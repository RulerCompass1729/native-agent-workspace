const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { processIdentity, processMayBeAlive } = require('../platform.cjs');
const { registry, removeOwned } = require('../../scripts/fixtures/test-temp.cjs');
const runner = path.resolve(__dirname, '../../scripts/test.cjs');
function fixture(t, source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-temp-guard-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'fixture.cjs'); fs.writeFileSync(file, source);
  const report = path.join(directory, 'report.json');
  const env = { ...process.env, NAW_TEST_TEMP_REPORT: report };
  delete env.NODE_TEST_CONTEXT; // This is a new CLI invocation, outside the parent test worker.
  const result = spawnSync(process.execPath, [runner, file], {
    env, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  const value = fs.existsSync(report) ? JSON.parse(fs.readFileSync(report)) : null;
  if (value?.retained) t.after(() => removeOwned(value.scope));
  return { ...result, report: value };
}
test('a test command cleans synchronous, callback and promise directories, leaving old directories alone', t => {
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-old-owned-fixture-'));
  t.after(() => fs.rmSync(old, { recursive: true, force: true }));
  fs.writeFileSync(path.join(old, 'keep'), 'old data');
  const result = fixture(t, `
    const test = require('node:test'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    test('three unmanaged caller APIs', async () => {
      fs.mkdtempSync(path.join(os.tmpdir(), 'naw-sync-'));
      await new Promise((resolve,reject) => fs.mkdtemp(path.join(os.tmpdir(), 'naw-callback-'), e => e ? reject(e) : resolve()));
      await fs.promises.mkdtemp(path.join(os.tmpdir(), 'naw-promise-'));
    });
  `);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.report.created, 3);
  assert.equal(result.report.after, 0);
  assert.ok(result.report.records.every(record => !fs.existsSync(record.path)));
  assert.equal(fs.readFileSync(path.join(old, 'keep'), 'utf8'), 'old data');
});
test('a newly unregistered naw directory makes the suite fail before fallback cleanup', t => {
  const result = fixture(t, `
    const test = require('node:test'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    test('a future uncovered producer', () => fs.mkdirSync(path.join(os.tmpdir(), 'naw-uncaught-leak')));
  `);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /TEMP LEAK: naw-uncaught/);
  assert.equal(result.report.after, 1, 'A cleanup sweep must not turn the residue check green');
  assert.equal(fs.existsSync(result.report.leftovers[0].path), false, 'Only the owned suite sandbox is removed afterward');
});
test('a nonzero worker exit retains its failure and cleans its registered directory', t => {
  const result = fixture(t, `
    const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
    fs.mkdtempSync(path.join(os.tmpdir(), 'naw-failed-worker-'));
    process.exit(7);
  `);
  assert.notEqual(result.status, 0);
  assert.equal(result.report.created, 1);
  assert.equal(result.report.after, 0);
  assert.ok(result.report.records.every(record => !fs.existsSync(record.path)));
});
test('the suite parent cleans a child killed before its exit cleanup can run', t => {
  const result = fixture(t, `
    const test = require('node:test'), {spawnSync} = require('node:child_process');
    test('abrupt owned child', () => {
      const child = spawnSync(process.execPath, ['-e',
        "const fs=require('node:fs'),path=require('node:path'),os=require('node:os');fs.mkdtempSync(path.join(os.tmpdir(),'naw-killed-child-'));process.kill(process.pid,'SIGKILL')"], {env:process.env});
      if (child.signal !== 'SIGKILL') throw Error('Kill schedule was not reached');
    });
  `);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.report.created, 1);
  assert.equal(result.report.after, 0);
  assert.ok(result.report.records.every(record => !fs.existsSync(record.path)));
});
test('directory registration never authorizes removal of a replacement at the same path', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-temp-identity-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const owner = registry(path.join(base, 'journal.jsonl'), [fs.realpathSync(base)]);
  const directory = fs.mkdtempSync(path.join(base, 'owned-'));
  owner.track(directory);
  fs.renameSync(directory, directory + '-saved'); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'keep'), 'replacement');
  assert.equal(owner.cleanup().length, 1);
  assert.equal(fs.readFileSync(path.join(directory, 'keep'), 'utf8'), 'replacement');
});
test('a protected scratch owner refusing cleanup makes the suite fail and preserves its profile', t => {
  const result = fixture(t, `
    const test = require('node:test'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    test('protected profile', () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-protected-profile-'));
      globalThis[Symbol.for('naw.testTemp.delegate')](directory);
      fs.writeFileSync(path.join(directory, 'keep'), 'unconfirmed resource');
    });
  `);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.report.retained, true);
  assert.equal(result.report.after, 1);
  assert.equal(fs.readFileSync(path.join(result.report.leftovers[0].path, 'keep'), 'utf8'), 'unconfirmed resource');
});
// A protected profile inside an ordinary owned directory: removing that
// directory would remove the profile, so its whole path must survive.
const scratchModule = JSON.stringify(path.resolve(__dirname, '../../scripts/fixtures/test-scratch.cjs'));
const nested = ending => `
  const test = require('node:test'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
  const scratch = require(${scratchModule});
  test('a scratch profile nested in an owned directory', async () => {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-nested-parent-')));
    const old = process.env.TMPDIR; process.env.TMPDIR = parent;
    const profile = scratch.directory(path.join(parent, 'naw-nested-profile-')); process.env.TMPDIR = old;
    fs.writeFileSync(path.join(profile, 'keep'), 'retained by its owner');
    ${ending}
  });
`;
function assertKept(result) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /TEMP GUARD: FAIL/);
  assert.equal(result.report.retained, true, 'A protected profile keeps its suite scope');
  const profile = result.report.records.find(record => record.delegated);
  const parent = result.report.records.find(record => !record.delegated && profile.path.startsWith(record.path + path.sep));
  assert.equal(fs.readFileSync(path.join(profile.path, 'keep'), 'utf8'), 'retained by its owner');
  assert.ok(result.report.leftovers.some(item => item.path === parent.path), 'The kept parent is reported, not deleted');
  assert.ok(result.report.protected.some(item => item.path === parent.path && item.by === profile.path));
}
test('a refused process check keeps a protected profile nested in an owned directory', t => {
  const result = fixture(t, nested(`
    const original = cp.execFileSync;
    cp.execFileSync = function (file, args, ...rest) {
      if (file === '/bin/ps' && args[0] === '-axo') throw Error('synthetic process census unavailable');
      return original.call(this, file, args, ...rest);
    };
    await assert.rejects(scratch.release(), /census unavailable/);
  `).replace("cp = require('node:child_process');", "cp = require('node:child_process'), assert = require('node:assert');"));
  assertKept(result);
});
test('a killed worker keeps a protected profile nested in an owned directory', t => {
  const result = fixture(t, nested(`process.kill(process.pid, 'SIGKILL');`));
  assertKept(result);
});
test('a worker keeps its own directory when another process protects a directory inside it', t => {
  const result = fixture(t, `
    const test = require('node:test'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
    test('protected by a child process', () => {
      const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-shared-parent-')));
      const child = cp.spawnSync(process.execPath, ['-e', [
        "const fs=require('node:fs'),path=require('node:path');",
        "const d=fs.mkdtempSync(path.join(process.argv[1],'naw-child-profile-'));",
        "globalThis[Symbol.for('naw.testTemp.delegate')](d);",
        "fs.writeFileSync(path.join(d,'keep'),'retained by its owner');",
      ].join(''), parent], { env: process.env });
      if (child.status !== 0) throw Error(String(child.stderr));
    });
  `);
  assertKept(result);
});

