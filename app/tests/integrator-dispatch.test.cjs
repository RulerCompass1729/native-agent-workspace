const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { RoomState } = require('../room-state.cjs');
const { QueueDispatcher, CAPABILITY, INTEGRATOR_ABSENT_MS, queueVacancies } = require('../queue-dispatch.cjs');
const { IntegrationHandoffs, FILE } = require('../integrator-handoff.cjs');
const { IntegratorEngine } = require('../integrator-engine.cjs');
const locale = require('../ui-locale.js');
const { uiError } = require('../ui-errors.cjs');

// The integration handoff connected to the real dispatcher and the real space record (B6 E2b,
// checkpoint H6b). The backend is a stand-in that records what it is sent; git is a stand-in with
// fixed answers. No model, no message outside this process, no lock.
const COMMIT = '61'.repeat(20), MAIN = 'a'.repeat(40), HEAD2 = 'b'.repeat(40);
const INTEGRATOR = { sessionId: 'integrator', nativeId: 'native-integrator' };
function session(id, extra = {}) {
  return { id, name: `Synthetic ${id}`, provider: 'claude', nativeId: `native-${id}`, model: 'synthetic-model', state: 'idle', roomIds: [], createdAt: 1, background: 0, scheduled: 0,
    backgroundStale: false, chatAvailable: true, liveDraft: '', controlRevision: 0, serviceCapabilities: [CAPABILITY], fleet: [], messages: [], cwd: '/synthetic/repository', ...extra };
}
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-integrator-dispatch-')); fs.chmodSync(directory, 0o700);
  const room = new RoomState(directory), client = new EventEmitter();
  const f = { directory, room, client, calls: [], notices: [], unreadable: 0, failed: [], designated: INTEGRATOR, head: MAIN, skew: 0, heads: 0, refreshes: 0, broadcasts: 0 };
  client.state = { sessions: [session('member-a', { roomId: 'shared', roomIds: ['shared'] }), session('member-b', { roomId: 'shared', roomIds: ['shared'] }), session('integrator')],
    rooms: [{ id: 'shared', messages: [], run: null }], wakePolicy: { enabled: true }, capabilities: [CAPABILITY] };
  client.snapshot = () => structuredClone(client.state); client.refresh = async () => { f.refreshes += 1; return client.snapshot(); }; client.close = () => {};
  client.route = () => ({ client, state: { capabilities: [CAPABILITY] } });
  // The backend's own NAW input: it takes the message, and the session starts to work.
  client.call = async (method, id, text, nativeId, packet) => {
    // What the space record asks of a backend while it archives a session; nothing here sends a message.
    if (method === 'initial') return client.snapshot();
    if (['pause', 'resumeRoom'].includes(method)) return undefined;
    assert.equal(method, 'dispatch');
    const itemId = typeof packet === 'object' ? packet.itemId : packet;
    const target = client.state.sessions.find(candidate => candidate.id === id);
    assert.equal(target.nativeId, nativeId);
    const tag = `tag-${f.calls.length + 1}`;
    f.calls.push({ id, text, itemId, tag });
    target.state = 'working'; target.messages.push({ id: tag, role: 'user', text, origin: 'naw-dispatch', dispatchItem: itemId,
      dispatchPurpose: { kind: 'queue', nativeId: target.nativeId, itemId, epoch: null }, status: 'submitted', time: Date.now() });
    return tag;
  };
  f.reply = (id, text) => { const target = client.state.sessions.find(candidate => candidate.id === id); target.messages.push({ id: `reply-${target.messages.length}`, role: 'assistant', text, time: Date.now() }); target.state = 'idle'; };
  f.handoffs = new IntegrationHandoffs(directory);
  // git: the delivery was cherry-picked, and HEAD2 holds it.
  const read = { commit: async value => [MAIN, HEAD2, COMMIT].find(id => id.startsWith(value)) || null, isAncestor: async (a, b) => b === HEAD2,
    changes: async (base, tip) => (tip === HEAD2 ? [{ commit: 'm1', change: 'x-1' }] : [{ commit: tip, change: 'x-1' }]) };
  const engine = dispatcher => new IntegratorEngine({ handoffs: f.handoffs, now: () => Date.now() + f.skew, designation: () => { if (f.designated instanceof Error) throw f.designated; return f.designated; },
    mainHead: async () => { f.heads += 1; return f.head; }, reader: read, send: (target, text, handoffId) => dispatcher.send(target, text, handoffId), typing: id => dispatcher.noteHuman(id),
    record: fact => room.recordHandoff(fact), notify: async info => { f.notices.push(info); },
    holderRecord: fact => room.recordHandoffHolder(fact), nameOf: target => dispatcher.name(target), holderLines: () => room.handoffHolderLines(),
    // Only a test that sets f.repository asks the question; the others read main as before.
    ...(options.repository ? { repository: () => { if (f.repository instanceof Error) throw f.repository; return f.repository; } } : {}) });
  f.dispatcher = new QueueDispatcher({ roomState: room, dataDir: directory, clients: () => client, now: () => Date.now() + f.skew, settleMs: 0, humanQuietMs: 0, broadcast: async () => { f.broadcasts += 1; },
    sampleProcesses: async () => '', samplePressure: async () => '', ...(options.observe ? { observeQueueState: options.observe } : {}), ...(options.plain ? {} : { integration: options.build || engine, integrationUnreadable: () => { f.unreadable += 1; }, integrationFailed: error => { f.failed.push(error.message); } }) });
  t.after(() => { f.dispatcher.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  f.records = () => room.metadata('shared').events.filter(event => event.monitor?.kind === 'handoff').map(event => [event.monitor.outcome, event.monitor.itemId]);
  f.states = () => Object.fromEntries(f.handoffs.snapshot().ready.map(entry => [entry.branch, entry.state + (entry.reason ? ':' + entry.reason : '')]));
  // A pass, with the dispatcher made to look again (as a state change from the backend would).
  f.pass = async () => { f.dispatcher.dirty = true; await f.dispatcher.tick(); };
  return f;
}

test('a member\'s delivery is handed to the designated integrator, its answer is checked and settled, and the space and the person are told', async t => {
  const f = fixture(t);
  f.designated = null;
  // The person queues a task; the dispatcher sends it to a member, who delivers.
  const itemId = f.room.queueAdd('Synthetic task', null);
  await f.pass();
  assert.deepEqual(f.calls.map(call => [call.id, call.itemId]), [['member-a', itemId]]);
  f.reply('member-a', `Done.\nREADY lane/a ${COMMIT}`);
  await f.pass();
  assert.equal(f.room.queueItems()[0].status, 'done');
  // The delivery is taken in in the same pass that recorded it. Nobody is designated yet: the person is asked once.
  assert.deepEqual(f.states(), { 'lane/a': 'deliverable' });
  assert.deepEqual(f.notices, [{ reason: 'integrator-unset', count: 1, roomId: 'shared', itemId }]);
  await f.pass(); await f.pass();
  assert.equal(f.notices.length, 1); assert.equal(f.calls.length, 1);
  // Nothing can move until the person designates somebody, so this is not work that keeps passes (or a connection) going.
  assert.equal(f.dispatcher.hasOpenWork(), false);
  // The person designates the integrator: one handoff goes to it, through the dispatcher's own send, and the space says so.
  f.designated = INTEGRATOR;
  assert.equal(f.dispatcher.hasOpenWork(), true, 'With somebody designated, the waiting delivery is work again');
  const looked = f.refreshes, announced = f.broadcasts;
  await f.pass();
  assert.equal(f.calls.length, 2);
  assert.ok(f.refreshes > looked, 'The sessions were read afresh right before the handoff was recorded');
  assert.ok(f.broadcasts > announced, 'The windows are told that the space record changed');
  const sent = f.calls[1], handoff = f.handoffs.snapshot().handoff;
  assert.deepEqual([sent.id, sent.itemId, handoff.status, handoff.tag, handoff.mainHead], ['integrator', handoff.id, 'sent', sent.tag, MAIN]);
  assert.ok(sent.text.startsWith(`【NAW 集成交接】${handoff.id}：`) && sent.text.includes(COMMIT) && !sent.text.includes('【NAW 派活】'));
  // Reviews cost money and are off until the person turns them on: the message says so.
  assert.ok(sent.text.includes('独审：现在关着') && !sent.text.includes('独审：用户已同意'));
  assert.deepEqual(f.records(), [['handed', itemId]]);
  assert.deepEqual(f.states(), { 'lane/a': 'handed' });
  // While the integrator works nothing more is sent to anyone.
  await f.pass(); await f.pass();
  assert.equal(f.calls.length, 2);
  // It answers. git confirms the merge on the new main head; the delivery is merged, the space is told, and the install question is raised once.
  f.head = HEAD2;
  f.reply('integrator', `MERGED ${COMMIT.slice(0, 9)} as ${HEAD2.slice(0, 9)} tests 12/12`);
  await f.pass();
  assert.deepEqual(f.states(), { 'lane/a': 'merged' });
  assert.equal(f.handoffs.snapshot().handoff, null);
  assert.deepEqual(f.records(), [['handed', itemId], ['merged', itemId]]);
  assert.deepEqual(f.notices.map(info => info.reason), ['integrator-unset', `installable:${HEAD2}`]);
  const merged = f.room.metadata('shared').events.findLast(event => event.monitor?.kind === 'handoff');
  assert.equal(merged.text, `「Synthetic task」的交付（lane/a ${COMMIT.slice(0, 12)}）已合入 main：${HEAD2.slice(0, 12)}，测试 12/12`);
  // Nothing is left to do: later passes send nothing, tell nothing and write nothing.
  const before = [fs.readFileSync(path.join(f.directory, FILE), 'utf8'), JSON.stringify(f.room.metadata('shared').events), f.broadcasts];
  await f.pass(); await f.pass();
  assert.deepEqual([fs.readFileSync(path.join(f.directory, FILE), 'utf8'), JSON.stringify(f.room.metadata('shared').events), f.broadcasts], before);
  assert.deepEqual([f.calls.length, f.notices.length, f.dispatcher.hasOpenWork()], [2, 2, false]);
  // The members were never sent a handoff, and the integrator was never sent a queue item.
  assert.deepEqual(f.calls.map(call => [call.id, call.text.startsWith('【NAW 集成交接】')]), [['member-a', false], ['integrator', true]]);
});

test('without the engine the dispatcher is as it was: nothing is taken in, recorded or sent for a delivery', async t => {
  const f = fixture(t, { plain: true });
  assert.equal(f.dispatcher.integration, null);
  const itemId = f.room.queueAdd('Synthetic task', null);
  await f.pass();
  f.reply('member-a', `READY lane/a ${COMMIT}`);
  await f.pass(); await f.pass();
  assert.equal(f.room.queueItems()[0].status, 'done');
  assert.deepEqual(f.calls.map(call => [call.id, call.itemId]), [['member-a', itemId]]);
  assert.equal(fs.existsSync(path.join(f.directory, FILE)), false, 'No handoff record is even created');
  assert.deepEqual(f.records(), []); assert.equal(f.dispatcher.hasOpenWork(), false);
});

test('the designated session counts as gone only after it has been missing from every pass for a while', async t => {
  const f = fixture(t);
  f.room.queueAdd('Synthetic task', null);
  await f.pass();
  f.reply('member-a', `READY lane/a ${COMMIT}`);
  // The integrator's session is not in the list (its backend is away, say).
  f.client.state.sessions = f.client.state.sessions.filter(candidate => candidate.id !== 'integrator');
  await f.pass(); await f.pass();
  assert.deepEqual(f.notices, [], 'A session that is missing for a moment is not reported as gone');
  assert.deepEqual(f.states(), { 'lane/a': 'deliverable' });
  f.skew = INTEGRATOR_ABSENT_MS - 1000;
  await f.pass();
  assert.deepEqual(f.notices, []);
  // It comes back in between: the absence starts again from nothing.
  f.client.state.sessions.push(session('integrator', { state: 'working' }));
  await f.pass();
  f.client.state.sessions = f.client.state.sessions.filter(candidate => candidate.id !== 'integrator');
  f.skew = INTEGRATOR_ABSENT_MS + 5000;
  await f.pass();
  assert.deepEqual(f.notices, []);
  // Missing on every pass for the whole time: the person is asked once.
  f.skew = 2 * INTEGRATOR_ABSENT_MS + 10000;
  await f.pass(); await f.pass();
  assert.deepEqual(f.notices.map(info => info.reason), ['integrator-missing:integrator']);
  assert.equal(INTEGRATOR_ABSENT_MS, 10 * 60 * 1000);
  assert.equal(f.calls.filter(call => call.id === 'integrator').length, 0);
});

test('a designated session that is in the list but archived, or another native session under its id, is the record\'s to judge: the person is asked at once', async t => {
  for (const change of ['archived', 'replaced']) {
    const f = fixture(t);
    f.room.queueAdd('Synthetic task', null);
    await f.pass();
    f.reply('member-a', `READY lane/a ${COMMIT}`);
    // Archived the real way: only the desktop's own record says so, and the dispatcher's view takes it from there.
    if (change === 'archived') await f.room.archiveSession(f.client, 'integrator', 'Synthetic integrator');
    else f.client.state.sessions.find(candidate => candidate.id === 'integrator').nativeId = 'native-replacement';
    await f.pass(); await f.pass();
    assert.deepEqual(f.notices.map(info => info.reason), ['integrator-missing:integrator'], JSON.stringify(change));
    assert.deepEqual([f.states(), f.calls.filter(call => call.id === 'integrator').length], [{ 'lane/a': 'deliverable' }, 0], JSON.stringify(change));
  }
});

test('a failure inside the engine\'s pass is kept and told once; the queue goes on and the next pass tries again', async t => {
  const f = fixture(t);
  f.room.queueAdd('Synthetic task', null);
  await f.pass();
  f.reply('member-a', `READY lane/a ${COMMIT}`);
  // The designation itself fails in a way the engine does not expect (a fault, not "unreadable").
  const pass = f.dispatcher.integration.pass.bind(f.dispatcher.integration);
  let broken = true;
  f.dispatcher.integration.pass = async (...args) => { if (broken) throw Error('Synthetic engine fault'); return pass(...args); };
  await f.pass(); await f.pass(); await f.pass();
  assert.deepEqual(f.failed, ['Synthetic engine fault'], 'Told once, not on every pass');
  assert.deepEqual([f.dispatcher.integrationError.message, f.dispatcher.integrationError.count >= 2], ['Synthetic engine fault', true]);
  assert.equal(f.room.queueItems()[0].status, 'done', 'The queue item was settled all the same');
  assert.equal(f.dispatcher.integrationError.recoveredAt, undefined, 'Not over while it keeps failing');
  // The fault is gone: the next pass takes the delivery in and hands it out.
  broken = false;
  await f.pass();
  const over = f.dispatcher.integrationError.recoveredAt;
  await f.pass();
  assert.deepEqual(f.states(), { 'lane/a': 'handed' });
  // The kept fault stays readable and says since when it is over; later good passes do not move that time.
  assert.ok(Number.isFinite(over) && f.dispatcher.integrationError.recoveredAt === over && f.dispatcher.integrationError.message === 'Synthetic engine fault');
  // After the recovery the same fault is not told again, and another kind of fault is.
  let fault = 'Synthetic engine fault';
  f.dispatcher.integration.pass = async () => { throw Error(fault); };
  await f.pass(); await f.pass();
  assert.deepEqual(f.failed, ['Synthetic engine fault']);
  assert.equal(f.dispatcher.integrationError.recoveredAt, undefined, 'A new failure is not marked as over');
  fault = 'Another synthetic fault';
  await f.pass(); await f.pass();
  assert.deepEqual(f.failed, ['Synthetic engine fault', 'Another synthetic fault']);
  assert.equal(f.dispatcher.integrationError.message, 'Another synthetic fault');
});

test('an integrator that is not ready, or a record that cannot be read, sends nothing; the person is told once about the record', async t => {
  const f = fixture(t);
  f.room.queueAdd('Synthetic task', null);
  await f.pass();
  f.reply('member-a', `READY lane/a ${COMMIT}`);
  // Automatic messages are off for the integrator, then it is at work, then the person has typed there.
  const integrator = () => f.client.state.sessions.find(candidate => candidate.id === 'integrator');
  integrator().wakeDisabled = true;
  await f.pass(); await f.pass();
  integrator().wakeDisabled = false; integrator().state = 'working';
  await f.pass();
  integrator().state = 'idle'; integrator().liveDraft = 'half a sentence';
  await f.pass();
  assert.deepEqual([f.calls.length, f.states(), f.handoffs.snapshot().handoff], [1, { 'lane/a': 'deliverable' }, null]);
  assert.equal(f.heads, 0, 'git was not read while the integrator could not take a message');
  // Something only the person can change is not work that keeps passes or a connection going; something that
  // changes by itself is.
  integrator().liveDraft = ''; integrator().wakeDisabled = true;
  await f.pass();
  assert.equal(f.dispatcher.hasOpenWork(), false, 'Paused for automatic messages: the person\'s to change');
  integrator().wakeDisabled = false; integrator().state = 'working';
  f.dispatcher.lastMaintenance = 0;   // the window's own once-a-minute check comes round
  await f.pass();
  assert.equal(f.dispatcher.hasOpenWork(), true, 'At work: it will be idle again by itself');
  // A record that cannot be read: every pass does nothing with it, and the person is told once.
  const g = fixture(t);
  fs.writeFileSync(path.join(g.directory, FILE), '{', { mode: 0o600 });
  g.handoffs = new IntegrationHandoffs(g.directory);
  g.dispatcher.integration.handoffs = g.handoffs;
  g.room.queueAdd('Synthetic task', null);
  await g.pass();
  g.reply('member-a', `READY lane/a ${COMMIT}`);
  await g.pass(); await g.pass(); await g.pass();
  assert.equal(g.unreadable, 1);
  assert.deepEqual([g.calls.length, g.records(), g.notices], [1, [], []]);
  assert.equal(fs.readFileSync(path.join(g.directory, FILE), 'utf8'), '{', 'The record is left as it is');
  assert.equal(g.room.queueItems()[0].status, 'done', 'The queue itself goes on');
  // Until the person has looked at the record nothing can move, so it keeps neither passes nor a connection going.
  assert.equal(g.dispatcher.hasOpenWork(), false);
  // With no queue work at all it is the same from the start, and the window's own check still tells the person, once.
  const h = fixture(t);
  fs.writeFileSync(path.join(h.directory, FILE), '{', { mode: 0o600 });
  h.dispatcher.integration.handoffs = new IntegrationHandoffs(h.directory);
  assert.equal(h.dispatcher.hasOpenWork(), false);
  await h.pass();
  assert.equal(h.unreadable, 1, 'Told by the first once-a-minute check through a window');
  await h.pass(); await h.pass();
  assert.deepEqual([h.unreadable, h.dispatcher.hasOpenWork(), h.calls.length], [1, false, 0]);
});

test('an engine that cannot be built leaves the queue running without it, and the person is told once', async t => {
  const f = fixture(t, { build: () => { throw Error('Synthetic build fault'); } });
  assert.equal(f.dispatcher.integration, null);
  assert.deepEqual(f.failed, ['Synthetic build fault']);
  assert.deepEqual([f.dispatcher.integrationError.message, f.dispatcher.integrationError.count], ['Synthetic build fault', 1]);
  // The queue works as it does without an engine.
  const itemId = f.room.queueAdd('Synthetic task', null);
  await f.pass();
  assert.deepEqual(f.calls.map(call => [call.id, call.itemId]), [['member-a', itemId]]);
  f.reply('member-a', `READY lane/a ${COMMIT}`);
  await f.pass(); await f.pass();
  assert.equal(f.room.queueItems()[0].status, 'done');
  assert.deepEqual([f.calls.length, f.failed.length, f.unreadable, f.records(), f.dispatcher.hasOpenWork()], [1, 1, 0, [], false]);
  assert.equal(fs.existsSync(path.join(f.directory, FILE)), false, 'Nothing was taken in: there is no engine');
  // The builder is given a dispatcher that is complete (it is built last).
  let seen = null;
  const g = fixture(t, { build: dispatcher => { seen = [typeof dispatcher.now(), dispatcher.rotations !== undefined, Array.isArray(dispatcher.log)]; return null; } });
  assert.deepEqual([seen, g.dispatcher.integration, g.failed], [['number', true, true], null, []]);
  // In the main process the person's entry gets the record only once the engine exists.
  const main = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  const builder = main.slice(main.indexOf('function integrationEngine(dispatcher) {'), main.indexOf('\nfunction ', main.indexOf('function integrationEngine(dispatcher) {') + 10));
  assert.ok(builder.indexOf('const engine = new IntegratorEngine(') > 0 && builder.indexOf('integrationHandoffs = handoffs;') > builder.indexOf('const engine = new IntegratorEngine('));
  assert.match(builder, /\n  integrationHandoffs = handoffs;\n  integrationRepository = \{\n/);
  assert.match(builder, /\n  \};\n  return engine;\n\}\n/);
  // The engine keeps no timer of its own: the main process gives it the bound on how long a question to git is waited for.
  assert.match(builder, /\n  const engine = new IntegratorEngine\(\{ handoffs, within, /);
  const from = builder.indexOf('  const within = (answer, ms, late) => new Promise('), to = builder.indexOf('\n  });\n', from);
  assert.ok(from > 0 && to > from);
  const within = new Function('setTimeout', 'clearTimeout', `${builder.slice(from, to + 6)}\n  return within;`);
  const timers = [], cleared = [];
  const bound = within((run, ms) => { const timer = setTimeout(run, ms); timers.push([timer, ms]); return timer; }, timer => { cleared.push(timer); clearTimeout(timer); });
  const LATE = Symbol('late');
  assert.equal(await bound(Promise.resolve('answer'), 5000, LATE), 'answer');
  assert.equal(await bound(new Promise(() => {}), 20, LATE), LATE, 'An answer that does not come in time is given up');
  await assert.rejects(bound(Promise.reject(Error('git failed')), 5000, LATE), /git failed/);
  assert.deepEqual([timers.map(([, ms]) => ms), cleared.length, cleared.includes(timers[0][0]) && cleared.includes(timers[2][0])], [[5000, 20, 5000], 2, true], 'No timer is left running behind an answer');
});

test('a pass whose result cannot be read is a fault like a pass that throws: kept and told once, and the queue goes on', async t => {
  const f = fixture(t);
  f.room.queueAdd('Synthetic task', null);
  await f.pass();
  f.reply('member-a', `READY lane/a ${COMMIT}`);
  const pass = f.dispatcher.integration.pass.bind(f.dispatcher.integration);
  // "Taken in" without its list; then no result at all.
  let shape = { kind: 'passed', taken: {} };
  f.dispatcher.integration.pass = async () => shape;
  await f.pass(); await f.pass();
  assert.equal(f.failed.length, 1, 'Told once, not on every pass');
  assert.ok(f.dispatcher.integrationError.count >= 2 && f.dispatcher.integrationError.message === f.failed[0]);
  assert.equal(f.room.queueItems()[0].status, 'done', 'The queue item was settled all the same');
  shape = undefined;
  await f.pass(); await f.pass();
  assert.equal(f.failed.length, 2, 'Another kind of fault is told as well');
  // Telling the windows fails outright: kept too.
  f.dispatcher.integration.pass = pass;
  const broadcast = f.dispatcher.broadcast;
  f.dispatcher.broadcast = () => { throw Error('Synthetic broadcast fault'); };
  await f.pass();
  assert.deepEqual([f.failed.length, f.failed[2], f.dispatcher.integrationError.message], [3, 'Synthetic broadcast fault', 'Synthetic broadcast fault']);
  // What the pass itself did is kept: the delivery was taken in and handed out.
  f.dispatcher.broadcast = broadcast;
  await f.pass(); await f.pass();
  assert.deepEqual([f.states(), f.failed.length], [{ 'lane/a': 'handed' }, 3]);
});

test('an integrator NAW itself is busy with is handed nothing until that is over', async t => {
  const f = fixture(t);
  f.room.queueAdd('Synthetic task', null);
  await f.pass();
  f.reply('member-a', `READY lane/a ${COMMIT}`);
  // Its session takes part in a running space exchange (it was taken out of the space while the exchange ran).
  f.client.state.rooms[0].run = { status: 'running', ids: ['integrator'] };
  await f.pass(); await f.pass();
  assert.deepEqual([f.calls.length, f.states(), f.heads], [1, { 'lane/a': 'deliverable' }, 0], 'Nothing is sent and git is not read');
  assert.equal(f.dispatcher.hasOpenWork(), true, 'The exchange ends by itself, so the passes go on');
  f.client.state.rooms[0].run = null;
  await f.pass();
  assert.deepEqual([f.calls.length, f.states()], [2, { 'lane/a': 'handed' }]);
  // The view names the sessions the queue's own planner leaves alone: a queue item sent and not yet answered,
  // a session rotation that is not at rest and the successor it has not confirmed, a quarantined successor.
  const g = fixture(t);
  g.client.state.sessions.find(candidate => candidate.id === 'integrator').roomIds = ['shared'];
  const itemId = g.room.queueAdd('Synthetic task', 'integrator');
  await g.pass();
  assert.deepEqual(g.calls.map(call => [call.id, call.itemId]), [['integrator', itemId]]);
  const busy = () => { const view = g.dispatcher.integrationView(g.dispatcher.view()); return ['integrator', 'member-a', 'member-b', 'next'].filter(id => view.busy(id)); };
  assert.deepEqual(busy(), ['integrator'], 'A queue item awaits its answer');
  g.reply('integrator', 'Done.');
  await g.pass();
  assert.deepEqual([g.room.queueItems()[0].status, busy()], ['done', []]);
  // A waiting item engages its member no more (11-12 for the two kinds that ask nothing; 11-13 for a decision,
  // which the person answers in that session while it takes more work).
  const queued = queue => { const current = g.dispatcher.view(); return g.dispatcher.integrationView({ ...current, snapshot: { ...current.snapshot, rooms: [{ id: 'shared', queue }] } }); };
  for (const reason of [undefined, 'Synthetic refusal', 'person-intervened', 'no-reply']) assert.equal(queued([{ id: 'w', status: 'waiting', reason, sentTo: 'integrator' }]).busy('integrator'), false, String(reason));
  g.dispatcher.rotations = { 'member-a': { phase: 'requested', newId: 'next' } };
  assert.deepEqual(busy(), ['member-a', 'next']);
  g.dispatcher.rotations = { 'member-a': { phase: 'kept', newId: 'next', handoffConfirmed: true } };
  assert.deepEqual(busy(), [], 'A rotation at rest engages nobody');
  // A successor whose folder was not trusted stays engaged until its cleanup is confirmed; the session it replaced is at rest.
  g.dispatcher.rotations = { 'member-a': { phase: 'failed', trustNoticeId: '01234567-89ab-4cde-8f01-23456789abcd', newId: 'next', cwd: '/synthetic/a', newCwd: '/synthetic/b' } };
  assert.deepEqual(busy(), ['next']);
  g.dispatcher.rotations = {};
});

test('the session that holds an open handoff is sent no queue item until the handoff is closed', async t => {
  const f = fixture(t);
  f.room.queueAdd('Synthetic task', null);
  await f.pass();
  f.reply('member-a', `READY lane/a ${COMMIT}`);
  await f.pass();
  assert.deepEqual([f.calls.length, f.states()], [2, { 'lane/a': 'handed' }]);
  assert.deepEqual(f.dispatcher.integration.holding(), ['integrator']);
  // While it works on the handoff the person puts it into the space and queues a task for it by name.
  const integrator = () => f.client.state.sessions.find(candidate => candidate.id === 'integrator');
  integrator().roomId = 'shared'; integrator().roomIds = ['shared'];
  const second = f.room.queueAdd('Second synthetic task', 'integrator');
  await f.pass();
  // It answers the handoff with a question for the person. It is idle now, and the handoff waits: still no queue item.
  f.reply('integrator', '需要你决定：现在合吗？');
  await f.pass(); await f.pass();
  assert.equal(f.handoffs.snapshot().handoff.status, 'waiting');
  assert.equal(f.calls.length, 2, 'Nothing was sent to it besides the handoff');
  assert.equal(f.room.queueItems().find(item => item.id === second).status, 'queued');
  // The person deals with the handoff: its place is free, and the queued task goes out.
  f.handoffs.resolveHandoff(f.handoffs.snapshot().handoff.id, { retry: false });
  assert.deepEqual(f.dispatcher.integration.holding(), []);
  await f.pass();
  assert.deepEqual(f.calls.slice(2).map(call => [call.id, call.itemId]), [['integrator', second]]);
  // A record that cannot be read names nobody.
  const g = fixture(t);
  fs.writeFileSync(path.join(g.directory, FILE), '{', { mode: 0o600 });
  g.dispatcher.integration.handoffs = new IntegrationHandoffs(g.directory);
  assert.deepEqual(g.dispatcher.integration.holding(), []);
  // The planner is told only when there is an engine.
  const dispatch = fs.readFileSync(path.join(__dirname, '../queue-dispatch.cjs'), 'utf8');
  assert.match(dispatch, /\n    const engaged = this\.integration \? this\.integration\.holding\(\) : undefined;\n    const input = \{\n[^}]*\n      engaged,\n[^}]*\};\n    let actions = planDispatch\(input\);\n/);
  assert.equal(dispatch.match(/this\.integration\.holding\(\)/g).length, 1, 'Asked once in a pass, before anything is sent');
  assert.equal(dispatch.match(/input\.engaged/g).length, 4, 'Read by the planner and by the vacancy list, nowhere else');
});

