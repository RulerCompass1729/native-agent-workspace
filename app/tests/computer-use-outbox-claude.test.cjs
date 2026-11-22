const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { LegacyClaude } = require('../legacy-claude.cjs');
const { LegacyInput } = require('../legacy-input.cjs');
const { Codex } = require('../adapters.cjs');
const { processIdentity } = require('../platform.cjs');
const { createSubmissionServer } = require('../claude-submit.cjs');
const { bindClaudeOutbox } = require('../computer-use-outbox-owner.cjs');
const { createOutboxBroker } = require('../computer-use-outbox-broker.cjs');

// Real HTTP, lease transport, Root/LegacyInput/Codex reducers. Native frames and
// the view are synthetic: no browser, native engine, provider or model starts.
async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync('/private/tmp/claude-outbox-'); fs.chmodSync(dir, 0o700);
  const records = [
    { id: 'secretary', name: 'Secretary', provider: 'claude', nativeId: randomUUID(), pid: process.pid,
      processIdentity: processIdentity(process.pid), state: 'idle', messages: [], owner: 'source-view', roomId: 'shared', memberRevision: 1, controlRevision: 2 },
    { id: 'recipient', name: 'Recipient', provider: 'codex', nativeId: 'receiver-native', pid: 202,
      owner: 'receiver-view', roomId: 'shared', memberRevision: 3, controlRevision: 4 },
  ];
  const bridge = new LegacyInput(dir), root = new LegacyClaude(records[0], dir, async () => records[0]);
  const binding = { sessionId: root.record.nativeId, ...await root.bindRoot({ sessionId: root.record.nativeId, nativeBlocks: true, addressedTool: true }) };
  const turn = { turnId: 'root-turn', promptId: 'root-prompt' };
  root.observeRoot({ ...binding, epoch: binding.observationEpoch, sequence: 1, block: true,
    id: 'control:turn-start', kind: 'control', status: 'running', ...turn });
  bridge.targets.set('secretary', root);
  const adapter = new Codex({ ...records[1], messages: [] }, { rpc: { async call(method, params) { assert.equal(method, 'thread/goal/get'); assert.equal(params.threadId, records[1].nativeId); return { goal: null }; } }, codexTargets: new Map() });
  const counts = { forwards: 0, views: 0, closes: 0 }, args = { recipient_id: 'recipient', message: '  Implement the owned task.\r\n\tKeep its exact context.  ' };
  const native = { record: adapter.record, adapter, connected: true, closed: false, state: 'idle', sharedReplyAvailable: false, close() {} };
  native.send = async (text, tag, refresh, guard) => {
    await refresh(); assert.equal(guard(), true); assert.equal(text, args.message); counts.forwards++;
    adapter.ownInputs.add(tag); adapter.turnId = 'receiver-turn';
    adapter.event({ method: 'item/completed', params: { threadId: records[1].nativeId, turnId: adapter.turnId,
      item: { type: 'userMessage', id: 'accepted-input', clientId: tag, content: [{ type: 'text', text }] } } }, adapter.host.rpc);
    adapter.event({ method: 'item/started', params: { threadId: records[1].nativeId, turnId: adapter.turnId,
      item: { type: 'commandExecution', id: 'actual-command', command: 'git status --short', status: 'inProgress' } } }, adapter.host.rpc);
    adapter.event({ method: 'item/completed', params: { threadId: records[1].nativeId, turnId: adapter.turnId,
      item: { type: 'commandExecution', id: 'actual-command', command: 'git status --short', status: 'completed', exitCode: options.exitCode || 0,
        aggregatedOutput: 'PRIVATE_COMMAND_OUTPUT' } } }, adapter.host.rpc);
    return adapter.turnId;
  };
  bridge.targets.set('recipient', { record: records[1], native, submission: native });
  const entry = { key: 'retained', client: { call() { throw Error('No backend or private initial reads'); } }, state: { wakePolicy: { enabled: true }, sessions: records, room: { messages: [] } } };
  const control = { legacyInput: bridge, manualEpoch: 1, generations: new Map(), maintenance: new Set() };
  const client = { entries: [entry], control, socket: { destroyed: false }, route: () => entry, on() {} };
  const contexts = records.map(record => ({ client, view: { owner: record.owner }, win: { isDestroyed: () => false } }));
  const deps = { contexts: () => contexts, roomState: { assertAvailable() {} } };
  let callbackFinished;
  const finished = new Promise(resolve => { callbackFinished = resolve; });
  const broker = await createOutboxBroker({ descriptorFile: path.join(dir, 'owner.json'),
    bind: async () => { throw Error('No Codex caller in this fixture'); },
    createView: async (model, actions, authority) => {
      counts.views++;
      await options.beforeView?.({ root, control, records });
      return { owner: 'only-outbox', inspect: async () => ({ ...await authority.inspectGrant(), spaceId: 'shared', recipientId: 'recipient',
        owner: 'only-outbox', selected: 'room', surface: 'records', body: model.text, revision: '1' }),
      target: async () => ({ id: 'send-only', kind: 'send', visible: true, disabled: false }),
      invoke: async name => {
        if (name === 'browser_snapshot') return { content: [{ type: 'text', text: '### Snapshot\n```yaml\n- button "发送" [ref=e1]\n```' }] };
        assert.equal(name, 'browser_click'); await actions.send(); return { content: [{ type: 'text', text: 'click dispatched' }] };
      }, showReceipt: async () => {}, close: async () => { counts.closes++; } };
    },
  });
  // Execute the actual Main binding band, without booting Electron or a service.
  const main = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  const band = main.slice(main.indexOf('function bindClient(context)'), main.indexOf('\nfunction displayState('));
  const bindClient = vm.runInNewContext('(' + band + ')', { outboxBroker: broker, bindClaudeOutbox,
    windows: new Map(contexts.map((context, i) => [i, context])), roomState: deps.roomState });
  bindClient(contexts[0]);
  const callback = bridge.restrictedOutboxCall;
  bridge.restrictedOutboxCall = async (...values) => { try { return await callback(...values); } finally { callbackFinished(); } };
  const socketPath = path.join(dir, 'root.sock');
  const targets = new Map([['root-token', root]]);
  const server = createSubmissionServer(socketPath, targets, { restrictedOutboxCall: (...values) => bridge.restrictedOutboxCall(...values) });
  await server.start();
  t.after(async () => {
    await broker.close(); server.server.closeAllConnections(); await new Promise(resolve => server.server.close(resolve));
    root.close(); bridge.close(); fs.rmSync(dir, { recursive: true });
  });
  const request = (extra = {}, token = 'root-token', route = '/addressed-message') => {
    let req;
    const result = new Promise((resolve, reject) => {
      req = http.request({ socketPath, method: 'POST', path: route, headers: { 'X-Workspace-Token': token } }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('data', part => { body += part; });
        res.on('end', () => resolve({ code: res.statusCode, ...JSON.parse(body) }));
      });
      req.on('error', reject); req.end(JSON.stringify({ ...binding, epoch: binding.observationEpoch, ...turn, callId: 'only-call', arguments: args, ...extra }));
    });
    return { result, close: () => req.destroy(Error('Owned caller disconnected')) };
  };
  return { request, root, bridge, records, control, counts, args, finished, broker, deps, targets,
    nativeBinding: { ...binding, token: 'root-token', socketPath } };
}

