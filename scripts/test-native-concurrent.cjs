// Actual Electron, Claude and Codex. Four task responses (five for native interruption),
// plus at most one native title response; all fixed loopback data, no paid inference.
// Tests the existing room interaction, including real mouse drag and native streaming.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), { execFileSync, fork } = require('node:child_process');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const { executable, processIdentity, processMayBeAlive } = require('../app/platform.cjs');
const { connect, connectService } = require('../app/service-client.cjs');
const retained = process.env.NAW_CONCURRENT_RETAINED === '1';
const nativeInterrupt = process.env.NAW_CONCURRENT_INTERRUPT === '1';
const emptyTerminal = process.env.NAW_CONCURRENT_EMPTY_TERMINAL === '1';
const providers = emptyTerminal ? ['codex'] : ['claude', 'codex'];
if (!process.env.NAW_APP_EXECUTABLE) execFileSync(process.execPath, [path.join(root, 'scripts/build-ui.cjs')]);
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-native-concurrent-'));
const profile = path.join(base, 'profile'), cwd = path.join(base, 'work');
const claudeHome = path.join(base, 'claude'), codexHome = path.join(base, 'codex');
for (const dir of [profile, cwd, claudeHome, codexHome]) fs.mkdirSync(dir, { mode: 0o700 });
const binaries = Object.fromEntries(providers.map(p => [p, executable(p) && fs.realpathSync(executable(p))]));
if (retained) { assert.ok(process.env.NAW_CLAUDE_302); binaries.claude = process.env.NAW_CLAUDE_302; }
const versions = Object.fromEntries(Object.entries(binaries).map(([p, file]) => {
  assert.ok(file, `Real ${p} required`); return [p, execFileSync(file, ['--version'], { encoding: 'utf8' }).trim()];
}));
if (!emptyTerminal) assert.match(versions.claude, retained ? /^2\.1\.302\b/ : /^2\.1\.(308|309)\b/);
assert.equal(versions.codex, 'codex-cli 0.163.0');
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
    if (number > (nativeInterrupt && provider === 'claude' ? 3 : 2)) { res.writeHead(429); res.end(); return; }
    const key = `${provider}-${number}`;
    fs.writeFileSync(path.join(base, `${key}-request.json`), body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (provider === 'claude') {
      event(res, 'message_start', { message: { id: 'msg_claude_local', type: 'message', role: 'assistant', model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      event(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      const append = text => event(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
      append(number === 1 ? 'CLAUDE_SHARED_PREFIX: checking the small task.\n' : nativeInterrupt && number === 2 ? 'CLAUDE_NATIVE_RECOVERY: private input after stop.\n' : 'CLAUDE_QUEUED_PREFIX: following up.\n');
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
async function openApplication() {
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], ...(process.env.NAW_VIDEO_DIR ? { recordVideo: { dir: process.env.NAW_VIDEO_DIR, size: { width: 1280, height: 900 } } } : {}), env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  await until(async () => { for (const candidate of application.windows()) if (!candidate.isClosed() && await candidate.locator('#new-session').count().catch(() => 0)) { page = candidate; return true; } return false; }, 'Main workspace');
  page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(codexHome, 'config.toml'), `model = "gpt-6-luna"\nmodel_provider = "local_fixture"\nmodel_reasoning_effort = "low"\n[model_providers.local_fixture]\nname = "Local fixture"\nbase_url = "${address}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(claudeHome, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [fs.realpathSync(cwd)]: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
  const shims = {};
  for (const provider of providers) {
    const config = provider === 'codex' ? { CODEX_HOME: codexHome } : { ANTHROPIC_BASE_URL: address, ANTHROPIC_API_KEY: 'local-fixture', CLAUDE_CONFIG_DIR: claudeHome, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' };
    shims[provider] = path.join(base, `${provider}-local`);
    fs.writeFileSync(shims[provider], '#!/usr/bin/python3\nimport os,sys\n' +
      'for key in ["OPENAI_API_KEY","CODEX_API_KEY","ANTHROPIC_AUTH_TOKEN","CLAUDE_CODE_OAUTH_TOKEN"]: os.environ.pop(key,None)\n' +
      `os.environ.update(${JSON.stringify(config)})\n` +
      `os.execv(${JSON.stringify(binaries[provider])},[${JSON.stringify(provider)}]+sys.argv[1:]+${JSON.stringify(provider === 'claude' ? ['--model', 'haiku', '--debug-file', path.join(base, 'claude-debug.log')] : [])})\n`, { mode: 0o700 });
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
  await openApplication();
  if (emptyTerminal) {
    assert.equal(retained, false);
    const codex = await create('codex');
    await page.locator('#terminal-tab').click();
    await page.locator('.terminal-loading').getByText('请先在对话中发送第一条消息，再打开同一会话的原生终端。', { exact: true }).waitFor();
    assert.equal((await snapshot()).diagnostics.dispatches, 0); assert.deepEqual(counts, { claude: 0, codex: 0 });
    assert.equal(await page.locator('#terminal-area .xterm-helper-textarea').isVisible(), false);
    await save('empty-terminal-guidance');
    await page.screenshot({ path: path.join(base, 'empty-terminal-guidance.png') });
    await page.locator('#chat-tab').click(); await page.locator('#message-input').fill('Start the first Codex task.'); await page.locator('#send-button').click();
    await until(() => controls['codex-1'], 'Requested first turn');
    await page.locator('#terminal-tab').click();
    await until(async () => { const text = await page.locator('#terminal-area').innerText(); return text.includes('Start the first Codex task.') && text.includes('Working'); }, 'The same native terminal displays the active first input');
    assert.equal((await session(codex.id)).state, 'working');
    // Native TUI attachment may not replay deltas emitted before it subscribed.
    // Verify newly arriving output, without claiming backfilled partial text.
    controls['codex-1'].append('AFTER_ATTACH: the original task is still streaming.\n');
    await until(async () => (await page.locator('#terminal-area').innerText()).includes('AFTER_ATTACH'), 'New native output reaches the attached terminal');
    await save('first-terminal-working');
    controls['codex-1'].finish();
    await until(async () => (await session(codex.id)).state === 'idle', 'First native response ends');
    assert.equal((await session(codex.id)).nativeId, codex.nativeId);
    assert.deepEqual((await session(codex.id)).serverIdentity, codex.serverIdentity);
    assert.equal((await snapshot()).diagnostics.dispatches, 1); assert.deepEqual(counts, { claude: 0, codex: 1 }); assert.deepEqual(errors, []);
    await save('first-terminal-ready');
    await page.screenshot({ path: path.join(base, 'first-terminal-ready.png') });
    await page.locator('#chat-tab').click();
    await until(async () => { const text = await page.locator('#messages').innerText(); return text.includes('CODEX_SHARED_PREFIX') && text.includes('AFTER_ATTACH'); }, 'The main reader retains both pre-attachment and later output');
    console.log(JSON.stringify({ checks: ['An empty native Codex session shows the necessary first-message step with zero seed tasks', 'During the single requested first GUI turn, terminal displays its input and new output after attachment', 'The original turn finishes and the main reader retains the complete reply without another submission'], versions, counts, nativeTitleResponses: titleCalls, paidModelCalls: 0, evidence: base }));
    return;
  }
  if (retained) await application.evaluate(({ app }) => {
    const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
    const { LegacyShared } = load('./app/legacy-shared.cjs'); globalThis.retainedShareTrace = [];
    const { Rpc } = load('./app/adapters.cjs'), rpcCall = Rpc.prototype.call;
    Rpc.prototype.call = async function (method, params) {
      if (!this.traceErrors) { this.traceErrors = true; this.ws.on('message', bytes => { const message = JSON.parse(bytes.toString()); if (message.error) globalThis.retainedShareTrace.push({ rawError: message.error }); }); }
      try { const result = await rpcCall.call(this, method, params); globalThis.retainedShareTrace.push({ rpc: method, ok: true, status: result?.thread?.status }); return result; }
      catch (error) { globalThis.retainedShareTrace.push({ rpc: method, error: error.message, nativeMissingHistory: error.nativeMissingHistory }); throw error; }
    };
    const { SubmissionChannel } = load('./app/claude-submit.cjs');
    for (const name of ['receive', 'authorize', 'result', 'finish']) {
      const original = SubmissionChannel.prototype[name];
      SubmissionChannel.prototype[name] = function (...args) {
        const tag = this.pending?.tag;
        const result = original.apply(this, args);
        globalThis.retainedShareTrace.push({ channel: name, tag, allowed: name === 'authorize' ? result : undefined,
          status: name === 'result' ? args[0]?.status : undefined, reason: name === 'result' ? args[0]?.reason : undefined, error: name === 'finish' ? args[0]?.message : undefined });
        return result;
      };
    }
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
  if (nativeInterrupt) {
    for (const original of [claude, codex]) {
      const key = original.provider + '-1', marker = original.provider.toUpperCase() + '_TRAILING_FRAGMENT';
      controls[key].append(marker);
      await page.locator(`[data-session-id="${original.id}"]`).click();
      const keyboardInterrupt = retained || original.provider === 'claude';
      let terminalText = '';
      if (keyboardInterrupt) {
        await page.locator('#terminal-tab').click();
        // Claude batches complete lines even in its own terminal. Do not wait
        // for an unfinished line before interrupting the real native stream.
        await until(async () => (await page.locator('#terminal-area').innerText()).includes(original.provider.toUpperCase() + '_SHARED_PREFIX'), 'Native terminal displays the running reply');
        fs.writeFileSync(path.join(base, original.provider + '-before-interrupt-terminal.txt'), await page.locator('#terminal-area').innerText());
        await page.locator('#terminal-area .xterm-screen:visible').click(); await page.keyboard.press('Escape');
      } else {
        // A GUI-created first Codex turn cannot attach a TUI before its rollout
        // exists. Use the real existing GUI interrupt, separately from the
        // retained TUI keyboard path; do not seed a hidden model turn.
        await page.locator('#chat-tab').click(); await page.locator('#interrupt').click();
      }
      await until(async () => (await session(original.id)).messages.some(m => m.kind === 'turn' && m.status === 'interrupted'), 'Exact native interruption boundary');
      if (keyboardInterrupt) {
        terminalText = await page.locator('#terminal-area').innerText();
        fs.writeFileSync(path.join(base, original.provider + '-interrupted-terminal.txt'), terminalText);
      }
      await until(async () => (await session(original.id)).state === 'idle', 'Native idle after keyboard interruption');
      const s = await session(original.id);
      assert.equal(s.nativeId, original.nativeId);
      if (retained || s.provider === 'claude') assert.equal(s.pid, original.pid);
      else assert.deepEqual(s.serverIdentity, original.serverIdentity);
      assert.equal(s.liveDraft, `Private ${s.provider} draft.`);
      const visibleTail = terminalText.includes(marker) ? marker : original.provider.toUpperCase() + '_SHARED_PREFIX';
      assert.ok(s.messages.some(m => m.role === 'assistant' && m.text?.includes(visibleTail)), 'Private reader preserves the native visible partial line');
      await page.locator('#chat-tab').click();
      assert.ok((await page.locator('#messages').innerText()).includes(visibleTail));
      await page.locator('#room-nav').click(); await page.locator('#room-record').click();
      const room = (await snapshot()).room.messages;
      assert.ok(room.some(m => m.sessionId === s.id && m.text?.includes(visibleTail)), 'Shared block preserves native visible partial line through confirmed interruption');
      assert.ok(room.some(m => m.sessionId === s.id && m.status === 'interrupted'));
      assert.ok(!room.some(m => m.sessionId === s.id && m.finalReply), 'Interrupted work is never a successful final reply');
      assert.ok((await page.locator('#room-messages').innerText()).includes(visibleTail));
      await save(original.provider + '-interrupted');
      if (original.provider === 'claude') {
        controls['codex-1'].append('CODEX_AFTER_CLAUDE_INTERRUPT: still working.\n');
        await until(async () => (await page.locator('#room-messages').innerText()).includes('CODEX_AFTER_CLAUDE_INTERRUPT'), 'Other member stays live after native interruption');
        assert.equal((await session(codex.id)).state, 'working');
      }
      checks.push(`Native ${s.provider} ${keyboardInterrupt ? 'Escape' : 'GUI interrupt'} preserves exact partial output and draft in solo/shared readers, without ending the peer task`);
    }
    const interruptedPrivate = (await session(codex.id)).messages.filter(m => m.status === 'interrupted').map(m => ({ id: m.id, text: m.text, status: m.status }));
    assert.ok(interruptedPrivate.some(m => m.text?.includes('CODEX_SHARED_PREFIX')));
    const assertPrivateRetained = async () => {
      const current = await session(codex.id);
      for (const row of interruptedPrivate) assert.ok(current.messages.some(m => m.id === row.id && m.text === row.text && m.status === row.status), 'Private interrupted row survives full app exit and later work');
      await page.locator(`[data-session-id="${codex.id}"]`).click(); await page.locator('#chat-tab').click();
      assert.ok((await page.locator('#messages').innerText()).includes('CODEX_SHARED_PREFIX'));
      await page.locator('#room-nav').click(); await page.locator('#room-record').click();
    };
    // Claude's native Stop explicitly refuses plugin input until a new human
    // native input arrives. The UI must keep drafts and explain that boundary,
    // never synthesize Enter or quietly resubmit. Exercise the real route.
    await recipient(claude.id);
    assert.equal(await page.locator('#forward-button').textContent(), '打开原生终端');
    assert.ok((await page.locator('#run-help').innerText()).includes('暂停插件输入'));
    assert.equal((await session(claude.id)).nativeInputRequired, true);
    await page.locator(`[data-session-id="${claude.id}"]`).click();
    await page.locator('#chat-tab').click();
    assert.equal(await page.locator('#send-button').textContent(), '打开原生终端');
    assert.equal(await page.locator('#message-input').inputValue(), 'Private claude draft.');
    assert.equal(await page.locator('#message-input').getAttribute('readonly'), null);
    await page.locator('#room-nav').click(); await page.locator('#room-record').click();
    await recipient(claude.id);
    const beforeRecovery = (await snapshot()).diagnostics.dispatches;
    if (process.env.NAW_CONCURRENT_REOPEN === '1') { await application.close(); application = null; await openApplication(); }
    else { await page.reload(); await page.locator('#new-session').waitFor(); }
    await until(async () => (await page.locator('#forward-button').textContent()) === '打开原生终端', 'Native pause survives reopening');
    assert.equal((await session(claude.id)).nativeId, claude.nativeId); assert.equal((await session(claude.id)).pid, claude.pid);
    assert.equal((await session(claude.id)).nativeInputRequired, true);
    if (retained) await until(async () => (await session(claude.id)).legacySubmit && (await session(codex.id)).legacySubmit, 'Original native observers reconnect before the new user action');
    await assertPrivateRetained(); await recipient(claude.id);
    await save('interrupted-private-restored');
    await page.locator('#forward-button').click();
    await page.locator('#terminal-area .xterm-screen:visible').waitFor();
    const recovery = 'Continue privately from the native terminal.';
    await page.locator('#terminal-area .xterm-screen:visible').click(); await page.keyboard.type(recovery);
    await until(async () => (await page.locator('#terminal-area').innerText()).includes(recovery), 'Native recovery edit line is visible before Enter');
    fs.writeFileSync(path.join(base, 'claude-recovery-edit-line.txt'), await page.locator('#terminal-area').innerText());
    await page.keyboard.press('Enter');
    await until(() => controls['claude-2'], 'Native human input resumes Claude after Stop');
    await until(async () => (await session(claude.id)).nativeInputRequired === false, 'Fresh native turn releases plugin pause');
    controls['claude-2'].finish();
    await until(async () => (await session(claude.id)).state === 'idle', 'Private native recovery finishes');
    assert.equal((await snapshot()).diagnostics.dispatches, beforeRecovery, 'Portal did not dispatch or replay the native recovery');
    assert.equal((await session(claude.id)).liveDraft, 'Private claude draft.');
    assert.ok(!(await snapshot()).room.messages.some(m => m.text?.includes('CLAUDE_NATIVE_RECOVERY')));
    await page.locator('#room-record').click();
    checks.push(`Claude native Stop remains visible through ${process.env.NAW_CONCURRENT_REOPEN === '1' ? 'whole-app reopening' : 'renderer reload'}; real human native input resumes the same session, with private draft and reply preserved`);
    // Now verify GUI delivery against both native engines without replacement.
    for (const original of [claude, codex]) {
      const key = original.provider + (original.provider === 'claude' ? '-3' : '-2');
      await sharedSend(original.id, `Continue the ${original.provider} task after interruption.`);
      await until(() => controls[key], 'Same native session accepts the next task');
      controls[key].finish();
      await until(async () => (await session(original.id)).state === 'idle', 'Resumed task finishes');
      assert.equal((await session(original.id)).nativeId, original.nativeId);
    }
    checks.push('After the required Claude native recovery, both sessions accept and finish a new GUI task without replacing either session');
    assert.deepEqual(counts, { claude: 3, codex: 2 }); assert.deepEqual(errors, []);
    await page.reload(); await page.locator('#new-session').waitFor();
    await until(async () => (await page.locator('#room-messages').innerText()).includes('CODEX_SHARED_PREFIX'), 'Interrupted reader survives renderer reload');
    await assertPrivateRetained();
    checks.push('Private and shared Codex interrupted text and boundary survive full app reopening and later GUI work');
    const final = await snapshot(); assert.equal(final.diagnostics.dispatches, 4); await save('interrupted-reopened');
    assert.ok(final.room.messages.filter(m => m.role === 'human').every(m => m.status === 'submitted'));
    if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'native-interruption.png') }); }
    console.log(JSON.stringify({ checks, versions, retained, counts, nativeTitleResponses: titleCalls, paidModelCalls: 0, evidence: base }));
    return;
  }
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
    if (retained) fs.writeFileSync(path.join(base, 'sharing-trace.json'), JSON.stringify(await application.evaluate(() => globalThis.retainedShareTrace || []).catch(() => []), null, 2));
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
