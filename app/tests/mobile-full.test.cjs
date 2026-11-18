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
  const ticket = access.authorize({ token: device.cookieValue, csrf: device.csrf, actor, origin, action: 'send', target });
  assert.equal(verifyTicket(root, ticket, target, 'send'), true);
  assert.throws(() => verifyTicket(root, ticket, { ...target, nativeId: 'replaced' }, 'send'));
  assert.throws(() => verifyTicket(root, ticket, target, 'answer'));
  assert.throws(() => access.authorize({ token: device.cookieValue, csrf: device.csrf, actor, origin, action: 'send', target: { ...target, serviceKey: 'outside' } }));
  const before = access.load(); assert.equal(before.version, 2); assert.equal(before.sessionPolicy, 'all'); assert.deepEqual(before.scopes, []);
  assert.throws(() => access.save({ ...before, sessionPolicy: 'unknown' }));
  assert.throws(() => access.save({ ...before, scopes: [{ ...target, actions: ['read'] }] }));
  access.revoke(); assert.throws(() => verifyTicket(root, ticket, target, 'send'));
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
test('full broker discovers later sessions, retains exact native checks and forbids push despite records permission', async t => {
  const f=brokerFixture(t), c=await f.broker.beginPairing({actor,origin,all:true});
  const d=f.broker.pair({secret:c.secret,actor,origin}), auth={token:d.cookieValue,actor,origin};auth.csrf=f.broker.session(auth).csrf;
  f.entries[0].state.sessions.push(f.row('future'));
  const session=await f.broker.refreshSession(auth);assert.equal(session.sessions.length,2);
  const r=await f.broker.read(auth,'future');assert.equal(r.id,'future');
  const w=await f.broker.workspaceRead(auth);assert.equal(w.g.allRooms,true);assert.equal(w.g.records,true);assert.equal(w.scopes.length,2);assert.equal(w.capabilities.push,false);
  assert.throws(()=>f.broker.pushInfo(auth));assert.throws(()=>f.broker.pushAction(auth,{action:'subscribe',subscription:{}}));
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
