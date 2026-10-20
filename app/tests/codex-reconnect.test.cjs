const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Codex } = require('../adapters.cjs'), { Workspace } = require('../workspace.cjs');
function fixture(t, rpc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-resubscribe-')), calls = [];
  const host = { binaries: {}, close() {}, codexTargets: new Map(), codexProcess: { pid: 987654 }, rpc: { call: async (method, params) => { calls.push({ method, params }); return rpc(method, params, r); } } };
  const w = new Workspace(host, dir);
  const s = { id: 'record', nativeId: 'same-thread', provider: 'codex', cwd: dir, state: 'disconnected', view: 'chat', owner: 'old-owner', messages: [{ id: 'answer', role: 'assistant', text: 'partial', status: 'streaming' }], fleet: [], controlRevision: 4, memberRevision: 2, roomId: 'shared', model: 'original-model' };
  const r = new Codex(s, host); r.stopped = true; r.hasHistory = true; r.liveMessageItems.add('answer');
  r.pending = { tag: 'old-tag', turnId: 'old-turn' }; r.turnId = 'old-turn';
  w.sessions.set(s.id, s); w.runtimes.set(s.id, r); w.bind(s, r); w.setDraft(s.id, '私有草稿');
  t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { w, s, r, host, calls };
}
const idle = (_m, _p, r) => ({ thread: { id: r.record.nativeId, status: { type: 'idle' } } });
const history = { data: [{ turnId: 'old-turn', item: { id: 'answer', type: 'agentMessage', text: 'complete historical answer' } }] };

