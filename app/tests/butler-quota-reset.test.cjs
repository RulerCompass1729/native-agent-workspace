const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),crypto=require('node:crypto');
const {fixture,stewardRead,RESET}=require('./fixtures/quota-turn.cjs');
const {ButlerIngress,noReplyContext,storedQueueSource}=require('../butler-ingress.cjs');
const {RoomState}=require('../room-state.cjs');
const {validateEvent}=require('../butler-policy.cjs');
const ISO=new Date(RESET*1000).toISOString();
const quotaEvent=f=>({eventId:'codex-quota:'+crypto.createHash('sha256').update(JSON.stringify([f.s.id,f.s.nativeId,'work-turn'])).digest('hex'),sourceRef:'codex-quota:'+f.s.id,kind:'blocked',payload:{memberId:f.s.id,reason:'codex-usage-limit-exceeded'}});
test('a verified reset reaches stewardEvents as canonical ISO without copying the error body',async t=>{
 const f=await fixture(t);f.drive();const read=await stewardRead(f);
 assert.deepEqual(read.events[0].payload,{memberId:f.s.id,reason:'codex-usage-limit-exceeded',resetsAt:ISO});
 assert.equal(f.snapshot().nativeQuota.resetsAt,RESET);assert.equal(f.calls.length,1);
});
test('no-reply recovery freezes the same reset and stays identical to a live quota source',async t=>{
 const f=await fixture(t);f.drive();f.settle();assert.equal(f.events().length,1);assert.equal(f.events()[0].payload.resetsAt,ISO);
 const fact=f.room.metadata().events.at(-1).queueSettlement;assert.equal(fact.quota.resetsAt,RESET);
 const bytes=fs.readFileSync(f.ingress.ledger.file);f.ingress.recover();assert.deepEqual(fs.readFileSync(f.ingress.ledger.file),bytes);
});
test('a failed first notification recovers the frozen reset after current quota and task metadata are gone',async t=>{
 const f=await fixture(t);f.w.removeAllListeners('change');f.room.onButlerReady=()=>{};f.drive();f.settle();assert.equal(f.events().length,0);
 delete f.s.nativeQuota;f.room.update({queue:[]});const restored=new ButlerIngress(f.dir,{roomState:new RoomState(f.dir)});restored.recover();
 assert.equal(restored.ledger.eventsAfter(null).events[0].payload.resetsAt,ISO);
 const bytes=fs.readFileSync(restored.ledger.file);restored.recover();assert.deepEqual(fs.readFileSync(restored.ledger.file),bytes);
});
test('prose alone keeps reset unverified and creates no timer',async t=>{
 const f=await fixture(t);f.drive({structured:false});assert.equal(f.snapshot().nativeQuota.resetsAt,undefined);
 assert.deepEqual(f.events()[0].payload,{memberId:f.s.id,reason:'codex-usage-limit-exceeded'});assert.equal(f.w.capacityRecoveries.size,0);
});
for(const reset of [-1,'tomorrow',Infinity,8640000000001])test('invalid persisted reset is not promoted: '+String(reset),async t=>{
 const f=await fixture(t);f.w.removeAllListeners('change');f.drive();f.s.nativeQuota.resetsAt=reset;
 f.ingress.observeRecoveryFailures([f.snapshot()]);assert.equal(f.events()[0].payload.resetsAt,undefined);
});
test('conflicting native reset aliases remain unverified',async t=>{
 const f=await fixture(t);f.frame('turn/started',{turn:{id:'work-turn'}});f.frame('error',{turnId:'work-turn',error:{codex_error_info:'usage_limit_exceeded',resetsAt:RESET,resets_at:RESET+1},willRetry:false});
 assert.equal(f.snapshot().nativeQuota.resetsAt,undefined);assert.equal(f.events()[0].payload.resetsAt,undefined);
});
test('the payload whitelist adds only one canonical ISO field',async t=>{
 const f=await fixture(t),event=quotaEvent(f);event.payload.resetsAt=ISO;
 assert.equal(validateEvent(event).payload.resetsAt,ISO);f.ingress.ledger.ingest(event);assert.equal(f.events()[0].payload.resetsAt,ISO);
 for(const reset of ['tomorrow','2026-11-22','1969-01-01T00:00:00.000Z',RESET,ISO+'x']){
  const invalid={...event,eventId:'invalid-'+String(reset),payload:{...event.payload,resetsAt:reset}};
  assert.throws(()=>validateEvent(invalid));assert.throws(()=>f.ingress.ledger.ingest(invalid));
 }
 assert.throws(()=>validateEvent({...event,payload:{...event.payload,resetReason:'not-allowed'}}));
});
test('changing a frozen reset rejects its source even if an invalid value has a matching new hash',async t=>{
 const f=await fixture(t);f.drive();f.settle();const event=structuredClone(f.room.metadata().events.at(-1));
 event.queueSettlement.quota.resetsAt++;assert.equal(storedQueueSource('shared',event).payload.reason,'source-invalid');
 event.queueSettlement.quota.resetsAt=-1;event.butlerNoReplySource=noReplyContext(event.queueSettlement);
 assert.equal(storedQueueSource('shared',event).payload.reason,'source-invalid');
});
test('old facts without reset keep their original hash and restart behavior',async t=>{
 const f=await fixture(t);f.drive({structured:false});f.settle();const event=f.room.metadata().events.at(-1),x=event.queueSettlement,d=x.dispatch,q=x.quota;
 const expected=crypto.createHash('sha256').update(JSON.stringify([x.roomId,x.eventId,x.itemId,x.memberId,[d.nativeId,d.sentAt,d.tag,d.control],x.status,x.reason,q&&[q.provider,q.kind,q.nativeId,q.turnId,q.observedAt]])).digest('hex');
 assert.equal(event.butlerNoReplySource.factHash,expected);f.ingress.recover();assert.equal(f.events().length,1);assert.equal(f.events()[0].payload.resetsAt,undefined);
});
test('an existing legacy quota event is not rewritten or duplicated when a reset becomes available',async t=>{
 const f=await fixture(t);f.ingress.record(quotaEvent(f));const before=fs.readFileSync(f.ingress.ledger.file);
 f.drive();f.settle();f.ingress.recover();assert.equal(f.events().length,1);assert.equal(f.events()[0].payload.resetsAt,undefined);
 assert.deepEqual(fs.readFileSync(f.ingress.ledger.file),before);assert.equal(f.ingress.status().intake,'ready');
});
test('a contradictory reset cannot overwrite a new-format event',async t=>{
 const f=await fixture(t);f.drive();const original=f.events()[0].payload.resetsAt;f.s.nativeQuota.resetsAt=RESET+1;
 assert.throws(()=>f.ingress.observeRecoveryFailures([f.snapshot()]));assert.equal(f.events().length,1);assert.equal(f.events()[0].payload.resetsAt,original);
});
