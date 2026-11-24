'use strict';
// The PM's 11-23 brief (approved by the butler): with migration on, an old backend whose sessions take turns being
// busy never stays quiet long enough to move. NAW opens a bounded quiet window there: no new item or NAW message,
// running turns end, the existing quiet rule is met and the move runs; at the deadline the window closes, work
// resumes and the timeout is told through the version-events exit. Synthetic backends; no model, no real move.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { RoomState } = require('../room-state.cjs');
const rules = require('../queue-dispatch.cjs'), { QueueDispatcher, CAPABILITY } = rules;
const backendSwitch = require('../backend-switch.cjs');
const { ButlerLedger } = require('../butler-ledger.cjs'), { ButlerIngress } = require('../butler-ingress.cjs');
const { StewardWake } = require('../steward-wake.cjs'), { PersonActions } = require('../person-actions.cjs');
const { VersionEvents } = require('../version-events.cjs');
const { continuationStatus } = require('../service-client.cjs'), { uiError } = require('../ui-errors.cjs'), locale = require('../ui-locale.js');
// Code before the window has no such module: what it does then is what is asserted.
let Q = null;
try { Q = require('../quiet-windows.cjs'); } catch { Q = null; }

const MIN = 60000, START = 1800000000000, KEY = 'backends/bbbbbbbbbbbbbbbbbbbb', OLD = '0.1.0-alpha.287', NEW = '0.1.0-alpha.288';
const CAPS = ['atomicShutdown', 'resume', 'conditionalMaintenanceStopV1'], SETTINGS = { auto: true, migrate: true };
const QUIET = { quietMs: rules.MIGRATE_QUIET_MS, unprovenQuietMs: rules.MIGRATE_UNPROVEN_QUIET_MS };
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-quiet-window-')); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// A queue member on the old backend that only a migration may move (what was typed in its terminal is not known).
function member(id, extra = {}) {
  return { id, name: `Synthetic ${id}`, provider: 'claude', nativeId: `native-${id}`, model: 'synthetic-model', state: 'idle', roomId: 'shared', roomIds: ['shared'],
    createdAt: START - 3600000, background: 0, scheduled: 0, backgroundStale: false, chatAvailable: true, liveDraft: '', controlRevision: 0,
    serviceCapabilities: [CAPABILITY], fleet: [], messages: [], terminalInputPending: true, lastActivityAt: START - 3600000, ...extra };
}
// As main.cjs connectionUpdateOptions builds it for this backend.
function option(sessions) {
  const plan = backendSwitch.backendPlan({ runtimeVersion: OLD, capabilities: CAPS, servicePid: 4200, sessions, room: { messages: [] } });
  return { backendKey: KEY, sessions: sessions.map(s => ({ id: s.id, name: s.name })),
    switch: plan && (plan.stops.length || plan.blocked || plan.ready) ? { ready: plan.ready, auto: plan.auto, blocked: plan.blocked, reason: plan.reason, stops: plan.stops } : null,
      moveRefused: plan && !plan.ready && !plan.blocked ? plan.reason || null : null };
}
const record = dir => JSON.parse(fs.readFileSync(path.join(dir, 'quiet-windows.json'), 'utf8'));

