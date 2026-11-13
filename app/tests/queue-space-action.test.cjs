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
    // This stand-in space state has archived nobody.
    apply: snapshot => snapshot,
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
    stewardCaller: async () => null,
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
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['queueAdd', 'task', null, 'shared', { kind: 'person', name: 'You', sessionId: null }, null], ['queueResolve', 'item-1', 'shared', null], ['queueCancel', 'item-1', 'shared', null]]);
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
    queueDispatcher: { schedule() {} }, stewardCaller: async () => null, ...extra,
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

test('a session the person archived cannot be made secretary, and an archived secretary can no longer add to the queue', async t => {
  const f = fixture(t);
  // The backend the space record archives through: it knows the session, and never marks it archived.
  const backend = { call: async method => (method === 'initial' ? { sessions: [f.record] } : undefined), snapshot: () => ({ sessions: [f.record] }), entries: f.c.client.entries, refresh: async () => {}, close() {} };
  await f.handlers.get('queueSecretary')({ client: f.c.client }, 'secretary');
  const first = await f.invoke('spaceAction', ['shared', 'queueAdd', ['before the archive', null]]);
  assert.equal(f.room.queueItems().length, 1);
  await f.room.archiveSession(backend, 'secretary', 'Secretary');
  assert.deepEqual(f.room.value.archivedSessions, ['secretary']);
  assert.equal((await f.c.client.call('initial')).sessions[0].archived, undefined, 'Only the desktop\'s own record says it is archived');
  // The designation is still recorded, but the archived session no longer acts as secretary.
  assert.deepEqual(f.role.current(), { sessionId: 'secretary', nativeId: 'native-secretary' });
  await assert.rejects(f.invoke('spaceAction', ['shared', 'queueAdd', ['after the archive', null]]), error => error.uiMessage?.key === 'error.queue.secretaryOnly');
  assert.deepEqual(f.room.queueItems().map(item => item.id), [first]);
  // It cannot be designated again while archived; the person can still revoke it, and add tasks themselves.
  await assert.rejects(f.handlers.get('queueSecretary')({ client: f.c.client }, 'secretary'), error => error.uiMessage?.key === 'error.queue.secretaryInvalid');
  await f.handlers.get('queueSecretary')({}, null);
  assert.equal(f.role.current(), null);
  await assert.rejects(f.handlers.get('queueSecretary')({ client: f.c.client }, 'secretary'), error => error.uiMessage?.key === 'error.queue.secretaryInvalid');
  assert.equal(f.role.current(), null);
  await f.handlers.get('spaceAction')({}, 'shared', 'queueAdd', ['the person adds one', null]);
  assert.equal(f.room.queueItems().length, 2);
  // Restored, it can be designated and add again.
  await f.room.restoreSession(backend, 'secretary', 'Secretary');
  await f.handlers.get('queueSecretary')({ client: f.c.client }, 'secretary');
  await f.invoke('spaceAction', ['shared', 'queueAdd', ['after the restore', null]]);
  assert.equal(f.room.queueItems().length, 3);
});

