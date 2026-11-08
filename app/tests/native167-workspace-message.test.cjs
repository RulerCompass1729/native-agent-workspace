const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { NativeHost, Codex } = require('../adapters.cjs');

const identity = { nativeId: 'owned-thread', sessionId: 'owned-native-session', turnId: 'owned-turn', callId: 'inner-mcp-call' };
const body = { recipient_id: 'chosen-peer', message: '  核对原文 hello world\n第二行，不经 IME 改写。  ' };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, version = '0.167.0') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-proof-'));
  const host = new NativeHost(dir); await host.start();
  host.rpc = { nativeVersion: version };
  const runtime = new Codex({ nativeId: identity.nativeId, messages: [] }, host);
  Object.assign(runtime, { nativeSessionId: identity.sessionId, turnId: identity.turnId });
  host.codexTargets.set(identity.nativeId, runtime);
  const staged = [], sockets = new Set();
  let received;
  const accepted = new Promise(resolve => { received = resolve; });
  host.hooks.on('connection', socket => socket.once('data', () => setImmediate(received)));
  runtime.addressedCall = (proof, args) => { staged.push({ proof, args, validAtStage: proof.valid() }); return { status: 'staged', id: 'one-ticket' }; };
  const observe = (rpc = host.rpc, params = {}) => runtime.observeNativeItem('item/started', {
    threadId: identity.nativeId, turnId: identity.turnId,
    item: { id: identity.callId, type: 'mcpToolCall', status: 'inProgress', server: 'native_workspace', tool: 'workspace_message', arguments: body }, ...params,
  }, rpc);
  const call = (args = body, who = identity, token = host.codexMessageToken) => new Promise((resolve, reject) => {
    const socket = net.connect(host.hookSocket); sockets.add(socket); let text = '';
    socket.setEncoding('utf8'); socket.on('error', reject); socket.setTimeout(2000, () => { socket.destroy(); reject(Error('Owned fixture hook did not settle')); });
    socket.once('connect', () => socket.write(JSON.stringify({ workspaceMessage: true, token, identity: who, arguments: args }) + '\n'));
    socket.on('data', chunk => { text += chunk; if (text.includes('\n')) { resolve(JSON.parse(text.split('\n')[0])); socket.destroy(); } });
    socket.once('close', () => { sockets.delete(socket); reject(Error('Owned hook closed before result')); });
  });
  t.after(() => { for (const s of sockets) s.destroy(); host.rpc = null; host.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { host, runtime, staged, observe, call, accepted };
}

for (const version of ['0.164.0', '0.165.0', '0.166.0', '0.167.0']) {
  test(`workspace hook admits only qualified exact native ${version} with matching proof`, async t => {
    const f = await fixture(t, version); f.observe();
    assert.equal((await f.call()).status, 'staged');
    assert.equal(f.staged.length, 1); assert.deepEqual(f.staged[0].args, body);
    assert.equal(f.staged[0].proof.nativeId, identity.nativeId);
    assert.equal(f.staged[0].proof.sessionId, identity.sessionId);
    assert.equal(f.staged[0].proof.turnId, identity.turnId);
    assert.equal(f.staged[0].proof.callId, identity.callId);
    assert.equal(f.staged[0].validAtStage, true);
  });
}
test('first MCP request waits for its actual inner native item instead of guessing from tool arguments', async t => {
  const f = await fixture(t); const result = f.call();
  await tick(); await tick(); assert.equal(f.staged.length, 0);
  f.observe(); assert.equal((await result).status, 'staged');
});
test('the current terminal proxy can prove a native167 call without inventing a proxy version', async t => {
  const f = await fixture(t), proxy = { connected: true };
  f.runtime.terminalRpc = proxy; f.observe(proxy);
  assert.equal((await f.call()).status, 'staged');
  assert.equal(f.staged[0].validAtStage, true);
  assert.equal(f.runtime.workspaceMcpCalls.get(identity.callId).rpc, proxy);
  assert.equal(Object.hasOwn(proxy, 'nativeVersion'), false, 'The terminal bridge proxy is not the initialized host RPC');
});
test('disconnecting the terminal proxy revokes a held workspace staging proof', async t => {
  const f = await fixture(t), proxy = { connected: true }; let proof, release;
  f.runtime.terminalRpc = proxy; f.observe(proxy);
  f.runtime.addressedCall = p => { proof = p; return new Promise(resolve => { release = resolve; }); };
  const result = f.call(); await f.accepted; assert.equal(proof.valid(), true);
  proxy.connected = false; assert.equal(proof.valid(), false);
  release({ status: 'unconfirmed' }); await result;
});
for (const version of ['0.168.0', '0.167.0-beta', '0.167.1', undefined]) {
  test(`unknown workspace protocol ${version} is refused with no staging`, async t => {
    const f = await fixture(t, version); if (version === undefined) delete f.host.rpc.nativeVersion;
    f.observe(); assert.equal((await f.call()).status, 'unconfirmed'); assert.equal(f.staged.length, 0);
  });
}
for (const change of ['session', 'turn', 'body', 'recipient', 'token']) {
  test(`mismatched ${change} cannot stage a workspace message`, async t => {
    const f = await fixture(t, '0.165.0'); f.observe();
    const args = { ...body }, who = { ...identity }; let token = f.host.codexMessageToken;
    if (change === 'session') who.sessionId = 'another-session';
    if (change === 'turn') who.turnId = 'another-turn';
    if (change === 'body') args.message += 'changed';
    if (change === 'recipient') args.recipient_id = 'another-peer';
    if (change === 'token') token = 'wrong-token';
    assert.equal((await f.call(args, who, token)).status, 'unconfirmed'); assert.equal(f.staged.length, 0);
  });
}
for (const change of ['rpc', 'lifecycle', 'nativeId']) {
  test(`proof already captured before ${change} changes cannot authorize staging`, async t => {
    const f = await fixture(t, '0.165.0'); f.observe();
    if (change === 'rpc') f.host.rpc = { nativeVersion: '0.165.0' };
    if (change === 'lifecycle') f.runtime.lifecycleRevision++;
    if (change === 'nativeId') f.runtime.record.nativeId = 'new-native-thread';
    assert.equal((await f.call()).status, 'unconfirmed'); assert.equal(f.staged.length, 0);
  });
}
for (const change of ['lifecycle', 'item completion']) test(`a held staging proof is invalid after ${change}`, async t => {
  const f = await fixture(t, '0.165.0'); let proof, release;
  f.runtime.addressedCall = p => { proof = p; return new Promise(resolve => { release = resolve; }); };
  f.observe(); const result = f.call(); await f.accepted;
  assert.equal(proof.valid(), true);
  if (change === 'lifecycle') f.runtime.lifecycleRevision++;
  else f.runtime.observeNativeItem('item/completed', { turnId: identity.turnId, item: { id: identity.callId, type: 'mcpToolCall', status: 'completed' } });
  assert.equal(proof.valid(), false); release({ status: 'unconfirmed' }); await result;
});
for (const wrong of ['namespace', 'tool', 'rpc', 'thread', 'call']) {
  test(`foreign ${wrong} cannot create an authoritative workspace proof`, async t => {
    const f = await fixture(t, '0.165.0'); const params = {};
    if (wrong === 'thread') params.threadId = 'foreign-thread';
    if (['namespace', 'tool', 'call'].includes(wrong)) params.item = { id: identity.callId, type: 'mcpToolCall', status: 'inProgress', server: wrong === 'namespace' ? 'foreign' : 'native_workspace', tool: wrong === 'tool' ? 'foreign_tool' : 'workspace_message', arguments: body, ...(wrong === 'call' ? { id: 'outer-code-mode-id' } : {}) };
    f.observe(wrong === 'rpc' ? {} : f.host.rpc, params);
    const result = f.call(); await f.accepted;
    f.runtime.emit('nativeTurnEnd', { turnId: identity.turnId });
    assert.equal((await result).status, 'unconfirmed'); assert.equal(f.staged.length, 0);
  });
}
test('a completed inner call cannot be revived by a late duplicate start', async t => {
  const f = await fixture(t, '0.165.0'); f.observe();
  f.runtime.observeNativeItem('item/completed', { threadId: identity.nativeId, turnId: identity.turnId, item: { id: identity.callId, type: 'mcpToolCall', status: 'completed' } });
  f.observe(); const result = f.call(); await f.accepted;
  f.runtime.emit('nativeTurnEnd', { turnId: identity.turnId });
  assert.equal((await result).status, 'unconfirmed'); assert.equal(f.staged.length, 0);
});
test('a duplicate inner id cannot replace the originally observed body', async t => {
  const f = await fixture(t, '0.165.0'); f.observe();
  const changed = { ...body, message: 'different native arguments' };
  f.observe(f.host.rpc, { item: { id: identity.callId, type: 'mcpToolCall', status: 'inProgress', server: 'native_workspace', tool: 'workspace_message', arguments: changed } });
  assert.equal((await f.call(changed)).status, 'unconfirmed'); assert.equal(f.staged.length, 0);
});
