// Changing the model of one session from its menu (N5): an isolated hidden window and NAW's own backend service; only
// the native programs are synthetic (fixtures/native-model-change.cjs). No native program is started, no model is called.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const scratch = require('./fixtures/test-scratch.cjs'), { createIn } = require('./fixtures/create-view.cjs');
const { _electron } = scratch.playwright(require('playwright'));
const locale = require('../app/ui-locale.js');
const root = path.resolve(__dirname, '..');
if (!process.env.NAW_APP_EXECUTABLE) scratch.childProcess.execFileSync(process.execPath, [path.join(root, 'scripts/build-ui.cjs')]);
const evidence = process.env.NAW_EVIDENCE_DIR || path.join(scratch.directory(path.join(os.tmpdir(), 'naw-model-change-evidence-')), 'evidence'); fs.mkdirSync(evidence, { recursive: true });
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-model-change-'));
const workspacePath = path.join(profile, 'workspace'); fs.mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
const env = { ...process.env }; for (const key of ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'NAW_RUNTIME_CONFIG', 'DEEPSEEK_API_KEY', 'NAW_TEST_BUTLER_ENTRY']) delete env[key];
const child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/native-model-change.cjs')],
  env: { ...env, NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: workspacePath, NAW_APP_VERSION: require(path.join(root, 'package.json')).version },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
