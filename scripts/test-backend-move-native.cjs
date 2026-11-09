const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
const { joinSpace } = require('./fixtures/space-membership.cjs');
const { revealDefaultSpace } = require('./fixtures/default-space.cjs');
// Real Electron + real Claude CLI: a real idle Claude terminal session on a backend the previous
// build started is moved by the candidate build under automatic migration. Canned replies are
// served on loopback; no paid inference, user profile edits or foregrounding.
// Question (daily 2026-11-08, alpha.224 moving an alpha.220 backend): a Claude terminal ends itself
// during the stop, so its backend refused its own receipt and the session was left stopped. Does
// the candidate keep the typed-into screen, reconnect the same native session on the moved backend,
// log the move, and leave the member answering in its space?
// Bounded: one native session, at most 6 local responses; stop at the first failure.
// NAW_MOVE_OLD_APP and NAW_MOVE_NEW_APP name the two packaged executables.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
// Packaged builds keep the Node inspector closed: renderer-only acceptance of the signed bundles.
const { _electron } = testScratch.playwright({ _electron: require('./fixtures/installed-renderer.cjs') });
const root = path.resolve(__dirname, '..');
const { connectService } = require('../app/service-client.cjs');
const { readLayout } = require('../app/service-layout.cjs');
const { executable, processMayBeAlive } = require('../app/platform.cjs');
const { migrationSafe } = require('../app/backend-switch.cjs');

const OLD_APP = process.env.NAW_MOVE_OLD_APP;
const NEW_APP = process.env.NAW_MOVE_NEW_APP;
assert.ok(OLD_APP && NEW_APP && fs.existsSync(OLD_APP) && fs.existsSync(NEW_APP), 'Both packaged executables exist');

const base = testScratch.directory(path.join(os.tmpdir(), 'naw-move-native-'));
const profile = path.join(base, 'profile');
const cwd = path.join(base, 'work');
const config = path.join(base, 'claude');
for (const dir of [profile, cwd, config]) {
  fs.mkdirSync(dir, { mode: 0o700 });
}
const UNSENT = 'UNSENT_MOVE_NAW';
const NAME = '迁移甲';
const RESPONSE_LIMIT = 6;
const binary = process.env.NAW_CLAUDE_BIN || executable('claude');
if (!binary) {
  throw Error('Real native CLI required');
}
const nativeVersion = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
assert.match(nativeVersion, /^2\.1\.(316|317|318|319)\b/, 'A native version with verified chat sending');

// One GUI test at a time on this machine (the daily installer checks the same slot).
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock');
try {
  fs.mkdirSync(slot);
} catch (error) {
  if (error.code === 'EEXIST') {
    console.error('GUI test slot occupied');
    process.exit(75);
  }
  throw error;
}
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Claude 终端', task: '225 Claude backend move', pid: process.pid, at: new Date().toISOString() }));
// Released however this process ends, even when a teardown step times out.
function releaseSlot() {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'), 'utf8'));
    if (owner.pid === process.pid) {
      fs.rmSync(slot, { recursive: true, force: true });
    }
  } catch {
    // Not ours or already gone.
  }
}
process.once('exit', releaseSlot);

let application;
let page;
let client;
let responses = 0;
let unexpected = null;
const errors = [];
const checks = [];
const prompts = [];
const observed = [];
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
  const task = prompt.match(/MOVE_TASK_(\d)/);
  if (task) {
    return `MOVE_DONE_${task[1]}`;
  }
  return 'OK';
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', data => {
    body += data;
  });
  req.on('end', () => {
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

async function launch(executablePath, extraEnv = {}) {
  const env = { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_QUEUE_HUMAN_QUIET_MS: '3000', ...extraEnv };
  application = await _electron.launch({ executablePath, env, timeout: 70000 });
  page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('#new-session').waitFor();
  const plist = path.join(path.resolve(path.dirname(executablePath), '../..'), 'Contents/Info.plist');
  return execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist], { encoding: 'utf8' }).trim();
}

async function openSpace() {
  await page.locator('#room-nav').click();
  await page.locator('#room-record').click();
}

async function shared() {
  const state = await page.evaluate(() => workspace.initial());
  return (state.rooms || [state.room]).find(room => room.id === 'shared');
}

async function itemByText(text) {
  const room = await shared();
  return (room.queue || []).find(item => item.text === text);
}

async function addItem(text) {
  if (!(await page.locator('#queue-dialog').isVisible())) {
    await page.locator('#room-queue').click();
    await page.locator('#queue-dialog').waitFor();
  }
  await page.locator('#queue-text').fill(text);
  await page.locator('#queue-assignee').selectOption('');
  await page.locator('#add-queue').click();
  await until(async () => Boolean(await itemByText(text)), `Queued ${text}`, 10000);
}

async function closeQueue() {
  if (await page.locator('#queue-dialog').isVisible()) {
    await page.locator('#close-queue').click();
    await page.locator('#queue-dialog').waitFor({ state: 'hidden' });
  }
}

