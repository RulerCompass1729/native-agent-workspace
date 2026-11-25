'use strict';
// A slow runtime copy must hold up neither the start nor the install, and DSH must appear later by itself.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const tui=require('../dsh-tui.cjs'),layout=require('../service-layout.cjs'),locks=require('../service-lock.cjs'),{qualification,runtime,write}=require('./helpers/dsh-runtime.cjs');
const preload=require.resolve('./helpers/dsh-copy-child.cjs');require(preload);
let dshCopy;try{dshCopy=require('../dsh-copy.cjs');}catch{/* The code before this change copies in the caller. */}
const cp=require('node:child_process');
const KEY='backends/aaaaaaaaaaaaaaaaaaaa',OTHER='backends/bbbbbbbbbbbbbbbbbbbb',VERSION='synthetic-new';
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,what,limit=10000){const end=Date.now()+limit;while(!check()){assert.ok(Date.now()<end,what);await wait(20);}}
function environment(t,values){for(const [key,value] of Object.entries(values)){const old=process.env[key];process.env[key]=value;t.after(()=>{if(old===undefined)delete process.env[key];else process.env[key]=old;});}}
function fixture(t,{files=40,slow={},limits={},pending=true,row=true,other=false,donorSessions=[],copy}={}){
 qualification(t);
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'naw-dsh-background-')));
 t.after(async()=>{await until(()=>!copier(),'a copier still runs at the end').catch(()=>{});fs.rmSync(root,{recursive:true,force:true});});
 const donor=runtime(root),target=path.join(root,KEY);fs.mkdirSync(target,{recursive:true,mode:0o700});
 for(let i=0;i<files;i++)write(path.join(donor.root,'padding-'+String(i).padStart(4,'0')),'synthetic '+i);
 if(other)runtime(path.join(root,OTHER));
 const sources=other?['.',OTHER]:['.'];
 layout.writeLayout(root,{...(pending?{format:1,active:'.',entries:sources,pending:KEY}:{format:1,active:KEY,entries:[...sources,KEY]}),
  ...(row?{dshInheritance:{version:VERSION,failures:[{source:'.',target:KEY,attempts:1,reason:'deadline'}]}}:{})});
 environment(t,{NODE_OPTIONS:'--require '+JSON.stringify(preload),NAW_TEST_DSH_CHILD:'1',NAW_TEST_DSH_SLOW_ROOT:donor.root,NAW_TEST_DSH_FILE_MS:String(slow.fileMs||0),NAW_TEST_DSH_CLOCK_MS:String(slow.clockMs||0)});
 const retired=[],warnings=[];let copies=0;
 const state=dir=>({runtimeVersion:dir===root?'synthetic-old':VERSION,sessions:dir===root?donorSessions:[],room:{messages:[]}});
 const ctx={fs,path,crypto,__dirname:path.join(__dirname,'..'),process:{env:{NAW_APP_VERSION:VERSION}},uiError:key=>Error(key),...layout,...locks,
  console:{warn:(...args)=>warnings.push(args)},waitForShutdown:async()=>{},emptyService:s=>s.sessions.length===0,emptyStore:()=>true,
  require(name){assert.equal(name,'./dsh-tui.cjs');return tui;},ensureServiceAt:async dir=>state(dir),
  connectService:async dir=>({call:async method=>{if(method==='shutdown')retired.push(dir);return state(dir);},close(){}}),
  dshCopy:dshCopy&&{...dshCopy,start:(...args)=>dshCopy.start(...args,limits),copy:(...args)=>{copies++;return (copy||dshCopy.copy)(...args);}}};
 const source=fs.readFileSync(require.resolve('../service-client.cjs'),'utf8'),start=source.indexOf('async function ensureService(dataDir,'),end=source.indexOf('\nfunction continuationStatus',start);
 const ensure=vm.runInNewContext(source.slice(start,end)+'\nensureService',ctx);
 const staging=()=>fs.readdirSync(target).filter(name=>name.startsWith('.dsh-tui-inherit-'));
 const copier=()=>{try{const record=JSON.parse(fs.readFileSync(path.join(target,'dsh-copy.lock'),'utf8'));process.kill(record.pid,0);return record;}catch{return null;}};
 return {root,target,donor,retired,warnings,ctx,staging,copier,copies:()=>copies,ensure:(executable=process.execPath)=>ensure(root,executable),rows:()=>layout.readLayout(root).dshInheritance?.failures,layout:()=>layout.readLayout(root),locked:()=>fs.existsSync(path.join(root,'services.lock'))};
}
// Every step moves, but the copy as a whole takes over two minutes of its own clock and outlasts the start's wait.
const SLOW={fileMs:100,clockMs:3000};

