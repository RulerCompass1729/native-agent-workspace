// Synthetic observation of the baseline's current model/effort; no provider starts.
// What the window shows of a member (nativeEffort, the model event) is there from its start. What a native report leaves
// (adapters.cjs observeCreationSetting, which standing creation is compared with) comes only with `observeSettings`,
// kept and read by the adapter's own methods.
require('./background-control.cjs');
const path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { NativeHost, Claude } = require(path.join(root, 'app/adapters.cjs'));
const create = NativeHost.prototype.create, observers = new Map();
NativeHost.prototype.create = function(record) {
  const runtime = create.call(this, record), start = runtime.start;
  if (record.provider === 'claude') {
    const observer = { record, ready: true, rootLease: 'synthetic-lease', observationEpoch: 'synthetic-epoch', get terminal() { return runtime.terminal; } };
    runtime.creationSettingsSnapshot = () => Claude.prototype.creationSettingsSnapshot.call(observer);
    observers.set(record.id, observer);
    runtime.start = async function(...args) {
      await start.apply(this, args);
      record.nativeEffort = 'low';
      runtime.emit('model', 'synthetic-model-a'); runtime.emit('capability');
    };
  }
  return runtime;
};
process.on('message', request => {
  if (request.method !== 'observeSettings') return;
  for (const [name, value] of Object.entries(request.value)) Claude.prototype.observeCreationSetting.call(observers.get(request.target), name, value);
});