test('authenticated original Claude uses the actual Main outbox binding and a completed native receipt', async t => {
  const f = await fixture(t), result = await f.request().result;
  assert.equal(result.status, 'staged', JSON.stringify({ result, counts: f.counts })); assert.equal(result.receipt.status, 'working');
  assert.equal(result.receipt.nativeReceived, true); assert.equal(result.receipt.firstCommand.exitCode, 0);
  assert.equal(result.receipt.senderNativeId, f.records[0].nativeId); assert.equal(result.receipt.text, f.args.message);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_COMMAND_OUTPUT'));
  const row = f.bridge.sharedMessages()[0];
  assert.equal(row.sessionId, 'secretary'); assert.equal(row.senderNativeId, f.records[0].nativeId);
  assert.equal(row.recipientId, 'recipient'); assert.equal(row.text, f.args.message);
  assert.equal(f.records[1].owner, 'receiver-view'); assert.equal(f.root.addressedSendAvailable, false);
  assert.equal((await f.request().result).status, 'not-sent');
  assert.deepEqual(f.counts, { forwards: 1, views: 1, closes: 1 });
});
test('a closed unrelated backend keeps the original authenticated Claude caller usable', async t => {
  const f = await fixture(t), client = f.deps.contexts()[0].client;
  client.entries.push({ key: 'closed-unrelated', closed: true, client: { socket: { destroyed: true } }, state: { sessions: [] } });
  client.socket.destroyed = true;
  const result = await f.request().result;
  assert.equal(result.status, 'staged'); assert.equal(result.receipt.nativeReceived, true);
  assert.deepEqual(f.counts, { forwards: 1, views: 1, closes: 1 });
});
test('closed conflicting Claude caller facts refuse before allocating any outbox or input', async t => {
  const f = await fixture(t), client = f.deps.contexts()[0].client;
  client.entries.push({ key: 'closed-conflicting-backend', closed: true, client: { socket: { destroyed: true } },
    state: { sessions: [{ ...f.records[0], id: 'closed-conflicting-caller', pid: process.pid + 1000 }] } });
  client.socket.destroyed = true;
  const result = await f.request().result;
  assert.notEqual(result.status, 'staged');
  assert.deepEqual(f.counts, { forwards: 0, views: 0, closes: 0 });
});
test('the same Claude identity on a closed channel does not mask its live original channel', async t => {
  const f = await fixture(t), client = f.deps.contexts()[0].client;
  client.entries.unshift({ ...client.entries[0], closed: true, client: { socket: { destroyed: true } } });
  client.socket.destroyed = true;
  const result = await f.request().result;
  assert.equal(result.status, 'staged'); assert.equal(result.receipt.nativeReceived, true);
  assert.deepEqual(f.counts, { forwards: 1, views: 1, closes: 1 });
});
test('wrong token, lease, epoch, prompt and native turn cannot allocate an outbox', async t => {
  const f = await fixture(t);
  assert.equal((await f.request({}, 'wrong-token').result).code, 403);
  for (const extra of [{ lease: 'other' }, { epoch: 'other' }, { promptId: 'other' }, { turnId: 'other' }]) {
    const result = await f.request(extra).result; assert.notEqual(result.status, 'staged');
  }
  assert.deepEqual(f.counts, { forwards: 0, views: 0, closes: 0 });
  assert.throws(() => bindClaudeOutbox(f.deps, {}), /could not be verified/);
});
test('a failed native permission call cannot be replayed as an approved message', async t => {
  const f = await fixture(t);
  assert.equal((await f.request({ arguments: undefined }, 'root-token', '/addressed-failed').result).status, 'not-sent');
  assert.equal((await f.request().result).status, 'not-sent'); assert.equal(f.counts.views, 0);
});
test('a callback success label without native receipt and completed command is not staged', async t => {
  const f = await fixture(t); f.bridge.restrictedOutboxCall = async () => ({ status: 'working' });
  assert.equal((await f.request().result).status, 'unconfirmed'); assert.equal(f.counts.forwards, 0);
});
test('the existing native hook keeps its approval path and accepts only the completed outbox envelope', async t => {
  const f = await fixture(t), hooks = new Map();
  const source = fs.readFileSync(path.join(__dirname, '../claude-bridge/hooks/register.js'), 'utf8');
  // Seed synthetic native lifecycle facts only; the production hook body and
  // its next(e) permission/approved-body checks remain unchanged.
  const setup = '\nexport function setup(b) { rootBinding=b;activeTurn="root-turn";rootPrompt={id:"root-prompt"};addressedTool=true;promptTurns.set("root-prompt",{binding:b,turnId:activeTurn,ambiguous:false}); }';
  const { register, setup: seed } = await import('data:text/javascript;base64,' + Buffer.from(source + setup + '\n//' + randomUUID()).toString('base64'));
  register((name, filter, fn) => { if (name === 'tool.call' && filter?.tool === 'mcp__native_workspace__workspace_message') hooks.set(name, fn); return { catch() {} }; });
  seed(f.nativeBinding);
  const $ = { http: { fetch: (url, options) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: options.socketPath, method: options.method, path: new URL(url).pathname, headers: options.headers }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', part => { text += part; }); res.on('end', () => resolve({ ok: res.statusCode === 200, text }));
    }); req.on('error', reject); req.end(options.body);
  }) } };
  let permissions = 0;
  const next = Object.assign(async e => { permissions++; return e.tool_use_id === 'denied-call' ? { deny: 'Native permission denied' }
    : { text: JSON.stringify({ approved: true, ...f.args }) }; }, { origin: { plugin: 'engine' } });
  const call = hooks.get('tool.call');
  assert.equal((await call($, { ...f.args, tool_use_id: 'denied-call' }, next)).deny, 'Native permission denied');
  assert.equal(f.counts.views, 0);
  const result = await call($, { ...f.args, tool_use_id: 'approved-call' }, next);
  assert.equal(result.isError, false); assert.equal(JSON.parse(result.result).receipt.status, 'working');
  assert.equal(permissions, 2); assert.equal(f.counts.forwards, 1);
});
test('manual control, root authority and sender identity are rechecked before the UI send', async t => {
  for (const change of [f => { f.control.manualEpoch++; }, f => { f.root.rootTurn = null; }, f => { f.records[0].pid++; },
    f => { f.records[1].memberRevision++; }, f => { f.root.livePermissions.set('permission', {}); }]) {
    const f = await fixture(t, { beforeView: change }), result = await f.request().result;
    assert.notEqual(result.status, 'staged'); assert.equal(f.counts.forwards, 0); assert.equal(f.counts.closes, 1);
  }
});
test('a native command failure is retained as failure through the old staged-only hook envelope', async t => {
  const f = await fixture(t, { exitCode: 7 }), result = await f.request().result;
  assert.equal(result.status, 'command-failed', JSON.stringify({ result, counts: f.counts })); assert.equal(result.receipt.firstCommand.exitCode, 7);
  assert.equal(result.retry, false); assert.equal(f.counts.forwards, 1);
});
test('the original Claude callback shares the same broker busy slot without a second view', async t => {
  const f = await fixture(t); let release;
  const pending = f.broker.submitAuthenticated(async () => { await new Promise(resolve => { release = resolve; }); throw Error('Owned held fixture'); });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.request().result).status, 'unconfirmed'); assert.equal(f.counts.views, 0);
  release(); await pending;
  assert.equal((await f.request().result).status, 'not-sent', 'A busy result does not make the native call replayable');
});
test('disconnecting the original root request before the view is ready aborts without forwarding', async t => {
  let viewStarted, release;
  const started = new Promise(resolve => { viewStarted = resolve; });
  const f = await fixture(t, { beforeView: async () => { viewStarted(); await new Promise(resolve => { release = resolve; }); } });
  const call = f.request(); const rejected = assert.rejects(call.result, /disconnected/);
  await started; call.close(); await rejected; await new Promise(resolve => setImmediate(resolve)); release();
  await f.finished; assert.equal(f.counts.forwards, 0); assert.equal(f.counts.closes, 1);
});
test('app-owned broker close aborts the root caller through the actual Main factory before any send', async t => {
  let viewStarted, release;
  const started = new Promise(resolve => { viewStarted = resolve; });
  const f = await fixture(t, { beforeView: async () => { viewStarted(); await new Promise(resolve => { release = resolve; }); } });
  const call = f.request(); await started;
  const closing = f.broker.close(); release();
  const result = await call.result; await closing;
  assert.equal(result.status, 'unconfirmed'); assert.equal(f.counts.forwards, 0); assert.equal(f.counts.closes, 1);
});
