const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync,execFile}=require('node:child_process'),{promisify}=require('node:util');
const ownership=require('../temp-ownership.cjs'),{TempReminders,DAY}=require('../temp-reminders.cjs'),{pythonExecutable}=require('../platform.cjs');
function fixture(t) {
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'naw-registration-generation-'))),registryDir=path.join(base,'registry'),dataDir=path.join(base,'profile');
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));fs.mkdirSync(dataDir,{mode:0o700});
  const dir=path.join(base,'candidate'),nested=path.join(dir,'nested'),payload=path.join(nested,'keep'),now=Date.now(),old=now-8*DAY;
  fs.mkdirSync(dir);fs.mkdirSync(nested);fs.writeFileSync(payload,'SYNTHETIC_ACTIVE_DATA');
  ownership.register(dir,{registryDir,owner:{pid:2**30,started:'synthetic exited owner'},now:()=>old});
  for(const p of [payload,nested,dir])fs.utimesSync(p,new Date(old),new Date(old));
  const manager=new TempReminders({dataDir,registryDir,roots:[base],now:()=>now,isPerson:c=>c.person,inspect:async()=>({opened:[],mounted:[]})}),person={person:true};
  const helper=request=>JSON.parse(execFileSync(pythonExecutable(),[path.join(__dirname,'../temp-cleanup.py')],{input:JSON.stringify(request),encoding:'utf8',timeout:10000}));
  const request=()=>({path:dir,owner:manager.candidates[0].record.owner,roots:[base],entries:manager.candidates[0].entries,registry:ownership.revision(registryDir)});
  return {base,registryDir,dir,nested,payload,manager,person,helper,request};
}
test('GENERATION: Node refuses a proof begun after registration starts but before its receipt exists',t=>{
  const f=fixture(t),write=fs.writeFileSync;let observed=false;
  t.mock.method(fs,'writeFileSync',(file,...args)=>{
    if(!observed&&String(file).startsWith(path.join(f.registryDir,'.pending-'))) {
      observed=true;assert.throws(()=>ownership.revision(f.registryDir),/incomplete/,'An already-started registration cannot look quiescent');
    }
    return write(file,...args);
  });
  ownership.register(f.nested,{registryDir:f.registryDir});assert.ok(observed);
  const proof=ownership.revision(f.registryDir);assert.equal(proof.generation.started[4],proof.generation.finished[4]);
  assert.equal(fs.readFileSync(f.payload,'utf8'),'SYNTHETIC_ACTIVE_DATA');
});
for(const phase of ['target validation','receipt write'])test(`GENERATION: the real helper keeps data during ${phase} before the receipt is visible`,async t=>{
  const f=fixture(t);await f.manager.present(f.person);const request=f.request();let result;
  if(phase==='receipt write') {
    const write=fs.writeFileSync;t.mock.method(fs,'writeFileSync',(file,...args)=>{
      if(!result&&String(file).startsWith(path.join(f.registryDir,'.pending-')))result=f.helper(request);
      return write(file,...args);
    });
  } else {
    const realpath=fs.realpathSync;t.mock.method(fs,'realpathSync',(file,...args)=>{
      const value=realpath(file,...args);
      if(!result&&file===f.nested)result=f.helper(request);
      return value;
    });
  }
  ownership.register(f.nested,{registryDir:f.registryDir});
  assert.equal(result.removed,false);assert.equal(result.bytes,0,'No active payload can be unlinked during the pre-receipt interval');
  assert.equal(result.registryChanged,true);assert.equal(result.untouched,true);
  assert.equal(fs.readFileSync(f.payload,'utf8'),'SYNTHETIC_ACTIVE_DATA');
});
test('GENERATION: overlapping registrations remain visible until the last writer finishes',t=>{
  const f=fixture(t),other=path.join(f.base,'other');fs.mkdirSync(other);const write=fs.writeFileSync;let depth=0;
  t.mock.method(fs,'writeFileSync',(file,...args)=>{
    if(String(file).startsWith(path.join(f.registryDir,'.pending-'))&&depth===0) {
      depth++;ownership.register(other,{registryDir:f.registryDir});
      assert.throws(()=>ownership.revision(f.registryDir),/incomplete/,'The first registration is still open after the second one finishes');
    }
    return write(file,...args);
  });
  ownership.register(f.nested,{registryDir:f.registryDir});
  const proof=ownership.revision(f.registryDir);assert.equal(proof.generation.started[4],'3');assert.equal(proof.generation.finished[4],'3');
});
test('GENERATION: a stable legacy receipt inventory initializes counters and still cleans normally',async t=>{
  const f=fixture(t);
  // Recreate the pre-protocol store shape before any cleanup proof exists.
  for(const name of ['registration-started','registration-finished'])fs.unlinkSync(path.join(f.registryDir,name));
  const shown=await f.manager.present(f.person),result=await f.manager.clean(f.person,shown.ticket);
  assert.equal(result.cleaned,1);assert.equal(result.skipped,0);assert.equal(fs.existsSync(f.dir),false);
  const proof=ownership.revision(f.registryDir);assert.equal(proof.generation.started[4],'0');assert.equal(proof.generation.finished[4],'0');
});
test('GENERATION: concurrent processes do not lose registration increments',async t=>{
  const f=fixture(t),before=ownership.revision(f.registryDir);
  const script="const fs=require('node:fs'),path=require('node:path'),own=require(process.argv[1]);for(let i=0;i<16;i++){const dir=path.join(process.argv[2],process.pid+'-'+i);fs.mkdirSync(dir);own.register(dir,{registryDir:process.argv[3]});}";
  await Promise.all(Array.from({length:4},()=>promisify(execFile)(process.execPath,['-e',script,require.resolve('../temp-ownership.cjs'),f.base,f.registryDir],{timeout:10000})));
  const after=ownership.revision(f.registryDir);
  assert.equal(Number(after.generation.started[4])-Number(before.generation.started[4]),64);
  assert.equal(after.generation.started[4],after.generation.finished[4]);assert.equal(ownership.read(f.registryDir).length,65);
});
test('GENERATION: a writer exiting before its receipt leaves cleanup unverified without resetting its generation',async t=>{
  const f=fixture(t),shown=await f.manager.present(f.person),request=f.request();
  const script="const fs=require('node:fs'),path=require('node:path'),own=require(process.argv[1]),write=fs.writeFileSync;fs.writeFileSync=(file,...args)=>{if(String(file).startsWith(path.join(process.argv[3],'.pending-')))process.exit(9);return write(file,...args)};own.register(process.argv[2],{registryDir:process.argv[3]});";
  assert.throws(()=>execFileSync(process.execPath,['-e',script,require.resolve('../temp-ownership.cjs'),f.nested,f.registryDir],{timeout:10000,stdio:'pipe'}),e=>e.status===9);
  const result=await f.manager.clean(f.person,shown.ticket);assert.equal(result.cleaned,0);assert.equal(result.reasons.unverified,1);
  assert.throws(()=>ownership.revision(f.registryDir),/incomplete/);
  // Even a request that claims the current unfinished counters cannot make
  // Python accept an in-flight inventory as a complete proof.
  const names={started:'registration-started',finished:'registration-finished'};
  request.registry.generation=Object.fromEntries(Object.entries(names).map(([key,name])=>{const s=fs.statSync(path.join(f.registryDir,name),{bigint:true});return [key,[s.dev,s.ino,s.uid,s.mode,s.size].map(String)];}));
  assert.equal(f.helper(request).removed,false);assert.equal(fs.readFileSync(f.payload,'utf8'),'SYNTHETIC_ACTIVE_DATA');
});
for(const kind of ['symlink','fifo','hardlink','oversized'])test(`GENERATION: ${kind} counter fails closed on both readers`,async t=>{
  const f=fixture(t),shown=await f.manager.present(f.person),request=f.request(),file=path.join(f.registryDir,'registration-started');
  if(kind==='hardlink')fs.linkSync(file,path.join(f.base,'counter-alias'));
  else if(kind==='oversized')fs.truncateSync(file,16*1024*1024+1);
  else {fs.unlinkSync(file);if(kind==='symlink')fs.symlinkSync(path.join(f.base,'unowned'),file);else execFileSync('/usr/bin/mkfifo',[file]);}
  const result=await f.manager.clean(f.person,shown.ticket);assert.equal(result.cleaned,0);assert.equal(result.reasons.unverified,1);
  const receipt=f.helper(request);assert.equal(receipt.removed,false);assert.equal(receipt.bytes,0);
  assert.equal(fs.readFileSync(f.payload,'utf8'),'SYNTHETIC_ACTIVE_DATA');
});
