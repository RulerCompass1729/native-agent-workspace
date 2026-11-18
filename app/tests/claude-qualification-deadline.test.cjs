const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const realMod = require('../claude-mod-check.cjs');

// Execute the production coordinator with a monotonic clock and owned-worker
// doubles. No CLI, network, provider configuration or wall-clock wait is used.
function setup(t, { modMs = 59000, nativeMs = 290000, cleanupMs = 3000, stubborn = false, closeDelay = 0, exitCode = 0 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-claude-deadline-'));
  const versions = path.join(directory, 'versions'); fs.mkdirSync(versions);
  for (const version of ['2.1.327', '2.1.328']) fs.writeFileSync(path.join(versions, version), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const binary = path.join(versions, '2.1.328'), launcher = path.join(directory, 'claude'); fs.symlinkSync(binary, launcher);
  let now = 0, serial = 0, settledAt, result, child, childRoot, nativeOptions;
  const timers = new Map(), cancellations = [], kills = [], phaseOptions = [];
  const later = (fn, delay) => { const id = ++serial; timers.set(id, { at: now + delay, fn }); return id; };
  const clear = id => timers.delete(id);
  const controller = new AbortController();
  const mod = { ...realMod, run: options => {
    phaseOptions.push(options);
    return new Promise((resolve, reject) => {
      const stop = () => { clear(timer); reject(Error('cancelled')); };
      const timer = later(() => { options.signal?.removeEventListener('abort', stop); resolve({ exit: 0, fail: 0, pass: 74, tests: 74 }); }, modMs);
      options.signal?.addEventListener('abort', stop, { once: true });
    });
  } };
  const fork = (_file, args) => {
    child = new EventEmitter(); child.stdout = child.stderr = { resume() {} }; child.connected = true;
    // The old worker allocates its own root. The corrected worker gets an exact
    // parent-owned receipt, allowing cleanup even after a forced worker exit.
    try { childRoot = JSON.parse(args[2]).root; } catch { childRoot = fs.realpathSync(fs.mkdtempSync('/tmp/ncq-')); }
    fs.writeFileSync(path.join(childRoot, 'synthetic-worker-file'), 'synthetic');
    const ownedTimers = new Set();
    const task = (fn, delay) => { const id = later(fn, delay); ownedTimers.add(id); return id; };
    const close = (code, cooperative) => {
      for (const id of ownedTimers) clear(id);
      if (cooperative) fs.rmSync(childRoot, { recursive: true, force: true });
      child.emit('close', code);
    };
    child.send = message => {
      if (!message.cancel) return; cancellations.push(now);
      if (!stubborn) { for (const id of ownedTimers) clear(id); task(() => close(1, true), cleanupMs); }
    };
    child.kill = signal => { kills.push({ at: now, signal }); close(1, false); };
    task(() => {
      child.emit('message', { type: 'result', result: { passed: true, journeys: { 'solo-queue': true, 'shared-queue': true, 'shared-model': true } } });
      task(() => close(exitCode, true), closeDelay);
    }, nativeMs);
    return child;
  };
  const filename = path.resolve(__dirname, '../claude-qualification.cjs'), box = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: box, exports: box.exports, __dirname: path.dirname(filename), process, console, AbortController,
    performance: { now: () => now }, setTimeout: later, clearTimeout: clear,
    require: name => name === './claude-mod-check.cjs' ? mod : name === 'node:child_process' ? { fork } : name.startsWith('.') ? require(path.resolve(path.dirname(filename), name)) : require(name),
  }, { filename });
  const options = { file: path.join(directory, 'qualification.json'), binary, version: '2.1.328', privateDir: directory, signal: controller.signal };
  const q = box.exports, runJourneys = q.nativeJourneys;
  const done = q.checkOnce({ ...options, runJourneys: options => { nativeOptions = options; return runJourneys(options); } }).then(value => { result = value; settledAt = now; return value; });
  const advance = async target => {
    for (;;) {
      const first = [...timers].filter(([, value]) => value.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) break;
      const [id, value] = first; timers.delete(id); now = value.at; value.fn();
      for (let i = 0; i < 16; i++) await Promise.resolve();
    }
    now = target; for (let i = 0; i < 16; i++) await Promise.resolve();
  };
  t.after(() => { if (childRoot) fs.rmSync(childRoot, { recursive: true, force: true }); fs.rmSync(directory, { recursive: true, force: true }); });
  return { q, options, launcher, controller, done, advance, timers, phaseOptions, cancellations, kills,
    get nativeOptions() { return nativeOptions; }, get root() { return childRoot; }, get result() { return result; }, get settledAt() { return settledAt; } };
}

