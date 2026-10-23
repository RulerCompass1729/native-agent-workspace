// Real Electron + native Claude/Codex; fixed loopback responses exercise tool
// calls and transport, not model judgement. No paid inference or global settings.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), { execFileSync } = require('node:child_process');
const { _electron } = require('playwright');
const { executable, processIdentity, processMayBeAlive } = require('../app/platform.cjs');
const { connect } = require('../app/service-client.cjs');
const root = path.resolve(__dirname, '..'), base = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-native-addressed-'));
const profile = path.join(base, 'profile'), cwd = path.join(base, 'work');
const homes = { claude: path.join(base, 'claude'), codex: path.join(base, 'codex') };
for (const dir of [profile, cwd, ...Object.values(homes)]) fs.mkdirSync(dir, { mode: 0o700 });
const binaries = Object.fromEntries(['claude', 'codex'].map(p => [p, fs.realpathSync(executable(p))]));
const versions = Object.fromEntries(Object.entries(binaries).map(([p, file]) => [p, execFileSync(file, ['--version'], { encoding: 'utf8' }).trim()]));
assert.match(versions.claude, /^2\.1\.309\b/); assert.equal(versions.codex, 'codex-cli 0.163.0');
let app, page, ids = {}, held, release, sequence = 0;
const counts = { claude: 0, codex: 0 }, errors = [], checks = [];
const deny = process.env.NAW_TEST_NATIVE_DENY === '1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, timeout = 40000) { const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await sleep(75); } throw Error(label); }
const snapshot = () => page.evaluate(() => workspace.initial());
function event(res, type, body) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: ++sequence, ...body })}\n\n`); }
function claudeBlock(res, index, content) {
  event(res, 'content_block_start', { index, content_block: content.type === 'text' ? { type: 'text', text: '' } : { ...content, input: {} } });
  event(res, 'content_block_delta', { index, delta: content.type === 'text' ? { type: 'text_delta', text: content.text } : { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } });
  event(res, 'content_block_stop', { index });
}
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', b => body += b); req.on('end', async () => {
    const provider = req.url.endsWith('/responses') ? 'codex' : req.url.startsWith('/v1/messages') && !req.url.includes('count_tokens') ? 'claude' : null;
    if (!provider) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":100,"data":[]}'); return; }
    const number = ++counts[provider], input = JSON.parse(body);
    fs.writeFileSync(path.join(base, `${provider}-${number}-request.json`), body);
    const schemas = JSON.stringify([...(input.tools || []), ...(input.input || []).filter(m => m.type === 'additional_tools').flatMap(m => m.tools || [])]);
    if (!(provider === 'claude' ? (input.tools || []).some(t => t.name === 'mcp__native_workspace__workspace_message' && t.input_schema?.properties?.recipient_id) : schemas.includes('workspace__workspace_message(args: {') && schemas.includes('recipient_id: string'))) { errors.push(`${provider} missing actual workspace tool schema`); res.writeHead(500); res.end(); return; }
    if (number > 4) { res.writeHead(429); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (provider === 'claude') {
      assert.match(input.model, /haiku/);
      event(res, 'message_start', { message: { id: `msg_claude_${number}`, type: 'message', role: 'assistant', model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      if (number === 1) {
        claudeBlock(res, 0, { type: 'text', text: '预算草案：两份午餐各 18 元，交通共 14 元，总计 50 元。请 Codex 核查。\n' });
        claudeBlock(res, 1, { type: 'tool_use', id: 'toolu_addressed_budget', name: 'mcp__native_workspace__workspace_message', input: { recipient_id: ids.codex, message: '请独立核查预算：午餐 2×18，交通 14，总计是否为 50？请把核查结果发回给我。' } });
      } else claudeBlock(res, 0, { type: 'text', text: number === 2 ? '已登记核查请求，等待本轮结束后转交。' : number === 3 ? '最终预算：50 元。两位 agent 已分别核查，结果一致。' : '脱出后的私人继续：保留 50 元预算，私人备注不共享。' });
      event(res, 'message_delta', { delta: { stop_reason: number === 1 ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 30 } });
      event(res, 'message_stop', {}); res.end();
    } else {
      assert.equal(input.model, 'gpt-6-luna');
      const response = { id: `resp_codex_${number}`, object: 'response', status: 'in_progress', model: input.model, output: [], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
      event(res, 'response.created', { response });
      if (number === 1 || number === 3) {
        const args = JSON.stringify({ recipient_id: ids.claude, message: number === 1 ? '已独立核查：2×18+14=50，预算正确。请完成最终说明。' : '这是暂停测试；只有真人未暂停时才可继续。' });
        const code = `text(await tools.workspace__workspace_message(${args}));`;
        const item = { id: `tool_codex_${number}`, type: 'custom_tool_call', namespace: 'functions', name: 'exec', call_id: `call_addressed_${number}`, input: code, status: 'completed' };
        event(res, 'response.output_item.added', { output_index: 0, item: { ...item, input: '', status: 'in_progress' } });
        event(res, 'response.custom_tool_call_input.delta', { output_index: 0, item_id: item.id, delta: code });
        event(res, 'response.custom_tool_call_input.done', { output_index: 0, item_id: item.id, input: code });
        event(res, 'response.output_item.done', { output_index: 0, item });
        event(res, 'response.completed', { response: { ...response, status: 'completed', output: [item] } }); res.end(); return;
      }
      const text = number === 2 ? '核查结果已登记返回 Claude。' : '已登记后续请求；本轮仍在整理。';
      const item = { id: `msg_codex_${number}`, type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] };
      event(res, 'response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
      event(res, 'response.content_part.added', { output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      event(res, 'response.output_text.delta', { output_index: 0, item_id: item.id, content_index: 0, delta: text });
      if (number === 4) { held = res; await new Promise(r => { release = r; }); if (res.destroyed) return; }
      event(res, 'response.output_text.done', { output_index: 0, item_id: item.id, content_index: 0, text });
      event(res, 'response.content_part.done', { output_index: 0, item_id: item.id, content_index: 0, part: item.content[0] });
      event(res, 'response.output_item.done', { output_index: 0, item });
      event(res, 'response.completed', { response: { ...response, status: 'completed', output: [item] } }); res.end();
    }
  });
});
async function launch() {
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    ...(process.env.NAW_VIDEO_DIR ? { recordVideo: { dir: process.env.NAW_VIDEO_DIR, size: { width: 1280, height: 900 } } } : {}),
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  await until(async () => { for (const p of app.windows()) if (!p.isClosed() && await p.locator('#new-session').count().catch(() => 0)) { page = p; return true; } }, 'Main workspace');
  page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
}
async function create(provider) {
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#initial-view').selectOption(provider === 'claude' ? 'terminal' : 'chat');
  await page.locator('#session-name').fill(provider === 'claude' ? '预算方案' : '预算核查'); await page.locator('#confirm-create').click();
  if (provider === 'claude') {
    await until(async () => /Yes, I trust this folder|Do you want to use this API key|Claude Code v2/.test(await page.locator('#terminal-area').innerText()) || (await snapshot()).sessions.find(s => s.provider === provider)?.chatAvailable, 'Native Claude startup');
    if ((await page.locator('#terminal-area').innerText()).includes('Yes, I trust this folder')) {
      assert.ok((await page.locator('#terminal-area').innerText()).includes(fs.realpathSync(cwd)));
      await page.locator('#terminal-area .xterm-helper-textarea').waitFor({ state: 'visible' });
      await until(async () => !(await page.locator('#terminal-paste').isDisabled()), 'Native terminal input ready');
      await page.locator('#terminal-area .xterm-screen').click();
      await until(async () => page.locator('#terminal-area .xterm-helper-textarea').evaluate(el => el === document.activeElement), 'Native terminal input focused');
      const selectedTrust = async () => /[❯›>]\s*(?:\d+[.)]\s*)?Yes, I trust this folder/.test(await page.locator('#terminal-area').innerText());
      if (!(await selectedTrust())) await page.keyboard.press('ArrowDown');
      await until(selectedTrust, 'Exact native trust choice selected');
      await page.keyboard.press('Enter');
    }
    await until(async () => /Do you want to use this API key|Claude Code v2/.test(await page.locator('#terminal-area').innerText()) || (await snapshot()).sessions.find(s => s.provider === provider)?.chatAvailable, 'Native key choice');
    if ((await page.locator('#terminal-area').innerText()).includes('Do you want to use this API key')) { await page.locator('#terminal-area .xterm-screen').click(); await page.keyboard.press('ArrowUp'); await sleep(200); await page.keyboard.press('Enter'); }
  }
  await until(async () => { const s = (await snapshot()).sessions.find(s => s.provider === provider); return s?.state === 'idle' && s.chatAvailable && s.addressedSendAvailable; }, `${provider} addressed tool connected`, 60000);
  const s = (await snapshot()).sessions.find(s => s.provider === provider); ids[provider] = s.id;
  await page.locator('#header-actions').getByRole('button', { name: '加入协作', exact: true }).click(); return s;
}
async function start(first, text) {
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await page.locator('#mention-button').click(); await page.locator(`[data-mention-id="${first}"]`).click();
  await page.locator('#shared-input').fill(text); await page.locator('#room-advanced summary').click(); await page.locator('#run-button').click();
  await page.locator('#run-mode').selectOption('directed'); await page.locator('#run-limit').selectOption('3'); await page.locator('#run-consent').check(); await page.locator('#confirm-run').click();
}
(async () => {
  console.log('Evidence:', base); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const address = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(homes.codex, 'config.toml'), `model = "gpt-6-luna"\nmodel_provider = "local_fixture"\nmodel_reasoning_effort = "low"\n[model_providers.local_fixture]\nname = "Local fixture"\nbase_url = "${address}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(homes.claude, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [fs.realpathSync(cwd)]: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
  if (deny) {
    const hook = path.join(base, 'deny-addressed.py');
    fs.writeFileSync(hook, 'import json,sys\njson.load(sys.stdin)\nprint(json.dumps({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Synthetic native policy denial"}}))\n');
    fs.writeFileSync(path.join(homes.claude, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'mcp__native_workspace__workspace_message', hooks: [{ type: 'command', command: '/usr/bin/python3 '+hook }] }] } }));
  }
  const shims = {};
  for (const p of ['claude', 'codex']) {
    const env = p === 'codex' ? { CODEX_HOME: homes[p] } : { ANTHROPIC_BASE_URL: address, ANTHROPIC_API_KEY: 'local-fixture', CLAUDE_CONFIG_DIR: homes[p], CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' };
    shims[p] = path.join(base, `${p}-local`);
    fs.writeFileSync(shims[p], '#!/usr/bin/python3\nimport os,sys\nfor key in ["OPENAI_API_KEY","CODEX_API_KEY","ANTHROPIC_AUTH_TOKEN","CLAUDE_CODE_OAUTH_TOKEN"]: os.environ.pop(key,None)\n' + `os.environ.update(${JSON.stringify(env)})\n` + `os.execv(${JSON.stringify(binaries[p])},[${JSON.stringify(p)}]+sys.argv[1:]+${JSON.stringify(p === 'claude' ? ['--model', 'haiku', '--debug-file', path.join(base, 'claude-debug.log')] : [])})\n`, { mode: 0o700 });
  }
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify(shims), { mode: 0o600 });
  if (!process.env.NAW_APP_EXECUTABLE) execFileSync(process.execPath, [path.join(root, 'scripts/build-ui.cjs')]);
  await launch(); const claude = await create('claude'), codex = await create('codex');
  const identities = [claude, codex].map(s => [s.id, s.nativeId, s.pid]);
  await start(claude.id, '两份午餐各18元，交通总共14元。Claude提出预算，Codex独立核查并返回，Claude给我最终结论。');
  await until(async () => (await snapshot()).room.run?.status !== 'running', 'Native addressed round finishes', 60000);
  let state = await snapshot(); fs.writeFileSync(path.join(base, 'round-one.json'), JSON.stringify(state, null, 2));
  if (deny) {
    assert.equal(state.room.run.status, 'paused'); assert.equal(state.diagnostics.dispatches, 1);
    assert.deepEqual(counts, { claude: 2, codex: 0 }); assert.deepEqual(errors, []);
    assert.equal(state.room.messages.filter(m => m.addressed).length, 0);
    assert.match(fs.readFileSync(path.join(base, 'claude-2-request.json'), 'utf8'), /Synthetic native policy denial/);
    console.log(JSON.stringify({ versions, checks: ['Native PreToolUse denial overrides the named tool allowance; no peer input; room pauses'], counts, paidModelCalls: 0, evidence: base }, null, 2)); return;
  }
  assert.equal(state.room.run.status, 'completed'); assert.equal(state.room.run.steps, 3); assert.equal(state.diagnostics.dispatches, 3);
  assert.deepEqual(counts, { claude: 3, codex: 2 });
  assert.equal(state.room.messages.filter(m => m.addressed).length, 2);
  assert.match(await page.locator('#room-messages').innerText(), /最终预算：50 元/);
  for (const m of state.room.messages.filter(m => m.addressed)) { assert.equal(m.deliveries.length, 1); assert.equal(m.deliveries[0].status, 'submitted'); }
  checks.push('Real native structured calls: Claude → Codex → Claude, exact recipient and receipt, one main reader');
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'addressed-budget.png') }); }
  await start(codex.id, '再做一次核查，但我会在转交前暂停。');
  await until(() => release, 'Native second task reaches held completion');
  await until(async () => (await snapshot()).room.run?.pendingHandoff, 'Native addressed intent staged');
  await page.locator('#pause-button').click(); release();
  await until(async () => (await snapshot()).sessions.find(s => s.id === codex.id).state === 'idle', 'Current native turn can finish after pause');
  assert.equal((await snapshot()).room.run.status, 'paused'); assert.equal(counts.claude, 3); assert.equal((await snapshot()).diagnostics.dispatches, 4);
  checks.push('Human pause revokes a staged message; no peer task starts');
  await page.locator(`[data-session-id="${claude.id}"]`).click(); await page.getByRole('button', { name: '脱出协作', exact: true }).click();
  await page.locator('#terminal-tab').click(); await until(async () => (await page.locator('#terminal-area').innerText()).includes('最终预算'), 'Same Claude terminal shows collaborative result');
  await page.locator('#terminal-area .xterm-screen').click(); await page.keyboard.type('Continue privately with this budget.');
  await until(async () => (await page.locator('#terminal-area').innerText()).includes('Continue privately with this budget.'), 'Native draft visible'); await page.keyboard.press('Enter');
  await until(async () => (await page.locator('#terminal-area').innerText()).includes('脱出后的私人继续'), 'Private native continuation');
  await until(async () => (await snapshot()).sessions.find(s => s.id === claude.id).state === 'idle', 'Private turn finishes');
  assert.ok(!(await snapshot()).room.messages.some(m => m.text?.includes('私人备注')));
  checks.push('Detach and continue in the same native TUI; private continuation does not enter the room');
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await page.locator('#shared-input').fill('下一次的草稿，暂不发送。'); await sleep(400);
  const before = await snapshot(); await app.close(); app = null; await launch();
  await until(async () => (await snapshot()).sessions.length === 2, 'Original sessions reconnect');
  state = await snapshot();
  assert.deepEqual(state.sessions.map(s => [s.id, s.nativeId, s.pid]), identities);
  assert.equal(state.room.run.status, 'paused'); assert.equal(state.diagnostics.dispatches, before.diagnostics.dispatches);
  assert.equal(await page.locator('#shared-input').inputValue(), '下一次的草稿，暂不发送。');
  assert.match(await page.locator('#room-messages').innerText(), /最终预算：50 元/);
  assert.deepEqual(counts, { claude: 4, codex: 4 }); assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(base, 'reopened.json'), JSON.stringify(state, null, 2));
  checks.push('Full application reopening preserves IDs/PIDs, room history and draft without replay');
  console.log(JSON.stringify({ versions, checks, counts, paidModelCalls: 0, evidence: base }, null, 2));
})().catch(async error => {
  if (page && !page.isClosed()) { fs.writeFileSync(path.join(base, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); fs.writeFileSync(path.join(base, 'failure.json'), JSON.stringify(await snapshot().catch(() => ({})), null, 2)); }
  console.error(error.stack, '\nEvidence:', base); process.exitCode = 1;
}).finally(async () => {
  release?.(); held?.destroy(); if (app) await app.close().catch(() => {});
  try { const client = await connect(profile, 'addressed-cleanup');
    try {
      for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id);
      const owned = client.entries.map(e => processIdentity(e.state.servicePid));
      for (const identity of owned) if (identity && processMayBeAlive(identity)) process.kill(identity.pid, 'SIGTERM');
      await until(() => owned.every(x => !processMayBeAlive(x)), 'Owned test service exits', 15000);
    } finally { client.close(); }
  } catch (error) { console.error('Cleanup:', error.message); process.exitCode = 1; }
  server.closeAllConnections(); await new Promise(r => server.close(r));
});
