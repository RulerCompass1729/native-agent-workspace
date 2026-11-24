// After the person answers an agent's confirmation card, the agent that asked is told (the person, 2026-11-13 20:0x:
// 「我发现我每次做完操作之后你没有反应,这其实也算是一个 bug」; queue e4432e37). Real BackgroundControl and QueueDispatcher,
// joined by main.cjs's own wiring: the store it keeps, the callbacks it gives background control, the dispatcher option.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { BackgroundControl, dialog } = require('../background-control.cjs');
const rules = require('../queue-dispatch.cjs');
const { RoomState } = require('../room-state.cjs');
// Missing before this change: every test below then fails on what the agent was (not) told, not on loading.
let notices = null; try { notices = require('../answer-notices.cjs'); } catch { /* Old code. */ }
const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
const NOW = 1_800_000_000_000;

class FakeClient extends EventEmitter {
  constructor(sessions) {
    super();
    this.state = { sessions, rooms: [{ id: 'shared', revision: 0, run: null, messages: [] }], wakePolicy: { enabled: true }, capabilities: [rules.CAPABILITY] };
    this.calls = []; this.failures = [];
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
      if (this.failures.length) throw this.failures.shift();
      this.state.sessions.find(s => s.id === args[0]).state = 'working';
      return `tag-${this.calls.length}`;
    }
    throw Error(`unexpected ${method}`);
  }
  dispatches() { return this.calls.filter(call => call[0] === 'dispatch'); }
  set(changes) { Object.assign(this.state.sessions[0], changes); this.emit('state', this.snapshot()); }
}
const agent = (provider, extra = {}) => ({ id: 'agent', name: 'Asker', provider, nativeId: 'native', model: 'test-model', state: 'idle', roomIds: [], roomId: null,
  createdAt: NOW - 3600000, background: 0, scheduled: 0, backgroundStale: false, chatAvailable: true, liveDraft: '', serviceCapabilities: [rules.CAPABILITY], fleet: [], messages: [], ...extra });

// main.cjs's wiring, read from main.cjs itself; the store is made here with the test's clock.
function wiring(now) {
  assert.match(main, /^const answerNotices = new AnswerNotices\(\);$/m, 'main.cjs keeps what the person answered for the agent that asked');
  const a = main.indexOf('\n    decided: '), b = main.indexOf('\n    project: projectBackgroundRecord,', a);
  assert.ok(a > 0 && b > a, 'main.cjs gives background control the person\'s answers');
  const dispatcher = main.slice(main.indexOf('async function startQueueDispatcher'), main.indexOf('queueDispatcher = await new QueueDispatcher(options)'));
  assert.match(dispatcher, /\n {6}answerNotices,\n/, 'main.cjs gives them to the dispatcher');
  assert.ok(notices, 'answer-notices.cjs');
  const answerNotices = new notices.AnswerNotices({ now });
  return { answerNotices, callbacks: vm.runInNewContext(`({${main.slice(a, b)}})`, { answerNotices }) };
}
async function fixture(t, provider, session = agent(provider)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-answer-notice-')); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { now: NOW }, now = () => clock.now, sender = { id: session.id, nativeId: session.nativeId, provider, name: 'Asker' };
  let wired = null;
  try { wired = wiring(now); } catch (error) { wired = { error }; }
  const contexts = [];
  // A command the person must confirm, as a maintenance handler asks through dialog().
  const handlers = new Map([['stop', async c => { const answer = await dialog(c, 'message', { message: 'Stop?', buttons: ['Cancel', 'Stop'], cancelId: 0 }); return answer.response === 1 ? 'SECRET-HANDLER-VALUE' : null; }],
    // One that asks a second card after the first was confirmed.
    ['twice', async c => { if ((await dialog(c, 'message', { message: 'First?', buttons: ['Cancel', 'Go'], cancelId: 0 })).response !== 1) return null; await dialog(c, 'message', { message: 'Second?', buttons: ['Cancel', 'Go'], cancelId: 0 }); return null; }]]);
  const controller = new BackgroundControl({ dataDir: dir, handlers, now, ...(wired.callbacks || {}), context: async (actor, saved) => {
    const c = { background: true, view: saved || { selected: actor.id, draft: '' }, confirmationActors: () => [actor], checkActor: async () => {}, client: { close() {} }, win: { destroy() {} } };
    contexts.push(c); return c;
  } });
  const client = new FakeClient([session]), rooms = new RoomState(dir);
  // The app's own tick, so a pass runs only when the dispatcher would run one; the test's clock drives it, not a timer.
  const dispatcher = new rules.QueueDispatcher({ roomState: rooms, dataDir: dir, connect: async () => client, now, settleMs: 8000, tickMs: 3000,
    transcriptRoot: path.join(dir, 'none'), ...(wired.answerNotices ? { answerNotices: wired.answerNotices } : {}) });
  t.after(() => dispatcher.close());
  await dispatcher.start(); clearInterval(dispatcher.timer);
  const binding = { sender, identity: { nativeId: sender.nativeId, sessionId: 'native-session', turnId: 'turn', callId: 'call' }, valid: () => true };
  const ask = (id, method = 'stop') => controller.call(binding, { action: 'invoke', operation_id: id, method, arguments: [] });
  const answer = (id, response) => controller.decide(sender.id, sender.nativeId, id, response);
  const receipt = id => controller.call(binding, { action: 'receipt', operation_id: id });
  const pass = () => dispatcher.schedule();
  // Time passing as in the app: a pass every 3 seconds (queue-dispatch.cjs TICK_MS).
  const elapse = async ms => { for (let left = ms; left > 0; left -= 3000) { clock.now += Math.min(3000, left); await pass(); } };
  const told = () => client.dispatches().filter(call => /^answer-notice:/u.test(call[4]));
  return { clock, client, rooms, controller, dispatcher, contexts, ask, answer, receipt, pass, elapse, told, wired };
}

