const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {Codex}=require('../adapters.cjs'),{Workspace}=require('../workspace.cjs');
const {applyCodexHistory,applyCodexMessage,applyCodexDelta}=require('../native-blocks.cjs');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'naw-context-unit-')),replies=[];
 const host={binaries:{},codexTargets:new Map(),rpc:{call:async()=>({data:[]}),reply:(...args)=>replies.push(args)},close(){}};
 const w=new Workspace(host,dir),s={id:'synthetic',provider:'codex',nativeId:randomUUID(),cwd:dir,messages:[],state:'idle',owner:'window',controlRevision:0,memberRevision:0,roomId:'shared'};
 const r=new Codex(s,host);w.sessions.set(s.id,s);w.runtimes.set(s.id,r);w.bind(s,r);host.codexTargets.set(s.nativeId,r);
 t.after(()=>{w.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {dir,w,s,r,host,replies};
}
test('T103 live command silence warns without controlling work and clears on progress, completion or source change',t=>{
 const {r,s,w,host}=fixture(t),original=Date.now;let now=original(),calls=[];Date.now=()=>now;
 host.rpc.call=async(method)=>{calls.push(method);return {}};
 try{
  const emit=(method,params)=>r.event({method,params:{threadId:s.nativeId,...params}});
  emit('turn/started',{turn:{id:'wait-a'}});
  emit('item/started',{turnId:'wait-a',startedAtMs:now-10000,item:{id:'read-a',type:'commandExecution',command:'synthetic read',status:'inProgress',commandActions:[]}});
  assert.equal(r.nativeActivity.toolWait?.source,'live-observation');const start=r.nativeActivity.toolWait.progressAt;
  w.room.run={id:'other-collaboration',ids:['B','C'],status:'running'};const run=JSON.stringify(w.room.run),draft='Original unsent draft';w.setDraft(s.id,draft,s.owner);
  now+=5*60*1000-1;w.tickToolWait();assert.equal(r.nativeActivity.waitNotice,undefined);
  now++;w.tickToolWait();assert.equal(w.snapshot().sessions[0].nativeActivity.waitNotice.progressAt,start);assert.equal(s.state,'working');assert.equal(JSON.stringify(w.room.run),run);assert.deepEqual(calls,[]);assert.equal(w.drafts.get(s.id),draft);
  emit('item/commandExecution/outputDelta',{turnId:'wait-a',itemId:'read-a',delta:'new progress'});assert.equal(r.nativeActivity.waitNotice,undefined);w.tickToolWait();assert.equal(r.toolWaitNotice,null);
  now+=5*60*1000;w.tickToolWait();assert.ok(r.nativeActivity.waitNotice);
  emit('thread/status/changed',{status:{type:'active',activeFlags:['waitingOnApproval']}});w.tickToolWait();assert.equal(r.nativeActivity.toolWait,undefined);
  now+=20*60*1000;emit('thread/status/changed',{status:{type:'active',activeFlags:[]}});w.tickToolWait();assert.equal(r.nativeActivity.waitNotice,undefined,'Human waiting time is not a fresh tool timeout');
  emit('turn/started',{turn:{id:'wait-b'}});emit('item/commandExecution/outputDelta',{turnId:'wait-a',itemId:'read-a',delta:'late old output'});w.tickToolWait();assert.equal(r.nativeActivity.toolWait,undefined);
  emit('item/started',{turnId:'wait-b',item:{id:'read-b',type:'commandExecution',command:'synthetic read',status:'inProgress',commandActions:[]}});
  now+=5*60*1000;w.tickToolWait();assert.ok(r.nativeActivity.waitNotice);
  const native=s.nativeId;s.nativeId=randomUUID();w.tickToolWait();assert.equal(r.nativeActivity?.toolWait,undefined,'An old live tool cannot bind to a replacement native ID');s.nativeId=native;
  emit('item/completed',{turnId:'wait-b',item:{id:'read-b',type:'commandExecution',status:'completed',command:'synthetic read',exitCode:0}});w.tickToolWait();assert.equal(r.nativeActivity.toolWait,undefined);assert.equal(r.toolWaitNotice,null);assert.deepEqual(calls,[]);
 }finally{Date.now=original}
});
for(const type of ['mcpToolCall','dynamicToolCall','fileChange'])test('T103 live '+type+' silence is observed without requiring a shell command',t=>{
 const {r,s,w}=fixture(t),original=Date.now;let now=original();Date.now=()=>now;
 const item={id:'tool',type,status:'inProgress',server:'synthetic',tool:'read',arguments:{},changes:[]};
 const emit=(method,params)=>r.event({method,params:{threadId:s.nativeId,turnId:'tool-turn',...params}});
 try{
  emit('turn/started',{turn:{id:'tool-turn'}});emit('item/started',{item});
  now+=5*60*1000;w.tickToolWait();assert.ok(r.nativeActivity.waitNotice,'Non-command native tools must not stay silently unwatched');
  const at=r.nativeActivity.toolWait.progressAt;emit('item/started',{item});assert.equal(r.nativeActivity.toolWait.progressAt,at,'Duplicate starts are not progress');
  if(type!=='dynamicToolCall'){
   const method=type==='mcpToolCall'?'item/mcpToolCall/progress':'item/fileChange/patchUpdated';
   const body=type==='mcpToolCall'?{message:'Read made progress'}:{changes:[{path:'synthetic.txt',kind:{type:'update'},diff:'+new'}]};
   emit(method,{itemId:item.id,turnId:'old-turn',...body});assert.equal(r.nativeActivity.toolWait.progressAt,at);
   now++;emit(method,{itemId:item.id,...body});w.tickToolWait();assert.equal(r.nativeActivity.waitNotice,undefined,'Real current native tool progress clears the advisory');
  }
  emit('item/completed',{item:{...item,status:'completed'}});w.tickToolWait();assert.equal(r.nativeActivity.toolWait,undefined);
  emit('item/started',{item});now+=5*60*1000;w.tickToolWait();assert.equal(r.nativeActivity.toolWait,undefined,'A late duplicate start cannot revive an already completed tool');
 }finally{Date.now=original}
});
test('T103 tool timing rejects unknown thread, history, old RPC and old observation lifetime',t=>{
 const {r,s,w,host}=fixture(t),original=Date.now;let now=original();Date.now=()=>now;
 const params={threadId:s.nativeId,turnId:'same-turn',item:{id:'same-item',type:'commandExecution',command:'synthetic read',status:'inProgress',commandActions:[]}};
 try{
  r.event({method:'turn/started',params:{threadId:s.nativeId,turn:{id:'same-turn'}}});
  r.event({method:'item/started',params:{...params,threadId:undefined}});assert.equal(r.nativeActivity.toolWait,undefined,'An unbound source cannot authorize a clock');
  const rpc=host.rpc;host.rpc=null;r.event({method:'item/started',params});assert.equal(r.nativeActivity.toolWait,undefined,'A missing RPC is not an observation source');host.rpc=rpc;
  const native=s.nativeId;s.nativeId=null;r.event({method:'item/started',params:{...params,threadId:null}});assert.equal(r.nativeActivity.toolWait,undefined,'A missing native identity cannot establish a tool clock');s.nativeId=native;
  r.historyMessageItems.add(params.item.id);r.event({method:'item/started',params});assert.equal(r.nativeActivity.toolWait,undefined,'History cannot establish live execution');
  r.historyMessageItems.clear();r.event({method:'item/started',params});now+=5*60*1000;w.tickToolWait();assert.ok(r.nativeActivity.waitNotice);
  const oldRpc=host.rpc;host.rpc={call:async()=>({})};w.tickToolWait();assert.equal(r.nativeActivity.toolWait,undefined,'Replacing the observation source invalidates its clock');
  r.event({method:'item/started',params},oldRpc);assert.equal(r.nativeActivity.toolWait,undefined);
  r.event({method:'item/started',params});w.tickToolWait();assert.equal(r.nativeActivity.waitNotice,undefined,'A newly observed source starts with fresh quiet time');
  now+=5*60*1000;w.tickToolWait();assert.ok(r.nativeActivity.waitNotice);r.lifecycleRevision++;w.tickToolWait();assert.equal(r.nativeActivity.toolWait,undefined,'The same native/turn IDs do not bridge observation lifetimes');
 }finally{Date.now=original}
});
test('T103 progress or completion of another concurrent tool cannot hide a stalled file read',t=>{
 const {r,s,w}=fixture(t),original=Date.now;let now=original();Date.now=()=>now;
 const emit=(method,params)=>r.event({method,params:{threadId:s.nativeId,turnId:'parallel-turn',...params}});
 const read={id:'blocked-read',type:'mcpToolCall',server:'synthetic',tool:'read',arguments:{},status:'inProgress'};
 const command={id:'working-command',type:'commandExecution',command:'synthetic work',commandActions:[],status:'inProgress'};
 try{
  emit('turn/started',{turn:{id:'parallel-turn'}});emit('item/started',{item:read});emit('item/started',{item:command});const at=now;
  now+=299900;emit('item/commandExecution/outputDelta',{itemId:command.id,delta:'Other tool progress'});
  now+=100;w.tickToolWait();assert.equal(r.nativeActivity.waitNotice?.progressAt,at,'The original read is still silent even while the command works');
  now++;emit('item/mcpToolCall/progress',{itemId:read.id,message:'Read made progress'});w.tickToolWait();assert.equal(r.nativeActivity.waitNotice,undefined);
  now=at+599900;w.tickToolWait();assert.equal(r.nativeActivity.waitNotice?.progressAt,at+299900,'Each tool keeps its own last progress time');
  emit('item/completed',{item:{...read,status:'completed'}});w.tickToolWait();assert.equal(r.nativeActivity.waitNotice?.progressAt,at+299900,'Finishing another tool cannot reset the pending command deadline');
  emit('item/completed',{item:{...command,status:'completed'}});w.tickToolWait();assert.equal(r.nativeActivity.waitNotice,undefined);
  assert.equal(s.state,'working','A warning never fabricates turn completion');
 }finally{Date.now=original}
});
test('T103 assistant content and an explicit native sleep are not stalled execution tools',t=>{
 const {r,s,w}=fixture(t),original=Date.now;let now=original();Date.now=()=>now;
 const items=[{type:'reasoning',summary:['Still thinking'],content:[]},{type:'plan',text:'Original plan'},
  {type:'agentMessage',text:'Original response'},{type:'sleep',durationMs:60*60*1000}];
 try{
  for(const [n,item]of items.entries()){
   const turnId='content-'+n,emit=(method,params)=>r.event({method,params:{threadId:s.nativeId,turnId,...params}});
   emit('turn/started',{turn:{id:turnId}});emit('item/started',{item:{id:'item-'+n,...item}});
   now+=6*60*1000;w.tickToolWait();assert.equal(r.nativeActivity.toolWait,undefined,item.type+' must retain its native meaning');assert.equal(s.state,'working');
  }
 }finally{Date.now=original}
});
test('native settings show effective Plan/model/effort without copying private instructions or another context',t=>{
 const {r,s,w}=fixture(t);
 r.event({method:'thread/settings/updated',params:{threadId:s.nativeId,threadSettings:{model:'native-model',effort:'low',collaborationMode:{mode:'plan',settings:{developer_instructions:'PRIVATE_INSTRUCTIONS'}}}}});
 assert.deepEqual(w.snapshot().sessions[0].nativeSettings,{nativeId:s.nativeId,model:'native-model',effort:'low',mode:'plan'});
 assert.equal(s.model,'native-model');assert.equal(JSON.stringify(w.snapshot()).includes('PRIVATE_INSTRUCTIONS'),false);
 r.event({method:'thread/settings/updated',params:{threadId:'other',threadSettings:{model:'wrong'}}});assert.equal(s.model,'native-model');
});
test('native question history distinguishes a source submission from resolution and never shares it',t=>{
 const {r,s,w,host}=fixture(t),rpc=r.terminalRpc={connected:true,reply(){}};
 const p={threadId:s.nativeId,turnId:'turn',itemId:'call',questions:[{id:'approach',header:'Choose',question:'Which approach?',options:[{label:'Reuse',description:'Existing primitive'}]}]};
 r.event({method:'turn/started',params:{threadId:s.nativeId,turn:{id:'turn'}}},rpc);
 r.event({id:1,method:'item/tool/requestUserInput',params:p},rpc);
 assert.match(s.messages.find(m=>m.title==='原生问题').text,/Which approach\?\nReuse — Existing primitive/);
 const reply={kind:'reply',id:1,result:{answers:{approach:{answers:['Reuse'],extra:'PRIVATE_EXTRA'},unrelated:{answers:['UNRELATED_SECRET']}},extra:'PRIVATE_EXTRA'},rpc};
 r.observeTerminalContext({...reply,rpc:host.rpc});assert.equal(s.messages.some(m=>m.status==='submitted'),false);
 r.observeTerminalContext(reply);const row=s.messages.find(m=>m.title==='原生终端提交的回答');assert.equal(row.role,'system');assert.equal(row.status,'submitted');assert.match(row.text,/Reuse/);
 assert.equal(row.text,'Reuse','The reader displays the literal answer rather than internal protocol JSON');
 assert.doesNotMatch(row.text,/PRIVATE_EXTRA|UNRELATED_SECRET/);
 r.event({method:'serverRequest/resolved',params:{threadId:s.nativeId,requestId:1}},rpc);
 assert.equal(row.status,'submitted','Resolution does not prove this client won the answer race');
 r.observeTerminalContext({...reply,result:{answers:{approach:{answers:['LATE_WRONG']}}}});assert.doesNotMatch(row.text,/LATE_WRONG/);
 assert.equal(JSON.stringify(w.room.messages).includes('Reuse'),false);
});
test('secret native answers stay out of live, generic history and submission projections',t=>{
 const {r,s}=fixture(t),rpc=r.terminalRpc={connected:true,reply(){}};
 r.event({id:1,method:'item/tool/requestUserInput',params:{threadId:s.nativeId,turnId:'turn',itemId:'call',questions:[{question:'Secret question',isSecret:true}]}},rpc);
 r.observeTerminalContext({kind:'reply',id:1,result:{answers:{secret:{answers:['SECRET_ANSWER']}}},rpc});
 const item={id:'secret-output',type:'functionCallOutput',name:'request_user_input',output:'SECRET_ANSWER',turnId:'turn'};
 applyCodexHistory(s,[item],r);r.event({method:'item/completed',params:{threadId:s.nativeId,turnId:'turn',item}},rpc);
 assert.equal(JSON.stringify(s.messages).includes('SECRET_ANSWER'),false);
});
for(const change of [{id:'answer',isSecret:true},{id:'changed',isSecret:false}])test('ambiguous native question cannot project an answer from its old request metadata: '+JSON.stringify(change),t=>{
 const {r,s}=fixture(t),rpc=r.terminalRpc={connected:true,reply(){}};
 const ask=question=>r.event({id:7,method:'item/tool/requestUserInput',params:{threadId:s.nativeId,turnId:'turn',itemId:'call',questions:[{question:'Choose',...question}]}},rpc);
 ask({id:'answer',isSecret:false});ask(change);
 r.observeTerminalContext({kind:'reply',id:7,result:{answers:{answer:{answers:['SENSITIVE_RESULT']},changed:{answers:['SENSITIVE_RESULT']}}},rpc});
 assert.equal(JSON.stringify(s.messages).includes('SENSITIVE_RESULT'),false);
});
test('native context save failure freezes both old and new events; retry commits the same observed identity without another model turn',async t=>{
 const f=fixture(t),{s,r,w,host,dir}=f,A=s.nativeId,B=randomUUID(),rpc={connected:true,reply(){}};
 w.drafts.set(s.id,'Unsent original draft');s.messages.push({id:'old',role:'assistant',nativeId:A,text:'Original A'});
 const source={id:'room-source'},tag='grant';w.sharedReplies.authorize(s,r,tag,source);w.persist();
 fs.mkdirSync(path.join(dir,'workspace.json.tmp'));
 r.observeTerminalContext({kind:'request',method:'thread/start',key:1});
 r.observeTerminalContext({kind:'response',method:'thread/start',key:1,rpc,result:{thread:{id:B,cwd:dir,status:{type:'idle'},turns:[]}}});
 assert.equal(r.chatAvailable,false);assert.ok(s.nativeContextPending);assert.equal(w.sharedReplies.grants.get(tag).closed,true);
 for(const id of[A,B])r.event({method:'item/completed',params:{threadId:id,turnId:'late',item:{id:'late',type:'agentMessage',text:'Must not import'}}},rpc);
 assert.equal(s.messages.some(m=>m.text==='Must not import'),false);
 fs.rmdirSync(path.join(dir,'workspace.json.tmp'));w.retrySave();await r.observing;
 assert.equal(s.nativeId,B);assert.equal(s.nativeContextPending,null);assert.equal(host.codexTargets.get(B),r);assert.equal(host.codexTargets.has(A),false);
 assert.equal(s.nativeContexts.length,1);assert.equal(w.drafts.get(s.id),'Unsent original draft');assert.equal(r.chatAvailable,true);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'workspace.json'))).sessions[0].nativeId,B);
 r.event({method:'item/completed',params:{threadId:A,turnId:'late',item:{id:'late',type:'agentMessage',text:'Wrong old output'}}},rpc);
 assert.equal(s.messages.some(m=>m.text==='Wrong old output'),false);
});
test('fork history retains original item provenance, context order and distinct display IDs through live updates and hydration',()=>{
 const A=randomUUID(),B=randomUUID(),boundary=randomUUID();
 const s={provider:'codex',nativeId:B,nativeContexts:[{nativeId:A,boundaryId:boundary}],messages:[
  {id:'same-item',nativeId:A,role:'assistant',turnId:'same-turn',text:'Original A'},
  {id:boundary,nativeId:B,role:'system',text:'Native fork boundary'}]};
 applyCodexHistory(s,[{id:'same-item',type:'agentMessage',turnId:'same-turn',text:'Inherited A'}],{});
 assert.deepEqual(s.messages.map(m=>m.text),['Original A','Native fork boundary','Inherited A']);
 assert.equal(s.messages[0].nativeId,A);assert.equal(s.messages[2].nativeId,B);assert.notEqual(s.messages[0].id,s.messages[2].id);
 applyCodexMessage(s,{id:'same-item',turnId:'same-turn',text:'Native B update'});applyCodexDelta(s,{id:'same-item',turnId:'same-turn',text:' plus'});
 assert.equal(s.messages[0].text,'Original A');assert.equal(s.messages[2].text,'Native B update plus');
 applyCodexHistory(s,[{id:'same-item',type:'agentMessage',turnId:'same-turn',text:'Native B update plus'}],{});
 assert.deepEqual(s.messages.map(m=>m.text),['Original A','Native fork boundary','Native B update plus']);
});
test('a native question is answered with its structured reply on its source connection, and only within its options',async t=>{
 const {r,s,w,host,replies}=fixture(t),nativeReplies=[];
 const rpc=r.terminalRpc={connected:true,reply:(...args)=>nativeReplies.push(args)};r.terminalNotificationSource=true;
 const ask=(id,question)=>{r.event({id,method:'item/tool/requestUserInput',params:{threadId:s.nativeId,turnId:'t',itemId:'i'+id,isBlocking:true,questions:[question]}},rpc);r.emit('state','approval');return s.approval.requestId;};
 let requestId=ask(8,{id:'q',header:'H',question:'Which?',isOther:false,isSecret:false,options:[{label:'A',description:''},{label:'B',description:''}]});
 assert.throws(()=>w.answer(s.id,requestId,{q:['C']},'window'),/只能从给出的选项中选择/);
 assert.throws(()=>w.answer(s.id,requestId,{},'window'),/请回答每个问题/);
 assert.throws(()=>w.answer(s.id,requestId,{q:['A','B']},'window'),/请回答每个问题/);
 assert.throws(()=>w.answer(s.id,requestId,{q:['A']},'other-window'),/问题已变化/);
 w.answer(s.id,requestId,{q:['B']},'window');assert.deepEqual(nativeReplies,[[8,{answers:{q:{answers:['B']}}}]]);assert.deepEqual(replies,[]);
 assert.throws(()=>w.answer(s.id,requestId,{q:['A']},'window'),/问题已变化/,'One answer per request');
 r.event({method:'serverRequest/resolved',params:{threadId:s.nativeId,requestId:8}},rpc);
 requestId=ask(9,{id:'secret',header:'Key',question:'Token?',isOther:true,isSecret:true,options:null});
 assert.throws(()=>w.answer(s.id,requestId,{secret:['x']},'window'),/请在原生终端回答/);assert.equal(nativeReplies.length,1);
});
test('native decisions and resolution stay on the exact source connection, including colliding numeric request IDs',async t=>{
 const {r,s,w,host,replies}=fixture(t),nativeReplies=[];
 const rpc=r.terminalRpc={connected:true,reply:(...args)=>nativeReplies.push(args)};r.terminalNotificationSource=true;
 const request={id:7,method:'item/commandExecution/requestApproval',params:{threadId:s.nativeId,command:'Read isolated file',cwd:s.cwd,availableDecisions:['accept','decline']}};
 r.event(request,rpc);const requestId=s.approval.requestId;r.emit('state','approval');
 w.approve(s.id,requestId,'accept','window');assert.deepEqual(nativeReplies,[[7,{decision:'accept'}]]);assert.deepEqual(replies,[]);
 r.event({method:'serverRequest/resolved',params:{threadId:s.nativeId,requestId:7}},host.rpc);assert.equal(s.approval.requestId,requestId);
 r.event({method:'serverRequest/resolved',params:{threadId:s.nativeId,requestId:7}},rpc);assert.equal(s.approval,null);
 assert.throws(()=>w.approve(s.id,requestId,'accept','window'),/权限请求已变化/);
 rpc.connected=false;r.event(request,rpc);assert.equal(s.approval,null);
});
test('private native retry diagnostics do not revoke or populate an otherwise valid shared reply',t=>{
 const {w,r,s}=fixture(t);r.event({method:'turn/started',params:{threadId:s.nativeId,turn:{id:'public-turn'}}});
 w.sharedReplies.authorize(s,r,'public-tag',{id:'public-input'});w.sharedReplies.bind(s,'public-tag',{nativeId:s.nativeId,turnId:'public-turn'});
 r.event({method:'error',params:{threadId:s.nativeId,turnId:'public-turn',willRetry:true,error:{message:'PRIVATE_NATIVE_DIAGNOSTIC'}}});
 assert.equal(s.state,'working');assert.equal(w.sharedReplies.grants.get('public-tag').closed,false);
 assert.ok(s.messages.some(m=>m.text==='PRIVATE_NATIVE_DIAGNOSTIC'));assert.equal(JSON.stringify(w.room.messages).includes('PRIVATE_NATIVE_DIAGNOSTIC'),false);
});
test('retiring a native source invalidates only its decisions, observes catch-up and never reconnects a stopped runtime',async t=>{
 const {r,s,w,host}=fixture(t);let release,resumes=0;const actual=host.rpc.call;
 host.rpc.call=async(method,args)=>{if(method==='thread/resume'){resumes++;return new Promise(resolve=>release=resolve);}return actual(method,args);};
 const rpc=r.terminalRpc={connected:true,reply(){}};r.terminalNotificationSource=true;
 r.event({method:'turn/started',params:{threadId:s.nativeId,turn:{id:'a'}}});
 r.event({id:7,method:'item/commandExecution/requestApproval',params:{threadId:s.nativeId,command:'Synthetic command',cwd:s.cwd}},rpc);
 const old=s.approval.requestId;r.observeTerminalContext({kind:'disconnected',rpc});
 assert.equal(s.approval,null);assert.equal(r.chatAvailable,false);assert.equal(r.nativeActivity.stale,true);assert.equal(r.terminalRpc,null);
 assert.throws(()=>w.approve(s.id,old,'accept','window'),/权限请求已变化/);
 release({thread:{id:s.nativeId,status:{type:'idle'}}});await r.observing;
 assert.equal(r.chatAvailable,true);assert.equal(r.nativeObservationPending,false);assert.equal(s.state,'idle');
 r.terminalRpc=rpc;r.terminalNotificationSource=true;r.stopped=true;r.observeTerminalContext({kind:'disconnected',rpc});
 assert.equal(r.terminalNotificationSource,false);assert.equal(r.terminalRpc,null);assert.equal(resumes,1,'Stop cannot reopen a native subscription');
});
test('authoritative catch-up replaces a missed partial while preserving an interrupted native cut',()=>{
 const s={provider:'codex',nativeId:'native',messages:[{id:'partial',nativeId:'native',role:'assistant',status:'streaming',text:'Old partial',turnId:'a'},{id:'cut',nativeId:'native',role:'assistant',status:'interrupted',text:'Observed cut',turnId:'b'}]};
 applyCodexHistory(s,[{id:'partial',type:'agentMessage',text:'Completed during the gap',turnId:'a'},{id:'cut',type:'agentMessage',text:'Untrusted late completion',turnId:'b'}],{},()=>{},undefined,true);
 assert.equal(s.messages.find(m=>m.id==='partial').text,'Completed during the gap');assert.equal(s.messages.find(m=>m.id==='partial').status,'complete');
 assert.equal(s.messages.find(m=>m.id==='cut').text,'Observed cut');assert.equal(s.messages.find(m=>m.id==='cut').status,'interrupted');
});
test('source catch-up cannot append an unknown suffix to an old partial before an interruption',async t=>{
 const {r,s,host}=fixture(t);let resume,history;
 host.rpc.call=async(method)=>method==='thread/resume'?new Promise(resolve=>resume=resolve):method==='thread/items/list'?new Promise(resolve=>history=resolve):{data:[]};
 r.turnId='turn';r.latestState='working';s.state='working';
 applyCodexDelta(s,{id:'cached',turnId:'turn',text:'FIRST'});r.liveMessageItems.add('cached');
 const rpc=r.terminalRpc={connected:true};r.terminalNotificationSource=true;
 r.observeTerminalContext({kind:'disconnected',rpc});resume({thread:{id:s.nativeId,status:{type:'active',activeFlags:[]}}});await new Promise(resolve=>setImmediate(resolve));
 r.event({method:'item/agentMessage/delta',params:{threadId:s.nativeId,turnId:'turn',itemId:'cached',delta:'TAIL'}});
 assert.equal(s.messages.find(m=>m.id==='cached').text,'FIRST','Unknown suffix must wait for an authoritative full item');
 r.event({method:'turn/completed',params:{threadId:s.nativeId,turn:{id:'turn',status:'interrupted'}}});
 history({data:[{turnId:'turn',item:{id:'cached',type:'agentMessage',text:'FIRSTMIDDLETAIL'}}]});await r.observing;
 const row=s.messages.find(m=>m.id==='cached');assert.equal(row.text,'FIRST');assert.equal(row.status,'interrupted');assert.equal(row.incomplete,true,'An observation gap cannot claim the exact native cut');
});

