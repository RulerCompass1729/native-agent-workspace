'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const legacy = require('./helpers/butler-legacy.cjs');
const { ButlerRole } = legacy.load('butler-role.cjs'), { ButlerLedger } = legacy.load('butler-ledger.cjs'), { ButlerController } = legacy.load('butler-controller.cjs');
const runner = { runnerRef: 'butler:runner-a', backendRef: 'butler:backend-a', purpose: 'butler', profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro' };
const envelope = (input, selection, reply = { actions: [] }, costMicros = 1) => ({ batchId: input.batchId, attempt: input.attempt, selection, reply, usage: { costMicros } });
const selectionFor = role => { const selected = role.current(); return { selectionRevision: selected.selectionRevision, identity: selected.identity, runnerRef: selected.runner.runnerRef }; };
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-controller-')); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const person = Symbol('person'), role = new ButlerRole(directory, { authorizePerson: actor => actor === person });
  role.set(person, { identity: { sessionId: 'butler-a', nativeId: 'native-a' }, runner, budget: { limitMicros: 100 } }, 0);
  const records = [{ id: 'butler-a', nativeId: 'native-a', provider: 'dsh', state: 'idle', roomIds: [], runner }];
  const spaces = [{ id: 'shared', name: 'Example space', archived: false, writable: true, members: [], queue: [] }];
  let time = Date.UTC(2026, 10, 9); const now = () => time;
  let epoch = 0;
  const newLedger = () => {
    const value = new ButlerLedger(directory, { now, authorizePerson: actor => actor === person });
    value.openQuestionMetricEpoch('controller-test-epoch-' + ++epoch); return value;
  };
  const ledger = newLedger(), calls = [], invocations = [], timers = new Map(), blocked = [], reports = [], questions = [];
  const run = async (input, selection) => {
    calls.push(input); invocations.push({ input, selection });
    if (options.run) return options.run(input, selection);
    return envelope(input, selection, { actions: input.events.filter(e => ['request', 'queue-empty'].includes(e.kind)).map(e => ({ kind: 'queue', sourceRef: e.sourceRef, text: 'Proposed synthetic task' })).concat([{ kind: 'report', sourceRef: input.events[0].sourceRef, text: 'New synthetic progress' }]) });
  };
  const publish = async r => { reports.push(r); return { deliveryId: r.deliveryId, status: 'sent' }; };
  const ask = async q => { questions.push(q); return { deliveryId: q.deliveryId, status: 'sent' }; };
  const makeController = (actualLedger, overrides = {}) => {
    const value = new ButlerController({ role, ledger: actualLedger, backend: { ensure: async () => ({ ready: true, binding: runner }) }, view: () => ({ records, spaces }), run,
    publish, ask,
    now, schedule: (fn, delay) => { const token = {}; timers.set(token, { fn, delay }); return token; }, cancel: token => timers.delete(token),
    estimateBatchCost: () => 1, onBlocked: x => blocked.push(x), ...options.controller, ...overrides });
    t.after(() => value.close()); return value;
  };
  const controller = makeController(ledger);
  const event = (n, kind = 'request') => ({ eventId: 'event-' + n, sourceRef: 'message-' + n, kind, payload: { text: 'Synthetic request ' + n } });
  const questionEvent = (n, key, kind = 'request', decisionKind = 'approval') => ({ ...event(n, kind), payload: { text: 'Synthetic question ' + n, questionKey: key, decisionKind } });
  return { controller, ledger, role, person, records, spaces, calls, invocations, timers, blocked, reports, questions, event, questionEvent, directory, publish, ask, newLedger,
    reopen: overrides => { const next = newLedger(); return { ledger: next, controller: makeController(next, overrides) }; }, advance: n => { time += n; } };
}
function completeFixtureBatch(f, event, actions) {
  f.ledger.ingest(event);
  const selection = selectionFor(f.role), batch = f.ledger.beginBatch(selection), attempt = f.ledger.beginAttempt(batch.batchId, selection);
  f.ledger.recordAttemptUsage(batch.batchId, selection, { costMicros: 0 }, attempt.attempt);
  f.ledger.completeBatch(batch.batchId, selection, { actions });
  return { batch, selection, attempt: attempt.attempt };
}

