// Real Workspace/Codex stop boundaries with synthetic RPC and terminal counters.
// No provider process, model, native input or goal mutation is started here.
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Workspace } = require('../workspace.cjs');
const { Codex } = require('../adapters.cjs');

function fixture() {
  const s = { id: 'unused', name: 'Unused successor', nativeId: 'unused-thread', provider: 'codex', state: 'starting',
    owner: 'original-view', view: 'terminal', controlRevision: 7, connectionRevision: 3, peerRevision: 0, placementRevision: 0,
    messages: [], fleet: [], background: null, scheduled: null, pendingTag: null };
  const calls = [], r = Object.create(Codex.prototype); EventEmitter.call(r);
  Object.assign(r, { record: s, lifecycleRevision: 0, stateRevision: 0, stopped: false, turnId: null,
    observing: Promise.resolve(), nativeRequests: new Map(), host: { codexTargets: new Map(), rpc: { call: async (method, args) => {
      calls.push([method, args]); return method === 'thread/unsubscribe' ? { status: 'unsubscribed' } : {};
    } } }, terminal: { stop: async () => { calls.push(['terminal.stop']); } } });
  const w = Object.create(Workspace.prototype); EventEmitter.call(w);
  Object.assign(w, { sessions: new Map([[s.id, s]]), runtimes: new Map([[s.id, r]]), draftRevisions: new Map(), drafts: new Map(),
    stops: new Map(), rooms: new Map([['shared', { run: null }]]), approvalRoutes: new Map(),
    pause: () => calls.push(['workspace.pause']), changed: () => {}, persist: () => {} });
  return { s, r, w, calls, proof: { nativeId: s.nativeId, controlRevision: s.controlRevision, draftRevision: 0, placementRevision: 0 } };
}
const refused = error => error.uiMessage?.key === 'error.backendSwitchSessionChanged';

test('guarded unused stop detaches only the proven thread without input, interrupt or a goal write', async () => {
  const f = fixture();
  assert.deepEqual(await f.w.stopUnusedSuccessor(f.s.id, f.proof), { state: 'disconnected' });
  assert.deepEqual(f.calls, [['terminal.stop'], ['thread/unsubscribe', { threadId: 'unused-thread' }]]);
  assert.equal(f.s.nativeId, f.proof.nativeId); assert.equal(f.w.stops.size, 0);
});

test('guarded unused stop can close an uninitialized Codex terminal with explicit null native identity', async () => {
  const f = fixture(); f.s.nativeId = null; f.proof.nativeId = null;
  assert.deepEqual(await f.w.stopUnusedSuccessor(f.s.id, f.proof), { state: 'ended' });
  assert.deepEqual(f.calls, [['terminal.stop']]);
  assert.equal(f.w.runtimes.has(f.s.id), false);
});

for (const proof of [undefined, null, [], {}, { nativeId: 'unused-thread', controlRevision: 7 },
  { nativeId: undefined, controlRevision: 7, draftRevision: 0, placementRevision: 0 },
  { nativeId: '', controlRevision: 7, draftRevision: 0, placementRevision: 0 },
  { nativeId: 'other-thread', controlRevision: 7, draftRevision: 0, placementRevision: 0 },
  { nativeId: 'unused-thread', controlRevision: '7', draftRevision: 0, placementRevision: 0 },
  { nativeId: 'unused-thread', controlRevision: -1, draftRevision: 0, placementRevision: 0 },
  { nativeId: 'unused-thread', controlRevision: 7, draftRevision: NaN, placementRevision: 0 },
  { nativeId: 'unused-thread', controlRevision: 7, draftRevision: 0 },
  { nativeId: 'unused-thread', controlRevision: 7, draftRevision: 0, placementRevision: null },
  { nativeId: 'unused-thread', controlRevision: 7, draftRevision: 0, placementRevision: '0' },
  { nativeId: 'unused-thread', controlRevision: 7, draftRevision: 0, placementRevision: -1 },
  { nativeId: 'unused-thread', controlRevision: 7, draftRevision: 0, placementRevision: Number.MAX_SAFE_INTEGER + 1 },
  { nativeId: 'unused-thread', controlRevision: 7, draftRevision: 0, placementRevision: 0, owner: 'forged-view' },
]) test(`guarded unused stop rejects malformed or stale proof ${JSON.stringify(proof)}`, async () => {
  const f = fixture();
  await assert.rejects(f.w.stopUnusedSuccessor(f.s.id, proof), refused);
  assert.deepEqual(f.calls, []); assert.equal(f.s.state, 'starting');
});

