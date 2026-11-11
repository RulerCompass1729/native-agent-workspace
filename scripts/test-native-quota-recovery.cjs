// Real Claude + real NAW daemon/transport. Fixed loopback replies only; native
// and its children are OS-sandboxed to this fixture's one port. One case/run.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const scratch = require('./fixtures/test-scratch.cjs'), loopback = require('./fixtures/loopback-model.cjs');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connectService } = require(path.join(code, 'app/service-connection.cjs'));
const binary = process.env.NAW_CLAUDE_BIN;
assert.ok(binary && path.isAbsolute(binary), 'Set NAW_CLAUDE_BIN to the native Claude executable');
const scenario = process.argv[2] || 'plain';
assert.ok(['plain', 'tool', 'background', 'child', 'terminal'].includes(scenario), 'Choose a bounded quota scenario');
const gui = process.env.NAW_QUOTA_GUI === '1';
assert.ok(!gui || scenario === 'plain', 'The GUI case checks ordinary chat input');
let slot, lease, leaseToken;
if (gui) {
  const common = scratch.childProcess.execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
  slot = path.resolve(common, '..', '.local/gui-test-slot.lock');
  try { fs.mkdirSync(slot); } catch (error) { if (error.code === 'EEXIST') { console.log('OCCUPIED: no test profile or Electron allocated'); process.exit(75); } throw error; }
  lease = fs.lstatSync(slot); leaseToken = randomUUID();
  fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex2', task: 'quota recovery GUI', pid: process.pid, token: leaseToken }));
}
const base = scratch.directory(path.join(os.tmpdir(), 'naw-quota-journey-'));
const dirs = Object.fromEntries(['home', 'config', 'work', 'profile'].map(key => [key, path.join(base, key)]));
for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { mode: 0o700 });
let daemon, client, application, page, recovering = false, calls = 0;
const trace = [], errors = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const marker = path.join(dirs.work, 'tool-executions.txt');
const toolScenario = ['tool', 'background', 'child'].includes(scenario);
function event(res, type, value) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`); }
function reply(res, request, blocks, reason) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  event(res, 'message_start', { message: { id: `msg_quota_${calls}`, type: 'message', role: 'assistant', model: request.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  blocks.forEach((block, index) => {
    event(res, 'content_block_start', { index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } });
    event(res, 'content_block_delta', { index, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    event(res, 'content_block_stop', { index });
  });
  event(res, 'message_delta', { delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 12 } });
  event(res, 'message_stop', {}); res.end();
}
const fixture = loopback.create({ directory: base, provider: 'claude', respond: (req, res, body) => {
  if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) { res.writeHead(200); res.end('{"input_tokens":100,"data":[]}'); return; }
  calls++; assert.ok(calls <= 8, 'At most eight fixed native requests, including child activity');
  const request = JSON.parse(body); fs.writeFileSync(path.join(base, `request-${calls}.json`), body);
  if (recovering) { reply(res, request, [{ type: 'text', text: 'FIXED_QUOTA_RECOVERY_COMPLETE' }], 'end_turn'); return; }
  if (calls === 1 && toolScenario) {
    const input = scenario === 'child' ? { description: 'Synthetic local child', prompt: 'FIXED_CHILD_QUOTA_PROBE', subagent_type: 'general-purpose', model: 'haiku' }
      : { command: "printf 'ONCE\\n' >> tool-executions.txt", description: 'Write the owned marker', ...(scenario === 'background' ? { run_in_background: true } : {}) };
    const name = scenario === 'child' ? 'Agent' : 'Bash';
    assert.ok(request.tools.some(tool => tool.name === name), 'The real native tool must exist');
    reply(res, request, [{ type: 'tool_use', id: 'toolu_quota_owned', name, input }], 'tool_use'); return;
  }
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'billing_error', message: 'Your credit balance is too low to access the Anthropic API.' } }));
} });
async function until(test, label, timeout = 45000) {
  const start = Date.now(); while (Date.now() - start < timeout) { if (await test()) return; await delay(100); } throw Error(label);
}
const snapshot = () => client.call('initial'), row = async () => (await snapshot()).sessions[0];
async function cleanup() {
  if (application) await application.close();
  if (client) { try { for (const s of (await snapshot()).sessions) await client.call('stop', s.id); await client.call('shutdown'); } catch { /* already stopped */ } finally { client.close(); } }
  await fixture.stop();
}
scratch.cleanup(cleanup);
(async () => {
  await fixture.start(); await fixture.preflight();
  const wrapper = fixture.wrapper(binary, { file: path.join(base, 'claude-local'), env: { HOME: dirs.home, CLAUDE_CONFIG_DIR: dirs.config, CLAUDE_CODE_MAX_RETRIES: '0' }, args: ['--permission-mode', 'default'] });
  const version = scratch.childProcess.execFileSync(wrapper, ['--version'], { encoding: 'utf8' }).trim(); assert.match(version, /^2\.1\.322\b/);
  fs.writeFileSync(path.join(dirs.config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', customApiKeyResponses: { approved: ['local-fixture'], rejected: [] }, projects: { [fs.realpathSync(dirs.work)]: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
  fs.writeFileSync(path.join(dirs.config, 'settings.json'), JSON.stringify({ awaySummaryEnabled: false, promptSuggestionEnabled: false, permissions: { allow: ['Bash', 'Agent'] } }), { mode: 0o600 });
  const config = path.join(dirs.profile, 'runtime-locations.json'); fs.writeFileSync(config, JSON.stringify({ claude: wrapper }), { mode: 0o600 });
  const benign = ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'USER', 'LOGNAME', 'SHELL', 'TERM'];
  const env = { ...Object.fromEntries(benign.filter(key => process.env[key]).map(key => [key, process.env[key]])), HOME: dirs.home, CLAUDE_CONFIG_DIR: dirs.config,
    NAW_RUNTIME_CONFIG: config, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: dirs.work, NAW_APP_VERSION: require(path.join(code, 'package.json')).version };
  daemon = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [dirs.profile], { env, execArgv: ['--require', path.join(root, 'scripts/fixtures/quota-observer.cjs')], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  daemon.on('message', value => { if (value.quotaObservation) trace.push(value.quotaObservation); });
  daemon.stderr.on('data', value => errors.push(value.toString()));
  await until(() => fs.existsSync(path.join(dirs.profile, 'connection.json')), 'Owned daemon started');
  client = await connectService(dirs.profile, 'quota-owner');
  if (gui) {
    scratch.childProcess.execFileSync(process.execPath, [path.join(root, 'scripts/build-ui.cjs')]);
    const { createSourceEntry } = require('./fixtures/synthetic-source-boot.cjs');
    const source = createSourceEntry({ profile: dirs.profile, code, fixturePid: daemon.pid });
    const { _electron } = scratch.playwright(require('playwright'));
    application = await _electron.launch({ executablePath: require('electron'), args: [source],
      env: { ...env, NAW_DATA_DIR: dirs.profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_VISIBLE: '0' }, timeout: 60000 });
    page = await application.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.locator('#session-list').waitFor({ state: 'attached', timeout: 30000 });
  }
  const id = await client.call('create', { provider: 'claude', cwd: dirs.work, name: 'Synthetic quota recovery', view: scenario === 'terminal' ? 'terminal' : 'chat', settings: { model: 'haiku' } });
  await until(async () => (await row())?.chatAvailable && (await row()).state === 'idle', 'Native root ready');
  if (gui) {
    await page.evaluate(id => workspace.viewState({ selected: id, mode: 'chat', preference: 'chat' }), id); await page.reload();
    await page.locator('#chat-tab').click();
    if (await page.locator('#take-control').isVisible()) await page.locator('#take-control').click();
  }
  const send = async text => {
    if (!gui) return client.call('send', id, text, before.nativeId);
    await page.locator('#message-input').fill(text);
    const button = page.locator('#composer button[type="submit"]'); assert.equal(await button.count(), 1);
    await until(async () => !(await button.isDisabled()), 'Ordinary chat send is enabled');
    await button.click();
  };
  const before = await row();
  await send('FIXED_QUOTA_FAILURE');
  await until(async () => (await row()).state === 'error', 'Native quota ended this root turn'); await delay(750);
  const failed = await row();
  assert.equal(failed.failedTurnInputAvailable, true, 'Chat can accept the next explicit input after quota failure');
  assert.equal(failed.activityUiMessage?.key, 'notice.failure.usageCreditsUnavailable');
  if (gui) {
    const language = process.env.NAW_TEST_UI_LANGUAGE || 'zh';
    const notice = require('../app/ui-locale.js').format(language, 'notice.failure.usageCreditsUnavailable');
    await until(async () => (await page.locator('#session-status').innerText()).includes(notice), 'The quota status explains the manual recovery');
    if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, `quota-${language}.png`) }); }
  }
  const atFailure = calls; await delay(1500); assert.equal(calls, atFailure, 'NAW does not retry or send a continuation');
  if (scenario === 'tool' || scenario === 'background') assert.equal(fs.readFileSync(marker, 'utf8'), 'ONCE\n');
  if (scenario === 'child') assert.ok(trace.some(e => e.event === 'SubagentStart'), 'A real child was started before quota');
  recovering = true;
  const input = scenario === 'terminal' ? 'FIXED_TERMINAL_RECOVERY' : 'FIXED_CHAT_RECOVERY';
  if (scenario === 'terminal') {
    await client.call('input', id, input);
    await until(async () => (await client.call('terminalSnapshot', id)).buffer.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').includes(input), 'Native edit line contains the exact text before Enter');
    await client.call('input', id, '\r');
  } else await send(input);
  await until(async () => (await row()).state === 'idle' && (await row()).messages.some(m => m.text?.includes('FIXED_QUOTA_RECOVERY_COMPLETE')), 'The explicit next message completes');
  const after = await row(); assert.equal(after.pid, before.pid); assert.equal(after.nativeId, before.nativeId);
  assert.equal(calls, atFailure + 1, 'Exactly one native request for the new user message');
  if (scenario === 'tool' || scenario === 'background') assert.equal(fs.readFileSync(marker, 'utf8'), 'ONCE\n', 'The old tool is not replayed');
  fixture.assertClean();
  assert.deepEqual(errors, []);
  const result = { scenario, version, paidModelCalls: 0, before, failed, after, trace, fixture: fixture.summary(), requestsBeforeRecovery: atFailure, requestsAfterRecovery: calls };
  fs.writeFileSync(path.join(base, 'result.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(base, 'native-terminal.json'), JSON.stringify(await client.call('terminalSnapshot', id)));
  console.log(JSON.stringify({ scenario, outcome: 'PASS', paidModelCalls: 0, requests: calls, identityPreserved: true, fixture: fixture.summary() }));
})().catch(async error => {
  console.error(error.stack); process.exitCode = 1;
  if (client) try { fs.writeFileSync(path.join(base, 'failure.json'), JSON.stringify({ snapshot: await snapshot(), trace, fixture: fixture.summary(), errors }, null, 2));
    const s = await row(); if (s) fs.writeFileSync(path.join(base, 'failure-terminal.json'), JSON.stringify(await client.call('terminalSnapshot', s.id))); } catch { /* preserve other evidence */ }
}).finally(async () => {
  await scratch.release();
  if (lease) {
    const current = fs.lstatSync(slot);
    assert.equal(current.ino, lease.ino); assert.equal(current.dev, lease.dev);
    assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, leaseToken);
    fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
  }
});
