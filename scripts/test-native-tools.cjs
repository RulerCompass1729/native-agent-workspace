const testScratch = require('./fixtures/test-scratch.cjs');
const { joinSpace } = require('./fixtures/space-membership.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
const { chooseRecipient: inlineRecipient, fillRoomMessage, roomBody } = require('./room-input.cjs');
// Actual Codex tool execution and Electron with two canned loopback Responses streams.
// Private native configuration; no paid inference or normal-profile edits.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { execFileSync } = testScratch.childProcess;
const { _electron } = testScratch.playwright(require('playwright'));
const loopback = require('./fixtures/loopback-model.cjs'), { trustOwnedFolder } = require('./native-trust.cjs');
const root = path.resolve(__dirname, '..');
const { executable, processIdentity, processMayBeAlive } = require('../app/platform.cjs'), { connect } = require('../app/service-client.cjs');
const base = testScratch.directory(path.join(os.tmpdir(), 'naw-native-tools-'));
const profile = path.join(base, 'profile'), cwd = path.join(base, 'work'), home = path.join(base, 'codex'), userHome = path.join(base, 'home');
for (const dir of [profile, cwd, home, userHome]) fs.mkdirSync(dir, { mode: 0o700 });
const binary = executable('codex'); if (!binary) throw Error('Real Codex required');
const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
// Tool rows come from the protocol the product verifies; follow its gate, not a fixed old version.
// NAW_CODEX_VERSION, when given, must name the installed version.
const nativeVersion = version.replace(/^codex-cli /, ''), { verifiedCodexProtocol } = require('../app/native-history.cjs');
assert.ok(verifiedCodexProtocol({ nativeVersion }), `Unqualified Codex: ${version}`);
if (process.env.NAW_CODEX_VERSION) assert.equal(nativeVersion, process.env.NAW_CODEX_VERSION);
// NAW starts the session in its own folder inside the owned base; the fixed tool call works there.
let folder = cwd;
// Two journeys, one per run. macOS lets no process inside a restricting sandbox start another, so inside the loopback
// fixture's sandbox Codex's own seatbelt cannot run (probed 2026-11-10, recorded in docs/review.md): with Codex's sandbox on,
// the file change asks for approval but the approved change is not applied; with it off, the tools run but nothing
// asks (both tried on 0.167.0). The approval journey keeps the file-change permission, which is what its sharing rule is about. So:
// - default: Codex's sandbox off in this private config. The fixed tools really run; their results reach the solo and
//   shared readers, the model, a reload and a service recovery.
// - NAW_TOOLS_APPROVAL=1: Codex's read-only sandbox. A real native file permission is asked; the GUI shows it, the
//   same-screen TUI approves it, and the shared diff freezes; what follows stays private, also after a reload and a
//   service recovery. The approved change is attempted but its write fails, so the applied file is not checked here.
// The fixture's sandbox keeps the CLI off the network and the keychain; it does not limit file writes. In the default
// journey the writes are bounded by the fixed responses: only the two tool calls below can happen (anything else
// trips the response budget), both stay in the session folder, and that folder is checked to be inside the owned base.
const approvalJourney = process.env.NAW_TOOLS_APPROVAL === '1';
let application, page, calls = 0, titleCalls = 0, sequence = 0, budgetError;
const errors = [], requests = [], sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, timeout = 30000) {
  const start = Date.now(); while (Date.now() - start < timeout) { if (budgetError) throw budgetError; if (await fn()) return; await sleep(75); } throw Error(label);
}
function event(res, type, body) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: ++sequence, ...body })}\n\n`); }
// The one B11 loopback fixture: 127.0.0.1, random port, sandboxed CLI, fixed responses below.
const fixture = loopback.create({ directory: base, provider: 'codex', respond: async (req, res, body) => {
  {
    if (!req.url.endsWith('/responses')) { requests.push({ path: req.url.split('?')[0] }); res.writeHead(404); res.end(); return; }
    const input = JSON.parse(body);
    const title = input.input?.some(m => m.role === 'user' && m.content?.some(p => p.text?.startsWith('Generate a concise, single-line task title')));
    const number = title ? 0 : ++calls; if (title) titleCalls++;
    if (calls > 2 || titleCalls > 1) { budgetError = Error('Native tools budget: two fixed task responses and at most one native title'); res.writeHead(400); res.end(budgetError.message); return; }
    assert.equal(input.model, 'gpt-6-luna'); requests.push({ model: input.model, inputItems: input.input?.length, title });
    fs.writeFileSync(path.join(base, title ? 'native-title-request.json' : `request-${number}.json`), JSON.stringify(input, null, 2));
    const response = { id: `resp_local_${number}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model: input.model, output: [], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    event(res, 'response.created', { response });
    if (!title && number === 1) {
      const patch = '*** Begin Patch\n*** Add File: sample.txt\n+NATIVE_TOOL_FILE: hello 世界\n*** End Patch';
      const code = `text(await tools.apply_patch(${JSON.stringify(patch)})); text(await tools.exec_command(${JSON.stringify({ cmd: 'cat sample.txt', workdir: folder, max_output_tokens: 100 })}));`;
      const tool = { id: 'tool_local_1', type: 'custom_tool_call', call_id: 'call_local_1', namespace: 'functions', name: 'exec', input: code, status: 'completed' };
      event(res, 'response.output_item.added', { output_index: 0, item: { ...tool, input: '', status: 'in_progress' } });
      event(res, 'response.custom_tool_call_input.delta', { output_index: 0, item_id: tool.id, delta: code });
      event(res, 'response.custom_tool_call_input.done', { output_index: 0, item_id: tool.id, input: code });
      event(res, 'response.output_item.done', { output_index: 0, item: tool });
      event(res, 'response.completed', { response: { ...response, status: 'completed', output: [tool] } }); res.end(); return;
    }
    const text = title ? JSON.stringify({ title: 'Create and read a small file' }) : 'NATIVE_TOOL_DONE: created and read sample.txt.';
    const item = { id: 'msg_local_2', type: 'message', role: 'assistant', status: 'in_progress', content: [], phase: 'final_answer' };
    event(res, 'response.output_item.added', { output_index: 0, item });
    event(res, 'response.content_part.added', { output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    event(res, 'response.output_text.delta', { output_index: 0, item_id: item.id, content_index: 0, delta: text });
    item.status = 'completed'; item.content = [{ type: 'output_text', text, annotations: [] }];
    event(res, 'response.output_text.done', { output_index: 0, item_id: item.id, content_index: 0, text });
    event(res, 'response.content_part.done', { output_index: 0, item_id: item.id, content_index: 0, part: item.content[0] });
    event(res, 'response.output_item.done', { output_index: 0, item });
    event(res, 'response.completed', { response: { ...response, status: 'completed', output: [item] } }); res.end();
  }
} });
const snapshot = () => page.evaluate(() => workspace.initial());
async function revealTools(selector) {
  for (const disclosure of await page.locator(selector + ' .process-details').all()) {
    if (await disclosure.getAttribute('open') === null) await disclosure.locator(':scope > summary').click();
  }
}
(async () => {
  await fixture.start(); await fixture.preflight();
  fs.writeFileSync(path.join(home, 'config.toml'), `model = "gpt-6-luna"\nmodel_provider = "local_fixture"\nmodel_reasoning_effort = "low"\ncli_auth_credentials_store = "file"\nsandbox_mode = "${approvalJourney ? 'read-only' : 'danger-full-access'}"\napproval_policy = "on-request"\n[features]\ndaemon_auto_start = false\n[model_providers.local_fixture]\nname = "Local protocol fixture"\nbase_url = "${fixture.endpoint}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`, { mode: 0o600 });
  // Trust only the owned empty fixture folder. In the approval journey the file permission is still asked and must
  // be answered in the real native UI; in the default journey Codex asks nothing.
  for (const trusted of new Set([cwd, fs.realpathSync(cwd)])) fs.appendFileSync(path.join(home, 'config.toml'), `\n[projects.${JSON.stringify(trusted)}]\ntrust_level = "trusted"\n`);
  const shim = path.join(base, 'codex-local');
  fixture.wrapper(binary, { file: shim, env: { CODEX_HOME: home, HOME: userHome } });
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify({ codex: shim }), { mode: 0o600 });
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], ...(process.env.NAW_VIDEO_DIR ? { recordVideo: { dir: process.env.NAW_VIDEO_DIR, size: { width: 1280, height: 900 } } } : {}), env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  await until(async () => { for (const candidate of application.windows()) if (!candidate.isClosed() && await candidate.locator('#new-session').count().catch(() => 0)) { page = candidate; return true; } return false; }, 'Main workspace');
  page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check();
  await page.locator('#session-name').fill('Native tools'); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions[0]?.state === 'idle', 'Native Codex ready');
  const before = (await snapshot()).sessions[0]; assert.equal(before.model, 'gpt-6-luna');
  assert.equal(before.nativeVersion, nativeVersion);
  folder = before.cwd; trustOwnedFolder({ home, base, folder });
  await joinSpace(page);
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await inlineRecipient(page, before.id);
  await fillRoomMessage(page, 'Create sample.txt with the provided line, then read it back.'); await page.locator('#forward-button').click();
  await until(async () => { const s = (await snapshot()).sessions[0]; return s.state === 'approval' || s.messages.some(m => m.text === 'NATIVE_TOOL_DONE: created and read sample.txt.'); }, 'Native tool starts', 45000);
  if (!approvalJourney) assert.notEqual((await snapshot()).sessions[0].state, 'approval', 'With Codex\'s own sandbox off, no native permission is asked');
  else {
    assert.equal((await snapshot()).sessions[0].state, 'approval', 'This journey requires a real native file permission, not an automatically allowed tool');
    await page.locator(`[data-session-id="${before.id}"]`).click();
    // The header shows the native state in the interface language.
    await page.locator('#native-phase').getByText('Native tools · 等待确认', { exact: true }).waitFor();
    await page.locator('#approval').getByText('Native tools · 需要你确认', { exact: true }).waitFor();
    assert.equal(await page.locator('#message-input').isEnabled(), true, 'A pending native confirmation preserves the draft editor');
    await page.locator('#terminal-tab').click();
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
    const patch = (await snapshot()).sessions[0].messages.find(m => m.toolKind === 'fileChange');
    assert.ok([folder, fs.realpathSync(folder)].some(dir => patch.text === `add ${path.join(dir, 'sample.txt')}\nNATIVE_TOOL_FILE: hello 世界\n`), 'The one-file change is in the session folder: ' + patch.text);
    // Only the isolated, exact one-file change above is approved once. This
    // does not change native permission defaults or grant future file access.
    await page.locator('#terminal-area .xterm-helper-textarea').press('Enter');
  }
  await until(async () => (await snapshot()).sessions[0].messages.some(m => m.text === 'NATIVE_TOOL_DONE: created and read sample.txt.'), 'Native tools and final response', 45000);
  await until(async () => (await snapshot()).sessions[0].state === 'idle', 'Native turn ends');
  const done = await snapshot(); fs.writeFileSync(path.join(base, 'completed.json'), JSON.stringify(done, null, 2));
  assert.ok(done.room.messages.every(m => !m.nativeMessageId || m.sessionId === before.id), 'Shared rows retain agent identity');
  const reply = 'NATIVE_TOOL_DONE: created and read sample.txt.';
  // Approval journey: exactly the diff the person was asked about is shared, frozen; nothing after it is.
  const assertPrivateAfterApproval = (state, when) => {
    const frozen = state.room.messages.filter(m => m.role === 'tool' && m.sharingStopped);
    assert.equal(frozen.length, 1, 'Shared diff explicitly freezes when approval is requested: ' + when);
    assert.equal(frozen[0].toolKind, 'fileChange'); assert.ok(frozen[0].text.includes('NATIVE_TOOL_FILE: hello 世界'));
    assert.ok(!state.room.messages.some(m => m.text === reply || m.finalReply), 'Permission revocation keeps later native replies private: ' + when);
    assert.ok(!JSON.stringify(state.room.messages).includes('Failed to write file'), 'The result after the approval stays private: ' + when);
  };
  if (approvalJourney) {
    assertPrivateAfterApproval(done, 'after the turn');
    assert.equal(done.sessions[0].approval, null, 'The same-screen TUI answer resolved the original request');
  } else {
    assert.equal(fs.readFileSync(path.join(folder, 'sample.txt'), 'utf8'), 'NATIVE_TOOL_FILE: hello 世界\n');
    const tools = done.sessions[0].messages.filter(m => m.role === 'tool');
    assert.ok(tools.some(m => m.text.includes('NATIVE_TOOL_FILE: hello 世界')), 'Native tool body reaches solo reading list');
    assert.ok(done.room.messages.some(m => m.role === 'tool' && m.text.includes('NATIVE_TOOL_FILE: hello 世界')), 'Explicitly routed tool result reaches shared reader');
    // No permission was asked, so sharing was never revoked: nothing is frozen and the reply is published once.
    assert.ok(!done.room.messages.some(m => m.sharingStopped), 'Nothing freezes without a permission request');
    assert.equal(done.room.messages.filter(m => m.finalReply).length, 1); assert.equal(done.room.messages.find(m => m.finalReply).text, reply);
  }
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await revealTools('#room-messages');
  const roomText = await page.locator('#room-messages').innerText(); fs.writeFileSync(path.join(base, 'shared-reader.txt'), roomText);
  assert.match(roomText, /NATIVE_TOOL_FILE: hello 世界/);
  if (approvalJourney) assert.ok(!roomText.includes(reply), 'The shared reader does not show the private reply');
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, approvalJourney ? 'shared-approval.png' : 'shared-tools.png') }); }
  await page.locator(`[data-session-id="${before.id}"]`).click();
  await revealTools('#messages');
  assert.match(await page.locator('#messages').innerText(), /NATIVE_TOOL_FILE: hello 世界/);
  await page.locator('#terminal-tab').click();
  await until(async () => (await page.locator('#terminal-area').innerText()).includes('NATIVE_TOOL_DONE'), 'Native TUI shows the same result', 60000);
  fs.writeFileSync(path.join(base, 'native-terminal.txt'), await page.locator('#terminal-area').innerText());
  await page.locator('#chat-tab').click();
  const roomBeforeReload = JSON.stringify((await snapshot()).room.messages);
  await page.reload(); await page.locator('#new-session').waitFor();
  await until(async () => (await snapshot()).sessions[0].nativeId === before.nativeId, 'Reader reload identity');
  assert.match(await page.locator('#messages').innerText(), /NATIVE_TOOL_FILE: hello 世界/);
  assert.equal(JSON.stringify((await snapshot()).room.messages), roomBeforeReload, 'A reload adds nothing to the shared record');
  if (approvalJourney) assertPrivateAfterApproval(await snapshot(), 'after a reload');
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
  if (approvalJourney) assertPrivateAfterApproval(recovered, 'after a service recovery');
  assert.ok(recovered.sessions[0].messages.some(m => m.role === 'tool' && m.text.includes('NATIVE_TOOL_FILE: hello 世界')));
  assert.equal(calls, 2); assert.equal(recovered.diagnostics.dispatches, 1);
  // What the tool call returned to the model: the output item itself, not the call's own input (which repeats the line).
  const request = JSON.parse(fs.readFileSync(path.join(base, 'request-2.json'), 'utf8'));
  const outputs = request.input.filter(item => item.type === 'custom_tool_call_output' && item.call_id === 'call_local_1');
  assert.equal(outputs.length, 1); const returned = JSON.stringify(outputs[0].output);
  const ran = returned.includes('Script completed') && returned.includes('NATIVE_TOOL_FILE: hello 世界');
  let approvedChange;
  if (!approvalJourney) assert.ok(ran, 'Real tool result returned to the native model input: ' + returned);
  else {
    // The answer was an approval, not a refusal: Codex went on to apply the change. Inside the fixture's sandbox the
    // write then fails; if a later Codex or macOS lets it succeed, the file must be right and the two journeys can merge.
    const failedWrite = returned.includes('Failed to write file') && returned.includes('sample.txt');
    assert.ok(failedWrite || ran, 'The approved change was attempted: ' + returned);
    if (ran) assert.equal(fs.readFileSync(path.join(folder, 'sample.txt'), 'utf8'), 'NATIVE_TOOL_FILE: hello 世界\n');
    approvedChange = ran ? 'applied' : 'attempted; the write failed inside the fixture sandbox';
  }
  assert.ok(titleCalls <= 1); assert.ok(!budgetError);
  fixture.assertClean();
  const shared = ['GUI and TUI retain same native identity', 'Reload neither loses tool text nor dispatches nor adds to the shared record', 'Separate native service resubscription hydrates tool history without sharing or another response'];
  console.log(JSON.stringify(approvalJourney
    ? { version, journey: 'approval', fixture: fixture.summary(), checks: ['GUI shows the actual native approval state; its same-screen TUI approves the original request', 'The file diff the person was asked about appears in the shared reader and freezes there; later output stays private, also after a reload and a service recovery', ...shared], approvedChange, localResponses: calls, nativeTitleResponses: titleCalls, paidModelCalls: 0, requests, evidence: base }
    : { version, journey: 'execution', fixture: fixture.summary(), checks: ['Native tool really creates and reads the isolated file', 'Tool results reach the solo and shared readers and the native model input; the reply is published once', ...shared], localResponses: calls, nativeTitleResponses: titleCalls, paidModelCalls: 0, requests, evidence: base }));
})().catch(async error => {
  if (page && !page.isClosed()) { fs.writeFileSync(path.join(base, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {}); }
  console.error(error.stack, '\nEvidence:', base); process.exitCode = 1;
}).finally(testScratch.cleanup(async () => {
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
  await fixture.stop();
}));
