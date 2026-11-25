// One owned source GUI, synthetic NativeHost, two sessions. No provider/model,
// native input, send, OS clipboard, installed/daily application or new design.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const scratch = require('./fixtures/test-scratch.cjs'), { createIn } = require('./fixtures/create-view.cjs');
const { _electron } = scratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..');
assert.equal(process.env.NAW_GROUPED_RENAME_GUI_AUTHORIZED, '1');
assert.ok(process.env.NAW_EVIDENCE_DIR && process.env.NAW_SCREENSHOTS_DIR);
const evidence = path.resolve(process.env.NAW_EVIDENCE_DIR), pictures = path.resolve(process.env.NAW_SCREENSHOTS_DIR);
for (const target of [evidence, pictures]) {
  let existing = target; while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const real = path.join(fs.realpathSync(existing), path.relative(existing, target));
  assert.ok(real !== root && !real.startsWith(root + path.sep), 'Evidence outside source'); fs.mkdirSync(real, { recursive: true, mode: 0o700 });
}
const hash = name => createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex');
const hashes = () => Object.fromEntries(['app/renderer/renderer.js', 'app/renderer/styles.css', 'app/dsh/client.js'].map(n => [n, hash(n)]));
const sourceBefore = hashes(), start = Date.now();
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('GUI slot occupied: no profile/process launched'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex 3', task: 'T155 grouped space rename', token, pid: process.pid, at: new Date().toISOString() }));
let profile, child, application, page, guiPid, sequence = 0, failure, details, cleanupConfirmed = false;
const checks = [], errors = [], witnesses = [], delay = ms => new Promise(r => setTimeout(r, ms));
const record = name => { checks.push(name); console.log('PASS ' + name); };
function withinBudget() { assert.ok(Date.now() - start < 180000, 'Finite 180s active journey'); }
async function until(fn, label) { for (let n = 0; n < 100; n++) { withinBudget(); if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value) {
  const id = ++sequence; return new Promise((resolve, reject) => {
    const listener = result => { if (result.requestId === id) { clearTimeout(timer); child.off('message', listener); result.error ? reject(Error(result.error)) : resolve(result); } };
    const timer = setTimeout(() => { child.off('message', listener); reject(Error('Fixture deadline')); }, 8000);
    child.on('message', listener); child.send({ id, method, target, value });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
const sidebar = () => page.locator('.naw[data-native-surface="sidebar"]');
const group = () => sidebar().locator('[data-session-group="shared"]');
async function capture(name) { const file = path.join(pictures, name + '.png'); await page.screenshot({ path: file }); witnesses.push(file); }
function stable(state) { return { sessions: state.sessions.map(s => [s.id, s.nativeId, s.liveDraft || '']).sort(), shared: state.viewState.roomViews?.shared?.sharedDraft || '' }; }
async function create(name, provider) {
  const state = await snapshot(); assert.equal(state.servicePid, child.pid, 'Never create on a replacement/real service');
  assert.equal(state.runtimeVersion, require('../package.json').version);
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="' + provider + '"]').check();
  await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => s.name === name && s.state === 'idle'), 'Synthetic session ready');
  const id = (await snapshot()).sessions.find(s => s.name === name).id;
  await page.locator('#session-header-more').click(); await page.getByRole('menuitem', { name: '加入此空间', exact: true }).click();
  await page.locator('#toast-close').waitFor(); await page.locator('#toast-close').click(); return id;
}
async function openRename() {
  await group().locator('.space-group-more').click(); await page.getByRole('menuitem', { name: '重命名…', exact: true }).click();
  await page.locator('#rename-name').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#rename-name').evaluate(e => e === document.activeElement), true);
  assert.equal(await page.locator('#sessions-grouped').getAttribute('aria-pressed'), 'true');
}
async function run() {
  profile = scratch.directory(path.join(os.tmpdir(), 'naw-grouped-space-rename-'));
  child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/collaboration-overview.cjs')], env: { ...process.env, NAW_APP_VERSION: require('../package.json').version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: root }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Own synthetic daemon ready');
  application = await _electron.launch({ executablePath: require('electron'), args: [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 30000 });
  guiPid = application.process().pid; page = await application.firstWindow(); page.setDefaultTimeout(6000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor();
  const initialService = await snapshot(); assert.equal(initialService.servicePid, child.pid, 'UI must use owned synthetic daemon BEFORE any session');
  assert.equal(initialService.runtimeVersion, require('../package.json').version); const initialFixture = await fixture('stats');
  assert.equal(initialFixture.stats.inputs, 0); assert.equal(initialFixture.stats.sends, 0);
  await (await application.browserWindow(page)).evaluate(w => w.setContentSize(1240, 850));
  const a = await create('Rename A', 'claude'), b = await create('Rename B', 'codex');
  await sidebar().locator('[data-session-row="' + a + '"]').first().locator('.session-link').click(); await page.locator('#message-input').fill('UNSENT rename private draft');
  await until(async () => (await snapshot()).sessions.find(s => s.id === a).liveDraft === 'UNSENT rename private draft', 'Private draft saved');
  await page.locator('#new-space').click(); await page.locator('#space-create-name').fill('Other untouched space'); await page.locator('#space-create-manager').uncheck(); await page.locator('#confirm-space-create').click(); await page.locator('#space-create-dialog').waitFor({ state: 'hidden' });
  const other = (await snapshot()).rooms.find(r => r.name === 'Other untouched space').id;
  await page.locator('#sessions-flat').click(); await page.locator('#room-nav').click(); await page.locator('#shared-input').fill('UNSENT rename shared draft');
  await until(async () => stable(await snapshot()).shared === 'UNSENT rename shared draft', 'Shared draft saved');
  if (await page.locator('#workspace-toggle').getAttribute('aria-expanded') === 'true') await page.locator('#workspace-toggle').click();
  await page.locator('#sessions-grouped').click(); assert.equal(await page.locator('#workspace-group').isVisible(), false);
  const initial = await snapshot(), identity = stable(initial), originalName = initial.rooms.find(r => r.id === 'shared').name;
  await openRename(); await page.locator('#rename-name').fill('UNSENT grouped room name');
  assert.equal(await page.locator('#workspace-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(await sidebar().locator('[data-space-id="' + other + '"]').isVisible(), false, 'Unrelated old space row remains hidden');
  await fixture('state', b, 'working'); await until(async () => (await snapshot()).sessions.find(s => s.id === b).state === 'working', 'Other member stream event');
  assert.equal(await page.locator('#rename-name').inputValue(), 'UNSENT grouped room name'); assert.deepEqual(stable(await snapshot()), identity);
  await capture('01-visible-existing-editor'); await page.locator('#rename-name').press('Escape');
  await until(async () => !await page.locator('#rename-editor').isVisible(), 'Escape cancels');
  assert.equal(await page.locator('#workspace-group').isVisible(), false); assert.equal((await snapshot()).rooms.find(r => r.id === 'shared').name, originalName);
  record('Grouped heading rename unfolds and focuses the original editor; stream preserves draft; Escape restores compact navigation');
  await openRename(); await page.locator('#rename-name').fill('Renamed shared workspace'); await page.locator('#confirm-rename').click();
  await until(async () => (await snapshot()).rooms.find(r => r.id === 'shared').name === 'Renamed shared workspace', 'Actual existing rename API persisted');
  assert.equal(await page.locator('#workspace-group').isVisible(), false); assert.match(await group().locator('.session-space-heading').innerText(), /^Renamed shared workspace/);
  assert.equal((await snapshot()).rooms.find(r => r.id === other).name, 'Other untouched space'); assert.deepEqual(stable(await snapshot()), identity);
  await page.reload(); await page.locator('#new-session').waitFor(); await group().waitFor(); assert.equal(await page.locator('#workspace-group').isVisible(), false);
  assert.match(await group().locator('.session-space-heading').innerText(), /^Renamed shared workspace/); assert.deepEqual(stable(await snapshot()), identity); await capture('02-saved-and-reloaded');
  record('Save changes the intended space only; grouped choice, native identities and private/shared drafts survive renderer reload');
  const packet = await fixture('stats'); assert.equal(packet.stats.inputs, 0); assert.equal(packet.stats.sends, 0);
  for (const [name, count] of Object.entries(packet.overviewCalls)) if (!['claim', 'terminal', 'terminalSnapshot'].includes(name)) assert.equal(count, 0, name);
  assert.deepEqual(errors, []); assert.deepEqual(hashes(), sourceBefore); withinBudget();
  return { identity, originalName, otherSpace: other, stats: packet.stats, workspaceCalls: packet.overviewCalls, runCounter: 'LOCAL_START_RUN_ATTEMPTS_ONLY', finalSpaceName: 'Renamed shared workspace' };
}
run().then(value => { details = value; }).catch(async error => { failure = error.stack; process.exitCode = 1; console.error(failure); if (page && !page.isClosed()) await capture('failure').catch(() => {}); }).finally(async () => {
  try { await scratch.release(); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); cleanupConfirmed = true; }
  catch (error) { console.error('Own cleanup unconfirmed; lease retained:', error.stack); process.exitCode = 1; }
  const result = { at: new Date().toISOString(), checks, details, errors, failure, witnesses, elapsedMs: Date.now() - start, ownDaemonPid: child?.pid, ownGuiPid: guiPid, ownedCleanupConfirmed: cleanupConfirmed, profileGone: profile ? !fs.existsSync(profile) : true, canonicalOwnTokenReleased: cleanupConfirmed, sourceBefore, sourceAfter: hashes(), productModels: 0, realProviders: 0, osClipboard: 0, limits: 'Actual source GUI/service with synthetic NativeHost; not installed/provider/IME/physical-native/locked CUA; flat/member/race branches covered by actual-function tests.' };
  fs.writeFileSync(path.join(evidence, 'grouped-space-rename-result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
});
