const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const pin = require('../claude-pin.cjs');

function installation(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-claude-auto-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'versions'));
  for (const version of ['2.1.323', '2.1.327', '2.1.328']) fs.writeFileSync(path.join(root, 'versions', version), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const launcher = path.join(root, 'claude'); fs.symlinkSync(path.join(root, 'versions/2.1.328'), launcher);
  return { root, launcher, fresh: true, stateFile: path.join(root, 'pin.json') };
}

test('a version passing the complete qualification is selected for the next session', t => {
  const i = installation(t);
  const result = pin.choose({ ...i, approvedVersions: ['2.1.328'] });
  assert.equal(result.version, '2.1.328');
  assert.equal(result.pin, null);
});

test('a failed journey keeps the fallback and supplies its reason for display', t => {
  const i = installation(t);
  const result = pin.choose({ ...i, approvedVersions: [], check: { status: 'failed', reason: 'shared-queue' } });
  assert.equal(result.version, '2.1.327');
  assert.equal(result.pin.check.reason, 'shared-queue');
  assert.equal(result.pin.check.status, 'failed');
});

test('a later qualification changes new launch choices without replacing a previous launch', t => {
  const i = installation(t), running = pin.choose(i), original = structuredClone(running);
  assert.equal(running.version, '2.1.327');
  const next = pin.choose({ ...i, fresh: false, lastVersion: '2.1.327', lastWritten: '2.1.327', approvedVersions: ['2.1.328'] });
  assert.equal(next.version, '2.1.328');
  assert.deepEqual(running, original);
});

test('the hook uses the launch qualification only for that exact native version', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../claude-bridge/hooks/register.js'), 'utf8');
  for (const [version, approved, expected] of [['2.1.328', '2.1.328', true], ['2.1.329', '2.1.328', false], ['2.1.328', '', false]]) {
    const hooks = new Map(), calls = [], clock = [];
    const api = {
      env: { get: async key => ({ NAW_SUBMIT_SOCKET: '/fixture/no-socket', NAW_HOOK_TOKEN: 'fixture', NAW_CLAUDE_QUALIFIED_VERSION: approved })[key] },
      session: { id: async () => '11111111-1111-4111-8111-111111111111', version: async () => ({ version }), model: async () => 'fixture', usage: async () => null },
      clock: { after: (_, callback) => { clock.push(callback); return { cancel() {} }; } },
      prompt: { read: async () => ({ text: '' }), submit: async () => { throw Error('No model'); } },
      tool: { list: async () => [] },
      http: { fetch: async (url, options) => { const route = new URL(url).pathname; calls.push({ route, body: JSON.parse(options.body) }); return { ok: true, text: JSON.stringify(route === '/root-bind' ? { lease: 'fixture', observationEpoch: 'fixture', nativeBlocks: false } : { idle: true }) }; } }
    };
    const { register } = await import('data:text/javascript;base64,' + Buffer.from(source + '\n//' + Math.random()).toString('base64'));
    register((name, callback) => { hooks.set(name, callback); return { catch() {} }; });
    await hooks.get('session.start')(api, {}, async event => event);
    if (clock.length) await clock.shift()();
    await new Promise(resolve => setImmediate(resolve));
    const binding = calls.find(call => call.route === '/root-bind')?.body;
    assert.equal(Boolean(binding?.nativeBlocks), expected, `${version}/${approved}`);
    if (expected) {
      assert.equal(binding.nativeQueue, true); assert.equal(binding.nativeMidturnAppend, true);
      for (const field of ['nativeMedia', 'nativeAbort', 'nativeInlineInput', 'nativePromptInput']) assert.equal(binding[field], false, field);
    }
  }
});

const qualification = require('../claude-qualification.cjs');
const passMod = async () => ({ exit: 0, fail: 0, pass: 74, tests: 74 });
const passJourneys = async () => ({ passed: true, journeys: { 'solo-queue': true, 'shared-queue': true, 'shared-model': true } });
function options(i) { return { file: path.join(i.root, 'qualification.json'), binary: path.join(i.root, 'versions/2.1.328'), version: '2.1.328', privateDir: i.root, runMod: passMod, runJourneys: passJourneys }; }

