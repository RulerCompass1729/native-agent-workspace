const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module'),runtime=require('../../scripts/fixtures/install-runtime.cjs');
function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'install-query-count-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const f=runtime.fixture(root),box={x:20,y:30,width:1240,height:820};
  const bundle=path.join(root,'Synthetic.app'),app=path.join(bundle,'Contents/Resources/app'),executable=path.join(bundle,'Contents/MacOS/fixture');
  fs.mkdirSync(path.dirname(app),{recursive:true});fs.renameSync(f.app,app);f.app=app;
  fs.mkdirSync(path.dirname(executable),{recursive:true});fs.writeFileSync(executable,'synthetic');
  const info={CFBundleIdentifier:'io.github.rulercompass1729.native-agent-workspace.fixture',CFBundleExecutable:'fixture',CFBundleShortVersionString:f.version,NAWSourceRevision:'a'.repeat(40)};
  fs.writeFileSync(path.join(bundle,'Contents/Info.plist'),JSON.stringify(info));
  const dsh=path.join(f.directory,'dsh-tui/runtime');fs.mkdirSync(dsh,{recursive:true});fs.writeFileSync(path.join(dsh,'qualified'),'yes');
  fs.writeFileSync(path.join(f.profile,'services.json'),JSON.stringify({format:1,active:f.key,entries:[f.key]}));
  fs.writeFileSync(path.join(f.profile,'views.json'),JSON.stringify([{owner:'synthetic-view',active:true,bounds:box}]));
  const observation={queries:0,now:0,guiStarted:'before',pid:424242,started:'backend lifetime',workers:0};
  function lock(){fs.writeFileSync(path.join(f.directory,'service.lock'),JSON.stringify({format:1,kind:'service',directory:f.directory,pid:observation.pid,started:observation.started}));}lock();
  const filename=require.resolve('../../scripts/check-install-state.cjs'),normal=createRequire(filename),module={exports:{}};
  const localRequire=name=>{
    if(name==='node:child_process')return{execFileSync(bin,args){
      if(bin==='/usr/bin/plutil')return JSON.stringify(info);
      if(bin==='/usr/bin/osascript')return JSON.stringify([{id:1,onScreen:true,bounds:box}]);
      if(bin==='/usr/bin/python3'){
        if(observation.frameFailure)throw Error('synthetic native frame unavailable');
        if(observation.guiReplaced)observation.guiStarted='replacement GUI lifetime';
        return JSON.stringify({pid:observation.wrongFramePid?123457:123456,windows:[{pid:123456,id:1,owner:'synthetic-view',onScreen:true,bounds:box,frame:box,frameBasis:'electron-getbounds-v1'}]});
      }
      if(bin==='/bin/ps'){
        const pid=Number(args[args.indexOf('-p')+1]),field=args.at(-1);assert.ok([123456,observation.pid].includes(pid));
        if(field==='lstart=')return pid===123456?observation.guiStarted:observation.started;
        if(field==='comm=')return executable;
        assert.equal(field,'command=');return executable+' '+path.join(f.runtime,'daemon.cjs')+' '+f.directory;
      }
      assert.equal(bin,process.execPath);assert.equal(path.basename(args[0]),'install-backend-version.cjs');assert.equal(args[1],f.directory);
      observation.queries++;if(observation.failAt===observation.queries)throw Error('synthetic helper failure');
      return JSON.stringify({servicePid:observation.pid,runtimeVersion:f.version});
    }};
    if(name==='node:perf_hooks')return{performance:{now:()=>observation.now}};
    if(name==='./test-discoveries-bundle.cjs')return{run:async()=>{observation.workers++;}};
    if(name===path.join(f.app,'app/dsh-tui.cjs'))return{verifyRuntime(){}};
    return normal(name);
  };
  const run=vm.runInNewContext('(function(require,module,__filename,__dirname){'+fs.readFileSync(filename,'utf8')+'\n})',{
    process,Buffer,console:{log(){}},setTimeout(fn,ms){observation.now+=ms;observation.onSleep?.();fn();return 1;},clearTimeout(){},
  });run(localRequire,module,filename,path.dirname(filename));
  const snapshot=path.join(root,'before.json'),args=mode=>[mode,'--bundle',bundle,'--profile',f.profile,'--pid','123456','--snapshot',snapshot,...(mode==='post'?['--version',f.version,'--revision','a'.repeat(40)]:[])];
  return{...f,observation,lock,main:mode=>module.exports.main(args(mode))};
}
async function beforePost(t){const f=fixture(t);assert.equal(await f.main('pre'),0);assert.equal(f.observation.queries,1);f.observation.queries=0;f.observation.guiStarted='after';return f;}
test('pre CLI takes one receipt and post CLI takes only initial and final receipts',async t=>{
  const f=await beforePost(t);assert.equal(await f.main('post'),0);assert.ok(f.observation.now>=20000);assert.equal(f.observation.workers,1);assert.equal(f.observation.queries,2);
  console.log('version queries: before=1 post='+f.observation.queries+' (virtual default 20s/1s)');
});
for(const change of ['pid','started'])test('post refuses a changed '+change+' instead of querying a replacement',async t=>{
  const f=await beforePost(t);let changed=false;f.observation.onSleep=()=>{if(changed)return;changed=true;if(change==='pid')f.observation.pid++;else f.observation.started='replacement lifetime';f.lock();};
  await assert.rejects(f.main('post'),/Backend process changed/);assert.equal(f.observation.queries,1);assert.equal(f.observation.workers,0);assert.equal(f.observation.now,1000);
});
test('helper failure terminates post immediately rather than retrying inside stable',async t=>{
  const f=await beforePost(t);f.observation.failAt=1;await assert.rejects(f.main('post'),/Backend version unconfirmed/);assert.equal(f.observation.queries,1);assert.equal(f.observation.now,0);assert.equal(f.observation.workers,0);
});
test('final helper failure is not replaced by the cached initial receipt',async t=>{
  const f=await beforePost(t);f.observation.failAt=2;await assert.rejects(f.main('post'),/Backend version unconfirmed/);assert.equal(f.observation.queries,2);assert.equal(f.observation.workers,1);
});
for(const file of ['workspace.cjs','dsh-tui.cjs'])test('cached version still rechecks '+file+' during stable',async t=>{
  const f=await beforePost(t);let changed=false;f.observation.onSleep=()=>{if(changed)return;changed=true;fs.appendFileSync(path.join(f.runtime,file),'\n// changed');};
  await assert.rejects(f.main('post'),/did not stabilize/);assert.equal(f.observation.queries,1);assert.equal(f.observation.workers,0);
});

for(const reason of ['missing GUI endpoint','invalid GUI response'])test('pre refuses '+reason+' without falling back to CG',async t=>{
  const f=fixture(t);f.observation.frameFailure=reason;await assert.rejects(f.main('pre'),/frame 口径待核实/);assert.equal(f.observation.queries,0);
});

for(const change of ['wrongFramePid','guiReplaced'])test('pre binds native frame to the verified GUI '+change,async t=>{
  const f=fixture(t);f.observation[change]=true;await assert.rejects(f.main('pre'),/frame 口径待核实/);assert.equal(f.observation.queries,0);
});
