const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// Real isolated Electron controls/IPC with deliberately delayed native acceptance.
// Synthetic transports only; no native agent or model request.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { fork } = testScratch.childProcess, { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-share-preview-ui-'));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/delayed-native.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: profile },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
let app, page, client, sequence = 0;
const checks = [], errors = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const snapshot = () => page.evaluate(() => workspace.initial());
async function until(fn, label) { for (let i = 0; i < 160; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function native(method = 'stats', reply = '', fail = false) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const cb = value => { if (value.requestId === id) { clearTimeout(timer); child.off('message', cb); resolve(value); } };
    const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 8000);
    child.on('message', cb); child.send({ id, method, reply, fail });
  });
}
async function sent(count, id, text) {
  await until(async () => (await native()).sends.length === count, 'One exact dispatch');
  assert.deepEqual((await native()).sends.at(-1), { id, text });
}
async function release(reply, fail = false) {
  await native('release', reply, fail);
  await until(async () => (await snapshot()).sessions.every(s => !s.pendingTag), 'Native result settled');
  await until(() => page.locator('#confirm-share').innerText().then(t => t === '发送这段内容'), 'Preview send settled');
}
async function create(provider) {
  await page.locator('#new-session').click();
  await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#session-name').fill(provider + ' · 分享测试');
  await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => s.provider === provider), 'Session created');
  const id = (await snapshot()).sessions.find(s => s.provider === provider).id;
  await page.getByRole('button', { name: '加入协作', exact: true }).click();
  return id;
}
async function shot(name) {
  if (!process.env.NAW_EVIDENCE_DIR) return;
  fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true, mode: 0o700 });
  await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png') });
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Fixture ready');
  client = await connect(profile, 'preview-observer');
  app = await _electron.launch({
    executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000,
  });
  page = await app.firstWindow(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('#new-session').waitFor();
  const a = await create('claude'), b = await create('codex');
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  const seed = client.call('forward', a, 'SYNTHETIC SOURCE');
  await sent(1, a, 'SYNTHETIC SOURCE'); await native('release', 'SOURCE RESULT'); await seed;
  const sourceRow = page.locator('#room-messages article').filter({ has: page.getByText('SOURCE RESULT', { exact: true }) });
  const source = sourceRow.getByRole('button', { name: '选择并分享', exact: true });
  const edit = page.locator('#share-text'), confirm = page.locator('#confirm-share'), dialog = page.locator('#share-dialog');
  // Message actions appear while the pointer is over the message, as for a person.
  async function open(id, text) { await sourceRow.hover(); await source.click(); await page.locator('#share-recipient').selectOption(id); await edit.fill(text); }

  await open(b, '   ');
  assert.equal(await confirm.isDisabled(), true);
  await edit.fill('SAME PREVIEW'); await confirm.click(); await sent(2, b, 'SAME PREVIEW');
  assert.equal(await confirm.isDisabled(), true);
  assert.match(await page.locator('#share-help').innerText(), /新的修改不会随这次发送/);
  await confirm.evaluate(button => { button.onclick(); button.onclick(); });
  assert.equal((await native()).sends.length, 2);
  await edit.fill('INTERVENING EDIT'); await edit.fill('SAME PREVIEW');
  await release('FIRST ACCEPTANCE');
  assert.equal(await dialog.evaluate(d => d.open), true);
  assert.equal(await edit.inputValue(), 'SAME PREVIEW');
  assert.equal(await confirm.isEnabled(), true);
  await shot('same-text-new-edit-retained');
  checks.push('Blank preview and repeated pending clicks do not dispatch; acceptance keeps a new same-text edit rather than closing it');
  await page.locator('#cancel-share').click();

  await open(a, 'OLD PREVIEW'); await confirm.click(); await sent(3, a, 'OLD PREVIEW');
  await page.locator('#cancel-share').click();
  await open(b, 'NEW PREVIEW MUST STAY');
  assert.equal(await confirm.isDisabled(), true);
  await release('OLD ACCEPTANCE');
  assert.equal(await dialog.evaluate(d => d.open), true);
  assert.equal(await edit.inputValue(), 'NEW PREVIEW MUST STAY');
  assert.equal(await page.locator('#share-recipient').inputValue(), b);
  assert.equal((await native()).sends.length, 3);
  await shot('new-preview-retained');
  checks.push('Cancel/reopen during an in-flight send keeps the new text and recipient when the old acceptance returns; no implicit second send');
  await page.locator('#cancel-share').click();

  await open(b, 'FAILURE PREVIEW'); await confirm.click(); await sent(4, b, 'FAILURE PREVIEW');
  await edit.fill('EDIT AFTER FAILED SUBMISSION'); await release('', true);
  await page.locator('#toast').filter({ hasText: 'Synthetic acceptance failure' }).waitFor();
  assert.equal(await dialog.evaluate(d => d.open), true);
  assert.equal(await edit.inputValue(), 'EDIT AFTER FAILED SUBMISSION');
  assert.equal((await native()).sends.length, 4);
  await shot('failed-send-keeps-edit');
  checks.push('A rejected send retains the current preview and exposes the failure without automatic replay');

  await confirm.focus(); await page.keyboard.press('Enter');
  await sent(5, b, 'EDIT AFTER FAILED SUBMISSION'); await release('EXPLICIT RETRY');
  await until(() => dialog.evaluate(d => !d.open), 'Unchanged acknowledged preview closes');
  assert.equal((await native()).sends.length, 5);
  checks.push('Explicit keyboard retry sends the edited text once and closes only that unchanged acknowledged preview');

  await open(a, 'CANCELLED PREVIEW'); await confirm.click(); await sent(6, a, 'CANCELLED PREVIEW');
  await page.keyboard.press('Escape');
  await release('ACCEPTED AFTER CLOSE');
  assert.equal(await dialog.evaluate(d => d.open), false);
  checks.push('Escape closes the preview without pretending to cancel accepted native work; late acceptance never reopens it');

  await open(a, 'OLD FAILURE'); await confirm.click(); await sent(7, a, 'OLD FAILURE');
  await page.locator('#cancel-share').click(); await open(b, 'NEW PREVIEW AFTER FAILURE');
  await release('', true);
  assert.equal(await dialog.evaluate(d => d.open), true);
  assert.equal(await edit.inputValue(), 'NEW PREVIEW AFTER FAILURE');
  assert.equal(await page.locator('#share-recipient').inputValue(), b);
  assert.equal(await confirm.isEnabled(), true);
  assert.equal((await native()).sends.length, 7);
  checks.push('An old rejection leaves a reopened preview, its edited text and its new recipient intact without replay');
  await page.locator('#cancel-share').click();

  await open(b, 'RECIPIENT LEAVES'); await confirm.click(); await sent(8, b, 'RECIPIENT LEAVES');
  await client.call('join', b, false);
  await until(async () => await page.locator('#share-recipient').inputValue() === '', 'Departed recipient cleared');
  assert.equal(await confirm.isDisabled(), true);
  await release('INVALIDATED ACCEPTANCE');
  assert.equal(await dialog.evaluate(d => d.open), true);
  assert.equal(await edit.inputValue(), 'RECIPIENT LEAVES');
  assert.equal(await page.locator('#share-recipient').inputValue(), '');
  assert.equal(await confirm.isDisabled(), true);
  await client.call('join', b, true);
  await until(async () => (await snapshot()).sessions.find(s => s.id === b).roomId === 'shared', 'Recipient rejoined');
  assert.equal(await page.locator('#share-recipient').inputValue(), '');
  assert.equal(await confirm.isDisabled(), true);
  await page.locator('#share-recipient').selectOption(b);
  assert.equal(await confirm.isEnabled(), true);
  assert.equal((await native()).sends.length, 8);
  await shot('departed-recipient-requires-selection');
  checks.push('Recipient departure invalidates the pending send and clears selection; rejoining never silently restores or changes it, and explicit selection still does not send');

  const state = await snapshot();
  assert.equal(state.room.messages.filter(m => m.role === 'human').length, 8);
  assert.equal(state.diagnostics.dispatches, 8);
  assert.equal(state.diagnostics.shellModelCalls, 0);
  assert.deepEqual(errors, []);
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() })));
  assert.deepEqual(windows, [{ visible: false, focusable: false }]);
  console.log(JSON.stringify({ checks, syntheticDispatches: 8, windows, errors, modelTasks: 0 }, null, 2));
}
run().catch(async error => { console.error(error.stack); if (page && !page.isClosed()) await shot('failed'); process.exitCode = 1; }).finally(testScratch.cleanup(async () => {
  if (app) await app.close();
  if (client) { for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); }
  if (child.connected) child.disconnect();
  await until(() => child.exitCode !== null, 'Owned fixture exits');
}));
