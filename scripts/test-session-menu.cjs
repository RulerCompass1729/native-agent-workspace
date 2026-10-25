const testScratch = require('./fixtures/test-scratch.cjs');
// Headed Electron interaction regression using only synthetic ended sessions.
// No provider session is created, resumed or sent a prompt.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { _electron } = testScratch.playwright(require('playwright'));
const { connect } = require('../app/service-client.cjs');
const root = path.resolve(__dirname, '..');
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-menu-test-'));
const shots = process.env.NAW_EVIDENCE_DIR;
const sessions = ['claude', 'codex'].map((provider, i) => ({
  id: randomUUID(), nativeId: randomUUID(), name: '学习笔记', provider,
  cwd: profile, state: 'ended', view: 'chat', roomId: i ? 'shared' : null,
  memberRevision: 0, controlRevision: 0, messages: [], fleet: [], model: '原生默认',
  background: null, scheduled: null, usage: null,
}));
fs.writeFileSync(path.join(profile, 'workspace.json'), JSON.stringify({ sessions, room: { messages: [] } }), { mode: 0o600 });
if (shots) fs.mkdirSync(shots, { recursive: true, mode: 0o700 });
let application, page;
const errors = [];
const snapshot = () => page.evaluate(() => workspace.initial());
const more = (id, p = page) => p.locator(`[data-session-menu="${id}"]`);
const link = id => page.locator(`[data-session-id="${id}"]`);
const item = (name, p = page) => p.getByRole('menuitem', { name, exact: true });
const stable = s => s.sessions.map(x => [x.id, x.nativeId, x.pid, x.state, x.roomId, x.messages]);
async function until(fn, label) {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(label);
}
async function launch() {
  assert.ok(!application);
  application = await _electron.launch({
    executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'),
    args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000,
  });
  page = await application.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor({ state: 'visible' });
  await link(sessions[0].id).waitFor({ state: 'visible' });
}
async function close() { if (application) { const app = application; application = null; await app.close(); } }
async function screenshot(name) { if (shots) await page.screenshot({ path: path.join(shots, name + '.png') }); }
async function run() {
  console.log('Fixture profile:', profile);
  await launch();
  const [a, b] = sessions; await link(a.id).click();
  const before = await snapshot();
  assert.ok(before.sessions.every(s => s.state === 'ended'));
  await more(b.id).click(); await item('重命名…').waitFor({ state: 'visible' });
  await until(async () => item('重命名…').evaluate(el => el === document.activeElement), 'Mouse menu autofocus');
  assert.equal((await snapshot()).viewState.selected, a.id, 'Menu must not select its target');
  assert.equal(await page.locator('.session-row button button').count(), 0);
  const anchor = await more(b.id).elementHandle();
  const focused = await page.evaluateHandle(() => document.activeElement);
  // Ended fixtures have no input owner. Exercise a legitimate metadata
  // broadcast instead of trying to write an unowned native session's draft.
  await page.evaluate(id => workspace.rename(id, '状态更新中的会话'), a.id);
  await until(async () => (await snapshot()).sessions.find(s => s.id === a.id).name === '状态更新中的会话', 'State broadcast');
  await page.waitForTimeout(100); // Let the name metadata broadcast reach the view.
  assert.ok(await anchor.evaluate(el => el.isConnected && el.getAttribute('aria-expanded') === 'true'));
  assert.ok(await focused.evaluate(el => el === document.activeElement), 'Broadcast must retain menu focus');
  await page.evaluate(({ id, name }) => workspace.rename(id, name), a);
  await page.keyboard.press('Escape');
  assert.equal(await more(b.id).getAttribute('aria-expanded'), 'false');
  assert.ok(await more(b.id).evaluate(el => el === document.activeElement));
  await anchor.dispose(); await focused.dispose();
  await link(b.id).click({ button: 'right' }); await item('重命名…').click();
  assert.equal(await page.locator('#rename-name').inputValue(), b.name);
  await page.locator('#rename-name').fill('   '); await page.locator('#confirm-rename').click();
  await page.locator('#rename-error').waitFor({ state: 'visible' });
  await page.locator('#rename-name').fill('研究 & <计划>'); await page.locator('#rename-name').press('Enter');
  await until(async () => !(await page.locator('#rename-dialog').isVisible()), 'Rename closes');
  let after = await snapshot();
  assert.equal(after.viewState.selected, a.id);
  assert.equal(after.sessions.find(s => s.id === a.id).name, a.name);
  assert.equal(after.sessions.find(s => s.id === b.id).name, '研究 & <计划>');
  assert.deepEqual(after.sessions.map(s => [s.owner, s.controlRevision]), before.sessions.map(s => [s.owner, s.controlRevision]));
  await more(b.id).click(); await item('重命名…').click();
  await page.locator('#rename-name').fill('取消的名称'); await page.locator('#rename-name').press('Escape');
  assert.equal((await snapshot()).sessions.find(s => s.id === b.id).name, '研究 & <计划>');
  await more(b.id).click(); await item('重命名…').waitFor({ state: 'visible' });
  await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('menu').count(), 0);
  assert.equal(await page.locator('#rename-dialog').isVisible(), false);
  assert.equal(application.windows().length, 1);
  await more(b.id).click(); await item('重命名…').waitFor({ state: 'visible' });
  await page.keyboard.press('Shift+Tab'); assert.equal(await page.getByRole('menu').count(), 0);
  assert.equal(await page.locator('#rename-dialog').isVisible(), false);
  await more(b.id).click(); await item('重命名…').waitFor({ state: 'visible' });
  await more(b.id).click(); assert.equal(await page.getByRole('menu').count(), 0, 'Trigger toggles closed');
  await more(b.id).click(); await item('重命名…').waitFor({ state: 'visible' });
  await page.locator('#title').click(); assert.equal(await page.getByRole('menu').count(), 0);
  console.log('PASS: duplicate-name targeting, right-click, validation/cancel/save, no implicit selection/takeover, stable focus on state update, Escape/Tab/outside dismissal.');

  await more(b.id).focus(); await page.keyboard.press('Enter');
  await item('重命名…').waitFor({ state: 'visible' });
  await until(async () => item('重命名…').evaluate(el => el === document.activeElement), 'Keyboard menu autofocus');
  await require('./check-theme.cjs').checkTheme(page);
  await page.emulateMedia({ colorScheme: 'light' }); await screenshot('session-menu-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.body.hasAttribute('data-ds-dark-theme')); await screenshot('session-menu-dark');
  await page.emulateMedia({ colorScheme: null });
  await page.keyboard.press('End');
  assert.ok(await item('归档会话').evaluate(el => el === document.activeElement), 'End focuses the last menu item');
  await page.keyboard.press('ArrowUp');
  assert.ok(await item('在独立窗口打开').evaluate(el => el === document.activeElement), 'ArrowUp returns to the window action');
  const opened = application.waitForEvent('window');
  await page.keyboard.press('Enter');
  const second = await opened;
  await second.locator('#new-session').waitFor({ state: 'visible' });
  assert.equal((await second.evaluate(() => workspace.initial())).viewState.selected, b.id);
  assert.equal((await snapshot()).viewState.selected, a.id);
  await more(b.id, second).click(); await item('重命名…', second).click();
  await second.locator('#rename-name').fill('很长的会话名称'.repeat(7)); await second.locator('#confirm-rename').click();
  await until(async () => (await more(b.id).getAttribute('aria-label')).includes('很长'), 'Other-window rename broadcast');
  await second.close();
  await page.locator('#room-nav').click();
  assert.equal(await page.locator(`[data-room-session="${b.id}"]`).innerText(), '很长的会话名称'.repeat(7));
  const win = await application.browserWindow(page);
  await win.evaluate(w => w.setSize(850, 600));
  assert.ok(await page.locator(`[data-room-session="${b.id}"]`).evaluate(el => el.getBoundingClientRect().width <= 200 && el.title.startsWith(el.textContent + ' · ')));
  assert.ok(await page.locator('#recipient').evaluate(el => el.getBoundingClientRect().width <= 260 && el.title === el.selectedOptions[0].textContent));
  await more(b.id).click(); await item('重命名…').waitFor({ state: 'visible' });
  await until(async () => page.getByRole('menu').evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }), 'Menu fits small window');
  assert.ok(await more(b.id).evaluate(el => { const r = el.getBoundingClientRect(); return r.width >= 24 && r.height >= 24 && r.right <= innerWidth; }));
  await screenshot('session-menu-small'); await page.keyboard.press('Escape');
  console.log('PASS: keyboard menu/new-window target, cross-window and room-name sync, light/dark contrast, small-window menu bounds.');
  after = await snapshot(); assert.deepEqual(stable(after), stable(before));
  assert.equal(after.diagnostics.dispatches, 0); assert.equal(after.diagnostics.shellModelCalls, 0);
  fs.writeFileSync(path.join(profile, 'menu-result.json'), JSON.stringify(after), { mode: 0o600 });
  await close(); await launch();
  const reopened = await snapshot(); assert.deepEqual(stable(reopened), stable(before));
  assert.equal(reopened.sessions.find(s => s.id === b.id).name, '很长的会话名称'.repeat(7));
  assert.equal(application.windows().length, 1); assert.deepEqual(errors, []);
  console.log('PASS: reopen preserves names and identity/history/membership; no native prompts, dispatches or shell model calls.');
}
run().catch(async error => { console.error(error.stack); if (page && !page.isClosed()) await screenshot('failed'); process.exitCode = 1; }).finally(testScratch.cleanup(async () => {
  await close();
  try { const c = await connect(profile, 'menu-test-cleanup'); try { await c.call('shutdown'); } finally { c.close(); } }
  catch (error) { console.error('Owned test service cleanup failed:', error.message); process.exitCode = 1; }
}));
