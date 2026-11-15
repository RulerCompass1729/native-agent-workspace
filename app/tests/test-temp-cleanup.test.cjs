const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
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
