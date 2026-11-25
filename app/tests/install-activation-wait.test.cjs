'use strict';
// Startup copies the DSH runtime before the new backend becomes active, so the installer must outwait a slow copy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createInspector } = require('../../scripts/install-runtime.cjs');
const { STALL_MS, COPY_LIMIT_MS } = require('../dsh-tui.cjs');

const OLD = 'backends/aaaaaaaaaaaaaaaaaaaa', NEXT = 'backends/bbbbbbbbbbbbbbbbbbbb', VERSION = '0.1.0-alpha.999';

// The new backend is active once `readyAt` synthetic milliseconds have passed; no real waiting.
async function verify(t, readyAt) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-install-activation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'release', 'app'), data = path.join(root, 'data');
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'views.json'), '[]');
  const started = Date.now();
  let clock = started;
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(globalThis, 'setTimeout', (work, ms) => {
    if (ms === 500) {
      clock += ms;
      queueMicrotask(work);
    }
    return 0;
  });
  globalThis.syntheticActivation = () => clock - started >= readyAt;
  t.after(() => { delete globalThis.syntheticActivation; });
  fs.writeFileSync(path.join(app, 'service-layout.cjs'), `module.exports = { readLayout: () => globalThis.syntheticActivation()
    ? { entries: ['${OLD}', '${NEXT}'], active: '${NEXT}' } : { entries: ['${OLD}'], active: '${OLD}', pending: '${NEXT}' } };`);
  fs.writeFileSync(path.join(app, 'service-connection.cjs'), `module.exports = { connectService: async directory => ({
    socket: { destroy() {} }, close() {},
    call: async () => ({ servicePid: 4242, runtimeVersion: directory.endsWith('${NEXT}') ? '${VERSION}' : '0.1.0-alpha.998',
      capabilities: ['queueDispatchV1', 'createSettingsV1'], room: { messages: [] }, rooms: [], sessions: [] }),
  }) };`);
  fs.writeFileSync(path.join(app, 'backend-switch.cjs'), 'module.exports = { readSettings: () => ({ auto: false }) };');
  fs.writeFileSync(path.join(app, 'platform.cjs'), 'module.exports = { processIdentity: pid => ({ pid }), processMayBeAlive: () => false };');
  fs.writeFileSync(path.join(app, 'background-fingerprint.cjs'), 'module.exports = { sessionBusy: () => false };');
  const inspector = createInspector({ data, resultDir: path.join(root, 'result'), newVersion: VERSION, release: path.join(root, 'release') }, { run: () => '' });
  return inspector.verifyUpgrade({ state: { sessions: [], services: [] }, restarting: [], expectedActive: null, views: [] });
}

test('a backend activated after the longest allowed runtime copy is still verified', async t => {
  // Clearing an interrupted copy has its own STALL_MS before the copy; starting the backend comes after.
  assert.equal((await verify(t, STALL_MS + COPY_LIMIT_MS + 30000)).active, NEXT);
});
test('a backend that never becomes active is still refused', async t => {
  await assert.rejects(verify(t, Infinity), /New backend did not become active/);
});
