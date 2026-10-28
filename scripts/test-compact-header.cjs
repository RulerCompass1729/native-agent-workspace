// Complete compact-header task in the actual Electron/DSH application. Reuse
// synthetic native transport; never start a provider or touch the OS clipboard.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const scratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
const { _electron } = scratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const evidence = process.env.NAW_EVIDENCE_DIR;
if (evidence) {
  let parent = path.resolve(evidence); while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const target = path.join(fs.realpathSync(parent), path.relative(parent, path.resolve(evidence)));
  for (const repo of [root, code].map(p => fs.realpathSync(p))) assert.ok(target !== repo && !target.startsWith(repo + path.sep), 'Evidence must be outside source repositories');
  fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
}
// The canonical mutex is shared by worktrees. Do not infer another owner's
// completion or acquire a lane-local lock instead.
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; no fixture or GUI launched.'); process.exit(75); }
const owned = { owner: 'Codex2', task: 'T71 compact header', token, pid: process.pid, createdAt: new Date().toISOString(), budget: { productModels: 0, providers: 0 } };
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify(owned, null, 2));
if (evidence) fs.writeFileSync(path.join(evidence, 'owner.json'), JSON.stringify(owned, null, 2));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-compact-header-'));
const file = path.join(profile, 'local-header-task.txt'); fs.writeFileSync(file, 'Original local file 你好\nNo automatic send.');
const child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/compact-header.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, page, client, request = 0, sequence = 0;
const checks = [], errors = [], geometry = [];
async function until(fn, label) { for (let i = 0; i < 160; i++) { if (await fn()) return; await delay(40); } throw Error(label); }
function fixture(method = 'stats', target, value) {
  const id = ++request;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 8000);
    const cb = result => { if (result.requestId === id) { clearTimeout(timer); child.off('message', cb); resolve(result); } };
    child.on('message', cb); child.send({ id, method, target, value });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