const {ButlerLedger:NewLedger}=require('../butler-ledger.cjs');

test('legacy controller must not turn a completed report carrier into a model request or spend a request budget', async t=>{
 const f=fixture(t,{run:async(input,selection)=>envelope(input,selection,{actions:[]},1)});f.controller.close();
 const writer=new NewLedger(f.directory,{now:()=>Date.UTC(2026,10,9)});
 writer.ingest({eventId:'completed-report',kind:'done',sourceRef:'queue-done:shared:report',payload:{spaceId:'shared',itemId:'report',title:'PASS',text:'Synthetic completed report; no new work requested'}});
 const restored=f.reopen();
 const outcome=await restored.controller.resume();
 const snapshot=restored.ledger.snapshot();
 console.log(JSON.stringify({outcome,calls:f.calls.length,inputKinds:f.calls.flatMap(c=>c.events.map(e=>e.kind)),questions:f.questions.length,actions:snapshot.actions.map(a=>a.kind),attempts:snapshot.attempts.map(a=>({status:a.status,usage:a.usage})),batches:snapshot.batches.length,timers:[...f.timers.values()].map(t=>t.delay)}));
 assert.equal(f.calls.length,0,'A completed report must not become a new legacy model request');
 assert.equal(snapshot.attempts.length,0,'A report carrier must not consume the request model budget');
});

const completedReport = {eventId:'passive-report',kind:'done',sourceRef:'queue-done:shared:report',
 payload:{spaceId:'shared',itemId:'report',memberId:'member-a',memberName:'Synthetic member',title:'PASS',text:'Synthetic finished report'}};
