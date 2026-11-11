// Presentation-only counts for an already frozen review. No ledger reads or writes.
// These keys belong to the UI; they are not a core confirmation payload.
(function (global) {
  'use strict';
  const policy = typeof module !== 'undefined' && module.exports ? require('../butler-review-policy.js') : global.NativeButlerReviewPolicy;
  if (!policy) throw Error('The shared butler review policy is unavailable');
  const MIN_REAL_SUGGESTIONS = policy.MIN_REVIEW_SUGGESTIONS;
  const nonempty = value => typeof value === 'string' && value.trim().length > 0;
  function requireValue(condition, message) { if (!condition) throw new TypeError(message); }

  function rowKey(row) {
    requireValue(row && typeof row === 'object' && !Array.isArray(row), 'Review row must be an object');
    requireValue(nonempty(row.id), 'Review occurrence needs an id');
    requireValue(typeof row.suspended === 'boolean', 'Review row needs a suspended flag');
    if (row.suspended) {
      if (row.candidateId !== undefined && row.candidateId !== null) {
        requireValue(nonempty(row.candidateId), 'Suspended candidate id must be nonempty');
        return 'candidate:' + row.candidateId;
      }
      return 'occurrence:' + row.id;
    }
    // actionId in the older ledger can collapse different tasks. Only the
    // core's semantic suggestion identity may join non-suspended occurrences.
    requireValue(nonempty(row.suggestionId), 'Non-suspended row needs a semantic suggestionId');
    return 'suggestion:' + row.suggestionId;
  }

  function measurement(value) {
    requireValue(value && typeof value === 'object' && !Array.isArray(value), 'Repeated-question measurement is required');
    requireValue(typeof value.complete === 'boolean', 'Repeated-question measurement needs a completeness flag');
    requireValue(value.count === null || Number.isSafeInteger(value.count) && value.count >= 0, 'Repeated-question count must be null or a nonnegative safe integer');
    if (value.complete) {
      requireValue(value.count !== null, 'Complete repeated-question measurement needs a count');
      requireValue(value.reason === undefined || value.reason === null || nonempty(value.reason), 'Measurement reason must be nonempty when supplied');
    } else {
      requireValue(nonempty(value.reason), 'Incomplete repeated-question records need a readable reason');
      requireValue(!/^(?:ERR|BUTLER)_[A-Z0-9_]+$/.test(value.reason.trim()), 'Incomplete records need a readable reason, not an internal code');
    }
    const reasonKeys = ['questionMetricUnavailable', 'questionMetricUnknown', 'questionMetricUnattributed',
      'questionMetricUnobserved', 'questionMetricBaseline', 'questionMetricIncomplete'];
    if (value.reasonParts !== undefined) {
      requireValue(Array.isArray(value.reasonParts) && value.reasonParts.length > 0 && value.reasonParts.length <= reasonKeys.length &&
        value.reasonParts.every(part => part && reasonKeys.includes(part.key) && part.params &&
          Object.keys(part.params).every(key => key === 'count' && Number.isSafeInteger(part.params[key]) && part.params[key] >= 0)), 'Invalid owned measurement explanation');
    }
    return { complete: value.complete, count: value.count, reason: value.reason ?? null,
      ...(value.reasonParts ? { reasonParts: value.reasonParts } : {}) };
  }

  function summarize(rows, marks, options) {
    requireValue(Array.isArray(rows), 'Review rows must be an array');
    requireValue(Object.prototype.toString.call(marks) === '[object Set]', 'Disagreement marks must be a Set');
    requireValue([...marks].every(nonempty), 'Disagreement keys must be nonempty strings');
    requireValue(options && typeof options === 'object' && !Array.isArray(options), 'Review options are required');
    const confirmed = options.confirmed === undefined ? false : options.confirmed;
    requireValue(typeof confirmed === 'boolean', 'Confirmation must be a boolean');
    requireValue(['audit', 'synthetic', 'real'].includes(options.sampleKind), 'Review needs a qualified sample kind');
    requireValue(typeof options.synthetic === 'boolean' && options.synthetic === (options.sampleKind === 'synthetic'), 'Synthetic flag must match the sample kind');
    const measured = measurement(options.repeatedQuestionsToPerson);
    const groups = new Map(), pausedGroups = new Map(), ids = new Set();
    let suspended = 0, unknownOccurrences = 0, pendingOccurrences = 0;
    let pausedDisagreed = 0, pausedUnable = 0, pausedAgreed = 0;
    for (const row of rows) {
      const key = rowKey(row);
      requireValue(!ids.has(row.id), 'Review occurrence ids must be unique'); ids.add(row.id);
      requireValue(typeof row.assessable === 'boolean', 'Review row needs an assessable flag');
      const marked = marks.has(key);
      if (!row.assessable) unknownOccurrences++;
      if (!confirmed && !marked) pendingOccurrences++;
      if (row.suspended) {
        const group = pausedGroups.get(key) || { marked, assessable: true };
        group.assessable = group.assessable && row.assessable;
        pausedGroups.set(key, group);
        continue;
      }
      const group = groups.get(key) || { marked, assessable: true };
      group.assessable = group.assessable && row.assessable;
      groups.set(key, group);
    }
    suspended = pausedGroups.size;
    for (const group of pausedGroups.values()) {
      if (group.marked) pausedDisagreed++;
      else if (!group.assessable) pausedUnable++;
      else if (confirmed) pausedAgreed++;
    }
    let disagreed = 0, unable = 0, markedSuggestions = 0;
    for (const group of groups.values()) {
      if (group.marked) markedSuggestions++;
      if (!group.assessable) unable++;
      else if (confirmed && group.marked) disagreed++;
    }
    const denominator = groups.size;
    const agreed = confirmed ? denominator - disagreed - unable : 0;
    return {
      total: rows.length, denominator,
      agreed,
      disagreed, unable, pendingOccurrences, suspended, unknownOccurrences,
      realSamples: options.sampleKind === 'real' ? denominator : 0, sampleKind: options.sampleKind, markedSuggestions,
      measurement: measured, minimumSamples: MIN_REAL_SUGGESTIONS,
      pausedDisagreed, pausedUnable, pausedAgreed,
      quality: policy.agreementSummary({ distinctSuggestions: denominator, agreedSuggestions: agreed, confirmed }),
    };
  }

  const api = { MIN_REAL_SUGGESTIONS, rowKey, summarize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.nativeWorkspaceButlerReviewModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
