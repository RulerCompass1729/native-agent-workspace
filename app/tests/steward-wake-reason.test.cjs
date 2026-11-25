'use strict';
// R198 (the person, 2026-11-24: 「"NAW 从 19:28 PT 起判不准我有没有后台任务" 这个很奇怪」): the butler reads its wake state
// in its own turn, where Claude's background report is stale (workspace.cjs 'working'), so every read said
// background-unconfirmed over the migration quiet window that really held it, and nothing told it which backend, until
// when, or what waited behind it. Synthetic sessions; no model, no daily data.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { RoomState } = require('../room-state.cjs');
const rules = require('../queue-dispatch.cjs'), { QueueDispatcher, CAPABILITY } = rules;
const { ButlerLedger } = require('../butler-ledger.cjs');
const { StewardWake } = require('../steward-wake.cjs');
const { QuietWindows } = require('../quiet-windows.cjs');
const { uiError } = require('../ui-errors.cjs'), locale = require('../ui-locale.js');
const root = path.resolve(__dirname, '..', '..');

const MIN = 60000, START = 1_800_000_000_000, HOUR = 60 * MIN;
const KEY = 'backends/bbbbbbbbbbbbbbbbbbbb', OTHER = 'backends/cccccccccccccccccccc';
const BUTLER = { sessionId: 'butler', nativeId: 'native-butler' };
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-wake-reason-')); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const window = (key, sessions, extra = {}) => ({ id: '00000000-0000-4000-8000-000000000001', scope: `backend:${key}`, reason: 'migration', openedBy: 'naw',
  openedAt: START, deadline: START + HOUR, waited: 'busy', sessions, ...extra });
function openWindows(dir, clock, windows) {
  fs.writeFileSync(path.join(dir, 'quiet-windows.json'), JSON.stringify({ format: 1, windows, history: [] }), { mode: 0o600 });
  return new QuietWindows(dir, { now: () => clock.now, moveWait: rules.moveWait });
}
const session = (id, extra = {}) => ({ id, name: `Synthetic ${id}`, provider: 'claude', nativeId: `native-${id}`, model: 'synthetic-model', state: 'idle', roomIds: [], roomId: null,
  createdAt: START - HOUR, background: 0, scheduled: 0, backgroundStale: false, chatAvailable: true, liveDraft: '', serviceCapabilities: [CAPABILITY], fleet: [], messages: [], ...extra });

// The real dispatcher and wake over one synthetic backend; `windows` are quiet windows as the record holds them.
function fixture(t, sessions, windows = []) {
  const dir = directory(t), clock = { now: START + MIN }, lines = [], sent = [], room = new RoomState(dir), ledger = new ButlerLedger(dir, { now: () => clock.now });
  const client = Object.assign(new EventEmitter(), { state: { sessions, rooms: [{ id: 'shared', revision: 0, run: null, messages: [] }], wakePolicy: { enabled: true }, capabilities: [CAPABILITY] },
    close() {}, snapshot: () => structuredClone(client.state), refresh: async () => client.snapshot(), route: () => ({ client, state: { capabilities: [CAPABILITY] } }),
    call: async (method, ...args) => { if (method === 'dispatch') { sent.push(args[0]); return `tag-${sent.length}`; } return method === 'initial' ? client.snapshot() : undefined; } });
  const wake = new StewardWake(dir, { ledger: () => ledger, selected: () => BUTLER, now: () => clock.now, record: line => lines.push(line) });
  const quiet = openWindows(dir, clock, windows);
  const dispatcher = new QueueDispatcher({ roomState: room, dataDir: dir, connect: async () => client, now: () => clock.now, settleMs: 8000, tickMs: 3600000,
    steward: () => ({ ...BUTLER, duty: '' }), stewardWake: wake, quietWindows: quiet, transcriptRoot: path.join(dir, 'none'),
    sampleProcesses: async () => '', samplePressure: async () => '' });
  t.after(() => dispatcher.close());
  wake.set(true);
  ledger.ingest({ eventId: 'butler-source:1', sourceRef: 'queue-outcome:space-1:1', kind: 'failure', payload: { spaceId: 'space-1', itemId: 'item-1', reason: 'Synthetic failure' } });
  const f = { dir, clock, lines, sent, room, client, wake, quiet, dispatcher, session: sessions[0] };
  f.read = async () => { dispatcher.dirty = true; await dispatcher.schedule(); return wake.view({ held: true }).blocked; };
  return f;
}
// Claude at work, as workspace.cjs leaves it: the last turn's background report is stale.
const atWork = (extra = {}) => session('butler', { state: 'working', backgroundStale: true, ...extra });

