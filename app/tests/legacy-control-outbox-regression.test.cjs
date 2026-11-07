const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
// A frozen source tree may be selected while the owning lane is still editing.
const source = process.env.NAW_LEGACY_CONTROL_SOURCE_ROOT || path.resolve(__dirname, '..');
const { LegacyInput } = require(path.join(source, 'legacy-input.cjs'));
const { LegacyCodex } = require(path.join(source, 'legacy-codex.cjs'));
const { Codex } = require(path.join(source, 'adapters.cjs'));
const { bindOriginalOutbox } = require(path.join(source, 'computer-use-outbox-owner.cjs'));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function observedInput(f, tag, body, turnId = 'recipient-turn') {
  f.native.adapter.event({ method: 'item/completed', params: {
    threadId: f.records[1].nativeId, turnId,
    item: { id: `native-input-${tag}`, type: 'userMessage', clientId: tag, content: [{ type: 'text', text: body }] },
  } }, f.native.adapter.host.rpc);
}

function fixture(t, body = '  first line\n\tsecond line  ') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-control-outbox-'));
  const bridge = new LegacyInput(directory), ack = deferred(), calls = [];
  const records = [
    { id: 'sender', name: 'Sender', nativeId: 'sender-native', provider: 'codex', pid: 201,
      owner: 'sender-view', roomId: 'shared', memberRevision: 1, controlRevision: 2, liveDraft: 'sender private draft' },
    { id: 'recipient', name: 'Recipient', nativeId: 'recipient-native', provider: 'codex', pid: 202,
      owner: 'recipient-view', roomId: 'shared', memberRevision: 3, controlRevision: 4, liveDraft: 'recipient private draft' },
  ];
  const rpc = { async call(method, params) {
    if (method === 'thread/goal/get') { assert.deepEqual(params, { threadId: records[1].nativeId }); return { goal: null }; }
    calls.push({ method, params });
    assert.equal(method, 'turn/start', 'No connection, claim, settings or history RPC is allowed');
    return ack.promise;
  } };
  // Real send reducers; only the RPC boundary is in memory. Never connect/start.
  const native = new LegacyCodex(records[1]);
  native.connected = true; native.state = 'idle'; native.subscribed = true;
  native.adapter = new Codex({ ...records[1], messages: [], view: 'chat' }, { rpc, codexTargets: new Map() });
  bridge.targets.set('recipient', { record: records[1], native, submission: native });
  const sender = new Codex({ ...records[0], messages: [] }, { rpc: {}, codexTargets: new Map() });
  sender.nativeSessionId = 'sender-session'; sender.turnId = 'sender-turn'; sender.latestState = 'working';
  bridge.targets.set('sender', { record: records[0],
    native: { connected: true, closed: false, adapter: sender }, submission: { close() {} } });
  const args = { recipient_id: 'recipient', message: body };
  const identity = { nativeId: 'sender-native', sessionId: 'sender-session', turnId: 'sender-turn', callId: 'outbox-call' };
  sender.event({ method: 'item/started', params: { threadId: identity.nativeId, turnId: identity.turnId,
    item: { id: identity.callId, type: 'mcpToolCall', server: 'native_outbox', tool: 'workspace_outbox', arguments: args, status: 'inProgress' } } }, sender.host.rpc);
  const entry = { key: 'retained', client: { call() { throw Error('No backend or native connection permitted'); } },
    state: { wakePolicy: { enabled: true }, sessions: records, room: { messages: [] } } };
  const control = { legacyInput: bridge, generations: new Map(), manualEpoch: 1, maintenance: new Set() };
  const client = { entries: [entry], control, socket: { destroyed: false }, route: () => entry };
  const contexts = records.map(record => ({ client, view: { owner: record.owner }, win: { isDestroyed: () => false } }));
  t.after(() => { ack.resolve({ turn: { id: 'cleanup-turn' } }); bridge.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { bridge, native, sender, records, calls, ack, control, directory,
    bind: () => bindOriginalOutbox({ contexts: () => contexts, roomState: { assertAvailable() {} } }, identity, args, AbortSignal.timeout(3000)) };
}

for (const [name, body] of [['LF', ' \tfirst line\n\tsecond line  \n'], ['CRLF', ' \tfirst line\r\n\tsecond line  \r\n']]) {
  test(`real LegacyInput and LegacyCodex retain ${name} body, source, recipient and one native tag`, async t => {
    const f = fixture(t, body), before = structuredClone(f.records), binding = await f.bind();
    t.after(() => binding.close());
    const pending = binding.forwardOnce();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, 1);
    const [{ method, params }] = f.calls, row = f.bridge.sharedMessages()[0];
    assert.equal(method, 'turn/start');
    assert.equal(params.threadId, before[1].nativeId);
    assert.equal(params.clientUserMessageId, row.id);
    assert.deepEqual(params.input, [{ type: 'text', text: body, text_elements: [] }]);
    assert.equal(f.native.record.messages[0].id, row.id);
    assert.equal(f.native.record.messages[0].text, body);
    assert.equal(row.role, 'assistant'); assert.equal(row.sessionId, before[0].id);
    assert.equal(row.senderNativeId, before[0].nativeId); assert.equal(row.recipientId, before[1].id);
    assert.equal(row.name, 'Sender → Recipient'); assert.equal(row.text, body);
    assert.equal(row.status, 'unconfirmed');
    assert.equal(row.deliveries[0].id, row.id); assert.equal(row.deliveries[0].recipientId, before[1].id);
    assert.equal(row.deliveries[0].text, body); assert.equal(row.deliveries[0].status, 'unconfirmed');
    // This shared status is rendered as "Received by native session". An ACK
    // alone must therefore leave both the message and its delivery unconfirmed.
    let received = 0;
    const unsubscribe = binding.watchReceipt({ messageId: row.id }, () => received++);
    t.after(unsubscribe);
    f.ack.resolve({ turn: { id: 'recipient-turn' } });
    assert.equal(await pending, row.id);
    assert.equal(f.bridge.sharedMessages()[0].status, 'unconfirmed');
    assert.equal(f.bridge.sharedMessages()[0].deliveries[0].status, 'unconfirmed');
    assert.equal(received, 0); assert.equal(f.native.adapter.nativeAcceptedInput, undefined);
    f.native.adapter.ownInputs.add('older-tag');
    observedInput(f, 'older-tag', 'Unrelated older input', 'older-turn');
    assert.equal(f.bridge.sharedMessages()[0].status, 'unconfirmed', 'A different native input tag cannot settle this delivery');
    observedInput(f, row.id, body);
    assert.equal(f.bridge.sharedMessages()[0].status, 'submitted');
    assert.equal(f.bridge.sharedMessages()[0].deliveries[0].status, 'submitted');
    assert.equal(received, 1);
    assert.deepEqual(f.records, before, 'Forwarding never claims ownership or edits either solo draft');
    const cold = new LegacyInput(f.directory); t.after(() => cold.close());
    assert.deepEqual(cold.sharedMessages(), f.bridge.sharedMessages(), 'Reload keeps source, exact body and delivery tag');
    assert.equal(cold.records[0].nativeId, before[1].nativeId);
    assert.equal(cold.sharedMessages().length, 1);
  });
}