for (const provider of ['claude', 'codex']) {
  test(`${provider}: a card confirmed and one cancelled reach the agent that asked as one message, after its turn has ended`, async t => {
    const f = await fixture(t, provider, agent(provider, { state: 'working' }));
    assert.equal((await f.ask('op-a')).state, 'confirmation-required'); assert.equal((await f.ask('op-b')).state, 'confirmation-required');
    assert.equal((await f.answer('op-a', 1)).state, 'complete');
    await f.elapse(2000);
    assert.equal((await f.answer('op-b', 0)).state, 'cancelled');
    await f.elapse(30000);
    assert.deepEqual(f.told(), [], 'at work: it hears nothing yet');
    // Its turn ends: the backend says so and a pass sees it.
    f.client.set({ state: 'idle' }); await f.pass();
    await f.elapse(6000);
    assert.deepEqual(f.told(), [], 'just idle: not settled yet');
    await f.elapse(3000);
    const sent = f.told();
    assert.equal(sent.length, 1, 'one message for both answers');
    const [, id, text, nativeId] = sent[0];
    assert.deepEqual([id, nativeId], ['agent', 'native'], 'to the agent that asked, in its own native conversation');
    assert.match(text, /^【NAW 确认结果】/u);
    assert.match(text, /- op-a（stop）：人点了确认，回执状态 complete\n- op-b（stop）：人点了取消，回执状态 cancelled\n/u, 'each operation id, the answer and the outcome, in the order answered');
    assert.match(text, /workspace_control 的 receipt 读回执/u, 'where to read the rest');
    assert.match(text, /不替你重发或续做/u, 'only told');
    assert.doesNotMatch(text, /SECRET-HANDLER-VALUE/u, 'nothing the operation returned');
    assert.equal(f.client.calls.some(call => ['send', 'queue', 'claim', 'input', 'steer'].includes(call[0])), false, 'no human send, no takeover');
    // Told once: idle again, it is not told again.
    f.client.set({ state: 'idle' }); await f.elapse(60000);
    assert.equal(f.told().length, 1);
    assert.equal(f.dispatcher.hasOpenWork(), false, 'nothing keeps the passes going');
  });
}

