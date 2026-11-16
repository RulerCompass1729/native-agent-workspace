const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
const ownership=require('../temp-ownership.cjs'),{TempReminders,DAY}=require('../temp-reminders.cjs'),{pythonExecutable}=require('../platform.cjs');
function fixture(t) {
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'naw-finished-debt-'))),registryDir=path.join(base,'registry'),dataDir=path.join(base,'profile');
  fs.mkdirSync(dataDir,{mode:0o700});t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const now=Date.now(),old=now-8*DAY,dead={pid:2**30,started:'synthetic exited owner'},person={person:true};
  function candidate(name) {const dir=path.join(base,name);fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'keep'),'SYNTHETIC_DATA');ownership.register(dir,{registryDir,owner:dead,now:()=>old});for(const p of [path.join(dir,'keep'),dir])fs.utimesSync(p,new Date(old),new Date(old));return dir;}
  const dir=candidate('candidate'),nested=path.join(dir,'nested');fs.mkdirSync(nested);const payload=path.join(nested,'active');fs.writeFileSync(payload,'SYNTHETIC_ACTIVE_DATA');for(const p of [payload,nested,dir])fs.utimesSync(p,new Date(old),new Date(old));
  const manager=new TempReminders({dataDir,registryDir,roots:[base],now:()=>now,isPerson:c=>c.person,inspect:async()=>({opened:[],mounted:[]})});
  const helper=request=>JSON.parse(execFileSync(pythonExecutable(),[path.join(__dirname,'../temp-cleanup.py')],{input:JSON.stringify(request),encoding:'utf8',timeout:10000}));
  const sizes=()=>['registration-started','registration-finished'].map(n=>fs.statSync(path.join(registryDir,n)).size);
  async function prepare(){const shown=await manager.present(person),s=manager.candidates[0];return {shown,request:{path:dir,owner:s.record.owner,roots:[base],entries:s.entries,registry:ownership.revision(registryDir)}};}
  return {base,registryDir,dir,nested,payload,manager,person,candidate,helper,sizes,prepare};
}
function failFinished(t,f) {
  const finished=fs.statSync(path.join(f.registryDir,'registration-finished')),write=fs.writeSync;
  return t.mock.method(fs,'writeSync',(fd,...args)=>{const s=fs.fstatSync(fd);if(s.dev===finished.dev&&s.ino===finished.ino)throw Object.assign(Error('synthetic finished ENOSPC'),{code:'ENOSPC'});return write(fd,...args);});
}
for(const entry of ['register','status','scan','clean'])test(`DEBT: the live writer repays finished before its next ${entry}`,async t=>{
  const f=fixture(t),p=await f.prepare(),mock=failFinished(t,f);
  assert.throws(()=>ownership.register(f.nested,{registryDir:f.registryDir}),{code:'ENOSPC'});assert.deepEqual(f.sizes(),[2,1]);
  const blocked=await f.manager.status(true);assert.equal(blocked.registrationIssue,'incomplete');assert.equal(blocked.directories,0);
  mock.mock.restore();
  if(entry==='register')f.candidate('idle');
  else if(entry==='clean'){const r=await f.manager.clean(f.person,p.shown.ticket);assert.equal(r.cleaned,0);assert.equal(r.reasons.busy,1);}
  else await f.manager[entry]();
  assert.deepEqual(f.sizes(),entry==='register'?[3,3]:[2,2],'Only this writer\'s ended registration is completed');
  assert.equal(fs.readFileSync(f.payload,'utf8'),'SYNTHETIC_ACTIVE_DATA');
  assert.equal(ownership.read(f.registryDir).find(r=>r.path===f.nested).owner.pid,process.pid);
  assert.ok(ownership.revision(f.registryDir));
  if(entry!=='register')f.candidate('idle');
  const ready=await f.manager.present(f.person,true);assert.equal(ready.anomaly,null);assert.equal(ready.directories,1,'The live nested receipt protects its parent; an unrelated idle candidate remains available');
  const cleaned=await f.manager.clean(f.person,ready.ticket);assert.equal(cleaned.cleaned,1);assert.equal(cleaned.skipped,0);
  assert.equal(fs.readFileSync(f.payload,'utf8'),'SYNTHETIC_ACTIVE_DATA');assert.equal(fs.existsSync(path.join(f.base,'idle')),false);
});
test('DEBT: repeated ENOSPC keeps multiple completions owed until all receipt writes have ended',async t=>{
  const f=fixture(t),p=await f.prepare(),mock=failFinished(t,f);
  assert.throws(()=>ownership.register(f.nested,{registryDir:f.registryDir}),{code:'ENOSPC'});
  const other=path.join(f.dir,'second-live');fs.mkdirSync(other);fs.writeFileSync(path.join(other,'active'),'SECOND_ACTIVE_DATA');
  assert.throws(()=>ownership.register(other,{registryDir:f.registryDir}),{code:'ENOSPC'});assert.deepEqual(f.sizes(),[3,1]);
  const blocked=await f.manager.status(true);assert.equal(blocked.registrationIssue,'incomplete');assert.deepEqual(f.sizes(),[3,1]);
  const kept=await f.manager.clean(f.person,p.shown.ticket);assert.equal(kept.cleaned,0);assert.equal(kept.bytes,0);
  mock.mock.restore();const recovered=await f.manager.scan();assert.deepEqual(f.sizes(),[3,3]);assert.equal(recovered.anomaly,null);assert.equal(recovered.directories,0);
  await f.manager.status(true);assert.deepEqual(f.sizes(),[3,3],'A retry cannot count a completion twice');
  assert.equal(fs.readFileSync(f.payload,'utf8'),'SYNTHETIC_ACTIVE_DATA');assert.equal(fs.readFileSync(path.join(other,'active'),'utf8'),'SECOND_ACTIVE_DATA');
});
test('DEBT: an unchanged ENOSPC status does not redraw forever, and repayment by register clears its cached refusal',async t=>{
  const f=fixture(t);await f.prepare();let notifications=0;f.manager.changed=()=>{notifications++;};
  const mock=failFinished(t,f);assert.throws(()=>ownership.register(f.nested,{registryDir:f.registryDir}),{code:'ENOSPC'});
  const blocked=await f.manager.status();assert.equal(blocked.registrationIssue,'incomplete');const before=notifications;
  await f.manager.status();assert.equal(notifications,before,'Unchanged failure must reuse the cached projection, avoiding recordsChanged feedback');
  mock.mock.restore();f.candidate('idle');assert.deepEqual(f.sizes(),[3,3]);
  const ready=await f.manager.status();assert.equal(ready.registrationIssue,undefined);assert.equal(ready.directories,1,'A repayment at the register entry also invalidates the cached refusal');
  const after=notifications;await f.manager.status();assert.equal(notifications,after);
  assert.equal(fs.readFileSync(f.payload,'utf8'),'SYNTHETIC_ACTIVE_DATA');
});
test('DEBT: another process cannot repay a finished failure after its writer exits',async t=>{
  const f=fixture(t),p=await f.prepare();
  const script="const fs=require('node:fs'),path=require('node:path'),own=require(process.argv[1]);const registry=process.argv[3],finished=fs.statSync(path.join(registry,'registration-finished')),write=fs.writeSync;fs.writeSync=(fd,...args)=>{const s=fs.fstatSync(fd);if(s.dev===finished.dev&&s.ino===finished.ino)throw Object.assign(Error('synthetic ENOSPC'),{code:'ENOSPC'});return write(fd,...args)};try{own.register(process.argv[2],{registryDir:registry})}catch(e){if(e.code!=='ENOSPC')throw e};";
  execFileSync(process.execPath,['-e',script,require.resolve('../temp-ownership.cjs'),f.nested,f.registryDir],{timeout:10000});
  assert.deepEqual(f.sizes(),[2,1]);const before=fs.readdirSync(f.registryDir).sort();
  const status=await f.manager.status(true);assert.equal(status.registrationIssue,'incomplete');
  const r=await f.manager.clean(f.person,p.shown.ticket);assert.equal(r.cleaned,0);assert.equal(r.bytes,0);assert.equal(r.registrationIssue,'incomplete');
  const py=f.helper(p.request);assert.equal(py.removed,false);assert.equal(py.bytes,0);assert.equal(py.registrationIssue,'incomplete');
  assert.deepEqual(f.sizes(),[2,1]);assert.deepEqual(fs.readdirSync(f.registryDir).sort(),before);assert.equal(fs.readFileSync(f.payload,'utf8'),'SYNTHETIC_ACTIVE_DATA');
});
test('DEBT: repaying an owned completion never fills another writer\'s anonymous gap',async t=>{
  const f=fixture(t),p=await f.prepare();
  fs.appendFileSync(path.join(f.registryDir,'registration-started'),Buffer.from([0]));
  const mock=failFinished(t,f);assert.throws(()=>ownership.register(f.nested,{registryDir:f.registryDir}),{code:'ENOSPC'});assert.deepEqual(f.sizes(),[3,1]);mock.mock.restore();
  const status=await f.manager.status(true);assert.equal(status.registrationIssue,'incomplete');assert.deepEqual(f.sizes(),[3,2]);
  const r=await f.manager.clean(f.person,p.shown.ticket);assert.equal(r.cleaned,0);assert.equal(r.bytes,0);
  const py=f.helper(p.request);assert.equal(py.removed,false);assert.equal(py.bytes,0);assert.equal(py.registrationIssue,'incomplete');
  assert.deepEqual(f.sizes(),[3,2]);assert.equal(fs.readFileSync(f.payload,'utf8'),'SYNTHETIC_ACTIVE_DATA');
});
for(const phase of ['before append','after append'])test(`DEBT: reentrant registration ${phase} cannot replay twice or pair before a receipt exists`,async t=>{
  const f=fixture(t),p=await f.prepare(),failed=failFinished(t,f);
  assert.throws(()=>ownership.register(f.nested,{registryDir:f.registryDir}),{code:'ENOSPC'});failed.mock.restore();
  const third=path.join(f.dir,'third-live');fs.mkdirSync(third);fs.writeFileSync(path.join(third,'active'),'THIRD_ACTIVE_DATA');
  const write=fs.writeSync,writeFile=fs.writeFileSync,finished=fs.statSync(path.join(f.registryDir,'registration-finished'));let depth=0,interleaved=false,sawUnpublished=false;
  t.mock.method(fs,'writeFileSync',(file,data,...args)=>{
    if(String(file).startsWith(path.join(f.registryDir,'.pending-'))&&JSON.parse(String(data)).path===third){
      sawUnpublished=true;assert.deepEqual(f.sizes(),[3,phase==='after append'?2:1]);assert.throws(()=>ownership.revision(f.registryDir),/incomplete/);
      const py=f.helper(p.request);assert.equal(py.removed,false);assert.equal(py.bytes,0);
    }
    return writeFile(file,data,...args);
  });
  t.mock.method(fs,'writeSync',(fd,...args)=>{
    const s=fs.fstatSync(fd);if(s.dev===finished.dev&&s.ino===finished.ino){
      if(depth)throw Object.assign(Error('nested completion ENOSPC'),{code:'ENOSPC'});
      if(!interleaved){interleaved=true;const appended=phase==='after append'?write(fd,...args):null;
        depth++;try{assert.throws(()=>ownership.register(third,{registryDir:f.registryDir}),{code:'ENOSPC'});}finally{depth--;}
        if(phase==='after append')return appended;}
    }
    return write(fd,...args);
  });
  f.candidate('idle');assert.ok(interleaved);assert.ok(sawUnpublished);assert.deepEqual(f.sizes(),[4,4]);
  await f.manager.status(true);assert.deepEqual(f.sizes(),[4,4]);assert.equal(fs.readFileSync(f.payload,'utf8'),'SYNTHETIC_ACTIVE_DATA');assert.equal(fs.readFileSync(path.join(third,'active'),'utf8'),'THIRD_ACTIVE_DATA');
});
test('DEBT: replacing a counter never redirects a known in-memory completion to the new file',async t=>{
  const f=fixture(t),p=await f.prepare(),mock=failFinished(t,f);
  assert.throws(()=>ownership.register(f.nested,{registryDir:f.registryDir}),{code:'ENOSPC'});mock.mock.restore();
  const file=path.join(f.registryDir,'registration-finished'),old=path.join(f.base,'old-counter');fs.renameSync(file,old);fs.copyFileSync(old,file);fs.chmodSync(file,0o600);
  const status=await f.manager.status(true);assert.equal(status.registrationIssue,'metadata-unavailable');assert.deepEqual(f.sizes(),[2,1]);assert.equal(fs.statSync(old).size,1);
  const r=await f.manager.clean(f.person,p.shown.ticket);assert.equal(r.cleaned,0);assert.equal(r.bytes,0);assert.equal(fs.readFileSync(f.payload,'utf8'),'SYNTHETIC_ACTIVE_DATA');
});
