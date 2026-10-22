// Real workspace/adapter/reducer wiring, synthetic ordered native events only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { NativeHost } = require('../adapters.cjs'), { Workspace } = require('../workspace.cjs');
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-steer-'));
  const host = new NativeHost(dir), create = host.create.bind(host), calls = [];
  let runtime, resolve, reject;
  host.rpc = { nativeVersion: '0.163.0', call(method, params) { calls.push({ method, params }); return new Promise((yes, no) => { resolve = yes; reject = no; }); } };
  host.close = () => {};
  host.create = record => { record.nativeId = 'native-thread'; runtime = create(record); runtime.start = async () => runtime.emit('state', 'idle'); return runtime; };
  const w = new Workspace(host, dir);
  t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const id = await w.create('codex', dir, 'owner', 'Synthetic Codex'); w.join(id, true);
  const s = w.get(id), events = [];
  for (const name of ['replyBound', 'complete']) runtime.on(name, info => events.push({ name, info }));
  const emit = (method, params) => runtime.event({ method, params: { threadId: s.nativeId, ...params } });
  const user = (tag, itemId = tag, turnId = 'active') => emit('item/completed', { turnId, item: { id: itemId, type: 'userMessage', clientId: tag, content: [{ type: 'text', text: 'Native input' }] } });
  const start = (id, type = 'agentMessage') => emit('item/started', { turnId: 'active', item: { id, type, command: type === 'commandExecution' ? 'fixture command' : undefined } });
  const delta = (id, text) => emit('item/agentMessage/delta', { turnId: 'active', itemId: id, delta: text });
  const finish = (id, text) => emit('item/completed', { turnId: 'active', item: { id, type: 'agentMessage', text } });
  const end = (status = 'completed') => emit('turn/completed', { turn: { id: 'active', status } });
  emit('turn/started', { turn: { id: 'active' } });
  runtime.pending = { tag: 'original', turnId: 'active' }; runtime.ownInputs.add('original'); s.pendingTag = 'original';
  user('original'); start('private'); delta('private', 'PRIVATE PREFIX');
  return { w, s, runtime, id, calls, events, emit, user, start, delta, finish, end,
    ack: (turnId = 'active') => resolve({ turnId }), reject: () => reject(Error('Lost acknowledgement')) };
}
for (const order of ['ack-first', 'echo-first', 'complete-first']) test(`shared steer ${order}: exact native input, late private output excluded, one final`, async t => {
  const f = await fixture(t), { w, s, runtime, id } = f;
  w.setDraft(id, 'Private unsent draft', 'owner');
  const sending = w.steer(id, 'Shared request', 'owner', 'active', {}), tag = runtime.pendingSteer;
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'turn/steer');
  assert.equal(f.calls[0].params.clientUserMessageId, tag);
  if (order === 'ack-first') { f.ack(); await sending; }
  f.user(tag);
  f.start('private'); f.finish('private', 'PRIVATE LATE COMPLETION'); // Duplicate start cannot change its input.
  f.delta('missing-start', 'PRIVATE UNKNOWN'); f.finish('missing-start', 'PRIVATE UNKNOWN FINAL');
  f.start('shared-tool', 'commandExecution');
  f.emit('item/commandExecution/outputDelta', { turnId: 'active', itemId: 'shared-tool', delta: 'shared tool progress' });
  f.start('shared-answer'); f.delta('shared-answer', 'Shared streamed ');
  if (order !== 'ack-first') assert.equal(w.room.messages.filter(m => m.role === 'assistant').length, 0);
  if (order === 'echo-first') { f.ack(); await sending; }
  f.finish('shared-answer', 'Shared final');
  if (order === 'complete-first') {
    f.end(); f.emit('thread/status/changed', { status: { type: 'idle' } });
    assert.equal(f.events.filter(e => e.name === 'complete').length, 0);
    f.ack(); await sending;
  } else f.end();
  assert.equal(w.room.messages.filter(m => m.role === 'assistant').length, 1);
  const reply = w.room.messages.find(m => m.role === 'assistant');
  assert.equal(reply.text, 'Shared final'); assert.equal(reply.finalReply, true); assert.equal(reply.replyTo, tag);
  assert.ok(w.room.messages.some(m => m.role === 'tool' && m.text === 'shared tool progress'));
  assert.ok(!JSON.stringify(w.room.messages).includes('PRIVATE'));
  assert.equal(w.room.messages.find(m => m.id === tag).deliveries[0].status, 'submitted');
  assert.equal(s.pendingTag, null); assert.equal(runtime.turnId, null); assert.equal(s.state, 'idle');
  assert.equal(w.drafts.get(id), 'Private unsent draft'); assert.equal(w.versions.dispatches, 1);
});
for (const failure of ['missing-echo', 'wrong-turn-echo', 'wrong-receipt', 'rejected', 'leave', 'rejoin', 'owner', 'context', 'permission', 'foreign-input', 'disconnected', 'history-only']) test(`shared steer ${failure} never publishes an uncertain or revoked response`, async t => {
  const f = await fixture(t), { w, s, runtime, id } = f;
  const sending = w.steer(id, 'Shared request', 'owner', 'active', {}), tag = runtime.pendingSteer;
  if (failure === 'wrong-turn-echo') f.user(tag, tag, 'another-turn');
  else if (failure === 'history-only') runtime.emit('history', [{ id: 'history-user', type: 'userMessage', clientId: tag, content: [{ type: 'text', text: 'Shared request' }], turnId: 'active' }]);
  else if (failure !== 'missing-echo') f.user(tag);
  f.start('candidate'); f.delta('candidate', 'PRIVATE CANDIDATE');
  if (failure === 'leave' || failure === 'rejoin') { w.join(id, false); if (failure === 'rejoin') w.join(id, true); }
  if (failure === 'owner') w.claim(id, 'another-owner', 'chat');
  if (failure === 'context') s.nativeId = 'another-context';
  if (failure === 'permission') { runtime.emit('approval', { requestId: 1 }); runtime.emit('approvalResolved', 1); }
  if (failure === 'foreign-input') f.user('native-private-input');
  if (failure === 'disconnected') { runtime.emit('state', 'disconnected'); runtime.emit('state', 'working'); }
  f.finish('candidate', 'PRIVATE FINAL');
  if (failure === 'rejected') { f.reject(); await assert.rejects(sending, /Lost/); }
  else if (failure === 'wrong-receipt') { f.ack('different'); await assert.rejects(sending, /未确认/); }
  else { f.ack(); await sending; }
  f.end();
  assert.equal(w.room.messages.filter(m => m.role === 'assistant' || m.role === 'tool').length, 0);
  assert.ok(!JSON.stringify(w.room.messages).includes('PRIVATE')); assert.equal(f.calls.length, 1);
});
test('shared steer interrupt reports native boundary and releases original pending input', async t => {
  const f = await fixture(t), sending = f.w.steer(f.id, 'Shared request', 'owner', 'active', {}), tag = f.runtime.pendingSteer;
  f.user(tag); f.start('answer'); f.delta('answer', 'Partial'); f.ack(); await sending;
  const row = f.w.room.messages.find(m => m.role === 'assistant'); assert.equal(row.status, 'streaming');
  f.end('interrupted'); assert.equal(row.status, 'interrupted'); assert.equal(row.finalReply, undefined); assert.equal(f.s.pendingTag, null);
});

