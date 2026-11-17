const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const repo=path.resolve(__dirname,'../..'),req=require('node:module').createRequire(path.join(repo,'app/tests/reviewer-fixture.cjs'));
const source=fs.readFileSync(path.join(repo,'app/tests/steward-standing-codex.test.cjs'),'utf8'),box={require:req,module:{exports:{}},process,Buffer,structuredClone,Date,setTimeout,clearTimeout};
vm.runInNewContext(source.slice(0,source.indexOf("test('Q06 Codex: fresh"))+'\nmodule.exports={fixture,effective,requiresCard};',box,{filename:path.join(repo,'app/tests/steward-standing-codex.test.cjs')});
const {fixture,effective,requiresCard}=box.module.exports;
function reply(f){return {thread:{id:f.peer.nativeId,cwd:f.dir,status:{type:'idle'},turns:[]},model:'synthetic-model',modelProvider:'openai',reasoningEffort:'high',approvalPolicy:'never',sandbox:{type:'dangerFullAccess'},activePermissionProfile:null,approvalsReviewer:'user'};}
test('reviewer: concurrent TUI resumes remain uncovered until BOTH requests settle',async t=>{
 const f=fixture(t),rpc={connected:true,nativeVersion:'0.168.0'};
 f.peer.view='terminal';f.runtime.terminal={alive:true};f.runtime.terminalNotificationSource=true;f.runtime.terminalRpc=rpc;f.observe(effective(),rpc);
 for(const key of ['older','newer'])f.runtime.observeTerminalContext({kind:'request',method:'thread/resume',threadId:f.peer.nativeId,key});
 f.runtime.observeTerminalContext({kind:'response',method:'thread/resume',threadId:f.peer.nativeId,key:'newer',rpc,result:reply(f)});
 const result=await f.ask();console.log('PENDING_OLDER_REQUEST',JSON.stringify({state:result.state,approvedBy:result.approvedBy,effects:f.effects.length,pending:Boolean(f.runtime.creationPermissionPending)}));
 assert.equal(result.state,'confirmation-required');assert.equal(f.effects.length,0);
});
test('reviewer: peer leaving the space during running audit prevents creation',async t=>{
 const f=fixture(t);f.observe();const original=f.controller.audit;f.controller.audit=row=>{const value=original(row);if(row.state==='running')f.peer.roomId=null;return value;};
 const result=await f.ask();assert.equal(result.state,'unconfirmed');assert.equal(f.effects.length,0);
});
for(const reviewer of [undefined,'guardian'])test('reviewer: unobserved or different approvals reviewer is not covered '+String(reviewer),async t=>{const f=fixture(t);f.observe(effective({approvalsReviewer:reviewer}));await requiresCard(f);});
test('reviewer: replacing the RPC during running audit prevents creation',async t=>{const f=fixture(t);f.observe();const original=f.controller.audit;f.controller.audit=row=>{const value=original(row);if(row.state==='running')f.host.rpc={connected:true,nativeVersion:'0.168.0'};return value;};assert.equal((await f.ask()).state,'unconfirmed');assert.equal(f.effects.length,0);});

