const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),net=require('node:net');
const {once}=require('node:events'),WebSocket=require('ws');
const {CodexTerminalBridge}=require('../codex-terminal-bridge.cjs');
const {randomUUID}=require('node:crypto');
test('native bridge preserves frames and source RPC; explicit close retires the source exactly once',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'naw-native-bridge-')),endpoint=path.join(dir,'display.sock'),upstream=path.join(dir,'native.sock');
 const server=http.createServer(),native=new WebSocket.Server({server}),observed=[];
 await new Promise(r=>server.listen(upstream,r));let remote;
 native.on('connection',socket=>{remote=socket;socket.on('message',(data,binary)=>{const m=JSON.parse(data);if(m.method==='thread/start')socket.send(JSON.stringify({id:m.id,result:{thread:{id:'real-native-context'}}}));});});
 const bridge=await new CodexTerminalBridge(endpoint,upstream,e=>observed.push(e)).start();
 const client=new WebSocket('ws://localhost',{createConnection:()=>net.connect(endpoint)});
 t.after(async()=>{client.terminate();bridge.close();for(const c of native.clients)c.terminate();await new Promise(r=>native.close(r));await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 await once(client,'open');const response=once(client,'message');client.send(JSON.stringify({id:1,method:'thread/start',params:{ephemeral:false,prompt:'Private bytes pass through unchanged'}}));
 assert.deepEqual(JSON.parse((await response)[0]),{id:1,result:{thread:{id:'real-native-context'}}});
 assert.equal(observed[0].kind,'request');assert.equal(observed[1].kind,'response');assert.equal(observed[0].key,observed[1].key);
 assert.ok(!JSON.stringify(observed).includes('Private bytes'),'Routing observation retains no prompt payload');
 const received=once(remote,'message');observed[1].rpc.reply('permission-1',{decision:'decline'});
 assert.deepEqual(JSON.parse((await received)[0]),{id:'permission-1',result:{decision:'decline'}});
 bridge.close();assert.equal(observed.filter(e=>e.kind==='disconnected').length,1);
 await new Promise(r=>setImmediate(r));bridge.close();assert.equal(observed.filter(e=>e.kind==='disconnected').length,1);
 assert.equal(observed[1].rpc.connected,false);assert.throws(()=>observed[1].rpc.reply(1,{}),/连接已变化/);
});

test('native plugin responses larger than 16 MiB pass unchanged and keep the display connected', { timeout: 10000 }, async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'naw-native-bridge-')),endpoint=path.join(dir,'display.sock'),upstream=path.join(dir,'native.sock');
 const server=http.createServer(),native=new WebSocket.Server({server}),observed=[];
 await new Promise(r=>server.listen(upstream,r));
 const payload=JSON.stringify({id:1,result:{marketplaces:[{name:'Synthetic plugin catalog',description:'x'.repeat(20*1024*1024)}]}});
 native.on('connection',socket=>socket.on('message',data=>{
  const m=JSON.parse(data);socket.send(m.id===1?payload:JSON.stringify({id:m.id,result:{alive:true}}));
 }));
 const bridge=await new CodexTerminalBridge(endpoint,upstream,e=>observed.push(e)).start();
 const client=new WebSocket('ws://localhost',{createConnection:()=>net.connect(endpoint)});
 t.after(async()=>{client.terminate();bridge.close();for(const c of native.clients)c.terminate();await new Promise(r=>native.close(r));await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 await once(client,'open');
 const receive=()=>Promise.race([once(client,'message').then(([data])=>data.toString()),once(client,'close').then(()=>{throw Error('Display disconnected before the native response');})]);
 const response=receive();client.send(JSON.stringify({id:1,method:'plugin/list',params:{}}));
 assert.equal(await response,payload,'The complete native response reaches the original display');
 const next=receive();client.send(JSON.stringify({id:2,method:'account/read',params:{}}));
 assert.deepEqual(JSON.parse(await next),{id:2,result:{alive:true}},'The same connection remains usable after the large response');
 assert.equal(observed.filter(e=>e.kind==='disconnected').length,0);
});