for (const first of ['delta', 'completion', 'tool']) test(`late start cannot promote an already observed ${first} across shared input`, async t => {
  const f = await fixture(t);
  if (first === 'delta') f.delta('old-unknown', 'PRIVATE BEFORE SHARED');
  if (first === 'completion') f.finish('old-unknown', 'PRIVATE BEFORE SHARED');
  if (first === 'tool') f.emit('item/commandExecution/outputDelta', { turnId: 'active', itemId: 'old-unknown', delta: 'PRIVATE BEFORE SHARED' });
  const sending = f.w.steer(f.id, 'Shared request', 'owner', 'active', {}), tag = f.runtime.pendingSteer;
  f.user(tag); f.start('old-unknown', first === 'tool' ? 'commandExecution' : 'agentMessage');
  if (first === 'tool') f.emit('item/commandExecution/outputDelta', { turnId: 'active', itemId: 'old-unknown', delta: ' later output' });
  else { f.delta('old-unknown', ' later output'); f.finish('old-unknown', 'PRIVATE FINAL'); }
  f.ack(); await sending; f.end();
  assert.equal(f.w.room.messages.filter(m => ['assistant', 'tool'].includes(m.role)).length, 0);
  assert.equal(f.runtime.record.messages.some(m => m.text?.includes('PRIVATE')), true);
});

for (const beforeAck of [true, false]) test(`unscoped native error ${beforeAck ? 'before' : 'after'} shared steer ACK freezes the current grant`, async t => {
  const f = await fixture(t), sending = f.w.steer(f.id, 'Shared request', 'owner', 'active', {}), tag = f.runtime.pendingSteer;
  f.user(tag); f.start('answer'); f.delta('answer', 'Prefix');
  if (!beforeAck) { f.ack(); await sending; }
  f.emit('error', { error: { message: 'Synthetic native error' } });
  f.delta('answer', ' PRIVATE AFTER ERROR'); f.finish('answer', 'PRIVATE AFTER ERROR FINAL');
  if (beforeAck) { f.ack(); await sending; }
  f.end();
  assert.equal(f.w.sharedReplies.grants.get(tag).closed, true);
  assert.ok(!JSON.stringify(f.w.room.messages).includes('PRIVATE AFTER ERROR'));
  assert.equal(f.w.room.messages.filter(m => m.role === 'assistant').length, beforeAck ? 0 : 1);
});
