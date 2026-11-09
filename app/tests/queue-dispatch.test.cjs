const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const rules = require('../queue-dispatch.cjs');
const { RoomState } = require('../room-state.cjs');

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const AWAKE = { enabled: true };

function member(id, extra = {}) {
  return {
    id,
    name: `Agent ${id}`,
    provider: 'claude',
    nativeId: `native-${id}`,
    model: 'claude-test-model',
    state: 'idle',
    roomIds: ['shared'],
    roomId: 'shared',
    createdAt: NOW - HOUR,
    background: 0,
    scheduled: 0,
    backgroundStale: false,
    chatAvailable: true,
    liveDraft: '',
    controlRevision: 0,
    serviceCapabilities: [rules.CAPABILITY],
    fleet: [],
    messages: [],
    ...extra,
  };
}

function item(id, extra = {}) {
  return { id, text: `task ${id}`, assignee: null, status: 'queued', createdAt: NOW - 1000, ...extra };
}

function settledSince(ids) {
  const idle = new Map();
  for (const id of ids) {
    idle.set(id, NOW - 60000);
  }
  return idle;
}

function plan(rooms, sessions, extra = {}) {
  const ids = [];
  for (const session of sessions) {
    ids.push(session.id);
  }
  return rules.planDispatch({
    rooms,
    sessions,
    wakePolicy: AWAKE,
    idleSince: settledSince(ids),
    now: NOW,
    ...extra,
  });
}

function sentItem(extra = {}) {
  return item('1', { status: 'sent', sentTo: 'a', sentAt: NOW - 30000, tag: 't1', control: 0, ...extra });
}

test('a queue rejects malformed items instead of guessing', () => {
  assert.deepEqual(rules.validateQueue(undefined), []);
  assert.equal(rules.validateQueue([item('a')]).length, 1);
  assert.throws(() => rules.validateQueue([item('a'), item('a')]), /Duplicate/);
  assert.throws(() => rules.validateQueue([item('a', { status: 'running' })]), /Invalid/);
  assert.throws(() => rules.validateQueue([item('a', { text: 'bad\u0007bell' })]), /Invalid/);
  assert.throws(() => rules.validateQueue([item('a', { attempts: -1 })]), /Invalid/);
  assert.throws(() => rules.newItem('   ', null), /Invalid/);
  const fresh = rules.newItem('line one\nline two', null, NOW);
  assert.equal(fresh.status, 'queued');
  assert.equal(fresh.assignee, null);
});

test('only a truly idle, unpaused member on an updated backend with no draft or background work is ready', () => {
  assert.equal(rules.sessionReady(member('a'), AWAKE).ready, true);
  const cases = [
    [member('a', { state: 'working' }), 'not-idle'],
    [member('a', { wakeDisabled: true }), 'paused'],
    [member('a', { liveDraft: 'half typed' }), 'person-typing'],
    [member('a', { background: 2 }), 'background-work'],
    [member('a', { backgroundStale: true }), 'background-unconfirmed'],
    [member('a', { pendingTag: 'tag' }), 'busy'],
    [member('a', { approval: { id: 1 } }), 'busy'],
    [member('a', { chatAvailable: false }), 'unavailable'],
    [member('a', { archived: true }), 'archived'],
    [member('a', { serviceCapabilities: ['collaborationSpacesV1'] }), 'backend-update-needed'],
    [member('a', { provider: 'codex', nativeGoal: { status: 'active' } }), 'native-goal-active'],
  ];
  for (const [session, reason] of cases) {
    assert.deepEqual(rules.sessionReady(session, AWAKE), { ready: false, reason });
  }
  assert.equal(rules.sessionReady(member('a'), { enabled: false }).reason, 'automatic-messages-off');
  const runningChild = member('a', { fleet: [{ event: 'SubagentStart', id: 'child', stale: false, time: NOW }] });
  assert.equal(rules.sessionReady(runningChild, AWAKE).reason, 'team-running');
  // A child record from before a restart is unknown, not running: it must not block forever.
  const staleChild = member('a', { fleet: [{ event: 'SubagentStart', id: 'child', stale: true, time: NOW }] });
  assert.equal(rules.sessionReady(staleChild, AWAKE).ready, true);
});

test('each idle member gets exactly one next item; an assigned item waits for its member', () => {
  const rooms = [{ id: 'shared', name: 'Team', memberOrder: ['a', 'b'], queue: [item('1'), item('2'), item('3', { assignee: 'b' })] }];
  assert.deepEqual(plan(rooms, [member('a'), member('b')]), [
    { kind: 'dispatch', roomId: 'shared', itemId: '1', sessionId: 'a' },
    { kind: 'dispatch', roomId: 'shared', itemId: '2', sessionId: 'b' },
  ]);
});

test('a member that just became idle, or that the person just used, is not sent anything', () => {
  const rooms = [{ id: 'shared', name: 'Team', queue: [item('1')] }];
  assert.deepEqual(plan(rooms, [member('a')], { idleSince: new Map([['a', NOW - 1000]]) }), []);
  assert.deepEqual(plan(rooms, [member('a')], { humanAt: new Map([['a', NOW - 30000]]) }), []);
  assert.equal(plan(rooms, [member('a')], { humanAt: new Map([['a', NOW - 5 * 60000]]) }).length, 1);
});

test('a member taking part in a running space collaboration is left alone', () => {
  const rooms = [{ id: 'shared', name: 'Team', run: { status: 'running', ids: ['a'] }, queue: [item('1')] }];
  assert.deepEqual(plan(rooms, [member('a')]), []);
});

test('paused members are skipped; claimable work goes to the next ready member', () => {
  const rooms = [{ id: 'shared', name: 'Team', memberOrder: ['a', 'b'], queue: [item('1'), item('2', { assignee: 'a' })] }];
  assert.deepEqual(plan(rooms, [member('a', { wakeDisabled: true }), member('b')]), [
    { kind: 'dispatch', roomId: 'shared', itemId: '1', sessionId: 'b' },
  ]);
});

test('a finished item settles as done and the same member gets the next item in the same pass', () => {
  const messages = [
    { id: 't1', role: 'user', text: 'NAW task', origin: 'naw-dispatch' },
    { id: 'r1', role: 'assistant', text: 'Done: changed the file.' },
  ];
  const rooms = [{ id: 'shared', name: 'Team', queue: [sentItem(), item('2')] }];
  assert.deepEqual(plan(rooms, [member('a', { messages })]), [
    { kind: 'settle', roomId: 'shared', itemId: '1', status: 'done', sessionId: 'a' },
    { kind: 'dispatch', roomId: 'shared', itemId: '2', sessionId: 'a' },
  ]);
});

test('an interrupted or silent turn, or the person stepping in, holds the member for the person', () => {
  const rooms = [{ id: 'shared', name: 'Team', queue: [sentItem(), item('2')] }];
  const silent = [{ id: 't1', role: 'user', text: 'NAW task', origin: 'naw-dispatch' }];
  assert.deepEqual(plan(rooms, [member('a', { messages: silent })]), [
    { kind: 'settle', roomId: 'shared', itemId: '1', status: 'waiting', reason: 'no-reply', sessionId: 'a' },
  ]);
  const personWrote = [
    { id: 't1', role: 'user', text: 'NAW task', origin: 'naw-dispatch' },
    { id: 'h1', role: 'user', text: 'stop, do it differently', origin: 'human' },
    { id: 'r1', role: 'assistant', text: 'OK, changed approach.' },
  ];
  assert.deepEqual(plan(rooms, [member('a', { messages: personWrote })]), [
    { kind: 'settle', roomId: 'shared', itemId: '1', status: 'waiting', reason: 'person-intervened', sessionId: 'a' },
  ]);
  // Interrupting from NAW or typing in the native terminal moves the control revision.
  const answered = [
    { id: 't1', role: 'user', text: 'NAW task', origin: 'naw-dispatch' },
    { id: 'r1', role: 'assistant', text: 'partial work' },
  ];
  assert.deepEqual(plan(rooms, [member('a', { messages: answered, controlRevision: 3 })]), [
    { kind: 'settle', roomId: 'shared', itemId: '1', status: 'waiting', reason: 'person-intervened', sessionId: 'a' },
  ]);
});

