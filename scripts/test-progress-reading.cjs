// Actual Electron navigation with controlled native events; no model calls.
// This replaces the retired terminal-camera/replay reading test.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { fork } = require('node:child_process');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-inline-reading-'));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/native-progress.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let application, page, sequence = 0;
const errors = [], checks = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value) { const id = ++sequence; return new Promise((resolve, reject) => {
  const callback = result => { if (result.requestId === id) { clearTimeout(timer); child.off('message', callback); result.error ? reject(Error(result.error)) : resolve(result); } };
  const timer = setTimeout(() => { child.off('message', callback); reject(Error('Fixture timeout')); }, 10000);
  child.on('message', callback); child.send({ id, method, target, value });
}); }
const snapshot = () => page.evaluate(() => workspace.initial());
async function create(name) {
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check();
  await page.locator('#initial-view').selectOption('chat'); await page.locator('#session-name').fill(name); await page.locator('#confirm-create').click();
  await until(async () => (await snapshot()).sessions.some(s => s.name === name), 'Session created');
  return (await snapshot()).sessions.find(s => s.name === name).id;
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Daemon');
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await application.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  const a = await create('Reading A'), b = await create('Reading B');
  const text = Array.from({ length: 100 }, (_, i) => `Result line ${i}: local output`).join('\n');
  await fixture('nativeBlock', a, { id: 'tool:read', kind: 'tool', turnId: 'a', title: 'Read', input: 'fixture.txt', text, status: 'complete' });
  await fixture('nativeBlock', b, { id: 'tool:read', kind: 'tool', turnId: 'b', title: 'Read', text: 'Other session result', status: 'complete' });
  await page.locator(`[data-session-id="${a}"]`).click();
  const result = page.locator('#messages .message.tool'); await result.locator('.message-body').waitFor();
  assert.match(await result.innerText(), /Result line 0/); assert.equal(await page.locator('.native-progress').count(), 0);
  await page.locator('#messages').hover(); await page.mouse.wheel(0, -1000000); await delay(100); await page.mouse.wheel(0, 260); await delay(200);
  const position = await page.locator('#messages').evaluate(el => el.scrollTop); assert.ok(position > 100);
  await page.locator('#message-input').fill('Unsent private draft');
  await page.locator(`[data-session-id="${b}"]`).click(); assert.match(await page.locator('#messages').innerText(), /Other session result/);
  await page.locator(`[data-session-id="${a}"]`).click(); await delay(150);
  assert.ok(Math.abs(await page.locator('#messages').evaluate(el => el.scrollTop) - position) < 3);
  assert.equal(await page.locator('#message-input').inputValue(), 'Unsent private draft');
  checks.push('Native tool body/input use the main reader; session switch retains draft and reading position');
  await page.locator('#terminal-tab').click(); await page.locator('#chat-tab').click(); await delay(150);
  assert.ok(Math.abs(await page.locator('#messages').evaluate(el => el.scrollTop) - position) < 3);
  await page.getByRole('button', { name: '加入协作', exact: true }).click(); await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  assert.ok(!(await page.locator('#room-messages').innerText()).includes('Result line'));
  await page.locator(`[data-session-id="${a}"]`).click(); await page.getByRole('button', { name: '脱出协作', exact: true }).click();
  assert.equal((await snapshot()).sessions.find(s => s.id === a).messages.find(m => m.kind === 'tool').text, text);
  checks.push('GUI/TUI switching and joining/leaving preserve private original content without sharing it');
  await fixture('legacyService', b); await fixture('progress', b, { id: 'legacy-read', source: 'claude-native-message', kind: 'tool-output', title: 'Legacy Read', status: 'observed', text: 'Retained backend output' });
  await page.locator(`[data-session-id="${b}"]`).click();
  await page.locator('#messages').getByText('Retained backend output', { exact: true }).waitFor();
  await fixture('progress', b, { id: 'legacy-read', source: 'claude-native-message', kind: 'tool-output', text: 'Retained backend live update' });
  await page.locator('#messages').getByText('Retained backend live update', { exact: true }).waitFor();
  assert.equal(await page.locator('#messages [data-message-id="legacy-observation:legacy-read"]').count(), 1);
  checks.push('Retained service progress snapshot and live updates remain readable inline without a camera panel');
  await fixture('progress', b, { id: 'legacy-read', source: 'claude-native-message', kind: 'tool-output', status: 'running', text: 'Last received running output' });
  await page.locator('#messages').getByText('Last received running output', { exact: true }).waitFor();
  await fixture('state', b, 'disconnected');
  await page.locator('#messages').getByText('连接状态尚未确认。保留最后收到的过程记录，当前运行情况未知。', { exact: true }).waitFor();
  await fixture('progress', b, { id: 'legacy-read', source: 'claude-native-message', kind: 'tool-output', status: 'running', text: 'Late disconnected event' });
  assert.match(await page.locator('#messages').innerText(), /Last received running output/);
  assert.ok(!(await page.locator('#messages').innerText()).includes('Late disconnected event'));
  await fixture('state', b, 'idle');
  await page.locator('#messages').getByText('Late disconnected event', { exact: true }).waitFor();
  checks.push('Retained connection loss freezes last records and ignores late live output; reconnection reloads native observations');
  assert.deepEqual(errors, []); const stats = (await fixture('stats')).stats; assert.equal(stats.sends, 0);
  console.log(JSON.stringify({ checks, errors, modelCalls: 0, stats, profile }, null, 2));
}
run().catch(async e => { if (page && !page.isClosed()) { await page.screenshot({ path: path.join(profile, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(profile, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); } console.error(e.stack); process.exitCode = 1; }).finally(async () => { if (application) await application.close(); if (child.exitCode === null) { await fixture('stop'); child.kill('SIGTERM'); } });
