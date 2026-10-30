// Real service/IPC; only the provider is synthetic. Record the exact target of
// native input rather than inferring delivery from an acknowledgement.
require('./collaboration-overview.cjs');
const path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { NativeHost } = require(path.join(root, 'app/adapters.cjs'));
const create = NativeHost.prototype.create, calls = [], queues = [], runtimes = new Map();
NativeHost.prototype.create = function(record) {
  const runtime = create.call(this, record), input = runtime.terminal.input;
  runtime.terminal.journal = runtime.journal;
  const snapshot = runtime.terminal.snapshot;
  runtime.terminal.snapshot = async function() { return { ...await snapshot.apply(this, arguments), epoch: runtime.journal.epoch }; };
  runtime.terminal.input = function(data) {
    calls.push({ id:record.id, nativeId:record.nativeId, data });
    const result = input.apply(this, arguments);
    runtime.screen.write(data, () => { const event = runtime.journal.append('output', data, runtime.screen.cols, runtime.screen.rows, () => runtime.serializer.serialize()); runtime.emit('terminal', { ...event, receivedAt: Date.now(), sequence: ++runtime.sequence }); }); return result;
  };
  runtimes.set(record.id,runtime); return runtime;
};
const send = process.send;
process.send = function(message, ...args) { if (message?.stats) { message.columnInputs = [...calls]; message.columnQueues = [...queues]; message.waitingColumnQueues = [...runtimes].filter(([,r])=>r.waitingColumnQueue).map(([id])=>id); } return send.call(this, message, ...args); };

process.on('message', q => {
  const runtime=runtimes.get(q.target);
  if(q.method==='columnQueue') {
    runtime.queueAvailable=true;
    runtime.queue=(text,tag,guard)=>new Promise((resolve,reject)=>{queues.push({id:q.target,text,tag});runtime.waitingColumnQueue={resolve,reject,guard};});
    runtime.emit('state','working');
  }
  if(q.method==='columnRejectQueue') {
    runtime.waitingColumnQueue?.reject(Object.assign(new Error('Synthetic queue was not sent'),{notSent:true}));runtime.waitingColumnQueue=null;
  }
});
