const testScratch = require('./fixtures/test-scratch.cjs');
// Real Electron + real Claude Code 2.1.310 on a loopback fake API: a native
// session-scoped `/goal` keeps evaluating its condition and starting the next
// turn while the NAW window is closed. Two main turns and two evaluator
// verdicts are the whole inference budget; nothing paid, no profile edits.
// NAW_GOAL_DISCOVERY=1 only records the request shapes (main reply served,
// every other request rejected) so the evaluator can be told apart by body.
// NAW_GOAL_CASE=recovery instead kills the native process while the goal's
// second turn is in flight, recovers through NAW and checks the same row,
// native ID, draft, bypass mode, effort and goal; nothing starts until prompted.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..');
const { connectService } = require('../app/service-client.cjs');
const { executable } = require('../app/platform.cjs');
const base = testScratch.directory(path.join(os.tmpdir(), 'naw-native-claude-goal-'));
const profile = path.join(base, 'profile'), cwd = path.join(base, 'work'), config = path.join(base, 'claude'), userHome = path.join(base, 'home');
for (const dir of [profile, cwd, config, userHome]) fs.mkdirSync(dir, { mode: 0o700 });
const binary = process.env.NAW_CLAUDE_BIN || executable('claude'); if (!binary) throw Error('Real Claude CLI required');
const nativeVersion = testScratch.childProcess.execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
assert.match(nativeVersion, /^2\.1\.310\b/, 'Native /goal continuation is verified against the native contract of 2.1.310 only');
const discovery = process.env.NAW_GOAL_DISCOVERY === '1', recoveryCase = process.env.NAW_GOAL_CASE === 'recovery';
// Short enough to stay on one native edit line, and checkable from the transcript alone.
const condition = 'the assistant has replied GOAL_STEP_TWO';
const notMet = 'needs GOAL_STEP_TWO', met = 'done';
const draft = '原生目标运行期间未发送的草稿';
// Observed in the 2.1.310 executable: the Stop-hook evaluator system prompt and
// the directive the goal command injects into the first main turn.
const evaluatorSystem = 'You are evaluating a stop-condition hook in Claude Code';
const mainSystem = "You are Claude Code, Anthropic's official CLI for Claude.";
const goalDirective = `A session-scoped Stop hook is now active with condition: "${condition}"`;
let application, page, client, calls = 0, mains = 0, evals = 0, titles = 0, others = 0;
let releaseFirstTurn, budgetError, closedAt = 0, relaunchedAt = 0, heldSecond = null, promptedAfterRecovery = false;
const received = [], errors = [], checks = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 30000) {
  const start = Date.now(); while (Date.now() - start < timeout) { if (budgetError) throw budgetError; if (await fn()) return; await sleep(80); } throw Error(label);
}
function event(res, type, body) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`); }
const systemText = request => Array.isArray(request.system) ? request.system.map(block => block?.text || '').join('\n') : String(request.system || '');
const userText = request => (request.messages || []).filter(m => m.role === 'user')
  .map(m => Array.isArray(m.content) ? m.content.map(c => c?.text || '').join('\n') : String(m.content || '')).join('\n');
// The main model and the small fast evaluator both resolve to the same haiku id
// here, so the body decides: the evaluator carries the stop-condition system
// prompt and no tools, a main turn carries the CLI system prompt and its tools.
function classify(request) {
  const system = systemText(request);
  if (system.includes(evaluatorSystem)) return 'evaluator';
  if (system.includes(mainSystem) && (request.tools || []).length > 0) return 'main';
  return 'other';
}
function reply(res, request, number, text) {
  const model = request.model, id = `msg_local_${number}`;
  if (request.stream === false) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 4 } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  event(res, 'message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  event(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  event(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
  event(res, 'content_block_stop', { index: 0 });
  event(res, 'message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
  event(res, 'message_stop', {}); res.end();
}
function refuse(res, message, fatal) {
  if (fatal && !budgetError) budgetError = Error(message);
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }));
}
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', data => body += data);
  // A rejected expectation must still answer the request, so the waiting test
  // fails on budgetError instead of hanging on an unfinished response.
  req.on('end', () => serve(req, res, body).catch(error => { if (!res.headersSent) refuse(res, `goal test: ${error.message}`, true); else { budgetError = budgetError || error; res.end(); } }));
});
async function serve(req, res, body) {
  {
    if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: 100, data: [] })); return;
    }
    const number = ++calls;
    let request; try { request = JSON.parse(body); } catch { refuse(res, 'goal test: unparsable request body', true); return; }
    const kind = classify(request);
    received.push({ number, kind, at: Date.now(), model: request.model, effort: request.output_config?.effort, tools: (request.tools || []).length, stream: request.stream !== false });
    fs.writeFileSync(path.join(base, `request-${number}-${kind}.json`), JSON.stringify({ url: req.url, headers: req.headers, body: request }, null, 2));
    if (discovery) {
      // Record mode: a main turn gets a plain text reply, everything else is
      // rejected so the evaluator body is captured without a goal loop running.
      if (number > 4) { refuse(res, 'goal discovery: four requests recorded'); return; }
      if (kind === 'main') { mains++; reply(res, request, number, 'GOAL_STEP_ONE\n'); return; }
      if (kind === 'evaluator') evals++; else others++;
      refuse(res, `goal discovery: ${kind} request recorded, not served`); return;
    }
    if (recoveryCase) { serveRecovery(res, request, kind, number); return; }
    if (kind === 'main') {
      if (++mains > 2) { refuse(res, 'goal test budget: at most two main turns', true); return; }
      if (mains === 1) {
        assert.ok(userText(request).includes(goalDirective), 'The first goal turn carries the native goal directive');
        await new Promise(resolve => { releaseFirstTurn = resolve; });
        reply(res, request, number, 'GOAL_STEP_ONE\n'); return;
      }
      // The not-met reason comes back as Claude's next instruction.
      const instruction = userText(request);
      assert.ok(instruction.includes(notMet), 'The second goal turn is driven by the evaluator reason');
      fs.writeFileSync(path.join(base, 'second-turn-instruction.txt'), (instruction.match(/[\s\S]{0,160}needs GOAL_STEP_TWO[\s\S]{0,160}/) || [''])[0]);
      reply(res, request, number, 'GOAL_STEP_TWO\n'); return;
    }
    if (kind === 'evaluator') {
      if (++evals > 2) { refuse(res, 'goal test budget: at most two evaluator verdicts', true); return; }
      assert.ok(userText(request).includes(`Condition: ${condition}`), 'The evaluator is asked about this exact condition');
      reply(res, request, number, evals === 1 ? JSON.stringify({ ok: false, reason: notMet }) : JSON.stringify({ ok: true, reason: met })); return;
    }
    if (++others > 1) { refuse(res, 'goal test budget: only one native title request is allowed', true); return; }
    titles++; reply(res, request, number, 'Native goal check\n');
  }
}
// Recovery budget: three main turns (the second never answered), two verdicts.
function serveRecovery(res, request, kind, number) {
  if (kind === 'main') {
    if (++mains > 3) { refuse(res, 'recovery budget: at most three main turns', true); return; }
    if (mains === 1) {
      assert.ok(userText(request).includes(goalDirective), 'The first goal turn carries the native goal directive');
      reply(res, request, number, 'GOAL_STEP_ONE\n'); return;
    }
    // Held: the native process is killed while this goal turn is in flight.
    if (mains === 2) { assert.ok(userText(request).includes(notMet), 'The goal continues from the evaluator reason'); heldSecond = res; return; }
    if (!promptedAfterRecovery) { refuse(res, 'recovery: a turn started before the person prompted after recovery', true); return; }
    reply(res, request, number, 'GOAL_STEP_TWO\n'); return;
  }
  if (kind === 'evaluator') {
    if (++evals > 2) { refuse(res, 'recovery budget: at most two evaluator verdicts', true); return; }
    assert.ok(userText(request).includes(`Condition: ${condition}`), 'The evaluator is asked about this exact condition');
    reply(res, request, number, evals === 1 ? JSON.stringify({ ok: false, reason: notMet }) : JSON.stringify({ ok: true, reason: met })); return;
  }
  // A native title may be generated again by the recovered process.
  if (++others > 2) { refuse(res, 'recovery budget: at most two native title requests', true); return; }
  titles++; reply(res, request, number, 'Native goal check\n');
}
const snapshot = () => client.call('initial');
const terminalText = () => page.locator('#terminal-area .xterm-rows').innerText();
// The native edit line is the last line that starts with the prompt marker.
const editLine = async () => ((await terminalText()).replace(/ /g, ' ').split('\n').filter(l => /^❯ /.test(l)).at(-1) || '').trim();
const goalLines = text => text.replace(/ /g, ' ').split('\n').map(l => l.trim()).filter(l => /Goal (achieved|not yet met|set:|cleared|could not|paused|still active|check-in)/.test(l));
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
  releaseFirstTurn?.(); releaseFirstTurn = null; heldSecond?.destroy(); heldSecond = null;
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
const stage = async name => fs.writeFileSync(path.join(base, `stage-${name}.txt`), await terminalText());
async function launch() {
  const app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 60000 });
  let window;
  await until(async () => { for (const p of app.windows()) if (!p.isClosed() && await p.locator('#new-session').count().catch(() => 0)) { window = p; return true; } return false; }, 'Main window', 60000);
  window.setDefaultTimeout(15000); window.on('pageerror', e => errors.push(e.message));
  return { app, window };
}
function transcriptLines(pattern) {
  const projects = path.join(config, 'projects');
  const files = fs.existsSync(projects) ? fs.readdirSync(projects).flatMap(dir => fs.readdirSync(path.join(projects, dir)).filter(f => f.endsWith('.jsonl')).map(f => path.join(projects, dir, f))) : [];
  return files.flatMap(file => fs.readFileSync(file, 'utf8').split('\n').filter(line => pattern.test(line)));
}
async function recover(before) {
  await until(() => heldSecond, 'Native goal continues into a second turn', 120000);
  const live = (await snapshot()).sessions[0];
  assert.equal(live.nativePermissionMode, 'bypassPermissions', 'NAW kept the bypass mode the native hooks reported');
  assert.equal(live.nativeEffort, 'low', 'NAW kept the effort the native hooks reported');
  assert.equal(received.find(r => r.kind === 'main').effort, 'low', 'The first native turn ran at the launch effort');
  assert.match(await terminalText(), /bypass permissions on/, 'The native TUI runs in bypass before the fault');
  // Durable checkpoint before fault injection: identity, goal, draft, in-flight work.
  const checkpoint = { id: live.id, nativeId: live.nativeId, pid: live.pid, goal: condition, draft: live.liveDraft, inFlight: 'goal turn 2 held by the loopback API', mains, evals, at: Date.now() };
  fs.writeFileSync(path.join(base, 'checkpoint.json'), JSON.stringify(checkpoint, null, 2));
  assert.equal(checkpoint.draft, draft);
  await stage('before-kill'); process.kill(live.pid, 'SIGKILL');
  await until(async () => ['ended', 'error'].includes((await snapshot()).sessions[0].state), 'NAW records the native exit', 30000);
  heldSecond.destroy(); heldSecond = null;
  const ended = (await snapshot()).sessions[0]; fs.writeFileSync(path.join(base, 'after-kill.json'), JSON.stringify(ended, null, 2));
  // An ended row keeps its composer read-only; the draft must still be there.
  await page.locator(`[data-session-id="${live.id}"]`).click(); await page.locator('#chat-tab').click();
  assert.equal(await page.locator('#message-input').inputValue(), draft, 'The draft survives the native process loss');
  // An external terminal still holding the ID blocks recovery: no second writer.
  const external = path.join(base, 'external', 'claude'); fs.mkdirSync(path.dirname(external)); fs.writeFileSync(external, '#!/bin/sh\nsleep 60\n', { mode: 0o700 });
  const holder = testScratch.childProcess.spawn('/bin/sh', [external, '--resume', before.nativeId], { stdio: 'ignore' });
  await page.getByRole('button', { name: '继续原生会话' }).click();
  await until(async () => (await snapshot()).sessions[0].activity?.includes(`PID ${holder.pid}`), 'Recovery refuses while another process holds the native ID', 30000);
  assert.equal(mains, 2); const refused = (await snapshot()).sessions[0]; assert.ok(!refused.pid || refused.pid === live.pid || refused.state === 'error');
  holder.kill('SIGKILL'); await new Promise(resolve => holder.exitCode !== null || holder.signalCode ? resolve() : holder.once('exit', resolve));
  await page.getByRole('button', { name: '继续原生会话' }).click();
  await until(async () => { const s = (await snapshot()).sessions[0]; return s.chatAvailable && s.state === 'idle' && s.pid && s.pid !== live.pid; }, 'NAW recovers the same native session', 90000);
  const recovered = (await snapshot()).sessions[0]; fs.writeFileSync(path.join(base, 'recovered.json'), JSON.stringify(recovered, null, 2));
  assert.equal(recovered.id, before.id); assert.equal(recovered.nativeId, before.nativeId); assert.notEqual(recovered.pid, live.pid);
  const argv = testScratch.childProcess.execFileSync('ps', ['-o', 'args=', '-p', String(recovered.pid)], { encoding: 'utf8' });
  fs.writeFileSync(path.join(base, 'recovered-argv.txt'), argv);
  // The shim appends only `--model haiku` now, so single posture flags before it are NAW's.
  assert.ok(argv.includes(`--resume ${before.nativeId}`) && argv.split('--permission-mode bypassPermissions').length === 2 &&
    argv.split('--effort low').length === 2 && argv.trim().endsWith('--model haiku'), `Recovered launch: ${argv}`);
  await page.locator('#terminal-tab').click();
  await until(async () => /bypass permissions on/.test(await terminalText()), 'The recovered native TUI is in bypass again', 30000);
  await stage('recovered');
  // Nothing replays the interrupted goal turn; only an explicit prompt continues.
  await sleep(8000); assert.equal(mains, 2, 'No turn starts after recovery until the person prompts');
  await openChat(); assert.equal(await page.locator('#message-input').inputValue(), draft, 'The draft survives the recovery');
  await page.locator('#terminal-tab').click(); await page.locator('#terminal-area .xterm-screen').click();
  await page.keyboard.type('continue', { delay: 30 });
  await until(async () => (await editLine()) === '❯ continue', 'Exact native prompt on the edit line');
  promptedAfterRecovery = true; await page.keyboard.press('Enter');
  await until(async () => mains === 3 && evals === 2 && /Goal achieved/.test(await terminalText()), 'The restored native goal evaluates the same condition and completes', 120000);
  const terminal = await terminalText(); fs.writeFileSync(path.join(base, 'recovered-terminal.txt'), terminal);
  // The isolated profile has no saved effort, so native alone would resume at the model default.
  assert.equal(received.filter(r => r.kind === 'main').at(-1).effort, 'low', 'The recovered native turn keeps the session effort');
  const modes = transcriptLines(/"type":"permission-mode"/).filter(l => l.includes(before.nativeId));
  assert.match(modes.at(-1) || '', /bypassPermissions/, 'The native transcript records bypass after recovery');
  const final = (await snapshot()).sessions[0];
  assert.equal(final.nativeId, before.nativeId); assert.equal(final.nativePermissionMode, 'bypassPermissions');
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'goal-recovered-terminal.png') }); }
  assert.deepEqual(errors, []);
  checks.push('Killing the native process mid-goal and recovering through NAW keeps the row, native ID, draft, bypass mode and effort, replays nothing, and the restored goal completes on the next prompt; recovery is refused while another process holds the ID');
  console.log(JSON.stringify({ checks, nativeVersion, case: 'recovery', mainTurns: mains, evaluatorVerdicts: evals, nativeTitleResponses: titles, localResponses: calls, paidModelCalls: 0, killedPid: live.pid, recoveredPid: recovered.pid, goalLines: goalLines(terminal), received, errors, evidence: base }));
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const shim = path.join(base, 'claude-local');
  fs.writeFileSync(shim, '#!/usr/bin/python3\nimport os,sys\nfor key in ["ANTHROPIC_AUTH_TOKEN","CLAUDE_CODE_OAUTH_TOKEN","CLAUDE_CODE_CHILD_SESSION","CLAUDECODE","CLAUDE_CODE_SESSION_ID","CLAUDE_CODE_ENTRYPOINT"]: os.environ.pop(key,None)\nos.environ.update(' +
    `HOME=${JSON.stringify(userHome)},ANTHROPIC_BASE_URL=${JSON.stringify(`http://127.0.0.1:${server.address().port}`)},ANTHROPIC_API_KEY="local-fixture",CLAUDE_CONFIG_DIR=${JSON.stringify(config)},CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1")\n` +
    // Recovery: only the first launch adds bypass and an effort, like the dogfood
    // fork's one-shot launcher; a recovered launch gets them from NAW or not at all.
    `extra=["--model","haiku"]\nmarker=${JSON.stringify(path.join(base, 'first-launch'))}\n` +
    `if ${recoveryCase ? 'True' : 'False'} and not os.path.exists(marker):\n open(marker,"x").close()\n extra+=["--permission-mode","bypassPermissions","--effort","low"]\n` +
    `os.execv(${JSON.stringify(binary)},["claude"]+sys.argv[1:]+extra)\n`, { mode: 0o700 });
  // The service starts a new session in <profile>/workspace; trust it up front
  // so the only native dialog left is the API key choice. /goal needs the same
  // workspace trust as settings-file hooks, so this also opens the command.
  const serviceCwd = path.join(profile, 'workspace'); fs.mkdirSync(serviceCwd, { mode: 0o700 });
  const trusted = Object.fromEntries([cwd, serviceCwd].map(dir => [fs.realpathSync(dir), { hasTrustDialogAccepted: true }]));
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: trusted }), { mode: 0o600 });
  // Native session recap fires a background model request when the embedded
  // terminal loses and regains focus (observed on 2.1.310 when switching tabs).
  // Turn it off for this isolated test so the reply budget measures only the goal.
  // Recovery mirrors a person who has accepted the bypass warning once.
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ awaySummaryEnabled: false, ...(recoveryCase ? { skipDangerousModePermissionPrompt: true } : {}) }), { mode: 0o600 });
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify({ claude: shim }), { mode: 0o600 });
  ({ app: application, window: page } = await launch());
  client = await connectService(profile, 'native-claude-goal-test');
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check();
  await page.locator('#initial-view').selectOption('terminal'); await page.locator('#session-name').fill('Goal follow'); await page.locator('#confirm-create').click();
  const nativeInput = page.locator('#terminal-area .xterm-helper-textarea');
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
  const before = (await snapshot()).sessions[0];
  // The draft is filled before the goal starts: once the first turn is held the
  // session is working, and the draft must survive the closed window either way.
  await openChat(); await page.locator('#message-input').fill(draft);
  // Inspect the native completion menu and the exact edit line before Enter.
  await page.locator('#terminal-tab').click(); await page.locator('#terminal-area .xterm-screen').click();
  await page.keyboard.type('/goal');
  await until(async () => /❯ \/goal\b/.test(await terminalText()), 'Native menu highlights /goal');
  await stage('goal-menu'); await page.keyboard.press('Tab');
  // The native edit line then shows its argument hint: "/goal  [condition]".
  await until(async () => /^❯ \/goal\b/.test(await editLine()), 'Completion accepted on the edit line');
  await page.keyboard.type(condition, { delay: 30 });
  await until(async () => (await editLine()) === `❯ /goal ${condition}`, 'Exact native goal command on the edit line');
  await stage('goal-line');
  assert.ok(!/Add directory|Directory path|Select a model/i.test(await terminalText()), 'No other native command opened');
  await page.keyboard.press('Enter');
  await sleep(1500); await stage('goal-submitted');
  for (const gate of ['/goal is only available in trusted workspaces', "/goal can't run yet", "/goal can't run while hooks are restricted"]) {
    assert.ok(!(await terminalText()).includes(gate), `Native /goal refused: ${gate}`);
  }
  if (discovery) {
    // Record mode stops as soon as an evaluator request has been captured.
    await until(() => mains >= 1, 'First native goal turn reaches the loopback API', 90000);
    await sleep(500); await stage('after-first-turn');
    await until(() => evals >= 1 || others >= 1, 'A non-main request follows the first goal turn', 120000);
    await sleep(8000); await stage('after-rejection');
    fs.writeFileSync(path.join(base, 'discovery-terminal.txt'), await terminalText());
    const state = await snapshot(); fs.writeFileSync(path.join(base, 'discovery-state.json'), JSON.stringify(state, null, 2));
    await openChat(); fs.writeFileSync(path.join(base, 'discovery-reader.txt'), await page.locator('#messages').innerText());
    if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'goal-discovery.png') }); }
    console.log(JSON.stringify({ discovery: true, nativeVersion, received, goalLines: goalLines(fs.readFileSync(path.join(base, 'discovery-terminal.txt'), 'utf8')), localResponses: calls, paidModelCalls: 0, errors, evidence: base }));
    return;
  }
  if (recoveryCase) { await recover(before); return; }
  await until(() => releaseFirstTurn, 'Native goal starts its first main turn', 90000);
  await openChat();
  assert.equal(await page.locator('#message-input').inputValue(), draft);
  const held = (await snapshot()).sessions[0];
  fs.writeFileSync(path.join(base, 'held-first-turn.json'), JSON.stringify(held, null, 2));
  assert.equal(held.nativeId, before.nativeId); assert.equal(held.pid, before.pid);
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'goal-held.png') }); }
  // Close the window and app; the service keeps the native processes. Only then
  // is the first reply released, so every later turn runs with no NAW window.
  closedAt = Date.now(); await application.close(); application = null;
  releaseFirstTurn(); releaseFirstTurn = null;
  await until(async () => {
    const s = (await snapshot()).sessions[0];
    return mains === 2 && evals === 2 && s.state === 'idle' && s.messages.some(m => m.role === 'assistant' && m.text?.includes('GOAL_STEP_TWO'));
  }, 'Native goal evaluates, continues and completes with the NAW window closed', 180000);
  const closedState = await snapshot();
  fs.writeFileSync(path.join(base, 'closed-window-state.json'), JSON.stringify(closedState, null, 2));
  assert.ok(ownedNativeProcesses().length > 0, 'The owned native processes really continue without a window');
  const second = received.find(r => r.kind === 'main' && r.number > 1), verdict = received.filter(r => r.kind === 'evaluator').at(-1);
  relaunchedAt = Date.now();
  assert.ok(second.at > closedAt && second.at < relaunchedAt, 'The second main turn started while no NAW window existed');
  assert.ok(verdict.at > closedAt && verdict.at < relaunchedAt, 'The final evaluator verdict was served while no NAW window existed');
  checks.push('Native /goal evaluated its condition, started a second turn and cleared itself while the NAW app was closed');
  ({ app: application, window: page } = await launch());
  await openChat();
  assert.equal(await page.locator('#message-input').inputValue(), draft, 'The unsent draft survives the closed window and the goal loop');
  const reader = await page.locator('#messages').innerText();
  fs.writeFileSync(path.join(base, 'reopened-reader.txt'), reader);
  assert.ok(reader.includes('GOAL_STEP_ONE') && reader.includes('GOAL_STEP_TWO'), 'The reopened reader shows both goal replies');
  const reopened = (await snapshot()).sessions[0];
  fs.writeFileSync(path.join(base, 'reopened.json'), JSON.stringify(reopened, null, 2));
  assert.equal(reopened.id, before.id); assert.equal(reopened.nativeId, before.nativeId); assert.equal(reopened.pid, before.pid);
  const assistant = reopened.messages.filter(m => m.role === 'assistant').map(m => m.text || '');
  assert.ok(assistant.some(t => t.includes('GOAL_STEP_ONE')), 'The held first goal reply is attributed to the assistant');
  assert.ok(assistant.some(t => t.includes('GOAL_STEP_TWO')), 'The reply from the window-closed turn is attributed to the assistant');
  await page.locator('#terminal-tab').click();
  await until(async () => /Goal achieved/.test(await terminalText()), 'Native goal achieved line in the reattached terminal', 30000);
  const terminal = await terminalText(); fs.writeFileSync(path.join(base, 'reopened-terminal.txt'), terminal);
  const lines = goalLines(terminal); fs.writeFileSync(path.join(base, 'goal-lines.txt'), lines.join('\n'));
  assert.ok(lines.some(l => l.includes('Goal achieved')), `Native goal lines: ${JSON.stringify(lines)}`);
  // Durable native record of the same verdict, independent of the TUI viewport.
  const projects = path.join(config, 'projects');
  const transcripts = fs.existsSync(projects) ? fs.readdirSync(projects).flatMap(dir => fs.readdirSync(path.join(projects, dir)).filter(f => f.endsWith('.jsonl')).map(f => path.join(projects, dir, f))) : [];
  const status = transcripts.flatMap(file => fs.readFileSync(file, 'utf8').split('\n').filter(line => line.includes('goal_status')));
  fs.writeFileSync(path.join(base, 'transcript-goal-status.jsonl'), status.join('\n'));
  if (process.env.NAW_EVIDENCE_DIR) {
    await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'goal-reopened-terminal.png') });
    await page.locator('#chat-tab').click(); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'goal-reopened-reader.png') });
    fs.writeFileSync(path.join(process.env.NAW_EVIDENCE_DIR, 'goal-lines.txt'), lines.join('\n'));
  }
  if (closedState.diagnostics) assert.equal(closedState.diagnostics.dispatches, 0, 'The goal loop needs no GUI dispatch');
  assert.equal(mains, 2); assert.equal(evals, 2); assert.ok(titles <= 1); assert.deepEqual(errors, []);
  checks.push('Reopening the same profile restores the same session row, native ID and PID, the unsent draft, both goal replies and the native achieved line');
  console.log(JSON.stringify({ checks, nativeVersion, mainTurns: mains, evaluatorVerdicts: evals, nativeTitleResponses: titles, localResponses: calls, paidModelCalls: 0, goalLines: lines, received, errors, evidence: base }));
})().catch(async error => {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(base, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  if (page && !page.isClosed()) fs.writeFileSync(path.join(base, 'failure-terminal.txt'), await terminalText().catch(() => ''));
  console.error(error.stack, '\nRequests:', JSON.stringify(received), '\nEvidence:', base); process.exitCode = 1;
}).finally(testScratch.cleanup(cleanup));
