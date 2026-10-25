const testScratch = require('./fixtures/test-scratch.cjs');
// Real Electron + real Claude CLI with two canned loopback replies: a native
// /branch must keep the row, process, history and draft, and GUI sending must
// reach the branched session. No paid inference, no user profile edits.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..');
const { connectService } = require('../app/service-client.cjs');
const { executable } = require('../app/platform.cjs');
const base = testScratch.directory(path.join(os.tmpdir(), 'naw-native-branch-test-'));
const profile = path.join(base, 'profile'), cwd = path.join(base, 'work'), config = path.join(base, 'claude'), userHome = path.join(base, 'home');
for (const dir of [profile, cwd, config, userHome]) fs.mkdirSync(dir, { mode: 0o700 });
const binary = process.env.NAW_CLAUDE_BIN || executable('claude'); if (!binary) throw Error('Real Claude CLI required');
const nativeVersion = testScratch.childProcess.execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
assert.match(nativeVersion, /^2\.1\.310\b/, 'Branch following is verified against the native contract of 2.1.310 only');
let application, page, client, calls = 0;
const errors = [], checks = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 30000) {
  const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await sleep(75); } throw Error(label);
}
function event(res, type, body) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`); }
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', data => body += data); req.on('end', () => {
    if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: 100, data: [] })); return;
    }
    const number = ++calls;
    fs.writeFileSync(path.join(base, `request-${number}.json`), body);
    if (number > 2) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'branch test budget: two replies' } })); return; }
    const request = JSON.parse(body), text = number === 1 ? 'BRANCH_PROBE_ONE\n' : 'BRANCH_PROBE_TWO\n';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    event(res, 'message_start', { message: { id: `msg_local_${number}`, type: 'message', role: 'assistant', model: request.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    event(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    event(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
    event(res, 'content_block_stop', { index: 0 });
    event(res, 'message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
    event(res, 'message_stop', {}); res.end();
  });
});
const snapshot = () => client.call('initial');
const terminalText = () => page.locator('#terminal-area .xterm-rows').innerText();
async function cleanup() {
  if (application) await application.close().catch(() => {});
  if (client) { try { for (const s of (await snapshot()).sessions) await client.call('stop', s.id); await client.call('shutdown'); } finally { client.close(); } }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
async function openChat() {
  // Selecting the row in the sidebar claims this window's view; the composer
  // stays read-only until then.
  const s = (await snapshot()).sessions[0];
  await page.locator(`[data-session-id="${s.id}"]`).click(); await page.locator('#chat-tab').click();
  await until(async () => !(await page.locator('#message-input').evaluate(el => el.readOnly)), 'GUI composer editable');
}
async function sendFromGui(text, marker) {
  await openChat();
  await page.locator('#message-input').fill(text);
  await until(() => page.locator('#send-button').isEnabled(), 'Send enabled for a non-empty draft');
  await page.locator('#send-button').click();
  await until(async () => { const s = (await snapshot()).sessions[0]; return s.state === 'idle' && s.messages.some(m => m.text?.includes(marker)); }, `GUI send reaches native and ${marker} is read back`);
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const shim = path.join(base, 'claude-local');
  fs.writeFileSync(shim, '#!/usr/bin/python3\nimport os,sys\nfor key in ["ANTHROPIC_AUTH_TOKEN","CLAUDE_CODE_OAUTH_TOKEN","CLAUDE_CODE_CHILD_SESSION","CLAUDECODE","CLAUDE_CODE_SESSION_ID","CLAUDE_CODE_ENTRYPOINT"]: os.environ.pop(key,None)\nos.environ.update(' +
    `HOME=${JSON.stringify(userHome)},ANTHROPIC_BASE_URL=${JSON.stringify(`http://127.0.0.1:${server.address().port}`)},ANTHROPIC_API_KEY="local-fixture",CLAUDE_CONFIG_DIR=${JSON.stringify(config)},CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1")\n` +
    `os.execv(${JSON.stringify(binary)},["claude"]+sys.argv[1:]+["--model","haiku"])\n`, { mode: 0o700 });
  // The service starts a new session in <profile>/workspace; trust it up front
  // so the only native dialog left is the API key choice.
  const serviceCwd = path.join(profile, 'workspace'); fs.mkdirSync(serviceCwd, { mode: 0o700 });
  const trusted = Object.fromEntries([cwd, serviceCwd].map(dir => [fs.realpathSync(dir), { hasTrustDialogAccepted: true }]));
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: trusted }), { mode: 0o600 });
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify({ claude: shim }), { mode: 0o600 });
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 60000 });
  page = await application.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor(); client = await connectService(profile, 'native-branch-test');
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check();
  await page.locator('#initial-view').selectOption('terminal'); await page.locator('#session-name').fill('Branch follow'); await page.locator('#confirm-create').click();
  const nativeInput = page.locator('#terminal-area .xterm-helper-textarea');
  const stage = async name => fs.writeFileSync(path.join(base, `startup-${name}.txt`), await terminalText());
  await until(async () => /Do you want to use this API key|Yes, I trust this folder/.test(await terminalText()) || (await snapshot()).sessions[0]?.chatAvailable, 'Native startup', 60000);
  await stage('first-dialog');
  assert.ok(!(await terminalText()).includes('Yes, I trust this folder'), 'Trust dialog should not appear for the pre-trusted service cwd');
  if ((await terminalText()).includes('Do you want to use this API key')) {
    // Move the native selection and confirm the move before pressing Enter.
    await nativeInput.press('ArrowUp');
    await until(async () => (await terminalText()).includes('❯ Yes'), 'Native key choice moved to Yes', 5000);
    await stage('key-yes-selected'); await nativeInput.press('Enter');
  }
  await until(async () => { const s = (await snapshot()).sessions[0]; if (s?.state === 'ended') throw Error('Native session ended during startup'); return s?.chatAvailable; }, 'Native submission bridge', 60000);
  await stage('ready');
  assert.ok(!(await terminalText()).includes('Transcript saving is off'), 'Native transcript persistence must be on, as in a normal launch');
  await sendFromGui('Say the first probe word.', 'BRANCH_PROBE_ONE');
  assert.equal(calls, 1);
  await openChat(); await page.locator('#message-input').fill('分支前未发送的草稿');
  const before = (await snapshot()).sessions[0];
  assert.equal(before.nativeContexts?.length || 0, 0);
  await page.locator('#terminal-tab').click(); await page.locator('#terminal-area .xterm-screen').click();
  await page.keyboard.type('/branch'); await page.keyboard.press('Enter');
  await until(async () => (await terminalText()).includes('Branched conversation'), 'Native branch confirmation in the same TUI');
  await until(async () => { const s = (await snapshot()).sessions[0]; return s.nativeId !== before.nativeId && !s.nativeContextPending && s.chatAvailable && s.state === 'idle'; }, 'GUI follows the branched native session');
  const after = (await snapshot()).sessions[0];
  assert.equal(after.id, before.id); assert.equal(after.pid, before.pid, 'Same native process');
  assert.ok((await terminalText()).includes(after.nativeId), 'The branch ID shown by the native TUI is the one the GUI now tracks');
  assert.equal(after.nativeContexts.length, 1); assert.equal(after.nativeContexts[0].nativeId, before.nativeId); assert.equal(after.nativeContexts[0].reason, 'branch');
  assert.ok(after.messages.some(m => m.text?.includes('BRANCH_PROBE_ONE')), 'Pre-branch history retained');
  const boundary = after.messages.find(m => m.kind === 'context'); assert.match(boundary.text, /分支/);
  await openChat();
  assert.equal(await page.locator('#message-input').inputValue(), '分支前未发送的草稿', 'Draft kept across the branch');
  assert.equal(calls, 1, 'Following the branch made no model request');
  checks.push('Native /branch keeps the same row and process, retains history and draft, records a labelled branch boundary and reopens GUI submission');
  await sendFromGui('Say the second probe word.', 'BRANCH_PROBE_TWO');
  const final = (await snapshot()).sessions[0];
  assert.equal(final.nativeId, after.nativeId); assert.equal(calls, 2); assert.deepEqual(errors, []);
  assert.ok((await terminalText()).includes('BRANCH_PROBE_TWO'), 'The same TUI shows the reply to the GUI message sent into the branch');
  checks.push('A GUI message sent after the branch reaches the branched native session and its reply is read back');
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'native-branch.png') }); fs.writeFileSync(path.join(process.env.NAW_EVIDENCE_DIR, 'native-branch-final.json'), JSON.stringify(final, null, 2)); }
  console.log(JSON.stringify({ checks, nativeVersion, localResponses: calls, paidModelCalls: 0, errors, evidence: base }));
})().catch(async error => {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(base, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  console.error(error.stack, '\nEvidence:', base); process.exitCode = 1;
}).finally(testScratch.cleanup(cleanup));
