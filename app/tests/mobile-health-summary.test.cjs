const test = require('node:test'), assert = require('node:assert/strict');
const { healthSummary } = require('../mobile-workspace.cjs');
test('phone health uses the producer capability and fixed reasons, never error or token text', () => {
  const reasons = ['busy', 'usage-limit-exceeded'];
  const blocked = { on: true, failed: false, blocked: { reason: 'busy', minutes: 12, private: 'PRIVATE_BODY_TOKEN_PATH' } };
  assert.deepEqual(healthSummary(blocked, reasons), { available: true, alerts: [{ code: 'steward-wake-stalled' }] });
  assert.deepEqual(healthSummary({ on: true, failed: false }, reasons), { available: true, alerts: [] });
  for (const [wake, known] of [[blocked, undefined], [null, reasons], [{ ...blocked, failed: true }, reasons],
    [{ ...blocked, blocked: { reason: 'PRIVATE_BODY_TOKEN_PATH' } }, reasons]])
    assert.deepEqual(healthSummary(wake, known), { available: false, alerts: [] });
});
