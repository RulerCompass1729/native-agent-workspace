// Real native AX and AXPress in one disposable NAW window; no provider/model.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const root=path.resolve(__dirname,'..'),scratch=require('./fixtures/test-scratch.cjs'),{_electron}=scratch.playwright(require('playwright'));
const {prepareComputerUse,createComputerUseGate}=require('../app/native-computer-use.cjs'),{processIdentity}=require('../app/platform.cjs');
const evidence=process.env.NAW_EVIDENCE_DIR,slot=process.env.NAW_GUI_SLOT,pictures=process.env.NAW_SCREENSHOTS_DIR;
assert(evidence&&slot&&pictures,'Explicit private evidence, pictures and canonical GUI slot are required');
fs.mkdirSync(evidence,{recursive:true,mode:0o700});fs.mkdirSync(pictures,{recursive:true,mode:0o700});
const token=randomUUID(),checks=[];let app,page,peer,bridge,profile,claimed=false,failure;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function check(name,pass){checks.push({name,pass:!!pass});console.log(`${pass?'PASS':'FAIL'} ${name}`);assert(pass,name);}
function save(name,result){
 const content=result?.content?.map((b,i)=>{if(b.type!=='image')return b;const file=path.join(pictures,`${name}-${i}.png`);fs.writeFileSync(file,Buffer.from(b.data,'base64'));return {type:'image',mimeType:b.mimeType,file};});
 fs.writeFileSync(path.join(evidence,name+'.json'),JSON.stringify(content?{...result,content}:result,null,2));
}
async function run(){
 fs.mkdirSync(slot);claimed=true;fs.writeFileSync(path.join(slot,'owner.json'),JSON.stringify({owner:'NAW AX test',task:'isolated native accessibility',pid:process.pid,token}));
 const config=prepareComputerUse();
 profile=scratch.directory(path.join(os.tmpdir(),'naw-ax-test-'));const work=path.join(profile,'work'),home=path.join(profile,'home');fs.mkdirSync(work);fs.mkdirSync(home);
 const env={...process.env,HOME:home,NAW_TEST_APP_ROOT:root,NAW_WORKSPACE:work,NAW_APP_VERSION:require('../package.json').version};
 scratch.childProcess.fork(path.join(root,'app/daemon.cjs'),[profile],{execArgv:['--require',path.join(__dirname,'fixtures/loading-terminal.cjs')],env,stdio:['ignore','ignore','inherit','ipc']});
 for(let n=0;n<200&&!fs.existsSync(path.join(profile,'connection.json'));n++)await delay(50);
 assert(fs.existsSync(path.join(profile,'connection.json')),'Synthetic service ready');
 app=await _electron.launch({executablePath:require('electron'),args:[root],env:{...env,NAW_DATA_DIR:profile,NAW_TEST_PARENT_PID:String(process.pid),NAW_TEST_VISIBLE:'1'},timeout:60000});
 page=await app.firstWindow();await page.locator('#setup-button').waitFor();
 const win=await app.browserWindow(page);
 // Non-focusable test NSWindows are exposed as AX dialogs and intentionally
 // refused by the bridge. Use normal window semantics, still shown inactive;
 // assert before/after that this owned window never takes focus.
 await win.evaluate(w=>w.setFocusable(true));check('owned window starts inactive',!await win.evaluate(w=>w.isFocused()));
 const cpu=[];
 for(let n=0;n<3;n++){await delay(1000);cpu.push(await app.evaluate(({app})=>app.getAppMetrics().map(m=>({type:m.type,cpu:m.cpu.percentCPUUsage}))));}
 save('idle-cpu',{samples:cpu,note:'Empty synthetic window only; not a production performance claim.'});
 save('features-start',await app.evaluate(({app})=>({enabled:app.isAccessibilitySupportEnabled(),features:app.getAccessibilitySupportFeatures(),force:app.commandLine.getSwitchValue('force-renderer-accessibility')})));
 const pid=app.process().pid,id=await win.evaluate(w=>w.getMediaSourceId()),match=/^window:([0-9]+):/.exec(id);assert(match);const windowId=Number(match[1]);
 save('target',{pid,windowId,profile,focusable:true});
 const {JsonRpcLineTransport}=await import('@deepseek-ai/dsh-sdk-protocol');
 peer=scratch.childProcess.spawn(config.command,config.args,{env:config.env,stdio:['pipe','pipe','inherit']});bridge=new JsonRpcLineTransport(peer.stdout,peer.stdin);bridge.start();
 await bridge.request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'naw-native-ax-test',version:'1'}},AbortSignal.timeout(10000));bridge.notify('notifications/initialized',{});
 const invoke=async p=>{const result=await bridge.request('tools/call',p,AbortSignal.timeout(25000));if(p.name==='click')save('wire-click',{request:p,result});return result;};
 const gate=createComputerUseGate({identity:p=>p===pid?processIdentity(p):null}); // Only this owned source fixture, never another application.
 const request=depth=>({name:'inspect_ui',arguments:{app_target:`PID:${pid}`,window_id:windowId,fresh:true,include_elements:true,max_depth:depth,max_elements:1500,max_children:150}});
 for(const depth of [13,30]){
  const result=await gate(request(depth),invoke);save('inspect-'+depth,result);
  check(`depth ${depth} exposes the unique actionable sidebar Settings button`,result.isError===false&&result._meta?.ui_elements?.filter(e=>e.ax_role==='AXButton'&&e.label==='设置'&&e.is_actionable&&e.is_enabled).length===1);
 }
 const seen=await gate({name:'see',arguments:{app_target:`PID:${pid}`,window_id:windowId,fresh:true,ocr:false,include_elements:true,max_depth:13}},invoke);save('see-13',seen);
 check('fresh see succeeds at the formerly failing depth',seen.isError===false&&seen._meta?.used_cache===false);
 const before=await gate(request(13),invoke),settings=before._meta.ui_elements.filter(e=>e.ax_role==='AXButton'&&e.label==='设置'&&e.is_actionable&&e.is_enabled);assert.equal(settings.length,1);
 const clicked=await gate({name:'click',arguments:{snapshot:before._meta.snapshot_id,pid,on:settings[0].id,expect:{label:'重新检查'}}},invoke);save('click-result',clicked);
 check('one background AXPress satisfies its fresh same-window page postcondition',clicked.isError===false&&clicked.structuredContent?.outcome==='postcondition_observed'&&clicked.structuredContent?.deliveryVerified===false);
 check('the real renderer setup dialog opened',await page.locator('#setup-dialog').isVisible());
 check('owned window remains inactive',!await win.evaluate(w=>w.isFocused()));
 check('synthetic profile has no native session or model task',await page.evaluate(async()=>!(await workspace.initial()).sessions.length));
 save('features',await app.evaluate(({app})=>({enabled:app.isAccessibilitySupportEnabled(),features:app.getAccessibilitySupportFeatures()})));
}
let timer;Promise.race([run(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Native AX test exceeded 120 seconds')),120000);})]).catch(e=>{failure=e.stack;if(!checks.some(c=>!c.pass))checks.push({name:'native workflow completed without protocol failure',pass:false});console.error(failure);process.exitCode=1;}).finally(async()=>{
 clearTimeout(timer);
 try{bridge?.close();peer?.stdin.end();await scratch.release();}catch(e){failure||=e.stack;checks.push({name:'owned resources cleaned',pass:false});console.error('Owned cleanup:',e.stack);process.exitCode=1;}
 if(claimed&&JSON.parse(fs.readFileSync(path.join(slot,'owner.json'))).token===token){fs.unlinkSync(path.join(slot,'owner.json'));fs.rmdirSync(slot);}
 save('result',{checks,pass:checks.filter(x=>x.pass).length,fail:checks.filter(x=>!x.pass).length,failure,modelCalls:0,temporaryProfileRemoved:profile?!fs.existsSync(profile):true});
 console.log(JSON.stringify({pass:checks.filter(x=>x.pass).length,fail:checks.filter(x=>!x.pass).length,skipped:0}));
});
