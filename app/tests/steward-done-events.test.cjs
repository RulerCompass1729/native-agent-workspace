const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const app=path.resolve(__dirname,'..');
const {RoomState}=require(path.join(app,'room-state.cjs'));
const {ButlerIngress,bindQueueOutcomes}=require(path.join(app,'butler-ingress.cjs'));
const rules=require(path.join(app,'queue-dispatch.cjs'));
const NOW=1800000000000;
for(const [label,reply,status,kind] of [
 ['review PASS','PASS\nSynthetic read-only review complete.','done','done'],
 ['review BLOCK','BLOCK\nSynthetic permission regression found.','done','done'],
 ['report only','Report complete; no code committed.','done','done'],
 ['person report','Report by a person-assigned member.','done',null],
 ['code READY','Complete.\nREADY lane/synthetic-delivery abc1234','done','ready'],
 ['needs person','需要你决定：Synthetic choice?','waiting','decision'],
 ['missing member',null,'failed','failure'],
])test(label+' through actual planner, room write and butler ingress',t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'event-gap-')));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const room=new RoomState(root),ingress=new ButlerIngress(root,{roomState:room});bindQueueOutcomes(room,ingress,()=>{});
 const person=label==='person report';
 const creator=person?{kind:'person',name:'Synthetic human',sessionId:null}:{kind:'secretary',name:'Synthetic steward',sessionId:'steward'};
 const id=room.queueAdd('Synthetic review task',null,'shared',creator,person?null:'steward');room.queueMarkSent('shared',id,'a','Synthetic member',NOW-30000);room.queueSetDelivery('shared',id,'task-tag',0);
 room.queueAdd('Keeps the space nonempty',null);
 const member={id:'a',name:'Synthetic member',provider:'claude',nativeId:'synthetic-native',model:'synthetic-model',state:'idle',roomIds:['shared'],roomId:'shared',createdAt:NOW-3600000,background:0,scheduled:0,backgroundStale:false,chatAvailable:true,liveDraft:'',controlRevision:0,draftRevision:0,placementRevision:0,serviceCapabilities:[rules.CAPABILITY,'guardedSessionStopV1'],fleet:[],messages:[{id:'task-tag',role:'user',text:'Synthetic assigned work',origin:'naw-dispatch'},...(reply===null?[]:[{id:'answer',role:'assistant',text:reply}])]};
 const actions=rules.planDispatch({rooms:[{...room.metadata(),id:'shared'}],sessions:reply===null?[]:[member],wakePolicy:{enabled:true},idleSince:new Map([['a',NOW-60000]]),now:NOW});
 const settle=actions.find(a=>a.kind==='settle'&&a.itemId===id);assert.ok(settle,JSON.stringify(actions));assert.equal(settle.status,status);
 const before=room.metadata().events.length;
 room.queueSettle('shared',id,settle.status,settle.reason||'','Synthetic member',settle.reply||'',settle.question,settle.ready,settle.reportTitle);
 const emitted=ingress.ledger.eventsAfter(null).events;
 assert.equal(room.queueFind('shared',id).status,status);
 if(kind){assert.equal(emitted.length,1);assert.equal(emitted[0].kind,kind);assert.equal(emitted[0].payload.itemId,id);
  if(kind==='done'){assert.equal(emitted[0].payload.title,reply.split('\n')[0]);assert.equal(emitted[0].payload.memberId,'a');assert.equal(emitted[0].payload.memberName,'Synthetic member');assert.equal(ingress.ledger.snapshot().questions.length,0);}
 }
 else{assert.equal(emitted.length,0);assert.equal(room.metadata().events.length,before);assert.equal(room.butlerSources().length,0);}
 const row={label,status,hasReady:!!settle.ready,newRoomEvents:room.metadata().events.length-before,stewardKinds:emitted.map(e=>e.kind)};
 console.log(JSON.stringify(row));
});
