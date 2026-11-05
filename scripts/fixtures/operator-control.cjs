// Test-only root calls on the existing synthetic host, never a native provider.
require('./daily-native.cjs');
const path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { NativeHost } = require(path.join(root, 'app/adapters.cjs'));
const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
const create = NativeHost.prototype.create, bind = Workspace.prototype.bind, sessions = new Map();
NativeHost.prototype.create = function (record) {
  const runtime = create.call(this, record); runtime.operatorAvailable = record.provider === 'claude';
  record.nativePermissionMode = 'default';
  runtime.liveTurn = { id: 'synthetic-turn-' + record.id, promptId: 'synthetic-prompt-' + record.id };
  const start = runtime.start; runtime.start = async () => { await start(); runtime.emit('model', 'synthetic-native-default'); };
  return runtime;
};
Workspace.prototype.bind = function (record, runtime) { bind.call(this, record, runtime); sessions.set(record.id, { workspace: this, runtime, record }); };
process.on('message', async request => {
  if (request.method !== 'operatorCall') return;
  try {
    const { runtime, record } = sessions.get(request.target);
    const result = await runtime.operatorCall({ nativeId: record.nativeId, turnId: runtime.liveTurn.id, promptId: runtime.liveTurn.promptId, callId: request.value.callId }, request.value.name, request.value.arguments);
    process.send({ operatorRequestId: request.operatorRequestId, result });
  } catch (error) { process.send({ operatorRequestId: request.operatorRequestId, error: error.message }); }
});
