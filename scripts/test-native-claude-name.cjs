const testScratch = require('./fixtures/test-scratch.cjs');
// Real Electron + Claude Code 2.1.310 on a loopback fake API: a session created
// without a name is launched without --name, so Claude generates its own title,
// and the row takes it as "Claude · <title>"; a desktop rename still wins.
// One main turn and one native title, both fixed local replies; nothing paid.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..');
const { connectService } = require('../app/service-client.cjs');
const { executable } = require('../app/platform.cjs');
const base = testScratch.directory(path.join(os.tmpdir(), 'naw-native-claude-name-'));
const profile = path.join(base, 'profile'), config = path.join(base, 'claude'), userHome = path.join(base, 'home');
for (const dir of [profile, config, userHome]) fs.mkdirSync(dir, { mode: 0o700 });
const binary = process.env.NAW_CLAUDE_BIN || executable('claude'); if (!binary) throw Error('Real Claude CLI required');
const nativeVersion = testScratch.childProcess.execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
assert.match(nativeVersion, /^2\.1\.310\b/, 'The generated-title source is verified against 2.1.310 only');
let application, page, client, mains = 0, titles = 0, budgetError;
const received = [], errors = [], checks = [];
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
    if (!main) { if (++titles > 1) return refuse('name test budget: one native title'); return reply(res, request.model, JSON.stringify({ title: 'Synthetic Fixture Title' })); }
    if (++mains > 1) return refuse('name test budget: one main turn');
    reply(res, request.model, 'NAME_REPLY');
  });
});
const snapshot = () => client.call('initial');
// Earlier rows keep their terminals in the DOM; read and type only into the visible one.
const terminalText = async () => (await page.locator('#terminal-area .xterm-rows').evaluateAll(rows => rows.filter(el => el.checkVisibility()).map(el => el.innerText).join('\n'))).replace(/ /g, ' ');
const focusTerminal = async () => { await page.locator('#terminal-area .xterm-screen >> visible=true').click(); };
const editLine = async () => ((await terminalText()).split('\n').filter(l => /^❯ /.test(l)).at(-1) || '').trim();
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
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const shim = path.join(base, 'claude-local');
  fs.writeFileSync(shim, '#!/usr/bin/python3\nimport os,sys\nfor key in ["ANTHROPIC_AUTH_TOKEN","CLAUDE_CODE_OAUTH_TOKEN","CLAUDE_CODE_CHILD_SESSION","CLAUDECODE","CLAUDE_CODE_SESSION_ID","CLAUDE_CODE_ENTRYPOINT"]: os.environ.pop(key,None)\nos.environ.update(' +
    `HOME=${JSON.stringify(userHome)},ANTHROPIC_BASE_URL=${JSON.stringify(`http://127.0.0.1:${server.address().port}`)},ANTHROPIC_API_KEY="local-fixture",CLAUDE_CONFIG_DIR=${JSON.stringify(config)},CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1")\n` +
    `os.execv(${JSON.stringify(binary)},["claude"]+sys.argv[1:]+["--model","haiku"])\n`, { mode: 0o700 });
  // The service's default folder, trusted up front.
  const serviceCwd = path.join(profile, 'workspace'); fs.mkdirSync(serviceCwd, { mode: 0o700 });
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [fs.realpathSync(serviceCwd)]: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ awaySummaryEnabled: false }), { mode: 0o600 });
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify({ claude: shim }), { mode: 0o600 });
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: serviceCwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 60000 });
  await until(async () => { for (const p of application.windows()) if (!p.isClosed() && await p.locator('#new-session').count().catch(() => 0)) { page = p; return true; } return false; }, 'Main window', 60000);
  page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  client = await connectService(profile, 'native-claude-name-test');

  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check();
  await page.locator('#initial-view').selectOption('terminal'); assert.equal(await page.locator('#session-name').inputValue(), ''); await page.locator('#confirm-create').click();
  await until(async () => /Do you want to use this API key/.test(await terminalText()) || (await snapshot()).sessions[0]?.chatAvailable, 'Startup', 60000);
  await acceptKeyDialog();
  await until(async () => (await snapshot()).sessions[0]?.chatAvailable, 'Ready', 60000);
  const row = (await snapshot()).sessions[0]; assert.equal(row.autoName, true); assert.equal(row.name, 'Claude 1');
  const argv = testScratch.childProcess.execFileSync('ps', ['-ww', '-o', 'args=', '-p', String(row.pid)], { encoding: 'utf8' });
  assert.ok(argv.includes(row.nativeId) && !argv.includes('--name'), 'An unnamed session is launched without --name');
  await focusTerminal(); await page.keyboard.type('NAME_PROMPT', { delay: 20 });
  await until(async () => (await editLine()) === '❯ NAME_PROMPT', 'Prompt on the edit line'); await page.keyboard.press('Enter');
  await until(async () => (await snapshot()).sessions[0].messages.some(m => m.role === 'assistant' && m.text?.includes('NAME_REPLY')) && (await snapshot()).sessions[0].state === 'idle', 'Reply', 60000);
  await until(async () => (await snapshot()).sessions[0].name === 'Claude · Synthetic Fixture Title', 'The row takes the native generated title', 30000);
  const link = page.locator(`[data-session-id="${row.id}"]`);
  await until(async () => (await link.innerText()).includes('Claude · Synthetic Fixture Title'), 'The sidebar shows it');
  checks.push('An unnamed Claude session is launched without --name and the row takes Claude\'s generated title with the provider name');
  await page.evaluate(id => workspace.rename(id, 'My own name'), row.id);
  await until(async () => (await link.innerText()).includes('My own name') && !(await link.innerText()).includes('Synthetic Fixture Title'), 'A desktop rename wins');
  checks.push('A desktop rename is shown instead of the native title');
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'claude-name.png') }); }
  assert.equal(mains, 1); assert.equal(titles, 1); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, nativeVersion, mainTurns: mains, nativeTitleResponses: titles, localResponses: received.length, paidModelCalls: 0, errors, evidence: base }));
})().catch(async error => {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(base, 'failure-terminal.txt'), await terminalText().catch(() => '')); }
  console.error(error.stack, '\nEvidence:', base); process.exitCode = 1;
}).finally(testScratch.cleanup(cleanup));
