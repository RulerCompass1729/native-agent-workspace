const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// Actual Electron keyboard controls during synthetic native updates; no model.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { fork } = testScratch.childProcess, { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-control-focus-ui-'));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/native-progress.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
let app, page, client, sequence = 0, history = 0;
const checks = [], errors = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method = 'stats', target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const receive = m => { if (m.requestId === id) { clearTimeout(timer); child.off('message', receive); m.error ? reject(Error(m.error)) : resolve(m); } };
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Fixture timeout')); }, 12000);
    child.on('message', receive); child.send({ id, method, target, value });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
async function create(provider) {
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#session-name').fill(provider + ' · 键盘操作'); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => s.provider === provider && s.state === 'idle'), 'Session ready');
  return (await snapshot()).sessions.find(s => s.provider === provider).id;
}
async function update(id) {
  const text = 'SYNTHETIC BACKGROUND UPDATE ' + ++history;
  await fixture('history', id, [{ id: 'focus-' + history, type: 'agentMessage', text }]);
  await until(async () => (await snapshot()).sessions.find(s => s.id === id)?.messages.some(m => m.text === text), 'History received');
  // A painted frame after the service event, including when a modal covers history.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function hold(locator, action) {
  const original = await locator.elementHandle(); await locator.focus(); await action();
  assert.equal(await original.evaluate(el => el.isConnected && document.activeElement === el), true, 'Original control retains focus');
}
async function shot(name) {
  if (!process.env.NAW_EVIDENCE_DIR) return;
  fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png') });
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Daemon ready'); client = await connect(profile, 'focus-observer');
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
  await page.locator('#new-session').waitFor();
  const a = await create('claude'), header = page.locator('#header-actions');
  await hold(header.getByRole('button', { name: '加入协作', exact: true }), () => update(a));
  await page.keyboard.press('Enter'); await until(async () => (await snapshot()).sessions.find(s => s.id === a).roomId === 'shared', 'Keyboard joins current session');
  const b = await create('codex');
  await hold(header.getByRole('button', { name: '加入协作', exact: true }), () => update(b));
  await page.keyboard.press('Enter'); await until(async () => (await snapshot()).sessions.find(s => s.id === b).roomId === 'shared', 'Changed selection joins new session');
  checks.push('Header button retains its original node and keyboard focus during history updates; Enter acts on the currently selected session');

  await page.locator('#advanced > summary').click();
  await hold(page.locator('#advanced-content').getByRole('button', { name: '查看协作笔记', exact: true }), () => update(b));
  await page.keyboard.press('Enter'); await page.locator('#notes-dialog').waitFor(); await page.locator('#cancel-notes').click();
  await hold(page.locator('#advanced-content').getByRole('button', { name: '带上协作背景…', exact: true }), () => update(b));
  await page.keyboard.press('Enter'); await page.locator('#context-dialog').waitFor();
  assert.match(await page.locator('#context-text').inputValue(), /本会话仍参与该工作区/); await page.locator('#close-context').click();
  checks.push('Advanced notes/context actions retain focus through updates and open the intended local dialog without sending context');

  await page.locator('#room-nav').click(); await page.locator('#room-record').click(); await page.locator('#manage-members').click();
  const member = page.locator(`[data-member-id="${a}"]`), view = member.getByRole('button', { name: '查看终端', exact: true });
  await hold(view, async () => { await update(a); await page.evaluate(id => workspace.rename(id, 'Renamed keyboard member'), a); });
  await member.getByText('Renamed keyboard member', { exact: true }).waitFor();
  assert.equal(await view.evaluate(el => document.activeElement === el), true);
  await page.keyboard.press('Enter'); await until(async () => !(await page.locator('#members-dialog').evaluate(el => el.open)), 'Members closed');
  await until(async () => (await snapshot()).viewState.roomSession === a, 'Exact member selected');
  await page.locator('#terminal-area .xterm-screen:visible').waitFor();
  checks.push('Member action retains focus while history and local name change; Enter opens that same member terminal');

  await page.locator('#room-record').click(); await page.locator('#manage-members').click(); await view.focus();
  await client.call('join', a, false); await until(async () => await member.count() === 0, 'Member removed');
  assert.equal(await page.locator('#close-members').evaluate(el => document.activeElement === el), true);
  await page.keyboard.press('Enter'); assert.equal(await page.locator('#members-dialog').evaluate(el => el.open), false);
  assert.equal((await snapshot()).sessions.find(s => s.id === b).roomId, 'shared');
  checks.push('Removing the focused member returns focus to dialog completion, never the adjacent member action');

  await page.locator(`[data-session-id="${b}"]`).click(); await page.locator('#chat-tab').click();
  await fixture('approval', b, { requestId: 17, method: 'item/commandExecution/requestApproval', params: { command: 'echo synthetic', cwd: '/synthetic', reason: 'Keyboard-only check' } });
  const approve = page.locator('#approval').getByRole('button', { name: '允许这一次', exact: true }); await approve.waitFor();
  await hold(approve, () => update(b)); await shot('approval-focus');
  const old = await approve.elementHandle(), oldRequest = (await snapshot()).sessions.find(s => s.id === b).approval.requestId;
  // A changed scope for the SAME native request invalidates its GUI credential.
  // A different native request would remain queued alongside the first one.
  await fixture('approval', b, { requestId: 17, method: 'item/commandExecution/requestApproval', params: { command: 'echo changed-scope', cwd: '/synthetic', reason: 'Changed request' } });
  await page.locator('#approval').getByText('echo changed-scope', { exact: true }).waitFor();
  assert.equal(await old.evaluate(el => el.isConnected), false);
  assert.equal(await approve.evaluate(el => document.activeElement === el), false, 'Changed permission is not silently focused');
  await page.evaluate(({ id, requestId }) => workspace.approve(id, requestId, 'accept').then(() => { throw Error('Stale approval accepted'); }, e => { if (!e.message.includes('权限请求已变化')) throw e; }), { id: b, requestId: oldRequest });
  assert.deepEqual((await fixture('stats', b)).approvalReplies, [], 'Stale GUI credential never reaches the native reply transport');
  const fresh = (await snapshot()).sessions.find(s => s.id === b);
  await client.call('claim', b, 'chat');
  await until(async () => await approve.isDisabled(), 'Observer loses decision control');
  await page.evaluate(({ id, requestId }) => workspace.approve(id, requestId, 'accept').then(() => { throw Error('Non-owner approval accepted'); }, e => { if (!e.message.includes('权限请求已变化')) throw e; }), { id: b, requestId: fresh.approval.requestId });
  assert.deepEqual((await fixture('stats', b)).approvalReplies, [], 'Losing control never replies to the native request');
  await page.evaluate(id => workspace.claim(id, 'chat'), b); await until(async () => await approve.isEnabled(), 'Explicit takeover restores decision control');
  assert.notEqual(fresh.approval.requestId, oldRequest);
  await approve.click();
  await until(async () => !(await snapshot()).sessions.find(s => s.id === b).approval, 'Native resolution clears the current approval');
  assert.deepEqual((await fixture('stats', b)).approvalReplies, [{ requestId: 17, result: { decision: 'accept' } }], 'Only the fresh authorized decision reaches the exact native request once');
  checks.push('Unrelated updates retain permission-button focus; changed scope replaces the GUI credential without implicit focus; stale and non-owner decisions cannot reply; fresh acceptance resolves the exact native request once');
  // A Codex question is answered here with native's structured reply (T-18): an option, or "other" text.
  const ask = (requestId, question) => fixture('approval', b, { requestId, method: 'item/tool/requestUserInput', params: { threadId: 'synthetic-thread', turnId: 'synthetic-turn', itemId: `ask-${requestId}`, isBlocking: true, autoResolutionMs: null, questions: [question] } });
  await ask(31, { id: 'approach', header: '方案', question: '用哪种做法？', isOther: true, isSecret: false, options: [{ label: '复用现有', description: '沿用原生机制' }, { label: '另起炉灶', description: '' }] });
  let form = page.locator('#approval .question-form'); await form.getByText('用哪种做法？', { exact: true }).waitFor();
  assert.equal(await form.getByRole('button', { name: '提交回答', exact: true }).isDisabled(), true, 'Nothing is sent before every question has an answer');
  await form.locator('label', { hasText: '复用现有' }).locator('input').check(); await form.getByRole('button', { name: '提交回答', exact: true }).click();
  await until(async () => JSON.stringify((await fixture('stats', b)).approvalReplies.at(-1)) === JSON.stringify({ requestId: 31, result: { answers: { approach: { answers: ['复用现有'] } } } }), 'Chosen option reaches the exact native request');
  await ask(32, { id: 'detail', header: '补充', question: '还有什么要求？', isOther: true, isSecret: false, options: [{ label: '没有', description: '' }] });
  form = page.locator('#approval .question-form'); await form.getByText('还有什么要求？', { exact: true }).waitFor();
  await form.getByRole('textbox').fill('保持原生行为'); await form.getByRole('button', { name: '提交回答', exact: true }).click();
  await until(async () => JSON.stringify((await fixture('stats', b)).approvalReplies.at(-1)) === JSON.stringify({ requestId: 32, result: { answers: { detail: { answers: ['保持原生行为'] } } } }), 'Other text reaches the native request');
  await shot('question-answered');
  checks.push('A Codex question is answered in the chat view with the native structured reply, an option or other text, never before every question is answered');

  await page.locator(`[data-session-id="${a}"]`).click();
  const join = header.getByRole('button', { name: '加入协作', exact: true });
  await join.focus(); await client.call('join', a, true);
  const leave = header.getByRole('button', { name: '脱出协作', exact: true }); await leave.waitFor();
  await page.keyboard.press('Enter');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal((await snapshot()).sessions.find(s => s.id === a).roomId, 'shared', 'Old join focus cannot execute opposite leave action');
  assert.equal(await leave.evaluate(el => document.activeElement === el), false);
  await leave.focus(); await client.call('join', a, false); await join.waitFor();
  await page.keyboard.press('Enter');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal((await snapshot()).sessions.find(s => s.id === a).roomId, null, 'Old leave focus cannot execute opposite join action');
  assert.equal(await join.evaluate(el => document.activeElement === el), false);
  checks.push('External membership changes withdraw obsolete keyboard focus in both directions; Enter never executes the opposite operation');
  await hold(header.getByRole('button', { name: '加入协作', exact: true }), () => update(a));
  await page.keyboard.press('Enter'); await until(async () => (await snapshot()).sessions.find(s => s.id === a).roomId === 'shared', 'Rejoin current member');
  assert.equal((await snapshot()).sessions.find(s => s.id === b).roomId, 'shared');
  assert.equal(await header.getByRole('button', { name: '脱出协作', exact: true }).count(), 1);
  await hold(header.getByRole('button', { name: '脱出协作', exact: true }), () => update(a)); await page.keyboard.press('Enter');
  await until(async () => !(await snapshot()).sessions.find(s => s.id === a).roomId, 'Detach current session');
  assert.equal((await snapshot()).sessions.find(s => s.id === b).roomId, 'shared');
  await shot('header-focus');
  checks.push('Reused header controls follow later selections and membership changes without duplicate buttons or affecting the other member');
  // The chat/terminal divider drags freely, snaps to the centre within 16 px, resizes the
  // native terminal once on release, and is remembered; the chat can take the full width.
  await page.locator(`[data-session-id="${a}"]`).click(); await page.locator('#terminal-tab').click();
  await page.locator('#terminal-area .xterm-screen:visible').waitFor();
  const layout = page.locator('#session-layout'), divider = layout.locator('.split-divider');
  const area = await layout.boundingBox(), centre = area.x + area.width / 2, y = area.y + 120;
  const split = () => layout.evaluate(el => el.style.getPropertyValue('--split-left'));
  const drag = async (to, steps) => { const d = await divider.boundingBox(); await page.mouse.move(d.x + d.width / 2, y); await page.mouse.down(); for (const x of steps) await page.mouse.move(x, y); await page.mouse.move(to, y); await page.mouse.up(); };
  const resizes = (await fixture()).stats.resizes, terminalWidth = (await page.locator('#terminal-area').boundingBox()).width;
  await page.mouse.move((await divider.boundingBox()).x + 5, y); await page.mouse.down();
  for (const dx of [40, 80, 120, 160]) await page.mouse.move(centre + dx, y);
  await delay(150); assert.equal((await fixture()).stats.resizes, resizes, 'No native resize while dragging');
  await page.mouse.move(centre + 200, y); await page.mouse.up();
  await until(async () => (await fixture()).stats.resizes === resizes + 1, 'One native resize after the drag'); await delay(150);
  assert.equal((await fixture()).stats.resizes, resizes + 1);
  assert.ok((await page.locator('#terminal-area').boundingBox()).width < terminalWidth - 150, 'The terminal got narrower');
  await drag(centre + 10, [centre + 60]); assert.equal(await split(), '50.00%', 'Within 16 px of the centre it snaps to half');
  await drag(centre + 30, [centre + 60]); assert.notEqual(await split(), '50.00%', 'Beyond the snap range it stays where dropped');
  await until(async () => Math.abs((await page.evaluate(() => workspace.initial())).viewState.terminalSplit - Number.parseFloat(await split()) / 100) < 0.001, 'Split width saved');
  await shot('split-dragged');
  // On a narrow window a 2% key step is under the 16 px snap; keys still move it.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(950, 760)); await delay(300);
  await divider.focus(); await page.keyboard.press('Home'); assert.equal(await split(), '50.00%');
  await page.keyboard.press('ArrowRight'); assert.equal(await split(), '52.00%', 'A key step moves the split even when narrower than the snap');
  assert.equal(await divider.getAttribute('aria-valuenow'), '52');
  await page.keyboard.press('ArrowLeft'); assert.equal(await split(), '50.00%');
  await page.getByRole('button', { name: '放大对话', exact: true }).click(); await until(() => page.locator('#native-pane').isHidden(), 'Chat takes the full width');
  await page.getByRole('button', { name: '恢复并排', exact: true }).first().click(); await until(() => page.locator('#native-pane').isVisible(), 'Side by side again');
  checks.push('The chat/terminal divider drags freely, snaps to the centre within 16 px, resizes the native terminal once per drag and is saved; the chat has its own full-width toggle');
  const stats = (await fixture()).stats;
  assert.equal(stats.sends, 0); assert.equal(stats.inputs, 0); assert.deepEqual(errors, []);
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() })));
  assert.deepEqual(windows, [{ visible: false, focusable: false }]);
  console.log(JSON.stringify({ checks, stats, errors, windows, nativeProcesses: 0, modelTasks: 0 }, null, 2));
}
run().catch(async error => { console.error(error.stack); process.exitCode = 1; if (page && !page.isClosed()) await shot('failure').catch(() => {}); }).finally(testScratch.cleanup(async () => {
  if (app) await app.close();
  if (client) { await fixture('stop'); await client.call('shutdown'); client.close(); }
  if (child.connected) child.disconnect();
  await until(() => child.exitCode !== null, 'Owned fixture exits');
}));
