const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
const { Codex } = require(path.join(root, 'app/adapters.cjs'));
const { RoomState } = require(path.join(root, 'app/room-state.cjs'));
const rules = require(path.join(root, 'app/queue-dispatch.cjs'));
function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'naw-rotation-context-')), calls=[]; let turn=0;
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

async function switched(t, trim=false){
 const f=fixture(t),record=await quotaRequest(f);await f.dispatcher.advanceRotations(f.client.snapshot(),Date.now());
 if(trim)f.s.messages=[];
 const previous=f.s.nativeId,next=randomUUID(),rpc=f.runtime.host.rpc,key='synthetic-terminal-switch';
 f.runtime.observeTerminalContext({kind:'request',method:'thread/start',key,rpc});
 f.runtime.observeTerminalContext({kind:'response',method:'thread/start',key,rpc,result:{model:'model-a',thread:{id:next,cwd:f.dir,status:{type:'idle'},turns:[]}}});
 await f.runtime.observing;assert.equal(f.s.nativeId,next);assert.equal(f.s.nativeContextPending,null);assert.equal(f.runtime.chatAvailable,true);
 f.s.background=0;f.s.scheduled=0;assert.equal(rules.sessionReady(f.w.snapshot().sessions[0],{enabled:true}).ready,true);
 f.dispatcher.pruneRotations(Date.now()+9*86400000);await f.dispatcher.advanceRotations(f.client.snapshot(),Date.now()+9*86400000);
 const input={rooms:[{id:'shared',name:'Synthetic',queue:[{id:'new-task',text:'Synthetic',status:'queued',assignee:null,createdAt:Date.now()-1000}]}],sessions:f.w.snapshot().sessions,wakePolicy:{enabled:true},idleSince:new Map([[f.s.id,Date.now()-60000]]),settleMs:0,now:Date.now()};
 const without=rules.planDispatch({...input,rotations:{}}),withOld=rules.planDispatch({...input,rotations:f.dispatcher.rotations});
 assert.ok(without.some(a=>a.kind==='dispatch'),'Positive control: identical new member and queue can dispatch');
 assert.throws(()=>f.w.releaseRotation(f.s.id,previous,record.episodeEpoch,record.tag,{kind:'person',id:'window'},'discard-old'));
 assert.throws(()=>f.w.releaseRotation(f.s.id,next,record.episodeEpoch,record.tag,{kind:'person',id:'window'},'discard-old'));
 const observation={previous,next,episode:f.s.rotationEpisode,record,without,withOld,releaseVisible:f.s.rotationEpisode.nativeId===f.s.nativeId};
 console.log('NATIVE_SWITCH '+JSON.stringify(observation));return {...observation,f};
}
test('a committed native switch retires the previous provider wait without replay or weakened release identity',async t=>{
 const o=await switched(t);assert.ok(o.withOld.some(a=>a.kind==='dispatch'),'Current ready native identity must not be held by an unreleasable previous-identity wait');
 assert.equal(o.episode.state,'released');assert.equal(o.episode.disposition.action,'context-switch');assert.equal(o.episode.disposition.outcome,'failed');
});
test('late replies, human input and a naked nativeId mismatch cannot retire a provider wait',async t=>{
 const f=fixture(t),record=await quotaRequest(f);await f.dispatcher.advanceRotations(f.client.snapshot(),Date.now());
 f.runtime.emit('complete',{tag:record.tag,text:'Synthetic late old handoff'});await f.w.send(f.s.id,'Synthetic human input','window');
 await f.dispatcher.advanceRotations(f.client.snapshot(),Date.now());assert.equal(f.dispatcher.rotations[f.s.id],record);
 f.s.nativeId=randomUUID();await f.dispatcher.advanceRotations(f.client.snapshot(),Date.now());assert.equal(f.dispatcher.rotations[f.s.id],record);
 assert.equal(f.s.rotationEpisode.state,'waiting-provider');
});
test('retirement audit survives restart and does not depend on an old input row remaining in the reader',async t=>{
 const o=await switched(t,true),f=o.f,saved=JSON.parse(fs.readFileSync(path.join(f.dir,'workspace.json'))).sessions[0];
 assert.equal(saved.rotationEpisode.disposition.outcome,'failed');assert.equal(saved.nativeContexts.at(-1).rotationDisposition.tag,o.record.tag);
 f.dispatcher.rotations[f.s.id]=o.record;const restored=new Workspace({binaries:{},close(){}},f.dir);
 try{await f.dispatcher.advanceRotations(restored.snapshot(),Date.now());assert.equal(f.dispatcher.rotations[f.s.id],undefined);}finally{restored.close();}
});
test('a failed switch checkpoint never publishes retirement and retry commits one audit without another native input',async t=>{
 const f=fixture(t),record=await quotaRequest(f);await f.dispatcher.advanceRotations(f.client.snapshot(),Date.now());
 const next=randomUUID(),rpc=f.runtime.host.rpc,key='eio-switch';rpc.connected=true;
 f.runtime.observeTerminalContext({kind:'request',method:'thread/start',key,rpc});const rename=fs.renameSync;
 fs.renameSync=function(a,b){if(b===path.join(f.dir,'workspace.json'))throw Object.assign(Error('Synthetic EIO'),{code:'EIO'});return rename.apply(this,arguments);};
 try{f.runtime.observeTerminalContext({kind:'response',method:'thread/start',key,rpc,result:{model:'model-a',thread:{id:next,cwd:f.dir,status:{type:'idle'},turns:[]}}});}finally{fs.renameSync=rename;}
 assert.ok(f.s.nativeContextPending);assert.equal(f.s.rotationEpisode.state,'waiting-provider');assert.equal(f.runtime.chatAvailable,false);
 await f.dispatcher.advanceRotations(f.client.snapshot(),Date.now());assert.equal(f.dispatcher.rotations[f.s.id],record);
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'workspace.json'))).sessions[0].rotationEpisode.state,'waiting-provider');
 f.w.retrySave();await f.runtime.observing;assert.equal(f.s.nativeContextPending,null);assert.equal(f.s.nativeContexts.length,1);
 assert.equal(f.s.rotationEpisode.state,'released');await f.dispatcher.advanceRotations(f.client.snapshot(),Date.now());assert.equal(f.dispatcher.rotations[f.s.id],undefined);assert.equal(f.calls.length,1);
});
test('a new native quota remains a stop gate after the previous wait was retired',async t=>{
 const o=await switched(t),f=o.f;f.notify('turn/started',{turn:{id:'new-native-quota'}});f.notify('turn/completed',{turn:{id:'new-native-quota',status:'failed',error:{codexErrorInfo:'usageLimitExceeded'}}});
 assert.equal(f.s.nativeQuota.nativeId,f.s.nativeId);assert.equal(rules.sessionReady(f.w.snapshot().sessions[0],{enabled:true}).reason,'usage-limit-exceeded');
 assert.equal(f.s.rotationEpisode.state,'released');await f.dispatcher.advanceRotations(f.client.snapshot(),Date.now());assert.equal(f.dispatcher.rotations[f.s.id],undefined);
});

