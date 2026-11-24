// Actual Workspace and Codex stop paths, held at a deterministic observation
// boundary. RPC and terminal are local counters; no provider process starts.
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Workspace } = require('../workspace.cjs');
const { Codex, Claude } = require('../adapters.cjs');
const { sessionPlan, backendPlan, maintenanceProof, sameStop } = require('../backend-switch.cjs');

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

// How the daily alpha.220 backend (same code since) answered a Claude maintenance stop on 2026-11-08: the real
// stop() and endNativeContext(); the runtime stand-in keeps the native order, SessionEnd's context end first,
// then the terminal close reaching the runtime's own listener (ended, runtime dropped), then stop() resolving.
test('a Claude terminal that ends itself during a maintenance stop makes the backend refuse its own receipt', async () => {
  const s = { id: 'local', name: 'Synthetic', nativeId: 'saved-session', provider: 'claude', state: 'idle', owner: 'original-view', view: 'terminal',
    controlRevision: 284, connectionRevision: 18, draftRevision: 0, peerRevision: 4694, memberRevision: 3, messages: [], fleet: [],
    terminalInputPending: false, backgroundStale: false, background: 0, scheduled: 0 };
  const r = Object.create(Claude.prototype); EventEmitter.call(r);
  const w = Object.create(Workspace.prototype); EventEmitter.call(w);
  Object.assign(w, { sessions: new Map([[s.id, s]]), runtimes: new Map([[s.id, r]]), draftRevisions: new Map(), drafts: new Map(), pendingDrafts: new Map(),
    stops: new Map(), rooms: new Map([['shared', { run: null }]]), approvalRoutes: new Map(),
    pause: () => {}, pauseParticipant: () => {}, changed: () => {}, persist: () => {} });
  r.stop = async () => {
    w.endNativeContext(s, r, { nativeId: s.nativeId, reason: 'other' });
    s.state = 'ended';
    w.runtimes.delete(s.id);
    return { state: 'ended' };
  };
  const expected = structuredClone(sessionPlan(s, s.state).stop);
  await assert.rejects(w.maintenanceStop(s.id, expected), error => error.uiMessage?.key === 'error.backendSwitchDisconnectUnconfirmed');
  assert.equal(s.state, 'ended'); assert.equal(w.runtimes.has(s.id), false); assert.equal(w.stops.size, 0); assert.equal(s.nativeContextPending, null);
  // What the window then accepts as this stop (backend-switch.cjs endedByThisStop): all as planned, both revisions +2.
  assert.ok(sameStop(s, { ...expected, controlRevision: 286, connectionRevision: 20 }));
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

// cd3e2a8d (2026-11-14): a rotation ends one old session. Its stop pauses only that session's relays, so another
// space's relay keeps running; the backend switch, which ends every session, still pauses every relay.
for (const scope of ['participant', undefined]) test(`a maintenance stop ${scope ? 'for one session leaves' : 'of the backend switch pauses'} another space's relay`, async () => {
  const f = fixture(); delete f.w.pause;
  const other = '7a1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8';
  const run = { id: 'other-run', roomId: other, ids: ['someone-else'], status: 'running', steps: 1 };
  f.w.rooms = new Map([['shared', { id: 'shared', revision: 0, run: null, messages: [] }], [other, { id: other, revision: 0, run, messages: [] }]]);
  const revoked = []; f.w.peerLeases = { revoke: (_reason, id, roomId) => revoked.push([id, roomId]) };
  const receipt = await f.w.maintenanceStop(f.s.id, f.expected, false, scope);
  assert.equal(receipt.stopped, true); assert.equal(f.s.state, 'disconnected');
  assert.equal(run.status, scope ? 'running' : 'paused');
  if (scope) assert.deepEqual(revoked, [[f.s.id, undefined]], 'only grants that include this session are withdrawn');
  else assert.ok(revoked.some(([id, roomId]) => id === undefined && roomId === undefined), 'every grant is withdrawn');
});

test('an unknown stop scope is refused before anything stops', () => {
  const f = fixture();
  assert.throws(() => f.w.maintenanceStop(f.s.id, f.expected, false, 'everyone-but-me'), error => error.uiMessage?.key === 'error.backendSwitchSessionChanged');
  assert.deepEqual(f.calls, []); assert.equal(f.s.state, 'idle');
});

function failedHandoffFixture() {
  const f = fixture(); Object.assign(f.w, { drafts: new Map(), pauseParticipant: () => {}, persist: () => true });
  f.s.placementRevision = 0; f.s.roomIds = ['shared']; f.s.state = 'error';
  f.s.messages = [{ id: 'handoff', role: 'user', origin: 'naw-dispatch', nativeId: f.s.nativeId, turnId: 'handoff-turn', dispatchPurpose: { kind: 'rotation-handoff' } }];
  f.proof = { nativeId: f.s.nativeId, controlRevision: f.s.controlRevision, draftRevision: 0, placementRevision: 0 };
  return f;
}

test('failed handoff cleanup uses actual guarded Codex stop and its saved receipt survives a lost reply', async () => {
  const f = failedHandoffFixture(); f.r.turnId = 'handoff-turn';
  const first = await f.w.stopFailedSuccessor(f.s.id, f.proof, 'handoff');
  assert.equal(first.state, 'disconnected'); assert.deepEqual(f.s.failedHandoffStop, first.receipt);
  assert.deepEqual(f.calls.find(c => c[0] === 'turn/interrupt')[1], { threadId: 'saved-thread', turnId: 'handoff-turn' });
  const calls = f.calls.length;
  const second = await f.w.stopFailedSuccessor(f.s.id, f.proof, 'handoff');
  assert.deepEqual(second, first); assert.equal(f.calls.length, calls, 'a lost reply never repeats native stop');
});
for (const change of ['input', 'draft', 'native turn', 'control', 'native identity']) test(`failed handoff stop refuses ${change} arriving during native observation`, async () => {
  const f = failedHandoffFixture(); let release;
  f.r.observing = new Promise(r => { release = r; });
  const stopping = f.w.stopFailedSuccessor(f.s.id, f.proof, 'handoff');
  if (change === 'input') f.s.messages.push({ id: 'person', role: 'user' });
  if (change === 'draft') f.w.drafts.set(f.s.id, 'synthetic draft');
  if (change === 'native turn') f.r.turnId = 'human-turn';
  if (change === 'control') f.s.controlRevision++;
  if (change === 'native identity') f.s.nativeId = 'other-thread';
  release(); await assert.rejects(stopping); assert.deepEqual(f.calls, []); assert.equal(f.s.state, 'error');
});
test('failed successor removal refuses human use after a confirmed stop', async () => {
  const f = failedHandoffFixture(); const receipt = await f.w.stopFailedSuccessor(f.s.id, f.proof, 'handoff');
  f.s.messages.push({ id: 'person-after-stop', role: 'user' });
  assert.throws(() => f.w.moveMembership(f.s.id, null, { operationId: '11111111-1111-4111-8111-111111111111',
    nativeId: f.s.nativeId, revision: 0, connectionRevision: f.s.connectionRevision, unusedSuccessor: true,
    failedHandoff: { receipt: receipt.receipt, tag: 'handoff' } }));
  assert.deepEqual(f.s.roomIds, ['shared']);
});

for (const change of ['turn', 'queued input', 'goal']) test(`failed successor detach protects live runtime ${change} after stop`, async () => {
  const f = failedHandoffFixture(); const receipt = await f.w.stopFailedSuccessor(f.s.id, f.proof, 'handoff');
  if (change === 'turn') f.r.turnId = 'new-person-turn';
  if (change === 'queued input') f.r.pendingQueue = ['new-person-input'];
  if (change === 'goal') f.r.nativeGoalSnapshot = () => ({ status: 'active' });
  assert.throws(() => f.w.moveMembership(f.s.id, null, { operationId: '11111111-1111-4111-8111-111111111111',
    nativeId: f.s.nativeId, revision: 0, connectionRevision: f.s.connectionRevision, unusedSuccessor: true,
    failedHandoff: { receipt: receipt.receipt, tag: 'handoff' } }));
  assert.deepEqual(f.s.roomIds, ['shared']);
});
for (const change of ['none', 'person', 'native context']) test(`r3 ended successor yields only current writer observation: ${change}`, async () => {
  const f = failedHandoffFixture(); f.s.state = 'ended'; f.w.runtimes.delete(f.s.id);
  if (change === 'person') { f.s.messages.push({ id: 'person', role: 'user' }); f.s.controlRevision++; }
  if (change === 'native context') f.s.nativeId = 'replacement-native';
  const observed = await f.w.stopFailedSuccessor(f.s.id, f.proof, 'handoff');
  assert.equal(observed.basis, 'observed-inactive'); assert.equal(observed.proof.nativeId, f.s.nativeId);
  assert.equal(observed.proof.controlRevision, f.s.controlRevision); assert.equal(observed.receipt, undefined);
  assert.equal(f.s.failedHandoffStop, undefined); assert.deepEqual(f.calls, []);
});

test('r3 authentic writer stop receipt authorizes the untouched stopped member leave', async () => {
  const f = failedHandoffFixture(); f.w.pauseRoom = () => {}; f.w.sharedReplies = { refresh() {} };
  f.w.rooms.get('shared').revision = 0;
  const result = await f.w.stopFailedSuccessor(f.s.id, f.proof, 'handoff');
  assert.equal(result.basis, 'stopped-by-this-attempt');
  const moved = f.w.moveMembership(f.s.id, null, { operationId: '11111111-1111-4111-8111-111111111111', nativeId: f.s.nativeId,
    revision: 0, connectionRevision: f.s.connectionRevision, unusedSuccessor: true,
    failedHandoff: { receipt: result.receipt, tag: 'handoff' } });
  assert.equal(moved.changed, true); assert.deepEqual(f.s.roomIds, []);
});
for (const kind of ['observation', 'legacy untyped', 'forged typed']) test(`r3 ${kind} evidence cannot authorize membership removal`, () => {
  const f = failedHandoffFixture(); f.s.state = 'ended'; f.w.runtimes.delete(f.s.id);
  const evidence = kind === 'observation' ? { basis: 'observed-inactive', state: 'ended', proof: f.proof }
    : { ...(kind === 'forged typed' ? { basis: 'stopped-by-this-attempt' } : {}), tag: 'handoff', owner: f.proof, proof: f.proof };
  if (kind !== 'forged typed') f.s.failedHandoffStop = evidence;
  assert.throws(() => f.w.moveMembership(f.s.id, null, { operationId: '11111111-1111-4111-8111-111111111111', nativeId: f.s.nativeId,
    revision: 0, connectionRevision: f.s.connectionRevision, unusedSuccessor: true,
    failedHandoff: { receipt: evidence, tag: 'handoff' } }), e => e.uiMessage?.key === 'error.movePlacementChanged');
  assert.deepEqual(f.s.roomIds, ['shared']);
});