test('the session that holds an open handoff is not listed as vacant for the space it was put into', async t => {
  const seen = [];
  const f = fixture(t, { observe: async states => { seen.push(states); } });
  f.room.queueAdd('Synthetic task', null);
  await f.pass();
  f.reply('member-a', `READY lane/a ${COMMIT}`);
  await f.pass();
  assert.deepEqual(f.states(), { 'lane/a': 'handed' });
  // It answers with a question, so it is idle and its handoff waits; the person puts it into the space.
  f.reply('integrator', '需要你决定：现在合吗？');
  await f.pass();
  const integrator = f.client.state.sessions.find(candidate => candidate.id === 'integrator');
  integrator.roomId = 'shared'; integrator.roomIds = ['shared'];
  f.dispatcher.lastMaintenance = 0;
  await f.pass(); await f.pass();
  const listed = () => seen.at(-1).find(space => space.roomId === 'shared').candidateIds;
  assert.equal(f.handoffs.snapshot().handoff.status, 'waiting');
  assert.ok(listed().includes('member-a') && !listed().includes('integrator'), JSON.stringify(listed()));
  // The handoff is dealt with: it is a member like any other.
  f.handoffs.resolveHandoff(f.handoffs.snapshot().handoff.id, { retry: false });
  f.dispatcher.lastMaintenance = 0;
  await f.pass();
  assert.ok(listed().includes('integrator'), JSON.stringify(listed()));
  // The list itself: named sessions are not vacant; nobody named, or something that is not a list, changes nothing.
  const input = extra => ({ rooms: [{ id: 'shared', name: 'Synthetic team', queue: [] }], sessions: [session('member-a', { roomId: 'shared', roomIds: ['shared'] }), session('member-b', { roomId: 'shared', roomIds: ['shared'] })],
    wakePolicy: { enabled: true }, idleSince: new Map([['member-a', 0], ['member-b', 0]]), humanAt: new Map(), now: 1_000_000, settleMs: 0, humanQuietMs: 0, ...extra });
  const plain = queueVacancies(input())[0];
  assert.deepEqual(plain.candidateIds, ['member-a', 'member-b']);
  assert.deepEqual([queueVacancies(input({ engaged: ['member-a'] }))[0].candidateIds, queueVacancies(input({ engaged: ['member-a'] }))[0].availableIds], [['member-b'], ['member-b']]);
  for (const engaged of [undefined, null, [], 'member-a', { 'member-a': true }]) assert.deepEqual(queueVacancies(input({ engaged }))[0], plain, JSON.stringify(engaged));
});

