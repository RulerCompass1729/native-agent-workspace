const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const tui=require('../dsh-tui.cjs'),{qualification,runtime}=require('./helpers/dsh-runtime.cjs'),layout=require('../service-layout.cjs');
function fixture(t,{fault=null,empty=true,pending=false}={}){
 qualification(t);const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'naw-donor-budget-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const donor=runtime(root),key='backends/ffffffffffffffffffff',target=path.join(root,key);fs.mkdirSync(target,{recursive:true,mode:0o700});
 if(fault==='unqualified')fs.writeFileSync(path.join(donor.tui,'package.json'),JSON.stringify({version:'old-synthetic'}));
 layout.writeLayout(root,pending?{format:1,active:'.',entries:['.'],pending:key}:{format:1,active:key,entries:['.',key]});
 const {performance}=require('node:perf_hooks'),now=performance.now.bind(performance),open=fs.promises.open;let offset=0,broken=true,locked=false,inheritCalls=0,boots=0;
 t.mock.method(performance,'now',()=>now()+offset);
 t.mock.method(fs.promises,'open',async function(file,...args){
  if(broken&&String(file).startsWith(donor.root)){if(fault==='deadline')offset+=31000;if(fault==='filesystem')throw Object.assign(Error('synthetic EIO'),{code:'EIO'});}
  return Reflect.apply(open,this,[file,...args]);
 });
 const env={NAW_APP_VERSION:'synthetic-v1'},retired=[],warnings=[];
 const state=dir=>({runtimeVersion:env.NAW_APP_VERSION,sessions:dir===root&&!empty?[{id:'retained',state:'ended'}]:[],room:{messages:[]}});
 const wrapped={...tui,inheritRuntime:async(...args)=>{assert.equal(locked,true);inheritCalls++;if(broken&&fault==='unexpected')throw Error('SYNTHETIC_PRIVATE_REASON');return tui.inheritRuntime(...args);}};
 const ctx={fs,path,crypto,__dirname:path.join(__dirname,'..'),process:{env},uiError:key=>Error(key),...layout,readLock:()=>undefined,createLock:()=>{locked=true;return {};},releaseLock:()=>{locked=false;return true;},ownerMayBeAlive:()=>false,
  emptyService:s=>s.sessions.length===0,emptyStore:()=>true,lockIdentity:()=>null,waitForShutdown:async()=>{},console:{warn:(...args)=>warnings.push(args)},require:()=>wrapped,
  ensureServiceAt:async dir=>{boots++;return state(dir);},connectService:async dir=>({call:async method=>{if(method==='initial')return state(dir);if(method==='shutdown')retired.push(dir);},close(){}})};
 const source=fs.readFileSync(require.resolve('../service-client.cjs'),'utf8'),start=source.indexOf('async function ensureService(dataDir,'),end=source.indexOf('\nfunction continuationStatus',start);
 return {root,key,target,env,retired,warnings,ctx,repair(){broken=false;},calls:()=>inheritCalls,
  async start(endedServiceKey=null){offset=0;boots=0;await vm.runInNewContext(source.slice(start,end)+'\nensureService',ctx)(root,'/synthetic/electron',endedServiceKey);assert.equal(locked,false);return {layout:layout.readLayout(root),boots,inheritCalls};}};
}
for(const pending of [false,true])test('unqualified empty donor retires immediately and is not retried, pending='+pending,async t=>{
 const f=fixture(t,{fault:'unqualified',pending});
 for(let n=1;n<=3;n++){const r=await f.start();assert.deepEqual(r.layout.entries,[f.key]);assert.equal(r.inheritCalls,1);assert.equal(r.boots,n===1?2:1);assert.equal(tui.installed(f.target),false);assert.equal(r.layout.dshInheritance,undefined);}
 assert.deepEqual(f.retired,[f.root]);
});
for(const fault of ['deadline','filesystem'])for(const pending of [false,true])test('persistent '+fault+' stops after two attempts and releases an empty donor, pending='+pending,async t=>{
 const f=fixture(t,{fault,pending});const first=await f.start();assert.ok(first.layout.entries.includes('.'));assert.equal(first.inheritCalls,1);
 assert.deepEqual(first.layout.dshInheritance.failures,[{source:'.',target:f.key,attempts:1,reason:fault}]);
 for(let n=2;n<=4;n++){const r=await f.start();assert.deepEqual(r.layout.entries,[f.key]);assert.equal(r.inheritCalls,2);assert.equal(r.boots,n===2?2:1);assert.equal(r.layout.dshInheritance,undefined);}
 assert.deepEqual(f.retired,[f.root]);
});
test('unexpected inheritance failures do not retain or retry an empty donor',async t=>{
 const f=fixture(t,{fault:'unexpected'});await f.start();const r=await f.start();assert.deepEqual(r.layout.entries,[f.key]);assert.equal(r.inheritCalls,1);assert.equal(r.boots,1);assert.ok(!JSON.stringify(f.warnings).includes('SYNTHETIC_PRIVATE_REASON'));
});
for(const fault of ['deadline','filesystem'])test('one '+fault+' still recovers on a fresh second startup and clears its budget',async t=>{
 const f=fixture(t,{fault});await f.start();f.repair();const r=await f.start();assert.equal(r.inheritCalls,2);assert.equal(tui.installed(f.target),true);tui.verifyRuntime(f.target);assert.deepEqual(r.layout.entries,[f.key]);assert.equal(r.layout.dshInheritance,undefined);
 await f.start();assert.equal(f.calls(),2);
});
for(const fault of ['unqualified','deadline'])test('retained history is preserved while '+fault+' retries are bounded and reset by version',async t=>{
 const f=fixture(t,{fault,empty:false});for(let n=0;n<4;n++)await f.start();assert.equal(f.calls(),fault==='deadline'?2:1);assert.deepEqual(f.retired,[]);assert.ok(layout.readLayout(f.root).entries.includes('.'));
 f.env.NAW_APP_VERSION='synthetic-v2';await f.start();assert.equal(f.calls(),fault==='deadline'?3:2);assert.equal(layout.readLayout(f.root).dshInheritance.version,'synthetic-v2');
});
test('a different target has its own budget and can recover from the same retained source',async t=>{
 const f=fixture(t,{fault:'deadline',empty:false});await f.start();await f.start();f.repair();
 const key='backends/eeeeeeeeeeeeeeeeeeee';fs.mkdirSync(path.join(f.root,key),{recursive:true,mode:0o700});const state=layout.readLayout(f.root);state.entries.push(key);state.active=key;layout.writeLayout(f.root,state);
 const r=await f.start();assert.equal(r.inheritCalls,3);assert.equal(tui.installed(path.join(f.root,key)),true);assert.ok(r.layout.entries.includes('.'));
});
test('retry bookkeeping failure does not turn an inheritance refusal into a service bootstrap failure',async t=>{
 const f=fixture(t,{fault:'deadline',empty:false});f.ctx.writeLayout=()=>{throw Error('synthetic retry-state write failure');};await f.start();assert.equal(f.calls(),1);
});
test('retry metadata accepts legacy layouts and rejects malformed counters or path keys',t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'naw-donor-layout-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const key='backends/aaaaaaaaaaaaaaaaaaaa',base={format:1,active:key,entries:['.',key]};fs.mkdirSync(path.join(root,key),{recursive:true,mode:0o700});
 layout.writeLayout(root,base);assert.deepEqual(layout.readLayout(root),base);
 const valid={version:'synthetic-v1',failures:[{source:'.',target:key,attempts:1,reason:'deadline'}]};
 for(const bad of [null,{...valid,version:1},{...valid,failures:{}},{...valid,failures:[{...valid.failures[0],source:'../escape'}]},{...valid,failures:[{...valid.failures[0],target:null}]},{...valid,failures:[{...valid.failures[0],attempts:3}]},{...valid,failures:[{...valid.failures[0],reason:'raw-private-error'}]},{...valid,failures:[valid.failures[0],valid.failures[0]]}]){
  layout.writeLayout(root,{...base,dshInheritance:bad});assert.throws(()=>layout.readLayout(root),e=>e.uiMessage?.key==='error.service.invalidLayout');
 }
 layout.writeLayout(root,{...base,dshInheritance:valid});assert.deepEqual(layout.readLayout(root).dshInheritance,valid);
});
test('a failing donor does not retire another runtime before that source gets its turn',async t=>{
 const f=fixture(t,{fault:'filesystem'}),other='backends/dddddddddddddddddddd';runtime(path.join(f.root,other));
 const initial=layout.readLayout(f.root);initial.entries.splice(1,0,other);layout.writeLayout(f.root,initial);
 for(let n=0;n<2;n++){const r=await f.start();assert.ok(r.layout.entries.includes(other),'unattempted source must remain reachable');}
 const r=await f.start();assert.equal(r.inheritCalls,3);assert.equal(tui.installed(f.target),true);assert.deepEqual(r.layout.entries,[f.key]);
});
test('stale donor metadata left by an older client is pruned without blocking startup',async t=>{
 const f=fixture(t),state=layout.readLayout(f.root);state.dshInheritance={version:'synthetic-v1',failures:[{source:'backends/aaaaaaaaaaaaaaaaaaaa',target:f.key,attempts:2,reason:'deadline'}]};layout.writeLayout(f.root,state);
 const r=await f.start();assert.equal(tui.installed(f.target),true);assert.equal(r.layout.dshInheritance,undefined);
});

test('explicit ended-session continuation leaves peer retry state untouched',async t=>{
 const f=fixture(t,{fault:'deadline',empty:false});await f.start();const before=layout.readLayout(f.root);f.env.NAW_APP_VERSION='synthetic-v2';
 const r=await f.start('.');assert.equal(r.boots,1);assert.equal(r.inheritCalls,1);assert.deepEqual(r.layout,before);
});
test('retirement layout write errors still propagate',async t=>{
 const f=fixture(t),error=Error('synthetic required layout failure');f.ctx.writeLayout=()=>{throw error;};await assert.rejects(f.start(),e=>e===error);
});
