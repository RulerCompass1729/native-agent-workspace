// One local source for the bell (and a future phone reader). Private creation
// receipts and person-bound deletion snapshots never enter the public summary.
const fs=require('node:fs'), path=require('node:path'), {execFile}=require('node:child_process');
const {randomUUID}=require('node:crypto'), {promisify}=require('node:util');
const ownership=require('./temp-ownership.cjs'), {pythonExecutable}=require('./platform.cjs');
const {lockIdentity}=require('./service-lock.cjs');
const run=promisify(execFile), DAY=86400000, LINE=512*1024*1024, WEEK=7*DAY;
const CLEAN_CHECK_MS=10000, CLEAN_REFRESH_ENTRIES=50000;
const intersects=(a,b)=>ownership.inside(a,b)||ownership.inside(b,a);
const ident=s=>[Number(s.dev),Number(s.ino),Number(s.uid),Number(s.size),s.mtimeNs.toString(),s.ctimeNs.toString()];
const protectedNames=new Set(['.git','.naw-keep','auth.json','.credentials.json','credentials','rollouts','evidence']);
function ownerAlive(owner) {
  try{process.kill(owner.pid,0);}catch(error){return error.code!=='ESRCH';}
  const current=lockIdentity(owner.pid); return !current||current.started===owner.started;
}
const ineligible=()=>Object.assign(Error('Protected temporary content'),{code:'TEMP_INELIGIBLE'});
const changed=()=>Object.assign(Error('Temporary directory identity changed'),{code:'TEMP_CHANGED'});
function liveRuntimeMetadata(file,expected) {
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {
    const stat=fs.fstatSync(fd); if(stat.size>16384||stat.ino!==expected.ino||stat.dev!==expected.dev) throw ineligible();
    let metadata; try {metadata=JSON.parse(fs.readFileSync(fd,'utf8'));} catch {throw ineligible();}
    const pid=Number.isSafeInteger(metadata)?metadata:metadata?.pid;
    if(!Number.isSafeInteger(pid)||pid<2) throw ineligible();
    try {process.kill(pid,0); return true;} catch(error) {if(error.code==='ESRCH') return false;throw ineligible();}
  } finally {fs.closeSync(fd);}
}
function shouldShow({bytes,oldestAt,anomaly,anomalyVersion=0},ack,now) {
  const due=bytes>=LINE || oldestAt!==null&&now-oldestAt>=WEEK || Boolean(anomaly);
  return Boolean(due&&(!ack || bytes>=ack.bytes+LINE || oldestAt!==null&&now-oldestAt>=ack.age+WEEK || anomaly&&(anomaly!==ack.anomaly||anomalyVersion>(ack.anomalyVersion||0))));
}
async function inspectSystem() {
  const [files,mounts]=await Promise.all([run('/usr/sbin/lsof',['-nP','-Fn'],{timeout:30000,maxBuffer:16*1024*1024}),run('/sbin/mount',[],{timeout:10000,maxBuffer:1024*1024})]);
  if(!files.stdout.trim() || files.stderr.trim() || mounts.stderr.trim() || !mounts.stdout.trim()) throw Error('System inspection unavailable');
  // Do not resolve unrelated applications' files. Only normalize the OS /tmp alias.
  const normalized=p=>process.platform==='darwin'?p.replace(/^\/tmp(?=\/|$)/,'/private/tmp').replace(/^\/var(?=\/|$)/,'/private/var'):p;
  return {opened:files.stdout.split('\n').filter(s=>s.startsWith('n/')).map(s=>normalized(s.slice(1).replace(/ \(deleted\)$/,''))),
    mounted:mounts.stdout.split('\n').map(s=>s.match(/ on (.*) \(/)?.[1]).filter(Boolean).map(normalized)};
}
async function tree(record,roots,system,protectedPaths,now,check=()=>{}) {
  const file=record.path;
  if(!roots.some(root=>file!==root&&ownership.inside(root,file)) || protectedPaths.some(p=>intersects(p,file))) return null;
  const first=await fs.promises.lstat(file,{bigint:true});
  if(!first.isDirectory() || first.isSymbolicLink() || Number(first.uid)!==record.uid || Number(first.dev)!==record.dev || Number(first.ino)!==record.ino || await fs.promises.realpath(file)!==file) throw changed();
  if(system.opened.some(p=>ownership.inside(file,p)) || system.mounted.some(p=>ownership.inside(file,p)||roots.some(root=>ownership.inside(root,p))&&ownership.inside(p,file))) return null;
  const entries=[]; let bytes=0,newest=0;
  async function visit(folder,name) {
    check(entries.length);
    if(entries.length>=50000) throw Error('Temporary tree too large');
    const s=await fs.promises.lstat(folder,{bigint:true});
    if(Number(s.uid)!==record.uid || Number(s.dev)!==record.dev || s.isSymbolicLink() || (!s.isDirectory()&&!s.isFile()) || s.isFile()&&s.nlink!==1n) throw ineligible();
    if(name && protectedNames.has(path.basename(name))) throw ineligible();
    if(s.isFile()&&['service.lock','connection.json'].includes(path.basename(name))&&liveRuntimeMetadata(folder,{ino:Number(s.ino),dev:Number(s.dev)})) throw ineligible();
    const allocated=Number(s.blocks)*512;
    entries.push({name,identity:ident(s),directory:s.isDirectory(),bytes:allocated}); bytes+=allocated; newest=Math.max(newest,Number(s.mtimeMs));
    if(s.isDirectory()) for(const child of (await fs.promises.readdir(folder)).sort()) await visit(path.join(folder,child),name?name+'/'+child:child);
  }
  await visit(file,'');
  if(now-newest<DAY) return null;
  // Read the root again: a concurrent subtree insertion is never a valid snapshot.
  if(JSON.stringify(ident(await fs.promises.lstat(file,{bigint:true})))!==JSON.stringify(entries[0].identity)) throw changed();
  return {record,entries,bytes};
}
function remove(snapshot,roots,registry) {
  return new Promise(resolve=>{
    const python=pythonExecutable(); if(!python) return resolve({removed:false,bytes:0});
    const child=execFile(python,[path.join(__dirname,'temp-cleanup.py')],{timeout:30000,maxBuffer:8192},(error,stdout)=>{
      try { if(error) throw error; const r=JSON.parse(stdout); if(typeof r.removed!=='boolean'||!Number.isSafeInteger(r.bytes)||r.bytes<0) throw Error('Invalid removal receipt'); resolve(r); }
      catch { resolve({removed:false,bytes:0}); }
    });
    child.stdin.on('error',()=>{}); child.stdin.end(JSON.stringify({path:snapshot.record.path,owner:snapshot.record.owner,roots,entries:snapshot.entries,registry}));
  });
}
class TempReminders {
  constructor({dataDir,registryDir=ownership.defaultDirectory(),roots=ownership.roots(),now=Date.now,monotonic=()=>performance.now(),inspect=inspectSystem,isAlive=ownerAlive,isPerson,changed=()=>{}}) {
    Object.assign(this,{dataDir,registryDir,roots:[...new Set(roots.map(p=>fs.realpathSync(p)))],now,monotonic,inspect,isAlive,isPerson,changed});
    this.file=path.join(dataDir,'temp-reminders.json'); this.tickets=new WeakMap(); this.candidates=[]; this.cached=null; this.lastScan=null; this.busy=false;
    try { const fd=fs.openSync(this.file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      try { const s=fs.fstatSync(fd); if(!s.isFile()||s.uid!==process.getuid()||s.mode&0o077||s.size>65536) throw Error('Unsafe reminder state'); this.saved=JSON.parse(fs.readFileSync(fd,'utf8')); }
      finally { fs.closeSync(fd); }
      if(this.saved.version!==1||!Number.isSafeInteger(this.saved.reminder?.version)) throw Error('Invalid reminder state');
    } catch(error) { if(error.code!=='ENOENT') throw error; this.saved={version:1,ack:null,reminder:{id:'naw-temp-files',version:0,result:null}}; }
  }
  save(reminder) {
    const s=fs.lstatSync(this.dataDir); if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||s.mode&0o077) throw Error('Unsafe reminder profile');
    const next={version:1,ack:this.saved.ack,reminder:{...reminder,id:'naw-temp-files',version:this.saved.reminder.version+1}};
    const temporary=this.file+'.'+randomUUID();
    try { fs.writeFileSync(temporary,JSON.stringify(next),{mode:0o600,flag:'wx'}); fs.renameSync(temporary,this.file); }
    finally { try {fs.unlinkSync(temporary);} catch(error) {if(error.code!=='ENOENT') throw error;} }
    this.saved=next; this.cached=next.reminder;
    try { Promise.resolve(this.changed()).catch(()=>{}); } catch { /* A closed view does not undo a durable result. */ }
    return this.cached;
  }
  async status(force=false,check) {
    // Retry before the daily cache, but keep an unchanged refusal cached so
    // recordsChanged does not trigger a scan/save/notification feedback loop.
    let registrationIssue;
    try {ownership.checkRegistration(this.registryDir);}catch(error){registrationIssue=error.registrationIssue;}
    if(registrationIssue!==this.cached?.registrationIssue)force=true;
    if(this.pending) return this.pending;
    if(!force&&this.lastScan!==null&&this.cached&&this.now()-this.lastScan<DAY&&this.now()>=this.lastScan) return this.cached;
    this.pending=this.scan(check).catch(error=>{
      const notify=this.cached?.anomaly!=='storage-unavailable';
      // All readers must see the failure instead of an earlier quiet cache.
      // Keep it ephemeral, grant no candidate, and retry on the next read.
      this.cached={...this.saved.reminder,id:'naw-temp-files',checkedAt:this.now(),directories:0,bytes:0,oldestDay:null,oldestAt:null,shown:true,anomaly:'storage-unavailable'};
      this.candidates=[];this.lastScan=null;
      if(notify)try{Promise.resolve(this.changed()).catch(()=>{});}catch{}
      throw error;
    }).finally(()=>{this.pending=null;}); return this.pending;
  }
  async scan(check=()=>{}) {
    const now=this.now(); let entries=[],anomaly=null,registrationIssue;
    try {
      ownership.checkRegistration(this.registryDir);
      const available=[];
      const alive=new Map(); const live=r=>{ const key=JSON.stringify(r.owner); if(!alive.has(key)) alive.set(key,this.isAlive(r.owner)); return alive.get(key); };
      for await(const batch of ownership.batches(this.registryDir,check)) for(const r of batch) { check(available.length); if(!this.roots.some(root=>r.path!==root&&ownership.inside(root,r.path)) || path.resolve(r.path)!==r.path) continue;
        try { await fs.promises.lstat(r.path); available.push(r); }
        catch(error) { if(error.code==='ENOENT') ownership.forgetMissing(r,this.registryDir); else throw error; } }
      const protectedPaths=available.filter(live).map(r=>r.path);
      const system=available.some(r=>!live(r))?await this.inspect():{opened:[],mounted:[]};
      let retained=available.length;
      for(const r of available.sort((a,b)=>a.path.length-b.path.length)) {
        check(retained);
        if(live(r)||entries.some(e=>ownership.inside(e.record.path,r.path))) continue;
        try { const e=await tree(r,this.roots,system,protectedPaths,now,size=>check(retained+size)); if(e) {entries.push(e);retained+=e.entries.length;} }
        catch(error) { if(error.code==='TEMP_BUDGET')throw error; if(!['ENOENT','TEMP_INELIGIBLE','TEMP_CHANGED'].includes(error.code)) anomaly='inspection-unavailable'; }
      }
      ownership.checkRegistration(this.registryDir);
    } catch(error) { registrationIssue=error.registrationIssue;anomaly=registrationIssue?'registration-unverified':'inspection-unavailable'; entries=[]; }
    this.candidates=entries; this.lastScan=now;
    const bytes=entries.reduce((s,e)=>s+e.bytes,0), oldest=entries.length?Math.min(...entries.map(e=>e.record.createdAt)):null;
    const anomalyVersion=(this.saved.reminder.anomalyVersion||0)+(anomaly&&this.saved.reminder.anomaly!==anomaly?1:0);
    const shown=shouldShow({bytes,oldestAt:oldest,anomaly,anomalyVersion},this.saved.ack,now);
    return this.save({checkedAt:now,directories:entries.length,bytes,oldestDay:oldest===null?null:new Date(oldest).toISOString().slice(0,10),oldestAt:oldest,
      shown:Boolean(shown),anomaly,anomalyVersion,...(registrationIssue?{registrationIssue}:{}),result:this.saved.reminder.result});
  }
  person(c) { if(typeof this.isPerson!=='function'||!this.isPerson(c)) throw Error('Temporary cleanup is person-only'); }
  async present(c,force=false) {
    this.person(c); const status=await this.status(force); this.person(c);
    const ticket=randomUUID(); this.tickets.set(c,{ticket,version:status.version,entries:[...this.candidates],status,at:this.now()});
    return {...status,ticket};
  }
  take(c,ticket,consume=false) {
    this.person(c); const grant=this.tickets.get(c);
    if(!grant||grant.ticket!==ticket||this.now()-grant.at>DAY||this.now()<grant.at) throw Error('Temporary cleanup snapshot changed');
    if(consume) this.tickets.delete(c); return grant;
  }
  async acknowledge(c,ticket) {
    const grant=this.take(c,ticket),s=grant.status,current=this.cached;
    const baseline=s.anomaly&&!s.directories&&this.saved.ack?this.saved.ack:{bytes:Math.min(s.bytes,current.bytes),age:Math.min(s.oldestAt===null?0:this.now()-s.oldestAt,current.oldestAt===null?0:this.now()-current.oldestAt)};
    this.saved.ack={...baseline,anomaly:s.anomaly,anomalyVersion:s.anomalyVersion||0};
    this.save({...current,shown:shouldShow(current,this.saved.ack,this.now())}); return this.present(c);
  }
  async clean(c,ticket) {
    const grant=this.take(c,ticket,true); if(this.busy) throw Error('Temporary cleanup already running');
    this.busy=true; const result={at:this.now(),cleaned:0,bytes:0,skipped:0,reasons:{busy:0,changed:0,unverified:0}};
    // One monotonic budget for execution-time inventory checks and the final
    // refresh. A deadline/retained-metadata limit fails closed, never deletes.
    const deadline=this.monotonic()+CLEAN_CHECK_MS,check=(retained=0)=>{
      if(this.monotonic()>=deadline||retained>=CLEAN_REFRESH_ENTRIES) throw Object.assign(Error('Temporary inspection budget exhausted'),{code:'TEMP_BUDGET'});
    };
    this.finished=new Promise(resolve=>{this.finish=resolve;});
    try {
      try {ownership.retryCompletions(this.registryDir);}catch{ /* Per-candidate proofs and the final scan retain the reason. */ }
      for(const [index,before] of grant.entries.entries()) {
        try {this.person(c);check();} catch {
          const remaining=grant.entries.length-index;result.skipped+=remaining;result.reasons.unverified+=remaining;break;
        }
        try {
          // Independently inspect each directory at execution; never extend a grant
          // to a newly discovered candidate or trust a cached lsof/mount result.
          const registry=ownership.revision(this.registryDir,check);
          let record=null,liveOverlap=false;
          for await(const batch of ownership.batches(this.registryDir,check)) for(const r of batch) {
            check();
            if(r.id===before.record.id)record=r;
            if(intersects(before.record.path,r.path)&&this.isAlive(r.owner))liveOverlap=true;
          }
          // Retain one receipt and a boolean, not the whole inventory. Finish
          // the stream: a later live child or unsafe receipt must still block.
          if(!record)throw Error('Temporary ownership receipt missing');
          if(['path','uid','dev','ino'].some(k=>record[k]!==before.record[k])||JSON.stringify(record.owner)!==JSON.stringify(before.record.owner))throw changed();
          if(liveOverlap) {result.skipped++;result.reasons.busy++;continue;}
          const system=await this.inspect(); this.person(c);
          const current=await tree(record,this.roots,system,[],this.now(),check);
          if(!current) {result.skipped++;result.reasons.busy++;continue;}
          if(JSON.stringify(current.entries)!==JSON.stringify(before.entries)) {result.skipped++;result.reasons.changed++;continue;}
          this.person(c);check();
          // No asynchronous gap between the final registry check and dispatch.
          // Python carries this same proof across its own system inspection.
          if(JSON.stringify(ownership.revision(this.registryDir,check))!==JSON.stringify(registry))throw changed();
          const receipt=await remove(current,this.roots,registry); result.bytes+=receipt.bytes;
          if(receipt.removed) {result.cleaned++;try{ownership.forget(record.id,this.registryDir);}catch{result.bookkeepingFailed=true;}}
          else {result.skipped++;result.reasons[receipt.registryChanged===true&&receipt.untouched===true&&receipt.bytes===0&&!receipt.registrationIssue?'changed':'unverified']++;if(receipt.registrationIssue)result.registrationIssue=receipt.registrationIssue;}
        } catch(error) {result.skipped++;result.reasons[error.code==='TEMP_CHANGED'?'changed':'unverified']++;if(error.registrationIssue)result.registrationIssue=error.registrationIssue;}
      }
      try {this.save({...this.cached,result}); await this.status(true,check);}
      catch {result.bookkeepingFailed=true;this.cached={...this.cached,result,shown:true,anomaly:'storage-unavailable'};this.saved.reminder=this.cached;}
      return result;
    } finally {this.busy=false;this.finish();}
  }
}
function tempSummary(r) {
  const n=k=>{if(!Number.isSafeInteger(r[k])||r[k]<0)throw Error('Invalid reminder count');return r[k];};
  if(typeof r.shown!=='boolean')throw Error('Invalid reminder state');
  const out={id:'naw-temp-files',version:n('version'),state:r.anomaly||r.state==='unavailable'?'unavailable':r.shown?'ready':'quiet',checkedAt:n('checkedAt'),directories:n('directories'),bytes:n('bytes'),oldestDay:/^\d{4}-\d{2}-\d{2}$/.test(r.oldestDay)?r.oldestDay:null,shown:r.shown===true,result:null};
  if(r.result) out.result=Object.fromEntries(['at','cleaned','bytes','skipped'].map(k=>{if(!Number.isSafeInteger(r.result[k])||r.result[k]<0)throw Error('Invalid cleanup result');return [k,r.result[k]];}));
  for(const [source,target] of [[r,out],[r.result,out.result]])if(source?.registrationIssue!==undefined) {
    if(!['incomplete','metadata-unavailable'].includes(source.registrationIssue))throw Error('Invalid registration issue');
    target.registrationIssue=source.registrationIssue;
  }
  return out;
}
function readSummary(dataDir) {
  const file=path.join(dataDir,'temp-reminders.json'),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {
    const stat=fs.fstatSync(fd); if(!stat.isFile()||stat.uid!==process.getuid()||stat.mode&0o077||stat.size>65536) throw Error('Unsafe reminder summary');
    const value=JSON.parse(fs.readFileSync(fd,'utf8')); if(value.version!==1||value.reminder?.id!=='naw-temp-files') throw Error('Invalid reminder summary');
    return tempSummary(value.reminder);
  } finally {fs.closeSync(fd);}
}
module.exports={TempReminders,readSummary,tempSummary,inspectSystem,shouldShow,DAY,LINE};
