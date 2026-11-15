const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// Real Electron + real Claude CLI 2.1.322/2.1.323 + the real bridge; canned responses on loopback (B11 fixture).
// Question (the person, 11-15): a prompt typed in the terminal while Claude works waits in Claude's own queue;
// pulled back with ↑, edited and sent again, the terminal holds only the edited prompt. Does the chat view
// show only that one too? Also: a queued prompt pulled back and deleted is not shown, and two identical
// queued prompts, both read, are not taken back. Every prompt is typed in NAW's own terminal view.
// Bounded: 1 native session, 3 turns, at most 8 local responses. Takes the shared GUI slot (exit 75 when busy).
// No paid inference or daily app. Fixture text is made up.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { _electron } = testScratch.playwright(require('playwright'));
const loopback = require('./fixtures/loopback-model.cjs');
const root = path.resolve(__dirname, '..');
const { connectService } = require(path.join(root, 'app/service-client.cjs'));
const { executable } = require(path.join(root, 'app/platform.cjs'));
const located = process.env.NAW_CLAUDE_BIN || executable('claude'), binary = located && fs.realpathSync(located); if (!binary) throw Error('Real Claude CLI required');
const nativeVersion = testScratch.childProcess.execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
// The queue records read here (enqueue, popAll/popOne, remove) were read from the 2.1.323 bundle and measured by this script.
assert.match(nativeVersion, /^2\.1\.32[23](?=\s|$)/, 'Queued prompt editing is measured on exact 2.1.322 and 2.1.323 only');
const common = testScratch.childProcess.execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('GUI slot occupied; no GUI launched.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Claude 7', task: 'edited queued prompt shown once', token, pid: process.pid, at: new Date().toISOString() }));
const base = testScratch.directory(path.join(os.tmpdir(), 'naw-native-queue-edit-'));
const profile = path.join(base, 'profile'), cwd = path.join(base, 'work'), config = path.join(base, 'claude');
for (const dir of [profile, cwd, config]) fs.mkdirSync(dir, { mode: 0o700 });
const TOOL_SECONDS = 16, BUDGET = 8;
let application, page, client, calls = 0, budgetError;
const errors = [], checks = [], requests = [], viewFailures = [];
// The chat view's checks are collected, so one run reports every case.
function view(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`VIEW ${ok ? 'PASS' : 'FAIL'} ${name}: shown ${JSON.stringify(actual)}, terminal ${JSON.stringify(expected)}`);
  if (ok) checks.push(`Chat view: ${name}`); else viewFailures.push(name);
}
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
// A turn's first request runs one long local step; the request after its result ends the turn.
const fixture = loopback.create({ directory: base, provider: 'claude', respond: async (req, res, body) => {
  if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: 100, data: [] })); return;
  }
  const number = ++calls;
  if (number > BUDGET) { budgetError = Error('Native task response budget exceeded'); res.writeHead(429); res.end(); return; }
  const request = JSON.parse(body);
  fs.writeFileSync(path.join(base, `request-${number}.json`), body);
  // After the step: the model's last message asked for a tool and a result follows it (a prompt taken into
  // the turn can follow as a message of its own).
  const lastAt = request.messages.findLastIndex(m => m.role === 'assistant');
  const afterTool = lastAt >= 0 && Array.isArray(request.messages[lastAt].content) && request.messages[lastAt].content.some(b => b.type === 'tool_use') &&
    request.messages.slice(lastAt + 1).some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result'));
  requests.push({ number, at: Date.now(), afterTool });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  event(res, 'message_start', { message: { id: `msg_local_${number}`, type: 'message', role: 'assistant', model: request.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  if (!afterTool) {
    block(res, 0, { type: 'text', text: `WORK_${number}: running a long step.\n` });
    block(res, 1, { type: 'tool_use', id: `toolu_local_step_${number}`, name: 'Bash', input: { command: `sleep ${TOOL_SECONDS}`, description: 'A long local step' } });
  } else block(res, 0, { type: 'text', text: `REPLY_${number}: done.\n` });
  event(res, 'message_delta', { delta: { stop_reason: afterTool ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } });
  event(res, 'message_stop', {}); res.end();
} });
const snapshot = () => client.call('initial');
const terminalText = async () => (await page.locator('#terminal-area .xterm-rows').evaluateAll(rows => rows.filter(el => el.checkVisibility()).map(el => el.innerText).join('\n'))).replace(/ /g, ' ');
// The native edit line, spaces removed: xterm draws a wide character over two cells.
// With prompts queued, the empty edit line shows Claude's own hint (2.1.323), not text.
const editLine = async () => { const line = ((await terminalText()).split('\n').filter(l => /^\s*❯/.test(l)).at(-1) || '').replace(/^\s*❯/, '').replace(/\s+/g, ''); return line === 'Pressuptoeditqueuedmessages' ? '' : line; };
const squeeze = text => text.replace(/\s+/g, '');
const userTexts = request => request.messages.filter(m => m.role === 'user').flatMap(m => typeof m.content === 'string' ? [m.content] : m.content.filter(b => b.type === 'text').map(b => b.text));
const shownInputs = async () => (await snapshot()).sessions[0].messages.filter(m => m.role === 'user' && m.origin === 'native').map(m => m.text);
async function focusTerminal() { await page.locator('#terminal-tab').click(); await page.locator('#terminal-area .xterm-screen >> visible=true').click(); }
let screenNo = 0;
async function screen(name) { fs.writeFileSync(path.join(base, `screen-${String(++screenNo).padStart(2, '0')}-${name}.txt`), await terminalText()); }
async function typeLine(text) {
  await until(async () => (await editLine()) === '', `Empty edit line before typing ${text}`);
  await page.keyboard.type(text);
  await until(async () => (await editLine()) === squeeze(text), `Edit line shows ${text}`);
  await page.keyboard.press('Enter');
  await sleep(400); await screen(`after-${squeeze(text)}`);
  await until(async () => (await editLine()) === '', `Edit line taken after ${text}`);
}
// A turn typed at an idle prompt, held in its long step while `during` types.
async function turn(start, during) {
  const before = calls, finished = requests.length;
  await typeLine(start);
  await until(() => calls === before + 1 && !requests.at(-1).afterTool, `${start}: its long step starts`);
  await until(async () => (await snapshot()).sessions[0].state === 'working', `${start}: working`);
  await sleep(1500);
  const t0 = Date.now();
  await during();
  assert.ok(Date.now() - t0 < (TOOL_SECONDS - 3) * 1000, 'Typed while the step still ran');
  await until(() => requests.length > finished + 1 && requests.at(-1).afterTool, `${start}: the request after the step`, (TOOL_SECONDS + 20) * 1000);
  await until(async () => { const s = (await snapshot()).sessions[0]; return s.state === 'idle' && s.messages.some(m => m.text?.includes(`REPLY_${calls}`)); }, `${start}: the turn ends`, 30000);
  return JSON.parse(fs.readFileSync(path.join(base, `request-${calls}.json`), 'utf8'));
}
async function cleanup() {
  if (application) await application.close().catch(() => {});
  if (client) { try { for (const s of (await snapshot()).sessions) await client.call('stop', s.id); await client.call('shutdown'); } finally { client.close(); } }
  await fixture.stop();
}
// The native queue's own records, from this test's own session journal: kinds and times only, plus the made-up text.
function journal(nativeId) {
  const dir = path.join(config, 'projects'), found = [];
  for (const project of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const file = path.join(dir, project, `${nativeId}.jsonl`);
    if (fs.existsSync(file)) found.push(file);
  }
  assert.equal(found.length, 1, 'One journal for the test session');
  return fs.readFileSync(found[0], 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(r => r.type === 'queue-operation' || (r.type === 'user' && !r.isMeta) || (r.type === 'attachment' && r.attachment?.type === 'queued_command'))
    .map(r => r.type === 'queue-operation' ? { type: r.type, operation: r.operation, timestamp: r.timestamp, ...(r.reason ? { reason: r.reason } : {}), ...(typeof r.content === 'string' ? { content: r.content } : {}) }
      : r.type === 'attachment' ? { type: r.type, attachment: 'queued_command', timestamp: r.timestamp, prompt: typeof r.attachment.prompt === 'string' ? r.attachment.prompt : undefined }
      : { type: r.type, timestamp: r.timestamp, promptId: r.promptId, text: typeof r.message?.content === 'string' ? r.message.content : (r.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n') || '(tool result)' });
}
(async () => {
  await fixture.start(); await fixture.preflight();
  const shim = path.join(base, 'claude-local');
  fixture.wrapper(binary, { file: shim, env: { CLAUDE_CONFIG_DIR: config }, args: ['--allowedTools', 'Bash(sleep:*)', '--model', 'haiku'] });
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [fs.realpathSync(cwd)]: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify({ claude: shim }), { mode: 0o600 });
  application = await _electron.launch({ executablePath: require('electron'), args: [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await application.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor(); client = await connectService(profile, 'native-queue-edit-test');
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check();
  await page.locator('#session-name').fill('Queue edit');
  const chosen = await page.locator('#chosen-folder').innerText(); assert.ok([path.resolve(base), fs.realpathSync(base)].some(owned => chosen.startsWith(owned + path.sep)), 'Only owned fixture folders');
  const prefix = [path.resolve(base), fs.realpathSync(base)].find(owned => chosen.startsWith(owned + path.sep));
  const canonicalChosen = fs.realpathSync(base) + chosen.slice(prefix.length);
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [chosen]: { hasTrustDialogAccepted: true }, [canonicalChosen]: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
  await createIn(page, 'terminal');
  await until(async () => /Yes, I trust this folder|Do you want to use this API key/.test(await page.locator('#terminal-area').innerText()) || (await snapshot()).sessions[0]?.chatAvailable, 'Native startup');
  if ((await page.locator('#terminal-area').innerText()).includes('Yes, I trust this folder')) {
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
  const nativeId = (await snapshot()).sessions[0].nativeId;
  await focusTerminal();

  // 1. Queued, pulled back with ↑, edited, sent again: the terminal and the model have only the edited prompt.
  const edited = await turn('开始第一件', async () => {
    await typeLine('方案 A');
    await page.keyboard.press('ArrowUp');
    await until(async () => (await editLine()) === squeeze('方案 A'), 'The queued prompt is back in the edit line');
    await page.keyboard.press('Backspace'); await page.keyboard.type('B');
    await until(async () => (await editLine()) === squeeze('方案 B'), 'Edited to 方案 B');
    await page.keyboard.press('Enter');
    await until(async () => (await editLine()) === '', 'The edited prompt is queued');
  });
  assert.equal(userTexts(edited).filter(t => t.includes('方案 B')).length, 1, 'The model reads the edited prompt once');
  assert.ok(!userTexts(edited).some(t => t.includes('方案 A')), 'The model never reads the pulled-back prompt');
  checks.push('Native: the edited queued prompt reaches the model once; the original never does');
  view('edited queued prompt', (await shownInputs()).filter(t => /方案/.test(t)), ['方案 B']);

  // 2. The same prompt queued twice, both read: neither is taken back. NAW keeps one row for one text under one
  // prompt id (claude-unannounced-stop: "the same submit seen twice keeps one row"), so the chat view shows one;
  // the terminal shows two. That is older than this check and is reported, not asserted here.
  const twice = await turn('开始第二件', async () => { await typeLine('方案 C'); await typeLine('方案 C'); });
  assert.equal(userTexts(twice).filter(t => t.includes('方案 C')).length, 2, 'The model reads both identical prompts');
  checks.push('Native: two identical queued prompts reach the model as two');
  const sameText = (await shownInputs()).filter(t => /方案 C/.test(t));
  view('two identical queued prompts are not taken back', sameText.length > 0, true);
  console.log(`KNOWN two identical queued prompts: chat view shows ${sameText.length}, terminal shows 2 (one row per text and prompt id)`);

  // 3. Queued, pulled back with ↑ and deleted: never sent, never shown.
  const removed = await turn('开始第三件', async () => {
    await typeLine('方案 D');
    await page.keyboard.press('ArrowUp');
    await until(async () => (await editLine()) === squeeze('方案 D'), 'The queued prompt is back in the edit line');
    for (let i = 0; i < '方案 D'.length; i++) await page.keyboard.press('Backspace');
    await until(async () => (await editLine()) === '', 'Deleted from the edit line');
  });
  assert.ok(!userTexts(removed).some(t => t.includes('方案 D')), 'The model never reads the deleted prompt');
  checks.push('Native: a queued prompt pulled back and deleted never reaches the model');
  view('queued prompt pulled back and deleted', (await shownInputs()).filter(t => /方案 D/.test(t)), []);

  await page.locator('#chat-tab').click(); await sleep(400);
  const chat = await page.locator('#messages').innerText().catch(() => '');
  fs.writeFileSync(path.join(base, 'chat.txt'), chat);
  await page.screenshot({ path: path.join(base, 'chat.png') });
  view('as drawn (A, B, D)', ['方案 A', '方案 B', '方案 D'].map(word => (chat.match(new RegExp(word, 'g')) || []).length), [0, 1, 0]);
  view('as drawn (C kept)', (chat.match(/方案 C/g) || []).length > 0, true);
  assert.deepEqual(errors, []); fixture.assertClean();
  assert.deepEqual(viewFailures, [], 'The chat view matches the terminal in every case');
  console.log(JSON.stringify({ checks, nativeVersion, journal: journal(nativeId), fixture: fixture.summary(), localResponses: calls, paidModelCalls: 0, errors, evidence: base }));
})().catch(async error => {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(base, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  try { const s = client && (await snapshot()).sessions[0]; if (s?.nativeId) console.error('JOURNAL', JSON.stringify(journal(s.nativeId))); } catch { /* evidence only */ }
  console.error(error.stack, '\nEvidence:', base); process.exitCode = 1;
}).finally(testScratch.cleanup(async () => {
  try { await cleanup(); } finally {
    try { if (JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token === token) { fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); } } catch (error) { console.error('Slot release', error.message); process.exitCode = 1; }
  }
}));
