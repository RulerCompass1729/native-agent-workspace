const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// Real Electron + real Claude CLI with one canned loopback reply: after a native
// /resume to another session the GUI must say the process switched (not that it
// is exiting), and after /background it must say the work moved to the native
// background (not that it ended). No paid inference, no user profile edits.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..');
const { connectService } = require('../app/service-client.cjs');
const { executable } = require('../app/platform.cjs');
const base = testScratch.directory(path.join(os.tmpdir(), 'naw-native-switch-test-'));
const profile = path.join(base, 'profile'), cwd = path.join(base, 'work'), config = path.join(base, 'claude'), userHome = path.join(base, 'home');
for (const dir of [profile, cwd, config, userHome]) fs.mkdirSync(dir, { mode: 0o700 });
const binary = process.env.NAW_CLAUDE_BIN || executable('claude'); if (!binary) throw Error('Real Claude CLI required');
const nativeVersion = testScratch.childProcess.execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
assert.match(nativeVersion, /^2\.1\.310\b/, 'Switch signals are verified against the native contract of 2.1.310 only');
const switchCase = process.env.NAW_SWITCH_CASE || 'resume'; if (!['resume', 'background', 'resume-background'].includes(switchCase)) throw Error('Unknown switch case');
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
    if (number > 1) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'switch test budget: one reply' } })); return; }
    const request = JSON.parse(body), text = 'SWITCH_PROBE_ONE\n';
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
// The native edit line is the last line that starts with the prompt marker.
const editLine = async () => ((await terminalText()).replace(/\u00a0/g, ' ').split('\n').filter(l => /^❯ /.test(l)).at(-1) || '').trim();
function ownedNativeProcesses() {
  // The native background daemon outlives the embedded process; it and its hosts
  // carry this test's temporary directory in their environment (macOS ps -E).
  const marker = path.basename(base);
  return testScratch.childProcess.execFileSync('ps', ['-axE', '-ww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter(line => line.includes(marker) && / daemon run\b|bg-pty-host|bg-spare|^\s*\d+\s+claude |claude-message-tool\.cjs/.test(line))
    .map(line => ({ pid: Number(line.trim().split(/\s+/)[0]), daemon: / daemon run\b/.test(line) })).filter(p => p.pid);
}
async function stopOwnedNative() {
  // Stop the daemon first: it replaces spare hosts that are killed before it.
  for (let round = 0; round < 3 && ownedNativeProcesses().length; round++) {
    const owned = ownedNativeProcesses();
    for (const p of [...owned.filter(p => p.daemon), ...owned.filter(p => !p.daemon)]) { try { process.kill(p.pid, round ? 'SIGKILL' : 'SIGTERM'); } catch { /* already gone */ } }
    await sleep(1500);
  }
  return ownedNativeProcesses().map(p => p.pid);
}
async function cleanup() {
  // The native background daemon is not owned by the app or service; stop it first.
  const survivors = await stopOwnedNative();
  if (application) await application.close().catch(() => {});
  if (client) { try { for (const s of (await snapshot()).sessions) await client.call('stop', s.id); await client.call('shutdown'); } finally { client.close(); } }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (survivors.length) throw Error('Owned native processes still alive: ' + survivors.join(','));
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
  // Native session recap fires a background model request when the embedded
  // terminal loses and regains focus (observed on 2.1.310 when switching tabs).
  // Turn it off for this isolated test so the reply budget measures only the switch.
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ awaySummaryEnabled: false }), { mode: 0o600 });
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify({ claude: shim }), { mode: 0o600 });
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 60000 });
  page = await application.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor(); client = await connectService(profile, 'native-branch-test');
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check();
  await page.locator('#session-name').fill('Branch follow'); await createIn(page, 'terminal');
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
  await sendFromGui('Say the first probe word.', 'SWITCH_PROBE_ONE');
  assert.equal(calls, 1);
  const original = (await snapshot()).sessions[0];
  if (switchCase !== 'background') {
  // /branch is followed (verified separately); it gives a second session to resume away from.
  await page.locator('#terminal-tab').click(); await page.locator('#terminal-area .xterm-screen').click();
  await page.keyboard.type('/branch'); await page.keyboard.press('Enter');
  await until(async () => { const s = (await snapshot()).sessions[0]; return s.nativeId !== original.nativeId && !s.nativeContextPending && s.chatAvailable; }, 'GUI follows the branch');
  const branched = (await snapshot()).sessions[0];
  await openChat(); await page.locator('#message-input').fill('切换前未发送的草稿');
  await page.locator('#terminal-tab').click(); await page.locator('#terminal-area .xterm-screen').click();
  // Inspect the native completion menu before each key: Tab accepts the highlighted
  // /resume, then the ID is typed and Enter is pressed only on that exact line.
  await page.keyboard.type('/resume');
  await until(async () => /❯ \/resume\b/.test(await terminalText()), 'Native menu highlights /resume');
  await stage('resume-menu'); await page.keyboard.press('Tab');
  // The native edit line then shows its argument hint: "/resume  [conversation id or search term]".
  await until(async () => /^❯ \/resume\b/.test(await editLine()), 'Completion accepted on the edit line');
  await page.keyboard.type(original.nativeId, { delay: 40 });
  await until(async () => (await editLine()) === `❯ /resume ${original.nativeId}`, 'Exact native command on the edit line');
  await stage('resume-line');
  assert.ok(!/Add directory|Directory path/.test(await terminalText()), 'No other native command opened');
  await page.keyboard.press('Enter');
  await until(async () => (await snapshot()).sessions[0].nativeContextPending?.reason === 'resume', 'Native resume away is observed', 20000);
  await sleep(1500);
  const away = (await snapshot()).sessions[0];
  const row = page.locator(`[data-session-id="${away.id}"]`);
  const awayStatus = await row.innerText();
  await stage('resume-away');
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'resume-away.png') }); fs.writeFileSync(path.join(process.env.NAW_EVIDENCE_DIR, 'resume-away.json'), JSON.stringify(away, null, 2)); }
  assert.equal(away.pid, branched.pid, 'Same native process'); assert.notEqual(away.state, 'ended');
  assert.ok(awayStatus.includes('原生已切换会话') && !awayStatus.includes('等待原生退出确认'), `Row says the process switched, not that it is exiting: ${awayStatus}`);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent === '结束这个原生会话…')?.hidden), false, 'Stop stays available while the native process is alive');
  assert.equal(away.nativeId, branched.nativeId, 'The GUI does not pretend to follow an unverified resume');
  await page.locator(`[data-session-id="${away.id}"]`).click(); await page.locator('#chat-tab').click();
  assert.equal(await page.locator('#message-input').inputValue(), '切换前未发送的草稿');
  assert.equal(calls, 1);
  checks.push('After a native /resume away the same process is shown as switched (not exiting), the GUI keeps its last verified identity and the draft');
  if (switchCase === 'resume-background') {
    await page.locator('#terminal-tab').click(); await page.locator('#terminal-area .xterm-screen').click();
    await page.keyboard.type('/background');
    await until(async () => (await editLine()).startsWith('❯ /background'), 'Background command on the resumed native edit line');
    await stage('resume-background-line'); await page.keyboard.press('Enter');
    await until(async () => ['background', 'ended', 'error', 'recoverable', 'disconnected'].includes((await snapshot()).sessions[0].state), 'Resumed native display leaves');
    const combined = (await snapshot()).sessions[0]; await stage('resume-background');
    if (process.env.NAW_EVIDENCE_DIR) { fs.writeFileSync(path.join(process.env.NAW_EVIDENCE_DIR, 'resume-background.json'), JSON.stringify(combined, null, 2)); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'resume-background.png') }); }
    assert.match(await terminalText(), /claude agents|claude attach/, 'The original native display reports its background handoff');
    assert.ok(ownedNativeProcesses().length > 0, 'The owned native background process really continues');
    assert.notEqual(combined.state, 'ended', 'This run proves the background handoff (TUI text and owned daemon above), so the row must not say ended');
    assert.ok(!(await row.innerText()).includes('已结束'));
    checks.push('Resume then background keeps the observed handoff or an explicit unknown state, without claiming that native work ended');
  }
  } else {
  await openChat(); await page.locator('#message-input').fill('切换前未发送的草稿');
  const row = page.locator(`[data-session-id="${original.id}"]`);
  await page.locator('#terminal-tab').click(); await page.locator('#terminal-area .xterm-screen').click();
  await page.keyboard.type('/background');
  await until(async () => (await editLine()).startsWith('❯ /background'), 'Exact native command on the edit line before Enter');
  await stage('background-line');
  await page.keyboard.press('Enter');
  await until(async () => ['background', 'ended', 'error'].includes((await snapshot()).sessions[0].state), 'Embedded native process left', 30000);
  const moved = (await snapshot()).sessions[0];
  await stage('background');
  if (process.env.NAW_EVIDENCE_DIR) { await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'background.png') }); fs.writeFileSync(path.join(process.env.NAW_EVIDENCE_DIR, 'background.json'), JSON.stringify(moved, null, 2)); fs.writeFileSync(path.join(process.env.NAW_EVIDENCE_DIR, 'background-processes.txt'), ownedNativeProcesses().map(p => p.pid).join('\n')); }
  assert.equal(moved.state, 'background', `Shown as moved to background, not ${moved.state}: ${moved.activity}`);
  assert.match(moved.activity, /claude agents/); assert.ok(ownedNativeProcesses().length > 0, 'The native daemon really continues');
  assert.ok((await row.innerText()).includes('已转到后台运行'));
  await page.locator(`[data-session-id="${moved.id}"]`).click(); await page.locator('#chat-tab').click();
  assert.equal(await page.locator('#message-input').inputValue(), '切换前未发送的草稿');
  assert.equal(await page.getByRole('button', { name: '继续原生会话', exact: true }).count(), 0, 'No resume of the stale ID is offered');
  assert.equal(calls, 1); assert.deepEqual(errors, []);
  checks.push('After a native /background the row says the work moved to the native background with its ID, offers no stale resume, and keeps the draft');
  }
  console.log(JSON.stringify({ checks, nativeVersion, localResponses: calls, paidModelCalls: 0, errors, evidence: base }));
})().catch(async error => {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(base, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  console.error(error.stack, '\nEvidence:', base); process.exitCode = 1;
}).finally(testScratch.cleanup(cleanup));
