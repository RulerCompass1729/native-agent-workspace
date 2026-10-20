// Real pointer selection in the actual Electron/xterm interface; synthetic output only.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { fork } = require('node:child_process');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-selection-ui-'));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/native-progress.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let application, page, client, sequence = 0; const errors = [], checks = [];
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
const panel = id => page.locator(`[data-progress-id="${id}"]`);
async function create(provider) {
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#initial-view').selectOption('chat'); await page.locator('#session-name').fill(provider + ' · 实时过程'); await page.locator('#confirm-create').click();
  await until(async () => (await snapshot()).sessions.some(s => s.provider === provider && s.state === 'idle'), 'Created');
  const id = (await snapshot()).sessions.find(s => s.provider === provider).id;
  await until(() => panel(id).locator('.xterm').count(), 'Readonly screen'); return id;
}
async function screen(id) {
  return page.evaluate(id => {
    const t = [...window.progressTestTerminals].reverse().find(t => t.element?.closest('[data-progress-id]')?.dataset.progressId === id);
    if (!t) return null;
    const b = t.buffer.active;
    return { cols: t.cols, rows: t.rows, type: b.type, cursor: [b.cursorX, b.cursorY], lines: Array.from({ length: b.length }, (_, i) => b.getLine(i).translateToString()) };
  }, id);
}
async function aligned(id) {
  const expected = (await fixture('stats', id)).screen;
  await until(async () => JSON.stringify(await screen(id)) === JSON.stringify(expected), 'Canonical screen alignment');
}
async function capture(name) {
  if (!process.env.NAW_EVIDENCE_DIR || !page || page.isClosed()) return;
  fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png') });
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Daemon'); client = await connect(profile, 'selection-test');
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await application.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  await page.evaluate(() => { window.progressTestTerminals = []; const open = Terminal.prototype.open; Terminal.prototype.open = function (...args) { progressTestTerminals.push(this); return open.apply(this, args); }; });
  const b = await create('codex'); await page.getByRole('button', { name: '加入协作', exact: true }).click();
  const a = await create('claude'), share = page.locator('#header-actions').getByRole('button', { name: '分享选中内容', exact: true });
  assert.equal(await share.isDisabled(), true);
  async function selection(id, native = false) {
    return page.evaluate(({id, native}) => { const t = [...progressTestTerminals].reverse().find(t => t.element?.isConnected && (native ? t.element.closest('[data-terminal-id]')?.dataset.terminalId : t.element.closest('[data-progress-id]')?.dataset.progressId) === id); return t && { text: t.getSelection(), cols: t.cols, rows: t.rows }; }, {id, native});
  }
  async function dragLine(id, native = false) {
    const host = native ? page.locator(`[data-terminal-id="${id}"]`) : panel(id);
    if (!native) await host.locator('.progress-viewport').evaluate(el => el.scrollTop = 0);
    const rect = await host.locator('.xterm-screen').boundingBox(), size = await selection(id, native); assert.ok(rect && size);
    await page.mouse.move(rect.x + 1, rect.y + rect.height / size.rows / 2); await page.mouse.down();
    await page.mouse.move(rect.x + rect.width / size.cols * 19, rect.y + rect.height / size.rows / 2, { steps: 12 }); await page.mouse.up();
    await until(async () => (await selection(id, native)).text.includes('SHARE-THIS-LINE'), 'Pointer selected source line');
    return (await selection(id, native)).text;
  }
  async function preview(text) {
    await until(() => share.isEnabled(), 'Selected source is shareable'); await share.click(); await page.locator('#share-dialog').waitFor();
    assert.equal(await page.locator('#share-text').inputValue(), text);
    await page.locator('#share-recipient').selectOption(b); assert.equal(await page.locator('#confirm-share').isEnabled(), true);
    await capture('selected-preview'); await page.locator('#cancel-share').click();
  }
  await fixture('output', a, { data: '\x1bcSHARE-THIS-LINE\r\n' }); await aligned(a);
  await preview(await dragLine(a));
  await panel(a).locator(':scope > summary').focus(); await page.keyboard.press('Enter');
  await until(() => share.isDisabled(), 'Collapsed native pane not shareable');
  await page.keyboard.press('Enter'); await until(() => share.isEnabled(), 'Reopened selected pane is shareable');
  checks.push('Empty selection disables sharing; actual pointer selection from the readonly native pane opens an exact-text preview for an explicitly chosen recipient');

  await fixture('history', a, [{ id: 'selected-message', type: 'agentMessage', text: 'VISIBLE CONVERSATION TEXT' }]);
  const message = page.locator('#messages').getByText('VISIBLE CONVERSATION TEXT', { exact: true }); await message.waitFor(); await message.click({ clickCount: 3 });
  const dom = await page.evaluate(() => getSelection().toString()); assert.equal(dom.trim(), 'VISIBLE CONVERSATION TEXT');
  await until(async () => !(await selection(a)).text, 'New document selection clears old terminal selection'); await preview(dom);
  await message.click({ clickCount: 3 }); await preview(await dragLine(a));
  assert.equal(await page.evaluate(() => getSelection().toString()), '');
  checks.push('New conversation text supersedes old terminal selection; new pointer selection in the native pane supersedes the document selection without combining text');

  await page.locator(`[data-session-id="${b}"]`).click(); assert.equal(await share.isDisabled(), true);
  await page.locator(`[data-session-id="${a}"]`).click(); assert.equal(await share.isDisabled(), true);
  await page.locator('#terminal-tab').click(); await page.locator('#terminal-area .xterm-screen').waitFor(); await preview(await dragLine(a, true));
  await page.locator('#chat-tab').click(); assert.equal(await share.isDisabled(), true);
  checks.push('Session and view changes do not reuse the other hidden selection; native terminal pointer selection still shares the exact original text');

  await fixture('progress', a, { id: 'folded-record', title: 'Read', status: 'completed', text: 'VISIBLE TRACE TEXT' });
  const trace = panel(a).locator('.progress-trace'); if (!(await trace.evaluate(el => el.open))) await trace.locator(':scope > summary').click();
  const item = trace.locator('[data-item-id="folded-record"]'); await item.locator('summary').click();
  const text = item.locator('pre'); await text.click({ clickCount: 3 });
  assert.equal((await page.evaluate(() => getSelection().toString())).trim(), 'VISIBLE TRACE TEXT'); await until(() => share.isEnabled(), 'Selected trace shareable');
  await item.locator('summary').focus(); await page.keyboard.press('Enter'); await until(() => share.isDisabled(), 'Collapsed record not shareable');
  await item.locator('summary').click(); await text.click({ clickCount: 3 });
  await trace.locator(':scope > summary').focus(); await page.keyboard.press('Enter'); await until(() => share.isDisabled(), 'Collapsed trace not shareable');
  checks.push('Keyboard collapse of a selected record or its parent trace rejects the hidden text rather than sharing an obsolete selection');

  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await page.locator('#room-messages').evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  await page.locator(`[data-room-session="${b}"]`).click();
  await page.locator(`[data-terminal-id="${b}"] .xterm-screen`).waitFor(); assert.equal(await share.isDisabled(), true);
  checks.push('Room-to-member navigation does not treat the shared timeline selection as that member terminal selection');
  assert.equal((await fixture()).stats.sends, 0); assert.equal((await fixture()).stats.inputs, 0); assert.deepEqual(errors, []);
  const windows = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() })));
  assert.deepEqual(windows, [{visible:false,focusable:false}]);
  console.log(JSON.stringify({ checks, stats:(await fixture()).stats, errors, windows, modelTasks:0, nativeProcesses:0 }, null, 2));
}
run().catch(async error => { console.error(error.stack); process.exitCode = 1; await capture('failed').catch(() => {}); }).finally(async () => {
  if (application) await application.close();
  if (client) { await fixture('stop'); await client.call('shutdown'); client.close(); }
  if (child.connected) child.disconnect(); await until(() => child.exitCode !== null, 'Owned fixture exits');
});
