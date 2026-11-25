const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {actor,tick,fixture,render}=require('./fixtures/confirmation-batch-scene.cjs');
require('../renderer/confirmation-batch.js');
const batch=globalThis.nativeWorkspaceConfirmationBatch;
function card(id,state='confirmation-required',answer,extra={}){
 const summary={action:'create',method:'create',name:'Helper '+id,provider:'codex',createKey:'same-config',risks:[]};
 const op={id,sessionId:'agent',nativeId:'native',state,summary,confirmation:{kind:'message',options:{buttons:['Cancel','Confirm'],cancelId:0}},...(answer?{answer}:{}),...extra};
 return {key:'agent:native:'+id,operationId:id,sessionId:'agent',nativeId:'native',time:1,state,actionable:state==='confirmation-required'&&!answer,summary,message:{backgroundOperation:op}};
}
async function entered(f){for(let i=0;i<100&&!f.entered.includes('A');i++)await tick();assert.ok(f.entered.includes('A'));}
test('queued position follows accepted decision order, not card creation order',async()=>{
 const f=await fixture();let a,b,c;try{
  await f.ask('A');await f.ask('C');await f.ask('B');
  a=f.control.decide('agent','native','A',1);await entered(f);
  b=f.control.decide('agent','native','B',1);c=f.control.decide('agent','native','C',1);
  const ops=f.cards().map(c=>c.message.backgroundOperation),by=id=>ops.find(o=>o.id===id);
  assert.equal(by('B').queuedAhead,1);assert.equal(by('C').queuedAhead,2);
  assert.equal(by('A').startedAt,f.control.receipt(actor,'A').humanDecisionAt);
  assert.ok(Number.isSafeInteger(by('A').startedAt));
 }finally{f.release();await Promise.allSettled([a,b,c]);await f.cleanup();}
});
test('two risk-free resume cards merge, preserving method, origin and risk boundaries',()=>{
 const resume=id=>{const c=card(id);c.summary={action:'resume',method:'resume',target:id,risks:[]};c.message.backgroundOperation.summary=c.summary;return c;};
 const a=resume('a'),b=resume('b');assert.equal(batch.plan([a,b]).length,1);
 const restore=resume('restore');restore.summary={...restore.summary,method:'restoreSession',action:'restoreSession'};
 const risky=resume('risk');risky.summary={...risky.summary,risks:['shared']};
 const foreign=resume('foreign');foreign.nativeId='different';
 assert.deepEqual(batch.plan([a,b,restore,risky,foreign,card('new')]).map(g=>g.cards.map(c=>c.operationId)),[['a','b']]);
});
test('five accepted cards show exact per-row queue position and running duration',()=>{
 const startedAt=Date.now()-13000;
 const cards=[card('A','complete'),card('B','complete'),card('C','running',null,{startedAt}),card('D','confirmation-required','queued',{queuedAhead:1}),card('E','confirmation-required','queued',{queuedAhead:2})];
 const r=render(cards,true),s=r.sandbox;s.Date=class extends Date{static now(){return startedAt+13000;}};
 vm.runInContext('entry.backgroundKey=null;renderBackgroundControls(entry,message)',s);
 const shown=s.entry.backgroundControls.textContent;assert.match(shown,/前面还有 1 项/);assert.match(shown,/前面还有 2 项/);assert.match(shown,/已 13 秒/);
});
test('a single accepted queued card names its queue position',()=>{
 const r=render([card('one','confirmation-required','queued',{queuedAhead:1})]);assert.match(r.shown,/前面还有 1 项/);
});
test('a single click immediately explains locked controls and cannot submit twice',async()=>{
 const r=render([card('one')]),s=r.sandbox;let finish,calls=0;
 s.api.backgroundDecision=()=>{calls++;return new Promise(resolve=>{finish=resolve;});};
 const first=vm.runInContext('answerConfirmationCard(message.backgroundOperation,1)',s);
 await vm.runInContext('answerConfirmationCard(message.backgroundOperation,1)',s);
 vm.runInContext('renderBackgroundControls(entry,message)',s);
 assert.match(s.entry.backgroundControls.textContent,/正在提交答复/);assert.equal(calls,1);
 finish({state:'complete'});await first;
});
test('disconnect and fresh authoritative reconnect preserve accepted state without resending',()=>{
 const cards=[card('A','running',null,{startedAt:Date.now()-5000}),card('B','confirmation-required','queued',{queuedAhead:1})];
 const r=render(cards,true),s=r.sandbox;
 vm.runInContext('disconnected=true;renderBackgroundControls(entry,message)',s);
 assert.match(s.entry.backgroundControls.textContent,/待核实/);
 vm.runInContext('disconnected=false;renderBackgroundControls(entry,message)',s);
 assert.match(s.entry.backgroundControls.textContent,/前面还有 1 项/);assert.doesNotMatch(s.entry.backgroundControls.textContent,/等待你的确认/);
});
test('partial results keep failed and unknown receipts distinct from completion',()=>{
 const cards=[card('A','complete'),card('B','complete'),card('C','complete'),card('D','not-executed',null,{disposition:'invalidated',error:'Synthetic target changed'}),card('E','unconfirmed',null,{error:'Synthetic receipt unavailable'})];
 const r=render(cards,true);assert.match(r.shown,/Synthetic target changed/);assert.match(r.shown,/Synthetic receipt unavailable/);assert.match(r.shown,/结果未确认/);assert.match(r.shown,/已执行 3 项/);
});