// Watches the old backend through its own connection until it is retired, keeping each view of the session.
function observe(directory, id) {
  let stopped = false;
  const done = (async () => {
    let watcher;
    try {
      watcher = await connectService(directory, 'move-native-observer');
    } catch {
      return;
    }
    try {
      while (!stopped) {
        let state;
        try {
          state = await watcher.call('initial');
        } catch {
          return;
        }
        const record = state.sessions.find(s => s.id === id);
        if (record) {
          observed.push({ at: Date.now(), runtimeVersion: state.runtimeVersion, state: record.state, controlRevision: record.controlRevision, connectionRevision: record.connectionRevision, activity: record.activity });
        }
        await sleep(100);
      }
    } finally {
      watcher.close();
    }
  })();
  return { stop: async () => { stopped = true; await done; }, done };
}

async function shutdownAll() {
  let layout;
  try {
    layout = readLayout(profile);
  } catch {
    return;
  }
  for (const key of layout.entries) {
    let backend;
    try {
      backend = await connectService(path.join(profile, key), 'move-native-cleanup');
    } catch {
      continue;
    }
    try {
      const state = await backend.call('initial').catch(() => ({ sessions: [] }));
      for (const session of state.sessions) {
        if (session.state !== 'ended') {
          await backend.call('stop', session.id).catch(() => {});
        }
      }
      await backend.call('shutdown').catch(() => {});
    } finally {
      backend.close();
    }
  }
}

