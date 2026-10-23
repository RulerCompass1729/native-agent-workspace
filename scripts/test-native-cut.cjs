// Actual Electron/native Codex interruption and next-turn continuation.
// Two fixed loopback task responses and at most one native title; no paid inference.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), { execFileSync, fork } = require('node:child_process');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const { executable, processIdentity, processMayBeAlive } = require('../app/platform.cjs');
const { connect, connectService } = require('../app/service-client.cjs');
const retained = process.env.NAW_CUT_RETAINED === '1';
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-native-cut-'));
const profile = path.join(base, 'profile'), cwd = path.join(base, 'work'), home = path.join(base, 'codex');
for (const dir of [profile, cwd, home]) fs.mkdirSync(dir, {mode:0o700});
const binary=executable('codex'); assert.ok(binary);
const version=execFileSync(binary,['--version'],{encoding:'utf8'}).trim(); assert.equal(version,'codex-cli 0.163.0');
let application,page,child,legacyClient,calls=0,titleCalls=0,sequence=0,release,releaseStart;
const checks=[],errors=[],sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,timeout=30000){const start=Date.now();while(Date.now()-start<timeout){if(await fn())return;await sleep(75);}throw Error(label);}
function event(res,type,body){res.write(`event: ${type}\ndata: ${JSON.stringify({type,sequence_number:++sequence,...body})}\n\n`);}
const partial='OBSERVED_CUT: this exact partial stays.\n', final='NEXT_TURN: a new request still completes.';
const server=http.createServer((req,res)=>{
 let body='';req.on('data',b=>body+=b);req.on('end',async()=>{
  if(!req.url.endsWith('/responses')){res.writeHead(404);res.end();return;}
  const input=JSON.parse(body);assert.equal(input.model,'gpt-6-luna');
  const title=input.input?.some(m=>m.role==='user'&&m.content?.some(p=>p.text?.startsWith('Generate a concise, single-line task title')));
  const number=title?0:++calls;if(title)titleCalls++;
  if(calls>2||titleCalls>1){res.writeHead(429);res.end();return;}
  fs.writeFileSync(path.join(base,title?'native-title-request.json':`request-${number}.json`),JSON.stringify(input,null,2));
  const text=title?JSON.stringify({title:'Small interruption check'}):number===1?partial:final;
  const response={id:`resp_cut_${number}`,object:'response',status:'in_progress',model:input.model,output:[],usage:{input_tokens:10,output_tokens:10,total_tokens:20}};
  const item={id:`answer_cut_${number}`,type:'message',role:'assistant',status:'in_progress',phase:'final_answer',content:[]};
  res.writeHead(200,{'content-type':'text/event-stream'});event(res,'response.created',{response});
  if(number===1)await new Promise(resolve=>releaseStart=resolve);
  if(res.destroyed)return;
  event(res,'response.output_item.added',{output_index:0,item});
  event(res,'response.content_part.added',{output_index:0,item_id:item.id,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
  event(res,'response.output_text.delta',{output_index:0,item_id:item.id,content_index:0,delta:text});
  if(number===1)await new Promise(resolve=>release=resolve);
  if(res.destroyed)return;
  item.status='completed';item.content=[{type:'output_text',text,annotations:[]}];
  event(res,'response.output_text.done',{output_index:0,item_id:item.id,content_index:0,text});
  event(res,'response.content_part.done',{output_index:0,item_id:item.id,content_index:0,part:item.content[0]});
  event(res,'response.output_item.done',{output_index:0,item});
  event(res,'response.completed',{response:{...response,status:'completed',output:[item]}});res.end();
 });
});
const snapshot=()=>page.evaluate(()=>workspace.initial());
async function save(name){const state=await snapshot();fs.writeFileSync(path.join(base,name+'.json'),JSON.stringify(state,null,2));return JSON.parse(JSON.stringify(state));}
(async()=>{
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(home, 'config.toml'), `model = "gpt-6-luna"\nmodel_provider = "local_fixture"\nmodel_reasoning_effort = "low"\n[model_providers.local_fixture]\nname = "Local protocol fixture"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`, { mode: 0o600 });
  const shim = path.join(base, 'codex-local');
  fs.writeFileSync(shim, '#!/usr/bin/python3\nimport os,sys\n' +
    `os.environ["CODEX_HOME"]=${JSON.stringify(home)}\n` +
    'for key in ["OPENAI_API_KEY","CODEX_API_KEY"]: os.environ.pop(key,None)\n' +
    `os.execv(${JSON.stringify(binary)},["codex"]+sys.argv[1:])\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify({ codex: shim }), { mode: 0o600 });
  let retainedId;
  if (retained) {
    const old = path.join(base, 'old'), bin = path.join(base, 'bin'); fs.mkdirSync(old); fs.mkdirSync(bin);
    execFileSync('/usr/bin/tar', ['-x', '-C', old], { input: execFileSync('git', ['archive', 'a87653b', 'app', 'package.json'], { cwd: root, maxBuffer: 16 * 1024 * 1024 }) });
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(old, 'node_modules')); fs.symlinkSync(shim, path.join(bin, 'codex'));
    child = fork(path.join(old, 'app/daemon.cjs'), [profile], { env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, NAW_APP_VERSION: '0.1.0-alpha.2', NAW_WORKSPACE: cwd }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Original backend boot');
    legacyClient = await connectService(profile, 'retained-steer-fixture');
    retainedId = await legacyClient.call('create', { provider: 'codex', cwd, name: 'Retained interruption', view: 'terminal' });
  }
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], ...(process.env.NAW_VIDEO_DIR ? { recordVideo: { dir: process.env.NAW_VIDEO_DIR, size: { width: 1280, height: 900 } } } : {}), env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  await until(async () => { for (const candidate of application.windows()) if (!candidate.isClosed() && await candidate.locator('#new-session').count().catch(() => 0)) { page = candidate; return true; } return false; }, 'Main workspace');
  page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  if (retained) {
    await page.locator(`[data-session-id="${retainedId}"]`).click(); await page.locator('#terminal-tab').click();
    const takeover = page.getByRole('button', { name: '接管此窗口', exact: true }); if (await takeover.isVisible()) await takeover.click();
    await until(async () => (await page.locator('#terminal-area').innerText()).includes('Trust this folder?') || (await snapshot()).sessions[0]?.state === 'idle', 'Native trust gate', 60000);
    if ((await page.locator('#terminal-area').innerText()).includes('Trust this folder?')) {
      const prompt = await page.locator('#terminal-area').innerText(); assert.ok(prompt.includes(cwd) || prompt.includes(fs.realpathSync(cwd))); assert.match(prompt, /› 1\. Trust and continue/);
      await page.locator('#terminal-area .xterm-helper-textarea').press('Enter');
    }
    await until(async () => (await snapshot()).sessions[0]?.state === 'idle', 'Retained native ready');
    await page.locator('#chat-tab').click();
    if (await page.locator('#send-button').textContent() === '接管此窗口') await page.locator('#send-button').click();
    assert.equal(await page.locator('#send-button').textContent(), '接通原会话输入'); await page.locator('#send-button').click();
  } else {
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check();
  await page.locator('#initial-view').selectOption('chat'); await page.locator('#session-name').fill('Native interruption'); await page.locator('#confirm-create').click();
  }
  await until(async () => (await snapshot()).sessions[0]?.state === 'idle', 'Native Codex ready');
  const before = (await snapshot()).sessions[0];
  if (!retained) assert.equal(before.model, 'gpt-6-luna');
  await page.locator('#header-actions').getByRole('button',{name:'加入协作',exact:true}).click();
  await page.locator('#room-nav').click();await page.locator('#room-record').click();
  await page.locator('#mention-button').click();await page.locator(`[data-mention-id="${before.id}"]`).click();
  await page.locator('#shared-input').fill('Start a small shared response for the interruption check.');await page.locator('#forward-button').click();
  await until(()=>calls===1&&releaseStart,'First native response pending');
  await page.locator(`[data-session-id="${before.id}"]`).click();await page.locator('#terminal-tab').click();
  await until(async()=>(await page.locator('#terminal-area').innerText()).includes('esc to interrupt'),'Native terminal attached before streaming',60000);
  releaseStart();releaseStart=null;
  await until(async()=>(await page.locator('#terminal-area').innerText()).includes(partial.trim()),'Native visible partial');
  await page.locator('#room-nav').click();await page.locator('#room-record').click();
  await page.locator('#room-messages').getByText(partial,{exact:true}).waitFor();
  const streaming=await save('streaming');assert.equal(calls,1);
  const sharedRow=streaming.room.messages.find(m=>m.text===partial);assert.equal(sharedRow.status,'streaming');
  await page.locator('#shared-input').fill('Unsent room draft.');
  await page.locator(`[data-session-id="${before.id}"]`).click();await page.locator('#chat-tab').click();
  await page.locator('#messages').getByText(partial,{exact:true}).waitFor();await page.locator('#message-input').fill('Unsent solo draft.');
  await page.locator('#terminal-tab').click();
  await until(async()=>{const text=await page.locator('#terminal-area').innerText();return text.includes(partial.trim())&&(await snapshot()).sessions[0].state==='working';},'Current native output while task is working',60000);
  fs.writeFileSync(path.join(base,'before-interrupt.txt'),await page.locator('#terminal-area').innerText());
  await page.locator('#terminal-area .xterm-screen:visible').click();await page.keyboard.press('Escape');
  await until(async()=>(await snapshot()).sessions[0].messages.some(m=>m.kind==='turn'&&m.status==='interrupted'),'Native interruption');
  await until(async()=>(await snapshot()).sessions[0].state==='idle','Native idle after interruption');
  release?.();release=null;
  const interrupted=await save('interrupted'),cut=interrupted.sessions[0].messages.find(m=>m.text===partial);
  assert.equal(cut.status,'interrupted');assert.equal(interrupted.room.messages.find(m=>m.id===sharedRow.id).status,'interrupted');
  assert.ok(!interrupted.room.messages.some(m=>m.finalReply));assert.equal(calls,1);
  fs.writeFileSync(path.join(base,'after-interrupt.txt'),await page.locator('#terminal-area').innerText());
  await page.locator('#chat-tab').click();await page.locator('#messages').getByText(partial,{exact:true}).waitFor();
  assert.equal(await page.locator('#message-input').inputValue(),'Unsent solo draft.');
  checks.push('Actual native Escape fixes the same partial text in solo and attributed shared readers, preserving drafts');
  await page.locator('#message-input').fill('Continue with a separate private task.');
  await save('before-next');
  fs.writeFileSync(path.join(base,'before-next-button.json'),JSON.stringify(await page.locator('#send-button').evaluate(e=>({html:e.outerHTML,value:document.getElementById('message-input').value})),null,2));
  await page.locator('#send-button').click();
  await page.locator('#messages').getByText(final,{exact:true}).waitFor();await until(async()=>(await snapshot()).sessions[0].state==='idle','Next native turn completed');
  const completed=await save('completed');assert.equal(calls,2);assert.ok(!completed.room.messages.some(m=>m.text===final));
  assert.deepEqual(completed.sessions[0].messages.find(m=>m.id===cut.id),cut);
  assert.deepEqual(completed.room.messages,interrupted.room.messages);
  await page.locator('#message-input').fill('Draft after continuation.');
  await page.locator('#terminal-tab').click();await until(async()=>(await page.locator('#terminal-area').innerText()).includes(final),'Native next result');
  fs.writeFileSync(path.join(base,'next-terminal.txt'),await page.locator('#terminal-area').innerText());await page.locator('#chat-tab').click();
  checks.push('Next GUI task completes in the same native session; interrupted row stays exact and next private reply stays out of the room');
  const oldId=completed.sessions[0].nativeId,oldPid=completed.sessions[0].pid;
  await application.close();application=null;
  application=await _electron.launch({executablePath:process.env.NAW_APP_EXECUTABLE||require('electron'),args:process.env.NAW_APP_EXECUTABLE?[]:[root],env:{...process.env,NAW_DATA_DIR:profile,NAW_WORKSPACE:cwd,NAW_TEST_PARENT_PID:String(process.pid)},timeout:70000});
  await until(async()=>{for(const candidate of application.windows())if(!candidate.isClosed()&&await candidate.locator('#new-session').count().catch(()=>0)){page=candidate;return true;}return false;},'Reopened workspace');
  page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  await page.locator('#messages').getByText(final,{exact:true}).waitFor();
  const reopened=await save('reopened');assert.equal(reopened.sessions[0].nativeId,oldId);assert.equal(reopened.sessions[0].pid,oldPid);
  assert.deepEqual(reopened.sessions[0].messages,completed.sessions[0].messages);assert.deepEqual(reopened.room.messages,completed.room.messages);
  assert.equal(await page.locator('#message-input').inputValue(),'Draft after continuation.');
  await page.locator('#room-nav').click();await page.locator('#room-record').click();
  await page.locator('#room-messages').getByText(partial,{exact:true}).waitFor();assert.equal(await page.locator('#shared-input').inputValue(),'Unsent room draft.');
  assert.equal(calls,2);assert.equal(reopened.diagnostics.dispatches,2);assert.deepEqual(errors,[]);
  if(process.env.NAW_EVIDENCE_DIR){fs.mkdirSync(process.env.NAW_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.NAW_EVIDENCE_DIR,'interrupted-shared.png')});}
  checks.push('Whole-app reopening retains exact solo/shared rows, native process/identity and both drafts without another dispatch');
  console.log(JSON.stringify({version,retained,checks,taskResponses:calls,nativeTitleResponses:titleCalls,paidModelCalls:0,errors,evidence:base}));
})().catch(async error => {
  if (page && !page.isClosed()) { fs.writeFileSync(path.join(base, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {}); }
  if(page&&!page.isClosed()){await save('failure-state');fs.writeFileSync(path.join(base,'failure-toast.txt'),await page.locator('#toast').textContent());}
  console.error(error.stack, '\nEvidence:', base); process.exitCode = 1;
}).finally(async () => {
  releaseStart?.(); release?.(); server.closeAllConnections();
  if (application) await application.close().catch(() => {});
  legacyClient?.close();
  try {
    const client = await connect(profile, 'native-cut-cleanup');
    try {
      for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id);
      // Codex unsubscribe deliberately reports disconnected, not fleet-ended.
      // This isolated fixture owns its entire daemon/server and creates no fleet.
      const owned = client.entries.map(entry => processIdentity(entry.state.servicePid));
      for (const identity of owned) {
        assert.ok(identity && processMayBeAlive(identity));
        process.kill(identity.pid, 'SIGTERM');
      }
      await until(() => owned.every(identity => !processMayBeAlive(identity)), 'Owned services terminate', 15000);
      console.log('Owned service exit confirmed.');
    } finally { client.close(); }
  } catch (error) { console.error('Owned trial cleanup not confirmed:', error.message); process.exitCode = 1; }
  if (child?.connected) child.disconnect();
  await new Promise(resolve => server.close(resolve));
});
