const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const app = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..');
const { Codex } = require(path.join(app, 'adapters.cjs'));
const { LegacyCodex } = require(path.join(app, 'legacy-codex.cjs'));
const { LegacyInput } = require(path.join(app, 'legacy-input.cjs'));
const { bindOriginalOutbox } = require(path.join(app, 'computer-use-outbox-owner.cjs'));
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-retained-outbox-'));
  const identity = { nativeId: 'caller-native', sessionId: 'caller-session', turnId: 'caller-turn', callId: 'owned-call' };
  const args = { recipient_id: 'receiver', message: '  Read the task.\r\n\t保留原文 🙂.  ' };
  const records = [
    { id: 'caller', name: 'Caller', nativeId: identity.nativeId, pid: 201, owner: 'caller-view', memberRevision: 1 },
    { id: 'receiver', name: 'Receiver', nativeId: 'receiver-native', pid: 202, owner: 'receiver-view', memberRevision: 2 },
  ].map(record => ({ ...record, provider: 'codex', roomId: 'shared', controlRevision: 4,
    draft: 'UNSENT_PRIVATE_DRAFT_' + record.id, messages: [] }));
  const bridge = new LegacyInput(root), calls = [], starts = [], natives = [], bindings = [];
  let release;
  const heldACK = new Promise(resolve => { release = resolve; });
  for (const record of records) {
    let adapter;
    const rpc = { nativeVersion: '0.164.0', async call(method, params) {
      // Record before assertions: observation-error catches must not hide an
      // unexpected settings/history/write RPC from the final trace check.
      calls.push([record.id, method]);
      assert.equal(record.id, 'receiver'); assert.equal(method, 'turn/start', 'No backend/history/connection metadata reads');
      starts.push(params);
      if (mode === 'unknown') throw Error('Controlled RPC outcome unknown');
      if (mode === 'events-before-ACK') {
        adapter.event({ method: 'turn/started', params: { threadId: record.nativeId, turn: { id: 'receiver-turn' } } }, rpc);
        adapter.event({ method: 'item/completed', params: { threadId: record.nativeId, turnId: 'receiver-turn', item: {
          id: 'owned-input', type: 'userMessage', clientId: params.clientUserMessageId,
          content: [{ type: 'text', text: args.message }] } } }, rpc);
        adapter.event({ method: 'item/started', params: { threadId: record.nativeId, turnId: 'receiver-turn', item: {
          id: 'owned-command', type: 'commandExecution', command: 'git status --short', status: 'inProgress' } } }, rpc);
        await heldACK;
      }
      return { turn: { id: 'receiver-turn' } };
    } };
    const native = new LegacyCodex(record);
    adapter = new Codex(native.record, { rpc, codexTargets: new Map() });
    // Seed an already-established transport. connect/start and its socket,
    // version qualification and settings discovery are deliberately untested.
    Object.assign(native, { adapter, rpc, connected: true, state: record.id === 'caller' ? 'working' : 'idle', subscribed: true });
    adapter.chatAvailable = true;
    adapter.on('state', state => { native.state = state; });
    if (record.id === 'caller') {
      adapter.turnId = identity.turnId; adapter.nativeSessionId = identity.sessionId;
      adapter.event({ method: 'item/started', params: { threadId: record.nativeId, turnId: identity.turnId,
        item: { id: identity.callId, type: 'mcpToolCall', server: 'native_outbox', tool: 'workspace_outbox',
          arguments: args, status: 'inProgress' } } }, rpc);
    }
    natives.push(native); bridge.targets.set(record.id, { record, native, submission: native });
  }
  const entry = { key: 'retained', client: { call() { throw Error('No initial/backend reads'); } },
    state: { sessions: records, room: { messages: [] } } };
  const control = { legacyInput: bridge, generations: new Map(), manualEpoch: 1, maintenance: new Set() };
  const client = { entries: [entry], control, socket: { destroyed: false }, route: () => entry };
  const contexts = records.map(record => ({ client, view: { owner: record.owner }, win: { isDestroyed: () => false } }));
  const deps = { contexts: () => contexts, roomState: { assertAvailable() {} } };
  t.after(() => {
    release(); for (const binding of bindings) binding.close(); bridge.close();
    fs.rmSync(root, { recursive: true, force: true });
    assert.deepEqual(calls, [['receiver', 'turn/start']], 'No swallowed or cleanup RPC can escape this trace');
  });
  const bind = async () => { const binding = await bindOriginalOutbox(deps, identity, args, AbortSignal.timeout(1000)); bindings.push(binding); return binding; };
  const preserved = records.map(({ id, owner, controlRevision, memberRevision, draft, nativeId }) => ({ id, owner, controlRevision, memberRevision, draft, nativeId }));
  const assertPreserved = () => assert.deepEqual(records.map(({ id, owner, controlRevision, memberRevision, draft, nativeId }) =>
    ({ id, owner, controlRevision, memberRevision, draft, nativeId })), preserved);
  return { args, records, bridge, calls, starts, natives, bind, release, assertPreserved };
}

