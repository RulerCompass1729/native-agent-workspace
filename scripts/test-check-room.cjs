// Exercise the exported desktop room checks on two owned synthetic terminals.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), Module = require('node:module');
const { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const scratch = require('./fixtures/test-scratch.cjs'), { createIn } = require('./fixtures/create-view.cjs');
const { _electron } = scratch.playwright(require('playwright'));
const checksModule = require('./check-room.cjs');
const root = path.resolve(__dirname, '..'), version = require('../package.json').version;
assert.equal(process.env.NAW_CHECK_ROOM_GUI_AUTHORIZED, '1');
assert.ok(process.env.NAW_EVIDENCE_DIR && process.env.NAW_SCREENSHOTS_DIR);
const evidence = path.resolve(process.env.NAW_EVIDENCE_DIR), pictures = path.resolve(process.env.NAW_SCREENSHOTS_DIR);
for (const target of [evidence, pictures]) {
  let existing = target; while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const real = path.join(fs.realpathSync(existing), path.relative(existing, target));
  assert.ok(real !== root && !real.startsWith(root + path.sep), 'Evidence must be outside the repository');
}
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
fs.mkdirSync(pictures, { recursive: true, mode: 0o700 });
const files = ['scripts/check-room.cjs', 'scripts/test-check-room.cjs', 'scripts/fixtures/space-membership.cjs', 'app/renderer/renderer.js', 'app/dsh/client.js'];
const hashes = () => Object.fromEntries(files.map(n => [n, createHash('sha256').update(fs.readFileSync(path.join(root, n))).digest('hex')]));
const sourceBefore = hashes(), started = Date.now();
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) {
  if (error.code !== 'EEXIST') throw error;
  fs.writeFileSync(path.join(evidence, 'occupied.json'), JSON.stringify({ at: new Date().toISOString(), launches: 0 }));
  process.exit(75);
}
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex 3', task: 'T151 check-room', token, pid: process.pid, at: new Date().toISOString() }));
let profile, child, application, page, guiPid, sequence = 0, failure, baselineResult, candidateResult, details, restored = false, cleaned = false;
const checks = [], errors = [], snapshot = () => page.evaluate(() => workspace.initial());
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 160; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture() {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const listener = m => { if (m.requestId === id) { clearTimeout(timer); child.off('message', listener); resolve(m); } };
    const timer = setTimeout(() => { child.off('message', listener); reject(Error('Fixture timeout')); }, 8000);
    child.on('message', listener); child.send({ id, method: 'stats' });
  });
}
async function guard() {
  const state = await snapshot(); assert.equal(state.servicePid, child.pid); assert.equal(state.runtimeVersion, version); return state;
}
async function create(name, provider) {
  await guard(); // Never create a native record on a replacement service.
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => s.name === name && s.state === 'idle'), 'Owned synthetic session ready');
}
function baseline(file) {
  const filename = path.join(root, 'scripts/check-room.cjs'), m = new Module(filename, module);
  m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
  m._compile(fs.readFileSync(file, 'utf8'), filename); return m.exports;
}
async function run() {
  profile = scratch.directory(path.join(os.tmpdir(), 'naw-check-room-'));
  child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/collaboration-overview.cjs')], env: { ...process.env, NAW_APP_VERSION: version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: root }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned fake daemon');
  application = await _electron.launch({ executablePath: require('electron'), args: [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 30000 });
  guiPid = application.process().pid; page = await application.firstWindow(); page.setDefaultTimeout(4000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor(); await guard(); const first = await fixture(); assert.equal(first.stats.inputs, 0); assert.equal(first.stats.sends, 0);
  await create('Room synthetic A', 'claude'); await create('Room synthetic B', 'codex');
  await page.locator('#sessions-flat').click();
  // Since 3751738 a fresh profile hides 共同工作 until it has members or saved activity (renderer.js allSpaces), and
  // the shared-draft step below opens it before any session joins. Save shared notes first, before anything is measured.
  await page.evaluate(async () => { const shared = (await workspace.initial()).rooms.find(room => room.id === 'shared'); await workspace.spaceAction('shared', 'notes', ['T151 shared space in use', shared.metadataRevision]); });
  await page.locator('#room-nav').waitFor({ state: 'visible' });
  const before = await guard();
  assert.equal(before.sessions.length, 2);
  assert.ok(before.sessions.every(s => s.owner === before.owner && s.state === 'idle' && s.terminalAvailable && !s.roomId && !s.liveDraft && !s.messages.length));
  fs.writeFileSync(path.join(evidence, 'controlled-before.json'), JSON.stringify(before, null, 2));
  if (process.env.NAW_CHECK_ROOM_BASELINE) {
    const old = baseline(process.env.NAW_CHECK_ROOM_BASELINE); baselineResult = {};
    try { await old.checkRoom(page, application, baselineResult); throw Error('Old workflow unexpectedly passed'); }
    catch (error) {
      assert.equal(baselineResult.skipped, undefined, 'No empty-profile skip');
      assert.ok(baselineResult.changed && /Timeout/.test(error.message), 'Retain a real old workflow timeout');
      fs.writeFileSync(path.join(evidence, 'baseline-failure.txt'), error.stack + '\n');
      await page.screenshot({ path: path.join(pictures, '01-old-stopped.png') });
    }
    await old.restoreRoom(page, baselineResult);
    await until(async () => (await snapshot()).sessions.every(s => !s.roomId && s.owner === before.owner), 'Exact original test cleanup');
    checks.push('Original complete module enters the positive two-member branch and stops at a real timeout; original cleanup restores membership');
  }
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  const sharedDraft = 'T151 ORIGINAL UNSENT SHARED DRAFT';
  await page.locator('#shared-input').fill(sharedDraft);
  await until(async () => (await snapshot()).viewState.roomViews.shared.sharedDraft === sharedDraft, 'Owned shared draft saved');
  candidateResult = {};
  await checksModule.checkRoom(page, application, candidateResult);
  assert.equal(candidateResult.skipped, undefined); assert.equal(candidateResult.selected, before.sessions.at(-1).id);
  checks.push('Actual complete checkRoom: two terminals, records, explicit second-view takeover, leave stays in space, explicit same-session return, minimum window and theme');
  await page.reload(); await page.locator('#new-session').waitFor(); await guard();
  await checksModule.verifyRoom(page, candidateResult);
  checks.push('Actual verifyRoom after same-instance renderer reload; not normal app reopen');
  await checksModule.restoreRoom(page, candidateResult);
  restored = true;
  const after = await snapshot();
  assert.ok(after.sessions.every(s => !s.roomId && s.owner === before.owner));
  assert.deepEqual(after.sessions.map(s => [s.id, s.nativeId, s.pid, s.messages.length]), before.sessions.map(s => [s.id, s.nativeId, s.pid, s.messages.length]));
  assert.equal(after.viewState.roomViews.shared.sharedDraft, sharedDraft);
  checks.push('Actual restoreRoom and identity/owner/shared-draft invariants');
  const packet = await fixture(); assert.equal(packet.stats.inputs, 0); assert.equal(packet.stats.sends, 0);
  for (const key of ['input', 'send', 'queue', 'steer', 'forward', 'approve', 'answer', 'resume']) assert.equal(packet.overviewCalls[key], 0, key);
  assert.deepEqual(errors, []); assert.deepEqual(hashes(), sourceBefore); assert.ok(Date.now() - started < 150000);
  details = { stats: packet.stats, workspaceCalls: packet.overviewCalls, runCounter: 'UNINSTRUMENTED', sharedDraft, before, after };
}
run().catch(async error => {
  failure = error.stack; process.exitCode = 1; console.error(failure);
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(pictures, 'failure.png') }).catch(() => {});
}).finally(async () => {
  try {
    if (!restored && page && !page.isClosed() && candidateResult?.changed) await checksModule.restoreRoom(page, candidateResult);
  } catch (error) { process.exitCode = 1; console.error('Module restoration failed', error.stack); }
  try {
    await scratch.release(); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token);
    fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); cleaned = true;
  } catch (error) { process.exitCode = 1; console.error('Owned cleanup unconfirmed; exact lease retained', error.stack); }
  const result = { at: new Date().toISOString(), checks, details, errors, failure, baselineResult, candidateResult, guiPid, daemonPid: child?.pid, elapsedMs: Date.now() - started, sourceBefore, sourceAfter: hashes(), ownedCleanupConfirmed: cleaned, profileGone: profile ? !fs.existsSync(profile) : true, canonicalOwnTokenReleased: cleaned, scope: 'T151 owned source GUI and synthetic NativeHost, two records/one intentional extra view. No real provider/native CLI/input/model/send/clipboard/daily; reload is not normal reopen, installed not qualified.' };
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
});
