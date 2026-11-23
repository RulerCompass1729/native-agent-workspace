const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {fork}=require('node:child_process'),{SESSION_MS}=require('../mobile-access.cjs');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'naw-e-pairing-restart-'));fs.chmodSync(root,0o700);fs.mkdirSync(path.join(root,'profile'),{mode:0o700});t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const run=input=>new Promise((resolve,reject)=>{
  const child=fork(path.join(__dirname,'fixtures/mobile-pairing-process.cjs'),[],{stdio:['ignore','pipe','pipe','ipc'],env:{...process.env}});let value;
  const timeout=setTimeout(()=>{child.kill();reject(Error('Owned process deadline'));},5000);
  child.stdout.resume();child.stderr.resume();child.once('error',reject);child.on('message',v=>{value=v;});child.once('exit',code=>{clearTimeout(timeout);resolve({code,value});});child.send({root,...input});
 });
 return {root,run};
}
test('a completed shared-host pairing survives an actual exit, invalidating old tickets and pending QR challenges',async t=>{
 const f=fixture(t),first=await f.run({mode:'pair'});assert.equal(first.code,0);
 const next=await f.run({mode:'resume',token:first.value.token,oldTicket:first.value.ticket,oldChallenge:first.value.oldChallenge});
 assert.equal(next.code,0);assert.notEqual(first.value.issuer.pid,next.value.issuer.pid);assert.equal(next.value.device,first.value.device);assert.equal(next.value.until,first.value.until);
 assert.equal(next.value.oldTicketDenied,true);assert.equal(next.value.oldChallengeDenied,true);
});
for(const change of ['actor','user-id','origin','mapping','new-service','funnel','unknown','expiry'])test('a fresh process refuses changed or expired recovery: '+change,async t=>{
 const f=fixture(t),first=await f.run({mode:'pair'});assert.equal(first.code,0);
 const next=await f.run({mode:'resume',token:first.value.token,change,advance:change==='expiry'?SESSION_MS+1000:0});
 assert.equal(next.code,1);assert.equal(next.value.ok,false);
});
test('a fresh process still recovers the pairing past the former twelve hours, with its original end',async t=>{
 const f=fixture(t),first=await f.run({mode:'pair'});assert.equal(first.code,0);
 const next=await f.run({mode:'resume',token:first.value.token,advance:3*24*3600000});
 assert.equal(next.code,0);assert.equal(next.value.device,first.value.device);assert.equal(next.value.until,first.value.until);
 assert.equal((await f.run({mode:'resume',token:first.value.token,advance:SESSION_MS-60000})).code,0);
 assert.equal((await f.run({mode:'resume',token:first.value.token,advance:SESSION_MS+1000})).code,1);
});
test('replacement and explicit revoke remain effective after separate process exits',async t=>{
 const f=fixture(t),first=await f.run({mode:'pair'});assert.equal(first.code,0);
 const changed=await f.run({mode:'replace',token:first.value.token});assert.equal(changed.code,0);assert.notEqual(changed.value.device,first.value.device);
 assert.equal((await f.run({mode:'resume',token:first.value.token})).code,1);
 const current=await f.run({mode:'resume',token:changed.value.token});assert.equal(current.code,0);assert.equal(current.value.device,changed.value.device);
 assert.equal((await f.run({mode:'revoke',token:changed.value.token})).code,0);
 assert.equal((await f.run({mode:'resume',token:changed.value.token})).code,1);
});
