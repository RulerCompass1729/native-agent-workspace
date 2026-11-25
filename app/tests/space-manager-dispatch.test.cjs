// What a space's project manager adds to its queue, and where NAW may send it: an agent's own item must not start it
// again, directly or through another manager. Synthetic sessions; nothing is sent to a real one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const rules = require('../queue-dispatch.cjs');
const { RoomState } = require('../room-state.cjs');

const NOW = 1_800_000_000_000;
const AWAKE = { enabled: true };
const BY_MANAGER = { kind: 'secretary', name: 'Manager', sessionId: 'manager' };

function member(id, extra = {}) {
  return {
    id, name: `Agent ${id}`, provider: 'claude', nativeId: `native-${id}`, model: 'claude-test-model', state: 'idle',
    roomIds: ['shared'], roomId: 'shared', createdAt: NOW - 3600000, background: 0, scheduled: 0, backgroundStale: false,
    chatAvailable: true, liveDraft: '', controlRevision: 0, draftRevision: 0, placementRevision: 0,
    serviceCapabilities: [rules.CAPABILITY], fleet: [], messages: [], ...extra,
  };
}

function plan(items, sessions, managers) {
  const waits = new Map();
  const actions = rules.planDispatch({
    rooms: [{ id: 'shared', name: 'Plans', queue: items, run: null }],
    sessions,
    wakePolicy: AWAKE,
    idleSince: new Map(sessions.map(session => [session.id, NOW - 60000])),
    now: NOW,
    waits,
    ...(managers === undefined ? {} : { managers }),
  });
  return { sent: actions.filter(action => action.kind === 'dispatch').map(action => [action.itemId, action.sessionId]), waits };
}
const item = (id, extra = {}) => ({ id, text: `task ${id}`, assignee: null, status: 'queued', createdAt: NOW - 1000, ...extra });
const MANAGES = new Map([['manager', 'shared']]);

test('an item a project manager added goes to a member, never back to it or to another manager', () => {
  const both = [member('manager'), member('a')];
  assert.deepEqual(plan([item('1', { creator: BY_MANAGER })], both, MANAGES).sent, [['1', 'a']], 'the first ready member that is not the manager');
  // Named before the person made that member the manager, or added to a session that is the manager now.
  const named = plan([item('1', { creator: BY_MANAGER, assignee: 'manager' })], both, MANAGES);
  assert.deepEqual(named.sent, []);
  assert.deepEqual(named.waits.get('1'), [{ sessionId: 'manager', reason: 'manager-item' }]);
  // No longer the manager: its own item still does not come back to it.
  assert.deepEqual(plan([item('1', { creator: BY_MANAGER })], [member('manager')], new Map()).sent, []);
  // Its successor after a rotation is the manager now.
  const successor = [member('next')];
  assert.deepEqual(plan([item('1', { creator: BY_MANAGER })], successor, new Map([['next', 'shared']])).sent, []);
  assert.deepEqual(plan([item('1', { creator: BY_MANAGER })], successor, new Map()).sent, [['1', 'next']]);
});

test("the person's and the butler's items may go to the manager", () => {
  const only = [member('manager')];
  assert.deepEqual(plan([item('1')], only, MANAGES).sent, [['1', 'manager']]);
  assert.deepEqual(plan([item('1', { creator: { kind: 'person', name: '', sessionId: '' } })], only, MANAGES).sent, [['1', 'manager']]);
  // The butler's items are in the form an older build accepts, and say so in `addedBy`.
  assert.deepEqual(plan([item('1', { creator: { kind: 'secretary', name: 'Butler', sessionId: 'butler' }, addedBy: 'steward' })], only, MANAGES).sent, [['1', 'manager']]);
});

test("a record that cannot be read holds a manager's items and no one else's", () => {
  const sessions = [member('a'), member('b')];
  const held = plan([item('1', { creator: BY_MANAGER }), item('2')], sessions, null);
  assert.deepEqual(held.sent, [['2', 'a']]);
  assert.deepEqual(held.waits.get('1'), [{ sessionId: 'a', reason: 'manager-item' }, { sessionId: 'b', reason: 'manager-item' }]);
  // A build or a caller that knows no managers behaves as before for the other items.
  assert.deepEqual(plan([item('1')], sessions).sent, [['1', 'a']]);
});

