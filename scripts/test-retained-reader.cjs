const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { fork } = require('node:child_process'), { _electron } = require('playwright');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connectService, connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-retained-reader-'));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/retained-reader.cjs')], env: { ...process.env, NAW_APP_VERSION: '0.1.0-alpha.2', NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let application, page, client, n = 0; const checks = [], errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method) { const id = ++n; return new Promise(resolve => { const receive = m => { if (m.id === id) { child.off('message', receive); resolve(m); } }; child.on('message', receive); child.send({ id, method }); }); }
async function launch() {
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await application.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
}
const snapshot = () => page.evaluate(() => workspace.initial());
(async () => {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Old service ready');
  client = await connectService(profile, 'fixture-owner');
  const id = await client.call('create', { provider: 'codex', cwd: profile, name: 'Retained Codex', view: 'chat' });
  const old = (await client.call('initial')).sessions[0]; assert.equal(old.messages.length, 0);
  await launch(); await page.locator(`[data-session-id="${id}"]`).click(); await page.locator('#chat-tab').click();
  if (await page.locator('#send-button').textContent() === '接管此窗口') await page.locator('#send-button').click();
  await until(async () => await page.locator('#send-button').textContent() === '接通原会话输入', 'Connect original session action');
  await page.locator('#send-button').click();
  await page.locator('#messages').getByText('Native terminal question', { exact: true }).waitFor();
  await page.locator('#messages').getByText('Native terminal answer', { exact: true }).waitFor();
  const connected = (await snapshot()).sessions.find(s => s.id === id);
  assert.equal(connected.model, 'synthetic-current-model'); assert.equal(connected.pid, old.pid); assert.equal(connected.nativeId, old.nativeId);
  assert.equal((await fixture('stats')).requests.filter(m => m === 'turn/start').length, 0);
  assert.equal(await page.locator('.native-progress').count(), 0);
  checks.push('Old empty portal reader imports original native history and current model without a new turn/process or camera pane');
  await page.locator('#message-input').fill('New GUI question'); await page.locator('#send-button').click();
  await page.locator('#messages').getByText('New GUI question', { exact: true }).waitFor();
  await page.locator('#messages').getByText('Live reply from original session', { exact: true }).waitFor();
  await page.locator('#messages').getByText('Native intermediate tool output', { exact: true }).waitFor();
  assert.equal(await page.locator('#messages').getByText('Native intermediate tool output', { exact: true }).count(), 1);
  await page.locator('#message-input').fill('Unsent draft'); await fixture('finish');
  await page.locator('#messages').getByText('Live reply from original session completed', { exact: true }).waitFor();
  assert.equal((await snapshot()).sessions.find(s => s.id === id).messages.filter(m => m.id === 'gui-answer').length, 1);
  assert.equal(await page.locator('#message-input').inputValue(), 'Unsent draft');
  assert.equal((await fixture('stats')).requests.filter(m => m === 'turn/start').length, 1);
  checks.push('Graphical input is visible once, live native output updates its block, draft remains, one explicit native dispatch');
  assert.equal(await page.locator('#toast').isVisible(), false, 'No unexpected interface error');
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'retained-reader.png') }); }
  await application.close(); application = null; await launch();
  await page.locator('#messages').getByText('Native terminal answer', { exact: true }).waitFor();
  await page.locator('#messages').getByText('Live reply from original session completed', { exact: true }).waitFor();
  assert.equal(await page.locator('#message-input').inputValue(), 'Unsent draft');
  assert.equal((await fixture('stats')).requests.filter(m => m === 'turn/start').length, 1);
  checks.push('Reopening restores the same subscription and draft without resending');
  assert.deepEqual(errors, []); console.log(JSON.stringify({ checks, errors, modelCalls: 0, profile }));
})().catch(async error => { if (page && !page.isClosed()) fs.writeFileSync(path.join(profile, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); console.error(error.stack, profile); process.exitCode = 1; }).finally(async () => {
  if (application) await application.close(); client?.close();
  const cleanup = await connect(profile, 'cleanup');
  for (const s of (await cleanup.call('initial')).sessions) await cleanup.call('stop', s.id);
  for (const entry of cleanup.entries) await entry.client.call('shutdown'); cleanup.close();
  if (child.connected) child.disconnect();
});
