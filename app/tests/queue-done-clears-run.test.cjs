// R232: the dispatcher's own passes, and a real backend process with a synthetic provider. What the backend clears and
// what it leaves is in session-wake.test.cjs; that every loop still stops, in session-wake-loop-bound.test.cjs.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { fork } = require('node:child_process');
const rules = require('../queue-dispatch.cjs');
const { RoomState } = require('../room-state.cjs');
const NOW = 1_800_000_000_000, QUEUE_DONE = 'agentWakeQueueDoneV1';

class Client extends EventEmitter {
  constructor(capabilities) {
    super();
    this.capabilities = [rules.CAPABILITY, ...capabilities];
    this.calls = [];
    this.entry = { client: this, state: { capabilities: this.capabilities } };
    this.answer = async () => true;
    this.state = { wakePolicy: { enabled: true }, capabilities: this.capabilities, rooms: [{ id: 'shared', revision: 0, run: null, messages: [] }],
      sessions: [{ id: 'a', name: 'Agent a', provider: 'claude', nativeId: 'native-a', model: 'test-model', state: 'idle', roomIds: ['shared'], roomId: 'shared',
        createdAt: NOW, background: 0, scheduled: 0, backgroundStale: false, chatAvailable: true, liveDraft: '', controlRevision: 0, draftRevision: 0,
        placementRevision: 0, serviceCapabilities: [rules.CAPABILITY], fleet: [], messages: [] }] };
  }
  snapshot() { return structuredClone(this.state); }
  async refresh() { return this.snapshot(); }
  close() {}
  route(id) { return id === 'butler' ? this.butlerEntry : this.entry; }
  async call(method, ...args) {
    this.calls.push([method, ...args]);
    if (method === 'wakeQueueDone') return this.answer(...args);
    assert.equal(method, 'dispatch', method);
    const tag = `tag-${this.calls.length}`, session = this.state.sessions[0];
    session.messages.push({ id: tag, role: 'user', text: args[1], origin: 'naw-dispatch', status: 'submitted', dispatchItem: args[3],
      dispatchPurpose: { kind: 'queue', itemId: args[3], nativeId: session.nativeId, epoch: null } });
    session.state = 'working';
    return tag;
  }
  reply(text) {
    const session = this.state.sessions[0], inputTag = session.messages.findLast(m => m.role === 'user').id;
    session.messages.push({ id: `reply-${session.messages.length}`, role: 'assistant', text, inputTag });
    session.state = 'idle';
    this.emit('state');
  }
  told() { return this.calls.filter(call => call[0] === 'wakeQueueDone').map(call => call[1]); }
  sent() { return this.calls.filter(call => call[0] === 'dispatch').map(call => call[4]); }
}
function setup(t, capabilities = [QUEUE_DONE], steward = () => null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-queue-done-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const room = new RoomState(dir), client = new Client(capabilities);
  const dispatcher = new rules.QueueDispatcher({ roomState: room, dataDir: dir, connect: async () => client, now: () => NOW, settleMs: 0, tickMs: 3600000, steward, sampleProcesses: async () => '', samplePressure: async () => '1\n' });
  t.after(() => dispatcher.close());
  const butlers = text => room.queueAdd(text, 'a', 'shared', { kind: 'secretary', name: 'Butler', sessionId: 'butler' }, 'steward');
  const pass = async () => { dispatcher.dirty = true; await dispatcher.schedule(); await dispatcher.schedule(); };
  const status = id => room.queueFind('shared', id).status;
  return { room, client, dispatcher, butlers, pass, status };
}
test('a pass that records the butler\'s item as done tells the member\'s backend once, then sends the next item', async t => {
  const f = setup(t), first = f.butlers('First.'), second = f.butlers('Second.');
  await f.dispatcher.start(); await f.pass();
  assert.deepEqual([f.client.sent(), f.client.told()], [[first], []]);
  f.client.reply('Done: the first.\nREADY lane/first 0123abcd'); await f.pass(); await f.pass();
  assert.deepEqual([f.status(first), f.client.told(), f.client.sent()], ['done', [{ sessionId: 'a', nativeId: 'native-a' }], [first, second]]);
  f.client.reply('Done: the second.'); await f.pass(); await f.pass();
  assert.deepEqual([f.status(second), f.client.told().length], ['done', 2], 'once for each item');
});
for (const [name, add, reply, status] of [
  ['the person\'s item', f => f.room.queueAdd('Mine.', 'a'), 'Done.', 'done'],
  ['a secretary\'s item', f => f.room.queueAdd('Theirs.', 'a', 'shared', { kind: 'secretary', name: 'Secretary', sessionId: 'secretary' }), 'Done.', 'done'],
  ['an item the butler\'s session queued as a secretary', f => f.room.queueAdd('Theirs.', 'a', 'shared', { kind: 'secretary', name: 'Butler', sessionId: 'butler' }), 'Done.', 'done'],
  ['a member\'s own item', f => f.room.queueAdd('Its own.', 'a', 'shared', { kind: 'secretary', name: 'Agent a', sessionId: 'a' }), 'Done.', 'done'],
  ['a question for the person', f => f.butlers('Ask.'), '需要你决定：which one?', 'waiting'],
  ['an empty reply', f => f.butlers('Nothing.'), '   ', 'waiting'],
]) test(`nothing is told after ${name}`, async t => {
  const f = setup(t), id = add(f);
  await f.dispatcher.start(); await f.pass();
  f.client.reply(reply); await f.pass(); await f.pass();
  assert.deepEqual([f.status(id), f.client.told()], [status, []]);
});
test('a decision the person answers from its card, and an item marked handled while out, tell nothing', async t => {
  const f = setup(t), asked = f.butlers('Ask.');
  await f.dispatcher.start(); await f.pass();
  f.client.reply('需要你决定：which one?'); await f.pass();
  f.room.queueResolve(asked, 'shared', null, 'The first.');
  const out = f.butlers('Out.');
  await f.pass();
  assert.equal(f.status(out), 'sent');
  f.room.queueResolve(out, 'shared', 'steward');
  f.client.reply('Done.'); await f.pass(); await f.pass();
  assert.deepEqual([f.status(asked), f.status(out), f.client.told()], ['done', 'done', []]);
});
function withButler(f) {
  const other = [];
  f.client.state.sessions.push({ ...structuredClone(f.client.state.sessions[0]), id: 'butler', name: 'Butler', nativeId: 'native-butler', roomIds: [], roomId: null });
  f.client.butlerEntry = { state: { capabilities: [QUEUE_DONE] }, client: { async call(...args) { other.push(args[0]); return true; } } };
  return other;
}
test('only the backend of the member that had the item is told, not the butler\'s', async t => {
  const f = setup(t, [QUEUE_DONE], () => ({ sessionId: 'butler', nativeId: 'native-butler' })), other = withButler(f), id = f.butlers('First.');
  await f.dispatcher.start(); await f.pass();
  f.client.reply('Done.'); await f.pass(); await f.pass();
  assert.deepEqual([f.status(id), f.client.told(), other], ['done', [{ sessionId: 'a', nativeId: 'native-a' }], []]);
});
test('a member no longer listed is told of nowhere, and its item is still done', async t => {
  const f = setup(t), id = f.butlers('First.');
  await f.dispatcher.start(); await f.pass();
  assert.equal(f.status(id), 'sent');
  f.dispatcher.settle({ kind: 'settle', roomId: 'shared', itemId: id, status: 'done', sessionId: 'a' }, { sessions: [] });
  await new Promise(setImmediate);
  assert.deepEqual([f.status(id), f.client.told()], ['done', []]);
});
for (const [name, break_] of [
  ['refuses', f => { f.client.answer = async () => { throw Error('Synthetic refusal'); }; }],
  ['never answers', f => { f.client.answer = () => new Promise(() => {}); }],
  ['is being replaced', f => { f.client.operationGuard = () => () => { if (f.client.told().length === 0 && f.client.sent().length === 1 && !f.let) { f.let = true; throw Error('Synthetic update'); } }; }],
]) test(`a backend that ${name} holds nothing up and is not asked again`, async t => {
  const f = setup(t), first = f.butlers('First.'), second = f.butlers('Second.');
  await f.dispatcher.start(); await f.pass();
  break_(f);
  f.client.reply('Done: the first.'); await f.pass(); await f.pass();
  assert.deepEqual([f.status(first), f.client.sent()], ['done', [first, second]]);
  assert.equal(f.client.told().length, name === 'is being replaced' ? 0 : 1);
});
test('an item put back in the queue and sent again, and one its member claimed, are told once', async t => {
  const f = setup(t), id = f.butlers('First.');
  await f.dispatcher.start(); await f.pass();
  f.client.state.sessions[0].state = 'idle';
  f.room.queueRequeue('shared', id, 'busy', 5, 'A');
  await f.pass();
  assert.deepEqual([f.status(id), f.client.told()], ['sent', []]);
  f.client.reply('Done.'); await f.pass(); await f.pass();
  assert.deepEqual([f.status(id), f.client.told().length], ['done', 1]);
  const session = f.client.state.sessions[0];
  session.messages.push({ id: 'board-turn', role: 'user', text: 'take it', origin: 'human', status: 'submitted' });
  session.state = 'working';
  const claimed = f.butlers('Claimed.');
  f.room.queueClaim(claimed, 'shared', { name: 'Agent a', sessionId: 'a', control: 0, input: 'board-turn' }, NOW);
  f.client.reply('Done: it.'); await f.pass(); await f.pass();
  assert.deepEqual([f.status(claimed), f.client.told().length], ['done', 2]);
});
test('a backend without the capability is not asked', async t => {
  const f = setup(t, []), id = f.butlers('First.');
  await f.dispatcher.start(); await f.pass();
  f.client.reply('Done.'); await f.pass();
  assert.deepEqual([f.status(id), f.client.told()], ['done', []]);
});

