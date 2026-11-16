// A prompt typed during a turn waits in native's queue. When the person takes it back unsent (↑ to edit it, then
// delete or change it; or cancelling), the native terminal stops showing it, and so does the conversation
// (the person, 11-15: 「这个应该是个 bug」, an edited queued prompt showed twice). The journal rows here are
// hand-written in the shape native 2.1.323 writes (measured 11-15 in a test session), with made-up text.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events'), { randomUUID } = require('node:crypto');
const { Claude, promptTextTag } = require('../adapters.cjs'), { Workspace } = require('../workspace.cjs');
const { SubmissionChannel } = require('../claude-submit.cjs');

function fixture(t, { journal = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-claude-queue-withdrawn-')), r = Object.create(Claude.prototype); EventEmitter.call(r);
  const w = new Workspace({ binaries: {}, close() {} }, dir), nativeId = randomUUID();
  r.record = { id: 'session', nativeId, provider: 'claude', messages: [], state: 'idle', owner: 'window', controlRevision: 0, memberRevision: 0, connectionRevision: 0 };
  r.terminal = { alive: true }; r.submission = new SubmissionChannel(); r.ready = true;
  w.sessions.set(r.record.id, r.record); w.runtimes.set(r.record.id, r); w.bind(r.record, r);
  t.after(() => { r.cancelQueueRefresh(); try { w.close(); } finally { fs.rmSync(dir, { recursive: true, force: true }); } });
  r.bindRoot({ sessionId: nativeId, nativeBlocks: true, nativeTurnRecords: true, nativeMedia: true });
  const transcript = path.join(dir, `${nativeId}.jsonl`);
  const write = row => fs.appendFileSync(transcript, JSON.stringify({ timestamp: new Date().toISOString(), sessionId: nativeId, ...row }) + '\n');
  const queue = (operation, content, extra = {}) => write({ type: 'queue-operation', operation, ...(content === undefined ? {} : { content }), ...extra });
  const hook = (name, extra = {}) => r.hook({ hook_event_name: name, session_id: nativeId, ...(journal ? { transcript_path: transcript } : {}), ...extra });
  // Native records the prompt's own row after its hook; a prompt typed during the turn only joins the queue.
  const prompt = (promptId, text) => { hook('UserPromptSubmit', { prompt_id: promptId, prompt: text }); write({ type: 'user', promptId, isSidechain: false, uuid: randomUUID(), message: { role: 'user', content: text } }); };
  const typed = (promptId, text) => hook('UserPromptSubmit', { prompt_id: promptId, prompt: text });
  const stop = promptId => hook('Stop', { prompt_id: promptId, last_assistant_message: 'reply', background_tasks: [], session_crons: [], stop_hook_active: false });
  const shown = () => w.sessions.get('session').messages.filter(m => m.role === 'user').map(m => m.text);
  return { r, w, nativeId, write, queue, prompt, typed, stop, shown };
}

test('a queued prompt edited with ↑ shows only as it was sent again', t => {
  const f = fixture(t), first = randomUUID();
  f.prompt(first, '开始第一件');
  f.typed(first, '方案 A'); f.queue('enqueue', '方案 A');
  f.queue('popAll', '方案 A'); // ↑ moves it into the editor; the person changes A to B and sends it
  f.queue('enqueue', '方案 B'); f.typed(first, '方案 B');
  assert.deepEqual(f.shown(), ['开始第一件', '方案 B']);
  f.queue('remove', '方案 B', { reason: 'absorbed_mid_turn' }); f.stop(first);
  assert.deepEqual(f.shown(), ['开始第一件', '方案 B']);
});
test('PF06: two identical prompts queued in one turn remain two distinct conversation rows', t => {
  const f=fixture(t),first=randomUUID();
  f.prompt(first,'开始');
  f.typed(first,'同一条指令');f.queue('enqueue','同一条指令');
  f.typed(first,'同一条指令');f.queue('enqueue','同一条指令');
  f.stop(first);
  assert.deepEqual(f.shown(),['开始','同一条指令','同一条指令']);
  const rows=f.w.get('session').messages.filter(m=>m.role==='user'&&m.text==='同一条指令');
  assert.equal(new Set(rows.map(m=>m.id)).size,2,'Queue occurrences have separate, stable identities');
});
test('PF06: the enqueue written after its hook updates the conversation before the turn stops',async t=>{
  const f=fixture(t),first=randomUUID();f.prompt(first,'开始');
  f.typed(first,'重复');f.queue('enqueue','重复');f.typed(first,'重复');f.queue('enqueue','重复');
  const control=f.w.get('session').controlRevision;
  await new Promise(resolve=>{const watch=event=>{if(event.id.includes('-e')){f.r.off('nativeQueuedInput',watch);resolve();}};f.r.on('nativeQueuedInput',watch);t.after(()=>f.r.off('nativeQueuedInput',watch));});
  assert.deepEqual(f.shown(),['开始','重复','重复']);
  const ids=f.w.get('session').messages.map(m=>m.id);
  for(let i=0;i<5;i++)f.r.withdrawQueued();
  assert.deepEqual(f.w.get('session').messages.map(m=>m.id),ids,'Repeated journal observations are idempotent');
  assert.equal(f.w.get('session').controlRevision,control,'Display reconciliation creates no new human-control event');
});
test('PF06: editing one of two equal queued prompts preserves the other row and its identity',t=>{
  const f=fixture(t),first=randomUUID();f.prompt(first,'开始');
  for(let i=0;i<2;i++){f.typed(first,'方案 A');f.queue('enqueue','方案 A');}f.r.withdrawQueued();
  const before=f.w.get('session').messages.filter(m=>m.text==='方案 A');assert.equal(before.length,2);
  f.queue('popOne','方案 A');f.typed(first,'方案 B');f.queue('enqueue','方案 B');f.stop(first);
  assert.deepEqual(f.shown(),['开始','方案 A','方案 B']);
  const remaining=f.w.get('session').messages.filter(m=>m.text==='方案 A');assert.equal(remaining.length,1);
  assert.ok(before.includes(remaining[0]),'The other entry is retained, not replaced with a new synthetic row');
  f.r.withdrawQueued();assert.deepEqual(f.shown(),['开始','方案 A','方案 B']);
});
test('PF06: a consumed equal prompt stays while only the waiting copy is withdrawn',t=>{
  const f=fixture(t),first=randomUUID();f.prompt(first,'开始');
  for(let i=0;i<2;i++){f.typed(first,'重复');f.queue('enqueue','重复');}f.r.withdrawQueued();
  const before=f.w.get('session').messages.filter(m=>m.text==='重复');assert.equal(before.length,2);
  before[0].turnId='consumed-turn';
  f.queue('remove','重复',{reason:'absorbed_mid_turn'});f.queue('popOne','重复');f.stop(first);
  assert.deepEqual(f.shown(),['开始','重复']);assert.ok(f.w.get('session').messages.includes(before[0]));
  assert.equal(f.w.get('session').messages.includes(before[1]),false);
});
test('PF06: taking back both equal entries removes both, with no skipped array element',t=>{
  const f=fixture(t),first=randomUUID();f.prompt(first,'开始');
  for(let i=0;i<2;i++){f.typed(first,'重复');f.queue('enqueue','重复');}f.r.withdrawQueued();
  assert.deepEqual(f.shown(),['开始','重复','重复']);
  f.queue('popOne','重复');f.queue('popOne','重复');f.stop(first);assert.deepEqual(f.shown(),['开始']);
});
test('PF06: queued copies equal to the original turn input do not collapse into that input',t=>{
  const f=fixture(t),first=randomUUID();f.prompt(first,'相同');
  for(let i=0;i<2;i++){f.typed(first,'相同');f.queue('enqueue','相同');}f.stop(first);
  assert.deepEqual(f.shown(),['相同','相同','相同']);
});
test('PF06: an old text-only turn trigger cannot select a row among equal queue occurrences',t=>{
  const f=fixture(t),first=randomUUID();f.prompt(first,'开始');
  for(let i=0;i<2;i++){f.typed(first,'重复');f.queue('enqueue','重复');}f.r.withdrawQueued();
  f.r.observeBlock({sessionId:f.nativeId,lease:f.r.rootLease,epoch:f.r.observationEpoch,sequence:1,block:true,
    id:'control:turn-start',kind:'control',turnId:'later-turn',promptId:first,status:'running',triggers:{prompts:[`${first}-q${promptTextTag('重复')}`],rows:[]}});
  assert.equal(f.w.get('session').messages.some(m=>m.text==='重复'&&m.turnId),false);
});
test('PF06: a display projection from another native session cannot add an equal entry',t=>{
  const f=fixture(t),first=randomUUID();f.prompt(first,'开始');f.typed(first,'重复');
  const id=`claude-prompt-${first}-q${promptTextTag('重复')}`;
  f.r.emit('nativeQueuedInput',{nativeId:randomUUID(),baseId:id,id:id+'-e123',text:'重复'});
  assert.deepEqual(f.shown(),['开始','重复']);
});
test('PF06: replacement native context cannot reuse an old queue window to add or withdraw rows',t=>{
  const f=fixture(t),first=randomUUID();f.prompt(first,'开始');f.typed(first,'重复');f.queue('enqueue','重复');
  const old=f.w.get('session').messages.map(m=>m.id);f.r.record.nativeId=randomUUID();f.r.withdrawQueued();
  assert.deepEqual(f.w.get('session').messages.map(m=>m.id),old);assert.equal(f.r.queuedRows.size,0);
});
test('PF06: equal text in a later turn is not counted again in an older queue window',t=>{
  const f=fixture(t),first=randomUUID(),second=randomUUID();f.prompt(first,'第一轮');
  f.typed(first,'重复');f.queue('enqueue','重复');f.queue('remove','重复',{reason:'absorbed_mid_turn'});f.stop(first);
  f.prompt(second,'第二轮');f.typed(second,'重复');f.queue('enqueue','重复');f.stop(second);
  assert.deepEqual(f.shown(),['第一轮','重复','第二轮','重复']);
  const ids=f.w.get('session').messages.map(m=>m.id);f.r.withdrawQueued();assert.deepEqual(f.w.get('session').messages.map(m=>m.id),ids);
});
test('PF06: a peer-sourced equal enqueue is not projected as an extra human copy',t=>{
  const f=fixture(t),first=randomUUID();f.prompt(first,'开始');f.typed(first,'重复');f.queue('enqueue','重复');
  f.r.hook({hook_event_name:'UserPromptSubmit',session_id:f.nativeId,prompt_id:first,prompt:'重复',source:'naw-peer'});
  f.queue('enqueue','重复');f.stop(first);
  assert.deepEqual(f.shown(),['开始','重复']);
});
test('PF06 B1: human then peer then human preserves mixed-origin evidence',t=>{
  const f=fixture(t),first=randomUUID();f.prompt(first,'开始');
  f.typed(first,'继续');f.queue('enqueue','继续');
  f.r.hook({hook_event_name:'UserPromptSubmit',session_id:f.nativeId,prompt_id:first,prompt:'继续',source:'naw-peer'});f.queue('enqueue','继续');
  f.typed(first,'继续');f.queue('enqueue','继续');f.stop(first);
  assert.deepEqual(f.shown(),['开始','继续','继续'],'The peer enqueue is not another human entry');
});
test('PF06 B1: root text then peer then human does not relabel the peer enqueue',t=>{
  const f=fixture(t),first=randomUUID();f.prompt(first,'继续');
  f.r.hook({hook_event_name:'UserPromptSubmit',session_id:f.nativeId,prompt_id:first,prompt:'继续',source:'naw-peer'});f.queue('enqueue','继续');
  f.typed(first,'继续');f.queue('enqueue','继续');f.stop(first);
  assert.deepEqual(f.shown(),['继续','继续'],'Only the root and one proven human queued input are shown');
});
test('PF06 T1: an equal-millisecond input stays before its subsequent reply',t=>{
  const now=Date.now();t.mock.method(Date,'now',()=>now);const f=fixture(t),first=randomUUID();f.prompt(first,'开始');
  f.typed(first,'重复');f.queue('enqueue','重复',{timestamp:new Date(now).toISOString()});
  f.typed(first,'重复');f.queue('enqueue','重复',{timestamp:new Date(now).toISOString()});
  f.w.get('session').messages.push({id:'reply',role:'assistant',text:'原生回复',time:now});f.r.withdrawQueued();
  assert.deepEqual(f.w.get('session').messages.map(m=>m.text),['开始','重复','重复','原生回复']);
});
test('PF06 B1: native task notifications reuse the existing machine-origin classification',t=>{
  const f=fixture(t),first=randomUUID(),text='<task-notification><task-id>fixture-task</task-id><summary>继续</summary></task-notification>';
  f.prompt(first,'开始');f.r.backgroundTaskIds=new Set(['fixture-task']);
  const input=source=>f.r.hook({hook_event_name:'UserPromptSubmit',session_id:f.nativeId,prompt_id:first,prompt:text,...(source?{source}:{})});
  input('user');f.queue('enqueue',text);input();f.queue('enqueue',text);input('user');f.queue('enqueue',text);f.stop(first);
  assert.deepEqual(f.shown(),['开始',text,text],'The known untagged task notification cannot become a third human copy');
});
test('PF06 B1: a proven human copy does not inherit the preceding peer row labels',t=>{
  const f=fixture(t),first=randomUUID();f.prompt(first,'开始');
  f.r.hook({hook_event_name:'UserPromptSubmit',session_id:f.nativeId,prompt_id:first,prompt:'继续',source:'naw-peer'});f.queue('enqueue','继续');
  f.typed(first,'继续');f.queue('enqueue','继续');f.stop(first);
  const rows=f.w.get('session').messages.filter(m=>m.text==='继续');assert.equal(rows.length,2);
  assert.equal(rows[0].inputSource,'naw-peer');
  assert.equal(rows[1].inputSource,undefined);assert.equal(rows[1].name,undefined);assert.equal(rows[1].displayText,undefined);
});
test('PF06 B1: one human observation cannot label multiple enqueues as human',t=>{
  const f=fixture(t),first=randomUUID();f.prompt(first,'开始');f.typed(first,'继续');
  f.queue('enqueue','继续');f.queue('enqueue','继续');f.stop(first);
  assert.deepEqual(f.shown(),['开始','继续'],'An extra enqueue with no matching source observation is not a proven human copy');
  const g=fixture(t),second=randomUUID();g.prompt(second,'开始');g.queue('enqueue','继续');
  g.typed(second,'继续');g.queue('enqueue','继续');g.stop(second);
  assert.deepEqual(g.shown(),['开始','继续'],'A fallback already displays the one proven human observation after an unknown enqueue');
});
test('PF06 T1: the observation anchor preserves prior progress at the same millisecond',t=>{
  const now=Date.now();t.mock.method(Date,'now',()=>now);const f=fixture(t),first=randomUUID();f.prompt(first,'开始');
  f.typed(first,'重复');f.queue('enqueue','重复',{timestamp:new Date(now).toISOString()});
  f.w.get('session').messages.push({id:'progress',role:'assistant',text:'此前进度',time:now});
  f.typed(first,'重复');f.queue('enqueue','重复',{timestamp:new Date(now).toISOString()});f.w.get('session').messages.push({id:'reply',role:'assistant',text:'后续回复',time:now});
  f.r.withdrawQueued();assert.deepEqual(f.w.get('session').messages.map(m=>m.text),['开始','重复','此前进度','重复','后续回复']);
});
test('PF06 T1: equal-time replies from another native turn keep their existing place',t=>{
  const now=Date.now();t.mock.method(Date,'now',()=>now);const f=fixture(t),first=randomUUID();f.prompt(first,'开始');
  f.w.get('session').messages[0].turnId='current-turn';
  f.typed(first,'重复');f.queue('enqueue','重复',{timestamp:new Date(now).toISOString()});f.typed(first,'重复');f.queue('enqueue','重复',{timestamp:new Date(now).toISOString()});
  f.w.get('session').messages.push({id:'other',role:'assistant',turnId:'other-turn',text:'其他轮',time:now},{id:'reply',role:'assistant',turnId:'current-turn',text:'当前回复',time:now});
  f.r.withdrawQueued();assert.deepEqual(f.w.get('session').messages.map(m=>m.text),['开始','重复','其他轮','重复','当前回复']);
});
test('PF06: a journal write delayed past the first refresh still shows both entries during the turn',{timeout:1500},async t=>{
  const f=fixture(t),first=randomUUID();f.prompt(first,'开始');f.typed(first,'重复');f.queue('enqueue','重复');f.typed(first,'重复');
  const written=setTimeout(()=>f.queue('enqueue','重复'),250);t.after(()=>clearTimeout(written));
  await new Promise(resolve=>{const watch=event=>{if(event.id.includes('-e')){f.r.off('nativeQueuedInput',watch);resolve();}};f.r.on('nativeQueuedInput',watch);t.after(()=>f.r.off('nativeQueuedInput',watch));});
  assert.deepEqual(f.shown(),['开始','重复','重复']);
});
test('PF06: late queue projection preserves journal time order before the native reply',t=>{
  const f=fixture(t),first=randomUUID(),now=Date.now();f.prompt(first,'开始');
  f.typed(first,'重复');f.queue('enqueue','重复',{timestamp:new Date(now+1).toISOString()});
  f.typed(first,'重复');f.queue('enqueue','重复',{timestamp:new Date(now+2).toISOString()});
  f.w.get('session').messages.push({id:'reply',role:'assistant',text:'原生回复',time:now+1000});f.r.withdrawQueued();
  assert.deepEqual(f.w.get('session').messages.map(m=>m.text),['开始','重复','重复','原生回复']);
});
test('a queued prompt taken back and deleted is gone once its turn ends', t => {
  const f = fixture(t), first = randomUUID();
  f.prompt(first, '开始第三件');
  f.typed(first, '方案 D'); f.queue('enqueue', '方案 D');
  f.queue('popAll', '方案 D'); // ↑, then the person deletes the text
  assert.deepEqual(f.shown(), ['开始第三件', '方案 D'], 'nothing has said so yet');
  f.stop(first);
  assert.deepEqual(f.shown(), ['开始第三件']);
});
test('picking one queued prompt to edit takes back only that one', t => {
  const f = fixture(t), first = randomUUID();
  f.prompt(first, '开始');
  f.typed(first, '方案 E'); f.queue('enqueue', '方案 E');
  f.typed(first, '方案 F'); f.queue('enqueue', '方案 F');
  f.queue('popOne', '方案 F'); f.queue('enqueue', '方案 G'); f.typed(first, '方案 G');
  f.queue('remove', '方案 E', { reason: 'absorbed_mid_turn' }); f.queue('remove', '方案 G', { reason: 'absorbed_mid_turn' }); f.stop(first);
  assert.deepEqual(f.shown(), ['开始', '方案 E', '方案 G']);
});
test('queued prompts cleared on cancel are not shown as sent', t => {
  const f = fixture(t), first = randomUUID(), second = randomUUID();
  f.prompt(first, '开始');
  f.typed(first, '方案 H'); f.queue('enqueue', '方案 H');
  f.queue('remove', '方案 H', { reason: 'cleared_on_cancel' });
  f.prompt(second, '下一件');
  assert.deepEqual(f.shown(), ['开始', '下一件']);
});
test('a queued prompt sent unchanged after ↑ stays, once', t => {
  const f = fixture(t), first = randomUUID();
  f.prompt(first, '开始');
  f.typed(first, '方案 A'); f.queue('enqueue', '方案 A');
  f.queue('popAll', '方案 A');
  f.typed(first, '方案 A'); // its hook can come before its new enqueue row is written
  assert.deepEqual(f.shown(), ['开始', '方案 A']);
  f.queue('enqueue', '方案 A'); f.queue('remove', '方案 A', { reason: 'absorbed_mid_turn' }); f.stop(first);
  assert.deepEqual(f.shown(), ['开始', '方案 A']);
});
test('read, delivered or still waiting queued prompts all stay', t => {
  const f = fixture(t), first = randomUUID(), second = randomUUID();
  f.prompt(first, '开始');
  f.typed(first, '方案 C'); f.queue('enqueue', '方案 C');
  f.typed(first, '方案 C'); f.queue('enqueue', '方案 C'); // both real enqueues, one is later consumed and the other taken back
  f.typed(first, '方案 J'); f.queue('enqueue', '方案 J');
  f.typed(first, '方案 K'); f.queue('enqueue', '方案 K');
  f.queue('remove', '方案 C', { reason: 'absorbed_mid_turn' }); f.queue('popOne', '方案 C'); // one of the two taken back
  f.queue('remove', '方案 K', { reason: 'dropped_by_hook' }); // native writes no text for this one
  f.stop(first);
  f.queue('dequeue'); f.prompt(second, '方案 J'); // J waits, then heads a turn of its own
  assert.deepEqual(f.shown(), ['开始', '方案 C', '方案 J', '方案 K', '方案 J']);
});
test('only this prompt window, this session and exact text count', t => {
  const f = fixture(t), earlier = randomUUID(), first = randomUUID();
  f.prompt(earlier, '更早');
  f.queue('enqueue', '方案 L'); f.queue('remove', '方案 L', { reason: 'absorbed_mid_turn' }); // read in an earlier turn
  f.prompt(first, '开始');
  f.typed(first, '方案 L'); f.queue('enqueue', '方案 L'); f.queue('popAll', '方案 L'); // this one is taken back
  f.typed(first, '方案 M'); f.queue('enqueue', '方案 M');
  f.write({ type: 'queue-operation', operation: 'popAll', content: '方案 M', sessionId: randomUUID() }); // another session's row
  f.queue('popAll', '方案 M '); // other text
  f.stop(first);
  assert.deepEqual(f.shown(), ['更早', '开始', '方案 M']);
});
test('without the turn\'s journal window nothing is removed', t => {
  // No transcript path (a hook without it) or an adapter that did not see the turn begin: no proof, no removal.
  const f = fixture(t, { journal: false }), first = randomUUID();
  f.prompt(first, '开始');
  f.typed(first, '方案 A'); f.queue('enqueue', '方案 A'); f.queue('popAll', '方案 A');
  f.stop(first);
  assert.deepEqual(f.shown(), ['开始', '方案 A']);
  const g = fixture(t), second = randomUUID();
  g.prompt(second, '开始');
  g.r.queueWindows?.clear(); // a restarted adapter
  g.typed(second, '方案 A'); g.queue('enqueue', '方案 A'); g.queue('popAll', '方案 A');
  g.stop(second);
  assert.deepEqual(g.shown(), ['开始', '方案 A']);
});
test('a typed prompt that heads its own turn is never removed', t => {
  const f = fixture(t), first = randomUUID();
  f.prompt(first, '开始');
  f.typed(first, '方案 N'); f.queue('enqueue', '方案 N');
  const row = f.w.sessions.get('session').messages.find(m => m.id === `claude-prompt-${first}-q${promptTextTag('方案 N')}`);
  row.turnId = 'queued-turn'; // its own turn began (T-138 trigger link)
  f.queue('popAll', '方案 N'); f.stop(first);
  assert.deepEqual(f.shown(), ['开始', '方案 N']);
});
test('another session\'s withdrawal and other row shapes are ignored', t => {
  const f = fixture(t), first = randomUUID();
  f.prompt(first, '开始');
  f.r.emit('nativeInputWithdrawn', { id: `claude-prompt-${first}`, nativeId: f.nativeId });
  f.typed(first, '方案 P'); const id = `claude-prompt-${first}-q${promptTextTag('方案 P')}`;
  f.r.emit('nativeInputWithdrawn', { id, nativeId: randomUUID() });
  assert.deepEqual(f.shown(), ['开始', '方案 P']);
});

test('PF06 B2: two human hooks before both enqueue appends retain both inputs', t => {
  const f = fixture(t), first = randomUUID(); f.prompt(first, '开始');
  for (let i = 0; i < 2; i++) f.r.hook({ hook_event_name: 'UserPromptSubmit', session_id: f.nativeId,
    transcript_path: f.r.nativeTranscript, prompt_id: first, prompt: '重复', source: 'user' });
  const control = f.w.get('session').controlRevision;
  f.queue('enqueue', '重复'); f.queue('enqueue', '重复'); f.stop(first);
  assert.deepEqual(f.shown(), ['开始', '重复', '重复']);
  const ids = f.w.get('session').messages.map(m => m.id);
  for (let i = 0; i < 5; i++) f.r.withdrawQueued();
  assert.deepEqual(f.w.get('session').messages.map(m => m.id), ids);
  assert.equal(f.w.get('session').controlRevision, control);
});

test('PF06 B2: three coalesced human observations each prove one enqueue', t => {
  const f = fixture(t), first = randomUUID(); f.prompt(first, '开始');
  for (let i = 0; i < 3; i++) f.typed(first, '重复');
  for (let i = 0; i < 3; i++) f.queue('enqueue', '重复');
  f.stop(first);
  assert.deepEqual(f.shown(), ['开始', '重复', '重复', '重复']);
  assert.equal(new Set(f.w.get('session').messages.map(m => m.id)).size, 4);
});

test('PF06 B2: repeated same-boundary observations accumulate without exhausting the origin bound', t => {
  const f = fixture(t), first = randomUUID(), count = 300; f.prompt(first, '开始');
  for (let i = 0; i < count; i++) f.typed(first, '重复');
  for (let i = 0; i < count; i++) f.queue('enqueue', '重复');
  f.stop(first);
  assert.equal(f.shown().filter(text => text === '重复').length, count);
  assert.ok([...f.r.queuedRows.values()].every(row => row.origins.length <= 256));
});

test('PF06 B2: coalesced source counts do not label an additional unknown enqueue', t => {
  const f = fixture(t), first = randomUUID(); f.prompt(first, '开始');
  f.typed(first, '重复'); f.typed(first, '重复');
  for (let i = 0; i < 3; i++) f.queue('enqueue', '重复');
  f.stop(first);
  assert.deepEqual(f.shown(), ['开始', '重复', '重复']);
});

test('PF06 B2: a coalesced mixed-origin boundary cannot supply human copy proofs', t => {
  for (const source of ['naw-peer', 'unknown-source']) {
    const f = fixture(t), first = randomUUID(); f.prompt(first, '开始');
    f.typed(first, '重复'); f.typed(first, '重复');
    f.r.hook({ hook_event_name: 'UserPromptSubmit', session_id: f.nativeId, prompt_id: first, prompt: '重复', source });
    f.typed(first, '重复');
    for (let i = 0; i < 4; i++) f.queue('enqueue', '重复');
    f.stop(first);
    assert.deepEqual(f.shown(), ['开始', '重复']);
  }
});

test('PF06 B2: coalesced observations retain their separate equal-time progress anchors', t => {
  const now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = fixture(t), first = randomUUID(); f.prompt(first, '开始');
  f.typed(first, '重复');
  f.w.get('session').messages.push({ id: 'progress', role: 'assistant', text: '此前进度', time: now });
  f.typed(first, '重复');
  f.queue('enqueue', '重复', { timestamp: new Date(now).toISOString() });
  f.queue('enqueue', '重复', { timestamp: new Date(now).toISOString() });
  f.w.get('session').messages.push({ id: 'reply', role: 'assistant', text: '后续回复', time: now });
  f.stop(first);
  assert.deepEqual(f.w.get('session').messages.map(m => m.text), ['开始', '重复', '此前进度', '重复', '后续回复']);
});
