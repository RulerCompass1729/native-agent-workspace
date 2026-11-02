// Actual Electron/DSH rename workflow, existing synthetic native transport.
// Clipboard and label-save faults are intercepted only in this owned process.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process'), { randomUUID, createHash } = require('node:crypto');
const scratch = require('./fixtures/test-scratch.cjs'), { createIn } = require('./fixtures/create-view.cjs');
const { _electron } = scratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const evidence = process.env.NAW_EVIDENCE_DIR;
if (evidence) {
  let parent = path.resolve(evidence); while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const target = path.join(fs.realpathSync(parent), path.relative(parent, path.resolve(evidence)));
  for (const repo of [root, code].map(p => fs.realpathSync(p))) assert.ok(target !== repo && !target.startsWith(repo + path.sep), 'Evidence outside source repositories');
  fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
}
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; no fixture or application started.'); process.exit(75); }
const owner = { owner: 'Codex2', task: 'T55 inline rename', token, pid: process.pid, createdAt: new Date().toISOString(), budget: { productModels: 0, providers: 0 } };
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify(owner));
if (evidence) fs.writeFileSync(path.join(evidence, 'owner.json'), JSON.stringify(owner, null, 2));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-inline-rename-'));
const child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')], env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: profile, NAW_APP_VERSION: require(path.join(code, 'package.json')).version }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let app, page, peer, client, request = 0;
const checks = [], errors = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 160; i++) { if (await fn()) return; await delay(40); } throw Error(label); }
function fixture(method = 'stats', target, value) { const id = ++request; return new Promise((resolve, reject) => {
  const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 8000);
  const cb = result => { if (result.requestId === id) { clearTimeout(timer); child.off('message', cb); resolve(result); } }; child.on('message', cb); child.send({ id, method, target, value });
}); }
const state = () => page.evaluate(() => workspace.initial());
const item = name => page.getByRole('menuitem', { name, exact: true });
const check = text => { checks.push(text); console.log('PASS:', text); };
async function shot(name) { if (evidence) await page.screenshot({ path: path.join(evidence, name + '.png') }); }
async function rename(id) {
  await page.locator(id === 'room' ? '#room-more' : `[data-session-row="${id}"] .session-more`).click(); await item('重命名…').click(); await page.locator('#rename-name').waitFor();
}
async function create(name) { await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check(); await page.locator('#session-name').fill(name); await createIn(page, 'chat'); return (await state()).sessions.find(s => s.name === name).id; }
const identity = s => [s.id, s.nativeId, s.owner];
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Own fixture ready'); client = await connect(profile, 'inline-rename-observer');
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(8000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  await app.evaluate(({ clipboard, nativeImage }, code) => {
    const load = process.getBuiltinModule('module').createRequire(code + '/package.json');
    const { SessionLabels } = load(code + '/app/session-labels.cjs'), { RoomState } = load(code + '/app/room-state.cjs');
    globalThis.inlineTest = { calls: [], fail: false, copies: [], reads: 0, text: 'Clipboard name 你好', hold: false };
    globalThis.inlineOriginal = { labels: SessionLabels.prototype.set, room: RoomState.prototype.rename, writeText: clipboard.writeText, readText: clipboard.readText, readImage: clipboard.readImage };
    SessionLabels.prototype.set = function (id, name) { globalThis.inlineTest.calls.push({ kind: 'session', id, name }); if (globalThis.inlineTest.fail) throw Error('Synthetic name save refused'); return globalThis.inlineOriginal.labels.call(this, id, name); };
    RoomState.prototype.rename = function (name) { globalThis.inlineTest.calls.push({ kind: 'room', name }); if (globalThis.inlineTest.fail) throw Error('Synthetic name save refused'); return globalThis.inlineOriginal.room.call(this, name); };
    clipboard.writeText = text => globalThis.inlineTest.copies.push(text);
    clipboard.readText = () => { globalThis.inlineTest.reads++; return globalThis.inlineTest.hold ? new Promise(resolve => { globalThis.inlineRelease = () => resolve(globalThis.inlineTest.text); }) : globalThis.inlineTest.text; };
    clipboard.readImage = () => nativeImage.createEmpty();
  }, code);
  const win = await app.browserWindow(page); await win.evaluate(w => w.setSize(1240, 850));
  const id = await create('Inline original'), input = page.locator('#rename-name'), draft = 'Original unsent draft 你好\nDo not submit';
  await page.locator('#message-input').fill(draft); await page.locator('#terminal-tab').click();
  await until(async () => (await fixture()).pending.includes(id), 'Own late snapshot');
  const original = (await state()).sessions.find(s => s.id === id), daemonOriginal = (await client.call('initial')).sessions.find(s => s.id === id);
  await rename(id);
  assert.equal(await page.locator('dialog[open]').count(), 0, 'Rename must not open a full-window modal');
  assert.equal(await input.evaluate((el, id) => el.closest('[data-session-row]')?.dataset.sessionRow === id, id), true, 'Editor belongs to the exact original row');
  assert.equal(await input.inputValue(), 'Inline original'); assert.equal(await input.getAttribute('maxlength'), '60');
  await input.fill('Unsaved local title'); await fixture('release', id); await until(async () => (await page.locator('.xterm-rows').innerText()).includes('Synthetic terminal ready'), 'Late snapshot actually painted');
  await until(() => input.evaluate(n => document.activeElement === n), 'Late native snapshot preserves inline focus'); await shot('session-inline');
  const callsBeforeIME = await app.evaluate(() => globalThis.inlineTest.calls.length);
  const ime = await input.evaluate(n => {
    n.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const enter = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }); n.dispatchEvent(enter);
    n.form.requestSubmit(); n.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }));
    const result = { enterPrevented: enter.defaultPrevented, visible: !document.getElementById('rename-editor').hidden, active: document.activeElement === n }; n.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); return result;
  });
  assert.deepEqual(ime, { enterPrevented: true, visible: true, active: true }); assert.equal(await app.evaluate(() => globalThis.inlineTest.calls.length), callsBeforeIME);
  await input.press('Escape'); assert.equal(await page.locator('#rename-editor').isVisible(), false); assert.equal((await state()).sessions.find(s => s.id === id).name, 'Inline original');
  assert.equal(await page.locator(`[data-session-row="${id}"] .session-more`).evaluate(n => n === document.activeElement), true);
  for (const control of ['#confirm-rename', '#cancel-rename']) {
    await rename(id); await input.fill('Unsubmitted button-focus title'); await page.locator(control).focus(); await page.locator(control).press('Escape'); await page.locator('#rename-editor').waitFor({ state: 'hidden' }); assert.equal((await state()).sessions.find(s => s.id === id).name, 'Inline original');
  }
  await rename(id); await input.fill('Saved title 你好'); await input.press('Enter'); await page.locator('#rename-editor').waitFor({ state: 'hidden' });
  assert.equal((await state()).sessions.find(s => s.id === id).name, 'Saved title 你好'); assert.deepEqual(identity((await state()).sessions.find(s => s.id === id)), identity(original));
  check('Exact row edit, late terminal snapshot, IME/229 Enter and Escape, ordinary cancel and Enter save preserve native identity, owner and draft');

  await rename(id); await input.fill(''); await input.press('Enter'); await until(async () => (await page.locator('#rename-error').innerText()).includes('不能为空'), 'Existing empty-name validation'); assert.equal(await input.inputValue(), '');
  await app.evaluate(() => { globalThis.inlineTest.fail = true; }); await input.fill('Retry local title'); await page.locator('#confirm-rename').click(); await until(async () => (await page.locator('#rename-error').innerText()).includes('Synthetic name save refused'), 'Visible save failure'); assert.equal(await input.inputValue(), 'Retry local title'); assert.equal(await input.isEditable(), true); assert.equal(await input.evaluate(n => n === document.activeElement), true, 'Failed pointer Save restores the editable name focus');
  assert.equal((await state()).sessions.find(s => s.id === id).name, 'Saved title 你好'); await shot('save-failure');
  const beforeOtherFocus = await app.evaluate(() => globalThis.inlineTest.calls.length);
  await input.evaluate(n => { n.form.requestSubmit(); document.getElementById('message-input').focus(); }); await until(async () => await app.evaluate(() => globalThis.inlineTest.calls.length) > beforeOtherFocus && await input.isEditable(), 'Failed save acknowledgement while another field has focus'); assert.equal(await page.locator('#message-input').evaluate(n => n === document.activeElement), true, 'Failure must not steal a newer field focus');
  await app.evaluate(() => { globalThis.inlineTest.fail = false; }); await page.locator('#confirm-rename').click(); await page.locator('#rename-editor').waitFor({ state: 'hidden' }); assert.equal(await page.locator(`[data-session-row="${id}"] .session-more`).evaluate(n => n === document.activeElement), true, 'Successful pointer Save returns to its original row action');
  await rename(id); await input.fill('Save with newer focus'); await input.evaluate(n => { n.form.requestSubmit(); document.getElementById('message-input').focus(); }); await page.locator('#rename-editor').waitFor({ state: 'hidden' }); assert.equal(await page.locator('#message-input').evaluate(n => n === document.activeElement), true, 'Success must not steal a newer field focus');
  await rename(id); await input.fill('Pending save title'); const beforeDouble = await app.evaluate(() => globalThis.inlineTest.calls.length);
  const pending = await input.evaluate(n => { n.form.requestSubmit(); n.form.requestSubmit(); n.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return { visible: !document.getElementById('rename-editor').hidden, readOnly: n.readOnly, cancelDisabled: document.getElementById('cancel-rename').disabled }; });
  assert.deepEqual(pending, { visible: true, readOnly: true, cancelDisabled: true }); await page.locator('#rename-editor').waitFor({ state: 'hidden' }); assert.equal(await app.evaluate(() => globalThis.inlineTest.calls.length), beforeDouble + 1);
  check('Existing validation and synthetic save failure preserve input; retry works and pending duplicate submits/Escape cannot discard an in-flight save');

  const peerReady = app.waitForEvent('window'); await page.evaluate(id => workspace.newWindow(id), id); peer = await peerReady; peer.setDefaultTimeout(8000); peer.on('pageerror', e => errors.push(e.message)); await peer.locator('#new-session').waitFor();
  await rename(id); await input.fill('Local conflicting draft'); await page.evaluate(() => { window.inlineOriginalInput = document.getElementById('rename-name'); });
  await peer.evaluate(id => workspace.rename(id, 'Peer chosen title'), id); await until(async () => (await page.locator('#rename-error').innerText()).includes('另一处更改'), 'Observed peer conflict');
  assert.equal(await input.inputValue(), 'Local conflicting draft'); assert.equal(await page.locator('#confirm-rename').isDisabled(), true); assert.equal(await page.evaluate(() => window.inlineOriginalInput === document.getElementById('rename-name')), true); await shot('peer-conflict');
  await input.evaluate(n => n.select()); await input.press('Shift+F10'); await item('复制').click(); await until(async () => await app.evaluate(() => globalThis.inlineTest.copies.at(-1)) === 'Local conflicting draft', 'Inline context Copy');
  await input.press('Escape'); await rename(id); assert.equal(await input.inputValue(), 'Peer chosen title'); await input.press('Escape');
  check('Independent window rename does not overwrite local editing text; observed conflict disables saving until explicit cancel/reopen, with exact inline Copy');

  const other = await create('Other inline'); await page.locator(`[data-session-id="${id}"]`).click(); await rename(id); const originalText = await input.inputValue();
  await input.evaluate(n => n.select()); await app.evaluate(() => { globalThis.inlineTest.hold = true; globalThis.inlineTest.text = 'Stale clipboard text'; });
  let reads = await app.evaluate(() => globalThis.inlineTest.reads); await input.press('Shift+F10'); await item('粘贴').click(); await until(async () => await app.evaluate(() => globalThis.inlineTest.reads) > reads, 'Explicit held clipboard read');
  await input.fill('Temporary newer name'); await input.fill(originalText); await input.evaluate(n => n.select()); await app.evaluate(() => { globalThis.inlineTest.hold = false; globalThis.inlineRelease(); }); await delay(100); assert.equal(await input.inputValue(), originalText, 'A newer edit returning to the same text still rejects stale Paste');
  await input.evaluate(n => n.select()); await app.evaluate(() => { globalThis.inlineTest.hold = true; }); reads = await app.evaluate(() => globalThis.inlineTest.reads);
  await input.press('Shift+F10'); await item('粘贴').click(); await until(async () => await app.evaluate(() => globalThis.inlineTest.reads) > reads, 'Held clipboard before retarget');
  await input.press('Escape'); await rename(other); await input.fill(originalText); await input.evaluate(n => n.select()); await app.evaluate(() => { globalThis.inlineTest.hold = false; globalThis.inlineRelease(); }); await delay(100); assert.equal(await input.inputValue(), originalText, 'Late Paste cannot reach another row editor with the same text');
  await input.press('Escape'); await rename(id); await app.evaluate(() => { globalThis.inlineTest.text = 'New explicit clipboard title'; }); await input.evaluate(n => n.select()); await input.click({ button: 'right' }); await item('粘贴').click(); await until(async () => await input.inputValue() === 'New explicit clipboard title', 'Inline pointer Paste'); await input.press('Meta+z'); assert.equal(await input.inputValue(), 'Peer chosen title'); await input.press('Escape');
  check('Inline pointer/menu-key editing uses the existing text menu; explicit Paste/Undo work while delayed edit-return and retargeted clipboard replies cannot overwrite names');

  await rename(id); await input.fill('Retained while collapsed'); await page.locator('#solo-drop').click(); await page.locator('#session-list').waitFor({ state: 'hidden' }); assert.equal(await input.inputValue(), 'Retained while collapsed'); await page.locator('#solo-drop').click(); await input.waitFor();
  await peer.evaluate(id => workspace.archiveSession(id), id); await until(async () => (await page.locator('#rename-error').innerText()).includes('已归档'), 'Archived editor is retained'); assert.equal(await input.inputValue(), 'Retained while collapsed'); assert.equal(await input.isVisible(), true); assert.equal(await page.locator('#confirm-rename').isDisabled(), true); await shot('archived-editor');
  await peer.evaluate(id => workspace.restoreSession(id), id); await until(() => page.locator('#confirm-rename').isEnabled(), 'Restored original row can retry'); assert.equal(await input.inputValue(), 'Retained while collapsed'); await input.press('Escape');
  check('Section collapse and external archive preserve the existing editor/value; original-row restoration unlocks retry without silent saving');

  await win.evaluate(w => w.setSize(850, 600)); await until(() => page.locator('.naw[data-native-surface="sidebar"]').evaluate(n => n.dataset.collapsed === 'true'), 'Actual DSH rail');
  await rename(id); await until(() => page.locator('.naw[data-native-surface="sidebar"]').evaluate(n => n.dataset.collapsed === 'false'), 'Existing DSH sidebar revealed for edit');
  const initialNarrowBox = await input.boundingBox(); let box, previousBox, stable = 0;
  await until(async () => {
    box = await input.boundingBox();
    const inWindow = box && box.width >= 100 && box.x >= 0 && box.x + box.width <= 850 && box.y >= 0 && box.y + box.height <= await page.evaluate(() => innerHeight);
    stable = inWindow && previousBox && Math.abs(previousBox.width - box.width) < .5 && Math.abs(previousBox.y - box.y) < .5 ? stable + 1 : 0;
    previousBox = box; return stable >= 2;
  }, 'Existing DSH sidebar expansion settles with the complete readable editor inside the window');
  assert.ok(box.width >= 100 && box.x >= 0 && box.x + box.width <= 850, 'Inline editor is readable and inside the actual narrow window'); console.log(JSON.stringify({ initialNarrowBox, settledNarrowBox: box })); await shot('narrow-existing-sidebar'); await input.press('Escape');
  await page.locator('#room-nav').click(); await page.locator('#shared-input').fill('Shared draft remains unsent'); const room = (await state()).room.name; await rename('room'); assert.equal(await input.inputValue(), room); assert.equal(await input.getAttribute('id'), 'rename-name'); assert.equal(await page.locator('#rename-label').innerText(), '工作区名称');
  assert.equal(await input.evaluate(n => n.closest('.room-row') !== null), true); await input.fill('Named workspace 你好'); await input.press('Enter'); await page.locator('#rename-editor').waitFor({ state: 'hidden' }); await until(async () => (await peer.evaluate(() => workspace.initial())).room.name === 'Named workspace 你好', 'Workspace rename synchronized');
  assert.equal(await page.locator('#shared-input').inputValue(), 'Shared draft remains unsent'); await rename('room'); await input.fill('Keep workspace draft'); await peer.evaluate(() => workspace.archiveRoom()); await until(async () => (await page.locator('#rename-error').innerText()).includes('已归档'), 'Archived workspace retains editor'); assert.equal(await input.isVisible(), true); await peer.evaluate(() => workspace.restoreRoom()); await until(() => page.locator('#confirm-rename').isEnabled(), 'Workspace restoration unlocks original editor'); await input.press('Escape');
  check('850×600 icon rail reuses the published sidebar reveal; workspace edits use their own original row/API and retain shared draft through rename/archive/restore');

  await page.locator(`[data-session-id="${id}"]`).click(); await page.locator('#chat-tab').click(); await fixture('history', id, [{ id: 'rename-original-body', type: 'agentMessage', text: 'Original private selection 你好' }]); await page.locator('[data-message-id="rename-original-body"] .message-body').waitFor();
  await page.locator('[data-message-id="rename-original-body"] .message-body').evaluate(n => { const r = document.createRange(); r.selectNodeContents(n); getSelection().removeAllRanges(); getSelection().addRange(r); });
  await rename(id); await page.locator('#session-header-more').click(); await item('分享选中内容').waitFor(); assert.equal(await item('分享选中内容').isDisabled(), true); await page.keyboard.press('Escape'); await input.press('Escape');
  const final = (await state()).sessions.find(s => s.id === id); assert.deepEqual(identity(final), identity(original)); assert.equal(final.liveDraft, draft); assert.equal((await client.call('initial')).sessions.find(s => s.id === id).name, daemonOriginal.name, 'Native record/title was never renamed');
  await page.reload(); await page.locator('#new-session').waitFor(); await until(async () => (await state()).sessions.find(s => s.id === id).name === 'Peer chosen title', 'Saved label after reload'); assert.equal((await state()).room.name, 'Named workspace 你好'); assert.equal(await page.locator('#message-input').inputValue(), draft);
  check('Rename never becomes shared input or native title; saved session/workspace labels, original identity/owner and unsent conversation draft survive reload');
  const stats = await fixture(), intercepted = await app.evaluate(() => globalThis.inlineTest); assert.deepEqual(stats.inputs, []); assert.deepEqual(stats.sends, []); assert.deepEqual(stats.interruptions, []); assert.deepEqual(errors, []);
  const result = { checks, stats, intercepted, errors, productModels: 0, realProviders: 0, systemClipboard: 'readers/writer intercepted, original formats untouched', limits: 'Synthetic transport/save faults and programmatic input; no physical IME/screen reader/installed validation; existing rename API has no atomic name CAS', scriptSha256: createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'), assetSha256: createHash('sha256').update(fs.readFileSync(path.join(code, 'app/dsh/client.js'))).digest('hex') };
  if (evidence) fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
}
scratch.cleanup(async () => {
  if (app) { await app.evaluate(({ clipboard }, code) => { const old = globalThis.inlineOriginal; if (!old) return; const load = process.getBuiltinModule('module').createRequire(code + '/package.json'); const { SessionLabels } = load(code + '/app/session-labels.cjs'), { RoomState } = load(code + '/app/room-state.cjs'); SessionLabels.prototype.set = old.labels; RoomState.prototype.rename = old.room; Object.assign(clipboard, { writeText: old.writeText, readText: old.readText, readImage: old.readImage }); }, code); await app.close(); }
  if (client) { for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); }
  if (child.connected) child.disconnect(); if (child.exitCode === null) child.kill('SIGTERM');
});
run().catch(async e => { console.error(e.stack); console.error(JSON.stringify({ checks, errors })); process.exitCode = 1; if (page) await shot('failure').catch(() => {}); }).finally(async () => {
  try { await scratch.release(); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); if (evidence) fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ ...owner, releasedAt: new Date().toISOString(), ownedProfilesAndProcessesGone: true }, null, 2)); console.log('Owned T55 GUI/profiles cleaned; canonical token released.'); }
  catch (e) { console.error('Cleanup unconfirmed; retain canonical lock:', e.stack); process.exitCode = 1; }
});
