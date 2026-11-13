// A Claude request refused with a typed 403 -> visible reason and schedule -> three bounded continuations -> the
// limit notice that mentions signing in again. A 401 is left alone.
// Shipped Electron, daemon, workspace and Claude adapter decision; synthetic transport, zero provider processes.
// NAW_TEST_UI_LANGUAGE=zh|en chooses the interface language; NAW_EVIDENCE_DIR keeps screenshots.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process'), { once } = require('node:events');
const scratch = require('./fixtures/test-scratch.cjs');
const { fork } = scratch.childProcess, { _electron } = scratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const evidence = process.env.NAW_EVIDENCE_DIR, language = process.env.NAW_TEST_UI_LANGUAGE || 'zh';
assert.ok(['zh', 'en'].includes(language), 'The interface language is zh or en');
assert.ok(!process.env.NAW_APP_EXECUTABLE, 'The notification stand-in is source-only');
if (evidence) {
  let parent = path.resolve(evidence); while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const target = path.join(fs.realpathSync(parent), path.relative(parent, path.resolve(evidence)));
  for (const folder of [root, code]) { const base = fs.realpathSync(folder); if (target === base || target.startsWith(base + path.sep)) throw Error('Evidence must be outside the repository'); }
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
}
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('GUI slot occupied; no GUI launched.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'forbidden-recovery-test', task: 'bounded continuation after a refused request (403)', token, pid: process.pid, at: new Date().toISOString() }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-forbidden-recovery-'));
const cwd = path.join(profile, 'workspace'), transcripts = path.join(profile, 'transcripts'); fs.mkdirSync(cwd); fs.mkdirSync(transcripts, { mode: 0o700 });
const version = require(path.join(code, 'package.json')).version;
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { cwd, execArgv: ['--require', path.join(__dirname, 'fixtures/forbidden-recovery.cjs')], env: { ...process.env, NAW_APP_VERSION: version, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: cwd }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
const { connectService } = require(path.join(code, 'app/service-connection.cjs'));
const locale = require(path.join(code, 'app/ui-locale.js')), text = (key, params) => locale.format(language, key, params);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, page, client, a, sequence = 0;
const checks = [], errors = [];
async function until(fn, message) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(message); }
function native(method = 'stats', extra = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Owned fixture reply timed out')); }, 5000);
    const receive = result => { if (result.requestId !== id || !result.forbiddenFixture) return; clearTimeout(timer); child.off('message', receive); resolve(result); };
    child.on('message', receive); child.send({ id, method, ...extra });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
const session = async () => (await snapshot()).sessions.find(s => s.id === a);
const shown = () => page.locator('#messages').innerText(), phase = () => page.locator('#native-phase').innerText();
async function capture(name) { if (evidence) await page.screenshot({ path: path.join(evidence, `${name}-${language}.png`) }); }
async function launch() {
  // Record the OS notification request instead of posting it to the desktop.
  const source = path.join(profile, 'source-app'); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'naw-forbidden-recovery-test', version, main: 'entry.cjs' }));
  fs.writeFileSync(path.join(source, 'entry.cjs'), `require(${JSON.stringify(path.join(__dirname, 'fixtures/decision-notification.cjs'))});\nrequire(${JSON.stringify(path.join(code, 'app/main.cjs'))});\n`);
  app = await _electron.launch({ executablePath: require('electron'), args: [source], env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_UI_LANGUAGE: language }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
}
async function select() {
  await page.locator(`[data-session-id="${a}"]`).click(); await page.locator('#chat-tab').click();
  // The owned fixture session was created by the setup client, so take control through the person's own action.
  if (await page.locator('#take-control').isVisible()) await page.locator('#take-control').click();
  await until(() => page.locator('#message-input').evaluate(el => !el.readOnly), 'Owned GUI control');
}
async function send(words, count) { await page.locator('#message-input').fill(words); await page.locator('#send-button').click(); await until(async () => (await native()).sends.length === count, 'Exactly one new task'); }
const refuse = status => native('refuse', { target: a, status, directory: transcripts });
function check(words) { checks.push(words); console.log('PASS:', words); }
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned daemon ready'); client = await connectService(profile, 'forbidden-setup');
  a = await client.call('create', { provider: 'claude', cwd, name: 'Refused request A', view: 'chat' });
  await until(async () => (await client.call('initial')).sessions.find(s => s.id === a).chatAvailable, 'Synthetic Claude transport attached');
  await launch(); await select(); await send('First task.', 1);
  const identity = await session(), same = s => ({ id: s.id, nativeId: s.nativeId, owner: s.owner });

  await refuse(403);
  await until(async () => (await session()).capacityRecovery?.reason === 'forbidden', 'A typed 403 schedules the bounded continuation');
  const first = (await session()).capacityRecovery; assert.equal(first.attempt, 0); assert.ok(first.due - Date.now() > 110000);
  await until(async () => (await phase()).includes(text('native.forbidden')), 'The phase line names the refused request');
  assert.ok(!(await phase()).includes(text('native.capacity')) && !(await phase()).includes(text('native.routingTimeout')));
  await capture('01-scheduled');
  check('A typed 403 shows its own reason and the production two-minute schedule');

  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal((await native('advanceRecovery', { target: a })).advanced, true);
    await until(async () => (await native()).sends.length === attempt + 1, 'One continuation per attempt');
    const [before, after] = text('notice.capacityAutoContinueForbidden', { time: '\u0000', attempt }).split('\u0000');
    await until(async () => { const all = await shown(); return all.includes(before) && all.includes(after); }, 'The continuation notice names the refused request and the attempt');
    if (attempt === 1) await capture('02-continued');
    await refuse(403);
    if (attempt < 3) {
      await until(async () => { const r = (await session()).capacityRecovery; return r?.status === 'scheduled' && r.attempt === attempt; }, 'The next refusal is scheduled within the same budget');
      assert.ok((await session()).capacityRecovery.due - Date.now() > [300000, 600000][attempt - 1] - 10000);
    }
  }
  await until(async () => (await session()).capacityRecovery?.status === 'exhausted', 'The fourth refusal reaches the limit');
  await until(async () => (await shown()).includes(text('notice.capacityLimitForbidden')), 'The limit notice mentions signing in again');
  await until(async () => (await phase()).includes(text('native.forbidden') + text('native.capacityLimit')), 'The phase line shows the limit');
  await until(async () => (await page.locator(`[data-session-id="${a}"]`).innerText()).includes(text('capacityBadge.forbiddenStopped')), 'The sidebar names the refused request');
  const all = await shown();
  for (const key of ['notice.capacityLimitCapacity', 'notice.capacityLimitRouting']) assert.ok(!all.includes(text(key)), 'A refused request is never worded as another cause');
  assert.equal((await native('advanceRecovery', { target: a })).advanced, false);
  await delay(1500); assert.deepEqual((await native()).sends.map(s => s.text), ['First task.', '继续', '继续', '继续']);
  assert.deepEqual(await app.evaluate(() => globalThis.decisionNotifications.map(n => n.options)), [{ title: text('os.capacityTitle'), body: text('os.capacityBody') }]);
  assert.deepEqual(same(await session()), same(identity)); await capture('03-limit');
  check('Three literal continues at 2/5/10 minutes on the same native identity, then one limit notice and one recorded OS request');

  await send('After the limit.', 5); await refuse(401);
  await until(async () => (await session()).state === 'error' && !(await session()).capacityRecovery, 'A 401 ends as an ordinary failure');
  await delay(1500); assert.equal((await native()).sends.length, 5); assert.equal((await session()).capacityRecovery, null); await capture('04-401-not-continued');
  check('A sign-in error (401) is not continued');

  assert.deepEqual(errors, []);
  const final = await native(); assert.equal(final.modelCalls, 0); assert.equal(final.nativeProcesses, 0);
  const result = { checks, errors, language, modelCalls: 0, nativeProviderProcesses: 0, sends: final.sends.map(s => s.text) };
  if (evidence) fs.writeFileSync(path.join(evidence, `result-${language}.json`), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
}
const cleanup = scratch.cleanup(async () => { try { if (app) await app.close(); client?.close(); } finally { if (child.connected) child.disconnect(); if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } } });
run().catch(async error => { console.error(error.stack); process.exitCode = 1; if (page && !page.isClosed()) await capture('failure'); if (evidence) fs.writeFileSync(path.join(evidence, `failure-${language}.txt`), error.stack); }).finally(async () => {
  try { await cleanup(); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); console.log('Owned fixture cleaned; canonical GUI token released.'); }
  catch (error) { console.error('Cleanup unconfirmed; own lock retained:', error.stack); process.exitCode = 1; }
});
