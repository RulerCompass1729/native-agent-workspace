const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),net=require('node:net');
const {once}=require('node:events'),WebSocket=require('ws');
const {CodexTerminalBridge}=require('../codex-terminal-bridge.cjs');
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
