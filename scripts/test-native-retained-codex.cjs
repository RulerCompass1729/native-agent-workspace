const { chooseRecipient: inlineRecipient, fillRoomMessage, roomBody } = require('./room-input.cjs');
// Actual retained alpha.2 host, native Codex and current Electron; four task Responses streams plus at most one native title response.
// Native execution and UI are real; inference is fixed.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), { execFileSync, fork } = require('node:child_process');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
if (!process.env.NAW_APP_EXECUTABLE) execFileSync(process.execPath, [path.join(root, 'scripts/build-ui.cjs')]);
const { executable, processIdentity, processMayBeAlive } = require('../app/platform.cjs');
const { connectService, connect } = require(path.join(code, 'app/service-client.cjs'));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-native-retained-codex-'));
const profile = path.join(base, 'profile'), cwd = path.join(base, 'work'), home = path.join(base, 'codex'), old = path.join(base, 'old'), bin = path.join(base, 'bin');
for (const dir of [profile, cwd, home, old, bin]) fs.mkdirSync(dir, { mode: 0o700 });
const binary = executable('codex'); assert.ok(binary);
const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(); assert.equal(version, 'codex-cli 0.163.0');
execFileSync('/usr/bin/tar', ['-x', '-C', old], { input: execFileSync('git', ['archive', 'a87653b', 'app', 'package.json'], { cwd: root, maxBuffer: 16 * 1024 * 1024 }) });
fs.symlinkSync(path.join(root, 'node_modules'), path.join(old, 'node_modules'));
let application, page, client, child, calls = 0, titleCalls = 0, sequence = 0, release;
const errors = [], requests = [], checks = [], sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, timeout = 30000) { const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await sleep(75); } throw Error(label); }
function event(res, type, body) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: ++sequence, ...body })}\n\n`); }
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', b => body += b); req.on('end', async () => {
    if (!req.url.endsWith('/responses')) { requests.push({ path: req.url.split('?')[0] }); res.writeHead(404); res.end(); return; }
    const input = JSON.parse(body);
    // The original native TUI may name a new thread by itself. Count that native
    // request separately; the portal neither enables it nor claims it costs zero.
    const nativeTitle = input.input?.some(m => m.role === 'user' && m.content?.some(p =>
      typeof p.text === 'string' && p.text.startsWith('Generate a concise, single-line task title')));
    const number = nativeTitle ? 0 : ++calls; if (nativeTitle) titleCalls++;
    if (calls > 4 || titleCalls > 1) { res.writeHead(429); res.end(); return; }
    requests.push({ model: input.model, inputItems: input.input?.length, nativeTitle });
    fs.writeFileSync(path.join(base, nativeTitle ? 'native-title-request.json' : `request-${number}.json`), JSON.stringify(input, null, 2));
    const response = { id: `resp_local_${number}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model: input.model, output: [], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    event(res, 'response.created', { response });
    if (number === 3) {
      const patch = '*** Begin Patch\n*** Add File: sample.txt\n+NATIVE_TOOL_FILE: hello 世界\n*** End Patch';
      const code = `text(await tools.apply_patch(${JSON.stringify(patch)})); text(await tools.exec_command(${JSON.stringify({ cmd: 'cat sample.txt', workdir: cwd, max_output_tokens: 100, sandbox_permissions: 'require_escalated', justification: 'Read the isolated test file once for the native permission check' })}));`;
      const tool = { id: 'tool_local_1', type: 'custom_tool_call', call_id: 'call_local_1', namespace: 'functions', name: 'exec', input: code, status: 'completed' };
      event(res, 'response.output_item.added', { output_index: 0, item: { ...tool, input: '', status: 'in_progress' } });
      event(res, 'response.custom_tool_call_input.delta', { output_index: 0, item_id: tool.id, delta: code });
      event(res, 'response.custom_tool_call_input.done', { output_index: 0, item_id: tool.id, input: code });
      event(res, 'response.output_item.done', { output_index: 0, item: tool });
      event(res, 'response.completed', { response: { ...response, status: 'completed', output: [tool] } }); res.end(); return;
    }
    const text = number === 0 ? JSON.stringify({ title: 'Inspect original task' }) : number === 1 ? 'RETAINED_CODEX_HISTORY: private original answer.' : number === 2 ? 'RETAINED_CODEX_SHARED: original task result.' : 'NATIVE_TOOL_DONE: created and read sample.txt.';
    const item = { id: `msg_local_${number}`, type: 'message', role: 'assistant', status: 'in_progress', content: [], phase: 'final_answer' };
    event(res, 'response.output_item.added', { output_index: 0, item });
    event(res, 'response.content_part.added', { output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    event(res, 'response.output_text.delta', { output_index: 0, item_id: item.id, content_index: 0, delta: text });
    if (number === 2) await new Promise(resolve => { release = resolve; });
    item.status = 'completed'; item.content = [{ type: 'output_text', text, annotations: [] }];
    event(res, 'response.output_text.done', { output_index: 0, item_id: item.id, content_index: 0, text });
    event(res, 'response.content_part.done', { output_index: 0, item_id: item.id, content_index: 0, part: item.content[0] });
    event(res, 'response.output_item.done', { output_index: 0, item });
    event(res, 'response.completed', { response: { ...response, status: 'completed', output: [item] } }); res.end();
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
  fs.writeFileSync(path.join(home, 'config.toml'), `model = "gpt-6-luna"\nmodel_provider = "local_fixture"\nmodel_reasoning_effort = "low"\n[model_providers.local_fixture]\nname = "Local protocol fixture"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`, { mode: 0o600 });
  const shim = path.join(bin, 'codex');
  fs.writeFileSync(shim, '#!/usr/bin/python3\nimport os,sys\n' +
    `os.environ["CODEX_HOME"]=${JSON.stringify(home)}\n` +
    'for key in ["OPENAI_API_KEY","CODEX_API_KEY"]: os.environ.pop(key,None)\n' +
    `os.execv(${JSON.stringify(binary)},["codex"]+sys.argv[1:])\n`, { mode: 0o700 });

  child = fork(path.join(old, 'app/daemon.cjs'), [profile], { env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
    NAW_APP_VERSION: '0.1.0-alpha.2', NAW_WORKSPACE: cwd }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Original backend boot');
  client = await connectService(profile, 'retained-codex-fixture');
  const id = await client.call('create', { provider: 'codex', cwd, name: 'Retained Codex', view: 'terminal' });
  await launch(); await page.locator(`[data-session-id="${id}"]`).click(); await page.locator('#terminal-tab').click();
  const takeover = page.locator('#take-control');
  if (await takeover.isVisible()) await takeover.click();
  await until(async () => (await page.locator('#terminal-area').innerText()).includes('Trust this folder?') ||
    (await snapshot()).sessions.find(s => s.id === id)?.state === 'idle', 'Native folder gate', 60000);
  if ((await page.locator('#terminal-area').innerText()).includes('Trust this folder?')) {
    const prompt = await page.locator('#terminal-area').innerText();
    assert.ok(prompt.includes(cwd) || prompt.includes(fs.realpathSync(cwd))); assert.match(prompt, /› 1\. Trust and continue/);
    await page.locator('#terminal-area .xterm-helper-textarea').press('Enter');
  }
  await until(async () => (await snapshot()).sessions.find(s => s.id === id)?.state === 'idle', 'Old native session ready', 60000);
  const before = (await snapshot()).sessions.find(s => s.id === id);
  await page.locator('#terminal-area .xterm-screen').click(); await page.keyboard.type('Keep this original private history.');
  await until(async () => (await page.locator('#terminal-area').innerText()).includes('Keep this original private history.'), 'Typed native input');
  await page.keyboard.press('Enter');
  await until(async () => calls === 1 && (await page.locator('#terminal-area').innerText()).includes('RETAINED_CODEX_HISTORY'), 'Original native answer', 60000);
  await page.locator('#chat-tab').click();
  if (await page.locator('#send-button').textContent() === '接管此窗口') await page.locator('#send-button').click();
  assert.equal(await page.locator('#send-button').textContent(), '接通原会话输入'); await page.locator('#send-button').click();
  await page.locator('#messages').getByText('RETAINED_CODEX_HISTORY: private original answer.', { exact: true }).waitFor();
  const linked = (await snapshot()).sessions.find(s => s.id === id);
  assert.equal(linked.nativeId, before.nativeId); assert.equal(linked.pid, before.pid); assert.equal(linked.legacySharedReply, true);
  await until(async()=> (await snapshot()).sessions.find(s=>s.id===id).messages.some(m=>m.kind==='turn'&&Number.isFinite(m.nativeCompletedAt)),'Original pre-share history completion time');
  const originalBoundary=(await snapshot()).sessions.find(s=>s.id===id).messages.find(m=>m.kind==='turn'&&Number.isFinite(m.nativeCompletedAt));
  fs.writeFileSync(path.join(base,'original-boundary-before-share.json'),JSON.stringify(originalBoundary,null,2));
  checks.push('Original native history attaches to the same process and ID without another model request');
  await page.locator('#message-input').fill('Unsent private draft.');
  await page.locator('#header-actions').getByRole('button', { name: '加入协作', exact: true }).click();
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await inlineRecipient(page, id);
  await fillRoomMessage(page, 'Report the shared task result.'); await page.locator('#forward-button').click();
  await page.locator('#room-messages').getByText('RETAINED_CODEX_SHARED: original task result.', { exact: true }).waitFor();
  const streaming = await snapshot(), row = streaming.room.messages.find(m => m.role === 'assistant');
  assert.equal(row.status, 'streaming'); assert.equal(row.sessionId, id); assert.ok(row.nativeMessageId);
  assert.ok(!JSON.stringify(streaming.room.messages).includes('RETAINED_CODEX_HISTORY'));
  assert.ok(!JSON.stringify(streaming.room.messages).includes('Unsent private draft'));
  assert.equal(streaming.room.messages.find(m => m.role === 'human').manualReply, false);
  assert.ok(!(await page.locator('#run-help').innerText()).includes('回复在成员视图'));
  fs.writeFileSync(path.join(base, 'streaming.json'), JSON.stringify(streaming, null, 2));
  await fillRoomMessage(page, 'A newer shared draft.'); await page.reload(); await page.locator('#new-session').waitFor();
  assert.equal(await roomBody(page), 'A newer shared draft.'); assert.equal(calls, 2);
  release(); release = null;
  await until(async () => (await snapshot()).room.messages.some(m => m.id === row.id && m.finalReply), 'Native final updates the original block');
  const completed = await snapshot(); fs.writeFileSync(path.join(base, 'completed.json'), JSON.stringify(completed, null, 2));
  assert.equal(completed.room.messages.filter(m => m.role === 'assistant').length, 1);
  assert.equal(completed.diagnostics.dispatches, 1); assert.equal(calls, 2);
  assert.equal(completed.sessions.find(s => s.id === id).pid, before.pid);
  assert.equal(completed.sessions.find(s=>s.id===id).messages.find(m=>m.id===originalBoundary.id).nativeCompletedAt,originalBoundary.nativeCompletedAt);
  const sharedBoundary=completed.room.messages.find(m=>m.kind==='turn');
  assert.ok(sharedBoundary&&Number.isFinite(sharedBoundary.nativeCompletedAt));
  assert.ok(Number.isSafeInteger(sharedBoundary.nativeDurationMs));
  assert.notEqual(sharedBoundary.turnId,originalBoundary.turnId,'The restored old boundary is not the newly completed shared turn');
  checks.push('Shared native output updates one attributed block across reload; private history/draft stay private');
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'retained-codex-shared.png') }); }
  await application.close(); application = null; await launch();
  await page.locator('#room-messages').getByText('RETAINED_CODEX_SHARED: original task result.', { exact: true }).waitFor();
  assert.equal(calls, 2); assert.equal((await snapshot()).diagnostics.dispatches, 1);
  assert.equal(await roomBody(page), 'A newer shared draft.');
  await page.locator(`[data-session-id="${id}"]`).click(); await page.locator('#chat-tab').click();
  if (await page.locator('#send-button').textContent() === '接管此窗口') await page.locator('#send-button').click();
  await until(async () => (await snapshot()).sessions.find(s => s.id === id).state === 'idle', 'Reopened native connection');
  assert.equal(await page.locator('#message-input').inputValue(), 'Unsent private draft.');
  checks.push('GUI closure restores shared history and both drafts without native replacement or replay');
  if(process.env.NAW_RETAINED_TIMING_ONLY==='1') {
    const reopened=await snapshot();
    assert.equal(reopened.room.messages.find(m=>m.id===sharedBoundary.id).nativeCompletedAt,sharedBoundary.nativeCompletedAt);
    assert.equal(reopened.sessions.find(s=>s.id===id).nativeId,before.nativeId);
    assert.deepEqual(errors,[]);
    checks.push('Retained alpha.2 original history and new shared native completion retain exact timing through reopening');
    console.log(JSON.stringify({version,checks,taskResponses:calls,nativeTitleResponses:titleCalls,paidModelCalls:0,evidence:base,errors}));return;
  }
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await fillRoomMessage(page, 'Create sample.txt with the provided line, then read it back.'); await page.locator('#forward-button').click();
  await until(async () => (await snapshot()).sessions.find(s => s.id === id).state === 'approval', 'Actual native command approval', 45000);
  const permission = await snapshot(); fs.writeFileSync(path.join(base, 'permission.json'), JSON.stringify(permission, null, 2));
  assert.equal(permission.sessions.find(s => s.id === id).approval.method, 'item/commandExecution/requestApproval');
  assert.ok(permission.room.messages.some(m => m.role === 'tool' && m.sharingStopped));
  await page.locator(`[data-session-id="${id}"]`).click(); await page.locator('#terminal-tab').click();
  await until(async () => (await page.locator('#terminal-area').innerText()).includes('Would you like to run the following command?'), 'Native permission UI', 45000);
  const confirmation = await page.locator('#terminal-area').innerText(); fs.writeFileSync(path.join(base, 'permission.txt'), confirmation);
  assert.match(confirmation, /sample.txt/); assert.match(confirmation, /› 1\. Yes, proceed \(y\)/);
  if (process.env.NAW_RETAINED_GUI_APPROVAL === '1') {
    await page.locator('#chat-tab').click();
    await page.locator('#approval').getByRole('button', { name: '允许这一次', exact: true }).click();
  } else await page.locator('#terminal-area .xterm-helper-textarea').press('Enter');
  await until(async () => (await snapshot()).sessions.find(s => s.id === id).messages.some(m => m.text === 'NATIVE_TOOL_DONE: created and read sample.txt.'), 'Post-permission private result', 45000);
  await until(async () => (await snapshot()).sessions.find(s => s.id === id).state === 'idle', 'Native completed');
  assert.equal(fs.readFileSync(path.join(cwd, 'sample.txt'), 'utf8'), 'NATIVE_TOOL_FILE: hello 世界\n');
  const done = await snapshot(); fs.writeFileSync(path.join(base, 'post-permission.json'), JSON.stringify(done, null, 2));
  assert.ok(!done.room.messages.some(m => m.text === 'NATIVE_TOOL_DONE: created and read sample.txt.'));
  assert.ok(done.sessions.find(s => s.id === id).messages.some(m => m.role === 'tool' && m.text.includes('NATIVE_TOOL_FILE: hello 世界')));
  assert.equal(done.diagnostics.dispatches, 2); assert.equal(calls, 4);
  await page.locator('#chat-tab').click();
  await page.locator('#header-actions').getByRole('button', { name: '脱出协作', exact: true }).click();
  await page.locator('#header-actions').getByRole('button', { name: '加入协作', exact: true }).click();
  assert.ok(!(await snapshot()).room.messages.some(m => m.text === 'NATIVE_TOOL_DONE: created and read sample.txt.'));
  assert.equal((await snapshot()).sessions.find(s => s.id === id).nativeId, before.nativeId);
  assert.equal((await snapshot()).sessions.find(s => s.id === id).pid, before.pid);
  checks.push('Actual native command permission freezes sharing before later private result; departure/rejoin never republishes it');
  if (process.env.NAW_RETAINED_GUI_APPROVAL === '1') checks.push('The current graphical approval action resolves the retained original native command request without replacing its backend');
  const request = JSON.parse(fs.readFileSync(path.join(base, 'request-2.json')));
  assert.equal(request.input.filter(item => item.role === 'user' && item.content?.some(p => p.text === 'Report the shared task result.')).length, 1);
  assert.ok(!JSON.stringify(request.input).includes('Unsent private draft'));
  await page.locator('#terminal-tab').click();
  await until(async () => (await page.locator('#terminal-area').innerText()).includes('NATIVE_TOOL_DONE'), 'Native terminal matches private reader');
  fs.writeFileSync(path.join(base, 'native-terminal.txt'), await page.locator('#terminal-area').innerText());
  assert.equal(await page.locator('.native-progress').count(), 0); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ version, checks, taskResponses: calls, nativeTitleResponses: titleCalls, localResponses: calls + titleCalls, paidModelCalls: 0, evidence: base, errors }));
})().catch(async error => {
  if (page && !page.isClosed()) { fs.writeFileSync(path.join(base, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(base, 'failure-state.json'), JSON.stringify(await snapshot().catch(() => ({})), null, 2)); }
  console.error(error.stack, '\nEvidence:', base); process.exitCode = 1;
}).finally(async () => {
  release?.(); server.closeAllConnections(); if (application) await application.close().catch(() => {}); client?.close();
  try { const cleanup = await connect(profile, 'cleanup');
    try {
      for (const s of (await cleanup.call('initial')).sessions) await cleanup.call('stop', s.id);
      const owned = cleanup.entries.map(e => processIdentity(e.state.servicePid));
      for (const identity of owned) { assert.ok(identity && processMayBeAlive(identity)); process.kill(identity.pid, 'SIGTERM'); }
      await until(() => owned.every(identity => !processMayBeAlive(identity)), 'Owned services exit', 15000);
    } finally { cleanup.close(); }
  } catch (error) { console.error('Owned cleanup unconfirmed:', error.message); process.exitCode = 1; }
  if (child?.connected) child.disconnect(); await new Promise(resolve => server.close(resolve));
});