test('exact legacy blocked report has no batch, runner, attempt, budget gate, timer, question or proposal',async t=>{
 let estimates=0;
 const f=fixture(t,{controller:{estimateBatchCost:()=>{estimates++;return 1;}},run:async(input,selection)=>envelope(input,selection,{actions:[]},1)});f.controller.close();
 new NewLedger(f.directory).ingest(completedReport);
 const restored=f.reopen();assert.equal((await restored.controller.resume()).status,'empty');
 const view=restored.ledger.snapshot(),wire=view.events[0];
 assert.equal(wire.kind,'blocked');assert.equal(wire.payload.itemId,'report');assert.equal(wire.payload.memberId,'member-a');
 assert.match(wire.payload.reason,/完成报告.*新格式.*旧版只显示摘要.*不是成员卡住.*不需要处理.*队列项：report.*成员：member-a/);
 assert.equal(wire.payload.title,'PASS');assert.equal(wire.payload.text,completedReport.payload.text);
 assert.deepEqual([f.calls.length,view.batches.length,view.attempts.length,estimates,f.timers.size,view.questions.length,view.actions.length,f.questions.length,f.blocked.length],[0,0,0,0,0,0,0,0,0]);
 assert.equal((await restored.controller.notifyPersisted(completedReport.eventId)).status,'duplicate');
 assert.deepEqual(new NewLedger(f.directory).eventsAfter().events.map(e=>e.kind),['done']);
 assert.deepEqual(new NewLedger(f.directory).eventsAfter().events[0].payload,completedReport.payload);
});
test('permitted legacy position-only wake and notification cooldown are identical for report and ordinary blocked events',async t=>{
 const {StewardWake,wakeText}=legacy.load('steward-wake.cjs');
 for(const isReport of [false,true]){
  const f=fixture(t);f.controller.close();let actual=f.ledger;const sent=[],lines=[];
  const wake=new StewardWake(f.directory,{ledger:()=>actual,selected:()=>({sessionId:'butler-a',nativeId:'native-a'}),record:line=>lines.push(line),now:()=>Date.UTC(2026,10,9)});
  wake.set(true);const before=actual.latest();assert.equal(wake.due(),false);
  if(isReport)new NewLedger(f.directory).ingest(completedReport);
  else f.ledger.ingest({...completedReport,kind:'blocked',payload:{reason:'source-invalid'}});
  const restored=f.reopen();actual=restored.ledger;await restored.controller.resume();
  assert.equal(wake.due(),true,'The existing person-authorized position notification is permitted');
  const send=async text=>{sent.push(text);return 'synthetic-notification';};
  await wake.wake({id:'butler-a',nativeId:'native-a'},'synthetic-model',send);
  assert.deepEqual(sent,[wakeText(before)]);assert.equal(wake.view().at,Date.UTC(2026,10,9));assert.equal(lines.length,2);
  assert.equal(await wake.wake({id:'butler-a',nativeId:'native-a'},'synthetic-model',send),null);assert.equal(sent.length,1);
  assert.deepEqual([f.calls.length,actual.snapshot().batches.length,actual.snapshot().attempts.length,f.timers.size,actual.snapshot().questions.length],[0,0,0,0,0]);
 }
});
test('published legacy room, confirmation cards, bell and intake never present a report as work for the person',t=>{
 const {RoomState}=require('../room-state.cjs'),{ButlerIngress,bindQueueOutcomes}=require('../butler-ingress.cjs');
 const f=fixture(t);f.controller.close();const room=new RoomState(f.directory),ledger=new NewLedger(f.directory),intake=new ButlerIngress(f.directory,{roomState:room,ledger});bindQueueOutcomes(room,intake,()=>{});
 const id=room.queueAdd('Synthetic review',null,'shared',{kind:'secretary',name:'Steward',sessionId:'steward'},'steward');room.queueMarkSent('shared',id,'member-a','Synthetic member');room.queueSettle('shared',id,'done','','Synthetic member','PASS');
 const oldRoom=new (legacy.load('room-state.cjs').RoomState)(f.directory),oldLedger=new ButlerLedger(f.directory),oldIntake=new (legacy.load('butler-ingress.cjs').ButlerIngress)(f.directory,{roomState:oldRoom,ledger:oldLedger});oldIntake.recover();
 assert.equal(oldIntake.status().intake,'ready');assert.equal(oldIntake.status().errorCode,null);assert.equal(oldLedger.snapshot().questions.length,0);assert.equal(oldLedger.snapshot().deliveries.length,0);
 const snapshot=oldRoom.apply({sessions:[{id:'member-a',nativeId:'native-member',name:'Synthetic member',state:'idle',messages:[],roomIds:['shared']}],rooms:[]});
 // This published build predates the later waiting strip; do not import an
 // unpushed version to assert a surface that did not exist in the pinned build.
 assert.doesNotMatch(legacy.source('renderer/renderer.js'),/nativeWorkspaceTaskStream|stream-waiting/);
 assert.equal(snapshot.room.queue.find(item=>item.id===id).status,'done');assert.equal(snapshot.sessions[0].state,'idle');
 assert.ok(!snapshot.room.events.some(event=>event.kind==='blocked'||event.questionId));
 const {BackgroundControl}=legacy.load('background-control.cjs'),cards=Object.create(BackgroundControl.prototype);cards.data={records:[]};cards.inflight=new Map();cards.archivedBySession=new Map();cards.now=()=>1;
 // The published host appends these per-session rows into the conversation;
 // the later cross-session pending-card API did not exist in this build.
 assert.deepEqual(cards.rows('member-a'),[]);assert.equal(legacy.load('record-reminders.cjs').status(f.directory,Date.UTC(2026,10,9)).count,0);
});
test('the fixed rollback revision is an ancestor of the locally recorded origin main',()=>{
 require('node:child_process').execFileSync('git',['merge-base','--is-ancestor',legacy.revision,'refs/remotes/origin/main'],
  {cwd:path.resolve(__dirname,'../..'),stdio:'pipe',timeout:10000});
});
