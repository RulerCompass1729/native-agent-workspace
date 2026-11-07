const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Codex } = require('../adapters.cjs');
const { LegacyInput } = require('../legacy-input.cjs');
const { bindOriginalOutbox } = require('../computer-use-outbox-owner.cjs');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-source-'));
  const records = [
    { id: 'sender', name: 'Sender', nativeId: 'sender-native', pid: 201, provider: 'codex', owner: 'sender-view', roomId: 'shared', memberRevision: 1, controlRevision: 2 },
    { id: 'recipient', name: 'Recipient', nativeId: 'recipient-native', pid: 202, provider: 'codex', owner: 'receiver-view', roomId: 'shared', memberRevision: 3, controlRevision: 4 },
  ];
  const bridge = new LegacyInput(dir), args = { recipient_id: 'recipient', message: '  Task one\n\tactual context.  ' };
  const identity = { nativeId: records[0].nativeId, sessionId: 'sender-session', turnId: 'sender-turn', callId: 'call-1' };
  const natives = records.map(record => {
    const host = { rpc: {}, codexTargets: new Map() }, adapter = new Codex({ ...record, messages: [] }, host);
    adapter.turnId = 'sender-turn'; adapter.nativeSessionId = 'sender-session'; adapter.latestState = 'working';
    const native = { adapter, record: adapter.record, connected: true, closed: false, state: 'idle', close() {}, sharedReplyAvailable: false };
    native.send = async (text, tag, refresh, guard) => {
      await refresh(); assert.equal(guard(), true); assert.equal(text, args.message);
      adapter.ownInputs.add(tag);
      adapter.nativeAcceptedInput = { tag, turnId: 'receiver-turn', rpc: host.rpc, lifecycle: adapter.lifecycleRevision };
      adapter.emit('nativeAcceptedInput');
      adapter.emit('progress', { id: 'native-command', source: 'codex-native', kind: 'commandExecution', status: 'completed', exitCode: 0, inputTag: tag,
        turnId: 'receiver-turn', input: 'git status --short', text: 'PRIVATE_OUTPUT_NOT_PROJECTED' });
      return 'receiver-turn';
    };
    bridge.targets.set(record.id, { record, native, submission: native }); return native;
  });
  const caller = natives[0].adapter;
  caller.event({ method: 'item/started', params: { threadId: identity.nativeId, turnId: identity.turnId,
    item: { id: identity.callId, type: 'mcpToolCall', server: 'native_outbox', tool: 'workspace_outbox', arguments: args, status: 'inProgress' } } }, caller.host.rpc);
  const entry = { key: 'retained', client: { call() { throw Error('No backend reads are permitted by this test'); } }, state: { sessions: records, room: { messages: [] } } };
  const control = { legacyInput: bridge, generations: new Map(), manualEpoch: 1, maintenance: new Set() };
  const client = { entries: [entry], control, socket: { destroyed: false }, route: () => entry };
  const contexts = records.map(record => ({ client, view: { owner: record.owner }, win: { isDestroyed: () => false } }));
  const deps = { contexts: () => contexts, roomState: { assertAvailable() {} } };
  t.after(() => { bridge.close(); fs.rmSync(dir, { recursive: true }); });
  return { args, identity, deps, records, bridge, natives, control, entry, contexts };
}
test('a single sender window can send a shared task without opening or taking over the recipient private view', async t => {
  const f = fixture(t);
  f.contexts.splice(1); // The original recipient transport stays connected.
  f.records[1].liveDraft = 'PRIVATE_DRAFT_PRESERVED';
  const before = JSON.stringify(f.records);
  const binding = await bindOriginalOutbox(f.deps, f.identity, f.args, AbortSignal.timeout(3000));
  const tag = await binding.forwardOnce(); let receipt;
  const unsubscribe = binding.watchReceipt({ messageId: tag }, value => { receipt = value; });
  assert.equal(receipt.nativeReceived, true);
  assert.equal(receipt.firstCommand.command, 'git status --short');
  assert.equal(receipt.firstCommand.status, 'completed'); assert.equal(receipt.firstCommand.exitCode, 0);
  assert.equal(f.bridge.sharedMessages().find(m => m.id === tag).recipientId, 'recipient');
  assert.equal(JSON.stringify(f.records), before);
  assert.equal(f.contexts.length, 1);
  unsubscribe(); binding.close();
});
test('production owner binding sends one exact task using existing authority, records real sender and exposes its native receipt only', async t => {
  const f = fixture(t), binding = await bindOriginalOutbox(f.deps, f.identity, f.args, AbortSignal.timeout(3000));
  assert.equal(binding.inspectGrant().ready, true);
  const tag = await binding.forwardOnce(); let receipt;
  const unsubscribe = binding.watchReceipt({ messageId: tag }, value => { receipt = value; });
  assert.equal(receipt.nativeReceived, true); assert.equal(receipt.inputTag, tag); assert.equal(receipt.firstCommand.command, 'git status --short');
  assert.ok(!JSON.stringify(receipt).includes('PRIVATE_OUTPUT'));
  const row = f.bridge.sharedMessages().find(m => m.id === tag);
  assert.equal(row.sessionId, 'sender'); assert.equal(row.senderNativeId, 'sender-native'); assert.equal(row.recipientId, 'recipient');
  assert.equal(row.name, 'Sender → Recipient'); assert.equal(row.text, f.args.message);
  assert.equal(f.records[1].owner, 'receiver-view'); assert.equal(f.records[1].controlRevision, 4);
  unsubscribe(); binding.close();
});
test('changed caller, owner, membership and manual control refuse before creating a send record', async t => {
  for (const windowCount of [1, 2]) for (const change of [f => { f.natives[0].adapter.turnId = 'changed'; }, f => { f.records[1].owner = 'other'; },
    f => { f.records[1].memberRevision++; }, f => { f.control.manualEpoch++; }, f => { f.natives[1].state = 'working'; }]) {
    const f = fixture(t); f.contexts.splice(windowCount);
    const binding = await bindOriginalOutbox(f.deps, f.identity, f.args, AbortSignal.timeout(3000)); change(f);
    await assert.rejects(binding.forwardOnce()); assert.equal(f.bridge.records.length, 0); binding.close();
  }
});
test('an unknown recipient private owner does not authorize shared dispatch', async t => {
  const f = fixture(t); f.contexts.splice(1); delete f.records[1].owner;
  await assert.rejects(bindOriginalOutbox(f.deps, f.identity, f.args, AbortSignal.timeout(3000)));
  assert.equal(f.bridge.records.length, 0);
});
test('a requested different space never silently falls back to shared', async t => {
  const f = fixture(t); const args = { ...f.args, space_id: 'different-space' };
  f.natives[0].adapter.outboxMcpCalls.get(f.identity.callId).arguments = args;
  await assert.rejects(bindOriginalOutbox(f.deps, f.identity, args, AbortSignal.timeout(3000))); assert.equal(f.bridge.records.length, 0);
});
test('missing original receiver transport fails without new connections, claims or backend reads', async t => {
  const f = fixture(t); f.bridge.targets.delete('recipient');
  await assert.rejects(bindOriginalOutbox(f.deps, f.identity, f.args, AbortSignal.timeout(3000))); assert.equal(f.bridge.records.length, 0);
});
test('outbox ACK alone remains unconfirmed, then the exact late native input settles its shared row', async t => {
  const f = fixture(t), native = f.natives[1], r = native.adapter;
  native.send = async (_text, tag, refresh, guard) => { await refresh(); assert.equal(guard(), true); r.ownInputs.add(tag); return 'ack-only-turn'; };
  const binding = await bindOriginalOutbox(f.deps, f.identity, f.args, AbortSignal.timeout(3000)), tag = await binding.forwardOnce();
  assert.equal(f.bridge.sharedMessages().find(row => row.id === tag).status, 'unconfirmed'); assert.equal(f.bridge.outboxReceipts.size, 1);
  r.nativeAcceptedInput = { tag: 'other', turnId: 'other-turn', rpc: r.host.rpc, lifecycle: r.lifecycleRevision }; r.emit('nativeAcceptedInput');
  assert.equal(f.bridge.sharedMessages().find(row => row.id === tag).status, 'unconfirmed');
  r.nativeAcceptedInput = { tag, turnId: 'actual-turn', rpc: r.host.rpc, lifecycle: r.lifecycleRevision }; r.emit('nativeAcceptedInput');
  assert.equal(f.bridge.sharedMessages().find(row => row.id === tag).status, 'submitted'); assert.equal(f.bridge.outboxReceipts.size, 0);
  binding.close();
});
test('changed native receipt connection/lifecycle cannot promote an ACK, and close removes its bounded watch', async t => {
  for (const change of [{ rpc: {} }, { lifecycle: 99 }]) {
    const f = fixture(t), native = f.natives[1], r = native.adapter;
    native.send = async (_text, tag) => { r.ownInputs.add(tag); return 'ack-only-turn'; };
    const binding = await bindOriginalOutbox(f.deps, f.identity, f.args, AbortSignal.timeout(3000)), tag = await binding.forwardOnce();
    r.nativeAcceptedInput = { tag, turnId: 'actual-turn', rpc: r.host.rpc, lifecycle: r.lifecycleRevision, ...change }; r.emit('nativeAcceptedInput');
    assert.equal(f.bridge.sharedMessages().find(row => row.id === tag).status, 'unconfirmed'); assert.equal(f.bridge.outboxReceipts.size, 0);
    binding.close(); f.bridge.close(); assert.equal(f.bridge.outboxReceipts.size, 0);
  }
});
