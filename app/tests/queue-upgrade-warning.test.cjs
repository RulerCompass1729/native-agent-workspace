const test=require('node:test'),assert=require('node:assert/strict'),vm=require('vm'),fs=require('fs');
const root=require('node:path').resolve(__dirname,'../..'),s=fs.readFileSync(root+'/app/renderer/renderer.js','utf8'),rules=require(root+'/app/queue-dispatch.cjs');
const start=s.indexOf('function renderQueue()'),end=s.indexOf("  const select = $('queue-assignee');",start);assert.ok(start>=0&&end>start);
function actual(caps){const elements=new Map(),$=id=>{if(!elements.has(id))elements.set(id,{hidden:false});return elements.get(id)};
 const record={id:'member',name:'Synthetic member',serviceCapabilities:caps};const context={$,queueSpace:'shared',spaceRecord:()=>({id:'shared'}),spaceName:()=> 'Synthetic space',ui:{display:{text(){}}},state:{wakePolicy:{enabled:true},sessions:[record]},disconnected:false,inSpace:()=>true};
 vm.runInNewContext(s.slice(start,end)+'\nreturn needUpdate;\n}',context);const names=context.renderQueue();return {hidden:$('queue-update').hidden,names:Array.from(names),reason:rules.sessionReady(record,{enabled:true},true).reason};}
test('current backend has no update warning',()=>assert.equal(actual(['queueDispatchV1','queueDispatchInputV1']).hidden,true));
test('backend with neither protocol shows the update warning',()=>assert.equal(actual([]).hidden,false));
test('retained old-only backend must show the existing queue update warning when dispatch requires the new protocol',()=>{const got=actual(['queueDispatchV1']);console.log(JSON.stringify(got));assert.equal(got.reason,'backend-update-needed');assert.equal(got.hidden,false,'blocked old backend must be named in the update warning');assert.deepEqual(got.names,['Synthetic member']);});
