const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { randomUUID } = require('node:crypto'), { EventEmitter } = require('node:events');
const { Claude } = require('../adapters.cjs');
const { Workspace } = require('../workspace.cjs');
const { SubmissionChannel, createSubmissionServer } = require('../claude-submit.cjs');
const { ProgressJournal } = require('../observation.cjs');

function adapter() {
  const r = Object.create(Claude.prototype); EventEmitter.call(r);
  r.record = { nativeId: randomUUID() }; r.terminal = { alive: true }; r.submission = new SubmissionChannel();
  r.bindRoot({ sessionId: r.record.nativeId }); return r;
}
async function mod({ version = '2.1.306', fetchObservation, runtime, legacy = false, requestHandler, promptSubmit, modelReader, toolReader, usageReader, turnAbort, now } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../claude-bridge/hooks/register.js'), 'utf8').replace('const legacyOnly = false;', `const legacyOnly = ${legacy};`);
  const { register, testObserveModel, testObserveUsage } = await import('data:text/javascript;base64,' + Buffer.from(source + '\nexport { observeModel as testObserveModel, observeUsage as testObserveUsage };\n//' + randomUUID()).toString('base64'));
  const r = runtime || adapter(), clock = [], hooks = new Map(), requests = [];
  let native = r.record.nativeId, token = 'a'.repeat(64);
  if (legacy) r.retainedReader = true;
  const $ = { session: { id: async () => native, version: async () => ({ version }), ...(modelReader ? { model: modelReader } : {}), ...(usageReader ? { usage: usageReader } : {}) },
    env: { get: async key => key === 'NAW_SUBMIT_SOCKET' ? (legacy ? undefined : '/fixture/socket') : key === 'NAW_HOOK_SOCKET' ? '/fixture/hooks.sock' : 'fixture-token' },
    fs: { read: async () => JSON.stringify({ sessionId: native, socketPath: '/fixture/gui-submit.sock', token, compat: true, nativeBlocks: true }) },
    clock: { after: (delay, fn) => { fn.delay = delay; clock.push(fn); return { cancel() { const i = clock.indexOf(fn); if (i >= 0) clock.splice(i, 1); } }; }, ...(now ? { now } : {}) },
    tool: { list: toolReader || (async () => []) },
    turn: { abort: turnAbort || (async () => { throw Error('No native control requested'); }) },
    prompt: { read: async () => ({ text: '' }), submit: promptSubmit || (async () => { throw Error('Observation must never submit'); }) },
    http: { fetch: async (url, options) => {
      const body = JSON.parse(options.body); let result;
      if (requestHandler) { const response = await requestHandler(url, options, body, r); if (response) return response; }
      if (url.endsWith('/root-bind')) result = await r.bindRoot(body);
      else if (url.endsWith('/next')) { if (body.observationGap) r.observeRootGap(body); result = { idle: true }; }
      else if (url.endsWith('/root-end')) result = r.endRoot(body);
      else if (url.endsWith('/root-clear')) {
        r.record.nativeId = body.nextSessionId; r.rootEnding = null; r.rootLease = randomUUID(); r.observationEpoch = randomUUID(); r.rootObservation = null; result = { lease: r.rootLease, observationEpoch: r.observationEpoch };
      }
      else if (url.endsWith('/observation')) { requests.push(body); result = fetchObservation ? await fetchObservation(body, r) : r.observeRoot(body); }
      else if (url.endsWith('/abort-result')) result = r.nativeAbortResult(body);
      else throw Error('Unexpected request: ' + url);
      return { ok: true, text: JSON.stringify(result) };
    } } };
  register((name, matcher, handler) => { const values=hooks.get(name)||[];values.push({matcher:handler?matcher:null,fn:handler||matcher});hooks.set(name,values);return {catch(){}}; });
  const matches=(filter,value)=>!filter||Object.entries(filter).every(([key,want])=>want&&typeof want==='object'?matches(want,value?.[key]):value?.[key]===want);
  const invoke = (name, e, next = async e => ({ uuid: e.uuid, message: e.message })) => {
    const selected=(hooks.get(name)||[]).filter(hook=>matches(hook.matcher,e));
    const dispatch=(index,value)=>{if(index===selected.length)return next(value);const rest=v=>dispatch(index+1,v);rest.origin=next.origin;return selected[index].fn($,value,rest);};return dispatch(0,e);
  };
  await invoke('session.start', {}); await clock.shift()(); const poll = clock.find(fn => fn.delay === 0); clock.length = 0;
  return { r, clock, requests, invoke, poll, readUsage() { return testObserveUsage($); }, setUsageReader(fn) { $.session.usage = fn; }, setModelReader(fn) { $.session.model = fn; }, readModel() { return testObserveModel($); }, setToken(value) { token = value; }, setNativeId(id) { native = id; }, append: (e, next) => invoke('session.append', e, next) };
}
const response = (text = 'Intermediate native text', extra = {}) => ({ uuid: randomUUID(), door: 'response', origin: { kind: 'model', model: 'synthetic' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }, ...extra });

for(const order of ['api-first','boundary-first'])test('native GUI abort requires API result, exact interrupted boundary and real submission settlement: '+order,async()=>{
 const r=adapter(),turnId=randomUUID();r.nativeAbortAvailable=true;r.rootTurn={id:turnId,status:'working'};
 r.terminal.input=()=>{throw Error('A native API interruption must not also write Escape');};
 const done=r.interrupt(),command=r.nativeAbortCommand();assert.equal(command.turnId,turnId);assert.equal(r.nativeAbortCommand(),null,'The native command is delivered once');
 const result={sessionId:r.record.nativeId,lease:r.rootLease,epoch:r.observationEpoch,id:command.id,turnId,status:'aborted',submitSettled:false};
 if(order==='api-first')r.nativeAbortResult(result);
 r.rootTurn.status='idle';r.finishInterrupted(turnId);
 if(order==='boundary-first')r.nativeAbortResult(result);
 assert.equal(r.nativeInputRequired,true,'Local completion cannot replace the mod submit finally proof');
 r.submission.pending={tag:'previous-submission'};r.nativeAbortResult({...result,submitSettled:true});
 assert.equal(r.nativeInputRequired,true,'The previous receipt is still using the channel');
 r.submission.pending=null;r.completeNativeAbort();await done;assert.equal(r.nativeInputRequired,false);
});
test('stale abort results cannot unlock a newer native turn or a changed control revision',async()=>{
 for(const changed of ['turn','control','epoch','gap']){
  const r=adapter(),turnId=randomUUID();r.nativeAbortAvailable=true;r.rootTurn={id:turnId,status:'working'};r.terminal.input=()=>{throw Error('No fallback key');};
  const done=r.interrupt(),command=r.nativeAbortCommand(),result={sessionId:r.record.nativeId,lease:r.rootLease,epoch:r.observationEpoch,id:command.id,turnId,status:'aborted',submitSettled:true};
  r.nativeInputRequired=true;
  if(changed==='turn')r.rootTurn={id:'newer-turn',status:'working'};
  if(changed==='control')r.record.controlRevision=1;
  if(changed==='epoch')r.observationEpoch='new-epoch';
  if(changed==='gap')r.observeRootGap(result);
  assert.throws(()=>r.nativeAbortResult(result),/Native abort changed/);assert.equal(r.nativeInputRequired,true);
  r.cancelNativeAbort();await assert.rejects(done,/未确认/);
 }
});
test('duplicate GUI interruption reuses its exact pending native operation without invalidating control',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'naw-abort-unit-')),host={binaries:{},close(){}},w=new Workspace(host,dir),r=adapter();
 const s=r.record;Object.assign(s,{id:'synthetic',owner:'window',view:'chat',controlRevision:0,memberRevision:0,provider:'claude',messages:[],state:'working'});
 w.sessions.set(s.id,s);w.runtimes.set(s.id,r);w.bind(s,r);r.nativeAbortAvailable=true;r.rootTurn={id:'native-turn',status:'working'};r.terminal.input=()=>{throw Error('No fallback key');};
 t.after(()=>{w.close();fs.rmSync(dir,{recursive:true,force:true});});
 const first=w.interrupt(s.id,'window'),command=r.nativeAbortCommand(),second=w.interrupt(s.id,'window');assert.equal(s.controlRevision,1);
 r.nativeQueue=true;r.ready=true;r.chatAvailable=true;w.drafts.set(s.id,'The next direction');
 assert.equal(w.snapshot().sessions[0].interruptPending,true);
 await assert.rejects(w.queue(s.id,'The next direction','window'),/草稿保留/);
 await assert.rejects(w.send(s.id,'The next direction','window'),/中断确认/);
 assert.equal(r.queueAvailable,false);assert.equal(s.controlRevision,1);assert.equal(r.nativeAbortCurrent(r.nativeAbortRequest),true);
 assert.equal(w.drafts.get(s.id),'The next direction');assert.equal(w.versions.dispatches,0);
 r.rootTurn.status='idle';r.finishInterrupted('native-turn');r.nativeAbortResult({sessionId:s.nativeId,lease:r.rootLease,epoch:r.observationEpoch,id:command.id,turnId:'native-turn',status:'aborted',submitSettled:true});
 await Promise.all([first,second]);assert.equal(r.nativeInputRequired,false);assert.equal(w.snapshot().sessions[0].interruptPending,false);
});
test('a delayed old abort timeout cannot cancel a later native operation',async t=>{
 const callbacks=[];t.mock.method(global,'setTimeout',fn=>{callbacks.push(fn);return 0;});
 const r=adapter();r.nativeAbortAvailable=true;r.rootTurn={id:'old-turn',status:'working'};
 const old=r.interrupt();r.cancelNativeAbort();await assert.rejects(old,/未确认/);
 r.rootTurn={id:'new-turn',status:'working'};const current=r.interrupt(),request=r.nativeAbortRequest;
 callbacks[0]();assert.equal(r.nativeAbortRequest,request);r.cancelNativeAbort();await assert.rejects(current,/未确认/);
});
test('a held native abort API cannot block observation of the actual interrupted boundary',async t=>{
 let release;
 const f=await mod({version:'2.1.310',turnAbort:()=>new Promise(resolve=>release=resolve),fetchObservation:(body,r)=>({...r.observeRoot(body),abort:r.nativeAbortCommand()})});
 const turnId=randomUUID();await f.invoke('turn.start',{turnId});await f.clock.shift()();
 t.after(()=>f.r.cancelNativeAbort());const done=f.r.interrupt();
 const next=()=> (async function*(){yield {kind:'thinking'};return {stopReason:'end_turn'};})();next.origin={plugin:'engine',tier:'core'};
 const stream=f.invoke('turn.step',{turnId},next);
 await stream.next();
 // Start control while the root still runs. Its RPC result can lag behind the
 // actual native boundary, which must continue through the observation queue.
 await f.clock.shift()();
 const task=f.clock.shift()();await Promise.resolve();
 assert.equal(typeof release,'function');
 await f.invoke('turn.complete',{turnId,reason:'aborted'});await f.clock.shift()();
 assert.equal(f.r.nativeAbortRequest.nativeDone,true);assert.equal(f.r.nativeInputRequired,true);
 release();await task;await done;await stream.return();assert.equal(f.r.nativeInputRequired,false);
});

test('root activity follows the transparent native stream, while child activity and ended turns cannot replace it', async () => {
  const f = await mod({version:'2.1.309'}), turnId=randomUUID();
  await f.invoke('turn.start',{turnId});await f.clock.shift()();
  assert.equal(f.r.nativeActivity.label,'requesting');
  const chunks=[{kind:'thinking',text:'PRIVATE REASONING'},{kind:'text',text:'visible',ref:2}], result={stopReason:'end_turn'};
  const next=()=> (async function*(){yield*chunks;return result;})();next.origin={plugin:'engine',tier:'core'};
  const stream=f.invoke('turn.step',{turnId},next);assert.equal((await stream.next()).value,chunks[0]);await f.clock.shift()();assert.equal(f.r.nativeActivity.label,'thinking');
  assert.equal((await stream.next()).value,chunks[1]);await f.clock.shift()();assert.equal(f.r.nativeActivity.label,'text');
  assert.equal((await stream.next()).value,result);assert.ok(!JSON.stringify(f.requests).includes('PRIVATE REASONING'));
  await f.invoke('prompt.submit',{text:'A newly entered private instruction'});await f.clock.shift()();
  assert.equal(f.r.nativeActivity.turnId,turnId,'A private-input boundary revokes sharing without inventing a new executing turn');
  const child=f.invoke('turn.step',{turnId:'child',agentId:'child'},next);while(!(await child.next()).done){};
  assert.equal(f.r.nativeActivity.turnId,turnId);
  await f.invoke('turn.complete',{turnId,reason:'answer',answer:'',durationMs:100});await f.clock.shift()();assert.equal(f.r.nativeActivity,null);
});

test('native permission requests remain private, correlated to actual calls and do not fabricate GUI decisions', async () => {
  const f=await mod({version:'2.1.302',legacy:true}), promptId=randomUUID(),turnId=randomUUID();
  await f.invoke('classic.UserPromptSubmit',{session_id:f.r.record.nativeId,prompt_id:promptId,prompt:'check'});
  await f.invoke('turn.start',{turnId});await f.clock.shift()();
  let finishA,finishB;
  const verdict=async()=>({decision:'ask'});verdict.origin={plugin:'engine',tier:'core'};
  const make=(id,command,done)=>{const execute=async()=>{await f.invoke('tool.check',{tool:'Bash',tool_use_id:id,input:{command}},verdict);return new Promise(done);};execute.origin={plugin:'engine',tier:'core'};return f.invoke('tool.call',{tool:'Bash',tool_use_id:id,input:{command}},execute);};
  const a=make('first','first',r=>finishA=r),b=make('second','second',r=>finishB=r);await new Promise(r=>setImmediate(r));
  await f.clock.shift()();assert.equal(f.r.nativeActivity.phase,'approval');assert.equal(f.r.nativeApproval.requests.length,2);assert.equal(f.r.nativeApproval.requests[0].input,'{\n  "command": "first"\n}');
  assert.equal(f.r.rootTurn,null);assert.equal(f.r.nativeApproval.availableDecisions,undefined);
  const render=async e=>e;render.origin={plugin:'engine',tier:'core'};
  await f.invoke('ui.render',{component:'ToolProgress',props:{kind:'background_hint',tool_use_id:'foreign'}},render);
  assert.equal(f.r.nativeApproval.requests.length,2,'An unrelated native render cannot resolve a root permission');
  const injected=async e=>e;injected.origin={plugin:'third-party',tier:'plugin'};
  await f.invoke('ui.render',{component:'ToolProgress',props:{kind:'background_hint',tool_use_id:'first'}},injected);
  assert.equal(f.r.nativeApproval.requests.length,2,'A transformed render is not native execution proof');
  await f.invoke('ui.render',{component:'ToolProgress',props:{kind:'background_hint',tool_use_id:'first'}},render);await f.clock.shift()();
  assert.equal(f.r.nativeApproval.requests.length,1,'A native running pill resolves only its own exact call');
  assert.match(f.r.nativeApproval.requests[0].input,/second/);
  finishA({result:'first result'});await a;await f.clock.shift()();assert.equal(f.r.nativeApproval.requests.length,1);
  finishB({deny:'native denial'});await b;await f.clock.shift()();assert.equal(f.r.nativeApproval,null);assert.equal(f.r.nativeActivity.turnId,turnId);
  f.r.observeRootGap({sessionId:f.r.record.nativeId,lease:f.r.rootLease,epoch:f.r.observationEpoch});assert.equal(f.r.nativeActivity,null);
});

