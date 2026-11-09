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
assert.ok(['claude', 'codex'].includes(PROVIDER), 'claude or codex');
const codexHome = path.join(base, 'codex');
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
if (PROVIDER === 'codex') {
  assert.match(nativeVersion, /^codex-cli 0\.(164|165|166|167)\.\d+$/, 'A Codex version NAW supports');
} else {
  assert.match(nativeVersion, /^2\.1\.(307|308|309|310|311|316|317|318|319)\b/, 'A native version with verified chat sending');
}
const RESPONSE_LIMIT = 12;
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
      const reply = cannedReply(prompt);
      prompts.push({ model: request.model, prompt: prompt.slice(0, 160), reply });
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
      await client.call('shutdown');
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
  const shimSource = [
    '#!/usr/bin/python3',
    'import os,sys',
    'os.environ.pop("ANTHROPIC_AUTH_TOKEN",None)',
    'os.environ.pop("CLAUDE_CODE_OAUTH_TOKEN",None)',
    `os.environ.update(ANTHROPIC_BASE_URL=${JSON.stringify(`http://127.0.0.1:${server.address().port}`)},ANTHROPIC_API_KEY="local-fixture",CLAUDE_CONFIG_DIR=${JSON.stringify(config)},CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1",PATH=${JSON.stringify(fakeBin)}+":"+os.environ.get("PATH",""))`,
    `os.execv(${JSON.stringify(binary)},["claude"]+sys.argv[1:]+["--model","haiku"])`,
    '',
  ].join('\n');
  fs.writeFileSync(shim, shimSource, { mode: 0o700 });
  const trusted = {};
  trusted[fs.realpathSync(cwd)] = { hasTrustDialogAccepted: true };
  trusted[fs.realpathSync(cwd) + '-sessions'] = { hasTrustDialogAccepted: true };
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: trusted }), { mode: 0o600 });
  const address = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(codexHome, 'config.toml'), `model = "gpt-6-luna"\nmodel_provider = "local_fixture"\nmodel_reasoning_effort = "low"\n[model_providers.local_fixture]\nname = "Local fixture"\nbase_url = "${address}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`, { mode: 0o600 });
  const codexShim = path.join(base, 'codex-local');
  const codexShimSource = [
    '#!/usr/bin/python3',
    'import os,sys',
    'for key in ["OPENAI_API_KEY","CODEX_API_KEY"]: os.environ.pop(key,None)',
    `os.environ.update(CODEX_HOME=${JSON.stringify(codexHome)})`,
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
  await page.locator('#new-session').click();
  await page.locator(`input[name="provider"][value="${PROVIDER}"]`).check();
  await page.locator('#session-name').fill('实测甲');
  if (PROVIDER === 'codex') {
    await createIn(page, 'chat');
  } else {
    await createIn(page, 'terminal');
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

  // 1) A real idle native session receives the queued item through NAW's own send path.
  const queuedAt = Date.now();
  await addItem('QUEUE_TASK_1 请只回复完成标记');
  timings.firstDispatchMs = await until(async () => (await itemByText('QUEUE_TASK_1 请只回复完成标记')).status !== 'queued', 'First item sent');
  timings.firstDoneMs = await until(async () => (await itemByText('QUEUE_TASK_1 请只回复完成标记')).status === 'done', 'First item done') + timings.firstDispatchMs;
  const afterFirst = (await snapshot()).sessions.find(s => s.id === first.id);
  const sentMessage = afterFirst.messages.find(m => m.role === 'user' && typeof m.text === 'string' && m.text.includes('【NAW 派活】'));
  assert.ok(sentMessage, 'The NAW message is in the native session record');
  assert.ok(afterFirst.messages.some(m => m.role === 'assistant' && m.text === 'QUEUE_DONE_1'), 'The native reply is in the record');
  checks.push(`A real native session got the queued item and finished it (sent ${timings.firstDispatchMs} ms, done ${Date.now() - queuedAt} ms after queuing)`);

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
  await openSpace();

  // 3) Rotation: the old session writes a handoff, a new session continues, the old process exits.
  const age = Date.now() - first.createdAt;
  if (age < 61000) {
    await sleep(61000 - age);
  }
  await application.close();
  application = null;
  await launch({ NAW_TEST_QUEUE_ROTATE_MS: '60000' });
  await openSpace();
  const old = (await snapshot()).sessions.find(s => s.id === first.id);
  const oldPid = old.pid;
  const oldRss = rssKb(oldPid);
  if (PROVIDER === 'claude') {
    assert.ok(oldPid && pidAlive(oldPid), 'The old native process is running before rotation');
  }
  await addItem('QUEUE_TASK_3 请只回复完成标记', first.id);
  await until(async () => (await snapshot()).sessions.some(s => s.name === '实测甲 · 续'), 'New native session created', 120000);
  await until(async () => (await snapshot()).sessions.find(s => s.id === first.id).state === 'ended', 'Old native session ended', 120000);
  if (PROVIDER === 'claude') {
    await until(() => !pidAlive(oldPid), 'Old native process exited', 30000);
  }
  const fresh = (await snapshot()).sessions.find(s => s.name === '实测甲 · 续');
  assert.ok(fresh.messages.some(m => m.role === 'user' && typeof m.text === 'string' && m.text.includes('feature-x 分支')), 'The handoff reached the new native session');
  await until(async () => (await itemByText('QUEUE_TASK_3 请只回复完成标记')).status === 'done', 'Third item done by the new session', 120000);
  const done = await itemByText('QUEUE_TASK_3 请只回复完成标记');
  assert.equal(done.sentTo, fresh.id);
  const freshRss = rssKb((await snapshot()).sessions.find(s => s.id === fresh.id).pid);
  checks.push(`Rotation: handoff written, new session continued, old process ${oldPid} exited (old ${oldRss} KB, new ${freshRss} KB)`);

  for (const prompt of prompts) {
    if (PROVIDER === 'claude') {
      assert.match(prompt.model, /haiku/i);
    }
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
  }
  console.error(error.stack, '\nEvidence:', base, '\nPrompts:', JSON.stringify(prompts));
  process.exitCode = 1;
}).finally(testScratch.cleanup(cleanup));
