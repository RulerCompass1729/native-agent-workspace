const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFile,execFileSync}=require('node:child_process');
const {PairingStore,keychainAdapter}=require('../mobile-pairing-store.cjs');
const {MobileAccess}=require('../mobile-access.cjs');
const actor='synthetic-person',origin='https://phone.example.test';
function fixture(t,mode='healthy'){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'naw-pairing-availability-'));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let item=null,current=mode,calls=0,hold=false,release,inflight=0,maxInflight=0,holdFailure=false,releaseFailure,signalFailure;const logs=[],actions=[],failureStarted=new Promise(r=>signalFailure=r);
 const adapter=keychainAdapter({platform:'darwin',run(_bin,_args,options,done){
  calls++;const input=JSON.parse(options.input);actions.push(input.action);const active=['put-fail','ack-lost'].includes(current)?(input.action==='put'?current==='put-fail'?'nonzero':'ack-lost':'healthy'):current;
  if(active==='healthy'&&input.action==='put'&&hold&&done){hold=false;inflight++;maxInflight=Math.max(maxInflight,inflight);release=()=>{item=structuredClone(input.value);inflight--;done(null,JSON.stringify({value:null}));};return {stdin:{end(){}}};}
  if(active==='ack-lost'){item=structuredClone(input.value);if(done){queueMicrotask(()=>done(Object.assign(Error('Synthetic lost acknowledgement'),{code:7})));return {stdin:{end(){}}};}throw Error('Synthetic lost acknowledgement');}
  if(active==='healthy'){if(input.action==='put')item=structuredClone(input.value);const out=JSON.stringify({value:input.action==='get'?item:null});if(done){queueMicrotask(()=>done(null,out));return {stdin:{end(){}}};}return out;}
  const code={nonzero:'process.exit(7)',timeout:'setTimeout(()=>{},60000)',invalid:'process.stdout.write("not-json")',overflow:'process.stdout.write(Buffer.alloc(524289,120))',interaction:'process.stderr.write("User interaction is not allowed");process.exit(1)'}[active];
  const start=()=>done?execFile(process.execPath,['-e',code],options,done):execFileSync(process.execPath,['-e',code],options);
  if(holdFailure&&done){holdFailure=false;let child;releaseFailure=()=>{child=start();};signalFailure();return {stdin:{end(){}},kill:()=>child?.kill()};}
  return start();
 }});
 const store=()=>new PairingStore(root,{adapter,asynchronous:true,log:v=>logs.push(v)});
 const details={endpoint:{origin,actor,port:48765,binding:null},all:false,workspace:null,consent:null,consentView:false};
 const access=(s,pid)=>new MobileAccess(root,{exclusive:()=>true,identity:{pid,started:'synthetic-'+pid},transaction:(a,save)=>s.commit(a,details,save),pauseTransaction:(a,m,save)=>s.pause(a,details,m,save),recover:r=>s.take(r)});
 return {root,adapter,store,access,logs,actions,calls:()=>calls,mode:v=>current=v,hold:()=>hold=true,release:()=>release(),holdFailure:()=>holdFailure=true,failureStarted,releaseFailure:()=>releaseFailure(),maxInflight:()=>maxInflight,stored:()=>structuredClone(item),set:v=>item=structuredClone(v)};
}
async function assertYieldBeforeFailure(f,pending){
 let settled=false;pending.then(()=>{settled=true;},()=>{settled=true;});await f.failureStarted;
 try{await new Promise(setImmediate);assert.equal(settled,false,'Event loop progresses while the helper completion is held');}finally{f.releaseFailure();}
}
function pair(a){a.initialize({alive:()=>false});const c=a.beginPairing({actor,origin,scopes:[{serviceKey:'.',sessionId:'synthetic',nativeId:'native',actions:['read']}]});return a.pair({secret:c.secret,actor,origin});}
for(const mode of ['nonzero','timeout','invalid','overflow','interaction','put-fail'])test('helper '+mode+' leaves process-only pairing usable without blocking the event loop',{timeout:20000},async t=>{
 const f=fixture(t,mode);f.holdFailure();const store=f.store();
 const pending=(async()=>{await store.ready?.();store.fresh?.();const a=f.access(store,900001),phone=pair(a);await store.flush?.();return {a,phone};})();
 await assertYieldBeforeFailure(f,pending);const {a,phone}=await pending;assert.equal(store.status?.(),'temporary');
 assert.ok(a.authenticate({token:phone.cookieValue,actor}));assert.equal(a.load().scopes[0].actions.join(','),'read');
 assert.ok(f.logs.some(v=>v.category!=='ok'));assert.ok(f.logs.every(v=>Object.keys(v).sort().join(',')==='category,elapsedMs,phase'));
 a.pause();await store.flush?.();const next=f.store();await next.ready?.();assert.throws(()=>next.checkpoint());
});
test('healthy serialized writes survive pause and a fresh issuer',async t=>{
 const f=fixture(t),s=f.store();await s.ready();s.fresh();const a=f.access(s,900001),phone=pair(a);await s.flush();assert.equal(s.status(),'ready');a.pause();await s.flush();
 const n=f.store();await n.ready();const b=f.access(n,900002);b.resume(n.checkpoint(),{alive:()=>false});await n.flush();assert.ok(b.authenticate({token:phone.cookieValue,actor}));
});
test('a late helper write cannot erase a later revocation or pending-recovery gate',async t=>{
 const f=fixture(t),s=f.store();await s.ready();s.fresh();const a=f.access(s,900001),phone=pair(a);a.revoke();await s.flush();
 assert.throws(()=>a.authenticate({token:phone.cookieValue,actor}));const n=f.store();await n.ready();assert.throws(()=>n.checkpoint());
});
test('the actual bounded helper timeout yields before its completion',{timeout:20000},async t=>{
 const f=fixture(t,'timeout');f.holdFailure();const pending=f.adapter.get('a'.repeat(64));
 await assertYieldBeforeFailure(f,pending);await assert.rejects(pending);
});
test('shutdown bounds a stalled adapter and a late read cannot reopen recovery',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'naw-pairing-late-'));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let release,cancelled=0;const logs=[],s=new PairingStore(root,{asynchronous:true,adapter:{get:()=>new Promise(r=>{release=r;}),put:async()=>{},cancel(){cancelled++;}},log:v=>logs.push(v)});
 const pending=s.ready();s.cancelRecovery();assert.equal(await s.finish(20),'temporary');assert.equal(cancelled,1);release(null);await pending;
 assert.throws(()=>s.checkpoint());assert.equal(fs.existsSync(path.join(root,'mobile-recovery-pending')),true);assert.equal(logs.at(-1).phase,'quit');
});

