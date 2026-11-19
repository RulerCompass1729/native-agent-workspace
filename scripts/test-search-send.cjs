const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// 把这句话发给… (product V22 (a)) in the actual hidden Electron renderer and service; synthetic sessions, no model.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { fork } = testScratch.childProcess, { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-search-send-'));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let app, page, client, sequence = 0;
const checks = [], errors = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 160; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value) { const id = ++sequence; return new Promise((resolve, reject) => {
  const callback = result => { if (result.requestId === id) { clearTimeout(timer); child.off('message', callback); resolve(result); } };
  const timer = setTimeout(() => { child.off('message', callback); reject(Error('Fixture timeout')); }, 8000);
  child.on('message', callback); child.send({ id, method, target, value });
}); }
const snapshot = () => page.evaluate(() => workspace.initial());
const session = async id => (await snapshot()).sessions.find(s => s.id === id);
const isOpen = id => page.locator('#' + id).evaluate(el => el.open);
const focused = selector => page.locator(selector).evaluate(el => el === document.activeElement);
async function launch() {
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#search-button').waitFor();
}
async function resize(width, height) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height });
  await until(() => page.evaluate(size => innerWidth === size.width && innerHeight === size.height, { width, height }), 'Window size');
}
async function create(name, provider = 'codex') {
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => s.name === name && s.state === 'idle' && !seen.has(s.id)), 'Create ' + name);
  const id = (await snapshot()).sessions.find(s => s.name === name && !seen.has(s.id)).id; seen.add(id); return id;
}
const seen = new Set();
async function openSearch(query) {
  await page.locator('#search-button').click(); await page.locator('#search-dialog').waitFor();
  await page.locator('#search-input').fill(query); await delay(160);
}
async function openSend(query) {
  await openSearch(query); await page.locator('#search-send').click(); await page.locator('#send-dialog').waitFor();
}
const rowIds = () => page.locator('#send-list input[name="send-target"]').evaluateAll(list => list.map(el => el.value));
const checkedIds = () => page.locator('#send-list input[name="send-target"]').evaluateAll(list => list.filter(el => el.checked).map(el => el.value));
const radio = id => page.locator(`#send-list input[value="${id}"]`);
const stats = () => fixture('stats');
async function closeAll() {
  for (const id of ['send-dialog', 'search-dialog']) if (await isOpen(id)) { await page.keyboard.press('Escape'); await until(async () => !(await isOpen(id)), 'Closed ' + id); }
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Service ready'); client = await connect(profile, 'search-send-observer'); await launch();
  const study = await create('学习记录'), budget = await create('周末预算', 'claude'), stopped = await create('已停会话'), held = await create('别处会话');
  await client.call('stop', stopped);
  await until(async () => (await session(stopped)).state !== 'idle', 'Stopped');
  await fixture('set-owner', held, 'another-owned-view');
  await until(async () => (await session(held)).owner === 'another-owned-view', 'Held elsewhere');
  await fixture('history', study, [{ id: 'note-1', type: 'agentMessage', text: '复习计划：先做错题' }]);
  await delay(200);
  const sentences = [];

  // 1. The original search, Enter and arrow keys are unchanged; the new button sits after × in Tab order (K1, K2).
  await openSearch('复习计划');
  assert.ok(await page.locator('#search-results button').count() >= 1, 'Search still finds the record');
  assert.equal(await page.locator('#search-send').isVisible(), true);
  assert.equal(await page.locator('#search-send').innerText(), '把这句话发给…');
  await page.locator('#search-input').focus(); await page.keyboard.press('Tab'); assert.equal(await focused('#close-search'), true, 'Tab: input → ×');
  await page.keyboard.press('Tab'); assert.equal(await focused('#search-send'), true, 'Tab: × → send button');
  await page.locator('#search-input').focus(); await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('#search-results button').first().evaluate(el => el === document.activeElement), true, 'ArrowDown enters results');
  await page.keyboard.press('ArrowUp'); assert.equal(await focused('#search-input'), true, 'ArrowUp on the first result returns to the input');
  await page.locator('#search-input').press('Enter');
  await until(async () => (await snapshot()).viewState.selected === study && !(await isOpen('search-dialog')), 'Enter opens the first result');
  assert.equal(await isOpen('send-dialog'), false);
  await openSearch('没有任何结果的一句话 zq');
  assert.equal(await page.locator('#search-results button').count(), 0);
  await page.locator('#search-input').press('Enter'); await delay(200);
  assert.equal(await isOpen('send-dialog'), false, 'Enter without results opens no send dialog');
  assert.equal(await isOpen('search-dialog'), true);
  await page.locator('#search-input').fill(''); await delay(50);
  assert.equal(await page.locator('#search-send').isVisible(), false, 'No sentence, no button');
  await closeAll();
  assert.equal((await stats()).sends.length, 0);
  checks.push('Original search: results, Enter opens the first result, arrows move as before; Enter with no results sends nothing; the button follows × in Tab order and hides for an empty box');

  // 2. A named session is preselected; stopped and held-elsewhere sessions are not candidates (A1, K3–K6, G1).
  const named = '请学习记录把今天的错题整理一下'; sentences.push(named);
  await openSearch(named);
  assert.equal(await page.locator('#search-send').innerText(), '把这句话发给 学习记录');
  assert.equal(await page.locator('#search-send').evaluate(el => el.classList.contains('primary')), true);
  await page.locator('#search-send').click(); await page.locator('#send-dialog').waitFor();
  assert.equal(await page.getByRole('dialog', { name: '把这句话发给它', exact: true }).count(), 1, 'A1 accessible name');
  assert.equal(await focused('#send-text'), true, 'K3 focus starts in the text');
  assert.equal(await page.locator('#send-text').inputValue(), named);
  const rows = await rowIds();
  assert.deepEqual(rows.slice(0, 1), [study]); assert.ok(rows.includes(budget)); assert.equal(rows.at(-1), 'new');
  assert.ok(!rows.includes(stopped) && !rows.includes(held), 'Stopped and held-elsewhere sessions are not candidates');
  assert.ok(rows.length <= 4);
  assert.deepEqual(await checkedIds(), [study]);
  assert.equal(await page.locator('#send-confirm').innerText(), '发送'); assert.equal(await page.locator('#send-confirm').isEnabled(), true);
  await page.locator('#send-text').press('Enter');
  assert.equal(await page.locator('#send-text').inputValue(), named + '\n', 'K3 Enter in the text adds a line');
  assert.equal(await isOpen('send-dialog'), true);
  await page.locator('#send-text').fill(named);
  await page.keyboard.press('Tab'); assert.equal(await radio(study).evaluate(el => el === document.activeElement), true, 'K6 Tab: text → recipients');
  await page.keyboard.press('Tab'); assert.equal(await focused('#send-cancel'), true, 'K6 Tab → 取消');
  await page.keyboard.press('Tab'); assert.equal(await focused('#send-confirm'), true, 'K6 Tab → 发送');
  const imeEscape = await page.locator('#send-text').evaluate(el => { const event = new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }); el.dispatchEvent(event); return event.defaultPrevented; });
  assert.equal(imeEscape, true, 'K4 the dialog handler holds Escape while composing'); assert.equal(await isOpen('send-dialog'), true);
  await page.locator('#send-text').focus(); await page.keyboard.press('Escape');
  await until(async () => !(await isOpen('send-dialog')), 'K5 Escape closes the send dialog');
  assert.equal(await isOpen('search-dialog'), true, 'K5 search stays open'); assert.equal(await page.locator('#search-input').inputValue(), named);
  await until(() => focused('#search-send'), 'K5 focus returns to the send button');
  await page.locator('#search-send').click(); await page.locator('#send-dialog').waitFor();
  await page.locator('#send-cancel').click(); await until(async () => !(await isOpen('send-dialog')), 'G1 cancel');
  await closeAll();
  assert.equal((await stats()).sends.length, 0, 'Cancel and Escape send nothing');
  checks.push('Named session preselected with its name on the button; stopped and held-elsewhere sessions absent; dialog name, focus, Enter-as-newline, Tab order, IME Escape, Escape-only-this-dialog and Cancel all send nothing');

  // 3. A selected session that can no longer take the sentence is let go, never swapped (r2-4); no name → no preselect (G7).
  const plain = '帮我看一下这周的安排'; sentences.push(plain);
  await openSend(plain);
  assert.equal(await page.locator('#search-send').innerText(), '把这句话发给…');
  assert.deepEqual(await checkedIds(), [], 'G7 no name, no preselect'); assert.equal(await page.locator('#send-confirm').isEnabled(), false);
  await radio(study).check(); assert.equal(await page.locator('#send-confirm').isEnabled(), true);
  await fixture('set-state', study, 'working');
  await until(() => radio(study).isDisabled(), 'Target became unable to receive');
  assert.deepEqual(await checkedIds(), [], 'Unselected, nothing else selected');
  assert.equal(await page.locator('#send-note').innerText(), '「学习记录」现在不能发，请重新选择。');
  assert.equal(await page.locator('#send-confirm').isEnabled(), false);
  assert.match(await radio(study).locator('xpath=..').innerText(), /现在不能发/);
  await fixture('set-state', study, 'idle');
  await until(async () => !(await radio(study).isDisabled()), 'Target can receive again');
  assert.deepEqual(await checkedIds(), [], 'Not reselected by itself');
  await closeAll();
  const two = '学习记录和周末预算都看一下'; sentences.push(two);
  await openSend(two);
  assert.equal(await page.locator('#search-send').innerText(), '把这句话发给…', 'G6 two names: the plain button');
  assert.deepEqual(await checkedIds(), [], 'G6 two names: nothing preselected'); assert.equal(await page.locator('#send-confirm').isEnabled(), false);
  const both2 = await rowIds(); assert.ok(both2.includes(study) && both2.includes(budget));
  await closeAll();
  assert.equal((await stats()).sends.length, 0);
  checks.push('No name or two names: nothing preselected and Send disabled; a chosen session that turns busy is unselected with a note, nothing else is chosen, and it is not reselected when it recovers');

  // 4. Send goes through deliverSessionInput's send; a double click while the native send is held sends once (G5);
  // the notice reads the message row's own delivery status.
  await fixture('hold-send', study);
  await openSend(named);
  assert.deepEqual(await checkedIds(), [study]);
  await page.locator('#send-confirm').evaluate(el => { el.click(); el.click(); });
  await until(async () => (await stats()).waitingSends.includes(study), 'Held send reached native');
  assert.equal(await page.locator('#send-confirm').isDisabled(), true, 'Locked while sending'); assert.equal(await isOpen('send-dialog'), true);
  await page.locator('#send-confirm').click({ force: true }).catch(() => {});
  await fixture('release-send', study);
  await until(async () => !(await isOpen('send-dialog')) && !(await isOpen('search-dialog')), 'Dialogs close after the receipt');
  await until(async () => (await page.locator('#toast-text').innerText()) === '学习记录：原生已接收', 'Notice shows the row status');
  let s = await stats();
  assert.deepEqual(s.sends, [{ id: study, text: named }], 'Exactly one send, to the chosen session, with the confirmed text');
  const row = (await session(study)).messages.find(m => m.role === 'user' && m.text === named);
  assert.equal(row?.status, 'submitted', 'The row the notice reads');
  await fixture('complete', study, { text: '好的' });
  await until(async () => (await session(study)).state === 'idle', 'Turn done');
  checks.push('Send uses the send path once despite a double click and a click while locked; the notice shows the message row status (原生已接收)');

  // 5. A working Claude session takes it through the queue (K7: Enter on the focused Send).
  await fixture('queue-capable', budget, true); await fixture('set-state', budget, 'working');
  await until(async () => { const b = await session(budget); return b.queueAvailable && b.state === 'working'; }, 'Queue-capable working session');
  const queued = '周末预算 下周三前把账单对一下'; sentences.push(queued);
  await openSend(queued);
  assert.deepEqual(await checkedIds(), [budget]);
  await until(async () => /等本轮结束后发送/.test(await radio(budget).locator('xpath=..').innerText()), 'The window sees the working session');
  assert.equal(await page.locator('#send-confirm').innerText(), '等本轮结束后发送');
  assert.match(await radio(budget).locator('xpath=..').innerText(), /等本轮结束后发送/);
  await page.evaluate(() => { window.toastTexts = []; new MutationObserver(() => window.toastTexts.push(document.getElementById('toast-text').textContent)).observe(document.getElementById('toast-text'), { childList: true, characterData: true, subtree: true }); });
  await page.locator('#send-confirm').focus(); await page.keyboard.press('Enter');
  await until(async () => (await page.locator('#toast-text').innerText()) === '周末预算：接收结果未确认', 'Notice follows the queued row to its recorded outcome');
  const texts = await page.evaluate(() => window.toastTexts.filter(Boolean));
  assert.ok(texts.every(text => ['周末预算：排队中，等空闲后发送', '周末预算：等待原生确认', '周末预算：接收结果未确认'].includes(text)), 'Only the row statuses: ' + JSON.stringify(texts));
  s = await stats();
  assert.deepEqual(s.queued, [{ id: budget, text: queued }]); assert.equal(s.sends.length, 1, 'Queue, not send');
  assert.equal(await isOpen('send-dialog'), false, 'An uncertain queued message is not offered again');
  checks.push('A working Claude session gets the queue (button 等本轮结束后发送, Enter on focused Send); the notice only shows recorded row statuses ' + JSON.stringify(texts));

  // 5b. C1: a click sends only the way its button showed. When the way changes while the click loads that
  // session's messages (the held reply below), nothing is sent and the note asks again; the next click sends once,
  // the new way. Unchanged ways send at the first click (groups 4, 5). queue → steer cannot happen to one session
  // (queue is Claude-only, steer Codex-only), so queue → send here and send → steer in 6b.
  const note = () => page.locator('#send-note').innerText();
  await app.evaluate(({ ipcMain }) => {
    const key = 'workspace:shownSessions', original = ipcMain._invokeHandlers.get(key); if (!original) throw Error(key);
    globalThis.searchSendHold = { on: false, held: [] };
    ipcMain._invokeHandlers.set(key, async (event, ...args) => {
      if (globalThis.searchSendHold.on) await new Promise(resolve => globalThis.searchSendHold.held.push(resolve));
      return original(event, ...args);
    });
  });
  const hold = () => app.evaluate(() => { globalThis.searchSendHold.on = true; });
  const heldCalls = () => app.evaluate(() => globalThis.searchSendHold.held.length);
  const release = () => app.evaluate(() => { globalThis.searchSendHold.on = false; globalThis.searchSendHold.held.splice(0).forEach(resolve => resolve()); });
  // The click waits only for a session whose messages this window does not hold (off screen): a fresh Claude
  // session, then 学习记录 opened again.
  const ledger = await create('账单助手', 'claude');
  await openSearch('复习计划'); await page.locator('#search-input').press('Enter');
  await until(async () => (await snapshot()).viewState.selected === study && !(await isOpen('search-dialog')), 'Back to 学习记录');
  await fixture('queue-capable', ledger, true); await fixture('set-state', ledger, 'working');
  await until(async () => { const x = await session(ledger); return x.queueAvailable && x.state === 'working' && x.messagesOmitted; }, 'Off-screen working Claude session');
  const afterQueue = '账单助手 账单对完再记一笔'; sentences.push(afterQueue);
  await openSend(afterQueue);
  assert.deepEqual(await checkedIds(), [ledger]);
  await until(async () => (await page.locator('#send-confirm').innerText()) === '等本轮结束后发送', 'Shown as queue');
  await hold(); await page.locator('#send-confirm').click();
  await until(async () => (await heldCalls()) > 0, 'The click waits for the messages');
  await fixture('set-state', ledger, 'idle');
  await until(async () => (await page.locator('#send-confirm').innerText()) === '发送', 'The turn ends during the wait');
  await release();
  await until(async () => { const x = await stats(); return (await note()) || x.sends.length > 1 || x.queued.length > 1; }, 'C1 queue → send click settles');
  s = await stats();
  assert.deepEqual(s.sends.slice(1), [], 'C1 queue → send: nothing sent at that click'); assert.equal(s.queued.length, 1, 'C1: not queued either');
  assert.equal(await note(), '「账单助手」的发送方式变了，现在是「发送」。确认无误请再点一次。');
  assert.equal(await isOpen('send-dialog'), true); assert.deepEqual(await checkedIds(), [ledger], 'Same recipient, not swapped');
  await page.locator('#send-confirm').click();
  await until(async () => (await page.locator('#toast-text').innerText()) === '账单助手：原生已接收', 'Reconfirmed send notice');
  s = await stats();
  assert.deepEqual(s.sends.at(-1), { id: ledger, text: afterQueue }); assert.equal(s.sends.length, 2, 'C1 reconfirmed: one send'); assert.equal(s.queued.length, 1);
  await fixture('complete', ledger, { text: '好的' }); await until(async () => (await session(ledger)).state === 'idle', 'Ledger idle');
  checks.push('C1 queue → send: the turn ended while the click loaded messages; nothing sent or queued, the note names the new way, the recipient stays; the next click sends once');

  // 6. Two sessions with the same name: nothing preselected, rows told apart by short id (G11).
  const twin = await create('学习记录');
  const both = '学习记录 明天复盘'; sentences.push(both);
  await openSend(both);
  assert.equal(await page.locator('#search-send').innerText(), '把这句话发给…');
  assert.deepEqual(await checkedIds(), []);
  const twinRows = await rowIds(); assert.ok(twinRows.includes(study) && twinRows.includes(twin));
  const lines = await Promise.all([study, twin].map(id => radio(id).locator('xpath=..').locator('small').innerText()));
  assert.notEqual(lines[0], lines[1]);
  await closeAll();
  checks.push('Two same-named sessions: none preselected, rows distinguished by short id ' + JSON.stringify(lines));

  // 6b. C1 send → steer: the Codex session (off screen now: the twin is open) starts a turn during the click's wait.
  const steer = '学习记录 错题按章节排一下'; sentences.push(steer); // both same-named rows listed, one chosen by hand
  await fixture('steer-capable', study, true);
  await until(async () => (await session(study)).messagesOmitted, '学习记录 off screen');
  await openSend(steer); await radio(study).check();
  assert.equal(await page.locator('#send-confirm').innerText(), '发送');
  await hold(); await page.locator('#send-confirm').click();
  await until(async () => (await heldCalls()) > 0, 'The click waits for the messages');
  await fixture('native-activity', study, { turnId: 'turn-1', label: '正在处理' });
  await until(async () => (await page.locator('#send-confirm').innerText()) === '追加指令', 'The turn starts during the wait');
  await release();
  await until(async () => { const x = await stats(); return (await note()) || x.sends.length > 2 || x.steered.length; }, 'C1 send → steer click settles');
  s = await stats();
  assert.deepEqual(s.steered, [], 'C1 send → steer: nothing steered at that click'); assert.equal(s.sends.length, 2, 'C1: not sent either');
  assert.match(await note(), /^「学习记录[^」]*」的发送方式变了，现在是「追加指令」。确认无误请再点一次。$/);
  assert.deepEqual(await checkedIds(), [study]);
  await page.locator('#send-confirm').click();
  await until(async () => !(await isOpen('send-dialog')), 'Reconfirmed steer closes the dialog');
  await until(async () => /^学习记录[^：]*：原生已接收$/.test(await page.locator('#toast-text').innerText()), 'Steer notice follows its row');
  const steerNotice = await page.locator('#toast-text').innerText();
  s = await stats();
  assert.deepEqual(s.steered, [{ id: study, text: steer, turnId: 'turn-1' }], 'C1 reconfirmed: one steer into that turn'); assert.equal(s.sends.length, 2);
  const steerRow = (await client.call('initial')).sessions.find(x => x.id === study).messages.find(m => m.text === steer);
  assert.equal(steerRow?.inputMode, 'steer'); assert.equal(steerRow.turnId, 'turn-1');
  await fixture('native-activity', study, null); await until(async () => (await session(study)).state === 'idle', 'Study idle');
  await closeAll();
  checks.push('C1 send → steer: a turn started while the click loaded messages; nothing sent or steered, the note names 追加指令; the next click steers once into that turn (' + steerNotice + ')');

  // 7. 850×600: the dialog and its buttons fit without horizontal scrolling.
  await resize(850, 600);
  await openSend(named);
  const fit = await page.evaluate(() => {
    const dialog = document.getElementById('send-dialog'), box = dialog.getBoundingClientRect(), inside = el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; };
    return { inside: inside(dialog) && inside(document.getElementById('send-cancel')) && inside(document.getElementById('send-confirm')), overflow: dialog.scrollWidth - dialog.clientWidth, width: Math.round(box.width), height: Math.round(box.height) };
  });
  assert.equal(fit.inside, true); assert.equal(fit.overflow, 0);
  await closeAll(); await resize(1240, 820);
  checks.push('850×600: dialog, 取消 and 发送 inside the window, no horizontal overflow ' + JSON.stringify(fit));

  // 8. 新开一个: the unchanged create dialog; cancelling it drops the sentence (G8, G9); a created session gets it
  // only after the reopened dialog is confirmed (G10).
  const dropped = '新开一个会话写周报草稿'; sentences.push(dropped);
  const before = (await stats()).sends.length;
  await openSend(dropped);
  await radio('new').check();
  assert.equal(await page.locator('#send-confirm').innerText(), '下一步：新建会话');
  await page.locator('#send-confirm').click();
  await page.locator('#create-dialog').waitFor();
  assert.equal(await isOpen('send-dialog'), false); assert.equal(await isOpen('search-dialog'), false);
  assert.equal(await page.locator('#session-name').inputValue(), '', 'Nothing put into the create form');
  await page.keyboard.press('Escape'); await page.locator('#create-dialog').waitFor({ state: 'hidden' });
  await delay(600);
  assert.equal(await isOpen('send-dialog'), false, 'Cancelled create drops the sentence');
  // C2: the 取消 button (a plain close(), no cancel event) ends the handoff too; a later unrelated session never gets it.
  const buttoned = '新开一个会话列下周采购'; sentences.push(buttoned);
  await openSend(buttoned);
  await radio('new').check(); await page.locator('#send-confirm').click(); await page.locator('#create-dialog').waitFor();
  await page.locator('#cancel-create').click(); await page.locator('#create-dialog').waitFor({ state: 'hidden' });
  await delay(600);
  assert.equal(await isOpen('send-dialog'), false, 'C2 button cancel drops the sentence');
  await create('无关会话');
  await delay(600);
  assert.equal(await isOpen('send-dialog'), false, 'C2 an unrelated new session does not reopen it');
  assert.equal(await page.locator('#send-text').inputValue(), '', 'C2 the sentence is gone');
  assert.equal((await stats()).sends.length, before, 'C2 nothing sent');
  const kept = '新开一个会话整理会议纪要'; sentences.push(kept);
  await openSend(kept);
  await radio('new').check(); await page.locator('#send-confirm').click(); await page.locator('#create-dialog').waitFor();
  await page.locator('input[name="provider"][value="codex"]').check(); await page.locator('#session-name').fill('纪要助手');
  await page.locator('#initial-view').selectOption('chat'); await page.locator('#confirm-create').click();
  await until(() => isOpen('send-dialog'), 'Send dialog returns once the new session is ready');
  const fresh = (await snapshot()).sessions.find(x => x.name === '纪要助手');
  assert.equal(fresh.state, 'idle');
  assert.equal(await page.locator('#send-text').inputValue(), kept);
  assert.deepEqual(await checkedIds(), [fresh.id]); assert.equal(await page.locator('#send-confirm').innerText(), '发送');
  assert.equal((await stats()).sends.length, before, 'Nothing sent before the person confirms');
  await page.locator('#send-confirm').click();
  await until(async () => (await page.locator('#toast-text').innerText()) === '纪要助手：原生已接收', 'New session notice');
  s = await stats();
  assert.deepEqual(s.sends.at(-1), { id: fresh.id, text: kept }); assert.equal(s.sends.length, before + 1);
  checks.push('新开一个: 下一步 opens the unchanged create dialog; Escape and the 取消 button there drop the sentence, and a later unrelated session does not get it (C2); after creating, the same dialog returns with the new session preselected and sends only on 发送');

  // 9. Restart: no sentence in views.json or any draft; the native work is exactly what was confirmed.
  await app.close(); app = null;
  const disk = fs.readFileSync(path.join(profile, 'views.json'), 'utf8');
  for (const sentence of sentences) assert.ok(!disk.includes(sentence), 'views.json holds no sentence');
  await launch();
  const after = await snapshot();
  for (const record of after.sessions) for (const sentence of sentences) assert.ok(!(record.liveDraft || '').includes(sentence), 'No draft holds a sentence');
  s = await stats();
  assert.deepEqual(s.sends, [{ id: study, text: named }, { id: ledger, text: afterQueue }, { id: fresh.id, text: kept }]);
  assert.deepEqual(s.queued, [{ id: budget, text: queued }]); assert.deepEqual(s.steered, [{ id: study, text: steer, turnId: 'turn-1' }]);
  assert.deepEqual(s.inputs, []); assert.deepEqual(s.interruptions, []);
  checks.push('After restart: no sentence in views.json or drafts; native work is exactly the 3 confirmed sends, 1 queue and 1 steer, with no terminal input or interrupt');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors, modelTasks: 0, profile, scriptSha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(__filename)).digest('hex') }, null, 2));
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(testScratch.cleanup(async () => {
  try { if (app) await app.close(); if (client) { for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); } }
  finally { if (child.connected) child.disconnect(); if (child.exitCode === null) child.kill('SIGTERM'); }
}));
