const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events'), { randomUUID } = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Workspace } = require('../workspace.cjs');
const { Claude } = require('../adapters.cjs');
const { SubmissionChannel } = require('../claude-submit.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'naw-clear-'));
  const host={binaries:{},close(){},create(record){
    const r=Object.create(Claude.prototype); EventEmitter.call(r); r.record=record; r.ready=true; r.pending=null;
    r.terminal={alive:true,pid:1234,input(){}};r.submission=new SubmissionChannel();
    r.submission.on('change',()=>{r.chatAvailable=r.submission.connected;r.emit('capability')});r.chatAvailable=false;
    r.start=async()=>r.emit('state','idle');return r;
  }};
  const w=new Workspace(host,dir); const id=await w.create('claude',dir,'owner','Study');const s=w.get(id),r=w.runtimes.get(id);
  t.after(()=>{r.submission.close();w.close();fs.rmSync(dir,{recursive:true,force:true})});
  const bind=()=>({sessionId:s.nativeId,...r.bindRoot({sessionId:s.nativeId})});
  const clear=(binding=bind())=>{r.endRoot({...binding,reason:'clear'});const next=randomUUID();const result=r.clearRoot({...binding,nextSessionId:next,source:'clear'});return {binding,result,next}};
  return {dir,w,id,s,r,bind,clear};
}
test('two confirmed root clears preserve row, history, draft and terminal but revoke sharing',async t=>{
 const f=await fixture(t),{w,id,s,r}=f;const first=s.nativeId, terminal=r.terminal;
 s.messages.push({id:'old-message',role:'user',text:'Private original context'});w.setDraft(id,'Unsent material','owner');w.join(id,true);
 w.room.run={id:'run',ids:[id,'peer'],status:'running',awaiting:{sessionId:id,tag:'old'},steps:0,maxSteps:2};
 const old=f.bind();assert.equal(f.bind().lease,old.lease,'Repeated handshake does not replace lease');
 const one=f.clear(old);assert.equal(w.room.run.status,'paused');assert.equal(w.get(id),s);assert.equal(r.terminal,terminal);
 assert.equal(s.nativeId,one.next);assert.equal(s.nativeContexts[0].nativeId,first);assert.equal(s.messages[0].text,'Private original context');assert.equal(w.drafts.get(id),'Unsent material');assert.equal(r.ready,true);
 assert.equal(r.validRootBinding(old),false);assert.throws(()=>r.endRoot({...old,reason:'clear'}));
 assert.deepEqual(r.clearRoot({...old,nextSessionId:one.next,source:'clear'}),one.result,'Lost metadata ACK is idempotent');
 const two=f.clear();assert.equal(s.nativeContexts.length,2);assert.equal(s.messages.filter(m=>m.role==='system').length,2);assert.equal(s.nativeId,two.next);
 assert.throws(()=>r.clearRoot({...old,nextSessionId:one.next,source:'clear'}));
 const stored=JSON.parse(fs.readFileSync(path.join(f.dir,'workspace.json')));assert.equal(stored.sessions[0].nativeId,two.next);assert.equal(stored.sessions[0].nativeContexts.length,2);assert.equal(stored.sessions[0].nativeContextPending,null);
 const restored=new Workspace({binaries:{},close(){}},f.dir);assert.equal(restored.get(id).nativeId,two.next);assert.deepEqual(restored.get(id).messages,s.messages.filter(m=>!m.volatile));restored.close();
});
test('child IDs and late root events cannot change the current binding, readiness or messages',async t=>{
 const f=await fixture(t),{s,r}=f,old=f.bind(),child=randomUUID();
 assert.throws(()=>r.bindRoot({sessionId:child}));
 r.hook({hook_event_name:'SessionEnd',session_id:child,agent_id:'child',reason:'clear'});assert.equal(r.ready,true);
 assert.throws(()=>r.clearRoot({...old,nextSessionId:child,source:'clear'}));
 r.endRoot({...old,reason:'clear'});
 for(const payload of [{lease:'wrong'},{sessionId:child},{source:'resume'},{source:undefined},{agentId:'child'},{nextSessionId:old.sessionId}])assert.throws(()=>r.clearRoot({...old,nextSessionId:child,source:'clear',...payload}));
 const next=randomUUID();r.clearRoot({...old,nextSessionId:next,source:'clear'});let observations=0;for(const name of ['complete','state','progress','fleet'])r.on(name,()=>observations++);
 for(const event of ['SessionStart','SessionEnd','Stop','PermissionRequest','SubagentStart'])r.hook({hook_event_name:event,session_id:old.sessionId,last_assistant_message:'late old reply'});
 assert.equal(observations,0);assert.equal(s.nativeId,next);assert.equal(r.ready,true);
});
for(const outcome of ['success','failure'])for(const edited of [false,true])test(`pending GUI draft survives clear and late ${outcome}; newer edit ${edited}`,async t=>{
 const f=await fixture(t),{w,id,s,r}=f;let done,fail;r.chatAvailable=true;r.send=()=>new Promise((resolve,reject)=>{done=resolve;fail=reject});
 w.setDraft(id,'Original waiting draft','owner');const sending=w.send(id,'Original waiting draft','owner');const checked=outcome==='failure'?assert.rejects(sending,/late failure/):sending;
 const oldTag=s.pendingTag;assert.equal(w.drafts.get(id),'');if(edited)w.setDraft(id,'Newer draft','owner');
 const old=f.bind();f.clear(old);
 assert.equal(w.drafts.get(id),edited?'Newer draft':'Original waiting draft');
 if(outcome==='success'){r.emit('submitted',oldTag);done()}else fail(Error('late failure'));await checked;
 assert.equal(w.drafts.get(id),edited?'Newer draft':'Original waiting draft');assert.equal(s.pendingTag,null);assert.equal(w.pendingDrafts.size,0);
});
test('failed atomic context save keeps input closed and old history; retry creates one boundary',async t=>{
 const f=await fixture(t),{dir,w,s,r}=f,old=f.bind();w.persist();const file=path.join(dir,'workspace.json'),before=fs.readFileSync(file,'utf8');
 r.endRoot({...old,reason:'clear'});const next=randomUUID();fs.mkdirSync(file+'.tmp');
 assert.throws(()=>r.clearRoot({...old,nextSessionId:next,source:'clear'}),/not saved/);assert.equal(r.ready,false);assert.equal(r.validRootBinding(old),false);
 assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(s.nativeContexts.length,1);assert.ok(s.nativeContextPending);
 fs.rmdirSync(file+'.tmp');w.retrySave();const answer=r.clearRoot({...old,nextSessionId:next,source:'clear'});assert.ok(answer.lease);assert.equal(r.ready,true);assert.equal(s.nativeContexts.length,1);assert.equal(s.nativeContextPending,null);
});
test('unverified resume keeps native terminal alive and never recovers the stale identity',async t=>{
 const f=await fixture(t),{w,id,s,r}=f;r.endRoot({...f.bind(),reason:'resume'});r.hook({hook_event_name:'SessionStart',session_id:randomUUID(),source:'resume'});
 assert.equal(r.ready,false);assert.equal(r.terminal.alive,true);assert.equal(s.nativeContextPending.reason,'resume');await assert.rejects(w.resume(id,'owner'),/新身份尚未确认/);
});
test('normal exit can still recover its last confirmed native identity',async t=>{
 const f=await fixture(t),{s,r}=f;r.endRoot({...f.bind(),reason:'prompt_input_exit'});assert.equal(s.nativeContextPending,null);assert.equal(r.ready,false);
});
for(const saveFails of [false,true])test(`new root input and permission survive delayed context save: ${saveFails}`,async t=>{
 const f=await fixture(t),{dir,w,s,r}=f,old=f.bind(),next=randomUUID();r.endRoot({...old,reason:'clear'});
 const change={...old,nextSessionId:next,source:'clear'};
 if(saveFails){fs.mkdirSync(path.join(dir,'workspace.json.tmp'));assert.throws(()=>r.clearRoot(change));}
 r.hook({hook_event_name:'SessionStart',session_id:next,source:'clear'});
 r.hook({hook_event_name:'UserPromptSubmit',session_id:next,prompt:'Native human work',prompt_id:randomUUID()});
 r.hook({hook_event_name:'PermissionRequest',session_id:next});
 r.hook({hook_event_name:'UserPromptSubmit',session_id:randomUUID(),agent_id:'child',prompt:'Never import child work'});
 if(saveFails){fs.rmdirSync(path.join(dir,'workspace.json.tmp'));w.retrySave();r.endRoot({...old,reason:'clear'});}
 r.clearRoot(change);assert.equal(s.state,'approval');assert.equal(s.messages.filter(m=>m.text==='Native human work').length,1);assert.equal(s.messages.some(m=>m.text==='Never import child work'),false);
});
test('rapid consecutive clears replay intermediate end and retain every native identity',async t=>{
 const f=await fixture(t),{s,r}=f,a=f.bind(),b=randomUUID(),c=randomUUID();r.endRoot({...a,reason:'clear'});
 for(const [name,id,extra]of [['SessionStart',b,{source:'clear'}],['SessionEnd',b,{reason:'clear'}],['SessionStart',c,{source:'clear'}],['UserPromptSubmit',c,{prompt:'Current work'}]])r.hook({hook_event_name:name,session_id:id,...extra});
 const one=r.clearRoot({...a,nextSessionId:b,source:'clear'});assert.equal(s.state,'stopping');assert.equal(r.ready,false);
 assert.deepEqual(r.clearRoot({...a,nextSessionId:b,source:'clear'}),one,'Lost ACK while intermediate root already ended');
 r.endRoot({sessionId:b,lease:one.lease,reason:'clear'});r.clearRoot({sessionId:b,lease:one.lease,nextSessionId:c,source:'clear'});
 assert.deepEqual(s.nativeContexts.map(x=>x.nativeId),[a.sessionId,b]);assert.equal(s.nativeId,c);assert.equal(s.state,'working');assert.equal(s.messages.at(-1).text,'Current work');
});
test('observation overflow keeps graphical input closed instead of announcing idle',async t=>{
 const f=await fixture(t),{r}=f,a=f.bind(),b=randomUUID();r.endRoot({...a,reason:'clear'});
 for(let i=0;i<257;i++)r.hook({hook_event_name:'PreToolUse',session_id:b,tool_name:'Tool'});
 assert.throws(()=>r.clearRoot({...a,nextSessionId:b,source:'clear'}),/overflow/);assert.equal(r.ready,false);assert.equal(r.contextEvents.length,256);
});
for(const correlated of [true,false])for(const newerPrompt of [false,true])test(`cached Stop stays before the old boundary and cannot forward; correlated ${correlated}, newer prompt ${newerPrompt}`,async t=>{
 const f=await fixture(t),{w,id,s,r}=f,old=f.bind(),prompt=randomUUID();w.join(id,true);
 const poll=new EventEmitter();poll.end=()=>poll.emit('close');r.submission.receive(poll);
 const sending=w.forward(id,'Review material','owner');const tag=s.pendingTag;
 assert.equal(r.submission.authorize({id:tag,text:'Review material'}),true);
 r.hook({hook_event_name:'UserPromptSubmit',session_id:old.sessionId,prompt:'Review material',prompt_id:prompt});
 r.hook({hook_event_name:'Stop',session_id:old.sessionId,prompt_id:prompt,last_assistant_message:'Old answer'});
 r.submission.result({id:tag,status:'accepted',promptId:correlated?prompt:null});f.clear(old);
 if(newerPrompt)r.hook({hook_event_name:'UserPromptSubmit',session_id:s.nativeId,prompt:'Work after clear',prompt_id:randomUUID()});
 await sending;
 const boundary=s.messages.findIndex(m=>m.role==='system'),answer=s.messages.findIndex(m=>m.text==='Old answer');
 assert.ok(answer>=0&&answer<boundary);assert.equal(w.room.messages.some(m=>m.text==='Old answer'),false);assert.equal(s.state,newerPrompt?'working':'idle');
});
test('final daemon context guard rejects old or missing identity after clear',async t=>{
 const f=await fixture(t),old=f.bind();f.w.assertNativeContext(f.id,old.sessionId);f.clear(old);
 assert.throws(()=>f.w.assertNativeContext(f.id,old.sessionId),/上下文已变化/);assert.throws(()=>f.w.assertNativeContext(f.id),/上下文已变化/);
 f.w.assertNativeContext(f.id,f.s.nativeId);assert.equal(f.w.versions.dispatches,0);
});
for(const scenario of ['held-ack','lost-ack','held-final-id'])test(`real mod registration serializes rapid A-B-C root transitions: ${scenario}`,async t=>{
 const f=await fixture(t),{r,s}=f;
 const source=fs.readFileSync(path.join(__dirname,'../claude-bridge/hooks/register.js'),'utf8');
 const {register}=await import('data:text/javascript;base64,'+Buffer.from(source+'\n//'+randomUUID()).toString('base64'));
 const hooks=new Map(),clock=[],transitions=[];let native=s.nativeId,release,held=false,submits=0,holdFinalId=false;
 const $={session:{id:async()=>{const value=native;if(holdFinalId){holdFinalId=false;await new Promise(resolve=>release=resolve)}return value},version:async()=>({version:'2.1.306'})},env:{get:async key=>key==='NAW_SUBMIT_SOCKET'?'/test/socket':'test-token'},clock:{after:(_ms,fn)=>clock.push(fn)},prompt:{submit:async()=>{submits++;throw Error('No inference expected')},read:async()=>({text:''})},http:{fetch:async(url,opts)=>{
  const body=JSON.parse(opts.body);let answer;
  if(url.endsWith('/root-bind'))answer=r.bindRoot(body);
  else if(url.endsWith('/root-end'))answer=r.endRoot(body);
  else if(url.endsWith('/root-clear')){answer=r.clearRoot(body);transitions.push(body.nextSessionId);if(!held){held=true;if(scenario==='held-final-id')holdFinalId=true;else await new Promise(resolve=>release=resolve);if(scenario==='lost-ack')throw Error('Lost metadata ACK')}}
  else if(url.endsWith('/next'))answer={idle:true};else throw Error('Unexpected dispatch');
  return {ok:true,text:JSON.stringify(answer)};
 }}};
 register((name,fn)=>{hooks.set(name,fn);return {catch(){}}});const invoke=(name,e)=>hooks.get(name)($,e,async x=>x);
 await invoke('session.start',{});await clock.shift()();clock.length=0;const a=native,b=randomUUID(),c=randomUUID();
 const end=async()=>{r.hook({hook_event_name:'SessionEnd',session_id:native,reason:'clear'});await invoke('session.end',{sessionId:native,reason:'clear'})};
 const start=async id=>{native=id;const e={session_id:id,source:'clear'};r.hook({hook_event_name:'SessionStart',...e});await invoke('classic.SessionStart',e)};
 await end();await start(b);const syncing=clock.shift()();for(let i=0;i<20&&!release;i++)await tick();assert.equal(typeof release,'function');
 await end();await start(c);if(scenario==='held-final-id'){while(clock.length)await clock.shift()()}release();await syncing;
 for(let i=0;i<12&&s.nativeId!==c;i++){assert.ok(clock.length);await clock.shift()()}
 assert.equal(s.nativeId,c);assert.deepEqual(s.nativeContexts.map(x=>x.nativeId),[a,b]);assert.equal(s.state,'idle');assert.equal(r.ready,true);assert.equal(submits,0);
 assert.deepEqual([...new Set(transitions)],[b,c]);
});
test('a native /branch (SessionEnd resume, SessionStart fork) is followed like clear; a plain resume is not',async t=>{
 const f=await fixture(t),{w,id,s,r}=f;const first=s.nativeId,old=f.bind();
 s.messages.push({id:'before-branch',role:'user',text:'Before the branch'});w.setDraft(id,'Kept draft','owner');
 r.endRoot({...old,reason:'resume'});assert.equal(r.ready,false);assert.equal(s.nativeContextPending.reason,'resume');
 const branch=randomUUID();
 for(const payload of [{source:'resume'},{source:'clear'}])assert.throws(()=>r.clearRoot({...old,nextSessionId:branch,...payload}),'Only the fork start of the same process follows a resume end');
 const result=r.clearRoot({...old,nextSessionId:branch,source:'fork'});assert.ok(result.lease);assert.equal(r.ready,true);
 assert.equal(s.nativeId,branch);assert.equal(s.nativeContexts.length,1);assert.equal(s.nativeContexts[0].nativeId,first);assert.equal(s.nativeContexts[0].reason,'branch');
 const boundary=s.messages.find(m=>m.kind==='context');assert.match(boundary.text,/分支/);assert.equal(s.messages[0].text,'Before the branch');assert.equal(w.drafts.get(id),'Kept draft');
 assert.equal(s.nativeContextPending,null);assert.equal(r.validRootBinding(old),false);
 // A clear end can still only be followed by a clear start.
 const second=f.bind();r.endRoot({...second,reason:'clear'});assert.throws(()=>r.clearRoot({...second,nextSessionId:randomUUID(),source:'fork'}));
});
for(const reason of ['other','logout','prompt_input_exit'])test(`an unfollowed ending (${reason}) never accepts a transition, even without a source`,async t=>{
 const f=await fixture(t),{r}=f,b=f.bind();r.endRoot({...b,reason});
 for(const source of [undefined,'clear','fork','resume'])assert.throws(()=>r.clearRoot({...b,nextSessionId:randomUUID(),source}));
});
function modHarness(r,s){
 const hooks=new Map(),clock=[],transitions=[];const state={native:s.nativeId,submits:0};
 const $={session:{id:async()=>state.native,version:async()=>({version:'2.1.310'})},env:{get:async key=>key==='NAW_SUBMIT_SOCKET'?'/test/socket':'test-token'},clock:{after:(_ms,fn)=>clock.push(fn)},prompt:{submit:async()=>{state.submits++}},tool:{list:async()=>[]},http:{fetch:async(url,opts)=>{
  const body=JSON.parse(opts.body);let answer;
  if(url.endsWith('/root-bind'))answer=r.bindRoot(body);
  else if(url.endsWith('/root-end'))answer=r.endRoot(body);
  else if(url.endsWith('/root-clear')){answer=r.clearRoot(body);transitions.push(body.source+':'+body.nextSessionId)}
  else if(url.endsWith('/next'))answer={idle:true};else if(url.endsWith('/addressed-capability'))answer={};else throw Error('Unexpected dispatch '+url);
  return {ok:true,text:JSON.stringify(answer)};
 }}};
 return {hooks,clock,transitions,state,$,invoke:(name,e)=>hooks.get(name)($,e,async x=>x)};
}
async function loadMod(){
 const source=fs.readFileSync(path.join(__dirname,'../claude-bridge/hooks/register.js'),'utf8');
 return (await import('data:text/javascript;base64,'+Buffer.from(source+'\n//'+randomUUID()).toString('base64'))).register;
}
test('real mod: a fork admitted before it is current is sent once a later clear proves it',async t=>{
 const f=await fixture(t),{r,s}=f,h=modHarness(r,s),register=await loadMod();
 register((name,fn)=>{h.hooks.set(name,fn);return {catch(){}}});
 await h.invoke('session.start',{});await h.clock.shift()();h.clock.length=0;const a=h.state.native,b=randomUUID(),c=randomUUID();
 r.hook({hook_event_name:'SessionEnd',session_id:a,reason:'resume'});await h.invoke('session.end',{sessionId:a,reason:'resume'});
 const fork={session_id:b,source:'fork'};r.hook({hook_event_name:'SessionStart',...fork});await h.invoke('classic.SessionStart',fork); // engine still answers the old id here
 h.state.native=b;r.hook({hook_event_name:'SessionEnd',session_id:b,reason:'clear'});await h.invoke('session.end',{sessionId:b,reason:'clear'});
 h.state.native=c;const clear={session_id:c,source:'clear'};r.hook({hook_event_name:'SessionStart',...clear});await h.invoke('classic.SessionStart',clear);
 for(let i=0;i<40&&s.nativeId!==c;i++){if(!h.clock.length)await tick();else await h.clock.shift()()}
 assert.equal(s.nativeId,c);assert.deepEqual(s.nativeContexts.map(x=>[x.nativeId,x.reason]),[[a,'branch'],[b,'clear']]);assert.deepEqual(h.transitions,['fork:'+b,'clear:'+c]);
 assert.equal(r.ready,true);assert.equal(h.state.submits,0);
});
test('real mod: a fork that never becomes current is dropped after bounded retries, GUI stays closed',async t=>{
 const f=await fixture(t),{r,s}=f,h=modHarness(r,s),register=await loadMod();
 register((name,fn)=>{h.hooks.set(name,fn);return {catch(){}}});
 await h.invoke('session.start',{});await h.clock.shift()();h.clock.length=0;const a=h.state.native,b=randomUUID();
 r.hook({hook_event_name:'SessionEnd',session_id:a,reason:'resume'});await h.invoke('session.end',{sessionId:a,reason:'resume'});
 const fork={session_id:b,source:'fork'};r.hook({hook_event_name:'SessionStart',...fork});await h.invoke('classic.SessionStart',fork);
 let runs=0;while(h.clock.length&&runs<80){runs++;await h.clock.shift()();for(let i=0;i<3;i++)await tick()}
 assert.ok(runs<80,'Retries stop');assert.ok(runs>=30,'Retried before giving up');assert.deepEqual(h.transitions,[]);assert.equal(h.clock.length,0);
 assert.equal(s.nativeId,a);assert.equal(s.nativeContextPending?.reason,'resume');assert.equal(r.ready,false);assert.equal(h.state.submits,0);
});
test('events of an unfollowed new root (plain /resume) are dropped, not buffered',async t=>{
 const f=await fixture(t),{s,r}=f,old=f.bind(),other=randomUUID();
 r.endRoot({...old,reason:'resume'});
 r.hook({hook_event_name:'SessionStart',session_id:other,source:'resume'});
 for(let i=0;i<300;i++)r.hook({hook_event_name:'Notification',session_id:other,message:'late'});
 assert.equal(r.contextEvents?.length||0,0);assert.equal(r.contextEventsOverflow,undefined);assert.equal(r.ready,false);assert.equal(s.nativeId,old.sessionId);
 assert.throws(()=>r.clearRoot({...old,nextSessionId:other,source:'fork'}),'A fork start cannot be claimed after a resume start was seen');
});
test('native /background: an exit-like end followed by a fork start with this token is shown as moved to background, not ended',async t=>{
 const f=await fixture(t),{w,id,s,r}=f;r.host={hookTargets:new Map([[r.token,r]])};r.cancelNativeAbort=()=>{};
 const original=s.nativeId,bg=randomUUID();
 r.hook({hook_event_name:'SessionEnd',session_id:original,reason:'prompt_input_exit'});assert.equal(s.state,'stopping');
 r.terminalClosed({confirmed:true});assert.equal(s.state,'stopping','Waits briefly for a background handoff');assert.ok(r.host.hookTargets.has(r.token),'Token stays routed during the window');
 r.hook({hook_event_name:'SessionStart',session_id:bg,source:'fork'});
 assert.equal(s.state,'background');assert.match(s.activity,new RegExp(bg.slice(0,8)));assert.equal(s.nativeId,original,'The GUI row keeps its own native identity');
 assert.equal(w.runtimes.has(id),false);assert.equal(r.host.hookTargets.has(r.token),false);
 w.persist();const restored=new (require('../workspace.cjs').Workspace)({binaries:{},close(){}},f.dir);assert.equal(restored.get(id).state,'background','Reopen does not offer resuming the stale ID');assert.match(restored.get(id).activity,new RegExp(bg.slice(0,8)),'Reopen keeps the background ID text');restored.close();
});
test('a plain native /exit still ends after the short handoff window, and a late fork start cannot revive it',async t=>{
 const f=await fixture(t),{s,r}=f;r.host={hookTargets:new Map([[r.token,r]])};r.cancelNativeAbort=()=>{};r.backgroundHandoffMs=20;
 r.hook({hook_event_name:'SessionEnd',session_id:s.nativeId,reason:'prompt_input_exit'});r.terminalClosed({confirmed:true});
 await new Promise(resolve=>setTimeout(resolve,60));assert.equal(s.state,'ended');assert.equal(r.host.hookTargets.has(r.token),false);
 r.hook({hook_event_name:'SessionStart',session_id:randomUUID(),source:'fork'});assert.equal(s.state,'ended');
});
test('an exit for another reason ends at once; a fork start without an exit-like root end is not background',async t=>{
 const f=await fixture(t),{s,r}=f;r.host={hookTargets:new Map([[r.token,r]])};r.cancelNativeAbort=()=>{};
 r.hook({hook_event_name:'SessionStart',session_id:randomUUID(),source:'fork'});assert.equal(r.backgroundTo,undefined);
 r.hook({hook_event_name:'SessionEnd',session_id:s.nativeId,reason:'prompt_input_exit'});
 r.hook({hook_event_name:'SessionStart',session_id:randomUUID(),source:'fork',agent_id:'child'});assert.equal(r.backgroundTo,undefined);
 const g=await fixture(t);g.r.host={hookTargets:new Map()};g.r.cancelNativeAbort=()=>{};
 g.r.hook({hook_event_name:'SessionEnd',session_id:g.s.nativeId,reason:'other'});g.r.terminalClosed({confirmed:true});assert.equal(g.s.state,'ended');
});
test('CL310-02: /resume away then /background is shown as moved to background, not ended',async t=>{
 const f=await fixture(t),{s,r}=f;r.host={hookTargets:new Map([[r.token,r]])};r.cancelNativeAbort=()=>{};
 const old=f.bind(),away=randomUUID(),bg=randomUUID();
 r.endRoot({...old,reason:'resume'});r.hook({hook_event_name:'SessionEnd',session_id:old.sessionId,reason:'resume'});
 r.hook({hook_event_name:'SessionStart',session_id:away,source:'resume'});
 r.hook({hook_event_name:'SessionEnd',session_id:away,reason:'prompt_input_exit'});
 r.terminalClosed({confirmed:true});assert.notEqual(s.state,'ended','Waits for a possible handoff of the switched-to session');
 r.hook({hook_event_name:'SessionStart',session_id:bg,source:'fork'});
 assert.equal(s.state,'background');assert.match(s.activity,new RegExp(bg.slice(0,8)));assert.equal(s.nativeId,old.sessionId);
});
test('CL310-02: after /resume away, a plain exit or a foreign/late fork never becomes background; the switch stays explicit',async t=>{
 const f=await fixture(t),{s,r}=f;r.host={hookTargets:new Map([[r.token,r]])};r.cancelNativeAbort=()=>{};r.backgroundHandoffMs=20;
 const old=f.bind(),away=randomUUID();
 r.endRoot({...old,reason:'resume'});r.hook({hook_event_name:'SessionEnd',session_id:old.sessionId,reason:'resume'});
 r.hook({hook_event_name:'SessionStart',session_id:away,source:'resume'});
 r.hook({hook_event_name:'SessionStart',session_id:randomUUID(),source:'fork'}); // a fork before the switched session ended (e.g. /fork copy)
 assert.notEqual(s.state,'background');
 r.hook({hook_event_name:'SessionEnd',session_id:away,reason:'prompt_input_exit'});r.terminalClosed({confirmed:true});
 await new Promise(resolve=>setTimeout(resolve,60));
 assert.equal(s.state,'ended');assert.match(s.activity,new RegExp(away.slice(0,8)),'Names the switched-to session whose continuation is not confirmed');
 r.hook({hook_event_name:'SessionStart',session_id:randomUUID(),source:'fork'});assert.equal(s.state,'ended','A late fork after the window cannot revive it');
});
test('stop() clears a pending background-handoff wait',async t=>{
 const f=await fixture(t),{s,r}=f;r.host={hookTargets:new Map([[r.token,r]])};r.cancelNativeAbort=()=>{};
 r.terminal.stop=async()=>{};
 r.hook({hook_event_name:'SessionEnd',session_id:s.nativeId,reason:'prompt_input_exit'});r.terminalClosed({confirmed:true});assert.ok(r.closedAwaitingBackground);
 await r.stop();assert.equal(r.closedAwaitingBackground,null);
});
test('CL310-02: /resume back to a retired context of this row, then /background, is shown as moved to background',async t=>{
 const f=await fixture(t),{s,r}=f;r.host={hookTargets:new Map([[r.token,r]])};r.cancelNativeAbort=()=>{};
 const first=s.nativeId;f.clear();const current=f.bind(),bg=randomUUID();
 assert.equal(s.nativeContexts.at(-1).nativeId,first);
 r.endRoot({...current,reason:'resume'});r.hook({hook_event_name:'SessionEnd',session_id:current.sessionId,reason:'resume'});
 r.hook({hook_event_name:'SessionStart',session_id:first,source:'resume'});
 r.hook({hook_event_name:'SessionEnd',session_id:first,reason:'prompt_input_exit'});
 r.terminalClosed({confirmed:true});assert.notEqual(s.state,'ended');
 r.hook({hook_event_name:'SessionStart',session_id:bg,source:'fork'});
 assert.equal(s.state,'background');assert.match(s.activity,new RegExp(bg.slice(0,8)));
});
for(const [label,end,start] of [['resume','resume','resume'],['clear','clear','clear'],['branch','resume','fork']])test(`CL310-02: a further ${label} inside the switched session is followed, then /background is recognised`,async t=>{
 const f=await fixture(t),{s,r}=f;r.host={hookTargets:new Map([[r.token,r]])};r.cancelNativeAbort=()=>{};
 const old=f.bind(),away=randomUUID(),next=randomUUID(),bg=randomUUID();
 r.endRoot({...old,reason:'resume'});r.hook({hook_event_name:'SessionEnd',session_id:old.sessionId,reason:'resume'});
 r.hook({hook_event_name:'SessionStart',session_id:away,source:'resume'});
 r.hook({hook_event_name:'SessionEnd',session_id:away,reason:end});r.hook({hook_event_name:'SessionStart',session_id:next,source:start});
 assert.equal(r.switchedTo,next);
 r.hook({hook_event_name:'SessionEnd',session_id:next,reason:'prompt_input_exit'});r.terminalClosed({confirmed:true});
 r.hook({hook_event_name:'SessionStart',session_id:bg,source:'fork'});
 assert.equal(s.state,'background');assert.match(s.activity,new RegExp(bg.slice(0,8)));
});
test('the root hook-reported permission mode and effort are kept on the row; children and retired contexts cannot change them',async t=>{
 const f=await fixture(t),{w,s,r}=f;const first=s.nativeId;
 const tool=(fields)=>r.hook({hook_event_name:'PreToolUse',tool_name:'Read',tool_use_id:randomUUID(),session_id:s.nativeId,...fields});
 tool({permission_mode:'bypassPermissions'});assert.equal(s.nativePermissionMode,'bypassPermissions');
 tool({permission_mode:'auto',agent_id:'child-agent'});tool({permission_mode:'plan',session_id:randomUUID()});tool({permission_mode:'not-a-mode'});
 assert.equal(s.nativePermissionMode,'bypassPermissions','Only the root reports the session mode');
 f.clear();tool({permission_mode:'default',session_id:first});assert.equal(s.nativePermissionMode,'bypassPermissions','A retired context cannot change it');
 w.persist();assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'workspace.json'))).sessions[0].nativePermissionMode,'bypassPermissions');
 tool({permission_mode:'auto'});assert.equal(s.nativePermissionMode,'auto','A later native choice replaces it');
 tool({effort:{level:'xhigh'}});assert.equal(s.nativeEffort,'xhigh');assert.equal(s.nativePermissionMode,'auto','A hook without a mode keeps the last one');
 tool({effort:{level:'low'},agent_id:'child-agent'});tool({effort:{level:'turbo'}});tool({effort:'max'});
 assert.equal(s.nativeEffort,'xhigh','Only a valid root effort report counts');
 tool({effort:{level:'max'}});assert.equal(s.nativeEffort,'max');
});
test('a recovery relaunch passes bypass and effort again only as the session last reported them',async t=>{
 const { Claude: Adapter } = require('../adapters.cjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'naw-posture-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const argvFile=path.join(dir,'argv.txt'),binary=path.join(dir,'claude');
 // A stand-in native binary that only records how NAW launched it.
 fs.writeFileSync(binary,`#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\n`,{mode:0o700});
 const launch=async record=>{
  fs.rmSync(argvFile,{force:true});
  const host={binaries:{claude:binary},privateDir:dir,hookTargets:new Map(),hookSocket:path.join(dir,'hook.sock'),submitSocket:path.join(dir,'submit.sock')};
  const r=new Adapter({id:randomUUID(),nativeId:randomUUID(),name:'Posture',cwd:dir,...record},host);
  await new Promise(resolve=>r.terminal.once('closed',resolve));r.submission.close();
  return fs.readFileSync(argvFile,'utf8').trim().split('\n');
 };
 const bypass=await launch({recovering:true,nativePermissionMode:'bypassPermissions',nativeEffort:'xhigh'});
 assert.equal(bypass[0],'--resume');assert.deepEqual(bypass.slice(-4),['--permission-mode','bypassPermissions','--effort','xhigh']);
 assert.deepEqual((await launch({recovering:true,nativePermissionMode:'auto',nativeEffort:'max'})).slice(-2),['--effort','max'],'Effort is kept without bypass');
 for(const record of [{recovering:true,nativePermissionMode:'auto'},{recovering:true,nativeEffort:'turbo'},{recovering:false,nativePermissionMode:'bypassPermissions',nativeEffort:'xhigh'}]){
  const argv=await launch(record);assert.ok(!argv.includes('--permission-mode')&&!argv.includes('--effort'),`No posture flag for ${JSON.stringify(record)}`);
 }
});
test('a recovery refuses while another claude process holds the same native ID',async t=>{
 const { Claude: Adapter } = require('../adapters.cjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'naw-holder-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const id=randomUUID(),external=path.join(dir,'claude'),launched=path.join(dir,'launched');
 // An external terminal's `claude --resume <id>`, as ps shows it.
 fs.writeFileSync(external,'#!/bin/sh\nsleep 30\n',{mode:0o700});
 const holder=require('node:child_process').spawn('/bin/sh',[external,'--resume',id],{stdio:'ignore'});t.after(()=>{try{holder.kill('SIGKILL');}catch{}});
 const binary=path.join(dir,'native');fs.writeFileSync(binary,`#!/bin/sh\ntouch '${launched}'\n`,{mode:0o700});
 const host={binaries:{claude:binary},privateDir:dir,hookTargets:new Map(),hookSocket:path.join(dir,'hook.sock'),submitSocket:path.join(dir,'submit.sock')};
 const record={id:randomUUID(),nativeId:id,name:'Holder',cwd:dir,recovering:true};
 await new Promise(resolve=>setTimeout(resolve,200));
 assert.throws(()=>new Adapter(record,host),new RegExp(`PID ${holder.pid}`));
 assert.equal(host.hookTargets.size,0,'A refused recovery registers no hook target');
 assert.doesNotThrow(()=>new Adapter({...record,id:randomUUID(),nativeId:randomUUID()},host).submission.close(),'Another session ID is not blocked');
 holder.kill('SIGKILL');await new Promise(resolve=>holder.once('exit',resolve));
 const r=new Adapter(record,host);await new Promise(resolve=>r.terminal.once('closed',resolve));r.submission.close();
 assert.ok(fs.existsSync(launched),'Once the other writer exits, recovery launches');
});
test('native processes do not inherit the service locations',()=>{
 const { nativeEnvironment } = require('../platform.cjs');
 const saved={...process.env};
 Object.assign(process.env,{NAW_WORKSPACE:'/live/workspace',NAW_RUNTIME_CONFIG:'/live/runtime-locations.json',NAW_APP_VERSION:'9.9.9',NAW_DATA_DIR:'/live/profile'});
 try{
  const env=nativeEnvironment({NAW_HOOK_TOKEN:'token'});
  for(const key of ['NAW_WORKSPACE','NAW_RUNTIME_CONFIG','NAW_APP_VERSION','NAW_DATA_DIR']) assert.equal(env[key],undefined,key);
  assert.equal(env.NAW_HOOK_TOKEN,'token','Per-session values are still passed');
 }finally{for(const key of ['NAW_WORKSPACE','NAW_RUNTIME_CONFIG','NAW_APP_VERSION','NAW_DATA_DIR']) if(key in saved) process.env[key]=saved[key]; else delete process.env[key];}
});
test('a picker branch launches the native picker once, then always resumes its own ID',async t=>{
 const { Claude: Adapter } = require('../adapters.cjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'naw-fork-argv-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const argvFile=path.join(dir,'argv.txt'),binary=path.join(dir,'claude');
 fs.writeFileSync(binary,`#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\n`,{mode:0o700});
 const launch=async record=>{
  fs.rmSync(argvFile,{force:true});
  const host={binaries:{claude:binary},privateDir:dir,hookTargets:new Map(),hookSocket:path.join(dir,'hook.sock'),submitSocket:path.join(dir,'submit.sock')};
  const r=new Adapter({id:randomUUID(),name:'Branch',cwd:dir,...record},host);
  await new Promise(resolve=>r.terminal.once('closed',resolve));r.submission.close();
  return fs.readFileSync(argvFile,'utf8').trim().split('\n');
 };
 const id=randomUUID();
 assert.deepEqual((await launch({nativeId:id,forkPicker:true})).slice(0,4),['--resume','--fork-session','--session-id',id],'First launch: native picker, branch into the pre-assigned ID');
 assert.deepEqual((await launch({nativeId:id,forkPicker:true,recovering:true})).slice(0,2),['--resume',id],'Recovery resumes the branch ID, never the picker');
 assert.deepEqual((await launch({nativeId:id})).slice(0,2),['--session-id',id],'A fresh session is unchanged');
});
test('the branch marker clears on its own session start; a cancelled picker says no branch was made',async t=>{
 const f=await fixture(t),{s,r}=f;
 s.forkPicker=true;
 r.hook({hook_event_name:'SessionStart',session_id:randomUUID(),source:'resume'});assert.equal(s.forkPicker,true,'Another session cannot clear it');
 r.hook({hook_event_name:'SessionStart',session_id:s.nativeId,source:'resume',agent_id:'child'});assert.equal(s.forkPicker,true,'A child cannot clear it');
 r.hook({hook_event_name:'SessionStart',session_id:s.nativeId,source:'resume'});assert.equal(s.forkPicker,false);
 const g=await fixture(t);g.s.forkPicker=true;g.r.host={hookTargets:new Map()};g.r.token='t';
 g.r.finishClose();assert.equal(g.s.state,'ended');assert.equal(g.s.activity,'未选择会话，没有创建分支。');
});
test('a Claude picker branch is created in terminal view; other branch requests are refused',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'naw-fork-create-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let created;
 const host={binaries:{},close(){},create(record){created={...record};const r=new EventEmitter();r.start=async()=>r.emit('state','idle');return r;}};
 const w=new Workspace(host,dir);t.after(()=>w.close());
 const id=await w.create('claude',dir,'owner','Branch','chat',{fork:'picker'});
 assert.equal(created.forkPicker,true);assert.equal(created.view,'terminal');assert.equal(w.get(id).view,'terminal');
 await assert.rejects(w.create('codex',dir,'owner','X','chat',{fork:'picker'}),/无效的分支请求/);
 await assert.rejects(w.create('claude',dir,'owner','X','chat',{fork:'other'}),/无效的分支请求/);
 assert.equal(w.sessions.size,1,'Refused requests add no row');
});
test('a picker branch still waiting when the service stops is restored as unconfirmed, not interrupted work',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'naw-fork-restore-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const host={binaries:{},close(){},create(record){const r=new EventEmitter();r.start=async()=>r.emit('state','idle');return r;}};
 const w=new Workspace(host,dir);const id=await w.create('claude',dir,'owner','Branch','terminal',{fork:'picker'});const plain=await w.create('claude',dir,'owner','Plain','terminal');
 w.persist();w.close();
 const restored=new Workspace({binaries:{},close(){}},dir);t.after(()=>restored.close());
 assert.equal(restored.get(id).state,'ended');assert.equal(restored.get(id).activity,'没有确认创建分支。');
 assert.equal(restored.get(plain).state,'recoverable','Ordinary rows keep the interrupted-work restore');
});