// Minute by minute: turns that are due end, the migration pass runs as main.cjs autoBackendSwitchOnce does (window,
// then the move NAW chooses), then the real dispatcher's pass sends queue items to whoever it finds ready.
async function simulate(t, { cordon, minutes = 60, turns = [1, 2, 3, 4], turnMinutes = 4, settings = SETTINGS, human = null, until = null, items = 80 } = {}) {
  const dir = directory(t), clock = { now: START }, room = new RoomState(dir), ends = new Map(), dispatched = [], humanAt = new Map(), failed = new Set();
  for (let i = 0; i < items; i++) room.queueAdd(`Synthetic task ${i}`, null);
  // Each member is part way through a turn; they end a minute apart.
  const sessions = turns.map((end, i) => { const id = 'abcd'[i]; ends.set(id, START + end * MIN); return member(id, { state: 'working', lastActivityAt: START }); });
  const client = new EventEmitter();
  client.state = { sessions, rooms: [{ id: 'shared', messages: [], run: null }], wakePolicy: { enabled: true }, capabilities: [CAPABILITY] };
  client.snapshot = () => structuredClone(client.state); client.refresh = async () => client.snapshot(); client.close = () => {};
  client.route = () => ({ client, state: { capabilities: [CAPABILITY] } });
  client.call = async (method, id, text, nativeId, itemId) => {
    if (method === 'initial') return client.snapshot();
    if (['pause', 'resumeRoom'].includes(method)) return undefined;
    assert.equal(method, 'dispatch');
    const s = sessions.find(x => x.id === id), tag = `tag-${dispatched.length + 1}`;
    dispatched.push({ id, itemId, at: clock.now });
    s.state = 'working'; s.lastActivityAt = clock.now; ends.set(id, clock.now + turnMinutes * MIN);
    s.messages.push({ id: tag, role: 'user', text, origin: 'naw-dispatch', dispatchItem: itemId, dispatchPurpose: { kind: 'queue', nativeId, itemId, epoch: null }, status: 'submitted', time: clock.now });
    return tag;
  };
  const quiet = cordon && Q ? new Q.QuietWindows(dir, { now: () => clock.now, moveWait: rules.moveWait }) : null;
  const d = new QueueDispatcher({ roomState: room, dataDir: dir, clients: () => client, now: () => clock.now, settleMs: 0, humanQuietMs: 0, broadcast: async () => {},
    sampleProcesses: async () => '', samplePressure: async () => '', ...(quiet ? { quietWindows: quiet } : {}) });
  t.after(() => d.close());
  const log = { opened: [], closed: [], movedAt: null, dispatched, quiet, room, sessions, clock };
  for (let m = 0; m <= minutes; m++) {
    for (const s of sessions) if (s.state === 'working' && clock.now >= ends.get(s.id)) {
      s.state = 'idle'; s.lastActivityAt = clock.now; s.messages.push({ id: `reply-${s.id}-${m}`, role: 'assistant', text: 'Done.', time: clock.now });
    }
    if (human && human.at === m) humanAt.set(human.id, clock.now);
    const options = [option(sessions)];
    if (quiet) {
      const { opened, closed } = quiet.pass({ options, settings, sessions, humanAt, failed, ...QUIET });
      log.opened.push(...opened.map(w => ({ ...w, minute: m }))); log.closed.push(...closed.map(w => ({ ...w, minute: m })));
    }
    if (log.movedAt === null && rules.nextBackendMove(options, settings, sessions, humanAt, clock.now, failed, QUIET.quietMs, QUIET.unprovenQuietMs)) {
      log.movedAt = m;
      if (quiet) log.closed.push({ ...quiet.moved(KEY, 'moved'), minute: m });
      if (until === 'moved') { d.dirty = true; await d.tick(); return log; }
    }
    d.dirty = true; await d.tick();
    clock.now += MIN;
  }
  return log;
}

test('without a window, four sessions taking turns being busy never let the backend move', async t => {
  const log = await simulate(t, { cordon: false, minutes: 60 });
  assert.equal(log.movedAt, null, 'no move in an hour');
  assert.ok(log.dispatched.length >= 40, `queue items kept going out: ${log.dispatched.length}`);
});

test('with a window, nothing new starts, the running turns end and the move runs 10 minutes after the last one', async t => {
  const log = await simulate(t, { cordon: true, minutes: 60, until: 'moved' });
  assert.equal(log.movedAt, 14, 'the last turn ended at minute 4; the existing 10-minute quiet rule is met at 14');
  assert.ok(Q, 'quiet-windows.cjs');
  const [opened] = log.opened;
  assert.equal(opened.minute, 0); assert.equal(opened.waited, 'busy'); assert.equal(opened.scope, `backend:${KEY}`);
  assert.equal(opened.deadline - opened.openedAt, Q.GRACE_MS + rules.MIGRATE_UNPROVEN_QUIET_MS, 'at work: 30 minutes plus the longer quiet rule');
  assert.deepEqual(opened.sessions, ['a', 'b', 'c', 'd']);
  // Queue items stayed queued through the window, then went out once it closed with the move.
  assert.deepEqual(log.dispatched.filter(x => x.at < START + 14 * MIN), [], 'no item sent inside the window');
  assert.deepEqual(log.closed.map(w => [w.code, w.minute]), [['moved', 14]]);
  assert.deepEqual(log.dispatched.map(x => x.id).sort(), ['a', 'b', 'c', 'd'], 'dispatched after it closed');
  assert.deepEqual(record(log.quiet.directory).windows, []);
});

