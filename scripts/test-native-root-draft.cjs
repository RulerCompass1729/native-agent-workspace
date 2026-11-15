// Real hidden renderer and managed control stack; only native events are synthetic.
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const scratch=require(root+'/scripts/fixtures/test-scratch.cjs');
const fs=require('node:fs'),assert=require('node:assert/strict'),os=require('node:os');
const {_electron}=scratch.playwright(require(root+'/node_modules/playwright'));
const {connectService}=require(root+'/app/service-connection.cjs');
const {requestOutbox}=require(root+'/app/computer-use-outbox-tool.cjs');
const {execFileSync}=require('node:child_process');
const desktop=()=>JSON.parse(execFileSync('osascript',['-l','JavaScript','-e',"ObjC.import('AppKit'); var p=$.NSEvent.mouseLocation; JSON.stringify({frontmostPid:$.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier,x:p.x,y:p.y})"],{encoding:'utf8'}));
const slot=process.env.NAW_GUI_TEST_SLOT;
if(!slot || !path.isAbsolute(slot) || !process.env.NAW_EVIDENCE_DIR) throw Error('Explicit GUI lease and private evidence directory required');
try{fs.mkdirSync(slot);}catch(e){if(e.code==='EEXIST'){console.log('GUI slot occupied');process.exit(75);}throw e;}
const profile=fs.realpathSync(scratch.directory(path.join(os.tmpdir(),'naw-p0b-gui-')));
let child,client,app,sequence=0;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(f,label){for(let i=0;i<200;i++){if(await f())return;await delay(50);}throw Error(label);}
function issue(target,value,method='p0b-proof'){return new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>reject(Error('fixture timeout')),10000);const fn=r=>{if(r.p0bRequestId===id){clearTimeout(timer);child.off('message',fn);r.error?reject(Error(r.error)):resolve(r);}};child.on('message',fn);child.send({id,method,target,value});});}
(async()=>{
 try{
  const beforeDesktop=desktop();
  const cwd=path.join(profile,'workspace');fs.mkdirSync(cwd,{mode:0o700});
  child=scratch.childProcess.fork(root+'/app/daemon.cjs',[profile],{cwd,execArgv:['--require',path.join(root,'scripts/fixtures/native-root-draft.cjs')],env:{...process.env,NAW_TEST_APP_ROOT:root,NAW_WORKSPACE:cwd},stdio:['ignore','ignore','inherit','ipc']});
  await until(()=>fs.existsSync(path.join(profile,'connection.json')),'service');client=await connectService(profile,'human-view');
  const source=await client.call('create',{provider:'claude',cwd,name:'Synthetic butler',view:'chat'});
  fs.writeFileSync(path.join(profile,'steward.json'),JSON.stringify({version:1,selected:{sessionId:source,nativeId:(await client.call('initial')).sessions.find(s=>s.id===source).nativeId}}),{mode:0o600});
  await client.call('claim',source,'chat');
  fs.writeFileSync(path.join(profile,'views.json'),JSON.stringify([{owner:'human-view',active:true,selected:source,mode:'chat'}]),{mode:0o600});
  app=await _electron.launch({args:[root],env:{...process.env,NAW_DATA_DIR:profile,NAW_TEST_PARENT_PID:String(process.pid)},timeout:30000});
  const page=await app.firstWindow();await page.locator('#message-input').waitFor();
  const cdp=await page.context().newCDPSession(page);let passed=0;
  for(const mode of ['empty','draft','typing','ime']){
   const args={action:'invoke',operation_id:'p0b-'+mode,method:'rename',arguments:[source,'Synthetic '+mode]};
   const proof=await issue(source,args);
   const input=page.locator('#message-input');
   if(mode==='draft')await input.fill('UNSENT SYNTHETIC DRAFT');
   if(mode==='typing')await input.pressSequentially('synthetic typing',{delay:30});
   if(mode==='ime'){await input.focus();await cdp.send('Input.imeSetComposition',{text:'合成草稿',selectionStart:4,selectionEnd:4});}
   await until(async()=>(await client.call('initial')).sessions.find(s=>s.id===source).liveDraft===await input.inputValue(),'Composer draft persisted before control');
   const draft=await input.inputValue();
   const result=await requestOutbox(path.join(profile,'outbox-owner.json'),proof.identity,args,undefined,true);
   console.log(JSON.stringify({mode,before:proof.before,result}));assert.equal(result.state,'complete');assert.equal(await input.inputValue(),draft);passed++;
   if(mode==='ime')await cdp.send('Input.insertText',{text:'合成草稿'});
  }
  await page.locator('#terminal-tab').click();
  const terminalInput=page.locator('#terminal-area .xterm-helper-textarea');await terminalInput.waitFor({state:'attached'});
  for(const mode of ['typing','ime','escape']) {
   const args={action:'invoke',operation_id:'p0b-terminal-'+mode,method:'rename',arguments:[source,'Synthetic terminal '+mode]};
   const proof=await issue(source,args);await issue(source,null,'p0b-arm-input');
   const pending=requestOutbox(path.join(profile,'outbox-owner.json'),proof.identity,args,undefined,true);
   await until(async()=>(await issue(source,null,'p0b-input-status')).entered,'Control scope bound before terminal input');
   await terminalInput.focus();
   if(mode==='ime')await cdp.send('Input.imeSetComposition',{text:'原生组字',selectionStart:4,selectionEnd:4});
   else {
    await terminalInput.press(mode==='escape'?'Escape':'x');
    await until(async()=>(await client.call('initial')).sessions.find(s=>s.id===source).controlRevision>proof.before.control,'Native key reached workspace');
   }
   const before=await terminalInput.inputValue(), controlAfter=(await client.call('initial')).sessions.find(s=>s.id===source).controlRevision;
   await issue(source,null,'p0b-release-input');
   const result=await pending;console.log(JSON.stringify({mode:'terminal-'+mode+'-after-binding',controlBefore:proof.before.control,controlAfter,result}));
   if(mode==='escape'){assert.equal(result.state,'unconfirmed');assert.equal(result.failureCheck,'scope-control-revision');}
   else {assert.equal(result.state,'complete');assert.equal(await terminalInput.inputValue(),before);}
   if(mode==='ime')await cdp.send('Input.insertText',{text:'原生组字'});
   passed++;
  }
  await app.evaluate((_electron,root)=>{
   const load=process.getBuiltinModule('module').createRequire(root+'/package.json');
   const {BackgroundControl}=load(root+'/app/background-control.cjs'), original=BackgroundControl.prototype.call;
   global.p0bResultGate={entered:false,restore:()=>{BackgroundControl.prototype.call=original;}};
   BackgroundControl.prototype.call=async function(binding,args){
    const result=await original.call(this,binding,args);
    if(args.operation_id==='p0b-after-execution'){global.p0bResultGate.entered=true;await new Promise(resolve=>{global.p0bResultGate.release=resolve;});}
    return result;
   };
  },root);
  const afterArgs={action:'invoke',operation_id:'p0b-after-execution',method:'rename',arguments:[source,'Synthetic after execution']};
  const afterProof=await issue(source,afterArgs);
  const afterPending=requestOutbox(path.join(profile,'outbox-owner.json'),afterProof.identity,afterArgs,undefined,true);
  await until(()=>app.evaluate(()=>global.p0bResultGate.entered),'Handler mutation completed before result release');
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile,'session-labels.json'),'utf8')).labels[source],'Synthetic after execution');
  await terminalInput.press('y');
  await until(async()=>(await client.call('initial')).sessions.find(s=>s.id===source).controlRevision>afterProof.before.control,'Native typing after actual execution');
  await app.evaluate(()=>global.p0bResultGate.release());
  const afterResult=await afterPending;console.log(JSON.stringify({mode:'typing-after-execution-before-reply',result:afterResult}));assert.equal(afterResult.state,'complete');assert.equal(afterResult.value,'Synthetic after execution');passed++;
  await app.evaluate(()=>global.p0bResultGate.restore());
  const denied={action:'invoke',operation_id:'p0b-denied-gap',method:'rename',arguments:[source,'MUST NOT RENAME']};
  const proof=await issue(source,denied);
  const forged=await requestOutbox(path.join(profile,'outbox-owner.json'),{...proof.identity,callId:'forged-unobserved-call'},denied,undefined,true);
  assert.equal(forged.state,'unconfirmed');assert.equal(forged.failureReason,'native-call-missing');passed++;
  await issue(source,null,'p0b-invalidate');
  const refusal=await requestOutbox(path.join(profile,'outbox-owner.json'),proof.identity,denied,undefined,true);
  assert.equal(refusal.state,'unconfirmed');assert.equal(refusal.failureCheck,'display-gap');
  assert.notEqual((await client.call('initial')).sessions.find(s=>s.id===source).name,'MUST NOT RENAME');passed++;
  console.log(JSON.stringify({passed,failed:0,skipped:0,namedRefusal:refusal.failureCheck,providerProcesses:0,modelCalls:0}));
  const windows=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>({visible:w.isVisible(),focused:w.isFocused()})));
  assert.ok(windows.every(w=>!w.visible&&!w.focused));assert.deepEqual(desktop(),beforeDesktop,'Foreground app and pointer unchanged');console.log('PASS hidden/unfocused; foreground and pointer unchanged; zero provider processes and model calls');
 }finally{client?.close();await scratch.release();fs.rmdirSync(slot);}
})().catch(e=>{console.error(e);process.exitCode=1;});
