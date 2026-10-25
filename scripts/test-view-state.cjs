const testScratch = require('./fixtures/test-scratch.cjs');
// Real isolated Electron startup/retry/quit with damaged synthetic local data.
// No provider process, model call, system clipboard or foreground window.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { fork } = testScratch.childProcess, { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-view-state-ui-')), file = path.join(profile, 'views.json');
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/native-progress.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: profile },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms)), checks = [], errors = [];
let app, page, client, otherClient, sequence = 0;
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
  assert.ok(!app);
  app = await _electron.launch({
    executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000,
  });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
}
async function close() { if (app) { const previous = app; app = null; await previous.close(); } }
async function shot(name) {
  if (process.env.NAW_EVIDENCE_DIR) {
    fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true, mode: 0o700 });
    await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png') });
  }
}
async function blocked() {
  await page.locator('#detail').getByText('界面记录无法读取', { exact: false }).waitFor();
  assert.equal(await page.locator('#retry').isEnabled(), true);
  assert.equal(await page.locator('#data').isVisible(), true);
  assert.equal(await page.locator('#new-session').count(), 0);
  assert.equal(app.windows().length, 1);
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Fixture service');
  client = await connect(profile, 'saved-view-owner');
  const id = await client.call('create', { provider: 'claude', cwd: profile, name: '恢复界面测试', view: 'chat' });
  otherClient = await connect(profile, 'other-saved-owner');
  const otherId = await otherClient.call('create', { provider: 'codex', cwd: profile, name: '另一个窗口', view: 'chat' });
  const draft = '保存的私人草稿，不发送', shared = '保存的共同工作草稿';
  await client.call('draft', id, draft);
  const baseline = (await client.call('initial')).sessions.find(s => s.id === id);
  const otherDraft = '第二个窗口自己的草稿';
  await otherClient.call('draft', otherId, otherDraft);
  const views = [{
    owner: 'saved-view-owner', selected: id, active: true, mode: 'chat', preference: 'chat',
    bounds: { x: 60, y: 60, width: 1100, height: 800 }, sharedDraft: shared,
    draft: { id, text: draft }, draftBackups: { [id]: { text: draft, acknowledged: true, recoveries: ['必须保留的合成恢复副本'] } },
  }, {
    owner: 'other-saved-owner', selected: otherId, active: true, mode: 'chat', preference: 'chat',
    bounds: { x: 100, y: 100, width: 1000, height: 700 }, draft: { id: otherId, text: otherDraft },
  }];
  const connection = fs.readFileSync(path.join(profile, 'connection.json'), 'utf8');
  const valid = JSON.stringify(views), damaged = valid.slice(0, -1);
  fs.writeFileSync(file, damaged, { mode: 0o600 });
  await launch(); await blocked(); assert.equal(fs.readFileSync(file, 'utf8'), damaged);
  // Inspect the actual button route without opening Finder or changing Spaces.
  await app.evaluate(({ shell }) => { global.viewStateOpenedPaths = []; shell.openPath = async p => { global.viewStateOpenedPaths.push(p); return ''; }; });
  await page.locator('#data').click();
  assert.deepEqual(await app.evaluate(() => global.viewStateOpenedPaths), [profile]);
  await page.locator('#retry').click(); await blocked();
  assert.equal(fs.readFileSync(file, 'utf8'), damaged);
  await shot('damaged-record-retained'); await close();
  assert.equal(fs.readFileSync(file, 'utf8'), damaged);
  assert.equal(fs.readFileSync(path.join(profile, 'connection.json'), 'utf8'), connection);
  assert.equal(fs.existsSync(path.join(profile, 'dsh')), false);
  checks.push('Damaged startup, repeated Retry and Quit retain every original byte; guarded data-folder button routes only to the isolated profile');

  fs.chmodSync(file, 0o000);
  await launch(); await blocked(); await shot('unreadable-record-retained');
  await close(); fs.chmodSync(file, 0o600);
  assert.equal(fs.readFileSync(file, 'utf8'), damaged);
  assert.equal((await client.call('initial')).sessions.find(s => s.id === id).nativeId, baseline.nativeId);
  checks.push('Actual filesystem read denial also blocks blank writes; native fixture identity and draft remain available');

  await launch(); await blocked();
  fs.writeFileSync(file, valid, { mode: 0o600 }); // Explicit restoration of the known-good synthetic backup.
  await page.locator('#retry').click(); await page.locator('#new-session').waitFor();
  await until(async () => await page.locator('#message-input').inputValue() === draft, 'Draft restored');
  const state = await page.evaluate(() => workspace.initial());
  assert.equal(state.sessions.length, 2);
  assert.equal(state.sessions.find(s => s.id === id).nativeId, baseline.nativeId);
  assert.equal(state.viewState.sharedDraft, shared);
  assert.deepEqual(state.viewState.draftBackups[id].recoveries, ['必须保留的合成恢复副本']);
  await until(() => app.windows().length === 2, 'Second saved window restored');
  const otherPage = app.windows().find(p => p !== page);
  await otherPage.locator('#new-session').waitFor();
  await until(async () => await otherPage.locator('#message-input').inputValue() === otherDraft, 'Legacy second-window draft restored');
  assert.equal((await otherPage.evaluate(() => workspace.initial())).viewState.selected, otherId);
  await page.locator('#draft-recovery > summary').click();
  assert.equal(await page.locator('#draft-recovery-text').inputValue(), '必须保留的合成恢复副本');
  await shot('explicit-retry-restored');
  const edited = draft + '；恢复后继续编辑';
  await page.locator('#message-input').fill(edited);
  await until(async () => (await client.call('initial')).sessions.find(s => s.id === id).liveDraft === edited, 'Post-retry draft persisted');
  await close(); await launch(); await page.locator('#new-session').waitFor();
  await until(async () => await page.locator('#message-input').inputValue() === edited, 'Edited draft reopened');
  assert.equal((await page.evaluate(() => workspace.initial())).viewState.sharedDraft, shared);
  await shot('reopened-with-drafts');
  await until(() => app.windows().length === 2, 'Both windows reopened');
  const reopenedOther = app.windows().find(p => p !== page);
  await reopenedOther.locator('#new-session').waitFor();
  await until(async () => await reopenedOther.locator('#message-input').inputValue() === otherDraft, 'Second draft reopened');
  checks.push('Explicit retry after backup restoration resumes two windows, the same native identities and selected chats, legacy/independent drafts and recovery copies; subsequent edit and reopen preserve them');

  const stats = (await fixture()).stats;
  assert.deepEqual(stats, { opens: 0, inputs: 0, resizes: 0, sends: 0 });
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() })));
  assert.deepEqual(windows, [{ visible: false, focusable: false }, { visible: false, focusable: false }]); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, stats, windows, errors, modelTasks: 0 }, null, 2));
}
run().catch(async error => { console.error(error.stack); if (page && !page.isClosed()) await shot('failed'); process.exitCode = 1; }).finally(testScratch.cleanup(async () => {
  if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
  await close();
  if (client) { await fixture('stop'); await client.call('shutdown'); client.close(); }
  otherClient?.close();
  if (child.connected) child.disconnect();
  await until(() => child.exitCode !== null, 'Owned test daemon exits');
}));
