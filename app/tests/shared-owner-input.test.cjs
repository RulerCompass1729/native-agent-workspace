// Existing Workspace methods with a synthetic transport: no providers or GUI.
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Workspace}=require('../workspace.cjs');
async function fixture(t,mode){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'naw-space-owner-'));let runtime,release,entered;
 const waiting=new Promise(r=>{entered=r}),calls=[];
 const host={binaries:{},close(){},create(s){s.nativeId='synthetic-original';runtime=new EventEmitter();runtime.start=async()=>runtime.emit('state','idle');runtime.finishTurn=()=>{};
  const deliver=async(text,tag,valid)=>{calls.push({text,tag,valid});if(runtime.hold){entered();await new Promise(r=>{release=r})}if(!valid())throw Object.assign(Error('Control changed before delivery'),{notSent:true});runtime.emit('submitted',tag)};
  runtime.send=deliver;runtime.queue=deliver;runtime.steer=(text,tag,turn,valid)=>deliver(text,tag,valid);return runtime;}};
 const w=new Workspace(host,directory);t.after(()=>{w.close();fs.rmSync(directory,{recursive:true,force:true})});
 const id=await w.create(mode==='queue'?'claude':'codex',directory,'private-owner','Synthetic owner','terminal');w.join(id,true);w.setDraft(id,'POSITIVE PRIVATE DRAFT','private-owner');
 const s=w.get(id);runtime.turnId='active';runtime.steerAvailable=runtime.queueAvailable=true;if(mode!=='forward')s.state='working';
 const act=(owner,shared=true)=>mode==='forward'?w.forward(id,'EXPLICIT SHARED BODY',owner):mode==='queue'?w.queue(id,'EXPLICIT SHARED BODY',owner,shared?{}:null):w.steer(id,'EXPLICIT SHARED BODY',owner,'active',shared?{}:null);
 return{w,id,s,runtime,calls,act,waiting,release:()=>release()};
}
for(const mode of ['forward','steer','queue'])test(`shared ${mode} from another view retains the native controller and private draft`,async t=>{
 const f=await fixture(t,mode);await f.act('space-view');assert.equal(f.calls.length,1);assert.equal(f.s.owner,'private-owner');assert.equal(f.s.view,'terminal');assert.equal(f.s.nativeId,'synthetic-original');assert.equal(f.w.drafts.get(f.id),'POSITIVE PRIVATE DRAFT');assert.equal(f.w.room.messages.filter(m=>m.text==='EXPLICIT SHARED BODY').length,1);
});
for(const mode of ['steer','queue'])test(`private ${mode} from another view still requires explicit control`,async t=>{
 const f=await fixture(t,mode);await assert.rejects(f.act('space-view',false));assert.equal(f.calls.length,0);assert.equal(f.s.owner,'private-owner');assert.equal(f.w.drafts.get(f.id),'POSITIVE PRIVATE DRAFT');assert.equal(f.w.room.messages.length,0);
});
for(const mode of ['forward','steer','queue'])test(`a newer human takeover invalidates pending shared ${mode} without reclaiming it`,async t=>{
 const f=await fixture(t,mode);f.runtime.hold=true;const sending=f.act('space-view');const observed=sending.then(()=>null,e=>e);await f.waiting;assert.equal(f.calls[0].valid(),true);f.w.claim(f.id,'newer-human','terminal');assert.equal(f.calls[0].valid(),false);f.release();assert.ok(await observed);assert.equal(f.s.owner,'newer-human');assert.equal(f.w.drafts.get(f.id),'POSITIVE PRIVATE DRAFT');assert.ok(f.w.room.messages.every(m=>m.status!=='submitted'));
});
