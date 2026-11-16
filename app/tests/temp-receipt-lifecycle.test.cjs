const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process'),{createHash}=require('node:crypto');
const root=path.resolve(__dirname,'../..');
function fixture(t){const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'naw-receipt-lifecycle-')));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));const home=path.join(base,'home');fs.mkdirSync(home,{mode:0o700});const env={...process.env,HOME:home};for(const key of ['NAW_DATA_DIR','NAW_TEMP_REGISTRY_DIR','NODE_OPTIONS','NODE_TEST_CONTEXT','NAW_TEST_TEMP_JOURNAL'])delete env[key];return {base,home,env};}
const storeCount=home=>{const dir=path.join(home,...(process.platform==='darwin'?['Library','Application Support']:['.local','share']),'Native Agent Workspace','temp-ownership');return fs.existsSync(dir)?fs.readdirSync(dir).filter(n=>n.endsWith('.json')).length:0;};
function child(f,body){const result=spawnSync(process.execPath,['-e',body],{env:f.env,cwd:root,encoding:'utf8',timeout:30000});assert.equal(result.status,0,result.stdout+result.stderr);return result;}
test('removeOwned forgets its creation receipt when the caller already deleted the directory',t=>{
 const f=fixture(t);child(f,`const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),own=require('./app/temp-ownership.cjs'),temp=require('./scripts/fixtures/test-temp.cjs');const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'naw-removed-receipt-')));const record={path:dir,...temp.identity(dir),reminderReceipt:own.register(dir)};fs.rmdirSync(dir);temp.removeOwned(record);`);
 assert.equal(storeCount(f.home),0,'Already-removed directories must not leave durable receipts');
});
test('standalone test-scratch release forgets the directory receipt in the default fake-HOME store',t=>{
 const f=fixture(t);child(f,`const scratch=require('./scripts/fixtures/test-scratch.cjs'),os=require('node:os'),path=require('node:path');scratch.directory(path.join(os.tmpdir(),'naw-scratch-receipt-'));scratch.release().catch(e=>{console.error(e);process.exitCode=1});`);
 assert.equal(storeCount(f.home),0,'Successful scratch release must forget, not just delete');
});
test('a suite parent forgets a delegated directory removed by a child that skipped exit hooks',t=>{
 const f=fixture(t),file=path.join(f.base,'mini-suite.cjs');
 fs.writeFileSync(file,`const test=require('node:test'),{spawnSync}=require('node:child_process');test('a removed delegated directory',()=>{const p=spawnSync(process.execPath,['-e',"const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'naw-gone-delegated-'));globalThis[Symbol.for('naw.testTemp.delegate')](dir);fs.rmdirSync(dir);process.kill(process.pid,'SIGKILL')"],{env:process.env});if(p.signal!=='SIGKILL')throw Error('Expected abrupt exit');});`);
 const result=spawnSync(process.execPath,['scripts/test.cjs',file],{env:f.env,cwd:root,encoding:'utf8',timeout:30000});
 assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/TEMP GUARD: PASS/);assert.equal(storeCount(f.home),0,'Parent cleanup must include gone delegated receipts');
});
test('an outer suite also forgets missing receipts from a retained inner suite',t=>{
 const f=fixture(t),inner=path.join(f.base,'inner.cjs'),outer=path.join(f.base,'outer.cjs'),report=path.join(f.base,'inner-report.json');
 fs.writeFileSync(inner,`const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'naw-inner-protected-'));globalThis[Symbol.for('naw.testTemp.delegate')](dir);process.kill(process.pid,'SIGKILL');`);
 fs.writeFileSync(outer,`const {spawnSync}=require('node:child_process'),fs=require('node:fs'),assert=require('node:assert/strict');const env={...process.env,NAW_TEST_TEMP_REPORT:${JSON.stringify(report)}};delete env.NODE_TEST_CONTEXT;const result=spawnSync(process.execPath,[${JSON.stringify(path.join(root,'scripts/test.cjs'))},${JSON.stringify(inner)}],{env,encoding:'utf8'});assert.equal(result.status,1,result.stderr);const kept=JSON.parse(fs.readFileSync(${JSON.stringify(report)}));assert.equal(kept.retained,true);require(${JSON.stringify(path.join(root,'scripts/fixtures/test-temp.cjs'))}).removeOwned(kept.scope);`);
 const result=spawnSync(process.execPath,['scripts/test.cjs',outer],{env:f.env,cwd:root,encoding:'utf8',timeout:30000});
 assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/TEMP GUARD: PASS/);assert.equal(storeCount(f.home),0,'Inner journals must not leave dangling receipts in the default store');
});
test('one scan streams orphan receipts without the bounded reader and still offers the real old candidate',async t=>{
 const f=fixture(t),dataDir=path.join(f.base,'profile'),reg=path.join(f.base,'registry'),area=path.join(f.base,'area');fs.mkdirSync(dataDir,{mode:0o700});fs.mkdirSync(area);
 const own=require('../temp-ownership.cjs'),now=Date.now(),old=now-8*86400000,dead={pid:2**30,started:'synthetic exited owner'};
 const dir=fs.mkdtempSync(path.join(area,'owned-'));fs.writeFileSync(path.join(dir,'data'),'synthetic');for(const p of [path.join(dir,'data'),dir])fs.utimesSync(p,new Date(old),new Date(old));
 own.register(dir,{registryDir:reg,owner:dead,now:()=>old});const record=own.read(reg)[0];
 // Cross multiple real 256-entry batches, without writing 50,001 files on every run.
 const orphanCount=513;
 for(let i=0;i<orphanCount;i++){const r={...record,path:path.join(area,'gone-'+i),ino:record.ino+i+1};r.id=createHash('sha256').update(JSON.stringify([r.path,r.dev,r.ino,r.uid])).digest('hex');fs.writeFileSync(path.join(reg,r.id+'.json'),JSON.stringify(r),{mode:0o600});}
 assert.equal(fs.readdirSync(reg).length,orphanCount+1);
 // The old scan hit read()'s inventory limit before pruning. Guard it before
 // loading the scanner, so even a captured read reference cannot hide that bug.
 const boundedRead=t.mock.method(own,'read',()=>{throw Error('Scan must not use the bounded receipt reader');});
 let status;
 try {
  const {TempReminders}=require('../temp-reminders.cjs');
  const manager=new TempReminders({dataDir,registryDir:reg,roots:[area],now:()=>now,isAlive:()=>false,isPerson:()=>true,inspect:async()=>({opened:[],mounted:[]})});
  status=await manager.status();
 } finally {boundedRead.mock.restore();}
 console.log('RECEIPT CLIFF before='+(orphanCount+1)+' after='+fs.readdirSync(reg).length+' candidates='+status.directories+' anomaly='+status.anomaly+' boundedReads='+boundedRead.mock.callCount());assert.equal(status.anomaly,null,'Inventory size must not prevent the missing-path sweep');assert.equal(boundedRead.mock.callCount(),0,'Scan must remain independent of the bounded inventory reader');assert.equal(status.directories,1);assert.equal(status.shown,true);assert.equal(fs.readdirSync(reg).length,1);assert.equal(own.read(reg)[0].path,dir);
});
