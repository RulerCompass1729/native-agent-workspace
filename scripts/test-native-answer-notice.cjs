const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// Real Electron + real Claude CLI 2.1.322 + the real bridge, one session; canned responses on loopback (B11 fixture).
// Question (queue e4432e37, the person 2026-11-13 20:0x: 「我发现我每次做完操作之后你没有反应,这其实也算是一个 bug」):
// an agent asks for two things the person must confirm and ends its turn; the person clicks Confirm on one card and
// Cancel on the other. Does NAW then tell that agent, by itself, in one message, so that it goes on without the person
// typing anything? The unit tests (app/tests/answer-notices.test.cjs) cover an agent still at work, receipts it read
// itself, a failed send, sessions gone; this run shows the real cards, clicks, bridge and native turn.
// Bounded: 1 native session, at most 8 local responses. Takes the shared GUI slot itself (exit 75 when it is busy).
// No paid inference or daily app.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { _electron } = testScratch.playwright(require('playwright'));
const loopback = require('./fixtures/loopback-model.cjs');
const root = path.resolve(__dirname, '..');
const { connectService } = require(path.join(root, 'app/service-client.cjs'));
const { executable } = require(path.join(root, 'app/platform.cjs'));
const evidence = process.env.NAW_EVIDENCE_DIR;
if (evidence) assert.ok(path.isAbsolute(evidence) && !path.resolve(evidence).startsWith(root + path.sep), 'Evidence stays outside the checkout');
const located = executable('claude'); if (!located) throw Error('Real Claude CLI required');
const version = file => testScratch.childProcess.execFileSync(file, ['--version'], { encoding: 'utf8' }).trim();
// Qualified on exact 2.1.322 (claude-bridge/hooks/register.js); the 2.1.322 beside a newer launcher, as NAW starts it.
let binary = fs.realpathSync(located);
const launcherVersion = version(binary);
if (path.basename(path.dirname(binary)) === 'versions' && path.basename(binary) !== '2.1.322' && fs.existsSync(path.join(path.dirname(binary), '2.1.322'))) binary = path.join(path.dirname(binary), '2.1.322');
const nativeVersion = version(binary);
assert.match(nativeVersion, /^2\.1\.322(?=\s|$)/, 'Qualified on exact 2.1.322 only');
const common = testScratch.childProcess.execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('GUI slot occupied; no GUI launched.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Claude 3', task: 'agent told after the person answers its cards', token, pid: process.pid, at: new Date().toISOString() }));
if (evidence) fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const base = testScratch.directory(path.join(os.tmpdir(), 'naw-native-answer-notice-'));
const profile = path.join(base, 'profile'), cwd = path.join(base, 'work'), config = path.join(base, 'claude');
for (const dir of [profile, cwd, config]) fs.mkdirSync(dir, { mode: 0o700 });
const ASKER = 'Asker', BUDGET = 8, TOOL = 'mcp__native_workspace__workspace_control', HEADING = '【NAW 确认结果】';
const TASK = 'ASK_TASK: make the spaces Alpha and Beta.';
const OP_A = `answer-run-alpha-${token.slice(0, 8)}`, OP_B = `answer-run-beta-${token.slice(0, 8)}`;
let application, page, client, calls = 0, budgetError;
const ids = {}, errors = [], checks = [], requests = [], facts = {};
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
const blocksOf = m => Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
const userTexts = request => request.messages.filter(m => m.role === 'user').flatMap(m => blocksOf(m).filter(b => b.type === 'text').map(b => b.text));
const text = value => ({ type: 'text', text: value });
const control = (id, input) => ({ type: 'tool_use', id, name: TOOL, input });
const invoke = (name, operationId) => ({ action: 'invoke', method: 'spaceCreate', arguments: [name], operation_id: operationId });
// The next response follows from the session's own conversation: the person's task, a tool result, or NAW's message.
function plan(request) {
  const last = blocksOf(request.messages.findLast(m => m.role === 'user'));
  const results = last.filter(b => b.type === 'tool_result').map(b => b.tool_use_id), said = last.filter(b => b.type === 'text').map(b => b.text).join('\n');
  if (results.includes('toolu_alpha')) return ['beta', [text('ASKING_BETA\n'), control('toolu_beta', invoke('Beta', OP_B))]];
  if (results.includes('toolu_beta')) return ['asked', [text('ASKED_BOTH: waiting for the person.')]];
  if (results.includes('toolu_receipt_b')) return ['continued', [text('CONTINUED_AFTER_ANSWER')]];
  // The agent goes on by itself: it reads both receipts, as NAW's message says.
  if (said.includes(HEADING)) return ['notice', [text('READING_RECEIPTS\n'), control('toolu_receipt_a', { action: 'receipt', operation_id: OP_A }), control('toolu_receipt_b', { action: 'receipt', operation_id: OP_B })]];
  if (said.includes('ASK_TASK')) {
    if (!(request.tools || []).some(t => t.name === TOOL)) errors.push('Task request without the workspace control tool');
    return ['alpha', [text('ASKING_ALPHA\n'), control('toolu_alpha', invoke('Alpha', OP_A))]];
  }
  return ['other', [text('UNEXPECTED_REQUEST')]];
}
const fixture = loopback.create({ directory: base, provider: 'claude', respond: async (req, res, body) => {
  if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: 100, data: [] })); return;
  }
  const number = ++calls;
  if (number > BUDGET) { budgetError = Error('Native task response budget exceeded'); res.writeHead(429); res.end(); return; }
  const request = JSON.parse(body), file = path.join(base, `request-${number}.json`);
  fs.writeFileSync(file, body);
  if (!/haiku/.test(request.model)) errors.push(`Request ${number} asked for ${request.model}`);
  const [step, content] = plan(request);
  requests.push({ number, step, at: Date.now(), file });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  event(res, 'message_start', { message: { id: `msg_local_${number}`, type: 'message', role: 'assistant', model: request.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  content.forEach((c, index) => block(res, index, c));
  event(res, 'message_delta', { delta: { stop_reason: content.some(c => c.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
  event(res, 'message_stop', {}); res.end();
} });
const seen = step => requests.find(r => r.step === step);
const read = step => JSON.parse(fs.readFileSync(seen(step).file, 'utf8'));
const snapshot = () => client.call('initial');
const session = (state, id) => state.sessions.find(s => s.id === id);
const select = async id => { await page.locator(`button.session-link[data-session-id="${id}"]`).click(); await page.locator('#chat-tab').click(); };
const shot = async name => { if (evidence) await page.screenshot({ path: path.join(evidence, name) }); };
// The tool result the session's next request carried, parsed as the bridge returned it.
function toolValue(step, id) {
  const content = blocksOf(read(step).messages.findLast(m => m.role === 'user')).find(b => b.tool_use_id === id)?.content;
  const raw = typeof content === 'string' ? content : (content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  try { return JSON.parse(raw); } catch { return { unparsed: raw }; }
}
// Trust and the fixture key are settled in the isolated Claude home, keeping what Claude itself wrote there.
function settle(folders) {
  const file = path.join(config, '.claude.json');
  let saved = {}; try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first write */ }
  const projects = { ...(saved.projects || {}) };
  for (const folder of folders) projects[folder] = { ...(projects[folder] || {}), hasTrustDialogAccepted: true };
  fs.writeFileSync(file, JSON.stringify({ ...saved, hasCompletedOnboarding: true, theme: 'dark', customApiKeyResponses: { approved: [loopback.FIXTURE_KEY.slice(-20)], rejected: [] }, projects }), { mode: 0o600 });
}
async function create(name, key) {
  const previous = new Set((await snapshot()).sessions.map(s => s.id));
  const created = async () => (await snapshot()).sessions.find(s => !previous.has(s.id));
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check();
  await page.locator('#session-name').fill(name);
  const chosen = await page.locator('#chosen-folder').innerText(), owned = [path.resolve(base), fs.realpathSync(base)].find(dir => chosen.startsWith(dir + path.sep));
  assert.ok(owned, 'Only owned fixture folders');
  settle([chosen, fs.realpathSync(base) + chosen.slice(owned.length)]);
  await createIn(page, 'terminal');
  await until(async () => Boolean(await created()), `${name} listed`);
  const id = (await created()).id, terminal = page.locator(`[data-terminal-id="${id}"]`);
  const shown = async () => (await terminal.innerText().catch(() => '')).replace(/ /g, ' ');
  const focus = () => terminal.locator('.xterm-helper-textarea').focus();
  // Only this session's own terminal is read and typed into.
  await until(async () => /Yes, I trust this folder|Do you want to use this API key/.test(await shown()) || (await created())?.chatAvailable, `${name} native startup`, 60000);
  if ((await shown()).includes('Yes, I trust this folder')) {
    // 2.1.322 redraws this question about 150 ms after showing it and resets the choice (test-native-addressed.cjs).
    await sleep(1500); await focus();
    for (let i = 0; i < 5 && !/[❯›>]\s*(?:\d+[.)]\s*)?Yes, I trust this folder/.test(await shown()); i++) { await page.keyboard.press('ArrowDown'); await sleep(300); }
    await page.keyboard.press('Enter');
  }
  await until(async () => (await shown()).includes('Do you want to use this API key') || (await created())?.chatAvailable, `${name} key question`, 60000);
  if ((await shown()).includes('Do you want to use this API key')) { await focus(); await page.keyboard.press('ArrowUp'); await sleep(300); await page.keyboard.press('Enter'); }
  await until(async () => { const s = await created(); return s?.state === 'idle' && s.chatAvailable; }, `${name} ready`, 60000);
  ids[key] = id;
}
// The card the person sees under the operation's row in the asking session's chat: exactly that row, exactly that button.
async function answerCard(operationId, which) {
  const row = page.locator(`#messages [data-message-id="background:${ids.native}:${operationId}"]`);
  await until(async () => await row.locator('.background-controls button').count() === 2, `card for ${operationId} shows two buttons`);
  // background-control's cards: [cancel, confirm], cancelId 0 (main.cjs confirmation).
  const labels = await row.locator('.background-controls button').allInnerTexts();
  assert.equal(new Set(labels).size, 2, 'Two different buttons');
  const button = row.locator('.background-controls').getByRole('button', { name: labels[which === 'confirm' ? 1 : 0], exact: true });
  assert.equal(await button.count(), 1, 'Exactly one target');
  await button.click();
  return labels;
}
async function cleanup() {
  if (application) await application.close().catch(() => {});
  if (client) { try { for (const s of (await snapshot()).sessions) await client.call('stop', s.id); await client.call('shutdown'); } finally { client.close(); } }
  await fixture.stop();
}
(async () => {
  await fixture.start(); await fixture.preflight();
  const shim = path.join(base, 'claude-local');
  // The native permission for the workspace control tool, as a person who allowed it once would have it.
  fixture.wrapper(binary, { file: shim, env: { CLAUDE_CONFIG_DIR: config }, args: ['--model', 'haiku', '--allowedTools', TOOL] });
  settle([fs.realpathSync(cwd)]);
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify({ claude: shim }), { mode: 0o600 });
  application = await _electron.launch({ executablePath: require('electron'), args: [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await application.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor(); client = await connectService(profile, 'native-answer-notice-test');
  await create(ASKER, 'asker');
  ids.native = session(await snapshot(), ids.asker).nativeId;
  assert.equal((await snapshot()).wakePolicy?.enabled, true, 'Automatic messages are on by default');
  checks.push('One 2.1.322 session, automatic messages on (the default)');

  // The person's task; the agent asks for two spaces, each a card for the person, and ends its turn.
  await select(ids.asker); await page.locator('#message-input').fill(TASK); await page.locator('#send-button').click();
  const taskAt = Date.now();
  await until(() => seen('asked'), 'The agent asks twice and ends its turn', 60000);
  await until(async () => session(await snapshot(), ids.asker).state === 'idle', 'Asker idle after asking');
  facts.asked = { alpha: toolValue('beta', 'toolu_alpha'), beta: toolValue('asked', 'toolu_beta') };
  assert.equal(facts.asked.alpha.state, 'confirmation-required'); assert.equal(facts.asked.beta.state, 'confirmation-required');
  checks.push('The agent\'s two workspace_control invokes (spaceCreate Alpha, Beta) returned confirmation-required; its turn ended');
  await shot('answer-notice-1-cards.png');

  // The person answers: Confirm on Alpha, Cancel on Beta, a moment apart. Nothing is typed into the session.
  const labels = await answerCard(OP_A, 'confirm');
  await sleep(1500);
  await answerCard(OP_B, 'cancel');
  const answeredAt = Date.now();
  facts.buttons = labels;
  await until(async () => (await page.evaluate(() => workspace.initial())).rooms?.some(r => r.name === 'Alpha'), 'Alpha is made on Confirm');
  checks.push(`The person clicked 「${labels[1]}」 on the Alpha card and 「${labels[0]}」 on the Beta card in the agent's chat`);
  await shot('answer-notice-2-answered.png');

  // NAW tells the agent by itself, in one message; the agent reads both receipts and goes on.
  await until(() => seen('notice'), 'The agent is told', 90000);
  facts.secondsAfterLastClick = Math.round((seen('notice').at - answeredAt) / 100) / 10;
  facts.secondsAfterTask = Math.round((seen('notice').at - taskAt) / 100) / 10;
  await until(() => seen('continued'), 'The agent reads both receipts and ends its turn', 60000);
  await until(async () => session(await snapshot(), ids.asker).state === 'idle', 'Asker idle after going on');
  const told = userTexts(read('notice')).filter(t => t.includes(HEADING));
  facts.noticeAsRead = told;
  assert.equal(told.length, 1, 'One message for both answers');
  assert.ok(told[0].includes(`- ${OP_A}（spaceCreate）：人点了确认，回执状态 complete`), 'Alpha: confirmed, carried out');
  assert.ok(told[0].includes(`- ${OP_B}（spaceCreate）：人点了取消，回执状态 cancelled`), 'Beta: cancelled');
  assert.match(told[0], /workspace_control 的 receipt 读回执/u); assert.match(told[0], /不替你重发或续做/u);
  facts.receipts = { alpha: toolValue('continued', 'toolu_receipt_a'), beta: toolValue('continued', 'toolu_receipt_b') };
  assert.equal(facts.receipts.alpha.receipt?.state, 'complete'); assert.equal(facts.receipts.beta.receipt?.state, 'cancelled');
  checks.push(`Told once, ${facts.secondsAfterLastClick} s after the last click (${facts.secondsAfterTask} s after the task): one message with both operation ids, the answers and states; the agent read both receipts itself and ended its turn`);

  // Told once: nothing repeats while the agent sits idle.
  await sleep(25000);
  const done = await snapshot(), asker = session(done, ids.asker);
  const rows = asker.messages.filter(m => typeof m.text === 'string' && m.text.includes(HEADING));
  facts.noticeRows = rows.map(m => ({ role: m.role, origin: m.origin, name: m.name, status: m.status }));
  assert.equal(rows.length, 1, 'One NAW message in the session');
  assert.equal(requests.filter(r => r.step === 'notice').length, 1, 'Read once');
  assert.deepEqual(requests.map(r => r.step), ['alpha', 'beta', 'asked', 'notice', 'continued'], 'No other request');
  const rooms = (await page.evaluate(() => workspace.initial())).rooms || [];
  assert.equal(rooms.filter(r => r.name === 'Alpha').length, 1); assert.equal(rooms.filter(r => r.name === 'Beta').length, 0);
  checks.push('25 s later: still one NAW message, five local responses in all; Alpha made once, Beta not made');
  await select(ids.asker); await until(async () => (await page.locator('#messages').innerText()).includes('CONTINUED_AFTER_ANSWER'), 'Chat shows the agent going on');
  await shot('answer-notice-3-continued.png');
  assert.deepEqual(errors, []); fixture.assertClean();
  fs.writeFileSync(path.join(base, 'completed.json'), JSON.stringify(done, null, 2));
  const result = { checks, facts, launcherVersion, nativeVersion, requests: requests.map(({ number, step, at }) => ({ number, step, at })), fixture: fixture.summary(), localResponses: calls, paidModelCalls: 0, errors, base, evidence: evidence || null };
  if (evidence) fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result, null, 1));
})().catch(async error => {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(base, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  console.error(error.stack, '\nRequests:', JSON.stringify(requests.map(({ number, step }) => [number, step])), '\nFacts:', JSON.stringify(facts), '\nEvidence:', base); process.exitCode = 1;
}).finally(testScratch.cleanup(async () => {
  try { await cleanup(); } finally {
    try { if (JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token === token) { fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); } } catch (error) { console.error('Slot release', error.message); process.exitCode = 1; }
  }
}));
