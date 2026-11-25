const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{EventEmitter}=require('node:events'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'../..'),req=createRequire(path.join(root,'app/tests/claude-observation.test.cjs'));
const {Claude,Codex}=req('../adapters.cjs'),{Workspace}=req('../workspace.cjs'),{SubmissionChannel}=req('../claude-submit.cjs');
const {RoomState}=req('../room-state.cjs'),{ButlerIngress,bindQueueOutcomes}=req('../butler-ingress.cjs'),rules=req('../queue-dispatch.cjs');
function part(src,a,b){const i=src.indexOf(a),j=src.indexOf(b,i);assert.ok(i>=0&&j>i);return src.slice(i,j);}
function adapter(){const r=Object.create(Claude.prototype);EventEmitter.call(r);r.record={nativeId:randomUUID()};r.terminal={alive:true};r.submission=new SubmissionChannel();r.bindRoot({sessionId:r.record.nativeId});return r;}
const claude=fs.readFileSync(path.join(root,'app/tests/claude-observation.test.cjs'),'utf8');
const helpers=part(claude,'function capacityFailure(',"for (const order of ['frame-first'")+part(claude,'function capacityWorkspace(',"test('Claude overload uses")+part(claude,'function nextFailure(f, status)',"test('repeated refused Claude requests");
const {capacityWorkspace,nextFailure}=new Function('fs','os','path','randomUUID','adapter','Workspace','assert',helpers+';return {capacityWorkspace,nextFailure};')(fs,os,path,randomUUID,adapter,Workspace,assert);
const codex=fs.readFileSync(path.join(root,'app/tests/codex-context.test.cjs'),'utf8');
const cHelpers=part(codex,'function fixture(t){',"test('T103")+part(codex,'function capacityFixture(t)', 'const capacityTick=');
const capacityFixture=new Function('fs','os','path','randomUUID','Codex','Workspace',cHelpers+';return capacityFixture;')(fs,os,path,randomUUID,Codex,Workspace);
const main=fs.readFileSync(path.join(root,'app/main.cjs'),'utf8');const start=main.indexOf("  client.on('state', data => {"),end=main.indexOf("  client.on('terminal', data =>",start);assert.ok(start>0&&end>start);
function wireMain(room,ingress){
 const listeners=[],client={on:(name,fn)=>{if(name==='state')listeners.push(fn);}};
 require('node:vm').runInNewContext(main.slice(start,end),{client,context:{background:true},win:{isDestroyed:()=>false},butlerIngress:ingress,sessionLabels:{labels:new Map()},roomState:room,broadcastRoom:async()=>{},placeOpened:async()=>{},carryGrants:async()=>{}});assert.equal(listeners.length,2);
 return listeners;
}
function wire(f){
 const room=new RoomState(f.dir),ingress=new ButlerIngress(f.dir,{roomState:room});bindQueueOutcomes(room,ingress,()=>{});
 const now=Date.now(),tag='synthetic-original';const id=room.queueAdd('Synthetic queued task',null,'shared');room.queueMarkSent('shared',id,f.s.id,'Synthetic member',now-30000);room.queueSetDelivery('shared',id,tag,0);
 f.s.messages.unshift({id:tag,role:'user',text:'Synthetic queued task',origin:'naw-dispatch',time:now-30000});Object.assign(f.s,{name:'Synthetic member',roomIds:['shared'],roomId:'shared'});
 const listeners=wireMain(room,ingress);
 return {room,ingress,id,listeners};
}
async function exhausted(t,provider,reason){
 const status={connection:null,capacity:529,forbidden:403}[reason];let f;
 if(provider==='claude')f=capacityWorkspace(t,undefined,{apiErrorStatus:status,...(reason==='connection'?{apiError:'connection_failed'}:{})});
 else {f=capacityFixture(t);f.host.rpc.nativeVersion='0.165.0';}
 const bound=wire(f),ends=[];f.r.on('nativeTurnEnd',info=>ends.push(info));
 if(provider==='claude'){f.fail();f.stop();}else f.fail('original',reason==='routing'?'other':'serverOverloaded',reason==='routing'?'workspace routing discovery timed out':'NATIVE ORIGINAL');
 for(let attempt=0;attempt<3;attempt++){
  const r=f.w.capacityStatus(f.s.id);assert.equal(r.reason,reason);assert.equal(r.attempt,attempt);f.w.tickCapacity(r.due);await new Promise(resolve=>setImmediate(resolve));
  if(provider==='claude')nextFailure(f,status);else{f.start('automatic-'+(attempt+1));f.end('automatic-'+(attempt+1),reason==='routing'?'other':'serverOverloaded','failed',reason==='routing'?'workspace routing discovery timed out':'NATIVE ORIGINAL');}
 }
 assert.equal(f.w.capacityStatus(f.s.id).status,'exhausted');assert.equal(ends.length,4);
 if(provider==='claude')assert.deepEqual(f.sent,['继续','继续','继续']);else{assert.equal(f.calls.length,3);assert.ok(f.calls.every(c=>c.method==='turn/start'&&c.params.input.length===1&&c.params.input[0].text==='继续'));}
 return {...f,...bound};
}
for(const [provider,reason] of [['claude','connection'],['claude','capacity'],['claude','forbidden'],['codex','capacity'],['codex','routing']])
test('review all recovery causes reach the butler once: '+provider+'/'+reason,async t=>{
 const f=await exhausted(t,provider,reason),member=f.w.snapshot().sessions.find(s=>s.id===f.s.id);assert.equal(member.state,provider==='claude'?'error':'idle');
 for(let n=0;n<3;n++)for(const listener of f.listeners)listener({sessions:[member]});
 const actions=rules.planDispatch({rooms:[{...f.room.metadata(),id:'shared'}],sessions:[member],wakePolicy:{enabled:true},idleSince:new Map([[member.id,Date.now()-60000]]),now:Date.now()});
 if(provider==='claude')assert.deepEqual(actions,[]);
 for(const action of actions)if(action.kind==='settle')f.room.queueSettle(action.roomId,action.itemId,action.status,action.reason||'','Synthetic member',action.reply||'',action.question,action.ready,action.reportTitle);
 assert.notEqual(f.room.queueFind('shared',f.id).status,'done');
 const failures=f.ingress.ledger.eventsAfter(null).events.filter(e=>e.kind==='failure');
 console.log('CAUSE',JSON.stringify({provider,reason,state:member.state,attempt:member.capacityRecovery.attempt,queue:f.room.queueFind('shared',f.id).status,failures:failures.length}));
 assert.equal(failures.length,1,'Every supported exhausted recovery must reach the butler, without replay or fake idle');
 const restored=new ButlerIngress(f.dir,{roomState:f.room});for(const listener of f.listeners)listener({sessions:[member]});for(const listener of wireMain(f.room,restored))listener({sessions:[member]});assert.equal(restored.ledger.eventsAfter(null).events.filter(e=>e.kind==='failure').length,1);
});
for(const boundary of ['draft','takeover','member-change'])test('review stale connection after '+boundary+' emits no failure',async t=>{
 const f=await exhausted(t,'claude','connection');if(boundary==='draft')f.w.setDraft(f.s.id,'Synthetic unsent words','window');if(boundary==='takeover')f.w.claim(f.s.id,'other-window');if(boundary==='member-change')f.w.join(f.s.id,false);
 const member=f.w.snapshot().sessions.find(s=>s.id===f.s.id);assert.equal(member.capacityRecovery,null);for(const listener of f.listeners)listener({sessions:[member]});assert.equal(f.ingress.ledger.eventsAfter(null).events.filter(e=>e.kind==='failure').length,0);assert.equal(f.sent.length,3);
});
// The same queue item through the real adapter, workspace and dispatcher, with the person's own calls noted as the daily
// app notes them (main.cjs authorizeOperation).
const human=part(main,'const HUMAN_SESSION_METHODS','// A key the person typed in'),note=/humanSessionWork\(method, args\)\) (queueDispatcher\?\.noteHuman\(.+\);)/.exec(main)[1];
function rig(t,f){
 const {room,ingress,id}=wire(f),clock={now:Date.now()};
 const capabilities=[rules.CAPABILITY],client=Object.assign(new EventEmitter(),{close(){},refresh:async()=>{},route:()=>({client,state:{capabilities}}),
  snapshot:()=>({...f.w.snapshot(),capabilities,wakePolicy:{enabled:true},operatorPolicy:{domains:[]}}),call:async m=>{if(m==='initial')return client.snapshot();throw Error(m);}});
 const d=new rules.QueueDispatcher({roomState:room,dataDir:f.dir,connect:async()=>client,clients:()=>client,steward:()=>null,now:()=>clock.now,settleMs:8000,tickMs:3600000,
  transcriptRoot:path.join(f.dir,'none'),sampleProcesses:async()=>'',samplePressure:async()=>'',compactions:{async sample(){return new Map();}},errorStalled:s=>ingress.errorStalled(s)});
 t.after(()=>d.close());
 const told=()=>ingress.ledger.eventsAfter(null).events.filter(e=>e.payload.reason==='error-stalled');
 const pass=async ms=>{for(let n=0;n<ms;n+=10000){d.dirty=true;await d.schedule();clock.now+=10000;}};
 const authorize=new Function('queueRules','queueDispatcher',human+'return (method,args,context)=>{if(humanSessionWork(method,args))'+note+'};')(rules,d);
 // The window a call comes from is the owner the workspace is given (claim's first argument, the others' last).
 const person=async(method,...args)=>{authorize(method,[f.s.id,...args],{view:{owner:method==='claim'?args[0]:args.at(-1)}});await (method==='draft'?f.w.setDraft(f.s.id,...args):f.w[method](f.s.id,...args));};
 return {room,id,clock,told,pass,person};
}
const STREAM={apiErrorStatus:undefined,apiError:'stream_idle_timeout',error:'server_error'};
// What NAW continues is not told while it is scheduled; what it does not continue is told after three minutes in 'error'.
for(const [label,row,reason] of [['an idle stream',STREAM,'connection'],['a server error',{apiErrorStatus:500,apiError:undefined,error:'server_error'},null],['a usage limit',{apiErrorStatus:429,apiError:undefined,error:'rate_limit'},null],['a sign-in failure',{apiErrorStatus:401,apiError:undefined,error:'authentication_failed'},null]])
test('a sent item whose member stopped on '+label+(reason?' is continued, and not told meanwhile':' is told to the butler, and not continued'),async t=>{
 const f=capacityWorkspace(t,undefined,row),g=rig(t,f);
 f.fail({errorRowUnclassified:true});f.stop();assert.equal(f.s.state,'error');
 assert.equal(f.w.capacityStatus(f.s.id)?.reason??null,reason);
 await g.pass(200000);
 assert.deepEqual(g.told().map(e=>[e.kind,e.payload.memberId,e.payload.itemId]),reason?[]:[['blocked',f.s.id,g.id]]);
 assert.equal(g.room.queueFind('shared',g.id).status,'sent');assert.deepEqual(f.sent,[]);
});
// Once continued, a turn that fails without a named end leaves its record at 'sending' (the limit of three counts on it).
for(const [label,row,incomplete] of [['a sign-in failure',{apiErrorStatus:401,apiError:undefined,error:'authentication_failed'},false],['a usage limit',{apiErrorStatus:429,apiError:undefined,error:'rate_limit'},false],['an idle stream in a turn of more than 64 blocks',STREAM,true]])
test('a continued turn that stopped on '+label+' is told to the butler',async t=>{
 const f=capacityWorkspace(t,undefined,STREAM),g=rig(t,f);
 f.fail({errorRowUnclassified:true});f.stop();f.w.tickCapacity(f.w.capacityStatus(f.s.id).due);await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(f.sent,['继续']);f.s.pendingTag=null;
 const promptId=f.r.lastPromptId=randomUUID(),turnId=randomUUID(),errorMessageId=randomUUID();
 fs.writeFileSync(f.file,JSON.stringify({...f.row,...row,uuid:errorMessageId})+'\n');
 f.block({id:'control:turn-start',kind:'control',status:'running',promptId,turnId});f.r.emit('state','working');
 if(incomplete)(f.r.displayProofs||=new Map()).set(turnId,{blocks:new Map(),incomplete:true});
 f.block({id:'turn:'+turnId,kind:'turn',status:'failed',turnId,failedRequest:true,errorMessageId,errorRowUnclassified:true});f.stop({prompt_id:promptId});
 assert.equal(f.s.state,'error');assert.equal(f.w.capacityStatus(f.s.id)?.status,'sending');
 await g.pass(200000);
 assert.deepEqual(g.told().map(e=>[e.kind,e.payload.memberId,e.payload.itemId]),[['blocked',f.s.id,g.id]]);
 assert.deepEqual(f.sent,['继续']);
});
// The person's own stop of the continuation is not told; looking, scrolling, typing or taking over is no stop. Looking
// and scrolling leave it scheduled, so what ends it there is something else; a takeover ends it when it is due.
for(const [label,calls,count] of [['the stop button',[['interrupt','window']],0],['Esc in the terminal',[['input','\x1b','window']],0],['Ctrl-C in the terminal',[['input','\x03','window']],0],
 ['something else after opening it',[['claim','window'],['claim','window','terminal']],1],['something else after scrolling its terminal',[['input','\x1b[<64;10;10M','window']],1],['other words in the terminal',[['input','words','window']],1],['another window taking over',[['claim','other-window']],1],['a draft, cleared',[['draft','words','window'],['draft','','window']],1]])
