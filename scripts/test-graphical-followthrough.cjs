const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
const { chooseRecipient: inlineRecipient, fillRoomMessage, roomBody } = require('./room-input.cjs');
// Actual Electron interface, native adapters/workspace and persisted records.
// Controlled provider events prove UI behavior, not model reasoning or OS IME.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { fork } = testScratch.childProcess;
const { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-graphical-followthrough-'));
const evidence = process.env.NAW_EVIDENCE_DIR;
if (evidence) fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/daily-native.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
let app, page, client, sequence = 0;
const checks = [], errors = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let n = 0; n < 200; n++) { if (await fn()) return; await delay(50); } throw Error(label); }
function native(method = 'stats', payload = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const receive = result => { if (result.requestId === id) { clearTimeout(timer); child.off('message', receive); resolve(result); } };
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Fixture timeout')); }, 8000);
    child.on('message', receive); child.send({ id, method, ...payload });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
const shot = async name => { if (evidence) await page.screenshot({ path: path.join(evidence, name + '.png') }); };
async function launch() {
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'),
    args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor();
  // Leave the person's clipboard untouched; capture only this app's copy calls.
  await app.evaluate(({ clipboard }) => { global.copyValues = []; clipboard.writeText = text => global.copyValues.push(text); });
}
async function create(provider, name) {
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => s.name === name && s.chatAvailable), 'Native attachment ready');
  const s = (await snapshot()).sessions.find(s => s.name === name);
  await page.getByRole('button', { name: '加入协作', exact: true }).click(); return s.id;
}
async function room() { await page.locator('#room-nav').click(); await page.locator('#room-record').click(); }
async function readableAction(button, label) {
  await page.locator('#room-search').click(); await page.mouse.move(3, 3);
  assert.ok(await button.isEnabled());
  const backgrounds = [];
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const colors = await button.evaluate(el => {
      const rgba = value => {
        const v = value.match(/[\d.]+/g).map(Number);
        return [v[0], v[1], v[2], v[3] ?? 1];
      };
      const over = (a, b) => {
        const alpha = a[3] + b[3] * (1 - a[3]);
        return alpha ? [0, 1, 2].map(i => (a[i] * a[3] + b[i] * b[3] * (1 - a[3])) / alpha).concat(alpha) : [0, 0, 0, 0];
      };
      let fg = rgba(getComputedStyle(el).color), bg = [0, 0, 0, 0];
      for (let node = el; node; node = node.parentElement) {
        const style = getComputedStyle(node), layer = rgba(style.backgroundColor);
        fg = over(fg, layer); bg = over(bg, layer);
        fg[3] *= Number(style.opacity); bg[3] *= Number(style.opacity);
      }
      const luminance = c => c.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
      fg = over(fg, [255, 255, 255, 1]); bg = over(bg, [255, 255, 255, 1]);
      const a = luminance(fg), b = luminance(bg);
      return { contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), fg, bg };
    });
    backgrounds.push(colors.bg);
    console.log(JSON.stringify({ action: label, colorScheme, ...colors }));
    await shot(label + '-' + colorScheme);
    assert.ok(colors.contrast >= 4.5, `${label} ${colorScheme}: enabled action must be readable without hover (${colors.contrast.toFixed(2)})`);
  }
  assert.notDeepEqual(backgrounds[0], backgrounds[1], 'Both rendered themes were actually checked');
  await page.emulateMedia({ colorScheme: null });
}
async function findReply(id, text) {
  // Opening a session deliberately keeps its reading position. Use the same
  // local search a person can use, then verify the answer actually enters view.
  await page.locator('#search-button').click(); await page.locator('#search-scope').selectOption('current');
  await page.locator('#search-input').fill(text.split('\n')[0]);
  const message = (await snapshot()).sessions.find(s => s.id === id).messages.find(m => m.text === text);
  assert.ok(message); await page.locator(`[data-search-key="message:${id}:${message.id}"]`).click();
  const body = page.locator(`#messages [data-message-id="${message.id}"] .message-body`);
  await until(() => body.evaluate(el => {
    const box = el.getBoundingClientRect(), viewport = document.getElementById('messages').getBoundingClientRect();
    return box.top >= viewport.top - 2 && box.bottom <= viewport.bottom + 2 && box.height > 0;
  }), 'Complete result visible inside conversation viewport');
}
async function run() {
  console.log('Profile:', profile);
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Service ready'); client = await connect(profile, 'followthrough-observer');
  await launch(); const a = await create('claude', '预算整理'), b = await create('codex', '预算核查');
  const identities = (await snapshot()).sessions.map(s => [s.id, s.nativeId]);
  await room(); await inlineRecipient(page, b);
  const task = '核查三人出游预算：每人午餐 18 元、交通 7 元。给出总计和人均，保留明细。';
  await fillRoomMessage(page, task); await page.locator('#forward-button').click();
  await until(async () => (await native()).sends.length === 1, 'Directed task accepted once');
  const request = (await snapshot()).room.messages.find(m => m.text === task);
  assert.ok(request); assert.equal(request.recipientId, b);
  const command = 'printf "午餐54，交通21，合计75，人均25"';
  await native('event', { target: b, value: { id: 11, method: 'item/commandExecution/requestApproval', params: { command, cwd: '/synthetic', reason: '合成预算检查，不执行命令' } } });
  await page.locator(`[data-session-id="${b}"]`).click(); await page.locator('#chat-tab').click();
  await page.locator('#approval').getByText(command, { exact: true }).waitFor();
  assert.equal(await page.locator('#send-button').isDisabled(), true);
  const draft = '明天再讨论行程安排，先不发送。'; await page.locator('#message-input').fill(draft);
  await shot('permission-and-draft');
  // The person chooses the existing native surface for this confirmation.
  await page.locator('#terminal-tab').click(); const input = page.locator(`[data-terminal-id="${b}"] .xterm-helper-textarea`);
  await input.waitFor({ state: 'attached' }); await input.focus(); await input.press('Enter');
  await until(async () => (await native()).inputs.some(i => i.id === b && i.data === '\r'), 'One native confirmation key');
  await native('event', { target: b, value: { method: 'serverRequest/resolved', params: { requestId: 11 } } });
  const result = '预算核查：午餐 54 元，交通 21 元，合计 75 元，人均 25 元。\n\n私人备注：明天再讨论行程。';
  await native('release', { text: result });
  await until(async () => (await snapshot()).room.messages.find(m => m.id === request.id)?.status === 'reply-private', 'Native intervention keeps completed answer private');
  await room(); const row = page.locator(`#room-messages [data-message-id="${request.id}"]`);
  await row.getByText('分享已失效，回复保留在原会话', { exact: true }).waitFor();
  assert.equal((await snapshot()).room.messages.some(m => m.text === result), false);
  if (process.env.NAW_EXPECT_NAVIGATION_GAP === '1') {
    assert.equal(await row.getByRole('button', { name: '查看会话', exact: true }).isVisible(), false);
    await shot('reproduced-missing-navigation'); console.log('REPRODUCED: private result exists, but its shared record hides the existing conversation action.'); return;
  }
  await readableAction(row.getByRole('button', { name: '查看会话', exact: true }), 'directed-result-action');
  await row.getByRole('button', { name: '查看会话', exact: true }).click();
  const answer = page.locator('#messages article').filter({ has: page.locator('.message-body', { hasText: result }) });
  await answer.waitFor(); assert.equal(await page.locator('#message-input').inputValue(), draft);
  assert.equal((await native()).sends.length, 1); await shot('private-result-found');
  checks.push('Directed budget task → native confirmation → terminal intervention → private result is reachable from its shared record; same identity/draft, no automatic re-sharing');
  // Reuse the existing preview, selecting only what this next recipient needs.
  await answer.getByRole('button', { name: '选择并分享', exact: true }).click();
  const selected = '已核查：合计 75 元，人均 25 元。请整理成一句可发给同行人的结论。';
  await page.locator('#share-text').fill(selected); await page.locator('#share-recipient').selectOption(a);
  assert.equal((await native()).sends.length, 1); await page.locator('#confirm-share').click();
  await until(async () => (await native()).sends.length === 2, 'Explicit selected result shared once');
  assert.deepEqual((await native()).sends.at(-1), { id: a, text: selected });
  const summary = '出游预算已核对：三人合计 75 元，每人 25 元（午餐 18 元、交通 7 元）。';
  await native('release', { text: summary }); await room();
  await until(async () => (await snapshot()).room.messages.some(m => m.text === summary), 'Explicit reply shared');
  assert.equal((await snapshot()).room.messages.some(m => m.text.includes('私人备注')), false);
  checks.push('Explicit preview edits and exact recipient share only selected result; private note/history never enters shared records or the other session');
  await page.locator('#room-filter').selectOption(a); await page.locator('#room-search').fill('出游预算已核对');
  await until(async () => await page.locator('#room-messages article').count() === 1, 'Exact result filter');
  await page.locator('#copy-timeline').click(); const copied = await app.evaluate(() => global.copyValues.at(-1));
  assert.ok(copied.includes(summary)); assert.ok(!copied.includes('私人备注'));
  await page.locator('#room-notes').click(); await page.locator('#room-notes-text').fill('已确认预算\n' + summary); await page.locator('#save-notes').click();
  await until(async () => (await snapshot()).room.notes === '已确认预算\n' + summary, 'Local note saved');
  const noteId = (await snapshot()).room.events.find(e => e.kind === 'notes').id;
  await page.locator('#search-button').click(); await page.locator('#search-scope').selectOption('room'); await page.locator('#search-input').fill('已确认预算');
  await page.locator(`[data-search-key="shared:${noteId}"]`).click();
  await page.locator(`#room-messages [data-message-id="${noteId}"]`).waitFor();
  assert.equal((await native()).sends.length, 2); await shot('local-result-note');
  checks.push('Filter/copy the result, save shared notes and find the saved decision locally: zero additional model submissions');
  await page.locator('#room-search').fill(''); await page.locator('#room-filter').selectOption('');
  // A finite exchange has no directed-send row. Its pause record must keep the
  // exact waiting session reachable without turning private output into sharing.
  await inlineRecipient(page, a);
  await fillRoomMessage(page, '复核这份预算，仍然只算三人午餐和交通。');
  await page.locator('#room-advanced summary').click(); await page.locator('#run-button').click();
  await page.locator('#run-limit').selectOption('2'); await page.locator('#run-consent').check(); await page.locator('#confirm-run').click();
  await until(async () => (await native()).sends.length === 3, 'First bounded reply');
  await native('release', { text: '午餐 54 元加交通 21 元，合计 75 元。请复核。' });
  await until(async () => (await native()).sends.length === 4, 'Second bounded reply');
  await native('event', { target: b, value: { id: 12, method: 'item/commandExecution/requestApproval', params: { command, cwd: '/synthetic', reason: '合成二次复核，不执行命令' } } });
  await until(async () => (await snapshot()).room.run?.status === 'paused', 'Permission pauses exchange');
  const paused = (await snapshot()).room.messages.findLast(m => m.role === 'system' && m.runId);
  assert.equal(paused.sessionId, b);
  const pauseRow = page.locator(`#room-messages [data-message-id="${paused.id}"]`);
  assert.equal(await pauseRow.locator('.message-heading strong').innerText(), '协作');
  const pauseAction = pauseRow.getByRole('button', { name: '查看会话', exact: true });
  await readableAction(pauseAction, 'paused-result-action');
  for (let tabs = 0; tabs < 80 && !(await pauseAction.evaluate(el => el === document.activeElement)); tabs++) await page.keyboard.press('Tab');
  assert.ok(await pauseAction.evaluate(el => el === document.activeElement && el.matches(':focus-visible')), 'Result action reachable with visible keyboard focus');
  await page.keyboard.press('Enter');
  await page.locator('#approval').getByText(command, { exact: true }).waitFor();
  await page.locator('#approval').getByRole('button', { name: '允许这一次', exact: true }).click();
  await page.locator('#approval').getByText('等待原生确认结果', { exact: true }).waitFor();
  assert.deepEqual((await native()).decisions, [{ id: 12, result: { decision: 'accept' } }]);
  await native('event', { target: b, value: { method: 'serverRequest/resolved', params: { requestId: 12 } } });
  const checked = '二次核验完成：75 元和人均 25 元都正确，未增加预算项目。';
  await native('release', { text: checked });
  await room(); await pauseRow.getByRole('button', { name: '查看会话', exact: true }).click();
  await findReply(b, checked);
  assert.equal((await snapshot()).room.messages.some(m => m.text === checked), false);
  assert.equal((await snapshot()).room.run.status, 'paused'); assert.equal((await native()).sends.length, 4);
  assert.equal(await page.locator('#message-input').inputValue(), draft);
  await shot('paused-exchange-private-result');
  checks.push('Finite two-session exchange → permission pause → exact original session → one visible approval → locate private result with existing search; result enters viewport, system authorship and invalid sharing stay intact');
  // A new explicit share is independent of the paused automatic authorization.
  // Preview/cancel is observation only; confirmation delivers only this selection.
  const checkedMessage = (await snapshot()).sessions.find(s => s.id === b).messages.find(m => m.text === checked);
  const checkedRow = page.locator(`#messages [data-message-id="${checkedMessage.id}"]`);
  await checkedRow.getByRole('button', { name: '选择并分享', exact: true }).click();
  await page.locator('#share-text').fill('核验结果：合计 75 元，人均 25 元。');
  await page.locator('#share-recipient').selectOption(a);
  await page.locator('#cancel-share').click();
  assert.equal((await native()).sends.length, 4);
  assert.equal((await snapshot()).room.run.status, 'paused');
  await checkedRow.getByRole('button', { name: '选择并分享', exact: true }).click();
  const selectedCheck = '核验结果：合计 75 元，人均 25 元。请确认这一结论。';
  await page.locator('#share-text').fill(selectedCheck);
  await page.locator('#share-recipient').selectOption(a);
  await page.locator('#confirm-share').click();
  await until(async () => (await native()).sends.length === 5, 'New explicit share after permission pause');
  assert.deepEqual((await native()).sends.at(-1), { id: a, text: selectedCheck });
  const acceptedCheck = '确认预算结论，可以继续安排。';
  await native('release', { text: acceptedCheck });
  await until(async () => (await snapshot()).room.messages.some(m => m.text === acceptedCheck), 'Only newly authorized reply shared');
  assert.equal((await snapshot()).room.run.status, 'paused');
  assert.equal((await snapshot()).room.messages.some(m => m.text === checked), false);
  assert.equal(await page.locator('#message-input').inputValue(), draft);
  checks.push('Cancel then explicitly share a selected private result after permission pause: one exact new delivery, no revival of the old exchange or automatic full-result disclosure');
  await page.locator(`[data-session-menu="${b}"]`).click(); await page.getByRole('menuitem', { name: '归档会话', exact: true }).click();
  await until(async () => (await snapshot()).sessions.find(s => s.id === b).archived, 'Session archived');
  await room();
  await page.locator(`#room-messages [data-message-id="${request.id}"]`).getByRole('button', { name: '查看会话', exact: true }).click();
  await findReply(b, result); assert.equal(await page.locator('#message-input').getAttribute('readonly'), '');
  assert.equal((await snapshot()).sessions.find(s => s.id === b).archived, true);
  await page.getByRole('button', { name: '恢复会话', exact: true }).click();
  await until(async () => !(await snapshot()).sessions.find(s => s.id === b).archived, 'Explicit session restore');
  assert.equal(await page.locator('#message-input').inputValue(), draft);
  checks.push('Private result remains accessible after archive as read-only; explicit restore retains its draft and identity without sending or automatically rejoining');
  await room(); const before = await snapshot(); await app.close(); app = null; await launch();
  const after = await snapshot();
  assert.deepEqual(after.sessions.map(s => [s.id, s.nativeId]), identities);
  assert.deepEqual(after.sessions.map(s => s.messages), before.sessions.map(s => s.messages));
  assert.deepEqual(after.room.messages, before.room.messages); assert.equal(after.room.notes, before.room.notes);
  await page.locator(`[data-session-id="${b}"]`).click(); await page.locator('#chat-tab').click();
  assert.equal(await page.locator('#message-input').inputValue(), draft);
  const log = await native(); assert.equal(log.sends.length, 5); assert.equal(log.modelCalls, 0); assert.deepEqual(errors, []);
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() })));
  assert.deepEqual(windows, [{ visible: false, focusable: false }]);
  checks.push('Close/reopen retains history, local decision, private draft and native identities; one hidden non-focusable window, five authorized synthetic submissions and no model calls');
  console.log(JSON.stringify({ checks, errors, syntheticDispatches: log.sends.length, modelCalls: log.modelCalls, nativeProcesses: log.nativeProcesses, windows, profile }, null, 2));
}
run().catch(async e => { console.error(e.stack); if (page && !page.isClosed()) await shot('failure').catch(() => {}); process.exitCode = 1; }).finally(testScratch.cleanup(async () => {
  if (app) await app.close();
  if (client) { for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); }
  if (child.connected) child.disconnect();
}));
