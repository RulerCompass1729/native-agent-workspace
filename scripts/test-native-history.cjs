const testScratch = require('./fixtures/test-scratch.cjs');
// Actual app interactions with a controlled native transport, no model calls.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { fork } = testScratch.childProcess, { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-history-ui-')), evidence = process.env.NAW_EVIDENCE_DIR;
if (evidence) fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/native-history.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let app, page, seq = 0; const checks = [], errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function stats() { const id = ++seq; return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Fixture timeout')), 5000); const handler = x => { if (x.requestId === id) { clearTimeout(timer); child.off('message', handler); resolve(x); } }; child.on('message', handler); child.send({ id }); }); }
const snapshot = () => page.evaluate(() => workspace.initial());
const shot = async name => { if (evidence) await page.screenshot({ path: path.join(evidence, name + '.png') }); };
async function launch() {
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
}
async function open() { await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check(); await page.locator('#open-native-history').click(); }
async function choose(n) { await page.locator(`input[name="native-history-choice"][value="00000000-0000-4000-8000-${String(n).padStart(12, '0')}"]`).check(); await page.locator('#confirm-native-history').click(); await until(() => page.locator('#native-history-dialog').evaluate(el => !el.open), 'Picker closed'); }
async function run() {
  console.log('Profile:', profile); await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Daemon ready'); await launch();
  assert.equal((await stats()).calls.length, 0, 'Launch must not browse or resume history');
  await open(); await page.locator('#close-native-history').click(); await delay(300);
  assert.equal((await snapshot()).sessions.length, 0); assert.equal((await stats()).calls.some(c => c.method === 'thread/resume'), false);
  await open(); await page.locator('input[name="native-history-choice"]').first().waitFor();
  await until(() => page.locator('#search-native-history').isEnabled(), 'List ready');
  await page.locator('#more-native-history').click(); await until(async () => await page.locator('input[name="native-history-choice"]').count() === 3, 'Pagination');
  await page.locator('#native-history-search').fill('周末'); await page.locator('#search-native-history').click();
  await until(async () => await page.locator('input[name="native-history-choice"]').count() === 1, 'Search'); await shot('history-picker');
  assert.equal((await snapshot()).sessions.length, 0); checks.push('Explicit metadata browsing, cancel during loading, pagination and name search create no session or task');
  await choose(1); await page.locator('#messages').getByText('原会话核查结果：合计75元，人均25元。', { exact: true }).waitFor();
  let s = (await snapshot()).sessions[0]; const local = s.id, native = s.nativeId;
  assert.equal(s.model, 'synthetic-original'); assert.equal(s.roomId, null); assert.equal(s.messages.length, 2);
  await page.locator('#message-input').fill('后续还想安排路线，先不发送');
  await page.getByRole('button', { name: '加入协作', exact: true }).click();
  await page.getByRole('button', { name: '脱出协作', exact: true }).click();
  await page.locator('#terminal-tab').click(); await page.locator('#terminal-area .xterm-helper-textarea').waitFor({ state: 'attached' });
  await page.locator('#chat-tab').click(); assert.equal(await page.locator('#message-input').inputValue(), '后续还想安排路线，先不发送');
  await shot('restored-history'); checks.push('Selected original identity, model and full fixture history load; join/detach and GUI/TUI switching retain unsent draft');
  await open(); await choose(1); assert.equal((await snapshot()).sessions.length, 1);
  assert.equal((await stats()).calls.filter(c => c.method === 'thread/resume').length, 1);
  await page.locator(`[data-session-id="${local}"]`).click({ button: 'right' }); await page.getByRole('menuitem', { name: '归档会话', exact: true }).click();
  await open(); await choose(1); assert.equal((await snapshot()).sessions.length, 1); assert.equal((await snapshot()).sessions[0].archived, true);
  await page.locator('#archive-button').click(); await page.locator(`[data-archived-session="${local}"]`).getByRole('button', { name: '恢复会话', exact: true }).click();
  assert.equal(await page.locator('#message-input').inputValue(), '后续还想安排路线，先不发送');
  checks.push('Reimport and archived selection open the existing record without another native resume; restore keeps draft');
  await open(); await page.locator('input[name="native-history-choice"][value="00000000-0000-4000-8000-000000000002"]').check();
  await page.locator('#confirm-native-history').click();
  await until(async () => (await page.locator('#native-history-status').innerText()).includes('其他原生连接'), 'Conflict visible');
  assert.equal((await snapshot()).sessions.length, 1); assert.equal(await page.locator('#confirm-native-history').isEnabled(), true);
  await shot('writer-conflict'); await page.locator('#close-native-history').click();
  assert.equal((await stats()).calls.filter(c => c.method === 'thread/resume' && c.params.threadId.endsWith('2')).length, 1);
  checks.push('Active writer refusal keeps the selection/error in the picker, without a local copy or automatic retry');
  await open(); await page.locator('#more-native-history').click(); await choose(3);
  await until(async () => (await snapshot()).sessions.some(s => s.activity.includes('同步未完成')), 'Partial recovery visible');
  const failed = (await snapshot()).sessions.find(s => s.nativeId.endsWith('3')); assert.equal(failed.chatAvailable, false);
  await shot('history-failure'); checks.push('Resume ACK plus history failure keeps one native connection with explicit fallback and no replay');
  await page.locator(`[data-session-id="${local}"]`).click(); await app.close(); app = null; await launch();
  s = (await snapshot()).sessions.find(s => s.id === local); assert.equal(s.nativeId, native); assert.equal(s.messages.length, 2);
  await page.locator(`[data-session-id="${local}"]`).click(); assert.equal(await page.locator('#message-input').inputValue(), '后续还想安排路线，先不发送');
  const result = await stats(); assert.ok(result.calls.every(c => ['thread/list', 'thread/read', 'thread/resume', 'thread/items/list'].includes(c.method)));
  assert.equal(result.calls.filter(c => c.method === 'thread/resume').length, 3); assert.deepEqual(errors, []);
  checks.push('Reopen retains exact identity/history/draft; zero inference, forks, start or replay calls');
  console.log(JSON.stringify({ checks, nativeResumes: 3, modelCalls: 0, errors }, null, 2));
}
run().catch(async error => { console.error(error.stack); await shot('failure').catch(() => {}); process.exitCode = 1; }).finally(testScratch.cleanup(async () => { if (app) await app.close().catch(() => {}); child.kill('SIGTERM'); }));