test('unverified single submissions stay locked, and only a fresh actionable snapshot unlocks them',async()=>{
 const original=card('one'),r=render([original]),s=r.sandbox;let calls=0;
 s.api.backgroundDecision=async()=>{calls++;throw Error('Synthetic closed transport');};s.api.initial=async()=>{throw Error('Synthetic source unavailable');};
 await vm.runInContext('answerConfirmationCard(message.backgroundOperation,1)',s);
 vm.runInContext('renderBackgroundControls(entry,message)',s);assert.match(s.entry.backgroundControls.textContent,/待核实/);
 await vm.runInContext('answerConfirmationCard(message.backgroundOperation,1)',s);assert.equal(calls,1);
 s.state={backgroundConfirmations:[card('one')],backgroundConfirmationsAvailable:false};
 vm.runInContext('renderBackgroundControls(entry,message)',s);assert.match(s.entry.backgroundControls.textContent,/待核实/);
 s.state={backgroundConfirmations:[card('one')],backgroundConfirmationsAvailable:true};
 vm.runInContext('renderBackgroundControls(entry,message)',s);assert.doesNotMatch(s.entry.backgroundControls.textContent,/待核实|正在提交/);assert.equal(calls,1);
});
test('a missing unavailable snapshot does not discard an answered batch',()=>{
 const cards=[card('A','running',null,{startedAt:Date.now()}),card('B','confirmation-required','queued',{queuedAhead:1})],r=render(cards,true),s=r.sandbox;
 vm.runInContext('state={backgroundConfirmations:[],backgroundConfirmationsAvailable:false};confirmationBatchRole(message.backgroundOperation)',s);
 assert.equal(vm.runInContext('confirmationBatchStarted.size',s),1);
 s.state={backgroundConfirmations:cards,backgroundConfirmationsAvailable:true};vm.runInContext('renderBackgroundControls(entry,message)',s);
 assert.match(s.entry.backgroundControls.textContent,/前面还有 1 项/);
});
test('restoreSession batches stay separate from resume batches and never include expired cards',()=>{
 const restore=id=>{const c=card(id);c.summary={action:'restoreSession',method:'restoreSession',risks:[]};return c;};
 const a=restore('a'),b=restore('b'),expired=restore('expired');expired.state='expired';expired.actionable=false;
 assert.deepEqual(batch.plan([a,b,expired]).map(g=>g.cards.map(c=>c.operationId)),[['a','b']]);
});
test('a submitted batch with no acknowledgement stays unverified when its source list disappears',()=>{
 const r=render([card('A'),card('B')],true),s=r.sandbox;
 vm.runInContext('state={backgroundConfirmations:[],backgroundConfirmationsAvailable:false};renderBackgroundControls(entry,message)',s);
 assert.match(s.entry.backgroundControls.textContent,/待核实/);assert.doesNotMatch(s.entry.backgroundControls.textContent,/等待你的确认/);
});
test('known finished batch receipts remain finished when transport closes',()=>{
 const r=render([card('A','complete'),card('B','complete')],true),s=r.sandbox;
 vm.runInContext('disconnected=true;renderBackgroundControls(entry,message)',s);
 assert.match(s.entry.backgroundControls.textContent,/已执行 2 项/);assert.doesNotMatch(s.entry.backgroundControls.textContent,/状态待核实/);
});
test('a real resume batch still executes and receipts each original operation exactly once',async()=>{
 const f=await fixture(),effects=[];try{
  f.control.handlers.set('resume',async(_context,id)=>{effects.push(id);});
  const identity={nativeId:'native',sessionId:'native-session',turnId:'turn',callId:'call'};
  for(const id of ['A','B'])assert.equal((await f.control.call({sender:actor,identity,valid:()=>true},{action:'invoke',operation_id:'resume-'+id,method:'resume',arguments:[id]})).state,'confirmation-required');
  const cards=f.cards(),groups=batch.plan(cards);assert.equal(groups.length,1);assert.equal(groups[0].cards.length,2);
  const r=render(cards),s=r.sandbox;s.api.backgroundDecision=(...args)=>f.control.decide(...args);
  await vm.runInContext('answerConfirmationBatch(confirmationBatchRole(message.backgroundOperation).batch,false)',s);
  assert.deepEqual(effects,['A','B']);assert.equal(f.control.receipt(actor,'resume-A').state,'complete');assert.equal(f.control.receipt(actor,'resume-B').state,'complete');
 }finally{await f.cleanup();}
});
test('a pending individual answer is excluded from a new batch and a stale batch cannot resubmit it',async()=>{
 const cards=[card('A'),card('B'),card('C')],r=render(cards),s=r.sandbox,finish=[];let calls=0;
 s.api.backgroundDecision=()=>{calls++;return new Promise(resolve=>finish.push(resolve));};
 s.first=cards[0].message.backgroundOperation;s.stale=batch.plan(cards)[0];let a,b;
 try{
  a=vm.runInContext('answerConfirmationCard(first,1)',s);
  b=vm.runInContext('answerConfirmationBatch(stale,false)',s);await tick();assert.equal(calls,1);
  vm.runInContext('renderBackgroundControls(entry,message)',s);
  assert.match(s.entry.backgroundControls.textContent,/正在提交答复/);
  s.message=cards[1].message;
  vm.runInContext('renderBackgroundControls(entry,message)',s);
  assert.match(s.entry.backgroundControls.textContent,/2 项/);
 }finally{for(const release of finish)release({state:'complete'});await Promise.allSettled([a,b]);}
});
test('submitting an unexpired single card cannot be overwritten by its expiry countdown',async()=>{
 const r=render([card('one','confirmation-required',null,{expiresAt:Date.now()+60000})]),s=r.sandbox;let finish,pending;
 s.api.backgroundDecision=()=>new Promise(resolve=>{finish=resolve;});s.backgroundRemaining=line=>{line.textContent='COUNTDOWN';};
 try{pending=vm.runInContext('answerConfirmationCard(message.backgroundOperation,1)',s);vm.runInContext('renderBackgroundControls(entry,message)',s);assert.match(s.entry.backgroundControls.textContent,/正在提交答复/);}
 finally{finish({state:'complete'});await pending;}
});
for(const language of ['zh','en'])for(const cause of ['disconnected','unavailable'])for(const shape of ['single','batch'])test('waiting '+shape+' explains '+cause+' in '+language+' and recovers without submitting',()=>{
 const cards=(shape==='single'?['A']:['A','B']).map(id=>{const c=card(id,'confirmation-required',null,{expiresAt:Date.now()+60000});c.expiresAt=c.message.backgroundOperation.expiresAt;return c;});
 const r=render(cards),s=r.sandbox,locale=require('../ui-locale.js');let calls=0;
 s.uiText=(key,params)=>locale.format(language,key,params);
 s.uiNode=(tag,key,params,cls)=>s.node(tag,s.uiText(key,params),cls);
 s.ui.display.text=(el,key,params)=>{el.textContent=s.uiText(key,params);};
 s.backgroundRemaining=line=>{line.textContent='COUNTDOWN';};s.api.backgroundDecision=()=>{calls++;};
 s.disconnected=cause==='disconnected';s.state.backgroundConfirmationsAvailable=cause!=='unavailable';
 vm.runInContext('renderBackgroundControls(entry,message)',s);
 const shown=s.entry.backgroundControls.textContent,expected=language==='zh'
  ?cause==='disconnected'?'连接中断，恢复后可确认':'确认服务暂不可用'
  :cause==='disconnected'?'Disconnected; reconnect before confirming':'Confirmation service temporarily unavailable';
 assert.ok(shown.includes(expected),shown);assert.doesNotMatch(shown,/COUNTDOWN/);
 const walk=el=>typeof el==='object'&&el?[el,...(el.children||[]).flatMap(walk)]:[];
 const buttons=walk(s.entry.backgroundControls).filter(el=>el.tag==='button');assert.equal(buttons.length,shape==='single'?2:3);assert.ok(buttons.every(el=>el.disabled));
 s.disconnected=false;s.state.backgroundConfirmationsAvailable=true;
 vm.runInContext('renderBackgroundControls(entry,message)',s);
 assert.ok(walk(s.entry.backgroundControls).filter(el=>el.tag==='button').every(el=>!el.disabled));
 assert.equal(calls,0);assert.ok(!s.entry.backgroundControls.textContent.includes(expected));
});