test('a reply that asks for a decision stops dispatch to that member until the person resolves it', () => {
  const messages = [
    { id: 't1', role: 'user', text: 'NAW task', origin: 'naw-dispatch' },
    { id: 'r1', role: 'assistant', text: '需要你决定：要不要删旧分支？' },
  ];
  const rooms = [{ id: 'shared', name: 'Team', queue: [sentItem(), item('2', { assignee: 'a' })] }];
  assert.deepEqual(plan(rooms, [member('a', { messages })]), [
    { kind: 'settle', roomId: 'shared', itemId: '1', status: 'waiting', sessionId: 'a' },
  ]);
  const later = [{ id: 'shared', name: 'Team', queue: [sentItem({ status: 'waiting' }), item('2', { assignee: 'a' })] }];
  assert.deepEqual(plan(later, [member('a', { messages })]), []);
});

test('a reply is found by send time when a native record replaced the NAW message id', () => {
  const messages = [
    { id: 'old', role: 'assistant', text: 'earlier work', time: NOW - 90000 },
    { id: 'native-user', role: 'user', text: 'NAW task', origin: 'naw-dispatch', time: NOW - 29000 },
    { id: 'r1', role: 'assistant', text: 'finished', time: NOW - 20000 },
  ];
  const rooms = [{ id: 'shared', name: 'Team', queue: [sentItem()] }];
  assert.deepEqual(plan(rooms, [member('a', { messages })]), [
    { kind: 'settle', roomId: 'shared', itemId: '1', status: 'done', sessionId: 'a' },
  ]);
  const silent = [{ id: 'old', role: 'assistant', text: 'earlier work', time: NOW - 90000 }];
  assert.deepEqual(plan(rooms, [member('a', { messages: silent })]), [
    { kind: 'settle', roomId: 'shared', itemId: '1', status: 'failed', reason: 'record-missing', sessionId: 'a' },
  ]);
});

test('a still-working member keeps its item in flight; an unconfirmed send is failed, never resent', () => {
  const rooms = [{ id: 'shared', name: 'Team', queue: [sentItem(), item('2')] }];
  assert.deepEqual(plan(rooms, [member('a', { state: 'working' })]), []);
  const lost = sentItem({ sentAt: NOW - 10 * 60000, tag: null });
  assert.deepEqual(plan([{ id: 'shared', name: 'Team', queue: [lost] }], [member('a')]), [
    { kind: 'settle', roomId: 'shared', itemId: '1', status: 'failed', reason: 'send-unconfirmed', sessionId: 'a' },
  ]);
});

test('a member older than the rotation age is rotated before it receives its next item', () => {
  const rooms = [{ id: 'shared', name: 'Team', queue: [item('1')] }];
  const old = member('a', { createdAt: NOW - 25 * HOUR });
  assert.deepEqual(plan(rooms, [old]), [{ kind: 'rotate', sessionId: 'a', reason: 'age' }]);
  const failed = { a: { phase: 'failed' } };
  assert.deepEqual(plan(rooms, [old], { rotations: failed }), [
    { kind: 'dispatch', roomId: 'shared', itemId: '1', sessionId: 'a' },
  ]);
  // With no queue the member is still rotated: it has been quiet since it was created a day ago.
  assert.deepEqual(plan([{ id: 'shared', name: 'Team', queue: [] }], [old]), [{ kind: 'rotate', sessionId: 'a', reason: 'age' }]);
});

test('an old, quiet space member is rotated even with no work queued; a recent conversation is not cut off', () => {
  const finished = item('1', { status: 'done', sentTo: 'a', sentAt: NOW - 2 * HOUR, tag: 't1' });
  const rooms = [{ id: 'shared', name: 'Team', queue: [finished] }];
  const quiet = member('a', { createdAt: NOW - 25 * HOUR, lastActivityAt: NOW - 40 * 60000 });
  assert.deepEqual(plan(rooms, [quiet]), [{ kind: 'rotate', sessionId: 'a', reason: 'age' }]);
  const talking = member('a', { createdAt: NOW - 25 * HOUR, lastActivityAt: NOW - 10 * 60000 });
  assert.deepEqual(plan(rooms, [talking]), []);
  const young = member('a', { createdAt: NOW - 2 * HOUR, lastActivityAt: NOW - 40 * 60000 });
  assert.deepEqual(plan(rooms, [young]), []);
  assert.deepEqual(plan([{ id: 'shared', name: 'Team', queue: [] }], [quiet]), [{ kind: 'rotate', sessionId: 'a', reason: 'age' }]);
  const waiting = item('2', { status: 'waiting', sentTo: 'a', sentAt: NOW - 2 * HOUR, tag: 't2' });
  assert.deepEqual(plan([{ id: 'shared', name: 'Team', queue: [waiting] }], [quiet]), []);
});

test('only refusals raised before anything was written count as not sent', () => {
  assert.equal(rules.notSent({ uiMessage: { key: 'error.workspace.sessionNotReady' } }), true);
  assert.equal(rules.notSent({ notSent: true }), true);
  assert.equal(rules.notSent({ uiMessage: { key: 'error.workspace.receiptUnconfirmed' } }), false);
  assert.equal(rules.notSent(Error('send-timeout')), false);
});

function roomSetup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-queue-dispatch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, room: new RoomState(dir) };
}

test('the person adds and cancels queue items; records persist and appear in the space record', t => {
  const { dir, room } = roomSetup(t);
  const first = room.queueAdd('第一件', null);
  const second = room.queueAdd('第二件', 'agent-b');
  room.queueCancel(second);
  const saved = new RoomState(dir);
  const queue = saved.value.queue;
  assert.equal(queue.length, 2);
  assert.equal(queue[0].id, first);
  assert.equal(queue[0].status, 'queued');
  assert.equal(queue[1].status, 'cancelled');
  const kinds = [];
  for (const event of saved.value.events) {
    kinds.push(event.uiMessage.key);
  }
  assert.deepEqual(kinds, ['notice.queue.added', 'notice.queue.added', 'notice.queue.cancelled']);
  assert.equal(saved.apply({ sessions: [], room: { messages: [] } }).rooms[0].queue.length, 2);
  assert.throws(() => room.queueAdd('', null), /1–6000/);
  assert.throws(() => room.queueCancel(second), /取消/);
});

test('dispatch and decision outcomes are written once to the space record with the member name', t => {
  const { room } = roomSetup(t);
  const id = room.queueAdd('改一下按钮', null);
  room.queueMarkSent('shared', id, 'agent-a', 'Claude 2', NOW);
  room.queueSetDelivery('shared', id, 'tag-1', 4);
  assert.equal(room.value.queue[0].control, 4);
  room.queueSettle('shared', id, 'waiting', '', 'Claude 2');
  const events = room.value.events;
  assert.equal(events[1].text, 'NAW 派活：改一下按钮 → Claude 2');
  assert.equal(events[1].sessionId, 'agent-a');
  assert.equal(events[2].text, 'Claude 2 需要你决定：改一下按钮');
  room.queueResolve(id);
  assert.equal(room.value.queue[0].status, 'done');
  assert.equal(room.value.events.length, 4);
  assert.equal(room.value.events[3].text, '已处理：改一下按钮');
});

