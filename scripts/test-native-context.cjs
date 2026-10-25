const testScratch = require('./fixtures/test-scratch.cjs');
const { chooseRecipient: inlineRecipient, fillRoomMessage, roomBody } = require('./room-input.cjs');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {fork}=testScratch.childProcess,{_electron}=testScratch.playwright(require('playwright'));
const root=path.resolve(__dirname,'..'),code=process.env.NAW_TEST_APP_ROOT||root,{connect}=require(path.join(code,'app/service-client.cjs'));
const profile=testScratch.directory(path.join(os.tmpdir(),'naw-context-ui-')),evidence=process.env.NAW_EVIDENCE_DIR;
if(evidence)fs.mkdirSync(evidence,{recursive:true,mode:0o700});
const child=fork(path.join(code,'app/daemon.cjs'),[profile],{execArgv:['--require',path.join(__dirname,'fixtures/context-native.cjs')],env:{...process.env,NAW_APP_VERSION:require(path.join(code,'package.json')).version,NAW_WORKSPACE:profile,NAW_TEST_APP_ROOT:code},stdio:['ignore','ignore','inherit','ipc']});
let app,page,client,seq=0;const checks=[],errors=[],delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(let i=0;i<160;i++){if(await fn())return;await delay(50)}throw Error(label)}
function fixture(method,extra={}){const id=++seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.off('message',cb);reject(Error('Fixture timeout'))},8000);const cb=m=>{if(m.requestId===id){clearTimeout(timer);child.off('message',cb);m.error?reject(Error(m.error)):resolve(m)}};child.on('message',cb);child.send({id,method,...extra})})}
const snapshot=()=>client.call('initial'),shot=async name=>{if(evidence)await page.screenshot({path:path.join(evidence,name+'.png')})};
async function launch(){app=await _electron.launch({executablePath:process.env.NAW_APP_EXECUTABLE||require('electron'),args:process.env.NAW_APP_EXECUTABLE?[]:[root],env:{...process.env,NAW_DATA_DIR:profile,NAW_TEST_PARENT_PID:String(process.pid)},timeout:70000});page=await app.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));await page.locator('#new-session').waitFor();assert.deepEqual(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>({visible:w.isVisible(),focusable:w.isFocusable()}))),[{visible:false,focusable:false}]);}
(async()=>{
 console.log('Profile:',profile);await until(()=>fs.existsSync(path.join(profile,'connection.json')),'Daemon');client=await connect(profile,'context-observer');await launch();
 await page.locator('#new-session').click();await page.locator('input[name="provider"][value="claude"]').check();await page.locator('#initial-view').selectOption('chat');await page.locator('#session-name').fill('学习助手');await page.locator('#confirm-create').click();
 await until(async()=>(await snapshot()).sessions[0]?.state==='idle','Ready');const original=(await snapshot()).sessions[0],id=original.id;
 await fixture('reply',{target:id,text:'清空前保留的私人结果。'});await page.locator('#messages').getByText('清空前保留的私人结果。',{exact:true}).waitFor();
 await page.locator('#message-input').fill('尚未发送的中文材料');await page.getByRole('button',{name:'加入协作',exact:true}).click();
 await fixture('clear',{target:id});await until(async()=>(await page.evaluate(()=>workspace.initial())).sessions[0].nativeId!==original.nativeId,'New root visible');
 assert.equal(await page.locator('#message-input').inputValue(),'尚未发送的中文材料');assert.equal(await page.locator('#send-button').isEnabled(),true);assert.equal((await snapshot()).sessions[0].nativeContexts.length,1);
 await page.locator('#messages').getByText('清空前保留的私人结果。',{exact:true}).waitFor();await page.locator('#messages').getByText('原生上下文',{exact:true}).waitFor();await shot('clear-retains-history-draft');
 checks.push('Clear keeps the same row, original result, draft, membership and explicit context boundary; new GUI submission is available');
 for(const outcome of ['resolve','reject']){
  const text='等待接收期间清空 · '+outcome;await page.locator('#message-input').fill(text);await fixture('hold');const count=(await fixture('stats')).sends.length;await page.locator('#message-input').press('Enter');await until(async()=>(await fixture('stats')).sends.length===count+1,'Held send');
  await fixture('clear',{target:id});await fixture(outcome);await delay(200);
  assert.equal(await page.locator('#message-input').inputValue(),text);assert.equal((await snapshot()).sessions[0].liveDraft,text);assert.equal(await page.locator('#send-button').isEnabled(),true);await shot('late-'+outcome);
  checks.push('Pending draft survives clear and late native '+outcome+' without automatic replay');
 }
 await page.locator('#new-session').click();await page.locator('input[name="provider"][value="claude"]').check();await page.locator('#initial-view').selectOption('chat');await page.locator('#session-name').fill('复核助手');await page.locator('#confirm-create').click();
 await page.getByRole('button',{name:'加入协作',exact:true}).click();await page.locator('#room-nav').click();await page.locator('#room-record').click();
 await inlineRecipient(page, id);const material='保留共同核查材料';await fillRoomMessage(page, material);
 await fixture('hold');await page.locator('#room-advanced summary').click();await page.locator('#run-button').click();await page.locator('#run-limit').selectOption('2');await page.locator('#run-consent').check();await page.locator('#confirm-run').click();
 await until(async()=>(await fixture('stats')).sends.length===3,'Run waits for first native acceptance');await fixture('clear',{target:id});await fixture('resolve');await delay(200);
 assert.equal(await roomBody(page),material);assert.equal((await snapshot()).room.run.status,'paused');assert.equal((await fixture('stats')).sends.length,3);await shot('clear-pending-shared-material');
 checks.push('A root clear while the first shared reply awaits acceptance preserves task material and prevents the next handoff');
 const before=(await snapshot()).sessions[0];assert.equal(before.nativeContexts.length,4);assert.equal((await fixture('stats')).sends.length,3);
 await app.close();app=null;await launch();await page.locator(`[data-session-id="${id}"]`).click();await page.locator('#chat-tab').click();
 const after=(await snapshot()).sessions[0];assert.equal(after.nativeId,before.nativeId);assert.deepEqual(after.nativeContexts,before.nativeContexts);assert.deepEqual(after.messages,before.messages);assert.equal(await page.locator('#message-input').inputValue(),before.liveDraft);assert.equal((await fixture('stats')).sends.length,3);
 checks.push('UI reopen preserves exact context history, current native identity and draft with no dispatch');assert.deepEqual(errors,[]);checks.forEach(c=>console.log('PASS',c));console.log(JSON.stringify({checks:checks.length,syntheticSubmissions:3,modelCalls:0,errors}));
})().catch(async e=>{console.error(e.stack);await shot('failure').catch(()=>{});process.exitCode=1}).finally(testScratch.cleanup(async()=>{if(app)await app.close().catch(()=>{});if(client){try{for(const s of(await snapshot()).sessions)await client.call('stop',s.id);await client.call('shutdown')}catch{}client.close()}if(child.exitCode===null&&!child.signalCode)child.kill('SIGTERM')}));
