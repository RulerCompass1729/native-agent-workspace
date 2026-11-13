const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// Real Electron + real Claude CLI 2.1.322 or 2.1.323 + the real bridge, two sessions; canned responses on loopback (B11 fixture).
// Question (wake proposal, item 3, board 11-12 16:44: 「③只做读到真人的话后重新授权」; 23:44:19: 「真人插话之后、他的话还没读到
// 之前，这一回合仍然发不出」): when the person types into a working sender's turn through NAW, is a message the turn asks to
// send before its next model request refused, saying it can send once it has read them; once that request carries the
// person's words (native's read receipt), is the next one registered and delivered at the turn's end, while the one
// registered before the person spoke is withdrawn? The unit tests cover the other cases (a later person action, pausing
// everything, the butler); this run shows that native's read receipt names the same turn NAW holds for the sender.
// Bounded: 2 native sessions, at most 8 local responses. Takes the shared GUI slot itself (exit 75 when it is busy).
// No paid inference or daily app.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { _electron } = testScratch.playwright(require('playwright'));
const loopback = require('./fixtures/loopback-model.cjs');
const root = path.resolve(__dirname, '..');
const { connectService } = require(path.join(root, 'app/service-client.cjs'));
const { executable } = require(path.join(root, 'app/platform.cjs'));
const evidence = process.env.NAW_EVIDENCE_DIR;
const located = executable('claude'), binary = located && fs.realpathSync(located); if (!binary) throw Error('Real Claude CLI required');
const nativeVersion = testScratch.childProcess.execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(), launcherVersion = nativeVersion;
// Mid-turn delivery and its read receipt are qualified on exact 2.1.322 and 2.1.323 (test-native-midturn.cjs).
assert.match(nativeVersion, /^2\.1\.32[23](?=\s|$)/, 'Mid-turn delivery is qualified on exact 2.1.322 and 2.1.323 only');
const common = testScratch.childProcess.execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('GUI slot occupied; no GUI launched.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Claude · NAW 开发 · 续', task: 'a turn sends again after reading the person', token, pid: process.pid, at: new Date().toISOString() }));
const base = testScratch.directory(path.join(os.tmpdir(), 'naw-native-wake-reauth-'));
const profile = path.join(base, 'profile'), cwd = path.join(base, 'work'), config = path.join(base, 'claude');
for (const dir of [profile, cwd, config]) fs.mkdirSync(dir, { mode: 0o700 });
const SENDER = 'Sender', RECEIVER = 'Receiver', BUDGET = 8, TOOL_SECONDS = 12;
const TASK = 'SENDER_TASK_1: tell Receiver about the plan.';
const BEFORE = 'Automatic note, before the person spoke: plan A.', UNREAD = 'Automatic note, after the person spoke but before reading them: plan A again.';
const WORDS = 'PERSON_WORDS: use plan B instead, and tell Receiver.', AFTER = 'Automatic note, after reading the person: plan B.';
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
const message = (id, body) => ({ type: 'tool_use', id, name: 'mcp__native_workspace__workspace_message', input: { recipient_id: ids.receiver, message: body } });
// Each session's next response follows from its own conversation: the person's task, the last tool results.
function plan(request) {
  const all = userTexts(request).join('\n'), last = blocksOf(request.messages.findLast(m => m.role === 'user'));
  const results = last.filter(b => b.type === 'tool_result').map(b => b.tool_use_id);
  if (all.includes('SENDER_TASK')) {
    if (!results.length) return ['s1', [{ type: 'text', text: 'SENDER_FIRST: telling Receiver plan A.\n' }, message('toolu_s1', BEFORE)]];
    // A long local step, the person speaks during it; then, in the same response, a message decided before reading them.
    if (results.includes('toolu_s1')) return ['s2', [{ type: 'text', text: 'SENDER_SECOND: a long step, then plan A again.\n' },
      { type: 'tool_use', id: 'toolu_s2_long', name: 'Bash', input: { command: `sleep ${TOOL_SECONDS}`, description: 'A long local step' } }, message('toolu_s2_unread', UNREAD)]];
    if (results.includes('toolu_s2_long') || results.includes('toolu_s2_unread')) return ['s3', [{ type: 'text', text: 'SENDER_THIRD: read the person; telling Receiver plan B.\n' }, message('toolu_s3', AFTER)]];
    if (results.includes('toolu_s3')) return ['s4', [{ type: 'text', text: 'SENDER_DONE' }]];
    return ['s-other', [{ type: 'text', text: 'SENDER_UNEXPECTED' }]];
  }
  if (all.includes(AFTER)) return ['receiver', [{ type: 'text', text: 'RECEIVER_READ' }]];
  if (all.includes(BEFORE) || all.includes(UNREAD)) return ['receiver-wrong', [{ type: 'text', text: 'RECEIVER_WRONG' }]];
  return ['other', [{ type: 'text', text: 'UNEXPECTED' }]];
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
  fixture.wrapper(binary, { file: shim, env: { CLAUDE_CONFIG_DIR: config }, args: ['--allowedTools', 'Bash(sleep:*)', '--model', 'haiku'] });
  settle([fs.realpathSync(cwd)]);
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify({ claude: shim }), { mode: 0o600 });
  application = await _electron.launch({ executablePath: require('electron'), args: [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await application.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor(); client = await connectService(profile, 'native-wake-reauth-test');
  await create(RECEIVER, 'receiver'); await create(SENDER, 'sender');
  assert.equal((await snapshot()).wakePolicy?.enabled, true, 'Automatic messages are on by default');
  checks.push(`Two ${nativeVersion.split(' ')[0]} sessions, none in a space, each with the workspace tool`);

  // The person gives Sender its task; its first response registers a message to Receiver.
  await select(ids.sender); await page.locator('#message-input').fill(TASK); await page.locator('#send-button').click();
  await until(() => seen('s2'), 'Sender registers plan A and starts its long step');
  assert.match(toolResult('s2', 'toolu_s1'), /staged/, 'Plan A: registered before the person spoke');
  // During the long step the person types into the running turn, from the composer as the GUI offers it.
  await until(async () => { const s = session(await snapshot(), ids.sender); return s.state === 'working' && s.midturnAvailable === true; }, 'Working, with mid-turn delivery offered');
  await until(async () => (await page.locator('#send-button').innerText()) === '工具结束时送进本轮 ↑', 'The waiting action says it delivers at the next tool step');
  await page.locator('#message-input').fill(WORDS); await page.locator('#send-button').click();
  await until(async () => session(await snapshot(), ids.sender).pendingQueue, 'Held for the next tool boundary');
  const tag = session(await snapshot(), ids.sender).pendingQueue;
  const words = async () => session(await snapshot(), ids.sender).messages.find(m => m.id === tag);
  checks.push('The person typed into the running turn during its long step; NAW holds the words for the next tool step');

  // The same response's next call ran before any request carried the person's words: refused, with the reason the agent reads.
  await until(() => seen('s3'), 'The turn makes its next request', (TOOL_SECONDS + 30) * 1000);
  const unread = toolResult('s3', 'toolu_s2_unread');
  facts.unreadResult = unread;
  assert.doesNotMatch(unread, /staged/, 'Plan A again: not registered');
  assert.match(unread, /这一回合还没读到；读到之后可以再发|has not read it yet; once it has, it can send again/, 'Plan A again: says the turn can send once it has read the person');
  const third = read('s3');
  assert.equal(userTexts(third).filter(t => t.includes(WORDS)).length, 1, 'The next request carries the person\'s words once');
  checks.push('Before the turn read the person\'s words, its message was refused with 「读到之后可以再发」; the next request carried the words');

  // Native's read receipt reopens the turn: the next message is registered and goes once at the turn's end.
  await until(() => seen('s4'), 'Sender reads its last result and ends its turn');
  const after = toolResult('s4', 'toolu_s3');
  facts.afterResult = after;
  assert.match(after, /staged/, 'Plan B: registered after the turn read the person');
  await until(async () => (await words())?.nativeRead === true, 'The read receipt reached the record');
  await until(() => seen('receiver'), 'Receiver reads plan B', 30000);
  await until(async () => { const s = await snapshot(); return [ids.sender, ids.receiver].every(id => session(s, id).state === 'idle'); }, 'Both idle again');
  const done = await snapshot(), sender = session(done, ids.sender), receiver = session(done, ids.receiver);
  const intents = sender.messages.filter(m => m.origin === 'agent-wake-intent').map(m => ({ body: m.wake.body, status: m.wake.status, epoch: m.wake.epoch ?? 0, cancellation: m.wake.cancellation?.code ?? null }));
  facts.intents = intents;
  assert.deepEqual(intents.map(i => [i.body, i.status, i.epoch]), [[BEFORE, 'cancelled', 0], [AFTER, 'submitted', 1]], 'Plan A withdrawn, plan B taken; plan A again never registered');
  assert.equal(intents[0].cancellation, 'source-identity-changed');
  const got = receiver.messages.filter(m => m.origin === 'agent-wake');
  assert.equal(got.length, 1, 'Receiver: one message'); assert.equal(got[0].name, `来自 ${SENDER}`); assert.equal(got[0].status, 'submitted');
  assert.equal(userTexts(read('receiver')).filter(t => t.includes(AFTER)).length, 1, 'Receiver read plan B once');
  assert.ok(!seen('receiver-wrong') && !JSON.stringify(receiver.messages).includes(BEFORE) && !JSON.stringify(receiver.messages).includes(UNREAD), 'Plan A reached nobody');
  assert.deepEqual(requests.map(r => r.step).sort(), ['receiver', 's1', 's2', 's3', 's4'].sort(), 'No other request');
  facts.senderRows = sender.messages.filter(m => m.origin === 'agent-wake-intent').map(m => m.text);
  checks.push('Once read: plan B registered and delivered once to Receiver at the turn\'s end; plan A, registered before the person spoke, withdrawn; no extra request');
  await select(ids.sender); await until(async () => (await page.locator('#messages').innerText()).includes('SENDER_DONE'), 'Sender chat shows the turn');
  await shot('wake-reauth-sender.png');
  await select(ids.receiver); await until(async () => (await page.locator('#messages').innerText()).includes('RECEIVER_READ'), 'Receiver chat shows its reply');
  await shot('wake-reauth-receiver.png');
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
