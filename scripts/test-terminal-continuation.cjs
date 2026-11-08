// T79 complete owned source-GUI read/reopen/link journey. No provider or model.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..'),scratch=require('./fixtures/test-scratch.cjs');
const {_electron}=scratch.playwright(require('playwright')), {createIn}=require('./fixtures/create-view.cjs');
const {connectService}=require('../app/service-connection.cjs');
const args=process.argv.slice(2),option=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined,diagnostic=args.includes('--diagnose');
const plan={task:'T79 native snapshot continuation source GUI',profiles:1,GUIStarts:2,windowsPerStart:1,ownedSyntheticDaemon:1,inMemoryWorker:1,realPTYs:0,providerProcesses:0,productModels:0,dispatches:0,OSClipboard:0,OSLinkOpens:0,activeMs:180000,cleanupMs:90000};
if(args.includes('--plan')){console.log(JSON.stringify(plan,null,2));process.exit(0);}
assert.ok(args.includes('--run'),'Explicit --run required');
const evidence=option('--evidence');assert.ok(evidence&&path.isAbsolute(evidence)&&!fs.existsSync(evidence),'Fresh absolute evidence required');
assert.ok(!process.env.NAW_APP_EXECUTABLE&&!process.env.NAW_TEST_APP_ROOT&&!process.env.NAW_EVIDENCE_DIR,'No ambient target');
const common=require('node:child_process').execFileSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{cwd:process.cwd(),encoding:'utf8'}).trim();
const slot=path.join(path.dirname(common),'.local/gui-test-slot.lock'),token=randomUUID();
let lease=false,profile,child,client,app,page,id,stopped=false,seq=0,failure,finalCounts;
const launched=[],errors=[],checks=[],delay=ms=>new Promise(r=>setTimeout(r,ms));
const owner={owner:'Codex2',task:'T79 continuation source-GUI reopen/link journey',token,pid:process.pid,createdAt:new Date().toISOString()};
const sourceFiles=['app/adapters.cjs','app/terminal-continuation.js','app/observation.cjs','app/legacy-observation.cjs','app/renderer/renderer.js','app/renderer/index.html','app/dsh/client.js','app/service-client.cjs','scripts/build-ui.cjs','scripts/package-mac.cjs','scripts/fixtures/terminal-continuation.cjs','scripts/test-terminal-continuation.cjs'];
const hashes=()=>Object.fromEntries(sourceFiles.map(f=>[f,createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex')]));
let frozen,original;
const env=extra=>({...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('NAW_')&&!k.startsWith('ELECTRON_')&&!['NODE_OPTIONS','NODE_PATH'].includes(k))),...extra});
async function until(read,label){for(let n=0;n<120;n++){if(stopped)throw Error('Owned trial stopped');if(await read())return;await delay(50);}throw Error(label);}
function fixture(method,value){const requestId=++seq;return new Promise((resolve,reject)=>{const receive=m=>{if(m.channel!=='t79-continuation'||m.requestId!==requestId)return;clearTimeout(timer);child.off('message',receive);m.error?reject(Error(m.error)):resolve(m);};const timer=setTimeout(()=>{child.off('message',receive);reject(Error('Owned fixture timeout'));},5000);child.on('message',receive);child.send({id:requestId,channel:'t79-continuation',method,target:id,value});});}
const state=()=>client.call('initial');
const view=()=>page.evaluate(()=>workspace.initial());
const nativeRows=()=>page.locator(`[data-terminal-id="${id}"] .xterm-rows`);
async function capture(name,extra={}){fs.writeFileSync(path.join(evidence,name+'.json'),JSON.stringify({state:await state(),fixture:await fixture('stats'),dom:await page.evaluate(id=>{const r=document.querySelector('[data-terminal-id=\"'+id+'\"]');return r?{root:r.querySelector('.xterm')?.className,screen:r.querySelector('.xterm-screen')?.className,text:r.querySelector('.xterm-rows')?.textContent}:null;},id),...extra},null,2));await page.screenshot({path:path.join(evidence,name+'.png')});}
async function launch(){assert.ok(!stopped&&launched.length<2);app=await _electron.launch({executablePath:require('electron'),args:[path.join(profile,'gui-entry')],env:env({NAW_DATA_DIR:profile,NAW_TEST_PARENT_PID:String(process.pid)}),timeout:60000});launched.push(app.process().pid);page=await app.firstWindow();page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));await page.locator('#new-session').waitFor();assert.equal(app.windows().length,1);assert.equal((await view()).servicePid,child.pid);}
async function charPoint(character){return page.locator(`[data-terminal-id="${id}"] .xterm-rows > div`).first().evaluate((row,character)=>{const walk=document.createTreeWalker(row,NodeFilter.SHOW_TEXT),found=[];for(let node=walk.nextNode();node;node=walk.nextNode()){for(let i=0;i<node.textContent.length;i++)if(node.textContent[i]===character){const range=document.createRange();range.setStart(node,i);range.setEnd(node,i+1);const r=range.getBoundingClientRect();found.push({x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height});}}if(found.length!==1)throw Error('Expected one exact fixture character');return found[0];},character);}
async function run(){
 try{fs.mkdirSync(slot);}catch(e){if(e.code!=='EEXIST')throw e;console.log('OCCUPIED: no owned profile/GUI allocated');process.exitCode=75;return;}
 lease=true;fs.writeFileSync(path.join(slot,'owner.json'),JSON.stringify(owner));fs.mkdirSync(evidence,{recursive:true,mode:0o700});fs.writeFileSync(path.join(evidence,'plan.json'),JSON.stringify(plan,null,2));frozen=hashes();
 profile=scratch.directory(path.join(os.tmpdir(),'naw-t79-continuation-'));fs.mkdirSync(path.join(profile,'workspace'));process.env.NAW_EVIDENCE_DIR=path.join(evidence,'raw');
 const entry=path.join(profile,'gui-entry');fs.mkdirSync(entry,{mode:0o700});fs.writeFileSync(path.join(entry,'package.json'),JSON.stringify({name:'naw-owned-continuation-gui',version:require('../package.json').version,main:'main.cjs'}));
 fs.writeFileSync(path.join(entry,'main.cjs'),`const e=require('electron'),cp=require('node:child_process'),p=require('node:path');globalThis.t79Guards={clipboard:0,external:0,dialogs:0};for(const k of ['readText','writeText','readImage','writeImage','read','write','readBuffer','writeBuffer','clear'])e.clipboard[k]=()=>{globalThis.t79Guards.clipboard++;throw Error('OS clipboard forbidden');};for(const k of ['openExternal','openPath'])e.shell[k]=async()=>{globalThis.t79Guards.external++;throw Error('External link forbidden');};for(const k of ['showMessageBox','showOpenDialog','showSaveDialog'])e.dialog[k]=async()=>{globalThis.t79Guards.dialogs++;throw Error('OS dialog forbidden');};const spawn=cp.spawn;cp.spawn=function(exe,argv,...rest){if(Array.isArray(argv)&&argv.some(a=>typeof a==='string'&&p.basename(a)==='daemon.cjs'))throw Error('Replacement service forbidden');return spawn.call(this,exe,argv,...rest);};require(${JSON.stringify(path.join(root,'app/main.cjs'))});`);
 child=scratch.childProcess.fork(path.join(root,'app/daemon.cjs'),[profile],{execArgv:['--require',path.join(root,'scripts/fixtures/terminal-continuation.cjs')],env:env({NAW_TEST_APP_ROOT:root,NAW_WORKSPACE:path.join(profile,'workspace'),NAW_APP_VERSION:require('../package.json').version}),stdio:['ignore','ignore','inherit','ipc']});
 await until(()=>fs.existsSync(path.join(profile,'connection.json')),'Owned daemon ready');client=await connectService(profile,'t79-inspection-driver');await launch();
 await page.locator('#new-session').click();await page.locator('input[name="provider"][value="codex"]').check();await page.locator('#session-name').fill('Snapshot fidelity fixture');await createIn(page,'chat');await until(async()=>(await state()).sessions.length===1,'One synthetic session');id=(await state()).sessions[0].id;
 const draft='Positive unsent snapshot draft';await page.locator('#message-input').fill(draft);await until(async()=>(await state()).sessions[0].liveDraft===draft,'Private draft persisted');await page.locator('#terminal-tab').click();await until(async()=>(await fixture('stats')).counts.snapshots.length>=1,'Initial real canonical snapshot');await nativeRows().waitFor();
 const uri='https://example.invalid/hidden-link',input='\x1b7\x1b]8;;'+uri+'\x1b\\B\x1b8';await fixture('output',input);await until(async()=>(await nativeRows().innerText()).includes('B'),'Live native bytes read');
 original=(await state()).sessions[0];const seed=await fixture('stats');assert.equal(seed.state.pen.active,false);assert.equal(seed.state.pen.uri,uri);await capture('01-before-reopen');checks.push('native VT creates hidden link without private pen mutation');
 await app.close();app=null;assert.equal(child.exitCode,null);assert.deepEqual((await state()).sessions.map(s=>[s.id,s.nativeId,s.owner,s.liveDraft]),[[original.id,original.nativeId,original.owner,draft]]);checks.push('own frontend close preserves service, identity, owner and draft');
 await launch();
 if(diagnostic){
   await page.addInitScript(()=>{
     let value;
     Object.defineProperty(globalThis,'nativeWorkspaceTerminalContinuation',{configurable:true,get(){return value;},set(api){
       globalThis.__t79DiagnosticAssignments=(globalThis.__t79DiagnosticAssignments||0)+1;
       value={...api,restore(term,state){const result=api.restore(term,state);globalThis.__t79Receiver=term;globalThis.__t79ReceivedState=state;globalThis.__t79DiagnosticRestoreCount=(globalThis.__t79DiagnosticRestoreCount||0)+1;return result;}};
     }});
   });
   await page.reload({waitUntil:'domcontentloaded'});await page.locator('#new-session').waitFor();
 }
 await until(async()=>(await fixture('stats')).counts.snapshots.length>=(diagnostic?3:2),'Reopen obtains paired snapshot');await nativeRows().waitFor();await until(async()=>(await nativeRows().innerText()).includes('B'),'Replayed B visible');
 await page.evaluate(()=>{window.__t79Links={confirm:0,open:0,urls:[]};window.confirm=message=>{if(!message.includes('https://example.invalid/hidden-link'))throw Error('Unexpected native link confirmation');window.__t79Links.confirm++;return true;};window.open=()=>{window.__t79Links.open++;return {opener:null,location:{set href(uri){window.__t79Links.urls.push(uri);}}};};});
 await fixture('output','C');await until(async()=>(await nativeRows().innerText()).includes('C'),'Plain continued C visible');const plain=await charPoint('C');await page.mouse.move(plain.x,plain.y);await delay(120);await page.mouse.click(plain.x,plain.y);assert.deepEqual(await page.evaluate(()=>window.__t79Links),{confirm:0,open:0,urls:[]});await capture('02-plain-stays-unlinked',{plain});checks.push('plain continued C is not turned into a link');
 await fixture('output','\x1b[4mD');await until(async()=>(await nativeRows().innerText()).includes('D'),'Native underline revival visible');const linked=await charPoint('D');await page.mouse.move(linked.x,linked.y);
 if(diagnostic){
   await delay(150);
   const receiver=await page.evaluate(point=>{
     const t=globalThis.__t79Receiver,c=t?._core,p=c?._inputHandler?._curAttrData,l=c?.linkifier;
     const cells=t?[0,1,2].map(x=>{const cell=t.buffer.active.getLine(0).getCell(x),id=cell.hasExtendedAttrs()?cell.extended.urlId:0;return {x,text:cell.getChars(),id,uri:c._oscLinkService.getLinkData(id)?.uri||null};}):null;
     return {helperAssignments:globalThis.__t79DiagnosticAssignments||0,restores:globalThis.__t79DiagnosticRestoreCount||0,stateVersion:globalThis.__t79ReceivedState?.version,cells,pen:p?{id:p.extended.urlId,active:Boolean(p.hasExtendedAttrs()),data:c._oscLinkService.getLinkData(p.extended.urlId)||null}:null,pointer:{point,element:document.elementFromPoint(point.x,point.y)?.className},linkifier:l?{last:l._lastBufferCell,activeLine:l._activeLine,current:l._currentLink?.link.text||null,replies:Array.from(l._activeProviderReplies||[],([id,links])=>({id,links:links?.map(v=>({text:v.link.text,range:v.link.range}))}))}:null};
   },linked);
   const receivedFrame=await page.evaluate(id=>workspace.terminalSnapshot(id),id);
   await capture('03-diagnostic-not-acceptance',{receiver,linked,receivedFrameSummary:{keys:Object.keys(receivedFrame),continuationVersion:receivedFrame.continuation?.version,cols:receivedFrame.cols,rows:receivedFrame.rows}});
   checks.push('READONLY_DIAGNOSTIC_ONLY_NOT_FULL_ACCEPTANCE');
   assert.deepEqual((await fixture('stats')).counts.inputs,[]);return;
 }
 await until(()=>page.locator(`[data-terminal-id="${id}"] .xterm-screen`).evaluate(el=>el.classList.contains('xterm-cursor-pointer')),'Actual hyperlink hover');await page.mouse.click(linked.x,linked.y);await until(async()=>(await page.evaluate(()=>window.__t79Links.urls)).length===1,'Native hyperlink activation');assert.deepEqual(await page.evaluate(()=>window.__t79Links.urls),[uri]);await capture('03-link-address-retained',{linked,linkActivation:await page.evaluate(()=>window.__t79Links)});checks.push('later native SGR revives exact hyperlink through actual DOM hover/click, system opening intercepted');
 const after=(await state()).sessions[0],stats=await fixture('stats');assert.deepEqual([after.id,after.nativeId,after.owner,after.liveDraft],[original.id,original.nativeId,original.owner,draft]);assert.equal(stats.counts.fakeWorkers,1);assert.deepEqual(stats.counts.inputs,[]);assert.ok(stats.counts.snapshots.length>=2);assert.ok(stats.counts.snapshots.every(s=>s.continuationVersion===1));assert.ok(stats.counts.serializations.every(s=>s.sourceCommands===0));assert.equal((await state()).diagnostics.dispatches,0);assert.deepEqual(await app.evaluate(()=>globalThis.t79Guards),{clipboard:0,external:0,dialogs:0});assert.deepEqual(errors,[]);checks.push('same source and view identities/draft, zero provider dispatch/input/OS operations');await capture('04-complete');
}
let timer;Promise.race([run(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Bounded source GUI timeout; no retry')),plan.activeMs);})]).catch(async error=>{failure=error.stack;process.exitCode=1;try{if(page&&!page.isClosed())await capture('failure');}catch{}console.error(failure);}).finally(async()=>{
 clearTimeout(timer);stopped=true;let cleaned=false;
 try{if(app)await app.close();if(client){const s=await state();for(const r of s.sessions)if(!['ended','unavailable'].includes(r.state))await client.call('stop',r.id);if(id)finalCounts=(await fixture('stats')).counts;await client.call('shutdown');client.close();}if(child?.connected)child.disconnect();await scratch.release();if(profile)assert.equal(fs.existsSync(profile),false);if(frozen)assert.deepEqual(hashes(),frozen);cleaned=true;}catch(error){process.exitCode=1;failure=failure||error.stack;console.error('Exact owned cleanup failed:',error.stack);}
 if(lease&&cleaned){assert.equal(JSON.parse(fs.readFileSync(path.join(slot,'owner.json'))).token,token);fs.unlinkSync(path.join(slot,'owner.json'));fs.rmdirSync(slot);lease=false;fs.writeFileSync(path.join(evidence,'released.json'),JSON.stringify({...owner,releasedAt:new Date().toISOString(),profileGone:true,guiPIDs:launched,daemonPID:child?.pid},null,2));}
 if(evidence&&fs.existsSync(evidence)){fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({plan,diagnosticOnly:diagnostic,checks,errors,failure:failure||null,sourceHashes:frozen,sourceUnchanged:cleaned,ownedCleanup:cleaned,leaseReleased:!lease,profile,guiPIDs:launched,daemonPID:child?.pid,finalCounts},null,2));}
 console.log(JSON.stringify({checks:checks.length,failure:failure||null,ownedCleanup:cleaned,leaseReleased:!lease,finalCounts}));
});
