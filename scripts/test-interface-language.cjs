// Actual source Electron + the existing synthetic NativeHost. No model or native program starts.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process'), { pathToFileURL } = require('node:url');
const testScratch = require('./fixtures/test-scratch.cjs'), { createIn } = require('./fixtures/create-view.cjs');
const { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const locale = require(path.join(code, 'app/ui-locale.js'));
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('GUI slot occupied; no launch.'); process.exit(75); }
const owner = { owner: process.env.NAW_TEST_OWNER || 'Codex4', task: 'T60 interface language', token, pid: process.pid, createdAt: new Date().toISOString() };
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify(owner));
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-interface-language-'));
const working = path.join(profile, 'workspace'); fs.mkdirSync(working);
const child = testScratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')],
  env: { ...process.env, DSH_TELEMETRY_DISABLED: '1', NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: working, NAW_APP_VERSION: require(path.join(code, 'package.json')).version },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
const evidence = process.env.NAW_EVIDENCE_DIR;
if (evidence) { assert.ok(!path.resolve(evidence).startsWith(root + path.sep)); fs.mkdirSync(evidence, { recursive: true, mode: 0o700 }); }
const checks = [], errors = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, page, other, sequence = 0, result;
const state = () => page.evaluate(() => workspace.initial());
const check = text => { checks.push(text); console.log('PASS:', text); };
const shot = name => evidence && page && !page.isClosed() ? page.screenshot({ path: path.join(evidence, name + '.png') }) : Promise.resolve();
async function until(fn, text) { for (let n = 0; n < 160; n++) { if (await fn()) return; await delay(50); } throw Error(text); }
function fixture(method, target, value) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, receive = reply => { if (reply.requestId === id) { clearTimeout(timer); child.off('message', receive); resolve(reply); } };
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Fixture response timed out')); }, 8000);
    child.on('message', receive); child.send({ id, method, target, value });
  });
}
const identity = record => [record.id, record.nativeId, record.owner, record.cwd, record.view];
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Own fixture startup');
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'connection.json'))).pid, child.pid);
  app = await _electron.launch({ args: [path.join(__dirname, 'fixtures/interface-language-main.cjs')],
    env: { ...process.env, DSH_TELEMETRY_DISABLED: '1', NAW_TEST_APP_ROOT: code, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_UI_LANGUAGE: 'system' }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
  await page.locator('#new-session').waitFor({ timeout: 60000 });
  const systemLanguages = await app.evaluate(({ app }) => app.getPreferredSystemLanguages());
  assert.equal(locale.language(locale.snapshot({ languages: systemLanguages, preference: null })), 'en', 'This English smoke requires an English system preference');
  const { readLocaleProfile } = await import(pathToFileURL(path.join(code, 'app/ui-locale-profile.mjs')).href);
  const readPreference = () => readLocaleProfile({ dataDir: path.join(profile, 'dsh'), localeModule: require.resolve('@deepseek-ai/dsh-client-locale') });
  const preference = async () => (await readPreference()).preference;
  const initialPreference = await readPreference();
  assert.deepEqual(initialPreference, { preference: null, legacyChinese: false, warning: null },
    'The new profile follows the actual system, without a forced preference or unavailable read');
  const newSession = page.locator('#new-session');
  assert.equal(await newSession.getAttribute('aria-label'), locale.format('en', 'sidebar.newSession'));
  assert.equal(await newSession.locator('.rail-label').innerText(), locale.format('en', 'sidebar.newSessionLabel'));
  assert.notEqual(locale.format('en', 'sidebar.newSessionLabel'), locale.format('zh', 'sidebar.newSessionLabel'));
  check('A new unseeded profile displays the actual English system language');
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, working);
  await newSession.click(); await page.locator('input[name="provider"][value="codex"]').check();
  await page.locator('#session-name').fill('RAW 中文 English fixture'); await page.locator('#choose-folder').click(); await createIn(page, 'chat');
  await until(async () => (await state()).sessions[0]?.state === 'idle', 'Synthetic session becomes ready');
  const original = (await state()).sessions[0]; assert.ok(original.owner); assert.ok(original.nativeId.startsWith('synthetic-'));
  const draft = 'PRIVATE 中文 English UNSENT\n{raw}'; await page.locator('#message-input').fill(draft);
  const newWindow = app.waitForEvent('window');
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('naw-menu-new-window').click());
  other = await newWindow; other.setDefaultTimeout(12000); other.on('pageerror', error => errors.push(error.message));
  await other.locator('#new-session').waitFor();
  await page.locator('#session-list [data-session-id="' + original.id + '"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: locale.format('en', 'menu.copyNawId'), exact: true }).waitFor();
  await other.locator('#setup-button').click(); await other.locator('#ui-language').selectOption('zh');
  await until(async () => await preference() === 'zh' && await other.locator('#setup-title').innerText() === locale.format('zh', 'common.settings'), 'Chinese preference accepted by the actual Host');
  await page.getByRole('menuitem', { name: locale.format('zh', 'menu.copyNawId'), exact: true }).waitFor();
  await fixture('set-state', original.id, 'working');
  await until(async () => (await state()).sessions[0].state === 'working', 'Positive synthetic native-state update');
  assert.equal(await page.getByRole('menuitem', { name: locale.format('zh', 'menu.copyNawId'), exact: true }).isVisible(), true);
  assert.deepEqual(identity((await state()).sessions[0]), identity(original)); assert.equal(await page.locator('#message-input').inputValue(), draft);
  await shot('chinese-open-menu');
  check('Changing language in the second window keeps the original menu, native identity and unsent draft through a native-state update');
  await other.locator('#ui-language').selectOption('en');
  await until(async () => await preference() === 'en' && await other.locator('#setup-title').innerText() === locale.format('en', 'common.settings'), 'English preference saved');
  await page.getByRole('menuitem', { name: locale.format('en', 'menu.copyNawId'), exact: true }).waitFor();
  await shot('english-open-menu'); await other.close(); other = null;
  await page.keyboard.press('Escape'); await fixture('set-state', original.id, 'idle');
  await page.reload(); await page.locator('#new-session').waitFor();
  assert.equal(await preference(), 'en'); assert.deepEqual(identity((await state()).sessions[0]), identity(original));
  assert.equal(await page.locator('#message-input').inputValue(), draft);
  await page.locator('#new-session').click(); assert.equal(await page.locator('#cancel-create').innerText(), locale.format('en', 'common.cancel'));
  await shot('english-create'); await page.locator('#cancel-create').click();
  const native = await fixture('inspect');
  assert.deepEqual(native.inputs, []); assert.deepEqual(native.sends, []); assert.deepEqual(native.interruptions, []);
  assert.equal((await state()).diagnostics.dispatches, 0); assert.deepEqual(errors, []);
  const clipboard = await app.evaluate(() => ({ proof: globalThis.t60ClipboardGuardProof, attempts: globalThis.t60ClipboardAttempts }));
  assert.equal(clipboard.proof.blocked, true); assert.equal(clipboard.proof.baseline, 1);
  assert.deepEqual(clipboard.attempts, ['readText'], 'Only the intercepted positive guard self-check was attempted; the GUI flow did not call the clipboard');
  check('Accepted English survives renderer reload and the original draft; create/cancel remains English with zero dispatches, native input or clipboard calls');
  result = { checks, errors, systemLanguages, identity: identity(original), native, clipboard, profile, productModelCalls: 0, providers: 0,
    limits: 'Source Electron/CDP only. A1 is separately covered by the actual Host unit. Main-added snapshot and other untranslated strings remain batch2; installed/physical/VoiceOver are not qualified.' };
}
const cleanup = testScratch.cleanup(async () => {
  if (app) await app.close();
  if (child.connected) child.disconnect(); if (child.exitCode === null) child.kill('SIGTERM');
});
let timer;
Promise.race([run(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Bounded language smoke exceeded 180 seconds')), 180000); })])
  .catch(async error => { console.error(error.stack); process.exitCode = 1; result = { checks, errors, failure: error.message, profile }; await shot('failure').catch(() => {}); })
  .finally(async () => {
    try { await cleanup(); clearTimeout(timer); assert.equal(fs.existsSync(profile), false);
      assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
      console.log('Owned GUI/processes/profile cleaned; canonical token released.');
    } catch (error) { clearTimeout(timer); process.exitCode = 1; console.error('Cleanup failed; this finalizer did not release the canonical slot:', error.stack); return; }
    try {
      if (evidence) { fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2)); fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ ...owner, profileGone: true, releasedAt: new Date().toISOString() }, null, 2)); }
    } catch (error) { process.exitCode = 1; console.error('Evidence write failed after confirmed cleanup and release:', error.stack); }
  });
