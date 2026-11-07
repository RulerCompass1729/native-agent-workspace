const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const vm = require('node:vm'), Module = require('node:module');
const app = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..');
const { Codex } = require(path.join(app, 'adapters.cjs'));
const { LegacyCodex } = require(path.join(app, 'legacy-codex.cjs'));
const { LegacyInput } = require(path.join(app, 'legacy-input.cjs'));
const { bindOriginalOutbox } = require(path.join(app, 'computer-use-outbox-owner.cjs'));

async function fixture(t, unknownRPC = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-single-view-outbox-'));
  const identity = { nativeId: 'sender-native', sessionId: 'sender-session', turnId: 'sender-turn', callId: 'single-observer-call' };
  const args = { recipient_id: 'recipient', message: '  A real source-chain task.\r\n\t保留正文 🙂.  ' };
  const records = [
    { id: 'sender', name: 'Sender', nativeId: identity.nativeId, pid: 201, owner: 'observer-view', memberRevision: 1 },
    { id: 'recipient', name: 'Recipient', nativeId: 'recipient-native', pid: 202, owner: 'original-human-view', memberRevision: 2 },
  ].map(record => ({ ...record, provider: 'codex', roomId: 'shared', controlRevision: 4,
    liveDraft: 'PRIVATE UNSENT ' + record.id, messages: [] }));
  const saved = structuredClone(records), sharedDraft = { text: 'SHARED UNSENT', recipient: 'sender' };
  const sharedBefore = structuredClone(sharedDraft), calls = [], goalReads = [], starts = [], natives = [], bindings = [];
  const bridge = new LegacyInput(root);
  let expectedStarts = 0;
  for (const record of records) {
    const rpc = { nativeVersion: '0.164.0', async call(method, params) {
      if (method === 'thread/goal/get') { assert.equal(params.threadId, record.nativeId); goalReads.push([record.id, method]); return { goal: null }; }
      calls.push([record.id, method]);
      assert.equal(record.id, 'recipient'); assert.equal(method, 'turn/start', 'No new metadata, history, settings or native command requests');
      starts.push(params);
      if (unknownRPC) throw Error('Controlled native outcome unknown');
      return { turn: { id: 'recipient-turn' } };
    } };
    const native = new LegacyCodex(record), adapter = new Codex(native.record, { rpc, codexTargets: new Map() });
    // Existing transports only: no connect/start, socket, provider or engine.
    Object.assign(native, { adapter, rpc, connected: true, subscribed: true, state: record.id === 'sender' ? 'working' : 'idle' });
    adapter.chatAvailable = true; adapter.on('state', state => { native.state = state; });
    if (record.id === 'sender') {
      adapter.turnId = identity.turnId; adapter.nativeSessionId = identity.sessionId;
      adapter.event({ method: 'item/started', params: { threadId: record.nativeId, turnId: identity.turnId,
        item: { id: identity.callId, type: 'mcpToolCall', server: 'native_outbox', tool: 'workspace_outbox', arguments: args, status: 'inProgress' } } }, rpc);
    }
    natives.push(native); bridge.targets.set(record.id, { record, native, submission: native });
  }
  const entry = { key: 'retained', client: { call() { throw Error('No backend reads, connections or input claims'); } },
    state: { wakePolicy: { enabled: true }, sessions: records, room: { messages: [] }, sharedDraft } };
  const control = { legacyInput: bridge, generations: new Map(), manualEpoch: 1, maintenance: new Set() };
  const client = { entries: [entry], control, socket: { destroyed: false }, route: () => entry };
  const contexts = [{ client, view: { owner: 'observer-view' }, win: { isDestroyed: () => false } }];
  assert.equal(contexts.length, 1); assert.ok(contexts.every(c => c.view.owner !== records[1].owner));
  const deps = { contexts: () => contexts, roomState: { assertAvailable() {} } };
  const bind = async () => { const b = await bindOriginalOutbox(deps, identity, args, AbortSignal.timeout(1000)); bindings.push(b); return b; };
  const frame = (method, item, scope = {}) => natives[1].adapter.event({ method, params: {
    threadId: 'recipient-native', turnId: 'recipient-turn', ...scope, item } }, natives[1].rpc);
  const received = () => {
    natives[1].adapter.event({ method: 'turn/started', params: { threadId: 'recipient-native', turn: { id: 'recipient-turn' } } }, natives[1].rpc);
    frame('item/completed', { id: 'exact-input', type: 'userMessage', clientId: starts[0].clientUserMessageId,
      content: [{ type: 'text', text: args.message }] });
  };
  t.after(() => {
    for (const b of bindings) b.close(); bridge.close(); fs.rmSync(root, { recursive: true, force: true });
    assert.deepEqual(calls, Array.from({ length: expectedStarts }, () => ['recipient', 'turn/start']));
    assert.equal(fs.existsSync(root), false);
  });
  return { args, identity, records, saved, bridge, natives, control, entry, starts, calls, contexts, bind, frame, received,
    sent() { expectedStarts = 1; },
    preserved() { assert.deepEqual(records, saved); assert.deepEqual(sharedDraft, sharedBefore); } };
}
async function core(t, binding) {
  const file = path.join(app, 'computer-use-outbox.cjs'), module = { exports: {} };
  // Only the isolated UI/Unix lease is a stand-in. All delivery and native
  // event reducers remain production code, including the send-site guard.
  vm.runInThisContext(Module.wrap(fs.readFileSync(file, 'utf8')), { filename: file })(module.exports, id => {
    if (id === './native-computer-use.cjs') return { createComputerUseViewLease: async config => {
      let closed = false; return { leaseFile: 'controlled-single-observer-lease', async close() {
        if (!closed) { closed = true; await config.dispose(); }
      } };
    } };
    if (id === './computer-use-outbox-native.cjs') return require(path.join(path.dirname(file), id));
    assert.equal(id, 'node:crypto'); return require(id);
  }, module, file, path.dirname(file));
  let send;
  const outbox = await module.exports.openOutbox(binding.grant, { ...binding, createView: async (_scope, actions) => {
    send = actions.send;
    return { owner: 'isolated-outbox-view', inspect: async () => ({ ...binding.grant, ...binding.inspectGrant(),
      owner: 'isolated-outbox-view', body: binding.grant.text }), target() {}, invoke() {}, showReceipt() {}, async close() {} };
  } });
  t.after(() => outbox.close()); return { outbox, send: () => send() };
}

