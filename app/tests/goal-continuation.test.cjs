const test = require('node:test');
const assert = require('node:assert/strict');
const { createState, registerWait, receiveEvent, recordResult } = require('../goal-continuation.cjs');

function fixture(enabled = true) {
  const authorization = { id: 'human-standing-authority', version: 1, status: 'granted',
    source: 'human', scopeId: 'board-original', capability: 'dependency-goal-continuation' };
  const snapshot = { known: true, nativeId: 'native-original', state: 'idle', controlRevision: 4,
    approvalPending: false, inputPending: false, waitingOnUser: false, usageLimited: false, budgetLimited: false,
    settings: { model: 'synthetic-native-model', effort: 'high' },
    goal: { threadId: 'native-original', id: 'goal-original', createdAt: 10, updatedAt: 20,
      status: 'blocked', objective: 'Finish the original synthetic task', tokenBudget: 1000,
      tokensUsed: 80, timeUsedSeconds: 2 } };
  const wait = { id: 'wait-original', scopeId: 'board-original', reason: 'agent-handoff', source: 'agent',
    taskId: 'original-task', triggers: [{ kind: 'dependency-completed', subjectId: 'dep-1' },
      { kind: 'task-assigned', subjectId: 'new-authorized-task' }] };
  const event = { id: 'ready-1', source: 'task-board', kind: 'dependency-completed', subjectId: 'dep-1',
    scopeId: 'board-original', confirmed: true };
  wait.blockedSnapshot = structuredClone(snapshot);
  const registration = registerWait(createState({ enabled }), { authorization, snapshot, wait });
  return { authorization, snapshot, wait, event, registration, state: registration.state };
}
function deliver(f, overrides = {}) { return receiveEvent(f.state, { authorization: f.authorization,
  snapshot: f.snapshot, waitId: f.wait.id, event: f.event, ...overrides }); }

test('the missing handoff path produces one original-goal intent without changing the native snapshot', () => {
  const f = fixture(), before = structuredClone(f.snapshot);
  assert.equal(f.registration.status, 'waiting');
  const result = deliver(f);
  assert.equal(result.status, 'intent');
  assert.equal(result.intent.kind, 'resume-original-goal');
  assert.equal(result.intent.nativeId, f.snapshot.nativeId);
  assert.equal(result.intent.expected.goal.id, 'goal-original');
  assert.equal(result.intent.expected.goal.createdAt, 10);
  assert.match(result.intent.expected.goal.objectiveHash, /^[a-f0-9]{64}$/);
  assert.equal(result.intent.expected.settings.model, 'synthetic-native-model');
  assert.equal(result.intent.expected.goal.tokenBudget, 1000);
  assert.equal(result.intent.expected.goal.tokensUsed, 80);
  assert.deepEqual(result.intent.authorization, { id: f.authorization.id, version: 1, scopeId: f.authorization.scopeId });
  assert.equal(result.intent.executionReady, false, 'An intent never claims the native interface can execute it safely');
  assert.ok(result.intent.requires.includes('atomic-conditional-native-resume'));
  assert.ok(result.intent.requires.includes('persist-attempt-and-space-receipt-before-write'));
  assert.deepEqual(f.snapshot, before);
  assert.equal(f.state.waits[f.wait.id].status, 'waiting', 'Reducer does not mutate its input');
  assert.ok(!JSON.stringify(result).includes(f.snapshot.goal.objective), 'Persist only the objective hash');
});

test('default is closed and cannot be enabled by a received event', () => {
  const f = fixture(false);
  assert.equal(createState().enabled, false);
  assert.equal(f.registration.reason, 'disabled');
  assert.equal(deliver(f).reason, 'disabled');
});

for (const change of [a => a.status = 'revoked', a => a.version++, a => a.id = 'replacement',
  a => a.scopeId = 'other-board', a => a.source = 'agent', a => a.capability = 'ordinary-message']) {
  test('authorization revocation or replacement invalidates the wait: ' + change.toString(), () => {
    const f = fixture(); change(f.authorization);
    assert.equal(deliver(f).status, 'denied');
    assert.equal(deliver(f).intent, undefined);
  });
}

for (const status of ['paused', 'complete', 'usageLimited', 'budgetLimited', 'stopped', 'unknown']) {
  test('native ' + status + ' is never resumed', () => {
    const f = fixture(); f.snapshot.goal.status = status;
    assert.equal(deliver(f).status, 'denied');
  });
}
for (const [key, value] of [['state', 'working'], ['state', 'approval'], ['approvalPending', true],
  ['inputPending', true], ['waitingOnUser', true], ['usageLimited', true], ['budgetLimited', true], ['known', false]]) {
  test('busy, approval, input or limit boundary refuses: ' + key + '=' + value, () => {
    const f = fixture(); f.snapshot[key] = value;
    assert.equal(deliver(f).status, 'denied');
  });
}

