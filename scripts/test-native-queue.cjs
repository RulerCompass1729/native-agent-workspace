// Real Electron + real Claude CLI; canned responses are served on loopback.
// No paid inference, user profile edits, global keyboard input, or foregrounding.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connectService } = require(path.join(code, 'app/service-client.cjs'));
const { executable } = require(path.join(code, 'app/platform.cjs'));
const shared = process.env.NAW_QUEUE_SHARED === '1';
const input = shared ? '#shared-input' : '#message-input', send = shared ? '#forward-button' : '#send-button';
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-native-queue-test-'));
const profile = path.join(base, 'profile'), cwd = path.join(base, 'work'), config = path.join(base, 'claude');
for (const dir of [profile, cwd, config]) fs.mkdirSync(dir, { mode: 0o700 });
const located = executable('claude'), binary = located && fs.realpathSync(located); if (!binary) throw Error('Real Claude CLI required');
const nativeVersion = require('node:child_process').execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
assert.match(nativeVersion, /^2\.1\.(308|309)\b/, 'Verify the updated native contract before sending a test task');
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
    if (number > 2) { res.writeHead(429); res.end(); return; }
    const request = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    event(res, 'message_start', { message: { id: `msg_local_${number}`, type: 'message', role: 'assistant', model: request.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    fs.writeFileSync(path.join(base, `request-${number}.json`), body);
    if (number > 2) throw Error('Native request budget exceeded');
    block(res, 0, { type: 'text', text: number === 1 ? 'FIRST_NATIVE_WORK: original task.\n' : 'QUEUED_NATIVE_REPLY: next task.\n' });
    const finish = () => {
      event(res, 'message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
      event(res, 'message_stop', {}); res.end();
    };
    if (number === 1) { held = res; releaseFinal = finish; } else finish();
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
    `ANTHROPIC_BASE_URL=${JSON.stringify(`http://127.0.0.1:${server.address().port}`)},ANTHROPIC_API_KEY="local-fixture",CLAUDE_CONFIG_DIR=${JSON.stringify(config)},CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1",DISABLE_AUTOUPDATER="1")\n` +
    `os.execv(${JSON.stringify(binary)},["claude"]+sys.argv[1:]+["--model","haiku","--allowedTools","Bash(printf:*)"])\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [fs.realpathSync(cwd)]: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify({ claude: shim }), { mode: 0o600 });
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], ...(process.env.NAW_VIDEO_DIR ? { recordVideo: { dir: process.env.NAW_VIDEO_DIR, size: { width: 1280, height: 900 } } } : {}), env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
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
  assert.equal(before.queueAvailable, true);
  await page.locator('#chat-tab').click();
  await page.locator('#message-input').fill('Run the original local task.'); await page.locator('#send-button').click();
  await until(() => calls === 1 && held, 'Native original task');
  await until(async () => (await snapshot()).sessions[0].state === 'working', 'Working native state');
  await until(async () => (await page.locator('#send-button').innerText()) === '等本轮结束后发送 ↑', 'Working composer receives state');
  if (shared) {
    await page.locator('#message-input').fill('Private solo draft.');
    await page.locator('#header-actions').getByRole('button', { name: '加入协作', exact: true }).click();
    await page.locator('#room-nav').click(); await page.locator('#room-record').click();
    await page.locator('#mention-button').click(); await page.locator(`[data-mention-id="${before.id}"]`).click();
    await until(async () => (await page.locator(send).innerText()) === '等本轮结束后发送 ↑', 'Shared native waiting action');
  }
  await page.locator(input).fill('Do the next local task.');
  assert.equal(await page.locator(send).innerText(), '等本轮结束后发送 ↑');
  await page.locator(send).click();
  await until(async () => (await snapshot()).sessions[0].pendingQueue, 'Waiting native input');
  const pending = (await snapshot()).sessions[0];
  assert.equal(pending.messages.filter(m => m.text === 'Do the next local task.').length, 1);
  assert.equal(pending.messages.at(-1).status, 'awaiting-native');
  assert.equal(await page.locator(input).inputValue(), 'Do the next local task.');
  await until(() => page.locator(send).isDisabled(), 'Pending queue reaches composer');
  assert.equal(await page.locator(send).isDisabled(), true);
  // Covers both the former 15 s submission and 40 s RPC deadlines with one
  // native task. No polling prompts or repeat inference.
  await sleep(42000);
  const waiting = (await snapshot()).sessions[0];
  assert.equal(waiting.pendingQueue, pending.pendingQueue); assert.equal(waiting.state, 'working');
  assert.equal(calls, 1); assert.equal(waiting.nativeId, before.nativeId); assert.equal(waiting.pid, before.pid);
  assert.equal(waiting.messages.find(m => m.id === pending.pendingQueue).status, 'awaiting-native');
  assert.ok(!(await page.locator('#toast').innerText()).includes('超时'));
  fs.writeFileSync(path.join(base, 'waiting.json'), JSON.stringify(await snapshot(), null, 2));
  if (shared) {
    const room = (await snapshot()).room;
    assert.equal(room.messages.filter(m => m.text === 'Do the next local task.').length, 1);
    assert.equal(room.messages.find(m => m.id === pending.pendingQueue).deliveries[0].status, 'awaiting-native');
    assert.ok(!JSON.stringify(room.messages).includes('FIRST_NATIVE_WORK'));
    assert.ok(!JSON.stringify(room.messages).includes('Private solo draft'));
  }
  checks.push('One native waiting input survives both old deadlines without interrupt, retry or extra inference');
  await page.locator(input).fill('A newer unsent draft.');
  if (!shared) await until(async () => (await snapshot()).sessions[0].liveDraft === 'A newer unsent draft.', 'Newer draft persisted');
  if (shared) await page.locator(`[data-session-id="${before.id}"]`).click();
  await page.locator('#terminal-tab').click();
  assert.equal((await snapshot()).sessions[0].pendingQueue, pending.pendingQueue);
  await page.locator('#chat-tab').click();
  if (shared) { await page.locator('#room-nav').click(); await page.locator('#room-record').click(); }
  await page.reload(); await page.locator('#new-session').waitFor();
  await until(async () => await page.locator(input).inputValue() === 'A newer unsent draft.', 'Pending queue draft after reload');
  assert.equal(await page.locator(send).isDisabled(), true);
  assert.equal((await snapshot()).sessions[0].pendingQueue, pending.pendingQueue);
  assert.equal(calls, 1);
  checks.push('View changes and actual renderer reload preserve the pending native task and editable draft without replay');
  releaseFinal(); releaseFinal = null;
  await until(() => calls === 2, 'Second native task starts');
  await until(async () => { const s = (await snapshot()).sessions[0]; return s.state === 'idle' && !s.pendingQueue && s.messages.some(m => m.text.includes('QUEUED_NATIVE_REPLY')); }, 'Queued native completion');
  const completed = (await snapshot()).sessions[0];
  assert.equal(completed.nativeId, before.nativeId); assert.equal(completed.pid, before.pid);
  assert.equal(completed.messages.filter(m => m.text === 'Do the next local task.').length, 1);
  assert.equal(completed.messages.find(m => m.id === pending.pendingQueue).status, 'submitted');
  assert.equal(await page.locator(input).inputValue(), 'A newer unsent draft.');
  const actual = JSON.parse(fs.readFileSync(path.join(base, 'request-2.json'), 'utf8'));
  assert.equal(actual.messages.filter(m => m.role === 'user').flatMap(m => typeof m.content === 'string' ? [m.content] : m.content.filter(b => b.type === 'text').map(b => b.text)).filter(t => t === 'Do the next local task.').length, 1);
  fs.writeFileSync(path.join(base, 'completed.json'), JSON.stringify(await snapshot(), null, 2));
  checks.push('Native consumes the queued prompt once after the original turn; native identity and newer draft remain intact');
  if (shared) {
    const room = (await snapshot()).room, source = room.messages.find(m => m.id === pending.pendingQueue);
    assert.equal(source.deliveries[0].status, 'submitted');
    assert.equal(source.deliveries[0].text, 'Do the next local task.');
    assert.equal(room.messages.filter(m => m.text?.includes('QUEUED_NATIVE_REPLY')).length, 1);
    assert.equal(room.messages.find(m => m.text?.includes('QUEUED_NATIVE_REPLY')).replyTo, source.id);
    assert.ok(!JSON.stringify(room.messages).includes('FIRST_NATIVE_WORK'));
    assert.equal(completed.liveDraft, 'Private solo draft.');
    await until(async () => (await page.locator('#room-messages').innerText()).includes('QUEUED_NATIVE_REPLY'), 'Shared native reply in main reader');
    assert.ok(!(await page.locator('#room-messages').innerText()).includes('FIRST_NATIVE_WORK'));
    checks.push('Shared native next-prompt receipt publishes one attributed reply; original private output and solo draft stay private');
  }
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'native-queue.png') }); }
  if (shared) await page.locator(`[data-session-id="${before.id}"]`).click();
  await page.locator('#terminal-tab').click(); await sleep(250);
  const terminal = await page.locator('#terminal-area').innerText();
  fs.writeFileSync(path.join(base, 'terminal.txt'), terminal);
  assert.match(terminal, /Run the original local task/); assert.match(terminal, /Do the next local task/); assert.match(terminal, /QUEUED_NATIVE_REPLY/);
  assert.equal(calls, 2); assert.deepEqual(errors, []);
  checks.push('Actual native terminal and main conversation contain the same two inputs and replies');
  console.log(JSON.stringify({ checks, shared, nativeVersion, localResponses: calls, paidModelCalls: 0, errors, evidence: base }));
})().catch(async error => {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(base, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  console.error(error.stack, '\nEvidence:', base); process.exitCode = 1;
}).finally(cleanup);
