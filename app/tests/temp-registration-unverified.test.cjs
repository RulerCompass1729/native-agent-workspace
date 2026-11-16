const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync,spawn}=require('node:child_process');
const ownership=require('../temp-ownership.cjs'),{TempReminders,DAY,readSummary,tempSummary}=require('../temp-reminders.cjs');
const {pythonExecutable}=require('../platform.cjs');
function fixture(t) {
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'naw-registration-unverified-'))),registryDir=path.join(base,'registry'),dataDir=path.join(base,'profile');
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));fs.mkdirSync(dataDir,{mode:0o700});
  const dir=path.join(base,'candidate'),nested=path.join(dir,'nested'),payload=path.join(nested,'keep'),now=Date.now(),old=now-8*DAY;
  fs.mkdirSync(dir);fs.mkdirSync(nested);fs.writeFileSync(payload,'SYNTHETIC_ACTIVE_DATA');
  ownership.register(dir,{registryDir,owner:{pid:2**30,started:'synthetic exited owner'},now:()=>old});
  for(const p of [payload,nested,dir])fs.utimesSync(p,new Date(old),new Date(old));
  const manager=new TempReminders({dataDir,registryDir,roots:[base],now:()=>now,isPerson:c=>c.person,inspect:async()=>({opened:[],mounted:[]})}),person={person:true};
  const helper=request=>JSON.parse(execFileSync(pythonExecutable(),[path.join(__dirname,'../temp-cleanup.py')],{input:JSON.stringify(request),encoding:'utf8',timeout:10000}));
  async function prepare() {
    const shown=await manager.present(person),snapshot=manager.candidates[0];
    return {shown,request:{path:dir,owner:snapshot.record.owner,roots:[base],entries:snapshot.entries,registry:ownership.revision(registryDir)}};
  }
  return {base,registryDir,dataDir,dir,nested,payload,manager,person,helper,prepare};
}
const sizes=f=>['registration-started','registration-finished'].map(n=>fs.statSync(path.join(f.registryDir,n)).size);
// Compare the complete private inventory, including unknown pending files.
const inventory=f=>Object.fromEntries(fs.readdirSync(f.registryDir).sort().map(n=>[n,fs.readFileSync(path.join(f.registryDir,n)).toString('hex')]));
async function kept(f,prepared,issue='incomplete') {
  const before=inventory(f),result=await f.manager.clean(f.person,prepared.shown.ticket),py=f.helper(prepared.request);
  assert.equal(result.cleaned,0);assert.equal(result.bytes,0);assert.equal(result.reasons.unverified,1);
  assert.equal(py.removed,false);assert.equal(py.bytes,0);assert.equal(py.untouched,true);
  assert.equal(fs.readFileSync(f.payload,'utf8'),'SYNTHETIC_ACTIVE_DATA');
  assert.deepEqual(inventory(f),before,'No counter reset, receipt removal, or invented completion');
  assert.equal(result.registrationIssue,issue,'The person must see why cleanup stayed unverified');
  assert.equal(py.registrationIssue,issue,'Node and Python report the same bounded reason');
  const status=await f.manager.status(true);
  assert.equal(status.registrationIssue,issue);assert.equal(status.anomaly,'registration-unverified');
  assert.equal(status.shown,true);assert.equal(status.directories,0);assert.equal(f.manager.candidates.length,0);
  assert.equal(readSummary(f.dataDir).registrationIssue,issue);
  assert.equal(readSummary(f.dataDir).result.registrationIssue,issue);
  assert.deepEqual(inventory(f),before,'Repeated status reads do not repair anonymous history');
}
test('A1: finished ENOSPC stays safely blocked with an explicit reason after storage and later registration recover',async t=>{
  const f=fixture(t),prepared=await f.prepare(),finished=fs.statSync(path.join(f.registryDir,'registration-finished')),write=fs.writeSync;
  const mock=t.mock.method(fs,'writeSync',(fd,...args)=>{const s=fs.fstatSync(fd);if(s.dev===finished.dev&&s.ino===finished.ino)throw Object.assign(Error('synthetic ENOSPC'),{code:'ENOSPC'});return write(fd,...args);});
  assert.throws(()=>ownership.register(f.nested,{registryDir:f.registryDir}),{code:'ENOSPC'});mock.mock.restore();assert.deepEqual(sizes(f),[2,1]);
  assert.equal((await f.manager.status(true)).registrationIssue,'incomplete');
  assert.equal(f.helper(prepared.request).registrationIssue,'incomplete');
  const other=path.join(f.base,'later');fs.mkdirSync(other);ownership.register(other,{registryDir:f.registryDir});assert.deepEqual(sizes(f),[3,2]);
  await kept(f,prepared);assert.deepEqual(sizes(f),[3,2]);
});
async function pausedWriter(t,f) {
  const script="const fs=require('node:fs'),path=require('node:path'),own=require(process.argv[1]),write=fs.writeFileSync;fs.writeFileSync=(file,...args)=>{if(String(file).startsWith(path.join(process.argv[3],'.pending-'))){write(file,'UNKNOWN_PARTIAL_RECEIPT',{mode:0o600,flag:'wx'});fs.writeSync(1,'READY\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,12000);throw Error('writer timeout')}return write(file,...args)};own.register(process.argv[2],{registryDir:process.argv[3]});";
  const child=spawn(process.execPath,['-e',script,require.resolve('../temp-ownership.cjs'),f.nested,f.registryDir],{stdio:['ignore','pipe','pipe']});
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await closed;});
  await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('writer did not pause')),5000);child.stdout.on('data',b=>{text+=b;if(text.includes('READY')){clearTimeout(timer);resolve();}});child.once('error',error=>{clearTimeout(timer);reject(error);});});
  assert.deepEqual(sizes(f),[2,1]);return {child,closed};
}
test('A1: a real SIGKILL before receipt publication preserves the unknown pending file and explains the block',async t=>{
  const f=fixture(t),prepared=await f.prepare(),writer=await pausedWriter(t,f);
  writer.child.kill('SIGKILL');assert.equal((await writer.closed).signal,'SIGKILL');
  await kept(f,prepared);assert.deepEqual(sizes(f),[2,1]);
});
test('A1: a live writer paused before receipt publication never authorizes cleanup',async t=>{
  const f=fixture(t),prepared=await f.prepare(),writer=await pausedWriter(t,f);
  process.kill(writer.child.pid,0);await kept(f,prepared);process.kill(writer.child.pid,0);
});
test('A1: a reused receipt PID does not prove that an anonymous unmatched writer ended',async t=>{
  const f=fixture(t),prepared=await f.prepare();
  // Synthetic PID-reuse identity, not an assertion that the OS reused a PID.
  // The ordinary owner oracle regards the old receipt owner as dead. An
  // unpaired generation has no identity to compare and must still block.
  const receipt=ownership.read(f.registryDir)[0];receipt.owner={pid:process.pid,started:'synthetic prior process start'};
  fs.writeFileSync(path.join(f.registryDir,receipt.id+'.json'),JSON.stringify(receipt),{mode:0o600});
  assert.equal(f.manager.isAlive(receipt.owner),false);
  fs.appendFileSync(path.join(f.registryDir,'registration-started'),Buffer.from([0]));
  await kept(f,prepared);
});
test('A1: a new registration during status inspection removes candidates and keeps all live payload',async t=>{
  const f=fixture(t),prepared=await f.prepare();let raced=false;
  f.manager.inspect=async()=>{if(!raced){raced=true;fs.appendFileSync(path.join(f.registryDir,'registration-started'),Buffer.from([0]));ownership.register(f.nested,{registryDir:f.registryDir});}return {opened:[],mounted:[]};};
  const status=await f.manager.status(true);
  assert.ok(raced);assert.equal(fs.readFileSync(f.payload,'utf8'),'SYNTHETIC_ACTIVE_DATA');
  assert.equal(status.registrationIssue,'incomplete');assert.equal(status.directories,0);
  await kept(f,prepared);assert.deepEqual(sizes(f),[3,2]);
});
for(const kind of ['missing','unsafe'])test(`A1: ${kind} counter metadata reports its reason without initializing a replacement`,async t=>{
  const f=fixture(t),prepared=await f.prepare(),file=path.join(f.registryDir,'registration-finished');
  if(kind==='missing')fs.unlinkSync(file);else fs.chmodSync(file,0o644);
  await kept(f,prepared,'metadata-unavailable');
  if(kind==='missing')assert.equal(fs.existsSync(file),false);else assert.equal(fs.statSync(file).mode&0o777,0o644);
});
test('A1: a counter disappearing after the diagnostic read is not recreated by the cleanup proof',t=>{
  const f=fixture(t),lstat=fs.lstatSync,finished=path.join(f.registryDir,'registration-finished');let reads=0;
  const mock=t.mock.method(fs,'lstatSync',(file,...args)=>{
    const value=lstat(file,...args);
    // Presence, open validation, then the two generation observations.
    if(file===path.join(f.registryDir,'registration-started')&&++reads===4)fs.unlinkSync(finished);
    return value;
  });
  assert.throws(()=>ownership.revision(f.registryDir));mock.mock.restore();assert.ok(reads>=4);
  assert.equal(fs.existsSync(finished),false,'A read must not repair a partially lost pair');
  assert.equal(fs.readFileSync(f.payload,'utf8'),'SYNTHETIC_ACTIVE_DATA');
});
test('A1: summaries reject unknown registration diagnostics instead of publishing arbitrary text',()=>{
  const r={version:1,checkedAt:1,directories:0,bytes:0,shown:true,anomaly:'registration-unverified',registrationIssue:'SYNTHETIC_PRIVATE_PATH'};
  assert.throws(()=>tempSummary(r),/registration/i);
  delete r.registrationIssue;r.result={at:1,cleaned:0,bytes:0,skipped:1,registrationIssue:'SYNTHETIC_PRIVATE_PATH'};
  assert.throws(()=>tempSummary(r),/registration/i);
});
