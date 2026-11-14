const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
const { joinSpace } = require('./fixtures/space-membership.cjs');
const { revealDefaultSpace } = require('./fixtures/default-space.cjs');
// Real Electron + real Claude CLI for space queues and session rotation; canned replies
// are served on loopback. No paid inference, user profile edits or foregrounding.
// Question: do the queue's idle, reply and rotation checks hold for a real native
// Claude session (message ids, Stop-hook background reports, create/join/stop)?
// Bounded: at most 2 native sessions and 12 local responses; stop at the first failure.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..');
const { connectService } = require('../app/service-client.cjs');
const { executable } = require('../app/platform.cjs');

const base = testScratch.directory(path.join(os.tmpdir(), 'naw-queue-native-'));
const profile = path.join(base, 'profile');
const cwd = path.join(base, 'work');
const config = path.join(base, 'claude');
for (const dir of [profile, cwd, config]) {
  fs.mkdirSync(dir, { mode: 0o700 });
}
// NAW_TEST_QUEUE_PROVIDER=codex runs the same checks against a real Codex CLI.
const PROVIDER = process.env.NAW_TEST_QUEUE_PROVIDER || 'claude';
// NAW_TEST_QUEUE_TRIGGER=memory rotates because the real process tree is above a lowered
// 100 MB memory limit, instead of because the conversation is above a lowered record limit.
const TRIGGER = process.env.NAW_TEST_QUEUE_TRIGGER || 'content';
const UNSENT = 'UNSENT_DRAFT_NAW';
assert.ok(['claude', 'codex'].includes(PROVIDER), 'claude or codex');
// NAW_TEST_QUEUE_PROFILE=1 (Codex only) makes the member a DeepSeek member: started from a Codex
// profile that names another model provider, as the person's DeepSeek pro / flash profiles do.
// The provider is a second path on the same loopback server with a synthetic key variable;
// no DeepSeek service and no real key are involved.
// The person's two are deepseek-pro and deepseek-flash; the dialog's default is pro, at effort max.
// NAW_TEST_QUEUE_LIVE=pro|flash instead runs one small item against the real DeepSeek service
// (paid; only when the person has allowed it): the test writes a provider table like the person's
// and copies only their model catalog; the key comes only from the inherited DEEPSEEK_API_KEY
// variable, whose presence is checked and whose value nothing here reads or prints.
const LIVE = process.env.NAW_TEST_QUEUE_LIVE || null;
assert.ok(!LIVE || ['pro', 'flash'].includes(LIVE), 'NAW_TEST_QUEUE_LIVE is pro or flash');
const PROFILE = LIVE ? 'naw-live-deepseek-pro' : process.env.NAW_TEST_QUEUE_PROFILE === '1' ? 'naw-fixture-deepseek-pro' : null;
const FLASH_PROFILE = LIVE ? 'naw-live-deepseek-flash' : 'naw-fixture-deepseek-flash';
const LIVE_PROFILE = LIVE === 'flash' ? FLASH_PROFILE : PROFILE;
// The member's first item has it call a native_workspace tool once, as a DeepSeek member would.
const WORKSPACE_CALL = 'naw_fixture_workspace_call_1';
// Codex members get native_workspace's workspace_control and workspace_message; the read-only catalog it is.
const CATALOG = JSON.stringify({ action: 'catalog' });
assert.ok(!PROFILE || PROVIDER === 'codex', 'A Codex profile is a Codex member');
assert.ok(!LIVE || process.env.DEEPSEEK_API_KEY, 'A live run needs DEEPSEEK_API_KEY in the environment (not read here)');
const codexHome = path.join(base, 'codex');
const defaultModelFile = path.join(base, 'default-model.txt');

// The Codex fixture's defaults; the test changes them before rotating.
function writeCodexConfig(model, effort) {
  const address = `http://127.0.0.1:${server.address().port}`;
  const text = [
    `model = "${model}"`,
    'model_provider = "local_fixture"',
    `model_reasoning_effort = "${effort}"`,
    '[model_providers.local_fixture]',
    'name = "Local fixture"',
    `base_url = "${address}/v1"`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    // The DeepSeek provider table's shape, on the same server; Codex sends the key variable's value.
    ...(LIVE ? ['[model_providers.deepseek]', 'name = "DeepSeek"', 'base_url = "https://api.deepseek.com"', 'env_key = "DEEPSEEK_API_KEY"', 'wire_api = "responses"']
      : PROFILE ? ['[model_providers.deepseek]', 'name = "DeepSeek fixture"', `base_url = "${address}/deepseek"`, 'env_key = "NAW_FIXTURE_DEEPSEEK_KEY"', 'wire_api = "responses"'] : []),
    // Like the person's daily folders: trusted, so a new native terminal starts without asking.
    `[projects."${fs.realpathSync(cwd)}"]`,
    'trust_level = "trusted"',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(codexHome, 'config.toml'), text, { mode: 0o600 });
}

// A synthetic model catalog with the fields Codex 0.168 requires (found by probing it), and the
// profile naming it, in the test's own CODEX_HOME. With the catalog Codex offers apply_patch and
// a 950000-token window; without it, neither.
function writeCodexProfile() {
  const catalog = path.join(codexHome, 'fixture-deepseek.models.json');
  const entry = slug => ({ slug, display_name: `Fixture ${slug}`, base_instructions: 'Fixture instructions.',
    supported_reasoning_levels: ['low', 'medium', 'high', 'max'].map(effort => ({ effort, description: effort })), shell_type: 'shell_command', visibility: 'list',
    supported_in_api: true, priority: 1, support_verbosity: false, truncation_policy: { mode: 'tokens', limit: 10000 }, experimental_supported_tools: [],
    apply_patch_tool_type: 'freeform', context_window: 1000000 });
  if (LIVE) {
    // The person's catalog (model descriptions only), copied into the test's own CODEX_HOME.
    fs.copyFileSync(path.join(os.homedir(), '.codex', 'deepseek.models.json'), catalog);
  } else {
    fs.writeFileSync(catalog, JSON.stringify({ models: [entry('deepseek-v4-pro'), entry('deepseek-v4-flash')] }), { mode: 0o600 });
  }
  // Like the person's: the pro profile names an effort, the flash one none.
  fs.writeFileSync(path.join(codexHome, `${PROFILE}.config.toml`), ['model = "deepseek-v4-pro"', 'model_provider = "deepseek"',
    `model_catalog_json = ${JSON.stringify(catalog)}`, 'model_reasoning_effort = "high"', ''].join('\n'), { mode: 0o600 });
  fs.writeFileSync(path.join(codexHome, `${FLASH_PROFILE}.config.toml`), ['model = "deepseek-v4-flash"', 'model_provider = "deepseek"',
    `model_catalog_json = ${JSON.stringify(catalog)}`, ''].join('\n'), { mode: 0o600 });
}