test('native question cancellation ends only its exact live turn after sharing authority is revoked',()=>{
 const r=adapter(),states=[];r.nativeBlocks=true;r.on('state',s=>states.push(s));
 const emit=(id,extra)=>r.observeBlock({block:true,sessionId:r.record.nativeId,lease:r.rootLease,epoch:r.observationEpoch,sequence:(r.rootObservation?.sequence||0)+1,kind:'control',status:'complete',id,...extra});
 emit('control:turn-start',{turnId:'a',promptId:'prompt-a',status:'running'});
 emit('control:permission',{turnId:'a',permissionId:'permission:question',title:'AskUserQuestion',input:'{}'});
 emit('control:permission',{turnId:'a',promptId:'prompt-a',boundaryOnly:true});
 r.hook({hook_event_name:'PermissionRequest',session_id:r.record.nativeId,prompt_id:'prompt-a'});
 assert.equal(r.rootTurn,null);states.length=0;
 emit('turn:a',{kind:'turn',turnId:'a',text:'',status:'complete'});
 assert.deepEqual(states,['idle']);assert.equal(r.nativeActivity,null);assert.equal(r.nativeApproval,null);assert.equal(r.rootTurn,null);
 emit('control:turn-start',{turnId:'b',status:'running'});states.length=0;
 emit('turn:a',{kind:'turn',turnId:'a',text:'',status:'complete'});
 assert.deepEqual(states,[]);assert.equal(r.nativeActivity.turnId,'b');
 emit('control:permission',{turnId:'b',permissionId:'permission:other',title:'AskUserQuestion',input:'{}'});
 emit('control:input',{});states.length=0;
 emit('turn:b',{kind:'turn',turnId:'b',text:'',status:'complete'});
 assert.deepEqual(states,[],'A later private input invalidates the old question completion');
});

for(const status of ['failed','interrupted'])test('native question abnormal end preserves its terminal state: '+status,()=>{
 const r=adapter(),states=[];r.nativeBlocks=true;r.on('state',s=>states.push(s));
 const emit=(id,extra)=>r.observeBlock({block:true,sessionId:r.record.nativeId,lease:r.rootLease,epoch:r.observationEpoch,sequence:(r.rootObservation?.sequence||0)+1,kind:'control',status:'complete',id,...extra});
 emit('control:turn-start',{turnId:'a',status:'running'});
 emit('control:permission',{turnId:'a',permissionId:'permission:question',title:'AskUserQuestion',input:'{}'});
 states.length=0;emit('turn:a',{kind:'turn',turnId:'a',text:'',status});
 assert.deepEqual(states,[status==='failed'?'error':'idle']);
 assert.equal(Boolean(r.nativeInputRequired),status==='interrupted');assert.equal(r.rootTurn,null);
});

for(const boundary of ['UserPromptSubmit','PermissionRequest','Notification','StopFailure'])test('late question completion cannot override the independent classic boundary: '+boundary,()=>{
 const r=adapter(),states=[];r.nativeBlocks=true;r.on('state',s=>states.push(s));
 const emit=(id,extra)=>r.observeBlock({block:true,sessionId:r.record.nativeId,lease:r.rootLease,epoch:r.observationEpoch,sequence:(r.rootObservation?.sequence||0)+1,kind:'control',status:'complete',id,...extra});
 emit('control:turn-start',{turnId:'a',promptId:'prompt-a',status:'running'});
 emit('control:permission',{turnId:'a',permissionId:'permission:question',title:'AskUserQuestion',input:'{}'});
 r.hook({hook_event_name:boundary,session_id:r.record.nativeId,prompt_id:'prompt-b',prompt:'new input',notification_type:'auth'});
 emit('control:permission',{turnId:'a',permissionId:'permission:old-question',title:'AskUserQuestion',input:'{}'});
 states.length=0;emit('turn:a',{kind:'turn',turnId:'a',text:'',status:'complete'});
 assert.deepEqual(states,[],'An older question frame cannot rearm completion after a newer classic boundary');
});

test('old permission identity cannot replace a new root and expired observer proof cannot look live',()=>{
 const r=adapter();r.nativeBlocks=true;const emit=(id,extra)=>r.observeBlock({block:true,sessionId:r.record.nativeId,lease:r.rootLease,epoch:r.observationEpoch,sequence:(r.rootObservation?.sequence||0)+1,kind:'control',status:'complete',id,...extra});
 emit('control:turn-start',{turnId:'a',status:'running'});emit('control:turn-start',{turnId:'b',status:'running'});
 emit('control:permission',{turnId:'a',permissionId:'permission:old',title:'Bash',input:'old'});
 assert.equal(r.nativeApproval,null);assert.equal(r.nativeActivity.turnId,'b');assert.equal(r.rootTurn.id,'b');
 r.observationSeenAt=Date.now()-6000;assert.ok(Date.now()-r.nativeActivity.observedAt>5000);
 emit('control:heartbeat',{});assert.equal(r.nativeActivity.turnId,'b');
});

for (const version of ['2.1.308', '2.1.309', '2.1.310', '2.1.311', '2.1.312', '2.1.313']) test('native queue/display compatibility remains version scoped: ' + version, async () => {
  const f = await mod({ version });
  assert.equal(f.r.nativeQueue === true, version !== '2.1.313');
  assert.equal(f.r.nativeBlocks === true, version !== '2.1.313');
  assert.equal(f.r.nativeAbortAvailable === true, ['2.1.310', '2.1.311', '2.1.312'].includes(version));
  assert.equal(f.r.nativeCapacityAvailable === true, ['2.1.310', '2.1.311', '2.1.312'].includes(version));
});
test('native 2.1.316 can abort its turn but does not yet arm capacity recovery (T-133)', async () => {
  const f = await mod({ version: '2.1.316' });
  assert.equal(f.r.nativeAbortAvailable, true); assert.notEqual(f.r.nativeCapacityAvailable, true);
});
test('a mod that predates nativeCapacity keeps capacity recovery with abort, as before', () => {
  for (const [fields, capacity] of [[{ nativeAbort: true }, true], [{ nativeAbort: true, nativeCapacity: false }, false], [{ nativeAbort: false }, false]]) {
    const r = Object.create(Claude.prototype); EventEmitter.call(r);
    r.record = { nativeId: randomUUID() }; r.terminal = { alive: true }; r.submission = new SubmissionChannel();
    r.bindRoot({ sessionId: r.record.nativeId, ...fields });
    assert.equal(r.nativeCapacityAvailable, capacity, JSON.stringify(fields));
  }
});
test('native 2.1.316 binds the root so a main-turn workspace message reaches the service', async () => {
  // Root binding and native blocks give the turn identity a wake needs; the
  // other per-version controls stay off until they are qualified separately.
  const tool = 'mcp__native_workspace__workspace_message', staged = [];
  const f = await mod({ version: '2.1.316', toolReader: async () => [{ name: tool }], requestHandler: async (url, options, body, r) => {
    if (url.endsWith('/addressed-capability')) { r.addressedSendAvailable = body.available && r.nativeBlocks === true && !r.retainedReader; return { ok: true, text: '{}' }; }
    if (url.endsWith('/addressed-message')) { staged.push(body); return { ok: true, text: JSON.stringify({ status: 'staged' }) }; }
  } });
  assert.equal(f.r.nativeBlocks, true);
  for (const flag of ['nativeQueue', 'nativeCapacityAvailable', 'nativeInlineInput', 'nativePromptInput', 'nativeMedia']) assert.notEqual(f.r[flag], true, flag);
  for (const fn of f.clock.splice(0).filter(fn => fn.delay === 500)) await fn();
  assert.equal(f.r.addressedSendAvailable, true);
  const promptId = randomUUID();
  await f.invoke('classic.UserPromptSubmit', { session_id: f.r.record.nativeId, prompt_id: promptId, prompt: 'Wake the idle peer.' });
  await f.invoke('turn.start', { turnId: 'turn-316' });
  const args = { recipient_id: 'peer-session', message: 'Continue from the task board.' };
  const execute = async () => ({ text: JSON.stringify({ approved: true, ...args }) }); execute.origin = { plugin: 'engine' };
  const result = await f.invoke('tool.call', { tool, tool_use_id: 'call-316', ...args }, execute);
  assert.equal(result.deny, undefined);
  assert.equal(staged.length, 1);
  assert.deepEqual({ turnId: staged[0].turnId, promptId: staged[0].promptId, callId: staged[0].callId, arguments: staged[0].arguments }, { turnId: 'turn-316', promptId, callId: 'call-316', arguments: args });
});
test('native 2.1.316: a turn without its own prompt, such as a `!` command, cannot stage a workspace message', async () => {
  // T-100 (integration review I139): a `!` turn raises no UserPromptSubmit, so
  // it still sees the last typed prompt; that prompt already started its turn.
  const tool = 'mcp__native_workspace__workspace_message', staged = [], refused = '没有本原生主会话的定向协作授权。';
  const f = await mod({ version: '2.1.316', toolReader: async () => [{ name: tool }], requestHandler: async (url, options, body, r) => {
    if (url.endsWith('/addressed-capability')) { r.addressedSendAvailable = body.available && r.nativeBlocks === true && !r.retainedReader; return { ok: true, text: '{}' }; }
    if (url.endsWith('/addressed-message')) { staged.push(body); return { ok: true, text: JSON.stringify({ status: 'staged' }) }; }
    if (url.endsWith('/addressed-failed')) return { ok: true, text: '{}' };
  } });
  for (const fn of f.clock.splice(0).filter(fn => fn.delay === 500)) await fn();
  const args = { recipient_id: 'peer-session', message: 'Continue from the task board.' };
  const execute = async () => ({ text: JSON.stringify({ approved: true, ...args }) }); execute.origin = { plugin: 'engine' };
  const typed = randomUUID();
  await f.invoke('classic.UserPromptSubmit', { session_id: f.r.record.nativeId, prompt_id: typed, prompt: 'Look at the board.' });
  await f.invoke('turn.start', { turnId: 'typed-turn' }); await f.invoke('turn.complete', { turnId: 'typed-turn' });
  await f.invoke('turn.start', { turnId: 'shell-turn' });
  assert.deepEqual(await f.invoke('tool.call', { tool, tool_use_id: 'call-shell', ...args }, execute), { deny: refused });
  await f.invoke('turn.complete', { turnId: 'shell-turn' });
  assert.equal(staged.length, 0);
  const next = randomUUID();
  await f.invoke('classic.UserPromptSubmit', { session_id: f.r.record.nativeId, prompt_id: next, prompt: 'Wake the idle peer.' });
  await f.invoke('turn.start', { turnId: 'typed-turn-2' });
  assert.equal((await f.invoke('tool.call', { tool, tool_use_id: 'call-typed', ...args }, execute)).deny, undefined);
  assert.deepEqual(staged.map(x => [x.turnId, x.promptId]), [['typed-turn-2', next]]);
});
function addressedMod(version, extra = {}) {
  const tool = 'mcp__native_workspace__workspace_message', staged = [];
  return mod({ version, toolReader: async () => [{ name: tool }], ...extra, requestHandler: async (url, options, body, r) => {
    if (url.endsWith('/addressed-capability')) { r.addressedSendAvailable = body.available && r.nativeBlocks === true && !r.retainedReader; return { ok: true, text: '{}' }; }
    if (url.endsWith('/addressed-message')) { staged.push(body); return { ok: true, text: JSON.stringify({ status: 'staged' }) }; }
    if (url.endsWith('/addressed-failed')) return { ok: true, text: '{}' };
    return extra.requestHandler?.(url, options, body, r);
  } }).then(async f => { for (const fn of f.clock.splice(0).filter(fn => fn.delay === 500)) await fn(); return Object.assign(f, { tool, staged }); });
}
const wakeCall = async (f, id) => {
  const args = { recipient_id: 'peer-session', message: 'Continue from the task board.' };
  const execute = async () => ({ text: JSON.stringify({ approved: true, ...args }) }); execute.origin = { plugin: 'engine' };
  return f.invoke('tool.call', { tool: f.tool, tool_use_id: id, ...args }, execute);
};
test('native 2.1.316: a prompt a settings hook stopped never authorizes a later turn without its own prompt', async () => {
  // T-100 (integration review I140): only a prompt that goes on may become the
  // turn's prompt; otherwise a following `!` turn would be its only, unambiguous turn.
  for (const verdict of [{ block: 'blocked by a settings hook' }, { preventContinuation: true, stopReason: 'stop' }]) for (const earlier of [true, false]) {
    const f = await addressedMod('2.1.316'), label = JSON.stringify({ verdict, earlier });
    if (earlier) {
      await f.invoke('classic.UserPromptSubmit', { session_id: f.r.record.nativeId, prompt_id: randomUUID(), prompt: 'Look at the board.' });
      await f.invoke('turn.start', { turnId: 'typed-turn' }); await f.invoke('turn.complete', { turnId: 'typed-turn' });
    }
    await f.invoke('classic.UserPromptSubmit', { session_id: f.r.record.nativeId, prompt_id: randomUUID(), prompt: 'blocked text' }, async () => verdict);
    await f.invoke('turn.start', { turnId: 'shell-turn' });
    assert.deepEqual(await wakeCall(f, 'call-shell'), { deny: '没有本原生主会话的定向协作授权。' }, label);
    assert.equal(f.staged.length, 0, label);
  }
});
for (const version of ['2.1.316', '2.1.312']) test(`native ${version}: a prompt delivered into a running turn never heads a later turn without its own prompt`, async () => {
  // T-100 (integration review I141 L1): a mid-turn prompt goes on but starts no turn of its own.
  const f = await addressedMod(version), first = randomUUID(), midTurn = randomUUID(), later = randomUUID();
  await f.invoke('classic.UserPromptSubmit', { session_id: f.r.record.nativeId, prompt_id: first, prompt: 'Look at the board.' });
  await f.invoke('turn.start', { turnId: 'typed-turn' });
  await f.invoke('classic.UserPromptSubmit', { session_id: f.r.record.nativeId, prompt_id: midTurn, prompt: 'And also this.' });
  await f.invoke('turn.complete', { turnId: 'typed-turn' });
  await f.invoke('turn.start', { turnId: 'shell-turn' });
  assert.deepEqual(await wakeCall(f, 'call-shell'), { deny: '没有本原生主会话的定向协作授权。' });
  await f.invoke('turn.complete', { turnId: 'shell-turn' });
  assert.equal(f.staged.length, 0);
  await f.invoke('classic.UserPromptSubmit', { session_id: f.r.record.nativeId, prompt_id: later, prompt: 'Wake the idle peer.' });
  await f.invoke('turn.start', { turnId: 'typed-turn-2' });
  assert.equal((await wakeCall(f, 'call-typed')).deny, undefined);
  assert.deepEqual(f.staged.map(x => [x.turnId, x.promptId]), [['typed-turn-2', later]]);
});
test('native 2.1.312 (the main session\'s binary): a typed turn and a turn NAW submitted each stage a workspace message', async () => {
  const typed = await addressedMod('2.1.312'), promptId = randomUUID();
  await typed.invoke('classic.UserPromptSubmit', { session_id: typed.r.record.nativeId, prompt_id: promptId, prompt: 'Wake the idle peer.' });
  await typed.invoke('turn.start', { turnId: 'typed-312' });
  assert.equal((await wakeCall(typed, 'call-typed-312')).deny, undefined);
  assert.deepEqual(typed.staged.map(x => [x.turnId, x.promptId]), [['typed-312', promptId]]);
  // A woken receiver's turn is sent by NAW itself through $.prompt.submit.
  let f, offered = false, inside; const submitted = randomUUID(), text = '[Workspace message from Sender] continue.';
  f = await addressedMod('2.1.312', {
    promptSubmit: async () => {
      await f.invoke('classic.UserPromptSubmit', { session_id: f.r.record.nativeId, prompt_id: submitted, prompt: text });
      await f.invoke('turn.start', { turnId: 'woken-312' });
      inside = await wakeCall(f, 'call-woken-312');
      return { text, origin: { kind: 'plugin', name: 'native-workspace-submit' } };
    },
    requestHandler: async url => {
      if (url.endsWith('/next') && offered) { offered = false; return { ok: true, text: JSON.stringify({ id: 'tag-312', text }) }; }
      if (url.endsWith('/authorize')) return { ok: true, text: '{"allowed":true}' };
      if (url.endsWith('/result')) return { ok: true, text: '{}' };
    } });
  offered = true; await f.poll();
  assert.equal(inside?.deny, undefined);
  assert.deepEqual(f.staged.map(x => [x.turnId, x.promptId]), [['woken-312', submitted]]);
});
test('native 2.1.317 binds and stages like 2.1.316: blocks, transitions, abort, turn records and narration, no capacity (T-133)', async () => {
  const f = await addressedMod('2.1.317'), promptId = randomUUID();
  assert.equal(f.r.nativeBlocks, true); assert.equal(f.r.nativeAbortAvailable, true); assert.notEqual(f.r.nativeCapacityAvailable, true);
  assert.equal(f.r.nativeTurnRecords, true); assert.equal(f.r.nativeNarration, true);
  for (const flag of ['nativeQueue', 'nativeInlineInput', 'nativePromptInput', 'nativeMedia']) assert.notEqual(f.r[flag], true, flag);
  await f.invoke('classic.UserPromptSubmit', { session_id: f.r.record.nativeId, prompt_id: promptId, prompt: 'Wake the idle peer.' });
  await f.invoke('turn.start', { turnId: 'turn-317' });
  assert.equal((await wakeCall(f, 'call-317')).deny, undefined);
  assert.deepEqual(f.staged.map(x => [x.turnId, x.promptId]), [['turn-317', promptId]]);
});
test('a compat copy defers workspace_message to the mod NAW launched and still refuses in a retained process', async () => {
  // T-100: the daily shared folder kept a compat copy; Claude loads it beside
  // NAW's own --plugin-dir mod, and its refusal blocked every wake there.
  const tool = 'mcp__native_workspace__workspace_message', args = { recipient_id: 'peer-session', message: 'Continue from the task board.' };
  const source = fs.readFileSync(path.join(__dirname, '../claude-bridge/hooks/register.js'), 'utf8').replace('const legacyOnly = false;', 'const legacyOnly = true;');
  for (const launched of [true, false]) {
    const { register } = await import('data:text/javascript;base64,' + Buffer.from(source + '\n//' + randomUUID()).toString('base64'));
    const calls = [];
    register((name, matcher, handler) => { if (name === 'tool.call' && handler && matcher?.tool === tool) calls.push(handler); return { catch() {} }; });
    const $ = { env: { get: async key => key === 'NAW_SUBMIT_SOCKET' && launched ? '/fixture/socket' : undefined } };
    const next = async () => ({ text: 'launcher mod result' }); next.origin = { plugin: 'engine' };
    assert.equal(calls.length, 1);
    assert.deepEqual(await calls[0]($, { tool, tool_use_id: 'call', ...args }, next), launched ? { text: 'launcher mod result' } : { deny: '没有本原生主会话的定向协作授权。' });
  }
});
test('NAW\'s own mod and a compat copy in the folder stage one workspace message in either hook order', async () => {
  // As in this file's other chains, next.origin names who made the call (the
  // engine for a model tool use), whichever mod runs first. The real 2.1.316
  // run (T-100 evidence) covers the order the engine actually uses.
  const tool = 'mcp__native_workspace__workspace_message', staged = [], args = { recipient_id: 'peer-session', message: 'Continue from the task board.' };
  const f = await mod({ version: '2.1.316', toolReader: async () => [{ name: tool }], requestHandler: async (url, options, body, r) => {
    if (url.endsWith('/addressed-capability')) { r.addressedSendAvailable = body.available && r.nativeBlocks === true && !r.retainedReader; return { ok: true, text: '{}' }; }
    if (url.endsWith('/addressed-message')) { staged.push(body); return { ok: true, text: JSON.stringify({ status: 'staged' }) }; }
  } });
  for (const fn of f.clock.splice(0).filter(fn => fn.delay === 500)) await fn();
  const source = fs.readFileSync(path.join(__dirname, '../claude-bridge/hooks/register.js'), 'utf8').replace('const legacyOnly = false;', 'const legacyOnly = true;');
  const { register } = await import('data:text/javascript;base64,' + Buffer.from(source + '\n//' + randomUUID()).toString('base64'));
  let compat; register((name, matcher, handler) => { if (name === 'tool.call' && handler && matcher?.tool === tool) compat = handler; return { catch() {} }; });
  const launched = { env: { get: async key => key === 'NAW_SUBMIT_SOCKET' ? '/fixture/socket' : undefined } };
  for (const order of ['compat first', 'NAW mod first']) {
    const promptId = randomUUID(), turnId = 'turn ' + order, e = { tool, tool_use_id: 'call ' + order, ...args };
    await f.invoke('classic.UserPromptSubmit', { session_id: f.r.record.nativeId, prompt_id: promptId, prompt: 'Wake the idle peer.' });
    await f.invoke('turn.start', { turnId });
    const execute = async () => ({ text: JSON.stringify({ approved: true, ...args }) }); execute.origin = { plugin: 'engine' };
    let result;
    if (order === 'compat first') { const inner = v => f.invoke('tool.call', v, execute); inner.origin = execute.origin; result = await compat(launched, e, inner); }
    else { const inner = v => compat(launched, v, execute); inner.origin = execute.origin; result = await f.invoke('tool.call', e, inner); }
    assert.equal(result.deny, undefined, order); assert.equal(JSON.parse(result.result).status, 'staged', order);
    assert.deepEqual(staged.at(-1) && [staged.length, staged.at(-1).turnId, staged.at(-1).promptId], [order === 'compat first' ? 1 : 2, turnId, promptId]);
    await f.invoke('turn.complete', { turnId });
  }
});
test('the retained compatibility hook keeps unverified 2.1.311/312 blocks off', async () => {
  for (const version of ['2.1.311', '2.1.312']) {
    const f = await mod({ version, legacy: true });
    assert.notEqual(f.r.nativeBlocks, true);
    assert.notEqual(f.r.nativeQueue, true);
    assert.notEqual(f.r.nativeAbortAvailable, true);
  }
  assert.equal((await mod({ version: '2.1.310', legacy: true })).r.nativeBlocks, true);
});

