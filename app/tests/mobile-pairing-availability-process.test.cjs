const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{fork}=require('node:child_process');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'naw-pairing-fallback-process-'));fs.chmodSync(root,0o700);fs.mkdirSync(path.join(root,'profile'),{mode:0o700});const children=[];
 t.after(async()=>{for(const c of children)if(c.exitCode===null){c.kill();await new Promise(r=>c.once('exit',r));}fs.rmSync(root,{recursive:true,force:true});});
 function start(){const c=fork(path.join(__dirname,'fixtures/mobile-pairing-passkey-process.cjs'),[],{stdio:['ignore','pipe','pipe','ipc']});children.push(c);c.stdout.resume();c.stderr.resume();let pending;const exited=new Promise(r=>c.once('exit',r));
  c.on('message',v=>pending?.(v));return {pid:c.pid,call:input=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{c.kill();reject(Error('Owned fallback deadline'));},5000);pending=v=>{clearTimeout(timer);pending=null;resolve(v);};c.send({root,asynchronous:true,deadline:Date.now()+120000,...input});}),stop:async(pause=true)=>{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{c.kill();reject(Error('Owned shutdown deadline'));},5000);pending=v=>{clearTimeout(timer);pending=null;resolve(v);};c.send({command:pause?'quit':'exitWithoutPause'});});assert.equal(await exited,0);}};
 }
 return {root,start};
}
for(const fault of ['putFails','getFails','healthy'])test('actual process exit/restart: '+fault,async t=>{
 const f=fixture(t),first=f.start(),initial=await first.call({command:'init',mode:'pair',...(fault==='healthy'?{}:{[fault]:true})});assert.equal(initial.ok,true);
 assert.equal((await first.call({command:'activate',mode:'basic'})).ok,true);const s=await first.call({command:'pairingStatus'});assert.equal(s.value.paired,true);assert.equal(s.value.temporaryPairing===true,fault!=='healthy');
 assert.equal((await first.call({command:'read'})).ok,true);await first.stop();
 const next=f.start();assert.notEqual(first.pid,next.pid);const restored=await next.call({command:'init',mode:'resume',token:initial.value.token});assert.equal(restored.ok,fault==='healthy');await next.stop();
});

test('an unknown active write cannot restore after an actual exit without pause',async t=>{
 const f=fixture(t),first=f.start(),initial=await first.call({command:'init',mode:'pair',unknownActivePut:true});assert.equal(initial.ok,true);
 assert.equal((await first.call({command:'activate',mode:'basic'})).ok,true);assert.equal((await first.call({command:'pairingStatus'})).value.temporaryPairing,true);
 assert.equal((await first.call({command:'read'})).ok,true);await first.stop(false);
 const next=f.start(),restored=await next.call({command:'init',mode:'resume',token:initial.value.token});assert.equal(restored.ok,false);await next.stop();
});
