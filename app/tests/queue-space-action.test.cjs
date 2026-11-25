const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { uiError } = require('../ui-errors.cjs');
const os = require('node:os');
const { RoomState } = require('../room-state.cjs');
const { SpaceManagers, refusedSpace } = require('../space-managers.cjs');
const { author: queueAuthor, usableRecord } = require('../queue-secretary.cjs');
const { roomIds, isMember, roomId: validRoomId } = require('../collaboration-spaces.cjs');
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
    queueWithdraw(...args) {
      calls.push(['queueWithdraw', ...args]);
    },
    queueResolve(...args) {
      calls.push(['queueResolve', ...args]);
    },
    queueClaim(...args) {
      calls.push(['queueClaim', ...args]);
    },
  };
  const context = vm.createContext({
    require: require('node:module').createRequire(path.join(__dirname, '../main.cjs')),
    register(name, fn) {
      handler = fn;
    },
    validRoomId: () => true,
    roomIds: require('../collaboration-spaces.cjs').roomIds,
    uiError,
    roomState,
    broadcastRoom: async () => {},
    queueDispatcher: { schedule() {} },
    backgroundOperation,
    spaceManagers: { creator() { throw uiError('error.queue.managerOnly'); } },
    queueAuthor,
    sessionLabels: { labels: new Map() },
    stewardCaller: async () => null,
    ...extra,
  });
  vm.runInContext(source.slice(start, end), context);
  return { handler, calls };
}

test('an ordinary agent cannot add or resolve, and its cancel is only ever a withdrawal of its own item', async () => {
  const { handler, calls } = spaceAction();
  const refusal = { queueAdd: 'error.queue.managerOnly', queueCancel: 'error.queue.withdrawOwnOnly', queueResolve: 'error.queue.personOnly', queueClaim: 'error.queue.claimOwnOnly' };
  for (const action of ['queueAdd', 'queueCancel', 'queueResolve', 'queueClaim']) {
    await assert.rejects(handler({ background: true, client: { call: async () => ({ sessions: [] }) } }, 'shared', action, ['x', null]), error => error.uiMessage?.key === refusal[action], action);
  }
  assert.deepEqual(calls, []);
});

test('the person\'s window adds, resolves and cancels queue items', async () => {
  const { handler, calls } = spaceAction();
  assert.equal(await handler({}, 'shared', 'queueAdd', ['task', null]), 'item-1');
  await handler({}, 'shared', 'queueResolve', ['item-1']);
  await handler({}, 'shared', 'queueCancel', ['item-1']);
  // Claiming is a session's own, for itself: the person's window has no session of its own to claim for.
  await assert.rejects(handler({ client: { call: async () => { throw Error('no session list is read'); } } }, 'shared', 'queueClaim', ['item-1']), error => error.uiMessage?.key === 'error.queue.claimOwnOnly');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['queueAdd', 'task', null, 'shared', { kind: 'person', name: 'You', sessionId: null }, null], ['queueResolve', 'item-1', 'shared', null], ['queueCancel', 'item-1', 'shared', null]]);
});