test('scoped calls use only the already-held native TUI socket and keep private responses out of its display', async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'naw-held-outbox-')), endpoint=path.join(dir,'display.sock'),upstream=path.join(dir,'native.sock');
 const server=http.createServer(),native=new WebSocket.Server({server}),observed=[],requests=[],display=[];let remote,hold=false,held;
 await new Promise(r=>server.listen(upstream,r));
 native.on('connection',socket=>{remote=socket;socket.on('message',data=>{
  const m=JSON.parse(data);requests.push(m);
  if(!m.method)return;
  if(m.method==='thread/start')return socket.send(JSON.stringify({id:m.id,result:{thread:{id:'original-thread'}}}));
  if(m.method==='thread/resume'&&m.id==='context-switch')return; // Native-owned context request remains pending.
  if(m.method==='turn/start'&&hold){held=m;return;}
  const result=m.method==='thread/goal/get'?{goal:null}:m.method==='thread/turns/list'?{data:[{id:'source-turn',status:'inProgress',itemsView:'notLoaded',items:[]}]}:{turn:{id:'accepted-turn'}};
  socket.send(JSON.stringify({id:m.id,result}));
 });});
 const bridge=await new CodexTerminalBridge(endpoint,upstream,e=>observed.push(e)).start();
 const client=new WebSocket('ws://localhost',{createConnection:()=>net.connect(endpoint)});
 t.after(async()=>{client.terminate();bridge.close();for(const c of native.clients)c.terminate();await new Promise(r=>native.close(r));await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 client.on('message',data=>display.push(JSON.parse(data)));
 await once(client,'open');const started=once(client,'message');client.send(JSON.stringify({id:1,method:'thread/start',params:{ephemeral:false}}));await started;
 const rpc=observed.find(e=>e.kind==='response').rpc;
 const task={threadId:'original-thread',clientUserMessageId:randomUUID(),input:[{type:'text',text:'  literal\r\n\t spaces  ',text_elements:[]}]};
 assert.deepEqual(await rpc.call('turn/start',task),{turn:{id:'accepted-turn'}});
 assert.deepEqual(await rpc.call('thread/turns/list',{threadId:'original-thread',limit:1,sortDirection:'desc',itemsView:'notLoaded'}),
  {data:[{id:'source-turn',status:'inProgress',itemsView:'notLoaded',items:[]}]});
 assert.deepEqual(await rpc.call('thread/goal/get',{threadId:'original-thread'}),{goal:null});
 const privateId=requests.find(r=>r.method==='turn/start').id;
 remote.send(JSON.stringify({id:privateId,result:{privateLate:'must not reach TUI'}}));
 const notice=once(client,'message');remote.send(JSON.stringify({method:'turn/started',params:{threadId:'original-thread',turn:{id:'accepted-turn'}}}));await notice;
 assert.equal(display.length,2);assert.equal(display[1].method,'turn/started');assert.equal(bridge.connections.size,1);assert.equal(native.clients.size,1);
 assert.deepEqual(requests[1].params,task);assert.equal(observed.filter(e=>e.kind==='native').length,1);
 for(const [method,params] of [['thread/resume',{threadId:'original-thread'}],['thread/read',{threadId:'original-thread'}],['thread/goal/set',{}],['thread/goal/get',{threadId:'foreign'}],['thread/goal/get',{threadId:'original-thread',extra:true}],
  ['thread/turns/list',{threadId:'original-thread',limit:2,sortDirection:'desc',itemsView:'notLoaded'}],['turn/start',{...task,threadId:'foreign'}],
  ['turn/start',{...task,model:'must not override'}]]) await assert.rejects(rpc.call(method,params));
 assert.equal(requests.length,4,'Forbidden scoped calls write no native frame');
 // Native approvals retain the existing pass-through; scoped calls never answer them.
 const approval=once(client,'message');remote.send(JSON.stringify({id:'approval',method:'item/commandExecution/requestApproval',params:{threadId:'original-thread'}}));await approval;
 const answer=once(remote,'message');client.send(JSON.stringify({id:'approval',result:{decision:'decline'}}));
 assert.deepEqual(JSON.parse((await answer)[0]),{id:'approval',result:{decision:'decline'}});
 hold=true;const pending=rpc.call('turn/start',task);const received=once(remote,'message');await received;
 assert.ok(held);bridge.close();await assert.rejects(pending);assert.equal(rpc.connected,false);
});

