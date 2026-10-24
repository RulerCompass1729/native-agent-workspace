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
