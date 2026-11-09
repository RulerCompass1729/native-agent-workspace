// Isolated desktop regression for space queues: replace only the provider transport,
// never spawn a native agent or call a model. Each send is accepted at once and the
// turn stays "working" until the runner releases that session with a reply.
const { EventEmitter } = require('node:events');
const path = require('node:path');
const appRoot = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { NativeHost } = require(path.join(appRoot, 'app/adapters.cjs'));

const sends = [];
const turns = new Map();
const runtimes = new Map();

NativeHost.prototype.start = async function () {
  this.binaries = { claude: 'fixture', codex: 'fixture', python: 'fixture' };
};
NativeHost.prototype.close = function () {};
NativeHost.prototype.create = function (record) {
  const runtime = new EventEmitter();
  runtime.chatAvailable = true;
  runtime.start = async () => {
    // Like a native CLI: it reports the model it was started with, else its default.
    let model = 'fixture-model';
    if (record.requestedSettings && record.requestedSettings.model) {
      model = record.requestedSettings.model;
    }
    runtime.emit('model', model);
    runtime.emit('state', 'idle');
  };
  runtime.stop = async () => {
    turns.delete(record.id);
    return { state: 'ended' };
  };
  runtime.send = (text, tag, guard) => new Promise((resolve, reject) => {
    if (!guard()) {
      reject(new Error('Synthetic acceptance refused'));
      return;
    }
    sends.push({ id: record.id, text });
    turns.set(record.id, tag);
    runtime.emit('submitted', tag);
    resolve();
    runtime.emit('state', 'working');
  });
  runtimes.set(record.id, runtime);
  return runtime;
};

function release(id, reply) {
  const runtime = runtimes.get(id);
  const tag = turns.get(id);
  if (!runtime || !tag) {
    return false;
  }
  turns.delete(id);
  runtime.emit('background', { count: 0, scheduled: 0, kinds: [], ids: [] });
  runtime.emit('state', 'idle');
  runtime.emit('complete', { tag, text: reply });
  return true;
}

process.on('message', request => {
  let released = null;
  if (request.method === 'release') {
    released = release(request.session, request.reply);
  }
  const working = [];
  for (const id of turns.keys()) {
    working.push(id);
  }
  process.send({ requestId: request.id, released, working, sends: sends.map(({ id, text }) => ({ id, text })) });
});
