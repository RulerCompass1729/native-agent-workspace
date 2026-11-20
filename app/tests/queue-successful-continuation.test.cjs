'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture } = require('./fixtures/quota-turn.cjs');
const final = 'Synthetic finished delivery\nREADY lane/synthetic abcd1234';
for (const echo of [false, true]) test('SAFETY accepted successful continuation must not inherit failure, explicit input=' + echo, async t => {
  const f = await fixture(t); f.drive({ partial: true });
  f.frame('turn/started', { turn: { id: 'success-turn' } });
  if (echo) f.frame('item/completed', { turnId: 'success-turn', item: { id: 'continued-input', type: 'userMessage', clientId: f.tag, content: [{ type: 'inputText', text: 'Synthetic diagnostic task' }] } });
  f.frame('item/started', { turnId: 'success-turn', item: { id: 'final-delivery', type: 'agentMessage', phase: 'final_answer' } });
  f.frame('item/completed', { turnId: 'success-turn', item: { id: 'final-delivery', type: 'agentMessage', phase: 'final_answer', text: final } });
  f.frame('turn/completed', { turn: { id: 'success-turn', status: 'completed' } });
  const row = f.snapshot(), current = row.messages.find(m => m.role === 'assistant' && m.turnId === 'success-turn');
  assert.equal(row.nativeQuota, undefined); assert.equal(row.state, 'idle');
  assert.equal(current.status, 'complete'); assert.equal(current.nativeId, row.nativeId);
  if (echo) assert.equal(current.inputTag, f.tag);
  const claim = f.room.queueFind('shared', f.itemId);
  const reply = f.M.rules.replyAfter(row, f.tag, claim.sentAt, false, { itemId: f.itemId, nativeId: claim.sentNative, claim });
  assert.equal(reply.last, final); assert.equal(reply.humanAfter, false); assert.equal(reply.purposeInvalid, undefined);
  const action = f.settle(), persisted = new f.M.RoomState(f.dir).queueFind('shared', f.itemId);
  console.log('PERSISTED_CONTINUATION ' + JSON.stringify({ explicitInput: echo, latestTurn: current.turnId, inputTagMatches: current.inputTag === f.tag,
    nativeQuota: row.nativeQuota ?? null, acceptedLastReply: reply.last, failedTurnIds: reply.failedTurnIds ?? [],
    action, persistedStatus: persisted.status, persistedReady: persisted.ready ?? null, nativeCalls: f.calls.length }));
  assert.equal(persisted.status, 'done'); assert.ok(action.ready); assert.equal(f.calls.length, 1);
});

function continuation(f, turnId = 'success-turn', status = 'completed') {
  f.frame('turn/started', { turn: { id: turnId } });
  f.frame('item/completed', { turnId, item: { id: 'delivery-' + turnId, type: 'agentMessage', phase: 'final_answer', text: final } });
  f.frame('turn/completed', { turn: { id: turnId, status } });
}
for (const change of ['wrong-native', 'missing-native', 'wrong-turn', 'wrong-tag', 'wrong-boundary-tag', 'missing-boundary', 'interrupted-boundary']) test('failure remains blocking without a matching successful delivery: ' + change, async t => {
  const f = await fixture(t); f.drive({ partial: true }); continuation(f);
  const message = f.s.messages.find(m => m.role === 'assistant' && m.turnId === 'success-turn');
  const boundary = f.s.messages.find(m => m.kind === 'turn' && m.turnId === 'success-turn');
  if (change === 'wrong-native') message.nativeId = '22222222-2222-4222-8222-222222222222';
  if (change === 'missing-native') delete message.nativeId;
  if (change === 'wrong-turn') boundary.turnId = 'unrelated-turn';
  if (change === 'wrong-tag') message.inputTag = 'unrelated-input';
  if (change === 'wrong-boundary-tag') boundary.inputTag = 'unrelated-input';
  if (change === 'missing-boundary') f.s.messages = f.s.messages.filter(m => m !== boundary);
  if (change === 'interrupted-boundary') boundary.status = 'interrupted';
  const action = f.settle(); assert.equal(action.status, 'waiting'); assert.equal(action.reason, 'native-turn-failed');
  for (const key of ['reply', 'ready', 'reportTitle']) assert.equal(action[key], undefined);
  assert.equal(new f.M.RoomState(f.dir).queueFind('shared', f.itemId).status, 'waiting'); assert.equal(f.calls.length, 1);
});
test('an earlier successful delivery cannot excuse a later failed turn', async t => {
  const f = await fixture(t); f.drive({ partial: true, success: true, text: final }); continuation(f, 'later-failure', 'failed');
  const action = f.settle(); assert.equal(action.status, 'waiting'); assert.equal(action.reason, 'native-turn-failed');
  assert.equal(action.ready, undefined); assert.equal(action.reply, undefined); assert.equal(f.calls.length, 1);
});
test('a second failure after recovery cannot reuse the earlier success', async t => {
  const f = await fixture(t); f.drive({ partial: true }); continuation(f); continuation(f, 'later-failure', 'failed');
  const action = f.settle(); assert.equal(action.status, 'waiting'); assert.equal(action.ready, undefined); assert.equal(action.reply, undefined); assert.equal(f.calls.length, 1);
});
test('the final delivery text must have its own successful boundary', async t => {
  const f = await fixture(t); f.drive({ partial: true }); continuation(f);
  f.frame('item/completed', { turnId: 'unproven-turn', item: { id: 'unproven', type: 'agentMessage', phase: 'final_answer', text: final } });
  const action = f.settle(); assert.equal(action.status, 'waiting'); assert.equal(action.ready, undefined); assert.equal(action.reply, undefined); assert.equal(f.calls.length, 1);
});
test('a successful continuation cannot bypass the original queue purpose', async t => {
  const f = await fixture(t); f.drive({ partial: true }); continuation(f);
  f.s.messages.find(m => m.id === f.tag).dispatchPurpose.itemId = 'unrelated-item';
  const action = f.settle(); assert.equal(action.status, 'waiting'); assert.equal(action.reason, 'input-purpose-unconfirmed'); assert.equal(action.ready, undefined); assert.equal(f.calls.length, 1);
});

