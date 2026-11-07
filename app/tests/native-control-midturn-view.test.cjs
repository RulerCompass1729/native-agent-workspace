const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const vm = require('node:vm'), Module = require('node:module');
const { randomUUID } = require('node:crypto'), { once } = require('node:events');
const { WebSocketServer } = require('ws');
const app = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..');
const { LegacyCodex } = require(path.join(app, 'legacy-codex.cjs'));
const { LegacyInput } = require(path.join(app, 'legacy-input.cjs'));
const { bindOriginalOutbox } = require(path.join(app, 'computer-use-outbox-owner.cjs'));

// Real retained connections, event reducers and delivery code. Only the native
// server and isolated UI/lease are synthetic; no engine or command is launched.
async function fixture(t) {
  const dir = fs.mkdtempSync('/private/tmp/naw-midturn-flow-'); fs.chmodSync(dir, 0o700);
  const socket = path.join(dir, 'native.sock'), server = http.createServer();
  const wss = new WebSocketServer({ server }), calls = [], starts = [], peers = new Map(), unexpected = [];
  const identity = { nativeId: randomUUID(), sessionId: 'sender-session', turnId: 'already-running', callId: 'outbox-call' };
  const args = { recipient_id: 'recipient', message: '  Exact midturn task.\r\n\t保留正文 🙂.  ' };
  const records = [
    { id: 'sender', name: 'Sender', nativeId: identity.nativeId, pid: 201, owner: 'observer-view', memberRevision: 1 },
    { id: 'recipient', name: 'Recipient', nativeId: randomUUID(), pid: 202, owner: 'original-human-view', memberRevision: 2 },
  ].map(record => ({ ...record, provider: 'codex', roomId: 'shared', controlRevision: 4,
    liveDraft: 'PRIVATE UNSENT ' + record.id, messages: [] }));
  const saved = structuredClone(records), sharedDraft = { text: 'PRIVATE SHARED UNSENT', recipient: 'sender' };
  const sharedBefore = structuredClone(sharedDraft), bridge = new LegacyInput(dir), natives = [], bindings = [];
  t.after(async () => {
    for (const b of bindings) b.close(); bridge.close(); for (const n of natives) n.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(unexpected, []); assert.ok(calls.length <= 20, 'Bounded synthetic RPC inventory');
    assert.equal(fs.existsSync(dir), false);
    t.diagnostic(JSON.stringify({ syntheticRpc: calls.length, methods: calls.map(c => c.method), ownedSocketRemoved: true }));
  });
  wss.on('connection', ws => ws.on('message', bytes => {
    const m = JSON.parse(bytes); if (m.id === undefined) return; calls.push(m);
    const reply = result => ws.send(JSON.stringify({ id: m.id, result }));
    const record = records.find(r => r.nativeId === m.params?.threadId);
    switch (m.method) {
      case 'initialize': return reply({ userAgent: 'codex/0.164.0' });
      case 'thread/loaded/list': return reply({ data: records.map(r => r.nativeId), nextCursor: null });
      case 'thread/resume':
        assert.ok(record); assert.deepEqual(m.params, { threadId: record.nativeId, excludeTurns: true }); peers.set(record.id, ws);
        return reply({ model: 'synthetic', reasoningEffort: null, thread: { id: record.nativeId,
          sessionId: record.id === 'sender' ? identity.sessionId : 'recipient-session',
          status: { type: record.id === 'sender' ? 'active' : 'idle', activeFlags: [] } } });
      case 'thread/items/list': assert.ok(record); return reply({ data: [], nextCursor: null });
      case 'thread/turns/list':
        assert.ok(record);
        if (m.params.limit === 1) {
          assert.equal(record.id, 'sender');
          assert.deepEqual(m.params, { threadId: identity.nativeId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
        }
        return reply({ data: record.id === 'sender' ? [{ id: identity.turnId, status: 'inProgress', itemsView: 'notLoaded', items: [] }] : [], nextCursor: null });
      case 'turn/start':
        assert.equal(record?.id, 'recipient'); starts.push(m.params); return reply({ turn: { id: 'recipient-turn' } });
      default:
        unexpected.push(m.method); return ws.send(JSON.stringify({ id: m.id, error: { code: -32601, message: 'Unexpected synthetic RPC' } }));
    }
  }));
  await new Promise(resolve => server.listen(socket, resolve)); fs.chmodSync(socket, 0o600);
  for (const record of records) {
    const native = new LegacyCodex(record); natives.push(native);
    await native.connect(socket); await native.adapter.turnMetadataHydration;
    assert.equal(native.adapter.turnId, null); bridge.targets.set(record.id, { record, native, submission: native });
  }
  assert.equal(natives[0].state, 'working'); assert.equal(natives[1].state, 'idle');
  const entry = { key: 'retained', client: { call() { throw Error('No backend reads or input ownership claims'); } },
    state: { sessions: records, room: { messages: [] }, sharedDraft } };
  const control = { legacyInput: bridge, generations: new Map(), manualEpoch: 1, maintenance: new Set() };
  const client = { entries: [entry], control, socket: { destroyed: false }, route: () => entry };
  const contexts = [{ client, view: { owner: 'observer-view' }, win: { isDestroyed: () => false } }];
  assert.equal(contexts.length, 1); assert.notEqual(contexts[0].view.owner, records[1].owner);
  const notify = async (index, method, params) => {
    const received = once(natives[index].rpc, 'event');
    peers.get(records[index].id).send(JSON.stringify({ method, params: { threadId: records[index].nativeId, ...params } }));
    await received;
  };
  await notify(0, 'item/started', { turnId: identity.turnId, item: { id: identity.callId,
    type: 'mcpToolCall', server: 'native_outbox', tool: 'workspace_outbox', arguments: args, status: 'inProgress' } });
  const bind = async () => {
    const binding = await bindOriginalOutbox({ contexts: () => contexts, roomState: { assertAvailable() {} } },
      identity, args, AbortSignal.timeout(500)); bindings.push(binding); return binding;
  };
  return { dir, identity, args, records, natives, bridge, starts, calls, bind, notify,
    metadataCalls: () => calls.filter(c => c.method === 'thread/turns/list' && c.params.limit === 1),
    preserved() { assert.deepEqual(records, saved); assert.deepEqual(sharedDraft, sharedBefore); } };
}
async function core(t, binding, beforeInspectReturns = async () => {}) {
  const file = path.join(app, 'computer-use-outbox.cjs'), module = { exports: {} };
  vm.runInThisContext(Module.wrap(fs.readFileSync(file, 'utf8')), { filename: file })(module.exports, id => {
    if (id === './native-computer-use.cjs') return { createComputerUseViewLease: async config => {
      let closed = false; return { leaseFile: 'synthetic-midturn-lease', async close() {
        if (!closed) { closed = true; await config.dispose(); }
      } };
    } };
    if (id === './computer-use-outbox-native.cjs') return require(path.join(path.dirname(file), id));
    assert.equal(id, 'node:crypto'); return require(id);
  }, module, file, path.dirname(file));
  let send, watched = 0;
  const outbox = await module.exports.openOutbox(binding.grant, { ...binding,
    watchReceipt(...args) { watched++; return binding.watchReceipt(...args); },
    createView: async (_scope, actions) => {
      send = actions.send;
      return { owner: 'isolated-outbox-view', async inspect() {
        const facts = { ...binding.grant, ...binding.inspectGrant(), owner: 'isolated-outbox-view', body: binding.grant.text };
        assert.equal(facts.ready, true); await beforeInspectReturns(); return facts;
      }, target() {}, invoke() {}, showReceipt() {}, async close() {} };
    } });
  t.after(() => outbox.close()); return { outbox, send: () => send(), watched: () => watched };
}

test('midturn attachment delivers one exact task through one observer and actual native receipt reducers', { timeout: 4000 }, async t => {
  const f = await fixture(t), binding = await f.bind(), c = await core(t, binding);
  assert.equal(f.natives[0].adapter.turnId, null); assert.equal(f.metadataCalls().length, 1);
  await c.send(); assert.equal(f.starts.length, 1); assert.equal(c.watched(), 1);
  assert.equal(f.starts[0].threadId, f.records[1].nativeId); assert.equal(f.starts[0].input[0].text, f.args.message);
  assert.equal(c.outbox.receipt().status, 'delivery-unconfirmed'); assert.equal(f.bridge.sharedMessages()[0].status, 'unconfirmed');
  await f.notify(1, 'turn/started', { turn: { id: 'recipient-turn' } });
  await f.notify(1, 'item/completed', { turnId: 'recipient-turn', item: { id: 'native-input', type: 'userMessage',
    clientId: f.starts[0].clientUserMessageId, content: [{ type: 'text', text: f.args.message }] } });
  assert.equal(c.outbox.receipt().status, 'received');
  const command = { id: 'command', type: 'commandExecution', command: 'git status --short', status: 'inProgress' };
  await f.notify(1, 'item/started', { turnId: 'recipient-turn', item: command });
  assert.equal(c.outbox.receipt().firstCommand, null);
  await f.notify(1, 'item/completed', { turnId: 'recipient-turn', item: { ...command, status: 'completed', exitCode: 0,
    aggregatedOutput: 'PRIVATE_OUTPUT_MUST_NOT_ENTER_RECEIPT' } });
  const receipt = await c.outbox.wait({ timeoutMs: 100 });
  assert.equal(receipt.status, 'working'); assert.equal(receipt.retry, false);
  assert.equal(receipt.senderId, 'sender'); assert.equal(receipt.senderNativeId, f.identity.nativeId);
  assert.equal(receipt.recipient.id, 'recipient'); assert.equal(receipt.nativeId, f.records[1].nativeId);
  assert.equal(receipt.text, f.args.message); assert.equal(receipt.firstCommand.exitCode, 0);
  assert.equal(receipt.messageId, f.starts[0].clientUserMessageId); assert.equal(receipt.turnId, 'recipient-turn');
  assert.ok(!JSON.stringify(receipt).includes('PRIVATE_OUTPUT_MUST_NOT_ENTER_RECEIPT'));
  const row = f.bridge.sharedMessages()[0];
  assert.equal(row.id, receipt.messageId); assert.equal(row.sessionId, 'sender'); assert.equal(row.senderNativeId, f.identity.nativeId);
  assert.equal(row.recipientId, 'recipient'); assert.equal(row.text, f.args.message); assert.equal(row.status, 'submitted');
  await assert.rejects(c.send()); await assert.rejects(f.bind());
  assert.equal(f.starts.length, 1); assert.equal(f.bridge.records.length, 1); assert.equal(f.metadataCalls().length, 1);
  assert.equal(f.natives[0].adapter.turnId, null); f.preserved();
});

test('source turn ending after inspect revokes midturn grant at the real send site with no send or retry', { timeout: 4000 }, async t => {
  const f = await fixture(t), binding = await f.bind();
  const beforeListeners = f.natives[1].adapter.listenerCount('nativeAcceptedInput');
  const c = await core(t, binding, () => f.notify(0, 'turn/completed', {
    turn: { id: f.identity.turnId, status: 'completed', items: [] } }));
  await c.send();
  const receipt = c.outbox.receipt();
  assert.equal(receipt.status, 'unconfirmed'); assert.equal(receipt.retry, false);
  assert.equal(receipt.messageId, null); assert.equal(receipt.turnId, null); assert.equal(receipt.nativeReceived, false);
  assert.equal(receipt.firstCommand, null); assert.equal(c.watched(), 0);
  assert.equal(f.natives[0].adapter.outboxMcpCalls.get(f.identity.callId), null);
  assert.equal(f.natives[0].adapter.turnId, null); assert.equal(binding.inspectGrant().callerValid, false);
  assert.equal(f.starts.length, 0); assert.equal(f.bridge.records.length, 0); assert.equal(fs.existsSync(f.bridge.filename), false);
  assert.deepEqual(f.bridge.sharedMessages(), []); assert.deepEqual(f.natives[1].record.messages, []);
  await assert.rejects(c.send()); await assert.rejects(f.bind());
  assert.equal(f.starts.length, 0); assert.equal(f.metadataCalls().length, 1); f.preserved();
  binding.close(); assert.equal(f.natives[1].adapter.listenerCount('nativeAcceptedInput'), beforeListeners - 1);
});
