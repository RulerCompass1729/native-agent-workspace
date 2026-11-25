'use strict';
// Two of the butler's dispatches were withdrawn with nobody told (the person, 2026-11-24: 「一旦错过就不再继续,这个肯定不
// 行」). Any message its call was told is saved that does not go out is one butler event: the recipient, the time, the
// message id and the reason, never its text. Nothing is sent again.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm'), { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Workspace } = require('../workspace.cjs'), { PeerRunner } = require('../peer-handoffs.cjs');
const { RoomState } = require('../room-state.cjs'), { ButlerLedger } = require('../butler-ledger.cjs'), { ButlerIngress } = require('../butler-ingress.cjs');
const { StewardRecord } = require('../steward-record.cjs'), { StewardWake } = require('../steward-wake.cjs');
const wake = require('../session-wake.cjs');
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const KEY = 'backends/aaaaaaaaaaaaaaaaaaaa', MIN = 60000;

// The butler on the root backend, its recipient on KEY, and main's intake and the butler record in a third directory.
async function fixture(t, { receiveFails = false } = {}) {
  const realNow = Date.now; let now = realNow(); Date.now = () => now; t.after(() => { Date.now = realNow; });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-own-undelivered-')); fs.chmodSync(root, 0o700);
  const dirs = [root, path.join(root, KEY)];
  fs.mkdirSync(dirs[1], { recursive: true, mode: 0o700 }); fs.chmodSync(path.dirname(dirs[1]), 0o700);
  fs.writeFileSync(path.join(root, 'services.json'), JSON.stringify({ format: 1, active: '.', entries: ['.', KEY] }), { mode: 0o600 });
  const writes = [], options = { receiveFails };
  const host = { binaries: {}, close() {}, create(s) {
    const r = new EventEmitter(); r.record = s; s.nativeId = 'native-' + s.id;
    r.host = { rpc: { call: async () => ({ goal: null }) } }; r.chatAvailable = r.addressedSendAvailable = true;
    r.start = async () => r.emit('state', 'idle');
    r.stop = async () => ({ state: 'ended' }); r.stopForMaintenance = async begin => { begin(); r.stopped = true; return { state: 'ended' }; };
    r.send = async (text, tag, guard) => { assert.equal(guard(), true); writes.push({ id: s.id, text, tag }); if (!options.silent) r.emit('submitted', tag); };
    return r;
  } };
  const workspaces = dirs.map(dir => new Workspace(host, dir));
  const connect = async dir => {
    const w = workspaces[dirs.indexOf(dir)];
    return { close() {}, async call(method, spec) {
      if (method === 'initial') return { ...w.snapshot(), capabilities: ['agentWakeV1', 'agentWakePreflightV1'] };
      if (method === 'wakeCheck') return wake.check(w, spec);
      if (method === 'wakeTake') { options.beforeTake?.(spec); return wake.take(w, spec); }
      if (method === 'wakeReceive') {
        if (options.receiveFails) throw Error('Synthetic connection lost');
        const result = await wake.receive(w, spec); if (options.lostAfter) throw Error('Synthetic connection lost'); return result;
      }
      throw Error('Unexpected method ' + method);
    } };
  };
  workspaces.forEach((w, i) => { w.peerRunner = new PeerRunner(w, dirs[i], connect); });
  t.after(() => { workspaces.forEach(w => w.close()); fs.rmSync(root, { recursive: true, force: true }); });
  const [source, target] = workspaces;
  const a = await source.create('codex', root, 'source-owner', 'Butler'), b = await target.create('codex', root, 'target-owner', 'Member');
  const c = await source.create('codex', root, 'other-owner', 'Other');
  const session = (w, id) => ({ sessionId: id, nativeId: w.get(id).nativeId });
  const begin = async (id, text, { from = a, to = b } = {}) => {
    const r = source.runtimes.get(from), nativeId = source.get(from).nativeId;
    r.turnId = id; r.emit('nativeTurnStart', { nativeId, turnId: id }); r.emit('state', 'working');
    let result; try { result = await r.addressedCall({ nativeId, turnId: id, callId: 'call-' + id }, { recipient_id: to, message: text }); } catch (error) { result = { error }; }
    const finish = async (status = 'completed') => { r.turnId = null; r.emit('state', 'idle'); r.emit('nativeTurnEnd', { nativeId, turnId: id, status }); await settle(); };
    return { result, finish };
  };
  const mainDir = path.join(root, 'main'); fs.mkdirSync(mainDir, { mode: 0o700 });
  let role = session(source, a), chain = [];
  const record = () => new StewardRecord(mainDir, { steward: () => role, selected: () => role, now: () => now });
  const open = () => { const ledger = new ButlerLedger(mainDir, { now: () => now }); return { ledger, record: record(), ingress: new ButlerIngress(mainDir, { roomState: new RoomState(mainDir), ledger, now: () => now }) }; };
  const f = { root, source, target, a, b, c, writes, options, begin, session, mainDir, open, main: open(),
    busy: () => target.runtimes.get(b).emit('state', 'working'), idle: () => target.runtimes.get(b).emit('state', 'idle'),
    stop: id => source.stop(id, { check() {}, participantOnly: true, expected: { ...source.get(id), draftRevision: 0 } }),
    retry: async () => { wake.retryHeld(source); await settle(); },
    rows: (id = a) => source.get(id).messages.filter(m => m.wake), row: (id = a) => f.rows(id).at(-1),
    // The person designates `next` from their window, as main does; `follow`: a done rotation handed the role on.
    designate: next => { role = next; f.main.record.designated(next); }, follow: (next, from) => { role = next; chain = from; },
    observe: (main = f.main, sessions = source.snapshot().sessions) => main.ingress.observeWakeUndelivered(sessions, { steward: () => role, formerly: () => chain,
      wasButler: (...who) => main.record.heldRole?.(...who) }),
    events: (main = f.main) => main.ledger.snapshot().events.filter(e => e.eventId.startsWith('wake-undelivered:')),
    outcomes: main => f.events(main).map(e => e.payload.outcome),
    advance: ms => { now += ms; }, now: () => now };
  f.designate(role); now += 1000;
  t.after(() => assert.ok(!/Secret/.test(JSON.stringify(f.main.ledger.snapshot())), 'never the message'));
  return f;
}
const quiet = (f, minutes = 40) => fs.writeFileSync(path.join(f.root, 'quiet-windows.json'), JSON.stringify({ format: 1, history: [],
  windows: [{ id: randomUUID(), scope: `backend:${KEY}`, reason: 'migration', openedBy: 'naw', openedAt: f.now(), deadline: f.now() + minutes * MIN, waited: 'busy', sessions: [f.b] }] }), { mode: 0o600 });