test('at work in a quiet window the butler reads quiet-window with its deadline, not background-unconfirmed', async t => {
  for (const extra of [{}, { pendingTag: 'tag-of-this-turn' }, { background: 1 }, { scheduled: 2 }, { pendingTag: 'x', background: null }, { state: 'approval', pendingTag: 'x' }]) {
    const f = fixture(t, [atWork(extra)], [window(KEY, ['butler', 'pm'])]);
    const blocked = await f.read();
    assert.deepEqual([blocked?.reason, blocked?.deadline], ['quiet-window', START + HOUR], JSON.stringify(extra));
    assert.deepEqual(f.sent, []);
  }
});

test('at work with nothing else holding it the butler reads not-idle; a stale background count is not a reason', async t => {
  for (const extra of [{}, { background: 1 }, { scheduled: 1 }, { pendingTag: 'tag-of-this-turn', background: 3 }, { state: 'approval' }]) {
    const blocked = await fixture(t, [atWork(extra)]).read();
    assert.equal(blocked?.reason, 'not-idle', JSON.stringify(extra));
    assert.equal(Object.hasOwn(blocked, 'deadline'), false);
  }
});

test('a turn with another busy flag, or a session not in a turn, reads as it did before', async t => {
  for (const [extra, reason] of [
    [{ state: 'approval', approval: { id: 'a' } }, 'not-idle'],
    [{ claudeQuestion: { id: 'q' } }, 'not-idle'],
    [{ nativeInputRequired: true, pendingTag: 'x' }, 'not-idle'],
    [{ pendingQueue: 'p' }, 'not-idle'],
    [{ interruptPending: true }, 'not-idle'],
    [{ nativeContextPending: 'compact' }, 'not-idle'],
    [{ state: 'recoverable' }, 'background-unconfirmed'],
    [{ state: 'recoverable', pendingTag: 'x' }, 'not-idle'],
  ]) assert.equal((await fixture(t, [atWork(extra)], [window(KEY, ['butler'])]).read())?.reason, reason, JSON.stringify(extra));
});

test('what really holds it after the turn is still said at work, in the same order as before', async t => {
  for (const [extra, reason] of [
    [{ liveDraft: 'SYNTHETIC PRIVATE DRAFT' }, 'person-typing'],
    [{ liveDraft: 'SYNTHETIC PRIVATE DRAFT', pendingTag: 'tag-of-this-turn' }, 'person-typing'],
    [{ fleet: [{ event: 'SubagentStart', id: 'child', stale: false, time: START }] }, 'team-running'],
    [{ backgroundStale: false, background: 1 }, 'background-work'],
    [{ backgroundStale: false, scheduled: 1 }, 'background-work'],
    [{ transportDisconnected: true }, 'unavailable'],
    [{ wakeDisabled: true }, 'paused'],
  ]) assert.equal((await fixture(t, [atWork(extra)], [window(KEY, ['butler'])]).read())?.reason, reason, JSON.stringify(extra));
});

