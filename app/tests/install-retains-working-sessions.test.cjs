'use strict';
// The daily installer compares backend captures across the old GUI's quit (scripts/install-daily.cjs). A session that
// keeps working stays on its old backend; alpha.284 rolled back only because one went from working to idle.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createInspector } = require('../../scripts/install-runtime.cjs');

const KEY = 'backends/synthetic0000000000000';

function release(root) {
  const app = path.join(root, 'release', 'app');
  fs.mkdirSync(app, { recursive: true });
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
  // The start time follows the pid, so a different pid reads as another process.
  fs.writeFileSync(path.join(app, 'platform.cjs'), `module.exports = {
    processIdentity: pid => ({ pid, started: 'synthetic-' + pid }),
    processMayBeAlive: () => false,
  };`);
  fs.writeFileSync(path.join(app, 'background-fingerprint.cjs'), `module.exports = require(${fingerprintPath});`);
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'views.json'), '[]');
  return { data, resultDir: path.join(root, 'result'), newVersion: '0.1.0-alpha.999', release: path.join(root, 'release') };
}

function session(extra) {
  return { id: 'worker', nativeId: 'native-worker', state: 'working', activeTurnId: 'turn-1', pid: 5001, model: 'synthetic', liveDraft: 'half a sentence', messages: [], ...extra };
}
function backend(sessions, roomMessages = 2) {
  return {
    servicePid: 4242, runtimeVersion: '0.1.0-alpha.998', capabilities: [], peerLeases: [],
    room: { messages: Array.from({ length: roomMessages }, (_, i) => ({ id: 'm' + i })) }, rooms: [], sessions,
  };
}

async function pair(t, before, after) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-install-retained-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inspector = createInspector(release(root), { run: () => '' });
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify(before));
  const first = await inspector.capture();
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify(after));
  const second = await inspector.capture();
  return () => inspector.retained(first, second);
}

test('a working session that finishes its turn and replies keeps the install going', async t => {
  const check = await pair(t, backend([session()]), backend([session({ state: 'idle', activeTurnId: null })], 3));
  check();
});

test('a session that starts another turn or waits for approval meanwhile keeps the install going', async t => {
  const check = await pair(t, backend([session({ state: 'idle', activeTurnId: null })]),
    backend([session({ state: 'approval', activeTurnId: 'turn-2', approval: { id: 'a1' } })]));
  check();
});

const losses = [
  ['a session gone', backend([])],
  ['a session ended', backend([session({ state: 'ended', activeTurnId: null })])],
  ['a session left recoverable', backend([session({ state: 'recoverable', activeTurnId: null })])],
  ['a session disconnected', backend([session({ state: 'disconnected', activeTurnId: null })])],
  ['a session in error', backend([session({ state: 'error', activeTurnId: null })])],
  ['a session in a state the check does not know', backend([session({ state: 'mystery', activeTurnId: null })])],
  ['the native process replaced', backend([session({ pid: 5002 })])],
  ['the native draft changed', backend([session({ liveDraft: '' })])],
  ['the model changed', backend([session({ model: 'other' })])],
  ['a room record dropped', backend([session()], 1)],
  ['the backend restarted', { ...backend([session()]), servicePid: 4343 }],
];
for (const [name, after] of losses) {
  test(`${name} stops the install`, async t => {
    const check = await pair(t, backend([session()]), after);
    assert.throws(check, assert.AssertionError);
  });
}
