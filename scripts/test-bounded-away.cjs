// Actual application and persistent service, controlled provider events only.
// --real-deadline waits the full ten minutes with the UI closed, no clock change.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { fork } = require('node:child_process'), { _electron } = require('playwright');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-bounded-away-'));
const evidence = process.env.NAW_EVIDENCE_DIR;
if (evidence) fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/daily-native.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
let app, page, client, seq = 0;
const checks = [], errors = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function native(method = 'stats', payload = {}) {
  const id = ++seq; return new Promise((resolve, reject) => {
    const cb = result => { if (result.requestId === id) { clearTimeout(timer); child.off('message', cb); resolve(result); } };
    const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 8000);
    child.on('message', cb); child.send({ id, method, ...payload });
  });
}
const snapshot = () => client.call('initial');
const shot = async name => { if (evidence) await page.screenshot({ path: path.join(evidence, name + '.png') }); };
async function launch() {
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor();
}
async function close() { await app.close(); app = null; page = null; }
async function room() { await page.locator('#room-nav').click(); await page.locator('#room-record').click(); }
async function create(provider, name) {
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#initial-view').selectOption('chat'); await page.locator('#session-name').fill(name); await page.locator('#confirm-create').click();
  await until(async () => (await snapshot()).sessions.some(s => s.name === name && s.chatAvailable), 'Session ready');
  const id = (await snapshot()).sessions.find(s => s.name === name).id;
  await page.getByRole('button', { name: '加入协作', exact: true }).click(); return id;
}
async function start(id, goal) {
  await room(); await page.locator('#mention-button').click(); await page.locator(`[data-mention-id="${id}"]`).click();
  await page.locator('#shared-input').fill(goal);
  if (!(await page.locator('#room-advanced').evaluate(el => el.open))) await page.locator('#room-advanced summary').click();
  await page.locator('#run-button').click(); await page.locator('#run-limit').selectOption('2');
  await page.locator('#run-consent').check(); await page.locator('#confirm-run').click();
  await until(async () => (await snapshot()).room.run?.goal === goal && (await snapshot()).room.run?.status === 'running', 'Authorized exchange started');
}
async function run() {
  console.log('Profile:', profile);
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Service ready'); client = await connect(profile, 'away-observer');
  await launch(); const a = await create('claude', '安排计划'), b = await create('codex', '核查计划');
  const identities = (await snapshot()).sessions.map(s => [s.id, s.nativeId]);
  await start(a, '核查学习安排：阅读 20 分钟，练习 15 分钟，总计多少？');
  await until(async () => (await native()).sends.length === 1, 'First submission'); await shot('authorized-before-close'); await close();
  await native('release', { text: '20 + 15 = 35 分钟，请核查。' });
  await until(async () => (await native()).sends.length === 2, 'Authorized continuation while UI closed');
  await native('release', { text: '核查完成，总计 35 分钟。' });
  await until(async () => (await snapshot()).room.run.status === 'completed', 'Reply cap reached without UI');
  await launch(); await room(); assert.match(await page.locator('#run-status').innerText(), /本轮交接结束 · 2\/2/);
  assert.deepEqual((await snapshot()).sessions.map(s => [s.id, s.nativeId]), identities); assert.equal((await native()).sends.length, 2);
  checks.push('Explicit two-reply study task continues with the UI closed, stops at its exact reply cap, and reopens with the same identities and results');
  await start(b, '独立核查 35 分钟，不要增加任务。'); await until(async () => (await native()).sends.length === 3, 'Error case accepted'); await close();
  await native('event', { target: b, value: { method: 'error', params: { message: 'Controlled native failure' } } });
  await until(async () => (await snapshot()).room.run.status === 'paused', 'Native error pauses handoffs while away');
  await native('release', { text: '错误之后收到的私人结果。' });
  await launch(); await room(); assert.match(await page.locator('#run-status').innerText(), /已暂停/);
  assert.equal((await native()).sends.length, 3); assert.ok((await snapshot()).room.messages.every(m => m.text !== '错误之后收到的私人结果。'));
  checks.push('A native error while the UI is closed pauses handoffs; a later result remains private and reopening never retries');
  await start(a, '等待真人决定是否继续学习安排。'); await until(async () => (await native()).sends.length === 4, 'Pause case accepted');
  await page.locator('#pause-button').click();
  assert.equal((await snapshot()).sessions.find(s => s.id === a).state, 'working', 'Pausing handoffs is not stopping the native task');
  await native('release', { text: '暂停后返回的私人计划。' });
  assert.equal((await native()).sends.length, 4); assert.ok((await snapshot()).room.messages.every(m => m.text !== '暂停后返回的私人计划。'));
  checks.push('Visible pause revokes subsequent sharing while the accepted native task can still finish privately; no implicit interrupt');
  if (process.argv.includes('--real-deadline')) {
    await start(a, '等待核查学习安排；到期后不再自动交接。');
    await until(async () => (await native()).sends.length === 5, 'Deadline case accepted');
    const initial = (await snapshot()).room.run, started = Date.now();
    assert.equal(initial.deadline - initial.startedAt, 10 * 60 * 1000);
    await close(); console.log('Real deadline started: UI closed, 600 seconds, one accepted synthetic task, zero models.');
    while (Date.now() < initial.deadline) {
      await delay(Math.min(60000, Math.max(1, initial.deadline - Date.now())));
      const state = await snapshot(), log = await native();
      assert.equal(log.sends.length, 5);
      console.log(JSON.stringify({ elapsedSeconds: Math.round((Date.now() - started) / 1000), run: state.room.run.status, submissions: log.sends.length, modelCalls: log.modelCalls }));
    }
    await until(async () => (await snapshot()).room.run.status === 'paused', 'Real timer expired');
    const expired = await snapshot(); assert.match(expired.room.run.reason, /10 分钟/);
    assert.equal(expired.sessions.find(s => s.id === a).state, 'working');
    await native('release', { text: '期限之后完成的私人学习计划。' });
    assert.equal((await native()).sends.length, 5); assert.ok((await snapshot()).room.messages.every(m => m.text !== '期限之后完成的私人学习计划。'));
    await launch(); await room(); assert.match(await page.locator('#run-status').innerText(), /已暂停.*10 分钟/); await shot('expired-without-ui');
    await page.locator('#mention-button').click(); await page.locator(`[data-mention-id="${b}"]`).click();
    await page.locator('#shared-input').fill('新的人工指令：把 35 分钟安排写成一句话。'); await page.locator('#forward-button').click();
    await until(async () => (await native()).sends.length === 6, 'New explicit message accepted'); await native('release', { text: '先阅读 20 分钟，再练习 15 分钟。' });
    assert.equal((await snapshot()).room.run.status, 'paused');
    checks.push('Full real ten-minute deadline expires with UI closed; pending native work is not called stopped, late result stays private, and a new explicit message works without resuming the expired run');
  }
  const log = await native(); assert.equal(log.calls.includes('turn/interrupt'), false); assert.deepEqual(log.inputs, []); assert.deepEqual(errors, []);
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() })));
  assert.deepEqual(windows, [{ visible: false, focusable: false }]);
  console.log(JSON.stringify({ checks, errors, profile, realDeadline: process.argv.includes('--real-deadline'), syntheticDispatches: log.sends.length, modelCalls: log.modelCalls, nativeProcesses: log.nativeProcesses, windows }, null, 2));
}
run().catch(async e => { console.error(e.stack); if (page && !page.isClosed()) await shot('failure').catch(() => {}); process.exitCode = 1; }).finally(async () => {
  if (app) await close();
  if (client) { for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); }
  if (child.connected) child.disconnect();
});
