// Exact routing error -> visible recovery/cancel -> one same-thread continue.
// Actual source Electron/daemon/Codex adapter; zero inference/provider processes.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process'), { once } = require('node:events');
const scratch = require('./fixtures/test-scratch.cjs');
const { fork } = scratch.childProcess, { _electron } = scratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const evidence = process.env.NAW_EVIDENCE_DIR;
if (evidence) {
  let parent = path.resolve(evidence); while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const target = path.join(fs.realpathSync(parent), path.relative(parent, path.resolve(evidence)));
  for (const folder of [root, code]) { const base = fs.realpathSync(folder); if (target === base || target.startsWith(base + path.sep)) throw Error('Evidence must be outside the repository'); }
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
}
const hashes = () => Object.fromEntries(['app/adapters.cjs', 'app/workspace.cjs', 'app/renderer/renderer.js', 'app/dsh/client.js'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(code, file))).digest('hex')]));
const sourceBefore = hashes(), common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('GUI slot occupied; no GUI launched.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex2', task: 'T103 routing recovery', token, pid: process.pid, at: new Date().toISOString() }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-routing-recovery-'));
const cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd);
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { cwd, execArgv: ['--require', path.join(__dirname, 'fixtures/routing-recovery.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: cwd }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
const { connectService } = require(path.join(code, 'app/service-connection.cjs'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, page, client, a, b, sequence = 0;
const checks = [], errors = [], routingError = 'workspace routing discovery timed out';
async function until(fn, message) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(message); }
function native(method = 'stats', extra = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Owned fixture reply timed out')); }, 5000);
    const receive = result => { if (result.requestId !== id || method === 'advanceRecovery' && !Object.hasOwn(result, 'advanced')) return; clearTimeout(timer); child.off('message', receive); resolve(result); };
    child.on('message', receive); child.send({ id, method, ...extra });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
const session = async id => (await snapshot()).sessions.find(s => s.id === id);
async function capture(name) { if (evidence) { await page.screenshot({ path: path.join(evidence, name + '.png') }); fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(await snapshot(), null, 2)); } }
async function launch() {
  app = await _electron.launch({ executablePath: require('electron'), args: [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
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
async function fail(message = routingError) {
  const s = await session(a); assert.ok(s.activeTurnId);
  await native('event', { target: a, value: { method: 'turn/completed', params: { threadId: s.nativeId, turn: { id: s.activeTurnId, status: 'failed', error: { message, codexErrorInfo: 'other' } } } } });
}
function check(text) { checks.push(text); console.log('PASS:', text); }
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned daemon ready'); client = await connectService(profile, 'routing-setup');
  a = await client.call('create', { provider: 'codex', cwd, name: 'Routing A', view: 'chat' });
  // The shared synthetic fixture creates a new RPC object per session. Finish
  // its first attachment before creating the next; production shares one RPC.
  await until(async () => (await client.call('initial')).sessions.find(s => s.id === a).chatAvailable, 'First synthetic attachment');
  b = await client.call('create', { provider: 'codex', cwd, name: 'Independent B', view: 'chat' });
  await until(async () => (await client.call('initial')).sessions.every(s => s.chatAvailable), 'Actual adapter attached');
  await launch(); await select(b); await page.locator('#message-input').fill('B unsent draft');
  await until(async () => (await session(b)).liveDraft === 'B unsent draft', 'Independent draft saved');
  await select(a); await send('First exact routing task.', 1);
  const before = await snapshot(), identities = before.sessions.map(s => ({ id: s.id, nativeId: s.nativeId, owner: s.owner }));
  await fail(); await until(async () => (await session(a)).capacityRecovery?.reason === 'routing', 'Exact terminal routing failure schedules recovery');
  assert.ok((await session(a)).capacityRecovery.due - Date.now() > 110000);
  await until(async () => (await page.locator('#native-phase').innerText()).includes('路由发现超时'), 'Honest routing phase label');
  await until(async () => (await page.locator('#messages').innerText()).includes(routingError), 'Original native routing error rendered'); await capture('01-routing-scheduled');
  check('Actual terminal event retains original text, shows routing reason and production two-minute schedule');
  await page.getByRole('button', { name: '取消自动继续', exact: true }).click();
  await until(async () => !(await session(a)).capacityRecovery, 'Human cancel removes recovery');
  await page.locator('#message-input').fill('A human draft after cancellation');
  await until(async () => (await session(a)).liveDraft === 'A human draft after cancellation', 'Human draft saved');
  await native('advanceRecovery', { target: a });
  assert.equal((await native()).sends.length, 1); assert.equal((await session(a)).liveDraft, 'A human draft after cancellation'); await capture('02-cancelled');
  check('Visible cancel preserves the new human draft and sends no automatic input');
  await send('Second exact routing task.', 2); await fail();
  await until(async () => (await session(a)).capacityRecovery?.reason === 'routing', 'Second exact failure schedules recovery');
  assert.equal((await native('advanceRecovery', { target: a })).advanced, true);
  await until(async () => (await native()).sends.length === 3, 'One bounded continuation');
  const stats = await native(); assert.deepEqual(stats.sends.map(s => s.text), ['First exact routing task.', 'Second exact routing task.', '继续']);
  await native('release', { target: a, text: 'Recovered same native thread.' });
  await until(async () => (await session(a)).state === 'idle' && !(await session(a)).capacityRecovery, 'Continuation completed and recovery cleared');
  await until(async () => (await page.locator('#messages').innerText()).includes('Recovered same native thread.'), 'Completed native reply rendered'); assert.equal((await session(b)).liveDraft, 'B unsent draft');
  assert.deepEqual((await snapshot()).sessions.map(s => ({ id: s.id, nativeId: s.nativeId, owner: s.owner })), identities); await capture('03-continued');
  check('One literal continue completes on the same native identity/owner, preserving independent B draft');
  await app.close(); app = null; await launch(); await select(a);
  assert.equal((await native()).sends.length, 3); await until(async () => (await page.locator('#messages').innerText()).includes('Recovered same native thread.'), 'Completed reply rendered after reopen');
  await send('Unrelated failure task.', 4); await fail('Unrelated native Other failure');
  await until(async () => (await session(a)).state === 'idle', 'Unrelated native failure completes'); assert.equal((await session(a)).capacityRecovery, null);
  await until(async () => (await page.locator('#messages').innerText()).includes('Unrelated native Other failure'), 'Unrelated original error rendered'); assert.equal((await native()).sends.length, 4); await capture('04-other-not-retried');
  check('Reopen retains completion without replay; unrelated Other error remains readable with no automatic retry');
  assert.deepEqual(errors, []); assert.deepEqual(hashes(), sourceBefore);
  const final = await native(); assert.equal(final.modelCalls, 0); assert.equal(final.nativeProcesses, 0);
  const result = { checks, errors, modelCalls: 0, nativeProviderProcesses: 0, syntheticDispatches: 4, identities, sourceBefore, sourceAfter: hashes(), profile };
  if (evidence) fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
}
const cleanup = scratch.cleanup(async () => { try { if (app) await app.close(); client?.close(); } finally { if (child.connected) child.disconnect(); if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } } });
run().catch(async error => { console.error(error.stack); process.exitCode = 1; if (page && !page.isClosed()) await capture('failure'); if (evidence) fs.writeFileSync(path.join(evidence, 'failure.txt'), error.stack); }).finally(async () => {
  try { await cleanup(); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); if (evidence) fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ token, releasedAt: new Date().toISOString(), profile, ownedCleanupConfirmed: true }, null, 2)); console.log('Owned fixture cleaned; canonical GUI token released.'); }
  catch (error) { console.error('Cleanup unconfirmed; own lock retained:', error.stack); process.exitCode = 1; }
});
