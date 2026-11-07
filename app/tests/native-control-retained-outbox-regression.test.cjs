const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const vm = require('node:vm'), Module = require('node:module');
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
        adapter.event({ method: 'item/completed', params: { threadId: record.nativeId, turnId: 'receiver-turn', item: {
          id: 'owned-command', type: 'commandExecution', command: 'git status --short', status: 'completed', exitCode: 0 } } }, rpc);
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
  const frame = (method, item, scope = {}) => natives[1].adapter.event({ method, params: {
    threadId: 'receiver-native', turnId: 'receiver-turn', ...scope, item } }, natives[1].rpc);
  const acceptInput = () => {
    natives[1].adapter.event({ method: 'turn/started', params: { threadId: 'receiver-native', turn: { id: 'receiver-turn' } } }, natives[1].rpc);
    frame('item/completed', { id: 'received-input', type: 'userMessage', clientId: starts[0].clientUserMessageId,
      content: [{ type: 'text', text: args.message }] });
  };
  return { args, records, bridge, calls, starts, natives, bind, release, assertPreserved, frame, acceptInput };
}

async function core(t, binding) {
  const file = path.join(app, 'computer-use-outbox.cjs'), module = { exports: {} };
  // Only the UI/Unix lease boundary is replaced. Core, owner, LegacyInput,
  // LegacyCodex and Codex.event are actual source; no provider is connected.
  vm.runInThisContext(Module.wrap(fs.readFileSync(file, 'utf8')), { filename: file })(module.exports, id => {
    if (id === './native-computer-use.cjs') return { createComputerUseViewLease: async config => {
      let closed = false; return { leaseFile: 'in-memory-command-lease', async close() {
        if (!closed) { closed = true; await config.dispose(); }
      } };
    } };
    if (id === './computer-use-outbox-native.cjs') return require(path.join(path.dirname(file), id));
    assert.equal(id, 'node:crypto'); return require(id);
  }, module, file, path.dirname(file));
  let send;
  const outbox = await module.exports.openOutbox(binding.grant, { ...binding, createView: async (_model, actions) => {
    send = actions.send;
    return { owner: 'owned-command-view', inspect: async () => ({ ...binding.grant, ...binding.inspectGrant(),
      owner: 'owned-command-view', body: binding.grant.text }), target() {}, invoke() {}, showReceipt() {}, async close() {} };
  } });
  t.after(() => outbox.close()); return { outbox, send: () => send() };
}

test('actual retained send stack ACK creates no native receipt or first-command proof', { timeout: 3000 }, async t => {
  const f = await fixture(t, 'ACK-only'), binding = await f.bind();
  const tag = await binding.forwardOnce(), receipts = [];
  const unsubscribe = binding.watchReceipt({ messageId: tag }, value => receipts.push(value));
  await tick(); assert.equal(f.starts.length, 1); assert.equal(f.bridge.records[0].status, 'unconfirmed');
  assert.equal(receipts.length, 0, 'The native input event, not a turn/start ACK, certifies receipt');
  unsubscribe(); f.assertPreserved();
});

test('actual adapter events preceding ACK retain exact target/body/tag, sender and first command', { timeout: 3000 }, async t => {
  const f = await fixture(t, 'events-before-ACK'), binding = await f.bind();
  const sending = binding.forwardOnce();
  try {
    await tick(); assert.equal(f.starts.length, 1);
    assert.equal(f.bridge.records[0].status, 'accepted', 'Actual native input arrived while RPC ACK is still held');
    assert.equal(f.bridge.sharedMessages()[0].status, 'submitted');
    assert.equal(f.starts[0].threadId, 'receiver-native'); assert.equal(f.starts[0].input[0].text, f.args.message);
  } finally { f.release(); }
  const tag = await sending, receipts = [];
  assert.equal(f.bridge.records[0].status, 'accepted');
  const unsubscribe = binding.watchReceipt({ messageId: tag }, value => receipts.push(value));
  assert.equal(receipts.length, 1); const receipt = receipts[0];
  assert.equal(receipt.nativeReceived, true); assert.equal(receipt.nativeId, 'receiver-native');
  assert.equal(receipt.messageId, tag); assert.equal(receipt.inputTag, tag); assert.equal(receipt.recipientId, 'receiver');
  assert.equal(receipt.turnId, 'receiver-turn'); assert.equal(receipt.firstCommand.command, 'git status --short');
  assert.equal(receipt.firstCommand.status, 'completed'); assert.equal(receipt.firstCommand.exitCode, 0);
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
  await assert.rejects(binding.forwardOnce(), error => {
    assert.equal(error.message.includes('outcome unknown'), false);
    assert.deepEqual(require(path.join(app, 'computer-use-outbox-native.cjs')).classifyOutboxFailure(error),
      { failurePhase: 'view-send', failureReason: 'send-unconfirmed' });
    return true;
  });
  await tick(); assert.equal(f.starts.length, 1); assert.equal(f.bridge.records.length, 1);
  assert.equal(f.bridge.records[0].status, 'unconfirmed');
  assert.equal(f.natives[0].adapter.outboxMcpCalls.get('owned-call').outboxConsumed, true);
  await assert.rejects(f.bind(), /original native outbox call could not be verified/); await tick();
  assert.equal(f.starts.length, 1); assert.equal(f.bridge.records.length, 1); f.assertPreserved();
});