test('the person at a session in the window still makes the move wait for its quiet rule', async t => {
  const log = await simulate(t, { cordon: true, minutes: 60, human: { at: 10, id: 'd' }, until: 'moved' });
  assert.equal(log.movedAt, 20, 'quiet 10 minutes after the person, not after the turn');
  assert.deepEqual(log.dispatched.filter(x => x.at < START + 20 * MIN), []);
});

test('at the deadline the window closes, work resumes, and none opens again for that backend for two hours', async t => {
  // One turn never ends within the window.
  const log = await simulate(t, { cordon: true, minutes: 66, turns: [1, 2, 3, 200], turnMinutes: 4 });
  assert.ok(Q, 'quiet-windows.cjs');
  assert.deepEqual(log.closed.map(w => [w.code, w.minute]), [['timeout', 60]]);
  assert.deepEqual(log.dispatched.filter(x => x.at < START + 60 * MIN), [], 'nothing new inside the window');
  assert.deepEqual(log.dispatched.filter(x => x.at === START + 60 * MIN).map(x => x.id).sort(), ['a', 'b', 'c'], 'items go out again at the deadline');
  assert.deepEqual(log.opened.map(w => w.minute), [0]);
  assert.equal(log.movedAt, null);
  // Still waiting only for its sessions: NAW opens the next window two hours after the timeout, not before.
  const { quiet, sessions, clock } = log, input = () => ({ options: [option(sessions)], settings: SETTINGS, sessions, humanAt: new Map(), failed: new Set(), ...QUIET });
  clock.now = START + (60 + 119) * MIN;
  assert.deepEqual(quiet.pass(input()).opened, []);
  assert.equal(new Q.QuietWindows(quiet.directory, { now: () => clock.now, moveWait: rules.moveWait }).pass(input()).opened.length, 0, 'the pause survives a restart');
  clock.now = START + 180 * MIN;
  assert.equal(quiet.pass(input()).opened.length, 1);
});

test('migration off: no window opens, and an open one closes', async t => {
  const log = await simulate(t, { cordon: true, minutes: 20, settings: { auto: true, migrate: false } });
  assert.deepEqual(log.opened, []); assert.ok(log.dispatched.length > 0);
  assert.ok(Q, 'quiet-windows.cjs');
  const dir = directory(t), clock = { now: START }, windows = new Q.QuietWindows(dir, { now: () => clock.now, moveWait: rules.moveWait });
  const sessions = [member('a', { state: 'working' }), member('b')], input = { options: [option(sessions)], sessions, humanAt: new Map(), failed: new Set(), ...QUIET };
  assert.equal(windows.pass({ ...input, settings: SETTINGS }).opened.length, 1);
  clock.now += MIN;
  assert.deepEqual(windows.pass({ ...input, settings: { auto: true, migrate: false } }).closed.map(w => w.code), ['migrate-off']);
  assert.deepEqual(windows.sessionIds(clock.now), new Map());
  // Off is not a timeout: once it is on again, NAW may open one.
  clock.now += MIN;
  assert.equal(windows.pass({ ...input, settings: SETTINGS }).opened.length, 1);
});

test('a backend that stops waiting only for its sessions closes the window, with the same two-hour pause', async t => {
  assert.ok(Q, 'quiet-windows.cjs');
  const dir = directory(t), clock = { now: START }, windows = new Q.QuietWindows(dir, { now: () => clock.now, moveWait: rules.moveWait });
  const sessions = [member('a', { state: 'working' }), member('b')], input = () => ({ options: [option(sessions)], settings: SETTINGS, sessions, humanAt: new Map(), failed: new Set(), ...QUIET });
  assert.equal(windows.pass(input()).opened.length, 1);
  sessions[1].state = 'disconnected'; clock.now += MIN;
  assert.deepEqual(windows.pass(input()).closed.map(w => w.code), ['not-waiting'], 'a broken session needs the person: not a wait for quiet');
  sessions[1].state = 'idle'; clock.now += 119 * MIN;
  assert.equal(windows.pass(input()).opened.length, 0, 'no reopen within two hours');
  clock.now += MIN;
  assert.equal(windows.pass(input()).opened.length, 1);
  // A failed move is not retried in this app run: no window for it either.
  const other = new Q.QuietWindows(directory(t), { now: () => clock.now, moveWait: rules.moveWait });
  assert.equal(other.pass({ ...input(), failed: new Set([KEY]) }).opened.length, 0);
});

