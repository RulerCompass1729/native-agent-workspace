const testScratch = require('./fixtures/test-scratch.cjs');
// Real Electron and NAW's own backend service. No native program is started, no butler exists and no model is called.
// 1. The product as it is: the butler entry is closed, so nothing offers the read log and its dialog stays shut.
// 2. The read path end to end. A real read log is written into the isolated profile by the product's own read log
//    module, as the core would write it. A dialog placed beside the product's hidden one is bound to the product's
//    own module, stylesheet and catalog and to the window's real `workspace.butlerReview`, so every record on screen
//    came through the real person-only call from the real file. Only the button that would open it is missing,
//    because the entry is closed.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = testScratch.playwright(require('playwright'));
const locale = require('../app/ui-locale.js');
const { ButlerReadAudit } = require('../app/butler-read-audit.cjs');
const { readsView } = require('../app/butler-reads-view.js');
const root = path.resolve(__dirname, '..');
if (!process.env.NAW_APP_EXECUTABLE) testScratch.childProcess.execFileSync(process.execPath, [path.join(root, 'scripts/build-ui.cjs')]);
const { connectService } = require('../app/service-client.cjs');
const base = testScratch.directory(path.join(os.tmpdir(), 'naw-butler-reads-'));
const profile = path.join(base, 'profile'); fs.mkdirSync(profile, { mode: 0o700 });
const evidence = process.env.NAW_EVIDENCE_DIR || path.join(base, 'evidence'); fs.mkdirSync(evidence, { recursive: true });
let application, page, client;
const errors = [], checks = [], shots = [], sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 30000) { const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await sleep(80); } throw Error(label); }
async function cleanup() {
  if (application) await application.close().catch(() => {});
  if (client) { try { await client.call('shutdown'); } catch { /* service already gone */ } finally { client.close(); } }
}
// The log as the core would write it: synthetic identities and space ids, times around now so that the newest
// records fall on the current UTC day whatever the hour.
const MINUTE = 60 * 1000, DAY = 24 * 3600 * 1000, NOW = Date.now(), SPACE = '11111111-1111-4111-8111-111111111111', token = {};
const logFile = path.join(profile, 'butler-business-reads.jsonl');
let clock = NOW;
const audit = new ButlerReadAudit(profile, { authorizePerson: value => value === token, now: () => clock });
function write(at, kind, { spaceId = null, count = 1, more = false, revision = 3 } = {}) {
  clock = at;
  audit.recordPage({ actor: { sessionId: 'butler-session-synthetic', nativeId: 'butler-native-synthetic', selectionRevision: revision, runnerRef: 'butler-runner-synthetic' },
    query: { kind, spaceId: kind === 'spaces' ? null : spaceId, limit: 50, ...(kind === 'deliveries' ? { fromTime: at - DAY, throughTime: at } : {}) },
    result: { count, recordRefs: Array.from({ length: count }, (_, index) => kind === 'spaces' ? `naw:space:${index ? SPACE : 'shared'}` : `naw:space:${spaceId}/${kind === 'queue' ? 'item' : 'event'}:synthetic-${index}`), scanned: count + (more ? 5 : 0), truncated: more } });
}
const all = () => { const records = []; let after = 0, through = 0;
  for (;;) { const result = audit.read(token, { afterSequence: after, limit: 50 }); records.push(...result.records); through = result.throughSequence; if (!result.truncated) break; after = result.nextAfterSequence; }
  return { records, through }; };