async function service(directory, running) {
  const { connect } = require('../service-client.cjs'), root = path.resolve(__dirname, '../..');
  const child = fork(path.join(root, 'app/daemon.cjs'), [directory], { execArgv: ['--require', path.join(root, 'scripts/fixtures/native-progress.cjs')],
    env: { PATH: process.env.PATH, HOME: directory, TMPDIR: os.tmpdir(), NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: directory }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let client;
  const stop = async () => {
    client?.close();
    if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; }
  };
  running.stop = stop;
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(path.join(directory, 'connection.json'))) {
    assert.ok(Date.now() < deadline && child.exitCode === null, 'the synthetic service starts');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  client = await connect(directory, 'queue-done-test');
  return client;
}
test('a real backend offers it, clears the saved run of the butler to the member only, and answers false when there is none', { timeout: 30000 }, async t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-queue-done-service-')));
  const running = { stop: async () => {} };
  t.after(async () => { await running.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  const file = path.join(directory, 'workspace.json'), member = value => value.sessions.find(s => s.name === 'Member');
  let client = await service(directory, running);
  const id = await client.call('create', { provider: 'codex', cwd: directory, name: 'Member', view: 'terminal' });
  const butler = await client.call('create', { provider: 'codex', cwd: directory, name: 'Butler', view: 'terminal' });
  await client.refresh();
  const nativeId = client.snapshot().sessions.find(s => s.id === id).nativeId;
  const butlerNative = client.snapshot().sessions.find(s => s.id === butler).nativeId;
  assert.ok(nativeId && butlerNative && butlerNative !== nativeId);
  assert.equal(await client.route(id).client.call('wakeQueueDone', { sessionId: id, nativeId }), false);
  await running.stop();
  const saved = JSON.parse(fs.readFileSync(file)), theButler = value => value.sessions.find(s => s.name === 'Butler');
  const budget = { version: 2, lastAt: 123, humanRevision: member(saved).wakeHumanRevision || 0, senders: { [butlerNative]: { id: 'm8', streak: 8 }, 'native-other': { id: 'm2', streak: 2 } } };
  const toButler = { version: 2, lastAt: 456, humanRevision: theButler(saved).wakeHumanRevision || 0, senders: { [nativeId]: { id: 'b8', streak: 8 }, 'native-other': { id: 'b1', streak: 1 } } };
  member(saved).wakeBudget = budget; theButler(saved).wakeBudget = toButler;
  fs.writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
  fs.writeFileSync(path.join(directory, 'steward.json'), JSON.stringify({ version: 1, selected: { sessionId: butler, nativeId: butlerNative } }), { mode: 0o600 });
  client = await service(directory, running);
  await client.refresh();
  const entry = client.route(id), now = () => { const value = JSON.parse(fs.readFileSync(file)); return [member(value).wakeBudget, theButler(value).wakeBudget]; };
  assert.ok(entry.state.capabilities.includes(QUEUE_DONE));
  assert.equal(await entry.client.call('wakeQueueDone', { sessionId: id, nativeId: 'native-else' }), false);
  assert.deepEqual(now(), [budget, toButler]);
  assert.equal(await entry.client.call('wakeQueueDone', { sessionId: id, nativeId }), true);
  assert.deepEqual(now(), [{ ...budget, senders: { ...budget.senders, [butlerNative]: { id: 'm8', streak: 0 } } }, toButler], 'another sender to the member, and the member to the butler, stay');
  assert.equal(await entry.client.call('wakeQueueDone', { sessionId: id, nativeId }), false);
});
