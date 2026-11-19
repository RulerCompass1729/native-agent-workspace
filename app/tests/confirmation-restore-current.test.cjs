const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events'), { createRequire } = require('node:module');
const { BackgroundControl } = require('../background-control.cjs'), { RoomState } = require('../room-state.cjs');
const { SessionLabels } = require('../session-labels.cjs'), operation = require('../background-operation.cjs'), locale = require('../ui-locale.js');
async function fixture(t, duringAudit = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-restore-notice-'));
  const actor = { id: 'agent', nativeId: 'native-agent', name: 'Lead', provider: 'codex' };
  const target = { id: 'target', nativeId: 'native-target', name: 'Worker', provider: 'claude', state: 'idle', roomIds: [],
    placementRevision: 1, memberRevision: 0, connectionRevision: 0, roomMembershipRevisions: {}, serviceCapabilities: ['singleHomeMoveV1'] };
  const raw = { sessions: [{ ...actor, state: 'idle', roomIds: [] }, target] }, rooms = new RoomState(dir), labels = new SessionLabels(dir);
  rooms.rename('Lab');
  const detached = { nativeId: target.nativeId, connectionRevision: 0, revision: 1, signature: JSON.stringify([[], 0, []]) };
  rooms.update({ archivedSessions: [target.id], sessionArchives: { [target.id]: { nativeId: target.nativeId,
    rooms: [{ id: 'shared', index: 0, next: null, expected: null, done: true }], checkpoint: detached, detached } } });
  let handlers = 0, mutation = null, pending, main;
  const native = [], notices = [], reveals = [];
  const client = { snapshot: () => raw, close() {}, call: async (method, id, room, proof) => {
    if (method === 'initial') return raw;
    native.push(method);
    if (method === 'pause') return;
    assert.equal(method, 'moveMembership'); assert.equal(id, target.id);
    const before = target.placementRevision; target.roomIds = [room]; target.placementRevision++;
    target.memberRevision++; target.roomMembershipRevisions[room] = 1;
    return target.placementReceipt = { operationId: proof.operationId, nativeId: target.nativeId, roomId: room,
      beforeRevision: before, revision: target.placementRevision, connectionRevision: 0, changed: true };
  } };
  const context = { background: true, client, view: { selected: actor.id }, win: { destroy() {} }, confirmationActors: () => [actor], checkActor: async () => {} };
  context.fingerprint = command => operation.controlFingerprint(command, { state: raw, actor, context, roomState: rooms, sessionLabels: labels, client });
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; notices.push(this); }
    show() {} close() { this.emit('close'); }
  }
  const control = new BackgroundControl({ dataDir: dir, context: async () => context,
    handlers: new Map([['restoreSession', async (_c, id) => { handlers++; return rooms.restoreSession(client, id, target.name); }]]),
    confirmation: () => ({ message: 'Synthetic restore', detail: 'Synthetic archive', buttons: ['Cancel', 'Confirm'], cancelId: 0 }),
    audit: row => { if (duringAudit && mutation && row.state === 'running') { const run = mutation; mutation = null; run(); } },
    confirmationPending: row => main.notifyBackgroundConfirmation(row), changed: () => main?.backgroundNotifications?.sync() });
  const decide = control.decide.bind(control); control.decide = (...args) => pending = decide(...args);
  main = vm.createContext({ require: createRequire(require.resolve('../main.cjs')), Notification, backgroundControl: control, backgroundNotifications: null,
    notificationScreen: { isUnlocked: () => true, revision: 0 }, displayText: (key, params) => locale.format('en', key, params),
    revealRecord: value => reveals.push(value), primary: true, quitting: false, queueOutcomeSeen: new Set(), roomState: rooms, sessionLabels: labels, confirmationSnapshot: c => c.snapshot() });
  const source = fs.readFileSync(require.resolve('../main.cjs'), 'utf8'), start = source.indexOf('function notifyBackgroundConfirmation('), end = source.indexOf('\nfunction notifyQueueOutcome(', start);
  vm.runInContext(source.slice(start, end), main);
  t.after(async () => { main.backgroundNotifications?.dispose(); await control.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const row = await control.call({ sender: actor, identity: { callId: 'restore-call', turnId: 'turn' }, valid: () => true },
    { action: 'invoke', operation_id: 'restore-operation', method: 'restoreSession', arguments: [target.id] });
  assert.equal(row.state, 'confirmation-required'); assert.equal(notices[0].options.actions?.length, 2);
  return { target, rooms, reveals, native, context, get handlers() { return handlers; }, mutate(fn) { if (duringAudit) mutation = fn; else fn(); },
    async click() { notices[0].emit('action', { actionIndex: 0 }); await pending; for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); return control.receipt(actor, row.id); } };
}
for (const change of ['placement', 'membership', 'room']) test('restore notice rechecks changed ' + change + ' before deciding and opens the full card', async t => {
  const h = await fixture(t);
  h.mutate(() => { if (change === 'placement') h.target.placementRevision++; else if (change === 'membership') h.target.memberRevision++; else h.target.roomIds = ['shared']; });
  await h.click(); t.diagnostic(JSON.stringify({ handlers: h.handlers, reveals: h.reveals.length }));
  assert.equal(h.handlers, 0); assert.equal(h.reveals.length, 1);
});
test('restore notice rechecks placement after asynchronous audit and never enters the handler', async t => {
  const h = await fixture(t, true); h.mutate(() => h.target.placementRevision++);
  await h.click(); t.diagnostic(JSON.stringify({ handlers: h.handlers, reveals: h.reveals.length }));
  assert.equal(h.handlers, 0); assert.equal(h.reveals.length, 1);
});
for (const unrelated of [false, true]) test('unchanged restore notice confirms once' + (unrelated ? ' after an unrelated space edit' : ''), async t => {
  const h = await fixture(t); if (unrelated) h.rooms.create('Other');
  const result = await h.click();
  assert.equal(h.handlers, 1); assert.equal(result.state, 'complete'); assert.equal(result.value.placement, 'restored');
  assert.deepEqual(h.target.roomIds, ['shared']); assert.equal(h.reveals.length, 0);
});