test('an idle agent is told once the person stopped answering for a moment, answers a few seconds apart together', async t => {
  const f = await fixture(t, 'claude');
  await f.ask('op-a'); await f.ask('op-b'); await f.ask('op-c');
  await f.elapse(9000);
  await f.answer('op-a', 1);
  await f.elapse(5000);
  assert.deepEqual(f.told(), [], 'the person may still be answering');
  await f.answer('op-b', 1);
  // Alone, op-a would have gone 10 seconds after it was answered, the agent settled by then.
  await f.elapse(6000);
  assert.deepEqual(f.told(), [], 'a new answer holds it a little longer');
  await f.elapse(4000);
  assert.equal(f.told().length, 1);
  assert.match(f.told()[0][2], /op-a[^\n]*\n- op-b/u, 'both answers in it');
  assert.doesNotMatch(f.told()[0][2], /op-c/u, 'not the card still waiting for the person');
  // The last card answered later is its own message.
  f.client.set({ state: 'idle' }); await f.elapse(9000);
  await f.answer('op-c', 0);
  await f.elapse(12000);
  assert.equal(f.told().length, 2); assert.match(f.told()[1][2], /op-c（stop）：人点了取消/u);
});

test('an agent that read the receipt itself is not told; one read before the outcome still is', async t => {
  const f = await fixture(t, 'codex');
  await f.ask('op-a'); await f.ask('op-b');
  assert.equal((await f.receipt('op-b')).receipt.state, 'confirmation-required');
  await f.answer('op-a', 1); await f.answer('op-b', 1);
  assert.equal((await f.receipt('op-a')).receipt.state, 'complete', 'the agent reads it in the same turn');
  await f.elapse(21000);
  assert.equal(f.told().length, 1);
  assert.doesNotMatch(f.told()[0][2], /op-a/u, 'already known');
  assert.match(f.told()[0][2], /op-b（stop）：人点了确认，回执状态 complete/u, 'read only while it still waited');
  // Reading every outcome leaves nothing to tell.
  await f.ask('op-c'); await f.answer('op-c', 0); await f.receipt('op-c');
  f.client.set({ state: 'idle' }); await f.elapse(21000);
  assert.equal(f.told().length, 1); assert.equal(f.dispatcher.hasOpenWork(), false);
});

test('not carried out because the asking session changed: still told, with that outcome; an answer refused as stale tells nothing', async t => {
  const f = await fixture(t, 'claude');
  await f.ask('op-a');
  for (const c of f.contexts) c.checkActor = async () => { throw Error('The originating native session changed'); };
  assert.equal((await f.answer('op-a', 1)).state, 'unconfirmed');
  await assert.rejects(f.answer('op-a', 1), /no longer current/u);
  await f.elapse(21000);
  assert.equal(f.told().length, 1);
  assert.match(f.told()[0][2], /op-a（stop）：人点了确认，回执状态 unconfirmed\n用/u, 'one line, once');
});

test('in a space as a member, the agent is told the same way', async t => {
  const f = await fixture(t, 'codex', agent('codex', { roomIds: ['shared'], roomId: 'shared' }));
  await f.ask('op-a'); await f.answer('op-a', 0);
  await f.elapse(21000);
  assert.equal(f.told().length, 1); assert.match(f.told()[0][2], /人点了取消，回执状态 cancelled/u);
});

