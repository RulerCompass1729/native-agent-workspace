'use strict';
// Private record-only state. This module never submits a turn, operates a queue,
// grants authority, sends a notification, or reads provider configuration.
// The desktop supplies an already authenticated selection/person context.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { validateEvent } = require('./butler-policy.cjs');
const { projectReview } = require('./butler-review-projection.cjs');
const { agreementSummary } = require('./butler-review-policy.js');

const EVENT_KINDS = ['request', 'queue-empty', 'ready', 'decision', 'failure', 'blocked', 'recovery'];
const ACTION_KINDS = ['queue', 'open', 'archive', 'question', 'report'];
const PAYLOAD_LIMITS = { text: 12000, title: 400, spaceId: 200, spaceName: 200, memberName: 200,
  memberId: 200, itemId: 200, outcome: 200, reason: 2000, decisionKind: 200, questionKey: 600, supersedes: 200 };
const MAX_FILE_BYTES = 32 * 1024 * 1024, MAX_RECORD_BYTES = 2 * 1024 * 1024, MAX_BATCH = 100;
const FILE_NAME = 'butler-ledger.jsonl';
const QUESTION_SEND_CHANNELS = ['notification', 'butler-ask'];
const QUESTION_METRIC_GAPS = ['source-unavailable', 'write-failed', 'delivery-unconfirmed', 'unattributed',
  'unobserved-send', 'epoch-unavailable', 'unexpected-display'];
const REVIEW_PROVENANCE = Object.freeze({ kind: 'audit', recordPeriod: 'off', activation: 'off' });

