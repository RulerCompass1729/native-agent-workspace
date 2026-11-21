const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {EventEmitter}=require('node:events'),{createRequire}=require('node:module');
const {MobileAccess,verifyTicket,SESSION_MS}=require('../mobile-access.cjs'),{PairingStore}=require('../mobile-pairing-store.cjs');
const {signer}=require('./fixtures/mobile-passkey.cjs');
const actor='synthetic-person',origin='https://phone.example.test';
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'naw-persistent-broker-')),clients=[],brokers=[],messages=[];fs.chmodSync(root,0o700);t.after(()=>{for(const b of brokers)try{b.revoke();}catch{}fs.rmSync(root,{recursive:true});});
 let item=null,identity=0,fail=false,closeFails=false,calls=0,lastTicket=null,decisions=0;
 const store=new PairingStore(root,{adapter:{get:()=>structuredClone(item),put(_a,v){if(fail)throw Error('Synthetic locked Keychain');item=structuredClone(v);}}});
 const record={id:'synthetic',nativeId:'native',state:'idle',provider:'claude',name:'Synthetic',messages:[]};
 const entries=[{key:'.',state:{capabilities:['humanMobileV1','humanMobilePreparedV1'],sessions:[record]}}];
 class Access extends MobileAccess{constructor(r,o){super(r,{...o,identity:{pid:process.pid,started:'synthetic-lifetime-'+(++identity)}});}}
 class Client extends EventEmitter{
  constructor(){super();this.scope=root;this.entries=entries;this.socket={destroyed:false};this.closing=false;clients.push(this);}
  route(id){if(id!==record.id)throw Error('Unknown target');return entries[0];}async refresh(){}
  close(){if(closeFails)throw Error('Synthetic transport close fault');this.closing=true;this.socket.destroyed=true;this.emit('closed');}
  async call(method,ticket){calls++;lastTicket=structuredClone(ticket);verifyTicket(root,ticket,{serviceKey:'.',sessionId:record.id,nativeId:record.nativeId},'read',{alive:()=>true});assert.equal(method,'mobileRead');
   return {...record,proof:{nativeId:record.nativeId,controlRevision:0,connectionRevision:0},canSend:false};}
 }
 const file=require.resolve('../mobile-broker.cjs'),req=createRequire(file),module={exports:{}};
 vm.runInNewContext(fs.readFileSync(file,'utf8'),{module,process,Buffer,URL,structuredClone,require(n){if(n==='./mobile-access.cjs')return {MobileAccess:Access,SESSION_MS};if(n==='./workspace-client.cjs')return {WorkspaceClient:Client};if(n==='./service-client.cjs')return {connect:async()=>new Client()};return req(n);}});
 const binding={sessionId:record.id,nativeId:record.nativeId,operationId:'card',version:'exact',decision:1,expiresAt:Date.now()+120000};
 const desktop={grant:(_c,g)=>structuredClone(g),records:{status:()=>({count:0})},read:async()=>({capabilities:{},confirmations:[]}),confirmationBinding:()=>binding,
  decision:async(_c,_s,_v,permit,valid)=>{decisions++;permit.check(valid(),binding);return {state:'complete'};}};
 const endpoint={origin,actor,port:48765,binding:{version:1,origin,actor,port:48765,userId:'7',topologyHash:'0'.repeat(64)}};
 const create=(current=endpoint)=>{const broker=new module.exports.MobileBroker(root,{exclusive:()=>true,desktop,persistence:store,pushOptions:{transport:async d=>{messages.push(d);return 201;}}});brokers.push(broker);if(current)broker.setEndpoint(current);return broker;};
 const first=create();
 const auth=d=>({token:d.cookieValue,actor,origin});
 async function selected(){const c=await first.beginPairing({actor,origin,selection:[{sessionId:record.id,actions:['read']}]});const a=auth(first.pair({secret:c.secret,actor,origin}));a.csrf=first.session(a).csrf;return a;}
 async function candidate(options={}){const c=await first.beginCandidate({actor,origin,...options}),a=auth(await first.pair({secret:c.secret,actor,origin}));a.csrf=first.session(a).csrf;return a;}
 function prove(a){const key=signer(origin),o=first.registrationOptions(a,{}),p=first.registerPasskey(a,{registrationId:o.registrationId,credential:key.credential(o.publicKey)});first.registrationProof(a,{registrationId:o.registrationId,assertion:key.assertion(p.publicKey)});return key;}
 return {root,persistence:store,first,create,selected,candidate,prove,binding,record,clients,messages,decisions:()=>decisions,fail:v=>{fail=v;},closeFail:v=>{closeFails=v;},calls:()=>calls,ticket:()=>lastTicket,stored:()=>structuredClone(item)};
}
test('a restored selected pairing reconnects once for simultaneous GETs and watches the replacement reader too',async t=>{
 const f=fixture(t),a=await f.selected();f.first.suspend();const next=f.create();await next.resume(async()=>true);a.csrf=next.session(a).csrf;
 let count=f.clients.length;f.clients.at(-1).close();
 await assert.rejects(next.read(a,f.record.id),{code:'MOBILE_SOURCE_UNAVAILABLE'});
 for(const bad of [{...a,actor:'another-person'},{...a,origin:'https://other.example.test'},{...a,token:'x'.repeat(43)}])await assert.rejects(next.refreshSession(bad));
 assert.equal(f.clients.length,count);const rows=await Promise.all([next.refreshSession(a),next.refreshSession(a)]);
 assert.equal(f.clients.length,count+1);assert.deepEqual(structuredClone(rows[0].sessions.map(s=>s.actions)),[['read']]);
 assert.equal((await next.read(a,f.record.id)).id,f.record.id);
 count=f.clients.length;f.clients.at(-1).close();await next.refreshSession(a);assert.equal(f.clients.length,count+1);
 f.clients.at(-1).close();count=f.clients.length;assert.equal(next.logout(a).authorizationRevoked,true);
 await assert.rejects(next.refreshSession(a));assert.equal(f.clients.length,count);
});
test('a restored subscribed pairing reports source loss once and clears it after the original phone reconnects',async t=>{
 const f=fixture(t),a=await f.candidate();await f.first.activateCandidate(a,{mode:'basic'});f.first.suspend();const next=f.create();await next.resume(async()=>true);a.csrf=next.session(a).csrf;
 const key=require('node:crypto').createECDH('prime256v1');key.generateKeys();
 const subscription={endpoint:'https://web.push.apple.com/synthetic',expirationTime:null,keys:{p256dh:key.getPublicKey().toString('base64url'),auth:Buffer.alloc(16,7).toString('base64url')}};
 const said=()=>JSON.parse(require('http_ece').decrypt(f.messages.at(-1).body,{version:'aes128gcm',privateKey:key,authSecret:subscription.keys.auth}));
 next.pushAction(a,{action:'subscribe',subscription});await next.refreshPush();const before=f.messages.length;assert.equal(before,1);
 f.clients.at(-1).close();await next.refreshPush();assert.equal(f.messages.length,before+1);assert.deepEqual(said().alerts,['service-disconnected']);
 await next.refreshPush();assert.equal(f.messages.length,before+1);
 await next.refreshSession(a);await next.refreshPush();assert.deepEqual(said().alerts,[]);assert.equal(next.pushInfo(a).enabled,true);
 const count=f.messages.length;next.logout(a);await next.refreshPush();assert.equal(f.messages.length,count);
});
test('checkpoint consent restores before a later source loss revokes it and its outstanding proof',async t=>{
 const f=fixture(t),a=await f.candidate(),key=f.prove(a);await f.first.activateCandidate(a,{mode:'verified'});f.first.suspend();const next=f.create();await next.resume(async()=>true);
 let status=next.session(a);assert.equal(status.consent.enabled,true);assert.equal(status.consent.registered,true);a.csrf=status.csrf;
 const value={id:'card',version:'exact',decision:'approve'},proof=await next.decisionOptions(a,value);f.clients.at(-1).close();
 await assert.rejects(next.decide(a,{...value,challengeId:proof.challengeId,assertion:key.assertion(proof.publicKey)}));
 status=await next.refreshSession(a);assert.equal(status.consent.enabled,false);assert.equal(status.consent.registered,false);
 await assert.rejects(next.decide(a,{...value,challengeId:proof.challengeId,assertion:key.assertion(proof.publicKey)}));assert.equal(f.decisions(),0);
 next.suspend();assert.equal(f.stored().details.consent,null);const later=f.create();await later.resume(async()=>true);
 assert.equal(later.session(a).consent.enabled,false);assert.equal(later.session(a).consent.registered,false);
});
test('suspend closes backend authorization before the issuer exits',async t=>{
 const f=fixture(t),a=await f.selected();await f.first.read(a,f.record.id);const ticket=f.ticket();
 f.first.suspend();assert.throws(()=>verifyTicket(f.root,ticket,{serviceKey:'.',sessionId:f.record.id,nativeId:f.record.nativeId},'read',{alive:()=>true}));
});
test('a suspended selected read-only pairing restores its exact scope, not the new default all scope',async t=>{
 const f=fixture(t),a=await f.selected();assert.equal(f.first.suspend().paused,true);const next=f.create();assert.ok(next.resumeInfo());await next.resume(async()=>true);
 const session=next.session(a);assert.deepEqual(structuredClone(session.sessions.map(s=>s.actions)),[['read']]);assert.equal(session.workspace,undefined);assert.equal(session.csrf!==a.csrf,true);
 assert.equal((await next.read(a,f.record.id)).id,f.record.id);assert.equal(f.calls(),1);assert.throws(()=>next.pushInfo(a));next.revoke();
});
test('a QR-verified key survives pause/recovery but each card still needs a new system-verification proof',async t=>{
 const f=fixture(t),a=await f.candidate(),key=f.prove(a);await f.first.activateCandidate(a,{mode:'verified'});
 const value={id:'card',version:'exact',decision:'approve'},old=await f.first.decisionOptions(a,value);f.first.suspend();
 const next=f.create();await next.resume(async()=>true);const status=next.session(a);assert.equal(status.consent.registered,true);assert.equal(status.consent.enabled,true);a.csrf=status.csrf;
 await assert.rejects(next.decide(a,{...value,challengeId:old.challengeId,assertion:key.assertion(old.publicKey)}));
 const wrong=await next.decisionOptions(a,value);await assert.rejects(next.decide(a,{...value,challengeId:wrong.challengeId,assertion:key.assertion(wrong.publicKey,{flags:1})}));
 const good=await next.decisionOptions(a,value);assert.equal((await next.decide(a,{...value,challengeId:good.challengeId,assertion:key.assertion(good.publicKey)})).status,'complete');
 // An all-scope pairing may subscribe, so the restored one may too; no subscription itself outlives the process.
 const push=next.pushInfo(a);assert.equal(push.enabled,false);assert.equal(push.state,'off');next.revoke();
});
test('explicit revoke before reconnecting the saved pairing is durable',async t=>{
 const f=fixture(t);await f.selected();f.first.suspend();const next=f.create();assert.equal(next.revoke().authorizationRevoked,true);
 assert.equal(f.create().resumeInfo(),null);assert.equal(f.stored().authority.enabled,false);
});
test('logout revokes the anchor before a failing transport close and never resumes it later',async t=>{
 const f=fixture(t),a=await f.selected();f.closeFail(true);assert.throws(()=>f.first.logout(a));f.closeFail(false);
 assert.equal(f.stored().authority.enabled,false);assert.equal(f.create().resumeInfo(),null);
});
test('failed candidate persistence preserves both the old cookie and old approval policy',async t=>{
 const f=fixture(t),old=await f.selected(),a=await f.candidate({replace:true});f.prove(a);f.fail(true);
 await assert.rejects(f.first.activateCandidate(a,{mode:'verified'}));f.fail(false);
 assert.ok(f.first.session(old));assert.equal(f.first.approvalStatus().enabled,false);assert.equal(f.first.session(a).candidate,true);await assert.rejects(f.first.read(a,f.record.id));
 f.first.suspend();const next=f.create();await next.resume(async()=>true);assert.ok(next.session(old));assert.equal(next.approvalStatus().enabled,false);next.revoke();
});
test('a changed carrier cannot rebind or alter the saved generation',async t=>{
 const f=fixture(t);await f.selected();f.first.suspend();const before=f.stored(),next=f.create();await assert.rejects(next.resume(async()=>false));assert.deepEqual(f.stored(),before);
});
test('all policy recovery removes an ended native target instead of reviving its saved tuple',async t=>{
 const f=fixture(t),a=await f.candidate();await f.first.activateCandidate(a,{mode:'basic'});f.first.suspend();f.record.state='ended';
 const next=f.create();await next.resume(async()=>true);assert.equal(next.session(a).sessions.length,0);await assert.rejects(next.read(a,f.record.id));assert.equal(f.calls(),0);next.revoke();
});