test('idle, an unconfirmed background report still holds it, quiet window or not', async t => {
  for (const windows of [[], [window(KEY, ['butler'])]]) {
    const f = fixture(t, [session('butler', { backgroundStale: true })], windows);
    f.dispatcher.idleSince.set('butler', START - HOUR);
    assert.equal((await f.read())?.reason, 'background-unconfirmed');
    Object.assign(f.session, { backgroundStale: false, background: 1 });
    assert.equal((await f.read())?.reason, 'background-work');
    assert.deepEqual(f.sent, []);
  }
});

test('the deadline is its own backend\'s window, not another\'s', async t => {
  const f = fixture(t, [atWork()], [window(OTHER, ['w1'], { id: '00000000-0000-4000-8000-000000000002', deadline: START + 2 * HOUR }), window(KEY, ['butler'])]);
  assert.equal((await f.read())?.deadline, START + HOUR);
  const elsewhere = fixture(t, [atWork()], [window(OTHER, ['w1'])]);
  assert.equal((await elsewhere.read())?.reason, 'not-idle', 'another backend\'s window does not hold it');
});

test('idle in a quiet window it is held with the deadline; past the deadline the wake goes out', async t => {
  const f = fixture(t, [session('butler')], [window(KEY, ['butler'])]);
  assert.deepEqual([(await f.read())?.reason, f.wake.view({ held: true }).blocked.deadline], ['quiet-window', START + HOUR]);
  f.clock.now = START + HOUR; await f.read(); f.clock.now += 9000; await f.read();
  assert.deepEqual(f.sent, ['butler']);
  assert.equal(f.wake.view({ held: true }).blocked, undefined);
});

function wakeOnly(t) {
  const dir = directory(t), clock = { now: START }, lines = [], ledger = new ButlerLedger(dir, { now: () => clock.now });
  let changes = 0;
  const wake = new StewardWake(dir, { ledger: () => ledger, selected: () => BUTLER, now: () => clock.now, record: line => lines.push(line), changed: () => { changes++; } });
  wake.set(true);
  ledger.ingest({ eventId: 'butler-source:1', sourceRef: 'queue-outcome:space-1:1', kind: 'failure', payload: { spaceId: 'space-1', itemId: 'item-1', reason: 'Synthetic failure' } });
  return { wake, clock, lines, changes: () => changes, held: () => wake.view({ held: true }).blocked };
}

test('since and minutes are the current reason\'s and restart when it changes; the whole wait is kept beside them', t => {
  const f = wakeOnly(t);
  f.wake.skip('not-idle'); f.clock.now += 4 * MIN; f.wake.skip('not-idle');
  assert.deepEqual(f.held(), { since: START, reason: 'not-idle', minutes: 4 }, 'one reason: no second clock');
  f.wake.skip('quiet-window', START + HOUR); f.clock.now += 3 * MIN; f.wake.skip('quiet-window', START + HOUR);
  assert.deepEqual(f.held(), { since: START + 4 * MIN, reason: 'quiet-window', minutes: 3, waitingSince: START, waitingMinutes: 7, deadline: START + HOUR });
  f.clock.now += MIN; f.wake.skip('not-idle');
  assert.deepEqual(f.held(), { since: START + 8 * MIN, reason: 'not-idle', minutes: 0, waitingSince: START, waitingMinutes: 8 }, 'back to the first reason: from now, and no deadline');
  f.wake.clearBlocked(); f.clock.now += MIN; f.wake.skip('not-idle');
  assert.deepEqual(f.held(), { since: START + 9 * MIN, reason: 'not-idle', minutes: 0 });
});

