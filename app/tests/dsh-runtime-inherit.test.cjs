const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),os=require('node:os');
const tui=require('../dsh-tui.cjs'),{qualification,runtime,write}=require('./helpers/dsh-runtime.cjs');
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'naw-dsh-inherit-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'source'),target=path.join(root,'target');fs.mkdirSync(source,{mode:0o700});fs.mkdirSync(target,{mode:0o700});return {root,source,target};
}
const inherit=(f)=>tui.inheritRuntime(f.source,f.target);
const refused = pattern => error => error.code === 'dsh-runtime-inheritance-refused' && pattern.test(error.cause?.message || '');

test('a qualified runtime is copied and independently qualified, without private siblings',async t=>{
 const calls=qualification(t),f=fixture(t),s=runtime(f.source);
 for(const name of ['home/.dsh/key','session-home/history','credential','workspace.json'])write(path.join(s.base,name),'SYNTHETIC_PRIVATE_NEVER_COPY');
 write(path.join(s.root,'node_modules/example/tool.js'),'synthetic tool');fs.chmodSync(path.join(s.root,'node_modules/example/tool.js'),0o700);
 fs.mkdirSync(path.join(s.root,'node_modules/.bin'),{mode:0o700});fs.symlinkSync('../example/tool.js',path.join(s.root,'node_modules/.bin/example'));
 const result=await inherit(f);assert.equal(result.status,'copied');assert.equal(tui.installed(f.target),true);tui.verifyRuntime(f.target);assert.ok(calls()>=4);
 const d=tui.paths(f.target);assert.deepEqual(fs.readdirSync(d.base),['runtime']);assert.equal(fs.readFileSync(path.join(d.root,'node_modules/example/tool.js'),'utf8'),'synthetic tool');
 assert.equal(fs.readlinkSync(path.join(d.root,'node_modules/.bin/example')),'../example/tool.js');assert.ok(fs.statSync(path.join(d.root,'node_modules/example/tool.js')).mode&0o100);
 assert.equal(fs.readFileSync(path.join(s.base,'home/.dsh/key'),'utf8'),'SYNTHETIC_PRIVATE_NEVER_COPY');
});
test('an absent source refuses copying without creating a runtime',async t=>{
 qualification(t);const f=fixture(t);const r=await inherit(f);assert.equal(r.status,'absent');assert.equal(fs.existsSync(tui.paths(f.target).root),false);
});
for(const part of ['version','privacy','update'])test('a damaged '+part+' source is refused before publication',async t=>{
 qualification(t);const f=fixture(t),s=runtime(f.source);const file=part==='version'?path.join(s.tui,'package.json'):part==='privacy'?path.join(s.root,'node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js'):path.join(s.tui,'lib/types/update.js');
 const cause = { version: /DSH TUI runtime: .* is not /, privacy: /DSH privacy patch: unqualified upstream source/, update: /Unqualified synthetic update source/ }[part];
 write(file,'damaged');await assert.rejects(inherit(f),refused(cause));assert.equal(fs.existsSync(tui.paths(f.target).root),false);assert.equal(fs.readFileSync(file,'utf8'),'damaged');
});
test('an existing qualified target is validated without replacement, even if the source is absent',async t=>{
 const count=qualification(t),f=fixture(t),d=runtime(f.target),file=path.join(d.root,'marker');write(file,'target-only');const before=fs.statSync(file);const r=await inherit(f);
 assert.equal(r.status,'existing');assert.ok(count()>=2);assert.equal(fs.statSync(file).ino,before.ino);assert.equal(fs.readFileSync(file,'utf8'),'target-only');
});
for(const kind of ['empty','invalid'])test('an existing '+kind+' target is preserved and refused',async t=>{
 qualification(t);const f=fixture(t);runtime(f.source);const d=tui.paths(f.target);fs.mkdirSync(d.root,{recursive:true,mode:0o700});if(kind==='invalid')write(path.join(d.root,'package.json'),'unchanged');const ino=fs.statSync(d.root).ino;
 await assert.rejects(inherit(f),refused(/DSH TUI runtime: .* is not /));assert.equal(fs.statSync(d.root).ino,ino);assert.deepEqual(fs.readdirSync(d.root),kind==='invalid'?['package.json']:[]);
});
test('a failed copy leaves the source intact and can be retried',async t=>{
 qualification(t);const f=fixture(t),s=runtime(f.source),original=fsp.open;let calls=0;
 const mock=t.mock.method(fsp,'open',async function(file,...args){if(String(file).startsWith(s.root)&&++calls===3)throw Object.assign(Error('synthetic copy interruption'),{code:'EIO'});return Reflect.apply(original,this,[file,...args]);});
 await assert.rejects(inherit(f),refused(/synthetic copy interruption/));assert.equal(fs.existsSync(tui.paths(f.target).root),false);tui.verifyRuntime(f.source);assert.ok(!fs.readdirSync(f.target).some(x=>x.startsWith('.dsh-tui-inherit-')));
 mock.mock.restore();assert.equal((await inherit(f)).status,'copied');tui.verifyRuntime(f.target);
});
for(const kind of ['outside-link','relative-outside-link','linked-root','linked-base','hard-link','foreign-owner','foreign-source-owner'])test(kind+' is refused without changing outside content',async t=>{
 qualification(t);const f=fixture(t),s=runtime(f.source);const outside=path.join(f.root,'outside');write(outside,'SYNTHETIC_OUTSIDE');
 if(kind==='outside-link')fs.symlinkSync(outside,path.join(s.root,'outside'));
 if(kind==='relative-outside-link')fs.symlinkSync(path.relative(s.root,outside),path.join(s.root,'outside'));
 if(kind==='linked-base'){const saved=path.join(f.root,'saved-base');fs.renameSync(s.base,saved);fs.symlinkSync(saved,s.base);}
 if(kind==='linked-root'){fs.renameSync(s.root,path.join(s.base,'saved'));fs.symlinkSync(path.join(s.base,'saved'),s.root);}
 if(kind==='hard-link')fs.linkSync(outside,path.join(s.root,'outside'));
 if(kind==='foreign-owner')t.mock.method(process,'getuid',()=>fs.statSync(f.source).uid+1);
 if(kind==='foreign-source-owner'){const original=fs.lstatSync;t.mock.method(fs,'lstatSync',function(file,...args){const stat=Reflect.apply(original,this,[file,...args]);return file===f.source?Object.assign(Object.create(Object.getPrototypeOf(stat)),stat,{uid:stat.uid+1}):stat;});}
 const cause = kind==='outside-link' ? /Unsafe runtime link/ : kind==='relative-outside-link' ? /Runtime link escapes/ : kind==='hard-link' ? /Unsafe runtime entry/ : /Unsafe runtime directory/;
 await assert.rejects(inherit(f),refused(cause));assert.equal(fs.readFileSync(outside,'utf8'),'SYNTHETIC_OUTSIDE');assert.equal(fs.existsSync(tui.paths(f.target).root),false);
});

