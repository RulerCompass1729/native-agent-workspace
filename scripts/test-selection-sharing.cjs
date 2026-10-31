// Existing five-group pointer-selection sharing journey, isolated source GUI and synthetic providers only.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const plan = { task: 'T33 current selection-sharing source GUI', fullGuiStarts: 1, ownedSyntheticDaemons: 1, syntheticSessions: 2, syntheticSends: 0, terminalInputs: 0, productModels: 0, realProviders: 0, osClipboard: 0, maxRunMs: 300000 };
if (process.argv.includes('--plan')) { console.log(JSON.stringify(plan, null, 2)); process.exit(0); }
assert.equal(process.env.NAW_T33_SELECTION_GUI_AUTHORIZED, '1', 'Record the finite source GUI plan before running');
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
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const env = additions => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NAW_') && !key.startsWith('ELECTRON_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(key))), ...additions });
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-selection-ui-'));
const entry = path.join(profile, 'entry'); fs.mkdirSync(entry);
fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ name: 'naw-owned-selection-gui', version: require('../package.json').version, main: 'main.cjs' }));
fs.writeFileSync(path.join(entry, 'main.cjs'), `const cp=require('node:child_process'),path=require('node:path'),e=require('electron');
globalThis.selectionGuards={clipboard:0,external:0,dialogs:0,maintenance:0,replacement:0};
const spawn=cp.spawn;cp.spawn=function(bin,args,...rest){if(Array.isArray(args)&&args.some(arg=>typeof arg==='string'&&path.basename(arg)==='daemon.cjs')){globalThis.selectionGuards.replacement++;throw Error('Replacement backend prohibited');}return spawn.call(this,bin,args,...rest);};
for(const name of ['readText','writeText','readImage','writeImage','read','write','readBuffer','writeBuffer','clear'])e.clipboard[name]=()=>{globalThis.selectionGuards.clipboard++;throw Error('OS clipboard prohibited');};
e.shell.openPath=e.shell.openExternal=async()=>{globalThis.selectionGuards.external++;throw Error('External action prohibited');};
e.dialog.showOpenDialog=e.dialog.showMessageBox=async()=>{globalThis.selectionGuards.dialogs++;throw Error('OS dialog prohibited');};
const {WorkspaceClient}=require(${JSON.stringify(path.join(root, 'app/workspace-client.cjs'))});WorkspaceClient.prototype.maintainService=function(){globalThis.selectionGuards.maintenance++;throw Error('Backend update prohibited');};
require(${JSON.stringify(path.join(root, 'app/main.cjs'))});`);
const executablePath = require('electron'), args = [entry];
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/native-progress.cjs')], env: env({ NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code }), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let application, page, client, sequence = 0, previews = 0, failure; const errors = [], checks = [], guiPids = [], guardSamples = [];
const started = Date.now();
async function guards() { const values = await application.evaluate(() => globalThis.selectionGuards); assert.deepEqual(values, { clipboard: 0, external: 0, dialogs: 0, maintenance: 0, replacement: 0 }); guardSamples.push(values); }
async function check(text) { assert.ok(Date.now() - started < plan.maxRunMs, 'Five-minute stage-entry budget'); checks.push(text); console.log('PASS:', text); await capture('stage-' + String(checks.length).padStart(2, '0')); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method = 'stats', target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const cb = m => { if (m.requestId === id) { clearTimeout(timer); child.off('message', cb); m.error ? reject(Error(m.error)) : resolve(m); } };
    const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 20000);
    child.on('message', cb); child.send({ id, method, target, value });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