test('actual retained send stack ACK creates no native receipt or first-command proof', { timeout: 3000 }, async t => {
  const f = await fixture(t, 'ACK-only'), binding = await f.bind();
  const tag = await binding.forwardOnce(), receipts = [];
  const unsubscribe = binding.watchReceipt({ messageId: tag }, value => receipts.push(value));
  await tick(); assert.equal(f.starts.length, 1); assert.equal(f.bridge.records[0].status, 'accepted');
  assert.equal(receipts.length, 0, 'The native input event, not a turn/start ACK, certifies receipt');
  unsubscribe(); f.assertPreserved();
});

test('actual adapter events preceding ACK retain exact target/body/tag, sender and first command', { timeout: 3000 }, async t => {
  const f = await fixture(t, 'events-before-ACK'), binding = await f.bind();
  const sending = binding.forwardOnce();
  try {
    await tick(); assert.equal(f.starts.length, 1);
    assert.equal(f.bridge.records[0].status, 'unconfirmed', 'RPC ACK is still held');
    assert.equal(f.starts[0].threadId, 'receiver-native'); assert.equal(f.starts[0].input[0].text, f.args.message);
  } finally { f.release(); }
  const tag = await sending, receipts = [];
  assert.equal(f.bridge.records[0].status, 'accepted');
  const unsubscribe = binding.watchReceipt({ messageId: tag }, value => receipts.push(value));
  assert.equal(receipts.length, 1); const receipt = receipts[0];
  assert.equal(receipt.nativeReceived, true); assert.equal(receipt.nativeId, 'receiver-native');
  assert.equal(receipt.messageId, tag); assert.equal(receipt.inputTag, tag); assert.equal(receipt.recipientId, 'receiver');
  assert.equal(receipt.turnId, 'receiver-turn'); assert.equal(receipt.firstCommand.command, 'git status --short');
  const row = f.bridge.sharedMessages().find(row => row.id === tag);
  assert.equal(row.sessionId, 'caller'); assert.equal(row.senderNativeId, 'caller-native');
  assert.equal(row.recipientId, 'receiver'); assert.equal(row.name, 'Caller → Receiver'); assert.equal(row.text, f.args.message);
  assert.equal(f.natives[0].adapter.outboxMcpCalls.get('owned-call').outboxConsumed, true);
  await assert.rejects(f.bind(), /original native outbox call could not be verified/);
  assert.equal(f.starts.length, 1); assert.equal(f.bridge.records.length, 1);
  unsubscribe(); f.assertPreserved();
});

test('unknown RPC failure stays unconfirmed and repeated original native call cannot dispatch again', { timeout: 3000 }, async t => {
  const f = await fixture(t, 'unknown'), binding = await f.bind();
  await assert.rejects(binding.forwardOnce(), /Controlled RPC outcome unknown/);
  await tick(); assert.equal(f.starts.length, 1); assert.equal(f.bridge.records.length, 1);
  assert.equal(f.bridge.records[0].status, 'unconfirmed');
  assert.equal(f.natives[0].adapter.outboxMcpCalls.get('owned-call').outboxConsumed, true);
  await assert.rejects(f.bind(), /original native outbox call could not be verified/); await tick();
  assert.equal(f.starts.length, 1); assert.equal(f.bridge.records.length, 1); f.assertPreserved();
});
