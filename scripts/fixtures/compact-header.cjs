// Extend the existing synthetic transport, never a real provider. These explicit
// native facts and counters exercise layout without model turns or native input.
require('./loading-terminal.cjs');
const path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { NativeHost } = require(path.join(root, 'app/adapters.cjs'));
const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
const create = NativeHost.prototype.create, runtimes = new Map(), calls = {};
NativeHost.prototype.create = function (record) {
  const runtime = create.call(this, record); runtimes.set(record.id, runtime); return runtime;
};
for (const method of ['claim', 'send', 'forward', 'resume', 'pause', 'join']) {
  const original = Workspace.prototype[method]; calls[method] = 0;
  Workspace.prototype[method] = function (...args) { calls[method]++; return original.apply(this, args); };
}
let collision;
const snapshot = Workspace.prototype.snapshot;
Workspace.prototype.snapshot = function () {
  const value = snapshot.call(this);
  if (collision) value.sessions.push({ ...collision, archived: true, messages: [], state: 'ended', owner: null });
  return value;
};
process.prependListener('message', q => {
  const runtime = runtimes.get(q.target);
  if (q.method === 'header-facts') {
    for (const key of ['model', 'activity']) if (key in q.value) runtime.record[key] = q.value[key];
    if ('nativeSettings' in q.value) runtime.nativeSettings = q.value.nativeSettings && { ...q.value.nativeSettings, nativeId: runtime.record.nativeId };
    runtime.emit('capability');
  }
  if (q.method === 'header-collision') {
    collision = { ...runtime.record, id: q.target.slice(0, 6) + (q.target[6] === 'a' ? 'b' : 'a') + '-synthetic-collision', name: 'Synthetic collision', roomId: null };
    runtime.emit('capability');
  }
});
const send = process.send;
process.send = function (message, ...args) {
  if (message?.requestId) { message.headerCalls = { ...calls }; message.headerRuntimeIds = [...runtimes.keys()]; }
  return send.call(this, message, ...args);
};
