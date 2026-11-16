const testScratch = require('./fixtures/test-scratch.cjs');
// The bell, on the real window and NAW's own backend service, over records the product's own modules wrote into an
// isolated profile. No native program is started and no model is called. The folder dialog and "show in Finder" are
// replaced inside the app's main process only, so that nothing opens on the desktop; everything else is the product's.
// 1. Nothing due: no bell. 2. A read log 33 days long: the bell with 1, its dialog, export of the old blocks into a
//    scratch folder (checked byte for byte), "知道了", and a restart that keeps it put away. 3. An operations block changed on disk: said, with "show in Finder" and no export. Both languages, 1280 and 860 wide.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = testScratch.playwright(require('playwright'));
const locale = require('../app/ui-locale.js');
const { ButlerReadAudit } = require('../app/butler-read-audit.cjs');
const { BlockLog } = require('../app/record-history.cjs');
const root = path.resolve(__dirname, '..');
if (!process.env.NAW_APP_EXECUTABLE) testScratch.childProcess.execFileSync(process.execPath, [path.join(root, 'scripts/build-ui.cjs')]);
const { connectService } = require('../app/service-client.cjs');
const base = testScratch.directory(path.join(os.tmpdir(), 'naw-record-reminders-'));
const evidence = process.env.NAW_EVIDENCE_DIR || path.join(base, 'evidence'); fs.mkdirSync(evidence, { recursive: true });
const out = path.join(base, 'exported'); fs.mkdirSync(out, { mode: 0o700 });
// The pages are an hour later than now, so that a block 30 days old is not just past the line by the time the app looks.
const DAY = 24 * 3600 * 1000, NOW = Date.now() + 3600 * 1000;
let application, page, client;
const errors = [], checks = [], shots = [], sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 30000) { const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await sleep(80); } throw Error(label); }
async function cleanup() {
  if (application) await application.close().catch(() => {});
  if (client) { try { await client.call('shutdown'); } catch { /* service already gone */ } finally { client.close(); } }
}
function profile(name) { const dir = path.join(base, name); fs.mkdirSync(dir, { mode: 0o700 }); fs.mkdirSync(path.join(dir, 'workspace'), { mode: 0o700 }); return dir; }
// One page a day on each of 33 days: 32 sealed daily blocks, the 2 oldest past 30 days.
function readLog(dir) {
  let clock; const audit = new ButlerReadAudit(dir, { now: () => clock });
  for (let n = 32; n >= 0; n--) { clock = NOW - n * DAY; audit.recordPage({ actor: { sessionId: 'butler-session-synthetic', nativeId: 'butler-native-synthetic', selectionRevision: 1, runnerRef: 'butler-runner-synthetic' },
    query: { kind: 'spaces', spaceId: null, limit: 50 }, result: { count: 0, recordRefs: [], scanned: 0, truncated: false } }); }
}
async function launch(dir) {
  const env = { ...process.env, NAW_DATA_DIR: dir, NAW_WORKSPACE: path.join(dir, 'workspace'), NAW_TEST_PARENT_PID: String(process.pid) };
  for (const key of ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'NAW_RUNTIME_CONFIG', 'DEEPSEEK_API_KEY', 'NAW_TEST_BUTLER_ENTRY']) delete env[key];
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env, timeout: 60000 });
  await until(async () => { for (const p of application.windows()) if (!p.isClosed() && await p.locator('#new-session').count().catch(() => 0)) { page = p; return true; } return false; }, 'Main window', 60000);
  page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  client = await connectService(dir, 'record-reminders-test');
  // Inside the app's main process only: the folder dialog answers with the scratch folder; Finder is not opened.
  await application.evaluate(({ dialog, shell }, folder) => { globalThis.revealed = []; globalThis.asked = [];
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); shell.showItemInFolder = target => { globalThis.revealed.push(target); };
    // The person's final "删除" in the native confirmation, answered here; what it asked is kept for the check.
    dialog.showMessageBox = async (_window, options) => { globalThis.asked.push({ message: options.message, buttons: options.buttons }); return { response: 1 }; }; }, out);
}
async function stop() { shown = null; await application.close(); application = null; try { await client.call('shutdown'); } catch { /* gone */ } client.close(); client = null; }
const size = async (width, height) => { await application.evaluate(({ BrowserWindow }, [w, h]) => { for (const win of BrowserWindow.getAllWindows()) win.setContentSize(w, h); }, [width, height]); await until(async () => await page.evaluate(w => innerWidth === w, width), `Window ${width} wide`, 10000); };
const shot = async name => { await page.screenshot({ path: path.join(evidence, name + '.png') }); shots.push(name); };
let shown = null;
const language = async language => {
  if (shown === language) return;
  await page.locator('#setup-button').click(); await page.locator('#setup-dialog').waitFor({ state: 'visible' });
  await page.locator('#ui-language').selectOption(language);
  await until(async () => await page.locator('#new-session').getAttribute('aria-label') === locale.format(language, 'sidebar.newSession'), 'The interface follows the language', 15000);
  await page.keyboard.press('Escape'); await page.locator('#setup-dialog').waitFor({ state: 'hidden' }); shown = language;
};
// Nothing clipped: the dialog inside the window, no line wider than the dialog.
const fits = label => page.evaluate(name => {
  const d = document.getElementById('records-dialog'), r = d.getBoundingClientRect();
  if (r.left < 0 || r.top < 0 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5) return `${name}: the dialog leaves the window`;
  for (const el of d.querySelectorAll('*')) if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === 'visible' && el.clientWidth > 0) return `${name}: ${el.tagName}.${el.className} is wider than its box`;
  return null;
}, label);
(async () => {
  const problems = [];
  // 1. Nothing due.
  const empty = profile('empty'); await launch(empty); await size(1280, 800);
  await sleep(500); assert.equal(await page.locator('#records-button').isVisible(), true, 'Permanent bell with nothing due');
  await shot('no-bell-1280'); checks.push('The empty bell remains visible'); await stop();

  // 2. A read log 33 days long.
  const dir = profile('long'); readLog(dir); await launch(dir);
  let bell = page.locator('#records-button'), dialog = page.locator('#records-dialog'); const say = (lang, key, params) => locale.format(lang, key, params);
  for (const [lang, width, height] of [['zh', 1280, 800], ['en', 1280, 800], ['en', 860, 600], ['zh', 860, 600]]) {
    await size(width, height); await language(lang);
    await bell.waitFor({ state: 'visible' }); assert.equal(await page.locator('#records-badge').innerText(), '1');
    await shot(`bell-${lang}-${width}`);
    await bell.click(); await dialog.waitFor({ state: 'visible' });
    const text = await dialog.innerText();
    for (const key of ['records.title', 'records.name.butler-reads']) assert.ok(text.includes(say(lang, key)), `${lang}: ${key}`);
    assert.ok(text.includes(say(lang, 'records.item.age', { blocks: 2, oldest: new Date(NOW - 32 * DAY).toISOString().slice(0, 10), total: 33, size: '\u0000' }).split('\u0000')[0]), `${lang}: the age line`);
    const problem = await fits(`${lang}-${width} reminders`); if (problem) problems.push(problem); await shot(`reminders-${lang}-${width}`);
    // Export view: the two old blocks chosen; nothing can be sent before a folder is chosen.
    await dialog.locator('button[data-action="export"]').click(); await dialog.locator('input[type="checkbox"]').first().waitFor();
    assert.deepEqual([await dialog.locator('input[type="checkbox"]').count(), await dialog.locator('input[type="checkbox"]:checked').count()], [32, 2]);
    assert.equal(await dialog.locator('button[data-action="run"]').isDisabled(), true);
    const exportProblem = await fits(`${lang}-${width} export`); if (exportProblem) problems.push(exportProblem); await shot(`export-${lang}-${width}`);
    assert.equal(await dialog.locator('button[data-action="delete"]').isVisible(), false, 'No delete before a checked export');
    await dialog.locator('button[data-action="back"]').click(); await dialog.locator('button[data-action="acknowledge"]').waitFor();
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  }
  checks.push('A read log past 30 days: the bell with 1, its dialog and the export view, in both languages, at 1280 and 860 wide');
  // Export the two old blocks, then delete them: the native confirmation is asked, the files go, their entries stay
  // (numbers, days, counts, when), the read says so, and the permanent bell has no badge because nothing past 30 days is left.
  await size(1280, 800); await language('zh'); await bell.click(); await dialog.waitFor({ state: 'visible' });
  await dialog.locator('button[data-action="export"]').click(); await dialog.locator('input[type="checkbox"]').first().waitFor();
  await dialog.locator('button[data-action="choose"]').click(); await until(async () => !(await dialog.locator('button[data-action="run"]').isDisabled()), 'A folder chosen');
  await dialog.locator('button[data-action="run"]').click();
  await until(async () => (await dialog.innerText()).includes('大小和校验值都核对过'), 'Exported and checked');
  const store = path.join(dir, 'history', 'butler-reads'), copies = fs.readdirSync(path.join(out, 'butler-reads')).sort();
  assert.equal(copies.length, 2);
  for (const name of copies) assert.deepEqual(fs.readFileSync(path.join(out, 'butler-reads', name)), fs.readFileSync(path.join(store, name)), `${name} copied as it is`);
  assert.equal(await dialog.locator('button[data-action="delete"]').innerText(), say('zh', 'records.delete.button', { count: 2 }));
  await shot('exported-zh-1280'); checks.push('Export from the dialog copies the two old blocks, byte for byte, into the folder chosen; the copies are checked; nothing in NAW changes');
  await dialog.locator('button[data-action="delete"]').click();
  await until(async () => (await dialog.innerText()).includes(say('zh', 'records.delete.done', { count: 2 })), 'Deleted');
  assert.deepEqual(await application.evaluate(() => globalThis.asked), [{ message: say('zh', 'records.delete.question', { count: 2 }), buttons: [say('zh', 'records.delete.cancel'), say('zh', 'records.delete.confirm')] }]);
  for (const name of copies) assert.equal(fs.existsSync(path.join(store, name)), false, `${name} is gone from NAW`);
  for (const name of copies) assert.ok(fs.existsSync(path.join(out, 'butler-reads', name)), `${name} is still in the export`);
  const manifest = JSON.parse(fs.readFileSync(path.join(store, 'manifest.json'))), gone = manifest.blocks.filter(block => block.status === 'deleted');
  assert.deepEqual(gone.map(block => [block.name, block.count]), copies.map(name => [name, 1]));
  const read = new ButlerReadAudit(dir, { authorizePerson: value => value === 'person' }).read('person');
  assert.deepEqual(read.gaps.map(item => [item.fromSequence, item.throughSequence, Number.isSafeInteger(item.deletedAt)]), [[1, 1, true], [2, 2, true]], 'Read back, the two are said to be deleted, in their places');
  assert.equal(read.records.length, 31);
  await until(async () => await bell.isVisible() && await page.locator('#records-badge').innerText() === '', 'The permanent bell has no badge'); await shot('deleted-zh-1280');
  checks.push('Deleting the exported blocks asks the native confirmation; their files go from NAW (the export keeps them), their entries stay marked deleted, and the permanent bell has no badge');
  await page.keyboard.press('Escape'); await stop();
  // "知道了", on another record 33 days long: the reminder goes, while the bell stays after a restart.
  const kept = profile('kept'); readLog(kept); await launch(kept); await size(1280, 800); await language('zh');
  bell = page.locator('#records-button'); dialog = page.locator('#records-dialog');
  await bell.waitFor({ state: 'visible' }); await bell.click(); await dialog.waitFor({ state: 'visible' });
  await dialog.locator('button[data-action="acknowledge"]').click(); await until(async () => await bell.isVisible() && await page.locator('#records-badge').innerText() === '', 'The permanent bell has no badge');
  assert.ok((await dialog.innerText()).includes(say('zh', 'records.nothing'))); await shot('acknowledged-zh-1280');
  await page.keyboard.press('Escape'); await stop(); await launch(kept); await sleep(800);
  assert.equal(await page.locator('#records-button').isVisible(), true, 'Permanent bell after a restart');
  checks.push('"知道了" puts the reminder away, also after a restart'); await stop();

  // 3. An operations record with a sealed block changed on disk: background control stops rather than risk running an
  //    operation id again, and the bell says so. The blocks are written by the product's own block log.
  const broken = profile('broken'), operation = id => ({ id, actor: { id: 'agent', nativeId: 'native', provider: 'codex', name: 'Agent' }, command: { action: 'invoke', method: 'forward', arguments: [id], operation_id: id }, state: 'complete', at: NOW - 3 * DAY, finishedAt: NOW - 3 * DAY });
  const blocks = new BlockLog(broken, 'operations', () => {});
  blocks.append([{ time: NOW - 3 * DAY, value: operation('op-1') }], NOW - 2 * DAY); blocks.append([{ time: NOW - 3 * DAY, value: operation('op-2') }], NOW - DAY);
  const sealed = path.join(broken, 'history', 'operations', blocks.manifest.blocks[0].name);
  fs.writeFileSync(sealed, fs.readFileSync(sealed, 'utf8').replace('"op-1"', '"op-9"'), { mode: 0o600 });
  await launch(broken); await size(1280, 800); await language('zh');
  bell = page.locator('#records-button'); dialog = page.locator('#records-dialog');
  await bell.waitFor({ state: 'visible' }); await bell.click(); await dialog.waitFor({ state: 'visible' });
  const text = await dialog.innerText();
  assert.ok(text.includes(say('zh', 'records.name.operations')));
  assert.ok(text.includes(say('zh', 'records.item.unavailable')), 'Said: the record cannot be read, so background operations are stopped');
  assert.deepEqual([await dialog.locator('button[data-action="reveal"]').count(), await dialog.locator('button[data-action="export"]').count()], [1, 0]);
  await dialog.locator('button[data-action="reveal"]').click();
  await until(async () => (await application.evaluate(() => globalThis.revealed.length)) === 1, 'Shown in Finder');
  assert.equal(fs.realpathSync(await application.evaluate(() => globalThis.revealed[0])), fs.realpathSync(path.join(broken, 'history', 'operations')));
  const problem = await fits('zh-1280 unreadable'); if (problem) problems.push(problem); await shot('unreadable-zh-1280');
  checks.push('An operations block changed on disk stops background control, and the bell says so, with "show in Finder" and no export'); await page.keyboard.press('Escape');
  assert.deepEqual(problems, []); assert.deepEqual(errors, []);
  assert.equal((await client.call('initial')).sessions.length, 0);
  console.log(JSON.stringify({ checks, screenshots: shots.length, nativeProgramsStarted: 0, sessions: 0, promptsSent: 0, paidModelCalls: 0, evidence }));
})().catch(async error => {
  if (page && !page.isClosed()) { fs.writeFileSync(path.join(evidence, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {}); }
  console.error(error.stack, '\nEvidence:', evidence); process.exitCode = 1;
}).finally(testScratch.cleanup(cleanup));