test('a queue member that ended its turn asking the person is told too; one whose item still runs only after the item settled', async t => {
  // Waiting for the person to decide (its turn ended with 需要你决定：): idle, it hears the answer; its item stays waiting.
  const f = await fixture(t, 'claude', agent('claude', { roomIds: ['shared'], roomId: 'shared' }));
  const held = f.rooms.queueAdd('Stop the old job', 'agent', 'shared');
  f.rooms.queueMarkSent('shared', held, 'agent', 'Asker', NOW); f.rooms.queueSettle('shared', held, 'waiting', '', 'Asker', '需要你决定：停掉旧任务吗？');
  await f.ask('op-a'); await f.answer('op-a', 1);
  await f.elapse(21000);
  assert.equal(f.told().length, 1, 'told while its item waits for the person');
  assert.equal(f.rooms.queueFind('shared', held).status, 'waiting', 'the item is left for the person');
  assert.equal(f.client.dispatches().length, 1, 'only the notice was sent');
  // With a next item for it: an open decision no longer holds the member from queue work (126658e7), so that item
  // goes to it, and the answer waits for that item as for any running one (below).
  const h = await fixture(t, 'claude', agent('claude', { roomIds: ['shared'], roomId: 'shared' }));
  const asks = h.rooms.queueAdd('Stop the old job', 'agent', 'shared');
  h.rooms.queueMarkSent('shared', asks, 'agent', 'Asker', NOW); h.rooms.queueSettle('shared', asks, 'waiting', '', 'Asker', '需要你决定：停掉旧任务吗？');
  const next = h.rooms.queueAdd('Then the new one', 'agent', 'shared');
  await h.ask('op-a'); await h.answer('op-a', 1);
  await h.elapse(21000);
  assert.equal(h.rooms.queueFind('shared', asks).status, 'waiting', 'the decision stays open');
  assert.equal(h.rooms.queueFind('shared', next).status, 'sent', 'its next item went to it');
  assert.deepEqual(h.told(), [], 'not while that item runs');
  // Its item still running (sent, the send not yet confirmed, so it cannot settle): nothing that could mix into the
  // item's reply; once the item settled, it is told.
  const g = await fixture(t, 'claude', agent('claude', { roomIds: ['shared'], roomId: 'shared' }));
  const running = g.rooms.queueAdd('Clean the build', 'agent', 'shared');
  g.rooms.queueMarkSent('shared', running, 'agent', 'Asker', NOW);
  await g.ask('op-a'); await g.answer('op-a', 0);
  const statusWhenTold = [], call = g.client.call.bind(g.client);
  g.client.call = (method, ...args) => { if (method === 'dispatch' && /^answer-notice:/u.test(args[3])) statusWhenTold.push(g.rooms.queueFind('shared', running).status); return call(method, ...args); };
  await g.elapse(30000);
  assert.deepEqual(g.told(), [], 'idle, but its item is still running');
  g.rooms.queueSetDelivery('shared', running, 'item-tag', 0);
  g.client.set({ messages: [{ id: 'item-tag', role: 'user', text: 'Clean the build', origin: 'naw-dispatch', dispatchItem: running,
    dispatchPurpose: { kind: 'queue', nativeId: g.client.state.sessions[0].nativeId, itemId: running, epoch: null }, status: 'submitted', time: NOW }, { id: 'r', role: 'assistant', text: 'Cleaned.', time: NOW + 1 }] });
  await g.elapse(21000);
  assert.equal(g.rooms.queueFind('shared', running).status, 'done', 'its item settled');
  assert.equal(g.told().length, 1, 'told after the item');
  assert.deepEqual(statusWhenTold, ['done'], 'not while the item was running');
});

test('a follow-up card is not told as an answer: the agent hears the person\'s last answer once', async t => {
  const f = await fixture(t, 'claude');
  await f.ask('op-a', 'twice');
  assert.equal((await f.answer('op-a', 1)).state, 'confirmation-required', 'the person is asked a second card');
  await f.elapse(30000);
  assert.deepEqual(f.told(), [], 'nothing while the second card waits');
  await f.answer('op-a', 0);
  await f.elapse(21000);
  assert.equal(f.told().length, 1);
  assert.match(f.told()[0][2], /op-a（twice）：人点了取消，回执状态 cancelled\n/u);
  assert.doesNotMatch(f.told()[0][2], /confirmation-required/u);
});

