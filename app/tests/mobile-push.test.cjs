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

for (const at of ['before-write', 'late-response']) test(`subscription expiry at ${at} aborts the request and remains expired`, async t => {
  let now = Date.now(), resume, submitted = 0, signal;
  const f = fixture(t, { now: () => now, transport: async (_details, guard) => {
    signal = guard.signal;
    await new Promise(r => { resume = r; });
    if (guard.valid()) submitted++;
    return 201;
  } });
  f.sub.expirationTime = now + 100;
  f.push.configuration(); f.push.subscribe(f.sub);
  const pending = f.push.refresh();
  if (at === 'late-response') {
    // The service may accept a request sent before expiry; its late response
    // still must not revive the now-expired local subscription.
    resume(); await Promise.resolve();
  }
  now += 100; // Equality is already expired.
  if (at === 'before-write') resume();
  await pending;
  assert.deepEqual(f.push.status(), { enabled: false, state: 'expired', lastSubmittedAt: null });
  assert.equal(signal.aborted, true); assert.equal(f.push.timer, null);
  assert.equal(submitted, at === 'before-write' ? 0 : 1);
  await f.push.refresh(); assert.equal(submitted, at === 'before-write' ? 0 : 1);
});
test('an expired old request cannot expire its replacement subscription', async t => {
  let now = Date.now(), release;
  const f = fixture(t, { now: () => now, transport: async (_details, guard) => {
    await new Promise(r => { release = r; }); return guard.valid() ? 201 : 410;
  } });
  f.sub.expirationTime = now + 100;
  f.push.configuration(); f.push.subscribe(f.sub); const old = f.push.refresh();
  f.push.subscribe({ ...f.sub, expirationTime: now + 1000, endpoint: 'https://web.push.apple.com/replaced' });
  now += 100; release(); await old;
  assert.equal(f.push.status().enabled, true); assert.equal(f.push.status().state, 'subscribed');
});


