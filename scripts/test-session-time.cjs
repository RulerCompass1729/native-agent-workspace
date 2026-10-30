// Source Electron + actual daemon/IPC, synthetic old/new backend timestamp data.
// No provider process, model, sends, native keys, clipboard or user migration.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process'), { once } = require('node:events');
const scratch = require('./fixtures/test-scratch.cjs');
const { fork } = scratch.childProcess, { _electron } = scratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), evidence = process.env.NAW_EVIDENCE_DIR;
if (evidence) {
  let parent = path.resolve(evidence); while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const target = path.join(fs.realpathSync(parent), path.relative(parent, path.resolve(evidence)));
  if (target === root || target.startsWith(root + path.sep)) throw Error('Evidence must be outside the repository');
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
}
const hash = () => Object.fromEntries(['app/renderer/renderer.js', 'app/dsh/client.js'].map(f => [f, createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex')]));
const sourceBefore = hash(), common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) {
  if (error.code !== 'EEXIST') throw error;
  let existing; try { const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); existing = { owner: owner.owner, task: owner.task, pid: owner.pid }; } catch { existing = { owner: 'unconfirmed' }; }
  console.error('GUI slot occupied; no fixture launched.', JSON.stringify(existing)); process.exit(75);
}
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex2', task: 'T73 session time', token, pid: process.pid, at: new Date().toISOString() }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-session-time-')), cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd);
const child = fork(path.join(root, 'app/daemon.cjs'), [profile], { cwd, execArgv: ['--require', path.join(__dirname, 'fixtures/session-time.cjs')], env: { ...process.env, NAW_APP_VERSION: require('../package.json').version, NAW_WORKSPACE: cwd }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
const { connectService } = require('../app/service-connection.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, page, client, a, b, c, sequence = 0;
const checks = [], errors = [];
async function until(fn, label) { for (let i = 0; i < 180; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function project(target, value) {
  const timeRequestId = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Owned timestamp projection reply timed out')); }, 5000);
    const receive = message => { if (message.timeRequestId !== timeRequestId) return; clearTimeout(timer); child.off('message', receive); message.error ? reject(Error(message.error)) : resolve(); };
    child.on('message', receive); child.send({ method: 'timeProjection', timeRequestId, target, value });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
const row = id => page.locator(`[data-session-row="${id}"]`);
const status = id => row(id).locator('small');
async function launch() {
  app = await _electron.launch({ executablePath: require('electron'), args: [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message)); await page.locator('#new-session').waitFor();
}
async function capture(name) { if (evidence) { await page.screenshot({ path: path.join(evidence, name + '.png') }); fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(await snapshot(), null, 2)); } }
function check(text) { checks.push(text); console.log('PASS:', text); }
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned daemon ready'); client = await connectService(profile, 'time-setup');
  a = await client.call('create', { provider: 'codex', cwd, name: 'Old recorded reply', view: 'chat' });
  b = await client.call('create', { provider: 'claude', cwd, name: 'Old unknown time', view: 'chat' });
  c = await client.call('create', { provider: 'claude', cwd, name: 'Reported activity', view: 'chat' });
  await client.call('initial'); // Establish the actual snapshot owner before projection controls.
  const clock = new Date(); clock.setHours(9, 5, 0, 0); const first = +clock, later = first + 3600000, reported = later + 3600000;
  const progress = { id: 'volatile-progress', kind: 'tool', role: 'tool', volatile: true, text: 'Synthetic live progress.', time: reported + 3600000 };
  const messages = [{ id: 'old-reply', role: 'assistant', text: 'Existing recorded response.', time: first }, { id: 'local-cache-gap', role: 'system', kind: 'gap', text: 'Synthetic cache gap.', time: later }, progress];
  await project(a, { messages }); await project(b, { createdAt: first, lastActivityAt: 1e20, messages: [{ id: 'unknown', role: 'assistant', text: 'No timestamp.', time: null }, progress] });
  await project(c, { createdAt: first, lastActivityAt: reported, messages: [{ id: 'newer-message', role: 'assistant', text: 'Ignored when backend activity exists.', time: reported + 3600000 }] });
  await launch(); const display = value => page.evaluate(n => new Date(n).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), value);
  const firstText = await display(first), laterText = await display(later), reportedText = await display(reported);
  await until(async () => (await status(a).innerText()).includes('推算 ' + firstText), 'Estimated recorded time visible');
  assert.ok((await status(b).innerText()).includes('时间未知')); assert.ok((await status(c).innerText()).includes(reportedText)); assert.ok(!(await status(c).innerText()).includes('推算'));
  for (const [id, text] of [[a, '最后活动 推算 ' + firstText], [b, '最后活动 时间未知'], [c, '最后活动 ' + reportedText]]) {
    const link = row(id).locator('[data-session-id]'); assert.ok((await link.getAttribute('aria-label')).includes(text)); assert.ok((await link.getAttribute('title')).includes(text));
  }
  await capture('01-recorded-estimated-unknown'); check('Old metadata shows an explicit estimate or unknown; backend activity wins and tooltip/accessible text agree');
  await row(a).locator('[data-session-id]').click(); await page.locator('#chat-tab').click();
  if (await page.locator('#take-control').isVisible()) await page.locator('#take-control').click();
  await until(() => page.locator('#message-input').evaluate(el => !el.readOnly), 'Own fixture control'); await page.locator('#message-input').fill('Unsent original draft');
  await until(async () => (await snapshot()).sessions.find(s => s.id === a).liveDraft === 'Unsent original draft', 'Draft saved');
  const before = await snapshot(), identities = before.sessions.map(s => ({ id: s.id, nativeId: s.nativeId, owner: s.owner })), order = await row(a).locator('..').evaluate(el => [...el.children].map(r => r.dataset.sessionRow));
  await project(a, { messages: [...messages, { id: 'later-reply', role: 'assistant', text: 'Another recorded response.', time: later }] });
  await until(async () => (await status(a).innerText()).includes('推算 ' + laterText), 'New recorded reply updates estimated time');
  assert.equal(await page.locator('#message-input').inputValue(), 'Unsent original draft'); check('A newer recorded reply updates the estimate without changing the original draft or native identity');
  await page.locator(`[data-session-menu="${a}"]`).click(); await page.getByRole('menuitem', { name: '归档会话', exact: true }).click();
  if (await page.locator('#archive-button').getAttribute('aria-expanded') !== 'true') await page.locator('#archive-button').click();
  const archive = page.locator('#archive-list .archive-item').filter({ has: page.getByText('Old recorded reply', { exact: true }) }); await archive.waitFor();
  assert.ok((await archive.innerText()).includes('推算 ' + laterText));
  await project(a, { lastActivityAt: reported, messages }); await until(async () => (await archive.innerText()).includes('最后活动 ' + reportedText) && !(await archive.innerText()).includes('推算'), 'Open archive updates on time-only metadata change'); await capture('02-archive-metadata-arrived');
  await archive.getByRole('button', { name: '恢复会话', exact: true }).click(); await row(a).waitFor();
  await until(async () => (await status(a).innerText()).includes(reportedText) && !(await status(a).innerText()).includes('推算'), 'Reported metadata replaces estimate in restored sidebar');
  check('Open archive reacts to time-only updates; restoring uses authoritative metadata without rewriting old message times');
  await app.close(); app = null; await launch();
  await until(async () => (await status(a).innerText()).includes(reportedText), 'Time retained after ordinary owned reopen');
  const final = await snapshot(); assert.deepEqual(final.sessions.map(s => ({ id: s.id, nativeId: s.nativeId, owner: s.owner })), identities); assert.equal(final.sessions.find(s => s.id === a).liveDraft, 'Unsent original draft');
  assert.deepEqual(await page.locator('#session-list').evaluate(el => [...el.children].map(r => r.dataset.sessionRow)), order); assert.deepEqual(errors, []); assert.deepEqual(hash(), sourceBefore); await capture('03-reopened');
  // The reused producer reports actual calls, not just an expected zero budget.
  const stats = await new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => reject(Error('Fixture stats timeout')), 5000); const receive = m => { if (m.requestId !== id) return; clearTimeout(timer); child.off('message', receive); resolve(m.stats); }; child.on('message', receive); child.send({ id, method: 'stats' }); });
  assert.equal(stats.sends, 0); assert.equal(stats.inputs, 0);
  check('Reopen preserves original IDs/owners/draft/order; zero sends, native input, model or provider processes');
  const result = { checks, errors, modelCalls: 0, nativeProviderProcesses: 0, stats, identities, sourceBefore, sourceAfter: hash(), profile };
  if (evidence) fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
}
const cleanup = scratch.cleanup(async () => { try { if (app) await app.close(); client?.close(); } finally { if (child.connected) child.disconnect(); if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } } });
run().catch(async error => { console.error(error.stack); process.exitCode = 1; if (page && !page.isClosed()) await capture('failure'); if (evidence) fs.writeFileSync(path.join(evidence, 'failure.txt'), error.stack); }).finally(async () => {
  try { await cleanup(); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); if (evidence) fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ token, releasedAt: new Date().toISOString(), profile, ownedCleanupConfirmed: true }, null, 2)); console.log('Owned timestamp fixture cleaned; canonical token released.'); }
  catch (error) { console.error('Cleanup unconfirmed; own lock retained:', error.stack); process.exitCode = 1; }
});
