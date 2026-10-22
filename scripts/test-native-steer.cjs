// Actual Codex and Electron with two canned loopback Responses streams.
// Private native configuration; no paid inference or normal-profile edits.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), { execFileSync } = require('node:child_process');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const { executable, processIdentity, processMayBeAlive } = require('../app/platform.cjs'), { connect } = require('../app/service-client.cjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-native-steer-'));
const profile = path.join(base, 'profile'), cwd = path.join(base, 'work'), home = path.join(base, 'codex');
for (const dir of [profile, cwd, home]) fs.mkdirSync(dir, { mode: 0o700 });
const binary = executable('codex'); if (!binary) throw Error('Real Codex required');
const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
assert.equal(version, 'codex-cli 0.163.0');
let application, page, calls = 0, release, sequence = 0;
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
    const text = number === 1 ? 'NATIVE_STEER_PARTIAL: original work in progress.' : 'NATIVE_STEER_FINAL: current instruction received.';
    const item = { id: `msg_local_${number}`, type: 'message', role: 'assistant', status: 'in_progress', content: [], phase: number === 1 ? 'commentary' : 'final_answer' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    event(res, 'response.created', { response });
    event(res, 'response.output_item.added', { output_index: 0, item });
    event(res, 'response.content_part.added', { output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    event(res, 'response.output_text.delta', { output_index: 0, item_id: item.id, content_index: 0, delta: text });
    if (number === 1) await new Promise(resolve => { release = resolve; });
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
  application = await _electron.launch({ executablePath: require('electron'), args: [root], ...(process.env.NAW_VIDEO_DIR ? { recordVideo: { dir: process.env.NAW_VIDEO_DIR, size: { width: 1280, height: 900 } } } : {}), env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  await until(async () => { for (const candidate of application.windows()) if (!candidate.isClosed() && await candidate.locator('#new-session').count().catch(() => 0)) { page = candidate; return true; } return false; }, 'Main workspace');
  page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check();
  await page.locator('#initial-view').selectOption('chat'); await page.locator('#session-name').fill('Native steering'); await page.locator('#confirm-create').click();
  await until(async () => (await snapshot()).sessions[0]?.state === 'idle', 'Native Codex ready');
  const before = (await snapshot()).sessions[0]; assert.equal(before.model, 'gpt-6-luna');
  await page.locator('#message-input').fill('Start the local protocol check.'); await page.locator('#send-button').click();
  await page.locator('#messages').getByText('NATIVE_STEER_PARTIAL: original work in progress.', { exact: true }).waitFor();
  const working = (await snapshot()).sessions[0]; assert.ok(working.activeTurnId); assert.equal(working.state, 'working');
  assert.equal(await page.locator('#send-button').textContent(), '追加指令 ↑');
  await page.locator('#message-input').fill('Use the current instruction.'); await page.keyboard.press('Enter');
  await until(async () => (await snapshot()).sessions[0].messages.some(m => m.text === 'Use the current instruction.' && m.status === 'submitted'), 'Native steer acknowledgement');
  const accepted = (await snapshot()).sessions[0]; assert.equal(accepted.activeTurnId, working.activeTurnId); assert.equal(accepted.nativeId, before.nativeId);
  assert.equal(accepted.messages.filter(m => m.text === 'Use the current instruction.').length, 1);
  assert.equal(accepted.messages.find(m => m.text.startsWith('NATIVE_STEER_PARTIAL')).status, 'streaming');
  release();
  await until(async () => (await snapshot()).sessions[0].state === 'idle', 'Native turn completes');
  await page.locator('#messages').getByText('NATIVE_STEER_FINAL: current instruction received.', { exact: true }).waitFor();
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
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'native-steering.png') }); }
  console.log(JSON.stringify({ version, checks: ['GUI working input uses the existing native turn', 'ACK does not terminate streamed output', 'One visible input and one final native boundary', 'GUI and native TUI retain identity and both inputs/results'], localResponses: calls, paidModelCalls: 0, requests, evidence: base }));
})().catch(async error => {
  if (page && !page.isClosed()) { fs.writeFileSync(path.join(base, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {}); }
  console.error(error.stack, '\nEvidence:', base); process.exitCode = 1;
}).finally(async () => {
  release?.(); server.closeAllConnections();
  if (application) await application.close().catch(() => {});
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
  await new Promise(resolve => server.close(resolve));
});
