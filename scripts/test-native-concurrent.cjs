// Actual Electron, Claude and Codex. Four bounded loopback responses; no paid inference.
// Tests the existing room interaction, including real mouse drag and native streaming.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), { execFileSync, fork } = require('node:child_process');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const { executable, processIdentity, processMayBeAlive } = require('../app/platform.cjs');
const { connect, connectService } = require('../app/service-client.cjs');
const retained = process.env.NAW_CONCURRENT_RETAINED === '1';
if (!process.env.NAW_APP_EXECUTABLE) execFileSync(process.execPath, [path.join(root, 'scripts/build-ui.cjs')]);
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-native-concurrent-'));
const profile = path.join(base, 'profile'), cwd = path.join(base, 'work');
const claudeHome = path.join(base, 'claude'), codexHome = path.join(base, 'codex');
for (const dir of [profile, cwd, claudeHome, codexHome]) fs.mkdirSync(dir, { mode: 0o700 });
const binaries = Object.fromEntries(['claude', 'codex'].map(p => [p, executable(p)]));
if (retained) { assert.ok(process.env.NAW_CLAUDE_302); binaries.claude = process.env.NAW_CLAUDE_302; }
const versions = Object.fromEntries(Object.entries(binaries).map(([p, file]) => {
  assert.ok(file, `Real ${p} required`); return [p, execFileSync(file, ['--version'], { encoding: 'utf8' }).trim()];
}));
assert.match(versions.claude, retained ? /^2\.1\.302\b/ : /^2\.1\.308\b/); assert.equal(versions.codex, 'codex-cli 0.163.0');
const retainedIds = {};
let application, page, child, legacyClient, sequence = 0, titleCalls = 0;
const counts = { claude: 0, codex: 0 }, controls = {}, errors = [], checks = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 30000) {
  const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await sleep(75); } throw Error(label);
}
function event(res, type, data) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: ++sequence, ...data })}\n\n`); }
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', b => body += b); req.on('end', () => {
    const provider = req.url.endsWith('/responses') ? 'codex' : req.url.startsWith('/v1/messages') && !req.url.includes('count_tokens') ? 'claude' : null;
    if (!provider) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":100,"data":[]}'); return; }
    const input = JSON.parse(body);
    if (provider === 'codex') assert.equal(input.model, 'gpt-6-luna');
    const nativeTitle = provider === 'codex' && input.input?.some(m => m.role === 'user' && m.content?.some(p => typeof p.text === 'string' && p.text.startsWith('Generate a concise, single-line task title')));
    if (nativeTitle) {
      if (++titleCalls > 1) { res.writeHead(429); res.end(); return; }
      fs.writeFileSync(path.join(base, 'native-title-request.json'), body);
      const response = { id: 'resp_local_title', object: 'response', status: 'completed', model: input.model,
        output: [{ id: 'msg_local_title', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ title: 'Check a small task' }), annotations: [] }] }] };
      const item = response.output[0], text = item.content[0].text;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      event(res, 'response.created', { response: { ...response, status: 'in_progress', output: [] } });
      event(res, 'response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
      event(res, 'response.content_part.added', { output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      event(res, 'response.output_text.delta', { output_index: 0, item_id: item.id, content_index: 0, delta: text });
      event(res, 'response.output_text.done', { output_index: 0, item_id: item.id, content_index: 0, text });
      event(res, 'response.content_part.done', { output_index: 0, item_id: item.id, content_index: 0, part: item.content[0] });
      event(res, 'response.output_item.done', { output_index: 0, item });
      event(res, 'response.completed', { response }); res.end(); return;
    }
    const number = ++counts[provider];
    if (number > (2)) { res.writeHead(429); res.end(); return; }
    const key = `${provider}-${number}`;
    fs.writeFileSync(path.join(base, `${key}-request.json`), body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (provider === 'claude') {
      event(res, 'message_start', { message: { id: 'msg_claude_local', type: 'message', role: 'assistant', model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      event(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      const append = text => event(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
      append(number === 1 ? 'CLAUDE_SHARED_PREFIX: checking the small task.\n' : 'CLAUDE_QUEUED_PREFIX: following up.\n');
      controls[key] = { append, finish: () => {
        event(res, 'content_block_stop', { index: 0 });
        event(res, 'message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 30 } });
        event(res, 'message_stop', {}); res.end();
      } };
    } else {
      const response = { id: `resp_codex_local_${number}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model: input.model, output: [], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
      const item = { id: `msg_codex_local_${number}`, type: 'message', role: 'assistant', status: 'in_progress', content: [], phase: number === 1 ? 'commentary' : 'final_answer' };
      let text = '';
      event(res, 'response.created', { response });
      event(res, 'response.output_item.added', { output_index: 0, item });
      event(res, 'response.content_part.added', { output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      const append = delta => { text += delta; event(res, 'response.output_text.delta', { output_index: 0, item_id: item.id, content_index: 0, delta }); };
      append(number === 1 ? 'CODEX_SHARED_PREFIX: checking concurrently.\n' : 'CODEX_STEER_PREFIX: revised task in progress.\n');
      controls[key] = { append, finish: () => {
        item.status = 'completed'; item.content = [{ type: 'output_text', text, annotations: [] }];
        event(res, 'response.output_text.done', { output_index: 0, item_id: item.id, content_index: 0, text });
        event(res, 'response.content_part.done', { output_index: 0, item_id: item.id, content_index: 0, part: item.content[0] });
        event(res, 'response.output_item.done', { output_index: 0, item });
        event(res, 'response.completed', { response: { ...response, status: 'completed', output: [item] } }); res.end();
      } };
    }
  });
});
const snapshot = () => page.evaluate(() => workspace.initial());
const session = async id => (await snapshot()).sessions.find(s => s.id === id);
const save = async name => fs.writeFileSync(path.join(base, `${name}.json`), JSON.stringify(await snapshot(), null, 2));
async function drag(source, target) {
  const a = await source.boundingBox(), b = await target.boundingBox(); assert.ok(a && b);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 4, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 18 });
  await page.mouse.move(b.x + b.width / 2 + 1, b.y + b.height / 2 + 1); await page.mouse.up();
}
async function create(provider) {
  let retainedId;
  if (retained) {
    retainedId = retainedIds[provider];
    await page.locator(`[data-session-id="${retainedId}"]`).waitFor(); await page.locator(`[data-session-id="${retainedId}"]`).click();
    await page.locator('#terminal-tab').click();
    const takeover = page.getByRole('button', { name: '接管此窗口', exact: true }); if (await takeover.isVisible()) await takeover.click();
  } else {
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#initial-view').selectOption(provider === 'claude' ? 'terminal' : 'chat');
  await page.locator('#session-name').fill(provider === 'claude' ? 'Claude review' : 'Codex build'); await page.locator('#confirm-create').click();
  }
  if (provider === 'claude') {
    await until(async () => /Yes, I trust this folder|Do you want to use this API key|Claude Code v2/.test(await page.locator('#terminal-area').innerText()) || (await snapshot()).sessions.find(s => s.provider === provider)?.chatAvailable, 'Claude startup');
    if ((await page.locator('#terminal-area').innerText()).includes('Yes, I trust this folder')) {
      assert.ok((await page.locator('#terminal-area').innerText()).includes(fs.realpathSync(cwd)));
      await page.locator('#terminal-area .xterm-screen').click(); await page.keyboard.press('ArrowDown'); await sleep(200); await page.keyboard.press('Enter');
    }
    await until(async () => /Do you want to use this API key|Claude Code v2/.test(await page.locator('#terminal-area').innerText()) || (await snapshot()).sessions.find(s => s.provider === provider)?.chatAvailable, 'Claude key selection');
    if ((await page.locator('#terminal-area').innerText()).includes('Do you want to use this API key')) {
      await page.locator('#terminal-area .xterm-screen').click(); await page.keyboard.press('ArrowUp'); await sleep(200); await page.keyboard.press('Enter');
    }
  }
  if (retained) {
    if (provider === 'codex') {
      await until(async () => /Trust this folder\?/.test(await page.locator('#terminal-area').innerText()) || (await snapshot()).sessions.find(s => s.id === retainedId)?.state === 'idle', 'Codex native boot', 60000);
      if ((await page.locator('#terminal-area').innerText()).includes('Trust this folder?')) {
        const text = await page.locator('#terminal-area').innerText(); assert.ok(text.includes(cwd) || text.includes(fs.realpathSync(cwd))); assert.match(text, /› 1\. Trust and continue/);
        await page.locator(`[data-terminal-id="${retainedId}"] .xterm-helper-textarea:not([readonly])`).press('Enter');
      }
    }
    await until(async () => (await snapshot()).sessions.find(s => s.id === retainedId)?.state === 'idle', 'Retained native idle');
    await page.locator('#chat-tab').click();
    if (await page.locator('#send-button').textContent() === '接管此窗口') await page.locator('#send-button').click();
    assert.equal(await page.locator('#send-button').textContent(), '接通原会话输入'); await page.locator('#send-button').click();
    await until(async () => (await snapshot()).sessions.find(s => s.id === retainedId)?.legacySubmit, 'Same-process retained input');
    if (provider === 'claude') {
      await page.locator('#terminal-tab').click(); await page.locator('#terminal-area .xterm-screen').click(); await page.keyboard.type('/reload-plugins');
      await until(async () => (await page.locator('#terminal-area').innerText()).includes('/reload-plugins'), 'Native reload command visible');
      await sleep(300); await page.keyboard.press('Enter');
      await until(async () => (await snapshot()).sessions.find(s => s.id === retainedId)?.nativeBlockMapping, 'Retained native reader bound');
    }
    await page.locator('#chat-tab').click();
  }
  await until(async () => { const s = (await snapshot()).sessions.find(s => s.provider === provider); return s?.state === 'idle' && s.chatAvailable; }, `${provider} ready`, 60000);
  const s = (await snapshot()).sessions.find(s => s.provider === provider);
  if (provider === 'claude') await page.locator('#chat-tab').click();
  await page.locator('#message-input').fill(`Private ${provider} draft.`);
  return s;
}
async function recipient(id) {
  await page.locator('#mention-button').click(); await page.locator(`[data-mention-id="${id}"]`).click();
}
async function sharedSend(id, text) {
  await recipient(id); await page.locator('#shared-input').fill(text); await page.locator('#forward-button').click();
  await until(async () => (await snapshot()).room.messages.some(m => m.text === text && m.status === 'submitted'), 'Shared native receipt');
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(codexHome, 'config.toml'), `model = "gpt-6-luna"\nmodel_provider = "local_fixture"\nmodel_reasoning_effort = "low"\n[model_providers.local_fixture]\nname = "Local fixture"\nbase_url = "${address}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(claudeHome, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [fs.realpathSync(cwd)]: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
  const shims = {};
  for (const provider of ['claude', 'codex']) {
    const config = provider === 'codex' ? { CODEX_HOME: codexHome } : { ANTHROPIC_BASE_URL: address, ANTHROPIC_API_KEY: 'local-fixture', CLAUDE_CONFIG_DIR: claudeHome, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    shims[provider] = path.join(base, `${provider}-local`);
    fs.writeFileSync(shims[provider], '#!/usr/bin/python3\nimport os,sys\n' +
      'for key in ["OPENAI_API_KEY","CODEX_API_KEY","ANTHROPIC_AUTH_TOKEN","CLAUDE_CODE_OAUTH_TOKEN"]: os.environ.pop(key,None)\n' +
      `os.environ.update(${JSON.stringify(config)})\n` +
      `os.execv(${JSON.stringify(binaries[provider])},[${JSON.stringify(provider)}]+sys.argv[1:]+${JSON.stringify(provider === 'claude' ? ['--model', 'haiku'] : [])})\n`, { mode: 0o700 });
  }
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify(shims), { mode: 0o600 });
  if (retained) {
    const old = path.join(base, 'old'), bin = path.join(base, 'bin'); fs.mkdirSync(old); fs.mkdirSync(bin);
    execFileSync('/usr/bin/tar', ['-x', '-C', old], { input: execFileSync('git', ['archive', 'a87653b', 'app', 'package.json'], { cwd: root, maxBuffer: 16 * 1024 * 1024 }) });
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(old, 'node_modules'));
    for (const provider of ['claude', 'codex']) fs.symlinkSync(shims[provider], path.join(bin, provider));
    require('../app/legacy-input.cjs').installPlugin(cwd);
    child = fork(path.join(old, 'app/daemon.cjs'), [profile], { env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, NAW_APP_VERSION: '0.1.0-alpha.2', NAW_WORKSPACE: cwd }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Original backend boot');
    legacyClient = await connectService(profile, 'retained-concurrent-fixture');
    for (const provider of ['claude', 'codex']) retainedIds[provider] = await legacyClient.call('create', { provider, cwd, name: provider === 'claude' ? 'Claude review' : 'Codex build', view: 'terminal' });
  }
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], ...(process.env.NAW_VIDEO_DIR ? { recordVideo: { dir: process.env.NAW_VIDEO_DIR, size: { width: 1280, height: 900 } } } : {}), env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  await until(async () => { for (const candidate of application.windows()) if (!candidate.isClosed() && await candidate.locator('#new-session').count().catch(() => 0)) { page = candidate; return true; } return false; }, 'Main workspace');
  page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  if (retained) await application.evaluate(({ app }) => {
    const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
    const { LegacyShared } = load('./app/legacy-shared.cjs'); globalThis.retainedShareTrace = [];
    const { Rpc } = load('./app/adapters.cjs'), rpcCall = Rpc.prototype.call;
    Rpc.prototype.call = async function (method, params) {
      if (!this.traceErrors) { this.traceErrors = true; this.ws.on('message', bytes => { const message = JSON.parse(bytes.toString()); if (message.error) globalThis.retainedShareTrace.push({ rawError: message.error }); }); }
      try { const result = await rpcCall.call(this, method, params); globalThis.retainedShareTrace.push({ rpc: method, ok: true, status: result?.thread?.status }); return result; }
      catch (error) { globalThis.retainedShareTrace.push({ rpc: method, error: error.message, nativeMissingHistory: error.nativeMissingHistory }); throw error; }
    };
    for (const name of ['authorize', 'bindNative', 'close']) {
      const original = LegacyShared.prototype[name];
      LegacyShared.prototype[name] = function (...args) {
        const tag = name === 'authorize' ? args[2] : name === 'bindNative' ? args[1]?.tag : args[0];
        const describe = () => { const g = this.grants.get(tag); return g ? { closed: g.closed, turnId: g.turnId, state: g.runtime.state, authority: g.authority?.(), nativeValid: g.runtime.sharedReplyAvailable, rows: g.rows.size } : null; };
        const before = describe(), result = original.apply(this, args);
        globalThis.retainedShareTrace.push({ name, tag, before, after: describe(), ...(name === 'close' ? { reason: args[1] } : {}) }); return result;
      };
    }
  });
  const claude = await create('claude'), codex = await create('codex'); if (!retained) assert.equal(codex.model, 'gpt-6-luna');
  for (const s of [claude, codex]) {
    await drag(page.locator(`[data-session-id="${s.id}"]`), page.locator('#room-nav'));
    await until(async () => (await session(s.id)).roomId === 'shared', 'Mouse join');
  }
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await sharedSend(claude.id, 'Review the small local task.');
  await until(async () => (await page.locator('#room-messages').innerText()).includes('CLAUDE_SHARED_PREFIX'), 'Claude shared prefix');
  await sharedSend(codex.id, 'Build the small local task.');
  await until(async () => (await page.locator('#room-messages').innerText()).includes('CODEX_SHARED_PREFIX'), 'Codex shared prefix');
  assert.equal((await session(claude.id)).state, 'working'); assert.equal((await session(codex.id)).state, 'working');
  controls['claude-1'].append('CLAUDE_AFTER_CODEX_START: still streaming.\n');
  await until(async () => (await page.locator('#room-messages').innerText()).includes('CLAUDE_AFTER_CODEX_START'), 'Other native stream survives targeted send');
  await save('concurrent'); checks.push('Two real native agents stream independently into one attributed room reader');
  const turn = (await session(codex.id)).activeTurnId;
  await recipient(claude.id); await page.locator('#shared-input').fill('Follow up on the Claude review.');
  await page.locator('#forward-button').click();
  await until(async () => (await session(claude.id)).pendingQueue, 'Claude queued input pending');
  controls['claude-1'].append('CLAUDE_WHILE_WAITING: original public work continues.\n');
  await until(async () => (await page.locator('#room-messages').innerText()).includes('CLAUDE_WHILE_WAITING'), 'Original public output stays live while queued input waits');
  await recipient(codex.id); await page.locator('#shared-input').fill('Refine only the Codex task.');
  assert.equal(await page.locator('#forward-button').isEnabled(), true, 'Waiting Claude input must not block another recipient');
  await page.locator('#forward-button').click();
  await until(async () => (await snapshot()).room.messages.some(m => m.text === 'Refine only the Codex task.' && m.status === 'submitted'), 'Codex shared steer receipt');
  controls['claude-1'].finish();
  await until(() => controls['claude-2'], 'Claude queued native task begins');
  await until(async () => !(await session(claude.id)).pendingQueue, 'Claude queue acknowledged');
  const originalReply = (await snapshot()).room.messages.find(m => m.role === 'assistant' && m.text?.includes('CLAUDE_WHILE_WAITING'));
  assert.equal(originalReply.finalReply, true); assert.equal(originalReply.sharingStopped, undefined);
  await until(() => controls['codex-2'], 'Codex steer starts revised response');
  assert.equal((await session(codex.id)).activeTurnId, turn);
  await until(async () => (await page.locator('#room-messages').innerText()).includes('CODEX_STEER_PREFIX'), 'Steered native block');
  controls['claude-2'].append('CLAUDE_AFTER_CODEX_STEER: unchanged task continues.\n');
  await until(async () => (await page.locator('#room-messages').innerText()).includes('CLAUDE_AFTER_CODEX_STEER'), 'Other native stream survives steering');
  await save('steered'); checks.push('Steering Codex stays in its turn and does not revoke the concurrent Claude stream');
  const currentRoom = (await snapshot()).room.messages;
  const source = currentRoom.find(m => m.text === 'Follow up on the Claude review.');
  await page.locator(`[data-message-id="${source.id}"] [data-reply-to]`).click();
  assert.ok(!(await page.locator('#room-messages').innerText()).includes('CODEX_STEER_PREFIX'));
  await page.locator('#shared-input').fill('Unsent thread draft.');
  await page.reload(); await page.locator('#new-session').waitFor();
  await until(async () => (await page.locator('#shared-input').inputValue()) === 'Unsent thread draft.', 'Thread draft restoration');
  assert.deepEqual(counts, { claude: 2, codex: 2 });
  await page.locator('#thread-back').click();
  await page.locator('#room-filter').selectOption(claude.id);
  assert.ok((await page.locator('#room-messages').innerText()).includes('CLAUDE_AFTER_CODEX_STEER'));
  assert.ok(!(await page.locator('#room-messages').innerText()).includes('CODEX_STEER_PREFIX'));
  await page.locator('#room-filter').selectOption('');
  checks.push('Reply thread and member filter isolate the right trajectory; reload retains draft without new dispatch');
  await drag(page.locator(`[data-room-session="${codex.id}"]`), page.locator('#solo-drop'));
  await until(async () => (await session(codex.id)).roomId === null, 'Mouse departure');
  controls['codex-2'].append('CODEX_PRIVATE_AFTER_LEAVE: this tail stays private.\n');
  await until(async () => (await session(codex.id)).messages.some(m => m.text?.includes('CODEX_PRIVATE_AFTER_LEAVE')), 'Private native continuation');
  await drag(page.locator(`[data-session-id="${codex.id}"]`), page.locator('#room-nav'));
  await until(async () => (await session(codex.id)).roomId === 'shared', 'Mouse rejoin');
  controls['codex-2'].append('CODEX_PRIVATE_AFTER_REJOIN: no automatic republication.\n');
  controls['claude-2'].append('CLAUDE_FINAL: review complete.\n');
  controls['claude-2'].finish(); controls['codex-1'].finish(); controls['codex-2'].finish();
  await until(async () => (await snapshot()).sessions.every(s => s.state === 'idle'), 'Both native tasks finish');
  const done = await snapshot(); await save('completed');
  assert.ok(!JSON.stringify(done.room.messages).includes('CODEX_PRIVATE_AFTER'));
  const claudeReply = done.room.messages.find(m => m.sessionId === claude.id && m.role === 'assistant' && m.text?.includes('CLAUDE_FINAL'));
  assert.match(claudeReply.text, /CLAUDE_FINAL/); assert.equal(claudeReply.status, 'complete'); assert.equal(claudeReply.finalReply, true);
  checks.push('Departure and rejoin preserve native work while revoked output stays private; the other agent completes normally');
  for (const original of [claude, codex]) {
    const s = done.sessions.find(s => s.id === original.id); assert.equal(s.nativeId, original.nativeId);
    if (s.provider === 'claude' || retained) assert.equal(s.pid, original.pid);
    else assert.deepEqual(s.serverIdentity, original.serverIdentity);
    assert.equal(s.liveDraft, `Private ${s.provider} draft.`);
    await page.locator(`[data-session-id="${s.id}"]`).click(); await page.locator('#terminal-tab').click();
    await until(async () => (await page.locator('#terminal-area').innerText()).includes(s.provider === 'claude' ? 'CLAUDE_FINAL' : 'CODEX_PRIVATE_AFTER_REJOIN'), 'Native terminal final content', 60000);
    fs.writeFileSync(path.join(base, `${s.provider}-terminal.txt`), await page.locator('#terminal-area').innerText());
    await page.locator('#chat-tab').click();
    assert.equal(await page.locator('#message-input').inputValue(), `Private ${s.provider} draft.`);
  }
  const claudeRequest = JSON.parse(fs.readFileSync(path.join(base, 'claude-1-request.json')));
  assert.ok(!JSON.stringify(claudeRequest.messages).includes('Codex task'));
  const codexRequest = JSON.parse(fs.readFileSync(path.join(base, 'codex-2-request.json')));
  assert.ok(JSON.stringify(codexRequest.input).includes('Refine only the Codex task.'));
  assert.ok(!JSON.stringify(codexRequest.input).includes('Review the small local task.'));
  assert.equal(done.diagnostics.dispatches, 4); assert.deepEqual(counts, { claude: 2, codex: 2 }); assert.deepEqual(errors, []);
  checks.push('Native GUI/TUI identities, native backends, private drafts and exact recipient payloads remain separate; four dispatches only');
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'concurrent-room.png') }); }
  if (retained) fs.writeFileSync(path.join(base, 'sharing-trace.json'), JSON.stringify(await application.evaluate(() => globalThis.retainedShareTrace), null, 2));
  console.log(JSON.stringify({ checks, versions, retained, counts, nativeTitleResponses: titleCalls, paidModelCalls: 0, evidence: base }));
})().catch(async error => {
  if (page && !page.isClosed()) {
    fs.writeFileSync(path.join(base, 'failure.txt'), await page.locator('body').innerText().catch(() => ''));
    if (retained) fs.writeFileSync(path.join(base, 'sharing-trace.json'), JSON.stringify(await application.evaluate(() => globalThis.retainedShareTrace).catch(() => []), null, 2));
    await save('failure').catch(() => {}); await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {});
  }
  console.error(error.stack, '\nEvidence:', base); process.exitCode = 1;
}).finally(async () => {
  server.closeAllConnections(); if (application) await application.close().catch(() => {});
  try {
    const client = await connect(profile, 'concurrent-cleanup');
    try {
      for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id);
      const owned = client.entries.map(entry => processIdentity(entry.state.servicePid));
      for (const identity of owned) { assert.ok(identity && processMayBeAlive(identity)); process.kill(identity.pid, 'SIGTERM'); }
      await until(() => owned.every(identity => !processMayBeAlive(identity)), 'Owned services terminate', 15000);
      console.log('Owned service exit confirmed.');
    } finally { client.close(); }
  } catch (error) { console.error('Owned trial cleanup not confirmed:', error.message); process.exitCode = 1; }
  legacyClient?.close(); if (child?.connected) child.disconnect();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
});
