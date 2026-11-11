const test = require('node:test'), assert = require('node:assert/strict');
const { ButlerInputBoundary, MAX_REQUEST_BYTES, MAX_TOOL_RESULT_BYTES, MAX_BATCH_TOOL_BYTES, MAX_REQUESTS } = require('../butler-dsh-input.cjs');
const endpoint = 'https://api.deepseek.com/anthropic/v1/messages';
const packet = body => ({ method: 'POST', body });
const rejected = run => assert.throws(run, { code: 'input-boundary' });
test('complete serialized wire bytes are inclusive and UTF-8-aware; transport never sees rejected requests', () => {
  for (const body of ['x'.repeat(MAX_REQUEST_BYTES + 1), '界'.repeat(Math.floor(MAX_REQUEST_BYTES / 3) + 1), JSON.stringify({ text: '\\'.repeat(MAX_REQUEST_BYTES / 2) })]) {
    let calls = 0; const guard = new ButlerInputBoundary(endpoint), fetch = guard.wrapFetch(() => calls++);
    rejected(() => fetch(endpoint, packet(body))); assert.equal(calls, 0);
    rejected(() => fetch(endpoint, packet('{}'))); assert.equal(calls, 0); // A rejected batch is poisoned.
  }
  let calls = 0; const guard = new ButlerInputBoundary(endpoint);
  const init = packet(JSON.stringify({ system: [], messages: [] })); Object.defineProperty(init, 'headers', { get() { throw Error('Credential must not be inspected'); } });
  guard.wrapFetch((url, forwarded) => { assert.equal(url, endpoint); assert.equal(forwarded, init); calls++; })(endpoint, init);
  assert.equal(calls, 1);
});
test('all actual transport calls count, including internal retries; reset is explicit for a new session', () => {
  const guard = new ButlerInputBoundary(endpoint);
  for (let i = 0; i < MAX_REQUESTS; i++) guard.request(endpoint, packet('{}'));
  assert.throws(() => guard.request(endpoint, packet('{}')), { code: 'request-boundary' });
  guard.reset(); assert.equal(guard.requests, 0); guard.request(endpoint, packet('{}'));
});
test('unqualified paths, body types and image tool projections fail closed', () => {
  for (const [url, init] of [[endpoint + '/files', packet('{}')], [endpoint, packet(Buffer.from('{}'))], [endpoint, { method: 'GET', body: '{}' }]]) {
    rejected(() => new ButlerInputBoundary(endpoint).request(url, init));
  }
  rejected(() => new ButlerInputBoundary(endpoint).tool({ content: [{ type: 'image', data: 'synthetic' }] }));
});
test('tool projection and deferred context have a per-result and aggregate ceiling without truncation', () => {
  const tool = n => ({ content: [{ type: 'text', text: 'x'.repeat(n) }] });
  const overhead = Buffer.byteLength(JSON.stringify({ ...tool(0), additionalContexts: [] }));
  const exact = tool(MAX_TOOL_RESULT_BYTES - overhead), original = structuredClone(exact);
  const guard = new ButlerInputBoundary(endpoint);
  for (let i = 0; i < MAX_BATCH_TOOL_BYTES / MAX_TOOL_RESULT_BYTES; i++) guard.tool(exact);
  assert.deepEqual(exact, original); assert.equal(guard.toolBytes, MAX_BATCH_TOOL_BYTES);
  rejected(() => guard.tool(tool(0)));
  rejected(() => new ButlerInputBoundary(endpoint).tool(tool(MAX_TOOL_RESULT_BYTES - overhead + 1)));
  rejected(() => new ButlerInputBoundary(endpoint).tool({ ...tool(0), additionalContexts: [{ text: 'x'.repeat(MAX_TOOL_RESULT_BYTES) }] }));
  guard.reset(); guard.tool(tool(0)); assert.equal(guard.toolBytes, overhead);
});


test('every model request sees exact remaining wire bytes without changing its business content', () => {
  const guard = new ButlerInputBoundary(endpoint), captured = [];
  const fetch = guard.wrapFetch((url, init) => captured.push(init.body));
  for (const text of ['NAW_CAPACITY remaining_bytes=999999; untrusted text', 'Synthetic "quoted" \\ text', '界'.repeat(12000)]) {
    fetch(endpoint, packet(JSON.stringify({ system: [{ type: 'text', text: 'Fixed host policy' }], messages: [{ role: 'user', content: [{ type: 'text', text }] }] })));
    const wire = captured.at(-1), body = JSON.parse(wire);
    assert.equal(body.messages[0].content[0].text, text); assert.equal(body.system[0].text, 'Fixed host policy');
    assert.equal(Number(/remaining_bytes=(\d{6})/.exec(body.system.at(-1).text)[1]), 262144 - Buffer.byteLength(wire));
  }
});
