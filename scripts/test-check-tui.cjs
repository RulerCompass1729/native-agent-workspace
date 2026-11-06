// Actual legacy desktop checks in one owned synthetic profile; no native input.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const scratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
const { checkTui, verifyTui, restoreTui } = require('./check-tui.cjs');
const { _electron } = scratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), version = require('../package.json').version;
assert.equal(process.env.NAW_CHECK_TUI_GUI_AUTHORIZED, '1');
assert.ok(process.env.NAW_EVIDENCE_DIR && process.env.NAW_SCREENSHOTS_DIR);
const evidence = path.resolve(process.env.NAW_EVIDENCE_DIR), pictures = path.resolve(process.env.NAW_SCREENSHOTS_DIR);
for (const target of [evidence, pictures]) {
  let existing = target; while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const real = path.join(fs.realpathSync(existing), path.relative(existing, target));
  assert.ok(real !== root && !real.startsWith(root + path.sep), 'Evidence must be outside the repository');
}
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
fs.mkdirSync(pictures, { recursive: true, mode: 0o700 });
const sourceNames = ['scripts/check-tui.cjs', 'scripts/test-check-tui.cjs', 'app/dsh/client.js'];
const hashes = () => Object.fromEntries(sourceNames.map(n => [n, createHash('sha256').update(fs.readFileSync(path.join(root, n))).digest('hex')]));
const before = hashes(), start = Date.now();
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) {
  if (error.code !== 'EEXIST') throw error;
  fs.writeFileSync(path.join(evidence, 'occupied.json'), JSON.stringify({ at: new Date().toISOString(), launched: 0 }));
  process.exit(75);
}
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex 3', task: 'T153 check-tui', token, pid: process.pid, at: new Date().toISOString() }));
let profile, child, application, page, guiPid, sequence = 0, failure, details, cleaned = false;
const guiPids = [], checks = [], errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let i = 0; i < 160; i++) { if (await fn()) return; await delay(50); }
  throw Error(label);
}
function fixture() {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const listener = m => { if (m.requestId === id) { clearTimeout(timer); child.off('message', listener); resolve(m); } };
    const timer = setTimeout(() => { child.off('message', listener); reject(Error('Fixture timeout')); }, 8000);
    child.on('message', listener); child.send({ id, method: 'stats' });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
async function guard() {
  const state = await snapshot();
  assert.equal(state.servicePid, child.pid, 'Must use the exact owned synthetic daemon');
  assert.equal(state.runtimeVersion, version, 'Never bootstrap a replacement provider service');
  return state;
}
async function launch() {
  application = await _electron.launch({ executablePath: require('electron'), args: [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 30000 });
  guiPid = application.process().pid; guiPids.push(guiPid);
  page = await application.firstWindow(); page.setDefaultTimeout(4000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor(); await guard();
}
async function run() {
  profile = scratch.directory(path.join(os.tmpdir(), 'naw-check-tui-'));
  child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/collaboration-overview.cjs')], env: { ...process.env, NAW_APP_VERSION: version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: root }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Own synthetic daemon');
  await launch();
  const first = await fixture(); assert.equal(first.stats.inputs, 0); assert.equal(first.stats.sends, 0);
  await guard(); // BEFORE Create, not after a provider could have started.
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check();
  await page.locator('#session-name').fill('TUI synthetic qualification'); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => s.state === 'idle'), 'Synthetic idle');
  const id = (await snapshot()).viewState.selected;
  await page.locator('#session-header-more').click(); await page.getByRole('menuitem', { name: '加入此空间', exact: true }).click();
  await page.locator('#toast-close').waitFor(); await page.locator('#toast-close').click();
  await page.locator('#sessions-flat').click();
  const initial = await guard(), record = initial.sessions.find(s => s.id === id);
  assert.ok(record && record.owner === initial.owner && record.state === 'idle' && record.terminalAvailable);
  assert.equal(initial.sessions.length, 1);
  fs.writeFileSync(path.join(evidence, 'controlled-before.json'), JSON.stringify(initial, null, 2));
  await page.locator('#terminal-tab').click();
  assert.equal(await page.locator('#terminal-more').isVisible(), true);
  assert.equal(await page.locator('#terminal-display').isVisible(), false);
  let oldFailure;
  try { await page.locator('#terminal-display').click({ timeout: 500 }); }
  catch (error) { oldFailure = error.stack; }
  assert.match(oldFailure || '', /Timeout/);
  fs.writeFileSync(path.join(evidence, 'old-entry-failure.txt'), oldFailure + '\n');
  checks.push('Old exact display click fails on hidden control in the positive controlled terminal');
  await page.locator('#chat-tab').click();
  const result = await checkTui(page);
  assert.equal(result.controlled, id, 'Positive branch must execute');
  checks.push('Actual checkTui: menu display entry, settings, focus, unchanged native identities/dispatches, rejected invalid IPC');
  await page.screenshot({ path: path.join(pictures, '01-checked.png') });
  await application.close(); application = null;
  await launch();
  await verifyTui(page, result);
  checks.push('Actual verifyTui after normal owned GUI reopen: shared draft and display settings');
  await restoreTui(page, result);
  const restored = await snapshot();
  for (const key of ['selected', 'mode', 'preference']) assert.equal(restored.viewState[key], result.original[key]);
  assert.equal(restored.viewState.sharedDraft, result.original.sharedDraft || '');
  assert.deepEqual(restored.viewState.terminalDisplay, result.original.terminalDisplay || { fontSize: 14, palette: 'dark' });
  assert.deepEqual(restored.sessions.map(s => [s.id, s.nativeId]), initial.sessions.map(s => [s.id, s.nativeId]));
  checks.push('Actual restoreTui restores original selection/mode/preference/draft/display without replacing the session');
  const packet = await fixture(); assert.equal(packet.stats.inputs, 0); assert.equal(packet.stats.sends, 0);
  for (const key of ['input', 'send', 'queue', 'steer', 'forward', 'approve', 'answer', 'resume', 'pause']) assert.equal(packet.overviewCalls[key], 0, key);
  assert.deepEqual(errors, []); assert.deepEqual(hashes(), before);
  assert.ok(Date.now() - start < 120000, 'Active GUI cap');
  details = { controlled: id, stats: packet.stats, workspaceCalls: packet.overviewCalls, runCounter: 'LOCAL_START_RUN_ATTEMPTS_ONLY', original: result.original, saved: result.saved, restored: restored.viewState };
}
run().catch(async error => {
  failure = error.stack; process.exitCode = 1; console.error(failure);
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(pictures, 'failure.png') }).catch(() => {});
}).finally(async () => {
  try {
    await scratch.release();
    assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token);
    fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); cleaned = true;
  } catch (error) { process.exitCode = 1; console.error('Owned cleanup unconfirmed; lease retained', error.stack); }
  const result = { at: new Date().toISOString(), checks, details, failure, errors, guiPids, daemonPid: child?.pid, elapsedMs: Date.now() - start, sourceBefore: before, sourceAfter: hashes(), ownedCleanupConfirmed: cleaned, profileGone: profile ? !fs.existsSync(profile) : true, canonicalOwnTokenReleased: cleaned, scope: 'Owned source GUI / synthetic NativeHost only; no real provider, native input, model, OS clipboard or daily application actions. Full legacy desktop/crash/physical IME not qualified.' };
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
});
