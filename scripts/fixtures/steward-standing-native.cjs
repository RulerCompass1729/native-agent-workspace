// Synthetic observation of the baseline's current model/effort; no provider starts.
require('./background-control.cjs');
const path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { NativeHost } = require(path.join(root, 'app/adapters.cjs'));
const create = NativeHost.prototype.create;
NativeHost.prototype.create = function(record) {
  const runtime = create.call(this, record), start = runtime.start;
  if (record.provider === 'claude') runtime.start = async function(...args) {
    await start.apply(this, args);
    record.nativeEffort = 'low';
    runtime.emit('model', 'synthetic-model-a'); runtime.emit('capability');
  };
  return runtime;
};
