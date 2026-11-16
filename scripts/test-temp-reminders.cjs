// Real hidden desktop + normal service bootstrap. All files are synthetic and
// below one owned profile/fixture. No provider, model, daily data or daily restart.
const testScratch=require('./fixtures/test-scratch.cjs');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {_electron}=testScratch.playwright(require('playwright'));
const {connect}=require('../app/service-client.cjs');
const {ButlerReadAudit}=require('../app/butler-read-audit.cjs');
const locale=require('../app/ui-locale.js');
const root=path.resolve(__dirname,'..'),base=testScratch.directory(path.join(os.tmpdir(),'naw-temp-reminders-gui-'));
const profile=path.join(base,'profile'),registry=path.join(base,'receipts'),candidates=path.join(base,'candidates');
for(const p of [profile,candidates]) fs.mkdirSync(p,{mode:0o700});
const evidence=process.env.NAW_EVIDENCE_DIR;
if(!evidence) throw Error('Set NAW_EVIDENCE_DIR outside the repository for screenshots');
fs.mkdirSync(evidence,{recursive:true,mode:0o700});
let application,page,client,openFile,checks=0;
async function stop() {
  if(application){await application.close();application=null;}
  if(client){try{await client.call('shutdown');}catch{}client.close();client=null;}
}
const cleanup = testScratch.cleanup(async()=>{if(openFile!==undefined){fs.closeSync(openFile);openFile=undefined;}await stop();});
async function launch() {
  const env={...process.env,NAW_DATA_DIR:profile,NAW_WORKSPACE:path.join(base,'workspace'),NAW_TEMP_REGISTRY_DIR:registry,NAW_TEST_PARENT_PID:String(process.pid),NAW_TEST_UI_LANGUAGE:'zh'};
  for(const key of ['CLAUDE_CODE_CHILD_SESSION','CLAUDECODE','CLAUDE_CODE_SESSION_ID','CLAUDE_CODE_ENTRYPOINT','NAW_RUNTIME_CONFIG','DEEPSEEK_API_KEY','NAW_TEST_BUTLER_ENTRY']) delete env[key];
  application=await _electron.launch({executablePath:require('electron'),args:[root],env,timeout:60000});
  page=await application.firstWindow(); page.setDefaultTimeout(20000);
  await page.locator('#records-button').waitFor({state:'visible'});
  client=await connect(profile,'temp-reminder-gui'); testScratch.ownService(profile);
  assert.equal((await client.call('initial')).sessions.length,0,'No native session has been started');
  if(await page.locator('#setup-dialog').isVisible()) await page.keyboard.press('Escape');
  const visibility=await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>({visible:w.isVisible(),focused:w.isFocused()})));
  assert.ok(visibility.every(w=>!w.visible&&!w.focused),'The owned app is hidden and unfocused');
}
async function shot(name,width=1280) {
  await application.evaluate(({BrowserWindow},w)=>BrowserWindow.getAllWindows().forEach(win=>win.setContentSize(w,860)),width);
  const panel=page.locator('#records-dialog');
  const bounds=await panel.evaluate(el=>{const r=el.getBoundingClientRect();return {right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,clipped:el.scrollWidth>el.clientWidth+2};});
  assert.ok(bounds.right<=bounds.width&&bounds.bottom<=bounds.height&&!bounds.clipped,'No clipped dialog');
  await page.screenshot({path:path.join(evidence,name+'.png'),scale:'css'}); checks++;
}
async function language(value) {
  await page.keyboard.press('Escape');
  await page.locator('#setup-button').click();await page.locator('#setup-dialog').waitFor({state:'visible'});
  await page.locator('#ui-language').selectOption(value);
  const expected=locale.format(value,'sidebar.newSession');
  for(let n=0;n<150;n++) {
    if(await page.locator('#new-session').getAttribute('aria-label')===expected)break;
    if(n===149)throw Error('Interface language did not settle');
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  await page.keyboard.press('Escape');await page.locator('#setup-dialog').waitFor({state:'hidden'});
  await page.locator('#records-button').click();await page.locator('.records-temp').waitFor();
}
async function run() {
  await launch();
  await page.locator('#records-button').click();
  await page.locator('#records-dialog .records-empty').waitFor();
  assert.equal((await page.locator('#records-dialog').innerText()).includes('没有要你看的'),true);
  await shot('01-empty-zh'); await stop();
  // The existing read-log owner writes synthetic records while this isolated
  // service is stopped. They exercise coexistence with the original record bell.
  let clock; const audit=new ButlerReadAudit(profile,{now:()=>clock}),now=Date.now();
  for(let n=32;n>=0;n--){clock=now-n*86400000;audit.recordPage({actor:{sessionId:'fixture-butler',nativeId:'fixture-native',selectionRevision:1,runnerRef:'fixture-runner'},query:{kind:'spaces',spaceId:null,limit:50},result:{count:0,recordRefs:[],scanned:0,truncated:false}});}
  // A separate producer uses the real durable registration, then exits. Its
  // creation journal is absent; the app must read the persisted ownership store.
  const child=spawnSync(process.execPath,[path.join(__dirname,'fixtures/temp-reminder-producer.cjs'),candidates,registry],{encoding:'utf8',env:{...process.env,NODE_OPTIONS:'',NAW_TEST_TEMP_JOURNAL:''}});
  assert.equal(child.status,0,child.stderr); const {dirs,unknown}=JSON.parse(child.stdout);
  await launch(); await page.locator('#records-button').click();
  await page.locator('[data-action="tempClean"]').waitFor();
  assert.equal(await page.locator('#records-badge').innerText(),'2','Two reminder entries, not three directories');
  assert.ok((await page.locator('.records-temp').innerText()).includes('3 个'));
  await shot('02-due-zh'); await shot('02-due-zh-850',850);
  await language('en');
  assert.equal(await page.locator('.records-temp h3').innerText(),'NAW temporary files are ready to clean up');
  await shot('02-due-en');await shot('02-due-en-850',850);
  await language('zh');
  openFile=fs.openSync(path.join(dirs[2],'data'),'r');
  await page.locator('[data-action="tempClean"]').click();
  await page.locator('.records-temp-result h3').filter({hasText:'已清理 2 个目录'}).waitFor();
  assert.equal(fs.existsSync(dirs[0]),false);assert.equal(fs.existsSync(dirs[1]),false);assert.equal(fs.existsSync(dirs[2]),true);assert.equal(fs.existsSync(unknown),true);
  assert.equal(await page.locator('#records-badge').innerText(),'1','Only the record reminder remains');
  assert.ok((await page.locator('.records-temp-result').innerText()).includes('1 个目录正在使用'));
  await shot('03-result-zh');
  fs.closeSync(openFile);openFile=undefined;
  const state=JSON.parse(fs.readFileSync(path.join(profile,'temp-reminders.json'),'utf8'));
  assert.equal(state.reminder.result.cleaned,2);assert.equal(state.reminder.result.skipped,1);
  const snapshot=await page.evaluate(()=>workspace.records('status'));
  assert.equal(snapshot.temp.id,'naw-temp-files');assert.ok(snapshot.temp.version>0);
  assert.equal(JSON.stringify(snapshot.temp).includes(candidates),false,'No paths escape the private snapshot');
  await stop();
  console.log(`PASS isolated app journey: durable producer exit → bell 2 → clean 2 / keep busy 1 → bell 1; unregistered directory kept; screenshots ${checks}; 0 native sessions / 0 model calls.`);
}
run().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(async () => {
  try { await cleanup(); } finally { /* Only the shared owner removes this fixture. */ }
}).catch(error=>{console.error(error.stack);process.exitCode=1;});
