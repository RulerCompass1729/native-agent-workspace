const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {MobileAccess,verifyTicket}=require('../mobile-access.cjs');
const {MobileConsent}=require('../mobile-consent.cjs');
const {signer}=require('./fixtures/mobile-passkey.cjs');
const actor='synthetic-person',origin='https://phone.example.test',target={serviceKey:'.',sessionId:'current',nativeId:'native-current'},scopes=[{...target,actions:['read','send','answer']}];
function fixture(t,{initial=false}={}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'naw-candidate-'));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true}));let now=1700000000000,writeFailure=null;
 const io=new Proxy(fs,{get(o,k){if(k==='renameSync')return(...args)=>{if(writeFailure==='before')throw Error('Synthetic storage refusal');const value=o.renameSync(...args);if(writeFailure==='after')throw Error('Synthetic uncertain storage result');return value;};return o[k];}});
 const access=new MobileAccess(root,{exclusive:()=>true,now:()=>now,io});access.initialize();
 const auth=d=>({token:d.cookieValue,csrf:d.csrf,actor,origin});let old=null;
 if(!initial){const c=access.beginPairing({actor,origin,scopes});old=auth(access.pair({secret:c.secret,actor,origin}));}
 return {root,access,old,auth,advance:n=>{now+=n},failure:v=>{writeFailure=v},live:a=>{try{access.authenticate(a);return true}catch{return false}}};
}
test('preparing, cancelling and expiring a replacement leave the existing device and exact authority untouched',t=>{
 const f=fixture(t),before=fs.readFileSync(path.join(f.root,'mobile-authority.json'));
 for(const finish of ['cancel','expire']){const c=f.access.beginCandidate({actor,origin,replace:true});assert.ok(f.live(f.old));assert.ok(before.equals(fs.readFileSync(path.join(f.root,'mobile-authority.json'))));
  if(finish==='cancel')f.access.cancelCandidate(c.id);else f.advance(120001);
  assert.throws(()=>f.access.pairCandidate({secret:c.secret,actor,origin}));assert.ok(f.live(f.old));}
});
test('QR exchange is single-use and candidate cookie has only an origin/actor/CSRF-bound enrollment scope',t=>{
 const f=fixture(t),c=f.access.beginCandidate({actor,origin,replace:true}),d=f.access.pairCandidate({secret:c.secret,actor,origin}),a=f.auth(d);
 assert.throws(()=>f.access.pairCandidate({secret:c.secret,actor,origin}));assert.throws(()=>f.access.authorize({...a,action:'read',target}));
 assert.ok(f.access.candidateAuthenticate(a,true).generation);assert.ok(f.live(f.old));
 for(const changes of [{actor:'other'},{origin:'https://other.example.test'},{csrf:'x'.repeat(43)},{token:'x'.repeat(43)},{mode:'verified'}])assert.throws(()=>f.access.candidateAuthenticate({...a,...changes},true));
});
test('candidate activation atomically replaces one exact authority and never leaves both cookies valid',t=>{
 const f=fixture(t),c=f.access.beginCandidate({actor,origin,replace:true}),a=f.auth(f.access.pairCandidate({secret:c.secret,actor,origin}));
 const oldTicket=f.access.authorize({...f.old,action:'read',target});f.access.activateCandidate(c.id,scopes);
 assert.equal(f.live(f.old),false);assert.ok(f.live(a));assert.throws(()=>verifyTicket(f.root,oldTicket,target,'read',{now:()=>1700000000000}));
 const ticket=f.access.authorize({...a,action:'read',target});assert.ok(verifyTicket(f.root,ticket,target,'read',{now:()=>1700000000000}));assert.throws(()=>f.access.activateCandidate(c.id,scopes));
});
test('a phone enrolled by QR lasts seven days, is refused after that, and a Mac revoke ends it at once',t=>{
 const HOUR=3600000,DAY=24*HOUR,enroll=()=>{const f=fixture(t,{initial:true}),c=f.access.beginCandidate({actor,origin}),d=f.access.pairCandidate({secret:c.secret,actor,origin});f.access.activateCandidate(c.id,scopes);return {f,d,a:f.auth(d)};};
 const one=enroll();assert.equal(one.d.expiresAt,1700000000000+7*DAY);
 one.f.advance(12*HOUR+1);assert.ok(one.f.live(one.a),'Past the former twelve hours');one.f.advance(7*DAY-12*HOUR-2);assert.ok(one.f.live(one.a),'Last millisecond');
 one.f.advance(1);assert.equal(one.f.live(one.a),false);assert.throws(()=>one.f.access.authorize({...one.a,action:'read',target}));
 const two=enroll();two.f.advance(3*DAY);const ticket=two.f.access.authorize({...two.a,action:'read',target}),at=1700000000000+3*DAY;
 assert.ok(verifyTicket(two.f.root,ticket,target,'read',{now:()=>at}));assert.deepEqual(two.f.access.revoke(),{confirmed:true});
 assert.equal(two.f.live(two.a),false);assert.throws(()=>verifyTicket(two.f.root,ticket,target,'read',{now:()=>at}));
});
test('storage refusal before the atomic rename preserves the old device; an already committed rename is recognized',t=>{
 for(const phase of ['before','after']){const f=fixture(t),c=f.access.beginCandidate({actor,origin,replace:true}),a=f.auth(f.access.pairCandidate({secret:c.secret,actor,origin}));f.failure(phase);
  if(phase==='before'){assert.throws(()=>f.access.activateCandidate(c.id,scopes));assert.ok(f.live(f.old));assert.equal(f.live(a),false);}else{assert.doesNotThrow(()=>f.access.activateCandidate(c.id,scopes));assert.equal(f.live(f.old),false);assert.ok(f.live(a));}
 }
});
test('explicit revocation, a newer candidate and candidate expiry cannot be undone by a late enrollment',t=>{
 for(const action of ['revoke','replace','expire']){const f=fixture(t),c=f.access.beginCandidate({actor,origin,replace:true}),a=f.auth(f.access.pairCandidate({secret:c.secret,actor,origin}));
  if(action==='revoke')f.access.revoke();else if(action==='replace')f.access.beginCandidate({actor,origin,replace:true});else f.advance(120001);
  assert.throws(()=>f.access.candidateAuthenticate(a,true));assert.throws(()=>f.access.activateCandidate(c.id,scopes));assert.equal(f.live(f.old),action!=='revoke');
 }
});
test('a first candidate can activate without current sessions but receives no wildcard ticket',t=>{
 const f=fixture(t,{initial:true}),c=f.access.beginCandidate({actor,origin}),a=f.auth(f.access.pairCandidate({secret:c.secret,actor,origin}));
 f.access.activateCandidate(c.id,[]);assert.ok(f.live(a));assert.throws(()=>f.access.authorize({...a,action:'read',target}));
 f.access.syncAllScopes(scopes);assert.ok(f.access.authorize({...a,action:'read',target}));
});
test('redeeming a QR near its deadline gives enrollment its own bounded window, without extending QR reuse',t=>{
 const f=fixture(t),c=f.access.beginCandidate({actor,origin,replace:true});f.advance(119000);const a=f.auth(f.access.pairCandidate({secret:c.secret,actor,origin}));f.advance(2000);
 assert.ok(f.access.candidateAuthenticate(a,true));assert.throws(()=>f.access.pairCandidate({secret:c.secret,actor,origin}));f.advance(118001);assert.throws(()=>f.access.candidateAuthenticate(a,true));assert.ok(f.live(f.old));
});
test('QR enrollment authorizes one proved key without the manual fingerprint ceremony, while the manual path stays manual',()=>{
 const consent=new MobileConsent(),a={origin,generation:require('node:crypto').randomUUID(),device:{id:require('node:crypto').randomUUID()}},key=signer();
 assert.throws(()=>consent.qrOptions(a,{}));consent.beginQrRegistration(a);const start=consent.qrOptions(a,{});assert.equal(start.publicKey.authenticatorSelection.userVerification,'required');
 const proof=consent.register(a,{registrationId:start.registrationId,credential:key.credential(start.publicKey)});assert.equal(consent.status(a).enabled,false);
 consent.completeQrRegistration(a,{registrationId:start.registrationId,assertion:key.assertion(proof.publicKey)});assert.equal(consent.status(a).enabled,true);
 assert.throws(()=>consent.qrOptions(a,{}));assert.throws(()=>consent.completeQrRegistration(a,{registrationId:start.registrationId,assertion:key.assertion(proof.publicKey)}));
 const binding={sessionId:'s',nativeId:'n',operationId:'o',version:'v',decision:1,expiresAt:Date.now()+120000};const challenge=consent.challenge(a,binding);
 assert.ok(consent.consume(a,{challengeId:challenge.challengeId,assertion:key.assertion(challenge.publicKey)},binding));
});
for(const [name,change] of Object.entries({origin:{client:{origin:'https://other.example.test'}},rp:{rpId:'other.example.test'},UV:{flags:1},UP:{flags:4}}))test('QR key possession still rejects wrong '+name,()=>{
 const consent=new MobileConsent(),a={origin,generation:require('node:crypto').randomUUID(),device:{id:require('node:crypto').randomUUID()}},key=signer();consent.beginQrRegistration(a);const start=consent.qrOptions(a,{}),proof=consent.register(a,{registrationId:start.registrationId,credential:key.credential(start.publicKey)});
 assert.throws(()=>consent.completeQrRegistration(a,{registrationId:start.registrationId,assertion:key.assertion(proof.publicKey,change)}));assert.equal(consent.status(a).enabled,false);
});
function brokerFixture(t, {changed}={}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'naw-candidate-broker-'));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true}));const {EventEmitter}=require('node:events'),vm=require('node:vm'),{createRequire}=require('node:module');
 const record={id:target.sessionId,nativeId:target.nativeId,name:'Synthetic member',provider:'codex',state:'idle',messages:[],controlRevision:0,connectionRevision:0},entries=[{key:'.',state:{capabilities:['humanMobileV1','humanMobilePreparedV1'],sessions:[record]}}];
 let hold=false,release,entered,outcome='submitted',writes=0;const sending=new Promise(r=>{entered=r});const clients=[];
 class Client extends EventEmitter {
  constructor(){super();this.scope=root;this.entries=entries;this.socket={destroyed:false};this.closing=false;clients.push(this);}
  route(id){if(id!==record.id)throw Error('Unknown synthetic target');return entries[0];}
  async refresh(){} close(){this.closing=true;this.socket.destroyed=true;this.emit('closed');}
  async call(method,ticket,spec){verifyTicket(root,ticket,target,method==='mobileRead'?'read':'send');
   if(method==='mobileRead')return require('../mobile-session.cjs').read({dataDir:root,closed:false,get:()=>record,runtimes:new Map([[record.id,{}]]),approvalRoutes:new Map(),host:{}},ticket);
   if(method==='mobileSend')writes++;
   if(hold){entered();await new Promise(r=>{release=r});hold=false;}
   return {requestId:spec.requestId,sessionId:record.id,nativeId:record.nativeId,action:'send',status:outcome};
  }
 }
 const filename=require.resolve('../mobile-broker.cjs'),module={exports:{}},req=createRequire(filename);
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,process,Buffer,structuredClone,require(name){if(name==='./workspace-client.cjs')return {WorkspaceClient:Client};if(name==='./service-client.cjs')return {connect:async()=>new Client()};return req(name);}});
 const binding={sessionId:record.id,nativeId:record.nativeId,operationId:'card',version:'exact-card-version',decision:1,expiresAt:Date.now()+120000};
 const desktop={grant:(_c,g)=>g,records:{status:()=>({count:0})},read:async(_c,g,s)=>({grant:g,scopes:s,capabilities:{},confirmations:[]}),confirmationBinding:()=>binding,decision:async(_c,_s,_v,permit,valid)=>{permit.check(valid(),binding);return {state:'complete'};}};
 const broker=new module.exports.MobileBroker(root,{exclusive:()=>true,desktop,changed});t.after(()=>broker.revoke());
 const auth=d=>({token:d.cookieValue,actor,origin});
 async function paired(){const c=await broker.beginPairing({actor,origin,selection:[{sessionId:record.id,actions:['read','send','answer']}]}),a=auth(broker.pair({secret:c.secret,actor,origin}));a.csrf=broker.session(a).csrf;return a;}
 async function candidate(options={}){const c=await broker.beginCandidate({actor,origin,...options}),a=auth(await broker.pair({secret:c.secret,actor,origin}));a.csrf=broker.session(a).csrf;return {challenge:c,auth:a};}
 async function prove(a,key=signer()){const start=broker.registrationOptions(a,{}),p=broker.registerPasskey(a,{registrationId:start.registrationId,credential:key.credential(start.publicKey)});broker.registrationProof(a,{registrationId:start.registrationId,assertion:key.assertion(p.publicKey)});return key;}
 return {broker,record,clients,paired,candidate,prove,binding,hold(){hold=true;},sending,release(){release();},outcome:value=>{outcome=value},writes:()=>writes};
}
test('candidate cannot read, send, inspect workspace, push or decide before completion; ordinary cookie cannot enroll through QR routes',async t=>{
 const f=brokerFixture(t),old=await f.paired();assert.throws(()=>f.broker.registrationOptions(old,{}));
 const {auth:a}=await f.candidate({replace:true});assert.equal(f.broker.session(a).candidate,true);assert.equal(f.broker.session(a).sessions.length,0);
 await assert.rejects(f.broker.activateCandidate(old,{mode:'basic'}));
 await assert.rejects(f.broker.read(a,target.sessionId));await assert.rejects(f.broker.workspaceRead(a));assert.throws(()=>f.broker.pushInfo(a));
 await assert.rejects(f.broker.decisionOptions(a,{id:'card',version:'v',decision:'approve'}));
 await assert.rejects(f.broker.activateCandidate(a,{mode:'verified'}));assert.equal((await f.broker.read(old,target.sessionId)).id,target.sessionId);
});
test('proved QR enrollment swaps the old cookie and key only at activation; new sensitive actions require a fresh exact-card assertion',async t=>{
 const f=brokerFixture(t),old=await f.paired(),{auth:a}=await f.candidate({replace:true}),key=await f.prove(a);
 assert.equal(f.broker.session(old).deviceId!==f.broker.session(a).deviceId,true);assert.equal(f.broker.approvalStatus().registered,false);
 await f.broker.activateCandidate(a,{mode:'verified'});assert.throws(()=>f.broker.session(old));assert.equal(f.broker.session(a).consent.enabled,true);
 assert.throws(()=>f.broker.registrationOptions(a,{}));assert.equal(f.broker.pushInfo(a).publicKey.length,87);
 const value={id:'card',version:f.binding.version,decision:'approve'},challenge=await f.broker.decisionOptions(a,value);
 await assert.rejects(f.broker.decide(a,{...value,challengeId:challenge.challengeId,assertion:key.assertion(challenge.publicKey,{flags:1})}));
 const fresh=await f.broker.decisionOptions(a,value);const result=await f.broker.decide(a,{...value,challengeId:fresh.challengeId,assertion:key.assertion(fresh.publicKey)});assert.equal(result.status,'complete');
 await assert.rejects(f.broker.decide(a,{...value,challengeId:fresh.challengeId,assertion:key.assertion(fresh.publicKey)}));
});
test('explicit basic activation never enables sensitive approval; cancellation and malformed modes leave the old phone usable',async t=>{
 const f=brokerFixture(t),old=await f.paired(),first=await f.candidate({replace:true});await assert.rejects(f.broker.activateCandidate(first.auth,{mode:'basic',enabled:true}));
 f.broker.cancelCandidate(first.challenge.id);assert.equal((await f.broker.read(old,target.sessionId)).id,target.sessionId);assert.throws(()=>f.broker.session(first.auth));
 const next=await f.candidate({replace:true});await f.broker.activateCandidate(next.auth,{mode:'basic'});assert.equal(f.broker.session(next.auth).consent.enabled,false);assert.throws(()=>f.broker.session(old));
});
test('in-flight old work is not discarded by replacement and completed work is not resent',async t=>{
 const f=brokerFixture(t),old=await f.paired(),row=await f.broker.read(old,target.sessionId);f.hold();
 const send=f.broker.send(old,{contextId:row.contextId,requestId:require('node:crypto').randomUUID(),text:'Synthetic task'});await f.sending;
 const next=await f.candidate({replace:true});await f.prove(next.auth);await assert.rejects(f.broker.activateCandidate(next.auth,{mode:'verified'}));assert.ok(f.broker.session(old));
 f.release();assert.equal((await send).status,'submitted');await f.broker.activateCandidate(next.auth,{mode:'verified'});assert.throws(()=>f.broker.session(old));
});
test('a revocation or cancellation during the final native carrier check cannot activate a late candidate',async t=>{
 for(const action of ['revoke','cancel']){const f=brokerFixture(t),old=await f.paired();let enter,release,checks=0;const entered=new Promise(r=>{enter=r});const next=await f.candidate({replace:true,validate:async()=>{if(++checks===1)return true;enter();await new Promise(r=>{release=r});return true;}});
  await f.prove(next.auth);const pending=f.broker.activateCandidate(next.auth,{mode:'verified'});pending.catch(()=>{});await entered;
  if(action==='revoke')f.broker.revoke();else f.broker.cancelCandidate(next.challenge.id);release();await assert.rejects(pending);
  if(action==='cancel')assert.ok(f.broker.session(old));else assert.throws(()=>f.broker.session(old));assert.throws(()=>f.broker.session(next.auth));
 }
});
test('a changed carrier refuses both verified and basic completion, preserving the old pairing',async t=>{
 const f=brokerFixture(t),old=await f.paired();let valid=true;const next=await f.candidate({replace:true,validate:async()=>valid});await f.prove(next.auth);valid=false;
 for(const mode of ['verified','basic']){await assert.rejects(f.broker.activateCandidate(next.auth,{mode}));assert.ok(f.broker.session(old));assert.equal(f.broker.session(next.auth).candidate,true);}
});
test('post-commit cleanup failure closes both generations instead of leaving a new active phone unconfirmed',async t=>{
 const f=brokerFixture(t),old=await f.paired(),next=await f.candidate({replace:true});await f.prove(next.auth);
 const previous=f.clients[0],close=previous.close.bind(previous);previous.close=()=>{close();throw Error('Synthetic cleanup failure');};
 await assert.rejects(f.broker.activateCandidate(next.auth,{mode:'verified'}));assert.throws(()=>f.broker.session(old));assert.throws(()=>f.broker.session(next.auth));
});
test('revoked access can prepare a fresh first candidate without reopening the revoked generation',async t=>{
 const f=brokerFixture(t),old=await f.paired();f.broker.revoke();const next=await f.candidate();assert.ok(f.broker.openUntil()>Date.now());assert.throws(()=>f.broker.session(old));
 await f.prove(next.auth);await f.broker.activateCandidate(next.auth,{mode:'verified'});assert.equal(f.broker.session(next.auth).consent.enabled,true);
});
test('an existing enabled key remains enabled during new enrollment, then cannot authorize the successor generation',async t=>{
 const f=brokerFixture(t),old=await f.paired(),oldKey=signer(),start=f.broker.approvalBegin(),options=f.broker.registrationOptions(old,{code:start.code}),proof=f.broker.registerPasskey(old,{registrationId:options.registrationId,credential:oldKey.credential(options.publicKey)});
 f.broker.registrationProof(old,{registrationId:options.registrationId,assertion:oldKey.assertion(proof.publicKey)});const pending=f.broker.approvalStatus().pending;
 f.broker.approvalConfirm({registrationId:pending.registrationId,fingerprint:pending.fingerprint});const status=f.broker.approvalStatus();f.broker.approvalEnable({enabled:true,registrationId:status.registrationId});
 const next=await f.candidate({replace:true});await f.prove(next.auth);assert.equal(f.broker.approvalStatus().enabled,true);assert.ok(f.broker.session(old));
 await f.broker.activateCandidate(next.auth,{mode:'verified'});const value={id:'card',version:f.binding.version,decision:'approve'},challenge=await f.broker.decisionOptions(next.auth,value);
 await assert.rejects(f.broker.decide(next.auth,{...value,challengeId:challenge.challengeId,assertion:oldKey.assertion(challenge.publicKey)}));assert.throws(()=>f.broker.session(old));
});
test('an uncertain original receipt blocks replacement until queried; receipt recovery never resends the action',async t=>{
 const f=brokerFixture(t),old=await f.paired(),row=await f.broker.read(old,target.sessionId),requestId=require('node:crypto').randomUUID();f.outcome('unconfirmed');
 assert.equal((await f.broker.send(old,{contextId:row.contextId,requestId,text:'Synthetic uncertain action'})).status,'unconfirmed');
 const next=await f.candidate({replace:true});await f.prove(next.auth);await assert.rejects(f.broker.activateCandidate(next.auth,{mode:'verified'}));assert.ok(f.broker.session(old));
 f.outcome('submitted');assert.equal((await f.broker.receipt(old,requestId)).status,'submitted');await f.broker.activateCandidate(next.auth,{mode:'verified'});assert.equal(f.writes(),1);assert.throws(()=>f.broker.session(old));
});

