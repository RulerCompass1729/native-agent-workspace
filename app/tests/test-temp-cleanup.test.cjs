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
