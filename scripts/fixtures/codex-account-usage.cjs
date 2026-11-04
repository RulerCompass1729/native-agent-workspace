// Owned synthetic native metadata through the actual connection watcher; no provider.
require('./loading-terminal.cjs');
const path = require('node:path'), { EventEmitter } = require('node:events');
const code = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { NativeHost } = require(path.join(code, 'app/adapters.cjs'));
const create = NativeHost.prototype.create, runtimes = new Map(), connections = new Set();
let reads = 0;
NativeHost.prototype.create = function (record) {
  const r = create.call(this, record); r.host = this; runtimes.set(record.id, r);
  const stop = r.stop; r.stop = async () => { r.stopped = true; return stop(); };
  r.transportClosed = () => { r.transportDisconnected = true; r.emit('capability'); };
  if (record.provider === 'codex') {
    this.codexTargets.set(record.nativeId, r);
    if (!this.quotaFixture) {
      const rpc = new EventEmitter(), child = new EventEmitter(); rpc.ws = { readyState: 1 }; rpc.nativeVersion = '0.164.0';
      child.exitCode = null; child.signalCode = null;
      const state = this.quotaFixture = { host: this, rpc, child, baseline: null };
      rpc.call = async method => { if (method !== 'account/rateLimits/read') throw Error('Unexpected synthetic native request'); reads++; return { rateLimits: state.baseline }; };
      this.codexProcess = child; state.watcher = this.watchCodexConnection(rpc, child); state.watcher.activate(); connections.add(state);
    }
  }
  return r;
};
process.prependListener('message', q => {
  const r = runtimes.get(q.target), state = r?.host?.quotaFixture;
  if (q.method === 'quota-update') state.rpc.emit('event', { method: 'account/rateLimits/updated', params: { rateLimits: q.value } });
  if (q.method === 'quota-account-change') { state.baseline = null; state.rpc.emit('event', { method: 'account/updated', params: { authMode: 'chatgpt', planType: 'pro' } }); }
  if (q.method === 'quota-token') r.emit('usage', q.value);
  if (q.method === 'context-pending') { r.emit('contextEnd', { nativeId: r.record.nativeId, reason: 'clear' }); r.emit('state', 'stopping'); }
  if (q.method === 'quota-finish') for (const f of connections) { f.watcher.dispose(); f.child.exitCode = 0; f.rpc.ws.readyState = 3; f.host.codexProcess = null; f.host.rpc = null; }
});
const send = process.send;
process.send = function (message, ...args) { if (message?.requestId) message.accountReads = reads; return send.call(this, message, ...args); };
