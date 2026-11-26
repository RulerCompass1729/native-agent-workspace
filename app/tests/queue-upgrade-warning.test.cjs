const test=require('node:test'),assert=require('node:assert/strict'),vm=require('vm'),fs=require('fs');
const root=require('node:path').resolve(__dirname,'../..'),s=fs.readFileSync(root+'/app/renderer/renderer.js','utf8'),rules=require(root+'/app/queue-dispatch.cjs');
const start=s.indexOf('function renderQueue()'),end=s.indexOf("  const select = $('queue-assignee');",start);assert.ok(start>=0&&end>start);
function actual(caps,extra={}){const elements=new Map(),$=id=>{if(!elements.has(id))elements.set(id,{hidden:false});return elements.get(id)};
 const record={id:'member',name:'Synthetic member',serviceCapabilities:caps,...extra};const context={$,queueSpace:'shared',spaceRecord:()=>({id:'shared'}),spaceName:()=> 'Synthetic space',ui:{display:{text(){}}},state:{wakePolicy:{enabled:true},sessions:[record]},disconnected:false,inSpace:()=>true};
 vm.runInNewContext(s.slice(start,end)+'\nreturn needUpdate;\n}',context);const names=context.renderQueue();return {hidden:$('queue-update').hidden,names:Array.from(names),reason:rules.sessionReady(record,{enabled:true},true).reason};}
test('current backend has no update warning',()=>assert.equal(actual(['queueDispatchV1','queueDispatchInputV1']).hidden,true));
test('backend with neither protocol shows the update warning',()=>assert.equal(actual([]).hidden,false));
// alpha.308 hotfix: an old-only backend takes queued work again (alpha.307), so it is not named, with or without a draft.
test('an old-only backend is not named in the update warning and is not held for an update',()=>{const got=actual(['queueDispatchV1']);assert.notEqual(got.reason,'backend-update-needed');assert.equal(got.hidden,true);assert.deepEqual(got.names,[]);});
test('an old-only backend with a draft is not named either: the draft holds it, as in alpha.307',()=>{const got=actual(['queueDispatchV1'],{state:'idle',liveDraft:'/'});assert.equal(got.reason,'person-typing');assert.equal(got.hidden,true);assert.deepEqual(got.names,[]);});
