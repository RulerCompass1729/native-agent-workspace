// Reuse the existing delayed synthetic transport. No provider or model starts.
require('./delayed-native.cjs');
const path = require('node:path');
const { NativeHost } = require(path.join(process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..'), 'app/adapters.cjs'));
const create = NativeHost.prototype.create, runtimes = new Map(), queues = [];
NativeHost.prototype.create = function (record) {
  const runtime = create.call(this, record); record.nativeId = 'synthetic-' + record.id;
  runtime.queueAvailable = record.provider === 'claude';
  runtime.queue = (text, tag, guard) => new Promise((resolve, reject) => {
    if (!guard()) return reject(Object.assign(Error('Synthetic queue refused before send'), { notSent: true }));
    queues.push({ id: record.id, text, tag, settle(fail) {
      if (fail || !guard()) reject(Object.assign(Error('Synthetic queue refused before send'), { notSent: true }));
      else { runtime.emit('submitted', tag); resolve(); }
      runtime.emit('state', 'idle');
    } });
  });
  runtimes.set(record.id, runtime); return runtime;
};
process.on('message', request => {
  if (request.method !== 'mentionControl') return;
  try {
    if (request.action === 'state') runtimes.get(request.target).emit('state', request.value);
    if (request.action === 'settleQueue') {
      const queue = queues.findLast(q => q.id === request.target); if (!queue) throw Error('No owned queued input'); queue.settle(request.value);
    }
    process.send({ controlId: request.controlId, queues: queues.map(({ id, text, tag }) => ({ id, text, tag })), modelCalls: 0, nativeProviderProcesses: 0 });
  } catch (error) { process.send({ controlId: request.controlId, error: error.message }); }
});
