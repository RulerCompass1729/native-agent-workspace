// Actual isolated Electron/DSH/service with existing synthetic native transport.
// No provider process/model task or system clipboard read/write is used.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const scratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
const { chooseRecipient, fillRoomMessage } = require('./room-input.cjs');
const { fork } = scratch.childProcess;
const { _electron } = scratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
// Fail before owning a GUI slot or starting a service when export cannot pass
// the scratch fixture's publication boundary, including symlink aliases.
if (process.env.NAW_EVIDENCE_DIR) {
  const target = path.resolve(process.env.NAW_EVIDENCE_DIR);
  let existing = target; while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const destination = path.join(fs.realpathSync(existing), path.relative(existing, target));
  for (const base of [root, code].map(value => fs.realpathSync(value))) {
    if (destination === base || destination.startsWith(base + path.sep)) throw Error('Evidence must be outside the repository; no GUI launched.');
  }
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
}
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock');
const token = randomUUID();
try { fs.mkdirSync(slot); }
catch (error) { if (error.code !== 'EEXIST') throw error; console.error('GUI slot occupied; no test app launched.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex 3', task: 'T53 collaboration overview', token, pid: process.pid, createdAt: new Date().toISOString() }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-collaboration-overview-'));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/collaboration-overview.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let application, page, secondOwner, sequence = 0;
const errors = [], checks = [];
async function until(fn, label) { for (let i = 0; i < 160; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const callback = result => { if (result.requestId === id) { clearTimeout(timer); child.off('message', callback); result.error ? reject(Error(result.error)) : resolve(result); } };
    const timer = setTimeout(() => { child.off('message', callback); reject(Error('Fixture reply timed out')); }, 10000);
    child.on('message', callback); child.send({ id, method, target, value });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
const reader = id => page.locator(`#collaboration-overview .collaboration-member-reader[data-member-id="${id}"] .messages`);
const header = id => page.locator(`#collaboration-overview .collaboration-member-status[data-member-id="${id}"]`);
const check = text => { checks.push(text); console.log('PASS:', text); };
async function allHeadersVisible(ids) {
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  for (const id of ids) {
    const boxes = await header(id).evaluate(el => [el, ...el.children].map(node => node.getBoundingClientRect().toJSON()));
    for (const box of boxes) {
      assert.ok(box.width > 0 && box.height > 0);
      assert.ok(box.left >= -1 && box.right <= viewport.width + 1 && box.top >= -1 && box.bottom <= viewport.height + 1,
        `Every member state/freshness fact must fit the visible reading surface: ${JSON.stringify(box)}`);
    }
  }
}
async function capture(name) {
  if (!process.env.NAW_SCREENSHOTS_DIR) return;
  fs.mkdirSync(process.env.NAW_SCREENSHOTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(process.env.NAW_SCREENSHOTS_DIR, `${name}.png`) });
}
async function launch() {
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await application.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  await page.locator('#new-session').waitFor();
  await application.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, path.join(profile, 'member-file.txt'));
}
async function create(name, provider) {
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => s.name === name && s.state === 'idle'), 'Fixture session created');
  const record = (await snapshot()).sessions.find(s => s.name === name);
  await page.locator('#session-header-more').click();
  await page.getByRole('menuitem', { name: '加入协作', exact: true }).click();
  return record.id;
}
function identity(state) { return state.sessions.map(s => ({ id: s.id, nativeId: s.nativeId, owner: s.owner, view: s.view, controlRevision: s.controlRevision, claudeQuestion: s.claudeQuestion })).sort((a, b) => a.id.localeCompare(b.id)); }
async function scrollToPast(id, amount) {
  await reader(id).hover(); await page.mouse.wheel(0, -100000); await delay(100); await page.mouse.wheel(0, amount); await delay(160);
  const top = await reader(id).evaluate(el => el.scrollTop); assert.ok(top > 10); return top;
}
async function unchangedNative(before, stateBefore) {
  const packet = await fixture('stats');
  assert.deepEqual(packet.stats, before.stats, 'Passive overview must not open, resize, input or send to a native session');
  assert.deepEqual(packet.overviewCalls, before.calls, 'Even same-owner passive claim/terminal/approval calls must remain absent');
  assert.deepEqual(identity(await snapshot()), identity(stateBefore), 'Passive reads must preserve native identity/control');
}
async function run() {
  console.log('Synthetic profile:', profile);
  fs.writeFileSync(path.join(profile, 'member-file.txt'), 'SYNTHETIC_MEMBER_FILE: local preview only.');
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Fixture service ready'); await launch();
  const a = await create('Member A', 'claude'), b = await create('Member B', 'codex'), c = await create('Member C', 'claude');
  for (const [id, name] of [[a, 'A'], [b, 'B'], [c, 'C']]) {
    for (let i = 0; i < 32; i++) await fixture('nativeBlock', id, { id: `response:${i}`, kind: 'response', turnId: `turn-${name}`, status: 'complete',
      text: `PRIVATE_${name}_${String(i).padStart(2, '0')}: Original native message.\n\nThis content belongs to member ${name}; reading it does not share it.` });
  }
  await fixture('fleet', c, { event: 'SubagentStart', id: 'fixture-child-c', name: 'Fixture native child', stale: false });
  await fixture('fleet', a, { event: 'thread/started', id: 'fixture-child-a', name: 'Unknown native child', stale: false });
  await fixture('state', a, 'working');
  secondOwner = await connect(profile, 'fixture-overview-other-owner'); await secondOwner.call('claim', b, 'chat');
  await page.locator('#room-nav').click();
  await page.locator('#collaboration-overview .collaboration-member-reader').nth(2).waitFor();
  await page.evaluate(id => workspace.claim(id, 'terminal'), a);
  await until(async () => (await snapshot()).sessions.find(s => s.id === a).view === 'terminal', 'Owned terminal-view precondition');
  assert.equal(await page.locator('#native-pane').isVisible(), false);
  assert.equal(await page.locator('#collaboration-overview .collaboration-member-reader .messages:visible').count(), 3);
  for (const [id, name] of [[a, 'A'], [b, 'B'], [c, 'C']]) assert.match(await reader(id).innerText(), new RegExp(`PRIVATE_${name}_`));
  assert.match(await header(a).innerText(), /状态未知/); assert.match(await header(c).innerText(), /会话就绪[\s\S]*子任务：[\s\S]*进行中/);
  for (const id of [a, b, c]) assert.match(await header(id).innerText(), /更新时间未报告/);
  await allHeadersVisible([a, b, c]);
  const baseline = await fixture('stats');
  const before = { stats: { ...baseline.stats }, calls: { ...baseline.overviewCalls } }, stateBefore = await snapshot();
  const privateRoom = stateBefore.room.messages.map(m => m.text).join('\n'); assert.ok(!privateRoom.includes('PRIVATE_'));
  await chooseRecipient(page, c); await fillRoomMessage(page, 'Unsent room message');
  const rawDraft = await page.locator('#shared-input').inputValue(), recipient = await page.locator('#recipient').inputValue();
  const topA = await scrollToPast(a, 160), topB = await scrollToPast(b, 320);
  // DOM range setup makes the exact selection deterministic; subsequent
  // streaming and focus/return are actual UI operations, not physical input.
  const selectedText = await reader(a).evaluate(el => {
    const body = [...el.querySelectorAll('.message-body')].find(node => node.getBoundingClientRect().top >= el.getBoundingClientRect().top);
    const range = document.createRange(); range.selectNodeContents(body);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); return selection.toString();
  });
  assert.match(selectedText, /PRIVATE_A_/);
  check('Three original GUI conversations have distinct context; all full member states are visible without a terminal');
  await fixture('nativeBlock', b, { id: 'response:32', kind: 'response', turnId: 'turn-B', text: 'PRIVATE_B_LATEST: original text with **Markdown** and 🙂', status: 'streaming' });
  await until(async () => (await reader(b).innerText()).includes('PRIVATE_B_LATEST'), 'B update visible');
  assert.ok(Math.abs(await reader(a).evaluate(el => el.scrollTop) - topA) < 3);
  assert.ok(Math.abs(await reader(b).evaluate(el => el.scrollTop) - topB) < 3);
  assert.equal(await page.evaluate(() => getSelection().toString()), selectedText);
  check('Live output in one member preserves independent reading anchors in other members');
  await capture('01-conversation-columns');
  await page.getByRole('button', { name: '简化信息', exact: true }).click();
  const quote = page.locator(`.collaboration-member-reader[data-member-id="${b}"] blockquote`);
  assert.equal(await quote.innerText(), 'PRIVATE_B_LATEST: original text with **Markdown** and 🙂');
  const source = page.locator(`.collaboration-member-reader[data-member-id="${b}"] .collaboration-source`);
  assert.match(await source.innerText(), /Member B.*查看原文/);
  for (const id of [a, b, c]) assert.equal(await header(id).isVisible(), true);
  await allHeadersVisible([a, b, c]);
  await capture('02-source-brief'); await source.click();
  const originalId = (await snapshot()).sessions.find(s => s.id === b).messages.find(m => m.text.startsWith('PRIVATE_B_LATEST')).id;
  const original = reader(b).locator(`[data-message-id="${originalId}"][data-search-target="true"]`);
  await original.waitFor();
  await until(async () => {
    const target = await original.boundingBox(), viewport = await reader(b).boundingBox();
    return target.y >= viewport.y - 1 && target.y < viewport.y + viewport.height - 1;
  }, 'Exact source is actually within its original member viewport');
  assert.ok(Math.abs(await reader(a).evaluate(el => el.scrollTop) - topA) < 3);
  check('Brief mode quotes exact source text with provenance; source navigation targets the original member without input');
  await scrollToPast(b, 320);
  const positionBeforeFocus = await reader(b).evaluate(el => el.scrollTop);
  const selectionBeforeFocus = await reader(b).evaluate(el => {
    const body = [...el.querySelectorAll('.message-body')].find(node => node.getBoundingClientRect().top >= el.getBoundingClientRect().top);
    const range = document.createRange(); range.selectNodeContents(body);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); return selection.toString();
  });
  await unchangedNative(before, stateBefore);
  await header(a).locator('.collaboration-member-name').click();
  assert.equal(await page.locator('#send-button').innerText(), '启用对话输入');
  await unchangedNative(before, stateBefore);
  await page.locator('#collaboration-overview').getByRole('button', { name: '← 返回共同工作', exact: true }).click();
  assert.equal(await page.evaluate(() => getSelection().toString()), selectionBeforeFocus);
  await header(b).locator('.collaboration-member-name').click();
  await page.locator('#conversation-pane').waitFor(); assert.equal(await page.locator('#native-pane').isVisible(), false);
  await page.locator('#session-files').click(); await page.locator('#file-dialog').waitFor();
  assert.equal(await page.locator('#file-content').innerText(), 'SYNTHETIC_MEMBER_FILE: local preview only.');
  assert.equal(await page.locator('#insert-file').isDisabled(), true, 'Another owner still prevents private draft insertion');
  await page.locator('#close-file').click();
  assert.match(await page.locator('#messages').innerText(), /PRIVATE_B_/);
  assert.equal(await page.locator('#message-input').evaluate(el => el.readOnly), true);
  for (const id of [a, b, c]) assert.equal(await header(id).isVisible(), true);
  await allHeadersVisible([a, b, c]);
  assert.equal(await page.locator('#shared-input').inputValue(), rawDraft); assert.equal(await page.locator('#recipient').inputValue(), recipient);
  await unchangedNative(before, stateBefore); await capture('03-focused-member');
  await page.locator('#messages').hover(); await page.mouse.wheel(0, 140); await delay(120);
  const focusedTop = await page.locator('#messages').evaluate(el => el.scrollTop);
  await header(b).locator('.collaboration-member-name').click(); await delay(100);
  assert.ok(Math.abs(await page.locator('#messages').evaluate(el => el.scrollTop) - focusedTop) < 3, 'Clicking the already-focused member must not reset reading');
  await page.locator('#collaboration-overview').getByRole('button', { name: '← 返回共同工作', exact: true }).click();
  assert.ok(Math.abs(await reader(b).evaluate(el => el.scrollTop) - positionBeforeFocus) < 3);
  assert.equal(await page.locator('#shared-input').inputValue(), rawDraft); assert.equal(await page.locator('#recipient').inputValue(), recipient);
  await unchangedNative(before, stateBefore);
  check('Passive focus uses the same complete GUI workspace; return preserves anchors/draft/recipient and never claims another owner');
  const beforeSearch = await reader(b).evaluate(el => el.scrollTop);
  await page.locator('#search-button').click(); await page.locator('#search-input').fill('PRIVATE_B_08');
  await until(() => page.locator('#search-results button').count().then(n => n === 1), 'One exact private original search result');
  await page.locator('#search-results button').click();
  const targetId = (await snapshot()).sessions.find(s => s.id === b).messages.find(m => m.text.startsWith('PRIVATE_B_08')).id;
  await page.locator(`#messages [data-message-id="${targetId}"][data-search-target="true"]`).waitFor();
  await page.locator('#return-reading').click();
  await until(() => reader(b).evaluate((el, top) => Math.abs(el.scrollTop - top) < 3, beforeSearch), 'Search returns to original overview pane position');
  assert.equal(await page.locator('#shared-input').inputValue(), rawDraft); assert.equal(await page.locator('#recipient').inputValue(), recipient);
  await unchangedNative(before, stateBefore);
  check('Search from the overview locates the exact existing personal GUI message and returns to independent overview positions');
  const grip = page.locator(`.collaboration-member-reader[data-member-id="${a}"] [role="separator"]`);
  const width = (await reader(a).boundingBox()).width; await grip.focus(); await page.keyboard.press('ArrowRight');
  assert.ok((await reader(a).boundingBox()).width > width);
  await page.getByRole('button', { name: '列表', exact: true }).click();
  for (const id of [a, b, c]) assert.equal(await header(id).isVisible(), true);
  await page.getByRole('button', { name: '网格', exact: true }).click();
  await page.locator('#room-record').click(); assert.equal(await page.locator('#room-messages').isVisible(), true);
  assert.ok(!(await page.locator('#room-messages').innerText()).includes('PRIVATE_'));
  for (const id of [a, b, c]) assert.equal(await header(id).isVisible(), true);
  await page.locator('#room-overview').click(); await unchangedNative(before, stateBefore);
  assert.equal((await application.windows()).length, 1);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 840));
  await until(async () => (await page.evaluate(() => innerWidth)) <= 900, 'Owned narrow window');
  await allHeadersVisible([a, b, c]); await capture('04-narrow-overview');
  await header(b).locator('.collaboration-member-name').click(); await allHeadersVisible([a, b, c]); await capture('05-narrow-focus');
  await page.locator('#collaboration-overview').getByRole('button', { name: '← 返回共同工作', exact: true }).click();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860));
  await unchangedNative(before, stateBefore);
  check('Keyboard sizing, grid/list, narrow focus and shared-record navigation retain member visibility and private boundaries');
  await header(b).locator('.collaboration-member-name').click();
  await page.locator('#send-button').getByText('接管此窗口', { exact: true }).click();
  await until(async () => { const s = await snapshot(); return s.sessions.find(x => x.id === b).owner === s.owner; }, 'Explicit takeover');
  await page.locator('#message-input').fill('Unsent private member B draft');
  await until(async () => (await snapshot()).sessions.find(s => s.id === b).liveDraft === 'Unsent private member B draft', 'Private draft preserved');
  assert.equal(await page.locator('#shared-input').inputValue(), rawDraft); assert.equal(await page.locator('#recipient').inputValue(), recipient);
  assert.equal((await fixture('stats')).stats.opens, before.stats.opens);
  await page.locator('#terminal-tab').click(); await page.locator('#native-pane').waitFor();
  await fixture('output', b, { data: 'Synthetic explicit native view\r\n' });
  await allHeadersVisible([a, b, c]);
  await page.locator('#terminal-maximize').click(); await allHeadersVisible([a, b, c]);
  const terminalBox = await page.locator('#native-pane').boundingBox(); assert.ok(terminalBox.height > 100);
  await capture('06-explicit-native-maximized');
  await page.locator('#terminal-maximize').click(); await page.locator('#chat-tab').click();
  assert.equal(await page.locator('#native-pane').isVisible(), false);
  assert.equal(await page.locator('#message-input').inputValue(), 'Unsent private member B draft');
  assert.equal(await page.locator('#shared-input').inputValue(), rawDraft);
  check('Deliberate native view and maximize preserve the full member state band; GUI return retains drafts');
  await fixture('approval', b, { requestId: 17, method: 'item/commandExecution/requestApproval',
    params: { command: 'echo synthetic-overview-permission', cwd: '/synthetic', availableDecisions: ['accept', 'decline'] } });
  await page.locator('#approval').getByRole('button', { name: '拒绝', exact: true }).click();
  await until(async () => (await fixture('stats', b)).approvalReplies?.length === 1, 'Existing focused permission reaches native fixture once');
  assert.equal((await fixture('stats', b)).approvalReplies[0].requestId, 17);
  await page.locator('#collaboration-overview').getByRole('button', { name: '← 返回共同工作', exact: true }).click();
  await header(b).locator('.collaboration-member-name').click(); assert.equal(await page.locator('#message-input').inputValue(), 'Unsent private member B draft');
  await page.locator('#collaboration-overview').getByRole('button', { name: '← 返回共同工作', exact: true }).click();
  check('Only deliberate existing takeover changes ownership; private GUI drafts and the independent room draft survive return');
  const ids = (await snapshot()).sessions.map(s => [s.id, s.nativeId]);
  await application.close(); application = null; await launch(); await page.locator('#collaboration-overview').waitFor();
  assert.deepEqual((await snapshot()).sessions.map(s => [s.id, s.nativeId]), ids);
  assert.equal(await page.locator('#shared-input').inputValue(), rawDraft); assert.equal(await page.locator('#recipient').inputValue(), recipient);
  assert.equal((await fixture('stats')).stats.sends, 0);
  await fixture('bindSends', c); await page.locator('#forward-button').click();
  await until(async () => (await fixture('stats', c)).stats.sends === 1, 'One deliberate shared send');
  const send = (await fixture('stats', c)).lastSend;
  assert.equal(send.nativeId, ids.find(x => x[0] === c)[1]); assert.match(send.text, /Unsent room message/);
  assert.ok(!send.text.includes('PRIVATE_')); assert.ok(!send.text.includes('Unsent private member B draft'));
  check('Reopen preserves the same native identities and drafts; deliberate send targets only the unchanged chosen recipient');
  await fillRoomMessage(page, 'Retained room draft after send');
  const retainedRoomDraft = await page.locator('#shared-input').inputValue();
  await header(b).locator('.collaboration-member-name').click();
  await page.locator(`[data-session-menu="${b}"]`).click();
  await page.getByRole('menuitem', { name: '重命名…', exact: true }).click();
  await page.locator('#rename-name').fill('Member A'); await page.locator('#confirm-rename').click();
  await until(async () => (await header(b).innerText()).includes('Member A'), 'Same visible member header renamed');
  assert.match(await header(a).locator('.collaboration-member-name').innerText(), /Member A.*Claude/);
  assert.match(await header(b).locator('.collaboration-member-name').innerText(), /Member A.*Codex/);
  assert.notEqual(await header(a).locator('.collaboration-member-name').innerText(), await header(b).locator('.collaboration-member-name').innerText());
  const sameB = (await snapshot()).sessions.find(s => s.id === b);
  assert.equal(sameB.nativeId, ids.find(x => x[0] === b)[1]);
  assert.equal(sameB.liveDraft, 'Unsent private member B draft');
  const handle = header(b).locator('.collaboration-member-name'), detachedLabel = await handle.innerText(); assert.equal(await handle.getAttribute('draggable'), 'true');
  await handle.dragTo(page.locator('#solo-drop'));
  await until(async () => !(await snapshot()).sessions.find(s => s.id === b).roomId, 'Visible member drag detaches existing native session');
  assert.equal((await snapshot()).viewState.selected, 'room');
  assert.equal((await snapshot()).sessions.find(s => s.id === b).liveDraft, 'Unsent private member B draft');
  await page.getByRole('button', { name: `打开 ${detachedLabel}`, exact: true }).click();
  assert.equal(await page.locator('#message-input').inputValue(), 'Unsent private member B draft');
  await page.locator('#room-nav').click(); await until(() => header(b).count().then(n => n === 0), 'Detached member reader removed');
  await allHeadersVisible([a, c]);
  assert.equal(await page.locator('#shared-input').inputValue(), retainedRoomDraft);
  assert.equal(await page.locator('#recipient').inputValue(), recipient);
  await page.locator(`[data-session-id="${b}"]`).click();
  await page.locator('#session-header-more').click();
  await page.getByRole('menuitem', { name: '加入协作', exact: true }).click(); await page.locator('#room-nav').click();
  await header(b).waitFor(); await allHeadersVisible([a, b, c]);
  assert.equal((await snapshot()).sessions.find(s => s.id === b).nativeId, sameB.nativeId);
  assert.equal((await snapshot()).sessions.find(s => s.id === b).liveDraft, sameB.liveDraft);
  check('Rename, visible member drag-to-detach and rejoin preserve native identity, private draft and the room recipient/draft');
  if (process.env.NAW_T53_NATIVE_FALLBACK === '1') {
    await chooseRecipient(page, b);
    const preserved = await page.locator('#shared-input').inputValue(), nativeId = (await snapshot()).sessions.find(s => s.id === b).nativeId;
    const sends = (await fixture('stats')).stats.sends;
    assert.equal(await page.locator('#forward-button').innerText(), '打开原生终端');
    await page.locator('#forward-button').click();
    await page.locator('#native-pane').waitFor(); await allHeadersVisible([a, b, c]);
    const state = await snapshot(); assert.equal(state.viewState.mode, 'terminal'); assert.equal(state.viewState.roomSession, b);
    assert.equal(state.sessions.find(s => s.id === b).nativeId, nativeId);
    assert.equal(await page.locator('#shared-input').inputValue(), preserved);
    assert.equal((await fixture('stats')).stats.sends, sends); assert.equal((await fixture('stats')).stats.inputs, 0);
    await capture('07-explicit-native-recovery');
    check('The explicit native recovery button opens the same native terminal and preserves draft/recipient without auto input or send');
  }
  assert.deepEqual(errors, []);
  const packet = await fixture('stats');
  const result = { checks, errors, nativeStats: packet.stats, workspaceCalls: packet.overviewCalls, fixtureOnly: true, productModelCalls: 0, realProviderProcesses: 0,
    limits: 'Synthetic native events through actual source GUI/service; no physical input, installed, native-provider or10/100 capacity certification.' };
  if (process.env.NAW_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.NAW_EVIDENCE_DIR, 'overview-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
run().catch(async error => { console.error(error.stack); process.exitCode = 1; if (page && !page.isClosed()) await capture('failure').catch(() => {}); }).finally(async () => {
  try {
    secondOwner?.close(); await scratch.release();
    const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); assert.equal(owner.token, token);
    fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); console.log('Owned fixture cleaned; GUI slot released.');
  } catch (error) { console.error('Cleanup not confirmed; retain owned GUI lock:', error.stack); process.exitCode = 1; }
});