test('a question the integrator writes after another agent\'s wake is put to the person; after they deal with it the deliveries go out again', async t => {
  const f = fixture(t);
  const itemId = f.room.queueAdd('Synthetic task', null);
  await f.pass();
  f.reply('member-a', `READY lane/a ${COMMIT}`);
  await f.pass();
  assert.deepEqual([f.calls.length, f.states()], [2, { 'lane/a': 'handed' }]);
  const first = f.handoffs.snapshot().handoff.id;
  // Another agent wakes the integrator before it has answered; then it asks the person something.
  const integrator = f.client.state.sessions.find(candidate => candidate.id === 'integrator');
  integrator.messages.push({ id: 'wake-1', role: 'user', text: 'Synthetic wake from another agent', origin: 'agent-wake', time: Date.now() });
  f.reply('integrator', '需要你决定：这件事怎么办？');
  await f.pass(); await f.pass();
  // The handoff waits with that question; nothing is sent again by itself, and the person is told once.
  const waiting = f.handoffs.snapshot().handoff;
  assert.deepEqual([waiting.id, waiting.status, waiting.question, f.calls.length], [first, 'waiting', '这件事怎么办？', 2]);
  assert.deepEqual(f.notices.map(info => info.reason), [`conflict:${first}`]);
  // The person deals with it and lets the delivery go out again; the new answer is read and the merge is checked.
  f.handoffs.resolveHandoff(first, { retry: true });
  await f.pass();
  const second = f.handoffs.snapshot().handoff;
  assert.ok(second && second.id !== first && second.status === 'sent', JSON.stringify(second));
  assert.deepEqual(f.calls.map(call => [call.id, call.itemId]), [['member-a', itemId], ['integrator', first], ['integrator', second.id]]);
  f.head = HEAD2;
  f.reply('integrator', `MERGED ${COMMIT.slice(0, 9)} as ${HEAD2.slice(0, 9)} tests 12/12`);
  await f.pass();
  assert.deepEqual([f.states(), f.handoffs.snapshot().handoff], [{ 'lane/a': 'merged' }, null]);
});

