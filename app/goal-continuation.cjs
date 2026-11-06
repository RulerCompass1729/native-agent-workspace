'use strict';
const { createHash } = require('node:crypto');

// Policy only: no timers, messages, native calls or goal setters. The caller owns
// trusted native/task/authority observations and must durably store returned state.
// A display-only nativeGoalSnapshot is deliberately insufficient input.
const CAPABILITY = 'dependency-goal-continuation';
const REQUIREMENTS = Object.freeze([
  'atomic-conditional-native-resume',
  'fresh-authority-and-human-control-check-at-write',
  'persist-attempt-and-space-receipt-before-write',
  'fresh-native-read-and-space-result-after-write'
]);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const count = value => Number.isFinite(value) && value >= 0;
const own = (object, key) => object && Object.hasOwn(object, key);
const copy = value => structuredClone(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const version = value => text(value) || Number.isSafeInteger(value) && value > 0;
const validState = state => state?.version === 1 && typeof state.enabled === 'boolean' &&
  state.waits && typeof state.waits === 'object' && !Array.isArray(state.waits) &&
  state.events && typeof state.events === 'object' && !Array.isArray(state.events);
const denial = (state, reason) => ({ state, status: 'denied', reason });

function createState({ enabled = false } = {}) {
  return { version: 1, enabled: enabled === true, waits: {}, events: {} };
}
function authority(value) {
  if (!value || !text(value.id) || !version(value.version) || value.status !== 'granted' ||
      value.source !== 'human' || !text(value.scopeId) || value.capability !== CAPABILITY) return null;
  return { id: value.id, version: value.version, scopeId: value.scopeId };
}
function observation(snapshot, status = 'blocked') {
  const goal = snapshot?.goal, settings = snapshot?.settings;
  if (snapshot?.known !== true || !text(snapshot.nativeId) ||
      !(status === 'active' ? ['idle', 'working'].includes(snapshot.state) : snapshot.state === 'idle') ||
      !Number.isSafeInteger(snapshot.controlRevision) || snapshot.controlRevision < 0 ||
      ['approvalPending', 'inputPending', 'waitingOnUser', 'usageLimited', 'budgetLimited'].some(key => snapshot[key] !== false) ||
      !goal || goal.threadId !== snapshot.nativeId || goal.status !== status ||
      !count(goal.createdAt) || !count(goal.updatedAt) || goal.updatedAt < goal.createdAt ||
      typeof goal.objective !== 'string' || !goal.objective.trim() ||
      (own(goal, 'id') && goal.id !== null && !text(goal.id)) || !settings || !text(settings.model) ||
      (own(settings, 'effort') && settings.effort !== null && !text(settings.effort)) ||
      !own(goal, 'tokenBudget') || !(goal.tokenBudget === null || Number.isSafeInteger(goal.tokenBudget) && goal.tokenBudget > 0) ||
      !Number.isSafeInteger(goal.tokensUsed) || goal.tokensUsed < 0 || !count(goal.timeUsedSeconds) ||
      (goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget) ||
      (own(goal, 'timeBudgetSeconds') && goal.timeBudgetSeconds !== null &&
        (!Number.isFinite(goal.timeBudgetSeconds) || goal.timeBudgetSeconds <= goal.timeUsedSeconds))) return null;
  return { nativeId: snapshot.nativeId, controlRevision: snapshot.controlRevision,
    settings: { model: settings.model, effort: settings.effort ?? null },
    goal: { id: goal.id ?? null, createdAt: goal.createdAt, updatedAt: goal.updatedAt,
      objectiveHash: digest(goal.objective), status, tokenBudget: goal.tokenBudget,
      tokensUsed: goal.tokensUsed, timeBudgetSeconds: goal.timeBudgetSeconds ?? null,
      timeUsedSeconds: goal.timeUsedSeconds } };
}
function goalKey(expected) {
  return digest([expected.nativeId, expected.goal.id, expected.goal.createdAt, expected.goal.objectiveHash]);
}
function waitProof(wait) {
  if (!wait || !text(wait.id) || !text(wait.scopeId) || !text(wait.taskId) ||
      wait.reason !== 'agent-handoff' || wait.source !== 'agent' || !Array.isArray(wait.triggers) ||
      !wait.triggers.length || wait.triggers.some(trigger => !trigger ||
        !['dependency-completed', 'task-assigned'].includes(trigger.kind) || !text(trigger.subjectId))) return null;
  return { id: wait.id, scopeId: wait.scopeId, taskId: wait.taskId, reason: wait.reason,
    source: wait.source, triggers: wait.triggers.map(({ kind, subjectId }) => ({ kind, subjectId })) };
}
function updateWait(state, id, patch) {
  return { ...state, waits: { ...state.waits, [id]: { ...state.waits[id], ...patch } } };
}

// Register only a machine-proven agent handoff for this exact blocked goal.
// wait.blockedSnapshot is captured with the original agent-wait evidence;
// snapshot is the fresh native read. Triggers name exact authorized tasks/
// dependencies; no wildcard future work. Raw goal text is hashed, never stored.
function registerWait(state, { authorization, snapshot, wait } = {}) {
  if (!validState(state)) return denial(state, 'invalid-state');
  if (!state.enabled) return denial(state, 'disabled');
  const auth = authority(authorization), proof = waitProof(wait), expected = observation(snapshot);
  if (!auth || !proof || auth.scopeId !== proof.scopeId) return denial(state, 'authority-or-wait-unproven');
  if (!expected) return denial(state, 'native-state-disallows');
  // The recorded agent-wait cause must itself belong to this goal revision.
  // Never attach an old task-board wait reason to whichever goal is current.
  const blocked = observation(wait.blockedSnapshot);
  if (!blocked || !same(blocked, expected)) return denial(state, 'handoff-not-original-goal');
  if (own(state.waits, proof.id)) return denial(state, 'wait-already-registered');
  const key = goalKey(expected);
  for (const previous of Object.values(state.waits)) {
    if (previous?.goalKey !== key) continue;
    // Unknown/rejected/in-flight results never re-arm. A confirmed cycle needs
    // a strictly newer native revision before another agent handoff can register.
    if (previous.status !== 'confirmed' || !(expected.goal.updatedAt > previous.confirmedUpdatedAt)) {
      return denial(state, 'goal-already-registered');
    }
  }
  const record = { ...proof, authorization: auth, expected, goalKey: key, status: 'waiting' };
  return { state: { ...state, waits: { ...state.waits, [proof.id]: record } }, status: 'waiting' };
}

// Consumes a trigger before exposing the intent. Persist this state and the
// scoped audit receipt before a conditional native operation. On restart an
// attempting row is unresolved, never a queue to replay. No execution is offered
// by this module; REQUIREMENTS are obligations, not capabilities it has proved.
function receiveEvent(state, { authorization, snapshot, waitId, event } = {}) {
  if (!validState(state)) return denial(state, 'invalid-state');
  if (!state.enabled) return denial(state, 'disabled');
  const record = own(state.waits, waitId) && state.waits[waitId];
  if (!record) return denial(state, 'wait-not-found');
  if (!event || !text(event.id) || event.source !== 'task-board' || event.confirmed !== true ||
      event.scopeId !== record.scopeId || !Array.isArray(record.triggers) ||
      !record.triggers.some(trigger => trigger.kind === event.kind && trigger.subjectId === event.subjectId)) {
    return denial(state, 'event-not-authorized-trigger');
  }
  const eventKey = digest([record.goalKey, event.source, event.scopeId, event.id]);
  if (own(state.events, eventKey)) return denial(state, 'event-already-consumed');
  if (record.status !== 'waiting') return denial(state, 'wait-already-attempted');
  const auth = authority(authorization);
  if (!auth || !same(auth, record.authorization)) {
    return denial(updateWait(state, waitId, { status: 'invalidated', reason: 'authority-changed' }), 'authority-changed');
  }
  const expected = observation(snapshot);
  if (!expected) {
    // Busy/approval/unknown readings do not imply a pause or permit a write.
    // Known native goal/control changes permanently invalidate this wait.
    const boundary = snapshot?.known === true && (snapshot.controlRevision !== record.expected?.controlRevision ||
      snapshot.nativeId !== record.expected?.nativeId || snapshot.goal?.status !== 'blocked');
    return denial(boundary ? updateWait(state, waitId, { status: 'invalidated', reason: 'native-boundary' }) : state,
      'native-state-disallows');
  }
  if (!same(expected, record.expected)) {
    return denial(updateWait(state, waitId, { status: 'invalidated', reason: 'original-goal-changed' }), 'original-goal-changed');
  }
  const trigger = { id: event.id, source: event.source, scopeId: event.scopeId,
    kind: event.kind, subjectId: event.subjectId };
  const intent = { id: digest([record.id, auth, expected, trigger]), kind: 'resume-original-goal',
    nativeId: expected.nativeId, waitId, taskId: record.taskId, authorization: copy(auth),
    expected: copy(expected), trigger, executionReady: false, requires: [...REQUIREMENTS] };
  const next = updateWait(state, waitId, { status: 'attempting', intent: copy(intent) });
  next.events = { ...state.events, [eventKey]: intent.id };
  return { state: next, status: 'intent', intent };
}

// Bookkeeping only. A positive result requires a newer authoritative native goal
// revision, same goal/settings/budget/control, and nondecreasing usage counters.
function recordResult(state, { intentId, result } = {}) {
  if (!validState(state)) return denial(state, 'invalid-state');
  const record = Object.values(state.waits).find(value => value?.intent?.id === intentId);
  if (!record || !record.expected?.goal || !text(record.id) || record.status !== 'attempting' ||
      !['confirmed', 'unconfirmed', 'rejected'].includes(result?.status)) {
    return denial(state, 'result-not-current-attempt');
  }
  if (result.status === 'confirmed') {
    const active = observation(result.snapshot, 'active'), expected = record.expected;
    if (!active || active.goal.updatedAt <= expected.goal.updatedAt ||
        active.goal.tokensUsed < expected.goal.tokensUsed || active.goal.timeUsedSeconds < expected.goal.timeUsedSeconds) {
      return denial(state, 'result-not-confirmed');
    }
    const comparable = copy(active);
    Object.assign(comparable.goal, { status: expected.goal.status, updatedAt: expected.goal.updatedAt,
      tokensUsed: expected.goal.tokensUsed, timeUsedSeconds: expected.goal.timeUsedSeconds });
    if (!same(comparable, expected)) return denial(state, 'result-not-original-goal');
    return { state: updateWait(state, record.id, { status: 'confirmed', confirmedUpdatedAt: active.goal.updatedAt }), status: 'confirmed' };
  }
  return { state: updateWait(state, record.id, { status: result.status }), status: result.status };
}
module.exports = { CAPABILITY, REQUIREMENTS, createState, registerWait, receiveEvent, recordResult };
