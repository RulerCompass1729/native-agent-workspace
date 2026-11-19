const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),os=require('node:os');
const tui=require('../dsh-tui.cjs'),{qualification,runtime,write}=require('./helpers/dsh-runtime.cjs');
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'naw-dsh-inherit-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'source'),target=path.join(root,'target');fs.mkdirSync(source,{mode:0o700});fs.mkdirSync(target,{mode:0o700});return {root,source,target};
}
const inherit=(f)=>tui.inheritRuntime(f.source,f.target);

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
 write(file,'damaged');await assert.rejects(inherit(f));assert.equal(fs.existsSync(tui.paths(f.target).root),false);assert.equal(fs.readFileSync(file,'utf8'),'damaged');
});
test('an existing qualified target is validated without replacement, even if the source is absent',async t=>{
 const count=qualification(t),f=fixture(t),d=runtime(f.target),file=path.join(d.root,'marker');write(file,'target-only');const before=fs.statSync(file);const r=await inherit(f);
 assert.equal(r.status,'existing');assert.ok(count()>=2);assert.equal(fs.statSync(file).ino,before.ino);assert.equal(fs.readFileSync(file,'utf8'),'target-only');
});
for(const kind of ['empty','invalid'])test('an existing '+kind+' target is preserved and refused',async t=>{
 qualification(t);const f=fixture(t);runtime(f.source);const d=tui.paths(f.target);fs.mkdirSync(d.root,{recursive:true,mode:0o700});if(kind==='invalid')write(path.join(d.root,'package.json'),'unchanged');const ino=fs.statSync(d.root).ino;
 await assert.rejects(inherit(f));assert.equal(fs.statSync(d.root).ino,ino);assert.deepEqual(fs.readdirSync(d.root),kind==='invalid'?['package.json']:[]);
});
test('a failed copy leaves the source intact and can be retried',async t=>{
 qualification(t);const f=fixture(t),s=runtime(f.source),original=fsp.open;let calls=0;
 const mock=t.mock.method(fsp,'open',async function(file,...args){if(String(file).startsWith(s.root)&&++calls===3)throw Object.assign(Error('synthetic copy interruption'),{code:'EIO'});return Reflect.apply(original,this,[file,...args]);});
 await assert.rejects(inherit(f));assert.equal(fs.existsSync(tui.paths(f.target).root),false);tui.verifyRuntime(f.source);assert.ok(!fs.readdirSync(f.target).some(x=>x.startsWith('.dsh-tui-inherit-')));
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
 await assert.rejects(inherit(f));assert.equal(fs.readFileSync(outside,'utf8'),'SYNTHETIC_OUTSIDE');assert.equal(fs.existsSync(tui.paths(f.target).root),false);
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