test('a member that holds an open handoff: the handoff waits for the person at once, its space is told once that the queue leaves it alone, and once when it is over', async t => {
  const f = fixture(t);
  f.room.queueAdd('Synthetic task', null);
  await f.pass();
  f.reply('member-a', `READY lane/a ${COMMIT}`);
  await f.pass();
  const handoffId = f.handoffs.snapshot().handoff.id;
  const told = () => f.room.metadata('shared').events.filter(event => event.monitor?.kind === 'handoff-holder').map(event => [event.monitor.state, event.sessionId, event.text]);
  const standing = () => [f.handoffs.snapshot().handoff.status, f.handoffs.snapshot().handoff.reason, f.notices.map(notice => notice.reason), f.states()];
  // The integrator is in no space: there is no queue to keep it out of, and nothing is said.
  await f.pass();
  assert.deepEqual([told(), f.handoffs.snapshot().handoff.status], [[], 'sent']);
  // The person puts it into the space while it works on the handoff.
  const integrator = f.client.state.sessions.find(candidate => candidate.id === 'integrator');
  integrator.roomId = 'shared'; integrator.roomIds = ['shared'];
  // A space that is being updated at that moment is told on a later pass; that is not a fault of the engine.
  const write = f.room.recordHandoffHolder.bind(f.room);
  f.room.recordHandoffHolder = () => { throw uiError('error.room.updatingDraftRetained'); };
  await f.pass();
  assert.deepEqual([told(), f.failed, f.dispatcher.integrationError], [[], [], null]);
  // In that same pass the handoff stopped being read: members and the space's queue may be speaking to that session now.
  // It waits for the person, who is told once by a system notice, whatever became of the space's line.
  assert.deepEqual(standing(), ['waiting', 'integrator-in-space', ['integrator-in-space'], { 'lane/a': 'handed' }]);
  // Any other failure of the writer is a fault: kept and told once, and the line is still written when it works again.
  f.room.recordHandoffHolder = () => { throw Error('Synthetic writer fault'); };
  await f.pass(); await f.pass();
  assert.deepEqual([told(), f.failed, f.dispatcher.integrationError.message], [[], ['Synthetic writer fault'], 'Synthetic writer fault']);
  f.room.recordHandoffHolder = write;
  const announced = f.broadcasts;
  // (A handoff that waits for the person is nothing the engine can move, so the line is written by the next pass that runs for another reason.)
  f.dispatcher.lastMaintenance = 0;
  await f.pass(); await f.pass(); await f.pass();
  assert.deepEqual(told(), [['waiting', 'integrator', 'Synthetic integrator 的集成交接在等你处理；你处理完之前，这个空间不给它派新活，排给它的活先等着']]);
  assert.ok(f.broadcasts > announced, 'The windows are told that the space record changed');
  // Whatever the integrator writes from now on is not read as the handoff's answer: not a merge that git would confirm,
  // not a question. The person's own typing changes nothing either, and nobody is told a second time.
  f.head = HEAD2;
  f.reply('integrator', `MERGED ${COMMIT.slice(0, 9)} as ${HEAD2.slice(0, 9)} tests 12/12`);
  await f.pass(); await f.pass();
  f.reply('integrator', '需要你决定：这是写给空间里别人的');
  await f.pass(); await f.pass();
  integrator.messages.push({ id: 'typed', role: 'user', text: 'A word from the person', origin: 'human', time: Date.now() });
  f.reply('integrator', 'Understood.');
  await f.pass(); await f.pass(); await f.pass();
  assert.deepEqual(standing(), ['waiting', 'integrator-in-space', ['integrator-in-space'], { 'lane/a': 'handed' }]);
  assert.equal(f.handoffs.snapshot().handoff.question, undefined);
  assert.deepEqual(told().map(row => row[0]), ['waiting']);
  // Said once: the record and the writer refuse a repeat; a space that does not exist and a fact without its parts write nothing.
  assert.deepEqual(f.room.recordHandoffHolder({ roomId: 'shared', sessionId: 'integrator', name: 'Synthetic integrator', handoffId, waiting: true }), { recorded: false, why: 'known' });
  assert.equal(f.room.recordHandoffHolder({ roomId: 'abcdef01-2345-4678-9abc-def012345678', sessionId: 'integrator', handoffId, waiting: true }).why, 'space-missing');
  for (const bad of [null, {}, { roomId: 'shared', sessionId: '', handoffId }, { roomId: 'shared', sessionId: 'integrator' }, { roomId: 'shared', sessionId: 'integrator', handoffId: 7 }]) {
    assert.deepEqual(f.room.recordHandoffHolder(bad), { recorded: false, why: 'no-words' }, JSON.stringify(bad));
  }
  assert.equal(told().length, 1);
  // The person deals with the handoff: the space is told once that it is over, so its record does not go on saying "waits for you".
  f.handoffs.resolveHandoff(handoffId, { retry: false });
  assert.equal(f.dispatcher.integration.holder(), null);
  const before = f.broadcasts;
  f.dispatcher.lastMaintenance = 0;
  await f.pass(); await f.pass(); await f.pass();
  assert.deepEqual(told().map(row => row[0]), ['waiting', 'closed']);
  assert.equal(told()[1][2], 'Synthetic integrator 的集成交接结束了，这个空间恢复给它派活');
  // Dealt with without a retry: the delivery is on hold under that reason, and the person's retry brings it back.
  assert.deepEqual(f.states(), { 'lane/a': 'held:integrator-in-space' });
  assert.deepEqual(f.handoffs.retryReason('integrator-in-space'), { released: [`ready:shared:${f.room.queueItems()[0].id}`] });
  assert.ok(f.broadcasts > before);
  // The ending is written only where the handoff was said to be open, and once.
  assert.deepEqual(f.room.recordHandoffHolder({ roomId: 'shared', sessionId: 'integrator', handoffId, closed: true }), { recorded: false, why: 'known' });
  assert.deepEqual(f.room.recordHandoffHolder({ roomId: 'shared', sessionId: 'integrator', handoffId: 'H8-00000000', closed: true }), { recorded: false, why: 'nothing-open' });
  assert.deepEqual(f.room.handoffHolderLines(), []);
  // A record that cannot be read names nobody.
  const g = fixture(t);
  fs.writeFileSync(path.join(g.directory, FILE), '{', { mode: 0o600 });
  g.dispatcher.integration.handoffs = new IntegrationHandoffs(g.directory);
  assert.equal(g.dispatcher.integration.holder(), null);
  // The main process gives the engine the space record's writer and the dispatcher's names.
  assert.match(fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8'), /\n    holderRecord: fact => roomState\.recordHandoffHolder\(fact\), nameOf: session => dispatcher\.name\(session\), holderLines: \(\) => roomState\.handoffHolderLines\(\),\n    repository: \(\) => \(repository\.usable\(\) \? true : null\), open \}\);\n/);
  // The writer's other line is for a handoff that is being worked on (a session can still be found in a space with one
  // while its message is not yet confirmed as sent). A name that is missing falls back to the session's id; the sentences exist in both languages.
  assert.equal(f.room.recordHandoffHolder({ roomId: 'shared', sessionId: 'integrator', handoffId: 'H9-00000000' }).recorded, true);
  assert.equal(told()[2][2], 'integrator 正在处理一份集成交接；交接结束前，这个空间不给它派新活，排给它的活先等着');
  assert.deepEqual(f.room.recordHandoffHolder({ roomId: 'shared', sessionId: 'integrator', handoffId: 'H9-00000000' }), { recorded: false, why: 'known' });
  // After a restart the engine remembers nothing. It reads once from the spaces' records which lines are still open
  // (the one just written, for a handoff that does not exist), and ends them; a record that cannot be read ends nothing.
  assert.deepEqual(f.room.handoffHolderLines(), [{ roomId: 'shared', sessionId: 'integrator', handoffId: 'H9-00000000', name: 'integrator' }]);
  f.dispatcher.integration.holderTold = null;
  const readable = f.dispatcher.integration.handoffs;
  f.dispatcher.integration.handoffs = Object.assign(Object.create(readable), { failed: true });
  f.dispatcher.lastMaintenance = 0;
  await f.pass();
  assert.equal(told().length, 3, 'Nothing is ended while the handoff record cannot be read');
  // The telling step itself refuses too, not only the pass around it: an unreadable record does not say that the handoff is over.
  assert.equal(f.dispatcher.integration.tellHolder(f.dispatcher.integrationView(f.dispatcher.view())), 0);
  assert.equal(told().length, 3);
  f.dispatcher.integration.handoffs = readable;
  // The spaces' records cannot be read on that first pass: nothing is ended, and they are read again on the next one.
  const lines = f.room.handoffHolderLines.bind(f.room);
  f.room.handoffHolderLines = () => { throw Error('Synthetic: the spaces cannot be read'); };
  f.dispatcher.lastMaintenance = 0;
  await f.pass();
  assert.deepEqual([told().length, f.dispatcher.integration.holderTold], [3, null]);
  f.room.handoffHolderLines = lines;
  f.dispatcher.lastMaintenance = 0;
  await f.pass(); await f.pass();
  assert.deepEqual(told().slice(2).map(row => row[0]), ['sent', 'closed']);
  assert.deepEqual(f.room.handoffHolderLines(), []);
  // An archived space has no queue at work and is told nothing.
  f.room.value.archived = true;
  assert.deepEqual(f.room.recordHandoffHolder({ roomId: 'shared', sessionId: 'integrator', handoffId: 'H10-00000000' }), { recorded: false, why: 'space-archived' });
  f.room.value.archived = false;
  for (const name of ['notice.handoff.holder.sent', 'notice.handoff.holder.waiting', 'notice.handoff.holder.closed']) {
    const zh = locale.format('zh', name, { name: 'Riley' }), en = locale.format('en', name, { name: 'Riley' });
    assert.ok(zh.includes('Riley') && en.includes('Riley') && zh !== en && zh !== name && en !== name, name);
  }
});

test('with no main repository that can be read the deliveries wait and the person is asked once; after they choose one the handoff goes out', async t => {
  const f = fixture(t, { repository: true });
  f.repository = null;
  const itemId = f.room.queueAdd('Synthetic task', null);
  await f.pass();
  f.reply('member-a', `READY lane/a ${COMMIT}`);
  await f.pass(); await f.pass(); await f.pass();
  assert.deepEqual([f.calls.length, f.states(), f.heads], [1, { 'lane/a': 'deliverable' }, 0], 'Nothing is sent and git is not read');
  assert.deepEqual(f.notices, [{ reason: 'repository-unset', count: 1, roomId: 'shared', itemId }]);
  assert.equal(f.dispatcher.hasOpenWork(), false, 'Only the person can change it');
  // A repository record that cannot be read is the same to the engine: no repository that can be read.
  f.repository = Error('Synthetic record failure');
  f.dispatcher.lastMaintenance = 0;
  await f.pass();
  assert.deepEqual([f.calls.length, f.notices.length], [1, 1]);
  // The person chooses one, as the entry does it: the question is closed and the engine tries again at once.
  const choose = () => { f.handoffs.reasonCleared('repository-chosen'); f.dispatcher.integration.unblock(); };
  f.repository = true; choose();
  assert.equal(f.dispatcher.hasOpenWork(), true, 'It is work again without waiting for another reason to pass');
  // It is lost again before any handoff opened (the folder fails a check): the person is asked again.
  f.repository = null;
  await f.pass(); await f.pass();
  assert.deepEqual([f.calls.length, f.notices.map(info => info.reason)], [1, ['repository-unset', 'repository-unset']]);
  // Chosen again: the next pass hands the delivery out, and main is read there.
  f.repository = true; choose();
  await f.pass();
  assert.deepEqual([f.calls.length, f.states(), f.handoffs.snapshot().reasons['repository-unset'].open], [2, { 'lane/a': 'handed' }, false]);
  assert.ok(f.heads > 0);
});

test('a pass that faults after it changed something still tells the windows; the list of automatic origins cannot be changed by a reader', async t => {
  const f = fixture(t);
  f.room.queueAdd('Synthetic task', null);
  await f.pass();
  f.reply('member-a', `READY lane/a ${COMMIT}`);
  await f.pass();
  // The integrator is put into the space while the space's writer is broken. In that pass the handoff stops being read and waits for the person.
  const integrator = f.client.state.sessions.find(candidate => candidate.id === 'integrator');
  integrator.roomId = 'shared'; integrator.roomIds = ['shared'];
  const write = f.room.recordHandoffHolder.bind(f.room), before = f.broadcasts;
  f.room.recordHandoffHolder = () => { throw Error('Synthetic writer fault'); };
  await f.pass();
  // The handoff was settled as waiting in that pass, and the windows are told about it although the pass ended in a fault.
  assert.deepEqual([f.states(), f.failed, f.handoffs.snapshot().handoff.status, f.handoffs.snapshot().handoff.reason], [{ 'lane/a': 'handed' }, ['Synthetic writer fault'], 'waiting', 'integrator-in-space']);
  assert.ok(f.broadcasts > before, 'The windows are told what the faulted pass changed');
  // The space is told once the writer works again, and of the ending once the person has dealt with the handoff.
  f.room.recordHandoffHolder = write;
  f.dispatcher.lastMaintenance = 0;
  await f.pass(); await f.pass();
  f.handoffs.resolveHandoff(f.handoffs.snapshot().handoff.id, { retry: false });
  f.dispatcher.lastMaintenance = 0;
  await f.pass(); await f.pass();
  assert.deepEqual(f.room.metadata('shared').events.filter(event => event.monitor?.kind === 'handoff-holder').map(event => event.monitor.state), ['waiting', 'closed']);
  // The list the handoff reads from the dispatcher's file is frozen.
  const { AUTOMATIC_ORIGINS } = require('../queue-dispatch.cjs');
  assert.ok(Object.isFrozen(AUTOMATIC_ORIGINS));
  assert.throws(() => { 'use strict'; AUTOMATIC_ORIGINS.push('made-up'); }, TypeError);
  assert.deepEqual([...AUTOMATIC_ORIGINS], ['naw-dispatch', 'agent-wake', 'capacity-recovery', 'agent-control', 'room']);
});

test('the engine is built only behind a switch that the daily app cannot open', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  // One place builds it, and that place is inside the test-only condition.
  assert.equal(main.match(/integrationEngine\(/g).length, 2, 'Its definition and one call');
  assert.match(main, /if \(backgroundTest && process\.env\.NAW_TEST_INTEGRATION_HANDOFF === '1'\) \{\n      options\.integration = dispatcher => integrationEngine\(dispatcher\);\n      options\.integrationUnreadable = \(\) => notifyHandoff\(null\);\n      options\.integrationFailed = \(\) => notifyHandoff\(undefined\);\n    \}/);
  // The three modules are loaded inside that function only: with the switch closed the daily app does not read them.
  const builder = main.indexOf('function integrationEngine(dispatcher) {'), next = main.indexOf('\nfunction ', builder + 10);
  for (const name of ['integrator-handoff', 'integrator-engine', 'integrator-git', 'integrator-repository']) {
    const places = [...main.matchAll(new RegExp(`require\\('\\./${name}\\.cjs'\\)`, 'g'))].map(match => match.index);
    assert.equal(places.length, 1, name); assert.ok(places[0] > builder && places[0] < next, name);
  }
  assert.equal(main.match(/new IntegratorEngine\(/g).length, 1); assert.equal(main.match(/new IntegrationHandoffs\(/g).length, 1); assert.equal(main.match(/new IntegrationRepository\(/g).length, 1);
  // git is read only in the repository the person chose: the builder never looks at a session's working folder.
  const built = main.slice(builder, next);
  assert.ok(built.includes('const folder = repository.usable();') && !/\.cwd\b/.test(built) && !/integratorRole\.current\(\)\s*;\s*\n\s*const session/.test(built));
  assert.equal(main.match(/NAW_TEST_INTEGRATION_HANDOFF/g).length, 1);
  // backgroundTest is the app's own judgement that this is an isolated test run with its own data folder.
  assert.match(main, /backgroundTest = \/\^\\d\+\$\/\.test\(process\.env\.NAW_TEST_PARENT_PID\)/);
  // The dispatcher runs the engine only when it was given one.
  const dispatch = fs.readFileSync(path.join(__dirname, '../queue-dispatch.cjs'), 'utf8');
  assert.match(dispatch, /\n    this\.integration = null;\n/);
  assert.match(dispatch, /\n    if \(typeof options\.integration === 'function'\) \{\n      try \{ this\.integration = options\.integration\(this\); \} catch \(error\) \{ this\.integrationFault\(error\); \}\n    \}\n  \}\n/);
  assert.equal(dispatch.match(/options\.integration\(/g).length, 1, 'One place builds the engine, and a fault there is caught');
  assert.equal(dispatch.match(/this\.integration = /g).length, 2, 'Absent at first, then the one place that builds it');
  assert.match(dispatch, /if \(this\.integration && !this\.closed\) await this\.integrate\(\);/);
  assert.match(dispatch, /if \(this\.integration && this\.integration\.hasWork\(this\.integrationRooms\(\)\)\) \{/);
  // Nothing else in the app or its scripts builds or loads the engine.
  const root = path.join(__dirname, '../..'), loaders = [];
  const walk = folder => { for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) { if (!['node_modules', '.git', '.local', 'tests', 'dist'].includes(entry.name)) walk(file); }
    else if (/\.(cjs|mjs|js)$/.test(entry.name) && !/^integrator-(engine|handoff|git|repository)\.cjs$/.test(entry.name) && /require\(['"]\.\/integrator-(engine|handoff|git|repository)\.cjs['"]\)/.test(fs.readFileSync(file, 'utf8'))) loaders.push(path.relative(root, file));
  } };
  walk(path.join(root, 'app')); walk(path.join(root, 'scripts'));
  assert.deepEqual(loaders, ['app/main.cjs']);
});


test('a reply with the wrong dispatch purpose cannot publish an integrator delivery', async t => {
  for (const change of ['source', 'item', 'native', 'epoch', 'rotation']) {
    const f = fixture(t, { plain: true }), itemId = f.room.queueAdd('Synthetic task', null);
    await f.pass();
    const member = f.client.state.sessions.find(s => s.id === 'member-a'), input = member.messages.at(-1);
    if (change === 'source') input.origin = 'human';
    if (change === 'item') input.dispatchItem = 'another-item';
    if (change === 'native') input.dispatchPurpose.nativeId = 'another-native';
    if (change === 'epoch') input.dispatchPurpose.epoch = 'stale-epoch';
    if (change === 'rotation') input.dispatchPurpose.kind = 'rotation-request';
    f.reply(member.id, `Done.\nREADY lane/a ${COMMIT}`);
    await f.pass();
    const item = f.room.queueFind('shared', itemId);
    assert.equal(item.status, 'waiting', change);
    assert.equal(item.reason, 'input-purpose-unconfirmed', change);
    assert.equal(item.ready, undefined, change);
    assert.ok(!f.room.metadata('shared').events.some(event => event.monitor?.kind === 'ready'), change);
    assert.equal(f.calls.length, 1, 'No input was replayed');
  }
});