test('the person sent the task and answered a moment later: told about 20 seconds after their last input, not after the two minutes queue work waits; held while they type', async t => {
  const f = await fixture(t, 'claude');
  await f.elapse(9000);
  // The person's task to it (main.cjs counts 'send' as the person's own input), then the card it asked, answered.
  f.dispatcher.noteHuman('agent');
  await f.ask('op-a'); await f.elapse(3000); await f.answer('op-a', 1);
  await f.elapse(15000);
  assert.deepEqual(f.told(), [], 'the person typed into it under 20 seconds ago');
  await f.elapse(6000);
  assert.equal(f.told().length, 1, 'told 21 seconds after the task, not two minutes');
  assert.equal(rules.ANSWER_QUIET_MS, 20000); assert.equal(rules.HUMAN_QUIET_MS, 120000);
  // Typing in its terminal (input on every key, no draft): nothing while it goes on.
  f.client.set({ state: 'idle' }); await f.elapse(9000);
  await f.ask('op-b'); await f.answer('op-b', 0);
  for (let i = 0; i < 20; i++) { f.dispatcher.noteHuman('agent'); await f.elapse(3000); }
  assert.equal(f.told().length, 1, 'not while the person is typing');
  await f.elapse(21000);
  assert.equal(f.told().length, 2); assert.match(f.told()[1][2], /op-b（stop）：人点了取消/u);
});

test('kept while the agent cannot take it now; dropped when nobody is left to tell', async t => {
  const cases = [
    ['automatic messages off', f => { f.client.state.wakePolicy = { enabled: false }; f.client.emit('state', f.client.snapshot()); }, f => { f.client.state.wakePolicy = { enabled: true }; f.client.emit('state', f.client.snapshot()); }],
    ['a draft the person is typing', f => f.client.set({ liveDraft: 'half a sentence' }), f => f.client.set({ liveDraft: '' })],
  ];
  for (const [name, hold, release] of cases) {
    const f = await fixture(t, 'claude');
    await f.ask('op-a'); await f.answer('op-a', 1);
    hold(f);
    await f.elapse(21000);
    assert.deepEqual(f.told(), [], name);
    assert.equal(f.dispatcher.hasOpenWork(), true, `${name}: still owed`);
    release(f);
    await f.elapse(12000);
    assert.equal(f.told().length, 1, `${name}: told once it can take it`);
  }
  // Archived as the sidebar does it: in the space record the dispatcher applies.
  for (const [name, change] of [['archived', f => { f.rooms.value.archivedSessions.push('agent'); f.client.set({}); }], ['another native conversation under the id', f => f.client.set({ nativeId: 'native-other' })]]) {
    const f = await fixture(t, 'claude');
    await f.ask('op-a'); await f.answer('op-a', 1);
    change(f);
    await f.elapse(21000);
    assert.deepEqual(f.told(), [], name);
    assert.equal(f.dispatcher.hasOpenWork(), false, `${name}: nobody is left to tell`);
  }
});

test('a send that failed is tried again after a minute, not on every pass', async t => {
  const f = await fixture(t, 'claude');
  await f.ask('op-a'); await f.answer('op-a', 1);
  f.client.failures.push(Object.assign(Error('backend-update-needed'), { notSent: true }));
  await f.elapse(12000);
  assert.equal(f.client.dispatches().length, 1, 'tried');
  await f.elapse(54000);
  assert.equal(f.client.dispatches().length, 1, 'not again within the minute');
  await f.elapse(9000);
  assert.equal(f.told().length, 2); assert.match(f.told()[1][2], /op-a/u);
  assert.equal(f.dispatcher.hasOpenWork(), false);
});

