// Real Electron + real Claude CLI; canned responses are served on loopback.
// No paid inference, user profile edits, global keyboard input, or foregrounding.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const { connectService } = require('../app/service-client.cjs');
const { executable } = require('../app/platform.cjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-native-block-test-'));
const profile = path.join(base, 'profile'), cwd = path.join(base, 'work'), config = path.join(base, 'claude');
for (const dir of [profile, cwd, config]) fs.mkdirSync(dir, { mode: 0o700 });
const binary = executable('claude'); if (!binary) throw Error('Real Claude CLI required');
const nativeVersion = require('node:child_process').execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
assert.match(nativeVersion, /^2\.1\.(307|308)\b/, 'Verify the updated native contract before sending a test task');
let application, page, client, calls = 0, held, releaseFinal;
const errors = [], checks = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 30000) {
  const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await sleep(75); } throw Error(label);
}
function event(res, type, body) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`); }
function block(res, index, content) {
  event(res, 'content_block_start', { index, content_block: content.type === 'text' ? { type: 'text', text: '' } : { ...content, input: {} } });
  event(res, 'content_block_delta', { index, delta: content.type === 'text' ? { type: 'text_delta', text: content.text } : { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } });
  event(res, 'content_block_stop', { index });
}
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', data => body += data); req.on('end', async () => {
    if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: 100, data: [] })); return;
    }
    const number = ++calls;
    if (number > 3) { res.writeHead(429); res.end(); return; }
    const request = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    event(res, 'message_start', { message: { id: `msg_local_${number}`, type: 'message', role: 'assistant', model: request.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    if (number === 1) {
      block(res, 0, { type: 'text', text: 'NATIVE_FIRST: checking locally.\n' });
      block(res, 1, { type: 'tool_use', id: 'toolu_local_block', name: 'Bash', input: { command: 'printf "NATIVE_TOOL: 42\\n"', description: 'Print the local test marker' } });
    } else if (number === 2) {
      await new Promise(resolve => { releaseFinal = resolve; });
      block(res, 0, { type: 'text', text: 'NATIVE_FINAL: the result is 42.\n' });
    } else {
      event(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      event(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'NATIVE_PARTIAL: still working.\n' } });
      held = res; return;
    }
    event(res, 'message_delta', { delta: { stop_reason: number === 1 ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
    event(res, 'message_stop', {}); res.end();
  });
});
const snapshot = () => client.call('initial');
async function cleanup() {
  releaseFinal?.(); held?.destroy();
  if (application) await application.close().catch(() => {});
  if (client) { try { for (const s of (await snapshot()).sessions) await client.call('stop', s.id); await client.call('shutdown'); } finally { client.close(); } }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const shim = path.join(base, 'claude-local');
  // A selected executable is the supported native-discovery setting. No
  // production adapter methods are replaced by this test.
  fs.writeFileSync(shim, '#!/usr/bin/python3\nimport os,sys\nos.environ.pop("ANTHROPIC_AUTH_TOKEN",None)\nos.environ.pop("CLAUDE_CODE_OAUTH_TOKEN",None)\nos.environ.update(' +
    `ANTHROPIC_BASE_URL=${JSON.stringify(`http://127.0.0.1:${server.address().port}`)},ANTHROPIC_API_KEY="local-fixture",CLAUDE_CONFIG_DIR=${JSON.stringify(config)},CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1")\n` +
    `os.execv(${JSON.stringify(binary)},["claude"]+sys.argv[1:]+["--model","haiku","--allowedTools","Bash(printf:*)"])\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [fs.realpathSync(cwd)]: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify({ claude: shim }), { mode: 0o600 });
  application = await _electron.launch({ executablePath: require('electron'), args: [root], ...(process.env.NAW_VIDEO_DIR ? { recordVideo: { dir: process.env.NAW_VIDEO_DIR, size: { width: 1280, height: 900 } } } : {}), env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await application.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor(); client = await connectService(profile, 'native-block-test');
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check();
  await page.locator('#initial-view').selectOption('terminal'); await page.locator('#session-name').fill('Native blocks'); await page.locator('#confirm-create').click();
  await until(async () => /Yes, I trust this folder|Do you want to use this API key/.test(await page.locator('#terminal-area').innerText()) || (await snapshot()).sessions[0]?.chatAvailable, 'Native startup');
  if ((await page.locator('#terminal-area').innerText()).includes('Yes, I trust this folder')) {
    assert.ok((await page.locator('#terminal-area').innerText()).includes(fs.realpathSync(cwd)));
    await page.locator('#terminal-area .xterm-screen').click(); await page.keyboard.press('ArrowDown'); await sleep(200); await page.keyboard.press('Enter');
  }
  await until(async () => (await page.locator('#terminal-area').innerText()).includes('Do you want to use this API key') || (await snapshot()).sessions[0]?.chatAvailable, 'Native key prompt');
  if ((await page.locator('#terminal-area').innerText()).includes('Do you want to use this API key')) {
    await page.locator('#terminal-area .xterm-screen').click(); await page.keyboard.press('ArrowUp'); await sleep(200); await page.keyboard.press('Enter');
  }
  await until(async () => (await snapshot()).sessions[0]?.chatAvailable, 'Native submission bridge', 60000);
  const before = (await snapshot()).sessions[0];
  await page.getByRole('button', { name: '加入协作', exact: true }).click();
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await page.locator('#mention-button').click(); await page.locator(`[data-mention-id="${before.id}"]`).click();
  await page.locator('#shared-input').fill('Run the local check.'); await page.locator('#forward-button').click();
  await page.locator(`[data-session-id="${before.id}"]`).click(); await page.locator('#chat-tab').click();
  await until(() => calls === 2, 'Native tool loop');
  await until(async () => (await snapshot()).sessions[0].messages.some(m => m.text.includes('NATIVE_TOOL: 42')), 'Tool content before final reply');
  const live = (await snapshot()).sessions[0];
  assert.equal(live.state, 'working');
  await page.locator('#messages').getByText('NATIVE_FIRST: checking locally.', { exact: true }).waitFor();
  assert.match(await page.locator('#messages').innerText(), /NATIVE_TOOL: 42/);
  assert.equal(await page.locator('.native-progress').count(), 0);
  checks.push('Native intermediate text and tool result appear in the main reading stream before final response');
  releaseFinal();
  await until(async () => (await snapshot()).sessions[0].messages.some(m => m.kind === 'turn'), 'Native turn boundary');
  await until(async () => (await snapshot()).room.messages.some(m => m.role === 'assistant' && m.text.includes('NATIVE_FINAL:')), 'Display-confirmed shared final reply');
  const first = (await snapshot()).sessions[0];
  assert.equal(first.messages.filter(m => m.text.includes('NATIVE_FINAL:')).length, 1);
  assert.equal(first.messages.filter(m => m.text.includes('NATIVE_FIRST:')).length, 1);
  assert.equal(first.nativeId, before.nativeId); assert.equal(first.pid, before.pid);
  const tool = first.messages.find(m => m.kind === 'tool'); assert.match(tool.input, /printf/); assert.equal(tool.status, 'complete');
  assert.ok(first.messages.findIndex(m => m.kind === 'tool') < first.messages.findIndex(m => m.text.includes('NATIVE_FINAL:')));
  await sleep(1100);
  assert.ok(!fs.readFileSync(path.join(profile, 'workspace.json'), 'utf8').includes('NATIVE_TOOL: 42'));
  checks.push('Stable block order, display-confirmed shared reply, same native process, tool content remains volatile');
  await page.locator('#message-input').fill('Start the interrupt check.'); await page.locator('#send-button').click();
  await until(() => calls === 3 && held, 'Held native stream');
  await until(async () => (await snapshot()).sessions[0].messages.some(m => m.text.includes('NATIVE_PARTIAL:')), 'Partial native display');
  await page.locator('#interrupt').click();
  await until(async () => (await snapshot()).sessions[0].messages.some(m => m.kind === 'turn' && m.status === 'interrupted'), 'Native interruption boundary');
  const after = (await snapshot()).sessions[0];
  assert.ok(after.messages.some(m => m.text.includes('NATIVE_PARTIAL:')));
  assert.equal(calls, 3); assert.deepEqual(errors, []);
  checks.push('Actual native interruption retains streamed text and records its confirmed boundary');
  const nativeId = after.nativeId, nativePid = after.pid;
  await page.locator('#terminal-tab').click();
  await page.locator('#terminal-area .xterm-screen').click();
  await page.keyboard.type('/clear'); await page.keyboard.press('Enter');
  await until(async () => { const s = (await snapshot()).sessions[0]; return s.nativeId !== nativeId && !s.nativeContextPending && s.chatAvailable; }, 'Native clear on the verified version');
  const cleared = (await snapshot()).sessions[0];
  assert.equal(cleared.pid, nativePid); assert.ok(cleared.messages.some(m => m.text.includes('NATIVE_PARTIAL:'))); assert.equal(calls, 3);
  await page.locator('#chat-tab').click();
  checks.push('Native clear changes context identity without replacing the process, discarding local history or making another model call');
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'native-blocks.png') }); }
  console.log(JSON.stringify({ checks, nativeVersion, localResponses: calls, paidModelCalls: 0, errors, evidence: base }));
})().catch(async error => {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(base, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  console.error(error.stack, '\nEvidence:', base); process.exitCode = 1;
}).finally(cleanup);
