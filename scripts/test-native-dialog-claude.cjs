// One interactive real Claude 2.1.323 in an isolated NAW profile, loopback only.
// The old service observes a real native choice without sending a task or confirming it.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process'), { randomUUID } = require('node:crypto');
const scratch = require('./fixtures/test-scratch.cjs'), { _electron } = scratch.playwright(require('playwright'));
const { createIn } = require('./fixtures/create-view.cjs'), loopback = require('./fixtures/loopback-model.cjs');
const root = path.resolve(__dirname, '..'), oldRoot = process.env.NAW_DIALOG_OLD_ROOT; assert.ok(oldRoot);
const { connect } = require('../app/service-client.cjs');
const evidence = process.env.NAW_EVIDENCE_DIR, pictures = process.env.NAW_SCREENSHOTS_DIR; assert.ok(evidence && pictures);
fs.mkdirSync(pictures, { recursive: true, mode: 0o700 });
async function checkNativeScreen(text, session = { provider: 'claude', state: 'idle' }) {
  const { Terminal } = require('@xterm/headless');
  const { terminalDialogPrompt } = require('../app/native-terminal-dialog.cjs');
  const terminal = new Terminal({ cols: 100, rows: 40, allowProposedApi: true });
  try {
    await new Promise(resolve => terminal.write(text.replace(/\n/g, '\r\n'), resolve));
    const prompt = terminalDialogPrompt(session, { terminal: { alive: true, screen: terminal } });
    assert.ok(prompt, 'actual native choice is recognized'); return prompt;
  } finally { terminal.dispose(); }
}
if (process.env.NAW_NATIVE_DIALOG_CAPTURE) {
  checkNativeScreen(fs.readFileSync(process.env.NAW_NATIVE_DIALOG_CAPTURE, 'utf8')).then(prompt => console.log(JSON.stringify({ replayOnly: true, prompt, launchedNative: false }))).catch(e => { console.error(e); process.exitCode = 1; });
  return;
}
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; no native CLI launched'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex F', task: 'one interactive native dialog trial', token, pid: process.pid }));
const base = scratch.directory(path.join(os.tmpdir(), 'naw-dialog-claude-'));
const profile = path.join(base, 'profile'), config = path.join(base, 'claude'), cwd = path.join(base, 'work');
for (const p of [profile, config, cwd]) fs.mkdirSync(p, { mode: 0o700 });
const binary = path.join(os.homedir(), '.local/share/claude/versions/2.1.323');
assert.match(execFileSync(binary, ['--version'], { encoding: 'utf8' }), /^2\.1\.323\b/);
let child, client, app, page, calls = 0, failure;
const errors = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixture = loopback.create({ directory: base, provider: 'claude', respond: (req, res, body) => {
  if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: 10, data: [] })); return; }
  calls++; failure = Error('This observational trial allows zero model responses');
  res.writeHead(429); res.end();
} });
async function until(fn, label, ms = 60000) { const end = Date.now() + ms; while (Date.now() < end) { if (failure) throw failure; if (await fn()) return; await delay(100); } throw Error(label); }
const screen = async () => (await page.locator('#terminal-area .xterm-rows').evaluateAll(rows => rows.filter(el => el.checkVisibility()).map(el => el.innerText).join('\n'))).replace(/\u00a0/g, ' ');
async function capture(name) { const text = await screen(); fs.writeFileSync(path.join(evidence, name + '.txt'), text); await page.screenshot({ path: path.join(pictures, name + '.png') }); return text; }
(async () => {
  await fixture.start(); await fixture.preflight();
  const wrapper = path.join(base, 'claude-local');
  fixture.wrapper(binary, { file: wrapper, env: { CLAUDE_CONFIG_DIR: config }, args: ['--model', 'haiku'] });
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', numStartups: 10, hasSeenAutoModeEntryWarning: true, hasSeenAutoDefaultNotice: true, autoModeEnvSetup: { denials: 6 }, projects: { [fs.realpathSync(cwd)]: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify({ claude: wrapper }), { mode: 0o600 });
  child = scratch.childProcess.fork(path.join(oldRoot, 'app/daemon.cjs'), [profile], { env: { ...process.env, NAW_WORKSPACE: cwd, NAW_APP_VERSION: require('../package.json').version }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'owned service');
  app = await _electron.launch({ executablePath: require('electron'), args: [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(15000);
  await page.locator('#new-session').waitFor(); client = await connect(profile, 'native-dialog-test');
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check(); await page.locator('#session-name').fill('Native dialog witness');
  fs.writeFileSync(path.join(evidence, 'native-create-state.json'), JSON.stringify(await page.evaluate(() => workspace.initial()), null, 2));
  fs.writeFileSync(path.join(evidence, 'native-preflight.json'), JSON.stringify(await page.evaluate(() => workspace.preflight()), null, 2));
  await capture('native-create-dialog'); await createIn(page, 'terminal');
  await until(async () => /Yes, I trust this folder|Do you want to use this API key/.test(await screen()) || (await client.call('initial')).sessions[0]?.chatAvailable, 'native startup');
  if ((await screen()).includes('Yes, I trust this folder')) {
    await page.locator('#terminal-area .xterm-screen').click(); await page.keyboard.press('ArrowDown');
    await until(async () => /❯\s*Yes, I trust this folder/.test(await screen()), 'trust selection'); await capture('native-trust-before-enter'); await page.keyboard.press('Enter');
  }
  await until(async () => (await screen()).includes('Do you want to use this API key') || (await client.call('initial')).sessions[0]?.chatAvailable, 'key prompt or ready');
  if ((await screen()).includes('Do you want to use this API key')) {
    await page.locator('#terminal-area .xterm-screen').click(); await page.keyboard.press('ArrowUp');
    await until(async () => /^❯\s*Yes/.test((await screen()).split('\n').filter(l => l.trim().startsWith('❯')).at(-1)?.trim() || ''), 'fixture key selection'); await capture('native-key-before-enter'); await page.keyboard.press('Enter');
  }
  await until(async () => (await client.call('initial')).sessions[0]?.chatAvailable, 'native mod ready');
  let before = await capture('native-ready');
  const exactOnboarding = before.includes('Teach auto mode about your environment?');
  if (!exactOnboarding) {
    await page.locator('#terminal-area .xterm-screen').click(); await page.keyboard.type('/model'); await delay(400);
    before = await capture('native-model-before-enter'); assert.match(before, /❯\s*\/model/); await page.keyboard.press('Enter');
    await until(async () => /Select model|Choose.*model/i.test(await screen()), 'real model choice');
  }
  before = await capture('native-dialog-before-submit');
  const s = (await client.call('initial')).sessions[0]; assert.equal(s.state, 'idle'); assert.equal(calls, 0);
  // The native run is intentionally observational. Queue inputs use the provider's API,
  // so an Enter in the raw TUI fixture does not establish the API's modal behavior.
  await checkNativeScreen(before, s);
  fixture.assertClean(); assert.equal(calls, 0); assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(evidence, 'native-dialog-result.json'), JSON.stringify({ version: '2.1.323', exactOnboarding, stateBefore: s.state, before, modelCalls: calls, paidModelCalls: 0, enteredTask: false, apiDialogEffect: 'unverified', fixture: fixture.summary() }, null, 2));
  console.log(JSON.stringify({ version: '2.1.323', exactOnboarding, modelCalls: calls, paidModelCalls: 0, enteredTask: false, errors }));
})().catch(async e => { if (page) await capture('native-failure').catch(() => {}); console.error(e); process.exitCode = 1; }).finally(async () => {
  if (app) await app.close().catch(() => {});
  if (client) { for (const s of client.snapshot().sessions) await client.call('stop', s.id).catch(() => {}); await client.call('shutdown').catch(() => {}); client.close(); }
  if (child && child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
  await fixture.stop();
  if (JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token === token) fs.rmSync(slot, { recursive: true });
});