test('VAPID subject and generated JWT carry no account, contact address or application host', async t => {
  const source = require('node:fs').readFileSync(require.resolve('../mobile-push.cjs'), 'utf8');
  const subject = source.match(/const SUBJECT = '([^']*)';/)[1];
  for (const host of ['web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com']) {
    const f = fixture(t, { authority: () => 'synthetic-person@example.invalid' });
    f.sub.endpoint = `https://${host}/synthetic`;
    f.push.configuration(); f.push.subscribe(f.sub); await f.push.refresh();
    assert.equal(f.messages.length, 1, 'generate the actual request with an offline transport');
    const details = f.messages[0], token = details.headers.Authorization.match(/^vapid t=([^,]+), k=/)[1];
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    assert.doesNotMatch(JSON.stringify(payload), /github|rulercompass|@|synthetic-mac/i);
    // RFC 8292 requires the push service origin in aud. No other claim may carry a host.
    assert.equal(payload.aud, `https://${host}`);
    assert.ok(Number.isSafeInteger(payload.exp) && payload.exp > Math.floor(Date.now() / 1000));
    assert.deepEqual({ ...payload, exp: 0 }, { aud: `https://${host}`, exp: 0, sub: 'mailto:' });
    assert.equal(subject, 'mailto:'); assert.equal(payload.sub, subject);
    const contact = new URL(subject); assert.equal(contact.protocol, 'mailto:');
    assert.deepEqual([contact.hostname, contact.username, contact.password, contact.pathname, contact.search, contact.hash], ['', '', '', '', '', '']);
    assert.ok(Object.keys(details.headers).every(key => !/user-agent|referer|referrer/i.test(key)));
    const plain = require('http_ece').decrypt(details.body, { version: 'aes128gcm', privateKey: f.key, authSecret: f.sub.keys.auth });
    assert.deepEqual(JSON.parse(plain), { count: 7 });
  }
});
const sent = (f, index = -1) => JSON.parse(require('http_ece').decrypt(f.messages.at(index).body, { version: 'aes128gcm', privateKey: f.key, authSecret: f.sub.keys.auth }).toString());
test('alerts leave only as fixed codes; a cleared alert is said once, then the count contract returns', async t => {
  let alerts = [{ code: 'token-anomaly' }, { code: 'PRIVATE_NAME' }, { code: 'service-disconnected', text: 'PRIVATE_BODY' }, { code: 'token-anomaly' }, 'decision-waiting', null];
  const f = fixture(t, { alerts: () => ({ alerts }) }); f.push.configuration(); f.push.subscribe(f.sub);
  await f.push.refresh();
  assert.deepEqual(sent(f), { count: 7, alerts: ['service-disconnected', 'token-anomaly'] });
  assert.equal(f.messages[0].headers.TTL, 3600); assert.equal(f.messages[0].headers.Urgency, 'high'); assert.equal(f.messages[0].headers.Topic, 'naw-count');
  await f.push.refresh(); assert.equal(f.messages.length, 1);
  alerts = []; await f.push.refresh();
  assert.deepEqual(sent(f), { count: 7, alerts: [] }); assert.equal(f.messages[1].headers.TTL, 60); assert.equal(f.messages[1].headers.Urgency, 'normal');
  await f.push.refresh(); assert.equal(f.messages.length, 2);
  f.count(8); await f.push.refresh(); assert.deepEqual(sent(f), { count: 8 });
});
test('without a permitted count only the alert leaves, and nothing leaves when there is no alert', async t => {
  let alerts = [];
  const f = fixture(t, { count: () => null, alerts: () => ({ alerts }) }); f.push.configuration(); f.push.subscribe(f.sub);
  await f.push.refresh(); assert.equal(f.messages.length, 0);
  alerts = [{ code: 'service-disconnected' }]; await f.push.refresh(); assert.deepEqual(sent(f), { alerts: ['service-disconnected'] });
  alerts = []; await f.push.refresh(); assert.deepEqual(sent(f), { alerts: [] });
  await f.push.refresh(); assert.equal(f.messages.length, 2);
});
test('an alert source that cannot be read keeps what was last said and never reports it cleared', async t => {
  let source = () => { throw Error('PRIVATE_FAILURE'); };
  const f = fixture(t, { alerts: () => source() }); f.push.configuration(); f.push.subscribe(f.sub);
  await f.push.refresh(); assert.deepEqual(sent(f), { count: 7 }); assert.equal(f.push.status().state, 'accepted');
  source = () => ({ alerts: [{ code: 'steward-wake-stalled' }, { code: 'decision-waiting' }] }); await f.push.refresh();
  assert.deepEqual(sent(f), { count: 7, alerts: ['steward-wake-stalled', 'decision-waiting'] });
  for (const broken of [() => { throw Error('PRIVATE_FAILURE'); }, () => null, () => ['decision-waiting'],
    () => ({ alerts: [], unknown: ['steward-wake-stalled', 'decision-waiting', 'PRIVATE_NAME'] })]) {
    source = broken; await f.push.refresh(); assert.equal(f.messages.length, 2);
  }
  // Only the wake source is unreadable now: the decision is known to be answered, the stall is still unknown.
  source = () => ({ alerts: [], unknown: ['steward-wake-stalled'] }); await f.push.refresh();
  assert.deepEqual(sent(f), { count: 7, alerts: ['steward-wake-stalled'] });
  // An unknown code that was never said is not invented.
  source = () => ({ alerts: [], unknown: ['steward-wake-stalled', 'token-anomaly'] }); await f.push.refresh(); assert.equal(f.messages.length, 3);
  source = () => ({ alerts: [] }); await f.push.refresh(); assert.deepEqual(sent(f), { count: 7, alerts: [] });
});
test('an unreadable count holds back only itself: alerts still leave, and it alone says nothing', async t => {
  let alerts = [], read = () => { throw Error('PRIVATE_FAILURE'); };
  const f = fixture(t, { count: () => read(), alerts: () => ({ alerts }) }); f.push.configuration(); f.push.subscribe(f.sub);
  await f.push.refresh(); assert.equal(f.messages.length, 0); assert.equal(f.push.status().state, 'delayed');
  alerts = [{ code: 'decision-waiting' }]; await f.push.refresh(); assert.deepEqual(sent(f), { alerts: ['decision-waiting'] });
  await f.push.refresh(); assert.equal(f.messages.length, 1);
  read = () => 7; await f.push.refresh(); assert.deepEqual(sent(f), { count: 7, alerts: ['decision-waiting'] });
  // A count that fails later neither repeats the alert nor sends a stale number.
  read = () => 1.5; await f.push.refresh(); read = () => { throw Error('PRIVATE_FAILURE'); }; await f.push.refresh(); assert.equal(f.messages.length, 2);
  alerts = []; await f.push.refresh(); assert.deepEqual(sent(f), { alerts: [] });
  read = () => 7; await f.push.refresh(); assert.equal(f.messages.length, 3);
});
test('a push told to end says the current state once more, keeps trying until it is accepted, then is off', async t => {
  let alerts = [], status = 201;
  const f = fixture(t, { alerts: () => ({ alerts }), transport: async details => { f.messages.push(details); return status; } });
  f.push.configuration(); f.push.subscribe(f.sub); await f.push.refresh(); assert.deepEqual(sent(f), { count: 7 });
  alerts = [{ code: 'service-disconnected' }]; status = 500; await f.push.end();
  assert.equal(f.messages.length, 2); assert.equal(f.push.status().enabled, true); assert.equal(f.push.status().state, 'delayed');
  status = 201; await f.push.refresh(); assert.deepEqual(sent(f), { count: 7, alerts: ['service-disconnected'] });
  assert.deepEqual(f.push.status(), { enabled: false, state: 'off', lastSubmittedAt: null });
  alerts = [{ code: 'decision-waiting' }]; await f.push.refresh(); assert.equal(f.messages.length, 3);
  // Nothing new to say also ends it, and so does ending before any subscription.
  const g = fixture(t); g.push.configuration(); g.push.subscribe(g.sub); await g.push.refresh(); await g.push.end();
  assert.equal(g.messages.length, 1); assert.equal(g.push.status().state, 'off');
  const h = fixture(t); h.push.configuration(); h.push.end(); assert.equal(h.push.status().state, 'off');
});
test('a new subscription during an unfinished ending is a new start and stays on', async t => {
  let status = 500;
  const f = fixture(t, { transport: async details => { f.messages.push(details); return status; } });
  f.push.configuration(); f.push.subscribe(f.sub); await f.push.end();
  assert.equal(f.push.status().state, 'delayed');
  status = 201; f.push.subscribe(f.sub); await f.push.refresh(); assert.deepEqual(sent(f), { count: 7 });
  assert.equal(f.push.status().enabled, true); assert.equal(f.push.status().state, 'accepted');
});
test('ending during a pending send still says the final state after that send settles', async t => {
  let alerts = [], release; const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { alerts: () => ({ alerts }), transport: async details => { f.messages.push(details); if (f.messages.length === 1) await gate; return 201; } });
  f.push.configuration(); f.push.subscribe(f.sub); const first = f.push.refresh();
  alerts = [{ code: 'service-disconnected' }]; f.push.end(); release(); await first;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(sent(f), { count: 7, alerts: ['service-disconnected'] }); assert.equal(f.push.status().state, 'off');
});
test('an unchanged alert is said again only for a newer case, and its time never leaves', async t => {
  let alerts = [{ code: 'decision-waiting', at: 1000 }];
  const f = fixture(t, { alerts: () => ({ alerts }) }); f.push.configuration(); f.push.subscribe(f.sub);
  await f.push.refresh(); await f.push.refresh(); assert.equal(f.messages.length, 1);
  alerts = [{ code: 'decision-waiting', at: 2000 }]; await f.push.refresh();
  assert.equal(f.messages.length, 2); assert.deepEqual(sent(f), { count: 7, alerts: ['decision-waiting'] });
  // The newer question was answered; the older one is still open and was already announced.
  alerts = [{ code: 'decision-waiting', at: 1000 }]; await f.push.refresh(); assert.equal(f.messages.length, 2);
  alerts = [{ code: 'decision-waiting', at: 'PRIVATE' }, { code: 'token-anomaly', at: 1.5 }]; await f.push.refresh();
  assert.equal(f.messages.length, 3); assert.deepEqual(sent(f), { count: 7, alerts: ['token-anomaly', 'decision-waiting'] });
});
