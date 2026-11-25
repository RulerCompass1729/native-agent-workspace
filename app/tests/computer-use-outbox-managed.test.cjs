const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { Workspace } = require('../workspace.cjs');
const { Codex } = require('../adapters.cjs');
const { LegacyInput } = require('../legacy-input.cjs');
const { connectService } = require('../service-connection.cjs');
const { readFrames, createWriter, REQUEST_BYTES } = require('../service-transport.cjs');
const { dispatchScopedOutbox } = require('../daemon.cjs');
const { CAPABILITY } = require('../scoped-outbox-runtime.cjs');
const { bindOriginalOutbox } = require('../computer-use-outbox-owner.cjs');
const { classifyOutboxFailure } = require('../computer-use-outbox-native.cjs');
const { createOutboxBroker } = require('../computer-use-outbox-broker.cjs');
const { requestOutbox } = require('../computer-use-outbox-tool.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function delivered(f, i = 1) {
  const scope = [...f.backends[i].workspace.scopedOutboxProducer.scopes.values()][0];
  // A real response read on the same stream is the barrier, not a timer/write.
  assert.equal((await f.entries[i].client.call('scopedOutbox', 'check', { token: scope.token })).ok, true);
}

// Real authenticated Unix service clients and production Workspace/Codex event
// bookkeeping. Only already-held native RPC and the leased view are synthetic.
// No provider, GUI, original backend, Native connect/resume or private read.
async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync('/private/tmp/naw-scoped-outbox-'); fs.chmodSync(dir, 0o700);
  const bridge = new LegacyInput(dir), backends = [], entries = [], calls = [], nativeCalls = [], goalReads = [];
  const args = { recipient_id: 'recipient', space_id: 'shared', message: '  Inspect the local source\r\n\tkeep literal spaces  ' };
  const records = ['sender', 'recipient'].map(id => ({ id, nativeId: randomUUID(), provider: 'codex', name: id,
    pid: process.pid, owner: `private-${id}`, roomId: 'shared', memberRevision: 3, controlRevision: 7,
    connectionRevision: 2, peerRevision: 0, state: id === 'sender' ? 'working' : 'idle' }));
  const identity = { nativeId: records[0].nativeId, sessionId: 'source-session', turnId: 'source-turn', callId: 'source-call' };
  const command = { id: 'actual-command', type: 'commandExecution', command: 'git status --short', status: 'inProgress' };
  const context = { win: { isDestroyed: () => false }, client: { entries, socket: { destroyed: false },
    control: { legacyInput: bridge, generations: new Map(), maintenance: new Set(), manualEpoch: 0 },
    route(id) { return entries.find(e => e.state.sessions.some(s => s.id === id)); } } };
  const deps = { contexts: () => [context], roomState: { assertAvailable() {} } };
  t.after(async () => {
    bridge.close();
    for (const b of backends) {
      b.workspace.closeScopedOutbox();
      b.entry.client.socket.destroy(); for (const s of b.sockets) s.destroy();
      b.workspace.close(); await new Promise(resolve => b.server.close(resolve));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (const [i, record] of records.entries()) {
    const root = path.join(dir, record.id); fs.mkdirSync(root, { mode: 0o700 });
    const host = { binaries: {}, codexTargets: new Map(), close() {} };
    const workspace = new Workspace(host, root), nativeRecord = { ...record, view: 'chat', messages: [], goal: 'PRIVATE_GOAL_UNCHANGED' };
    const runtime = new Codex(nativeRecord, host); runtime.nativeSessionId = i ? 'receiver-session' : identity.sessionId;
    workspace.sessions.set(record.id, nativeRecord); workspace.runtimes.set(record.id, runtime); workspace.bind(nativeRecord, runtime);
    workspace.drafts.set(record.id, 'PRIVATE_DRAFT_UNCHANGED');
    const emit = (method, p, rpc = runtime.terminalNotificationSource ? runtime.terminalRpc : host.rpc) =>
      runtime.event({ method, params: { threadId: record.nativeId, ...p } }, rpc);
    const nativeRpc = { connected: true, nativeVersion: options.nativeVersion, async call(method, params) {
      if (method === 'thread/goal/get') {
        assert.deepEqual(params, { threadId: record.nativeId }); goalReads.push({ actor: record.id, rpc: this });
        await options.beforeGoal?.({ nativeRecord, workspace, runtime });
        const status = typeof options.goalStatus === 'function' ? options.goalStatus() : options.goalStatus;
        return options.invalidGoal ? {} : { goal: status ? { threadId: record.nativeId, status, objective: 'PRIVATE_GOAL_NOT_PROJECTED' } : null };
      }
      nativeCalls.push({ actor: record.id, rpc: this, method, params });
      if (method === 'thread/turns/list') return { data: [{ id: identity.turnId, status: 'inProgress', itemsView: 'notLoaded', items: [] }] };
      assert.equal(method, 'turn/start', 'No Native connection/resume/history/goal/approval fallback');
      await options.beforeNative?.({ record, nativeRecord, runtime, workspace, records, context });
      if (!options.ackOnly) {
        emit('turn/started', { turn: { id: 'receiver-turn' } });
        emit('item/completed', { turnId: 'receiver-turn', item: { id: 'echo', type: 'userMessage', clientId: params.clientUserMessageId,
          content: [{ type: 'text', text: 'PRIVATE_ECHO_NOT_RETURNED' }] } });
        emit('item/started', { turnId: 'receiver-turn', item: command });
        emit('item/completed', { turnId: 'receiver-turn', item: { ...command, status: 'completed', exitCode: 0, aggregatedOutput: 'PRIVATE_STDOUT_NOT_RETURNED' } });
      }
      return { turn: { id: 'receiver-turn', items: [{ text: 'PRIVATE_ACK_NOT_RETURNED' }] } };
    } };
    host.rpc = nativeRpc;
    if (options.terminal) {
      runtime.terminalNotificationSource = 'original-tui'; runtime.terminalRpc = { connected: true, nativeClientVersion: options.terminalVersion, call: nativeRpc.call };
      runtime.needsSubscription = true; runtime.chatAvailable = false;
    }
    const sockets = new Set(), token = randomUUID(), endpoint = path.join(root, 'service.sock');
    const server = net.createServer(socket => {
      sockets.add(socket); const writer = createWriter(socket); let authenticated = false;
      socket.on('close', () => { workspace.scopedOutboxDisconnected(socket); sockets.delete(socket); });
      readFrames(socket, REQUEST_BYTES, async packet => {
        if (!authenticated) {
          if (packet.protocol !== 1 || packet.token !== token || !packet.owner) return socket.destroy();
          authenticated = true; socket.owner = packet.owner; writer.send({ ready: true }); return;
        }
        calls.push({ actor: record.id, method: packet.method, action: packet.args?.[0], params: packet.args?.[1] });
        assert.equal(packet.method, 'scopedOutbox', 'No initial/observe/private view/claim/forward request');
        await options.beforeAction?.(packet.args[0], { i, record, nativeRecord, runtime, workspace, records, context });
        const result = await dispatchScopedOutbox(workspace, socket, packet.args, (_client, value) => writer.send(value));
        await options.afterAction?.(packet.args[0], { i, record, nativeRecord, runtime, workspace, records, context });
        writer.send({ id: packet.id, ok: true, value: result });
      });
    });
    await new Promise(resolve => server.listen(endpoint, resolve)); fs.chmodSync(endpoint, 0o600);
    fs.writeFileSync(path.join(root, 'connection.json'), JSON.stringify({ protocol: 1, token, pid: process.pid, endpoint }), { mode: 0o600 });
    const client = await connectService(root, 'existing-window');
    const entry = { key: `host-${i}`, client, state: { wakePolicy: { enabled: true }, capabilities: options.unsupported === i ? [] : [CAPABILITY],
      runtimeVersion: i ? '0.1.0-alpha.120' : '0.1.0-alpha.159', servicePid: process.pid, sessions: [record], room: {} } };
    entries.push(entry); backends.push({ root, workspace, runtime, nativeRecord, emit, entry, nativeRpc, sockets, server });
    for (const key of ['messages', 'liveDraft', 'goal']) Object.defineProperty(record, key, {
      enumerable: true, get() { throw Error(`Frontend private field read: ${key}`); },
    });
  }
  const start = (patch = {}) => {
    backends[0].emit('turn/started', { turn: { id: identity.turnId } });
    backends[0].emit('item/started', { turnId: identity.turnId, item: { id: identity.callId, type: 'mcpToolCall',
      server: 'native_outbox', tool: 'workspace_outbox', status: 'inProgress', arguments: args, ...patch } });
  };
  return { dir, bridge, backends, entries, records, calls, nativeCalls, goalReads, args, identity, command, context, deps, start,
    bind: (id = identity) => bindOriginalOutbox(deps, id, args, AbortSignal.timeout(1500)) };
}

test('existing managed backends send once on their held RPC with exact native receipt/command and one source-attributed ledger', async t => {
  const f = await fixture(t); f.start();
  assert.equal(f.bridge.targets.size, 0); assert.equal(f.bridge.readers.size, 0);
  const binding = await f.bind(), tag = await binding.forwardOnce(); let receipt;
  binding.watchReceipt({ messageId: tag }, r => { receipt = r; });
  assert.equal(receipt.nativeReceived, true); assert.equal(receipt.firstCommand.exitCode, 0);
  assert.equal(receipt.firstCommand.command, 'git status --short'); assert.equal(receipt.inputTag, tag);
  assert.equal(f.nativeCalls.length, 1); assert.equal(f.nativeCalls[0].rpc, f.backends[1].nativeRpc);
  assert.deepEqual(f.nativeCalls[0].params, { threadId: f.records[1].nativeId, clientUserMessageId: tag,
    input: [{ type: 'text', text: f.args.message, text_elements: [] }] });
  const shared = f.bridge.sharedMessages(); assert.equal(shared.length, 1); assert.equal(shared[0].sessionId, 'sender');
  assert.equal(shared[0].text, f.args.message); assert.equal(shared[0].status, 'submitted');
  assert.equal(f.bridge.localDispatchCount(), 0); assert.equal(f.backends[1].workspace.versions.dispatches, 1);
  for (const b of f.backends) {
    assert.equal(b.nativeRecord.owner, `private-${b.nativeRecord.id}`); assert.equal(b.nativeRecord.controlRevision, 7);
    assert.equal(b.nativeRecord.goal, 'PRIVATE_GOAL_UNCHANGED'); assert.equal(b.workspace.drafts.get(b.nativeRecord.id), 'PRIVATE_DRAFT_UNCHANGED');
    assert.equal(b.workspace.room.messages.length, 0); assert.equal(b.workspace.forwards.size, 0); assert.equal(b.workspace.sharedReplies.grants.size, 0);
  }
  assert.ok(!JSON.stringify(receipt).includes('PRIVATE_'));
  await binding.close();
  for (const b of f.backends) assert.equal(b.workspace.scopedOutboxProducer.scopes.size, 0);
  assert.equal(f.bridge.managedOutboxTargets.size, 0); assert.equal(f.entries[0].client.listenerCount('scopedOutbox'), 0);
  await assert.rejects(f.bind()); assert.equal(f.nativeCalls.length, 1);
});
test('held original TUI connection can supply provenance and send without NativeHost resume or chatAvailable', async t => {
  const f = await fixture(t, { terminal: true }); f.start(); const binding = await f.bind();
  const tag = await binding.forwardOnce(); let receipt; binding.watchReceipt({ messageId: tag }, r => { receipt = r; });
  assert.equal(receipt.firstCommand.exitCode, 0); assert.equal(f.nativeCalls[0].rpc, f.backends[1].runtime.terminalRpc);
  assert.equal(f.nativeCalls.length, 1); await binding.close();
});
test('qualified original TUI sends independently of a pre-existing edit without clearing its protection marker', async t => {
  const f = await fixture(t, { terminal: true, nativeVersion: '0.167.0', terminalVersion: '0.167.0' });
  const b = f.backends[1]; b.nativeRecord.terminalInputPending = true; f.start();
  const binding = await f.bind(), tag = await binding.forwardOnce(); let receipt;
  binding.watchReceipt({ messageId: tag }, value => { receipt = value; });
  assert.equal(receipt.firstCommand.exitCode, 0); assert.equal(receipt.inputTag, tag);
  assert.equal(f.nativeCalls.length, 1); assert.equal(f.nativeCalls[0].rpc, b.runtime.terminalRpc);
  assert.equal(b.nativeRecord.terminalInputPending, true);
  assert.equal(b.nativeRecord.controlRevision, 7);
  assert.equal(b.workspace.drafts.get('recipient'), 'PRIVATE_DRAFT_UNCHANGED');
  await binding.close();
});
test('unqualified host or actual TUI versions retain the terminal edit gate before any native write', async t => {
  for (const options of [{ terminal: true }, { terminal: true, terminalVersion: '0.167.0' },
    { terminal: true, nativeVersion: '0.166.0', terminalVersion: '0.167.0' },
    { terminal: true, nativeVersion: '0.168.0', terminalVersion: '0.167.0' },
    { terminal: true, nativeVersion: '0.167.0', terminalVersion: '0.166.0' },
    { terminal: true, nativeVersion: '0.167.0', terminalVersion: '0.168.0' },
    { terminal: true, nativeVersion: '0.167.0' },
    { nativeVersion: '0.167.0', terminalVersion: '0.167.0' }]) {
    const f = await fixture(t, options); const b = f.backends[1]; b.nativeRecord.terminalInputPending = true; f.start();
    await assert.rejects(f.bind(), undefined, JSON.stringify(options));
    assert.equal(f.nativeCalls.length, 0); assert.equal(f.goalReads.length, 0);
    assert.equal(b.nativeRecord.terminalInputPending, true);
    assert.equal(b.workspace.drafts.get('recipient'), 'PRIVATE_DRAFT_UNCHANGED');
  }
});
test('loss of the actual TUI qualification after binding refuses before turn/start', async t => {
  const f = await fixture(t, { terminal: true, nativeVersion: '0.167.0', terminalVersion: '0.167.0' });
  const b = f.backends[1]; b.nativeRecord.terminalInputPending = true; f.start();
  const binding = await f.bind(); b.runtime.terminalRpc.nativeClientVersion = null;
  await assert.rejects(binding.forwardOnce()); assert.equal(f.nativeCalls.length, 0);
  assert.equal(b.nativeRecord.terminalInputPending, true); await binding.close();
});
test('a new real keystroke after a draft-preserving binding still withdraws the send', async t => {
  const f = await fixture(t, { terminal: true, nativeVersion: '0.167.0', terminalVersion: '0.167.0' });
  const b = f.backends[1], input = []; b.nativeRecord.terminalInputPending = true;
  b.nativeRecord.view = 'terminal'; b.runtime.terminal = { alive: true, input: data => input.push(data) };
  f.start(); const binding = await f.bind();
  b.workspace.input('recipient', 'new human edit', b.nativeRecord.owner);
  assert.deepEqual(input, ['new human edit']); assert.equal(b.nativeRecord.controlRevision, 8);
  await assert.rejects(binding.forwardOnce()); assert.equal(f.nativeCalls.length, 0);
  assert.equal(b.nativeRecord.terminalInputPending, true); await binding.close();
});
test('managed source/receipt through actual broker/private socket/leased Core view remains working only after native command completion', async t => {
  const f = await fixture(t); f.start(); let binding, clicks = 0, closed = 0;
  const broker = await createOutboxBroker({ descriptorFile: path.join(f.dir, 'owner.json'),
    bind: async (...args) => (binding = await bindOriginalOutbox(f.deps, ...args)),
    createView: async (model, actions) => ({ owner: 'scoped-view',
      inspect: () => ({ ...binding.grant, ...binding.inspectGrant(), owner: 'scoped-view', selected: 'room', surface: 'records', body: model.text, revision: 'one' }),
      target: () => ({ id: 'send', kind: 'send', visible: true, disabled: false }),
      async invoke(name) {
        if (name === 'browser_snapshot') return { content: [{ type: 'text', text: '### Snapshot\n```yaml\n- button "发送" [ref=e1]\n```' }] };
        assert.equal(name, 'browser_click'); clicks++; await actions.send(); return { content: [{ type: 'text', text: 'clicked' }] };
      }, async showReceipt() {}, async close() { closed++; } }),
  });
  try {
    const result = await requestOutbox(broker.descriptorFile, f.identity, f.args);
    assert.equal(result.status, 'working'); assert.equal(result.nativeReceived, true); assert.equal(result.firstCommand.exitCode, 0);
    assert.equal(clicks, 1); assert.equal(closed, 1); assert.equal(f.nativeCalls.length, 1);
    assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
    for (const b of f.backends) assert.equal(b.workspace.scopedOutboxProducer.scopes.size, 0);
  } finally { await broker.close(); }
});
test('ACK-only is unconfirmed; wrong/old command provenance cannot be reassigned after a late user echo', async t => {
  const f = await fixture(t, { ackOnly: true }); f.start(); const binding = await f.bind();
  const tag = await binding.forwardOnce(); let receipt; binding.watchReceipt({ messageId: tag }, r => { receipt = r; });
  assert.equal(receipt, undefined); assert.equal(f.bridge.sharedMessages()[0].status, 'unconfirmed');
  const b = f.backends[1], turnId = 'receiver-turn';
  b.emit('turn/started', { turn: { id: turnId } });
  b.emit('item/started', { turnId, item: f.command });
  b.emit('item/completed', { turnId, item: { id: 'echo', type: 'userMessage', clientId: tag } });
  b.emit('item/completed', { turnId, item: { ...f.command, status: 'completed', exitCode: 0 } });
  await delivered(f); assert.equal(receipt.nativeReceived, true); assert.equal(receipt.firstCommand, undefined);
  b.emit('item/started', { turnId, item: { ...f.command, id: 'new-command' } });
  b.emit('item/completed', { turnId, item: { ...f.command, id: 'new-command', status: 'declined', exitCode: 0 } });
  b.emit('item/completed', { turnId, item: { ...f.command, id: 'new-command', status: 'completed', exitCode: '0' } });
  await delivered(f); assert.equal(receipt.firstCommand, undefined);
  b.emit('item/completed', { turnId, item: { ...f.command, id: 'new-command', status: 'failed', exitCode: 7 } });
  await delivered(f); assert.equal(receipt.firstCommand.exitCode, 7); await binding.close();
});
test('first command means the first started command for this input, even when a later command finishes first', async t => {
  const f = await fixture(t, { ackOnly: true }); f.start(); const binding = await f.bind();
  const tag = await binding.forwardOnce(); let receipt; binding.watchReceipt({ messageId: tag }, r => { receipt = r; });
  const b = f.backends[1], turnId = 'receiver-turn';
  b.emit('turn/started', { turn: { id: turnId } });
  b.emit('item/completed', { turnId, item: { id: 'echo', type: 'userMessage', clientId: tag } });
  b.emit('item/started', { turnId, item: { ...f.command, id: 'first' } });
  b.emit('item/started', { turnId, item: { ...f.command, id: 'second' } });
  b.emit('item/completed', { turnId, item: { ...f.command, id: 'second', status: 'completed', exitCode: 0 } });
  await delivered(f); assert.equal(receipt.firstCommand, undefined, 'A later completion cannot hide the first command still running');
  b.emit('item/completed', { turnId, item: { ...f.command, id: 'first', status: 'failed', exitCode: 7 } });
  await delivered(f); assert.equal(receipt.firstCommand.id, 'first'); assert.equal(receipt.firstCommand.exitCode, 7);
  await binding.close();
});
test('an unprojectable first command cannot be replaced by a later short successful command', async t => {
  for (const commandText of ['x'.repeat(4097), '', null]) {
    const f = await fixture(t, { ackOnly: true }); f.start(); const binding = await f.bind();
    const tag = await binding.forwardOnce(); let receipt; binding.watchReceipt({ messageId: tag }, r => { receipt = r; });
    const b = f.backends[1], turnId = 'receiver-turn';
    b.emit('turn/started', { turn: { id: turnId } });
    b.emit('item/completed', { turnId, item: { id: 'echo', type: 'userMessage', clientId: tag } });
    b.emit('item/started', { turnId, item: { ...f.command, id: 'first-unprojectable', command: commandText } });
    b.emit('item/started', { turnId, item: { ...f.command, id: 'second-short' } });
    b.emit('item/completed', { turnId, item: { ...f.command, id: 'second-short', status: 'completed', exitCode: 0 } });
    await delivered(f); assert.equal(receipt.firstCommand, undefined);
    b.emit('item/completed', { turnId, item: { ...f.command, id: 'first-unprojectable', command: commandText, status: 'failed', exitCode: 7 } });
    await delivered(f); assert.equal(receipt.firstCommand, undefined); assert.equal(receipt.nativeReceived, true);
    await binding.close();
  }
});
test('capability absent on old source or receiver never falls back to new Native connections', async t => {
  for (const unsupported of [0, 1]) {
    const f = await fixture(t, { unsupported }); f.start(); await assert.rejects(f.bind());
    assert.equal(f.nativeCalls.length, 0); assert.equal(f.bridge.records.length, 0);
  }
});
test('wrong original source session/turn/body and completed MCP call refuse before any dispatch', async t => {
  for (const mutate of [f => ({ ...f.identity, sessionId: 'foreign-session' }), f => ({ ...f.identity, turnId: 'foreign-turn' }),
    f => { f.backends[0].runtime.outboxMcpCalls.get(f.identity.callId).arguments = { ...f.args, message: 'other' }; return f.identity; },
    f => { f.backends[0].emit('item/completed', { turnId: f.identity.turnId, item: { id: f.identity.callId, type: 'mcpToolCall', server: 'native_outbox', tool: 'workspace_outbox' } }); return f.identity; }]) {
    const f = await fixture(t); f.start(); await assert.rejects(f.bind(mutate(f))); assert.equal(f.nativeCalls.length, 0);
    assert.equal(f.bridge.records.length, 0);
  }
});
test('caller and recipient authority stay pinned across source-proof and recipient-prepare IPC awaits', async t => {
  for (const action of ['call', 'prepare']) for (const which of [0, 1]) for (const field of ['owner', 'controlRevision', 'memberRevision']) {
    const f = await fixture(t, { afterAction(name, { records }) {
      if (name === action) records[which][field] = field === 'owner' ? 'new-owner' : records[which][field] + 1;
    } });
    f.start(); await assert.rejects(f.bind(), field); assert.equal(f.nativeCalls.length, 0); assert.equal(f.bridge.records.length, 0);
    for (const b of f.backends) assert.equal(b.workspace.scopedOutboxProducer?.scopes.size || 0, 0);
  }
});
test('receiver native stale connection/subscription, private draft, approval, queue and shared run prevent sending', async t => {
  for (const mutate of [b => { b.runtime.needsSubscription = true; }, b => { b.runtime.transportDisconnected = true; },
    b => { b.nativeRecord.terminalInputPending = true; }, b => { b.runtime.pendingQueue = { tag: 'old' }; },
    b => { b.nativeRecord.approval = { id: 'approval' }; }, b => { b.workspace.room.run = { status: 'running' }; }]) {
    const f = await fixture(t); f.start(); mutate(f.backends[1]); await assert.rejects(f.bind()); assert.equal(f.nativeCalls.length, 0);
  }
});
test('backend token ownership, invalidation and projections are confined to the authenticated service client', async t => {
  const f = await fixture(t); f.start(); const binding = await f.bind(), b = f.backends[1];
  const other = await connectService(b.root, 'other-window'); let leaked = 0; other.on('scopedOutbox', () => leaked++);
  t.after(() => other.socket.destroy());
  const scope = [...b.workspace.scopedOutboxProducer.scopes.values()][0];
  for (const action of ['check', 'close']) {
    const r = await other.call('scopedOutbox', action, { token: scope.token });
    assert.equal(r.ok, false); assert.equal(r.failureReason, 'grant-invalidated');
  }
  b.nativeRecord.controlRevision++; b.workspace.changed(); await tick();
  await assert.rejects(binding.forwardOnce()); assert.equal(f.nativeCalls.length, 0); assert.equal(leaked, 0);
  await binding.close();
});
test('backend source authority is refreshed even when the GUI has not received its changed owner or membership', async t => {
  for (const change of [b => { b.nativeRecord.controlRevision++; }, b => { b.nativeRecord.memberRevision++; },
    b => { b.runtime.lifecycleRevision++; }, b => { b.emit('item/completed', { turnId: 'source-turn', item: { id: 'source-call', type: 'mcpToolCall', server: 'native_outbox', tool: 'workspace_outbox' } }); }]) {
    const f = await fixture(t); f.start(); const binding = await f.bind(); change(f.backends[0]);
    await assert.rejects(binding.forwardOnce()); assert.equal(f.nativeCalls.length, 0); assert.equal(f.bridge.records.length, 0);
    await binding.close();
  }
});
test('a prepare control failure survives an additional backend cleanup failure without exposing raw errors', async t => {
  const f = await fixture(t, { afterAction(action, { i, record }) { if (i === 1 && action === 'prepare') record.controlRevision++; } });
  const client = f.entries[1].client, call = client.call.bind(client);
  client.call = async (...args) => { const value = await call(...args); if (args[1] === 'close') throw Error('PRIVATE_CLEANUP_ERROR'); return value; };
  f.start(); let error; try { await f.bind(); } catch (e) { error = e; }
  assert.equal(classifyOutboxFailure(error).failureReason, 'control-changed');
  assert.equal(classifyOutboxFailure(error).cleanupUnconfirmed, true); assert.equal(f.nativeCalls.length, 0);
  assert.equal(error.message.includes('PRIVATE_'), false);
});
test('a backend-only recipient change refuses before Native write and retains its unconfirmed draft row', async t => {
  const f = await fixture(t); f.start(); const binding = await f.bind(); f.backends[1].nativeRecord.owner = 'new-private-owner';
  await assert.rejects(binding.forwardOnce()); assert.equal(f.nativeCalls.length, 0);
  assert.equal(f.bridge.sharedMessages()[0].status, 'unconfirmed'); assert.equal(f.bridge.sharedMessages()[0].text, f.args.message);
  assert.equal(f.backends[1].nativeRecord.messages.length, 0); await binding.close();
});
test('wrong RPC, tag, lifecycle and turn cannot manufacture the scoped first completed command', async t => {
  const f = await fixture(t, { ackOnly: true }); f.start(); const binding = await f.bind();
  const tag = await binding.forwardOnce(); let receipt; binding.watchReceipt({ messageId: tag }, r => { receipt = r; });
  const b = f.backends[1], turnId = 'receiver-turn';
  b.emit('turn/started', { turn: { id: turnId } });
  b.emit('item/completed', { turnId, item: { id: 'echo', type: 'userMessage', clientId: tag } });
  const item = { source: 'codex-native', kind: 'commandExecution', id: 'fake', turnId, inputTag: tag,
    input: 'git status --short', rpc: b.nativeRpc, lifecycle: b.runtime.lifecycleRevision };
  for (const delta of [{ rpc: {} }, { lifecycle: 99 }, { inputTag: 'other' }, { turnId: 'foreign' }]) {
    b.runtime.emit('scopedOutboxCommand', { ...item, ...delta, status: 'inProgress' });
    b.runtime.emit('scopedOutboxCommand', { ...item, ...delta, status: 'completed', exitCode: 0 });
  }
  await delivered(f); assert.equal(receipt.nativeReceived, true); assert.equal(receipt.firstCommand, undefined);
  b.emit('item/started', { turnId, item: f.command });
  b.emit('item/completed', { turnId, item: { ...f.command, status: 'completed', exitCode: 0 } });
  await delivered(f); assert.equal(receipt.firstCommand.id, f.command.id);
  assert.deepEqual(Object.keys(receipt).sort(), ['source','nativeId','inputTag','nativeReceived','turnId','firstCommand','messageId','recipientId'].sort());
  await binding.close();
});
test('raw errors after possible native dispatch remain unconfirmed and cannot authorize resend or expose private text', async t => {
  const f = await fixture(t, { beforeNative() { throw Error('PRIVATE_RAW_ERROR'); } }); f.start(); const binding = await f.bind();
  let failure; try { await binding.forwardOnce(); } catch (e) { failure = e; }
  assert.equal(classifyOutboxFailure(failure).failurePhase, 'view-send'); assert.ok(!failure.message.includes('PRIVATE_'));
  assert.equal(f.nativeCalls.length, 1); assert.equal(f.bridge.sharedMessages()[0].status, 'unconfirmed');
  await assert.rejects(binding.forwardOnce()); assert.equal(f.nativeCalls.length, 1); await binding.close();
});

for (const mode of ['gui-connection-during-source-proof', 'backend-peer-before-prepare', 'backend-start-before-prepare'])
test(`scoped receiver keeps the original shared input identity: ${mode}`, async t => {
  let f;
  f = await fixture(t, {
    afterAction(action, { i }) {
      if (mode === 'gui-connection-during-source-proof' && action === 'call' && i === 0) {
        f.records[1].connectionRevision++;
        f.backends[1].nativeRecord.connectionRevision++;
      }
    },
    beforeAction(action, { i, nativeRecord }) {
      if (action !== 'prepare' || i !== 1) return;
      if (mode === 'backend-peer-before-prepare') nativeRecord.peerRevision++;
      if (mode === 'backend-start-before-prepare') nativeRecord.serverIdentity = {
        pid: nativeRecord.pid, started: 'synthetic-new-native-server-start' };
    },
  });
  f.start(); let binding, refusal;
  try { binding = await f.bind(); await binding.forwardOnce(); }
  catch (e) { refusal = e; }
  finally { await binding?.close(); }
  assert.equal(f.nativeCalls.length, 0, 'Never adopt a newer receiver identity after source admission began');
  assert.equal(f.bridge.records.length, 0);
  assert.equal(classifyOutboxFailure(refusal).failureReason, 'control-changed');
  t.diagnostic(JSON.stringify({ syntheticNativeCalls: f.nativeCalls.length,
    serviceRequests: f.calls.length, sharedRows: f.bridge.records.length }));
});

for (const mode of ['session', 'global']) test(`scoped agent send respects the existing ${mode} wake off switch`, async t => {
  const f = await fixture(t), b = f.backends[1];
  require('../session-wake.cjs').setPolicy(b.workspace, mode === 'session' ? 'recipient' : null, false);
  f.start(); let binding, refusal;
  try { binding = await f.bind(); await binding.forwardOnce(); }
  catch (e) { refusal = e; }
  finally { await binding?.close(); }
  assert.equal(f.nativeCalls.length, 0, 'The existing Prevent other agents from waking switch must not be bypassed');
  assert.equal(f.bridge.records.length, 0);
  assert.ok(refusal);
});

for (const status of ['paused', 'blocked', 'usageLimited', 'budgetLimited', 'unexpected']) test(`managed native goal ${status} refuses agent input without setter or native write`, async t => {
  const f = await fixture(t, { goalStatus: status }); f.start();
  await assert.rejects(f.bind(), error => classifyOutboxFailure(error).failureReason === (status === 'unexpected' ? 'native-goal-unconfirmed' : 'native-goal-disallows'));
  assert.equal(f.goalReads.length, 1); assert.equal(f.nativeCalls.length, 0); assert.equal(f.bridge.records.length, 0);
});
test('managed native goal is checked again after prepare and human changes during goal read revoke input', async t => {
  for (const mode of ['paused-after-prepare', 'human-during-read']) {
    let status = 'active', change = false;
    const f = await fixture(t, { goalStatus: () => status, beforeGoal({ nativeRecord }) { if (change && mode === 'human-during-read') nativeRecord.controlRevision++; } });
    f.start(); const binding = await f.bind();
    if (mode === 'paused-after-prepare') status = 'paused'; else change = true;
    await assert.rejects(binding.forwardOnce()); assert.equal(f.nativeCalls.length, 0);
    assert.equal(f.goalReads.length, 2); await binding.close();
  }
});
test('managed native outbox preserves cooldown and consecutive wake limits', async t => {
  for (const wakeBudget of [
    { version: 2, lastAt: Date.now(), humanRevision: 0, senders: { sender: { id: 'earlier', streak: 1 } } },
    { version: 2, lastAt: 1, humanRevision: 0, senders: { sender: { id: 'earlier', streak: 8 } } },
  ]) {
    const f = await fixture(t); f.backends[1].nativeRecord.wakeBudget = wakeBudget; f.start();
    await assert.rejects(f.bind()); assert.equal(f.nativeCalls.length, 0); assert.equal(f.goalReads.length, 0);
  }
});
test('managed successful input durably reserves exactly one existing wake budget', async t => {
  const f = await fixture(t); f.start(); const binding = await f.bind(); await binding.forwardOnce();
  const s = f.backends[1].nativeRecord; assert.equal(s.wakeBudget.senders[f.records[0].nativeId].streak, 1); assert.equal(f.goalReads.length, 2);
  assert.equal(f.nativeCalls.length, 1); assert.equal(f.bridge.records[0].agentWakeBudget, undefined);
  await binding.close();
});

test('native wake and managed outbox share one recipient budget; the ninth mixed automatic input is refused', async t => {
  const wake = require('../session-wake.cjs'), { identity: inputIdentity } = require('../peer-handoffs.cjs');
  const f = await fixture(t), b = f.backends[1], w = b.workspace, s = b.nativeRecord;
  // Trusted source transport is synthetic here; receive/send/accounting and
  // scoped outbox use the same real Workspace and original recipient runtime.
  const sourceKey = 'backends/aaaaaaaaaaaaaaaaaaaa';
  fs.mkdirSync(path.join(b.root, sourceKey), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(b.root, 'services.json'), JSON.stringify({ format: 1, active: '.', entries: ['.', sourceKey] }), { mode: 0o600 });
  w.peerRunner = { root: () => b.root };
  w.peerRunner.takeWake = async spec => ({ ...spec, senderId: 'sender', nativeId: f.records[0].nativeId,
    boundary: wake.boundary(w), targetProof: inputIdentity(s), body: 'Synthetic native wake', senderName: 'Synthetic source', time: Date.now() });
  b.runtime.chatAvailable = true; b.runtime.needsSubscription = false;
  const settle = () => { b.emit('turn/completed', { turn: { id: 'receiver-turn', status: 'completed' } }); s.wakeBudget.lastAt = 1; };
  await wake.receive(w, { sourceKey, id: randomUUID(), senderId: 'sender', recipientId: s.id });
  assert.equal(s.wakeBudget.senders[f.records[0].nativeId].streak, 1); settle();
  f.start(); const binding = await f.bind(); await binding.forwardOnce(); await binding.close();
  assert.equal(s.wakeBudget.senders[f.records[0].nativeId].streak, 2); settle();
  for (let n = 3; n <= 8; n++) {
    await wake.receive(w, { sourceKey, id: randomUUID(), senderId: 'sender', recipientId: s.id });
    assert.equal(s.wakeBudget.senders[f.records[0].nativeId].streak, n); settle();
  }
  f.identity.callId = 'ninth-mixed-call'; f.start();
  await assert.rejects(f.bind());
  assert.equal(f.nativeCalls.filter(c => c.method === 'turn/start').length, 8);
  assert.equal(s.wakeBudget.senders[f.records[0].nativeId].streak, 8); assert.equal(f.bridge.records.length, 1);
  w.persist(); assert.equal(JSON.parse(fs.readFileSync(path.join(b.root, 'workspace.json'))).sessions.find(r => r.id === s.id).wakeBudget.senders[f.records[0].nativeId].streak, 8);
});