test('only a complete matching record opens launch selection, without changing an existing choice', async t => {
  const i = installation(t), before = pin.choose(i), opt = options(i);
  assert.equal(qualification.launch({ launcher: i.launcher, file: opt.file }).approvedVersions.length, 0);
  const record = await qualification.checkOnce(opt);
  assert.equal(qualification.passed(record), true);
  const selected = qualification.launch({ launcher: i.launcher, file: opt.file });
  assert.deepEqual(selected.approvedVersions, ['2.1.328']);
  assert.equal(selected.qualifiedVersion, '2.1.328');
  assert.equal(pin.choose({ ...i, ...selected }).version, selected.qualifiedVersion);
  assert.equal(before.version, '2.1.327');
  assert.deepEqual(await qualification.checkOnce({ ...opt, runMod: () => { throw Error('must reuse'); } }), record, 'cached identity uses the stored result');
});

test('each failed or missing journey leaves the new version closed and names the failed check', async t => {
  for (const name of qualification.JOURNEYS) {
    const i = installation(t), opt = options(i);
    const result = await qualification.checkOnce({ ...opt, runJourneys: async () => ({ passed: false, reason: name, journeys: { ...await passJourneys().then(r => r.journeys), [name]: false } }) });
    assert.equal(result.status, 'failed');
    const selection = qualification.launch({ launcher: i.launcher, file: opt.file });
    const launch = pin.choose({ ...i, ...selection });
    assert.equal(selection.qualifiedVersion, ''); assert.equal(launch.version, '2.1.327');
    assert.equal(launch.pin.check.reason, name);
  }
});

test('a mod failure starts no native journey, and neither test output nor paths become the UI reason', async t => {
  const i = installation(t), opt = options(i); let calls = 0;
  const record = await qualification.checkOnce({ ...opt, runMod: async () => ({ exit: 1, fail: 1, pass: 73, tests: 74 }), runJourneys: () => { calls++; } });
  assert.equal(calls, 0); assert.equal(record.reason, 'mod-tests');
  assert.deepEqual(qualification.launch({ launcher: i.launcher, file: opt.file }).approvedVersions, []);
});

test('binary replacement, wrong version, or a stale basis invalidates prior qualification', async t => {
  for (const mutate of [r => { r.basis = 'stale'; }, r => { r.version = '2.1.329'; }, (r, opt) => fs.appendFileSync(opt.binary, '# replaced\n')]) {
    const i = installation(t), opt = options(i), record = await qualification.checkOnce(opt);
    mutate(record, opt); fs.writeFileSync(opt.file, JSON.stringify({ format: 1, checks: { '2.1.328': record } }));
    assert.deepEqual(qualification.launch({ launcher: i.launcher, file: opt.file }).approvedVersions, []);
  }
});

test('cancellation never publishes a success and a partial journey report never qualifies', async t => {
  const i = installation(t), opt = options(i), stop = new AbortController();
  const result = await qualification.checkOnce({ ...opt, signal: stop.signal, runJourneys: async () => { stop.abort(); return passJourneys(); } });
  assert.equal(result, null);
  assert.equal(qualification.launch({ launcher: i.launcher, file: opt.file }).qualifiedVersion, '');
  const partial = await qualification.checkOnce({ ...opt, runJourneys: async () => ({ passed: true, journeys: { 'solo-queue': true } }) });
  assert.equal(qualification.passed(partial), false);
});

test('qualification helpers are copied to the daemon runtime and packaged', () => {
  for (const file of ['service-client.cjs', '../scripts/package-mac.cjs']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    for (const name of ['claude-qualification.cjs', 'claude-native-journeys.cjs', 'claude-loopback.cjs']) assert.ok(source.includes(`'${name}'`), `${file} includes ${name}`);
  }
});