test('one observer delivers the exact task without a recipient-owned window; ACK and unrelated input are not receipts', { timeout: 3000 }, async t => {
  const f = await fixture(t), binding = await f.bind(), c = await core(t, binding);
  await c.send(); f.sent(); assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].threadId, 'recipient-native'); assert.equal(f.starts[0].input[0].text, f.args.message);
  assert.equal(c.outbox.receipt().status, 'delivery-unconfirmed'); assert.equal(f.bridge.records[0].status, 'unconfirmed');
  const input = { id: 'unrelated-input', type: 'userMessage', clientId: 'unrelated-tag', content: [{ type: 'text', text: f.args.message }] };
  f.frame('item/completed', input, { threadId: 'other-native' }); f.frame('item/completed', input);
  assert.equal(c.outbox.receipt().status, 'delivery-unconfirmed'); assert.equal(f.bridge.sharedMessages()[0].status, 'unconfirmed');
  f.received(); assert.equal(c.outbox.receipt().status, 'received');
  const command = { id: 'exact-command', type: 'commandExecution', command: 'git status --short', status: 'inProgress' };
  f.frame('item/started', command); assert.equal(c.outbox.receipt().firstCommand, null);
  f.frame('item/completed', { ...command, status: 'completed', exitCode: 0, aggregatedOutput: 'PRIVATE_OUTPUT_NOT_PROJECTED' });
  const receipt = await c.outbox.wait({ timeoutMs: 100 });
  assert.equal(receipt.status, 'working'); assert.equal(receipt.senderId, 'sender'); assert.equal(receipt.senderNativeId, 'sender-native');
  assert.equal(receipt.recipient.id, 'recipient'); assert.equal(receipt.nativeId, 'recipient-native'); assert.equal(receipt.text, f.args.message);
  assert.equal(receipt.firstCommand.exitCode, 0); assert.equal(receipt.retry, false);
  const row = f.bridge.sharedMessages()[0];
  assert.equal(row.sessionId, 'sender'); assert.equal(row.senderNativeId, 'sender-native'); assert.equal(row.recipientId, 'recipient');
  assert.equal(row.text, f.args.message); assert.equal(row.status, 'submitted'); assert.equal(row.id, f.bridge.records[0].id);
  assert.equal(receipt.messageId, row.id); assert.equal(f.starts[0].clientUserMessageId, row.id); assert.equal(receipt.turnId, 'recipient-turn');
  assert.ok(!JSON.stringify(receipt).includes('PRIVATE_OUTPUT_NOT_PROJECTED'));
  await assert.rejects(c.send()); await assert.rejects(f.bind());
  assert.equal(f.starts.length, 1); assert.equal(f.bridge.records.length, 1); f.preserved();
});

test('unknown native submission and failed execution never resend, rebind or take the original input owner', { timeout: 3000 }, async t => {
  for (const unknown of [true, false]) {
    const f = await fixture(t, unknown), binding = await f.bind(), c = await core(t, binding);
    await c.send(); f.sent();
    if (!unknown) {
      f.received();
      const command = { id: 'failed-command', type: 'commandExecution', command: 'git status --short', status: 'inProgress' };
      f.frame('item/started', command); assert.equal(c.outbox.receipt().firstCommand, null);
      f.frame('item/completed', { ...command, status: 'failed', exitCode: 7, aggregatedOutput: 'PRIVATE_FAILURE_OUTPUT' });
    }
    const receipt = c.outbox.receipt(); assert.equal(receipt.status, unknown ? 'unconfirmed' : 'command-failed');
    assert.equal(receipt.retry, false); assert.ok(!JSON.stringify(receipt).includes('PRIVATE_FAILURE_OUTPUT'));
    await assert.rejects(c.send()); await assert.rejects(f.bind());
    assert.equal(f.starts.length, 1); assert.equal(f.bridge.records.length, 1);
    assert.equal(f.bridge.sharedMessages()[0].status, unknown ? 'unconfirmed' : 'submitted'); f.preserved();
  }
});

test('single-observer sharing still refuses changed original owner, control, membership and human boundary before sending', { timeout: 3000 }, async t => {
  for (const change of [f => { f.records[1].owner = 'later-human-view'; }, f => { f.records[1].controlRevision++; },
    f => { f.records[1].memberRevision++; }, f => { f.control.manualEpoch++; }]) {
    const f = await fixture(t), binding = await f.bind(), c = await core(t, binding); change(f);
    const afterHuman = structuredClone(f.records);
    await c.send(); assert.equal(c.outbox.receipt().status, 'not-sent'); assert.equal(c.outbox.receipt().retry, false);
    assert.deepEqual(f.calls, []); assert.equal(f.bridge.records.length, 0); assert.deepEqual(f.records, afterHuman);
    await assert.rejects(c.send()); assert.deepEqual(f.calls, []);
  }
});
