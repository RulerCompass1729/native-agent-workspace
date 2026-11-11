const testScratch = require('./fixtures/test-scratch.cjs');
// Real Electron and NAW's own backend service; no native program is started and no model is called.
// The person's Settings selection for Codex points at a program that is gone. The backend that takes
// new sessions cannot run Codex: the workspace must say so in its alert line, in both languages, and
// stop saying so as soon as the selection is set back to automatic discovery in Settings.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = testScratch.playwright(require('playwright'));
const locale = require('../app/ui-locale.js');
const root = path.resolve(__dirname, '..');
if (!process.env.NAW_APP_EXECUTABLE) testScratch.childProcess.execFileSync(process.execPath, [path.join(root, 'scripts/build-ui.cjs')]);
const { connectService } = require('../app/service-client.cjs');
const base = testScratch.directory(path.join(os.tmpdir(), 'naw-program-notice-'));
const profile = path.join(base, 'profile'); fs.mkdirSync(profile, { mode: 0o700 });
const gone = path.join(base, 'removed-version', 'codex'), settings = path.join(profile, 'runtime-locations.json');
let application, page, client;
const errors = [], checks = [], sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 30000) { const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await sleep(80); } throw Error(label); }
async function cleanup() {
  if (application) await application.close().catch(() => {});
  if (client) { try { await client.call('shutdown'); } catch { /* service already gone */ } finally { client.close(); } }
}
(async () => {
  fs.writeFileSync(settings, JSON.stringify({ codex: gone }), { mode: 0o600 });
  const serviceCwd = path.join(profile, 'workspace'); fs.mkdirSync(serviceCwd, { mode: 0o700 });
  const env = { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: serviceCwd, NAW_TEST_PARENT_PID: String(process.pid) };
  for (const key of ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'NAW_RUNTIME_CONFIG']) delete env[key];
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env, timeout: 60000 });
  await until(async () => { for (const p of application.windows()) if (!p.isClosed() && await p.locator('#new-session').count().catch(() => 0)) { page = p; return true; } return false; }, 'Main window', 60000);
  page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  client = await connectService(profile, 'program-notice-test');
  const first = await client.call('initial');
  assert.ok(first.capabilities.includes('programAvailabilityV1'));
  assert.deepEqual([first.available.codex, first.available.claude, first.available.python], [false, true, true], 'Only the selected program that is gone is unavailable; this machine has Claude Code and Python 3');
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), { codex: gone }, 'The person\'s own selection is not removed');

  const alert = page.locator('#alert'), expected = language => locale.format(language, 'error.warning.programsMissing', { programs: 'Codex' });
  await until(async () => await alert.isVisible() && (await alert.innerText()).trim() === expected('zh'), 'The alert names the program the active backend cannot run', 20000);
  checks.push('With a Settings selection that is gone, the workspace says the active backend cannot find Codex');
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'program-notice-shown.png') }); }

  await page.locator('#setup-button').click(); await page.locator('#setup-dialog').waitFor({ state: 'visible' });
  const rows = page.locator('#setup-status .setup-program');
  await until(async () => await rows.count() === 3, 'Three program rows', 15000);
  const codexRow = rows.filter({ hasText: 'Codex CLI' }); assert.equal(await codexRow.count(), 1);
  assert.equal((await codexRow.locator('strong').innerText()).trim(), locale.format('zh', 'setup.program', { program: 'Codex CLI', status: locale.format('zh', 'setup.missing') }));
  assert.equal((await codexRow.locator('.program-path').innerText()).trim(), gone);
  await page.locator('#ui-language').selectOption('en');
  await until(async () => (await alert.innerText()).trim() === expected('en'), 'The alert follows the interface language', 15000);
  checks.push('The alert is shown in Chinese and in English, and Settings shows the selected Codex as not found');

  // Exactly one program has a selection, so exactly one row offers automatic discovery.
  const automatic = page.locator('#setup-status button', { hasText: locale.format('en', 'setup.automatic') });
  await until(async () => await automatic.count() === 1, 'One automatic-discovery button', 15000);
  assert.equal(await codexRow.locator('button', { hasText: locale.format('en', 'setup.automatic') }).count(), 1, 'It is the Codex row\'s');
  await automatic.click();
  await until(async () => !(await alert.isVisible()), 'The alert goes once Codex is found again', 20000);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), {});
  assert.equal((await client.call('initial')).available.codex, true);
  await until(async () => (await codexRow.locator('strong').innerText()).trim() === locale.format('en', 'setup.program', { program: 'Codex CLI', status: locale.format('en', 'setup.found') }), 'Settings shows Codex as found', 15000);
  checks.push('Setting the selection back to automatic discovery in Settings removes the alert at once');

  assert.equal((await client.call('initial')).sessions.length, 0); assert.deepEqual(errors, []);
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'program-notice-after.png') }); }
  console.log(JSON.stringify({ checks, nativeProgramsStarted: 0, sessions: 0, promptsSent: 0, paidModelCalls: 0, evidence: base }));
})().catch(async error => {
  if (page && !page.isClosed()) { fs.writeFileSync(path.join(base, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {}); }
  console.error(error.stack, '\nEvidence:', base); process.exitCode = 1;
}).finally(testScratch.cleanup(cleanup));