test('unknown and human blocking reasons cannot arm a continuation', () => {
  for (const change of [w => w.reason = 'unknown', w => w.reason = 'approval', w => w.source = 'human',
    w => w.reason = 'budget', w => w.triggers = []]) {
    const f = fixture(); change(f.wait);
    assert.equal(registerWait(createState({ enabled: true }), f).status, 'denied');
  }
});

for (const change of [s => s.nativeId = 'replacement-native', s => s.goal.threadId = 'other-thread',
  s => s.goal.id = 'replacement-goal', s => s.goal.createdAt++, s => s.goal.objective += ' changed',
  s => s.settings.model = 'replacement-model', s => s.settings.effort = 'low', s => s.goal.tokenBudget++,
  s => s.goal.tokensUsed++, s => s.goal.timeUsedSeconds++, s => s.controlRevision++]) {
  test('original identity, settings, budget and control are bound: ' + change.toString(), () => {
    const f = fixture(); change(f.snapshot);
    assert.equal(deliver(f).status, 'denied');
  });
}

test('only exact registered, confirmed, same-scope task/dependency events trigger', () => {
  for (const change of [e => e.id = '', e => e.subjectId = 'unrelated', e => e.scopeId = 'other-board',
    e => e.confirmed = false, e => e.kind = 'timer', e => e.source = 'mtime']) {
    const f = fixture(); change(f.event);
    assert.equal(deliver(f).status, 'denied');
  }
  const f = fixture(); f.event.kind = 'task-assigned'; f.event.subjectId = 'new-authorized-task';
  assert.equal(deliver(f).status, 'intent');
});

test('same event is consumed once across persistence and different waits', () => {
  const f = fixture(), first = deliver(f);
  f.state = JSON.parse(JSON.stringify(first.state));
  assert.equal(deliver(f).reason, 'event-already-consumed');
  const next = fixture(); next.wait.id = 'another-wait';
  const rearm = registerWait(f.state, next);
  assert.equal(rearm.status, 'denied', 'An outstanding attempt blocks re-registration of the same original goal');
});

test('unknown result and in-flight crash block new event IDs and re-arming', () => {
  for (const result of [null, { status: 'unconfirmed' }]) {
    const f = fixture(), first = deliver(f);
    let state = first.state;
    if (result) state = recordResult(state, { intentId: first.intent.id, result }).state;
    f.state = JSON.parse(JSON.stringify(state)); f.event.id = 'different-ready';
    assert.equal(deliver(f).reason, 'wait-already-attempted');
    const next = fixture(); next.wait.id = 'new-wait';
    assert.equal(registerWait(f.state, next).reason, 'goal-already-registered');
  }
});

test('confirmed outcome needs fresh active observation and cannot overwrite a prior outcome', () => {
  const f = fixture(), first = deliver(f);
  assert.equal(recordResult(first.state, { intentId: first.intent.id, result: { status: 'confirmed' } }).status, 'denied');
  const active = structuredClone(f.snapshot); active.goal.status = 'active'; active.goal.updatedAt++; active.goal.tokensUsed++;
  const finished = recordResult(first.state, { intentId: first.intent.id, result: { status: 'confirmed', snapshot: active } });
  assert.equal(finished.status, 'confirmed');
  assert.equal(recordResult(finished.state, { intentId: first.intent.id, result: { status: 'unconfirmed' } }).status, 'denied');
  f.state = finished.state; f.event.id = 'later'; assert.equal(deliver(f).reason, 'wait-already-attempted');
});

test('confirmation rejects another goal, model, budget, reset counters or non-active state', () => {
  for (const change of [s => s.goal.createdAt++, s => s.settings.model = 'other', s => s.goal.tokenBudget++,
    s => s.goal.tokensUsed = 0, s => s.goal.timeUsedSeconds = 0, s => s.goal.status = 'blocked']) {
    const f = fixture(), first = deliver(f), active = structuredClone(f.snapshot);
    active.goal.status = 'active'; active.goal.updatedAt++; change(active);
    assert.equal(recordResult(first.state, { intentId: first.intent.id, result: { status: 'confirmed', snapshot: active } }).status, 'denied');
  }
});

test('incomplete native facts and exhausted budget fail closed', () => {
  for (const change of [s => delete s.goal.createdAt, s => delete s.goal.updatedAt, s => delete s.goal.objective,
    s => delete s.goal.tokensUsed, s => delete s.goal.timeUsedSeconds, s => s.goal.tokenBudget = 80,
    s => delete s.settings.model, s => delete s.approvalPending, s => s.goal.tokensUsed = NaN]) {
    const f = fixture(); change(f.snapshot);
    assert.equal(registerWait(createState({ enabled: true }), f).status, 'denied');
  }
});

