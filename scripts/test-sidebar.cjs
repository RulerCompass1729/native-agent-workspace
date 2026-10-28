const testScratch = require('./fixtures/test-scratch.cjs');
// Actual hidden Electron/DSH, desktop metadata and lifecycle; synthetic native
// transport only. No provider process, model, task send or terminal input.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { fork } = testScratch.childProcess, { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-sidebar-ui-'));
const ids = ['abcdef00-0000-4000-8000-000000000001', 'abcdef10-0000-4000-8000-000000000002', '12345600-0000-4000-8000-000000000003'];
fs.writeFileSync(path.join(profile, 'workspace.json'), JSON.stringify({ sessions: ids.map((id, i) => ({ id, provider: i === 1 ? 'claude' : 'codex', name: i < 2 ? '学习' : '常用', nativeId: i === 2 ? null : 'synthetic-native-' + i, model: 'fixture', cwd: profile, state: 'idle', messages: [] })) }), { mode: 0o600 });
fs.writeFileSync(path.join(profile, 'views.json'), JSON.stringify([{ owner: 'sidebar-owner', active: true, selected: ids[0], mode: 'chat' }, { owner: 'sidebar-observer', active: true, selected: '', mode: 'chat' }]), { mode: 0o600 });
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/native-progress.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: profile }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms)), checks = [], errors = [];
let app, page, peer, client, sequence = 0;
async function until(fn, label) { for (let i = 0; i < 180; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method = 'stats', target, value) { const id = ++sequence; return new Promise((resolve, reject) => {
  const callback = result => { if (result.requestId === id) { clearTimeout(timer); child.off('message', callback); result.error ? reject(Error(result.error)) : resolve(result); } };
  const timer = setTimeout(() => { child.off('message', callback); reject(Error('Fixture timeout')); }, 8000);
  child.on('message', callback); child.send({ id, method, target, value });
}); }
const snapshot = () => page.evaluate(() => workspace.initial());
const rows = p => p.locator('#session-list [data-session-row]');
const order = p => rows(p).evaluateAll(list => list.map(row => row.dataset.sessionRow));
async function expectOrder(expected) { for (const p of [page, peer]) await until(async () => JSON.stringify(await order(p)) === JSON.stringify(expected), 'Same saved sidebar order in both windows'); }
async function launch() {
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  await until(() => app.windows().length === 2, 'Two restored owned windows');
  for (const p of app.windows()) { p.setDefaultTimeout(15000); p.on('pageerror', e => errors.push(e.message)); await p.locator('#new-session').waitFor(); const s = await p.evaluate(() => workspace.initial()); if (s.viewState.owner === 'sidebar-owner') page = p; else peer = p; }
  await app.evaluate(({ clipboard }) => { globalThis.sidebarCopies = []; clipboard.writeText = value => globalThis.sidebarCopies.push(value); });
  for (const p of [page, peer]) { const w = await app.browserWindow(p); assert.equal(await w.evaluate(win => win.isVisible()), false); assert.equal(await w.evaluate(win => win.isFocusable()), false); }
}
async function menu(id, action, keyboard = false) {
  const trigger = page.locator(`[data-session-menu="${id}"]`);
  if (keyboard) { await trigger.focus(); await page.keyboard.press('Shift+F10'); } else await trigger.click();
  const item = page.getByRole('menuitem', { name: action, exact: true }); await item.waitFor();
  if (keyboard) { await until(async () => (await page.locator('.naw-session-menu [role="menuitem"]:focus').count()) === 1, 'Menu initial focus'); for (let i = 0; i < 12 && !(await item.evaluate(el => el === document.activeElement)); i++) await page.keyboard.press('ArrowDown'); assert.equal(await item.evaluate(el => el === document.activeElement), true); await page.keyboard.press('Enter'); }
  else await item.click();
  await page.locator('.naw-session-menu').waitFor({ state: 'hidden' });
}
async function dragTo(source, target, fraction = 0.5) {
  const a = await source.boundingBox(), b = await target.boundingBox(); assert.ok(a && b);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height * fraction, { steps: 12 }); await page.mouse.up();
}
async function capture(name) {
  if (!process.env.NAW_EVIDENCE_DIR) return;
  fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true, mode: 0o700 });
  await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png') });
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Fixture service ready'); client = await connect(profile, 'sidebar-test-observer'); await launch();
  await page.locator('#composer').getByRole('button', { name: '继续原生会话', exact: true }).click();
  await until(async () => (await snapshot()).sessions.find(s => s.id === ids[0]).state === 'idle', 'Resume original synthetic session');
  await page.locator('#message-input').fill('保留的私人草稿，不发送');
  await until(async () => (await snapshot()).sessions.find(s => s.id === ids[0]).liveDraft === '保留的私人草稿，不发送', 'Draft saved');
  const identity = s => [s.id, s.nativeId, s.pid, s.owner, s.liveDraft], original = identity((await snapshot()).sessions.find(s => s.id === ids[0]));
  await expectOrder(ids);
  for (const [id, short] of [[ids[0], 'abcdef0'], [ids[1], 'abcdef1'], [ids[2], '123456']]) {
    assert.equal(await page.locator(`[data-session-row="${id}"] .session-short-id`).innerText(), short);
    assert.ok((await page.locator(`[data-session-id="${id}"]`).getAttribute('aria-label')).includes(short));
  }
  assert.ok((await page.locator('#subtitle').innerText()).includes('abcdef0'));
  await menu(ids[0], '复制完整 NAW ID'); await menu(ids[0], '复制完整原生 ID');
  assert.deepEqual(await app.evaluate(() => globalThis.sidebarCopies), [ids[0], 'synthetic-native-0']);
  await page.locator(`[data-session-menu="${ids[2]}"]`).click();
  assert.equal(await page.getByRole('menuitem', { name: '复制完整原生 ID', exact: true }).count(), 0);
  await page.keyboard.press('Escape');
  checks.push('Always-visible collision-expanded NAW IDs distinguish duplicate names; header and exact full NAW/native copy agree without changing system clipboard');

  await dragTo(page.locator(`[data-session-id="${ids[2]}"]`), page.locator(`[data-session-row="${ids[0]}"]`), 0.2);
  await expectOrder([ids[2], ids[0], ids[1]]);
  assert.equal((await snapshot()).sessions.find(s => s.id === ids[2]).roomId, undefined);
  await menu(ids[2], '下移', true); await expectOrder([ids[0], ids[2], ids[1]]);
  assert.equal(await page.locator(`[data-session-menu="${ids[2]}"]`).evaluate(el => el === document.activeElement), true);
  await menu(ids[2], '上移', true); await expectOrder([ids[2], ids[0], ids[1]]);
  checks.push('Actual row drag and keyboard menu move up/down save the same cross-window order without changing membership or focused row');

  await dragTo(page.locator(`[data-session-id="${ids[0]}"]`), page.locator('#room-nav'));
  await until(async () => Boolean((await snapshot()).sessions.find(s => s.id === ids[0]).roomId), 'Drag to room joins');
  await expectOrder([ids[2], ids[0], ids[1]]);
  await dragTo(page.locator(`[data-session-id="${ids[0]}"]`), page.locator(`[data-session-row="${ids[2]}"]`), 0.2);
  await expectOrder([ids[0], ids[2], ids[1]]);
  assert.ok((await snapshot()).sessions.find(s => s.id === ids[0]).roomId, 'Sorting a member does not detach it');
  await page.locator('#room-nav').click();
  const memberTab = page.locator(`[data-room-session="${ids[0]}"]`); await memberTab.waitFor(); assert.ok((await memberTab.innerText()).includes('abcdef0'));
  await page.locator('#solo-drop').click();
  await until(() => page.locator('#session-list').isHidden(), 'Sessions collapsed');
  await dragTo(memberTab, page.locator('#solo-drop'));
  await until(async () => !(await snapshot()).sessions.find(s => s.id === ids[0]).roomId, 'Collapsed header still detaches member');
  assert.equal(await page.locator('#solo-drop').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('#session-list').isHidden(), true);
  checks.push('Room join remains a separate drop action; member sorting preserves membership; collapsed session header still detaches a room tab without expanding');

  await page.locator('#solo-drop').focus(); await page.keyboard.press('ArrowRight');
  await until(() => page.locator('#session-list').isVisible(), 'Right expands');
  await page.locator(`[data-session-id="${ids[0]}"]`).click();
  await fixture('state', ids[0], 'working');
  await until(async () => (await page.locator('#session-group-summary').innerText()).includes('1 工作中'), 'Working overview');
  await page.locator('#workspace-toggle').focus(); await page.keyboard.press('Space');
  await until(() => page.locator('#workspace-group-body').isHidden(), 'Space collapses room');
  await page.locator('#solo-drop').focus(); await page.keyboard.press('Enter');
  await until(() => peer.locator('#session-list').isHidden(), 'Peer collapse synced');
  assert.equal(await page.locator('#solo-drop').getAttribute('aria-controls'), 'session-list');
  assert.ok((await page.locator('#solo-drop').innerText()).includes('3'));
  await capture('collapsed-working');
  await page.locator('#solo-drop').press('ArrowRight');
  await fixture('state', ids[0], 'idle');
  await menu(ids[0], '重命名…'); await page.locator('#rename-name').fill('改名后仍是原会话'); await page.locator('#confirm-rename').click();
  await until(async () => (await peer.locator(`[data-session-row="${ids[0]}"]`).innerText()).includes('改名后仍是原会话'), 'Peer rename');
  assert.equal(await page.locator(`[data-session-row="${ids[0]}"] .session-short-id`).innerText(), 'abcdef0');
  assert.deepEqual(identity((await snapshot()).sessions.find(s => s.id === ids[0])), original);
  checks.push('Keyboard collapse/expand, live overview, rename and profile broadcasts preserve selected native identity/owner and unsent draft');

  // Fail the actual metadata disk replacement. No optimistic reorder/collapse
  // may become visible or replace the existing names on a failed save.
  const metadata = fs.readFileSync(path.join(profile, 'session-labels.json'), 'utf8');
  await app.evaluate(() => { const fs = process.getBuiltinModule('fs'); globalThis.sidebarRename = fs.renameSync; fs.renameSync = (from, to) => { if (String(to).endsWith('/session-labels.json')) throw Error('Synthetic metadata save failure'); return globalThis.sidebarRename(from, to); }; });
  await menu(ids[0], '下移');
  await page.locator('#toast').getByText('未能保存会话显示设置', { exact: false }).waitFor();
  await expectOrder([ids[0], ids[2], ids[1]]); assert.equal(fs.readFileSync(path.join(profile, 'session-labels.json'), 'utf8'), metadata);
  await page.locator('#solo-drop').click(); await delay(100); assert.equal(await page.locator('#solo-drop').getAttribute('aria-expanded'), 'true');
  await app.evaluate(() => { process.getBuiltinModule('fs').renameSync = globalThis.sidebarRename; });
  await page.locator('#toast-close').click();
  await menu(ids[0], '下移'); await expectOrder([ids[2], ids[0], ids[1]]);
  await page.locator('#solo-drop').click(); await until(() => peer.locator('#session-list').isHidden(), 'Saved collapsed state');
  await page.reload(); await page.locator('#new-session').waitFor();
  await until(() => page.locator('#session-list').isHidden(), 'Reload retains collapsed');
  assert.equal(await page.locator('#workspace-group-body').isHidden(), true);
  assert.deepEqual(identity((await snapshot()).sessions.find(s => s.id === ids[0])), original);
  await app.close(); app = null; await launch();
  await until(() => page.locator('#session-list').isHidden(), 'App reopen retains collapsed');
  assert.equal(await page.locator('#workspace-group-body').isHidden(), true);
  await expectOrder([ids[2], ids[0], ids[1]]);
  await page.locator('#solo-drop').press('ArrowRight');
  assert.equal(await page.locator('#message-input').inputValue(), original.at(-1));
  assert.deepEqual(identity((await snapshot()).sessions.find(s => s.id === ids[0])), original);
  await capture('reopened-sorted');
  const stats = (await fixture()).stats; assert.equal(stats.sends, 0); assert.equal(stats.inputs, 0);
  assert.equal((await snapshot()).diagnostics.dispatches, 0); assert.deepEqual(errors, []);
  checks.push('Actual metadata save failure preserves disk and UI, explicit retry works; reload and whole-app reopen retain sorted/collapsed state, draft and native identity with zero sends/inputs');
  console.log(JSON.stringify({ checks, errors, modelTasks: 0, nativeProcesses: 0, stats, profile, scriptSha256: createHash('sha256').update(fs.readFileSync(__filename)).digest('hex') }, null, 2));
}
run().catch(async error => { console.error(error.stack); if (page && !page.isClosed()) { await capture('failed'); if (process.env.NAW_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.NAW_EVIDENCE_DIR, 'failure.txt'), await page.locator('body').innerText()); } process.exitCode = 1; }).finally(testScratch.cleanup(async () => {
  // The two preseeded historical rows have no live runtime to stop. Terminate
  // only this owned synthetic daemon, rather than asking it to forget history.
  try { if (app) await app.close(); if (client) { await fixture('stop'); client.close(); } }
  finally { if (child.connected) child.disconnect(); if (child.exitCode === null) child.kill('SIGTERM'); }
}));
