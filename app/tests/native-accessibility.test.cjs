const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createOutboxBroker } = require('../computer-use-outbox-broker.cjs');
const { processIdentity } = require('../platform.cjs');
const { createAccessibilityScope, acquireAccessibility } = require('../native-accessibility.cjs');
const full = ['nativeAPIs', 'webContents', 'inlineTextBoxes', 'extendedProperties'];
function appFixture(initial = []) {
  let features = [...initial]; const writes = [];
  return { getAccessibilitySupportFeatures: () => [...features], setAccessibilitySupportFeatures: value => { writes.push([...value]); features = [...value]; }, writes };
}
test('full AX is off at rest and restored only after the last overlapping operation', () => {
  const app = appFixture(), acquire = createAccessibilityScope(app, () => true);
  assert.deepEqual(app.writes, []);
  const first = acquire(1), second = acquire(2); assert.deepEqual(app.getAccessibilitySupportFeatures(), full);
  first(); assert.deepEqual(app.getAccessibilitySupportFeatures(), full);
  second(); assert.deepEqual(app.getAccessibilitySupportFeatures(), []);
  second(); assert.equal(app.writes.length, 2, 'Release is idempotent');
});
test('AX scopes reject a foreign window and preserve prior or newly enabled assistive features', () => {
  const app = appFixture(['html']), acquire = createAccessibilityScope(app, id => id === 9);
  assert.throws(() => acquire(8)); assert.deepEqual(app.writes, []);
  const release = acquire(9); release(); assert.deepEqual(app.getAccessibilitySupportFeatures(), ['html']);
  const later = acquire(9); app.setAccessibilitySupportFeatures([...full, 'screenReader', 'html']); later();
  assert.ok(app.getAccessibilitySupportFeatures().includes('screenReader'));
  assert.ok(full.every(f => app.getAccessibilitySupportFeatures().includes(f)));
});
test('an explicit feature removal during a scope is not undone on release', () => {
  const app = appFixture(['html']), acquire = createAccessibilityScope(app, () => true), release = acquire(1);
  app.setAccessibilitySupportFeatures([]); release(); assert.deepEqual(app.getAccessibilitySupportFeatures(), []);
});
test('a preexisting partial screen-reader mode is restored exactly, without keeping our additions', () => {
  const app = appFixture(['screenReader']), acquire = createAccessibilityScope(app, () => true), release = acquire(1);
  assert.ok(full.every(feature => app.getAccessibilitySupportFeatures().includes(feature)));
  release(); assert.deepEqual(app.getAccessibilitySupportFeatures(), ['screenReader']);
});
async function brokerFixture(t, accessibilityMs = 60000) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-ax-scope-'))); fs.chmodSync(dir, 0o700);
  let broker;
  t.after(async () => { await broker?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const app = appFixture(), scope = createAccessibilityScope(app, id => id === 9);
  broker = await createOutboxBroker({ descriptorFile: path.join(dir, 'owner.json'),
    bind: () => assert.fail('AX must not bind a native task'), createView: () => assert.fail('AX must not open a control view'),
    acquireAccessibility: target => scope(target.windowId), accessibilityMs });
  return { broker, app, target: { ...processIdentity(process.pid), windowId: 9 } };
}
test('the private broker lease restores AX on client close without invoking a native operation', async t => {
  const f = await brokerFixture(t), release = await acquireAccessibility(f.target, f.broker.descriptorFile);
  assert.deepEqual(f.app.getAccessibilitySupportFeatures(), full);
  await release();
  for (let i = 0; i < 30 && f.app.getAccessibilitySupportFeatures().length; i++) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(f.app.getAccessibilitySupportFeatures(), []);
});
test('a stalled AX client is disconnected and restored by its own bounded expiry', async t => {
  const f = await brokerFixture(t, 400), release = await acquireAccessibility(f.target, f.broker.descriptorFile);
  await new Promise(r => setTimeout(r, 500));
  assert.deepEqual(f.app.getAccessibilitySupportFeatures(), []); await release();
});
test('PID generation, exact window and request shape must pass before enabling AX', async t => {
  const f = await brokerFixture(t);
  for (const change of [{ pid: process.pid + 1 }, { started: 'old' }, { windowId: 8 }, { windowId: 0 }, { extra: true }]) {
    await assert.rejects(acquireAccessibility({ ...f.target, ...change }, f.broker.descriptorFile));
    assert.deepEqual(f.app.getAccessibilitySupportFeatures(), []);
  }
});
test('both native MCP configurations carry only the private AX descriptor; the stock bridge never inherits it', () => {
  const { computerUseMcpServer, codexComputerUseMcpArgs, computerUseEnvironment } = require('../native-computer-use.cjs');
  const previous = process.env.NAW_OUTBOX_DESCRIPTOR;
  try {
    process.env.NAW_OUTBOX_DESCRIPTOR = '/synthetic/private/outbox-owner.json';
    assert.equal(computerUseMcpServer().env.NAW_AX_OUTBOX_DESCRIPTOR, process.env.NAW_OUTBOX_DESCRIPTOR);
    assert.ok(codexComputerUseMcpArgs().includes('mcp_servers.peekaboo.env.NAW_AX_OUTBOX_DESCRIPTOR="/synthetic/private/outbox-owner.json"'));
    assert.equal(computerUseMcpServer({ viewLeaseFile: '/synthetic/view.json' }).env.NAW_AX_OUTBOX_DESCRIPTOR, undefined);
    assert.equal(computerUseEnvironment({ NAW_AX_OUTBOX_DESCRIPTOR: process.env.NAW_OUTBOX_DESCRIPTOR }).NAW_AX_OUTBOX_DESCRIPTOR, undefined);
  } finally { if (previous === undefined) delete process.env.NAW_OUTBOX_DESCRIPTOR; else process.env.NAW_OUTBOX_DESCRIPTOR = previous; }
});
test('the broker rejects a forged capability or extra request fields without enabling AX', async t => {
  const f = await brokerFixture(t), info = JSON.parse(fs.readFileSync(f.broker.descriptorFile, 'utf8'));
  for (const change of [{ capability: '0'.repeat(64) }, { arguments: [] }]) {
    const response = await new Promise((resolve, reject) => {
      const socket = require('node:net').connect(info.socketPath); let data = '';
      socket.once('error', reject); socket.setTimeout(1000, () => { socket.destroy(); reject(Error('Broker did not refuse')); });
      socket.once('connect', () => socket.write(JSON.stringify({ kind: 'accessibility', identity: f.target, capability: info.capability, ...change }) + '\n'));
      socket.on('data', chunk => data += chunk); socket.once('end', () => { socket.destroy(); resolve(JSON.parse(data)); });
    });
    assert.notEqual(response.accessibility, 'ready'); assert.deepEqual(f.app.writes, []);
  }
});
test('the gate releases AX on read failure and never acquires it for an unqualified target', async () => {
  const { createComputerUseGate } = require('../native-computer-use.cjs'); let active = false;
  const observe = { name: 'inspect_ui', arguments: { app_target: 'PID:123', window_id: 9, fresh: true, include_elements: true } };
  const gate = createComputerUseGate({ identity: () => ({ pid: 123, started: 'original' }),
    acquireAccessibility: async () => { active = true; return () => { active = false; }; } });
  await assert.rejects(gate(observe, async () => { assert.equal(active, true); throw Error('Synthetic read failure'); }));
  assert.equal(active, false);
  const refused = createComputerUseGate({ identity: () => null, acquireAccessibility: () => assert.fail('Foreign target cannot acquire AX') });
  await assert.rejects(refused(observe, () => assert.fail('Foreign target cannot read')));
});
