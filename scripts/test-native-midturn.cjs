const testScratch = require('./fixtures/test-scratch.cjs');
const { joinSpace } = require('./fixtures/space-membership.cjs');
const { revealDefaultSpace } = require('./fixtures/default-space.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
const { chooseRecipient: inlineRecipient, fillRoomMessage } = require('./room-input.cjs');
// Real Electron + real Claude CLI 2.1.322 + the real bridge; canned responses on loopback (B11 fixture).
// Question: does a message queued while Claude works reach the running turn at its next tool boundary,
// once, after that tool's result, with the GUI saying so (stored, then read), and no extra turn?
// NAW_MIDTURN_SHARED=1 sends it from the collaboration space (the steward's route): the delivery is
// recorded there and the running turn's output stays private. Bounded: 1 native session, 2 local responses.
// Takes the shared GUI slot itself (exit 75 when it is busy). No paid inference or daily app.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { _electron } = testScratch.playwright(require('playwright'));
const loopback = require('./fixtures/loopback-model.cjs');
const root = path.resolve(__dirname, '..');
const { connectService } = require(path.join(root, 'app/service-client.cjs'));
const { executable } = require(path.join(root, 'app/platform.cjs'));
const shared = process.env.NAW_MIDTURN_SHARED === '1';
const evidence = process.env.NAW_EVIDENCE_DIR;
const located = executable('claude'), binary = located && fs.realpathSync(located); if (!binary) throw Error('Real Claude CLI required');
const nativeVersion = testScratch.childProcess.execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
// Mid-turn delivery is measured on exact 2.1.322 only (.local/work/midturn-20261112/work.md in the author's lane).
assert.match(nativeVersion, /^2\.1\.322(?=\s|$)/, 'Mid-turn delivery is qualified on exact 2.1.322 only');
const common = testScratch.childProcess.execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('GUI slot occupied; no GUI launched.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Claude 2', task: 'mid-turn delivery journey', token, pid: process.pid, at: new Date().toISOString() }));
const base = testScratch.directory(path.join(os.tmpdir(), 'naw-native-midturn-'));
const profile = path.join(base, 'profile'), cwd = path.join(base, 'work'), config = path.join(base, 'claude');
for (const dir of [profile, cwd, config]) fs.mkdirSync(dir, { mode: 0o700 });
const STEER = shared ? 'Steer from the space during the tool.' : 'Steer during the tool.';
const TOOL_SECONDS = 14;
let application, page, client, calls = 0, budgetError;
const errors = [], checks = [], requests = [];
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
const fixture = loopback.create({ directory: base, provider: 'claude', respond: async (req, res, body) => {
  if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: 100, data: [] })); return;
  }
  const number = ++calls;
  if (number > 2) { budgetError = Error('Native task response budget exceeded'); res.writeHead(429); res.end(); return; }
  const request = JSON.parse(body);
  requests.push({ number, at: Date.now() });
  fs.writeFileSync(path.join(base, `request-${number}.json`), body);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  event(res, 'message_start', { message: { id: `msg_local_${number}`, type: 'message', role: 'assistant', model: request.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  if (number === 1) {
    block(res, 0, { type: 'text', text: 'FIRST_NATIVE_WORK: running a long step.\n' });
    block(res, 1, { type: 'tool_use', id: 'toolu_local_long_step', name: 'Bash', input: { command: `sleep ${TOOL_SECONDS}`, description: 'A long local step' } });
  } else block(res, 0, { type: 'text', text: 'MIDTURN_REPLY: read the steer.\n' });
  event(res, 'message_delta', { delta: { stop_reason: number === 1 ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
  event(res, 'message_stop', {}); res.end();
} });
const snapshot = () => client.call('initial');
const terminalText = async () => (await page.locator('#terminal-area .xterm-rows').evaluateAll(rows => rows.filter(el => el.checkVisibility()).map(el => el.innerText).join('\n'))).replace(/ /g, ' ');
const userTexts = request => request.messages.filter(m => m.role === 'user').flatMap(m => typeof m.content === 'string' ? [m.content] : m.content.filter(b => b.type === 'text').map(b => b.text));
async function cleanup() {
  if (application) await application.close().catch(() => {});
  if (client) { try { for (const s of (await snapshot()).sessions) await client.call('stop', s.id); await client.call('shutdown'); } finally { client.close(); } }
  await fixture.stop();
}
(async () => {
  await fixture.start(); await fixture.preflight();
  const shim = path.join(base, 'claude-local');
  fixture.wrapper(binary, { file: shim, env: { CLAUDE_CONFIG_DIR: config }, args: ['--allowedTools', 'Bash(sleep:*)', '--model', 'haiku'] });
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [fs.realpathSync(cwd)]: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify({ claude: shim }), { mode: 0o600 });
  application = await _electron.launch({ executablePath: require('electron'), args: [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await application.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor(); client = await connectService(profile, 'native-midturn-test');
  if (shared) await revealDefaultSpace(page);
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check();
  await page.locator('#session-name').fill('Midturn');
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
  const before = (await snapshot()).sessions[0];
  await page.locator('#chat-tab').click();
  await page.locator('#message-input').fill('Run the original local task.'); await page.locator('#send-button').click();
  await until(() => calls === 1, 'Native original task');
  await until(async () => { const s = (await snapshot()).sessions[0]; return s.state === 'working' && s.midturnAvailable === true; }, 'Working, with mid-turn delivery offered');
  const send = shared ? '#forward-button' : '#send-button', input = shared ? '#shared-input' : '#message-input';
  if (shared) {
    await joinSpace(page);
    await page.locator('#room-nav').click(); await page.locator('#room-record').click();
    await inlineRecipient(page, before.id);
  }
  await until(async () => (await page.locator(send).innerText()) === '工具结束时送进本轮 ↑', 'The waiting action says it delivers at the next tool step');
  checks.push('A working 2.1.322 session offers 工具结束时送进本轮');
  const sentAt = Date.now();
  if (shared) await fillRoomMessage(page, STEER); else await page.locator(input).fill(STEER);
  await page.locator(send).click();
  await until(async () => (await snapshot()).sessions[0].pendingQueue, 'Held for the next tool boundary');
  const pending = (await snapshot()).sessions[0], tag = pending.pendingQueue;
  const row = () => snapshot().then(s => (shared ? s.room.messages : s.sessions[0].messages).find(m => m.id === tag));
  assert.equal((await row()).midturn, true); assert.equal((await row()).status, 'awaiting-native');
  // Past the old 15 s first-answer limit, still held and unanswered: no timeout, no retry, no extra request.
  await sleep(4000);
  assert.equal(calls, 1); assert.equal((await snapshot()).sessions[0].pendingQueue, tag);
  const visible = await page.locator('body').innerText();
  assert.ok(shared ? (await page.locator('#run-status').innerText()).includes('等它下一个工具结束时送进正在进行的回合')
    : (await page.locator('#compose-hint').innerText()).includes('正等 Claude 下一个工具结束时送进本轮'), 'The GUI says it waits for the next tool step');
  if (!shared) assert.ok(!visible.includes('想中途插话，请在原生终端输入'), 'No longer points to the native terminal');
  if (evidence) await page.screenshot({ path: path.join(evidence, `midturn-held${shared ? '-shared' : ''}.png`) });
  checks.push('Held while the tool runs: recorded as waiting for the next tool step, no request, no timeout');
  // The tool ends: the message enters that turn, its next request reads it once, after the tool's result.
  await until(() => calls === 2, 'The same turn makes its next request', (TOOL_SECONDS + 20) * 1000);
  const second = JSON.parse(fs.readFileSync(path.join(base, 'request-2.json'), 'utf8'));
  assert.equal(userTexts(second).filter(t => t.includes(STEER)).length, 1, 'Read once');
  const last = second.messages.findLast(m => m.role === 'user');
  const lastBlocks = Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content }];
  const resultAt = lastBlocks.findIndex(b => b.type === 'tool_result' && b.tool_use_id === 'toolu_local_long_step'), steerAt = lastBlocks.findIndex(b => b.type === 'text' && b.text.includes(STEER));
  assert.ok(resultAt >= 0 && steerAt > resultAt, 'After the long step\'s result, in the message the model reads next');
  assert.ok(requests[1].at - sentAt >= (TOOL_SECONDS - 5) * 1000, 'Read at the tool boundary, not before the tool ended');
  checks.push('The running turn\'s next request carries the message once, right after the tool result');
  await until(async () => { const s = (await snapshot()).sessions[0]; return s.state === 'idle' && !s.pendingQueue && s.messages.some(m => m.text?.includes('MIDTURN_REPLY')); }, 'The same turn completes');
  await until(async () => (await row()).nativeRead === true, 'The read receipt reached the record');
  const done = await snapshot(), s = done.sessions[0], delivered = await row();
  assert.equal(calls, 2, 'No turn of its own'); assert.equal(s.nativeId, before.nativeId); assert.equal(s.pid, before.pid);
  assert.equal(delivered.status, shared ? 'reply-private' : 'submitted'); assert.ok(delivered.deliveredInto, 'Delivered into the running turn');
  if (shared) {
    assert.equal(delivered.deliveries[0].status, 'submitted');
    assert.ok(!JSON.stringify(done.room.messages).includes('MIDTURN_REPLY'), 'The running turn\'s output stays private');
    assert.ok(!JSON.stringify(done.room.messages).includes('FIRST_NATIVE_WORK'));
    await until(async () => (await page.locator('#room-messages').innerText()).includes('已送进正在进行的回合，Claude 已读到'), 'The space says it was delivered and read');
    const record = await page.locator('#room-messages').innerText();
    assert.ok(record.includes('送进了正在进行的回合，回复留在原会话') && !record.includes('分享已失效'), 'Said as a delivery, not as a failed share');
    checks.push('From the space: delivered and read in the running turn; the space records that, and its reply stays in the session');
  } else {
    const steerRow = s.messages.find(m => m.id === tag), reply = s.messages.find(m => m.text?.includes('MIDTURN_REPLY'));
    assert.ok(s.messages.indexOf(steerRow) < s.messages.indexOf(reply), 'Kept in time order, before the reply that read it');
    checks.push('Private: delivered and read in the running turn, kept in time order before the reply');
  }
  if (evidence) await page.screenshot({ path: path.join(evidence, `midturn-read${shared ? '-shared' : ''}.png`) });
  if (shared) await page.locator(`[data-session-id="${before.id}"]`).click();
  await page.locator('#terminal-tab').click(); await sleep(250);
  const terminal = await terminalText();
  fs.writeFileSync(path.join(base, 'terminal.txt'), terminal);
  assert.match(terminal, /MIDTURN_REPLY/);
  // Native shows a mod's row to the model only (isMeta): the terminal does not show the message itself.
  checks.push(`Native terminal shows the reply; the delivered message itself ${terminal.includes(STEER) ? 'is' : 'is not'} drawn there`);
  assert.deepEqual(errors, []); fixture.assertClean();
  fs.writeFileSync(path.join(base, 'completed.json'), JSON.stringify(done, null, 2));
  console.log(JSON.stringify({ checks, shared, nativeVersion, fixture: fixture.summary(), localResponses: calls, paidModelCalls: 0, errors, evidence: base }));
})().catch(async error => {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(base, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  console.error(error.stack, '\nEvidence:', base); process.exitCode = 1;
}).finally(testScratch.cleanup(async () => {
  try { await cleanup(); } finally {
    try { if (JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token === token) { fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); } } catch (error) { console.error('Slot release', error.message); process.exitCode = 1; }
  }
}));