(async () => {
  const serviceCwd = path.join(profile, 'workspace'); fs.mkdirSync(serviceCwd, { mode: 0o700 });
  const env = { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: serviceCwd, NAW_TEST_PARENT_PID: String(process.pid) };
  for (const key of ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'NAW_RUNTIME_CONFIG', 'DEEPSEEK_API_KEY', 'NAW_TEST_BUTLER_ENTRY']) delete env[key];
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env, timeout: 60000 });
  await until(async () => { for (const p of application.windows()) if (!p.isClosed() && await p.locator('#new-session').count().catch(() => 0)) { page = p; return true; } return false; }, 'Main window', 60000);
  page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  client = await connectService(profile, 'butler-reads-test');
  const shot = async name => { await page.screenshot({ path: path.join(evidence, name + '.png') }); shots.push(name); };
  const size = async (width, height) => { await application.evaluate(({ BrowserWindow }, [w, h]) => { for (const win of BrowserWindow.getAllWindows()) win.setContentSize(w, h); }, [width, height]); await until(async () => await page.evaluate(w => innerWidth === w, width), `Window ${width} wide`, 10000); };

  // 1. The product as it is.
  await size(1280, 800);
  const closed = () => page.evaluate(() => { const dialog = document.getElementById('butler-reads-dialog'), row = document.getElementById('butler-row');
    return { dialog: Boolean(dialog) && !dialog.open && dialog.getClientRects().length === 0, bound: Boolean(dialog?.querySelector('h2')), row: row.hidden, module: typeof window.nativeWorkspaceButlerReads?.bind,
      text: /大管家|Butler|读过什么|has read/.test(document.querySelector('.sidebar').innerText + document.querySelector('main').innerText) }; });
  assert.deepEqual(await closed(), { dialog: true, bound: true, row: true, module: 'function', text: false });
  assert.equal(fs.existsSync(logFile), false, 'Starting the app writes no read log');
  checks.push('With the entry closed (every ordinary launch) the read log dialog is in the page, shut and invisible, and nothing offers it');

  // 2. A real log, read through the real person-only call.
  const midnight = Date.parse(new Date(NOW).toISOString().slice(0, 10) + 'T00:00:00Z');
  for (let index = 0; index < 58; index++) write(midnight - DAY + 10 * MINUTE + index * 24 * MINUTE, index % 3 === 2 ? 'deliveries' : index % 3 ? 'queue' : 'spaces', { spaceId: index % 2 ? SPACE : 'shared', count: index % 5, more: index % 7 === 0 && index % 5 > 0, revision: 2 });
  for (let index = 0; index < 6; index++) write(midnight + index * MINUTE, index % 2 ? 'queue' : 'spaces', { spaceId: SPACE, count: 2 });
  const { records, through } = all(); assert.equal(through, 64);
  const mount = language => page.evaluate(lang => {
    const dialog = document.createElement('dialog'); dialog.id = 'butler-reads-dialog-check'; dialog.className = 'butler-reads'; dialog.setAttribute('closedby', 'any');
    document.getElementById('butler-reads-dialog').after(dialog);
    const reads = window.nativeWorkspaceButlerReads.bind({ dialog, document, api: window.workspace, text: (key, params) => window.nativeWorkspaceLocale.format(lang, key, params), spaceName: id => id === 'shared' ? 'Shared (this window)' : null });
    window.butlerReadsCheck = { reads, dialog };
  }, language);
  const unmount = () => page.evaluate(() => { const { reads, dialog } = window.butlerReadsCheck; reads.dispose(); dialog.remove(); delete window.butlerReadsCheck; });
  const dialog = () => page.locator('#butler-reads-dialog-check'), settled = state => page.waitForFunction(value => window.butlerReadsCheck.dialog.dataset.readsState === value, state);
  const rows = () => dialog().locator('tbody tr:not(.butler-reads-day)'), days = () => dialog().locator('tr.butler-reads-day').allInnerTexts().then(list => list.map(value => value.trim()));
  const fits = label => page.evaluate(name => {
    const d = window.butlerReadsCheck.dialog, list = d.querySelector('.butler-reads-list'), box = d.getBoundingClientRect(), problems = [], clipped = el => el.scrollWidth > el.clientWidth + 1;
    if (box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight) problems.push('dialog outside the window');
    if (d.scrollHeight > d.clientHeight + 1 || clipped(d)) problems.push('the dialog itself scrolls');
    if (list && clipped(list)) problems.push('the list scrolls sideways');
    const buttons = [...d.querySelectorAll('.dialog-actions button')].filter(el => el.getClientRects().length);
    if (new Set(buttons.map(el => Math.round(el.getBoundingClientRect().top))).size > 1) problems.push('actions on more than one line');
    if (buttons.some(clipped) || buttons.some(el => el.getBoundingClientRect().bottom > box.bottom)) problems.push('an action is clipped');
    for (const el of d.querySelectorAll('p, h2, th, td')) if (el.getClientRects().length && clipped(el)) problems.push('text clipped: ' + el.tagName);
    if (d.querySelectorAll('input, textarea, select, a, form').length) problems.push('a field or link');
    return problems.length ? name + ': ' + problems.join('; ') : '';
  }, label);
  const problems = [];
  let shown = 'zh';
  for (const [language, width, height] of [['zh', 1280, 800], ['en', 1280, 800], ['en', 860, 600], ['zh', 860, 600]]) {
    const say = (key, params) => locale.format(language, key, params), tag = `${language}-${width}`;
    if (language !== shown) {
      await page.locator('#setup-button').click(); await page.locator('#setup-dialog').waitFor({ state: 'visible' });
      await page.locator('#ui-language').selectOption(language);
      await until(async () => await page.locator('#new-session').getAttribute('aria-label') === say('sidebar.newSession'), 'The interface follows the language', 15000);
      await page.keyboard.press('Escape'); await page.locator('#setup-dialog').waitFor({ state: 'hidden' }); shown = language;
    }
    await size(width, height); await mount(language);
    const look = async name => { const problem = await fits(`${tag} ${name}`); if (problem) problems.push(problem); await shot(`${name}-${tag}`); };
    // What the dialog must show is what the same view makes of the same records, in this machine's own zone.
    const view = readsView({ records: records.slice(-50), through, now: Date.now(), spaceNames: id => id === 'shared' ? 'Shared (this window)' : null });
    await page.evaluate(() => { window.butlerReadsCheck.reads.open(); }); await settled('records');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'done', 'Opening puts the focus on Done');
    assert.equal((await dialog().locator('.butler-reads-today').innerText()).trim(), say('butler.reads.today', { from: view.today.from, pages: 6, left: 58, limit: 64, resets: view.today.resets }));
    assert.equal((await dialog().locator('p.quiet').nth(1).innerText()).trim(), say('butler.reads.listed', { total: 64, shown: 50 }));
    assert.equal(await dialog().locator('.butler-reads-storage').isVisible(), false, 'A small log file is not warned about');
    assert.deepEqual(await days(), view.days.map(day => say('butler.reads.day', { from: day.from, through: day.through, day: day.day, pages: day.pages })));
    assert.deepEqual([view.days.length, view.days[0].pages, view.days[1].pages], [2, 6, 58]); assert.equal(await rows().count(), 50);
    const cells = async index => (await rows().nth(index).locator('td').allInnerTexts()).map(value => value.trim()), expect = row => [row.time,
      row.kind === 'deliveries' ? say('butler.reads.kind.deliveries', { from: row.window.from, through: row.window.through }) : say(`butler.reads.kind.${row.kind}`),
      !row.space ? say('butler.reads.spaceNone') : row.space.name || say('butler.reads.spaceUnknown', { id: row.space.short }), say(row.more ? 'butler.reads.countMore' : 'butler.reads.count', { count: row.count }), say('butler.reads.revision', { revision: row.revision })];
    const flat = view.days.flatMap(day => day.rows);
    for (const index of [0, 5, 6, 7, 8, 20, 49]) assert.deepEqual(await cells(index), expect(flat[index]), `${tag} row ${index}`);
    const text = await dialog().innerText();
    assert.match(text, language === 'zh' ? /因容量不足被扣下、未发给模型的页仍计入每天 64 页/ : /Pages withheld for lack of capacity still count toward the daily 64 pages, even though they were not sent to the model/);
    assert.equal(/butler-session-synthetic|butler-native-synthetic|butler-runner-synthetic|synthetic-\d|naw:space/.test(text), false, 'No session, runner or record reference reaches the page');
    assert.equal(await page.evaluate(() => window.butlerReadsCheck.dialog.querySelector('.butler-reads-wrap').dataset.more), 'true', 'Rows below the fold are announced');
    await look('reads');
    // Earlier records: the remaining fourteen, and then nothing more to ask for.
    await dialog().locator('button[data-action="older"]').click(); await until(async () => await rows().count() === 64, 'The earlier records arrive');
    assert.equal((await dialog().locator('p.quiet').nth(1).innerText()).trim(), say('butler.reads.listedAll', { total: 64 })); assert.equal(await dialog().locator('button[data-action="older"]').isVisible(), false);
    await dialog().locator('.butler-reads-list').evaluate(list => { list.scrollTop = list.scrollHeight; });
    await until(async () => await page.evaluate(() => window.butlerReadsCheck.dialog.querySelector('.butler-reads-wrap').dataset.more) === 'false', 'The fade goes at the end of the list');
    // Scrolled to the oldest rows, their day is still on screen, pinned under the column names.
    const pinned = await page.evaluate(() => { const list = window.butlerReadsCheck.dialog.querySelector('.butler-reads-list'), heads = [...list.querySelectorAll('tr.butler-reads-day th')], last = heads[heads.length - 1];
      return { offset: Math.round(last.getBoundingClientRect().top - list.getBoundingClientRect().top), visible: last.getBoundingClientRect().bottom <= list.getBoundingClientRect().bottom }; });
    assert.deepEqual(pinned, { offset: 30, visible: true });
    await look('reads-earlier');
    await dialog().locator('button[data-action="done"]').click(); await dialog().waitFor({ state: 'hidden' });
    await until(async () => await dialog().locator('table').count() === 0, 'Closing drops what was read');
    await unmount();
    checks.push(`${tag}: a real log of 64 pages over two UTC days is read through the real call and shown newest first; earlier records on request`);
  }
  // The log file filling up. A real file of 24 MiB is not written here: the records are the real ones through the
  // real call, and only the core's report of how full the file is is replaced on its way to the dialog.
  // Four states: the core's prewarning; a file at its cap (which the log still reads from, for the person); an
  // answer without the report, where the dialog says it cannot tell how full the file is; and a newest record this
  // version does not understand, where it says it cannot tell the day's count.
  for (const language of ['zh', 'en']) for (const [state, change, key, params] of [['nearly-full', { used: 25 * 1048576 + 1 }, 'storageWarning', { used: '25.1', max: '32' }],
    ['full', { used: 32 * 1048576 }, 'storageFull', { used: '32', max: '32' }], ['report-missing', { drop: true }, 'storageUnknown'], ['newest-not-understood', { newest: true }, null]]) {
    const say = (key, params) => locale.format(language, key, params);
    await page.evaluate(([lang, change]) => {
      const dialog = document.createElement('dialog'); dialog.id = 'butler-reads-dialog-check'; dialog.className = 'butler-reads'; dialog.setAttribute('closedby', 'any');
      document.getElementById('butler-reads-dialog').after(dialog);
      const api = { butlerReview: async (...args) => { const answer = await window.workspace.butlerReview(...args); if (!answer.storage || answer.storage.warning !== false) throw Error('The real answer must carry an unwarned report');
        if (change.drop) { const { storage, ...rest } = answer; return rest; }
        if (change.newest) return { ...answer, records: answer.records.map(record => record.sequence === answer.throughSequence ? { ...record, version: 2 } : record) };
        return { ...answer, storage: { ...answer.storage, usedBytes: change.used, remainingBytes: answer.storage.maxBytes - change.used, warning: true } }; } };
      const reads = window.nativeWorkspaceButlerReads.bind({ dialog, document, api, text: (key, params) => window.nativeWorkspaceLocale.format(lang, key, params), spaceName: id => id === 'shared' ? 'Shared (this window)' : null });
      window.butlerReadsCheck = { reads, dialog };
    }, [language, change]);
    await page.evaluate(() => { window.butlerReadsCheck.reads.open(); }); await settled('records');
    const count = (await dialog().locator('.butler-reads-today').innerText()).trim();
    if (key) {
      assert.equal((await dialog().locator('.butler-reads-storage').innerText()).trim(), say(`butler.reads.${key}`, params));
      // The day's count is still given beside it.
      assert.equal(count.includes(say('butler.reads.todayUnknownNewest', { from: '\u0000', limit: 64, resets: '\u0000' }).split('\u0000')[1]), false);
    } else {
      // Where the day's count would be, the dialog says it cannot tell, and why; the file itself is not warned about.
      for (const part of say('butler.reads.todayUnknownNewest', { from: '\u0000', limit: 64, resets: '\u0000' }).split('\u0000').filter(Boolean)) assert.ok(count.includes(part.trim()), `${language}: ${part} in ${count}`);
      assert.equal(await dialog().locator('.butler-reads-storage').isVisible(), false);
      // The newest day's own header does not contradict it: its number is said as a lower bound.
      // The words between the day and the number are what tell this header from the ordinary one, in either language.
      const least = say('butler.reads.dayAtLeast', { from: 'F', through: 'T', day: '\u0001', pages: '\u0002' }).split('\u0001')[1].split('\u0002')[0].trim();
      const plain = say('butler.reads.day', { from: 'F', through: 'T', day: '\u0001', pages: '\u0002' }).split('\u0001')[1].split('\u0002')[0].trim();
      assert.ok(least.length > plain.length && !plain.includes(least), 'The two headers differ in these words');
      assert.ok((await days())[0].includes(least), `${language}: "${least}" in ${(await days())[0]}`);
    }
    assert.equal(await dialog().locator('.butler-reads-today').isVisible(), true); assert.ok(await rows().count() > 0, 'The records are still listed');
    const problem = await fits(`${language}-860 reads-file-${state}`); if (problem) problems.push(problem); await shot(`reads-file-${state}-${language}-860`);
    await dialog().locator('button[data-action="done"]').click(); await dialog().waitFor({ state: 'hidden' }); await unmount();
  }
  checks.push('The core\'s warning that the log file is filling up, a file already at its cap, a missing report ("cannot tell how full") and a newest record that is not understood ("cannot tell the day\'s count") are each said, in both languages');
  // Last, because it cannot be undone while the app runs: the log is damaged. It is said to be unreadable, with the
  // rule and what to do; nothing is shown as if it were the log; and putting the file back does not help until NAW
  // is reopened, which is what the dialog says.
  {
    const say = (key, params) => locale.format('zh', key, params);
    await mount('zh'); await page.evaluate(() => { window.butlerReadsCheck.reads.open(); }); await settled('records');
    const kept = fs.readFileSync(logFile); fs.appendFileSync(logFile, 'not a record\n');
    await dialog().locator('button[data-action="refresh"]').click(); await settled('unavailable');
    assert.deepEqual((await dialog().locator('.butler-reads-note:visible').allInnerTexts()).map(value => value.trim()), [say('butler.reads.unavailable'), say('butler.reads.unavailableHelp')]);
    assert.equal(await rows().count(), 0); assert.equal(await dialog().locator('.butler-reads-today').isVisible(), false);
    assert.equal((await dialog().locator('button[data-action="refresh"]').innerText()).trim(), say('butler.reads.retry'));
    const problem = await fits('zh-860 reads-unreadable'); if (problem) problems.push(problem); await shot('reads-unreadable-zh-860');
    fs.writeFileSync(logFile, kept, { mode: 0o600 });
    await dialog().locator('button[data-action="refresh"]').click();
    await page.waitForFunction(() => window.butlerReadsCheck.dialog.dataset.readsState === 'loading').catch(() => {}); await settled('unavailable');
    assert.equal(await rows().count(), 0, 'Reading again does not help while the app keeps running');
    await dialog().locator('button[data-action="done"]').click(); await dialog().waitFor({ state: 'hidden' }); await unmount();
    checks.push('A damaged log is said to be unreadable with the rule and the next step; it stays unreadable after the file is put back, until NAW is reopened');
  }
  assert.deepEqual(problems, [], 'Nothing clipped, no dialog off the window, only the list scrolls, the actions on one line');
  // The person's reading consumed none of the butler's pages and changed nothing in the log.
  assert.deepEqual(new ButlerReadAudit(profile, { authorizePerson: value => value === token }).read(token, { afterSequence: 0, limit: 1 }).throughSequence, 64); assert.deepEqual(await closed(), { dialog: true, bound: true, row: true, module: 'function', text: false });
  assert.equal((await client.call('initial')).sessions.length, 0); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, screenshots: shots.length, nativeProgramsStarted: 0, sessions: 0, promptsSent: 0, paidModelCalls: 0, evidence }));
})().catch(async error => {
  if (page && !page.isClosed()) { fs.writeFileSync(path.join(evidence, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {}); }
  console.error(error.stack, '\nEvidence:', evidence); process.exitCode = 1;
}).finally(testScratch.cleanup(cleanup));
