// Actual adapter/workspace with only turn/steer acknowledgement held locally.
// Reuse the existing synthetic transport and bounded recovery-clock hook.
require('./routing-recovery.cjs');
const path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { NativeHost } = require(path.join(root, 'app/adapters.cjs'));
const create = NativeHost.prototype.create, held = new Map(), runtimes = new Map(), calls = [];
NativeHost.prototype.create = function (...args) {
  const runtime = create.apply(this, args), call = this.rpc.call;
  runtimes.set(runtime.record.nativeId, runtime);
  this.rpc.call = (method, params) => {
    if (method !== 'turn/steer') return call(method, params);
    const target = runtimes.get(params.threadId);
    if (!target || held.has(target.record.id)) throw Error('Unexpected synthetic steer');
    calls.push({ id: target.record.id, text: params.input[0].text, turnId: params.expectedTurnId });
    target.event({ method: 'item/completed', params: { threadId: params.threadId, turnId: params.expectedTurnId, item: { id: params.clientUserMessageId, type: 'userMessage', clientId: params.clientUserMessageId, content: params.input } } });
    return new Promise((resolve, reject) => held.set(target.record.id, { resolve, reject, turnId: params.expectedTurnId }));
  };
  return runtime;
};
process.on('message', q => {
  if (!['steerStats', 'settleSteer'].includes(q.method)) return;
  if (q.method === 'settleSteer') {
    const receipt = held.get(q.target); if (!receipt) throw Error('No exact synthetic steer receipt'); held.delete(q.target);
    if (q.rejected) receipt.reject(Error('Synthetic native steer acknowledgement lost'));
    else receipt.resolve({ turnId: receipt.turnId });
  }
  process.send?.({ requestId: q.id, steerFixture: true, held: [...held.keys()], calls });
});
