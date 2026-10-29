// Actual source Electron, DSH, IPC and Workspace; synthetic provider transport.
// Exercise both existing composer-clear paths without model or clipboard use.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process'), { once } = require('node:events');
const scratch = require('./fixtures/test-scratch.cjs');
const { fork } = scratch.childProcess, { _electron } = scratch.playwright(process.env.NAW_APP_EXECUTABLE ? { _electron: require('./fixtures/installed-renderer.cjs') } : require('playwright'));
const { chooseRecipient, fillRoomMessage } = require('./room-input.cjs');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const evidence = process.env.NAW_EVIDENCE_DIR;
if (evidence) {
  let parent = path.resolve(evidence); while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const target = path.join(fs.realpathSync(parent), path.relative(parent, path.resolve(evidence)));
  for (const folder of [root, code]) { const base = fs.realpathSync(folder); if (target === base || target.startsWith(base + path.sep)) throw Error('Evidence must be outside the repository'); }
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
}
const sourceFiles = ['app/renderer/renderer.js', 'app/room-mention.js', 'app/dsh/client.js'];
// The signed payload contains the built client, not this source-only renderer file.
const hashes = () => Object.fromEntries(sourceFiles.filter(file => !process.env.NAW_APP_EXECUTABLE || file !== 'app/renderer/renderer.js').map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(code, file))).digest('hex')]));
const sourceBefore = hashes();
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('GUI slot occupied; no GUI launched.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex2', task: 'T87 mention send', token, pid: process.pid, at: new Date().toISOString() }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-room-mention-send-'));
const cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd);
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { cwd, execArgv: ['--require', path.join(__dirname, 'fixtures/room-mention-send.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: cwd }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
const { connectService } = require(path.join(code, 'app/service-connection.cjs'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, page, client, a, b, sequence = 0;
const checks = [], errors = [];
async function until(fn, message) { for (let i = 0; i < 150; i++) { if (await fn()) return; await delay(50); } throw Error(message); }
function request(action, target, value) {
  const controlId = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Owned fixture reply timed out')); }, 10000);
    const receive = result => { if (result.controlId !== controlId) return; clearTimeout(timer); child.off('message', receive); result.error ? reject(Error(result.error)) : resolve(result); };
    child.on('message', receive); child.send({ method: 'mentionControl', controlId, action, target, value });
  });
}
function native(method = 'stats', fail = false) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Delayed transport reply timed out')); }, 10000);
    const receive = result => { if (result.requestId !== id) return; clearTimeout(timer); child.off('message', receive); resolve(result); };
    child.on('message', receive); child.send({ id, method, fail, reply: 'Synthetic complete reply.' });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
const input = () => page.locator('#shared-input');
async function capture(name) { if (evidence) { await page.screenshot({ path: path.join(evidence, name + '.png') }); fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(await snapshot(), null, 2)); } }
async function launch() {
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#shared-input').waitFor();
}
async function draft(id, text) { await input().fill(text); await chooseRecipient(page, id); }
async function sendAndWait(count) { await page.locator('#forward-button').click(); await until(async () => (await native()).sends.length === count, 'One exact directed dispatch'); }
async function cleared() {
  await until(async () => await input().inputValue() === '' && await page.locator('#recipient').inputValue() === '', 'Successful send clears BOTH address and body');
  await until(async () => { const view = (await snapshot()).viewState; return view.sharedDraft === '' && view.roomMention === null && view.roomRecipient === ''; }, 'Empty composer and no recipient authority persist');
}
async function queue(text) {
  await request('state', a, 'working'); await until(async () => (await snapshot()).sessions.find(s => s.id === a).state === 'working', 'Owned synthetic busy session');
  await draft(a, text); const raw = await input().inputValue();
  await until(async () => !(await page.locator('#forward-button').isDisabled()), 'Queue input enabled');
  await page.locator('#forward-button').click();
  await until(async () => (await snapshot()).sessions.find(s => s.id === a).pendingQueue, 'Actual Workspace persists queued input');
  await cleared(); return raw;
}
const check = text => { checks.push(text); console.log('PASS:', text); };
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned daemon ready'); client = await connectService(profile, 'mention-setup');
  a = await client.call('create', { provider: 'claude', cwd, name: 'Member A', view: 'chat' });
  b = await client.call('create', { provider: 'claude', cwd, name: 'Member B', view: 'chat' });
  await client.call('join', a, true); await client.call('join', b, true);
  const identities = (await client.call('initial')).sessions.map(s => ({ id: s.id, nativeId: s.nativeId }));
  fs.writeFileSync(path.join(profile, 'views.json'), JSON.stringify([{ owner: 'mention-view', active: true, selected: 'room', mode: 'chat' }]), { mode: 0o600 });
  await launch(); await page.locator('#room-record').click();
  await draft(a, 'Deliver this exact body.'); await sendAndWait(1); await native('release'); await cleared();
  assert.deepEqual((await native()).sends, [{ id: a, text: 'Deliver this exact body.' }]);
  assert.equal(await page.locator('#forward-button').isDisabled(), true); await capture('01-cleared');
  check('Choose Member A and send once: exact body delivered, address/body/recipient authority cleared together');
  await app.close(); app = null; await launch(); await cleared(); assert.equal((await native()).sends.length, 1);
  check('Ordinary owned GUI reopen preserves empty composer and never resends');
  await draft(a, 'Keep this failed draft.'); const failed = await input().inputValue(); await sendAndWait(2); await native('release', true);
  await until(() => page.locator('#toast').innerText().then(t => t.includes('Synthetic acceptance failure')), 'Failure is visible');
  assert.equal(await input().inputValue(), failed); assert.equal(await page.locator('#recipient').inputValue(), a); await capture('02-failed');
  check('Failed ordinary send keeps exact address, body and chosen recipient');
  await draft(a, 'Older pending message.'); await sendAndWait(3); await fillRoomMessage(page, 'Newer unsent body.'); const newer = await input().inputValue();
  await native('release'); await until(async () => !(await snapshot()).sessions.find(s => s.id === a).pendingTag, 'Old send settles');
  assert.equal(await input().inputValue(), newer); assert.equal(await page.locator('#recipient').inputValue(), a);
  check('Late successful acknowledgement preserves a newer draft for the same recipient');
  await draft(a, 'Another pending message.'); await sendAndWait(4); await draft(b, 'New recipient B draft.'); const other = await input().inputValue();
  await native('release'); await until(async () => !(await snapshot()).sessions.find(s => s.id === a).pendingTag, 'Earlier recipient settles');
  assert.equal(await input().inputValue(), other); assert.equal(await page.locator('#recipient').inputValue(), b); await capture('03-late-recipient');
  check('Late successful acknowledgement preserves a newer recipient and its exact draft');
  const queuedRaw = await queue('Known queue refusal.'); await request('settleQueue', a, true);
  await until(async () => await input().inputValue() === queuedRaw && await page.locator('#recipient').inputValue() === a, 'Proven not-sent restores untouched address/body');
  assert.equal((await snapshot()).room.messages.find(m => m.text === 'Known queue refusal.').status, 'not-sent'); await capture('04-queue-restored');
  check('Durable queued input clears both fields; proven not-sent restores the untouched original address/body');
  await queue('Older queue with newer draft.'); await draft(b, 'Keep new B draft after refusal.'); const afterQueue = await input().inputValue(); await request('settleQueue', a, true);
  await until(async () => !(await snapshot()).sessions.find(s => s.id === a).pendingQueue, 'Refused queue settles');
  assert.equal(await input().inputValue(), afterQueue); assert.equal(await page.locator('#recipient').inputValue(), b);
  check('A later queued refusal cannot restore over a newer recipient or draft');
  await queue('Accepted queued message.'); await request('settleQueue', a, false);
  await until(async () => (await snapshot()).room.messages.find(m => m.text === 'Accepted queued message.').status === 'submitted', 'Queued input accepted once'); await cleared();
  assert.equal((await request('stats')).queues.length, 3); assert.equal((await native()).sends.length, 4);
  assert.deepEqual((await snapshot()).sessions.map(s => ({ id: s.id, nativeId: s.nativeId })), identities);
  assert.deepEqual(errors, []); assert.deepEqual(hashes(), sourceBefore); await capture('05-final');
  check('Accepted queue stays empty without retry; both original native identities remain and no page errors occur');
  const result = { checks, errors, modelCalls: 0, nativeProviderProcesses: 0, ordinaryDispatches: 4, queuedAttempts: 3, identities, sourceBefore, sourceAfter: hashes(), profile };
  if (evidence) fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
const cleanup = scratch.cleanup(async () => { try { if (app) await app.close(); client?.close(); } finally { if (child.connected) child.disconnect(); if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } } });
run().catch(async error => { console.error(error.stack); process.exitCode = 1; if (page && !page.isClosed()) await capture('failure'); if (evidence) fs.writeFileSync(path.join(evidence, 'failure.txt'), error.stack); }).finally(async () => {
  try { await cleanup(); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); if (evidence) fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ token, releasedAt: new Date().toISOString(), profile, ownedCleanupConfirmed: true }, null, 2)); console.log('Owned fixture cleaned; canonical GUI token released.'); }
  catch (error) { console.error('Cleanup unconfirmed; own lock retained:', error.stack); process.exitCode = 1; }
});