async function cleanup() {
  if (application) {
    await application.close().catch(() => {});
  }
  if (client) {
    client.close();
  }
  await shutdownAll();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  releaseSlot();
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
    `os.environ.update(ANTHROPIC_BASE_URL=${JSON.stringify(`http://127.0.0.1:${server.address().port}`)},ANTHROPIC_API_KEY="local-fixture",CLAUDE_CONFIG_DIR=${JSON.stringify(config)},CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1",PATH=${JSON.stringify(fakeBin + ':')}+os.environ.get("PATH",""))`,
    'args=sys.argv[1:]',
    'args=args if "--model" in args else args+["--model","haiku"]',
    `os.execv(${JSON.stringify(binary)},["claude"]+args)`,
    '',
  ].join('\n');
  fs.writeFileSync(shim, shimSource, { mode: 0o700 });
  const trusted = {};
  trusted[fs.realpathSync(cwd)] = { hasTrustDialogAccepted: true };
  trusted[fs.realpathSync(cwd) + '-sessions'] = { hasTrustDialogAccepted: true };
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: trusted }), { mode: 0o600 });
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify({ claude: shim }), { mode: 0o600 });

  // 1) The previous build starts the backend and a real Claude terminal session in the default space.
  const oldVersion = await launch(OLD_APP);
  const oldKey = readLayout(profile).active;
  const oldDirectory = path.join(profile, oldKey);
  client = await connectService(oldDirectory, 'move-native-test');
  await revealDefaultSpace(page);
  await page.locator('#new-session').click();
  await page.locator('input[name="provider"][value="claude"]').check();
  await page.locator('#session-name').fill(NAME);
  await createIn(page, 'terminal');
  const terminalText = () => page.locator('#terminal-area').innerText();
  const ready = async () => (await snapshot()).sessions.some(s => s.name === NAME && s.state === 'idle' && s.chatAvailable);
  await until(async () => /Yes, I trust this folder|Do you want to use this API key/.test(await terminalText()) || await ready(), 'Native startup');
  if ((await terminalText()).includes('Yes, I trust this folder')) {
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
  await until(ready, 'Native session ready', 120000);
  if (await page.locator('#chat-tab').isVisible()) {
    await page.locator('#chat-tab').click();
  }
  await joinSpace(page);
  const first = (await snapshot()).sessions.find(s => s.name === NAME);
  await openSpace();
  checks.push(`Real Claude session ready on the ${oldVersion} backend (${nativeVersion})`);

  // The member does one item through NAW, so its native session has history to resume.
  await addItem('MOVE_TASK_1 请只回复完成标记');
  await until(async () => (await itemByText('MOVE_TASK_1 请只回复完成标记')).status === 'done', 'First item done', 120000);
  await closeQueue();

  // The person types into the native prompt and leaves it unsent, as the secretary's terminal was.
  await page.locator(`#session-list .session-link[data-session-id="${first.id}"]`).click();
  await page.locator('#terminal-tab').click();
  await page.locator('#terminal-area .xterm-screen').waitFor();
  await page.locator('#terminal-area .xterm-screen').click();
  const screenText = () => page.locator('#terminal-area .xterm-rows').innerText();
  await page.keyboard.type(UNSENT, { delay: 30 });
  await until(async () => (await screenText()).includes(UNSENT), 'Unsent text visible in the native prompt', 20000);
  await until(async () => (await snapshot()).sessions.find(s => s.id === first.id).terminalInputPending === true, 'Terminal input recorded as possibly unsent', 20000);
  await until(async () => migrationSafe((await snapshot()).sessions.find(s => s.id === first.id)), 'The idle member is safe to migrate (background reported)', 60000);
  const before = (await snapshot()).sessions.find(s => s.id === first.id);
  assert.ok(processMayBeAlive(before.processIdentity), 'The old Claude process runs before the move');
  await application.close();
  application = null;
  client.close();
  client = null;

  // 2) The candidate opens the same profile with automatic migration on.
  fs.writeFileSync(path.join(profile, 'backend-switch-settings.json'), JSON.stringify({ format: 1, auto: false, migrate: true }), { mode: 0o600 });
  const watch = observe(oldDirectory, first.id);
  const newVersion = await launch(NEW_APP, { NAW_TEST_MIGRATE_QUIET_MS: '5000', NAW_TEST_BACKEND_SWITCH_MS: '3000' });
  assert.notEqual(newVersion, oldVersion);
  const log = path.join(profile, 'backend-migrations.jsonl');
  const movedIn = await until(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').trim().length > 0, 'A migration was logged', 180000);
  await Promise.race([watch.done, sleep(5000)]);
  await watch.stop();
  const entries = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(entries.length, 1, 'One move');
  const entry = entries[0];
  assert.equal(entry.failed, undefined, `The move finished (${entry.failed})`);
  assert.equal(entry.backend, oldKey);
  assert.deepEqual(entry.sessions.map(s => s.id), [first.id]);
  assert.equal(entry.left, 0);
  assert.equal(entry.reconnectFailed, false);
  assert.equal(entry.screens.length, 1);
  assert.ok(fs.readFileSync(path.join(profile, entry.screens[0]), 'utf8').includes(UNSENT), 'The saved screen has the unsent text');
  checks.push(`Moved in ${movedIn} ms; logged with the saved screen ${entry.screens[0]}; confirmedByState ${JSON.stringify(entry.confirmedByState)}`);

  // What the old backend showed: the plan's view, and its last view before it was retired.
  const planned = observed.find(view => view.state === 'idle');
  const last = observed[observed.length - 1];
  assert.ok(planned && last, 'The old backend was observed');
  const delta = { control: last.controlRevision - planned.controlRevision, connection: last.connectionRevision - planned.connectionRevision, lastState: last.state, lastActivity: last.activity, views: observed.length };
  checks.push(`Old ${oldVersion} backend before retirement: ${JSON.stringify(delta)}`);

  // 3) The same native session runs again on the moved backend, as the same member.
  client = await connectService(oldDirectory, 'move-native-check');
  await until(async () => {
    const state = await snapshot();
    const record = state.sessions.find(s => s.id === first.id);
    return state.runtimeVersion === newVersion && record && record.state === 'idle';
  }, 'The moved session is idle on the new code', 90000);
  const after = (await snapshot()).sessions.find(s => s.id === first.id);
  assert.equal(after.nativeId, before.nativeId);
  assert.equal(processMayBeAlive(before.processIdentity), false, 'The old Claude process exited');
  assert.ok(processMayBeAlive(after.processIdentity), 'A new Claude process runs the same native session');
  checks.push(`Same native session ${after.nativeId.slice(0, 8)} idle on ${newVersion}; old process ${before.processIdentity.pid} exited, new ${after.processIdentity.pid}`);

  // 4) The member still answers in its space through NAW.
  await openSpace();
  await addItem('MOVE_TASK_2 请只回复完成标记');
  await until(async () => (await itemByText('MOVE_TASK_2 请只回复完成标记')).status === 'done', 'Second item done after the move', 120000);
  const second = await itemByText('MOVE_TASK_2 请只回复完成标记');
  assert.equal(second.sentTo, first.id);
  const replied = (await snapshot()).sessions.find(s => s.id === first.id).messages.some(m => m.role === 'assistant' && m.text === 'MOVE_DONE_2');
  assert.ok(replied, 'The reply is in the moved session record');
  checks.push('The moved member got the next space item through NAW and replied');
  for (const prompt of prompts) {
    assert.match(prompt.model, /haiku/i);
  }
  assert.deepEqual(errors, []);
  if (process.env.NAW_EVIDENCE_DIR) {
    fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'move-native.png') });
  }
  console.log(JSON.stringify({ oldVersion, newVersion, checks, delta, entry, nativeVersion, localResponses: responses, paidModelCalls: 0, prompts, errors, evidence: base }));
})().catch(async error => {
  if (page && !page.isClosed()) {
    const kept = process.env.NAW_EVIDENCE_DIR || base;
    fs.mkdirSync(kept, { recursive: true });
    await page.screenshot({ path: path.join(kept, 'failure.png') }).catch(() => {});
    const terminal = await page.locator('#terminal-area').innerText().catch(() => '');
    fs.writeFileSync(path.join(kept, 'failure-terminal.txt'), terminal);
  }
  console.error(error.stack, '\nEvidence:', base, '\nObserved:', JSON.stringify([...observed.slice(0, 3), ...observed.slice(-3)]), '\nPrompts:', JSON.stringify(prompts));
  process.exitCode = 1;
}).finally(testScratch.cleanup(cleanup));