test('the normal tick reconciles a retired wait even though it is not an active rotation',async t=>{
 const o=await switched(t),f=o.f;f.dispatcher.rotations[f.s.id]=o.record;assert.equal(f.dispatcher.activeRotations().length,0);
 const advance=f.dispatcher.advanceRotations.bind(f.dispatcher);let calls=0;f.dispatcher.advanceRotations=async(...args)=>{calls++;return advance(...args);};
 f.dispatcher.listen=()=>{};f.dispatcher.memory=async()=>({memory:new Map(),limit:1e9});f.dispatcher.dirty=true;f.dispatcher.lastMaintenance=0;
 await f.dispatcher.tick();assert.ok(calls>0);assert.equal(f.dispatcher.rotations[f.s.id],undefined);assert.equal(f.calls.length,1);
});
test('contextEnd alone or an unmatched clear does not authorize retirement',async t=>{
 const f=fixture(t),record=await quotaRequest(f);await f.dispatcher.advanceRotations(f.client.snapshot(),Date.now());
 f.runtime.observeTerminalContext({kind:'request',method:'thread/start',key:'pending-switch',rpc:f.runtime.host.rpc});
 f.w.clearNativeContext(f.s,{}, {previousId:f.s.nativeId,nativeId:randomUUID(),reason:'terminal-switch'});
 await f.dispatcher.advanceRotations(f.client.snapshot(),Date.now());assert.equal(f.s.rotationEpisode.state,'waiting-provider');assert.equal(f.dispatcher.rotations[f.s.id],record);assert.equal(f.calls.length,1);
});
test('two committed native switches before coordinator recovery keep the original retirement proof usable',async t=>{
 const o=await switched(t),f=o.f;f.dispatcher.rotations[f.s.id]=o.record;const next=randomUUID(),rpc=f.runtime.host.rpc,key='second-switch';
 f.runtime.observeTerminalContext({kind:'request',method:'thread/start',key,rpc});f.runtime.observeTerminalContext({kind:'response',method:'thread/start',key,rpc,result:{model:'model-a',thread:{id:next,cwd:f.dir,status:{type:'idle'},turns:[]}}});await f.runtime.observing;
 await f.dispatcher.advanceRotations(f.client.snapshot(),Date.now());assert.equal(f.s.nativeId,next);assert.equal(f.dispatcher.rotations[f.s.id],undefined);assert.equal(f.calls.length,1);
});
