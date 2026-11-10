// Real Claude root MCP calls and actual peer receipt, using bounded loopback
// responses only. Every process, profile and GUI socket belongs to this test.
const scratch = require('./fixtures/test-scratch.cjs');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { _electron } = scratch.playwright(require('playwright'));
const { connectService } = require('../app/service-client.cjs');
const root = path.resolve(__dirname, '..'), evidence = process.env.NAW_EVIDENCE_DIR;
assert.ok(evidence && path.isAbsolute(evidence) && !path.resolve(evidence).startsWith(root + path.sep), 'Private external evidence directory required');
const binary = fs.realpathSync(process.env.NAW_CLAUDE_BIN || '');
const nativeVersion = scratch.childProcess.execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
assert.match(nativeVersion, /^2\.1\.(321|322)(?: \(Claude Code\))?$/);
const denied = process.env.NAW_TEST_EXPECT_DENIED === '1';
const common = scratch.childProcess.execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
async function acquireSlot() {
  const reserve = () => { try { fs.mkdirSync(slot); return true; } catch (error) { if (error.code !== 'EEXIST') throw error; return false; } };
  if (reserve()) return;
  if (process.env.NAW_TEST_WAIT_GUI_SLOT !== '1') { console.error('Canonical GUI slot occupied; nothing launched'); process.exit(75); }
  // Wait on the real release event before allocating anything. mkdir remains
  // atomic; no timeout, PID observation or busy label can retire another lease.
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { watcher.close(); reject(Object.assign(Error('GUI slot still occupied; nothing launched'), { code: 'GUI_SLOT_BUSY' })); }, 180000);
    const watcher = fs.watch(path.dirname(slot), () => {
      try { if (reserve()) { clearTimeout(timeout); watcher.close(); resolve(); } }
      catch (error) { clearTimeout(timeout); watcher.close(); reject(error); }
    });
    if (reserve()) { clearTimeout(timeout); watcher.close(); resolve(); }
  });
}
(async () => {
await acquireSlot();
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex2', task: 'Claude root workspace qualification', token, pid: process.pid }));
process.once('exit', () => {
  try { assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); }
  catch (error) { console.error('GUI slot retained:', error.message); process.exitCode = 1; }
});
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const base = fs.realpathSync(scratch.directory(path.join(os.tmpdir(), 'naw-claude-workspace-')));
const profile = path.join(base, 'profile'), cwd = path.join(base, 'work'), config = path.join(base, 'config');
for (const directory of [profile, cwd, config]) fs.mkdirSync(directory, { mode: 0o700 });
const message = 'ROOT_COMPAT_MESSAGE\n  Exact native recipient and original body. 中文';
const requests = [], toolResults = [], errors = [];
let application, page, client, recipient, sender, senderRequests = 0, recipientRequests = 0, unexpected;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (unexpected) throw unexpected; if (await fn()) return; await sleep(100); }
  throw Error(label);
}
function event(response, type, value) { response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`); }
function answer(response, request, blocks) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  event(response, 'message_start', { message: { id: 'msg_fixture_' + requests.length, type: 'message', role: 'assistant', model: request.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  blocks.forEach((content, index) => {
    event(response, 'content_block_start', { index, content_block: content.type === 'text' ? { type: 'text', text: '' } : { ...content, input: {} } });
    event(response, 'content_block_delta', { index, delta: content.type === 'text' ? { type: 'text_delta', text: content.text } : { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } });
    event(response, 'content_block_stop', { index });
  });
  event(response, 'message_delta', { delta: { stop_reason: blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
  event(response, 'message_stop', {}); response.end();
}
const server = http.createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  if (!request.url.startsWith('/v1/messages') || request.url.includes('count_tokens')) { response.writeHead(200); response.end('{}'); return; }
  try {
    const data = JSON.parse(body); requests.push(data);
    fs.writeFileSync(path.join(evidence, `request-${requests.length}.json`), body, { mode: 0o600 });
    assert.ok(requests.length <= 4, 'At most four canned responses; never retry an uncertain native call');
    const text = JSON.stringify(data.messages);
    if (text.includes('ROOT_PROBE_BEGIN')) {
      senderRequests++;
      if (senderRequests === 1) {
        const names = data.tools.map(t => t.name);
        for (const name of ['mcp__native_workspace__workspace_control', 'mcp__native_workspace__workspace_message']) assert.ok(names.includes(name), 'Actual native tool catalog includes ' + name);
        answer(response, data, [
          { type: 'tool_use', id: 'toolu_root_control', name: 'mcp__native_workspace__workspace_control', input: { action: 'catalog' } },
          { type: 'tool_use', id: 'toolu_root_message', name: 'mcp__native_workspace__workspace_message', input: { recipient_id: recipient, message } },
        ]);
      } else {
        assert.equal(senderRequests, 2, 'One native root task and its tool results only');
        for (const row of data.messages) for (const block of Array.isArray(row.content) ? row.content : []) if (block.type === 'tool_result') toolResults.push(block);
        answer(response, data, [{ type: 'text', text: 'ROOT_PROBE_DONE: native tool results observed.' }]);
      }
    } else if (text.includes('ROOT_COMPAT_MESSAGE')) {
      recipientRequests++; assert.equal(recipientRequests, 1, 'Peer task delivered once');
      answer(response, data, [{ type: 'text', text: 'ROOT_RECIPIENT_ACK: exact forwarded message received.' }]);
    } else throw Error('Unexpected local native task: no automatic retry');
  } catch (error) { unexpected = error; response.writeHead(500); response.end(); }
});
const snapshot = () => client.call('initial');
async function captureTypes() {
  const found = [];
  function visit(directory, depth = 0) {
    if (depth > 10) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || ['node_modules', 'dsh', 'Cache', 'Code Cache', 'GPUCache'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file, depth + 1);
      else if (entry.name === 'index.d.ts' && file.includes('.claude-plugin/types/claude-code/')) found.push(file);
    }
  }
  visit(profile); visit(cwd); const sibling = cwd + '-sessions'; if (fs.existsSync(sibling)) visit(sibling);
  for (const [index, file] of found.entries()) fs.copyFileSync(file, path.join(evidence, `engine-${index}.d.ts`));
  return found.length;
}
async function cleanup() {
  if (application) await application.close().catch(() => {});
  if (client) { try { for (const session of (await snapshot()).sessions) await client.call('stop', session.id); await client.call('shutdown'); } finally { client.close(); } }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
await (async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const shim = path.join(base, 'claude-local');
  fs.writeFileSync(shim, '#!/usr/bin/python3\nimport os,sys\nos.environ.pop("ANTHROPIC_AUTH_TOKEN",None)\nos.environ.pop("CLAUDE_CODE_OAUTH_TOKEN",None)\nos.environ.update(' +
    `ANTHROPIC_BASE_URL=${JSON.stringify(`http://127.0.0.1:${server.address().port}`)},ANTHROPIC_API_KEY="local-fixture",CLAUDE_CONFIG_DIR=${JSON.stringify(config)},CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1",DISABLE_AUTOUPDATER="1")\n` +
    `os.execv(${JSON.stringify(binary)},["claude"]+sys.argv[1:]+["--model","haiku","--allowedTools","mcp__native_workspace__workspace_control,mcp__native_workspace__workspace_message"])\n`, { mode: 0o700 });
  const real = fs.realpathSync(cwd);
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', customApiKeyResponses: { approved: ['local-fixture'], rejected: [] },
    projects: { [real]: { hasTrustDialogAccepted: true }, [real + '-sessions']: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify({ claude: shim }), { mode: 0o600 });
  application = await _electron.launch({ executablePath: require('electron'), args: [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await application.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await page.locator('#new-session').waitFor();
  // The ordinary app IPC creates both actual native sessions with the normal permission posture.
  recipient = await page.evaluate(cwd => workspace.create({ provider: 'claude', cwd, name: 'Native recipient', view: 'chat' }), cwd);
  sender = await page.evaluate(cwd => workspace.create({ provider: 'claude', cwd, name: 'Native sender', view: 'chat' }), cwd);
  client = await connectService(profile, 'native-root-observer');
  await until(async () => { const rows = (await snapshot()).sessions; return rows.length === 2 && rows.every(s => s.chatAvailable && s.nativeId && s.state === 'idle'); }, 'Both real native sessions ready', 90000);
  if (!denied) {
    // The existing zero-inference helper runs on a cold root. After a task,
    // native asks to confirm discarding the model's cache; preserve that dialog.
    await page.locator(`.session-link[data-session-id="${sender}"]`).click();
    await page.evaluate(id => workspace.claim(id), sender);
    await require('./native-model-check.cjs')({ page, snapshot: async () => ({ sessions: (await snapshot()).sessions.filter(s => s.id === sender) }), base, aliases: ['sonnet', 'haiku'] });
    assert.equal(requests.length, 0, 'Native model metadata switching adds no inference request');
  }
  await client.call('wakePolicy', null, true); await client.call('wakePolicy', recipient, true);
  for (const id of [sender, recipient]) await client.call('join', id, true);
  const before = (await snapshot()).sessions;
  await client.call('claim', sender);
  await client.call('send', sender, 'ROOT_PROBE_BEGIN: exercise the actual root tools once.', before.find(s => s.id === sender).nativeId);
  await until(() => toolResults.some(t => t.tool_use_id === 'toolu_root_message') && toolResults.some(t => t.tool_use_id === 'toolu_root_control'), 'Actual native tool results reach the native next request');
  await until(async () => (await snapshot()).sessions.find(s => s.id === sender).state === 'idle', 'Native sender completes');
  const resultText = id => JSON.stringify(toolResults.find(t => t.tool_use_id === id).content);
  if (denied) {
    assert.match(resultText('toolu_root_message'), /没有本原生主会话的定向协作授权/);
    assert.match(resultText('toolu_root_control'), /Background control requires the actual native root call/);
    assert.equal(recipientRequests, 0);
  } else {
    const value = id => {
      const content = toolResults.find(t => t.tool_use_id === id).content;
      return JSON.parse(typeof content === 'string' ? content : content.filter(c => c.type === 'text').map(c => c.text).join('\n'));
    };
    assert.equal(value('toolu_root_message').status, 'staged');
    assert.equal(value('toolu_root_control').state, 'complete');
    assert.ok(value('toolu_root_control').commands.length > 0, 'Actual app command catalog returned through the native root');
    await until(async () => (await snapshot()).sessions.find(s => s.id === recipient).messages.some(m => m.text?.includes('ROOT_RECIPIENT_ACK')), 'Actual recipient completes the staged native message');
    assert.equal(recipientRequests, 1);
    const peer = (await snapshot()).sessions.find(s => s.id === recipient);
    assert.ok(peer.messages.some(m => m.role === 'user' && m.text.includes(message)), 'Recipient keeps the exact original body');
  }
  const after = (await snapshot()).sessions;
  for (const session of before) {
    const current = after.find(s => s.id === session.id);
    assert.equal(current.nativeId, session.nativeId); assert.equal(current.pid, session.pid);
  }
  const declarations = await captureTypes();
  assert.deepEqual(errors, []);
  const result = { nativeVersion, expectedDenied: denied, sender, recipient, senderRequests, recipientRequests, localResponses: requests.length, paidModelCalls: 0, declarations, toolResults, errors };
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  await page.screenshot({ path: path.join(evidence, 'result.png') });
  console.log(JSON.stringify({ ...result, toolResults: toolResults.map(t => ({ tool_use_id: t.tool_use_id, is_error: t.is_error })) }));
})().catch(async error => {
  const failure = { nativeVersion, senderRequests, recipientRequests, toolResults, unexpected: unexpected?.message, errors };
  fs.writeFileSync(path.join(evidence, 'failure.json'), JSON.stringify(failure, null, 2));
  console.error(error.stack); console.error(JSON.stringify({ ...failure, toolResults: toolResults.map(t => ({ tool_use_id: t.tool_use_id, is_error: t.is_error })) }));
  process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
}).finally(scratch.cleanup(cleanup));
})().catch(error => { console.error(error.stack); process.exitCode = error.code === 'GUI_SLOT_BUSY' ? 75 : 1; });
