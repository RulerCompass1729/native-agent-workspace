const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// Real Electron + real Claude CLI 2.1.322 + the real bridge, three sessions; canned responses on loopback (B11 fixture).
// Question (wake proposal, item 2, 2026-11-12: 「②只给指定大管家（每收件方 1 条、最多 4 个），其他 agent 不变」): once the
// person makes a session the butler through NAW, does one turn of it deliver one automatic message to each of two
// other sessions, and is a second to the same recipient in that turn refused with its reason, never delivered? The
// unit tests cover the other cases (a session that is not the butler, the fifth recipient, the role ending mid-turn);
// this run shows that the real app finds the person's designation where session-wake.cjs reads it.
// Bounded: 3 native sessions, at most 10 local responses. Takes the shared GUI slot itself (exit 75 when it is busy).
// No paid inference or daily app.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { _electron } = testScratch.playwright(require('playwright'));
const loopback = require('./fixtures/loopback-model.cjs');
const root = path.resolve(__dirname, '..');
const { connectService } = require(path.join(root, 'app/service-client.cjs'));
const { executable } = require(path.join(root, 'app/platform.cjs'));
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
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Claude · NAW 开发 · 续', task: 'butler messages several sessions in one turn', token, pid: process.pid, at: new Date().toISOString() }));
const base = testScratch.directory(path.join(os.tmpdir(), 'naw-native-wake-steward-'));
const profile = path.join(base, 'profile'), cwd = path.join(base, 'work'), config = path.join(base, 'claude');
for (const dir of [profile, cwd, config]) fs.mkdirSync(dir, { mode: 0o700 });
const BUTLER = 'Butler', FRONT = 'Front', DOCS = 'Docs', BUDGET = 10;
const TASK = 'BUTLER_TASK_1: hand the two pieces of work out.';
const NOTE_FRONT = 'Automatic note for Front: take the header change.', NOTE_DOCS = 'Automatic note for Docs: update the guide.';
const NOTE_AGAIN = 'Automatic note for Front, again: also the footer.';
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
  if (all.includes('BUTLER_TASK')) {
    if (!(request.tools || []).some(t => t.name === 'mcp__native_workspace__workspace_message')) errors.push('Butler request without the workspace tool');
    // Three calls in one turn, one after another: Front, Docs, then Front again.
    if (!result) return ['b1', [{ type: 'text', text: 'BUTLER_FIRST: telling Front.\n' }, message('toolu_b1', 'front', NOTE_FRONT)]];
    if (result === 'toolu_b1') return ['b2', [{ type: 'text', text: 'BUTLER_SECOND: telling Docs.\n' }, message('toolu_b2', 'docs', NOTE_DOCS)]];
    if (result === 'toolu_b2') return ['b3', [{ type: 'text', text: 'BUTLER_THIRD: Front once more.\n' }, message('toolu_b3', 'front', NOTE_AGAIN)]];
    if (result === 'toolu_b3') return ['b4', [{ type: 'text', text: 'BUTLER_DONE' }]];
    return ['b-other', [{ type: 'text', text: 'BUTLER_UNEXPECTED' }]];
  }
  if (all.includes(NOTE_FRONT)) return ['front', [{ type: 'text', text: 'FRONT_READ' }]];
  if (all.includes(NOTE_DOCS)) return ['docs', [{ type: 'text', text: 'DOCS_READ' }]];
  if (all.includes(NOTE_AGAIN)) return ['again', [{ type: 'text', text: 'AGAIN_READ' }]];
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
  await page.locator('#new-session').waitFor(); client = await connectService(profile, 'native-wake-steward-test');
  await create(FRONT, 'front'); await create(DOCS, 'docs'); await create(BUTLER, 'butler');
  assert.equal((await snapshot()).wakePolicy?.enabled, true, 'Automatic messages are on by default');
  assert.ok((await snapshot()).sessions.every(s => !(s.roomIds || []).length), 'No session is in a space');

  // The person makes Butler the butler, as the chooser's confirm does; NAW sends it the duty statement.
  await page.evaluate(id => workspace.steward(id), ids.butler);
  await until(async () => await page.locator('#steward-slot .session-row').count() === 1, 'Butler sits at the top');
  const nativeOf = async id => session(await snapshot(), id).nativeId;
  const designation = JSON.parse(fs.readFileSync(path.join(profile, 'steward.json'), 'utf8')).selected;
  assert.deepEqual(designation, { sessionId: ids.butler, nativeId: await nativeOf(ids.butler) }, 'The record session-wake.cjs reads, in the app\'s profile');
  await until(() => seen('duty'), 'Butler reads its duty statement');
  await until(async () => session(await snapshot(), ids.butler).state === 'idle', 'Butler idle after the statement');
  checks.push('Three 2.1.322 sessions, none in a space, each with the workspace tool; Butler designated through NAW and read its duty statement');
  const before = { front: control(session(await snapshot(), ids.front)), docs: control(session(await snapshot(), ids.docs)) };

  // In one turn the butler messages Front, then Docs, then Front again.
  await select(ids.butler); await page.locator('#message-input').fill(TASK); await page.locator('#send-button').click();
  await until(() => seen('b4'), 'Butler reads its three results and ends its turn');
  const results = { front: toolResult('b2', 'toolu_b1'), docs: toolResult('b3', 'toolu_b2'), again: toolResult('b4', 'toolu_b3') };
  facts.butlerToolResults = results;
  assert.match(results.front, /staged/, 'Front: staged'); assert.match(results.docs, /staged/, 'Docs: staged, a second recipient in the same turn');
  assert.doesNotMatch(results.again, /staged/, 'Front again: not staged');
  assert.match(results.again, /合成一条|put everything for it in one message/, 'Front again: the sender agent reads why');
  checks.push('In one butler turn: Front staged, Docs staged, Front again refused with its reason');

  // At the turn's end each of the two is delivered once, as its recipient's own next turn.
  await until(() => seen('front') && seen('docs'), 'Front and Docs each answer their message', 30000);
  await until(async () => { const s = await snapshot(); return ['front', 'docs'].every(k => session(s, ids[k]).state === 'idle'); }, 'Both idle again');
  const done = await snapshot(), butler = session(done, ids.butler);
  const intents = butler.messages.filter(m => m.origin === 'agent-wake-intent').map(m => [m.wake.recipientId, m.wake.body, m.wake.status]);
  facts.intents = intents;
  assert.deepEqual(intents.filter(([, , status]) => status === 'submitted').map(([who, body]) => [who, body]).sort(), [[ids.docs, NOTE_DOCS], [ids.front, NOTE_FRONT]].sort(), 'Both taken');
  assert.ok(!intents.some(([, body]) => body === NOTE_AGAIN), 'The refused one was never registered');
  for (const [key, note] of [['front', NOTE_FRONT], ['docs', NOTE_DOCS]]) {
    const r = session(done, ids[key]), row = r.messages.find(m => m.origin === 'agent-wake');
    assert.equal(row?.name, `来自 ${BUTLER}`); assert.equal(row.wakeSource?.senderId, ids.butler); assert.equal(row.status, 'submitted');
    assert.equal(userTexts(read(key)).filter(t => t.includes(note)).length, 1, `${key} read its message once`);
    assert.ok(userTexts(read(key)).some(t => t.includes(`[Workspace message from ${BUTLER} · ${ids.butler} at `)), `${key}: says who sent it`);
    assert.deepEqual(control(r), before[key], `${key}: no control change`);
    assert.equal(r.messages.filter(m => m.origin === 'agent-wake').length, 1, `${key}: one message`);
  }
  assert.ok(!seen('again') && !JSON.stringify(session(done, ids.front).messages).includes(NOTE_AGAIN), 'The refused one never reached Front');
  assert.deepEqual(requests.map(r => r.step).sort(), ['b1', 'b2', 'b3', 'b4', 'docs', 'duty', 'front'].sort(), 'No other request');
  facts.butlerRows = butler.messages.filter(m => m.origin === 'agent-wake-intent').map(m => m.text);
  checks.push('At the turn\'s end: Front and Docs each got one message 来自 Butler, read once as their own turn, no control change; the refused one reached nobody');
  await select(ids.butler); await until(async () => (await page.locator('#messages').innerText()).includes('BUTLER_DONE'), 'Butler chat shows the turn');
  await shot('steward-wake-butler.png');
  await select(ids.docs); await until(async () => (await page.locator('#messages').innerText()).includes('DOCS_READ'), 'Docs chat shows its reply');
  await shot('steward-wake-docs.png');
  await select(ids.front); await until(async () => (await page.locator('#messages').innerText()).includes('FRONT_READ'), 'Front chat shows its reply');
  await shot('steward-wake-front.png');
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