test('a held pause write settles before a following revoke, never the other way around',async t=>{
 const f=fixture(t),s=f.store();await s.ready();s.fresh();const a=f.access(s,900001),phone=pair(a);await s.flush();
 f.hold();a.pause();await new Promise(setImmediate);a.revoke();f.release();await s.flush();assert.equal(f.maxInflight(),1);
 assert.throws(()=>a.authenticate({token:phone.cookieValue,actor}));const n=f.store();await n.ready();assert.throws(()=>n.checkpoint());
});
test('lost helper acknowledgements resolve by exact readback without replaying a put',async t=>{
 const f=fixture(t,'ack-lost'),s=f.store();await s.ready();s.fresh();const a=f.access(s,900001),phone=pair(a);await s.flush();
 assert.equal(s.status(),'ready');assert.equal(f.actions.filter(v=>v==='put').length,3);assert.ok(a.authenticate({token:phone.cookieValue,actor}));
});
test('a failed local candidate rename queues the exact rollback and keeps only the old phone',async t=>{
 const f=fixture(t),s=f.store();await s.ready();s.fresh();const a=f.access(s,900001),old=pair(a);await s.flush();const before=JSON.stringify(f.stored());
 const c=a.beginCandidate({actor,origin,replace:true}),fresh=a.pairCandidate({secret:c.secret,actor,origin});const io=Object.create(fs);io.renameSync=()=>{throw Error('Synthetic rename failure');};a.io=io;
 assert.throws(()=>a.activateCandidate(c.id,[{serviceKey:'.',sessionId:'synthetic',nativeId:'native',actions:['read']}]));a.io=fs;await s.flush();
 assert.equal(JSON.stringify(f.stored()),before);assert.ok(a.authenticate({token:old.cookieValue,actor}));assert.throws(()=>a.authenticate({token:fresh.cookieValue,actor}));
});
test('a changed authoritative anchor between checkpoint and commit refuses recovery',async t=>{
 const f=fixture(t),s=f.store();await s.ready();s.fresh();pair(f.access(s,900001));await s.flush();const checkpoint=s.checkpoint();f.set(null);
 await assert.rejects(()=>s.confirm(checkpoint));assert.throws(()=>s.take(checkpoint));assert.equal(s.status(),'temporary');
});
test('durable diagnostics accept only fixed metadata and never follow a link',t=>{
 const f=fixture(t),{logPairing}=require('../mobile-pairing-store.cjs'),entry={phase:'boot',category:'timeout',elapsedMs:5000};
 assert.equal(logPairing(f.root,entry),true);const file=path.join(f.root,'mobile-persistence.log');assert.deepEqual(JSON.parse(fs.readFileSync(file)),entry);assert.equal(fs.statSync(file).mode&0o777,0o600);
 assert.equal(logPairing(f.root,{...entry,stderr:'synthetic-private'}),false);assert.equal(logPairing(f.root,{...entry,category:'synthetic-private'}),false);assert.equal(fs.readFileSync(file,'utf8').includes('synthetic-private'),false);
 fs.renameSync(file,file+'.owned');fs.symlinkSync(file+'.owned',file);assert.equal(logPairing(f.root,entry),false);
});
test('a later explicit revoke retry seals an old anchor without re-enabling persistence',async t=>{
 const f=fixture(t),s=f.store();await s.ready();s.fresh();const a=f.access(s,900001),phone=pair(a);await s.flush();f.mode('put-fail');a.revoke();await s.flush();
 assert.equal(s.status(),'temporary');assert.equal(f.stored().authority.enabled,true);f.mode('healthy');assert.equal(await s.sealRevocation(),true);
 assert.equal(f.stored().authority.enabled,false);assert.equal(s.status(),'temporary');assert.throws(()=>a.authenticate({token:phone.cookieValue,actor}));const n=f.store();await n.ready();assert.throws(()=>n.checkpoint());
});
test('a FIFO recovery barrier is refused without blocking the caller',async t=>{
 const f=fixture(t);execFileSync('/usr/bin/mkfifo',[path.join(f.root,'mobile-recovery-pending')]);
 const code="const {PairingStore}=require(process.argv[2]);new PairingStore(process.argv[1],{asynchronous:true,adapter:{get:async()=>{throw Error('Synthetic refusal')},put:async()=>{}}}).ready().then(()=>process.exit(2),()=>process.exit(0));";
 const child=require('node:child_process').spawn(process.execPath,['-e',code,f.root,require.resolve('../mobile-pairing-store.cjs')],{stdio:'ignore',env:process.env});
 const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>child.kill(),1000);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});});
 assert.equal(result.code,0,'Malformed barrier must reject, not wait for a FIFO writer');assert.equal(result.signal,null);
});