test('a restart voids a window past its deadline; a record that is a link, others\' to read, or too large is no record', async t => {
  assert.ok(Q, 'quiet-windows.cjs');
  const dir = directory(t), clock = { now: START };
  const one = new Q.QuietWindows(dir, { now: () => clock.now, moveWait: rules.moveWait }), sessions = [member('a', { state: 'working' })];
  const [window] = one.pass({ options: [option(sessions)], settings: SETTINGS, sessions, humanAt: new Map(), failed: new Set(), ...QUIET }).opened;
  assert.equal((fs.statSync(path.join(dir, 'quiet-windows.json')).mode & 0o777), 0o600);
  assert.equal(new Q.QuietWindows(dir, { now: () => window.deadline - 1, moveWait: rules.moveWait }).windows.length, 1, 'still open across a restart before its deadline');
  const later = new Q.QuietWindows(dir, { now: () => window.deadline, moveWait: rules.moveWait });
  assert.deepEqual(later.windows, []);
  assert.equal(later.history.at(-1).code, 'expired-at-start'); assert.deepEqual(record(dir).windows, [], 'and the file says so');
  assert.equal(Q.openWindow(dir, KEY, window.deadline), null);
  // Unsafe or malformed records hold nothing.
  const fresh = new Q.QuietWindows(directory(t), { now: () => clock.now, moveWait: rules.moveWait });
  const [open] = fresh.pass({ options: [option(sessions)], settings: SETTINGS, sessions, humanAt: new Map(), failed: new Set(), ...QUIET }).opened;
  const file = path.join(fresh.directory, 'quiet-windows.json'), body = fs.readFileSync(file, 'utf8');
  assert.equal(Q.openWindow(fresh.directory, KEY, clock.now)?.id, open.id);
  fs.chmodSync(file, 0o644); assert.equal(Q.openWindow(fresh.directory, KEY, clock.now), null, 'readable by others'); fs.chmodSync(file, 0o600);
  const elsewhere = path.join(directory(t), 'quiet-windows.json'); fs.renameSync(file, elsewhere); fs.symlinkSync(elsewhere, file);
  assert.equal(Q.openWindow(fresh.directory, KEY, clock.now), null, 'a link'); fs.rmSync(file);
  fs.writeFileSync(file, body.replace('"windows":[', `"pad":"${'x'.repeat(70000)}","windows":[`), { mode: 0o600 });
  assert.equal(Q.openWindow(fresh.directory, KEY, clock.now), null, 'too large'); fs.rmSync(file);
  const forged = JSON.parse(body); forged.windows[0].openedBy = 'agent';
  fs.writeFileSync(file, JSON.stringify(forged), { mode: 0o600 });
  assert.equal(Q.openWindow(fresh.directory, KEY, clock.now), null, 'only NAW opens one');
  forged.windows[0].openedBy = 'naw'; forged.windows[0].deadline = forged.windows[0].openedAt + 3 * 3600000;
  fs.writeFileSync(file, JSON.stringify(forged));
  assert.equal(Q.openWindow(fresh.directory, KEY, clock.now), null, 'never longer than its bound');
});