function capacityFixture(t) {
 const f=fixture(t);f.s.roomId=null;f.s.view='chat';f.r.chatAvailable=true;f.host.rpc.nativeVersion='0.164.0';f.calls=[];f.goalReads=[];
 f.host.rpc.call=async(method,params)=>{if(method==='thread/goal/get'){f.goalReads.push(params);return {goal:f.goal??null};}f.calls.push({method,params});return {turn:{id:'automatic-'+f.calls.length}};};
 f.start=id=>f.r.event({method:'turn/started',params:{threadId:f.s.nativeId,turn:{id}}});
 f.end=(id,code='serverOverloaded',status='failed',message='NATIVE ORIGINAL')=>f.r.event({method:'turn/completed',params:{threadId:f.s.nativeId,turn:{id,status,error:status==='failed'?{message,codexErrorInfo:code}:null}}});
 f.fail=(id='original',code='serverOverloaded',message='NATIVE ORIGINAL')=>{f.start(id);f.end(id,code,'failed',message);};return f;
}
const capacityTick=()=>new Promise(resolve=>setImmediate(resolve));
const routingError='workspace routing discovery timed out';
for(const failure of ['authorization','change notification'])test('steer preparation failure releases its marker and drains an observed overload: '+failure,async t=>{
 const f=capacityFixture(t);f.host.rpc.nativeVersion='0.165.0';f.s.roomId='shared';f.start('live');
 const fail=()=>{f.end('live');throw Error('Synthetic preparation failure');};
 if(failure==='authorization')f.w.sharedReplies.authorize=fail;
 else {let raised=false;f.w.on('change',()=>{if(!raised&&f.r.pendingSteer){raised=true;fail();}});}
 await assert.rejects(f.w.steer(f.s.id,'Human refinement','window','live',{}),/Synthetic preparation failure/);
 assert.equal(f.r.pendingSteer,null);assert.equal(f.r.turnId,null);assert.equal(f.w.capacityStatus(f.s.id),null);
 f.w.tickCapacity(Date.now()+86400000);await capacityTick();assert.equal(f.calls.length,0,'No native input or continuation after failed preparation');
});
for(const outcome of ['accepted','ACK lost','wrong turn','new draft','edited then cleared','human input','owner changed','cancelled'])test('overload before steer ACK preserves recovery only for the accepted unchanged input: '+outcome,async t=>{
 const f=capacityFixture(t);f.host.rpc.nativeVersion='0.165.0';f.start('live');
 const read=f.host.rpc.call;let accept,reject;
 f.host.rpc.call=(method,params)=>method==='turn/steer'?new Promise((yes,no)=>{accept=yes;reject=no;}):read(method,params);
 f.w.setDraft(f.s.id,'Refine the existing task','window');
 const sending=f.w.steer(f.s.id,'Refine the existing task','window','live');
 const rejected=outcome==='ACK lost'||outcome==='wrong turn'?assert.rejects(sending):null;
 f.end('live');assert.equal(f.w.capacityStatus(f.s.id),null,'Unsettled native input cannot authorize recovery');
 if(outcome==='new draft')f.w.setDraft(f.s.id,'New human direction','window');
 if(outcome==='edited then cleared'){f.w.setDraft(f.s.id,'Human edit','window');f.w.setDraft(f.s.id,'','window');}
 if(outcome==='human input')f.r.emit('nativeInput','Human terminal direction',{turnId:'live'});
 if(outcome==='owner changed')f.w.claim(f.s.id,'other-window','chat');
 if(outcome==='cancelled')await f.w.interrupt(f.s.id,'window');
 if(outcome==='ACK lost')reject(Error('Synthetic lost ACK'));else accept({turnId:outcome==='wrong turn'?'other':'live'});
 if(rejected)await rejected;else await sending;
 assert.equal(f.r.pendingSteer,null);assert.equal(f.r.turnId,null,'The exact completed native turn is drained after the input settles');
 const recovery=f.w.capacityStatus(f.s.id);
 if(outcome==='accepted'){
  assert.ok(recovery,'A confirmed steer must not swallow the subsequent typed overload');
  assert.equal(f.w.drafts.get(f.s.id),'');f.w.tickCapacity(recovery.due);await capacityTick();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].params.input[0].text,'继续');
 }else{assert.equal(recovery,null);f.w.tickCapacity(Date.now()+86400000);await capacityTick();assert.equal(f.calls.filter(c=>c.method==='turn/start').length,0);}
 assert.equal(f.s.messages.filter(m=>m.inputMode==='steer').length,1,'Never replay the human instruction');
});
for(const version of ['0.164.0','0.165.0'])for(const cause of ['capacity','routing'])test('qualified native '+version+' recovers only the exact terminal transient cause: '+cause,async t=>{
 const f=capacityFixture(t);f.host.rpc.nativeVersion=version;
 const error={message:cause==='routing'?routingError:'NATIVE ORIGINAL',codexErrorInfo:cause==='routing'?'other':'serverOverloaded'};
 f.start('live');f.r.event({method:'error',params:{threadId:f.s.nativeId,turnId:'live',willRetry:true,error}});
 assert.equal(f.w.capacityStatus(f.s.id),null,'Intermediate native retries remain native');
 f.end('live',error.codexErrorInfo,'failed',error.message);
 const recovery=f.w.capacityStatus(f.s.id);assert.ok(recovery);assert.equal(recovery.reason,cause);assert.ok(recovery.due-Date.now()>119000);
 f.w.tickCapacity(recovery.due);await capacityTick();assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].params.input,[{type:'text',text:'继续',text_elements:[]}]);
 assert.ok(f.s.messages.some(m=>m.kind==='notice'&&m.text===error.message),'Original native error retained');
 assert.ok(f.s.messages.some(m=>m.name==='NAW'&&m.text.includes(cause==='routing'?'路由发现超时':'模型满载')));
});
for(const [label,code,message,status] of [
 ['other message','other','An unrelated failure','failed'],['prefix','other','prefix '+routingError,'failed'],
 ['suffix','other',routingError+'.','failed'],['wrong case','other','Workspace routing discovery timed out','failed'],
 ['missing message','other',null,'failed'],['wrong enum','Other',routingError,'failed'],
 ['code absent',null,routingError,'failed'],['text-only error','badRequest',routingError,'failed'],
 ['interrupted','other',routingError,'interrupted'],['completed','other',routingError,'completed']
])test('routing recovery rejects '+label,t=>{
 const f=capacityFixture(t);f.host.rpc.nativeVersion='0.165.0';f.start('live');f.end('live',code,status,message);
 assert.equal(f.w.capacityStatus(f.s.id),null);assert.equal(f.calls.length,0);
});
for(const version of ['0.163.0','0.166.0',undefined])test('unqualified native version has no recovery: '+version,t=>{
 const f=capacityFixture(t);f.host.rpc.nativeVersion=version;f.fail('overload');assert.equal(f.w.capacityStatus(f.s.id),null);
 f.fail('routing','other',routingError);assert.equal(f.w.capacityStatus(f.s.id),null);
});
test('terminal-only native error retains exact message and details without requiring an intermediate notification',t=>{
 const f=capacityFixture(t);f.start('live');
 f.r.event({method:'turn/completed',params:{threadId:f.s.nativeId,turn:{id:'live',status:'failed',error:{message:routingError,codexErrorInfo:'other',additionalDetails:'Native exact details'}}}});
 assert.equal(f.s.messages.filter(m=>m.kind==='notice'&&m.text===routingError+'\n\nNative exact details').length,1);
});
for(const different of [false,true])test('terminal native error deduplicates an identical notice and preserves a different retry error: '+different,t=>{
 const f=capacityFixture(t);f.start('live');
 f.r.event({method:'error',params:{threadId:f.s.nativeId,turnId:'live',willRetry:true,error:{message:different?'Earlier native retry':routingError,codexErrorInfo:'other'}}});
 f.end('live','other','failed',routingError);
 assert.equal(f.s.messages.filter(m=>m.kind==='notice'&&m.text===routingError).length,1);
 if(different)assert.ok(f.s.messages.some(m=>m.text==='Earlier native retry'));
});
test('malformed completed turn without its required thread ID cannot arm recovery',t=>{
 const f=capacityFixture(t);f.host.rpc.nativeVersion='0.165.0';f.start('live');
 f.r.event({method:'turn/completed',params:{turn:{id:'live',status:'failed',error:{message:routingError,codexErrorInfo:'other'}}}});
 assert.equal(f.w.capacityStatus(f.s.id),null);assert.equal(f.calls.length,0);
});
test('routing history, foreign and duplicate terminal events cannot arm or renew recovery',t=>{
 const f=capacityFixture(t);f.host.rpc.nativeVersion='0.165.0';f.end('old','other','failed',routingError);assert.equal(f.w.capacityStatus(f.s.id),null);
 f.r.event({method:'turn/started',params:{threadId:'foreign',turn:{id:'other'}}});f.end('other','other','failed',routingError);assert.equal(f.w.capacityStatus(f.s.id),null);
 f.fail('live','other',routingError);const scheduled=f.w.capacityStatus(f.s.id);f.end('live','other','failed',routingError);assert.deepEqual(f.w.capacityStatus(f.s.id),scheduled);
});
test('routing and capacity failures share the same bounded three-attempt budget',async t=>{
 const f=capacityFixture(t);f.host.rpc.nativeVersion='0.165.0';f.fail('original','other',routingError);
 for(let n=1;n<=3;n++){
  const recovery=f.w.capacityStatus(f.s.id);assert.equal(recovery.attempt,n-1);assert.ok(recovery.due-Date.now()>[120000,300000,600000][n-1]-1000);
  f.w.tickCapacity(recovery.due);await capacityTick();assert.equal(f.calls.length,n);
  f.start('automatic-'+n);f.end('automatic-'+n,n===1?'serverOverloaded':'other','failed',n===1?'NATIVE ORIGINAL':routingError);
 }
 assert.equal(f.w.capacityStatus(f.s.id).status,'exhausted');assert.equal(f.w.capacityStatus(f.s.id).reason,'routing');
 f.w.tickCapacity(Date.now()+86400000);assert.equal(f.calls.length,3);
});
for(const stop of ['draft','cancel','paused goal','goal read pending'])test('routing recovery preserves the existing human/goal boundary: '+stop,async t=>{
 const f=capacityFixture(t);f.host.rpc.nativeVersion='0.165.0';f.fail('original','other',routingError);
 const due=f.w.capacityStatus(f.s.id).due;let release;
 if(stop==='draft')f.w.setDraft(f.s.id,'Human unsent draft','window');
 if(stop==='cancel')await f.w.interrupt(f.s.id,'window');
 if(stop==='paused goal')f.goal={threadId:f.s.nativeId,status:'paused',objective:'Human paused this',tokenBudget:42};
 if(stop==='goal read pending')f.host.rpc.call=async()=>new Promise(resolve=>{release=resolve;});
 f.w.tickCapacity(due);
 if(stop==='goal read pending'){await f.w.interrupt(f.s.id,'window');release({goal:null});}
 await capacityTick();assert.equal(f.calls.length,0);assert.equal(f.w.capacityStatus(f.s.id),null);
 if(stop==='draft')assert.equal(f.w.drafts.get(f.s.id),'Human unsent draft');
 if(stop==='paused goal')assert.equal(f.goal.status,'paused');
});
for(const member of [false,true])test('automatic capacity continuation only pauses collaboration containing its session: '+member,async t=>{
 const f=capacityFixture(t),{w,s}=f;f.fail();
 const ids=member?[s.id,'other']:['other','peer'];
 const run=w.room.run={id:'existing-run',ids,status:'running',deadline:Date.now()+600000};
 const {PeerLeases}=require('../peer-handoffs.cjs');w.peerLeases=new PeerLeases(w);
 const grant={id:'existing-grant',ids,status:'running',client:{}};w.peerLeases.leases.set(grant.id,grant);
 const wake=require('../session-wake.cjs'),boundary=wake.boundary(w);
 w.tickCapacity(w.capacityStatus(s.id).due);await capacityTick();
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'turn/start');
 assert.equal(wake.boundary(w),boundary,'Automatic recovery never creates a human global wake boundary');
 assert.deepEqual(f.calls[0].params.input,[{type:'text',text:'继续',text_elements:[]}]);
 assert.equal(run.status,member?'paused':'running');assert.equal(grant.status,member?'paused':'running');
 assert.equal(w.room.messages.some(m=>m.text.includes('模型满载自动继续')),member);
});
test('human input in an independent session still pauses all collaboration',async t=>{
 const f=capacityFixture(t),{w,s}=f;
 const run=w.room.run={id:'existing-run',ids:['other','peer'],status:'running',deadline:Date.now()+600000};
 const {PeerLeases}=require('../peer-handoffs.cjs');w.peerLeases=new PeerLeases(w);
 const grant={id:'existing-grant',ids:['other','peer'],status:'running',client:{}};w.peerLeases.leases.set(grant.id,grant);
 await w.send(s.id,'New human instruction','window');
 assert.equal(run.status,'paused');assert.equal(run.reason,'真人输入优先');assert.equal(grant.status,'paused');
 assert.equal(f.calls.length,1);
});
for(const human of [false,true])test('a prepared peer-only authorization remains usable after independent recovery, but human input revokes it: '+human,async t=>{
 const f=capacityFixture(t),{w,s}=f;f.fail();
 const {PeerLeases,identity}=require('../peer-handoffs.cjs'),{EventEmitter}=require('node:events');
 w.peerLeases=new PeerLeases(w);
 const peer={id:'local-peer',nativeId:randomUUID(),provider:'codex',owner:'window',roomId:'shared',state:'idle',messages:[],controlRevision:0,memberRevision:0};
 const runtime=new EventEmitter();runtime.chatAvailable=true;runtime.send=async(text,tag,guard)=>{assert.ok(guard());runtime.emit('submitted',tag);};
 w.sessions.set(peer.id,peer);w.runtimes.set(peer.id,runtime);w.bind(peer,runtime);
 const client={},runId=randomUUID();
 w.peerLeases.prepare(client,'window',{id:runId,ids:[peer.id,'remote-peer'],expected:{[peer.id]:identity(peer)},names:{[peer.id]:'B','remote-peer':'C'},deadline:Date.now()+600000,maxSteps:2});
 const grant=w.peerLeases.leases.get(runId);assert.equal(w.peerLeases.valid(grant),true);
 if(human)await w.send(s.id,'Human priority','window');else {w.tickCapacity(w.capacityStatus(s.id).due);await capacityTick();}
 assert.equal(grant.status,human?'paused':'running');assert.equal(w.peerLeases.valid(grant),!human);
 const step={runId,step:1,sessionId:peer.id,text:'Authorized handoff',displayText:'Selected material',sourceId:randomUUID(),senderId:null};
 if(human)await assert.rejects(w.peerLeases.send(client,'window',step),/失效/);else assert.ok((await w.peerLeases.send(client,'window',step)).tag);
 assert.equal(f.calls.length,1);
});
test('capacity failure and continuation never reactivate an actual prepared member lease',async t=>{
 const f=capacityFixture(t),{w,s}=f;s.roomId='shared';
 const {PeerLeases,identity}=require('../peer-handoffs.cjs');w.peerLeases=new PeerLeases(w);
 const client={},id=randomUUID();w.peerLeases.prepare(client,'window',{id,ids:[s.id,'remote-peer'],expected:{[s.id]:identity(s)},names:{[s.id]:'A','remote-peer':'B'},deadline:Date.now()+600000,maxSteps:2});
 const grant=w.peerLeases.leases.get(id);assert.equal(w.peerLeases.valid(grant),true);f.fail();assert.equal(grant.status,'paused');
 w.tickCapacity(w.capacityStatus(s.id).due);await capacityTick();assert.equal(f.calls.length,1);assert.equal(grant.status,'paused');assert.equal(w.peerLeases.valid(grant),false);
});
test('live terminal overload alone schedules a delayed new continuation; three attempts then stop without task replay',async t=>{
 const f=capacityFixture(t),{w,r,s,calls}=f;s.messages.push({id:'original-input',role:'user',text:'Original task with side effects',status:'submitted'});
 f.start('original');r.event({method:'error',params:{threadId:s.nativeId,turnId:'original',willRetry:true,error:{message:'NATIVE ORIGINAL',codexErrorInfo:'serverOverloaded'}}});
 assert.equal(w.capacityStatus(s.id),null,'Native retry stays in charge');f.end('original');
 const first=w.capacityStatus(s.id);assert.equal(first.status,'scheduled');assert.ok(first.due-Date.now()>119000);w.tickCapacity(first.due-1);assert.equal(calls.length,0);
 for(let n=1;n<=3;n++){
  const scheduled=w.capacityStatus(s.id);assert.equal(scheduled.attempt,n-1);const remaining=scheduled.due-Date.now();assert.ok(remaining>[120000,300000,600000][n-1]-1000);
  w.tickCapacity(scheduled.due);w.tickCapacity(scheduled.due+1);await capacityTick();assert.equal(calls.length,n,'One send even if tick runs again before acknowledgement');
  assert.equal(calls[n-1].method,'turn/start');assert.equal(calls[n-1].params.threadId,s.nativeId);assert.deepEqual(calls[n-1].params.input,[{type:'text',text:'继续',text_elements:[]}]);
  assert.equal(s.messages.filter(m=>m.origin==='capacity-recovery').length,n);assert.equal(s.messages.find(m=>m.origin==='capacity-recovery').name,'NAW');
  f.start('automatic-'+n);f.end('automatic-'+n);
 }
 assert.equal(w.capacityStatus(s.id).status,'exhausted');w.tickCapacity(Date.now()+86400000);await capacityTick();assert.equal(calls.length,3);
 assert.ok(s.messages.some(m=>m.name==='NAW'&&m.text.includes('3 次上限')));assert.ok(s.messages.some(m=>m.text==='NATIVE ORIGINAL'));assert.equal(w.room.messages.length,0);
 assert.equal(s.messages.filter(m=>m.text==='Original task with side effects').length,1);assert.equal(w.versions.dispatches,3);
});
for(const code of ['usageLimitExceeded','sessionBudgetExceeded','rateLimitExceeded','unauthorized','badRequest','server_overloaded',null])test('no automatic continuation for non-capacity code '+code,t=>{
 const f=capacityFixture(t);f.fail('failure',code);assert.equal(f.w.capacityStatus(f.s.id),null);f.w.tickCapacity(Date.now()+86400000);assert.equal(f.calls.length,0);
});
test('history-only, old-thread and duplicate outcomes never arm or renew capacity recovery',t=>{
 const f=capacityFixture(t);f.end('historical');assert.equal(f.w.capacityStatus(f.s.id),null);
 f.r.event({method:'turn/started',params:{threadId:'another-thread',turn:{id:'foreign'}}});f.end('foreign');assert.equal(f.w.capacityStatus(f.s.id),null);
 f.fail();const before=f.w.capacityStatus(f.s.id);f.end('original');assert.deepEqual(f.w.capacityStatus(f.s.id),before);
});
for(const [name,change] of [
 ['draft',f=>f.w.setDraft(f.s.id,'new human draft','window')],
 ['native key',f=>{f.s.view='terminal';f.r.terminal={alive:true,input(){}};f.w.input(f.s.id,'a','window');}],
 ['new native turn',f=>f.start('human-turn')],
 ['takeover',f=>f.w.claim(f.s.id,'another-window')],
 ['membership',f=>f.w.join(f.s.id,true)],
 ['thread',f=>f.s.nativeId=randomUUID()],
 ['connection',f=>f.r.transportDisconnected=true],
 ['runtime lifecycle',f=>f.r.lifecycleRevision++],
 ['archive',f=>f.s.archived=true],
 ['approval',f=>f.r.emit('state','approval')],
 ['save failure',f=>f.w.storageWarning='disk full']
])test('capacity recovery cancels on '+name,async t=>{
 const f=capacityFixture(t);f.fail();change(f);f.w.tickCapacity(Date.now()+86400000);await capacityTick();assert.equal(f.calls.length,0);assert.equal(f.w.capacityStatus(f.s.id),null);
});
test('explicit cancel stops a scheduled recovery without sending a native interrupt',async t=>{
 const f=capacityFixture(t);f.fail();await f.w.interrupt(f.s.id,'window');assert.equal(f.calls.length,0);assert.equal(f.w.capacityStatus(f.s.id),null);
});
test('successful continuation clears the retry chain and preserves model/settings; uncertain receipt never retries',async t=>{
 const f=capacityFixture(t);f.s.model='unchanged-model';f.r.nativeSettings={model:'unchanged-model',effort:'ultra'};f.fail();f.w.tickCapacity(f.w.capacityStatus(f.s.id).due);await capacityTick();
 f.start('automatic-1');f.end('automatic-1',null,'completed');assert.equal(f.w.capacityStatus(f.s.id),null);assert.equal(f.s.model,'unchanged-model');assert.equal(f.r.nativeSettings.effort,'ultra');
 f.fail('later');assert.equal(f.w.capacityStatus(f.s.id).attempt,0);f.host.rpc.call=async method=>{if(method==='thread/goal/get')return {goal:null};throw Error('ACK lost');};f.w.tickCapacity(f.w.capacityStatus(f.s.id).due);await capacityTick();
 assert.equal(f.w.capacityStatus(f.s.id),null);assert.ok(f.s.messages.some(m=>m.text.includes('接收结果未确认')));f.w.tickCapacity(Date.now()+86400000);assert.equal(f.calls.length,1);
});
test('pending recovery is not restored by service restart or inferred from an old failure',t=>{
 const f=capacityFixture(t);f.fail();f.w.persist();const stored=JSON.parse(fs.readFileSync(path.join(f.dir,'workspace.json')));assert.equal(stored.sessions[0].capacityRecovery,undefined);
 const restored=new Workspace({binaries:{},close(){}},f.dir);t.after(()=>restored.close());assert.equal(restored.capacityStatus(f.s.id),null);restored.tickCapacity(Date.now()+86400000);assert.equal(f.calls.length,0);
});
test('a non-owner send rejection does not cancel the owner capacity schedule',async t=>{
 const f=capacityFixture(t);f.fail();const scheduled=f.w.capacityStatus(f.s.id);
 await assert.rejects(f.w.send(f.s.id,'not mine','another-window'),/接管/);
 assert.deepEqual(f.w.capacityStatus(f.s.id),scheduled);assert.equal(f.calls.length,0);
});
for(const status of ['blocked','paused','usageLimited','budgetLimited'])test('capacity recovery preserves a stopped native goal: '+status,async t=>{
 const f=capacityFixture(t);f.goal={threadId:f.s.nativeId,status,objective:'Keep this native objective',tokenBudget:123,tokensUsed:42};const before={...f.goal};
 f.fail();f.w.tickCapacity(f.w.capacityStatus(f.s.id).due);await capacityTick();
 assert.deepEqual(f.goal,before);assert.equal(f.goalReads.length,1);assert.equal(f.calls.length,0,'No turn/start or goal mutation');assert.equal(f.w.capacityStatus(f.s.id),null);
 assert.ok(f.s.messages.some(m=>m.name==='NAW'&&m.text.includes('goal 为 '+status)));assert.equal(f.s.messages.filter(m=>m.origin==='capacity-recovery').length,0);
 if(status==='blocked')assert.ok(f.s.messages.some(m=>m.text.includes('/goal resume')));
});
for(const status of ['active','complete'])test('capacity metadata read never changes an existing goal: '+status,async t=>{
 const f=capacityFixture(t);f.goal={threadId:f.s.nativeId,status,objective:'Unchanged',tokenBudget:null};const before={...f.goal};f.fail();f.w.tickCapacity(f.w.capacityStatus(f.s.id).due);await capacityTick();
 assert.deepEqual(f.goal,before);assert.equal(f.goalReads.length,1);assert.deepEqual(f.calls.map(c=>c.method),['turn/start']);
});
for(const result of [{}, {goal:{threadId:'another-thread',status:'blocked'}}, {goal:{status:'new-unknown-state'}}])test('unverified native goal prevents an automatic write: '+JSON.stringify(result),async t=>{
 const f=capacityFixture(t),methods=[];f.host.rpc.call=async method=>{methods.push(method);return result;};f.fail();f.w.tickCapacity(f.w.capacityStatus(f.s.id).due);await capacityTick();assert.deepEqual(methods,['thread/goal/get']);
 assert.equal(f.calls.length,0);assert.equal(f.w.capacityStatus(f.s.id),null);assert.ok(f.s.messages.some(m=>m.name==='NAW'&&m.text.includes('无法核对原生 goal')));
});
test('goal metadata failure stops recovery without exposing the internal error',async t=>{
 const f=capacityFixture(t);let calls=0;f.host.rpc.call=async()=>{calls++;throw Error('Private transport detail');};f.fail();f.w.tickCapacity(f.w.capacityStatus(f.s.id).due);await capacityTick();
 assert.equal(calls,1);assert.equal(f.w.capacityStatus(f.s.id),null);assert.ok(!f.s.messages.some(m=>m.text.includes('Private transport detail')));
});
for(const action of ['draft','cancel'])test('human '+action+' wins during a held goal metadata read',async t=>{
 const f=capacityFixture(t),methods=[];let release;f.host.rpc.call=async method=>{methods.push(method);return new Promise(resolve=>release=resolve);};f.fail();
 const due=f.w.capacityStatus(f.s.id).due;f.w.tickCapacity(due);f.w.tickCapacity(due+1);assert.equal(f.w.capacityStatus(f.s.id).status,'scheduled','Cancel remains available');
 if(action==='draft')f.w.setDraft(f.s.id,'Human input wins','window');else await f.w.interrupt(f.s.id,'window');
 release({goal:null});await capacityTick();assert.deepEqual(methods,['thread/goal/get']);assert.equal(f.w.capacityStatus(f.s.id),null);assert.equal(f.calls.length,0);assert.equal(f.s.messages.filter(m=>m.origin==='capacity-recovery').length,0);
});
test('a late metadata failure cannot append an old notice into a new native context',async t=>{
 const f=capacityFixture(t);let reject;f.host.rpc.call=async()=>new Promise((_,no)=>reject=no);f.fail();f.w.tickCapacity(f.w.capacityStatus(f.s.id).due);
 f.s.nativeId=randomUUID();const count=f.s.messages.length;reject(Error('Old context'));await capacityTick();assert.equal(f.w.capacityStatus(f.s.id),null);assert.equal(f.s.messages.length,count);
});
test('a plain capacity turn still continues when native goals are explicitly disabled',async t=>{
 const f=capacityFixture(t),call=f.host.rpc.call;f.host.rpc.call=async(method,params)=>{if(method==='thread/goal/get')throw Object.assign(Error('Native interface rejected request'),{nativeGoalsDisabled:true});return call(method,params);};
 f.fail();f.w.tickCapacity(f.w.capacityStatus(f.s.id).due);await capacityTick();assert.deepEqual(f.calls.map(c=>c.method),['turn/start']);assert.ok(!f.s.messages.some(m=>m.text.includes('无法核对')));
});
for(const [code,message,disabled] of [[-32600,'goals feature is disabled',true],[-32603,'goals feature is disabled',false],[-32600,'goals feature is disabled: unverified suffix',false]])test('only the exact native goals-disabled protocol rejection is classified: '+code+' '+message,async()=>{
 const {EventEmitter}=require('node:events'),{Rpc}=require('../adapters.cjs'),ws=new EventEmitter();ws.readyState=1;ws.send=()=>{};const rpc=new Rpc(ws);
 const pending=rpc.call('thread/goal/get',{threadId:'owned'});ws.emit('message',JSON.stringify({id:1,error:{code,message}}));
 await assert.rejects(pending,error=>error.nativeGoalsDisabled===disabled&&!error.message.includes('goals feature is disabled'));ws.emit('close');
});
