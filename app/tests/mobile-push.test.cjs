const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { MobilePush, subscriptionValue, publicAddress } = require('../mobile-push.cjs');
function subscription() {
  const key = crypto.createECDH('prime256v1'); key.generateKeys();
  return { endpoint: 'https://web.push.apple.com/synthetic', expirationTime: null,
    keys: { p256dh: key.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') }, key };
}
function fixture(t, options = {}) {
  let authority = 'paired-generation-device', count = 7;
  const messages = [], sub = subscription(); const { key, ...wire } = sub;
  const push = new MobilePush({ authority: () => authority, count: () => count,
    transport: async (details, guard) => { assert.equal(guard.valid(), true); messages.push(details); return 201; }, ...options });
  t.after(() => push.close());
  return { push, messages, sub: wire, key, revoke: () => { authority = null; }, count: value => { count = value; } };
}
test('push count is exactly records.status().count; encrypted payload contains only that number', async t => {
  const records = { status: () => ({ count: 37, names: ['PRIVATE_NAME'], body: 'PRIVATE_BODY', path: '/private/path', token: 'PRIVATE_TOKEN' }) };
  const f = fixture(t, { count: () => records.status().count });
  f.push.configuration(); f.push.subscribe(f.sub); await f.push.refresh();
  assert.equal(f.messages.length, 1);
  const details = f.messages[0]; assert.equal(details.headers['Content-Encoding'], 'aes128gcm');
  const plain = require('http_ece').decrypt(details.body, { version: 'aes128gcm', privateKey: f.key, authSecret: f.sub.keys.auth }).toString();
  assert.deepEqual(JSON.parse(plain), { count: records.status().count });
  assert.doesNotMatch(JSON.stringify(details), /PRIVATE_|\/private\/path/);
  assert.equal(details.headers.TTL, 60); assert.equal(details.headers.Topic, 'naw-count');
  assert.deepEqual(Object.keys(f.push.status()).sort(), ['enabled', 'lastSubmittedAt', 'state']);
});
test('only count changes send; identical counts coalesce and zero is the same count contract', async t => {
  const f = fixture(t); f.push.configuration(); f.push.subscribe(f.sub);
  await f.push.refresh(); await f.push.refresh(); assert.equal(f.messages.length, 1);
  f.count(0); await f.push.refresh(); assert.equal(f.messages.length, 2);
});
test('APNs authorization is reused for an hour while every changed count is freshly encrypted', async t => {
  const realNow = Date.now; let now = realNow(); Date.now = () => now; t.after(() => { Date.now = realNow; });
  const f = fixture(t); f.push.configuration(); f.push.subscribe(f.sub); await f.push.refresh();
  const auth = f.messages[0].headers.Authorization;
  now += 60001; f.count(8); await f.push.refresh();
  assert.equal(f.messages[1].headers.Authorization, auth); assert.notDeepEqual(f.messages[1].body, f.messages[0].body);
  now += 3600000; f.count(9); await f.push.refresh(); assert.notEqual(f.messages[2].headers.Authorization, auth);
});
test('only supported HTTPS push endpoints and exact subscription keys are accepted', t => {
  const f = fixture(t);
  const credentialURL = new URL('https://web.push.apple.com/a'); credentialURL.username = 'synthetic-user';
  for (const endpoint of ['http://web.push.apple.com/a', 'https://127.0.0.1/a', 'https://web.push.apple.com.attacker.test/a', 'https://web.push.apple.com:444/a', credentialURL.href, 'https://web.push.apple.com/a?secret=1', 'https://web.push.apple.com/a#x'])
    assert.throws(() => subscriptionValue({ ...f.sub, endpoint }));
  assert.throws(() => subscriptionValue({ ...f.sub, name: 'PRIVATE_NAME' }));
  assert.throws(() => subscriptionValue({ ...f.sub, keys: { ...f.sub.keys, auth: 'x' } }));
  for (const host of ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']) assert.ok(subscriptionValue({ ...f.sub, endpoint: `https://${host}/synthetic` }));
  assert.ok(subscriptionValue({ ...f.sub, endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic:APA91b-token' }));
});
test('private, loopback, mapped and multicast DNS addresses are refused', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.1.2', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '224.1.1.1', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1']) assert.equal(publicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '2606:4700:4700::1111']) assert.equal(publicAddress(ip), true, ip);
});
test('revocation and close abort a pending send and prevent subsequent sends or late status changes', async t => {
  let resolve, signal; const f = fixture(t, { transport: async (_details, guard) => { signal = guard.signal; return new Promise(r => { resolve = r; }); } });
  f.push.configuration(); f.push.subscribe(f.sub); const pending = f.push.refresh();
  assert.ok(signal); f.revoke(); f.push.close(); assert.equal(signal.aborted, true);
  resolve(201); await pending; await f.push.refresh();
  assert.deepEqual(f.push.status(), { enabled: false, state: 'off', lastSubmittedAt: null });
});
test('authority expiration or generation replacement invalidates the subscription before another send', async t => {
  const f = fixture(t); f.push.configuration(); f.push.subscribe(f.sub); await f.push.refresh();
  f.revoke(); f.count(9); await f.push.refresh(); assert.equal(f.messages.length, 1); assert.equal(f.push.status().enabled, false);
});
test('a subscription replaced during a pending request receives its own current count after that request settles', async t => {
  let release, sends = 0;
  const f = fixture(t, { transport: async () => { sends++; if (sends === 1) await new Promise(r => { release = r; }); return 201; } });
  f.push.configuration(); f.push.subscribe(f.sub); const old = f.push.refresh();
  f.push.subscribe({ ...f.sub, endpoint: 'https://web.push.apple.com/replacement' });
  release(); await old; await new Promise(r => setTimeout(r, 20));
  assert.equal(sends, 2); assert.equal(f.push.status().state, 'accepted');
});
test('offline or server failure stays delayed; an accepted response never claims phone delivery', async t => {
  const f = fixture(t, { transport: async () => { throw Error('PRIVATE_ENDPOINT_AND_PATH'); } });
  f.push.configuration(); f.push.subscribe(f.sub); await f.push.refresh();
  assert.deepEqual(f.push.status(), { enabled: true, state: 'delayed', lastSubmittedAt: null });
  assert.doesNotMatch(JSON.stringify(f.push.status()), /PRIVATE/);
});
test('404/410 cancels a dead subscription rather than retrying it', async t => {
  const f = fixture(t, { transport: async () => 410 });
  f.push.configuration(); f.push.subscribe(f.sub); await f.push.refresh();
  assert.equal(f.push.status().enabled, false); assert.equal(f.push.status().state, 'expired');
});
test('key logging mode cannot load or use the encryption library', t => {
  const old = process.env.ECE_KEYLOG; process.env.ECE_KEYLOG = '1';
  t.after(() => { if (old === undefined) delete process.env.ECE_KEYLOG; else process.env.ECE_KEYLOG = old; });
  const f = fixture(t); assert.throws(() => f.push.configuration()); assert.equal(f.messages.length, 0);
});
test('the actual encrypted request reaches only the owned loopback TLS endpoint; redirects are not followed', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), https = require('node:https');
  const { execFileSync } = require('node:child_process'), { once } = require('node:events');
  const { sendRequest } = require('../mobile-push.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-push-tls-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key'), '-out', path.join(dir, 'cert'), '-subj', '/CN=localhost', '-days', '1'], { stdio: 'ignore' });
  let status = 201, hits = 0, received;
  const server = https.createServer({ key: fs.readFileSync(path.join(dir, 'key')), cert: fs.readFileSync(path.join(dir, 'cert')) }, (req, res) => {
    hits++; const chunks = []; req.on('data', b => chunks.push(b)); req.on('end', () => {
      received = Buffer.concat(chunks); res.writeHead(status, { Location: 'https://outside.invalid/never-follow' }); res.end();
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const transport = (details, guard) => sendRequest(details, guard, (url, options, callback) => {
    assert.equal(new URL(url).hostname, 'web.push.apple.com'); assert.equal(options.agent, false); assert.ok(options.signal); assert.equal(typeof options.lookup, 'function');
    return https.request(`https://127.0.0.1:${server.address().port}/synthetic`, { ...options, lookup: undefined, rejectUnauthorized: false }, callback);
  });
  const f = fixture(t, { transport }); f.push.configuration(); f.push.subscribe(f.sub); await f.push.refresh();
  assert.equal(hits, 1); assert.equal(f.push.status().state, 'accepted');
  assert.deepEqual(JSON.parse(require('http_ece').decrypt(received, { version: 'aes128gcm', privateKey: f.key, authSecret: f.sub.keys.auth })), { count: 7 });
  status = 302; f.count(9); await f.push.refresh(); assert.equal(hits, 2); assert.equal(f.push.status().state, 'delayed');
});
