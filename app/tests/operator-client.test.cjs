const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { WorkspaceClient } = require('../workspace-client.cjs');
const CAP = 'operatorControl1a';
function fixture(t, active = 'legacy') {
  const make = (key, capable) => {
    const real = { owner: 'human-view', runtimeVersion: 'synthetic-' + key, capabilities: capable ? [CAP] : [],
      operatorPolicy: { enabled: false, error: null, domains: [{ id: 'grant-' + key }] },
      nativeImageCacheRoot: '/synthetic/' + key + '/native-image-cache',
      nativeImageCacheRoots: ['/synthetic/retained/native-image-cache'],
      sessions: [{ id: key, nativeId: 'native-' + key, provider: 'claude', state: 'idle', liveDraft: 'PRIVATE_' + key, messages: [{ id: 'private-' + key, text: 'PRIVATE_BODY_' + key }] }],
      diagnostics: { dispatches: 0, shellModelCalls: 0 }, room: { id: 'shared', messages: [{ id: 'shared-' + key, text: 'SHARED_' + key, time: 1 }], revision: 0, run: null } };
    const client = new EventEmitter(), calls = [], entry = { key, client, real, calls, state: structuredClone(real) };
    client.call = async (method, ...args) => {
      calls.push([method, ...structuredClone(args)]);
      if (method === 'initial') return structuredClone(real);
      assert.equal(method, 'operatorAction', 'no native input, creation or delivery API');
      if (entry.onAction) await entry.onAction(args);
      if (args[1] === 'enabled') real.operatorPolicy.enabled = args[2];
      return entry.result === undefined ? true : entry.result;
    };
    client.close = () => client.emit('closed');
    entry.publish = () => client.emit('state', structuredClone(real));
    entry.actions = () => calls.filter(x => x[0] === 'operatorAction');
    return entry;
  };
  const a = make('a', true), b = make('b', true), legacy = make('legacy', false);
  const c = new WorkspaceClient([a, b, legacy], active, Symbol());
  t.after(() => c.close());
  return { a, b, legacy, c, make };
}
function heldAction(entry) {
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  entry.onAction = () => { started(); return new Promise(resolve => { release = resolve; }); };
  return { entered, release: () => release() };
}
function retained(state) { return { images: state.nativeImageCacheRoots, idsAndDrafts: state.sessions.map(s => [s.id, s.nativeId, s.liveDraft, s.messages]), shared: state.room.messages }; }

test('mixed operator backends route per-session only to its owner, refuse legacy before RPC, and preserve native IDs/drafts/image roots', async t => {
  const { a, b, legacy, c } = fixture(t);
  const before = retained(c.snapshot());
  await c.call('operatorAction', 'b', 'enabled', true);
  assert.equal(a.actions().length, 0); assert.deepEqual(b.actions(), [['operatorAction', 'b', 'enabled', true]]); assert.equal(legacy.actions().length, 0);
  await assert.rejects(c.call('operatorAction', 'legacy', 'enabled', true), /support/);
  assert.equal(legacy.actions().length, 0); assert.deepEqual(retained(c.snapshot()), before);
  assert.equal(c.snapshot().capabilities.includes(CAP), false, 'the active legacy backend is not promoted');
  assert.equal(c.snapshot().operatorPolicy.enabled, false, 'only one capable backend enabled');
});
test('global enable and disable fan out once to capable backends only with refreshed aggregate state', async t => {
  const { a, b, legacy, c } = fixture(t); const before = retained(c.snapshot());
  for (const enabled of [true, false]) {
    assert.equal(await c.call('operatorAction', null, 'enabled', enabled), true);
    assert.equal(c.snapshot().operatorPolicy.enabled, enabled);
  }
  assert.deepEqual(a.actions(), [['operatorAction', null, 'enabled', true], ['operatorAction', null, 'enabled', false]]);
  assert.deepEqual(b.actions(), a.actions()); assert.equal(legacy.actions().length, 0);
  assert.deepEqual(retained(c.snapshot()), before);
  assert.deepEqual(c.snapshot().operatorPolicy.domains.map(d => d.id), ['grant-a', 'grant-b']);
});
test('global policy never claims enabled from a closed, updating or unconfirmed capable backend', t => {
  const { a, b, c } = fixture(t); a.state.operatorPolicy.enabled = true; b.state.operatorPolicy.enabled = true;
  assert.equal(c.snapshot().operatorPolicy.enabled, true);
  b.closed = true; assert.equal(c.snapshot().operatorPolicy.enabled, false); b.closed = false;
  const finish = c.maintainService('b'); assert.equal(c.snapshot().operatorPolicy.enabled, false); finish();
  b.state.operatorPolicy.enabled = 'unknown'; assert.equal(c.snapshot().operatorPolicy.enabled, false);
  assert.equal(a.actions().length + b.actions().length, 0);
});
test('a global RPC refusal remains failure with no next-backend action or retry', async t => {
  const { a, b, legacy, c } = fixture(t);
  a.onAction = () => { throw Error('Synthetic explicit RPC refusal'); };
  await assert.rejects(c.call('operatorAction', null, 'enabled', true), /Synthetic explicit RPC refusal/);
  assert.equal(a.actions().length, 1); assert.equal(b.actions().length + legacy.actions().length, 0);
});
for (const changed of ['capability-removed', 'capability-added', 'backend-replaced', 'backend-updating']) test('global action refuses an observed mid-flight change without replay: ' + changed, async t => {
  const { a, b, legacy, c, make } = fixture(t), hold = heldAction(a);
  const pending = c.call('operatorAction', null, 'enabled', true); await hold.entered;
  let replacement;
  if (changed === 'capability-removed') { b.real.capabilities = []; b.publish(); }
  if (changed === 'capability-added') { legacy.real.capabilities.push(CAP); legacy.publish(); }
  if (changed === 'backend-replaced') { replacement = make('b', true); c.replaceService('b', replacement.client, replacement.state); }
  if (changed === 'backend-updating') { const finish = c.maintainService('b'); t.after(finish); }
  hold.release(); await assert.rejects(pending);
  assert.equal(a.actions().length, 1); assert.equal(b.actions().length, 0); assert.equal(legacy.actions().length, 0);
  assert.equal(replacement?.actions().length || 0, 0, 'the replacement must not receive the old action');
});
test('a session rebound during its RPC cannot report the old action as confirmed', async t => {
  const { a, c } = fixture(t), hold = heldAction(a);
  const pending = c.call('operatorAction', 'a', 'enabled', true); await hold.entered;
  a.real.sessions[0].nativeId = 'different-native'; a.publish(); hold.release();
  await assert.rejects(pending); assert.equal(a.actions().length, 1);
});
for (const kind of ['false-result', 'stale-readback']) test('a global acknowledgement is confirmed for every backend: ' + kind, async t => {
    const { a, b, legacy, c } = fixture(t);
    if (kind === 'false-result') b.result = false;
    else {
      const original = b.client.call;
      b.client.call = async (method, ...args) => { const value = await original(method, ...args); if (method === 'operatorAction') b.real.operatorPolicy.enabled = false; return value; };
    }
    await assert.rejects(c.call('operatorAction', null, 'enabled', true));
    assert.equal(a.actions().length, 1); assert.equal(b.actions().length, 1); assert.equal(legacy.actions().length, 0);
});
