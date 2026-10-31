// Existing seven-group delayed-acceptance preview journey, isolated source GUI and synthetic providers only.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const plan = { task: 'T33 current delayed share-preview source GUI', fullGuiStarts: 1, ownedSyntheticDaemons: 1, syntheticSessions: 2, syntheticSends: 8, terminalInputs: 0, productModels: 0, realProviders: 0, osClipboard: 0, maxRunMs: 300000 };
if (process.argv.includes('--plan')) { console.log(JSON.stringify(plan, null, 2)); process.exit(0); }
assert.equal(process.env.NAW_T33_SHARE_PREVIEW_GUI_AUTHORIZED, '1', 'Record the finite source GUI plan before running');
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
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-share-preview-ui-'));
const entry = path.join(profile, 'entry'); fs.mkdirSync(entry);
fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ name: 'naw-owned-share-preview-gui', version: require('../package.json').version, main: 'main.cjs' }));
fs.writeFileSync(path.join(entry, 'main.cjs'), `const cp=require('node:child_process'),path=require('node:path'),e=require('electron');
globalThis.previewGuards={clipboard:0,external:0,dialogs:0,maintenance:0,replacement:0};
const spawn=cp.spawn;cp.spawn=function(bin,args,...rest){if(Array.isArray(args)&&args.some(arg=>typeof arg==='string'&&path.basename(arg)==='daemon.cjs')){globalThis.previewGuards.replacement++;throw Error('Replacement backend prohibited');}return spawn.call(this,bin,args,...rest);};
for(const name of ['readText','writeText','readImage','writeImage','read','write','readBuffer','writeBuffer','clear'])e.clipboard[name]=()=>{globalThis.previewGuards.clipboard++;throw Error('OS clipboard prohibited');};
e.shell.openPath=e.shell.openExternal=async()=>{globalThis.previewGuards.external++;throw Error('External action prohibited');};
e.dialog.showOpenDialog=e.dialog.showMessageBox=async()=>{globalThis.previewGuards.dialogs++;throw Error('OS dialog prohibited');};
const {WorkspaceClient}=require(${JSON.stringify(path.join(root, 'app/workspace-client.cjs'))});WorkspaceClient.prototype.maintainService=function(){globalThis.previewGuards.maintenance++;throw Error('Backend update prohibited');};
require(${JSON.stringify(path.join(root, 'app/main.cjs'))});`);
const executablePath = require('electron'), args = [entry];
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/delayed-native.cjs')],
  env: env({ NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: profile }),
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
let app, page, client, sequence = 0, failure;
const guiPids = [], guardSamples = [], started = Date.now();
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
  await until(async () => await page.locator('#share-dialog').evaluate(d => !d.open) || await page.locator('#confirm-share').innerText() === '发送这段内容', 'Preview send settled or acknowledged dialog closed');
}
async function create(provider) {
  await page.locator('#new-session').click();
  await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#session-name').fill(provider + ' · 分享测试');
  await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => s.provider === provider), 'Session created');
  const id = (await snapshot()).sessions.find(s => s.provider === provider).id;
  const room = (await snapshot()).rooms.find(room => room.id === 'shared');
  await page.locator(`[data-session-menu="${id}"]`).click();
  await page.getByRole('menuitem', { name: `加入「${room.name}」`, exact: true }).click();
  await until(async () => (await snapshot()).sessions.find(s => s.id === id).roomIds?.includes('shared'), 'Visible membership acknowledged');
  return id;
}
async function shot(name) {
  if (!page || page.isClosed()) return;
  fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
  await page.screenshot({ path: path.join(evidence, name + '.png') });
  fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(await snapshot(), null, 2));
  const ui = await page.evaluate(() => ({ open: document.querySelector('#share-dialog').open, text: document.querySelector('#share-text').value, recipient: document.querySelector('#share-recipient').value, disabled: document.querySelector('#confirm-share').disabled, confirm: document.querySelector('#confirm-share').textContent, help: document.querySelector('#share-help').textContent }));
  fs.writeFileSync(path.join(evidence, name + '.ui.json'), JSON.stringify(ui, null, 2));
}
async function guards() { const values = await app.evaluate(() => globalThis.previewGuards); assert.deepEqual(values, { clipboard: 0, external: 0, dialogs: 0, maintenance: 0, replacement: 0 }); guardSamples.push(values); }
async function check(text) { assert.ok(Date.now() - started < plan.maxRunMs, 'Five-minute stage-entry budget'); checks.push(text); console.log('PASS:', text); await shot('stage-' + String(checks.length).padStart(2, '0')); }
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Fixture ready');
  client = await connect(profile, 'preview-observer');
  const backend = await client.call('initial'); assert.equal(backend.servicePid, child.pid); assert.equal(backend.runtimeVersion, require('../package.json').version); assert.equal(backend.sessions.length, 0);
  app = await _electron.launch({ executablePath, args, env: env({ NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }), timeout: 70000 }); guiPids.push(app.process().pid);
  page = await app.firstWindow(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('#new-session').waitFor();
  const a = await create('claude'), b = await create('codex');
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  const seed = client.call('forward', a, 'SYNTHETIC SOURCE');
  await sent(1, a, 'SYNTHETIC SOURCE'); await native('release', 'SOURCE RESULT'); await seed;
  const sourceRecord = (await snapshot()).room.messages.find(m => m.sessionId === a && m.role === 'assistant' && m.text === 'SOURCE RESULT'); assert.ok(sourceRecord);
  const sourceRow = page.locator(`#room-messages article[data-message-id="${sourceRecord.id}"]`);
  await sourceRow.getByText('SOURCE RESULT', { exact: true }).waitFor();
  const source = sourceRow.getByRole('button', { name: '选择并分享：claude · 分享测试的回复', exact: true });
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
  await check('Blank preview and repeated pending clicks do not dispatch; acceptance keeps a new same-text edit rather than closing it');
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
  await check('Cancel/reopen during an in-flight send keeps the new text and recipient when the old acceptance returns; no implicit second send');
  await page.locator('#cancel-share').click();

  await open(b, 'FAILURE PREVIEW'); await confirm.click(); await sent(4, b, 'FAILURE PREVIEW');
  await edit.fill('EDIT AFTER FAILED SUBMISSION'); await release('', true);
  await page.locator('#toast').filter({ hasText: 'Synthetic acceptance failure' }).waitFor();
  assert.equal(await dialog.evaluate(d => d.open), true);
  assert.equal(await edit.inputValue(), 'EDIT AFTER FAILED SUBMISSION');
  assert.equal((await native()).sends.length, 4);
  await shot('failed-send-keeps-edit');
  await check('A rejected send retains the current preview and exposes the failure without automatic replay');

  await confirm.focus(); await page.keyboard.press('Enter');
  await sent(5, b, 'EDIT AFTER FAILED SUBMISSION'); await release('EXPLICIT RETRY');
  await until(() => dialog.evaluate(d => !d.open), 'Unchanged acknowledged preview closes');
  assert.equal((await native()).sends.length, 5);
  await check('Explicit keyboard retry sends the edited text once and closes only that unchanged acknowledged preview');

  await open(a, 'CANCELLED PREVIEW'); await confirm.click(); await sent(6, a, 'CANCELLED PREVIEW');
  await page.keyboard.press('Escape');
  await release('ACCEPTED AFTER CLOSE');
  assert.equal(await dialog.evaluate(d => d.open), false);
  await check('Escape closes the preview without pretending to cancel accepted native work; late acceptance never reopens it');

  await open(a, 'OLD FAILURE'); await confirm.click(); await sent(7, a, 'OLD FAILURE');
  await page.locator('#cancel-share').click(); await open(b, 'NEW PREVIEW AFTER FAILURE');
  await release('', true);
  assert.equal(await dialog.evaluate(d => d.open), true);
  assert.equal(await edit.inputValue(), 'NEW PREVIEW AFTER FAILURE');
  assert.equal(await page.locator('#share-recipient').inputValue(), b);
  assert.equal(await confirm.isEnabled(), true);
  assert.equal((await native()).sends.length, 7);
  await check('An old rejection leaves a reopened preview, its edited text and its new recipient intact without replay');
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
  await check('Recipient departure invalidates the pending send and clears selection; rejoining never silently restores or changes it, and explicit selection still does not send');

  const state = await snapshot();
  assert.equal(state.room.messages.filter(m => m.role === 'human').length, 8);
  assert.equal(state.diagnostics.dispatches, 8);
  assert.equal(state.diagnostics.shellModelCalls, 0);
  assert.deepEqual(errors, []); await guards();
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() })));
  assert.deepEqual(windows, [{ visible: false, focusable: false }]);
  console.log(JSON.stringify({ checks, syntheticDispatches: 8, windows, errors, modelTasks: 0 }, null, 2));
}
const cleanup = testScratch.cleanup(async () => {
  if (app) await app.close();
  if (client) { for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); } else if (child.exitCode === null) child.kill('SIGTERM');
  if (child.connected) child.disconnect();
  await until(() => child.exitCode !== null, 'Owned fixture exits');
});
run().catch(async error => { failure = error.stack; console.error(failure); process.exitCode = 1; await shot('failed').catch(() => {}); }).finally(async () => {
  try {
    fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ checks, failure, errors, profile, ownedNodePid: child.pid, ownedGuiPids: guiPids, guards: guardSamples, currentGuards: app ? await app.evaluate(() => globalThis.previewGuards).catch(() => null) : null, fixture: child.connected ? await native().catch(() => null) : null }, null, 2));
  } finally {
    await cleanup(); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
    fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ token, releasedAt: new Date().toISOString(), ownedProfileGone: !fs.existsSync(profile) }));
  }
});
