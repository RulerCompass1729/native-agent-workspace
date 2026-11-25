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
      if (method === 'wakeTake') return wake.take(w, spec);
      if (method === 'wakeReceive') { if (options.receiveFails) throw Error('Synthetic connection lost'); return wake.receive(w, spec); }
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
      wasButler: (...who) => main.record.heldRole?.(...who) === true }),
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
    [['blocked', `wake-undelivered:${f.b}`, own(f, f.row(), 'cancelled:observation-boundary-known-reason')]]);
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
  assert.deepEqual(f.events().map(e => e.payload), [own(f, f.row(), 'cancelled:observation-boundary-known-reason')]);
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
  assert.deepEqual(f.outcomes(), ['not-sent:recipient-disabled', 'unconfirmed:delivery-failed', 'unconfirmed:unconfirmed']);
  assert.deepEqual(f.events().at(-1).payload, own(f, f.row(), 'unconfirmed:unconfirmed'), 'when it ended, not when it was registered');
  const g = await fixture(t), sent = await g.begin('sent', 'Secret four.'); await sent.finish();
  assert.equal(g.row().wake.status, 'submitted'); g.observe(); assert.deepEqual(g.events(), []);
});

test('the person designates another session directly: what the one before was told is saved is the new butler\'s too', async t => {
  const f = await fixture(t); f.busy();
  const one = await f.begin('one', 'Secret held task.'); await one.finish();
  assert.equal(f.row().wake.status, 'held');
  f.advance(MIN); f.designate(f.session(f.source, f.c)); f.advance(1000);
  f.observe(); assert.deepEqual(f.events(), [], 'still waiting');
  f.advance(MIN); await f.stop(f.a); f.observe(); f.observe();
  assert.deepEqual(f.events().map(e => e.payload), [own(f, f.row(), 'cancelled:observation-boundary-known-reason')]);
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

test('refused when it was called: the call said so, no event', async t => {
  const f = await fixture(t);
  f.target.get(f.b).wakeDisabled = true;
  const off = await f.begin('off', 'Secret one.'); await off.finish(); assert.equal(off.result.status, 'not-sent');
  f.target.get(f.b).wakeDisabled = false; f.advance(1000);
  const self = await f.begin('self', 'Secret two.', { to: f.a }); assert.ok(self.result.error); await self.finish();
  f.advance(1000); const persist = f.source.persist.bind(f.source);
  f.source.persist = () => { f.source.storageWarning = 'Synthetic'; };
  const unsaved = await f.begin('unsaved', 'Secret three.');
  f.source.persist = persist; f.source.storageWarning = null; await unsaved.finish();
  assert.ok(unsaved.result.error, 'could not be saved');
  assert.deepEqual(f.rows().map(m => [m.wake.status, m.wake.told]), [['not-sent', undefined], ['unconfirmed', undefined]]);
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
  // One it took without confirming is in its own conversation, or lost: as before, no event.
  // Also when its sender still held the role as it was sent.
  g.designate(g.session(g.source, g.a)); g.advance(1000); g.options.silent = true;
  const quietly = await g.begin('quietly', 'Secret three.'); g.advance(1000); g.designate(g.session(g.target, g.b)); await quietly.finish();
  assert.equal(g.row().wake.status, 'unconfirmed'); g.observe(); assert.equal(g.events().length, 1);
  // The butler's own message to the session it continued from is its own.
  const h = await fixture(t); h.follow(h.session(h.source, h.a), [h.b]);
  const back = await h.begin('back', 'Secret four.'); await back.finish('failed'); h.observe();
  assert.deepEqual(h.events().map(e => e.payload), [own(h, h.row(), 'cancelled:turn-not-completed')]);
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

test('the role record says who held the role and when, in its own words only', async t => {
  const f = await fixture(t), record = f.main.record, at = f.now(), nativeId = f.source.get(f.a).nativeId;
  assert.equal(record.heldRole(f.a, nativeId, at), true);
  assert.equal(record.heldRole(f.a, 'another-native', at), false); assert.equal(record.heldRole('another', nativeId, at), false);
  assert.equal(record.heldRole(f.a, nativeId, at - 5000), false, 'before it was designated');
  f.advance(1000); f.designate(null);
  assert.equal(record.heldRole(f.a, nativeId, f.now()), false); assert.equal(record.heldRole(f.a, nativeId, at), true);
  assert.equal(record.heldRole(f.c, f.source.get(f.c).nativeId, at), false);
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
  assert.deepEqual(f.outcomes(), ['cancelled:observation-boundary-known-reason']);
  // The person's designation.
  const handler = main.slice(main.indexOf("  register('steward', async (c, id, duty = null) => {"), main.indexOf("  register('stewardEvents', async (c, position = null) => {"));
  for (const next of [null, 'next']) {
    const steps = [], handlers = new Map();
    vm.runInNewContext(handler, { applicationHandlers: new Map(), register: (name, run) => handlers.set(name, run), uiError: key => Error(key), validDuty: () => true, midRotation: () => false, roomIds: () => [],
      roomState: { serial: run => run(), apply: value => value }, broadcastRoom: async () => {}, stewardDutyText: () => 'duty', submit: async () => {}, stewardWake: { set() {} },
      stewardOf: () => ({ sessionId: 'rotated', nativeId: 'native-rotated' }),
      stewardRecord: { sync: value => steps.push(['sync', value.sessionId]), designated: value => steps.push(['designated', value?.sessionId ?? null]) },
      stewardRole: { selected: null, set(value) { steps.push(['set', value?.sessionId ?? null]); this.selected = value; } } });
    const person = { background: false, client: { call: async () => ({ sessions: [{ id: 'next', nativeId: 'native-next', state: 'ended-later', provider: 'codex' }] }), snapshot: () => ({ sessions: [] }) } };
    try { await handlers.get('steward')(person, next); } catch { /* The duty text has no session to go to here. */ }
    assert.deepEqual(steps, [['sync', 'rotated'], ['set', next], ['designated', next]]);
  }
});