test('real retained append hook reconciles receipt through reader without a classic prompt ID or sharing grant', async t => {
  const { LegacyClaude } = require('../legacy-claude.cjs'), { LegacyInput } = require('../legacy-input.cjs');
  const { processIdentity } = require('../platform.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retained-receipt-'));
  const record = { id: 'retained', provider: 'claude', nativeId: randomUUID(), pid: process.pid,
    processIdentity: processIdentity(process.pid), state: 'idle', messages: [] };
  const reader = new LegacyClaude(record, dir, async () => record), bridge = new LegacyInput(dir);
  bridge.targets.set(record.id, reader); bridge.readers.set(record.id, reader);
  reader.on('readerBlock', message => bridge.observeReader(reader, message));
  t.after(() => { bridge.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const tag = randomUUID(), storedMessageId = randomUUID(), text = 'accepted native instruction';
  bridge.records.push({ id: tag, sessionId: record.id, nativeId: record.nativeId, shared: true, sharedReply: true, inputMode: 'queue', text, status: 'unconfirmed' });
  let offered = false, finish;
  const f = await mod({ runtime: reader, legacy: true, version: '2.1.302',
    promptSubmit: () => new Promise(resolve => { finish = resolve; }),
    requestHandler: async url => {
      if (url.endsWith('/next') && offered) { offered = false; return { ok: true, text: JSON.stringify({ id: tag, text }) }; }
      if (url.endsWith('/authorize')) return { ok: true, text: '{"allowed":true}' };
      if (url.endsWith('/result')) return { ok: true, text: '{}' };
    } });
  offered = true; const listening = f.poll(); await new Promise(resolve => setImmediate(resolve));
  await f.invoke('classic.UserPromptSubmit', { session_id: record.nativeId, prompt_id: randomUUID(), prompt: text });
  await f.append({ uuid: storedMessageId, door: 'prompt', origin: { kind: 'plugin', name: 'native-workspace-compat', asUser: true },
    message: { type: 'user', role: 'user', content: [{ type: 'text', text }] } });
  await f.clock.shift()();
  const input = reader.record.messages.find(m => m.kind === 'input');
  assert.equal(input.id, `native:${record.nativeId}:prompt:${storedMessageId}`);
  assert.equal(input.promptId, undefined); assert.equal(input.inputTag, tag);
  assert.equal(bridge.sharedMessages()[0].status, 'submitted');
  assert.equal(bridge.sharedMessages()[0].manualReply, true);
  assert.equal(bridge.sharedReplies.grants.size, 0);
  assert.equal(JSON.parse(fs.readFileSync(bridge.filename))[0].status, 'accepted');
  finish({ text, origin: { kind: 'plugin', name: 'native-workspace-compat' } }); await listening;
});

test('retained observer restores ordered offline output during held submit without replaying command or migrating receipt', async () => {
  const tag = randomUUID(), promptId = randomUUID(), turnId = randomUUID(), nativeMessage = randomUUID();
  let credential = 'a'.repeat(64), online = true, offered = false, finishSubmit, submits = 0, polls = 0, binds = 0;
  const receipts = [], events = [];
  const f = await mod({ version: '2.1.302', legacy: true,
    promptSubmit: () => { submits++; return new Promise(resolve => { finishSubmit = resolve; }); },
    requestHandler: async (url, options, body) => {
      const token = options.headers['X-Workspace-Token'];
      if (url.endsWith('/result')) receipts.push({ token, body });
      if (!online) throw Error('Local GUI unavailable');
      if (token !== credential) return { ok: false, status: 403 };
      if (url.endsWith('/root-bind')) binds++;
      if (url.endsWith('/next')) { polls++; if (offered) { offered = false; return { ok: true, text: JSON.stringify({ id: tag, text: 'queued instruction' }) }; } }
      if (url.endsWith('/authorize')) return { ok: true, text: '{"allowed":true}' };
    } });
  const session = { nativeId: f.r.record.nativeId, messages: [] };
  f.r.on('nativeBlock', row => { events.push(row); require('../native-blocks.cjs').applyNativeBlock(session, row); });
  offered = true; const listening = f.poll(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(submits, 1); assert.equal(polls, 2);
  online = false;
  await f.invoke('classic.UserPromptSubmit', { session_id: session.nativeId, prompt_id: promptId, prompt: 'queued instruction' });
  await f.append({ uuid: nativeMessage, door: 'prompt', origin: { kind: 'plugin', name: 'native-workspace-compat', asUser: true },
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'queued instruction' }] } });
  await f.invoke('turn.start', { turnId });
  const display = { session_id: session.nativeId, turn_id: randomUUID(), prompt_id: promptId, message_id: randomUUID(), index: 0, delta: 'visible ', final: false };
  await f.invoke('classic.MessageDisplay', display, async () => ({}));
  await f.clock.shift()(); assert.equal(events.length, 0); assert.deepEqual(f.clock.map(fn => fn.delay), [1000]);
  await f.invoke('classic.MessageDisplay', { ...display, index: 1, delta: 'complete', final: true }, async () => ({}));
  await f.invoke('turn.complete', { turnId, reason: 'answer', answer: 'visible complete' });
  await f.clock.shift()(); assert.equal(events.length, 0); assert.equal(f.clock.length, 1);
  credential = 'b'.repeat(64); f.setToken(credential); online = true;
  // GUI owns the observer/receipt channel, not the still-running native submit.
  f.r.rootLease = null; f.r.observationEpoch = null; f.r.rootObservation = null;
  await f.clock.shift()();
  assert.equal(binds, 2); assert.equal(polls, 2); assert.equal(submits, 1); assert.equal(receipts.length, 0);
  assert.deepEqual(events.map(row => row.kind), ['input', 'response', 'response', 'turn']);
  assert.equal(events[0].inputTag, tag); assert.equal(events[1].turnId, turnId);
  assert.deepEqual(f.requests.map(row => row.sequence), [1, 2, 3, 4, 5]);
  assert.ok(f.requests.every(row => row.replayed));
  assert.equal(f.r.rootTurn, null, 'Offline history never authorizes a live idle state');
  assert.equal(session.messages.filter(row => row.role === 'user').length, 1);
  assert.equal(session.messages.find(row => row.role === 'assistant').text, 'visible complete');
  assert.equal(f.clock.length, 0, 'No standing observer poll after queue drains');
  finishSubmit({ text: 'queued instruction', origin: { kind: 'plugin', name: 'native-workspace-compat' } }); await listening;
  assert.equal(receipts.length, 1); assert.equal(receipts[0].token, 'a'.repeat(64));
  assert.equal(receipts[0].body.promptId, promptId); assert.equal(submits, 1); assert.equal(polls, 2);
});

test('retained refusal with unchanged credential keeps exactly one retry timer; invalid rows disclose a gap', async () => {
  let status = 403, calls = 0;
  const f = await mod({ version: '2.1.302', legacy: true, requestHandler: async url => {
    if (url.endsWith('/observation')) { calls++; return { ok: false, status }; }
  } });
  const display = { session_id: f.r.record.nativeId, turn_id: randomUUID(), message_id: randomUUID(), index: 0, delta: 'native tail', final: true };
  await f.invoke('classic.MessageDisplay', display, async () => ({}));
  for (let i = 0; i < 3; i++) { await f.clock.shift()(); assert.equal(calls, i + 1); assert.equal(f.clock.length, 1); assert.equal(f.clock[0].delay, 1000); }
  status = 409; await f.clock.shift()(); assert.equal(f.clock.length, 0);
  const gaps = []; f.r.on('nativeBlock', row => gaps.push(row)); await f.poll();
  assert.equal(gaps.length, 1); assert.equal(gaps[0].kind, 'gap');
});

test('retained offline queue cannot cross a root end or unannounced native identity change', async () => {
  for (const end of [false, true]) {
    let online = false, binds = 0;
    const f = await mod({ version: '2.1.302', legacy: true, requestHandler: async url => {
      if (url.endsWith('/root-bind')) binds++;
      if (url.endsWith('/observation') && !online) throw Error('Offline');
    } });
    await f.invoke('classic.MessageDisplay', { session_id: f.r.record.nativeId, turn_id: randomUUID(), message_id: randomUUID(), index: 0, delta: 'old private', final: true }, async () => ({}));
    await f.clock.shift()();
    if (end) await f.invoke('session.end', { sessionId: f.r.record.nativeId, reason: 'other' });
    f.setNativeId(randomUUID()); f.setToken('b'.repeat(64)); online = true;
    await f.clock.shift()(); assert.equal(f.requests.length, 0); assert.equal(binds, 1);
    if (!end) assert.equal(f.clock.length, 0, 'Retired identity must not keep a retry timer');
  }
});