for (const existing of [false, true]) test('owned interrupted staging is pruned under the startup lock, existing target='+existing, async t => {
 qualification(t); const f=fixture(t); runtime(f.source); if(existing)runtime(f.target);
 const old=fs.mkdtempSync(path.join(f.target,'.dsh-tui-inherit-'));write(path.join(old,'dsh-tui/runtime/partial'),'interrupted');
 const other=path.join(f.target,'unrelated-stage');write(path.join(other,'keep'),'unrelated');
 const prefixOnly=path.join(f.target,'.dsh-tui-inherit-not-a-generated-suffix');write(path.join(prefixOnly,'keep'),'unrelated');
 const {createLock,releaseLock}=require('../service-lock.cjs'),file=path.join(f.root,'services.lock'),lock=createLock(file,'startup',f.root);
 try { await tui.inheritRuntime(f.source,f.target,{cleanStaging:true}); }
 finally { assert.equal(releaseLock(file,lock),true); }
 assert.equal(fs.existsSync(old),false);assert.equal(fs.readFileSync(path.join(other,'keep'),'utf8'),'unrelated');assert.equal(fs.readFileSync(path.join(prefixOnly,'keep'),'utf8'),'unrelated');
 tui.verifyRuntime(f.source);tui.verifyRuntime(f.target);
});