test('a refusal before sending returns the item to the queue, and fails it after five tries', t => {
  const { room } = roomSetup(t);
  const id = room.queueAdd('试一下', null);
  for (let attempt = 1; attempt < 5; attempt += 1) {
    room.queueMarkSent('shared', id, 'agent-a', 'A', NOW);
    room.queueRequeue('shared', id, 'busy', 5, 'A');
    assert.equal(room.value.queue[0].status, 'queued');
    assert.equal(room.value.queue[0].attempts, attempt);
    assert.equal(room.value.queue[0].sentTo, undefined);
  }
  room.queueMarkSent('shared', id, 'agent-a', 'A', NOW);
  room.queueRequeue('shared', id, 'busy', 5, 'A');
  assert.equal(room.value.queue[0].status, 'failed');
});

class FakeClient extends EventEmitter {
  constructor(sessions) {
    super();
    this.state = { sessions, rooms: [{ id: 'shared', revision: 0, run: null, messages: [] }], wakePolicy: AWAKE, capabilities: [rules.CAPABILITY, rules.CREATE_SETTINGS_CAPABILITY] };
    this.calls = [];
    this.sequence = 0;
    this.reads = 0;
    this.capabilities = [rules.CAPABILITY];
  }
  snapshot() {
    this.reads += 1;
    return structuredClone(this.state);
  }
  async refresh() {
    return this.snapshot();
  }
  close() {}
  route(id) {
    if (!this.state.sessions.some(s => s.id === id)) {
      throw Error('unknown session');
    }
    return { client: this, state: { capabilities: this.capabilities } };
  }
  async call(method, ...args) {
    this.calls.push([method, ...args]);
    const session = this.state.sessions.find(s => s.id === args[0]);
    if (method === 'dispatch') {
      this.sequence += 1;
      const tag = `tag-${this.sequence}`;
      session.messages.push({ id: tag, role: 'user', text: args[1], origin: 'naw-dispatch', status: 'submitted' });
      session.state = 'working';
      this.emit('state');
      return tag;
    }
    if (method === 'create') {
      // Like the native CLIs: the requested model, or the provider default (unlike the old session's).
      let model = 'claude-default-model';
      if (args[0].settings && args[0].settings.model && !this.ignoreSettings) {
        model = args[0].settings.model;
      }
      const created = member(`new-${this.sequence}`, { name: args[0].name, createdAt: NOW, roomIds: [], roomId: null, cwd: args[0].cwd, model, view: args[0].view });
      this.state.sessions.push(created);
      return created.id;
    }
    if (method === 'stop') {
      session.state = 'ended';
      return { state: 'ended' };
    }
    throw Error(`unexpected ${method}`);
  }
  reply(id, text) {
    const session = this.state.sessions.find(s => s.id === id);
    session.messages.push({ id: `reply-${session.messages.length}`, role: 'assistant', text });
    session.state = 'idle';
    this.emit('state');
  }
  sends(id) {
    const result = [];
    for (const call of this.calls) {
      if (call[0] === 'dispatch' && (!id || call[1] === id)) {
        result.push(call);
      }
    }
    return result;
  }
}

function fakeMembership(room, client) {
  const joins = [];
  room.membership = async (_client, id, join, label, roomId) => {
    joins.push([id, join, roomId]);
    const session = client.state.sessions.find(s => s.id === id);
    if (join) {
      session.roomIds = [roomId];
      session.roomId = roomId;
    } else {
      session.roomIds = [];
      session.roomId = null;
    }
  };
  return joins;
}

function dispatcherSetup(t, sessions, options = {}) {
  const { dir, room } = roomSetup(t);
  const client = new FakeClient(sessions);
  let now = NOW;
  let connects = 0;
  const dispatcher = new rules.QueueDispatcher({
    roomState: room,
    dataDir: dir,
    connect: async () => {
      connects += 1;
      return client;
    },
    now: () => now,
    settleMs: 0,
    tickMs: 3600000,
    ...options,
  });
  t.after(() => dispatcher.close());
  return { room, client, dispatcher, advance: ms => { now += ms; }, dir, connects: () => connects };
}

test('the dispatcher sends through the backend dispatch input, waits for the reply, then sends the next', async t => {
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a')]);
  room.queueAdd('first task', null);
  room.queueAdd('second task', null);
  await dispatcher.start();
  await dispatcher.schedule();
  const sends = client.sends();
  assert.equal(sends.length, 1);
  assert.match(sends[0][2], /【NAW 派活】[\s\S]*first task/);
  assert.equal(sends[0][4], room.value.queue[0].id, 'the backend learns which queue item this is');
  assert.equal(client.calls.some(call => call[0] === 'claim' || call[0] === 'send'), false, 'no takeover and no human send');
  assert.equal(room.value.queue[0].status, 'sent');
  assert.equal(room.value.queue[0].tag, 'tag-1');
  await dispatcher.schedule();
  assert.equal(client.sends().length, 1, 'no second item while the member works');
  client.reply('a', 'first task finished');
  await dispatcher.schedule();
  await dispatcher.schedule();
  assert.equal(room.value.queue[0].status, 'done');
  assert.equal(client.sends().length, 2);
  assert.match(client.sends()[1][2], /second task/);
});

test('a refused send goes back to the queue; an uncertain failure is recorded and never retried', async t => {
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a')]);
  const original = client.call.bind(client);
  let refusals = 1;
  client.call = async (method, ...args) => {
    if (method === 'dispatch' && refusals > 0) {
      refusals -= 1;
      throw Object.assign(Error('not ready'), { uiMessage: { key: 'error.workspace.sessionNotReady' } });
    }
    if (method === 'dispatch') {
      throw Error('backend went away');
    }
    return original(method, ...args);
  };
  room.queueAdd('only task', null);
  await dispatcher.start();
  assert.equal(room.value.queue[0].status, 'queued', 'a refusal before sending is not a failure');
  assert.equal(room.value.queue[0].attempts, 1);
  dispatcher.dirty = true;
  await dispatcher.schedule();
  assert.equal(room.value.queue[0].status, 'failed');
  assert.equal(room.value.queue[0].reason, 'backend went away');
  dispatcher.dirty = true;
  await dispatcher.schedule();
  assert.equal(client.calls.filter(call => call[0] === 'dispatch').length, 0);
});

test('a member whose backend has not been updated gets nothing', async t => {
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a', { serviceCapabilities: ['collaborationSpacesV1'] })]);
  room.queueAdd('only task', null);
  await dispatcher.start();
  await dispatcher.schedule();
  assert.equal(client.calls.length, 0);
  assert.equal(room.value.queue[0].status, 'queued');
});

test('the person working in a session keeps NAW out of it for two minutes', async t => {
  const { room, client, dispatcher, advance } = dispatcherSetup(t, [member('a')]);
  room.queueAdd('only task', null);
  dispatcher.noteHuman('a');
  await dispatcher.start();
  await dispatcher.schedule();
  assert.equal(client.sends().length, 0);
  advance(rules.HUMAN_QUIET_MS + 1000);
  dispatcher.dirty = true;
  await dispatcher.schedule();
  assert.equal(client.sends().length, 1);
});