const changes = {
  identity: f => { f.s.nativeId = 'new-thread'; },
  control: f => { f.s.controlRevision++; },
  placement: f => { f.s.placementRevision++; },
  draftRevision: f => { f.w.draftRevisions.set(f.s.id, 1); },
  draft: f => { f.w.drafts.set(f.s.id, 'unsent personal draft'); },
  working: f => { f.s.state = 'working'; },
  queued: f => { f.r.pendingQueue = { id: 'native-queue' }; },
  steer: f => { f.r.pendingSteer = { id: 'native-steer' }; },
  pendingTag: f => { f.s.pendingTag = 'new-input'; },
  pendingContext: f => { f.s.nativeContextPending = true; },
  nativeTurn: f => { f.r.turnId = 'active-turn'; },
  rootTurn: f => { f.r.rootTurn = { status: 'working' }; },
  nativeInput: f => { f.r.nativeInputRequired = true; },
  goal: f => { f.r.nativeGoalSnapshot = () => ({ status: 'active' }); },
  unknownGoal: f => { f.r.nativeGoalSnapshot = () => ({ known: false }); },
  userHistory: f => { f.s.messages.push({ role: 'user', text: 'a person started work' }); },
  assistantHistory: f => { f.s.messages.push({ role: 'assistant', text: 'work already happened' }); },
  background: f => { f.s.background = 1; },
  schedule: f => { f.s.scheduled = 1; },
  fleet: f => { f.s.fleet.push({ event: 'SubagentStart' }); },
  collaboration: f => { f.w.rooms.get('shared').run = { status: 'running', ids: [f.s.id] }; },
};
for (const [name, change] of Object.entries(changes)) test(`guarded unused stop preserves ${name} before any native side effect`, async () => {
  const f = fixture(); change(f); const newer = structuredClone(f.s);
  await assert.rejects(f.w.stopUnusedSuccessor(f.s.id, f.proof), refused);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.s, newer);
});

for (const name of ['identity', 'control', 'placement', 'draftRevision', 'draft', 'goal', 'userHistory', 'nativeTurn']) test(`guarded unused stop rechecks ${name} after the native observation wait`, async () => {
  const f = fixture(); let release;
  f.r.observing = new Promise(resolve => { release = resolve; });
  const operation = f.w.stopUnusedSuccessor(f.s.id, f.proof);
  await Promise.resolve(); assert.equal(f.s.state, 'starting');
  changes[name](f); const newer = structuredClone(f.s); release();
  await assert.rejects(operation, refused);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.s, newer); assert.equal(f.w.stops.size, 0);
});

test('guarded unused stop rejects a newer view owner during the native observation wait', async () => {
  const f = fixture(); let release;
  f.r.observing = new Promise(resolve => { release = resolve; });
  const operation = f.w.stopUnusedSuccessor(f.s.id, f.proof); await Promise.resolve();
  f.s.owner = 'new-view'; const newer = structuredClone(f.s); release();
  await assert.rejects(operation, refused);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.s, newer);
});