// Exercise the real register wrapper as well as its handler. Queue metadata is
// local even when an unrelated retained backend lacks backgroundControlV1.
function registered(extra) {
  const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  const handlers = new Map(), ipc = new Map();
  const context = vm.createContext({
    require: require('node:module').createRequire(path.join(__dirname, '../main.cjs')),
    applicationHandlers: handlers, backgroundOperation, uiError,
    ipcMain: { handle: (name, handler) => ipc.set(name, handler) },
    path, randomUUID: () => 'generated', validRoomId, roomIds, isMember, usableRecord, queueAuthor, refusedSpace, broadcastRoom: async () => {},
    isCurrentHumanContext: c => c.background !== true, midRotation: () => false, stewardOf: () => null, assertNativeCreation() {},
    displayText: (key, params) => require('../ui-locale.js').format('zh', key, params),
    creationDefaults: { get: () => ({ repository: null, directory: '/synthetic/project' }) },
    queueDispatcher: { schedule() {}, handingOver: () => false }, stewardCaller: async () => null, ...extra,
  });
  const start = source.indexOf('function register(name, handler) {');
  vm.runInContext(source.slice(start, source.indexOf('async function replaceBackendSockets', start)), context);
  for (const [first, last] of [["function isStewardActor(", "// Whether the butler reads another"], ["async function designateManager(", "// A background window's own state that"], ["  register('spaceMerge',", "  register('spaceAction',"],
    ["  register('spaceAction',", "  register('spaceFiles',"], ["  register('spaceManager',", "  // Designating or revoking the integrator"]]) {
    const a = source.indexOf(first), b = source.indexOf(last, a);
    if (a !== -1) vm.runInContext(source.slice(a, b), context);
  }
  vm.runInContext("register('send', () => 'should require backend support');", context);
  return { handlers, ipc, context };
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-manager-action-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const managers = new SpaceManagers(dir), room = new RoomState(dir);
  const sender = { id: 'manager', nativeId: 'native-manager', name: 'Manager', provider: 'codex', turnId: 'turn', callId: 'call', operationId: 'op' };
  const record = { id: sender.id, nativeId: sender.nativeId, name: 'Manager', state: 'idle', roomIds: ['shared'] };
  const client = { call: async () => ({ sessions: [record] }), entries: [{ state: { sessions: [{ id: 'old' }], capabilities: [] } }], refresh: async () => {}, close() {}, snapshot: () => ({ wakePolicy: { enabled: true }, sessions: [{ id: 'old' }] }) };
  const c = { background: true, actor: sender, client, view: { selected: sender.id }, win: { destroy() {} }, checkActor: async () => {} };
  const { handlers, ipc } = registered({ roomState: room, spaceManagers: managers, sessionLabels: { labels: new Map() } });
  const designate = (value = { sessionId: sender.id, nativeId: sender.nativeId }) => managers.set('shared', value);
  const invoke = (name, args, actor = sender, context = c) => backgroundOperation.run(actor, () => handlers.get(name)(context, ...args), { context, valid: async () => {} });
  return { dir, managers, designate, room, sender, record, c, handlers, ipc, invoke };
}
test("actual background entry accepts only the space's project manager, stores provenance, and lets the person cancel", async t => {
  const f = fixture(t);
  f.designate();
  const id = await f.invoke('spaceAction', ['shared', 'queueAdd', ['task from the person', null, { kind: 'person', name: 'spoof', sessionId: null }]]);
  assert.deepEqual(f.room.queueItems()[0].creator, { kind: 'secretary', name: 'Manager', sessionId: 'manager' });
  assert.equal(f.room.queueItems()[0].id, id);
  const event = f.room.value.events.at(-1);
  assert.equal(event.uiMessage.key, 'notice.queue.addedBySecretary');
  assert.equal(event.uiMessage.params.sessionId, f.sender.id);
  await assert.rejects(f.invoke('spaceAction', ['shared', 'queueResolve', [id]]), error => error.uiMessage?.key === 'error.queue.personOnly');
  await f.handlers.get('spaceAction')({}, 'shared', 'queueCancel', [id]);
  assert.equal(f.room.queueItems()[0].status, 'cancelled');
  await assert.rejects(f.invoke('spaceAction', ['shared', 'queueAdd', ['other', null]], { ...f.sender, id: 'other' }), error => error.uiMessage?.key === 'error.queue.managerOnly');
  f.designate(null);
  await assert.rejects(f.invoke('spaceAction', ['shared', 'queueAdd', ['revoked', null]]), error => error.uiMessage?.key === 'error.queue.managerOnly');
  await assert.rejects(f.handlers.get('spaceAction')(f.c, 'shared', 'queueAdd', ['no native proof', null]), /originating operation/);
  assert.equal(f.room.queueItems().length, 1);
});
test('only the person designates/revokes, and a member of that space; unrelated old backends still gate native input', async t => {
  const f = fixture(t), person = { client: f.c.client }, set = f.handlers.get('spaceManager'), key = value => error => error.uiMessage?.key === value;
  await set(person, 'shared', 'manager');
  assert.deepEqual(f.managers.current('shared'), { sessionId: 'manager', nativeId: 'native-manager' });
  assert.deepEqual([f.room.value.events.at(-1).uiMessage.key, f.room.value.events.at(-1).sessionId], ['notice.room.managerSet', 'manager']);
  for (const id of [null, 'manager', { create: true }]) await assert.rejects(f.invoke('spaceManager', ['shared', id]), key('error.manager.personOnly'));
  await set(person, 'shared', null);
  assert.equal(f.managers.current('shared'), null);
  const cleared = f.room.value.events.length;
  assert.equal(f.room.value.events.at(-1).uiMessage.key, 'notice.room.managerCleared');
  await set(person, 'shared', null);
  assert.equal(f.room.value.events.length, cleared, 'nothing to revoke leaves no record');
  await assert.rejects(f.invoke('send', ['old', 'text']), /adopt background-control support/);
  for (const bad of ['missing', 7, {}, ['manager']]) await assert.rejects(set(person, 'shared', bad), key('error.manager.invalid'));
  for (const changes of [{ roomIds: [] }, { state: 'ended' }, { nativeContextPending: true }, { nativeId: null }]) {
    const kept = { ...f.record }; Object.assign(f.record, changes);
    await assert.rejects(set(person, 'shared', 'manager'), key('error.manager.invalid'), JSON.stringify(changes));
    Object.assign(f.record, kept);
  }
  assert.equal(f.managers.current('shared'), null);
});
test('a project manager adds to its own space only, and not while it is out of it', async t => {
  const f = fixture(t), add = roomId => f.invoke('spaceAction', [roomId, 'queueAdd', ['task', null]]), refused = error => error.uiMessage?.key === 'error.queue.managerOnly';
  const other = f.room.create('Another space');
  f.designate();
  await assert.rejects(add(other), refused);
  assert.equal(f.room.queueItems(other).length, 0);
  await add('shared');
  f.record.roomIds = [other];
  await assert.rejects(add('shared'), refused);
  await assert.rejects(add(other), refused);
  assert.equal(f.room.queueItems('shared').length, 1);
});
test("a project manager's item cannot be for itself or for another space's project manager", async t => {
  const f = fixture(t), member = { id: 'member', nativeId: 'native-member', name: 'Member', state: 'idle', roomIds: ['shared'] };
  const { handlers } = registered({ roomState: f.room, spaceManagers: f.managers, sessionLabels: { labels: new Map() }, queueRules: require('../queue-dispatch.cjs') });
  f.c.client.call = async () => ({ sessions: [f.record, member] });
  f.designate();
  const add = assignee => backgroundOperation.run(f.sender, () => handlers.get('spaceAction')(f.c, 'shared', 'queueAdd', ['task', assignee]), { context: f.c, valid: async () => {} });
  await assert.rejects(add('manager'), error => error.uiMessage?.key === 'error.queue.managerSelf');
  await add('member');
  assert.deepEqual(f.room.queueItems().map(item => item.assignee), ['member']);
});
test('the project manager of a new space is a Claude session with native defaults, sent nothing; a failure keeps what was made', async t => {
  const f = fixture(t), calls = [], space = f.room.create('Plans'), key = value => error => error.uiMessage?.key === value;
  const opened = { id: 'opened', nativeId: 'native-opened', name: '项目经理 · Plans', state: 'idle', roomIds: [] };
  let sessions = [f.record], fail = '';
  const client = { call: async (method, ...args) => {
    calls.push([method, ...args]);
    if (method === 'initial') return { sessions, newWorkspaceRoot: '/synthetic/sessions' };
    if (method === 'create') { if (fail === 'create') throw uiError('error.manager.changed'); sessions = [f.record, opened]; return 'opened'; }
    throw Error('unexpected ' + method);
  } };
  f.room.membership = async (_client, id, join, _label, roomId) => { calls.push(['join', id, join, roomId]); if (fail === 'join') throw uiError('error.main.invalidSpace'); opened.roomIds = [roomId]; };
  const set = f.handlers.get('spaceManager'), person = { client };
  assert.equal(await set(person, space, { create: true }), 'opened');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(call => call[0] !== 'initial'))), [['create', { provider: 'claude', view: 'chat', name: '项目经理 · Plans', cwd: '/synthetic/project' }], ['join', 'opened', true, space]]);
  assert.deepEqual(f.managers.current(space), { sessionId: 'opened', nativeId: 'native-opened' });
  await assert.rejects(set(person, space, { create: true }), key('error.manager.changed'), 'one at a time');
  assert.equal(calls.filter(call => call[0] === 'create').length, 1);
  const second = f.room.create('Other'); fail = 'join';
  await assert.rejects(set(person, second, { create: true }), key('error.manager.partial'));
  assert.equal(f.managers.current(second), null);
  fail = 'create';
  await assert.rejects(set(person, second, { create: true }), key('error.manager.changed'));
  fail = '';
  const creates = () => calls.filter(call => call[0] === 'create').length, before = creates();
  const both = await Promise.allSettled([set(person, second, { create: true }), set(person, second, { create: true })]);
  assert.deepEqual(both.map(result => result.status), ['fulfilled', 'rejected'], 'a second press while one is being opened opens no other');
  assert.equal(creates(), before + 1);
});
test('a member the person chose while a new project manager was being opened stays the manager', async t => {
  const f = fixture(t), space = f.room.create('Plans'), chosen = { sessionId: 'manager', nativeId: 'native-manager' };
  const opened = { id: 'opened', nativeId: 'native-opened', name: 'Opened', state: 'idle', roomIds: [space] };
  let sessions = [f.record];
  f.room.membership = async () => {};
  const client = { call: async method => {
    if (method === 'create') {
      sessions = [{ ...f.record, roomIds: [space] }, opened];
      f.managers.set(space, chosen);
      return 'opened';
    }
    return { sessions, newWorkspaceRoot: '/synthetic/sessions' };
  } };
  await assert.rejects(f.handlers.get('spaceManager')({ client }, space, { create: true }), error => error.uiMessage?.key === 'error.manager.partial');
  assert.deepEqual(f.managers.current(space), chosen);
});
test('neither the butler nor a session being replaced by its successor can be made project manager', async t => {
  const f = fixture(t), person = { client: f.c.client };
  for (const extra of [{ midRotation: id => id === 'manager' }, { stewardOf: () => ({ sessionId: 'manager', nativeId: 'native-manager' }) }]) {
    const { handlers } = registered({ roomState: f.room, spaceManagers: f.managers, sessionLabels: { labels: new Map() }, ...extra });
    await assert.rejects(handlers.get('spaceManager')(person, 'shared', 'manager'), error => error.uiMessage?.key === 'error.manager.invalid');
    assert.equal(f.managers.current('shared'), null);
  }
});