test('a scheduled continuation ended by '+label+': '+(count?'told':'not told'),async t=>{
 const f=capacityWorkspace(t,undefined,STREAM),g=rig(t,f);f.r.terminal.input=()=>{};
 f.fail({errorRowUnclassified:true});f.stop();await g.pass(60000);assert.equal(f.w.capacityStatus(f.s.id).status,'scheduled');
 for(const call of calls)await g.person(...call);
 if(label.startsWith('something else'))f.w.cancelCapacity(f.s.id);
 if(label.startsWith('another window')){f.w.tickCapacity(f.w.capacityStatus(f.s.id).due);await new Promise(resolve=>setImmediate(resolve));}
 assert.equal(f.w.capacityStatus(f.s.id),null);assert.equal(f.s.state,'error');
 await g.pass(3600000);
 assert.equal(g.told().length,count);assert.deepEqual(f.sent,[]);
});
test('Esc ten minutes before the stop is no stop of its continuation: told',async t=>{
 const f=capacityWorkspace(t,undefined,STREAM),g=rig(t,f);f.r.terminal.input=()=>{};
 await g.pass(10000);await g.person('input','\x1b','window');await g.pass(600000);
 f.fail({errorRowUnclassified:true});f.stop();assert.equal(f.s.state,'error');await g.pass(60000);f.w.cancelCapacity(f.s.id);
 await g.pass(3600000);
 assert.equal(g.told().length,1);
});
test('a second stop of the same item has its own line',async t=>{
 const f=capacityWorkspace(t,undefined,{apiErrorStatus:500,apiError:undefined,error:'server_error'}),g=rig(t,f);
 f.fail({errorRowUnclassified:true});f.stop();await g.pass(600000);assert.equal(g.told().length,1);
 f.r.emit('state','working');await g.pass(60000);f.r.emit('state','error');await g.pass(170000);assert.equal(g.told().length,1);
 await g.pass(600000);assert.equal(g.told().length,2);assert.deepEqual(f.sent,[]);
});
