const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {fixture,ROOT}=require('./fixtures/quota-turn.cjs');
const text='Synthetic progress only\nREADY lane/synthetic aabbccdd';
for(const legacy of [false,true])test('a quota-failed turn cannot finish a queued item, legacy purpose='+legacy,async t=>{
 const f=await fixture(t);if(legacy)delete f.s.messages.find(m=>m.id===f.tag).dispatchPurpose;
 f.drive({partial:true,text});const original=f.s.messages.find(m=>m.role==='assistant');
 assert.equal(original.inputTag,f.tag);assert.equal(original.turnId,'work-turn');
 assert.ok(f.s.messages.some(m=>m.kind==='turn'&&m.status==='failed'&&m.turnId===original.turnId&&m.nativeId===original.nativeId));
 const a=f.settle();assert.equal(a.status,'waiting');assert.equal(a.reason,'usage-limit-exceeded');
 assert.equal(f.room.queueFind('shared',f.itemId).status,'waiting');
 for(const key of ['ready','reportTitle','reply'])assert.equal(a[key],undefined);
 assert.equal(original.text,text);assert.equal(original.status,'complete');assert.equal(f.s.messages.find(m=>m.id===f.tag).status,'submitted');
 assert.equal(f.events().length,1);assert.equal(f.calls.length,1);
});
test('a confirmed failed non-quota turn has a fixed failure reason without interpreting its prose',async t=>{
 const f=await fixture(t);f.drive({partial:true,typed:false,text});const a=f.settle();
 assert.equal(a.status,'waiting');assert.equal(a.reason,'native-turn-failed');assert.equal(a.ready,undefined);assert.equal(a.reply,undefined);
});
for(const change of ['other-turn','other-native','other-tag','no-boundary'])test('unrelated or missing failure proof leaves existing completion behavior unchanged: '+change,async t=>{
 const f=await fixture(t);f.drive({partial:true,text});const boundary=f.s.messages.find(m=>m.kind==='turn');
 if(change==='other-turn')boundary.turnId='other-turn';
 if(change==='other-native')boundary.nativeId='22222222-2222-4222-8222-222222222222';
 if(change==='other-tag'){boundary.inputTag='other-tag';for(const m of f.s.messages)if(m.role==='assistant')m.inputTag='other-tag';}
 if(change==='no-boundary')f.s.messages=f.s.messages.filter(m=>m.kind!=='turn');
 const a=f.settle();if(change==='other-tag')assert.notEqual(a.status,'done');else assert.equal(a.status,'done');
});
test('normal successful native completion retains done and the READY receipt',async t=>{
 const f=await fixture(t);f.drive({partial:true,success:true,text});const a=f.settle();assert.equal(a.status,'done');assert.ok(a.ready);assert.equal(f.calls.length,1);
});
test('a quota error without final turn proof remains sent and never resubmits',async t=>{
 const f=await fixture(t);f.frame('turn/started',{turn:{id:'work-turn'}});f.frame('error',{turnId:'work-turn',error:{codex_error_info:'usage_limit_exceeded',message:'Synthetic quota'},willRetry:false});
 assert.ok(!f.plan().some(a=>a.kind==='settle'));assert.equal(f.room.queueFind('shared',f.itemId).status,'sent');assert.equal(f.calls.length,1);
});
test('queue failure reasons resolve to visible bilingual text through the existing reason mapper',()=>{
 const source=fs.readFileSync(path.join(ROOT,'app/renderer/renderer.js'),'utf8'),start=source.indexOf('const QUEUE_REASONS ='),end=source.indexOf('// What came back',start);
 const ctx={};vm.runInNewContext(source.slice(start,end)+';this.key=queueReasonKey;',ctx);
 const locale=require(path.join(ROOT,'app/ui-locale.js'));
 for(const reason of ['usage-limit-exceeded','native-turn-failed']){const key=ctx.key(reason);assert.ok(key);for(const language of ['zh','en'])assert.notEqual(locale.format(language,key),key);}
});
test('rotation and integrator callers without a queue expectation keep the existing helper contract',async t=>{
 const f=await fixture(t);f.drive({partial:true,text});
 const reply=f.M.rules.replyAfter(f.snapshot(),f.tag,f.room.queueFind('shared',f.itemId).sentAt);
 assert.equal(reply.last,text);assert.equal(reply.failedTurnIds,undefined);
});
