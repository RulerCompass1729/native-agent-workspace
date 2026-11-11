const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { RoomState } = require('../room-state.cjs');
const { QueueDispatcher, CAPABILITY, INTEGRATOR_ABSENT_MS } = require('../queue-dispatch.cjs');
const { IntegrationHandoffs, FILE } = require('../integrator-handoff.cjs');
const { IntegratorEngine } = require('../integrator-engine.cjs');

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
  client.call = async (method, id, text, nativeId, itemId) => {
    // What the space record asks of a backend while it archives a session; nothing here sends a message.
    if (method === 'initial') return client.snapshot();
    if (['pause', 'resumeRoom'].includes(method)) return undefined;
    assert.equal(method, 'dispatch');
    const target = client.state.sessions.find(candidate => candidate.id === id);
    assert.equal(target.nativeId, nativeId);
    const tag = `tag-${f.calls.length + 1}`;
    f.calls.push({ id, text, itemId, tag });
    target.state = 'working'; target.messages.push({ id: tag, role: 'user', text, origin: 'naw-dispatch', status: 'submitted', time: Date.now() });
    return tag;
  };
  f.reply = (id, text) => { const target = client.state.sessions.find(candidate => candidate.id === id); target.messages.push({ id: `reply-${target.messages.length}`, role: 'assistant', text, time: Date.now() }); target.state = 'idle'; };
  f.handoffs = new IntegrationHandoffs(directory);
  // git: the delivery was cherry-picked, and HEAD2 holds it.
  const read = { commit: async value => [MAIN, HEAD2, COMMIT].find(id => id.startsWith(value)) || null, isAncestor: async (a, b) => b === HEAD2,
    changes: async (base, tip) => (tip === HEAD2 ? [{ commit: 'm1', change: 'x-1' }] : [{ commit: tip, change: 'x-1' }]) };
  const engine = dispatcher => new IntegratorEngine({ handoffs: f.handoffs, now: () => Date.now() + f.skew, designation: () => { if (f.designated instanceof Error) throw f.designated; return f.designated; },
    mainHead: async () => { f.heads += 1; return f.head; }, reader: read, send: (target, text, handoffId) => dispatcher.send(target, text, handoffId), typing: id => dispatcher.noteHuman(id),
    record: fact => room.recordHandoff(fact), notify: async info => { f.notices.push(info); } });
  f.dispatcher = new QueueDispatcher({ roomState: room, dataDir: directory, clients: () => client, now: () => Date.now() + f.skew, settleMs: 0, humanQuietMs: 0, broadcast: async () => { f.broadcasts += 1; },
    sampleProcesses: async () => '', samplePressure: async () => '', ...(options.plain ? {} : { integration: engine, integrationUnreadable: () => { f.unreadable += 1; }, integrationFailed: error => { f.failed.push(error.message); } }) });
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
  // The fault is gone: the next pass takes the delivery in and hands it out.
  broken = false;
  await f.pass(); await f.pass();
  assert.deepEqual(f.states(), { 'lane/a': 'handed' });
  // After the recovery the same fault is not told again, and another kind of fault is.
  let fault = 'Synthetic engine fault';
  f.dispatcher.integration.pass = async () => { throw Error(fault); };
  await f.pass(); await f.pass();
  assert.deepEqual(f.failed, ['Synthetic engine fault']);
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
});

test('the engine is built only behind a switch that the daily app cannot open', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  // One place builds it, and that place is inside the test-only condition.
  assert.equal(main.match(/integrationEngine\(/g).length, 2, 'Its definition and one call');
  assert.match(main, /if \(backgroundTest && process\.env\.NAW_TEST_INTEGRATION_HANDOFF === '1'\) \{\n      options\.integration = dispatcher => integrationEngine\(dispatcher\);\n      options\.integrationUnreadable = \(\) => notifyHandoff\(null\);\n      options\.integrationFailed = \(\) => notifyHandoff\(undefined\);\n    \}/);
  // The three modules are loaded inside that function only: with the switch closed the daily app does not read them.
  const builder = main.indexOf('function integrationEngine(dispatcher) {'), next = main.indexOf('\nfunction ', builder + 10);
  for (const name of ['integrator-handoff', 'integrator-engine', 'integrator-git']) {
    const places = [...main.matchAll(new RegExp(`require\\('\\./${name}\\.cjs'\\)`, 'g'))].map(match => match.index);
    assert.equal(places.length, 1, name); assert.ok(places[0] > builder && places[0] < next, name);
  }
  assert.equal(main.match(/new IntegratorEngine\(/g).length, 1); assert.equal(main.match(/new IntegrationHandoffs\(/g).length, 1);
  assert.equal(main.match(/NAW_TEST_INTEGRATION_HANDOFF/g).length, 1);
  // backgroundTest is the app's own judgement that this is an isolated test run with its own data folder.
  assert.match(main, /backgroundTest = \/\^\\d\+\$\/\.test\(process\.env\.NAW_TEST_PARENT_PID\)/);
  // The dispatcher runs the engine only when it was given one.
  const dispatch = fs.readFileSync(path.join(__dirname, '../queue-dispatch.cjs'), 'utf8');
  assert.match(dispatch, /this\.integration = typeof options\.integration === 'function' \? options\.integration\(this\) : null;/);
  assert.match(dispatch, /if \(this\.integration && !this\.closed\) await this\.integrate\(\);/);
  assert.match(dispatch, /if \(this\.integration && this\.integration\.hasWork\(this\.integrationRooms\(\)\)\) \{/);
  // Nothing else in the app or its scripts builds or loads the engine.
  const root = path.join(__dirname, '../..'), loaders = [];
  const walk = folder => { for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) { if (!['node_modules', '.git', '.local', 'tests', 'dist'].includes(entry.name)) walk(file); }
    else if (/\.(cjs|mjs|js)$/.test(entry.name) && !/^integrator-(engine|handoff|git)\.cjs$/.test(entry.name) && /require\(['"]\.\/integrator-(engine|handoff|git)\.cjs['"]\)/.test(fs.readFileSync(file, 'utf8'))) loaders.push(path.relative(root, file));
  } };
  walk(path.join(root, 'app')); walk(path.join(root, 'scripts'));
  assert.deepEqual(loaders, ['app/main.cjs']);
});
