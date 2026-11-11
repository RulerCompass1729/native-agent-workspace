const testScratch = require('./fixtures/test-scratch.cjs');
// Real Electron and NAW's own backend service, with the butler entry's switch open. Only a verified isolated test
// launch can open it (NAW_TEST_BUTLER_ENTRY=1 beside the test parent and profile checks); an ordinary launch cannot.
// No native program is started, no butler host is prepared or started, no credential is checked and no model is
// called. The whole path is the product's own: the window asks the main process -> the person-only handler -> the
// core's person view -> the entry adapter -> the sidebar row and dialog -> the person's action -> the core's record.
// A designation is written here by the core's own record store, because this version offers no way to designate
// (a butler session's identity exists only after its host has started, and nothing starts it).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = testScratch.playwright(require('playwright'));
const locale = require('../app/ui-locale.js');
const { ButlerRole } = require('../app/butler-role.cjs');
const root = path.resolve(__dirname, '..');
if (!process.env.NAW_APP_EXECUTABLE) testScratch.childProcess.execFileSync(process.execPath, [path.join(root, 'scripts/build-ui.cjs')]);
const { connectService } = require('../app/service-client.cjs');
const base = testScratch.directory(path.join(os.tmpdir(), 'naw-butler-entry-open-'));
const profile = path.join(base, 'profile'); fs.mkdirSync(profile, { mode: 0o700 });
const evidence = process.env.NAW_EVIDENCE_DIR || path.join(base, 'evidence'); fs.mkdirSync(evidence, { recursive: true });
let application, page, client;
const errors = [], checks = [], shots = [], sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 30000) { const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await sleep(80); } throw Error(label); }
async function cleanup() {
  if (application) await application.close().catch(() => {});
  if (client) { try { await client.call('shutdown'); } catch { /* service already gone */ } finally { client.close(); } }
}
const say = (key, params) => locale.format('zh', key, params);
// Synthetic identity and references; they must never reach a page.
const hidden = ['butler-session-synthetic', 'butler-native-synthetic', 'butler-runner:synthetic', 'butler-backend:synthetic'];
const selection = { identity: { sessionId: hidden[0], nativeId: hidden[1] },
  runner: { runnerRef: hidden[2], backendRef: hidden[3], purpose: 'butler', profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro' } };
(async () => {
  const serviceCwd = path.join(profile, 'workspace'); fs.mkdirSync(serviceCwd, { mode: 0o700 });
  const env = { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: serviceCwd, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_BUTLER_ENTRY: '1' };
  for (const key of ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'NAW_RUNTIME_CONFIG', 'DEEPSEEK_API_KEY']) delete env[key];
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env, timeout: 60000 });
  await until(async () => { for (const p of application.windows()) if (!p.isClosed() && await p.locator('#new-session').count().catch(() => 0)) { page = p; return true; } return false; }, 'Main window', 60000);
  page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  client = await connectService(profile, 'butler-entry-open-test');
  await application.evaluate(({ BrowserWindow }) => { for (const win of BrowserWindow.getAllWindows()) win.setContentSize(1280, 800); });
  await until(async () => await page.evaluate(() => innerWidth === 1280), 'Window 1280 wide', 10000);
  const shot = async name => { await page.screenshot({ path: path.join(evidence, name + '.png') }); shots.push(name); };
  const row = page.locator('#butler-row'), dialog = page.locator('#butler-dialog');
  const label = state => say('butler.rowLabel', { state: say(`butler.row.${state}`) });
  const actions = () => dialog.locator('.dialog-actions:visible button').evaluateAll(list => list.map(el => el.dataset.action));
  const notes = async () => (await dialog.locator('.butler-note:visible').allInnerTexts()).map(value => value.trim());
  const call = (...args) => page.evaluate(values => window.workspace.butler(...values).then(value => ({ value }), error => ({ refused: error.message })), args);
  const record = () => JSON.parse(fs.readFileSync(path.join(profile, 'butler.json'), 'utf8'));
  const front = () => page.evaluate(() => { window.dispatchEvent(new Event('focus')); });
  const unseen = async what => { const text = await page.evaluate(() => document.body.innerText + document.body.innerHTML); for (const value of hidden) assert.equal(text.includes(value), false, `${what}: no identity or reference is on the page`); };
  const reminder = { amountMicros: 2000000, dayBoundary: 'UTC' };

  // 1. The product's own row appears by itself: the window asked the main process as it started. Nothing is designated.
  await until(async () => await row.isVisible() && await row.getAttribute('aria-label') === label('empty'), 'The product\'s own row shows that no butler is designated');
  assert.equal(await page.evaluate(() => document.getElementById('butler-row').nextElementSibling.id), 'new-session');
  await row.click(); await dialog.waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'done', 'Opening puts the focus on Done');
  assert.deepEqual(await notes(), [say('butler.note.empty'), say('butler.note.designateLater')], 'The person is told no designation can be made in this version');
  assert.deepEqual(await actions(), ['reads', 'done'], 'No designation is offered; the read log is');
  // What the real main process answers a window with, and what it does with each call the entry can make.
  const empty = await call('status');
  assert.deepEqual(empty.value.role, { revision: 0, selected: null }); assert.deepEqual(empty.value.reminder, reminder);
  assert.deepEqual([empty.value.version, empty.value.startable, empty.value.uncertain, empty.value.hold, empty.value.usage, empty.value.reviewAvailable], [1, false, false, null, null, false]);
  assert.deepEqual(empty.value.actions, ['recheck'], 'A designation is not among what the main process accepts');
  assert.deepEqual(await call('designate', 0), { value: { activation: 'off', recordPeriod: 'off', status: 'blocked', reason: 'trusted-candidate-unavailable' } });
  // The shape the window used to send with a designation, and anything else extra, is refused.
  for (const invalid of [['designate', 0, { profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro', limitMicros: 2000000, dayBoundary: 'UTC', startable: false }], ['recheck'], ['turnOff', 0], ['open', 0], ['close', 0], ['revoke'], ['revoke', '0'], ['status', 0]])
    assert.deepEqual(await call(...invalid), { refused: say('error.butler.invalidRequest') }, JSON.stringify(invalid));
  assert.deepEqual(await call('setActive', true, 0), { refused: say('error.butler.activationDisabled') }, 'Nothing here can start a butler');
  for (const name of ['butler.json', 'butler-native']) assert.equal(fs.existsSync(path.join(profile, name)), false, 'Looking and being refused writes nothing: ' + name);
  await shot('open-empty');
  await dialog.locator('button[data-action="done"]').click(); await dialog.waitFor({ state: 'hidden' });
  checks.push('Switch open, nothing designated: the row appears by itself, the dialog says no designation can be made in this version and offers none; a designate call is answered "blocked", the old three-argument shape is refused, nothing is written');

  // 2. A designation exists (written by the core's own record store, behind the window's back). Coming back to the
  //    front asks again, and the row follows.
  const token = {}, core = new ButlerRole(profile, { authorizePerson: value => value === token });
  assert.equal(core.set(token, selection, 0).revision, 1);
  assert.equal(await row.getAttribute('aria-label'), label('empty'), 'Nothing is pushed: the row is as it was');
  await front();
  await until(async () => await row.getAttribute('aria-label') === label('blockedBuild'), 'After coming back to the front the row shows the designation');
  await row.click(); await dialog.waitFor({ state: 'visible' });
  assert.deepEqual(await notes(), [say('butler.note.blockedBuild')]);
  const lines = (await dialog.locator('.quiet:visible').allInnerTexts()).map(value => value.trim().replace(/ /g, ' '));
  // No limit of its own was recorded: the line shown is the reminder line. No wake-up was recorded: not verified, not zero.
  assert.deepEqual(lines, [say('butler.model', { name: 'DeepSeek pro', model: 'deepseek-v4-pro' }), say('butler.usage.unverified', { limit: '$2.00' }).replace(/ /g, ' ')]);
  assert.deepEqual(await actions(), ['revoke', 'reads', 'done']);
  const designated = await call('status');
  assert.deepEqual(designated.value.role, { revision: 1, selected: { runner: { profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro' }, budget: null } });
  assert.deepEqual([designated.value.startable, designated.value.uncertain, designated.value.actions], [false, false, ['revoke', 'recheck']]);
  for (const value of hidden) assert.equal(JSON.stringify(designated).includes(value), false, 'The answer carries no identity or reference');
  await unseen('designated');
  await shot('open-designated');
  checks.push('A designation made elsewhere is shown after the window comes back to the front: "cannot start", its model, the reminder line, usage not verified, revoke apart; the answer and the page carry no identity or reference');

  // 3. The record changes while the dialog is open (another window revoked and designated again): the person's
  //    revoke for the revision on the screen is refused, said in words, and the dialog then shows the record as it is.
  assert.equal(core.revoke(token, 1).revision, 2); assert.equal(core.set(token, selection, 2).revision, 3);
  await dialog.locator('button[data-action="revoke"]').click();
  assert.deepEqual(await notes(), [say('butler.revoke.text')]); assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'back', 'A question puts the focus on Cancel');
  await shot('open-revoke-question');
  await dialog.locator('button[data-action="confirmRevoke"]').click();
  await until(async () => (await dialog.locator('[role="alert"]:visible').count()) === 1, 'The refusal is said');
  assert.equal((await dialog.locator('[role="alert"]:visible').innerText()).trim(), say('error.butler.changed'));
  assert.equal(record().revision, 3, 'A stale revoke changes nothing'); assert.notEqual(record().selected, null);
  await shot('open-revoke-stale');

  // 4. Revoking, through the product's own dialog, for the record as it now is.
  await dialog.locator('button[data-action="revoke"]').click();
  assert.equal(record().revision, 3, 'Asking is not revoking');
  await dialog.locator('button[data-action="confirmRevoke"]').click();
  await until(async () => await row.getAttribute('aria-label') === label('empty'), 'After revoking the row says no butler is designated');
  assert.deepEqual(record(), { version: 1, revision: 4, selected: null });
  assert.deepEqual(await notes(), [say('butler.note.empty'), say('butler.note.designateLater')]); assert.deepEqual(await actions(), ['reads', 'done']);
  assert.equal(await dialog.locator('[role="alert"]:visible').count(), 0, 'The earlier refusal is not left on the screen');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'done');
  await unseen('revoked');
  await shot('open-revoked');
  checks.push('A revoke for a record that changed meanwhile is refused in words and changes nothing; revoking the record as it is asks first, then the core\'s record has no designation and the row is empty again');

  // 5. The read log opens from the entry (its own dialog), and the entry is still there afterwards.
  await dialog.locator('button[data-action="reads"]').click();
  await page.locator('#butler-reads-dialog').waitFor({ state: 'visible' }); assert.equal(await dialog.isVisible(), false);
  await page.locator('#butler-reads-dialog button[data-action="done"]').click(); await page.locator('#butler-reads-dialog').waitFor({ state: 'hidden' });
  assert.equal(await row.getAttribute('aria-label'), label('empty'));
  checks.push('The read log opens from the entry and closes back to the row');

  // 6. The designation record becomes unreadable: not "none designated", and nothing to do from the window.
  fs.writeFileSync(path.join(profile, 'butler.json'), '{broken', { mode: 0o600 });
  await front();
  await until(async () => await row.getAttribute('aria-label') === label('unknown'), 'An unreadable record is shown as an unknown state');
  await row.click(); await dialog.waitFor({ state: 'visible' });
  assert.deepEqual(await notes(), [say('butler.note.unknown')]); assert.deepEqual(await actions(), ['reads', 'done']);
  assert.deepEqual((await call('status')).value, { version: 1, unavailable: true, actions: [] });
  await shot('open-unreadable');
  await dialog.locator('button[data-action="done"]').click(); await dialog.waitFor({ state: 'hidden' });
  checks.push('An unreadable designation record is shown as "state unknown" with nothing to do but read the log');

  // 7. Nothing else happened.
  assert.equal(fs.existsSync(path.join(profile, 'butler-native')), false, 'No butler host directory was prepared');
  assert.equal((await client.call('initial')).sessions.length, 0); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, screenshots: shots.length, nativeProgramsStarted: 0, butlerHostsPrepared: 0, sessions: 0, promptsSent: 0, paidModelCalls: 0, evidence }));
})().catch(async error => {
  if (page && !page.isClosed()) { fs.writeFileSync(path.join(evidence, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {}); }
  console.error(error.stack, '\nEvidence:', evidence); process.exitCode = 1;
}).finally(testScratch.cleanup(cleanup));
