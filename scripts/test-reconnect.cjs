const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { fork } = require('node:child_process'), { _electron } = require('playwright');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-reconnect-ui-'));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/reconnect-native.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms)), checks = [], errors = [];
let app, page, client, sequence = 0;
async function until(fn, label) { for (let i = 0; i < 160; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value) { const id = ++sequence; return new Promise((resolve, reject) => {
  const callback = result => { if (result.requestId === id) { clearTimeout(timer); child.off('message', callback); resolve(result); } };
  const timer = setTimeout(() => { child.off('message', callback); reject(Error('Fixture timeout')); }, 8000);
  child.on('message', callback); child.send({ id, method, target, value });
}); }
const snapshot = () => page.evaluate(() => workspace.initial());
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Service ready'); client = await connect(profile, 'test-observer');
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor();
  await app.evaluate(({ dialog }) => { globalThis.dialogs = []; globalThis.choice = 0; dialog.showMessageBox = async (_w, options) => { globalThis.dialogs.push(options); return { response: globalThis.choice }; }; });
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check();
  await page.locator('#initial-view').selectOption('chat'); await page.locator('#session-name').fill('恢复原会话'); await page.locator('#confirm-create').click();
  await until(async () => (await snapshot()).sessions[0]?.state === 'idle', 'Ready');
  const original = (await snapshot()).sessions[0], id = original.id;
  await fixture('history', id); await page.locator('#messages').getByText('保留的原生历史', { exact: true }).waitFor();
  await page.locator('#message-input').fill('私有草稿：断开后保留');
  await page.locator('#advanced > summary').click(); await page.getByRole('button', { name: '断开本应用连接…', exact: true }).click();
  assert.equal((await snapshot()).sessions[0].state, 'idle');
  await app.evaluate(() => { globalThis.choice = 1; });
  await page.getByRole('button', { name: '断开本应用连接…', exact: true }).click();
  await page.getByRole('button', { name: '继续原生会话', exact: true }).waitFor();
  assert.equal((await snapshot()).sessions[0].state, 'disconnected');
  await page.locator('.progress-notice').getByText('连接已断开', { exact: false }).waitFor();
  assert.equal(await page.locator('#message-input').inputValue(), '私有草稿：断开后保留');
  checks.push('Cancel disconnect preserves live session; confirmed disconnect exposes continuation and preserves draft');
  await app.evaluate(() => { globalThis.choice = 0; });
  await page.getByRole('button', { name: '继续原生会话', exact: true }).click();
  assert.equal((await snapshot()).sessions[0].state, 'disconnected');
  await app.evaluate(() => { globalThis.choice = 1; }); await fixture('fail', id, true);
  await page.getByRole('button', { name: '继续原生会话', exact: true }).click();
  await page.locator('#toast').getByText('Synthetic connection interruption', { exact: true }).waitFor();
  await page.getByRole('button', { name: '继续原生会话', exact: true }).waitFor();
  await fixture('fail', id, false); await page.getByRole('button', { name: '继续原生会话', exact: true }).click();
  await until(async () => (await snapshot()).sessions[0].state === 'idle', 'Reconnected');
  const current = (await snapshot()).sessions[0];
  assert.equal(current.id, id); assert.equal(current.nativeId, original.nativeId); assert.equal(current.messages.length, 1);
  assert.equal(current.messages[0].text, '保留的原生历史'); assert.equal(await page.locator('#message-input').inputValue(), '私有草稿：断开后保留');
  checks.push('Cancel reconnect is inert; failed reconnect remains retryable; successful retry preserves exact identity/history/draft');
  await page.locator('#terminal-tab').click(); await page.locator('#terminal-area .xterm-screen').waitFor();
  await page.locator('#chat-tab').click(); assert.equal(await page.locator('#message-input').inputValue(), '私有草稿：断开后保留');
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'reconnect-retry.png') }); }
  const calls = (await fixture('inspect')).calls;
  assert.equal(calls.filter(c => c.method === 'thread/start').length, 1);
  assert.ok(calls.filter(c => c.method === 'thread/resume').every(c => Object.keys(c.params).sort().join(',') === 'excludeTurns,threadId'));
  assert.equal(calls.some(c => c.method === 'turn/start'), false);
  assert.equal((await snapshot()).diagnostics.dispatches, 0); assert.deepEqual(errors, []);
  checks.push('Native view toggle retains same thread; reconnection has no settings overrides, duplicate thread creation, or model send');
  console.log(JSON.stringify({ checks, errors, modelTasks: 0, nativeProcesses: 0, profile }, null, 2));
}
run().catch(async e => { console.error(e.stack); process.exitCode = 1; }).finally(async () => {
  if (app) await app.close(); client?.close(); if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
});
