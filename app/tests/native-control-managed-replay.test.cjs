const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto'), { EventEmitter } = require('node:events');
const app = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..');
const { Codex } = require(path.join(app, 'adapters.cjs'));
const { Workspace } = require(path.join(app, 'workspace.cjs'));
const { LegacyInput } = require(path.join(app, 'legacy-input.cjs'));
const { bindOriginalOutbox } = require(path.join(app, 'computer-use-outbox-owner.cjs'));
const { createOutboxBroker } = require(path.join(app, 'computer-use-outbox-broker.cjs'));
const { requestOutbox } = require(path.join(app, 'computer-use-outbox-tool.cjs'));
const { CAPABILITY } = require(path.join(app, 'managed-outbox-transport.cjs'));

test('a completed unknown managed broker operation cannot replay its consumed native call', { timeout: 12000 }, async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'naw-managed-replay-')); fs.chmodSync(dir, 0o700);
  const starts = [], nativeCalls = [], goalReads = [], scopedCalls = [], notices = [], runtimes = [];
  let broker, activeBinding, views = 0, closedViews = 0, rendered;
  const host = { binaries: {}, create() { assert.fail('No native process may be created'); }, startCodex() { assert.fail('No history/connection bootstrap'); } };
  const workspace = new Workspace(host, path.join(dir, 'service'));
  const bridge = new LegacyInput(dir), service = new EventEmitter(); service.destroyed = false;
  t.after(async () => {
    if (broker) await broker.close();
    workspace.closeScopedOutbox(); bridge.close();
    clearInterval(workspace.deadlineTimer); clearTimeout(workspace.saveTimer); clearTimeout(workspace.saveDeadline);
    for (const runtime of runtimes) runtime.removeAllListeners();
    workspace.closed = true;
    assert.ok(scopedCalls.length <= 40); assert.ok(nativeCalls.length <= 2);
    t.diagnostic(JSON.stringify({ syntheticNativeRpc: nativeCalls.length + goalReads.length, goalReads: goalReads.length, starts: starts.length, ledger: bridge.records.length,
      views, closedViews, scopedRequests: scopedCalls.length, scopesLeft: workspace.scopedOutboxProducer?.scopes.size || 0 }));
    fs.rmSync(dir, { recursive: true, force: true }); assert.equal(fs.existsSync(dir), false);
  });
  const records = ['sender', 'receiver'].map(id => ({ id, provider: 'codex', view: 'chat', name: id, nativeId: randomUUID(), pid: process.pid,
    owner: 'human-' + id, controlRevision: 7, connectionRevision: 3, peerRevision: 0, memberRevision: 2,
    roomId: 'shared', state: 'idle', messages: [], autoName: false }));
  const args = { recipient_id: 'receiver', space_id: 'shared', message: '  Synthetic scoped replay task.\r\n\tPreserve exact body.  ' };
  const identity = { nativeId: records[0].nativeId, sessionId: 'sender-session', turnId: 'sender-turn', callId: 'original-call' };
  const rpc = { nativeVersion: '0.164.0', async call(method, params) {
    if (method === 'thread/goal/get') { assert.deepEqual(params, { threadId: records[1].nativeId }); goalReads.push(method); return { goal: null }; }
    nativeCalls.push({ method, params });
    assert.equal(method, 'turn/start', 'No resume, history, settings, approval or goal fallback');
    assert.equal(params.threadId, records[1].nativeId); assert.equal(params.input[0].text, args.message);
    starts.push(params);
    throw Error('SYNTHETIC_PRIVATE_OUTCOME_UNKNOWN');
  } };
  for (const record of records) {
    workspace.sessions.set(record.id, record); workspace.drafts.set(record.id, 'PRIVATE_UNSENT_' + record.id);
    const nativeHost = { rpc, codexTargets: new Map() }, runtime = new Codex(record, nativeHost);
    nativeHost.codexTargets.set(record.nativeId, runtime); runtime.chatAvailable = true; runtime.needsSubscription = false;
    runtime.nativeSessionId = record.id + '-session';
    workspace.runtimes.set(record.id, runtime); workspace.bind(record, runtime); runtimes.push(runtime);
    assert.equal(runtime.scopedOutboxRpc(), rpc);
  }
  service.call = async (method, action, value) => {
    assert.equal(method, 'scopedOutbox', 'No initial snapshot, observe, claim or old forward');
    scopedCalls.push(action);
    return workspace.scopedOutboxRequest(service, action, value, event => { notices.push(event); service.emit('scopedOutbox', event); });
  };
  const entry = { key: 'synthetic-original-host', client: service, state: { runtimeVersion: 'synthetic-new-producer-not-old120',
    wakePolicy: { enabled: true }, capabilities: [CAPABILITY], sessions: records, room: workspace.room, peerLeases: [] } };
  const control = { legacyInput: bridge, generations: new Map(), maintenance: new Set(), manualEpoch: 0 };
  const client = { entries: [entry], control, socket: { destroyed: false }, route: () => entry };
  const context = { client, win: { isDestroyed: () => false } };
  const deps = { contexts: () => [context], roomState: { assertAvailable() {} } };
  const source = runtimes[0];
  source.event({ method: 'turn/started', params: { threadId: identity.nativeId, turn: { id: identity.turnId } } }, rpc);
  source.event({ method: 'item/started', params: { threadId: identity.nativeId, turnId: identity.turnId,
    item: { id: identity.callId, type: 'mcpToolCall', server: 'native_outbox', tool: 'workspace_outbox', status: 'inProgress', arguments: args } } }, rpc);
  assert.equal(source.outboxMcpCalls.has(identity.callId), true);
  assert.equal(bridge.targets.size, 0, 'No seeded retained-reader or observer targets');
  const preserved = records.map(s => ({ id: s.id, nativeId: s.nativeId, owner: s.owner, control: s.controlRevision,
    member: s.memberRevision, draft: workspace.drafts.get(s.id) }));
  const descriptorFile = path.join(dir, 'owner.json');
  broker = await createOutboxBroker({ descriptorFile,
    bind: async (caller, body, signal) => { activeBinding = await bindOriginalOutbox(deps, caller, body, signal); return activeBinding; },
    createView: async (model, actions) => { views++; return { owner: 'owned-managed-replay-view',
      inspect: async () => ({ ...activeBinding.grant, ...activeBinding.inspectGrant(), owner: 'owned-managed-replay-view', selected: 'room',
        surface: 'records', body: model.text, revision: '1' }),
      target: async () => ({ id: 'forward-button', kind: 'send', visible: true, disabled: false }),
      invoke: async name => {
        if (name === 'browser_snapshot') return { content: [{ type: 'text', text: '### Snapshot\n```yaml\n- button "发送" [ref=e1]\n```' }] };
        assert.equal(name, 'browser_click'); await actions.send(); return { content: [{ type: 'text', text: 'clicked' }] };
      }, showReceipt: async result => { rendered = result; }, close: async () => { closedViews++; } }; },
  });
  const first = await requestOutbox(descriptorFile, identity, args);
  assert.equal(starts.length, 1, 'The first operation must reach the actual scoped native sender');
  assert.equal(first.status, 'unconfirmed'); assert.equal(first.retry, false); assert.notEqual(first.nativeReceived, true);
  assert.equal(rendered.status, 'unconfirmed'); assert.equal(views, 1); assert.equal(closedViews, 1);
  assert.equal(bridge.records.length, 1); assert.equal(workspace.versions.dispatches, 1);
  assert.equal(records[1].messages.at(-1).text, args.message); assert.equal(records[1].messages.at(-1).status, 'unconfirmed');
  assert.equal(records[1].pendingTag, null); assert.equal(runtimes[1].pending, null);
  assert.equal(source.outboxMcpCalls.get(identity.callId).outboxConsumed, true);
  assert.equal(workspace.scopedOutboxProducer.scopes.size, 0, 'First operation cleanup must complete before a new request');
  const second = await requestOutbox(descriptorFile, identity, args);
  assert.equal(second.status, 'unconfirmed'); assert.equal(second.retry, false); assert.equal(second.failureReason, 'duplicate-call');
  assert.equal(starts.length, 1); assert.equal(bridge.records.length, 1); assert.equal(workspace.versions.dispatches, 1);
  assert.equal(views, 1); assert.equal(closedViews, 1); assert.equal(workspace.scopedOutboxProducer.scopes.size, 0);
  assert.equal(service.listenerCount('scopedOutbox'), 0);
  assert.equal(notices.some(event => JSON.stringify(event).includes('PRIVATE_UNSENT_')), false);
  assert.equal(JSON.stringify([first, second]).includes('SYNTHETIC_PRIVATE_OUTCOME_UNKNOWN'), false);
  assert.deepEqual(records.map(s => ({ id: s.id, nativeId: s.nativeId, owner: s.owner, control: s.controlRevision,
    member: s.memberRevision, draft: workspace.drafts.get(s.id) })), preserved);
});
