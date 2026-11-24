'use strict';
// Bug ② (2026-11-23 18:11Z): two resumed Claude sessions received NAW input, but their plugin never bound the
// root, so every NAW tool was refused in the plugin and the backend saw no turn; nothing told the butler. The
// plugin has no channel then, so the backend marks such a session and the butler gets one failure event.
// Synthetic sessions only: no provider process, model or daily app.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { Claude } = require('../adapters.cjs');
const { Workspace } = require('../workspace.cjs');
const { ButlerLedger } = require('../butler-ledger.cjs');
const { ButlerIngress } = require('../butler-ingress.cjs');
const { RoomState } = require('../room-state.cjs');

const NATIVE = '11111111-1111-4111-8111-111111111111';
function adapter({ lease = null, alive = true } = {}) {
  const runtime = Object.create(Claude.prototype); EventEmitter.call(runtime);
  runtime.record = { id: 'member-a', nativeId: NATIVE }; runtime.ready = true; runtime.unboundGraceMs = 20;
  runtime.rootLease = lease; runtime.terminal = { alive, input() {} };
  runtime.submission = { connected: true, close() {}, request: async () => ({ promptId: null }) };
  let capability = 0; runtime.on('capability', () => { capability++; });
  return { runtime, capability: () => capability };
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('input delivered to a root that never binds marks the session not connected to NAW after the grace period', async () => {
  const f = adapter();
  await f.runtime.send('task', 'tag-1', () => true);
  assert.equal(f.runtime.nativeUnbound ?? null, null, 'a just-started root may still bind');
  await wait(60);
  assert.equal(f.runtime.nativeUnbound?.nativeId, NATIVE);
  assert.equal(Number.isSafeInteger(f.runtime.nativeUnbound.at), true);
  assert.equal(f.capability() >= 1, true, 'the workspace hears about it');
  // A later bind clears it.
  f.runtime.bindRoot({ sessionId: NATIVE });
  assert.equal(f.runtime.nativeUnbound, null);
});

test('a bound root, a root that binds within the grace period, or an exited root is never marked', async () => {
  const bound = adapter({ lease: 'lease-1' });
  await bound.runtime.send('task', 'tag-1', () => true); await wait(60);
  assert.equal(bound.runtime.nativeUnbound ?? null, null, 'bound');
  const late = adapter();
  await late.runtime.send('task', 'tag-1', () => true); late.runtime.bindRoot({ sessionId: NATIVE }); await wait(60);
  assert.equal(late.runtime.nativeUnbound ?? null, null, 'bound in time');
  const exited = adapter();
  await exited.runtime.send('task', 'tag-1', () => true); exited.runtime.terminal.alive = false; await wait(60);
  assert.equal(exited.runtime.nativeUnbound ?? null, null, 'exited');
  const reader = adapter(); reader.runtime.retainedReader = true;
  await reader.runtime.send('task', 'tag-1', () => true); await wait(60);
  assert.equal(reader.runtime.nativeUnbound ?? null, null, 'retained reader');
});

test('the mark reaches the session state and the butler ledger as one failure event, also after a restart', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-unbound-')); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const host = { binaries: {}, close() {}, rpc: {} }, w = new Workspace(host, dir);
  t.after(() => w.close());
  const s = { id: 'member-a', nativeId: NATIVE, provider: 'claude', model: 'claude-test-model', view: 'chat', cwd: dir, owner: 'window',
    state: 'working', createdAt: Date.now() - 10000, messages: [], fleet: [], roomId: null, roomIds: [], controlRevision: 0, memberRevision: 0 };
  const runtime = new EventEmitter(); runtime.host = host; runtime.chatAvailable = true;
  w.sessions.set(s.id, s); w.runtimes.set(s.id, runtime); w.bind(s, runtime);
  const state = () => w.snapshot().sessions.find(x => x.id === s.id);
  assert.equal(state().nativeUnbound, null);
  runtime.nativeUnbound = { at: 1_800_000_000_000, nativeId: NATIVE };
  assert.deepEqual(state().nativeUnbound, { at: 1_800_000_000_000, nativeId: NATIVE });
  const ledger = new ButlerLedger(dir), ingress = new ButlerIngress(dir, { roomState: new RoomState(dir), ledger });
  const before = ledger.latest();
  ingress.observeUnbound([state()]); ingress.observeUnbound([state()]);
  ingress.observeUnbound([{ ...state(), nativeId: 'another-native' }]);
  ingress.observeUnbound([{ ...state(), id: 'member-b', nativeUnbound: null }]);
  const events = ledger.eventsAfter(before).events;
  assert.equal(events.length, 1, 'once per occurrence; a replaced native session or an unmarked one not at all');
  assert.equal(events[0].kind, 'failure');
  assert.deepEqual(events[0].payload, { memberId: 'member-a', reason: 'native-unbound' });
  const stored = ledger.snapshot().events.filter(e => e.eventId.startsWith('native-unbound:'));
  assert.deepEqual(stored.map(e => e.sourceRef), ['native-unbound:member-a']);
  new ButlerIngress(dir, { roomState: new RoomState(dir), ledger }).observeUnbound([state()]);
  assert.equal(ledger.eventsAfter(before).events.length, 1, 'a restarted intake does not repeat it');
  runtime.nativeUnbound = { at: 1_800_000_060_000, nativeId: NATIVE };
  ingress.observeUnbound([state()]);
  assert.equal(ledger.eventsAfter(before).events.length, 2, 'a new occurrence after a bind is reported again');
});

test('the desktop process feeds every backend state to the observer', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  assert.match(source, /butlerIngress\?\.observeUnbound\(data\?\.sessions\)/);
});
