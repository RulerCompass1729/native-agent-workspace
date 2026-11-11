const testScratch = require('./fixtures/test-scratch.cjs');
// Real Electron and NAW's own backend service, with the butler entry's switch open. Only a verified isolated test
// launch can open it (NAW_TEST_BUTLER_ENTRY=1 beside the test parent and profile checks); an ordinary launch cannot.
// No native program is started, no butler host is prepared or started, no credential is checked and no model is
// called. The whole path is the product's own: the window asks the main process -> the person-only handler -> the
// core's person view -> the entry adapter -> the sidebar row and dialog -> the person's action -> the core's record.
// A designation is written here by the core's own record store, because this version offers no way to designate
// (a butler session's identity exists only after its host has started, and nothing starts it).
// Last, the entry that cannot be set up: one of its parts is kept out of the window as it loads, and the window's
// own code meets the failure. The row must stay, say that the interface failed, and still lead to the read log.
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
  // What the journey changed in the core's record: the next revision, and no designation. The record's own format
  // version is the core's to change and is not this check's concern.
  assert.deepEqual([record().revision, record().selected], [4, null]);
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

  // 7. The entry cannot be set up. The main process still says this window has an entry (the record is the
  //    unreadable one from step 6), so the row must not vanish: it stays in its place and says the interface failed.
  await page.addInitScript(() => {
    const mode = sessionStorage.getItem('naw-test-entry-failure');
    const hide = name => Object.defineProperty(window, name, { configurable: true, get() { return undefined; }, set() {} });
    if (mode === 'module') hide('nativeWorkspaceButlerEntry');
    if (mode === 'view') hide('nativeWorkspaceButlerEntryView');
    // The element is taken out of the page the first time the window looks for it, which is at its setup.
    if (mode === 'row' || mode === 'dialog') { const real = Document.prototype.getElementById, id = mode === 'row' ? 'butler-row' : 'butler-dialog'; let taken = false;
      Document.prototype.getElementById = function (wanted) { const found = real.call(this, wanted); if (wanted !== id || taken || !found) return found; taken = true; found.remove(); return null; }; }
  });
  const load = async mode => {
    await page.evaluate(value => sessionStorage.setItem('naw-test-entry-failure', value), mode); await page.reload();
    await until(async () => await page.locator('#new-session').count().catch(() => 0), 'Main window after reload', 30000);
  };
  // What was kept out really is out: the program, the view it draws from, or the element as the setup found it.
  const keptOut = () => page.evaluate(() => [typeof window.nativeWorkspaceButlerEntry?.bind, typeof window.nativeWorkspaceButlerEntryView?.entryView]);
  const size = async (width, height) => { await application.evaluate(({ BrowserWindow }, [w, h]) => { for (const win of BrowserWindow.getAllWindows()) win.setContentSize(w, h); }, [width, height]); await until(async () => await page.evaluate(w => innerWidth === w, width), `Window ${width} wide`, 10000); };
  const recordBytes = () => fs.readFileSync(path.join(profile, 'butler.json'), 'hex'), before = recordBytes();
  const reads = page.locator('#butler-reads-dialog');
  let spoken = 'zh';
  // mode, the reason the window must give, what is then absent from it, language, window size
  for (const [mode, reason, out, language, width, height] of [['module', 'module', ['undefined', 'function'], 'zh', 1280, 800], ['view', 'setup', ['function', 'undefined'], 'zh', 860, 600],
    ['row', 'element', ['function', 'function'], 'en', 1280, 800], ['dialog', 'element', ['function', 'function'], 'en', 860, 600]]) {
    const tell = (key, params) => locale.format(language, key, params), tag = `${mode}-${language}-${width}`, failed = tell('butler.rowLabel', { state: tell('butler.row.failed') });
    await size(width, height); await load(mode);
    await until(async () => await row.isVisible().catch(() => false), `${tag}: a row is on the screen`, 15000);
    if (language !== spoken) {
      await page.locator('#setup-button').click(); await page.locator('#setup-dialog').waitFor({ state: 'visible' });
      await page.locator('#ui-language').selectOption(language);
      await until(async () => await page.locator('#new-session').getAttribute('aria-label') === tell('sidebar.newSession'), 'The interface follows the language', 15000);
      await page.keyboard.press('Escape'); await page.locator('#setup-dialog').waitFor({ state: 'hidden' }); spoken = language;
    }
    assert.deepEqual(await keptOut(), out, tag);
    // One row, in the entry's place, saying it is the interface; not a notice, and not any state of a butler.
    await until(async () => await row.getAttribute('aria-label') === failed, `${tag}: the row says the interface failed`, 15000);
    const seen = await page.evaluate(() => { const rows = document.querySelectorAll('#butler-row'), row = rows[0], box = row.getBoundingClientRect(), dot = row.querySelector('.butler-dot').getBoundingClientRect(), text = row.querySelector('.butler-state > span:not(.butler-dot)');
      return { rows: rows.length, dialogs: document.querySelectorAll('#butler-dialog').length, next: row.nextElementSibling.id, state: row.dataset.butlerState, failure: row.dataset.butlerFailure, title: row.title,
        inside: box.left >= 0 && box.right <= innerWidth && box.height >= 24, dot: dot.width > 0 && getComputedStyle(row.querySelector('.butler-dot')).backgroundColor, stateShown: text.getClientRects().length > 0, stateText: text.textContent,
        toast: document.getElementById('toast').hidden === false && document.getElementById('toast').getClientRects().length > 0 }; });
    assert.deepEqual(seen, { rows: 1, dialogs: mode === 'dialog' ? 0 : 1, next: 'new-session', state: 'failed', failure: reason, title: failed, inside: true, dot: 'rgb(181, 101, 29)', stateShown: width > 900, stateText: tell('butler.row.failed'), toast: false }, tag);
    // Chosen, it says why, what cannot be done from here, and offers the read log and Done; nothing that changes a designation.
    await row.click(); await dialog.waitFor({ state: 'visible' });
    assert.deepEqual([await dialog.getAttribute('data-butler-state'), await dialog.getAttribute('data-butler-failure'), (await dialog.locator('h2').innerText()).trim()], ['failed', reason, tell('butler.name')], tag);
    assert.deepEqual((await dialog.locator('p').allInnerTexts()).map(value => value.trim()), [tell(`butler.entryFailed.${reason}`)], tag);
    assert.equal(await dialog.locator('p[role="alert"]').count(), 1); assert.deepEqual(await actions(), ['reads', 'done'], tag);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.action), 'done', 'The focus is on Done');
    const text = (await dialog.innerText()).replace(/\s+/g, ' ');
    for (const key of ['butler.status.empty', 'butler.status.unknown', 'butler.note.unknown', 'butler.note.empty', 'butler.note.designateLater']) assert.equal(text.includes(tell(key)), false, `${tag}: ${key}`);
    // It fits its window: nothing cut, nothing to scroll sideways, the actions on one line.
    // And it is the page's dialog, not a bare one: among the page's own dialogs, as wide as the entry's dialog is,
    // drawn like the page's other dialogs and buttons (a dialog made outside that place gets none of the styles).
    const fit = await page.evaluate(() => { const d = document.getElementById('butler-dialog'), box = d.getBoundingClientRect(), all = [...d.querySelectorAll('.dialog-actions button')], buttons = all.map(b => b.getBoundingClientRect());
      const like = document.getElementById('butler-reads-dialog'), look = element => { const style = getComputedStyle(element); return [style.borderTopLeftRadius, style.paddingLeft, style.borderTopWidth, style.backgroundColor].join(' '); };
      return { inside: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight, level: d.scrollWidth <= d.clientWidth && d.scrollHeight <= d.clientHeight, oneLine: new Set(buttons.map(b => Math.round(b.top))).size === 1, shown: buttons.every(b => b.width > 0 && b.right <= box.right),
        place: d.parentElement === document.getElementById('butler-review-dialog').parentElement && d.nextElementSibling.id === 'butler-review-dialog', width: Math.round(box.width) === Math.min(600, innerWidth - 48),
        dialogLook: look(d) === look(like) && parseFloat(getComputedStyle(d).borderTopLeftRadius) > 0, buttonLook: all.every(b => getComputedStyle(b).fontSize === getComputedStyle(d).fontSize && parseFloat(getComputedStyle(b).borderTopLeftRadius) > 0), right: buttons.at(-1).right > box.right - 80 }; });
    assert.deepEqual(fit, { inside: true, level: true, oneLine: true, shown: true, place: true, width: true, dialogLook: true, buttonLook: true, right: true }, tag);
    await unseen(`failed ${tag}`); await shot(`entry-failed-${tag}`);
    // The read log needs no entry: it opens from here and closes back to the row, which is still the failure row.
    await dialog.locator('button[data-action="reads"]').click(); await reads.waitFor({ state: 'visible' }); assert.equal(await dialog.isVisible(), false);
    assert.equal(await reads.getAttribute('data-reads-failure'), null, 'The read log itself is not what failed');
    await reads.locator('button[data-action="done"]').click(); await reads.waitFor({ state: 'hidden' });
    assert.equal(await row.getAttribute('aria-label'), failed); assert.equal(await row.isVisible(), true);
    // Coming back to the front changes nothing, and nothing was written.
    await front(); await sleep(200); assert.equal(await row.getAttribute('aria-label'), failed); assert.equal(recordBytes(), before, 'The designation record is as it was');
  }
  // With nothing kept out the entry itself is back, saying what the record says.
  await load('none'); assert.deepEqual(await keptOut(), ['function', 'function']);
  await until(async () => await row.isVisible().catch(() => false) && await row.getAttribute('aria-label') === locale.format('en', 'butler.rowLabel', { state: locale.format('en', 'butler.row.unknown') }), 'The entry itself is back');
  assert.deepEqual(await page.evaluate(() => [document.getElementById('butler-row').dataset.butlerState, document.getElementById('butler-row').dataset.butlerFailure ?? null, document.querySelectorAll('#butler-row').length]), ['unknown', null, 1]);
  checks.push('An entry that cannot be set up (its program missing, the view it draws from missing, its row or its dialog not in the page) leaves a row in the entry\'s place that says the interface failed; its dialog says why and what cannot be done from here, offers the read log and Done, and the read log opens from it; in both languages and at both widths; nothing is written');

  // 8. Nothing else happened.
  assert.equal(fs.existsSync(path.join(profile, 'butler-native')), false, 'No butler host directory was prepared');
  assert.equal((await client.call('initial')).sessions.length, 0); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, screenshots: shots.length, nativeProgramsStarted: 0, butlerHostsPrepared: 0, sessions: 0, promptsSent: 0, paidModelCalls: 0, evidence }));
})().catch(async error => {
  if (page && !page.isClosed()) { fs.writeFileSync(path.join(evidence, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {}); }
  console.error(error.stack, '\nEvidence:', evidence); process.exitCode = 1;
}).finally(testScratch.cleanup(cleanup));