function invalid(message, code = 'BUTLER_LEDGER_INVALID') {
  return Object.assign(new Error(message), { code });
}
function requireValue(ok, message, code) { if (!ok) throw invalid(message, code); }
function object(value, allowed, required = []) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'Invalid ledger object');
  const keys = Object.keys(value);
  requireValue(keys.every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key)), 'Invalid ledger fields');
}
function string(value, limit = 600) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= limit &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), 'Invalid ledger text');
  return value;
}
function idString(value) {
  string(value, 200);
  requireValue(!/[\s\u0000-\u001f\u007f]/u.test(value), 'Invalid ledger identity');
  return value;
}
function reference(value) { return string(value, 600); }
function safeInteger(value) { return Number.isSafeInteger(value) && value >= 0; }
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function stableId(kind, value) { return kind + ':' + createHash('sha256').update(canonical(value)).digest('hex'); }
function clone(value) { return structuredClone(value); }
function normalizeSelection(value) {
  object(value, ['selectionRevision', 'identity', 'runnerRef'], ['selectionRevision', 'identity', 'runnerRef']);
  requireValue(safeInteger(value.selectionRevision), 'Invalid selection revision');
  object(value.identity, ['sessionId', 'nativeId'], ['sessionId', 'nativeId']);
  return { selectionRevision: value.selectionRevision,
    identity: { sessionId: idString(value.identity.sessionId), nativeId: idString(value.identity.nativeId) }, runnerRef: idString(value.runnerRef) };
}
function sameSelection(a, b) { return canonical(a) === canonical(b); }
function normalizeEvent(value) {
  validateEvent(value);
  object(value, ['eventId', 'kind', 'sourceRef', 'payload'], ['eventId', 'kind', 'sourceRef', 'payload']);
  requireValue(EVENT_KINDS.includes(value.kind), 'Invalid butler event kind');
  object(value.payload, Object.keys(PAYLOAD_LIMITS));
  const payload = {};
  for (const [key, field] of Object.entries(value.payload)) payload[key] = string(field, PAYLOAD_LIMITS[key]);
  return { eventId: idString(value.eventId), kind: value.kind, sourceRef: reference(value.sourceRef), payload };
}
function normalizeAction(value) {
  object(value, ['kind', 'sourceRef', 'text', 'spaceId', 'decisionKind', 'evidenceRevision', 'supersedes'], ['kind', 'sourceRef', 'text']);
  requireValue(ACTION_KINDS.includes(value.kind), 'Invalid butler action kind');
  const result = { kind: value.kind, sourceRef: reference(value.sourceRef), text: string(value.text, 12000) };
  if (value.spaceId !== undefined) result.spaceId = idString(value.spaceId);
  if (value.decisionKind !== undefined) result.decisionKind = idString(value.decisionKind);
  if (value.evidenceRevision !== undefined) result.evidenceRevision = reference(value.evidenceRevision);
  if (value.supersedes !== undefined) result.supersedes = idString(value.supersedes);
  requireValue(value.kind === 'question' || value.supersedes === undefined, 'Only questions can supersede a question');
  if (value.kind === 'question') requireValue(result.decisionKind, 'A question needs a stable decision kind');
  return result;
}
function normalizeUsage(value) {
  object(value, ['inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens', 'costUsd', 'costMicros', 'source', 'reportedAt', 'estimated', 'tokensComplete']);
  const result = {};
  for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens']) if (value[key] !== undefined) {
    requireValue(value[key] === null || safeInteger(value[key]), 'Invalid usage token count'); result[key] = value[key];
  }
  if (value.costUsd !== undefined) {
    requireValue(value.costUsd === null || Number.isFinite(value.costUsd) && value.costUsd >= 0, 'Invalid usage cost');
    result.costUsd = value.costUsd;
  }
  if (value.costMicros !== undefined) {
    requireValue(value.costMicros === null || safeInteger(value.costMicros), 'Invalid usage micro-dollar amount'); result.costMicros = value.costMicros;
  }
  if (value.source !== undefined) result.source = string(value.source, 200);
  if (value.reportedAt !== undefined) { requireValue(Number.isFinite(value.reportedAt) && value.reportedAt >= 0, 'Invalid usage date'); result.reportedAt = value.reportedAt; }
  if (value.estimated !== undefined) { requireValue(typeof value.estimated === 'boolean', 'Invalid usage estimate flag'); result.estimated = value.estimated; }
  if (value.tokensComplete !== undefined) {
    requireValue(typeof value.tokensComplete === 'boolean', 'Invalid token completeness');
    if (value.tokensComplete) requireValue(['inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens'].every(k => safeInteger(value[k])), 'Complete token counts are required');
    result.tokensComplete = value.tokensComplete;
  }
  return result;
}
function safeCandidateText(value, limit = 12000) {
  string(value, limit);
  // Reuse the admission rule before retaining a rejected proposal in audit.
  // A suspension must not become an alternate route for secret-shaped text.
  validateEvent({ eventId: 'candidate-audit', kind: 'blocked', sourceRef: 'candidate:audit', payload: { text: value } });
  return value;
}
function normalizeSuspension(value) {
  object(value, ['stage', 'index', 'reason', 'kind', 'sourceRef', 'text', 'redacted'], ['stage', 'index', 'reason']);
  requireValue(value.stage === 'policy' && safeInteger(value.index) && value.index < MAX_BATCH &&
    typeof value.reason === 'string' && /^[A-Z][A-Z0-9_:-]{0,199}$/u.test(value.reason), 'Invalid candidate suspension');
  const result = { stage: value.stage, index: value.index, reason: value.reason };
  if (value.kind !== undefined) { requireValue(ACTION_KINDS.includes(value.kind), 'Invalid suspended candidate kind'); result.kind = value.kind; }
  if (value.sourceRef !== undefined) result.sourceRef = safeCandidateText(value.sourceRef, 600);
  if (value.text !== undefined) result.text = safeCandidateText(value.text);
  if (value.redacted !== undefined) { requireValue(value.redacted === true, 'Invalid candidate redaction'); result.redacted = true; }
  return result;
}
function normalizeResult(value) {
  object(value, ['actions', 'suspended', 'usage'], ['actions']);
  requireValue(Array.isArray(value.actions) && value.actions.length <= MAX_BATCH, 'Invalid butler action list');
  let suspended;
  if (value.suspended !== undefined) {
    requireValue(Array.isArray(value.suspended) && value.suspended.length <= MAX_BATCH, 'Invalid suspended candidate list');
    suspended = value.suspended.map(normalizeSuspension);
    requireValue(new Set(suspended.map(candidate => candidate.index)).size === suspended.length &&
      value.actions.length + suspended.length <= MAX_BATCH, 'Invalid suspended candidate positions');
  }
  return { actions: value.actions.map(normalizeAction), ...(suspended === undefined ? {} : { suspended }),
    ...(value.usage === undefined ? {} : { usage: normalizeUsage(value.usage) }) };
}
function initialState() {
  return { sequence: 0, eventSequence: 0, origin: null, events: [], eventIndex: new Map(), processed: new Set(),
    batches: new Map(), activeBatchId: null, actions: new Map(), questions: new Map(), questionHead: new Map(),
    deliveries: new Map(), reports: new Map(), reported: new Set(), attempts: new Map(), suspended: new Map(), quarantined: new Map(), quarantinedEvents: new Set(), sourceStates: new Map(),
    questionMetricEpochs: new Map(), questionMetricGaps: [], questionSends: new Map(), reviews: new Map(), hasStoredReviewData: false };
}
function pending(state) { return state.events.filter(event => !state.processed.has(event.eventId) && !state.quarantinedEvents.has(event.eventId)); }
function cursor(state, covered) {
  // This is only the contiguous confirmed prefix. Rule-recorded events need
  // not be reported, so a later report can be sent while this cursor stays put.
  let value = 0;
  for (const event of state.events) { if (!covered.has(event.eventId)) break; value = event.sequence; }
  return value;
}
function evidenceEvents(state, ref) {
  const result = state.events.filter(event => event.eventId === ref || event.sourceRef === ref).map(event => event.eventId);
  requireValue(result.length > 0, 'Evidence is not an ingested source', 'BUTLER_UNKNOWN_EVIDENCE');
  return result;
}
function questionInput(value) {
  object(value, ['sourceRef', 'decisionKind', 'evidenceRevision', 'text', 'supersedes'], ['sourceRef', 'decisionKind', 'text']);
  const normalized = normalizeAction({ kind: 'question', ...value });
  const { kind: _kind, ...question } = normalized;
  return question;
}
function decisionContext(state, input) {
  const candidates = state.events.filter(event => event.eventId === input.sourceRef || event.sourceRef === input.sourceRef);
  requireValue(candidates.length, 'Question source was not ingested', 'BUTLER_UNKNOWN_EVIDENCE');
  // The host must explicitly grant a stable decision vocabulary. The model
  // cannot turn different wording or another event reference into another issue.
  const contexts = candidates.filter(event => event.payload.questionKey && event.payload.decisionKind === input.decisionKind);
  requireValue(contexts.length, 'Question source has no matching host decision metadata', 'BUTLER_QUESTION_SOURCE');
  const first = contexts[0].payload;
  requireValue(contexts.every(event => event.payload.questionKey === first.questionKey),
    'Question source is ambiguous within its host decision type', 'BUTLER_QUESTION_SOURCE');
  return { decisionSource: first.questionKey, decisionKind: first.decisionKind, events: contexts };
}
function planQuestion(state, input, time) {
  const context = decisionContext(state, input);
  const baseKey = stableId('question-source', [context.decisionSource, context.decisionKind]);
  const existing = state.questions.get(state.questionHead.get(baseKey));
  if (existing?.status === 'open' || existing && !input.supersedes) return { question: existing, duplicate: true };
  const evidence = input.evidenceRevision === undefined ? context.events.at(-1) : state.eventIndex.get(input.evidenceRevision);
  requireValue(evidence, 'Question evidence must be an exact ingested event id', 'BUTLER_UNKNOWN_EVIDENCE');
  requireValue(evidence.payload.questionKey === context.decisionSource && evidence.payload.decisionKind === context.decisionKind,
    'Question evidence belongs to another decision', 'BUTLER_QUESTION_EVIDENCE');
  if (existing) {
    requireValue(input.supersedes === existing.questionId, 'Invalid question supersedes reference', 'BUTLER_QUESTION_EVIDENCE');
    requireValue(safeInteger(existing.resolvedSequence) && evidence.sequence > existing.resolvedSequence &&
      evidence.payload.outcome === 'facts-changed' && evidence.payload.supersedes === existing.questionId,
      'A new question needs same-decision facts ingested after the answer', 'BUTLER_QUESTION_EVIDENCE');
  } else requireValue(input.supersedes === undefined, 'Unknown superseded question', 'BUTLER_QUESTION_EVIDENCE');
  const questionKey = stableId('question-key', [context.decisionSource, context.decisionKind, evidence.eventId]);
  const questionId = stableId('question', questionKey);
  requireValue(!state.questions.has(questionId), 'Question identity conflict', 'BUTLER_QUESTION_EVIDENCE');
  const question = { questionId, questionKey, decisionSource: context.decisionSource, sourceRef: existing?.sourceRef || input.sourceRef, decisionKind: context.decisionKind,
    evidenceRevision: evidence.eventId, evidenceEventIds: [evidence.eventId], text: input.text, status: 'open', createdAt: time, physicalSeq: state.sequence + 1,
    ...(existing ? { supersedes: existing.questionId } : {}) };
  state.questions.set(questionId, question); state.questionHead.set(baseKey, questionId);
  return { question, duplicate: false };
}
function attemptKey(batchId, attempt) { return stableId('attempt', [batchId, attempt]); }
function mergeUsage(previous, value) {
  if (value === null) {
    requireValue(previous === null, 'Known attempt usage cannot become unknown', 'BUTLER_USAGE_CONFLICT');
    return null;
  }
  const incoming = normalizeUsage(value), result = { ...(previous || {}) };
  for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens', 'costUsd', 'costMicros']) {
    if (!Object.hasOwn(incoming, key)) continue;
    if (result[key] !== undefined && result[key] !== null)
      requireValue(previous?.tokensComplete === false && ['inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens'].includes(key)
        ? safeInteger(incoming[key]) && incoming[key] >= result[key] : incoming[key] === result[key], 'Known attempt usage cannot be replaced', 'BUTLER_USAGE_CONFLICT');
    result[key] = incoming[key];
  }
  if (Object.hasOwn(incoming, 'tokensComplete')) {
    requireValue(!previous || previous.tokensComplete === false || incoming.tokensComplete !== false, 'Complete tokens cannot become incomplete', 'BUTLER_USAGE_CONFLICT');
    result.tokensComplete = incoming.tokensComplete;
  }
  for (const key of ['source', 'reportedAt', 'estimated']) if (Object.hasOwn(incoming, key)) result[key] = incoming[key];
  return result;
}
function activeBatch(state, id) {
  const batch = state.batches.get(id);
  requireValue(batch && state.activeBatchId === id, 'No matching active batch', 'BUTLER_BATCH_STATE');
  return batch;
}
function reserve(state, kind, targetId, time) {
  const deliveryId = stableId('delivery', [kind, targetId]);
  if (state.deliveries.has(deliveryId)) return state.deliveries.get(deliveryId);
  const delivery = { deliveryId, kind, targetId, status: 'reserved', reservedAt: time, physicalSeq: state.sequence + 1, acknowledgements: [] };
  state.deliveries.set(deliveryId, delivery);
  return delivery;
}
function questionSendInput(value, includesEpoch = false) {
  object(value, ['attemptId', 'questionId', 'deliveryId', 'sourceEventId', 'channel', ...(includesEpoch ? ['epochId'] : [])], ['attemptId', 'channel']);
  requireValue(QUESTION_SEND_CHANNELS.includes(value.channel), 'Unsupported question send channel', 'BUTLER_QUESTION_SEND_STATE');
  const result = { attemptId: idString(value.attemptId), channel: value.channel };
  for (const field of ['questionId', 'deliveryId', 'sourceEventId']) result[field] = value[field] == null ? null : idString(value[field]);
  return result;
}
function metricIntervals(state, ownedEpoch, ownedGap) {
  return [...state.questionMetricEpochs.values()].map(epoch => {
    const gap = state.questionMetricGaps.some(item => item.epochId === epoch.epochId);
    let through = epoch.checkpoints.at(-1)?.throughSequence || 0;
    if (!gap && epoch.status === 'closed') through = epoch.closedPhysicalSeq;
    else if (!gap && epoch.epochId === ownedEpoch && !ownedGap) through = state.sequence;
    return [epoch.physicalSeq, through];
  }).filter(([from, through]) => through >= from).sort((a, b) => a[0] - b[0]);
}
function coveredWindow(intervals, after, through) {
  if (after === through) return intervals.some(([start, end]) => start <= through && end >= through);
  let next = after + 1;
  for (const [start, end] of intervals) {
    if (start > next) return false;
    if (end >= next) next = end + 1;
    if (next > through) return true;
  }
  return false;
}
function sendAt(send, through) {
  const acknowledgements = send.acknowledgements.filter(ack => ack.physicalSeq <= through);
  return { ...send, status: acknowledgements.at(-1)?.status || 'intent',
    shown: acknowledgements.find(ack => ack.status === 'shown') };
}
function questionSource(event, question, state) {
  const evidence = question && state.eventIndex.get(question.evidenceRevision);
  if (!(event && evidence && event.sequence >= evidence.sequence && event.payload.questionKey === question.decisionSource &&
    event.payload.decisionKind === question.decisionKind)) return false;
  // A resolved question's version ends at its first valid later facts change.
  // This boundary already exists before a replacement question is reserved.
  // Merely receiving another source while the same question is open does not
  // create a version or prevent attribution to that canonical question.
  return !safeInteger(question.resolvedSequence) || !state.events.some(next => next.sequence > question.resolvedSequence &&
    next.sequence <= event.sequence && next.payload.questionKey === question.decisionSource &&
    next.payload.decisionKind === question.decisionKind && next.payload.outcome === 'facts-changed' && next.payload.supersedes === question.questionId);
}
function questionMetrics(state, { afterSequence = 0, throughSequence = state.sequence } = {}, { ownedEpoch, ownedGap, failed }) {
  requireValue(safeInteger(afterSequence) && safeInteger(throughSequence) && afterSequence <= throughSequence && throughSequence <= state.sequence,
    'Invalid question metric window', 'BUTLER_QUESTION_METRIC_WINDOW');
  const inWindow = seq => seq > afterSequence && seq <= throughSequence;
  const intervals = metricIntervals(state, failed ? null : ownedEpoch, ownedGap);
  const sends = [...state.questionSends.values()].filter(send => send.physicalSeq <= throughSequence).map(send => sendAt(send, throughSequence));
  const shown = sends.filter(send => send.shown).sort((a, b) => a.shown.physicalSeq - b.shown.physicalSeq);
  const currentShown = shown.filter(send => inWindow(send.shown.physicalSeq)), seen = new Set();
  let knownRepeatedSends = 0;
  for (const send of shown) if (send.attributed) {
    if (seen.has(send.questionId) && inWindow(send.shown.physicalSeq)) knownRepeatedSends++;
    seen.add(send.questionId);
  }
  const currentQuestions = new Set(currentShown.filter(send => send.attributed).map(send => send.questionId));
  const relevantSends = sends.filter(send => inWindow(send.physicalSeq) || send.shown && inWindow(send.shown.physicalSeq) ||
    ['intent', 'unknown'].includes(send.status));
  const unknownAttempts = relevantSends.filter(send => ['intent', 'unknown'].includes(send.status)).length;
  const unattributedAttempts = relevantSends.filter(send => !send.attributed).length;
  const observedSource = event => sends.some(send => send.attributed && send.sourceEventId === event.eventId);
  const observedDelivery = delivery => sends.some(send => send.attributed && send.deliveryId === delivery.deliveryId);
  const decisions = state.events.filter(event => event.kind === 'decision' && event.physicalSeq <= throughSequence);
  const deliveries = [...state.deliveries.values()].filter(delivery => delivery.kind === 'question' && delivery.physicalSeq <= throughSequence);
  const unobservedDecisionSources = decisions.filter(event => inWindow(event.physicalSeq) && !observedSource(event)).length;
  const unobservedLogicalDeliveries = deliveries.filter(delivery => (inWindow(delivery.physicalSeq) ||
    delivery.acknowledgements.some(ack => inWindow(ack.physicalSeq))) && !observedDelivery(delivery)).length;
  const uncertainBaseline = new Set();
  for (const questionId of currentQuestions) {
    const question = state.questions.get(questionId);
    // Old unmeasured decisions do not poison unrelated future questions. They
    // matter when this exact canonical question is actually shown again.
    if (decisions.some(event => event.physicalSeq <= afterSequence && questionSource(event, question, state) && !sends.some(send => send.attributed &&
        send.sourceEventId === event.eventId && send.physicalSeq <= afterSequence))) uncertainBaseline.add(questionId);
    if (deliveries.some(delivery => delivery.targetId === questionId && delivery.physicalSeq <= afterSequence &&
      (!intervals.some(([start, end]) => start <= delivery.physicalSeq && end >= delivery.physicalSeq) ||
        !sends.some(send => send.attributed && send.deliveryId === delivery.deliveryId && send.physicalSeq <= afterSequence)))) uncertainBaseline.add(questionId);
    if (sends.some(send => send.questionId === questionId && send.physicalSeq <= afterSequence && ['intent', 'unknown'].includes(send.status))) uncertainBaseline.add(questionId);
    if (sends.some(send => !send.attributed && send.physicalSeq <= afterSequence &&
      (send.questionId === questionId || send.sourceEventId && (question.evidenceEventIds.includes(send.sourceEventId) ||
        questionSource(state.eventIndex.get(send.sourceEventId), question, state)) ||
        send.sourceEventId === null && question.physicalSeq <= send.physicalSeq))) uncertainBaseline.add(questionId);
  }
  let duplicateQuestionCandidatesBlocked = 0, suspendedQuestionCandidates = 0;
  for (const batch of state.batches.values()) if (inWindow(batch.completedPhysicalSeq)) {
    duplicateQuestionCandidatesBlocked += batch.actions.filter(action => action.kind === 'question' && action.duplicateQuestion).length;
    suspendedQuestionCandidates += batch.suspended.filter(candidate => candidate.kind === 'question').length;
  }
  const unavailable = failed || !state.questionMetricEpochs.size;
  const complete = !unavailable && coveredWindow(intervals, afterSequence, throughSequence) && !unknownAttempts && !unattributedAttempts &&
    !unobservedDecisionSources && !unobservedLogicalDeliveries && !uncertainBaseline.size;
  return { afterSequence, throughSequence, shownAttempts: currentShown.length, knownRepeatedSends, unknownAttempts, unattributedAttempts,
    duplicateQuestionCandidatesBlocked, suspendedQuestionCandidates, unobservedDecisionSources, unobservedLogicalDeliveries,
    uncertainBaselineQuestions: uncertainBaseline.size, coverage: unavailable ? 'unavailable' : complete ? 'complete' : 'incomplete',
    repeatedQuestions: complete ? knownRepeatedSends : null };
}
function snapshotState(state) {
  return { version: 1, sequence: state.sequence, events: state.events, pendingEvents: pending(state), batches: [...state.batches.values()],
    activeBatch: state.activeBatchId ? state.batches.get(state.activeBatchId) : null,
    actions: [...state.actions.values()], questions: [...state.questions.values()], deliveries: [...state.deliveries.values()],
    reports: [...state.reports.values()], attempts: [...state.attempts.values()], suspended: [...state.suspended.values()],
    quarantined: [...state.quarantined.values()], sourceStates: [...state.sourceStates.values()],
    questionSends: [...state.questionSends.values()], questionMetricEpochs: [...state.questionMetricEpochs.values()],
    questionMetricGaps: state.questionMetricGaps, reviews: [...state.reviews.values()],
    cursors: { processed: cursor(state, state.processed), reported: cursor(state, state.reported) } };
}
function reviewContent(value) {
  return { projectionVersion: value.projectionVersion, window: value.window, provenance: value.provenance,
    frozen: value.frozen, questionMetrics: value.questionMetrics };
}
function reviewSummary(frozen, confirmation) {
  const groups = new Map(), candidates = new Set();
  for (const row of frozen.rows) {
    if (row.suspended) { candidates.add(row.candidateId); continue; }
    groups.set(row.suggestionId, (groups.get(row.suggestionId) ?? true) && row.assessable === true);
  }
  const marked = new Set(confirmation?.disagreedSuggestionIds || []);
  let agreedSuggestions = 0, disagreedSuggestions = 0, unableSuggestions = 0, pendingSuggestions = 0;
  for (const [suggestionId, assessable] of groups) {
    if (!assessable) unableSuggestions++;
    else if (!confirmation) pendingSuggestions++;
    else if (marked.has(suggestionId)) disagreedSuggestions++;
    else agreedSuggestions++;
  }
  return { distinctSuggestions: groups.size, agreedSuggestions, disagreedSuggestions, unableSuggestions, pendingSuggestions,
    markedSuggestions: marked.size, suspendedCandidates: candidates.size, disagreedCandidates: confirmation?.disagreedCandidateIds.length || 0,
    ...agreementSummary({ distinctSuggestions: groups.size, agreedSuggestions, confirmed: confirmation !== null }) };
}
function reviewRequest(value, review, includesId = false) {
  const keys = ['contentDigest', 'expectedRevision', 'disagreedSuggestionIds', 'disagreedCandidateIds', 'allRead'];
  object(value, [...keys, ...(includesId ? ['reviewId'] : [])], keys);
  requireValue(value.contentDigest === review.contentDigest, 'Frozen review content changed', 'BUTLER_REVIEW_DIGEST');
  requireValue(safeInteger(value.expectedRevision) && value.allRead === true, 'An explicit complete review is required', 'BUTLER_REVIEW_INVALID');
  const allowedSuggestions = new Set(review.frozen.rows.filter(row => !row.suspended).map(row => row.suggestionId));
  const allowedCandidates = new Set(review.frozen.rows.filter(row => row.suspended).map(row => row.candidateId));
  const marks = (values, allowed) => {
    requireValue(Array.isArray(values) && values.length <= allowed.size, 'Invalid review marks', 'BUTLER_REVIEW_INVALID');
    const result = values.map(value => idString(value));
    requireValue(new Set(result).size === result.length && result.every(value => allowed.has(value)), 'Review mark is outside the frozen set', 'BUTLER_REVIEW_INVALID');
    return result.sort();
  };
  return { contentDigest: value.contentDigest, expectedRevision: value.expectedRevision,
    disagreedSuggestionIds: marks(value.disagreedSuggestionIds, allowedSuggestions),
    disagreedCandidateIds: marks(value.disagreedCandidateIds, allowedCandidates), allRead: true };
}
function confirmationRequest(confirmation) {
  return { contentDigest: confirmation.contentDigest, expectedRevision: confirmation.expectedRevision,
    disagreedSuggestionIds: confirmation.disagreedSuggestionIds, disagreedCandidateIds: confirmation.disagreedCandidateIds, allRead: confirmation.allRead };
}
const CANDIDATE_ERRORS = new Set(['BUTLER_ACTION_SOURCE', 'BUTLER_UNKNOWN_EVIDENCE', 'BUTLER_QUESTION_SOURCE', 'BUTLER_QUESTION_EVIDENCE']);
function suspendedAction(input, index, reason, batchSources) {
  const candidate = { stage: 'ledger', index, reason, kind: input.kind };
  if (batchSources.has(input.sourceRef)) {
    try { candidate.sourceRef = safeCandidateText(input.sourceRef, 600); } catch { /* Retain only an admitted source reference. */ }
  }
  try { candidate.text = safeCandidateText(input.text); } catch { candidate.redacted = true; }
  return candidate;
}
function reduce(state, record) {
  object(record, ['version', 'sequence', 'time', 'type', 'data'], ['version', 'sequence', 'time', 'type', 'data']);
  requireValue(record.version === 1 && record.sequence === state.sequence + 1 && Number.isFinite(record.time) && record.time >= 0,
    'Invalid ledger record sequence');
  const data = record.data, time = record.time;
  switch (record.type) {
    case 'event': {
      const input = normalizeEvent(data), previous = state.eventIndex.get(input.eventId);
      requireValue(!previous, 'Duplicate event record');
      const event = { ...input, sequence: ++state.eventSequence, physicalSeq: record.sequence, time };
      state.events.push(event); state.eventIndex.set(event.eventId, event); break;
    }
    case 'source-transition': {
      object(data, ['sourceRef', 'active', 'generation', 'event'], ['sourceRef', 'active', 'generation']);
      const sourceRef = reference(data.sourceRef), previous = state.sourceStates.get(sourceRef);
      normalizeEvent({ eventId: 'source-validation', kind: 'queue-empty', sourceRef, payload: {} });
      requireValue(typeof data.active === 'boolean' && previous?.active !== data.active, 'Invalid source transition');
      const generation = (previous?.generation || 0) + (data.active ? 1 : 0);
      requireValue(safeInteger(data.generation) && data.generation === generation, 'Invalid source generation');
      requireValue(data.active === Object.hasOwn(data, 'event'), 'Only an active source transition records an event');
      let event;
      if (data.active) {
        const input = normalizeEvent(data.event);
        requireValue(input.kind === 'queue-empty' && input.sourceRef === sourceRef &&
          input.eventId === stableId('queue-empty', [sourceRef, generation]) && !state.eventIndex.has(input.eventId), 'Invalid source event');
        event = { ...input, sequence: state.eventSequence + 1, physicalSeq: record.sequence, time };
      }
      // The episode marker and its business event are committed by one journal
      // row, so a crash cannot consume the transition without its pending event.
      state.sourceStates.set(sourceRef, { sourceRef, active: data.active, generation,
        ...(event || previous?.eventId ? { eventId: event?.eventId || previous.eventId } : {}) });
      if (event) {
        state.eventSequence = event.sequence;
        state.events.push(event); state.eventIndex.set(event.eventId, event);
      }
      break;
    }
    case 'events-recorded': {
      object(data, ['eventIds'], ['eventIds']);
      requireValue(Array.isArray(data.eventIds) && data.eventIds.length > 0 && data.eventIds.length <= 10000, 'Invalid recorded event list');
      const active = state.activeBatchId ? state.batches.get(state.activeBatchId) : null;
      for (const eventId of data.eventIds) {
        const event = state.eventIndex.get(idString(eventId));
        requireValue(event && ['decision', 'failure', 'blocked'].includes(event.kind), 'Only rule-handled events can be recorded without a model');
        requireValue(!active?.eventIds.includes(eventId), 'An active batch owns this event', 'BUTLER_BATCH_STATE');
        requireValue(!state.quarantinedEvents.has(eventId), 'Quarantined events need separate recovery', 'BUTLER_EVENT_QUARANTINED');
      }
      for (const eventId of data.eventIds) state.processed.add(eventId);
      break;
    }
    case 'batch-start': {
      object(data, ['batchId', 'selection', 'eventIds'], ['batchId', 'selection', 'eventIds']);
      requireValue(state.activeBatchId === null && !state.batches.has(data.batchId), 'Another batch is active', 'BUTLER_BATCH_STATE');
      const selection = normalizeSelection(data.selection), batchId = idString(data.batchId);
      requireValue(Array.isArray(data.eventIds) && data.eventIds.length > 0 && data.eventIds.length <= MAX_BATCH &&
        canonical(data.eventIds) === canonical(pending(state).slice(0, data.eventIds.length).map(event => event.eventId)), 'Batch must cover the pending prefix');
      state.batches.set(batchId, { batchId, selection, eventIds: [...data.eventIds], status: 'running', attempt: 1, startedAt: time, physicalSeq: record.sequence });
      state.activeBatchId = batchId; break;
    }
    case 'batch-fail': {
      object(data, ['batchId', 'reason'], ['batchId', 'reason']);
      const batch = activeBatch(state, idString(data.batchId));
      requireValue(batch.status === 'running', 'Only a running batch can fail', 'BUTLER_BATCH_STATE');
      batch.status = 'failed'; batch.failure = string(data.reason, 2000); batch.failedAt = time; break;
    }
    case 'batch-retry': {
      object(data, ['batchId', 'selection'], ['batchId', 'selection']);
      const batch = activeBatch(state, idString(data.batchId)), selection = normalizeSelection(data.selection);
      requireValue(batch.status === 'failed' && sameSelection(selection, batch.selection), 'Batch needs an explicit retry by its current selection', 'BUTLER_BATCH_SELECTION');
      batch.selection = selection; batch.status = 'running'; batch.attempt++; batch.retriedAt = time; delete batch.failure; break;
    }
    case 'batch-rebind': {
      object(data, ['batchId', 'previousSelection', 'nextSelection'], ['batchId', 'previousSelection', 'nextSelection']);
      const batch = activeBatch(state, idString(data.batchId));
      const previousSelection = normalizeSelection(data.previousSelection), nextSelection = normalizeSelection(data.nextSelection);
      requireValue(batch.status === 'failed' && sameSelection(batch.selection, previousSelection) &&
        nextSelection.selectionRevision >= previousSelection.selectionRevision, 'Batch cannot rebind this selection', 'BUTLER_BATCH_SELECTION');
      batch.selection = nextSelection; batch.lastRebind = { previousSelection, nextSelection, time }; break;
    }
    case 'attempt-begin': {
      object(data, ['batchId', 'attempt', 'selection'], ['batchId', 'attempt', 'selection']);
      const batch = activeBatch(state, idString(data.batchId)), selection = normalizeSelection(data.selection);
      requireValue(batch.status === 'running' && data.attempt === batch.attempt && sameSelection(batch.selection, selection),
        'Attempt does not match the active batch', 'BUTLER_BATCH_SELECTION');
      const key = attemptKey(batch.batchId, data.attempt);
      requireValue(!state.attempts.has(key), 'Attempt was already started');
      state.attempts.set(key, { batchId: batch.batchId, attempt: data.attempt, startedAt: time, selection, usage: null });
      break;
    }
    case 'attempt-usage': {
      object(data, ['batchId', 'attempt', 'selection', 'usage'], ['batchId', 'attempt', 'selection', 'usage']);
      requireValue(Number.isSafeInteger(data.attempt) && data.attempt > 0, 'Invalid native attempt');
      const attempt = state.attempts.get(attemptKey(idString(data.batchId), data.attempt));
      requireValue(attempt && sameSelection(attempt.selection, normalizeSelection(data.selection)),
        'Usage does not belong to this native attempt', 'BUTLER_BATCH_SELECTION');
      attempt.usage = mergeUsage(attempt.usage, data.usage); attempt.usageRecordedAt = time;
      break;
    }
    case 'batch-quarantine': {
      object(data, ['batchId', 'selection', 'reason'], ['batchId', 'selection', 'reason']);
      const batch = activeBatch(state, idString(data.batchId)), selection = normalizeSelection(data.selection);
      requireValue(['running', 'failed'].includes(batch.status) && sameSelection(batch.selection, selection),
        'Only the current failed or running batch can be quarantined', 'BUTLER_BATCH_SELECTION');
      const reason = string(data.reason, 2000);
      const quarantined = { batchId: batch.batchId, attempt: batch.attempt, selection, eventIds: [...batch.eventIds],
        sourceRefs: batch.eventIds.map(id => state.eventIndex.get(id).sourceRef), reason, quarantinedAt: time };
      state.quarantined.set(batch.batchId, quarantined);
      for (const eventId of batch.eventIds) state.quarantinedEvents.add(eventId);
      batch.status = 'quarantined'; batch.quarantineReason = reason; batch.quarantinedAt = time; state.activeBatchId = null;
      break;
    }
    case 'batch-complete': {
      object(data, ['batchId', 'selection', 'result'], ['batchId', 'selection', 'result']);
      const batch = activeBatch(state, idString(data.batchId)), selection = normalizeSelection(data.selection), result = normalizeResult(data.result);
      requireValue(batch.status === 'running' && sameSelection(batch.selection, selection), 'Stale batch identity', 'BUTLER_BATCH_SELECTION');
      const batchSources = new Set(batch.eventIds.flatMap(id => { const event = state.eventIndex.get(id); return [event.eventId, event.sourceRef]; }));
      const actions = [], suspended = [];
      const suspend = candidate => {
        // The policy's indices refer to its original model list. Ledger indices
        // refer to the filtered actions list; the stage disambiguates them.
        requireValue(candidate.sourceRef === undefined || batchSources.has(candidate.sourceRef), 'Suspended source is outside its batch', 'BUTLER_ACTION_SOURCE');
        const item = { ...candidate, candidateId: stableId('candidate', [batch.batchId, candidate.stage, candidate.index]),
          batchId: batch.batchId, status: 'suspended', effect: 'none', time, physicalSeq: record.sequence };
        state.suspended.set(item.candidateId, item); suspended.push(item);
      };
      for (const candidate of result.suspended || []) suspend(candidate);
      for (const [index, input] of result.actions.entries()) {
        let question;
        try {
          requireValue(batchSources.has(input.sourceRef), 'Action source is outside its batch', 'BUTLER_ACTION_SOURCE');
          if (input.kind === 'question') question = planQuestion(state, input, time);
          else if (input.evidenceRevision !== undefined) evidenceEvents(state, input.evidenceRevision);
        } catch (error) {
          if (!CANDIDATE_ERRORS.has(error.code)) throw error;
          // planQuestion validates every field before creating a question, so a
          // rejected candidate cannot leave partial question authority behind.
          suspend(suspendedAction(input, index, error.code, batchSources)); continue;
        }
        const actionId = stableId('action', [input.kind, input.sourceRef, input.spaceId || null,
          input.kind === 'question' ? question.question.questionId : null]);
        const previous = state.actions.get(actionId);
        const action = { ...input, actionId, effect: 'none', ...(question ? { questionId: question.question.questionId,
          duplicateQuestion: question.duplicate } : {}), duplicate: Boolean(previous), batchId: batch.batchId, time, physicalSeq: record.sequence };
        if (!previous) state.actions.set(actionId, action);
        actions.push(action);
      }
      const reportActions = actions.filter(action => action.kind === 'report');
      const readyEvents = batch.eventIds.map(id => state.eventIndex.get(id)).filter(event => event.kind === 'ready')
        .map(event => ({ eventId: event.eventId, sourceRef: event.sourceRef, title: event.payload.title || event.payload.text || 'READY' }));
      if (reportActions.length || readyEvents.length) {
        const reportId = stableId('report', batch.batchId);
        const trustedReady = readyEvents.map(event => `READY ${event.sourceRef}: ${event.title}`);
        state.reports.set(reportId, { reportId, batchId: batch.batchId, eventIds: [...batch.eventIds], readyEvents,
          text: [...trustedReady, ...reportActions.map(action => action.text)].join('\n'), status: 'pending', createdAt: time });
      }
      batch.status = 'completed'; batch.completedAt = time; batch.completedPhysicalSeq = record.sequence;
      batch.actions = actions; batch.suspended = suspended; batch.result = result;
      batch.resultFingerprint = stableId('result', result);
      for (const eventId of batch.eventIds) state.processed.add(eventId);
      state.activeBatchId = null; break;
    }
    case 'question-reserve': {
      const input = questionInput(data), planned = planQuestion(state, input, time);
      requireValue(planned.question.status === 'open', 'A resolved question cannot be delivered');
      reserve(state, 'question', planned.question.questionId, time); break;
    }
    case 'stored-question-reserve': {
      object(data, ['questionId'], ['questionId']);
      const question = state.questions.get(idString(data.questionId));
      requireValue(question?.status === 'open', 'Stored question is not open', 'BUTLER_QUESTION_STATE');
      // Admission already fixed this question's identity, decision and text.
      // Later decisions on the same task cannot invalidate its delivery.
      reserve(state, 'question', question.questionId, time); break;
    }
    case 'question-answer': {
      object(data, ['questionId', 'answer'], ['questionId', 'answer']);
      const question = state.questions.get(idString(data.questionId));
      requireValue(question?.status === 'open', 'Question is not open');
      requireValue(data.answer === null || typeof data.answer === 'string', 'Invalid question answer');
      question.status = data.answer === null ? 'withdrawn' : 'answered';
      question.answer = data.answer === null ? null : string(data.answer, 12000); question.answeredAt = time; question.resolvedSequence = state.eventSequence; break;
    }
    case 'report-reserve': {
      object(data, ['reportId'], ['reportId']);
      const report = state.reports.get(idString(data.reportId));
      requireValue(report?.status === 'pending', 'Report is not awaiting delivery');
      reserve(state, 'report', report.reportId, time); report.status = 'reserved'; break;
    }
    case 'delivery-ack': {
      object(data, ['deliveryId', 'status'], ['deliveryId', 'status']);
      const delivery = state.deliveries.get(idString(data.deliveryId));
      requireValue(delivery && ['sent', 'unknown'].includes(data.status), 'Invalid delivery acknowledgement');
      requireValue(delivery.status !== 'sent', 'A sent delivery cannot be downgraded');
      delivery.status = data.status; delivery.acknowledgedAt = time;
      delivery.acknowledgements.push({ status: data.status, physicalSeq: record.sequence, time });
      if (delivery.kind === 'report') {
        const report = state.reports.get(delivery.targetId); report.status = data.status;
        if (data.status === 'sent') for (const eventId of report.eventIds) state.reported.add(eventId);
      }
      break;
    }
    case 'question-metric-open': {
      object(data, ['epochId'], ['epochId']); const epochId = idString(data.epochId);
      requireValue(!state.questionMetricEpochs.has(epochId), 'Question metric epoch already exists', 'BUTLER_QUESTION_METRIC_EPOCH');
      state.questionMetricEpochs.set(epochId, { epochId, status: 'open', physicalSeq: record.sequence, openedAt: time, checkpoints: [] });
      break;
    }
    case 'question-metric-checkpoint': {
      object(data, ['epochId', 'throughSequence'], ['epochId', 'throughSequence']);
      const epoch = state.questionMetricEpochs.get(idString(data.epochId));
      requireValue(epoch?.status === 'open' && safeInteger(data.throughSequence) && data.throughSequence >= epoch.physicalSeq &&
        data.throughSequence <= state.sequence && data.throughSequence > (epoch.checkpoints.at(-1)?.throughSequence || 0) &&
        !state.questionMetricGaps.some(gap => gap.epochId === epoch.epochId), 'Question metric prefix cannot be certified', 'BUTLER_QUESTION_METRIC_EPOCH');
      epoch.checkpoints.push({ throughSequence: data.throughSequence, physicalSeq: record.sequence, time });
      break;
    }
    case 'question-metric-close': {
      object(data, ['epochId'], ['epochId']);
      const epoch = state.questionMetricEpochs.get(idString(data.epochId));
      requireValue(epoch?.status === 'open', 'Question metric epoch is not open', 'BUTLER_QUESTION_METRIC_EPOCH');
      epoch.status = 'closed'; epoch.closedPhysicalSeq = record.sequence; epoch.closedAt = time;
      break;
    }
    case 'question-metric-gap': {
      object(data, ['epochId', 'reason'], ['epochId', 'reason']);
      const epoch = state.questionMetricEpochs.get(idString(data.epochId));
      requireValue(epoch?.status === 'open' && QUESTION_METRIC_GAPS.includes(data.reason), 'Invalid question metric gap', 'BUTLER_QUESTION_METRIC_EPOCH');
      state.questionMetricGaps.push({ epochId: epoch.epochId, reason: data.reason, physicalSeq: record.sequence, time });
      break;
    }
    case 'question-send-begin': {
      object(data, ['epochId', 'attemptId', 'questionId', 'deliveryId', 'sourceEventId', 'channel'],
        ['epochId', 'attemptId', 'questionId', 'deliveryId', 'sourceEventId', 'channel']);
      const epoch = state.questionMetricEpochs.get(idString(data.epochId)), input = questionSendInput(data, true);
      requireValue(epoch?.status === 'open' && !state.questionSends.has(input.attemptId), 'Invalid question send intent', 'BUTLER_QUESTION_SEND_STATE');
      const question = state.questions.get(input.questionId), event = state.eventIndex.get(input.sourceEventId), delivery = state.deliveries.get(input.deliveryId);
      const attributed = Boolean(questionSource(event, question, state) &&
        (input.deliveryId === null || delivery?.kind === 'question' && delivery.targetId === question.questionId));
      state.questionSends.set(input.attemptId, { ...input, epochId: epoch.epochId, attributed, status: 'intent', physicalSeq: record.sequence,
        startedAt: time, acknowledgements: [] });
      break;
    }
    case 'question-send-ack': {
      object(data, ['attemptId', 'status'], ['attemptId', 'status']);
      const send = state.questionSends.get(idString(data.attemptId));
      requireValue(send && ['shown', 'failed', 'unknown'].includes(data.status) && send.status !== 'shown' && send.status !== data.status &&
        !(send.status === 'failed' && data.status === 'unknown'), 'Invalid question send receipt', 'BUTLER_QUESTION_SEND_STATE');
      send.status = data.status;
      send.acknowledgements.push({ status: data.status, physicalSeq: record.sequence, time });
      break;
    }
    case 'review-freeze': {
      object(data, ['reviewId', 'projectionVersion', 'window', 'provenance', 'frozen', 'questionMetrics', 'contentDigest', 'metricEpochId'],
        ['reviewId', 'projectionVersion', 'window', 'provenance', 'frozen', 'questionMetrics', 'contentDigest', 'metricEpochId']);
      const reviewId = idString(data.reviewId);
      requireValue(!state.reviews.has(reviewId) && data.projectionVersion === 1, 'Invalid frozen review identity or version', 'BUTLER_REVIEW_INVALID');
      object(data.window, ['afterSequence', 'throughSequence'], ['afterSequence', 'throughSequence']);
      requireValue(safeInteger(data.window.afterSequence) && data.window.afterSequence <= state.sequence && data.window.throughSequence === state.sequence,
        'Review must freeze the exact current head', 'BUTLER_REVIEW_INVALID');
      requireValue(canonical(data.provenance) === canonical(REVIEW_PROVENANCE), 'Review cannot certify a working-day trial', 'BUTLER_REVIEW_INVALID');
      if (data.metricEpochId !== null) {
        const epoch = state.questionMetricEpochs.get(idString(data.metricEpochId));
        requireValue(epoch?.status === 'open' && !state.questionMetricGaps.some(gap => gap.epochId === epoch.epochId),
          'Question metric prefix cannot be certified', 'BUTLER_QUESTION_METRIC_EPOCH');
        // The person-triggered freeze and its writer's prefix certificate share
        // one append. A failed/oversized freeze cannot leave a false receipt.
        epoch.checkpoints.push({ throughSequence: state.sequence, physicalSeq: record.sequence, time });
      }
      const frozen = projectReview(snapshotState(state), { afterSequence: data.window.afterSequence, maxBytes: MAX_RECORD_BYTES });
      const metrics = questionMetrics(state, data.window, { ownedEpoch: null, ownedGap: false, failed: false });
      requireValue(canonical(data.frozen) === canonical(frozen) && canonical(data.questionMetrics) === canonical(metrics),
        'Frozen review differs from its journal prefix', 'BUTLER_REVIEW_INVALID');
      requireValue(data.contentDigest === stableId('review-content', reviewContent(data)), 'Invalid frozen review digest', 'BUTLER_REVIEW_DIGEST');
      state.reviews.set(reviewId, { reviewId, ...clone(reviewContent(data)), contentDigest: data.contentDigest,
        createdAt: time, physicalSeq: record.sequence, revision: 0, confirmation: null, confirmations: [], summary: reviewSummary(frozen, null) });
      if (frozen.rows.length || frozen.failed.length) state.hasStoredReviewData = true;
      break;
    }
    case 'review-confirm': {
      const review = state.reviews.get(idString(data.reviewId));
      requireValue(review, 'Unknown frozen review', 'BUTLER_REVIEW_NOT_FOUND');
      const input = reviewRequest(data, review, true);
      requireValue(input.expectedRevision === review.revision && review.revision < Number.MAX_SAFE_INTEGER,
        'Review confirmation is stale', 'BUTLER_REVIEW_REVISION');
      const confirmation = { ...input, revision: review.revision + 1, physicalSeq: record.sequence, confirmedAt: time };
      const summary = reviewSummary(review.frozen, confirmation);
      review.revision = confirmation.revision; review.confirmation = confirmation; review.confirmations.push(confirmation); review.summary = summary;
      break;
    }
    default: throw invalid('Unknown ledger record type');
  }
  // This ledger's name in a read position (eventsAfter): its first record, which never changes once written.
  if (record.sequence === 1) state.origin = createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 16);
  state.sequence = record.sequence;
}
function fileIdentity(stat) { return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }; }
function safeFile(stat) {
  requireValue(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o7777) === 0o600 &&
    (!process.getuid || stat.uid === process.getuid()) && stat.size <= MAX_FILE_BYTES, 'Unsafe butler ledger file', 'BUTLER_LEDGER_UNSAFE');
}

