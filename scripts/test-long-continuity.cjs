const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// Actual hidden Electron/DSH and daemon. Synthetic long histories isolate local
// continuity from model latency/cost; all user actions use the rendered UI.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { createHash } = require('node:crypto');
const { fork } = testScratch.childProcess, { once } = require('node:events');
const { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-long-continuity-'));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
let app, page, sequence = 0;
const checks = [], errors = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stored = () => JSON.parse(fs.readFileSync(path.join(profile, 'workspace.json')));
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(100); } throw Error(label); }
function fixture(method, target, value) { const id = ++sequence; return new Promise((resolve, reject) => {
  const cb = result => { if (result.requestId === id) { clearTimeout(timer); child.off('message', cb); resolve(result); } };
  const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 15000);
  child.on('message', cb); child.send({ id, method, target, value });
}); }
async function launch() {
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(25000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor();
}
async function create(name) {
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check();
  await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  await until(async () => (await page.evaluate(() => workspace.initial())).sessions.some(s => s.name === name && s.state === 'idle'), 'Session ready');
  return (await page.evaluate(() => workspace.initial())).sessions.find(s => s.name === name).id;
}
const anchor = () => page.locator('#messages [data-message-id="long-40"] .message-body p').first();
async function anchorOffset() { return anchor().evaluate(el => el.getBoundingClientRect().top - document.getElementById('messages').getBoundingClientRect().top); }
async function verifyPosition(expected, label) {
  await until(async () => Math.abs(await anchorOffset() - expected) < 3, label);
  assert.equal(await page.locator('#reconnect-button').isVisible(), false); checks.push(label); console.log('PASS:', label);
}
async function run() {
  console.log('Synthetic continuity profile:', profile);
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Service'); await launch();
  const id = await create('长对话阅读'), other = await create('临时切换');
  await page.locator(`[data-session-id="${id}"]`).click();
  const history = Array.from({ length: 80 }, (_, i) => ({ id: `long-${i}`, type: 'agentMessage', turnId: `turn-${i}`,
    text: `Long record ${i}. 合成长记录，保留完整原文。\n\n${'Synthetic history payload. '.repeat(9000)}` }));
  const bytes = Buffer.byteLength(JSON.stringify(history)), began = Date.now();
  await fixture('history', id, history);
  await page.locator('#messages [data-message-id="long-79"] .message-body p').first().waitFor();
  await until(() => page.locator('#messages .message-body p').count().then(n => n === 160), 'Long history rendered');
  const loadMs = Date.now() - began;
  const draft = '还没有发出的计划：继续核对原文。';
  await page.locator('#message-input').fill(draft);
  await page.getByRole('button', { name: '加入协作', exact: true }).click();
  await anchor().scrollIntoViewIfNeeded();
  const box = await anchor().boundingBox(); await page.mouse.click(box.x + 25, box.y + 9, { clickCount: 3 });
  const selection = await page.evaluate(() => window.getSelection().toString()); assert.match(selection, /Long record 40/);
  const expected = await anchorOffset();
  for (let i = 0; i < 3; i++) await fixture('delta', id, { id: 'latest', text: `新的进度 ${i}。\n` });
  await page.locator('#messages [data-message-id="latest"]').getByText('新的进度 2。', { exact: false }).waitFor();
  assert.equal(await page.evaluate(() => window.getSelection().toString()), selection);
  await verifyPosition(expected, 'Reading old text remains stable while new output arrives');
  await until(() => { try { return stored().drafts[id] === draft && stored().sessions.find(s => s.id === id).messages.length === 81; } catch { return false; } }, 'Checkpoint');
  const checkpoint = stored(), nativeId = checkpoint.sessions.find(s => s.id === id).nativeId;
  const expectedMessages = checkpoint.sessions.find(s => s.id === id).messages.map(m=>['streaming','running','awaiting-native'].includes(m.status)?{...m,status:'unconfirmed'}:m);
  const expectedHash = hash(expectedMessages);
  assert.deepEqual(expectedMessages.slice(0, 80).map(m => m.text), history.map(m => m.text));
  await page.locator(`[data-session-id="${other}"]`).click(); await page.locator(`[data-session-id="${id}"]`).click();
  await verifyPosition(expected, 'Conversation roundtrip restores the same historical paragraph');
  assert.equal(await page.locator('#message-input').inputValue(), draft);
  await page.locator('#terminal-tab').click(); await until(async () => (await fixture('stats')).pending.includes(id), 'Terminal attachment');
  await fixture('release', id);
  await until(async () => (await page.evaluate(() => workspace.initial())).sessions.find(s => s.id === id).view === 'terminal', 'Terminal control');
  await fixture('hold-claim', id); await page.locator('#chat-tab').click();
  await until(async () => (await fixture('stats')).claims.includes(id), 'Hold only native control acknowledgement');
  await until(() => JSON.parse(fs.readFileSync(path.join(profile, 'views.json')))[0].mode === 'chat', 'Visible chat preference saved before native acknowledgement');
  checks.push('Visible GUI choice saves while native control is still pending');
  await verifyPosition(expected, 'GUI/TUI roundtrip preserves reading position and unsent draft');
  assert.equal(await page.locator('#message-input').inputValue(), draft);
  assert.equal((await fixture('stats')).sends.length, 0);
  await app.close(); app = null;
  // The visible choice was saved even though its native-control request never
  // completed. Reject only this test-held request after the window has closed.
  await fixture('fail-claim', id); await launch();
  await verifyPosition(expected, 'Quit during pending control and reopen restore visible chat and reading position');
  assert.equal(await page.locator('#message-input').inputValue(), draft);
  // Kill only the owned synthetic backend, never a user's native process.
  const exited = once(child, 'exit'); testScratch.ownService(profile); child.kill('SIGKILL'); await exited;
  await page.locator('#reconnect-button').waitFor({ state: 'visible' });
  await page.locator('#reconnect-button').click();
  await page.locator('#reconnect-button').waitFor({ state: 'hidden', timeout: 40000 });
  await verifyPosition(expected, 'Cold backend reconnect keeps historical reading position');
  const recovered = await page.evaluate(() => workspace.initial()), session = recovered.sessions.find(s => s.id === id);
  assert.equal(recovered.viewState.selected, id); assert.equal(session.nativeId, nativeId);
  assert.equal(session.state, 'recoverable'); assert.equal(session.roomId, 'shared');
  assert.equal(hash(session.messages), expectedHash); assert.equal(await page.locator('#message-input').inputValue(), draft);
  assert.equal(recovered.diagnostics.dispatches, 0);
  await page.getByRole('button', { name: '继续原生会话', exact: true }).waitFor();
  checks.push('Complete original text and record hash survive with pending status unconfirmed after crash; draft/room/native identity retained without replay');
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true, mode: 0o700 }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'long-history-recovered.png') }); }
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() })));
  assert.equal(windows.length, 1); assert.ok(windows.every(w => !w.visible && !w.focusable)); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, historyBytes: bytes, historyMessages: history.length, loadMs, historySha256: expectedHash, windows, errors, modelTasks: 0, nativeProviderProcesses: 0 }, null, 2));
}
run().catch(async error => { console.error(error.stack); if (page && !page.isClosed()) console.log(JSON.stringify(await page.evaluate(() => ({ mountedMessages: document.querySelectorAll('#messages article').length, chatVisible: !document.getElementById('messages')?.hidden, toast: document.getElementById('toast')?.textContent })))); process.exitCode = 1; }).finally(testScratch.cleanup(async () => {
  if (app) await app.close();
  if (child.connected) child.disconnect();
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  try { const info = JSON.parse(fs.readFileSync(path.join(profile, 'connection.json'))); if (info.pid !== child.pid) process.kill(info.pid, 'SIGTERM'); } catch {}
}));
