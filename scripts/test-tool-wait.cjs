// Explicit Main GUI handoff required before invocation. Real source Electron/
// daemon/renderer; synthetic provider and pre-main Notification replacement.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process'), { once } = require('node:events');
const scratch = require('./fixtures/test-scratch.cjs'), { fork } = scratch.childProcess;
const { _electron } = scratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), fixtureFile = path.join(__dirname, 'fixtures/tool-wait.cjs');
const evidence = process.env.NAW_EVIDENCE_DIR;
if (evidence) {
  const target = path.resolve(evidence); let existing = target;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const real = path.join(fs.realpathSync(existing), path.relative(existing, target));
  if (real === fs.realpathSync(root) || real.startsWith(fs.realpathSync(root) + path.sep)) throw Error('GUI evidence must be outside the repository');
  fs.mkdirSync(real, { recursive: true, mode: 0o700 });
}
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const lock = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(lock); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; no profile or process launched.'); process.exit(75); }
fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ owner: 'Codex2', task: 'T103 tool-wait source GUI', token, pid: process.pid, at: new Date().toISOString() }));
const hashes = () => Object.fromEntries(['app/adapters.cjs', 'app/workspace.cjs', 'app/main.cjs', 'app/renderer/renderer.js', 'app/dsh/client.js', 'scripts/fixtures/tool-wait.cjs'].map(f => [f, createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex')]));
const sourceBefore = hashes(), profile = scratch.directory(path.join(os.tmpdir(), 'naw-tool-wait-'));
const cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd);
// Source Electron ignores NODE_OPTIONS here. Use an explicit entry with the
// real app version, installing the guards before requiring production Main.
const sourceApp = path.join(profile, 'source-app'); fs.mkdirSync(sourceApp);
fs.writeFileSync(path.join(sourceApp, 'package.json'), JSON.stringify({ name: 'naw-tool-wait-source', version: require('../package.json').version, main: 'entry.cjs' }));
fs.writeFileSync(path.join(sourceApp, 'entry.cjs'), `require(${JSON.stringify(fixtureFile)});\nif (!Array.isArray(globalThis.toolWaitNotificationRequests)) throw Error('Notification guard missing before Main');\nrequire(${JSON.stringify(path.join(root, 'app/main.cjs'))});\n`);
const child = fork(path.join(root, 'app/daemon.cjs'), [profile], { cwd, execArgv: ['--require', fixtureFile], env: { ...process.env, NODE_OPTIONS: '', NAW_TOOL_WAIT_DAEMON_FIXTURE: '1', NAW_APP_VERSION: require('../package.json').version, NAW_WORKSPACE: cwd, NAW_TEST_APP_ROOT: root }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
const { connectService } = require('../app/service-connection.cjs');
let app, page, client, id, sequence = 0; const errors = [], checks = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, message) { for (let i = 0; i < 150; i++) { if (await fn()) return; await delay(40); } throw Error(message); }
function fixture(method = 'stats', target, value) {
  const requestId = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Owned fixture timeout')); }, 5000);
    const receive = result => { if (result.requestId !== requestId) return; clearTimeout(timer); child.off('message', receive); resolve(result); };
    child.on('message', receive); child.send({ id: requestId, method, target, value });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
const requests = () => app.evaluate(() => globalThis.toolWaitNotificationRequests);
const stable = s => [s.id, s.nativeId, s.pid, s.owner, s.liveDraft, s.controlRevision, s.memberRevision];
async function capture(name) { if (evidence && page && !page.isClosed()) { await page.screenshot({ path: path.join(evidence, name + '.png') }); fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify({ state: await snapshot(), notificationRequests: await requests(), fixtureStats: await fixture(), checks }, null, 2)); } }
function pass(text) { checks.push(text); console.log('PASS:', text); }
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned daemon ready'); client = await connectService(profile, 'tool-wait-setup');
  app = await _electron.launch({ executablePath: require('electron'), args: [sourceApp], env: { ...process.env, NODE_OPTIONS: '', NAW_TOOL_WAIT_DAEMON_FIXTURE: '', NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  assert.deepEqual(await requests(), [], 'Notification replacement must be installed before any tool starts');
  assert.equal((await snapshot()).servicePid, child.pid, 'Only the explicitly instrumented owned daemon may serve the GUI');
  if (evidence) fs.writeFileSync(path.join(evidence, 'owned-processes.json'), JSON.stringify({ daemon: child.pid, electron: app.process().pid, profile, sourceApp }, null, 2));
  id = await client.call('create', { provider: 'codex', cwd, name: 'Original tool-wait task', view: 'chat' });
  await page.locator(`[data-session-id="${id}"]`).click();
  await page.locator('#chat-tab').click();
  await until(async () => (await fixture()).pending.includes(id), 'Original terminal display'); await fixture('release', id);
  if (await page.locator('#take-control').isVisible()) await page.locator('#take-control').click();
  await until(() => page.locator('#message-input').evaluate(el => !el.readOnly), 'Explicit control available');
  await page.locator('#message-input').fill('Continue this original synthetic task'); await page.locator('#send-button').click();
  await until(async () => (await fixture()).sends.length === 1, 'One original task accepted');
  await fixture('tool-wait-start', id); await page.locator('#message-input').fill('Original unsent next draft');
  await until(async () => (await snapshot()).sessions.find(s => s.id === id).liveDraft === 'Original unsent next draft', 'Draft saved');
  const before = stable((await snapshot()).sessions.find(s => s.id === id));
  await fixture('tool-wait-age', id);
  await until(() => page.locator('#native-phase').innerText().then(text => text.includes('较长时间未收到工具进展')), 'Visible original status advisory');
  await until(async () => (await requests()).length === 1, 'One main-process notification request'); await capture('01-quiet-tool-warning');
  assert.equal((await snapshot()).sessions.find(s => s.id === id).state, 'working');
  assert.equal((await requests())[0].title, 'NAW · 工具等待提醒');
  pass('A quiet live tool produces a visible advisory and one intercepted notification while native work remains working');
  await fixture('tool-wait-tick', id); await fixture('tool-wait-tick', id); assert.equal((await requests()).length, 1);
  await fixture('tool-wait-progress', id);
  await until(() => page.locator('#native-phase').innerText().then(text => !text.includes('较长时间未收到工具进展')), 'New progress clears advisory');
  await fixture('tool-wait-age', id); await until(() => page.locator('#native-phase').innerText().then(text => text.includes('较长时间未收到工具进展')), 'A later quiet interval is visible');
  assert.equal((await requests()).length, 1, 'No repeated OS request for the same native turn'); pass('Progress clears the warning; a later quiet interval never repeats the same-turn notification');
  assert.deepEqual(stable((await snapshot()).sessions.find(s => s.id === id)), before);
  const stats = await fixture(); assert.deepEqual(stats.inputs, []); assert.equal(stats.sends.length, 1); assert.deepEqual(stats.interruptions, []);
  await fixture('complete', id, { text: 'Original task completed' });
  await until(async () => (await snapshot()).sessions.find(s => s.id === id).state === 'idle', 'Original completion');
  await until(() => page.locator('#native-activity').isHidden(), 'Completion clears original status');
  assert.deepEqual(stable((await snapshot()).sessions.find(s => s.id === id)), before); pass('Completion retains original identity, owner and draft with zero warning-induced native input, retry or interrupt');
  await capture('02-completed-original-task'); assert.deepEqual(errors, []); assert.deepEqual(hashes(), sourceBefore);
  assert.equal((await snapshot()).servicePid, child.pid);
  if (evidence) fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ checks, errors, sourceBefore, sourceAfter: hashes(), notificationRequests: await requests(), osNotifications: 'MOCKED before main load; no real OS delivery qualification', productModels: 0, realProviders: 0, originalSyntheticSends: 1, automaticSends: 0, nativeInputs: 0, interrupts: 0, profile, actualNativePid: 'synthetic null; not real PID retention proof' }, null, 2));
}
const cleanup = scratch.cleanup(async () => { try { if (app) await app.close(); client?.close(); } finally { if (child.connected) child.disconnect(); if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } } });
run().catch(async error => { console.error(error.stack); process.exitCode = 1; if (page && !page.isClosed()) await capture('failure'); if (evidence) fs.writeFileSync(path.join(evidence, 'failure.txt'), error.stack); }).finally(async () => {
  try { await cleanup(); assert.equal(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'))).token, token); fs.unlinkSync(path.join(lock, 'owner.json')); fs.rmdirSync(lock); if (evidence) fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ profile, token, cleaned: true, releasedAt: new Date().toISOString() }, null, 2)); console.log('Exact owned profile/processes cleaned and GUI token released.'); }
  catch (e) { console.error('Own cleanup unconfirmed; own token retained:', e.message); process.exitCode = 1; }
});