// The native_workspace tool Codex offers the thread, by its name in the request (a tool may sit in a namespace).
function workspaceTool(request, suffix) {
  for (const tool of request.tools || []) {
    if (typeof tool.name === 'string' && tool.name.endsWith(suffix)) {
      return { name: tool.name };
    }
    for (const child of Array.isArray(tool.tools) ? tool.tools : []) {
      if (typeof child.name === 'string' && child.name.endsWith(suffix)) {
        return { name: child.name, namespace: tool.name };
      }
    }
  }
  return null;
}

function codexToolCall(res, request, number, tool) {
  const response = { id: `resp_local_${number}`, object: 'response', status: 'in_progress', model: request.model, output: [], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
  const item = { type: 'function_call', id: `fc_local_${number}`, call_id: WORKSPACE_CALL, name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}), arguments: CATALOG, status: 'completed' };
  event(res, 'response.created', { response });
  event(res, 'response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', arguments: '' } });
  event(res, 'response.function_call_arguments.delta', { output_index: 0, item_id: item.id, delta: CATALOG });
  event(res, 'response.function_call_arguments.done', { output_index: 0, item_id: item.id, arguments: CATALOG });
  event(res, 'response.output_item.done', { output_index: 0, item });
  event(res, 'response.completed', { response: { ...response, status: 'completed', output: [item] } });
  res.end();
}
const workspaceCalls = [];
fs.mkdirSync(codexHome, { mode: 0o700 });
let binary;
if (PROVIDER === 'codex') {
  binary = fs.realpathSync(executable('codex'));
} else {
  binary = process.env.NAW_CLAUDE_BIN || executable('claude');
}
if (!binary) {
  throw Error('Real native CLI required');
}
const nativeVersion = testScratch.childProcess.execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
if (PROFILE) {
  // The thread configuration a profile becomes was measured on 0.168.0 only.
  assert.equal(nativeVersion, 'codex-cli 0.168.0', 'Codex profiles are verified on 0.168.0');
} else if (PROVIDER === 'codex') {
  assert.match(nativeVersion, /^codex-cli 0\.(164|165|166|167)\.\d+$/, 'A Codex version NAW supports');
} else {
  assert.match(nativeVersion, /^2\.1\.(307|308|309|310|311|316|317|318|319)\b/, 'A native version with verified chat sending');
}
// One more with a profile: the member's native_workspace call.
const RESPONSE_LIMIT = process.env.NAW_TEST_QUEUE_PROFILE === '1' ? 13 : 12;
let application;
let page;
let client;
let responses = 0;
let unexpected = null;
const errors = [];
const checks = [];
const prompts = [];
const timings = {};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, label, timeout = 90000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (unexpected) {
      throw unexpected;
    }
    if (await check()) {
      return Date.now() - started;
    }
    await sleep(200);
  }
  throw Error(label);
}

