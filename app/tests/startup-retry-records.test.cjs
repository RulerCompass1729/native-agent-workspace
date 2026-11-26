const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { RoomState } = require('../room-state.cjs');
const { SessionLabels } = require('../session-labels.cjs');
const { bindQueueOutcomes } = require('../butler-ingress.cjs');
const { QueueDispatcher } = require('../queue-dispatch.cjs');
const personActionsSource = require('./fixtures/main-person-actions.cjs');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
const section = (from, to) => {
  const start = main.indexOf(from), end = main.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, from);
  return main.slice(start, end);
};

// The records boot() opens and the dispatcher it starts, run as Main runs them: again when a start is retried. The
// dispatcher and the records are real; its passes are not (no session). The phone's workspace keeps its records as well.
function app(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-retry-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const started = [];
  class Dispatcher extends QueueDispatcher {
    async start() { started.push(this); return this; }
  }
  let phone = null;
  const ingress = { recover() {}, captureOutcome: () => null, set roomState(value) { this.held = value; } };
  const sandbox = { dataDir, queueDispatcher: null, butlerIngress: ingress, personActions: {}, backgroundTest: false, process: { env: {} }, windows: new Map(),
    RoomState, SessionLabels, bindQueueOutcomes, QueueDispatcher: Dispatcher, keepStewardOutside() {}, notifyQueueOutcome() {}, connect() {}, broadcastRoom: async () => {},
    notifyRotation() {}, creationDefaults: { get: () => ({}) }, stewardWake: null, answerNotices: null, versionNotices: null, managerNotices: null, quietWindows: null };
  vm.createContext(sandbox);
  vm.runInContext(personActionsSource(main).replace('let personActions = null;', '') + '\nvar roomState, sessionLabels;\n' +
    section('async function startQueueDispatcher()', 'async function broadcastRoom()') +
    '\nfunction openRecords() {\n' + section('  sessionLabels = ', '  try { butlerReadAudit') + '}', sandbox);
  return {
    dataDir, started, sandbox,
    boot: async () => { vm.runInContext('openRecords()', sandbox); await vm.runInContext('startQueueDispatcher()', sandbox); phone ||= { roomState: sandbox.roomState }; return sandbox.roomState; },
    saved: () => JSON.parse(fs.readFileSync(path.join(dataDir, 'collaboration-spaces.json'), 'utf8')).rooms.map(room => room.queue.map(item => [item.text, item.status])),
    held: () => [phone.roomState === sandbox.roomState, ingress.held === sandbox.roomState],
  };
}

test('a retried start keeps the records the dispatcher has, so each side sees and keeps what the other writes', async t => {
  const h = app(t), first = await h.boot(), space = first.create('Space'), other = first.create('Other');
  first.queueAdd('before', 'member', space);
  for (const round of ['one', 'two']) {
    const retried = await h.boot();
    assert.equal(h.started.length, 1, 'one dispatcher for the run');
    const dispatcher = h.started[0], added = retried.queueAdd('after ' + round, 'member', space);
    retried.queueAdd('other ' + round, 'member', other);
    assert.ok(dispatcher.roomState.metadata(space).queue.some(item => item.id === added), 'the dispatcher plans what was added since');
    // Whoever writes last.
    dispatcher.roomState.queueMarkSent(space, added, 'member', 'Member', Date.now(), false, null, []);
    retried.queueAdd('later ' + round, 'member', space);
  }
  assert.deepEqual(h.saved(), [
    [['before', 'queued'], ['after one', 'sent'], ['later one', 'queued'], ['after two', 'sent'], ['later two', 'queued']],
    [['other one', 'queued'], ['other two', 'queued']]]);
  assert.deepEqual(h.held(), [true, true], 'the phone and the event record have them too');
});

test('records that could not be read are read again by a retried start, for whoever has them', async t => {
  for (const [name, warning] of [['collaboration-spaces.json', 'spacesWarning'], ['room-state.json', 'warning']]) {
    const h = app(t), file = path.join(h.dataDir, name), keep = new RoomState(h.dataDir), space = keep.create('Space');
    keep.queueAdd('kept', 'member', space); keep.queueAdd('kept', 'member', 'shared');
    const good = fs.readFileSync(file);
    fs.writeFileSync(file, '{', { mode: 0o600 });
    const first = await h.boot();
    assert.ok(first[warning], name);
    assert.ok((await h.boot())[warning], name + ' still unreadable');
    assert.equal(fs.readFileSync(file, 'utf8'), '{');
    fs.writeFileSync(file, good);
    const retried = await h.boot(), seen = h.started[0].roomState;
    assert.deepEqual([retried[warning], retried[warning + 'UiMessage']], ['', undefined], name);
    retried.queueAdd('task', 'member', space);
    for (const id of [space, 'shared']) assert.deepEqual(seen.metadata(id).queue.map(item => item.text), id === space ? ['kept', 'task'] : ['kept'], name);
    assert.deepEqual(h.held(), [true, true], name);
  }
});