// Exercise the production WorkspaceClient.close, with only its owned transport
// replaced by a throwing fixture. No socket, phone or native process is used.
function failCandidateTransportClose(client, beforeClose=()=>{}) {
 const close=client.close.bind(client);
 client.control={revision:0,manualEpoch:0,views:new Set([client]),clients:1};client.legacyObservers=new Map();
 client.entries=client.entries.map(entry=>({...entry,client:{close(){beforeClose();throw Error('Synthetic transport cleanup failure');}}}));
 client.close=require('../workspace-client.cjs').WorkspaceClient.prototype.close.bind(client);
 return ()=>{client.close=close;};
}
function enableOldKey(f,old) {
 const key=signer(),begin=f.broker.approvalBegin(),options=f.broker.registrationOptions(old,{code:begin.code});
 const proof=f.broker.registerPasskey(old,{registrationId:options.registrationId,credential:key.credential(options.publicKey)});
 f.broker.registrationProof(old,{registrationId:options.registrationId,assertion:key.assertion(proof.publicKey)});
 const pending=f.broker.approvalStatus().pending;f.broker.approvalConfirm({registrationId:pending.registrationId,fingerprint:pending.fingerprint});
 const status=f.broker.approvalStatus();f.broker.approvalEnable({enabled:true,registrationId:status.registrationId});return key;
}
for(const action of ['revoke','logout'])for(const phase of ['prepared','redeemed'])
test(`explicit ${action} invalidates old authority and key before a ${phase} candidate transport can fail`,async t=>{
 let changes=0;const f=brokerFixture(t,{changed:()=>{changes++;}}),old=await f.paired(),key=enableOldKey(f,old),previous=f.clients[0];
 let ticket;const call=previous.call.bind(previous);previous.call=async(method,value,...args)=>{if(method==='mobileRead')ticket=value;return call(method,value,...args);};
 await f.broker.read(old,target.sessionId);assert.ok(ticket);assert.ok(f.broker.session(old));assert.equal(f.broker.approvalStatus().enabled,true);
 const card={id:'card',version:f.binding.version,decision:'approve'},challenge=await f.broker.decisionOptions(old,card);
 const next=phase==='redeemed'?await f.candidate({replace:true}):{challenge:await f.broker.beginCandidate({actor,origin,replace:true})};
 if(next.auth)await f.prove(next.auth);
 const candidate=f.clients.at(-1),root=previous.scope,before=fs.readFileSync(path.join(root,'mobile-authority.json'));let revokedBeforeClose=false;
 const restore=failCandidateTransportClose(candidate,()=>{try{verifyTicket(root,ticket,target,'read');}catch{revokedBeforeClose=true;}}),changedBefore=changes;
 try{
  assert.throws(()=>action==='revoke'?f.broker.revoke():f.broker.logout(old),'Cleanup failure remains unconfirmed, never a false success');
  assert.equal(revokedBeforeClose,true,'Durable native ticket revocation precedes transport cleanup');
  assert.throws(()=>f.broker.session(old));assert.equal(f.broker.approvalStatus().enabled,false);assert.equal(f.broker.approvalStatus().registered,false);
  assert.equal(before.equals(fs.readFileSync(path.join(root,'mobile-authority.json')))&&!fs.existsSync(path.join(root,'mobile-disabled')),false);
  assert.throws(()=>verifyTicket(root,ticket,target,'read'));await assert.rejects(f.broker.read(old,target.sessionId));
  await assert.rejects(f.broker.decide(old,{...card,challengeId:challenge.challengeId,assertion:key.assertion(challenge.publicKey)}));
  if(next.auth){assert.throws(()=>f.broker.session(next.auth));await assert.rejects(f.broker.activateCandidate(next.auth,{mode:'verified'}));}
  else await assert.rejects(async()=>f.broker.pair({secret:next.challenge.secret,actor,origin}));
  assert.equal(f.broker.openUntil(),0);assert.equal(previous.closing,true,'Old client cleanup is attempted after candidate cleanup throws');
  if(action==='logout')assert.equal(changes,changedBefore+1,'Listener change notification survives cleanup failure');
 }finally{restore();}
});
test('cancelling only a candidate preserves the old key and authority even if its transport cleanup fails',async t=>{
 const f=brokerFixture(t),old=await f.paired();enableOldKey(f,old);const next=await f.candidate({replace:true}),candidate=f.clients.at(-1),restore=failCandidateTransportClose(candidate);
 try{assert.throws(()=>f.broker.cancelCandidate(next.challenge.id));assert.ok(f.broker.session(old));assert.equal(f.broker.approvalStatus().enabled,true);assert.throws(()=>f.broker.session(next.auth));}
 finally{restore();}
});

