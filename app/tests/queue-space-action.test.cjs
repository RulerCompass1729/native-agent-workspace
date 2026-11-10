const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { uiError } = require('../ui-errors.cjs');
const os = require('node:os');
const { RoomState } = require('../room-state.cjs');
const { QueueSecretary } = require('../queue-secretary.cjs');
const backgroundOperation = require('../background-operation.cjs');
const { BackgroundControl } = require('../background-control.cjs');

// The actual spaceAction handler from main.cjs: only the person's window may change a queue.
function spaceAction(extra = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  const start = source.indexOf("  register('spaceAction', async (c, roomId, action, args = []) => {");
  const end = source.indexOf("  register('spaceFiles',", start);
  assert.ok(start > 0 && end > start);
  const calls = [];
  let handler;
  const roomState = {
    metadata() {},
    queueAdd(...args) {
      calls.push(['queueAdd', ...args]);
      return 'item-1';
    },
    queueCancel(...args) {
      calls.push(['queueCancel', ...args]);
    },
    queueResolve(...args) {
      calls.push(['queueResolve', ...args]);
    },
  };
  const context = vm.createContext({
    register(name, fn) {
      handler = fn;
    },
    validRoomId: () => true,
    uiError,
    roomState,
    broadcastRoom: async () => {},
    queueDispatcher: { schedule() {} },
    backgroundOperation,
    queueSecretary: { creator() { throw uiError('error.queue.secretaryOnly'); } },
    sessionLabels: { labels: new Map() },
    ...extra,
  });
  vm.runInContext(source.slice(start, end), context);
  return { handler, calls };
}

test('an ordinary agent cannot add; even the secretary cannot cancel or resolve queue items', async () => {
  const { handler, calls } = spaceAction();
  for (const action of ['queueAdd', 'queueCancel', 'queueResolve']) {
    await assert.rejects(handler({ background: true, client: { call: async () => ({ sessions: [] }) } }, 'shared', action, ['x', null]), error => error.uiMessage?.key === (action === 'queueAdd' ? 'error.queue.secretaryOnly' : 'error.queue.personOnly'));
  }
  assert.deepEqual(calls, []);
});

test('the person\'s window adds, resolves and cancels queue items', async () => {
  const { handler, calls } = spaceAction();
  assert.equal(await handler({}, 'shared', 'queueAdd', ['task', null]), 'item-1');
  await handler({}, 'shared', 'queueResolve', ['item-1']);
  await handler({}, 'shared', 'queueCancel', ['item-1']);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['queueAdd', 'task', null, 'shared', { kind: 'person', name: 'You', sessionId: null }], ['queueResolve', 'item-1', 'shared'], ['queueCancel', 'item-1', 'shared']]);
});

