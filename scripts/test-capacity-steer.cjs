// Accepted steer -> terminal overload before ACK -> bounded continue, human stop.
// Actual source Electron/daemon/Codex adapter; zero inference/provider processes.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process'), { once } = require('node:events');
const scratch = require('./fixtures/test-scratch.cjs');
const { fork } = scratch.childProcess, { _electron } = scratch.playwright(process.env.NAW_APP_EXECUTABLE ? { _electron: require('./fixtures/installed-renderer.cjs') } : require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const evidence = process.env.NAW_EVIDENCE_DIR;
if (evidence) {
  let parent = path.resolve(evidence); while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const target = path.join(fs.realpathSync(parent), path.relative(parent, path.resolve(evidence)));
  for (const folder of [root, code]) { const base = fs.realpathSync(folder); if (target === base || target.startsWith(base + path.sep)) throw Error('Evidence must be outside the repository'); }
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
}
const hashes = () => Object.fromEntries(['app/adapters.cjs', 'app/workspace.cjs', 'app/renderer/renderer.js', 'app/dsh/client.js'].filter(file => !process.env.NAW_APP_EXECUTABLE || file !== 'app/renderer/renderer.js').map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(code, file))).digest('hex')]));
const sourceBefore = hashes(), common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('GUI slot occupied; no GUI launched.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex2', task: 'T110 capacity steer recovery', token, pid: process.pid, at: new Date().toISOString() }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-capacity-steer-'));
const cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd);
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { cwd, execArgv: ['--require', path.join(__dirname, 'fixtures/capacity-steer.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: cwd }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
const { connectService } = require(path.join(code, 'app/service-connection.cjs'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, page, client, a, b, sequence = 0;
const checks = [], errors = [];
async function until(fn, message) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(message); }
function native(method = 'stats', extra = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Owned fixture reply timed out')); }, 5000);
    const receive = result => { if (result.requestId !== id || method === 'advanceRecovery' && !Object.hasOwn(result, 'advanced') || ['steerStats', 'settleSteer'].includes(method) && !result.steerFixture) return; clearTimeout(timer); child.off('message', receive); resolve(result); };
    child.on('message', receive); child.send({ id, method, ...extra });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
const session = async id => (await snapshot()).sessions.find(s => s.id === id);
async function capture(name) { if (evidence) { await page.screenshot({ path: path.join(evidence, name + '.png') }); fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(await snapshot(), null, 2)); } }
async function launch() {
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
}
async function select(id) {
  await page.locator(`[data-session-id="${id}"]`).click(); await page.locator('#chat-tab').click();
  // These owned fixture sessions were created by the setup client, so take
  // control through the same explicit UI action available to the user.
  if (await page.locator('#take-control').isVisible()) await page.locator('#take-control').click();
  await until(() => page.locator('#message-input').evaluate(el => !el.readOnly), 'Owned GUI control');
}
async function send(text, count) { await page.locator('#message-input').fill(text); await page.locator('#send-button').click(); await until(async () => (await native()).sends.length === count, 'Exactly one new task'); }
function check(text) { checks.push(text); console.log('PASS:', text); }
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned daemon ready'); client = await connectService(profile, 'capacity-steer-setup');
  a = await client.call('create', { provider: 'codex', cwd, name: 'Capacity A', view: 'chat' });
  await until(async () => (await client.call('initial')).sessions.find(s => s.id === a).chatAvailable, 'First adapter attached');
  b = await client.call('create', { provider: 'codex', cwd, name: 'Independent B', view: 'chat' });
  await until(async () => (await client.call('initial')).sessions.every(s => s.chatAvailable), 'Both adapters attached');
  await launch(); await select(b); await page.locator('#message-input').fill('B unsent draft');
  await until(async () => (await session(b)).liveDraft === 'B unsent draft', 'B draft saved'); await select(a);
  const identities = (await snapshot()).sessions.map(s => ({ id: s.id, nativeId: s.nativeId, owner: s.owner }));
  async function overloadBeforeAck(text, count) {
    await send(text + ' original.', count);
    await page.locator('#message-input').fill(text + ' refinement.');
    await until(async () => (await session(a)).liveDraft === text + ' refinement.', 'Steer draft saved');
    await page.getByRole('button', { name: '追加指令 ↑', exact: true }).click();
    await until(async () => (await native('steerStats')).held.includes(a), 'Actual turn/steer RPC held');
    const row = await session(a);
    await native('event', { target: a, value: { method: 'turn/completed', params: { threadId: row.nativeId, turn: { id: row.activeTurnId, status: 'failed', error: { message: 'Synthetic typed capacity failure', codexErrorInfo: 'serverOverloaded' } } } } });
    assert.equal((await session(a)).capacityRecovery, null, 'No recovery while native input is unsettled');
  }
  await overloadBeforeAck('First', 1); await native('settleSteer', { target: a });
  await until(async () => (await session(a)).capacityRecovery?.reason === 'capacity' && !(await session(a)).pendingSteer, 'Confirmed input cleanup admits capacity recovery');
  assert.equal((await session(a)).liveDraft, '');
  assert.ok((await session(a)).capacityRecovery.due - Date.now() > 110000);
  await until(async () => (await page.locator('#native-phase').innerText()).includes('模型满载'), 'Visible capacity countdown');
  await until(async () => (await page.locator('#messages').innerText()).includes('Synthetic typed capacity failure'), 'Original native error visible'); await capture('01-scheduled');
  check('Steer accepted after terminal overload retains original error, clears only its own draft and shows the production two-minute recovery');
  assert.equal((await native('advanceRecovery', { target: a })).advanced, true);
  await until(async () => (await native()).sends.length === 2, 'One new continuation');
  await native('release', { target: a, text: 'Same native work completed after bounded continuation.' });
  await until(async () => (await session(a)).state === 'idle' && !(await session(a)).capacityRecovery, 'Continuation finishes');
  await until(async () => (await page.locator('#messages').innerText()).includes('Same native work completed'), 'Result visible'); await capture('02-continued');
  check('One literal continue finishes on the original identity without replaying the accepted refinement');
  await overloadBeforeAck('Second', 3);
  await page.locator('#message-input').fill('New human draft after failure');
  await until(async () => (await session(a)).liveDraft === 'New human draft after failure', 'New human draft saved before ACK');
  await native('settleSteer', { target: a });
  await until(async () => !(await session(a)).pendingSteer && !(await session(a)).activeTurnId, 'Second turn settles');
  assert.equal((await session(a)).capacityRecovery, null); await native('advanceRecovery', { target: a });
  assert.equal((await native()).sends.length, 3); assert.equal((await session(a)).liveDraft, 'New human draft after failure'); await capture('03-human-stopped');
  check('A later human edit survives the late ACK and prevents any automatic continuation');
  await overloadBeforeAck('Third', 4); await native('settleSteer', { target: a, rejected: true });
  await until(async () => !(await session(a)).pendingSteer && !(await session(a)).activeTurnId, 'Uncertain input turn settles');
  assert.equal((await session(a)).capacityRecovery, null); await native('advanceRecovery', { target: a });
  assert.equal((await session(a)).liveDraft, 'Third refinement.');
  const steered = (await session(a)).messages.filter(m => m.inputMode === 'steer');
  assert.deepEqual(steered.map(m => m.status), ['submitted', 'submitted', 'unconfirmed']); await capture('04-uncertain-stopped');
  check('Lost native receipt keeps the exact draft and uncertain record; never resends either the refinement or continue');
  await app.close(); app = null; await launch(); await select(a);
  await until(async () => (await page.locator('#messages').innerText()).includes('Same native work completed'), 'Result after window reopen');
  assert.equal((await session(a)).liveDraft, 'Third refinement.'); assert.equal((await session(b)).liveDraft, 'B unsent draft');
  assert.deepEqual((await snapshot()).sessions.map(s => ({ id: s.id, nativeId: s.nativeId, owner: s.owner })), identities);
  const final = await native(), steerStats = await native('steerStats');
  assert.deepEqual(final.sends.map(s => s.text), ['First original.', '继续', 'Second original.', 'Third original.']);
  assert.equal(steerStats.calls.length, 3); assert.equal(final.inputs.length, 0); assert.equal(final.decisions.length, 0);
  assert.equal(final.modelCalls, 0); assert.equal(final.nativeProcesses, 0); assert.deepEqual(errors, []); assert.deepEqual(hashes(), sourceBefore);
  check('Reopen preserves both native IDs, owners, independent draft and original receipts without replay');
  const result = { checks, errors, modelCalls: 0, nativeProviderProcesses: 0, syntheticOriginalTasks: 3, syntheticAutomaticContinue: 1, steerCalls: steerStats.calls, stats: final, identities, sourceBefore, sourceAfter: hashes(), profile };
  if (evidence) fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
}
const cleanup = scratch.cleanup(async () => { try { if (app) await app.close(); client?.close(); } finally { if (child.connected) child.disconnect(); if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } } });
run().catch(async error => { console.error(error.stack); process.exitCode = 1; if (page && !page.isClosed()) await capture('failure'); if (evidence) fs.writeFileSync(path.join(evidence, 'failure.txt'), error.stack); }).finally(async () => {
  try { await cleanup(); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); if (evidence) fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ token, releasedAt: new Date().toISOString(), profile, ownedCleanupConfirmed: true }, null, 2)); console.log('Owned fixture cleaned; canonical GUI token released.'); }
  catch (error) { console.error('Cleanup unconfirmed; own lock retained:', error.stack); process.exitCode = 1; }
});
