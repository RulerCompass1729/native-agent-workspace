const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createOutboxBroker } = require('../computer-use-outbox-broker.cjs');
const { requestOutbox, outboxMcpServer, registerOriginalOutbox } = require('../computer-use-outbox-tool.cjs');
const identity = { nativeId: 'sender-native', sessionId: 'session', turnId: 'turn', callId: 'call' };
const meta = { threadId: identity.nativeId, sessionId: identity.sessionId, callId: identity.callId,
  'x-codex-turn-metadata': { thread_id: identity.nativeId, turn_id: identity.turnId } };
const args = { recipient_id: 'receiver', message: '  One task\n\twith context.  ' };
async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'outbox-broker-')); fs.chmodSync(dir, 0o700);
  const descriptorFile = path.join(dir, 'owner.json');
  let forwards = 0, rendered, closeCount = 0, proofCount = 0;
  const grant = { callerId: 'sender', callerNativeId: identity.nativeId, recipientId: args.recipient_id,
    nativeId: 'receiver-native', memberRevision: 1, spaceId: 'shared', text: args.message };
  const broker = await createOutboxBroker({ descriptorFile,
    bind: async (caller, body) => {
      assert.deepEqual(caller, identity); assert.deepEqual(body, args); proofCount++;
      return { grant, inspectGrant: async () => ({ ...grant, callerValid: true, ready: true }),
        forwardOnce: async () => { forwards++; return 'message-id'; },
        watchReceipt: async (scope, listener) => {
          listener({ ...scope, inputTag: 'message-id', source: 'codex-native', turnId: 'receiver-turn', nativeReceived: true,
            firstCommand: { id: 'command', kind: 'commandExecution', status: 'completed', exitCode: 0, inputTag: 'message-id', turnId: 'receiver-turn', command: 'git status --short' } });
          return () => {};
        }, close() {} };
    },
    createView: async (model, actions) => ({ owner: 'owned-composer',
      inspect: async () => ({ ...grant, callerValid: true, ready: true, owner: 'owned-composer', selected: 'room', surface: 'records', body: model.text, revision: '1' }),
      target: async () => ({ id: 'forward-button', kind: 'send', visible: true, disabled: false }),
      invoke: async name => {
        if (name === 'browser_snapshot') return { content: [{ type: 'text', text: '### Snapshot\n```yaml\n- button "发送" [ref=e1]\n```' }] };
        assert.equal(name, 'browser_click'); await actions.send(); return { content: [{ type: 'text', text: 'clicked' }] };
      }, showReceipt: async value => { rendered = value; }, close: async () => { closeCount++; } }),
    ...options,
  });
  t.after(async () => { await broker.close(); fs.rmSync(dir, { recursive: true }); });
  return { broker, descriptorFile, state: () => ({ forwards, rendered, closeCount, proofCount }) };
}
test('scoped broker drives the leased UI once and returns native receipt rather than stock click success', async t => {
  const f = await fixture(t), result = await requestOutbox(f.descriptorFile, identity, args);
  assert.equal(result.status, 'working'); assert.equal(result.nativeReceived, true); assert.equal(result.senderId, 'sender');
  assert.equal(result.firstCommand.command, 'git status --short'); assert.equal(result.text, args.message);
  assert.equal(f.state().forwards, 1); assert.equal(f.state().closeCount, 1); assert.equal(f.state().rendered.status, 'working');
});
test('background control receives a full long-thread snapshot above the old four-MiB reply limit', async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'outbox-control-size-'));
  fs.chmodSync(dir, 0o700);
  const descriptorFile = path.join(dir, 'owner.json'), command = { action: 'snapshot' };
  const value = { state: 'complete', value: { messages: [{ text: '界'.repeat(2 * 1024 * 1024) }] } };
  let calls = 0;
  const broker = await createOutboxBroker({ descriptorFile,
    bind: async () => { throw Error('No message send allowed'); },
    createView: async () => { throw Error('No desktop view allowed'); },
    bindControl: async (caller, args) => { assert.deepEqual(caller, identity); assert.deepEqual(args, command); return { args }; },
    control: async () => { calls++; return value; },
  });
  t.after(async () => { await broker.close(); fs.rmSync(dir, { recursive: true }); });
  const result = await requestOutbox(descriptorFile, identity, command, undefined, true);
  assert.deepEqual(result, value, 'Native history is not truncated or translated');
  assert.equal(calls, 1, 'Reading a large result does not retry the operation');
});
for (const [name, reply] of [['oversized ordinary receipt', JSON.stringify({ text: 'x'.repeat(100001) }) + '\n'], ['malformed reply', '{not JSON}\n']]) {
  test(`native control transport promptly rejects ${name} without replay`, { timeout: 3000 }, async t => {
    const net = require('node:net'), dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'outbox-invalid-frame-'));
    fs.chmodSync(dir, 0o700);
    const descriptorFile = path.join(dir, 'owner.json'), socketPath = path.join(dir, 'reply.sock'), sockets = new Set(), abort = new AbortController();
    let calls = 0;
    const server = net.createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
      socket.once('data', () => { calls++; socket.write(reply); });
    });
    t.after(async () => { abort.abort(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true }); });
    await new Promise(resolve => server.listen(socketPath, resolve)); fs.chmodSync(socketPath, 0o600);
    fs.writeFileSync(descriptorFile, JSON.stringify({ version: 1, capability: 'a'.repeat(64), socketPath }), { mode: 0o600 });
    await assert.rejects(requestOutbox(descriptorFile, identity, args, abort.signal), /Outbox delivery is unconfirmed/);
    assert.equal(calls, 1);
  });
}
test('real stdio registration exposes only the scoped tool and requires native metadata before forwarding', async t => {
  const f = await fixture(t), config = outboxMcpServer(f.descriptorFile);
  const child = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', part => { stderr += part; });
  const { JsonRpcLineTransport } = await import('@deepseek-ai/dsh-sdk-protocol');
  const transport = new JsonRpcLineTransport(child.stdout, child.stdin); transport.start();
  t.after(async () => { child.stdin.end(); await once(child, 'exit'); transport.close(); assert.equal(stderr, ''); });
  const call = (method, params) => transport.request(method, params, AbortSignal.timeout(3000));
  await call('initialize', {}); assert.deepEqual((await call('tools/list', {})).tools.map(tool => tool.name), ['workspace_outbox']);
  await assert.rejects(call('tools/call', { name: 'workspace_outbox', arguments: args })); assert.equal(f.state().forwards, 0);
  await assert.rejects(call('tools/call', { name: 'browser_evaluate', arguments: {} })); assert.equal(f.state().forwards, 0);
  const result = await call('tools/call', { name: 'workspace_outbox', arguments: args, _meta: meta });
  assert.equal(result.isError, false); assert.equal(JSON.parse(result.content[0].text).status, 'working');
});
test('real workspace-control MCP stdio returns a nineteen-MiB snapshot intact without a provider or retry', { timeout: 15000 }, async t => {
  const text = 'x'.repeat(19 * 1024 * 1024) + '尾', command = { action: 'snapshot' };
  let calls = 0;
  const f = await fixture(t, {
    bindControl: async (caller, args) => { assert.deepEqual(caller, identity); assert.deepEqual(args, command); return { args }; },
    control: async () => { calls++; return { state: 'complete', value: { messages: [{ text }] } }; },
  });
  const child = spawn(process.execPath, [path.resolve(__dirname, '../claude-message-tool.cjs'), '--codex'], {
    env: { ...process.env, NAW_CONTROL_DESCRIPTOR: f.descriptorFile }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = ''; child.stderr.on('data', part => { stderr += part; });
  const { JsonRpcLineTransport } = await import('@deepseek-ai/dsh-sdk-protocol');
  const transport = new JsonRpcLineTransport(child.stdout, child.stdin); transport.start();
  t.after(async () => { child.stdin.end(); await once(child, 'exit'); transport.close(); assert.equal(stderr, ''); });
  const result = await transport.request('tools/call', { name: 'workspace_control', arguments: command, _meta: meta }, t.signal);
  assert.equal(result.isError, false); assert.equal(JSON.parse(result.content[0].text).value.messages[0].text, text);
  assert.equal(calls, 1); assert.equal(f.state().forwards, 0);
});
test('original-host adoption writes exactly one reviewed MCP key and labels catalog registration as untested delivery', async t => {
  const f = await fixture(t), calls = [], rpc = { async call(method, params) {
    calls.push({ method, params });
    if (method === 'config/value/write') return { status: 'ok', filePath: '/synthetic/config.toml', version: 'next' };
    if (method === 'config/mcpServer/reload') return {};
    if (method === 'mcpServerStatus/list') return { data: [{ name: 'native_outbox', tools: { workspace_outbox: {} } }] };
    throw Error('Unexpected native request');
  } };
  const result = await registerOriginalOutbox({ rpc, nativeId: identity.nativeId, descriptorFile: f.descriptorFile,
    configFile: '/synthetic/config.toml', expectedVersion: 'reviewed-version', valid: () => true });
  assert.deepEqual(calls.map(c => c.method), ['config/value/write', 'config/mcpServer/reload', 'mcpServerStatus/list']);
  assert.equal(calls[0].params.keyPath, 'mcp_servers.native_outbox'); assert.equal(calls[0].params.expectedVersion, 'reviewed-version');
  assert.equal(Object.hasOwn(calls[0].params, 'reloadUserConfig'), false);
  assert.equal(result.status, 'registered'); assert.equal(result.actualNativeCall, false); assert.equal(result.actualDelivery, false);
  assert.equal(f.state().forwards, 0);
});
test('a dead app descriptor can be replaced, while a live owner cannot be displaced', async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'outbox-restart-')); fs.chmodSync(dir, 0o700);
  const descriptorFile = path.join(dir, 'owner.json');
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},10000)']);
  const issuer = require('../platform.cjs').processIdentity(child.pid);
  child.kill('SIGTERM'); await once(child, 'exit');
  fs.writeFileSync(descriptorFile, JSON.stringify({ version: 1, issuer, capability: 'a'.repeat(64), socketPath: path.join(dir, 'gone.sock') }), { mode: 0o600 });
  let broker;
  t.after(async () => { await broker?.close(); fs.rmSync(dir, { recursive: true }); });
  const options = { descriptorFile, bind: async () => { throw Error('No native call in this test'); }, createView: async () => { throw Error('No GUI in this test'); } };
  broker = await createOutboxBroker(options);
  await assert.rejects(createOutboxBroker(options));
  assert.equal(JSON.parse(fs.readFileSync(descriptorFile)).issuer.pid, process.pid);
});