const path = require('node:path'), { ROOT } = require('./fixtures/quota-turn.cjs');
const { replyAfter } = require(path.join(ROOT, 'app/queue-dispatch.cjs'));
for (const nativeId of [undefined, null, '']) for (const continued of [false, true]) test('unavailable native identity stays failed: ' + String(nativeId) + ', continuation=' + continued, () => {
  const messages = [{ id: 'tag', role: 'user', origin: 'naw-dispatch', dispatchItem: 'task' },
    { role: 'assistant', text: 'failed text', status: 'complete', nativeId, turnId: 'failed' },
    { kind: 'turn', status: 'failed', nativeId, turnId: 'failed' }];
  if (continued) messages.push({ role: 'assistant', text: 'READY lane/synthetic abcd1234', status: 'complete', nativeId, turnId: 'later' },
    { kind: 'turn', status: 'complete', nativeId, turnId: 'later' });
  const reply = replyAfter({ nativeId, messages }, 'tag', 0, false, { itemId: 'task' });
  assert.deepEqual(reply.failedTurnIds, ['failed']);
});

function emptyEndAfterSuccess(f, status) {
  f.drive({ partial: true });
  f.frame('turn/started', { turn: { id: 'bound-success' } });
  f.frame('item/completed', { turnId: 'bound-success', item: { id: 'success-input', type: 'userMessage', clientId: f.tag, content: [{ type: 'inputText', text: 'Synthetic diagnostic task' }] } });
  f.frame('item/started', { turnId: 'bound-success', item: { id: 'success-output', type: 'agentMessage', phase: 'final_answer' } });
  f.frame('item/completed', { turnId: 'bound-success', item: { id: 'success-output', type: 'agentMessage', phase: 'final_answer', text: final } });
  f.frame('turn/completed', { turn: { id: 'bound-success', status: 'completed' } });
  f.frame('turn/started', { turn: { id: 'empty-end' } });
  f.frame('item/completed', { turnId: 'empty-end', item: { id: 'end-input', type: 'userMessage', clientId: f.tag, content: [{ type: 'inputText', text: 'Synthetic diagnostic task' }] } });
  f.frame('turn/completed', { turn: { id: 'empty-end', status } });
  return f.s.messages.find(m => m.kind === 'turn' && m.turnId === 'empty-end');
}
test('an empty interruption bound to the original input cannot reuse earlier delivery', async t => {
  const f = await fixture(t), boundary = emptyEndAfterSuccess(f, 'interrupted');
  assert.equal(boundary.inputTag, f.tag); assert.equal(boundary.status, 'interrupted');
  assert.ok(!f.snapshot().messages.some(m => m.role === 'assistant' && m.turnId === 'empty-end'));
  const action = f.settle(), saved = new f.M.RoomState(f.dir).queueFind('shared', f.itemId);
  assert.equal(saved.status, 'waiting'); assert.equal(saved.ready, undefined);
  for (const key of ['reply', 'ready', 'reportTitle']) assert.equal(action[key], undefined);
  assert.equal(f.calls.length, 1);
});
for (const change of ['other-native', 'other-input']) test('an unrelated empty failure does not override the accepted delivery: ' + change, async t => {
  const f = await fixture(t), boundary = emptyEndAfterSuccess(f, 'failed');
  if (change === 'other-native') boundary.nativeId = '22222222-2222-4222-8222-222222222222';
  else boundary.inputTag = 'unrelated-input';
  const action = f.settle(), saved = new f.M.RoomState(f.dir).queueFind('shared', f.itemId);
  assert.equal(saved.status, 'done'); assert.ok(action.ready); assert.equal(f.calls.length, 1);
});

