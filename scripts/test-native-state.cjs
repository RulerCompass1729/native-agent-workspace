const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// Actual Electron, IPC and workspace with controlled native observations.
// Model/runtime integration is checked separately; this runner uses no provider.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {fork}=testScratch.childProcess,{_electron}=testScratch.playwright(require('playwright'));
const root=path.resolve(__dirname,'..'),code=process.env.NAW_TEST_APP_ROOT||root;
const {connect}=require(path.join(code,'app/service-client.cjs'));
const profile=testScratch.directory(path.join(os.tmpdir(),'naw-native-state-'));
const child=fork(path.join(code,'app/daemon.cjs'),[profile],{execArgv:['--require',path.join(__dirname,'fixtures/loading-terminal.cjs')],env:{...process.env,NAW_APP_VERSION:require(path.join(code,'package.json')).version,NAW_WORKSPACE:profile,NAW_TEST_APP_ROOT:code},stdio:['ignore','ignore','inherit','ipc']});
let app,page,client,sequence=0;const errors=[],checks=[],delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(let i=0;i<160;i++){if(await fn())return;await delay(50);}throw Error(label);}
function fixture(method,target,value){const id=++sequence;return new Promise((resolve,reject)=>{const cb=m=>{if(m.requestId===id){clearTimeout(timer);child.off('message',cb);resolve(m);}};const timer=setTimeout(()=>{child.off('message',cb);reject(Error('Fixture timeout'));},8000);child.on('message',cb);child.send({id,method,target,value});});}
const snapshot=()=>page.evaluate(()=>workspace.initial());
async function launch(){app=await _electron.launch({executablePath:process.env.NAW_APP_EXECUTABLE||require('electron'),args:process.env.NAW_APP_EXECUTABLE?[]:[root],env:{...process.env,NAW_DATA_DIR:profile,NAW_TEST_PARENT_PID:String(process.pid)},timeout:70000});page=await app.firstWindow();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));await page.locator('#new-session').waitFor();}
async function create(provider,name){await page.locator('#new-session').click();await page.locator(`input[name="provider"][value="${provider}"]`).check();await page.locator('#session-name').fill(name);await createIn(page, 'chat');await until(async()=>(await snapshot()).sessions.some(s=>s.name===name&&s.state==='idle'),'Created');return (await snapshot()).sessions.find(s=>s.name===name).id;}
async function capture(name){if(process.env.NAW_EVIDENCE_DIR){fs.mkdirSync(process.env.NAW_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.NAW_EVIDENCE_DIR,name+'.png')});}}
async function run(){
 await until(()=>fs.existsSync(path.join(profile,'connection.json')),'Service');client=await connect(profile,'state-observer');await launch();
 const a=await create('claude','Claude state');
 await fixture('native-activity',a,{turnId:'turn-a',label:'正在请求',phase:'requesting'});
 await page.locator('#native-phase').getByText('Claude state · 正在请求',{exact:true}).waitFor();
 await page.locator('#message-input').fill('尚未发送的下一条草稿');
 await fixture('native-activity',a,{turnId:'turn-a',label:'思考中',phase:'thinking'});
 await page.locator('#native-phase').getByText('Claude state · 思考中',{exact:true}).waitFor();
 assert.equal(await page.locator('#messages .assistant').count(),0,'A live phase is visible before assistant text');
 await page.locator('#terminal-tab').click();await until(async()=>(await fixture('stats')).pending.includes(a),'Native surface pending');await fixture('release',a);
 await page.locator('#terminal-area .xterm-screen').waitFor();assert.equal(await page.locator('#native-activity').isVisible(),true,'Native input focus does not hide the reader phase');
 await fixture('native-activity',a,{turnId:'turn-a',label:'Bash',phase:'approval'});
 const permission={nativeOnly:true,requests:[{id:'permission:1',title:'Bash',input:'{"command":"check-document"}'}]};
 await fixture('native-permission',a,permission);
 await page.locator('#approval').getByText('Claude state',{exact:true}).waitFor();
 await page.locator('#native-phase').getByText('Claude state · Bash',{exact:true}).waitFor();
 assert.equal(await page.locator('#approval pre').innerText(),'{'+'"command":"check-document"}');
 assert.equal(await page.locator('#approval button').count(),1,'No fabricated native permission decisions');
 const requestBody=await page.locator('#approval pre').elementHandle();
 const observedAt=Date.now();await fixture('native-permission',a,{...permission,observedAt});
 await until(async()=>(await snapshot()).sessions.find(s=>s.id===a).nativeApproval.observedAt===observedAt,'Fresh observer heartbeat');await page.waitForTimeout(100);
 assert.equal(await requestBody.evaluate(el=>el.isConnected),true,'Observer heartbeat must not replace the readable request or focused action');
 assert.equal(await page.locator('#message-input').inputValue(),'尚未发送的下一条草稿');
 await capture('solo-native-permission');
 await fixture('native-permission',a,null);await fixture('native-activity',a,{turnId:'turn-a',label:'正在输出',phase:'responding'});
 await page.locator('#approval').waitFor({state:'hidden'});await page.locator('#native-phase').getByText('Claude state · 正在输出',{exact:true}).waitFor();
 await fixture('native-activity',a,null);await page.locator('#native-activity').waitFor({state:'hidden'});
 checks.push('Before-text/request/thinking/response/end phases; native focus and unsent draft remain independent; exact private permission body with native handling');
 await page.getByRole('button',{name:'加入协作',exact:true}).click();
 const b=await create('codex','Other member');
 await fixture('native-activity',b,{turnId:'codex-clock',label:'inProgress'});
 await page.locator('#native-phase').getByText('Other member · 工作中',{exact:true}).waitFor();
 assert.equal(await page.locator('#native-elapsed').innerText(),'','Unknown native start time does not become an enqueue clock');
 await fixture('native-activity',b,{turnId:'codex-clock',label:'inProgress',startedAt:Date.now()-2000});
 await until(async()=>/已用 \d+ 秒/.test(await page.locator('#native-elapsed').innerText()),'Known native start time permits elapsed display');
 await fixture('native-activity',b,{turnId:'codex-clock',label:'inProgress'});
 await until(async()=>(await page.locator('#native-elapsed').innerText())==='','Losing native time removes the clock rather than retaining an earlier value');
 await fixture('native-activity',b,null);await page.locator('#native-activity').waitFor({state:'hidden'});
 checks.push('Codex running clock is absent for unknown native time, follows a reported start, disappears again when unknown, and hides after native idle');
 await page.getByRole('button',{name:'加入协作',exact:true}).click();
 await page.locator('#room-nav').click();
 const {chooseRecipient,fillRoomMessage}=require('./room-input.cjs');await chooseRecipient(page,a);await fillRoomMessage(page,'Check one document.');await page.locator('#forward-button').click();
 await fixture('replyBound',a,{turnId:'shared-turn',promptId:'shared-prompt'});
 await fixture('native-activity',a,{turnId:'shared-turn',label:'思考中',phase:'thinking'});
 await page.locator('#run-status').getByText('Claude state · 思考中',{exact:false}).waitFor();
 await fixture('nativeBlock',a,{id:'response:shared',kind:'response',turnId:'shared-turn',promptId:'shared-prompt',text:'Public partial',status:'streaming'});
 await fixture('native-permission',a,permission);
 await page.locator('#approval').getByText('Claude state',{exact:true}).waitFor();
 assert.equal(await page.locator('#room-messages').isVisible(),true);
 assert.ok(!(await snapshot()).room.messages.some(m=>m.text.includes('check-document')),'Permission arguments never become room messages');
 await page.locator('#approval').getByRole('button',{name:'在 Claude state 的原生终端处理',exact:true}).click();
 assert.match(await page.locator('#native-pane-title').innerText(),/Claude state/);
 await fixture('native-permission',a,null);await fixture('native-activity',a,{turnId:'shared-turn',label:'PRIVATE PHASE',phase:'thinking'});
 await fixture('nativeBlock',a,{id:'response:shared',kind:'response',turnId:'shared-turn',promptId:'shared-prompt',text:'PRIVATE AFTER PERMISSION',status:'streaming'});
 assert.ok(!(await page.locator('#run-status').innerText()).includes('PRIVATE PHASE'));
 assert.ok(!(await snapshot()).room.messages.some(m=>m.text.includes('PRIVATE AFTER PERMISSION')));
 await capture('room-native-permission');
 checks.push('Room permission is locally visible even before choosing a member; native action selects the right TUI; revoked grant never resumes phase or reply sharing');
 await fixture('native-activity',a,null);assert.equal((await fixture('stats')).sends.length,1);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({checks,errors,providerCalls:0,dispatches:1,profile},null,2));
}
run().catch(async e=>{console.error(e.stack);if(page&&!page.isClosed())await capture('failed');process.exitCode=1;}).finally(testScratch.cleanup(async()=>{if(app)await app.close();if(client){for(const s of(await client.call('initial')).sessions)await client.call('stop',s.id);await client.call('shutdown');client.close();}if(child.connected)child.disconnect();}));
