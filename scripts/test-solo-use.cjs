// A hidden Electron renderer and real persistence chain, with synthetic native transport.
// Composition uses Chromium's input path, not a physical macOS input method.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { fork } = require('node:child_process');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-solo-use-profile-'));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let app, page, client, sequence = 0; const errors = [], passed = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method = 'stats', target, value) { const id = ++sequence; return new Promise((resolve, reject) => {
  const cb = m => { if (m.requestId === id) { clearTimeout(timer); child.off('message', cb); resolve(m); } };
  const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 5000);
  child.on('message', cb); child.send({ id, method, target, value });
}); }
const snapshot = () => page.evaluate(() => workspace.initial());
const input = id => page.locator(`[data-terminal-id="${id}"] .xterm-helper-textarea`);
const focused = id => input(id).evaluate(el => document.activeElement === el);
async function capture(name) { if (process.env.NAW_EVIDENCE_DIR) { if (name !== 'failed') await page.locator('#toast').waitFor({ state: 'hidden' }); fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png') }); } }
async function launch() {
  assert.ok(!app);
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor();
}
async function create(provider) {
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#initial-view').selectOption('chat'); await page.locator('#session-name').fill(provider + ' · 单会话验收'); await page.locator('#confirm-create').click();
  await until(async () => (await snapshot()).sessions.some(s => s.provider === provider && s.state === 'idle'), 'Created');
  return (await snapshot()).sessions.find(s => s.provider === provider).id;
}
async function choose(id) { await page.locator(`[data-session-id="${id}"]`).click(); }
async function chat(id) { await choose(id); await page.locator('#chat-tab').click(); await until(async () => (await snapshot()).viewState.mode === 'chat', 'Chat mode acknowledged'); }
async function releaseTerminal(id) {
  await until(async () => (await fixture()).pending.includes(id), 'Native snapshot requested'); await fixture('release', id);
  await until(() => focused(id), 'Terminal ready and focused');
}
async function checkSaved(id, text, shared, recipient) {
  const s = await snapshot(), v = s.viewState;
  assert.equal(s.sessions.find(x => x.id === id).liveDraft, text, 'Service draft');
  assert.deepEqual(v.draft, { id, text }, 'Main recovery draft');
  assert.equal(v.sharedDraft, shared); assert.equal(v.roomRecipient, recipient);
  const disk = JSON.parse(fs.readFileSync(path.join(profile, 'views.json'))).find(x => x.owner === s.owner);
  for (const key of ['draft', 'sharedDraft', 'roomRecipient', 'selected', 'mode']) assert.deepEqual(disk[key], v[key], 'Disk ' + key);
  assert.equal(await page.locator('#shared-input').inputValue(), shared, 'DOM shared draft');
}
async function run() {
  console.log('Synthetic profile:', profile, 'Code root:', code);
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Service'); client = await connect(profile, 'solo-observer'); await launch();
  const a = await create('claude'), b = await create('codex');
  if (process.env.NAW_SOLO_CASE !== 'fallback') {
    await chat(a); await fixture('hold-claim', a); await page.locator('#terminal-tab').click();
    await until(async () => (await fixture()).claims.includes(a), 'A control held');
    await chat(b); await page.locator('#message-input').fill('B-STAYS-PRIVATE');
    await fixture('release-claim', a); await delay(200);
    assert.equal((await snapshot()).viewState.selected, b); assert.equal((await snapshot()).viewState.mode, 'chat', 'Old A must not switch B');
    assert.equal(await page.locator('#message-input').inputValue(), 'B-STAYS-PRIVATE');
    assert.equal(await page.locator('#message-input').evaluate(el => document.activeElement === el), true);
    await chat(a); await fixture('hold-claim', a); await page.locator('#terminal-tab').click();
    await until(async () => (await fixture()).claims.includes(a), 'Same-session control held'); await page.locator('#chat-tab').click();
    await fixture('release-claim', a);
    await until(async () => (await snapshot()).sessions.find(s => s.id === a).view === 'chat', 'Latest chat intent owns native view');
    assert.equal((await snapshot()).viewState.mode, 'chat');
    await fixture('hold-claim', a); await page.locator('#terminal-tab').click();
    await until(async () => (await fixture()).claims.includes(a), 'Claim held before another owner');
    await page.locator('#chat-tab').click(); await fixture('release-taken', a); await delay(250);
    assert.equal((await snapshot()).sessions.find(s => s.id === a).owner, 'other-test-view', 'Queued old intent cannot take control back from a later owner');
    await page.locator('#send-button').getByText('接管此窗口', { exact: true }).waitFor();
    await page.locator('#terminal-tab').click();
    await until(async () => (await snapshot()).viewState.mode === 'terminal', 'Read-only terminal navigation');
    assert.equal((await snapshot()).sessions.find(s => s.id === a).owner, 'other-test-view', 'Viewing terminal does not take control');
    await page.locator('#chat-tab').click();
    await page.locator('#send-button').getByText('接管此窗口', { exact: true }).click();
    await until(async () => (await snapshot()).sessions.find(s => s.id === a).owner === (await snapshot()).owner, 'Fresh explicit takeover');
    if (process.env.NAW_SOLO_CASE === 'takeover') return;
    await fixture('hold-claim', a); await page.locator('#terminal-tab').click();
    await until(async () => (await fixture()).claims.includes(a), 'Claim held before failure'); await fixture('fail-claim', a);
    await page.locator('#toast').getByText('Synthetic control failure', { exact: false }).waitFor();
    await page.locator('#chat-tab').click(); await until(async () => (await snapshot()).viewState.mode === 'chat', 'Queue recovers after rejection');
    await fixture('hold-claim', a); await page.locator('#chat-tab').click();
    await until(async () => (await fixture()).claims.includes(a), 'Late chat claim');
    await page.locator(`[data-session-menu="${a}"]`).click();
    await until(() => page.evaluate(() => document.activeElement?.getAttribute('role') === 'menuitem'), 'Menu focus');
    await fixture('release-claim', a); await delay(150);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role') === 'menuitem'), true);
    await page.keyboard.press('Escape');
    await fixture('hold-claim', a); await page.locator('#chat-tab').click();
    await until(async () => (await fixture()).claims.includes(a), 'Claim before dialog'); await page.locator('#setup-button').click();
    await fixture('release-claim', a); await delay(150);
    assert.equal(await page.locator('#setup-dialog').evaluate(el => el.open && el.contains(document.activeElement)), true);
    await page.locator('#close-setup').click();
    passed.push('Late view acknowledgements cannot override another session draft or a newer view choice');
    passed.push('Queued view intent cannot reclaim an observed newer owner; read-only tabs allow viewing, explicit takeover remains available');
    passed.push('Rejected view change can be retried; late chat acknowledgements respect menu and dialog focus');
  }
  if (process.env.NAW_SOLO_CASE === 'focus') return;
  await chat(a); await page.locator('#message-input').fill('PRIVATE-UNSENT-中文'); await fixture('unavailable', a);
  await until(async () => (await snapshot()).sessions.find(s => s.id === a).chatAvailable === false, 'Unavailable capability');
  await page.locator('#send-button').getByText('打开原生终端', { exact: true }).waitFor();
  assert.equal(await page.locator('#message-input').evaluate(el => el.readOnly), true);
  assert.equal(await page.locator('#message-input').inputValue(), 'PRIVATE-UNSENT-中文');
  await capture('unavailable-solo'); await page.locator('#send-button').click(); await releaseTerminal(a);
  assert.deepEqual((await fixture()).inputs, []); assert.deepEqual((await fixture()).sends, []);
  await page.keyboard.type('NATIVE-DRAFT'); await until(async () => (await fixture()).inputs.map(x => x.data).join('') === 'NATIVE-DRAFT', 'Native text');
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Control+c');
  await until(async () => (await fixture()).inputs.map(x => x.data).join('') === 'NATIVE-DRAFT\x1b[D\x03', 'Native editing and interrupt keys pass through');
  await chat(a); assert.equal(await page.locator('#message-input').inputValue(), 'PRIVATE-UNSENT-中文');
  await page.getByRole('button', { name: '加入协作', exact: true }).click(); await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  // Draft first, then select an unavailable recipient. Never inject it into TUI.
  await page.locator('#shared-input').fill('ROOM-UNSENT'); await page.locator('#recipient').selectOption(a);
  await page.locator('#forward-button').getByText('打开原生终端', { exact: true }).waitFor();
  assert.equal(await page.locator('#shared-input').evaluate(el => el.readOnly), true);
  await capture('unavailable-room'); await page.locator('#forward-button').click(); await until(() => focused(a), 'Same member terminal');
  assert.equal((await fixture()).inputs.map(x => x.data).join(''), 'NATIVE-DRAFT\x1b[D\x03'); assert.equal((await fixture()).sends.length, 0);
  passed.push('Unavailable solo/room routes expose the same native terminal, preserve both drafts and never paste or dispatch');
  await fixture('available', a); await chat(a); await page.locator('#message-input').fill('');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '中文组合', selectionStart: 4, selectionEnd: 4 });
  await page.locator('#message-input').dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true });
  assert.equal((await fixture()).sends.length, 0, 'Composition confirmation never sends');
  await cdp.send('Input.insertText', { text: '中文组合' });
  await page.keyboard.press('Shift+Enter'); await page.keyboard.type('second line');
  assert.equal(await page.locator('#message-input').inputValue(), '中文组合\nsecond line');
  await page.keyboard.press('Enter'); await until(async () => (await fixture()).sends.length === 1, 'Explicit subsequent Enter sends');
  assert.deepEqual((await fixture()).sends[0], { id: a, text: '中文组合\nsecond line' });
  await page.locator('#interrupt').click(); await until(async () => (await fixture()).interruptions.length === 1, 'Explicit interrupt');
  await page.keyboard.type('MOUSE-SEND');
  assert.equal(await page.locator('#message-input').inputValue(), 'MOUSE-SEND', 'Typing after clicking stop returns to the composer');
  await page.locator('#send-button').click(); await page.keyboard.type('REOPEN-PRIVATE-');
  await until(async () => (await fixture()).sends.length === 2, 'Mouse send');
  assert.deepEqual((await fixture()).sends[1], { id: a, text: 'MOUSE-SEND' });
  assert.equal(await page.locator('#message-input').inputValue(), 'REOPEN-PRIVATE-', 'Typing after clicking send edits the next draft');
  await page.locator('#interrupt').click(); await page.keyboard.insertText('中文');
  await until(async () => (await fixture()).interruptions.length === 2, 'Second explicit interrupt');
  assert.equal(await page.locator('#message-input').inputValue(), 'REOPEN-PRIVATE-中文', 'Stopping retains the next draft and accepts immediate input');
  await page.locator('#terminal-tab').click(); await until(() => focused(a), 'Terminal composition');
  const initialInputs = (await fixture()).inputs.length;
  await cdp.send('Input.imeSetComposition', { text: '终端中文', selectionStart: 4, selectionEnd: 4 });
  await fixture('state', a); await delay(150);
  assert.equal((await fixture()).inputs.length, initialInputs, 'No preedit bytes'); assert.equal(await focused(a), true);
  await cdp.send('Input.insertText', { text: '终端中文' });
  await until(async () => (await fixture()).inputs.slice(initialInputs).map(x => x.data).join('') === '终端中文', 'Composition commits exactly once');
  await cdp.detach(); passed.push('Chromium composition retains focus and commits once; GUI confirmation is guarded, explicit send/interrupt works (not physical IME)');
  await fixture('set-state', a, 'error'); await chat(a);
  await page.locator('#send-button').getByText('打开原生终端', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '继续原生会话', exact: true }).count(), 0, 'A still-connected error is not a new resume');
  await fixture('set-state', a, 'idle');
  await fixture('set-owner', a, 'other-test-view');
  await page.locator('#send-button').getByText('接管此窗口', { exact: true }).waitFor();
  assert.equal(await page.locator('#message-input').evaluate(el => el.readOnly), true);
  await page.locator('#send-button').click(); await until(async () => (await snapshot()).sessions.find(s => s.id === a).owner === (await snapshot()).owner, 'Explicit takeover');
  assert.equal(await page.locator('#message-input').inputValue(), 'REOPEN-PRIVATE-中文');
  passed.push('Connected errors use the existing terminal; another owner remains read-only until explicit takeover');
  await page.locator('#room-nav').click(); await page.locator('#room-record').click(); await page.locator('#recipient').selectOption(a); await page.locator('#shared-input').fill('REOPEN-ROOM-中文');
  await chat(a); await until(async () => (await snapshot()).viewState.draft?.text === 'REOPEN-PRIVATE-中文', 'Saved GUI draft');
  await checkSaved(a, 'REOPEN-PRIVATE-中文', 'REOPEN-ROOM-中文', a);
  await delay(12000); await checkSaved(a, 'REOPEN-PRIVATE-中文', 'REOPEN-ROOM-中文', a);
  const before = await snapshot(); await app.close(); app = null; await launch();
  await until(async () => (await snapshot()).viewState.selected === a, 'Reopened original selection');
  await checkSaved(a, 'REOPEN-PRIVATE-中文', 'REOPEN-ROOM-中文', a); assert.equal(await page.locator('#message-input').inputValue(), 'REOPEN-PRIVATE-中文');
  await delay(12000); await checkSaved(a, 'REOPEN-PRIVATE-中文', 'REOPEN-ROOM-中文', a);
  await capture('idle-reopened');
  const after = await snapshot(); assert.deepEqual(after.sessions.map(s => [s.id, s.nativeId, s.messages, s.liveDraft]), before.sessions.map(s => [s.id, s.nativeId, s.messages, s.liveDraft]));
  // Membership changes clear an invalid recipient, never the draft body.
  await page.getByRole('button', { name: '脱出协作', exact: true }).click(); await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await until(async () => (await snapshot()).viewState.roomRecipient === '', 'Invalid recipient cleared');
  await checkSaved(a, 'REOPEN-PRIVATE-中文', 'REOPEN-ROOM-中文', '');
  await app.close(); app = null; await launch(); await delay(12000);
  await checkSaved(a, 'REOPEN-PRIVATE-中文', 'REOPEN-ROOM-中文', '');
  await chat(a); await fixture('set-state', a, 'ended');
  await page.locator('#send-button').getByText('继续原生会话', { exact: true }).waitFor();
  assert.equal(await page.locator('#message-input').evaluate(el => el.readOnly), true);
  assert.equal(await page.locator('#message-input').inputValue(), 'REOPEN-PRIVATE-中文');
  assert.equal((await fixture()).sends.length, 2); assert.equal(app.windows().length, 1); assert.deepEqual(errors, []); await capture('ended-preserved');
  passed.push('DOM/main/disk/service drafts agree after ready, 12-second idle, UI reopen and another 12-second idle; no replay');
  passed.push('An empty room and invalid saved recipient retain the shared draft after reopen/idle; ended native sessions expose explicit recovery');
  console.log(JSON.stringify({ passed, errors, nativeProviderProcesses: 0, modelTasks: 0, syntheticSends: 2, physicalIME: false, oneWindow: true }, null, 2));
}
run().catch(async error => { console.error(error.stack); if (page && !page.isClosed()) await capture('failed'); process.exitCode = 1; }).finally(async () => {
  if (app) await app.close();
  if (client) { const s = await client.call('initial'); for (const x of s.sessions) await client.call('stop', x.id); await client.call('shutdown'); client.close(); }
  if (child.connected) child.disconnect();
});
