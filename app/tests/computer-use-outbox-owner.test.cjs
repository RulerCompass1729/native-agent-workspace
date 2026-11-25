const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Codex } = require('../adapters.cjs');
const { LegacyInput } = require('../legacy-input.cjs');
const { classifyOutboxFailure } = require('../computer-use-outbox-native.cjs');
const { bindOriginalOutbox } = require('../computer-use-outbox-owner.cjs');
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-source-'));
  const records = [
    { id: 'sender', name: 'Sender', nativeId: 'sender-native', pid: 201, provider: 'codex', owner: 'sender-view', roomId: 'shared', memberRevision: 1, controlRevision: 2 },
    { id: 'recipient', name: 'Recipient', nativeId: 'recipient-native', pid: 202, provider: 'codex', owner: 'receiver-view', roomId: 'shared', memberRevision: 3, controlRevision: 4 },
  ];
  const bridge = new LegacyInput(dir), args = { recipient_id: 'recipient', message: '  Task one\n\tactual context.  ' };
  const identity = { nativeId: records[0].nativeId, sessionId: 'sender-session', turnId: 'sender-turn', callId: 'call-1' };
  const natives = records.map(record => {
    const host = { rpc: { async call(method, params) { assert.equal(method, 'thread/goal/get'); assert.equal(params.threadId, record.nativeId); return { goal: native.goalStatus ? { threadId: record.nativeId, status: native.goalStatus } : null }; } }, codexTargets: new Map() }, adapter = new Codex({ ...record, messages: [] }, host);
    adapter.turnId = 'sender-turn'; adapter.nativeSessionId = 'sender-session'; adapter.latestState = 'working';
    const native = { adapter, record: adapter.record, connected: true, closed: false, state: 'idle', close() {}, sharedReplyAvailable: false };
    native.send = async (text, tag, refresh, guard) => {
      await refresh(); assert.equal(guard(), true); assert.equal(text, args.message);
      adapter.ownInputs.add(tag);
      adapter.event({ method: 'turn/started', params: { threadId: record.nativeId, turn: { id: 'receiver-turn' } } }, host.rpc);
      const emit = (method, item) => adapter.event({ method, params: { threadId: record.nativeId, turnId: 'receiver-turn', item } }, host.rpc);
      emit('item/completed', { id: 'native-input', type: 'userMessage', clientId: tag,
        content: [{ type: 'inputText', text }] });
      if (!options.manualCommands) {
        const command = { id: 'native-command', type: 'commandExecution', command: 'git status --short', cwd: '/synthetic', commandActions: [] };
        emit('item/started', { ...command, status: 'inProgress' });
        emit('item/completed', { ...command, status: 'completed', exitCode: 0, aggregatedOutput: 'PRIVATE_OUTPUT_NOT_PROJECTED' });
      }
      return 'receiver-turn';
    };
    bridge.targets.set(record.id, { record, native, submission: native }); return native;
  });
  const caller = natives[0].adapter;
  caller.event({ method: 'item/started', params: { threadId: identity.nativeId, turnId: identity.turnId,
    item: { id: identity.callId, type: 'mcpToolCall', server: 'native_outbox', tool: 'workspace_outbox', arguments: args, status: 'inProgress' } } }, caller.host.rpc);
  const entry = { key: 'retained', client: { call() { throw Error('No backend reads are permitted by this test'); } }, state: { wakePolicy: { enabled: true }, sessions: records, room: { messages: [] } } };
  const control = { legacyInput: bridge, generations: new Map(), manualEpoch: 1, maintenance: new Set() };
  const client = { entries: [entry], control, socket: { destroyed: false }, route: () => entry };
  const contexts = records.map(record => ({ client, view: { owner: record.owner }, win: { isDestroyed: () => false } }));
  const deps = { contexts: () => contexts, roomState: { assertAvailable() {} } };
  t.after(() => { bridge.close(); fs.rmSync(dir, { recursive: true }); });
  const commandEvent = (method, item) => {
    const r = natives[1].adapter;
    r.event({ method, params: { threadId: r.record.nativeId, turnId: 'receiver-turn', item } }, r.host.rpc);
  };
  return { args, identity, deps, records, bridge, natives, control, entry, contexts, commandEvent };
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
test('local receipt keeps the first started command when a later command succeeds first', async t => {
  const f = fixture(t, { manualCommands: true });
  const binding = await bindOriginalOutbox(f.deps, f.identity, f.args, AbortSignal.timeout(3000));
  const tag = await binding.forwardOnce(); let receipt;
  binding.watchReceipt({ messageId: tag }, value => { receipt = value; });
  const command = { type: 'commandExecution', cwd: '/synthetic', commandActions: [] };
  f.commandEvent('item/started', { ...command, id: 'first', command: 'synthetic-first', status: 'inProgress' });
  f.commandEvent('item/started', { ...command, id: 'later', command: 'synthetic-later', status: 'inProgress' });
  f.commandEvent('item/completed', { ...command, id: 'later', command: 'synthetic-later', status: 'completed', exitCode: 0 });
  assert.equal(receipt.nativeReceived, true);
  assert.equal(receipt.firstCommand, undefined, 'A later success cannot stand in for the first command still running');
  f.commandEvent('item/completed', { ...command, id: 'first', command: 'synthetic-first', status: 'failed', exitCode: 7 });
  assert.equal(receipt.firstCommand.id, 'first');
  assert.equal(receipt.firstCommand.status, 'failed'); assert.equal(receipt.firstCommand.exitCode, 7);
  await binding.close();
  assert.equal(f.natives[1].adapter.listenerCount('scopedOutboxCommand'), 0);
});
for (const first of ['declined', 'unprojectable']) test(`local receipt does not replace a ${first} first command with a later success`, async t => {
  const f = fixture(t, { manualCommands: true });
  const binding = await bindOriginalOutbox(f.deps, f.identity, f.args, AbortSignal.timeout(3000));
  const tag = await binding.forwardOnce(); let receipt;
  binding.watchReceipt({ messageId: tag }, value => { receipt = value; });
  const command = { type: 'commandExecution', cwd: '/synthetic', commandActions: [] };
  const firstCommand = first === 'unprojectable' ? 'x'.repeat(4097) : 'synthetic-first';
  f.commandEvent('item/started', { ...command, id: 'first', command: firstCommand, status: 'inProgress' });
  f.commandEvent('item/completed', { ...command, id: 'first', command: firstCommand,
    status: first === 'declined' ? 'declined' : 'completed', ...(first === 'declined' ? {} : { exitCode: 0 }) });
  f.commandEvent('item/started', { ...command, id: 'later', command: 'synthetic-later', status: 'inProgress' });
  f.commandEvent('item/completed', { ...command, id: 'later', command: 'synthetic-later', status: 'completed', exitCode: 0 });
  assert.equal(receipt.nativeReceived, true); assert.equal(receipt.firstCommand, undefined);
  await binding.close();
});
test('local receipt rejects an earlier command start on another RPC or lifecycle', async t => {
  for (const change of [{ rpc: {} }, { lifecycle: 99 }]) {
    const f = fixture(t, { manualCommands: true });
    const binding = await bindOriginalOutbox(f.deps, f.identity, f.args, AbortSignal.timeout(3000));
    const tag = await binding.forwardOnce(); let receipt;
    binding.watchReceipt({ messageId: tag }, value => { receipt = value; });
    const r = f.natives[1].adapter;
    r.emit('scopedOutboxCommand', { id: 'foreign', input: 'foreign-command', source: 'codex-native', kind: 'commandExecution',
      inputTag: tag, turnId: 'receiver-turn', status: 'inProgress', rpc: r.host.rpc, lifecycle: r.lifecycleRevision, ...change });
    const command = { id: 'actual', type: 'commandExecution', command: 'synthetic-actual', cwd: '/synthetic', commandActions: [] };
    f.commandEvent('item/started', { ...command, status: 'inProgress' });
    f.commandEvent('item/completed', { ...command, status: 'completed', exitCode: 0 });
    assert.equal(receipt.firstCommand.id, 'actual'); assert.equal(receipt.firstCommand.exitCode, 0);
    await binding.close();
  }
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

test('direct native outbox respects global off or unavailable policy before reserving input', async t => {
  for (const policy of [{ enabled: false }, undefined]) {
    const f = fixture(t); f.entry.state.wakePolicy = policy;
    await assert.rejects(bindOriginalOutbox(f.deps, f.identity, f.args), error => classifyOutboxFailure(error).failureReason === ('wake-policy-unavailable'));
    assert.equal(f.bridge.records.length, 0);
  }
});
test('direct native outbox rechecks global off and native goal before native write', async t => {
  for (const status of ['paused', 'blocked', 'usageLimited', 'budgetLimited']) {
    const f = fixture(t), binding = await bindOriginalOutbox(f.deps, f.identity, f.args);
    let writes = 0; f.natives[1].goalStatus = status;
    f.natives[1].send = async (_text, _tag, refresh) => { await refresh(); writes++; };
    await assert.rejects(binding.forwardOnce(), error => classifyOutboxFailure(error).failureReason === ('native-goal-disallows'));
    assert.equal(writes, 0); assert.equal(f.bridge.records.length, 1);
    assert.equal(f.bridge.records[0].agentWakeBudget.senders[f.records[0].nativeId].streak, 1);
    await binding.close();
  }
  const f = fixture(t), binding = await bindOriginalOutbox(f.deps, f.identity, f.args);
  f.entry.state.wakePolicy.enabled = false;
  await assert.rejects(binding.forwardOnce(), error => classifyOutboxFailure(error).failureReason === ('wake-policy-unavailable'));
  assert.equal(f.bridge.records.length, 0); await binding.close();
});
test('direct native outbox shares existing cooldown and streak admission', async t => {
  for (const budget of [
    { version: 2, lastAt: Date.now(), humanRevision: 0, senders: { sender: { id: 'earlier', streak: 1 } } },
    { version: 2, lastAt: 1, humanRevision: 0, senders: { sender: { id: 'earlier', streak: 8 } } },
  ]) {
    const f = fixture(t); f.bridge.records.push({ sessionId: 'recipient', nativeId: 'recipient-native', agentWakeBudget: budget });
    await assert.rejects(bindOriginalOutbox(f.deps, f.identity, f.args), error => classifyOutboxFailure(error).failureReason === ('wake-limited'));
    assert.equal(f.bridge.records.length, 1);
  }
});

test('a backend with canonical wake accounting cannot fall back to a stale direct ledger', async t => {
  for (const policy of ['capability', 'persisted-budget']) {
    const f = fixture(t);
    f.bridge.records.push({ sessionId: 'recipient', nativeId: 'recipient-native', agentWakeBudget: { version: 2, lastAt: 1, humanRevision: 0, senders: { sender: { id: 'earlier', streak: 1 } } } });
    if (policy === 'capability') f.entry.state.capabilities = ['agentWakeV1'];
    else f.records[1].wakeBudget = { version: 2, lastAt: 1, humanRevision: 0, senders: { sender: { id: 'earlier', streak: 8 } } };
    await assert.rejects(bindOriginalOutbox(f.deps, f.identity, f.args), error => classifyOutboxFailure(error).failureReason === 'wake-policy-unavailable');
    assert.equal(f.bridge.records.length, 1);
  }
});

test('a direct grant cannot survive the arrival of canonical wake accounting', async t => {
  const f = fixture(t), binding = await bindOriginalOutbox(f.deps, f.identity, f.args);
  f.entry.state.capabilities = ['agentWakeV1'];
  await assert.rejects(binding.forwardOnce(), error => classifyOutboxFailure(error).failureReason === 'wake-policy-unavailable');
  assert.equal(f.bridge.records.length, 0); await binding.close();
});
