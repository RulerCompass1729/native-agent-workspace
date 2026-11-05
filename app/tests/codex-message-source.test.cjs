const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { EventEmitter } = require('node:events');
const source = fs.readFileSync(require.resolve('../adapters.cjs'), 'utf8');
const start = source.indexOf('async function workspaceMcpProof('), end = source.indexOf('\nclass NativeHost', start);
assert.ok(start >= 0 && end > start);
const proof = vm.runInNewContext('(' + source.slice(start, end) + ')', { uiError: require('../ui-errors.cjs').uiError });
const turnId = 'owned-native-turn', callId = 'exec-owned-inner-call';
const identity = { nativeId: 'owned-thread', sessionId: 'owned-session', turnId, callId };
const args = { recipient_id: 'owned-peer', message: 'Synthetic capture only.' };
function fixture(ready = true) {
  const runtime = new EventEmitter(), socket = new EventEmitter(), call = { turnId, arguments: { ...args } };
  Object.assign(runtime, { nativeSessionId: identity.sessionId, turnId, workspaceMcpCalls: new Map(ready ? [[callId, call]] : []) });
  socket.destroyed = false;
  return { runtime, socket, call };
}
function clean(f) { assert.equal(f.runtime.listenerCount('workspaceMcpProof'), 0); assert.equal(f.runtime.listenerCount('nativeTurnEnd'), 0); assert.equal(f.socket.listenerCount('close'), 0); }
for (const order of ['native-first', 'MCP-first']) test('native workspace provenance joins both source orders: ' + order, async () => {
  const f = fixture(order === 'native-first'); let done = false;
  const pending = proof(f.runtime, identity, args, f.socket).then(value => { done = true; return value; });
  if (order === 'MCP-first') { await Promise.resolve(); assert.equal(done, false); f.runtime.workspaceMcpCalls.set(callId, f.call); f.runtime.emit('workspaceMcpProof'); }
  assert.equal(await pending, f.call); clean(f);
});
for (const scenario of ['wrong-session', 'wrong-turn', 'wrong-native-item-turn', 'wrong-recipient', 'wrong-body', 'stopped', 'disconnected', 'socket-already-closed']) test('native workspace provenance refuses ' + scenario, async () => {
  const f = fixture(), current = { ...identity }, body = { ...args };
  if (scenario === 'wrong-session') current.sessionId = 'other-session';
  if (scenario === 'wrong-turn') current.turnId = 'other-turn';
  if (scenario === 'wrong-native-item-turn') f.call.turnId = 'other-turn';
  if (scenario === 'wrong-recipient') body.recipient_id = 'other-peer';
  if (scenario === 'wrong-body') body.message = 'Different message';
  if (scenario === 'stopped') f.runtime.stopped = true;
  if (scenario === 'disconnected') f.runtime.transportDisconnected = true;
  if (scenario === 'socket-already-closed') f.socket.destroyed = true;
  await assert.rejects(proof(f.runtime, current, body, f.socket)); clean(f);
});
for (const boundary of ['matching-turn-end', 'MCP-socket-close']) test('pending native workspace proof expires on ' + boundary, async () => {
  const f = fixture(false); let done = false;
  const pending = proof(f.runtime, identity, args, f.socket).finally(() => { done = true; });
  const rejected = assert.rejects(pending);
  f.runtime.emit('nativeTurnEnd', { turnId: 'unrelated-turn' }); await Promise.resolve(); assert.equal(done, false, 'another turn cannot cancel this join');
  if (boundary === 'matching-turn-end') f.runtime.emit('nativeTurnEnd', { turnId });
  else { f.socket.destroyed = true; f.socket.emit('close'); }
  await rejected; clean(f);
});

test('workspace instructions use discovered Codex tool names while preserving the exact authorized roster and task', () => {
  const { taskText } = require('../addressed-handoffs.cjs');
  const text = taskText({ ids: ['peer-a', 'peer-b'], names: { 'peer-a': 'A', 'peer-b': 'B' }, maxSteps: 3, steps: 1 }, 'Keep this exact task.', 'peer-a');
  assert.ok(text.startsWith('Keep this exact task.\n'));
  assert.ok(text.includes('peer-a: A\npeer-b: B'));
  assert.ok(text.includes('ALL_TOOLS') && text.includes("native_workspace's workspace_message") && text.includes('exact exposed name'));
  assert.ok(!text.includes('tools.workspace__workspace_message'));
  assert.ok(text.includes('At most 2 replies remain') && text.includes('No tool call means answer the human and stop'));
});