test('what is owed stays bounded and old answers expire', () => {
  assert.ok(notices, 'answer-notices.cjs');
  const clock = { now: NOW }, store = new notices.AnswerNotices({ now: () => clock.now });
  for (let n = 0; n < notices.MAX_NOTICES + 5; n++) { clock.now += 1; store.add({ id: `s${n % 3}`, nativeId: 'n' }, { id: `op-${n}`, state: 'complete', command: { method: 'stop' } }, 'confirmed'); }
  const all = ['s0', 's1', 's2'].flatMap(id => store.take({ sessionId: id, nativeId: 'n' }).map(n => n.operationId));
  assert.equal(all.length, notices.MAX_NOTICES); assert.ok(!all.includes('op-0') && all.includes(`op-${notices.MAX_NOTICES + 4}`), 'the oldest go first');
  assert.equal(store.add({ id: 'x', nativeId: 'n' }, { id: 'op\nforged', state: 'complete' }, 'confirmed'), false, 'an id that is not a token is not kept');
  assert.equal(store.add({ id: 'x', nativeId: 'n' }, { id: 'op-x', state: 'complete' }, 'maybe'), false);
  clock.now += notices.MAX_AGE_MS + 1; store.prune([]);
  assert.equal(store.waiting(), false, 'a day later nobody waits for it');
});


test('a different task receipt cannot complete the item before an answer notice', async t => {
  const f = await fixture(t, 'claude', agent('claude', { roomIds: ['shared'], roomId: 'shared' }));
  const id = f.rooms.queueAdd('Synthetic running task', 'agent', 'shared'), member = f.client.state.sessions[0];
  f.rooms.queueMarkSent('shared', id, member.id, 'Asker', NOW, false, member.nativeId);
  f.rooms.queueSetDelivery('shared', id, 'item-tag', 0);
  f.client.set({ messages: [{ id: 'item-tag', role: 'user', text: 'Synthetic running task', time: NOW,
    origin: 'naw-dispatch', dispatchItem: 'different-item', status: 'submitted',
    dispatchPurpose: { kind: 'queue', nativeId: member.nativeId, itemId: 'different-item', epoch: null } },
    { id: 'reply', role: 'assistant', text: 'Done.\nREADY lane/synthetic abcdef1234567', time: NOW + 1 }] });
  await f.elapse(21000);
  const item = f.rooms.queueFind('shared', id);
  assert.equal(item.status, 'waiting');
  assert.equal(item.reason, 'input-purpose-unconfirmed');
  assert.equal(item.ready, undefined);
  assert.ok(!f.rooms.metadata('shared').events.some(event => event.monitor?.kind === 'ready'));
  assert.deepEqual(f.client.dispatches(), [], 'No input was replayed');
});