test('the actual authenticated background controller adds once without confirmation and retains its native sender', async t => {
  const f = fixture(t);
  f.designate();
  const controller = new BackgroundControl({ dataDir: f.dir, handlers: f.handlers, context: () => f.c });
  const binding = { sender: { id: f.sender.id, nativeId: f.sender.nativeId, provider: 'codex', name: 'Manager' }, identity: { callId: 'native-call', turnId: 'native-turn' }, valid: () => true };
  const command = { action: 'invoke', method: 'spaceAction', arguments: ['shared', 'queueAdd', ['A request from the person', null]], operation_id: 'intake-one' };
  const receipt = await controller.call(binding, command);
  assert.equal(receipt.state, 'complete');
  assert.equal(receipt.actor.id, f.sender.id);
  assert.equal(receipt.confirmation, undefined);
  assert.equal(f.room.queueItems().length, 1);
  assert.equal((await controller.call(binding, command)).duplicate, true);
  assert.equal(f.room.queueItems().length, 1, 'an uncertain caller must read its existing operation instead of creating a duplicate');
  f.designate(null);
  const refusal = await controller.call(binding, { ...command, operation_id: 'intake-revoked' });
  assert.equal(refusal.state, 'unconfirmed');
  assert.equal(f.room.queueItems().length, 1);
  await controller.close();
});