const own = (f, row, outcome, at = f.now()) => ({ memberId: f.b, itemId: row.id, reason: 'own-message-undelivered', outcome, title: new Date(at).toISOString() });

test('held, then the butler is archived and its successor goes on: one event, naming recipient, time, message and reason', async t => {
  const f = await fixture(t); f.busy();
  const one = await f.begin('one', 'Secret held task.'); assert.equal(one.result.readiness, 'held'); await one.finish();
  assert.equal(f.row().wake.status, 'held');
  f.advance(MIN); await f.stop(f.a);
  f.follow(f.session(f.source, f.c), [f.a]);
  assert.equal(f.row().wake.status, 'cancelled');
  f.observe(); f.observe();
  assert.deepEqual(f.events().map(e => [e.kind, e.sourceRef, e.payload]),
    [['blocked', `wake-undelivered:${f.b}`, own(f, f.row(), 'cancelled:disconnecting')]]);
  // The new butler is also one the record names; main restarting records nothing again.
  f.main.record.sync(f.session(f.source, f.c)); f.observe(); f.advance(1000);
  const later = f.open(); f.observe(later); assert.equal(f.events(later).length, 1);
  assert.equal(f.writes.length, 0, 'nothing is sent again');
});

for (const held of [false, true]) test(`registered${held ? ' for a quiet window' : ''}, then withdrawn before the turn ended: one event`, async t => {
  const f = await fixture(t); if (held) quiet(f);
  const one = await f.begin('one', 'Secret task.');
  assert.deepEqual([one.result.status, one.result.readiness], ['staged', held ? 'held' : 'checked']);
  assert.equal(f.row().wake.heldAt, undefined);
  f.source.claim(f.a, 'another-window'); f.advance(1000); await one.finish();
  assert.equal(f.row().wake.status, 'cancelled');
  f.observe(); f.observe();
  assert.deepEqual(f.events().map(e => e.payload), [own(f, f.row(), 'cancelled:source-identity-changed')]);
  const stewardWake = new StewardWake(f.mainDir, { ledger: () => f.main.ledger, selected: () => f.session(f.source, f.a), now: () => f.now(), record: () => {} });
  stewardWake.set(true); assert.equal(stewardWake.due(), false);
  f.advance(1000); const two = await f.begin('two', 'Secret second task.'); await two.finish('failed'); f.observe();
  assert.deepEqual(f.outcomes(), ['cancelled:source-identity-changed', 'cancelled:turn-not-completed']);
  assert.equal(stewardWake.due(), true, 'the event wakes the butler');
});

for (const held of [false, true]) test(`a gap in what NAW saw of the turn withdraws a ${held ? 'held' : 'registered'} message: one event (the two of 22:35)`, async t => {
  const f = await fixture(t); if (held) f.busy();
  const one = await f.begin('one', 'Secret task.'); if (held) await one.finish();
  assert.equal(f.row().wake.status, held ? 'held' : 'staged'); f.advance(1000);
  for (let i = 0; i < 2; i++) f.source.runtimes.get(f.a).emit('nativeBlock', { kind: 'gap' });
  if (!held) await one.finish();
  assert.equal(f.row().wake.status, 'cancelled'); f.observe(); f.observe();
  assert.deepEqual(f.events().map(e => e.payload), [own(f, f.row(), 'cancelled:observation-gap')]);
});

test('after a gap, asking again in the same turn: the call answers it did not go out, so no event but the first message\'s', async t => {
  const f = await fixture(t), one = await f.begin('one', 'Secret task.'), r = f.source.runtimes.get(f.a);
  r.emit('nativeBlock', { kind: 'gap' });
  const call = (callId, message) => new Promise(resolve => resolve(r.addressedCall({ nativeId: f.source.get(f.a).nativeId, turnId: 'one', callId }, { recipient_id: f.b, message }))).catch(error => ({ error }));
  const same = await call('call-one', 'Secret task.');
  assert.deepEqual([same.status, same.id], ['unconfirmed', f.row().id]);
  assert.ok((await call('call-two', 'Secret again.')).error);
  await one.finish(); f.observe();
  assert.deepEqual(f.events().map(e => e.payload.itemId), [f.rows()[0].id]); assert.equal(f.rows().length, 1);
});

test('told saved, then refused at its one attempt, lost on the way, or not confirmed: one event each; delivered: none', async t => {
  const f = await fixture(t);
  const refused = await f.begin('refused', 'Secret one.'); assert.equal(refused.result.status, 'staged');
  f.target.get(f.b).wakeDisabled = true; f.advance(1000); await refused.finish();
  assert.equal(f.row().wake.status, 'not-sent'); f.observe();
  assert.deepEqual(f.events().map(e => e.payload), [own(f, f.row(), 'not-sent:recipient-disabled')]);
  f.target.get(f.b).wakeDisabled = false;
  f.options.receiveFails = true; const lost = await f.begin('lost', 'Secret two.'); await lost.finish();
  f.options.receiveFails = false; f.options.silent = true; f.advance(1000);
  const silent = await f.begin('silent', 'Secret three.'); f.advance(1000); await silent.finish();
  assert.deepEqual(f.rows().map(m => m.wake.status), ['not-sent', 'unconfirmed', 'unconfirmed']);
  f.observe();
  assert.deepEqual(f.outcomes(), ['not-sent:recipient-disabled', 'not-sent:not-taken', 'unconfirmed:unconfirmed']);
  assert.deepEqual(f.events().at(-1).payload, own(f, f.row(), 'unconfirmed:unconfirmed'), 'when it ended, not when it was registered');
  const g = await fixture(t), sent = await g.begin('sent', 'Secret four.'); await sent.finish();
  assert.equal(g.row().wake.status, 'submitted'); g.observe(); assert.deepEqual(g.events(), []);
});