test('the person is still told after ten minutes of the whole wait, however often the reason changes', t => {
  const f = wakeOnly(t);
  for (let minute = 0; minute <= 9; minute++) { f.wake.skip(minute % 2 ? 'not-idle' : 'background-work'); f.clock.now += MIN; }
  assert.equal(f.wake.view().blocked, undefined); assert.deepEqual(f.lines, []);
  f.wake.skip('quiet-window', START + HOUR);
  assert.deepEqual(f.wake.view().blocked, { since: START + 10 * MIN, reason: 'quiet-window', minutes: 0, waitingSince: START, waitingMinutes: 10, deadline: START + HOUR });
  // The record's line says how long the butler was not woken (stewardWake.stalled): the whole wait.
  assert.deepEqual(f.lines, [{ kind: 'wakeBlocked', reason: 'quiet-window', since: START }]);
  // Its count is refreshed as the whole wait passes a minute, not the reason's.
  f.clock.now += MIN / 2; f.wake.skip('not-idle'); const before = f.changes();
  f.clock.now += MIN / 2; f.wake.skip('not-idle');
  assert.equal(f.changes(), before + 1);
});

test('a record line that cannot be written does not restart the reason it stood for', t => {
  const f = wakeOnly(t);
  f.wake.record = () => { throw Error('SYNTHETIC PRIVATE RECORD ERROR'); };
  f.wake.skip('not-idle'); f.clock.now += 10 * MIN; f.wake.skip('not-idle');
  assert.deepEqual([f.held().reason, f.held().since, f.held().minutes], ['record-unavailable', START, 10]);
  f.clock.now += MIN; f.wake.skip('not-idle');
  assert.deepEqual(f.held(), { since: START, reason: 'not-idle', minutes: 11 });
  const q = wakeOnly(t); q.wake.record = f.wake.record;
  q.wake.skip('quiet-window', START + HOUR); q.clock.now += 10 * MIN; q.wake.skip('quiet-window', START + HOUR);
  assert.deepEqual(q.held(), { since: START, reason: 'record-unavailable', minutes: 10 }, 'a deadline only beside its own reason');
});

test('the butler\'s own unresolved handoff starts its own clock and drops an earlier deadline', t => {
  const f = wakeOnly(t);
  f.wake.skip('quiet-window', START + HOUR); f.clock.now += 5 * MIN; f.wake.hold('rotation-control-unresolved', 'release');
  assert.deepEqual(f.held(), { since: START + 5 * MIN, reason: 'rotation-control-unresolved', minutes: 0, waitingSince: START, waitingMinutes: 5, step: 'release' });
  f.clock.now += 2 * MIN; f.wake.hold('rotation-control-unresolved', 'update-backend');
  assert.deepEqual(f.held(), { since: START + 5 * MIN, reason: 'rotation-control-unresolved', minutes: 2, waitingSince: START, waitingMinutes: 7, step: 'update-backend' });
});

test('a deadline is kept only for a quiet window and only as a time; a clock set back starts over', t => {
  const f = wakeOnly(t);
  for (const [reason, deadline] of [['not-idle', START + HOUR], ['quiet-window', undefined], ['quiet-window', 'soon'], ['quiet-window', NaN], ['made-up', START + HOUR]]) {
    f.wake.clearBlocked(); f.wake.skip(reason, deadline);
    assert.equal(Object.hasOwn(f.held(), 'deadline'), false, `${reason} ${String(deadline)}`);
  }
  f.wake.clearBlocked(); f.wake.skip('not-idle'); f.clock.now += 5 * MIN; f.wake.skip('quiet-window', START + HOUR);
  f.clock.now -= 2 * MIN; f.wake.skip('quiet-window', START + HOUR);
  assert.deepEqual([f.held().since, f.held().minutes], [START + 3 * MIN, 0]);
});

