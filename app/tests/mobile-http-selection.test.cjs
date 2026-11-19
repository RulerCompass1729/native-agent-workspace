const test = require('node:test'), assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createMobileHandler, COOKIE } = require(require('node:path').join(process.env.NAW_TEST_APP_ROOT || require('node:path').resolve(__dirname, '../..'), 'app/mobile-http.cjs'));
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

for (const [url, choice] of [
  ['/mobile/workspace/summary', { kind: 'summary' }],
  ['/mobile/workspace/session/session-a', { kind: 'session', id: 'session-a' }],
  ['/mobile/workspace/room/shared', { kind: 'room', id: 'shared' }],
]) test('fixed read selector reaches authenticated workspace broker: ' + url, async () => {
  const f = fixture();
  f.broker.workspaceRead = async (auth, selection) => { f.calls.push(['workspaceRead', auth, selection]); return { sessions: [], rooms: [] }; };
  const result = await f.invoke({ url });
  assert.equal(result.statusCode, 200); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0][2], choice); assert.equal(f.calls[0][1].token, bearer);
});
test('selection paths preserve cookie, carrier, host, origin, peer and custom-header gates', async () => {
  const base = ['Host', 'mobile.invalid', 'Tailscale-User-Login', actor, 'X-NAW-Mobile', '1', 'Origin', origin, 'Cookie', `${COOKIE}=${bearer}`];
  for (const url of ['/mobile/workspace/summary', '/mobile/workspace/session/session-a', '/mobile/workspace/room/shared']) {
    const f = fixture(); f.broker.workspaceRead = () => { f.calls.push(['workspaceRead']); return {}; };
    for (const field of ['Cookie', 'Host', 'Tailscale-User-Login', 'X-NAW-Mobile']) {
      const raw = base.filter((_, i) => i % 2 ? base[i - 1] !== field : base[i] !== field);
      assert.notEqual((await f.invoke({ url, raw })).statusCode, 200);
    }
    for (const options of [{ peer: '10.0.0.1' }, { raw: base.concat(['Origin', 'https://outside.invalid']) }])
      assert.notEqual((await f.invoke({ url, ...options })).statusCode, 200);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.invoke({ url })).statusCode, 200); assert.equal(f.calls.length, 1);
  }
});
test('arbitrary query, selector path traversal, extra path and POST do not reach the read broker', async () => {
  const f = fixture(); f.broker.workspaceRead = () => { f.calls.push(['workspaceRead']); return {}; };
  for (const url of ['/mobile/workspace/summary?all=true', '/mobile/workspace/session/../session-a', '/mobile/workspace/session/%2e%2e', '/mobile/workspace/session/session-a/extra', '/mobile/workspace/unknown'])
    assert.notEqual((await f.invoke({ url })).statusCode, 200);
  assert.notEqual((await f.invoke({ url: '/mobile/workspace/summary', method: 'POST', value: {} })).statusCode, 200);
  assert.equal(f.calls.length, 0);
});
