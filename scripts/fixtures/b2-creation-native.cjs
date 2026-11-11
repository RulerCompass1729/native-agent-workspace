// B2 uses the existing synthetic queue transport. The only extra control holds
// one named successor after Workspace persisted and prepared its worktree.
// A UI restart reconnects to the same service and must adopt that same nonce.
require('./queue-native.cjs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { NativeHost } = require(path.join(root, 'app/adapters.cjs'));
const create = NativeHost.prototype.create;
const creations = [], held = new Map(), names = new Set(), inputs = [];

NativeHost.prototype.create = function (record) {
  if (!record.nativeId) record.nativeId = randomUUID();
  const runtime = create.call(this, record), start = runtime.start;
  creations.push({ id: record.id, name: record.name, cwd: record.cwd, nonce: record.worktreePreparation?.nonce || null });
  runtime.start = async () => {
    if (names.delete(record.name)) await new Promise(resolve => held.set(record.id, resolve));
    return start();
  };
  // A restored UI may mount the retained terminal before selecting chat.
  runtime.terminal = { alive: true, resize() {}, input(data) { inputs.push({ id: record.id, data }); },
    snapshot: async () => ({ buffer: 'Synthetic B2 terminal\r\n> ', sequence: 0, cols: 100, rows: 30 }) };
  runtime.openTerminal = async () => runtime.terminal;
  return runtime;
};

process.on('message', request => {
  if (!['b2HoldStart', 'b2ReleaseStart', 'b2ReleaseAll', 'b2Stats'].includes(request.method)) return;
  if (request.method === 'b2HoldStart') names.add(request.name);
  let released = false;
  if (request.method === 'b2ReleaseStart') {
    const resolve = held.get(request.session);
    if (resolve) { held.delete(request.session); resolve(); released = true; }
  }
  if (request.method === 'b2ReleaseAll') {
    for (const resolve of held.values()) resolve();
    held.clear(); names.clear();
  }
  process.send({ requestId: request.id, fixture: 'b2-creation', released, held: [...held.keys()], creations, inputs, providerProcesses: 0, modelCalls: 0 });
});
