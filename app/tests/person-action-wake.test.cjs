const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{EventEmitter}=require('node:events');
const {ButlerLedger}=require('../butler-ledger.cjs'),{ButlerIngress}=require('../butler-ingress.cjs'),{RoomState}=require('../room-state.cjs'),{StewardWake}=require('../steward-wake.cjs'),{QueueDispatcher,CAPABILITY}=require('../queue-dispatch.cjs');
const {PersonActions}=require('../person-actions.cjs');
const NOW=1800000000000,identity={sessionId:'butler',nativeId:'native-butler'};
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'naw-b-person-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const clock={now:NOW},room=new RoomState(dir),ledger=new ButlerLedger(dir,{now:()=>clock.now}),ingress=new ButlerIngress(dir,{roomState:room,ledger,now:()=>clock.now}),actions=new PersonActions({ingress,now:()=>clock.now});return {dir,clock,room,ledger,ingress,actions};}
test('a saved grant produces a metadata event and wakes an idle butler, then no idle repeat',async t=>{
 const f=fixture(t),calls=[],domains=[],session={id:'butler',nativeId:'native-butler',provider:'claude',model:'claude-test-model',state:'idle',roomIds:[],serviceCapabilities:[CAPABILITY],chatAvailable:true,background:0,scheduled:0,messages:[],fleet:[],liveDraft:'',createdAt:NOW-3600000};
 const client=Object.assign(new EventEmitter(),{close(){},refresh:async()=>{},snapshot:()=>({sessions:[session],rooms:[],wakePolicy:{enabled:true},operatorPolicy:{domains}}),route:()=>({client,state:{capabilities:[CAPABILITY]}}),call:async(method,...args)=>{calls.push([method,...args]);if(method==='dispatch'){session.state='working';return 'receipt-tag';}if(method==='initial')return client.snapshot();throw Error(method);}});
 const wake=new StewardWake(f.dir,{ledger:()=>f.ledger,selected:()=>identity,now:()=>f.clock.now,record:()=>{}});wake.set(true);
 const d=new QueueDispatcher({roomState:f.room,dataDir:f.dir,connect:async()=>client,steward:()=>identity,stewardWake:wake,now:()=>f.clock.now,settleMs:8000,tickMs:3600000,observePersonActions:s=>f.actions.observe(s,[]),transcriptRoot:path.join(f.dir,'none')});t.after(()=>d.close());await d.start();
 f.actions.call('operatorAction',['initiator','grant',Object.defineProperty({},'directories',{get(){throw Error('private');}})],'synthetic-domain');
 const events=f.ledger.eventsAfter(null).events;assert.equal(events.length,1);assert.equal(events[0].payload.reason,'person-action:operator:grant');assert.equal(wake.due(),true);
 await d.schedule();f.clock.now+=9000;await d.schedule();assert.equal(calls.filter(x=>x[0]==='dispatch').length,1);
 domains.push({id:'synthetic-domain',source:'human',createdAt:NOW,expiresAt:NOW+600000});await d.schedule();assert.equal(calls.filter(x=>x[0]==='dispatch').length,1);
 session.state='idle';domains.push({id:'recovered-domain',source:'human',createdAt:NOW,expiresAt:NOW+600000});client.emit('state',client.snapshot());
 await d.schedule();assert.equal(f.ledger.eventsAfter(null).events.at(-1).payload.itemId,'recovered-domain');f.clock.now+=9000;await d.schedule();assert.equal(calls.filter(x=>x[0]==='dispatch').length,1,'a new human event cannot bypass the one-minute gap');
 f.clock.now+=60000;let nextWake=0;await wake.wake(session,session.model,async()=>{nextWake++;return 'next-receipt';});assert.equal(nextWake,1);
});
test('automatic work, pending cards and unchanged idle observations do not create events or wake messages',async t=>{
 const f=fixture(t),session={id:'butler',nativeId:'native-butler',provider:'claude',model:'claude-test-model',state:'idle',roomIds:[],chatAvailable:true,background:0,scheduled:0,messages:[],fleet:[],liveDraft:'',createdAt:NOW-3600000,serviceCapabilities:[CAPABILITY]},calls=[];
 const client=Object.assign(new EventEmitter(),{snapshot:()=>({sessions:[session],rooms:[],wakePolicy:{enabled:true}}),refresh:async()=>{},close(){},route:()=>({client,state:{capabilities:[CAPABILITY]}}),call:async(method)=>{calls.push(method);if(method==='initial')return client.snapshot();throw Error('unexpected native send');}});
 const wake=new StewardWake(f.dir,{ledger:()=>f.ledger,selected:()=>identity,now:()=>f.clock.now,record:()=>{}}),d=new QueueDispatcher({roomState:f.room,dataDir:f.dir,connect:async()=>client,observePersonActions:s=>f.actions.observe(s,[{id:'pending',actor:{id:'a',nativeId:'b'},state:'needs-confirmation'}]),steward:()=>identity,stewardWake:wake,now:()=>f.clock.now,tickMs:3600000});t.after(()=>d.close());
 await d.start();wake.set(true);
 for(const elapsed of [60000,60000,7200000,86400000]){f.clock.now+=elapsed;await d.schedule();}
 assert.equal(f.ledger.eventsAfter(null).events.length,0);assert.equal(calls.filter(x=>x==='dispatch').length,0);
});
test('mobile queue decisions use the same metadata-only intake after the existing authorization checks',async t=>{
 const f=fixture(t),{MobileWorkspace}=require('../mobile-workspace.cjs'),roomId='shared';let applied=0;
 const adapter=new MobileWorkspace({snapshot:()=>({sessions:[],rooms:[{id:roomId}]}),roomState:{metadata(){},queueResolve(){applied++;}},records:{status(){},acknowledge(){}},personAction:(...args)=>f.actions.call(...args)});
 await adapter.action({}, {roomIds:[roomId],records:false},{requestId:'request',action:'queueResolve',roomId,itemId:'item'},()=>{});
 assert.equal(applied,1);assert.equal(f.ledger.eventsAfter(null).events[0].payload.reason,'person-action:queue:resolve');
 await assert.rejects(adapter.action({}, {roomIds:[],records:false},{requestId:'request',action:'queueResolve',roomId,itemId:'item'},()=>{}));
 assert.equal(applied,1);assert.equal(f.ledger.eventsAfter(null).events.length,1);
});
test('confirmation permit/reject/expiry, authorization denial/expiry and queue responses are events without bodies',t=>{
 const f=fixture(t),row={id:'op',actor:{id:'member',nativeId:'native'},command:{method:'input'},confirmation:{options:{cancelId:0}},humanDecision:1,humanDecisionAt:NOW,state:'complete'};
 Object.defineProperty(row.command,'arguments',{get(){throw Error('private args');}});
 f.actions.observe({},[row]);f.actions.observe({},[{...row,id:'reject',humanDecision:0,state:'cancelled',humanDecisionAt:undefined,finishedAt:NOW}]);
 f.actions.observe({},[{id:'expire',actor:row.actor,command:{method:'input'},state:'not-executed',disposition:'expired',finishedAt:NOW}]);
 f.actions.call('operatorAction',['member','dismiss',{key:'opaque-action'}],true);
 f.actions.observe({operatorPolicy:{domains:[{id:'domain',source:'human',createdAt:NOW-10000,expiresAt:NOW-1}]}},[]);
 f.actions.call('spaceAction',['space','queueResolve',['item','PRIVATE ANSWER']],undefined);f.actions.call('spaceAction',['space','queueCancel',['other']],undefined);
 const events=f.ledger.eventsAfter(null).events;assert.equal(events.length,8);const reasons=events.map(e=>e.payload.reason);
 for(const end of ['confirmation:confirm','confirmation:reject','confirmation:expire','operator:dismiss','operator:expire','queue:answer','queue:cancel'])assert.ok(reasons.includes('person-action:'+end));
 assert.doesNotMatch(JSON.stringify(events),/PRIVATE|arguments|directories/);
});
test('durable facts deduplicate across reload and an unavailable ledger retries without replaying effects',t=>{
 const f=fixture(t),state={operatorPolicy:{domains:[{id:'domain',source:'human',createdAt:NOW,expiresAt:NOW+1}]}};f.actions.observe(state,[]);const before=fs.readFileSync(f.ledger.file);
 const fresh=new PersonActions({ingress:new ButlerIngress(f.dir,{roomState:f.room,now:()=>f.clock.now}),now:()=>f.clock.now});fresh.observe(state,[]);assert.deepEqual(fs.readFileSync(f.ledger.file),before);
 let fail=true;const original=f.ingress.record.bind(f.ingress);f.ingress.record=event=>{if(fail)throw Error('synthetic disk fault');return original(event);};
 assert.doesNotThrow(()=>f.actions.call('spaceAction',['space','queueResolve',['pending']],undefined));fail=false;f.actions.observe({},[]);assert.equal(f.ledger.eventsAfter(null).events.length,2);
});
test('real Main IPC records only a committed person action, including a window closed during the request',async t=>{
 const f=fixture(t),vm=require('node:vm'),source=fs.readFileSync(require.resolve('../main.cjs'),'utf8'),ipc=new Map(),contexts=new Map(),handlers=new Map();
 const context={background:false,win:{isDestroyed:()=>false},view:{}},sender={id:1,mainFrame:{url:'test://local'}};contexts.set(1,context);
 const sandbox={applicationHandlers:handlers,ipcMain:{handle:(name,fn)=>ipc.set(name,fn)},windows:contexts,trusted:()=>true,
  typingKey:()=>false,isCurrentHumanContext:c=>contexts.get(1)===c&&!c.background,
  recordPersonAction:(...args)=>f.actions.call(...args),uiLocale:{displayMessage:x=>x},uiError:()=>({uiMessage:{key:'failed'}})};
 vm.runInNewContext(source.slice(source.indexOf('function register(name, handler)'),source.indexOf('\nasync function replaceBackendSockets(')),sandbox);
 let calls=0,release;const wait=new Promise(r=>{release=r;});sandbox.register('operatorAction',async()=>{calls++;await wait;return 'saved-domain';});
 const response=ipc.get('workspace:operatorAction')({sender,senderFrame:sender.mainFrame},'member','grant',{});
 assert.equal(f.ledger.eventsAfter(null).events.length,0);contexts.delete(1);release();assert.equal((await response).ok,true);
 assert.equal(calls,1);assert.equal(f.ledger.eventsAfter(null).events.length,1);assert.equal(f.ledger.eventsAfter(null).events[0].payload.itemId,'saved-domain');
 contexts.set(1,context);sandbox.register('operatorAction',async()=>{throw Error('denied');});
 assert.equal((await ipc.get('workspace:operatorAction')({sender,senderFrame:sender.mainFrame},'member','grant',{})).ok,false);
 assert.equal(f.ledger.eventsAfter(null).events.length,1);
 context.background=true;sandbox.register('operatorAction',async()=>true);
 await ipc.get('workspace:operatorAction')({sender,senderFrame:sender.mainFrame},'member','dismiss',{});
 assert.equal(f.ledger.eventsAfter(null).events.length,1,'agent handlers cannot manufacture a person fact');
});
test('real confirmation settlement records permits, denial and TTL expiry without executing expired work',async t=>{
 const f=fixture(t),{BackgroundControl,dialog}=require('../background-control.cjs'),actor={id:'agent',nativeId:'native',provider:'codex',name:'Synthetic'},options={buttons:['Cancel','Confirm'],cancelId:0};let writes=0,control;
 const source=fs.readFileSync(require.resolve('../main.cjs'),'utf8'),vm=require('node:vm');
 const callback=source.slice(source.indexOf('changed: change => { observePersonActions();')+'changed: '.length,source.indexOf(',\n    confirmationFingerprint:',source.indexOf('new background.BackgroundControl')));
 const changed=vm.runInNewContext('('+callback+')',{observePersonActions:()=>{if(control)f.actions.observe({},control.data.records);},backgroundNotifications:null,broadcastRoom:async()=>{},recordsChanged(){}});
 const handlers=new Map([['guarded',async c=>{await dialog(c,'message',options);writes++;return true; }]]);
 control=new BackgroundControl({dataDir:f.dir,handlers,now:()=>f.clock.now,changed,context:async(_actor,saved)=>({background:true,view:saved||{selected:actor.id,draft:''},confirmationActors:()=>[actor],checkActor:async()=>{},client:{close(){}},win:{destroy(){}}})});t.after(()=>control.close());
 const binding={sender:actor,identity:{nativeId:'native',sessionId:'session',turnId:'turn',callId:'call'},valid:()=>true};
 const invoke=id=>control.call(binding,{action:'invoke',operation_id:id,method:'guarded',arguments:[]});
 await invoke('yes');await control.decide(actor.id,actor.nativeId,'yes',1);assert.equal(writes,1);
 await invoke('no');await control.decide(actor.id,actor.nativeId,'no',0);assert.equal(writes,1);
 await invoke('late');f.clock.now+=600001;control.expirePending();assert.equal(writes,1);
 const events=f.ledger.eventsAfter(null).events;assert.deepEqual(events.map(x=>x.payload.reason),['person-action:confirmation:confirm','person-action:confirmation:reject','person-action:confirmation:expire']);
 assert.equal(events[0].payload.memberId,actor.id);assert.equal(events[0].payload.itemId,'yes');
});

test('a human decision with an unavailable native identity remains a fact, never an execution proof',t=>{
 const f=fixture(t),row={id:'null-native-card',actor:{id:'member',nativeId:null},humanDecision:1,humanDecisionAt:NOW,state:'unknown'};
 f.actions.observe({},[row]);f.actions.observe({},[row]);
 const event=f.ledger.eventsAfter(null).events;assert.equal(event.length,1);assert.equal(event[0].payload.reason,'person-action:confirmation:confirm');assert.equal(event[0].payload.outcome,'confirm');
 assert.doesNotMatch(JSON.stringify(event),/terminalConsent|terminalInputProof/);
});