test('the open windows say which backend, until when and how many queued items wait behind each', t => {
  const dir = directory(t), clock = { now: START + MIN };
  const quiet = openWindows(dir, clock, [window(KEY, ['butler', 'pm']), window(OTHER, ['w1'], { id: '00000000-0000-4000-8000-000000000002', openedAt: START + 1, deadline: START + 2 * HOUR })]);
  const item = (id, extra = {}) => ({ id, status: 'queued', assignee: null, ...extra });
  const rooms = [
    { id: 'shared', queue: [item('a', { assignee: 'pm' }), item('b', { assignee: 'pm' }), item('c'), item('d'), item('e', { status: 'sent', assignee: 'pm' }), item('f', { assignee: 'out' }), item('no-pass', { assignee: 'pm' }), item('nobody'), item('left', { assignee: 'pm' })] },
    { id: 'space-2', queue: [item('g', { assignee: 'w1' }), item('h')] },
    { id: 'old', archived: true, queue: [item('i', { assignee: 'pm' })] },
    { id: 'empty' }, null,
  ];
  const waits = new Map([
    ['a', [{ sessionId: 'pm', reason: 'quiet-window' }]],
    ['b', [{ sessionId: 'pm', reason: 'not-idle' }]],                                          // Its only member is in the window: held after its turn too.
    ['c', [{ sessionId: 'pm', reason: 'quiet-window' }, { sessionId: 'out', reason: 'not-idle' }]], // Only the window keeps it from one member.
    ['d', [{ sessionId: 'pm', reason: 'not-idle' }, { sessionId: 'out', reason: 'not-idle' }]],     // Another member may take it.
    ['e', [{ sessionId: 'pm', reason: 'quiet-window' }]], ['f', [{ sessionId: 'out', reason: 'not-idle' }]],
    ['g', [{ sessionId: 'w1', reason: 'previous-item', readiness: 'quiet-window' }]],
    ['h', [{ reason: 'no-members' }]], ['left', [{ sessionId: 'pm', reason: 'not-member' }]],
  ]);
  assert.deepEqual(quiet.holding(rooms, waits), [
    { backend: KEY, openedAt: START, deadline: START + HOUR, sessions: ['butler', 'pm'], queued: 4 },
    { backend: OTHER, openedAt: START + 1, deadline: START + 2 * HOUR, sessions: ['w1'], queued: 1 },
  ]);
  clock.now = START + HOUR;
  assert.deepEqual(quiet.holding(rooms, waits).map(w => w.backend), [OTHER], 'a window past its deadline holds nothing');
  quiet.holding(rooms, waits)[0].sessions.push('x');
  assert.deepEqual(quiet.windows.find(w => w.scope === `backend:${OTHER}`).sessions, ['w1'], 'a copy');
  assert.deepEqual(quiet.holding(undefined, undefined).map(w => w.queued), [0]);
});

test('the count is the dispatcher\'s own last pass: two items for a member in the window, none once it closes', async t => {
  const pm = session('pm', { roomIds: ['shared'], roomId: 'shared' });
  const f = fixture(t, [atWork(), pm], [window(KEY, ['butler', 'pm'])]);
  f.room.queueAdd('Synthetic first', 'pm'); f.room.queueAdd('Synthetic second', 'pm');
  const now = () => f.quiet.holding([f.room.value, ...f.room.spaces.rooms], f.room.queueWaits);
  await f.read();
  assert.deepEqual(now(), [{ backend: KEY, openedAt: START, deadline: START + HOUR, sessions: ['butler', 'pm'], queued: 2 }]);
  assert.deepEqual(f.sent, [], 'nothing sent inside it');
  f.clock.now = START + HOUR; await f.read();
  assert.deepEqual(now(), []);
});

// main.cjs stewardWake, the real handler.
function handler({ quietWindows = null, wake }) {
  const source = fs.readFileSync(path.join(root, 'app/main.cjs'), 'utf8');
  const start = source.indexOf("  register('stewardWake', async (c, on) => {"), end = source.indexOf("  // B6: the person's own actions on an integration handoff", start);
  assert.ok(start > 0 && end > start);
  let registered;
  vm.runInContext(source.slice(start, end), vm.createContext({ register: (_name, fn) => { registered = fn; }, stewardCaller: async c => c.background ? { id: 'butler' } : null,
    isCurrentHumanContext: c => !c.background, stewardWake: wake, stewardRecord: null, uiError, quietWindows, roomState: { value: { id: 'shared', queue: [] }, spaces: { rooms: [{ id: 's2' }] }, queueWaits: new Map([['a', []]]) } }));
  const plain = async value => JSON.parse(JSON.stringify(await value));
  return { agent: (...args) => plain(registered({ background: true }, ...args)), person: (...args) => plain(registered({ background: false }, ...args)) };
}

