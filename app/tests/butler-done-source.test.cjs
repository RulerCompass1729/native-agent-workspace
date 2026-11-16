'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {RoomState}=require('../room-state.cjs');
const {ButlerIngress,bindQueueOutcomes,storedQueueSource}=require('../butler-ingress.cjs');
const {ButlerLedger}=require('../butler-ledger.cjs');
const {queueDoneSource}=require('../butler-ready.cjs');
const rules=require('../queue-dispatch.cjs');
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'naw-done-source-')));fs.chmodSync(root,0o700);
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const room=new RoomState(root),ingress=new ButlerIngress(root,{roomState:room});bindQueueOutcomes(room,ingress,()=>{});
 const item=()=>{const id=room.queueAdd('Synthetic steward task',null,'shared',{kind:'secretary',name:'Steward',sessionId:'steward'},'steward');room.queueMarkSent('shared',id,'member','Member');return id;};
 return {root,room,ingress,item};
}
test('done is durable before notification, replays exactly once after a lost callback, and keeps its cursor across restart',t=>{
 const f=fixture(t),id=f.item();f.room.onButlerReady=()=>{throw Error('Synthetic unavailable intake');};
 f.room.queueSettle('shared',id,'done','','Member','BLOCK. Synthetic report.');
 const before=f.room.metadata().events.filter(e=>e.monitor?.kind==='done');assert.equal(before.length,1);
 assert.equal(f.ingress.ledger.eventsAfter().events.length,0);
 const restored=new RoomState(f.root),ledger=new ButlerLedger(f.root),ingress=new ButlerIngress(f.root,{roomState:restored,ledger});
 ingress.recover();const first=ledger.eventsAfter();assert.equal(first.events.length,1);assert.equal(first.events[0].kind,'done');
 assert.equal(first.events[0].payload.itemId,id);assert.equal(ledger.snapshot().questions.length,0);
 ingress.recover();assert.equal(ledger.eventsAfter().events.length,1);
 assert.throws(()=>ledger.consumeRecorded([ledger.snapshot().events[0].eventId]),/Only rule-handled events/);
 assert.equal(ledger.eventsAfter().events.length,1,'A done report cannot be silently consumed as a rule-only event');
 const again=new ButlerLedger(f.root);assert.deepEqual(again.eventsAfter(first.through),{events:[],through:first.through,more:false});
 assert.throws(()=>restored.queueSettle('shared',id,'done','','Member','Again'));
});
test('historical steward done is not backfilled; a new done and queue-empty remain distinct facts',t=>{
 const f=fixture(t),old=f.item();
 const queue=f.room.queueItems().map(i=>i.id===old?{...i,status:'done',reply:'Existing report',finishedAt:Date.now()}:i);
 f.room.update({queue});f.ingress.recover();assert.equal(f.ingress.ledger.eventsAfter().events.length,0);
 const id=f.item();f.room.queueSettle('shared',id,'done','','Member','PASS');
 const saved=f.room.metadata().events;
 assert.equal(saved.filter(e=>e.monitor?.kind==='done').length,1);assert.equal(saved.filter(e=>e.monitor?.kind==='queue-dry').length,1);
 f.ingress.observeQueues([{roomId:'shared',name:'Synthetic space',active:true,candidateIds:[]}]);
 const got=f.ingress.ledger.eventsAfter().events;
 assert.deepEqual(got.map(e=>e.kind),['done','queue-empty']);assert.equal(got[0].payload.itemId,id);
 f.ingress.recover();f.ingress.observeQueues([{roomId:'shared',name:'Synthetic space',active:true,candidateIds:[]}]);
 assert.equal(f.ingress.ledger.eventsAfter().events.length,2);
});
test('typed done admits only steward completions, projects shared reply fields, and binds stored source identity',t=>{
 const f=fixture(t),id=f.item();
 f.room.queueSettle('shared',id,'done','','Member','PASS Report body',undefined,undefined,'PASS');
 const parent=f.room.metadata().events.find(e=>e.monitor?.kind==='done');
 assert.equal(parent.butlerSource.payload.title,'PASS');
 for(const edit of [e=>e.monitor.addedBy='person',e=>e.monitor.key='done:other:item',e=>e.butlerSource.payload.itemId='other',e=>e.butlerSource.payload.memberId='other',e=>e.text='Changed title',e=>e.butlerSource.payload.private='Unapproved field']){
  const copy=structuredClone(parent);edit(copy);const rejected=storedQueueSource('shared',copy);
  assert.equal(rejected.kind,'blocked');assert.equal(rejected.payload.reason,'source-invalid');assert.equal(Object.hasOwn(rejected.payload,'text'),false);
 }
 const item={id:'typed-item',status:'done',addedBy:'steward',sentTo:'member',reply:'Compact shared report'};
 Object.defineProperty(item,'privateConversation',{get(){throw Error('Private data must not be read');}});
 assert.equal(queueDoneSource('shared',item,'Member','PASS').kind,'done');
 assert.equal(queueDoneSource('shared',{...item,addedBy:undefined},'Member','PASS'),null);
 assert.equal(queueDoneSource('shared',{...item,status:'waiting'},'Member','PASS'),null);
 assert.equal(queueDoneSource('shared',{...item,ready:{branch:'lane/code',commit:'abcdef1'}},'Member','PASS'),null);
 const oversized=queueDoneSource('shared',{...item,reply:'x'.repeat(201)},'Member','PASS');
 assert.equal(oversized.kind,'blocked');assert.equal(oversized.payload.reason,'input-rejected');
 const malformed=structuredClone(parent);malformed.butlerSource.payload.text='x'.repeat(201);
 assert.equal(storedQueueSource('shared',malformed).kind,'blocked');
 const source=queueDoneSource('shared',item,'Member','PASS'),other=queueDoneSource('other-space',item,'Member','PASS');
 assert.notEqual(other.eventId,source.eventId);
 assert.equal(queueDoneSource('shared',{...item,reply:'Updated wording'},'Renamed member','BLOCK').eventId,source.eventId);
});
test('the first reply line is sanitized and bounded before a compact multiline reply loses its boundaries',()=>{
 assert.equal(rules.reportTitle('\u001b[31mBLOCK\u001b[0m\nSecond line stays out of the title'),'BLOCK');
 assert.equal(rules.reportTitle('\n PASS\u2028Second line'),'PASS');
 assert.equal(rules.reportTitle('x'.repeat(500)+'\nOther'), 'x'.repeat(199)+'…');
 assert.equal(rules.reportTitle('PASS\nMore details'),'PASS');
});

test('done retains the live member name when its old dispatch record is no longer retained',t=>{
 const f=fixture(t),id=f.item();
 f.room.update({events:f.room.metadata().events.filter(e=>e.uiMessage?.key!=='notice.queue.dispatched')});
 f.room.queueSettle('shared',id,'done','','Current member','PASS');
 const event=f.ingress.ledger.eventsAfter().events[0];
 assert.equal(event.kind,'done');assert.equal(event.payload.memberId,'member');assert.equal(event.payload.memberName,'Current member');
});
