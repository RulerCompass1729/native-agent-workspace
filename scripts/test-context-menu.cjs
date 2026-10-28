const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// Existing Electron/DSH surface and synthetic transport. Clipboard readers and
// writer are intercepted in the owned main process, never backed up or read.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { fork } = testScratch.childProcess, { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-context-menu-'));
fs.writeFileSync(path.join(profile, 'workspace.json'), JSON.stringify({ sessions: [], drafts: {}, room: { messages: [{ id: 'shared-context', role: 'human', name: 'Local fixture', text: 'Shared original context 你好', status: 'complete', time: Date.now() }] } }));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: profile }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let app, page, client, request = 0, sequence = 0; const checks = [], errors = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 150; i++) { if (await fn()) return; await delay(40); } throw Error(label); }
function fixture(method = 'stats', target, value) { const id = ++request; return new Promise((resolve, reject) => {
  const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 8000);
  const cb = result => { if (result.requestId === id) { clearTimeout(timer); child.off('message', cb); resolve(result); } }; child.on('message', cb); child.send({ id, method, target, value });
}); }
const snapshot = () => page.evaluate(() => workspace.initial());
const copied = () => app.evaluate(() => globalThis.menuClipboard.copies.at(-1));
const item = name => page.getByRole('menuitem', { name, exact: true });
async function open(target, keyboard) { if (keyboard) { await target.focus(); await target.press(keyboard); } else await target.click({ button: 'right' }); await item('复制').waitFor(); }
async function selectText(target) { return target.evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); return selection.toString(); }); }
async function capture(name) { if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true, mode: 0o700 }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png') }); } }
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Service ready'); client = await connect(profile, 'context-menu-observer');
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  await app.context().addInitScript(() => { window.menuTerms = new Map(); let constructor; Object.defineProperty(window, 'Terminal', { configurable: true, get: () => constructor, set: value => { constructor = value; const open = value.prototype.open; value.prototype.open = function (element, ...args) { window.menuTerms.set(element.closest('[data-terminal-id]').dataset.terminalId, this); return open.call(this, element, ...args); }; } }); });
  page = await app.firstWindow(); page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message)); await page.locator('#new-session').waitFor(); await page.reload(); await page.locator('#new-session').waitFor();
  await app.evaluate(({ clipboard, nativeImage, shell }) => {
    globalThis.menuOriginals = { writeText: clipboard.writeText, readText: clipboard.readText, readImage: clipboard.readImage, openExternal: shell.openExternal };
    globalThis.menuClipboard = { copies: [], reads: 0, imageReads: 0, text: 'Paste original 你好\nSecond\tline', fail: false, hold: false, external: [] };
    clipboard.writeText = text => { if (globalThis.menuClipboard.fail) throw Error('Synthetic menu copy refused'); globalThis.menuClipboard.copies.push(text); };
    clipboard.readText = () => { const state = globalThis.menuClipboard; state.reads++; return state.hold ? new Promise(resolve => { globalThis.menuRelease = () => resolve(state.text); }) : state.text; };
    clipboard.readImage = () => { globalThis.menuClipboard.imageReads++; return nativeImage.createEmpty(); };
    shell.openExternal = url => { globalThis.menuClipboard.external.push(url); return Promise.resolve(); };
  });
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check(); await page.locator('#session-name').fill('Context menu task'); await createIn(page, 'chat');
  const id = (await snapshot()).sessions[0].id; await until(async () => (await fixture()).pending.includes(id), 'Native snapshot'); await fixture('release', id); await page.locator('.terminal-surface').waitFor();
  const original = (await snapshot()).sessions[0], identity = s => [s.id, s.nativeId, s.owner];
  const input = page.locator('#message-input'), draft = 'Draft 你好\nKeep tabs\tintact'; await input.fill(draft); await input.evaluate(el => el.select());
  await open(input); await capture('input-menu'); await item('复制').click(); await until(async () => await copied() === draft, 'Input selection copied exactly');
  assert.equal(await input.inputValue(), draft);
  await input.evaluate(el => el.select()); await open(input, 'Shift+F10'); await app.evaluate(() => { globalThis.menuClipboard.fail = true; }); await item('剪切').click();
  await until(async () => (await page.locator('#toast-text').innerText()).includes('Synthetic menu copy refused'), 'Cut copy error is visible'); assert.equal(await input.inputValue(), draft);
  await app.evaluate(() => { globalThis.menuClipboard.fail = false; }); await input.evaluate(el => el.select()); await open(input); await item('剪切').click(); await until(async () => await input.inputValue() === '', 'Cut after copy acknowledgement');
  await input.press('Meta+z'); await until(async () => await input.inputValue() === draft, 'Native undo retains the original draft');
  await input.evaluate(el => el.select()); await open(input); await item('粘贴').click(); await until(async () => await input.inputValue() === 'Paste original 你好\nSecond\tline', 'Menu paste preserves Unicode, tabs and newlines in the original selection');
  await input.press('Meta+z'); await until(async () => await input.inputValue() === draft, 'Menu paste keeps native undo');
  await app.evaluate(() => { globalThis.menuClipboard.text = 'x'.repeat(16001); }); await input.evaluate(el => el.select()); await open(input); await item('粘贴').click(); await delay(150);
  assert.equal(await input.inputValue(), draft, 'Oversized clipboard text must not replace or silently truncate the existing draft');
  await app.evaluate(() => { globalThis.menuClipboard.text = 'Paste original 你好'; });
  checks.push('Input pointer/Shift+F10 Copy, acknowledged Cut with failure retry, Paste and native Undo preserve exact text');

  await page.locator('#new-session').click();
  const modalInput = page.locator('#session-name'); await modalInput.fill('Modal context 你好'); await modalInput.evaluate(el => el.select());
  await open(modalInput, 'Shift+F10'); await capture('modal-input-menu'); await item('复制').click(); await until(async () => await copied() === 'Modal context 你好', 'Modal input menu is interactive above its dialog');
  await open(modalInput, 'Shift+F10'); await page.keyboard.press('Escape'); assert.equal(await page.locator('#create-dialog').isVisible(), true); assert.equal(await modalInput.inputValue(), 'Modal context 你好', 'Escape dismisses only the menu');
  await open(modalInput); const win = await app.browserWindow(page); await win.evaluate(w => w.setSize(850, 600)); await delay(150);
  const modalBounds = await item('复制').evaluate(el => { const menu = el.closest('[role="menu"]').getBoundingClientRect(), dialog = el.closest('dialog').getBoundingClientRect(); return { left: menu.left, right: menu.right, top: menu.top, bottom: menu.bottom, dialog: { left: dialog.left, right: dialog.right, top: dialog.top, bottom: dialog.bottom } }; });
  assert.ok(modalBounds.left >= modalBounds.dialog.left && modalBounds.right <= modalBounds.dialog.right && modalBounds.top >= modalBounds.dialog.top && modalBounds.bottom <= modalBounds.dialog.bottom, 'Modal menu remains visible inside a resized dialog'); await capture('modal-menu-small'); await page.keyboard.press('Escape');
  await win.evaluate(w => w.setSize(1240, 850));
  await page.locator('#cancel-create').click(); checks.push('Existing modal inputs expose an interactive keyboard context menu without closing or changing the form');

  await page.locator('#privacy-button').click(); const modalText = page.locator('#privacy-dialog > p').first(); await modalText.waitFor();
  for (const keyboard of [false, true]) {
    const expected = await selectText(modalText); await page.evaluate(() => document.activeElement?.blur());
    if (keyboard) await page.keyboard.press('Shift+F10'); else await modalText.click({ button: 'right' });
    await item('复制').waitFor(); await capture(keyboard ? 'modal-static-keyboard' : 'modal-static-pointer');
    const placement = await item('复制').evaluate(el => ({ menuDialog: el.closest('dialog')?.id, focusedTag: document.activeElement?.tagName }));
    console.log(JSON.stringify({ modalStaticMenu: keyboard ? 'keyboard' : 'pointer', placement }));
    assert.equal(placement.menuDialog, 'privacy-dialog', 'Static modal text uses the target dialog even when body has focus');
    await item('复制').click(); await until(async () => await copied() === expected, 'Static modal text is copied exactly');
  }
  await page.locator('#close-privacy').click(); checks.push('Static modal text supports pointer and body-focus keyboard Copy inside the target dialog');

  await open(input); await item('全选').click(); assert.deepEqual(await input.evaluate(el => [el.selectionStart, el.selectionEnd]), [0, draft.length]);
  await app.evaluate(() => { globalThis.menuClipboard.hold = true; }); const beforeRead = await app.evaluate(() => globalThis.menuClipboard.reads);
  await open(input); await item('粘贴').click(); await until(async () => await app.evaluate(() => globalThis.menuClipboard.reads) > beforeRead, 'Delayed explicit paste');
  await input.fill('Newer unsent draft'); await app.evaluate(() => { globalThis.menuClipboard.hold = false; globalThis.menuRelease(); }); await delay(150); assert.equal(await input.inputValue(), 'Newer unsent draft');
  await until(async () => (await snapshot()).sessions[0].liveDraft === 'Newer unsent draft', 'Newer draft persisted');
  await input.evaluate(el => el.select()); await app.evaluate(() => { globalThis.menuClipboard.hold = true; }); const beforeEditReturn = await app.evaluate(() => globalThis.menuClipboard.reads);
  await open(input); await item('粘贴').click(); await until(async () => await app.evaluate(() => globalThis.menuClipboard.reads) > beforeEditReturn, 'Delayed paste before edit and return');
  await input.fill('Temporary newer edit'); await input.fill('Newer unsent draft'); await input.evaluate(el => el.select());
  await app.evaluate(() => { globalThis.menuClipboard.hold = false; globalThis.menuRelease(); }); await delay(150); assert.equal(await input.inputValue(), 'Newer unsent draft', 'Existing draft revision also protects an edit that returns to the same value and selection');
  await input.evaluate(el => el.select()); await app.evaluate(() => { globalThis.menuClipboard.hold = true; globalThis.menuClipboard.text = 'Do not paste after returning'; });
  const beforeReturn = await app.evaluate(() => globalThis.menuClipboard.reads); await open(input); await item('粘贴').click();
  await until(async () => await app.evaluate(() => globalThis.menuClipboard.reads) > beforeReturn, 'Delayed paste before switching away');
  await page.locator('#room-nav').click(); await page.locator(`[data-session-id="${id}"]`).click();
  await app.evaluate(() => { globalThis.menuClipboard.hold = false; globalThis.menuRelease(); }); await delay(150); assert.equal(await input.inputValue(), 'Newer unsent draft');
  const beforeDismiss = await app.evaluate(() => globalThis.menuClipboard.copies.length); await open(input); await page.keyboard.press('Escape'); await open(input, 'Shift+F10'); await page.keyboard.press('Tab');
  assert.equal(await app.evaluate(() => globalThis.menuClipboard.copies.length), beforeDismiss); assert.equal(await input.inputValue(), 'Newer unsent draft');
  checks.push('Select All and harmless Escape/Tab work; delayed clipboard cannot overwrite a newer edit or a switched-away-and-returned view');

  await fixture('history', id, [{ id: 'private-context', type: 'agentMessage', text: 'Private original context 你好\n\n[Local guide](https://example.invalid/guide)' }]);
  const body = page.locator('#messages .message.assistant .message-body').last(); await body.waitFor(); const originalText = await selectText(body);
  await open(body); await item('复制').click(); await until(async () => await copied() === originalText, 'Private reader selection');
  await selectText(body); await page.evaluate(() => document.activeElement?.blur()); assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
  await page.keyboard.press('Shift+F10'); await item('复制').click(); await until(async () => await copied() === originalText, 'Keyboard menu uses the selected reading text when body has focus');
  const link = body.getByRole('link', { name: 'Local guide', exact: true }); await link.click({ button: 'right' }); await item('复制链接').click(); await until(async () => await copied() === 'https://example.invalid/guide', 'Link copied without opening a browser');
  await page.locator('#room-nav').click(); await page.locator('#room-record').click(); const shared = page.locator('#room-messages [data-message-id="shared-context"] .message-body'); await shared.waitFor(); const sharedText = await selectText(shared);
  await open(shared); await item('复制').click(); await until(async () => await copied() === sharedText, 'Shared reader selection');
  await page.locator('#room-nav').click({ button: 'right' }); await item('重命名…').waitFor(); assert.equal(await item('剪切').count(), 0); await page.keyboard.press('Escape');
  await page.locator(`[data-session-id="${id}"]`).click(); await page.locator(`[data-session-row="${id}"]`).click({ button: 'right' }); await item('复制完整 NAW ID').waitFor(); await page.keyboard.press('Escape');
  checks.push('Private/shared original selections and links copy exactly; session and room keep their dedicated menus');

  await page.locator('#terminal-tab').click(); await fixture('terminal', id, { sequence: ++sequence, data: '\x1bcTerminal original 你好\r\nSecond line\x1b[?1000h\x1b[?1006h\x1b[?2004h' });
  await until(() => page.evaluate(id => window.menuTerms.get(id).modes.mouseTrackingMode === 'vt200', id), 'Actual native mouse mode');
  await page.evaluate(id => window.menuTerms.get(id).select(0, 0, 22), id); const selected = await page.evaluate(id => window.menuTerms.get(id).getSelection(), id);
  const surface = page.locator('.terminal-surface'), beforeNative = (await fixture()).inputs.length; await surface.click({ button: 'right' }); await delay(100);
  assert.ok((await fixture()).inputs.length > beforeNative, 'Ordinary native mouse right-click is preserved'); assert.equal(await item('复制').count(), 0);
  await page.evaluate(id => window.menuTerms.get(id).select(0, 0, 22), id); await page.keyboard.down('Alt'); try { await surface.click({ button: 'right' }); } finally { await page.keyboard.up('Alt'); }
  await item('复制').click(); await until(async () => await copied() === selected, 'Native context Copy uses existing native selection');
  await page.evaluate(id => window.menuTerms.get(id).focus(), id); const beforeKey = (await fixture()).inputs.length; await page.keyboard.press('Shift+F10'); await item('复制').waitFor(); assert.equal((await fixture()).inputs.length, beforeKey, 'Menu shortcut is not encoded into the native program'); await capture('native-menu');
  await app.evaluate(() => { globalThis.menuClipboard.text = 'Native menu paste'; }); await item('粘贴').click();
  await until(async () => (await fixture()).inputs.some(row => row.data.includes('Native menu paste')), 'Native menu Paste follows existing bracketed path');
  const pasted = (await fixture()).inputs.find(row => row.data.includes('Native menu paste')); assert.equal(pasted.data, '\x1b[200~Native menu paste\x1b[201~');
  await page.evaluate(id => window.menuTerms.get(id).focus(), id); await page.keyboard.press('ContextMenu'); await item('复制').waitFor(); const beforeStale = (await fixture()).inputs.length, beforeReads = await app.evaluate(() => globalThis.menuClipboard.reads);
  await fixture('set-owner', id, 'other-window'); await until(() => input.evaluate(el => el.readOnly), 'Native owner changed while menu open'); await item('粘贴').click(); await delay(100);
  assert.equal((await fixture()).inputs.length, beforeStale); assert.equal(await app.evaluate(() => globalThis.menuClipboard.reads), beforeReads, 'Stale native menu does not read clipboard or deliver elsewhere');
  await input.evaluate(el => el.select()); await open(input); assert.equal(await item('剪切').count() === 0 || await item('剪切').isDisabled(), true, 'Readonly input cannot be cut'); assert.equal(await item('粘贴').count() === 0 || await item('粘贴').isDisabled(), true, 'Readonly input cannot be pasted'); await page.keyboard.press('Escape');
  checks.push('Native ordinary right-click remains native; Option-right/menu key and Shift+F10 reach guarded Copy/Paste without shortcut leakage or stale-owner paste');
  const stats = await fixture(), clipboardState = await app.evaluate(() => globalThis.menuClipboard); assert.deepEqual(stats.sends, []); assert.deepEqual(stats.interruptions, []); assert.deepEqual(clipboardState.external, []); assert.deepEqual(errors, []);
  const final = (await snapshot()).sessions.find(s => s.id === id); assert.deepEqual([final.id, final.nativeId], identity(original).slice(0, 2)); assert.equal(final.liveDraft, 'Newer unsent draft');
  console.log(JSON.stringify({ checks, errors, nativeInputs: stats.inputs, copies: clipboardState.copies, clipboardReads: clipboardState.reads, modelTasks: 0, realProviderProcesses: 0, systemClipboard: 'readers/writer intercepted; original formats untouched', physicalMouseKeyboard: 'not tested', scriptSha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(__filename)).digest('hex') }, null, 2));
}
run().catch(async error => { console.error(error.stack); console.error(JSON.stringify({ partialChecks: checks, errors })); if (page) await capture('failed'); process.exitCode = 1; }).finally(testScratch.cleanup(async () => {
  try { if (app) { await app.evaluate(({ clipboard, shell }) => { if (globalThis.menuOriginals) { Object.assign(clipboard, { writeText: globalThis.menuOriginals.writeText, readText: globalThis.menuOriginals.readText, readImage: globalThis.menuOriginals.readImage }); shell.openExternal = globalThis.menuOriginals.openExternal; } }); await app.close(); } if (client) { for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); } }
  finally { if (child.connected) child.disconnect(); if (child.exitCode === null) child.kill('SIGTERM'); }
}));
