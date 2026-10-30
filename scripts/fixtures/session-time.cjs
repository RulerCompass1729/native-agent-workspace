// Existing synthetic native host; project only old/new timestamp payloads.
require('./native-progress.cjs');
const path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
const original = Workspace.prototype.snapshot, projections = new Map();
let current;
Workspace.prototype.snapshot = function () {
  current = this; const state = original.call(this);
  state.sessions = state.sessions.map(s => {
    const projection = projections.get(s.id); if (!projection) return s;
    delete s.createdAt; delete s.lastActivityAt;
    return { ...s, ...projection };
  });
  return state;
};
process.on('message', q => {
  if (q.method !== 'timeProjection') return;
  if (!current?.sessions.has(q.target)) return process.send?.({ timeRequestId: q.timeRequestId, error: 'Unknown owned fixture session' });
  projections.set(q.target, q.value); current.changed();
  process.send?.({ timeRequestId: q.timeRequestId });
});
