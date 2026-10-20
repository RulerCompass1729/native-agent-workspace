// Owned synthetic server failures only; no provider process or model calls.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { once, EventEmitter } = require('node:events');
const net = require('node:net');
const { NativeHost, Codex } = require('../adapters.cjs');
const { Workspace } = require('../workspace.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(fn) { for (let i = 0; i < 150; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 20)); } throw Error('Expected state not reached'); }
async function fixture(t, { symlink = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-server-recovery-'));
  const binary = path.join(dir, 'server'), callsFile = path.join(dir, 'calls.jsonl'), controlFile = path.join(dir, 'control.json');
  fs.writeFileSync(controlFile, '{}');
  fs.writeFileSync(binary, `#!${process.execPath}\nconst fs=require('node:fs'),http=require('node:http');
const {WebSocketServer}=require(${JSON.stringify(require.resolve('ws'))});
const server=http.createServer(),wss=new WebSocketServer({server});let count=0;
wss.on('connection',ws=>ws.on('message',async raw=>{const m=JSON.parse(raw);fs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify(m)+'\\n');
const control=()=>JSON.parse(fs.readFileSync(${JSON.stringify(controlFile)}));let cfg=control();
while(cfg.hold===m.method){await new Promise(r=>setTimeout(r,10));cfg=control();}
if(ws.readyState!==1)return;
if(cfg.reject===m.method){ws.send(JSON.stringify({id:m.id,error:{code:-32000,message:'Synthetic rejection'}}));return;}
if(cfg.closeOnResume&&m.method==='thread/resume')ws.send(JSON.stringify({method:'thread/closed',params:{threadId:m.params.threadId}}));
let result={};if(m.method==='thread/start')result={thread:{id:'synthetic-'+(++count),status:{type:'idle'}},model:'synthetic'};
if(m.method==='thread/resume')result={thread:{id:m.params.threadId,status:{type:'idle'}},model:'synthetic'};
if(m.method==='thread/read')result={thread:{id:m.params.threadId,status:{type:'idle'},preview:'completed synthetic history'}};
if(m.method==='thread/items/list')result={data:[{turnId:'old-turn',item:{id:'saved-reply',type:'agentMessage',text:'saved history'}}],nextCursor:null};
if(m.method==='turn/start'&&cfg.acceptTurn)result={turn:{id:'accepted-turn'}};
if(m.id && (m.method!=='turn/start'||cfg.acceptTurn))ws.send(JSON.stringify({id:m.id,result}));if(m.method==='test/close')ws.close();}));
const requested=process.argv.at(-1).slice(7),endpoint=${symlink} ? requested+'.native' : requested;
server.listen(endpoint,()=>{if(${symlink})fs.symlinkSync(endpoint,requested);});\n`, { mode: 0o700 });
  const host = new NativeHost(dir); host.binaries.codex = binary;
  host.create = record => new Codex(record, host);
  const w = new Workspace(host, dir);
  t.after(async () => {
    const child = host.codexProcess;
    w.close();
    if (child && child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const id = await w.create('codex', dir, 'window', 'Synthetic continuity');
  return { host, w, id, dir, configure: value => fs.writeFileSync(controlFile, JSON.stringify(value)), calls: () => fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse) };
}
async function crash(host) {
  const child = host.codexProcess, exited = once(child, 'exit');
  child.kill('SIGTERM'); await exited;
  await until(() => host.codexProcess === null);
}
test('confirmed owned server exit preserves records and enables explicit same-ID recovery once', async t => {
  const {host,w,id,calls} = await fixture(t), old = w.runtime(id), rpc = host.rpc;
  const s = w.get(id), identity = s.nativeId;
  s.messages = [{id:'saved-reply',role:'assistant',text:'saved history',status:'complete'}];
  w.setDraft(id, 'unsent 中文'); w.join(id,true);
  w.room.run = {id:'old-run',status:'running',ids:[id]};
  await crash(host); await until(() => s.state === 'recoverable');
  assert.equal(w.runtimes.has(id),false); assert.equal(w.drafts.get(id),'unsent 中文');
  assert.equal(w.room.run.status,'paused'); assert.equal(w.snapshot().sessions[0].terminalAvailable,false);
  const pending = w.resume(id,'window'); await assert.rejects(w.resume(id,'other-window')); await pending;
  assert.equal(s.nativeId,identity); assert.equal(s.state,'idle'); assert.equal(w.runtime(id).chatAvailable,true);
  assert.equal(s.roomId,'shared'); assert.equal(w.drafts.get(id),'unsent 中文'); assert.equal(s.messages.length,1);
  const current = w.runtime(id), state = JSON.stringify(w.snapshot());
  rpc.emit('closed'); rpc.emit('event',{method:'turn/started',params:{threadId:identity,turn:{id:'obsolete'}}});
  old.emit('state','ended'); old.emit('failed','late error'); old.emit('nativeInput','obsolete input'); old.emit('pid',123);
  old.emit('history',[{id:'wrong',type:'agentMessage',text:'obsolete history'}]); old.emit('messageItem',{id:'wrong',text:'obsolete answer'});
  assert.equal(w.runtime(id),current); assert.equal(JSON.stringify(w.snapshot()),state);
  assert.equal(calls().filter(c=>c.method==='thread/start').length,1);
  assert.equal(calls().filter(c=>c.method==='thread/resume').length,1);
  assert.equal(calls().filter(c=>c.method==='turn/start').length,0);
});
test('transport closure alone never clears or duplicates a still running native server', async t => {
  const {host,w,id} = await fixture(t), child = host.codexProcess;
  await host.rpc.call('test/close',{}); await until(()=>host.rpc.ws.readyState===3);
  await host.startCodex(); assert.equal(host.codexProcess,child); assert.equal(child.signalCode,null);
  assert.equal(w.get(id).state,'error'); assert.equal(w.runtime(id).backendExitConfirmed,undefined);
});
test('explicit transport recovery retains the same live backend, terminal and thread without replay', async t => {
  const {host,w,id,calls} = await fixture(t), child = host.codexProcess, rpc = host.rpc, r = w.runtime(id);
  const s = w.get(id), identity = s.nativeId;
  s.messages = [{id:'saved-reply',role:'assistant',text:'saved history',status:'complete'}];
  r.hasHistory = true; w.setDraft(id,'未发送的草稿'); w.join(id,true);
  let stopped = 0;
  r.terminal = {alive:true, pid:process.pid, stop:async()=>{stopped++}, input(){}};
  r.emit('pid', process.pid);
  const terminalIdentity = s.processIdentity, serverIdentity = s.serverIdentity;
  await rpc.call('test/close',{}); await until(()=>rpc.ws.readyState===3);
  await w.resume(id,'window');
  assert.equal(host.codexProcess,child); assert.notEqual(host.rpc,rpc);
  assert.equal(w.runtime(id),r); assert.equal(stopped,0);
  assert.deepEqual(s.processIdentity, terminalIdentity);
  assert.deepEqual(s.serverIdentity, serverIdentity);
  assert.equal(s.nativeId,identity); assert.equal(s.state,'idle'); assert.equal(r.chatAvailable,true);
  assert.equal(s.roomId,'shared'); assert.equal(w.drafts.get(id),'未发送的草稿');
  assert.equal(s.messages.length,1);
  assert.deepEqual(calls().filter(c=>c.method==='thread/resume').map(c=>c.params),[{threadId:identity,excludeTurns:true}]);
  assert.equal(calls().filter(c=>c.method==='thread/start').length,1);
  assert.equal(calls().filter(c=>c.method==='turn/start').length,0);
  const good=JSON.stringify(w.snapshot());
  rpc.emit('closed');rpc.emit('event',{method:'turn/started',params:{threadId:identity,turn:{id:'old'}}});
  assert.equal(JSON.stringify(w.snapshot()),good);
});
for (const concurrent of [false,true]) test('shared transport reconnect subscribes only explicitly selected threads: '+concurrent,async t=>{
  const f=await fixture(t),second=await f.w.create('codex',f.dir,'window','Other session'),child=f.host.codexProcess,old=f.host.rpc;
  await old.call('test/close',{});await until(()=>old.ws.readyState===3);
  if(concurrent)await Promise.all([f.w.resume(f.id,'window'),f.w.resume(second,'window')]);
  else{
    await f.w.resume(f.id,'window');
    assert.equal(f.w.get(second).state,'error');assert.equal(f.w.runtime(second).transportDisconnected,true);
    f.host.rpc.emit('event',{method:'turn/started',params:{threadId:f.w.get(second).nativeId,turn:{id:'not-subscribed'}}});
    assert.equal(f.w.get(second).state,'error');
    assert.equal(f.calls().filter(c=>c.method==='thread/resume').length,1);
    await f.w.resume(second,'window');
  }
  assert.equal(f.host.codexProcess,child);assert.equal(f.calls().filter(c=>c.method==='initialize').length,2);
  assert.equal(f.calls().filter(c=>c.method==='thread/resume').length,2);
  assert.equal(f.calls().filter(c=>c.method==='thread/start').length,2);
  assert.equal(f.calls().filter(c=>c.method==='turn/start').length,0);
});
for(const method of ['initialize','thread/items/list'])test('failed transport recovery remains retryable without killing the existing server: '+method,async t=>{
  const f=await fixture(t),child=f.host.codexProcess,old=f.host.rpc;
  f.w.get(f.id).messages=[{id:'saved-reply',role:'assistant',text:'old complete',status:'complete'}];
  await old.call('test/close',{});await until(()=>old.ws.readyState===3);f.configure({reject:method});
  await assert.rejects(f.w.resume(f.id,'window'));
  assert.equal(f.host.codexProcess,child);assert.equal(child.signalCode,null);
  assert.equal(f.w.get(f.id).state,'error');assert.equal(f.w.runtime(f.id).transportDisconnected,true);
  assert.equal(f.w.get(f.id).messages[0].text,'old complete');
  f.configure({});await f.w.resume(f.id,'window');
  assert.equal(f.w.get(f.id).state,'idle');assert.equal(f.w.runtime(f.id).transportDisconnected,false);
  assert.equal(f.calls().filter(c=>c.method==='turn/start').length,0);
  assert.equal(child.listenerCount('exit'),1);
});
test('backend exit during transport initialization retains recoverable state and never starts another server',async t=>{
  const f=await fixture(t),old=f.host.rpc;
  await old.call('test/close',{});await until(()=>old.ws.readyState===3);
  f.configure({hold:'initialize'});
  const pending=f.w.resume(f.id,'window'),rejected=assert.rejects(pending);
  await until(()=>f.calls().filter(c=>c.method==='initialize').length===2);
  await crash(f.host);await rejected;
  assert.equal(f.w.get(f.id).state,'recoverable');assert.equal(f.w.runtimes.has(f.id),false);
  assert.equal(f.host.codexProcess,null);assert.equal(f.calls().filter(c=>c.method==='thread/start').length,1);
});
test('a replaced endpoint is not contacted even while the original child remains alive',async t=>{
  const f=await fixture(t),old=f.host.rpc,child=f.host.codexProcess;
  await old.call('test/close',{});await until(()=>old.ws.readyState===3);
  fs.renameSync(f.host.codexSocket,f.host.codexSocket+'.original');
  let connects=0;const other=net.createServer(s=>{connects++;s.destroy()});
  await new Promise(r=>other.listen(f.host.codexSocket,r));t.after(()=>new Promise(r=>other.close(r)));
  await assert.rejects(f.w.resume(f.id,'window'),/接口已变化/);
  assert.equal(connects,0);assert.equal(f.host.codexProcess,child);assert.equal(child.signalCode,null);
});
test('an unchanged native symlink cannot hide replacement of its resolved socket',async t=>{
  const f=await fixture(t,{symlink:true}),old=f.host.rpc,child=f.host.codexProcess;
  await old.call('test/close',{});await until(()=>old.ws.readyState===3);
  const link=fs.lstatSync(f.host.codexSocket),resolved=fs.realpathSync(f.host.codexSocket);
  fs.renameSync(resolved,resolved+'.original');
  let connects=0;const other=net.createServer(s=>{connects++;s.destroy()});
  await new Promise(r=>other.listen(resolved,r));t.after(()=>new Promise(r=>other.close(r)));
  assert.equal(fs.lstatSync(f.host.codexSocket).ino,link.ino);
  await assert.rejects(f.w.resume(f.id,'window'),/接口已变化/);
  assert.equal(connects,0);assert.equal(f.host.codexProcess,child);assert.equal(child.signalCode,null);
});
test('an unchanged owned native symlink supports explicit same-process reconnection',async t=>{
  const f=await fixture(t,{symlink:true}),old=f.host.rpc,child=f.host.codexProcess;
  await old.call('test/close',{});await until(()=>old.ws.readyState===3);
  await f.w.resume(f.id,'window');
  assert.equal(f.w.get(f.id).state,'idle');assert.equal(f.host.codexProcess,child);
  assert.equal(f.calls().filter(c=>c.method==='turn/start').length,0);
});
test('pre-ACK transport loss preserves the uncertain draft and never replays it on reconnect',async t=>{
  const f=await fixture(t);f.w.setDraft(f.id,'uncertain 中文','window');
  const send=f.w.send(f.id,'uncertain 中文','window'),rejected=assert.rejects(send);
  await until(()=>f.calls().some(c=>c.method==='turn/start'));
  const old=f.host.rpc;await old.call('test/close',{});await rejected;await until(()=>old.ws.readyState===3);
  await f.w.resume(f.id,'window');
  assert.equal(f.w.drafts.get(f.id),'uncertain 中文');
  assert.equal(f.w.get(f.id).messages.find(m=>m.text==='uncertain 中文').status,'unconfirmed');
  assert.equal(f.calls().filter(c=>c.method==='turn/start').length,1);
});
test('previously accepted sharing stays private after transport reconnect and native completion',async t=>{
  const f=await fixture(t);f.configure({acceptTurn:true});f.w.join(f.id,true);
  const s=f.w.get(f.id),tag=await f.w.send(f.id,'shared synthetic task','window',null,{member:s.memberRevision});
  assert.equal(s.messages.find(m=>m.id===tag).status,'submitted');
  const old=f.host.rpc;await old.call('test/close',{});await until(()=>old.ws.readyState===3);
  await f.w.resume(f.id,'window');
  assert.equal(s.pendingTag,null);assert.equal(f.w.forwards.has(tag),false);
  assert.equal(f.w.room.messages.find(m=>m.id===tag).status,'reply-private');
  const r=f.w.runtime(f.id);
  r.event({method:'item/completed',params:{turnId:'accepted-turn',item:{id:'late-reply',type:'agentMessage',text:'private late answer'}}});
  r.event({method:'turn/completed',params:{turn:{id:'accepted-turn',status:'completed'}}});
  assert.equal(f.w.room.messages.some(m=>m.text==='private late answer'),false);
  assert.equal(f.calls().filter(c=>c.method==='turn/start').length,1);
});
test('a sleeping first-turn observer cannot subscribe an unselected peer through a replacement transport',async t=>{
  const f=await fixture(t),second=await f.w.create('codex',f.dir,'window','Unselected terminal-first peer');
  const r=f.w.runtime(second);r.chatAvailable=false;
  const observing=r.observeFirstTurn();
  const old=f.host.rpc;await old.call('test/close',{});await until(()=>old.ws.readyState===3);
  await f.w.resume(f.id,'window');await observing;
  assert.equal(r.transportDisconnected,true);assert.equal(r.chatAvailable,false);assert.equal(f.w.get(second).state,'error');
  assert.equal(f.calls().some(c=>['thread/read','thread/resume'].includes(c.method)&&c.params.threadId===f.w.get(second).nativeId),false);
});
test('an old permission decision cannot authorize a new request with the same native number after reconnect',async t=>{
  const f=await fixture(t),s=f.w.get(f.id),r=f.w.runtime(f.id);
  r.event({id:7,method:'item/commandExecution/requestApproval',params:{command:'first synthetic request'}});
  const oldKey=s.approval.requestId;
  const old=f.host.rpc;await old.call('test/close',{});await until(()=>old.ws.readyState===3);
  assert.equal(s.approval,null);await f.w.resume(f.id,'window');
  r.event({id:7,method:'item/commandExecution/requestApproval',params:{command:'different synthetic request'}});
  const nextKey=s.approval.requestId;
  assert.throws(()=>f.w.approve(f.id,oldKey,'accept','window'),/权限请求已变化/);
  assert.throws(()=>f.w.approve(f.id,nextKey,'accept','another-window'),/权限请求已变化/);
  assert.throws(()=>f.w.approve(f.id,nextKey,'invalid','window'),/未知权限决定/);
  assert.equal(s.approval.params.command,'different synthetic request');
  f.w.approve(f.id,nextKey,'decline','window');
  await until(()=>f.calls().some(c=>c.id===7&&c.result?.decision==='decline'));
  assert.equal(f.calls().some(c=>c.result?.decision==='accept'),false);
  assert.equal(s.approval,null);
});
test('a pre-ACK crash retains the uncertain input and its draft without retrying', async t => {
  const {host,w,id,calls} = await fixture(t);
  w.setDraft(id,'unsent task draft','window');
  const sending=w.send(id,'unsent task draft','window'),rejected=assert.rejects(sending);
  await until(()=>calls().some(c=>c.method==='turn/start'));
  await crash(host);await rejected;await until(()=>w.get(id).state==='recoverable');
  assert.equal(w.get(id).messages.at(-1).status,'unconfirmed');
  assert.equal(w.drafts.get(id),'unsent task draft');
  assert.equal(calls().filter(c=>c.method==='turn/start').length,1);
});
test('an endpoint that still answers after the old child exit is never removed or replaced', async t => {
  const {host} = await fixture(t); await crash(host);
  try { fs.unlinkSync(host.codexSocket); } catch(e) { if(e.code!=='ENOENT')throw e; }
  const listener = net.createServer(s=>s.end()); await new Promise(r=>listener.listen(host.codexSocket,r));
  t.after(()=>new Promise(r=>listener.close(r)));
  const before = fs.lstatSync(host.codexSocket);
  await assert.rejects(host.startCodex(),/接口仍在运行/);
  assert.equal(host.codexProcess,null);assert.equal(fs.lstatSync(host.codexSocket).ino,before.ino);
});
test('unconfirmed display-client exit blocks recovery until its own exit is confirmed', async t => {
  const {host,w,id} = await fixture(t), r=w.runtime(id);
  let confirmed=false;
  const terminal=r.terminal=new EventEmitter();terminal.alive=false;terminal.nativeExited=false;
  terminal.stop=async()=>{if(!confirmed)throw Error('No exit confirmation');terminal.nativeExited=true;};
  terminal.observe=async()=>({buffer:'last native frame'});
  await crash(host);await until(()=>r.retiringTerminal===null);
  assert.equal(w.get(id).state,'error');assert.equal(w.runtimes.get(id),r);
  await assert.rejects(w.resume(id,'window'),/仍有运行连接/);
  confirmed=true;await w.stop(id);
  assert.equal(w.get(id).state,'recoverable');assert.equal(w.runtimes.has(id),false);
  assert.deepEqual((await w.observe(id)).terminal,{buffer:'last native frame'});
});
test('old creation queue cannot use a new lease after its previous slot completes', async () => {
  const h = new NativeHost(os.tmpdir()); h.codexProcess={pid:123};h.rpc={};
  let release,created=0;
  const active=h.createCodex(()=>new Promise(r=>{release=r}));await tick();
  const queued=h.createCodex(()=>{created++});const rejected=assert.rejects(queued,/启动队列/);
  h.codexProcess={pid:456};h.rpc={};release();await active;await rejected;
  assert.equal(created,0);await h.createCodex(()=>{created++});assert.equal(created,1);
});
test('confirmed backend exit immediately blocks input while its display client is still exiting', async t => {
  const {host,w,id}=await fixture(t),r=w.runtime(id);let finish,writes=0;
  r.terminal={alive:true,nativeExited:false,input(){writes++},stop:()=>new Promise(resolve=>{finish=()=>{r.terminal.alive=false;r.terminal.nativeExited=true;resolve()}})};
  w.claim(id,'window','terminal');
  await crash(host);await until(()=>Boolean(finish));
  assert.equal(w.snapshot().sessions[0].backendUnavailable,true);
  assert.throws(()=>w.input(id,'must stay unsent','window'),/输入未发送/);
  assert.equal(writes,0);await assert.rejects(w.resume(id,'window'),/仍有运行连接/);
  finish();await until(()=>w.get(id).state==='recoverable');
  w.get(id).view='chat';await w.resume(id,'window');
  const current=w.runtime(id);current.terminal={alive:true,input(){writes++},stop:async()=>{}};
  w.claim(id,'window','terminal');w.input(id,'new input','window');assert.equal(writes,1);
});
test('late native start ACK cannot attach a previous server identity to a new lease',async()=>{
  const h=new NativeHost(os.tmpdir());h.codexProcess={pid:123};h.startCodex=async()=>{};
  let release;h.rpc={call:()=>new Promise(r=>{release=r})};
  const s={provider:'codex',nativeId:null,view:'chat',cwd:os.tmpdir()},r=new Codex(s,h);
  const pending=r.start(),rejected=assert.rejects(pending,/旧的启动结果/);await tick();
  h.codexProcess={pid:456};h.rpc={};release({thread:{id:'old-native'}});await rejected;
  assert.equal(s.nativeId,null);assert.equal(h.codexTargets.size,0);
});
test('backend exit cancels native setup and its queued slot before a later terminal event',async t=>{
  const {host,w,dir}=await fixture(t);
  host.create=record=>{
    const r=new Codex(record,host);
    r.makeTerminal=()=>{
      const term=new EventEmitter();term.alive=true;term.nativeExited=false;
      term.stop=async()=>{term.alive=false;term.nativeExited=true;term.emit('closed',{confirmed:true})};
      return r.terminal=term;
    };
    return r;
  };
  const id=await w.create('codex',dir,'window','Setup only','terminal');
  await until(()=>Boolean(host.pendingCodex));
  const lateStarted=host.pendingCodex;
  await crash(host);await until(()=>w.get(id).state==='ended');
  assert.equal(host.pendingCodex,null);assert.equal(w.get(id).nativeId,null);
  const next=await w.create('codex',dir,'window','Next session');
  lateStarted({id:'obsolete-native'});await tick();
  assert.equal(w.get(id).nativeId,null);assert.equal(w.get(id).state,'ended');
  assert.equal(w.get(next).state,'idle');assert.equal(host.codexTargets.has('obsolete-native'),false);
});
