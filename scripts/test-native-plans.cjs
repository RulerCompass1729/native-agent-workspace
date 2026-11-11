const testScratch = require('./fixtures/test-scratch.cjs');
const { joinSpace } = require('./fixtures/space-membership.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
const { chooseRecipient: inlineRecipient, fillRoomMessage, roomBody } = require('./room-input.cjs');
// Actual Codex Plan mode and Electron; four bounded fixed loopback responses.
// Private native configuration; no paid inference or normal-profile edits.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { execFileSync } = testScratch.childProcess;
const root = path.resolve(__dirname, '..');
const { _electron } = testScratch.playwright(require('playwright'));
const loopback = require('./fixtures/loopback-model.cjs');
const { executable, processIdentity, processMayBeAlive } = require('../app/platform.cjs'), { connect } = require('../app/service-client.cjs');
const base = testScratch.directory(path.join(os.tmpdir(), 'naw-native-plans-'));
const profile = path.join(base, 'profile'), cwd = path.join(base, 'work'), home = path.join(base, 'codex'), userHome = path.join(base, 'home');
for (const dir of [profile, cwd, home, userHome]) fs.mkdirSync(dir, { mode: 0o700 });
const binary = executable('codex'); if (!binary) throw Error('Real Codex required');
const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
// Plan rows come from the protocol the product verifies; follow its gate, not a fixed old version.
// NAW_CODEX_VERSION, when given, must name the installed version.
const nativeVersion = version.replace(/^codex-cli /, ''), { verifiedCodexProtocol } = require('../app/native-history.cjs');
assert.ok(verifiedCodexProtocol({ nativeVersion }), `Unqualified Codex: ${version}`);
if (process.env.NAW_CODEX_VERSION) assert.equal(nativeVersion, process.env.NAW_CODEX_VERSION);
let application, page, calls = 0, titleCalls = 0, sequence = 0, releaseStart, releaseFinal, budgetError;
const checks = [];
const errors = [], requests = [], sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, timeout = 30000) {
  const start = Date.now(); while (Date.now() - start < timeout) { if (budgetError) throw budgetError; if (await fn()) return; await sleep(75); } throw Error(label);
}
function event(res, type, body) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: ++sequence, ...body })}\n\n`); }
const plan = '# Small plan\n\n1. Read the supplied example.\n2. Check the result.';
// The one B11 loopback fixture: 127.0.0.1, random port, sandboxed CLI, fixed responses below.
const fixture = loopback.create({ directory: base, provider: 'codex', respond: async (req, res, body) => {
  {
    if (!req.url.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
    const input = JSON.parse(body);
    const nativeTitle = input.input?.some(m => m.role === 'user' && m.content?.some(p => typeof p.text === 'string' && p.text.startsWith('Generate a concise, single-line task title')));
    const number = nativeTitle ? 0 : ++calls; if (nativeTitle) titleCalls++;
    if (calls > 4 || titleCalls > 1) { budgetError = Error('Native Plan budget: four fixed tasks and at most one native title'); res.writeHead(400); res.end(budgetError.message); return; }
    assert.equal(input.model, 'gpt-6-luna');
    fs.writeFileSync(path.join(base, nativeTitle ? 'native-title-request.json' : `request-${number}.json`), JSON.stringify(input, null, 2));
    requests.push({model: input.model, inputItems: input.input?.length,nativeTitle});
    const response = {id: `resp_plan_${number}`, object:'response', created_at: Math.floor(Date.now()/1000), status:'in_progress', model: input.model, output:[], usage: {input_tokens:10,output_tokens:10,total_tokens:20}};
    res.writeHead(200, {'content-type':'text/event-stream'}); event(res, 'response.created', {response});
    if (nativeTitle) {
      const item = {id:'native_title',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({title:'Check small example'}),annotations:[]}]};
      event(res,'response.output_item.done',{output_index:0,item});
      event(res,'response.completed',{response:{...response,status:'completed',output:[item]}});res.end();return;
    }
    const planBody = number === 1 ? 'Ready for the plan.' : `<proposed_plan>\n${number === 2 ? plan : number === 3 ? '# Shared plan\n\nCheck this shared plan before continuing.' : '# Interrupted plan\n\nKeep this observed cut.'}\n${number === 4 ? '' : '</proposed_plan>'}`;
    const item={id:`plan_message_${number}`,type:'message',role:'assistant',status:'in_progress',phase:'final_answer',content:[]};
    event(res,'response.output_item.added',{output_index:0,item});
    event(res,'response.output_text.delta',{output_index:0,item_id:item.id,content_index:0,delta:planBody});
    if(number>1) { await new Promise(resolve=>{releaseFinal=resolve;}); releaseFinal=null; }
    if(res.destroyed)return;
    item.status='completed';item.content=[{type:'output_text',text:planBody,annotations:[]}];
    event(res,'response.output_item.done',{output_index:0,item});
    event(res,'response.completed',{response:{...response,status:'completed',output:[item]}});res.end();
  }
} });
const snapshot = () => page.evaluate(() => workspace.initial());
async function launch() {
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], ...(process.env.NAW_VIDEO_DIR ? { recordVideo: { dir: process.env.NAW_VIDEO_DIR, size: { width: 1280, height: 900 } } } : {}), env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  await until(async () => { for (const candidate of application.windows()) if (!candidate.isClosed() && await candidate.locator('#new-session').count().catch(() => 0)) { page = candidate; return true; } return false; }, 'Main workspace');
  page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
}

(async () => {
  await fixture.start(); await fixture.preflight();
  fs.writeFileSync(path.join(home, 'config.toml'), `model = "gpt-6-luna"\nmodel_provider = "local_fixture"\nmodel_reasoning_effort = "low"\ncli_auth_credentials_store = "file"\n[features]\ndaemon_auto_start = false\n[model_providers.local_fixture]\nname = "Local protocol fixture"\nbase_url = "${fixture.endpoint}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`, { mode: 0o600 });
  const shim = path.join(base, 'codex-local');
  fixture.wrapper(binary, { file: shim, env: { CODEX_HOME: home, HOME: userHome } });
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify({ codex: shim }), { mode: 0o600 });
  await launch();
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check();
  await page.locator('#session-name').fill('Native plans'); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions[0]?.state === 'idle', 'Native Codex ready');
  const before = (await snapshot()).sessions[0]; assert.equal(before.model, 'gpt-6-luna'); assert.equal(before.nativeVersion, nativeVersion);
  // NAW starts the session in its own folder inside the owned base. Codex 0.167's TUI shows another screen before
  // its trust prompt, so the prompt is not waited for: the folder is recorded as trusted before the TUI attaches.
  require('./native-trust.cjs').trustOwnedFolder({ home, base, folder: before.cwd });
  await page.locator('#message-input').fill('Prepare to plan this small example.'); await page.locator('#send-button').click();
  await until(async()=>(await snapshot()).sessions[0].messages.some(m=>m.text==='Ready for the plan.'),'Warmup complete');
  await page.locator('#terminal-tab').click();
  await require('./native-trust.cjs').acceptOwnedFolder(page, before.cwd);
  fs.writeFileSync(path.join(base,'native-attached.txt'),await page.locator('#terminal-area').innerText());
  const terminal=page.locator('#terminal-area'), input=terminal.locator('.xterm-helper-textarea');
  await until(async()=>(await terminal.innerText()).includes('Ready for the plan.'),'Native terminal ready',60000);
  await input.pressSequentially('/plan',{delay:70});
  await until(async()=>(await terminal.innerText()).includes('/plan'),'Native slash command edit line');
  fs.writeFileSync(path.join(base,'before-plan-command.txt'),await terminal.innerText());
  await input.press('Enter');
  await until(async()=>(await terminal.innerText()).includes('Model changed to gpt-6-luna medium for Plan mode.'),'Native Plan mode');
  fs.writeFileSync(path.join(base,'plan-mode.txt'),await terminal.innerText());
  await input.pressSequentially('Plan this small example.',{delay:10});
  await until(async()=>(await terminal.innerText()).includes('Plan this small example.'),'Native task edit line');
  await input.press('Enter');
  await until(()=>calls===2&&releaseFinal,'Native plan response');
  await until(async()=>(await terminal.innerText()).includes('Read the supplied example.'),'Native plan text');
  fs.writeFileSync(path.join(base,'native-plan.txt'),await terminal.innerText());
  await page.locator('#chat-tab').click();
  await page.locator('#messages').getByText('Read the supplied example.',{exact:true}).waitFor();
  const streaming=await snapshot(), row=streaming.sessions[0].messages.find(m=>m.kind==='plan');
  assert.ok(row);assert.equal(row.text,plan+'\n');assert.equal(row.status,'streaming');assert.equal(row.role,'assistant');
  fs.writeFileSync(path.join(base,'plan-streaming.json'),JSON.stringify(streaming,null,2));
  await page.locator('#message-input').fill('Unsent plan comment.');await page.reload();await page.locator('#new-session').waitFor();
  assert.equal(await page.locator('#message-input').inputValue(),'Unsent plan comment.');
  releaseFinal();
  await until(async()=>(await snapshot()).sessions[0].state==='idle','Native plan complete');
  const completed=await snapshot(),complete=completed.sessions[0].messages.find(m=>m.id===row.id);
  assert.equal(complete.text,plan+'\n');assert.equal(complete.status,'complete');
  assert.equal(completed.sessions[0].messages.filter(m=>m.kind==='plan').length,1);
  assert.equal(await page.locator('#native-activity').isVisible(), false, 'Completed turn has no visible running clock');
  // A completion footer is shown only for a native turn record that carries native time fields (Codex 0.167 reports
  // them for every turn; 0.163/0.164 reported none here). The reader adds none of its own.
  const nativeTurns=completed.sessions[0].messages.filter(m=>m.kind==='turn'&&m.nativeBlock&&Number.isFinite(m.nativeCompletedAt)&&Number.isSafeInteger(m.nativeDurationMs));
  assert.equal(await page.locator('#messages .reading-turn-footer').count(), nativeTurns.length, 'Every completion footer is a native turn record with native time fields; none is fabricated');
  for(const turn of nativeTurns) assert.equal(await page.locator('#messages [data-message-id="'+turn.id+'"] > .reading-turn-footer').count(), 1, 'Each native turn record has its own footer');
  assert.doesNotMatch(await page.locator('#messages').innerText(), /本轮已运行|Worked for|Cooked for|原生本轮已结束/);
  fs.writeFileSync(path.join(base,'plan-completed.json'),JSON.stringify(completed,null,2));
  checks.push('Native Plan command and input produce one streaming plan in the reader; completion replaces that same block');
  await page.locator('#terminal-tab').click();
  await until(async()=>(await terminal.innerText()).includes('Implement this plan?'),'Native implementation menu');
  fs.writeFileSync(path.join(base,'native-plan-completed.txt'),await terminal.innerText());
  // Escape dismisses a native menu; it must not be confused with interruption.
  await input.press('Escape');
  await until(async()=>!(await terminal.innerText()).includes('Implement this plan?'),'Native implementation menu dismissed');
  await page.locator('#chat-tab').click();
  await joinSpace(page);
  await page.locator('#room-nav').click();await page.locator('#room-record').click();
  await inlineRecipient(page, before.id);
  await fillRoomMessage(page, 'Plan this shared example.');await page.locator('#forward-button').click();
  await until(()=>calls===3&&releaseFinal,'One explicit shared task');
  await page.locator('#room-messages').getByText('Check this shared plan before continuing.',{exact:true}).waitFor();
  const shared=await snapshot();assert.ok(shared.room.messages.some(m=>m.kind==='plan'&&m.status==='streaming'));
  assert.ok(!shared.room.messages.some(m=>m.text?.includes('Read the supplied example.')),'Private plan never broadcast');
  fs.writeFileSync(path.join(base,'shared-streaming.json'),JSON.stringify(shared,null,2));
  if(process.env.NAW_EVIDENCE_DIR){fs.mkdirSync(process.env.NAW_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.NAW_EVIDENCE_DIR,'shared-plan.png')});}
  const sharedTag=shared.room.messages.find(m=>m.kind==='plan').sourceTag;
  releaseFinal();await until(async()=>(await snapshot()).sessions[0].state==='idle','Shared plan completes');
  const sharedCompleted=await snapshot();
  assert.equal(sharedCompleted.room.messages.find(m=>m.id===sharedTag).status,'submitted');
  assert.ok(sharedCompleted.room.messages.some(m=>m.kind==='plan'&&m.status==='complete'));
  assert.equal(sharedCompleted.room.messages.filter(m=>m.finalReply).length,0);assert.equal(calls,3);
  fs.writeFileSync(path.join(base,'shared-completed.json'),JSON.stringify(sharedCompleted,null,2));
  await page.locator(`[data-session-id="${before.id}"]`).click();await page.locator('#terminal-tab').click();
  await until(async()=>{const text=await terminal.innerText();return text.includes('Plan this shared example.')&&text.includes('Check this shared plan before continuing.');},'Completed shared plan visible in native terminal');
  await until(async()=>(await terminal.innerText()).includes('Implement this plan?'),'Shared native implementation menu');
  fs.writeFileSync(path.join(base,'native-shared-completed.txt'),await terminal.innerText());
  await input.press('Escape');
  await until(async()=>!(await terminal.innerText()).includes('Implement this plan?'),'Shared native menu dismissed');
  await page.locator('#room-nav').click();await page.locator('#room-record').click();
  // The earlier send used up its recipient mention; choose the member again, as a person does with @.
  await inlineRecipient(page, before.id);
  await fillRoomMessage(page, 'Start the next shared plan.');await page.locator('#forward-button').click();
  await until(()=>calls===4&&releaseFinal,'Last bounded shared task');
  await page.locator('#room-messages').getByText('Keep this observed cut.',{exact:true}).waitFor();
  await page.locator(`[data-session-id="${before.id}"]`).click();await page.locator('#terminal-tab').click();
  await until(async()=>{const text=await terminal.innerText();return text.includes('Start the next shared plan.')&&text.includes('Keep this observed cut.');},'Current native shared task and plan visible');
  await until(async()=>await input.evaluate(el=>el===document.activeElement),'Current native input focused');
  fs.writeFileSync(path.join(base,'native-shared.txt'),await terminal.innerText());
  await input.press('Escape');
  await until(async()=>(await snapshot()).sessions[0].messages.some(m=>m.kind==='plan'&&m.status==='interrupted'),'Native plan interrupted');
  releaseFinal();
  await page.locator('#chat-tab').click();
  const interrupted=await snapshot();assert.ok(interrupted.room.messages.some(m=>m.kind==='plan'&&m.status==='interrupted'));
  assert.ok(!interrupted.room.messages.some(m=>m.finalReply));assert.equal(interrupted.diagnostics.dispatches,3);assert.equal(calls,4);
  fs.writeFileSync(path.join(base,'interrupted.json'),JSON.stringify(interrupted,null,2));
  checks.push('Explicit shared request inherits native Plan mode; private plan remains private; plan completion retains submitted receipt without handoff; native Escape freezes shared plan without approval or handoff');
  await application.close();application=null;await launch();await page.locator('#new-session').waitFor();
  const reopened=await snapshot();assert.equal(reopened.sessions[0].nativeId,before.nativeId);assert.equal(reopened.sessions[0].pid,interrupted.sessions[0].pid);
  assert.deepEqual(reopened.sessions[0].messages,interrupted.sessions[0].messages);assert.deepEqual(reopened.room.messages,interrupted.room.messages);
  assert.equal(await page.locator('#message-input').inputValue(),'Unsent plan comment.');assert.equal(calls,4);assert.equal(reopened.diagnostics.dispatches,3);
  assert.equal(await page.locator('#native-activity').isVisible(), false, 'Reopened completed/interrupted history has no running clock');
  assert.doesNotMatch(await page.locator('#messages').innerText(), /本轮已运行|Worked for|Cooked for|原生本轮已结束/);
  fs.writeFileSync(path.join(base,'reopened.json'),JSON.stringify(reopened,null,2));
  checks.push('Whole-app reopen preserves native identity, original plan/cut, shared records and draft, with no extra submission');
  assert.ok(!budgetError);assert.deepEqual(errors,[]);fixture.assertClean();
  console.log(JSON.stringify({version,fixture:fixture.summary(),checks,evidence:base,localTaskResponses:calls,nativeTitleResponses:titleCalls,paidModelCalls:0}));
})().catch(async error => {
  if (page && !page.isClosed()) { fs.writeFileSync(path.join(base,'failure.json'),JSON.stringify(await snapshot().catch(()=>null),null,2)); fs.writeFileSync(path.join(base, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {}); }
  console.error(error.stack, '\nEvidence:', base, JSON.stringify({calls,titleCalls,releaseStart:Boolean(releaseStart),releaseFinal:Boolean(releaseFinal)})); process.exitCode = 1;
}).finally(testScratch.cleanup(async () => {
  releaseStart?.(); releaseFinal?.();
  if (application) await application.close().catch(() => {});
  try {
    const client = await connect(profile, 'native-plans-cleanup');
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
  await fixture.stop();
}));