// Steward step 2, batch 4 (the person, 2026-11-12 06:4x: 「这些事难道你不能做吗」): the butler adds, cancels and marks
// handled, each under its own name; everyone else keeps the rules above.
test('the butler adds, cancels and resolves queue items, each said to be the butler\'s', async () => {
  const { handler, calls } = spaceAction({ stewardCaller: async c => c.background ? { id: 'butler', name: 'Claude manager' } : null });
  const c = { background: true, client: { call: async () => ({ sessions: [] }) } };
  assert.equal(await handler(c, 'shared', 'queueAdd', ['task', null]), 'item-1');
  await handler(c, 'shared', 'queueCancel', ['item-1']); await handler(c, 'shared', 'queueResolve', ['item-1']);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['queueAdd', 'task', null, 'shared', { kind: 'secretary', name: 'Claude manager', sessionId: 'butler' }, 'steward'],
    ['queueCancel', 'item-1', 'shared', 'steward'], ['queueResolve', 'item-1', 'shared', 'steward']]);
});
test('the room state keeps who acted on the item, in a form older builds still read', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-steward-queue-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const room = new RoomState(dir), creator = { kind: 'secretary', name: 'Claude manager', sessionId: 'butler' };
  const a = room.queueAdd('first', null, 'shared', creator, 'steward'), b = room.queueAdd('second', null, 'shared', creator, 'steward');
  assert.equal(room.value.events.at(-1).uiMessage.key, 'notice.queue.addedBySteward');
  room.queueCancel(a, 'shared', 'steward');
  assert.equal(room.value.events.at(-1).uiMessage.key, 'notice.queue.cancelledBySteward');
  const items = new RoomState(dir).queueItems();
  assert.deepEqual(items.map(i => [i.addedBy, i.finishedBy ?? null, i.status]), [['steward', 'steward', 'cancelled'], ['steward', null, 'queued']]);
  // The creator form is one an older build accepts (it reads person or secretary only) and leaves the new fields alone.
  assert.ok(items.every(i => ['person', 'secretary'].includes(i.creator.kind) && Object.keys(i.creator).sort().join() === 'kind,name,sessionId'));
  assert.throws(() => require('../queue-dispatch.cjs').validateQueue([{ ...items[0], addedBy: 'someone' }]), /actor/);
  void b;
});
test('stewardCaller: only the designated session, as it is now, outside every space', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  const start = source.indexOf('async function stewardCaller(c) {'), end = source.indexOf('function conversationReaderAllowed(actor) {', start);
  const actor = { id: 'butler', nativeId: 'native-butler' }, record = { id: 'butler', nativeId: 'native-butler', name: 'Butler', state: 'idle', roomIds: [] };
  let steward = { sessionId: 'butler', nativeId: 'native-butler' }, sessions = [record];
  const context = vm.createContext({ backgroundOperation: { current: () => actor }, stewardOf: () => { if (steward instanceof Error) throw steward; return steward; },
    roomState: { apply: s => s }, roomIds: s => { if (s.roomIds === 'broken') throw Error('broken'); return s.roomIds; }, sessionLabels: { labels: new Map([['butler', 'Claude manager']]) } });
  vm.runInContext(source.slice(start, end), context);
  const call = (background = true) => context.stewardCaller({ background, client: { call: async () => ({ sessions }) } });
  assert.deepEqual(JSON.parse(JSON.stringify(await call())), { id: 'butler', name: 'Claude manager' });
  assert.equal(await call(false), null, 'the person\'s own window is not the butler');
  steward = { sessionId: 'butler', nativeId: 'older-native' }; assert.equal(await call(), null, 'another native session of it');
  steward = Error('unreadable'); assert.equal(await call(), null, 'a designation that cannot be read');
  steward = null; assert.equal(await call(), null);
  steward = { sessionId: 'butler', nativeId: 'native-butler' };
  for (const change of [{ roomIds: ['shared'] }, { roomIds: 'broken' }, { archived: true }, { state: 'ended' }, { nativeContextPending: true }, { nativeId: 'other' }]) {
    sessions = [{ ...record, ...change }]; assert.equal(await call(), null, JSON.stringify(change));
  }
});
// Batch 4, part 2: the butler sees every space as a member does, only while it is in no space.
test('the butler, in no space, reads every space as a member; others keep their own spaces; an unreadable designation is nobody', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  const start = source.indexOf('function conversationReaderAllowed(actor) {'), end = source.indexOf('function controlRequestActors(client) {', start);
  let steward = { sessionId: 'butler', nativeId: 'native-butler' }, secretary = null;
  const context = vm.createContext({ stewardOf: () => { if (steward instanceof Error) throw steward; return steward; }, queueSecretary: { current: () => secretary },
    roomState: { value: { archivedSessions: [] }, spaces: { rooms: [{ id: 'web' }, { id: 'empty' }] } }, roomIds: s => s.roomIds });
  vm.runInContext(source.slice(start, end), context);
  const snapshot = { room: { id: 'shared' }, rooms: [{ id: 'shared' }, { id: 'web' }, { id: 'docs' }], sessions: [
    { id: 'butler', nativeId: 'native-butler', roomIds: [] }, { id: 'member', nativeId: 'native-member', roomIds: ['web'] }] };
  const access = actor => JSON.parse(JSON.stringify(context.conversationAccess(actor, snapshot)));
  const butler = { id: 'butler', nativeId: 'native-butler' }, member = { id: 'member', nativeId: 'native-member' };
  assert.deepEqual(access(butler), { roomIds: ['shared', 'web', 'docs', 'empty'], secretary: false }, 'a space nobody joined yet included');
  assert.deepEqual(access(member), { roomIds: ['web'], secretary: false });
  secretary = { sessionId: 'butler', nativeId: 'native-butler' };
  assert.deepEqual(access(butler), { roomIds: ['shared', 'web', 'docs', 'empty'], secretary: false }, 'also the secretary: the butler reads');
  assert.equal(context.conversationReaderAllowed(butler), true);
  steward = { sessionId: 'butler', nativeId: 'older-native' };
  assert.deepEqual(access(butler), { roomIds: [], secretary: true }, 'another native session of it is the secretary only');
  steward = Error('unreadable'); assert.deepEqual(access(butler), { roomIds: [], secretary: true });
  // What the agent's view then holds: queue text and space content for every space.
  steward = { sessionId: 'butler', nativeId: 'native-butler' }; secretary = null;
  const value = { sessions: snapshot.sessions, room: { id: 'shared' }, rooms: [{ id: 'web', name: 'Web', notes: 'N', queue: [{ id: 'q', status: 'queued', text: 'Fix it', assignee: null, createdAt: 1 }] }] };
  const view = backgroundOperation.conversationSnapshot(value, { ...butler, name: 'B', provider: 'claude' }, null, undefined, context.conversationAccess(butler, snapshot));
  assert.deepEqual([view.rooms[0].notes, view.rooms[0].queue[0].text], ['N', 'Fix it']);
});

