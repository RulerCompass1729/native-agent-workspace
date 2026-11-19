const test = require('node:test'), assert = require('node:assert/strict'), { EventEmitter } = require('node:events');
const { parseTrending, readSource, MAX_BYTES } = require('../regular-popup-source.cjs');
const { createWireGuard, priceUsage, selectWithDsh, MODEL, INSTRUCTION, createDshContext, tariff } = require('../regular-popup-dsh.cjs');
const html = '<article class="Box-row"><h2><a href="/example/tool">example / tool</a></h2><p>Local &amp; private <b>notes</b></p></article>';
test('source parser extracts only repository candidates and plain public descriptions', () => {
  assert.deepEqual(parseTrending(html), [{ id: 'repo-0', title: 'example/tool', description: 'Local & private notes', url: 'https://github.com/example/tool' }]);
  for (const value of ['', '<article class="Box-row">broken</article>', html.replace('/example/tool', 'https://other.example/x')]) assert.throws(() => parseTrending(value));
});
function fakeGet({ status = 200, body = html, headers = { 'content-type': 'text/html' }, hang = false } = {}) {
  let calls = 0, request;
  return { get: (url, options, callback) => {
    calls++; assert.equal(url, 'https://github.com/trending'); assert.equal(options.headers.Cookie, undefined); assert.equal(options.headers.Authorization, undefined);
    const req = new EventEmitter(); req.destroy = error => queueMicrotask(() => req.emit('error', error || Error('closed'))); request = req;
    if (!hang) queueMicrotask(() => { const res = new EventEmitter(); res.statusCode = status; res.headers = headers; res.destroy = () => {}; callback(res); res.emit('data', Buffer.from(body)); res.emit('end'); }); return req;
  }, calls: () => calls, request: () => request };
}
test('bounded HTTPS read succeeds using a fake transport, with no real requests', async () => {
  const f = fakeGet(); assert.equal((await readSource({}, { get: f.get }))[0].title, 'example/tool'); assert.equal(f.calls(), 1);
});
test('redirects, MIME mismatch, oversized body, timeout and abort stop source processing', async () => {
  for (const options of [{ status: 302 }, { headers: { 'content-type': 'application/json' } }, { body: 'x'.repeat(MAX_BYTES + 1) }, { hang: true }]) {
    const f = fakeGet(options); await assert.rejects(readSource({}, { get: f.get, timeoutMs: 10 })); assert.equal(f.calls(), 1);
  }
  const c = new AbortController(), f = fakeGet({ hang: true }), pending = readSource({ signal: c.signal }, { get: f.get }); c.abort(); await assert.rejects(pending);
});
const metered = { inputTokens: 1000, cachedInputTokens: 100, outputTokens: 100, totalTokens: 1200, providerAt: Date.parse('2026-11-18T02:00:00Z'), tier: 'peak' };
const usageEvents = input => [
  { type: 'message_start', message: { model: MODEL, usage: { input_tokens: input, cache_read_input_tokens: 100 } } },
  { type: 'message_delta', usage: { output_tokens: 100 } }, { type: 'message_stop' },
];
const sse = events => events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('');
const wire = { model: MODEL, max_tokens: 1200, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: [{ type: 'text', text: '{"concern":"tools","candidates":[]}' }] }], system: INSTRUCTION, stream: true };
test('wire guard allows exactly one fixed Flash request and derives real usage, without network', async () => {
  let calls = 0; const guard = createWireGuard(async () => { calls++; return new Response(sse(usageEvents(1000)), { headers: { 'content-type': 'text/event-stream', date: 'Wed, 18 Nov 2026 02:00:00 GMT' } }); });
  const response = await guard.fetch('https://api.deepseek.com/anthropic/v1/messages', { method: 'POST', body: JSON.stringify(wire) }); await response.text();
  assert.equal(calls, 1); assert.deepEqual(guard.usage(), metered); assert.equal(priceUsage(guard.usage()), 421);
  await assert.rejects(guard.fetch('https://api.deepseek.com/anthropic/v1/messages', { method: 'POST', body: JSON.stringify(wire) })); assert.equal(calls, 1);
});
test('wire guard rejects other routes/models/tools, oversized inputs and excess output before transport', async () => {
  for (const changes of [{ model: 'deepseek-v4-pro' }, { tools: [{ name: 'execute' }] }, { max_tokens: 1201 }, { messages: [{ role: 'user', content: 'x'.repeat(17000) }] }]) {
    let calls = 0; const guard = createWireGuard(() => { calls++; }); await assert.rejects(guard.fetch('https://api.deepseek.com/anthropic/v1/messages', { method: 'POST', body: JSON.stringify({ ...wire, ...changes }) })); assert.equal(calls, 0);
  }
  let calls = 0; const guard = createWireGuard(() => { calls++; }); await assert.rejects(guard.fetch('https://other.example/messages', { method: 'POST', body: JSON.stringify(wire) })); assert.equal(calls, 0);
});
test('missing/inconsistent raw provider usage is unknown rather than free', async () => {
  for (const events of [usageEvents(1000).slice(1), usageEvents(1000).filter(e => e.type !== 'message_delta'), usageEvents(-1), usageEvents(20000)]) {
    const guard = createWireGuard(async () => new Response(sse(events))); await guard.fetch('https://api.deepseek.com/anthropic/v1/messages', { method: 'POST', body: JSON.stringify(wire) }); assert.equal(guard.usage(), null);
  }
  for (const u of [null, {}, { inputTokens: -1 }, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 1 }]) assert.equal(priceUsage(u), null);
});
test('DSH one-shot receives only explicit input, fixed Flash and zero tools; model cost is ignored', async () => {
  const payload = { concern: 'tools', candidates: [{ id: 'x', title: 'x', description: 'x' }] }; let calls = 0;
  const ctx = { llm: { async *stream(options) { calls++; assert.equal(options.model, MODEL); assert.deepEqual(options.tools, []); assert.deepEqual(JSON.parse(options.messages[0].content[0].text), payload);
    yield { type: 'text-delta', text: '{"picks":[{"id":"x","why":"fits"}]}' }; yield { type: 'finish', reason: { kind: 'stop' } }; } } };
  const result = await selectWithDsh(payload, { ctx, usage: () => metered });
  assert.equal(calls, 1); assert.equal(result.costMicros, 421); assert.equal(result.picks[0].id, 'x');
});
test('real pinned DSH composition mounts only llm/provider with privacy applied and no requests', async () => {
  const old = global.fetch; let calls = 0; global.fetch = () => { calls++; throw Error('Real fetch forbidden'); };
  let host; try { host = await createDshContext(); assert.equal(Boolean(host.ctx.get('tools')), false); assert.equal(Boolean(host.ctx.get('agents')), false); assert.equal(Boolean(host.ctx.get('mcp')), false); assert.equal(calls, 0); }
  finally { await host?.close(); global.fetch = old; }
});