test('a copy that outlasts the start finishes in the background without another start',async t=>{
 const f=fixture(t,{slow:SLOW,limits:{waitMs:150}});
 await f.ensure();
 assert.equal(f.layout().active,KEY);assert.equal(f.layout().pending,undefined);
 assert.equal(tui.installed(f.target),false,'the copy is still running');assert.equal(f.locked(),false);
 if(dshCopy){
  await until(()=>f.staging().length===1,'the copy has begun');const owner=f.copier(),staging=f.staging();
  await f.ensure();
  assert.equal(f.copier().pid,owner.pid);assert.equal(f.copies(),1,'a second start begins no second copy');assert.deepEqual(f.staging(),staging);
  assert.deepEqual(f.layout().entries,['.',KEY],'the runtime being copied keeps its backend');assert.deepEqual(f.retired,[]);
 }
 await until(()=>tui.installed(f.target),'DSH appears without another start');
 await until(()=>f.layout().dshInheritance===undefined,'the failure record is cleared');
 tui.verifyRuntime(f.target);assert.equal(fs.readFileSync(path.join(tui.paths(f.target).root,'padding-0039'),'utf8'),'synthetic 39');
 await until(()=>f.staging().length===0&&!fs.existsSync(path.join(f.target,'dsh-copy.lock')),'the copier leaves nothing behind');
 assert.equal(f.locked(),false);assert.deepEqual(f.warnings,[]);
 await f.ensure();assert.deepEqual(f.retired,[f.root]);assert.deepEqual(f.layout().entries,[KEY]);
});

test('a source that stops moving in the background is recorded and the next one is copied after a pause',async t=>{
 const f=fixture(t,{slow:{fileMs:100,clockMs:31000},limits:{waitMs:20,retryMs:1500},row:false,other:true});
 await f.ensure();assert.equal(f.layout().active,KEY);
 await until(()=>f.rows(),'the failure is recorded');
 assert.deepEqual(f.rows().map(({source,target,attempts,reason,stage})=>({source,target,attempts,reason,stage})),[{source:'.',target:KEY,attempts:1,reason:'deadline',stage:'files'}]);
 assert.equal(f.locked(),false);assert.equal(tui.installed(f.target),false);
 assert.deepEqual(f.layout().entries,['.',OTHER,KEY],'both sources are kept');assert.deepEqual(f.retired,[]);
 await until(()=>tui.installed(f.target),'the other source is copied');await until(()=>!f.layout().dshInheritance,'the record is cleared');
 assert.equal(fs.existsSync(path.join(tui.paths(f.target).root,'padding-0000')),false,'the copy is of the second source');
 assert.deepEqual(f.warnings,[['DSH runtime inheritance skipped:','deadline']]);
});

for(const [reason,calls,rows] of [['stopped',3,undefined],['filesystem',2,[{source:'.',target:KEY,attempts:2,reason:'filesystem'}]],['target',1,undefined]])test('a background copy refused with '+reason+' is tried '+calls+' times in all',async t=>{
 let tried=0;
 const f=fixture(t,{limits:{waitMs:5,retryMs:30},row:false,copy:async()=>{tried++;await wait(20);throw Object.assign(Error('synthetic'),{reason});}});
 await f.ensure();await until(()=>tried===calls,'every try is made');await wait(300);
 assert.equal(tried,calls);assert.deepEqual(f.rows(),rows);assert.equal(f.layout().active,KEY);assert.equal(f.locked(),false);
});

for(const [change,next,tried] of [['its backend is no longer in use',{format:1,active:'.',entries:['.',OTHER]},['.']],['one source is gone',{format:1,active:KEY,entries:['.',KEY]},['.','.','.']]])test('a later try reads the layout again: '+change,async t=>{
 const sources=[];
 const f=fixture(t,{limits:{waitMs:5,retryMs:100},row:false,other:true,copy:async(_executable,source)=>{sources.push(path.relative(f.root,source)||'.');await wait(20);throw Object.assign(Error('synthetic'),{reason:'stopped'});}});
 await f.ensure();await until(()=>f.warnings.length===1,'the first try ends');layout.writeLayout(f.root,next);
 await wait(500);assert.deepEqual(sources,tried);
});

test('no copier is started when no backend has a runtime',async t=>{
 const f=fixture(t,{row:false});fs.rmSync(f.donor.base,{recursive:true});
 await f.ensure();assert.equal(f.copies(),0);assert.equal(f.layout().active,KEY);assert.deepEqual(f.warnings,[]);
});

test('a copier ended without a verdict charges nobody and is started again',async t=>{
 const f=fixture(t,{slow:{fileMs:100},limits:{waitMs:20,retryMs:300},row:false});
 await f.ensure();await until(()=>f.copier()&&f.staging().length===1,'the copy has begun');
 const first=f.copier(),half=f.staging()[0];process.kill(first.pid,'SIGKILL');
 await until(()=>tui.installed(f.target),'the copy is made again');await until(()=>f.staging().length===0,'the half directory is cleared');
 tui.verifyRuntime(f.target);assert.equal(fs.existsSync(path.join(f.target,half)),false);assert.equal(f.rows(),undefined);
 assert.deepEqual(f.warnings,[['DSH runtime inheritance skipped:','stopped']]);
});