test('actual started, declined and malformed-exit frames cannot certify execution before a completed zero exit', { timeout: 3000 }, async t => {
  const f = await fixture(t, 'ACK-only'), binding = await f.bind(), c = await core(t, binding);
  await c.send(); assert.equal(c.outbox.receipt().status, 'delivery-unconfirmed');
  f.acceptInput(); assert.equal(c.outbox.receipt().status, 'received');
  let finished = false; const waiting = c.outbox.wait({ timeoutMs: 1000 }).then(value => { finished = true; return value; });
  const emit = (id, status, exitCode) => {
    const command = { id, type: 'commandExecution', command: 'git status --short', status: 'inProgress' };
    f.frame('item/started', command);
    assert.equal(c.outbox.receipt().firstCommand, null, 'Started is not executed');
    f.frame('item/completed', { ...command, status, exitCode, aggregatedOutput: 'DO_NOT_EXPOSE_COMMAND_OUTPUT' });
  };
  const incomplete = [['declined', undefined], ['completed', undefined], ['completed', null], ['completed', '0'], ['completed', 0.5]];
  for (let n = 0; n < incomplete.length; n++) {
    emit('incomplete-' + n, ...incomplete[n]);
    assert.equal(c.outbox.receipt().status, 'received'); assert.equal(c.outbox.receipt().firstCommand, null);
  }
  await tick(); assert.equal(finished, false, 'A native receive does not settle execution waiting');
  emit('completed-command', 'completed', 0);
  const value = await waiting;
  assert.equal(value.status, 'working'); assert.equal(value.firstCommand.status, 'completed');
  assert.equal(value.firstCommand.exitCode, 0); assert.equal(value.firstCommand.id, 'completed-command');
  assert.equal(value.firstCommand.command, 'git status --short'); assert.equal(value.nativeId, 'receiver-native');
  assert.equal(value.recipient.id, 'receiver'); assert.equal(value.senderId, 'caller'); assert.equal(value.text, f.args.message);
  assert.ok(!JSON.stringify(value).includes('DO_NOT_EXPOSE_COMMAND_OUTPUT')); assert.equal(value.retry, false);
  await assert.rejects(c.send()); assert.equal(f.starts.length, 1); f.assertPreserved();
});

test('actual failed or nonzero completed command reaches a terminal failure receipt without resend', { timeout: 3000 }, async t => {
  for (const status of ['failed', 'completed']) {
    const f = await fixture(t, 'ACK-only'), binding = await f.bind(), c = await core(t, binding);
    await c.send(); f.acceptInput();
    const command = { id: 'failed-command', type: 'commandExecution', command: 'git status --short', status: 'inProgress' };
    f.frame('item/started', command); assert.equal(c.outbox.receipt().firstCommand, null);
    f.frame('item/completed', { ...command, status, exitCode: 7, aggregatedOutput: 'DO_NOT_EXPOSE_FAILURE_OUTPUT' });
    const value = await c.outbox.wait({ timeoutMs: 100 });
    assert.equal(value.status, 'command-failed'); assert.equal(value.firstCommand.status, status);
    assert.equal(value.firstCommand.exitCode, 7); assert.equal(value.retry, false);
    assert.ok(!JSON.stringify(value).includes('DO_NOT_EXPOSE_FAILURE_OUTPUT'));
    await assert.rejects(c.send()); await assert.rejects(f.bind(), /original native outbox call could not be verified/);
    assert.equal(f.starts.length, 1); assert.equal(f.bridge.records.length, 1); f.assertPreserved();
  }
});
