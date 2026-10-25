const testScratch = require('./fixtures/test-scratch.cjs');
const { chooseRecipient: inlineRecipient, fillRoomMessage, roomBody } = require('./room-input.cjs');
// One visible app, real shipped adapter/workspace/IPC, synthetic providers.
// This tests the complete daily-use path, not native login, models or fleets.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { fork, spawn, execFileSync } = testScratch.childProcess;
const { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-daily-ui-'));
const executablePath = process.env.NAW_APP_EXECUTABLE || require('electron'), args = process.env.NAW_APP_EXECUTABLE ? [] : [root];
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/daily-native.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let app, page, client, sequence = 0; const errors = [], passed = [], requests = new Set(), startupMs = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) { for (let i = 0; i < 140; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method = 'stats', text = '') { const id = ++sequence; return new Promise((resolve, reject) => {
  const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 5000);
  const cb = m => { if (m.requestId === id) { clearTimeout(timer); child.off('message', cb); resolve(m); } }; child.on('message', cb); child.send({ id, method, text });
}); }
const snapshot = () => page.evaluate(() => workspace.initial());
const input = id => page.locator(`[data-terminal-id="${id}"] .xterm-helper-textarea`);
async function capture(name) { if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png') }); } }
async function launch() {
  const started = performance.now();
  assert.ok(!app); app = await _electron.launch({ executablePath, args, env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); page.on('request', r => { if (/^https?:|^wss?:/.test(r.url())) requests.add(new URL(r.url()).hostname); });
  await page.locator('#new-session').waitFor();
  startupMs.push(Math.round(performance.now() - started));
}
async function create(provider) {
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#initial-view').selectOption('terminal'); await page.locator('#session-name').fill(provider + ' · 日用测试'); await page.locator('#confirm-create').click();
  await until(async () => (await snapshot()).sessions.some(s => s.provider === provider && s.chatAvailable && s.terminalAvailable), 'Session ready');
  return (await snapshot()).sessions.find(s => s.provider === provider).id;
}
async function terminal(id) {
  await page.locator(`[data-session-id="${id}"]`).click(); await page.locator('#terminal-tab').click();
  await until(() => input(id).evaluate(el => document.activeElement === el), 'Selected terminal focus');
}
async function reply(text) { await fixture('release', text); await until(async () => (await snapshot()).sessions.every(s => !s.pendingTag), 'Reply settled'); }
const identities = state => state.sessions.map(s => [s.id, s.nativeId]);
async function run() {
  console.log('Synthetic profile:', profile, 'Code root:', code);
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Daemon ready'); client = await connect(profile, 'daily-observer'); await launch();
  await page.locator('#setup-button').click(); await page.locator('#setup-dialog').waitFor(); assert.match(await page.locator('#version-info').innerText(), /应用/);
  await require('./check-theme.cjs').checkTheme(page); await page.locator('#close-setup').click();
  passed.push('Fresh app profile renders setup and light/dark controls; native environment installation is not simulated');
  const codex = await create('codex');
  await until(async () => (await snapshot()).sessions.find(s => s.id === codex).messages.length === 105, 'All native history pages imported');
  let codexState = (await snapshot()).sessions.find(s => s.id === codex);
  assert.equal(new Set(codexState.messages.map(m => m.id)).size, 105); assert.equal(codexState.controlRevision, 1);
  await page.locator('#chat-tab').click(); assert.equal(await page.locator('#messages article').count(), 105);
  await page.locator('#messages').getByText('PRIVATE-HISTORY-104', { exact: true }).scrollIntoViewIfNeeded(); await capture('history-complete');
  await page.locator('#message-input').fill('私有中文草稿\n不分享');
  await terminal(codex); await page.keyboard.type('UNSUBMITTED-CODEX');
  assert.equal((await fixture()).inputs.filter(x => x.id === codex).map(x => x.data).join(''), 'UNSUBMITTED-CODEX');
  await page.locator('#chat-tab').click(); assert.equal(await page.locator('#message-input').inputValue(), '私有中文草稿\n不分享');
  // Explicit solo send has one exact payload, no history/context replay.
  await page.locator('#message-input').fill('SOLO-QUESTION'); await page.locator('#send-button').click();
  await until(async () => (await fixture()).sends.length === 1, 'Solo send'); assert.deepEqual((await fixture()).sends[0], { id: codex, text: 'SOLO-QUESTION' }); await reply('SOLO-ANSWER');
  await page.locator('#message-input').fill('保留独立草稿');
  passed.push('Codex terminal attachment retains 105 history items once; GUI/TUI keep identity, exact first input and private drafts');
  const claude = await create('claude'); const ids = identities(await snapshot());
  await page.locator(`[data-session-menu="${claude}"]`).click(); await page.getByRole('menuitem', { name: '重命名…', exact: true }).click();
  await page.locator('#rename-name').fill('一起核查'); await page.locator('#confirm-rename').click();
  await page.getByRole('button', { name: '加入协作', exact: true }).click();
  await page.locator(`[data-session-id="${codex}"]`).click(); await page.getByRole('button', { name: '加入协作', exact: true }).click();
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  assert.equal((await snapshot()).room.messages.length, 0, 'Joining does not expose private history');
  await chooseRecipient(claude); await fillRoomMessage(page, 'SHARED-MATERIAL'); await page.locator('#forward-button').click();
  await until(async () => (await fixture()).sends.length === 2, 'Directed Claude send'); await reply('REVIEW-MATERIAL');
  const shared = page.locator('#room-messages article.assistant').filter({ has: page.getByText('REVIEW-MATERIAL', { exact: true }) });
  await shared.getByRole('button', { name: '选择并分享', exact: true }).click(); await page.locator('#share-recipient').selectOption(codex);
  assert.equal(await page.locator('#share-text').inputValue(), 'REVIEW-MATERIAL'); await page.locator('#confirm-share').click();
  await until(async () => (await fixture()).sends.length === 3, 'Selected review to Codex'); await reply('VERIFIED-MATERIAL');
  await page.locator('#room-messages').getByText('VERIFIED-MATERIAL', { exact: true }).waitFor();
  const requestArticle = page.locator('#room-messages article').filter({ has: page.getByText('SHARED-MATERIAL', { exact: true }) });
  assert.equal(await requestArticle.locator('.message-heading strong').innerText(), '你 → 一起核查');
  assert.equal(await shared.locator('.message-heading strong').innerText(), '一起核查');
  assert.deepEqual((await fixture()).sends, [{ id: codex, text: 'SOLO-QUESTION' }, { id: claude, text: 'SHARED-MATERIAL' }, { id: codex, text: 'REVIEW-MATERIAL' }]);
  assert.ok(!(await page.locator('#room-messages').innerText()).includes('PRIVATE-HISTORY'));
  await page.locator(`[data-session-menu="${claude}"]`).click(); await page.getByRole('menuitem', { name: '重命名…', exact: true }).click();
  await page.locator('#rename-name').fill('复核伙伴'); await page.locator('#confirm-rename').click();
  await until(async () => await shared.locator('.message-heading strong').innerText() === '复核伙伴', 'Room authors follow renaming');
  assert.equal(await requestArticle.locator('.message-heading strong').innerText(), '你 → 复核伙伴');
  await page.locator('#room-messages').getByText('VERIFIED-MATERIAL', { exact: true }).scrollIntoViewIfNeeded();
  await capture('shared-review'); passed.push('Two-agent directed verification shares only selected material; current author/recipient names follow renaming without changing saved messages');
  await page.locator(`[data-room-session="${codex}"]`).click(); await until(() => input(codex).evaluate(el => document.activeElement === el), 'Room terminal focus');
  await page.keyboard.type('-ROOM');
  await page.locator('#room-record').click(); await chooseRecipient(claude); await fillRoomMessage(page, '下一次核查草稿');
  await page.locator(`[data-session-id="${codex}"]`).click(); await page.getByRole('button', { name: '脱出协作', exact: true }).click();
  await terminal(codex); await page.keyboard.type('-SOLO');
  assert.equal((await fixture()).inputs.filter(x => x.id === codex).map(x => x.data).join(''), 'UNSUBMITTED-CODEX-ROOM-SOLO');
  assert.deepEqual(identities(await snapshot()), ids); assert.equal((await snapshot()).sessions.find(s => s.id === codex).roomId, null);
  await page.locator('#chat-tab').click(); assert.equal(await page.locator('#message-input').inputValue(), '保留独立草稿');
  await terminal(codex); const before = await snapshot(); await capture('detached-terminal');
  // A deliberate competing test launch keeps this app inactive and creates no new UI.
  const duplicate = spawn(executablePath, args, { env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, stdio: 'ignore' });
  try { await until(() => duplicate.exitCode !== null, 'Duplicate exits'); assert.equal(duplicate.exitCode, 0); } finally { if (duplicate.exitCode === null) duplicate.kill('SIGTERM'); }
  assert.equal(app.windows().length, 1);
  await app.close(); app = null; await launch();
  const after = await snapshot(); assert.deepEqual(identities(after), ids);
  assert.deepEqual(after.sessions.map(s => [s.id, s.messages, s.liveDraft, s.name, s.roomId]), before.sessions.map(s => [s.id, s.messages, s.liveDraft, s.name, s.roomId]));
  for (const key of ['selected', 'mode', 'roomSession', 'sharedDraft', 'roomRecipient']) assert.deepEqual(after.viewState[key], before.viewState[key], key);
  await until(() => input(codex).evaluate(el => document.activeElement === el), 'Reopen original terminal');
  assert.equal((await fixture()).sends.length, 3); assert.equal((await fixture()).calls.filter(x => x === 'thread/items/list').length, 2, 'UI reopen does not reload the agent');
  passed.push('Detach continues the same terminal; deliberate duplicate launch and reopen retain names, history, membership, both drafts and recipient with no replay');
  await page.locator('#privacy-button').click(); const trust = await page.locator('#trust-status').innerText();
  assert.match(trust, /不是账单/); assert.match(trust, /未报告；不能据此判断为零/); await capture('privacy-usage'); await page.locator('#close-privacy').click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(880, 660));
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  assert.equal(await roomBody(page), '下一次核查草稿'); assert.equal(await page.locator('#recipient').inputValue(), claude);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await capture('compact-room');
  passed.push('Usage panel distinguishes unknown native cost from shell counts; compact window retains controls and shared draft');
  assert.equal((await snapshot()).diagnostics.shellModelCalls, 0); assert.equal((await snapshot()).diagnostics.dispatches, 3);
  assert.deepEqual(errors, []); assert.ok([...requests].every(x => x === '127.0.0.1' || x === 'localhost'));
  // One sampled process-tree baseline, not a steady-state/per-provider benchmark.
  const processRows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,%cpu='], { encoding: 'utf8' }).trim().split('\n').map(row => row.trim().split(/\s+/).map(Number));
  const owned = new Set([app.process().pid, child.pid]);
  for (let previous = -1; previous !== owned.size;) { previous = owned.size; for (const [pid, parent] of processRows) if (owned.has(parent)) owned.add(pid); }
  const sample = processRows.filter(([pid]) => owned.has(pid));
  const resources = { startupMs, processes: sample.length, summedRssMiB: Math.round(sample.reduce((n, row) => n + row[2], 0) / 1024), sampledCpuPercent: sample.reduce((n, row) => n + row[3], 0), scope: 'Synthetic test app/services only; summed RSS may double-count shared pages; one sample, not steady-state or native costs' };
  console.log(JSON.stringify({ passed, errors, resources, syntheticDispatches: 3, nativeProcesses: 0, modelCalls: 0, oneWindow: app.windows().length === 1, observedRendererHosts: [...requests] }, null, 2));
}
run().catch(async e => { console.error(e.stack); if (page) await capture('failed'); process.exitCode = 1; }).finally(testScratch.cleanup(async () => {
  if (app) await app.close(); if (client) { const state = await client.call('initial'); for (const s of state.sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); } if (child.connected) child.disconnect();
}));

async function chooseRecipient(id) { await inlineRecipient(page, id); }
