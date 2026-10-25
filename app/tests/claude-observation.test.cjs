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
async function mod({ version = '2.1.306', fetchObservation, runtime, legacy = false, requestHandler, promptSubmit, modelReader, toolReader, usageReader, turnAbort } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../claude-bridge/hooks/register.js'), 'utf8').replace('const legacyOnly = false;', `const legacyOnly = ${legacy};`);
  const { register, testObserveModel, testObserveUsage } = await import('data:text/javascript;base64,' + Buffer.from(source + '\nexport { observeModel as testObserveModel, observeUsage as testObserveUsage };\n//' + randomUUID()).toString('base64'));
  const r = runtime || adapter(), clock = [], hooks = new Map(), requests = [];
  let native = r.record.nativeId, token = 'a'.repeat(64);
  if (legacy) r.retainedReader = true;
  const $ = { session: { id: async () => native, version: async () => ({ version }), ...(modelReader ? { model: modelReader } : {}), ...(usageReader ? { usage: usageReader } : {}) },
    env: { get: async key => key === 'NAW_SUBMIT_SOCKET' ? (legacy ? undefined : '/fixture/socket') : key === 'NAW_HOOK_SOCKET' ? '/fixture/hooks.sock' : 'fixture-token' },
    fs: { read: async () => JSON.stringify({ sessionId: native, socketPath: '/fixture/gui-submit.sock', token, compat: true, nativeBlocks: true }) },
    clock: { after: (delay, fn) => { fn.delay = delay; clock.push(fn); return { cancel() { const i = clock.indexOf(fn); if (i >= 0) clock.splice(i, 1); } }; } },
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

for (const version of ['2.1.308', '2.1.309', '2.1.310', '2.1.311']) test('native queue/display compatibility remains version scoped: ' + version, async () => {
  const f = await mod({ version });
  assert.equal(f.r.nativeQueue === true, version !== '2.1.311');
  assert.equal(f.r.nativeBlocks === true, version !== '2.1.311');
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
  const unknown = await mod({ version: '2.1.311' });
  unknown.setModelReader(async () => { throw Error('Unknown version must not be queried'); });
  // A valid to_model would publish on a supported version; an unknown one must stay silent.
  await unknown.invoke('classic.PostModelSwitch', { session_id: unknown.r.record.nativeId, to_model: 'claude-sonnet-test' });
  await new Promise(r => setImmediate(r)); while (unknown.clock.length) await unknown.clock.shift()();
  assert.equal(unknown.requests.length, 0);
});


test('native model metadata on 2.1.310 updates the model block for a valid switch', async () => {
  const f = await mod({ version: '2.1.310' }), models = [];
  f.r.on('model', value => models.push(value)); f.setModelReader(async () => 'claude-sonnet-test');
  await f.invoke('classic.PostModelSwitch', { session_id: f.r.record.nativeId, to_model: 'claude-sonnet-test' });
  await new Promise(r => setImmediate(r)); await f.clock.shift()();
  assert.deepEqual(models, ['claude-sonnet-test']);
  assert.equal(f.requests[0].id, 'control:model'); assert.equal(f.requests[0].model, 'claude-sonnet-test');
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
  const append = () => f.append(response('API Error: PRIVATE RAW', { origin: { kind: 'model', model: '<synthetic>' } }), async e =>
    ({ uuid: e.uuid, message: { type: 'assistant', content: [{ type: 'text', text: 'SAFE ERROR' }] } }));
  const failure = () => f.invoke('classic.StopFailure', { session_id: f.r.record.nativeId, prompt_id: prompt,
    error_details: 'PRIVATE DETAIL', last_assistant_message: 'PRIVATE LAST ANSWER' });
  const end = () => f.invoke('turn.complete', { turnId: turn, reason: 'error', answer: '', durationMs: 100 });
  for (const fn of order === 'append-first' ? [append, failure, end] : order === 'failure-first' ? [failure, end, append] : [end, append, failure]) await fn();
  while (f.clock.length) await f.clock.shift()();
  const failures = rows.filter(row => row.kind === 'turn');
  assert.match(failures.at(-1).text, /SAFE ERROR/); assert.equal(failures.at(-1).status, 'failed');
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
  const unknown = await mod({ version: '2.1.311' });
  let unknownReads = 0; unknown.setUsageReader(() => { unknownReads++; throw Error('Unknown version must not read'); }); await unknown.readUsage();
  assert.equal(unknownReads, 0, 'An unknown native version is never asked for usage');
});

test('usage metadata on 2.1.310 is read after turn completion and missing values stay unknown', async () => {
  const f = await mod({ version: '2.1.310' }), usage = []; let reads = 0;
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

test('held usage metadata never blocks binding/input and coalesces reads', async () => {
  let reads = 0, release;
  const f = await mod({ version: '2.1.309', usageReader: () => { reads++; return new Promise(r => { release = r; }); } });
  assert.ok(f.r.rootLease); assert.equal(typeof f.poll, 'function');
  await f.readUsage(); await f.readUsage(); assert.equal(reads, 1);
  f.setUsageReader(async () => { reads++; return { context: { window: 200000 } }; });
  release({ context: { window: 200000, tokens: 123 } }); await new Promise(r => setImmediate(r));
  assert.equal(reads, 2, 'Repeated observation requests coalesce to one fresh read');
});
