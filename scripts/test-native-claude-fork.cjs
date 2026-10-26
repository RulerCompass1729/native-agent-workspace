const testScratch = require('./fixtures/test-scratch.cjs');
// Real Electron + Claude Code 2.1.310 on a loopback fake API: "从已有 Claude 会话分支…"
// opens the native session picker in a new row's terminal and forks the chosen
// session into the row's pre-assigned ID; the original transcript is untouched.
// A cancelled picker ends the row saying no branch was made. The parent prompt
// also checks that Shift+Enter is a native newline. Two main turns at most, all
// fixed local replies; nothing paid, no profile edits.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..');
const { connectService } = require('../app/service-client.cjs');
const { executable } = require('../app/platform.cjs');
const base = testScratch.directory(path.join(os.tmpdir(), 'naw-native-claude-fork-'));
const profile = path.join(base, 'profile'), config = path.join(base, 'claude'), userHome = path.join(base, 'home');
for (const dir of [profile, config, userHome]) fs.mkdirSync(dir, { mode: 0o700 });
const binary = process.env.NAW_CLAUDE_BIN || executable('claude'); if (!binary) throw Error('Real Claude CLI required');
const nativeVersion = testScratch.childProcess.execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
assert.match(nativeVersion, /^2\.1\.310\b/, 'The picker fork is verified against the native contract of 2.1.310 only');
let application, page, client, mains = 0, titles = 0, budgetError;
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
    if (!main) { if (++titles > 2) return refuse('fork test budget: at most two native titles'); return reply(res, request.model, JSON.stringify({ title: 'Native fork check' })); }
    if (++mains > 2) return refuse('fork test budget: at most two main turns');
    // The branch turn must carry the parent's history: the fork copied it.
    if (mains === 1) assert.ok(userText(request).includes('PARENT_PROMPT\nSECOND_LINE'), 'Shift+Enter put a newline inside the one parent prompt');
    if (mains === 2) assert.ok(userText(request).includes('PARENT_PROMPT') && userText(request).includes('BRANCH_PROMPT'), 'The branch turn carries the parent history');
    reply(res, request.model, mains === 1 ? 'PARENT_REPLY' : 'BRANCH_REPLY');
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
function ownedNativeProcesses() {
  const marker = path.basename(base);
  return testScratch.childProcess.execFileSync('ps', ['-axE', '-ww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter(line => line.includes(marker) && / daemon run\b|bg-pty-host|bg-spare|^\s*\d+\s+claude |claude-message-tool\.cjs/.test(line))
    .map(line => ({ pid: Number(line.trim().split(/\s+/)[0]), daemon: / daemon run\b/.test(line) })).filter(p => p.pid);
}
async function cleanup() {
  for (let round = 0; round < 3 && ownedNativeProcesses().length; round++) {
    const owned = ownedNativeProcesses();
    for (const p of [...owned.filter(p => p.daemon), ...owned.filter(p => !p.daemon)]) { try { process.kill(p.pid, round ? 'SIGKILL' : 'SIGTERM'); } catch { /* gone */ } }
    await sleep(1500);
  }
  const survivors = ownedNativeProcesses().map(p => p.pid);
  if (application) await application.close().catch(() => {});
  if (client) { try { for (const s of (await snapshot()).sessions) await client.call('stop', s.id); await client.call('shutdown'); } finally { client.close(); } }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (survivors.length) throw Error('Owned native processes still alive: ' + survivors.join(','));
}
async function acceptKeyDialog() {
  if (!/Do you want to use this API key/.test(await terminalText())) return;
  await focusTerminal(); await page.keyboard.press('ArrowUp');
  await until(async () => (await terminalText()).includes('❯ Yes'), 'Native key choice moved to Yes', 5000); await page.keyboard.press('Enter');
}
async function openBranch() {
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check();
  const button = page.locator('#open-native-history');
  await until(async () => (await button.isVisible()) && (await button.innerText()) === '从已有 Claude 会话分支…', 'Branch entry offered for Claude');
  const before = new Set((await snapshot()).sessions.map(s => s.id));
  await button.click();
  await until(async () => (await snapshot()).sessions.some(s => !before.has(s.id)), 'Branch row created');
  return (await snapshot()).sessions.find(s => !before.has(s.id));
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const shim = path.join(base, 'claude-local');
  fs.writeFileSync(shim, '#!/usr/bin/python3\nimport os,sys\nfor key in ["ANTHROPIC_AUTH_TOKEN","CLAUDE_CODE_OAUTH_TOKEN","CLAUDE_CODE_CHILD_SESSION","CLAUDECODE","CLAUDE_CODE_SESSION_ID","CLAUDE_CODE_ENTRYPOINT"]: os.environ.pop(key,None)\nos.environ.update(' +
    `HOME=${JSON.stringify(userHome)},ANTHROPIC_BASE_URL=${JSON.stringify(`http://127.0.0.1:${server.address().port}`)},ANTHROPIC_API_KEY="local-fixture",CLAUDE_CONFIG_DIR=${JSON.stringify(config)},CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1")\n` +
    `os.execv(${JSON.stringify(binary)},["claude"]+sys.argv[1:]+["--model","haiku"])\n`, { mode: 0o700 });
  // Parent and branch both use the service's default folder, trusted up front.
  const serviceCwd = path.join(profile, 'workspace'); fs.mkdirSync(serviceCwd, { mode: 0o700 });
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [fs.realpathSync(serviceCwd)]: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ awaySummaryEnabled: false }), { mode: 0o600 });
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify({ claude: shim }), { mode: 0o600 });
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: serviceCwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 60000 });
  await until(async () => { for (const p of application.windows()) if (!p.isClosed() && await p.locator('#new-session').count().catch(() => 0)) { page = p; return true; } return false; }, 'Main window', 60000);
  page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  client = await connectService(profile, 'native-claude-fork-test');
  assert.ok((await snapshot()).capabilities.includes('claudeFork'), 'The service declares the picker branch');

  // 1. An existing Claude conversation with one turn, then its writer stops.
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check();
  await page.locator('#initial-view').selectOption('terminal'); await page.locator('#session-name').fill('Parent'); await page.locator('#confirm-create').click();
  await until(async () => /Do you want to use this API key/.test(await terminalText()) || (await snapshot()).sessions[0]?.chatAvailable, 'Parent startup', 60000);
  await acceptKeyDialog();
  await until(async () => (await snapshot()).sessions[0]?.chatAvailable, 'Parent ready', 60000);
  const parent = (await snapshot()).sessions[0];
  await focusTerminal(); await page.keyboard.type('PARENT_PROMPT', { delay: 20 });
  await until(async () => (await editLine()) === '❯ PARENT_PROMPT', 'Parent prompt on the edit line');
  await page.keyboard.press('Shift+Enter'); await page.keyboard.type('SECOND_LINE', { delay: 20 });
  await until(async () => /❯ PARENT_PROMPT\n\s*SECOND_LINE/.test(await terminalText()), 'Shift+Enter keeps the draft on two native lines');
  assert.equal(mains, 0, 'Shift+Enter did not submit'); await page.keyboard.press('Enter');
  await until(async () => (await snapshot()).sessions[0].messages.some(m => m.role === 'assistant' && m.text?.includes('PARENT_REPLY')) && (await snapshot()).sessions[0].state === 'idle', 'Parent reply', 60000);
  await sleep(1500); await client.call('stop', parent.id);
  await until(async () => (await snapshot()).sessions.find(s => s.id === parent.id).state === 'ended', 'Parent writer stopped', 30000);
  const parentBefore = transcripts()[parent.nativeId]; assert.ok(parentBefore?.text.includes('PARENT_PROMPT'), 'Parent transcript saved');

  // 2. Branch through the native picker into the row's pre-assigned ID.
  const branch = await openBranch();
  assert.equal(branch.view, 'terminal'); assert.notEqual(branch.nativeId, parent.nativeId); assert.equal(branch.forkPicker, true);
  await until(async () => /Resume session/.test(await terminalText()) || /Do you want to use this API key/.test(await terminalText()), 'Native picker or key dialog', 60000);
  await acceptKeyDialog();
  // The picker lists a session by its name (NAW passes --name), else its first prompt.
  await until(async () => /Resume session/.test(await terminalText()) && (await terminalText()).includes('❯ Parent'), 'Native picker lists the existing conversation', 30000);
  fs.writeFileSync(path.join(base, 'picker.txt'), await terminalText());
  await focusTerminal(); await page.keyboard.press('Enter');
  await until(async () => { const s = (await snapshot()).sessions.find(x => x.id === branch.id); return s.chatAvailable && s.forkPicker === false; }, 'Branch bound to its own session', 60000);
  await until(async () => (await terminalText()).includes('PARENT_REPLY'), 'Branch shows the copied history', 30000);
  await focusTerminal(); await page.keyboard.type('BRANCH_PROMPT', { delay: 20 });
  await until(async () => (await editLine()) === '❯ BRANCH_PROMPT', 'Branch prompt on the edit line'); await page.keyboard.press('Enter');
  await until(async () => (await snapshot()).sessions.find(x => x.id === branch.id).messages.some(m => m.role === 'assistant' && m.text?.includes('BRANCH_REPLY')), 'Branch reply in the reader', 60000);
  await sleep(1500);
  const after = transcripts(), bound = (await snapshot()).sessions.find(x => x.id === branch.id);
  assert.equal(bound.nativeId, branch.nativeId, 'The row keeps its pre-assigned native ID');
  assert.equal(after[parent.nativeId].sha, parentBefore.sha, 'The original transcript is unchanged');
  assert.ok(after[branch.nativeId]?.text.includes('PARENT_PROMPT') && after[branch.nativeId].text.includes('BRANCH_PROMPT'), 'The branch transcript holds the copied history and its own turn');
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'claude-branch.png') }); }

  // 3. A cancelled picker creates nothing and says so.
  const cancelled = await openBranch();
  await until(async () => /Resume session/.test(await terminalText()), 'Second native picker', 60000);
  await focusTerminal(); await page.keyboard.press('Escape');
  await until(async () => { const s = (await snapshot()).sessions.find(x => x.id === cancelled.id); return s.state === 'ended' && s.activity === '未选择会话，没有创建分支。'; }, 'Cancelled picker ends without a branch', 30000);
  assert.ok(!transcripts()[cancelled.nativeId], 'No transcript for the cancelled branch');
  assert.equal(mains, 2); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks: [
    'The branch entry opens the native picker in a new terminal row; the chosen conversation is forked into the row\'s pre-assigned ID with its history; the original transcript is byte-identical',
    'A cancelled picker ends the row saying no branch was made; no transcript is created'], nativeVersion, mainTurns: mains, nativeTitleResponses: titles, localResponses: received.length, paidModelCalls: 0, errors, evidence: base }));
})().catch(async error => {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(base, 'failure-terminal.txt'), await terminalText().catch(() => '')); }
  console.error(error.stack, '\nEvidence:', base); process.exitCode = 1;
}).finally(testScratch.cleanup(cleanup));