test('59s mod + 290s native: one 300s work deadline, then at most 20s cleanup; never late approval', async t => {
  const f = setup(t); await f.advance(300000);
  assert.deepEqual(f.cancellations, [300000], 'Cancel at the whole-check deadline, not 300 seconds after mod tests');
  assert.equal(f.result, undefined, 'Do not finish until the owned worker has exited');
  await f.advance(303000); const record = await f.done;
  assert.equal(record.status, 'failed'); assert.equal(record.reason, 'timed-out'); assert.equal(f.settledAt, 303000);
  assert.equal(fs.existsSync(f.root), false); assert.equal(f.timers.size, 0);
  assert.deepEqual(Array.from(f.q.launch({ launcher: f.launcher, file: f.options.file }).approvedVersions), []);
});

test('each phase receives only its own ceiling within the remaining whole-check budget', async t => {
  const f = setup(t); await f.advance(59000);
  assert.equal(f.phaseOptions[0].timeoutMs, 60000); assert.equal(f.nativeOptions.timeoutMs, 241000);
  assert.equal(f.phaseOptions[0].signal, f.nativeOptions.signal);
  f.controller.abort(); await f.advance(62000); assert.equal(await f.done, null); assert.equal(f.timers.size, 0);
});

test('deadline cancellation waits for cleanup and removes a forcibly stopped worker root within 20s', async t => {
  const f = setup(t, { modMs: 0, nativeMs: 400000, stubborn: true }); await f.advance(300000);
  assert.equal(f.result, undefined); assert.equal(fs.existsSync(f.root), true);
  await f.advance(319999); assert.equal(f.result, undefined); assert.deepEqual(f.kills, []);
  await f.advance(320000); const record = await f.done;
  assert.equal(fs.existsSync(f.root), false, 'The parent cleans its exact root after a forced worker exit');
  assert.equal(record.reason, 'timed-out'); assert.equal(record.status, 'failed');
  assert.deepEqual(f.kills, [{ at: 320000, signal: 'SIGKILL' }]); assert.equal(fs.existsSync(f.root), false); assert.equal(f.timers.size, 0);
});

test('a success message before the deadline cannot qualify if the worker exits after cancellation', async t => {
  const f = setup(t, { modMs: 0, nativeMs: 299000, closeDelay: 5000 }); await f.advance(303000);
  const record = await f.done; assert.equal(record.status, 'failed'); assert.equal(record.reason, 'timed-out'); assert.equal(fs.existsSync(f.root), false);
});

test('success before the deadline clears timers and the external cancellation listener', async t => {
  const f = setup(t, { modMs: 1000, nativeMs: 1000 }); await f.advance(2000); const record = await f.done;
  assert.equal(f.q.passed(record), true); assert.equal(fs.existsSync(f.root), false); assert.equal(f.timers.size, 0);
  f.controller.abort(); await f.advance(400000); assert.equal(f.q.passed(record), true); assert.deepEqual(f.cancellations, []);
});

test('a worker success message cannot qualify after a failed cleanup exit', async t => {
  const f = setup(t, { modMs: 1000, nativeMs: 1000, exitCode: 1 }); await f.advance(2000);
  const record = await f.done; assert.equal(record.status, 'failed'); assert.equal(record.reason, 'native-startup');
  assert.equal(fs.existsSync(f.root), false); assert.equal(f.timers.size, 0);
});