// Exercise the real register wrapper as well as its handler. Queue metadata is
// local even when an unrelated retained backend lacks backgroundControlV1.
function registered(extra) {
  const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  const handlers = new Map(), ipc = new Map();
  const context = vm.createContext({
    applicationHandlers: handlers, backgroundOperation, uiError,
    ipcMain: { handle: (name, handler) => ipc.set(name, handler) },
    validRoomId: () => true, broadcastRoom: async () => {},
    queueDispatcher: { schedule() {} }, ...extra,
  });
  const start = source.indexOf('function register(name, handler) {');
  vm.runInContext(source.slice(start, source.indexOf('async function replaceBackendSockets', start)), context);
  for (const [first, last] of [["  register('spaceAction',", "  register('spaceFiles',"], ["  register('queueSecretary',", "  register('rename',"]]) {
    const a = source.indexOf(first), b = source.indexOf(last, a);
    if (a !== -1) vm.runInContext(source.slice(a, b), context);
  }
  vm.runInContext("register('send', () => 'should require backend support');", context);
  return { handlers, ipc };
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-secretary-action-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const role = new QueueSecretary(dir), room = new RoomState(dir);
  const sender = { id: 'secretary', nativeId: 'native-secretary', name: 'Secretary', provider: 'codex', turnId: 'turn', callId: 'call', operationId: 'op' };
  const record = { id: sender.id, nativeId: sender.nativeId, name: 'Secretary', state: 'idle' };
  const client = { call: async () => ({ sessions: [record] }), entries: [{ state: { sessions: [{ id: 'old' }], capabilities: [] } }], refresh: async () => {}, close() {}, snapshot: () => ({ wakePolicy: { enabled: true }, sessions: [{ id: 'old' }] }) };
  const c = { background: true, actor: sender, client, view: { selected: sender.id }, win: { destroy() {} }, checkActor: async () => {} };
  const { handlers, ipc } = registered({ roomState: room, queueSecretary: role, sessionLabels: { labels: new Map() } });
  const invoke = (name, args, actor = sender, context = c) => backgroundOperation.run(actor, () => handlers.get(name)(context, ...args), { context, valid: async () => {} });
  return { dir, role, room, sender, record, c, handlers, ipc, invoke };
}
test('actual background entry accepts only the selected native secretary, stores provenance, and lets the person cancel', async t => {
  const f = fixture(t);
  f.role.set({ sessionId: f.sender.id, nativeId: f.sender.nativeId });
  const id = await f.invoke('spaceAction', ['shared', 'queueAdd', ['task from the person', null, { kind: 'person', name: 'spoof', sessionId: null }]]);
  assert.deepEqual(f.room.queueItems()[0].creator, { kind: 'secretary', name: 'Secretary', sessionId: 'secretary' });
  assert.equal(f.room.queueItems()[0].id, id);
  const event = f.room.value.events.at(-1);
  assert.equal(event.uiMessage.key, 'notice.queue.addedBySecretary');
  assert.equal(event.uiMessage.params.sessionId, f.sender.id);
  for (const action of ['queueCancel', 'queueResolve']) await assert.rejects(f.invoke('spaceAction', ['shared', action, [id]]), error => error.uiMessage?.key === 'error.queue.personOnly');
  await f.handlers.get('spaceAction')({}, 'shared', 'queueCancel', [id]);
  assert.equal(f.room.queueItems()[0].status, 'cancelled');
  await assert.rejects(f.invoke('spaceAction', ['shared', 'queueAdd', ['other', null]], { ...f.sender, id: 'other' }), error => error.uiMessage?.key === 'error.queue.secretaryOnly');
  f.role.set(null);
  await assert.rejects(f.invoke('spaceAction', ['shared', 'queueAdd', ['revoked', null]]), error => error.uiMessage?.key === 'error.queue.secretaryOnly');
  await assert.rejects(f.handlers.get('spaceAction')(f.c, 'shared', 'queueAdd', ['no native proof', null]), /originating operation/);
  assert.equal(f.room.queueItems().length, 1);
});
test('only the person designates/revokes; unrelated old backends still gate native input', async t => {
  const f = fixture(t);
  assert.ok(f.handlers.has('queueSecretary'));
  await f.handlers.get('queueSecretary')({ client: f.c.client }, 'secretary');
  assert.deepEqual(f.role.current(), { sessionId: 'secretary', nativeId: 'native-secretary' });
  for (const id of [null, 'secretary']) await assert.rejects(f.invoke('queueSecretary', [id]), error => error.uiMessage?.key === 'error.queue.personOnly');
  await f.handlers.get('queueSecretary')({}, null);
  assert.equal(f.role.current(), null);
  await assert.rejects(f.invoke('send', ['old', 'text']), /adopt background-control support/);
  await assert.rejects(f.handlers.get('queueSecretary')({ client: f.c.client }, 'missing'), error => error.uiMessage?.key === 'error.queue.secretaryInvalid');
});

test('the actual authenticated background controller adds once without confirmation and retains its native sender', async t => {
  const f = fixture(t);
  f.role.set({ sessionId: f.sender.id, nativeId: f.sender.nativeId });
  const controller = new BackgroundControl({ dataDir: f.dir, handlers: f.handlers, context: () => f.c });
  const binding = { sender: { id: f.sender.id, nativeId: f.sender.nativeId, provider: 'codex', name: 'Secretary' }, identity: { callId: 'native-call', turnId: 'native-turn' }, valid: () => true };
  const command = { action: 'invoke', method: 'spaceAction', arguments: ['shared', 'queueAdd', ['A request from the person', null]], operation_id: 'intake-one' };
  const receipt = await controller.call(binding, command);
  assert.equal(receipt.state, 'complete');
  assert.equal(receipt.actor.id, f.sender.id);
  assert.equal(receipt.confirmation, undefined);
  assert.equal(f.room.queueItems().length, 1);
  assert.equal((await controller.call(binding, command)).duplicate, true);
  assert.equal(f.room.queueItems().length, 1, 'an uncertain caller must read its existing operation instead of creating a duplicate');
  f.role.set(null);
  const refusal = await controller.call(binding, { ...command, operation_id: 'intake-revoked' });
  assert.equal(refusal.state, 'unconfirmed');
  assert.equal(f.room.queueItems().length, 1);
  await controller.close();
});
