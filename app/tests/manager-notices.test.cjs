// R253 (the person, 2026-11-25, after two sessions they opened joined a space and were sent its manager's items while
// the manager sat idle: 「你咋没反应?我已经点了卡了」「或者是你没有感知到这个变动,需要修」). A space's project manager is
// told when a session joins or leaves its space and when an item it added is sent or comes back. Real QueueDispatcher
// and RoomState, joined by main.cjs's own wiring.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const rules = require('../queue-dispatch.cjs');
const { RoomState } = require('../room-state.cjs');
// Missing before this change: every test below then fails on what the manager was (not) told.
let notices = null; try { notices = require('../manager-notices.cjs'); } catch { /* Old code. */ }
const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
const NOW = 1_800_000_000_000;

class FakeClient extends EventEmitter {
  constructor(sessions) {
    super();
    this.state = { sessions, rooms: [{ id: 'shared', revision: 0, run: null, messages: [] }], wakePolicy: { enabled: true }, capabilities: [rules.CAPABILITY] };
    this.calls = [];
  }
  snapshot() { return structuredClone(this.state); }
  async refresh() { return this.snapshot(); }
  close() {}
  route(id) {
    if (!this.state.sessions.some(s => s.id === id)) throw Error('unknown session');
    return { client: this, state: { capabilities: [rules.CAPABILITY] } };
  }
  async call(method, ...args) {
    this.calls.push([method, ...args]);
    if (method === 'initial') return this.snapshot();
    if (method === 'dispatch') {
      this.session(args[0]).state = 'working';
      return `tag-${this.calls.length}`;
    }
    throw Error(`unexpected ${method}`);
  }
  session(id) { return this.state.sessions.find(s => s.id === id); }
  set(id, changes) { Object.assign(this.session(id), changes); this.emit('state', this.snapshot()); }
}
const agent = (id, name, roomIds, extra = {}) => ({ id, name, provider: 'claude', nativeId: 'native-' + id, model: 'test-model', state: 'idle', roomIds, roomId: null,
  createdAt: NOW - 3600000, background: 0, scheduled: 0, backgroundStale: false, chatAvailable: true, liveDraft: '', serviceCapabilities: [rules.CAPABILITY], fleet: [], messages: [], ...extra });

test('main.cjs keeps one store of what is owed to managers and gives it to the dispatcher', () => {
  assert.match(main, /^const managerNotices = new ManagerNotices\(\);$/m);
  const dispatcher = main.slice(main.indexOf('async function startQueueDispatcher'), main.indexOf('queueDispatcher = await new QueueDispatcher(options)'));
  assert.match(dispatcher, /\n {6}managerNotices,\n/);
});

