const testScratch = require('./fixtures/test-scratch.cjs');
// One owned external Claude session → active-writer refusal → same-ID takeover.
// Real source Electron/native CLI, isolated HOME/config, fixed loopback replies.
// At most two main/two title responses and three native root launches; zero paid.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..');
const { connectService } = require('../app/service-client.cjs');
const { executable, processIdentity, processMayBeAlive } = require('../app/platform.cjs');
const { Terminal } = require('../app/adapters.cjs');
const base = testScratch.directory(path.join(os.tmpdir(), 'naw-native-claude-takeover-'));
const profile = path.join(base, 'profile'), config = path.join(base, 'claude'), userHome = path.join(base, 'home');
for (const dir of [profile, config, userHome]) fs.mkdirSync(dir, { mode: 0o700 });
const binary = process.env.NAW_CLAUDE_BIN || executable('claude'); if (!binary) throw Error('Real Claude CLI required');
const nativeVersion = testScratch.childProcess.execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
assert.match(nativeVersion, /^2\.1\.312\b/, 'This bounded takeover case uses the qualified 2.1.312 native contract');
let application, page, client, externalParent, parentIdentity, mains = 0, titles = 0, budgetError;
const received = [], errors = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 30000) {
  const start = Date.now(); while (Date.now() - start < timeout) { if (budgetError) throw budgetError; if (await fn()) return; await sleep(80); } throw Error(label);
}
function event(res, type, body) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`); }
function reply(res, model, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  event(res, 'message_start', { message: { id: 'msg_local_' + received.length, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  event(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  event(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
  event(res, 'content_block_stop', { index: 0 });
  event(res, 'message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
  event(res, 'message_stop', {}); res.end();
}
const userText = request => (request.messages || []).filter(m => m.role === 'user')
  .map(m => Array.isArray(m.content) ? m.content.map(c => c?.text || '').join('\n') : String(m.content || '')).join('\n');
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', data => body += data);
  req.on('end', () => {
    if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: 100, data: [] })); return; }
    const request = JSON.parse(body), main = (request.tools || []).length > 0;
    received.push({ main, at: Date.now() });
    fs.writeFileSync(path.join(base, `request-${received.length}.json`), JSON.stringify(request, null, 2));
    const refuse = message => { budgetError ||= Error(message); res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } })); };
    if (!main) { if (++titles > 2) return refuse('takeover test budget: at most two native titles'); return reply(res, request.model, JSON.stringify({ title: 'Native fork check' })); }
    if (++mains > 2) return refuse('takeover test budget: at most two main turns');
    if (mains === 1) assert.ok(userText(request).includes('PARENT_PROMPT'), 'One explicit parent prompt');
    if (mains === 2) assert.ok(userText(request).includes('PARENT_PROMPT') && userText(request).includes('TAKEOVER_PROMPT'), 'Takeover carries the original native history');
    reply(res, request.model, mains === 1 ? 'PARENT_REPLY' : 'TAKEOVER_REPLY');
  });
});
const snapshot = () => client.call('initial');
// Earlier rows keep their terminals in the DOM; read and type only into the visible one.
const terminalText = async () => (await page.locator('#terminal-area .xterm-rows').evaluateAll(rows => rows.filter(el => el.checkVisibility()).map(el => el.innerText).join('\n'))).replace(/ /g, ' ');
const focusTerminal = async () => { await page.locator('#terminal-area .xterm-screen >> visible=true').click(); };
const editLine = async () => ((await terminalText()).split('\n').filter(l => /^❯ /.test(l)).at(-1) || '').trim();
function transcripts() {
  const projects = path.join(config, 'projects'); const out = {};
  if (!fs.existsSync(projects)) return out;
  for (const dir of fs.readdirSync(projects)) for (const file of fs.readdirSync(path.join(projects, dir))) if (file.endsWith('.jsonl')) {
    const data = fs.readFileSync(path.join(projects, dir, file)); out[file.slice(0, -6)] = { sha: crypto.createHash('sha256').update(data).digest('hex'), text: data.toString('utf8') };
  }
  return out;
}

async function externalText() {
  await externalParent.snapshot();
  const buffer = externalParent.screen.buffer.active;
  return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i).translateToString(true)).join('\n').replace(/\u00a0/g, ' ');
}
async function cleanup() {
  let failure;
  try { if (externalParent?.alive) await externalParent.stop(10000); }
  catch (error) { failure = error; }
  if (application) await application.close().catch(() => {});
  if (client) { try { for (const s of (await snapshot()).sessions) await client.call('stop', s.id); await client.call('shutdown'); } finally { client.close(); } }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (parentIdentity && processMayBeAlive(parentIdentity)) failure ||= Error('Owned external parent exit is unconfirmed');
  if (failure) throw failure;
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const shim = path.join(base, 'claude-local');
  fs.writeFileSync(shim, '#!/usr/bin/python3\nimport os,sys\nfor key in ["ANTHROPIC_AUTH_TOKEN","CLAUDE_CODE_OAUTH_TOKEN","CLAUDE_CODE_CHILD_SESSION","CLAUDECODE","CLAUDE_CODE_SESSION_ID","CLAUDE_CODE_ENTRYPOINT"]: os.environ.pop(key,None)\nos.environ.update(' +
    `HOME=${JSON.stringify(userHome)},ANTHROPIC_BASE_URL=${JSON.stringify(`http://127.0.0.1:${server.address().port}`)},ANTHROPIC_API_KEY="local-fixture",CLAUDE_CONFIG_DIR=${JSON.stringify(config)},DISABLE_AUTOUPDATER="1",CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1",CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL="1")\n` +
    `extra=[] if sys.argv[1:2] in [["agents"],["--version"]] else ["--model","haiku"]\nos.execv(${JSON.stringify(binary)},["claude"]+sys.argv[1:]+extra)\n`, { mode: 0o700 });
  const serviceCwd = path.join(profile, 'workspace'); fs.mkdirSync(serviceCwd, { mode: 0o700 });
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [fs.realpathSync(serviceCwd)]: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ awaySummaryEnabled: false, promptSuggestionEnabled: false }), { mode: 0o600 });
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify({ claude: shim }), { mode: 0o600 });
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: serviceCwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 60000 });
  page = await application.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor(); client = await connectService(profile, 'native-claude-takeover-test');
  assert.ok((await snapshot()).capabilities.includes('claudeHistory'));
  assert.equal((await snapshot()).sessions.length, 0);

  // Outside NAW: a real interactive writer with no local row to deduplicate.
  const nativeId = crypto.randomUUID();
  externalParent = new Terminal([shim, '--session-id', nativeId, '--name', 'External parent', '--prompt-suggestions', 'false'], serviceCwd);
  await until(() => Boolean(externalParent.pid), 'Owned external native PID'); parentIdentity = processIdentity(externalParent.pid);
  await until(async () => /Do you want to use this API key|❯/.test(await externalText()), 'External startup', 60000);
  if ((await externalText()).includes('Do you want to use this API key')) {
    externalParent.input('\x1b[A');
    await until(async () => (await externalText()).includes('❯ Yes'), 'External native key selection'); externalParent.input('\r');
  }
  await until(async () => (await externalText()).split('\n').some(l => l.trim() === '❯'), 'External native edit line');
  externalParent.input('PARENT_PROMPT');
  await until(async () => (await externalText()).split('\n').some(l => l.trim() === '❯ PARENT_PROMPT'), 'Exact external task before Enter'); externalParent.input('\r');
  await until(async () => mains === 1 && (await externalText()).includes('PARENT_REPLY') && transcripts()[nativeId]?.text.includes('PARENT_REPLY'), 'External reply saved', 60000);
  fs.writeFileSync(path.join(base, 'external-parent.txt'), await externalText());

  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check();
  await page.locator('#claude-history-id-option').waitFor();
  assert.equal(await page.locator('#open-native-history').innerText(), '从已有 Claude 会话分支…', 'Blank retains the existing fork entry');
  assert.equal(await page.locator('#skip-permissions').isChecked(), false);
  assert.equal(await page.locator('#chosen-folder').innerText(), serviceCwd);
  await page.locator('#session-name').fill('Adopted parent');
  await page.locator('#claude-history-id').fill('not-a-uuid');
  for (const route of ['name-enter', 'primary', 'id-enter']) {
    if (route === 'name-enter') await page.locator('#session-name').press('Enter');
    else if (route === 'primary') await page.locator('#confirm-create').click();
    else await page.locator('#claude-history-id').press('Enter');
    await until(async () => (await page.locator('#toast').isVisible()) && (await page.locator('#toast').innerText()).includes('无效的原生会话标识'), 'Invalid ID refuses through ' + route);
    assert.equal((await snapshot()).sessions.length, 0); assert.equal(mains, 1);
    if (route !== 'id-enter') await page.locator('#toast').waitFor({ state: 'hidden' });
  }
  await page.locator('#claude-history-id').fill(nativeId.toUpperCase());
  assert.equal(await page.locator('#open-native-history').innerText(), '接管此 Claude 会话');
  const heldHistory = transcripts()[nativeId].sha;
  await page.locator('#open-native-history').click();
  await until(async () => /可能正在写入|活动连接或后台工作/.test(await page.locator('#toast').innerText()), 'Actual active native writer refused');
  assert.equal((await snapshot()).sessions.length, 0); assert.equal(await page.locator('#create-dialog').isVisible(), true);
  assert.equal(await page.locator('#claude-history-id').inputValue(), nativeId.toUpperCase());
  assert.equal(transcripts()[nativeId].sha, heldHistory); assert.equal(processMayBeAlive(parentIdentity), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'workspace.json'))).sessions.length, 0, 'Refusal removes its reserved disk row');
  fs.writeFileSync(path.join(base, 'active-writer-refused.json'), JSON.stringify(await snapshot(), null, 2));
  await page.screenshot({ path: path.join(base, 'active-writer-refused.png') });

  await externalParent.stop(10000); assert.equal(externalParent.nativeExited, true); assert.equal(processMayBeAlive(parentIdentity), false);
  await page.locator('#open-native-history').click();
  await page.locator('#create-dialog').waitFor({ state: 'hidden' });
  await until(async () => { const s = (await snapshot()).sessions[0]; return s?.externalHistory === true && s.nativeId === nativeId && s.chatAvailable; }, 'True external import bound to original identity', 60000);
  const adopted = (await snapshot()).sessions[0];
  assert.equal(adopted.provider, 'claude'); assert.equal(adopted.view, 'terminal'); assert.equal(adopted.name, 'Adopted parent');
  assert.notEqual(adopted.pid, parentIdentity.pid); assert.notEqual(adopted.forkPicker, true); assert.notEqual(adopted.nativePermissionMode, 'bypassPermissions');
  await until(async () => (await terminalText()).includes('PARENT_REPLY'), 'The same native transcript is present');
  assert.equal(mains, 1, 'Takeover itself never replays the old task');
  fs.writeFileSync(path.join(base, 'adopted.json'), JSON.stringify(await snapshot(), null, 2));
  await page.screenshot({ path: path.join(base, 'adopted-history.png') });
  await page.locator('#chat-tab').click(); await page.locator('#message-input').fill('TAKEOVER_PROMPT'); await page.locator('#send-button').click();
  await until(async () => { const s = (await snapshot()).sessions[0]; return s.state === 'idle' && s.messages.some(m => m.text?.includes('TAKEOVER_REPLY')); }, 'Explicit GUI task completes with original history', 60000);
  const completed = (await snapshot()).sessions[0]; assert.equal(completed.nativeId, nativeId); assert.equal(completed.pid, adopted.pid);
  await page.locator('#message-input').fill('Unsent takeover draft.');
  await until(async () => (await snapshot()).sessions[0].liveDraft === 'Unsent takeover draft.', 'Takeover draft persisted');
  await page.reload(); await page.locator('#new-session').waitFor(); await page.locator(`[data-session-id="${adopted.id}"]`).click(); await page.locator('#chat-tab').click();
  assert.equal(await page.locator('#message-input').inputValue(), 'Unsent takeover draft.');
  assert.equal((await snapshot()).sessions[0].pid, adopted.pid); assert.equal((await snapshot()).sessions[0].nativeId, nativeId);
  await page.screenshot({ path: path.join(base, 'takeover-complete.png') });

  // A syntactically valid missing ID must fail natively, never become a new task.
  const missingId = crypto.randomUUID();
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check();
  await page.locator('#claude-history-id').fill(missingId); await page.locator('#open-native-history').click();
  await until(async () => { const s = (await snapshot()).sessions.find(s => s.nativeId === missingId); return s?.state === 'ended' && /No conversation found/i.test(await terminalText()); }, 'Missing history reports native failure without fresh-session fallback', 60000);
  assert.equal(transcripts()[missingId], undefined); assert.deepEqual(Object.keys(transcripts()), [nativeId]);
  assert.equal(mains, 2); assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(base, 'missing-native.txt'), await terminalText());
  fs.writeFileSync(path.join(base, 'finished.json'), JSON.stringify(await snapshot(), null, 2));
  await page.screenshot({ path: path.join(base, 'missing-history.png') });
  console.log(JSON.stringify({ checks: ['Actual external writer refused without stopping it or retaining a reserved row', 'Explicit UUID continues the same native history without fork/replay, an actual GUI task completes, reload keeps ID/PID/draft', 'Invalid and missing UUIDs never silently create a fresh session'], nativeVersion, mainTurns: mains, nativeTitleResponses: titles, localResponses: received.length, nativeRootLaunches: 3, paidModelCalls: 0, errors, evidence: base }));
})().catch(async error => {
  if (externalParent) fs.writeFileSync(path.join(base, 'external-failure.txt'), await externalText().catch(() => ''));
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(base, 'failure-terminal.txt'), await terminalText().catch(() => '')); fs.writeFileSync(path.join(base, 'failure-body.txt'), await page.locator('body').innerText().catch(() => '')); }
  console.error(error.stack, '\nEvidence:', base); process.exitCode = 1;
}).finally(testScratch.cleanup(cleanup));