// Sample six (22:43): a message whose turn ended normally was refused as it was being taken. What the person and the
// sender see is unchanged; the butler is told apart the one that never left from the one that may have arrived.
for (const [name, set, code, refused] of [
  ['a gap', f => f.source.runtimes.get(f.a).emit('nativeBlock', { kind: 'gap' }), 'source-identity-changed', { code: 'source-identity-changed', fields: ['peerRevision'] }],
  ['a permission question', f => f.source.runtimes.get(f.a).emit('state', 'approval'), 'source-identity-changed', { code: 'source-identity-changed', fields: ['peerRevision'] }],
  ['the recipient could not be reached', f => { f.options.receiveFails = true; }, 'not-taken', { code: 'not-taken' }],
]) test(`as it is being taken, ${name}: not sent, and never taken later`, async t => {
  const f = await fixture(t), one = await f.begin('one', 'Secret task.'); assert.equal(one.result.status, 'staged');
  const before = JSON.stringify(f.source.get(f.a).messages.at(-1).wake.sourceProof);
  f.options.beforeTake = () => { f.options.beforeTake = null; set(f); };
  if (code === 'not-taken') set(f);
  f.advance(1000); await one.finish();
  const row = f.row();
  assert.deepEqual([row.wake.status, row.uiMessage.key, row.wake.untaken, row.wake.takeRefused], ['unconfirmed', 'error.wake.deliveryUnconfirmed', true, refused]);
  assert.equal(JSON.stringify(row.wake.sourceProof), before);
  f.observe(); f.observe();
  assert.deepEqual(f.events().map(e => e.payload), [own(f, row, `not-sent:${code}`)]);
  // Asked for again, it stays refused, and why it did not go out stays.
  assert.throws(() => wake.take(f.source, { id: row.id, senderId: f.a, recipientId: f.b, targetKey: KEY }), e => e.uiMessage?.key === 'error.wake.credentialInvalid');
  assert.deepEqual(row.wake.takeRefused, refused); assert.equal(f.writes.length, 0);
  f.source.persist(); const again = f.open(), reopened = new Workspace({ binaries: {}, close() {} }, f.root); t.after(() => reopened.close());
  f.observe(again, reopened.snapshot().sessions); assert.equal(f.events(again).length, 1);
});

test('lost after it was taken, or input as it is being taken: may have arrived, or delivered', async t => {
  const f = await fixture(t), one = await f.begin('one', 'Secret task.');
  f.options.lostAfter = true; f.advance(1000); await one.finish();
  assert.deepEqual([f.row().wake.status, f.row().wake.untaken, f.row().wake.takeRefused], ['unconfirmed', undefined, undefined]);
  assert.equal(f.writes.length, 1); f.observe();
  assert.deepEqual(f.events().map(e => e.payload), [own(f, f.row(), 'unconfirmed:delivery-failed')]);
  const g = await fixture(t), two = await g.begin('two', 'Secret two.');
  g.options.beforeTake = () => g.source.runtimes.get(g.a).emit('nativeControlBoundary', 'control:input');
  await two.finish(); g.observe();
  assert.deepEqual([g.row().wake.status, g.row().wake.untaken, g.writes.length, g.events().length], ['submitted', undefined, 1, 0]);
});

test('why a take is refused, in codes: not being sent, another recipient, another backend, or a runtime that is gone', async t => {
  const f = await fixture(t), one = await f.begin('one', 'Secret task.');
  const row = f.row(), spec = { id: row.id, senderId: f.a, recipientId: f.b, targetKey: KEY }, seen = [];
  const refuse = other => { assert.throws(() => wake.take(f.source, { ...spec, ...other }), e => e.uiMessage?.key === 'error.wake.credentialInvalid'); seen.push(row.wake.takeRefused); };
  refuse({}); delete row.wake.takeRefused;
  f.options.beforeTake = () => {
    f.options.beforeTake = null; refuse({ recipientId: f.c }); refuse({ targetKey: '.' });
    const r = f.source.runtimes.get(f.a); f.source.runtimes.delete(f.a); refuse({}); f.source.runtimes.set(f.a, r);
  };
  await one.finish();
  assert.deepEqual(seen, ['not-being-sent', 'recipient-mismatch', 'backend-mismatch', 'source-runtime-changed'].map(code => ({ code })));
  assert.deepEqual([row.wake.status, row.wake.takeRefused], ['submitted', undefined], 'the right one still takes it');
  assert.throws(() => wake.take(f.source, { ...spec, id: 'none' }), e => e.uiMessage?.key === 'error.wake.credentialInvalid');
  f.observe(); assert.deepEqual(f.events(), []);
});

test('refused as it is being taken, to the butler or from an ordinary session: told as before', async t => {
  const f = await fixture(t); f.designate(f.session(f.target, f.b)); f.advance(1000);
  for (const to of [f.b]) {
    const one = await f.begin('one', 'Secret task.', { from: f.c, to });
    f.options.beforeTake = () => f.source.runtimes.get(f.c).emit('nativeBlock', { kind: 'gap' });
    await one.finish(); f.observe();
    assert.equal(f.row(f.c).wake.untaken, true);
    assert.deepEqual(f.events().map(e => e.payload), [{ memberId: f.c, reason: 'wake-undelivered', outcome: 'unconfirmed:delivery-failed', title: new Date(f.now()).toISOString() }]);
  }
});

