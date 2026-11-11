const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http');
const g = require('../../scripts/fixtures/butler-trial-gateway.cjs');
const native = { model: g.MODEL, stream: true, tools: [{ type: 'function', name: g.TOOL }], input: 'PRIVATE_CANARY' };
const reply = (index = 1, usage = {}) => Buffer.from('data: ' + JSON.stringify({ type: 'response.completed', response: {
  model: g.MODEL, status: 'completed', output: index === 1 ? [{ type: 'function_call', name: g.TOOL, call_id: 'synthetic_call', arguments: '{}' }]
    : [{ type: 'message', content: [{ type: 'output_text', text: g.ANSWER }] }],
  usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 10 }, output_tokens: 20, ...usage },
} }) + '\n\n');
function send(gateway, body = native) { return new Promise(resolve => {
  const data = JSON.stringify(body), req = http.request(gateway.endpoint + '/responses', { method: 'POST', headers: {
    'Content-Length': Buffer.byteLength(data), Authorization: 'Bearer synthetic-only', 'Content-Type': 'application/json' } }, res => {
    const chunks = []; res.on('data', x => chunks.push(x)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
  }); req.on('error', e => resolve({ error: e.code })); req.end(data);
}); }
test('native frame bounds HTTP and retains authentication as opaque transport bytes', () => {
  const body = JSON.stringify(native), auth = 'Authorization: Bearer synthetic-only';
  const raw = Buffer.from(`POST /only HTTP/1.1\r\n${auth}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  const frame = g.nativeFrame(raw, '/only'); assert.ok(frame.authorization.equals(Buffer.from(auth))); assert.deepEqual(frame.body, native);
  assert.equal(g.nativeFrame(raw.subarray(0, raw.length - 1), '/only'), null);
  assert.throws(() => g.nativeFrame(Buffer.concat([raw, raw]), '/only'), /pipelining-forbidden/);
  assert.throws(() => g.nativeFrame(Buffer.from(raw.toString().replace('Content-Length:', auth + '\r\nContent-Length:')), '/only'), /duplicate-authorization/);
  assert.throws(() => g.nativeFrame(Buffer.from(raw.toString().replace('Content-Length:', 'Transfer-Encoding: chunked\r\nContent-Length:')), '/only'), /unsupported-encoding/);
  assert.throws(() => g.nativeFrame(Buffer.alloc(16385, 65), '/only'), /header-too-large/);
});
test('the transmitted synthetic requests cap output and have no native context', () => {
  const first = JSON.parse(g.requestBody(1)); assert.equal(first.max_output_tokens, 1024); assert.equal(first.tool_choice.name, g.TOOL);
  const second = JSON.parse(g.requestBody(2, { type: 'function_call', name: g.TOOL, call_id: 'synthetic_call', arguments: '{}' }));
  assert.equal(second.tool_choice, 'none'); assert.deepEqual(second.tools, []); assert.equal(second.input[2].output, g.RESULT);
  assert.ok(Buffer.byteLength(JSON.stringify(second)) < 1600);
});
test('unknown usage, overflow and server tools cannot become a cheap completed trial', () => {
  const response = g.responseEvent(reply()); assert.equal(g.usage(response).estimatedMicros, 199);
  for (const change of [{ output_tokens: 1025 }, { input_tokens: 2001 }, { input_tokens_details: { cached_tokens: 101 } },
    { input_tokens_details: {} }, { output_tokens: -1 }, { server_tool_use: { tool_search: 1 } }]) {
    assert.throws(() => g.usage(g.responseEvent(reply(1, change))));
  }
  assert.equal(g.usage(response).actualAmount, null);
});
test('two attempts and one exact native tool result complete; a third never reaches upstream', async t => {
  const calls = [], receipts = []; const gateway = g.createGateway({ record: r => receipts.push(r), transport: async (b, auth) => {
    calls.push(JSON.parse(b)); assert.ok(auth); assert.ok(!b.includes(Buffer.from('PRIVATE_CANARY'))); return reply(calls.length);
  } }); await gateway.start(); t.after(() => gateway.close());
  assert.equal((await send(gateway)).status, 200);
  assert.throws(() => gateway.handleTool({ tool: 'exec_command', callId: 'synthetic_call', arguments: {} }), /unexpected-native-tool/);
  const params = { tool: g.TOOL, callId: 'synthetic_call', arguments: {} };
  assert.equal(gateway.handleTool(params).contentItems[0].text, g.RESULT);
  assert.throws(() => gateway.handleTool(params), /unexpected-native-tool/);
  assert.equal((await send(gateway)).status, 200);
  assert.ok((await send(gateway)).error); assert.equal(calls.length, 2);
  assert.ok(!JSON.stringify(receipts).includes('synthetic-only')); assert.ok(!JSON.stringify(receipts).includes('PRIVATE_CANARY'));
});
test('a second request without the native tool callback never reaches upstream', async t => {
  let calls = 0; const gateway = g.createGateway({ transport: async () => { calls++; return reply(); } });
  await gateway.start(); t.after(() => gateway.close()); await send(gateway); assert.ok((await send(gateway)).error); assert.equal(calls, 1);
});
test('unexpected native model or tool registry is rejected before any upstream request', async t => {
  for (const body of [{ ...native, model: 'another-model' }, { ...native, tools: [] }, { ...native, tools: [...native.tools, { type: 'function', name: 'exec_command' }] }]) {
    let calls = 0; const gateway = g.createGateway({ transport: async () => { calls++; return reply(); } });
    await gateway.start(); t.after(() => gateway.close()); assert.ok((await send(gateway, body)).error); assert.equal(calls, 0);
  }
});
test('an upstream failure is not retried and does not acquire known zero cost', async t => {
  let calls = 0; const gateway = g.createGateway({ transport: async () => { calls++; throw Error('synthetic failure'); } });
  await gateway.start(); t.after(() => gateway.close()); assert.ok((await send(gateway)).error); assert.ok((await send(gateway)).error);
  assert.equal(calls, 1); assert.equal(gateway.records.filter(r => r.state === 'provider-usage').length, 0);
});
test('HTTP decoding rejects redirects, truncated chunks and content encodings', () => {
  const body = reply();
  const wire = Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n${body.length.toString(16)}\r\n`), body, Buffer.from('\r\n0\r\n\r\n')]);
  assert.ok(g.decodeHttp(wire).equals(body)); assert.throws(() => g.decodeHttp(wire.subarray(0, wire.length - 1)));
  assert.throws(() => g.decodeHttp(Buffer.from('HTTP/1.1 302 Found\r\nLocation: https://example.test\r\n\r\n')), /upstream-http-302/);
  assert.throws(() => g.decodeHttp(Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Encoding: gzip\r\n\r\n')), /unexpected-upstream-content/);
});
test('the actual TLS transport uses verified fixed-host HTTP and opaque native authentication', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), tls = require('node:tls');
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-trial-tls-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = path.join(dir, 'test.key'), cert = path.join(dir, 'test.crt');
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  let wire; const server = tls.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, socket => {
    let bytes = Buffer.alloc(0);
    socket.on('data', b => {
      bytes = Buffer.concat([bytes, b]); const frame = g.nativeFrame(bytes, '/responses'); if (!frame) return;
      wire = frame;
      const body = reply(); socket.end(Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`), body]));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const connect = tls.connect;
  t.mock.method(tls, 'connect', options => {
    assert.equal(options.host, 'api.deepseek.com'); assert.equal(options.servername, 'api.deepseek.com');
    assert.equal(options.rejectUnauthorized, true); assert.deepEqual(options.ALPNProtocols, ['http/1.1']);
    return connect({ ...options, host: '127.0.0.1', port: server.address().port, servername: 'localhost', ca: fs.readFileSync(cert) });
  });
  const auth = Buffer.from('Authorization: Bearer synthetic-only');
  const result = await g.liveTransport(g.requestBody(1), auth, () => {});
  assert.ok(result.equals(reply())); assert.ok(wire.authorization.equals(auth)); assert.equal(wire.body.max_output_tokens, 1024);
});

test('terminal failures retain reported integer usage before validation stops the trial', async t => {
  for (const [type, changes, expected] of [
    ['response.incomplete', { output_tokens: 1024 }, 'provider-not-completed'],
    ['response.failed', {}, 'provider-not-completed'],
    ['response.completed', { input_tokens: 2001 }, 'provider-usage-exceeded-limit'],
    ['response.completed', { output_tokens: 1025 }, 'provider-usage-exceeded-limit'],
    ['response.completed', { server_tool_use: { tool_search: 1, tool_fetch: 0 } }, 'unexpected-server-tool'],
  ]) {
    const event = JSON.parse(reply(1, changes).toString().slice(6));
    event.type = type; event.response.status = type.split('.')[1];
    event.response.usage.output_tokens_details = { reasoning_tokens: 3 };
    const gateway = g.createGateway({ transport: async () => Buffer.from('data: ' + JSON.stringify(event) + '\n\n') });
    await gateway.start(); t.after(() => gateway.close());
    assert.ok((await send(gateway)).error);
    const raw = gateway.records.find(r => r.state === 'provider-usage-raw');
    assert.ok(raw); assert.equal(raw.inputTokens, changes.input_tokens ?? 100);
    assert.equal(raw.outputTokens, changes.output_tokens ?? 20); assert.equal(raw.reasoningTokens, 3);
    assert.ok(gateway.records.find(r => r.state === 'provider-usage').estimatedMicros > 0);
    assert.equal(gateway.records.find(r => r.state === 'stopped').code, expected);
    assert.ok((await send(gateway)).error); assert.equal(gateway.requestCount, 1);
  }
});
test('a partial usage receipt keeps known integers without recording provider strings', async t => {
  const event = JSON.parse(reply(1, { input_tokens_details: {}, output_tokens: 'PRIVATE_USAGE_CANARY' }).toString().slice(6));
  const gateway = g.createGateway({ transport: async () => Buffer.from('data: ' + JSON.stringify(event) + '\n\n') });
  await gateway.start(); t.after(() => gateway.close()); assert.ok((await send(gateway)).error);
  const raw = gateway.records.find(r => r.state === 'provider-usage-raw');
  assert.equal(raw.inputTokens, 100); assert.equal(raw.outputTokens, null); assert.equal(raw.cachedInputTokens, null);
  assert.equal(gateway.records.filter(r => r.state === 'provider-usage').length, 0);
  assert.ok(!JSON.stringify(gateway.records).includes('PRIVATE_USAGE_CANARY'));
});
test('a receipt write failure closes owned sockets before any upstream attempt', async t => {
  let calls = 0;
  const gateway = g.createGateway({ record: () => { throw Error('synthetic disk failure'); }, transport: async () => { calls++; return reply(); } });
  await gateway.start(); t.after(() => gateway.close()); assert.ok((await send(gateway)).error); assert.equal(calls, 0);
});
