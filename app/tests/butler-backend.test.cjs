'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ButlerBackend } = require('../butler-backend.cjs');

const qualified = () => ({ tools: true, context: true, provider: true, s2: true });
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-backend-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'butler'), calls = [];
  let serial = 0, live = null;
  const driver = {
    recover: async value => { calls.push(['recover', value]); return live ? { status: 'present', binding: live } : { status: 'absent' }; },
    start: async value => { calls.push(['start', value]); live = { ...value }; return { status: 'present', binding: live }; },
  };
  const options = { runtimeVersion: 'alpha.synthetic', credentialPresent: () => true, qualify: qualified,
    driver, now: () => 100, id: () => `synthetic-${++serial}`, ...overrides };
  return { root, directory, calls, driver, options, backend: new ButlerBackend(directory, options),
    raw: () => JSON.parse(fs.readFileSync(path.join(directory, 'backend.json'), 'utf8')) };
}

test('prepare reserves its own private store and immutable runner without changing ordinary services', t => {
  const f = setup(t);
  const ordinary = path.join(f.root, 'services.json'), original = '{"format":1,"active":".","entries":["."]}';
  fs.writeFileSync(ordinary, original, { mode: 0o600 });
  assert.equal(f.backend.read(), null);
  const prepared = f.backend.prepare(), first = f.raw();
  assert.equal(prepared.state, 'prepared'); assert.equal(prepared.ready, false);
  assert.deepEqual({ purpose: prepared.binding.purpose, profile: prepared.binding.profile, provider: prepared.binding.provider, model: prepared.binding.model },
    { purpose: 'butler', profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro' });
  assert.equal(prepared.binding.runtimeVersion, 'alpha.synthetic');
  assert.ok(first.binding.startNonce);
  assert.deepEqual(new ButlerBackend(f.directory, f.options).prepare(), prepared);
  assert.deepEqual(f.raw(), first, 'Reopening never replaces the reservation or nonce');
  assert.deepEqual(f.calls, []); assert.equal(fs.readFileSync(ordinary, 'utf8'), original);
  assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(f.backend.store).mode & 0o777, 0o700);
  assert.equal(fs.statSync(f.backend.file).mode & 0o777, 0o600);
  assert.equal(prepared.binding.startNonce, undefined);
  assert.equal(prepared.binding.store, undefined);
});

test('default qualification keeps the unsupported native boundary closed without touching a driver', async t => {
  const f = setup(t, { qualify: undefined });
  const result = await f.backend.ensure();
  assert.equal(result.ready, false);
  for (const name of ['tools', 'context', 'provider', 's2']) assert.ok(result.blocked.includes(`${name}-unqualified`));
  assert.deepEqual(f.calls, []); assert.equal(f.backend.snapshot().ready, false);
});

for (const present of [false, 'synthetic-secret-value', 1, undefined, { value: 'synthetic-secret-value' }])
  test(`credential presence must be a boolean: ${typeof present}`, async t => {
    const f = setup(t, { credentialPresent: () => present });
    const result = await f.backend.ensure();
    assert.equal(result.ready, false);
    assert.ok(result.blocked.includes(present === false ? 'credential-missing' : 'credential-presence-invalid'));
    assert.deepEqual(f.calls, []);
    const saved = fs.readFileSync(f.backend.file, 'utf8');
    assert.equal(saved.includes('synthetic-secret-value'), false);
    assert.equal(JSON.stringify(f.backend.snapshot()).includes('synthetic-secret-value'), false);
  });

for (const flag of ['tools', 'context', 'provider', 's2']) test(`a missing ${flag} boundary prevents all driver operations`, async t => {
  const f = setup(t, { qualify: () => ({ ...qualified(), [flag]: false }) });
  assert.deepEqual(await f.backend.ensure(), { ready: false, blocked: [`${flag}-unqualified`] });
  assert.deepEqual(f.calls, []);
});

test('unknown runtime or malformed qualification is never enough to start', async t => {
  const f = setup(t, { runtimeVersion: 'unknown' });
  assert.ok((await f.backend.ensure()).blocked.includes('runtime-unqualified')); assert.deepEqual(f.calls, []);
  const bad = setup(t, { qualify: () => ({ ...qualified(), value: 'synthetic-secret-value' }) });
  assert.ok((await bad.backend.ensure()).blocked.includes('qualification-invalid')); assert.deepEqual(bad.calls, []);
  assert.equal(fs.readFileSync(bad.backend.file, 'utf8').includes('synthetic-secret-value'), false);
});

test('qualified ensure persists the nonce before recover and start and exposes only safe binding names', async t => {
  const f = setup(t);
  const start = f.driver.start;
  f.driver.start = async proof => {
    assert.equal(Object.isFrozen(proof), true);
    const saved = f.raw();
    assert.equal(saved.status, 'starting'); assert.equal(saved.binding.startNonce, proof.startNonce);
    assert.deepEqual(saved.qualification, qualified()); assert.equal(saved.credentialPresent, true);
    assert.equal(fs.existsSync(f.backend.lockFile), false, 'No file lock spans an asynchronous driver call');
    assert.deepEqual(Object.keys(proof).sort(), ['purpose', 'profile', 'provider', 'model', 'runtimeVersion', 'backendRef', 'runnerRef', 'store', 'startNonce'].sort());
    return start(proof);
  };
  const ready = await f.backend.ensure();
  assert.equal(ready.ready, true); assert.deepEqual(ready.binding, f.backend.snapshot().binding);
  assert.deepEqual(f.calls.map(call => call[0]), ['recover', 'start']);
  assert.equal(f.backend.snapshot().ready, true);
  const reopened = new ButlerBackend(f.directory, f.options);
  assert.equal(reopened.snapshot().ready, false, 'A persisted ready state is not proof of a live native backend');
  assert.deepEqual(reopened.snapshot().blocked, ['recovery-required']);
  assert.equal((await reopened.ensure()).ready, true);
  assert.equal(f.calls.filter(call => call[0] === 'start').length, 1);
  assert.equal(ready.binding.startNonce, undefined); assert.equal(ready.binding.store, undefined);
});

test('same-instance ensure is single flight and another instance cannot race recover into a second start', async t => {
  const f = setup(t);
  let release;
  f.driver.recover = async proof => { f.calls.push(['recover', proof]); return new Promise(resolve => { release = resolve; }); };
  const first = f.backend.ensure(), second = f.backend.ensure();
  assert.equal(first, second);
  await tick(); assert.equal(typeof release, 'function');
  assert.equal(fs.existsSync(f.backend.lockFile), false);
  const other = new ButlerBackend(f.directory, f.options);
  assert.deepEqual(await other.ensure(), { ready: false, blocked: ['backend-busy'] });
  assert.deepEqual(f.calls.map(call => call[0]), ['recover']);
  release({ status: 'absent' });
  assert.equal((await first).ready, true); assert.equal((await second).ready, true);
  assert.equal(f.calls.filter(call => call[0] === 'start').length, 1);
});

test('a blocked or unknown recovery preserves the reservation and never starts a duplicate', async t => {
  const f = setup(t);
  f.driver.recover = async proof => { f.calls.push(['recover', proof]); return { status: 'unknown' }; };
  f.backend.prepare(); const nonce = f.raw().binding.startNonce;
  assert.deepEqual(await f.backend.ensure(), { ready: false, blocked: ['liveness-unconfirmed'] });
  const reopened = new ButlerBackend(f.directory, f.options);
  assert.deepEqual(await reopened.ensure(), { ready: false, blocked: ['liveness-unconfirmed'] });
  assert.equal(f.raw().binding.startNonce, nonce);
  assert.equal(f.calls.some(call => call[0] === 'start'), false);
});

test('reopening after an uncertain start recovers the same nonce without fallback or another process', async t => {
  const f = setup(t);
  let live;
  f.driver.recover = async proof => { f.calls.push(['recover', proof]); return live ? { status: 'present', binding: live } : { status: 'absent' }; };
  f.driver.start = async proof => { f.calls.push(['start', proof]); live = { ...proof }; throw Error('synthetic-secret-value'); };
  assert.deepEqual(await f.backend.ensure(), { ready: false, blocked: ['start-failed'] });
  const first = f.raw().binding;
  const reopened = new ButlerBackend(f.directory, f.options);
  assert.equal((await reopened.ensure()).ready, true);
  assert.deepEqual(f.raw().binding, first);
  assert.equal(f.calls.filter(call => call[0] === 'start').length, 1);
  assert.equal(fs.readFileSync(f.backend.file, 'utf8').includes('synthetic-secret-value'), false);
  assert.equal(JSON.stringify(reopened.snapshot()).includes('synthetic-secret-value'), false);
  for (const [, proof] of f.calls) assert.equal(proof.provider, 'deepseek');
});

test('a confirmed absent failed start can retry only after recovery using the saved nonce', async t => {
  const f = setup(t);
  let attempts = 0;
  const start = f.driver.start;
  f.driver.start = async proof => { if (++attempts === 1) { f.calls.push(['start', proof]); throw Error('synthetic failure'); } return start(proof); };
  assert.equal((await f.backend.ensure()).ready, false);
  const nonce = f.raw().binding.startNonce;
  assert.equal((await new ButlerBackend(f.directory, f.options).ensure()).ready, true);
  assert.deepEqual(f.calls.map(call => call[0]), ['recover', 'start', 'recover', 'start']);
  for (const [, proof] of f.calls) assert.equal(proof.startNonce, nonce);
});

for (const key of ['runnerRef', 'backendRef', 'startNonce', 'runtimeVersion', 'profile', 'provider', 'model'])
  test(`recovery cannot adopt a backend with another ${key}`, async t => {
    const f = setup(t);
    f.driver.recover = async proof => { f.calls.push(['recover', proof]); return { status: 'present', binding: { ...proof, [key]: 'another' } }; };
    await assert.rejects(f.backend.ensure(), error => error.code === 'binding-mismatch');
    assert.equal(f.calls.some(call => call[0] === 'start'), false);
    assert.equal(f.backend.snapshot().ready, false);
    assert.deepEqual(f.backend.snapshot().blocked, ['binding-mismatch']);
  });

test('an unconfirmed start acknowledgement is never ready', async t => {
  const f = setup(t);
  f.driver.start = async proof => { f.calls.push(['start', proof]); return { status: 'present', binding: { ...proof, runnerRef: 'another' } }; };
  assert.deepEqual(await f.backend.ensure(), { ready: false, blocked: ['start-unconfirmed'] });
  assert.equal(f.backend.snapshot().ready, false);
});

test('another runtime version and a foreign-purpose record cannot be reused or overwritten', async t => {
  const f = setup(t); f.backend.prepare();
  const original = fs.readFileSync(f.backend.file, 'utf8');
  const other = new ButlerBackend(f.directory, { ...f.options, runtimeVersion: 'alpha.other' });
  assert.throws(() => other.prepare(), error => error.code === 'binding-mismatch');
  await assert.rejects(other.ensure(), error => error.code === 'binding-mismatch');
  assert.equal(fs.readFileSync(f.backend.file, 'utf8'), original);
  const foreign = f.raw(); foreign.binding.purpose = 'ordinary';
  fs.writeFileSync(f.backend.file, JSON.stringify(foreign));
  const foreignText = fs.readFileSync(f.backend.file, 'utf8');
  assert.throws(() => f.backend.prepare(), error => error.code === 'state-invalid');
  assert.equal(fs.readFileSync(f.backend.file, 'utf8'), foreignText);
  assert.deepEqual(f.calls, []);
});

test('a preexisting lock is never stolen or removed', async t => {
  const f = setup(t); f.backend.prepare();
  fs.writeFileSync(f.backend.lockFile, 'another owner or unconfirmed former lock', { mode: 0o600 });
  assert.throws(() => f.backend.prepare(), error => error.code === 'backend-busy');
  assert.deepEqual(await f.backend.ensure(), { ready: false, blocked: ['backend-busy'] });
  assert.equal(fs.readFileSync(f.backend.lockFile, 'utf8'), 'another owner or unconfirmed former lock');
  assert.deepEqual(f.calls, []);
});

test('corrupt private metadata is preserved and never repaired by replacing the binding', t => {
  const f = setup(t); f.backend.prepare();
  fs.writeFileSync(f.backend.file, '{broken');
  assert.throws(() => f.backend.prepare(), error => error.code === 'state-invalid');
  assert.equal(fs.readFileSync(f.backend.file, 'utf8'), '{broken');
});

test('an unowned nonempty store is not adopted as a new runner', t => {
  const f = setup(t);
  fs.mkdirSync(f.directory, { mode: 0o700 }); fs.mkdirSync(f.backend.store, { mode: 0o700 });
  const unrelated = path.join(f.backend.store, 'unrelated.txt'); fs.writeFileSync(unrelated, 'existing data', { mode: 0o600 });
  assert.throws(() => f.backend.prepare(), error => error.code === 'unowned-store');
  assert.equal(fs.existsSync(f.backend.file), false); assert.equal(fs.readFileSync(unrelated, 'utf8'), 'existing data');
});

test('foreign record ownership fails closed without changing the record', async t => {
  const f = setup(t); f.backend.prepare(); const saved = fs.readFileSync(f.backend.file, 'utf8');
  const original = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (...args) => {
    const stat = original(...args);
    return args[0] === f.backend.file ? Object.assign(Object.create(stat), { uid: process.getuid() + 1 }) : stat;
  });
  await assert.rejects(f.backend.ensure()); assert.deepEqual(f.calls, []);
  assert.equal(fs.readFileSync(f.backend.file, 'utf8'), saved);
});

