'use strict';
// Read-only ledger accounting. A recorded run attempt is not a provider HTTP
// request; one run may make several requests, or have an uncertain start.
const TOKEN_FIELDS = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens'];
const count = value => Number.isSafeInteger(value) && value >= 0;
const utcDay = time => new Date(time).toISOString().slice(0, 10);
const reading = () => ({ value: 0, knownLowerBound: 0, unknownRuns: 0, overflow: false });
function add(target, value) {
  if (!count(value)) target.unknownRuns++;
  else if (!target.overflow) {
    const total = target.knownLowerBound + value;
    if (!count(total)) { target.overflow = true; target.knownLowerBound = null; }
    else target.knownLowerBound = total;
  }
  target.value = target.overflow || target.unknownRuns ? null : target.knownLowerBound;
}

function summarizeUsage(snapshot, { now = Date.now() } = {}) {
  if (!snapshot || !Array.isArray(snapshot.attempts) || !Array.isArray(snapshot.batches) ||
      !Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) throw TypeError('Butler usage snapshot unavailable');
  const day = utcDay(now), metered = new Set(), sources = new Set();
  const today = { recordedRunCount: 0, attemptCount: 0, legacyBatchCount: 0, providerRequestCount: null,
    costMicros: reading(), tokens: Object.fromEntries(TOKEN_FIELDS.map(field => [field, reading()])),
    sources: { values: [], unknownRuns: 0 }, estimated: { yes: 0, no: 0, unknown: 0 } };
  const guard = { reason: null, unknownAttempts: 0 };
  const reason = value => { guard.reason ||= value; };
  const observeToday = (usage, isAttempt) => {
    today.recordedRunCount++;
    if (isAttempt) today.attemptCount++; else today.legacyBatchCount++;
    add(today.costMicros, usage?.costMicros);
    for (const field of TOKEN_FIELDS) add(today.tokens[field], usage?.[field]);
    if (typeof usage?.source === 'string' && usage.source.trim()) sources.add(usage.source);
    else today.sources.unknownRuns++;
    today.estimated[usage?.estimated === true ? 'yes' : usage?.estimated === false ? 'no' : 'unknown']++;
    if (count(usage?.costMicros) && today.costMicros.overflow) reason('usage-cost-invalid');
  };
  // Preserve the controller's guard order: inspect every historical attempt's
  // amount before checking its day, including failed, stale and isolated work.
  for (const attempt of snapshot.attempts) {
    metered.add(attempt.batchId);
    if (!count(attempt.usage?.costMicros)) { guard.unknownAttempts++; reason('usage-cost-unknown'); }
    if (utcDay(attempt.startedAt) === day) observeToday(attempt.usage, true);
  }
  // Legacy batches have no per-attempt record. Any attempt coverage suppresses
  // this fallback, even when that attempt started on a different UTC day.
  for (const batch of snapshot.batches) {
    if (metered.has(batch.batchId) || batch.status !== 'completed' || utcDay(batch.completedAt) !== day) continue;
    if (!count(batch.result?.usage?.costMicros)) reason('usage-cost-unknown');
    observeToday(batch.result?.usage, false);
  }
  today.sources.values = [...sources].sort();
  return { utcDay: day, asOf: now, today, guard };
}

module.exports = { summarizeUsage };
