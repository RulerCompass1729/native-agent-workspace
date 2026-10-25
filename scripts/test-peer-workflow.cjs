const testScratch = require('./fixtures/test-scratch.cjs');
const { chooseRecipient: inlineRecipient, fillRoomMessage, roomBody } = require('./room-input.cjs');
// Actual hidden desktop, two independent local services and shipped routing.
// Controlled provider transports; no native process or model inference.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { fork } = testScratch.childProcess, assert = require('node:assert/strict');
const { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-peer-workflow-')), key = 'backends/' + 'b'.repeat(20);
const children = [], errors = [], checks = [], version = require(path.join(code, 'package.json')).version;
let app, page, observer, requestId = 0;
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, name) { for (let n = 0; n < 240; n++) { if (await fn()) return; await delay(50); } throw Error(name); }
const snapshot = () => page.evaluate(() => workspace.initial());
async function start(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const child = fork(path.join(code, 'app/daemon.cjs'), [dir], { execArgv: ['--require', path.join(__dirname, 'fixtures/daily-native.cjs')],
    env: { ...process.env, NAW_APP_VERSION: version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  children.push(child); await until(() => fs.existsSync(path.join(dir, 'connection.json')), 'Local service ready'); return child;
}
function fixture(child, method = 'stats', text = '', target, value) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Fixture timeout')); }, 5000);
    const receive = m => { if (m.requestId === id) { clearTimeout(timer); child.off('message', receive); resolve(m); } };
    child.on('message', receive); child.send({ id, method, text, target, value });
  });
}
async function launch() {
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  await until(async () => { for (const candidate of app.windows()) if (!candidate.isClosed() && await candidate.locator('#new-session').count().catch(() => 0)) { page = candidate; return true; } }, 'Actual workspace');
  page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
}
async function create(provider, name) {
  const before = new Set((await snapshot()).sessions.map(s => s.id));
  await page.locator('#new-session').click(); await page.locator(`input[value="${provider}"][name="provider"]`).check();
  await page.locator('#initial-view').selectOption('chat'); await page.locator('#session-name').fill(name); await page.locator('#confirm-create').click();
  let record; await until(async () => { record = (await snapshot()).sessions.find(s => !before.has(s.id)); return record?.chatAvailable && record.state === 'idle'; }, 'Session created');
  await page.getByRole('button', { name: '加入协作', exact: true }).click(); return record;
}
async function run(id, text) {
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await inlineRecipient(page, id);
  await fillRoomMessage(page, text); await page.locator('#room-advanced summary').click(); await page.locator('#run-button').click();
  assert.equal(await page.locator('#run-mode').inputValue(), 'replies');
  await page.locator('#run-limit').selectOption('3'); await page.locator('#run-consent').check(); await page.locator('#confirm-run').click();
}
async function rejectHistoryClear() {
  await page.locator('#privacy-button').click();
  const summary = page.getByText('清理与完全退出', { exact: true });
  if (!await summary.evaluate(el => el.parentElement.open)) await summary.click();
  await page.locator('#clear-shared-history').click();
  await until(async () => (await page.locator('#toast').innerText()).includes('核对各后台'), 'Clear history preserves the unresolved pause warning');
  await page.locator('#close-privacy').click();
}
async function main() {
  console.log('Evidence:', profile);
  const old = await start(profile); await launch(); const a = await create('claude', '方案');
  await app.close(); app = null;
  const next = await start(path.join(profile, key));
  fs.writeFileSync(path.join(profile, 'services.json'), JSON.stringify({ format: 1, active: key, entries: ['.', key] }), { mode: 0o600 });
  await launch(); const b = await create('codex', '核查');
  observer = await connect(profile, 'read-only-peer-test');
  const identities = (await snapshot()).sessions.map(s => [s.id, s.nativeId, s.pid]);
  await run(a.id, '计算36+14，让两位按顺序核对，最后由方案会话给结论。');
  await until(async () => (await fixture(old)).sends.length === 1, 'First service accepts step one');
  await fixture(old, 'release', '草案：预算50元。');
  await until(async () => (await fixture(next)).sends.length === 1, 'Second service accepts step two');
  await fillRoomMessage(page, '关闭重开后保留的草稿'); await app.close(); app = null;
  await fixture(next, 'release', '核查：36+14=50，计算正确。');
  await until(async () => (await fixture(old)).sends.length === 2, 'UI-closed service handoff returns to original session');
  await fixture(old, 'release', '最终预算50元，已核查。');
  await until(async () => (await observer.call('initial')).room.run?.status === 'completed', 'Finite run completes without UI');
  await launch(); await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  assert.equal(await roomBody(page), '关闭重开后保留的草稿');
  let state = await snapshot(); assert.equal(state.room.run.steps, 3); assert.deepEqual(state.sessions.map(s => [s.id, s.nativeId, s.pid]), identities);
  assert.equal(state.room.messages.filter(m => m.role === 'human' && m.runId === state.room.run.id).length, 1);
  assert.equal(state.room.messages.filter(m => m.finalReply && m.runId === state.room.run.id).length, 3);
  assert.match(await page.locator('#room-messages').innerText(), /最终预算50元/);
  checks.push('Two independent services complete A → B → A; closed UI preserves work, identity, draft and one reading stream without replay');
  await run(a.id, '再次核查，第二位返回前我会暂停。'); await until(async () => (await fixture(old)).sends.length === 3, 'Second round');
  await fixture(old, 'release', '待第二位核查50元。'); await until(async () => (await fixture(next)).sends.length === 2, 'Second member started');
  await fixture(next, 'holdPeerPause'); await page.locator('#pause-button').click();
  await until(async () => (await fixture(next)).peerPausePending === 2, 'Both pause ACKs held');
  await until(async () => (await page.locator('#run-status').innerText()).includes('正在撤销后续授权'), 'Pending revocation is visible');
  assert.ok(!(await page.locator('#run-status').innerText()).includes('已暂停'));
  await rejectHistoryClear();
  assert.equal((await snapshot()).room.run.pausePending, true);
  await fixture(next, 'rejectPeerPause');
  await until(async () => (await snapshot()).room.run?.pauseUnconfirmed, 'Lost ACK remains unconfirmed');
  await until(async () => (await page.locator('#run-status').innerText()).includes('部分后台未确认暂停'), 'Unconfirmed pause is visible');
  await rejectHistoryClear();
  assert.equal((await snapshot()).room.run.pauseUnconfirmed, true);
  await page.locator('#pause-button').click();
  await until(async () => !(await snapshot()).room.run?.pauseUnconfirmed && !(await snapshot()).room.run?.pausePending, 'Explicit read-only pause confirmation');
  await fixture(next, 'release', '暂停后的私人回复'); await delay(150);
  state = await snapshot(); assert.ok(state.sessions.find(s => s.id === b.id).messages.some(m => m.text === '暂停后的私人回复'));
  assert.ok(!state.room.messages.some(m => m.text?.includes('暂停后的私人回复'))); assert.equal((await fixture(old)).sends.length, 3);
  checks.push('Held/lost pause ACK is visible; explicit read-only confirmation never resends; pause revokes peer grants; already-running native reply stays private and never creates a later step');
  await run(a.id, '核查权限变化，不要继续交接。'); await until(async () => (await fixture(old)).sends.length === 4, 'Permission scenario starts');
  await fixture(next, 'events', '', b.id, [
    { method: 'thread/status/changed', params: { threadId: b.nativeId, status: { type: 'active', activeFlags: ['waitingOnApproval'] } } },
    { method: 'thread/status/changed', params: { threadId: b.nativeId, status: { type: 'idle' } } },
  ]);
  await until(async () => (await snapshot()).room.run?.status === 'paused', 'Transient permission revokes before coalesced idle');
  await fixture(old, 'release', '权限变化后的原会话结果'); await delay(150); assert.equal((await fixture(next)).sends.length, 2);
  checks.push('Approval → idle inside one state batch cannot restore a revoked step');
  await run(a.id, '成员脱出后不要继续交接。'); await until(async () => (await fixture(old)).sends.length === 5, 'Departure scenario starts');
  await page.locator(`[data-session-menu="${b.id}"]`).click(); await page.getByRole('menuitem', { name: '脱出协作', exact: true }).click();
  await until(async () => !(await snapshot()).sessions.find(s => s.id === b.id).roomId, 'Member detached');
  await fixture(old, 'release', '脱出后的原会话结果'); await delay(150); assert.equal((await fixture(next)).sends.length, 2);
  state = await snapshot(); assert.deepEqual(state.sessions.map(s => [s.id, s.nativeId, s.pid]), identities);
  checks.push('Departure pauses cross-service routing while keeping both original sessions');
  assert.deepEqual(errors, []);
  assert.ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(w => !w.isVisible() && !w.isFocused())));
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'peer-workflow.png') }); }
  fs.writeFileSync(path.join(profile, 'evidence.json'), JSON.stringify({ checks, state }, null, 2));
  console.log(JSON.stringify({ checks, syntheticDispatches: 7, nativeProcesses: 0, modelCalls: 0, evidence: profile }, null, 2));
}
main().catch(async error => { console.error(error.stack); process.exitCode = 1; if (page && !page.isClosed()) { console.error((await page.locator('#toast').innerText().catch(() => ''))); await page.screenshot({ path: path.join(profile, 'failure.png') }).catch(() => {}); } }).finally(testScratch.cleanup(async () => {
  observer?.close(); if (app) await app.close();
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
}));
