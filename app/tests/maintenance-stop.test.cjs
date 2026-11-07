// Actual Workspace and Codex stop paths, held at a deterministic observation
// boundary. RPC and terminal are local counters; no provider process starts.
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Workspace } = require('../workspace.cjs');
const { Codex, Claude } = require('../adapters.cjs');
const { sessionPlan, backendPlan, maintenanceProof } = require('../backend-switch.cjs');

function fixture() {
  const s = { id: 'local', name: 'Synthetic', nativeId: 'saved-thread', provider: 'codex', state: 'idle',
    owner: 'original-view', view: 'chat', controlRevision: 7, connectionRevision: 3, draftRevision: 0, messages: [] };
  const calls = [], r = Object.create(Codex.prototype); EventEmitter.call(r);
  Object.assign(r, { record: s, lifecycleRevision: 0, stateRevision: 0, stopped: false, turnId: null,
    observing: Promise.resolve(), nativeRequests: new Map(), host: { codexTargets: new Map(), rpc: { call: async (method, params) => {
      calls.push([method, params]); return method === 'thread/unsubscribe' ? { status: 'unsubscribed' } : {};
    } } }, terminal: { stop: async () => { calls.push(['terminal.stop']); } } });
  const w = Object.create(Workspace.prototype); EventEmitter.call(w);
  Object.assign(w, { sessions: new Map([[s.id, s]]), runtimes: new Map([[s.id, r]]), draftRevisions: new Map(),
    stops: new Map(), rooms: new Map([['shared', { run: null }]]), approvalRoutes: new Map(),
    pause: () => calls.push(['workspace.pause']), changed: () => {}, persist: () => {} });
  return { s, r, w, calls, expected: structuredClone(sessionPlan(s, s.state).stop) };
}

test('unchanged maintenance stops the saved thread without an interrupt or a goal write', async () => {
  const f = fixture();
  const receipt = await f.w.maintenanceStop(f.s.id, f.expected);
  assert.equal(receipt.stopped, true); assert.deepEqual(receipt.expected, f.expected);
  assert.equal(receipt.stoppedState.controlRevision, 8); assert.equal(receipt.stoppedState.connectionRevision, 4);
  assert.deepEqual(f.calls.map(([method]) => method), ['workspace.pause', 'terminal.stop', 'thread/unsubscribe']);
  assert.equal(f.s.state, 'disconnected'); assert.equal(f.s.nativeId, 'saved-thread'); assert.equal(f.s.owner, 'original-view');
  assert.equal(f.w.stops.size, 0);
});

const changes = {
  working: f => { f.s.state = 'working'; f.r.turnId = 'new-human-turn'; f.s.pendingTag = 'new-input'; },
  owner: f => { f.s.owner = 'new-human-view'; },
  control: f => { f.s.controlRevision++; },
  connection: f => { f.s.connectionRevision++; },
  identity: f => { f.s.nativeId = 'different-thread'; },
  view: f => { f.s.view = 'terminal'; },
  draft: f => { f.w.draftRevisions.set(f.s.id, 1); },
  input: f => { f.s.peerRevision = 1; },
  approval: f => { f.s.approval = { id: 'new-approval' }; },
  relay: f => { f.w.rooms.get('shared').run = { status: 'running', ids: [f.s.id] }; },
  queue: f => { f.r.pendingQueue = 'new-queued-input'; },
  nativeState: f => { f.r.stateRevision++; },
};
for (const [name, change] of Object.entries(changes)) test(`a late ${name} during observation refuses maintenance with zero stop side effects`, async () => {
  const f = fixture(); let release;
  f.r.observing = new Promise(resolve => { release = resolve; });
  const operation = f.w.maintenanceStop(f.s.id, f.expected);
  await Promise.resolve();
  assert.equal(f.r.stopped, false, 'keep observing native state during the wait');
  change(f); const newer = structuredClone(f.s);
  release();
  await assert.rejects(operation, error => error.uiMessage?.key === 'error.backendSwitchSessionChanged');
  assert.deepEqual(f.calls, [], 'no pause, interrupt, terminal stop or unsubscribe');
  assert.deepEqual(f.s, newer, 'do not rewrite newer work, ownership or activity to error');
  assert.equal(f.r.stopped, false); assert.equal(f.w.stops.size, 0);
});

test('a stale request at the service boundary never begins a runtime stop', async () => {
  const f = fixture(); f.s.controlRevision++;
  assert.throws(() => f.w.maintenanceStop(f.s.id, f.expected), /状态已变化/);
  assert.deepEqual(f.calls, []);
});

