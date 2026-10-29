// Existing actual Codex adapter + synthetic transport, with explicit typed tool
// intent injection. Never boot a provider, contact an API or inspect user data.
require('./daily-native.cjs');
const path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
const { NativeHost } = require(path.join(root, 'app/adapters.cjs'));
const bindings = new Map(), bind = Workspace.prototype.bind, create = NativeHost.prototype.create;
Workspace.prototype.bind = function (s, r) { bind.call(this, s, r); bindings.set(s.id, { w: this, r }); };
NativeHost.prototype.create = function (record) {
  const previousRpc = this.rpc;
  const r = create.call(this, record); r.addressedSendAvailable = true;
  if (previousRpc && record.provider === 'codex') this.rpc = previousRpc;
  if (this.rpc && !this.rpc.wakeFixture) {
    const call = this.rpc.call.bind(this.rpc); this.rpc.wakeFixture = true;
    this.rpc.call = async (method, args) => method === 'thread/goal/get' ? { goal: null } : call(method, args);
  }
  return r;
};
process.on('message', async q => {
  if (q.method !== 'wakeIntent') return;
  try {
    const { r } = bindings.get(q.target);
    const result = await r.addressedCall({ nativeId: r.record.nativeId, turnId: r.turnId, callId: q.value.callId }, { recipient_id: q.value.recipientId, message: q.value.body });
    process.send({ requestId: q.wakeRequestId, wakeResult: result });
  } catch (error) { process.send({ requestId: q.wakeRequestId, wakeError: error.message }); }
});
