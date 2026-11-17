const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const ownership=require('../temp-ownership.cjs'),{TempReminders,DAY}=require('../temp-reminders.cjs');
for(const phase of ['Python'])test(`B1 HFS_CURSOR ${phase}: a live receipt registered during checkpoint enumeration prevents deletion`, {timeout:150000,skip:process.platform!=='darwin'},async t=>{
 const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'naw-g-hfs-registry-'))),image=path.join(base,'fixture.dmg'),mount=path.join(base,'volume');
 fs.mkdirSync(mount);const originalTmp=process.env.TMPDIR;let attached=false;
 try{
  execFileSync('/usr/bin/hdiutil',['create','-size','32m','-fs','HFS+','-volname','NAWReviewFixture','-layout','NONE',image],{encoding:'utf8',timeout:30000});
  const attach=execFileSync('/usr/bin/hdiutil',['attach','-nobrowse','-noautoopen','-owners','on','-mountpoint',mount,image],{encoding:'utf8',timeout:30000});attached=true;
  fs.writeFileSync(path.join(mount,'.metadata_never_index'),'');
  const root=path.join(base,'private-temp');fs.mkdirSync(root,{mode:0o700});process.env.TMPDIR=root;
  const dataDir=path.join(root,'profile'),registryDir=path.join(mount,'registry'),dir=path.join(root,'candidate');let nested=path.join(dir,'nested');
  fs.mkdirSync(dataDir,{mode:0o700});fs.mkdirSync(dir);fs.mkdirSync(nested);let payload=path.join(nested,'keep');fs.writeFileSync(payload,'SYNTHETIC_ACTIVE_OWNER_DATA');
  const now=Date.now(),old=now-8*DAY;ownership.register(dir,{registryDir,owner:{pid:2**30,started:'synthetic exited owner'},now:()=>old});
  for(const p of [payload,nested,dir])fs.utimesSync(p,new Date(old),new Date(old));
  const manager=new TempReminders({dataDir,registryDir,roots:[root],now:()=>now,isPerson:c=>c.person}),person={person:true};
  for(let i=0;i<32;i++){const sibling=path.join(root,'active-sibling-'+i);fs.mkdirSync(sibling);ownership.register(sibling,{registryDir});}
  // Every hex receipt name sorts before this existing generation counter on
  // HFS+. Register after consuming it: no random hash search is needed to put
  // the new receipt behind the real directory cursor.
  const cursorName='registration-finished';
  const shown=await manager.present(person);assert.equal(shown.directories,1);
  // Model HFS timestamp aliasing in the Python fixture, without a wall-clock
  // deadline: only this registry directory's mtime/ctime are projected. Its
  // identity, real receipts/counters, iterator, owner and deletion stay real.
  if(phase==='Node') {
  const realInspect=manager.inspect;let proofBefore,proofAfter,liveId,ownerAlive;manager.inspect=async()=>{
   if(!liveId){proofBefore=ownership.revision(registryDir);liveId=ownership.register(nested,{registryDir});proofAfter=ownership.revision(registryDir);
    const live=ownership.read(registryDir).find(r=>r.id===liveId);ownerAlive=manager.isAlive(live.owner);assert.equal(ownerAlive,true);
    t.diagnostic(JSON.stringify({attach:attach.trim(),registryFilesystemType:fs.statfsSync(registryDir).type,targetFilesystemType:fs.statfsSync(dir).type,proofBefore,proofAfter,proofEqual:JSON.stringify(proofBefore)===JSON.stringify(proofAfter),ownerAlive}));
   }return await realInspect();
  };
  const result=await manager.clean(person,shown.ticket);t.diagnostic(JSON.stringify({result,candidateExists:fs.existsSync(dir),activeDataExists:fs.existsSync(payload),ownerAlive}));
  assert.deepEqual(proofBefore.identity,proofAfter.identity,'The old timestamp-only proof really collides');
  assert.equal(result.cleaned,0,'Registering a live child on a supported private filesystem must preserve its data');
  } else {
   const snapshot=manager.candidates[0],owner=require('../service-lock.cjs').lockIdentity(process.pid),diagnostic=path.join(base,'helper-proof.json');
   const register="require(process.argv[1]).register(process.argv[2],{registryDir:process.argv[3],owner:JSON.parse(process.argv[4])})";
   const request={path:dir,owner:snapshot.record.owner,roots:[root],entries:snapshot.entries,registry:ownership.revision(registryDir)};
   const harness=`import sys,json,subprocess,os,io
script,live,registry,node,module,owner,register,diagnostic=sys.argv[1:]
scope={}
exec(compile(open(script).read().rsplit('\\ntry: main()',1)[0],script,'exec'),scope)
request=json.load(sys.stdin)
sys.stdin=io.StringIO(json.dumps(request))
original_stat=os.stat
registry_stat=original_stat(registry)
fixed_mtime,fixed_ctime=map(int,request['registry']['identity'][4:])
class RegistryTimes:
 def __init__(self,actual): self.actual=actual
 def __getattr__(self,name):
  if name=='st_mtime_ns': return fixed_mtime
  if name=='st_ctime_ns': return fixed_ctime
  if name=='st_mtime': return fixed_mtime/1000000000
  if name=='st_ctime': return fixed_ctime/1000000000
  return getattr(self.actual,name)
def fixed_registry_times(original):
 def read(*args,**kwargs):
  actual=original(*args,**kwargs)
  if (actual.st_dev,actual.st_ino)==(registry_stat.st_dev,registry_stat.st_ino): return RegistryTimes(actual)
  return actual
 return read
for name in ('stat','lstat','fstat'): setattr(os,name,fixed_registry_times(getattr(os,name)))
original_scan=os.scandir
scans=0
registered=False
def identity(raw=False):
 s=original_stat(registry) if raw else os.stat(registry)
 return [str(s.st_dev),str(s.st_ino),str(s.st_uid),str(s.st_mode),str(s.st_mtime_ns),str(s.st_ctime_ns)]
class ChangingScan:
 def __init__(self,fd):
  global scans
  scans+=1
  self.number=scans
  self.inner=original_scan(fd)
  self.started=False
  self.seen=[]
  self.details=None
 def __enter__(self):
  self.inner.__enter__()
  return self
 def __exit__(self,*args):
  if self.details is not None:
   self.details['enumerated']=self.seen
   with open(diagnostic,'w') as f: json.dump(self.details,f)
  return self.inner.__exit__(*args)
 def __iter__(self): return self
 def __next__(self):
  global registered
  entry=next(self.inner)
  self.seen.append(entry.name)
  if self.number==3 and entry.name=='registration-finished' and not self.started:
   self.started=True
   before=identity()
   actual_before=identity(True)
   subprocess.run([node,'-e',register,module,live,registry,owner],check=True)
   registered=True
   self.details={'before':before,'after':identity(),'actualBefore':actual_before,'actualAfter':identity(True),'duringScan':self.number,'firstEntry':entry.name}
  return entry
os.scandir=ChangingScan
scope['main']()
`;
   const result=JSON.parse(execFileSync(require('../platform.cjs').pythonExecutable(),['-c',harness,path.join(__dirname,'../temp-cleanup.py'),nested,registryDir,process.execPath,require.resolve('../temp-ownership.cjs'),JSON.stringify(owner),register,diagnostic],{input:JSON.stringify(request),encoding:'utf8',timeout:10000}));
   const observed=JSON.parse(fs.readFileSync(diagnostic,'utf8'));
   assert.deepEqual(observed.before,request.registry.identity);assert.deepEqual(observed.after,observed.before,'Python must detect a registration the timestamp-only proof misses');
   assert.deepEqual(observed.actualBefore.slice(0,4),request.registry.identity.slice(0,4),'The actual registry identity is unchanged');
   assert.deepEqual(observed.actualAfter.slice(0,4),observed.actualBefore.slice(0,4),'Only directory timestamps are projected');
   const live=ownership.read(registryDir).find(r=>r.path===nested);assert.equal(manager.isAlive(live.owner),true);observed.liveId=live.id;observed.liveReceiptSeen=observed.enumerated.includes(live.id+'.json');observed.enumeratedCount=observed.enumerated.length;
   t.diagnostic(JSON.stringify({phase,result,observed,candidateExists:fs.existsSync(dir),activeDataExists:fs.existsSync(payload)}));
   assert.equal(observed.firstEntry,cursorName,'Register only after the existing counter has been consumed');
   assert.ok(live.id+'.json'<cursorName,'The real receipt must sort behind the consumed cursor');
   assert.equal(observed.liveReceiptSeen,false,'The real HFS iterator must miss the new live receipt');
   assert.equal(result.removed,false,'The real helper must retain the live data even when Node already dispatched it');
   assert.equal(result.bytes,0);assert.equal(result.registryChanged,true);assert.equal(result.untouched,true);
  }
  assert.equal(fs.readFileSync(payload,'utf8'),'SYNTHETIC_ACTIVE_OWNER_DATA');
 }finally{
  if(originalTmp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=originalTmp;
  const isMounted=()=>execFileSync('/sbin/mount',[],{encoding:'utf8',timeout:10000}).split('\n').some(l=>l.includes(' on '+mount+' ('));
  if(attached||isMounted()){try{execFileSync('/usr/bin/hdiutil',['detach',mount],{encoding:'utf8',timeout:30000});}catch(error){execFileSync('/usr/bin/hdiutil',['detach','-force',mount],{encoding:'utf8',timeout:30000});}attached=false;t.diagnostic('Owned HFS fixture detached');}
  // Never sweep an unknown mount: only this newly created image and directory.
  assert.equal(attached,false);assert.equal(isMounted(),false);fs.rmSync(base,{recursive:true,force:true});
 }
});
