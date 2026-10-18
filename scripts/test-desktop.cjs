// Headed lifecycle regression. Reuses one private test profile on every run.
// No model prompts, new native sessions, login changes, or global process kills.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { _electron } = require('playwright');
const { connect } = require('../app/service-client.cjs');
const root = path.resolve(__dirname, '..');
const executablePath = process.env.NAW_APP_EXECUTABLE || require('electron');
const launchArgs = process.env.NAW_APP_EXECUTABLE ? [] : [root];
const dataDir = path.resolve(process.env.NAW_DOGFOOD_DIR || path.join(os.tmpdir(), 'native-agent-workspace-dogfood'));
const lock = path.join(dataDir, 'test-driver.json');
const hostFile = path.join(dataDir, 'ui-host.json');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } }
async function until(predicate, message, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(100); }
  throw new Error(message);
}
let application, page, ownsLock = false, stopping = false, testDraft;
const draftText = 'Lifecycle test draft\n中文草稿：不发送，不调用模型。';
async function launch(earlyQuit = false) {
  if (application) throw new Error('Close the existing test UI before launching another.');
  application = await _electron.launch({ executablePath, args: launchArgs, env: { ...process.env, NAW_DATA_DIR: dataDir, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await application.firstWindow();
  if (earlyQuit) return;
  await page.locator('#start-claude').waitFor({ state: 'attached' });
  await page.waitForLoadState('load');
  return page.evaluate(() => workspace.initial());
}
async function closeUI() {
  if (!application) return;
  const old = application; application = null;
  let timer;
  try {
    await Promise.race([old.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Test UI did not close cleanly')), 10000); })]);
  } catch (error) {
    // This exact process was launched by this runner. Never kill by app name.
    if (old.process().exitCode === null && old.process().signalCode === null) old.process().kill('SIGKILL');
    throw error;
  } finally { clearTimeout(timer); }
}
function identity(state) { return state.sessions.map(s => ({ id: s.id, nativeId: s.nativeId, pid: s.pid, state: s.state })); }
function drafts(state) { return state.sessions.map(s => ({ id: s.id, text: s.liveDraft })); }
async function cleanup() {
  if (stopping) return; stopping = true;
  if (!ownsLock) return;
  try { await closeUI(); }
  finally {
    // The service enforces that shutdown cannot terminate any live native session.
    try {
      const c = await connect(dataDir, 'desktop-test-cleanup');
      try {
        const s = await c.call('initial');
        if (testDraft && s.sessions.find(x => x.id === testDraft)?.liveDraft === draftText) await c.call('draft', testDraft, '');
        if (s.sessions.every(x => x.state === 'ended')) await c.call('shutdown');
        else console.log('Kept the existing native sessions running.');
      } finally { c.close(); }
    } catch (e) { if (e.code !== 'ENOENT') console.log('Native service cleanup was not confirmed; no PID was killed.'); }
    if (ownsLock) {
      try { if (JSON.parse(fs.readFileSync(lock, 'utf8')).pid === process.pid) fs.rmSync(lock); } catch {}
    }
  }
}
async function run() {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (fs.statSync(dataDir).uid !== process.getuid()) throw new Error('Test profile belongs to a different user.');
  fs.chmodSync(dataDir, 0o700);
  if (fs.existsSync(lock)) {
    const old = JSON.parse(fs.readFileSync(lock, 'utf8'));
    if (!Number.isSafeInteger(old.pid) || old.pid <= 1 || alive(old.pid)) throw new Error('A desktop test already owns this profile, or its record is invalid. Do not start another.');
    fs.rmSync(lock);
  }
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 }); ownsLock = true;
  let before = await launch();
  await page.locator('#setup-button').click();
  await page.locator('#setup-dialog').waitFor({ state: 'visible' });
  assert.match(await page.locator('#version-info').innerText(), /应用/);
  await page.locator('#close-setup').click();
  console.log('PASS: packaged/source UI composition and setup screen render.');
  const selected = before.sessions.find(s => s.id === before.viewState.selected);
  if (selected && selected.owner === before.owner && selected.state === 'idle' && !selected.liveDraft && !before.room.run) {
    testDraft = selected.id;
    await page.locator('#chat-tab').click();
    await page.locator('#message-input').fill(draftText);
    await until(async () => (await page.evaluate(() => workspace.initial())).sessions.find(s => s.id === testDraft).liveDraft === draftText, 'Draft was not saved');
    if (before.viewState.mode === 'terminal') await page.locator('#terminal-tab').click();
    before = await page.evaluate(() => workspace.initial());
  }
  const savedView = before.viewState;
  const host = JSON.parse(fs.readFileSync(hostFile, 'utf8'));
  const competingTest = spawn(process.execPath, [__filename], { env: { ...process.env, NAW_DOGFOOD_DIR: dataDir }, stdio: 'ignore' });
  try {
    await until(() => competingTest.exitCode !== null, 'Competing test launcher did not exit');
    assert.equal(competingTest.exitCode, 1);
    assert.equal(JSON.parse(fs.readFileSync(hostFile, 'utf8')).pid, host.pid);
    assert.deepEqual(identity(await page.evaluate(() => workspace.initial())), identity(before));
    console.log('PASS: a second test runner is refused without touching the first.');
  } finally { if (competingTest.exitCode === null && competingTest.signalCode === null) competingTest.kill('SIGTERM'); }
  const duplicate = spawn(executablePath, launchArgs, { env: { ...process.env, NAW_DATA_DIR: dataDir }, stdio: 'ignore' });
  try {
    await until(() => duplicate.exitCode !== null, 'Duplicate application did not exit');
    assert.equal(duplicate.exitCode, 0);
    assert.equal(application.windows().length, 1);
    assert.equal(JSON.parse(fs.readFileSync(hostFile, 'utf8')).pid, host.pid);
    console.log('PASS: repeated launch focuses one UI and retains one DSH host.');
  } finally { if (duplicate.exitCode === null && duplicate.signalCode === null) duplicate.kill('SIGTERM'); }
  if (selected) {
    const opened = application.waitForEvent('window');
    await page.locator('#header-actions').getByRole('button', { name: '独立窗口', exact: true }).click();
    const second = await opened;
    await second.locator('#terminal-tab').waitFor({ state: 'visible' });
    assert.equal(application.windows().length, 2);
    assert.equal(JSON.parse(fs.readFileSync(hostFile, 'utf8')).pid, host.pid);
    assert.deepEqual(identity(await second.evaluate(() => workspace.initial())), identity(before));
    await second.close();
    assert.equal(application.windows().length, 1);
    console.log('PASS: explicitly opening a second view shares the same service and sessions.');
  }
  await closeUI();
  await until(() => !alive(host.pid), 'DSH host survived normal UI exit');
  const reopened = await launch();
  assert.deepEqual(identity(reopened), identity(before));
  assert.equal(reopened.viewState.selected, savedView.selected);
  assert.equal(reopened.viewState.mode, savedView.mode);
  assert.deepEqual(drafts(reopened), drafts(before));
  console.log('PASS: normal reopen preserves native identities, view, and drafts.');
  const crashedHost = JSON.parse(fs.readFileSync(hostFile, 'utf8'));
  const crashed = application; application = null;
  crashed.process().kill('SIGKILL');
  await until(() => !alive(crashedHost.pid), 'DSH host survived desktop crash');
  const recovered = await launch();
  assert.deepEqual(identity(recovered), identity(before));
  assert.equal(recovered.viewState.selected, savedView.selected);
  assert.equal(recovered.viewState.mode, savedView.mode);
  assert.deepEqual(drafts(recovered), drafts(before));
  console.log('PASS: crashed UI host exits; reopening reconnects to the same native sessions.');
  await closeUI();
  await launch(true);
  let earlyHost; try { earlyHost = JSON.parse(fs.readFileSync(hostFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await closeUI();
  await until(() => !earlyHost || !alive(earlyHost.pid), 'DSH host survived closing a loading window');
  const final = await launch();
  assert.deepEqual(identity(final), identity(before));
  assert.deepEqual(drafts(final), drafts(before));
  console.log('PASS: quitting during page load closes cleanly without a fatal dialog.');
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => cleanup().finally(() => process.exit(130)));
run().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(cleanup);
