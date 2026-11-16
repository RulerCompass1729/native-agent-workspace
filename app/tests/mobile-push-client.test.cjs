const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
const crypto = require('node:crypto');
for (const phase of ['permission', 'subscription']) test(`a phone re-paired during ${phase} cannot carry the old enable into the new device grant`, async () => {
  let session = { deviceId: 'old-device', csrf: 'old-csrf' }, resume, paused;
  const waiting = new Promise(r => { paused = r; }), held = new Promise(r => { resume = r; });
  const calls = []; let unsubscribed = 0;
  const sub = { toJSON: () => ({ endpoint: 'https://web.push.apple.com/synthetic' }), unsubscribe: async () => { unsubscribed++; return true; } };
  const curve = crypto.createECDH('prime256v1'); curve.generateKeys();
  const registration = { pushManager: { getSubscription: async () => null, subscribe: async () => {
    if (phase === 'subscription') { paused(); await held; } return sub;
  } } };
  const window = { isSecureContext: true, PushManager: function () {}, atob: s => Buffer.from(s, 'base64').toString('binary'),
    navigator: { serviceWorker: { register: async () => registration, ready: Promise.resolve() } },
    Notification: { requestPermission: async () => { if (phase === 'permission') { paused(); await held; } return 'granted'; } } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../mobile-web/push.js'), 'utf8'), { window, Uint8Array });
  const push = window.NAWMobilePush.create({ session: () => session, request: async (_url, value, csrf) => {
    calls.push({ value, csrf }); return { publicKey: curve.getPublicKey().toString('base64url'), enabled: Boolean(value), state: 'subscribed' };
  } });
  const action = push.enable(); await waiting;
  session = { deviceId: 'new-device', csrf: 'new-csrf' }; resume(); await action;
  assert.equal(calls.filter(c => c.value).length, 0, 'old asynchronous enable must not post using the newly paired cookie/CSRF');
  assert.equal(push.state.state, 'unconfirmed');
  if (phase === 'subscription') assert.equal(unsubscribed, 1);
});
test('a late disable response cannot unsubscribe the newly paired device', async () => {
  let session = { deviceId: 'old', csrf: 'old' }, release, unsubscribed = 0;
  const held = new Promise(r => { release = r; });
  const window = { navigator: { serviceWorker: { getRegistration: async () => ({ pushManager: {
    getSubscription: async () => ({ unsubscribe: async () => { unsubscribed++; } }),
  } }) } } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../mobile-web/push.js'), 'utf8'), { window });
  const push = window.NAWMobilePush.create({ session: () => session, request: async () => { await held; return { enabled: false, state: 'off' }; } });
  const action = push.disable(); session = { deviceId: 'new', csrf: 'new' }; release(); await action;
  assert.equal(unsubscribed, 0); assert.equal(push.state.state, 'unconfirmed');
});
test('a late status read never overwrites the new pairing status', async () => {
  let session = { deviceId: 'old', csrf: 'old' }, release;
  const held = new Promise(r => { release = r; }), window = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../mobile-web/push.js'), 'utf8'), { window });
  const push = window.NAWMobilePush.create({ session: () => session, request: async () => { await held; return { enabled: true, state: 'accepted' }; } });
  const reading = push.read(); session = { deviceId: 'new', csrf: 'new' }; release();
  await assert.rejects(reading); assert.equal(push.state.enabled, false);
});