test('retained metadata timeout reuses one request and releases the queued frame when that request settles', async () => {
  let held = false, release, bindings = 0;
  const f = await mod({ version: '2.1.302', legacy: true, requestHandler: async (url, options, body, r) => {
    if (url.endsWith('/observation') && held && options.headers['X-Workspace-Token'] === 'a'.repeat(64)) return { ok: false, status: 403 };
    if (url.endsWith('/root-bind')) { bindings++; if (held) return new Promise(resolve => { release = () => resolve({ ok: true, text: JSON.stringify(r.bindRoot(body)) }); }); }
  } });
  held = true; f.setToken('b'.repeat(64));
  await f.invoke('classic.MessageDisplay', { session_id: f.r.record.nativeId, turn_id: randomUUID(), message_id: randomUUID(), index: 0, delta: 'after reconnect', final: true }, async () => ({}));
  await f.clock.shift()();
  for (let i = 0; i < 3; i++) {
    const flushing = f.clock.shift()(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(bindings, 2); assert.equal(f.clock.length, 1); assert.equal(f.clock[0].delay, 1500);
    f.clock.shift()(); await flushing;
    assert.deepEqual(f.clock.map(fn => fn.delay), [1000]);
  }
  release(); await new Promise(resolve => setImmediate(resolve)); await f.clock.shift()();
  assert.equal(bindings, 2); assert.equal(f.requests.length, 1); assert.equal(f.requests[0].delta, 'after reconnect');
  assert.equal(f.clock.length, 0);
});

test('retained 302 observes only accepted root prompt and downstream display content without sending', async () => {
  const f = await mod({ version: '2.1.302', legacy: true }), rows = [], prompt = randomUUID(), turn = randomUUID();
  f.r.on('nativeBlock', row => rows.push(row));
  const input = { uuid: randomUUID(), door: 'prompt', origin: { kind: 'human' }, message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'original' }] } };
  await f.append(input, async e => ({ uuid: e.uuid, message: { ...e.message, content: [{ type: 'text', text: 'accepted text' }] } }));
  await f.append({ ...input, agentId: 'child' });
  await f.append({ ...input, uuid: randomUUID() }, async () => ({ deny: 'not accepted' }));
  await f.invoke('classic.UserPromptSubmit', { session_id: f.r.record.nativeId, prompt_id: prompt });
  await f.invoke('turn.start', { turnId: turn });
  const display = { session_id: f.r.record.nativeId, turn_id: randomUUID(), prompt_id: prompt, message_id: randomUUID(), index: 0, delta: 'raw private text', final: true };
  await f.invoke('classic.MessageDisplay', display, async () => ({ displayContent: 'visible transformed text' }));
  await f.invoke('classic.MessageDisplay', { ...display, agent_id: 'child', message_id: randomUUID() }, async () => ({}));
  while (f.clock.length) await f.clock.shift()();
  assert.equal(rows.length, 2); assert.equal(rows[0].kind, 'input'); assert.equal(rows[0].text, 'accepted text');
  assert.equal(rows[1].delta, 'visible transformed text'); assert.equal(rows[1].turnId, turn);
  assert.equal(JSON.stringify(rows).includes('raw private text'), false);
  assert.ok(f.requests.every(row => row.lease === f.r.rootLease && row.epoch === f.r.observationEpoch));
});

