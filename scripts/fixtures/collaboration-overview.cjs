// Reuse the real application transport fixture; count side-effect entry calls
// without changing their arguments, return values, guards or events.
require('./native-progress.cjs');
const path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
const { NativeHost } = require(path.join(root, 'app/adapters.cjs'));
const create = NativeHost.prototype.create;
NativeHost.prototype.create = function (record) {
  const runtime = create.call(this, record);
  if (process.env.NAW_T53_NATIVE_FALLBACK === '1' && record.provider === 'codex') runtime.nativeInputRequired = true;
  return runtime;
};
const calls = Object.create(null);
for (const method of ['claim', 'terminal', 'terminalSnapshot', 'input', 'send', 'queue', 'steer', 'forward', 'approve', 'answer', 'run', 'resume', 'pause']) {
  const original = Workspace.prototype[method];
  if (typeof original !== 'function') continue;
  calls[method] = 0;
  Workspace.prototype[method] = function (...args) { calls[method]++; return original.apply(this, args); };
}
const send = process.send;
process.send = function (message, ...args) {
  if (message?.stats) message.overviewCalls = { ...calls };
  return send.call(this, message, ...args);
};
