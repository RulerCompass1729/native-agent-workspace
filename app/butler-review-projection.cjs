'use strict';
// A local, read-only projection of one complete, current ledger snapshot. The
// host owns authentication, persistence, recording periods and metric receipts.
const { createHash } = require('node:crypto');

const plain = value => value && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const position = value => Number.isSafeInteger(value) && value >= 0;
const clone = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' :
  plain(value) ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
const identity = value => 'suggestion:' + createHash('sha256').update(canonical(value)).digest('hex');
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
function requireValue(condition) {
  if (!condition) throw Object.assign(Error('Invalid butler review projection'), { code: 'BUTLER_REVIEW_PROJECTION' });
}
function requireCapacity(condition) {
  if (!condition) throw Object.assign(Error('Butler review capacity exceeded'), { code: 'BUTLER_REVIEW_CAPACITY' });
}

function sourcesFor(item, batchEvents) {
  // Event IDs and source references are separate namespaces. An exact event ID
  // fixes one event even if another event happens to use that string as its ref.
  const exact = batchEvents.filter(event => event.eventId === item.sourceRef);
  return exact.length ? exact : batchEvents.filter(event => event.sourceRef === item.sourceRef);
}
function businessSource(event) {
  const payload = event.payload;
  // A queue item ID is scoped by its source space, independently of the target
  // space proposed by this action. Names and later observations are not keys.
  if (nonempty(payload?.spaceId) && nonempty(payload?.itemId)) return ['queue-item', payload.spaceId, payload.itemId];
  return ['reference', event.sourceRef];
}
function sourceIdentity(sources, occurrenceId) {
  if (!sources.length) return { value: ['unavailable', occurrenceId], reason: 'source-unavailable' };
  const keys = sources.map(businessSource), first = canonical(keys[0]);
  if (keys.some(key => canonical(key) !== first)) {
    // Conflicting host boundaries must never collapse two tasks because they
    // share a reference. Exact source IDs retain the uncertainty for review.
    return { value: ['ambiguous-events', sources.map(event => event.eventId).sort()], reason: 'source-ambiguous' };
  }
  return { value: keys[0], reason: null };
}
function selectedFields(value, keys) {
  const result = {};
  for (const key of keys) if (Object.hasOwn(value, key) && value[key] !== undefined) result[key] = value[key];
  return result;
}

function projectReview(snapshot, { afterSequence = 0, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  requireValue(plain(snapshot) && position(snapshot.sequence) && position(afterSequence) && afterSequence <= snapshot.sequence &&
    Array.isArray(snapshot.events) && Array.isArray(snapshot.batches) && Array.isArray(snapshot.questions) &&
    Number.isSafeInteger(maxBytes) && maxBytes > 0);
  const throughSequence = snapshot.sequence, events = new Map(), questions = new Map(), batches = new Set();
  const rows = [], failed = [];
  const result = { projectionVersion: 1, sequence: throughSequence, afterSequence, throughSequence, rows, failed };
  let retainedBytes = Buffer.byteLength(JSON.stringify(result));
  requireCapacity(retainedBytes <= maxBytes);
  const append = (target, candidate) => {
    // Inspect one candidate before copying its complete sources. This caps
    // retained output while it is built, rather than cloning a batch's sources
    // for every occurrence and waiting for the journal's final record check.
    const bytes = Buffer.byteLength(JSON.stringify(candidate)) + (target.length ? 1 : 0);
    requireCapacity(bytes <= maxBytes - retainedBytes);
    retainedBytes += bytes;
    target.push(clone(candidate));
  };
  for (const event of snapshot.events) {
    requireValue(plain(event) && nonempty(event.eventId) && nonempty(event.sourceRef) && plain(event.payload) &&
      position(event.physicalSeq) && event.physicalSeq <= throughSequence && !events.has(event.eventId));
    events.set(event.eventId, event);
  }
  for (const question of snapshot.questions) {
    requireValue(plain(question) && nonempty(question.questionId) && !questions.has(question.questionId));
    questions.set(question.questionId, question);
  }
  for (const batch of snapshot.batches) {
    requireValue(plain(batch) && nonempty(batch.batchId) && !batches.has(batch.batchId) && Array.isArray(batch.eventIds));
    batches.add(batch.batchId);
    const batchEvents = batch.eventIds.map(id => events.get(id)).filter(Boolean);
    const missingSourceEventIds = batch.eventIds.filter(id => !events.has(id));
    if (batch.status === 'failed') {
      append(failed, { ...selectedFields(batch, ['batchId', 'failure', 'failedAt', 'startedAt', 'physicalSeq', 'selection', 'attempt']),
        time: batch.failedAt, events: batchEvents, missingSourceEventIds });
    }
    if (batch.status !== 'completed') continue;
    // A missing physical completion boundary cannot safely be inferred from an
    // event sequence, timestamp, array position or the current batch count.
    requireValue(position(batch.completedPhysicalSeq) && batch.completedPhysicalSeq > 0 && batch.completedPhysicalSeq <= throughSequence &&
      Array.isArray(batch.actions) && Array.isArray(batch.suspended));
    if (batch.completedPhysicalSeq <= afterSequence) continue;
    for (const [index, action] of batch.actions.entries()) {
      requireValue(plain(action) && nonempty(action.kind));
      const id = batch.batchId + ':action:' + index;
      const sources = sourcesFor(action, batchEvents), source = sourceIdentity(sources, id);
      const question = action.kind === 'question' ? questions.get(action.questionId) : null;
      const reason = !nonempty(action.text) ? 'text-unavailable' : source.reason ||
        (action.kind === 'question' && !question ? 'question-unavailable' : null);
      const suggestionId = action.kind === 'question' && question ? identity(['question', question.questionId]) :
        identity(['business', action.kind, source.value, action.spaceId ?? null, action.text ?? null]);
      append(rows, { ...selectedFields(action, ['actionId', 'kind', 'sourceRef', 'text', 'spaceId', 'decisionKind', 'evidenceRevision',
        'supersedes', 'effect', 'time', 'physicalSeq', 'duplicate', 'duplicateQuestion']), id, batchId: batch.batchId,
        suggestionId, suspended: false, assessable: reason === null, reason,
        sources, batchSources: batchEvents, missingSourceEventIds,
        selection: batch.selection, question: question || null, questionStatus: question?.status ?? null,
        supplementalSources: question ? (question.evidenceEventIds || []).map(id => events.get(id)).filter(Boolean) : [] });
    }
    for (const [index, candidate] of batch.suspended.entries()) {
      requireValue(plain(candidate) && nonempty(candidate.candidateId));
      const sources = sourcesFor(candidate, batchEvents), source = sourceIdentity(sources, candidate.candidateId);
      const unavailableReason = candidate.redacted === true || !nonempty(candidate.text) ? 'text-unavailable' : source.reason;
      append(rows, { ...selectedFields(candidate, ['candidateId', 'stage', 'index', 'kind', 'sourceRef', 'text', 'reason',
        'redacted', 'status', 'effect', 'time', 'physicalSeq']), id: batch.batchId + ':suspended:' + index,
        batchId: batch.batchId, suspended: true, assessable: unavailableReason === null, unavailableReason,
        sources, batchSources: batchEvents, missingSourceEventIds, selection: batch.selection });
    }
  }
  return result;
}

module.exports = { projectReview };
