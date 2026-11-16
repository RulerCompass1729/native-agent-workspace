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
  // Choose a real child whose legitimate receipt name sorts behind the already
  // consumed HFS directory cursor. No filesystem result or digest is replaced.
  const firstName=ownership.read(registryDir).map(r=>r.id).sort()[0];let chosenId=null;
  for(let i=0;i<4096;i++){
   const alternative=path.join(dir,'nested-'+i);fs.mkdirSync(alternative);const st=fs.statSync(alternative);
   const id=require('node:crypto').createHash('sha256').update(JSON.stringify([alternative,st.dev,st.ino,st.uid])).digest('hex');
   if(id<firstName){fs.renameSync(payload,path.join(alternative,'keep'));fs.rmdirSync(nested);nested=alternative;payload=path.join(nested,'keep');chosenId=id;break;}
   fs.rmdirSync(alternative);
  }
  assert.ok(chosenId,'A bounded synthetic setup must find a lower real receipt id');
  for(const p of [payload,nested,dir])fs.utimesSync(p,new Date(old),new Date(old));
  t.diagnostic(JSON.stringify({chosenId,firstName,ordering:chosenId<firstName}));
  const shown=await manager.present(person);assert.equal(shown.directories,1);
  // Start safely inside a fresh one-second timestamp interval. No stat values,
  // register(), receipt contents, liveness oracle or deletion gates are mocked.
  await new Promise(r=>setTimeout(r,1000-Date.now()%1000+25));
  const touch=path.join(registryDir,'.time-marker');fs.writeFileSync(touch,'x');fs.unlinkSync(touch);
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
   const harness=`import sys,json,subprocess,os\nscript,live,registry,node,module,owner,register,diagnostic=sys.argv[1:]\nscope={}\nexec(compile(open(script).read().rsplit('\\ntry: main()',1)[0],script,'exec'),scope)\noriginal_scan=os.scandir\nscans=0\nregistered=False\ndef identity():\n s=os.stat(registry)\n return [str(s.st_dev),str(s.st_ino),str(s.st_uid),str(s.st_mode),str(s.st_mtime_ns),str(s.st_ctime_ns)]\nclass ChangingScan:\n def __init__(self,fd):\n  global scans\n  scans+=1\n  self.number=scans\n  self.inner=original_scan(fd)\n  self.started=False\n  self.seen=[]\n  self.details=None\n def __enter__(self):\n  self.inner.__enter__()\n  return self\n def __exit__(self,*args):\n  if self.details is not None:\n   self.details['enumerated']=self.seen\n   with open(diagnostic,'w') as f: json.dump(self.details,f)\n  return self.inner.__exit__(*args)\n def __iter__(self): return self\n def __next__(self):\n  global registered\n  entry=next(self.inner)\n  self.seen.append(entry.name)\n  if self.number==3 and not self.started:\n   self.started=True\n   before=identity()\n   subprocess.run([node,'-e',register,module,live,registry,owner],check=True)\n   registered=True\n   self.details={'before':before,'after':identity(),'duringScan':self.number,'firstEntry':entry.name}\n  return entry\nos.scandir=ChangingScan\nscope['main']()\n`;
   const result=JSON.parse(execFileSync(require('../platform.cjs').pythonExecutable(),['-c',harness,path.join(__dirname,'../temp-cleanup.py'),nested,registryDir,process.execPath,require.resolve('../temp-ownership.cjs'),JSON.stringify(owner),register,diagnostic],{input:JSON.stringify(request),encoding:'utf8',timeout:10000}));
   const observed=JSON.parse(fs.readFileSync(diagnostic,'utf8'));
   assert.deepEqual(observed.before,request.registry.identity);assert.deepEqual(observed.after,observed.before,'Python must detect a registration the timestamp-only proof misses');
   const live=ownership.read(registryDir).find(r=>r.path===nested);assert.equal(manager.isAlive(live.owner),true);observed.liveId=live.id;observed.liveReceiptSeen=observed.enumerated.includes(live.id+'.json');observed.enumeratedCount=observed.enumerated.length;
   t.diagnostic(JSON.stringify({phase,result,observed,candidateExists:fs.existsSync(dir),activeDataExists:fs.existsSync(payload)}));
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
