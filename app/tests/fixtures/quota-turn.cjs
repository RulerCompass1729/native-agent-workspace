'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const ROOT=process.env.NAW_TEST_APP_ROOT||process.env.NAW_SOURCE_ROOT||path.resolve(__dirname,'../../..');
async function stewardRead(f){
 const vm=require('node:vm'),source=fs.readFileSync(path.join(ROOT,'app/main.cjs'),'utf8');
 const start=source.indexOf("  register('stewardEvents',"),end=source.indexOf('  // The switch for waking',start);assert.ok(start>0&&end>start);
 let handler;vm.runInNewContext(source.slice(start,end),{register:(name,fn)=>{assert.equal(name,'stewardEvents');handler=fn;},stewardCaller:async()=>true,butlerIngress:f.ingress,uiError:require(path.join(ROOT,'app/ui-errors.cjs')).uiError});
 return handler({background:true},null);
}
const RESET=Date.parse('2026-11-22T00:00:00Z')/1000;
const ERROR_TEXT="You've hit your usage limit. Try again at 2026-11-22T00:00:00Z.";
function modules(root){return { ...require(path.join(root,'app/adapters.cjs')), ...require(path.join(root,'app/workspace.cjs')), ...require(path.join(root,'app/room-state.cjs')), ...require(path.join(root,'app/butler-ingress.cjs')), rules:require(path.join(root,'app/queue-dispatch.cjs'))};}
async function fixture(t,root=ROOT){
 const M=modules(root),dir=fs.mkdtempSync(path.join(os.tmpdir(),'naw-c-quota-steward-'));fs.chmodSync(dir,0o700);
 const NOW=Date.now()+60000,calls=[],host={binaries:{},codexTargets:new Map(),close(){},rpc:{nativeVersion:'0.167.0',call:async(method,params)=>{calls.push({method,params});assert.equal(method,'turn/start');return {turn:{id:'work-turn'}};}}};
 const w=new M.Workspace(host,dir),s={id:'member-a',nativeId:'11111111-1111-4111-8111-111111111111',provider:'codex',model:'model-a',cwd:dir,view:'chat',owner:'synthetic-window',state:'idle',createdAt:NOW-60000,controlRevision:0,memberRevision:0,messages:[],roomId:'shared',roomIds:['shared'],serviceCapabilities:[M.rules.CAPABILITY,'nativeInputIsolation','rotationControlEpochV1'],background:0,scheduled:0,fleet:[]};
 const r=new M.Codex(s,host);w.sessions.set(s.id,s);w.runtimes.set(s.id,r);w.bind(s,r);
 const room=new M.RoomState(dir),ingress=new M.ButlerIngress(dir,{roomState:room});let personNotices=0;
 M.bindQueueOutcomes(room,ingress,()=>{personNotices++;});
 w.on('change',()=>ingress.observeRecoveryFailures(w.snapshot().sessions));
 const itemId=room.queueAdd('Synthetic diagnostic task',null);room.queueMarkSent('shared',itemId,s.id,'Synthetic member',NOW-2000,false,s.nativeId);
 const tag=await w.send(s.id,'Synthetic diagnostic task','naw-dispatcher',null,null,null,null,null,null,null,{itemId});room.queueSetDelivery('shared',itemId,tag,0);
 const client={snapshot:()=>w.snapshot()},dispatcher={roomState:room,client,stillSent:(...a)=>room.queueFind(...a).status==='sent',name:()=> 'Synthetic member',broadcast:()=>Promise.resolve()};
 const snapshot=()=>w.snapshot().sessions.find(x=>x.id===s.id);
 const plan=(queue=room.queueItems('shared'),sessions=[snapshot()])=>M.rules.planDispatch({rooms:[{id:'shared',name:'Synthetic team',queue}],sessions,wakePolicy:{enabled:true},idleSince:new Map(sessions.map(x=>[x.id,NOW-60000])),now:NOW,settleMs:0});
 const settle=()=>{const action=plan().find(a=>a.kind==='settle'&&a.itemId===itemId);assert.ok(action,'A real plan produced a settlement');M.rules.QueueDispatcher.prototype.settle.call(dispatcher,action,client.snapshot());return action;};
 const frame=(method,params)=>r.event({method,params:{threadId:s.nativeId,...params}},host.rpc);
 const drive=({partial=false,typed=true,success=false,structured=true,text='Synthetic progress: next I will check the task.'}={})=>{
  const error=success?undefined:{message:ERROR_TEXT,...(typed?{codex_error_info:'usage_limit_exceeded',...(structured?{resets_at:RESET}:{})}:{})};
  const records=[{timestamp:new Date(NOW-2000).toISOString(),type:'session_meta',payload:{id:s.nativeId,cwd:dir}},{type:'event_msg',payload:{type:'task_started',turn_id:'work-turn'}}];
  if(partial)records.push({type:'event_msg',payload:{type:'agent_message',turn_id:'work-turn',message:text}});
  records.push({type:'event_msg',payload:{type:'task_complete',turn_id:'work-turn',last_agent_message:partial?text:'',...(error?{error}:{})}});
  const file=path.join(dir,'synthetic-rollout.jsonl');fs.writeFileSync(file,records.map(x=>JSON.stringify(x)).join('\n')+'\n');
  const rows=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);assert.equal(rows[0].payload.id,s.nativeId);
  // Fixture transport projection only: production consumes live RPC, not this file.
  for(const row of rows.slice(1)){
   const p=row.payload;assert.equal(p.turn_id,'work-turn');
   if(p.type==='task_started'){frame('turn/started',{turn:{id:p.turn_id}});frame('item/completed',{turnId:p.turn_id,item:{id:'input-item',type:'userMessage',clientId:tag,content:[{type:'inputText',text:'Synthetic diagnostic task'}]}});}
   if(p.type==='agent_message'){frame('item/started',{turnId:p.turn_id,item:{id:'progress-item',type:'agentMessage',phase:'commentary'}});frame('item/completed',{turnId:p.turn_id,item:{id:'progress-item',type:'agentMessage',phase:'commentary',text:p.message}});}
   if(p.type==='task_complete')frame('turn/completed',{turn:{id:p.turn_id,status:p.error?'failed':'completed',...(p.error?{error:p.error}:{})}});
  }
  return {file,records};
 };
 t.after(async()=>{await w.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {M,dir,NOW,w,s,r,host,room,ingress,itemId,tag,calls,snapshot,frame,drive,plan,settle,events:()=>ingress.ledger.eventsAfter(null).events,personNotices:()=>personNotices};
}
module.exports={fixture,stewardRead,RESET,ERROR_TEXT,ROOT};