test('staging cleanup leaves linked, foreign-owned and unexpected trees untouched',async t=>{
 qualification(t);const f=fixture(t);runtime(f.source);const outside=path.join(f.root,'outside');write(path.join(outside,'keep'),'outside');
 const linked=path.join(f.target,'.dsh-tui-inherit-ABC123');fs.symlinkSync(outside,linked);
 const nested=fs.mkdtempSync(path.join(f.target,'.dsh-tui-inherit-'));fs.symlinkSync(outside,path.join(nested,'dsh-tui'));
 const foreign=fs.mkdtempSync(path.join(f.target,'.dsh-tui-inherit-'));write(path.join(foreign,'dsh-tui/runtime/partial'),'foreign');
 const unknown=fs.mkdtempSync(path.join(f.target,'.dsh-tui-inherit-'));write(path.join(unknown,'home/history'),'unrelated');
 const ordinaryFile=path.join(f.target,'.dsh-tui-inherit-FILE00');write(ordinaryFile,'not a staging directory');
 const original=fs.lstatSync;t.mock.method(fs,'lstatSync',function(file,...args){const s=Reflect.apply(original,this,[file,...args]);return file===foreign?Object.assign(Object.create(Object.getPrototypeOf(s)),s,{uid:s.uid+1}):s;});
 await tui.inheritRuntime(f.source,f.target,{cleanStaging:true});
 for(const file of [linked,nested,foreign,unknown,ordinaryFile])assert.equal(fs.existsSync(file),true);
 assert.equal(fs.readFileSync(path.join(outside,'keep'),'utf8'),'outside');tui.verifyRuntime(f.target);
});

test('ordinary runtime validation never sweeps staging outside the service startup lock',async t=>{
 qualification(t);const f=fixture(t);runtime(f.target);const old=fs.mkdtempSync(path.join(f.target,'.dsh-tui-inherit-'));write(path.join(old,'dsh-tui/runtime/partial'),'still owned');
 await inherit(f);assert.equal(fs.existsSync(old),true);
});

