const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// Real Electron + real Claude Code 2.1.322 under the loopback model fixture (B11):
// the launcher points at an unqualified "2.1.999", so NAW must start the new session
// with the qualified 2.1.322 installed beside it, bind it as usual and say so (B3
// fallback). In the background NAW runs the mod's own tests with the unqualified version,
// offline, and keeps the result for the manual qualification (claude-mod-check.cjs).
// No prompt is sent; any model request gets a fixed local reply. Nothing paid.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = testScratch.playwright(require('playwright'));
const loopback = require('./fixtures/loopback-model.cjs'), locale = require('../app/ui-locale.js');
const root = path.resolve(__dirname, '..');
if (!process.env.NAW_APP_EXECUTABLE) testScratch.childProcess.execFileSync(process.execPath, [path.join(root, 'scripts/build-ui.cjs')]);
const { connectService } = require('../app/service-client.cjs');
const base = testScratch.directory(path.join(os.tmpdir(), 'naw-native-claude-pin-'));
const profile = path.join(base, 'profile'), config = path.join(base, 'claude'), userHome = path.join(base, 'home'), versions = path.join(base, 'versions'), bin = path.join(base, 'bin');
for (const dir of [profile, config, userHome, versions, bin]) fs.mkdirSync(dir, { mode: 0o700 });
const binary = process.env.NAW_CLAUDE_BIN || path.join(os.homedir(), '.local/share/claude/versions/2.1.322');
const nativeVersion = testScratch.childProcess.execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
assert.match(nativeVersion, /^2\.1\.322\b/, 'The fallback target in this trial is the qualified 2.1.322');
let application, page, client;
const errors = [], checks = [], sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 30000) { const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await sleep(80); } throw Error(label); }
function event(res, type, body) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`); }
// Fixed responses only: metadata calls get an empty JSON body, any message call a short fixed reply.
const fixture = loopback.create({ directory: base, provider: 'claude', respond: (req, res, body) => {
  if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: 100, data: [] })); return; }
  const request = JSON.parse(body);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  event(res, 'message_start', { message: { id: 'msg_local', type: 'message', role: 'assistant', model: request.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  event(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  event(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'FIXED_LOCAL_REPLY' } });
  event(res, 'content_block_stop', { index: 0 });
  event(res, 'message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
  event(res, 'message_stop', {}); res.end();
} });
const snapshot = () => client.call('initial');
const terminalText = async () => (await page.locator('#terminal-area .xterm-rows').evaluateAll(rows => rows.filter(el => el.checkVisibility()).map(el => el.innerText).join('\n'))).replace(/ /g, ' ');
function ownedNativeProcesses() {
  const marker = path.basename(base);
  return testScratch.childProcess.execFileSync('ps', ['-axE', '-ww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter(line => line.includes(marker) && / daemon run\b|bg-pty-host|bg-spare|^\s*\d+\s+\S*claude\S* |claude-message-tool\.cjs/.test(line))
    .map(line => ({ pid: Number(line.trim().split(/\s+/)[0]), daemon: / daemon run\b/.test(line) })).filter(p => p.pid);
}
async function cleanup() {
  if (application) await application.close().catch(() => {});
  if (client) { try { for (const s of (await snapshot()).sessions) await client.call('stop', s.id); await client.call('shutdown'); } catch { /* service already gone */ } finally { client.close(); } }
  for (let round = 0; round < 3 && ownedNativeProcesses().length; round++) {
    const owned = ownedNativeProcesses();
    for (const p of [...owned.filter(p => p.daemon), ...owned.filter(p => !p.daemon)]) { try { process.kill(p.pid, round ? 'SIGKILL' : 'SIGTERM'); } catch { /* gone */ } }
    await sleep(1500);
  }
  const survivors = ownedNativeProcesses().map(p => p.pid);
  await fixture.stop();
  if (survivors.length) throw Error('Owned native processes still alive: ' + survivors.join(','));
}
(async () => {
  await fixture.start(); await fixture.preflight();
  // The vendor layout: versions/<version> programs and a launcher link. The unqualified version is a
  // stub: asked for the mod's tests it is the real program (NAW's background check, which has no
  // network); started any other way it leaves a marker and fails, so a session that starts did not use it.
  const marker = path.join(base, 'unqualified-version-ran');
  fs.writeFileSync(path.join(versions, '2.1.999'), `#!/bin/sh\nif [ "$1" = plugin ] && [ "$2" = test ]; then exec '${binary}' "$@"; fi\necho ran > '${marker}'\nexit 1\n`, { mode: 0o700 });
  fixture.wrapper(binary, { file: path.join(versions, '2.1.322'), env: { HOME: userHome, CLAUDE_CONFIG_DIR: config }, args: ['--model', 'haiku'] });
  const launcher = path.join(bin, 'claude'); fs.symlinkSync(path.join(versions, '2.1.999'), launcher);
  const serviceCwd = path.join(profile, 'workspace'); fs.mkdirSync(serviceCwd, { mode: 0o700 });
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [fs.realpathSync(serviceCwd)]: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ awaySummaryEnabled: false }), { mode: 0o600 });
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify({ claude: launcher }), { mode: 0o600 });
  // This test may itself run inside a Claude Code session; none of that identity reaches the trial.
  const env = { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: serviceCwd, NAW_TEST_PARENT_PID: String(process.pid) };
  for (const key of ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL']) delete env[key];
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env, timeout: 60000 });
  await until(async () => { for (const p of application.windows()) if (!p.isClosed() && await p.locator('#new-session').count().catch(() => 0)) { page = p; return true; } return false; }, 'Main window', 60000);
  page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  client = await connectService(profile, 'native-claude-pin-test');

  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check();
  await page.locator('#session-name').fill('Fallback version'); await createIn(page, 'terminal');
  // Native first-run questions are answered in the native terminal, as a person would: trust for this
  // test's own temporary folder only (the native default is "No, exit"), then the fixture API key.
  const QUESTION = /Yes, I trust this folder|Do you want to use this API key/;
  const ready = async () => Boolean((await snapshot()).sessions[0]?.chatAvailable);
  await until(async () => QUESTION.test(await terminalText()) || await ready(), 'Startup', 60000);
  for (let step = 0; step < 4 && !(await ready()); step++) {
    const text = await terminalText();
    if (!QUESTION.test(text)) { await sleep(500); continue; }
    // Keys go in only once the native terminal accepts input and has the focus (as in the concurrent journey).
    await until(async () => !(await page.locator('#terminal-paste').isDisabled()), 'Native terminal input ready', 15000);
    await page.locator('#terminal-area .xterm-screen >> visible=true').click();
    await until(() => page.evaluate(() => Boolean(document.activeElement?.classList.contains('xterm-helper-textarea') && document.activeElement.closest('#terminal-area'))), 'Native terminal input focused', 15000);
    if (/Yes, I trust this folder/.test(text)) {
      assert.ok(text.replace(/\s*\n\s*/g, '').includes(fs.realpathSync(base)), 'Trust is answered only for the owned temporary folder');
      await page.keyboard.press('ArrowDown');
      await until(async () => /❯\s*Yes, I trust this folder/.test(await terminalText()), 'Native trust choice moved to Yes', 5000);
    } else {
      await page.keyboard.press('ArrowUp');
      await until(async () => (await terminalText()).includes('❯ Yes'), 'Native key choice moved to Yes', 5000);
    }
    await page.keyboard.press('Enter');
    await until(async () => await ready() || (await terminalText()) !== text, 'Native question answered', 20000);
    await sleep(800);
  }
  await until(async () => (await snapshot()).sessions[0]?.chatAvailable, 'The session binds and offers chat', 60000);
  const row = (await snapshot()).sessions[0];
  assert.equal(fs.existsSync(marker), false, 'The unqualified version was never started');
  assert.equal(row.nativeLaunchVersion, '2.1.322');
  assert.equal(row.nativePin?.requested, '2.1.999'); assert.equal(row.nativePin?.pinned, '2.1.322'); assert.equal(row.nativePin?.expired, undefined);
  checks.push('A new session under an unqualified launcher starts with the qualified version beside it and binds as usual');
  const argv = testScratch.childProcess.execFileSync('ps', ['-ww', '-o', 'args=', '-p', String(row.pid)], { encoding: 'utf8' });
  assert.ok(argv.includes(row.nativeId), 'The running native process is this session');
  const date = new Date(row.nativePin.until).toLocaleDateString('zh', { month: 'numeric', day: 'numeric' });
  const expected = locale.format('zh', 'native.claudePinned', { pinned: '2.1.322', requested: '2.1.999', date });
  await until(async () => (await page.locator('#session-status').innerText()).includes(expected.trim().replace(/^· /, '')), 'The session status names the fallback', 15000);
  assert.equal(await page.locator('#session-status').getAttribute('title'), locale.format('zh', 'native.claudePinnedDetail', { pinned: '2.1.322', requested: '2.1.999', date }));
  checks.push('The session status and its hover text name the version in use, the new version and the last day');
  // The background check ran the mod's tests from the copied runtime with the unqualified version and kept the result.
  const modCheck = require('../app/claude-mod-check.cjs'), recordFile = path.join(profile, 'claude-mod-check.json');
  await until(() => fs.existsSync(recordFile), 'The background check is recorded', 90000);
  const tested = modCheck.load(recordFile)['2.1.999'];
  assert.equal(modCheck.passed(tested), true, JSON.stringify(tested)); assert.equal(tested.files, modCheck.TESTS.length); assert.equal(tested.mod, modCheck.modHash());
  const runtimes = fs.readdirSync(path.join(profile, 'runtimes')); assert.equal(runtimes.length, 1);
  const runtime = path.join(profile, 'runtimes', runtimes[0]);
  assert.deepEqual(fs.readdirSync(path.join(runtime, 'claude-bridge-tests')).sort(), [...modCheck.TESTS].sort());
  assert.deepEqual(fs.readdirSync(path.join(runtime, 'claude-bridge')).filter(name => name.endsWith('.test.ts')), [], 'The folder the session loads has no test file');
  assert.equal(fs.existsSync(marker), false, 'The check ran only the tests of the unqualified version');
  checks.push(`In the background the mod's tests ran offline with the unqualified version and the result is kept: ${modCheck.describe(tested)}`);
  fixture.assertClean(); assert.deepEqual(errors, []);
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'claude-fallback-version.png') }); }
  console.log(JSON.stringify({ checks, nativeVersion, fixture: fixture.summary(), pin: row.nativePin, modCheck: tested, promptsSent: 0, paidModelCalls: 0, evidence: base }));
})().catch(async error => {
  if (page && !page.isClosed()) { fs.writeFileSync(path.join(base, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {}); }
  // The service's own copy of the native screen and the page's focus: whether a key reached the native program or only the page is stale.
  if (client) {
    const seen = {};
    try { const s = (await snapshot()).sessions[0]; seen.session = s && { state: s.state, view: s.view, owner: s.owner, terminalState: s.terminalState, terminalInputPending: s.terminalInputPending }; seen.screen = s && await client.call('terminalSnapshot', s.id); }
    catch (failure) { seen.error = String(failure?.message); }
    if (page && !page.isClosed()) seen.focus = await page.evaluate(() => ({ tag: document.activeElement?.tagName, className: String(document.activeElement?.className || ''), id: document.activeElement?.id || '', inTerminal: Boolean(document.activeElement?.closest('#terminal-area')) })).catch(() => null);
    fs.writeFileSync(path.join(base, 'service-terminal.json'), JSON.stringify(seen));
  }
  console.error(error.stack, '\nFixture:', JSON.stringify(fixture.summary()), '\nEvidence:', base); process.exitCode = 1;
}).finally(testScratch.cleanup(cleanup));
