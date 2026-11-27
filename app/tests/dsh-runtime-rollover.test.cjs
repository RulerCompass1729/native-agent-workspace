const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const { readRetiredBackend } = require('../retired-backend.cjs');
const tui=require('../dsh-tui.cjs'),{qualification,runtime,inProcess}=require('./helpers/dsh-runtime.cjs'),layout=require('../service-layout.cjs');
for(const kind of ['new','pending','reused'])test(kind+' backend retains a qualified DSH runtime through real ensureService selection',async t=>{
 qualification(t);const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'naw-dsh-rollover-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));runtime(root);
 const slot='backends/aaaaaaaaaaaaaaaaaaaa',dest=path.join(root,slot);if(kind!=='new')fs.mkdirSync(dest,{recursive:true,mode:0o700});
 if(kind==='pending')layout.writeLayout(root,{format:1,active:'.',entries:['.'],pending:slot});if(kind==='reused')layout.writeLayout(root,{format:1,active:'.',entries:['.',slot]});
 const source=fs.readFileSync(require.resolve('../service-client.cjs'),'utf8'),start=source.indexOf('async function ensureService(dataDir,'),end=source.indexOf('\nfunction continuationStatus',start);assert.ok(start>0&&end>start);const calls=[];
 const ctx={fs,path,crypto,__dirname:path.join(__dirname,'..'),process:{env:{NAW_APP_VERSION:'synthetic-new'}},dshCopy:inProcess(tui),uiError:key=>Error(key),...layout,readRetiredBackend,readLock:()=>undefined,createLock:()=>({}),releaseLock:()=>true,ownerMayBeAlive:()=>false,emptyService:()=>false,emptyStore:()=>false,
  require(name){assert.equal(name,'./dsh-tui.cjs');return tui;},ensureServiceAt:async dir=>{calls.push(dir);return {runtimeVersion:dir===root?'synthetic-old':'synthetic-new',sessions:dir===root?[{id:'synthetic-record',state:'error'}]:[],room:{messages:[]}};},connectService:async()=>({call:async()=>{},close(){}})};
 await vm.runInNewContext(source.slice(start,end)+'\nensureService',ctx)(root,'/synthetic/electron');const after=layout.readLayout(root),selected=path.join(root,after.active);
 assert.match(after.active,/^backends\//);assert.equal(tui.installed(root),true);assert.equal(tui.installed(selected),true,'selected backend lost DSH runtime');tui.verifyRuntime(selected);assert.equal(after.pending,undefined);assert.ok(calls.includes(selected));
 if(kind==='reused')assert.equal(calls.filter(x=>x===dest).length,1,'already running reused backend is not restarted');
});

for (const kind of ['stale-pin','unsafe-source','timeout','empty-target','unsafe-target','io-failure','unexpected-error']) test(kind+' inheritance cannot block rollover or the next startup',async t=>{
 qualification(t);
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'naw-dsh-rollover-refusal-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const sourceRuntime=runtime(root),slot='backends/bbbbbbbbbbbbbbbbbbbb',dest=path.join(root,slot),warnings=[];
 fs.mkdirSync(dest,{recursive:true,mode:0o700});layout.writeLayout(root,{format:1,active:'.',entries:['.'],pending:slot});
 if(kind==='stale-pin')fs.writeFileSync(path.join(sourceRuntime.tui,'package.json'),JSON.stringify({version:'old-synthetic'}));
 if(kind==='unsafe-source'){const file=path.join(sourceRuntime.root,'unsafe');fs.writeFileSync(file,'fixture');fs.chmodSync(file,0o664);}
 if(kind==='empty-target')fs.mkdirSync(tui.paths(dest).root,{recursive:true,mode:0o700});
 if(kind==='unsafe-target'){const where=runtime(dest),file=path.join(where.root,'unsafe');fs.writeFileSync(file,'fixture');fs.chmodSync(file,0o664);}
 if(kind==='unexpected-error')t.mock.method(tui,'inheritRuntime',async()=>{throw Error('SYNTHETIC_PRIVATE_DIAGNOSTIC');});
 if(kind==='io-failure'){const open=fs.promises.open;t.mock.method(fs.promises,'open',async function(file,...args){if(String(file).startsWith(sourceRuntime.root))throw Object.assign(Error('synthetic disk failure'),{code:'EIO'});return Reflect.apply(open,this,[file,...args]);});}
 if(kind==='timeout'){
  const {performance}=require('node:perf_hooks'),now=performance.now.bind(performance),open=fs.promises.open;let offset=0;
  t.mock.method(performance,'now',()=>now()+offset);
  t.mock.method(fs.promises,'open',async function(file,...args){if(String(file).startsWith(sourceRuntime.root))offset+=31000;return Reflect.apply(open,this,[file,...args]);});
 }
 const source=fs.readFileSync(require.resolve('../service-client.cjs'),'utf8'),start=source.indexOf('async function ensureService(dataDir,'),end=source.indexOf('\nfunction continuationStatus',start),calls=[];let locked=false;
 const ctx={fs,path,crypto,__dirname:path.join(__dirname,'..'),process:{env:{NAW_APP_VERSION:'synthetic-new'}},dshCopy:inProcess(tui),uiError:key=>Error(key),...layout,readRetiredBackend,readLock:()=>undefined,createLock:()=>{locked=true;return {};},releaseLock:()=>{locked=false;return true;},ownerMayBeAlive:()=>false,emptyService:()=>false,emptyStore:()=>false,
  console:{warn:(...args)=>warnings.push(args)},require(name){assert.equal(name,'./dsh-tui.cjs');assert.equal(locked,true);return tui;},
  ensureServiceAt:async dir=>{calls.push(dir);return {runtimeVersion:dir===root?'synthetic-old':'synthetic-new',sessions:dir===root?[{id:'retained',state:'error'}]:[],room:{messages:[]}};},connectService:async()=>({call:async()=>{},close(){}})};
 const ensure=vm.runInNewContext(source.slice(start,end)+'\nensureService',ctx);
 for(let attempt=0;attempt<2;attempt++){
  await ensure(root,'/synthetic/electron');const after=layout.readLayout(root);assert.equal(after.active,slot);assert.equal(after.pending,undefined);assert.ok(calls.includes(dest));assert.equal(locked,false);
  const {NativeHost}=require('../adapters.cjs');
  const host=Object.assign(Object.create(NativeHost.prototype),{dataDir:dest,serviceBinding:null,binaries:{codex:process.execPath,python:process.execPath},resolvePrograms(){return this.binaries;}});
  const codex=host.create({id:'synthetic-codex',provider:'codex',view:'chat',cwd:root,messages:[]});assert.equal(codex.chatAvailable,true);
  if(kind!=='unsafe-target')assert.throws(()=>host.create({id:'synthetic-dsh',provider:'dsh'}),e=>e.uiMessage?.key==='error.dsh.runtimeUnqualified');
 }
 assert.equal(warnings.length,['timeout','io-failure'].includes(kind)?2:1);assert.ok(!JSON.stringify(warnings).includes('SYNTHETIC_PRIVATE_DIAGNOSTIC'));
 assert.equal(warnings[0][1],kind==='timeout'?'deadline':kind==='io-failure'?'filesystem':kind==='unexpected-error'?'unavailable':kind.endsWith('-target')?'target':'unqualified');
 if(kind==='unsafe-target'){
  const dsh=new tui.DshTui({id:'synthetic-dsh'}, {dataDir:dest,binaries:{dsh:process.execPath}}, {key:async()=>assert.fail('No key read')});
  dsh.launch=async()=>assert.fail('Unsafe target must not launch');
  await assert.rejects(dsh.start(),e=>e.uiMessage?.key==='error.dsh.runtimeUnsafe');
 }
});

test('inheritance fallback does not hide a real service bootstrap failure',async t=>{
 const file=require.resolve('../service-client.cjs'),source=fs.readFileSync(file,'utf8'),start=source.indexOf('async function ensureService(dataDir,'),end=source.indexOf('\nfunction continuationStatus',start);
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'naw-dsh-service-error-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const failure=Error('synthetic service bootstrap failure');
 const ctx={fs,path,crypto,__dirname:path.join(__dirname,'..'),process:{env:{}},uiError:key=>Error(key),...layout,readRetiredBackend,readLock:()=>undefined,createLock:()=>({}),releaseLock:()=>true,ensureServiceAt:async()=>{throw failure;}};
 await assert.rejects(vm.runInNewContext(source.slice(start,end)+'\nensureService',ctx)(root,'/synthetic/electron'),e=>e===failure);
});

for (const kind of ['io-failure', 'deadline']) for (const empty of [false, true]) test(kind+' is retried on the next locked startup, empty donor='+empty, async t=>{
 qualification(t);
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'naw-dsh-retry-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const sourceRuntime=runtime(root),slot='backends/cccccccccccccccccccc',dest=path.join(root,slot);
 fs.mkdirSync(dest,{recursive:true,mode:0o700});layout.writeLayout(root,{format:1,active:'.',entries:['.'],pending:slot});
 const {performance}=require('node:perf_hooks'),now=performance.now.bind(performance),open=fs.promises.open;let broken=true,offset=0,locked=false;
 t.mock.method(performance,'now',()=>now()+offset);
 t.mock.method(fs.promises,'open',async function(file,...args){
  if(broken&&String(file).startsWith(sourceRuntime.root)){
   if(kind==='deadline')offset=31000;else throw Object.assign(Error('synthetic EIO'),{code:'EIO'});
  }
  return Reflect.apply(open,this,[file,...args]);
 });
 const source=fs.readFileSync(require.resolve('../service-client.cjs'),'utf8'),start=source.indexOf('async function ensureService(dataDir,'),end=source.indexOf('\nfunction continuationStatus',start);
 const retired=[],state=dir=>({runtimeVersion:dir===root?'synthetic-old':'synthetic-new',sessions:empty||dir!==root?[]:[{id:'retained',state:'error'}],room:{messages:[]}});
 const ctx={fs,path,crypto,__dirname:path.join(__dirname,'..'),process:{env:{NAW_APP_VERSION:'synthetic-new'}},dshCopy:inProcess(tui),uiError:key=>Error(key),...layout,readRetiredBackend,
  readLock:()=>undefined,createLock:()=>{locked=true;return {};},releaseLock:()=>{locked=false;return true;},ownerMayBeAlive:()=>false,
  emptyService:s=>s.sessions.length===0,emptyStore:()=>true,lockIdentity:()=>({pid:12345}),waitForShutdown:async()=>{},console:{warn(){}},
  require(name){assert.equal(name,'./dsh-tui.cjs');assert.equal(locked,true);return tui;},ensureServiceAt:async dir=>state(dir),
  connectService:async(dir)=>({call:async method=>{if(method==='initial')return state(dir);if(method==='shutdown')retired.push(dir);},close(){}})};
 const ensure=vm.runInNewContext(source.slice(start,end)+'\nensureService',ctx);
 await ensure(root,'/synthetic/electron');
 assert.equal(layout.readLayout(root).active,slot);assert.equal(layout.readLayout(root).pending,undefined);assert.equal(tui.installed(dest),false);
 assert.ok(layout.readLayout(root).entries.includes('.'),'failed inheritance retains its only donor');assert.equal(retired.length,0);
 broken=false;offset=0;
 await ensure(root,'/synthetic/electron');
 assert.equal(tui.installed(dest),true,'second startup must recover DSH without another version change');tui.verifyRuntime(dest);assert.equal(locked,false);
 if(empty){assert.deepEqual(retired,[root]);assert.deepEqual(layout.readLayout(root).entries,[slot]);}
 await ensure(root,'/synthetic/electron');assert.equal(tui.installed(dest),true);
});

for(const pending of [false,true])test('a missing active runtime skips an unqualified donor and inherits a qualified retained backend, pending='+pending,async t=>{
 qualification(t);const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'naw-dsh-donors-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const old=runtime(root);fs.writeFileSync(path.join(old.tui,'package.json'),JSON.stringify({version:'old-synthetic'}));
 const active='backends/dddddddddddddddddddd',donor='backends/eeeeeeeeeeeeeeeeeeee';fs.mkdirSync(path.join(root,active),{recursive:true,mode:0o700});runtime(path.join(root,donor));
 layout.writeLayout(root,pending?{format:1,active:'.',entries:['.',donor],pending:active}:{format:1,active,entries:['.',active,donor]});
 const source=fs.readFileSync(require.resolve('../service-client.cjs'),'utf8'),start=source.indexOf('async function ensureService(dataDir,'),end=source.indexOf('\nfunction continuationStatus',start);let locked=false,warnings=0;
 const ctx={fs,path,crypto,__dirname:path.join(__dirname,'..'),process:{env:{NAW_APP_VERSION:'synthetic-new'}},dshCopy:inProcess(tui),uiError:key=>Error(key),...layout,readRetiredBackend,
  readLock:()=>undefined,createLock:()=>{locked=true;return {};},releaseLock:()=>{locked=false;return true;},ownerMayBeAlive:()=>false,emptyService:()=>false,
  console:{warn(){warnings++;}},require(){assert.equal(locked,true);return tui;},ensureServiceAt:async()=>({runtimeVersion:'synthetic-new',sessions:[]}),connectService:async()=>({call:async()=>{},close(){}})};
 await vm.runInNewContext(source.slice(start,end)+'\nensureService',ctx)(root,'/synthetic/electron');
 assert.equal(warnings,1);assert.equal(layout.readLayout(root).active,active);assert.equal(tui.installed(path.join(root,active)),true);tui.verifyRuntime(path.join(root,active));assert.equal(locked,false);
});
