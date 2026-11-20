const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {MobileAccess,FILE,OFF,SESSION_MS,verifyTicket}=require('../mobile-access.cjs');
const actor='synthetic-person',origin='https://phone.example.test';
const target={serviceKey:'.',sessionId:'synthetic-session',nativeId:'synthetic-native'};
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'naw-pairing-persist-'));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true}));
 const {PairingStore}=require('../mobile-pairing-store.cjs');let item=null,writes=0,fail=false,after=false,time=1700000000000;
 const adapter={get(){return item===null?null:structuredClone(item);},put(_account,value){writes++;if(fail)throw Error('Synthetic keychain refusal');item=structuredClone(value);if(after)throw Error('Synthetic lost acknowledgement');}};
 const store=new PairingStore(root,{adapter});let details={endpoint:{origin,actor,port:48765,binding:null},all:false,workspace:null,consent:null,consentView:false};
 const access=pid=>new MobileAccess(root,{identity:{pid,started:'synthetic-'+pid},now:()=>time,exclusive:()=>true,transaction:(value,save)=>store.commit(value,details,save),pauseTransaction:(value,mirror,save)=>store.pause(value,details,mirror,save),recover:receipt=>store.take(receipt)});
 const first=access(900001);first.initialize({alive:()=>false});
 function pair(a=first){const c=a.beginPairing({actor,origin,scopes:[{...target,actions:['read']}]});return a.pair({secret:c.secret,actor,origin});}
 return {root,store,first,access,pair,adapter,get:()=>structuredClone(item),set:v=>{item=structuredClone(v);},writes:()=>writes,fail:v=>{fail=v;},after:v=>{after=v;},advance:n=>{time+=n;},now:()=>time,details:v=>{details=v;}};
}
test('one completed pairing survives a new issuer without extending its original expiry',t=>{
 const f=fixture(t),phone=f.pair(),before=f.first.load(),old=f.first.authorize({token:phone.cookieValue,actor,action:'read',target});
 const next=f.access(900002),restored=next.resume(f.store.checkpoint(),{alive:()=>false});
 assert.equal(next.authenticate({token:phone.cookieValue,actor}).device.id,before.device.id);
 assert.equal(restored.state.device.until,before.device.until);assert.equal(restored.csrf!==phone.csrf,true);
 assert.notEqual(restored.state.generation,before.generation);assert.notDeepEqual(restored.state.issuer,before.issuer);
 assert.throws(()=>verifyTicket(f.root,old,target,'read',{now:f.now,alive:()=>true}));
 assert.throws(()=>next.authorize({token:phone.cookieValue,actor,origin,csrf:restored.csrf,action:'send',target}));
});
test('pause refuses old native tickets before process exit, while keeping only a Keychain recovery grant',t=>{
 const f=fixture(t),phone=f.pair(),ticket=f.first.authorize({token:phone.cookieValue,actor,action:'read',target});assert.equal(verifyTicket(f.root,ticket,target,'read',{now:f.now,alive:()=>true}),true);
 assert.equal(f.first.pause().paused,true);assert.throws(()=>verifyTicket(f.root,ticket,target,'read',{now:f.now,alive:()=>true}));
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,FILE))).enabled,false);assert.equal(f.get().authority.enabled,true);
 const next=f.access(900002);next.resume(f.store.checkpoint(),{alive:()=>false});assert.ok(next.authenticate({token:phone.cookieValue,actor}));
});
test('explicit revocation survives restart and restoring the old profile file',t=>{
 const f=fixture(t),phone=f.pair(),old=fs.readFileSync(path.join(f.root,FILE));assert.equal(f.first.revoke().confirmed,true);
 assert.throws(()=>f.store.checkpoint());fs.writeFileSync(path.join(f.root,FILE),old);
 assert.throws(()=>f.access(900002).resume(f.store.checkpoint(),{alive:()=>false}));
 assert.throws(()=>f.first.authenticate({token:phone.cookieValue,actor}));
});
test('completed replacement survives restart with only the new phone valid',t=>{
 const f=fixture(t),old=f.pair(),c=f.first.beginCandidate({actor,origin,replace:true}),fresh=f.first.pairCandidate({secret:c.secret,actor,origin});
 f.first.activateCandidate(c.id,[{...target,actions:['read']}]);
 const next=f.access(900002);next.resume(f.store.checkpoint(),{alive:()=>false});
 assert.throws(()=>next.authenticate({token:old.cookieValue,actor}));assert.ok(next.authenticate({token:fresh.cookieValue,actor}));
});
test('an unfinished candidate is never a persistent grant and cannot replace the old phone',t=>{
 const f=fixture(t),old=f.pair(),generation=f.get().authority.generation;
 const c=f.first.beginCandidate({actor,origin,replace:true});f.first.pairCandidate({secret:c.secret,actor,origin});
 assert.equal(f.get().authority.generation,generation);const next=f.access(900002);next.resume(f.store.checkpoint(),{alive:()=>false});
 assert.ok(next.authenticate({token:old.cookieValue,actor}));
});
for(const change of ['corrupt','extra','permissions','symlink','hardlink'])test('restart refuses '+change+' authority metadata',t=>{
 const f=fixture(t);f.pair();const file=path.join(f.root,FILE);
 if(change==='corrupt')fs.writeFileSync(file,'{');
 if(change==='extra'){const a=JSON.parse(fs.readFileSync(file));a.extra=true;fs.writeFileSync(file,JSON.stringify(a));}
 if(change==='permissions')fs.chmodSync(file,0o644);
 if(change==='symlink'){fs.renameSync(file,file+'.real');fs.symlinkSync(file+'.real',file);}
 if(change==='hardlink')fs.linkSync(file,file+'.link');
 assert.throws(()=>f.store.checkpoint());
});
for(const change of ['format','profile','scope','device','enabled','empty'])test('restart refuses '+change+' Keychain record',t=>{
 const f=fixture(t);f.pair();const value=f.get();
 if(change==='format')value.version=0;if(change==='profile')value.profile='0'.repeat(64);
 if(change==='scope')value.authority.scopes[0].actions.push('send');if(change==='device')value.authority.device.id=crypto.randomUUID();
 if(change==='enabled')value.authority.enabled=false;if(change==='empty'){f.set(null);}else f.set(value);
 assert.throws(()=>f.store.checkpoint());
});
test('an old-format authority without a Keychain receipt is not silently imported',t=>{const f=fixture(t);f.pair();f.set(null);assert.throws(()=>f.store.checkpoint());});
test('expired grants and an OFF marker never resume',t=>{for(const end of ['expiry','OFF']){const f=fixture(t);f.pair();if(end==='expiry')f.advance(SESSION_MS);else fs.writeFileSync(path.join(f.root,OFF),'',{mode:0o600});assert.throws(()=>f.access(900002).resume(f.store.checkpoint(),{alive:()=>false}));}});
test('a live or unconfirmed previous issuer and a forged checkpoint cannot resume',t=>{
 const f=fixture(t);f.pair();for(const alive of [true,undefined])assert.throws(()=>f.access(900002).resume(f.store.checkpoint(),{alive:()=>alive}));
 assert.throws(()=>f.access(900002).resume(f.get(),{alive:()=>false}));
});
test('a checkpoint is single use and cannot cross a later revocation',t=>{
 const f=fixture(t);f.pair();const cp=f.store.checkpoint();f.first.revoke();assert.throws(()=>f.access(900002).resume(cp,{alive:()=>false}));
});
test('Keychain failure before replacement preserves the old grant',t=>{
 const f=fixture(t),old=f.pair(),before=f.get(),c=f.first.beginCandidate({actor,origin,replace:true});f.first.pairCandidate({secret:c.secret,actor,origin});
 f.fail(true);assert.throws(()=>f.first.activateCandidate(c.id,[{...target,actions:['read']}]));f.fail(false);
 assert.deepEqual(f.get(),before);assert.ok(f.first.authenticate({token:old.cookieValue,actor}));
});
test('a known mirror refusal rolls Keychain back and keeps the old phone',t=>{
 const f=fixture(t),old=f.pair(),before=f.get(),c=f.first.beginCandidate({actor,origin,replace:true});f.first.pairCandidate({secret:c.secret,actor,origin});
 const io=Object.create(fs);io.renameSync=()=>{throw Error('Synthetic pre-rename refusal');};f.first.io=io;
 assert.throws(()=>f.first.activateCandidate(c.id,[{...target,actions:['read']}]));f.first.io=fs;
 assert.deepEqual(f.get(),before);assert.ok(f.first.authenticate({token:old.cookieValue,actor}));
});
test('a mirror error after rename is resolved as the new phone, never a second activation',t=>{
 const f=fixture(t),old=f.pair(),c=f.first.beginCandidate({actor,origin,replace:true}),fresh=f.first.pairCandidate({secret:c.secret,actor,origin});
 const io=Object.create(fs);io.renameSync=(...args)=>{fs.renameSync(...args);throw Error('Synthetic lost rename acknowledgement');};f.first.io=io;
 f.first.activateCandidate(c.id,[{...target,actions:['read']}]);f.first.io=fs;assert.throws(()=>f.first.authenticate({token:old.cookieValue,actor}));assert.ok(f.first.authenticate({token:fresh.cookieValue,actor}));
 const next=f.access(900002);next.resume(f.store.checkpoint(),{alive:()=>false});assert.ok(next.authenticate({token:fresh.cookieValue,actor}));
});
test('an unconfirmable rollback fails closed rather than reviving either guessed grant',t=>{
 const f=fixture(t);f.pair();const c=f.first.beginCandidate({actor,origin,replace:true});f.first.pairCandidate({secret:c.secret,actor,origin});
 const put=f.adapter.put;let writes=0;f.adapter.put=(...args)=>{if(++writes===2)throw Error('Synthetic rollback refusal');return put(...args);};
 const io=Object.create(fs);io.renameSync=()=>{throw Error('Synthetic mirror refusal');};f.first.io=io;
 assert.throws(()=>f.first.activateCandidate(c.id,[{...target,actions:['read']}]));f.first.io=fs;
 assert.equal(f.first.closed,true);assert.equal(fs.existsSync(path.join(f.root,OFF)),true);assert.throws(()=>f.store.checkpoint());
});
test('failed Keychain revocation is reported unconfirmed despite the local OFF fallback, and a later explicit retry seals it',t=>{
 const f=fixture(t);f.pair();f.fail(true);assert.equal(f.first.revoke().confirmed,false);assert.throws(()=>f.store.checkpoint());f.fail(false);
 assert.equal(f.first.revoke().confirmed,true);assert.equal(f.get().authority.enabled,false);assert.throws(()=>f.store.checkpoint());
});
test('a lost Keychain write acknowledgement is resolved by exact readback without replaying the transaction',t=>{
 const f=fixture(t);f.after(true);const phone=f.pair();f.after(false);const next=f.access(900002);next.resume(f.store.checkpoint(),{alive:()=>false});assert.ok(next.authenticate({token:phone.cookieValue,actor}));
});
test('Keychain metadata contains no cookie or pairing secret and imports start no transport',t=>{
 const f=fixture(t),phone=f.pair(),bytes=JSON.stringify(f.get());assert.equal(bytes.includes(phone.cookieValue),false);assert.equal(bytes.includes(phone.csrf),false);
 assert.deepEqual(Object.keys(f.get()).sort(),['authority','details','mirror','profile','version']);
});
test('independent CLI processes retain one device and original expiry, and a durable revoke blocks the next process',async t=>{
 const {fork}=require('node:child_process'),root=fs.mkdtempSync(path.join(os.tmpdir(),'naw-pairing-process-'));fs.chmodSync(root,0o700);fs.mkdirSync(path.join(root,'profile'),{mode:0o700});t.after(()=>fs.rmSync(root,{recursive:true}));
 async function run(mode,token,oldTicket){return new Promise((resolve,reject)=>{
  const child=fork(path.join(__dirname,'fixtures/mobile-pairing-process.cjs'),[],{stdio:['ignore','pipe','pipe','ipc'],env:{...process.env}});let value;
  const timer=setTimeout(()=>{child.kill();reject(Error('Owned process deadline'));},5000);child.stdout.resume();child.stderr.resume();child.on('message',v=>{value=v;});
  child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve({code,value});});child.send({root,mode,token,oldTicket});
 });}
 const first=await run('pair');assert.equal(first.code,0);const next=await run('resume',first.value.token,first.value.ticket);assert.equal(next.code,0);assert.equal(next.value.oldTicketDenied,true);
 assert.notEqual(next.value.issuer.pid,first.value.issuer.pid);assert.equal(next.value.device,first.value.device);assert.equal(next.value.until,first.value.until);
 const revoked=await run('revoke',first.value.token);assert.equal(revoked.code,0);assert.equal((await run('resume',first.value.token)).code,1);
});
