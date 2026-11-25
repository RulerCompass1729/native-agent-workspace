// Regression cases from independent review C-A3-1.
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { RoomState } = require('../room-state.cjs');
const { ButlerIngress, bindQueueOutcomes, storedQueueSource } = require('../butler-ingress.cjs');
const { QueueDispatcher } = require('../queue-dispatch.cjs');
const NOW = 1_800_000_000_000;
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-e-a3-parent-'));
  fs.chmodSync(dir, 0o700); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const room = new RoomState(dir), ingress = new ButlerIngress(dir, { roomState: room });
  let personNotices = 0;
  bindQueueOutcomes(room, ingress, () => { personNotices++; });
  const session = { id: 'member-a', nativeId: 'native-a', provider: 'codex', state: 'idle' };
  const itemId = room.queueAdd('PRIVATE TASK CANARY', null);
  room.queueMarkSent('shared', itemId, session.id, 'PRIVATE NAME CANARY', NOW, false, session.nativeId);
  const dispatcher = { roomState: room, client: { snapshot: () => ({ sessions: [session] }) },
    stillSent: (...args) => room.queueFind(...args).status === 'sent',
    name: () => 'PRIVATE NAME CANARY', broadcast: () => Promise.resolve(), clearRuns() {} };
  const settle = (status = 'waiting', reason = 'no-reply', planned = session) => QueueDispatcher.prototype.settle.call(dispatcher,
    { roomId: 'shared', itemId, sessionId: session.id, status, reason, reply: status === 'done' ? 'Synthetic complete reply' : '' }, { sessions: [planned] });
  return { dir, room, ingress, session, itemId, settle, client: dispatcher.client, events: () => ingress.ledger.snapshot().events,
    personNotices: () => personNotices, restart: () => new ButlerIngress(dir, { roomState: new RoomState(dir) }) };
}
function quota(f, turnId = 'quota-turn') {
  f.session.nativeQuota = { kind: 'usage_limit_exceeded', nativeId: f.session.nativeId, turnId, observedAt: NOW, model: null };
}
test('C: an asynchronous plan/settle gap uses the current quota and still emits exactly once',async t=>{
 const f=fixture(t),planned=structuredClone(f.session);await new Promise(setImmediate);quota(f,'arrived-after-plan');
 f.ingress.observeRecoveryFailures([f.session]);f.settle('waiting','no-reply',planned);
 assert.equal(f.events().length,1);assert.equal(f.events()[0].payload.reason,'codex-usage-limit-exceeded');
});
test('C: recovery in a plan/settle gap restores unknown no-reply instead of suppressing it',async t=>{
 const f=fixture(t);quota(f);const planned=structuredClone(f.session);f.ingress.observeRecoveryFailures([f.session]);
 await new Promise(setImmediate);delete f.session.nativeQuota;f.settle('waiting','no-reply',planned);
 assert.equal(f.events().length,2);assert.deepEqual(f.events().at(-1).payload,{memberId:f.session.id,itemId:f.itemId,reason:'no-reply-unconfirmed'});
});
test('C: a copied auxiliary source cannot bind to a different parent event ID',t=>{
 const f=fixture(t);f.settle();const original=f.room.metadata().events.at(-1),event=structuredClone(f.room.metadata().events.find(e=>e.uiMessage?.key==='notice.queue.dispatched'));
 assert.ok(event);event.butlerNoReplySource=structuredClone(original.butlerNoReplySource);
 const source=storedQueueSource('shared',event);console.log('PARENT-ID actual '+JSON.stringify(source));assert.equal(source.payload.reason,'source-invalid');
});
test('C: a copied auxiliary source cannot bind to another room',t=>{
 const f=fixture(t);f.settle();const event=structuredClone(f.room.metadata().events.at(-1));
 const otherRoom=f.room.create('Synthetic other room');const source=storedQueueSource(otherRoom,event);console.log('PARENT-ROOM actual '+JSON.stringify(source));assert.equal(source.payload.reason,'source-invalid');
});
test('C: changing a stored unknown cause into plausible quota identities must not fabricate a typed block',t=>{
 const f=fixture(t);f.settle();const event=structuredClone(f.room.metadata().events.at(-1));
 event.butlerNoReplySource.quota={nativeId:'unrelated-native',turnId:'invented-quota-turn'};
 const source=storedQueueSource('shared',event);console.log('FORGED-QUOTA actual '+JSON.stringify(source));assert.equal(source.payload.reason,'source-invalid');
});
test('C: extra payload is rejected and cannot escape the source record',t=>{
 const f=fixture(t);f.settle();const event=structuredClone(f.room.metadata().events.at(-1));event.butlerNoReplySource.payload={reason:'forged-reason',text:'SYNTHETIC PRIVATE CANARY'};
 const source=storedQueueSource('shared',event);assert.equal(source.payload.reason,'source-invalid');assert.ok(!JSON.stringify(source).includes('CANARY'));
});
test('C: a legacy no-reply parent without auxiliary data is never backfilled',t=>{
 const f=fixture(t);f.room.onButlerReady=()=>{};f.settle();const events=structuredClone(f.room.metadata().events);delete events.at(-1).butlerNoReplySource;
 f.room.update({events});const restored=f.restart();restored.recover();assert.equal(restored.ledger.snapshot().events.length,0);
});
test('C: restart must not manufacture quota from a changed auxiliary record when first notification failed',t=>{
 const f=fixture(t);f.room.onButlerReady=()=>{throw Error('Synthetic notifier failure');};f.settle();assert.equal(f.events().length,0);
 const events=structuredClone(f.room.metadata().events);events.at(-1).butlerNoReplySource.quota={nativeId:'unrelated-native',turnId:'invented-quota-turn'};
 f.room.update({events});const restored=f.restart();restored.recover();const recorded=restored.ledger.snapshot().events;
 console.log('RESTART actual '+JSON.stringify(recorded.map(e=>({kind:e.kind,payload:e.payload}))));
 assert.equal(recorded.length,1);assert.equal(recorded[0].payload.reason,'source-invalid');
});
test('complete settlement data cannot be copied onto a fresh parent ID', t => {
  const f = fixture(t); f.settle();
  const original = structuredClone(f.room.metadata().events.at(-1)), copied = { ...original }; delete copied.id;
  f.room.update({}, copied);
  const other = f.room.metadata().events.at(-1); assert.notEqual(other.id, original.id);
  assert.equal(storedQueueSource('shared', other).payload.reason, 'source-invalid');
});
for (const change of ['status', 'reason', 'dispatch-native', 'dispatch-time', 'dispatch-tag', 'dispatch-control', 'quota-kind', 'quota-observed'])
test('the full settlement fact is fixed: ' + change, t => {
  const f = fixture(t); quota(f); f.settle();
  const event = structuredClone(f.room.metadata().events.at(-1)); assert.ok(event.queueSettlement);
  const fact = event.queueSettlement;
  if (change === 'status') fact.status = 'sent';
  if (change === 'reason') fact.reason = 'person-intervened';
  if (change === 'dispatch-native') fact.dispatch.nativeId = 'other-native';
  if (change === 'dispatch-time') fact.dispatch.sentAt++;
  if (change === 'dispatch-tag') fact.dispatch.tag = 'another-dispatch';
  if (change === 'dispatch-control') fact.dispatch.control = 2;
  if (change === 'quota-kind') fact.quota.kind = 'other';
  if (change === 'quota-observed') fact.quota.observedAt++;
  assert.equal(storedQueueSource('shared', event).payload.reason, 'source-invalid');
});
for (const hasQuota of [false, true]) test('the frozen settlement survives task trimming, quota=' + hasQuota, t => {
  const f = fixture(t); if (hasQuota) quota(f);
  f.room.onButlerReady = () => {}; f.settle(); f.room.update({ queue: [] });
  const restored = f.restart(); restored.recover();
  const events = restored.ledger.snapshot().events; assert.equal(events.length, 1);
  assert.equal(events[0].payload.reason, hasQuota ? 'codex-usage-limit-exceeded' : 'no-reply-unconfirmed');
  const bytes = fs.readFileSync(restored.ledger.file); f.restart().recover();
  assert.deepEqual(fs.readFileSync(restored.ledger.file), bytes);
});