// As the app was seen to start on 11-25: everything up to the window worked, the window's page did not become ready in time.
test('a start that fails at its window, retried, leaves the dispatcher and the window the same records', async t => {
  const order = ['roomState = new RoomState(dataDir);', 'await startQueueDispatcher();', 'dsh = await startDsh(', 'await openWindow(view);'].map(step => main.indexOf(step));
  assert.ok(order[0] > 0 && order.every((at, index) => !index || at > order[index - 1]), 'boot() comes to the window last');
  const h = app(t), shown = [], hosts = [];
  const window = () => ({ isDestroyed: () => false, destroy() {}, loadFile: async () => {}, webContents: { send: (_channel, status) => shown.push(status.kind) } });
  Object.assign(h.sandbox, { starting: false, quitting: false, localeHostGeneration: 0, startupWindow: null, startupFile: '', dsh: null, pendingReveal: null, backgroundControl: null,
    backendSwitchTimer: {}, uiLocale: { startupCode() {} }, displayText: key => key, startupMessage: error => error.message, displayLanguage() {}, updateApplicationMenu() {},
    readStartupLocale: async () => {}, resumeAppMobileOnBoot: async () => {}, createWindow: window,
    startDsh: async () => { const host = { stopped: false, stop() { this.stopped = true; } }; hosts.push(host); return host; },
    openWindow: async () => { if (hosts.length === 1) throw Error('UI did not become ready'); } });
  vm.runInContext(section('async function start()', '// The page handled') +
    'async function boot() { openRecords(); await startQueueDispatcher(); dsh = await startDsh(); await openWindow(); }', h.sandbox);
  await h.sandbox.start();
  assert.deepEqual([shown.at(-1), hosts.map(host => host.stopped)], ['failed', [true]]);
  const space = h.sandbox.roomState.create('Space');
  h.sandbox.roomState.queueAdd('before', 'member', space);
  await h.sandbox.start();
  assert.deepEqual([hosts.length, h.started.length], [2, 1], 'a second UI host and the one dispatcher');
  const added = h.sandbox.roomState.queueAdd('after', 'member', space), dispatcher = h.started[0].roomState;
  assert.ok(dispatcher.metadata(space).queue.some(item => item.id === added), 'the dispatcher plans what the window added');
  dispatcher.queueMarkSent(space, dispatcher.metadata(space).queue[0].id, 'member', 'Member', Date.now(), false, null, []);
  assert.deepEqual(h.saved(), [[['before', 'sent'], ['after', 'queued']]]);
});

// What is in both files: the spaces and their items, the shared space's items, its switch and its archived sessions.
const contents = records => [records.spaces.rooms.map(room => [room.name, room.queue?.map(item => item.text)]),
  records.value.queue?.map(item => item.text), records.value.notesToQueue, records.value.archivedSessions];
test('a file the person put in place before the retry counts, whatever was read before', async t => {
  for (const before of ['missing', 'readable']) for (const name of ['collaboration-spaces.json', 'room-state.json']) {
    const h = app(t), what = `${name}, ${before} at the first start`, file = path.join(h.dataDir, name);
    const keep = new RoomState(h.dataDir), space = keep.create('Space');
    keep.queueAdd('kept', 'member', space); keep.queueAdd('kept', 'member', 'shared');
    const expected = contents(keep), good = fs.readFileSync(file);
    if (before === 'missing') fs.unlinkSync(file);
    else {
      const current = new RoomState(h.dataDir);
      if (name === 'room-state.json') {
        current.update({ archivedSessions: ['ended'], notesToQueue: true, notesToQueueSince: 1 });
        current.queueAdd('newer', 'member', 'shared');
      } else {
        current.create('Newer'); current.queueAdd('newer', 'member', space);
      }
    }
    const first = await h.boot();
    assert.notDeepEqual(contents(first), expected, what);
    assert.deepEqual([first.warning, first.spacesWarning], ['', ''], what);
    fs.writeFileSync(file, good, { mode: 0o600 });
    const retried = await h.boot();
    assert.deepEqual(contents(retried), expected, what);
    assert.deepEqual(contents(h.started[0].roomState), expected, what + ': the dispatcher has it');
    retried.create('Added'); retried.queueAdd('added', 'member', 'shared');
    const saved = new RoomState(h.dataDir);
    assert.deepEqual(contents(saved), [[...expected[0], ['Added', undefined]], ['kept', 'added'], ...expected.slice(2)], what + ': and the next change keeps it');
    assert.deepEqual(h.held(), [true, true], what);
  }
});

test('a file that went missing or cannot be read by the retry changes nothing that is held, and is not written over', async t => {
  for (const [name, warning, id] of [['collaboration-spaces.json', 'spacesWarning'], ['room-state.json', 'warning', 'shared']]) {
    const h = app(t), file = path.join(h.dataDir, name), first = await h.boot(), space = first.create('Space');
    first.queueAdd('kept', 'member', space); first.queueAdd('kept', 'member', 'shared');
    const expected = contents(first), good = fs.readFileSync(file);
    fs.writeFileSync(file, '{', { mode: 0o600 });
    const damaged = await h.boot();
    assert.ok(damaged[warning], name);
    assert.deepEqual(contents(damaged), expected, name);
    assert.throws(() => damaged.queueAdd('refused', 'member', id || space));
    assert.equal(fs.readFileSync(file, 'utf8'), '{');
    fs.writeFileSync(file, good);
    assert.equal((await h.boot())[warning], '', name);
    fs.unlinkSync(file);
    const missing = await h.boot();
    assert.deepEqual([missing[warning], contents(missing)], ['', expected], name);
    missing.queueAdd('added', 'member', id || space);
    assert.deepEqual(new RoomState(h.dataDir).metadata(id || space).queue.map(item => item.text), ['kept', 'added'], name);
  }
});