test('with nothing queued the dispatcher reads no session state and opens no connection', async t => {
  const { client, dispatcher, connects } = dispatcherSetup(t, [member('a')]);
  await dispatcher.start();
  await dispatcher.schedule();
  assert.equal(connects(), 0);
  assert.equal(client.reads, 0);
  assert.equal(client.calls.length, 0);
});

test('with queued work that cannot move, unchanged state is not reread on every tick', async t => {
  const { room, client, dispatcher, advance } = dispatcherSetup(t, [member('a', { state: 'working' })]);
  room.queueAdd('only task', null);
  await dispatcher.start();
  await dispatcher.schedule();
  const reads = client.reads;
  for (let i = 0; i < 5; i += 1) {
    advance(3000);
    await dispatcher.schedule();
  }
  assert.equal(client.reads, reads, 'no state change, nothing settling: no reread');
  client.emit('state');
  await dispatcher.schedule();
  assert.ok(client.reads > reads, 'a state change is looked at');
});

test('an open window client is used instead of a second connection', async t => {
  const { dir, room } = roomSetup(t);
  const windowClient = new FakeClient([member('a')]);
  let connects = 0;
  const dispatcher = new rules.QueueDispatcher({
    roomState: room,
    dataDir: dir,
    clients: () => windowClient,
    connect: async () => {
      connects += 1;
      return new FakeClient([]);
    },
    now: () => NOW,
    settleMs: 0,
    tickMs: 3600000,
  });
  t.after(() => dispatcher.close());
  room.queueAdd('window task', null);
  await dispatcher.start();
  await dispatcher.schedule();
  assert.equal(connects, 0);
  assert.equal(windowClient.sends().length, 1);
  assert.match(windowClient.sends()[0][2], /window task/);
});

test('an old member writes a handoff, a new member takes its queue, and the old process is stopped', async t => {
  const { room, client, dispatcher, dir } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, cwd: '/tmp' })]);
  const joins = fakeMembership(room, client);
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  await dispatcher.schedule();
  const request = client.sends('a')[0];
  assert.match(request[2], /【NAW 换会话】[\s\S]*只写交接/);
  assert.equal(room.value.queue[0].status, 'queued', 'the queued item is not sent to the old member');
  client.reply('a', '交接：在 feature 分支 abc123，下一步跑测试。');
  await dispatcher.schedule();
  const created = client.calls.find(call => call[0] === 'create');
  assert.equal(created[1].provider, 'claude');
  assert.equal(created[1].cwd, '/tmp');
  assert.deepEqual(created[1].settings, { model: 'claude-test-model' }, 'the successor starts with the old model');
  assert.equal(created[1].view, 'chat');
  const newId = client.state.sessions[1].id;
  assert.equal(room.value.queue[0].assignee, newId);
  await dispatcher.schedule();
  const handoff = client.sends(newId);
  assert.equal(handoff.length, 1);
  assert.match(handoff[0][2], /交接：在 feature 分支 abc123/);
  await dispatcher.schedule();
  assert.deepEqual(client.calls.find(call => call[0] === 'stop'), ['stop', 'a']);
  assert.deepEqual(joins, [[newId, true, 'shared'], ['a', false, 'shared']]);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'queue-dispatch.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved.rotations), [newId], 'only the successor rests, for a day');
  assert.equal(saved.rotations[newId].phase, 'kept');
  assert.equal(saved.rotations[newId].successorOf, 'a');
  client.reply(newId, '已核对交接。');
  await dispatcher.schedule();
  await dispatcher.schedule();
  const work = client.sends(newId);
  assert.equal(work.length, 2);
  assert.match(work[1][2], /next task/);
});

test('the person using the old member during the handoff stops the rotation before a new session exists', async t => {
  const { room, client, dispatcher, advance } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, cwd: '/tmp' })]);
  fakeMembership(room, client);
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  await dispatcher.schedule();
  advance(1000);
  dispatcher.noteHuman('a');
  client.reply('a', '交接：分支 abc。');
  await dispatcher.schedule();
  assert.equal(client.calls.filter(call => call[0] === 'create').length, 0);
  assert.equal(client.calls.filter(call => call[0] === 'stop').length, 0);
  const keys = [];
  for (const event of room.value.events) {
    keys.push(event.uiMessage.key);
  }
  assert.ok(keys.includes('notice.rotation.failed'));
});

test('if the old member is in use when the handoff lands, it is kept running', async t => {
  const { room, client, dispatcher, advance } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, cwd: '/tmp' })]);
  fakeMembership(room, client);
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  await dispatcher.schedule();
  client.reply('a', '交接：分支 abc。');
  await dispatcher.schedule();
  const newId = client.state.sessions[1].id;
  await dispatcher.schedule();
  assert.equal(client.sends(newId).length, 1, 'handoff sent to the new member');
  advance(1000);
  dispatcher.noteHuman('a');
  await dispatcher.schedule();
  assert.equal(client.calls.filter(call => call[0] === 'stop').length, 0, 'the old member is not stopped while in use');
  const keys = [];
  for (const event of room.value.events) {
    keys.push(event.uiMessage.key);
  }
  assert.ok(keys.includes('notice.rotation.oldKept'));
});

test('a new member that never gets ready ends the rotation, is stopped, and the old member keeps its work', async t => {
  const { room, client, dispatcher, advance } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, cwd: '/tmp' })]);
  fakeMembership(room, client);
  const original = client.call.bind(client);
  client.call = async (method, ...args) => {
    const result = await original(method, ...args);
    if (method === 'create') {
      // A startup prompt keeps the new native session from ever becoming idle.
      client.state.sessions.find(s => s.id === result).state = 'starting';
    }
    return result;
  };
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  await dispatcher.schedule();
  client.reply('a', '交接：分支 abc。');
  await dispatcher.schedule();
  const newId = client.state.sessions[1].id;
  assert.equal(room.value.queue[0].assignee, newId);
  advance(11 * 60 * 1000);
  await dispatcher.schedule();
  assert.equal(room.value.queue[0].assignee, 'a', 'the work goes back to the old member');
  assert.deepEqual(client.calls.filter(call => call[0] === 'stop'), [['stop', newId]], 'only the unused new member is stopped');
  const keys = [];
  for (const event of room.value.events) {
    keys.push(event.uiMessage.key);
  }
  assert.ok(keys.includes('notice.rotation.failed'), 'the failure is recorded in the space');
  const sends = client.sends('a');
  assert.match(sends[sends.length - 1][2], /next task/, 'the old member then gets its next item');
});

test('after a restart mid-creation, the session already created is adopted instead of a second one', async t => {
  const { dir, room } = roomSetup(t);
  const existing = member('made', { name: 'Agent a · 续', cwd: '/tmp', createdAt: NOW - 1000, roomIds: [], roomId: null });
  const client = new FakeClient([member('a', { createdAt: NOW - 30 * HOUR, cwd: '/tmp' }), existing]);
  fakeMembership(room, client);
  const record = { phase: 'creating', requestedAt: NOW - 60000, creatingAt: NOW - 2000, tag: 'tag-0', oldNativeId: 'native-a', oldControl: 0, provider: 'claude', cwd: '/tmp', name: 'Agent a', roomIds: ['shared'], handoff: '交接：x' };
  fs.writeFileSync(path.join(dir, 'queue-dispatch.json'), JSON.stringify({ version: 1, rotations: { a: record } }), { mode: 0o600 });
  const dispatcher = new rules.QueueDispatcher({ roomState: room, dataDir: dir, connect: async () => client, now: () => NOW, settleMs: 0, tickMs: 3600000 });
  t.after(() => dispatcher.close());
  await dispatcher.start();
  await dispatcher.schedule();
  assert.equal(client.calls.filter(call => call[0] === 'create').length, 0);
  assert.equal(dispatcher.rotations.a.newId, 'made');
});

