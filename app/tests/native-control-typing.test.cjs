const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { randomUUID } = require('node:crypto');
const { Workspace } = require('../workspace.cjs'), { Claude } = require('../adapters.cjs');
const { ScopedOutboxRuntime } = require('../scoped-outbox-runtime.cjs'), { rootCall } = require('../background-control-native.cjs');

// Real input bookkeeping, Claude root identity and service-side proof consumption.
// No provider process, native keyboard injection, model, or daily app.
async function fixture(t, steward = true) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'naw-control-typing-'));
  const w = new Workspace({ binaries: {}, close() {} }, dir);
  const s = { id: randomUUID(), nativeId: randomUUID(), provider: 'claude', owner: 'human', view: 'terminal',
    controlRevision: 0, peerRevision: 0, memberRevision: 0, messages: [], state: 'working' };
  const r = new Claude(s, w.host, { attachOnly: true }), keys = [];
  r.terminal = { alive: true, input: text => keys.push(text) };
  const binding = { sessionId: s.nativeId, ...r.bindRoot({ sessionId: s.nativeId, nativeBlocks: true }) };
  r.observeRoot({ ...binding, epoch: r.observationEpoch, sequence: 1, block: true, id: 'control:turn-start',
    kind: 'control', status: 'running', turnId: 'owned-turn', promptId: 'owned-prompt' });
  w.sessions.set(s.id, s); w.runtimes.set(s.id, r);
  const designate = selected => fs.writeFileSync(path.join(dir, 'steward.json'), JSON.stringify({ version: 1, selected }), { mode: 0o600 });
  if (steward) designate({ sessionId: s.id, nativeId: s.nativeId });
  const producer = new ScopedOutboxRuntime(w), client = { destroyed: false }, events = [];
  t.after(() => { producer.closeAll(); w.close(); fs.rmSync(dir, { recursive: true }); });
  const args = { action: 'catalog' }, proof = rootCall(r, { ...binding, epoch: r.observationEpoch,
    turnId: 'owned-turn', promptId: 'owned-prompt', callId: 'owned-call', arguments: args }, new AbortController().signal, () => true);
  const opened = await producer.request(client, 'controlCall', { op: randomUUID(), callerId: s.id, identity: proof.identity, arguments: args }, event => events.push(event));
  assert.equal(opened.ok, true);
  return { w, s, r, keys, events, designate, producer, check: () => producer.request(client, 'check', { token: opened.value.token }, () => {}) };
}
for (const steward of [true, false]) test(`${steward ? 'a designated butler' : 'an ordinary session\'s'} control call survives native typing, paste, edits and unsent chat draft`, async t => {
  const f = await fixture(t, steward);
  for (const key of ['x', 'SYNTHETIC PASTE', '\x7f', '\x1b[D']) {
    f.w.input(f.s.id, key, f.s.owner); f.w.changed();
    assert.equal((await f.check()).ok, true, JSON.stringify(key));
  }
  f.w.setDraft(f.s.id, 'SYNTHETIC UNSENT DRAFT', f.s.owner);
  assert.equal((await f.check()).ok, true); assert.equal(f.s.controlRevision, 4); assert.equal(f.keys.length, 4);
});
for (const [name, change, check] of [
  ['Escape', f => f.w.input(f.s.id, '\x1b', f.s.owner), 'scope-control-revision'],
  ['Ctrl-C', f => f.w.input(f.s.id, '\x03', f.s.owner), 'scope-control-revision'],
  ['takeover', f => { f.s.owner = 'other-human'; }, 'scope-owner'],
  ['non-input control', f => { f.s.controlRevision++; }, 'scope-control-revision'],
  ['native identity', f => { f.s.nativeId = randomUUID(); }, 'scope-native-id'],
  ['connection', f => { f.s.connectionRevision = 1; }, 'scope-connection'],
  ['native stop', f => { f.r.stopped = true; }, 'scope-native-state'],
  ['root observation gap', f => { f.r.displayGap = true; }, 'display-gap'],
  ['role withdrawn after typing', f => { f.w.input(f.s.id, 'x', f.s.owner); f.designate(null); }, 'scope-control-revision'],
]) for (const steward of name === 'role withdrawn after typing' ? [true] : [true, false]) test(`${steward ? 'a butler\'s' : 'an ordinary session\'s'} source control call still refuses ${name} with a fixed condition name`, async t => {
  const f = await fixture(t, steward); change(f);
  const result = await f.check(); assert.equal(result.ok, false); assert.equal(result.failureCheck, check);
});
test('asynchronous revocation keeps its fixed check name in the service notification', async t => {
  const f = await fixture(t); f.s.controlRevision++; f.w.changed();
  assert.equal(f.events.at(-1).failureCheck, 'scope-control-revision'); assert.equal((await f.check()).ok, false);
});
