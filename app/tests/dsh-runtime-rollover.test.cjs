const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const tui=require('../dsh-tui.cjs'),{qualification,runtime}=require('./helpers/dsh-runtime.cjs'),layout=require('../service-layout.cjs');
for(const kind of ['new','pending','reused'])test(kind+' backend retains a qualified DSH runtime through real ensureService selection',async t=>{
 qualification(t);const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'naw-dsh-rollover-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));runtime(root);
 const slot='backends/aaaaaaaaaaaaaaaaaaaa',dest=path.join(root,slot);if(kind!=='new')fs.mkdirSync(dest,{recursive:true,mode:0o700});
 if(kind==='pending')layout.writeLayout(root,{format:1,active:'.',entries:['.'],pending:slot});if(kind==='reused')layout.writeLayout(root,{format:1,active:'.',entries:['.',slot]});
 const source=fs.readFileSync(require.resolve('../service-client.cjs'),'utf8'),start=source.indexOf('async function ensureService(dataDir,'),end=source.indexOf('\nfunction continuationStatus',start);assert.ok(start>0&&end>start);const calls=[];
 const ctx={fs,path,crypto,__dirname:path.join(__dirname,'..'),process:{env:{NAW_APP_VERSION:'synthetic-new'}},uiError:key=>Error(key),...layout,readLock:()=>undefined,createLock:()=>({}),releaseLock:()=>true,ownerMayBeAlive:()=>false,emptyService:()=>false,emptyStore:()=>false,
  require(name){assert.equal(name,'./dsh-tui.cjs');return tui;},ensureServiceAt:async dir=>{calls.push(dir);return {runtimeVersion:dir===root?'synthetic-old':'synthetic-new',sessions:dir===root?[{id:'synthetic-record',state:'error'}]:[],room:{messages:[]}};},connectService:async()=>({call:async()=>{},close(){}})};
 await vm.runInNewContext(source.slice(start,end)+'\nensureService',ctx)(root,'/synthetic/electron');const after=layout.readLayout(root),selected=path.join(root,after.active);
 assert.match(after.active,/^backends\//);assert.equal(tui.installed(root),true);assert.equal(tui.installed(selected),true,'selected backend lost DSH runtime');tui.verifyRuntime(selected);assert.equal(after.pending,undefined);assert.ok(calls.includes(selected));
 if(kind==='reused')assert.equal(calls.filter(x=>x===dest).length,1,'already running reused backend is not restarted');
});
