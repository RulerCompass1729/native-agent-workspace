const fs=require('node:fs'),path=require('node:path');
const {MobileAccess,verifyTicket}=require('../../mobile-access.cjs');
process.once('message',input=>{
 try{
  const root=input.root,file=path.join(root,'fake-keychain.json'),profile=path.join(root,'profile');
  const adapter={get:()=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null,put(_a,v){fs.writeFileSync(file,JSON.stringify(v),{mode:0o600});}};
  const persistent=typeof MobileAccess.prototype.resume==='function';
  const store=persistent?new(require('../../mobile-pairing-store.cjs').PairingStore)(profile,{adapter}):null;
  const actor='synthetic-person',host='demo.example.ts.net',origin='https://'+host+':10000';
  const status={BackendState:'Running',Self:{DNSName:host+'.',UserID:7},User:{'7':{LoginName:actor}}},serve={TCP:{},Web:{},AllowFunnel:{}};
  for(const [port,target] of [[443,8001],[8443,8780],[10000,48765]]){serve.TCP[port]={HTTPS:true};serve.Web[host+':'+port]={Handlers:{'/':{Proxy:'http://127.0.0.1:'+target}}};}
  const carrier=persistent?require('../../mobile-carrier.cjs'):null;
  const binding=carrier?.binding?carrier.binding(carrier.inspect(status,serve,{sharedHostConfirmed:true})):null;
  const details={endpoint:{origin,actor,port:48765,binding},all:false,workspace:null,consent:null,consentView:false};
  const access=new MobileAccess(profile,{exclusive:()=>true,now:()=>Date.now()+(input.advance||0),...(store?{transaction:(state,save)=>store.commit(state,details,save),pauseTransaction:(state,mirror,save)=>store.pause(state,details,mirror,save),recover:c=>store.take(c)}:{})});
  let token=input.token,oldChallenge;
  if(input.mode==='pair'){
   access.initialize();const c=access.beginPairing({actor,origin,scopes:[{serviceKey:'.',sessionId:'synthetic',nativeId:'native',actions:['read']}]});
   token=access.pair({secret:c.secret,actor,origin}).cookieValue;
  }else if(store){
   const cp=store.checkpoint();
   if(input.change==='actor')status.User['7'].LoginName='another-person';
   if(input.change==='user-id'){status.Self.UserID=8;status.User['8']={LoginName:actor};}
   if(input.change==='origin'){serve.Web[host+':10001']=serve.Web[host+':10000'];delete serve.Web[host+':10000'];serve.TCP[10001]=serve.TCP[10000];delete serve.TCP[10000];}
   if(input.change==='mapping')serve.Web[host+':10000'].Handlers['/'].Proxy='http://127.0.0.1:48766';
   if(input.change==='new-service'){serve.TCP[10443]={HTTPS:true};serve.Web[host+':10443']={Handlers:{'/':{Proxy:'http://127.0.0.1:9000'}}};}
   if(input.change==='funnel')serve.AllowFunnel[host+':10000']=true;
   if(input.change==='unknown')serve.Services={unknown:{}};
   carrier.inspectRestored(status,serve,cp.details.endpoint.binding);access.resume(cp);
  }else access.initialize();
  const target={serviceKey:'.',sessionId:'synthetic',nativeId:'native'};
  if(input.mode==='replace'){
   const c=access.beginCandidate({actor,origin,replace:true});token=access.pairCandidate({secret:c.secret,actor,origin}).cookieValue;
   access.activateCandidate(c.id,[{...target,actions:['read']}]);
  }
  const state=access.authenticate({token,actor}),ticket=access.authorize({token,actor,action:'read',target});
  let oldTicketDenied=null;if(input.oldTicket){try{verifyTicket(profile,input.oldTicket,target,'read');oldTicketDenied=false;}catch{oldTicketDenied=true;}}
  let oldChallengeDenied=null;if(input.oldChallenge){try{access.pairCandidate({secret:input.oldChallenge,actor,origin});oldChallengeDenied=false;}catch{oldChallengeDenied=true;}}
  if(input.mode==='pair')oldChallenge=access.beginCandidate({actor,origin,replace:true}).secret;
  if(input.mode==='revoke')access.revoke();
  else if(store)access.pause();
  process.send({ok:true,token,ticket,oldTicketDenied,oldChallenge,oldChallengeDenied,device:state.device.id,until:state.device.until,issuer:state.issuer},()=>process.disconnect());
 }catch{process.send({ok:false},()=>process.disconnect());process.exitCode=1;}
});
