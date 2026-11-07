const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { randomUUID } = require('node:crypto'), { once } = require('node:events');
const { WebSocketServer } = require('ws');
const { LegacyCodex } = require('../legacy-codex.cjs');
const { nativeOutboxCall } = require('../computer-use-outbox-native.cjs');

// Actual retained connection and native event parser; only the native server
// is synthetic. No provider, model, GUI, settings write or original agent.
async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync('/private/tmp/naw-midturn-'), socket = path.join(dir, 'native.sock');
  const server = http.createServer(), wss = new WebSocketServer({ server }), calls = [];
  const record = { id: 'sender', nativeId: randomUUID(), provider: 'codex', messages: [] };
  const identity = { nativeId: record.nativeId, sessionId: 'session-current', turnId: 'turn-current', callId: 'call-current' };
  const args = { recipient_id: 'recipient', message: 'A new productive task\n  exact body  ' };
  let peer, metadataReply;
  const target = new LegacyCodex(record);
  t.after(async () => {
    target.close(); for (const ws of wss.clients) ws.terminate(); wss.close();
    await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true });
  });
  wss.on('connection', ws => {
    peer = ws; ws.on('message', bytes => {
      const m = JSON.parse(bytes); calls.push(m);
      if (m.id === undefined) return;
      const reply = result => ws.send(JSON.stringify({ id: m.id, result }));
      switch (m.method) {
        case 'initialize': return reply({ userAgent: 'codex/0.164.0' });
        case 'thread/loaded/list': return reply({ data: [record.nativeId], nextCursor: null });
        case 'thread/resume': return reply({ model: 'synthetic', reasoningEffort: null,
          thread: { id: record.nativeId, sessionId: identity.sessionId, status: { type: 'active', activeFlags: [] } } });
        case 'thread/items/list': return reply({ data: [], nextCursor: null });
        case 'thread/turns/list':
          if (m.params.limit === 1) {
            assert.deepEqual(m.params, { threadId: record.nativeId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
            if (options.holdMetadata) { metadataReply = reply; return; }
            return reply(options.metadata || { data: [{ id: identity.turnId, status: 'inProgress', itemsView: 'notLoaded', items: [] }], nextCursor: null });
          }
          return reply({ data: [{ id: identity.turnId, status: 'inProgress', itemsView: 'notLoaded', items: [] }], nextCursor: null });
        default: assert.fail(`Unexpected native operation: ${m.method}`);
      }
    });
  });
  await new Promise(resolve => server.listen(socket, resolve)); fs.chmodSync(socket, 0o600);
  await target.connect(socket); await target.adapter.turnMetadataHydration;
  assert.equal(target.adapter.turnId, null); // No turn/started occurred after attachment.
  assert.equal(target.state, 'working');
  const notify = async (method, params) => {
    const received = once(target.rpc, 'event');
    peer.send(JSON.stringify({ method, params: { threadId: record.nativeId, ...params } }));
    await received;
  };
  const emit = (method, item, turnId = identity.turnId) => notify(method, { turnId, item });
  const item = { id: identity.callId, type: 'mcpToolCall', server: 'native_outbox', tool: 'workspace_outbox',
    arguments: args, status: 'inProgress' };
  const metadataCalls = () => calls.filter(c => c.method === 'thread/turns/list' && c.params.limit === 1);
  return { target, identity, args, calls, emit, notify, item, metadataCalls, release: value => metadataReply(value), metadataPending: () => Boolean(metadataReply) };
}
test('retained attachment during the original turn can prove its later live outbox call without adopting UI turn state', async t => {
  const f = await fixture(t); await f.emit('item/started', f.item);
  const proof = await nativeOutboxCall(f.target.adapter, f.identity, f.args, AbortSignal.timeout(1000));
  assert.equal(proof.valid(), true); assert.equal(f.target.adapter.turnId, null);
  assert.equal(f.metadataCalls().length, 1);
  await assert.rejects(nativeOutboxCall(f.target.adapter, f.identity, f.args, AbortSignal.timeout(1000)));
  await f.emit('item/completed', { ...f.item, status: 'completed' });
  assert.equal(proof.valid(), false);
  // A late duplicate start must not revive the consumed/completed call.
  await f.emit('item/started', f.item);
  await assert.rejects(nativeOutboxCall(f.target.adapter, f.identity, f.args, AbortSignal.timeout(80)));
  assert.equal(f.metadataCalls().length, 1);
});
test('unknown-turn metadata must name the latest active original turn and contain no loaded items', async t => {
  for (const data of [[], [{ id: 'other', status: 'inProgress', itemsView: 'notLoaded', items: [] }],
    [{ id: 'turn-current', status: 'completed', itemsView: 'notLoaded', items: [] }],
    [{ id: 'turn-current', status: 'inProgress', items: [] }],
    [{ id: 'turn-current', status: 'inProgress', items: [{ type: 'agentMessage', text: 'PRIVATE' }] }]]) {
    const f = await fixture(t, { metadata: { data, nextCursor: null } }); await f.emit('item/started', f.item);
    await assert.rejects(nativeOutboxCall(f.target.adapter, f.identity, f.args, AbortSignal.timeout(500)));
    assert.equal(f.target.adapter.turnId, null); assert.ok(f.calls.every(c => !/^(turn\/|thread\/goal\/|config\/)/.test(c.method)));
  }
});
test('an item completed before the tool request cannot be revived by delayed start', async t => {
  const f = await fixture(t); await f.emit('item/completed', { ...f.item, status: 'completed' });
  await f.emit('item/started', f.item);
  await assert.rejects(nativeOutboxCall(f.target.adapter, f.identity, f.args, AbortSignal.timeout(80)));
  assert.equal(f.metadataCalls().length, 0);
});
test('mid-turn metadata is rejected if the original connection changes while its response is held', async t => {
  const f = await fixture(t, { holdMetadata: true }); await f.emit('item/started', f.item);
  const pending = nativeOutboxCall(f.target.adapter, f.identity, f.args, AbortSignal.timeout(1000));
  const rejected = assert.rejects(pending);
  for (let i = 0; i < 50 && !f.metadataPending(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.metadataPending(), true);
  const original = f.target.adapter.host.rpc; f.target.adapter.host.rpc = {};
  f.release({ data: [{ id: f.identity.turnId, status: 'inProgress', itemsView: 'notLoaded', items: [] }], nextCursor: null });
  await rejected; f.target.adapter.host.rpc = original;
});
test('completion or cancellation during the metadata read cannot leave a usable proof', async t => {
  for (const cancel of [false, true]) {
    const f = await fixture(t, { holdMetadata: true }); await f.emit('item/started', f.item);
    const abort = new AbortController();
    const pending = nativeOutboxCall(f.target.adapter, f.identity, f.args, abort.signal), rejected = assert.rejects(pending);
    for (let i = 0; i < 50 && !f.metadataPending(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.metadataPending(), true);
    if (cancel) abort.abort(); else await f.emit('item/completed', { ...f.item, status: 'completed' });
    f.release({ data: [{ id: f.identity.turnId, status: 'inProgress', itemsView: 'notLoaded', items: [] }], nextCursor: null });
    await rejected;
    assert.equal(f.target.adapter.turnId, null);
  }
});
test('a full bounded candidate map still invalidates its completed call', async t => {
  const f = await fixture(t); await f.emit('item/started', f.item);
  const proof = await nativeOutboxCall(f.target.adapter, f.identity, f.args, AbortSignal.timeout(1000));
  for (let i = 1; i < 64; i++) await f.emit('item/started', { ...f.item, id: `other-${i}` });
  assert.equal(f.target.adapter.outboxMcpCalls.size, 64);
  await f.emit('item/completed', { ...f.item, status: 'completed' });
  assert.equal(proof.valid(), false);
});
test('original turn completion revokes mid-turn proof even without an MCP completion event', async t => {
  const f = await fixture(t); await f.emit('item/started', f.item);
  const proof = await nativeOutboxCall(f.target.adapter, f.identity, f.args, AbortSignal.timeout(1000));
  await f.notify('turn/completed', { turn: { id: f.identity.turnId, status: 'completed', items: [] } });
  assert.equal(proof.valid(), false); assert.equal(f.target.adapter.turnId, null);
});