test('a completed background check leaves the running native process and launch version untouched', async t => {
  const i = installation(t), { NativeHost } = require('../adapters.cjs');
  const { EventEmitter } = require('node:events');
  const target = new EventEmitter();
  target.record = { nativeId: 'synthetic-root', nativeLaunchVersion: '2.1.327', pid: 123, nativePin: { requested: '2.1.328', pinned: '2.1.327' } };
  let stopped = 0; target.stop = () => { stopped++; }; target.terminal = { pid: 123 };
  const original = qualification.checkOnce;
  t.after(() => { qualification.checkOnce = original; });
  qualification.checkOnce = async () => ({ status: 'passed' });
  const host = { binaries: { claude: i.launcher }, dataDir: i.root, privateDir: i.root, hookTargets: new Map([['fixture', target]]), claudeModChecks: new Map() };
  NativeHost.prototype.checkClaudeVersion.call(host);
  await host.claudeModChecks.get('2.1.328').done;
  assert.equal(stopped, 0); assert.equal(target.terminal.pid, 123);
  assert.equal(target.record.pid, 123); assert.equal(target.record.nativeId, 'synthetic-root');
  assert.equal(target.record.nativeLaunchVersion, '2.1.327');
  assert.deepEqual(target.record.nativePin.check, { status: 'passed', reason: 'passed' });
});


test('a failed qualification has a fixed human-readable reason in both interface languages', () => {
  const vm = require('node:vm'), locale = require('../ui-locale.js');
  const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  const body = renderer.slice(renderer.indexOf('function claudePinText('), renderer.indexOf('function nativeVersionText('));
  for (const language of ['zh', 'en']) {
    const scope = { ui: { language: { getSnapshot: () => ({ active: language }) } }, uiText: (key, params) => locale.format(language, key, params) };
    vm.runInNewContext(body, scope);
    const text = scope.claudePinText({ provider: 'claude', nativePin: { pinned: '2.1.327', requested: '2.1.328', until: '2026-12-01', check: { status: 'failed', reason: 'shared-queue' } } });
    assert.ok(text.includes(language === 'zh' ? '空间排队检查' : 'space queue journey'));
    assert.ok(text.includes(language === 'zh' ? '未通过' : 'failed'));
    assert.ok(!text.includes('native.claudeCheck'));
  }
});

test('updater launcher changes trigger a check without opening a conversation or adding a timer', async t => {
  const i = installation(t), { NativeHost } = require('../adapters.cjs');
  let checks = 0;
  const host = { binaries: { claude: i.launcher }, checkClaudeVersion: () => { checks++; } };
  NativeHost.prototype.watchClaudeLauncher.call(host);
  t.after(() => host.claudeLauncherWatch?.close());
  const watch = host.claudeLauncherWatch, sentinel = path.join(i.root, 'watch-ready');
  let ready = false;
  const observed = (_event, name) => { if (!name || String(name) === path.basename(sentinel)) ready = true; };
  watch.on('change', observed);
  const readyDeadline = Date.now() + 3000;
  for (let n = 0; !ready && Date.now() < readyDeadline; n++) {
    fs.writeFileSync(sentinel, String(n));
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  watch.off('change', observed);
  assert.ok(ready, 'The same watcher must observe a sentinel before testing later updates');
  const beforeChange = checks;
  fs.unlinkSync(i.launcher); fs.symlinkSync(path.join(i.root, 'versions/2.1.327'), i.launcher);
  const deadline = Date.now() + 3000;
  while (checks === beforeChange && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(checks > 0);
  assert.ok(checks > beforeChange, 'The launcher change itself must trigger a check');
  assert.equal(typeof watch.close, 'function');
  host.closed = true; watch.close();
  const before = checks;
  fs.unlinkSync(i.launcher); fs.symlinkSync(path.join(i.root, 'versions/2.1.328'), i.launcher);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(checks, before);
});

test('host startup checks directly after installing its advisory launcher watcher', async t => {
  const i = installation(t), { NativeHost } = require('../adapters.cjs'), calls = [];
  const socket = path.join(i.root, 'synthetic-hook'); fs.writeFileSync(socket, '');
  const host = { hookSocket: socket, hooks: { once() {}, listen(_file, ready) { ready(); } },
    submissions: { async start() {} }, watchClaudeLauncher() { calls.push('watch'); }, checkClaudeVersion() { calls.push('check'); } };
  await NativeHost.prototype.start.call(host);
  assert.equal(host.nativeStarted, true); assert.deepEqual(calls, ['watch', 'check']);
});
