// Write-queue disconnect (11-22): with a large history, one agent asks for five new sessions and two resumes and the
// person confirms them at once. The window's connection must stay up. Real hidden Electron window, MCP broker,
// durable receipts and service; synthetic native host, so no provider process or model call is involved.
// NAW_WRITE_QUEUE_HISTORY_MB sets the synthetic history size (default 28, the size of the affected daily backends).
const scratch = require('./fixtures/test-scratch.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto'), { execFileSync } = require('node:child_process');
const { _electron } = scratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = fs.realpathSync(process.env.NAW_TEST_APP_ROOT || root);
const { connectService } = require(path.join(code, 'app/service-connection.cjs'));
const evidence = process.env.NAW_EVIDENCE_DIR;
if (!evidence || !path.isAbsolute(evidence) || [root, code].some(p => path.resolve(evidence) === p || path.resolve(evidence).startsWith(p + path.sep))) throw Error('External private evidence directory required');
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = process.env.NAW_GUI_TEST_SLOT || path.join(path.dirname(common), '.local/gui-test-slot.lock');
fs.mkdirSync(path.dirname(slot), { recursive: true });
const token = randomUUID();
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; no launch.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, task: 'write-queue cards window test', pid: process.pid }));
const historyMb = Number(process.env.NAW_WRITE_QUEUE_HISTORY_MB || 28);
const log = path.join(evidence, 'write-queue.jsonl');
const checks = [], trace = [], errors = [];
let profile, child, client, app, page, helper, source, sequence = 0;
const save = (name, value) => fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(value, null, 2), { mode: 0o600 });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, rounds = 1500) {
  for (let n = 0; n < rounds; n++) { if (await fn()) return; await wait(40); }
  throw Error(label);
}
function fixture(method, target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Fixture response timeout')); }, 15000);
    const receive = r => {
      if ((method === 'backgroundProof' ? r.proofRequestId : method === 'writeQueueSummary' ? r.writeQueueRequestId : r.requestId) !== id) return;
      clearTimeout(timer); child.off('message', receive); r.error ? reject(Error(r.error)) : resolve(r);
    };
    child.on('message', receive); child.send({ id, method, target, value });
  });
}
function mcp() {
  helper = scratch.childProcess.spawn(process.execPath, [path.join(code, 'app/claude-message-tool.cjs'), '--codex'], {
    env: { ...process.env, NAW_CONTROL_DESCRIPTOR: path.join(profile, 'outbox-owner.json') }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = ''; const pending = new Map();
  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', part => {
    buffer += part; let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const reply = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      pending.get(reply.id)?.(reply); pending.delete(reply.id);
    }
  });
  helper.stderr.on('data', part => errors.push(String(part)));
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('MCP response timeout')); }, 30000);
    pending.set(id, reply => { clearTimeout(timer); reply.error ? reject(Error(JSON.stringify(reply.error))) : resolve(reply.result); });
    helper.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function hidden(stage) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focused: w.isFocused() })));
  const frontmostPid = Number(execFileSync('osascript', ['-l', 'JavaScript', '-e', "ObjC.import('AppKit'); $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier"], { encoding: 'utf8' }).trim());
  save(stage + '-windows', { windows, frontmostPid, ownPid: app.process().pid });
  assert.ok(windows.length > 0 && windows.every(w => !w.visible && !w.focused), 'Owned windows stay hidden and unfocused');
  assert.notEqual(frontmostPid, app.process().pid, 'Owned app does not take the foreground');
}
const stored = id => JSON.parse(fs.readFileSync(path.join(profile, 'background-operations.json'))).records.find(r => r.id === id);
const events = () => { try { return JSON.parse(fs.readFileSync(path.join(profile, 'connection-events.json'), 'utf8')); } catch { return []; } };
const card = record => page.locator(`#messages [data-message-id="background:${record.actor.nativeId}:${record.id}"]`);
async function check(name, test) {
  try { await test(); checks.push({ name, passed: true }); console.log('PASS ' + name); }
  catch (e) { checks.push({ name, passed: false, error: e.stack }); console.error('FAIL ' + name + '\n' + e.stack); }
  save('checks', checks);
}
// Synthetic ended sessions whose records together are about historyMb, like the affected daily backends.
function seed(cwd) {
  const line = 'synthetic history line for the write-queue test; no real conversation. '.repeat(28);
  const perMessage = Buffer.byteLength(line) + 120, total = Math.round(historyMb * 1024 * 1024 / perMessage);
  const sessions = Array.from({ length: 8 }, (_, i) => ({ id: `synthetic-history-${i}`, nativeId: `synthetic-history-native-${i}`, provider: 'codex', name: `Synthetic history ${i}`,
    cwd, roomId: null, view: 'chat', state: 'ended', model: 'synthetic-model', fleet: [], activity: '',
    messages: Array.from({ length: Math.ceil(total / 8) }, (_, j) => ({ id: `h${i}-${j}`, role: j % 2 ? 'assistant' : 'user', text: `${j} ${line}`, status: 'complete', time: 1763700000000 + j })) }));
  const resumable = ['Synthetic resume A', 'Synthetic resume B'].map((name, i) => ({ id: `synthetic-resume-${i}`, nativeId: `synthetic-resume-native-${i}`, provider: 'codex', name,
    cwd, roomId: null, view: 'chat', state: 'ended', model: 'synthetic-model', fleet: [], activity: '', messages: [{ id: `r${i}`, role: 'assistant', text: 'Synthetic resume history', status: 'complete' }] }));
  fs.writeFileSync(path.join(profile, 'workspace.json'), JSON.stringify({ sessions: [...sessions, ...resumable], room: { messages: [] }, drafts: {} }), { mode: 0o600 });
  return resumable.map(s => s.id);
}
function frames() {
  const rows = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const byKind = {};
  for (const row of rows) {
    if (!row.kind || row.action === 'written') continue;
    const k = byKind[row.kind] ||= { queued: 0, maxBytes: 0, totalBytes: 0 };
    k.queued++; k.maxBytes = Math.max(k.maxBytes, row.bytes); k.totalBytes += row.bytes;
  }
  return { byKind, refusals: rows.filter(row => row.action && !['queued', 'written'].includes(row.action)), peakQueued: rows.reduce((best, row) => row.queuedBytes > (best?.queuedBytes || 0) ? row : best, null) };
}
async function run() {
  profile = fs.realpathSync(scratch.directory(path.join(os.tmpdir(), 'naw-write-queue-')));
  const cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd, { mode: 0o700 });
  const resumeIds = seed(cwd);
  child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
    cwd, execArgv: ['--require', path.join(__dirname, 'fixtures/background-control.cjs'), '--require', path.join(__dirname, 'fixtures/write-queue-probe.cjs')],
    env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: cwd, NAW_WRITE_QUEUE_LOG: log, NAW_APP_VERSION: require(path.join(code, 'package.json')).version },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  save('source', { code, revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: code, encoding: 'utf8' }).trim(), historyMb, childPid: child.pid });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Synthetic service starts');
  client = await connectService(profile, 'human-view');
  const snapshotBytes = Buffer.byteLength(JSON.stringify(await client.call('initial')));
  source = await client.call('create', { provider: 'codex', cwd, name: 'Synthetic operator', view: 'chat' });
  await client.call('wakePolicy', null, false);
  client.close(); client = null;
  fs.writeFileSync(path.join(profile, 'views.json'), JSON.stringify([{ owner: 'human-view', active: true, selected: source, mode: 'chat' }]), { mode: 0o600 });
  app = await _electron.launch({ executablePath: require('electron'), args: [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_APP_ROOT: code, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_VISIBLE: '0' }, timeout: 60000 });
  page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#message-input').waitFor(); await hidden('startup');
  const rpc = mcp(); await rpc('initialize');
  async function invoke(method, args) {
    const call = { action: 'invoke', method, arguments: args, operation_id: randomUUID() };
    const proof = await fixture('backgroundProof', source, { callId: randomUUID(), arguments: call });
    const result = await rpc('tools/call', { name: 'workspace_control', arguments: call,
      _meta: { threadId: proof.nativeId, sessionId: proof.sessionId, callId: proof.callId, 'x-codex-turn-metadata': { thread_id: proof.nativeId, turn_id: proof.turnId } } });
    const record = JSON.parse(result.content[0].text); trace.push({ call, record, isError: result.isError }); save('trace', trace);
    await fixture('backgroundComplete', source, { callId: proof.callId, arguments: call });
    assert.equal(stored(record.id).state, 'confirmation-required'); await card(record).waitFor();
    return record;
  }
  const before = events().length;
  let records = [];
  await check('five-creates-and-two-resumes-execute', async () => {
    const names = ['Write queue A', 'Write queue B', 'Write queue C', 'Write queue D', 'Write queue E'];
    for (const name of names) records.push(await invoke('create', [{ provider: 'codex', cwd, name, view: 'chat', settings: { model: 'synthetic-model', effort: 'high' } }]));
    const resumes = [];
    for (const id of resumeIds) resumes.push(await invoke('resume', [id]));
    records = records.concat(resumes);
    const batch = page.locator('#messages .background-batch').filter({ has: page.getByRole('button', { name: '全部确认（5）', exact: true }) });
    await until(async () => await batch.count() === 1, 'Five create cards share one batch');
    // The person confirms everything in one go: the batch, then each resume card, without waiting in between.
    await batch.getByRole('button', { name: '全部确认（5）', exact: true }).click();
    for (const record of resumes) await card(record).locator('.background-controls').getByRole('button', { name: '确认', exact: true }).click();
    await until(() => records.every(r => ['complete', 'failed', 'not-executed'].includes(stored(r.id)?.state)), 'Every card reaches an outcome');
    save('receipts', records.map(r => ({ id: r.id, method: r.command?.method, state: stored(r.id).state, reason: stored(r.id).reason || null })));
    assert.deepEqual(records.map(r => stored(r.id).state), records.map(() => 'complete'), 'Each card executes once');
  });
  await wait(3000);
  await check('window-connection-stays-up', async () => {
    const after = events().slice(before);
    save('connection-events', after);
    const summary = (await fixture('writeQueueSummary')).summary;
    const measured = frames();
    save('write-queue-summary', { snapshotBytes, connections: summary, ...measured });
    console.log('MEASURE snapshotBytes=' + snapshotBytes + ' peak=' + JSON.stringify(summary.map(c => [c.conn, c.owner, c.page, c.peakBytes, c.peakFrames, c.refused])));
    console.log('MEASURE byKind=' + JSON.stringify(measured.byKind));
    assert.deepEqual(after.filter(e => e.event === 'closed'), [], 'No window connection closes');
    assert.deepEqual(summary.filter(c => c.refused), [], 'The service ends no connection');
  });
  const stats = await fixture('stats'); save('fixture-stats', stats);
  assert.equal(stats.nativeProcesses, 0); assert.equal(stats.modelCalls, 0);
  await hidden('final');
}
(async () => {
  let fatal, cleanupError;
  try { await run(); } catch (e) { fatal = e.stack; console.error(fatal); }
  finally {
    if (helper) helper.stdin.end();
    if (client) client.close();
    try {
      await scratch.release();
      const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json')));
      if (owner.token === token) fs.rmSync(slot, { recursive: true });
    } catch (e) { cleanupError = e.stack; console.error(cleanupError); }
    const passed = checks.filter(c => c.passed).length, failed = checks.length - passed;
    const ok = !fatal && !cleanupError && failed === 0 && checks.length === 2;
    save('result', { passed, failed, ok, fatal, cleanupError, errors, syntheticNative: true, installed: false });
    console.log(`RESULT passed=${passed} failed=${failed} fatal=${Boolean(fatal)} cleanup=${cleanupError ? 'failed' : 'complete'}`);
    if (!ok) process.exitCode = 1;
  }
})();
