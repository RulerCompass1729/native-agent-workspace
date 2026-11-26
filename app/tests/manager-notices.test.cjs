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

test('an item the manager added is told when it is sent and when it comes back with READY; the person\'s item is not', async t => {
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
  f.rooms.queueAdd('Person task', 'worker', f.space);
  f.rooms.queueAdd('Butler task', 'worker', f.space, { kind: 'secretary', name: 'Butler', sessionId: 'butler' }, 'steward');
  f.dispatcher.dirty = true;
  await f.elapse(90000);
  assert.equal(f.rooms.queueItems(f.space).find(item => item.text === 'Person task').status, 'sent');
  f.rooms.queueSettle(f.space, f.rooms.queueItems(f.space).find(item => item.text === 'Person task').id, 'done', '', 'Worker', 'Done.');
  f.client.set('worker', { state: 'idle' });
  await f.elapse(90000);
  assert.equal(f.rooms.queueItems(f.space).find(item => item.text === 'Butler task').status, 'sent');
  assert.equal(f.told().length, 2, 'not an item the manager did not add, the person\'s or the butler\'s');
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