test('disconnected owned runtime resumes the exact native identity, reconciles history, and preserves private draft and membership', async t => {
  const f = fixture(t, (m,p,r) => m === 'thread/resume' ? idle(m,p,r) : history);
  assert.equal(f.w.snapshot().sessions[0].terminalAvailable, false);
  await f.w.resume(f.s.id, 'new-owner');
  assert.equal(f.w.runtime(f.s.id), f.r); assert.equal(f.s.nativeId, 'same-thread');
  assert.equal(f.s.state, 'idle'); assert.equal(f.s.owner, 'new-owner'); assert.equal(f.s.model, 'original-model');
  assert.equal(f.s.messages.length, 1); assert.equal(f.s.messages[0].text, 'complete historical answer');
  assert.equal(f.s.messages[0].status, 'complete'); assert.equal(f.w.drafts.get(f.s.id), '私有草稿');
  assert.equal(f.s.roomId, 'shared'); assert.equal(f.s.memberRevision, 2); assert.equal(f.s.controlRevision, 5);
  assert.equal(f.r.pending, null); assert.equal(f.r.turnId, null); assert.equal(f.r.chatAvailable, true);
  assert.deepEqual(f.calls, [{ method: 'thread/resume', params: { threadId: 'same-thread', excludeTurns: true } }, { method: 'thread/items/list', params: { threadId: 'same-thread', limit: 100, sortDirection: 'asc' } }]);
  assert.equal(f.w.versions.dispatches, 0);
});
for (const mode of ['approval', 'working', 'closed', 'failure', 'mismatched']) test('reconnect respects newer native state and retains retry without inventing a session: '+mode, async t => {
  const f = fixture(t, (m,p,r) => {
    if (m !== 'thread/resume') return history;
    if (mode === 'approval') r.event({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'same-thread' } });
    if (mode === 'working') r.event({ method: 'turn/started', params: { turn: { id: 'new-live-turn' } } });
    if (mode === 'closed') r.event({ method: 'thread/closed' });
    if (mode === 'failure') throw Error('RPC unconfirmed');
    if (mode === 'mismatched') return { thread: { id: 'another-thread' } };
    return idle(m,p,r);
  });
  if (['closed','failure','mismatched'].includes(mode)) await assert.rejects(f.w.resume(f.s.id, 'owner'));
  else await f.w.resume(f.s.id, 'owner');
  assert.equal(f.s.state, mode === 'closed' ? 'ended' : ['failure','mismatched'].includes(mode) ? 'disconnected' : mode);
  assert.equal(f.s.nativeId, 'same-thread'); assert.equal(f.w.versions.dispatches, 0);
  if (mode === 'working') assert.equal(f.r.turnId, 'new-live-turn');
  if (mode === 'approval') assert.equal(f.s.approval.requestId, 7);
  if (mode === 'closed') assert.equal(f.w.runtimes.has(f.s.id), false);
  else assert.equal(f.w.runtime(f.s.id), f.r);
});
test('two resume clicks cannot create duplicate subscriptions and a concurrent stop wins', async t => {
  let release;
  const f = fixture(t, (m,p,r) => m === 'thread/resume' ? new Promise(resolve => { release = () => resolve(idle(m,p,r)); }) : { status: 'unsubscribed' });
  const pending = f.w.resume(f.s.id, 'owner');
  const rejected = assert.rejects(pending);
  await assert.rejects(f.w.resume(f.s.id, 'other-owner'), /仍有运行连接/);
  await f.w.stop(f.s.id); release(); await rejected;
  assert.equal(f.s.state, 'disconnected'); assert.equal(f.r.chatAvailable, false);
  assert.equal(f.calls.filter(x => x.method === 'thread/resume').length, 1);
  assert.equal(f.calls.some(x => x.method === 'turn/start'), false);
});
test('history read failure leaves a retryable connection without overwriting old messages', async t => {
  let fail = true;
  const f = fixture(t, (m,p,r) => { if (m === 'thread/resume') return idle(m,p,r); if (fail) throw Error('History unavailable'); return history; });
  await assert.rejects(f.w.resume(f.s.id, 'owner'), /History unavailable/);
  assert.equal(f.s.state, 'disconnected'); assert.equal(f.s.messages[0].text, 'partial');
  fail = false; await f.w.resume(f.s.id, 'owner');
  assert.equal(f.s.state, 'idle'); assert.equal(f.s.messages[0].text, 'complete historical answer');
});
for (const mode of ['idle', 'unloaded', 'existing-history']) test('an empty native thread needs no manufactured model turn: '+mode, async t => {
  const f = fixture(t, (m,p,r) => {
    if (m === 'thread/resume') throw Object.assign(Error('No rollout yet'), { nativeMissingHistory: true });
    if (m === 'thread/read') return { thread: { id: r.record.nativeId, status: { type: mode === 'idle' ? 'idle' : 'notLoaded' }, preview: '' } };
    throw Error('Unexpected RPC '+m);
  });
  f.r.hasHistory = false; if (mode !== 'existing-history') f.s.messages = [];
  if (mode === 'idle') { await f.w.resume(f.s.id,'owner'); assert.equal(f.r.needsSubscription, true); assert.equal(f.r.chatAvailable, true); assert.equal(f.s.state,'idle'); }
  else { await assert.rejects(f.w.resume(f.s.id,'owner')); assert.equal(f.s.state,'disconnected'); }
  assert.equal(f.calls.some(x => x.method === 'turn/start'), false);
});
for (const failure of [false,true]) test('first real input after empty reconnect is sent once; later observation failure cannot reject the accepted send: '+failure, async t => {
  const f = fixture(t, (m,p,r) => {
    if (m === 'turn/start') return { turn: { id: 'accepted-turn' } };
    if (m === 'thread/resume') { if (failure) throw Error('Lost observer'); return idle(m,p,r); }
    if (m === 'thread/turns/list') return { data: [{ id: 'accepted-turn', status: 'completed', items: [{ id: 'final', type: 'agentMessage', text: 'finished' }] }] };
    throw Error('Unexpected RPC '+m);
  });
  f.r.stopped = false; f.r.pending = null; f.r.turnId = null; f.r.needsSubscription = true; f.r.chatAvailable = true;
  const completed = []; f.r.on('complete', x => completed.push(x));
  await f.r.send('one explicit message','explicit-tag',()=>true);
  assert.equal(f.calls.filter(x => x.method === 'turn/start').length, 1);
  if (failure) { assert.equal(f.s.state,'error'); assert.match(f.s.activity,/已被原生接受/); }
  else { assert.equal(f.s.state,'idle'); assert.equal(completed[0].tag,'explicit-tag'); assert.equal(completed[0].text,'finished'); }
});
for (const late of ['success','failure','history']) test('old reconnect completion cannot damage a later connection after stop: '+late, async t => {
  let release, reject, count = 0, holdHistory = late === 'history';
  const f = fixture(t,(m,p,r)=> {
    if (m === 'thread/resume') {
      count++;
      if (count === 1 && late !== 'history') return new Promise((yes,no)=>{release=()=>yes(idle(m,p,r));reject=()=>no(Error('Old request failed'))});
      return idle(m,p,r);
    }
    if (m === 'thread/items/list') {
      if (holdHistory) {holdHistory=false;return new Promise(yes=>{release=()=>yes({data:[{item:{id:'stale-history',type:'agentMessage',text:'must not replace'}}]})})}
      return history;
    }
    if (m === 'thread/unsubscribe') return {status:'unsubscribed'};
    throw Error('Unexpected RPC '+m);
  });
  const a=f.w.resume(f.s.id,'first-owner'), rejected=assert.rejects(a);
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  await f.w.stop(f.s.id);await f.w.resume(f.s.id,'second-owner');
  const good=f.w.snapshot();
  if(late==='failure')reject();else release();await rejected;
  assert.deepEqual(f.w.snapshot(),good);assert.equal(f.r.chatAvailable,true);assert.equal(f.r.stopped,false);
  assert.equal(f.s.state,'idle');assert.equal(f.s.owner,'second-owner');assert.equal(f.s.recovering,false);
});
for (const kind of ['approval','working']) test('late empty-thread read cannot hide newer native '+kind,async t=>{
 const f=fixture(t,(m,p,r)=>{
  if(m==='thread/resume')throw Object.assign(Error('No rollout yet'),{nativeMissingHistory:true});
  if(m==='thread/read'){
   if(kind==='approval')r.event({id:9,method:'item/commandExecution/requestApproval',params:{threadId:'same-thread'}});
   else r.event({method:'turn/started',params:{turn:{id:'current'}}});
   return idle(m,p,r);
  }
  throw Error('Unexpected RPC '+m);
 });
 f.r.hasHistory=false;f.s.messages=[];await f.w.resume(f.s.id,'owner');
 assert.equal(f.s.state,kind);assert.equal(f.r.chatAvailable,true);assert.equal(f.w.versions.dispatches,0);
});
test('permission request before the first real turn ACK remains actionable after observer subscription',async t=>{
 const f=fixture(t,(m,p,r)=>{
  if(m==='turn/start') {r.event({id:24,method:'item/commandExecution/requestApproval',params:{threadId:'same-thread'}});return {turn:{id:'accepted'}};}
  if(m==='thread/resume')return idle(m,p,r);
  if(m==='thread/turns/list')return {data:[]};
  throw Error('Unexpected RPC '+m);
 });
 f.r.stopped=false;f.r.pending=null;f.r.turnId=null;f.r.needsSubscription=true;f.r.chatAvailable=true;
 await f.r.send('one human input','tag',()=>true);
 assert.equal(f.s.state,'approval');assert.equal(f.s.approval.requestId,24);assert.equal(f.r.pending.turnId,'accepted');
});
test('old send rejection cannot clear the new pending task or restore its draft after reconnect',async t=>{
 let rejectOld,releaseNew,turns=0;
 const f=fixture(t,(m,p,r)=>{
  if(m==='turn/start')return new Promise((resolve,reject)=>{if(++turns===1)rejectOld=()=>reject(Error('Old send uncertain'));else releaseNew=()=>resolve({turn:{id:'new-turn'}})});
  if(m==='thread/resume')return idle(m,p,r);
  if(m==='thread/items/list')return history;
  if(m==='thread/unsubscribe')return {status:'unsubscribed'};
  throw Error('Unexpected RPC '+m);
 });
 f.r.stopped=false;f.r.pending=null;f.r.turnId=null;f.r.chatAvailable=true;f.s.state='idle';
 f.w.setDraft(f.s.id,'old draft');
 const old=f.w.send(f.s.id,'old draft','old-owner'),rejected=assert.rejects(old);
 await f.w.stop(f.s.id);await f.w.resume(f.s.id,'new-owner');
 f.w.setDraft(f.s.id,'new draft');const next=f.w.send(f.s.id,'new draft','new-owner');
 const newTag=f.s.pendingTag;f.w.room.run={status:'running',id:'new-run',ids:[],deadline:Date.now()+60000};
 rejectOld();await rejected;
 assert.equal(f.s.pendingTag,newTag);assert.equal(f.w.drafts.get(f.s.id),'');assert.equal(f.w.room.run.status,'running');
 assert.equal(f.s.messages.find(m=>m.text==='old draft').status,'unconfirmed');
 releaseNew();await next;assert.equal(f.r.pending.turnId,'new-turn');
});
for(const kind of ['approval','working'])test('native state before empty resume rejection is not overwritten by read idle: '+kind,async t=>{
 const f=fixture(t,(m,p,r)=>{
  if(m==='thread/resume'){
   if(kind==='approval')r.event({id:31,method:'item/commandExecution/requestApproval',params:{threadId:'same-thread'}});
   else r.event({method:'turn/started',params:{turn:{id:'active'}}});
   throw Object.assign(Error('No rollout yet'),{nativeMissingHistory:true});
  }
  if(m==='thread/read')return idle(m,p,r);
  throw Error('Unexpected RPC '+m);
 });
 f.r.hasHistory=false;f.s.messages=[];await f.w.resume(f.s.id,'owner');assert.equal(f.s.state,kind);
});
test('closed adapter refuses first-turn observation before sending a native request',async t=>{
 const f=fixture(t,()=>{throw Error('Unexpected native request')});
 await assert.rejects(f.r.observeAcceptedTurn('old-turn'),/连接已变化/);assert.deepEqual(f.calls,[]);
});