test('exact native input before the RPC ACK settles only its own shared delivery and survives the late ACK', async t => {
  const body = '  receipt before ACK\r\n\tstill exact  ';
  const f = fixture(t, body), before = structuredClone(f.records), binding = await f.bind(); t.after(() => binding.close());
  const pending = binding.forwardOnce(); await new Promise(resolve => setImmediate(resolve));
  const row = f.bridge.sharedMessages()[0];
  assert.equal(row.status, 'unconfirmed'); assert.equal(f.calls.length, 1);
  observedInput(f, row.id, body);
  assert.equal(f.bridge.sharedMessages()[0].status, 'submitted');
  assert.equal(f.bridge.sharedMessages()[0].deliveries[0].status, 'submitted');
  f.ack.resolve({ turn: { id: 'recipient-turn' } }); assert.equal(await pending, row.id);
  assert.equal(f.bridge.sharedMessages()[0].status, 'submitted');
  assert.deepEqual(f.records, before);
  const cold = new LegacyInput(f.directory); t.after(() => cold.close());
  assert.equal(cold.sharedMessages()[0].status, 'submitted'); assert.equal(cold.sharedMessages()[0].text, body);
});

for (const [name, revoke] of [
  ['owner', f => { f.records[1].owner = 'other-view'; }],
  ['membership', f => { f.records[1].memberRevision++; }],
  ['recipient identity', f => { f.records[1].nativeId = 'replacement-recipient'; }],
  ['sender identity', f => { f.records[0].nativeId = 'replacement-native'; }],
  ['manual control', f => { f.control.manualEpoch++; }],
  ['native caller turn', f => { f.sender.turnId = 'replacement-turn'; }],
]) {
  test(`revoking ${name} across the real refresh await prevents every native write`, async t => {
    const f = fixture(t), binding = await f.bind(); t.after(() => binding.close());
    const pending = binding.forwardOnce();
    // LegacyCodex has called refresh and is suspended at its await, before RPC.
    assert.equal(f.bridge.records.length, 1); assert.equal(f.calls.length, 0);
    revoke(f);
    // A broken guard must fail an assertion, rather than hang on the RPC stub.
    f.ack.resolve({ turn: { id: 'must-not-start' } });
    const drafts = f.records.map(record => record.liveDraft);
    await assert.rejects(pending);
    assert.equal(f.calls.length, 0); assert.deepEqual(f.native.record.messages, []);
    assert.equal(f.bridge.records[0].status, 'unconfirmed');
    assert.equal(f.bridge.sharedMessages()[0].status, 'unconfirmed');
    assert.equal(f.bridge.sharedMessages()[0].deliveries[0].status, 'unconfirmed');
    assert.deepEqual(f.records.map(record => record.liveDraft), drafts);
    assert.equal(f.bridge.target(f.records[1]).refresh, null);
  });
}