test('the butler in a window is held with its own reason, shown to the person in both languages', async t => {
  const dir = directory(t), clock = { now: START }, identity = { sessionId: 'butler', nativeId: 'native-butler' };
  const room = new RoomState(dir), ledger = new ButlerLedger(dir, { now: () => clock.now });
  const ingress = new ButlerIngress(dir, { roomState: room, ledger, now: () => clock.now }), actions = new PersonActions({ ingress, now: () => clock.now });
  const sessions = [member('butler', { roomId: null, roomIds: [] }), member('w', { state: 'working', roomId: null, roomIds: [] })], calls = [];
  const client = Object.assign(new EventEmitter(), { close() {}, refresh: async () => {},
    snapshot: () => ({ sessions: structuredClone(sessions), rooms: [], wakePolicy: { enabled: true }, operatorPolicy: { domains: [] } }),
    route: () => ({ client, state: { capabilities: [CAPABILITY] } }),
    call: async (method, ...args) => { calls.push(method); if (method === 'initial') return client.snapshot(); if (method === 'dispatch') return 'receipt'; throw Error(method); } });
  const wake = new StewardWake(dir, { ledger: () => ledger, selected: () => identity, now: () => clock.now, record() {}, changed() {} });
  wake.set(true);
  const quiet = Q ? new Q.QuietWindows(dir, { now: () => clock.now, moveWait: rules.moveWait }) : null;
  quiet?.pass({ options: [option(sessions)], settings: SETTINGS, sessions, humanAt: new Map(), failed: new Set(), ...QUIET });
  const d = new QueueDispatcher({ roomState: room, dataDir: dir, connect: async () => client, steward: () => identity, stewardWake: wake, now: () => clock.now,
    settleMs: 8000, tickMs: 3600000, observePersonActions: s => actions.observe(s, []), transcriptRoot: path.join(dir, 'none'), ...(quiet ? { quietWindows: quiet } : {}) });
  t.after(() => d.close());
  actions.call('operatorAction', ['member', 'grant', {}], 'synthetic-domain');
  await d.schedule(); clock.now += 9000; await d.schedule();
  assert.deepEqual(calls.filter(c => c === 'dispatch'), [], 'not woken inside the window');
  assert.equal(wake.blocked?.reason, 'quiet-window');
  assert.equal(locale.format('zh', 'stewardWake.reason.quiet-window'), '它的后台在迁移前的安静窗口里，窗口结束前不派新活');
  assert.equal(locale.format('en', 'stewardWake.reason.quiet-window'), 'Its backend is in the quiet window before a migration; no new work until the window ends');
});

// main.cjs: the window runs inside the automatic move pass, and its timeout goes out as a version event.
const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
const box = { exports: {} };
vm.runInNewContext(process.binding('natives')['internal/deps/acorn/acorn/dist/acorn'], { module: box, exports: box.exports });
const ast = box.exports.parse(main, { ecmaVersion: 'latest' });
const declared = name => ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
function wired(t) {
  const dir = directory(t), f = { settings: SETTINGS, skew: 0, fail: false, switched: [], owed: [] };
  const ledger = new ButlerLedger(dir), ingress = new ButlerIngress(dir, { roomState: new RoomState(dir), ledger });
  const now = () => Date.now() + f.skew;
  const versionEvents = new VersionEvents(dir, { version: NEW, now, record: event => ingress.record(event), owe: text => { f.owed.push(text); return true; } });
  f.sessions = [member('a', { state: 'working', lastActivityAt: Date.now() }), member('b', { lastActivityAt: Date.now() - 3600000 })];
  const entry = { key: KEY, client: {}, state: { runtimeVersion: OLD, capabilities: CAPS, servicePid: 4200, sessions: f.sessions, room: { messages: [] } } };
  const current = { key: '.', client: {}, state: { runtimeVersion: NEW, capabilities: CAPS, servicePid: 4100, sessions: [], room: { messages: [] } } };
  const control = { maintenance: new Set(), generations: new Map(), revision: 0, manualEpoch: 0, views: new Set() };
  const client = { entries: [entry, current], active: current, control, socket: { destroyed: false }, refresh: async () => {},
    snapshot() { return { sessions: this.entries.flatMap(e => e.state.sessions) }; }, sessionState: value => value.state };
  const context = { client, view: { owner: 'synthetic-owner' }, win: { isDestroyed: () => false } };
  f.scope = vm.createContext({ continuationStatus, uiError, uiLocale: locale, roomState: { apply: state => state }, app: { getVersion: () => NEW },
    backendSwitch: { ...backendSwitch, readSettings: () => f.settings }, windows: new Map([[1, context]]), backendSwitching: null, autoSwitchFailed: new Set(), quitting: false,
    quietWindows: Q ? new Q.QuietWindows(dir, { now, moveWait: rules.moveWait }) : null, versionEvents, queueDispatcher: null, queueRules: rules, runningRelays: () => new Set(), dataDir: dir, path,
    migrateQuietMs: () => rules.MIGRATE_QUIET_MS, migrateUnprovenQuietMs: () => rules.MIGRATE_UNPROVEN_QUIET_MS, sendToPage() {},
    async runBackendSwitch(c, chosen) { f.switched.push(chosen.backendKey); if (f.fail) throw Error('synthetic move failure'); return { resumed: [], left: [] }; },
    recordMigration() {}, recordMigrationFailure() {} });
  for (const name of ['connectionUpdateOptions', 'autoBackendSwitchOnce', 'passQuietWindows', 'quietWindowMoved']) {
    const node = declared(name);
    if (node) vm.runInContext(main.slice(node.start, node.end), f.scope);
  }
  f.pass = () => f.scope.autoBackendSwitchOnce();
  f.record = () => { try { return record(dir); } catch { return null; } };
  f.events = () => ledger.snapshot().events.filter(e => e.eventId.startsWith('version-change:'));
  return f;
}