test('a rotation file that is not private or well formed is ignored', t => {
  const { dir } = roomSetup(t);
  const file = path.join(dir, 'queue-dispatch.json');
  const record = { phase: 'handed', oldNativeId: 'native-a', name: 'A', roomIds: ['shared'], newId: 'b' };
  fs.writeFileSync(file, JSON.stringify({ version: 1, rotations: { a: record } }), { mode: 0o644 });
  assert.deepEqual(rules.readRotations(file, NOW), {});
  fs.chmodSync(file, 0o600);
  assert.equal(rules.readRotations(file, NOW).a.phase, 'handed');
  fs.writeFileSync(file, JSON.stringify({ version: 1, rotations: { a: { phase: 'stop-everything' } } }), { mode: 0o600 });
  assert.deepEqual(rules.readRotations(file, NOW), {});
});

test('messages from a space handoff or NAW\'s own text are not read as the person stepping in', () => {
  const rooms = [{ id: 'shared', name: 'Team', queue: [sentItem()] }];
  const handoff = [
    { id: 't1', role: 'user', text: 'NAW task', origin: 'naw-dispatch' },
    { id: 'x1', role: 'user', text: 'handoff from a teammate', origin: 'room' },
    { id: 'r1', role: 'assistant', text: 'done' },
  ];
  assert.equal(plan(rooms, [member('a', { messages: handoff })])[0].status, 'done');
  const replaced = [
    { id: 'native-user', role: 'user', text: '<system-reminder>native note</system-reminder>\n【NAW 派活】task', time: NOW - 29000 },
    { id: 'r1', role: 'assistant', text: 'finished', time: NOW - 20000 },
  ];
  assert.equal(plan(rooms, [member('a', { messages: replaced })])[0].status, 'done');
});

test('a kept old session is not asked to hand off again for a day', () => {
  const rooms = [{ id: 'shared', name: 'Team', queue: [item('1')] }];
  const old = member('a', { createdAt: NOW - 30 * HOUR });
  const kept = { a: { phase: 'kept', keptAt: NOW - 1000, oldNativeId: 'native-a', name: 'A', roomIds: ['shared'] } };
  assert.deepEqual(plan(rooms, [old], { rotations: kept }), [
    { kind: 'dispatch', roomId: 'shared', itemId: '1', sessionId: 'a' },
  ]);
});

test('a kept record expires after a day and a failed one after a week', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-queue-rotations-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'queue-dispatch.json');
  const base = { oldNativeId: 'native-a', name: 'A', roomIds: ['shared'] };
  const rotations = {
    a: { ...base, phase: 'kept', keptAt: NOW - 25 * HOUR },
    b: { ...base, phase: 'kept', keptAt: NOW - HOUR },
    c: { ...base, phase: 'failed', failedAt: NOW - 8 * 24 * HOUR },
  };
  fs.writeFileSync(file, JSON.stringify({ version: 1, rotations }), { mode: 0o600 });
  assert.deepEqual(Object.keys(rules.readRotations(file, NOW)), ['b']);
});

test('a connection being updated holds the item without recording a send or using up its retries', async t => {
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a')]);
  let updating = true;
  client.operationGuard = () => () => {
    if (updating) {
      throw Object.assign(Error('updating'), { uiMessage: { key: 'error.client.connectionUpdatingNoInput' } });
    }
  };
  room.queueAdd('only task', null);
  await dispatcher.start();
  for (let i = 0; i < 6; i += 1) {
    dispatcher.dirty = true;
    await dispatcher.schedule();
  }
  assert.equal(room.value.queue[0].status, 'queued');
  assert.equal(room.value.queue[0].attempts, undefined);
  assert.equal(client.sends().length, 0);
  updating = false;
  dispatcher.dirty = true;
  await dispatcher.schedule();
  assert.equal(client.sends().length, 1);
});

test('the old session is not stopped while a space collaboration is running', async t => {
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, cwd: '/tmp' })]);
  fakeMembership(room, client);
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  client.reply('a', '交接：分支 abc。');
  await dispatcher.schedule();
  await dispatcher.schedule();
  client.state.rooms[0].run = { status: 'running', ids: ['someone-else', 'another'] };
  await dispatcher.schedule();
  assert.equal(client.calls.filter(call => call[0] === 'stop').length, 0, 'waits while a collaboration runs');
  client.state.rooms[0].run = null;
  await dispatcher.schedule();
  assert.deepEqual(client.calls.filter(call => call[0] === 'stop'), [['stop', 'a']]);
});

test('while the old session waits for a collaboration, the new member already takes work, and the wait is bounded', async t => {
  const { room, client, dispatcher, advance } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, cwd: '/tmp' })]);
  fakeMembership(room, client);
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  client.reply('a', '交接：分支 abc。');
  await dispatcher.schedule();
  const newId = client.state.sessions[1].id;
  await dispatcher.schedule();
  client.state.rooms[0].run = { status: 'running', ids: ['x', 'y'] };
  client.reply(newId, '已核对交接。');
  await dispatcher.schedule();
  await dispatcher.schedule();
  assert.equal(client.sends(newId).length, 2, 'the new member got the queued item during the wait');
  assert.equal(client.calls.filter(call => call[0] === 'stop').length, 0);
  advance(31 * 60 * 1000);
  dispatcher.dirty = true;
  await dispatcher.schedule();
  assert.equal(client.calls.filter(call => call[0] === 'stop').length, 0, 'never stopped while a collaboration runs');
  assert.equal(dispatcher.rotations.a.phase, 'kept');
});

test('the person quoting NAW text is still the person; an ended old session needs no wait', () => {
  const rooms = [{ id: 'shared', name: 'Team', queue: [sentItem()] }];
  const quoted = [
    { id: 't1', role: 'user', text: 'NAW task', origin: 'naw-dispatch' },
    { id: 'h1', role: 'user', text: '关于【NAW 派活】那件，换个做法', origin: 'human' },
    { id: 'r1', role: 'assistant', text: 'OK' },
  ];
  assert.equal(plan(rooms, [member('a', { messages: quoted })])[0].reason, 'person-intervened');
});

test('a rotation whose old session already ended finishes at once even while a collaboration runs', async t => {
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, cwd: '/tmp' })]);
  fakeMembership(room, client);
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  client.reply('a', '交接：分支 abc。');
  await dispatcher.schedule();
  await dispatcher.schedule();
  client.state.sessions[0].state = 'ended';
  client.state.rooms[0].run = { status: 'running', ids: ['x', 'y'] };
  dispatcher.dirty = true;
  await dispatcher.schedule();
  assert.equal(dispatcher.rotations.a, undefined, 'record finished without waiting');
  assert.equal(client.calls.filter(call => call[0] === 'stop').length, 0, 'nothing left to stop');
});

test('only a terminal\'s own replies are ignored; every key the person presses counts', () => {
  const { isTerminalResponse } = require('../workspace.cjs');
  const replies = ['\x1b[12;40R', '\x1b[?1;2c', '\x1b[>0;95;0c', '\x1b[0n', '\x1b[?2004;1$y', '\x1b]11;rgb:0000/0000/0000\x07', '\x1b[<35;10;5M'];
  for (const reply of replies) {
    assert.equal(isTerminalResponse(reply), true, JSON.stringify(reply));
    assert.equal(rules.terminalReplyOnly(reply), true, JSON.stringify(reply));
  }
  assert.equal(rules.terminalReplyOnly('\x1b[I'), true, 'focus in');
  assert.equal(rules.terminalReplyOnly('\x1b[O'), true, 'focus out');
  const keys = ['a', '\r', '\x03', '\x7f', '\x1b[A', '\x1bOA', '\x1b[Z', '\x1b[3~', '\x1b[5~', '\x1b[1;5C', '\x1b[15~', '\x1b[<0;10;5M', 'hi\x1b[I'];
  for (const key of keys) {
    assert.equal(isTerminalResponse(key), false, JSON.stringify(key));
    assert.equal(rules.terminalReplyOnly(key), false, JSON.stringify(key));
  }
});

