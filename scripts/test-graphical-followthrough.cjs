// Existing seven-group graphical followthrough journey, isolated source GUI and synthetic providers only.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const plan = { task: 'T33 current graphical followthrough source GUI', fullGuiStarts: 2, ownedSyntheticDaemons: 1, syntheticSessions: 2, syntheticSends: 5, syntheticTerminalInputBytes: 1, syntheticApprovalDecisions: 1, nativeCliCalls: 0, productModels: 0, realProviders: 0, osClipboard: 0, maxRunMs: 300000 };
if (process.argv.includes('--plan')) { console.log(JSON.stringify(plan, null, 2)); process.exit(0); }
assert.equal(process.env.NAW_T33_FOLLOWTHROUGH_GUI_AUTHORIZED, '1', 'Record the finite source GUI plan before running');
assert.ok(!process.env.NAW_EXPECT_NAVIGATION_GAP, 'Whole-journey qualification excludes the legacy early-return diagnostic');
assert.ok(!process.env.NAW_APP_EXECUTABLE && path.resolve(code) === root, 'This recipe qualifies source only; Main owns installed acceptance');
const evidence = process.env.NAW_EVIDENCE_DIR;
assert.ok(evidence && path.isAbsolute(evidence), 'Private outside-repository evidence is required');
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.resolve(common, '..', '.local/gui-test-slot.lock'), token = randomUUID();
let existing = evidence;
while (!fs.existsSync(existing)) existing = path.dirname(existing);
const destination = path.resolve(fs.realpathSync(existing), path.relative(existing, evidence));
for (const repo of [fs.realpathSync(root), fs.realpathSync(path.resolve(slot, '../..'))]) assert.ok(destination !== repo && !destination.startsWith(repo + path.sep), 'Evidence must be outside both repositories');
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('OCCUPIED: no profile, daemon or GUI started'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex 3', task: plan.task, token, pid: process.pid, time: new Date().toISOString() }));
const testScratch = require('./fixtures/test-scratch.cjs');
const { fork } = testScratch.childProcess;
const { _electron } = testScratch.playwright(require('playwright'));
const { createIn } = require('./fixtures/create-view.cjs');
const { chooseRecipient: inlineRecipient, fillRoomMessage, roomBody } = require('./room-input.cjs');
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const env = additions => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NAW_') && !key.startsWith('ELECTRON_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(key))), ...additions });
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-graphical-followthrough-'));
const entry = path.join(profile, 'entry'); fs.mkdirSync(entry);
fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ name: 'naw-owned-followthrough-gui', version: require('../package.json').version, main: 'main.cjs' }));
fs.writeFileSync(path.join(entry, 'main.cjs'), `const cp=require('node:child_process'),path=require('node:path'),e=require('electron');
globalThis.followthroughGuards={clipboard:0,external:0,dialogs:0,maintenance:0,replacement:0};
const spawn=cp.spawn;cp.spawn=function(bin,args,...rest){if(Array.isArray(args)&&args.some(arg=>typeof arg==='string'&&path.basename(arg)==='daemon.cjs')){globalThis.followthroughGuards.replacement++;throw Error('Replacement backend prohibited');}return spawn.call(this,bin,args,...rest);};
for(const name of ['readText','writeText','readImage','writeImage','read','write','readBuffer','writeBuffer','clear'])e.clipboard[name]=()=>{globalThis.followthroughGuards.clipboard++;throw Error('OS clipboard prohibited');};
e.shell.openPath=e.shell.openExternal=async()=>{globalThis.followthroughGuards.external++;throw Error('External action prohibited');};
e.dialog.showOpenDialog=e.dialog.showMessageBox=async()=>{globalThis.followthroughGuards.dialogs++;throw Error('OS dialog prohibited');};
const {WorkspaceClient}=require(${JSON.stringify(path.join(root, 'app/workspace-client.cjs'))});WorkspaceClient.prototype.maintainService=function(){globalThis.followthroughGuards.maintenance++;throw Error('Backend update prohibited');};
require(${JSON.stringify(path.join(root, 'app/main.cjs'))});`);
const executablePath = require('electron'), args = [entry];
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/daily-native.cjs')], env: env({ NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code }), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let app, page, client, sequence = 0, failure, fullStarts = 0;
const guiPids = [], guardSamples = [], copyBatches = [], started = Date.now();
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
const shot = async name => {
  if (!page || page.isClosed()) return;
  fs.mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: path.join(evidence, name + '.png') });
  fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(await snapshot(), null, 2));
  const ui = await page.evaluate(() => ({ privateDraft: document.querySelector('#message-input').value, sharedDraft: document.querySelector('#shared-input').value, shareOpen: document.querySelector('#share-dialog').open, shareText: document.querySelector('#share-text').value, shareRecipient: document.querySelector('#share-recipient').value, filter: document.querySelector('#room-filter').value, search: document.querySelector('#room-search').value }));
  fs.writeFileSync(path.join(evidence, name + '.ui.json'), JSON.stringify(ui, null, 2));
};
async function guards() { const values = await app.evaluate(() => globalThis.followthroughGuards); assert.deepEqual(values, { clipboard: 0, external: 0, dialogs: 0, maintenance: 0, replacement: 0 }); guardSamples.push(values); }
async function check(text) { assert.ok(Date.now() - started < plan.maxRunMs, 'Five-minute stage-entry budget'); checks.push(text); console.log('PASS:', text); await shot('stage-' + String(checks.length).padStart(2, '0')); }
async function openSearchScope(scope) { await page.locator('#search-button').click(); await page.locator('#search-options > summary').click(); await page.locator('#search-scope').selectOption(scope); }
async function selectSession(id) {
  const row = page.locator(`#session-list .session-link[data-session-id="${id}"]`);
  if (!(await row.isVisible()) && (await snapshot()).viewState.sidebarSpaceFilter) await page.locator('#clear-space-filter').click();
  await row.click();
}
async function launch() {
  assert.ok(fullStarts++ < plan.fullGuiStarts, 'At most the two planned full GUI starts');
  app = await _electron.launch({ executablePath, args, env: env({ NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }), timeout: 70000 }); guiPids.push(app.process().pid);
  page = await app.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor();
  // Leave the person's clipboard untouched; capture only this app's copy calls.
  await app.evaluate(({ clipboard }) => { global.copyValues = []; clipboard.writeText = text => global.copyValues.push(text); });
  await guards();
}
async function create(provider, name) {
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => s.name === name && s.chatAvailable), 'Native attachment ready');
  const s = (await snapshot()).sessions.find(s => s.name === name);
  const shared = (await snapshot()).rooms.find(room => room.id === 'shared');
  await page.locator(`[data-session-menu="${s.id}"]`).click();
  await page.getByRole('menuitem', { name: `加入「${shared.name}」`, exact: true }).click();
  await until(async () => (await snapshot()).sessions.find(row => row.id === s.id).roomIds?.includes('shared'), 'Visible membership acknowledged'); return s.id;
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
  await openSearchScope('current');
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
  const backend = await client.call('initial'); assert.equal(backend.servicePid, child.pid); assert.equal(backend.runtimeVersion, require('../package.json').version); assert.equal(backend.sessions.length, 0);
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
  await selectSession(b); await page.locator('#chat-tab').click();
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
  await check('Directed budget task → native confirmation → terminal intervention → private result is reachable from its shared record; same identity/draft, no automatic re-sharing');
  // Reuse the existing preview, selecting only what this next recipient needs.
  // Message actions appear while the pointer is over the message, as for a person.
  await answer.hover(); await answer.getByRole('button', { name: '选择并分享：Codex的回复', exact: true }).click();
  const selected = '已核查：合计 75 元，人均 25 元。请整理成一句可发给同行人的结论。';
  await page.locator('#share-text').fill(selected); await page.locator('#share-recipient').selectOption(a);
  assert.equal((await native()).sends.length, 1); await page.locator('#confirm-share').click();
  await until(async () => (await native()).sends.length === 2, 'Explicit selected result shared once');
  assert.deepEqual((await native()).sends.at(-1), { id: a, text: selected });
  const summary = '出游预算已核对：三人合计 75 元，每人 25 元（午餐 18 元、交通 7 元）。';
  await native('release', { text: summary }); await room();
  await until(async () => (await snapshot()).room.messages.some(m => m.text === summary), 'Explicit reply shared');
  assert.equal((await snapshot()).room.messages.some(m => m.text.includes('私人备注')), false);
  await check('Explicit preview edits and exact recipient share only selected result; private note/history never enters shared records or the other session');
  await page.locator('#room-filter').selectOption(a); await page.locator('#room-search').fill('出游预算已核对');
  await until(async () => await page.locator('#room-messages article').count() === 1, 'Exact result filter');
  await page.locator('#copy-timeline').click(); const copied = await app.evaluate(() => global.copyValues.at(-1));
  assert.ok(copied.includes(summary)); assert.ok(!copied.includes('私人备注'));
  await page.locator('#room-notes').click(); await page.locator('#room-notes-text').fill('已确认预算\n' + summary); await page.locator('#save-notes').click();
  await until(async () => (await snapshot()).room.notes === '已确认预算\n' + summary, 'Local note saved');
  const noteId = (await snapshot()).room.events.find(e => e.kind === 'notes').id;
  await openSearchScope('room'); await page.locator('#search-input').fill('已确认预算');
  await page.locator(`[data-search-key="shared:${noteId}"]`).click();
  await page.locator(`#room-messages [data-message-id="${noteId}"]`).waitFor();
  assert.equal((await native()).sends.length, 2); await shot('local-result-note');
  await check('Filter/copy the result, save shared notes and find the saved decision locally: zero additional model submissions');
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
  assert.equal(await pauseRow.locator('.message-heading .message-author').innerText(), '协作');
  const pauseAction = pauseRow.getByRole('button', { name: '查看会话', exact: true });
  await readableAction(pauseAction, 'paused-result-action');
  for (let tabs = 0; tabs < 80 && !(await pauseAction.evaluate(el => el === document.activeElement)); tabs++) await page.keyboard.press('Tab');
  assert.ok(await pauseAction.evaluate(el => el === document.activeElement && el.matches(':focus-visible')), 'Result action reachable with visible keyboard focus');
  await page.keyboard.press('Enter');
  await page.locator('#approval').getByText(command, { exact: true }).waitFor();
  await page.locator('#approval').getByRole('button', { name: '允许这一次', exact: true }).click();
  // The heading names the session: "<name> · 等待原生确认结果".
  await page.locator('#approval').getByText(/ · 等待原生确认结果$/).waitFor();
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
  await check('Finite two-session exchange → permission pause → exact original session → one visible approval → locate private result with existing search; result enters viewport, system authorship and invalid sharing stay intact');
  // A new explicit share is independent of the paused automatic authorization.
  // Preview/cancel is observation only; confirmation delivers only this selection.
  const checkedMessage = (await snapshot()).sessions.find(s => s.id === b).messages.find(m => m.text === checked);
  const checkedRow = page.locator(`#messages [data-message-id="${checkedMessage.id}"]`);
  await checkedRow.hover(); await checkedRow.getByRole('button', { name: '选择并分享：Codex的回复', exact: true }).click();
  await page.locator('#share-text').fill('核验结果：合计 75 元，人均 25 元。');
  await page.locator('#share-recipient').selectOption(a);
  await page.locator('#cancel-share').click();
  assert.equal((await native()).sends.length, 4);
  assert.equal((await snapshot()).room.run.status, 'paused');
  await checkedRow.hover(); await checkedRow.getByRole('button', { name: '选择并分享：Codex的回复', exact: true }).click();
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
  await check('Cancel then explicitly share a selected private result after permission pause: one exact new delivery, no revival of the old exchange or automatic full-result disclosure');
  await page.locator(`[data-session-menu="${b}"]`).click(); await page.getByRole('menuitem', { name: '归档会话', exact: true }).click();
  await until(async () => (await snapshot()).sessions.find(s => s.id === b).archived, 'Session archived');
  await room();
  await page.locator(`#room-messages [data-message-id="${request.id}"]`).getByRole('button', { name: '查看会话', exact: true }).click();
  await findReply(b, result); assert.equal(await page.locator('#message-input').getAttribute('readonly'), '');
  assert.equal((await snapshot()).sessions.find(s => s.id === b).archived, true);
  await page.getByRole('button', { name: '恢复会话', exact: true }).click();
  await until(async () => !(await snapshot()).sessions.find(s => s.id === b).archived, 'Explicit session restore');
  assert.equal(await page.locator('#message-input').inputValue(), draft);
  await check('Private result remains accessible after archive as read-only; explicit restore retains its draft and identity without sending or automatically rejoining');
  await room(); const before = await snapshot(); await guards(); copyBatches.push(await app.evaluate(() => global.copyValues)); await app.close(); app = null; await launch();
  const after = await snapshot();
  assert.deepEqual(after.sessions.map(s => [s.id, s.nativeId]), identities);
  assert.deepEqual(after.sessions.map(s => s.messages), before.sessions.map(s => s.messages));
  assert.deepEqual(after.room.messages, before.room.messages); assert.equal(after.room.notes, before.room.notes);
  await selectSession(b); await page.locator('#chat-tab').click();
  assert.equal(await page.locator('#message-input').inputValue(), draft);
  const log = await native(); assert.equal(log.sends.length, 5); assert.equal(log.modelCalls, 0); assert.deepEqual(log.inputs, [{ id: b, data: '\r' }]); assert.deepEqual(log.decisions, [{ id: 12, result: { decision: 'accept' } }]); assert.deepEqual(errors, []); await guards(); assert.equal(copyBatches.flat().length + (await app.evaluate(() => global.copyValues)).length, 1, 'Only the explicit filtered copy used the in-memory clipboard');
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() })));
  assert.deepEqual(windows, [{ visible: false, focusable: false }]);
  await check('Close/reopen retains history, local decision, private draft and native identities; one hidden non-focusable window, five authorized synthetic submissions and no model calls');
  console.log(JSON.stringify({ checks, errors, syntheticDispatches: log.sends.length, modelCalls: log.modelCalls, nativeProcesses: log.nativeProcesses, windows, profile }, null, 2));
}
const cleanup = testScratch.cleanup(async () => {
  if (app) await app.close();
  if (client) { for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); } else if (child.exitCode === null) child.kill('SIGTERM');
  if (child.connected) child.disconnect(); await until(() => child.exitCode !== null, 'Owned fixture exits');
});
run().catch(async e => { failure = e.stack; console.error(failure); process.exitCode = 1; await shot('failure').catch(() => {}); }).finally(async () => {
  try {
    fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ checks, failure, errors, profile, fullStarts, ownedNodePid: child.pid, ownedGuiPids: guiPids, guards: guardSamples, currentGuards: app ? await app.evaluate(() => globalThis.followthroughGuards).catch(() => null) : null, copyBatches: [...copyBatches, app ? await app.evaluate(() => global.copyValues).catch(() => []) : []], fixture: child.connected ? await native().catch(() => null) : null }, null, 2));
  } finally {
    await cleanup(); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
    fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ token, releasedAt: new Date().toISOString(), ownedProfileGone: !fs.existsSync(profile) }));
  }
});
