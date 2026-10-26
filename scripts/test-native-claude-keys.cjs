const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// Real Electron + Claude Code on a loopback fake API: keys that the audit says
// work "in the same-screen native TUI" are pressed in NAW's terminal and the
// native screen is read back. NAW's xterm has no kitty keyboard protocol, so
// Claude runs without CSI-u there. Nothing is submitted: zero model requests.
// Option+letter keys produce characters from the macOS keyboard layout, which
// synthetic events cannot reproduce; they need a physical keyboard check.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..');
const { connectService } = require('../app/service-client.cjs');
const { executable } = require('../app/platform.cjs');
const base = testScratch.directory(path.join(os.tmpdir(), 'naw-native-claude-keys-'));
const profile = path.join(base, 'profile'), config = path.join(base, 'claude'), userHome = path.join(base, 'home');
for (const dir of [profile, config, userHome]) fs.mkdirSync(dir, { mode: 0o700 });
const binary = process.env.NAW_CLAUDE_BIN || executable('claude'); if (!binary) throw Error('Real Claude CLI required');
const nativeVersion = testScratch.childProcess.execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
assert.match(nativeVersion, /^2\.1\.31[01]\b/, 'Native key handling is verified against 2.1.310 and 2.1.311 only');
let application, page, client, requests = 0;
const errors = [], checks = [], screens = {};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 15000) {
  const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await sleep(80); } throw Error(label);
}
// Any model request fails the probe: no key here may submit a prompt.
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', data => body += data);
  req.on('end', () => {
    if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: 100, data: [] })); return; }
    requests++; fs.writeFileSync(path.join(base, `request-${requests}.json`), body);
    res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'key probe: no model request expected' } }));
  });
});
const snapshot = () => client.call('initial');
const terminalText = async () => (await page.locator('#terminal-area .xterm-rows').evaluateAll(rows => rows.filter(el => el.checkVisibility()).map(el => el.innerText).join('\n'))).replace(/\u00a0/g, ' ');
const focusTerminal = async () => { await page.locator('#terminal-area .xterm-screen >> visible=true').click(); };
const editLine = async () => ((await terminalText()).split('\n').filter(l => /^❯ ?/.test(l)).at(-1) || '').replace(/\s+$/, '');
async function record(name) { screens[name] = await terminalText(); fs.writeFileSync(path.join(base, `screen-${name}.txt`), screens[name]); }
// Back to an empty edit line before the next probe. One Escape only: a second
// one in a row opens native Rewind.
async function reset() {
  await page.keyboard.press('Escape'); await sleep(400);
  await page.keyboard.press('Control+e'); await page.keyboard.press('Control+u'); await sleep(200);
  await until(async () => (await editLine()) === '❯', 'Empty native edit line', 5000);
}
function ownedNativeProcesses() {
  const marker = path.basename(base);
  return testScratch.childProcess.execFileSync('ps', ['-axE', '-ww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter(line => line.includes(marker) && / daemon run\b|bg-pty-host|bg-spare|^\s*\d+\s+claude |claude-message-tool\.cjs/.test(line))
    .map(line => ({ pid: Number(line.trim().split(/\s+/)[0]), daemon: / daemon run\b/.test(line) })).filter(p => p.pid);
}
async function cleanup() {
  for (let round = 0; round < 3 && ownedNativeProcesses().length; round++) {
    const owned = ownedNativeProcesses();
    for (const p of [...owned.filter(p => p.daemon), ...owned.filter(p => !p.daemon)]) { try { process.kill(p.pid, round ? 'SIGKILL' : 'SIGTERM'); } catch { /* gone */ } }
    await sleep(1500);
  }
  const survivors = ownedNativeProcesses().map(p => p.pid);
  if (application) await application.close().catch(() => {});
  if (client) { try { for (const s of (await snapshot()).sessions) await client.call('stop', s.id); await client.call('shutdown'); } finally { client.close(); } }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (survivors.length) throw Error('Owned native processes still alive: ' + survivors.join(','));
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const shim = path.join(base, 'claude-local');
  fs.writeFileSync(shim, '#!/usr/bin/python3\nimport os,sys\nfor key in ["ANTHROPIC_AUTH_TOKEN","CLAUDE_CODE_OAUTH_TOKEN","CLAUDE_CODE_CHILD_SESSION","CLAUDECODE","CLAUDE_CODE_SESSION_ID","CLAUDE_CODE_ENTRYPOINT"]: os.environ.pop(key,None)\nos.environ.update(' +
    `HOME=${JSON.stringify(userHome)},ANTHROPIC_BASE_URL=${JSON.stringify(`http://127.0.0.1:${server.address().port}`)},ANTHROPIC_API_KEY="local-fixture",CLAUDE_CONFIG_DIR=${JSON.stringify(config)},CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1")\n` +
    `os.execv(${JSON.stringify(binary)},["claude"]+sys.argv[1:]+["--model","haiku"])\n`, { mode: 0o700 });
  const serviceCwd = path.join(profile, 'workspace'); fs.mkdirSync(serviceCwd, { mode: 0o700 });
  fs.writeFileSync(path.join(serviceCwd, 'keyprobe-notes.txt'), 'synthetic file for the @ mention menu\n');
  // A committed file with an uncommitted edit, for native /diff (synthetic local identity).
  const git = (...args) => testScratch.childProcess.execFileSync('git', ['-c', 'user.name=Key Probe', '-c', 'user.email=probe@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: serviceCwd, stdio: 'ignore' });
  git('init', '-q'); git('add', 'keyprobe-notes.txt'); git('commit', '-q', '-m', 'synthetic');
  fs.appendFileSync(path.join(serviceCwd, 'keyprobe-notes.txt'), 'an uncommitted synthetic line\n');
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [fs.realpathSync(serviceCwd)]: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ awaySummaryEnabled: false }), { mode: 0o600 });
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify({ claude: shim }), { mode: 0o600 });
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: serviceCwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 60000 });
  await until(async () => { for (const p of application.windows()) if (!p.isClosed() && await p.locator('#new-session').count().catch(() => 0)) { page = p; return true; } return false; }, 'Main window', 60000);
  page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  client = await connectService(profile, 'native-claude-keys-test');
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check();
  await page.locator('#session-name').fill('Keys'); await createIn(page, 'terminal');
  await until(async () => /Do you want to use this API key/.test(await terminalText()) || (await snapshot()).sessions[0]?.chatAvailable, 'Native startup', 60000);
  if (/Do you want to use this API key/.test(await terminalText())) {
    await focusTerminal(); await page.keyboard.press('ArrowUp');
    await until(async () => (await terminalText()).includes('❯ Yes'), 'Native key choice moved to Yes', 5000); await page.keyboard.press('Enter');
  }
  await until(async () => (await snapshot()).sessions[0]?.chatAvailable, 'Native ready', 60000);
  await focusTerminal(); await until(async () => (await editLine()) === '❯', 'Native edit line', 15000); await record('start');

  // CL-I01: word and line editing with modifiers whose synthetic and physical
  // events match (xterm sends ESC DEL for Option+Backspace and CSI 1;3D for
  // Option+Left from the key code, not from the macOS layout).
  await page.keyboard.type('alpha beta', { delay: 20 }); await until(async () => (await editLine()) === '❯ alpha beta', 'Typed text');
  await page.keyboard.press('Alt+Backspace'); await sleep(300); await record('alt-backspace');
  const wordDeleted = (await editLine()) === '❯ alpha';
  await reset(); await page.keyboard.type('alpha beta', { delay: 20 }); await until(async () => (await editLine()) === '❯ alpha beta', 'Typed text again');
  await page.keyboard.press('Alt+ArrowLeft'); await page.keyboard.type('X'); await sleep(300); await record('alt-left');
  const wordLeft = (await editLine()) === '❯ alpha Xbeta';
  // Ctrl+U deletes from the cursor (after X) to the line start.
  await page.keyboard.press('Control+u'); await sleep(300); await record('ctrl-u');
  const killToStart = (await editLine()) === '❯ beta';
  await reset();

  // CL-A05: Shift+Tab cycles the native permission mode named in the footer,
  // and further presses come back to the starting mode.
  const mode = text => text.split('\n').slice(-3).join('\n').match(/(\w+) mode on/)?.[1];
  const modeBefore = mode(await terminalText());
  await page.keyboard.press('Shift+Tab'); await sleep(500); await record('shift-tab');
  const modeAfter = mode(screens['shift-tab']);
  for (let i = 0; i < 6 && mode(await terminalText()) !== modeBefore; i++) { await page.keyboard.press('Shift+Tab'); await sleep(400); }
  const modeRestored = mode(await terminalText());
  const modeChanged = modeBefore === 'auto' && modeAfter === 'manual' && modeRestored === 'auto';
  await reset();

  // CL-I05: the / command menu and the @ file mention menu.
  await page.keyboard.type('/'); await sleep(600); await record('slash');
  const menuLines = text => text.split('\n').filter(l => !/^❯/.test(l)).join('\n');
  const slashMenu = /\/add-dir\b/.test(menuLines(screens.slash)) && !/\/add-dir\b/.test(screens.start);
  await reset();
  await page.keyboard.type('@keyprobe', { delay: 20 }); await sleep(800); await record('at');
  const atMenu = /keyprobe-notes\.txt/.test(screens.at) && !/keyprobe-notes\.txt/.test(screens.start);
  await reset();

  // CL-I07: ! enters shell mode.
  await page.keyboard.type('!'); await sleep(500); await record('bang');
  const shellMode = /! for shell mode/.test(screens.bang) && screens.bang.split('\n').some(l => /^! *$/.test(l));
  await page.keyboard.press('Backspace'); await until(async () => (await editLine()) === '❯', 'Shell mode left', 5000);

  // CL-I03: Ctrl+R opens the native prompt-history search.
  await page.keyboard.press('Control+r'); await sleep(500); await record('ctrl-r');
  const historySearch = /Search prompts/.test(screens['ctrl-r']) && /Filter history/.test(screens['ctrl-r']);
  await reset();

  // CL-I02: a long multi-line paste goes through NAW's paste guard as a bracketed
  // paste, and native shows its placeholder instead of the lines.
  const pasted = Array.from({ length: 40 }, (_, i) => `pasted line ${i}`).join('\n');
  await page.locator('#terminal-area .xterm-helper-textarea >> visible=true').evaluate((el, text) => {
    const data = new DataTransfer(); data.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, pasted);
  await sleep(800); await record('paste');
  const pastePlaceholder = /\[Pasted text #\d+/.test(await editLine()) && !/pasted line 39/.test(screens.paste);
  await reset();

  // CL-S04: Escape twice on an empty line opens native Rewind; one more closes it.
  await page.keyboard.press('Escape'); await sleep(120); await page.keyboard.press('Escape'); await sleep(700); await record('rewind');
  const rewindOpens = /Rewind/.test(screens.rewind) && /Esc to cancel/.test(screens.rewind);
  await page.keyboard.press('Escape'); await until(async () => (await editLine()) === '❯' && !/Rewind/.test(await terminalText()), 'Rewind closed', 5000);

  // CL-R04: /diff opens native's diff dialog on the folder's uncommitted edit. It is
  // a local command, not a prompt; Enter only once the menu highlights /diff.
  await page.keyboard.type('/diff', { delay: 20 });
  await until(async () => (await editLine()) === '❯ /diff' && (await terminalText()).split('\n').some(l => /^\s+❯ \/diff\s/.test(l)), 'Edit line and menu show /diff', 5000);
  await page.keyboard.press('Enter'); await sleep(1500); await record('diff-split');
  // Beside the chat the terminal is narrower than the 110 columns the panel needs.
  const diffNeedsWidth = /at least 110 columns/.test(screens['diff-split']);
  await reset();
  await page.locator('#terminal-maximize').click(); await sleep(800); await focusTerminal();
  await page.keyboard.type('/diff', { delay: 20 });
  await until(async () => (await editLine()) === '❯ /diff' && (await terminalText()).split('\n').some(l => /^\s+❯ \/diff\s/.test(l)), 'Edit line and menu show /diff again', 5000);
  await page.keyboard.press('Enter'); await sleep(1500); await record('diff');
  const diffDialog = /Diff panel shown/.test(screens.diff) && /1 file edited/.test(screens.diff);
  // The panel stays beside the session (Escape does not close it); only the edit line must be free.
  await reset();
  await page.locator('#terminal-maximize').click(); await sleep(500); await focusTerminal();

  // CL-S02/CL-S03: local native dialogs open in NAW's terminal. Enter only once
  // the edit line and the highlighted menu entry are the command.
  async function openNative(command) {
    await page.keyboard.type('/' + command, { delay: 20 });
    await until(async () => (await editLine()) === '❯ /' + command && (await terminalText()).split('\n').some(l => new RegExp('^\\s+❯ /' + command + '\\s').test(l)), 'Edit line and menu show /' + command, 5000);
    await page.keyboard.press('Enter'); await sleep(1200); await record(command);
    // One Escape may only clear a filter (/config); press again only if still open.
    await page.keyboard.press('Escape');
    if (!await until(async () => (await editLine()) === '❯', '', 1000).then(() => true, () => false)) await page.keyboard.press('Escape');
    await until(async () => (await editLine()) === '❯', '/' + command + ' closed', 5000);
    return screens[command];
  }
  const modelPicker = /Haiku ✔/.test(await openNative('model')) && /Sonnet/.test(screens.model);
  const configDialog = /Type to filter/.test(await openNative('config')) && /Show tips/.test(screens.config);
  const memoryDialog = /Auto-memory/.test(await openNative('memory')) && /Esc to cancel/.test(screens.memory);
  // CL-X05: NAW's directed-message MCP server is connected with its one tool.
  const mcpListed = /✔ native_workspace\s+1 tool/.test(await openNative('mcp'));
  const hooksMenu = /This menu is read-only/.test(await openNative('hooks'));
  // NAW's launch settings add PreToolUse hooks, yet the native menu lists none
  // there: All events, then the first event (PreToolUse).
  await page.keyboard.type('/hooks', { delay: 20 });
  await until(async () => (await editLine()) === '❯ /hooks' && (await terminalText()).split('\n').some(l => /^\s+❯ \/hooks\s/.test(l)), 'Edit line and menu show /hooks again', 5000);
  await page.keyboard.press('Enter'); await until(async () => /❯ All events/.test(await terminalText()), 'Hooks menu open', 5000);
  await page.keyboard.press('Enter'); await until(async () => /PreToolUse/.test(await terminalText()), 'Hook events listed', 5000); await record('hooks-events');
  await page.keyboard.press('Enter'); await sleep(800); await record('hooks-pretool');
  const nawHooksUnlisted = /0 with hooks/.test(screens['hooks-events']) && /PreToolUse - Matchers/.test(screens['hooks-pretool']) && /No hooks configured for this event/.test(screens['hooks-pretool']);
  for (let i = 0; i < 4 && (await editLine()) !== '❯'; i++) { await page.keyboard.press('Escape'); await sleep(600); }
  await until(async () => (await editLine()) === '❯', 'Hooks menu closed', 5000);

  // CL-R05: Ctrl+T shows nothing without tasks, and making a task needs a model
  // turn, so the screen is kept as evidence only and the row stays unverified.
  await page.keyboard.press('Control+t'); await sleep(500); await record('ctrl-t');
  await page.keyboard.press('Control+t'); await sleep(300); await reset();

  const results = { wordDeleted, wordLeft, killToStart, modeChanged, slashMenu, atMenu, shellMode, historySearch, pastePlaceholder, rewindOpens, diffNeedsWidth, diffDialog, modelPicker, configDialog, memoryDialog, mcpListed, hooksMenu, nawHooksUnlisted };
  fs.writeFileSync(path.join(base, 'results.json'), JSON.stringify({ results, modeBefore, modeAfter, modeRestored }, null, 2));
  if (process.env.NAW_EVIDENCE_DIR) {
    fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true });
    for (const [name, text] of Object.entries(screens)) fs.writeFileSync(path.join(process.env.NAW_EVIDENCE_DIR, `screen-${name}.txt`), text);
  }
  assert.equal(requests, 0, 'No key submitted a model request'); assert.deepEqual(errors, []);
  for (const [name, ok] of Object.entries(results)) if (ok) checks.push(name);
  console.log(JSON.stringify({ nativeVersion, results, modes: [modeBefore, modeAfter, modeRestored], checks, modelRequests: requests, paidModelCalls: 0, errors, evidence: base }, null, 2));
  const failed = Object.entries(results).filter(([, ok]) => !ok).map(([name]) => name);
  assert.deepEqual(failed, [], 'Native keys that did not work in NAW\'s terminal');
})().catch(async error => {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(base, 'failure-terminal.txt'), await terminalText().catch(() => '')); }
  console.error(error.stack, '\nEvidence:', base); process.exitCode = 1;
}).finally(testScratch.cleanup(cleanup));
