'use strict';
// R200 (the person, 2026-11-24: 「我点了卡为撒你没反应」): the click on the butler's card was recorded at once, but the
// butler's backend was in a migration quiet window and no wake went out until it ended. The person's own act is told to
// the butler past the window; every other event and every other gate stays. Synthetic sessions; no model, no daily data.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { RoomState } = require('../room-state.cjs');
const rules = require('../queue-dispatch.cjs'), { QueueDispatcher, CAPABILITY } = rules;
const { ButlerLedger } = require('../butler-ledger.cjs'), { ButlerIngress } = require('../butler-ingress.cjs');
const { PersonActions } = require('../person-actions.cjs');
const { StewardWake } = require('../steward-wake.cjs');
const { QuietWindows } = require('../quiet-windows.cjs');

const MIN = 60000, START = 1_800_000_000_000, HOUR = 60 * MIN, KEY = 'backends/bbbbbbbbbbbbbbbbbbbb', OTHER = 'backends/cccccccccccccccccccc';
const BUTLER = { sessionId: 'butler', nativeId: 'native-butler' };
const session = (id, extra = {}) => ({ id, name: `Synthetic ${id}`, provider: 'claude', nativeId: `native-${id}`, model: 'synthetic-model', state: 'idle', roomIds: [], roomId: null,
  createdAt: START - HOUR, lastActivityAt: START - MIN, background: 0, scheduled: 0, backgroundStale: false, chatAvailable: true, liveDraft: '', serviceCapabilities: [CAPABILITY], fleet: [], messages: [], ...extra });
const quietWindow = (sessions, extra = {}) => ({ id: '00000000-0000-4000-8000-000000000001', scope: `backend:${KEY}`, reason: 'migration', openedBy: 'naw',
  openedAt: START, deadline: START + HOUR, waited: 'busy', sessions, ...extra });

