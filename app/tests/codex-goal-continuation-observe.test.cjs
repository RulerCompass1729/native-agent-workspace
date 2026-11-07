const test = require('node:test'), assert = require('node:assert/strict');
const { Codex } = require('../adapters.cjs');
function fixture() {
  const goal = { threadId: 'original-native', status: 'blocked', objective: '  The same original task.  ',
    createdAt: 10, updatedAt: 20, tokenBudget: null, tokensUsed: 42, timeUsedSeconds: 3 };
  const requests = [], rpc = { async call(method, params) { requests.push({ method, params }); return { goal: structuredClone(goal) }; } };
  const record = { nativeId: goal.threadId, controlRevision: 7, messages: [] };
  const runtime = new Codex(record, { rpc });
  runtime.observeSettings({ model: 'fixture-model', effort: 'high' }); runtime.observeStatus({ type: 'idle' });
  Object.defineProperty(record, 'messages', { get() { throw Error('A goal read must not inspect private conversation history'); } });
  return { runtime, goal, requests, rpc, record };
}
test('one exact original-goal read preserves full body, explicit unbounded budget, counters and settings without any setter', async () => {
  const f = fixture(), before = structuredClone(f.goal), result = await f.runtime.goalContinuationObserve();
  assert.deepEqual(result, { known: true, nativeId: f.record.nativeId, state: 'idle', controlRevision: 7,
    settings: { model: 'fixture-model', effort: 'high' }, goal: before,
    approvalPending: false, inputPending: false, waitingOnUser: false, usageLimited: false, budgetLimited: false });
  assert.deepEqual(f.requests, [{ method: 'thread/goal/get', params: { threadId: 'original-native' } }]);
  assert.deepEqual(f.goal, before); assert.equal(f.runtime.goalContinuationResume, undefined);
  assert.equal(f.runtime.goalContinuationCapabilities, undefined);
  result.goal.objective = 'caller changed returned copy'; assert.deepEqual(f.goal, before);
});
test('no stamped effective settings or native status means unknown without reading any goal', async () => {
  for (const change of [f => { f.runtime.nativeSettings = null; }, f => { f.runtime.continuationSettingsSource = null; },
    f => { f.runtime.continuationStatusSource = null; }, f => { f.runtime.observeSettings({ model: 'fixture-model' }); },
    f => { f.runtime.observeSettings({ model: 'fixture-model', effort: 'high' }, {}); },
    f => { f.runtime.observeStatus({ type: 'idle' }, {}); },
    f => { f.runtime.terminalSwitch = 'switching-context'; },
    f => { f.runtime.observeStatus({ type: 'active', activeFlags: ['unknown-future-boundary'] }); }]) {
    const f = fixture(); change(f); assert.equal((await f.runtime.goalContinuationObserve()).known, false); assert.equal(f.requests.length, 0);
  }
});
test('missing native budget/counters, wrong identity and malformed timestamps remain unknown rather than inferred defaults', async () => {
  for (const change of [f => { delete f.goal.tokenBudget; }, f => { delete f.goal.tokensUsed; }, f => { delete f.goal.timeUsedSeconds; },
    f => { f.goal.threadId = 'other-native'; }, f => { f.goal.updatedAt = 9; }, f => { f.goal.tokensUsed = NaN; },
    f => { f.goal.tokenBudget = 0; }, f => { f.goal.objective = '  '; }]) {
    const f = fixture(); change(f); assert.equal((await f.runtime.goalContinuationObserve()).known, false); assert.equal(f.requests.length, 1);
  }
});
test('native read failure, disabled goals and no goal do not reuse display-only state', async () => {
  for (const answer of [null, {}, { goal: null }]) {
    const f = fixture(); f.rpc.call = async () => answer;
    f.runtime.observeNativeGoal({ threadId: 'original-native', goal: f.goal }, f.rpc);
    assert.equal(f.runtime.nativeGoalSnapshot().status, 'blocked');
    assert.equal((await f.runtime.goalContinuationObserve()).known, false);
  }
  const f = fixture(); f.rpc.call = async () => { throw Object.assign(Error('Goals unavailable'), { nativeGoalsDisabled: true }); };
  assert.deepEqual(await f.runtime.goalContinuationObserve(), { known: false, nativeId: 'original-native', reason: 'native-goal-read-unavailable' });
});
test('transport, native identity, model, lifecycle, state, human control and observations changing during a read reject the old response', async () => {
  for (const change of [f => { f.runtime.host.rpc = {}; }, f => { f.record.nativeId = 'replacement'; },
    f => { f.runtime.observeSettings({ model: 'changed-model', effort: 'high' }); }, f => { f.runtime.lifecycleRevision++; },
    f => { f.runtime.emit('state', 'working'); }, f => { f.record.controlRevision++; }, f => { f.runtime.eventRevision++; },
    f => { f.runtime.turnId = 'later-native-turn'; },
    f => { f.runtime.terminalSwitch = 'switching-context'; }, f => { f.runtime.pendingTerminalContext = {}; },
    f => { f.runtime.transportDisconnected = true; }, f => { f.runtime.nativeObservationPending = true; }]) {
    const f = fixture(); f.rpc.call = async () => { change(f); return { goal: f.goal }; };
    assert.equal((await f.runtime.goalContinuationObserve()).known, false);
  }
});
test('paused, limited and pending user/native input facts stay visible and are never changed by observation', async () => {
  for (const status of ['paused', 'usageLimited', 'budgetLimited', 'complete']) {
    const f = fixture(); f.goal.status = status;
    const result = await f.runtime.goalContinuationObserve(); assert.equal(result.known, true); assert.equal(result.goal.status, status);
    assert.equal(result.usageLimited, status === 'usageLimited'); assert.equal(result.budgetLimited, status === 'budgetLimited');
  }
  const f = fixture(); f.runtime.pending = { tag: 'pending-input' }; f.runtime.nativeRequests.set('approval', {});
  f.runtime.nativeInputRequired = true; const result = await f.runtime.goalContinuationObserve();
  assert.equal(result.inputPending, true); assert.equal(result.approvalPending, true); assert.equal(result.waitingOnUser, true);
  assert.deepEqual(f.runtime.pending, { tag: 'pending-input' }); assert.equal(f.runtime.nativeRequests.size, 1);
});
test('exhausted native token and time budgets are reported without raising limits or clearing counters', async () => {
  for (const patch of [{ tokenBudget: 42 }, { timeBudgetSeconds: 3 }]) {
    const f = fixture(); Object.assign(f.goal, patch); const before = structuredClone(f.goal);
    const result = await f.runtime.goalContinuationObserve(); assert.equal(result.budgetLimited, true); assert.deepEqual(f.goal, before);
  }
});
