const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const tui=require('../dsh-tui.cjs'),{qualification,runtime,inProcess}=require('./helpers/dsh-runtime.cjs'),layout=require('../service-layout.cjs');
function fixture(t,{fault=null,empty=true,pending=false,targetFault=null}={}){
 qualification(t);const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'naw-donor-budget-')));let restore=()=>{};t.after(()=>{restore();fs.rmSync(root,{recursive:true,force:true});});
 const donor=runtime(root),key='backends/ffffffffffffffffffff',target=path.join(root,key);fs.mkdirSync(target,{recursive:true,mode:0o700});
 if(fault==='unqualified')fs.writeFileSync(path.join(donor.tui,'package.json'),JSON.stringify({version:'old-synthetic'}));
 if(targetFault==='unsafe-parent'){const base=tui.paths(target).base;fs.mkdirSync(base,{mode:0o700});fs.chmodSync(base,0o770);restore=()=>fs.chmodSync(base,0o700);}
 if(targetFault==='unreadable'){fs.chmodSync(target,0o300);restore=()=>fs.chmodSync(target,0o700);}
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
  emptyService:s=>s.sessions.length===0,emptyStore:()=>true,lockIdentity:()=>null,waitForShutdown:async()=>{},console:{warn:(...args)=>warnings.push(args)},require:()=>wrapped,dshCopy:inProcess(wrapped),
  ensureServiceAt:async dir=>{boots++;return state(dir);},connectService:async dir=>({call:async method=>{if(method==='initial')return state(dir);if(method==='shutdown')retired.push(dir);},close(){}})};
 const source=fs.readFileSync(require.resolve('../service-client.cjs'),'utf8'),start=source.indexOf('async function ensureService(dataDir,'),end=source.indexOf('\nfunction continuationStatus',start);
 const ensure=vm.runInNewContext(source.slice(start,end)+'\nensureService',ctx);
 return {root,key,target,env,retired,warnings,ctx,repair(){broken=false;restore();},calls:()=>inheritCalls,
  async start(endedServiceKey=null){offset=0;boots=0;await ensure(root,'/synthetic/electron',endedServiceKey);assert.equal(locked,false);return {layout:layout.readLayout(root),boots,inheritCalls};}};
}
for(const pending of [false,true])test('unqualified empty donor retires immediately and is not retried, pending='+pending,async t=>{
 const f=fixture(t,{fault:'unqualified',pending});
 for(let n=1;n<=3;n++){const r=await f.start();assert.deepEqual(r.layout.entries,[f.key]);assert.equal(r.inheritCalls,1);assert.equal(r.boots,n===1?2:1);assert.equal(tui.installed(f.target),false);assert.equal(r.layout.dshInheritance,undefined);}
 assert.deepEqual(f.retired,[f.root]);
});
for(const fault of ['deadline','filesystem'])for(const pending of [false,true])test('persistent '+fault+' stops after two attempts and releases an empty donor, pending='+pending,async t=>{
 const f=fixture(t,{fault,pending});const first=await f.start();assert.ok(first.layout.entries.includes('.'));assert.equal(first.inheritCalls,1);
 const [{item,elapsedMs,...row}]=first.layout.dshInheritance.failures;assert.deepEqual(row,{source:'.',target:f.key,attempts:1,reason:fault,stage:'files'});
 assert.ok(Number.isSafeInteger(item)&&item>=0);assert.ok(Number.isSafeInteger(elapsedMs)&&elapsedMs>=(fault==='deadline'?30000:0));
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
for(const targetFault of ['unsafe-parent','unreadable'])for(const pending of [false,true])for(const empty of [true,false])test('a refused '+targetFault+' target never retires or charges its qualified donor, pending='+pending+', empty='+empty,async t=>{
 const f=fixture(t,{targetFault,pending,empty});
 for(let n=1;n<=3;n++){
  const r=await f.start();assert.equal(r.inheritCalls,n);assert.equal(tui.installed(f.target),false);
  assert.ok(r.layout.entries.includes('.'),'the donor stays reachable');assert.equal(r.layout.dshInheritance,undefined,'nothing is recorded against the donor');
  assert.deepEqual(f.warnings.at(-1),['DSH runtime inheritance skipped:','target']);
 }
 tui.verifyRuntime(f.root);assert.deepEqual(f.retired,[]);
 f.repair();const r=await f.start();assert.equal(r.inheritCalls,4);assert.equal(tui.installed(f.target),true);tui.verifyRuntime(f.target);
 assert.equal(r.layout.dshInheritance,undefined);assert.deepEqual(r.layout.entries,empty?[f.key]:['.',f.key]);assert.deepEqual(f.retired,empty?[f.root]:[]);
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
 for(const bad of [null,{...valid,version:1},{...valid,failures:{}},{...valid,failures:[{...valid.failures[0],source:'../escape'}]},{...valid,failures:[{...valid.failures[0],target:null}]},{...valid,failures:[{...valid.failures[0],attempts:3}]},{...valid,failures:[{...valid.failures[0],reason:'raw-private-error'}]},{...valid,failures:[valid.failures[0],valid.failures[0]]},
  ...[{stage:'/private/path'},{stage:7},{stage:'x'.repeat(21)},{item:-1},{item:1.5},{item:'3'},{elapsedMs:null},{elapsedMs:-1}].map(part=>({...valid,failures:[{...valid.failures[0],...part}]}))]){
  layout.writeLayout(root,{...base,dshInheritance:bad});assert.throws(()=>layout.readLayout(root),e=>e.uiMessage?.key==='error.service.invalidLayout');
 }
 const where={...valid,failures:[{...valid.failures[0],stage:'files',item:40000,elapsedMs:120412}]};
 for(const good of [valid,where]){layout.writeLayout(root,{...base,dshInheritance:good});assert.deepEqual(layout.readLayout(root).dshInheritance,good);}
});
test('a failing donor does not retire another runtime before that source gets its turn',async t=>{
 const f=fixture(t,{fault:'filesystem'}),other='backends/dddddddddddddddddddd';runtime(path.join(f.root,other));
 const initial=layout.readLayout(f.root);initial.entries.splice(1,0,other);layout.writeLayout(f.root,initial);
 for(let n=0;n<2;n++){const r=await f.start();assert.ok(r.layout.entries.includes(other),'unattempted source must remain reachable');}
 const r=await f.start();assert.equal(r.inheritCalls,3);assert.equal(tui.installed(f.target),true);assert.deepEqual(r.layout.entries,[f.key]);
});
test('a failure recorded by an older version keeps its count and gains where the next one stopped',async t=>{
 const f=fixture(t,{fault:'deadline',empty:false}),state=layout.readLayout(f.root);state.dshInheritance={version:'synthetic-v1',failures:[{source:'.',target:f.key,attempts:1,reason:'deadline'}]};layout.writeLayout(f.root,state);
 const r=await f.start(),[row]=r.layout.dshInheritance.failures;assert.equal(row.attempts,2);assert.equal(row.stage,'files');assert.ok(Number.isSafeInteger(row.item));
 await f.start();assert.equal(f.calls(),1);
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


test('repeated unsafe target warnings are deduplicated without skipping any precheck',async t=>{
 const f=fixture(t,{targetFault:'unsafe-parent'}),original=tui.inheritRuntime;let checking=false,sourceReads=0,writes=0;
 for(const [io,name] of [[fs,'lstatSync'],[fs,'readFileSync'],[fs.promises,'readdir'],[fs.promises,'open']]){
  const method=io[name];t.mock.method(io,name,function(file,...args){if(checking&&(String(file)===f.root||String(file).startsWith(tui.paths(f.root).root)))sourceReads++;return Reflect.apply(method,this,[file,...args]);});
 }
 for(const name of ['mkdtemp','mkdir','rename','copyFile']){const method=fs.promises[name];t.mock.method(fs.promises,name,function(...args){if(checking)writes++;return Reflect.apply(method,this,args);});}
 t.mock.method(tui,'inheritRuntime',async(...args)=>{checking=true;try{return await original(...args);}finally{checking=false;}});
 for(let i=0;i<10;i++)await f.start();
 assert.equal(f.calls(),10,'every startup must still inspect target permissions');assert.equal(sourceReads,0);assert.equal(writes,0);
 assert.equal(tui.installed(f.target),false);assert.ok(layout.readLayout(f.root).entries.includes('.'));assert.deepEqual(f.retired,[]);assert.equal(layout.readLayout(f.root).dshInheritance,undefined);
 const warnings=f.warnings.length;console.log('TARGET_WARNING_CHECK '+JSON.stringify({prechecks:f.calls(),sourceReads,writes,warnings}));
 f.repair();await f.start();assert.equal(tui.installed(f.target),true);tui.verifyRuntime(f.target);
 assert.equal(warnings,1,'unchanged target refusal should warn once');
});
test('target state or reason changes and a repair cycle permit a fresh warning',async t=>{
 const f=fixture(t,{targetFault:'unsafe-parent',empty:false}),base=tui.paths(f.target).base,original=tui.inheritRuntime;let reason=null;
 t.mock.method(tui,'inheritRuntime',(...args)=>reason?Promise.reject(Object.assign(Error('synthetic refusal'),{reason})):original(...args));
 await f.start();await f.start();assert.equal(f.warnings.length,1);
 await new Promise(resolve=>setTimeout(resolve,5));fs.chmodSync(base,0o700);fs.chmodSync(base,0o770);
 await f.start();await f.start();assert.equal(f.warnings.length,2,'a repair between startups must not hide a later refusal');
 fs.chmodSync(base,0o772);await f.start();await f.start();assert.equal(f.warnings.length,3,'changed unsafe permissions warn again');
 reason='filesystem';await f.start();assert.equal(f.warnings.at(-1)[1],'filesystem');
 reason=null;await f.start();await f.start();assert.equal(f.warnings.length,5,'a changed refusal reason resets target diagnostics');
 f.repair();await f.start();assert.equal(tui.installed(f.target),true);tui.verifyRuntime(f.target);assert.equal(layout.readLayout(f.root).dshInheritance,undefined);
 fs.rmSync(tui.paths(f.target).root,{recursive:true,force:true});fs.chmodSync(base,0o770);
 await f.start();await f.start();assert.equal(f.warnings.length,6,'repair followed by refusal warns once again');
 assert.equal(tui.installed(f.target),false);assert.deepEqual(f.retired,[]);
 assert.deepEqual(f.warnings.map(w=>w[1]),['target','target','target','filesystem','target','target']);
 assert.ok(f.warnings.every(w=>w.length===2&&!w.join(' ').includes(f.root)),'diagnostics contain no paths or private error details');
});