// Queue W4 (the person, 2026-11-20 and 11-23): a card that ran out before the person answered left the agent waiting until
// the person came to ask. It is told once; the same request running out again is not, so an agent asking again while
// the person is away is not woken in a loop. Read from the record, not the receipt: an agent that reads it is not told.
const recorded = (f, id) => f.controller.data.records.find(r => r.id === id).state;
test('a card nobody answered in time: the agent is told once nothing was done; the same request running out again is not told again', async t => {
  const f = await fixture(t, 'claude');
  assert.equal((await f.ask('op-a')).state, 'confirmation-required');
  f.clock.now += 10 * 60 * 1000; f.controller.expirePending();
  // The handler asks from inside its run, so the record says the rest was not carried out ('unconfirmed').
  assert.equal(f.controller.data.records.find(r => r.id === 'op-a').disposition, 'expired');
  await f.elapse(12000);
  assert.equal(f.told().length, 1, 'told that it ran out');
  assert.match(f.told()[0][2], new RegExp(`- op-a（stop）：人没在时限内答复，卡已过期，回执状态 ${recorded(f, 'op-a')}\\n`, 'u'));
  assert.doesNotMatch(f.told()[0][2], /人已经答复/u, 'the heading does not say the person answered');
  // Its handler had started: earlier steps may have run, so the line does not say nothing was done.
  assert.equal(recorded(f, 'op-a'), 'unconfirmed'); assert.doesNotMatch(f.told()[0][2], /没执行/u);
  f.client.set({ state: 'idle' });
  await f.ask('op-b'); f.clock.now += 10 * 60 * 1000; f.controller.expirePending();
  assert.equal(f.controller.data.records.find(r => r.id === 'op-b').disposition, 'expired');
  await f.elapse(60000);
  assert.equal(f.told().length, 1, 'the same request running out again is not told again');
  f.client.set({ state: 'idle' });
  await f.ask('op-c'); assert.equal((await f.answer('op-c', 1)).state, 'complete');
  await f.elapse(12000);
  assert.equal(f.told().length, 2); assert.match(f.told()[1][2], /- op-c（stop）：人点了确认/u);
});
test('the person clicked after the card ran out: the agent is told nothing was done, even after the same request ran out unanswered', async t => {
  const f = await fixture(t, 'claude');
  await f.ask('op-a'); f.clock.now += 10 * 60 * 1000; f.controller.expirePending();
  await f.elapse(12000);
  assert.equal(f.told().length, 1);
  f.client.set({ state: 'idle' });
  await f.ask('op-b'); f.clock.now += 10 * 60 * 1000;
  const late = await f.answer('op-b', 1);
  assert.equal(late.disposition, 'expired', 'clicked late: the rest is not carried out');
  await f.elapse(12000);
  assert.equal(f.told().length, 2, 'the person acted: the agent hears of it');
  assert.match(f.told()[1][2], new RegExp(`- op-b（stop）：人没在时限内答复，卡已过期，回执状态 ${late.state}\\n`, 'u'));
});
test('asked again while the first card still waits: the agent hears about the card that settles last, not the one it replaced', async t => {
  const f = await fixture(t, 'claude');
  await f.ask('op-a'); f.clock.now += 60000; await f.ask('op-b');
  f.clock.now += 9 * 60000; f.controller.expirePending();
  assert.equal(f.controller.data.records.find(r => r.id === 'op-a').disposition, 'expired');
  assert.equal(recorded(f, 'op-b'), 'confirmation-required');
  await f.elapse(12000);
  assert.deepEqual(f.told(), [], 'the later card of the same request still waits: nothing about the earlier one');
  f.clock.now += 60000; f.controller.expirePending();
  await f.elapse(12000);
  assert.equal(f.told().length, 1, 'the later card ran out: told, though the one it replaced ran out before it');
  assert.match(f.told()[0][2], /- op-b（stop）：人没在时限内答复，卡已过期/u); assert.doesNotMatch(f.told()[0][2], /op-a/u);
});
// Queue W4, M105 (the person, 2026-11-23): a card whose asking session was archived waited where no view shows it, and
// said a reconnect would let it be confirmed. It is settled as not carried out, saying why.
test('a card whose asking session was archived is settled as such; a missing or unreadable session leaves it waiting', async t => {
  const messages = require('../ui-messages.js');
  const f = await fixture(t, 'claude');
  await f.ask('op-a');
  const live = f.client.snapshot(), session = live.sessions[0];
  const card = snapshot => f.controller.confirmations(snapshot).find(c => c.operationId === 'op-a');
  for (const [name, snapshot] of [['live', live], ['missing from the list', { ...live, sessions: [] }], ['list unavailable', { ...live, unavailable: true, sessions: [{ ...session, archived: true }] }],
    ['another native conversation archived under the id', { ...live, sessions: [{ ...session, nativeId: 'native-other', archived: true }] }]]) {
    assert.notEqual(card(snapshot).reason, 'originator-archived', name);
    assert.equal(recorded(f, 'op-a'), 'confirmation-required', `${name}: still waiting`);
  }
  const settled = card({ ...live, sessions: [{ ...session, archived: true }] });
  assert.deepEqual([settled.disposition, settled.reason, settled.actionable], ['invalidated', 'originator-archived', false]);
  assert.notEqual(recorded(f, 'op-a'), 'confirmation-required', 'settled in the record, so the agent\'s receipt says so too');
  assert.equal(card(live).reason, 'originator-archived', 'restoring the session does not bring the card back');
  for (const lang of ['zh', 'en']) assert.ok(messages[lang]['background.card.reason.originator-archived'], `${lang} reason text`);
  assert.equal(messages.zh['background.card.reason.originator-archived'], '发起这张卡的会话已归档，未执行。');
});
