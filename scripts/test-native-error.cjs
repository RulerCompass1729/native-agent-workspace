const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// Real Electron + real Claude CLI; canned responses are served on loopback.
// No paid inference, user profile edits, global keyboard input, or foregrounding.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..');
const { connectService } = require('../app/service-client.cjs');
const { executable } = require('../app/platform.cjs');
const base = testScratch.directory(path.join(os.tmpdir(), 'naw-native-block-test-'));
const profile = path.join(base, 'profile'), cwd = path.join(base, 'work'), config = path.join(base, 'claude');
for (const dir of [profile, cwd, config]) fs.mkdirSync(dir, { mode: 0o700 });
const binary = executable('claude'); if (!binary) throw Error('Real Claude CLI required');
const nativeVersion = testScratch.childProcess.execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
assert.match(nativeVersion, /^2\.1\.(307|308|309|310|311)\b/, 'Verify the updated native contract before sending a test task');
let application, page, client, calls = 0, recovering = false, recoveryCalls = 0;
const errors = [], checks = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 30000) {
  const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await sleep(75); } throw Error(label);
}
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', data => body += data); req.on('end', async () => {
    if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: 100, data: [] })); return;
    }
    // A rejected request is resent at once in compatibility variants (2.1.311: the
    // original and 7 more, varying optional betas and replacing deferred tool search
    // with the full tool list), then fails; one recovery task follows.
    const number = ++calls; if(number > 10){ res.destroy(); server.close(); return; }
    fs.writeFileSync(path.join(base, `request-${number}.json`), body);
    if (recovering) {
      assert.equal(++recoveryCalls, 1, 'One explicit new task, no portal retry');
      const request = JSON.parse(body);
      const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({type, ...data})}\n\n`);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      event('message_start', {message:{id:'msg_local_recovery',type:'message',role:'assistant',model:request.model,content:[],stop_reason:null,usage:{input_tokens:10,output_tokens:0}}});
      event('content_block_start', {index:0,content_block:{type:'text',text:''}});
      event('content_block_delta', {index:0,delta:{type:'text_delta',text:'NATIVE_RECOVERY: the new task completed.\n'}});
      event('content_block_stop', {index:0});
      event('message_delta', {delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:10}});
      event('message_stop', {}); res.end(); return;
    }
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'NATIVE_FAILURE_FIXTURE: selected model is unavailable.' } }));

  });
});
const snapshot = () => client.call('initial');
async function cleanup() {
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
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], ...(process.env.NAW_VIDEO_DIR ? { recordVideo: { dir: process.env.NAW_VIDEO_DIR, size: { width: 1280, height: 900 } } } : {}), env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await application.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor(); client = await connectService(profile, 'native-block-test');
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check();
  await page.locator('#session-name').fill('Native blocks'); await createIn(page, 'terminal');
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
  await page.locator('#chat-tab').click();
  await page.locator('#message-input').fill('Explain the local error.'); await page.locator('#send-button').click();
  await until(() => calls >= 1, 'Native request');
  await until(async () => (await snapshot()).sessions[0].state === 'error' || (await snapshot()).sessions[0].messages.some(m=>m.kind==='turn'&&m.status==='failed'), 'Native failure boundary');
  await sleep(1000);
  const state = await snapshot(); fs.writeFileSync(path.join(base,'error-state.json'),JSON.stringify(state,null,2));
  assert.match(await page.locator('#compose-hint').innerText(), /原生请求未完成|上次请求失败/);
  const reader = await page.locator('#messages').innerText();fs.writeFileSync(path.join(base,'error-reader.txt'),reader);
  await page.locator('#terminal-tab').click();
  await until(async()=> (await page.locator('#terminal-area').innerText()).includes('NATIVE_FAILURE_FIXTURE'), 'Native terminal displays error');
  fs.writeFileSync(path.join(base,'error-terminal.txt'),await page.locator('#terminal-area').innerText());
  await page.screenshot({path:path.join(base,'error-terminal.png')});
  await page.locator('#chat-tab').click();await page.screenshot({path:path.join(base,'error-reader.png')});
  assert.match(reader,/NATIVE_FAILURE_FIXTURE: selected model is unavailable\./,'Specific native failure is readable in the main conversation');
  // Every request so far carries the one task once: variants of it, never a repeat.
  for (let n = 1; n <= calls; n++) { const sent = JSON.parse(fs.readFileSync(path.join(base, `request-${n}.json`), 'utf8')); assert.equal(sent.messages.length, 2, 'One task per request'); assert.equal(JSON.stringify(sent).split('Explain the local error.').length - 1, 1, 'The task appears once'); }
  assert.ok(calls >= 1 && calls <= 8, 'One native failure: ' + calls);assert.deepEqual(errors,[]);
  assert.equal(state.sessions[0].nativeId,before.nativeId);assert.equal(state.sessions[0].pid,before.pid);
  assert.equal(state.diagnostics.dispatches,1);
  assert.equal(state.sessions[0].messages.filter(m=>m.kind==='turn'&&m.text.includes('NATIVE_FAILURE_FIXTURE')).length,1);
  assert.ok(!state.room.messages.some(m=>m.finalReply));
  if (process.env.NAW_ERROR_RECOVERY === '1') {
    assert.equal(await page.locator('#message-input').getAttribute('readonly'), null, 'Explicit new human input is available after a confirmed request failure');
    assert.equal(state.sessions[0].failedTurnInputAvailable, true);
    recovering = true;
    await page.locator('#message-input').fill('Continue with a new small task after the failed request.');
    await page.locator('#send-button').click();
    await until(async () => (await snapshot()).sessions[0].state === 'idle' && (await page.locator('#messages').innerText()).includes('NATIVE_RECOVERY'), 'Explicit GUI task after native API failure');
    const after = await snapshot();
    assert.equal(recoveryCalls, 1); assert.equal(after.diagnostics.dispatches, 2);
    assert.equal(after.sessions[0].nativeId, before.nativeId); assert.equal(after.sessions[0].pid, before.pid);
    assert.equal(after.sessions[0].failedTurnInputAvailable, false);
    assert.match(await page.locator('#messages').innerText(), /NATIVE_FAILURE_FIXTURE/);
    await page.screenshot({path:path.join(base,'recovered-reader.png')});
    await page.locator('#terminal-tab').click();
    await until(async () => (await page.locator('#terminal-area').innerText()).includes('NATIVE_RECOVERY'), 'Same native terminal shows recovery');
    fs.writeFileSync(path.join(base,'recovered-terminal.txt'),await page.locator('#terminal-area').innerText());
    await page.screenshot({path:path.join(base,'recovered-terminal.png')});
    fs.writeFileSync(path.join(base,'recovered-state.json'),JSON.stringify(after,null,2));
  }
  console.log(JSON.stringify({checks:['One native error is visible in the unified reader and original terminal', ...(recovering ? ['Explicit new GUI input succeeds once in the same session, retaining its failure record'] : [])],nativeVersion,localResponses:calls,paidModelCalls:0,evidence:base}));

})().catch(async error => {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(base, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  console.error(error.stack, '\nEvidence:', base); process.exitCode = 1;
}).finally(testScratch.cleanup(cleanup));
