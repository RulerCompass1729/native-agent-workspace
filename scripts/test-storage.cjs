const testScratch = require('./fixtures/test-scratch.cjs');
// Actual Electron/DSH and service, synthetic provider output; no model calls.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { fork } = testScratch.childProcess;
const { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-storage-ui-'));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')],
  env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const stored = () => JSON.parse(fs.readFileSync(path.join(profile, 'workspace.json')));
let app, page, sequence = 0;
const checks = [], errors = [], checkpoints = [];
async function until(check, label) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await delay(100); }
  throw Error(label);
}
function fixture(method, target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const receive = message => {
      if (message.requestId === id) { clearTimeout(timer); child.off('message', receive); resolve(message); }
    };
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Fixture timeout')); }, 10000);
    child.on('message', receive); child.send({ id, method, target, value });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
async function run() {
  console.log('Synthetic storage profile:', profile);
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Service boot');
  app = await _electron.launch({
    executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'),
    args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000,
  });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').click();
  await page.locator('input[name="provider"][value="codex"]').check();
  await page.locator('#initial-view').selectOption('chat');
  await page.locator('#session-name').fill('连续工作保存');
  await page.locator('#confirm-create').click();
  await until(async () => (await snapshot()).sessions[0]?.state === 'idle', 'Session ready');
  const before = (await snapshot()).sessions[0], id = before.id;
  const history = Array.from({ length: 400 }, (_, i) => ({
    id: `stored-${i}`, type: 'agentMessage', turnId: `turn-${i}`,
    text: `历史记录 ${i}。保留原文、原顺序和原生身份。\n\n${'合成工作记录。'.repeat(30)}`,
  }));
  await fixture('history', id, history);
  await page.locator('#message-input').fill('还没发出的中文草稿。');
  await page.getByRole('button', { name: '加入协作', exact: true }).click();
  await until(() => {
    try {
      const saved = stored();
      return saved.sessions[0]?.messages.length === history.length &&
        saved.sessions[0].roomId === 'shared' && saved.drafts[id] === '还没发出的中文草稿。';
    } catch { return false; }
  }, 'Initial history saved');
  const beforeFailure = stored(), obstruction = path.join(profile, 'workspace.json.tmp');
  fs.mkdirSync(obstruction);
  await fixture('messageItem', id, { id: 'storage-retry-note', text: '保存暂时失败期间收到的记录。' });
  await page.locator('#retry-save').waitFor({ state: 'visible' });
  assert.deepEqual(stored(), beforeFailure, 'A failed write preserves the previous checkpoint');
  await page.locator('#retry-save').click();
  await until(async () => !(await page.locator('#retry-save').isDisabled()), 'Failed retry settles');
  assert.equal(await page.locator('#retry-save').isVisible(), true);
  assert.deepEqual(stored(), beforeFailure);
  fs.rmdirSync(obstruction);
  await page.locator('#retry-save').click();
  await page.locator('#retry-save').waitFor({ state: 'hidden' });
  const savedAfterRetry = stored();
  assert.equal(savedAfterRetry.sessions[0].id, id);
  assert.equal(savedAfterRetry.sessions[0].nativeId, before.nativeId);
  assert.equal(savedAfterRetry.sessions[0].roomId, 'shared');
  assert.equal(savedAfterRetry.drafts[id], '还没发出的中文草稿。');
  assert.equal(savedAfterRetry.sessions[0].messages.at(-1).text, '保存暂时失败期间收到的记录。');
  assert.equal((await fixture('stats')).sends.length, 0);
  checks.push('Real write obstruction keeps the checkpoint; explicit failed/successful retries save current history and draft without dispatch');
  const began = Date.now(); let emitted = 0;
  while (Date.now() - began < 3200) {
    await fixture('delta', id, { id: 'streaming-reply', text: `片段${++emitted}。` });
    await delay(40);
    const text = stored().sessions[0].messages.find(m => m.id === 'streaming-reply')?.text || '';
    checkpoints.push({ elapsedMs: Date.now() - began, chars: text.length, emitted });
  }
  const nonempty = checkpoints.filter(p => p.chars > 0);
  assert.ok(nonempty.length, 'Output must reach disk before streaming stops');
  assert.ok(nonempty[0].elapsedMs < 1600, 'Checkpoint is not indefinitely postponed by output');
  assert.ok(new Set(nonempty.map(p => p.chars)).size >= 2, 'Repeated checkpoints during the same continuous reply');
  const checkpoint = stored(), stats = await fixture('stats');
  assert.equal(stats.sends.length, 0);
  // Crash only this test-owned daemon. It cannot flush in response to SIGKILL.
  testScratch.ownService(profile); child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));
  await page.locator('#reconnect-button').waitFor({ state: 'visible' });
  assert.deepEqual(stored(), checkpoint, 'The crash cannot add an orderly-shutdown save');
  checks.push('Continuous output checkpoints repeatedly without a quiet interval or one write per chunk');
  await page.locator('#reconnect-button').click();
  await page.locator('#reconnect-button').waitFor({ state: 'hidden', timeout: 30000 });
  await until(async () => {
    const state = await snapshot();
    return state.sessions[0]?.state === 'recoverable' && state.sessions[0]?.messages.length === checkpoint.sessions[0].messages.length;
  }, 'Reconnect reads the saved records');
  const recovered = await snapshot(), session = recovered.sessions[0];
  assert.equal(session.id, id); assert.equal(session.nativeId, before.nativeId);
  assert.equal(session.roomId, 'shared');
  // A dead connection preserves text, not an obsolete live-stream claim.
  const expected=checkpoint.sessions[0].messages.map(m=>['streaming','running','awaiting-native'].includes(m.status)?{...m,status:'unconfirmed'}:m);
  assert.deepEqual(session.messages,expected);
  assert.equal(await page.locator('#message-input').inputValue(), '还没发出的中文草稿。');
  assert.equal(recovered.diagnostics.dispatches, 0);
  await page.getByRole('button', { name: '继续原生会话', exact: true }).waitFor();
  await page.locator('#messages [data-message-id="streaming-reply"] .message-heading').getByText('结果未确认',{exact:true}).waitFor();
  await page.locator('#messages [data-message-id="stored-0"]').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('#messages [data-message-id="stored-0"] .message-body p').first().textContent(), history[0].text.split('\n\n')[0]);
  checks.push('Actual process crash and UI reconnect retain checkpointed history, same identity, draft and room; no task replay');
  if (process.env.NAW_EVIDENCE_DIR) {
    fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true, mode: 0o700 });
    await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'checkpoint-recovered.png') });
  }
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() })));
  assert.ok(windows.every(w => !w.visible && !w.focusable));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, checkpoints, errors, windows, profile, modelTasks: 0, nativeProviderProcesses: 0 }, null, 2));
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(testScratch.cleanup(async () => {
  if (app) await app.close();
  if (child.connected) child.disconnect();
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  // Reconnect owns a new daemon for this private profile; no native work ran.
  try {
    const info = JSON.parse(fs.readFileSync(path.join(profile, 'connection.json')));
    if (info.pid !== child.pid) process.kill(info.pid, 'SIGTERM');
  } catch {}
}));
