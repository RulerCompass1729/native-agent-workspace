const testScratch = require('./fixtures/test-scratch.cjs');
// Real Electron and NAW's own backend service. No native program is started, no model is called and nothing is
// designated: in an ordinary launch the main process refuses every call of the person-only butler entry.
// 1. The product as it is. The butler's row is in the page and hidden; nothing about a butler is on the screen.
// 2. The same page with entries handed in by this script, for the states the main process cannot answer with in
//    this version. The product's own module, stylesheet and catalog draw a row and a dialog placed beside the hidden
//    ones, in both languages and at two window widths (1280, and 860 where the sidebar is a rail; the window's
//    minimum is 850); `butler` here answers the question for the entry with what the script handed in and only
//    records what the dialog would ask the main process to do.
// The entry with its switch open, through the real main process, is scripts/test-butler-entry-open.cjs.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = testScratch.playwright(require('playwright'));
const locale = require('../app/ui-locale.js');
const root = path.resolve(__dirname, '..');
if (!process.env.NAW_APP_EXECUTABLE) testScratch.childProcess.execFileSync(process.execPath, [path.join(root, 'scripts/build-ui.cjs')]);
const { connectService } = require('../app/service-client.cjs');
const base = testScratch.directory(path.join(os.tmpdir(), 'naw-butler-entry-'));
const profile = path.join(base, 'profile'); fs.mkdirSync(profile, { mode: 0o700 });
const evidence = process.env.NAW_EVIDENCE_DIR || path.join(base, 'evidence'); fs.mkdirSync(evidence, { recursive: true });
let application, page, client;
const errors = [], checks = [], shots = [], sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 30000) { const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await sleep(80); } throw Error(label); }
async function cleanup() {
  if (application) await application.close().catch(() => {});
  if (client) { try { await client.call('shutdown'); } catch { /* service already gone */ } finally { client.close(); } }
}
// Synthetic views in the shape app/butler-entry-view.js documents.
const selected = { runner: { profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro' }, budget: { limitMicros: 2_000_000, dayBoundary: 'UTC' } };
const every = ['designate', 'revoke', 'recheck'];
const none = { version: 1, role: { revision: 0, selected: null }, offer: selected, startable: false, actions: every };
const designated = extra => ({ version: 1, role: { revision: 1, selected }, startable: false, backend: null, intake: { recordPeriod: 'off' }, actions: every, ...extra });
const ready = extra => designated({ startable: true, backend: { state: 'ready', ready: true, blocked: [] }, ...extra });
// Today's usage as the core reads it (app/butler-usage.cjs): `runs` recorded wake-ups, `unknown` of them without usage.
const { summarizeUsage } = require('../app/butler-usage.cjs');
const NOW = Date.UTC(2026, 10, 11, 9);
const usage = (runs, unknown, totalTokens, costMicros) => summarizeUsage({ batches: [], attempts: Array.from({ length: runs }, (_, index) => ({ batchId: `batch-${index}`, startedAt: NOW - 60000,
  usage: index < unknown ? null : { inputTokens: index === unknown ? totalTokens : 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: index === unknown ? totalTokens : 0, costMicros: index === unknown ? costMicros : 0 } })) }, { now: NOW });
// name, view, state, and the catalog keys whose sentences must be on the screen
const gallery = [
  ['blocked-build-nokey', designated({ backend: { state: 'blocked', ready: false, blocked: ['credential-missing', 'tools-unqualified', 'context-unqualified', 'provider-unqualified', 's2-unqualified'] } }), 'blocked-build', ['butler.note.blockedBuild', 'butler.note.alsoMissingKey']],
  ['blocked-credential', designated({ startable: true, backend: { state: 'blocked', ready: false, blocked: ['credential-missing'] } }), 'blocked-credential', ['butler.note.blockedCredential']],
  ['unknown', designated({ startable: true, backend: { state: 'unknown', ready: false, blocked: ['liveness-unconfirmed'] } }), 'unknown', ['butler.note.unknown']],
  ['ready', ready({ usage: usage(0, 0, 0, 0) }), 'ready', ['butler.status.ready', 'butler.note.ready']],
  ['recording', ready({ intake: { recordPeriod: 'on' }, usage: usage(3, 0, 5074, 6100), reviewAvailable: true }), 'recording', ['butler.status.recording', 'butler.note.recording']],
  ['recording-partial', ready({ intake: { recordPeriod: 'on' }, usage: usage(3, 1, 3331, 3940) }), 'recording', ['butler.note.recording']],
  ['held-budget', ready({ intake: { recordPeriod: 'on' }, usage: usage(2, 0, 860000, 2115000), hold: 'daily-budget-reached' }), 'held', ['butler.hold.dailyBudgetReached']],
  ['held-cost-unknown', ready({ intake: { recordPeriod: 'on' }, usage: usage(3, 1, 3331, 3940), hold: 'usage-cost-unknown' }), 'held', ['butler.hold.usageCostUnknown']],
  ['held-estimate', ready({ intake: { recordPeriod: 'on' }, hold: 'next-batch-cost-unknown' }), 'held', ['butler.hold.nextBatchCostUnknown']],
];
(async () => {
  const serviceCwd = path.join(profile, 'workspace'); fs.mkdirSync(serviceCwd, { mode: 0o700 });
  const env = { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: serviceCwd, NAW_TEST_PARENT_PID: String(process.pid) };
  for (const key of ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'NAW_RUNTIME_CONFIG', 'DEEPSEEK_API_KEY', 'NAW_TEST_BUTLER_ENTRY']) delete env[key];
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env, timeout: 60000 });
  await until(async () => { for (const p of application.windows()) if (!p.isClosed() && await p.locator('#new-session').count().catch(() => 0)) { page = p; return true; } return false; }, 'Main window', 60000);
  page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  client = await connectService(profile, 'butler-entry-test');
  const shot = async name => { const file = path.join(evidence, name + '.png'); await page.screenshot({ path: file }); shots.push(name); };
  const size = async (width, height) => { await application.evaluate(({ BrowserWindow }, [w, h]) => { for (const win of BrowserWindow.getAllWindows()) win.setContentSize(w, h); }, [width, height]); await until(async () => await page.evaluate(w => innerWidth === w, width), `Window ${width} wide`, 10000); };

  // 1. The product as it is: the switch is closed.
  await size(1280, 800);
  const closed = () => page.evaluate(() => {
    const row = document.getElementById('butler-row'), dialog = document.getElementById('butler-dialog'), next = document.getElementById('new-session');
    return { row: !!row && row.hidden && row.getClientRects().length === 0, rowBeforeNew: row.nextElementSibling === next, dialog: !!dialog && !dialog.open, entry: typeof window.workspace.butler,
      text: /大管家|Butler/.test(document.querySelector('.sidebar').innerText), module: typeof window.nativeWorkspaceButlerEntry?.bind, view: JSON.stringify(window.nativeWorkspaceButlerEntryView?.entryView(undefined)) };
  });
  assert.deepEqual(await closed(), { row: true, rowBeforeNew: true, dialog: true, entry: 'function', text: false, module: 'function', view: '{"visible":false}' });
  // The call exists, and the main process refuses it: the entry is closed in an ordinary launch.
  for (const call of [['status'], ['revoke', 0], ['designate', 0]]) assert.equal(await page.evaluate(args => window.workspace.butler(...args).then(() => 'accepted', error => error.message), call), locale.format('zh', 'error.butler.entryDisabled'));
  for (const name of ['butler.json', 'butler-native']) assert.equal(fs.existsSync(path.join(profile, name)), false, 'Nothing about a butler is written: ' + name);
  // The window asked once as it started and was refused; coming back to the front does not make a row appear.
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); }); await sleep(300);
  assert.deepEqual(await closed(), { row: true, rowBeforeNew: true, dialog: true, entry: 'function', text: false, module: 'function', view: '{"visible":false}' });
  // The hidden row takes no room: "new session" sits where it sits without it.
  const gapWith = await page.evaluate(() => document.getElementById('new-session').getBoundingClientRect().top);
  const gapWithout = await page.evaluate(() => { const row = document.getElementById('butler-row'), parent = row.parentNode, next = row.nextSibling; row.remove(); const top = document.getElementById('new-session').getBoundingClientRect().top; parent.insertBefore(row, next); return top; });
  assert.equal(gapWith, gapWithout);
  await shot('closed-zh');
  checks.push('With the entry closed (every ordinary launch) the row is hidden, takes no room, the main process refuses every butler call, and the sidebar says nothing about a butler');

  // 2. A view handed in by this script, drawn by the product's own module beside the hidden row and dialog.
  const mount = language => page.evaluate(lang => {
    const row = document.createElement('button'); row.id = 'butler-row-check'; row.className = 'butler-row'; row.type = 'button'; row.setAttribute('aria-haspopup', 'dialog'); row.hidden = true;
    document.getElementById('butler-row').before(row);
    const dialog = document.createElement('dialog'); dialog.id = 'butler-dialog-check'; dialog.className = 'butler-dialog'; dialog.setAttribute('closedby', 'any');
    document.getElementById('butler-dialog').after(dialog);
    const calls = [], check = { calls, row, dialog, current: undefined };
    // The question for the entry is answered with what the script handed in last; everything else is only recorded.
    check.entry = window.nativeWorkspaceButlerEntry.bind({ row, dialog, document, api: { butler: async (...args) => { if (args[0] === 'status') return check.current; calls.push(args); } }, text: (key, params) => window.nativeWorkspaceLocale.format(lang, key, params) });
    window.butlerEntryCheck = check;
  }, language);
  const unmount = () => page.evaluate(() => { const { entry, row, dialog } = window.butlerEntryCheck; entry.dispose(); row.remove(); dialog.remove(); delete window.butlerEntryCheck; });
  const give = view => page.evaluate(value => { window.butlerEntryCheck.current = value; window.butlerEntryCheck.entry.render(value); }, view);
  const calls = () => page.evaluate(() => window.butlerEntryCheck.calls);
  const row = () => page.locator('#butler-row-check'), dialog = () => page.locator('#butler-dialog-check');
  const act = name => dialog().locator(`button[data-action="${name}"]:visible`);
  // What a person would trip over: clipped text, a dialog off the window, actions wrapping onto a second line.
  const fits = label => page.evaluate(name => {
    const { row, dialog } = window.butlerEntryCheck, problems = [];
    const clipped = el => el.scrollWidth > el.clientWidth + 1;
    if (clipped(row) || [...row.querySelectorAll('span')].some(el => el.getClientRects().length && clipped(el))) problems.push('row text clipped');
    if (dialog.open) {
      const box = dialog.getBoundingClientRect();
      if (box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight) problems.push('dialog outside the window');
      if (clipped(dialog)) problems.push('dialog scrolls sideways');
      if (dialog.scrollHeight > dialog.clientHeight + 1) problems.push('dialog scrolls inside: part of it is out of sight');
      const buttons = [...dialog.querySelectorAll('.dialog-actions button')].filter(el => el.getClientRects().length);
      if (new Set(buttons.map(el => Math.round(el.getBoundingClientRect().top))).size > 1) problems.push('actions on more than one line');
      if (buttons.some(clipped) || buttons.some(el => el.getBoundingClientRect().right > box.right || el.getBoundingClientRect().left < box.left)) problems.push('an action is clipped');
      for (const el of dialog.querySelectorAll('p, dd, dt, h2, strong')) if (el.getClientRects().length && clipped(el)) problems.push('text clipped: ' + el.className);
    }
    return problems.length ? name + ': ' + problems.join('; ') : '';
  }, label);
  const focused = () => page.evaluate(() => document.activeElement?.dataset?.action || document.activeElement?.id || document.activeElement?.tagName);
  const collapsed = () => page.evaluate(() => document.querySelector('.naw[data-native-surface="sidebar"]')?.dataset.collapsed === 'true');
  const problems = [];
  let shown = 'zh';
  // Wide first in both languages, then narrow: once the window is narrow the sidebar stays a rail.
  for (const [language, width, height] of [['zh', 1280, 800], ['en', 1280, 800], ['en', 860, 600], ['zh', 860, 600]]) {
    const say = (key, params) => locale.format(language, key, params), limit = '$2.00', tag = `${language}-${width}`, rail = width < 1000;
    if (language !== shown) {
      await page.locator('#setup-button').click(); await page.locator('#setup-dialog').waitFor({ state: 'visible' });
      await page.locator('#ui-language').selectOption(language);
      await until(async () => await page.locator('#new-session').getAttribute('aria-label') === say('sidebar.newSession'), 'The interface follows the language', 15000);
      await page.keyboard.press('Escape'); await page.locator('#setup-dialog').waitFor({ state: 'hidden' });
      assert.equal((await closed()).text, false, 'Still nothing about a butler after a language switch');
      shown = language;
    }
    await size(width, height);
    await until(async () => await collapsed() === rail, `${tag}: the sidebar is ${rail ? 'a rail' : 'expanded'}`, 15000);
    await mount(language);
    const look = async name => { const problem = await fits(`${tag} ${name}`); if (problem) problems.push(problem); await shot(`${name}-${tag}`); };
    // The whole task: nothing there, designate after a complete confirmation, see why it cannot start, revoke.
    await give(none);
    await row().waitFor({ state: 'visible' });
    assert.equal(await row().getAttribute('aria-label'), say('butler.rowLabel', { state: say('butler.row.empty') }));
    assert.equal(await row().getAttribute('title'), say('butler.rowLabel', { state: say('butler.row.empty') }));
    // Expanded, the name and the state are written out; as a rail, one square button whose name and tooltip say both.
    assert.equal((await row().innerText()).replace(/\s+/g, ' ').trim(), rail ? '◆' : `${say('butler.name')} ${say('butler.row.empty')}`);
    if (rail) { const box = await row().boundingBox(); assert.deepEqual([Math.round(box.width), Math.round(box.height)], [38, 38], 'Rail button is 38 by 38'); }
    assert.equal(await page.evaluate(() => window.butlerEntryCheck.row.nextElementSibling.nextElementSibling.id), 'new-session', 'The row sits directly above "new session"');
    await look('row-empty');
    await row().click(); await dialog().waitFor({ state: 'visible' });
    assert.equal(await focused(), 'done', 'Opening puts the focus on Done');
    assert.equal((await dialog().locator('.butler-note:visible').first().innerText()).trim(), say('butler.note.empty'));
    assert.deepEqual(await dialog().locator('.dialog-actions:visible button').evaluateAll(list => list.map(el => el.dataset.action)), ['designate', 'done']);
    await look('empty');
    // What the main process answers in this version: nothing designated and no designation accepted. Said, with no button.
    await give({ ...none, offer: undefined, actions: ['recheck'] });
    assert.deepEqual((await dialog().locator('.butler-note:visible').allInnerTexts()).map(value => value.trim()), [say('butler.note.empty'), say('butler.note.designateLater')]);
    assert.deepEqual(await dialog().locator('.dialog-actions:visible button').evaluateAll(list => list.map(el => el.dataset.action)), ['done']);
    await look('empty-no-designation');
    await give(none);
    await act('designate').click();
    assert.equal(await focused(), 'back', 'A question puts the focus on Cancel');
    assert.deepEqual((await dialog().locator('.butler-facts dt').allInnerTexts()).map(value => value.trim()), ['model', 'reads', 'never', 'sent', 'period', 'limit'].map(key => say(`butler.confirm.${key}`)));
    assert.deepEqual((await dialog().locator('.butler-facts dd').allInnerTexts()).map(value => value.trim()), [say('butler.confirm.modelValue', { name: 'DeepSeek pro', model: 'deepseek-v4-pro' }),
      say('butler.confirm.readsValue'), say('butler.confirm.neverValue'), say('butler.confirm.sentValue'), say('butler.confirm.periodValue'), say('butler.confirm.limitValue', { limit })]);
    assert.equal((await dialog().locator('.butler-not-yet').innerText()).trim(), say('butler.confirm.notYet'));
    assert.equal(await dialog().locator('input, textarea, select').count(), 0, 'No field takes a key or anything else');
    assert.deepEqual(await calls(), [], 'Asking is not designating');
    await look('confirm');
    await act('confirmDesignate').click();
    assert.deepEqual(await calls(), [['designate', 0]], 'The call carries the revision the page was drawn for, the one shape the main process accepts');
    // What the main process would answer in this version: designated, and it cannot start.
    await give(gallery[0][1]);
    assert.equal(await row().getAttribute('aria-label'), say('butler.rowLabel', { state: say('butler.row.blockedBuild') }));
    assert.deepEqual((await dialog().locator('.butler-note:visible').allInnerTexts()).map(value => value.trim()), [say('butler.note.blockedBuild'), say('butler.note.alsoMissingKey')]);
    assert.deepEqual((await dialog().locator('.quiet:visible').allInnerTexts()).map(value => value.trim().replace(/ /g, ' ')), [say('butler.model', { name: 'DeepSeek pro', model: 'deepseek-v4-pro' }), say('butler.usage.unverified', { limit }).replace(/ /g, ' ')]);
    assert.deepEqual(await dialog().locator('.dialog-actions:visible button').evaluateAll(list => list.map(el => el.dataset.action)), ['revoke', 'done']);
    const [left, next] = await dialog().locator('.dialog-actions:visible button').evaluateAll(list => list.slice(0, 2).map(el => el.getBoundingClientRect()).map((box, index) => index ? box.left : box.right));
    assert.ok(next - left > 60, 'Revoking sits apart from the everyday actions');
    await look('blocked-build-nokey');
    await act('revoke').click();
    assert.equal(await focused(), 'back'); assert.equal((await dialog().locator('.butler-note:visible').innerText()).trim(), say('butler.revoke.text'));
    await look('revoke');
    await act('back').click(); assert.deepEqual(await calls(), [['designate', 0]], 'Cancelling revokes nothing');
    await act('revoke').click(); await act('confirmRevoke').click();
    assert.deepEqual(await calls(), [['designate', 0], ['revoke', 1]]);
    await give(none);
    assert.equal(await row().getAttribute('aria-label'), say('butler.rowLabel', { state: say('butler.row.empty') }));
    // The other states the view can answer, for when the core gives their fields.
    for (const [name, view, state, keys] of gallery.slice(1)) {
      await give(view);
      assert.equal(await dialog().getAttribute('data-butler-state'), state);
      const text = (await dialog().innerText()).replace(/\s+/g, ' ');
      for (const key of keys) assert.ok(text.includes(say(key).replace(/\s+/g, ' ')), `${tag} ${name}: ${key}`);
      await look(name);
    }
    await act('done').click(); await dialog().waitFor({ state: 'hidden' });
    await look('row-held');
    await give(undefined);
    assert.equal(await row().isVisible(), false, 'Without a view the row is hidden again');
    await unmount();
    assert.equal(await collapsed(), rail);
    checks.push(`${tag}${rail ? ' (sidebar as a rail)' : ''}: empty, "none can be designated in this version", confirmation, this version's "cannot start", revoke, and the ${gallery.length - 1} other states are drawn`);
  }
  assert.deepEqual(problems, [], 'Nothing clipped, no dialog off the window, the actions on one line');
  assert.deepEqual(await closed(), { row: true, rowBeforeNew: true, dialog: true, entry: 'function', text: false, module: 'function', view: '{"visible":false}' });
  assert.equal((await client.call('initial')).sessions.length, 0); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, screenshots: shots.length, nativeProgramsStarted: 0, sessions: 0, promptsSent: 0, paidModelCalls: 0, evidence }));
})().catch(async error => {
  if (page && !page.isClosed()) { fs.writeFileSync(path.join(evidence, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {}); }
  console.error(error.stack, '\nEvidence:', evidence); process.exitCode = 1;
}).finally(testScratch.cleanup(cleanup));
