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
