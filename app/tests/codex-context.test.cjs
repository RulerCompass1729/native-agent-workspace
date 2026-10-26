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
 f.end=(id,code='serverOverloaded',status='failed')=>f.r.event({method:'turn/completed',params:{threadId:f.s.nativeId,turn:{id,status,error:status==='failed'?{message:'NATIVE ORIGINAL',codexErrorInfo:code}:null}}});
 f.fail=(id='original',code='serverOverloaded')=>{f.start(id);f.end(id,code);};return f;
}
const capacityTick=()=>new Promise(resolve=>setImmediate(resolve));
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
