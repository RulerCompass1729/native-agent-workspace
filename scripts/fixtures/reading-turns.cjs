// Existing owned synthetic transport; only display records are projected.
require('./process-groups.cjs');
const path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
const snapshot = Workspace.prototype.snapshot, projections = new Map(); let workspace;
Workspace.prototype.snapshot = function () {
  workspace = this; const state = snapshot.call(this);
  state.sessions = state.sessions.map(s => projections.has(s.id) ? { ...s, messages: projections.get(s.id) } : s);
  return state;
};
process.on('message', q => {
  if (q.method !== 'readingProjection') return;
  if (!workspace?.sessions.has(q.target) || !Array.isArray(q.value)) return process.send?.({ requestId:q.id,error:'Unknown owned reading projection' });
  projections.set(q.target, q.value); workspace.changed();
});