test('verified display contract carries indexed batches, empty final and interruption without waiting for HTTP', async () => {
  const f = await mod({ version: '2.1.307' }), rows = [], turn = randomUUID(), id = randomUUID();
  f.r.on('nativeBlock', row => rows.push(row));
  const promptId = randomUUID(); await f.invoke('classic.UserPromptSubmit', { session_id: f.r.record.nativeId, prompt_id: promptId });
  await f.invoke('turn.start', { turnId: turn });
  const e = { session_id: f.r.record.nativeId, turn_id: randomUUID(), prompt_id: promptId, message_id: id, index: 0, final: false, delta: 'stream\n' };
  await f.invoke('classic.MessageDisplay', e, async () => ({}));
  await f.invoke('classic.MessageDisplay', { ...e, index: 1, final: true, delta: '' }, async () => ({}));
  await f.invoke('turn.complete', { turnId: turn, reason: 'aborted', durationMs: 1200 });
  assert.equal(rows.length, 0); await f.clock.shift()();
  assert.deepEqual(rows.map(x => x.status), ['streaming', 'complete', 'interrupted']);
  assert.deepEqual(rows.slice(0, 2).map(x => x.index), [0, 1]); assert.equal(rows[1].delta, '');
  assert.ok(rows.every(row => row.turnId === turn));
});
test('display mapping excludes child text, respects downstream redaction, and never duplicates response append', async () => {
  const f = await mod({ version: '2.1.307' }), rows = []; f.r.on('nativeBlock', row => rows.push(row));
  const e = { session_id: f.r.record.nativeId, turn_id: randomUUID(), message_id: randomUUID(), index: 0, final: true, delta: 'PRIVATE ORIGINAL' };
  await f.invoke('classic.MessageDisplay', { ...e, agent_id: 'child' }, async () => ({}));
  await f.invoke('classic.MessageDisplay', e, async () => ({ displayContent: 'REDACTED' }));
  await f.append(response('PRIVATE ORIGINAL'));
  await f.clock.shift()(); assert.equal(rows.length, 1); assert.equal(rows[0].delta, 'REDACTED');
});
test('tool identity retains its original turn when append or background result crosses a later turn', async () => {
  const f = await mod({ version: '2.1.307' }), rows = [], a = randomUUID(), b = randomUUID();
  f.r.on('nativeBlock', row => rows.push(row));
  await f.invoke('turn.start', { turnId: a });
  const e = response(); e.message.content = [{ type: 'tool_use', id: 'toolu_background', name: 'Bash', input: { command: 'printf test' } }];
  let release; const appending = f.append(e, () => new Promise(resolve => { release = resolve; }));
  await f.invoke('turn.start', { turnId: b }); release({ uuid: e.uuid, message: e.message }); await appending;
  const result = response(); result.door = 'tool-result'; result.origin = { kind: 'tool', tool: 'Bash' };
  result.message = { type: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_background', content: 'background result' }] };
  await f.append(result); await f.clock.shift()();
  assert.equal(rows[0].turnId, a); assert.equal(rows[1].turnId, undefined); assert.equal(rows[0].id, rows[1].id);
  const session = { nativeId: f.r.record.nativeId, messages: [] };
  for (const row of rows) require('../native-blocks.cjs').applyNativeBlock(session, row);
  assert.equal(session.messages[0].turnId, a); assert.equal(session.messages[0].text, 'background result');
});

test('observe only the stored native response, after append, without delaying or rewriting it', async () => {
  const f = await mod(), e = response(), saved = { uuid: e.uuid, message: { ...e.message, content: [{ type: 'text', text: 'Stored downstream text' }] } };
  const value = await f.append(e, async () => saved);
  assert.equal(value, saved); assert.equal(f.requests.length, 0);
  await f.clock.shift()(); assert.equal(f.requests.length, 1); assert.equal(f.requests[0].text, 'Stored downstream text');
  assert.equal(f.requests[0].sessionId, f.r.record.nativeId); assert.equal(f.requests[0].lease, f.r.rootLease);
});
test('private hidden attachments, prompts, children, denied/changed rows and thinking are excluded', async () => {
  const f = await mod();
  for (const extra of [{ agentId: 'child' }, { door: 'attachment' }, { door: 'hook-context' }, { door: 'prompt' }, { origin: { kind: 'plugin' } }, { message: { type: 'assistant', isMeta: true, content: [{ type: 'text', text: 'private' }] } }]) await f.append(response('private', extra));
  await f.append(response(), async () => ({ deny: 'Denied' }));
  await f.append(response(), async e => ({ uuid: randomUUID(), message: e.message }));
  const e = response(); e.message.content = [{ type: 'thinking', thinking: 'never copy' }, { type: 'image', source: { data: 'never copy' } }]; await f.append(e);
  assert.equal(f.clock.length, 0); assert.equal(f.requests.length, 0);
});
test('tool result text keeps block order, excludes media bytes and marks nontext output', async () => {
  const f = await mod(), e = response();
  e.door = 'tool-result'; e.origin = { kind: 'tool', tool: 'Read' }; e.message = { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool', content: [{ type: 'text', text: 'first' }, { type: 'image', source: { data: 'secret-media' } }, { type: 'text', text: 'second' }] }] };
  await f.append(e); await f.clock.shift()(); const row = f.requests[0];
  assert.equal(row.text, 'first\nsecond'); assert.equal(row.nonText, true); assert.equal(row.kind, 'tool-output'); assert.equal(row.id, e.uuid + ':0'); assert.ok(!JSON.stringify(row).includes('secret-media'));
});
test('observation queue and text are bounded with explicit gaps and truncation', async () => {
  const f = await mod();
  for (let i = 0; i < 80; i++) await f.append(response('X'.repeat(15000) + i));
  assert.equal(f.requests.length, 0); assert.equal(f.clock.length, 1); await f.clock.shift()();
  assert.ok(f.requests.length <= 64); assert.ok(f.requests.reduce((n, r) => n + r.text.length, 0) <= 256000);
  assert.equal(f.requests[0].gap, true); assert.ok(f.requests.every(r => r.truncated && r.text.length === 12000));
});
test('failed observation does not retry a task and the next received row declares a gap', async () => {
  let calls = 0; const f = await mod({ fetchObservation: body => { if (++calls === 1) throw Error('Offline'); return { observed: true }; } });
  await f.append(response('first')); await f.append(response('second')); await f.clock.shift()();
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1].gap, true);
});
test('a failed final observation reports its gap through the next normal poll without another append', async () => {
  const f = await mod({ fetchObservation: () => { throw Error('Offline'); } }), gaps = [];
  f.r.on('progress', item => gaps.push(item)); await f.append(response()); await f.clock.shift()();
  assert.equal(gaps.length, 0); await f.poll(); assert.equal(gaps.length, 1); assert.equal(gaps[0].kind, 'gap'); assert.equal(f.requests.length, 1);
});
test('a held old-root observation times out and new-root text proceeds without old completion changing it', async () => {
  let release; const f = await mod({ fetchObservation: (body, r) => body.text === 'old' ? new Promise(resolve => { release = resolve; }) : r.observeRoot(body) });
  const seen = []; f.r.on('progress', item => seen.push(item));
  await f.append(response('old')); const flush = f.clock.shift()(); await new Promise(r => setImmediate(r));
  const previous = f.r.record.nativeId, next = randomUUID(); await f.invoke('session.end', { sessionId: previous, reason: 'clear' });
  // $.session.id already points at the new native root when classic start fires.
  f.setNativeId(next); await f.invoke('classic.SessionStart', { session_id: next, source: 'clear' });
  for (let i = 0; i < 5 && f.clock.some(fn => fn.delay === 0); i++) { const j = f.clock.findIndex(fn => fn.delay === 0); await f.clock.splice(j, 1)[0](); }
  await f.append(response('new')); const timeout = f.clock.find(fn => fn.delay === 1500); assert.ok(timeout); timeout(); await flush;
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1].sessionId, next); assert.equal(seen.at(-1).text, 'new');
  release({ observed: true }); await new Promise(r => setImmediate(r)); assert.equal(seen.length, 1);
});
test('blocked local delivery never blocks the next native append', async () => {
  let release; const f = await mod({ fetchObservation: () => new Promise(resolve => { release = resolve; }) });
  await f.append(response()); const pending = f.clock.shift()(); await new Promise(r => setImmediate(r));
  const e = response('another native message'), result = await f.append(e); assert.equal(result.uuid, e.uuid);
  // End the root before releasing the first observation: queued stale rows cannot
  // be attributed to a new native conversation or become shared work.
  await f.invoke('session.end', { sessionId: f.r.record.nativeId, reason: 'clear' });
  release({ observed: true }); await pending; assert.equal(f.requests.length, 1);
});
test('a timed-out same-root observation cannot arrive after a newer row as the latest output', async () => {
  let deliverOld; const f = await mod({ fetchObservation: (body, r) => body.text === 'old'
    ? new Promise((resolve, reject) => { deliverOld = () => { try { resolve(r.observeRoot(body)); } catch (e) { reject(e); } }; }) : r.observeRoot(body) });
  const seen = []; f.r.on('progress', item => seen.push(item));
  await f.append(response('old')); await f.append(response('new'));
  const flush = f.clock.shift()(); await new Promise(r => setImmediate(r));
  f.clock.find(fn => fn.delay === 1500)(); await flush;
  assert.deepEqual(seen.map(x => x.kind), ['gap', 'response']); assert.equal(seen.at(-1).text, 'new');
  deliverOld(); await new Promise(r => setImmediate(r));
  assert.equal(seen.length, 2); assert.equal(seen.at(-1).text, 'new');
  assert.deepEqual(f.requests.map(x => x.sequence), [1, 2]);
  assert.equal(f.r.rootObservation.sequence, 2);
});
test('reloading an observer rejects old in-flight higher sequences without changing the control lease', async () => {
  const deliveries = [], f = await mod({ fetchObservation: (body, r) => new Promise((resolve, reject) => {
    deliveries.push(() => { try { resolve(r.observeRoot(body)); } catch (e) { reject(e); } });
  }) }), seen = [];
  f.r.on('progress', item => seen.push(item));
  for (let i = 0; i < 2; i++) {
    await f.append(response('old-' + i)); const flush = f.clock.shift()(); await new Promise(r => setImmediate(r));
    f.clock.find(fn => fn.delay === 1500)(); await flush;
  }
  const lease = f.r.rootLease, previousEpoch = f.r.observationEpoch;
  const next = await mod({ runtime: f.r }); assert.equal(f.r.rootLease, lease); assert.notEqual(f.r.observationEpoch, previousEpoch);
  await next.append(response('new')); await next.clock.shift()();
  assert.equal(seen.at(-1).text, 'new'); assert.equal(next.requests[0].sequence, 1);
  for (const deliver of deliveries) deliver(); await new Promise(r => setImmediate(r));
  assert.deepEqual(seen.map(x => x.kind), ['gap', 'response']); assert.equal(seen[1].text, 'new');
  assert.throws(() => f.r.observeRootGap({ sessionId: f.r.record.nativeId, lease, epoch: previousEpoch }), /Invalid/);
});
test('unresolved native HTTP calls remain capped while a normal poll can disclose dropped tail output', async () => {
  const releases = [], f = await mod({ fetchObservation: () => new Promise(resolve => releases.push(resolve)) }), gaps = [];
  f.r.on('progress', item => gaps.push(item));
  for (let i = 0; i < 3; i++) {
    await f.append(response('held-' + i)); const flush = f.clock.shift()(); await new Promise(r => setImmediate(r));
    const timeout = f.clock.find(fn => fn.delay === 1500); if (timeout) timeout(); await flush;
  }
  assert.equal(f.requests.length, 2); assert.equal(releases.length, 2);
  await f.poll(); assert.equal(gaps.length, 1); assert.equal(gaps[0].kind, 'gap');
  for (const release of releases) release({ observed: true }); await new Promise(r => setImmediate(r));
});
test('unverified runtime versions do not enable native message observation', async () => {
  const f = await mod({ version: '2.1.307' }); await f.append(response()); assert.equal(f.clock.length, 0); assert.equal(f.requests.length, 0);
});
test('legacy observation appears inline but remains volatile and cannot alter readiness, sharing or dispatch', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-native-observation-')); let r;
  const w = new Workspace({ binaries: {}, close() {}, create(record) { r = adapter(); r.record = record; r.chatAvailable = true; r.start = async () => r.emit('state', 'working'); return r; } }, dir);
  t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const id = await w.create('claude', dir, 'owner'); w.join(id, true); const before = JSON.stringify(w.snapshot());
  const body = { sessionId: r.record.nativeId, lease: r.rootLease, epoch: r.observationEpoch, sequence: 1, id: randomUUID(), kind: 'response', text: 'PRIVATE_NATIVE_OUTPUT', gap: true, truncated: true };
  r.observeRoot(body); assert.throws(() => r.observeRoot({ ...body, gap: false }), /Stale/);
  const after = w.snapshot(); assert.equal(after.sessions[0].messages.at(-1).text, body.text);
  after.sessions[0].messages = []; assert.equal(JSON.stringify(after), before); const observed = await w.observe(id);
  assert.equal(observed.progress.items.length, 2); assert.equal(observed.progress.items.at(-1).truncated, true);
  w.persist(); assert.ok(!fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8').includes(body.text));
});
test('private observation transport rejects stale root leases, invalid IDs and oversized text', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-observe-')), socketPath = path.join(dir, 's'), r = adapter(), journal = new ProgressJournal();
  r.on('progress', item => journal.update(item)); const transport = createSubmissionServer(socketPath, new Map([['token', r]])); await transport.start();
  t.after(async () => { r.submission.close(); transport.server.closeAllConnections(); await new Promise(resolve => transport.server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const request = body => new Promise((resolve, reject) => { const req = http.request({ socketPath, path: '/observation', method: 'POST', headers: { 'X-Workspace-Token': 'token' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject); req.end(JSON.stringify(body)); });
  const row = { sessionId: r.record.nativeId, lease: r.rootLease, epoch: r.observationEpoch, sequence: 1, id: randomUUID(), kind: 'response', text: 'Observed' };
  for (const patch of [{ lease: 'stale' }, { sessionId: randomUUID() }, { id: '<script>' }, { kind: 'prompt' }, { text: 'x'.repeat(12001) }, { sequence: 0 }, { sequence: 1.5 }, { sequence: null }]) assert.equal(await request({ ...row, ...patch }), 409);
  assert.equal(journal.items.size, 0); assert.equal(await request(row), 200); assert.equal(journal.items.size, 1);
  r.rootEnding = { sessionId: r.record.nativeId }; assert.equal(await request(row), 409);
});
test('held native turn completion cannot enter a newly cleared root', async () => {
  const f = await mod({ version: '2.1.307' }), rows = [], turnId = randomUUID();
  f.r.on('nativeBlock', row => rows.push(row));
  let release; const finishing = f.invoke('turn.complete', { turnId, reason: 'aborted' }, () => new Promise(resolve => { release = resolve; }));
  const previous = f.r.record.nativeId, next = randomUUID();
  await f.invoke('session.end', { sessionId: previous, reason: 'clear' }); f.setNativeId(next);
  await f.invoke('classic.SessionStart', { session_id: next, source: 'clear' });
  for (let i = 0; i < 5 && f.clock.some(fn => fn.delay === 0); i++) { const j = f.clock.findIndex(fn => fn.delay === 0); await f.clock.splice(j, 1)[0](); }
  release({}); await finishing;
  for (let i = 0; i < 5 && f.clock.some(fn => fn.delay === 0); i++) { const j = f.clock.findIndex(fn => fn.delay === 0); await f.clock.splice(j, 1)[0](); }
  assert.equal(rows.length, 0); assert.equal(f.r.record.nativeId, next);
});
test('display redaction survives Stop, shared room retention and the next automatic handoff', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-display-proof-')); let r;
  const w = new Workspace({ binaries: {}, close() {}, create(record) { r = adapter(); r.record = record; r.chatAvailable = true; return r; } }, dir);
  t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const id = await w.create('claude', dir, 'owner'); w.join(id, true);
  const f = await mod({ runtime: r, version: '2.1.307' });
  const turnId = randomUUID(), promptId = randomUUID(), tag = randomUUID();
  r.pending = { nativeId: r.record.nativeId, accepted: true, promptId, turnId, tag, guard: () => true };
  w.get(id).pendingTag = tag; w.forwards.set(tag, { member: w.get(id).memberRevision, control: w.get(id).controlRevision });
  w.sharedReplies.authorize(w.get(id), r, tag, { id: tag });
  const advanced = []; w.advance = async (_, info) => advanced.push(info);
  await f.invoke('classic.UserPromptSubmit', { session_id: r.record.nativeId, prompt_id: promptId });
  await f.invoke('turn.start', { turnId });
  const e = { session_id: r.record.nativeId, prompt_id: promptId, turn_id: randomUUID(), message_id: randomUUID(), index: 0, final: true, delta: 'PRIVATE ORIGINAL' };
  await f.invoke('classic.MessageDisplay', e, async () => ({ displayContent: 'REDACTED' }));
  // Stop arrives before the asynchronous display observation: it cannot leak.
  r.finishReply(r.pending, { prompt_id: promptId, last_assistant_message: 'PRIVATE ORIGINAL', background_tasks: [], session_crons: [], stop_hook_active: false });
  assert.equal(w.room.messages.length, 0); assert.equal(advanced.length, 0);
  await f.invoke('turn.complete', { turnId, reason: 'answer', answer: 'PRIVATE ORIGINAL' }); await f.clock.shift()();
  assert.equal(w.room.messages[0].text, 'REDACTED'); assert.equal(advanced[0].text, 'REDACTED'); assert.equal(advanced[0].tag, tag);
  assert.ok(!JSON.stringify(w.snapshot()).includes('PRIVATE ORIGINAL')); w.persist();
  assert.ok(!fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8').includes('PRIVATE ORIGINAL'));
});
test('missing display identity or a display gap never falls back to raw Stop text', async () => {
  for (const gap of [false, true]) {
    const f = await mod({ version: '2.1.307' }), r = f.r, turnId = randomUUID(), promptId = randomUUID(), tag = randomUUID(), complete = [];
    r.pending = { nativeId: r.record.nativeId, accepted: true, promptId, turnId, tag, guard: () => true };
    r.on('complete', info => complete.push(info));
    await f.invoke('classic.UserPromptSubmit', { session_id: r.record.nativeId, prompt_id: promptId });
  await f.invoke('turn.start', { turnId });
  const e = { session_id: r.record.nativeId, prompt_id: promptId, turn_id: randomUUID(), message_id: randomUUID(), index: 0, final: true, delta: 'PRIVATE' };
    await f.invoke('classic.MessageDisplay', e, async () => ({ displayContent: 'MASKED' }));
    await f.invoke('turn.complete', { turnId, reason: 'answer', answer: gap ? 'PRIVATE' : 'OTHER' });
    if (gap) r.observeRootGap({ sessionId: r.record.nativeId, lease: r.rootLease, epoch: r.observationEpoch });
    await f.clock.shift()();
    r.finishReply(r.pending, { prompt_id: promptId, last_assistant_message: 'PRIVATE' });
    assert.equal(complete[0].tag, undefined); assert.equal(complete[0].text, '');
  }
});
test('a gap or late batch after a valid final display revokes sharing before a delayed Stop', async () => {
  for (const damage of ['gap', 'late']) {
    const f = await mod({ version: '2.1.307' }), r = f.r, turnId = randomUUID(), promptId = randomUUID(), tag = randomUUID(), completed = [];
    await f.invoke('classic.UserPromptSubmit', { session_id: r.record.nativeId, prompt_id: promptId }); await f.invoke('turn.start', { turnId });
    r.pending = { nativeId: r.record.nativeId, accepted: true, promptId, turnId, tag, guard: () => true }; r.on('complete', info => completed.push(info));
    const e = { session_id: r.record.nativeId, prompt_id: promptId, turn_id: randomUUID(), message_id: randomUUID(), index: 0, final: true, delta: 'Safe display\n' };
    await f.invoke('classic.MessageDisplay', e, async () => ({}));
    await f.invoke('turn.complete', { turnId, reason: 'answer', answer: 'Safe display' }); await f.clock.shift()();
    assert.equal(r.displayProofs.get(turnId).safeText, 'Safe display\n');
    if (damage === 'gap') r.observeRootGap({ sessionId: r.record.nativeId, lease: r.rootLease, epoch: r.observationEpoch });
    else { await f.invoke('classic.MessageDisplay', { ...e, index: 1, delta: 'late' }, async () => ({})); await f.clock.shift()(); }
    r.finishReply(r.pending, { prompt_id: promptId, last_assistant_message: 'Safe display' });
    assert.equal(completed[0].tag, undefined); assert.equal(completed[0].text, '');
  }
});

for (const legacy of [false, true]) test(`fresh ${legacy ? 'retained' : 'current'} native root interruption releases only its own pending task`, async () => {
  const f = await mod({ version: legacy ? '2.1.302' : '2.1.308', legacy });
  const states = [], complete = [], background = [], interrupted = [], turnId = randomUUID(), promptId = randomUUID();
  f.r.on('state', s => states.push(s)); f.r.on('complete', e => complete.push(e));
  f.r.on('background', e => background.push(e)); f.r.on('interrupted', e => interrupted.push(e));
  await f.invoke('classic.UserPromptSubmit', { session_id: f.r.record.nativeId, prompt_id: promptId });
  await f.invoke('turn.start', { turnId }); await f.clock.shift()();
  f.r.pending = { tag: 'accepted-input', turnId, accepted: true, promptId };
  const queued = { tag: 'next-waiting-input' }; f.r.queued = queued;
  await f.invoke('turn.complete', { turnId, reason: 'aborted' }); await f.clock.shift()();
  assert.deepEqual(states, ['idle']); assert.equal(f.r.pending, null); assert.equal(f.r.queued, queued);
  assert.deepEqual(interrupted, [{ turnId, tag: 'accepted-input' }]); assert.deepEqual(complete, []); assert.deepEqual(background, []);
});

for (const boundary of ['new-turn', 'input', 'permission', 'gap', 'rebind', 'replay', 'end', 'duplicate-start'])
test(`native interruption cannot override ${boundary}`, async () => {
  const f = await mod({ version: '2.1.308' }), states = [], first = randomUUID(), next = randomUUID();
  f.r.on('state', state => states.push(state));
  await f.invoke('turn.start', { turnId: first }); await f.clock.shift()();
  if (boundary === 'new-turn') { await f.invoke('turn.start', { turnId: next }); await f.clock.shift()(); }
  if (['input', 'permission', 'duplicate-start'].includes(boundary)) {
    await f.invoke(boundary === 'permission' ? 'classic.PermissionRequest' : 'prompt.submit', { session_id: f.r.record.nativeId });
    await f.clock.shift()();
    if (boundary === 'duplicate-start') { await f.invoke('turn.start', { turnId: first }); await f.clock.shift()(); }
  }
  if (boundary === 'gap') f.r.observeRootGap({ sessionId: f.r.record.nativeId, lease: f.r.rootLease, epoch: f.r.observationEpoch });
  if (boundary === 'rebind') f.r.bindRoot({ sessionId: f.r.record.nativeId, nativeBlocks: true });
  if (boundary === 'end') { f.r.contextEnding(); states.length = 0; }
  if (boundary === 'replay') {
    const body = { block: true, sessionId: f.r.record.nativeId, lease: f.r.rootLease, epoch: f.r.observationEpoch,
      sequence: 2, id: 'control:turn-start', kind: 'control', turnId: next, status: 'running', replayed: true };
    f.r.observeRoot(body);
    f.r.observeRoot({ ...body, sequence: 3, id: 'turn:' + next, kind: 'turn', status: 'interrupted' });
  } else { await f.invoke('turn.complete', { turnId: first, reason: 'aborted' }); await f.clock.shift()(); }
  assert.ok(!states.includes('idle'));
});


test('native model metadata preserves the active task and ignores children, stale roots and late startup', async () => {
  const f = await mod({ version: '2.1.309' }), models = [];
  f.r.on('model', value => models.push(value)); f.setModelReader(async () => 'claude-sonnet-test');
  const turn = { id: 'active', status: 'working' }; f.r.rootTurn = turn; f.r.nativeInputRequired = true;
  let boundaries = 0; f.r.on('sharingBoundary', () => boundaries++);
  await f.invoke('classic.PostModelSwitch', { session_id: f.r.record.nativeId, to_model: 'claude-sonnet-test' }); await new Promise(r => setImmediate(r)); await f.clock.shift()();
  assert.deepEqual(models, ['claude-sonnet-test']); assert.equal(f.r.rootTurn, turn);
  assert.equal(f.r.nativeInputRequired, true); assert.equal(boundaries, 0);
  // Independently transported classic startup cannot overwrite a newer observation.
  f.r.hook({ hook_event_name: 'SessionStart', session_id: f.r.record.nativeId, model: 'old-startup' });
  assert.deepEqual(models, ['claude-sonnet-test']);
  await f.invoke('classic.PostModelSwitch', { session_id: f.r.record.nativeId, agent_id: 'child' });
  await f.invoke('classic.PostModelSwitch', { session_id: randomUUID() });
  assert.equal(f.clock.length, 0);
  const stale = f.requests[0]; f.r.bindRoot({ sessionId: f.r.record.nativeId, nativeBlocks: true });
  assert.throws(() => f.r.observeBlock({ ...stale, sequence: 999 }), /Invalid/);
});

test('slow model read cannot overwrite a later native selection or survive root retirement', async () => {
  const f = await mod({ version: '2.1.309' }), models = []; f.r.on('model', value => models.push(value));
  let resolve; f.setModelReader(() => new Promise(r => { resolve = r; }));
  const older = f.readModel();
  await new Promise(r => setImmediate(r));
  f.setModelReader(async () => 'claude-latest');
  await f.invoke('classic.PostModelSwitch', { session_id: f.r.record.nativeId, to_model: 'claude-latest' });
  resolve('claude-older'); await older; await new Promise(r => setImmediate(r)); await f.clock.shift()();
  assert.deepEqual(models, ['claude-latest']);
  f.setModelReader(() => new Promise(r => { resolve = r; }));
  const retiring = f.readModel();
  await new Promise(r => setImmediate(r));
  await f.invoke('session.end', { sessionId: f.r.record.nativeId, reason: 'other' });
  resolve('claude-retired'); await retiring;
  assert.equal(f.requests.length, 1);
});

test('model metadata rejects invalid payloads and ignores offline replay without accepting input', async () => {
  const f = await mod({ version: '2.1.309' }), models = []; f.r.on('model', x => models.push(x));
  f.setModelReader(async () => 'claude-sonnet-test');
  await f.invoke('classic.PostModelSwitch', { session_id: f.r.record.nativeId, to_model: 'claude-sonnet-test' }); await new Promise(r => setImmediate(r)); await f.clock.shift()();
  const base = { ...f.requests[0], sequence: 2 };
  for (const model of [null, {}, '', 'x'.repeat(161), 'bad\nmodel'])
    assert.throws(() => f.r.observeBlock({ ...base, model }), /Invalid/);
  f.r.observeBlock({ ...base, model: 'claude-old', replayed: true });
  assert.deepEqual(models, ['claude-sonnet-test']);
  const unknown = await mod({ version: '2.1.313' });
  unknown.setModelReader(async () => { throw Error('Unknown version must not be queried'); });
  // A valid to_model would publish on a supported version; an unknown one must stay silent.
  await unknown.invoke('classic.PostModelSwitch', { session_id: unknown.r.record.nativeId, to_model: 'claude-sonnet-test' });
  await new Promise(r => setImmediate(r)); while (unknown.clock.length) await unknown.clock.shift()();
  assert.equal(unknown.requests.length, 0);
});


for (const version of ['2.1.310', '2.1.312', '2.1.316', '2.1.317']) test('native model metadata updates the model block for a valid switch: ' + version, async () => {
  const f = await mod({ version }), models = [];
  f.r.on('model', value => models.push(value)); f.setModelReader(async () => 'claude-sonnet-test');
  await f.invoke('classic.PostModelSwitch', { session_id: f.r.record.nativeId, to_model: 'claude-sonnet-test' });
  await new Promise(r => setImmediate(r)); await f.clock.shift()();
  assert.deepEqual(models, ['claude-sonnet-test']);
  assert.equal(f.requests[0].id, 'control:model'); assert.equal(f.requests[0].model, 'claude-sonnet-test');
});

// The reader exists from the start, so the bind-time read (not only the switch hook) is covered. The
// fixture drops timers queued during startup, so the block that read sends is not visible here; the
// switch tests above cover the same block path, and the real-CLI model run records the start model.
for (const [version, on] of [['2.1.316', true], ['2.1.317', true], ['2.1.313', false]]) test(`native ${version} ${on ? 'reads' : 'does not read'} the model at bind (T-133)`, async () => {
  let reads = 0;
  await mod({ version, modelReader: async () => { reads++; return 'claude-sonnet-test'; } });
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.equal(reads > 0, on);
});
test('native 2.1.313 keeps model metadata off: no read, no block (T-133)', async () => {
  let reads = 0;
  const f = await mod({ version: '2.1.313', modelReader: async () => { reads++; return 'claude-sonnet-test'; } }), models = [];
  f.r.on('model', value => models.push(value));
  await f.invoke('classic.PostModelSwitch', { session_id: f.r.record.nativeId, to_model: 'claude-sonnet-test' });
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.equal(reads, 0); assert.deepEqual(models, []); assert.ok(!f.requests.some(x => x.id === 'control:model'));
});
test('native model metadata on 2.1.310 ignores invalid and oversized switch payloads', async () => {
  const f = await mod({ version: '2.1.310' }), models = [];
  f.r.on('model', value => models.push(value));
  for (const model of [null, {}, '', 'x'.repeat(161), 'bad\nmodel'])
    await f.invoke('classic.PostModelSwitch', { session_id: f.r.record.nativeId, to_model: model });
  assert.equal(f.clock.length, 0); assert.equal(f.requests.length, 0); assert.deepEqual(models, []);
});


test('held initial model metadata never blocks native input polling', async () => {
  let reads = 0, polls = 0;
  const f = await mod({ version: '2.1.309', modelReader: () => { reads++; return new Promise(() => {}); },
    requestHandler: async url => { if (url.endsWith('/next')) polls++; } });
  assert.equal(reads, 1); assert.equal(polls, 1);
  for (let i = 0; i < 10; i++) f.readModel();
  assert.equal(reads, 2, 'Unabortable metadata requests are bounded');
  await f.poll(); assert.equal(polls, 2);
});

test('retained rebind with held model metadata still flushes offline native output', async () => {
  let token = 'a'.repeat(64), online = true, reads = 0;
  const f = await mod({ version: '2.1.302', legacy: true,
    modelReader: () => { reads++; return new Promise(() => {}); },
    requestHandler: async (url, options) => {
      if (!online) throw Error('offline');
      if (options.headers['X-Workspace-Token'] !== token) return { ok: false, status: 403 };
    } });
  online = false;
  await f.invoke('classic.MessageDisplay', { session_id: f.r.record.nativeId, turn_id: randomUUID(),
    message_id: randomUUID(), prompt_id: randomUUID(), index: 0, delta: 'offline output', final: false }, async () => ({}));
  await f.clock.shift()();
  token = 'b'.repeat(64); f.setToken(token); online = true;
  await f.clock.shift()();
  assert.equal(reads, 2); assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].delta, 'offline output');
});


test('invalid native model query cannot become a plausible string label', async () => {
  const f = await mod({ version: '2.1.309' });
  for (const value of [undefined, null, {}, 123, 'bad\nmodel']) {
    f.setModelReader(async () => value);
    await f.readModel();
    await new Promise(r => setImmediate(r));
  }
  assert.equal(f.clock.length, 0); assert.equal(f.requests.length, 0);
});


test('native switch event wins over lagging query and delayed older switch hook', async () => {
  const f = await mod({ version: '2.1.302', legacy: true }), models = [];
  f.r.on('model', model => models.push(model)); f.setModelReader(async () => 'claude-old-query');
  let finish;
  const first = f.invoke('classic.PostModelSwitch', { session_id: f.r.record.nativeId, to_model: 'claude-first' },
    () => new Promise(resolve => { finish = resolve; }));
  await f.invoke('classic.PostModelSwitch', { session_id: f.r.record.nativeId, to_model: 'claude-second' });
  finish({}); await first; await f.clock.shift()();
  assert.deepEqual(models, ['claude-second']);
});


for (const legacy of [false, true]) for (const order of ['append-first', 'failure-first', 'end-first'])
test(`native API failure uses only processed same-turn text: ${legacy ? 'retained' : 'current'} ${order}`, async () => {
  const f = await mod({ version: legacy ? '2.1.302' : '2.1.309', legacy }), rows = [], prompt = randomUUID(), turn = randomUUID();
  f.r.on('nativeBlock', row => rows.push(row));
  f.r.lastPromptId = prompt; f.r.submission.status(true);
  await f.invoke('classic.UserPromptSubmit', { session_id: f.r.record.nativeId, prompt_id: prompt });
  await f.invoke('turn.start', { turnId: turn });
  const nativeErrorId = randomUUID();
  const append = () => f.append(response('API Error: PRIVATE RAW', { uuid: nativeErrorId, origin: { kind: 'model', model: '<synthetic>' } }), async e =>
    ({ uuid: e.uuid, message: { type: 'assistant', content: [{ type: 'text', text: 'SAFE ERROR' }] } }));
  const failure = () => f.invoke('classic.StopFailure', { session_id: f.r.record.nativeId, prompt_id: prompt,
    error_details: 'PRIVATE DETAIL', last_assistant_message: 'PRIVATE LAST ANSWER' });
  const end = () => f.invoke('turn.complete', { turnId: turn, reason: 'error', answer: '', durationMs: 100 });
  for (const fn of order === 'append-first' ? [append, failure, end] : order === 'failure-first' ? [failure, end, append] : [end, append, failure]) await fn();
  while (f.clock.length) await f.clock.shift()();
  const failures = rows.filter(row => row.kind === 'turn');
  assert.match(failures.at(-1).text, /SAFE ERROR/); assert.equal(failures.at(-1).status, 'failed');
  assert.equal(f.requests.filter(row => row.kind === 'turn').at(-1).errorMessageId, nativeErrorId, 'Every native event order retains the exact saved error UUID');
  assert.ok(failures.every(row => row.id === `turn:${turn}` && !row.finalDisplayId));
  assert.ok(!JSON.stringify(rows).includes('PRIVATE')); assert.equal(rows.filter(row => row.kind === 'response').length, 0);
  const session = { nativeId: f.r.record.nativeId, messages: [] };
  for (const row of rows) require('../native-blocks.cjs').applyNativeBlock(session, row);
  assert.equal(session.messages.length, 1); assert.equal(session.messages[0].role, 'system');
  assert.equal(f.r.failedTurnInputId, turn, 'Only the confirmed failed native turn permits a new explicit input');
  f.r.claimFailedTurnInput(); assert.equal(f.r.failedTurnInputId, null);
  await failure(); while (f.clock.length) await f.clock.shift()();
  assert.equal(f.r.failedTurnInputId, null, 'A delayed failure update cannot grant another send');
});

test('late root failure cannot erase a newer native task or child work', () => {
  const r = adapter(), current = randomUUID(), old = randomUUID(), states = [];
  r.lastPromptId = current; r.rootTurn = { id: 'new-turn', promptId: current, status: 'working' };
  const pending = r.pending = { promptId: current, tag: 'new-input' };
  r.on('state', state => states.push(state));
  r.hook({ hook_event_name: 'StopFailure', session_id: r.record.nativeId, prompt_id: old });
  r.hook({ hook_event_name: 'StopFailure', session_id: r.record.nativeId, prompt_id: current, agent_id: 'child' });
  assert.equal(r.pending, pending); assert.equal(r.rootTurn.id, 'new-turn'); assert.deepEqual(states, []);
});
for (const boundary of ['pending-send', 'ordered-start']) test(`late failed A cannot erase B at ${boundary} before settings hook catches up`, () => {
  const r = adapter(), a = randomUUID(), b = randomUUID(), states = [];
  r.nativeBlocks = true;
  r.lastPromptId = a; r.rootTurn = { id: 'failed-A', promptId: a, status: 'error', inputUsed: true };
  const pending = r.pending = { tag: 'new-B', failedPromptId: a, promptId: null, accepted: false };
  r.on('state', s => states.push(s)); r.on('failed', () => states.push('failed'));
  if (boundary === 'ordered-start') r.observeBlock({ sessionId: r.record.nativeId, lease: r.rootLease,
    epoch: r.observationEpoch, sequence: 1, block: true, id: 'control:turn-start', kind: 'control',
    turnId: 'new-B', promptId: b, status: 'running' });
  r.hook({ hook_event_name: 'StopFailure', session_id: r.record.nativeId, prompt_id: a });
  assert.equal(r.pending, pending); assert.deepEqual(states, []);
  if (boundary === 'ordered-start') {
    assert.equal(r.rootTurn.id, 'new-B');
    r.hook({ hook_event_name: 'StopFailure', session_id: r.record.nativeId, prompt_id: b });
    assert.equal(r.pending, null); assert.deepEqual(states, ['error', 'failed'], 'B failure remains actionable despite stale settings lastPromptId');
  }
});

for (const boundary of ['input', 'permission', 'gap', 'rebind', 'end', 'stop', 'disconnect', 'dead-process'])
test(`explicit failure recovery cannot outlive ${boundary}`, async () => {
  const r = new Claude({ nativeId: randomUUID() }, null, { attachOnly: true });
  r.terminal = { alive: true }; r.bindRoot({ sessionId: r.record.nativeId, nativeBlocks: true }); r.submission.status(true);
  const prompt = randomUUID(), turn = randomUUID(); r.lastPromptId = prompt;
  r.rootTurn = { id: turn, promptId: prompt, status: 'error' };
  assert.equal(r.failedTurnInputId, turn);
  if (['input', 'permission'].includes(boundary)) r.observeRoot({ block: true, sessionId: r.record.nativeId, lease: r.rootLease,
    epoch: r.observationEpoch, sequence: 1, id: `control:${boundary}`, kind: 'control', status: 'complete' });
  if (boundary === 'gap') r.observeRootGap({ sessionId: r.record.nativeId, lease: r.rootLease, epoch: r.observationEpoch });
  if (boundary === 'rebind') r.bindRoot({ sessionId: r.record.nativeId, nativeBlocks: true });
  if (boundary === 'end') r.contextEnding();
  if (boundary === 'stop') r.nativeInputRequired = true;
  if (boundary === 'disconnect') { r.submission.status(false); r.submission.status(true); }
  if (boundary === 'dead-process') r.terminal.alive = false;
  assert.equal(r.failedTurnInputId, null); assert.equal(r.failedTurnInputMatches(turn), false);
  r.submission.close();
});
for (const rejection of ['empty-transform', 'ordinary-model', 'unknown-shape', 'child', 'old-prompt', 'aborted', 'changed-uuid', 'reinitialized'])
test(`native API failure does not disclose uncertain or transformed-away content: ${rejection}`, async () => {
  const f = await mod({ version: '2.1.309' }), rows = [], prompt = randomUUID(), turn = randomUUID();
  f.r.on('nativeBlock', row => rows.push(row));
  await f.invoke('classic.UserPromptSubmit', { session_id: f.r.record.nativeId, prompt_id: prompt });
  await f.invoke('turn.start', { turnId: turn });
  const e = response(rejection === 'unknown-shape' ? 'PRIVATE BODY' : 'API Error: PRIVATE BODY', {
    origin: { kind: 'model', model: rejection === 'ordinary-model' ? 'claude-haiku' : '<synthetic>' },
    ...(rejection === 'child' ? { agentId: 'child' } : {}) });
  await f.append(e, async e => {
    if (rejection === 'reinitialized') await f.invoke('session.start', {});
    return { uuid: rejection === 'changed-uuid' ? randomUUID() : e.uuid,
      message: { type: 'assistant', content: [{ type: 'text', text: rejection === 'empty-transform' ? '' : 'PRIVATE BODY' }] } };
  });
  await f.invoke('classic.StopFailure', { session_id: f.r.record.nativeId,
    prompt_id: rejection === 'old-prompt' ? randomUUID() : prompt, last_assistant_message: 'API Error: PRIVATE OLD' });
  await f.invoke('turn.complete', { turnId: turn, reason: rejection === 'aborted' ? 'aborted' : 'error' });
  // Session restart owns its new repeating poll; only flush existing observations.
  for (let i = 0; i < 3 && f.clock.length; i++) await f.clock.shift()();
  assert.ok(!JSON.stringify(rows).includes('PRIVATE'));
});

test('held tool discovery never blocks root binding or input polling and remains single-flight', async () => {
  let reads = 0, polls = 0;
  const f = await mod({ version: '2.1.309', toolReader: () => { reads++; return new Promise(() => {}); },
    requestHandler: async url => { if (url.endsWith('/next')) polls++; } });
  assert.equal(reads, 1); assert.equal(polls, 1);
  for (let i = 0; i < 4; i++) await f.poll();
  assert.equal(reads, 1); assert.equal(polls, 5);
});


test('usage read is free, root-scoped, metadata-only and version-gated', async () => {
  const f = await mod({ version: '2.1.309' }), usage = [], blocks = [], capabilities = [];
  f.r.on('usage', x => usage.push(x)); f.r.on('nativeBlock', x => blocks.push(x)); f.r.on('capability', x => capabilities.push(x));
  f.setUsageReader(async (...args) => { assert.equal(args.length, 0); return { context: { window: 200000, tokens: 17, percent: 0 }, cost: { usd: 0 } }; });
  await f.readUsage(); await new Promise(r => setImmediate(r)); await f.clock.shift()();
  assert.equal(usage.length, 1); assert.equal(usage[0].context.tokens, 17);
  assert.deepEqual(blocks, []); assert.deepEqual(capabilities, []);
  const requestCount = f.requests.length;
  f.setUsageReader(async () => ({ context: { window: 0 } })); await f.readUsage();
  assert.equal(f.requests.length, requestCount); assert.equal(f.clock.length, 0, 'Unavailable metadata cannot inject an observation gap');
  let resolve;
  f.setUsageReader(() => new Promise(r => { resolve = r; }));
  const pending = f.readUsage(); f.setNativeId(randomUUID()); resolve({ context: { window: 200000, tokens: 999 } }); await pending;
  assert.equal(usage.length, 1, 'Old native identity may not publish a reading');
  const unknown = await mod({ version: '2.1.313' });
  let unknownReads = 0; unknown.setUsageReader(() => { unknownReads++; throw Error('Unknown version must not read'); }); await unknown.readUsage();
  assert.equal(unknownReads, 0, 'An unknown native version is never asked for usage');
});

for (const version of ['2.1.310', '2.1.312']) test('usage metadata is read after turn completion and missing values stay unknown: ' + version, async () => {
  const f = await mod({ version }), usage = []; let reads = 0;
  f.r.on('usage', x => usage.push(x));
  const first = randomUUID();
  await f.invoke('turn.start', { turnId: first }); await f.clock.shift()();
  f.setUsageReader(async (...args) => { assert.equal(args.length, 0); reads++; return { context: { window: 200000, tokens: 42, percent: 0.5 }, cost: { usd: 0 } }; });
  await f.invoke('turn.complete', { turnId: first, reason: 'answer', answer: 'ok' });
  await new Promise(r => setImmediate(r)); await f.clock.shift()();
  assert.equal(reads, 1); assert.equal(usage.length, 1);
  assert.equal(usage[0].context.window, 200000); assert.equal(usage[0].context.tokens, 42); assert.equal(usage[0].context.percent, 0.5);
  const second = randomUUID();
  await f.invoke('turn.start', { turnId: second }); await f.clock.shift()();
  f.setUsageReader(async () => { reads++; return { context: { window: 200000 } }; });
  await f.invoke('turn.complete', { turnId: second, reason: 'answer', answer: 'ok' });
  await new Promise(r => setImmediate(r)); await f.clock.shift()();
  assert.equal(reads, 2); assert.equal(usage.length, 2);
  assert.equal(usage[1].context.window, 200000); assert.equal(usage[1].context.tokens, undefined);
});

for (const [version, read] of [['2.1.316', true], ['2.1.317', true], ['2.1.313', false]]) test(`native ${version} ${read ? 'reads' : 'does not read'} the free status-line usage (T-133)`, async () => {
  let reads = 0;
  const f = await mod({ version, usageReader: async args => { reads++; assert.equal(args, undefined, 'Only the free plain read'); return { context: { window: 200000, tokens: 1234, percent: 1 } }; } });
  const blocks = []; f.r.on('nativeBlock', row => blocks.push(row));
  await f.readUsage(); await new Promise(r => setImmediate(r));
  assert.equal(reads > 0, read, version); // bind already reads once; an explicit read may add one
});
test('held usage metadata never blocks binding/input and coalesces reads', async () => {
  let reads = 0, release;
  const f = await mod({ version: '2.1.309', usageReader: () => { reads++; return new Promise(r => { release = r; }); } });
  assert.ok(f.r.rootLease); assert.equal(typeof f.poll, 'function');
  await f.readUsage(); await f.readUsage(); assert.equal(reads, 1);
  f.setUsageReader(async () => { reads++; return { context: { window: 200000 } }; });
  release({ context: { window: 200000, tokens: 123 } }); await new Promise(r => setImmediate(r));
  assert.equal(reads, 2, 'Repeated observation requests coalesce to one fresh read');
});

// The final HTTP error is typed only in the saved native row. The bridge and
// StopFailure must independently identify that same live root turn first.
function capacityFailure(t, rowChange = {}) {
  const r = adapter(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-claude-capacity-'));
  t.after(() => { r.submission.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  r.nativeBlocks = true; r.nativeAbortAvailable = true; r.nativeCapacityAvailable = true; r.submission.status(true);
  const prompt = r.lastPromptId = randomUUID(), turnId = randomUUID(), messageId = randomUUID();
  const file = path.join(dir, r.record.nativeId + '.jsonl');
  const row = { uuid: messageId, sessionId: r.record.nativeId, type: 'assistant', isSidechain: false,
    isApiErrorMessage: true, message: { model: '<synthetic>' }, apiErrorStatus: 529, ...rowChange };
  fs.writeFileSync(file, JSON.stringify(row) + '\n');
  let sequence = 0;
  const block = extra => r.observeBlock({ sessionId: r.record.nativeId, lease: r.rootLease, epoch: r.observationEpoch, sequence: ++sequence, ...extra });
  block({ id: 'control:turn-start', kind: 'control', status: 'running', promptId: prompt, turnId });
  const events = []; r.on('nativeTurnEnd', e => events.push(e));
  const fail = (extra = {}) => block({ id: 'turn:' + turnId, kind: 'turn', turnId, status: 'failed', failedRequest: true, errorMessageId: messageId, ...extra });
  const stop = (extra = {}) => r.hook({ hook_event_name: 'StopFailure', session_id: r.record.nativeId, prompt_id: prompt, transcript_path: file, ...extra });
  return { r, dir, file, row, block, fail, stop, events, prompt, turnId, messageId };
}
for (const order of ['frame-first', 'hook-first']) test('Claude capacity needs native UUID, typed529 and both live boundaries: ' + order, t => {
  const f = capacityFailure(t);
  if (order === 'frame-first') { f.fail(); assert.equal(f.events.length, 0); f.stop(); }
  else { f.stop(); assert.equal(f.events.length, 0); f.fail(); }
  assert.deepEqual(f.events, [{ nativeId: f.r.record.nativeId, turnId: f.turnId, status: 'failed', errorInfo: 'serverOverloaded' }]);
  f.stop(); f.fail(); assert.equal(f.events.length, 1, 'Duplicate hooks or updates cannot schedule another attempt');
});
for (const change of [{ apiErrorStatus: 500 }, { apiErrorStatus: 429 }, { apiErrorStatus: 401 }, { apiErrorStatus: '529' },
  { apiErrorStatus: null }, { isApiErrorMessage: false }, { isSidechain: true }, { sessionId: randomUUID() },
  { uuid: randomUUID() }, { message: { model: 'ordinary-model' } }, { type: 'user' }])
test('Claude capacity rejects non-overload or unrelated native metadata: ' + JSON.stringify(change), t => {
  const f = capacityFailure(t, change); f.fail(); f.stop(); assert.deepEqual(f.events.filter(e => e.errorInfo === 'serverOverloaded'), []);
});
for (const boundary of ['replayed', 'gap', 'incomplete', 'child-hook', 'old-hook', 'retained', 'unqualified', 'new-prompt', 'rebind', 'used-input', 'dead', 'torn', 'missing', 'symlink', 'outside-tail', 'already-complete', 'fifo'])
test('Claude capacity cannot infer a fresh failure through ' + boundary, t => {
  const f = capacityFailure(t);
  if (boundary === 'retained') f.r.retainedReader = true;
  if (boundary === 'unqualified') f.r.nativeCapacityAvailable = false;
  if (boundary === 'torn') fs.writeFileSync(f.file, JSON.stringify(f.row).slice(0, -2));
  if (boundary === 'missing') fs.unlinkSync(f.file);
  if (boundary === 'fifo') { fs.unlinkSync(f.file); require('node:child_process').execFileSync('mkfifo', [f.file]); }
  if (boundary === 'symlink') { fs.renameSync(f.file, f.file + '.saved'); fs.symlinkSync(f.file + '.saved', f.file); }
  if (boundary === 'outside-tail') fs.appendFileSync(f.file, ' '.repeat(270000));
  if (boundary === 'already-complete') f.fail({ status: 'complete', failedRequest: false, errorMessageId: undefined });
  f.fail(['replayed', 'gap', 'incomplete'].includes(boundary) ? { [boundary]: true } : {});
  if (boundary === 'new-prompt') f.r.hook({ hook_event_name: 'UserPromptSubmit', session_id: f.r.record.nativeId, prompt_id: randomUUID(), prompt: 'New human task' });
  if (boundary === 'rebind') f.r.bindRoot({ sessionId: f.r.record.nativeId, nativeBlocks: true, nativeAbort: true });
  if (boundary === 'used-input') f.r.claimFailedTurnInput();
  if (boundary === 'dead') f.r.terminal.alive = false;
  f.stop(boundary === 'child-hook' ? { agent_id: 'child' } : boundary === 'old-hook' ? { prompt_id: randomUUID() } : {});
  assert.deepEqual(f.events.filter(e => e.errorInfo === 'serverOverloaded'), []);
});

function capacityWorkspace(t) {
  const f = capacityFailure(t), host = { binaries: {}, close() {} }, w = new Workspace(host, f.dir);
  const s = Object.assign(f.r.record, { id: 'capacity-root', provider: 'claude', cwd: f.dir, messages: [], state: 'idle', owner: 'window', controlRevision: 0, memberRevision: 0 });
  f.r.host = host; f.r.ready = f.r.chatAvailable = true;
  w.sessions.set(s.id, s); w.runtimes.set(s.id, f.r); w.bind(s, f.r);
  const sent = []; f.r.send = async (text, tag, guard) => { assert.ok(guard()); f.r.claimFailedTurnInput(); sent.push(text); f.r.emit('submitted', tag); };
  t.after(() => w.close()); return { ...f, w, s, sent };
}
test('Claude overload uses the shared two-minute timer and a new continuation without a Codex RPC', async t => {
  const f = capacityWorkspace(t); f.fail(); f.stop();
  const scheduled = f.w.capacityStatus(f.s.id); assert.ok(scheduled.due - Date.now() > 119000);
  f.w.tickCapacity(scheduled.due - 1); assert.deepEqual(f.sent, []);
  f.w.tickCapacity(scheduled.due); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.sent, ['继续']); assert.equal(f.s.messages.filter(m => m.origin === 'capacity-recovery').length, 1);
  assert.ok(f.s.messages.some(m => m.name === 'NAW' && m.text.includes('第 1 次')));
  f.r.emit('interrupted', {}); assert.equal(f.w.capacityStatus(f.s.id), null);
});
for (const boundary of ['human-draft', 'input', 'rebind', 'gap', 'ambiguous', 'changed-transcript'])
test('Claude scheduled continuation yields to ' + boundary, async t => {
  const f = capacityWorkspace(t); f.fail(); f.stop(); const due = f.w.capacityStatus(f.s.id).due;
  if (boundary === 'human-draft') f.w.setDraft(f.s.id, 'My unsent task', 'window');
  if (boundary === 'input') f.r.hook({ hook_event_name: 'UserPromptSubmit', session_id: f.s.nativeId, prompt_id: randomUUID(), prompt: 'Different task' });
  if (boundary === 'rebind') f.r.bindRoot({ sessionId: f.s.nativeId, nativeBlocks: true, nativeAbort: true });
  if (boundary === 'gap') f.r.observeRootGap({ sessionId: f.s.nativeId, lease: f.r.rootLease, epoch: f.r.observationEpoch });
  if (boundary === 'ambiguous') f.fail({ incomplete: true, errorMessageId: undefined });
  if (boundary === 'changed-transcript') f.r.rootTurn.failedTranscript = f.file + '.different';
  f.w.tickCapacity(due); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.sent, []); assert.equal(f.w.capacityStatus(f.s.id), null);
});

test('repeated Claude overloads retain the shared 2/5/10-minute budget; another error cancels it', async t => {
  const f = capacityWorkspace(t); f.fail(); f.stop();
  const nextFailure = status => {
    const promptId = f.r.lastPromptId = randomUUID(), turnId = randomUUID(), errorMessageId = randomUUID();
    fs.writeFileSync(f.file, JSON.stringify({ ...f.row, uuid: errorMessageId, apiErrorStatus: status }) + '\n');
    f.block({ id: 'control:turn-start', kind: 'control', status: 'running', promptId, turnId });
    f.block({ id: 'turn:' + turnId, kind: 'turn', status: 'failed', turnId, failedRequest: true, errorMessageId });
    f.stop({ prompt_id: promptId });
  };
  for (let n = 0; n < 3; n++) {
    const r = f.w.capacityStatus(f.s.id); assert.equal(r.attempt, n);
    assert.ok(r.due - Date.now() > [120000, 300000, 600000][n] - 1000);
    f.w.tickCapacity(r.due); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.sent.length, n + 1); nextFailure(529);
  }
  assert.equal(f.w.capacityStatus(f.s.id).status, 'exhausted'); f.w.tickCapacity(Date.now() + 86400000); assert.equal(f.sent.length, 3);
  nextFailure(500); assert.equal(f.w.capacityStatus(f.s.id), null, 'A generic server error is not an overload');
});

test('native file persistence may follow failure events; the existing clock reads the same UUID then arms once', t => {
  const f = capacityWorkspace(t); fs.unlinkSync(f.file); f.fail(); f.stop();
  assert.equal(f.w.capacityStatus(f.s.id), null); assert.equal(f.r.rootTurn.pendingFailure, true);
  f.fail(); f.stop(); assert.equal(f.r.rootTurn.failureReads, 1, 'Duplicate events do not add reads');
  f.w.tickCapacity(); fs.writeFileSync(f.file, JSON.stringify(f.row) + '\n'); f.w.tickCapacity();
  assert.equal(f.w.capacityStatus(f.s.id).status, 'scheduled');
  assert.equal(f.r.rootTurn.pendingFailure, false); const due = f.w.capacityStatus(f.s.id).due;
  f.w.tickCapacity(); assert.equal(f.w.capacityStatus(f.s.id).due, due, 'No second schedule');
});
for (const boundary of ['draft-then-clear', 'claim', 'member-change', 'native-input', 'rebind'])
test('pending native error metadata cannot outlive ' + boundary, t => {
  const f = capacityWorkspace(t); fs.unlinkSync(f.file); f.fail(); f.stop();
  if (boundary === 'draft-then-clear') { f.w.setDraft(f.s.id, 'My text', 'window'); f.w.setDraft(f.s.id, '', 'window'); }
  if (boundary === 'claim') f.w.claim(f.s.id, 'other-window');
  if (boundary === 'member-change') f.w.join(f.s.id, true);
  if (boundary === 'native-input') f.r.hook({ hook_event_name: 'UserPromptSubmit', session_id: f.s.nativeId, prompt_id: randomUUID(), prompt: 'New task' });
  if (boundary === 'rebind') f.r.bindRoot({ sessionId: f.s.nativeId, nativeBlocks: true, nativeAbort: true });
  fs.writeFileSync(f.file, JSON.stringify(f.row) + '\n'); f.w.tickCapacity();
  assert.equal(f.w.capacityStatus(f.s.id), null); assert.equal(f.sent.length, 0);
});
test('missing native row gets at most five bounded reads, no delayed surprise rearming', t => {
  const f = capacityWorkspace(t); fs.unlinkSync(f.file); f.fail(); f.stop();
  for (let n = 0; n < 8; n++) f.w.tickCapacity();
  assert.equal(f.r.rootTurn.failureReads, 5); assert.equal(f.r.rootTurn.pendingFailure, false);
  fs.writeFileSync(f.file, JSON.stringify(f.row) + '\n'); f.w.tickCapacity(); f.stop(); f.fail();
  assert.equal(f.w.capacityStatus(f.s.id), null); assert.equal(f.sent.length, 0);
});


test('replayed native display content stays readable without acquiring a current message clock', () => {
  const { applyNativeBlock } = require('../native-blocks.cjs'), r = adapter();
  r.bindRoot({ sessionId: r.record.nativeId, nativeBlocks: true }); r.record.messages = [];
  const rows = []; r.on('nativeBlock', e => { rows.push(e); applyNativeBlock(r.record, e); });
  const base = { block: true, sessionId: r.record.nativeId, lease: r.rootLease, epoch: r.observationEpoch,
    kind: 'response', turnId: 'replayed-turn', status: 'complete', index: 0 };
  r.observeRoot({ ...base, sequence: 1, id: 'display:old', delta: 'Original old text', replayed: true });
  assert.equal(rows[0].replayed, true); assert.equal(r.record.messages[0].text, 'Original old text');
  assert.equal(r.record.messages[0].time, undefined);
  const before = Date.now();
  r.observeRoot({ ...base, sequence: 2, id: 'display:new', delta: 'Original live text' });
  assert.ok(r.record.messages[1].time >= before && r.record.messages[1].time <= Date.now());
});

// T-99. Rows as Claude Code 2.1.316 builds them: processBashCommand appends the
// input and then its output, and its append classifier files both on door `command`.
const shellRow = (value, extra = {}) => ({ uuid: randomUUID(), door: 'command', origin: { kind: 'composer' }, message: { type: 'user', role: 'user', content: [{ type: 'text', text: value }] }, ...extra });
test('native 2.1.316 shows a ! command, heads each turn with its inputs and keeps the turn clock', async () => {
  const ended = Date.UTC(2026, 10, 2, 5, 27), f = await mod({ version: '2.1.316', now: async () => ended }), rows = [], links = [];
  assert.equal(f.r.nativeTurnRecords, true);
  f.r.on('nativeBlock', row => rows.push(row)); f.r.on('nativeTurnTriggers', info => links.push(info));
  const input = shellRow('<bash-input>brew pin peekaboo</bash-input>');
  await f.append(input); await f.append(shellRow('<bash-stdout>pinned</bash-stdout><bash-stderr></bash-stderr>'));
  await f.invoke('turn.start', { turnId: 'shell-turn' });
  await f.invoke('turn.complete', { turnId: 'shell-turn', reason: 'answer', answer: '', durationMs: 30400 });
  const promptId = randomUUID();
  await f.invoke('classic.UserPromptSubmit', { session_id: f.r.record.nativeId, prompt_id: promptId, prompt: 'typed' });
  await f.invoke('turn.start', { turnId: 'typed-turn' });
  while (f.clock.length) await f.clock.shift()();
  const shell = rows.find(row => row.id === `tool:shell-${input.uuid}`);
  assert.deepEqual({ kind: shell.kind, title: shell.title, input: shell.input, text: shell.text, status: shell.status, toolKind: shell.toolKind, commandSource: shell.commandSource, turnId: shell.turnId },
    { kind: 'tool', title: 'Bash', input: 'brew pin peekaboo', text: 'pinned', status: 'complete', toolKind: 'commandExecution', commandSource: 'userShell', turnId: undefined });
  const turn = rows.find(row => row.id === 'turn:shell-turn');
  assert.equal(turn.nativeDurationMs, 30400); assert.equal(turn.nativeCompletedAt, ended);
  assert.deepEqual(links.map(l => [l.turnId, l.prompts, l.rows]), [['shell-turn', [], [`tool:shell-${input.uuid}`]], ['typed-turn', [promptId], []]]);
  const session = { nativeId: f.r.record.nativeId, messages: [] };
  for (const row of rows) require('../native-blocks.cjs').applyNativeBlock(session, row);
  const stored = session.messages.find(m => m.id.endsWith(`tool:shell-${input.uuid}`)), end = session.messages.find(m => m.id.endsWith('turn:shell-turn'));
  assert.equal(stored.commandSource, 'userShell'); assert.equal(stored.input, 'brew pin peekaboo');
  assert.equal(end.nativeDurationMs, 30400); assert.equal(end.nativeCompletedAt, ended);
});
test('the adapter accepts ! rows, triggers and turn clocks only as agreed and in their exact shape', () => {
  const plain = Object.create(Claude.prototype); EventEmitter.call(plain); plain.record = { nativeId: randomUUID() }; plain.terminal = { alive: true }; plain.submission = new SubmissionChannel();
  plain.bindRoot({ sessionId: plain.record.nativeId, nativeBlocks: true });
  const agreed = Object.create(Claude.prototype); EventEmitter.call(agreed); agreed.record = { nativeId: randomUUID() }; agreed.terminal = { alive: true }; agreed.submission = new SubmissionChannel();
  assert.equal(agreed.bindRoot({ sessionId: agreed.record.nativeId, nativeBlocks: true, nativeTurnRecords: true }).nativeTurnRecords, true);
  let sequence = 0;
  const frame = (r, row) => ({ block: true, sessionId: r.record.nativeId, lease: r.rootLease, epoch: r.observationEpoch, sequence: ++sequence, ...row });
  const shell = { id: `tool:shell-${randomUUID()}`, kind: 'tool', title: 'Bash', userShell: true, input: 'ls', text: 'a', status: 'complete' };
  const clock = { id: 'turn:t1', kind: 'turn', turnId: 't1', text: '', status: 'complete', nativeDurationMs: 5, nativeCompletedAt: 1 };
  const start = { id: 'control:turn-start', kind: 'control', turnId: 't2', status: 'running', triggers: { prompts: [randomUUID()], rows: [shell.id] } };
  for (const row of [shell, clock, start]) assert.throws(() => plain.observeRoot(frame(plain, row)), /Invalid native block/, 'not agreed: ' + row.id);
  const links = []; agreed.on('nativeTurnTriggers', info => links.push(info));
  for (const row of [shell, clock, start]) agreed.observeRoot(frame(agreed, row));
  assert.deepEqual(links, [{ nativeId: agreed.record.nativeId, turnId: 't2', prompts: start.triggers.prompts, rows: [shell.id] }]);
  for (const row of [
    { ...shell, id: 'tool:shell-not-a-uuid' }, { ...shell, id: 'tool:toolu_model' }, { ...shell, userShell: undefined }, { ...shell, turnId: 't1' },
    { ...shell, status: 'running' }, { ...shell, title: 'Read' }, { ...shell, input: undefined }, { ...shell, kind: 'response', index: 0, delta: '' },
    { ...shell, delta: ' appended' }, { ...shell, index: 0 }, { ...shell, promptId: 'p' }, { ...shell, displayTurnId: 'd' }, { ...shell, incomplete: false }, { ...shell, incomplete: 'yes' },
    { id: 'tool:toolu_model', kind: 'tool', title: 'Bash', userShell: true, input: 'ls', text: '', status: 'complete' },
    { ...clock, nativeDurationMs: -1 }, { ...clock, nativeDurationMs: 1.5 }, { ...clock, nativeCompletedAt: 9e15 },
    { id: 'tool:toolu_model', kind: 'tool', title: 'Bash', text: '', status: 'complete', nativeDurationMs: 5 },
    { ...start, triggers: { prompts: [], rows: [] } }, { ...start, triggers: { prompts: Array.from({ length: 9 }, () => randomUUID()), rows: [] } },
    { ...start, triggers: { prompts: ['not-an-id'], rows: [] } }, { ...start, triggers: { prompts: [], rows: ['tool:toolu_model'] } },
    { ...start, triggers: { prompts: [], rows: [], extra: [] } }, { ...start, triggers: [shell.id] },
    { id: 'control:input', kind: 'control', status: 'complete', triggers: start.triggers },
  ]) assert.throws(() => agreed.observeRoot(frame(agreed, row)), /Invalid native/, JSON.stringify(row).slice(0, 120));
  assert.equal(links.length, 1);
});
test('a prompt a settings hook blocked or stopped never heads the next turn (engine result shape)', async () => {
  for (const verdict of [{ block: 'blocked by a settings hook' }, { block: '' }, { preventContinuation: true, stopReason: 'stop' }]) {
    const f = await mod({ version: '2.1.316' }), links = [];
    f.r.on('nativeTurnTriggers', info => links.push(info));
    const blocked = randomUUID(), input = shellRow('<bash-input>ls</bash-input>');
    await f.invoke('classic.UserPromptSubmit', { session_id: f.r.record.nativeId, prompt_id: blocked, prompt: 'blocked text' }, async () => verdict);
    await f.append(input); await f.append(shellRow('<bash-stdout>a</bash-stdout><bash-stderr></bash-stderr>'));
    await f.invoke('turn.start', { turnId: 'shell-turn' });
    while (f.clock.length) await f.clock.shift()();
    assert.deepEqual(links.map(l => [l.prompts, l.rows]), [[[], [`tool:shell-${input.uuid}`]]], JSON.stringify(verdict));
  }
});
// T-130. Claude Code 2.1.316 draws a thinking block it classifies as narration through
// ui.render AssistantMessage with isSummary, keyed by the stored row's uuid.
const thinkingRow = (text, extra = {}) => ({ uuid: randomUUID(), door: 'response', origin: { kind: 'model', model: 'synthetic' },
  message: { type: 'assistant', role: 'assistant', content: [{ type: 'thinking', thinking: text, signature: 'opaque-signature' }] }, ...extra });
const toolUseRow = id => ({ uuid: randomUUID(), door: 'response', origin: { kind: 'model', model: 'synthetic' },
  message: { type: 'assistant', role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/fixture/a.txt' } }] } });
const engineDraw = async () => ({ type: 'Text', props: {}, children: [] }); engineDraw.origin = { plugin: 'engine', tier: 'core' };
const drawn = (requestId, text, props = {}) => ({ component: 'AssistantMessage', surface: 'terminal', requestId, props: { text, isFirstOfReply: true, isSummary: true, ...props } });
async function narrationFixture(options = {}) {
  const f = await mod({ version: '2.1.316', ...options }), rows = [];
  f.r.on('nativeBlock', row => rows.push(row));
  const flush = async () => { while (f.clock.length) await f.clock.shift()(); };
  const session = () => { const s = { nativeId: f.r.record.nativeId, messages: [] }; for (const row of rows) require('../native-blocks.cjs').applyNativeBlock(s, row); return s; };
  return { ...f, rows, flush, session, narrations: () => rows.filter(row => row.id.startsWith('narration:')) };
}
test('native 2.1.316 shows the explanation the terminal drew, in its place, as the turn\'s commentary', async () => {
  const f = await narrationFixture();
  assert.equal(f.r.nativeNarration, true);
  await f.invoke('turn.start', { turnId: 'work-turn' });
  const said = thinkingRow('stored text with <memory-tag>hidden</memory-tag>');
  await f.append(said);
  await f.append(toolUseRow('toolu_read'));          // the next block lands before the terminal's next frame
  await f.invoke('ui.render', drawn(said.uuid, '我先读一下这个文件。'), engineDraw);
  await f.invoke('ui.render', drawn(said.uuid, '我先读一下这个文件。'), engineDraw); // a redraw
  await f.flush();
  assert.deepEqual(f.narrations().map(row => [row.kind, row.phase, row.turnId, row.text, row.beforeId]),
    [['response', 'commentary', 'work-turn', '我先读一下这个文件。', 'tool:toolu_read']]);
  const s = f.session(), order = s.messages.map(m => m.id.split(':').slice(2).join(':'));
  assert.deepEqual(order, [`narration:${said.uuid}`, 'tool:toolu_read']);
  const row = s.messages[0];
  assert.deepEqual([row.role, row.kind, row.phase, row.turnId, row.text], ['assistant', 'response', 'commentary', 'work-turn', '我先读一下这个文件。']);
  // Drawn before the next row: no reordering needed.
  const later = thinkingRow('second');
  await f.append(later); await f.invoke('ui.render', drawn(later.uuid, '读完了，接着改。'), engineDraw); await f.append(toolUseRow('toolu_edit')); await f.flush();
  assert.equal(f.narrations().at(-1).beforeId, undefined);
  assert.deepEqual(f.session().messages.map(m => m.id.split(':').slice(2).join(':')), [`narration:${said.uuid}`, 'tool:toolu_read', `narration:${later.uuid}`, 'tool:toolu_edit']);
});
test('only the terminal\'s own narration drawing of a root row from a running turn is shown', async () => {
  const f = await narrationFixture();
  await f.invoke('turn.start', { turnId: 'earlier-turn' });
  await f.invoke('turn.complete', { turnId: 'earlier-turn', reason: 'answer', answer: '', durationMs: 5 });
  const idle = thinkingRow('after that turn ended');
  await f.append(idle);
  await f.invoke('turn.start', { turnId: 'work-turn' });
  const child = thinkingRow('child', { agentId: 'a1b2c3' }), plain = thinkingRow('real thinking'), own = thinkingRow('own');
  await f.append(child); await f.append(plain); await f.append(own);
  const pluginDraw = async () => ({}); pluginDraw.origin = { plugin: 'another-plugin', tier: 'user' };
  await f.invoke('ui.render', drawn(idle.uuid, 'idle text'), engineDraw);           // not appended during a root turn
  await f.invoke('ui.render', drawn(child.uuid, 'child text'), engineDraw);         // a subagent's row
  await f.invoke('ui.render', drawn(plain.uuid, 'not narration', { isSummary: undefined }), engineDraw); // drawn as plain text, not a summary
  await f.invoke('ui.render', drawn(randomUUID(), 'history remount'), engineDraw);  // never appended here
  await f.invoke('ui.render', drawn(own.uuid, 'not the engine'), pluginDraw);       // another plugin's call
  await f.invoke('ui.render', drawn(own.uuid, '   '), engineDraw);                  // nothing to show
  await f.flush();
  assert.deepEqual(f.narrations(), []);
  assert.equal(f.requests.some(row => row.kind === 'narration'), false, 'nothing was even sent');
});
test('an adapter that did not agree to narration gets no narration frames and no gap', async () => {
  const f = await narrationFixture({ requestHandler: async (url, options, body, r) => {
    if (!url.endsWith('/root-bind')) return;
    const result = await r.bindRoot({ ...body, nativeNarration: undefined });
    return { ok: true, text: JSON.stringify(result) };
  } });
  assert.notEqual(f.r.nativeNarration, true);
  await f.invoke('turn.start', { turnId: 'work-turn' });
  const said = thinkingRow('x'); await f.append(said);
  await f.invoke('ui.render', drawn(said.uuid, 'explanation'), engineDraw); await f.flush();
  assert.deepEqual(f.narrations(), []); assert.equal(f.requests.some(row => row.gap), false);
  assert.equal(f.requests.some(row => row.kind === 'narration'), false, 'the bridge sends nothing the adapter did not agree to');
});
test('the adapter accepts a narration frame only as agreed and in its exact shape', () => {
  const make = narration => { const r = Object.create(Claude.prototype); EventEmitter.call(r); r.record = { nativeId: randomUUID() }; r.terminal = { alive: true }; r.submission = new SubmissionChannel();
    r.bindRoot({ sessionId: r.record.nativeId, nativeBlocks: true, nativeNarration: narration }); return r; };
  const plain = make(undefined), agreed = make(true); let sequence = 0;
  const frame = (r, row) => ({ block: true, sessionId: r.record.nativeId, lease: r.rootLease, epoch: r.observationEpoch, sequence: ++sequence, ...row });
  const good = { id: `narration:${randomUUID()}`, kind: 'narration', turnId: 't1', text: 'explanation', status: 'complete', order: 1, beforeId: 'tool:toolu_x' };
  assert.throws(() => plain.observeRoot(frame(plain, good)), /Invalid native block/);
  const rows = []; agreed.on('nativeBlock', row => rows.push(row)); agreed.observeRoot(frame(agreed, good));
  assert.deepEqual(rows.map(r => [r.kind, r.phase, r.text, r.beforeId]), [['response', 'commentary', 'explanation', 'tool:toolu_x']]);
  for (const row of [{ ...good, id: 'narration:not-a-uuid' }, { ...good, text: ' ' }, { ...good, text: 1 }, { ...good, turnId: undefined }, { ...good, status: 'streaming' },
    { ...good, beforeId: 'narration:x' }, { ...good, beforeId: 'control:input' }, { ...good, order: undefined }, { ...good, order: -1 }, { ...good, order: 1.5 }, { ...good, index: 0 }, { ...good, delta: 'x' }, { ...good, promptId: 'p' },
    { ...good, kind: 'response', index: 0, delta: 'x' }, { id: 'display:x', kind: 'narration', turnId: 't1', text: 'x', status: 'complete' }])
    assert.throws(() => agreed.observeRoot(frame(agreed, row)), /Invalid native/, JSON.stringify(row).slice(0, 100));
  assert.equal(rows.length, 1);
});
test('an explanation drawn before its row is stored still appears, in its own place', async () => {
  const f = await narrationFixture();
  await f.invoke('turn.start', { turnId: 'work-turn' });
  const said = thinkingRow('stored');
  await f.invoke('ui.render', drawn(said.uuid, '先确认一下配置。'), engineDraw);   // the terminal drew it first
  await f.append(said); await f.append(toolUseRow('toolu_read')); await f.flush();
  assert.deepEqual(f.narrations().map(r => [r.text, r.beforeId]), [['先确认一下配置。', undefined]]);
  assert.deepEqual(f.session().messages.map(m => m.id.split(':').slice(2).join(':')), [`narration:${said.uuid}`, 'tool:toolu_read']);
  // A drawing held for a row that never comes in this turn is dropped at its end.
  const ghost = randomUUID();
  await f.invoke('ui.render', drawn(ghost, 'never stored'), engineDraw);
  await f.invoke('turn.complete', { turnId: 'work-turn', reason: 'answer', answer: '', durationMs: 5 });
  await f.invoke('turn.start', { turnId: 'next-turn' });
  await f.append({ ...thinkingRow('late'), uuid: ghost }); await f.flush();
  assert.equal(f.narrations().length, 1);
});
test('explanations drawn out of order keep the order their rows were stored in', async () => {
  for (const later of [true, false]) {
    const f = await narrationFixture();
    await f.invoke('turn.start', { turnId: 'work-turn' });
    const a = thinkingRow('a'), b = thinkingRow('b');
    await f.append(a); await f.append(b);
    if (later) await f.append(toolUseRow('toolu_next'));     // both drawings arrive after a later row
    await f.invoke('ui.render', drawn(b.uuid, '第二段'), engineDraw);
    await f.invoke('ui.render', drawn(a.uuid, '第一段'), engineDraw);
    await f.flush();
    const order = f.session().messages.map(m => m.id.split(':').slice(2).join(':'));
    assert.deepEqual(order, [`narration:${a.uuid}`, `narration:${b.uuid}`, ...(later ? ['tool:toolu_next'] : [])], String(later));
  }
});
test('only the terminal\'s drawing counts, and only explanation rows can be placed early', async () => {
  const f = await narrationFixture();
  await f.invoke('turn.start', { turnId: 'work-turn' });
  const said = thinkingRow('x'); await f.append(said);
  await f.invoke('ui.render', { ...drawn(said.uuid, 'a remote surface'), surface: 'desktop' }, engineDraw); await f.flush();
  assert.deepEqual(f.narrations(), []);
  const s = { nativeId: 'N', messages: [{ id: 'native:N:tool:a', role: 'tool', kind: 'tool', nativeId: 'N' }] };
  require('../native-blocks.cjs').applyNativeBlock(s, { id: 'display:x', nativeId: 'N', kind: 'response', turnId: 't', text: 'reply', status: 'complete', beforeId: 'tool:a', index: 0 });
  assert.deepEqual(s.messages.map(m => m.id), ['native:N:tool:a', 'native:N:display:x']);
});
