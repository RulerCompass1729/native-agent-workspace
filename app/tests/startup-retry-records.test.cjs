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
    notifyRotation() {}, creationDefaults: { get: () => ({}) }, stewardWake: null, answerNotices: null, versionNotices: null, quietWindows: null };
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
