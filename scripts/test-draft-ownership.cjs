const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// Hidden real Electron windows/IPC/service; synthetic transport, no model tasks.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { fork } = testScratch.childProcess;
const { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-draft-owner-'));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/delayed-native.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
const errors = [], observations = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, client;
async function until(fn, label) { for (let i = 0; i < 150; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
const snapshot = page => page.evaluate(() => workspace.initial());
async function ready(page) { page.on('pageerror', error => errors.push(error.message)); await page.locator('#new-session').waitFor(); }
async function launch() {
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  const page = await app.firstWindow(); await ready(page); return page;
}
async function run() {
  console.log('Synthetic profile:', profile);
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Fixture service');
  client = await connect(profile, 'draft-owner-observer');
  const a = await launch();
  await a.locator('#new-session').click(); await a.locator('input[name="provider"][value="codex"]').check();
  await a.locator('#session-name').fill('草稿连续性'); await createIn(a, 'chat');
  await until(async () => (await snapshot(a)).sessions[0]?.state === 'idle', 'Created');
  const id = (await snapshot(a)).sessions[0].id;
  const input = page => page.locator('#message-input');
  const serviceDraft = async () => (await client.call('initial')).sessions.find(s => s.id === id).liveDraft;
  async function edit(page, text) { await input(page).fill(text); await until(async () => await serviceDraft() === text, 'Draft persisted'); }
  async function takeover(page) {
    await page.locator('#send-button').getByText('接管此窗口', { exact: true }).click();
    await until(async () => { const s = await snapshot(page); return s.sessions.find(x => x.id === id).owner === s.owner; }, 'Explicit takeover');
    await until(async () => !(await input(page).evaluate(el => el.readOnly)), 'Editable after takeover');
  }
  const older = '窗口 A 原先的草稿', newer = '窗口 B 后来修改的草稿';
  await edit(a, older);
  const opened = app.waitForEvent('window');
  await a.locator(`[data-session-menu="${id}"]`).click();
  await a.getByRole('menuitem', { name: '在独立窗口打开', exact: true }).click();
  const b = await opened; await ready(b); assert.equal(await input(b).inputValue(), older);
  await takeover(b); await edit(b, newer);
  await until(async () => await input(a).evaluate(el => el.readOnly), 'A becomes observer');
  await takeover(a);
  observations.push({ check: 'takeover uses the latest session draft', actual: await input(a).inputValue(), expected: newer });
  // Give the service's real state broadcast time to settle; it must not be
  // dependent on a test-issued uiReady call or an artificial draft write.
  await delay(200);
  await a.reload(); await ready(a);
  await until(async () => (await snapshot(a)).viewState.selected === id, 'Restored selection');
  await delay(200);
  observations.push({ check: 'reload never writes an obsolete window copy over the session', actual: await serviceDraft(), expected: newer });
  observations.push({ check: 'reloaded composer displays the current draft', actual: await input(a).inputValue(), expected: newer });
  await takeover(b);
  const rejected = '窗口 A 尚未保存的文字';
  const error = await a.evaluate(async ({ id, text }) => { try { await workspace.draft(id, text); return ''; } catch (error) { return error.message; } }, { id, text: rejected });
  assert.match(error, /另一窗口控制/);
  assert.equal(await serviceDraft(), newer, 'Old owner cannot overwrite the current draft');
  await a.reload(); await ready(a);
  await a.locator('#draft-recovery').waitFor();
  await a.locator('#draft-recovery summary').click();
  observations.push({ check: 'rejected draft remains copyable after reload', actual: await a.locator('#draft-recovery-text').inputValue(), expected: rejected });
  assert.equal(await a.locator('#draft-recovery-text').evaluate(el => el.readOnly), true);
  assert.equal(await input(a).inputValue(), newer, 'Recovery never replaces the live composer');
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true, mode: 0o700 }); await a.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'draft-owner.png') }); }
  const ownerA = (await snapshot(a)).owner;
  await app.close(); app = null;
  // Simulate a pre-upgrade window record. Migration must preserve its copy
  // without inventing an acknowledgement or writing it into the live session.
  const file = path.join(profile, 'views.json'), views = JSON.parse(fs.readFileSync(file));
  delete views.find(v => v.owner === ownerA).draftBackups;
  fs.writeFileSync(file, JSON.stringify(views), { mode: 0o600 });
  const restored = await launch();
  await until(async () => (await snapshot(restored)).viewState.selected === id, 'Real UI restore');
  assert.equal((await snapshot(restored)).owner, ownerA);
  await restored.locator('#draft-recovery').waitFor();
  observations.push({ check: 'legacy backup survives full UI restart without replay', actual: await restored.locator('#draft-recovery-text').inputValue(), expected: rejected });
  assert.equal(await serviceDraft(), newer); assert.equal(await input(restored).inputValue(), newer);
  await until(() => app.windows().length === 2, 'Both intentional windows restored');
  await takeover(restored); await edit(restored, '接管后继续写的新草稿');
  await restored.reload(); await ready(restored); await delay(200);
  observations.push({ check: 'unresolved recovery survives ordinary editing and another reload', actual: await restored.locator('#draft-recovery-text').inputValue(), expected: rejected });
  await restored.locator('#draft-recovery summary').click();
  await restored.getByRole('button', { name: '删除此副本', exact: true }).click();
  await restored.locator('#draft-recovery').waitFor({ state: 'hidden' });
  await restored.reload(); await ready(restored); await delay(200);
  assert.equal(await restored.locator('#draft-recovery').isVisible(), false, 'Explicitly deleted recovery stays deleted');
  assert.equal(await input(restored).inputValue(), '接管后继续写的新草稿');
  observations.push({ check: 'explicit recovery deletion leaves the current draft untouched', actual: await serviceDraft(), expected: '接管后继续写的新草稿' });
  // Hold only the successful response, after the real service accepted the
  // draft. A competing window can now replace it before the writer sees ACK.
  const peer = app.windows().find(page => page !== restored); await ready(peer);
  await app.evaluate(({ app }) => {
    const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
    const { ServiceClient } = load('./app/service-client.cjs');
    const call = ServiceClient.prototype.call;
    ServiceClient.prototype.call = async function (method, ...args) {
      const result = await call.call(this, method, ...args);
      if (method === 'draft' && args[1] === '已保存但确认延迟的草稿') {
        await new Promise(resolve => { globalThis.releaseDraftAck = resolve; });
      }
      return result;
    };
  });
  const accepted = '已保存但确认延迟的草稿';
  await edit(restored, accepted);
  await until(() => app.evaluate(() => typeof globalThis.releaseDraftAck === 'function'), 'Successful draft response held');
  await takeover(peer); await edit(peer, '另一窗口的新正文');
  await restored.locator('#draft-recovery').waitFor();
  assert.equal(await restored.locator('#draft-recovery-text').inputValue(), accepted);
  await app.evaluate(() => globalThis.releaseDraftAck());
  await takeover(restored); await edit(restored, '确认返回后继续编辑');
  await restored.reload(); await ready(restored); await delay(200);
  const savedCopies = await restored.locator('.draft-recovery-text').evaluateAll(items => items.map(el => el.value));
  observations.push({ check: 'accepted draft with delayed ACK remains recoverable after competing edit and reload', actual: savedCopies.includes(accepted), expected: true });
  await app.evaluate(() => { globalThis.releaseDraftAck = null; });
  await edit(restored, accepted);
  await until(() => app.evaluate(() => typeof globalThis.releaseDraftAck === 'function'), 'Second successful response held');
  await takeover(peer); await edit(peer, '保留当前正文');
  await restored.locator('#draft-recovery summary').click();
  await restored.getByRole('button', { name: '删除此副本', exact: true }).click();
  await restored.locator('#draft-recovery').waitFor({ state: 'hidden' });
  await edit(peer, '副本删除后另一窗口再次编辑');
  await until(async () => await input(restored).inputValue() === '副本删除后另一窗口再次编辑', 'Fresh broadcast before ACK');
  await delay(200);
  observations.push({ check: 'fresh state while ACK is still held respects recovery deletion', actual: await restored.locator('#draft-recovery').isVisible(), expected: false });
  await app.evaluate(() => globalThis.releaseDraftAck());
  await takeover(restored); await edit(restored, '删除副本后继续编辑');
  await restored.reload(); await ready(restored); await delay(200);
  observations.push({ check: 'late successful save cannot revive an explicitly deleted recovery', actual: await restored.locator('#draft-recovery').isVisible(), expected: false });
  const windowStates = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() })));
  assert.equal(windowStates.length, 2); assert.ok(windowStates.every(w => !w.visible && !w.focusable));
  const dispatches = (await client.call('initial')).diagnostics.dispatches;
  assert.equal(dispatches, 0);
  console.log(JSON.stringify({ observations, errors, windows: windowStates, dispatches, modelTasks: 0 }));
  for (const check of observations) assert.equal(check.actual, check.expected, check.check);
  assert.deepEqual(errors, []);
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(testScratch.cleanup(async () => {
  try {
    if (app) await app.close();
    if (client) { const s = await client.call('initial'); for (const record of s.sessions) await client.call('stop', record.id); await client.call('shutdown'); client.close(); }
  } finally { if (child.connected) child.disconnect(); if (child.exitCode === null) child.kill('SIGTERM'); }
}));