test('a pending native context switch prevents any scoped send on the old context', async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'naw-held-context-')),endpoint=path.join(dir,'display.sock'),upstream=path.join(dir,'native.sock');
 const server=http.createServer(),native=new WebSocket.Server({server}),observed=[];let remote,seen=0;
 native.on('connection',socket=>{remote=socket;socket.on('message',data=>{const m=JSON.parse(data);seen++;if(m.method==='thread/start')socket.send(JSON.stringify({id:m.id,result:{thread:{id:'original'}}}));});});
 await new Promise(r=>server.listen(upstream,r));const bridge=await new CodexTerminalBridge(endpoint,upstream,e=>observed.push(e)).start();
 const client=new WebSocket('ws://localhost',{createConnection:()=>net.connect(endpoint)});
 t.after(async()=>{client.terminate();bridge.close();for(const c of native.clients)c.terminate();await new Promise(r=>native.close(r));await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 await once(client,'open');const initial=once(client,'message');client.send(JSON.stringify({id:1,method:'thread/start',params:{ephemeral:false}}));await initial;
 const rpc=observed.find(e=>e.kind==='response').rpc,received=once(remote,'message');client.send(JSON.stringify({id:2,method:'thread/resume',params:{threadId:'new-context'}}));await received;
 await assert.rejects(rpc.call('turn/start',{threadId:'original',clientUserMessageId:randomUUID(),input:[{type:'text',text:'new task',text_elements:[]}]}));
 assert.equal(seen,2);
});