test('a copier that cannot be started does not hold up the start',async t=>{
 const f=fixture(t,{row:false});
 await f.ensure(path.join(f.root,'no-such-executable'));
 assert.equal(f.layout().active,KEY);assert.equal(f.layout().pending,undefined);assert.equal(f.rows(),undefined);assert.deepEqual(f.layout().entries,['.',KEY]);
 assert.deepEqual(f.warnings,[['DSH runtime inheritance skipped:','stopped']]);
});

test('a second copier leaves a live half directory alone and waits for its owner',async t=>{
 const f=fixture(t,{slow:{fileMs:200},row:false});
 const first=dshCopy.copy(process.execPath,f.root,f.target);await until(()=>f.copier()&&f.staging().length===1,'the copy has begun');
 const owner=f.copier(),staging=f.staging();let ended=false;
 const second=dshCopy.copy(process.execPath,f.root,f.target).finally(()=>{ended=true;});await wait(500);
 assert.equal(f.copier().pid,owner.pid);assert.deepEqual(f.staging(),staging);assert.equal(ended,false);
 assert.equal((await first).status,'copied');assert.equal((await second).status,'existing');
 tui.verifyRuntime(f.target);assert.equal(fs.existsSync(path.join(f.target,'dsh-copy.lock')),false);
});

test('the copier ends with the process that started it, and the next start clears its half directory',async t=>{
 const f=fixture(t,{slow:{fileMs:300},row:false});
 const parent=cp.spawn(process.execPath,['-e','require(process.argv[1]).copy(process.execPath,process.argv[2],process.argv[3]);setInterval(()=>{},1000);',require.resolve('../dsh-copy.cjs'),f.root,f.target],{stdio:'ignore'});
 t.after(()=>parent.kill('SIGKILL'));
 await until(()=>f.copier()&&f.staging().length===1,'the copy has begun');const owner=f.copier(),half=f.staging()[0];
 parent.kill('SIGKILL');await until(()=>!alive(owner.pid),'the copier ends');
 assert.deepEqual(f.staging(),[half]);assert.equal(tui.installed(f.target),false);
 process.env.NAW_TEST_DSH_FILE_MS='0';await f.ensure();
 tui.verifyRuntime(f.target);assert.deepEqual(f.staging(),[]);assert.equal(fs.existsSync(path.join(f.target,'dsh-copy.lock')),false);assert.deepEqual(f.warnings,[]);
});

test('a finished background copy waits for another start to let go before it clears its record',async t=>{
 const f=fixture(t,{slow:{fileMs:30},limits:{waitMs:20}});await f.ensure();
 const file=path.join(f.root,'services.lock'),lock=locks.createLock(file,'startup',f.root);
 await until(()=>tui.installed(f.target),'the copy ends');await wait(1300);
 assert.ok(f.rows(),'nothing is written while another start holds the lock');assert.deepEqual(locks.readLock(file).token,lock.token);
 assert.equal(locks.releaseLock(file,lock),true);await until(()=>!f.rows(),'the record is cleared');assert.equal(f.locked(),false);
});

test('a start clears the record of a copy that finished just as its window ended',async t=>{
 const f=fixture(t,{pending:false,donorSessions:[{id:'retained',state:'ended'}]});runtime(f.target);assert.ok(f.rows());
 await f.ensure();assert.equal(f.rows(),undefined);assert.deepEqual(f.layout().entries,['.',KEY]);assert.deepEqual(f.warnings,[]);
});

test('copying is not slowed by a busy process: 30 ms of every turn costs at most three times the idle time',async t=>{
 const time=async busy=>{
  const f=fixture(t,{files:150,row:false});let on=busy,turns=0;
  const spin=()=>{if(!on)return;const end=Date.now()+30;while(Date.now()<end);turns++;setImmediate(spin);};
  setImmediate(spin);const started=Date.now();
  try{await f.ensure();await until(()=>tui.installed(f.target),'the copy ends',60000);}finally{on=false;}
  const elapsed=Date.now()-started;tui.verifyRuntime(f.target);return {elapsed,turns};
 };
 const idle=await time(false),busy=await time(true);
 console.log('BUSY_COPY '+JSON.stringify({idleMs:idle.elapsed,busyMs:busy.elapsed,busyTurns:busy.turns}));
 // The floor keeps a loaded machine from failing runs of a tenth of a second; the copy in the caller took over six.
 assert.ok(busy.elapsed<=Math.max(idle.elapsed*3,2000),`${busy.elapsed} ms against ${idle.elapsed} ms idle`);
});
