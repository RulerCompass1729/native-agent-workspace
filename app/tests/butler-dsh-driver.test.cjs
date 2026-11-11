const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { ButlerDshDriver } = require('../butler-dsh-driver.cjs');
const { ButlerBackend } = require('../butler-backend.cjs');
const binding = require('../service-binding.cjs');
const { lockIdentity } = require('../service-lock.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-dsh-owner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'backend');
  const backend = new ButlerBackend(directory, { runtimeVersion: 'fixture',
    configuration: { profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro' } });
  backend.prepare(); const proof = JSON.parse(fs.readFileSync(backend.file)).binding;
  binding.reserveBinding(backend.store, proof);
  return { driver: new ButlerDshDriver(directory), proof };
}
test('uncertain launch ownership and a live foreign driver are preserved without replacement', async t => {
  const f = fixture(t);
  for (const identity of [null, lockIdentity(process.pid)]) {
    const value = JSON.stringify({ format: 1, token: 'synthetic-owner', binding: f.proof, identity });
    fs.writeFileSync(f.driver.file, value, { mode: 0o600 });
    await assert.rejects(f.driver.recover(f.proof), /owner-unconfirmed/);
    assert.equal(fs.readFileSync(f.driver.file, 'utf8'), value); assert.equal(f.driver.child, null);
  }
});
test('a legacy butler daemon store cannot be adopted by DSH', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.driver.store, 'native-launch.json'), '{}', { mode: 0o600 });
  await assert.rejects(f.driver.recover(f.proof), /legacy-butler-store/);
  assert.equal(f.driver.child, null);
});
test('a different provider/profile/model or reservation cannot use this DSH slot', async t => {
  const f = fixture(t);
  for (const key of ['provider','profile','model','runnerRef','runtimeVersion','backendRef']) {
    await assert.rejects(f.driver.recover({ ...f.proof, [key]: key === 'runnerRef' ? 'butler-runner:other' : key === 'backendRef' ? 'butler-backend:other' : 'other' }), /binding-mismatch/);
  }
  assert.equal(f.driver.child, null);
});
test('non-loopback fixture endpoints are refused before startup', t => {
  const f = fixture(t);
  for (const fixtureEndpoint of ['https://example.invalid','http://localhost:1234','http://127.0.0.1:1234/path','http://127.0.0.1:1234?token=x']) {
    assert.throws(() => new ButlerDshDriver(path.dirname(f.driver.store), { fixtureEndpoint }), /endpoint-invalid/);
  }
});
test('malformed host packets plus changed ownership cannot produce an unhandled close rejection', async t => {
  const f = fixture(t), runner = require('../butler-runner.cjs'), cp = require('node:child_process');
  t.mock.method(runner, 'dshCredentialPresent', () => true);
  let ownedChild;
  t.mock.method(runner, 'spawnDshRunner', () => ownedChild = cp.spawn(process.execPath, ['-e',
    `const fs=require('fs');process.stdin.once('data',()=>{fs.writeFileSync(${JSON.stringify(f.driver.file)},'unreadable-owner');process.stdout.write('null\\n')});process.stdin.on('end',()=>process.exit(0));`],
    { detached: true, stdio: ['pipe','pipe','ignore'], env: { PATH: '/usr/bin:/bin' } }));
  f.driver.mcp = { command: process.execPath, args: [], tools: ['mcp__native_workspace__test'] };
  await assert.rejects(f.driver.start(f.proof), /protocol-invalid/);
  const receipt = await f.driver.close();
  assert.equal(receipt.stopped, true); assert.equal(receipt.cleanupConfirmed, false);
  assert.equal(fs.readFileSync(f.driver.file, 'utf8'), 'unreadable-owner');
  assert.throws(() => process.kill(ownedChild.pid, 0), { code: 'ESRCH' });
});

test('close cancels a start waiting for ownership recovery before it can spawn', async t => {
  const f = fixture(t), runner = require('../butler-runner.cjs');
  t.mock.method(runner, 'dshCredentialPresent', () => true);
  let release, spawns = 0;
  t.mock.method(runner, 'spawnDshRunner', () => { spawns++; throw Error('Must not spawn after close'); });
  f.driver.mcp = {};
  t.mock.method(f.driver, 'recover', () => new Promise(resolve => { release = resolve; }));
  const starting = f.driver.start(f.proof);
  const result = assert.rejects(starting, /closed/);
  assert.equal((await f.driver.close()).stopped, true);
  release({ status: 'absent' }); await result;
  assert.equal(spawns, 0); assert.equal(fs.existsSync(f.driver.file), false);
});

test('desktop shutdown permanently refuses starts, including after a close receipt', async t => {
  const f = fixture(t), runner = require('../butler-runner.cjs');
  let probes = 0;
  t.mock.method(runner, 'dshCredentialPresent', () => { probes++; return true; });
  assert.equal(typeof f.driver.beginShutdown, 'function');
  f.driver.beginShutdown();
  await assert.rejects(f.driver.start(f.proof), error => error.code === 'closing');
  await f.driver.close();
  await assert.rejects(f.driver.start(f.proof), error => error.code === 'closing');
  assert.equal(probes, 0); assert.equal(f.driver.child, null);
});