for (const stage of ['binding', 'execution', 'cleanup']) test(`control broker retains trusted failure diagnostics through ${stage} without replay`, async t => {
  const { outboxError } = require('../computer-use-outbox-native.cjs');
  let binds = 0, calls = 0, closes = 0;
  const fail = () => { throw outboxError('control-changed', 'binding', 'Opaque native failure', stage === 'cleanup'); };
  const command = { action: 'invoke', operation_id: 'diagnostic-control', method: 'rename', arguments: ['target', 'name'] };
  const f = await fixture(t, {
    bindControl: async () => { binds++; if (stage === 'binding') fail(); return { args: command, close() { closes++; if (stage === 'cleanup') fail(); } }; },
    control: async () => { calls++; if (stage === 'execution') fail(); return { state: 'complete' }; },
  });
  const result = await requestOutbox(f.descriptorFile, identity, command, undefined, true);
  assert.equal(result.state, 'unconfirmed'); assert.equal(result.retry, false);
  assert.equal(result.failurePhase, 'binding'); assert.equal(result.failureReason, 'control-changed');
  assert.equal(result.cleanupUnconfirmed, stage === 'cleanup' ? true : undefined);
  assert.equal(binds, 1); assert.equal(calls, stage === 'binding' ? 0 : 1); assert.equal(closes, stage === 'binding' ? 0 : 1);
});
test('control diagnostics ignore enumerable lookalikes and keep an unclassified failure explicit', async t => {
  const f = await fixture(t, { bindControl: async () => { throw Object.assign(Error('Unknown failure'), { failureReason: 'control-changed', failurePhase: 'view-send', privateBody: 'PRIVATE_CONTENT' }); }, control: async () => assert.fail('No operation') });
  const result = await requestOutbox(f.descriptorFile, identity, { action: 'catalog' }, undefined, true);
  assert.equal(result.failurePhase, 'binding'); assert.equal(result.failureReason, 'binding-unavailable');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CONTENT|view-send|control-changed/);
});

