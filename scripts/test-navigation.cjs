// Real hidden Electron navigation with many synthetic histories; no model tasks.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { fork } = require('node:child_process'), { _electron } = require('playwright');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-navigation-ui-'));
const records = Array.from({ length: 90 }, (_, i) => ({ id: `synthetic-session-${i}`, nativeId: `synthetic-native-${i}`, name: `学习项目 ${String(i).padStart(2, '0')}`, provider: i % 2 ? 'claude' : 'codex', cwd: profile, roomId: null, view: 'chat', state: 'ended', messages: [{ id: `message-${i}`, role: 'assistant', text: `合成学习资料 ${i}`, status: 'complete' }], fleet: [], background: null, scheduled: null, model: 'synthetic', usage: null, pendingTag: null, activity: '' }));
fs.writeFileSync(path.join(profile, 'workspace.json'), JSON.stringify({ sessions: records, room: { messages: [] }, drafts: {} }), { mode: 0o600 });
fs.writeFileSync(path.join(profile, 'room-state.json'), JSON.stringify({ version: 1, name: '共同工作', notes: '', revision: 0, events: [], archived: false, archivedSessions: records.slice(60).map(s => s.id), restoreMembers: [] }), { mode: 0o600 });
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms)), checks = [], errors = [], geometry = [];
let app, page, client, sequence = 0;
async function until(fn, label) { for (let n = 0; n < 160; n++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value) { const id = ++sequence; return new Promise((resolve, reject) => {
  const receive = result => { if (result.requestId === id) { clearTimeout(timer); child.off('message', receive); resolve(result); } };
  const timer = setTimeout(() => { child.off('message', receive); reject(Error('Fixture timeout')); }, 8000);
  child.on('message', receive); child.send({ id, method, target, value });
}); }
const snapshot = () => page.evaluate(() => workspace.initial());
async function launch() {
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#search-button').waitFor({ timeout: 60000 });
}
async function capture(name) { if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png') }); } }
async function inView(selector, container = null) {
  return page.locator(selector).evaluate((el, scope) => {
    const r = el.getBoundingClientRect(), box = scope ? document.querySelector(scope).getBoundingClientRect() : { top: 0, left: 0, right: innerWidth, bottom: innerHeight };
    return r.width > 0 && r.height > 0 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1 && r.left >= box.left - 1 && r.right <= box.right + 1;
  }, container);
}
async function controls(label) {
  for (const id of ['new-session', 'search-button', 'room-nav', 'archive-button', 'setup-button', 'privacy-button']) assert.equal(await inView('#' + id), true, `${label}: ${id} stays visible`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  geometry.push({ label, list: await page.locator('#session-list').boundingBox(), room: await page.locator('#room-nav').boundingBox() });
}
async function searchName(name, id) {
  await page.locator('#search-button').click(); await page.locator('#search-input').fill(name);
  await page.locator(`[data-search-key="session:${id}"]`).waitFor(); await page.locator('#search-input').press('Enter');
  await page.locator('#search-dialog').waitFor({ state: 'hidden' });
  await until(() => inView(`[data-session-row="${id}"]`, '#session-list'), 'Selected session and its menu visible after search');
}
async function create(name) {
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check();
  await page.locator('#initial-view').selectOption('chat'); await page.locator('#session-name').fill(name); await page.locator('#confirm-create').click();
  await until(async () => (await snapshot()).sessions.some(s => s.name === name && s.state === 'idle'), 'Create synthetic session');
  return (await snapshot()).sessions.find(s => s.name === name).id;
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Service ready'); client = await connect(profile, 'navigation-observer'); await launch();
  await controls('60 histories at initial size'); await capture('long-list');
  await searchName('学习项目 59', 'synthetic-session-59');
  assert.equal(await page.locator('#title').innerText(), '学习项目 59');
  await page.locator('[data-session-menu="synthetic-session-59"]').click(); await page.getByRole('menuitem', { name: '重命名…', exact: true }).click();
  const longName = '一份需要长期保留并且能够重新找到的学习与工作记录'.repeat(2);
  await page.locator('#rename-name').fill(longName); await page.locator('#confirm-rename').click();
  await until(async () => (await snapshot()).sessions.find(s => s.id === 'synthetic-session-59').name === longName, 'Rename retained history');
  assert.equal(await inView('[data-session-menu="synthetic-session-59"]', '#session-list'), true);
  await controls('Long name does not push menus or workspaces away');
  checks.push('Sixty histories scroll independently; collaboration and footer actions remain visible; search reveals the selected history and long names retain their menu');
  await page.locator('[data-session-menu="synthetic-session-59"]').click(); await page.getByRole('menuitem', { name: '归档会话', exact: true }).click();
  await until(async () => (await snapshot()).sessions.find(s => s.id === 'synthetic-session-59').archived, 'Archived');
  await page.locator('#archive-button').click();
  const archived = page.locator('[data-archived-session="synthetic-session-89"]');
  await archived.getByRole('button', { name: '恢复会话', exact: true }).click();
  await until(() => inView('[data-session-row="synthetic-session-89"]', '#session-list'), 'Restored history and menu visible');
  assert.equal((await snapshot()).sessions.find(s => s.id === 'synthetic-session-89').nativeId, 'synthetic-native-89');
  assert.equal(await page.locator('#title').innerText(), '学习项目 89');
  checks.push('An archive containing thirty-one records remains scrollable; restoring its last history reveals the same native identity without starting it');
  const live = await create('正在进行的学习');
  await page.locator('#message-input').fill('这份草稿不会发送');
  const nativeId = (await snapshot()).sessions.find(s => s.id === live).nativeId;
  await page.locator(`[data-session-id="${live}"]`).dragTo(page.locator('#room-nav'));
  await until(async () => (await snapshot()).sessions.find(s => s.id === live).roomId === 'shared', 'Pointer drag joined');
  await page.locator(`[data-session-id="${live}"]`).dragTo(page.locator('#solo-drop'));
  await until(async () => !(await snapshot()).sessions.find(s => s.id === live).roomId, 'Pointer drag detached');
  assert.equal((await snapshot()).sessions.find(s => s.id === live).nativeId, nativeId);
  assert.equal(await page.locator('#message-input').inputValue(), '这份草稿不会发送');
  checks.push('Actual pointer drag from the scrolled list joins and detaches through pinned targets, preserving native identity and an unsent draft');
  await page.locator('#session-list').hover(); await page.mouse.wheel(0, -650); await delay(250);
  const scroll = await page.locator('#session-list').evaluate(el => el.scrollTop);
  for (let i = 0; i < 12; i++) { await fixture('set-state', live, i % 2 ? 'idle' : 'working'); await delay(45); }
  assert.equal(await page.locator('#session-list').evaluate(el => el.scrollTop), scroll);
  checks.push('Native state updates do not pull a manually scrolled sidebar back to the active session');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(850, 600)); await delay(250);
  await controls('Minimum-size window'); await searchName('学习项目 58', 'synthetic-session-58'); await capture('narrow-list');
  await page.locator('[data-session-menu="synthetic-session-58"]').focus(); await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: '重命名…', exact: true }).waitFor(); await page.keyboard.press('Escape');
  await until(() => page.locator('[data-session-menu="synthetic-session-58"]').evaluate(el => document.activeElement === el), 'Menu focus returns to visible row');
  checks.push('Minimum-size window keeps primary actions and selected history reachable; keyboard menu dismissal restores focus');
  const before = await snapshot(); await app.close(); app = null; await launch();
  await until(() => inView('[data-session-row="synthetic-session-58"]', '#session-list'), 'Reopen reveals selected history and menu');
  const after = await snapshot();
  assert.deepEqual(after.sessions.map(s => [s.id, s.nativeId, s.messages, s.name, s.archived, s.liveDraft]), before.sessions.map(s => [s.id, s.nativeId, s.messages, s.name, s.archived, s.liveDraft]));
  const stats = await fixture('stats'); assert.deepEqual(stats.sends, []); assert.deepEqual(stats.inputs, []); assert.deepEqual(stats.interruptions, []);
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() })));
  assert.deepEqual(windows, [{ visible: false, focusable: false }]); assert.deepEqual(errors, []);
  checks.push('Reopen reveals the selected history and preserves names, archives, native identities, content and drafts with zero native inputs or model tasks');
  console.log(JSON.stringify({ checks, geometry, errors, modelTasks: 0, nativeProcesses: 0, windows, profile }, null, 2));
}
run().catch(async error => { console.error(error.stack); if (page && !page.isClosed()) await capture('failure'); process.exitCode = 1; }).finally(async () => {
  if (app) await app.close(); if (client) client.close();
  if (child.exitCode === null && child.signalCode === null) await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Test-owned daemon did not exit')), 8000);
    child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
  });
  console.log(JSON.stringify({ testDaemonExited: child.exitCode !== null || child.signalCode !== null }));
});
