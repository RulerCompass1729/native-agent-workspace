// Actual product UI and service with synthetic handshakes; no native/model tasks.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { fork } = require('node:child_process');
const { _electron } = require('playwright');
const { chooseRecipient, fillRoomMessage, roomBody } = require('./room-input.cjs');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-native-version-'));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: profile }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let app, page, client, sequence = 0; const errors = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) { for (let n = 0; n < 160; n++) { if (await fn()) return; await sleep(50); } throw Error(label); }
const snapshot = () => page.evaluate(() => workspace.initial());
function fixture(method, target, value) { const id = ++sequence; return new Promise((resolve, reject) => {
  const cb = m => { if (m.requestId === id) { clearTimeout(timer); child.off('message', cb); resolve(m); } };
  const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 10000);
  child.on('message', cb); child.send({ id, method, target, value });
}); }
async function create(provider, name) {
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#initial-view').selectOption('chat'); await page.locator('#session-name').fill(name); await page.locator('#confirm-create').click();
  await until(async () => (await snapshot()).sessions.some(s => s.name === name && s.state === 'idle'), 'Session ready');
  const s = (await snapshot()).sessions.find(s => s.name === name);
  await page.getByRole('button', { name: '加入协作', exact: true }).click(); return s.id;
}
(async () => {
  console.log('Evidence:', profile);
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Private service ready');
  client = await connect(profile, 'version-test-observer');
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor();
  const a = await create('claude', 'A'), b = await create('codex', 'B');
  await page.locator('#room-nav').click(); await page.locator(`[data-room-session="${b}"]`).click();
  await chooseRecipient(page, a); await fillRoomMessage(page, 'Keep the draft addressed to A.');
  for (const version of ['0.163.0', '0.164.0']) {
    await fixture('native-version', b, { version });
    await until(async () => (await snapshot()).sessions.find(s => s.id === b).nativeVersion === version, 'Running handshake visible');
    await until(async () => (await page.locator('#session-status').getAttribute('title')).includes(`Codex ${version} · 核心接口已验证`), 'Verified running handshake rendered');
    assert.ok(!(await page.locator('#session-status').innerText()).includes('尚未验证'));
    assert.match(await page.locator('#session-status').getAttribute('title'), /核心接口已验证/);
  }
  await fixture('native-version', b, { version: '0.165.0' });
  await until(async () => (await page.locator('#session-status').innerText()).includes('Codex 0.165.0 尚未验证'), 'Unverified running version is explicit');
  assert.match(await page.locator('#session-status').getAttribute('title'), /工作中追加.*上下文切换.*历史同步/);
  await fixture('set-state', b, 'approval');
  await until(async () => (await page.locator('#session-status').innerText()).includes('等待确认'), 'Native pending state remains visible');
  assert.ok((await page.locator('#session-status').innerText()).includes('尚未验证'));
  await fixture('native-version', b, { version: '0.165.0', closed: true });
  await until(async () => (await page.locator('#session-status').getAttribute('title')).includes('上次连接 Codex 0.165.0 · 当前未确认'), 'Disconnected version cannot certify the current connection');
  assert.ok(!(await page.locator('#session-status').innerText()).includes('尚未验证'));
  await fixture('native-version', b, { version: '0.164.0-beta PRIVATE' });
  await until(async () => (await page.locator('#session-status').innerText()).includes('版本未确认'), 'Prerelease or malformed version cannot borrow a verified release');
  assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE'));
  const final = await snapshot();
  assert.equal(final.viewState.roomRecipient, a); assert.equal(await roomBody(page), 'Keep the draft addressed to A.');
  assert.equal(final.diagnostics.dispatches, 0); assert.deepEqual((await fixture('stats')).sends, []); assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(profile, 'final-evidence.json'), JSON.stringify(final, null, 2));
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'native-version.png') }); }
  console.log(JSON.stringify({ checks: ['Supported handshakes stay quiet; future version shows explicit enhanced-capability boundary', 'Permission status survives notice; disconnect marks last-known and prerelease never certifies release', 'Displayed member, exact recipient and unsent draft survive with zero dispatch'], modelCalls: 0, errors, evidence: profile }));
})().catch(async e => {
  console.error(e.stack);
  if (page && !page.isClosed()) fs.writeFileSync(path.join(profile, 'failure.json'), JSON.stringify(await snapshot().catch(() => ({})), null, 2));
  process.exitCode = 1;
}).finally(async () => {
  if (app) await app.close();
  if (client) { for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); }
  if (child.connected) child.disconnect();
});