test('a copier killed after opening its staged output is cleaned on the next locked attempt',async t=>{
 qualification(t);const f=fixture(t);runtime(f.source);
 const script=`
 const fs=require('node:fs'),path=require('node:path');
 const [moduleFile,helper,source,target]=process.argv.slice(1);
 require(helper).qualification({mock:{method(object,key,value){object[key]=value;}}});
 const tui=require(moduleFile),open=fs.promises.open;let sent=false;
 fs.promises.open=async function(file,...args){
   const handle=await Reflect.apply(open,this,[file,...args]);
   if(String(file).startsWith(target+path.sep)&&String(file).includes('.dsh-tui-inherit-')){
     if(!sent){sent=true;setInterval(()=>{},1000);process.send('copying');}
     await new Promise(()=>{});
   }
   return handle;
 };
 tui.inheritRuntime(source,target).catch(()=>process.send('failed'));
 `;
 const child=require('node:child_process').spawn(process.execPath,['-e',script,require.resolve('../dsh-tui.cjs'),require.resolve('./helpers/dsh-runtime.cjs'),f.source,f.target],{stdio:['ignore','ignore','pipe','ipc']});
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;});
 let timer;try{await Promise.race([new Promise((resolve,reject)=>{child.once('message',value=>value==='copying'?resolve():reject(Error('Copy failed before interruption')));child.once('error',reject);}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Copier did not reach output')),5000);})]);}finally{clearTimeout(timer);}
 child.kill('SIGKILL');assert.equal((await exited).signal,'SIGKILL');
 const abandoned=fs.readdirSync(f.target).filter(name=>name.startsWith('.dsh-tui-inherit-'));assert.equal(abandoned.length,1);
 const {createLock,releaseLock}=require('../service-lock.cjs'),file=path.join(f.root,'services.lock'),lock=createLock(file,'startup',f.root);
 try{await tui.inheritRuntime(f.source,f.target,{cleanStaging:true});}finally{releaseLock(file,lock);}
 assert.equal(fs.existsSync(path.join(f.target,abandoned[0])),false);tui.verifyRuntime(f.source);tui.verifyRuntime(f.target);
});
test('a target appearing at publication is never overwritten',async t=>{
 qualification(t);const f=fixture(t);runtime(f.source);const d=tui.paths(f.target),original=fsp.mkdir;let race=true,ino;
 t.mock.method(fsp,'mkdir',async function(file,...args){if(file===d.root&&race){race=false;runtime(f.target);write(path.join(d.root,'other-install'),'other');ino=fs.statSync(d.root).ino;}return Reflect.apply(original,this,[file,...args]);});
 const r=await inherit(f);assert.equal(r.status,'existing');assert.equal(fs.statSync(d.root).ino,ino);assert.equal(fs.readFileSync(path.join(d.root,'other-install'),'utf8'),'other');
});
test('copying is asynchronous, bounded in time and calls no network, npm or provider',async t=>{
 qualification(t);const f=fixture(t),s=runtime(f.source);for(let i=0;i<16;i++)write(path.join(s.root,'padding-'+i),Buffer.alloc(512*1024,1));
 const cp=require('node:child_process');for(const method of ['spawn','spawnSync','execFile','execFileSync','exec','execSync'])t.mock.method(cp,method,()=>{throw Error('No child process allowed');});
 t.mock.method(globalThis,'fetch',()=>{throw Error('No network allowed');});for(const mod of ['node:http','node:https'])for(const method of ['get','request'])t.mock.method(require(mod),method,()=>{throw Error('No network allowed');});
 const file=require.resolve('../dsh-tui.cjs'),cached=require.cache[file];delete require.cache[file];const offlineTui=require(file);t.after(()=>{require.cache[file]=cached;});
 let ticks=0;const timer=setInterval(()=>ticks++,1);const started=performance.now();try{await offlineTui.inheritRuntime(f.source,f.target);}finally{clearInterval(timer);}const elapsedMs=performance.now()-started;
 assert.ok(ticks>1,'event loop progresses');assert.ok(elapsedMs<10000,`copy took ${elapsedMs}ms`);console.log('COPY_TIMING',JSON.stringify({bytes:8*1024*1024,elapsedMs,ticks}));
});

for (const copyMs of [13000,31000]) test('cleanup and copying have separate deadlines, copy='+copyMs+'ms',async t=>{
 qualification(t);const f=fixture(t),s=runtime(f.source),old=fs.mkdtempSync(path.join(f.target,'.dsh-tui-inherit-'));
 write(path.join(old,'dsh-tui/runtime/partial'),'interrupted');
 const {performance}=require('node:perf_hooks'),now=performance.now.bind(performance),rm=fsp.rm,open=fsp.open;let offset=0,copyStarted=false;
 t.mock.method(performance,'now',()=>now()+offset);
 t.mock.method(fsp,'rm',async function(file,...args){const result=await Reflect.apply(rm,this,[file,...args]);if(file===old)offset+=18000;return result;});
 t.mock.method(fsp,'open',async function(file,...args){if(!copyStarted&&String(file).startsWith(s.root)){copyStarted=true;offset+=copyMs;}return Reflect.apply(open,this,[file,...args]);});
 if(copyMs>30000){await assert.rejects(tui.inheritRuntime(f.source,f.target,{cleanStaging:true}),refused(/Runtime inheritance deadline/));assert.equal(tui.installed(f.target),false);}
 else {const result=await tui.inheritRuntime(f.source,f.target,{cleanStaging:true});assert.equal(result.status,'copied');assert.ok(result.elapsedMs>=31000);tui.verifyRuntime(f.target);}
 assert.equal(fs.existsSync(old),false);assert.equal(fs.readdirSync(f.target).some(name=>name.startsWith('.dsh-tui-inherit-')),false);tui.verifyRuntime(f.source);
});

// An injected clock: each operation the fixture slows adds its time here, so nothing waits.
function slowed(t){
 const {performance}=require('node:perf_hooks'),now=performance.now.bind(performance);let offset=0;
 t.mock.method(performance,'now',()=>now()+offset);
 return ms=>{offset+=ms;};
}
const padding=(where,count,bytes=64)=>{for(let i=0;i<count;i++)write(path.join(where.root,'padding-'+String(i).padStart(3,'0')),Buffer.alloc(bytes,i+1));};
const slowOpen=(t,root,advance,ms)=>{const open=fsp.open;let calls=0;t.mock.method(fsp,'open',async function(file,...args){if(String(file).startsWith(root))advance(typeof ms==='function'?ms(++calls):ms);return Reflect.apply(open,this,[file,...args]);});};
const nothingPublished=f=>{assert.equal(tui.installed(f.target),false);assert.equal(fs.readdirSync(f.target).some(name=>name.startsWith('.dsh-tui-inherit-')),false);tui.verifyRuntime(f.source);};
const refusal=async work=>{let error;await assert.rejects(work,e=>{error=e;return true;});assert.equal(error.code,'dsh-runtime-inheritance-refused');return error;};

test('a slow copy that keeps finishing files is not stopped at thirty seconds',async t=>{
 qualification(t);const f=fixture(t),s=runtime(f.source);padding(s,20);slowOpen(t,s.root,slowed(t),3000);
 const result=await inherit(f);assert.equal(result.status,'copied');assert.ok(result.elapsedMs>60000&&result.elapsedMs<120000,`${result.elapsedMs}`);
 const d=tui.paths(f.target);tui.verifyRuntime(f.target);for(const name of fs.readdirSync(s.root).filter(name=>name.startsWith('padding-')))assert.deepEqual(fs.readFileSync(path.join(d.root,name)),fs.readFileSync(path.join(s.root,name)));
});
test('one large file read slowly counts every piece read as progress',async t=>{
 qualification(t);const f=fixture(t),s=runtime(f.source),advance=slowed(t),open=fsp.open,large=path.join(s.root,'large');write(large,Buffer.alloc(4*1024*1024,7));
 t.mock.method(fsp,'open',async function(file,...args){const handle=await Reflect.apply(open,this,[file,...args]);if(file===large){const read=handle.read.bind(handle);handle.read=async(...rest)=>{advance(2000);return read(...rest);};}return handle;});
 const result=await inherit(f);assert.equal(result.status,'copied');assert.ok(result.elapsedMs>60000);assert.deepEqual(fs.readFileSync(path.join(tui.paths(f.target).root,'large')),fs.readFileSync(large));
});
test('a slow inventory that keeps finding entries is not stopped at thirty seconds',async t=>{
 qualification(t);const f=fixture(t),s=runtime(f.source),advance=slowed(t),lstat=fs.lstatSync;padding(s,80);
 t.mock.method(fs,'lstatSync',function(file,...args){if(String(file).startsWith(s.root+path.sep))advance(500);return Reflect.apply(lstat,this,[file,...args]);});
 const result=await inherit(f);assert.equal(result.status,'copied');assert.ok(result.elapsedMs>40000);tui.verifyRuntime(f.target);
});
test('a copy with nothing finished for thirty seconds stops and says where',async t=>{
 qualification(t);const f=fixture(t),s=runtime(f.source);padding(s,40);slowOpen(t,s.root,slowed(t),call=>call===30?31000:0);
 const error=await refusal(inherit(f));assert.equal(error.reason,'deadline');assert.equal(error.progress.stage,'files');
 assert.ok(error.progress.item>0&&error.progress.item<40,JSON.stringify(error.progress));assert.ok(error.progress.elapsedMs>30000&&error.progress.elapsedMs<60000);nothingPublished(f);
});
test('a copy still moving at two minutes stops',async t=>{
 qualification(t);const f=fixture(t),s=runtime(f.source);padding(s,80);slowOpen(t,s.root,slowed(t),3000);
 const error=await refusal(inherit(f));assert.equal(error.reason,'deadline');assert.equal(error.progress.stage,'files');
 assert.ok(error.progress.item>20&&error.progress.item<80,JSON.stringify(error.progress));assert.ok(error.progress.elapsedMs>120000&&error.progress.elapsedMs<150000);nothingPublished(f);
});
test('a refusal other than a deadline also says where it stopped',async t=>{
 qualification(t);const f=fixture(t),s=runtime(f.source),open=fsp.open;padding(s,40);let calls=0;
 t.mock.method(fsp,'open',async function(file,...args){if(String(file).startsWith(s.root)&&++calls===30)throw Object.assign(Error('synthetic EIO'),{code:'EIO'});return Reflect.apply(open,this,[file,...args]);});
 const error=await refusal(inherit(f));assert.equal(error.reason,'filesystem');assert.equal(error.progress.stage,'files');assert.ok(error.progress.item>0);assert.ok(Number.isSafeInteger(error.progress.elapsedMs));nothingPublished(f);
});
for(const [name,slow,count] of [['directories','mkdir',20],['links','symlink',20]])test('slow '+name+' that keep being made are not stopped at thirty seconds',async t=>{
 qualification(t);const f=fixture(t),s=runtime(f.source),advance=slowed(t),original=fsp[slow];write(path.join(s.root,'tool'),'synthetic');
 for(let i=0;i<count;i++)if(slow==='mkdir')fs.mkdirSync(path.join(s.root,'dir-'+i),{mode:0o700});else fs.symlinkSync('tool',path.join(s.root,'link-'+i));
 t.mock.method(fsp,slow,async function(...args){advance(3000);return Reflect.apply(original,this,args);});
 const result=await inherit(f);assert.equal(result.status,'copied');assert.ok(result.elapsedMs>60000);tui.verifyRuntime(f.target);
});
test('the last checks of a copied runtime each count as progress',async t=>{
 qualification(t);const f=fixture(t),s=runtime(f.source),advance=slowed(t),read=fs.readFileSync,staged=path.join('lib','types','update.js');
 t.mock.method(fs,'readFileSync',function(file,...args){if(String(file).endsWith(staged))advance(20000);return Reflect.apply(read,this,[file,...args]);});
 const result=await inherit(f);assert.equal(result.status,'copied');assert.ok(result.elapsedMs>=60000);
});
test('clearing an interrupted copy keeps thirty seconds in total',async t=>{
 qualification(t);const f=fixture(t);runtime(f.source);const old=fs.mkdtempSync(path.join(f.target,'.dsh-tui-inherit-')),advance=slowed(t),lstat=fs.lstatSync;
 for(let i=0;i<80;i++)write(path.join(old,'dsh-tui/runtime/partial-'+i),'interrupted');
 t.mock.method(fs,'lstatSync',function(file,...args){if(String(file).startsWith(old+path.sep))advance(500);return Reflect.apply(lstat,this,[file,...args]);});
 const error=await refusal(tui.inheritRuntime(f.source,f.target,{cleanStaging:true}));assert.equal(error.reason,'deadline');assert.equal(error.progress.stage,'cleanup');assert.equal(tui.installed(f.target),false);
});
test('a slow inventory gives the event loop a turn at least every fifty milliseconds',async t=>{
 qualification(t);const f=fixture(t),s=runtime(f.source),advance=slowed(t),lstat=fs.lstatSync,immediate=setImmediate,mkdtemp=fsp.mkdtemp;padding(s,100);let turns=0,counted=true;
 t.mock.method(fs,'lstatSync',function(file,...args){if(String(file).startsWith(s.root+path.sep))advance(10);return Reflect.apply(lstat,this,[file,...args]);});
 t.mock.method(globalThis,'setImmediate',(...args)=>{if(counted)turns++;return immediate(...args);});
 t.mock.method(fsp,'mkdtemp',async(...args)=>{counted=false;return mkdtemp(...args);});
 assert.equal((await inherit(f)).status,'copied');assert.ok(turns>=15,'turns '+turns);
});
test('checking a runtime already in place keeps thirty seconds in total',async t=>{
 qualification(t);const f=fixture(t),d=runtime(f.target),advance=slowed(t),lstat=fs.lstatSync;padding(d,80);
 t.mock.method(fs,'lstatSync',function(file,...args){if(String(file).startsWith(d.root+path.sep))advance(500);return Reflect.apply(lstat,this,[file,...args]);});
 const error=await refusal(inherit(f));assert.equal(error.reason,'deadline');assert.equal(error.progress.stage,'target');tui.verifyRuntime(f.target);
});

for(const kind of ['writable-file','writable-directory','hardlink'])test('start reports unsafe runtime attributes for '+kind+' without launching or reading a key',async t=>{
 qualification(t);const f=fixture(t),s=runtime(f.source),file=path.join(s.root,'synthetic-file');write(file,'synthetic');
 if(kind==='writable-file')fs.chmodSync(file,0o660);
 if(kind==='writable-directory')fs.chmodSync(f.source,0o770);
 if(kind==='hardlink')fs.linkSync(file,path.join(s.root,'synthetic-link'));
 const dsh=new tui.DshTui({id:'synthetic-dsh'},{dataDir:f.source,binaries:{dsh:process.execPath}},{key:async()=>assert.fail('No key read')});
 dsh.launch=async()=>assert.fail('Unsafe runtime must not launch');
 await assert.rejects(dsh.start(),e=>e.code==='dsh-runtime-unqualified'&&e.uiMessage?.key==='error.dsh.runtimeUnsafe');
});