test('held native goal reads preserve only the exact disabled-feature flag without exposing private errors', async t => {
 const { nativeGoalStatus }=require('../session-wake.cjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'naw-held-goal-')),endpoint=path.join(dir,'display.sock'),upstream=path.join(dir,'native.sock');
 const server=http.createServer(),native=new WebSocket.Server({server}),observed=[],display=[],calls=[];
 let error={code:-32600,message:'goals feature is disabled'};
 native.on('connection',socket=>socket.on('message',data=>{const m=JSON.parse(data);calls.push(m);
  if(m.method==='thread/start')return socket.send(JSON.stringify({id:m.id,result:{thread:{id:'original'}}}));
  assert.equal(m.method,'thread/goal/get');socket.send(JSON.stringify({id:m.id,error}));
 }));
 await new Promise(r=>server.listen(upstream,r));const bridge=await new CodexTerminalBridge(endpoint,upstream,e=>observed.push(e)).start();
 const client=new WebSocket('ws://localhost',{createConnection:()=>net.connect(endpoint)});
 t.after(async()=>{client.terminate();bridge.close();for(const c of native.clients)c.terminate();await new Promise(r=>native.close(r));await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 client.on('message',data=>display.push(JSON.parse(data)));await once(client,'open');const started=once(client,'message');client.send(JSON.stringify({id:1,method:'thread/start',params:{ephemeral:false}}));await started;
 const rpc=observed.find(e=>e.kind==='response').rpc,s={provider:'codex',nativeId:'original'};
 assert.equal(await nativeGoalStatus(s,{},()=>true,rpc),null,'Native absence of the optional goal feature must not reject ordinary input');
 for(const variant of [{code:-32601,message:'goals feature is disabled'},{code:-32600,message:'PRIVATE unrelated server error'}]){
  error=variant;await assert.rejects(rpc.call('thread/goal/get',{threadId:'original'}),e=>e.nativeGoalsDisabled===false&&!e.message.includes('PRIVATE'));
  await assert.rejects(nativeGoalStatus(s,{},()=>true,rpc));
 }
 assert.equal(calls.filter(m=>m.method==='thread/goal/get').length,5);
 assert.equal(display.length,1,'Private scoped responses are never forwarded to the native display');
 assert.equal(native.clients.size,1,'No new original native connection or engine');
});

async function versionFixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'naw-tui-version-'));
 const endpoint=path.join(dir,'display.sock'),upstream=path.join(dir,'native.sock');
 const server=http.createServer(),native=new WebSocket.Server({server}),observed=[],requests=[];let remote;
 native.on('connection',socket=>{remote=socket;socket.on('message',data=>{
  const m=JSON.parse(data);requests.push(m);
  if(m.method==='thread/start')socket.send(JSON.stringify({id:m.id,result:{thread:{id:'original'}}}));
 });});
 await new Promise(r=>server.listen(upstream,r));
 const bridge=await new CodexTerminalBridge(endpoint,upstream,e=>observed.push(e)).start();
 const clients=[];
 t.after(async()=>{for(const c of clients)c.terminate();bridge.close();for(const c of native.clients)c.terminate();await new Promise(r=>native.close(r));await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 async function connect() {
  const client=new WebSocket('ws://localhost',{createConnection:()=>net.connect(endpoint)});clients.push(client);
  await once(client,'open');const reply=once(client,'message');
  client.send(JSON.stringify({id:'thread',method:'thread/start',params:{}}));await reply;
  const rpc=observed.filter(e=>e.kind==='response').at(-1).rpc;
  return {client,rpc};
 }
 const current=await connect();
 const send=async(client,frame)=>{const received=once(remote,'message');client.send(JSON.stringify(frame));assert.deepEqual(JSON.parse((await received)[0]),frame);};
 const reply=async(client,frame)=>{const received=once(client,'message');remote.send(JSON.stringify(frame));assert.deepEqual(JSON.parse((await received)[0]),frame);};
 return {...current,connect,send,reply,observed,requests};
}

const initialize=(version,id='init')=>({id,method:'initialize',params:{clientInfo:{name:'codex-tui',version},capabilities:{experimentalApi:true}}});

test('actual TUI initialize version is pinned only after its successful response; all frames pass unchanged', async t=>{
 const f=await versionFixture(t);
 assert.equal(f.rpc.nativeClientVersion,null);
 await f.send(f.client,initialize('0.167.0'));
 assert.equal(f.rpc.nativeClientVersion,null,'Unacknowledged initialize cannot qualify a draft');
 await f.reply(f.client,{id:'other',result:{userAgent:'codex/0.167.0'}});
 assert.equal(f.rpc.nativeClientVersion,null,'Unrelated response cannot confirm initialize');
 await f.reply(f.client,{id:'init',result:{userAgent:'codex/0.168.0'}});
 assert.equal(f.rpc.nativeClientVersion,'0.167.0','Use the TUI client version, never the server response version');
 assert.equal(Object.getOwnPropertyDescriptor(f.rpc,'nativeClientVersion').set,undefined);
 assert.deepEqual(f.requests[1],initialize('0.167.0'));
});

test('missing, malformed or failed TUI initialization never qualifies the terminal', async t=>{
 for(const [request,response] of [
  [initialize(undefined),{id:'init',result:{}}],
  [initialize({version:'0.167.0'}),{id:'init',result:{}}],
  [{method:'initialize',params:{clientInfo:{version:'0.167.0'}}},{result:{}}],
  [initialize('0.167.0'),{id:'init',error:{code:-32600,message:'Rejected'}}],
  [initialize('0.167.0'),{id:'init'}],
 ]) {
  const f=await versionFixture(t);await f.send(f.client,JSON.parse(JSON.stringify(request)));await f.reply(f.client,response);
  assert.equal(f.rpc.nativeClientVersion,null);
 }
});

test('duplicate initialize invalidates qualification even before the first response', async t=>{
 for(const acknowledgeFirst of [true,false]) {
  const f=await versionFixture(t);
  await f.send(f.client,initialize('0.167.0'));
  if(acknowledgeFirst)await f.reply(f.client,{id:'init',result:{}});
  await f.send(f.client,initialize('0.168.0','again'));
  if(!acknowledgeFirst)await f.reply(f.client,{id:'init',result:{}});
  await f.reply(f.client,{id:'again',result:{}});
  assert.equal(f.rpc.nativeClientVersion,null,'Do not silently replace an ambiguous client identity');
  await f.send(f.client,initialize('0.167.0','third'));await f.reply(f.client,{id:'third',result:{}});
  assert.equal(f.rpc.nativeClientVersion,null,'A duplicate handshake cannot requalify the connection');
 }
});

test('a reconnected TUI cannot inherit the old connection version', async t=>{
 const f=await versionFixture(t);
 await f.send(f.client,initialize('0.167.0'));await f.reply(f.client,{id:'init',result:{}});
 assert.equal(f.rpc.nativeClientVersion,'0.167.0');
 const closed=once(f.client,'close');f.client.close();await closed;
 assert.equal(f.rpc.connected,false);assert.equal(f.rpc.nativeClientVersion,null);
 const next=await f.connect();assert.notEqual(next.rpc,f.rpc);assert.equal(next.rpc.nativeClientVersion,null);
 await f.send(next.client,initialize('0.168.0'));await f.reply(next.client,{id:'init',result:{}});
 assert.equal(next.rpc.nativeClientVersion,'0.168.0');
 assert.equal(f.rpc.nativeClientVersion,null);
});
