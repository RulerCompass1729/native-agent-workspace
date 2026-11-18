const testScratch = require('./fixtures/test-scratch.cjs');
// The Claude session list in 新建会话, end to end: isolated HOME/config, the real
// native CLI under the loopback sandbox, two synthetic transcripts. A has exited;
// B is open in an owned outside terminal. List → search finds A → A continues
// with its own ID → B is refused while it runs (no second writer) → B continues
// after it exits. No message is sent, so the fixture expects zero requests.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..');
const { connectService } = require('../app/service-client.cjs');
const { executable, processIdentity, processMayBeAlive } = require('../app/platform.cjs');
const { Terminal } = require('../app/adapters.cjs');
const loopback = require('../app/claude-loopback.cjs');
const base = testScratch.directory(path.join(os.tmpdir(), 'naw-claude-session-list-'));
const profile = path.join(base, 'profile'), config = path.join(base, 'claude'), userHome = path.join(base, 'home');
const alphaDir = path.join(base, 'alpha-notes'), betaDir = path.join(base, 'beta-notes');
for (const dir of [profile, config, userHome, alphaDir, betaDir]) fs.mkdirSync(dir, { mode: 0o700 });
const evidence = process.env.NAW_EVIDENCE_DIR;
if (evidence) fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const binary = process.env.NAW_CLAUDE_BIN || executable('claude'); if (!binary) throw Error('Real Claude CLI required');
const nativeVersion = testScratch.childProcess.execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
assert.match(nativeVersion, /^2\.1\.327\b/, 'This journey uses the qualified 2.1.327 native contract');
const A = crypto.randomUUID(), B = crypto.randomUUID();
const TITLES = { [A]: 'Synthetic Alpha notes', [B]: 'Synthetic Beta notes' };
const REPLIES = { [A]: 'SYNTHETIC_ALPHA_REPLY', [B]: 'SYNTHETIC_BETA_REPLY' };
const PROMPTS = { [A]: 'SYNTHETIC_ALPHA_PROMPT', [B]: 'SYNTHETIC_BETA_PROMPT' };
const SESSION_TEXT = [...Object.values(TITLES), ...Object.values(PROMPTS), ...Object.values(REPLIES)];
let fixture, application, page, client, outside, outsideIdentity, nativeIdentities = [];
const errors = [], checks = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 30000) {
  const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await sleep(80); } throw Error(label);
}
const shot = async name => { if (evidence) await page.screenshot({ path: path.join(evidence, name + '.png') }); };
const snapshot = () => client.call('initial');
const slug = dir => fs.realpathSync(dir).replace(/[^a-zA-Z0-9]/g, '-');
const transcriptFile = (id, dir) => path.join(config, 'projects', slug(dir), id + '.jsonl');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// The rows Claude 2.1.327 writes for a named session with one finished exchange.
function transcript(id, cwd) {
  const first = crypto.randomUUID(), second = crypto.randomUUID();
  const common = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: id, version: '2.1.327', gitBranch: '' };
  return [
    { type: 'custom-title', customTitle: TITLES[id], sessionId: id },
    { parentUuid: null, ...common, type: 'user', message: { role: 'user', content: PROMPTS[id] }, uuid: first, timestamp: '2026-11-18T10:00:00.000Z' },
    { parentUuid: first, ...common, type: 'assistant', message: { id: 'msg_synthetic_' + id.slice(0, 8), type: 'message', role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: REPLIES[id] }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 4 } }, uuid: second, timestamp: '2026-11-18T10:00:01.000Z' },
  ].map(row => JSON.stringify(row)).join('\n') + '\n';
}
// Earlier rows keep their terminals in the DOM; read only the visible one.
const terminalText = async () => (await page.locator('#terminal-area .xterm-rows').evaluateAll(rows => rows.filter(el => el.checkVisibility()).map(el => el.innerText).join('\n'))).replace(/ /g, ' ');
async function outsideText() {
  await outside.snapshot(); const buffer = outside.screen.buffer.active;
  return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i).translateToString(true)).join('\n').replace(/ /g, ' ');
}
const choice = id => page.locator(`input[name="native-history-choice"][value="${id}"]`);
const rows = () => page.locator('input[name="native-history-choice"]').count();
async function openList() {
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check();
  await page.locator('#open-claude-sessions').waitFor(); await page.locator('#open-claude-sessions').click();
  await page.locator('#native-history-dialog').waitFor();
  await until(() => page.locator('#search-native-history').isEnabled(), 'List ready');
}
async function cleanup() {
  let failure;
  try { if (outside?.alive) await outside.stop(10000); } catch (error) { failure = error; }
  if (application) await application.close().catch(() => {});
  if (client) { try {
    const open = (await snapshot()).sessions; nativeIdentities = open.filter(s => s.pid).map(s => processIdentity(s.pid)).filter(Boolean);
    for (const s of open) await client.call('stop', s.id); await client.call('shutdown');
  } finally { client.close(); } }
  if (fixture) await fixture.stop();
  if (outsideIdentity && processMayBeAlive(outsideIdentity)) failure ||= Error('Owned outside session exit is unconfirmed');
  await until(() => nativeIdentities.every(id => !processMayBeAlive(id)), 'Native sessions exited', 5000).catch(error => { failure ||= error; });
  // testScratch exports this whole base as evidence: transcripts and Claude's records stay out of it.
  fs.rmSync(config, { recursive: true, force: true });
  const failureText = path.join(base, 'failure.txt');
  if (fs.existsSync(failureText)) fs.writeFileSync(failureText, SESSION_TEXT.reduce((text, marker) => text.split(marker).join('[synthetic session text]'), fs.readFileSync(failureText, 'utf8')));
  if (failure) throw failure;
}
(async () => {
  fixture = loopback.create({ directory: base, provider: 'claude', respond: (req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'session list journey sends no message' } })); } });
  await fixture.start(); await fixture.preflight();
  const shim = fixture.wrapper(binary, { file: path.join(base, 'claude-local'), env: { HOME: userHome, CLAUDE_CONFIG_DIR: config } });
  const trusted = Object.fromEntries([alphaDir, betaDir].map(dir => [fs.realpathSync(dir), { hasTrustDialogAccepted: true }]));
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: trusted }), { mode: 0o600 });
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ awaySummaryEnabled: false, promptSuggestionEnabled: false }), { mode: 0o600 });
  for (const [id, dir, hour] of [[A, alphaDir, 9], [B, betaDir, 10]]) {
    fs.mkdirSync(path.dirname(transcriptFile(id, dir)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(transcriptFile(id, dir), transcript(id, fs.realpathSync(dir)), { mode: 0o600 });
    const at = new Date(`2026-11-18T${String(hour).padStart(2, '0')}:00:00Z`); fs.utimesSync(transcriptFile(id, dir), at, at);
  }
  const before = { [A]: fs.readFileSync(transcriptFile(A, alphaDir), 'utf8'), [B]: fs.readFileSync(transcriptFile(B, betaDir), 'utf8') };
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify({ claude: shim }), { mode: 0o600 });

  // Outside NAW: B stays open in its own terminal, with no message sent.
  outside = new Terminal([shim, '--resume', B], betaDir);
  await until(() => Boolean(outside.pid), 'Owned outside PID'); outsideIdentity = processIdentity(outside.pid);
  await until(async () => /Do you want to use this API key|❯/.test(await outsideText()), 'Outside startup', 60000);
  if ((await outsideText()).includes('Do you want to use this API key')) {
    outside.input('\x1b[A'); await until(async () => (await outsideText()).includes('❯ Yes'), 'Outside key selection'); outside.input('\r');
  }
  await until(async () => (await outsideText()).split('\n').some(line => line.trim() === '❯'), 'Outside edit line', 60000);
  assert.ok((await outsideText()).includes(REPLIES[B]), 'The outside session shows B history');

  // The daemon reads Claude's records from this config only, never the real ~/.claude.
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: alphaDir, CLAUDE_CONFIG_DIR: config, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 60000 });
  page = await application.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor(); client = await connectService(profile, 'native-claude-session-list-test');
  assert.ok((await snapshot()).capabilities.includes('claudeSessionList'));
  const listed = await client.call('nativeHistory', { provider: 'claude' });
  assert.deepEqual(listed.data.map(r => r.nativeId).sort(), [A, B].sort(), 'Only the two synthetic sessions are listed');
  assert.equal(listed.data.find(r => r.nativeId === B).running, true); assert.equal(listed.data.find(r => r.nativeId === A).running, false);
  assert.equal((await snapshot()).sessions.length, 0); checks.push('Opening the service lists exactly the isolated synthetic sessions; B reports running, A exited');

  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check();
  await page.locator('#open-claude-sessions').waitFor(); await shot('after-create-dialog'); await page.locator('#cancel-create').click();
  await openList(); await until(async () => await rows() === 2, 'Both sessions listed');
  assert.match(await page.locator('#native-history-heading').innerText(), /Claude/);
  const betaRow = await choice(B).locator('xpath=ancestor::label[1]').innerText();
  assert.ok(betaRow.includes('正在别处运行，先在那边退出再接') && betaRow.includes(TITLES[B]));
  const alphaRow = await choice(A).locator('xpath=ancestor::label[1]').innerText();
  assert.ok(alphaRow.includes(TITLES[A]) && !alphaRow.includes('正在别处运行'));
  await shot('after-list');
  await page.locator('#native-history-search').fill('alpha'); await page.locator('#search-native-history').click();
  await until(async () => await rows() === 1 && await choice(A).count() === 1, 'Search finds A'); await shot('after-search');
  checks.push('The dialog lists both sessions with titles and folders, marks B as running elsewhere, and search narrows to A');

  await choice(A).check(); await page.locator('#confirm-native-history').click();
  await until(() => page.locator('#native-history-dialog').evaluate(el => !el.open), 'Picker closed after A');
  await until(async () => { const s = (await snapshot()).sessions.find(s => s.nativeId === A); return s?.chatAvailable && s.pid; }, 'A continues natively', 60000);
  await until(async () => (await terminalText()).includes(REPLIES[A]), 'A history is visible');
  const alpha = (await snapshot()).sessions.find(s => s.nativeId === A);
  assert.equal(alpha.provider, 'claude'); assert.equal(alpha.cwd, fs.realpathSync(alphaDir)); assert.equal(alpha.externalHistory, true);
  assert.ok(fs.readFileSync(transcriptFile(A, alphaDir), 'utf8').startsWith(before[A]), 'A keeps its own transcript');
  assert.deepEqual(fs.readdirSync(path.dirname(transcriptFile(A, alphaDir))), [A + '.jsonl'], 'No new native session was started for A');
  await shot('after-continue-alpha'); checks.push('Choosing A continues the same native session ID in its own folder, with its history and no new session');

  const heldB = sha(transcriptFile(B, betaDir));
  await openList(); await until(async () => await rows() === 2, 'List reopened');
  const alphaAgain = await choice(A).locator('xpath=ancestor::label[1]').innerText();
  assert.ok(alphaAgain.includes('已在工作台中') && !alphaAgain.includes('正在别处运行'), 'A open in NAW is not reported as running elsewhere');
  await choice(B).check(); await page.locator('#confirm-native-history').click();
  await until(async () => /活动连接或后台工作|可能正在写入/.test(await page.locator('#native-history-status').innerText()), 'Running B refused');
  assert.equal((await snapshot()).sessions.some(s => s.nativeId === B), false); assert.equal(await page.locator('#native-history-dialog').evaluate(el => el.open), true);
  assert.equal(sha(transcriptFile(B, betaDir)), heldB); assert.equal(processMayBeAlive(outsideIdentity), true);
  await shot('after-running-refused'); checks.push('Choosing running B is refused in the dialog: no NAW record, outside process untouched, transcript unchanged');

  await outside.stop(10000); assert.equal(processMayBeAlive(outsideIdentity), false);
  await page.locator('#confirm-native-history').click();
  await until(() => page.locator('#native-history-dialog').evaluate(el => !el.open), 'Picker closed after B');
  await until(async () => { const s = (await snapshot()).sessions.find(s => s.nativeId === B); return s?.chatAvailable && s.pid; }, 'B continues natively', 60000);
  await until(async () => (await terminalText()).includes(REPLIES[B]), 'B history is visible');
  assert.ok(fs.readFileSync(transcriptFile(B, betaDir), 'utf8').startsWith(before[B]), 'B keeps its own transcript');
  assert.deepEqual(fs.readdirSync(path.dirname(transcriptFile(B, betaDir))), [B + '.jsonl']);
  await shot('after-continue-beta'); checks.push('After B exits outside, the same choice continues B with its own ID');

  // Titles and excerpts are for the dialog only: no NAW file may hold them.
  const private_ = [...Object.values(TITLES), ...Object.values(PROMPTS)], holders = [];
  const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else if (entry.isFile() && private_.some(text => fs.readFileSync(file, 'utf8').includes(text))) holders.push(path.relative(profile, file)); } };
  walk(profile); assert.deepEqual(holders, [], 'No NAW record, queue or log holds a native title or excerpt');
  checks.push('No file in the NAW profile holds a listed title or first message');
  const network = fixture.summary(); fixture.assertClean(); assert.equal(network.requests, 0, 'No model request');
  assert.deepEqual(errors, []);
  const result = { checks, nativeVersion, modelRequests: network.requests, credentialViolations: network.credentialViolations, sandbox: network.sandbox, preflight: network.preflight, nativeLaunches: 3, errors };
  if (evidence) fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
})().catch(async error => {
  if (page && !page.isClosed()) { await shot('failure').catch(() => {}); if (evidence) fs.writeFileSync(path.join(evidence, 'failure-status.txt'), await page.locator('#native-history-status').innerText().catch(() => '')); }
  console.error(error.stack); process.exitCode = 1;
}).finally(testScratch.cleanup(cleanup)).then(() => {
  if (!evidence) return;
  const holders = [];
  const scan = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) scan(file); else if (entry.isFile() && SESSION_TEXT.some(text => fs.readFileSync(file).includes(text))) holders.push(path.relative(evidence, file)); } };
  scan(evidence);
  if (holders.length) { console.error(JSON.stringify({ evidenceHoldsSessionText: holders })); process.exitCode = 1; }
  else console.log(JSON.stringify({ evidenceSessionTextScan: 'clean', markers: SESSION_TEXT.length }));
});
