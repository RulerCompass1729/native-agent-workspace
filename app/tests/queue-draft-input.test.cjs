const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { EventEmitter } = require('node:events');
const { Workspace } = require('../workspace.cjs'), { RoomState } = require('../room-state.cjs'), rules = require('../queue-dispatch.cjs');
const { fork } = require('node:child_process'), { once } = require('node:events');
const { connectService } = require('../service-connection.cjs');
const NOW = 1800000000000;
const proof = (w, id) => { const s = w.snapshot().sessions.find(s => s.id === id); return Object.fromEntries(['nativeId','draftRevision','controlRevision','connectionRevision'].map(k => [k,s[k] ?? 0])); };
async function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'naw-b-draft-input-')), calls=[];
  const host={binaries:{},close(){},create(s){s.nativeId='native-'+s.id;const r=new EventEmitter();r.chatAvailable=true;r.terminal={alive:true,input(){}};r.start=async()=>r.emit('state','idle');r.send=async(text,tag,guard)=>{assert.ok(guard());calls.push({text,tag,own:guard.ownInput});r.emit('submitted',tag);};return r;}};
  const w=new Workspace(host,root),id=await w.create('claude',root,'person','Synthetic member');w.join(id,true);w.get(id).createdAt=NOW;
  let dispatcher; t.after(()=>{dispatcher?.close();w.close();fs.rmSync(root,{recursive:true});});
  const send=expectedInput=>w.send(id,'Synthetic task','naw-dispatcher',null,null,null,null,null,null,null,{itemId:'task',expectedInput});
  const room=new RoomState(root), client=new EventEmitter();client.snapshot=()=>({...w.snapshot(),sessions:w.snapshot().sessions.map(s=>({...s,serviceCapabilities:[rules.CAPABILITY]})),capabilities:[rules.CAPABILITY]});client.refresh=async()=>client.snapshot();client.close=()=>{};
  client.route=()=>({client,state:{capabilities:[rules.CAPABILITY]}});let intercept=async()=>{};
  client.call=async(method,...args)=>{assert.equal(method,'dispatch');const packet=args[3];await intercept();return w.send(args[0],args[1],'naw-dispatcher',null,null,null,null,null,null,null,typeof packet==='string'?{itemId:packet}:{...packet});};
  let now=NOW;dispatcher=new rules.QueueDispatcher({roomState:room,dataDir:root,clients:()=>client,now:()=>now,settleMs:0,tickMs:3600000,sampleProcesses:async()=>'',samplePressure:async()=>'0'});
  return {w,id,calls,send,room,client,dispatcher,hook:fn=>{intercept=fn;},advance:ms=>{now+=ms;dispatcher.dirty=true;},snapshot:()=>room.apply(client.snapshot())};
}
for(const draft of ['/','  Synthetic draft 😀 \n  ',''])test('checked Workspace dispatch preserves every draft byte '+JSON.stringify(draft),async t=>{
 const f=await fixture(t);f.w.setDraft(f.id,draft,'person');const expected=proof(f.w,f.id);const tag=await f.send(expected);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].text,'Synthetic task');assert.equal(f.calls[0].own,undefined);assert.equal(f.w.drafts.get(f.id),draft);
 assert.equal(f.w.draftRevisions.get(f.id),expected.draftRevision);assert.equal(f.w.get(f.id).messages.find(m=>m.id===tag).origin,'naw-dispatch');
});
for(const change of ['cleared-draft','terminal-control','connection'])test('B1 refuses a changed input version before Workspace entry: '+change,async t=>{
 const f=await fixture(t),expected=proof(f.w,f.id);
 if(change==='cleared-draft')f.w.setDraft(f.id,'','person');
 if(change==='terminal-control')f.w.input(f.id,'k','person');
 if(change==='connection')f.w.get(f.id).connectionRevision++;
 await assert.rejects(f.send(expected),e=>e.uiMessage?.key==='error.queue.personTyping');assert.equal(f.calls.length,0);assert.equal(f.w.get(f.id).pendingTag,null);
});
test('B1: a second input connection wins before dispatch arrives, then receives a full quiet period',async t=>{
 const f=await fixture(t);f.w.setDraft(f.id,'/','person');const item=f.room.queueAdd('Synthetic queued task',f.id);let once=true,intercepted=0;
 f.hook(async()=>{if(once){once=false;intercepted++;f.w.setDraft(f.id,'  Newer unsent draft \n','person');}});
 await f.dispatcher.start();assert.equal(intercepted,1);assert.equal(f.calls.length,0);assert.equal(f.room.queueFind('shared',item).status,'queued');
 assert.deepEqual(f.snapshot().rooms[0].queue[0].wait,[{sessionId:f.id,reason:'person-recent'}]);
 f.advance(rules.HUMAN_QUIET_MS-1);await f.dispatcher.schedule();assert.equal(f.calls.length,0);
 f.advance(1);await f.dispatcher.schedule();assert.equal(f.calls.length,1);assert.equal(f.w.drafts.get(f.id),'  Newer unsent draft \n');assert.equal(f.calls[0].text.includes('Newer unsent'),false);assert.equal(f.room.queueFind('shared',item).status,'sent');
});
test('the expected input is rechecked at the native write boundary too',async t=>{
 const f=await fixture(t);f.w.setDraft(f.id,'/','person');let valid;
 f.w.runtime(f.id).send=async(_text,_tag,guard)=>{valid=guard;};await f.send(proof(f.w,f.id));assert.equal(valid(),true);
 f.w.setDraft(f.id,'/new','person');assert.equal(valid(),false);assert.equal(f.w.drafts.get(f.id),'/new');
});
test('a proven refusal after Workspace entry also requeues with the full human quiet period',async t=>{
 const f=await fixture(t);let attempts=0;
 f.w.runtime(f.id).send=async(text,tag,guard)=>{
   attempts++;
   if(attempts===1)f.w.setDraft(f.id,'  Later draft \n','person');
   if(!guard())throw Object.assign(Error('Synthetic prewrite refusal'),{notSent:true});
   f.calls.push({text,tag});f.w.runtime(f.id).emit('submitted',tag);
 };
 const item=f.room.queueAdd('Synthetic task',f.id);await f.dispatcher.start();
 assert.equal(attempts,1);assert.equal(f.calls.length,0);assert.equal(f.room.queueFind('shared',item).status,'queued');
 assert.deepEqual(f.snapshot().rooms[0].queue[0].wait,[{sessionId:f.id,reason:'person-recent'}]);
 f.advance(rules.HUMAN_QUIET_MS-1);await f.dispatcher.schedule();assert.equal(attempts,1);
 f.advance(1);await f.dispatcher.schedule();assert.equal(attempts,2);assert.equal(f.calls.length,1);assert.equal(f.w.drafts.get(f.id),'  Later draft \n');
});
test('legacy lifecycle calls still refuse a draft and old-only backends cannot accept ordinary queued work',async t=>{
 const f=await fixture(t);f.w.setDraft(f.id,'/','person');await assert.rejects(f.w.send(f.id,'handoff','naw-dispatcher',null,null,null,null,null,null,null,{itemId:'legacy'}));
 const snap=f.client.snapshot();snap.sessions[0].liveDraft='';snap.sessions[0].serviceCapabilities=['queueDispatchV1'];const waits=new Map();
 const actions=rules.planDispatch({...snap,rooms:[{id:'shared',queue:[{id:'task',text:'Synthetic',status:'queued',assignee:f.id}]}],now:NOW,settleMs:0,idleSince:new Map([[f.id,NOW-10000]]),waits});
 assert.deepEqual(actions.filter(a=>a.kind==='dispatch'),[]);assert.deepEqual(waits.get('task'),[{sessionId:f.id,reason:'backend-update-needed'}]);
 assert.equal(rules.sessionReady(snap.sessions[0],{enabled:true}).ready,true,'unchanged lifecycle contract still accepts an old backend with no draft');
});
test('changed input after an uncertain native write cannot become a proven refusal or an automatic retry',async t=>{
 const f=await fixture(t);let writes=0;
 f.w.runtime(f.id).send=async()=>{writes++;f.w.setDraft(f.id,'new draft','person');throw Error('Synthetic lost acknowledgement');};
 const item=f.room.queueAdd('Synthetic task',f.id);await f.dispatcher.start();
 assert.equal(f.room.queueFind('shared',item).status,'failed');assert.equal(writes,1);
 f.advance(rules.HUMAN_QUIET_MS);await f.dispatcher.schedule();assert.equal(writes,1);assert.equal(f.w.drafts.get(f.id),'new draft');
});
test('malformed or wrong-native expected input is refused without writing or changing the draft',async t=>{
 const f=await fixture(t);f.w.setDraft(f.id,'/','person');const valid=proof(f.w,f.id);
 for(const expected of [null,{}, {...valid,draftRevision:-1},{...valid,controlRevision:0.5},{...valid,extra:1},{...valid,nativeId:'other-native'}])await assert.rejects(f.send(expected));
 assert.equal(f.calls.length,0);assert.equal(f.w.get(f.id).pendingTag,null);assert.equal(f.w.drafts.get(f.id),'/');
});
test('serialized Unix RPC rejects a late draft from another connection and accepts the unchanged checked version',async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'naw-b-draft-rpc-'))),cwd=path.join(root,'workspace');fs.mkdirSync(cwd,{mode:0o700});
 const child=fork(path.resolve(__dirname,'../daemon.cjs'),[root],{execArgv:['--require',path.resolve(__dirname,'fixtures/mobile-host.cjs')],env:{...process.env,NAW_WORKSPACE:cwd,NAW_MOBILE_FIXTURE_ROOT:root,NAW_APP_VERSION:'synthetic-draft-test'},stdio:['ignore','ignore','pipe','ipc']});
 const clients=[];let stderr='';child.stderr.on('data',data=>{stderr+=data;});
 t.after(async()=>{for(const c of clients)c.close();if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await ended;}fs.rmSync(root,{recursive:true});});
 for(let i=0;i<100&&!fs.existsSync(path.join(root,'connection.json'));i++){if(child.exitCode!==null)assert.fail(stderr);await new Promise(resolve=>setTimeout(resolve,10));}
 assert.ok(fs.existsSync(path.join(root,'connection.json')),stderr);
 const client=await connectService(root,'person'),other=await connectService(root,'person');clients.push(client,other);
 const id=await client.call('create',{provider:'claude',cwd,name:'Synthetic draft target',view:'chat'});
 const read=async()=>{const state=await client.call('initial');return state.sessions.find(s=>s.id===id);};
 assert.ok((await client.call('initial')).capabilities.includes(rules.CAPABILITY));
 await client.call('draft',id,'/');const old=await read();const expected=Object.fromEntries(['nativeId','draftRevision','controlRevision','connectionRevision'].map(k=>[k,old[k]??0]));
 await other.call('draft',id,'  New draft 😀 \n');
 await assert.rejects(client.call('dispatch',id,'Synthetic task',old.nativeId,{itemId:'task',expectedInput:expected}),e=>e.uiMessage?.key==='error.queue.personTyping');
 const current=await read();assert.equal(current.pendingTag,null);assert.equal(current.messages.filter(m=>m.origin==='naw-dispatch').length,0);
 const fresh=Object.fromEntries(['nativeId','draftRevision','controlRevision','connectionRevision'].map(k=>[k,current[k]??0]));
 const tag=await client.call('dispatch',id,'Synthetic task',current.nativeId,{itemId:'task',expectedInput:fresh});
 const sent=await read();assert.equal(sent.liveDraft,'  New draft 😀 \n');
 const inputs=sent.messages.filter(m=>m.origin==='naw-dispatch');assert.equal(inputs.length,1);assert.equal(inputs[0].id,tag);assert.equal(inputs[0].text,'Synthetic task');assert.equal(inputs[0].dispatchItem,'task');
});
