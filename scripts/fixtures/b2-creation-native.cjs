// B2 uses the existing synthetic queue transport. The only extra control holds
// one named successor after Workspace persisted and prepared its worktree.
// A UI restart reconnects to the same service and must adopt that same nonce.
require('./queue-native.cjs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { NativeHost } = require(path.join(root, 'app/adapters.cjs'));
const { Terminal } = require(require.resolve('@xterm/headless', { paths: [root] }));
const create = NativeHost.prototype.create;
const creations = [], held = new Map(), names = new Set(), inputs = [];
const maintenanceStops = [];
const trustNames = new Set(), trust = new Map();

NativeHost.prototype.create = function (record) {
  if (!record.nativeId) record.nativeId = randomUUID();
  const runtime = create.call(this, record), start = runtime.start;
  runtime.stopForMaintenance = check => { check(); maintenanceStops.push(record.id); return runtime.stop(); };
  // The shared queue fixture's complete.text supplies Claude's final body.
  // Codex records its body through messageItem before the completion boundary.
  if (record.provider === 'codex') runtime.on('complete', info => {
    if (info.tag && info.text) runtime.emit('messageItem', { id: `b2-reply-${info.tag}`, text: info.text, inputTag: info.tag });
  });
  creations.push({ id: record.id, name: record.name, cwd: record.cwd, nonce: record.worktreePreparation?.nonce || null });
  runtime.start = async () => {
    if (names.delete(record.name)) await new Promise(resolve => held.set(record.id, resolve));
    if (trustNames.delete(record.name)) {
      const screen = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
      const text = record.provider === 'claude'
        ? 'Quick safety check:\r\nIs this a project you created or one you trust?\r\nNo, exit\r\nYes, I trust this folder\r\n'
        : 'Folder access\r\nTrust this folder?\r\n1. Trust and continue\r\n2. Back to Agent Command Center\r\n';
      await new Promise(resolve => screen.write(text, resolve));
      runtime.terminal.screen = screen;
      runtime.terminal.snapshot = async () => ({ buffer: text, sequence: 1, cols: 100, rows: 30 });
      trust.set(record.id, { runtime, start, screen });
      runtime.emit('state', 'starting'); runtime.emit('terminal', { data: text });
      return;
    }
    return start();
  };
  // A restored UI may mount the retained terminal before selecting chat.
  runtime.terminal = { alive: true, resize() {}, input(data) { inputs.push({ id: record.id, data }); },
    snapshot: async () => ({ buffer: 'Synthetic B2 terminal\r\n> ', sequence: 0, cols: 100, rows: 30 }) };
  runtime.openTerminal = async () => runtime.terminal;
  return runtime;
};

process.on('message', request => {
  if (!['b2HoldStart', 'b2ReleaseStart', 'b2TrustStart', 'b2TrustReady', 'b2ReleaseAll', 'b2Stats'].includes(request.method)) return;
  if (request.method === 'b2HoldStart') names.add(request.name);
  if (request.method === 'b2TrustStart') trustNames.add(request.name);
  let released = false;
  if (request.method === 'b2TrustReady') {
    const waiting = trust.get(request.session);
    if (waiting) {
      // The fixture models an independently observed ready event, never an input
      // or an accepted trust choice. No native provider is running here.
      trust.delete(request.session); delete waiting.runtime.terminal.screen;
      waiting.screen.dispose(); waiting.start(); released = true;
    }
  }
  if (request.method === 'b2ReleaseStart') {
    const resolve = held.get(request.session);
    if (resolve) { held.delete(request.session); resolve(); released = true; }
  }
  if (request.method === 'b2ReleaseAll') {
    for (const resolve of held.values()) resolve();
    held.clear(); names.clear();
    for (const waiting of trust.values()) waiting.screen.dispose();
    trust.clear(); trustNames.clear();
  }
  process.send({ requestId: request.id, fixture: 'b2-creation', released, held: [...held.keys()], trust: [...trust.keys()], creations, inputs, maintenanceStops, providerProcesses: 0, modelCalls: 0 });
});
