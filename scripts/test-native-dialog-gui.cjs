// Existing status/queue text only. One isolated synthetic-provider GUI; no model.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process'), { randomUUID } = require('node:crypto');
const scratch = require('./fixtures/test-scratch.cjs'), { _electron } = scratch.playwright(require('playwright'));
const { revealDefaultSpace } = require('./fixtures/default-space.cjs');
const { connect } = require('../app/service-client.cjs'), { RoomState } = require('../app/room-state.cjs');
const root = path.resolve(__dirname, '..'), evidence = process.env.NAW_EVIDENCE_DIR, pictures = process.env.NAW_SCREENSHOTS_DIR;
assert.ok(evidence && pictures); fs.mkdirSync(pictures, { recursive: true, mode: 0o700 });
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; nothing launched'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex F', task: 'dialog status and queue GUI', token, pid: process.pid }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-dialog-gui-'));
let child, client, app, page; const errors = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 30000) { const end = Date.now() + limit; while (Date.now() < end) { if (await check()) return; await delay(100); } throw Error(label); }
const snapshot = () => page.evaluate(() => workspace.initial());
(async () => {
  child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/native-dialog.cjs')], env: { ...process.env, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: root, NAW_DIALOG_LOG_ROOT: profile, NAW_APP_VERSION: require('../package.json').version }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'owned service'); client = await connect(profile, 'fixture-person');
  const id = await client.call('create', { provider: 'claude', cwd: profile, name: 'Dialog member' });
  await client.call('join', id, true);
  await until(async () => (await client.call('initial')).sessions[0]?.nativeTerminalDialog, 'fixture choice');
  const room = new RoomState(profile), itemId = room.queueAdd('GUI_SYNTHETIC_TASK', id);
  app = await _electron.launch({ executablePath: require('electron'), args: [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 60000 });
  page = await app.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor(); await revealDefaultSpace(page); await page.locator('#sessions-flat').click();
  await page.locator(`#session-list .session-link[data-session-id="${id}"]`).click();
  await until(async () => (await page.locator('#session-status').innerText()).includes('等你：终端停在弹窗'), 'session status');
  assert.match(await page.locator('#session-status').innerText(), /Teach auto mode about your environment/);
  await page.screenshot({ path: path.join(pictures, 'fixture-session-blocked.png') });
  await page.locator('#room-nav').click(); await page.locator('#room-queue').click();
  const row = page.locator(`#queue-list [data-queue-item="${itemId}"]`);
  await until(async () => (await row.innerText()).includes('等你：终端停在弹窗'), 'queue reason');
  await page.screenshot({ path: path.join(pictures, 'fixture-queue-blocked.png') });
  await delay(8500); assert.equal((await snapshot()).rooms.find(r => r.id === 'shared').queue.find(i => i.id === itemId).status, 'queued');
  assert.equal(fs.existsSync(path.join(profile, id + '.jsonl')), false, 'known fixture has received zero terminal bytes');
  // The fixture removes its screen. This is not a human input and does not bypass the existing human quiet timer.
  child.send({ id: 1, method: 'dismiss', target: id });
  await until(async () => (await snapshot()).rooms.find(r => r.id === 'shared').queue.find(i => i.id === itemId).status === 'sent', 'automatic dispatch resumes');
  assert.ok(!(await row.innerText()).includes('等你：终端停在弹窗'));
  await page.screenshot({ path: path.join(pictures, 'fixture-queue-resumed.png') });
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(evidence, 'gui-result.json'), JSON.stringify({ checks: ['session title', 'queue reason', 'zero bytes during dialog', 'dispatch after disappearance', 'reason cleared'], errors, paidModelCalls: 0 }, null, 2));
  console.log('GUI 5 pass / 0 fail; paid model calls 0');
})().catch(async e => { if (page) { await page.screenshot({ path: path.join(pictures, 'fixture-failure.png') }).catch(() => {}); fs.writeFileSync(path.join(evidence, 'gui-failure.txt'), await page.locator('body').innerText().catch(() => 'unavailable')); } console.error(e); process.exitCode = 1; }).finally(async () => {
  if (app) await app.close().catch(() => {});
  if (client) { for (const s of client.snapshot().sessions) await client.call('stop', s.id).catch(() => {}); await client.call('shutdown').catch(() => {}); client.close(); }
  if (child && child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
  if (JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token === token) fs.rmSync(slot, { recursive: true });
});