// A run that is stopped, or whose test leaves a process, ends what it started: found by the run's own random directory.
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end; await delay(50)) { const value = check(); if (value) return value; }
  assert.fail(message());
}
const json = file => { try { return JSON.parse(fs.readFileSync(file)); } catch { return null; } };
// The fixture leaves: one detached with the run's environment; one without it, named only by its command, that holds a
// child, with neither, that ignores SIGTERM, and is stopped (claude-version-lifecycle.test.cjs does all of this).
const IDLE = 'setInterval(()=>{},1000)';
const workerSource = `const child = require('node:child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.stdout.write('1');${IDLE}"], { stdio: ['ignore', 'pipe', 'ignore'] });
child.stdout.once('data', () => require('node:fs').writeFileSync(process.argv[2], String(child.pid)));
${IDLE}`;
const leaving = wait => `
  const test = require('node:test'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawn } = require('node:child_process');
  test('leaves processes behind', { timeout: 60000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-process-leak-')), alone = { detached: true, stdio: 'ignore' };
    const worker = path.join(dir, 'worker.cjs'), seen = path.join(dir, 'seen'), file = process.env.NAW_LEAK_PIDS;
    fs.writeFileSync(worker, ${JSON.stringify(workerSource)});
    const plain = spawn(process.execPath, ['-e', ${JSON.stringify(IDLE)}], alone), held = spawn(process.execPath, [worker, seen], { ...alone, env: {} });
    plain.unref(); held.unref();
    while (!fs.existsSync(seen) || !fs.readFileSync(seen, 'utf8')) await new Promise(resolve => setTimeout(resolve, 20));
    process.kill(held.pid, 'SIGSTOP');
    fs.writeFileSync(file + '.tmp', JSON.stringify({ pids: [plain.pid, held.pid, Number(fs.readFileSync(seen, 'utf8'))], directory: os.tmpdir() })); fs.renameSync(file + '.tmp', file);
    ${wait}
  });
`;
function start(t, source, extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-process-guard-test-')), file = path.join(directory, 'fixture.cjs'), report = path.join(directory, 'report.json');
  fs.writeFileSync(file, source);
  const env = { ...process.env, NAW_TEST_TEMP_REPORT: report, NAW_LEAK_PIDS: path.join(directory, 'pids.json'), ...extra };
  delete env.NODE_TEST_CONTEXT;
  const run = spawn(process.execPath, [runner, file], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; for (const stream of [run.stdout, run.stderr]) stream.setEncoding('utf8').on('data', text => { output += text; });
  const exited = new Promise(resolve => run.once('close', (code, signal) => resolve({ code, signal })));
  const owned = [];
  t.after(async () => {
    // What the code under test should have ended, when it did not.
    for (const identity of owned) if (processMayBeAlive(identity)) try { process.kill(identity.pid, 'SIGKILL'); } catch { /* ended since */ }
    if (run.exitCode === null && run.signalCode === null) run.kill('SIGKILL');
    await exited;
    const value = json(report); if (value?.retained) removeOwned(value.scope);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const own = pids => pids.map(pid => { const identity = processIdentity(pid); assert.ok(identity, `process ${pid}`); owned.push(identity); return identity; });
  return { run, exited, own, output: () => output, report: () => json(report), started: () => until(() => json(env.NAW_LEAK_PIDS), () => `the fixture did not start: ${output}`) };
}
const gone = identities => identities.map(identity => !processMayBeAlive(identity));
for (const signal of ['SIGTERM', 'SIGINT']) test(`a run stopped by ${signal} ends every process it started, and nothing else`, { timeout: 60000 }, async t => {
  const f = start(t, leaving('await new Promise(() => setInterval(() => {}, 1000));')), { pids, directory } = await f.started(), left = f.own(pids);
  // The same command, and the run's directory in a command whose owner is alive: neither is this run's.
  const others = [['-e', IDLE], ['-e', IDLE, directory]].map(args => spawn(process.execPath, args, { detached: true, stdio: 'ignore' }));
  const kept = f.own(others.map(child => child.pid));
  f.run.kill(signal);
  const { code } = await f.exited;
  assert.deepEqual(gone(left), [true, true, true], f.output());
  assert.deepEqual(gone(kept), [false, false]);
  assert.notEqual(code, 0);
  assert.deepEqual(f.report().processes.map(p => p.pid).sort((a, b) => a - b), [...pids].sort((a, b) => a - b));
  assert.match(f.output(), /PROCESS GUARD: ended=3 left=0/);
  assert.doesNotMatch(f.output(), /NAW_TEST_TEMP_JOURNAL=/, 'no environment is printed');
  for (const child of others) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited; }
});
test('a program the run did not start is left, though its command names the run\'s directory', { timeout: 60000 }, async t => {
  const f = start(t, leaving('await new Promise(() => setInterval(() => {}, 1000));')), { pids, directory } = await f.started(), left = f.own(pids);
  const log = path.join(directory, 'log'); fs.writeFileSync(log, '');
  // Nobody's: the shell that started it has ended.
  const shell = spawnSync('/bin/sh', ['-c', '/usr/bin/tail -f "$0" >/dev/null 2>&1 & echo $!', log], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  const kept = f.own([Number(shell.stdout)]);
  f.run.kill('SIGTERM'); await f.exited;
  assert.deepEqual(gone(left), [true, true, true], f.output());
  assert.deepEqual(gone(kept), [false], f.output());
});
test('a finished run ends what a passing test left, and says so', { timeout: 60000 }, async t => {
  const f = start(t, leaving('')), { pids } = await f.started(), left = f.own(pids), { code } = await f.exited;
  assert.deepEqual(gone(left), [true, true, true], f.output());
  assert.equal(code, 0, f.output());
  assert.match(f.output(), /PROCESS GUARD: ended=3 left=0/);
  assert.equal(f.output().match(/PROCESS LEAK: /g).length, 3);
});
test('a process that is only slow to end is waited for; a run that leaves none says nothing', { timeout: 60000 }, async t => {
  const slow = start(t, `require('node:test')('slow', () => { require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{},2500)'], { detached: true, stdio: 'ignore' }).unref(); });`);
  assert.equal((await slow.exited).code, 0);
  assert.doesNotMatch(slow.output(), /PROCESS/);
  assert.deepEqual(slow.report().processes, []);
});
test('a process of a protected profile is its owner\'s: named, not ended', { timeout: 60000 }, async t => {
  const f = start(t, `
    const test = require('node:test'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawn } = require('node:child_process');
    test('protected profile', () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-protected-profile-'));
      globalThis[Symbol.for('naw.testTemp.delegate')](directory);
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(IDLE)}, directory], { detached: true, stdio: 'ignore' }); child.unref();
      fs.writeFileSync(process.env.NAW_LEAK_PIDS, JSON.stringify({ pids: [child.pid] }));
    });
  `), { pids } = await f.started(), left = f.own(pids), { code } = await f.exited;
  assert.deepEqual(gone(left), [false], f.output());
  assert.equal(code, 1);
  assert.match(f.output(), /PROCESS GUARD: ended=0 left=1/);
  assert.match(f.output(), /PROCESS PROTECTED: /);
});
