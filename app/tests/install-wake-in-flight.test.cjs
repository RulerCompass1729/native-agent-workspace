'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createInspector } = require('../../scripts/install-runtime.cjs');

const KEY = 'backends/synthetic0000000000000';
const OLD_TURN = 'turn-old';
const CURRENT_TURN = 'turn-current';

// A release root whose service modules return one synthetic backend; the busy rule is the real one.
function release(root, state) {
  const app = path.join(root, 'release', 'app');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify(state));
  const statePath = JSON.stringify(path.join(root, 'state.json'));
  const fingerprintPath = JSON.stringify(path.resolve(__dirname, '../background-fingerprint.cjs'));
  fs.writeFileSync(path.join(app, 'service-connection.cjs'), `module.exports = {
    connectService: async () => ({
      socket: { destroy() {} },
      call: async () => JSON.parse(require('node:fs').readFileSync(${statePath}, 'utf8')),
      close() {},
    }),
  };`);
  fs.writeFileSync(path.join(app, 'service-layout.cjs'), `module.exports = { readLayout: () => ({ entries: ['${KEY}'], active: '${KEY}' }) };`);
  fs.writeFileSync(path.join(app, 'backend-switch.cjs'), 'module.exports = { readSettings: () => ({ auto: false }) };');
  fs.writeFileSync(path.join(app, 'platform.cjs'), `module.exports = {
    processIdentity: pid => ({ pid, started: 'synthetic' }),
    processMayBeAlive: () => false,
  };`);
  fs.writeFileSync(path.join(app, 'background-fingerprint.cjs'), `module.exports = require(${fingerprintPath});`);
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'views.json'), '[]');
  return { data, resultDir: path.join(root, 'result'), newVersion: '0.1.0-alpha.999', release: path.join(root, 'release') };
}

function wakeRow(id, status, turnId, senderId) {
  return { id, role: 'system', kind: 'notice', status: 'complete', wake: { id, nativeId: 'native-' + senderId, turnId, senderId, status } };
}

function backendState(sender, row) {
  const recipient = { id: 'recipient', nativeId: 'native-recipient', state: 'idle', messages: [] };
  return {
    servicePid: 4242, runtimeVersion: '0.1.0-alpha.998', capabilities: [], peerLeases: [],
    room: { messages: [] }, rooms: [],
    sessions: [{ nativeId: 'native-' + sender.id, messages: [row], ...sender }, recipient],
  };
}

async function capture(state) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-wake-gate-'));
  try {
    return await createInspector(release(root, state), { run: () => '' }).capture();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const IN_FLIGHT = /No automatic message in flight: backends\/synthetic/;

test('staged wake of a working sender in its current turn still blocks', async () => {
  const sender = { id: 'sender', state: 'working', activeTurnId: CURRENT_TURN };
  await assert.rejects(capture(backendState(sender, wakeRow('w1', 'staged', CURRENT_TURN, 'sender'))), IN_FLIGHT);
});

test('staged wake of an idle sender from an older turn passes and is listed in the capture', async () => {
  const sender = { id: 'sender', state: 'idle', activeTurnId: null };
  const result = await capture(backendState(sender, wakeRow('w2', 'staged', OLD_TURN, 'sender')));
  assert.deepEqual(result.state.staleWakes, [{
    backend: KEY, id: 'w2', sender: 'sender', turnId: OLD_TURN,
    reason: 'staged; sender idle and the wake turn is not its current turn',
  }]);
});

test('staged wake stays blocked while the sender has queued input (shared busy rule)', async () => {
  const sender = { id: 'sender', state: 'idle', activeTurnId: null, pendingQueue: { id: 'q' } };
  await assert.rejects(capture(backendState(sender, wakeRow('w3', 'staged', OLD_TURN, 'sender'))), IN_FLIGHT);
});

test('sending wake blocks even when the sender is idle', async () => {
  const sender = { id: 'sender', state: 'idle', activeTurnId: null };
  await assert.rejects(capture(backendState(sender, wakeRow('w4', 'sending', OLD_TURN, 'sender'))), IN_FLIGHT);
});

test('held wake blocks: the butler limit timer can still send it', async () => {
  const sender = { id: 'sender', state: 'idle', activeTurnId: null };
  await assert.rejects(capture(backendState(sender, wakeRow('w5', 'held', OLD_TURN, 'sender'))), IN_FLIGHT);
});

test('quiet backend records no stale wakes', async () => {
  const sender = { id: 'sender', state: 'idle', activeTurnId: null };
  const result = await capture(backendState(sender, wakeRow('w6', 'delivered', OLD_TURN, 'sender')));
  assert.deepEqual(result.state.staleWakes, []);
});
