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
async function fixture(t) {
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
