const testScratch = require('./fixtures/test-scratch.cjs');
const { joinSpace } = require('./fixtures/space-membership.cjs');
const { revealDefaultSpace } = require('./fixtures/default-space.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
const { chooseRecipient: inlineRecipient, fillRoomMessage } = require('./room-input.cjs');
// Real Electron + real Claude CLI 2.1.322 or 2.1.323 + the real bridge, two sessions; canned responses on loopback (B11 fixture).
// Question (wake proposal, item 1, 2026-11-12): an automatic message (one session's workspace_message tool) to a
// session in the middle of a turn of several tool calls: does it enter that turn through the native queue, read once
// at the next tool boundary, shown on the recipient as 来自 <sender> and submitted, without counting as the person's
// action (no takeover, no control change, the automatic-message boundary stands), while the space the turn answers
// stops showing it (review B1)? And is one to a recipient waiting for approval refused with that reason?
// Bounded: 2 native sessions, at most 12 local responses. Takes the shared GUI slot itself (exit 75 when it is busy).
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
// Mid-turn delivery is qualified on exact 2.1.322 and 2.1.323 (claude-bridge/hooks/register.js). When the vendor's
// launcher points at another version, use the newest of these installed beside it, as NAW itself does (claude-pin.cjs).
const MIDTURN = ['2.1.323', '2.1.322'];
let binary = fs.realpathSync(located);
const launcherVersion = version(binary);
if (path.basename(path.dirname(binary)) === 'versions' && !MIDTURN.includes(path.basename(binary))) {
  const beside = MIDTURN.find(v => fs.existsSync(path.join(path.dirname(binary), v))); if (beside) binary = path.join(path.dirname(binary), beside);
}
const nativeVersion = version(binary);
assert.match(nativeVersion, /^2\.1\.32[23](?=\s|$)/, 'Mid-turn delivery is qualified on exact 2.1.322 and 2.1.323 only');
const common = testScratch.childProcess.execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('GUI slot occupied; no GUI launched.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Claude · NAW 开发 · 续', task: 'automatic message mid-turn journey', token, pid: process.pid, at: new Date().toISOString() }));
const base = testScratch.directory(path.join(os.tmpdir(), 'naw-native-wake-midturn-'));
const profile = path.join(base, 'profile'), cwd = path.join(base, 'work'), config = path.join(base, 'claude');
for (const dir of [profile, cwd, config]) fs.mkdirSync(dir, { mode: 0o700 });
// Claude itself refuses a standalone `sleep 25` as a tool ("Blocked: standalone sleep 25", 2.1.322); 14 s runs, as in
// test-native-midturn.cjs, and is far longer than the sender's whole turn (about 0.3 s measured here).
const SENDER = 'Sender', RECEIVER = 'Receiver', LONG_SECONDS = 14, BUDGET = 12;
const TASK_R1 = 'RECEIVER_TASK_1: run the two local steps.', TASK_R2 = 'RECEIVER_TASK_2: run the command that asks first.';
const TASK_S1 = 'SENDER_TASK_1: tell the other session the build finished.', TASK_S2 = 'SENDER_TASK_2: tell the other session once more.';
const WAKE1 = 'Automatic note one: the build finished.', WAKE2 = 'Automatic note two: please check the file.';
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
const bash = (id, command) => ({ type: 'tool_use', id, name: 'Bash', input: { command, description: 'A local step' } });
const message = (id, body) => ({ type: 'tool_use', id, name: 'mcp__native_workspace__workspace_message', input: { recipient_id: ids.receiver, message: body } });
// Each session's next response follows from its own conversation: which task the person gave and which tool result came back.
function plan(request) {
  const all = userTexts(request).join('\n'), last = blocksOf(request.messages.findLast(m => m.role === 'user'));
  const result = last.find(b => b.type === 'tool_result')?.tool_use_id || null, text = last.filter(b => b.type === 'text').map(b => b.text).join('\n');
  if (all.includes('SENDER_TASK')) {
    if (!(request.tools || []).some(t => t.name === 'mcp__native_workspace__workspace_message' && t.input_schema?.properties?.recipient_id)) errors.push('Sender request without the workspace tool');
    if (!result && text.includes('SENDER_TASK_1')) return ['s1', [{ type: 'text', text: 'SENDER_FIRST: telling the other session.\n' }, message('toolu_s1', WAKE1)]];
    if (result === 'toolu_s1') return ['s2', [{ type: 'text', text: 'SENDER_DONE_1' }]];
    if (!result && text.includes('SENDER_TASK_2')) return ['s3', [{ type: 'text', text: 'SENDER_AGAIN: telling the other session.\n' }, message('toolu_s3', WAKE2)]];
    if (result === 'toolu_s3') return ['s4', [{ type: 'text', text: 'SENDER_DONE_2' }]];
    return ['s-other', [{ type: 'text', text: 'SENDER_UNEXPECTED' }]];
  }
  if (all.includes('RECEIVER_TASK')) {
    if (!result && text.includes('RECEIVER_TASK_1')) return ['r1', [{ type: 'text', text: 'RECEIVER_FIRST: a short step.\n' }, bash('toolu_r1', 'sleep 1')]];
    if (result === 'toolu_r1') return ['r2', [{ type: 'text', text: 'RECEIVER_SECOND: a long step.\n' }, bash('toolu_r2', `sleep ${LONG_SECONDS}`)]];
    if (result === 'toolu_r2') return ['r3', [{ type: 'text', text: 'RECEIVER_AFTER_WAKE: read the note.' }]];
    // A command that asks first: `touch` in the working folder runs without asking on 2.1.322 (measured). Harmless if run.
    if (!result && text.includes('RECEIVER_TASK_2')) return ['r4', [{ type: 'text', text: 'RECEIVER_ASK: one command that asks first.\n' }, bash('toolu_r4', 'python3 -c "print(1)"')]];
    if (result === 'toolu_r4') return ['r5', [{ type: 'text', text: 'RECEIVER_AFTER_APPROVAL' }]];
    return ['r-other', [{ type: 'text', text: 'RECEIVER_UNEXPECTED' }]];
  }
  return ['other', [{ type: 'text', text: 'none' }]];
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
const boundary = () => fs.readFileSync(path.join(profile, 'agent-wake-boundary'), 'utf8');
const control = s => Object.fromEntries(['owner', 'controlRevision', 'wakeHumanRevision', 'nativeId', 'pid'].map(k => [k, s[k] ?? null]));
const select = async id => { await page.locator(`button.session-link[data-session-id="${id}"]`).click(); await page.locator('#chat-tab').click(); };
const sendPrivately = async (id, text) => { await select(id); await page.locator('#message-input').fill(text); await page.locator('#send-button').click(); };
const shot = async name => { if (evidence) await page.screenshot({ path: path.join(evidence, name) }); };
// Trust and the fixture key are settled in the isolated Claude home, keeping what Claude itself wrote there.
function settle(folders) {
  const file = path.join(config, '.claude.json');
  let saved = {}; try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first write */ }
  const projects = { ...(saved.projects || {}) };
  for (const folder of folders) projects[folder] = { ...(projects[folder] || {}), hasTrustDialogAccepted: true };
  fs.writeFileSync(file, JSON.stringify({ ...saved, hasCompletedOnboarding: true, theme: 'dark', customApiKeyResponses: { approved: [loopback.FIXTURE_KEY.slice(-20)], rejected: [] }, projects }), { mode: 0o600 });
}
async function create(name) {
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
  const shown = async () => (await terminal.innerText().catch(() => '')).replace(/ /g, ' ');
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
  ids[name === SENDER ? 'sender' : 'receiver'] = id;
  await joinSpace(page);
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
  await page.locator('#new-session').waitFor(); client = await connectService(profile, 'native-wake-midturn-test');
  await revealDefaultSpace(page);
  await create(RECEIVER); await create(SENDER);
  assert.equal((await snapshot()).wakePolicy?.enabled, true, 'Automatic messages are on by default');
  checks.push(`Two ${nativeVersion.split(' ')[0]} sessions in the space, each with the workspace tool; automatic messages on`);

  // Case 1. The person gives Receiver a task from the space, so its turn answers there: two tools, the second long.
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await inlineRecipient(page, ids.receiver); await fillRoomMessage(page, TASK_R1); await page.locator('#forward-button').click();
  await until(() => seen('r2'), 'Receiver starts its second, long tool');
  await until(async () => { const r = session(await snapshot(), ids.receiver); return r.state === 'working' && r.midturnAvailable === true && !r.pendingQueue; }, 'Receiver working, mid-turn delivery open');
  await until(async () => (await snapshot()).room.messages.some(m => m.text?.includes('RECEIVER_FIRST')), 'Receiver\'s turn answers the space');
  assert.ok(!(await page.locator('#room-messages').innerText()).includes('后续内容留在原会话'), 'Sharing still open before the message');
  const before = control(session(await snapshot(), ids.receiver)), boundaryBefore = boundary();
  // While Receiver works, the person asks Sender, privately, to tell it something.
  await sendPrivately(ids.sender, TASK_S1);
  await until(() => seen('s2'), 'Sender reads its tool result and ends its turn');
  const staged = JSON.stringify(blocksOf(read('s2').messages.findLast(m => m.role === 'user')).find(b => b.tool_use_id === 'toolu_s1')?.content ?? null);
  facts.senderToolResult1 = staged;
  assert.match(staged, /staged/, 'The sender agent is told its message is staged');
  await until(async () => Boolean(session(await snapshot(), ids.receiver).pendingQueue), 'Held in Receiver\'s native queue', 20000);
  const heldAt = Date.now(), held = await snapshot(), receiver = session(held, ids.receiver), tag = receiver.pendingQueue, row = receiver.messages.find(m => m.id === tag);
  assert.ok(seen('r2') && !seen('r3'), 'Still inside the long tool');
  assert.equal(row.origin, 'agent-wake'); assert.equal(row.name, `来自 ${SENDER}`); assert.equal(row.wakeSource?.senderId, ids.sender);
  assert.equal(row.inputMode, 'queue'); assert.equal(row.midturn, true); assert.equal(row.status, 'awaiting-native');
  const intent = session(held, ids.sender).messages.find(m => m.origin === 'agent-wake-intent' && m.wake?.body === WAKE1);
  assert.equal(intent.wake.status, 'consumed', 'Taken by the recipient, result not yet known');
  assert.deepEqual(control(receiver), before, 'Receiver\'s owner, control and human revisions unchanged: not the person\'s action');
  assert.equal(boundary(), boundaryBefore, 'The automatic-message boundary stands');
  checks.push('Held in Receiver\'s native queue as 来自 Sender (queue, mid-turn, awaiting-native) while its long tool runs; no control change');
  await page.locator('#room-nav').click();
  await until(async () => (await page.locator('#room-messages').innerText()).includes('后续内容留在原会话'), 'The space stops showing Receiver\'s turn (B1)');
  facts.heldRoom = await page.locator('#room-messages').innerText();
  await shot('wake-held-space.png');
  checks.push('The space Receiver\'s turn answered now says 后续内容留在原会话');

  // The long tool ends: the message enters that turn and its next request reads it once, after the tool's result.
  await until(() => seen('r3'), 'Receiver\'s same turn makes its next request', (LONG_SECONDS + 20) * 1000);
  const third = read('r3'), last = blocksOf(third.messages.findLast(m => m.role === 'user'));
  const resultAt = last.findIndex(b => b.type === 'tool_result' && b.tool_use_id === 'toolu_r2'), wakeAt = last.findIndex(b => b.type === 'text' && b.text.includes(WAKE1));
  assert.ok(resultAt >= 0 && wakeAt > resultAt, 'After the long tool\'s result, in the message the model reads next');
  assert.ok(!JSON.stringify(last[resultAt].content).includes('Blocked'), 'The long tool really ran');
  assert.equal(userTexts(third).filter(t => t.includes(WAKE1)).length, 1, 'Read once');
  facts.readByReceiver = last[wakeAt].text;
  assert.ok(last[wakeAt].text.includes(`[Workspace message from ${SENDER} · ${ids.sender} at `), 'Says who sent it');
  assert.ok(seen('r3').at - seen('r2').at >= (LONG_SECONDS - 3) * 1000, 'Read at the tool boundary, not before the tool ended');
  checks.push('Receiver\'s next request in the same turn carries the message once, right after the long tool\'s result');
  await until(async () => { const r = session(await snapshot(), ids.receiver); return r.state === 'idle' && !r.pendingQueue && r.messages.some(m => m.text?.includes('RECEIVER_AFTER_WAKE')); }, 'Receiver\'s turn completes');
  await until(async () => session(await snapshot(), ids.receiver).messages.find(m => m.id === tag)?.nativeRead === true, 'The read receipt reached the record');
  await until(async () => session(await snapshot(), ids.sender).messages.find(m => m.id === intent.id)?.wake?.status === 'submitted', 'Sender\'s record says it was taken');
  const done = await snapshot(), r1 = session(done, ids.receiver), delivered = r1.messages.find(m => m.id === tag), told = session(done, ids.sender).messages.find(m => m.id === intent.id);
  assert.equal(delivered.status, 'submitted'); assert.ok(delivered.deliveredInto, 'Delivered into the running turn');
  assert.ok(r1.messages.indexOf(delivered) < r1.messages.findIndex(m => m.text?.includes('RECEIVER_AFTER_WAKE')), 'Kept before the reply that read it');
  assert.ok(told.text.startsWith('发给原会话的自动消息：原生已接收。'), told.text);
  assert.deepEqual(requests.filter(r => r.step.startsWith('r')).map(r => r.step), ['r1', 'r2', 'r3'], 'No turn of its own');
  assert.deepEqual(control(r1), before, 'Still no control change after the turn');
  assert.equal(boundary(), boundaryBefore, 'The boundary still stands');
  const room = JSON.stringify(done.room.messages);
  assert.ok(room.includes('RECEIVER_FIRST') && !room.includes('RECEIVER_AFTER_WAKE'), 'The rest of Receiver\'s turn stays private');
  facts.sharingStopped = done.room.messages.filter(m => m.sharingStopped).map(m => m.sharingStopped);
  facts.mirrored = done.room.messages.filter(m => m.kind === 'agent-wake').map(m => m.name);
  facts.pauseNotices = [...done.room.messages, ...r1.messages].filter(m => /旧协作交接已撤销|真人接管/.test(m.text || '')).map(m => m.text);
  checks.push('Receiver row 来自 Sender submitted and read; Sender row 原生已接收; the space keeps only what came before');
  await shot('wake-delivered-space.png');
  await select(ids.receiver); await until(async () => (await page.locator('#messages').innerText()).includes('RECEIVER_AFTER_WAKE'), 'Receiver chat shows the reply');
  await shot('wake-delivered-receiver.png');
  await select(ids.sender); await until(async () => (await page.locator('#messages').innerText()).includes('原生已接收'), 'Sender chat shows 原生已接收');
  await shot('wake-delivered-sender.png');

  // Case 2. The person gives Receiver a private task whose tool waits for approval; Sender then messages it.
  await sendPrivately(ids.receiver, TASK_R2);
  await until(() => seen('r4'), 'Receiver asks for the command');
  await until(async () => session(await snapshot(), ids.receiver).state === 'approval', 'Receiver waits for approval');
  // Still waiting a moment later, with no further request: a prompt that stays open, not a passing state.
  await sleep(1500);
  assert.equal(session(await snapshot(), ids.receiver).state, 'approval', 'The approval stays open'); assert.ok(!seen('r5') && !seen('r-other'), 'Nothing ran');
  await shot('wake-receiver-approval.png');
  await sendPrivately(ids.sender, TASK_S2);
  await until(() => seen('s4'), 'Sender reads the refusal and ends its turn');
  const refusedResult = JSON.stringify(blocksOf(read('s4').messages.findLast(m => m.role === 'user')).find(b => b.tool_use_id === 'toolu_s3')?.content ?? null);
  facts.senderToolResult2 = refusedResult;
  assert.match(refusedResult, /not-sent/); assert.ok(refusedResult.includes('收件方在等批准或等原生输入。'), 'The sender agent reads the reason');
  await until(async () => session(await snapshot(), ids.sender).state === 'idle', 'Sender idle');
  const after = await snapshot(), refused = session(after, ids.sender).messages.find(m => m.origin === 'agent-wake-intent' && m.wake?.body === WAKE2), r2 = session(after, ids.receiver);
  assert.equal(refused.wake.status, 'not-sent'); assert.ok(refused.text.includes('收件方在等批准或等原生输入。'), refused.text);
  assert.ok(!r2.messages.some(m => m.origin === 'agent-wake' && m.text?.includes(WAKE2)) && !r2.pendingQueue && r2.state === 'approval', 'Nothing reached Receiver');
  facts.refusedRow = refused.text;
  await until(async () => (await page.locator('#messages').innerText()).includes('收件方在等批准'), 'Sender chat shows the reason');
  await shot('wake-refused-sender.png');
  checks.push('To a recipient waiting for approval: not sent, with 收件方在等批准或等原生输入。 to the sender agent and on its row');
  assert.ok(!requests.some(r => ['r-other', 's-other'].includes(r.step)), 'No unexpected session request');
  assert.deepEqual(errors, []); fixture.assertClean();
  fs.writeFileSync(path.join(base, 'completed.json'), JSON.stringify(after, null, 2));
  console.log(JSON.stringify({ checks, facts, launcherVersion, nativeVersion, requests: requests.map(({ number, step, at }) => ({ number, step, at })), heldAt, fixture: fixture.summary(), localResponses: calls, paidModelCalls: 0, errors, evidence: base }, null, 1));
})().catch(async error => {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(base, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  console.error(error.stack, '\nRequests:', JSON.stringify(requests.map(({ number, step }) => [number, step])), '\nFacts:', JSON.stringify(facts), '\nEvidence:', base); process.exitCode = 1;
}).finally(testScratch.cleanup(async () => {
  try { await cleanup(); } finally {
    try { if (JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token === token) { fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); } } catch (error) { console.error('Slot release', error.message); process.exitCode = 1; }
  }
}));
