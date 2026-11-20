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
class PairingStore{
 constructor(root,{adapter}={}){
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
function keychainAdapter({run=require('node:child_process').execFileSync,platform=process.platform}={}){
 return {
  get:account=>call('get',account),put:(account,value)=>call('put',account,value),
 };
 function call(action,account,value){
  if(platform!=='darwin'||!/^[a-f0-9]{64}$/.test(account))throw refuse();
  try{
   const input=JSON.stringify({action,account,...(action==='put'?{value}:{})});if(Buffer.byteLength(input)>512*1024)throw refuse();
   const out=run('/usr/bin/osascript',['-l','JavaScript',path.join(__dirname,'mobile-pairing-keychain.jxa')],{
    input,encoding:'utf8',timeout:5000,maxBuffer:512*1024,
    stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'},
   });
   const result=JSON.parse(out);if(!exact(result,['value']))throw refuse();return result.value;
  }catch{throw refuse();}
 }
}
module.exports={PairingStore,take,keychainAdapter};
