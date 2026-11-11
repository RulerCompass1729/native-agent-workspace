// Thin desktop adapter. The host owns the frozen set, provenance and receipts.
(function (root) {
  'use strict';
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\s\u0000-\u001f\u007f]/u.test(value);
  const same = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
  function create({ api, text }) {
    let disposed = false, epoch = 0, binding = null;
    const t = (key, params) => text('butlerReview.' + key, params);
    const fail = (key = 'adapterInvalid', code = 'BUTLER_REVIEW_RESPONSE') => { throw Object.assign(Error(t(key)), { code }); };
    const requireValue = value => { if (!value) fail(); };
    const current = ticket => { if (disposed || ticket !== epoch) fail('adapterChanged', 'BUTLER_REVIEW_STALE_UI'); };
    const token = review => JSON.stringify([review.reviewId, review.contentDigest, review.revision]);
    function ids(values, allowed) {
      requireValue(Array.isArray(values) && values.every(id) && new Set(values).size === values.length && values.every(value => allowed.has(value)));
      return [...values].sort();
    }
    async function call(action, ...args) {
      try { return await api.butlerReview(action, ...args); }
      catch (error) {
        const key = ({ 'error.butlerReview.conflict': 'adapterConflict', 'error.butlerReview.capacity': 'adapterCapacity',
          'error.butlerReview.personOnly': 'adapterPersonOnly', 'error.butlerReview.unavailable': 'adapterUnavailable' }[error?.uiMessage?.key]) || { BUTLER_REVIEW_REVISION: 'adapterConflict', BUTLER_REVIEW_DIGEST: 'adapterConflict',
          BUTLER_REVIEW_CAPACITY: 'adapterCapacity', BUTLER_PERSON_ONLY: 'adapterPersonOnly',
          BUTLER_REVIEW_UNAVAILABLE: 'adapterUnavailable' }[error?.code] || 'adapterFailed';
        fail(key, error?.code || 'BUTLER_REVIEW_REQUEST_FAILED');
      }
    }
    function normalize(review) {
      requireValue(review && id(review.reviewId) && id(review.contentDigest) && review.projectionVersion === 1 && integer(review.revision));
      requireValue(review.provenance?.kind === 'audit' && review.provenance.recordPeriod === 'off' && review.provenance.activation === 'off');
      const frozen = review.frozen, window = review.window;
      requireValue(frozen?.projectionVersion === 1 && Array.isArray(frozen.rows) && Array.isArray(frozen.failed) &&
        integer(window?.afterSequence) && integer(window.throughSequence) && window.afterSequence <= window.throughSequence &&
        frozen.afterSequence === window.afterSequence && frozen.throughSequence === window.throughSequence && frozen.sequence === window.throughSequence);
      const suggestionIds = new Set(), candidateIds = new Set(), occurrenceIds = new Set();
      for (const row of frozen.rows) {
        requireValue(row && typeof row.id === 'string' && row.id.length > 0 && !occurrenceIds.has(row.id) && typeof row.suspended === 'boolean' && typeof row.assessable === 'boolean');
        occurrenceIds.add(row.id);
        requireValue(id(row.suspended ? row.candidateId : row.suggestionId));
        (row.suspended ? candidateIds : suggestionIds).add(row.suspended ? row.candidateId : row.suggestionId);
      }
      const summary = review.summary;
      for (const field of ['distinctSuggestions', 'agreedSuggestions', 'disagreedSuggestions', 'unableSuggestions', 'pendingSuggestions', 'markedSuggestions', 'suspendedCandidates', 'disagreedCandidates']) requireValue(integer(summary?.[field]));
      requireValue(summary.distinctSuggestions === suggestionIds.size && summary.suspendedCandidates === candidateIds.size &&
        summary.agreedSuggestions + summary.disagreedSuggestions + summary.unableSuggestions + summary.pendingSuggestions === suggestionIds.size &&
        ['insufficient-samples', 'unreviewed', 'reviewed'].includes(summary.status) &&
        (summary.agreementRate === null || typeof summary.agreementRate === 'number' && summary.agreementRate >= 0 && summary.agreementRate <= 1) &&
        (summary.agreementMeetsThreshold === null || typeof summary.agreementMeetsThreshold === 'boolean'));
      let confirmation = null;
      if (review.confirmation === null) requireValue(review.revision === 0 && summary.agreedSuggestions === 0 &&
        summary.disagreedSuggestions === 0 && summary.markedSuggestions === 0 && summary.disagreedCandidates === 0);
      else {
        const c = review.confirmation;
        requireValue(c && c.allRead === true && c.contentDigest === review.contentDigest && integer(c.expectedRevision) &&
          c.revision === review.revision && review.revision === c.expectedRevision + 1);
        confirmation = { allRead: true, revision: c.revision,
          marks: [...ids(c.disagreedSuggestionIds, suggestionIds).map(value => 'suggestion:' + value),
            ...ids(c.disagreedCandidateIds, candidateIds).map(value => 'candidate:' + value)] };
      }
      const metrics = review.questionMetrics;
      requireValue(metrics && ['complete', 'incomplete', 'unavailable'].includes(metrics.coverage));
      for (const field of ['afterSequence', 'throughSequence', 'shownAttempts', 'knownRepeatedSends', 'unknownAttempts', 'unattributedAttempts',
        'duplicateQuestionCandidatesBlocked', 'suspendedQuestionCandidates', 'unobservedDecisionSources', 'unobservedLogicalDeliveries', 'uncertainBaselineQuestions']) requireValue(integer(metrics[field]));
      requireValue(metrics.afterSequence === window.afterSequence && metrics.throughSequence === window.throughSequence);
      const complete = metrics.coverage === 'complete';
      requireValue(complete ? integer(metrics.repeatedQuestions) : metrics.repeatedQuestions === null);
      if (complete) requireValue(metrics.repeatedQuestions === metrics.knownRepeatedSends && !metrics.unknownAttempts &&
        !metrics.unattributedAttempts && !metrics.unobservedDecisionSources && !metrics.unobservedLogicalDeliveries && !metrics.uncertainBaselineQuestions);
      const reasonParts = [], explain = (key, params = {}) => reasonParts.push({ key, params });
      if (!complete) {
        if (metrics.coverage === 'unavailable') explain('questionMetricUnavailable');
        else {
          if (metrics.unknownAttempts) explain('questionMetricUnknown', { count: metrics.unknownAttempts });
          if (metrics.unattributedAttempts) explain('questionMetricUnattributed', { count: metrics.unattributedAttempts });
          const missing = metrics.unobservedDecisionSources + metrics.unobservedLogicalDeliveries;
          if (missing) explain('questionMetricUnobserved', { count: missing });
          if (metrics.uncertainBaselineQuestions) explain('questionMetricBaseline', { count: metrics.uncertainBaselineQuestions });
          if (!reasonParts.length) explain('questionMetricIncomplete');
        }
      }
      const nextBinding = { reviewId: review.reviewId, contentDigest: review.contentDigest, revision: review.revision,
        token: token(review), suggestionIds, candidateIds };
      return { binding: nextBinding, view: { token: nextBinding.token, sampleKind: 'audit', synthetic: false, realSamples: 0,
        rows: structuredClone(frozen.rows), failed: structuredClone(frozen.failed), confirmation,
        summary: structuredClone(summary), repeatedQuestionsToPerson: { complete, count: complete ? metrics.repeatedQuestions : null,
          reason: complete ? null : reasonParts.map(part => t(part.key, part.params)).join(' '), ...(!complete ? { reasonParts } : {}) },
        blockedRepeatQuestionCandidates: metrics.duplicateQuestionCandidatesBlocked } };
    }
    async function read({ explicitOpen = false } = {}) {
      if (disposed) fail('adapterDisposed', 'BUTLER_REVIEW_DISPOSED');
      requireValue(typeof explicitOpen === 'boolean');
      const ticket = ++epoch; binding = null;
      let review = await call('latest'); current(ticket);
      let normalized = review === null ? null : normalize(review);
      // A previously empty head cannot strand later business evidence behind
      // an entry whose dialog closes before the New audit button is reachable.
      if (explicitOpen && (normalized === null || !normalized.view.rows.length && !normalized.view.failed.length)) {
        review = await call('freeze'); current(ticket); normalized = normalize(review);
      }
      if (normalized === null) return null;
      current(ticket); binding = normalized.binding;
      return normalized.view;
    }
    async function confirm(draft) {
      if (disposed) fail('adapterDisposed', 'BUTLER_REVIEW_DISPOSED');
      if (!binding || draft?.token !== binding.token) fail('adapterChanged', 'BUTLER_REVIEW_STALE_UI');
      requireValue(draft.allRead === true && Array.isArray(draft.marks) && new Set(draft.marks).size === draft.marks.length);
      const captured = binding, suggestions = [], candidates = [];
      for (const mark of draft.marks) {
        requireValue(typeof mark === 'string');
        if (mark.startsWith('suggestion:')) suggestions.push(mark.slice('suggestion:'.length));
        else if (mark.startsWith('candidate:')) candidates.push(mark.slice('candidate:'.length));
        else fail();
      }
      const payload = { reviewId: captured.reviewId, contentDigest: captured.contentDigest, expectedRevision: captured.revision,
        disagreedSuggestionIds: ids(suggestions, captured.suggestionIds), disagreedCandidateIds: ids(candidates, captured.candidateIds), allRead: true };
      const ticket = ++epoch, response = await call('confirm', payload); current(ticket);
      const normalized = normalize(response), c = response.confirmation;
      if (response.reviewId !== payload.reviewId || response.contentDigest !== payload.contentDigest || response.revision !== payload.expectedRevision + 1 ||
          !c || c.expectedRevision !== payload.expectedRevision || c.revision !== response.revision || c.allRead !== true ||
          !same([...c.disagreedSuggestionIds].sort(), payload.disagreedSuggestionIds) || !same([...c.disagreedCandidateIds].sort(), payload.disagreedCandidateIds)) fail('adapterConflict', 'BUTLER_REVIEW_RECEIPT_MISMATCH');
      current(ticket); binding = normalized.binding;
      return normalized.view;
    }
    async function freeze() {
      if (disposed) fail('adapterDisposed', 'BUTLER_REVIEW_DISPOSED');
      const ticket = ++epoch; binding = null;
      const response = await call('freeze'); current(ticket);
      const normalized = normalize(response); current(ticket); binding = normalized.binding;
      return normalized.view;
    }
    return { read, open: () => read({ explicitOpen: true }), freeze, confirm, dispose() { disposed = true; epoch++; binding = null; } };
  }
  const exported = { create };
  if (typeof module === 'object' && module.exports) module.exports = exported;
  else root.nativeWorkspaceButlerReviewAdapter = exported;
})(globalThis);