function event(res, type, body) {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`);
}

function lastCodexText(request) {
  const items = Array.isArray(request.input) ? request.input : [];
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.role !== 'user') {
      continue;
    }
    const parts = [];
    for (const part of item.content || []) {
      if (typeof part.text === 'string') {
        parts.push(part.text);
      }
    }
    return parts.join('\n');
  }
  return '';
}

function codexReply(res, request, number, reply) {
  const response = { id: `resp_local_${number}`, object: 'response', status: 'in_progress', model: request.model, output: [], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
  const item = { id: `msg_local_${number}`, type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: reply, annotations: [] }] };
  event(res, 'response.created', { response });
  event(res, 'response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
  event(res, 'response.content_part.added', { output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
  event(res, 'response.output_text.delta', { output_index: 0, item_id: item.id, content_index: 0, delta: reply });
  event(res, 'response.output_text.done', { output_index: 0, item_id: item.id, content_index: 0, text: reply });
  event(res, 'response.content_part.done', { output_index: 0, item_id: item.id, content_index: 0, part: item.content[0] });
  event(res, 'response.output_item.done', { output_index: 0, item });
  event(res, 'response.completed', { response: { ...response, status: 'completed', output: [item] } });
  res.end();
}

function lastUserText(request) {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'user') {
      continue;
    }
    if (typeof message.content === 'string') {
      return message.content;
    }
    const parts = [];
    for (const part of message.content || []) {
      if (part.type === 'text') {
        parts.push(part.text);
      }
    }
    return parts.join('\n');
  }
  return '';
}

function cannedReply(prompt) {
  if (prompt.includes('只写交接')) {
    return '交接：在 feature-x 分支，提交 abc1234，下一步跑全量测试。';
  }
  if (prompt.includes('你接手')) {
    return '已核对交接。';
  }
  const task = prompt.match(/QUEUE_TASK_(\d)/);
  if (task) {
    return `QUEUE_DONE_${task[1]}`;
  }
  return 'OK';
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', data => {
    body += data;
  });
  req.on('end', () => {
    if (req.url.endsWith('/responses') && req.method === 'POST') {
      responses += 1;
      if (responses > RESPONSE_LIMIT) {
        unexpected = Error('Local response budget exceeded');
        res.writeHead(429);
        res.end();
        return;
      }
      const request = JSON.parse(body);
      const prompt = lastCodexText(request);
      // A DeepSeek member's first item: one native_workspace call, then the reply once its output is back.
      const output = (request.input || []).find(item => item.call_id === WORKSPACE_CALL && /output/.test(item.type || ''));
      if (output) {
        workspaceCalls.push({ outputType: output.type, output: JSON.stringify(output.output ?? output.content ?? null).slice(0, 2000) });
      }
      const tool = PROFILE && /QUEUE_TASK_1/.test(prompt) && !output && !workspaceCalls.some(call => call.requested) ? workspaceTool(request, 'workspace_control') : null;
      if (PROFILE && /QUEUE_TASK_1/.test(prompt) && !output && !tool) {
        const names = (request.tools || []).map(entry => [entry.type, entry.name, ...(Array.isArray(entry.tools) ? entry.tools.map(child => child.name) : [])].filter(Boolean).join(':'));
        const extra = (request.input || []).filter(item => !['message', 'function_call', 'function_call_output', 'reasoning'].includes(item.type)).map(item => JSON.stringify(item).slice(0, 1500));
        workspaceCalls.push({ missing: true, names, extra, inputTypes: (request.input || []).map(item => item.type) });
      }
      if (tool) {
        workspaceCalls.push({ requested: tool });
        prompts.push({ model: request.model, prompt: prompt.slice(0, 160), reply: `call ${tool.name}`, path: req.url.split('?')[0], bearer: req.headers.authorization === 'Bearer local-fixture',
          effort: request.reasoning?.effort || null, applyPatch: (request.tools || []).some(entry => (entry.name || entry.type) === 'apply_patch'), workspaceTool: true });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        codexToolCall(res, request, responses, tool);
        return;
      }
      const reply = cannedReply(prompt);
      // Which provider path, whether the synthetic key came as a bearer, the effort, and the tools
      // the thread was offered (apply_patch only with the profile's catalog).
      const tools = (request.tools || []).map(tool => tool.name || tool.type);
      const offered = JSON.stringify([...(request.tools || []), ...(request.input || []).filter(item => item.type === 'additional_tools')]);
      prompts.push({ model: request.model, prompt: prompt.slice(0, 160), reply, path: req.url.split('?')[0], bearer: req.headers.authorization === 'Bearer local-fixture',
        effort: request.reasoning?.effort || null, applyPatch: tools.includes('apply_patch'), workspaceTool: offered.includes('workspace_message') });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      codexReply(res, request, responses, reply);
      return;
    }
    if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 100, data: [] }));
      return;
    }
    responses += 1;
    if (responses > RESPONSE_LIMIT) {
      unexpected = Error('Local response budget exceeded');
      res.writeHead(429);
      res.end();
      return;
    }
    const request = JSON.parse(body);
    const prompt = lastUserText(request);
    const reply = cannedReply(prompt);
    prompts.push({ model: request.model, prompt: prompt.slice(0, 160), reply });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    event(res, 'message_start', { message: { id: `msg_local_${responses}`, type: 'message', role: 'assistant', model: request.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    event(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    event(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: reply } });
    event(res, 'content_block_stop', { index: 0 });
    event(res, 'message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
    event(res, 'message_stop', {});
    res.end();
  });
});

const snapshot = () => client.call('initial');

async function shared() {
  const state = await page.evaluate(() => workspace.initial());
  return (state.rooms || [state.room]).find(room => room.id === 'shared');
}

async function itemByText(text) {
  const room = await shared();
  return (room.queue || []).find(item => item.text === text);
}

async function addItem(text, assignee = '') {
  if (!(await page.locator('#queue-dialog').isVisible())) {
    await page.locator('#room-queue').click();
    await page.locator('#queue-dialog').waitFor();
  }
  await page.locator('#queue-text').fill(text);
  await page.locator('#queue-assignee').selectOption(assignee);
  await page.locator('#add-queue').click();
  await until(async () => Boolean(await itemByText(text)), `Queued ${text}`, 10000);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function rssKb(pid) {
  try {
    return Number(testScratch.childProcess.execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim());
  } catch {
    return null;
  }
}

async function launch(extraEnv = {}) {
  let executablePath = require('electron');
  let args = [root];
  if (process.env.NAW_APP_EXECUTABLE) {
    executablePath = process.env.NAW_APP_EXECUTABLE;
    args = [];
  }
  const env = { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_QUEUE_HUMAN_QUIET_MS: '3000', ...extraEnv };
  // NAW reads a profile from the CODEX_HOME Codex uses: the test's own, never the person's.
  if (PROFILE) {
    env.CODEX_HOME = codexHome;
  }
  // Kept only for a live run, where Codex reads it itself as the provider table names it.
  if (!LIVE) {
    delete env.DEEPSEEK_API_KEY;
  }
  application = await _electron.launch({ executablePath, args, env, timeout: 70000 });
  page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('#new-session').waitFor();
}

async function openSpace() {
  await page.locator('#room-nav').click();
  await page.locator('#room-record').click();
}

// The live run's one item: a native_workspace call, a one-file commit, and the READY line.
const LIVE_TASK = 'DEEPSEEK_LIVE 小任务，只做这几步：1) 调用一次 native_workspace 的 workspace_control 工具，参数 {"action":"catalog"}（只读），看到结果即可；2) 在当前文件夹新建 live.txt，内容一行 DEEPSEEK_LIVE_OK；3) 在当前文件夹运行 git add live.txt 和 git commit -m "DeepSeek live check"；4) 结束本轮，按要求另起一行写 READY 行（当前分支名和这个提交号）。不做别的事。';
const LIVE_LIMIT_MS = 10 * 60 * 1000;
// What the test answers for the person in the member's terminal: exactly the task's own requests, namely
// the read-only catalog call, the edit of live.txt in the member's folder, and `git add live.txt` and
// the commit. Only the request itself is read (from its question to its first choice); anything else
// is refused and stops the run.
const LIVE_COMMANDS = ['git add live.txt', 'git commit -m "DeepSeek live check"', 'git add live.txt && git commit -m "DeepSeek live check"'];
function liveAnswer(screen, memberCwd) {
  const request = marker => {
    const lines = screen.slice(screen.lastIndexOf(marker) + marker.length).split('\n').map(line => line.trim());
    const end = lines.findIndex(line => /^(›\s*)?1\. /u.test(line));
    return end < 0 ? null : lines.slice(0, end).filter(Boolean);
  };
  if (screen.includes('Allow the native_workspace MCP server')) {
    const lines = request('Allow the native_workspace MCP server');
    return lines?.join('\n') === 'to run tool\n"workspace_control"?\naction: catalog' ? 'allow' : 'refuse';
  }
  if (screen.includes('Would you like to run the following command?')) {
    const lines = request('Would you like to run the following command?');
    const at = lines ? lines.findIndex(line => line.startsWith('$ ')) : -1;
    return at >= 0 && LIVE_COMMANDS.includes(lines.slice(at).join(' ').slice(2)) ? 'allow' : 'refuse';
  }
  if (screen.includes('Would you like to make the following edits?')) {
    const lines = request('Would you like to make the following edits?');
    const at = lines ? lines.indexOf('Destination:') : -1;
    const destination = at >= 0 ? lines.slice(at + 1).join('') : '';
    // macOS shows the temporary folder as /var or /private/var.
    const plain = file => file.replace(/^\/private\//u, '/');
    return [memberCwd, fs.realpathSync(memberCwd)].some(folder => plain(path.join(folder, 'live.txt')) === plain(destination)) ? 'allow' : 'refuse';
  }
  return 'refuse';
}

async function liveItem(first) {
  const memberCwd = (await snapshot()).sessions.find(s => s.id === first.id).cwd;
  const git = (...args) => testScratch.childProcess.execFileSync('git', args, { cwd: memberCwd, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'naw-live');
  git('config', 'user.name', 'NAW live test');
  git('config', 'user.email', 'naw-live@example.invalid');
  git('commit', '-q', '--allow-empty', '-m', 'start');
  const evidence = process.env.NAW_EVIDENCE_DIR;
  if (evidence) {
    fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
  }
  const rows = () => page.locator('#terminal-area .xterm-rows').innerText();
  const approvals = [];
  let terminalOpen = false;
  const queuedAt = Date.now();
  await addItem(LIVE_TASK);
  for (;;) {
    const item = await itemByText(LIVE_TASK);
    if (item && !['queued', 'sent'].includes(item.status)) {
      break;
    }
    if (Date.now() - queuedAt > LIVE_LIMIT_MS) {
      throw Error('The live item did not settle within 10 minutes');
    }
    const member = (await snapshot()).sessions.find(s => s.id === first.id);
    if (member.state !== 'approval') {
      await sleep(1000);
      continue;
    }
    if (!terminalOpen) {
      if (await page.locator('#queue-dialog').isVisible()) {
        await page.locator('#close-queue').click();
      }
      await page.locator(`[data-session-id="${first.id}"]`).first().click();
      await page.locator('#terminal-tab').click();
      await page.locator('#terminal-area .xterm-screen').waitFor();
      terminalOpen = true;
    }
    await until(async () => /Trust this folder|Allow the native_workspace MCP server|Would you like to/u.test(await rows()), 'The native request is on screen', 45000);
    await page.locator('#terminal-area .xterm-screen').click();
    if (/Trust this folder/u.test(await rows())) {
      // A new session folder is not yet trusted by Codex: answered as the person would, like their daily folders.
      await page.keyboard.press('Enter');
      await until(async () => !/Trust this folder/u.test(await rows()), 'Native folder trust answered', 30000);
      continue;
    }
    const screen = await rows();
    const answer = liveAnswer(screen, memberCwd);
    approvals.push({ method: member.approval?.method || null, answer });
    if (evidence) {
      fs.writeFileSync(path.join(evidence, `approval-${approvals.length}.txt`), `${member.approval?.method}\n${answer}\n\n${screen}`, { mode: 0o600 });
    }
    if (answer !== 'allow') {
      await page.keyboard.press('Escape');
      throw Error(`Live run stopped: the member asked for something outside the task (${member.approval?.method})`);
    }
    await page.keyboard.press('Enter');
    await until(async () => (await snapshot()).sessions.find(s => s.id === first.id).state !== 'approval' || await rows() !== screen, 'The member goes on after the answer', 30000);
  }
  timings.liveSettledMs = Date.now() - queuedAt;
  const item = await itemByText(LIVE_TASK);
  const member = (await snapshot()).sessions.find(s => s.id === first.id);
  const head = git('rev-parse', 'HEAD');
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  const file = fs.existsSync(path.join(memberCwd, 'live.txt')) ? fs.readFileSync(path.join(memberCwd, 'live.txt'), 'utf8') : null;
  // Each model response leaves one token_count event with usage in the native rollout.
  const rollouts = [];
  const walk = dir => {
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else if (/^rollout-.*\.jsonl$/.test(entry.name)) rollouts.push(path.join(dir, entry.name));
    }
  };
  walk(path.join(codexHome, 'sessions'));
  let modelResponses = 0;
  let rolloutUsage = null;
  for (const file of rollouts) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      try {
        const payload = JSON.parse(line).payload;
        if (payload?.type === 'token_count' && payload.info) {
          modelResponses += 1;
          rolloutUsage = payload.info.total_token_usage;
        }
      } catch {}
    }
  }
  if (evidence) {
    fs.writeFileSync(path.join(evidence, 'live-member.json'), JSON.stringify(member, null, 2), { mode: 0o600 });
    await page.screenshot({ path: path.join(evidence, 'live-done.png') });
  }
  const result = { live: LIVE, model: member.model, vendor: member.vendor, shell: member.shell, requested: member.requestedSettings, nativeVersion,
    item: { status: item.status, reason: item.reason || '', reply: item.reply, ready: item.ready || null }, git: { branch, head, file, log: git('log', '--format=%s', '-3') },
    approvals, timings, modelResponses, rollouts: rollouts.length, usage: member.usage || null, rolloutUsage, localResponses: responses, evidence: base };
  console.log(JSON.stringify(result));
  assert.equal(approvals.filter(entry => entry.method === 'mcpServer/elicitation/request').length >= 1, true, 'The member called the workspace tool');
  assert.equal(file?.trim(), 'DEEPSEEK_LIVE_OK', 'The member wrote the file');
  assert.deepEqual(item.ready && { branch: item.ready.branch, commit: head.startsWith(item.ready.commit) }, { branch, commit: true }, 'The READY line names the branch and its head commit');
  assert.deepEqual(errors, []);
}

async function cleanup() {
  if (application) {
    await application.close().catch(() => {});
  }
  if (client) {
    try {
      for (const session of (await snapshot()).sessions) {
        if (session.state !== 'ended') {
          await client.call('stop', session.id);
        }
      }
      // A stop returns before the native process has ended. A stopped Codex session stays loaded in
      // the shared Codex service ('disconnected'), and the service will not shut down under it;
      // the test scratch then ends the service it owns.
      const open = async closed => (await snapshot()).sessions.filter(session => !closed.includes(session.state));
      const deadline = Date.now() + 10000;
      while ((await open(['ended', 'background', 'disconnected'])).length && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      try {
        await client.call('shutdown');
      } catch (error) {
        const left = await open(['ended', 'background']);
        if (!left.every(session => session.provider === 'codex' && session.state === 'disconnected')) {
          console.error('Sessions still open at cleanup:', JSON.stringify(left.map(session => ({ id: session.id, provider: session.provider, state: session.state }))));
          throw error;
        }
      }
    } finally {
      client.close();
    }
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const shim = path.join(base, 'claude-local');
  const fakeBin = path.join(base, 'bin');
  fs.mkdirSync(fakeBin, { mode: 0o700 });
  fs.writeFileSync(path.join(fakeBin, 'pbcopy'), `#!/bin/sh\ncat > "${base}/pbcopy-$$.txt"\n`, { mode: 0o700 });
  fs.writeFileSync(defaultModelFile, 'haiku\n', { mode: 0o600 });
  const shimSource = [
    '#!/usr/bin/python3',
    'import os,sys',
    'os.environ.pop("ANTHROPIC_AUTH_TOKEN",None)',
    'os.environ.pop("CLAUDE_CODE_OAUTH_TOKEN",None)',
    `os.environ.update(ANTHROPIC_BASE_URL=${JSON.stringify(`http://127.0.0.1:${server.address().port}`)},ANTHROPIC_API_KEY="local-fixture",CLAUDE_CONFIG_DIR=${JSON.stringify(config)},CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1",PATH=${JSON.stringify(fakeBin)}+":"+os.environ.get("PATH",""))`,
    // The default model comes from a file the test changes before rotating; NAW's own --model wins.
    `default_model=open(${JSON.stringify(defaultModelFile)}).read().strip()`,
    'args=sys.argv[1:]',
    'args=args if "--model" in args else args+["--model",default_model]',
    `os.execv(${JSON.stringify(binary)},["claude"]+args)`,
    '',
  ].join('\n');
  fs.writeFileSync(shim, shimSource, { mode: 0o700 });
  const trusted = {};
  trusted[fs.realpathSync(cwd)] = { hasTrustDialogAccepted: true };
  trusted[fs.realpathSync(cwd) + '-sessions'] = { hasTrustDialogAccepted: true };
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: trusted }), { mode: 0o600 });
  writeCodexConfig('gpt-6-luna', 'low');
  if (PROFILE) {
    writeCodexProfile();
  }
  const codexShim = path.join(base, 'codex-local');
  const codexShimSource = [
    '#!/usr/bin/python3',
    'import os,sys',
    // Removed unread: the fixture provider's key is a synthetic variable.
    `for key in ["OPENAI_API_KEY","CODEX_API_KEY"${LIVE ? '' : ',"DEEPSEEK_API_KEY"'}]: os.environ.pop(key,None)`,
    `os.environ.update(CODEX_HOME=${JSON.stringify(codexHome)},NAW_FIXTURE_DEEPSEEK_KEY="local-fixture")`,
    `os.execv(${JSON.stringify(binary)},["codex"]+sys.argv[1:])`,
    '',
  ].join('\n');
  fs.writeFileSync(codexShim, codexShimSource, { mode: 0o700 });
  const locations = {};
  if (PROVIDER === 'codex') {
    locations.codex = codexShim;
  } else {
    locations.claude = shim;
  }
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify(locations), { mode: 0o600 });

  await launch();
  client = await connectService(profile, 'queue-native-test');
  await revealDefaultSpace(page);
  if (PROFILE) {
    // The person's way: the new-session dialog offers DeepSeek when a profile names it, pro by default.
    await page.locator('#new-session').click();
    await page.locator('#deepseek-provider').waitFor();
    assert.equal(await page.locator('#create-profile').isVisible(), false, 'The DeepSeek model is asked only for DeepSeek');
    await page.locator('input[name="provider"][value="deepseek"]').check();
    await page.locator('#create-profile').waitFor();
    assert.deepEqual(await page.locator('#create-profile option').allInnerTexts(), ['deepseek-v4-flash', 'deepseek-v4-pro']);
    assert.equal(await page.locator('#create-profile').inputValue(), PROFILE, 'pro is the default');
    if (LIVE === 'flash') {
      await page.locator('#create-profile').selectOption(FLASH_PROFILE);
    }
    await page.locator('#session-name').fill('实测甲');
    if (process.env.NAW_EVIDENCE_DIR) {
      fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true, mode: 0o700 });
      await page.locator('#create-dialog').screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'create-deepseek.png') });
    }
    await createIn(page, 'chat');
    checks.push('The new-session dialog offers DeepSeek from the Codex profiles, pro by default and flash as a choice');
  } else {
    await page.locator('#new-session').click();
    await page.locator(`input[name="provider"][value="${PROVIDER}"]`).check();
    await page.locator('#session-name').fill('实测甲');
    if (PROVIDER === 'codex') {
      await createIn(page, 'chat');
    } else {
      await createIn(page, 'terminal');
    }
  }
  // A fresh test config asks once to trust the folder and once to use the local key.
  const terminalText = () => page.locator('#terminal-area').innerText();
  const ready = async () => (await snapshot()).sessions.some(s => s.name === '实测甲' && s.chatAvailable);
  if (PROVIDER === 'claude') {
  await until(async () => /Yes, I trust this folder|Do you want to use this API key/.test(await terminalText()) || await ready(), 'Native startup');
  if ((await terminalText()).includes('Yes, I trust this folder')) {
    // The same keys test-native-blocks.cjs uses for this native dialog.
    await page.locator('#terminal-area .xterm-screen').click();
    await page.keyboard.press('ArrowDown');
    await sleep(200);
    await page.keyboard.press('Enter');
  }
  await until(async () => (await terminalText()).includes('Do you want to use this API key') || await ready(), 'Native key prompt');
  if ((await terminalText()).includes('Do you want to use this API key')) {
    await page.locator('#terminal-area .xterm-screen').click();
    await page.keyboard.press('ArrowUp');
    await sleep(200);
    await page.keyboard.press('Enter');
  }
  }
  await until(async () => (await snapshot()).sessions.some(s => s.name === '实测甲' && s.state === 'idle' && s.chatAvailable), 'Native session ready', 120000);
  if (await page.locator('#chat-tab').isVisible()) {
    await page.locator('#chat-tab').click();
  }
  await joinSpace(page);
  const first = (await snapshot()).sessions.find(s => s.name === '实测甲');
  await openSpace();
  checks.push(`Real native session ready (${nativeVersion})`);
  if (PROFILE) {
    assert.deepEqual({ vendor: first.vendor, shell: first.shell, modelProvider: first.modelProvider, model: first.model, requested: first.requestedSettings },
      { vendor: 'deepseek', shell: 'codex', modelProvider: 'deepseek', model: LIVE === 'flash' ? 'deepseek-v4-flash' : 'deepseek-v4-pro', requested: { effort: 'max', profile: LIVE_PROFILE || PROFILE } });
    checks.push('A member started from a Codex profile is recorded as vendor deepseek in shell codex, on the profile\'s model at effort max');
  }

  if (LIVE) {
    await liveItem(first);
    return;
  }

  // 1) A real idle native session receives the queued item through NAW's own send path.
  const queuedAt = Date.now();
  await addItem('QUEUE_TASK_1 请只回复完成标记');
  timings.firstDispatchMs = await until(async () => (await itemByText('QUEUE_TASK_1 请只回复完成标记')).status !== 'queued', 'First item sent');
  if (PROFILE) {
    // Codex asks before an MCP tool runs in a session without skipped permissions, as for any Codex member. The
    // person answers in the member's native terminal; NAW's own buttons only cover command and file requests.
    await until(async () => (await snapshot()).sessions.find(s => s.id === first.id).state === 'approval', 'The member asks before the workspace tool runs');
    const asking = (await snapshot()).sessions.find(s => s.id === first.id);
    if (await page.locator('#queue-dialog').isVisible()) await page.locator('#close-queue').click();
    await page.locator(`[data-session-id="${first.id}"]`).first().click();
    await page.locator('#terminal-tab').click();
    await page.locator('#terminal-area .xterm-screen').waitFor();
    const rows = () => page.locator('#terminal-area .xterm-rows').innerText();
    // A new session folder is not yet trusted by Codex: answered as the person would, like their daily folders.
    await until(async () => /Trust this folder|workspace_control/u.test(await rows()), 'The native terminal opens', 45000);
    if (/Trust this folder/u.test(await rows())) {
      await page.locator('#terminal-area .xterm-screen').click();
      await page.keyboard.press('Enter');
      await until(async () => !/Trust this folder/u.test(await rows()), 'Native folder trust answered', 30000);
    }
    await until(async () => /workspace_control/.test(await rows()), 'The native terminal shows the workspace tool request', 45000);
    const asked = await rows();
    if (process.env.NAW_EVIDENCE_DIR) {
      fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(process.env.NAW_EVIDENCE_DIR, 'tool-approval.txt'), `${asking.approval?.method}\n\n${asked}`);
      await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'tool-approval.png') });
    }
    // Only this one read-only catalog call is allowed, once: the first option, whatever its wording.
    await page.locator('#terminal-area .xterm-screen').click();
    await page.keyboard.press('Enter');
    await until(async () => (await snapshot()).sessions.find(s => s.id === first.id).state !== 'approval', 'The member goes on after the person allows the call');
    checks.push(`The member asked before the workspace tool ran (${asking.approval?.method}); allowed once in its native terminal`);
    await openSpace();
  }
  // The person answered in the member's terminal, so NAW settles the item as one the person stepped into: open for
  // them to look at, without holding the member (queue-dispatch UNHELD_WAITING). That is NAW's rule for any member.
  const firstSettled = item => PROFILE ? item.status === 'waiting' && item.reason === 'person-intervened' : item.status === 'done';
  timings.firstDoneMs = await until(async () => firstSettled(await itemByText('QUEUE_TASK_1 请只回复完成标记')), 'First item done') + timings.firstDispatchMs;
  if (PROFILE) assert.equal((await itemByText('QUEUE_TASK_1 请只回复完成标记')).reply, 'QUEUE_DONE_1', 'The item keeps the member\'s reply');
  const afterFirst = (await snapshot()).sessions.find(s => s.id === first.id);
  const sentMessage = afterFirst.messages.find(m => m.role === 'user' && typeof m.text === 'string' && m.text.includes('【NAW 派活】'));
  assert.ok(sentMessage, 'The NAW message is in the native session record');
  assert.ok(afterFirst.messages.some(m => m.role === 'assistant' && m.text === 'QUEUE_DONE_1'), 'The native reply is in the record');
  checks.push(`A real native session got the queued item and ${PROFILE ? 'replied (settled as one the person stepped into, member not held)' : 'finished it'} (sent ${timings.firstDispatchMs} ms, settled ${Date.now() - queuedAt} ms after queuing)`);
  if (PROFILE) {
    const requested = workspaceCalls.find(call => call.requested), returned = workspaceCalls.find(call => call.output);
    assert.ok(requested, `Codex offered the DeepSeek member native_workspace's workspace_control: ${JSON.stringify(workspaceCalls).slice(0, 4000)}`);
    assert.ok(returned && returned.output.includes('archiveRoom'), `The catalog came back to the model: ${JSON.stringify(workspaceCalls).slice(0, 2000)}`);
    checks.push(`The DeepSeek member called native_workspace ${requested.requested.namespace || ''} ${requested.requested.name} (catalog) and the catalog went back to the model before the reply`);
  }

  // 2) With the member's real terminal open and left alone, the next item still arrives.
  if (await page.locator('#queue-dialog').isVisible()) {
    await page.locator('#close-queue').click();
    await page.locator('#queue-dialog').waitFor({ state: 'hidden' });
  }
  await page.locator(`#session-list .session-link[data-session-id="${first.id}"]`).click();
  await page.locator('#terminal-tab').click();
  await page.locator('#terminal-area .xterm-screen').waitFor();
  await page.evaluate(text => workspace.spaceAction('shared', 'queueAdd', [text, null]), 'QUEUE_TASK_2 请只回复完成标记');
  timings.terminalOpenDoneMs = await until(async () => (await itemByText('QUEUE_TASK_2 请只回复完成标记')).status === 'done', 'Second item done with the terminal open');
  checks.push(`The next item followed with the member's native terminal open and idle (${timings.terminalOpenDoneMs} ms)`);
  // The person types into the native prompt and leaves it unsent; NAW cannot see that text.
  // A new session folder is not yet trusted by Codex: answer as the person would, like their daily folders.
  await page.locator('#terminal-area .xterm-screen').click();
  const screenText = () => page.locator('#terminal-area .xterm-rows').innerText();
  if (/Trust this folder/u.test(await screenText())) {
    await page.keyboard.press('Enter');
    await until(async () => !/Trust this folder/u.test(await screenText()), 'Native folder trust answered', 30000);
    await sleep(2000);
  }
  await page.keyboard.type(UNSENT, { delay: 30 });
  await until(async () => (await screenText()).includes(UNSENT), 'Unsent text visible in the native prompt', 20000);
  await until(async () => (await snapshot()).sessions.find(s => s.id === first.id).terminalInputPending === true, 'Terminal input recorded as possibly unsent', 20000);
  await openSpace();

  // 3) Rotation: the old session writes a handoff, a new session continues, the old process exits.
  // A memory rotation needs a session at least three minutes old here: the old one is, while
  // the new one gets its first item well inside that, so it is not replaced again.
  let minimumAge = 0;
  if (TRIGGER === 'memory') {
    minimumAge = 181000;
  }
  const age = Date.now() - first.createdAt;
  if (age < minimumAge) {
    await sleep(minimumAge - age);
  }
  await application.close();
  application = null;
  // From here the providers' defaults differ from what the old session started with, so the
  // successor matches the old session only if NAW carried its settings.
  if (PROVIDER === 'claude') {
    fs.writeFileSync(defaultModelFile, 'sonnet\n');
  } else {
    writeCodexConfig('gpt-6-nova', 'medium');
  }
  if (TRIGGER === 'memory') {
    await launch({ NAW_TEST_QUEUE_MEMORY_MB: '100', NAW_TEST_QUEUE_MEMORY_MIN_AGE_MS: '180000' });
  } else {
    await launch({ NAW_TEST_QUEUE_CONTENT_LIMIT: '2' });
  }
  await openSpace();
  const old = (await snapshot()).sessions.find(s => s.id === first.id);
  const oldSettings = { model: old.model, effort: old.nativeSettings ? old.nativeSettings.effort : old.nativeEffort, view: old.view };
  const oldPid = old.pid;
  const oldRss = rssKb(oldPid);
  if (PROVIDER === 'claude') {
    assert.ok(oldPid && pidAlive(oldPid), 'The old native process is running before rotation');
  }
  await addItem('QUEUE_TASK_3 请只回复完成标记', first.id);
  const logPath = path.join(profile, 'rotation-log.jsonl');
  const logEntries = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
  if (PROVIDER === 'claude') {
    // Claude refuses NAW's request while its prompt holds the unsent text: nothing starts, nothing fails.
    await sleep(15000);
    assert.equal(logEntries().length, 0, 'No rotation starts or fails while the native prompt holds unsent text');
    assert.equal((await snapshot()).sessions.some(s => s.name === '实测甲 · 续'), false);
    checks.push('With text typed but not sent in the native prompt, no rotation started and none was recorded as failed');
    // The person clears the prompt; the rotation then proceeds on its own.
    if (await page.locator('#queue-dialog').isVisible()) {
      await page.locator('#close-queue').click();
      await page.locator('#queue-dialog').waitFor({ state: 'hidden' });
    }
    await page.locator(`#session-list .session-link[data-session-id="${first.id}"]`).click();
    await page.locator('#terminal-tab').click();
    await page.locator('#terminal-area .xterm-screen').waitFor();
    await page.locator('#terminal-area .xterm-screen').click();
    for (let n = 0; n < UNSENT.length + 2; n += 1) {
      await page.keyboard.press('Backspace');
    }
    await openSpace();
  }
  await until(async () => (await snapshot()).sessions.some(s => s.name === '实测甲 · 续'), 'New native session created', 120000);
  await until(async () => (await snapshot()).sessions.find(s => s.id === first.id).state === 'ended', 'Old native session ended', 120000);
  if (PROVIDER === 'claude') {
    await until(() => !pidAlive(oldPid), 'Old native process exited', 30000);
  }
  const fresh = (await snapshot()).sessions.find(s => s.name === '实测甲 · 续');
  assert.ok(fresh.messages.some(m => m.role === 'user' && typeof m.text === 'string' && m.text.includes('feature-x 分支')), 'The handoff reached the new native session');
  const ended = (await snapshot()).sessions.find(s => s.id === first.id);
  const request = ended.messages.find(m => m.role === 'user' && typeof m.text === 'string' && m.text.startsWith('【NAW 换会话】'));
  assert.ok(request, 'The old session received the handoff request');
  const log = fs.readFileSync(path.join(profile, 'rotation-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const requested = log.find(entry => entry.event === 'requested' && entry.old.id === first.id);
  assert.ok(requested, 'The rotation log records the request');
  assert.equal(requested.reason, TRIGGER);
  assert.equal(request.text.includes(UNSENT), false, 'NAW\'s handoff request does not carry the unsent text');
  const finished = log.find(entry => entry.event === 'done' && entry.old.id === first.id);
  assert.ok(finished, 'The rotation finished');
  // The person, 11-12: the replaced session leaves the list of sessions for 归档, where it can be restored.
  // The archive follows the done line: read the log again until it is there.
  const rotationLog = () => fs.readFileSync(path.join(profile, 'rotation-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  await until(() => rotationLog().some(entry => entry.event === 'archived' && entry.old.id === first.id), 'The rotation log records the archive', 30000);
  const archivedLog = rotationLog();
  assert.ok(archivedLog.findIndex(entry => entry.event === 'archived' && entry.old.id === first.id) > archivedLog.findIndex(entry => entry.event === 'done' && entry.old.id === first.id), 'after the done rotation');
  await until(async () => (await page.evaluate(() => workspace.initial())).sessions.find(s => s.id === first.id)?.archived === true, 'The old session is archived in the window', 30000);
  // 归档 is collapsed by default: open it the way the person does, then read it. The queue
  // dialog is still open on the Codex path (only the Claude path closed it above).
  if (await page.locator('#queue-dialog').isVisible()) {
    await page.locator('#close-queue').click();
    await page.locator('#queue-dialog').waitFor({ state: 'hidden' });
  }
  if (await page.locator('#archive-button').getAttribute('aria-expanded') !== 'true') await page.locator('#archive-button').click();
  await page.locator('#archive-group-body').waitFor();
  await until(async () => (await page.locator('#archive-list').innerText()).includes('实测甲'), 'The old session is listed under 归档', 30000);
  assert.equal(await page.locator(`#session-list [data-session-id="${first.id}"]`).count(), 0, 'It is no longer among the sessions');
  if (process.env.NAW_EVIDENCE_DIR) {
    fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'rotation-archived.png') });
  }
  const spaceEvents = (await page.evaluate(() => workspace.initial())).rooms.flatMap(room => room.events || []);
  assert.ok(spaceEvents.some(event => event.uiMessage?.key === 'notice.rotation.archived'), 'The space says the replaced session was archived');
  checks.push('The replaced session was archived: off the list of sessions, under 归档, said in the space');
  if (finished.terminal) {
    // A live terminal was typed into: its last screen is kept before the session ends.
    const savedScreen = fs.readFileSync(path.join(profile, finished.terminal), 'utf8');
    if (PROVIDER === 'claude') {
      assert.equal(savedScreen.includes(UNSENT), false, 'The cleared prompt is not in the saved screen');
    } else {
      assert.ok(savedScreen.includes(UNSENT), 'The saved screen holds the text typed but not sent');
    }
    assert.equal(/Trust this folder/u.test(savedScreen), false, 'No terminal was reopened to read it');
    checks.push(`Last terminal screen kept before the old session ended: ${finished.terminal}`);
  } else {
    assert.equal(PROVIDER, 'codex', 'A live Claude terminal is always saved');
    checks.push('The Codex terminal was no longer open: nothing unsent remained and none was reopened');
  }
  if (TRIGGER === 'memory') {
    const measured = /已占用约 ([\d.]+) GB 内存/u.exec(request.text);
    assert.ok(measured && Number(measured[1]) >= 0.1, 'The request names the measured footprint of the real process tree');
    checks.push(`Memory trigger: the real ${PROVIDER} process tree measured about ${measured[1]} GB against a 100 MB test limit`);
  }
  await until(async () => (await itemByText('QUEUE_TASK_3 请只回复完成标记')).status === 'done', 'Third item done by the new session', 120000);
  const done = await itemByText('QUEUE_TASK_3 请只回复完成标记');
  assert.equal(done.sentTo, fresh.id);
  const freshRss = rssKb((await snapshot()).sessions.find(s => s.id === fresh.id).pid);
  checks.push(`Rotation: handoff written, new session continued, old process ${oldPid} exited (old ${oldRss} KB, new ${freshRss} KB)`);

  const successor = (await snapshot()).sessions.find(s => s.id === fresh.id);
  const successorSettings = { model: successor.model, effort: successor.nativeSettings ? successor.nativeSettings.effort : successor.nativeEffort, view: successor.view };
  assert.equal(successorSettings.model, oldSettings.model, 'The successor runs the old model, not the changed default');
  let expectedView = oldSettings.view;
  if (PROVIDER === 'codex') {
    expectedView = 'chat';
  }
  assert.equal(successorSettings.view, expectedView, 'Claude keeps the old view; a Codex successor starts in chat view');
  if (PROVIDER === 'codex') {
    assert.equal(successorSettings.effort, oldSettings.effort, 'The successor keeps the old reasoning effort');
  }
  checks.push(`Successor settings carried against a changed default: old ${JSON.stringify(oldSettings)}, new ${JSON.stringify(successorSettings)}`);
  if (PROFILE) {
    assert.deepEqual({ vendor: successor.vendor, modelProvider: successor.modelProvider, profile: successor.requestedSettings?.profile },
      { vendor: 'deepseek', modelProvider: 'deepseek', profile: PROFILE }, 'The successor is a DeepSeek member from the same profile');
    for (const session of [ended, successor]) {
      assert.equal(session.usage?.modelContextWindow, 950000, 'The catalog\'s context window, after the old session\'s terminal and the successor\'s start');
    }
    checks.push('The successor runs from the same profile on DeepSeek; both report the catalog\'s 950000-token window');
  }
  for (const prompt of prompts) {
    if (PROVIDER === 'claude') {
      assert.match(prompt.model, /haiku/i);
    } else if (PROFILE) {
      assert.deepEqual({ path: prompt.path, model: prompt.model, bearer: prompt.bearer, effort: prompt.effort, applyPatch: prompt.applyPatch },
        { path: '/deepseek/responses', model: 'deepseek-v4-pro', bearer: true, effort: 'max', applyPatch: true }, `Every request went to the DeepSeek provider with the profile at effort max: ${prompt.prompt}`);
    } else {
      assert.equal(prompt.model, 'gpt-6-luna', 'Every request, the successor\'s too, used the old model');
    }
  }
  if (PROFILE) {
    checks.push(`All ${prompts.length} requests, with the terminal open and after rotation, went to the DeepSeek path with the synthetic key, the profile's model, effort max and the catalog's tools`);
  }
  assert.deepEqual(errors, []);
  if (process.env.NAW_EVIDENCE_DIR) {
    fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'queue-native.png') });
  }
  console.log(JSON.stringify({ provider: PROVIDER, oldPidAlive: oldPid ? pidAlive(oldPid) : null, checks, timings, nativeVersion, localResponses: responses, paidModelCalls: 0, prompts, errors, evidence: base }));
})().catch(async error => {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(base, 'failure.png') }).catch(() => {});
    // The scratch folder goes at cleanup; a named private evidence folder keeps what the window showed.
    if (process.env.NAW_EVIDENCE_DIR) {
      fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true, mode: 0o700 });
      await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'failure.png') }).catch(() => {});
      const screen = await page.locator('#terminal-area').innerText().catch(() => '');
      fs.writeFileSync(path.join(process.env.NAW_EVIDENCE_DIR, 'failure-terminal.txt'), screen, { mode: 0o600 });
    }
  }
  console.error(error.stack, '\nEvidence:', base, '\nPrompts:', JSON.stringify(prompts), '\nWorkspace calls:', JSON.stringify(workspaceCalls).slice(0, 6000));
  process.exitCode = 1;
}).finally(testScratch.cleanup(cleanup));