async function fixture(t, { window = false, managed = true, manager = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-manager-notice-')); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { now: NOW }, now = () => clock.now;
  const rooms = new RoomState(dir), space = rooms.create('Plans');
  const client = new FakeClient([agent('pm', 'PM', [space], manager), agent('worker', 'Worker', [space]), agent('newcomer', 'Newcomer', [])]);
  const designation = { [space]: { sessionId: 'pm', nativeId: 'native-pm' } };
  const dispatcher = new rules.QueueDispatcher({ roomState: rooms, dataDir: dir, connect: async () => client, now, settleMs: 8000, tickMs: 3000,
    transcriptRoot: path.join(dir, 'none'), observePersonActions: () => {}, ...(window ? { clients: () => client } : {}),
    managers: () => managed ? designation : {}, ...(notices ? { managerNotices: new notices.ManagerNotices({ now }) } : {}) });
  t.after(() => dispatcher.close());
  await dispatcher.start(); clearInterval(dispatcher.timer);
  const pass = () => dispatcher.schedule();
  const elapse = async ms => { for (let left = ms; left > 0; left -= 3000) { clock.now += Math.min(3000, left); await pass(); } };
  const told = () => client.calls.filter(call => call[0] === 'dispatch' && /^manager-notice:/u.test(call[4]));
  const join = (id, ...ids) => client.set(id, { roomIds: ids });
  return { clock, client, rooms, space, dispatcher, pass, elapse, told, join };
}

for (const window of [false, true]) {
  test(`${window ? 'with' : 'without'} a window: the manager is told once a session joins and once it leaves its space, nothing in between`, async t => {
    const f = await fixture(t, { window });
    await f.elapse(70000);
    assert.deepEqual(f.told(), [], 'the members it found at first are not news');
    f.join('newcomer', f.space);
    await f.elapse(75000);
    assert.equal(f.told().length, 1);
    const [, id, text, nativeId] = f.told()[0];
    assert.deepEqual([id, nativeId], ['pm', 'native-pm'], 'into the manager\'s own conversation');
    assert.match(text, /^【NAW 空间变动】你管的空间「Plans」/u);
    assert.match(text, /- Newcomer（newcomer）进了空间/u, 'who, with the id to message it by');
    assert.match(text, /NAW 只告诉你发生了什么/u);
    f.client.set('pm', { state: 'idle' });
    await f.elapse(120000);
    assert.equal(f.told().length, 1, 'nothing changed: nothing more');
    f.join('newcomer');
    await f.elapse(75000);
    assert.equal(f.told().length, 2);
    assert.match(f.told()[1][2], /- Newcomer（newcomer）离开了空间/u);
    f.client.set('pm', { state: 'idle' });
    await f.elapse(120000);
    assert.equal(f.told().length, 2);
    assert.equal(f.dispatcher.hasOpenWork(), false, 'nothing owed keeps the passes going');
  });
}

test('an item the manager added is told when it is sent and when it comes back with READY; the person\'s and the butler\'s too', async t => {
  const f = await fixture(t);
  await f.elapse(12000);
  f.rooms.queueAdd('Write the parser', null, f.space, { kind: 'secretary', name: 'PM', sessionId: 'pm' });
  f.dispatcher.dirty = true;
  await f.elapse(30000);
  const out = f.rooms.queueItems(f.space).find(item => item.text === 'Write the parser');
  assert.deepEqual([out.status, out.sentTo], ['sent', 'worker'], 'a manager\'s item goes to a member, not to it');
  await f.elapse(75000);
  assert.equal(f.told().length, 1);
  assert.match(f.told()[0][2], new RegExp(`- 你加的队列项 ${out.id}「Write the parser」：派给了 Worker`, 'u'));
  f.client.set('pm', { state: 'idle' });
  f.rooms.queueSettle(f.space, out.id, 'done', '', 'Worker', 'Done.', undefined, { branch: 'lane/parser', commit: 'abc1234' });
  f.client.set('worker', { state: 'idle' });
  await f.elapse(75000);
  assert.equal(f.told().length, 2);
  assert.match(f.told()[1][2], new RegExp(`- 你加的队列项 ${out.id}「Write the parser」：Worker 交付了：READY lane/parser abc1234`, 'u'));
  f.client.set('pm', { state: 'idle' });
  // The review of 8f89855a: the acceptance names the queue's sends and deliveries in the space, whoever added them.
  const person = f.rooms.queueAdd('Person task', 'worker', f.space);
  const butler = f.rooms.queueAdd('Butler task', 'worker', f.space, { kind: 'secretary', name: 'Butler', sessionId: 'butler' }, 'steward');
  f.dispatcher.dirty = true;
  await f.elapse(90000);
  assert.equal(f.rooms.queueItems(f.space).find(item => item.id === person).status, 'sent');
  assert.equal(f.told().length, 3);
  assert.match(f.told()[2][2], new RegExp(`- 人加的队列项 ${person}「Person task」：派给了 Worker`, 'u'));
  assert.doesNotMatch(f.told()[2][2], /Butler task/u, 'still in the queue: not news yet');
  f.client.set('pm', { state: 'idle' });
  f.rooms.queueSettle(f.space, person, 'done', '', 'Worker', 'Done.');
  f.client.set('worker', { state: 'idle' });
  await f.elapse(90000);
  assert.equal(f.rooms.queueItems(f.space).find(item => item.id === butler).status, 'sent');
  const later = f.told().slice(3).map(call => call[2]).join('\n');
  assert.match(later, new RegExp(`- 人加的队列项 ${person}「Person task」：Worker 做完了`, 'u'));
  assert.match(later, new RegExp(`- 大管家加的队列项 ${butler}「Butler task」：派给了 Worker`, 'u'));
});

// Review of 8f89855a, B1: a member's backend restarting, moving or updating takes it out of the list for a moment; the
// manager was told it left and then that it joined, a model turn each, for a move that never happened.
test('a member missing from the list for a moment is no news; one archived, or missing for long, has left', async t => {
  const f = await fixture(t);
  await f.elapse(12000);
  const away = id => {
    f.client.state.sessions = f.client.state.sessions.filter(s => s.id !== id);
    f.client.emit('state', f.client.snapshot());
  };
  const worker = f.client.session('worker');
  away('worker');
  await f.elapse(75000);
  f.client.state.sessions.push(worker);
  f.client.emit('state', f.client.snapshot());
  await f.elapse(150000);
  assert.deepEqual(f.told(), [], 'missing once and back: nothing owed');
  assert.equal(f.dispatcher.hasOpenWork(), false);
  // Archived in the space record (RoomState.apply sets each listed session's `archived` from it).
  f.rooms.update({ archivedSessions: [...f.rooms.value.archivedSessions, 'worker'] });
  f.client.emit('state', f.client.snapshot());
  await f.elapse(75000);
  assert.equal(f.told().length, 1);
  assert.match(f.told()[0][2], /- Worker（worker）离开了空间/u, 'listed and archived: gone now');
  f.client.set('pm', { state: 'idle' });
  f.join('newcomer', f.space);
  await f.elapse(75000);
  assert.equal(f.told().length, 2);
  f.client.set('pm', { state: 'idle' });
  away('newcomer');
  await f.elapse(notices.ABSENT_MS - 60000);
  assert.equal(f.told().length, 2, 'missing for less than the absence limit: not yet');
  await f.elapse(150000);
  assert.equal(f.told().length, 3);
  assert.match(f.told()[2][2], /- Newcomer（newcomer）离开了空间/u, 'missing for long: gone');
});

// The store alone, for what the dispatcher-level tests above cannot reach in a few passes.
const A = '22222222-2222-4222-8222-222222222222', B = '33333333-3333-4333-8333-333333333333';
const PM = { sessionId: 'pm', nativeId: 'native-pm' };
const member = (id, roomIds, extra = {}) => ({ id, name: id[0].toUpperCase() + id.slice(1), nativeId: 'native-' + id, roomIds, ...extra });
function store() {
  const clock = { now: NOW }, n = new notices.ManagerNotices({ now: () => clock.now });
  const messages = [];
  const deliver = () => {
    for (const target of n.due(clock.now)) {
      const told = n.take(target);
      messages.push(notices.managerText(told));
      n.sent(target, told);
    }
  };
  return { clock, n, messages, deliver };
}

test('a member out of the space and back before it was told: nothing owed', () => {
  const { clock, n } = store();
  const sessions = [member('pm', [A]), member('worker', [A])], rooms = [{ id: A, name: 'Plans', queue: [] }];
  n.observe(rooms, sessions, { [A]: PM }, clock.now);
  sessions[1].roomIds = [];
  clock.now += 3000;
  assert.equal(n.observe(rooms, sessions, { [A]: PM }, clock.now), true);
  sessions[1].roomIds = [A];
  clock.now += 3000;
  n.observe(rooms, sessions, { [A]: PM }, clock.now);
  assert.equal(n.waiting(), false);
});

test('one manager of two spaces hears each space\'s changes under that space\'s name', () => {
  const { clock, n, messages, deliver } = store();
  const sessions = [member('pm', [A, B]), member('worker', [A])];
  const rooms = [{ id: A, name: 'Plans', queue: [] }, { id: B, name: 'Ops', queue: [] }], managers = { [A]: PM, [B]: PM };
  n.observe(rooms, sessions, managers, clock.now);
  sessions[1].roomIds = [B];
  clock.now += 3000;
  n.observe(rooms, sessions, managers, clock.now);
  clock.now += 15000;
  deliver();
  assert.equal(messages.length, 1);
  assert.match(messages[0], /^【NAW 空间变动】你管的 2 个空间有变动：\n「Plans」：\n- Worker（worker）离开了空间\n「Ops」：\n- Worker（worker）进了空间\n/u);
});

test('a manager revoked or replaced before its message went is not told about that space', () => {
  for (const after of [{}, { [A]: { sessionId: 'other', nativeId: 'native-other' } }]) {
    const { clock, n } = store();
    const sessions = [member('pm', [A]), member('worker', [A]), member('newcomer', [])], rooms = [{ id: A, name: 'Plans', queue: [] }];
    n.observe(rooms, sessions, { [A]: PM }, clock.now);
    sessions[2].roomIds = [A];
    clock.now += 3000;
    n.observe(rooms, sessions, { [A]: PM }, clock.now);
    assert.equal(n.waiting(), true);
    clock.now += 3000;
    n.observe(rooms, sessions, after, clock.now);
    n.prune(sessions, clock.now);
    assert.equal(n.waiting(), false, JSON.stringify(after));
  }
});

test('the person\'s item sent to the manager itself is no news to it', () => {
  const { clock, n } = store();
  const sessions = [member('pm', [A]), member('worker', [A])];
  const item = { id: 'item-1', text: 'Plan it', status: 'queued', creator: { kind: 'person', name: 'You', sessionId: null } };
  const rooms = [{ id: A, name: 'Plans', queue: [item] }];
  n.observe(rooms, sessions, { [A]: PM }, clock.now);
  for (const change of [{ status: 'sent', sentTo: 'pm' }, { status: 'done' }]) {
    Object.assign(item, change);
    clock.now += 3000;
    n.observe(rooms, sessions, { [A]: PM }, clock.now);
  }
  assert.equal(n.waiting(), false);
});

test('a long reason is cut like an item\'s text', () => {
  const { clock, n, messages, deliver } = store();
  const sessions = [member('pm', [A]), member('worker', [A])];
  const item = { id: 'item-1', text: 'Parser', status: 'sent', sentTo: 'worker', creator: { kind: 'secretary', sessionId: 'pm' } };
  const rooms = [{ id: A, name: 'Plans', queue: [item] }];
  n.observe(rooms, sessions, { [A]: PM }, clock.now);
  Object.assign(item, { status: 'waiting', reason: 'why '.repeat(200) });
  clock.now += 3000;
  n.observe(rooms, sessions, { [A]: PM }, clock.now);
  clock.now += 15000;
  deliver();
  const line = messages[0].split('\n').find(text => text.includes('item-1'));
  assert.ok(line.length < 120, line);
  assert.match(line, /Worker 那边停下了，等人看（why why .*…）$/u);
});

test('an item NAW keeps sending and its member keeps refusing is told so often, then only how it ends', () => {
  const { clock, n, messages, deliver } = store();
  const sessions = [member('pm', [A]), member('worker', [A])];
  const item = { id: 'item-1', text: 'Bounce', status: 'queued', creator: { kind: 'secretary', sessionId: 'pm' } };
  const rooms = [{ id: A, name: 'Plans', queue: [item] }];
  const look = () => n.observe(rooms, sessions, { [A]: PM }, clock.now);
  look();
  for (let round = 0; round < 6; round += 1) {
    Object.assign(item, { status: 'sent', sentTo: 'worker' });
    clock.now += 5000;
    look();
    Object.assign(item, { status: 'queued', sentTo: null, reason: 'refused' });
    clock.now += 5000;
    look();
    clock.now += 60000;
    deliver();
  }
  assert.equal(messages.length, 3, 'not one a minute for as long as it goes on');
  assert.match(messages.at(-1), /之后它再派出或退回不再告诉你/u);
  assert.doesNotMatch(messages[0], /不再告诉你/u);
  Object.assign(item, { status: 'sent', sentTo: 'worker' });
  clock.now += 5000;
  look();
  Object.assign(item, { status: 'done' });
  clock.now += 5000;
  look();
  clock.now += 60000;
  deliver();
  assert.equal(messages.length, 4);
  assert.match(messages.at(-1), /- 你加的队列项 item-1「Bounce」：Worker 做完了/u);
});

test('a manager at work is told only after its turn, everything since in one message, a minute after the last one at least', async t => {
  const f = await fixture(t, { manager: { state: 'working' } });
  await f.elapse(12000);
  f.join('newcomer', f.space);
  await f.elapse(60000);
  assert.deepEqual(f.told(), [], 'at work: nothing yet');
  f.join('worker');
  f.client.set('pm', { state: 'idle' });
  await f.elapse(30000);
  assert.equal(f.told().length, 1, 'both changes in one message');
  assert.match(f.told()[0][2], /Newcomer（newcomer）进了空间[^]*Worker（worker）离开了空间|Worker（worker）离开了空间[^]*Newcomer（newcomer）进了空间/u);
  f.client.set('pm', { state: 'idle' });
  f.join('worker', f.space);
  await f.elapse(30000);
  assert.equal(f.told().length, 1, 'not within a minute of the last one');
  await f.elapse(45000);
  assert.equal(f.told().length, 2);
});

test('a space with no manager, or with automatic messages off, tells nobody', async t => {
  const none = await fixture(t, { managed: false });
  await none.elapse(12000);
  none.join('newcomer', none.space);
  await none.elapse(90000);
  assert.deepEqual(none.told(), []);
  const off = await fixture(t);
  await off.elapse(12000);
  off.client.state.wakePolicy = { enabled: false };
  off.join('newcomer', off.space);
  await off.elapse(90000);
  assert.deepEqual(off.told(), [], 'off: not sent');
  off.client.state.wakePolicy = { enabled: true };
  off.client.emit('state', off.client.snapshot());
  await off.elapse(30000);
  assert.equal(off.told().length, 1, 'told once they are on again');
});
