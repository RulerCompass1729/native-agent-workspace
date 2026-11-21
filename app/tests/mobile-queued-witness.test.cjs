const test=require('node:test'),assert=require('node:assert/strict');
const {createMobileClient}=require('../mobile-web/client.js');
test('failed explicit lookup invalidates a former queued witness while retaining the original',async()=>{
 const deviceId='10000000-0000-4000-8000-000000000001',id='20000000-0000-4000-8000-000000000001',disk=new Map(),calls=[];let unavailable=false;
 const client=createMobileClient({newId:()=>id,storage:{getItem:k=>disk.get(k),setItem:(k,v)=>disk.set(k,v)},request:async(url,value)=>{
  calls.push(url);
  if(url==='/mobile/session')return {deviceId,csrf:'c'.repeat(43),sessions:[{id:'a',actions:['read','send']}]};
  if(url==='/mobile/read/a')return {id:'a',contextId:'x'.repeat(43),canSend:true};
  if(url==='/mobile/receipt'&&unavailable)throw Object.assign(Error('Synthetic 503'),{code:'MOBILE_QUEUE_UNAVAILABLE'});
  return {requestId:id,sessionId:'a',action:'send',status:'awaiting-native',queued:true};
 }});
 await client.start();await client.select('a');client.setDraft('Synthetic original input');await client.send();
 assert.equal(client.state.pending[0].queued,true,'positive control: actual prior response proves queued');
 unavailable=true;await client.receipt(id);
 assert.equal(calls.filter(x=>x==='/mobile/send').length,1);assert.equal(client.state.pending.length,1);assert.equal(client.state.draft,'Synthetic original input');
 assert.notEqual(client.state.pending[0].queued,true,'unavailable current proof must not remain an affirmative queued claim');
});
async function queuedFixture(){
 const id='20000000-0000-4000-8000-000000000001',calls=[],disk=new Map();let failure=false,bad=false,status='awaiting-native',held=null,storageFailure=false,device='10000000-0000-4000-8000-000000000001';
 const storage={getItem:k=>disk.get(k),setItem:(k,v)=>{if(storageFailure)throw Error('Synthetic storage refusal');disk.set(k,v);}};
 const client=createMobileClient({newId:()=>id,storage,request:async(url,value)=>{
  calls.push({url,value});if(url==='/mobile/session')return {deviceId:device,csrf:'c'.repeat(43),sessions:['a','b'].map(id=>({id,nativeId:'native-'+id,actions:['read','send']}))};
  if(url.startsWith('/mobile/read/'))return {id:url.split('/').at(-1),contextId:'x'.repeat(43),canSend:true};
  if(url==='/mobile/receipt'){if(held)return held;if(failure)throw Object.assign(Error('Synthetic 503'),{code:'MOBILE_QUEUE_UNAVAILABLE'});}
  return {requestId:bad?'20000000-0000-4000-8000-000000000099':id,sessionId:'a',action:'send',status,queued:status==='awaiting-native'};
 }});
 await client.start();await client.select('a');client.setDraft('Synthetic original input');await client.send();assert.equal(client.state.pending[0].queued,true);
 return {client,id,calls,disk,storage,fail:()=>failure=true,bad:()=>bad=true,status:value=>{failure=false;bad=false;status=value;},storageFail:()=>storageFailure=true,
  hold:promise=>held=promise,device:value=>device=value};
}
for(const route of ['explicit','refresh'])test('a failed '+route+' receipt lookup invalidates only the witness and retains input identity',async()=>{
 const f=await queuedFixture(),original=structuredClone(f.client.state.pending[0]);f.fail();
 if(route==='explicit')await f.client.receipt(f.id);else await f.client.refresh();
 const pending=f.client.state.pending[0];assert.equal(pending.queued,false);assert.equal(pending.status,'unconfirmed');
 for(const key of ['deviceId','sessionId','requestId','action','text','revision','context','createdAt'])assert.deepEqual(pending[key],original[key],key);
 assert.equal(f.client.state.draft,'Synthetic original input');assert.equal(f.calls.filter(c=>c.url==='/mobile/send').length,1);
 await assert.rejects(f.client.send());assert.equal(f.calls.filter(c=>c.url==='/mobile/send').length,1);
});
test('a mismatched receipt cannot preserve the old affirmative queued witness',async()=>{
 const f=await queuedFixture();f.bad();await f.client.receipt(f.id);assert.equal(f.client.state.pending[0].queued,false);assert.equal(f.client.state.pending[0].status,'unconfirmed');
 assert.equal(f.client.state.pending[0].requestId,f.id);
});
test('a fresh valid witness can confirm queued again and later settle without a second send',async()=>{
 const f=await queuedFixture();f.fail();await f.client.receipt(f.id);assert.equal(f.client.state.pending[0].status,'unconfirmed');
 f.status('awaiting-native');await f.client.receipt(f.id);assert.equal(f.client.state.pending[0].queued,true);
 f.status('submitted');await f.client.receipt(f.id);assert.equal(f.client.state.pending[0].status,'submitted');assert.equal(f.client.state.draft,'');
 assert.equal(f.calls.filter(c=>c.url==='/mobile/send').length,1);
});
test('a terminal delivery fact is never downgraded by a later query failure',async()=>{
 const f=await queuedFixture();f.status('submitted');await f.client.receipt(f.id);f.fail();await f.client.receipt(f.id);
 assert.equal(f.client.state.pending[0].status,'submitted');assert.equal(f.client.state.pending[0].queued,false);
});
test('a late failed lookup across pairing generations cannot touch the new draft',async()=>{
 const f=await queuedFixture();let reject;f.hold(new Promise((_,r)=>reject=r));const pending=f.client.receipt(f.id),old=structuredClone(f.client.state.pending[0]);
 f.device('10000000-0000-4000-8000-000000000002');await f.client.start();await f.client.select('b');f.client.setDraft('New device draft');reject(Error('Synthetic late 503'));await pending;
 assert.equal(f.client.state.draft,'New device draft');assert.equal(f.client.state.selected,'b');assert.deepEqual(f.client.state.pending[0],old);
 assert.equal(f.calls.filter(c=>c.url==='/mobile/send').length,1);
});
test('witness invalidation keeps a storage error visible and pauses sending',async()=>{
 const f=await queuedFixture();f.storageFail();f.fail();await f.client.receipt(f.id);
 assert.equal(f.client.state.pending[0].queued,false);assert.equal(f.client.state.storageError,true);assert.match(f.client.state.notice,/草稿未能保存/);
 assert.equal(f.client.state.draft,'Synthetic original input');assert.equal(f.client.state.pending.length,1);
});
