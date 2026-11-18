// Real native CLI and production Workspace/PTY/mod, with fixed loopback responses. No GUI or provider.
// The same three contracts as test-native-queue: solo queue, shared queue, shared model changes.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const [binary, version, receipt] = process.argv.slice(2);
const { nativeRoot, removeNativeRoot } = require('./claude-qualification.cjs');
const directoryReceipt = JSON.parse(receipt), root = nativeRoot(directoryReceipt);
const home = path.join(root, 'home'); fs.mkdirSync(home, { mode: 0o700 });
Object.assign(process.env, { HOME: home, TMPDIR: root, CLAUDE_CONFIG_DIR: path.join(root, 'config'), NAW_DATA_DIR: path.join(root, 'data'), NAW_RUNTIME_CONFIG: path.join(root, 'locations.json') });
const { NativeHost } = require('./adapters.cjs'), { Workspace } = require('./workspace.cjs');
const { pythonExecutable } = require('./platform.cjs');
const loopback = require('./claude-loopback.cjs');
let cancelled = false, workspace, fixture, release, held;
const journeys = {}, owner = 'native-qualification';
const cancel = () => { cancelled = true; release?.(); held?.destroy(); };
process.on('message', message => { if (message?.cancel) cancel(); });
process.on('disconnect', cancel); process.on('SIGTERM', cancel); process.on('SIGINT', cancel);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, name, limit = 30000) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) { if (cancelled) throw Error('cancelled'); if (await read()) return; await sleep(50); }
  throw Error(name);
}
function event(res, type, fields) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`); }
async function cleanup() {
  release?.(); release = null; held?.destroy(); held = null;
  if (workspace) {
    const own = workspace; workspace = null;
    try { await Promise.all([...own.sessions.keys()].map(id => own.stop(id))); }
    finally { await own.close(); }
  }
  if (fixture) { const own = fixture; fixture = null; await own.stop(); }
}
async function journey(name) {
  const directory = path.join(root, name), config = path.join(directory, 'config'), cwd = path.join(directory, 'work'), profile = path.join(directory, 'data');
  for (const folder of [directory, config, cwd, profile]) fs.mkdirSync(folder, { mode: 0o700 });
  const requests = [];
  fixture = loopback.create({ directory, provider: 'claude', respond: (req, res, body) => {
    if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: 100, data: [] })); return; }
    const number = requests.push(JSON.parse(body));
    if (name === 'shared-model' || number > 2) throw Error('Fixed response budget exceeded');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    event(res, 'message_start', { message: { id: `fixture-${number}`, type: 'message', role: 'assistant', model: requests.at(-1).model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    event(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    event(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: number === 1 ? 'PRIVATE_ORIGINAL_REPLY' : 'SHARED_QUEUED_REPLY' } });
    event(res, 'content_block_stop', { index: 0 });
    const finish = () => { event(res, 'message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } }); event(res, 'message_stop', {}); res.end(); };
    if (number === 1) { release = finish; held = res; } else finish();
  } });
  await fixture.start(); await fixture.preflight();
  const shim = path.join(directory, 'claude-local');
  fixture.wrapper(binary, { file: shim, env: { CLAUDE_CONFIG_DIR: config }, args: ['--allowedTools', 'Bash(printf:*)', '--model', 'haiku'] });
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, customApiKeyResponses: { approved: [loopback.FIXTURE_KEY], rejected: [] }, theme: 'dark', projects: { [cwd]: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
  fs.writeFileSync(process.env.NAW_RUNTIME_CONFIG, JSON.stringify({ claude: shim }), { mode: 0o600 });
  const host = new NativeHost(path.join(directory), profile);
  host.checkClaudeVersion = () => {}; // Never recursively qualify a qualification fixture.
  host.qualificationTrialVersion = version;
  host.resolvePrograms = () => (host.binaries = { claude: shim, codex: null, python: pythonExecutable() });
  await host.start(); workspace = new Workspace(host, profile);
  const id = await workspace.create('claude', cwd, owner, 'Native qualification', 'terminal');
  const read = () => workspace.snapshot().sessions.find(row => row.id === id);
  const screen = async () => {
    const terminal = workspace.runtime(id).terminal; await terminal.snapshot();
    const buffer = terminal.screen.buffer.active;
    return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) || '').join('\n').replace(/\u00a0/g, ' ');
  };
  await until(() => read()?.chatAvailable && read()?.state === 'idle', 'native-startup', 60000);
  const before = read(); assert.equal(before.queueAvailable, true);
  if (name === 'shared-model') {
    workspace.join(id, true); workspace.setDraft(id, 'Unsent model-switch draft', owner);
    for (const alias of ['sonnet', 'haiku', 'sonnet']) {
      workspace.input(id, '/model ' + alias, owner);
      // A native command is submitted only after its actual edit line has settled.
      await until(async () => String(await screen()).split('\n').filter(line => /^❯/.test(line.trim())).at(-1)?.trim() === '❯ /model ' + alias, 'model-edit-line');
      workspace.input(id, '\r', owner);
      await until(() => read().model?.includes(alias), 'native-model-observation');
      assert.equal(read().nativeId, before.nativeId); assert.equal(read().pid, before.pid);
      assert.equal(read().liveDraft, 'Unsent model-switch draft'); assert.equal(read().state, 'idle');
      assert.equal(read().messages.filter(row => ['user', 'assistant'].includes(row.role)).length, 0);
    }
    assert.equal(requests.length, 0);
  } else {
    await workspace.send(id, 'Run the original local task.', owner);
    await until(() => requests.length === 1 && read().state === 'working', 'original-task');
    const shared = name === 'shared-queue';
    if (shared) { workspace.setDraft(id, 'Private solo draft', owner); workspace.join(id, true); }
    else {
      workspace.input(id, 'x', owner);
      await until(async () => /❯\s*x\s*$/.test(String(await screen()).split('\n').filter(line => /^❯/.test(line.trim())).at(-1) || ''), 'native-draft');
    }
    const pending = workspace.queue(id, 'Do the next local task.', owner, shared ? { roomId: 'shared' } : null);
    // Observe rejection immediately, without creating an unhandled pending rejection.
    let queueError; const done = pending.catch(error => { queueError = error; });
    await until(() => read().pendingQueue || queueError, 'pending-queue');
    if (queueError) throw queueError;
    const tag = read().pendingQueue;
    workspace.setDraft(id, shared ? 'Private solo draft' : 'A newer unsent draft.', owner);
    // Exceed both the old 15-second submission and 40-second RPC deadlines.
    for (let i = 0; i < 420; i++) { if (cancelled || queueError) throw queueError || Error('cancelled'); await sleep(100); }
    assert.equal(read().pendingQueue, tag); assert.equal(requests.length, 1);
    assert.equal(read().messages.find(row => row.id === tag).status, 'awaiting-native');
    release(); release = null;
    await until(() => read().state === 'idle' && !read().pendingQueue && requests.length === 2, 'queued-completion');
    await done; if (queueError) throw queueError;
    const after = read();
    assert.equal(after.nativeId, before.nativeId); assert.equal(after.pid, before.pid);
    assert.equal(after.messages.filter(row => row.text === 'Do the next local task.').length, 1);
    assert.equal(after.messages.find(row => row.id === tag).status, 'submitted');
    assert.equal(after.liveDraft, shared ? 'Private solo draft' : 'A newer unsent draft.');
    const userTexts = requests[1].messages.filter(row => row.role === 'user').flatMap(row => typeof row.content === 'string' ? [row.content] : row.content.filter(part => part.type === 'text').map(part => part.text));
    assert.equal(userTexts.filter(text => text === 'Do the next local task.').length, 1);
    assert.ok(!userTexts.includes('x')); assert.ok(!userTexts.includes('Private solo draft'));
    if (shared) {
      await until(() => workspace.snapshot().room.messages.some(row => row.text?.includes('SHARED_QUEUED_REPLY')), 'shared-reply');
      const room = workspace.snapshot().room;
      assert.ok(!JSON.stringify(room.messages).includes('PRIVATE_ORIGINAL_REPLY'));
      assert.equal(room.messages.find(row => row.id === tag).deliveries[0].status, 'submitted');
      assert.equal(room.messages.filter(row => row.text?.includes('SHARED_QUEUED_REPLY')).length, 1);
    } else assert.match(String(await screen()), /❯\s*x(?:\s|$)/);
  }
  fixture.assertClean();
  await cleanup(); journeys[name] = true;
}
(async () => {
  let reason = 'native-startup';
  try {
    const reported = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 15000 }).trim();
    assert.equal(reported.split(' ')[0], version);
    for (const name of ['solo-queue', 'shared-queue', 'shared-model']) { reason = name; await journey(name); }
    process.send?.({ type: 'result', result: { passed: true, journeys, paidModelCalls: 0 } });
  } catch (error) {
    // Only fixed reason codes are persisted, never CLI text, prompts or private filesystem paths.
    console.error(error.stack);
    process.send?.({ type: 'result', result: { passed: false, reason, journeys } });
    process.exitCode = 1;
  } finally {
    await cleanup(); removeNativeRoot(directoryReceipt);
    if (process.connected) process.disconnect();
  }
})();