test('a row that names no usable reason, or is still being sent: not taken, or no event', async t => {
  const f = await fixture(t);
  const row = (id, status, extra) => ({ id, origin: 'agent-wake-intent', uiMessage: { version: 1, key: 'error.wake.deliveryUnconfirmed', params: {} },
    wake: { id, senderId: f.a, nativeId: f.source.get(f.a).nativeId, recipientId: f.b, body: 'Secret.', time: f.now(), status, untaken: true, ...extra } });
  f.observe(f.main, [{ ...f.source.get(f.a), messages: [row('none', 'unconfirmed'), row('bad', 'unconfirmed', { takeRefused: { code: 'Secret words' } }), row('open', 'sending')] }]);
  assert.deepEqual(f.events().map(e => [e.payload.itemId, e.payload.outcome]), [['none', 'not-sent:not-taken'], ['bad', 'not-sent:not-taken']]);
});

test('held, offered and refused as it is taken: the reason of that attempt', async t => {
  const f = await fixture(t); f.busy(); const one = await f.begin('one', 'Secret task.'); await one.finish();
  assert.equal(f.row().wake.status, 'held'); f.row().wake.takeRefused = { code: 'earlier' };
  f.idle(); f.options.receiveFails = true; f.advance(2 * MIN); await f.retry();
  assert.deepEqual([f.row().wake.status, f.row().wake.takeRefused], ['unconfirmed', { code: 'not-taken' }]);
  f.observe(); assert.deepEqual(f.outcomes(), ['not-sent:not-taken']);
});

test('the person designates another session directly: what the one before was told is saved is the new butler\'s too', async t => {
  const f = await fixture(t); f.busy();
  const one = await f.begin('one', 'Secret held task.'); await one.finish();
  assert.equal(f.row().wake.status, 'held');
  f.advance(MIN); f.designate(f.session(f.source, f.c)); f.advance(1000);
  f.observe(); assert.deepEqual(f.events(), [], 'still waiting');
  f.advance(MIN); await f.stop(f.a); f.observe(); f.observe();
  assert.deepEqual(f.events().map(e => e.payload), [own(f, f.row(), 'cancelled:disconnecting')]);
  // What it sends after it stopped being the butler is an ordinary session's.
  const g = await fixture(t);
  g.designate(g.session(g.source, g.c)); g.advance(1000);
  const after = await g.begin('after', 'Secret task.'); await after.finish('failed');
  assert.equal(g.row().wake.status, 'cancelled'); g.observe(); assert.deepEqual(g.events(), []);
});

test('two direct designations on, and no butler in between: still one event; without a role record, none is guessed', async t => {
  const f = await fixture(t); f.busy();
  const one = await f.begin('one', 'Secret held task.'); await one.finish();
  f.advance(1000); f.designate(null); f.advance(1000); await f.stop(f.a);
  f.observe(); assert.deepEqual(f.events(), [], 'nobody to tell');
  f.advance(MIN); f.designate({ sessionId: 'between', nativeId: 'native-between' }); f.advance(1000); f.designate(f.session(f.source, f.c)); f.observe();
  assert.deepEqual(f.events().map(e => e.payload.reason), ['own-message-undelivered']);
  const g = await fixture(t); g.busy();
  const two = await g.begin('two', 'Secret held task.'); await two.finish(); await g.stop(g.a);
  const next = () => g.session(g.source, g.c), sessions = g.source.snapshot().sessions;
  for (const wasButler of [undefined, () => false, () => undefined, () => { throw Error('unreadable'); }]) g.main.ingress.observeWakeUndelivered(sessions, { steward: next, wasButler });
  assert.deepEqual(g.events(), []);
});

test('the backend starts again with one held, one registered: each is settled, recorded once and not sent', async t => {
  for (const restart of ['main still running', 'main opened after the backend']) {
    const f = await fixture(t); f.busy();
    const one = await f.begin('one', 'Secret held task.'); await one.finish(); f.idle(); f.advance(1000);
    await f.begin('two', 'Secret registered task.', { to: f.b });
    assert.deepEqual(f.rows().map(m => m.wake.status), ['held', 'staged'], restart);
    f.source.persist(); f.advance(MIN);
    const reopened = new Workspace({ binaries: {}, close() {} }, f.root); t.after(() => reopened.close());
    const rows = reopened.get(f.a).messages.filter(m => m.wake), at = f.now();
    assert.deepEqual(rows.map(m => m.wake.status), ['cancelled', 'unconfirmed']);
    f.advance(5000);
    const main = restart === 'main still running' ? f.main : f.open();
    f.observe(main, reopened.snapshot().sessions); f.observe(main, reopened.snapshot().sessions);
    assert.deepEqual(f.events(main).map(e => e.payload), [own(f, rows[0], 'cancelled:held-restored', at), own(f, rows[1], 'unconfirmed:restored', at)], restart);
    const again = f.open(); f.observe(again, reopened.snapshot().sessions); assert.equal(f.events(again).length, 2);
    wake.retryHeld(reopened); await settle(); assert.equal(f.writes.length, 0);
  }
});

test('withdrawn while the app was closed: recorded when it opens, once; an ordinary session\'s own history is not', async t => {
  const f = await fixture(t); f.busy();
  const one = await f.begin('one', 'Secret held task.'); await one.finish();
  // Sent by C as an ordinary session, before it became the butler.
  const other = await f.begin('other', 'Secret other task.', { from: f.c }); await other.finish('failed');
  f.advance(1000); await f.stop(f.a); f.advance(MIN);
  const main = f.open(); f.observe(main); f.observe(main);
  assert.deepEqual(f.events(main).map(e => e.payload.itemId), [f.row().id]);
  main.record.designated(f.session(f.source, f.c)); f.follow(f.session(f.source, f.c), []);
  f.advance(1000); const later = f.open(); f.observe(later);
  assert.equal(f.events(later).length, 1);
});

