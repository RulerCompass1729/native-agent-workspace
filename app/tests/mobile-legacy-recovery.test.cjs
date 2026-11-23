const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { MobileAccess, FILE } = require('../mobile-access.cjs');
const { MobileBroker } = require('../mobile-broker.cjs');
const { PairingStore } = require('../mobile-pairing-store.cjs');

test('legacy authority without a checkpoint requires reconnection without accepting old credentials or altering data', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-mobile-legacy-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const actor = 'synthetic-person', origin = 'https://phone.example.test';
  const old = new MobileAccess(root, { exclusive: () => true, identity: { pid: 900001, started: 'synthetic-old-instance' } });
  old.initialize({ alive: () => false });
  const challenge = old.beginPairing({ actor, origin, scopes: [{ serviceKey: '.', sessionId: 'synthetic-session', nativeId: 'synthetic-native', actions: ['read'] }] });
  const paired = old.pair({ actor, origin, secret: challenge.secret });
  const before = fs.readFileSync(path.join(root, FILE)); let writes = 0;
  const store = new PairingStore(root, { adapter: { get: () => null, put() { writes++; } } });
  const broker = new MobileBroker(root, { exclusive: () => true, persistence: store });
  assert.equal(broker.resumeInfo(), null);
  assert.deepEqual(broker.approvalStatus(), { paired: false, enabled: false, registered: false, pending: null, reconnectRequired: true });
  const auth = { actor, origin, token: paired.cookieValue };
  assert.throws(() => broker.session(auth));
  await assert.rejects(broker.refreshSession(auth));
  await assert.rejects(broker.resume(async () => true));
  assert.equal(broker.openUntil(), 0);
  assert.equal(writes, 0);
  assert.deepEqual(fs.readFileSync(path.join(root, FILE)), before);
  assert.deepEqual(fs.readdirSync(root), [FILE]);
});

test('a fresh profile without old authority does not claim a lost pairing', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-mobile-fresh-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new PairingStore(root, { adapter: { get: () => null, put() { throw Error('No write expected'); } } });
  const broker = new MobileBroker(root, { exclusive: () => true, persistence: store });
  assert.deepEqual(broker.approvalStatus(), { paired: false, enabled: false, registered: false, pending: null });
  assert.deepEqual(fs.readdirSync(root), []);
});