test('main.cjs opens the window in its move pass and closes it with the move, or with a failed one', async t => {
  for (const fail of [false, true]) {
    const f = wired(t); f.fail = fail;
    await f.pass();
    assert.deepEqual(f.record()?.windows.map(w => [w.scope, w.waited, w.sessions]), [[`backend:${KEY}`, 'busy', ['a', 'b']]], 'opened while a session works');
    assert.deepEqual(f.switched, []);
    Object.assign(f.sessions[0], { state: 'idle', lastActivityAt: Date.now() - 3600000 });
    await f.pass();
    assert.deepEqual(f.switched, [KEY]);
    assert.deepEqual(f.record().windows, []);
    assert.equal(f.record().history.at(-1).code, fail ? 'move-failed' : 'moved');
    assert.deepEqual(f.events(), [], 'a move tells through its own records, not the window');
  }
});

test('main.cjs: at the deadline the butler and the secretary are told once, through the version-events exit', async t => {
  const f = wired(t);
  await f.pass();
  const [window] = f.record()?.windows || [];
  assert.ok(window, 'a window');
  f.skew = window.deadline - Date.now() + 1000;
  await f.pass();
  assert.equal(f.record().history.at(-1).code, 'timeout');
  const [event, ...more] = f.events();
  assert.ok(event); assert.deepEqual(more, []);
  assert.equal(event.kind, 'blocked'); assert.equal(event.payload.reason, 'quiet-window-timeout');
  assert.equal(event.payload.outcome, 'backend:bbbbbbb,waited:busy');
  // Who still holds the move is named (the PM's 11-24 brief: at the deadline, say who and where).
  assert.match(event.payload.text, /^【NAW 版本】后台 bbbbbbb 迁移前的安静窗口到了截止时间（\d{4}-\d\d-\d\dT[\d:]+Z），还没迁成，卡在：2 个会话里 1 个（Synthetic a）在干活或等人回答，[^。]*后自动迁。已恢复派活和自动消息；2 小时内不再为它开窗。$/u);
  assert.deepEqual(f.owed, [`${event.payload.text}\nNAW 只通知，不加任务。`]);
  f.skew += MIN; await f.pass();
  assert.deepEqual(f.record().windows, [], 'none again right after'); assert.equal(f.events().length, 1);
});

test('main.cjs moves a backend whose sessions are only recoverable instead of leaving it not movable (alpha.290)', async t => {
  const f = wired(t);
  for (const s of f.sessions) Object.assign(s, { provider: 'codex', state: 'recoverable' });
  await f.pass();
  assert.deepEqual(f.switched, [KEY]);
});

test('main.cjs: the person turning migration off closes the window, without an event', async t => {
  const f = wired(t);
  await f.pass();
  assert.equal(f.record()?.windows.length, 1);
  f.settings = { auto: false, migrate: false };
  await f.pass();
  assert.deepEqual(f.record().windows, []); assert.equal(f.record().history.at(-1).code, 'migrate-off');
  assert.deepEqual(f.events(), []);
});

test('main.cjs boot gives its windows the move rule: without it a pass would fail and no window would ever open', t => {
  assert.ok(Q, 'quiet-windows.cjs');
  const line = main.split('\n').find(text => text.includes('quietWindows ||= new QuietWindows('));
  assert.ok(line, 'boot constructs the windows');
  const dir = directory(t), scope = vm.createContext({ quietWindows: null, QuietWindows: Q.QuietWindows, queueRules: rules, dataDir: dir });
  vm.runInContext(line, scope);
  const sessions = [member('a', { state: 'working' })];
  const { opened } = scope.quietWindows.pass({ options: [option(sessions)], settings: SETTINGS, sessions, humanAt: new Map(), failed: new Set(), ...QUIET });
  assert.equal(opened.length, 1);
  assert.throws(() => new Q.QuietWindows(directory(t)).pass({ options: [], settings: SETTINGS, sessions: [], humanAt: new Map(), failed: new Set(), ...QUIET }), /moveWait/);
});
