const { chooseRecipient: inlineRecipient, fillRoomMessage, roomBody } = require('./room-input.cjs');
// Upper-bound daily workflow through the actual app. Provider replies are
// controlled, not model reasoning; process samples exclude the person's apps.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { fork, execFileSync } = require('node:child_process');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-six-workflow-'));
const evidence = process.env.NAW_EVIDENCE_DIR;
if (evidence) fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/daily-native.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
const checks = [], errors = [], delay = ms => new Promise(r => setTimeout(r, ms));
let app, page, client, sequence = 0;
async function until(fn, label) { for (let i = 0; i < 240; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function native(method = 'stats', text, extra = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const callback = r => { if (r.requestId === id) { clearTimeout(timer); child.off('message', callback); resolve(r); } };
    const timer = setTimeout(() => { child.off('message', callback); reject(Error('Fixture timeout')); }, 8000);
    child.on('message', callback); child.send({ id, method, text, ...extra });
  });
}
const snapshot = () => client.call('initial');
const shot = async name => { if (evidence) await page.screenshot({ path: path.join(evidence, name + '.png') }); };
async function launch() {
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(850, 600));
}
async function create(provider) {
  const previous = (await snapshot()).sessions.map(s => s.id);
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#initial-view').selectOption('chat'); await page.locator('#session-name').fill('学习伙伴'); await page.locator('#confirm-create').click();
  await until(async () => (await snapshot()).sessions.some(s => !previous.includes(s.id) && s.chatAvailable), 'Distinct session ready');
  const id = (await snapshot()).sessions.find(s => !previous.includes(s.id)).id;
  await page.getByRole('button', { name: '加入协作', exact: true }).click(); return id;
}
async function room() { await page.locator('#room-nav').click(); await page.locator('#room-record').click(); }
async function authorize(ids, goal) {
  await room(); await inlineRecipient(page, ids[0]);
  await fillRoomMessage(page, goal);
  if (!await page.locator('#room-advanced').evaluate(el => el.open)) await page.locator('#room-advanced summary').click();
  await page.locator('#run-button').click();
  for (const id of ids.slice(1)) await page.locator(`[data-run-member="${id}"]`).check();
  await page.locator('#run-limit').selectOption(String(ids.length));
  assert.equal(await page.locator('#run-limit').inputValue(), String(ids.length));
  await page.locator('#run-consent').check();
  await page.locator('#confirm-run').click({ trial: true }); await shot('six-participants-preview');
  await page.locator('#confirm-run').click();
}
function resources() {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,time='], { encoding: 'utf8' }).trim().split('\n').map(line => {
    const [pid, parent, rss, time] = line.trim().split(/\s+/), parts = time.split(':').map(Number);
    return { pid: Number(pid), parent: Number(parent), rss: Number(rss), seconds: parts.reduce((total, n) => total * 60 + n, 0) };
  });
  const owned = new Set([child.pid, app.process().pid]);
  let size;
  do { size = owned.size; for (const r of rows) if (owned.has(r.parent)) owned.add(r.pid); } while (owned.size !== size);
  const selected = rows.filter(r => owned.has(r.pid));
  return { at: Date.now(), count: selected.length, rssMiB: selected.reduce((n, r) => n + r.rss, 0) / 1024, cpuSeconds: selected.reduce((n, r) => n + r.seconds, 0) };
}
async function run() {
  console.log('Profile:', profile); await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Fixture ready');
  client = await connect(profile, 'six-session-observer'); await launch();
  const ids = []; for (const provider of ['claude', 'codex', 'claude', 'codex', 'claude', 'codex']) ids.push(await create(provider));
  const identities = (await snapshot()).sessions.map(s => [s.id, s.nativeId]);
  assert.equal(await page.locator('[data-session-id]').count(), 6);
  const goal = '共同核查学习安排：每天阅读20分钟、练习15分钟，一周5天。只核查这份材料。';
  await authorize(ids, goal);
  for (let i = 0; i < 6; i++) {
    await until(async () => (await native()).sends.length === i + 1, 'Next authorized recipient');
    assert.equal((await native()).sends.at(-1).id, ids[i]);
    await native('release', `核查 ${i + 1}：每天35分钟，一周175分钟。`);
  }
  await until(async () => (await snapshot()).room.run.status === 'completed', 'Six replies complete');
  assert.equal((await native()).sends.length, 6);
  assert.ok((await native()).sends.every(s => !s.text.includes('PRIVATE-HISTORY')));
  checks.push('Six same-name independent sessions selected through GUI, exact routing order and six-reply cap; private history excluded');
  await shot('six-replies-complete');
  await authorize(ids, '重新核查周计划；真人可能中途暂停。');
  await until(async () => (await native()).sends.length === 7, 'First reply accepted'); await native('release', '每天35分钟。');
  await until(async () => (await native()).sends.length === 8, 'Second reply accepted');
  await page.locator(`[data-session-id="${ids[4]}"]`).click(); await page.locator('#chat-tab').click();
  const draft = '这是离开后继续讨论的私人草稿，暂不发送。'; await page.locator('#message-input').fill(draft);
  await page.getByRole('button', { name: '脱出协作', exact: true }).click();
  await until(async () => (await snapshot()).room.run.status === 'paused', 'Later participant departure invalidates handoff');
  await native('release', '脱出之后的私人结果，不再交给后续成员。');
  assert.equal((await native()).sends.length, 8);
  assert.ok((await snapshot()).room.messages.every(m => !m.text.includes('脱出之后的私人结果')));
  await page.locator(`[data-session-id="${ids[4]}"]`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '归档会话', exact: true }).click();
  await page.locator('#archive-button').click();
  await page.locator(`[data-archived-session="${ids[4]}"]`).getByRole('button', { name: '恢复会话', exact: true }).click();
  assert.equal(await page.locator('#message-input').inputValue(), draft);
  assert.equal((await snapshot()).sessions.find(s => s.id === ids[4]).roomId, null);
  checks.push('Removing a later participant pauses the existing run, keeps late reply private and preserves independent draft through archive/restore');
  await app.close(); app = null; await launch();
  await page.locator(`[data-session-id="${ids[4]}"]`).click(); await page.locator('#chat-tab').click();
  assert.equal(await page.locator('#message-input').inputValue(), draft);
  assert.deepEqual((await snapshot()).sessions.map(s => [s.id, s.nativeId]), identities);
  assert.equal((await native()).sends.length, 8); await room();
  checks.push('App reopen retains all six identities, private draft and paused authorization; no replay');
  // A separate native session can await permission while this selected pair
  // works. Its private tool event must not alter their sharing authorization.
  await page.locator(`[data-session-id="${ids[5]}"]`).click();
  await page.getByRole('button', { name: '脱出协作', exact: true }).click();
  await authorize(ids.slice(0, 2), '最后核查每天35分钟、每周175分钟。');
  await until(async () => (await native()).sends.length === 9, 'Selected pair started');
  const runId = (await snapshot()).room.run.id;
  const eventId = ++sequence;
  await new Promise((resolve, reject) => {
    const callback = r => { if (r.requestId === eventId) { clearTimeout(timer); child.off('message', callback); resolve(); } };
    const timer = setTimeout(() => { child.off('message', callback); reject(Error('Outside event timeout')); }, 8000);
    child.on('message', callback); child.send({ id: eventId, method: 'event', target: ids[5], value: { method: 'item/commandExecution/requestApproval', id: 99,
      params: { command: 'synthetic-private-command', cwd: '/synthetic', reason: 'Independent task; no command executes' } } });
  });
  await until(async () => (await snapshot()).sessions.find(s => s.id === ids[5]).state === 'approval', 'Independent permission visible');
  await room(); await shot('independent-permission');
  if (process.argv.includes('--expect-independent-pause')) {
    assert.equal((await snapshot()).room.run.status, 'paused');
    console.log('REPRODUCED: an independent session permission request pauses the unrelated selected pair.'); return;
  }
  assert.equal((await snapshot()).room.run.status, 'running'); assert.equal((await snapshot()).room.run.id, runId);
  await native('release', '每天35分钟，一周175分钟。');
  await until(async () => (await native()).sends.length === 10, 'Pair continues despite outside permission');
  await native('release', '复核35乘以5等于175分钟。');
  await until(async () => (await snapshot()).room.run.status === 'completed', 'Selected pair completes');
  assert.ok((await snapshot()).room.messages.every(m => !m.text.includes('synthetic-private-command')));
  checks.push('An independent native permission request remains visible in its session while the selected pair completes; no private tool scope shared');
  // Human-operation ordering waits for a pending private ACK before starting
  // a new run. Failure retains the draft and requires explicit reauthorization.
  await page.locator(`[data-session-id="${ids[4]}"]`).click(); await page.locator('#chat-tab').click();
  const pendingDraft = '私人问题等待接收确认；不要分享给协作成员。';
  await page.locator('#message-input').fill(pendingDraft);
  await native('holdSend', null, { target: ids[4] }); await page.locator('#message-input').press('Enter');
  await until(async () => (await native()).sends.length === 11, 'Private send is pending');
  await authorize(ids.slice(0, 2), '独立核查下周每天40分钟、一周200分钟。');
  await delay(250); assert.equal((await native()).sends.length, 11);
  assert.equal((await snapshot()).room.run.status, 'completed', 'Pending human operation does not start another run');
  await native('rejectSend', 'Synthetic private acknowledgement failed', { target: ids[4] });
  await until(async () => !(await snapshot()).sessions.find(s => s.id === ids[4]).pendingTag, 'Private failure clears pending state');
  await until(() => page.locator('#shared-input').isEditable(), 'Failed authorization returns editable draft');
  assert.equal((await native()).sends.length, 11);
  assert.equal((await snapshot()).room.run.status, 'completed');
  assert.ok((await snapshot()).room.messages.every(m => !m.text.includes('Synthetic private acknowledgement failed') && !m.text.includes(pendingDraft)));
  await page.locator(`[data-session-id="${ids[4]}"]`).click(); await page.locator('#chat-tab').click();
  assert.equal(await page.locator('#message-input').inputValue(), pendingDraft);
  await shot('private-failure-draft-retained');
  await authorize(ids.slice(0, 2), '独立核查下周每天40分钟、一周200分钟。');
  await until(async () => (await native()).sends.length === 12, 'Explicit reauthorization starts the new pair');
  await native('release', '每天40分钟，一周200分钟。');
  await until(async () => (await native()).sends.length === 13, 'New pair continues after private failure');
  await native('release', '确认40乘以5等于200分钟。');
  await until(async () => (await snapshot()).room.run.status === 'completed', 'New pair completes');
  await page.locator(`[data-session-id="${ids[4]}"]`).click(); await page.locator('#chat-tab').click();
  assert.equal(await page.locator('#message-input').inputValue(), pendingDraft);
  await shot('private-failure-draft-retained'); await room();
  checks.push('Pending private ACK blocks a later GUI authorization; rejection restores its draft, leaks no private content and explicit reauthorization lets the selected pair complete');
  const samples = [], sampleSeconds = process.argv.includes('--idle-sample') ? 300 : 0;
  if (sampleSeconds) {
    console.log('Idle sample: five minutes, one owned app and service tree, no provider processes or tasks.');
    samples.push(resources());
    for (let elapsed = 15; elapsed <= sampleSeconds; elapsed += 15) {
      await delay(15000); const next = resources(), before = samples.at(-1);
      next.intervalCpuPercent = 100 * (next.cpuSeconds - before.cpuSeconds) / ((next.at - before.at) / 1000);
      samples.push(next); console.log(JSON.stringify({ elapsedSeconds: elapsed, ...next }));
    }
    assert.equal((await native()).sends.length, 13);
  }
  assert.deepEqual(errors, []);
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() })));
  assert.deepEqual(windows, [{ visible: false, focusable: false }]);
  await shot('six-session-final');
  console.log(JSON.stringify({ checks, samples, dispatches: 13, models: 0, errors, windows }, null, 2));
}
run().catch(async error => { console.error(error.stack); if (page && !page.isClosed()) await shot('failure').catch(() => {}); process.exitCode = 1; }).finally(async () => {
  if (app) await app.close().catch(() => {});
  if (client) { try { for (const s of (await snapshot()).sessions) await client.call('stop', s.id); await client.call('shutdown'); } finally { client.close(); } }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
});