test('rotated names count up instead of piling suffixes', () => {
  assert.equal(rules.nextName('队员甲'), '队员甲 · 续');
  assert.equal(rules.nextName('队员甲 · 续'), '队员甲 · 续2');
  assert.equal(rules.nextName('队员甲 · 续9'), '队员甲 · 续10');
});

test('a rotation is announced and logged with every session id and native id, and chains show the sessions behind one conversation', async t => {
  const notices = [];
  const { room, client, dispatcher, dir } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, cwd: '/tmp' })], {
    notify: (outcome, record) => notices.push([outcome, record.name, record.newName]),
  });
  fakeMembership(room, client);
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  client.reply('a', '交接：分支 abc。');
  await dispatcher.schedule();
  await dispatcher.schedule();
  await dispatcher.schedule();
  const newId = client.state.sessions[1].id;
  assert.deepEqual(notices, [['done', 'Agent a', 'Agent a · 续']]);
  const lines = fs.readFileSync(path.join(dir, 'rotation-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const events = [];
  for (const line of lines) {
    events.push(line.event);
  }
  assert.deepEqual(events, ['requested', 'done']);
  assert.deepEqual(lines[1].old, { id: 'a', nativeId: 'native-a', name: 'Agent a' });
  assert.equal(lines[1].new.id, newId);
  assert.equal(lines[1].new.nativeId, `native-${newId}`);
  assert.deepEqual(lines[1].spaces, ['shared']);
  const chains = dispatcher.rotationChains();
  assert.equal(chains.length, 1);
  const ids = [];
  for (const link of chains[0].sessions) {
    ids.push(link.id);
  }
  assert.deepEqual(ids, ['a', newId]);
  assert.deepEqual(chains[0].spaces, ['shared']);
  const doneEvent = room.value.events.find(event => event.uiMessage.key === 'notice.rotation.done');
  assert.match(doneEvent.text, /「Agent a（a）」的工作已交给「Agent a · 续（[^）]+）」/);
});

test('chains follow several rotations of one conversation in order', () => {
  const entries = [
    { time: 1, event: 'done', spaces: ['s'], old: { id: 'a', nativeId: 'na', name: 'A' }, new: { id: 'b', nativeId: 'nb', name: 'A · 续' } },
    { time: 2, event: 'failed', spaces: ['s'], old: { id: 'b', nativeId: 'nb', name: 'A · 续' }, new: null },
    { time: 3, event: 'kept', spaces: ['s'], old: { id: 'b', nativeId: 'nb', name: 'A · 续' }, new: { id: 'c', nativeId: 'nc', name: 'A · 续2' } },
  ];
  const chains = rules.rotationChains(entries);
  assert.equal(chains.length, 1);
  const summary = [];
  for (const link of chains[0].sessions) {
    summary.push([link.id, link.nativeId, link.outcome]);
  }
  assert.deepEqual(summary, [['a', 'na', null], ['b', 'nb', 'done'], ['c', 'nc', 'kept']]);
});

test('a kept session rotated again keeps both successors visible; malformed log lines are ignored', t => {
  const entries = [
    { time: 1, event: 'kept', spaces: ['s'], old: { id: 'a', nativeId: 'na', name: 'A' }, new: { id: 'b', nativeId: 'nb', name: 'A · 续' } },
    { time: 2, event: 'done', spaces: ['s'], old: { id: 'a', nativeId: 'na', name: 'A' }, new: { id: 'c', nativeId: 'nc', name: 'A · 续2' } },
    null,
    { time: 3, event: 'done', spaces: 'not-a-list', old: { id: 'x' }, new: null },
  ];
  const chains = rules.rotationChains(entries);
  const paths = [];
  for (const chain of chains) {
    const ids = [];
    for (const link of chain.sessions) {
      ids.push(link.id);
    }
    paths.push(ids.join('>'));
  }
  assert.deepEqual(paths.sort(), ['a>b', 'a>c']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-rotation-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'rotation-log.jsonl'), 'null\n{"event":"done","spaces":"x"}\nnot json\n' + JSON.stringify(entries[0]) + '\n', { mode: 0o600 });
  const dispatcher = new rules.QueueDispatcher({ roomState: new RoomState(dir), dataDir: dir, connect: async () => null });
  assert.equal(dispatcher.rotationEntries().length, 1);
  assert.equal(dispatcher.rotationChains().length, 1);
  assert.equal(dispatcher.rotationChains(), dispatcher.rotationChains(), 'cached until the log changes');
});

test('memory or age, whichever comes first, makes a member due; machine pressure lowers the memory bar', () => {
  const rooms = [{ id: 'shared', name: 'Team', queue: [item('1')] }];
  const young = member('a', { createdAt: NOW - HOUR });
  const big = new Map([['a', 1600 * 1024 * 1024]]);
  assert.deepEqual(plan(rooms, [young], { memory: big }), [{ kind: 'rotate', sessionId: 'a', reason: 'memory' }]);
  const grown = new Map([['a', 900 * 1024 * 1024]]);
  assert.deepEqual(plan(rooms, [young], { memory: grown }), [{ kind: 'dispatch', roomId: 'shared', itemId: '1', sessionId: 'a' }]);
  assert.deepEqual(plan(rooms, [young], { memory: grown, memoryLimit: rules.PRESSURE_LIMIT_BYTES }), [{ kind: 'rotate', sessionId: 'a', reason: 'memory' }]);
  const old = member('a', { createdAt: NOW - 25 * HOUR });
  assert.deepEqual(plan(rooms, [old], { memory: new Map() }), [{ kind: 'rotate', sessionId: 'a', reason: 'age' }]);
  // A quiet member with no work is rotated for memory after 10 quiet minutes, not 30.
  const finished = [{ id: 'shared', name: 'Team', queue: [item('2', { status: 'done' })] }];
  const quiet = member('a', { lastActivityAt: NOW - 15 * 60000 });
  assert.deepEqual(plan(finished, [quiet], { memory: big }), [{ kind: 'rotate', sessionId: 'a', reason: 'memory' }]);
  const busyPerson = member('a', { lastActivityAt: NOW - 5 * 60000 });
  assert.deepEqual(plan(finished, [busyPerson], { memory: big }), []);
  // Under an hour old, a large session is not replaced: its successor would start as large.
  const newborn = member('a', { createdAt: NOW - 30 * 60000 });
  assert.deepEqual(plan(rooms, [newborn], { memory: big }), [{ kind: 'dispatch', roomId: 'shared', itemId: '1', sessionId: 'a' }]);
});