// 300's integration review, B3: which report a message gets is decided by who held the role as it was sent.
const synthetic = (f, sender, recipientId, id, extra) => ({ id, origin: 'agent-wake-intent', uiMessage: { version: 1, key: 'notice.wake.restored', params: {} },
  wake: { id, senderId: sender.sessionId, nativeId: sender.nativeId, recipientId, body: 'Secret.', time: f.now(), settledAt: f.now() + MIN, status: 'unconfirmed', told: true, ...extra } });
const person = id => ({ sessionId: id, nativeId: 'native-' + id });
const reported = f => f.events().map(e => [e.payload.itemId ?? null, e.payload.reason, e.payload.memberId, e.payload.outcome]);

test('a butler\'s saved message to the session the person then designates directly: its own, arrival unconfirmed, once', async t => {
  const f = await fixture(t);
  await f.begin('one', 'Secret saved task.');
  assert.equal(f.row().wake.status, 'staged'); f.advance(1000);
  f.designate(f.session(f.target, f.b)); f.source.persist(); f.advance(MIN);
  const reopened = new Workspace({ binaries: {}, close() {} }, f.root); t.after(() => reopened.close());
  const row = reopened.get(f.a).messages.findLast(m => m.wake), at = f.now();
  assert.deepEqual([row.wake.status, row.uiMessage.key], ['unconfirmed', 'notice.wake.restored']);
  f.observe(f.main, reopened.snapshot().sessions); f.observe(f.main, reopened.snapshot().sessions);
  assert.deepEqual(f.events().map(e => e.payload), [own(f, row, 'unconfirmed:restored', at)]);
  f.advance(1000); const later = f.open(); f.observe(later, reopened.snapshot().sessions);
  assert.equal(f.events(later).length, 1, 'main restarting records it no second time');
  // Also one that did not go out: the same message is not also one to the butler.
  const g = await fixture(t); g.busy();
  const two = await g.begin('two', 'Secret held task.'); await two.finish(); g.advance(1000);
  g.designate(g.session(g.target, g.b)); g.advance(MIN); await g.stop(g.a); g.observe(); g.observe();
  assert.deepEqual(g.events().map(e => e.payload), [own(g, g.row(), 'cancelled:disconnecting')]);
  // Refused as it was called, so never said to be saved: to the butler of now as before, not its own.
  const h = await fixture(t); h.target.get(h.b).wakeDisabled = true;
  const off = await h.begin('off', 'Secret refused task.'); await off.finish(); assert.equal(off.result.status, 'not-sent');
  h.advance(1000); h.designate(h.session(h.target, h.b)); h.observe();
  assert.deepEqual(h.events().map(e => [e.payload.reason, e.payload.memberId]), [['wake-undelivered', h.a]]);
});

test('sent by the butler of now before it became the butler: not its own, also once it has rotated', async t => {
  const f = await fixture(t), b = person('b'), c = person('c');
  const early = [synthetic(f, b, 'member', 'early'), synthetic(f, b, f.a, 'early-to-butler', { status: 'not-sent', uiMessage: undefined })];
  f.advance(1000); f.designate(b); f.advance(1000);
  const sessions = () => [{ id: b.sessionId, nativeId: b.nativeId, messages: [...early, ...mine] }]; let mine = [];
  f.observe(f.main, sessions()); assert.deepEqual(reported(f), []);
  mine = [synthetic(f, b, 'member', 'mine')];
  f.observe(f.main, sessions()); assert.deepEqual(reported(f), [['mine', 'own-message-undelivered', 'member', 'unconfirmed:restored']]);
  // The same native session only: its workspace id under another native identity did not hold the role.
  mine.push(synthetic(f, { ...b, nativeId: 'native-before' }, 'member', 'other-native'));
  f.observe(f.main, sessions()); assert.equal(f.events().length, 1);
  // After a rotation what it sent before its designation is still nobody's own.
  f.advance(1000); f.follow(c, [b.sessionId]); f.observe(f.main, sessions()); f.main.record.sync(c); f.observe(f.main, sessions());
  assert.equal(f.events().length, 1);
});

test('along a rotation chain: what each session sent in its turn is the butler\'s of now, lines in the record or not', async t => {
  const f = await fixture(t), a = f.session(f.source, f.a), [b, c] = [person('b'), person('c')];
  const sessions = [{ id: f.a, nativeId: a.nativeId, messages: [synthetic(f, a, 'member', 'of-a')] }];
  f.advance(1000);
  // B followed A and made no call: the record has no line of it. C followed B, and the record has not noticed yet.
  sessions.push({ id: 'b', nativeId: b.nativeId, messages: [synthetic(f, b, 'member', 'of-b'), synthetic(f, b, 'c', 'of-b-to-c')] });
  f.advance(1000); f.follow(c, ['b', f.a]);
  sessions.push({ id: 'c', nativeId: c.nativeId, messages: [synthetic(f, c, 'member', 'of-c')] });
  f.observe(f.main, sessions); f.observe(f.main, sessions);
  assert.deepEqual(reported(f).map(r => r.slice(0, 2)), ['of-a', 'of-b', 'of-b-to-c', 'of-c'].map(id => [id, 'own-message-undelivered']));
  f.main.record.sync(c); f.observe(f.main, sessions); assert.equal(f.events().length, 4);
  // The person designates the chain's newest again: what came before is still its own.
  f.advance(1000); f.designate(c); sessions[1].messages.push(synthetic(f, b, 'member', 'of-b-again', { time: f.now() - 1500 }));
  f.advance(1000); f.observe(f.main, sessions); assert.equal(f.events().at(-1).payload.itemId, 'of-b-again');
  // Told it was saved and lost while the app was closed: B's too, as of a session with a line.
  sessions[1].messages.push(synthetic(f, b, 'member', 'of-b-closed', { time: f.now() - 2500, settledAt: f.now() - 2400 }));
  const later = f.open(); f.observe(later, sessions); assert.equal(f.events(later).at(-1).payload.itemId, 'of-b-closed'); assert.equal(f.events(later).length, 6);
});

