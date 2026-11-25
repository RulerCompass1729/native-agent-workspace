const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// Real Electron + real Claude CLI 2.1.322 + the real bridge, three sessions; canned responses on loopback (B11 fixture).
// Question (option A, board 11-12 21:2x, the person 「按你推荐的来」: 「被拒的自动消息先存着、每分钟补送一条，限制本身不变
// （不放宽）」): when two agents report to the person's designated butler less than 60 seconds apart, is the second one
// kept by its sender's backend and delivered once the butler's limit allows, exactly once, as the butler's own turn,
// instead of being refused and lost? The unit tests cover the rest (three in a row, other recipients, the person acting
// on either session, pausing all handoffs, a reopened backend); this run shows the real app's timer and the real
// sender agent's tool result, with about when it goes, and 「大管家的记录」 counting it, in Chinese and English.
// Bounded: 3 native sessions, at most 10 local responses, about 70 seconds of waiting for the limit. Takes the shared
// GUI slot itself (exit 75 when it is busy). No paid inference or daily app.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { _electron } = testScratch.playwright(require('playwright'));
const loopback = require('./fixtures/loopback-model.cjs');
const root = path.resolve(__dirname, '..');
const { connectService } = require(path.join(root, 'app/service-client.cjs'));
const { executable } = require(path.join(root, 'app/platform.cjs'));
const locale = require(path.join(root, 'app/ui-locale.js')), say = (language, key, params) => locale.format(language, key, params);
const evidence = process.env.NAW_EVIDENCE_DIR;
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
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Claude · NAW 开发 · 续', task: 'a message the butler refuses for its 60-second limit is held, then sent', token, pid: process.pid, at: new Date().toISOString() }));
const base = testScratch.directory(path.join(os.tmpdir(), 'naw-native-wake-held-'));
const profile = path.join(base, 'profile'), cwd = path.join(base, 'work'), config = path.join(base, 'claude');
for (const dir of [profile, cwd, config]) fs.mkdirSync(dir, { mode: 0o700 });
const BUTLER = 'Butler', FRONT = 'Front', DOCS = 'Docs', BUDGET = 10;
const FRONT_TASK = 'FRONT_TASK_1: report to the butler.', DOCS_TASK = 'DOCS_TASK_1: report to the butler.';
const NOTE_FRONT = 'Automatic report from Front: the header is done.', NOTE_DOCS = 'Automatic report from Docs: the guide is done.';
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
const message = (id, recipient, body) => ({ type: 'tool_use', id, name: 'mcp__native_workspace__workspace_message', input: { recipient_id: ids[recipient], message: body } });
// Each session's next response follows from its own conversation: the person's task, the messages it read, the last tool result.
function plan(request) {
  const all = userTexts(request).join('\n'), last = blocksOf(request.messages.findLast(m => m.role === 'user'));
  const result = last.find(b => b.type === 'tool_result')?.tool_use_id || null;
  for (const [task, key, note] of [[FRONT_TASK, 'front', NOTE_FRONT], [DOCS_TASK, 'docs', NOTE_DOCS]]) if (all.includes(task)) {
    if (!(request.tools || []).some(t => t.name === 'mcp__native_workspace__workspace_message')) errors.push(`${key} request without the workspace tool`);
    if (!result) return [`${key}1`, [{ type: 'text', text: `${key.toUpperCase()}_REPORTING\n` }, message(`toolu_${key}`, 'butler', note)]];
    return [`${key}2`, [{ type: 'text', text: `${key.toUpperCase()}_DONE` }]];
  }
  // The butler's conversation holds the earlier report too: the later one decides.
  if (all.includes(NOTE_DOCS)) return ['butler-docs', [{ type: 'text', text: 'BUTLER_READ_DOCS' }]];
  if (all.includes(NOTE_FRONT)) return ['butler-front', [{ type: 'text', text: 'BUTLER_READ_FRONT' }]];
  // The duty statement NAW sends the session the person makes the butler.
  return ['duty', [{ type: 'text', text: 'BUTLER_DUTY_READ' }]];
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
const control = s => Object.fromEntries(['owner', 'controlRevision', 'wakeHumanRevision', 'nativeId', 'pid'].map(k => [k, s[k] ?? null]));
const select = async id => { await page.locator(`button.session-link[data-session-id="${id}"]`).click(); await page.locator('#chat-tab').click(); };
const shot = async name => { if (evidence) await page.screenshot({ path: path.join(evidence, name) }); };
const toolResult = (step, id) => JSON.stringify(blocksOf(read(step).messages.findLast(m => m.role === 'user')).find(b => b.tool_use_id === id)?.content ?? null);
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
  await until(async () => { const s = await created(); return s?.state === 'idle' && s.chatAvailable && s.addressedSendAvailable; }, `${name} ready with the workspace tool`, 60000);
  ids[key] = id;
}
async function cleanup() {
  if (application) await application.close().catch(() => {});
  if (client) { try { for (const s of (await snapshot()).sessions) await client.call('stop', s.id); await client.call('shutdown'); } finally { client.close(); } }
  await fixture.stop();
}
(async () => {
  await fixture.start(); await fixture.preflight();
  const shim = path.join(base, 'claude-local');
  fixture.wrapper(binary, { file: shim, env: { CLAUDE_CONFIG_DIR: config }, args: ['--model', 'haiku'] });
  settle([fs.realpathSync(cwd)]);
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify({ claude: shim }), { mode: 0o600 });
  application = await _electron.launch({ executablePath: require('electron'), args: [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await application.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor(); client = await connectService(profile, 'native-wake-held-test');
  await create(FRONT, 'front'); await create(DOCS, 'docs'); await create(BUTLER, 'butler');
  assert.equal((await snapshot()).wakePolicy?.enabled, true, 'Automatic messages are on by default');
  assert.ok((await snapshot()).sessions.every(s => !(s.roomIds || []).length), 'No session is in a space');

  // The person makes Butler the butler, as the chooser's confirm does; NAW sends it the duty statement.
  await page.evaluate(id => workspace.steward(id), ids.butler);
  await until(async () => await page.locator('#steward-slot .session-row').count() === 1, 'Butler sits at the top');
  const designation = JSON.parse(fs.readFileSync(path.join(profile, 'steward.json'), 'utf8')).selected;
  assert.deepEqual(designation, { sessionId: ids.butler, nativeId: session(await snapshot(), ids.butler).nativeId }, 'The record session-wake.cjs reads');
  await until(() => seen('duty'), 'Butler reads its duty statement');
  await until(async () => session(await snapshot(), ids.butler).state === 'idle', 'Butler idle after the statement');
  checks.push('Three 2.1.322 sessions, none in a space; Butler designated through NAW and read its duty statement');
  const before = control(session(await snapshot(), ids.butler));

  // Front reports first: delivered at its turn's end, as the butler's own turn.
  await select(ids.front); await page.locator('#message-input').fill(FRONT_TASK); await page.locator('#send-button').click();
  await until(() => seen('front2') && seen('butler-front'), 'Front reports, and the butler reads it');
  await until(async () => session(await snapshot(), ids.butler).state === 'idle', 'Butler idle after the first report');
  const firstAt = session(await snapshot(), ids.butler).wakeBudget?.lastAt ?? null;
  facts.frontResult = toolResult('front2', 'toolu_front');
  assert.match(facts.frontResult, /staged/);
  checks.push('Front\'s report: staged in its turn, delivered at the turn\'s end; the butler read it as its own turn');

  // Docs reports well within the butler's 60 seconds: its agent reads that the message is kept, not lost.
  await select(ids.docs); await page.locator('#message-input').fill(DOCS_TASK); await page.locator('#send-button').click();
  await until(() => seen('docs2'), 'Docs reports and ends its turn');
  facts.docsResult = toolResult('docs2', 'toolu_docs');
  assert.match(facts.docsResult, /staged/); assert.match(facts.docsResult, /held/); assert.match(facts.docsResult, /60 秒/); assert.match(facts.docsResult, /已排着，约 1 分钟后/);
  const heldRow = async () => session(await snapshot(), ids.docs).messages.find(m => m.origin === 'agent-wake-intent');
  await until(async () => (await heldRow())?.wake?.status === 'held', 'Docs\'s report is held by its backend');
  const held = (await heldRow()).wake;
  facts.held = { heldAt: held.heldAt, retryAt: held.retryAt, firstAt, text: (await heldRow()).text };
  assert.ok(Number.isSafeInteger(firstAt) && held.retryAt === firstAt + 60000, 'Offered again when the butler\'s limit opens');
  assert.ok(!seen('butler-docs'), 'Not delivered while held');
  await until(async () => (await page.locator('#messages').innerText()).includes('已存着，收件方能收时再试一次'), 'Docs chat shows it held');
  assert.ok(!(await page.locator('#messages').innerText()).includes('接收结果未记录'), 'Held is named, not shown as unknown');
  await shot('wake-held-docs-held.png');
  // 「大管家的记录」 says how many are held for it and how long the oldest has waited (the integrator, 11-12 21:2x:
  // 「大管家记录里看得到存量和最老等待」; 「中英截图先给我」): in both languages while Docs's report is held.
  const openRecord = async language => {
    await page.locator('#steward-slot .session-row').click({ button: 'right' });
    await page.getByRole('menuitem', { name: say(language, 'menu.stewardRecord'), exact: true }).click();
    await page.locator('#steward-record-dialog').waitFor({ state: 'visible' });
    return (await page.locator('#steward-record-dialog .steward-record-waiting').innerText()).trim();
  };
  const closeRecord = async () => { await page.keyboard.press('Escape'); await page.locator('#steward-record-dialog').waitFor({ state: 'hidden' }); };
  const language = async value => {
    await page.locator('#setup-button').click(); await page.locator('#setup-dialog').waitFor({ state: 'visible' });
    await page.locator('#ui-language').selectOption(value);
    await until(async () => await page.locator('#new-session').getAttribute('aria-label') === say(value, 'sidebar.newSession'), `The interface reads ${value}`);
    await page.keyboard.press('Escape'); await page.locator('#setup-dialog').waitFor({ state: 'hidden' });
  };
  facts.record = { zh: await openRecord('zh') };
  assert.equal(facts.record.zh, say('zh', 'stewardRecord.waitingNew', { count: 1 }), 'The record counts the held report');
  await shot('wake-held-record-zh.png'); await closeRecord();
  await language('en'); await select(ids.docs);
  await until(async () => (await page.locator('#messages').innerText()).includes(say('en', 'reading.wakeHeld')), 'Docs chat shows it held, in English');
  await shot('wake-held-docs-held-en.png');
  facts.record.en = await openRecord('en');
  assert.equal(facts.record.en, say('en', 'stewardRecord.waitingNew', { count: 1 }));
  await shot('wake-held-record-en.png'); await closeRecord();
  await language('zh');
  assert.ok(!seen('butler-docs'), 'Still held after both looks');
  checks.push('Docs\'s report within the minute: its agent read 「held」 and about when it goes at once; 「大管家的记录」 counted it in both languages; at the turn\'s end its backend kept it, to be offered when the butler\'s limit opens; nothing reached the butler meanwhile');

  // Once the limit allows, it is delivered, once, as the butler's own turn; nobody pressed anything.
  await until(() => seen('butler-docs'), 'The butler reads the held report after its limit', 90000);
  await until(async () => (await heldRow())?.wake?.status === 'submitted', 'Docs\'s report taken');
  await until(async () => session(await snapshot(), ids.butler).state === 'idle', 'Butler idle after the second report');
  const done = await snapshot(), butler = session(done, ids.butler);
  facts.secondAt = seen('butler-docs').at;
  assert.ok(facts.secondAt >= held.retryAt, 'Not before the limit');
  const received = butler.messages.filter(m => m.origin === 'agent-wake');
  facts.received = received.map(m => [m.name, m.status, m.wakeSource?.senderId]);
  assert.deepEqual(received.map(m => [m.wakeSource?.senderId, m.status]), [[ids.front, 'submitted'], [ids.docs, 'submitted']], 'One from each, in order');
  assert.equal(userTexts(read('butler-docs')).filter(t => t.includes(NOTE_DOCS)).length, 1, 'The butler read the held report once');
  assert.ok(userTexts(read('butler-docs')).some(t => t.includes(`[Workspace message from ${DOCS} · ${ids.docs} at `)), 'It says who sent it');
  assert.deepEqual(control(butler), before, 'No control change on the butler');
  assert.deepEqual(requests.map(r => r.step).sort(), ['butler-docs', 'butler-front', 'docs1', 'docs2', 'duty', 'front1', 'front2'].sort(), 'No other request');
  facts.docsRows = session(done, ids.docs).messages.filter(m => m.origin === 'agent-wake-intent').map(m => [m.wake.status, m.text]);
  checks.push('After the limit: delivered once, as the butler\'s own turn, saying it came from Docs; Docs\'s row reads 原生已接收; no control change, no other request');
  await select(ids.docs); await until(async () => (await page.locator('#messages').innerText()).includes('原生已接收'), 'Docs chat shows it taken');
  await shot('wake-held-docs-sent.png');
  await select(ids.butler); await until(async () => (await page.locator('#messages').innerText()).includes('BUTLER_READ_DOCS'), 'Butler chat shows both');
  await shot('wake-held-butler.png');
  assert.deepEqual(errors, []); fixture.assertClean();
  fs.writeFileSync(path.join(base, 'completed.json'), JSON.stringify(done, null, 2));
  console.log(JSON.stringify({ checks, facts, launcherVersion, nativeVersion, requests: requests.map(({ number, step, at }) => ({ number, step, at })), fixture: fixture.summary(), localResponses: calls, paidModelCalls: 0, errors, evidence: base }, null, 1));
})().catch(async error => {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(base, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  console.error(error.stack, '\nRequests:', JSON.stringify(requests.map(({ number, step }) => [number, step])), '\nFacts:', JSON.stringify(facts), '\nEvidence:', base); process.exitCode = 1;
}).finally(testScratch.cleanup(async () => {
  try { await cleanup(); } finally {
    try { if (JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token === token) { fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); } } catch (error) { console.error('Slot release', error.message); process.exitCode = 1; }
  }
}));
