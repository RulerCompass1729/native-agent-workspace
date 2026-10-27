// Reuse the actual Codex adapter and daily UI fixture. No provider processes.
require('./daily-native.cjs');
const path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { NativeHost } = require(path.join(root, 'app/adapters.cjs'));
const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
const create = NativeHost.prototype.create;
NativeHost.prototype.create = function (...args) {
  const runtime = create.apply(this, args), call = this.rpc.call;
  this.rpc.nativeVersion = '0.164.0';
  this.rpc.call = (method, params) => method === 'thread/goal/get' ? Promise.resolve({ goal: null }) : call(method, params);
  return runtime;
};
const schedule = Workspace.prototype.scheduleCapacity;
Workspace.prototype.scheduleCapacity = function (...args) {
  const result = schedule.apply(this, args), recovery = this.capacityRecoveries.get(args[0].id);
  // Advance only the scheduled delay; existing timer, goal/control guards and
  // dispatch still execute normally. The real two-minute delay is not tested.
  if (recovery?.status === 'scheduled') recovery.due = Date.now() + 25;
  return result;
};
