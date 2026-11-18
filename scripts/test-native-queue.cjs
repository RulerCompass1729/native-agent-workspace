const testScratch = require('./fixtures/test-scratch.cjs');
const { joinSpace } = require('./fixtures/space-membership.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
const { chooseRecipient: inlineRecipient, fillRoomMessage, roomBody } = require('./room-input.cjs');
// Real Electron + real Claude CLI; canned responses are served on loopback.
// No paid inference, user profile edits, global keyboard input, or foregrounding.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const installed = Boolean(process.env.NAW_APP_EXECUTABLE);
const { _electron } = testScratch.playwright(installed ? { _electron: require('./fixtures/installed-renderer.cjs') } : require('playwright'));
const loopback = require('./fixtures/loopback-model.cjs');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connectService } = require(path.join(code, 'app/service-client.cjs'));
const { executable, processIdentity } = require(path.join(code, 'app/platform.cjs'));
const shared = process.env.NAW_QUEUE_SHARED === '1';
const modelOnly = process.env.NAW_MODEL_ONLY === '1';
// The solo model-switch journey sends no task and needs no model responder.
const noModelServer = modelOnly && !shared;
const inlineTrial = process.env.NAW_NATIVE_INLINE_TRIAL === '1';
const inlineTool = process.env.NAW_NATIVE_INLINE_TOOL === '1';
assert.ok(!inlineTool || inlineTrial);
assert.ok(!inlineTrial || (!shared && !modelOnly), 'One bounded native inline task only');
const input = shared ? '#shared-input' : '#message-input', send = shared ? '#forward-button' : '#send-button';
const base = testScratch.directory(path.join(os.tmpdir(), 'naw-native-queue-test-'));
const profile = path.join(base, 'profile'), cwd = path.join(base, 'work'), config = path.join(base, 'claude');
for (const dir of [profile, cwd, config]) fs.mkdirSync(dir, { mode: 0o700 });
const located = executable('claude'), binary = located && fs.realpathSync(located); if (!binary) throw Error('Real Claude CLI required');
const nativeVersion = testScratch.childProcess.execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
// Each journey runs only on the exact versions it was verified on (app/tests/claude-319-contract.test.cjs pins this
// line). The third list covers the queue journey, solo and shared, and the shared model-only journey; all three
// passed on exact 2.1.327 in the isolated loopback qualification, and on exact 2.1.322 on 2026-11-10 and on exact 2.1.323 on 2026-11-12 inside the loopback fixture's sandbox.
// The product also qualifies queueing on 318, 319 and 321, which are not installed and have not been run.
assert.match(nativeVersion, inlineTrial ? /^2\.1\.312\b/ : noModelServer ? /^2\.1\.(308|309|310|311|316|317|318|319(?=\s|$))\b/ : /^2\.1\.(308|309|310|311|322(?=\s|$)|323(?=\s|$)|327(?=\s|$))\b/, 'Verify the updated native contract before sending a test task');
// 2.1.322 and 2.1.323 offer mid-turn delivery: a queued message is held for the running turn's next tool boundary. This
// journey's first turn has no tool, so it runs as its own turn when that turn ends (the fallback); the words say so.
// The mid-turn journey itself is scripts/test-native-midturn.cjs.
const midturn = /^2\.1\.32[237](?=\s|$)/.test(nativeVersion);
const queueLabel = midturn ? '工具结束时送进本轮 ↑' : '等本轮结束后发送 ↑';
let application, page, client, calls = 0, held, releaseFinal, pausedNative;
let budgetError, toolMarker;
const errors = [], checks = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 30000) {
  const start = Date.now(); while (Date.now() - start < timeout) { if (budgetError) throw budgetError; if (await fn()) return; await sleep(75); } throw Error(label);
}
function event(res, type, body) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`); }
function block(res, index, content) {
  event(res, 'content_block_start', { index, content_block: content.type === 'text' ? { type: 'text', text: '' } : { ...content, input: {} } });
  event(res, 'content_block_delta', { index, delta: content.type === 'text' ? { type: 'text_delta', text: content.text } : { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } });
  event(res, 'content_block_stop', { index });
}
// The one B11 loopback fixture: 127.0.0.1, random port, sandboxed CLI, fixed responses below.
const fixture = loopback.create({ directory: base, provider: 'claude', respond: async (req, res, body) => {
  {
    if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: 100, data: [] })); return;
    }
    const number = ++calls;
    if (number > (modelOnly ? 0 : 2)) { budgetError = Error('Native task response budget exceeded'); res.writeHead(429); res.end(); return; }
    const request = JSON.parse(body);
    if (inlineTrial) assert.match(request.model, /haiku/i, 'Only the explicitly selected fixture model');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    event(res, 'message_start', { message: { id: `msg_local_${number}`, type: 'message', role: 'assistant', model: request.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    fs.writeFileSync(path.join(base, `request-${number}.json`), body);
    if (number > 2) throw Error('Native request budget exceeded');
    block(res, 0, { type: 'text', text: number === 1 ? 'FIRST_NATIVE_WORK: original task.\n' : 'QUEUED_NATIVE_REPLY: next task.\n' });
    if (inlineTool && number === 1) {
      block(res, 1, { type: 'tool_use', id: 'native_owned_hold', name: 'Bash', input: { command: 'printf ready > tool-started; sleep 8; printf NATIVE_TOOL_DONE', description: 'Bounded owned native input fixture' } });
    }
    const finish = () => {
      event(res, 'message_delta', { delta: { stop_reason: inlineTool && number === 1 ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
      event(res, 'message_stop', {}); res.end();
    };
    if (number === 1) { held = res; if (inlineTool) finish(); else releaseFinal = finish; } else finish();
  }
} });
const snapshot = () => client.call('initial');
function resumeNative() {
  if (!pausedNative) return;
  const stopped = pausedNative; pausedNative = null;
  if (processIdentity(stopped.pid)?.started === stopped.started) process.kill(stopped.pid, 'SIGCONT');
}
const terminalText = async () => (await page.locator('#terminal-area .xterm-rows').evaluateAll(rows => rows.filter(el => el.checkVisibility()).map(el => el.innerText).join('\n'))).replace(/\u00a0/g, ' ');
// One key into the native prompt itself, through the row's own terminal view.
async function nativeKey(key, expected) {
  await page.locator('#terminal-tab').click(); await page.locator('#terminal-area .xterm-screen >> visible=true').click();
  await page.keyboard.press(key);
  await until(async () => expected.test((await terminalText()).split('\n').filter(l => /^❯/.test(l.trim())).at(-1) || ''), 'Native prompt shows ' + expected);
  await page.locator('#chat-tab').click();
}
async function cleanup() {
  resumeNative();
  releaseFinal?.(); held?.destroy();
  if (application) await application.close().catch(() => {});
  if (client) { try { for (const s of (await snapshot()).sessions) await client.call('stop', s.id); await client.call('shutdown'); } finally { client.close(); } }
  await fixture.stop();
}
(async () => {
  // Every journey runs the CLI inside the fixture's sandbox. The model-only journey sends no task: any model
  // request there is refused by the response budget above and fails the run.
  await fixture.start(); await fixture.preflight();
  const shim = path.join(base, 'claude-local');
  // A selected executable is the supported native-discovery setting. No
  // production adapter methods are replaced by this test.
  // --allowedTools takes several values, so --model follows it: the session arguments NAW adds come after these,
  // and a --model or --permission-mode of NAW's own would now win over these.
  fixture.wrapper(binary, { file: shim, env: { CLAUDE_CONFIG_DIR: config }, args: inlineTool
    ? ['--permission-mode', 'default', '--allowedTools', 'Bash(printf:*)', 'Bash(sleep:*)', '--model', 'haiku']
    : ['--allowedTools', 'Bash(printf:*)', '--model', 'haiku'] });
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [fs.realpathSync(cwd)]: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify({ claude: shim }), { mode: 0o600 });
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], ...(process.env.NAW_VIDEO_DIR ? { recordVideo: { dir: process.env.NAW_VIDEO_DIR, size: { width: 1280, height: 900 } } } : {}), env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await application.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor(); client = await connectService(profile, 'native-block-test');
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check();
  await page.locator('#session-name').fill('Native blocks');
  const chosen = await page.locator('#chosen-folder').innerText(); assert.ok([path.resolve(base), fs.realpathSync(base)].some(owned => chosen.startsWith(owned + path.sep)), 'Only owned fixture folders');
  const prefix = [path.resolve(base), fs.realpathSync(base)].find(owned => chosen.startsWith(owned + path.sep));
  const canonicalChosen = fs.realpathSync(base) + chosen.slice(prefix.length);
  toolMarker = path.join(canonicalChosen, 'tool-started');
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [chosen]: { hasTrustDialogAccepted: true }, [canonicalChosen]: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
  await createIn(page, 'terminal');
  await until(async () => /Yes, I trust this folder|Do you want to use this API key/.test(await page.locator('#terminal-area').innerText()) || (await snapshot()).sessions[0]?.chatAvailable, 'Native startup');
  if ((await page.locator('#terminal-area').innerText()).includes('Yes, I trust this folder')) {
    assert.ok((await terminalText()).replace(/\s/g, '').includes(canonicalChosen.replace(/\s/g, '')), 'Native trust question names only the exact owned fixture');
    await page.locator('#terminal-area .xterm-screen').click(); await page.keyboard.press('ArrowDown');
    await until(async () => /❯\s*Yes, I trust this folder/.test(await terminalText()), 'Actual native trust choice selected'); await page.keyboard.press('Enter');
  }
  await until(async () => (await page.locator('#terminal-area').innerText()).includes('Do you want to use this API key') || (await snapshot()).sessions[0]?.chatAvailable, 'Native key prompt');
  if ((await page.locator('#terminal-area').innerText()).includes('Do you want to use this API key')) {
    await page.locator('#terminal-area .xterm-screen').click(); await page.keyboard.press('ArrowUp');
    await until(async () => /^❯\s*Yes(?:\s|$)/.test((await terminalText()).split('\n').filter(line => line.trim().startsWith('❯')).at(-1)?.trim() || ''), 'Native fixture key choice is visibly selected');
    await page.keyboard.press('Enter');
  }
  await until(async () => (await snapshot()).sessions[0]?.chatAvailable, 'Native submission bridge', 60000);
  if (modelOnly) {
    await require('./native-model-check.cjs')({ page, snapshot, base });
    assert.equal(calls, 0); assert.deepEqual(errors, []);
    if (noModelServer) assert.equal((await snapshot()).diagnostics.dispatches, 0);
    fixture.assertClean();
    console.log(JSON.stringify({ checks: ['Native model switches and GUI reload preserve identity/draft and match actual header'], nativeVersion, modelCalls: calls, fixture: fixture.summary(), guiDispatches: (await snapshot()).diagnostics.dispatches, errors, evidence: base })); return;
  }
  const before = (await snapshot()).sessions[0];
  assert.equal(before.queueAvailable, true);
  await page.locator('#chat-tab').click();
  await page.locator('#message-input').fill('Run the original local task.'); await page.locator('#send-button').click();
  await until(() => calls === 1 && held, 'Native original task');
  if (inlineTool) {
    await until(async () => { const s = (await snapshot()).sessions[0]; return s.nativeApproval?.requests?.some(r => r.title === 'Bash') || fs.existsSync(toolMarker); }, 'Native tool permission or owned tool start');
    if (!fs.existsSync(toolMarker)) {
      const s = (await snapshot()).sessions[0], request = s.nativeApproval.requests.find(r => r.title === 'Bash');
      assert.equal(JSON.parse(request.input).command, 'printf ready > tool-started; sleep 8; printf NATIVE_TOOL_DONE');
      await page.locator('#terminal-tab').click(); await page.locator('#terminal-area .xterm-screen >> visible=true').click();
      await until(async () => /❯\s*1\. Yes/.test(await terminalText()), 'Exact native one-time approval is selected');
      fs.writeFileSync(path.join(base, 'owned-tool-permission.txt'), await terminalText()); await page.keyboard.press('Enter');
    }
  }
  await until(async () => (await snapshot()).sessions[0].state === 'working', 'Working native state');
  if (inlineTrial) {
    const text = 'Native inline original text.';
    if (inlineTool) await until(() => fs.existsSync(toolMarker), 'Owned native tool is actually running');
    await page.locator('#terminal-tab').click(); await page.locator('#terminal-area .xterm-screen >> visible=true').click();
    await until(async () => /❯\s*$/.test((await terminalText()).split('\n').filter(l => /^❯/.test(l.trim())).at(-1) || ''), 'Native edit line is empty');
    await page.keyboard.type(text, { delay: 15 });
    await until(async () => ((await terminalText()).split('\n').filter(l => /^❯/.test(l.trim())).at(-1) || '').trim() === '❯ ' + text, 'Exact native edit line before Enter');
    fs.writeFileSync(path.join(base, 'inline-before-enter.txt'), await terminalText()); await page.keyboard.press('Enter');
    await sleep(400); assert.equal(calls, 1, 'Ordinary native Enter queues until the first task completes');
    if (!inlineTool) { releaseFinal(); releaseFinal = null; }
    await until(() => calls === 2, 'Native accepts its queued terminal input');
    await until(async () => { const s = (await snapshot()).sessions[0]; return s.state === 'idle' && s.messages.some(m => m.text.includes('QUEUED_NATIVE_REPLY')); }, 'Second native reply completes');
    const after = (await snapshot()).sessions[0];
    fs.writeFileSync(path.join(base, 'native-inline-snapshot.json'), JSON.stringify({ before, after, calls, errors }, null, 2));
    let acceptedText = text, acceptedId;
    if (inlineTool) {
      // Compare with the actual native saved rendering, not a hand-built or
      // stripped reminder. The typed input remains visible in the native TUI.
      let accepted;
      // A native append resolves before the asynchronous transcript flush.
      // Wait for that exact saved record; neither an API reply nor idle alone
      // claims that durable text is already available on disk.
      await until(() => {
        const transcriptRows = fs.readdirSync(path.join(config, 'projects'), { recursive: true })
          .filter(name => name.endsWith(`${after.nativeId}.jsonl`))
          .flatMap(name => fs.readFileSync(path.join(config, 'projects', name), 'utf8').split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line)));
        accepted = transcriptRows.filter(row => row.type === 'attachment' && row.attachment?.type === 'queued_command' && row.attachment.prompt === text);
        return accepted.length > 0;
      }, 'Actual native accepted attachment is durably saved', 5000);
      assert.equal(accepted.length, 1, 'One actual accepted queued attachment');
      acceptedText = accepted[0].rendered.flatMap(block => typeof block.content === 'string' ? [block.content] : block.content.filter(item => item.type === 'text').map(item => item.text)).join('\n');
      acceptedId = `native:${after.nativeId}:prompt:${accepted[0].uuid}`;
      assert.equal(acceptedText.split(text).length - 1, 1);
    }
    const rows = after.messages.filter(m => m.role === 'user' && m.text === acceptedText);
    fs.writeFileSync(path.join(base, 'native-inline-completed.json'), JSON.stringify({ before, after, rows, calls, errors }, null, 2));
    assert.equal(rows.length, 1, 'Actual native accepted rendering has one GUI row');
    if (acceptedId) assert.equal(rows[0].id, acceptedId, 'GUI identity is the actual accepted attachment UUID');
    assert.equal(rows[0].inputMode, inlineTool ? 'native-inline' : 'native-prompt', 'Native accepted input follows its actual tool or prompt boundary');
    assert.equal(after.nativeId, before.nativeId); assert.equal(after.pid, before.pid);
    const request = JSON.parse(fs.readFileSync(path.join(base, 'request-2.json')));
    assert.equal(request.messages.filter(m => m.role === 'user').flatMap(m => typeof m.content === 'string' ? [m.content] : m.content.filter(b => b.type === 'text').map(b => b.text)).filter(t => t.includes(text)).length, 1);
    await page.locator('#chat-tab').click(); assert.equal(await page.locator('#messages .message-body').filter({ hasText: text }).count(), 1);
    if (inlineTool) assert.equal(await page.locator('#messages .message').filter({ has: page.locator('.message-body').filter({ hasText: text }) }).locator('.message-heading strong').first().innerText(), '原生会话', 'Native framing is not labeled as human-authored');
    fs.writeFileSync(path.join(base, 'native-inline-completed.json'), JSON.stringify({ before, after, rows, calls, errors }, null, 2));
    if (process.env.NAW_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'native-inline.png') });
    assert.deepEqual(errors, []); fixture.assertClean(); console.log(JSON.stringify({ fixture: fixture.summary(), checks: ['Real312 queued input reaches the model once and its exact native accepted rendering appears once under the original UUID'], nativeVersion, localResponses: calls, paidModelCalls: 0, evidence: base })); return;
  }
  await until(async () => (await page.locator('#send-button').innerText()) === queueLabel, 'Working composer receives state');
  if (shared) {
  // A draft in the native prompt makes native refuse a queued send before holding it.
  await nativeKey('x', /❯\s*x\s*$/);
  if (shared) {
    await page.locator('#message-input').fill('Private solo draft.');
    await joinSpace(page);
    await page.locator('#room-nav').click(); await page.locator('#room-record').click();
    await inlineRecipient(page, before.id);
    await until(async () => (await page.locator(send).innerText()) === queueLabel, 'Shared native waiting action');
  }
  const blocked = 'Blocked by a native draft.';
  if (shared) await fillRoomMessage(page, blocked); else await page.locator(input).fill(blocked);
  // Hold only this isolated row's CLI so the recorded/cleared state is visible
  // before native reads its existing draft and refuses the prompt. No provider
  // or product methods are replaced; always unpause before cleanup can stop it.
  const owned = (await snapshot()).sessions.find(s => s.id === before.id);
  assert.equal(owned.nativeId, before.nativeId); assert.equal(owned.pid, before.pid);
  pausedNative = processIdentity(owned.pid); assert.ok(pausedNative);
  // The sandbox wrapper replaces itself with the CLI under the same pid: the paused process is this session's own CLI.
  const pausedCommand = testScratch.childProcess.execFileSync('/bin/ps', ['-ww', '-o', 'args=', '-p', String(pausedNative.pid)], { encoding: 'utf8' });
  assert.ok(pausedCommand.includes(binary) && pausedCommand.includes(before.nativeId), 'The paused process is the native CLI of this session');
  assert.doesNotMatch(pausedCommand, /(^|\/)sandbox-exec\s/, 'The paused process is the CLI, not the sandbox wrapper that started it');
  process.kill(pausedNative.pid, 'SIGSTOP');
  try {
    await page.locator(send).click();
    await until(async () => (shared ? await roomBody(page) : await page.locator(input).inputValue()) === '', 'The recorded message clears before native refusal', 5000);
    assert.equal((await snapshot()).sessions[0].messages.find(m => m.text === blocked).status, 'awaiting-native');
    await page.screenshot({ path: path.join(base, 'refusal-cleared.png') });
    fs.writeFileSync(path.join(base, 'refusal-cleared.json'), JSON.stringify(await snapshot(), null, 2));
  } finally { resumeNative(); }
  await until(async () => (await snapshot()).sessions[0].messages.some(m => m.text === blocked && m.status === 'not-sent'), 'Native draft refuses the queued send');
  await until(async () => (shared ? await roomBody(page) : await page.locator(input).inputValue()) === blocked, 'A proven non-send returns to the untouched composer');
  await until(async () => (await page.locator('body').innerText()).includes('没有发出'), 'The record says it was not sent');
  await until(async () => (await page.locator('#toast').innerText()).includes('原生终端里还有未发送的草稿'), 'Native draft refusal, not a submission timeout');
  if (shared) assert.equal((await snapshot()).room.messages.find(m => m.text === blocked).deliveries[0].status, 'not-sent');
  else assert.equal((await snapshot()).sessions[0].liveDraft, blocked);
  await page.screenshot({ path: path.join(base, 'refusal-restored.png') });
  assert.equal(calls, 1);
  if (shared) await page.locator(`[data-session-id="${before.id}"]`).click();
  await nativeKey('Backspace', /❯\s*$/);
  if (shared) { await page.locator('#room-nav').click(); await page.locator('#room-record').click(); }
  checks.push('A recorded queued input visibly clears, then a native draft refusal marks 没有发出 and restores the untouched composer');
  } else await nativeKey('x', /❯\s*x\s*$/);
  // The room picks its recipient with an inline mention; a plain fill would drop it.
  if (shared) await fillRoomMessage(page, 'Do the next local task.'); else await page.locator(input).fill('Do the next local task.');
  assert.equal(await page.locator(send).innerText(), queueLabel);
  await page.locator(send).click();
  await until(async () => (await snapshot()).sessions[0].pendingQueue, 'Waiting native input');
  const pending = (await snapshot()).sessions[0];
  assert.equal(pending.messages.filter(m => m.text === 'Do the next local task.').length, 1);
  assert.equal(pending.messages.at(-1).status, 'awaiting-native');
  // Like a native TUI queue, the recorded message leaves the composer at once.
  await until(async () => (shared ? await roomBody(page) : await page.locator(input).inputValue()) === '', 'Queued message leaves the composer');
  if (!shared) assert.equal(pending.liveDraft, '');
  await until(() => page.locator(send).isDisabled(), 'Pending queue reaches composer');
  assert.equal(await page.locator(send).isDisabled(), true);
  // Covers both the former 15 s submission and 40 s RPC deadlines with one
  // native task. No polling prompts or repeat inference.
  await sleep(42000);
  const waiting = (await snapshot()).sessions[0];
  assert.equal(waiting.pendingQueue, pending.pendingQueue); assert.equal(waiting.state, 'working');
  assert.equal(calls, 1); assert.equal(waiting.nativeId, before.nativeId); assert.equal(waiting.pid, before.pid);
  assert.equal(waiting.messages.find(m => m.id === pending.pendingQueue).status, 'awaiting-native');
  // The GUI says why it waits: before 2.1.322 native runs a plugin's queued prompt only once idle, so it points to the
  // native terminal for mid-turn input; on 2.1.322 it waits for the next tool step, or the turn's end.
  const visible = await page.locator('body').innerText();
  assert.ok(visible.includes(midturn ? '等下一个工具结束时送进本轮' : '排队中，等空闲后发送'), 'The queued message says what it waits for');
  assert.ok(shared ? (await page.locator('#run-status').innerText()).includes(midturn ? '等它下一个工具结束时送进正在进行的回合' : '想中途插话，请在它的原生终端输入')
    : (await page.locator('#compose-hint').innerText()).includes(midturn ? '正等 Claude 下一个工具结束时送进本轮' : '想中途插话，请在原生终端输入'), 'The GUI says how this waiting input reaches the turn');
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
  if (!shared) assert.match(terminal, /❯\s*x(?:\s|$)/, 'Native draft is retained after both tasks');
  assert.equal(actual.messages.flatMap(m => typeof m.content === 'string' ? [m.content] : m.content.filter(b => b.type === 'text').map(b => b.text)).filter(t => t.trim() === 'x').length, 0, 'Native draft is not sent');
  assert.equal(calls, 2); assert.deepEqual(errors, []);
  checks.push('Actual native terminal and main conversation contain the same two inputs and replies');
  fixture.assertClean();
  console.log(JSON.stringify({ checks, shared, nativeVersion, fixture: fixture.summary(), localResponses: calls, paidModelCalls: 0, errors, evidence: base }));
})().catch(async error => {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(base, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  console.error(error.stack, '\nEvidence:', base); process.exitCode = 1;
}).finally(testScratch.cleanup(cleanup));
