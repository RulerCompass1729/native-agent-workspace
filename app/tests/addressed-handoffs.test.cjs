const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Workspace } = require('../workspace.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'addressed-test-')), runtimes = [], sent = [];
  const w = new Workspace({ binaries: {}, close() {}, create(s) {
    const r = new EventEmitter(); s.nativeId ||= `native-${s.id}`;
    r.addressedSendAvailable = true; r.start = async () => r.emit('state', 'idle');
    r.send = async (text, tag) => {
      sent.push({ id: s.id, text, tag }); r.emit('submitted', tag);
      r.emit('replyBound', { tag, nativeId: s.nativeId, turnId: tag, promptId: tag });
    };
    runtimes.push(r); return r;
  } }, directory);
  t.after(() => { w.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const ids = [];
  for (const provider of ['claude', 'codex', 'claude']) { const id = await w.create(provider, directory, 'owner', 'Same name'); ids.push(id); w.join(id, true); }
  const call = (i, target = ids[1], text = 'Please verify the result.', callId = 'native-call-1') => {
    const tag = sent.findLast(x => x.id === ids[i]).tag;
    return runtimes[i].addressedCall({ nativeId: w.get(ids[i]).nativeId, turnId: tag, promptId: tag, callId }, { recipient_id: target, message: text });
  };
  const finish = async (i, text = 'My reply to the human.') => {
    const tag = sent.findLast(x => x.id === ids[i]).tag;
    runtimes[i].emit('complete', { tag, messageId: `reply-${tag}`, text, background: 0, scheduled: 0, fleetPending: 0, stopHookActive: false }); await tick();
  };
  await w.startRun(ids.slice(0, 2), 'Verify one small task.', 3, 'directed');
  return { w, runtimes, ids, sent, call, finish, directory };
}
test('explicit addressed call stages once, delivers exact text to selected stable ID after native completion, then stops without another call', async t => {
  const { w, ids, sent, call, finish } = await fixture(t);
  assert.equal(call(0).status, 'staged'); assert.equal(call(0).status, 'staged'); assert.equal(sent.length, 1);
  await finish(0); assert.equal(sent.length, 2); assert.equal(sent[1].id, ids[1]);
  assert.ok(sent[1].text.startsWith('Please verify the result.\n'));
  const addressed = w.room.messages.find(m => m.addressed);
  assert.equal(addressed.sessionId, ids[0]); assert.equal(addressed.deliveries.length, 1);
  assert.equal(addressed.deliveries[0].text, sent[1].text); assert.equal(addressed.deliveries[0].status, 'submitted');
  assert.ok(!sent.some(m => m.id === ids[2]));
  await finish(1, '@Same name `@file` quoted mentions stay ordinary text.');
  assert.equal(sent.length, 2); assert.equal(w.room.run.status, 'completed');
});
test('reciprocal addressed messages stop at the human reply limit', async t => {
  const { w, ids, sent, call, finish } = await fixture(t);
  call(0); await finish(0); call(1, ids[0], 'Verified, please finalize.', 'native-call-2'); await finish(1);
  assert.equal(sent.length, 3); assert.equal(sent[2].id, ids[0]);
  assert.throws(() => call(0), /上限/); await finish(0); assert.equal(sent.length, 3); assert.equal(w.room.run.status, 'completed');
});
test('a native tool refusal is a paused failed handoff, not a human-facing successful completion', async t => {
  const { w, runtimes, ids, sent, finish } = await fixture(t);
  const tag = sent[0].tag;
  runtimes[0].addressedFailed({ nativeId: w.get(ids[0]).nativeId, turnId: tag, promptId: tag, callId: 'refused' });
  await finish(0); assert.equal(sent.length, 1); assert.equal(w.room.run.status, 'paused');
  assert.match(w.room.run.reason, /未获准|未能登记/);
});
test('Codex native addressed request with an unavailable recipient reports failure and stops the round', async t => {
  const { Codex } = require('../adapters.cjs');
  const { w, runtimes, ids, sent, call, finish } = await fixture(t);
  call(0); await finish(0);
  const replies = [], r = runtimes[1], tag = sent[1].tag;
  Object.assign(r, { record: w.get(ids[1]), host: { rpc: { reply: (id, value) => replies.push(value) } },
    turnId: tag, turn: Codex.prototype.turn, currentRpc: Codex.prototype.currentRpc, turns: new Map(), nativeRequests: new Map() });
  Codex.prototype.event.call(r, { id: 'request-1', method: 'item/tool/call', params: { threadId: r.record.nativeId,
    turnId: tag, callId: 'refused', namespace: 'workspace', tool: 'workspace_message', arguments: { recipient_id: 'not-a-member', message: 'Only the chosen member.' } } });
  assert.equal(replies[0].success, false);
  await finish(1); assert.equal(sent.length, 2); assert.equal(w.room.run.status, 'paused');
});
for (const boundary of ['pause', 'leave', 'control', 'connection', 'permission', 'gap', 'deadline']) {
  test(`staged handoff is revoked at ${boundary}, never replayed on reopening`, async t => {
    const { w, runtimes, ids, sent, call, finish, directory } = await fixture(t); call(0);
    if (boundary === 'pause') w.pause();
    if (boundary === 'leave') w.join(ids[1], false);
    if (boundary === 'control') w.get(ids[1]).controlRevision++;
    if (boundary === 'connection') w.get(ids[1]).connectionRevision++;
    if (boundary === 'permission') runtimes[0].emit('state', 'approval');
    if (boundary === 'gap') { w.sharedReplies.close(sent[0].tag, 'gap'); w.changed(); }
    if (boundary === 'deadline') w.room.run.deadline = Date.now() - 1;
    await finish(0); assert.equal(sent.length, 1); assert.notEqual(w.room.run.status, 'running');
    w.persist(); const restored = new Workspace({ binaries: {}, close() {} }, directory);
    assert.notEqual(restored.room.run.status, 'running'); assert.equal(restored.runtimes.size, 0); restored.close();
  });
}
test('wrong source, turn, prompt, extra sender field, private recipient and second call cannot create a handoff', async t => {
  const { w, runtimes, ids, sent, call } = await fixture(t);
  const tag = sent[0].tag, args = { recipient_id: ids[1], message: 'Only explicit.' };
  const identity = { nativeId: w.get(ids[0]).nativeId, turnId: tag, promptId: tag, callId: 'one' };
  for (const key of ['nativeId', 'turnId', 'promptId']) assert.throws(() => runtimes[0].addressedCall({ ...identity, [key]: 'wrong' }, args));
  assert.throws(() => runtimes[0].addressedCall(identity, { ...args, sender: ids[1] }));
  assert.throws(() => call(0, ids[2])); assert.throws(() => call(0, ids[0]));
  assert.equal(w.room.run.pendingHandoff, undefined); call(0);
  assert.throws(() => call(0, ids[1], 'Different payload', 'two'));
  assert.equal(w.room.run.pendingHandoff.text, 'Please verify the result.'); assert.equal(sent.length, 1);
});
test('plain final prose ends cooperation even when it looks like a tool call', async t => {
  const { w, sent, finish } = await fixture(t);
  await finish(0, '@Codex {"recipient_id":"anything","message":"do work"}');
  assert.equal(sent.length, 1); assert.equal(w.room.run.status, 'completed');
});