test('submission-only events and an uncertain RPC never promote a pending shared row', async t => {
  const f = fixture(t), binding = await f.bind(); t.after(() => binding.close());
  const pending = binding.forwardOnce(); await new Promise(resolve => setImmediate(resolve));
  const row = f.bridge.sharedMessages()[0];
  f.native.adapter.emit('submitted', row.id);
  f.native.emit('submitted', row.id);
  f.bridge.emit('submitted', row.id);
  assert.equal(f.bridge.sharedMessages()[0].status, 'unconfirmed');
  assert.equal(f.bridge.sharedMessages()[0].deliveries[0].status, 'unconfirmed');
  f.ack.reject(Error('Synthetic transport outcome unknown'));
  await assert.rejects(pending, error => {
    assert.equal(error.message.includes('outcome unknown'), false);
    assert.deepEqual(require('../computer-use-outbox-native.cjs').classifyOutboxFailure(error),
      { failurePhase: 'view-send', failureReason: 'send-unconfirmed' });
    return true;
  });
  assert.equal(f.calls.length, 1, 'Uncertain outcome must not trigger an automatic resend');
  const cold = new LegacyInput(f.directory); t.after(() => cold.close());
  assert.equal(cold.sharedMessages()[0].id, row.id);
  assert.equal(cold.sharedMessages()[0].status, 'unconfirmed');
  assert.equal(cold.sharedMessages()[0].deliveries[0].status, 'unconfirmed');
});

test('invalid or nonshared outbox source cannot fall back to a human shared row', async t => {
  for (const [shared, sourceOf] of [[true, () => null], [true, () => ({ id: 'sender', nativeId: '', name: 'Sender' })],
    [true, () => ({ id: 'sender', nativeId: 'sender-native', name: 'Forged\nlabel' })],
    [false, () => ({ id: 'sender', nativeId: 'sender-native', name: 'Sender' })]]) {
    const f = fixture(t);
    await assert.rejects(f.bridge.send(f.records[1], 'Task', async () => {}, () => true,
      shared, undefined, undefined, false, undefined, sourceOf));
    assert.equal(f.calls.length, 0); assert.equal(f.bridge.records.length, 0);
    assert.deepEqual(f.bridge.sharedMessages(), []);
  }
});
