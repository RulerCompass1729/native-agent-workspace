const path = require('node:path'), { randomUUID } = require('node:crypto');
const root = process.env.NAW_TEST_APP_ROOT;
const { NativeHost, Codex } = require(path.join(root, 'app/adapters.cjs'));
const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
const runtimes = new Map(); let workspace, nativeWrites = 0;
NativeHost.prototype.start = async function () {
  this.binaries = { codex: 'synthetic', python: 'synthetic' };
  this.rpc = { connected: true, async call() { nativeWrites++; throw Error('No provider RPC is allowed'); } };
};
NativeHost.prototype.resolvePrograms = function () {};
NativeHost.prototype.close = function () {};
NativeHost.prototype.create = function (record) {
  record.nativeId = randomUUID(); record.pid = process.pid;
  const r = new Codex(record, this); r.nativeSessionId = 'synthetic-session'; r.needsSubscription = false;
  r.start = async () => { r.chatAvailable = true; r.emit('state', 'idle'); };
  r.stop = async () => { r.stopped = true; };
  runtimes.set(record.id, r); return r;
};
const bind = Workspace.prototype.bind;
Workspace.prototype.bind = function (...args) { workspace = this; return bind.apply(this, args); };
process.on('message', q => {
  if (!q.isolation) return;
  try {
    const r = runtimes.get(q.session);
    if (q.action === 'arm') {
      const identity = { provider: 'codex', nativeId: r.record.nativeId, sessionId: r.nativeSessionId, turnId: 'synthetic-turn', callId: randomUUID() };
      r.event({ method: 'turn/started', params: { threadId: identity.nativeId, turn: { id: identity.turnId } } }, r.host.rpc);
      r.event({ method: 'item/started', params: { threadId: identity.nativeId, turnId: identity.turnId, item: { id: identity.callId, type: 'mcpToolCall', server: 'native_workspace', tool: 'workspace_control', arguments: { action: 'catalog' }, status: 'inProgress' } } }, r.host.rpc);
      process.send({ isolation: q.isolation, identity });
    } else if (q.action === 'patch') {
      Object.assign(r.record, q.patch); workspace.changed(r.record.id); process.send({ isolation: q.isolation });
    } else process.send({ isolation: q.isolation, nativeWrites });
  } catch (e) { process.send({ isolation: q.isolation, failure: e.message }); }
});
