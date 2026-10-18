// Isolated desktop regression: replace only the provider transport, never spawn
// a native agent or connect to a model. The runner controls acceptance timing.
const { EventEmitter } = require('node:events');
const { NativeHost } = require('../../app/adapters.cjs');
const sends = [];
NativeHost.prototype.start = async function () { this.binaries = { claude: 'fixture', codex: 'fixture', python: 'fixture' }; };
NativeHost.prototype.close = function () {};
NativeHost.prototype.create = function (record) {
  const runtime = new EventEmitter(); runtime.chatAvailable = true;
  runtime.start = async () => runtime.emit('state', 'idle');
  runtime.stop = async () => ({ state: 'ended' });
  runtime.send = (text, tag, guard) => new Promise((resolve, reject) => {
    sends.push({ id: record.id, text, settle(fail) {
      if (fail || !guard()) { reject(new Error('Synthetic acceptance failure')); return; }
      runtime.emit('submitted', tag); resolve();
      runtime.emit('state', 'idle'); runtime.emit('complete', { tag, text: '' });
    } });
  });
  return runtime;
};
process.on('message', request => {
  if (request.method === 'release') sends.at(-1).settle(request.fail);
  process.send({ requestId: request.id, sends: sends.map(({ id, text }) => ({ id, text })) });
});
