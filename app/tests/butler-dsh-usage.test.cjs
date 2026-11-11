const test = require('node:test'), assert = require('node:assert/strict');
const { settledUsage } = require('../butler-dsh-usage.cjs');
test('a later failed request retains settled tokens and marks the missing part unknown', () => {
  const value = settledUsage([{ inputTokens: 9, outputTokens: 2, totalTokens: 16, cacheReadTokens: 3, cacheWriteTokens: 2 }], 2);
  assert.equal(value.inputTokens, 14); assert.equal(value.outputTokens, 2); assert.equal(value.totalTokens, 16);
  assert.equal(value.cachedInputTokens, 3); assert.equal(value.tokensComplete, false); assert.equal(value.costMicros, null);
});
test('refusal before the next transmission preserves a complete token count for prior requests', () => {
  assert.equal(settledUsage([{ inputTokens: 9, outputTokens: 2, totalTokens: 11 }], 1).tokensComplete, true);
  assert.equal(settledUsage([], 0).totalTokens, 0);
  assert.equal(settledUsage([], 1).tokensComplete, false);
});
test('invalid and overflowing usage never erases other confirmed rows or claims complete counts', () => {
  const row = { inputTokens: 9, outputTokens: 2, totalTokens: 11 };
  const value = settledUsage([row, null, { ...row, cacheReadTokens: -1 }], 3);
  assert.equal(value.inputTokens, 18); assert.equal(value.tokensComplete, false);
  assert.equal(settledUsage([{ ...row, inputTokens: Number.MAX_SAFE_INTEGER }, row], 2).inputTokens, null);
});


test('one partially reported request keeps its known fields as lower bounds', () => {
  const value = settledUsage([{ inputTokens: 9 }], 1);
  assert.equal(value.inputTokens, 9); assert.equal(value.outputTokens, 0);
  assert.equal(value.tokensComplete, false); assert.equal(value.costMicros, null);
});
