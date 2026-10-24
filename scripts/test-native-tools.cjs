const { chooseRecipient: inlineRecipient, fillRoomMessage, roomBody } = require('./room-input.cjs');
// Actual Codex tool execution and Electron with two canned loopback Responses streams.
// Private native configuration; no paid inference or normal-profile edits.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), { execFileSync } = require('node:child_process');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const { executable, processIdentity, processMayBeAlive } = require('../app/platform.cjs'), { connect } = require('../app/service-client.cjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-native-tools-'));
const profile = path.join(base, 'profile'), cwd = path.join(base, 'work'), home = path.join(base, 'codex');
for (const dir of [profile, cwd, home]) fs.mkdirSync(dir, { mode: 0o700 });
const binary = executable('codex'); if (!binary) throw Error('Real Codex required');
const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
assert.equal(version, 'codex-cli 0.163.0');
let application, page, calls = 0, sequence = 0;
const errors = [], requests = [], sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, timeout = 30000) {
  const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await sleep(75); } throw Error(label);
}
function event(res, type, body) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: ++sequence, ...body })}\n\n`); }
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', b => body += b); req.on('end', async () => {
    if (!req.url.endsWith('/responses')) { requests.push({ path: req.url.split('?')[0] }); res.writeHead(404); res.end(); return; }
    const number = ++calls;
    if (number > 2) { res.writeHead(429); res.end(); return; }
    const input = JSON.parse(body); requests.push({ model: input.model, inputItems: input.input?.length });
    fs.writeFileSync(path.join(base, `request-${number}.json`), JSON.stringify(input, null, 2));
    const response = { id: `resp_local_${number}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model: input.model, output: [], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    event(res, 'response.created', { response });
    if (number === 1) {
      const patch = '*** Begin Patch\n*** Add File: sample.txt\n+NATIVE_TOOL_FILE: hello 世界\n*** End Patch';
      const code = `text(await tools.apply_patch(${JSON.stringify(patch)})); text(await tools.exec_command(${JSON.stringify({ cmd: 'cat sample.txt', workdir: cwd, max_output_tokens: 100 })}));`;
      const tool = { id: 'tool_local_1', type: 'custom_tool_call', call_id: 'call_local_1', namespace: 'functions', name: 'exec', input: code, status: 'completed' };
      event(res, 'response.output_item.added', { output_index: 0, item: { ...tool, input: '', status: 'in_progress' } });
      event(res, 'response.custom_tool_call_input.delta', { output_index: 0, item_id: tool.id, delta: code });
      event(res, 'response.custom_tool_call_input.done', { output_index: 0, item_id: tool.id, input: code });
      event(res, 'response.output_item.done', { output_index: 0, item: tool });
      event(res, 'response.completed', { response: { ...response, status: 'completed', output: [tool] } }); res.end(); return;
    }
    const text = 'NATIVE_TOOL_DONE: created and read sample.txt.';
    const item = { id: 'msg_local_2', type: 'message', role: 'assistant', status: 'in_progress', content: [], phase: 'final_answer' };
    event(res, 'response.output_item.added', { output_index: 0, item });
    event(res, 'response.content_part.added', { output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    event(res, 'response.output_text.delta', { output_index: 0, item_id: item.id, content_index: 0, delta: text });
    item.status = 'completed'; item.content = [{ type: 'output_text', text, annotations: [] }];
    event(res, 'response.output_text.done', { output_index: 0, item_id: item.id, content_index: 0, text });
    event(res, 'response.content_part.done', { output_index: 0, item_id: item.id, content_index: 0, part: item.content[0] });
    event(res, 'response.output_item.done', { output_index: 0, item });
    event(res, 'response.completed', { response: { ...response, status: 'completed', output: [item] } }); res.end();
  });
});
const snapshot = () => page.evaluate(() => workspace.initial());
async function revealTools(selector) {
  for (const disclosure of await page.locator(selector + ' .process-details').all()) {
    if (await disclosure.getAttribute('open') === null) await disclosure.locator(':scope > summary').click();
  }
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(home, 'config.toml'), `model = "gpt-6-luna"\nmodel_provider = "local_fixture"\nmodel_reasoning_effort = "low"\nsandbox_mode = "read-only"\napproval_policy = "on-request"\n[model_providers.local_fixture]\nname = "Local protocol fixture"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`, { mode: 0o600 });
  // Trust only the owned empty fixture folder. The actual file permission
  // remains on-request and must still be answered in the real native UI.
  for (const folder of new Set([cwd, fs.realpathSync(cwd)])) fs.appendFileSync(path.join(home, 'config.toml'), `\n[projects.${JSON.stringify(folder)}]\ntrust_level = "trusted"\n`);
  const shim = path.join(base, 'codex-local');
  fs.writeFileSync(shim, '#!/usr/bin/python3\nimport os,sys\n' +
    `os.environ["CODEX_HOME"]=${JSON.stringify(home)}\n` +
    'for key in ["OPENAI_API_KEY","CODEX_API_KEY"]: os.environ.pop(key,None)\n' +
    `os.execv(${JSON.stringify(binary)},["codex"]+sys.argv[1:])\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify({ codex: shim }), { mode: 0o600 });
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], ...(process.env.NAW_VIDEO_DIR ? { recordVideo: { dir: process.env.NAW_VIDEO_DIR, size: { width: 1280, height: 900 } } } : {}), env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  await until(async () => { for (const candidate of application.windows()) if (!candidate.isClosed() && await candidate.locator('#new-session').count().catch(() => 0)) { page = candidate; return true; } return false; }, 'Main workspace');
  page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check();
  await page.locator('#initial-view').selectOption('chat'); await page.locator('#session-name').fill('Native tools'); await page.locator('#confirm-create').click();
  await until(async () => (await snapshot()).sessions[0]?.state === 'idle', 'Native Codex ready');
  const before = (await snapshot()).sessions[0]; assert.equal(before.model, 'gpt-6-luna');
  await page.locator('#header-actions').getByRole('button', { name: '加入协作', exact: true }).click();
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await inlineRecipient(page, before.id);
  await fillRoomMessage(page, 'Create sample.txt with the provided line, then read it back.'); await page.locator('#forward-button').click();
  await until(async () => { const s = (await snapshot()).sessions[0]; return s.state === 'approval' || s.messages.some(m => m.text === 'NATIVE_TOOL_DONE: created and read sample.txt.'); }, 'Native tool starts', 45000);
  assert.equal((await snapshot()).sessions[0].state, 'approval', 'This scenario requires a real native file permission, not an automatically allowed tool');
  if ((await snapshot()).sessions[0].state === 'approval') {
    await page.locator(`[data-session-id="${before.id}"]`).click(); await page.locator('#terminal-tab').click();
    await until(async () => (await page.locator('#terminal-area').innerText()).includes('sample.txt'), 'Native approval is rendered', 45000);
    fs.writeFileSync(path.join(base, 'approval.txt'), await page.locator('#terminal-area').innerText());
    fs.writeFileSync(path.join(base, 'approval.json'), JSON.stringify(await snapshot(), null, 2));
    await page.screenshot({ path: path.join(base, 'approval.png') });
    console.log('Native approval evidence:', base);
    const confirmation = await page.locator('#terminal-area').innerText();
    const approval = (await snapshot()).sessions[0].approval;
    assert.equal(approval.method, 'item/fileChange/requestApproval');
    assert.match(confirmation, /Would you like to make the following edits\?/);
    assert.match(confirmation, /› 1\. Yes, proceed \(y\)/);
    const patch = (await snapshot()).sessions[0].messages.find(m => m.title === '文件修改');
    assert.equal(patch.text, `新增 ${path.join(cwd, 'sample.txt')}\nNATIVE_TOOL_FILE: hello 世界\n`);
    // Only the isolated, exact one-file change above is approved once. This
    // does not change native permission defaults or grant future file access.
    await page.locator('#terminal-area .xterm-helper-textarea').press('Enter');
  }
  await until(async () => (await snapshot()).sessions[0].messages.some(m => m.text === 'NATIVE_TOOL_DONE: created and read sample.txt.'), 'Native tools and final response', 45000);
  await until(async () => (await snapshot()).sessions[0].state === 'idle', 'Native turn ends');
  const done = await snapshot(); fs.writeFileSync(path.join(base, 'completed.json'), JSON.stringify(done, null, 2));
  assert.equal(fs.readFileSync(path.join(cwd, 'sample.txt'), 'utf8'), 'NATIVE_TOOL_FILE: hello 世界\n');
  const tools = done.sessions[0].messages.filter(m => m.role === 'tool');
  assert.ok(tools.some(m => m.text.includes('NATIVE_TOOL_FILE: hello 世界')), 'Native tool body reaches solo reading list');
  assert.ok(done.room.messages.some(m => m.role === 'tool' && m.text.includes('NATIVE_TOOL_FILE: hello 世界')), 'Explicitly routed tool result reaches shared reader');
  assert.ok(done.room.messages.every(m => !m.nativeMessageId || m.sessionId === before.id), 'Shared rows retain agent identity');
  assert.ok(!done.room.messages.some(m => m.text === 'NATIVE_TOOL_DONE: created and read sample.txt.'), 'Permission revocation keeps later native replies private');
  assert.ok(done.room.messages.some(m => m.role === 'tool' && m.sharingStopped), 'Shared diff explicitly freezes when approval is requested');
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await revealTools('#room-messages');
  const roomText = await page.locator('#room-messages').innerText(); fs.writeFileSync(path.join(base, 'shared-reader.txt'), roomText);
  assert.match(roomText, /NATIVE_TOOL_FILE: hello 世界/);
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'shared-tools.png') }); }
  await page.locator(`[data-session-id="${before.id}"]`).click();
  await revealTools('#messages');
  assert.match(await page.locator('#messages').innerText(), /NATIVE_TOOL_FILE: hello 世界/);
  await page.locator('#terminal-tab').click();
  await until(async () => (await page.locator('#terminal-area').innerText()).includes('NATIVE_TOOL_DONE'), 'Native TUI shows the same result', 60000);
  fs.writeFileSync(path.join(base, 'native-terminal.txt'), await page.locator('#terminal-area').innerText());
  await page.locator('#chat-tab').click();
  await page.reload(); await page.locator('#new-session').waitFor();
  await until(async () => (await snapshot()).sessions[0].nativeId === before.nativeId, 'Reader reload identity');
  assert.match(await page.locator('#messages').innerText(), /NATIVE_TOOL_FILE: hello 世界/);
  assert.equal(calls, 2); assert.equal((await snapshot()).diagnostics.dispatches, 1); assert.deepEqual(errors, []);
  // Separate real service-protocol recovery check. The OS confirmation dialog
  // is not automated here; the existing GUI confirmation tests cover its route.
  const roomBeforeRecovery = JSON.stringify((await snapshot()).room.messages);
  const recovery = await connect(profile, before.owner);
  try { await recovery.call('stop', before.id); await recovery.call('resume', before.id); }
  finally { recovery.close(); }
  await until(async () => { const s = (await snapshot()).sessions[0]; return s.state === 'idle' && s.chatAvailable; }, 'Native history resubscribed', 45000);
  const recovered = await snapshot(); fs.writeFileSync(path.join(base, 'recovered.json'), JSON.stringify(recovered, null, 2));
  assert.equal(recovered.sessions[0].nativeId, before.nativeId);
  assert.equal(JSON.stringify(recovered.room.messages), roomBeforeRecovery, 'Native history cannot add shared messages');
  assert.ok(recovered.sessions[0].messages.some(m => m.role === 'tool' && m.text.includes('NATIVE_TOOL_FILE: hello 世界')));
  assert.equal(calls, 2); assert.equal(recovered.diagnostics.dispatches, 1);
  const request = JSON.parse(fs.readFileSync(path.join(base, 'request-2.json'), 'utf8'));
  assert.ok(JSON.stringify(request.input).includes('NATIVE_TOOL_FILE: hello 世界'), 'Real tool result returned to the native model input');
  console.log(JSON.stringify({ version, checks: ['Native tool really creates and reads the isolated file', 'Authorized file diff appears in the shared reader; permission revocation keeps later output private', 'GUI and TUI retain same native identity', 'Reload neither loses tool text nor dispatches', 'Separate native service resubscription hydrates tool history without sharing or another response'], localResponses: calls, paidModelCalls: 0, requests, evidence: base }));
})().catch(async error => {
  if (page && !page.isClosed()) { fs.writeFileSync(path.join(base, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {}); }
  console.error(error.stack, '\nEvidence:', base); process.exitCode = 1;
}).finally(async () => {
  server.closeAllConnections();
  if (application) await application.close().catch(() => {});
  try {
    const client = await connect(profile, 'native-tools-cleanup');
    try {
      for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id);
      // Codex unsubscribe deliberately reports disconnected, not fleet-ended.
      // This isolated fixture owns its entire daemon/server and creates no fleet.
      const owned = client.entries.map(entry => processIdentity(entry.state.servicePid));
      for (const identity of owned) {
        assert.ok(identity && processMayBeAlive(identity));
        process.kill(identity.pid, 'SIGTERM');
      }
      await until(() => owned.every(identity => !processMayBeAlive(identity)), 'Owned services terminate', 15000);
      console.log('Owned service exit confirmed.');
    } finally { client.close(); }
  } catch (error) { console.error('Owned trial cleanup not confirmed:', error.message); process.exitCode = 1; }
  await new Promise(resolve => server.close(resolve));
});
