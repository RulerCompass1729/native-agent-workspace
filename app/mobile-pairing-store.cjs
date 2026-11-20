'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto');
const {readState,validState,FILE,OFF}=require('./mobile-access.cjs');
const {MobileConsent}=require('./mobile-consent.cjs');
const receipts=new WeakMap(),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));
const refuse=()=>Object.assign(Error('Mobile pairing recovery is unconfirmed'),{code:'MOBILE_PERSISTENCE_DENIED'});
function details(d){
 if(!exact(d,['endpoint','all','workspace','consent','consentView'])||typeof d.all!=='boolean'||typeof d.consentView!=='boolean')return false;
 const e=d.endpoint;
 if(!exact(e,['actor','origin','port','binding'])||typeof e.actor!=='string'||!e.actor||e.actor.length>320||/[\x00-\x1f\x7f]/.test(e.actor)||!Number.isSafeInteger(e.port)||e.port<1024||e.port>65535)return false;
 if(e.binding!==null&&(!require('./mobile-carrier.cjs').validBinding(e.binding)||!['actor','origin','port'].every(k=>e.binding[k]===e[k])))return false;
 try{const u=new URL(e.origin);if(u.protocol!=='https:'||u.origin!==e.origin||u.username||u.password)return false;}catch{return false;}
 const w=d.workspace;
 if(w!==null&&!(exact(w,['allRooms','records'])&&w.allRooms===true&&typeof w.records==='boolean')&&
   !(exact(w,['roomIds','records'])&&Array.isArray(w.roomIds)&&w.roomIds.length<=32&&new Set(w.roomIds).size===w.roomIds.length&&w.roomIds.every(x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(x))&&typeof w.records==='boolean'))return false;
 return d.consent===null||exact(d.consent,['version','owner','enabled','key']);
}
const PHASES=['boot','restore','pair','load','restore-check','persist-enabled','persist-disabled','quit','revoke'];
const CATEGORIES=['ok','unconfirmed','unavailable','timeout','output-limit','input-limit','unsupported','process','invalid-response'];
function logPairing(root,entry){
 if(!exact(entry,['phase','category','elapsedMs'])||!PHASES.includes(entry.phase)||!CATEGORIES.includes(entry.category)||!Number.isSafeInteger(entry.elapsedMs)||entry.elapsedMs<0)return false;
 let fd;try{
  fd=fs.openSync(path.join(root,'mobile-persistence.log'),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_APPEND|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK,0o600);
  const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid()||(stat.mode&0o077)||stat.size>1024*1024)return false;
  fs.writeFileSync(fd,JSON.stringify(entry)+'\n');return true;
 }catch{return false;}finally{if(fd!==undefined)fs.closeSync(fd);}
}
class PairingStore{
 constructor(root,{adapter,asynchronous=false,log=()=>{}}={}){
  if(asynchronous)return new AsyncPairingStore(root,{adapter,log});
  this.root=fs.realpathSync(root);const s=fs.lstatSync(this.root);
  if(!s.isDirectory()||s.uid!==process.getuid()||s.mode&0o022||!adapter||typeof adapter.get!=='function'||typeof adapter.put!=='function')throw refuse();
  this.adapter=adapter;this.profile=createHash('sha256').update(JSON.stringify([process.getuid(),this.root])).digest('hex');
 }
 #valid(v){
  if(!exact(v,['version','profile','authority','mirror','details'])||v.version!==2||v.profile!==this.profile||!validState(v.authority)||!validState(v.mirror))return false;
  if(!v.authority.enabled)return v.details===null&&!v.mirror.enabled&&same(v.authority,{...v.mirror,pairing:null});
  const paused=!v.mirror.enabled&&v.mirror.generation!==v.authority.generation&&same(v.mirror,{...v.authority,generation:v.mirror.generation,enabled:false,pairing:null,device:null});
  if(!same(v.authority,v.mirror)&&!paused)return false;
  if(!details(v.details)||v.details.endpoint.actor!==v.authority.actor||v.details.endpoint.origin!==v.authority.origin)return false;
  try{new MobileConsent().restore(v.authority,v.authority,v.details.consent);return true;}catch{return false;}
 }
 valid(value){return value===null||this.#valid(value);}
 #get(){const v=this.adapter.get(this.profile);if(v!==null&&!this.#valid(v))throw refuse();return structuredClone(v);}
 #put(value,before){
  try{this.adapter.put(this.profile,structuredClone(value));}
  catch{let actual;try{actual=this.#get();}catch{throw Object.assign(refuse(),{persistenceUnconfirmed:true});}
   if(same(actual,value))return;
   throw Object.assign(refuse(),{persistenceUnconfirmed:!same(actual,before)});
  }
 }
 #mirror(){try{fs.lstatSync(path.join(this.root,FILE));}catch(e){if(e.code==='ENOENT')return null;throw e;}return readState(this.root,{allowDisabled:true});}
 checkpoint(){
  const value=this.#get(),current=this.#mirror();
  if(!value?.authority.enabled||!current||!same(value.mirror,current)||fs.existsSync(path.join(this.root,OFF)))throw refuse();
  const receipt=Object.freeze(structuredClone(value));receipts.set(receipt,{store:this,value:structuredClone(value)});return receipt;
 }
 verify(value){if(!same(this.#get(),value)||!same(this.#mirror(),value.mirror)||fs.existsSync(path.join(this.root,OFF)))throw refuse();}
  take(receipt){return take(receipt,this.root);}
  revoke(){
   const previous=this.#get();if(!previous)return;
   const authority={...previous.authority,generation:randomUUID(),enabled:false,pairing:null,device:null};
   const value={...previous,authority,mirror:authority,details:null};
   this.#put(value,previous);
  }
 commit(authority,info,save){
  const value={version:2,profile:this.profile,authority:structuredClone(authority.enabled?authority:{...authority,pairing:null}),mirror:structuredClone(authority),details:authority.enabled?structuredClone(info):null};
  return this.#publish(value,save);
 }
 pause(authority,info,mirror,save){
  const previous=this.#get();if(!previous||!same(previous.authority,authority))throw refuse();
  return this.#publish({...previous,mirror:structuredClone(mirror),details:structuredClone(info)},save);
 }
 #publish(value,save){
  if(!this.#valid(value))throw refuse();
  const previous=this.#get(),mirror=this.#mirror();
  if(previous&&!same(previous.mirror,mirror)&&!(value.authority.enabled===false&&previous.authority.enabled===false&&fs.existsSync(path.join(this.root,OFF))))throw refuse();
  this.#put(value,previous);
  try{save();}
  catch{
   let actual;try{actual=this.#mirror();}catch{throw Object.assign(refuse(),{persistenceUnconfirmed:true});}
   if(same(actual,value.mirror))return;
   if(value.authority.enabled&&same(actual,mirror)){
    try{this.#put(previous,value);}catch{throw Object.assign(refuse(),{persistenceUnconfirmed:true});}
    throw refuse();
   }
   throw Object.assign(refuse(),{persistenceUnconfirmed:true,persistenceRevoked:value.authority.enabled===false});
  }
 }
}
function take(receipt,root){const entry=receipts.get(receipt);receipts.delete(receipt);if(!entry||entry.store.root!==root||!same(receipt,entry.value))throw refuse();entry.store.verify(entry.value);return structuredClone(entry.value);}
const PENDING='mobile-recovery-pending';
class AsyncPairingStore{
 #core;#adapter;#value=null;#mode='loading';#ready;#tail=Promise.resolve();#serial=0;#log;
 constructor(root,{adapter,log}){
  this.root=fs.realpathSync(root);this.#adapter=adapter;this.#log=log;
  this.#core=new PairingStore(root,{adapter:{get:()=>structuredClone(this.#value),put:(_a,value)=>this.#enqueue(value)}});
 }
 status(){return this.#mode==='persistent'?'ready':this.#mode==='loading'?'pending':'temporary';}
 #notice(phase,error,start){try{this.#log({phase,category:CATEGORIES.includes(error?.persistenceCategory)?error.persistenceCategory:(error?'unconfirmed':'ok'),elapsedMs:Math.max(0,Math.round(performance.now()-start))});}catch{}}
 #marker(){
  const file=path.join(this.root,PENDING);let fd;
  try{fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);fs.writeFileSync(fd,'pending\n');fs.fsyncSync(fd);const dir=fs.openSync(this.root,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}
  catch(e){if(e.code!=='EEXIST')throw e;}
  finally{if(fd!==undefined)fs.closeSync(fd);}
  const read=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);let stat;
  try{stat=fs.fstatSync(read);if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid()||(stat.mode&0o077)||stat.size!==8||fs.readFileSync(read,'utf8')!=='pending\n')throw refuse();}finally{fs.closeSync(read);}
  return stat;
 }
 #blocked(){try{fs.lstatSync(path.join(this.root,PENDING));return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
 ready(phase='load'){
  if(!this.#ready){const serial=this.#serial,start=performance.now();this.#ready=(async()=>{
   try{const value=await this.#adapter.get(this.#core.profile);if(serial!==this.#serial)return;
    if(!this.#core.valid(value))throw refuse();this.#value=structuredClone(value);this.#mode='persistent';this.#notice(phase,null,start);
   }catch(error){if(serial!==this.#serial)return;this.#marker();this.#value=null;this.#mode='temporary';this.#notice(phase,error,start);}
  })();}
  return this.#ready;
 }
 async confirm(receipt){
  const serial=this.#serial,start=performance.now();
  try{
   if(this.#mode!=='persistent'||this.#blocked())throw refuse();
   const value=await this.#adapter.get(this.#core.profile);
   if(serial!==this.#serial||this.#mode!=='persistent'||this.#blocked()||!same(value,receipt))throw refuse();
   this.#core.verify(receipt);this.#notice('restore-check',null,start);
  }catch(error){this.#marker();this.#mode='temporary';this.#notice('restore-check',error,start);throw refuse();}
 }
 fresh(){if(this.#mode==='loading')throw refuse();this.#value=null;}
 #enqueue(value){
  const own=this.#marker(),serial=++this.#serial;this.#value=structuredClone(value);
  this.#tail=this.#tail.then(async()=>{
   if(this.#mode!=='persistent')return;const start=performance.now();
   try{
    try{await this.#adapter.put(this.#core.profile,value);}
    catch(error){let actual;try{actual=await this.#adapter.get(this.#core.profile);}catch{throw error;}if(!same(actual,value))throw error;}
    this.#notice(value.authority.enabled?'persist-enabled':'persist-disabled',null,start);
    // Only the latest acknowledged mirror may reopen recovery, never an older completion.
    if(serial===this.#serial&&same(this.#value,value)&&same(readState(this.root,{allowDisabled:true}),value.mirror)){
     const file=path.join(this.root,PENDING),now=fs.lstatSync(file);if(now.dev!==own.dev||now.ino!==own.ino)throw refuse();fs.unlinkSync(file);const dir=fs.openSync(this.root,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
    }
   }catch(error){this.#mode='temporary';try{this.#marker();}catch{}this.#notice(value.authority.enabled?'persist-enabled':'persist-disabled',error,start);}
  });
 }
 sealRevocation(){
  this.#serial++;this.#mode='temporary';this.#marker();const start=performance.now();
  const task=this.#tail.then(async()=>{
   try{
    const before=await this.#adapter.get(this.#core.profile);if(!this.#core.valid(before))throw refuse();
    if(before){const authority={...before.authority,generation:randomUUID(),enabled:false,pairing:null,device:null},value={...before,authority,mirror:authority,details:null};
     try{await this.#adapter.put(this.#core.profile,value);}catch(error){let actual;try{actual=await this.#adapter.get(this.#core.profile);}catch{throw error;}if(!same(actual,value))throw error;}
    }
    this.#notice('revoke',null,start);return true;
   }catch(error){this.#notice('revoke',error,start);return false;}
  });this.#tail=task.then(()=>{});return task;
 }
 async finish(timeoutMs=5000){
  let timer;const started=performance.now();
  try{return await Promise.race([this.flush(),new Promise((resolve,reject)=>{timer=setTimeout(()=>{
   this.#serial++;this.#mode='temporary';try{this.#marker();this.#adapter.cancel?.();this.#notice('quit',Object.assign(refuse(),{persistenceCategory:'timeout'}),started);resolve(this.status());}catch(error){reject(error);}
  },timeoutMs);})]);}finally{clearTimeout(timer);}
 }
 async flush(){await this.#ready;let tail;do{tail=this.#tail;await tail;}while(tail!==this.#tail);return this.status();}
 checkpoint(){if(this.#mode!=='persistent'||this.#blocked())throw refuse();return this.#core.checkpoint();}
 take(receipt){if(this.#mode!=='persistent'||this.#blocked())throw refuse();return this.#core.take(receipt);}
 commit(authority,info,save){
  if(this.#mode==='loading')throw refuse();this.#marker();
  if(this.#mode==='temporary'){const value={version:2,profile:this.#core.profile,authority:structuredClone(authority.enabled?authority:{...authority,pairing:null}),mirror:structuredClone(authority),details:authority.enabled?structuredClone(info):null};if(!this.#core.valid(value))throw refuse();return save();}return this.#core.commit(authority,info,save);
 }
 pause(authority,info,mirror,save){this.#marker();if(this.#mode==='temporary'){if(!this.#core.valid({version:2,profile:this.#core.profile,authority,mirror,details:info}))throw refuse();return save();}return this.#core.pause(authority,info,mirror,save);}
 revoke(){this.#marker();if(this.#mode==='loading'){this.#serial++;this.#mode='temporary';return;}if(this.#mode==='persistent')return this.#core.revoke();}
 cancelRecovery(){if(this.#mode==='loading'){this.#serial++;this.#mode='temporary';this.#marker();}}
}
function keychainAdapter({run=require('node:child_process').execFile,platform=process.platform}={}){
 const running=new Set();return {get:account=>call('get',account),put:(account,value)=>call('put',account,value),cancel(){for(const child of running)try{child.kill?.();}catch{}}};
 function call(action,account,value){
  return new Promise((resolve,reject)=>{
   let child,settled=false;const fail=category=>reject(Object.assign(refuse(),{persistenceCategory:category}));
   if(platform!=='darwin'||!/^[a-f0-9]{64}$/.test(account))return fail('unsupported');
   const input=JSON.stringify({action,account,...(action==='put'?{value}:{})});if(Buffer.byteLength(input)>512*1024)return fail('input-limit');
   const done=(error,out)=>{
    if(settled)return;settled=true;if(child)running.delete(child);
    if(error)return fail(error.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER'||error.code==='ENOBUFS'?'output-limit':error.code==='ETIMEDOUT'||error.killed?'timeout':'process');
    try{if(Buffer.byteLength(out)>512*1024)return fail('output-limit');const result=JSON.parse(out);if(!exact(result,['value']))return fail('invalid-response');resolve(result.value);}catch{return fail('invalid-response');}
   };
   try{child=run('/usr/bin/osascript',['-l','JavaScript',path.join(__dirname,'mobile-pairing-keychain.jxa')],{
    input,encoding:'utf8',timeout:5000,maxBuffer:512*1024,stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'},
   },done);if(child&&!settled)running.add(child);child?.stdin?.on?.('error',()=>{});child?.stdin?.end(input);
   }catch{return fail('process');}
  });
 }
}
module.exports={PairingStore,take,keychainAdapter,logPairing};