test('no role record to read: what the butler lost since the intake is not left out, and none is guessed to be another session\'s', async t => {
  const broken = { 'it throws': () => { throw Error('unreadable'); }, 'it cannot say': () => undefined };
  for (const [name, wasButler] of Object.entries(broken)) {
    const f = await fixture(t), a = f.session(f.source, f.a), b = person('b'), c = person('c');
    const sessions = [{ id: f.a, nativeId: a.nativeId, messages: [synthetic(f, a, 'b', 'a-to-b'), synthetic(f, a, 'member', 'a-to-member'), synthetic(f, a, 'b', 'a-to-b-unmarked', { told: undefined })] },
      { id: 'b', nativeId: b.nativeId, messages: [synthetic(f, b, 'member', 'of-b'), synthetic(f, b, 'member', 'of-b-history', { settledAt: 1 })] }, { id: 'c', nativeId: c.nativeId, messages: [synthetic(f, c, 'member', 'of-c')] }];
    const observe = () => f.main.ingress.observeWakeUndelivered(sessions, { steward: () => b, formerly: () => ['c'], wasButler });
    observe(); observe();
    // A, on no chain, may have been the butler: its message to the butler of now is said as what it is, from A to the
    // butler; nothing says whose the one to a member is.
    assert.deepEqual(reported(f), [[null, 'wake-undelivered', f.a, 'unconfirmed:restored'], ['of-b', 'own-message-undelivered', 'member', 'unconfirmed:restored'],
      ['of-c', 'own-message-undelivered', 'member', 'unconfirmed:restored']], name);
    // Readable again: the one that could not be placed is recorded, the others no second time.
    f.advance(1000); f.designate(b); const later = f.open(); f.advance(1000);
    const events = () => later.ingress.observeWakeUndelivered(sessions, { steward: () => b, formerly: () => [], wasButler: (...who) => later.record.heldRole(...who) });
    events(); events();
    assert.deepEqual(f.events(later).slice(3).map(e => [e.payload.itemId, e.payload.reason]), [['a-to-member', 'own-message-undelivered'], ['a-to-b-unmarked', 'own-message-undelivered']], name);
  }
});

test('refused when it was called: the call said so, no event', async t => {
  const f = await fixture(t);
  f.target.get(f.b).wakeDisabled = true;
  const off = await f.begin('off', 'Secret one.'); await off.finish(); assert.equal(off.result.status, 'not-sent');
  f.target.get(f.b).wakeDisabled = false; f.advance(1000);
  const self = await f.begin('self', 'Secret two.', { to: f.a }); assert.ok(self.result.error); await self.finish();
  const persist = f.source.persist.bind(f.source);
  // Also one for a recipient in a quiet window, or at work.
  for (const set of [() => {}, () => quiet(f), () => { fs.rmSync(path.join(f.root, 'quiet-windows.json')); f.busy(); }]) {
    f.advance(1000); set(); f.source.persist = () => { f.source.storageWarning = 'Synthetic'; };
    const unsaved = await f.begin('unsaved-' + f.now(), 'Secret three.');
    f.source.persist = persist; f.source.storageWarning = null; await unsaved.finish();
    assert.ok(unsaved.result.error, 'could not be saved');
  }
  assert.deepEqual(f.rows().map(m => [m.wake.status, m.wake.told, Boolean(m.wake.quietWindow)]), [['not-sent', undefined, false], ['unconfirmed', undefined, false], ['unconfirmed', undefined, true], ['unconfirmed', undefined, false]]);
  f.observe(); assert.deepEqual(f.events(), []);
});

test('a sender that never was the butler: no event; a message to the butler is recorded as before', async t => {
  const f = await fixture(t);
  const one = await f.begin('one', 'Secret one.', { from: f.c }); await one.finish('failed');
  f.observe(); assert.deepEqual(f.events(), []);
  const g = await fixture(t);
  g.designate(g.session(g.target, g.b)); g.advance(1000);
  // The butler of before writes to the one of now: the same row, recorded as a message to the butler.
  const to = await g.begin('to', 'Secret two.'); await to.finish('failed'); g.observe();
  assert.deepEqual(g.events().map(e => e.payload), [{ memberId: g.a, reason: 'wake-undelivered', outcome: 'cancelled:turn-not-completed', title: new Date(g.now()).toISOString() }]);
  // One an ordinary session sent that it took without confirming is in its own conversation, or lost: as before, no event.
  g.advance(1000); g.options.silent = true;
  const quietly = await g.begin('quietly', 'Secret three.'); g.advance(1000); await quietly.finish();
  assert.equal(g.row().wake.status, 'unconfirmed'); g.observe(); assert.equal(g.events().length, 1);
  // The butler's own message to the session it continued from is its own.
  const h = await fixture(t); h.follow(h.session(h.source, h.a), [h.b]);
  const back = await h.begin('back', 'Secret four.'); await back.finish('failed'); h.observe();
  assert.deepEqual(h.events().map(e => e.payload), [own(h, h.row(), 'cancelled:turn-not-completed')]);
  // Refused as it was called, with a row or without one: the call said so.
  h.target.get(h.b).wakeDisabled = true; h.advance(1000);
  const off = await h.begin('off', 'Secret five.'); await off.finish(); assert.equal(off.result.status, 'not-sent');
  h.observe(h.main, [{ ...h.source.get(h.a), wakeUndelivered: [{ id: randomUUID(), at: h.now(), recipientId: h.b, key: null }] }]);
  assert.equal(h.events().length, 1);
});

