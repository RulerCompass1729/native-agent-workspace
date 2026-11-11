// Shared arithmetic for a canonical set of distinct, reviewed suggestions.
// The host projection owns deduplication and suspension classification. These
// counts alone cannot certify a working-day trial or authorize activation.
(function (target) {
  'use strict';
  const MIN_REVIEW_SUGGESTIONS = 10;
  function agreementSummary(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw TypeError('Invalid butler review summary');
    const { distinctSuggestions, agreedSuggestions, confirmed } = value;
    if (!Number.isSafeInteger(distinctSuggestions) || distinctSuggestions < 0 ||
        !Number.isSafeInteger(agreedSuggestions) || agreedSuggestions < 0 || agreedSuggestions > distinctSuggestions ||
        typeof confirmed !== 'boolean') throw TypeError('Invalid butler review summary');
    if (distinctSuggestions < MIN_REVIEW_SUGGESTIONS) return { status: 'insufficient-samples', agreementRate: null, agreementMeetsThreshold: null };
    if (!confirmed) return { status: 'unreviewed', agreementRate: null, agreementMeetsThreshold: null };
    return { status: 'reviewed', agreementRate: agreedSuggestions / distinctSuggestions,
      agreementMeetsThreshold: BigInt(agreedSuggestions) * 10n >= BigInt(distinctSuggestions) * 9n };
  }
  const api = Object.freeze({ MIN_REVIEW_SUGGESTIONS, agreementSummary });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else target.NativeButlerReviewPolicy = api;
})(typeof window === 'undefined' ? globalThis : window);
