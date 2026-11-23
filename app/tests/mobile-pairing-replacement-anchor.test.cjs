'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{fork}=require('node:child_process');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'naw-pairing-anchor-'));fs.chmodSync(root,0o700);const profile=path.join(root,'profile');fs.mkdirSync(profile,{mode:0o700});const children=[];
 t.after(async()=>{for(const c of children)if(c.exitCode===null&&c.signalCode===null){c.kill();await new Promise(r=>c.once('exit',r));}fs.rmSync(root,{recursive:true,force:true});});
 function start(){
  const c=fork(path.join(__dirname,'fixtures/mobile-pairing-passkey-process.cjs'),[],{stdio:['ignore','pipe','pipe','ipc']});children.push(c);c.stdout.resume();c.stderr.resume();let pending;const exited=new Promise(r=>c.once('exit',r));c.on('message',v=>pending?.(v));
  const call=input=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{c.kill();reject(Error('Owned replacement deadline'));},5000);pending=v=>{clearTimeout(timer);pending=null;resolve(v);};c.send({root,asynchronous:true,deadline:Date.now()+120000,...input});});
  return {pid:c.pid,call,stop:async()=>{assert.equal((await call({command:'exitWithoutPause'})).ok,true);assert.equal(await exited,0);}};
 }
 const backup=()=>fs.readFileSync(path.join(profile,'mobile-authority.json'));
 function replay(bytes){fs.writeFileSync(path.join(profile,'mobile-authority.json'),bytes,{mode:0o600});for(const name of ['mobile-recovery-pending','mobile-disabled'])try{fs.unlinkSync(path.join(profile,name));}catch(e){if(e.code!=='ENOENT')throw e;}}
 return {root,start,backup,replay,fault:mode=>fs.writeFileSync(path.join(root,'fail-put.json'),JSON.stringify({mode}),{mode:0o600}),healthy:()=>fs.unlinkSync(path.join(root,'fail-put.json'))};
}
async function seed(f){const a=f.start(),initial=await a.call({command:'init',mode:'pair'});assert.equal(initial.ok,true);assert.equal((await a.call({command:'activate',mode:'basic'})).ok,true);return {a,token:initial.value.token};}
for(const entry of ['candidate','selected'])test(entry+': failed retirement refuses replacement, retains only A, and a later completed replacement rejects an old backup',async t=>{
 const f=fixture(t),{a,token}=await seed(f),before=f.backup();f.fault('all');
 const attempt=await a.call({command:'replace',entry});assert.equal(attempt.ok,true);
 assert.equal(attempt.value.activated,false,'An unretired durable anchor cannot be reported replaced');assert.equal(attempt.value.errorCode,'MOBILE_STORAGE');assert.equal(attempt.value.oldAccepted,true);assert.equal(attempt.value.newAccepted,false);
 await a.stop();f.replay(before);f.healthy();const b=f.start();assert.notEqual(a.pid,b.pid);assert.equal((await b.call({command:'init',mode:'resume',token})).ok,true,'A remains valid because replacement was explicitly refused');
 assert.equal((await b.call({command:'replace',entry})).value.activated,true);await b.stop();f.replay(before);const c=f.start();assert.equal((await c.call({command:'init',mode:'resume',token})).ok,false);await c.stop();
});
for(const entry of ['candidate','selected'])test(entry+': completed process-only replacement has a durable disabled anchor before accepting B; profile replay cannot revive A',async t=>{
 const f=fixture(t),{a,token}=await seed(f),before=f.backup();f.fault('enabled');
 const attempt=await a.call({command:'replace',entry});assert.equal(attempt.ok,true);assert.deepEqual(attempt.value,{activated:true,oldAccepted:false,newAccepted:true,errorCode:null,temporaryPairing:true});
 const anchor=JSON.parse(fs.readFileSync(path.join(f.root,'fake-keychain.json')));assert.equal(anchor.authority.enabled,false,'Old authority must already be retired outside the profile');
 await a.stop();f.replay(before);f.healthy();const b=f.start();assert.notEqual(a.pid,b.pid);assert.equal((await b.call({command:'init',mode:'resume',token})).ok,false);await b.stop();
});

test('an unreadable prior anchor is not silently replaced by a temporary pairing after a fresh process starts',async t=>{
 const f=fixture(t),{a,token}=await seed(f),before=f.backup();await a.stop();
 const b=f.start();assert.equal((await b.call({command:'init',mode:'pair',getFails:true})).ok,false,'Existing profile plus unknown external anchor requires confirmed retirement');await b.stop();
 f.replay(before);const c=f.start();assert.equal((await c.call({command:'init',mode:'resume',token})).ok,true,'The refused attempt did not claim to revoke A');await c.stop();
});
test('a fresh-process replacement also retires its known previous anchor before a process-only grant',async t=>{
 const f=fixture(t),{a,token}=await seed(f),before=f.backup();await a.stop();f.fault('all');
 const b=f.start();assert.equal((await b.call({command:'init',mode:'pair'})).ok,false);await b.stop();
 f.replay(before);f.healthy();const c=f.start();assert.equal((await c.call({command:'init',mode:'resume',token})).ok,true);await c.stop();
});