test('a pause while retiring a replacement invalidates its commit proof',async t=>{
 const f=fixture(t),s=f.store();await s.ready();s.fresh();const a=f.access(s,900001),phone=pair(a);await s.flush();
 f.hold();const pending=s.prepareReplacement();await new Promise(setImmediate);a.pause();f.release();
 await assert.rejects(pending);await s.flush();assert.throws(()=>a.authenticate({token:phone.cookieValue,actor}));assert.equal(f.stored().authority.enabled,false);
 const next=f.store();await next.ready();assert.throws(()=>next.checkpoint());
});
test('a changed mirror after retirement cannot reuse the replacement proof',async t=>{
 const f=fixture(t),s=f.store();await s.ready();s.fresh();const a=f.access(s,900001);pair(a);await s.flush();
 const commit=await s.prepareReplacement();a.save(a.load());assert.throws(commit);await s.flush();
});
test('lost retirement acknowledgement requires an exact disabled-anchor readback',async t=>{
 const f=fixture(t),s=f.store();await s.ready();s.fresh();const a=f.access(s,900001);pair(a);await s.flush();f.mode('ack-lost');
 const puts=f.actions.filter(x=>x==='put').length,commit=await s.prepareReplacement();
 assert.equal(f.stored().authority.enabled,false);assert.equal(f.actions.filter(x=>x==='put').length,puts+1);assert.doesNotThrow(commit);assert.throws(commit);
});
test('a failed retirement cannot retry against a different authoritative anchor',async t=>{
 const f=fixture(t),s=f.store();await s.ready();s.fresh();const a=f.access(s,900001);pair(a);await s.flush();
 f.mode('put-fail');await assert.rejects(()=>s.prepareReplacement());f.mode('healthy');f.set(null);
 const puts=f.actions.filter(x=>x==='put').length;await assert.rejects(()=>s.prepareReplacement());assert.equal(f.actions.filter(x=>x==='put').length,puts);
});