test('rows of a backend from before the mark: withdrawn, held or lost are recorded; one refused at once, or from before the intake, is not', async t => {
  const f = await fixture(t);
  const old = (id, status, extra = {}, key = null) => ({ id, origin: 'agent-wake-intent', uiMessage: key ? { version: 1, key, params: {} } : undefined,
    wake: { id, senderId: f.a, nativeId: f.source.get(f.a).nativeId, recipientId: f.b, body: 'Secret.', time: f.now(), status, ...extra } });
  const sessions = messages => [{ ...f.source.get(f.a), messages }];
  f.observe(f.main, sessions([old('w', 'cancelled', {}, 'notice.wake.turnCancelled'), old('h', 'not-sent', { heldAt: f.now() }), old('q', 'not-sent', { quietWindow: { id: 'x', deadline: 1 } }),
    old('b', 'not-sent', { busyHold: { deadline: 1 } }), old('l', 'unconfirmed', {}, 'error.wake.deliveryUnconfirmed'),
    old('r', 'not-sent'), old('s', 'unconfirmed', {}, 'notice.wake.saveFailed'), old('early', 'cancelled', { time: 1000 }), old('open', 'held', { heldAt: f.now() })]));
  assert.deepEqual(f.events().map(e => e.payload.itemId), ['w', 'h', 'q', 'b', 'l']);
  const before = old('before', 'cancelled'); f.advance(1000);
  const later = f.open(); f.observe(later, sessions([before]));
  assert.deepEqual(f.events(later).map(e => e.payload.itemId), ['w', 'h', 'q', 'b', 'l'], 'sent in the role, withdrawn before this intake: without the mark, not announced');
});

// A gap, a takeover in a space and a stop for maintenance or a handoff were one code.
const withdrawals = {
  'observation-gap': f => f.source.runtimes.get(f.a).emit('nativeBlock', { kind: 'gap' }),
  'human-control': f => f.source.claim(f.a, 'another-window', 'chat', 'shared'),
  disconnecting: f => f.stop(f.a),
};
for (const [code, act] of Object.entries(withdrawals)) test(`why a held one was withdrawn is its own code: ${code}`, async t => {
  const f = await fixture(t); f.busy();
  const one = await f.begin('one', 'Secret held task.'); await one.finish(); f.advance(MIN);
  await act(f); assert.equal(f.row().wake.status, 'cancelled'); assert.equal(f.row().uiMessage.key, 'notice.wake.observationBoundaryKnownReason');
  f.observe(); assert.deepEqual(f.outcomes(), [`cancelled:${code}`]);
});
test('withdrawn with a code of its own, or with no cause: as before', async t => {
  const f = await fixture(t), row = (id, uiMessage, extra) => ({ id, origin: 'agent-wake-intent', uiMessage,
    wake: { id, senderId: f.a, nativeId: f.source.get(f.a).nativeId, recipientId: f.b, body: 'Secret.', time: f.now(), status: 'cancelled', told: true, ...extra } });
  const cause = { version: 1, key: 'notice.run.observationGap', params: {} };
  f.observe(f.main, [{ ...f.source.get(f.a), messages: [row('own', { version: 1, key: 'notice.wake.turnCancelled', params: {}, cause }, { cancellation: { code: 'turn-not-completed', at: f.now() } }),
    row('plain', { version: 1, key: 'notice.wake.heldCancelled', params: {} }), row('none', undefined)] }]);
  assert.deepEqual(f.outcomes(), ['cancelled:turn-not-completed', 'cancelled:held-cancelled', 'cancelled:unknown']);
});

test('the role record says who held the role and when, in its own words only', async t => {
  const f = await fixture(t), record = f.main.record, at = f.now(), nativeId = f.source.get(f.a).nativeId;
  assert.equal(record.heldRole(f.a, nativeId, at), true);
  assert.equal(record.heldRole(f.a, 'another-native', at), false); assert.equal(record.heldRole('another', nativeId, at), false);
  assert.equal(record.heldRole(f.a, nativeId, at - 5000), false, 'before it was designated');
  f.advance(1000); f.designate(null);
  assert.equal(record.heldRole(f.a, nativeId, f.now()), false); assert.equal(record.heldRole(f.a, nativeId, at), true);
  assert.equal(record.heldRole(f.c, f.source.get(f.c).nativeId, at), false);
});