// The native terminal beside the chat is the only live screen (the readonly progress panel was removed).
const nativePane = id => page.locator(`[data-terminal-id="${id}"]`);
async function create(provider) {
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#session-name').fill(provider + ' · 实时过程'); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => s.provider === provider && s.state === 'idle'), 'Created');
  const id = (await snapshot()).sessions.find(s => s.provider === provider).id;
  await until(() => nativePane(id).locator('.xterm').count(), 'Native screen'); return id;
}
async function screen(id) {
  return page.evaluate(id => {
    const t = [...window.progressTestTerminals].reverse().find(t => t.element?.isConnected && t.element.closest('[data-terminal-id]')?.dataset.terminalId === id);
    if (!t) return null;
    const b = t.buffer.active;
    return { cols: t.cols, rows: t.rows, type: b.type, cursor: [b.cursorX, b.cursorY], lines: Array.from({ length: b.length }, (_, i) => b.getLine(i).translateToString()) };
  }, id);
}
async function aligned(id) {
  // The canonical screen follows native resizes too, so compare with its latest state.
  await until(async () => JSON.stringify(await screen(id)) === JSON.stringify((await fixture('stats', id)).screen), 'Canonical screen alignment');
}
async function capture(name) {
  if (!page || page.isClosed()) return;
  fs.mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: path.join(evidence, name + '.png') });
  fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(await snapshot(), null, 2));
  const ui = await page.evaluate(() => ({ shareOpen: document.querySelector('#share-dialog').open, preview: document.querySelector('#share-text').value, recipient: document.querySelector('#share-recipient').value, documentSelection: getSelection().toString(), terminalSelections: (window.progressTestTerminals || []).map(t => ({ id: t.element?.closest('[data-terminal-id]')?.dataset.terminalId, text: t.getSelection() })) }));
  fs.writeFileSync(path.join(evidence, name + '.ui.json'), JSON.stringify(ui, null, 2));
}
async function join(id) {
  const room = (await snapshot()).rooms.find(room => room.id === 'shared');
  await page.locator(`[data-session-menu="${id}"]`).click();
  await page.getByRole('menuitem', { name: `加入「${room.name}」`, exact: true }).click();
  await until(async () => (await snapshot()).sessions.find(s => s.id === id).roomIds?.includes('shared'), 'Visible membership acknowledged');
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Daemon'); client = await connect(profile, 'selection-test');
  const backend = await client.call('initial'); assert.equal(backend.servicePid, child.pid); assert.equal(backend.runtimeVersion, require('../package.json').version); assert.equal(backend.sessions.length, 0);
  application = await _electron.launch({ executablePath, args, env: env({ NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }), timeout: 70000 }); guiPids.push(application.process().pid);
  page = await application.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  await page.evaluate(() => { window.progressTestTerminals = []; const open = Terminal.prototype.open; Terminal.prototype.open = function (...args) { progressTestTerminals.push(this); return open.apply(this, args); }; });
  const b = await create('codex'); await join(b);
  const a = await create('claude'), share = page.locator('#header-actions').getByRole('button', { name: '分享选中内容', exact: true, includeHidden: true });
  // The solo header uses its visible More menu; focused room members keep the visible original button.
  async function visibleShareControl() {
    const more = page.locator('#session-header-more');
    if (await more.isVisible()) { await more.click(); return page.getByRole('menuitem', { name: '分享选中内容', exact: true }); }
    await share.waitFor({ state: 'visible' }); return share;
  }
  async function visibleDisabled() {
    const control = await visibleShareControl(); assert.equal(await control.isDisabled(), true);
    const more = page.locator('#session-header-more');
    if (await more.getAttribute('aria-expanded') === 'true') {
      await page.keyboard.press('Escape'); await until(async () => await more.getAttribute('aria-expanded') === 'false', 'Visible share menu closes');
    }
  }
  assert.equal(await share.isDisabled(), true); await visibleDisabled();
  async function selection(id) {
    return page.evaluate(id => { const t = [...progressTestTerminals].reverse().find(t => t.element?.isConnected && t.element.closest('[data-terminal-id]')?.dataset.terminalId === id); return t && { text: t.getSelection(), cols: t.cols, rows: t.rows }; }, id);
  }
  async function dragLine(id) {
    const host = nativePane(id);
    const rect = await host.locator('.xterm-screen').boundingBox(), size = await selection(id); assert.ok(rect && size);
    await page.mouse.move(rect.x + 1, rect.y + rect.height / size.rows / 2); await page.mouse.down();
    await page.mouse.move(rect.x + rect.width / size.cols * 19, rect.y + rect.height / size.rows / 2, { steps: 12 }); await page.mouse.up();
    await until(async () => (await selection(id)).text.includes('SHARE-THIS-LINE'), 'Pointer selected source line');
    return (await selection(id)).text;
  }
  async function dragDocumentText(target, expected) {
    await target.scrollIntoViewIfNeeded();
    const points = await target.evaluate((el, text) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node; while ((node = walker.nextNode()) && !node.data.includes(text)) {}
      if (!node) return null;
      const start = node.data.indexOf(text), first = document.createRange(), last = document.createRange();
      first.setStart(node, start); first.setEnd(node, start + 1);
      last.setStart(node, start + text.length - 1); last.setEnd(node, start + text.length);
      const a = first.getBoundingClientRect(), b = last.getBoundingClientRect();
      return { x1: a.left + a.width * .1, y1: a.top + a.height / 2, x2: b.right - b.width * .1, y2: b.top + b.height / 2 };
    }, expected);
    assert.ok(points, 'Visible fixture text has glyph geometry');
    await page.mouse.click(points.x1, points.y1);
    await until(async () => await page.evaluate(() => getSelection().toString()) === '', 'Real click collapses the previous document selection');
    await page.mouse.move(points.x1, points.y1); await page.mouse.down();
    await page.mouse.move(points.x2, points.y2, { steps: 12 }); await page.mouse.up();
    await until(async () => await page.evaluate(() => getSelection().toString()) === expected, 'Pointer selected exact document text');
    assert.equal(await page.locator('#messages').evaluate(el => { const s = getSelection(); return el.contains(s.anchorNode) && el.contains(s.focusNode); }), true, 'Positive selection stays inside the original reader');
    return page.evaluate(() => getSelection().toString());
  }
  async function preview(text) {
    await until(() => share.isEnabled(), 'Selected source is shareable'); const control = await visibleShareControl(); assert.equal(await control.isEnabled(), true); await control.click(); await page.locator('#share-dialog').waitFor();
    assert.equal(await page.locator('#share-text').inputValue(), text);
    await page.locator('#share-recipient').selectOption(b); assert.equal(await page.locator('#confirm-share').isEnabled(), true);
    await capture('selected-preview-' + String(++previews).padStart(2, '0')); await page.locator('#cancel-share').click();
  }
  await fixture('output', a, { data: '\x1bcSHARE-THIS-LINE\r\n' }); await aligned(a);
  await preview(await dragLine(a));
  await page.locator('#close-native-terminal').click(); await until(() => share.isDisabled(), 'A hidden native terminal is not shareable'); await visibleDisabled();
  await page.locator('#terminal-tab').click(); await nativePane(a).locator('.xterm-screen').waitFor(); await page.locator('#chat-tab').click();
  await check('Empty selection disables sharing; actual pointer selection from the native terminal opens an exact-text preview for an explicitly chosen recipient; hiding the terminal withdraws it');

  await fixture('history', a, [{ id: 'selected-message', type: 'agentMessage', text: 'VISIBLE CONVERSATION TEXT' }]);
  const message = page.locator('#messages').getByText('VISIBLE CONVERSATION TEXT', { exact: true }); await message.waitFor(); await message.click({ clickCount: 3 });
  const paragraph = await page.locator('#messages').evaluate(el => { const s = getSelection(); return { text: s.toString(), inside: el.contains(s.anchorNode) && el.contains(s.focusNode), anchorName: s.anchorNode.nodeName, focusName: s.focusNode.nodeName, focusId: s.focusNode.nodeType === 1 ? s.focusNode.id : s.focusNode.parentElement?.id }; });
  assert.equal(paragraph.text.trim(), 'VISIBLE CONVERSATION TEXT');
  await until(async () => !(await selection(a)).text, 'New document selection clears old terminal selection');
  fs.writeFileSync(path.join(evidence, 'paragraph-range.json'), JSON.stringify(paragraph, null, 2));
  if (!paragraph.inside) { await until(() => share.isDisabled(), 'A paragraph selection crossing outside the reader is not a share source'); await visibleDisabled(); }
  const dom = await dragDocumentText(message, 'VISIBLE CONVERSATION TEXT'); assert.equal(dom.trim(), 'VISIBLE CONVERSATION TEXT'); await preview(dom);
  await dragDocumentText(message, 'VISIBLE CONVERSATION TEXT'); await preview(await dragLine(a));
  assert.equal(await page.evaluate(() => getSelection().toString()), '');
  await check('New conversation text supersedes old terminal selection; new pointer selection in the native pane supersedes the document selection without combining text');

  await page.locator(`[data-session-id="${b}"]`).click(); assert.equal(await share.isDisabled(), true); await visibleDisabled();
  // Back on a, its terminal shows the same highlighted selection again; only that visible text is offered.
  await page.locator(`[data-session-id="${a}"]`).click(); await preview((await selection(a)).text);
  await page.locator('#terminal-tab').click(); await nativePane(a).locator('.xterm-screen').waitFor(); await preview(await dragLine(a));
  // The chat tab keeps the terminal beside it, highlight and all; hiding it is checked above.
  await page.locator('#chat-tab').click(); await preview((await selection(a)).text);
  await check('Another session never reuses a hidden selection; a selection still shown in the native terminal shares its exact original text');

  await fixture('nativeBlock', a, { id: 'tool:folded-record', kind: 'tool', turnId: 'trace', title: 'Read', input: 'trace.txt', text: 'VISIBLE TRACE TEXT', status: 'complete' });
  // Progress records are inline tool rows in the reader now.
  const item = page.locator('#messages .process').filter({ hasText: 'VISIBLE TRACE TEXT' }); await item.waitFor();
  if (!(await item.locator('.process-details').evaluate(el => el.open))) await item.locator('.process-details > summary').click();
  const text = item.locator('.message-body'); await dragDocumentText(text, 'VISIBLE TRACE TEXT');
  await until(async () => !(await selection(a)).text, 'The record selection supersedes the older terminal selection');
  assert.equal((await page.evaluate(() => getSelection().toString())).trim(), 'VISIBLE TRACE TEXT'); await until(() => share.isEnabled(), 'Selected record shareable');
  await item.locator('.process-details > summary').focus(); await page.keyboard.press('Enter'); await until(() => share.isDisabled(), 'Collapsed record not shareable'); await visibleDisabled();
  await check('Keyboard collapse of a selected record rejects the hidden text rather than sharing an obsolete selection');

  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await page.locator('#room-messages').evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  await page.locator('#room-overview').click();
  await page.locator(`.collaboration-member-status[data-member-id="${b}"] .collaboration-member-name`).click();
  await page.locator('#terminal-tab').click();
  await page.locator(`[data-terminal-id="${b}"] .xterm-screen`).waitFor(); assert.equal(await share.isDisabled(), true); await visibleDisabled();
  await check('Room-to-member navigation does not treat the shared timeline selection as that member terminal selection');
  assert.equal((await fixture()).stats.sends, 0); assert.equal((await fixture()).stats.inputs, 0); assert.deepEqual(errors, []); await guards();
  const windows = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() })));
  assert.deepEqual(windows, [{visible:false,focusable:false}]);
  console.log(JSON.stringify({ checks, stats:(await fixture()).stats, errors, windows, modelTasks:0, nativeProcesses:0 }, null, 2));
}
const cleanup = testScratch.cleanup(async () => {
  if (application) await application.close();
  if (client) { await fixture('stop'); await client.call('shutdown'); client.close(); } else if (child.exitCode === null) child.kill('SIGTERM');
  if (child.connected) child.disconnect(); await until(() => child.exitCode !== null, 'Owned fixture exits');
});
run().catch(async error => { failure = error.stack; console.error(failure); process.exitCode = 1; await capture('failed').catch(() => {}); }).finally(async () => {
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ checks, previews, failure, errors, profile, ownedNodePid: child.pid, ownedGuiPids: guiPids, guards: guardSamples, currentGuards: application ? await application.evaluate(() => globalThis.selectionGuards).catch(() => null) : null, fixture: child.connected ? await fixture().catch(() => null) : null }, null, 2));
  await cleanup(); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
  fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ token, releasedAt: new Date().toISOString(), ownedProfileGone: !fs.existsSync(profile) }));
});