test('a saved receipt alone cannot substitute for a freshly verified current endpoint',async t=>{
 const f=fixture(t);await f.selected();f.first.suspend();const before=f.stored(),next=f.create(null);
 await assert.rejects(next.resume(async()=>true));assert.deepEqual(f.stored(),before);assert.equal(f.calls(),0);
});
test('revocation during the final candidate durability wait cannot report activation',async t=>{
 const f=fixture(t),a=await f.candidate();let release;f.first.settlePersistence=()=>new Promise(r=>{release=r;});
 const pending=f.first.activateCandidate(a,{mode:'basic'});await new Promise(setImmediate);assert.equal(typeof release,'function');f.first.revoke();release();
 await assert.rejects(pending);assert.throws(()=>f.first.session(a));
});
test('revocation during the final recovery durability wait cannot report restoration',async t=>{
 const f=fixture(t),a=await f.selected();f.first.suspend();const next=f.create();let release;next.settlePersistence=()=>new Promise(r=>{release=r;});
 const pending=next.resume(async()=>true);await new Promise(setImmediate);assert.equal(typeof release,'function');next.revoke();release();
 await assert.rejects(pending);assert.throws(()=>next.session(a));assert.equal(f.stored().authority.enabled,false);
});

test('a late failed recovery never revokes a newer completed replacement',async t=>{
 const f=fixture(t);await f.selected();f.first.suspend();const next=f.create();let release,waits=0;
 next.settlePersistence=()=>++waits===1?new Promise(r=>{release=r;}):Promise.resolve();
 const recovering=next.resume(async()=>true);await new Promise(setImmediate);assert.equal(typeof release,'function');
 const c=await next.beginCandidate({actor,origin,replace:true}),phone=await next.pair({secret:c.secret,actor,origin}),auth={actor,origin,token:phone.cookieValue};auth.csrf=next.session(auth).csrf;
 await next.activateCandidate(auth,{mode:'basic'});f.persistence.status=()=>'temporary';release();await assert.rejects(recovering);
 assert.equal(next.session(auth).deviceId,phone.deviceId);assert.equal(f.stored().authority.enabled,true);
});
test('desktop enrollment stays pending until persistence has a known disposition',async t=>{
 const f=fixture(t),c=await f.first.beginCandidate({actor,origin}),phone=await f.first.pair({secret:c.secret,actor,origin}),a={actor,origin,token:phone.cookieValue};a.csrf=f.first.session(a).csrf;
 let release;f.first.settlePersistence=()=>new Promise(r=>{release=r;});const pending=f.first.activateCandidate(a,{mode:'basic'});await new Promise(setImmediate);
 const info=f.first.candidateInfo(c.id);assert.equal(info.state,'redeemed');assert.equal(info.redeemed,true);assert.ok(info.expiresAt>Date.now());
 release();await pending;assert.equal(f.first.candidateInfo(c.id).state,'complete');
});
