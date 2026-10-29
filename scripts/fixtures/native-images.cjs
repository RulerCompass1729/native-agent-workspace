// Original Codex item receiver on the existing isolated service transport.
// No provider process, file upload, model call or native configuration change.
require('./collaboration-overview.cjs');
const path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { NativeHost, Codex } = require(path.join(root, 'app/adapters.cjs'));
const create = NativeHost.prototype.create, runtimes = new Map();
NativeHost.prototype.create = function (record) {
  const fake = create.call(this, record), runtime = new Codex(record, this);
  fake.emit = (...args) => runtime.emit(...args);
  for (const name of ['terminal', 'start', 'stop', 'openTerminal']) runtime[name] = fake[name];
  runtime.send = async (text, tag) => {
    runtime.ownInputs.add(tag); await fake.send(text, tag);
    if (fake.lastSend) runtime.turn(fake.lastSend.turnId).inputTag = tag;
  };
  runtimes.set(record.id, runtime); return runtime;
};
process.prependListener('message', packet => {
  if (packet.method !== 'nativeImageEvent') return;
  const runtime = runtimes.get(packet.target); if (!runtime) throw Error('Unknown image fixture receiver');
  if (packet.value.cwd) runtime.nativeSettings = { cwd: packet.value.cwd };
  runtime.event({ method: packet.value.method, params: { threadId: runtime.record.nativeId,
    turnId: 'image-turn', ...packet.value.params } });
});
