const testScratch = require('./fixtures/test-scratch.cjs');
// The person, 2026-11-13: sessions the butler had created in the background read 「另一个窗口控制」, and
// their composer and terminal stayed locked until 「接管此窗口」 was pressed, with no other window open.
// Hidden real Electron windows, IPC and service; synthetic native transport, no provider process or model.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { fork } = testScratch.childProcess, { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-pageless-owner-'));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/native-progress.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
let app, client, background, sequence = 0;
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
async function ready(page) { page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message)); await page.locator('#new-session').waitFor(); }
const owner = page => page.evaluate(() => workspace.initial().then(s => s.owner));
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Daemon ready');
  client = await connect(profile, 'pageless-observer');
  // As the butler's background operations and the queue dispatcher do: a connection with no window.
  background = await connect(profile, 'background-request-window', { page: false });
  const id = await background.call('create', { provider: 'codex', cwd: profile, name: '后台创建的会话', view: 'chat' });
  const session = async () => (await client.call('initial')).sessions.find(s => s.id === id);
  await until(async () => (await session())?.state === 'idle', 'Created in the background');
  const control = (await session()).controlRevision || 0;
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  const a = await app.firstWindow(); await ready(a);
  const input = page => page.locator('#message-input'), claim = page => page.locator('#take-control');
  await a.locator(`[data-session-id="${id}"]`).click(); await a.locator('#chat-tab').click();
  await until(async () => (await session()).owner === await owner(a), 'The one open window holds the session');
  await until(async () => !(await input(a).evaluate(el => el.readOnly)), 'Composer editable');
  assert.equal(await claim(a).isVisible(), false, 'No 接管此窗口 with one window open');
  assert.doesNotMatch(await a.locator('#session-status').innerText(), /另一个窗口控制/);
  await input(a).fill('直接就能写');
  await until(async () => (await session()).liveDraft === '直接就能写', 'Draft reaches the service');
  checks.push('One open window types into a session created in the background without a takeover');
  await a.locator('#terminal-tab').click();
  const terminal = a.locator('#terminal-area .xterm-helper-textarea');
  await a.locator('#terminal-area .xterm-screen:visible').waitFor();
  await until(async () => (await session()).view === 'terminal', 'Terminal view');
  assert.equal((await session()).controlRevision || 0, control, 'Nothing was taken over');
  const before = (await fixture()).stats.inputs;
  await terminal.focus(); await a.keyboard.press('ArrowDown');
  await until(async () => (await fixture()).stats.inputs > before, 'The terminal key reaches the native session');
  // A key the person presses in the native terminal pauses automation and bumps the revision itself (as before).
  const typed = (await session()).controlRevision;
  assert.equal((await session()).owner, await owner(a));
  checks.push('Its terminal takes keys without a takeover');
  // A Claude session the butler opens in its terminal, where a first prompt (folder trust) waits for the person.
  const terminalId = await background.call('create', { provider: 'claude', cwd: profile, name: '后台创建的终端会话', view: 'terminal' });
  const terminalSession = async () => (await client.call('initial')).sessions.find(s => s.id === terminalId);
  await until(async () => ['starting', 'idle'].includes((await terminalSession())?.state), 'Terminal session created');
  await a.locator(`[data-session-id="${terminalId}"]`).click();
  await until(async () => (await terminalSession()).owner === await owner(a), 'The open window holds the terminal session');
  assert.equal(await claim(a).isVisible(), false);
  await a.locator('#terminal-area .xterm-screen:visible').waitFor();
  const keys = (await fixture()).stats.inputs;
  await terminal.focus(); await a.keyboard.press('ArrowDown');
  await until(async () => (await fixture()).stats.inputs > keys, 'The key reaches the Claude terminal');
  checks.push('A Claude session created in its terminal in the background takes keys in the one open window');
  await a.locator(`[data-session-id="${id}"]`).click(); await a.locator('#chat-tab').click();

  const opened = app.waitForEvent('window');
  await a.locator(`[data-session-menu="${id}"]`).click();
  await a.getByRole('menuitem', { name: '在独立窗口打开', exact: true }).click();
  const b = await opened; await ready(b);
  await claim(b).waitFor({ state: 'visible' });
  assert.equal(await input(b).evaluate(el => el.readOnly), true, 'Second window waits for a takeover');
  await claim(b).click();
  await until(async () => (await session()).owner === await owner(b), 'Second window takes over');
  assert.equal((await session()).controlRevision, typed + 1);
  await claim(a).waitFor({ state: 'visible' });
  checks.push('With two windows open, the other one still needs 接管此窗口');

  // The person closes the second window: it holds nothing against the open one.
  await (await app.browserWindow(b)).evaluate(win => win.close());
  await until(async () => (await session()).owner === await owner(a), 'The open window holds it again');
  await until(async () => !(await input(a).evaluate(el => el.readOnly)), 'Composer editable again');
  assert.equal(await claim(a).isVisible(), false);
  assert.equal((await session()).controlRevision, typed + 1, 'Getting it back is not another takeover');
  await input(a).fill('关掉另一个窗口后继续写');
  await until(async () => (await session()).liveDraft === '关掉另一个窗口后继续写', 'Draft after the close');
  checks.push('After the second window closes, the open one has the session again without a takeover');

  const stats = (await fixture()).stats;
  assert.equal(stats.sends, 0); assert.deepEqual(errors, []);
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() })));
  assert.deepEqual(windows, [{ visible: false, focusable: false }]);
  console.log(JSON.stringify({ checks, stats, errors, windows, nativeProcesses: 0, modelTasks: 0 }, null, 2));
}
run().catch(async error => { console.error(error.stack); process.exitCode = 1; }).finally(testScratch.cleanup(async () => {
  if (app) await app.close();
  if (background) background.close();
  if (client) { await fixture('stop'); await client.call('shutdown'); client.close(); }
  if (child.connected) child.disconnect();
  await until(() => child.exitCode !== null, 'Owned fixture exits');
}));