const item = name => page.getByRole('menuitem', { name, exact: true });
const check = text => { checks.push(text); console.log('PASS:', text); };
async function capture(name) { if (evidence) await page.screenshot({ path: path.join(evidence, name + '.png') }); }
async function menu(anchor, key) { if (key) { await page.locator(anchor).focus(); await page.keyboard.press(key); } else await page.locator(anchor).click(); await page.getByRole('menu').waitFor(); }
async function selectText(selector) { return page.locator(selector).evaluate(el => { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString(); }); }
async function bounds(label) {
  const boxes = await page.evaluate(() => {
    const rect = id => { const n = document.getElementById(id); return n && !n.hidden && n.getBoundingClientRect().height ? n.getBoundingClientRect().toJSON() : null; };
    return { width: innerWidth, height: innerHeight, header: rect('header'), toolbar: rect('session-toolbar'), reader: rect('messages'), native: rect('terminal-area'), chat: rect('conversation-pane-toolbar'), controls: [...document.querySelectorAll('#header button, #header .identity-value, #conversation-pane-toolbar button, .native-pane-toolbar button, .private-label')].filter(n => n.getBoundingClientRect().width && n.getBoundingClientRect().height).map(n => ({ label: n.getAttribute('aria-label') || n.textContent, ...n.getBoundingClientRect().toJSON() })) };
  });
  for (const box of boxes.controls) assert.ok(box.left >= -1 && box.right <= boxes.width + 1 && box.top >= -1 && box.bottom <= boxes.height + 1, `${label}: visible fact/action outside the viewport: ${JSON.stringify(box)}`);
  geometry.push({ label, ...boxes }); return boxes;
}
async function create(name, provider = 'codex') {
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check(); await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => s.name === name && s.state === 'idle'), 'Synthetic session ready');
  return (await snapshot()).sessions.find(s => s.name === name).id;
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Service ready'); client = await connect(profile, 'compact-header-observer');
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  await app.context().addInitScript(() => { window.headerTerms = new Map(); let constructor; Object.defineProperty(window, 'Terminal', { configurable: true, get: () => constructor, set: value => { constructor = value; const open = value.prototype.open; value.prototype.open = function (el, ...args) { window.headerTerms.set(el.closest('[data-terminal-id]').dataset.terminalId, this); return open.call(this, el, ...args); }; } }); });
  page = await app.firstWindow(); page.setDefaultTimeout(8000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor(); await page.reload(); await page.locator('#new-session').waitFor();
  await app.evaluate(({ clipboard, nativeImage, dialog }, file) => {
    globalThis.headerClipboardOriginal = { writeText: clipboard.writeText, readText: clipboard.readText, readImage: clipboard.readImage };
    globalThis.headerClipboard = { copies: [], reads: 0 };
    clipboard.writeText = text => globalThis.headerClipboard.copies.push(text);
    clipboard.readText = () => { globalThis.headerClipboard.reads++; return ''; };
    clipboard.readImage = () => nativeImage.createEmpty();
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, file);
  const win = await app.browserWindow(page); await win.evaluate(w => w.setSize(1440, 900));
  const id = await create('Header research'), input = page.locator('#message-input');
  const draft = 'Original draft 你好\nKeep this unsent.'; await input.fill(draft);
  await page.locator('#terminal-tab').click(); await until(async () => (await fixture()).pending.includes(id), 'Held terminal snapshot'); await fixture('release', id); await page.locator('.terminal-surface').waitFor();
  await fixture('history', id, [{ id: 'header-original', type: 'agentMessage', text: 'Original result 你好\n\nRead, search and run completed.' }]);
  await fixture('terminal', id, { sequence: ++sequence, data: '\x1bcOriginal terminal 你好\r\nRead, search and run completed.\r\n> ' }); await page.locator('#chat-tab').click();
  await page.locator('#messages [data-message-id="header-original"]').waitFor();
  const original = (await snapshot()).sessions.find(s => s.id === id);
  const beforeLayoutCalls = (await fixture()).headerCalls;
  if (process.env.NAW_HEADER_BASELINE === '1') {
    assert.equal(await page.locator('#header #session-toolbar').count(), 0, 'Baseline must use the original separate view toolbar');
    await bounds('baseline-split'); await capture('baseline-split'); check('Original separate header/view/native bars measured without changing the task');
  } else {
    assert.equal(await page.locator('#header #session-toolbar').count(), 1);
    await page.evaluate(() => { window.headerOriginalInput = document.getElementById('message-input'); window.headerOriginalTerminal = document.querySelector('.terminal-surface'); });
    await bounds('split'); await capture('split');
    await page.locator('#chat-maximize').click(); await page.locator('#native-pane').waitFor({ state: 'hidden' }); await bounds('chat'); await capture('chat');
    await page.getByRole('button', { name: '恢复并排', exact: true }).click(); await page.locator('#native-pane').waitFor();
    await page.locator('#terminal-maximize').click(); await until(() => page.locator('#conversation-pane').evaluate(n => n.getBoundingClientRect().height === 0), 'Terminal maximized'); await bounds('terminal'); await capture('terminal');
    await page.locator('#terminal-maximize').click(); await page.locator('#close-native-terminal').click(); await page.locator('#native-pane').waitFor({ state: 'hidden' }); await page.locator('#chat-maximize').click(); await page.locator('#chat-tab').click();
    assert.equal(await page.evaluate(() => window.headerOriginalInput === document.getElementById('message-input') && window.headerOriginalTerminal === document.querySelector('.terminal-surface')), true, 'Layouts move existing nodes, never replace the draft/terminal');
    assert.equal(await input.inputValue(), draft); assert.equal((await fixture()).headerCalls.send, beforeLayoutCalls.send);
    check('Split/chat/terminal maximize, restore and close retain the original input/terminal nodes, identity and unsent draft');

    for (const anchor of ['#session-header-more', '#terminal-more']) { await menu(anchor); await page.locator(anchor).click(); await page.getByRole('menu').waitFor({ state: 'hidden' }); }
    await menu('#session-header-more', 'Enter'); await item('加入协作').waitFor(); assert.equal(await item('分享选中内容').isDisabled(), true); await page.keyboard.press('Escape'); assert.equal(await page.locator('#session-header-more').evaluate(n => n === document.activeElement), true);
    await menu('#session-header-more', 'Space'); await page.keyboard.press('Tab'); await page.getByRole('menu').waitFor({ state: 'hidden' });
    await menu('#session-header-more'); await item('用量').click(); await page.locator('#privacy-dialog').waitFor(); assert.equal(await page.locator('#privacy-dialog h2').innerText(), 'Header research · 用量'); await page.locator('#close-privacy').click();
    await page.locator('#session-files').click(); await page.locator('#file-dialog').waitFor(); assert.equal(await page.locator('#file-content').innerText(), fs.readFileSync(file, 'utf8')); await page.locator('#close-file').click();
    await menu('#terminal-more', 'Enter'); await item('显示…').waitFor(); await page.keyboard.press('Escape'); assert.equal(await page.locator('#terminal-more').evaluate(n => n === document.activeElement), true);
    await menu('#terminal-more'); await item('显示…').click(); await page.locator('#terminal-display-dialog').waitFor(); await page.locator('#terminal-font-size').fill('16'); await page.locator('#terminal-font-size').dispatchEvent('change'); await page.locator('#close-terminal-display').click();
    check('Both existing-menu anchors support keyboard, Escape/Tab and return focus; native usage, local files and display settings remain reachable');

    await menu('#session-header-more'); await item('加入协作').click(); await until(async () => (await snapshot()).sessions.find(s => s.id === id).roomId === 'shared', 'Explicit join');
    assert.ok((await page.locator('#subtitle').innerText()).includes('协作中，也可单独操作'));
    const other = await create('Other member', 'claude'); await page.evaluate(id => workspace.join(id, true), other); await page.locator(`[data-session-id="${id}"]`).click();
    const body = '#messages [data-message-id="header-original"] .message-body', selected = await selectText(body);
    await menu('#session-header-more'); assert.equal(await item('分享选中内容').isDisabled(), false); await item('分享选中内容').click(); await page.locator('#share-dialog').waitFor(); assert.equal(await page.locator('#share-text').inputValue(), selected); await page.locator('#cancel-share').click();
    await selectText('#title'); await menu('#session-header-more'); assert.equal(await item('分享选中内容').isDisabled(), true, 'Header selection is not eligible private conversation content'); await page.keyboard.press('Escape');
    await page.locator('#terminal-tab').click(); await page.evaluate(id => window.headerTerms.get(id).select(0, 0, 22), id); const nativeText = await page.evaluate(id => window.headerTerms.get(id).getSelection(), id); await page.locator('#terminal-copy').click(); assert.equal(await app.evaluate(() => globalThis.headerClipboard.copies.at(-1)), nativeText);
    await menu('#session-header-more'); await item('脱出协作').click(); await until(async () => !(await snapshot()).sessions.find(s => s.id === id).roomId, 'Explicit leave'); await menu('#session-header-more'); await item('加入协作').click();
    check('Explicit join/leave, selected-original sharing preview and persistent terminal Copy retain existing scope; no selected header or text is shared automatically');

    await page.evaluate(id => workspace.archiveSession(id), id); await page.getByRole('button', { name: '恢复会话', exact: true }).waitFor();
    await menu('#session-header-more'); await item('用量').waitFor(); assert.equal(await item('加入协作').count() + await item('脱出协作').count(), 0); await page.keyboard.press('Escape');
    await menu('#terminal-more'); await fixture('header-facts', id, { activity: 'Retained original terminal' }); await until(async () => (await page.locator('#session-status').innerText()).includes('Retained original terminal'), 'Archived native update'); await item('显示…').click(); await page.locator('#terminal-display-dialog').waitFor(); await page.locator('#close-terminal-display').click(); await fixture('header-facts', id, { activity: '' });
    await page.getByRole('button', { name: '恢复会话', exact: true }).click(); await until(async () => !(await snapshot()).sessions.find(s => s.id === id).archived, 'Explicit restore');
    if (!(await snapshot()).sessions.find(s => s.id === id).roomId) { await menu('#session-header-more'); await item('加入协作').click(); }
    check('Archive status and explicit Restore remain visible; retained read-only terminal display settings are still reachable');

    const longName = 'Long English research session with original native facts';
    await page.evaluate(({ id, name }) => workspace.rename(id, name), { id, name: longName });
    const model = 'native-reported-long-model-with-build-2026-10-28-original';
    await fixture('header-facts', id, { model, nativeSettings: { mode: 'plan', effort: 'medium' } }); await fixture('header-collision', id);
    await win.evaluate(w => w.setSize(850, 600)); await delay(200);
    await page.locator('#chat-tab').click();
    const fields = await page.locator('#subtitle .identity-value').allTextContents(); assert.deepEqual(fields, ['Codex', id.slice(0, 7), model, 'Plan', 'medium', '协作中，也可单独操作']);
    await page.locator('#chat-tab').evaluate(n => { n.textContent = 'Conversation'; }); await page.locator('#terminal-tab').evaluate(n => { n.textContent = 'Native terminal'; });
    const compact = await bounds('narrow-long-English'); assert.ok(compact.header.height <= 110, 'Ordinary narrow identity/view controls remain compact'); await capture('narrow-long-English');
    const hint = await page.locator('#terminal-selection-hint').evaluate(n => ({ text: n.textContent, width: n.getBoundingClientRect().width, height: n.getBoundingClientRect().height, clip: getComputedStyle(n).clipPath })); assert.ok(hint.text.includes('Option') && hint.width > 50 && hint.height >= 12 && hint.clip === 'none', 'The previously required Option-selection hint stays visibly readable');
    const modelField = page.locator('.identity-model'); await modelField.focus(); assert.equal(await modelField.getAttribute('aria-label'), model); assert.equal(await modelField.evaluate(n => getComputedStyle(n).whiteSpace), 'normal'); await bounds('focused-full-model'); await capture('focused-full-model');
    const fullModel = await selectText('.identity-model'); await modelField.click({ button: 'right' }); await item('复制').click(); assert.equal(await app.evaluate(() => globalThis.headerClipboard.copies.at(-1)), fullModel); assert.equal(fullModel, model);
    await page.locator('#title').focus(); assert.equal(await page.locator('#title').getAttribute('title'), longName); assert.equal(await page.locator('#title').evaluate(n => getComputedStyle(n).whiteSpace), 'normal'); await bounds('focused-full-name');
    check('850×600 long English labels, native model/Plan/effort and collision-expanded ID stay reachable; focused full native value copies exactly');

    await win.evaluate(w => w.setSize(1240, 850)); await fixture('native-version', id, { version: '0.999.0' });
    await fixture('native-permission', id, { nativeOnly: true, requests: [{ title: 'Original native permission', input: 'Read original source? 你好' }] });
    await fixture('set-owner', id, 'another-owned-view'); await until(() => page.locator('#take-control').isVisible(), 'Explicit takeover stays visible');
    const status = await page.locator('#session-status').innerText(); assert.ok(status.includes('尚未验证') && status.includes('另一个窗口控制')); assert.equal(await page.locator('#approval').isVisible(), true); assert.ok((await page.locator('#approval').innerText()).includes('Read original source? 你好')); await bounds('approval-other-owner'); await capture('approval-other-owner');
    await menu('#session-header-more'); await fixture('set-owner', id, original.owner); await page.getByRole('menu').waitFor({ state: 'hidden' }); assert.equal(await page.locator('#session-header-more').getAttribute('aria-expanded'), 'false');
    await fixture('native-permission', id, null); await fixture('set-state', id, 'idle'); await fixture('native-version', id, { version: '0.164.0' });
    await page.locator('#chat-tab').click(); await until(async () => (await snapshot()).sessions.find(s => s.id === id).view === 'chat', 'Chat control settled before bounded claim'); await fixture('hold-claim', id); await page.locator('#terminal-tab').click(); await until(async () => (await fixture()).claims.includes(id), 'Bounded pending view claim');
    assert.ok((await page.locator('#session-status').innerText()).includes('输入暂存，尚未发送')); await capture('pending-input'); await fixture('fail-claim', id); await until(async () => !(await fixture()).claims.includes(id), 'Claim released without input');
    check('Unverified version, original permission, other-window owner/takeover and pending-unsent input remain explicit; owner changes invalidate open header menus');

    await page.locator('#room-nav').click(); const ownerBeforeFocus = (await snapshot()).sessions.find(s => s.id === id).owner, callsBeforeFocus = (await fixture()).headerCalls.claim;
    await page.locator(`.collaboration-member-status[data-member-id="${id}"] button[aria-pressed]`).click(); await page.locator('#room-session #session-view').waitFor();
    assert.equal(await page.locator('#header').evaluate(n => n.classList.contains('compact-session')), false); assert.equal(await page.locator('#room-session #session-toolbar').count(), 1); assert.equal(await page.locator('#session-files').isVisible(), true);
    assert.equal((await snapshot()).sessions.find(s => s.id === id).owner, ownerBeforeFocus); assert.equal((await fixture()).headerCalls.claim, callsBeforeFocus, 'Passive room focus does not claim input');
    await page.locator('#usage-button').click(); await page.locator('#privacy-dialog').waitFor(); assert.equal(await page.locator('#privacy-dialog h2').innerText(), `${longName} · 用量`); await page.locator('#close-privacy').click();
    await page.locator('.collaboration-back').click(); await page.locator(`[data-session-id="${id}"]`).click();
    await menu('#session-header-more'); await page.locator(`[data-session-id="${other}"]`).click(); await page.getByRole('menu').waitFor({ state: 'hidden' }); await page.locator(`[data-session-id="${id}"]`).click();
    const draftBeforeReload = await input.inputValue(); await page.reload(); await page.locator('#session-header-more').waitFor(); await until(async () => await input.inputValue() === draftBeforeReload, 'Reload retains the draft');
    if ((await fixture()).pending.includes(id)) await fixture('release', id);
    await menu('#terminal-more'); await item('显示…').click(); await page.locator('#terminal-display-dialog').waitFor(); assert.equal(await page.locator('#terminal-font-size').inputValue(), '16'); await page.locator('#close-terminal-display').click();
    const final = (await snapshot()).sessions.find(s => s.id === id); assert.deepEqual([final.id, final.nativeId, final.owner], [original.id, original.nativeId, original.owner]); assert.equal(final.liveDraft, draft);
    check('T53 focused-member files/usage/passive ownership and return remain intact; session changes close menus and reload retains identity, draft and display preference');

    await fixture('native-activity', id, { turnId: 'header-original-turn', label: 'Original native running 你好', observedAt: Date.now() });
    await until(async () => (await page.locator('#native-phase').innerText()).includes('Original native running 你好'), 'Original ongoing native activity');
    assert.equal(await page.locator('#native-activity').isVisible(), true); assert.equal(await page.locator('#session-status').innerText(), '正在工作'); await capture('native-running'); await fixture('native-activity', id, null);
    await fixture('native-permission', id, { nativeOnly: true, requests: [{ title: 'AskUserQuestion', input: JSON.stringify({ questions: [{ header: 'Original question', question: 'Which original file? 你好', options: [{ label: 'Source', description: 'Keep original source' }, { label: 'Tests', description: 'Keep original tests' }] }] }) }] });
    await until(async () => (await page.locator('#approval').innerText()).includes('Which original file? 你好'), 'Native question originals'); await capture('native-question'); await fixture('native-permission', id, null); await fixture('set-state', id, 'idle');
    const reconnect = await snapshot();
    // Exercise the real preload IPC subscriber with a bounded synthetic service
    // event. This proves rendering/guards, not an actual transport outage.
    await menu('#session-header-more'); await win.evaluate(w => w.webContents.send('workspace:disconnected', 'Synthetic local service disconnection'));
    await page.getByRole('menu').waitFor({ state: 'hidden' }); await page.locator('#reconnect-button').waitFor();
    assert.ok((await page.locator('#alert').innerText()).includes('本地服务断开')); assert.equal(await input.inputValue(), draft); assert.equal(await page.locator('#terminal-paste').isDisabled(), true);
    await win.evaluate(w => w.webContents.send('workspace:view-storage', 'Synthetic draft save failure'));
    await until(async () => (await page.locator('#alert').innerText()).includes('Synthetic draft save failure'), 'Draft save warning is explicit'); await page.locator('#retry-save').waitFor();
    await menu('#terminal-more'); await win.evaluate(w => w.webContents.send('workspace:view-storage', 'Synthetic draft save failure still visible')); await item('显示…').click(); await page.locator('#terminal-display-dialog').waitFor(); await page.locator('#close-terminal-display').click();
    await bounds('disconnected-save-warning'); await capture('disconnected-save-warning');
    await win.evaluate((w, state) => { w.webContents.send('workspace:view-storage', null); w.webContents.send('workspace:reconnected', state); }, reconnect); await page.locator('#alert').waitFor({ state: 'hidden' }); assert.equal(await input.inputValue(), draft);
    check('Original running/question text and synthetic preload disconnection/save-failure facts stay explicit; stale menu closes, retained display settings work and draft survives recovery');
  }
  const stats = await fixture(), clipboard = await app.evaluate(() => globalThis.headerClipboard);
  assert.deepEqual(stats.sends, []); assert.deepEqual(stats.inputs, []); assert.deepEqual(stats.interruptions, []); assert.equal(clipboard.reads, 0); assert.deepEqual(errors, []);
  const result = { checks, geometry, stats, clipboard, errors, productModels: 0, providerProcesses: 0, systemClipboard: 'all readers/writer intercepted; original formats neither read nor changed', limits: 'Synthetic native facts, source GUI; physical keyboard/mouse/screen reader and signed installation are not claimed', sourceAssetSha256: createHash('sha256').update(fs.readFileSync(path.join(code, 'app/dsh/client.js'))).digest('hex'), scriptSha256: createHash('sha256').update(fs.readFileSync(__filename)).digest('hex') };
  if (evidence) fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
}
scratch.cleanup(async () => {
  if (app) { await app.evaluate(({ clipboard }) => { if (globalThis.headerClipboardOriginal) Object.assign(clipboard, globalThis.headerClipboardOriginal); }); await app.close(); }
  if (client) { for (const id of (await fixture()).headerRuntimeIds) await client.call('stop', id); await client.call('shutdown'); client.close(); }
  if (child.connected) child.disconnect(); if (child.exitCode === null) child.kill('SIGTERM');
});
run().catch(async e => { console.error(e.stack); console.error(JSON.stringify({ partialChecks: checks, geometry, errors })); process.exitCode = 1; if (page) await capture('failure').catch(() => {}); }).finally(async () => {
  try {
    await scratch.release(); const current = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); assert.equal(current.token, token); assert.equal(current.owner, 'Codex2');
    fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
    const receipt = { ...owned, releasedAt: new Date().toISOString(), cleanup: 'owned processes/profiles verified by test-scratch; canonical token released' };
    if (evidence) fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify(receipt, null, 2)); console.log('Owned T71 fixture cleaned; canonical GUI slot released.');
  } catch (e) { console.error('Cleanup unconfirmed; retaining GUI lock:', e.stack); process.exitCode = 1; }
});