// The real dispatcher, wake, window record and person-action intake over one synthetic backend.
function fixture(t, { butler = {}, others = [], windows = [quietWindow(['butler', 'pm'])] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-person-window-')); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { now: START + MIN }, lines = [], sent = [], room = new RoomState(dir), ledger = new ButlerLedger(dir, { now: () => clock.now });
  const ingress = new ButlerIngress(dir, { roomState: room, ledger, now: () => clock.now }), actions = new PersonActions({ ingress, now: () => clock.now });
  const sessions = [session('butler', butler), ...others];
  const client = Object.assign(new EventEmitter(), { state: { sessions, rooms: [{ id: 'shared', revision: 0, run: null, messages: [] }], wakePolicy: { enabled: true }, capabilities: [CAPABILITY] },
    close() {}, snapshot: () => structuredClone(client.state), refresh: async () => client.snapshot(), route: () => ({ client, state: { capabilities: [CAPABILITY] } }),
    call: async (method, ...args) => {
      if (method === 'initial') return client.snapshot();
      if (method !== 'dispatch') return undefined;
      sent.push({ id: args[0], itemId: args[3]?.itemId ?? args[3], at: clock.now });
      const s = sessions.find(x => x.id === args[0]); s.state = 'working'; s.lastActivityAt = clock.now;
      return `tag-${sent.length}`;
    } });
  const wake = new StewardWake(dir, { ledger: () => ledger, selected: () => BUTLER, now: () => clock.now, record: line => lines.push(line) });
  fs.writeFileSync(path.join(dir, 'quiet-windows.json'), JSON.stringify({ format: 1, windows, history: [] }), { mode: 0o600 });
  const quiet = new QuietWindows(dir, { now: () => clock.now, moveWait: rules.moveWait });
  const dispatcher = new QueueDispatcher({ roomState: room, dataDir: dir, connect: async () => client, now: () => clock.now, settleMs: 8000, tickMs: 3000,
    steward: () => ({ ...BUTLER, duty: '' }), stewardWake: wake, quietWindows: quiet, transcriptRoot: path.join(dir, 'none'),
    sampleProcesses: async () => '', samplePressure: async () => '' });
  t.after(() => dispatcher.close());
  wake.set(true);
  const f = { dir, clock, lines, sent, room, ledger, client, wake, quiet, dispatcher, actions, sessions, butler: sessions[0] };
  f.rows = [];
  // The card as BackgroundControl records the person's answer to it.
  f.click = (id = 'card-1', humanDecision = 1) => {
    f.rows.push({ id, actor: { id: 'butler', nativeId: 'native-butler' }, command: { method: 'createSession' }, confirmation: { options: { cancelId: 0 } }, humanDecision, humanDecisionAt: clock.now, state: 'complete' });
    actions.observe({}, f.rows);
  };
  // Another act of the person's, not on one of the butler's cards (those: steward-wake-card-click.test.cjs).
  f.act = (id = 'item-1') => actions.call('spaceAction', ['space-1', 'queueResolve', [id, 'SYNTHETIC PRIVATE ANSWER']], true);
  f.event = (n = 1) => ledger.ingest({ eventId: `butler-source:${n}`, sourceRef: `queue-outcome:space-1:${n}`, kind: 'failure', payload: { spaceId: 'space-1', itemId: `item-${n}`, reason: 'Synthetic failure' } });
  // Passes as the dispatcher's own timer makes them, every 3 seconds, for `ms`.
  f.run = async (ms, { hurry = false } = {}) => {
    const end = clock.now + ms;
    do { if (hurry) dispatcher.dirty = true; await dispatcher.schedule(); clock.now += 3000; } while (clock.now <= end);
  };
  f.held = () => wake.view({ held: true }).blocked;
  return f;
}

test('the person\'s click wakes the butler within a minute while its backend is in a quiet window, once', async t => {
  for (const decision of [1, 0]) {
    const f = fixture(t);
    await f.run(30000);
    f.click('card-1', decision); const at = f.clock.now;
    await f.run(MIN);
    assert.deepEqual(f.sent.map(s => [s.id, s.itemId.split(':')[0]]), [['butler', 'steward-wake']], `decision ${decision}`);
    assert.ok(f.sent[0].at - at <= MIN, `${f.sent[0].at - at} ms`);
    assert.equal(f.wake.due(), false); assert.equal(f.held(), undefined);
    // Its turn ends inside the window: the same click is not told again.
    Object.assign(f.butler, { state: 'idle', lastActivityAt: f.clock.now });
    f.actions.observe({}, f.rows);
    await f.run(10 * MIN);
    assert.equal(f.sent.length, 1);
    assert.ok(f.quiet.windowOf('butler', f.clock.now), 'the window is still open');
  }
});

test('an ordinary event in the window still waits for it to end', async t => {
  const f = fixture(t);
  f.event(); await f.run(20 * MIN);
  assert.deepEqual(f.sent, []);
  assert.deepEqual([f.held()?.reason, f.held()?.deadline], ['quiet-window', START + HOUR]);
  f.clock.now = START + HOUR; await f.run(MIN);
  assert.equal(f.sent.length, 1);
});

test('a click is told together with the ordinary events before it; those after it wait for the window', async t => {
  const f = fixture(t);
  f.event(1); await f.run(5 * MIN); assert.deepEqual(f.sent, []);
  f.click(); await f.run(MIN); assert.equal(f.sent.length, 1);
  Object.assign(f.butler, { state: 'idle', lastActivityAt: f.clock.now });
  f.event(2); await f.run(10 * MIN);
  assert.equal(f.sent.length, 1); assert.equal(f.held()?.reason, 'quiet-window');
  f.click('card-2'); await f.run(MIN); assert.equal(f.sent.length, 2, 'the next click is told too');
});

test('two answers on queue items within a minute are told at most a minute apart', async t => {
  const f = fixture(t);
  f.act(); await f.run(6000, { hurry: true }); assert.equal(f.sent.length, 1);
  Object.assign(f.butler, { state: 'idle', lastActivityAt: f.clock.now - 10000 });
  f.act('item-2'); await f.run(2 * MIN, { hurry: true });
  assert.equal(f.sent.length, 2); assert.ok(f.sent[1].at - f.sent[0].at >= MIN);
});

test('a card or grant running out of time is not the person\'s act', async t => {
  const f = fixture(t);
  f.actions.observe({ operatorPolicy: { domains: [{ id: 'domain', source: 'human', createdAt: START, expiresAt: START + 1 }] } },
    [{ id: 'late', actor: { id: 'butler', nativeId: 'native-butler' }, command: { method: 'x' }, state: 'not-executed', disposition: 'expired', finishedAt: START }]);
  const reasons = f.ledger.eventsAfter(null).events.map(e => e.payload.reason);
  assert.ok(reasons.includes('person-action:confirmation:expire') && reasons.includes('person-action:operator:expire'));
  f.wake.set(false); f.wake.set(true);
  f.ledger.ingest({ eventId: 'e1', sourceRef: 'e1', kind: 'request', payload: { reason: 'person-action:confirmation:expire', outcome: 'not-executed' } });
  f.ledger.ingest({ eventId: 'e2', sourceRef: 'e2', kind: 'request', payload: { reason: 'person-action:operator:expire', outcome: 'expired' } });
  f.ledger.ingest({ eventId: 'e3', sourceRef: 'e3', kind: 'blocked', payload: { reason: 'person-action:confirmation:confirm' } });
  f.ledger.ingest({ eventId: 'e4', sourceRef: 'e4', kind: 'request', payload: { reason: 'not a person-action:confirmation:confirm' } });
  assert.equal(f.wake.due(), true);
  await f.run(10 * MIN);
  assert.deepEqual(f.sent, []); assert.equal(f.held()?.reason, 'quiet-window');
});

test('an act that is no answer on the butler\'s card passes no other gate', async t => {
  const child = { event: 'SubagentStart', id: 'child', stale: false, time: START };
  for (const [name, set, reason] of [
    ['automatic messages off', f => { f.client.state.wakePolicy = { enabled: false }; }, 'automatic-messages-off'],
    ['the butler paused by the person', f => { f.butler.wakeDisabled = true; }, 'paused'],
    ['the person just used it', f => f.dispatcher.noteHuman('butler'), 'person-recent'],
    ['the person is typing in it', f => { f.butler.liveDraft = 'SYNTHETIC PRIVATE DRAFT'; f.dispatcher.noteHuman('butler', 'draft'); }, 'person-recent'],
    ['at work', f => { f.butler.state = 'working'; f.butler.backgroundStale = true; }, 'not-idle'],
    ['a background command', f => { f.butler.background = 1; }, 'background-work'],
    ['an unconfirmed background report', f => { f.butler.backgroundStale = true; }, 'background-unconfirmed'],
    ['a permission waiting', f => { f.butler.approval = { id: 'a' }; }, 'busy'],
    ['a child agent running', f => { f.butler.fleet = [child]; }, 'team-running'],
    ['a DeepSeek model', f => { f.butler.model = 'deepseek-flash'; }, 'model-excluded'],
    ['an unknown model', f => { f.butler.model = null; }, 'model-unknown'],
    ['a space it joined', f => { f.butler.roomIds = ['shared']; f.butler.roomId = 'shared'; }, 'in-space'],
    ['another native session', f => { f.butler.nativeId = 'native-other'; }, 'identity-unavailable'],
    ['a backend being replaced', f => { f.client.operationGuard = () => () => { throw Object.assign(Error('SYNTHETIC maintenance'), { notSent: true }); }; }, 'send-not-sent'],
  ]) {
    const f = fixture(t);
    f.act(); set(f);
    await f.run(MIN, { hurry: true });
    assert.deepEqual(f.sent, [], name); assert.equal(f.held()?.reason, reason, name);
  }
  const off = fixture(t);
  off.wake.set(false); off.act(); await off.run(5 * MIN);
  assert.deepEqual(off.sent, [], 'event wake off');
});

test('the two minutes after the person used the butler still hold such an act, then it goes out inside the window', async t => {
  const f = fixture(t);
  f.dispatcher.noteHuman('butler'); const used = f.clock.now;
  f.act(); await f.dispatcher.schedule();
  assert.equal(f.held()?.reason, 'person-recent', 'said at once');
  await f.run(5 * MIN);
  assert.equal(f.sent.length, 1);
  assert.ok(f.sent[0].at - used >= 2 * MIN && f.sent[0].at - used <= 2 * MIN + 35000, `${f.sent[0].at - used} ms`);
});

test('the butler\'s own last activity is its quiet there: a turn that just ended waits eight seconds', async t => {
  const f = fixture(t);
  f.butler.lastActivityAt = f.clock.now; f.click(); const at = f.clock.now;
  await f.run(5000, { hurry: true });
  assert.deepEqual(f.sent, []); assert.equal(f.held()?.reason, 'not-settled', 'the window is not what holds it');
  await f.run(30000, { hurry: true });
  assert.equal(f.sent.length, 1); assert.ok(f.sent[0].at - at >= 8000);
  // Nothing known of its activity: held, as it would be without this.
  const unknown = fixture(t, { butler: { lastActivityAt: undefined, createdAt: undefined } });
  unknown.click(); await unknown.run(MIN, { hurry: true });
  assert.deepEqual(unknown.sent, []);
});

test('a patrol, a queue item and another session\'s window are as before', async t => {
  const pm = session('pm', { roomIds: ['shared'], roomId: 'shared' });
  const f = fixture(t, { others: [pm] });
  f.room.queueAdd('Synthetic task', 'pm'); f.wake.setPatrol(15);
  f.click(); await f.run(MIN);
  assert.deepEqual(f.sent.map(s => s.id), ['butler'], 'the member in the window gets no item');
  Object.assign(f.butler, { state: 'idle', lastActivityAt: f.clock.now });
  await f.run(40 * MIN);
  assert.equal(f.sent.length, 1, 'no patrol inside the window');
  const elsewhere = fixture(t, { windows: [quietWindow(['pm'], { scope: `backend:${OTHER}` })] });
  elsewhere.event(); await elsewhere.run(MIN);
  assert.equal(elsewhere.sent.length, 1, 'a window elsewhere never held the butler');
});

test('a wake that did not arrive keeps such an act owed, tried again a minute later', async t => {
  const f = fixture(t), dispatch = f.client.call;
  let fail = true;
  f.client.call = async (method, ...args) => { if (method === 'dispatch' && fail) throw Object.assign(Error('SYNTHETIC not sent'), { notSent: true }); return dispatch(method, ...args); };
  f.act(); await f.run(30000, { hurry: true });
  assert.deepEqual(f.sent, []); assert.equal(f.held()?.reason, 'cooldown'); assert.equal(f.wake.due(), true);
  fail = false; await f.run(MIN, { hurry: true });
  assert.equal(f.sent.length, 1);
});

test('the click is found behind a long backlog, and an event record that cannot be read passes nothing', async t => {
  const f = fixture(t);
  for (let n = 1; n <= 250; n++) f.event(n);
  assert.equal(f.wake.personActed(), false);
  f.click(); assert.equal(f.wake.personActed(), true);
  f.ledger.eventsAfter = () => { throw Error('SYNTHETIC PRIVATE LEDGER ERROR'); };
  assert.equal(f.wake.personActed(), false);
  await f.run(MIN, { hurry: true });
  assert.deepEqual(f.sent, []); assert.equal(f.held()?.reason, 'quiet-window');
});

test('an answer on a queue item, a grant and a native answer are the person\'s acts too', async t => {
  for (const [name, args, result] of [['spaceAction', ['space-1', 'queueResolve', ['item-1', 'SYNTHETIC PRIVATE ANSWER']]], ['operatorAction', ['member', 'grant', {}], 'synthetic-domain'], ['answer', ['member', 'question-1']]]) {
    const f = fixture(t);
    f.actions.call(name, args, result); await f.run(MIN);
    assert.equal(f.sent.length, 1, name);
  }
});

test('a window that opens between the pass and the send still holds an ordinary wake and a queue item', async t => {
  const opens = f => {
    const refresh = f.client.refresh;
    f.client.refresh = async () => { f.quiet.windows = [quietWindow(['butler', 'pm'])]; return refresh(); };
  };
  const f = fixture(t, { windows: [] });
  f.event(); await f.run(6000, { hurry: true }); opens(f); await f.run(MIN, { hurry: true });
  assert.deepEqual(f.sent, []); assert.equal(f.held()?.reason, 'quiet-window');
  const q = fixture(t, { windows: [], others: [session('pm', { roomIds: ['shared'], roomId: 'shared' })] });
  q.room.queueAdd('Synthetic task', 'pm'); await q.run(6000, { hurry: true }); opens(q); await q.run(MIN, { hurry: true });
  assert.deepEqual(q.sent, []);
});

test('at work with a click waiting, what will still hold it after the turn is said, not the window', async t => {
  for (const [extra, reason] of [[{}, 'not-idle'], [{ liveDraft: 'SYNTHETIC PRIVATE DRAFT' }, 'not-idle'],
    [{ liveDraft: 'SYNTHETIC PRIVATE DRAFT', serviceCapabilities: ['queueDispatchV1'] }, 'person-typing']]) {
    const f = fixture(t, { butler: { state: 'working', backgroundStale: true, pendingTag: 'tag-of-this-turn', ...extra } });
    f.click(); await f.dispatcher.schedule();
    assert.equal(f.held()?.reason, reason); assert.deepEqual(f.sent, []);
  }
});

test('the butler gone by the read right before the send is said as missing', async t => {
  const f = fixture(t), refresh = f.client.refresh;
  f.click(); f.client.refresh = async () => { f.client.state.sessions = []; return refresh(); };
  await f.dispatcher.schedule();
  assert.deepEqual(f.sent, []); assert.equal(f.held()?.reason, 'missing');
});

test('outside a window such an act waits for the same idle clock as any event', async t => {
  const f = fixture(t, { windows: [] });
  f.act(); const at = f.clock.now;
  await f.dispatcher.schedule();
  assert.deepEqual(f.sent, []); assert.equal(f.held()?.reason, 'not-settled');
  await f.run(MIN);
  assert.equal(f.sent.length, 1); assert.ok(f.sent[0].at - at >= 8000);
});

test('the wake inside a window makes the move wait for its quiet again, without moving the deadline', async t => {
  const f = fixture(t), backend = [f.butler], before = f.quiet.windowOf('butler', f.clock.now).deadline;
  Object.assign(f.butler, { lastActivityAt: START - 20 * MIN, terminalInputPending: true });
  const ready = now => rules.migrationReady(structuredClone(backend[0]), f.dispatcher.humanAt, now);
  assert.equal(ready(f.clock.now), true, 'it could have moved');
  f.click(); await f.run(MIN);
  assert.equal(f.sent.length, 1);
  Object.assign(f.butler, { state: 'idle' });
  assert.equal(ready(f.clock.now), false);
  assert.equal(ready(f.sent[0].at + rules.MIGRATE_QUIET_MS), true);
  assert.equal(f.quiet.windowOf('butler', f.clock.now).deadline, before);
});

test('an event that waits for the window to end asks the backends for nothing meanwhile', async t => {
  const f = fixture(t), refresh = f.client.refresh; let reads = 0;
  f.client.refresh = async () => { reads += 1; return refresh(); };
  f.event(); await f.run(20 * MIN, { hurry: true });
  assert.deepEqual(f.sent, []); assert.equal(f.held()?.reason, 'quiet-window'); assert.equal(reads, 0);
  f.clock.now = START + HOUR; await f.run(MIN);
  assert.equal(f.sent.length, 1);
});

test('a click right after the butler\'s turn ended in the window waits its eight seconds, whether a pass saw that turn or not', async t => {
  for (const seen of [true, false]) {
    const f = fixture(t);
    await f.run(MIN, { hurry: true });
    if (seen) { f.butler.state = 'working'; await f.run(MIN, { hurry: true }); f.butler.state = 'idle'; }
    f.butler.lastActivityAt = f.clock.now; f.click(); const at = f.clock.now;
    await f.run(6000, { hurry: true });
    assert.deepEqual(f.sent, [], `seen ${seen}`); assert.equal(f.held()?.reason, 'not-settled');
    await f.run(30000, { hurry: true });
    assert.equal(f.sent.length, 1); assert.ok(f.sent[0].at - at >= 8000 && f.sent[0].at - at <= 12000, `${f.sent[0].at - at} ms`);
  }
});
