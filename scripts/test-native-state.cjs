// Existing three-group native observation journey, isolated source GUI and synthetic providers only.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const plan = { task: 'T33 current native-state source GUI', fullGuiStarts: 1, ownedSyntheticDaemons: 1, syntheticSessions: 2, syntheticSends: 1, terminalInputs: 0, productModels: 0, realProviders: 0, osClipboard: 0, maxRunMs: 300000 };
if (process.argv.includes('--plan')) { console.log(JSON.stringify(plan, null, 2)); process.exit(0); }
assert.equal(process.env.NAW_T33_NATIVE_STATE_GUI_AUTHORIZED, '1', 'Record the finite source GUI plan before running');
assert.ok(!process.env.NAW_APP_EXECUTABLE && path.resolve(code) === root, 'This recipe qualifies source only; Main owns installed acceptance');
const evidence = process.env.NAW_EVIDENCE_DIR;
assert.ok(evidence && path.isAbsolute(evidence), 'Private outside-repository evidence is required');
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.resolve(common, '..', '.local/gui-test-slot.lock'), token = randomUUID();
let existing = evidence;
while (!fs.existsSync(existing)) existing = path.dirname(existing);
const destination = path.resolve(fs.realpathSync(existing), path.relative(existing, evidence));
for (const repo of [fs.realpathSync(root), fs.realpathSync(path.resolve(slot, '../..'))]) assert.ok(destination !== repo && !destination.startsWith(repo + path.sep), 'Evidence must be outside both repositories');
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('OCCUPIED: no profile, daemon or GUI started'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex 3', task: plan.task, token, pid: process.pid, time: new Date().toISOString() }));
const testScratch = require('./fixtures/test-scratch.cjs');
const { fork } = testScratch.childProcess;
const { _electron } = testScratch.playwright(require('playwright'));
const { createIn } = require('./fixtures/create-view.cjs');
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const env = additions => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NAW_') && !key.startsWith('ELECTRON_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(key))), ...additions });
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-native-state-'));
const entry = path.join(profile, 'entry'); fs.mkdirSync(entry);
fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ name: 'naw-owned-native-state-gui', version: require('../package.json').version, main: 'main.cjs' }));
fs.writeFileSync(path.join(entry, 'main.cjs'), `const cp=require('node:child_process'),path=require('node:path'),e=require('electron');
globalThis.stateGuards={clipboard:0,external:0,dialogs:0,maintenance:0,replacement:0};
const spawn=cp.spawn;cp.spawn=function(bin,args,...rest){if(Array.isArray(args)&&args.some(arg=>typeof arg==='string'&&path.basename(arg)==='daemon.cjs')){globalThis.stateGuards.replacement++;throw Error('Replacement backend prohibited');}return spawn.call(this,bin,args,...rest);};
for(const name of ['readText','writeText','readImage','writeImage','read','write','readBuffer','writeBuffer','clear'])e.clipboard[name]=()=>{globalThis.stateGuards.clipboard++;throw Error('OS clipboard prohibited');};
e.shell.openPath=e.shell.openExternal=async()=>{globalThis.stateGuards.external++;throw Error('External action prohibited');};
e.dialog.showOpenDialog=e.dialog.showMessageBox=async()=>{globalThis.stateGuards.dialogs++;throw Error('OS dialog prohibited');};
const {WorkspaceClient}=require(${JSON.stringify(path.join(root, 'app/workspace-client.cjs'))});WorkspaceClient.prototype.maintainService=function(){globalThis.stateGuards.maintenance++;throw Error('Backend update prohibited');};
require(${JSON.stringify(path.join(root, 'app/main.cjs'))});`);
const executablePath = require('electron'), args = [entry];
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')], env: env({ NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code }), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let app,page,client,sequence=0,failure;const guiPids=[],guardSamples=[],started=Date.now();const errors=[],checks=[],delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(let i=0;i<160;i++){if(await fn())return;await delay(50);}throw Error(label);}
function fixture(method,target,value){const id=++sequence;return new Promise((resolve,reject)=>{const cb=m=>{if(m.requestId===id){clearTimeout(timer);child.off('message',cb);resolve(m);}};const timer=setTimeout(()=>{child.off('message',cb);reject(Error('Fixture timeout'));},8000);child.on('message',cb);child.send({id,method,target,value});});}
const snapshot=()=>page.evaluate(()=>workspace.initial());
async function launch(){app=await _electron.launch({executablePath,args,env:env({NAW_DATA_DIR:profile,NAW_TEST_PARENT_PID:String(process.pid)}),timeout:70000});guiPids.push(app.process().pid);page=await app.firstWindow();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));await page.locator('#new-session').waitFor();}
async function create(provider,name){await page.locator('#new-session').click();await page.locator(`input[name="provider"][value="${provider}"]`).check();await page.locator('#session-name').fill(name);await createIn(page, 'chat');await until(async()=>(await snapshot()).sessions.some(s=>s.name===name&&s.state==='idle'),'Created');return (await snapshot()).sessions.find(s=>s.name===name).id;}
async function capture(name){
 if(!page||page.isClosed())return;fs.mkdirSync(evidence,{recursive:true});
 await page.screenshot({path:path.join(evidence,name+'.png')});
 fs.writeFileSync(path.join(evidence,name+'.json'),JSON.stringify(await snapshot(),null,2));
 const ui=await page.evaluate(()=>({phase:document.querySelector('#native-phase').textContent,elapsed:document.querySelector('#native-elapsed').textContent,draft:document.querySelector('#message-input').value,approval:document.querySelector('#approval').innerText,disclosures:[...document.querySelectorAll('#approval details')].map(el=>({className:el.className,open:el.open})),nativeTitle:document.querySelector('#native-pane-title').textContent}));
 fs.writeFileSync(path.join(evidence,name+'.ui.json'),JSON.stringify(ui,null,2));
}
async function join(id){
 const room=(await snapshot()).rooms.find(r=>r.id==='shared');
 await page.locator(`[data-session-menu="${id}"]`).click();
 await page.getByRole('menuitem',{name:`加入「${room.name}」`,exact:true}).click();
 await until(async()=>(await snapshot()).sessions.find(s=>s.id===id).roomIds?.includes('shared'),'Visible membership acknowledged');
}
async function guards(){const values=await app.evaluate(()=>globalThis.stateGuards);assert.deepEqual(values,{clipboard:0,external:0,dialogs:0,maintenance:0,replacement:0});guardSamples.push(values);}
async function check(text){assert.ok(Date.now()-started<plan.maxRunMs,'Five-minute stage-entry budget');checks.push(text);console.log('PASS:',text);await capture('stage-'+String(checks.length).padStart(2,'0'));}
async function run(){
 await until(()=>fs.existsSync(path.join(profile,'connection.json')),'Service');client=await connect(profile,'state-observer');const backend=await client.call('initial');assert.equal(backend.servicePid,child.pid);assert.equal(backend.runtimeVersion,require('../package.json').version);assert.equal(backend.sessions.length,0);await launch();
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
 const request=page.locator('#approval .native-approval-request[data-native-request-id="permission:1"]');
 if(!await request.evaluate(el=>el.open))await request.locator(':scope > summary').click();
 const original=request.locator('.native-approval-original');
 if(!await original.evaluate(el=>el.open))await original.locator(':scope > summary').click();
 const rawBody=request.locator('.native-approval-raw-body');await rawBody.waitFor({state:'visible'});
 assert.equal(await rawBody.innerText(),'{'+'"command":"check-document"}');
 assert.equal(await page.locator('#approval button').count(),1,'No fabricated native permission decisions');
 const requestBody=await rawBody.elementHandle();
 const observedAt=Date.now();await fixture('native-permission',a,{...permission,observedAt});
 await until(async()=>(await snapshot()).sessions.find(s=>s.id===a).nativeApproval.observedAt===observedAt,'Fresh observer heartbeat');await page.waitForTimeout(100);
 assert.equal(await requestBody.evaluate(el=>el.isConnected),true,'Observer heartbeat must not replace the readable request or focused action');
 assert.equal(await original.evaluate(el=>el.open),true,'Observer heartbeat keeps the original request expanded');assert.equal(await rawBody.isVisible(),true);
 assert.equal(await page.locator('#message-input').inputValue(),'尚未发送的下一条草稿');
 await capture('solo-native-permission');
 await fixture('native-permission',a,null);await fixture('native-activity',a,{turnId:'turn-a',label:'正在输出',phase:'responding'});
 await page.locator('#approval').waitFor({state:'hidden'});await page.locator('#native-phase').getByText('Claude state · 正在输出',{exact:true}).waitFor();
 await fixture('native-activity',a,null);await page.locator('#native-activity').waitFor({state:'hidden'});
 await check('Before-text/request/thinking/response/end phases; native focus and unsent draft remain independent; exact private permission body with native handling');
 await join(a);
 const b=await create('codex','Other member');
 await fixture('native-activity',b,{turnId:'codex-clock',label:'inProgress'});
 await page.locator('#native-phase').getByText('Other member · 工作中',{exact:true}).waitFor();
 assert.equal(await page.locator('#native-elapsed').innerText(),'','Unknown native start time does not become an enqueue clock');
 await fixture('native-activity',b,{turnId:'codex-clock',label:'inProgress',startedAt:Date.now()-2000});
 await until(async()=>/已用 \d+ 秒/.test(await page.locator('#native-elapsed').innerText()),'Known native start time permits elapsed display');
 await fixture('native-activity',b,{turnId:'codex-clock',label:'inProgress'});
 await until(async()=>(await page.locator('#native-elapsed').innerText())==='','Losing native time removes the clock rather than retaining an earlier value');
 await fixture('native-activity',b,null);await page.locator('#native-activity').waitFor({state:'hidden'});
 await check('Codex running clock is absent for unknown native time, follows a reported start, disappears again when unknown, and hides after native idle');
 await join(b);
 await page.locator('#room-nav').click();await page.locator('#room-record').click();
 const {chooseRecipient,fillRoomMessage}=require('./room-input.cjs');await chooseRecipient(page,a);await fillRoomMessage(page,'Check one document.');await page.locator('#forward-button').click();
 await fixture('replyBound',a,{turnId:'shared-turn',promptId:'shared-prompt'});
 await fixture('native-activity',a,{turnId:'shared-turn',label:'思考中',phase:'thinking'});
 await page.locator('#run-status').getByText('Claude state · 思考中',{exact:false}).waitFor();
 await fixture('nativeBlock',a,{id:'response:shared',kind:'response',turnId:'shared-turn',promptId:'shared-prompt',text:'Public partial',status:'streaming'});
 await page.locator('#room-messages').getByText('Public partial',{exact:true}).waitFor();await capture('shared-public-before-permission');
 await fixture('native-permission',a,permission);
 assert.equal(await page.locator('#room-messages').isVisible(),true);
 const waitingMember=page.locator(`.collaboration-member-status[data-member-id="${a}"]`);await waitingMember.waitFor();
 await until(async()=>await waitingMember.getAttribute('data-state')==='approval','The original member visibly reports waiting for permission');
 assert.ok((await waitingMember.innerText()).includes('等待确认'));await capture('room-waiting-member');
 await waitingMember.locator('.collaboration-member-name').click();
 await page.locator('#approval').getByText('Claude state',{exact:true}).waitFor();
 assert.ok(!(await snapshot()).room.messages.some(m=>m.text.includes('check-document')),'Permission arguments never become room messages');
 await page.locator('#approval').getByRole('button',{name:'在 Claude state 的原生终端处理',exact:true}).click();
 assert.match(await page.locator('#native-pane-title').innerText(),/Claude state/);
 await fixture('native-permission',a,null);await fixture('native-activity',a,{turnId:'shared-turn',label:'PRIVATE PHASE',phase:'thinking'});
 await fixture('nativeBlock',a,{id:'response:shared',kind:'response',turnId:'shared-turn',promptId:'shared-prompt',text:'PRIVATE AFTER PERMISSION',status:'streaming'});
 await page.locator('#native-phase').getByText('Claude state · PRIVATE PHASE',{exact:true}).waitFor();
 await page.locator('#messages').getByText('PRIVATE AFTER PERMISSION',{exact:true}).waitFor();
 assert.ok(!(await page.locator('#run-status').innerText()).includes('PRIVATE PHASE'));
 assert.ok(!(await snapshot()).room.messages.some(m=>m.text.includes('PRIVATE AFTER PERMISSION')));
 assert.equal((await snapshot()).sessions.find(s=>s.id===a).sharedActivity,null,'Later private activity has no shared grant');
 assert.ok((await snapshot()).room.messages.some(m=>m.text==='Public partial'),'Revoking sharing preserves the last public prefix');
 await capture('room-native-permission');
 await check('Room member status exposes a waiting permission; explicit member focus opens its local permission and original TUI; revoked grant never resumes phase or reply sharing');
 await fixture('native-activity',a,null);assert.equal((await fixture('stats')).sends.length,1);const stats=await fixture('stats');assert.deepEqual(stats.sends,[{id:a,text:'Check one document.'}]);assert.equal(stats.inputs.length,0);assert.equal(stats.interruptions.length,0);assert.deepEqual(errors,[]);await guards();const windows=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>({visible:w.isVisible(),focusable:w.isFocusable()})));assert.deepEqual(windows,[{visible:false,focusable:false}]);
 console.log(JSON.stringify({checks,errors,providerCalls:0,dispatches:1,profile},null,2));
}
const cleanup=testScratch.cleanup(async()=>{if(app)await app.close();if(client){for(const s of(await client.call('initial')).sessions)await client.call('stop',s.id);await client.call('shutdown');client.close();}else if(child.exitCode===null)child.kill('SIGTERM');if(child.connected)child.disconnect();await until(()=>child.exitCode!==null,'Owned fixture exits');});
run().catch(async e=>{failure=e.stack;console.error(failure);process.exitCode=1;await capture('failed').catch(()=>{});}).finally(async()=>{
 fs.mkdirSync(evidence,{recursive:true});
 fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({checks,failure,errors,profile,ownedNodePid:child.pid,ownedGuiPids:guiPids,guards:guardSamples,currentGuards:app?await app.evaluate(()=>globalThis.stateGuards).catch(()=>null):null,fixture:child.connected?await fixture('stats').catch(()=>null):null},null,2));
 await cleanup();assert.equal(JSON.parse(fs.readFileSync(path.join(slot,'owner.json'))).token,token);fs.unlinkSync(path.join(slot,'owner.json'));fs.rmdirSync(slot);
 fs.writeFileSync(path.join(evidence,'released.json'),JSON.stringify({token,releasedAt:new Date().toISOString(),ownedProfileGone:!fs.existsSync(profile)}));
});
