// Actual alpha.2 backend + Claude 2.1.302 + current Electron. Three loopback
// responses, zero paid inference. No original profile or global keyboard access.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), { fork, execFileSync } = require('node:child_process');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connectService, connect } = require(path.join(code, 'app/service-client.cjs'));
const { installPlugin } = require(path.join(code, 'app/legacy-input.cjs'));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-native-retained-claude-'));
const profile = path.join(base, 'profile'), cwd = path.join(base, 'work'), config = path.join(base, 'claude'), old = path.join(base, 'old'), bin = path.join(base, 'bin');
for (const directory of [profile, cwd, config, old, bin]) fs.mkdirSync(directory, { mode: 0o700 });
const binary = process.env.NAW_CLAUDE_302;
assert.ok(binary, 'Set NAW_CLAUDE_302 to the retained native executable');
const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(); assert.match(version, /^2\.1\.302\b/);
const archive = execFileSync('git', ['archive', 'a87653b', 'app', 'package.json'], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
execFileSync('/usr/bin/tar', ['-x', '-C', old], { input: archive }); fs.symlinkSync(path.join(root, 'node_modules'), path.join(old, 'node_modules'));
let child, client, application, page, calls = 0, finishFinal;
const checks = [], errors = [], sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 30000) { const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await sleep(75); } throw Error(label); }
function event(res, type, data) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`); }
function block(res, index, item) {
  event(res, 'content_block_start', { index, content_block: item.type === 'text' ? { type: 'text', text: '' } : { ...item, input: {} } });
  event(res, 'content_block_delta', { index, delta: item.type === 'text' ? { type: 'text_delta', text: item.text } : { type: 'input_json_delta', partial_json: JSON.stringify(item.input) } });
  event(res, 'content_block_stop', { index });
}
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', b => body += b); req.on('end', () => {
    if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":100,"data":[]}'); return; }
    const number = ++calls; if (number > 3) { res.writeHead(429); res.end(); return; }
    const input = JSON.parse(body); fs.writeFileSync(path.join(base, `request-${number}.json`), body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    event(res, 'message_start', { message: { id: `msg_retained_${number}`, type: 'message', role: 'assistant', model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    const finish = reason => { event(res, 'message_delta', { delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 30 } }); event(res, 'message_stop', {}); res.end(); };
    if (number === 1) { block(res, 0, { type: 'text', text: 'RETAINED_HISTORY: original native answer.\n' }); finish('end_turn'); }
    if (number === 2) {
      block(res, 0, { type: 'text', text: 'RETAINED_PROGRESS: inspect the local result.\n' });
      block(res, 1, { type: 'tool_use', id: 'toolu_retained', name: 'Bash', input: { command: 'printf "RETAINED_TOOL: 42\\n"', description: 'Print the local fixture' } }); finish('tool_use');
    }
    if (number === 3) {
      event(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      event(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'RETAINED_FINAL_PREFIX: checking the native result.\n' } });
      finishFinal = () => { event(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: '42.\n' } }); event(res, 'content_block_stop', { index: 0 }); finish('end_turn'); finishFinal = null; };
    }
  });
});
const snapshot = () => page.evaluate(() => workspace.initial());
async function launch() {
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    ...(process.env.NAW_VIDEO_DIR ? { recordVideo: { dir: process.env.NAW_VIDEO_DIR, size: { width: 1280, height: 900 } } } : {}),
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await application.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  installPlugin(cwd);
  // Boot with the already released compatibility hook, then exercise the
  // actual explicit reload upgrade in this same native process.
  fs.writeFileSync(path.join(cwd, '.claude/skills/native-workspace-compat/hooks/register.js'),
    execFileSync('git', ['show', '2fe9784:app/claude-bridge/hooks/register.js'], { cwd: root, encoding: 'utf8' }).replace('const legacyOnly = false;', 'const legacyOnly = true;'), { mode: 0o600 });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/usr/bin/python3\nimport os,sys\nos.environ.pop("ANTHROPIC_AUTH_TOKEN",None)\nos.environ.pop("CLAUDE_CODE_OAUTH_TOKEN",None)\nos.environ.update(' +
    `ANTHROPIC_BASE_URL=${JSON.stringify(`http://127.0.0.1:${server.address().port}`)},ANTHROPIC_API_KEY="local-fixture",CLAUDE_CONFIG_DIR=${JSON.stringify(config)},CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1")\n` +
    `os.execv(${JSON.stringify(binary)},["claude"]+sys.argv[1:]+["--model","haiku","--debug-file",${JSON.stringify(path.join(base, 'native-debug.log'))},"--allowedTools","Bash(printf:*)"])\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [fs.realpathSync(cwd)]: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
  child = fork(path.join(old, 'app/daemon.cjs'), [profile], { env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
    NAW_APP_VERSION: '0.1.0-alpha.2', NAW_WORKSPACE: cwd }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Original backend boot');
  client = await connectService(profile, 'retained-fixture'); const id = await client.call('create', { provider: 'claude', cwd, name: 'Retained Claude', view: 'terminal' });
  await launch(); await page.locator(`[data-session-id="${id}"]`).click(); await page.locator('#terminal-tab').click();
  const takeover = page.getByRole('button', { name: '接管此窗口', exact: true });
  if (await takeover.isVisible()) await takeover.click();
  await until(async () => /Yes, I trust this folder|Do you want to use this API key|Claude Code v2/.test(await page.locator('#terminal-area').innerText()), 'Native boot', 60000);
  if ((await page.locator('#terminal-area').innerText()).includes('Yes, I trust this folder')) {
    assert.ok((await page.locator('#terminal-area').innerText()).includes(fs.realpathSync(cwd)));
    await page.locator('#terminal-area .xterm-screen').click(); await page.keyboard.press('ArrowDown'); await sleep(200); await page.keyboard.press('Enter');
  }
  await until(async () => /Do you want to use this API key|Claude Code v2/.test(await page.locator('#terminal-area').innerText()), 'Native key choice');
  if ((await page.locator('#terminal-area').innerText()).includes('Do you want to use this API key')) {
    await page.locator('#terminal-area .xterm-screen').click(); await page.keyboard.press('ArrowUp'); await sleep(200); await page.keyboard.press('Enter');
  }
  await until(async () => (await snapshot()).sessions.find(s => s.id === id)?.state === 'idle', 'Old native session ready');
  const before = (await snapshot()).sessions.find(s => s.id === id);
  await page.locator('#terminal-area .xterm-screen').click(); await page.keyboard.type('Keep the original history.'); await page.keyboard.press('Enter');
  await until(async () => (await snapshot()).sessions.find(s => s.id === id).messages.some(m => m.text.includes('RETAINED_HISTORY:')), 'Old hooks recorded native reply');
  await page.locator('#chat-tab').click();
  if (await page.locator('#send-button').textContent() === '接管此窗口') await page.locator('#send-button').click();
  assert.equal(await page.locator('#send-button').textContent(), '接通原会话输入'); await page.locator('#send-button').click();
  await until(async () => (await snapshot()).sessions.find(s => s.id === id)?.legacySubmit, 'Existing input plugin connected');
  await page.locator('#chat-tab').click();
  const linked = (await snapshot()).sessions.find(s => s.id === id);
  // The native file watcher may already have reloaded the updated project
  // plugin. Explain the pending case, but never require an obsolete warning.
  if (linked.legacyReaderPending) await until(async () => (await page.locator('#compose-hint').innerText()).includes('实时过程尚待更新') ||
    (await snapshot()).sessions.find(s => s.id === id).nativeBlockMapping, 'Pending reader notice or confirmed native hot reload');
  else assert.equal(linked.nativeBlockMapping, true);
  assert.equal(await page.locator('#message-input').getAttribute('readonly'), null);
  await page.locator('#terminal-tab').click(); await page.locator('#terminal-area .xterm-screen').click();
  await page.keyboard.type('/reload-plugins');
  await until(async () => (await page.locator('#terminal-area').innerText()).includes('/reload-plugins'), 'Native reload command shown');
  await sleep(300); await page.keyboard.press('Enter');
  await until(async () => { const s = (await snapshot()).sessions.find(s => s.id === id); return s.nativeBlockMapping && s.legacySubmit; }, 'Same-process reader and input ready');
  await page.locator('#chat-tab').click();
  assert.equal(await page.locator('#messages').getByText('RETAINED_HISTORY: original native answer.', { exact: true }).count(), 1);
  assert.equal(calls, 1); checks.push('Actual old backend and native TUI history retained on same-process input/reader attachment');
  await page.locator('#message-input').fill('Read the local result in the unified interface.'); await page.locator('#send-button').click();
  await until(() => calls === 3 && finishFinal, 'Native tool and held final');
  await page.locator('#messages').getByText('RETAINED_PROGRESS: inspect the local result.', { exact: true }).waitFor();
  await until(async () => (await page.locator('#messages').innerText()).includes('RETAINED_TOOL: 42'), 'Native tool in main reader');
  await until(async () => (await page.locator('#messages').innerText()).includes('RETAINED_FINAL_PREFIX:'), 'Partial final before native completion');
  assert.equal(await page.locator('#messages').getByText('Read the local result in the unified interface.', { exact: true }).count(), 1);
  assert.equal(await page.locator('.native-progress').count(), 0);
  fs.writeFileSync(path.join(base, 'streaming.json'), JSON.stringify(await snapshot(), null, 2));
  checks.push('Actual 302 display and tool events stream into attributed main-reader blocks; one visible input and no camera panel');
  await page.locator('#message-input').fill('Unsent reader draft'); await sleep(300);
  await application.close(); application = null; await launch();
  await until(async () => (await snapshot()).sessions.find(s => s.id === id)?.legacySubmit, 'Rebound observer after GUI reopen');
  assert.equal(await page.locator('#message-input').inputValue(), 'Unsent reader draft');
  await page.locator(`[data-session-menu="${id}"]`).click();
  const secondOpened = application.waitForEvent('window');
  await page.getByRole('menuitem', { name: '在独立窗口打开', exact: true }).click();
  const secondPage = await secondOpened; await secondPage.locator('#new-session').waitFor();
  finishFinal();
  await until(async () => (await snapshot()).sessions.find(s => s.id === id).messages.some(m => m.kind === 'turn'), 'Native completion after reopen');
  const after = (await snapshot()).sessions.find(s => s.id === id);
  assert.equal(after.nativeId, before.nativeId); assert.equal(after.pid, before.pid);
  assert.equal(after.messages.filter(m => m.text.includes('RETAINED_FINAL_PREFIX:')).length, 1);
  assert.ok(after.messages.some(m => m.text.includes('RETAINED_FINAL_PREFIX:') && m.text.endsWith('42.\n')));
  assert.equal(calls, 3); assert.equal(await page.locator('#message-input').inputValue(), 'Unsent reader draft');
  await until(async () => (await secondPage.locator('#messages').innerText()).includes('42.'), 'Second window receives new final');
  await secondPage.close();
  fs.writeFileSync(path.join(base, 'completed.json'), JSON.stringify(await snapshot(), null, 2));
  checks.push('GUI reopen retains native PID/identity, displayed partial and draft; new final updates the same block without duplicate old Stop text');
  await page.locator('#terminal-tab').click(); await until(async () => (await page.locator('#terminal-area').innerText()).includes('RETAINED_FINAL_PREFIX:'), 'Original terminal final');
  fs.writeFileSync(path.join(base, 'terminal.txt'), await page.locator('#terminal-area').innerText()); await page.locator('#chat-tab').click();
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'retained-claude-reader.png') }); }
  const debug = fs.readFileSync(path.join(base, 'native-debug.log'), 'utf8');
  assert.ok(!debug.includes('Plugin loading errors:'), 'Native plugin discovery/reload has no load errors');
  await page.locator('#terminal-tab').click(); await page.locator('#terminal-area .xterm-screen').click();
  await page.keyboard.type('/exit');
  await until(async () => (await page.locator('#terminal-area').innerText()).includes('/exit'), 'Native exit command shown');
  await sleep(300); await page.keyboard.press('Enter');
  await until(async () => (await snapshot()).sessions.find(s => s.id === id)?.state === 'ended', 'Owned native process ended', 30000);
  await page.locator('#chat-tab').click();
  assert.ok((await page.locator('#messages').innerText()).includes('RETAINED_FINAL_PREFIX:'));
  await application.close(); application = null; await launch();
  assert.ok((await page.locator('#messages').innerText()).includes('RETAINED_FINAL_PREFIX:'));
  const ended = (await snapshot()).sessions.find(s => s.id === id);
  assert.equal(ended.pid, null); assert.equal(ended.nativeId, before.nativeId); assert.equal(ended.state, 'ended');
  assert.equal(calls, 3);
  checks.push('Second window receives new output; native exit and ended-history reopen preserve reader without a new process or model turn');
  fs.writeFileSync(path.join(base, 'ended.json'), JSON.stringify(await snapshot(), null, 2));
  assert.deepEqual(errors, []); console.log(JSON.stringify({ checks, nativeVersion: version, localResponses: calls, paidModelCalls: 0, errors, evidence: base }));
})().catch(async error => {
  if (page && !page.isClosed()) { fs.writeFileSync(path.join(base, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {}); }
  if (client) try { const s = (await client.call('initial')).sessions[0]; fs.writeFileSync(path.join(base, 'failure-native.json'), JSON.stringify(await client.call('snapshot', s.id))); } catch {}
  console.error(error.stack, '\nEvidence:', base); process.exitCode = 1;
}).finally(async () => {
  finishFinal?.(); if (application) await application.close(); client?.close();
  try { const cleanup = await connect(profile, 'cleanup'); for (const s of (await cleanup.call('initial')).sessions) await cleanup.call('stop', s.id);
    for (const entry of cleanup.entries) await entry.client.call('shutdown'); cleanup.close(); } catch {}
  if (child?.connected) child.disconnect(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
});