test('one dependency completion may unblock two distinct original goals without replaying either', () => {
  const first = fixture(), second = fixture();
  second.wait.id = 'wait-second'; second.snapshot.nativeId = second.snapshot.goal.threadId = 'native-second';
  second.snapshot.goal.id = 'goal-second'; second.wait.blockedSnapshot = structuredClone(second.snapshot);
  const registered = registerWait(first.state, second);
  first.state = registered.state;
  const a = deliver(first); second.state = a.state;
  const b = deliver(second);
  assert.equal(b.status, 'intent', 'Deduplication is per original goal, not a broadcast-wide suppression');
  second.state = b.state; assert.equal(deliver(second).reason, 'event-already-consumed');
});

test('active goal confirmation accepts its natural next working round without another resume', () => {
  const f = fixture(), first = deliver(f), active = structuredClone(f.snapshot);
  active.goal.status = 'active'; active.goal.updatedAt++; active.state = 'working'; active.goal.tokensUsed++;
  const result = recordResult(first.state, { intentId: first.intent.id, result: { status: 'confirmed', snapshot: active } });
  assert.equal(result.status, 'confirmed');
  assert.equal(result.intent, undefined, 'Recording a result never emits another native action');
});

test('persisted authorization invalidation stays terminal when an old grant reappears', () => {
  const f = fixture(); const original = structuredClone(f.authorization); f.authorization.status = 'revoked';
  f.state = deliver(f).state; f.authorization = original;
  assert.equal(deliver(f).reason, 'wait-already-attempted');
});

test('only a strictly newer blocked cycle after confirmed activation may register again', () => {
  const f = fixture(), first = deliver(f), active = structuredClone(f.snapshot);
  active.goal.status = 'active'; active.goal.updatedAt++;
  const finished = recordResult(first.state, { intentId: first.intent.id, result: { status: 'confirmed', snapshot: active } });
  f.wait.id = 'wait-next-cycle'; f.snapshot.goal.updatedAt = active.goal.updatedAt;
  assert.equal(registerWait(finished.state, f).status, 'denied');
  f.snapshot.goal.updatedAt++; f.wait.blockedSnapshot = structuredClone(f.snapshot);
  const next = registerWait(finished.state, f); assert.equal(next.status, 'waiting');
  f.state = next.state; assert.equal(deliver(f).reason, 'event-already-consumed');
  f.event.id = 'next-ready'; assert.equal(deliver(f).status, 'intent');
});

test('malformed or display-only inputs fail closed rather than reconstructing native identity', () => {
  const f = fixture();
  for (const state of [null, {}, { version: 2, enabled: true, waits: {}, events: {} }]) {
    assert.equal(receiveEvent(state, f).reason, 'invalid-state');
  }
  assert.equal(registerWait(createState({ enabled: true }), { ...f,
    snapshot: { nativeId: f.snapshot.nativeId, status: 'blocked', observedAt: 1 } }).status, 'denied');
  assert.equal(receiveEvent(f.state).status, 'denied');
  assert.equal(recordResult(f.state).status, 'denied');
  const corrupt = createState({ enabled: true });
  corrupt.waits.broken = { status: 'attempting', intent: { id: 'bad' } };
  assert.equal(recordResult(corrupt, { intentId: 'bad', result: { status: 'confirmed', snapshot: f.snapshot } }).status, 'denied');
});

test('a stale handoff cause cannot be attached to a replacement goal at registration', () => {
  const f = fixture();
  const staleWait = structuredClone(f.wait);
  f.snapshot.goal.id = 'new-goal-before-registration'; f.snapshot.goal.createdAt++; f.snapshot.goal.updatedAt++;
  assert.equal(registerWait(createState({ enabled: true }), { ...f, wait: staleWait }).status, 'denied');
});

test('native goals without a separate ID retain createdAt/hash identity and an unlimited budget', () => {
  const f = fixture(); delete f.snapshot.goal.id; f.snapshot.goal.tokenBudget = null;
  f.wait.blockedSnapshot = structuredClone(f.snapshot);
  f.state = registerWait(createState({ enabled: true }), f).state;
  const result = deliver(f); assert.equal(result.status, 'intent');
  assert.equal(result.intent.expected.goal.id, null);
  assert.equal(result.intent.expected.goal.createdAt, 10);
  assert.equal(result.intent.expected.goal.tokenBudget, null);
});

test('time budgets are bound and exhausted time never authorizes an intent', () => {
  const f = fixture(); f.snapshot.goal.timeBudgetSeconds = 20; f.wait.blockedSnapshot = structuredClone(f.snapshot);
  f.state = registerWait(createState({ enabled: true }), f).state;
  assert.equal(deliver(f).intent.expected.goal.timeBudgetSeconds, 20);
  f.snapshot.goal.timeBudgetSeconds = 21; assert.equal(deliver(f).status, 'denied');
  f.snapshot.goal.timeBudgetSeconds = 2; f.wait.blockedSnapshot = structuredClone(f.snapshot);
  assert.equal(registerWait(createState({ enabled: true }), f).status, 'denied');
});
