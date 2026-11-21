const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module'), { EventEmitter } = require('node:events');
const { MobileAccess, verifyTicket } = require('../mobile-access.cjs');
const actor = 'synthetic-person', origin = 'https://phone.example.test';
function authority(t, initialized = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-full-mobile-')); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true }));
  const access = new MobileAccess(root, { exclusive: () => true }); if (initialized) access.initialize();
  return { root, access };
}
test('all-session authority includes future concrete identities without turning the ticket into a wildcard', t => {
  const { root, access } = authority(t);
  const challenge = access.beginPairing({ actor, origin, scopes: [], all: true });
  const device = access.pair({ secret: challenge.secret, actor, origin });
  const target = { serviceKey: '.', sessionId: 'future-session', nativeId: 'future-native' };
  const before = access.load(); assert.equal(before.version, 2); assert.equal(before.sessionPolicy, 'all'); assert.deepEqual(before.scopes, []);
  assert.throws(() => access.authorize({ token: device.cookieValue, csrf: device.csrf, actor, origin, action: 'send', target }));
  access.syncAllScopes([{...target,actions:['read','send','answer']}]);
  const ticket = access.authorize({ token: device.cookieValue, csrf: device.csrf, actor, origin, action: 'send', target });
  assert.equal(verifyTicket(root, ticket, target, 'send'), true);
  assert.throws(() => verifyTicket(root, ticket, { ...target, nativeId: 'replaced' }, 'send'));
  assert.throws(() => verifyTicket(root, ticket, target, 'answer'));
  assert.throws(() => access.authorize({ token: device.cookieValue, csrf: device.csrf, actor, origin, action: 'send', target: { ...target, serviceKey: 'outside' } }));
  assert.throws(() => access.save({ ...before, sessionPolicy: 'unknown' }));
  assert.throws(() => access.save({ ...before, scopes: [{ ...target, actions: ['read'] }] }));
  access.revoke(); assert.throws(() => verifyTicket(root, ticket, target, 'send'));
});
test('an empty all-scope bootstrap cannot grant an unobserved native target',t=>{
 const {root,access}=authority(t),challenge=access.beginPairing({actor,origin,scopes:[],all:true}),device=access.pair({secret:challenge.secret,actor,origin});
 const target={serviceKey:'.',sessionId:'unobserved',nativeId:'unobserved-native'};
 assert.throws(()=>access.authorize({token:device.cookieValue,csrf:device.csrf,actor,origin,action:'read',target}));
});
test('legacy selected read pairing never inherits the new all-session policy', t => {
  const { root, access } = authority(t), target = { serviceKey: '.', sessionId: 'selected', nativeId: 'native' };
  const c = access.beginPairing({ actor, origin, scopes: [{ ...target, actions: ['read'] }] });
  const d = access.pair({ secret: c.secret, actor, origin });
  assert.equal(access.load().version, 1);
  assert.throws(() => access.syncAllScopes([{ ...target, sessionId: 'future', actions: ['read','send','answer'] }]));
  assert.throws(() => access.authorize({ token: d.cookieValue, csrf: d.csrf, actor, origin, action: 'read', target: { ...target, sessionId: 'future' } }));
  assert.throws(() => access.authorize({ token: d.cookieValue, csrf: d.csrf, actor, origin, action: 'send', target }));
  assert.ok(fs.existsSync(path.join(root, 'mobile-authority.json')));
});
function brokerFixture(t, { legacy = false } = {}) {
  const { root } = authority(t, false), entries = [{ key: '.', state: { capabilities: ['humanMobileV1','humanMobilePreparedV1','humanMobileAllV1'], sessions: [] } }];
  const row = id => ({ id, nativeId: 'native-'+id, provider: 'codex', name: 'Synthetic member', state: 'idle', proof: { nativeId: 'native-'+id, controlRevision: 0, connectionRevision: 0 } });
  entries[0].state.sessions.push(row('first')); const clients = [], calls = [];
  let holdOne = false, release, entered;
  const connectionEntered = new Promise(resolve => { entered=resolve; });
  let holdRead=false, releaseRead, readEntered;
  const reading=new Promise(resolve=>{readEntered=resolve;});
  class Client extends EventEmitter {
    constructor() { super(); this.scope=root; this.entries=[...entries]; this.socket={destroyed:false}; this.closing=false; }
    route(id) { const e=this.entries.find(e=>e.state.sessions.some(s=>s.id===id)); if(!e)throw Error('Unavailable synthetic member');return e; }
    async refresh() { return this.snapshot(); }
    snapshot() { return { sessions: this.entries.flatMap(e=>e.state.sessions) }; }
    close() { this.closing=true;this.socket.destroyed=true;this.emit('closed'); }
    async call(method,ticket) { calls.push(method);const r=this.route(ticket.sessionId).state.sessions.find(s=>s.id===ticket.sessionId);const check=legacy?require('./helpers/butler-legacy.cjs').load('mobile-access.cjs').verifyTicket:verifyTicket;check(root,ticket,{serviceKey:this.route(r.id).key,sessionId:r.id,nativeId:r.nativeId},'read');if(holdRead){holdRead=false;readEntered();await new Promise(resolve=>{releaseRead=resolve;});}return {...r,messages:[],question:null,canSend:true,earlierMessagesOmitted:0}; }
  }
  const filename=require.resolve('../mobile-broker.cjs'), module={exports:{}}, req=createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,process,Buffer,structuredClone,require(name){if(name==='./workspace-client.cjs')return {WorkspaceClient:Client};if(name==='./service-client.cjs')return {connect:async()=>{const c=new Client();clients.push(c);if(holdOne){holdOne=false;entered();await new Promise(resolve=>{release=resolve;});}return c}};return req(name);}});
  const desktop={ grant:(_client,value)=>value, records:{ status:()=>({count:0}) }, read:async(_c,g,scopes)=>({g,scopes,capabilities:{},confirmations:[]}) };
  const broker=new module.exports.MobileBroker(root,{exclusive:()=>true,desktop});
  t.after(()=>broker.revoke());
  return {root,broker,entries,clients,calls,row,holdConnection(){holdOne=true;},connectionEntered,releaseConnection(){release();},holdRead(){holdRead=true;},reading,releaseRead(){releaseRead();}};
}
test('full broker discovers later sessions, retains exact native checks and offers push with its records permission', async t => {
  const f=brokerFixture(t), c=await f.broker.beginPairing({actor,origin,all:true});
  const d=f.broker.pair({secret:c.secret,actor,origin}), auth={token:d.cookieValue,actor,origin};auth.csrf=f.broker.session(auth).csrf;
  f.entries[0].state.sessions.push(f.row('future'));
  const session=await f.broker.refreshSession(auth);assert.equal(session.sessions.length,2);
  const r=await f.broker.read(auth,'future');assert.equal(r.id,'future');
  const w=await f.broker.workspaceRead(auth);assert.equal(w.g.allRooms,true);assert.equal(w.g.records,true);assert.equal(w.scopes.length,2);assert.equal(w.capabilities.push,true);
  assert.equal(f.broker.pushInfo(auth).publicKey.length,87);assert.throws(()=>f.broker.pushAction(auth,{action:'subscribe',subscription:{}}));
  f.entries[0].state.sessions[1].archived=true;await assert.rejects(f.broker.read(auth,'future'));
  assert.equal(f.broker.approvalStatus().enabled,false);
});
test('full broker follows a new trusted backend but invalidates old reading contexts; incompatible backend stays unavailable', async t => {
  const f=brokerFixture(t), c=await f.broker.beginPairing({actor,origin,all:true}), d=f.broker.pair({secret:c.secret,actor,origin});
  const auth={token:d.cookieValue,actor,origin};auth.csrf=f.broker.session(auth).csrf;
  await f.broker.read(auth,'first');
  const key='backends/'+'a'.repeat(20);fs.mkdirSync(path.join(f.root,'backends'),{mode:0o700});fs.mkdirSync(path.join(f.root,key),{mode:0o700});
  fs.writeFileSync(path.join(f.root,'services.json'),JSON.stringify({format:1,active:'.',entries:['.',key]}),{mode:0o600});
  f.entries.push({key,state:{capabilities:['humanMobileV1','humanMobilePreparedV1','humanMobileAllV1'],sessions:[f.row('new-backend')]}});
  const next=await f.broker.refreshSession(auth);assert.equal(next.sessions.length,2);assert.equal(f.clients[0].socket.destroyed,true);
  assert.equal((await f.broker.read(auth,'new-backend')).id,'new-backend');
  f.entries[1].state.capabilities=[];
  await assert.rejects(f.broker.read(auth,'new-backend'));
});
test('all-room grant includes future rooms without granting arbitrary workspace actions', async () => {
  const {MobileWorkspace}=require('../mobile-workspace.cjs');let rooms=[{id:'first',queue:[],messages:[]}];
  const client={refresh:async()=>{},route:()=>({key:'.'})};
  const added=[];
  const workspace=new MobileWorkspace({snapshot:()=>({rooms,sessions:[]}),roomState:{metadata:id=>assert.ok(rooms.some(r=>r.id===id)),queueAdd:(text,assignee,id,actor)=>{added.push({text,assignee,id,actor});return 'new-item';}},records:{status:()=>({count:0,records:[]}),acknowledge(){}}});
  const grant=workspace.grant(client,{allRooms:true,records:true});rooms.push({id:'future',queue:[],messages:[]});
  assert.equal((await workspace.read(client,grant,[])).rooms.length,2);
  const result=await workspace.action(client,grant,{requestId:'synthetic-request',action:'queueAdd',roomId:'future',text:'Synthetic task',assignee:null},()=>{});
  assert.equal(result.status,'complete');assert.equal(added[0].id,'future');assert.equal(added[0].actor.kind,'person');
  await assert.rejects(workspace.action(client,grant,{action:'createSession'},()=>{}));
  assert.throws(()=>workspace.grant(client,{allRooms:'yes',records:true}));
});
test('all scope works with a still-running backend advertising the existing prepared mobile protocol', async t => {
  const f=brokerFixture(t);f.entries[0].state.capabilities=['humanMobileV1','humanMobilePreparedV1'];
  const c=await f.broker.beginPairing({actor,origin,all:true}),d=f.broker.pair({secret:c.secret,actor,origin}),auth={token:d.cookieValue,actor,origin};auth.csrf=f.broker.session(auth).csrf;
  assert.equal((await f.broker.read(auth,'first')).id,'first');
});
test('the exact published v1 backend reader accepts concrete grants for both existing and future all-scope sessions', async t => {
  const f=brokerFixture(t,{legacy:true});const c=await f.broker.beginPairing({actor,origin,all:true}),d=f.broker.pair({secret:c.secret,actor,origin}),auth={token:d.cookieValue,actor,origin};auth.csrf=f.broker.session(auth).csrf;
  assert.equal((await f.broker.read(auth,'first')).id,'first');f.entries[0].state.sessions.push(f.row('future'));
  assert.equal((await f.broker.read(auth,'future')).id,'future');assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'mobile-authority.json'),'utf8')).version,1);
});
test('a replaced pairing does not wait on or get clobbered by the previous generation backend discovery', async t => {
  const f=brokerFixture(t), c=await f.broker.beginPairing({actor,origin,all:true}),d=f.broker.pair({secret:c.secret,actor,origin}),auth={token:d.cookieValue,actor,origin};auth.csrf=f.broker.session(auth).csrf;
  const key='backends/'+'b'.repeat(20);fs.mkdirSync(path.join(f.root,'backends'),{mode:0o700});fs.mkdirSync(path.join(f.root,key),{mode:0o700});fs.writeFileSync(path.join(f.root,'services.json'),JSON.stringify({format:1,active:'.',entries:['.',key]}),{mode:0o600});f.entries.push({key,state:{capabilities:['humanMobileV1','humanMobilePreparedV1'],sessions:[f.row('next')]}});
  f.holdConnection();const oldRead=f.broker.refreshSession(auth);oldRead.catch(()=>{});await f.connectionEntered;
  let newRead;
  try {
    const next=await f.broker.beginPairing({actor,origin,all:true,replace:true}),phone=f.broker.pair({secret:next.secret,actor,origin}),fresh={token:phone.cookieValue,actor,origin};fresh.csrf=f.broker.session(fresh).csrf;
    newRead=f.broker.refreshSession(fresh);newRead.catch(()=>{});
    const available=await Promise.race([newRead.then(()=>true,()=>false),new Promise(resolve=>setImmediate(()=>resolve(false)))]);
    assert.equal(available,true,'new pairing discovery must be independent of the superseded connection');
    f.releaseConnection();await assert.rejects(oldRead);assert.equal(f.broker.session(fresh).sessions.length,2);
  } finally { f.releaseConnection();await Promise.allSettled([oldRead,newRead]); }
});
test('all-scope read cannot disclose its late result after the trusted backend membership changes', async t => {
  const f=brokerFixture(t),c=await f.broker.beginPairing({actor,origin,all:true}),d=f.broker.pair({secret:c.secret,actor,origin}),auth={token:d.cookieValue,actor,origin};auth.csrf=f.broker.session(auth).csrf;
  f.holdRead();const pending=f.broker.read(auth,'first');pending.catch(()=>{});await f.reading;
  const key='backends/'+'c'.repeat(20);fs.mkdirSync(path.join(f.root,'backends'),{mode:0o700});fs.mkdirSync(path.join(f.root,key),{mode:0o700});fs.writeFileSync(path.join(f.root,'services.json'),JSON.stringify({format:1,active:'.',entries:['.',key]}),{mode:0o600});
  f.releaseRead();await assert.rejects(pending);assert.equal(f.calls.length,1);
});
test('all-scope workspace stays readable with many long histories and labels omissions without losing session metadata', async () => {
  const {MobileWorkspace}=require('../mobile-workspace.cjs'), bodies=['Synthetic long reply. '.repeat(4000),'合成🙂"\\\n'.repeat(20000)];
  const sessions=Array.from({length:70},(_,i)=>({id:'session-'+i,nativeId:'native-'+i,name:'Synthetic member',provider:'codex',state:'idle',messages:[0,1].map(n=>({id:'message-'+i+'-'+n,nativeId:'native-'+i,role:'assistant',text:bodies[i%2],time:1}))}));
  const client={refresh:async()=>{},route:()=>({key:'.'})}, workspace=new MobileWorkspace({snapshot:()=>({sessions,rooms:[{id:'shared',messages:[],queue:[]}]}),roomState:{},records:{status:()=>({count:0,records:[]}),acknowledge(){}}});
  const result=await workspace.read(client,workspace.grant(client,{allRooms:true,records:true}),sessions.map(s=>({serviceKey:'.',sessionId:s.id,nativeId:s.nativeId,actions:['read','send','answer']})));
  assert.equal(result.sessions.length,70);assert.ok(Buffer.byteLength(JSON.stringify(result))<=8*1024*1024);
  assert.ok(result.sessions.every(s=>s.messages.some(m=>m.text.length>0)),'each session retains readable recent content');
  assert.ok(result.sessions.every(s=>s.earlierMessagesOmitted>0||s.messages.some(m=>m.textOmitted)),'bounded content is explicitly labelled');
  assert.ok(result.sessions.every(s=>s.messages.every(m=>!m.text.includes('\ufffd'))),'UTF-8 boundaries do not invent replacement characters');
  assert.ok(sessions.every((s,i)=>s.messages[0].text===bodies[i%2]),'native source content is unchanged');
});
test('all targets ending or losing native identity disappear from list, scopes and backend authority, including the last tuple',async t=>{
 const f=brokerFixture(t),c=await f.broker.beginPairing({actor,origin,all:true}),d=f.broker.pair({secret:c.secret,actor,origin}),auth={token:d.cookieValue,actor,origin};auth.csrf=f.broker.session(auth).csrf;
 const native=require('../mobile-session.cjs'),record=f.entries[0].state.sessions[0];record.messages=[{id:'history',role:'assistant',text:'Synthetic ended history',nativeId:record.nativeId}];
 let ticket;const client=f.clients[0],call=client.call.bind(client);client.call=async(method,value)=>{ticket=structuredClone(value);return call(method,value);};
 await f.broker.read(auth,'first');
 const workspace={dataDir:f.root,closed:false,get:()=>record,runtimes:new Map([[record.id,{stopped:true,backendExitConfirmed:true}]]),approvalRoutes:new Map(),host:{}};
 for(const mutate of [r=>{r.state='ended'},r=>{r.archived=true},r=>{r.nativeContextPending=true},r=>{r.nativeId=''},r=>{r.backendUnavailable=true}]){
  Object.assign(record,f.row('first'),{archived:false,nativeContextPending:false,backendUnavailable:false});mutate(record);
  assert.equal((await f.broker.refreshSession(auth)).sessions.length,0);assert.equal((await f.broker.workspaceRead(auth)).scopes.length,0);
  await assert.rejects(f.broker.read(auth,'first'));assert.throws(()=>native.read(workspace,ticket));
  const state=JSON.parse(fs.readFileSync(path.join(f.root,'mobile-authority.json'),'utf8'));assert.deepEqual(state.scopes,[]);
 }
 Object.assign(record,f.row('first'),{archived:false,nativeContextPending:false,backendUnavailable:false});
 assert.equal((await f.broker.read(auth,'first')).id,'first');
 f.entries[0].state.sessions.push(f.row('second'));await f.broker.refreshSession(auth);record.state='ended';
 assert.deepEqual(Array.from((await f.broker.refreshSession(auth)).sessions,s=>s.id),['second']);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,'mobile-authority.json'),'utf8')).scopes.map(s=>s.sessionId),['second']);
});
test('selected historical reads keep their existing semantics after a session ends',async t=>{
 const f=brokerFixture(t),c=await f.broker.beginPairing({actor,origin,selection:[{sessionId:'first',actions:['read']}]}),d=f.broker.pair({secret:c.secret,actor,origin}),auth={token:d.cookieValue,actor,origin};auth.csrf=f.broker.session(auth).csrf;
 const record=f.entries[0].state.sessions[0];record.state='ended';record.messages=[{id:'old',role:'assistant',text:'Synthetic selected history',nativeId:record.nativeId}];
 const native=require('../mobile-session.cjs'),target={serviceKey:'.',sessionId:record.id,nativeId:record.nativeId};
 let ticket;const client=f.clients[0],call=client.call.bind(client);client.call=async(method,value)=>{ticket=structuredClone(value);return call(method,value);};
 assert.equal((await f.broker.read(auth,'first')).id,'first');
 assert.equal(native.read({dataDir:f.root,closed:false,get:()=>record,runtimes:new Map([[record.id,{stopped:true,backendExitConfirmed:true}]]),approvalRoutes:new Map(),host:{}},ticket).messages[0].text,'Synthetic selected history');
 assert.equal(verifyTicket(f.root,ticket,target,'read'),true);
});
test('a full workspace rechecks current targets after its own refresh; selected history remains visible',async()=>{
 const {MobileWorkspace}=require('../mobile-workspace.cjs'),record={id:'first',nativeId:'native-first',state:'idle',messages:[{id:'history',role:'assistant',text:'Synthetic history'}]};
 const w=new MobileWorkspace({snapshot:()=>({sessions:[record],rooms:[]}),roomState:{},records:{status:()=>({count:0}),acknowledge(){}}});
 const client={refresh:async()=>{record.state='ended'},route:()=>({key:'.'})},scope={serviceKey:'.',sessionId:record.id,nativeId:record.nativeId,actions:['read']};
 assert.equal((await w.read(client,{allRooms:true,records:true},[scope])).sessions.length,0);
 assert.equal((await w.read(client,{roomIds:[],records:false},[scope])).sessions[0].messages[0].text,'Synthetic history');
});