test('tariff uses qualified UTC windows and a conservative bound for unqualified calendars', () => {
  assert.equal(priceUsage(metered), 421);
  const off = { ...metered, providerAt: Date.parse('2026-11-18T12:00:00Z'), tier: 'offpeak' }; assert.equal(priceUsage(off), 211);
  for (const date of ['2026-01-01T02:00:00Z', '2026-11-21T02:00:00Z']) assert.equal(tariff(Date.parse(date)), 'offpeak');
  for (const date of ['2027-01-05T02:00:00Z', '2026-11-18T04:00:00Z']) assert.equal(tariff(Date.parse(date)), 'peak-bound');
  assert.equal(priceUsage({ ...metered, tier: 'offpeak' }), null);
  assert.equal(priceUsage({ ...metered, inputTokens: 16000, cachedInputTokens: 0, outputTokens: 1200, totalTokens: 17200 }), 6240);
});
test('confirmed token counts survive an unconfirmed tariff instead of being priced at an assumed rate', async () => {
  const guard = createWireGuard(async () => new Response(sse(usageEvents(1000))));
  await guard.fetch('https://api.deepseek.com/anthropic/v1/messages', { method: 'POST', body: JSON.stringify(wire) });
  assert.equal(guard.usage().inputTokens, 1000); assert.equal(guard.usage().tier, 'unknown'); assert.equal(priceUsage(guard.usage()), null);
});