test('deadline failure has a fixed human-readable reason in both interface languages', () => {
  const locale = require('../ui-locale.js'), renderer = fs.readFileSync(path.resolve(__dirname, '../renderer/renderer.js'), 'utf8');
  const source = renderer.slice(renderer.indexOf('function claudePinText('), renderer.indexOf('function nativeVersionText('));
  for (const language of ['zh', 'en']) {
    const scope = { ui: { language: { getSnapshot: () => ({ active: language }) } }, uiText: (key, params) => locale.format(language, key, params) };
    vm.runInNewContext(source, scope);
    const text = scope.claudePinText({ provider: 'claude', nativePin: { pinned: '2.1.327', requested: '2.1.328', until: '2026-12-01', check: { status: 'failed', reason: 'timed-out' } } });
    assert.ok(text.includes(language === 'zh' ? '300 秒' : '300-second')); assert.ok(!text.includes('native.claudeCheckReason'));
  }
});

test('forced cleanup refuses a substituted root and leaves its symlink target untouched', t => {
  const q = require('../claude-qualification.cjs'), root = fs.realpathSync(fs.mkdtempSync('/tmp/ncq-'));
  const stat = fs.lstatSync(root), owner = { root, uid: stat.uid, dev: stat.dev, ino: stat.ino };
  const replacement = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-claude-unrelated-')), original = root + '-original';
  fs.writeFileSync(path.join(replacement, 'sentinel'), 'synthetic unrelated data');
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(original, { recursive: true, force: true }); fs.rmSync(replacement, { recursive: true, force: true }); });
  fs.renameSync(root, original); fs.symlinkSync(replacement, root);
  assert.throws(() => q.removeNativeRoot(owner)); assert.equal(fs.readFileSync(path.join(replacement, 'sentinel'), 'utf8'), 'synthetic unrelated data');
  fs.unlinkSync(root); fs.renameSync(original, root); q.removeNativeRoot(owner); assert.equal(fs.existsSync(root), false);
});

test('the real worker consumes its root receipt, rejects a fake version mismatch, and exits with no root left', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-claude-worker-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const binary = path.join(directory, '2.1.328'), marker = path.join(directory, 'version-reached');
  fs.writeFileSync(binary, '#!' + process.execPath + '\nrequire("node:assert/strict").deepEqual(process.argv.slice(2), ["--version"]);\nrequire("node:fs").writeFileSync(' + JSON.stringify(marker) + ', "reached");\nconsole.log("2.1.329 (Synthetic CLI)");\n', { mode: 0o700 });
  const filename = path.resolve(__dirname, '../claude-qualification.cjs'), box = { exports: {} }, cp = require('node:child_process');
  let root;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: box, exports: box.exports, __dirname: path.dirname(filename), process, console, AbortController, performance, setTimeout, clearTimeout,
    require: name => name === 'node:child_process' ? { fork: (file, args, options) => { root = JSON.parse(args[2]).root; return cp.fork(file, args, options); } } : name.startsWith('.') ? require(path.resolve(path.dirname(filename), name)) : require(name),
  }, { filename });
  const result = await box.exports.nativeJourneys({ binary, version: '2.1.328', privateDir: directory });
  assert.equal(fs.existsSync(marker), true, 'The worker must parse and execute the controlled version check before refusing the mismatch');
  assert.equal(fs.readFileSync(marker, 'utf8'), 'reached');
  assert.equal(result.passed, false); assert.equal(result.reason, 'native-startup'); assert.equal(fs.existsSync(root), false);
});

test('every qualification worker entry passes node --check without running its entry code', () => {
  const { spawnSync } = require('node:child_process'), app = path.resolve(__dirname, '..');
  const entries = new Set(['claude-qualification.cjs', 'claude-mod-check.cjs']);
  for (const entry of entries) {
    const file = path.join(app, entry), source = fs.readFileSync(file, 'utf8');
    // Follow the actual fork declarations, including workers added later. An
    // unrecognized declaration fails closed instead of silently missing an entry.
    const workers = [...source.matchAll(/\bfork\(\s*path\.join\(__dirname,\s*['"]([^'"]+\.cjs)['"]\)/g)];
    assert.equal(workers.length, [...source.matchAll(/\bfork\s*\(/g)].length, entry + ': every fork entry must be checked');
    for (const [, worker] of workers) entries.add(path.relative(app, path.resolve(path.dirname(file), worker)));
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined, entry);
    assert.equal(result.status, 0, entry + ': ' + result.stderr);
  }
  assert.ok(entries.size > 2, 'The guard reached the real worker entry');
});
