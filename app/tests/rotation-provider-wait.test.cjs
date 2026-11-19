const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
const { Codex } = require(path.join(root, 'app/adapters.cjs'));
const { RoomState } = require(path.join(root, 'app/room-state.cjs'));
const rules = require(path.join(root, 'app/queue-dispatch.cjs'));
function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'naw-b1-interface-')), calls=[]; let turn=0;
 const host={binaries:{},codexTargets:new Map(),close(){},rpc:{call:async(method,params)=>{calls.push({method,tag:params.clientUserMessageId});return {turn:{id:'turn-'+(++turn)}};}}};
 const w=new Workspace(host,dir), s={id:'member-a',nativeId:'native-a',provider:'codex',model:'model-a',view:'chat',cwd:dir,owner:'window',
  state:'idle',createdAt:Date.now()-60000,messages:[],fleet:[],roomId:'shared',roomIds:['shared'],controlRevision:0,memberRevision:0,
  serviceCapabilities:[rules.CAPABILITY,rules.ROTATION_CAPABILITY]};
 const runtime=new Codex(s,host); runtime.chatAvailable=true;
 w.sessions.set(s.id,s);w.runtimes.set(s.id,runtime);w.bind(s,runtime);s.background=0;s.scheduled=0;
 const client={snapshot:()=>w.snapshot(),refresh:async()=>w.snapshot(),route:()=>({client,state:{capabilities:[rules.CAPABILITY,rules.ROTATION_CAPABILITY]}}),
  call:async(method,...args)=>{if(method==='invalidateRotation')return w.invalidateRotation(...args);if(method==='completeRotation')return w.completeRotation(...args);if(method==='releaseRotation')return w.releaseRotation(...args);throw Error('Unexpected operation '+method);}};
 const dispatcher=new rules.QueueDispatcher({dataDir:dir,roomState:new RoomState(dir),clients:()=>client,now:()=>Date.now(),settleMs:0});dispatcher.client=client;dispatcher.closed=false;
 t.after(()=>{dispatcher.close();w.close();fs.rmSync(dir,{recursive:true,force:true});});
 const notify=(method,params)=>runtime.event({method,params:{threadId:s.nativeId,...params}},host.rpc);
 return {dir,w,s,runtime,calls,dispatcher,client,notify};
}
async function quotaRequest(f, error={codex_error_info:'usage_limit_exceeded'}) {
 const epoch=randomUUID(), requestedAt=Date.now();
 const tag=await f.w.send(f.s.id,'Synthetic original handoff','dispatcher',null,null,null,null,null,null,null,{itemId:'rotation:'+f.s.id,control:{kind:'rotation-request',epoch}});
 const record={phase:'requested',episodeEpoch:epoch,episodeState:'open',requestedAt,tag,oldId:f.s.id,oldNativeId:f.s.nativeId,oldControl:f.s.controlRevision||0,
  provider:'codex',cwd:f.dir,name:'Synthetic member',roomIds:['shared'],view:'chat'};
 f.dispatcher.rotations[f.s.id]=record;
 f.notify('turn/completed',{turn:{id:'turn-1',status:'failed',error}});

 assert.equal(f.s.rotationEpisode.responseTag,undefined);assert.equal(f.s.pendingTag,null);
 return record;
}
test('typed quota on the original handoff enters waiting-provider without seven-day failure or replay',async t=>{
 const f=fixture(t),record=await quotaRequest(f);assert.equal(f.s.rotationEpisode.state,'waiting-provider');
 await f.dispatcher.advanceRotations(f.client.snapshot(),Date.now());assert.equal(record.phase,'waiting-provider');
 assert.equal(record.tag,f.s.rotationEpisode.tag);assert.equal(record.episodeEpoch,f.s.rotationEpisode.epoch);
 assert.equal(record.providerBlock.kind,'usage_limit_exceeded');assert.equal(record.providerBlock.turnId,'turn-1');
 f.dispatcher.pruneRotations(Date.now()+8*86400000);assert.equal(f.dispatcher.rotations[f.s.id],record);
 for(let i=0;i<3;i++)await f.dispatcher.advanceRotations(f.client.snapshot(),Date.now());assert.equal(f.calls.length,1);
});
test('manual successful recovery cannot consume the old control; explicit audited release permits the same native member',async t=>{
 const f=fixture(t),record=await quotaRequest(f);await f.dispatcher.advanceRotations(f.client.snapshot(),Date.now());
 const retryTag=await f.w.send(f.s.id,'Synthetic explicit retry','window');f.notify('turn/completed',{turn:{id:'turn-2',status:'completed'}});
 assert.notEqual(retryTag,record.tag);assert.equal(f.s.nativeQuota,undefined);assert.equal(f.s.rotationEpisode.state,'waiting-provider');
 assert.throws(()=>f.w.completeRotation(f.s.id,f.s.nativeId,record.episodeEpoch,record.tag));
 assert.equal(rules.sessionReady(f.w.snapshot().sessions[0],{enabled:true}).reason,'waiting-provider');
 await f.dispatcher.releaseRotation(f.s.id,f.s.nativeId,record.episodeEpoch,record.tag,{kind:'steward',id:'synthetic-butler'},'discard-quota-handoff');
 assert.equal(f.calls.length,2);assert.equal(rules.sessionReady(f.w.snapshot().sessions[0],{enabled:true}).ready,true);
 const next=randomUUID();await f.w.send(f.s.id,'Synthetic fresh handoff','dispatcher',null,null,null,null,null,null,null,{itemId:'rotation:'+f.s.id,control:{kind:'rotation-request',epoch:next}});
 assert.equal(f.s.rotationEpisode.epoch,next);assert.notEqual(next,record.episodeEpoch);assert.equal(f.calls.length,3);
});
test('untagged provider recovery and late original completion do not unlock waiting-provider',async t=>{
 const f=fixture(t),record=await quotaRequest(f);await f.dispatcher.advanceRotations(f.client.snapshot(),Date.now());
 f.notify('turn/started',{turn:{id:'native-recovery'}});f.notify('turn/completed',{turn:{id:'native-recovery',status:'completed'}});
 assert.equal(f.s.nativeQuota,undefined);f.runtime.emit('complete',{tag:record.tag,text:'Synthetic late handoff'});
 assert.equal(f.s.rotationEpisode.state,'waiting-provider');assert.throws(()=>f.w.completeRotation(f.s.id,f.s.nativeId,record.episodeEpoch,record.tag));
 assert.equal(f.calls.length,1);
});
test('waiting-provider survives Workspace and coordinator restart with original identity and tag',async t=>{
 const f=fixture(t),record=await quotaRequest(f);await f.dispatcher.advanceRotations(f.client.snapshot(),Date.now());f.w.persist();f.dispatcher.save();
 const restored=new Workspace({binaries:{},close(){}},f.dir);try{const s=restored.snapshot().sessions[0];assert.equal(s.rotationEpisode.state,'waiting-provider');assert.equal(s.rotationEpisode.epoch,record.episodeEpoch);assert.equal(s.rotationEpisode.tag,record.tag);}finally{restored.close();}
 const records=rules.readRotations(f.dispatcher.file,Date.now());assert.equal(records[f.s.id].phase,'waiting-provider');assert.equal(records[f.s.id].tag,record.tag);
});
test('untyped handoff-missing and unrelated quota are not provider-wait evidence',async t=>{
 for(const other of [false,true]){const f=fixture(t),record=await quotaRequest(f,{codexErrorInfo:'other'});
 if(other){f.notify('turn/started',{turn:{id:'unrelated-quota'}});f.notify('turn/completed',{turn:{id:'unrelated-quota',status:'failed',error:{codexErrorInfo:'usageLimitExceeded'}}});assert.ok(f.s.nativeQuota);}
 await f.dispatcher.failRotation(f.s.id,record,'handoff-missing',Date.now(),f.client.snapshot());assert.equal(record.phase,'failed');assert.equal(f.s.rotationEpisode.state,'invalid');assert.equal(f.calls.length,1);}
});

test('a failed provider-wait checkpoint cannot publish a durable coordinator wait until save retry succeeds',async t=>{
 const f=fixture(t),notify=f.notify;f.notify=(...args)=>{const rename=fs.renameSync;fs.renameSync=function(a,b){if(b===path.join(f.dir,'workspace.json'))throw Object.assign(Error('Synthetic EIO'),{code:'EIO'});return rename.apply(this,arguments);};try{return notify(...args);}finally{fs.renameSync=rename;}};
 const record=await quotaRequest(f);assert.ok(f.w.storageWarning);await f.dispatcher.advanceRotations(f.client.snapshot(),Date.now());assert.equal(record.phase,'requested');
 f.w.retrySave();await f.dispatcher.advanceRotations(f.client.snapshot(),Date.now());assert.equal(record.phase,'waiting-provider');
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'workspace.json'))).sessions[0].rotationEpisode.state,'waiting-provider');
});
