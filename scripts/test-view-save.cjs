// Exercise disk-write failure and real window/app lifecycle without provider work.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { fork } = require('node:child_process'), { _electron } = require('playwright');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-view-save-')), file = path.join(profile, 'views.json');
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/native-progress.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: profile },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms)), checks = [], errors = [];
let app, page, second, client, sequence = 0;
async function until(fn, label) { for (let i = 0; i < 160; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method = 'stats') {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const cb = value => { if (value.requestId === id) { clearTimeout(timer); child.off('message', cb); value.error ? reject(Error(value.error)) : resolve(value); } };
    const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 8000);
    child.on('message', cb); child.send({ id, method });
  });
}
async function launch() {
  app = await _electron.launch({
    executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000,
  });
  page = await app.firstWindow(); await page.locator('#new-session').waitFor();
  await until(() => app.windows().length === 2, 'Two restored test windows');
  second = app.windows().find(p => p !== page); await second.locator('#new-session').waitFor();
  for (const p of [page, second]) { p.setDefaultTimeout(15000); p.on('pageerror', e => errors.push(e.message)); }
}
async function close() { if (app) { const previous = app; app = null; await previous.close(); } }
async function failWrites() {
  await app.evaluate(({ dialog }) => {
    const fs = process.getBuiltinModule('fs');
    global.viewSaveOriginalRename = fs.renameSync; global.viewSaveMainErrors = [];
    // Capture a regression without opening an OS error dialog over another Space.
    dialog.showErrorBox = (title, content) => global.viewSaveMainErrors.push({ title, content });
    fs.renameSync = (source, destination) => {
      if (String(destination).endsWith('/views.json')) throw Error('Synthetic view write failure');
      return global.viewSaveOriginalRename(source, destination);
    };
  });
}
async function restoreWrites() {
  if (app) await app.evaluate(() => {
    if (global.viewSaveOriginalRename) { process.getBuiltinModule('fs').renameSync = global.viewSaveOriginalRename; global.viewSaveOriginalRename = null; }
  });
}
async function screenshot(name) {
  if (!process.env.NAW_EVIDENCE_DIR) return;
  fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true, mode: 0o700 });
  await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png') });
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Fixture ready');
  client = await connect(profile, 'private-owner');
  const id = await client.call('create', { provider: 'codex', cwd: profile, name: '未保存草稿测试', view: 'chat' });
  await client.call('draft', id, '原来已保存的私人草稿');
  const originalNative = (await client.call('initial')).sessions[0].nativeId;
  fs.writeFileSync(file, JSON.stringify([
    { owner: 'shared-owner', active: true, selected: 'room', mode: 'chat', sharedDraft: '原来的共享草稿' },
    { owner: 'private-owner', active: true, selected: id, mode: 'chat' },
  ]), { mode: 0o600 });
  await launch();
  const before = fs.readFileSync(file, 'utf8'), uiHost = fs.readFileSync(path.join(profile, 'ui-host.json'), 'utf8');
  await app.evaluate(({ app }) => {
    const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
    const { WorkspaceClient } = load('./app/workspace-client.cjs'), call = WorkspaceClient.prototype.call;
    global.viewSaveHoldInitial = true;
    WorkspaceClient.prototype.call = async function (method, ...args) {
      const result = await call.call(this, method, ...args);
      if (method === 'initial' && result.owner === 'private-owner' && global.viewSaveHoldInitial) {
        global.viewSaveHoldInitial = false;
        return new Promise(resolve => { global.viewSaveReleaseInitial = () => resolve(result); });
      }
      return result;
    };
  });
  await second.reload();
  await until(() => app.evaluate(() => typeof global.viewSaveReleaseInitial === 'function'), 'Peer initial snapshot held');
  await failWrites();
  const shared = '新的共同工作草稿：磁盘失败时仍要保留', draft = '新的私人草稿：未发送';
  await page.locator('#shared-input').fill(shared);
  await page.locator('#alert').getByText('界面与草稿副本未能保存', { exact: false }).waitFor();
  await app.evaluate(() => global.viewSaveReleaseInitial());
  await second.locator('#retry-save').waitFor();
  await until(() => second.locator('#message-input').isVisible(), 'Peer initialization finishes');
  assert.equal(await second.locator('#alert').isVisible(), true); assert.deepEqual(errors, []);
  checks.push('Storage failure arriving before the peer initial snapshot is rendered safely and stays visible after that older snapshot arrives');
  await second.locator('#message-input').fill(draft);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const secondWindow = await app.browserWindow(second);
  await secondWindow.evaluate(win => { setTimeout(() => win.close(), 0); }); await delay(200);
  assert.equal(second.isClosed(), false);
  await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); }); await delay(200);
  assert.equal(app.windows().length, 2);
  assert.equal(await page.locator('#shared-input').inputValue(), shared);
  assert.equal(await second.locator('#message-input').inputValue(), draft);
  assert.equal(fs.readFileSync(path.join(profile, 'ui-host.json'), 'utf8'), uiHost);
  assert.deepEqual(await app.evaluate(() => global.viewSaveMainErrors), []);
  assert.equal((await second.evaluate(() => workspace.initial())).viewState.active, true);
  await screenshot('failed-quit-keeps-working-windows');
  checks.push('Failed save cancels both window close and application quit; both drafts, active windows and the existing UI host remain, without a main-process error dialog');

  await page.locator('#retry-save').click();
  await until(() => page.locator('#retry-save').isEnabled(), 'Failed retry returns control');
  assert.equal(await page.locator('#alert').isVisible(), true);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  await restoreWrites(); await page.locator('#retry-save').click();
  await until(() => page.locator('#alert').isHidden(), 'Shared save warning cleared');
  await until(() => second.locator('#alert').isHidden(), 'Peer save warning cleared');
  const saved = JSON.parse(fs.readFileSync(file));
  assert.equal(saved.find(v => v.owner === 'shared-owner').sharedDraft, shared);
  assert.equal(saved.find(v => v.owner === 'private-owner').draftBackups[id].text, draft);
  assert.ok(saved.every(v => v.active));
  assert.equal((await client.call('initial')).sessions[0].liveDraft, '原来已保存的私人草稿');
  checks.push('Explicit retry keeps failure visible until disk writes succeed; saves both views without silently replaying the unacknowledged private draft');

  await close(); await launch();
  assert.equal(await page.locator('#shared-input').inputValue(), shared);
  await second.locator('#draft-recovery > summary').click();
  assert.equal(await second.locator('#draft-recovery-text').inputValue(), draft);
  assert.equal(await second.locator('#message-input').inputValue(), '原来已保存的私人草稿');
  assert.equal((await client.call('initial')).sessions[0].nativeId, originalNative);
  checks.push('Normal quit/reopen restores both windows and the shared draft; unacknowledged private text is a recoverable copy beside the unchanged native draft');

  // Window storage can recover independently after the backend disappears.
  await failWrites(); await page.locator('#shared-input').fill(shared + '；断线时编辑');
  await page.locator('#retry-save').waitFor();
  await fixture('stop'); const stats = (await fixture()).stats;
  await client.call('shutdown'); client.close(); client = null;
  await until(() => child.exitCode !== null, 'Synthetic backend exits');
  await page.locator('#reconnect-button').waitFor();
  await restoreWrites(); await page.locator('#retry-save').click();
  await until(() => page.locator('#retry-save').isHidden(), 'Local save retry completes while disconnected');
  assert.equal(await page.locator('#reconnect-button').isVisible(), true);
  assert.equal(JSON.parse(fs.readFileSync(file)).find(v => v.owner === 'shared-owner').sharedDraft, shared + '；断线时编辑');
  assert.deepEqual(await app.evaluate(() => global.viewSaveMainErrors), []);
  await screenshot('local-save-recovered-while-disconnected');
  checks.push('Local view retry works after service disconnection, preserving the separate disconnected notice without a provider restart');
  assert.deepEqual(stats, { opens: 0, inputs: 0, resizes: 0, sends: 0 });
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() })));
  assert.ok(windows.length === 2 && windows.every(w => !w.visible && !w.focusable)); assert.deepEqual(errors, []);
  const closed = await app.browserWindow(second);
  await closed.evaluate(win => { setTimeout(() => win.close(), 0); });
  await until(() => second.isClosed(), 'Normal peer close works after saving');
  assert.equal(app.windows().length, 1);
  assert.equal(JSON.parse(fs.readFileSync(file)).find(v => v.owner === 'private-owner').active, false);
  assert.equal(await page.locator('#shared-input').inputValue(), shared + '；断线时编辑');
  checks.push('After storage recovers, closing one window succeeds and saves its inactive state without closing the other window');
  console.log(JSON.stringify({ checks, stats, errors, windows, modelTasks: 0 }, null, 2));
}
run().catch(async error => { console.error(error.stack); if (page && !page.isClosed()) await screenshot('failed'); process.exitCode = 1; }).finally(async () => {
  await restoreWrites(); await close();
  if (client) { await fixture('stop'); await client.call('shutdown'); client.close(); }
  if (child.connected) child.disconnect();
  await until(() => child.exitCode !== null, 'Owned fixture exits');
});