class ButlerLedger {
  #authorizePerson;
  #ownedQuestionMetricEpoch = null;
  #questionMetricGap = false;
  constructor(directory, { now = Date.now, id = randomUUID, authorizePerson = () => false } = {}) {
    requireValue(typeof directory === 'string' && path.isAbsolute(directory), 'Butler directory must be absolute');
    requireValue(typeof now === 'function' && typeof id === 'function' && typeof authorizePerson === 'function', 'Invalid ledger clock, identity generator or person verifier');
    this.#authorizePerson = authorizePerson;
    this.directory = directory; this.file = path.join(directory, FILE_NAME); this.now = now; this.id = id;
    this.state = initialState(); this.expectedFile = null; this.failed = false;
    this.load();
  }
  load() {
    try {
      const directory = fs.lstatSync(this.directory);
      requireValue(directory.isDirectory() && !directory.isSymbolicLink() && (!process.getuid || directory.uid === process.getuid()) &&
        !(directory.mode & 0o077), 'Unsafe butler ledger directory', 'BUTLER_LEDGER_UNSAFE');
    } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    let stat;
    try { stat = fs.lstatSync(this.file); }
    catch (error) { if (error.code === 'ENOENT') return; throw invalid('Butler ledger cannot be read'); }
    safeFile(stat); requireValue(!stat.isSymbolicLink(), 'Unsafe butler ledger file');
    let fd;
    try {
      fd = fs.openSync(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const actual = fs.fstatSync(fd); safeFile(actual);
      requireValue(actual.dev === stat.dev && actual.ino === stat.ino, 'Butler ledger changed while opening');
      const bytes = fs.readFileSync(fd), text = bytes.toString('utf8');
      requireValue(Buffer.from(text).equals(bytes), 'Butler ledger contains invalid UTF-8');
      requireValue(canonical(fileIdentity(fs.fstatSync(fd))) === canonical(fileIdentity(actual)), 'Butler ledger changed while reading');
      requireValue(text === '' || text.endsWith('\n'), 'Butler ledger has an incomplete record');
      for (const line of text ? text.slice(0, -1).split('\n') : []) {
        requireValue(Buffer.byteLength(line) <= MAX_RECORD_BYTES && line.trim(), 'Invalid butler ledger record');
        let record; try { record = JSON.parse(line); } catch { throw invalid('Butler ledger contains invalid JSON'); }
        reduce(this.state, record);
      }
      this.expectedFile = fileIdentity(actual);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  healthy() { requireValue(!this.failed, 'Butler ledger needs recovery after an uncertain write', 'BUTLER_LEDGER_FAILED'); }
  #append(type, data) {
    this.healthy();
    const record = { version: 1, sequence: this.state.sequence + 1, time: this.now(), type, data: clone(data) };
    const next = clone(this.state); reduce(next, record);
    const bytes = Buffer.from(JSON.stringify(record) + '\n');
    requireValue(bytes.length <= MAX_RECORD_BYTES && (this.expectedFile?.size || 0) + bytes.length <= MAX_FILE_BYTES, 'Butler ledger capacity reached');
    let fd, directoryFd;
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const directory = fs.lstatSync(this.directory);
      requireValue(directory.isDirectory() && !directory.isSymbolicLink() && (!process.getuid || directory.uid === process.getuid()) &&
        !(directory.mode & 0o077), 'Unsafe butler ledger directory');
      const create = this.expectedFile === null;
      fd = fs.openSync(this.file, fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0) |
        (create ? fs.constants.O_CREAT | fs.constants.O_EXCL : 0), 0o600);
      const stat = fs.fstatSync(fd); safeFile(stat);
      const named = fs.lstatSync(this.file);
      requireValue(named.dev === stat.dev && named.ino === stat.ino && !named.isSymbolicLink(), 'Butler ledger path changed');
      requireValue(create || canonical(fileIdentity(stat)) === canonical(this.expectedFile), 'Butler ledger changed outside its writer');
      let offset = 0;
      while (offset < bytes.length) {
        const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
        requireValue(written > 0, 'Butler ledger write did not advance'); offset += written;
      }
      fs.fsyncSync(fd);
      if (create) { directoryFd = fs.openSync(this.directory, 'r'); fs.fsyncSync(directoryFd); }
      this.expectedFile = fileIdentity(fs.fstatSync(fd)); this.state = next;
    } catch {
      this.failed = true;
      throw invalid('Butler ledger write failed; source records were retained', 'BUTLER_LEDGER_WRITE');
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (directoryFd !== undefined) fs.closeSync(directoryFd);
    }
  }
  ingest(value) {
    this.healthy(); const event = normalizeEvent(value), existing = this.state.eventIndex.get(event.eventId);
    if (existing) {
      const original = { eventId: existing.eventId, kind: existing.kind, sourceRef: existing.sourceRef, payload: existing.payload };
      requireValue(canonical(event) === canonical(original), 'Event identity reused with different content', 'BUTLER_EVENT_CONFLICT');
      return clone(existing);
    }
    this.#append('event', event); return clone(this.state.eventIndex.get(event.eventId));
  }
  // Trusted host observations only. The source's false-to-true edge creates a
  // queue-empty episode; repeated snapshots do not create model work or rows.
  observeSource(sourceRef, active, payload = {}) {
    this.healthy(); sourceRef = reference(sourceRef);
    requireValue(typeof active === 'boolean', 'Source activity must be a boolean');
    const previous = this.state.sourceStates.get(sourceRef);
    const generation = (previous?.generation || 0) + (active && previous?.active !== true ? 1 : 0);
    requireValue(safeInteger(generation), 'Source generation exhausted');
    const event = normalizeEvent({ eventId: stableId('queue-empty', [sourceRef, generation]), kind: 'queue-empty', sourceRef, payload });
    if (previous?.active === active) return { changed: false,
      event: active ? clone(this.state.eventIndex.get(previous.eventId)) : null };
    this.#append('source-transition', { sourceRef, active, generation, ...(active ? { event } : {}) });
    return { changed: true, event: active ? clone(this.state.eventIndex.get(event.eventId)) : null };
  }
  pendingEvents() { this.healthy(); return clone(pending(this.state)); }
  // What the person's designated butler reads to report only what is new: the business events after a position
  // this ledger gave, oldest first, at most `limit`. A position is `<origin>:<sequence>`, origin naming this ledger
  // by its first record, so a restart keeps every position good. One from another ledger (a new profile, a replaced
  // file), past the newest event or malformed is refused, and the reader starts again from the beginning (null).
  // Reading changes nothing: what the separate butler's batches take stays as it is.
  eventsAfter(position = null, limit = 50) {
    this.healthy();
    requireValue(Number.isSafeInteger(limit) && limit > 0 && limit <= MAX_BATCH, 'Invalid event read limit');
    const origin = this.state.origin;
    let after = 0;
    if (position !== null) {
      const match = typeof position === 'string' ? /^([0-9a-f]{16}):(0|[1-9][0-9]{0,15})$/u.exec(position) : null;
      after = match ? Number(match[2]) : NaN;
      requireValue(match && match[1] === origin && Number.isSafeInteger(after) && after <= this.state.eventSequence,
        'This position is not one of the current butler ledger', 'BUTLER_POSITION_STALE');
    }
    const later = this.state.events.filter(event => event.sequence > after);
    const events = later.slice(0, limit).map(({ sequence, time, kind, payload }) => clone({ sequence, time, kind, payload }));
    return { events, through: origin === null ? null : `${origin}:${events.at(-1)?.sequence ?? after}`, more: later.length > events.length };
  }
  // Decisions/failures already handled by the rule/B1 path need no model turn.
  // Keep the original event and its independent reporting state for audit.
  consumeRecorded(eventIds) {
    this.healthy();
    requireValue(Array.isArray(eventIds) && eventIds.length > 0 && eventIds.length <= 10000, 'Invalid recorded event list');
    eventIds = [...new Set(eventIds.map(idString))];
    const trial = clone(this.state);
    reduce(trial, { version: 1, sequence: trial.sequence + 1, time: this.now(), type: 'events-recorded', data: { eventIds } });
    const recordedCount = eventIds.filter(eventId => !this.state.processed.has(eventId)).length;
    if (recordedCount) this.#append('events-recorded', { eventIds });
    return { eventIds: [...eventIds], recordedCount, processedCursor: cursor(this.state, this.state.processed) };
  }
  beginBatch(selection, limit = 50) {
    this.healthy(); selection = normalizeSelection(selection);
    requireValue(Number.isSafeInteger(limit) && limit > 0 && limit <= MAX_BATCH, 'Invalid batch limit');
    if (this.state.activeBatchId) {
      const batch = this.state.batches.get(this.state.activeBatchId);
      requireValue(batch.status === 'running', 'Failed batch needs explicit retryBatch', 'BUTLER_BATCH_RETRY_REQUIRED');
      requireValue(sameSelection(selection, batch.selection), 'Another selection owns the active batch', 'BUTLER_BATCH_SELECTION');
      return clone(batch);
    }
    const events = pending(this.state).slice(0, limit); if (!events.length) return null;
    const batchId = idString('batch:' + this.id());
    this.#append('batch-start', { batchId, selection, eventIds: events.map(event => event.eventId) });
    return clone(this.state.batches.get(batchId));
  }
  completeBatch(batchId, selection, value) {
    this.healthy(); batchId = idString(batchId); selection = normalizeSelection(selection); const result = normalizeResult(value);
    const previous = this.state.batches.get(batchId);
    if (previous?.status === 'completed') {
      requireValue(sameSelection(selection, previous.selection) && stableId('result', result) === previous.resultFingerprint,
        'Completed batch cannot change identity or result', 'BUTLER_BATCH_CONFLICT');
      return clone(previous);
    }
    this.#append('batch-complete', { batchId, selection, result }); return clone(this.state.batches.get(batchId));
  }
  failBatch(batchId, reason) {
    this.healthy(); batchId = idString(batchId); reason = string(reason, 2000);
    const previous = this.state.batches.get(batchId);
    if (previous?.status === 'failed' && previous.failure === reason) return clone(previous);
    this.#append('batch-fail', { batchId, reason }); return clone(this.state.batches.get(batchId));
  }
  retryBatch(batchId, selection) {
    this.healthy(); this.#append('batch-retry', { batchId: idString(batchId), selection: normalizeSelection(selection) });
    return clone(this.state.batches.get(batchId));
  }
  // Both contexts are supplied by the desktop after role authorization. Rebinding
  // preserves work, but cannot turn a running/uncertain native turn into a retry.
  rebindBatch(batchId, previousSelection, nextSelection) {
    this.healthy(); batchId = idString(batchId);
    previousSelection = normalizeSelection(previousSelection); nextSelection = normalizeSelection(nextSelection);
    const batch = this.state.batches.get(batchId);
    if (batch?.status === 'failed' && batch.lastRebind &&
      sameSelection(batch.lastRebind.previousSelection, previousSelection) && sameSelection(batch.selection, nextSelection)) return clone(batch);
    this.#append('batch-rebind', { batchId, previousSelection, nextSelection }); return clone(this.state.batches.get(batchId));
  }
  beginAttempt(batchId, selection) {
    this.healthy(); batchId = idString(batchId); selection = normalizeSelection(selection);
    const batch = activeBatch(this.state, batchId);
    requireValue(batch.status === 'running' && sameSelection(batch.selection, selection), 'Attempt selection changed', 'BUTLER_BATCH_SELECTION');
    const previous = this.state.attempts.get(attemptKey(batchId, batch.attempt));
    if (previous) return clone(previous);
    this.#append('attempt-begin', { batchId, attempt: batch.attempt, selection });
    return clone(this.state.attempts.get(attemptKey(batchId, batch.attempt)));
  }
  // Usage is supplied only by the host's native result/explicit reconciliation,
  // never by model-authored action JSON. Historical attempts remain addressable.
  recordAttemptUsage(batchId, selection, usage, attemptNumber) {
    this.healthy(); batchId = idString(batchId); selection = normalizeSelection(selection);
    if (attemptNumber === undefined) {
      const matches = [...this.state.attempts.values()].filter(attempt => attempt.batchId === batchId && sameSelection(attempt.selection, selection));
      requireValue(matches.length === 1, 'An exact attempt number is required', 'BUTLER_USAGE_ATTEMPT'); attemptNumber = matches[0].attempt;
    }
    requireValue(Number.isSafeInteger(attemptNumber) && attemptNumber > 0, 'Invalid native attempt');
    const previous = this.state.attempts.get(attemptKey(batchId, attemptNumber));
    requireValue(previous && sameSelection(previous.selection, selection), 'Usage selection changed', 'BUTLER_BATCH_SELECTION');
    const normalized = usage === null ? null : normalizeUsage(usage), merged = mergeUsage(previous.usage, normalized);
    if (canonical(previous.usage) === canonical(merged)) return clone(previous);
    this.#append('attempt-usage', { batchId, attempt: attemptNumber, selection, usage: normalized });
    return clone(this.state.attempts.get(attemptKey(batchId, attemptNumber)));
  }
  quarantineBatch(batchId, selection, reason) {
    this.healthy(); batchId = idString(batchId); selection = normalizeSelection(selection); reason = string(reason, 2000);
    const existing = this.state.quarantined.get(batchId);
    if (existing && sameSelection(existing.selection, selection) && existing.reason === reason) return clone(existing);
    this.#append('batch-quarantine', { batchId, selection, reason }); return clone(this.state.quarantined.get(batchId));
  }
  reserveQuestion(value) {
    this.healthy(); const input = questionInput(value), trial = clone(this.state), planned = planQuestion(trial, input, this.now());
    const question = planned.question, deliveryId = stableId('delivery', ['question', question.questionId]);
    const previous = this.state.deliveries.get(deliveryId);
    if (question.status !== 'open' || previous) return { question: clone(question), deliveryId: previous?.deliveryId || null, shouldNotify: false };
    this.#append('question-reserve', input);
    return { question: clone(this.state.questions.get(question.questionId)), deliveryId, shouldNotify: true };
  }
  // The host checks this stored question's completed-batch role origin first.
  // This method can reserve delivery only; it cannot admit or rewrite a question.
  reserveStoredQuestion(questionId) {
    this.healthy(); questionId = idString(questionId);
    const question = this.state.questions.get(questionId);
    requireValue(question, 'Unknown stored question', 'BUTLER_QUESTION_STATE');
    const deliveryId = stableId('delivery', ['question', questionId]), previous = this.state.deliveries.get(deliveryId);
    if (previous || question.status !== 'open') return { question: clone(question), deliveryId: previous?.deliveryId || null, shouldNotify: false };
    this.#append('stored-question-reserve', { questionId });
    return { question: clone(this.state.questions.get(questionId)), deliveryId, shouldNotify: true };
  }
  // The injected verifier recognizes an opaque desktop context. Never persist
  // that context or accept model-authored {kind:'person'} as authorization.
  answerQuestion(questionId, answer, person) {
    this.healthy(); let authorized = false;
    try { authorized = this.#authorizePerson(person) === true; } catch {}
    requireValue(authorized, 'Only a verified person can resolve a question', 'BUTLER_PERSON_ONLY');
    questionId = idString(questionId); if (answer !== null) string(answer, 12000);
    const previous = this.state.questions.get(questionId);
    if (previous && previous.status === (answer === null ? 'withdrawn' : 'answered') && previous.answer === answer) return clone(previous);
    this.#append('question-answer', { questionId, answer }); return clone(this.state.questions.get(questionId));
  }
  pendingReports() { this.healthy(); return clone([...this.state.reports.values()].filter(report => report.status === 'pending')); }
  reserveReport(reportId) {
    this.healthy(); reportId = idString(reportId); const report = this.state.reports.get(reportId);
    requireValue(report, 'Unknown report');
    const deliveryId = stableId('delivery', ['report', reportId]);
    if (report.status !== 'pending') return { report: clone(report), deliveryId, shouldNotify: false };
    this.#append('report-reserve', { reportId }); return { report: clone(this.state.reports.get(reportId)), deliveryId, shouldNotify: true };
  }
  ackDelivery(deliveryId, status = 'sent') {
    this.healthy(); deliveryId = idString(deliveryId); requireValue(['sent', 'unknown'].includes(status), 'Invalid delivery status');
    const delivery = this.state.deliveries.get(deliveryId); requireValue(delivery, 'Unknown delivery');
    if (delivery.status === status) return clone(delivery);
    this.#append('delivery-ack', { deliveryId, status }); return clone(this.state.deliveries.get(deliveryId));
  }
  openQuestionMetricEpoch(epochId) {
    this.healthy(); epochId = idString(epochId);
    const own = this.state.questionMetricEpochs.get(this.#ownedQuestionMetricEpoch);
    if (own?.status === 'open' && own.epochId === epochId) return clone(own);
    requireValue(own?.status !== 'open' && !this.state.questionMetricEpochs.has(epochId),
      'Question metric epoch cannot be adopted or replaced', 'BUTLER_QUESTION_METRIC_EPOCH');
    this.#append('question-metric-open', { epochId });
    this.#ownedQuestionMetricEpoch = epochId; this.#questionMetricGap = false;
    return clone(this.state.questionMetricEpochs.get(epochId));
  }
  #questionMetricEpoch() {
    this.healthy();
    const epoch = this.state.questionMetricEpochs.get(this.#ownedQuestionMetricEpoch);
    requireValue(epoch?.status === 'open', 'This writer owns no open question metric epoch', 'BUTLER_QUESTION_METRIC_EPOCH');
    return epoch;
  }
  checkpointQuestionMetrics(throughSequence = this.state.sequence) {
    const epoch = this.#questionMetricEpoch();
    requireValue(!this.#questionMetricGap && safeInteger(throughSequence) && throughSequence >= epoch.physicalSeq && throughSequence <= this.state.sequence,
      'Question metric prefix cannot be certified', 'BUTLER_QUESTION_METRIC_EPOCH');
    const previous = epoch.checkpoints.at(-1);
    if (previous?.throughSequence === throughSequence) return clone({ epochId: epoch.epochId, ...previous });
    this.#append('question-metric-checkpoint', { epochId: epoch.epochId, throughSequence });
    return clone({ epochId: epoch.epochId, ...this.state.questionMetricEpochs.get(epoch.epochId).checkpoints.at(-1) });
  }
  closeQuestionMetricEpoch() {
    const epoch = this.#questionMetricEpoch();
    this.#append('question-metric-close', { epochId: epoch.epochId });
    return clone(this.state.questionMetricEpochs.get(epoch.epochId));
  }
  markQuestionMetricGap(reason) {
    requireValue(QUESTION_METRIC_GAPS.includes(reason), 'Invalid question metric gap', 'BUTLER_QUESTION_METRIC_EPOCH');
    // Set before the append: even a failed append cannot make this writer claim
    // complete coverage. A previously durable open epoch protects the restart.
    this.#questionMetricGap = true;
    const epoch = this.#questionMetricEpoch();
    this.#append('question-metric-gap', { epochId: epoch.epochId, reason });
    return clone(this.state.questionMetricGaps.at(-1));
  }
  beginQuestionSend(value) {
    const input = questionSendInput(value), epoch = this.#questionMetricEpoch();
    const previous = this.state.questionSends.get(input.attemptId);
    if (previous) {
      requireValue(previous.epochId === epoch.epochId && Object.keys(input).every(key => input[key] === previous[key]),
        'Question send identity cannot be reused', 'BUTLER_QUESTION_SEND_STATE');
      return clone(previous);
    }
    this.#append('question-send-begin', { epochId: epoch.epochId, ...input });
    return clone(this.state.questionSends.get(input.attemptId));
  }
  ackQuestionSend(attemptId, status) {
    const epoch = this.#questionMetricEpoch(); attemptId = idString(attemptId);
    requireValue(['shown', 'failed', 'unknown'].includes(status), 'Invalid question send receipt', 'BUTLER_QUESTION_SEND_STATE');
    const previous = this.state.questionSends.get(attemptId);
    requireValue(previous?.epochId === epoch.epochId, 'This writer does not own the question send', 'BUTLER_QUESTION_SEND_STATE');
    if (previous.status === status) return clone(previous);
    if (previous.status === 'shown' || previous.status === 'failed' && status === 'unknown') {
      this.markQuestionMetricGap('delivery-unconfirmed'); return clone(previous);
    }
    const conflict = previous.status === 'failed' && status === 'shown';
    this.#append('question-send-ack', { attemptId, status });
    if (conflict) this.markQuestionMetricGap('delivery-unconfirmed');
    return clone(this.state.questionSends.get(attemptId));
  }
  questionSendMetrics(window = {}) {
    object(window, ['afterSequence', 'throughSequence']);
    return questionMetrics(this.state, window, { ownedEpoch: this.#ownedQuestionMetricEpoch, ownedGap: this.#questionMetricGap, failed: this.failed });
  }
  #reviewPerson(person) {
    let authorized = false;
    try { authorized = this.#authorizePerson(person) === true; } catch {}
    requireValue(authorized, 'Only a verified person can review butler records', 'BUTLER_PERSON_ONLY');
  }
  hasReviewData(person) {
    this.#reviewPerson(person); this.healthy();
    // Inspect existing indexes only. A saved failure remains reviewable after
    // its live batch is retried; an empty frozen review never creates an entry.
    return this.state.actions.size > 0 || this.state.suspended.size > 0 ||
      this.state.batches.get(this.state.activeBatchId)?.status === 'failed' || this.state.hasStoredReviewData;
  }
  freezeReview(options = {}, person) {
    this.#reviewPerson(person); this.healthy(); object(options, ['afterSequence']);
    const afterSequence = options.afterSequence === undefined ? 0 : options.afterSequence;
    const latest = [...this.state.reviews.values()].at(-1);
    if (latest?.window.afterSequence === afterSequence) {
      // Audit records cannot change business evidence or display receipts. Reuse
      // the saved view only when they account for the complete journal suffix.
      // Counting all reviews also handles a late confirmation of an older view.
      let auditRecords = 0;
      for (const review of this.state.reviews.values()) {
        if (review.physicalSeq > latest.window.throughSequence) auditRecords++;
        for (const confirmation of review.confirmations) {
          if (confirmation.physicalSeq > latest.window.throughSequence) auditRecords++;
        }
      }
      if (auditRecords === this.state.sequence - latest.window.throughSequence) return clone(latest);
    }
    const window = { afterSequence, throughSequence: this.state.sequence };
    const frozen = projectReview(snapshotState(this.state), { afterSequence, maxBytes: MAX_RECORD_BYTES });
    const questionMetrics = this.questionSendMetrics(window);
    const epoch = this.state.questionMetricEpochs.get(this.#ownedQuestionMetricEpoch);
    const metricEpochId = epoch?.status === 'open' && !this.#questionMetricGap &&
      !this.state.questionMetricGaps.some(gap => gap.epochId === epoch.epochId) ? epoch.epochId : null;
    const content = { projectionVersion: frozen.projectionVersion, window, provenance: { ...REVIEW_PROVENANCE }, frozen, questionMetrics };
    const reviewId = idString('review:' + this.id()), contentDigest = stableId('review-content', content);
    this.#append('review-freeze', { reviewId, ...content, contentDigest, metricEpochId });
    return clone(this.state.reviews.get(reviewId));
  }
  review(reviewId, person) {
    this.#reviewPerson(person); this.healthy(); reviewId = idString(reviewId);
    const review = this.state.reviews.get(reviewId);
    requireValue(review, 'Unknown frozen review', 'BUTLER_REVIEW_NOT_FOUND');
    return clone(review);
  }
  latestReview(person) {
    this.#reviewPerson(person); this.healthy();
    return clone([...this.state.reviews.values()].at(-1) || null);
  }
  confirmReview(reviewId, value, person) {
    this.#reviewPerson(person); this.healthy(); reviewId = idString(reviewId);
    const review = this.state.reviews.get(reviewId);
    requireValue(review, 'Unknown frozen review', 'BUTLER_REVIEW_NOT_FOUND');
    const input = reviewRequest(value, review);
    if (review.confirmations.some(confirmation => canonical(confirmationRequest(confirmation)) === canonical(input))) return clone(review);
    requireValue(input.expectedRevision === review.revision, 'Review confirmation is stale', 'BUTLER_REVIEW_REVISION');
    this.#append('review-confirm', { reviewId, ...input });
    return clone(this.state.reviews.get(reviewId));
  }
  snapshot() {
    this.healthy();
    return clone(snapshotState(this.state));
  }
}
module.exports = { ButlerLedger };
