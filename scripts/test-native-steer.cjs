const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
const { chooseRecipient: inlineRecipient, fillRoomMessage, roomBody } = require('./room-input.cjs');
// Actual Codex and Electron with two canned loopback Responses streams.
// Private native configuration; no paid inference or normal-profile edits.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), { execFileSync, fork } = testScratch.childProcess;
const { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..');
if (!process.env.NAW_APP_EXECUTABLE) execFileSync(process.execPath, [path.join(root, 'scripts/build-ui.cjs')]);
const { executable, processIdentity, processMayBeAlive } = require('../app/platform.cjs'), { connect, connectService } = require('../app/service-client.cjs');
const base = testScratch.directory(path.join(os.tmpdir(), 'naw-native-steer-'));
const profile = path.join(base, 'profile'), cwd = path.join(base, 'work'), home = path.join(base, 'codex');
for (const dir of [profile, cwd, home]) fs.mkdirSync(dir, { mode: 0o700 });
const binary = executable('codex'); if (!binary) throw Error('Real Codex required');
const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
assert.equal(version, 'codex-cli 0.163.0');
const shared = process.env.NAW_STEER_SHARED === '1';
const retained = process.env.NAW_STEER_RETAINED === '1';
const inputSelector = shared ? '#shared-input' : '#message-input', sendSelector = shared ? '#forward-button' : '#send-button';
let application, page, child, legacyClient, calls = 0, titleCalls = 0, release, releaseSecond, sequence = 0;
const errors = [], requests = [], sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, timeout = 30000) {
  const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await sleep(75); } throw Error(label);
}
function event(res, type, body) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: ++sequence, ...body })}\n\n`); }
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', b => body += b); req.on('end', async () => {
    if (!req.url.endsWith('/responses')) { requests.push({ path: req.url.split('?')[0] }); res.writeHead(404); res.end(); return; }
    const input = JSON.parse(body); assert.equal(input.model, 'gpt-6-luna');
    const nativeTitle = input.input?.some(m => m.role === 'user' && m.content?.some(p => typeof p.text === 'string' && p.text.startsWith('Generate a concise, single-line task title')));
    const number = nativeTitle ? 0 : ++calls; if (nativeTitle) titleCalls++;
    if (calls > 2 || titleCalls > 1) { res.writeHead(429); res.end(); return; }
    requests.push({ model: input.model, inputItems: input.input?.length, nativeTitle });
    fs.writeFileSync(path.join(base, nativeTitle ? 'native-title-request.json' : `request-${number}.json`), JSON.stringify(input, null, 2));
    const response = { id: `resp_local_${number}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model: input.model, output: [], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
    const text = nativeTitle ? JSON.stringify({ title: 'Inspect current instruction' }) : number === 1 ? 'NATIVE_STEER_PARTIAL: original work in progress.' : 'NATIVE_STEER_FINAL: current instruction received.';
    const item = { id: `msg_local_${number}`, type: 'message', role: 'assistant', status: 'in_progress', content: [], phase: number === 1 ? 'commentary' : 'final_answer' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    event(res, 'response.created', { response });
    event(res, 'response.output_item.added', { output_index: 0, item });
    event(res, 'response.content_part.added', { output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    event(res, 'response.output_text.delta', { output_index: 0, item_id: item.id, content_index: 0, delta: text });
    if (number === 1) await new Promise(resolve => { release = resolve; });
    else if (!nativeTitle) await new Promise(resolve => { releaseSecond = resolve; });
    item.status = 'completed'; item.content = [{ type: 'output_text', text, annotations: [] }];
    event(res, 'response.output_text.done', { output_index: 0, item_id: item.id, content_index: 0, text });
    event(res, 'response.content_part.done', { output_index: 0, item_id: item.id, content_index: 0, part: item.content[0] });
    event(res, 'response.output_item.done', { output_index: 0, item });
    event(res, 'response.completed', { response: { ...response, status: 'completed', output: [item] } }); res.end();
  });
});
const snapshot = () => page.evaluate(() => workspace.initial());
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(home, 'config.toml'), `model = "gpt-6-luna"\nmodel_provider = "local_fixture"\nmodel_reasoning_effort = "low"\n[model_providers.local_fixture]\nname = "Local protocol fixture"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`, { mode: 0o600 });
  const shim = path.join(base, 'codex-local');
  fs.writeFileSync(shim, '#!/usr/bin/python3\nimport os,sys\n' +
    `os.environ["CODEX_HOME"]=${JSON.stringify(home)}\n` +
    'for key in ["OPENAI_API_KEY","CODEX_API_KEY"]: os.environ.pop(key,None)\n' +
    `os.execv(${JSON.stringify(binary)},["codex"]+sys.argv[1:])\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify({ codex: shim }), { mode: 0o600 });
  let retainedId;
  if (retained) {
    const old = path.join(base, 'old'), bin = path.join(base, 'bin'); fs.mkdirSync(old); fs.mkdirSync(bin);
    execFileSync('/usr/bin/tar', ['-x', '-C', old], { input: execFileSync('git', ['archive', 'a87653b', 'app', 'package.json'], { cwd: root, maxBuffer: 16 * 1024 * 1024 }) });
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(old, 'node_modules')); fs.symlinkSync(shim, path.join(bin, 'codex'));
    child = fork(path.join(old, 'app/daemon.cjs'), [profile], { env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, NAW_APP_VERSION: '0.1.0-alpha.2', NAW_WORKSPACE: cwd }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Original backend boot');
    legacyClient = await connectService(profile, 'retained-steer-fixture');
    retainedId = await legacyClient.call('create', { provider: 'codex', cwd, name: 'Retained steering', view: 'terminal' });
  }
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], ...(process.env.NAW_VIDEO_DIR ? { recordVideo: { dir: process.env.NAW_VIDEO_DIR, size: { width: 1280, height: 900 } } } : {}), env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  await until(async () => { for (const candidate of application.windows()) if (!candidate.isClosed() && await candidate.locator('#new-session').count().catch(() => 0)) { page = candidate; return true; } return false; }, 'Main workspace');
  page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  if (retained) {
    await page.locator(`[data-session-id="${retainedId}"]`).click(); await page.locator('#terminal-tab').click();
    const takeover = page.getByRole('button', { name: '接管此窗口', exact: true }); if (await takeover.isVisible()) await takeover.click();
    await until(async () => (await page.locator('#terminal-area').innerText()).includes('Trust this folder?') || (await snapshot()).sessions[0]?.state === 'idle', 'Native trust gate', 60000);
    if ((await page.locator('#terminal-area').innerText()).includes('Trust this folder?')) {
      const prompt = await page.locator('#terminal-area').innerText(); assert.ok(prompt.includes(cwd) || prompt.includes(fs.realpathSync(cwd))); assert.match(prompt, /› 1\. Trust and continue/);
      await page.locator('#terminal-area .xterm-helper-textarea').press('Enter');
    }
    await until(async () => (await snapshot()).sessions[0]?.state === 'idle', 'Retained native ready');
    await page.locator('#chat-tab').click();
    if (await page.locator('#send-button').textContent() === '接管此窗口') await page.locator('#send-button').click();
    assert.equal(await page.locator('#send-button').textContent(), '接通原会话输入'); await page.locator('#send-button').click();
  } else {
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check();
  await page.locator('#session-name').fill('Native steering'); await createIn(page, 'chat');
  }
  await until(async () => (await snapshot()).sessions[0]?.state === 'idle', 'Native Codex ready');
  const before = (await snapshot()).sessions[0];
  if (!retained) assert.equal(before.model, 'gpt-6-luna');
  await page.locator('#message-input').fill('Start the local protocol check.'); await page.locator('#send-button').click();
  await page.locator('#messages').getByText('NATIVE_STEER_PARTIAL: original work in progress.', { exact: true }).waitFor();
  const working = (await snapshot()).sessions[0]; assert.ok(working.activeTurnId); assert.equal(working.state, 'working');
  assert.equal(await page.locator('#send-button').textContent(), '追加指令 ↑');
  if (shared) {
    await page.locator('#message-input').fill('Unsent private draft.');
    await page.locator('#header-actions').getByRole('button', { name: '加入协作', exact: true }).click();
    await page.locator('#room-nav').click(); await page.locator('#room-record').click();
    await inlineRecipient(page, before.id);
    assert.ok(!(await page.locator('#room-messages').innerText()).includes('NATIVE_STEER_PARTIAL'));
  }
  assert.equal(await page.locator(sendSelector).textContent(), '追加指令 ↑');
  await page.locator(inputSelector).fill('Use the current instruction.'); await page.keyboard.press('Enter');
  await until(async () => (await snapshot()).sessions[0].messages.some(m => m.text === 'Use the current instruction.' && m.status === 'submitted'), 'Native steer acknowledgement');
  const accepted = (await snapshot()).sessions[0]; assert.equal(accepted.activeTurnId, working.activeTurnId); assert.equal(accepted.nativeId, before.nativeId);
  assert.equal(accepted.messages.filter(m => m.text === 'Use the current instruction.').length, 1);
  assert.equal(accepted.messages.find(m => m.text.startsWith('NATIVE_STEER_PARTIAL')).status, 'streaming');
  await until(() => typeof releaseSecond === 'function', 'Native second response started');
  if (shared) {
    await page.locator('#room-messages').getByText('NATIVE_STEER_FINAL: current instruction received.', { exact: true }).waitFor();
    const inFlight = await snapshot();
    const row = inFlight.room.messages.find(m => m.role === 'assistant');
    assert.equal(row.status, 'streaming'); assert.ok(row.nativeMessageId);
    assert.equal(inFlight.room.messages.filter(m => m.role === 'human').length, 1);
    assert.ok(!JSON.stringify(inFlight.room.messages).includes('NATIVE_STEER_PARTIAL'));
    assert.ok(!JSON.stringify(inFlight.room.messages).includes('Unsent private draft'));
    fs.writeFileSync(path.join(base, 'shared-streaming.json'), JSON.stringify(inFlight, null, 2));
    await page.locator(inputSelector).fill('A newer shared draft.');
    await page.reload(); await page.locator('#new-session').waitFor();
    await until(async () => (await page.locator(inputSelector).inputValue()) === 'A newer shared draft.', 'Draft restored in room');
    assert.equal((await snapshot()).sessions[0].activeTurnId, working.activeTurnId);
    assert.equal(calls, 2);
  }
  release(); releaseSecond();
  await until(async () => (await snapshot()).sessions[0].state === 'idle', 'Native turn completes');
  await page.locator(shared ? '#room-messages' : '#messages').getByText('NATIVE_STEER_FINAL: current instruction received.', { exact: true }).waitFor();
  if (shared) {
    const done = await snapshot(), reply = done.room.messages.find(m => m.role === 'assistant');
    assert.equal(reply.status, 'complete'); assert.equal(reply.finalReply, true);
    assert.equal(done.room.messages.filter(m => m.role === 'assistant').length, 1);
    assert.equal(done.sessions[0].pendingTag, null);
    fs.writeFileSync(path.join(base, 'shared-completed.json'), JSON.stringify(done, null, 2));
    if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'shared-steering.png') }); }
    await page.locator(`[data-session-id="${before.id}"]`).click();
    assert.equal(await page.locator('#message-input').inputValue(), 'Unsent private draft.');
  }
  const after = (await snapshot()).sessions[0];
  fs.writeFileSync(path.join(base, 'accepted.json'), JSON.stringify(accepted, null, 2));
  fs.writeFileSync(path.join(base, 'completed.json'), JSON.stringify(after, null, 2));
  assert.equal(after.messages.filter(m => m.kind === 'turn').length, 1);
  assert.equal(calls, 2); assert.equal((await snapshot()).diagnostics.dispatches, 2);
  const secondInput = JSON.parse(fs.readFileSync(path.join(base, 'request-2.json'), 'utf8')).input;
  assert.ok(secondInput.some(item => item.role === 'user' && item.content?.some(part => part.type === 'input_text' && part.text === 'Use the current instruction.')), 'Steered instruction reaches the actual native provider request');
  await page.locator('#terminal-tab').click();
  await until(async () => (await page.locator('#terminal-area').innerText()).includes('NATIVE_STEER_FINAL'), 'Native TUI shows the same result', 60000);
  assert.match(await page.locator('#terminal-area').innerText(), /Use the current instruction/);
  fs.writeFileSync(path.join(base, 'native-terminal.txt'), await page.locator('#terminal-area').innerText());
  await page.locator('#chat-tab').click();
  assert.equal((await snapshot()).sessions[0].nativeId, before.nativeId); assert.equal(calls, 2); assert.deepEqual(errors, []);
  if (!shared) {
    await page.reload(); await page.locator('#new-session').waitFor();
    assert.equal(await page.locator('#message-input').inputValue(), '', 'Submitted solo draft must not return after reload');
    assert.equal((await snapshot()).sessions[0].liveDraft, ''); assert.equal(calls, 2);
  }
  if (retained) assert.equal((await snapshot()).sessions[0].pid, before.pid);
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'native-steering.png') }); }
  console.log(JSON.stringify({ version, shared, retained, checks: ['GUI working input uses the existing native turn', 'ACK does not terminate streamed output', 'One visible input and one final native boundary', 'GUI and native TUI retain identity and both inputs/results', ...(shared ? ['Shared reply excludes prior private blocks and draft', 'Room reload preserves streaming item and draft without dispatch'] : [])], taskResponses: calls, nativeTitleResponses: titleCalls, localResponses: calls + titleCalls, paidModelCalls: 0, requests, evidence: base }));
})().catch(async error => {
  if (page && !page.isClosed()) { fs.writeFileSync(path.join(base, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {}); }
  console.error(error.stack, '\nEvidence:', base); process.exitCode = 1;
}).finally(testScratch.cleanup(async () => {
  release?.(); releaseSecond?.(); server.closeAllConnections();
  if (application) await application.close().catch(() => {});
  legacyClient?.close();
  try {
    const client = await connect(profile, 'native-steer-cleanup');
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
  if (child?.connected) child.disconnect();
  await new Promise(resolve => server.close(resolve));
}));
