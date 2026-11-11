'use strict';
const count = v => Number.isSafeInteger(v) && v >= 0;
// Preserve confirmed provider fields even when a later request/batch fails.
// A missing/invalid row makes these sums lower bounds, never a complete bill.
function settledUsage(rows, requests) {
  const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0,
    tokensComplete: rows.length === requests, costMicros: null, source: 'dsh-provider', estimated: false };
  for (const row of rows) {
    if (!row) { usage.tokensComplete = false; continue; }
    const read = row.cacheReadTokens === undefined ? 0 : row.cacheReadTokens;
    const write = row.cacheWriteTokens === undefined ? 0 : row.cacheWriteTokens;
    // Retain each confirmed field; missing output must not erase known input.
    const values = [['inputTokens', row.inputTokens], ['inputTokens', read], ['inputTokens', write],
      ['outputTokens', row.outputTokens], ['cachedInputTokens', read], ['totalTokens', row.totalTokens]];
    for (const [key, value] of values) {
      if (!count(value)) { usage.tokensComplete = false; continue; }
      const total = usage[key] === null ? null : usage[key] + value;
      if (!count(total)) { usage[key] = null; usage.tokensComplete = false; }
      else usage[key] = total;
    }
  }
  return usage;
}
module.exports = { settledUsage };
