const test = require('node:test'), assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createMobileHandler, COOKIE } = require('../mobile-http.cjs');
const origin = 'https://mobile.invalid', actor = 'synthetic-human', bearer = 'b'.repeat(43), csrf = 'c'.repeat(43), pairing = 'p'.repeat(43);
const deviceId = '10000000-0000-4000-8000-000000000001', requestId = '20000000-0000-4000-8000-000000000002';
function fixture() {
  const calls = [], result = { requestId, sessionId: 'session-a', action: 'send', status: 'submitted', error: null, storageWarning: null };
  const broker = {
    pair(value) { calls.push(['pair', value]); return { deviceId, expiresAt: Date.now() + 60000, cookieValue: bearer }; },
    session(auth) { calls.push(['session', auth]); return { deviceId, csrf, sessions: [{ id: 'session-a', actions: ['read', 'send'] }] }; },
    async read(auth, id) { calls.push(['read', auth, id]); return { id, messages: [{ text: '<script>literal original</script>' }] }; },
    async send(auth, value) { calls.push(['send', auth, value]); return result; },
    async answer(auth, value) { calls.push(['answer', auth, value]); return { ...result, action: 'answer', status: 'reply-written' }; },
    async receipt(auth, id) { calls.push(['receipt', auth, id]); return result; },
    logout(auth) { calls.push(['logout', auth]); return { authorizationRevoked: true, connectionClosed: true, committedWorkMayContinue: true }; },
  };
  const handler = createMobileHandler({ broker, origin, actor, bodyTimeoutMs: 20 });
  async function invoke({ url = '/mobile/session', method = 'GET', raw, peer = '127.0.0.1', value, chunks, stream } = {}) {
    const request = stream || Readable.from(chunks || (value === undefined ? [] : [Buffer.from(JSON.stringify(value))]));
    request.url = url; request.method = method; request.socket = { remoteAddress: peer };
    request.rawHeaders = raw || ['Host', 'mobile.invalid', 'Tailscale-User-Login', actor, 'X-NAW-Mobile', '1', 'Origin', origin, 'Cookie', `${COOKIE}=${bearer}`, 'X-NAW-CSRF', csrf, 'Content-Type', 'application/json'];
    const response = { headers: {}, setHeader(key, val) { this.headers[key.toLowerCase()] = val; }, end(body) { this.body = Buffer.isBuffer(body) ? body.toString() : body; this.writableEnded = true; } };
    await handler(request, response); response.json = () => JSON.parse(response.body); return response;
  }
  return { broker, calls, result, invoke, handler };
}
test('fixed packaged shell and authenticated reads preserve literal originals, no CORS', async () => {
  const f = fixture(); const raw = ['Host', 'mobile.invalid', 'Tailscale-User-Login', actor];
  const shell = await f.invoke({ url: '/mobile/', raw }); assert.equal(shell.statusCode, 200); assert.match(shell.body, /<script src="\/mobile\/client.js" defer>/); assert.equal(f.calls.length, 0);
  assert.match(shell.headers['content-security-policy'], /frame-ancestors 'none'/); assert.equal(shell.headers['cache-control'], 'no-store'); assert.equal(shell.headers['access-control-allow-origin'], undefined);
  const read = await f.invoke({ url: '/mobile/read/session-a' }); assert.equal(read.statusCode, 200); assert.equal(read.json().messages[0].text, '<script>literal original</script>');
});
test('peer, fixed host, carrier actor, explicit Origin and custom API header are all independent boundaries', async () => {
  const f = fixture(), base = ['Host', 'mobile.invalid', 'Tailscale-User-Login', actor, 'Cookie', `${COOKIE}=${bearer}`, 'X-NAW-Mobile', '1'];
  for (const options of [{ peer: '10.0.0.1' }, { raw: base.map(v => v === 'mobile.invalid' ? 'outside.invalid' : v) },
    { raw: base.map(v => v === actor ? 'other-human' : v) }, { raw: base.concat(['Origin', 'https://outside.invalid']) }, { raw: base.slice(0, -2) }]) {
    const denied = await f.invoke(options); assert.equal(denied.statusCode, 403);
  }
  assert.equal(f.calls.length, 0); assert.equal((await f.invoke({ raw: base })).statusCode, 200);
});
test('ambiguous duplicate headers/cookies, length plus encoding and malformed cookie never reach broker', async () => {
  for (const extra of [['host', 'mobile.invalid'], ['ORIGIN', origin], ['Cookie', `${COOKIE}=${bearer}`], ['X-NAW-CSRF', csrf], ['Content-Length', '2', 'Transfer-Encoding', 'chunked']]) {
    const f = fixture(), response = await f.invoke({ raw: ['Host', 'mobile.invalid', 'Tailscale-User-Login', actor, 'X-NAW-Mobile', '1', 'Origin', origin, 'Cookie', `${COOKIE}=${bearer}`, 'X-NAW-CSRF', csrf, ...extra] });
    assert.equal(response.statusCode, 400); assert.equal(f.calls.length, 0);
  }
  for (const cookie of [`${COOKIE}=${bearer}; ${COOKIE}=${bearer}`, `${COOKIE}=bad`, 'unrelated=value']) {
    const f = fixture(), response = await f.invoke({ raw: ['Host', 'mobile.invalid', 'Tailscale-User-Login', actor, 'X-NAW-Mobile', '1', 'Cookie', cookie] });
    assert.equal(response.statusCode, 401); assert.equal(f.calls.length, 0);
  }
});
test('pair secret is accepted only in exact JSON at an explicit same-origin fixed endpoint, cookie never JSON', async () => {
  const f = fixture(), response = await f.invoke({ method: 'POST', url: '/mobile/pair', value: { secret: pairing } });
  assert.equal(response.statusCode, 200); assert.deepEqual(response.json().paired, true); assert.ok(!response.body.includes(bearer));
  assert.match(response.headers['set-cookie'], /Secure; HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+/); assert.ok(!response.headers['set-cookie'].includes('Domain'));
  for (const value of [{ secret: pairing, actor: 'other' }, { secret: pairing, scopes: [] }, { secret: 'short' }]) assert.equal((await f.invoke({ method: 'POST', url: '/mobile/pair', value })).statusCode, 400);
  assert.equal(f.calls.length, 1);
});
test('JSON actual byte limit, fatal UTF8, declared length and object shape are enforced without a listener', async () => {
  const f = fixture();
  for (const chunks of [[Buffer.from('{"secret":"' + 'a'.repeat(4200) + '"}')], [Buffer.from([123, 34, 120, 34, 58, 34, 0xc0, 0xaf, 34, 125])], [Buffer.from('[]')], [Buffer.from('{')]]) {
    assert.ok([400, 413].includes((await f.invoke({ method: 'POST', url: '/mobile/pair', chunks })).statusCode));
  }
  const raw = ['Host', 'mobile.invalid', 'Tailscale-User-Login', actor, 'X-NAW-Mobile', '1', 'Origin', origin, 'Content-Type', 'application/json', 'Content-Length', '3'];
  assert.equal((await f.invoke({ method: 'POST', url: '/mobile/pair', value: {}, raw })).statusCode, 400); assert.equal(f.calls.length, 0);
});
test('slow bodies time out and pending bodies are bounded to eight, no broker calls', async () => {
  const f = fixture(), keepAlive = setTimeout(() => {}, 1000), streams = Array.from({ length: 8 }, () => new Readable({ read() {} }));
  try {
    const pending = streams.map(stream => f.invoke({ method: 'POST', url: '/mobile/pair', stream }));
    assert.equal((await f.invoke()).statusCode, 429);
    const responses = await Promise.all(pending); assert.ok(responses.every(r => r.statusCode === 408)); assert.ok(streams.every(s => s.destroyed)); assert.equal(f.calls.length, 0);
  } finally { clearTimeout(keepAlive); streams.forEach(s => s.destroy()); }
});
test('only fixed routes exist, no options/CORS/query action/generic local pairing RPC', async () => {
  const f = fixture();
  for (const options of [{ method: 'OPTIONS' }, { url: '/mobile/session?action=send' }, { method: 'POST', url: '/mobile/beginPairing', value: {} }, { url: '/mobile/read/../private' }]) assert.ok([403, 404].includes((await f.invoke(options)).statusCode));
  assert.equal(f.calls.length, 0);
});
test('write Origin, JSON type and session-bound CSRF header are mandatory even with cookie', async () => {
  const f = fixture(), base = ['Host', 'mobile.invalid', 'Tailscale-User-Login', actor, 'X-NAW-Mobile', '1', 'Cookie', `${COOKIE}=${bearer}`];
  for (const raw of [base, base.concat(['Origin', origin, 'Content-Type', 'text/plain']), base.concat(['Origin', origin, 'Content-Type', 'application/json'])]) {
    const response = await f.invoke({ method: 'POST', url: '/mobile/send', value: {}, raw }); assert.ok([403, 415].includes(response.statusCode));
  }
  assert.equal(f.calls.length, 0);
});
test('receipt diagnostics and thrown transport errors expose fixed codes only, preserving actual receipt states', async () => {
  const f = fixture(); f.result.error = '/PRIVATE_PROVIDER_PATH'; f.result.storageWarning = '/PRIVATE_PROFILE';
  for (const status of ['prepared', 'awaiting-native', 'unconfirmed', 'not-sent', 'submitted']) {
    f.result.status = status; const r = await f.invoke({ method: 'POST', url: '/mobile/send', value: {} }); assert.equal(r.json().status, status); assert.ok(!r.body.includes('PRIVATE_'));
  }
  f.broker.send = async () => { throw Error('/PRIVATE_BACKEND'); };
  const failed = await f.invoke({ method: 'POST', url: '/mobile/send', value: {} }); assert.deepEqual(failed.json(), { error: 'MOBILE_REQUEST_UNCONFIRMED' });
  const receipt = await f.invoke({ method: 'POST', url: '/mobile/receipt', value: { requestId } }); assert.ok(!receipt.body.includes('PRIVATE_'));
});
test('unknown original receipt remains unknown, never becomes not-sent or a new send', async () => {
  const f = fixture(); f.broker.receipt = async () => { throw Object.assign(Error('/PRIVATE_ISSUER'), { code: 'MOBILE_RECEIPT_UNKNOWN' }); };
  const r = await f.invoke({ method: 'POST', url: '/mobile/receipt', value: { requestId } });
  assert.equal(r.statusCode, 409); assert.deepEqual(r.json(), { error: 'MOBILE_RECEIPT_UNKNOWN' }); assert.equal(f.calls.length, 0);
});
test('an arbitrary backend error carrying HTTP-like status/code is still code-only', async () => {
  const f = fixture(); f.broker.read = async () => { throw Object.assign(Error('/PRIVATE_ORIGINAL_PATH'), { status: 500, code: '/PRIVATE_CODE' }); };
  const r = await f.invoke({ url: '/mobile/read/session-a' }); assert.equal(r.statusCode, 403); assert.deepEqual(r.json(), { error: 'MOBILE_DENIED' });
});
test('read-only logout requires explicit request and reports unconfirmed revocation without claiming native cancellation', async () => {
  const f = fixture(); f.broker.logout = () => ({ authorizationRevoked: false, connectionClosed: true, committedWorkMayContinue: true });
  const r = await f.invoke({ method: 'POST', url: '/mobile/logout', value: {} }); assert.equal(r.statusCode, 409); assert.equal(r.json().authorizationRevoked, false); assert.equal(r.json().committedWorkMayContinue, true); assert.match(r.headers['set-cookie'], /Max-Age=0/);
});
