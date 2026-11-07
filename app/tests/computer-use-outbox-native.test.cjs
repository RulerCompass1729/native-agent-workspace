const test = require('node:test'), assert = require('node:assert/strict');
const { Codex } = require('../adapters.cjs');
const { nativeOutboxCall, nativeOutboxReceipt, validateOutboxArgs } = require('../computer-use-outbox-native.cjs');
const { projectOutboxFacts } = require('../computer-use-outbox-view.cjs');
const identity = { nativeId: 'sender-native', sessionId: 'session', turnId: 'turn', callId: 'call' };
const args = { recipient_id: 'recipient', message: '  first line\n\tsecond line  ' };
function runtime() {
  const rpc = { connected: true }, host = { rpc, codexTargets: new Map() };
  const r = new Codex({ nativeId: identity.nativeId, messages: [] }, host);
  r.turnId = identity.turnId; r.nativeSessionId = identity.sessionId; r.latestState = 'working';
  return r;
}
function item(r, change = {}) {
  r.event({ method: 'item/started', params: { threadId: r.record.nativeId, turnId: identity.turnId,
    item: { type: 'mcpToolCall', id: identity.callId, server: 'native_outbox', tool: 'workspace_outbox', arguments: args, status: 'inProgress', ...change } } }, r.host.rpc);
}
test('multiline outbox text is exact; only protocol controls are rejected', () => {
  assert.equal(validateOutboxArgs(args).message, args.message);
  assert.throws(() => validateOutboxArgs({ ...args, message: 'a\x00b' }));
  assert.throws(() => validateOutboxArgs({ ...args, caller_id: 'forged' }));
});
test('page facts cannot override Main authority; textarea CRLF display retains the exact transport body', () => {
  const text = '  first\r\n\tsecond  ', grant = { callerValid: false, callerId: 'sender', nativeId: 'native', memberRevision: 3, ready: false };
  const result = projectOutboxFacts({ text, spaceId: 'shared' }, grant,
    { callerValid: true, callerId: 'forged', nativeId: 'forged', memberRevision: 99, ready: true,
      recipientId: 'recipient', body: '  first\n\tsecond  ', revision: 'revision' }, 'owned');
  assert.equal(result.body, text); assert.equal(result.callerValid, false); assert.equal(result.callerId, 'sender');
  assert.equal(result.nativeId, 'native'); assert.equal(result.memberRevision, 3); assert.equal(result.ready, false);
  const edited = projectOutboxFacts({ text, spaceId: 'shared' }, grant, { body: 'Changed', revision: 'changed' }, 'owned');
  assert.equal(edited.body, 'Changed');
});
test('an actual owning adapter call binds native session, turn, body and connection, then expires on completion', async () => {
  const r = runtime(); item(r);
  const proof = await nativeOutboxCall(r, identity, args, AbortSignal.timeout(3000)); assert.equal(proof.valid(), true);
  await assert.rejects(nativeOutboxCall(r, identity, args, AbortSignal.timeout(3000)), /verified/);
  const call = r.outboxMcpCalls.get(identity.callId);
  for (const [field, value] of [['nativeSessionId', 'foreign'], ['turnId', 'foreign'], ['lifecycleRevision', r.lifecycleRevision + 1]]) {
    const saved = r[field]; r[field] = value; assert.equal(proof.valid(), false); r[field] = saved;
  }
  const rpc = r.host.rpc; r.host.rpc = {}; assert.equal(proof.valid(), false); r.host.rpc = rpc;
  call.arguments.message = 'other'; assert.equal(proof.valid(), false); call.arguments.message = args.message;
  r.event({ method: 'item/completed', params: { threadId: r.record.nativeId, turnId: identity.turnId,
    item: { id: identity.callId, type: 'mcpToolCall', server: 'native_outbox', tool: 'workspace_outbox', arguments: args } } }, rpc);
  assert.equal(proof.valid(), false);
});
test('MCP metadata arriving before its native item waits for that exact proof', async () => {
  const r = runtime(); let finished = false;
  const pending = nativeOutboxCall(r, identity, args, AbortSignal.timeout(3000)).then(value => { finished = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
  item(r); assert.equal((await pending).valid(), true);
});
test('a display success, wrong namespace or different raw arguments cannot authorize the outbox', async () => {
  for (const change of [{ server: 'other' }, { tool: 'workspace_message' }, { arguments: { ...args, recipient_id: 'other' } }]) {
    const r = runtime(); item(r, change);
    await assert.rejects(nativeOutboxCall(r, identity, args, AbortSignal.abort()));
  }
});
test('native receipt is captured before ACK; only the exact accepted tag/turn first real command is exposed', () => {
  const r = runtime(), capture = nativeOutboxReceipt(r, r.record.nativeId); let value;
  r.ownInputs.add('new-tag');
  r.nativeAcceptedInput = { tag: 'new-tag', turnId: 'new-turn', rpc: r.host.rpc, lifecycle: r.lifecycleRevision };
  r.emit('nativeAcceptedInput');
  r.emit('progress', { id: 'foreign', kind: 'commandExecution', status: 'completed', exitCode: 0, input: 'SECRET', source: 'codex-native', inputTag: 'other-tag', turnId: 'new-turn' });
  r.emit('progress', { id: 'wrong-turn', kind: 'commandExecution', status: 'completed', exitCode: 0, input: 'SECRET', source: 'codex-native', inputTag: 'new-tag', turnId: 'other-turn' });
  capture.bind('new-tag'); const unsubscribe = capture.subscribe(result => { value = result; });
  assert.equal(value.nativeReceived, true); assert.equal(value.firstCommand, undefined);
  r.emit('progress', { id: 'command', kind: 'commandExecution', status: 'completed', exitCode: 0, input: 'git status --short', source: 'codex-native', inputTag: 'new-tag', turnId: 'new-turn', text: 'DO_NOT_EXPOSE_OUTPUT' });
  assert.equal(value.firstCommand.command, 'git status --short'); assert.ok(!JSON.stringify(value).includes('SECRET')); assert.ok(!JSON.stringify(value).includes('DO_NOT_EXPOSE'));
  unsubscribe(); capture.close(); assert.equal(r.listenerCount('nativeAcceptedInput'), 0); assert.equal(r.listenerCount('progress'), 0);
});
test('native receive on another RPC/lifecycle and submission-only ACK never count', () => {
  const r = runtime(), capture = nativeOutboxReceipt(r, r.record.nativeId); let received = 0;
  capture.bind('new-tag'); capture.subscribe(() => received++); r.ownInputs.add('new-tag');
  for (const change of [{ rpc: {} }, { lifecycle: r.lifecycleRevision + 1 }]) {
    r.nativeAcceptedInput = { tag: 'new-tag', turnId: 'new-turn', rpc: r.host.rpc, lifecycle: r.lifecycleRevision, ...change }; r.emit('nativeAcceptedInput');
  }
  r.emit('submitted', 'new-tag'); assert.equal(received, 0); capture.close();
});
test('actual native started-then-declined command never counts as execution; only a completed command carries its exit evidence', () => {
  const r = runtime(), capture = nativeOutboxReceipt(r, r.record.nativeId); let value;
  capture.bind('message-tag'); capture.subscribe(receipt => { value = receipt; }); r.ownInputs.add('message-tag');
  const emit = (method, item) => r.event({ method, params: { threadId: r.record.nativeId, turnId: r.turnId, item } }, r.host.rpc);
  emit('item/completed', { id: 'input', type: 'userMessage', clientId: 'message-tag', content: [{ type: 'inputText', text: 'One task' }] });
  const item = { id: 'declined-command', type: 'commandExecution', command: 'git status --short', status: 'inProgress', cwd: '/synthetic', commandActions: [] };
  emit('item/started', item); assert.equal(value.firstCommand, undefined);
  emit('item/completed', { ...item, status: 'declined' }); assert.equal(value.firstCommand, undefined);
  emit('item/started', { ...item, id: 'real-command' }); assert.equal(value.firstCommand, undefined);
  emit('item/completed', { ...item, id: 'real-command', status: 'completed', exitCode: 0, aggregatedOutput: 'DO_NOT_EXPOSE_OUTPUT' });
  assert.equal(value.firstCommand.id, 'real-command'); assert.equal(value.firstCommand.status, 'completed'); assert.equal(value.firstCommand.exitCode, 0);
  assert.ok(!JSON.stringify(value).includes('DO_NOT_EXPOSE')); capture.close();
});