test('a later empty failure explicitly bound to the original input cannot reuse prior success', async t => {
  const f = await fixture(t); f.drive({ partial: true });
  f.frame('turn/started', { turn: { id: 'success-turn' } });
  f.frame('item/completed', { turnId: 'success-turn', item: { id: 'success-input', type: 'userMessage', clientId: f.tag, content: [{ type: 'inputText', text: 'Synthetic diagnostic task' }] } });
  f.frame('item/started', { turnId: 'success-turn', item: { id: 'success-text', type: 'agentMessage', phase: 'final_answer' } });
  f.frame('item/completed', { turnId: 'success-turn', item: { id: 'success-text', type: 'agentMessage', phase: 'final_answer', text: 'Synthetic delivery\nREADY lane/synthetic abcd1234' } });
  f.frame('turn/completed', { turn: { id: 'success-turn', status: 'completed' } });
  f.frame('turn/started', { turn: { id: 'later-empty-failure' } });
  f.frame('item/completed', { turnId: 'later-empty-failure', item: { id: 'failed-input', type: 'userMessage', clientId: f.tag, content: [{ type: 'inputText', text: 'Synthetic diagnostic task' }] } });
  f.frame('turn/completed', { turn: { id: 'later-empty-failure', status: 'failed', error: { codex_error_info: 'usage_limit_exceeded', message: 'Synthetic quota failure without assistant text' } } });
  const row = f.snapshot(), claim = f.room.queueFind('shared', f.itemId);
  const reply = f.M.rules.replyAfter(row, f.tag, claim.sentAt, false, { itemId: f.itemId, nativeId: claim.sentNative, claim });
  const action = f.settle(), persisted = new f.M.RoomState(f.dir).queueFind('shared', f.itemId);
  console.log('LATER_EMPTY_FAILURE ' + JSON.stringify({ boundaries: row.messages.filter(m => m.kind === 'turn'), nativeQuota: row.nativeQuota, reply, action, persisted, nativeCalls: f.calls.length }));
  assert.equal(row.nativeQuota.turnId, 'later-empty-failure');
  assert.equal(row.messages.find(m => m.kind === 'turn' && m.turnId === 'later-empty-failure').inputTag, f.tag);
  assert.equal(row.messages.find(m => m.role === 'assistant' && m.turnId === 'success-turn').inputTag, f.tag);
  assert.equal(reply.humanAfter, false); assert.equal(reply.purposeInvalid, undefined);
  assert.equal(persisted.status, 'waiting'); assert.equal(action.ready, undefined); assert.equal(f.calls.length, 1);
  assert.equal(persisted.ready, undefined); for (const key of ['reply', 'ready', 'reportTitle']) assert.equal(action[key], undefined);
});

test('a later empty failed native turn cannot reuse the earlier successful continuation', async t => {
  const f = await fixture(t); f.drive({ partial: true });
  f.frame('turn/started', { turn: { id: 'success-turn' } });
  f.frame('item/completed', { turnId: 'success-turn', item: { id: 'success-text', type: 'agentMessage', phase: 'final_answer', text: 'Synthetic delivery\nREADY lane/synthetic abcd1234' } });
  f.frame('turn/completed', { turn: { id: 'success-turn', status: 'completed' } });
  f.frame('turn/started', { turn: { id: 'later-empty-failure' } });
  f.frame('turn/completed', { turn: { id: 'later-empty-failure', status: 'failed', error: { codex_error_info: 'usage_limit_exceeded', message: 'Synthetic quota failure without assistant text' } } });
  const row = f.snapshot(), claim = f.room.queueFind('shared', f.itemId);
  const reply = f.M.rules.replyAfter(row, f.tag, claim.sentAt, false, { itemId: f.itemId, nativeId: claim.sentNative, claim });
  const action = f.settle(), persisted = new f.M.RoomState(f.dir).queueFind('shared', f.itemId);
  console.log('LATER_EMPTY_FAILURE ' + JSON.stringify({ boundaries: row.messages.filter(m => m.kind === 'turn'), nativeQuota: row.nativeQuota, reply, action, persisted, nativeCalls: f.calls.length }));
  assert.equal(row.nativeQuota.turnId, 'later-empty-failure');
  assert.equal(persisted.status, 'waiting'); assert.equal(action.ready, undefined); assert.equal(f.calls.length, 1);
  assert.equal(persisted.ready, undefined); for (const key of ['reply', 'ready', 'reportTitle']) assert.equal(action[key], undefined);
});