test("a manager's item waits for a member that is at work rather than going to the manager", () => {
  const { sent, waits } = plan([item('1', { creator: BY_MANAGER })], [member('manager'), member('a', { state: 'working' })], MANAGES);
  assert.deepEqual(sent, []);
  assert.deepEqual(waits.get('1'), [{ sessionId: 'a', reason: 'not-idle' }]);
});

class FakeClient extends EventEmitter {
  constructor(sessions) {
    super();
    this.state = { sessions, rooms: [{ id: 'shared', revision: 0, run: null, messages: [] }], wakePolicy: AWAKE, capabilities: [rules.CAPABILITY] };
    this.sent = [];
  }
  snapshot() { return structuredClone(this.state); }
  async refresh() { return this.snapshot(); }
  close() {}
  route() { return { client: this, state: { capabilities: [rules.CAPABILITY] } }; }
  async call(method, id, text) {
    if (method === 'initial') return this.snapshot();
    assert.equal(method, 'dispatch');
    this.sent.push([id, text]);
    const session = this.state.sessions.find(value => value.id === id);
    session.state = 'working';
    session.messages.push({ id: `tag-${this.sent.length}`, role: 'user', text, origin: 'naw-dispatch', status: 'submitted' });
    return `tag-${this.sent.length}`;
  }
}
async function dispatcher(t, sessions, managers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-manager-dispatch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const room = new RoomState(dir), client = new FakeClient(sessions);
  const value = new rules.QueueDispatcher({ roomState: room, dataDir: dir, connect: async () => client, now: () => NOW, settleMs: 0, tickMs: 3600000,
    transcriptRoot: path.join(dir, 'none'), managers });
  t.after(() => value.close());
  await value.start();
  return { room, client, dispatcher: value };
}

test('every item sent to the manager says it is one; nothing is sent only to say so, and a member is told nothing of it', async t => {
  let managers = { shared: { sessionId: 'manager', nativeId: 'native-manager' } };
  const f = await dispatcher(t, [member('manager'), member('a')], () => managers);
  await f.dispatcher.schedule();
  assert.deepEqual(f.client.sent, [], 'being the manager sends nothing');
  f.room.queueAdd('plan the week', 'manager');
  f.room.queueAdd('write the page', 'a');
  await f.dispatcher.schedule();
  assert.deepEqual(f.client.sent.map(([id]) => id).sort(), ['a', 'manager']);
  const text = id => f.client.sent.find(([target]) => target === id)[1];
  assert.match(text('manager'), /plan the week[\s\S]*你是这个空间的项目经理/u);
  assert.equal(text('a').includes('项目经理'), false);
  assert.ok(text('manager').split('\n').at(-1).startsWith('你是这个空间的项目经理'));
});

test("a member that manages another space is told nothing of it with this space's item", async t => {
  const f = await dispatcher(t, [member('a')], () => ({ other: { sessionId: 'a', nativeId: 'native-a' } }));
  f.room.queueAdd('write the page', 'a');
  await f.dispatcher.schedule();
  assert.equal(f.client.sent.length, 1);
  assert.equal(f.client.sent[0][1].includes('项目经理'), false);
});

test('the role is read again just before sending', async t => {
  let managers = {}, reads = 0;
  const f = await dispatcher(t, [member('a')], () => {
    reads += 1;
    // The plan reads no manager; by the send the person has made this member the manager.
    return reads === 1 ? {} : managers;
  });
  reads = 0;
  managers = { shared: { sessionId: 'a', nativeId: 'native-a' } };
  const id = f.room.queueAdd('from the former manager', null, 'shared', BY_MANAGER);
  await f.dispatcher.schedule();
  assert.ok(reads >= 2);
  assert.deepEqual(f.client.sent, []);
  assert.equal(f.room.queueFind('shared', id).status, 'queued');
  assert.deepEqual(f.room.queueWaits.get(id), [{ sessionId: 'a', reason: 'manager-item' }]);
});

test('a role that cannot be read stops no other item', async t => {
  const f = await dispatcher(t, [member('a')], () => { throw Error('unreadable'); });
  const held = f.room.queueAdd('from a manager', null, 'shared', BY_MANAGER), sent = f.room.queueAdd('from the person', null);
  await f.dispatcher.schedule();
  assert.deepEqual([held, sent].map(id => f.room.queueFind('shared', id).status), ['queued', 'sent']);
  assert.equal(f.client.sent[0][1].includes('项目经理'), false);
});