// Follow-up 2 (11-12): in the person's data, item 87a3b4c0 named an assignee no session had (it shared only its
// first eight characters with a member) and stayed queued for nobody. An assignee that is not a current member
// of the space is refused before anything is added, and the refusal names the members (name · id) to choose from.
const SPACE = '7b1d2c3e-4f50-4a61-8b72-93a4b5c6d7e8', OTHER_SPACE = '7b1d2c3e-4f50-4a61-8b72-000000000000';
const MEMBER = '0e36ef36-5bff-4c1a-9d2e-3f4a5b6c7d8e', LOOKALIKE = '0e36ef36-c702-4e3b-8a1c-2d3e4f5a6b7c';
function assigneeCase(sessions, extra = {}) {
  const harness = spaceAction({ queueRules: require('../queue-dispatch.cjs'),
    sessionLabels: { labels: new Map([[MEMBER, 'Builder']]) }, stewardCaller: async c => c.background ? { id: 'butler', name: 'Claude manager' } : null, ...extra });
  harness.handlerFor = background => args => harness.handler({ background, client: { call: async () => ({ sessions }) } }, SPACE, 'queueAdd', args);
  return harness;
}
const members = () => [
  { id: MEMBER, name: 'stored name', roomIds: [SPACE] },
  { id: 'a1b2c3d4-0000-4000-8000-000000000002', name: 'Reviewer', roomIds: [SPACE, OTHER_SPACE] },
  { id: 'a1b2c3d4-0000-4000-8000-000000000003', name: 'Gone', roomIds: [SPACE], archived: true },
  { id: 'a1b2c3d4-0000-4000-8000-000000000004', name: 'Elsewhere', roomIds: [OTHER_SPACE] },
  { id: 'butler', name: 'Claude manager', roomIds: [] },
];
const notMember = list => error => {
  assert.equal(error.uiMessage?.key, 'error.queue.assigneeNotMember');
  assert.equal(error.uiMessage.params.members, list);
  assert.match(error.message, /没有加进队列/);
  return true;
};
test('queueAdd refuses an assignee that is not a current member of the space, naming the members to choose from', async () => {
  const { handlerFor, calls } = assigneeCase(members(), { roomState: { apply: s => s, metadata: () => ({ memberOrder: ['a1b2c3d4-0000-4000-8000-000000000002'] }), queueAdd: (...args) => { calls.push(['queueAdd', ...args]); return 'item-1'; } } });
  const listed = `Reviewer · a1b2c3d4-0000-4000-8000-000000000002; Builder · ${MEMBER}`;
  for (const background of [true, false]) {
    const add = handlerFor(background);
    // An id no session has, sharing its first eight characters with a member; an archived member; a session in
    // another space only; the butler itself (in no space); something that is not an id at all.
    for (const assignee of [LOOKALIKE, 'a1b2c3d4-0000-4000-8000-000000000003', 'a1b2c3d4-0000-4000-8000-000000000004', 'butler', MEMBER.slice(0, 8), 7, '']) {
      await assert.rejects(add(['task', assignee]), notMember(listed), `${background} ${assignee}`);
    }
    assert.deepEqual(calls, [], 'nothing was added');
  }
  // A member is taken as the assignee; no assignee is any free member's.
  assert.equal(await handlerFor(true)(['task', MEMBER]), 'item-1');
  assert.equal(await handlerFor(true)(['task', null]), 'item-1');
  assert.equal(await handlerFor(false)(['task', 'a1b2c3d4-0000-4000-8000-000000000002']), 'item-1');
  assert.deepEqual(calls.map(call => call[2]), [MEMBER, null, 'a1b2c3d4-0000-4000-8000-000000000002']);
});
test('queueAdd with an assignee in a space with no members says so, and adds nothing', async () => {
  const { handlerFor, calls } = assigneeCase(members().filter(s => !s.roomIds.includes(SPACE) || s.archived), { roomState: { apply: s => s, metadata: () => ({ memberOrder: [] }), queueAdd: () => { calls.push('added'); } } });
  await assert.rejects(handlerFor(true)(['task', MEMBER]), error => error.uiMessage?.key === 'error.queue.assigneeNoMembers' && /没有加进队列/.test(error.message));
  assert.deepEqual(calls, []);
});
test('a background caller\'s refused assignee comes back in its receipt with the members, and nothing is queued', async t => {
  const f = fixture(t);
  const member = { id: MEMBER, nativeId: 'native-member', name: 'Builder', state: 'idle', roomIds: ['shared'] };
  f.c.client.call = async () => ({ sessions: [f.record, member] });
  const { handlers } = registered({ roomState: f.room, queueSecretary: f.role, sessionLabels: { labels: new Map() }, queueRules: require('../queue-dispatch.cjs') });
  f.role.set({ sessionId: f.sender.id, nativeId: f.sender.nativeId });
  const controller = new BackgroundControl({ dataDir: f.dir, handlers, context: () => f.c });
  const binding = { sender: { id: f.sender.id, nativeId: f.sender.nativeId, provider: 'codex', name: 'Secretary' }, identity: { callId: 'native-call', turnId: 'native-turn' }, valid: () => true };
  const receipt = await controller.call(binding, { action: 'invoke', method: 'spaceAction', arguments: ['shared', 'queueAdd', ['Work for a lookalike', LOOKALIKE]], operation_id: 'lookalike' });
  assert.equal(receipt.state, 'unconfirmed');
  assert.match(receipt.error, /没有加进队列/);
  assert.ok(receipt.error.includes(`Builder · ${MEMBER}`), receipt.error);
  assert.equal(f.room.queueItems().length, 0);
  const accepted = await controller.call(binding, { action: 'invoke', method: 'spaceAction', arguments: ['shared', 'queueAdd', ['Work for the member', MEMBER]], operation_id: 'member' });
  assert.equal(accepted.state, 'complete');
  assert.deepEqual(f.room.queueItems().map(item => item.assignee), [MEMBER]);
  await controller.close();
});
