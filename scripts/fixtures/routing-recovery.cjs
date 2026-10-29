// Real Codex adapter/workspace, synthetic transport; no provider processes.
require('./daily-native.cjs');
const path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { NativeHost } = require(path.join(root, 'app/adapters.cjs'));
const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
const create = NativeHost.prototype.create, pending = new Map();
NativeHost.prototype.create = function (...args) {
  const runtime = create.apply(this, args), call = this.rpc.call;
  this.rpc.nativeVersion = '0.165.0';
  this.rpc.call = (method, params) => method === 'thread/goal/get' ? Promise.resolve({ goal: null }) : call(method, params);
  return runtime;
};
const schedule = Workspace.prototype.scheduleCapacity;
Workspace.prototype.scheduleCapacity = function (session, ...args) {
  const result = schedule.call(this, session, ...args); pending.set(session.id, this); return result;
};
process.on('message', q => {
  if (q.method !== 'advanceRecovery') return;
  const workspace = pending.get(q.target), recovery = workspace?.capacityRecoveries.get(q.target);
  // Advance only the existing scheduled clock. Production preflight/dispatch
  // and all identity, goal and human-control checks still run normally.
  if (recovery?.status === 'scheduled') recovery.due = Date.now();
  process.send?.({ requestId: q.id, advanced: recovery?.status === 'scheduled' });
});
