// Write-queue disconnect on a batch archive (11-23): the person confirms "全部确认（8）" for eight archive cards of one
// agent across five backends with large histories. No backend may end a window's connection. Real hidden Electron
// window, MCP broker, durable receipts and services; synthetic native host, so no provider process or model call.
// NAW_DAEMON_ROOT: the checkout the backends run (an older one keeps its old protocol); default this checkout.
// NAW_WRITE_QUEUE_SERVICES_MB: comma-separated synthetic history per backend, in MB (default five of 28).
const scratch = require('./fixtures/test-scratch.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto'), { execFileSync } = require('node:child_process');
const { _electron } = scratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = fs.realpathSync(process.env.NAW_TEST_APP_ROOT || root);
const daemonRoot = fs.realpathSync(process.env.NAW_DAEMON_ROOT || code);
const { connectService } = require(path.join(code, 'app/service-connection.cjs'));
const evidence = process.env.NAW_EVIDENCE_DIR;
if (!evidence || !path.isAbsolute(evidence) || [root, code, daemonRoot].some(p => path.resolve(evidence) === p || path.resolve(evidence).startsWith(p + path.sep))) throw Error('External private evidence directory required');
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = process.env.NAW_GUI_TEST_SLOT || path.join(path.dirname(common), '.local/gui-test-slot.lock');
fs.mkdirSync(path.dirname(slot), { recursive: true });
const token = randomUUID();
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; no launch.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, task: 'write-queue archive window test', pid: process.pid }));
const sizesMb = (process.env.NAW_WRITE_QUEUE_SERVICES_MB || '28,28,28,28,28').split(',').map(Number), SERVICES = sizesMb.length, TARGETS = 8;
assert.ok(SERVICES >= 1 && sizesMb.every(mb => mb > 0), 'NAW_WRITE_QUEUE_SERVICES_MB lists positive sizes');
const checks = [], trace = [], errors = [];
let profile, services = [], app, page, helper, source, sequence = 0;
const save = (name, value) => fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(value, null, 2), { mode: 0o600 });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, rounds = 1500) {
  for (let n = 0; n < rounds; n++) { if (await fn()) return; await wait(40); }
  throw Error(label);
}
function fixture(child, method, target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Fixture response timeout')); }, 15000);
    const receive = r => {
      if ((method === 'backgroundProof' ? r.proofRequestId : method === 'writeQueueSummary' ? r.writeQueueRequestId : r.requestId) !== id) return;
      clearTimeout(timer); child.off('message', receive); r.error ? reject(Error(r.error)) : resolve(r);
    };
    child.on('message', receive);
    child.send({ id, method, target, value }, e => { if (e) { clearTimeout(timer); child.off('message', receive); reject(e); } });
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
function seed(dir, cwd, n, historyMb) {
  const line = 'synthetic history line for the write-queue test; no real conversation. '.repeat(28);
  const perMessage = Buffer.byteLength(line) + 120, total = Math.round(historyMb * 1024 * 1024 / perMessage);
  const sessions = Array.from({ length: 6 }, (_, i) => ({ id: `synthetic-history-${n}-${i}`, nativeId: `synthetic-history-native-${n}-${i}`, provider: 'codex', name: `Synthetic history ${n}.${i}`,
    cwd, roomId: null, view: 'chat', state: 'ended', model: 'synthetic-model', fleet: [], activity: '',
    messages: Array.from({ length: Math.ceil(total / 6) }, (_, j) => ({ id: `h${n}-${i}-${j}`, role: j % 2 ? 'assistant' : 'user', text: `${j} ${line}`, status: 'complete', time: 1763700000000 + j })) }));
  fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify({ sessions, room: { messages: [] }, drafts: {} }), { mode: 0o600 });
}
function frames(log, snapshotBytes) {
  const rows = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => !row.summary) : [];
  const byKind = {}, fullInitial = {};
  for (const row of rows) {
    if (!row.kind || row.action === 'written') continue;
    const k = byKind[row.kind] ||= { queued: 0, maxBytes: 0, totalBytes: 0 };
    k.queued++; k.maxBytes = Math.max(k.maxBytes, row.bytes); k.totalBytes += row.bytes;
    // A whole snapshot, not a negotiated delta: at least half the measured snapshot.
    if (row.kind === 'reply:initial' && row.bytes >= snapshotBytes / 2) { const key = `${row.conn}:${row.owner}:${row.page}`; fullInitial[key] = (fullInitial[key] || 0) + 1; }
  }
  return { byKind, fullInitial, refusals: rows.filter(row => row.action && !['queued', 'written'].includes(row.action)),
    peakQueued: rows.reduce((best, row) => row.queuedBytes > (best?.queuedBytes || 0) ? row : best, null) };
}
async function startService(key, n, cwd) {
  const dir = key === '.' ? profile : path.join(profile, key);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  seed(dir, cwd, n, sizesMb[n]);
  const log = path.join(evidence, `write-queue-${n}.jsonl`);
  const child = scratch.childProcess.fork(path.join(daemonRoot, 'app/daemon.cjs'), [dir], {
    cwd, execArgv: ['--require', path.join(daemonRoot, 'scripts/fixtures/background-control.cjs'), '--require', path.join(__dirname, 'fixtures/write-queue-probe.cjs')],
    env: { ...process.env, NAW_TEST_APP_ROOT: daemonRoot, NAW_WORKSPACE: cwd, NAW_WRITE_QUEUE_LOG: log, NAW_APP_VERSION: require(path.join(daemonRoot, 'package.json')).version },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(dir, 'connection.json')), 'Synthetic service starts');
  const client = await connectService(dir, 'human-view');
  const snapshotBytes = Buffer.byteLength(JSON.stringify(await client.call('initial')));
  return { key, n, dir, log, child, client, snapshotBytes };
}
async function run() {
  profile = fs.realpathSync(scratch.directory(path.join(os.tmpdir(), 'naw-write-queue-archive-')));
  const cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd, { mode: 0o700 });
  fs.mkdirSync(path.join(profile, 'backends'), { mode: 0o700 });
  const keys = ['.', ...Array.from({ length: SERVICES - 1 }, () => 'backends/' + randomBytes(10).toString('hex'))];
  for (const [n, key] of keys.entries()) services.push(await startService(key, n, cwd));
  fs.writeFileSync(path.join(profile, 'services.json'), JSON.stringify({ format: 1, active: '.', entries: keys }), { mode: 0o600 });
  const operator = services[0];
  source = await operator.client.call('create', { provider: 'codex', cwd, name: 'Synthetic operator', view: 'chat' });
  await operator.client.call('wakePolicy', null, false);
  const idle = async (service, name) => {
    const id = await service.client.call('create', { provider: 'codex', cwd, name, view: 'chat' });
    await until(async () => (await service.client.call('initial')).sessions.find(s => s.id === id)?.state === 'idle', 'Synthetic session ready');
    return id;
  };
  const targets = [];
  for (let i = 0; i < TARGETS; i++) targets.push(await idle(services[i % SERVICES], `Synthetic archive ${i}`));
  // A daily backend always holds a live session; one with only ended ones is retired at startup.
  for (const service of services.slice(TARGETS)) await idle(service, `Synthetic resident ${service.n}`);
  for (const service of services) { service.client.close(); service.client = null; }
  fs.writeFileSync(path.join(profile, 'views.json'), JSON.stringify([{ owner: 'human-view', active: true, selected: source, mode: 'chat' }]), { mode: 0o600 });
  save('source', { code, daemonRoot, revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: code, encoding: 'utf8' }).trim(),
    daemonRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: daemonRoot, encoding: 'utf8' }).trim(), sizesMb,
    services: services.map(s => ({ n: s.n, key: s.key, pid: s.child.pid, snapshotBytes: s.snapshotBytes })) });
  app = await _electron.launch({ executablePath: require('electron'), args: [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_APP_ROOT: code, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_VISIBLE: '0' }, timeout: 90000 });
  page = await app.firstWindow(); page.setDefaultTimeout(30000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#message-input').waitFor(); await hidden('startup');
  // Main-process event-loop delay, sampled every 50 ms.
  await app.evaluate(() => {
    const lag = globalThis.__nawLag = { max: 0, over1s: 0, samples: 0 }; let last = Date.now();
    globalThis.__nawLagTimer = setInterval(() => { const now = Date.now(), d = now - last - 50; last = now; lag.samples++; if (d > lag.max) lag.max = d; if (d > 1000) lag.over1s++; }, 50);
  });
  const rpc = mcp(); await rpc('initialize');
  async function archive(target) {
    const call = { action: 'invoke', method: 'archiveSession', arguments: [target], operation_id: randomUUID() };
    const proof = await fixture(operator.child, 'backgroundProof', source, { callId: randomUUID(), arguments: call });
    const result = await rpc('tools/call', { name: 'workspace_control', arguments: call,
      _meta: { threadId: proof.nativeId, sessionId: proof.sessionId, callId: proof.callId, 'x-codex-turn-metadata': { thread_id: proof.nativeId, turn_id: proof.turnId } } });
    const record = JSON.parse(result.content[0].text); trace.push({ call, record, isError: result.isError }); save('trace', trace);
    await fixture(operator.child, 'backgroundComplete', source, { callId: proof.callId, arguments: call });
    assert.equal(stored(record.id).state, 'confirmation-required'); await card(record).waitFor();
    return record;
  }
  const before = events().length;
  let records = [], confirmedAt = 0;
  await check('eight-archives-execute', async () => {
    for (const target of targets) records.push(await archive(target));
    const batch = page.locator('#messages .background-batch').filter({ has: page.getByRole('button', { name: `全部确认（${TARGETS}）`, exact: true }) });
    await until(async () => await batch.count() === 1, 'Eight archive cards share one batch', 3000);
    confirmedAt = Date.now();
    await batch.getByRole('button', { name: `全部确认（${TARGETS}）`, exact: true }).click();
    await until(() => records.every(r => ['complete', 'failed', 'not-executed', 'unconfirmed', 'cancelled'].includes(stored(r.id)?.state)), 'Every card reaches an outcome', 9000);
    save('receipts', records.map(r => { const s = stored(r.id); return { id: r.id, state: s.state, reason: s.reason || null, humanDecisionAt: s.humanDecisionAt ?? null, finishedAt: s.finishedAt ?? null }; }));
    assert.deepEqual(records.map(r => stored(r.id).state), records.map(() => 'complete'), 'Each card executes once');
    const archived = JSON.parse(fs.readFileSync(path.join(profile, 'room-state.json'))).archivedSessions;
    assert.ok(targets.every(id => archived.includes(id)), 'Every target is archived');
  });
  await wait(3000);
  const lag = await app.evaluate(() => { clearInterval(globalThis.__nawLagTimer); return globalThis.__nawLag; });
  await check('window-connections-stay-up', async () => {
    const after = events().slice(before);
    save('connection-events', after);
    const finished = records.map(r => stored(r.id)?.finishedAt).filter(Number.isSafeInteger).sort((a, b) => a - b);
    const perItem = finished.map((t, i) => t - (i ? finished[i - 1] : confirmedAt));
    const measured = [];
    for (const s of services) {
      const summary = (await fixture(s.child, 'writeQueueSummary')).summary;
      measured.push({ n: s.n, key: s.key, snapshotBytes: s.snapshotBytes, connections: summary, ...frames(s.log, s.snapshotBytes) });
    }
    const refused = measured.flatMap(m => m.connections.filter(c => c.refused).map(c => ({ service: m.n, ...c })));
    const report = { closes: after.filter(e => e.event === 'closed').length, serviceRefusals: refused.length, mainMaxLagMs: lag.max, mainLagOver1s: lag.over1s,
      perItemMs: perItem, totalMs: finished.length ? finished[finished.length - 1] - confirmedAt : null,
      fullInitialReplies: measured.map(m => ({ service: m.n, perConnection: m.fullInitial, total: Object.values(m.fullInitial).reduce((a, b) => a + b, 0) })) };
    save('write-queue-summary', { report, measured });
    console.log('MEASURE ' + JSON.stringify(report));
    for (const m of measured) console.log(`MEASURE service=${m.n} snapshotBytes=${m.snapshotBytes} refused=${JSON.stringify(m.connections.filter(c => c.refused).map(c => [c.conn, c.owner, c.page, c.refused]))} peak=${JSON.stringify(m.connections.map(c => [c.conn, c.page, c.peakBytes]))}`);
    assert.deepEqual(refused, [], 'No backend ends a connection');
    assert.deepEqual(after.filter(e => e.event === 'closed'), [], 'No window connection closes');
  });
  const stats = await fixture(operator.child, 'stats'); save('fixture-stats', stats);
  assert.equal(stats.nativeProcesses, 0); assert.equal(stats.modelCalls, 0);
  await hidden('final');
}
(async () => {
  let fatal, cleanupError;
  try { await run(); } catch (e) { fatal = e.stack; console.error(fatal); }
  finally {
    if (helper) helper.stdin.end();
    for (const s of services) s.client?.close();
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
