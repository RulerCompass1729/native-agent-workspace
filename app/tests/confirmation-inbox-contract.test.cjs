const test=require('node:test'),assert=require('node:assert/strict');
test('bell count is actionable confirmations plus each currently shown reminder, with a safe shared summary',()=>{
 const {inboxStatus,confirmationSummary}=require('../confirmation-inbox.cjs');
 const cards=[{id:'background:old-native:same-op',operationId:'same-op',sessionId:'a',nativeId:'old-native',actorName:'Requester',targetName:'Target',state:'waiting',actionable:true,time:1000,expiresAt:121000,summary:{action:'input',method:'input',target:'Target',folder:'PRIVATE_PATH',file:'PRIVATE_FILE'},detail:'PRIVATE_NATIVE_APPROVAL',guard:{secret:'PRIVATE_GUARD'},message:{text:'PRIVATE_TERMINAL'}},
 {id:'background:new-native:same-op',sessionId:'a',nativeId:'new-native',operationId:'same-op',state:'expired',actionable:false,time:1000}];
 const status=inboxStatus({count:1,records:[{items:[{shown:true}]}]},{shown:true},cards);
 assert.equal(status.count,3); assert.equal(status.confirmationCount,1);
 const safe=confirmationSummary(cards[0]);assert.equal(safe.nativeId,'old-native');assert.equal(safe.id,cards[0].id);
 assert.doesNotMatch(JSON.stringify(safe),/PRIVATE_/);assert.equal(safe.canDecide,false);
});

test('confirmation refresh bypasses block-count optimization and reaches every human window only',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(require.resolve('../main.cjs'),'utf8'),sent=[];let pushes=0;
 const window=background=>({background,win:{isDestroyed:()=>false,webContents:{send:channel=>sent.push(channel)}}});
 const context=vm.createContext({mobileBroker:{refreshPush:()=>pushes++},operationsBlocks:2,backgroundControl:{archive:{manifest:{blocks:[{},{}]}}},windows:new Map([[1,window(false)],[2,window(false)],[3,window(true)]])});
 vm.runInContext(source.slice(source.indexOf('function recordsChanged('),source.indexOf('// Every \'workspace:state\'')),context);
 context.recordsChanged();assert.equal(sent.length,0);context.recordsChanged(true);assert.deepEqual(sent,['workspace:records-changed','workspace:records-changed']);assert.equal(pushes,2,'Push refresh survives the block-count optimization too');
});

test('desktop status and the mobile/push status callback use the same live bell count and safe summaries',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(require.resolve('../main.cjs'),'utf8');
 const {tempSummary}=require('../temp-reminders.cjs'); let state={sessions:[],backgroundConfirmations:[{id:'original',key:'a:n:op',summary:{action:'input',target:'Target'},actionable:true}]};
 const scope=vm.createContext({dataDir:'/synthetic',operationsUnavailable:false,stewardRecord:null,recordReminders:{status:()=>({count:1,records:[]})},tempSummary,tempReminders:{cached:{shown:true,version:1,checkedAt:1,directories:1,bytes:1,oldestDay:null,ticket:'PRIVATE_TICKET'}},sessionLabels:{apply:s=>s,labels:new Map()},roomState:{apply:s=>s},confirmationInbox:require('../confirmation-inbox.cjs'),backgroundControl:{confirmations:()=>state.backgroundConfirmations},displayState:s=>s,queueDispatcher:null,broadcastRoom(){},Date,
 require(name){assert.equal(name,'./mobile-workspace.cjs');return {MobileWorkspace:class{constructor(options){Object.assign(this,options);}}};}});
 vm.runInContext(source.slice(source.indexOf('function confirmationSnapshot('),source.indexOf('// The listener stays open')),scope);
 const mobile=scope.appMobileWorkspace(),client={snapshot:()=>state};mobile.snapshot(client);
 const desktop=scope.appRecordsStatus(state),push=mobile.records.status(null,client);assert.equal(desktop.count,3);assert.equal(push.count,desktop.count);assert.doesNotMatch(JSON.stringify(push),/PRIVATE_/);
 state={...state,backgroundConfirmations:[]};assert.equal(mobile.records.status(null,client).count,2,'Callback re-reads the source, not the last phone render');
 client.closing=true;assert.equal(scope.confirmationSnapshot(client).unavailable,true);
});


test('Main defines the shared records status only once after the phone/bell merge',()=>{
 const fs=require('node:fs'),source=fs.readFileSync(require.resolve('../main.cjs'),'utf8');
 assert.equal((source.match(/function appRecordsStatus\(/g)||[]).length,1);assert.doesNotMatch(source,/sourceClient/);
});
