const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { BackgroundControl, validate, dialog } = require('../background-control.cjs');
const operation = require('../background-operation.cjs');
const { Codex } = require('../adapters.cjs');
const native = require('../background-control-native.cjs');
const sender = { id: 'agent', nativeId: 'native', provider: 'codex', name: 'Agent' };
const identity = { nativeId: 'native', sessionId: 'native-session', turnId: 'turn', callId: 'call' };
const binding = (changes = {}) => ({ sender, identity, valid: () => true, ...changes });
const invoke = (id, method, args = []) => ({ action: 'invoke', operation_id: id, method, arguments: args });
function setup(t, handlers = new Map()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-background-test-')); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const contexts = [];
  const config = { dataDir: dir, handlers, context: async (actor, saved) => {
    const c = { background: true, view: saved || { selected: actor.id, draft: '' }, checkActor: async () => {}, client: { close() {} }, win: { destroy() {} } };
    contexts.push(c); return c;
  } };
  return { controller: new BackgroundControl(config), contexts, config, dir, handlers };
}
test('the exact real handler sees immutable agent provenance after a durable intent; duplicate ids never resend across restart', async t => {
  const f = setup(t); let writes = 0;
  f.handlers.set('forward', (_c, text) => {
    const disk = JSON.parse(fs.readFileSync(path.join(f.dir, 'background-operations.json')));
    assert.equal(disk.records[0].state, 'running'); assert.equal(operation.current().id, 'agent'); writes++; return text;
  });
  const args = invoke('send-1', 'forward', ['  line one\r\n二\n  ']);
  const a = await f.controller.call(binding(), args);
  assert.equal(a.state, 'complete'); assert.equal(a.value, args.arguments[0]); assert.equal(operation.current(), null);
  assert.equal((await f.controller.call(binding(), args)).duplicate, true);
  const reopened = new BackgroundControl(f.config);
  assert.equal((await reopened.call(binding(), args)).duplicate, true); assert.equal(writes, 1);
  await assert.rejects(reopened.call(binding(), { ...args, arguments: ['different'] }), /different command/);
  assert.equal(writes, 1);
});
test('agent view edits do not share another agent or human draft and survive reopening', async t => {
  const human = { selected: 'human-session', draft: 'UNSENT HUMAN TEXT' };
  const f = setup(t, new Map([['draft', (c, text) => { c.view.draft = text; }], ['initial', c => ({ view: c.view })]]));
  await f.controller.call(binding(), invoke('draft-1', 'draft', ['AGENT DRAFT']));
  const second = binding({ sender: { ...sender, id: 'other', nativeId: 'other-native' } });
  const other = await f.controller.call(second, { action: 'snapshot' });
  assert.equal(other.value.view.draft, ''); assert.deepEqual(human, { selected: 'human-session', draft: 'UNSENT HUMAN TEXT' });
  const reopened = new BackgroundControl(f.config);
  assert.equal((await reopened.call(binding(), { action: 'snapshot' })).value.view.draft, 'AGENT DRAFT');
});
test('background interventions leave the actual agent name in shared pause records; human records retain their attribution', () => {
  const { Workspace } = require('../workspace.cjs'), { uiActivity } = require('../ui-errors.cjs');
  function pause() {
    const room = { id: 'shared', revision: 0, run: { id: 'run', status: 'running' } };
    const w = { rooms: new Map([['shared', room]]), goalContinuationCancel() {}, runEvent() {}, changed() {} };
    Workspace.prototype.pause.call(w, '真人追加等待输入', undefined, false, uiActivity('notice.run.humanQueue')[1]);
    return room.run;
  }
  const recorded = operation.run({ ...sender, callId: 'call', turnId: 'turn', operationId: 'queue' }, pause);
  assert.equal(recorded.reason, 'Agent 追加等待输入'); assert.equal(recorded.reasonUiMessage.key, 'notice.run.agentQueue');
  assert.equal(pause().reason, '真人追加等待输入');
});
test('two concurrent agents retain separate provenance, and one actor cannot overlap an unfinished action', async t => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  const f = setup(t, new Map([['hold', async () => { const before = operation.current().id; await waiting; return [before, operation.current().id]; }], ['fast', () => operation.current().id]]));
  const pending = f.controller.call(binding(), invoke('held', 'hold'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.controller.call(binding(), invoke('another', 'fast'))).reason, 'another-operation-running');
  const second = binding({ sender: { ...sender, id: 'second' } });
  assert.equal((await f.controller.call(second, invoke('fast', 'fast'))).value, 'second');
  release(); assert.deepEqual((await pending).value, ['agent', 'agent']);
});
test('lost result remains unknown and cannot be retried; a later actual native receipt is distinct from enqueue', async t => {
  let received = false, sent = 0;
  const f = setup(t, new Map([['forward', () => { sent++; return { tag: 'tag' }; }]]));
  const c = await f.controller.view(sender);
  c.delivery = async () => ({ messageId: 'tag', nativeReceived: received, status: received ? 'submitted' : 'awaiting-native' });
  const args = invoke('message', 'forward');
  assert.equal((await f.controller.call(binding(), args)).state, 'awaiting-native');
  assert.equal((await f.controller.call(binding(), args)).duplicate, true); assert.equal(sent, 1);
  received = true;
  const receipt = await f.controller.call(binding(), { action: 'receipt', operation_id: 'message' });
  assert.equal(receipt.receipt.state, 'received'); assert.equal(receipt.receipt.delivery.nativeReceived, true); assert.equal(sent, 1);
});
test('a failed handler remains unconfirmed after process reopening and does not rerun', async t => {
  let calls = 0;
  const f = setup(t, new Map([['send', () => { calls++; throw Error('Lost transport ACK'); }]]));
  const args = invoke('lost', 'send'); assert.equal((await f.controller.call(binding(), args)).state, 'unconfirmed');
  const reopened = new BackgroundControl(f.config); assert.equal((await reopened.call(binding(), args)).state, 'unconfirmed'); assert.equal(calls, 1);
});
test('failed audit persistence prevents mutation', async t => {
  let writes = 0; const f = setup(t, new Map([['rename', () => writes++]]));
  f.controller.file = path.join(f.dir, 'missing', 'record.json');
  await assert.rejects(f.controller.call(binding(), invoke('bad-store', 'rename')), /save/); assert.equal(writes, 0);
});
test('confirmation does not open a desktop dialog or mutate; only the human decision resumes the saved command once', async t => {
  let nativeDialogs = 0, stopped = 0;
  const options = { message: 'Stop original session?', buttons: ['Cancel', 'Stop'], cancelId: 0 };
  const f = setup(t, new Map([['stop', async c => { const answer = await dialog(c, 'message', options, () => nativeDialogs++); if (answer.response === 1) stopped++; }]]));
  const args = invoke('stop-1', 'stop');
  assert.equal((await f.controller.call(binding(), args)).state, 'confirmation-required');
  assert.equal(nativeDialogs, 0); assert.equal(stopped, 0);
  assert.equal((await f.controller.decide('agent', 'native', 'stop-1', 1)).state, 'complete'); assert.equal(stopped, 1);
  await assert.rejects(f.controller.decide('agent', 'native', 'stop-1', 1)); assert.equal(stopped, 1);
});
test('a changed target after the human sees a confirmation is refused without executing', async t => {
  let target = 'old-native', stopped = 0;
  const options = { message: 'Stop?', buttons: ['Cancel', 'Stop'], cancelId: 0 };
  const f = setup(t, new Map([['stop', async c => { await dialog(c, 'message', options); stopped++; }]]));
  const c = await f.controller.view(sender); c.fingerprint = () => ({ nativeId: target });
  await f.controller.call(binding(), invoke('stale', 'stop')); target = 'replacement-native';
  const result = await f.controller.decide('agent', 'native', 'stale', 1); assert.equal(result.state, 'unconfirmed'); assert.equal(stopped, 0);
});
test('a pending human decision reserves its actor before awaits; an identical concurrent command cannot consume its approval', async t => {
  let unblock, entered;
  const waiting = new Promise(resolve => { unblock = resolve; });
  const checking = new Promise(resolve => { entered = resolve; });
  let applied = 0;
  const options = { message: 'Confirm destructive command', buttons: ['Cancel', 'Confirm'], cancelId: 0 };
  const f = setup(t, new Map([['guarded', async c => { await dialog(c, 'message', options); applied++; }]]));
  const first = invoke('human-approved-A', 'guarded');
  assert.equal((await f.controller.call(binding(), first)).state, 'confirmation-required');
  const c = await f.controller.view(sender); c.checkActor = async () => { entered(); await waiting; };
  const decision = f.controller.decide(sender.id, sender.nativeId, first.operation_id, 1);
  await checking;
  const concurrent = await f.controller.call(binding(), invoke('unapproved-B', 'guarded'));
  unblock(); const result = await decision;
  assert.equal(concurrent.state, 'not-executed'); assert.equal(concurrent.reason, 'another-operation-running');
  assert.equal(result.state, 'complete'); assert.equal(applied, 1);
  assert.equal(f.controller.receipt(sender, 'unapproved-B'), null);
});
test('explicit background file selection uses the existing handler without a native picker', async t => {
  const f = setup(t); const selected = path.join(f.dir, 'text.txt'); fs.writeFileSync(selected, 'content');
  const c = { background: true }, actor = { ...sender, callId: 'call', turnId: 'turn', operationId: 'files' }, request = { context: c, actor, args: { paths: [selected] } };
  assert.deepEqual(await operation.run(actor, () => dialog(c, 'open', { properties: ['openFile'] }, () => { throw Error('desktop picker'); }), request), { canceled: false, filePaths: [selected] });
  assert.throws(() => operation.run(actor, () => dialog(c, 'open', { properties: ['openDirectory'] }), request), /wrong type/);
});
test('shutdown releases only its own connections before awaiting a pending command', async t => {
  let finish, entered; const waiting = new Promise(resolve => { finish = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const f = setup(t, new Map([['queue', async () => { entered(); return waiting; }]]));
  const c = await f.controller.view(sender); c.client.close = () => finish('connection closed, native work retained');
  const result = f.controller.call(binding(), invoke('pending', 'queue')); await started;
  await Promise.race([f.controller.close(), new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('Closing waited on its own connection')), 500); timer.unref(); })]);
  await result; assert.equal(f.controller.contexts.size, 0);
  await assert.rejects(f.controller.call(binding(), { action: 'snapshot' }), /closing/);
});
test('control arguments cannot identify the caller, execute unknown methods, or change receipts', async t => {
  for (const a of [{ action: 'invoke', method: 'send', arguments: [] }, { action: 'snapshot', callerId: 'forged' }, { action: 'receipt', operation_id: 'x', arguments: [] }]) assert.throws(() => validate(a));
  const f = setup(t); assert.equal((await f.controller.call(binding(), invoke('unknown', 'madeUp'))).state, 'not-executed');
  assert.equal(f.controller.data.records.length, 0);
});
function codex(args) {
  const rpc = { connected: true }, r = new Codex({ provider: 'codex', nativeId: identity.nativeId, messages: [] }, { rpc, codexTargets: new Map() });
  r.turnId = identity.turnId; r.nativeSessionId = identity.sessionId; r.latestState = 'working';
  const item = { type: 'mcpToolCall', id: identity.callId, server: 'native_workspace', tool: 'workspace_control', arguments: args, status: 'inProgress' };
  return { r, item, emit: (method, change = {}) => r.event({ method, params: { threadId: r.record.nativeId, turnId: identity.turnId, item: { ...item, ...change } } }, rpc) };
}
test('actual Codex native tool events bind exact control arguments, single use, lifecycle and completion', async () => {
  const args = invoke('rename-native', 'rename', ['target', 'Literal 名字']), f = codex(args); f.emit('item/started');
  const proof = await native.nativeCall(f.r, identity, args, new AbortController().signal); assert.equal(proof.valid(), true);
  await assert.rejects(native.nativeCall(f.r, identity, args, new AbortController().signal));
  f.emit('item/completed', { status: 'completed' }); assert.equal(proof.valid(), false);
  for (const change of [{ server: 'other' }, { tool: 'workspace_message' }, { arguments: { ...args, arguments: ['other'] } }]) {
    const g = codex(args); g.emit('item/started', change); await assert.rejects(native.nativeCall(g.r, identity, args, AbortSignal.abort()));
  }
});
test('Claude root proof requires the actual bound prompt and cannot be consumed twice or after root changes', () => {
  const args = invoke('claude-op', 'rename', ['target', 'name']);
  const r = { record: { provider: 'claude', nativeId: 'claude-native' }, nativeBlocks: true, terminal: { alive: true }, observationEpoch: 2,
    liveTurn: { id: 'turn', promptId: 'prompt' }, validRootBinding: () => true };
  const message = { arguments: args, turnId: 'turn', promptId: 'prompt', callId: 'call', epoch: 2 };
  const p = native.rootCall(r, message, new AbortController().signal, () => true);
  const proof = native.consumeCredential(p.credential); assert.equal(proof.valid(), true);
  assert.throws(() => native.consumeCredential(p.credential));
  r.liveTurn = { id: 'new', promptId: 'new' }; assert.equal(proof.valid(), false);
  assert.throws(() => native.rootCall(r, { ...message, callId: 'new-call' }, new AbortController().signal, () => true));
});
