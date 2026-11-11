'use strict';
// Dedicated composition only: no real profile, credential or provider launch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { ButlerBackend } = require('../butler-backend.cjs');
const { createDedicatedBackend } = require('../butler-backend-host.cjs');
const dedicated = require('../butler-dsh-driver.cjs');

const flags = ['tools', 'context', 'provider', 's2'];
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-host-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'dedicated');
  let presenceCalls = 0, launchCalls = 0, syntheticPresence = true;
  t.mock.method(dedicated, 'credentialPresent', () => { presenceCalls++; return syntheticPresence; });
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    t.mock.method(childProcess, name, () => { launchCalls++; throw Error('Unexpected child process in composition check'); });
  }
  return { root, directory, calls: () => ({ presence: presenceCalls, launch: launchCalls }),
    setPresence: value => { syntheticPresence = value; },
    make: options => createDedicatedBackend(directory, { runtimeVersion: 'host.synthetic', ...options }) };
}
function blockDriver(backend) {
  const calls = [];
  backend.driver.recover = async () => { calls.push('recover'); throw Error('Unqualified recovery'); };
  backend.driver.start = async () => { calls.push('start'); throw Error('Unqualified launch'); };
  return calls;
}
function assertClosed(result) {
  assert.equal(result.ready, false);
  for (const flag of flags) assert.ok(result.blocked.includes(flag + '-unqualified'));
}

test('dedicated host construction, snapshots and reopening have no launch, presence or disk side effects', t => {
  const f = fixture(t);
  assert.deepEqual(fs.readdirSync(f.root), []);
  const backend = f.make();
  assert.ok(backend instanceof ButlerBackend);
  assert.ok(backend.driver instanceof dedicated.ButlerDshDriver);
  assert.equal(backend.driver.store, backend.store);
  assert.equal(backend.store, path.join(f.directory, 'store'));
  assert.equal(backend.runtimeVersion, 'host.synthetic');
  assert.equal(backend.driver.executablePath, process.execPath);
  assert.equal(backend.credentialPresent, dedicated.credentialPresent);
  assert.equal(backend.read(), null);
  assert.equal(backend.snapshot().prepared, false);
  assert.equal(backend.snapshot().ready, false);
  const reopened = f.make();
  assert.deepEqual(reopened.snapshot(), backend.snapshot());
  assert.deepEqual(f.calls(), { presence: 0, launch: 0 });
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test('the dormant DSH desktop boundary supplies its own explicit configuration and ignores caller replacements', async t => {
  const f = fixture(t), backend = f.make({ configuration: { profile: 'different', provider: 'fixture-vendor', model: 'fixture-model' } });
  const calls = blockDriver(backend);
  assertClosed(await backend.ensure());
  const binding = backend.snapshot().binding;
  assert.deepEqual({ profile: binding.profile, provider: binding.provider, model: binding.model },
    { profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro' });
  assert.deepEqual(calls, []); assert.deepEqual(f.calls(), { presence: 1, launch: 0 });
});

test('factory defaults are unknown version and actual executable; an explicit executable stays dedicated', t => {
  const f = fixture(t);
  const unknown = createDedicatedBackend(f.directory);
  assert.equal(unknown.runtimeVersion, 'unknown');
  assert.equal(unknown.driver.executablePath, process.execPath);
  const executablePath = path.join(f.root, 'synthetic-node');
  const explicit = f.make({ executablePath });
  assert.equal(explicit.driver.executablePath, executablePath);
  assert.equal(explicit.driver.store, path.join(f.directory, 'store'));
  assert.deepEqual(f.calls(), { presence: 0, launch: 0 });
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test('a positive synthetic presence cannot open any native boundary or call the real driver', async t => {
  const f = fixture(t), backend = f.make();
  const calls = blockDriver(backend);
  assertClosed(await backend.ensure());
  assert.equal(backend.snapshot().credentialPresent, true);
  assert.equal(backend.snapshot().qualified, false);
  assert.equal(backend.snapshot().ready, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(f.calls(), { presence: 1, launch: 0 });
});

test('blocked state reopens without a presence check or launch and explicit ensure keeps all gates closed', async t => {
  const f = fixture(t), original = f.make();
  assertClosed(await original.ensure());
  const before = fs.readFileSync(original.file);
  const reopened = f.make(), calls = blockDriver(reopened);
  assert.equal(reopened.snapshot().state, 'blocked');
  assertClosed(reopened.snapshot());
  assert.deepEqual(fs.readFileSync(original.file), before);
  assert.deepEqual(f.calls(), { presence: 1, launch: 0 });
  assertClosed(await reopened.ensure());
  assert.deepEqual(calls, []);
  assert.deepEqual(f.calls(), { presence: 2, launch: 0 });
});

test('missing synthetic presence is rejected without attempting recovery or provider startup', async t => {
  const f = fixture(t), backend = f.make();
  f.setPresence(false);
  const calls = blockDriver(backend), result = await backend.ensure();
  assertClosed(result);
  assert.ok(result.blocked.includes('credential-missing'));
  assert.equal(backend.snapshot().credentialPresent, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(f.calls(), { presence: 1, launch: 0 });
});

test('factory caller cannot inject a qualification function or replacement driver through extra options', async t => {
  const f = fixture(t);
  let qualificationCalls = 0, replacementCalls = 0;
  const backend = f.make({ qualify: () => { qualificationCalls++; return Object.fromEntries(flags.map(flag => [flag, true])); },
    driver: { recover: async () => { replacementCalls++; }, start: async () => { replacementCalls++; } } });
  const calls = blockDriver(backend);
  assert.ok(backend.driver instanceof dedicated.ButlerDshDriver);
  assertClosed(await backend.ensure());
  assert.equal(qualificationCalls, 0);
  assert.equal(replacementCalls, 0);
  assert.deepEqual(calls, []);
  assert.deepEqual(f.calls(), { presence: 1, launch: 0 });
});

test('an unsafe existing record stays untouched and reads as blocked', t => {
  const f = fixture(t);
  fs.mkdirSync(f.directory, { mode: 0o700 });
  const file = path.join(f.directory, 'backend.json'), original = '{"synthetic":"unsafe-mode"}';
  fs.writeFileSync(file, original, { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  const backend = f.make();
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(backend.read().state, 'blocked');
  assert.deepEqual(backend.snapshot().blocked, ['unsafe-record']);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  assert.deepEqual(fs.readdirSync(f.directory), ['backend.json']);
  assert.deepEqual(f.calls(), { presence: 0, launch: 0 });
});

test('runtime upgrade is shown as blocked without rewriting, launching or accepting the old binding', async t => {
  const f = fixture(t), original = f.make(); original.prepare();
  const bytes = fs.readFileSync(original.file), reopened = f.make({ runtimeVersion: 'new.synthetic' });
  for (const method of ['read', 'snapshot']) {
    const state = reopened[method]();
    assert.equal(state.state, 'blocked'); assert.equal(state.ready, false);
    assert.deepEqual(state.blocked, ['binding-mismatch']); assert.equal(state.binding, null);
  }
  await assert.rejects(reopened.ensure(), e => e.code === 'binding-mismatch');
  assert.deepEqual(fs.readFileSync(original.file), bytes);
  assert.deepEqual(f.calls(), { presence: 0, launch: 0 });
  // Only the display boundary converts errors; core authority checks still throw.
  assert.throws(() => new ButlerBackend(f.directory, { runtimeVersion: 'new.synthetic' }).read(), e => e.code === 'binding-mismatch');
});