test('reviewer: actual Unix bridge leaves older restrictive request outstanding after newer full-access response', {timeout:8000}, async t=>{
 const http=req('node:http'),net=req('node:net'),WebSocket=req('ws'),{once}=req('node:events');
 const {CodexTerminalBridge}=req('../codex-terminal-bridge.cjs'),f=fixture(t);
 const endpoint=path.join(f.dir,'display.sock'),upstream=path.join(f.dir,'native.sock');
 const server=http.createServer(),native=new WebSocket.Server({server});let remote;
 const observed=[],sent=[];
 await new Promise(r=>server.listen(upstream,r));
 native.on('connection',socket=>{remote=socket;socket.on('message',data=>{
   const m=JSON.parse(data);sent.push(m);
   if(m.id==='bootstrap')socket.send(JSON.stringify({id:m.id,result:reply(f)}));
   if(m.id==='newer')socket.send(JSON.stringify({id:m.id,result:reply(f)}));
 });});
 const bridge=await new CodexTerminalBridge(endpoint,upstream,e=>{observed.push(e);f.runtime.observeTerminalContext(e);}).start();
 const client=new WebSocket('ws://localhost',{createConnection:()=>net.connect(endpoint)});
 t.after(async()=>{f.runtime.stopped=true;client.terminate();bridge.close();for(const c of native.clients)c.terminate();await new Promise(r=>native.close(r));await new Promise(r=>server.close(r));});
 // Start with the previously bound display connection, using a real bridge response
 // to acquire its exact source RPC; only fixtures replace the native upstream.
 f.peer.view='terminal';f.runtime.terminal={alive:true};f.runtime.terminalNotificationSource=true;
 await once(client,'open');let returned=once(client,'message');
 client.send(JSON.stringify({id:'bootstrap',method:'thread/resume',params:{threadId:f.peer.nativeId}}));await returned;
 f.observe(effective(),f.runtime.terminalRpc);
 returned=once(client,'message');
 client.send(JSON.stringify({id:'older',method:'thread/resume',params:{threadId:f.peer.nativeId,approvalPolicy:'on-request',sandbox:'read-only'}}));
 client.send(JSON.stringify({id:'newer',method:'thread/resume',params:{threadId:f.peer.nativeId,approvalPolicy:'never',sandbox:'danger-full-access'}}));await returned;
 const state=[...bridge.connections][0],older=state.pending.get('older'),callsBefore=f.effects.length;
 assert.ok(older,'Actual bridge still retains the earlier native request');assert.equal(older.method,'thread/resume');
 assert.equal(sent.filter(x=>x.id==='older').length,1);
 const result=await f.ask();
 console.log('ACTUAL_BRIDGE',JSON.stringify({nativePending:state.pending.size,adapterPending:Boolean(f.runtime.creationPermissionPending),state:result.state,approvedBy:result.approvedBy,handlerCalls:f.effects.length-callsBefore}));
 // Even a later restrictive response cannot clear the stale permission: the
 // single latest-key record no longer recognizes the older response.
 returned=once(client,'message');remote.send(JSON.stringify({id:'older',result:{...reply(f),approvalPolicy:'on-request',sandbox:{type:'readOnly'}}}));await returned;
 const afterOlder=f.runtime.creationSettingsSnapshot?.()||null,post=await f.ask();
 console.log('AFTER_OLDER_RESTRICTED_REPLY',JSON.stringify({nativePending:state.pending.size,permission:afterOlder?.permissions?.approvalPolicy||null,state:post.state,approvedBy:post.approvedBy,totalHandlerCalls:f.effects.length}));
 assert.equal(result.state,'confirmation-required','Cannot exempt consent while an earlier permission change remains unresolved');
 assert.equal(f.effects.length,0);assert.equal(afterOlder,null,'Restrictive response must revoke full-access evidence');
});

for(const order of [['older','newer'],['newer','older']])test('Q06 concurrent full access becomes covered only after all replies: '+order.join(' then '),async t=>{
 const f=fixture(t),rpc={connected:true,nativeVersion:'0.168.0'};
 f.peer.view='terminal';f.runtime.terminal={alive:true};f.runtime.terminalNotificationSource=true;f.runtime.terminalRpc=rpc;f.observe(effective(),rpc);
 for(const key of ['older','newer'])f.runtime.observeTerminalContext({kind:'request',method:'thread/resume',threadId:f.peer.nativeId,key});
 await requiresCard(f);
 f.runtime.observeTerminalContext({kind:'response',method:'thread/resume',threadId:f.peer.nativeId,key:order[0],rpc,result:reply(f)});await requiresCard(f);
 f.runtime.observeTerminalContext({kind:'response',method:'thread/resume',threadId:f.peer.nativeId,key:order[1],rpc,result:reply(f)});
 const result=await f.ask();assert.equal(result.state,'complete');assert.equal(result.approvedBy,'standing');assert.equal(f.effects.length,1);assert.equal(f.runtime.creationPermissionPending,null);
});
for(const outcome of ['error','incomplete','different-model'])test('Q06 late '+outcome+' response revokes newer full-access evidence',async t=>{
 const f=fixture(t),rpc={connected:true,nativeVersion:'0.168.0'};
 f.peer.view='terminal';f.runtime.terminal={alive:true};f.runtime.terminalNotificationSource=true;f.runtime.terminalRpc=rpc;f.observe(effective(),rpc);
 for(const key of ['older','newer'])f.runtime.observeTerminalContext({kind:'request',method:'thread/resume',threadId:f.peer.nativeId,key});
 f.runtime.observeTerminalContext({kind:'response',method:'thread/resume',threadId:f.peer.nativeId,key:'newer',rpc,result:reply(f)});
 f.runtime.observeTerminalContext({kind:'response',method:'thread/resume',threadId:f.peer.nativeId,key:'older',rpc,error:outcome==='error',result:outcome==='error'?undefined:{...reply(f),...(outcome==='incomplete'?{approvalPolicy:undefined}:{model:'another-model'})}});
 assert.equal(f.runtime.creationSettingsSnapshot(),null);await requiresCard(f);
});

