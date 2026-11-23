const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {fork}=require('node:child_process');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'naw-e-resume-binding-'));fs.chmodSync(root,0o700);fs.mkdirSync(path.join(root,'profile'),{mode:0o700});const children=[];
 t.after(async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill();await new Promise(r=>child.once('exit',r));}fs.rmSync(root,{recursive:true,force:true});});
 function start(){
  const child=fork(path.join(__dirname,'fixtures/mobile-pairing-passkey-process.cjs'),[],{stdio:['ignore','pipe','pipe','ipc'],env:{...process.env}});children.push(child);child.stdout.resume();child.stderr.resume();const pending=new Map();let seq=0;
  const exited=new Promise(r=>child.once('exit',r));child.on('message',v=>pending.get(v.id)?.(v));
  const call=value=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{child.kill();reject(Error('Owned recovery process deadline'));},5000);pending.set(id,result=>{pending.delete(id);clearTimeout(timer);resolve(result);});child.send({...value,id});});
  return {call,pid:child.pid,stop:async()=>{assert.equal((await call({command:'quit'})).ok,true);assert.equal(await exited,0);}};
 }
 return {root,start};
}
async function pair(f,change){const first=f.start(),initial=await first.call({command:'init',root:f.root,mode:'pair',change,deadline:Date.now()+120000});assert.equal(initial.ok,true);assert.equal((await first.call({command:'activate',mode:'basic'})).ok,true);await first.stop();return {...initial.value,pid:first.pid};}
for(const entry of ['manual','boot','broker']){
 test(entry+': exact shared-host trust survives a real process exit without changing the original actions',async t=>{
  const f=fixture(t),first=await pair(f),next=f.start();assert.notEqual(next.pid,first.pid);
  const result=await next.call({command:'init',root:f.root,mode:'resume',entry,token:first.token});assert.equal(result.ok,true);
  assert.deepEqual(result.value.session.sessions.map(s=>s.actions),[['read','send','answer']]);assert.equal(result.nativeCalls,0);assert.equal(result.executions,0);await next.stop();
 });
 for(const change of ['user-id','new-service','null-receipt','unknown-receipt'])test(entry+': changed or unproven saved binding refuses recovery after exit: '+change,async t=>{
  const f=fixture(t),first=await pair(f,change),next=f.start();assert.notEqual(next.pid,first.pid);
  const result=await next.call({command:'init',root:f.root,mode:'resume',entry,change,token:first.token});assert.equal(result.ok,false,'A shared-host checkbox cannot expand saved trust');assert.equal(result.nativeCalls,0);assert.equal(result.executions,0);await next.stop();
 });
}
