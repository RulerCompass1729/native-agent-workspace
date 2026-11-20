const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{fork}=require('node:child_process'),{randomUUID}=require('node:crypto');
const {signer}=require('./fixtures/mobile-passkey.cjs');
for(const asynchronous of [false,true])test('a public key survives real broker process exit, while old CSRF/context/challenge and missing UV cannot execute: '+(asynchronous?'asynchronous':'synchronous fixture'),async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'naw-e-passkey-restart-'));fs.chmodSync(root,0o700);fs.mkdirSync(path.join(root,'profile'),{mode:0o700});
 const children=[];
 t.after(async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}fs.rmSync(root,{recursive:true,force:true});});
 function start(){
  const child=fork(path.join(__dirname,'fixtures/mobile-pairing-passkey-process.cjs'),[],{stdio:['ignore','pipe','pipe','ipc'],env:{...process.env}});children.push(child);child.stdout.resume();child.stderr.resume();
  const pending=new Map();let id=0;const exited=new Promise(resolve=>child.once('exit',resolve));
  child.on('message',result=>{const callback=pending.get(result.id);if(callback){pending.delete(result.id);callback(result);}});
  const call=value=>new Promise((resolve,reject)=>{const seq=++id,timer=setTimeout(()=>{child.kill();reject(Error('Owned broker deadline'));},5000);pending.set(seq,result=>{clearTimeout(timer);resolve(result);});child.send({...value,id:seq});});
  return {call,stop:async()=>{assert.equal((await call({command:'quit'})).ok,true);assert.equal(await exited,0);}};
 }
 const deadline=Date.now()+120000,first=start(),key=signer('https://demo.example.ts.net:10000');
 const initial=await first.call({command:'init',root,deadline,mode:'pair',asynchronous});assert.equal(initial.ok,true);
 const registration=(await first.call({command:'registration'})).value;
 const proof=await first.call({command:'register',value:{registrationId:registration.registrationId,credential:key.credential(registration.publicKey)}});assert.equal(proof.ok,true);
 assert.equal((await first.call({command:'proof',value:{registrationId:registration.registrationId,assertion:key.assertion(proof.value.publicKey)}})).ok,true);
 assert.equal((await first.call({command:'activate'})).ok,true);
 const before=(await first.call({command:'session'})).value,oldContext=await first.call({command:'read'}),oldOptions=await first.call({command:'options'});assert.equal(oldContext.ok,true);assert.equal(oldOptions.ok,true);
 await first.stop();
 const second=start(),restored=await second.call({command:'init',root,deadline,mode:'resume',asynchronous,token:initial.value.token});assert.equal(restored.ok,true);
 assert.notEqual(restored.value.pid,initial.value.pid);assert.deepEqual(restored.value.session.consent,{registered:true,enabled:true});
 assert.equal(restored.value.session.expiresAt,before.expiresAt);assert.equal(restored.value.session.csrf!==before.csrf,true);
 const oldCsrf=await second.call({command:'options',csrf:before.csrf});assert.equal(oldCsrf.ok,false);assert.equal(oldCsrf.executions,0);
 const late=await second.call({command:'send',value:{contextId:oldContext.value.contextId,requestId:randomUUID(),text:'Synthetic delayed send'}});assert.equal(late.ok,false);assert.equal(late.nativeCalls,0);
 const stale=await second.call({command:'decide',value:{challengeId:oldOptions.value.challengeId,assertion:key.assertion(oldOptions.value.publicKey)}});assert.equal(stale.ok,false);assert.equal(stale.executions,0);
 const missing=(await second.call({command:'options'})).value,rejected=await second.call({command:'decide',value:{challengeId:missing.challengeId,assertion:key.assertion(missing.publicKey,{flags:1})}});assert.equal(rejected.ok,false);assert.equal(rejected.executions,0);
 const fresh=(await second.call({command:'options'})).value,assertion=key.assertion(fresh.publicKey),accepted=await second.call({command:'decide',value:{challengeId:fresh.challengeId,assertion}});assert.equal(accepted.ok,true);assert.equal(accepted.value.status,'complete');assert.equal(accepted.executions,1);
 const replay=await second.call({command:'decide',value:{challengeId:fresh.challengeId,assertion}});assert.equal(replay.ok,false);assert.equal(replay.executions,1);
 await second.stop();
});
