// Main's own person-action helpers, for tests that run other Main sections in a VM (alpha.285 wired them into
// bindClient, appMobileWorkspace and startQueueDispatcher). Before boot, personActions is null and both are no-ops.
const assert = require('node:assert/strict');
module.exports = function personActionsSource(main) {
  const start = main.indexOf('let personActions = null;');
  const end = main.indexOf("\n// The person's answers on agents' confirmation cards", start);
  assert.ok(start >= 0 && end > start, 'Actual person-action helpers exist in main.cjs');
  return main.slice(start, end);
};
