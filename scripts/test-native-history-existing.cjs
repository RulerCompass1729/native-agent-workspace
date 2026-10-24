// Import a stopped, actual context-runner history into a completely fresh app.
// Explicit owned fixture required; no normal profile. Optional cold continuation
// serves only the explicitly sent draft with one fixed reply and at most one native title.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict'), { _electron } = require('playwright');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { processIdentity, processMayBeAlive } = require(path.join(code, 'app/platform.cjs'));
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const source = fs.realpathSync(process.env.NAW_NATIVE_HISTORY_EVIDENCE || 'MISSING_OWNED_FIXTURE');
assert.equal(path.dirname(source), fs.realpathSync(os.tmpdir())); assert.match(path.basename(source), /^naw-native-context-/);
assert.equal(fs.statSync(source).uid, process.getuid());
const original = JSON.parse(fs.readFileSync(path.join(source, 'resumed.json'))).sessions[0];
assert.match(original.nativeId, /^[a-f0-9-]{36}$/); assert.equal(original.provider, 'codex');
assert.ok(original.messages.some(m => m.text === 'CONTEXT_TASK_1'));
for (const identity of [original.processIdentity, original.serverIdentity]) assert.ok(identity && !processMayBeAlive(identity), 'Old owned native writer has exited');
const config = fs.readFileSync(path.join(source, 'codex/config.toml'), 'utf8');
const url = new URL(config.match(/^base_url\s*=\s*"([^"]+)"/m)?.[1]);
assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1'); assert.ok(Number(url.port) > 0);
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-native-import-')), profile = path.join(base, 'profile');
const profiles = [];
function setupProfile(folder) {
  fs.mkdirSync(folder, { mode: 0o700 }); profiles.push(folder);
  fs.writeFileSync(path.join(folder, 'runtime-locations.json'), JSON.stringify({ codex: path.join(source, 'codex-local') }), { mode: 0o600 });
}
setupProfile(profile);
const requests = [], errors = [], sleep = ms => new Promise(r => setTimeout(r, ms));
const continueCold = process.env.NAW_NATIVE_COLD_CONTINUE === '1';
assert.ok(!continueCold || process.env.NAW_NATIVE_COLD_RECOVERY === '1');
let allowContinuation = false, taskResponses = 0, titleResponses = 0, sequence = 0;
const draft = 'Unsent follow-up to the original native session. ' + path.basename(base), reply = '原会话继续成功（' + path.basename(base).slice(-6) + '）。';
function event(res, type, body) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: ++sequence, ...body })}\n\n`); }
const trap = http.createServer((req, res) => {
  let body = ''; req.on('data', b => body += b); req.on('end', () => {
    requests.push(req.url);
    try {
      assert.ok(continueCold && allowContinuation && req.url.endsWith('/responses'), 'No inference before explicit continuation');
      const input = JSON.parse(body), title = input.input?.some(m => m.role === 'user' && m.content?.some(p => p.text?.startsWith('Generate a concise, single-line task title')));
      assert.equal(input.model, 'gpt-6-luna');
      if (title) assert.ok(++titleResponses <= 1, 'At most one native title');
      else {
        assert.equal(++taskResponses, 1, 'Only the explicit continuation may generate');
        const lastUser = input.input.filter(m => m.role === 'user').at(-1);
        assert.equal(lastUser.content.filter(p => typeof p.text === 'string').map(p => p.text).join('\n'), draft, 'The original preserved draft is the new native input');
      }
      fs.writeFileSync(path.join(base, title ? 'native-title-request.json' : 'explicit-continuation-request.json'), body);
      const text = title ? JSON.stringify({ title: 'Continue original session' }) : reply;
      const response = { id: 'cold_response_' + randomUUID(), object: 'response', status: 'in_progress', model: input.model, output: [], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
      const item = { id: 'cold_message_' + randomUUID(), type: 'message', role: 'assistant', phase: 'final_answer', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
      res.writeHead(200, { 'content-type': 'text/event-stream' }); event(res, 'response.created', { response });
      event(res, 'response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
      event(res, 'response.content_part.added', { output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      event(res, 'response.output_text.delta', { output_index: 0, item_id: item.id, content_index: 0, delta: text });
      event(res, 'response.output_text.done', { output_index: 0, item_id: item.id, content_index: 0, text });
      event(res, 'response.output_item.done', { output_index: 0, item });
      event(res, 'response.completed', { response: { ...response, status: 'completed', output: [item] } }); res.end();
    } catch (e) { errors.push(e.message); res.writeHead(503); res.end('Unexpected inference is refused'); }
  });
});
let app, page; const cleaned = new Set();
async function until(fn, label) { for (let n = 0; n < 300; n++) { if (await fn()) return; await sleep(60); } throw Error(label); }
const snapshot = () => page.evaluate(() => workspace.initial());
async function cleanupProfile(target, protectedIdentity) {
  if (cleaned.has(target) || !fs.existsSync(path.join(target, 'connection.json'))) return;
  const client = await connect(target, 'owned-import-cleanup');
  try {
    for (const s of (await client.call('initial')).sessions) if (!['recoverable', 'ended'].includes(s.state)) await client.call('stop', s.id);
    const owned = client.entries.map(e => processIdentity(e.state.servicePid));
    for (const identity of owned) if (identity && processMayBeAlive(identity)) process.kill(identity.pid, 'SIGTERM');
    await until(() => owned.every(i => !processMayBeAlive(i)), 'Owned fresh service exits');
    if (protectedIdentity) assert.ok(processMayBeAlive(protectedIdentity), 'Cleaning the rejected profile must preserve the first native writer');
    cleaned.add(target);
  } finally { client.close(); }
}
async function launch(target = profile) {
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    env: { ...process.env, NAW_DATA_DIR: target, NAW_WORKSPACE: path.join(source, 'work'), NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  await until(async () => { for (const p of app.windows()) if (!p.isClosed() && await p.locator('#new-session').count().catch(() => 0)) { page = p; return true; } }, 'Actual application ready');
  page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
}
async function selectOriginal(accepted = true) {
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check(); await page.locator('#open-native-history').click();
  const choice = page.locator(`input[name="native-history-choice"][value="${original.nativeId}"]`);
  await choice.waitFor(); await page.locator('#search-native-history').waitFor();
  await until(() => page.locator('#search-native-history').isEnabled(), 'Native catalog ready');
  assert.equal(await choice.count(), 1); await choice.check(); await page.locator('#confirm-native-history').click();
  if (accepted) await until(() => page.locator('#native-history-dialog').evaluate(e => !e.open), 'Native history selection completed');
  return choice;
}
(async () => {
  console.log('Evidence:', base, 'Owned source:', source);
  await new Promise((resolve, reject) => { trap.once('error', reject); trap.listen(Number(url.port), '127.0.0.1', resolve); });
  await launch(); assert.equal((await snapshot()).sessions.length, 0);
  await selectOriginal();
  await until(async () => { const s = (await snapshot()).sessions[0]; return s?.chatAvailable && s.messages.some(m => m.text === 'CONTEXT_TASK_1'); }, 'Actual original native history loaded');
  let state = await snapshot(), session = state.sessions[0];
  assert.equal(state.sessions.length, 1); assert.equal(session.nativeId, original.nativeId); assert.equal(session.model, original.model);
  assert.equal(session.externalHistory, true); assert.equal(session.roomId, null); assert.equal(session.nativeVersion, '0.164.0');
  const expected = original.messages.filter(m => m.nativeId === original.nativeId && ['user', 'assistant'].includes(m.role) && m.text?.trim());
  assert.ok(expected.length >= 2);
  for (const message of expected) assert.ok(session.messages.some(m => m.role === message.role && m.text === message.text), 'Original received text is recovered, not a new summary');
  const nativeTimes = original.messages.filter(m => m.nativeId === original.nativeId && m.kind === 'turn' && Number.isFinite(m.nativeCompletedAt));
  assert.ok(nativeTimes.length > 0, 'The owned native history has completion metadata');
  await until(async () => {
    const rows = (await snapshot()).sessions[0].messages;
    return nativeTimes.every(t => rows.some(m => m.kind === 'turn' && m.turnId === t.turnId && ['nativeStartedAt', 'nativeCompletedAt', 'nativeDurationMs'].every(k => m[k] === t[k])));
  }, 'Original native completion time and duration are recovered exactly');
  await page.locator('#terminal-tab').click();
  await require('./native-trust.cjs').acceptOwnedFolder(page, path.join(source, 'work'), process.env.NAW_NATIVE_EXPECT_IMPORT_TRUST === '1');
  await until(async () => (await page.locator('#terminal-area').innerText()).includes('CONTEXT_TASK_1'), 'The actual native terminal has passed its folder gate and displays the same original history');
  fs.writeFileSync(path.join(base, 'native-terminal.txt'), await page.locator('#terminal-area').innerText());
  state = await snapshot(); assert.equal(state.sessions[0].nativeId, original.nativeId);
  assert.deepEqual(state.sessions[0].serverIdentity, session.serverIdentity, 'First display attachment never replaces the native server');
  fs.writeFileSync(path.join(base, 'imported.json'), JSON.stringify(state, null, 2));
  await page.locator('#chat-tab').click();
  await page.locator('#message-input').fill(draft);
  await page.getByRole('button', { name: '加入协作', exact: true }).click();
  await until(async () => (await snapshot()).sessions[0].roomId === 'shared', 'Original session joins');
  assert.ok(!(await snapshot()).room.messages.some(m => m.text?.includes('CONTEXT_TASK_1')));
  await page.getByRole('button', { name: '脱出协作', exact: true }).click();
  await until(async () => !(await snapshot()).sessions[0].roomId, 'Original session detaches');
  assert.equal(await page.locator('#message-input').inputValue(), draft);
  await selectOriginal(); assert.equal((await snapshot()).sessions.length, 1, 'Reimport selects the existing reference');
  await sleep(400); const before = await snapshot(); fs.writeFileSync(path.join(base, 'before-reopen.json'), JSON.stringify(before, null, 2));
  await app.close(); app = null; await launch();
  await until(async () => (await snapshot()).sessions[0]?.chatAvailable, 'Imported original session reconnected');
  state = await snapshot(); session = state.sessions[0];
  for (const key of ['id', 'nativeId', 'pid', 'processIdentity', 'serverIdentity', 'model']) assert.deepEqual(session[key], before.sessions[0][key]);
  assert.equal(await page.locator('#message-input').inputValue(), draft);
  assert.deepEqual(session.messages.map(m => [m.id, m.role, m.text, m.nativeId]), before.sessions[0].messages.map(m => [m.id, m.role, m.text, m.nativeId]));
  assert.equal(state.diagnostics.dispatches, 0); assert.deepEqual(requests, []); assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(base, 'reopened.json'), JSON.stringify(state, null, 2));
  await app.close(); app = null;
  const conflict = path.join(base, 'conflict'); setupProfile(conflict); await launch(conflict);
  assert.equal((await snapshot()).sessions.length, 0);
  const conflictingChoice = await selectOriginal(false);
  await until(async () => (await page.locator('#native-history-status').innerText()).includes('其他原生连接'), 'Second writer is refused explicitly');
  assert.equal((await snapshot()).sessions.length, 0); assert.equal(await conflictingChoice.isChecked(), true);
  assert.equal(await page.locator('#confirm-native-history').isEnabled(), true);
  fs.writeFileSync(path.join(base, 'writer-refused.json'), JSON.stringify(await snapshot(), null, 2));
  fs.writeFileSync(path.join(base, 'writer-refused.txt'), await page.locator('#native-history-dialog').innerText());
  await app.close(); app = null; await cleanupProfile(conflict, session.serverIdentity);
  const persisted = path.join(conflict, 'workspace.json');
  assert.equal(fs.existsSync(persisted) ? JSON.parse(fs.readFileSync(persisted)).sessions.length : 0, 0, 'Rejected writer leaves no persisted local reference');
  await launch();
  await until(async () => (await snapshot()).sessions[0]?.chatAvailable, 'Original writer remains usable');
  const afterConflict = await snapshot();
  for (const key of ['id', 'nativeId', 'pid', 'processIdentity', 'serverIdentity', 'model']) assert.deepEqual(afterConflict.sessions[0][key], session[key]);
  assert.deepEqual(afterConflict.sessions[0].messages.map(m => [m.id, m.role, m.text, m.nativeId]), session.messages.map(m => [m.id, m.role, m.text, m.nativeId]));
  assert.equal(await page.locator('#message-input').inputValue(), draft);
  assert.equal(afterConflict.diagnostics.dispatches, 0); assert.deepEqual(requests, []); assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(base, 'after-writer-refusal.json'), JSON.stringify(afterConflict, null, 2));
  const checks = ['A fresh product profile selects exact stopped native TUI history and recovers original text/model/identity', 'Native folder trust is handled in the actual TUI; its original received text and exact native completion time/duration match the reader', 'Join/detach keep old private history private; repeated import never duplicates the local reference', 'Whole application reopening keeps the imported native identity, current backend identity, full received text and draft without replay', 'A second fresh workspace refuses the active writer, keeps exact choice/error and creates no duplicate; the first writer remains unchanged'];
  if (process.env.NAW_NATIVE_COLD_RECOVERY === '1') {
    await app.close(); app = null; await cleanupProfile(profile);
    assert.ok(!processMayBeAlive(afterConflict.sessions[0].serverIdentity), 'The old native backend really exited');
    cleaned.delete(profile); await launch();
    await until(async () => (await snapshot()).sessions[0]?.state === 'recoverable', 'Cold opening retains an explicitly recoverable record');
    const cold = await snapshot(); fs.writeFileSync(path.join(base, 'cold-before-resume.json'), JSON.stringify(cold, null, 2));
    assert.equal(cold.sessions[0].id, session.id); assert.equal(cold.sessions[0].nativeId, original.nativeId);
    assert.equal(cold.sessions[0].pid, null); assert.equal(cold.sessions[0].nativeVersionStatus, 'unreported');
    assert.equal(await page.locator('#message-input').inputValue(), draft);
    assert.deepEqual(requests, []);
    // Preserve the actual recovery confirmation handler and explicit choice;
    // its OS-native rendering/click is a separate, unverified surface.
    await app.evaluate(({ dialog }) => {
      globalThis.recoveryConfirmations = [];
      dialog.showMessageBox = async (_window, options) => {
        if (options?.message !== '继续这个原生会话？' || options.buttons?.join('|') !== '取消|继续会话' || options.defaultId !== 0 || options.cancelId !== 0) throw Error('Unexpected confirmation in owned cold fixture');
        globalThis.recoveryConfirmations.push(options); return { response: 1 };
      };
    });
    await page.locator('#chat-tab').click(); await page.locator('#send-button').getByText('继续原生会话', { exact: true }).click();
    await until(async () => { const s = (await snapshot()).sessions[0]; return s.state === 'idle' && s.chatAvailable && s.nativeVersionStatus === 'verified'; }, 'Explicit GUI action resumes the same native history');
    const resumed = await snapshot(), recovered = resumed.sessions[0];
    assert.equal(recovered.id, session.id); assert.equal(recovered.nativeId, original.nativeId); assert.equal(recovered.model, session.model);
    assert.ok(recovered.serverIdentity && processMayBeAlive(recovered.serverIdentity));
    assert.notDeepEqual(recovered.serverIdentity, afterConflict.sessions[0].serverIdentity, 'Explicit cold recovery uses a new native backend, not a claimed surviving old process');
    for (const m of session.messages) assert.ok(recovered.messages.some(r => r.id === m.id && r.role === m.role && r.text === m.text && r.nativeId === m.nativeId), 'Cold recovery retains the original received records');
    for (const t of nativeTimes) assert.ok(recovered.messages.some(m => m.kind === 'turn' && m.turnId === t.turnId && ['nativeStartedAt', 'nativeCompletedAt', 'nativeDurationMs'].every(k => m[k] === t[k])));
    assert.equal(await page.locator('#message-input').inputValue(), draft);
    assert.equal(resumed.diagnostics.dispatches, 0); assert.deepEqual(requests, []); assert.deepEqual(errors, []);
    const confirmations = await app.evaluate(() => globalThis.recoveryConfirmations);
    assert.equal(confirmations.length, 1); fs.writeFileSync(path.join(base, 'recovery-confirmation.json'), JSON.stringify(confirmations, null, 2));
    fs.writeFileSync(path.join(base, 'cold-resumed.json'), JSON.stringify(resumed, null, 2));
    checks.push('After confirmed native service exit, cold GUI recovery with explicit fixture consent resumes the original ID on a new backend without replay; OS-dialog appearance is not certified');
    if (continueCold) {
      await page.locator('#terminal-tab').click();
      await require('./native-trust.cjs').acceptOwnedFolder(page, path.join(source, 'work'));
      await until(async () => (await page.locator('#terminal-area').innerText()).includes('CONTEXT_TASK_1'), 'The recovered same-session TUI is ready before new input');
      await page.locator('#chat-tab').click(); assert.equal(await page.locator('#message-input').inputValue(), draft);
      allowContinuation = true; await page.locator('#send-button').click();
      await until(async () => { const s = (await snapshot()).sessions[0]; return s.state === 'idle' && s.messages.some(m => m.text === reply) && (await page.locator('#terminal-area').innerText()).includes(reply); }, 'Explicit new reply reaches both original reader and TUI');
      const continued = await snapshot(), current = continued.sessions[0];
      assert.equal(current.nativeId, original.nativeId); assert.deepEqual(current.serverIdentity, recovered.serverIdentity);
      assert.equal(current.messages.filter(m => m.role === 'user' && m.text === draft).length, 1);
      const historyKeys = ['id', 'role', 'text', 'nativeId', 'kind', 'turnId', 'nativeStartedAt', 'nativeCompletedAt', 'nativeDurationMs'];
      for (const old of recovered.messages) {
        const matches = current.messages.filter(m => m.id === old.id);
        assert.equal(matches.length, 1, 'Every pre-send record retains its unique identity');
        for (const key of historyKeys) assert.deepEqual(matches[0][key], old[key], 'Pre-send record remains unchanged: ' + key);
      }
      fs.writeFileSync(path.join(base, 'history-preservation.json'), JSON.stringify({ baseline: recovered.messages.length, preserved: recovered.messages.length, keys: historyKeys, uniqueFixtureResponseIds: true }, null, 2));
      assert.equal(taskResponses, 1); assert.equal(continued.diagnostics.dispatches, 1); assert.equal(continued.room.messages.length, 0); assert.deepEqual(errors, []);
      fs.writeFileSync(path.join(base, 'cold-continued.json'), JSON.stringify(continued, null, 2));
      fs.writeFileSync(path.join(base, 'cold-continued-terminal.txt'), await page.locator('#terminal-area').innerText());
      checks.push('Only an explicit Send transmits the preserved draft once after cold recovery; one fixed reply reaches reader and same-session TUI without duplicating old history');
    }
  }
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'native-import.png') }); }
  console.log(JSON.stringify({ checks, originalTextBlocks: expected.length, recoveryInferenceRequests: requests.length - taskResponses - titleResponses, explicitContinuationResponses: taskResponses, nativeTitleResponses: titleResponses, portalDispatches: (await snapshot()).diagnostics.dispatches, paidModelCalls: 0, errors, evidence: base }));
})().catch(async e => {
  console.error(e.stack);
  if (page && !page.isClosed()) { fs.writeFileSync(path.join(base, 'failure.json'), JSON.stringify(await snapshot().catch(() => ({})), null, 2)); fs.writeFileSync(path.join(base, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  process.exitCode = 1;
}).finally(async () => {
  try {
    if (app) await app.close().catch(() => {});
    for (const target of profiles) await cleanupProfile(target);
  } finally { trap.closeAllConnections(); await new Promise(resolve => trap.close(resolve)); }
  assert.equal(requests.length, taskResponses + titleResponses, 'Cleanup must not initiate inference');
});
