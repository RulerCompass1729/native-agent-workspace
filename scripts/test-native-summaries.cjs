const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
const { chooseRecipient: inlineRecipient, fillRoomMessage, roomBody } = require('./room-input.cjs');
// Actual Codex tool execution and Electron with two bounded loopback summary streams.
// Private native configuration; no paid inference or normal-profile edits.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), { execFileSync } = testScratch.childProcess;
const { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..');
const { executable, processIdentity, processMayBeAlive } = require('../app/platform.cjs'), { connect } = require('../app/service-client.cjs');
const base = testScratch.directory(path.join(os.tmpdir(), 'naw-native-summaries-'));
const profile = path.join(base, 'profile'), cwd = path.join(base, 'work'), home = path.join(base, 'codex');
for (const dir of [profile, cwd, home]) fs.mkdirSync(dir, { mode: 0o700 });
const binary = executable('codex'); if (!binary) throw Error('Real Codex required');
const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
assert.equal(version, 'codex-cli 0.163.0');
let application, page, calls = 0, titleCalls = 0, sequence = 0, releaseStart, releaseFinal;
const checks = [];
const errors = [], requests = [], sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, timeout = 30000) {
  const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await sleep(75); } throw Error(label);
}
function event(res, type, body) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: ++sequence, ...body })}\n\n`); }
const summary = '**PUBLIC_SUMMARY**\n\nChecking the given material.';
const second = 'Comparing the visible result.';
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', b => body += b); req.on('end', async () => {
    if (!req.url.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
    const input = JSON.parse(body);
    const nativeTitle = input.input?.some(m => m.role === 'user' && m.content?.some(p => typeof p.text === 'string' && p.text.startsWith('Generate a concise, single-line task title')));
    const number = nativeTitle ? 0 : ++calls; if (nativeTitle) titleCalls++;
    if (number > 2 || titleCalls > 1) { res.writeHead(429); res.end(); return; }
    fs.writeFileSync(path.join(base, nativeTitle ? 'native-title-request.json' : `request-${number}.json`), JSON.stringify(input, null, 2));
    requests.push({model: input.model, inputItems: input.input?.length,nativeTitle});
    const response = {id: `resp_summary_${number}`, object:'response', created_at: Math.floor(Date.now()/1000), status:'in_progress', model: input.model, output:[], usage: {input_tokens:10,output_tokens:10,total_tokens:20}};
    res.writeHead(200, {'content-type':'text/event-stream'}); event(res, 'response.created', {response});
    if (nativeTitle) {
      const item = {id:'native_title',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({title:'Check small example'}),annotations:[]}]};
      event(res,'response.output_item.done',{output_index:0,item});
      event(res,'response.completed',{response:{...response,status:'completed',output:[item]}});res.end();return;
    }
    await new Promise(resolve => { releaseStart = resolve; }); releaseStart = null;
    if (res.destroyed) return;
    const item = {id: `summary_${number}`, type:'reasoning', summary:[], content:[], encrypted_content:null};
    event(res, 'response.output_item.added', {output_index:0, item});
    event(res, 'response.reasoning_summary_part.added', {output_index:0,item_id:item.id,summary_index:0,part:{type:'summary_text',text:''}});
    const first = number === 1 ? summary : '**INTERRUPTED_SUMMARY**\n\nThis visible partial must remain.';
    event(res, 'response.reasoning_summary_text.delta', {output_index:0,item_id:item.id,summary_index:0,delta:first});
    await new Promise(resolve => { releaseFinal = resolve; }); releaseFinal = null;
    if (res.destroyed) return;
    event(res, 'response.reasoning_summary_text.done', {output_index:0,item_id:item.id,summary_index:0,text:first});
    event(res, 'response.reasoning_summary_part.done', {output_index:0,item_id:item.id,summary_index:0,part:{type:'summary_text',text:first}});
    event(res, 'response.reasoning_summary_part.added', {output_index:0,item_id:item.id,summary_index:1,part:{type:'summary_text',text:''}});
    event(res, 'response.reasoning_summary_text.delta', {output_index:0,item_id:item.id,summary_index:1,delta:second});
    item.summary = [{type:'summary_text',text:first},{type:'summary_text',text:second}];
    event(res, 'response.output_item.done', {output_index:0,item});
    const answer = {id:`answer_${number}`,type:'message',role:'assistant',status:'completed',phase:'final_answer',content:[{type:'output_text',text:'SUMMARY_TASK_DONE',annotations:[]}]};
    event(res, 'response.output_item.added', {output_index:1,item:{...answer,status:'in_progress',content:[]}});
    event(res, 'response.output_text.delta', {output_index:1,item_id:answer.id,content_index:0,delta:'SUMMARY_TASK_DONE'});
    event(res, 'response.output_item.done', {output_index:1,item:answer});
    event(res, 'response.completed', {response:{...response,status:'completed',output:[item,answer]}}); res.end();
  });
});
const snapshot = () => page.evaluate(() => workspace.initial());
async function launch() {
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], ...(process.env.NAW_VIDEO_DIR ? { recordVideo: { dir: process.env.NAW_VIDEO_DIR, size: { width: 1280, height: 900 } } } : {}), env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  await until(async () => { for (const candidate of application.windows()) if (!candidate.isClosed() && await candidate.locator('#new-session').count().catch(() => 0)) { page = candidate; return true; } return false; }, 'Main workspace');
  page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(home, 'config.toml'), `model = "gpt-6-luna"\nmodel_provider = "local_fixture"\nmodel_reasoning_effort = "low"\n[model_providers.local_fixture]\nname = "Local protocol fixture"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`, { mode: 0o600 });
  const shim = path.join(base, 'codex-local');
  for(const folder of new Set([cwd,fs.realpathSync(cwd)])) fs.appendFileSync(path.join(home,'config.toml'), `\n[projects.${JSON.stringify(folder)}]\ntrust_level = "trusted"\n`);
  fs.writeFileSync(shim, '#!/usr/bin/python3\nimport os,sys\n' +
    `os.environ["CODEX_HOME"]=${JSON.stringify(home)}\n` +
    'for key in ["OPENAI_API_KEY","CODEX_API_KEY"]: os.environ.pop(key,None)\n' +
    `os.execv(${JSON.stringify(binary)},["codex"]+sys.argv[1:])\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify({ codex: shim }), { mode: 0o600 });
  await launch();
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check();
  await page.locator('#session-name').fill('Native summaries'); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions[0]?.state === 'idle', 'Native Codex ready');
  const before = (await snapshot()).sessions[0]; assert.equal(before.model, 'gpt-6-luna');
  await page.locator('#header-actions').getByRole('button', {name:'加入协作',exact:true}).click();
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await inlineRecipient(page, before.id);
  await fillRoomMessage(page, 'Check this small example and report your progress.'); await page.locator('#forward-button').click();
  await until(() => calls === 1 && releaseStart, 'One requested native task');
  await page.locator('#run-status').getByText('Native summaries · 正在处理',{exact:false}).waitFor();
  await page.locator(`[data-session-id="${before.id}"]`).click();
  await until(async () => (await snapshot()).sessions[0].terminalState?.alive && (await page.locator('#terminal-area').innerText()).includes('esc to interrupt'), 'Actual native terminal attaches alongside the reader without a tab switch', 60000);
  releaseStart();
  await until(async () => (await page.locator('#terminal-area').innerText()).includes('Checking the given material.'), 'Native public summary');
  fs.writeFileSync(path.join(base,'native-streaming.txt'),await page.locator('#terminal-area').innerText());
  await page.locator('#chat-tab').click();
  if (process.env.NAW_EXPECT_MISSING_SUMMARY === '1') {
    const missing = await snapshot(); assert.equal(missing.sessions[0].messages.filter(m=>m.kind==='summary').length,0);
    fs.writeFileSync(path.join(base,'missing-summary.json'),JSON.stringify(missing,null,2));
    console.log(JSON.stringify({reproduced:true,nativeSummaryVisible:true,guiSummaryRows:0,localResponses:calls,nativeTitleResponses:titleCalls,paidModelCalls:0,evidence:base})); return;
  }
  const disclosure = page.locator('#messages .process-details').filter({hasText:'PUBLIC_SUMMARY'});
  await disclosure.locator(':scope > summary').waitFor(); assert.equal(await disclosure.evaluate(el=>el.open),false);
  await disclosure.locator(':scope > summary').click();
  await page.locator('#messages').getByText('Checking the given material.',{exact:true}).waitFor();
  assert.equal(await page.locator('#terminal-area').isVisible(),true,'Actual native TUI remains alongside its structured reader');
  const streaming = await snapshot(), row = streaming.sessions[0].messages.find(m=>m.kind==='summary');
  assert.equal(row.text,summary); assert.equal(row.status,'streaming');
  assert.equal(streaming.room.messages.find(m=>m.title==='过程摘要').text,summary);
  fs.writeFileSync(path.join(base,'streaming.json'),JSON.stringify(streaming,null,2));
  await page.locator('#message-input').fill('Unsent draft remains.'); await page.reload(); await page.locator('#new-session').waitFor();
  assert.equal(await page.locator('#message-input').inputValue(),'Unsent draft remains.');
  releaseFinal();
  await until(async () => (await snapshot()).sessions[0].state==='idle','Native completion');
  const completed = await snapshot(), finished = completed.sessions[0].messages.find(m=>m.id===row.id);
  assert.equal(finished.text,summary+'\n\n'+second); assert.equal(finished.status,'complete');
  assert.equal(completed.sessions[0].messages.filter(m=>m.kind==='summary').length,1);
  assert.equal(completed.room.messages.filter(m=>m.finalReply).length,1);
  assert.equal(completed.room.messages.find(m=>m.finalReply).text,'SUMMARY_TASK_DONE');
  assert.equal(completed.sessions[0].nativeId,before.nativeId); assert.equal(calls,1);
  const completion=completed.sessions[0].messages.find(m=>m.kind==='turn'&&m.status==='complete');
  assert.ok(Number.isFinite(completion?.nativeCompletedAt)); assert.ok(Number.isSafeInteger(completion?.nativeDurationMs));
  const sharedCompletion=completed.room.messages.find(m=>m.nativeMessageId===completion.id);
  assert.equal(sharedCompletion?.kind,'turn'); assert.equal(sharedCompletion.nativeCompletedAt,completion.nativeCompletedAt);
  assert.equal(sharedCompletion.nativeDurationMs,completion.nativeDurationMs);
  const completionRow=page.locator('#messages [data-message-id="'+completion.id+'"]');
  await completionRow.getByText('Worked for',{exact:false}).waitFor();
  const displayedCompletion=await completionRow.locator('.message-body').innerText();
  await page.locator('#terminal-tab').click();
  await until(async()=> (await page.locator('#terminal-area').innerText()).includes('Worked for'),'Native completion label');
  const nativeCompleted=await page.locator('#terminal-area').innerText();
  assert.ok(nativeCompleted.includes(displayedCompletion.split(' • ')[0]),'Reader duration matches the native TUI completion');
  fs.writeFileSync(path.join(base,'native-completed.txt'),nativeCompleted);
  await page.locator('#chat-tab').click();
  fs.writeFileSync(path.join(base,'completed.json'),JSON.stringify(completed,null,2));
  checks.push('One native summary block streams in solo/shared readers; reload preserves draft; final reply stays separate');
  checks.push('Native completion duration agrees with TUI and retains exact native clock in solo and shared records');
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await page.locator(`[data-room-session="${before.id}"]`).click();
  assert.equal(await page.locator('#room-messages').isVisible(),true);
  assert.equal(await page.locator('#terminal-area').isVisible(),true,'Shared reading and the actual native member remain together');
  await page.locator('#room-messages .process-details').filter({hasText:'PUBLIC_SUMMARY'}).locator(':scope > summary').click();
  assert.match(await page.locator('#room-messages').innerText(),/Checking the given material/);
  if(process.env.NAW_EVIDENCE_DIR){fs.mkdirSync(process.env.NAW_EVIDENCE_DIR,{recursive:true}); await page.screenshot({path:path.join(process.env.NAW_EVIDENCE_DIR,'public-summary.png')});}
  await fillRoomMessage(page, 'Start another small check.'); await page.locator('#forward-button').click();
  await until(()=>calls===2&&releaseStart,'Second bounded task'); releaseStart();
  await page.locator('#room-messages .process-details').filter({hasText:'INTERRUPTED_SUMMARY'}).locator(':scope > summary').click();
  await page.locator('#room-messages').getByText('This visible partial must remain.',{exact:true}).waitFor();
  assert.equal(await page.locator('#room-messages').isVisible(),true);
  await fillRoomMessage(page,'Unsent shared draft before native intervention.');
  const sharedDraftBeforeInterrupt=await page.locator('#shared-input').inputValue();
  await page.locator('#terminal-area .xterm-screen').click();
  await until(async ()=>(await page.locator('#terminal-area').innerText()).includes('This visible partial must remain.'),'Native partial summary');
  await page.locator('#terminal-area .xterm-helper-textarea').press('Escape');
  await until(async ()=>(await snapshot()).sessions[0].messages.some(m=>m.kind==='summary'&&m.status==='interrupted'),'Native interruption boundary');
  assert.equal(await page.locator('#room-messages').isVisible(),true,'Native Escape occurs inside the shared workspace');
  assert.equal(await page.locator('#shared-input').inputValue(),sharedDraftBeforeInterrupt,'Native interruption preserves the independent shared draft');
  fs.writeFileSync(path.join(base,'shared-interrupted.json'),JSON.stringify(await snapshot(),null,2));
  if(process.env.NAW_EVIDENCE_DIR) await page.screenshot({path:path.join(process.env.NAW_EVIDENCE_DIR,'shared-native-interrupted.png')});
  releaseFinal();
  await page.locator(`[data-session-id="${before.id}"]`).click();await page.locator('#chat-tab').click(); await page.reload(); await page.locator('#new-session').waitFor();
  const interrupted=await snapshot();
  assert.ok(interrupted.sessions[0].messages.some(m=>m.kind==='summary'&&m.status==='interrupted'&&m.text.includes('This visible partial must remain.')));
  assert.ok(interrupted.room.messages.some(m=>m.title==='过程摘要'&&m.status==='interrupted'));
  assert.equal(interrupted.diagnostics.dispatches,2); assert.equal(calls,2); assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(base,'interrupted.json'),JSON.stringify(interrupted,null,2));
  checks.push('Actual native Escape freezes partial summary in both readers; no extra response or final handoff');
  const identity=interrupted.sessions[0];
  await application.close(); application=null; await launch(); await page.locator('#new-session').waitFor();
  await until(async ()=>(await snapshot()).sessions[0]?.messages.some(m=>m.kind==='summary'&&m.status==='interrupted'),'Whole-app reopen preserves native cut');
  const reopened=await snapshot(); assert.equal(reopened.sessions[0].nativeId,identity.nativeId); assert.equal(reopened.sessions[0].pid,identity.pid);
  assert.equal(await page.locator('#message-input').inputValue(),'Unsent draft remains.'); assert.equal(calls,2);
  assert.ok(reopened.room.messages.some(m=>m.title==='过程摘要'&&m.status==='interrupted'));
  fs.writeFileSync(path.join(base,'reopened.json'),JSON.stringify(reopened,null,2));
  assert.equal(await page.locator('#messages .message.assistant .message-body').first().evaluate(el=>getComputedStyle(el).whiteSpace),'normal','Rendered Markdown must not double its paragraph breaks');
  fs.writeFileSync(path.join(base,'summary-dom.json'),JSON.stringify(await page.locator('#messages .message.assistant .message-body').evaluateAll(els=>els.map(el=>({html:el.innerHTML,style:getComputedStyle(el).whiteSpace,children:[...el.querySelectorAll('*')].slice(0,25).map(child=>({tag:child.tagName,cls:child.className,height:child.getBoundingClientRect().height,margin:getComputedStyle(child).margin,whiteSpace:getComputedStyle(child).whiteSpace}))}))),null,2));
  checks.push('Whole-app reopening retains native identity/process, summary cut, shared records and unsent draft');
  console.log(JSON.stringify({version,checks,localResponses:calls,nativeTitleResponses:titleCalls,paidModelCalls:0,evidence:base}));
})().catch(async error => {
  if (page && !page.isClosed()) { fs.writeFileSync(path.join(base, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {}); }
  console.error(error.stack, '\nEvidence:', base, JSON.stringify({calls,titleCalls,releaseStart:Boolean(releaseStart),releaseFinal:Boolean(releaseFinal)})); process.exitCode = 1;
}).finally(testScratch.cleanup(async () => {
  releaseStart?.(); releaseFinal?.(); server.closeAllConnections();
  if (application) await application.close().catch(() => {});
  try {
    const client = await connect(profile, 'native-summaries-cleanup');
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
  await new Promise(resolve => server.close(resolve));
}));
