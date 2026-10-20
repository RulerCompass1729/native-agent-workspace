// Owned synthetic server failures only; no provider process or model calls.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { once, EventEmitter } = require('node:events');
const net = require('node:net');
const { NativeHost, Codex } = require('../adapters.cjs');
const { Workspace } = require('../workspace.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(fn) { for (let i = 0; i < 150; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 20)); } throw Error('Expected state not reached'); }
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-server-recovery-'));
  const binary = path.join(dir, 'server'), callsFile = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(binary, `#!${process.execPath}\nconst fs=require('node:fs'),http=require('node:http');
const {WebSocketServer}=require(${JSON.stringify(require.resolve('ws'))});
const server=http.createServer(),wss=new WebSocketServer({server});let count=0;
wss.on('connection',ws=>ws.on('message',raw=>{const m=JSON.parse(raw);fs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify(m)+'\\n');
let result={};if(m.method==='thread/start')result={thread:{id:'synthetic-'+(++count),status:{type:'idle'}},model:'synthetic'};
if(m.method==='thread/resume')result={thread:{id:m.params.threadId,status:{type:'idle'}},model:'synthetic'};
if(m.method==='thread/items/list')result={data:[{turnId:'old-turn',item:{id:'saved-reply',type:'agentMessage',text:'saved history'}}],nextCursor:null};
if(m.id && m.method!=='turn/start')ws.send(JSON.stringify({id:m.id,result}));if(m.method==='test/close')ws.close();}));
server.listen(process.argv.at(-1).slice(7));\n`, { mode: 0o700 });
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
  return { host, w, id, dir, calls: () => fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse) };
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
