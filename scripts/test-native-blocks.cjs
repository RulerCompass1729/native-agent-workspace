const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
const { chooseRecipient: inlineRecipient, fillRoomMessage, roomBody } = require('./room-input.cjs');
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
const binary = process.env.NAW_CLAUDE_BIN || executable('claude'); if (!binary) throw Error('Real Claude CLI required');
const nativeVersion = testScratch.childProcess.execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
assert.match(nativeVersion, /^2\.1\.(307|308|309|310|311|312)\b/, 'Verify the updated native contract before sending a test task');
let application, page, client, calls = 0, held, releaseFinal, releaseStart, unexpectedRequest;
const errors = [], checks = [];
const compatibilityTrial = process.env.NAW_TEST_NATIVE_COMPAT === '1';
const questionTrial = process.env.NAW_TEST_NATIVE_QUESTION === '1';
const imageTrial = process.env.NAW_TEST_NATIVE_IMAGE === '1';
// Plan case: the session starts in native plan mode; the model writes its plan
// file, then ExitPlanMode opens the native approval with that plan.
const planTrial = process.env.NAW_TEST_NATIVE_PLAN === '1', planText = '# PLAN_MARKER\n1. Read the local file.\n2. Report the result.\n';
// Permission case: manual mode asks before a Bash command that writes a file
// (read-only commands such as echo run without asking).
const permissionTrial = process.env.NAW_TEST_NATIVE_PERMISSION === '1';
assert.ok([compatibilityTrial, imageTrial, questionTrial, planTrial, permissionTrial].filter(Boolean).length <= 1, 'One bounded case per run');
assert.ok(!/^2\.1\.312\b/.test(nativeVersion) || compatibilityTrial, 'Only the combined compatibility case is qualified on 2.1.312');
let planFile = null; const planSteps = [];
const answerMode=process.env.NAW_NATIVE_QUESTION_ANSWER||'first'; if(!['first','other','cancel','multi','gui','handback','interrupt'].includes(answerMode))throw Error('Unknown bounded native answer case');
const nativeQuestion = { question: 'Which method should this check use?', header: 'Method', multiSelect: false, options: [{ label: 'Keep original', description: 'Continue in this same native session.' }, { label: 'Read only', description: 'Inspect the existing result.' }] };
// The multi case asks two questions at once, the second multi-select.
const checksQuestion = { question: 'Which checks should run?', header: 'Checks', multiSelect: true, options: [{ label: 'Unit tests', description: 'Run the local unit tests.' }, { label: 'Lint', description: 'Check style.' }, { label: 'Build', description: 'Build the bundle.' }] };
const nativeQuestions = ['multi', 'gui'].includes(answerMode) ? [nativeQuestion, checksQuestion] : [nativeQuestion];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 30000) {
  const start = Date.now(); while (Date.now() - start < timeout) { if (unexpectedRequest) throw unexpectedRequest; if (await fn()) return; await sleep(75); } throw Error(label);
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
    if (compatibilityTrial && number > 3) { unexpectedRequest = Error('Compatibility budget exceeded: at most three local responses'); res.writeHead(429); res.end(); return; }
    if (number === 1 && process.env.NAW_TEST_NATIVE_PHASE === '1') await new Promise(resolve => { releaseStart = resolve; });
    if (number > (imageTrial ? 1 : questionTrial || permissionTrial ? 2 : planTrial ? 4 : 3)) { res.writeHead(429); res.end(); return; }
    const request = JSON.parse(body);
    fs.writeFileSync(path.join(base, `request-${number}.json`), body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    event(res, 'message_start', { message: { id: `msg_local_${number}`, type: 'message', role: 'assistant', model: request.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    if (imageTrial) {
      block(res, 0, { type: 'text', text: 'NATIVE_IMAGE_FINAL' });
      event(res, 'message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
      event(res, 'message_stop', {}); res.end(); return;
    }
    if (planTrial) {
      // Native names the plan file in plan mode's instructions to the model; for a
      // bridge-submitted first prompt they arrive with the next request, so look first.
      planFile ||= (body.match(/\/[^"\\\s]*\/plans\/[^"\\\s]+\.md/) || [])[0] || null;
      const step = !planFile && !planSteps.length ? 'look' : !planSteps.includes('write') ? 'write' : !planSteps.includes('exit') ? 'exit' : 'final';
      planSteps.push(step);
      if (step === 'look') block(res, 0, { type: 'tool_use', id: 'toolu_local_plan_look', name: 'Read', input: { file_path: path.join(fs.realpathSync(cwd), 'notes.txt') } });
      else if (step === 'write') block(res, 0, { type: 'tool_use', id: 'toolu_local_plan_write', name: 'Write', input: { file_path: planFile, content: planText } });
      else if (step === 'exit') block(res, 0, { type: 'tool_use', id: 'toolu_local_plan_exit', name: 'ExitPlanMode', input: {} });
      else block(res, 0, { type: 'text', text: 'NATIVE_FINAL: the plan was approved.\n' });
      event(res, 'message_delta', { delta: { stop_reason: step === 'final' ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } });
      event(res, 'message_stop', {}); res.end(); return;
    }
    if (permissionTrial) {
      if (number === 1) block(res, 0, { type: 'tool_use', id: 'toolu_local_permission', name: 'Bash', input: { command: 'touch native-permission-marker && echo NATIVE_PERMISSION_DONE', description: 'Create a marker file' } });
      else block(res, 0, { type: 'text', text: 'NATIVE_FINAL: the permitted command ran.\n' });
      event(res, 'message_delta', { delta: { stop_reason: number === 1 ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
      event(res, 'message_stop', {}); res.end(); return;
    }
    if (number === 1) {
      block(res, 0, { type: 'text', text: 'NATIVE_FIRST: checking locally.\n' });
      block(res, 1, questionTrial ? { type: 'tool_use', id: 'toolu_local_question', name: 'AskUserQuestion', input: { questions: nativeQuestions } } : { type: 'tool_use', id: 'toolu_local_block', name: 'Bash', input: { command: 'printf "NATIVE_TOOL: 42\\n"', description: 'Print the local test marker' } });
    } else if (number === 2) {
      if (!questionTrial) await new Promise(resolve => { releaseFinal = resolve; });
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
    `os.execv(${JSON.stringify(binary)},["claude"]+sys.argv[1:]+["--model","haiku","--allowedTools","Bash(printf:*)"${planTrial ? ',"--permission-mode","plan"' : permissionTrial ? ',"--permission-mode","default"' : ''}])\n`, { mode: 0o700 });
  if (planTrial) fs.writeFileSync(path.join(cwd, 'notes.txt'), 'local notes\n');
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [fs.realpathSync(cwd)]: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify({ claude: shim }), { mode: 0o600 });
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], ...(process.env.NAW_VIDEO_DIR ? { recordVideo: { dir: process.env.NAW_VIDEO_DIR, size: { width: 1280, height: 900 } } } : {}), env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await application.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor(); client = await connectService(profile, 'native-block-test');
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check();
  await page.locator('#session-name').fill('Native blocks'); await createIn(page, 'terminal');
  await until(async () => /Yes, I trust this folder|Do you want to use this API key/.test(await page.locator('#terminal-area').innerText()) || (await snapshot()).sessions[0]?.chatAvailable, 'Native startup');
  if ((await page.locator('#terminal-area').innerText()).includes('Yes, I trust this folder')) {
    assert.ok((await page.locator('#terminal-area').innerText()).replace(/\s/g,'').includes(fs.realpathSync(cwd).replace(/\s/g,'')));
    await page.locator('#terminal-area .xterm-screen').click(); await page.keyboard.press('ArrowDown'); await sleep(200); await page.keyboard.press('Enter');
  }
  await until(async () => (await page.locator('#terminal-area').innerText()).includes('Do you want to use this API key') || (await snapshot()).sessions[0]?.chatAvailable, 'Native key prompt');
  if ((await page.locator('#terminal-area').innerText()).includes('Do you want to use this API key')) {
    await page.locator('#terminal-area .xterm-screen').click(); await page.keyboard.press('ArrowUp'); await sleep(200); await page.keyboard.press('Enter');
  }
  await until(async () => (await snapshot()).sessions[0]?.chatAvailable, 'Native submission bridge', 60000);
  const before = (await snapshot()).sessions[0];
  if (compatibilityTrial) {
    fs.writeFileSync(path.join(base, 'compat-start.json'), JSON.stringify(before, null, 2));
    assert.equal(before.queueAvailable, true, 'Qualified native queue is bound at startup');
    await require('./native-model-check.cjs')({ page, snapshot, base, aliases: ['sonnet', 'haiku'] });
    assert.equal(calls, 0, 'Native model commands make no model request');
    checks.push('Actual native model changes reach the GUI header and survive reload with the same ID/PID/draft; task model returns to haiku');
  }
  if (imageTrial) {
    const original = Buffer.from([0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 0, 255, 255, 255]);
    const png = await application.evaluate(({ nativeImage }, data) => nativeImage.createFromBitmap(Buffer.from(data), { width: 2, height: 2 }).toPNG().toString('base64'), Array.from(original));
    const bytes = Array.from(Buffer.from(png, 'base64')), draft = 'Unsent screenshot task draft';
    await page.locator('#chat-tab').click(); await page.locator('#message-input').fill(draft);
    await page.locator('#message-input').evaluate((el, data) => {
      const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(data)], 'paste.png', { type: 'image/png' }));
      el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    }, bytes);
    const rows = () => page.locator('#terminal-area .xterm-rows').innerText();
    await until(async () => (await rows()).includes('[Image #1]'), 'Composer image reaches the original Claude input');
    const nativeInput = page.locator('#terminal-area .xterm-helper-textarea');
    await nativeInput.evaluate((el, data) => {
      const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(data)], 'drop.png', { type: 'image/png' }));
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }, bytes);
    await until(async () => (await rows()).includes('[Image #2]'), 'Dropped image reaches the same Claude input');
    await application.evaluate(({ clipboard, nativeImage }, data) => { clipboard.readImage = () => nativeImage.createFromBuffer(Buffer.from(data, 'base64')); }, png);
    await page.locator('#terminal-paste').click();
    await until(async () => (await rows()).includes('[Image #3]'), 'Paste button reads a screenshot on demand');
    assert.equal(calls, 0, 'None of the image entry paths automatically sends');
    assert.equal((await snapshot()).sessions[0].liveDraft, draft);
    await nativeInput.press('Enter');
    await until(async () => calls === 1 && (await snapshot()).sessions[0].messages.some(m => m.text?.includes('NATIVE_IMAGE_FINAL')), 'One explicit native send receives the fixed reply');
    const completionObservedAt = Date.now();
    await until(async () => (await snapshot()).sessions[0].state === 'idle' && (await page.locator('#session-status').innerText()).includes('就绪'), 'Native completion settles to idle in the GUI');
    const completionLagMs = Date.now() - completionObservedAt;
    assert.ok(completionLagMs < 1000, `GUI completion took ${completionLagMs} ms after the reply appeared`);
    const request = JSON.parse(fs.readFileSync(path.join(base, 'request-1.json'), 'utf8'));
    const images = request.messages.filter(m => m.role === 'user').flatMap(m => Array.isArray(m.content) ? m.content : []).filter(c => c.type === 'image');
    assert.equal(images.length, 3);
    for (const image of images) {
      assert.equal(image.source.type, 'base64');
      const pixels = await application.evaluate(({ nativeImage }, data) => nativeImage.createFromBuffer(Buffer.from(data, 'base64')).toBitmap().toString('base64'), image.source.data);
      assert.equal(pixels, original.toString('base64'), 'Original screenshot pixels reach Claude');
    }
    const after = (await snapshot()).sessions[0];
    assert.equal(after.nativeId, before.nativeId); assert.equal(after.pid, before.pid); assert.equal(after.liveDraft, draft);
    assert.equal(calls, 1); assert.deepEqual(errors, []);
    if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'native-images.png') }); }
    console.log(JSON.stringify({ checks: ['Three image entry paths keep the GUI draft, never auto-send, deliver unchanged pixels to the same native Claude session and settle to GUI idle'], nativeVersion, attachments: images.length, completionLagMs, localResponses: calls, paidModelCalls: 0, physicalClipboard: 'not exercised; renderer events and readImage stub', evidence: base })); return;
  }
  if (questionTrial && ['gui', 'handback', 'interrupt'].includes(answerMode)) {
    // A solo row in the chat view: native's question is held for the chat view (T-18).
    const rows = () => page.locator('#terminal-area .xterm-rows').innerText();
    await page.locator('#chat-tab').click(); await page.locator('#message-input').fill('Run the local check.'); await page.locator('#send-button').click();
    const form = page.locator('#approval .question-form'); await form.getByText(nativeQuestion.question, { exact: true }).waitFor({ timeout: 60000 });
    await until(async () => (await page.locator('#native-phase').innerText()).includes('等待回答'), 'The composer status identifies the held native question');
    assert.equal((await snapshot()).sessions[0].nativeApproval, null, 'Native has not opened its dialog');
    if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'question-held-' + answerMode + '.png') }); }
    if (answerMode === 'interrupt') {
      // Stopping the turn releases the held hook first, so native can end the turn.
      const stopped = Date.now(); await page.locator('#interrupt').click();
      await until(async () => (await snapshot()).sessions[0].state === 'idle' && !(await snapshot()).sessions[0].claudeQuestion, 'The turn stops while a question was held', 30000);
      assert.ok(Date.now() - stopped < 20000, 'Stopping does not wait for the hook timeout'); await sleep(1500); assert.equal(calls, 1, 'No answer was sent to the model');
      await until(() => page.locator('#approval').isHidden(), 'The question card clears');
      const after = (await snapshot()).sessions[0]; assert.equal(after.nativeId, before.nativeId); assert.deepEqual(errors, []);
      console.log(JSON.stringify({ checks: ['Stopping a turn while its native question is held for the chat view ends the turn promptly; nothing is answered'], nativeVersion, localResponses: calls, paidModelCalls: 0, errors, evidence: base }));
      return;
    }
    let expected;
    if (answerMode === 'gui') {
      await form.locator('label', { hasText: 'Read only' }).locator('input').check();
      await form.locator('label', { hasText: 'Unit tests' }).locator('input').check(); await form.locator('label', { hasText: 'Build' }).locator('input').check();
      await form.getByRole('button', { name: '提交回答', exact: true }).click();
      expected = ['"Which method should this check use?"="Read only"', '"Which checks should run?"="Unit tests, Build"'];
    } else {
      await page.locator('#approval').getByRole('button', { name: '去终端回答', exact: true }).click();
      await until(async () => (await rows()).includes(nativeQuestion.question) && (await rows()).includes('Enter to select'), 'Handed back, the native dialog asks in the terminal');
      await page.locator('#terminal-area .xterm-helper-textarea').press('Enter');
      expected = ['"Which method should this check use?"="Keep original"'];
    }
    await until(async () => calls === 2 && (await snapshot()).sessions[0].messages.some(m => m.text?.includes('NATIVE_FINAL:')), 'The answer continues the same native turn', 60000);
    const request = JSON.parse(fs.readFileSync(path.join(base, 'request-2.json')));
    const result = request.messages.flatMap(m => m.content || []).find(p => p.type === 'tool_result' && p.tool_use_id === 'toolu_local_question');
    for (const text of expected) assert.ok(result && JSON.stringify(result).includes(text.replace(/"/g, '\\"')), `Native tool result carries ${text}`);
    if (answerMode === 'gui') assert.ok(!(await rows()).includes('Enter to select'), 'The native dialog never opened');
    await until(() => page.locator('#approval').isHidden(), 'The question card clears');
    const after = (await snapshot()).sessions[0]; assert.equal(after.nativeId, before.nativeId); assert.equal(after.pid, before.pid); assert.equal(calls, 2); assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(base, 'question-' + answerMode + '.json'), JSON.stringify(await snapshot(), null, 2));
    console.log(JSON.stringify({ checks: [answerMode === 'gui' ? 'A held native question (single and multi-select) is answered in the chat view; native\'s own tool result carries the answers and its dialog never opens' : 'A held native question handed back opens the native dialog in the terminal, which answers it'], nativeVersion, localResponses: calls, paidModelCalls: 0, errors, evidence: base }));
    return;
  }
  await page.getByRole('button', { name: '加入协作', exact: true }).click();
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await inlineRecipient(page, before.id);
  await fillRoomMessage(page, 'Run the local check.'); await page.locator('#forward-button').click();
  if (planTrial) {
    const rows = () => page.locator('#terminal-area .xterm-rows').innerText();
    await page.locator(`[data-session-id="${before.id}"]`).click(); await page.locator('#chat-tab').click();
    await until(async () => (await snapshot()).sessions[0].nativeApproval?.requests.some(r => r.title === 'ExitPlanMode'), 'Native plan approval reaches the existing private panel', 60000);
    assert.ok(planFile, 'Native named a plan file in plan mode');
    // Native fills the ExitPlanMode request with the plan file's text and path; the
    // panel shows that native input as is, and the reader keeps the Write call.
    const panel = await page.locator('#approval').innerText(); fs.writeFileSync(path.join(base, 'plan-panel.txt'), panel);
    const request = (await snapshot()).sessions[0].nativeApproval.requests.find(r => r.title === 'ExitPlanMode');
    assert.deepEqual(JSON.parse(request.input), { plan: planText, planFilePath: planFile }, 'The request input is native\'s own plan text and file');
    assert.ok(panel.includes('ExitPlanMode') && panel.includes('PLAN_MARKER') && panel.includes(planFile), 'The panel shows the native plan request as is');
    assert.ok((await page.locator('#messages').innerText()).includes('Write'), 'The reader keeps the native plan file write');
    assert.equal((await snapshot()).sessions[0].nativePermissionMode, 'plan');
    await page.locator('#terminal-tab').click();
    await until(async () => (await rows()).includes('Ready to code?') && (await rows()).includes('PLAN_MARKER'), 'The same native TUI shows the plan for approval');
    fs.writeFileSync(path.join(base, 'plan-terminal.txt'), await rows());
    const nativeInput = page.locator('#terminal-area .xterm-helper-textarea');
    await nativeInput.press('ArrowDown');
    await until(async () => (await rows()).includes('❯ 2. Yes, manually approve edits'), 'Native option selected before Enter');
    await nativeInput.press('Enter');
    await until(async () => { const s = (await snapshot()).sessions[0]; return planSteps.at(-1) === 'final' && s.state === 'idle' && s.messages.some(m => m.text?.includes('NATIVE_FINAL:')); }, 'Approved plan continues the same native turn', 60000);
    const after = (await snapshot()).sessions[0];
    assert.equal(after.nativeId, before.nativeId); assert.equal(after.pid, before.pid); assert.deepEqual(planSteps.filter(s => s !== 'look'), ['write', 'exit', 'final']);
    assert.equal(after.nativePermissionMode, 'default', 'The recorded mode follows native out of plan mode');
    await page.locator('#chat-tab').click(); await until(() => page.locator('#approval').isHidden(), 'Approved plan clears the panel');
    assert.deepEqual(errors, []); fs.writeFileSync(path.join(base, 'plan-finished.json'), JSON.stringify(after, null, 2));
    if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'native-plan.png') }); }
    console.log(JSON.stringify({ planSteps, checks: ['Native plan: the panel shows the ExitPlanMode request with the plan text and file native put in it, approval happens in the same TUI, the turn continues with the same identity and the recorded mode leaves plan'], nativeVersion, localResponses: calls, paidModelCalls: 0, evidence: base })); return;
  }
  if (permissionTrial) {
    const rows = () => page.locator('#terminal-area .xterm-rows').innerText();
    await page.locator(`[data-session-id="${before.id}"]`).click(); await page.locator('#chat-tab').click();
    await until(async () => (await snapshot()).sessions[0].nativeApproval?.requests.some(r => r.title === 'Bash'), 'Native permission request reaches the private panel', 60000);
    const request = (await snapshot()).sessions[0].nativeApproval.requests.find(r => r.title === 'Bash');
    assert.match(request.input, /touch native-permission-marker && echo NATIVE_PERMISSION_DONE/, 'The request carries native\'s tool input as is');
    await until(async () => { const text = await page.locator('#approval').innerText(); return text.includes('Bash') && text.includes('touch native-permission-marker'); }, 'The panel shows the tool and its input', 10000);
    fs.writeFileSync(path.join(base, 'permission-panel.txt'), await page.locator('#approval').innerText());
    assert.equal(await page.locator('#approval').getByRole('button', { name: '允许这一次', exact: true }).count(), 0, 'NAW offers no decision of its own');
    assert.equal(calls, 1, 'No model request before the decision');
    assert.ok(!fs.existsSync(path.join(cwd, 'native-permission-marker')), 'The command did not run before the decision');
    await page.locator('#terminal-tab').click();
    await until(async () => (await rows()).includes('touch native-permission-marker') && /Do you want to proceed\?/.test(await rows()), 'The same native TUI asks before running', 30000);
    // Option 3 would also switch the session to auto mode; Enter only on plain Yes.
    await until(async () => (await rows()).includes('❯ 1. Yes'), 'Native option Yes selected before Enter', 5000);
    fs.writeFileSync(path.join(base, 'permission-terminal.txt'), await rows());
    await page.locator('#terminal-area .xterm-helper-textarea').press('Enter');
    await until(async () => { const s = (await snapshot()).sessions[0]; return calls === 2 && s.state === 'idle' && s.messages.some(m => m.text?.includes('NATIVE_FINAL: the permitted')); }, 'The permitted command runs and the turn continues', 60000);
    assert.match(fs.readFileSync(path.join(base, 'request-2.json'), 'utf8'), /NATIVE_PERMISSION_DONE/, 'Native ran the command after the decision');
    assert.ok(fs.existsSync(path.join(cwd, 'native-permission-marker')), 'The permitted command changed the folder');
    const after = (await snapshot()).sessions[0]; assert.equal(after.nativeId, before.nativeId); assert.equal(after.pid, before.pid);
    await page.locator('#chat-tab').click(); await until(() => page.locator('#approval').isHidden(), 'The decided request clears the panel');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ checks: ['A native tool permission request shows the tool and its input as is in the private panel; NAW offers no decision of its own; the same native TUI asks, and the decision there runs the command and continues the turn'], nativeVersion, localResponses: calls, paidModelCalls: 0, evidence: base })); return;
  }
  if (questionTrial) {
    await page.locator(`[data-session-id="${before.id}"]`).click(); await page.locator('#chat-tab').click();
    await until(async () => (await snapshot()).sessions[0].nativeApproval?.requests.some(r => r.title === 'AskUserQuestion'), 'Actual native question reaches existing private panel');
    for (const question of nativeQuestions) {
      await page.locator('#approval').getByText(question.question, {exact:true}).waitFor();
      await page.locator('#approval').getByText(question.header, {exact:true}).waitFor();
      for (const option of question.options) {
        await page.locator('#approval').getByText(option.label,{exact:true}).waitFor();
        await page.locator('#approval').getByText(option.description,{exact:true}).waitFor();
      }
    }
    fs.writeFileSync(path.join(base,'question-wait.json'),JSON.stringify(await snapshot(),null,2));
    fs.writeFileSync(path.join(base,'question-panel.txt'),await page.locator('#approval').innerText());
    if(process.env.NAW_EVIDENCE_DIR){fs.mkdirSync(process.env.NAW_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.NAW_EVIDENCE_DIR,'question-wait-'+answerMode+'.png')});}
    await page.locator('#terminal-tab').click();
    await until(async () => (await page.locator('#terminal-area .xterm-rows').innerText()).includes(nativeQuestion.question), 'The same native TUI asks the same question');
    fs.writeFileSync(path.join(base,'question-terminal.txt'),await page.locator('#terminal-area .xterm-rows').innerText());
    const nativeInput=page.locator('#terminal-area .xterm-helper-textarea');
    if(answerMode==='cancel') {
      assert.ok((await page.locator('#terminal-area .xterm-rows').innerText()).includes('Esc to cancel'));
      await nativeInput.press('Escape');
      await until(async()=>{const s=(await snapshot()).sessions[0];return s.state==='idle'&&s.messages.some(m=>m.kind==='tool'&&m.status==='failed'&&m.text.includes("The user doesn't want to proceed"));},'Native question cancellation is preserved as a rejected tool, not a guessed turn abort');
      const after=await snapshot(); assert.equal(after.sessions[0].nativeId,before.nativeId);assert.equal(after.sessions[0].pid,before.pid);
      await page.locator('#chat-tab').click();await until(()=>page.locator('#approval').isHidden(),'Cancelled dialog clears');
      assert.match(await page.locator('#messages').innerText(),/The user doesn't want to proceed/);assert.equal(calls,1,'Question cancellation does not submit a replacement human task');
      fs.writeFileSync(path.join(base,'question-cancelled.json'),JSON.stringify(after,null,2));
      console.log(JSON.stringify({checks:['Original question/options; native Esc cancellation retained as an abnormal boundary without fabricating an answer'],nativeVersion,answerMode,localResponses:calls,paidModelCalls:0,evidence:base}));return;
    }
    if(answerMode==='multi') {
      // Native flow: Enter answers the first question; Space toggles choices; Tab opens the review.
      const rows=()=>page.locator('#terminal-area .xterm-rows').innerText();
      await nativeInput.press('Enter');
      await until(async()=>(await rows()).includes(checksQuestion.question),'The same native dialog moves to the second question');
      await nativeInput.press(' ');await nativeInput.press('ArrowDown');await nativeInput.press('ArrowDown');await nativeInput.press(' ');
      await until(async()=>/\[✔\] Unit tests[\s\S]*\[ \] Lint[\s\S]*\[✔\] Build/.test(await rows()),'Two native selections in the multi-select question');
      assert.ok((await snapshot()).sessions[0].nativeApproval,'The GUI keeps showing the open native question while it is answered');
      await nativeInput.press('Tab');
      await until(async()=>(await rows()).includes('Review your answers')&&(await rows()).includes('Unit tests, Build'),'Native review of both answers');
      fs.writeFileSync(path.join(base,'question-multi-review.txt'),await rows());
    }
    const expectedAnswer=answerMode==='other'?'Use my own original answer.':answerMode==='multi'?'Unit tests, Build':'Keep original';
    if(answerMode==='other') {
      assert.ok((await page.locator('#terminal-area .xterm-rows').innerText()).includes('3. Type something.'));
      await nativeInput.press('ArrowDown');await nativeInput.press('ArrowDown');
      await until(async()=>(await page.locator('#terminal-area .xterm-rows').innerText()).includes('❯ 3. Type something.'),'Actual native free-answer field selected');
      if(process.env.NAW_NATIVE_QUESTION_PASTE==='1') {
        await application.evaluate(({clipboard,nativeImage},text)=>{clipboard.readImage=()=>nativeImage.createEmpty();clipboard.readText=()=>text;},expectedAnswer);
        await page.locator('#terminal-paste').click();
      } else await nativeInput.type(expectedAnswer);
      await until(async()=>(await page.locator('#terminal-area .xterm-rows').innerText()).includes(expectedAnswer)&&Boolean((await snapshot()).sessions[0].nativeApproval),'Free answer is visible in the still-open native question before submitting');
      fs.writeFileSync(path.join(base,'question-free-draft.txt'),await page.locator('#terminal-area .xterm-rows').innerText());
    }
    await nativeInput.press('Enter');
    await until(async () => calls === 2 || (await page.locator('#terminal-area .xterm-rows').innerText()).includes('Submit answers'), 'Native selection or answer review');
    if (calls !== 2) {
      fs.writeFileSync(path.join(base,'question-review.txt'),await page.locator('#terminal-area .xterm-rows').innerText());
      await page.locator('#terminal-area .xterm-helper-textarea').press('Enter');
    }
    await until(async () => (await snapshot()).sessions[0].state === 'idle' && (await snapshot()).sessions[0].messages.some(m => m.text.includes('NATIVE_FINAL:')), 'Answer continues the same native turn');
    const after=(await snapshot()).sessions[0];
    await page.locator('#terminal-tab').click();await until(async()=>(await page.locator('#terminal-area .xterm-rows').innerText()).includes('NATIVE_FINAL:'),'Actual same TUI receives the final answer');
    fs.writeFileSync(path.join(base,'question-finished-terminal.txt'),await page.locator('#terminal-area .xterm-rows').innerText());
    assert.equal(after.nativeId,before.nativeId);assert.equal(after.pid,before.pid);assert.equal(calls,2);
    const request=JSON.parse(fs.readFileSync(path.join(base,'request-2.json')));
    const result=request.messages.flatMap(m=>m.content||[]).find(p=>p.type==='tool_result'&&p.tool_use_id==='toolu_local_question');
    assert.ok(result && JSON.stringify(result).includes(expectedAnswer),'The actual native tool result, not enqueue ACK, contains the selected answer');
    assert.ok(!(await snapshot()).room.messages.some(m=>m.text?.includes('NATIVE_FINAL:')),'The human-input boundary prevents a late private reply from leaking back into shared history');
    await page.locator('#chat-tab').click();
    assert.equal(await page.locator('#approval').isVisible(),false);
    assert.ok(!(await page.locator('#messages').innerText()).includes('原生本轮已结束'));
    assert.deepEqual(errors,[]);fs.writeFileSync(path.join(base,'question-finished.json'),JSON.stringify(await snapshot(),null,2));
    if(process.env.NAW_EVIDENCE_DIR){fs.mkdirSync(process.env.NAW_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.NAW_EVIDENCE_DIR,'native-question.png')});}
    console.log(JSON.stringify({checks:[`Exact native question${nativeQuestions.length>1?'s (one multi-select)':''}/options in the existing GUI panel and same TUI; actual native answer result; same identity; no late private sharing; no invented completion sentence`],nativeVersion,answerMode,localResponses:calls,paidModelCalls:0,evidence:base}));return;
  }
  if (process.env.NAW_TEST_NATIVE_PHASE === '1') {
    await until(()=>Boolean(releaseStart),'One bounded native request waits before text');
    await page.locator(`[data-session-id="${before.id}"]`).click();await page.locator('#chat-tab').click();
    await page.locator('#native-phase').getByText('Native blocks · 正在请求',{exact:true}).waitFor();
    fs.writeFileSync(path.join(base,'before-first-text.json'),JSON.stringify(await snapshot(),null,2));
    releaseStart();releaseStart=null;
  }
  await page.locator(`[data-session-id="${before.id}"]`).click(); await page.locator('#chat-tab').click();
  await until(() => calls === 2, 'Native tool loop');
  await until(async () => (await snapshot()).sessions[0].messages.some(m => m.text.includes('NATIVE_TOOL: 42')), 'Tool content before final reply');
  const live = (await snapshot()).sessions[0];
  assert.equal(live.state, 'working');
  if (compatibilityTrial) {
    assert.equal(live.queueAvailable, true, 'Native waiting queue remains available while working');
    fs.writeFileSync(path.join(base, 'compat-working.json'), JSON.stringify(live, null, 2));
    checks.push('Native queue capability is available while working on this qualified version');
  }
  await page.locator('#messages').getByText('NATIVE_FIRST: checking locally.', { exact: true }).waitFor();
  await page.locator('#messages .process-details').filter({hasText:'NATIVE_TOOL: 42'}).locator(':scope > summary').click();
  assert.match(await page.locator('#messages').innerText(), /NATIVE_TOOL: 42/);
  assert.equal(await page.locator('.native-progress').count(), 0);
  checks.push('Native intermediate text and tool result appear in the main reading stream before final response');
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await page.locator('#room-messages').getByText('NATIVE_FIRST: checking locally.', { exact: true }).waitFor();
  assert.match(await page.locator('#room-messages').innerText(), /NATIVE_TOOL: 42/);
  const sharing = (await snapshot()).room.messages;
  assert.ok(sharing.some(m => m.role === 'tool' && m.volatile));
  assert.ok(sharing.filter(m => m.sharedStream).every(m => m.sessionId === before.id && m.replyTo));
  assert.equal(calls, 2); assert.equal((await snapshot()).diagnostics.dispatches, 1);
  checks.push('Actual native ACK binds intermediate and tool blocks into the shared main reader before final reply, without another dispatch');
  releaseFinal();
  await until(async () => (await snapshot()).sessions[0].messages.some(m => m.kind === 'turn'), 'Native turn boundary');
  await until(async () => (await snapshot()).room.messages.some(m => m.role === 'assistant' && m.text.includes('NATIVE_FINAL:')), 'Display-confirmed shared final reply');
  const first = (await snapshot()).sessions[0];
  const sharedFinal = (await snapshot()).room.messages.filter(m => m.role === 'assistant' && m.text.includes('NATIVE_FINAL:'));
  assert.equal(sharedFinal.length, 1); assert.equal(sharedFinal[0].finalReply, true);
  assert.equal(first.messages.filter(m => m.text.includes('NATIVE_FINAL:')).length, 1);
  assert.equal(first.messages.filter(m => m.text.includes('NATIVE_FIRST:')).length, 1);
  assert.equal(first.nativeId, before.nativeId); assert.equal(first.pid, before.pid);
  const tool = first.messages.find(m => m.kind === 'tool'); assert.match(tool.input, /printf/); assert.equal(tool.status, 'complete');
  assert.ok(first.messages.findIndex(m => m.kind === 'tool') < first.messages.findIndex(m => m.text.includes('NATIVE_FINAL:')));
  await sleep(1100);
  assert.ok(fs.readFileSync(path.join(profile, 'workspace.json'), 'utf8').includes('NATIVE_TOOL: 42'));
  checks.push('Stable block order, display-confirmed shared reply, same native process, bounded structured tool history retained locally');
  // The native session's own usage metadata, read after the turn without another request.
  await until(async () => (await snapshot()).sessions[0].usage?.source === 'claude-session-usage', 'Native usage reading');
  assert.ok((await snapshot()).sessions[0].usage.context.window > 0); checks.push('Native usage metadata is read after the turn');
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'shared-native-blocks.png') }); }
  await page.locator(`[data-session-id="${before.id}"]`).click(); await page.locator('#chat-tab').click();
  await page.locator('#message-input').fill('Start the interrupt check.'); await page.locator('#send-button').click();
  await until(() => calls === 3 && held, 'Held native stream');
  await until(async () => (await snapshot()).sessions[0].messages.some(m => m.text.includes('NATIVE_PARTIAL:')), 'Partial native display');
  if (compatibilityTrial) await page.locator('#message-input').fill('Unsent compatibility draft.');
  await page.locator('#interrupt').click();
  await until(async () => (await snapshot()).sessions[0].messages.some(m => m.kind === 'turn' && m.status === 'interrupted'), 'Native interruption boundary');
  if (compatibilityTrial) {
    // Only the native API result + exact boundary + settled submission clear
    // this flag. Escape fallback leaves nativeInputRequired true.
    await until(async () => { const s = (await snapshot()).sessions[0]; return s.state === 'idle' && !s.nativeInputRequired && !s.interruptPending; }, 'Native API abort settles and graphical input recovers');
    assert.equal(await page.locator('#message-input').inputValue(), 'Unsent compatibility draft.');
    fs.writeFileSync(path.join(base, 'compat-aborted.json'), JSON.stringify(await snapshot(), null, 2));
    checks.push('Native API abort confirms its result/boundary/submission settlement and preserves the next unsent draft');
  }
  const after = (await snapshot()).sessions[0];
  assert.ok(after.messages.some(m => m.text.includes('NATIVE_PARTIAL:')));
  assert.equal(calls, 3); assert.deepEqual(errors, []);
  checks.push('Actual native interruption retains streamed text and records its confirmed boundary');
  const nativeId = after.nativeId, nativePid = after.pid;
  await page.locator('#terminal-tab').click();
  await page.locator('#terminal-area .xterm-screen').click();
  await page.keyboard.type('/clear'); await sleep(500);
  const clearEdit = await page.locator('#terminal-area').innerText();
  fs.writeFileSync(path.join(base, 'clear-before-enter.txt'), clearEdit);
  assert.equal(clearEdit.split('\n').filter(line => line.startsWith('❯')).at(-1)?.slice(1).trim(), '/clear');
  await page.keyboard.press('Enter');
  await until(async () => { const s = (await snapshot()).sessions[0]; return s.nativeId !== nativeId && !s.nativeContextPending && s.chatAvailable; }, 'Native clear on the verified version');
  const cleared = (await snapshot()).sessions[0];
  assert.equal(cleared.pid, nativePid); assert.ok(cleared.messages.some(m => m.text.includes('NATIVE_PARTIAL:'))); assert.equal(calls, 3);
  await page.locator('#chat-tab').click();
  if (compatibilityTrial) {
    assert.equal(await page.locator('#message-input').inputValue(), 'Unsent compatibility draft.');
    fs.writeFileSync(path.join(base, 'compat-cleared.json'), JSON.stringify(await snapshot(), null, 2));
  }
  checks.push('Native clear changes context identity without replacing the process, discarding local history or making another model call');
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'native-blocks.png') }); }
  console.log(JSON.stringify({ checks, nativeVersion, localResponses: calls, paidModelCalls: 0, errors, evidence: base }));
})().catch(async error => {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(base, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  console.error(error.stack, '\nEvidence:', base); process.exitCode = 1;
}).finally(testScratch.cleanup(cleanup));