test('control cleanup failure keeps the executed operation identity without releasing its private value or replaying', async t => {
  const { outboxError } = require('../computer-use-outbox-native.cjs');
  let calls = 0;
  const command = { action: 'invoke', operation_id: 'executed-control', method: 'rename', arguments: ['target', 'name'] };
  const actor = { id: 'sender', nativeId: identity.nativeId, provider: 'codex' };
  const f = await fixture(t, {
    bindControl: async () => ({ args: command, close() { throw outboxError('cleanup-unconfirmed', 'cleanup'); } }),
    control: async () => { calls++; return { state: 'complete', id: command.operation_id, actor, value: 'PRIVATE_RESULT_NOT_RELEASED' }; },
  });
  const result = await requestOutbox(f.descriptorFile, identity, command, undefined, true);
  assert.equal(calls, 1); assert.equal(result.state, 'unconfirmed'); assert.equal(result.retry, false);
  assert.equal(result.id, command.operation_id); assert.deepEqual(result.actor, actor);
  assert.equal(result.failurePhase, 'cleanup'); assert.equal(result.cleanupUnconfirmed, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_RESULT_NOT_RELEASED/);
});
test('a control execution refusal keeps its named cause when cleanup also fails', async t => {
  const { outboxError } = require('../computer-use-outbox-native.cjs');
  const f = await fixture(t, {
    bindControl: async () => ({ args: { action: 'catalog' }, close() { throw Error('Secondary cleanup failure'); } }),
    control: async () => { throw outboxError('native-call-invalidated', 'binding', undefined, false, 'display-gap'); },
  });
  const result = await requestOutbox(f.descriptorFile, identity, { action: 'catalog' }, undefined, true);
  assert.equal(result.failureReason, 'native-call-invalidated'); assert.equal(result.failureCheck, 'display-gap');
  assert.equal(result.cleanupUnconfirmed, true); assert.equal(result.retry, false);
});
test('a managed scope close that answers late, but answers, keeps a complete control result complete', async t => {
  // 2026-11-15 12:03 PT, daily 253: a butler queueAdd was durably complete with its queue item created,
  // but the caller got "could not be verified" with no operation id. With a valid token the service's
  // close cannot answer ok:false; only this transport's own close timer can raise that error after
  // a complete result, and the queueAdds around it took 6-9 s each. Here the close answers after 5.5 s.
  const { EventEmitter } = require('node:events');
  const { openManagedCall } = require('../managed-outbox-transport.cjs');
  const command = { action: 'invoke', operation_id: 'late-close', method: 'rename', arguments: ['target', 'name'] };
  const actor = { id: 'sender', nativeId: identity.nativeId, provider: 'claude' };
  const client = new EventEmitter(), actions = [];
  client.call = async (method, action, value) => {
    assert.equal(method, 'scopedOutbox'); actions.push(action);
    if (action === 'controlCall') return { ok: true, value: { token: 'scope-token', sender: { ...actor, name: 'Butler' } } };
    assert.equal(action, 'close'); assert.deepEqual(value, { token: 'scope-token' });
    await new Promise(resolve => setTimeout(resolve, 5500));
    return { ok: true, value: true };
  };
  const entry = { client, closed: false, state: { capabilities: ['scopedNativeOutboxV1', 'backgroundControlV1'] } };
  let calls = 0;
  const f = await fixture(t, {
    bindControl: (caller, body, signal) => openManagedCall(entry, { id: actor.id, provider: actor.provider }, caller, body, signal, true),
    control: async () => { calls++; return { state: 'complete', id: command.operation_id, actor, value: 'queued' }; },
  });
  const result = await requestOutbox(f.descriptorFile, identity, command, undefined, true);
  assert.deepEqual(actions, ['controlCall', 'close']); assert.equal(calls, 1);
  assert.equal(result.state, 'complete', `got ${result.state}: ${result.failureReason}/${result.failurePhase}`);
  assert.equal(result.id, command.operation_id); assert.equal(result.value, 'queued');
});