for (const kind of ['record-symlink', 'record-hardlink', 'record-mode', 'store-symlink', 'store-mode', 'directory-symlink', 'directory-mode'])
  test(`unsafe ${kind} cannot authorize a driver`, async t => {
    const f = setup(t); f.backend.prepare();
    const saved = fs.readFileSync(f.backend.file, 'utf8'), outside = path.join(f.root, 'outside');
    if (kind === 'record-symlink') { fs.writeFileSync(outside, saved, { mode: 0o600 }); fs.unlinkSync(f.backend.file); fs.symlinkSync(outside, f.backend.file); }
    if (kind === 'record-hardlink') fs.linkSync(f.backend.file, outside);
    if (kind === 'record-mode') fs.chmodSync(f.backend.file, 0o644);
    if (kind === 'store-symlink') { fs.mkdirSync(outside, { mode: 0o700 }); fs.rmdirSync(f.backend.store); fs.symlinkSync(outside, f.backend.store); }
    if (kind === 'store-mode') fs.chmodSync(f.backend.store, 0o755);
    if (kind === 'directory-symlink') { fs.renameSync(f.directory, outside); fs.symlinkSync(outside, f.directory); }
    if (kind === 'directory-mode') fs.chmodSync(f.directory, 0o755);
    await assert.rejects(f.backend.ensure());
    assert.deepEqual(f.calls, []);
    if (kind.startsWith('record')) assert.equal(fs.readFileSync(f.backend.file, 'utf8'), saved);
  });
