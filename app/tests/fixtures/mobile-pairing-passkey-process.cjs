// Real broker/crypto in an owned process; Keychain, carrier and native execution are fixtures.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module'),{EventEmitter}=require('node:events');
const {MobileAccess,SESSION_MS,verifyTicket}=require('../../mobile-access.cjs'),{PairingStore}=require('../../mobile-pairing-store.cjs'),carrier=require('../../mobile-carrier.cjs');
let broker,auth,deadline,executions=0,nativeCalls=0;
const actor='synthetic-person',origin='https://demo.example.ts.net:10000',row={id:'synthetic',nativeId:'native',state:'idle',provider:'claude',name:'Synthetic',messages:[]};
async function initialize(input){
 const root=path.join(input.root,'profile'),file=path.join(input.root,'fake-keychain.json');deadline=input.deadline;
 const store=new PairingStore(root,{adapter:{get:()=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null,put(_a,value){fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});}}});
 const entries=[{key:'.',state:{capabilities:['humanMobileV1','humanMobilePreparedV1'],sessions:[row]}}];
 class Client extends EventEmitter{
  constructor(){super();this.scope=root;this.entries=entries;this.socket={destroyed:false};this.closing=false;}
  route(id){if(id!==row.id)throw Error('Unknown target');return entries[0];}async refresh(){}
  close(){this.closing=true;this.socket.destroyed=true;this.emit('closed');}
  async call(method,ticket){nativeCalls++;verifyTicket(root,ticket,{serviceKey:'.',sessionId:row.id,nativeId:row.nativeId},'read');
   if(method!=='mobileRead')throw Error('Unexpected native execution');return {...row,proof:{nativeId:row.nativeId,controlRevision:0,connectionRevision:0},canSend:true,sendMode:'inline'};}
 }
 const binding=()=>({sessionId:row.id,nativeId:row.nativeId,operationId:'card',version:'exact',decision:1,expiresAt:deadline});
 const desktop={grant:(_client,value)=>structuredClone(value),records:{status:()=>({count:0})},read:async()=>({capabilities:{},confirmations:[]}),confirmationBinding:binding,
  decision:async(_client,_state,_value,permit,valid)=>{permit.check(valid(),binding());executions++;return {state:'complete'};}};
 const fileName=require.resolve('../../mobile-broker.cjs'),localRequire=createRequire(fileName),module={exports:{}};
 vm.runInNewContext(fs.readFileSync(fileName,'utf8'),{module,process,Buffer,URL,structuredClone,require(name){
  if(name==='./mobile-access.cjs')return {MobileAccess,SESSION_MS};if(name==='./workspace-client.cjs')return {WorkspaceClient:Client};
  if(name==='./service-client.cjs')return {connect:async()=>new Client()};return localRequire(name);
 }});
 broker=new module.exports.MobileBroker(root,{exclusive:()=>true,desktop,persistence:store});
 const status={BackendState:'Running',Self:{DNSName:'demo.example.ts.net.',UserID:7},User:{'7':{LoginName:actor}}},serve={TCP:{'10000':{HTTPS:true},'443':{HTTPS:true}},Web:{
  'demo.example.ts.net:10000':{Handlers:{'/':{Proxy:'http://127.0.0.1:48765'}}},'demo.example.ts.net:443':{Handlers:{'/':{Proxy:'http://127.0.0.1:8001'}}}}};
 if(input.mode==='pair'){
  const detected=carrier.inspect(status,serve,{sharedHostConfirmed:true});broker.setEndpoint({...detected,binding:carrier.binding(detected)});
  const c=await broker.beginCandidate({actor,origin}),phone=await broker.pair({secret:c.secret,actor,origin});auth={actor,origin,token:phone.cookieValue};
 }else{
  const endpoint=broker.resumeInfo();if(!endpoint)throw Error('No recovery grant');
  await broker.resume(async()=>{const detected=carrier.inspectRestored(status,serve,endpoint.binding);broker.setEndpoint({...detected,binding:carrier.binding(detected)});return true;});
  auth={actor,origin,token:input.token};
 }
 const session=broker.session(auth);auth.csrf=session.csrf;
 return {token:auth.token,session,pid:process.pid};
}
process.on('message',async input=>{
 try{
  let value;
  if(input.command==='init')value=await initialize(input);
  else if(input.command==='registration')value=broker.registrationOptions(auth,{});
  else if(input.command==='register')value=broker.registerPasskey(auth,input.value);
  else if(input.command==='proof')value=broker.registrationProof(auth,input.value);
  else if(input.command==='activate'){value=await broker.activateCandidate(auth,{mode:'verified'});auth.csrf=broker.session(auth).csrf;}
  else if(input.command==='session')value=broker.session(auth);
  else if(input.command==='read')value=await broker.read(auth,row.id);
  else if(input.command==='send')value=await broker.send(auth,input.value);
  else if(input.command==='options')value=await broker.decisionOptions(input.csrf?{...auth,csrf:input.csrf}:auth,{id:'card',version:'exact',decision:'approve'});
  else if(input.command==='decide')value=await broker.decide(auth,{id:'card',version:'exact',decision:'approve',...input.value});
  else if(input.command==='quit'){value=broker.suspend();process.send({id:input.id,ok:true,value,executions,nativeCalls},()=>process.disconnect());return;}
  else throw Error('Unknown fixture command');
  process.send({id:input.id,ok:true,value,executions,nativeCalls});
 }catch{process.send({id:input.id,ok:false,executions,nativeCalls});}
});