test('a complete control result whose close outlasts the connection limit still answers with its id', async t => {
  // Codex E, review of da4a16cc: work done at 86 s plus a 16 s close passed the 100 s connection limit, which
  // dropped the answer and its operation id; with 5 s the caller got unconfirmed with the id at 91 s.
  // Here the limit is 7 s, the work is done at 0.5 s and the close does not answer.
  const { EventEmitter } = require('node:events');
  const { openManagedCall } = require('../managed-outbox-transport.cjs');
  const command = { action: 'invoke', operation_id: 'late-close', method: 'rename', arguments: ['target', 'name'] };
  const actor = { id: 'sender', nativeId: identity.nativeId, provider: 'claude' };
  const client = new EventEmitter(), actions = []; let release;
  client.call = async (method, action) => {
    actions.push(action);
    if (action === 'controlCall') return { ok: true, value: { token: 'scope-token', sender: { ...actor, name: 'Butler' } } };
    await new Promise(resolve => { release = resolve; }); return { ok: true, value: true };
  };
  const entry = { client, closed: false, state: { capabilities: ['scopedNativeOutboxV1', 'backgroundControlV1'] } };
  let calls = 0;
  const f = await fixture(t, { connectionMs: 7000,
    bindControl: (caller, body, signal) => openManagedCall(entry, { id: actor.id, provider: actor.provider }, caller, body, signal, true),
    control: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 500)); return { state: 'complete', id: command.operation_id, actor, value: 'queued' }; },
  });
  const started = Date.now();
  const result = await requestOutbox(f.descriptorFile, identity, command, undefined, true).catch(error => ({ transport: error.message }));
  const elapsed = Date.now() - started, activeAfterReply = f.broker.active(); release?.();
  assert.deepEqual(actions, ['controlCall', 'close']); assert.equal(calls, 1);
  assert.equal(result.id, command.operation_id, `no id after ${elapsed} ms: ${JSON.stringify(result)}`);
  assert.deepEqual(result.actor, actor); assert.equal(result.state, 'unconfirmed'); assert.equal(result.retry, false);
  assert.equal(result.failureReason, 'cleanup-unconfirmed'); assert.equal(result.failurePhase, 'cleanup');
  assert.equal(result.cleanupUnconfirmed, true); assert.equal(result.value, undefined);
  t.diagnostic(`near-limit control reply: ${elapsed}ms (business 500ms)`);
  assert.ok(activeAfterReply > 0, 'The early answer does not abandon its pending cleanup');
  assert.ok(elapsed < 2500, `business finished at 500ms, but the reply waited ${elapsed}ms`);
});
for (const confirmed of [true, false]) test(`a managed close with an already settled ${confirmed ? 'success' : 'failure'} is answered promptly`, async t => {
  const { EventEmitter } = require('node:events'), { openManagedCall } = require('../managed-outbox-transport.cjs');
  const command = { action: 'invoke', operation_id: 'settled-close', method: 'rename', arguments: ['target', 'name'] };
  const actor = { id: 'sender', nativeId: identity.nativeId, provider: 'claude' }, client = new EventEmitter(), actions = [];
  let calls = 0;
  client.call = async (method, action) => {
    assert.equal(method, 'scopedOutbox'); actions.push(action);
    if (action === 'controlCall') return { ok: true, value: { token: 'scope-token', sender: { ...actor, name: 'Synthetic actor' } } };
    assert.equal(action, 'close');
    return confirmed ? { ok: true, value: true } : { ok: false, failurePhase: 'cleanup', failureReason: 'cleanup-unconfirmed' };
  };
  const entry = { client, closed: false, state: { capabilities: ['scopedNativeOutboxV1', 'backgroundControlV1'] } };
  const f = await fixture(t, { connectionMs: 7000,
    bindControl: (caller, body, signal) => openManagedCall(entry, actor, caller, body, signal, true),
    control: async () => { calls++; return { state: 'complete', id: command.operation_id, actor, value: 'PRIVATE_COMPLETE_VALUE' }; },
  });
  const started = Date.now(), result = await requestOutbox(f.descriptorFile, identity, command, undefined, true);
  assert.ok(Date.now() - started < 1000, 'A settled cleanup does not wait for a connection timer');
  assert.equal(result.state, confirmed ? 'complete' : 'unconfirmed');
  assert.equal(result.id, command.operation_id); assert.deepEqual(result.actor, actor);
  if (!confirmed) {
    assert.equal(result.retry, false); assert.equal(result.cleanupUnconfirmed, true);
    assert.equal(result.failurePhase, 'cleanup'); assert.equal(result.failureReason, 'cleanup-unconfirmed');
    assert.equal(result.value, undefined);
  }
  assert.equal(calls, 1); assert.deepEqual(actions, ['controlCall', 'close']);
});
test('shutdown during control business waits for cleanup registered after closing began', { timeout: 5000 }, async t => {
  const { EventEmitter } = require('node:events');
  const { openManagedCall } = require('../managed-outbox-transport.cjs');
  const command = { action: 'invoke', operation_id: 'shutdown-op', method: 'rename', arguments: ['target', 'name'] };
  const actor = { id: 'sender', nativeId: identity.nativeId, provider: 'claude' };
  const client = new EventEmitter(), actions = [];
  let releaseBusiness, releaseCleanup, businessEntered;
  const entered = new Promise(resolve => { businessEntered = resolve; });
  const business = new Promise(resolve => { releaseBusiness = resolve; });
  const cleanup = new Promise(resolve => { releaseCleanup = resolve; });
  client.call = async (method, action) => {
    assert.equal(method, 'scopedOutbox'); actions.push(action);
    if (action === 'controlCall') return { ok: true, value: { token: 'scope-token', sender: { ...actor, name: 'Butler' } } };
    assert.equal(action, 'close'); await cleanup; return { ok: true, value: true };
  };
  const entry = { client, closed: false, state: { capabilities: ['scopedNativeOutboxV1', 'backgroundControlV1'] } };
  let calls = 0;
  const f = await fixture(t, { connectionMs: 1200,
    bindControl: (caller, body, signal) => openManagedCall(entry, { id: actor.id, provider: actor.provider }, caller, body, signal, true),
    control: async () => {
      calls++; businessEntered(); await business;
      return { state: 'complete', id: command.operation_id, actor, value: 'queued' };
    } });
  let closing, request;
  try {
    request = requestOutbox(f.descriptorFile, identity, command, undefined, true).catch(error => ({ transport: error.message }));
    await Promise.race([entered, new Promise((_, reject) => setTimeout(() => reject(Error('business did not start')), 1000))]);
    let closeReturned = false;
    closing = f.broker.close().then(() => { closeReturned = true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    releaseBusiness();
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(closeReturned, false, 'close returned while cleanup remained active');
    assert.equal(f.broker.active(), 1);
    releaseCleanup();
    await closing;
    await request;
    assert.equal(f.broker.active(), 0);
    assert.equal(calls, 1);
    assert.deepEqual(actions, ['controlCall', 'close']);
  } finally {
    releaseBusiness?.(); releaseCleanup?.(); await closing; await request;
  }
});
for (const cause of ['missing', 'consumed', 'root-changed', 'identity', 'arguments']) test(`real Claude native proof refusal reaches the broker receipt (${cause})`, async t => {
  const native = require('../background-control-native.cjs');
  const command = { action: 'invoke', operation_id: 'claude-proof-check', method: 'rename', arguments: ['target', 'name'] };
  const runtime = { record: { provider: 'claude', nativeId: 'claude-native' }, nativeBlocks: true, terminal: { alive: true }, observationEpoch: 2,
    liveTurn: { id: 'turn', promptId: 'prompt' }, validRootBinding: () => true };
  const message = { arguments: command, turnId: 'turn', promptId: 'prompt', callId: 'call', epoch: 2 };
  const proof = native.rootCall(runtime, message, new AbortController().signal, () => true);
  const callIdentity = { ...proof.identity };
  let request = command;
  if (cause === 'missing') runtime.backgroundRootCalls.clear();
  if (cause === 'consumed') native.consumeCredential(proof.credential);
  if (cause === 'root-changed') runtime.liveTurn = { id: 'replacement', promptId: 'replacement' };
  if (cause === 'identity') callIdentity.turnId = 'different';
  if (cause === 'arguments') request = { ...command, arguments: ['other', 'name'] };
  let operations = 0;
  const f = await fixture(t, { bindControl: async (_identity, args, signal) => native.nativeCall(runtime, callIdentity, args, signal), control: async () => { operations++; } });
  const result = await requestOutbox(f.descriptorFile, identity, request, undefined, true);
  assert.equal(result.state, 'unconfirmed'); assert.equal(result.retry, false); assert.equal(operations, 0);
  assert.equal(result.failurePhase, 'binding');
  assert.equal(result.failureReason, { missing: 'native-call-missing', consumed: 'duplicate-call', 'root-changed': 'native-call-invalidated',
    identity: 'native-call-identity-mismatch', arguments: 'native-call-arguments-mismatch' }[cause]);
  if (cause === 'identity' || cause === 'arguments') {
    assert.equal(native.consumeCredential(proof.credential).valid(), true, 'A mismatched request did not consume the original proof');
    assert.throws(() => native.consumeCredential(proof.credential), /unavailable/, 'The accepted original proof remains single use');
  }
});
