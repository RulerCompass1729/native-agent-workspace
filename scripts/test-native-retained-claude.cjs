const { chooseRecipient: inlineRecipient, fillRoomMessage, roomBody } = require('./room-input.cjs');
// Actual alpha.2 backend + Claude 2.1.302 + current Electron. Three loopback
// responses (four with NAW_RETAINED_QUEUE=1, five with NAW_RETAINED_SHARED=1), zero paid inference. No original profile or global keyboard access.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), { fork, execFileSync } = require('node:child_process');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
if (!process.env.NAW_APP_EXECUTABLE) execFileSync(process.execPath, [path.join(root, 'scripts/build-ui.cjs')]);
const { connectService, connect } = require(path.join(code, 'app/service-client.cjs'));
const { installPlugin } = require(path.join(code, 'app/legacy-input.cjs'));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-native-retained-claude-'));
const profile = path.join(base, 'profile'), cwd = path.join(base, 'work'), config = path.join(base, 'claude'), old = path.join(base, 'old'), bin = path.join(base, 'bin');
for (const directory of [profile, cwd, config, old, bin]) fs.mkdirSync(directory, { mode: 0o700 });
const binary = process.env.NAW_CLAUDE_302;
assert.ok(binary, 'Set NAW_CLAUDE_302 to the retained native executable');
const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(); assert.match(version, /^2\.1\.302\b/);
const archive = execFileSync('git', ['archive', 'a87653b', 'app', 'package.json'], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
execFileSync('/usr/bin/tar', ['-x', '-C', old], { input: archive }); fs.symlinkSync(path.join(root, 'node_modules'), path.join(old, 'node_modules'));
const sharedQueueTrial = process.env.NAW_RETAINED_SHARED_QUEUE === '1';
const quitQueueTrial = process.env.NAW_RETAINED_QUEUE_QUIT === '1';
const queueTrial = sharedQueueTrial || process.env.NAW_RETAINED_QUEUE === '1', sharedTrial = process.env.NAW_RETAINED_SHARED === '1';
assert.ok(!(queueTrial && sharedTrial), 'Choose one bounded scenario');
assert.ok(!quitQueueTrial || sharedQueueTrial, 'Whole-app pending quit uses the shared waiting scenario');
const toolHistoryTrial = process.env.NAW_RETAINED_TOOL_HISTORY === '1';
const modelOnly = process.env.NAW_MODEL_ONLY === '1';
const errorTrial = process.env.NAW_RETAINED_ERROR === '1';
assert.ok(!errorTrial || !(modelOnly || queueTrial || sharedTrial || toolHistoryTrial), 'Error trial is a single bounded task');
const errorRecovery = errorTrial && process.env.NAW_ERROR_RECOVERY === '1';
const budget = errorTrial ? 7 : modelOnly ? 0 : sharedTrial ? 5 : queueTrial ? 4 : 3;
let child, client, application, page, calls = 0, finishFinal, recovering = false, recoveryCalls = 0;
const checks = [], errors = [], sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 30000) { const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await sleep(75); } throw Error(label); }
function event(res, type, data) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`); }
function block(res, index, item) {
  event(res, 'content_block_start', { index, content_block: item.type === 'text' ? { type: 'text', text: '' } : { ...item, input: {} } });
  event(res, 'content_block_delta', { index, delta: item.type === 'text' ? { type: 'text_delta', text: item.text } : { type: 'input_json_delta', partial_json: JSON.stringify(item.input) } });
  event(res, 'content_block_stop', { index });
}
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', b => body += b); req.on('end', () => {
    if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":100,"data":[]}'); return; }
    const number = ++calls; if (number > budget) { res.writeHead(429); res.end(); return; }
    const input = JSON.parse(body); fs.writeFileSync(path.join(base, `request-${number}.json`), body);
    if (errorTrial && !recovering) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'NATIVE_FAILURE_FIXTURE: selected model is unavailable.' } })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    event(res, 'message_start', { message: { id: `msg_retained_${number}`, type: 'message', role: 'assistant', model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    const finish = reason => { event(res, 'message_delta', { delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 30 } }); event(res, 'message_stop', {}); res.end(); };
    if (recovering) { assert.equal(++recoveryCalls, 1); block(res, 0, {type:'text',text:'RETAINED_ERROR_RECOVERY: new task completed.\n'}); finish('end_turn'); return; }
    if (number === 1) { block(res, 0, { type: 'text', text: 'RETAINED_HISTORY: original native answer.\n' }); finish('end_turn'); }
    if (number === 2) {
      block(res, 0, { type: 'text', text: 'RETAINED_PROGRESS: inspect the local result.\n' });
      block(res, 1, { type: 'tool_use', id: 'toolu_retained', name: 'Bash', input: { command: 'printf "RETAINED_TOOL: 42\\n"', description: 'Print the local fixture' } }); finish('tool_use');
    }
    if (number === 4 && !sharedTrial) { block(res, 0, { type: 'text', text: 'RETAINED_QUEUED_REPLY: next instruction received.\n' }); finish('end_turn'); }
    if (number === 4 && sharedTrial) {
      block(res, 0, { type: 'text', text: 'RETAINED_PERMISSION_PREFIX: await native permission.\n' });
      block(res, 1, { type: 'tool_use', id: 'toolu_permission', name: 'Bash', input: { command: 'node -e "process.stdout.write(\'RETAINED_APPROVED_TOOL\')"', description: 'Print an approval fixture' } }); finish('tool_use');
    }
    if (number === 5) { block(res, 0, { type: 'text', text: 'RETAINED_PRIVATE_AFTER_PERMISSION: task complete.\n' }); finish('end_turn'); }
    if (number === 3) {
      event(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      event(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'RETAINED_FINAL_PREFIX: checking the native result.\n' } });
      finishFinal = () => { event(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: '42.\n' } }); event(res, 'content_block_stop', { index: 0 }); finish('end_turn'); finishFinal = null; };
    }
  });
});
const snapshot = () => page.evaluate(() => workspace.initial());
async function launch() {
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    ...(process.env.NAW_VIDEO_DIR ? { recordVideo: { dir: process.env.NAW_VIDEO_DIR, size: { width: 1280, height: 900 } } } : {}),
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await application.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  if (sharedTrial) await application.evaluate(({ app }) => {
    const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
    const { Claude } = load('./app/adapters.cjs'), original = Claude.prototype.observeBlock;
    globalThis.retainedBoundaryTrace = [];
    Claude.prototype.observeBlock = function (message) {
      const result = original.call(this, message);
      globalThis.retainedBoundaryTrace.push({ kind: message.kind, id: message.id, sequence: message.sequence, epoch: message.epoch });
      return result;
    };
  });
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  installPlugin(cwd);
  // Boot with the already released compatibility hook, then exercise the
  // actual explicit reload upgrade in this same native process.
  fs.writeFileSync(path.join(cwd, '.claude/skills/native-workspace-compat/hooks/register.js'),
    execFileSync('git', ['show', (errorTrial ? 'b2c8b67' : quitQueueTrial ? '03c44d8' : '2fe9784') + ':app/claude-bridge/hooks/register.js'], { cwd: root, encoding: 'utf8' }).replace('const legacyOnly = false;', 'const legacyOnly = true;'), { mode: 0o600 });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/usr/bin/python3\nimport os,sys\nos.environ.pop("ANTHROPIC_AUTH_TOKEN",None)\nos.environ.pop("CLAUDE_CODE_OAUTH_TOKEN",None)\nos.environ.update(' +
    `ANTHROPIC_BASE_URL=${JSON.stringify(`http://127.0.0.1:${server.address().port}`)},ANTHROPIC_API_KEY="local-fixture",CLAUDE_CONFIG_DIR=${JSON.stringify(config)},CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1")\n` +
    `os.execv(${JSON.stringify(binary)},["claude"]+sys.argv[1:]+["--model","haiku","--debug-file",${JSON.stringify(path.join(base, 'native-debug.log'))},"--allowedTools","Bash(printf:*)"])\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [fs.realpathSync(cwd)]: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
  child = fork(path.join(old, 'app/daemon.cjs'), [profile], { env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
    NAW_APP_VERSION: '0.1.0-alpha.2', NAW_WORKSPACE: cwd }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Original backend boot');
  client = await connectService(profile, 'retained-fixture'); const id = await client.call('create', { provider: 'claude', cwd, name: 'Retained Claude', view: 'terminal' });
  await launch(); await page.locator(`[data-session-id="${id}"]`).click(); await page.locator('#terminal-tab').click();
  const takeover = page.locator('#take-control');
  if (await takeover.isVisible()) await takeover.click();
  await until(async () => /Yes, I trust this folder|Do you want to use this API key|Claude Code v2/.test(await page.locator('#terminal-area').innerText()), 'Native boot', 60000);
  if ((await page.locator('#terminal-area').innerText()).includes('Yes, I trust this folder')) {
    assert.ok((await page.locator('#terminal-area').innerText()).includes(fs.realpathSync(cwd)));
    await page.locator('#terminal-area .xterm-screen').click(); await page.keyboard.press('ArrowDown'); await sleep(200); await page.keyboard.press('Enter');
  }
  await until(async () => /Do you want to use this API key|Claude Code v2/.test(await page.locator('#terminal-area').innerText()), 'Native key choice');
  if ((await page.locator('#terminal-area').innerText()).includes('Do you want to use this API key')) {
    await page.locator('#terminal-area .xterm-screen').click(); await page.keyboard.press('ArrowUp'); await sleep(200); await page.keyboard.press('Enter');
  }
  await until(async () => (await snapshot()).sessions.find(s => s.id === id)?.state === 'idle', 'Old native session ready');
  const before = (await snapshot()).sessions.find(s => s.id === id);
  if (!modelOnly && !errorTrial) {
  await page.locator('#terminal-area .xterm-screen').click(); await page.keyboard.type('Keep the original history.'); await page.keyboard.press('Enter');
  await until(async () => (await snapshot()).sessions.find(s => s.id === id).messages.some(m => m.text.includes('RETAINED_HISTORY:')), 'Old hooks recorded native reply');
  }
  await page.locator('#chat-tab').click();
  if (await page.locator('#send-button').textContent() === '接管此窗口') await page.locator('#send-button').click();
  assert.equal(await page.locator('#send-button').textContent(), '接通原会话输入'); await page.locator('#send-button').click();
  await until(async () => (await snapshot()).sessions.find(s => s.id === id)?.legacySubmit, 'Existing input plugin connected');
  await page.locator('#chat-tab').click();
  const linked = (await snapshot()).sessions.find(s => s.id === id);
  if (quitQueueTrial) assert.equal(fs.readFileSync(path.join(cwd, '.claude/skills/native-workspace-compat/hooks/register.js'), 'utf8'),
    fs.readFileSync(path.join(code, 'app/claude-bridge/hooks/register.js'), 'utf8').replace('const legacyOnly = false;', 'const legacyOnly = true;'),
    'Released alpha.69 hook is upgraded to the exact current hook without replacing the native process');
  // The native file watcher may already have reloaded the updated project
  // plugin. Explain the pending case, but never require an obsolete warning.
  if (linked.legacyReaderPending) await until(async () => (await page.locator('#compose-hint').innerText()).includes('实时过程尚待更新') ||
    (await snapshot()).sessions.find(s => s.id === id).nativeBlockMapping, 'Pending reader notice or confirmed native hot reload');
  else assert.equal(linked.nativeBlockMapping, true);
  assert.equal(await page.locator('#message-input').getAttribute('readonly'), null);
  await page.locator('#terminal-tab').click(); await page.locator('#terminal-area .xterm-screen').click();
  await page.keyboard.type('/reload-plugins');
  await until(async () => (await page.locator('#terminal-area').innerText()).includes('/reload-plugins'), 'Native reload command shown');
  await sleep(300); await page.keyboard.press('Enter');
  await until(async () => { const s = (await snapshot()).sessions.find(s => s.id === id); return s.nativeBlockMapping && s.legacySubmit; }, 'Same-process reader and input ready');
  await page.locator('#chat-tab').click();
  if (errorTrial) {
    await page.locator('#message-input').fill('Explain the local error.'); await page.locator('#send-button').click();
    await until(async () => (await snapshot()).sessions.find(s => s.id === id).messages.some(m => m.kind === 'turn' && m.text.includes('NATIVE_FAILURE_FIXTURE')), 'Retained error detail in main reader');
    assert.match(await page.locator('#messages').innerText(), /NATIVE_FAILURE_FIXTURE/);
    await until(async () => /原生请求未完成|上次请求失败/.test(await page.locator('#compose-hint').innerText()), 'Error guidance supersedes plugin reload');
    assert.ok(!(await page.locator('#compose-hint').innerText()).includes('/reload-plugins'));
    await page.screenshot({ path: path.join(base, 'error-reader.png') });
    await page.locator('#terminal-tab').click();
    await until(async () => (await page.locator('#terminal-area').innerText()).includes('NATIVE_FAILURE_FIXTURE'), 'Native retained terminal error');
    await page.screenshot({ path: path.join(base, 'error-terminal.png') });
    const after = (await snapshot()).sessions.find(s => s.id === id);
    assert.equal(after.nativeId, before.nativeId); assert.equal(after.pid, before.pid); assert.ok(calls >= 1 && calls <= 6);
    assert.equal(after.messages.filter(m => m.kind === 'turn' && m.text.includes('NATIVE_FAILURE_FIXTURE')).length, 1);
    assert.deepEqual(errors, []);
    if (errorRecovery) {
      assert.equal(after.failedTurnInputAvailable, true); recovering = true;
      await page.locator('#chat-tab').click();
      await page.getByRole('button', { name: '加入协作', exact: true }).click();
      await page.locator('#room-nav').click(); await page.locator('#room-record').click();
      await inlineRecipient(page, id);
      await fillRoomMessage(page, 'Continue with this new shared task after the failure.');
      assert.equal(await page.locator('#run-button').isEnabled(), false);
      await page.locator('#forward-button').click();
      await until(async () => (await snapshot()).sessions.find(s => s.id === id).state === 'idle' && (await page.locator('#room-messages').innerText()).includes('RETAINED_ERROR_RECOVERY'), 'Explicit retained shared task after native failure');
      const recovered = await snapshot();
      assert.equal(recoveryCalls, 1); assert.equal(recovered.sessions.find(s => s.id === id).nativeId, before.nativeId);
      assert.equal(recovered.sessions.find(s => s.id === id).pid, before.pid);
      assert.equal(recovered.room.messages.filter(m => m.role === 'human').length, 1);
      await page.screenshot({path:path.join(base,'recovered-room.png')});
      await page.locator(`[data-session-id="${id}"]`).click(); await page.locator('#chat-tab').click();
      assert.match(await page.locator('#messages').innerText(), /NATIVE_FAILURE_FIXTURE/);
      assert.match(await page.locator('#messages').innerText(), /RETAINED_ERROR_RECOVERY/);
      await page.screenshot({path:path.join(base,'recovered-reader.png')});
      await page.locator('#terminal-tab').click();
      await until(async () => (await page.locator('#terminal-area').innerText()).includes('RETAINED_ERROR_RECOVERY'), 'Original terminal shows the new result');
      fs.writeFileSync(path.join(base,'recovered-terminal.txt'),await page.locator('#terminal-area').innerText());
      fs.writeFileSync(path.join(base,'recovered-state.json'),JSON.stringify(recovered,null,2));
    }
    console.log(JSON.stringify({ checks: ['Retained native API failure is readable in unified and terminal views, same identity/process', ...(recovering ? ['Explicit shared new task succeeds once with unchanged native identity; automatic run remains disabled'] : [])], nativeVersion: version, localResponses: calls, paidModelCalls: 0, evidence: base })); return;
  }
  if (modelOnly) {
    await require('./native-model-check.cjs')({ page, snapshot, base, reopen: async () => {
      await application.close(); application = null; await launch(); return page;
    } });
    assert.equal(calls, 0); assert.deepEqual(errors, []);
    console.log(JSON.stringify({ checks: ['Retained native model switches and whole-app reopen preserve identity/draft and match actual header'], nativeVersion: version, modelCalls: calls, errors, evidence: base })); return;
  }
  assert.equal(await page.locator('#messages').getByText('RETAINED_HISTORY: original native answer.', { exact: true }).count(), 1);
  assert.equal(calls, 1); checks.push('Actual old backend and native TUI history retained on same-process input/reader attachment');
  if (sharedTrial || toolHistoryTrial) {
    await page.getByRole('button', { name: '加入协作', exact: true }).click();
    await page.locator('#room-nav').click(); await page.locator('#room-record').click();
    await inlineRecipient(page, id);
    await fillRoomMessage(page, 'Read the local result in the unified interface.'); await page.locator('#forward-button').click();
    await until(async () => (await snapshot()).room.messages.some(m => m.role === 'assistant'), 'Shared reply in retained main reader');
    await page.locator('#room-messages').getByText('RETAINED_PROGRESS: inspect the local result.', { exact: true }).waitFor();
    const sharedProcess=page.locator('#room-messages .process-details').filter({hasText:'RETAINED_TOOL: 42'});await sharedProcess.locator(':scope > summary').click();
    await until(async () => (await page.locator('#room-messages').innerText()).includes('RETAINED_TOOL: 42'), 'Shared native tool');
    assert.ok(!JSON.stringify((await snapshot()).room.messages).includes('RETAINED_HISTORY'));
    assert.ok(!(await page.locator('#run-help').innerText()).includes('回复在成员视图'));
    assert.equal((await snapshot()).room.messages.find(m => m.role === 'human').manualReply, false);
    await page.locator(`[data-session-id="${id}"]`).click(); await page.locator('#chat-tab').click();
    checks.push('Explicit retained room task streams attributed native text/tools in main reader without private history');
  } else { await page.locator('#message-input').fill('Read the local result in the unified interface.'); await page.locator('#send-button').click(); }
  await until(() => calls === 3 && finishFinal, 'Native tool and held final');
  await page.locator('#messages').getByText('RETAINED_PROGRESS: inspect the local result.', { exact: true }).waitFor();
  const toolProcess=page.locator('#messages .process-details').filter({hasText:'RETAINED_TOOL: 42'});await toolProcess.locator(':scope > summary').click();
  await until(async () => (await page.locator('#messages').innerText()).includes('RETAINED_TOOL: 42'), 'Native tool in main reader');
  await until(async () => (await page.locator('#messages').innerText()).includes('RETAINED_FINAL_PREFIX:'), 'Partial final before native completion');
  assert.equal(await page.locator('#messages').getByText('Read the local result in the unified interface.', { exact: true }).count(), 1);
  assert.equal(await page.locator('.native-progress').count(), 0);
  fs.writeFileSync(path.join(base, 'streaming.json'), JSON.stringify(await snapshot(), null, 2));
  checks.push('Actual 302 display and tool events stream into attributed main-reader blocks; one visible input and no camera panel');
  if (toolHistoryTrial) {
    const beforeQuit = await snapshot(), original = beforeQuit.sessions.find(s => s.id === id);
    const tool = original.messages.find(m => m.role === 'tool' && m.text.includes('RETAINED_TOOL: 42'));
    const sharedTool = beforeQuit.room.messages.find(m => m.role === 'tool' && m.text.includes('RETAINED_TOOL: 42'));
    assert.ok(tool && sharedTool, 'Native tool is visible privately and in the authorized room');
    await page.locator('#message-input').fill('Unsent reader draft'); await sleep(300);
    await application.close(); application = null; await launch();
    await until(async () => (await snapshot()).sessions.find(s => s.id === id)?.legacySubmit, 'Same native observer reconnects');
    const restored = await snapshot(), current = restored.sessions.find(s => s.id === id);
    fs.writeFileSync(path.join(base, 'tool-history-reopened.json'), JSON.stringify(restored, null, 2));
    assert.equal(current.nativeId, before.nativeId); assert.equal(current.pid, before.pid);
    assert.equal(await page.locator('#message-input').inputValue(), 'Unsent reader draft');
    assert.equal(current.messages.find(m => m.id === tool.id)?.text, tool.text, 'Private native tool body survives whole-app exit');
    assert.equal(current.messages.find(m => m.id === tool.id)?.input, tool.input);
    assert.equal(restored.room.messages.find(m => m.id === sharedTool.id)?.text, sharedTool.text, 'Shared native tool body survives whole-app exit');
    await until(async () => (await page.locator('#messages').innerText()).includes('RETAINED_TOOL: 42'), 'Restored tool is readable in solo view');
    await page.locator('#room-nav').click(); await page.locator('#room-record').click();
    await until(async () => (await page.locator('#room-messages').innerText()).includes('RETAINED_TOOL: 42'), 'Restored tool is readable in room');
    assert.ok(!JSON.stringify(restored.room.messages).includes('RETAINED_HISTORY'));
    const roomBeforeFinal = JSON.stringify(restored.room.messages);
    finishFinal();
    await until(async () => (await snapshot()).sessions.find(s => s.id === id).messages.some(m => m.text.endsWith('42.\n')), 'Same native task finishes privately');
    assert.equal(JSON.stringify((await snapshot()).room.messages), roomBeforeFinal, 'Reopen preserves history without restoring sharing authority');
    await page.locator(`[data-session-id="${id}"]`).click(); await page.locator('#terminal-tab').click();
    await until(async () => (await page.locator('#terminal-area').innerText()).includes('RETAINED_FINAL_PREFIX'), 'Same native terminal is connected');
    await page.locator('#terminal-area .xterm-screen').click(); await page.keyboard.press('Control+o');
    await until(async () => (await page.locator('#terminal-area').innerText()).includes('RETAINED_TOOL'), 'Native expanded transcript shows the retained tool result');
    const terminal = await page.locator('#terminal-area').innerText(); fs.writeFileSync(path.join(base, 'tool-history-terminal.txt'), terminal);
    assert.match(terminal, /RETAINED_TOOL/);
    await page.locator('#chat-tab').click();
    fs.writeFileSync(path.join(base, 'tool-history-final.json'), JSON.stringify(await snapshot(), null, 2));
    if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'tool-history-solo.png') }); await page.locator('#room-nav').click(); await page.locator('#room-record').click(); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'tool-history-room.png') }); }
    await page.locator('#privacy-button').click();
    assert.ok((await page.locator('#trust-status').innerText()).includes('结构化工具输入与结果会随记录保存在本机'));
    await page.locator('#close-privacy').click();
    assert.equal(calls, 3); assert.deepEqual(errors, []);
    checks.push('Whole-app exit retains exact private/shared tool input and result, same native process and draft, with no replay or restored sharing grant');
    console.log(JSON.stringify({ checks, version, calls, paidModelCalls: 0, evidence: base })); return;
  }
  let queuedTag;
  if (queueTrial) {
    if (sharedQueueTrial) {
      await page.getByRole('button', { name: '加入协作', exact: true }).click();
      await page.locator('#room-nav').click(); await page.locator('#room-record').click();
      await inlineRecipient(page, id);
      await until(async () => (await page.locator('#forward-button').innerText()) === '等本轮结束后发送 ↑', 'Room supports original native waiting queue');
      await fillRoomMessage(page, 'Handle this one queued instruction.'); await page.locator('#forward-button').click();
      await until(async () => (await snapshot()).sessions.find(s => s.id === id).pendingQueue, 'Room waiting receipt');
      const waiting = (await snapshot()).room.messages.find(m => m.role === 'human');
      assert.equal(waiting.status, 'awaiting-native'); assert.equal(waiting.deliveries[0].status, 'awaiting-native');
      assert.equal(waiting.manualReply, false);
      await page.locator('#room-messages .message-body').filter({ hasText: 'Handle this one queued instruction.' }).waitFor();
      await fillRoomMessage(page, 'Unsent room draft'); await sleep(300);
      await page.reload(); await page.locator('#new-session').waitFor();
      assert.equal(await roomBody(page), 'Unsent room draft');
      assert.equal((await snapshot()).room.messages.filter(m => m.role === 'assistant').length, 0);
      await page.locator(`[data-session-id="${id}"]`).click(); await page.locator('#chat-tab').click();
    } else {
    await until(async () => (await page.locator('#send-button').innerText()) === '等本轮结束后发送 ↑', 'Retained working composer accepts a native waiting instruction');
    await page.locator('#message-input').fill('Handle this one queued instruction.'); await page.locator('#send-button').click();
    }
    await until(async () => (await snapshot()).sessions.find(s => s.id === id).pendingQueue, 'Retained waiting receipt');
    queuedTag = (await snapshot()).sessions.find(s => s.id === id).pendingQueue;
    await page.locator('#messages').getByText('Handle this one queued instruction.', { exact: true }).waitFor();
    await sleep(quitQueueTrial ? 1000 : 42000);
    const waiting = (await snapshot()).sessions.find(s => s.id === id);
    assert.equal(waiting.pendingQueue, queuedTag); assert.equal(waiting.state, 'working'); assert.equal(calls, 3);
    assert.equal(waiting.messages.find(m => m.id === queuedTag).status, 'awaiting-native');
    assert.ok(!(await page.locator('#toast').innerText()).includes('超时'));
    fs.writeFileSync(path.join(base, 'waiting.json'), JSON.stringify(await snapshot(), null, 2));
    checks.push(quitQueueTrial ? 'Shared input waits in the original native queue without starting a second task'
      : 'Retained native queue waits beyond both old deadlines, without interrupt, retry or extra model request');
  }
  await page.locator('#message-input').fill('Unsent reader draft'); await sleep(300);
  if (quitQueueTrial) {
    await application.close(); application = null; finishFinal();
    await until(async () => calls === 4 && (await client.call('initial')).sessions.find(s => s.id === id)?.state === 'idle', 'Native queued task completes while GUI is closed');
    fs.writeFileSync(path.join(base, 'pending-quit-native.json'), JSON.stringify(await client.call('initial'), null, 2));
    await launch();
  }
  else if (queueTrial || sharedTrial) {
    await page.locator('#terminal-tab').click(); await page.locator('#chat-tab').click();
    await page.reload(); await page.locator('#new-session').waitFor();
    if (queueTrial) assert.equal((await snapshot()).sessions.find(s => s.id === id).pendingQueue, queuedTag);
  } else { await application.close(); application = null; await launch(); }
  if (!quitQueueTrial) await until(async () => (await snapshot()).sessions.find(s => s.id === id)?.legacySubmit, 'Rebound observer after GUI reopen');
  assert.equal(await page.locator('#message-input').inputValue(), 'Unsent reader draft');
  if (quitQueueTrial) {
    const reopened = await snapshot(), session = reopened.sessions.find(s => s.id === id);
    fs.writeFileSync(path.join(base, 'pending-reopen.json'), JSON.stringify(reopened, null, 2));
    assert.equal(session.nativeId, before.nativeId); assert.equal(session.pid, before.pid); assert.equal(calls, 4);
    assert.ok(['unconfirmed', 'submitted'].includes(reopened.room.messages.find(m => m.id === queuedTag).status));
    await until(async () => (await snapshot()).sessions.find(s => s.id === id).messages.some(m => m.text.includes('RETAINED_QUEUED_REPLY')), 'Original queued native work continues after whole-app reopen');
    const completed = await snapshot(), s = completed.sessions.find(s => s.id === id);
    assert.equal(completed.room.messages.find(m => m.id === queuedTag).status, 'submitted', 'Exact recovered native input confirms receipt without replay');
    assert.equal(completed.room.messages.find(m => m.id === queuedTag).deliveries[0].status, 'submitted');
    assert.equal(completed.room.messages.find(m => m.id === queuedTag).manualReply, true, 'Recovered receipt explains that output remains in original session');
    fs.writeFileSync(path.join(base, 'pending-reopen-completed.json'), JSON.stringify(completed, null, 2));
    await page.locator('#terminal-tab').click();
    await until(async () => (await page.locator('#terminal-area').innerText()).includes('RETAINED_QUEUED_REPLY'), 'Same native terminal shows completed queued reply');
    fs.writeFileSync(path.join(base, 'pending-reopen-terminal.txt'), await page.locator('#terminal-area').innerText()); await page.locator('#chat-tab').click();
    assert.equal(s.messages.filter(m => m.text === 'Handle this one queued instruction.').length, 1, 'Pending input and native acceptance must reconcile without duplicate displayed input');
    assert.equal(s.nativeId, before.nativeId); assert.equal(s.pid, before.pid); assert.equal(calls, 4);
    const actual = JSON.parse(fs.readFileSync(path.join(base, 'request-4.json')));
    assert.equal(actual.messages.filter(m => m.role === 'user').flatMap(m => typeof m.content === 'string' ? [m.content] : m.content.filter(b => b.type === 'text').map(b => b.text)).filter(t => t === 'Handle this one queued instruction.').length, 1);
    assert.equal(await page.locator('#message-input').inputValue(), 'Unsent reader draft');
    assert.ok(s.messages.some(m => m.text.includes('RETAINED_FINAL_PREFIX:') && m.text.endsWith('42.\n')), 'Original task tail is restored, not only the next reply');
    assert.equal(completed.room.messages.filter(m => m.role === 'assistant').length, 0, 'Reopening does not resurrect old sharing authority');
    assert.deepEqual(errors, []);
    if (process.env.NAW_EVIDENCE_DIR) {
      fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'pending-quit-success.png') });
      await page.locator('#room-nav').click(); await page.locator('#room-record').click();
      assert.equal(await roomBody(page), 'Unsent room draft');
      await page.locator('#room-messages').getByText('原生已接收 · 回复由你选定后分享', { exact: true }).waitFor();
      await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'pending-receipt-success.png') });
    }
    checks.push('Whole-app reopen recovers output completed while closed, original pending work, draft and identity without replay, duplicate input or restored sharing grant');
    console.log(JSON.stringify({ checks, version, calls, paidModelCalls: 0, evidence: base })); return;
  }
  await page.locator(`[data-session-menu="${id}"]`).click();
  const secondOpened = application.waitForEvent('window');
  await page.getByRole('menuitem', { name: '在独立窗口打开', exact: true }).click();
  const secondPage = await secondOpened; await secondPage.locator('#new-session').waitFor();
  finishFinal();
  await until(async () => (await snapshot()).sessions.find(s => s.id === id).messages.some(m => m.kind === 'turn'), 'Native completion after reopen');
  if (queueTrial) {
    await until(async () => { const s = (await snapshot()).sessions.find(s => s.id === id); return !s.pendingQueue && s.state === 'idle' && s.messages.some(m => m.text.includes('RETAINED_QUEUED_REPLY')); }, 'Queued instruction actually consumed by original native session');
    if (sharedQueueTrial) {
      await until(async () => (await snapshot()).room.messages.some(m => m.finalReply && m.text.includes('RETAINED_QUEUED_REPLY')), 'Room final attributed to actual queued input');
      const room = (await snapshot()).room.messages;
      const final = room.find(m => m.finalReply); assert.equal(final.sourceTag, queuedTag); assert.equal(final.sessionId, id);
      assert.equal(room.filter(m => m.role === 'assistant').length, 1);
      assert.equal(room.find(m => m.id === queuedTag).status, 'submitted');
      for (const privateText of ['RETAINED_HISTORY', 'RETAINED_PROGRESS', 'RETAINED_TOOL', 'RETAINED_FINAL_PREFIX', 'Unsent reader draft']) assert.ok(!JSON.stringify(room).includes(privateText));
      await page.locator('#room-nav').click(); await page.locator('#room-record').click();
      await page.locator('#room-messages').getByText(final.text.trim(), { exact: true }).waitFor();
      assert.equal(await roomBody(page), 'Unsent room draft');
      await page.reload(); await page.locator('#new-session').waitFor();
      await page.locator('#room-messages').getByText(final.text.trim(), { exact: true }).waitFor();
      assert.equal((await snapshot()).room.messages.find(m => m.finalReply).id, final.id);
      assert.equal(await roomBody(page), 'Unsent room draft');
      fs.writeFileSync(path.join(base, 'shared-queue-final.json'), JSON.stringify(await snapshot(), null, 2));
      if (process.env.NAW_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'retained-shared-queue-success.png') });
      checks.push('Room waiting receipt, exact queued reply and new draft survive reload; prior private task stays private');
      await page.locator(`[data-session-id="${id}"]`).click(); await page.locator('#chat-tab').click();
    }
    const accepted = (await snapshot()).sessions.find(s => s.id === id);
    assert.equal(accepted.messages.filter(m => m.text === 'Handle this one queued instruction.').length, 1);
    assert.equal(accepted.messages.find(m => m.text === 'Handle this one queued instruction.').inputTag, queuedTag);
    const actual = JSON.parse(fs.readFileSync(path.join(base, 'request-4.json'), 'utf8'));
    assert.equal(actual.messages.filter(m => m.role === 'user').flatMap(m => typeof m.content === 'string' ? [m.content] : m.content.filter(b => b.type === 'text').map(b => b.text)).filter(t => t === 'Handle this one queued instruction.').length, 1);
    checks.push('Native request contains queued text once; exact native tag replaces waiting row while preserving newer draft and both windows');
  }
  const after = (await snapshot()).sessions.find(s => s.id === id);
  assert.equal(after.nativeId, before.nativeId); assert.equal(after.pid, before.pid);
  assert.equal(after.messages.filter(m => m.text.includes('RETAINED_FINAL_PREFIX:')).length, 1);
  assert.ok(after.messages.some(m => m.text.includes('RETAINED_FINAL_PREFIX:') && m.text.endsWith('42.\n')));
  assert.equal(calls, sharedTrial ? 3 : budget); assert.equal(await page.locator('#message-input').inputValue(), 'Unsent reader draft');
  await until(async () => (await secondPage.locator('#messages').innerText()).includes('42.'), 'Second window receives new final');
  await secondPage.close();
  fs.writeFileSync(path.join(base, 'completed.json'), JSON.stringify(await snapshot(), null, 2));
  checks.push(`${queueTrial || sharedTrial ? 'Renderer reload' : 'GUI reopen'} retains native PID/identity, displayed partial and draft; new final updates the same block without duplicate old Stop text`);
  await page.locator('#terminal-tab').click(); await until(async () => (await page.locator('#terminal-area').innerText()).includes('RETAINED_FINAL_PREFIX:'), 'Original terminal final');
  fs.writeFileSync(path.join(base, 'terminal.txt'), await page.locator('#terminal-area').innerText()); await page.locator('#chat-tab').click();
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'retained-claude-reader.png') }); }
  if (sharedTrial) {
    await page.locator('#room-nav').click(); await page.locator('#room-record').click();
    await until(async () => (await snapshot()).room.messages.some(m => m.finalReply && m.text.includes('RETAINED_FINAL_PREFIX:')), 'Final shared display proof');
    const room = (await snapshot()).room.messages, final = room.find(m => m.finalReply);
    assert.equal(room.filter(m => m.text?.includes('RETAINED_FINAL_PREFIX:')).length, 1);
    assert.equal(final.sessionId, id); assert.ok(final.replyTo);
    assert.equal((await snapshot()).diagnostics.dispatches, 1);
    assert.ok(!JSON.stringify(room).includes('Unsent reader draft'));
    fs.writeFileSync(path.join(base, 'shared-completed.json'), JSON.stringify(await snapshot(), null, 2));
    if (process.env.NAW_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'retained-shared-success.png') });
    await application.close(); application = null; await launch();
    await page.locator('#room-nav').click(); await page.locator('#room-record').click();
    await page.locator('#room-messages').getByText(final.text.trim(), { exact: true }).waitFor();
    assert.equal(calls, 3);
    const savedShared=fs.readFileSync(path.join(profile, 'legacy-shared.json'), 'utf8');
    assert.ok(savedShared.includes('RETAINED_TOOL: 42'));assert.ok(!savedShared.includes('RETAINED_HISTORY'));
    checks.push('Shared final and explicitly observed native tools survive reopen without importing private history or replaying a delivery');
    await page.locator(`[data-session-id="${id}"]`).click(); await page.locator('#chat-tab').click();
    if (await page.locator('#send-button').textContent() === '接管此窗口') await page.locator('#send-button').click();
    await until(async () => (await snapshot()).sessions.find(s => s.id === id).legacySubmit, 'Retained rebind for second task');
    await page.locator('#room-nav').click(); await page.locator('#room-record').click();
    await inlineRecipient(page, id);
    await fillRoomMessage(page, 'Check native permission without exposing later output.'); await page.locator('#forward-button').click();
    await until(async () => (await snapshot()).sessions.find(s => s.id === id).state === 'approval', 'Actual retained native permission prompt');
    await page.locator('#approval').getByText('Retained Claude',{exact:true}).waitFor();
    assert.match(await page.locator('#approval pre').innerText(),/RETAINED_APPROVED_TOOL/);
    assert.equal(await page.locator('#approval button').count(),1,'Actual native options stay on the real TUI');
    fs.writeFileSync(path.join(base, 'shared-permission.json'), JSON.stringify(await snapshot(), null, 2));
    await page.locator('#approval button').click();
    await until(async () => /Do you want to proceed|Allow this/.test(await page.locator('#terminal-area').innerText()), 'Native permission choice visible');
    const permissionText = await page.locator('#terminal-area').innerText();
    assert.ok(permissionText.includes('RETAINED_APPROVED_TOOL'));
    fs.writeFileSync(path.join(base, 'native-permission.txt'), permissionText);
    await page.locator('#terminal-area .xterm-screen').click(); await page.keyboard.press('Enter');
    await until(async () => (await snapshot()).sessions.find(s => s.id === id).messages.some(m => m.text.includes('RETAINED_PRIVATE_AFTER_PERMISSION')), 'Post-permission native answer');
    const verified = await snapshot(); assert.equal(calls, 5);
    assert.ok(!JSON.stringify(verified.room.messages).includes('RETAINED_PRIVATE_AFTER_PERMISSION'));
    assert.ok(!verified.room.messages.some(m => m.role === 'tool' && m.text?.includes('RETAINED_APPROVED_TOOL')));
    const boundaries = await application.evaluate(() => globalThis.retainedBoundaryTrace);
    const permission = boundaries.find(event => event.id === 'control:permission');
    assert.ok(permission, 'Actual 302 permission hook reached the ordered observation channel');
    assert.ok(boundaries.some(event => event.kind === 'response' && event.epoch === permission.epoch && event.sequence > permission.sequence));
    fs.writeFileSync(path.join(base, 'native-boundaries.json'), JSON.stringify(boundaries, null, 2));
    assert.equal(verified.sessions.find(s => s.id === id).nativeId, before.nativeId);
    assert.equal(verified.sessions.find(s => s.id === id).pid, before.pid);
    await page.locator(`[data-session-id="${id}"]`).click(); await page.locator('#chat-tab').click();
    await page.getByRole('button', { name: '脱出协作', exact: true }).click();
    await page.getByRole('button', { name: '加入协作', exact: true }).click();
    assert.ok(!JSON.stringify((await snapshot()).room.messages).includes('RETAINED_PRIVATE_AFTER_PERMISSION'));
    fs.writeFileSync(path.join(base, 'shared-final.json'), JSON.stringify(await snapshot(), null, 2));
    checks.push('Real native permission and GUI leave/rejoin retain original process without promoting later private output or replay');
  }
  const debug = fs.readFileSync(path.join(base, 'native-debug.log'), 'utf8');
  assert.ok(!debug.includes('Plugin loading errors:'), 'Native plugin discovery/reload has no load errors');
  await page.locator('#terminal-tab').click(); await page.locator('#terminal-area .xterm-screen').click();
  await page.keyboard.type('/exit');
  await until(async () => (await page.locator('#terminal-area').innerText()).includes('/exit'), 'Native exit command shown');
  await sleep(300); await page.keyboard.press('Enter');
  await until(async () => (await snapshot()).sessions.find(s => s.id === id)?.state === 'ended', 'Owned native process ended', 30000);
  await page.locator('#chat-tab').click();
  assert.ok((await page.locator('#messages').innerText()).includes('RETAINED_FINAL_PREFIX:'));
  await application.close(); application = null; await launch();
  assert.ok((await page.locator('#messages').innerText()).includes('RETAINED_FINAL_PREFIX:'));
  const ended = (await snapshot()).sessions.find(s => s.id === id);
  assert.equal(ended.pid, null); assert.equal(ended.nativeId, before.nativeId); assert.equal(ended.state, 'ended');
  assert.equal(calls, budget);
  checks.push('Second window receives new output; native exit and ended-history reopen preserve reader without a new process or model turn');
  fs.writeFileSync(path.join(base, 'ended.json'), JSON.stringify(await snapshot(), null, 2));
  assert.deepEqual(errors, []); console.log(JSON.stringify({ checks, nativeVersion: version, localResponses: calls, paidModelCalls: 0, errors, evidence: base }));
})().catch(async error => {
  if (page && !page.isClosed()) { fs.writeFileSync(path.join(base, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {}); }
  if (client) try { const s = (await client.call('initial')).sessions[0]; fs.writeFileSync(path.join(base, 'failure-native.json'), JSON.stringify(await client.call('snapshot', s.id))); } catch {}
  console.error(error.stack, '\nEvidence:', base); process.exitCode = 1;
}).finally(async () => {
  finishFinal?.(); if (application) await application.close(); client?.close();
  try { const cleanup = await connect(profile, 'cleanup'); for (const s of (await cleanup.call('initial')).sessions) await cleanup.call('stop', s.id);
    for (const entry of cleanup.entries) await entry.client.call('shutdown'); cleanup.close(); } catch {}
  if (child?.connected) child.disconnect(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
});
