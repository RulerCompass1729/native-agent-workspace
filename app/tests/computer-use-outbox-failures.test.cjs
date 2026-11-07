const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { createOutboxBroker } = require('../computer-use-outbox-broker.cjs');
const { requestOutbox } = require('../computer-use-outbox-tool.cjs');
const { outboxError } = require('../computer-use-outbox-native.cjs');
const { Codex } = require('../adapters.cjs');
const { LegacyInput } = require('../legacy-input.cjs');
const { bindOriginalOutbox } = require('../computer-use-outbox-owner.cjs');
const identity = { nativeId: 'sender-native', sessionId: 'session', turnId: 'turn', callId: 'call' };
const args = { recipient_id: 'recipient', message: 'One exact task' };
const privateError = () => Object.assign(Error('PRIVATE_ERROR_TOKEN_AND_PATH'), {
  failurePhase: 'PRIVATE_PHASE', failureReason: 'PRIVATE_REASON', cause: { token: 'PRIVATE_CAUSE' } });

// Real broker, socket, Core and lease. Only the view/native reply is synthetic.
async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync('/private/tmp/naw-failure-'); fs.chmodSync(dir, 0o700);
  const grant = { callerId: 'sender', callerNativeId: identity.nativeId, recipientId: args.recipient_id,
    nativeId: 'recipient-native', memberRevision: 1, spaceId: 'shared', text: args.message };
  let forwards = 0, views = 0, closes = 0;
  const binding = { grant, inspectGrant: () => ({ ...grant, callerValid: true, ready: true }),
    async forwardOnce() { forwards++; if (options.sendError) throw privateError(); return 'message'; },
    watchReceipt(scope, listener) {
      if (options.watchError) throw privateError();
      listener({ ...scope, source: 'codex-native', nativeReceived: true, inputTag: 'message', turnId: 'native-turn',
        firstCommand: { id: 'command', kind: 'commandExecution', status: 'completed', exitCode: 0,
          command: 'git status --short', inputTag: 'message', turnId: 'native-turn' } });
      return () => {};
    }, close() {} };
  const broker = await createOutboxBroker({ descriptorFile: path.join(dir, 'owner.json'),
    bind: options.bind || (async () => { if (options.bindError) throw options.bindError(); return binding; }),
    createView: async (model, actions) => {
      views++; if (options.viewError) throw privateError();
      return { owner: 'owned-view',
        inspect: options.invalidView ? undefined : () => ({ ...grant, callerValid: true, ready: true, owner: 'owned-view', selected: 'room', surface: 'records', body: model.text, revision: 'one' }),
        target: () => ({ id: 'forward-button', kind: 'send', visible: true, disabled: false }),
        async invoke(name) {
          if (name === 'browser_snapshot') return { content: [{ type: 'text', text: options.ambiguous
            ? '### Snapshot\n```yaml\n- button "发送" [ref=e1]\n- button "发送" [ref=e2]\n```'
            : '### Snapshot\n```yaml\n- button "发送" [ref=e1]\n```' }] };
          assert.equal(name, 'browser_click'); if (!options.noSend) await actions.send(); return { content: [{ type: 'text', text: 'clicked' }] };
        },
        async showReceipt() { if (options.renderError) throw privateError(); },
        async close() { closes++; if (options.closeError) throw privateError(); },
      };
    },
  });
  t.after(async () => { await broker.close(); fs.rmSync(dir, { recursive: true }); });
  return { broker, call: () => requestOutbox(broker.descriptorFile, identity, args), state: () => ({ forwards, views, closes }), binding };
}
function failed(result, phase, reason) {
  assert.equal(result.status, 'unconfirmed'); assert.equal(result.retry, false);
  assert.equal(result.failurePhase, phase); assert.equal(result.failureReason, reason);
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
}
test('a binding failure returns only its finite stage instead of an opaque or private exception', async t => {
  const f = await fixture(t, { bindError: privateError }), result = await f.call();
  failed(result, 'binding', 'binding-unavailable'); assert.equal(f.state().views, 0); assert.equal(f.state().forwards, 0);
});
test('view creation and ambiguous snapshot failures stay separate and never forward', async t => {
  for (const options of [{ viewError: true }, { ambiguous: true }]) {
    const f = await fixture(t, options), result = await f.call();
    failed(result, options.viewError ? 'view-open' : 'view-snapshot', options.viewError ? 'view-unavailable' : 'ambiguous-target');
    assert.equal(f.state().forwards, 0);
  }
});
test('a possible native dispatch followed by an error is unconfirmed at send, never not-sent or receipt-timeout', async t => {
  const f = await fixture(t, { sendError: true }), result = await f.call();
  failed(result, 'view-send', 'send-unconfirmed'); assert.equal(f.state().forwards, 1); assert.equal(f.state().closes, 1);
});
test('a receipt watcher failure is distinguished from native dispatch and never resends', async t => {
  const f = await fixture(t, { watchError: true }), result = await f.call();
  failed(result, 'native-receipt', 'receipt-unconfirmed'); assert.equal(f.state().forwards, 1);
});
test('cleanup failure overrides an otherwise genuine synthetic working receipt', async t => {
  const f = await fixture(t, { closeError: true }), result = await f.call();
  failed(result, 'cleanup', 'cleanup-unconfirmed'); assert.equal(f.state().forwards, 1); assert.equal(f.state().closes, 1);
});
test('a valid native receipt remains working without diagnostic failure fields', async t => {
  const f = await fixture(t), result = await f.call();
  assert.equal(result.status, 'working'); assert.equal(result.nativeReceived, true);
  assert.equal(result.firstCommand.exitCode, 0); assert.equal(Object.hasOwn(result, 'failurePhase'), false);
});
test('trusted finite provenance and recipient guard reasons pass through without raw errors', async t => {
  for (const reason of ['provenance-unconfirmed', 'recipient-not-idle', 'membership-changed', 'control-changed']) {
    const f = await fixture(t, { bindError: () => outboxError(reason, 'binding') }), result = await f.call();
    failed(result, 'binding', reason); assert.equal(f.state().views, 0);
  }
});
test('a primary send failure survives an additional cleanup failure', async t => {
  const f = await fixture(t, { sendError: true, closeError: true }), result = await f.call();
  failed(result, 'view-send', 'send-unconfirmed'); assert.equal(result.cleanupUnconfirmed, true);
  assert.equal(f.state().forwards, 1);
});
test('cleanup failure during view setup is retained through both Core and broker catches', async t => {
  const f = await fixture(t, { invalidView: true, closeError: true }), result = await f.call();
  failed(result, 'view-open', 'view-unavailable'); assert.equal(result.cleanupUnconfirmed, true);
  assert.equal(f.state().forwards, 0); assert.equal(f.state().closes, 1);
});
test('busy and closed admission keep their own finite reason without rebinding', async t => {
  const f = await fixture(t); let release;
  const pending = f.broker.submitAuthenticated(() => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  failed(await f.call(), 'admission', 'busy');
  release(f.binding); await pending;
  await f.broker.close();
  failed(await f.broker.submitAuthenticated(() => { throw Error('Must not rebind'); }), 'admission', 'owner-closed');
});

function originalOwner(t) {
  const dir = fs.mkdtempSync('/private/tmp/naw-owner-failure-'), bridge = new LegacyInput(dir);
  const records = [
    { id: 'sender', nativeId: identity.nativeId, name: 'Sender', provider: 'codex', pid: 101, owner: 'private-sender', roomId: 'shared', memberRevision: 1, controlRevision: 1 },
    { id: args.recipient_id, nativeId: 'recipient-native', name: 'Recipient', provider: 'codex', pid: 102, owner: 'private-recipient', roomId: 'shared', memberRevision: 1, controlRevision: 2 },
  ];
  const natives = records.map(record => {
    const adapter = new Codex({ ...record, messages: [] }, { rpc: {}, codexTargets: new Map() });
    const native = { adapter, connected: true, closed: false, state: 'idle', close() {},
      send() { assert.fail('The rejected owner guard must never reach native send'); } };
    bridge.targets.set(record.id, { record, native, submission: { connected: true, close() {} } }); return native;
  });
  const r = natives[0].adapter; r.turnId = identity.turnId; r.nativeSessionId = identity.sessionId;
  r.event({ method: 'item/started', params: { threadId: identity.nativeId, turnId: identity.turnId,
    item: { id: identity.callId, type: 'mcpToolCall', server: 'native_outbox', tool: 'workspace_outbox', arguments: args, status: 'inProgress' } } }, r.host.rpc);
  const entry = { key: 'retained', client: {}, state: { sessions: records, room: { messages: [] } } };
  const control = { legacyInput: bridge, manualEpoch: 1, maintenance: new Set(), generations: new Map() };
  const client = { entries: [entry], control, socket: { destroyed: false }, route: () => entry };
  const contexts = [{ client, view: { owner: records[0].owner }, win: { isDestroyed: () => false } }];
  const deps = { contexts: () => contexts, roomState: { assertAvailable() {} } };
  t.after(() => { bridge.close(); fs.rmSync(dir, { recursive: true }); });
  return { records, natives, bridge, control, bind: (id = identity) => bindOriginalOutbox(deps, id, args, AbortSignal.timeout(1000)) };
}
test('actual native proof and owner binding identify provenance, unavailable caller and busy recipient before any view', async t => {
  for (const scenario of ['origin', 'caller', 'idle', 'member']) {
    const o = originalOwner(t);
    if (scenario === 'caller') o.bridge.targets.delete('sender');
    if (scenario === 'idle') o.natives[1].state = 'working';
    if (scenario === 'member') o.records[1].roomId = null;
    const f = await fixture(t, { bind: () => o.bind(scenario === 'origin' ? { ...identity, callId: '' } : identity) });
    const result = await f.call();
    failed(result, 'binding', { origin: 'provenance-unconfirmed', caller: 'caller-unavailable', idle: 'recipient-not-idle', member: 'membership-unconfirmed' }[scenario]);
    assert.equal(f.state().views, 0); assert.equal(o.bridge.records.length, 0);
  }
});
test('actual member and control changes at send remain precise failures despite a ready-looking view', async t => {
  for (const change of ['member', 'owner', 'manual']) {
    const o = originalOwner(t), binding = await o.bind();
    if (change === 'member') o.records[1].memberRevision++;
    if (change === 'owner') o.records[1].owner = 'new-private-owner';
    if (change === 'manual') o.control.manualEpoch++;
    const f = await fixture(t, { bind: async () => binding }), result = await f.call();
    failed(result, 'view-send', change === 'member' ? 'membership-changed' : 'control-changed');
    assert.equal(o.bridge.records.length, 0);
  }
});

test('late validated native execution clears an earlier watcher failure diagnostic', async t => {
  const f = await fixture(t);
  f.binding.watchReceipt = (scope, listener) => {
    queueMicrotask(() => listener({ ...scope, source: 'codex-native', nativeReceived: true, inputTag: 'message', turnId: 'native-turn',
      firstCommand: { id: 'command', kind: 'commandExecution', status: 'completed', exitCode: 0,
        command: 'git status --short', inputTag: 'message', turnId: 'native-turn' } }));
    throw privateError();
  };
  const result = await f.call();
  assert.equal(result.status, 'working'); assert.equal(result.nativeReceived, true);
  assert.equal(Object.hasOwn(result, 'failurePhase'), false);
});
test('an unauthenticated request cannot learn whether the owner is busy', async t => {
  const f = await fixture(t); let release;
  const pending = f.broker.submitAuthenticated(() => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const info = JSON.parse(fs.readFileSync(f.broker.descriptorFile));
  info.capability = (info.capability[0] === 'a' ? 'b' : 'a') + info.capability.slice(1);
  const wrong = path.join(path.dirname(f.broker.descriptorFile), 'wrong.json');
  fs.writeFileSync(wrong, JSON.stringify(info), { mode: 0o600 });
  let result;
  try { result = await requestOutbox(wrong, identity, args); } finally { release(f.binding); await pending; }
  failed(result, 'admission', 'invalid-request');
});
test('a click with no forward reaches a send-unconfirmed timeout rather than claiming native delivery', async t => {
  const f = await fixture(t, { noSend: true }), realTimer = setTimeout;
  // Accelerate only Core's existing 60-second receipt wait; no provider/GUI.
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...rest) => realTimer(fn, ms === 60000 ? 5 : ms, ...rest));
  const result = await f.call();
  failed(result, 'view-send', 'send-unconfirmed');
  assert.equal(result.timedOut, true); assert.equal(result.messageId, null); assert.equal(f.state().forwards, 0);
});