test('only the butler\'s own read lists the open windows; a list that cannot be read is null, not empty', async () => {
  const wake = { view: () => ({ on: true }), set: on => ({ on }) }, seen = [];
  const quietWindows = { holding: (rooms, waits) => { seen.push([rooms.map(r => r.id), [...waits.keys()]]); return [{ backend: KEY, queued: 2 }]; } };
  assert.deepEqual(await handler({ quietWindows, wake }).agent(), { on: true, quietWindows: [{ backend: KEY, queued: 2 }] });
  assert.deepEqual(JSON.parse(JSON.stringify(seen)), [[['shared', 's2'], ['a']]]);
  assert.deepEqual(await handler({ quietWindows, wake }).person(), { on: true });
  assert.deepEqual(await handler({ quietWindows, wake }).agent(true), { on: true });
  assert.equal(seen.length, 1);
  assert.deepEqual(await handler({ quietWindows: null, wake }).agent(), { on: true, quietWindows: null });
  assert.deepEqual(await handler({ quietWindows: { holding() { throw Error('SYNTHETIC PRIVATE ERROR'); } }, wake }).agent(), { on: true, quietWindows: null });
});

test('the catalog tells the butler what its read says', () => {
  const { BackgroundControl } = require('../background-control.cjs');
  const entry = new BackgroundControl({ dataDir: os.tmpdir(), handlers: new Map([['stewardWake', () => null]]) }).catalog().find(item => item.method === 'stewardWake');
  for (const word of ['blocked', 'waitingMinutes', 'waitingSince', 'quietWindows', 'openedAt', 'deadline', 'queued', 'last dispatch pass', 'milliseconds', 'the person\'s own act']) assert.ok(entry.parameters[0].includes(word), word);
});

test('the person\'s banner counts the whole wait, not the current reason\'s minutes', () => {
  const source = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
  const at = source.indexOf('function renderStewardWakeWarning('), code = source.slice(at, source.indexOf('\n}\n', at) + 2);
  for (const language of ['zh', 'en']) for (const [block, minutes] of [[{ minutes: 3, waitingMinutes: 41 }, 41], [{ minutes: 12 }, 12], [{ minutes: 0, waitingMinutes: 10 }, 10]]) {
    const p = { textContent: '' }, button = {}, step = {}, summary = { setAttribute(k, v) { this[k] = v; } };
    const text = { textContent: '', setAttribute() {}, removeAttribute() {} };
    const parts = { p, summary, '.wake-chip-text': text, '.steward-wake-step': step, '.steward-wake-record': button }, box = { dataset: {}, querySelector: tag => parts[tag] };
    const say = (k, v) => locale.format(language, k, v);
    const context = vm.createContext({ state: {}, disconnected: false, $: () => box, uiText: say, stewardSteps: null, rotationReleaseAction: () => [], backendUpdateAction: () => [] });
    vm.runInContext(code, context);
    context.renderStewardWakeWarning({ since: START, reason: 'quiet-window', ...block });
    assert.equal(text.textContent, say('stewardWake.chip', { minutes }));
    assert.equal(summary['aria-label'], say('stewardWake.stalled', { minutes, reason: say('stewardWake.reason.quiet-window') }));
    context.renderStewardWakeWarning({ since: START, reason: 'rotation-control-unresolved', step: 'release', ...block });
    assert.equal(p.textContent, say('stewardWake.ownHandoffButton.release', { minutes }));
  }
});