let app, page, sequence = 0;
const errors = [], checks = [], shots = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, tries = 600) { for (let i = 0; i < tries; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const callback = reply => { if (reply.requestId === id) { clearTimeout(timer); child.off('message', callback); reply.error ? reject(Error(reply.error)) : resolve(reply); } };
    const timer = setTimeout(() => { child.off('message', callback); reject(Error('Fixture timed out')); }, 12000);
    child.on('message', callback); child.send({ id, method, target, value });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
const session = async id => (await snapshot()).sessions.find(s => s.id === id);
async function create(name, provider) {
  const previous = new Set((await snapshot()).sessions.map(s => s.id));
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  const id = (await snapshot()).sessions.find(s => s.name === name && !previous.has(s.id)).id;
  if (provider === 'claude') await fixture('background', id, { count: 0, scheduled: 0, kinds: [], ids: [] });
  return id;
}
async function size(width, height) {
  await (await app.browserWindow(page)).evaluate((win, [w, h]) => win.setContentSize(w, h), [width, height]);
  await until(() => page.evaluate(w => innerWidth === w, width), `Window ${width} wide`); await delay(400);
}
async function language(value) {
  await page.locator('#setup-button').click(); await page.locator('#ui-language').selectOption(value);
  await until(async () => await page.locator('#ui-language').getAttribute('aria-busy') === 'false' && await page.locator('#setup-title').innerText() === locale.format(value, 'common.settings'), 'The interface follows the language');
  await page.locator('#close-setup').click(); await page.locator('#setup-dialog').waitFor({ state: 'hidden' });
}
const shot = async name => { await delay(200); await page.screenshot({ path: path.join(evidence, name + '.png') }); shots.push(name); };
const dialogShot = async name => { await delay(200); await page.locator('#model-dialog').screenshot({ path: path.join(evidence, name + '.png') }); shots.push(name); };
const row = id => page.locator(`#session-list .session-row[data-session-row="${id}"]`);
const menu = async id => { await row(id).click({ button: 'right' }); await page.getByRole('menuitem').first().waitFor(); };
const changeItem = () => page.getByRole('menuitem').filter({ hasText: say('menu.changeModelUnreported') });
let lang = 'zh'; const say = (key, params) => locale.format(lang, key, params);
const dialog = () => page.locator('#model-dialog'), toast = () => page.locator('#toast-text').innerText();
async function openDialog(id) { await menu(id); await changeItem().first().click(); await dialog().waitFor({ state: 'visible' }); await until(() => page.locator('#model-list input').count(), 'Choices'); }
const rows = () => page.locator('#model-list .model-pick').allInnerTexts();
async function choose(model, effort) { await page.locator(`#model-list input[value="${model}"]`).check(); await page.locator('#model-effort').selectOption(effort); await page.locator('#model-confirm').click(); }
// What a person could not read: text wider than its box, or a button outside the window.
const overflow = () => page.evaluate(() => {
  const box = document.getElementById('model-dialog').getBoundingClientRect(), bad = [];
  if (box.left < 0 || box.right > innerWidth || box.top < 0 || box.bottom > innerHeight) bad.push('dialog');
  for (const el of document.querySelectorAll('#model-dialog *')) { const r = el.getBoundingClientRect(); if (r.width && (r.left < box.left - 1 || r.right > box.right + 1)) bad.push(el.id || el.className || el.tagName); }
  return bad;
});

(async () => {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Own fixture ready');
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.stack)); await page.locator('#new-session').waitFor();
  await size(1280, 800);
  const claude = await create('Claude 主会话', 'claude'), codex = await create('Codex 文档', 'codex');
  const before = await session(claude);

  // 1. The menu says what the session runs; the dialog lists what it can change to and changes nothing by itself.
  await menu(claude); assert.deepEqual(await changeItem().allInnerTexts(), [say('menu.changeModel', { model: 'claude-fable-5-2' })]); await shot('zh-menu');
  await page.keyboard.press('Escape'); await delay(150);
  await openDialog(claude);
  assert.equal(await page.locator('#model-title').innerText(), say('model.title', { name: 'Claude 主会话' }));
  assert.deepEqual(await rows(), [say('standing.nativeDefault'), 'claude-opus-5-5', 'claude-sonnet-5-5', say('model.now', { model: 'claude-fable-5-2' }), 'claude-haiku-5-5']);
  assert.equal(await page.locator('#model-list input:checked').inputValue(), 'claude-fable-5-2');
  assert.deepEqual(await overflow(), []); await dialogShot('zh-dialog-claude'); await shot('zh-dialog-window');
  await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'hidden' });
  assert.deepEqual((await snapshot()).modelChanges, []);
  checks.push('The menu names the model it runs; the dialog marks it, lists the rest and closes on Escape without a change');

  // 2. An idle session is stopped and resumed as the same one, with the choice; the person is told.
  await openDialog(claude); await choose('claude-opus-5-5', 'xhigh'); await dialog().waitFor({ state: 'hidden' });
  await until(async () => (await session(claude)).model === 'claude-opus-5-5' && (await session(claude)).state === 'idle', 'Changed');
  let after = await session(claude);
  assert.deepEqual([after.nativeId, after.nativeEffort, after.owner, after.view, after.requestedSettings?.effort], [before.nativeId, 'xhigh', before.owner, before.view, 'xhigh']);
  await until(async () => await toast() === say('model.done', { name: 'Claude 主会话', value: 'claude-opus-5-5 · xhigh' }), 'Told'); await shot('zh-done');
  assert.deepEqual((await snapshot()).modelChanges, []);
  await fixture('background', claude, { count: 0, scheduled: 0, kinds: [], ids: [] });
  checks.push('An idle session is stopped and resumed as the same one with the choice, for the same window');

  // 3. A working session waits for its turn to end; what waits is in the menu, can be withdrawn, and is made at the end.
  await fixture('state', claude, 'working'); await openDialog(claude); await choose('claude-sonnet-5-5', 'low'); await dialog().waitFor({ state: 'hidden' });
  await until(async () => await toast() === say('model.waiting', { name: 'Claude 主会话', value: 'claude-sonnet-5-5 · low', reason: say('model.wait.turn') }), 'Said to wait');
  await delay(2600); assert.equal((await session(claude)).model, 'claude-opus-5-5', 'Nothing is stopped meanwhile'); assert.equal((await session(claude)).state, 'working');
  await menu(claude); assert.deepEqual(await changeItem().allInnerTexts(), [say('menu.changeModelPending', { value: 'claude-sonnet-5-5 · low' })]); await shot('zh-menu-waiting'); await page.keyboard.press('Escape'); await delay(150);
  await openDialog(claude); assert.equal(await page.locator('#model-pending').innerText(), say('model.pending', { value: 'claude-sonnet-5-5 · low', reason: say('model.wait.turn') })); assert.deepEqual(await overflow(), []); await dialogShot('zh-dialog-waiting');
  await page.locator('#model-withdraw').click(); await dialog().waitFor({ state: 'hidden' }); assert.deepEqual((await snapshot()).modelChanges, []);
  await openDialog(claude); await choose('claude-sonnet-5-5', 'low'); await dialog().waitFor({ state: 'hidden' });
  await fixture('background', claude, { count: 0, scheduled: 0, kinds: [], ids: [] }); await fixture('state', claude, 'idle');
  await until(async () => (await session(claude)).model === 'claude-sonnet-5-5', 'Changed at the end of its turn');
  checks.push('A working session waits for its turn to end, the menu and the dialog say so, it can be withdrawn, and nothing is stopped meanwhile');

  // 4. Background work that a restart would cut off refuses it in the dialog, with what is running.
  await fixture('background', claude, { count: 2, scheduled: 0, kinds: ['shell'], ids: ['1', '2'] });
  await openDialog(claude); await choose('claude-opus-5-5', 'high'); await page.locator('#model-error').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#model-error').innerText(), say('error.modelChange.busy', { reason: say('error.planBackgroundRunning', { count: 2 }) })); assert.deepEqual(await overflow(), []); await dialogShot('zh-dialog-refused');
  await page.locator('#model-cancel').click(); assert.equal((await session(claude)).model, 'claude-sonnet-5-5'); assert.deepEqual((await snapshot()).modelChanges, []);
  checks.push('Running background work refuses the change in the dialog with its reason; nothing is stopped');

  // 5. Codex: its own list, in effect from the next turn also while it works.
  await fixture('state', codex, 'working'); await openDialog(codex);
  assert.deepEqual(await rows(), [say('model.now', { model: 'gpt-6.2-sol' }), 'gpt-6.2-luna']); assert.deepEqual(await overflow(), []); await dialogShot('zh-dialog-codex');
  await choose('gpt-6.2-luna', 'medium'); await dialog().waitFor({ state: 'hidden' });
  await until(async () => await toast() === say('model.doneCodex', { name: 'Codex 文档', value: 'gpt-6.2-luna · medium' }), 'Told for Codex');
  assert.deepEqual([(await session(codex)).model, (await session(codex)).state], ['gpt-6.2-luna', 'working']);
  checks.push('Codex is changed without a restart, also while it works, and the person is told from when');

  // 6. The title bar's menu offers it too; small window and English.
  await row(codex).locator('.session-link').first().click(); await delay(300); await page.locator('#session-header-more').click(); await changeItem().first().click(); await dialog().waitFor({ state: 'visible' }); await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'hidden' });
  await size(850, 600); await row(claude).locator('.session-link').first().click(); await delay(200); await page.locator('#session-header-more').click(); await changeItem().first().click(); await dialog().waitFor({ state: 'visible' }); await until(() => page.locator('#model-list input').count(), 'Choices'); assert.deepEqual(await overflow(), []); await shot('zh-850'); await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'hidden' });
  await size(1280, 800); await language('en'); lang = 'en'; await openDialog(claude); assert.deepEqual(await overflow(), []); await dialogShot('en-dialog-claude'); await page.locator('#model-cancel').click();
  checks.push('The title bar offers it; it fits the 850 by 600 window; English');

  assert.deepEqual(errors, []);
  const result = { checks, screenshots: shots.length, nativeProgramsStarted: 0, modelPromptsSent: 0, paidModelCalls: 0, evidence };
  fs.writeFileSync(path.join(evidence, 'model-change-result.json'), JSON.stringify(result, null, 1)); console.log(JSON.stringify(result));
})().catch(async error => {
  if (page && !page.isClosed()) { fs.writeFileSync(path.join(evidence, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {}); }
  console.error(error.stack, '\nPage errors:', errors, '\nEvidence:', evidence); process.exitCode = 1;
}).finally(async () => { await scratch.release().catch(error => { console.error('Cleanup:', error.message); process.exitCode = 1; }); });