test('an explicit manual stop still interrupts current work', async () => {
  const f = fixture(); f.s.state = 'working'; f.r.turnId = 'actual-turn';
  await f.w.stop(f.s.id);
  assert.equal(f.calls.filter(([method]) => method === 'turn/interrupt').length, 1);
  assert.equal(f.calls.filter(([method]) => method === 'thread/unsubscribe').length, 1);
});

test('the Claude maintenance wrapper checks before any ordinary stop side effect', async () => {
  let stops = 0; const runtime = Object.create(Claude.prototype); runtime.stop = () => { stops++; };
  assert.throws(() => runtime.stopForMaintenance(() => { throw Error('new human input'); }), /new human input/);
  assert.equal(stops, 0); runtime.stopForMaintenance(() => {}); assert.equal(stops, 1);
});

test('occupied legacy backends are explicit refusals; already-ended ones need no stop capability', () => {
  const f = fixture(), state = { servicePid: 123, capabilities: ['atomicShutdown', 'resume'], sessions: [f.s] };
  assert.equal(backendPlan(state).ready, false);
  state.capabilities.push('conditionalMaintenanceStopV1'); assert.equal(backendPlan(state).ready, true);
  state.capabilities.pop(); f.s.state = 'ended'; assert.equal(backendPlan(state).ready, true);
});

for (const key of ['owner', 'controlRevision', 'draftRevision']) test('rollback resume refuses a newer '+key+' at the service boundary', () => {
  const f = fixture(); f.s.state = 'disconnected'; const expected = { ...f.expected, state: f.s.state };
  f.w.resume = () => assert.fail('No restore under newer human authority');
  if (key === 'draftRevision') f.w.draftRevisions.set(f.s.id, 1);
  else f.s[key] = key === 'owner' ? 'new-human-view' : 8;
  assert.throws(() => f.w.maintenanceResume(f.s.id, expected, 'original-view'), /状态已变化/);
  assert.deepEqual(f.calls, []);
});

test('newer authority during terminal shutdown is retained without an old-owner rollback receipt', async () => {
  const f = fixture(); let release;
  f.r.terminal.stop = () => new Promise(resolve => { release = resolve; });
  const operation = f.w.maintenanceStop(f.s.id, f.expected);
  await Promise.resolve(); await Promise.resolve();
  f.s.owner = 'new-human-view'; f.s.controlRevision++; f.s.activity = 'new human choice';
  const newer = structuredClone(f.s); release();
  await assert.rejects(operation, /没有确认断开/);
  assert.deepEqual(f.s, newer); assert.equal(f.w.stops.size, 0);
});

for (const kind of ['baseline', 'owner', 'working', 'draft', 'newSession', 'newTurn']) test('final service shutdown guard: '+kind, () => {
  const f = fixture(); f.s.state = 'disconnected';
  const proof = [maintenanceProof(f.s)];
  if (kind === 'owner') f.s.owner = 'new-human-view';
  if (kind === 'working') f.s.state = 'working';
  if (kind === 'draft') f.w.draftRevisions.set(f.s.id, 1);
  if (kind === 'newSession') f.w.sessions.set('new', { id: 'new', state: 'working' });
  if (kind === 'newTurn') f.r.turnId = 'new-turn';
  if (kind === 'baseline') f.w.assertMaintenanceShutdown(proof);
  else assert.throws(() => f.w.assertMaintenanceShutdown(proof), error => error.uiMessage?.key === 'error.backendSwitchOldPending' && !error.message.includes('没有结束任何会话'));
  assert.deepEqual(f.calls, []);
});

for (const count of [0, 1]) test('final guard retains '+count+' carried recoverable records without a process', () => {
  const f = fixture(); f.s.state = 'disconnected';
  if (count) f.w.sessions.set('saved', { id: 'saved', name: 'Saved', provider: 'claude', nativeId: 'saved-native', state: 'recoverable', draftRevision: 0 });
  const proof = [...f.w.sessions.values()].map(maintenanceProof);
  f.w.assertMaintenanceShutdown(proof); assert.deepEqual(f.calls, []);
});

test('a legacy recoverable carry is rejected before any stops', () => {
  const f = fixture(), saved = { ...f.s, id: 'saved', state: 'recoverable' };
  const state = { servicePid: 123, capabilities: ['atomicShutdown', 'resume'], sessions: [saved] };
  assert.equal(backendPlan(state).ready, false);
  state.sessions.push(f.s); assert.equal(backendPlan(state).ready, false);
});