test('members of every space are rotated once quiet; a session without a creation time uses its earliest message', () => {
  const plain = [{ id: 'shared', name: 'Team' }];
  const old = member('a', { createdAt: NOW - 25 * HOUR, lastActivityAt: NOW - 40 * 60000 });
  assert.deepEqual(plan(plain, [old]), [{ kind: 'rotate', sessionId: 'a', reason: 'age' }]);
  const recent = member('a', { createdAt: NOW - 25 * HOUR, lastActivityAt: NOW - 10 * 60000 });
  assert.deepEqual(plan(plain, [recent]), []);
  const archived = [{ id: 'shared', name: 'Team', archived: true }];
  assert.deepEqual(plan(archived, [old]), []);
  const messages = [{ role: 'system', text: 'x' }, { role: 'user', text: 'y', time: NOW - 340 * HOUR }, { role: 'assistant', text: 'z', time: NOW - 2 * HOUR }];
  const unrecorded = member('a', { createdAt: undefined, lastActivityAt: NOW - 40 * 60000, messages });
  assert.equal(rules.sessionStart(unrecorded, NOW), NOW - 340 * HOUR);
  assert.deepEqual(plan(plain, [unrecorded]), [{ kind: 'rotate', sessionId: 'a', reason: 'age' }]);
  const unknown = member('a', { createdAt: undefined, lastActivityAt: NOW - 40 * 60000, messages: [{ role: 'user', text: 'y' }, { role: 'user', text: 'w', time: 1234 }] });
  assert.equal(rules.sessionStart(unknown, NOW), null);
  assert.deepEqual(plan(plain, [unknown], { memory: new Map([['a', 4 * 1024 ** 3]]) }), []);
});

test('a session\'s memory footprint includes its child processes; pressure is macOS\'s own level', () => {
  const top = ['Processes: 812 total', 'PID    PPID   MEM', '10     1      97M', '11     10     48M+', '12     11     2048K-', '20     1      1.5G', '99     1      976M'].join('\n');
  const memory = rules.processMemory([{ id: 'a', pid: 10 }, { id: 'b', pid: 20 }, { id: 'c', pid: 404 }], top);
  assert.equal(memory.get('a'), (97 + 48 + 2) * 1024 * 1024);
  assert.equal(memory.get('b'), 1.5 * 1024 ** 3);
  assert.equal(memory.has('c'), false);
  assert.equal(rules.memoryPressure('1\n'), false);
  assert.equal(rules.memoryPressure('2\n'), true);
  assert.equal(rules.memoryPressure('4'), true);
  assert.equal(rules.memoryPressure('nonsense'), false);
  const listing = require('node:child_process').execFileSync('/usr/bin/top', ['-l', '1', '-stats', 'pid,ppid,mem'], { encoding: 'utf8' });
  const real = rules.processMemory([{ id: 'self', pid: process.pid }], listing);
  assert.ok(real.get('self') > 1024 * 1024, 'measures a real process footprint with top');
  const level = require('node:child_process').execFileSync('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { encoding: 'utf8' });
  assert.match(level.trim(), /^[124]$/, 'macOS reports a pressure level');
});

test('with no queued work, a quiet oversized member of a queue space is still rotated through an open window', async t => {
  const { dir, room } = roomSetup(t);
  const windowClient = new FakeClient([member('a', { pid: 4242, cwd: '/tmp', lastActivityAt: NOW - 20 * 60000 })]);
  fakeMembership(room, windowClient);
  const id = room.queueAdd('old task', null);
  room.queueMarkSent('shared', id, 'a', 'A', NOW - 3600000);
  room.queueSetDelivery('shared', id, 'tag-0', 0);
  room.queueSettle('shared', id, 'done', '', 'A');
  const dispatcher = new rules.QueueDispatcher({
    roomState: room,
    dataDir: dir,
    clients: () => windowClient,
    connect: async () => null,
    now: () => NOW,
    settleMs: 0,
    tickMs: 3600000,
    sampleProcesses: async () => '4242 1 1660M\n',
    samplePressure: async () => '1\n',
  });
  t.after(() => dispatcher.close());
  await dispatcher.start();
  const sends = windowClient.sends('a');
  assert.equal(sends.length, 1);
  assert.match(sends[0][2], /【NAW 换会话】这个会话（连同它的子进程）已占用约 1\.6 GB 内存/);
  const requested = room.value.events.find(event => event.uiMessage.key === 'notice.rotation.requested');
  assert.match(requested.text, /NAW 换会话（这个会话（连同它的子进程）已占用约 1\.6 GB 内存）/);
});

test('with the default settle time and no queued work, a quiet oversized member is rotated on the minute check', async t => {
  const { dir, room } = roomSetup(t);
  const windowClient = new FakeClient([member('a', { pid: 4242, cwd: '/tmp', lastActivityAt: NOW - 20 * 60000 })]);
  fakeMembership(room, windowClient);
  const id = room.queueAdd('old task', null);
  room.queueMarkSent('shared', id, 'a', 'A', NOW - 3600000);
  room.queueSetDelivery('shared', id, 'tag-0', 0);
  room.queueSettle('shared', id, 'done', '', 'A');
  let now = NOW;
  const dispatcher = new rules.QueueDispatcher({
    roomState: room,
    dataDir: dir,
    clients: () => windowClient,
    connect: async () => null,
    now: () => now,
    tickMs: 3600000,
    sampleProcesses: async () => '4242 1 1660M\n',
    samplePressure: async () => '1\n',
  });
  t.after(() => dispatcher.close());
  await dispatcher.start();
  for (let second = 0; second < 70; second += 3) {
    now += 3000;
    await dispatcher.schedule();
  }
  assert.equal(windowClient.sends('a').length, 1, 'rotated within a minute without any queued work');
});

test('a process shared by two sessions is not charged to either', () => {
  const memory = rules.processMemory([{ id: 'a', pid: 10 }, { id: 'b', pid: 10 }, { id: 'c', pid: 20 }], '10 1 879M\n20 1 1000K\n');
  assert.equal(memory.has('a'), false);
  assert.equal(memory.has('b'), false);
  assert.equal(memory.get('c'), 1000 * 1024);
});

test('idle times seen by a minute check are not reused: work added later still waits the full settle time', async t => {
  const { dir, room } = roomSetup(t);
  const windowClient = new FakeClient([member('a', { pid: 4242, cwd: '/tmp' })]);
  fakeMembership(room, windowClient);
  const old = room.queueAdd('old task', null);
  room.queueMarkSent('shared', old, 'a', 'A', NOW - 3600000);
  room.queueSetDelivery('shared', old, 'tag-0', 0);
  room.queueSettle('shared', old, 'done', '', 'A');
  let now = NOW;
  const dispatcher = new rules.QueueDispatcher({
    roomState: room,
    dataDir: dir,
    clients: () => windowClient,
    connect: async () => null,
    now: () => now,
    tickMs: 3600000,
    sampleProcesses: async () => '4242 1 1M\n',
    samplePressure: async () => '1\n',
  });
  t.after(() => dispatcher.close());
  await dispatcher.start();
  now += 30000;
  await dispatcher.schedule();
  room.queueAdd('next task', null);
  now += 1000;
  await dispatcher.schedule();
  assert.equal(windowClient.sends('a').length, 0, 'the member was seen idle 31 s ago, but only by the minute check');
  now += 9000;
  await dispatcher.schedule();
  assert.equal(windowClient.sends('a').length, 1, 'sent once the member has settled under observation');
});

test('only one rotation runs at a time; the largest quiet session goes first', () => {
  const rooms = [{ id: 'shared', name: 'Team' }];
  const quiet = { lastActivityAt: NOW - 40 * 60000 };
  const a = member('a', { createdAt: NOW - 30 * HOUR, ...quiet });
  const b = member('b', { createdAt: NOW - 26 * HOUR, ...quiet });
  const c = member('c', { createdAt: NOW - 40 * HOUR, ...quiet });
  const memory = new Map([['a', 200 * 1024 * 1024], ['b', 700 * 1024 * 1024], ['c', 300 * 1024 * 1024]]);
  assert.deepEqual(plan(rooms, [a, b, c], { memory }), [{ kind: 'rotate', sessionId: 'b', reason: 'age' }]);
  assert.deepEqual(plan(rooms, [a, b, c]), [{ kind: 'rotate', sessionId: 'c', reason: 'age' }], 'without a memory sample the oldest goes first');
  const running = { x: { phase: 'requested', oldId: 'x' } };
  assert.deepEqual(plan(rooms, [a, b, c], { memory, rotations: running }), []);
  // A due member that gets work while another rotation runs keeps working.
  const queued = [{ id: 'shared', name: 'Team', queue: [item('1')] }];
  assert.deepEqual(plan(queued, [a], { rotations: running }), [{ kind: 'dispatch', roomId: 'shared', itemId: '1', sessionId: 'a' }]);
});

test('a successor carries the old model, effort, permission mode and view; what cannot be carried is named', () => {
  const claude = member('a', { model: 'claude-opus-5-5', nativeEffort: 'xhigh', nativePermissionMode: 'auto', view: 'terminal', roomIds: ['shared'] });
  assert.deepEqual(rules.carrySettings(claude), { settings: { model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: 'auto' }, view: 'terminal' });
  const plain = member('a', { model: 'claude-opus-5-5', nativePermissionMode: 'default' });
  assert.deepEqual(rules.carrySettings(plain), { settings: { model: 'claude-opus-5-5' }, view: 'chat' });
  assert.deepEqual(rules.carrySettings(member('a', { nativePermissionMode: 'somethingNew' })), { reason: 'permission-mode' });
  assert.deepEqual(rules.carrySettings(member('a', { model: '原生默认' })), { reason: 'model-unknown' });
  assert.deepEqual(rules.carrySettings(member('a', { model: '原生未报告' })), { reason: 'model-unknown' });
  // Like the person's older Codex records: one space in roomId, no roomIds field.
  const codex = member('c', { provider: 'codex', model: 'gpt-6.1-sol', nativeSettings: { model: 'gpt-6.1-sol', effort: 'ultra', mode: null }, roomId: 'shared', view: 'terminal' });
  delete codex.roomIds;
  assert.deepEqual(rules.carrySettings(codex), { settings: { model: 'gpt-6.1-sol', effort: 'ultra' }, view: 'chat' }, 'a Codex successor starts in chat view');
  const planning = member('c', { provider: 'codex', nativeSettings: { model: 'gpt-6.1-sol', effort: 'high', mode: 'plan' } });
  assert.deepEqual(rules.carrySettings(planning), { reason: 'collaboration-mode' });
  const twoSpaces = member('a', { roomIds: ['shared', '308f55b3-ec97-467c-a2b8-1ecc47562029'] });
  assert.deepEqual(rules.carrySettings(twoSpaces), { reason: 'several-spaces' });
  // The lists match what the backend accepts.
  const workspace = require('../workspace.cjs');
  assert.deepEqual(rules.CLAUDE_PERMISSION_MODES, workspace.CLAUDE_PERMISSION_MODES);
  assert.deepEqual(rules.CLAUDE_EFFORTS, workspace.CLAUDE_EFFORTS);
});

test('a successor that reports other settings is caught; last activity falls back to the newest message', () => {
  const carry = { model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: 'auto' };
  assert.equal(rules.settingsMismatch(carry, member('n', { model: '原生默认' })), 'pending');
  assert.equal(rules.settingsMismatch(carry, member('n', { model: 'claude-sonnet-5-5' })), 'model');
  assert.equal(rules.settingsMismatch(carry, member('n', { model: 'claude-opus-5-5', nativePermissionMode: 'manual' })), 'permission-mode');
  assert.equal(rules.settingsMismatch(carry, member('n', { model: 'claude-opus-5-5', nativeEffort: 'low' })), 'effort');
  assert.equal(rules.settingsMismatch(carry, member('n', { model: 'claude-opus-5-5' })), null, 'effort and mode not reported yet');
  const codexCarry = { model: 'gpt-6.1-sol', effort: 'ultra' };
  assert.equal(rules.settingsMismatch(codexCarry, member('n', { provider: 'codex', nativeSettings: { model: 'gpt-6-astra', effort: 'xhigh' } })), 'model');
  assert.equal(rules.settingsMismatch(codexCarry, member('n', { provider: 'codex', nativeSettings: { model: 'gpt-6.1-sol', effort: 'xhigh' } })), 'effort');
  assert.equal(rules.settingsMismatch(codexCarry, member('n', { provider: 'codex', nativeSettings: { model: 'gpt-6.1-sol', effort: 'ultra' } })), null);
  const messages = [{ role: 'user', text: 'a', time: NOW - 340 * HOUR }, { role: 'assistant', text: 'b', time: NOW - 3 * HOUR }];
  assert.equal(rules.lastActivityOf(member('a', { lastActivityAt: NOW - HOUR, messages }), NOW), NOW - HOUR);
  assert.equal(rules.lastActivityOf(member('a', { lastActivityAt: undefined, messages }), NOW), NOW - 3 * HOUR);
});

test('a session whose settings cannot be carried is not asked for a handoff; it keeps working and is told once', async t => {
  const notices = [];
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, cwd: '/tmp', model: '原生默认' })], {
    notify: (kind, record) => notices.push([kind, record.reason]),
  });
  fakeMembership(room, client);
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  await dispatcher.schedule();
  assert.deepEqual(notices, [['failed', 'cannot-carry:model-unknown']]);
  assert.equal(client.calls.some(call => call[0] === 'create'), false);
  await dispatcher.schedule();
  const sends = client.sends('a');
  assert.equal(sends.length, 1);
  assert.match(sends[0][2], /【NAW 派活】[\s\S]*next task/, 'the member simply gets its next item');
  assert.equal(notices.length, 1);
});

