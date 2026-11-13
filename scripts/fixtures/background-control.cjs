// Synthetic native producer only: the app, MCP helper, authenticated broker,
// original-runtime proof, shared application handler and durable store are real.
require('./daily-native.cjs');
const path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
const { NativeHost } = require(path.join(root, 'app/adapters.cjs'));
const create = NativeHost.prototype.create;
// holdQueue: the next queued input waits for releaseQueue before native takes it (a turn still running).
let holdNext = false, releaseHeld = null;
NativeHost.prototype.create = function (record) {
  const runtime = create.call(this, record);
  if (record.provider === 'claude') {
    runtime.queueAvailable = true;
    runtime.queue = async (text, tag, valid) => {
      if (!valid()) throw Error('Synthetic queue is stale');
      if (holdNext) { holdNext = false; await new Promise(resolve => { releaseHeld = resolve; }); }
      else await new Promise(resolve => setTimeout(resolve, 25));
      if (!valid()) throw Error('Synthetic queue changed before native pickup');
      runtime.emit('submitted', tag);
    };
  }
  return runtime;
};
const bind = Workspace.prototype.bind, sessions = new Map();
Workspace.prototype.bind = function (record, runtime) {
  bind.call(this, record, runtime); sessions.set(record.id, { runtime, record });
};
process.on('message', request => {
  if (request.method === 'holdQueue') { holdNext = true; process.send({ requestId: request.id }); return; }
  if (request.method === 'releaseQueue') { const release = releaseHeld; releaseHeld = null; release?.(); process.send({ requestId: request.id, released: Boolean(release) }); return; }
  // A Claude session's hook reports its background work when a turn ends; until then NAW treats it as unknown
  // and sends it nothing (queue-dispatch.cjs readiness). This reports none, as queue-native.cjs release does.
  if (request.method === 'backgroundReport') { sessions.get(request.target).runtime.emit('background', { count: 0, scheduled: 0, kinds: [], ids: [] }); return; }
  if (request.method === 'backgroundComplete') {
    const { runtime, record } = sessions.get(request.target);
    runtime.event({ method: 'item/completed', params: { threadId: record.nativeId, turnId: runtime.turnId,
      item: { id: request.value.callId, type: 'mcpToolCall', server: 'native_workspace', tool: 'workspace_control', arguments: request.value.arguments, status: 'completed' } } });
    return;
  }
  if (request.method !== 'backgroundProof') return;
  try {
    const { runtime, record } = sessions.get(request.target);
    runtime.nativeSessionId = 'fixture-native-session';
    runtime.event({ method: 'turn/started', params: { threadId: record.nativeId, turn: { id: 'fixture-control-turn' } } });
    runtime.event({ method: 'item/started', params: { threadId: record.nativeId, turnId: 'fixture-control-turn',
      item: { id: request.value.callId, type: 'mcpToolCall', server: 'native_workspace', tool: 'workspace_control', arguments: request.value.arguments, status: 'inProgress' } } });
    process.send({ proofRequestId: request.id, nativeId: record.nativeId, sessionId: runtime.nativeSessionId, turnId: runtime.turnId, callId: request.value.callId });
  } catch (error) { process.send({ proofRequestId: request.id, error: error.message }); }
});