test('concurrent guarded requests do not both stop the same native connection', async () => {
  const f = fixture(); let release;
  f.r.observing = new Promise(resolve => { release = resolve; });
  const first = f.w.stopUnusedSuccessor(f.s.id, f.proof), second = f.w.stopUnusedSuccessor(f.s.id, f.proof);
  await Promise.resolve(); release();
  const results = await Promise.allSettled([first, second]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.equal(f.calls.filter(([method]) => method === 'terminal.stop').length, 1);
});

for (const state of ['ended', 'recoverable', 'disconnected']) test(`guarded unused stop only observes an already ${state} row`, async () => {
  const f = fixture(); f.s.state = state; f.s.controlRevision++; f.w.runtimes.clear();
  assert.deepEqual(await f.w.stopUnusedSuccessor(f.s.id, f.proof), { state });
  assert.deepEqual(f.calls, []);
  f.s.placementRevision++;
  await assert.rejects(f.w.stopUnusedSuccessor(f.s.id, f.proof), refused);
  f.s.placementRevision--;
  f.s.nativeId = 'another-thread';
  await assert.rejects(f.w.stopUnusedSuccessor(f.s.id, f.proof), refused);
});

test('an unconfirmed native stop is rejected rather than reported as an ended successor', async () => {
  const f = fixture(); f.r.terminal.stop = async () => { throw Error('native exit unconfirmed'); };
  await assert.rejects(f.w.stopUnusedSuccessor(f.s.id, f.proof), /native exit unconfirmed/);
  assert.equal(f.s.state, 'error'); assert.equal(f.w.stops.size, 0);
  assert.equal(f.calls.some(([method]) => method === 'thread/unsubscribe'), false);
});

test('ordinary person-requested stop is unchanged and does not require an unused proof', async () => {
  const f = fixture(); f.s.messages.push({ role: 'user', text: 'existing work' }); f.s.state = 'working';
  f.r.stop = async () => { f.calls.push(['ordinary-stop']); return { state: 'ended' }; };
  assert.equal(await f.w.stop(f.s.id), undefined); assert.equal(f.s.state, 'ended');
  assert.deepEqual(f.calls, [['workspace.pause'], ['ordinary-stop']]);
});

test('guarded cleanup preserves a running collaboration and goals belonging to other participants', async () => {
  const f = fixture(), other = { id: 'other-run', status: 'running', ids: ['another-session'] };
  f.w.rooms.set('other-room', { run: other });
  const cancellations = []; f.w.goalContinuationCancel = (room, id) => cancellations.push([room, id]);
  await f.w.stopUnusedSuccessor(f.s.id, f.proof);
  assert.equal(other.status, 'running');
  assert.deepEqual(cancellations, [[undefined, f.s.id]]);
  assert.equal(f.calls.some(([method]) => method === 'workspace.pause'), false);
});

test('a runtime without the final guard does not fall back to its ordinary stop', async () => {
  const f = fixture(); f.r.stopForMaintenance = undefined;
  await assert.rejects(f.w.stopUnusedSuccessor(f.s.id, f.proof), refused);
  assert.deepEqual(f.calls, []);
});

test('serialized daemon RPC advertises and executes guarded stop on a synthetic provider', { timeout: 15000 }, async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { fork } = require('node:child_process'), { once } = require('node:events');
  const { connect } = require('../service-client.cjs');
  const root = path.resolve(__dirname, '../..'), directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-guarded-stop-')));
  const fixture = path.join(directory, 'synthetic-native.cjs');
  fs.writeFileSync(fixture, `require(${JSON.stringify(path.join(root, 'scripts/fixtures/queue-native.cjs'))});\n` +
    `const { NativeHost } = require(${JSON.stringify(path.join(root, 'app/adapters.cjs'))});\n` +
    `const create = NativeHost.prototype.create; NativeHost.prototype.create = function (record) { const runtime = create.call(this, record); runtime.stopForMaintenance = async check => { check(); return runtime.stop(); }; return runtime; };\n`);
  const child = fork(path.join(root, 'app/daemon.cjs'), [directory], { execArgv: ['--require', fixture],
    env: { PATH: process.env.PATH, HOME: directory, TMPDIR: os.tmpdir(), NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: directory },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let client;
  t.after(async () => {
    client?.close();
    if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(path.join(directory, 'connection.json'))) {
    assert.ok(Date.now() < deadline && child.exitCode === null, 'owned synthetic service starts');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  client = await connect(directory, 'guarded-stop-test');
  const id = await client.call('create', { provider: 'codex', cwd: directory, name: 'Unused', view: 'terminal' });
  await client.refresh();
  const target = client.route(id), s = target.state.sessions.find(session => session.id === id);
  assert.ok(target.state.capabilities.includes('guardedSessionStopV1'));
  assert.deepEqual(await target.client.call('stopUnusedSuccessor', id, { nativeId: s.nativeId, controlRevision: s.controlRevision, draftRevision: 0,
    placementRevision: require('../collaboration-spaces.cjs').placementRevision(s) }), { state: 'ended' });
  await client.refresh();
  assert.equal(client.snapshot().sessions.find(session => session.id === id).state, 'ended');
});
