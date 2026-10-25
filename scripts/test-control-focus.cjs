const testScratch = require('./fixtures/test-scratch.cjs');
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
  await page.locator('#initial-view').selectOption('chat'); await page.locator('#session-name').fill(provider + ' · 键盘操作'); await page.locator('#confirm-create').click();
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
  await page.locator('#terminal-area .xterm-screen').waitFor();
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
  await fixture('approval', b, { requestId: 18, method: 'item/commandExecution/requestApproval', params: { command: 'echo changed-scope', cwd: '/synthetic', reason: 'New request' } });
  await page.locator('#approval').getByText('echo changed-scope', { exact: true }).waitFor();
  assert.equal(await old.evaluate(el => el.isConnected), false);
  assert.equal(await approve.evaluate(el => document.activeElement === el), false, 'Changed permission is not silently focused');
  await page.evaluate(({ id, requestId }) => workspace.approve(id, requestId, 'accept').then(() => { throw Error('Stale approval accepted'); }, e => { if (!e.message.includes('权限请求已变化')) throw e; }), { id: b, requestId: oldRequest });
  const fresh = (await snapshot()).sessions.find(s => s.id === b);
  await client.call('claim', b, 'chat');
  await until(async () => await approve.isDisabled(), 'Observer loses decision control');
  await page.evaluate(id => workspace.claim(id, 'chat'), b); await until(async () => await approve.isEnabled(), 'Explicit takeover restores decision control');
  assert.notEqual(fresh.approval.requestId, oldRequest);
  checks.push('Unrelated updates retain permission-button focus; changed request replaces it without implicit focus, stale request is rejected and owner changes disable decisions');

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