test('the role record says neither yes nor no of a time it cannot know', async t => {
  const f = await fixture(t), record = f.main.record, a = f.session(f.source, f.a), [b, c] = [person('b'), person('c')];
  const held = (who, at, chain) => record.heldRole(who.sessionId, who.nativeId, at, chain && new Set(chain));
  assert.deepEqual([held(a, undefined), record.heldRole(f.a, undefined, f.now())], [undefined, undefined]);
  // Along a chain: the line of one stands for those it handed the role to.
  const t1 = f.now();
  assert.deepEqual([held(b, t1), held(b, t1, ['b', f.a]), held(b, t1, ['b'])], [false, true, undefined], 'alone; a chain from A; designated, and the record is behind');
  f.advance(1000); f.designate(b); const t2 = f.now();
  assert.deepEqual([held(b, t1, ['b']), held(b, t2, ['b']), held(a, t2, ['b']), held({ ...b, nativeId: 'other' }, t2, ['b'])], [false, true, false, false]);
  // Started: the butler was designated some time after the line before, when no line could be written.
  f.advance(1000); f.designate(null); const ended = f.now(); f.advance(1000); const t3 = f.now(); f.advance(1000);
  record.append({ kind: 'role', event: 'started', session: { id: 'c', nativeId: 'native-c' } });
  assert.deepEqual([held(c, ended), held(c, t3), held(c, t3, ['c', 'b']), held(b, t3, ['c', 'b']), held(b, t3), held(c, t2)], [undefined, undefined, undefined, undefined, undefined, false], 'nobody knows who until that line');
  // A line that cannot be written: what came before stands, later nobody knows.
  f.advance(1000); const t4 = f.now(); f.advance(1000); record.log.append = () => { throw Error('Synthetic'); };
  assert.throws(() => record.designated(b)); const t5 = f.now();
  assert.deepEqual([held(c, t4), held(b, t1), held(c, t5), held(b, t5, ['b'])], [true, false, undefined, undefined]);
  // A successor the role did not follow, then chosen by the person: not before that.
  const g = await fixture(t), x = person('x'), at = g.now(); g.advance(1000); g.designate(x);
  assert.equal(g.main.record.heldRole('x', 'native-x', at, new Set(['x', g.a])), false);
  assert.equal(g.main.record.heldRole('y', 'native-y', at, new Set(['x', 'y', g.a])), true, 'one between them');
  // One the role followed to held it from its start, before the line that noticed it; who came before it is not known.
  const follows = path.join(g.root, 'follows'); fs.mkdirSync(follows, { mode: 0o700 });
  const followed = new StewardRecord(follows, { steward: () => x, selected: () => person('first'), now: () => g.now() });
  followed.append({ kind: 'role', event: 'revoked', session: null }); g.advance(1000); const gap = g.now(); g.advance(1000); followed.sync(x);
  assert.equal(followed.roles().at(-1).event, 'followed');
  assert.deepEqual([['x', ['x', 'y']], ['y', ['x', 'y']], ['y', ['x']], ['y']].map(([id, chain]) => followed.heldRole(id, 'native-' + id, gap, chain && new Set(chain))), [true, undefined, false, false]);
  // Before the first line: not the butler if that line is a designation, not known if it was already one.
  const first = await fixture(t); assert.equal(first.main.record.heldRole('b', 'native-b', 1), false);
  const dir = path.join(first.root, 'started'); fs.mkdirSync(dir, { mode: 0o700 });
  const started = new StewardRecord(dir, { steward: () => b, selected: () => b, now: () => first.now() });
  assert.equal(started.heldRole('c', 'native-c', first.now()), undefined, 'no line at all');
  started.sync(b); assert.equal(started.heldRole('c', 'native-c', first.now() - 1), undefined);
  // A block that cannot be read.
  const file = fs.readdirSync(path.join(f.mainDir, 'history'), { recursive: true }).map(name => path.join(f.mainDir, 'history', String(name))).find(name => fs.statSync(name).isFile() && /steward/.test(name));
  fs.writeFileSync(file, 'not a record\n', { mode: 0o600 });
  const unread = f.open().record; assert.equal(unread.failed, true);
  assert.deepEqual([unread.heldRole(f.a, a.nativeId, t1), unread.heldRole('b', 'native-b', t2)], [undefined, undefined]);
});

test('main: each backend state is judged with the role record, and the butler a rotation made is recorded before another is designated', async t => {
  const f = await fixture(t); f.busy();
  const one = await f.begin('one', 'Secret held task.'); await one.finish(); f.advance(1000); await f.stop(f.a);
  const client = new EventEmitter(), context = { background: true, client, win: { isDestroyed: () => false } };
  const main = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  const bind = main.slice(main.indexOf('function bindClient(context)'), main.indexOf('function displayState('));
  f.main.record.designated(f.session(f.source, f.c));
  vm.runInNewContext(bind + '\nbindClient(context);', { context, butlerIngress: f.main.ingress, stewardRole: { current: () => f.session(f.source, f.c) }, stewardRecord: f.main.record,
    queueDispatcher: null, sessionLabels: { labels: new Map() }, roomState: new RoomState(f.mainDir), broadcastRoom: async () => {} });
  client.emit('state', f.source.snapshot());
  assert.deepEqual(f.outcomes(), ['cancelled:disconnecting']);
  // The sessions the butler continued from go with it: one between two of the record's lines is its own too.
  const between = person('between'); f.advance(1000);
  const linked = new EventEmitter(), other = { background: true, client: linked, win: { isDestroyed: () => false } };
  vm.runInNewContext(bind + '\nbindClient(context);', { context: other, butlerIngress: f.main.ingress, stewardRole: { current: () => person('last') }, stewardRecord: f.main.record,
    queueDispatcher: { continuedFrom: id => id === 'last' ? ['between', f.c] : [] }, sessionLabels: { labels: new Map() }, roomState: new RoomState(f.mainDir), broadcastRoom: async () => {} });
  linked.emit('state', { sessions: [{ id: 'between', nativeId: between.nativeId, messages: [synthetic(f, between, 'member', 'early', { time: f.now() - 60000 }), synthetic(f, between, 'member', 'of-between', { settledAt: 1 })] }] });
  assert.deepEqual(reported(f).slice(1).map(r => r[0]), ['of-between'], 'also lost before this intake, told it was saved');
  // The person's designation.
  const start = main.indexOf("  register('steward', async ");
  const end = main.indexOf("  register('stewardStanding',", start);
  assert.ok(start >= 0 && end > start);
  const handler = main.slice(start, end);
  for (const next of [null, 'next']) {
    const steps = [], handlers = new Map();
    vm.runInNewContext(handler, { applicationHandlers: new Map(), register: (name, run) => handlers.set(name, run), uiError: key => Error(key), validDuty: () => true, midRotation: () => false, roomIds: () => [],
      roomState: { serial: run => run(), apply: value => value }, broadcastRoom: async () => {}, stewardDutyText: () => 'duty', submit: async () => {}, stewardWake: null, stewardStanding: null,
      stewardOf: () => ({ sessionId: 'rotated', nativeId: 'native-rotated' }),
      stewardRecord: { sync: value => steps.push(['sync', value.sessionId]), designated: value => steps.push(['designated', value?.sessionId ?? null]) },
      stewardRole: { selected: null, set(value) { steps.push(['set', value?.sessionId ?? null]); this.selected = value; } } });
    const person = { background: false, client: { call: async () => ({ sessions: [{ id: 'next', nativeId: 'native-next', state: 'idle', provider: 'codex' }] }), snapshot: () => ({ sessions: [] }) } };
    const result = await handlers.get('steward')(person, next);
    if (next === null) assert.equal(result, null);
    else assert.equal(result.duty.state, 'sent');
    assert.deepEqual(steps, [['sync', 'rotated'], ['set', next], ['designated', next]]);
  }
});
