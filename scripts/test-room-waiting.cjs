const { chooseRecipient: inlineRecipient, fillRoomMessage, roomBody } = require('./room-input.cjs');
// Actual hidden Electron actions; controlled provider acknowledgements only.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { fork } = require('node:child_process'), { _electron } = require('playwright');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-room-wait-')), evidence = process.env.NAW_EVIDENCE_DIR;
if (evidence) fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/daily-native.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let app, page, client, sequence = 0; const checks = [], errors = [], delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) { for (let i = 0; i < 160; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method = 'stats', extra = {}) {
  const id = ++sequence; return new Promise((resolve, reject) => {
    const cb = m => { if (m.requestId === id) { clearTimeout(timer); child.off('message', cb); resolve(m); } };
    const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 8000);
    child.on('message', cb); child.send({ id, method, ...extra });
  });
}
const snapshot = () => client.call('initial');
const shot = async name => { if (evidence) await page.screenshot({ path: path.join(evidence, name + '.png') }); };
async function create(provider, name) {
  const previous = (await snapshot()).sessions.map(s => s.id);
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#initial-view').selectOption('chat'); await page.locator('#session-name').fill(name); await page.locator('#confirm-create').click();
  await until(async () => (await snapshot()).sessions.some(s => !previous.includes(s.id) && s.chatAvailable), 'Ready session');
  return (await snapshot()).sessions.find(s => !previous.includes(s.id)).id;
}
async function authorize(first, goal) {
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await inlineRecipient(page, first);
  await fillRoomMessage(page, goal);
  if (!await page.locator('#room-advanced').evaluate(el => el.open)) await page.locator('#room-advanced summary').click();
  await page.locator('#run-button').click(); await page.locator('#run-limit').selectOption('2');
  await page.locator('#run-consent').check(); await page.locator('#confirm-run').click();
}
async function pendingPrivate(id, text) {
  await page.locator(`[data-session-id="${id}"]`).click(); await page.locator('#chat-tab').click();
  await page.locator('#message-input').fill(text); await fixture('holdSend', { target: id });
  const count = (await fixture()).sends.length; await page.locator('#message-input').press('Enter');
  await until(async () => (await fixture()).sends.length === count + 1, 'Private submission waits');
}
async function completePair(first, second, previous) {
  await until(async () => (await fixture()).sends.length === previous + 1, 'Authorized first recipient');
  assert.equal((await fixture()).sends.at(-1).id, first); await fixture('release', { text: '35 minutes daily' });
  await until(async () => (await fixture()).sends.length === previous + 2, 'Authorized second recipient');
  assert.equal((await fixture()).sends.at(-1).id, second); await fixture('release', { text: '175 minutes weekly' });
  await until(async () => (await snapshot()).room.run.status === 'completed', 'Pair complete');
}
async function run() {
  console.log('Profile:', profile); await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Service ready');
  client = await connect(profile, 'room-wait-observer');
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(950, 700));
  const a = await create('claude', '核查者'), b = await create('codex', '复核者');
  for (const id of [a, b]) { await page.locator(`[data-session-id="${id}"]`).click(); await page.getByRole('button', { name: '加入协作', exact: true }).click(); }
  const c = await create('claude', '私人学习');
  await pendingPrivate(c, '私人问题一，不进入共同任务'); await authorize(a, '旧授权任务：每天35分钟');
  await delay(250); assert.equal((await fixture()).sends.length, 1); await shot('waiting-before-action');
  if (process.argv.includes('--expect-missing-wait')) {
    assert.equal(await page.locator('#run-status').isVisible(), false); assert.equal(await page.locator('#pause-button').isVisible(), false);
    console.log('REPRODUCED: pending authorization has no visible status or cancel action.');
    await fixture('rejectSend', { target: c, text: 'Synthetic cleanup rejection' }); return;
  }
  assert.match(await page.locator('#run-status').innerText(), /等待|准备/);
  assert.equal(await page.locator('#run-status').isVisible(), true);
  assert.equal(await page.locator('#pause-button').innerText(), '取消等待'); assert.equal(await page.locator('#pause-button').isEnabled(), true);
  await page.locator('#pause-button').click();
  await until(() => page.locator('#run-button').isEnabled(), 'Cancelled wait returns draft controls');
  assert.equal(await page.locator('#shared-input').evaluate(el => el === document.activeElement), true, 'Cancel preserves immediate typing focus');
  const nextDraft = '重新确认的任务：每周175分钟'; await page.keyboard.press('Meta+A'); await page.keyboard.insertText(nextDraft);
  await fixture('rejectSend', { target: c, text: 'Synthetic private failure after cancelled wait' });
  await until(async () => !(await snapshot()).sessions.find(s => s.id === c).pendingTag, 'Private rejection settled');
  await delay(200); assert.equal((await fixture()).sends.length, 1); assert.equal(await roomBody(page), nextDraft);
  await page.locator(`[data-session-id="${c}"]`).click(); await page.locator('#chat-tab').click();
  assert.equal(await page.locator('#message-input').inputValue(), '私人问题一，不进入共同任务');
  checks.push('Waiting is visible and cancellable through the existing status/action; late private rejection retains both drafts and dispatches no cancelled task');
  await authorize(a, nextDraft); await completePair(a, b, 1);
  checks.push('Fresh explicit authorization succeeds after cancellation without resuming the cancelled task');
  await pendingPrivate(c, '私人问题二，不进入共同任务'); await authorize(a, '不应迟到执行的旧任务');
  await page.locator('#pause-button').click(); await until(() => page.locator('#run-button').isEnabled(), 'Second wait cancelled');
  const lastGoal = '最终明确授权：每天35分钟、一周175分钟'; await authorize(a, lastGoal);
  await fixture('confirmSend', { target: c });
  await completePair(a, b, 4);
  assert.equal((await snapshot()).room.run.goal, lastGoal);
  assert.ok((await fixture()).sends.every(s => !s.text.includes('不应迟到执行的旧任务')));
  await fixture('release', { target: c, text: '私人问题的回复保持在原会话。' });
  assert.equal((await fixture()).sends.length, 6);
  assert.ok((await snapshot()).room.messages.every(m => !m.text.includes('私人问题的回复')));
  await shot('cancelled-old-authorization-not-replayed');
  checks.push('Late successful ACK releases only the new explicit authorization; old completion cannot overwrite current state or share the private result');
  const cancellingDraft = '保留这份材料，即使接收确认刚好回来。';
  await fixture('holdSend', { target: a }); await authorize(a, cancellingDraft);
  await until(async () => (await fixture()).sends.length === 7, 'Run native ACK held');
  await fixture('holdPause'); await page.locator('#pause-button').click();
  await until(async () => (await fixture()).pausePending, 'Pause effect applied but ACK delayed');
  await fixture('confirmSend', { target: a });
  await delay(250);
  assert.equal(await roomBody(page), cancellingDraft, 'Native acceptance during cancellation cannot erase the material');
  assert.equal(await page.locator('#pause-button').isDisabled(), true, 'Cancellation remains pending until its own acknowledgement');
  assert.match(await page.locator('#run-status').innerText(), /正在取消/); await shot('cancellation-ack-race');
  await fixture('releasePause'); await until(async () => (await snapshot()).room.run.status === 'paused', 'Pause retained');
  await fixture('release', { target: a, text: '取消后的回复只留原会话。' });
  await delay(100); assert.equal((await fixture()).sends.length, 7);
  assert.ok((await snapshot()).room.messages.every(m => !m.text.includes('取消后的回复')));
  checks.push('Native acceptance during delayed cancellation cannot clear the material or dismiss the pending cancellation; accepted work stays private without another handoff');
  const failedPauseDraft = '取消确认失败时也要保留的任务材料';
  await fixture('holdSend', { target: a }); await authorize(a, failedPauseDraft);
  await until(async () => (await fixture()).sends.length === 8, 'Next run ACK held');
  await fixture('holdPause'); await page.locator('#pause-button').click();
  await until(async () => (await fixture()).pausePending, 'Second pause awaiting confirmation');
  await fixture('rejectSend', { target: a, text: 'Synthetic old send rejected during cancellation' });
  await delay(250);
  assert.equal(await roomBody(page), failedPauseDraft);
  assert.equal(await page.locator('#pause-button').isDisabled(), true);
  assert.match(await page.locator('#run-status').innerText(), /正在取消/);
  assert.ok(!(await page.locator('#toast').innerText()).includes('Synthetic old send rejected'));
  await fixture('rejectPause', { text: 'Synthetic pause confirmation lost' });
  await until(async () => (await page.locator('#toast').innerText()).includes('Synthetic pause confirmation lost'), 'Pause failure remains visible');
  await until(() => page.locator('#run-button').isEnabled(), 'Failed confirmation permits fresh explicit action');
  assert.equal(await roomBody(page), failedPauseDraft); await shot('pause-failure-material-retained');
  await authorize(a, '重新明确授权后核查每日35分钟'); await completePair(a, b, 8);
  checks.push('Old send rejection cannot dismiss a pending cancellation; pause ACK failure is visible, retains materials and permits a fresh explicit successful run');
  const failedFirstDraft = '取消未确认后原任务才确认，也不能丢这份材料';
  await fixture('holdSend', { target: a }); await authorize(a, failedFirstDraft);
  await until(async () => (await fixture()).sends.length === 11, 'Run ACK pending for reversed order');
  await fixture('holdPause'); await page.locator('#pause-button').click();
  await until(async () => (await fixture()).pausePending, 'Pause ACK pending for reversed order');
  await fixture('rejectPause', { text: 'Synthetic cancellation unconfirmed before native ACK' });
  await until(async () => (await page.locator('#toast').innerText()).includes('Synthetic cancellation unconfirmed before native ACK'), 'Cancellation failure shown before native acknowledgement');
  await fixture('confirmSend', { target: a }); await delay(250);
  assert.equal(await roomBody(page), failedFirstDraft, 'Requested cancellation protects material even when its confirmation failed first');
  assert.ok(!(await page.locator('#toast').innerText()).includes('已取消'));
  await fixture('release', { target: a, text: '已接收的原任务结果，只在会话保留。' });
  await until(async () => !(await snapshot()).sessions.find(s => s.id === a).pendingTag, 'Late accepted result settled');
  assert.equal((await fixture()).sends.length, 11);
  checks.push('Pause ACK failure before native success is visible and cannot undo the cancellation intent to retain task materials');
  await inlineRecipient(page, a);
  await fillRoomMessage(page, '只给核查者的一条消息'); await fixture('holdSend', { target: a });
  await page.locator('#shared-input').press('Enter');
  await until(async () => (await fixture()).sends.length === 12, 'Directed send awaits acknowledgement');
  assert.match(await page.locator('#run-status').innerText(), /正在发给.*核查者.*等待原生接收确认/);
  assert.equal(await page.locator('#run-status').isVisible(), true); assert.equal(await page.locator('#pause-button').isDisabled(), true);
  await fillRoomMessage(page, '等待期间开始写的下一条草稿'); await shot('directed-send-waiting');
  await fixture('confirmSend', { target: a }); await fixture('release', { target: a, text: '收到明确分享的一条消息。' });
  await until(async () => !(await snapshot()).sessions.find(s => s.id === a).pendingTag, 'Directed reply completes');
  assert.equal(await roomBody(page), '等待期间开始写的下一条草稿');
  assert.equal((await fixture()).sends.length, 12);
  checks.push('Directed sends identify their recipient while waiting, offer no false task cancellation and retain a newer draft when acknowledgement arrives');
  assert.deepEqual(errors, []); console.log(JSON.stringify({ checks, dispatches: 12, modelCalls: 0, errors }, null, 2));
}
run().catch(async error => { console.error(error.stack); if (page && !page.isClosed()) await shot('failure').catch(() => {}); process.exitCode = 1; }).finally(async () => {
  if (app) await app.close().catch(() => {});
  if (client) { try { for (const s of (await snapshot()).sessions) await client.call('stop', s.id); await client.call('shutdown'); } finally { client.close(); } }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
});