test('a scan during the refresh validation await preserves enrollment and rejects replacement',async t=>{
 const f=brokerFixture(t),first=await f.broker.beginCandidate({actor,origin,renew:true});let a;
 await assert.rejects(f.broker.beginCandidate({actor,origin,renew:true,refreshOf:first.id,validate:async()=>{a={...f.auth,actor,origin};const paired=await f.broker.pair({secret:first.secret,actor,origin});a={token:paired.cookieValue,actor,origin};return true;}}),e=>e.code==='MOBILE_SETUP_REDEEMED');
 assert.equal(f.broker.session(a).candidate,true);assert.equal(f.broker.candidateInfo(first.id).redeemed,true);
 const stopped=f.broker.cancelCandidate(first.id,{unredeemedOnly:true});assert.equal(stopped.cancelled,false);assert.equal(stopped.redeemed,true);assert.equal(f.broker.session(a).candidate,true);
});
test('a bounded renewal lease keeps only the expired candidate metadata alive, never its QR',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1700000000000});const f=brokerFixture(t),c=await f.broker.beginCandidate({actor,origin,renew:true});
 t.mock.timers.tick(120001);assert.equal(f.broker.candidateInfo(c.id).state,'expired');assert.equal(f.broker.openUntil(),1700000600000);
 await assert.rejects(async()=>f.broker.pair({secret:c.secret,actor,origin}));assert.equal(f.broker.candidateInfo(c.id).redeemed,false);
 t.mock.timers.tick(480000);assert.equal(f.broker.openUntil(),0);assert.equal(f.broker.candidateInfo(c.id).state,'unconfirmed');
});
test('a concurrent exchange during refresh preparation wins without losing its candidate',async t=>{
 const f=brokerFixture(t),c=await f.broker.beginCandidate({actor,origin,renew:true});
 const refresh=f.broker.beginCandidate({actor,origin,renew:true,refreshOf:c.id});
 const rejection=assert.rejects(refresh,e=>e.code==='MOBILE_SETUP_REDEEMED');
 const paired=await f.broker.pair({secret:c.secret,actor,origin});await rejection;
 assert.equal(f.broker.session({token:paired.cookieValue,actor,origin}).candidate,true);
});
test('completed setup status is bound to the activated generation and never survives revocation',async t=>{const f=brokerFixture(t),next=await f.candidate({renew:true});await f.broker.activateCandidate(next.auth,{mode:'basic'});const info=f.broker.candidateInfo(next.challenge.id);assert.equal(info.state,'complete');assert.equal(info.setupId,next.challenge.id);assert.deepEqual(Object.keys(info).sort(),['setupId','state']);f.broker.revoke();assert.equal(f.broker.candidateInfo(next.challenge.id).state,'unconfirmed');});
test('a transport cleanup failure cannot leave an undisplayed replacement candidate behind',async t=>{const f=brokerFixture(t),old=await f.paired(),first=await f.broker.beginCandidate({actor,origin,replace:true,renew:true}),client=f.clients.at(-1),close=client.close.bind(client);let created;const original=MobileAccess.prototype.beginCandidate;t.mock.method(MobileAccess.prototype,'beginCandidate',function(value){const r=original.call(this,value);created=r.id;return r;});client.close=()=>{throw Error('Synthetic candidate transport refusal')};try{await assert.rejects(f.broker.beginCandidate({actor,origin,replace:true,renew:true,refreshOf:first.id}));assert.ok(created);assert.equal(f.broker.candidateInfo(created).state,'unconfirmed');assert.ok(f.broker.session(old));}finally{client.close=close;close();}});
