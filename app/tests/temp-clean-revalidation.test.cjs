const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{createHash}=require('node:crypto');
const ownership=require('../temp-ownership.cjs'),{TempReminders,DAY}=require('../temp-reminders.cjs');
const {execFileSync}=require('node:child_process'),{pythonExecutable}=require('../platform.cjs');
function fixture(t) {
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'naw-temp-revalidation-'))),now=Date.now(),old=now-8*DAY;
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const dataDir=path.join(base,'profile'),registryDir=path.join(base,'registry');fs.mkdirSync(dataDir,{mode:0o700});
  const dead={pid:2**30,started:'synthetic exited owner'},person={person:true};
  const manager=new TempReminders({dataDir,registryDir,roots:[base],now:()=>now,isAlive:()=>false,isPerson:c=>c.person,
    inspect:async()=>({opened:[],mounted:[]})});
  function candidate(prefix='owned-') {
    const dir=fs.mkdtempSync(path.join(base,prefix));fs.writeFileSync(path.join(dir,'data'),'synthetic data');
    ownership.register(dir,{registryDir,owner:dead,now:()=>old});
    for(const p of [path.join(dir,'data'),dir])fs.utimesSync(p,new Date(old),new Date(old));
    return dir;
  }
  return {base,registryDir,manager,candidate,person,now,old};
}
for(const replacement of ['directory','symlink'])test(`PF17: a root replaced by a ${replacement} is changed, never busy or deleted`,async t=>{
  const f=fixture(t),dir=f.candidate(),shown=await f.manager.present(f.person),original=dir+'-original';
  fs.renameSync(dir,original);
  const target=fs.mkdtempSync(path.join(f.base,'unregistered-'));fs.writeFileSync(path.join(target,'keep'),'unowned data');
  if(replacement==='symlink')fs.symlinkSync(target,dir);else {fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'keep'),'replacement data');}
  const result=await f.manager.clean(f.person,shown.ticket);
  assert.equal(result.cleaned,0);assert.equal(result.skipped,1);
  assert.ok(fs.lstatSync(dir));assert.equal(fs.readFileSync(path.join(original,'data'),'utf8'),'synthetic data');
  assert.equal(fs.readFileSync(path.join(target,'keep'),'utf8'),'unowned data');
  assert.equal(result.reasons.changed,1,'An identity change must use the existing changed-folder result');
  assert.equal(result.reasons.busy,0);
  assert.equal(f.manager.cached.anomaly,null,'A changed root is not an inspection outage');
});
test('PF18: cleanup streams a receipt backlog instead of calling the capped whole-store reader',async t=>{
  const f=fixture(t),dir=f.candidate(),shown=await f.manager.present(f.person),record=ownership.read(f.registryDir)[0];
  // More than two production-size batches, without a 50,001-file slow fixture.
  for(let i=0;i<513;i++) {
    const r={...record,path:path.join(f.base,'gone-'+i),ino:record.ino+i+1};
    r.id=createHash('sha256').update(JSON.stringify([r.path,r.dev,r.ino,r.uid])).digest('hex');
    fs.writeFileSync(path.join(f.registryDir,r.id+'.json'),JSON.stringify(r),{mode:0o600});
  }
  let reads=0,batches=0,maxBatch=0;
  const read=ownership.read,stream=ownership.batches;
  t.mock.method(ownership,'read',()=>{reads++;throw Error('Temporary ownership inventory is too large');});
  t.mock.method(ownership,'batches',async function*(...args){for await(const batch of stream(...args)){batches++;maxBatch=Math.max(maxBatch,batch.length);yield batch;}});
  const result=await f.manager.clean(f.person,shown.ticket);
  assert.equal(result.cleaned,1,'The former read() ceiling must not prevent authorized cleanup');
  assert.equal(result.skipped,0);assert.equal(fs.existsSync(dir),false);assert.equal(reads,0);
  assert.ok(batches>=3);assert.ok(maxBatch<=256,'Receipt buffering stays at the existing batch size');
  assert.equal(read(f.registryDir).length,0,'The normal refresh still retires missing receipts');
});
for(const relation of ['child','ancestor'])test(`a live ${relation} appearing later in the receipt stream still protects the displayed directory`,async t=>{
  const f=fixture(t),dir=f.candidate();
  const livePath=relation==='child'?path.join(dir,'nested'):f.base;
  if(relation==='child') {fs.mkdirSync(livePath);for(const p of [livePath,dir])fs.utimesSync(p,new Date(f.old),new Date(f.old));}
  const shown=await f.manager.present(f.person),target=ownership.read(f.registryDir)[0];
  const liveId=ownership.register(livePath,{registryDir:f.registryDir,owner:{pid:process.pid,started:'synthetic live owner'},now:()=>f.old});
  const live=ownership.read(f.registryDir).find(r=>r.id===liveId),stream=ownership.batches;let calls=0;
  f.manager.isAlive=owner=>owner.pid===process.pid;
  t.mock.method(ownership,'batches',async function*(...args){if(++calls===1){yield [target];yield [live];}else yield* stream(...args);});
  const result=await f.manager.clean(f.person,shown.ticket);
  assert.equal(result.cleaned,0);assert.equal(result.reasons.busy,1);
  assert.equal(fs.readFileSync(path.join(dir,'data'),'utf8'),'synthetic data');assert.ok(fs.existsSync(livePath));
});
for(const relation of ['child','ancestor'])test(`B1: a live ${relation} registered during asynchronous inspection prevents deletion`,async t=>{
  const f=fixture(t),dir=f.candidate(),nested=path.join(dir,'nested');
  fs.mkdirSync(nested);fs.writeFileSync(path.join(nested,'keep'),'SYNTHETIC_ACTIVE_OWNER_DATA');
  for(const p of [path.join(nested,'keep'),nested,dir])fs.utimesSync(p,new Date(f.old),new Date(f.old));
  const shown=await f.manager.present(f.person),livePath=relation==='child'?nested:f.base;
  const liveOracle=new TempReminders({dataDir:f.manager.dataDir,registryDir:f.registryDir,roots:[f.base],isPerson:c=>c.person});
  f.manager.isAlive=liveOracle.isAlive;let registered=false,liveReceipt;
  f.manager.inspect=async()=>{
    await new Promise(resolve=>setImmediate(resolve));
    if(!registered) {
      registered=true;ownership.register(livePath,{registryDir:f.registryDir});
      liveReceipt=ownership.read(f.registryDir).find(r=>r.path===livePath);
      assert.equal(liveReceipt.owner.pid,process.pid);assert.equal(f.manager.isAlive(liveReceipt.owner),true);
    }
    return {opened:[],mounted:[]};
  };
  const result=await f.manager.clean(f.person,shown.ticket);
  t.diagnostic(JSON.stringify({relation,result,registered,candidateExists:fs.existsSync(dir),activeDataExists:fs.existsSync(path.join(nested,'keep'))}));
  assert.equal(result.cleaned,0,'A live overlapping receipt installed before deletion protects its data');
  assert.equal(result.reasons.changed,1);assert.equal(result.reasons.unverified,0,'No deletion was dispatched; report kept');
  assert.equal(result.skipped,1);assert.equal(fs.readFileSync(path.join(nested,'keep'),'utf8'),'SYNTHETIC_ACTIVE_OWNER_DATA');
  assert.ok(ownership.read(f.registryDir).some(r=>r.id===liveReceipt.id),'The live receipt is retained');
});
for(const relation of ['child','ancestor'])test(`B1 helper: a live ${relation} registered during the final system inspection prevents deletion`,async t=>{
  const f=fixture(t),dir=f.candidate(),nested=path.join(dir,'nested');
  fs.mkdirSync(nested);fs.writeFileSync(path.join(nested,'keep'),'SYNTHETIC_ACTIVE_OWNER_DATA');
  for(const p of [path.join(nested,'keep'),nested,dir])fs.utimesSync(p,new Date(f.old),new Date(f.old));
  await f.manager.present(f.person);const snapshot=f.manager.candidates[0],livePath=relation==='child'?nested:f.base;
  // Compile the actual helper body; only add the race after its real lsof/mount
  // checks. Its manifest checks and deletion functions remain the product code.
  const register="require(process.argv[1]).register(process.argv[2],{registryDir:process.argv[3],owner:JSON.parse(process.argv[4])})";
  const owner=require('../service-lock.cjs').lockIdentity(process.pid);
  const request={path:dir,owner:snapshot.record.owner,roots:[f.base],entries:snapshot.entries,
    registry:ownership.revision?.(f.registryDir)};
  const harness=`import sys,json,subprocess\nscript,live,registry,node,module,owner,register=sys.argv[1:]\nscope={}\nexec(compile(open(script).read().rsplit('\\ntry: main()',1)[0],script,'exec'),scope)\noriginal=scope['idle_again']\ndef race(*args):\n original(*args)\n subprocess.run([node,'-e',register,module,live,registry,owner],check=True)\nscope['idle_again']=race\nscope['main']()\n`;
  const result=JSON.parse(execFileSync(pythonExecutable(),['-c',harness,path.join(__dirname,'../temp-cleanup.py'),livePath,f.registryDir,process.execPath,require.resolve('../temp-ownership.cjs'),JSON.stringify(owner),register],
    {input:JSON.stringify(request),encoding:'utf8',timeout:10000}));
  assert.equal(result.removed,false,'A registration after the real Python inspection must not permit deletion');
  assert.equal(result.bytes,0);assert.equal(fs.readFileSync(path.join(nested,'keep'),'utf8'),'SYNTHETIC_ACTIVE_OWNER_DATA');
  const receipt=ownership.read(f.registryDir).find(r=>r.path===livePath);
  const liveOracle=new TempReminders({dataDir:f.manager.dataDir,registryDir:f.registryDir,roots:[f.base],isPerson:c=>c.person});
  assert.equal(receipt.owner.pid,process.pid);assert.equal(liveOracle.isAlive(receipt.owner),true);
  assert.equal(result.registryChanged,true);assert.equal(result.untouched,true);
});
test('B1 helper: a registry change after one unlink reports partial work, not untouched',async t=>{
  const f=fixture(t),dir=f.candidate();await f.manager.present(f.person);const snapshot=f.manager.candidates[0];
  const owner=require('../service-lock.cjs').lockIdentity(process.pid);
  const register="require(process.argv[1]).register(process.argv[2],{registryDir:process.argv[3],owner:JSON.parse(process.argv[4])})";
  const harness=`import sys,subprocess\nscript,live,registry,node,module,owner,register=sys.argv[1:]\nscope={}\nexec(compile(open(script).read().rsplit('\\ntry: main()',1)[0],script,'exec'),scope)\noriginal=scope['os'].unlink\ndef race(*args,**kwargs):\n original(*args,**kwargs)\n scope['os'].unlink=original\n subprocess.run([node,'-e',register,module,live,registry,owner],check=True)\nscope['os'].unlink=race\nscope['main']()\n`;
  const request={path:dir,owner:snapshot.record.owner,roots:[f.base],entries:snapshot.entries,registry:ownership.revision(f.registryDir)};
  const result=JSON.parse(execFileSync(pythonExecutable(),['-c',harness,path.join(__dirname,'../temp-cleanup.py'),f.base,f.registryDir,process.execPath,require.resolve('../temp-ownership.cjs'),JSON.stringify(owner),register],
    {input:JSON.stringify(request),encoding:'utf8',timeout:10000}));
  assert.equal(result.removed,false);assert.equal(result.registryChanged,true);assert.equal(result.untouched,false);
  assert.equal(result.bytes,snapshot.entries.find(e=>e.name==='data').bytes);assert.ok(fs.existsSync(dir));
  assert.equal(fs.existsSync(path.join(dir,'data')),false,'The real first unlink must not be hidden by the refusal');
});
test('an unsafe receipt after the matching receipt fails closed and is never removed',async t=>{
  const f=fixture(t),dir=f.candidate(),shown=await f.manager.present(f.person),record=ownership.read(f.registryDir)[0];
  const unsafe=path.join(f.registryDir,'a'.repeat(64)+'.json');fs.writeFileSync(unsafe,'{',{mode:0o600});
  const stream=ownership.batches;
  t.mock.method(ownership,'batches',async function*(...args){yield [record];yield* stream(...args);});
  const result=await f.manager.clean(f.person,shown.ticket);
  assert.equal(result.cleaned,0);assert.equal(result.reasons.unverified,1);
  assert.equal(fs.readFileSync(unsafe,'utf8'),'{');assert.equal(fs.readFileSync(path.join(dir,'data'),'utf8'),'synthetic data');
});
for(const receiptChange of ['missing','redirected'])test(`a ${receiptChange} receipt cannot extend the ticket to an unregistered directory`,async t=>{
  const f=fixture(t),dir=f.candidate(),unknown=fs.mkdtempSync(path.join(f.base,'unregistered-'));
  fs.writeFileSync(path.join(unknown,'keep'),'unowned data');
  const shown=await f.manager.present(f.person),record=ownership.read(f.registryDir)[0],file=path.join(f.registryDir,record.id+'.json');
  if(receiptChange==='missing')fs.unlinkSync(file);
  else fs.writeFileSync(file,JSON.stringify({...record,path:unknown}));
  const result=await f.manager.clean(f.person,shown.ticket);
  assert.equal(result.cleaned,0);assert.equal(result.skipped,1);assert.equal(result.reasons.busy,0);
  assert.equal(fs.readFileSync(path.join(dir,'data'),'utf8'),'synthetic data');
  assert.equal(fs.readFileSync(path.join(unknown,'keep'),'utf8'),'unowned data');
});
test('the shared monotonic budget closes a long stream before any deletion and also bounds the result refresh',async t=>{
  const f=fixture(t),dir=f.candidate(),shown=await f.manager.present(f.person),record=ownership.read(f.registryDir)[0];
  let tick=0,yields=0,closed=0;f.manager.monotonic=()=>tick;
  t.mock.method(ownership,'batches',async function*(){try{for(let i=0;i<6;i++){yields++;yield [record];tick+=6000;}}finally{closed++;}});
  const result=await f.manager.clean(f.person,shown.ticket);
  assert.equal(result.cleaned,0);assert.equal(result.reasons.unverified,1);assert.equal(result.reasons.busy,0);
  assert.ok(yields<=4,'Neither the initial pass nor the refresh may finish an over-budget inventory');
  assert.equal(closed,2,'Both interrupted iterators are closed');assert.ok(fs.existsSync(dir));
  assert.equal(f.manager.cached.anomaly,'inspection-unavailable');assert.equal(f.manager.cached.result,result);
  assert.equal(f.manager.busy,false);await f.manager.finished;
});
test('a budget exhausted during refresh retains the actual successful removal result',async t=>{
  const f=fixture(t),dir=f.candidate(),shown=await f.manager.present(f.person),stream=ownership.batches;
  let tick=0,passes=0;f.manager.monotonic=()=>tick;
  t.mock.method(ownership,'batches',async function*(...args){if(++passes===2)tick=10000;yield* stream(...args);});
  const result=await f.manager.clean(f.person,shown.ticket);
  assert.equal(result.cleaned,1);assert.equal(result.skipped,0);assert.equal(fs.existsSync(dir),false);
  assert.equal(f.manager.cached.anomaly,'inspection-unavailable');assert.equal(f.manager.cached.result.cleaned,1);
});
test('receipt iteration checks its budget even for unrelated names and closes the directory handle',async t=>{
  const f=fixture(t);f.candidate();
  for(const name of ['.DS_Store','backup-note'])fs.writeFileSync(path.join(f.registryDir,name),'unrelated');
  const open=fs.promises.opendir;let handle,checks=0;
  t.mock.method(fs.promises,'opendir',async (...args)=>{handle=await open(...args);return handle;});
  await assert.rejects(async()=>{for await(const _ of ownership.batches(f.registryDir,()=>{if(++checks===3)throw Error('synthetic deadline');})){}},/synthetic deadline/);
  assert.equal(checks,3);await assert.rejects(handle.read(),{code:'ERR_DIR_CLOSED'});
  assert.equal(fs.readFileSync(path.join(f.registryDir,'.DS_Store'),'utf8'),'unrelated');
});
test('a bounded result refresh discards incomplete candidates instead of keeping an unbounded metadata list',async t=>{
  const f=fixture(t),first=f.candidate('first-'),second=f.candidate('second-');
  const status=await f.manager.scan(retained=>{if(retained>=2)throw Object.assign(Error('synthetic memory budget'),{code:'TEMP_BUDGET'});});
  assert.equal(status.directories,0);assert.equal(status.anomaly,'inspection-unavailable');assert.equal(status.shown,true);
  assert.ok(fs.existsSync(first));assert.ok(fs.existsSync(second));assert.deepEqual(f.manager.candidates,[]);
});
test('registry content proof notices an in-place receipt change without any directory timestamp change',t=>{
  const f=fixture(t);f.candidate();const before=ownership.revision(f.registryDir),record=ownership.read(f.registryDir)[0];
  fs.writeFileSync(path.join(f.registryDir,record.id+'.json'),JSON.stringify({...record,creator:'changed synthetic creator'}));
  const after=ownership.revision(f.registryDir);
  assert.deepEqual(after.identity,before.identity,'Only the existing receipt content changed');
  assert.notEqual(after.inventory,before.inventory,'Content, not directory timestamps, must bind the inventory');
});
test('registry content proof checks its budget for stray entries and closes the stream on failure',t=>{
  const f=fixture(t);f.candidate();fs.writeFileSync(path.join(f.registryDir,'.DS_Store'),'unrelated');
  const open=fs.opendirSync;let handle,checks=0;
  t.mock.method(fs,'opendirSync',(...args)=>{handle=open(...args);return handle;});
  assert.throws(()=>ownership.revision(f.registryDir,()=>{if(++checks===2)throw Error('synthetic proof deadline');}),/synthetic proof deadline/);
  assert.equal(checks,2);assert.throws(()=>handle.readSync(),{code:'ERR_DIR_CLOSED'});
  assert.equal(fs.readFileSync(path.join(f.registryDir,'.DS_Store'),'utf8'),'unrelated');
});
