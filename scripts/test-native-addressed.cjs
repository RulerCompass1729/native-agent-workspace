const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
const { chooseRecipient: inlineRecipient, fillRoomMessage, roomBody } = require('./room-input.cjs');
// Real Electron + native Claude/Codex; fixed loopback responses exercise tool
// calls and transport, not model judgement. No paid inference or global settings.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), { execFileSync } = testScratch.childProcess;
const { _electron } = testScratch.playwright(require('playwright'));
const { executable, processIdentity, processMayBeAlive } = require('../app/platform.cjs');
const { connect } = require('../app/service-client.cjs');
const root = path.resolve(__dirname, '..'), base = testScratch.directory(path.join(os.tmpdir(), 'naw-native-addressed-'));
const profile = path.join(base, 'profile'), cwd = path.join(base, 'work');
const homes = { claude: path.join(base, 'claude'), codex: path.join(base, 'codex') };
for (const dir of [profile, cwd, ...Object.values(homes)]) fs.mkdirSync(dir, { mode: 0o700 });
const binaries = Object.fromEntries(['claude', 'codex'].map(p => [p, fs.realpathSync(executable(p))]));
const versions = Object.fromEntries(Object.entries(binaries).map(([p, file]) => [p, execFileSync(file, ['--version'], { encoding: 'utf8' }).trim()]));
const nativeVersion = process.env.NAW_CODEX_VERSION || '0.163.0';
assert.ok(['0.163.0','0.164.0'].includes(nativeVersion));
assert.match(versions.claude, /^2\.1\.(309|310)\b/); assert.equal(versions.codex, 'codex-cli ' + nativeVersion);
let app, page, ids = {}, held, release, sequence = 0;
const counts = { claude: 0, codex: 0 }, errors = [], checks = [];
let tokenCountRequests = 0;
const deny = process.env.NAW_TEST_NATIVE_DENY === '1';
const three = process.env.NAW_TEST_THREE_MEMBERS === '1';
const peer = process.env.NAW_TEST_PEER_DIRECTED === '1';
const longFinal = process.env.NAW_TEST_LONG_DIRECTED_FINAL === '1';
assert.ok(!(deny && three), 'Choose one native scenario');
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
    if (req.url.includes('count_tokens')) tokenCountRequests++;
    if (!provider) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":100,"data":[]}'); return; }
    const number = ++counts[provider], input = JSON.parse(body);
    fs.writeFileSync(path.join(base, `${provider}-${number}-request.json`), body);
    const schemas = JSON.stringify([...(input.tools || []), ...(input.input || []).filter(m => m.type === 'additional_tools').flatMap(m => m.tools || [])]);
    if (!(provider === 'claude' ? (input.tools || []).some(t => t.name === 'mcp__native_workspace__workspace_message' && t.input_schema?.properties?.recipient_id) : schemas.includes('workspace__workspace_message(args: {') && schemas.includes('recipient_id: string'))) { errors.push(`${provider} missing actual workspace tool schema`); res.writeHead(500); res.end(); return; }
    if (number > (three ? 5 : 4)) { res.writeHead(429); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (provider === 'claude') {
      assert.match(input.model, /haiku/);
      event(res, 'message_start', { message: { id: `msg_claude_${number}`, type: 'message', role: 'assistant', model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      if (three) {
        if (number === 1 || number === 3) {
          claudeBlock(res, 0, { type: 'text', text: number === 1 ? '方案：两份午餐 36 元，交通 14 元。先请另一位 Claude 核对材料。' : '材料核对完成：36 + 14。请 Codex 独立计算并给最初的 Claude 返回结果。' });
          claudeBlock(res, 1, { type: 'tool_use', id: `toolu_three_${number}`, name: 'mcp__native_workspace__workspace_message', input: { recipient_id: number === 1 ? ids.secondClaude : ids.codex, message: number === 1 ? '请核对材料：午餐合计36元、交通14元，然后交给Codex计算。' : '请计算36+14，并将核对结果送回第一位Claude。' } });
        } else {
          claudeBlock(res, 0, { type: 'text', text: number === 5 ? '三位完成：最终预算 50 元，材料与计算一致。' : '转交请求已登记，当前回复即将结束。' });
          if (number === 4) { held = res; await new Promise(r => { release = r; }); if (res.destroyed) return; }
        }
      } else if (number === 1) {
        claudeBlock(res, 0, { type: 'text', text: '预算草案：两份午餐各 18 元，交通共 14 元，总计 50 元。请 Codex 核查。\n' });
        claudeBlock(res, 1, { type: 'tool_use', id: 'toolu_addressed_budget', name: 'mcp__native_workspace__workspace_message', input: { recipient_id: ids.codex, message: '请独立核查预算：午餐 2×18，交通 14，总计是否为 50？请把核查结果发回给我。' } });
      } else claudeBlock(res, 0, { type: 'text', text: number === 2 ? longFinal ? 'LONG_HUMAN_FINAL_ONLY: ' + 'This answer stays with the human. '.repeat(400) : '已登记核查请求，等待本轮结束后转交。' : number === 3 ? '最终预算：50 元。两位 agent 已分别核查，结果一致。' : '脱出后的私人继续：保留 50 元预算，私人备注不共享。' });
      event(res, 'message_delta', { delta: { stop_reason: number === 1 || (three && number === 3) ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 30 } });
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
  await app.evaluate(({ clipboard }) => { globalThis.copiedText = []; clipboard.writeText = text => globalThis.copiedText.push(text); });
  page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
}
async function create(provider, key = provider) {
  const previous = new Set((await snapshot()).sessions.map(s => s.id));
  const created = async () => (await snapshot()).sessions.find(s => s.provider === provider && !previous.has(s.id));
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#session-name').fill(three ? '核查员' : provider === 'claude' ? '预算方案' : '预算核查'); await createIn(page, provider === 'claude' ? 'terminal' : 'chat');
  if (provider === 'claude') {
    await until(async () => /Yes, I trust this folder|Do you want to use this API key|Claude Code v2/.test(await page.locator('#terminal-area').innerText()) || (await created())?.chatAvailable, 'Native Claude startup');
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
    await until(async () => /Do you want to use this API key|Claude Code v2/.test(await page.locator('#terminal-area').innerText()) || (await created())?.chatAvailable, 'Native key choice');
    if ((await page.locator('#terminal-area').innerText()).includes('Do you want to use this API key')) { await page.locator('#terminal-area .xterm-screen').click(); await page.keyboard.press('ArrowUp'); await sleep(200); await page.keyboard.press('Enter'); }
  }
  await until(async () => { const s = await created(); return s?.state === 'idle' && s.chatAvailable && s.addressedSendAvailable; }, `${provider} addressed tool connected`, 60000);
  const s = await created(); ids[key] = s.id;
  await page.locator('#header-actions').getByRole('button', { name: '加入协作', exact: true }).click(); return s;
}
async function start(first, text) {
  const previousRun = (await snapshot()).room.run?.id;
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await inlineRecipient(page, first);
  await fillRoomMessage(page, text); await page.locator('#room-advanced summary').click(); await page.locator('#run-button').click();
  await page.locator('#run-mode').selectOption('directed');
  if (three) await page.locator(`[data-run-member="${ids.secondClaude}"]`).check();
  await page.locator('#run-limit').selectOption(three ? '4' : '3'); await page.locator('#run-consent').check(); await page.locator('#confirm-run').click();
  await until(async () => { const run = (await snapshot()).room.run; return run?.id && run.id !== previousRun; }, 'The authorized native round is visible');
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
  await launch(); const claude = await create('claude');
  if (peer) {
    await app.close(); app = null;
    const key = 'backends/' + 'd'.repeat(20); fs.mkdirSync(path.join(profile, key), { recursive: true, mode: 0o700 }); fs.chmodSync(path.join(profile, 'backends'), 0o700);
    fs.writeFileSync(path.join(profile, 'services.json'), JSON.stringify({ format: 1, active: '.', entries: ['.'], pending: key }), { mode: 0o600 });
    const shipped = process.env.NAW_APP_EXECUTABLE ? path.resolve(process.env.NAW_APP_EXECUTABLE, '../../Resources/app') : root;
    const previous = { NAW_APP_VERSION: process.env.NAW_APP_VERSION, NAW_RUNTIME_CONFIG: process.env.NAW_RUNTIME_CONFIG, NAW_WORKSPACE: process.env.NAW_WORKSPACE };
    try {
      Object.assign(process.env, { NAW_APP_VERSION: require(path.join(shipped, 'package.json')).version, NAW_RUNTIME_CONFIG: path.join(profile, 'runtime-locations.json'), NAW_WORKSPACE: cwd });
      await require(path.join(shipped, 'app/service-client.cjs')).ensureService(profile, process.env.NAW_APP_EXECUTABLE || require('electron'));
    } finally { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; }
    await launch();
  }
  const codex = await create('codex');
  if (peer) assert.equal(new Set((await snapshot()).sessions.map(s => s.handoffGroup)).size, 2);
  if (three) {
    const second = await create('claude', 'secondClaude');
    const identities = [claude, codex, second].map(s => [s.id, s.nativeId, s.pid]);
    for (const member of [claude, codex, second]) {
      const link = page.locator(`[data-session-id="${member.id}"]`);
      assert.ok((await link.innerText()).includes(member.id.slice(0, 6)), 'Same-name sidebar distinguishes native sessions');
      assert.ok((await link.getAttribute('aria-label')).includes(member.id.slice(0, 6)));
      assert.ok((await page.locator(`[data-session-menu="${member.id}"]`).getAttribute('aria-label')).includes(member.id.slice(0, 6)));
    }
    if (process.env.NAW_TEST_USAGE === '1') {
      await until(async () => (await snapshot()).sessions.filter(s => s.provider === 'claude').every(s => s.usage?.source === 'claude-session-usage'), 'Native Claude free metadata on startup');
      const before = { ...counts };
      await page.locator('#privacy-button').click(); await page.locator('#refresh-trust').click();
      assert.match(await page.locator('#trust-status').innerText(), /原生 \/cost 累计金额/);
      assert.match(await page.locator('#trust-status').innerText(), /不是账户实际账单/);
      await page.locator('#close-privacy').click(); assert.deepEqual(counts, before); assert.equal(tokenCountRequests, 0);
    }
    for (const member of [claude, second]) {
      await page.locator(`[data-session-menu="${member.id}"]`).click(); await page.getByRole('menuitem', { name: '脱出协作', exact: true }).click();
      await until(async () => !(await snapshot()).sessions.find(s => s.id === member.id).roomId, 'Independent same-name invite candidate');
    }
    await page.locator('#room-nav').click(); await page.locator('#room-record').click();
    for (const member of [claude, second]) {
      await page.getByRole('button', { name: '参与者…', exact: true }).click(); await page.locator('#invite-button').click();
      const invitation = page.locator(`[data-invite-session="${member.id}"]`);
      assert.ok((await invitation.innerText()).includes(member.id.slice(0, 6)), 'Invite target has exact same-name identity');
      await invitation.click();
      await until(async () => (await snapshot()).sessions.find(s => s.id === member.id).roomId === 'shared', 'Exact invite target rejoins');
    }
    await start(claude.id, '两份午餐各18元，交通14元。第一位Claude提出方案，第二位Claude核对材料，Codex计算后回给第一位Claude收尾。');
    await until(() => release, 'Third participant stages a handoff before interface closes');
    if (!peer) await until(async () => (await snapshot()).room.run?.pendingHandoff?.recipientId === codex.id, 'Third participant picks Codex');
    else assert.ok(JSON.stringify(JSON.parse(fs.readFileSync(path.join(base, 'claude-4-request.json'))).messages).includes('staged'), 'Native second Claude tool result confirms staging before completion');
    let state = await snapshot();
    assert.equal(state.room.run.steps, 1); assert.deepEqual(state.room.run.ids, [claude.id, codex.id, second.id]);
    assert.equal(counts.codex, 0, 'Chosen target skips the fixed order');
    assert.equal(state.room.run.awaiting.sessionId, second.id);
    await fillRoomMessage(page, '重新打开后保留的协作草稿'); await sleep(400);
    fs.writeFileSync(path.join(base, 'before-close.json'), JSON.stringify(await snapshot(), null, 2));
    await app.close(); app = null; release();
    await until(() => counts.claude === 5, 'Authorized native handoffs continue with interface closed');
    await launch();
    await until(async () => (await snapshot()).room.run?.status === 'completed', 'Shared task finishes');
    state = await snapshot();
    assert.equal(state.room.run.steps, 4); assert.equal(state.diagnostics.dispatches, 4);
    assert.deepEqual(state.sessions.map(s => [s.id, s.nativeId, s.pid]), identities);
    if (process.env.NAW_TEST_USAGE === '1') {
      await until(async () => (await snapshot()).sessions.filter(s => s.provider === 'claude').every(s => Number.isFinite(s.usage?.costUsd) && Number.isSafeInteger(s.usage?.context?.tokens)), 'Native Claude usage after the task');
      assert.ok((await snapshot()).sessions.find(s => s.provider === 'codex').usage?.total);
      assert.equal(tokenCountRequests, 0);
      await page.locator('#privacy-button').click(); await page.locator('#refresh-trust').click();
      assert.match(await page.locator('#trust-status').innerText(), /累计 token：输入/);
      if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'native-usage.png') }); }
      await page.locator('#close-privacy').click();
      checks.push('Native usage appears without token-count requests; viewing and refresh add no model responses');
    }
    const addressed = state.room.messages.filter(m => m.addressed);
    assert.deepEqual(addressed.map(m => [m.sessionId, m.deliveries[0].recipientId, m.deliveries[0].status]), [[claude.id, second.id, 'submitted'], [second.id, codex.id, 'submitted'], [codex.id, claude.id, 'submitted']]);
    assert.equal(await roomBody(page), '重新打开后保留的协作草稿');
    assert.match(await page.locator('#room-messages').innerText(), /三位完成：最终预算 50 元/);
    for (const message of state.room.messages.filter(m => m.sharedStream && m.role === 'system')) {
      assert.ok((await page.locator(`[data-message-id="${message.id}"] .message-heading`).innerText()).includes(message.sessionId.slice(0, 6)), 'Native turn notices identify their exact participant');
    }
    await page.getByRole('button', { name: '参与者…', exact: true }).click();
    for (const member of [claude, codex, second]) assert.ok((await page.locator(`[data-member-id="${member.id}"]`).innerText()).includes(member.id.slice(0, 6)));
    await page.locator('#close-members').click();
    const beforeCopy = await app.evaluate(() => globalThis.copiedText.length);
    await page.locator('#copy-timeline').click();
    await until(async () => await app.evaluate(() => globalThis.copiedText.length) === beforeCopy + 1, 'Fresh copy acknowledgement');
    const copied = await app.evaluate(() => globalThis.copiedText.at(-1));
    for (const member of [claude, codex, second]) assert.ok(copied.includes(member.id.slice(0, 6)), 'Copied shared record keeps source identities');
    await page.locator('#room-filter').selectOption(second.id);
    assert.match(await page.locator('#room-messages').innerText(), /材料核对完成/);
    assert.doesNotMatch(await page.locator('#room-messages').innerText(), /三位完成：最终预算/);
    await page.locator('#room-filter').selectOption('');
    await page.locator(`[data-session-id="${second.id}"]`).click(); await page.getByRole('button', { name: '脱出协作', exact: true }).click();
    await page.locator('#terminal-tab').click();
    await until(async () => (await page.locator('#terminal-area').innerText()).includes('材料核对完成'), 'Detached native TUI retains its own work');
    assert.deepEqual((await snapshot()).sessions.map(s => [s.id, s.nativeId, s.pid]), identities);
    await page.locator('#room-nav').click(); await page.locator('#room-record').click();
    assert.match(await page.locator('#room-messages').innerText(), /材料核对完成/);
    await page.locator(`[data-session-menu="${second.id}"]`).click(); await page.getByRole('menuitem', { name: '归档会话', exact: true }).click();
    await page.locator('#archive-button').click();
    assert.ok((await page.locator(`[data-archived-session="${second.id}"] strong`).innerText()).includes(second.id.slice(0, 6)));
    await page.locator(`[data-archived-session="${second.id}"]`).getByRole('button', { name: '恢复会话', exact: true }).click();
    await page.locator(`[data-session-menu="${second.id}"]`).click(); await page.getByRole('menuitem', { name: '重命名…', exact: true }).click();
    await page.locator('#rename-name').fill('材料核对'); await page.locator('#confirm-rename').click();
    await until(async () => (await page.locator(`[data-session-id="${second.id}"]`).getAttribute('aria-label')).includes('材料核对'), 'Rename propagates');
    assert.ok(!(await page.locator(`[data-session-id="${second.id}"]`).innerText()).includes(second.id.slice(0, 6)), 'Unique name stays compact');
    assert.deepEqual((await snapshot()).sessions.map(s => [s.id, s.nativeId, s.pid]), identities);
    await page.locator('#room-nav').click(); await page.locator('#room-record').click();
    assert.match(await page.locator('#room-messages').innerText(), /材料核对/);
    assert.deepEqual(counts, { claude: 5, codex: 2 }); assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(base, 'three-completed.json'), JSON.stringify(await snapshot(), null, 2));
    // Only these owned completed test sessions; native task permissions are not stubbed.
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async (_win, options) => {
      if (!['结束这个原生会话？', '移除此应用中的会话记录？'].includes(options.message)) throw Error('Unexpected confirmation');
      return { response: 1 };
    }; });
    for (const member of [claude, second]) {
      await page.locator(`[data-session-id="${member.id}"]`).click();
      if (!(await page.locator('#advanced').evaluate(el => el.open))) await page.locator('#advanced summary').click();
      await page.getByRole('button', { name: '结束这个原生会话…', exact: true }).click();
      await until(async () => (await snapshot()).sessions.find(s => s.id === member.id)?.state === 'ended', 'Owned native Claude exits');
      await page.getByRole('button', { name: '移除本应用记录…', exact: true }).click();
      await until(async () => !(await snapshot()).sessions.some(s => s.id === member.id), 'Owned session reference removed');
    }
    await page.locator('#room-nav').click(); await page.locator('#room-record').click();
    for (const message of state.room.messages.filter(m => m.sharedStream && [claude.id, second.id].includes(m.sessionId))) {
      assert.ok((await page.locator(`[data-message-id="${message.id}"] .message-heading`).innerText()).includes(message.sessionId.slice(0, 6)), 'Forgotten native row preserves exact author identity');
    }
    for (const message of addressed) {
      assert.ok((await page.locator(`[data-message-id="${message.id}"] .message-delivery summary`).innerText()).includes(message.deliveries[0].recipientId.slice(0, 6)) || message.deliveries[0].recipientId === codex.id, 'Forgotten recipient retains exact identity');
    }
    const beforeHistoryCopy = await app.evaluate(() => globalThis.copiedText.length);
    await page.locator('#copy-timeline').click();
    await until(async () => await app.evaluate(() => globalThis.copiedText.length) === beforeHistoryCopy + 1, 'Fresh historical copy acknowledgement');
    const historyCopy = await app.evaluate(() => globalThis.copiedText.at(-1));
    for (const member of [claude, second]) assert.ok(historyCopy.includes(member.id.slice(0, 6)), 'Copied history preserves removed authors');
    fs.writeFileSync(path.join(base, 'three-forgotten.json'), JSON.stringify(await snapshot(), null, 2));
    if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'three-native-addressed.png') }); }
    console.log(JSON.stringify({ versions, crossService: peer, checks: [...checks, 'Three same-name native participants route by ID instead of roster order', 'Authorized handoffs continue while the interface is closed', 'Reopening restores native identities, history and unsent draft without replay', 'Member filtering and departure preserve the original terminal and shared records', 'Same-name sidebar, menus, member dialog, native notices, copied history and archive show exact identity; rename restores compact labels', 'Removing ended local session references preserves shared author and recipient identities'], counts, paidModelCalls: 0, evidence: base }, null, 2));
    return;
  }
  const identities = [claude, codex].map(s => [s.id, s.nativeId, s.pid]);
  const nativeProcesses = { claude: claude.processIdentity, codex: codex.serverIdentity };
  for (const identity of Object.values(nativeProcesses)) assert.ok(identity && Number.isInteger(identity.pid) && identity.started && processMayBeAlive(identity), 'Initial native process identity is present and alive');
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
  if (longFinal) { assert.ok(state.room.messages.some(m => m.finalReply && m.text?.includes('LONG_HUMAN_FINAL_ONLY'))); assert.ok(!JSON.stringify(JSON.parse(fs.readFileSync(path.join(base, 'codex-1-request.json'))).input).includes('LONG_HUMAN_FINAL_ONLY')); }
  checks.push('Real native structured calls: Claude → Codex → Claude, exact recipient and receipt, one main reader');
  if (process.env.NAW_TEST_USAGE === '1') {
    await until(async () => (await snapshot()).sessions.find(s => s.id === codex.id).usage?.total?.inputTokens > 0, 'Native Codex token reading');
    const before = { ...counts };
    await fillRoomMessage(page, '用量查看期间保留的草稿'); await sleep(400);
    const recipient = (await snapshot()).viewState.roomRecipient;
    await page.locator('#usage-button').click();
    assert.equal(await page.locator('#privacy-dialog').getAttribute('data-mode'), 'usage');
    assert.equal(await page.locator('[data-usage-session]').count(), 2);
    assert.match(await page.locator(`[data-usage-session="${codex.id}"]`).innerText(), /累计 token：输入/);
    await page.locator('#refresh-trust').click(); await page.locator('#close-privacy').click();
    assert.equal(await roomBody(page), '用量查看期间保留的草稿');
    assert.equal((await snapshot()).viewState.roomRecipient, recipient);
    await page.locator(`[data-session-id="${codex.id}"]`).click(); await page.locator('#usage-button').click();
    assert.equal(await page.locator('[data-usage-session]').count(), 1);
    assert.equal(await page.locator('[data-usage-session]').getAttribute('data-usage-session'), codex.id);
    assert.match(await page.locator('#trust-status').innerText(), /本机读数时间/);
    if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'native-scoped-usage.png') }); }
    await page.locator('#close-privacy').click(); await page.locator('#room-nav').click(); await page.locator('#room-record').click();
    await fillRoomMessage(page, ''); assert.deepEqual(counts, before); assert.equal(tokenCountRequests, 0);
    checks.push('Actual native usage stays scoped to room or original session; refresh preserves draft/recipient with zero additional inference');
  }
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'addressed-budget.png') }); }
  await start(codex.id, '再做一次核查，但我会在转交前暂停。');
  await until(() => release, 'Native second task reaches held completion');
  if (!peer) await until(async () => (await snapshot()).room.run?.pendingHandoff, 'Native addressed intent staged');
  else assert.ok(JSON.stringify(JSON.parse(fs.readFileSync(path.join(base, 'codex-4-request.json'))).input).includes('staged'), 'Native peer tool result confirms staging');
  await page.locator('#pause-button').click(); release();
  await until(async () => (await snapshot()).sessions.find(s => s.id === codex.id).state === 'idle', 'Current native turn can finish after pause');
  assert.equal((await snapshot()).room.run.status, 'paused'); assert.equal(counts.claude, 3); assert.equal((await snapshot()).diagnostics.dispatches, 4);
  checks.push('Human pause revokes a staged message; no peer task starts');
  await page.locator(`[data-session-id="${claude.id}"]`).click(); await page.getByRole('button', { name: '脱出协作', exact: true }).click();
  const nativeClaude = page.locator(`[data-terminal-id="${claude.id}"]`);
  await page.locator('#terminal-tab').click(); await nativeClaude.waitFor({ state: 'visible' });
  await until(async () => (await nativeClaude.innerText()).includes('最终预算'), 'Same Claude terminal shows collaborative result');
  await nativeClaude.locator('.xterm-screen').click(); await page.keyboard.type('Continue privately with this budget.');
  await until(async () => (await nativeClaude.innerText()).includes('Continue privately with this budget.'), 'Native draft visible'); await page.keyboard.press('Enter');
  await until(async () => (await nativeClaude.innerText()).includes('脱出后的私人继续'), 'Private native continuation');
  await until(async () => (await snapshot()).sessions.find(s => s.id === claude.id).state === 'idle', 'Private turn finishes');
  assert.ok(!(await snapshot()).room.messages.some(m => m.text?.includes('私人备注')));
  checks.push('Detach and continue in the same native TUI; private continuation does not enter the room');
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await fillRoomMessage(page, '下一次的草稿，暂不发送。'); await sleep(400);
  const before = await snapshot();
  assert.deepEqual(before.sessions.map(s => [s.id, s.nativeId]), identities.map(([id, nativeId]) => [id, nativeId]));
  assert.deepEqual(before.sessions.find(s => s.id === claude.id).processIdentity, nativeProcesses.claude);
  assert.deepEqual(before.sessions.find(s => s.id === codex.id).serverIdentity, nativeProcesses.codex);
  fs.writeFileSync(path.join(base, 'before-reopen.json'), JSON.stringify(before, null, 2));
  await app.close(); app = null; await launch();
  await until(async () => (await snapshot()).sessions.length === 2, 'Original sessions reconnect');
  state = await snapshot();
  assert.deepEqual(state.sessions.map(s => [s.id, s.nativeId, s.pid, s.processIdentity, s.serverIdentity]), before.sessions.map(s => [s.id, s.nativeId, s.pid, s.processIdentity, s.serverIdentity]));
  assert.equal(state.room.run.status, 'paused'); assert.equal(state.diagnostics.dispatches, before.diagnostics.dispatches);
  assert.equal(await roomBody(page), '下一次的草稿，暂不发送。');
  assert.match(await page.locator('#room-messages').innerText(), /最终预算：50 元/);
  assert.deepEqual(counts, { claude: 4, codex: 4 }); assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(base, 'reopened.json'), JSON.stringify(state, null, 2));
  checks.push('Full application reopening preserves IDs/PIDs, room history and draft without replay');
  console.log(JSON.stringify({ versions, checks, counts, paidModelCalls: 0, evidence: base }, null, 2));
})().catch(async error => {
  if (page && !page.isClosed()) { fs.writeFileSync(path.join(base, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); fs.writeFileSync(path.join(base, 'failure.json'), JSON.stringify(await snapshot().catch(() => ({})), null, 2)); }
  console.error(error.stack, '\nEvidence:', base); process.exitCode = 1;
}).finally(testScratch.cleanup(async () => {
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
}));