test('a backend that ignores the settings gives a successor with another model: it is stopped, the old session stays', async t => {
  const notices = [];
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, cwd: '/tmp' })], {
    notify: (kind, record) => notices.push([kind, record.reason]),
  });
  fakeMembership(room, client);
  client.ignoreSettings = true;
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  await dispatcher.schedule();
  client.reply('a', '交接：在 feature 分支。');
  await dispatcher.schedule();
  await dispatcher.schedule();
  const newId = client.state.sessions[1].id;
  assert.equal(client.sends(newId).length, 0, 'no handoff reaches a successor with another model');
  assert.deepEqual(client.calls.filter(call => call[0] === 'stop'), [['stop', newId]]);
  assert.deepEqual(notices, [['failed', 'settings-differ:model']]);
  assert.notEqual(client.state.sessions[0].state, 'ended', 'the old session keeps running');
  assert.ok(client.sends('a').some(call => /【NAW 派活】[\s\S]*next task/.test(call[2])), 'and gets its queued item back');
});

test('without the backend support for carried settings no rotation starts', async t => {
  const notices = [];
  const { room, client, dispatcher } = dispatcherSetup(t, [member('a', { createdAt: NOW - 30 * HOUR, cwd: '/tmp' })], {
    notify: (kind, record) => notices.push([kind, record.reason]),
  });
  fakeMembership(room, client);
  client.state.capabilities = [rules.CAPABILITY];
  room.queueAdd('next task', 'a');
  await dispatcher.start();
  await dispatcher.schedule();
  assert.deepEqual(notices, [['failed', 'cannot-carry:backend-cannot-carry-settings']]);
  assert.equal(client.sends('a').some(call => /【NAW 换会话】/.test(call[2])), false);
});
