const testScratch = require('./fixtures/test-scratch.cjs');
// Actual hidden Electron/workspace, synthetic native transport. No provider or model call.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { fork } = testScratch.childProcess;
const { _electron } = testScratch.playwright(require('playwright'));
const { chooseRecipient, fillRoomMessage, roomBody } = require('./room-input.cjs');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-pending-actions-'));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/daily-native.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code }, stdio: ['ignore','ignore','inherit','ipc'] });
let app, page, sequence = 0; const errors = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) { for(let i=0;i<200;i++){ if(await fn()) return; await sleep(50); } throw Error(label); }
function fixture(method, target, value) { const id=++sequence; return new Promise((resolve,reject)=>{
  const cb=m=>{if(m.requestId===id){clearTimeout(timer);child.off('message',cb);resolve(m);}};
  const timer=setTimeout(()=>{child.off('message',cb);reject(Error('Fixture timeout'));},10000);
  child.on('message',cb);child.send({id,method,target,value});
}); }
const snapshot = () => page.evaluate(()=>workspace.initial());
async function event(id, message) { const s=(await snapshot()).sessions.find(s=>s.id===id);return fixture('event',id,{...message,params:{threadId:s.nativeId,...message.params}}); }
async function request(id, nativeId, text) { await event(id,{id:nativeId,method:'item/commandExecution/requestApproval',params:{command:text,cwd:'/synthetic',availableDecisions:['accept','decline']}}); }
async function resolved(id, nativeId) { await event(id,{method:'serverRequest/resolved',params:{requestId:nativeId}}); }
async function create(name) {
  await page.locator('#new-session').click();await page.locator('input[name="provider"][value="codex"]').check();
  await page.locator('#initial-view').selectOption('chat');await page.locator('#session-name').fill(name);await page.locator('#confirm-create').click();
  await until(async()=>(await snapshot()).sessions.some(s=>s.name===name&&s.state==='idle'),'Session ready');
  const s=(await snapshot()).sessions.find(s=>s.name===name);await page.getByRole('button',{name:'加入协作',exact:true}).click();return s.id;
}
async function capture(name) { if(process.env.NAW_EVIDENCE_DIR){fs.mkdirSync(process.env.NAW_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.NAW_EVIDENCE_DIR,name+'.png')});} }
(async()=>{
  await until(()=>fs.existsSync(path.join(profile,'connection.json')),'Native fixture ready');
  app=await _electron.launch({executablePath:process.env.NAW_APP_EXECUTABLE||require('electron'),args:process.env.NAW_APP_EXECUTABLE?[]:[root],env:{...process.env,NAW_DATA_DIR:profile,NAW_TEST_PARENT_PID:String(process.pid)},timeout:70000});
  page=await app.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));await page.locator('#new-session').waitFor();
  const a=await create('A'),b=await create('B'),c=await create('C');
  await page.locator('#room-nav').click();await page.locator(`[data-room-session="${a}"]`).click();
  await chooseRecipient(page,c);await fillRoomMessage(page,'Keep this unsent draft for C.');
  await request(b,1,'PRIVATE_B_FIRST');
  await event(b,{id:'1',method:'item/tool/requestUserInput',params:{isBlocking:false,questions:[{id:'choice',header:'PRIVATE_B_QUESTION',question:'Choose?',options:[{label:'One',description:'Synthetic'}]}]}});
  await until(async()=>(await page.locator(`[data-room-session="${b}"]`).innerText()).includes('2 待处理'),'Unselected member pending actions are visible');
  assert.equal(await page.locator('#approval').isVisible(),false,'Unselected private request details stay out of the main room view');
  assert.ok(!(await page.locator('#room-messages').innerText()).includes('PRIVATE_B_'));
  await capture('three-member-pending');
  await page.locator(`[data-room-session="${b}"]`).click();
  await until(async()=>await page.locator('#approval-request option').count()===2,'Two original requests remain available');
  assert.equal((await snapshot()).viewState.roomRecipient,c);assert.equal(await roomBody(page),'Keep this unsent draft for C.');
  // Resolve the latest nonblocking question first: the older permission must reappear.
  await resolved(b,'1');await until(async()=>(await page.locator('#approval').innerText()).includes('PRIVATE_B_FIRST'),'Earlier permission remains after later question resolves');
  assert.ok(!(await page.locator('#approval').innerText()).includes('已处理'));
  await request(b,3,'PRIVATE_B_SECOND');await until(async()=>await page.locator('#approval-request option').count()===2,'Two confirmations are independently selectable');
  const state=await snapshot(),first=state.sessions.find(s=>s.id===b).approvals.find(r=>r.params.command==='PRIVATE_B_FIRST').requestId;
  await page.locator('#approval-request').selectOption(first);await page.locator('#approval').getByRole('button',{name:'允许这一次',exact:true}).click();
  await until(async()=>(await fixture('stats')).decisions.length===1,'Exact first decision reaches native transport');
  await until(()=>page.locator('#approval').getByRole('button',{name:'允许这一次',exact:true}).isDisabled(),'The chosen request waits for its native acknowledgement');
  await resolved(b,1);await until(async()=>(await page.locator('#approval').innerText()).includes('PRIVATE_B_SECOND'),'Second unresolved request remains actionable');
  await page.reload();await page.locator('#new-session').waitFor();
  await until(async()=>(await page.locator('#approval').innerText()).includes('PRIVATE_B_SECOND'),'Pending native request survives renderer reload');
  await page.locator('#approval').getByRole('button',{name:'拒绝',exact:true}).click();
  await until(async()=>(await fixture('stats')).decisions.length===2,'Second decision delivered once');
  await resolved(b,3);await event(b,{method:'thread/status/changed',params:{status:{type:'idle'}}});
  await until(async()=>!(await page.locator(`[data-room-session="${b}"]`).innerText()).includes('待处理'),'Only resolved member cue clears');
  const final=await snapshot(),stats=await fixture('stats');
  assert.deepEqual(stats.decisions,[{id:1,result:{decision:'accept'}},{id:3,result:{decision:'decline'}}]);
  assert.equal(final.viewState.roomRecipient,c);assert.equal(await roomBody(page),'Keep this unsent draft for C.');
  assert.deepEqual(stats.sends,[]);assert.equal(stats.modelCalls,0);assert.deepEqual(errors,[]);
  assert.ok(!JSON.stringify(final.room.messages).includes('PRIVATE_B_'));
  fs.writeFileSync(path.join(profile,'final-evidence.json'),JSON.stringify(final,null,2));await capture('pending-resolved');
  console.log(JSON.stringify({checks:['Three members: view A, address C, find waiting B without publishing its private request','Resolving newer nonblocking question preserves older confirmation; selected request routes exactly once','Pending request survives reload; another resolution clears only itself; recipient and unsent room draft unchanged'],syntheticDecisions:stats.decisions.length,modelCalls:0,evidence:profile,errors}));
})().catch(async e=>{console.error(e.stack,'Evidence:',profile);if(page&&!page.isClosed()){await capture('failed');fs.writeFileSync(path.join(profile,'failure.json'),JSON.stringify(await snapshot(),null,2));fs.writeFileSync(path.join(profile,'failure.txt'),await page.locator('body').innerText());}process.exitCode=1;}).finally(testScratch.cleanup(async()=>{
  if(app)await app.close().catch(()=>{});if(child.connected)child.send({id:++sequence,method:'finish'});
  if(child.exitCode===null)await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGTERM');resolve();},4000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
}));
