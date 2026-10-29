// Reuse the existing synthetic transport; current-turn metadata is supplied
// independently of tool completion, just as it is by the native runtime.
require('./collaboration-overview.cjs');
const path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { NativeHost } = require(path.join(root, 'app/adapters.cjs'));
const create = NativeHost.prototype.create, runtimes = new Map();
NativeHost.prototype.create = function (record) {
  const runtime = create.call(this, record); runtimes.set(record.id, runtime); return runtime;
};
// The existing listener owns the single reply. This listener only supplies
// fixture-native control facts before that reply, without touching a provider.
process.prependListener('message', packet => {
  if (packet.method !== 'processTurn') return;
  const runtime = runtimes.get(packet.target); if (!runtime) return;
  runtime.turnId = packet.value.turnId;
  runtime.emit('state', packet.value.state);
});