test('Q06 actual Unix bridge permits standing after both full-access replies settle', {timeout:8000},async t=>{
 const http=req('node:http'),net=req('node:net'),WebSocket=req('ws'),{once}=req('node:events'),{CodexTerminalBridge}=req('../codex-terminal-bridge.cjs'),f=fixture(t);
 const server=http.createServer(),native=new WebSocket.Server({server}),endpoint=path.join(f.dir,'display.sock'),upstream=path.join(f.dir,'native.sock');let remote;
 await new Promise(resolve=>server.listen(upstream,resolve));
 native.on('connection',socket=>{remote=socket;socket.on('message',data=>{const message=JSON.parse(data);if(['bootstrap','newer'].includes(message.id))socket.send(JSON.stringify({id:message.id,result:reply(f)}));});});
 const bridge=await new CodexTerminalBridge(endpoint,upstream,event=>f.runtime.observeTerminalContext(event)).start();
 const client=new WebSocket('ws://localhost',{createConnection:()=>net.connect(endpoint)});
 t.after(async()=>{f.runtime.stopped=true;client.terminate();bridge.close();for(const connection of native.clients)connection.terminate();await new Promise(resolve=>native.close(resolve));await new Promise(resolve=>server.close(resolve));});
 f.peer.view='terminal';f.runtime.terminal={alive:true};f.runtime.terminalNotificationSource=true;
 await once(client,'open');let returned=once(client,'message');client.send(JSON.stringify({id:'bootstrap',method:'thread/resume',params:{threadId:f.peer.nativeId}}));await returned;f.observe(effective(),f.runtime.terminalRpc);
 returned=once(client,'message');
 for(const id of ['older','newer'])client.send(JSON.stringify({id,method:'thread/resume',params:{threadId:f.peer.nativeId,approvalPolicy:'never',sandbox:'danger-full-access'}}));
 await returned;assert.equal([...bridge.connections][0].pending.size,1);await requiresCard(f);
 returned=once(client,'message');remote.send(JSON.stringify({id:'older',result:reply(f)}));await returned;
 assert.equal([...bridge.connections][0].pending.size,0);const result=await f.ask();assert.equal(result.state,'complete');assert.equal(result.approvedBy,'standing');assert.equal(f.effects.length,1);
});