test('without a folder of the last new session, the new project manager gets a folder of its own', async t => {
  const f = fixture(t), space = f.room.create('Plans'), created = [];
  const { handlers } = registered({ roomState: f.room, spaceManagers: f.managers, sessionLabels: { labels: new Map() }, creationDefaults: { get: () => ({ repository: null, directory: null }) } });
  f.room.membership = async () => { throw uiError('error.main.invalidSpace'); };
  const client = { call: async (method, options) => {
    if (method === 'initial') return { sessions: [], newWorkspaceRoot: '/synthetic/sessions' };
    created.push(options);
    return 'opened';
  } };
  await assert.rejects(handlers.get('spaceManager')({ client }, space, { create: true }), error => error.uiMessage?.key === 'error.manager.partial');
  assert.deepEqual(JSON.parse(JSON.stringify(created)), [{ provider: 'claude', view: 'chat', name: '项目经理 · Plans', cwd: '/synthetic/sessions/generated', newDirectory: true }]);
});
test('the former secretary becomes the manager of its space once its session is listed, and the space says so; once', async t => {
  const f = fixture(t), secretary = { sessionId: 'manager', nativeId: 'native-manager' };
  const { context } = registered({ roomState: f.room, spaceManagers: f.managers, queueSecretary: { current: () => secretary }, sessionLabels: { labels: new Map([['manager', 'Trusted label']]) } });
  const events = () => f.room.value.events.filter(event => event.kind === 'manager');
  const again = () => vm.runInContext('retireSecretaryAt = 0', context);
  await context.retireSecretary({ sessions: [], room: {}, rooms: [{ id: 'shared' }] });
  assert.deepEqual([f.managers.secretaryRetired, events().length], [null, 0], 'its backend has not answered yet');
  const snapshot = { sessions: [f.record], rooms: [{ id: 'shared' }] };
  await context.retireSecretary(snapshot);
  assert.equal(f.managers.secretaryRetired, null, 'not looked at with every state');
  const wait = vm.runInContext('retireSecretaryAt', context) - Date.now();
  assert.ok(wait > 0 && wait <= 10000);
  again();
  await context.retireSecretary(snapshot);
  assert.deepEqual(f.managers.current('shared'), secretary);
  assert.deepEqual(events().map(event => [event.uiMessage.key, event.uiMessage.params.name, event.sessionId]), [['notice.room.managerFromSecretary', 'Trusted label', 'manager']]);
  f.managers.set('shared', null);
  again();
  await context.retireSecretary(snapshot);
  assert.equal(f.managers.current('shared'), null, 'what the person revoked is not brought back');
  assert.equal(events().length, 1);
  assert.equal(new RoomState(f.dir).value.events.filter(event => event.kind === 'manager').length, 1, 'the record is kept');
});
test('a space record that cannot be written does not undo the role, nor the former secretary\'s', async t => {
  const f = fixture(t), person = { client: f.c.client }, secretary = { sessionId: 'manager', nativeId: 'native-manager' };
  f.room.noteManager = () => { throw Error('full'); };
  await f.handlers.get('spaceManager')(person, 'shared', 'manager');
  assert.deepEqual(f.managers.current('shared'), secretary);
  await f.handlers.get('spaceManager')(person, 'shared', null);
  assert.equal(f.managers.current('shared'), null);
  const managers = new SpaceManagers(fixture(t).dir);
  const { context } = registered({ roomState: f.room, spaceManagers: managers, queueSecretary: { current: () => secretary }, sessionLabels: { labels: new Map() } });
  await context.retireSecretary({ sessions: [f.record], rooms: [{ id: 'shared' }] });
  assert.deepEqual(managers.current('shared'), secretary);
});
test('over a record that cannot be read, a project manager is set only once the person agrees to start over', async t => {
  const f = fixture(t), person = { client: f.c.client }, shown = [];
  f.managers.set('22222222-2222-4222-8222-222222222222', { sessionId: 'other', nativeId: 'native-other' });
  fs.writeFileSync(f.managers.file, '{broken', { mode: 0o600 });
  const managers = new SpaceManagers(f.dir);
  let response = 0;
  const { handlers } = registered({ roomState: f.room, spaceManagers: managers, sessionLabels: { labels: new Map() },
    showDialog: async (c, kind, options) => { assert.equal(c, person); shown.push(options); return { response }; } });
  const set = choice => handlers.get('spaceManager')(person, 'shared', choice);
  for (const choice of ['manager', null]) await set(choice);
  assert.equal(shown.length, 2);
  const text = fs.readFileSync(managers.file, 'utf8');
  fs.writeFileSync(managers.file, JSON.stringify({ version: 1, managers: {}, secretaryRetired: null }));
  await set(null);
  assert.deepEqual([shown.length, managers.failed], [2, false], 'read again before asking');
  fs.writeFileSync(managers.file, text);
  managers.read();
  assert.deepEqual([shown[0].cancelId, shown[0].defaultId, shown[0].buttons.length], [0, 0, 2]);
  assert.match(shown[0].detail, /别的空间的项目经理要再设一遍/u);
  assert.equal(managers.failed, true);
  assert.equal(fs.readFileSync(managers.file, 'utf8'), '{broken', 'cancelled: nothing is written');
  response = 1;
  await set('manager');
  assert.deepEqual(managers.current('shared'), { sessionId: 'manager', nativeId: 'native-manager' });
  await set(null);
  assert.equal(shown.length, 3, 'a record that is read asks nothing');
  assert.equal(managers.current('shared'), null);
});
test('a manager handing over counts as one until its successor does', t => {
  const f = fixture(t), over = new Set();
  f.designate();
  const { context } = registered({ roomState: f.room, spaceManagers: f.managers, sessionLabels: { labels: new Map() },
    queueDispatcher: { schedule() {}, handingOver: (id, roomId) => roomId === 'shared' && over.has(id) } });
  const active = record => Object.keys(context.activeManagers([record]));
  assert.deepEqual(active(f.record), ['shared']);
  assert.deepEqual(active({ ...f.record, roomIds: [] }), []);
  over.add('manager');
  assert.deepEqual(active({ ...f.record, roomIds: [] }), ['shared']);
  assert.deepEqual(active({ ...f.record, id: 'someone', roomIds: [] }), []);
});
// R162 (the person, 2026-11-23): 「保证不会让项目经理被其他空间的任务干扰」. The same limit as a workspace message's.
test("no shared input of another space's agent reaches a project manager; its own space's and the person's do", async t => {
  const f = fixture(t), B = '22222222-2222-4222-8222-222222222222';
  f.designate();
  const row = (id, rooms) => ({ id, nativeId: 'native-' + id, name: 'Session ' + id, state: 'idle', roomIds: rooms });
  let sessions = [f.record, row('worker', ['shared']), row('outside', [B]), row('alone', []), row('both', ['shared', B]), row('target', ['shared'])];
  f.c.client.snapshot = () => ({ wakePolicy: { enabled: true }, sessions });
  f.c.client.entries = [{ state: { sessions, capabilities: [backgroundOperation.CAPABILITY] } }];
  const reached = [], { handlers, context } = registered({ roomState: f.room, spaceManagers: f.managers, sessionLabels: { labels: new Map([['manager', 'Space lead']]) } });
  context.reached = reached;
  const direct = ['send', 'queue', 'steer'], shared = ['forward', 'queueShared', 'steerShared', 'run'];
  for (const name of [...direct, 'input', 'spaceAction']) vm.runInContext(`register('${name}', (c, ...args) => { reached.push(args); })`, context);
  const call = (from, name, args, request = {}) => {
    const actor = { ...f.sender, id: from, nativeId: 'native-' + from, name: from };
    const c = { ...f.c, actor };
    return backgroundOperation.run(actor, () => handlers.get(name)(c, ...args), { context: c, valid: async () => {}, ...request });
  };
  const ways = [...direct.map(name => [name, to => [to, 'text']]), ['input', to => [to, 'text']],
    ...shared.map(name => ['spaceAction', to => ['shared', name, [name === 'run' ? ['target', to] : to, 'text']]])];
  const refused = error => error.uiMessage?.key === 'error.wake.managerSpace' && error.uiMessage.params.name === 'Space lead';
  for (const [name, args] of ways) {
    const label = name + ' ' + args('manager')[1];
    reached.length = 0;
    await assert.rejects(call('outside', name, args('manager')), refused, label);
    assert.deepEqual(reached, [], label);
    for (const from of ['worker', 'alone', 'both']) await call(from, name, args('manager'));
    await call('outside', name, args('worker'));
    await call('manager', name, args('manager'));
    assert.equal(reached.length, 5, label);
    await call('outside', name, args('manager'), { maintenanceApproved: true });
    assert.equal(reached.length, 6, 'what the person confirmed is theirs');
  }
  // Its own row is not here: which spaces it is in is unknown.
  sessions = sessions.filter(entry => entry.id !== 'worker');
  await assert.rejects(call('worker', 'send', ['manager', 'text']), refused);
  await call('worker', 'send', ['target', 'text']);
  // Nor is the same session in another native context itself.
  sessions = [...sessions, { ...row('worker', ['shared']), nativeId: 'another' }];
  await assert.rejects(call('worker', 'send', ['manager', 'text']), refused);
  fs.writeFileSync(f.managers.file, '{broken', { mode: 0o600 });
  const broken = registered({ roomState: f.room, spaceManagers: new SpaceManagers(f.dir), sessionLabels: { labels: new Map() } });
  const send = (from, to) => {
    const actor = { ...f.sender, id: from, nativeId: 'native-' + from, name: from }, c = { ...f.c, actor };
    return backgroundOperation.run(actor, () => broken.handlers.get('send')(c, to, 'text'), { context: c, valid: async () => {} });
  };
  const unknown = error => error.uiMessage?.key === 'error.manager.state';
  await assert.rejects(send('outside', 'target'), unknown);
  await send('both', 'target');
  await send('alone', 'target');
  await send('outside', 'alone');
});
test("a project manager's agent cannot read other spaces through a merge preview", async t => {
  const f = fixture(t), calls = [], roomState = f.room;
  roomState.mergePreview = () => { calls.push('preview'); return 'shown'; };
  roomState.mergeStatus = () => { calls.push('status'); return 'shown'; };
  const { handlers } = registered({ roomState, spaceManagers: f.managers, sessionLabels: { labels: new Map() }, hasSavedSpaceDraft: () => false, views: [] });
  f.c.client.snapshot = () => ({ sessions: [f.record] });
  const value = Object.assign(Object.create(null), { operationId: '33333333-3333-4333-8333-333333333333' });
  const merge = action => backgroundOperation.run(f.sender, () => handlers.get('spaceMerge')(f.c, action, value), { context: f.c, valid: async () => {} });
  f.c.client.entries = [{ state: { sessions: [], capabilities: [backgroundOperation.CAPABILITY] } }];
  assert.equal(await merge('preview'), 'shown');
  f.designate();
  for (const action of ['preview', 'status', 'discard', 'commit', 'undo']) await assert.rejects(merge(action), error => error.uiMessage?.key === 'error.background.spaceContent', action);
  assert.deepEqual(calls, ['preview']);
  assert.equal(await handlers.get('spaceMerge')({ client: f.c.client }, 'status', value), 'shown', 'the person still can');
});
test('a session the person archived cannot be made project manager, and an archived one can no longer add to the queue', async t => {
  const f = fixture(t);
  // The backend the space record archives through: it knows the session, and never marks it archived.
  const backend = { call: async method => {
    if (method === 'join') f.record.roomIds = [];
    return method === 'initial' ? { sessions: [f.record] } : undefined;
  }, snapshot: () => ({ sessions: [f.record] }), entries: f.c.client.entries, refresh: async () => {}, close() {} };
  await f.handlers.get('spaceManager')({ client: f.c.client }, 'shared', 'manager');
  const first = await f.invoke('spaceAction', ['shared', 'queueAdd', ['before the archive', null]]);
  assert.equal(f.room.queueItems().length, 1);
  await f.room.archiveSession(backend, 'manager', 'Manager');
  assert.deepEqual(f.room.value.archivedSessions, ['manager']);
  f.record.roomIds = ['shared'];
  assert.equal((await f.c.client.call('initial')).sessions[0].archived, undefined, 'Only the desktop\'s own record says it is archived');
  // The designation is still recorded, but the archived session no longer acts as project manager.
  assert.deepEqual(f.managers.current('shared'), { sessionId: 'manager', nativeId: 'native-manager' });
  await assert.rejects(f.invoke('spaceAction', ['shared', 'queueAdd', ['after the archive', null]]), error => error.uiMessage?.key === 'error.queue.managerOnly');
  assert.deepEqual(f.room.queueItems().map(item => item.id), [first]);
  // It cannot be designated again while archived; the person can still revoke it, and add tasks themselves.
  await assert.rejects(f.handlers.get('spaceManager')({ client: f.c.client }, 'shared', 'manager'), error => error.uiMessage?.key === 'error.manager.invalid');
  await f.handlers.get('spaceManager')({}, 'shared', null);
  assert.equal(f.managers.current('shared'), null);
  await assert.rejects(f.handlers.get('spaceManager')({ client: f.c.client }, 'shared', 'manager'), error => error.uiMessage?.key === 'error.manager.invalid');
  assert.equal(f.managers.current('shared'), null);
  await f.handlers.get('spaceAction')({}, 'shared', 'queueAdd', ['the person adds one', null]);
  assert.equal(f.room.queueItems().length, 2);
  // Restored, it can be designated and add again.
  await f.room.restoreSession(backend, 'manager', 'Manager');
  await f.handlers.get('spaceManager')({ client: f.c.client }, 'shared', 'manager');
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
  let steward = { sessionId: 'butler', nativeId: 'native-butler' }, managed = () => null, designated = record => managed(record);
  const context = vm.createContext({ stewardOf: () => { if (steward instanceof Error) throw steward; return steward; }, spaceManagers: { roomOf: record => managed(record), designated: record => designated(record) },
    roomState: { value: { archivedSessions: [] }, spaces: { rooms: [{ id: 'web' }, { id: 'empty' }] } }, roomIds: s => s.roomIds });
  vm.runInContext(source.slice(start, end), context);
  const snapshot = { room: { id: 'shared' }, rooms: [{ id: 'shared' }, { id: 'web' }, { id: 'docs' }], sessions: [
    { id: 'butler', nativeId: 'native-butler', roomIds: [] }, { id: 'member', nativeId: 'native-member', roomIds: ['web'] }] };
  const access = actor => JSON.parse(JSON.stringify(context.conversationAccess(actor, snapshot)));
  const butler = { id: 'butler', nativeId: 'native-butler' }, member = { id: 'member', nativeId: 'native-member' };
  assert.deepEqual(access(butler), { roomIds: ['shared', 'web', 'docs', 'empty'], metadataOnly: false, limit: null }, 'a space nobody joined yet included');
  assert.deepEqual(access(member), { roomIds: ['web'], metadataOnly: false, limit: null });
  snapshot.sessions[1].roomIds = ['web', 'docs']; managed = record => record?.id === 'member' ? 'web' : null;
  assert.deepEqual(access(member), { roomIds: ['web'], metadataOnly: false, limit: ['web'] }, "a project manager reads its own space only");
  assert.equal(context.conversationReaderAllowed(member), false);
  managed = () => { throw Error('unreadable'); };
  assert.deepEqual(access(member), { roomIds: ['web', 'docs'], metadataOnly: true, limit: ['web', 'docs'] }, 'an unreadable role reads metadata only, of its own spaces');
  snapshot.sessions.push({ id: 'alone', nativeId: 'native-alone', roomIds: [] });
  assert.deepEqual(access({ id: 'alone', nativeId: 'native-alone' }), { roomIds: [], metadataOnly: true, limit: null }, 'one in no space manages none');
  assert.deepEqual(access({ id: 'gone', nativeId: 'native-gone' }), { roomIds: [], metadataOnly: true, limit: [] }, 'nor is one whose own row is not here shown any');
  snapshot.sessions.pop();
  assert.deepEqual(access(butler), { roomIds: ['shared', 'web', 'docs', 'empty'], metadataOnly: false, limit: null }, 'the butler reads also then');
  assert.equal(context.conversationReaderAllowed(butler), true);
  steward = { sessionId: 'butler', nativeId: 'older-native' };
  assert.deepEqual(access(butler), { roomIds: [], metadataOnly: true, limit: null }, 'another native session of it is not the butler');
  managed = () => null; designated = record => record.id === 'gone' ? 'web' : null;
  assert.deepEqual(access({ id: 'gone', nativeId: 'native-gone' }), { roomIds: [], metadataOnly: false, limit: [] }, 'a manager whose own row is not here is shown no space');
  assert.deepEqual(access({ id: 'stranger', nativeId: 'native-stranger' }), { roomIds: [], metadataOnly: false, limit: null });
  designated = record => managed(record); managed = () => { throw Error('unreadable'); };
  steward = Error('unreadable'); assert.deepEqual(access(butler), { roomIds: [], metadataOnly: true, limit: null });
  // What the agent's view then holds: queue text and space content for every space.
  steward = { sessionId: 'butler', nativeId: 'native-butler' }; managed = () => null; snapshot.sessions[1].roomIds = ['web'];
  const rotation = { kind: 'rotation', rotationReason: { sessionId: 'member', reason: 'refresh-failed' } };
  const value = { sessions: snapshot.sessions, room: { id: 'shared' }, rooms: [{ id: 'web', name: 'Web', notes: 'N', events: [rotation], queue: [{ id: 'q', status: 'queued', text: 'Fix it', assignee: null, createdAt: 1 }] }] };
  const view = backgroundOperation.conversationSnapshot(value, { ...butler, name: 'B', provider: 'claude' }, null, undefined, context.conversationAccess(butler, snapshot));
  assert.deepEqual([view.rooms[0].notes, view.rooms[0].queue[0].text], ['N', 'Fix it']);
  assert.deepEqual(view.rooms[0].events[0], rotation, 'The real butler access path includes structured rotation reasons');
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
  const { handlers } = registered({ roomState: f.room, spaceManagers: f.managers, sessionLabels: { labels: new Map() }, queueRules: require('../queue-dispatch.cjs') });
  f.designate();
  const controller = new BackgroundControl({ dataDir: f.dir, handlers, context: () => f.c });
  const binding = { sender: { id: f.sender.id, nativeId: f.sender.nativeId, provider: 'codex', name: 'Manager' }, identity: { callId: 'native-call', turnId: 'native-turn' }, valid: () => true };
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

// The person, 11-12 21:1x, 「可以」 to: 秘书/放入者可撤回自己放进队列、尚未派出的条目；别人放的、已派出的、「已处理」照旧只有人能点。
test('a session takes back an item it queued itself while it is still queued, and nothing else', async t => {
  const f = fixture(t);
  const other = { id: 'other', nativeId: 'native-other', name: 'Other', provider: 'claude', turnId: 'turn', callId: 'call', operationId: 'op' };
  const sessions = [f.record, { id: 'other', nativeId: 'native-other', name: 'Other', state: 'idle' }];
  f.c.client.call = async () => ({ sessions });
  f.designate();
  const add = text => f.invoke('spaceAction', ['shared', 'queueAdd', [text, null]]);
  const withdraw = (id, actor = f.sender) => f.invoke('spaceAction', ['shared', 'queueCancel', [id]], actor);
  const own = await add('own, still queued'), sent = await add('own, already sent'), later = await add('own, after the role ended');
  const mismatch = await add('own, called from another native session');
  const persons = await f.handlers.get('spaceAction')({}, 'shared', 'queueAdd', ['the person\'s', null]);
  const status = id => f.room.queueFind('shared', id).status;
  const refused = key => error => error.uiMessage?.key === key;
  // Someone else's: another session's, and the person's.
  await assert.rejects(withdraw(own, other), refused('error.queue.withdrawOwnOnly'));
  await assert.rejects(withdraw(persons), refused('error.queue.withdrawOwnOnly'));
  // Its own, still queued: taken back, said to be its own doing, in the form older builds read.
  await withdraw(own);
  assert.equal(status(own), 'cancelled');
  const event = f.room.value.events.at(-1).uiMessage;
  assert.deepEqual([event.key, event.params], ['notice.queue.withdrawn', { text: 'own, still queued', name: 'Manager', sessionId: 'manager' }]);
  const item = f.room.queueFind('shared', own);
  assert.equal(Object.hasOwn(item, 'finishedBy'), false);
  assert.deepEqual(item.creator, { kind: 'secretary', name: 'Manager', sessionId: 'manager' });
  assert.doesNotThrow(() => require('../queue-dispatch.cjs').validateQueue(f.room.queueItems()));
  await assert.rejects(withdraw(own), refused('error.queue.notCancellable'));
  // Its own, already sent: the person's to handle.
  f.room.queueMarkSent('shared', sent, 'other', 'Other', Date.now());
  await assert.rejects(withdraw(sent), refused('error.queue.notCancellable'));
  assert.equal(status(sent), 'sent');
  // Marking handled stays the person's, also for its own item.
  await assert.rejects(f.invoke('spaceAction', ['shared', 'queueResolve', [later]]), refused('error.queue.personOnly'));
  // A call from a native session other than the one the person's record names now is refused, and so is the session once
  // ended. (The item keeps only the session id: if the record itself moves to a new native session, that one may withdraw.)
  await assert.rejects(withdraw(mismatch, { ...f.sender, nativeId: 'native-replacement' }), refused('error.queue.withdrawOwnOnly'));
  f.record.state = 'ended';
  await assert.rejects(withdraw(mismatch), refused('error.queue.withdrawOwnOnly'));
  f.record.state = 'idle';
  // No longer the manager, it still takes back what it added.
  f.designate(null);
  await withdraw(later);
  assert.equal(status(later), 'cancelled');
  assert.deepEqual([own, sent, later, mismatch, persons].map(status), ['cancelled', 'sent', 'cancelled', 'queued', 'queued']);
});
test('through the real background controller, a withdrawal needs no confirmation and a refused one changes nothing', async t => {
  const f = fixture(t);
  f.designate();
  const own = await f.invoke('spaceAction', ['shared', 'queueAdd', ['own', null]]);
  const persons = await f.handlers.get('spaceAction')({}, 'shared', 'queueAdd', ['the person\'s', null]);
  const controller = new BackgroundControl({ dataDir: f.dir, handlers: f.handlers, context: () => f.c });
  const binding = { sender: { id: f.sender.id, nativeId: f.sender.nativeId, provider: 'codex', name: 'Manager' }, identity: { callId: 'native-call', turnId: 'native-turn' }, valid: () => true };
  const call = (id, operation) => controller.call(binding, { action: 'invoke', method: 'spaceAction', arguments: ['shared', 'queueCancel', [id]], operation_id: operation });
  const refused = await call(persons, 'withdraw-persons');
  assert.equal(refused.state, 'unconfirmed');
  assert.match(refused.error, /只能撤回自己放进队列/);
  const taken = await call(own, 'withdraw-own');
  assert.equal(taken.state, 'complete');
  assert.equal(taken.confirmation, undefined);
  assert.deepEqual(f.room.queueItems().map(item => item.status), ['cancelled', 'queued']);
  await controller.close();
});

// Queue item 6897c6e3, part 1 (board 11-13 00:02:25/00:02:46): a member that took work from the board while the same
// item was queued for it claims the item, so that NAW does not send it the same work again. Nothing is sent; the item
// counts as sent to that member and settles by its reply. Not a cancel or a resolve: those stay as they are.
test('a session claims an item queued for it that it is already doing, and nothing else', async t => {
  const f = fixture(t);
  const other = { ...f.sender, id: 'other', nativeId: 'native-other', name: 'Other' };
  f.record.controlRevision = 3;
  f.record.messages = [{ id: 'earlier-input', role: 'user', text: 'an earlier turn', origin: 'human' }, { id: 'earlier', role: 'assistant', text: 'earlier work' },
    { id: 'turn-input', role: 'user', text: 'take the board task', origin: 'human' }, { id: 'working', role: 'assistant', text: 'on it' }];
  const sessions = [f.record, { id: 'other', nativeId: 'native-other', name: 'Other', state: 'idle' }];
  f.c.client.call = async () => ({ sessions });
  const add = (text, assignee) => f.room.queueAdd(text, assignee, 'shared');
  const own = add('board task', 'manager'), others = add('someone else\'s', 'other'), anyone = add('for any member', null);
  const sent = add('already sent', 'manager'), cancelled = add('cancelled', 'manager'), later = add('later', 'manager');
  f.room.queueMarkSent('shared', sent, 'manager', 'Manager', Date.now());
  f.room.queueCancel(cancelled, 'shared');
  const claim = (id, actor = f.sender) => f.invoke('spaceAction', ['shared', 'queueClaim', [id]], actor);
  const refused = key => error => error.uiMessage?.key === key;
  const status = id => f.room.queueFind('shared', id).status;
  // Queued for another member, for any member, or called by another session: not its own.
  await assert.rejects(claim(others), refused('error.queue.claimOwnOnly'));
  await assert.rejects(claim(anyone), refused('error.queue.claimOwnOnly'));
  await assert.rejects(claim(own, other), refused('error.queue.claimOwnOnly'));
  await assert.rejects(claim(own, { ...f.sender, nativeId: 'native-replacement' }), refused('error.queue.claimOwnOnly'));
  // Its own, but no longer queued.
  await assert.rejects(claim(sent), refused('error.queue.notQueued'));
  await assert.rejects(claim(cancelled), refused('error.queue.notQueued'));
  assert.deepEqual([own, others, anyone, sent, cancelled, later].map(status), ['queued', 'queued', 'queued', 'sent', 'cancelled', 'queued']);
  // Its own and queued, but the item NAW sent it has not settled: both would settle on the same reply.
  await assert.rejects(claim(own), refused('error.queue.claimBusy'));
  assert.equal(status(own), 'queued');
  f.room.queueSettle('shared', sent, 'done', '', 'Secretary', 'finished');
  const events = f.room.value.events.length;
  // Its own, queued: sent to it now, under the input its turn began with and its control revision now.
  const before = Date.now();
  await claim(own);
  const item = f.room.queueFind('shared', own);
  assert.deepEqual([item.status, item.sentTo, item.tag, item.control], ['sent', 'manager', 'turn-input', 3]);
  assert.ok(item.sentAt >= before && item.sentAt <= Date.now());
  assert.equal(Object.hasOwn(item, 'finishedBy') || Object.hasOwn(item, 'finishedAt'), false);
  assert.equal(f.room.value.events.length, events + 1);
  const event = f.room.value.events.at(-1);
  assert.deepEqual([event.sessionId, event.uiMessage.key, event.uiMessage.params], ['manager', 'notice.queue.claimed', { text: 'board task', name: 'Manager', sessionId: 'manager' }]);
  assert.doesNotThrow(() => require('../queue-dispatch.cjs').validateQueue(f.room.queueItems()));
  await assert.rejects(claim(own), refused('error.queue.notQueued'));
  await assert.rejects(claim(later), refused('error.queue.claimBusy'));
  f.room.queueSettle('shared', own, 'done', '', 'Secretary', 'board task done');
  // With no input on its record, the reply is what follows the time of the claim.
  f.record.messages = [];
  await claim(later);
  assert.equal(f.room.queueFind('shared', later).tag, `claimed:${later}`);
  assert.deepEqual([own, others, anyone, sent, cancelled, later].map(status), ['done', 'queued', 'queued', 'done', 'cancelled', 'sent']);
});
test('through the real background controller, a claim needs no confirmation and a refused one changes nothing', async t => {
  const f = fixture(t);
  f.record.messages = [{ id: 'turn-input', role: 'user', text: 'take the board task', origin: 'human' }];
  const own = f.room.queueAdd('own', 'manager', 'shared'), persons = f.room.queueAdd('the person\'s, for any member', null, 'shared');
  const controller = new BackgroundControl({ dataDir: f.dir, handlers: f.handlers, context: () => f.c });
  const binding = { sender: { id: f.sender.id, nativeId: f.sender.nativeId, provider: 'codex', name: 'Manager' }, identity: { callId: 'native-call', turnId: 'native-turn' }, valid: () => true };
  const call = (id, operation) => controller.call(binding, { action: 'invoke', method: 'spaceAction', arguments: ['shared', 'queueClaim', [id]], operation_id: operation });
  const refused = await call(persons, 'claim-unassigned');
  assert.equal(refused.state, 'unconfirmed');
  assert.match(refused.error, /只能认领指给自己/);
  const taken = await call(own, 'claim-own');
  assert.equal(taken.state, 'complete');
  assert.equal(taken.confirmation, undefined);
  assert.deepEqual(f.room.queueItems().map(item => [item.status, item.tag ?? null]), [['sent', 'turn-input'], ['queued', null]]);
  await controller.close();
});

test('a live or failed rotation control cannot be claimed as a queued task', async t => {
  for (const state of ['open', 'invalid']) {
    const f = fixture(t); f.record.state = 'working';
    f.record.rotationEpisode = { nativeId: f.sender.nativeId, epoch: '00000000-0000-4000-8000-000000000001', state };
    f.record.messages = [{ id: 'control-tag', role: 'user', origin: 'naw-dispatch', dispatchItem: 'rotation:' + f.sender.id }];
    const id = f.room.queueAdd('Synthetic queued task', f.sender.id);
    await assert.rejects(f.invoke('spaceAction', ['shared', 'queueClaim', [id]]), error => error.uiMessage?.key === 'error.queue.claimBusy');
    assert.equal(f.room.queueFind('shared', id).status, 'queued');
  }
});

test('only the current person or designated butler can explicitly release an episode in its space',async()=>{
 const releases=[],session={id:'member',nativeId:'native',roomIds:['shared']};
 const extra={isCurrentHumanContext:c=>c.current===true,queueDispatcher:{releaseRotation:async(...args)=>{releases.push(args);return {state:'released'};}},stewardCaller:async c=>c.butler?{id:'butler-id'}:null};
 const {handler}=spaceAction(extra),client={call:async()=>({sessions:[session]})},args=['member','native','epoch','tag','discard-handoff'];
 await assert.rejects(handler({background:true,client},'shared','releaseRotation',args));
 await assert.rejects(handler({current:false,view:{owner:'window'},client},'shared','releaseRotation',args));
 await handler({current:true,view:{owner:'window'},client},'shared','releaseRotation',args);
 await handler({background:true,butler:true,client},'shared','releaseRotation',args);
 assert.deepEqual(JSON.parse(JSON.stringify(releases)),[['member','native','epoch','tag',{kind:'person',id:'window'},'discard-handoff'],['member','native','epoch','tag',{kind:'steward',id:'butler-id'},'discard-handoff']]);
 session.roomIds=['other'];await assert.rejects(handler({current:true,view:{owner:'window'},client},'shared','releaseRotation',args));assert.equal(releases.length,2);
});

test('a standalone session has the same person/steward release boundary without acquiring membership',async()=>{
 const releases=[],session={id:'outside',nativeId:'native',roomIds:[],roomId:null},args=['outside','native','epoch','tag','discard-handoff'];
 const {handler}=spaceAction({isCurrentHumanContext:c=>c.current===true,queueDispatcher:{releaseRotation:async(...x)=>{releases.push(x);return {state:'released'};}}});const client={call:async()=>({sessions:[session]})};
 await handler({current:true,view:{owner:'window'},client},'shared','releaseRotation',args);assert.equal(releases.length,1);assert.deepEqual(session.roomIds,[]);
 await assert.rejects(handler({background:true,client},'shared','releaseRotation',args));assert.equal(releases.length,1);
});