test('Q06 unbound display disconnect clears only its own pending permission evidence',async t=>{
 const f=fixture(t),rpc={connected:true,nativeVersion:'0.168.0'};f.observe();
 f.runtime.observeTerminalContext({kind:'request',method:'thread/resume',threadId:f.peer.nativeId,key:'unbound',rpc});
 assert.ok(f.runtime.creationPermissionPending);f.runtime.observeTerminalContext({kind:'disconnected',rpc});
 assert.equal(f.runtime.creationPermissionPending,null);assert.equal(f.runtime.creationSettingsSnapshot(),null);
 f.observe();const result=await f.ask();assert.equal(result.state,'complete');assert.equal(f.effects.length,1);
});
test('Q06 unrelated disconnect cannot release a live permission request',async t=>{
 const f=fixture(t),rpc={connected:true,nativeVersion:'0.168.0'};
 f.peer.view='terminal';f.runtime.terminal={alive:true};f.runtime.terminalNotificationSource=true;f.runtime.terminalRpc=rpc;f.observe(effective(),rpc);
 f.runtime.observeTerminalContext({kind:'request',method:'thread/resume',threadId:f.peer.nativeId,key:'live',rpc});
 f.runtime.observeTerminalContext({kind:'disconnected',rpc:{connected:false}});assert.ok(f.runtime.creationPermissionPending);await requiresCard(f);
 f.runtime.observeTerminalContext({kind:'response',method:'thread/resume',threadId:f.peer.nativeId,key:'live',rpc,result:reply(f)});
 const result=await f.ask();assert.equal(result.state,'complete');assert.equal(f.effects.length,1);
});
test('Q06 actual bridge pins the existing RPC identity before the first response', {timeout:8000},async t=>{
 const http=req('node:http'),net=req('node:net'),WebSocket=req('ws'),{once}=req('node:events'),{CodexTerminalBridge}=req('../codex-terminal-bridge.cjs'),f=fixture(t);
 const server=http.createServer(),native=new WebSocket.Server({server}),endpoint=path.join(f.dir,'display.sock'),upstream=path.join(f.dir,'native.sock');
 await new Promise(resolve=>server.listen(upstream,resolve));
 let seen;const requested=new Promise(resolve=>{seen=resolve;});let disconnected;const closed=new Promise(resolve=>{disconnected=resolve;});
 const bridge=await new CodexTerminalBridge(endpoint,upstream,event=>{f.runtime.observeTerminalContext(event);if(event.kind==='request')seen(event);if(event.kind==='disconnected')disconnected(event);}).start();
 const client=new WebSocket('ws://localhost',{createConnection:()=>net.connect(endpoint)});
 t.after(async()=>{f.runtime.stopped=true;client.terminate();bridge.close();for(const connection of native.clients)connection.terminate();await new Promise(resolve=>native.close(resolve));await new Promise(resolve=>server.close(resolve));});
 await once(client,'open');client.send(JSON.stringify({id:'held',method:'thread/resume',params:{threadId:f.peer.nativeId}}));const request=await requested;
 assert.ok(request.rpc && typeof request.rpc.call==='function','Use the existing source RPC before the first response');
 client.terminate();const ended=await closed;assert.equal(ended.rpc,request.rpc);assert.equal(f.runtime.creationPermissionPending,null);assert.equal(f.runtime.creationSettingsSnapshot(),null);
});

test('Q06 concurrent settlement cannot refresh an aged permission request',async t=>{
 let now=1800000000000;t.mock.method(Date,'now',()=>now);
 const f=fixture(t),rpc={connected:true,nativeVersion:'0.168.0'};
 f.peer.view='terminal';f.runtime.terminal={alive:true};f.runtime.terminalNotificationSource=true;f.runtime.terminalRpc=rpc;f.observe(effective(),rpc);
 f.runtime.observeTerminalContext({kind:'request',method:'thread/resume',threadId:f.peer.nativeId,key:'older',rpc});
 f.runtime.observeTerminalContext({kind:'request',method:'thread/resume',threadId:f.peer.nativeId,key:'newer',rpc});
 f.runtime.observeTerminalContext({kind:'response',method:'thread/resume',threadId:f.peer.nativeId,key:'newer',rpc,result:reply(f)});now+=61000;
 f.runtime.observeTerminalContext({kind:'response',method:'thread/resume',threadId:f.peer.nativeId,key:'older',rpc,result:reply(f)});
 assert.equal(f.runtime.creationPermissionPending,null);assert.equal(f.runtime.creationSettingsSnapshot().permissions.observedAt,now-61000);await requiresCard(f);
 f.observe(effective(),rpc);const result=await f.ask();assert.equal(result.state,'complete');assert.equal(f.effects.length,1);
});

test('Q06 older compatible completion does not age out a newer still-fresh permission proof',async t=>{
 let now=1800000000000;t.mock.method(Date,'now',()=>now);
 const f=fixture(t),rpc={connected:true,nativeVersion:'0.168.0'};
 f.peer.view='terminal';f.runtime.terminal={alive:true};f.runtime.terminalNotificationSource=true;f.runtime.terminalRpc=rpc;f.observe(effective(),rpc);
 f.runtime.observeTerminalContext({kind:'request',method:'thread/resume',threadId:f.peer.nativeId,key:'older',rpc});now+=59000;
 f.runtime.observeTerminalContext({kind:'request',method:'thread/resume',threadId:f.peer.nativeId,key:'newer',rpc});
 f.runtime.observeTerminalContext({kind:'response',method:'thread/resume',threadId:f.peer.nativeId,key:'newer',rpc,result:reply(f)});await requiresCard(f);now+=2000;
 f.runtime.observeTerminalContext({kind:'response',method:'thread/resume',threadId:f.peer.nativeId,key:'older',rpc,result:reply(f)});
 assert.equal(f.runtime.creationSettingsSnapshot().permissions.observedAt,now-2000);
 const result=await f.ask();assert.equal(result.state,'complete');assert.equal(f.effects.length,1);
});
