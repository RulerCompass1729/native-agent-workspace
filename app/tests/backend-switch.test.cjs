// Moving idle sessions to the current backend (T-122). Services here are
// synthetic sockets in temporary directories; the "service process" is a
// sleeping child this test owns, so no real backend can ever be signalled.
for (const key of ['NAW_WORKSPACE', 'NAW_APP_VERSION', 'NAW_RUNTIME_CONFIG']) delete process.env[key];
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { backendPlan, sessionPlan, samePlan, switchBackend, readRecords, clearRecord, readSettings, writeSettings } = require('../backend-switch.cjs');
const { readFrames, REQUEST_BYTES } = require('../service-transport.cjs');

const now = 1_800_000_000_000;
const claudeNew = (extra = {}) => ({ id: 'c', nativeId: 'native-c', provider: 'claude', name: 'Claude 2', state: 'idle', owner: 'view-a',
  terminalInputPending: false, backgroundStale: false, background: 0, scheduled: 0, ...extra });
const codexNew = (extra = {}) => ({ id: 'x', nativeId: 'native-x', provider: 'codex', name: 'Codex 秘书', state: 'idle', owner: 'view-b', terminalInputPending: false, ...extra });
const caps = ['atomicShutdown', 'resume', 'conditionalMaintenanceStopV1'];

test('backend plan reasons carry exact canonical text and translate each known refusal without changing the plan', () => {
  const locale = require('../ui-locale.js'), rawName = 'RAW 中文 <name>{reason}';
  const cases = [
    { state: 'working' }, { state: 'starting' }, { state: 'stopping' }, { state: 'approval' }, { state: 'disconnected' }, { state: 'error' }, { state: 'unrecognized' }, { state: 'constructor' }, { state: '__proto__' },
    { pendingTag: 'original' }, { approval: {} }, { claudeQuestion: {} }, { capacityRecovery: { status: 'scheduled' } }, { nativeContextPending: {} }, { worktreePreparation: { status: 'pending' } },
    { nativeId: null }, { provider: 'unrecognized' }, { background: 2 }, { scheduled: 1 }, { fleet: [{ event: 'SubagentStart', id: 'child', stale: false }] },
    { terminalInputPending: undefined }, { terminalInputPending: true }, { fleet: [{ event: 'TeammateIdle', id: 'team' }] }, { fleet: [{ event: 'SubagentStart', id: 'child', stale: true }] }, { backgroundStale: true }, { provider: 'codex' },
  ];
  for (const patch of cases) {
    const record = claudeNew({ ...patch, name: rawName }), before = JSON.stringify(record), plan = sessionPlan(record, record.state), raw = plan.block || plan.reason;
    const uiMessage = plan.block ? plan.blockUiMessage : plan.reasonUiMessage; assert.ok(locale.displayMessage(uiMessage), JSON.stringify(patch));
    const wire = JSON.parse(JSON.stringify({ message: raw, uiMessage })); assert.equal(locale.errorText('zh', wire), raw);
    const english = locale.errorText('en', wire); assert.ok(english.includes(rawName)); assert.notEqual(english, raw);
    assert.doesNotMatch(english.replace(rawName, ''), /\p{Script=Han}/u); assert.equal(JSON.stringify(record), before);
  }
  for (const sessions of [[claudeNew({ name: rawName, state: 'working' }), codexNew({ state: 'approval' })], [claudeNew({ name: rawName, terminalInputPending: true }), codexNew()]]) {
    const plan = backendPlan({ capabilities: caps, servicePid: 42, sessions }), original = plan.reason, wire = JSON.parse(JSON.stringify({ message: original, uiMessage: plan.reasonUiMessage }));
    assert.ok(locale.displayMessage(wire.uiMessage)?.parts); assert.equal(locale.errorText('zh', wire), original);
    const english = locale.errorText('en', wire); assert.ok(english.includes(rawName)); assert.ok(english.includes('Codex 秘书')); assert.notEqual(english, original);
    assert.doesNotMatch(english.replace(rawName, '').replace('Codex 秘书', ''), /\p{Script=Han}/u);
    assert.equal(plan.reason, original); assert.equal(plan.auto, false);
  }
});

test('process identity refusals preserve their guards and carry English display metadata without a process operation', () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), locale = require('../ui-locale.js');
  const source = fs.readFileSync(require.resolve('../backend-switch.cjs'), 'utf8');
  const begin = source.indexOf('function serviceProcess('), end = source.indexOf('const psCommand =', begin);
  assert.ok(begin > 0 && end > begin);
  let lock = '43', commands = 0; const identity = { pid: 42, started: 1 };
  const context = { fs: { readFileSync: () => lock }, path, uiError: locale.createError, processIdentity: () => identity };
  vm.runInNewContext(source.slice(begin, end) + ';globalThis.check = serviceProcess;', context);
  const command = () => { commands++; return '/fixture/backend/runtimes/v1/daemon.cjs'; };
  assert.throws(() => context.check('/fixture/backend', 42, command), error => error.message === '后台进程记录不一致；没有结束任何进程。' && locale.errorText('en', error).includes('no processes were ended'));
  assert.equal(commands, 0, 'A mismatched lock never reaches process command inspection');
  lock = '42';
  assert.throws(() => context.check('/fixture/backend', 42, () => 'unrelated process'), error => error.uiMessage?.key === 'error.backendSwitchProcessUnconfirmed');
  assert.equal(context.check('/fixture/backend', 42, command), identity); assert.equal(commands, 1);
});

test('only a Claude session whose runtime proves nothing would be lost may move automatically', () => {
  const plan = record => sessionPlan(record, record.state);
  assert.equal(plan(claudeNew()).auto, true);
  assert.equal(plan(claudeNew({ background: null, scheduled: null })).auto, true, 'No turn since the process started');
  const old = claudeNew(); delete old.terminalInputPending; delete old.backgroundStale;
  assert.deepEqual([plan(old).auto, Boolean(plan(old).stop)], [false, true], 'Old runtimes: one click only');
  assert.match(plan(old).reason, /版本无法确认/);
  assert.match(plan(claudeNew({ terminalInputPending: true })).reason, /启动后在终端里输入过/);
  assert.match(plan(claudeNew({ backgroundStale: true })).reason, /还没有新的后台任务报告/);
  assert.match(plan(claudeNew({ background: null, scheduled: 0 })).reason, /还没有新的后台任务报告/);
  assert.match(plan(claudeNew({ fleet: [{ event: 'SubagentStart', id: 'old-child', stale: true }] })).reason, /以前观察到的子 agent/);
  for (const event of ['TeammateIdle', 'TaskCompleted']) for (const stale of [false, true]) assert.match(plan(claudeNew({ fleet: [{ event, id: 'mate', stale }] })).reason || '', /团队成员（Agent Teams）/, event + stale);
  for (const codex of [codexNew(), codexNew({ idleAt: 0 })]) {
    assert.equal(plan(codex).auto, false, 'Codex is never moved automatically'); assert.match(plan(codex).reason, /结束这个后台里的 Codex 程序/);
  }
});
test('busy, pending, relaying, child-running or possibly running sessions block both automatic and one-click moves', () => {
  const plan = (record, running) => sessionPlan(record, record.state, running);
  for (const [record, pattern, running] of [
    [claudeNew({ background: 2 }), /后台任务在跑 · 2 项/], [claudeNew({ scheduled: 1 }), /有定时唤醒 · 1 项/],
    [claudeNew({ state: 'working' }), /正在工作/], [codexNew({ state: 'disconnected' }), /原生回合可能仍在运行/], [claudeNew({ state: 'error' }), /状态异常/],
    [claudeNew({ pendingTag: 't' }), /接收结果/], [codexNew({ approval: { id: 1 } }), /权限确认/], [claudeNew({ capacityRecovery: { status: 'scheduled' } }), /满载/],
    [claudeNew({ nativeId: null }), /原生身份/], [claudeNew({ state: 'ended', processIdentity: { pid: process.pid } }), /可能仍在运行/],
    [claudeNew({ fleet: [{ event: 'SubagentStart', id: 'teammate', stale: false }] }), /子 agent 或团队成员可能还在运行（1 个）/],
    [codexNew({ fleet: [{ event: 'thread/started', id: 'child-thread', stale: false }] }), /子 agent 或团队成员可能还在运行/],
    [claudeNew({ fleet: [{ event: 'subAgentActivity', nativeId: 'a', kind: 'started', stale: false }] }), /子 agent/],
    [claudeNew(), /正在进行的自动接力/, new Set(['c'])],
  ]) assert.match(plan(record, running).block || '', pattern, JSON.stringify(record));
  assert.equal(plan(claudeNew({ fleet: [{ event: 'SubagentStart', id: 't', stale: false }, { event: 'SubagentStop', id: 't', stale: false }] })).auto, true, 'A child seen ending no longer blocks');
  assert.deepEqual(plan({ ...claudeNew(), state: 'ended', processIdentity: null }), { carry: true });
  assert.deepEqual(plan({ ...codexNew(), state: 'recoverable', serverIdentity: { pid: 999999999 } }), { carry: true });
  const backend = (sessions, extra = {}) => backendPlan({ servicePid: 4242, capabilities: caps, sessions, ...extra }, record => record.state);
  assert.deepEqual([backend([claudeNew()]).ready, backend([claudeNew()]).auto, backend([claudeNew()]).endsCodex], [true, true, false]);
  const mixed = backend([claudeNew(), codexNew()]);
  assert.deepEqual([mixed.ready, mixed.auto, mixed.stops.length, mixed.endsCodex], [true, false, 2, true], 'Any Codex makes the whole backend one-click');
  const relay = backend([claudeNew()], { rooms: [{ run: { status: 'running', ids: ['c', 'elsewhere'] } }] });
  assert.equal(relay.ready, false); assert.match(relay.reason, /正在进行的自动接力/);
  assert.equal(backend([claudeNew()], { room: { run: { status: 'paused', ids: ['c'] } } }).ready, true, 'A paused relay does not block');
  const blocked = backend([claudeNew(), codexNew({ state: 'working' })]);
  assert.deepEqual([blocked.ready, blocked.auto], [false, false]); assert.match(blocked.reason, /^等空闲后更新：Codex 秘书正在工作/);
  assert.equal(backendPlan({ servicePid: 4242, capabilities: ['resume'], sessions: [claudeNew()] }).ready, false);
  assert.equal(backendPlan({ capabilities: caps, sessions: [claudeNew()] }).ready, false, 'No service PID, no move');
  assert.equal(backendPlan({ servicePid: 4242, capabilities: caps, storageWarning: 'x', sessions: [claudeNew()] }).ready, false);
  assert.equal(backend([{ ...claudeNew(), state: 'ended' }]).auto, false, 'Nothing to stop is never an automatic move');
});
test('automatic updates default on, automatic migration defaults off, and each is one stored boolean', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-switch-settings-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(readSettings(dir), { auto: true, migrate: false });
  assert.deepEqual(writeSettings(dir, false), { auto: false, migrate: false }); assert.deepEqual(writeSettings(dir, true), { auto: true, migrate: false });
  // Migration is the person's standing confirmation; changing automatic updates keeps it as it was.
  assert.deepEqual(writeSettings(dir, false, true), { auto: false, migrate: true });
  assert.deepEqual(writeSettings(dir, true), { auto: true, migrate: true });
  assert.deepEqual(writeSettings(dir, true, false), { auto: true, migrate: false });
  assert.equal((fs.statSync(path.join(dir, 'backend-switch-settings.json')).mode & 0o777), 0o600);
});

// A synthetic service on a short Unix socket. Its process is a sleeping child.
async function service(directory, state, { onStop } = {}) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const transport = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-')), endpoint = path.join(transport, 's.sock'), sockets = new Set(), calls = [];
  for (const record of state.sessions) record.draftRevision ??= 0;
  const child = spawn('/bin/sleep', ['60'], { stdio: 'ignore' }); state.servicePid = child.pid;
  fs.writeFileSync(path.join(directory, 'service.lock'), String(child.pid));
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let owner;
    readFrames(socket, REQUEST_BYTES, request => {
        if (owner === undefined) { owner = request.owner; socket.write(JSON.stringify({ ready: true }) + '\n'); return; }
        calls.push([request.method, request.args?.[0], owner, request.args?.[1]]);
        let value = true, error = null, uiMessage = null;
        const record = state.sessions.find(s => s.id === request.args?.[0]);
        if (request.method === 'initial') value = state;
        else if (request.method === 'maintenanceStop') { const next = onStop?.(record, state); if (next === 'reject') { record.state = 'error'; error = '原生未确认结束状态。'; }
          else if (next?.refuse) {
            // As a backend whose Claude terminal ended itself during the stop: ended, both revisions moved, its own receipt refused.
            record.state = 'ended';
            record.controlRevision += next.refuse.delta;
            record.connectionRevision = (record.connectionRevision || 0) + (next.refuse.connectionDelta ?? next.refuse.delta);
            Object.assign(record, next.refuse.changes || {});
            error = '没有确认断开原生会话。'; uiMessage = { version: 1, key: 'error.backendSwitchDisconnectUnconfirmed', params: { name: record.name } };
          } else { record.state = next || (record.provider === 'codex' ? 'disconnected' : 'ended'); record.controlRevision = (record.controlRevision || 0) + 1; record.connectionRevision = (record.connectionRevision || 0) + 1; value = { stopped: true, expected: request.args[1], stoppedState: { ...request.args[1], controlRevision: record.controlRevision, connectionRevision: record.connectionRevision, state: record.state } }; } }
        else if (request.method === 'terminalSnapshot') value = (state.screens || {})[request.args?.[0]] || { buffer: '', cols: 80, rows: 24 };
        else if (request.method === 'maintenanceResume') { // Same states the real resume accepts (ended/recoverable/error; disconnected Codex reconnects).
          if (!['ended', 'recoverable', 'error', 'disconnected'].includes(record.state)) error = '这个会话目前不能恢复。'; else record.state = 'idle'; }
        else if (['shutdown', 'maintenanceShutdown'].includes(request.method)) {
          if (request.method === 'maintenanceShutdown') {
            const { Workspace } = require('../workspace.cjs'), guard = Object.create(Workspace.prototype);
            Object.assign(guard, { sessions: new Map(state.sessions.map(s => [s.id, s])), runtimes: new Map(), stops: new Map(),
              draftRevisions: new Map(state.sessions.map(s => [s.id, s.draftRevision])), rooms: new Map() });
            try { guard.assertMaintenanceShutdown(request.args[0]); } catch (failure) { error = failure.message; }
          } else if (state.sessions.some(s => !['ended', 'background'].includes(s.state))) error = '请先结束各原生会话，再关闭运行服务。';
          if (!error) setTimeout(() => api.die(), 10);
        }
        socket.write(JSON.stringify({ id: request.id, ok: !error, error, value, ...(uiMessage ? { uiMessage } : {}) }) + '\n');
    });
  });
  fs.writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ protocol: 1, endpoint, token: 'synthetic' }), { mode: 0o600 });
  await new Promise(resolve => server.listen(endpoint, resolve));
  const api = { state, calls, pid: child.pid, signals: [],
    async die() { for (const socket of sockets) socket.destroy(); child.kill('SIGKILL'); await new Promise(resolve => server.close(resolve)); fs.rmSync(path.join(directory, 'service.lock'), { force: true }); fs.rmSync(transport, { recursive: true, force: true }); },
    async close() { if (child.exitCode === null && child.signalCode === null) await api.die(); } };
  return api;
}
function harness(t, sessions) {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-switch-'))), key = 'backends/' + 'a'.repeat(20), directory = path.join(dataDir, key);
  const services = [];
  t.after(async () => { for (const s of services) await s.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return {
    dataDir, key, directory, services,
    async old() { const s = await service(directory, { runtimeVersion: '0.1.0-alpha.157', capabilities: caps, sessions: structuredClone(sessions), room: { messages: [] } }); services.push(s); return s; },
    // The current code reloads the store: ended stays ended, anything else live becomes recoverable.
    ensure: (stateFor = old => old.sessions.map(r => ({ ...r, owner: null, controlRevision: 0, draftRevision: 0, state: r.state === 'ended' ? 'ended' : 'recoverable' }))) => async (dir, exe, k) => {
      assert.equal(dir, dataDir); assert.equal(k, key);
      const next = await service(directory, { runtimeVersion: '0.1.0-alpha.158', capabilities: caps, sessions: stateFor(services[0].state), room: { messages: [] } }); services.push(next);
    },
    command: s => pid => { assert.equal(pid, s.pid); return `/Applications/NAW --disable-sigusr1 ${directory}/runtimes/0123456789abcdef/daemon.cjs ${directory}`; },
    signal: s => (pid, name) => { assert.ok(directory.startsWith(fs.realpathSync(os.tmpdir())), 'Only a temporary test service can be signalled'); assert.equal(pid, s.pid); s.signals.push(name); s.die(); },
  };
}
const methods = s => s.calls.map(([method, id]) => id ? `${method}:${id}` : method).filter(m => m !== 'initial').map(m => m.startsWith('maintenanceShutdown:') ? 'maintenanceShutdown' : m);

const record = (dir, key) => readRecords(dir)[key] || null;
const ownersOf = (s, method) => s.calls.filter(([m]) => m === method).map(([, id, owner]) => `${id}:${owner}`);
test('a Claude and a Codex session are stopped, the proven old service is retired, and only they are reconnected as their own owners', async t => {
  const h = harness(t, [claudeNew(), codexNew(), { id: 'done', nativeId: 'native-done', provider: 'claude', name: 'Ended', state: 'ended' }]);
  const old = await h.old(), expected = backendPlan(old.state, r => r.state);
  const result = await switchBackend({ dataDir: h.dataDir, key: h.key, executablePath: 'unused', expected, ensure: h.ensure(), owner: 'window-default',
    applicationVersion: '0.1.0-alpha.158', commandLine: h.command(old), signal: h.signal(old), now: () => now });
  assert.deepEqual(methods(old), ['maintenanceStop:c', 'maintenanceStop:x', 'maintenanceShutdown'], 'The new guarded shutdown replaces the signal bypass');
  assert.deepEqual(old.signals, []);
  const next = h.services[1];
  assert.deepEqual(methods(next), ['maintenanceResume:c', 'maintenanceResume:x'], 'The already-ended session is not reconnected');
  assert.deepEqual(ownersOf(next, 'maintenanceResume'), ['c:view-a', 'x:view-b'], 'Each session keeps its previous owner');
  assert.ok(!next.calls.some(([m]) => ['send', 'queue', 'steer', 'run', 'input'].includes(m)), 'NAW sends nothing');
  assert.deepEqual(result, { key: h.key, resumed: ['c', 'x'], left: [], confirmedByState: [] }); assert.equal(record(h.dataDir, h.key), null);
});
test('an all-Claude backend is retired with its own shutdown call, never a signal', async t => {
  const h = harness(t, [claudeNew()]); const old = await h.old();
  await switchBackend({ dataDir: h.dataDir, key: h.key, executablePath: 'unused', ensure: h.ensure(), owner: 'view-b', applicationVersion: '0.1.0-alpha.158', requireAuto: true,
    commandLine: h.command(old), signal: () => assert.fail('No signal when shutdown is allowed'), now: () => now });
  assert.deepEqual(methods(old), ['maintenanceStop:c', 'maintenanceShutdown']); assert.deepEqual(methods(h.services[1]), ['maintenanceResume:c']);
});
// The daily failure (2026-11-08, alpha.220 backend): a Claude terminal ended itself during the stop, so the
// backend refused its own receipt. Daily values: planned 284/18, settled 286/20.
const daily = extra => claudeNew({ controlRevision: 284, connectionRevision: 18, peerRevision: 4694, ...extra });
const refused = (changes = {}, delta = 2, connectionDelta = delta) => record => record.provider === 'claude' || changes.codex ? { refuse: { delta, connectionDelta, changes } } : null;
const oldWith = async (h, sessions, onStop) => {
  const old = await service(h.directory, { runtimeVersion: '0.1.0-alpha.157', capabilities: caps, sessions: structuredClone(sessions), room: { messages: [] } }, { onStop });
  h.services.push(old);
  return old;
};
// A session created and never reconnected has no connection revision yet (found by the real move test).
for (const [delta, made] of [[1, daily], [2, daily], [2, () => daily({ connectionRevision: undefined })]]) test(`a Claude stop its backend refused after the native end (+${delta}${made().connectionRevision === undefined ? ', never reconnected' : ''}) still moves the session and reconnects it as its owner`, async t => {
  const h = harness(t, [made()]);
  const old = await oldWith(h, [made()], refused({}, delta));
  const result = await switchBackend({ dataDir: h.dataDir, key: h.key, executablePath: 'unused', ensure: h.ensure(), owner: 'window-default',
    applicationVersion: '0.1.0-alpha.158', commandLine: h.command(old), now: () => now, settleMs: 300 });
  assert.deepEqual(methods(old), ['maintenanceStop:c', 'maintenanceShutdown']);
  assert.deepEqual(methods(h.services[1]), ['maintenanceResume:c']);
  assert.deepEqual(ownersOf(h.services[1], 'maintenanceResume'), ['c:view-a']);
  assert.deepEqual(result, { key: h.key, resumed: ['c'], left: [], confirmedByState: ['c'] });
  assert.equal(record(h.dataDir, h.key), null);
});
for (const [label, sessions, onStop] of [
  ['another owner took control', [daily()], refused({ owner: 'view-z' })],
  ['three revisions moved', [daily()], refused({}, 3)],
  ['the two revisions moved apart', [daily()], refused({}, 2, 1)],
  ['its process may still run', [daily()], refused({ processIdentity: { pid: process.pid } })],
  ['it went to the background', [daily()], refused({ state: 'background' })],
  ['a new native context is pending', [daily()], refused({ nativeContextPending: { nativeId: 'native-c', reason: 'clear' } })],
  ['a draft changed', [daily()], refused({ draftRevision: 1 })],
  ['it is a Codex session', [codexNew({ controlRevision: 9, connectionRevision: 4 })], refused({ codex: true })],
]) test(`a refused receipt is not taken as this stop when ${label}`, async t => {
  const h = harness(t, sessions);
  const old = await oldWith(h, sessions, onStop);
  await assert.rejects(switchBackend({ dataDir: h.dataDir, key: h.key, executablePath: 'unused', ensure: () => assert.fail('No new backend'), owner: 'window-default',
    applicationVersion: '0.1.0-alpha.158', commandLine: h.command(old), now: () => now, settleMs: 300 }), error => error.uiMessage?.key === 'error.backendSwitchDisconnectUnconfirmed');
  const id = sessions[0].id;
  assert.deepEqual(methods(old), [`maintenanceStop:${id}`], 'Nothing is put back on an unproven end, and the old service keeps running');
  assert.deepEqual(record(h.dataDir, h.key).sessions.map(s => s.id), [id], 'The session is named for the person to continue');
});
test('a refused Claude receipt taken as this stop is put back with its settled proof when a later stop fails', async t => {
  const two = [daily(), claudeNew({ id: 'c2', nativeId: 'native-c2', name: 'Claude 3', owner: 'view-c', controlRevision: 5, connectionRevision: 2 })];
  const h = harness(t, two);
  const old = await oldWith(h, two, record => record.id === 'c' ? { refuse: { delta: 2 } } : 'reject');
  await assert.rejects(switchBackend({ dataDir: h.dataDir, key: h.key, executablePath: 'unused', ensure: () => assert.fail('No new backend'), owner: 'window-default',
    applicationVersion: '0.1.0-alpha.158', commandLine: h.command(old), now: () => now, settleMs: 300 }));
  assert.deepEqual(methods(old), ['maintenanceStop:c', 'maintenanceStop:c2', 'maintenanceResume:c']);
  assert.deepEqual(ownersOf(old, 'maintenanceResume'), ['c:view-a'], 'Put back as its own owner');
  const proof = old.calls.find(([method, id]) => method === 'maintenanceResume' && id === 'c')[3];
  assert.deepEqual(proof, { id: 'c', nativeId: 'native-c', provider: 'claude', owner: 'view-a', view: null,
    controlRevision: 286, connectionRevision: 20, draftRevision: 0, peerRevision: 4694, state: 'ended' }, 'The settled state is what an old service compares');
  assert.deepEqual(record(h.dataDir, h.key).sessions.map(s => s.id), ['c2'], 'Only the unconfirmed second stop is left for the person');
});
test('a restored session with history larger than the request limit resumes using only bounded identity proof', async t => {
  const messages = [{ role: 'assistant', text: 'Synthetic retained history. '.repeat(250000) }];
  assert.ok(Buffer.byteLength(JSON.stringify(messages)) > REQUEST_BYTES, 'The response may contain more history than a request may carry');
  const h = harness(t, [codexNew({ messages, peerRevision: 7, connectionRevision: 4, controlRevision: 3 })]), old = await h.old();
  const result = await switchBackend({ dataDir: h.dataDir, key: h.key, executablePath: 'unused', expected: backendPlan(old.state),
    ensure: h.ensure(), owner: 'view-default', applicationVersion: '0.1.0-alpha.158', commandLine: h.command(old), now: () => now });
  assert.deepEqual(result, { key: h.key, resumed: ['x'], left: [], confirmedByState: [] }, 'Large response history must not disconnect the resume request');
  const next = h.services[1], proof = next.calls.find(([method]) => method === 'maintenanceResume')?.[3];
  assert.deepEqual(proof, { id: 'x', nativeId: 'native-x', provider: 'codex', owner: null, view: null,
    controlRevision: 0, connectionRevision: 5, draftRevision: 0, peerRevision: 7, state: 'recoverable' });
  assert.ok(Buffer.byteLength(JSON.stringify(proof)) < 1024, 'Only fixed identity and revision fields belong in the request');
  assert.deepEqual(next.state.sessions[0].messages, messages, 'History stays on the service record unchanged');
  assert.equal(record(h.dataDir, h.key), null, 'Confirmed recovery clears the continuation record');
});
test('an automatic move never stops a session that is not proven at the moment of its stop', async t => {
  const h = harness(t, [claudeNew(), codexNew()]); const old = await h.old();
  await assert.rejects(switchBackend({ dataDir: h.dataDir, key: h.key, executablePath: 'unused', ensure: () => assert.fail(), applicationVersion: '0.1.0-alpha.158', requireAuto: true,
    commandLine: h.command(old), signal: () => assert.fail(), now: () => now }), /没有结束任何会话/);
  assert.deepEqual(methods(old), [], 'A backend with Codex is never moved automatically');
  const two = [claudeNew(), claudeNew({ id: 'c2', nativeId: 'native-c2', name: 'Claude 3', owner: 'view-c' })];
  const h2 = harness(t, two); const old2 = await service(h2.directory, { runtimeVersion: '0.1.0-alpha.157', capabilities: caps, sessions: structuredClone(two), room: { messages: [] } },
    { onStop: (r, state) => { if (r.id === 'c') state.sessions.find(s => s.id === 'c2').terminalInputPending = true; } }); h2.services.push(old2);
  await assert.rejects(switchBackend({ dataDir: h2.dataDir, key: h2.key, executablePath: 'unused', ensure: () => assert.fail(), applicationVersion: '0.1.0-alpha.158', requireAuto: true,
    commandLine: h2.command(old2), signal: () => assert.fail(), now: () => now }), /Claude 3 的状态已变化/);
  assert.deepEqual(methods(old2), ['maintenanceStop:c', 'maintenanceResume:c'], 'Typing in the second session during the move stops it before its stop');
  assert.deepEqual(ownersOf(old2, 'maintenanceResume'), ['c:view-a'], 'Put back as its own owner'); assert.equal(record(h2.dataDir, h2.key), null);
});
test('a move under the migration setting re-checks each session on fresh state and stops before ending new teamwork', async t => {
  const two = [claudeNew(), claudeNew({ id: 'c2', nativeId: 'native-c2', name: 'Claude 3', owner: 'view-c' })];
  const noTeam = record => !(record.fleet || []).some(event => event.event === 'TeammateIdle');
  const h = harness(t, two); const old = await service(h.directory, { runtimeVersion: '0.1.0-alpha.157', capabilities: caps, sessions: structuredClone(two), room: { messages: [] } },
    { onStop: (r, state) => { if (r.id === 'c') state.sessions.find(s => s.id === 'c2').fleet = [{ event: 'TeammateIdle' }]; } }); h.services.push(old);
  await assert.rejects(switchBackend({ dataDir: h.dataDir, key: h.key, executablePath: 'unused', ensure: () => assert.fail(), applicationVersion: '0.1.0-alpha.158', guard: noTeam,
    commandLine: h.command(old), signal: () => assert.fail(), now: () => now }), /Claude 3 的状态已变化/);
  assert.deepEqual(methods(old), ['maintenanceStop:c', 'maintenanceResume:c'], 'Teammates that started during the move stop it before that session ends');
  // A guard that refuses on the fresh plan ends nothing at all.
  const h2 = harness(t, [claudeNew({ fleet: [{ event: 'TeammateIdle' }] })]); const old2 = await h2.old();
  await assert.rejects(switchBackend({ dataDir: h2.dataDir, key: h2.key, executablePath: 'unused', ensure: () => assert.fail(), applicationVersion: '0.1.0-alpha.158', guard: noTeam,
    commandLine: h2.command(old2), signal: () => assert.fail(), now: () => now }), /没有结束任何会话/);
  assert.deepEqual(methods(old2), []);
});
test('a migration reads a terminal screen through the old backend itself, so the window\'s maintenance never blocks it', async t => {
  const h = harness(t, [claudeNew()]); const old = await h.old();
  old.state.screens = { c: { buffer: 'Claude Code\r\n> UNSENT_TEXT', cols: 80, rows: 24 } };
  const { saveTerminalScreen } = require('../queue-dispatch.cjs');
  const { connectService } = require('../service-client.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-screen-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = await saveTerminalScreen(owner => connectService(h.directory, owner), 'naw-migration', path.join(dir, 'rotation-terminals'), 'c', now);
  assert.match(fs.readFileSync(path.join(dir, file), 'utf8'), /> UNSENT_TEXT/);
  assert.deepEqual(methods(old), ['terminalSnapshot:c'], 'only a read; nothing stopped or claimed');
});
test('a service process that cannot be proven is never signalled and no session is stopped', async t => {
  const h = harness(t, [claudeNew(), codexNew()]); const old = await h.old();
  for (const commandLine of [() => '/usr/bin/other daemon.cjs', () => `/x ${h.dataDir}/runtimes/0/daemon.cjs`, () => undefined]) {
    await assert.rejects(switchBackend({ dataDir: h.dataDir, key: h.key, executablePath: 'unused', ensure: () => assert.fail('No new service'), applicationVersion: '0.1.0-alpha.158',
      commandLine, signal: () => assert.fail('Never signalled'), now: () => now }), /无法确认属于这个连接/);
  }
  fs.writeFileSync(path.join(h.directory, 'service.lock'), '1');
  await assert.rejects(switchBackend({ dataDir: h.dataDir, key: h.key, executablePath: 'unused', ensure: () => assert.fail('No new service'), applicationVersion: '0.1.0-alpha.158',
    commandLine: h.command(old), signal: () => assert.fail('Never signalled'), now: () => now }), /进程记录不一致/);
  assert.deepEqual(methods(old), []); assert.equal(record(h.dataDir, h.key), null);
});
test('a changed plan, an unconfirmed stop or a rejected stop puts every stopped session back on the old service as its own owner', async t => {
  const h = harness(t, [claudeNew(), codexNew()]); const old = await h.old();
  const stale = backendPlan({ ...old.state, sessions: [claudeNew()] }, r => r.state);
  await assert.rejects(switchBackend({ dataDir: h.dataDir, key: h.key, executablePath: 'unused', expected: stale, ensure: () => assert.fail(), applicationVersion: '0.1.0-alpha.158',
    commandLine: h.command(old), signal: () => assert.fail(), now: () => now }), /没有结束任何会话/);
  assert.deepEqual(methods(old), []);
  for (const [outcome, message] of [['error', /Codex 秘书 没有确认断开/], ['reject', /原生未确认结束状态/]]) {
    const h2 = harness(t, [claudeNew(), codexNew()]); const old2 = await service(h2.directory, { runtimeVersion: '0.1.0-alpha.157', capabilities: caps, sessions: [claudeNew(), codexNew()], room: { messages: [] } },
      { onStop: r => r.provider === 'codex' ? outcome : null }); h2.services.push(old2);
    await assert.rejects(switchBackend({ dataDir: h2.dataDir, key: h2.key, executablePath: 'unused', ensure: () => assert.fail('No new service'), applicationVersion: '0.1.0-alpha.158',
      commandLine: h2.command(old2), signal: () => assert.fail('Never signalled'), now: () => now }), message);
    assert.deepEqual(methods(old2), ['maintenanceStop:c', 'maintenanceStop:x', 'maintenanceResume:c', ...(outcome === 'reject' ? [] : ['maintenanceResume:x'])], outcome);
    assert.deepEqual(ownersOf(old2, 'maintenanceResume'), ['c:view-a', ...(outcome === 'reject' ? [] : ['x:view-b'])]);
    if (outcome === 'reject') assert.deepEqual(record(h2.dataDir, h2.key).sessions.map(s => s.id), ['x'], 'Unknown stop stays recorded, never automatically resumed');
    else assert.equal(record(h2.dataDir, h2.key), null, 'Acknowledged stops were put back');
  }
});
test('every failure after the stops names the stopped sessions per backend, and another backend\'s move keeps them', async t => {
  const h = harness(t, [claudeNew({ owner: null }), codexNew()]); const old = await h.old();
  const result = await switchBackend({ dataDir: h.dataDir, key: h.key, executablePath: 'unused', ensure: h.ensure(), owner: null, applicationVersion: '0.1.0-alpha.158',
    commandLine: h.command(old), signal: h.signal(old), now: () => now });
  assert.deepEqual(result.left, ['c']); assert.deepEqual(record(h.dataDir, h.key).sessions.map(s => s.name), ['Claude 2']); assert.equal(record(h.dataDir, h.key).phase, 'stopped');
  // A second backend in the same profile moves cleanly; the first record stays.
  const otherKey = 'backends/' + 'b'.repeat(20), otherDir = path.join(h.dataDir, otherKey);
  const other = await service(otherDir, { runtimeVersion: '0.1.0-alpha.157', capabilities: caps, sessions: [claudeNew({ id: 'o', nativeId: 'native-o', name: 'Other' })], room: { messages: [] } }); h.services.push(other);
  await switchBackend({ dataDir: h.dataDir, key: otherKey, executablePath: 'unused', owner: 'view-b', applicationVersion: '0.1.0-alpha.158',
    ensure: async () => { h.services.push(await service(otherDir, { runtimeVersion: '0.1.0-alpha.158', capabilities: caps, sessions: [claudeNew({ id: 'o', nativeId: 'native-o', name: 'Other', owner: null, controlRevision: 0, state: 'ended' })], room: { messages: [] } })); },
    commandLine: pid => `/x ${otherDir}/runtimes/0/daemon.cjs ${pid}`, signal: () => assert.fail(), now: () => now });
  assert.deepEqual(Object.keys(readRecords(h.dataDir)), [h.key], 'Another backend\'s clean move does not clear this record');
  clearRecord(h.dataDir, h.key); assert.deepEqual(readRecords(h.dataDir), {});
  for (const [label, ensure] of [
    ['wrong identity', h2 => h2.ensure(old => old.sessions.map(r => ({ ...r, nativeId: 'other', state: 'ended' })))],
    ['new service fails to start', () => async () => { throw Error('Synthetic start failure'); }],
  ]) {
    const h2 = harness(t, [claudeNew()]); const old2 = await h2.old();
    await assert.rejects(switchBackend({ dataDir: h2.dataDir, key: h2.key, executablePath: 'unused', ensure: ensure(h2), owner: 'view-b', applicationVersion: '0.1.0-alpha.158',
      commandLine: h2.command(old2), signal: () => assert.fail(), now: () => now }));
    assert.deepEqual(record(h2.dataDir, h2.key)?.sessions.map(s => s.id), ['c'], label); assert.equal(record(h2.dataDir, h2.key).phase, 'stopped');
    assert.ok(h2.services.slice(1).every(s => !methods(s).includes('maintenanceResume:c')), 'No resume onto a different or missing service: ' + label);
  }
});

test('the confirmed plan must still be what is unproven, and the record names a session only once its stop is requested', async t => {
  const h = harness(t, [claudeNew(), claudeNew({ id: 'c2', nativeId: 'native-c2', name: 'Claude 3', owner: 'view-c' })]); const old = await h.old();
  const confirmed = backendPlan(old.state, r => r.state); old.state.sessions[1].terminalInputPending = true;
  await assert.rejects(switchBackend({ dataDir: h.dataDir, key: h.key, executablePath: 'unused', expected: confirmed, ensure: () => assert.fail(), applicationVersion: '0.1.0-alpha.158',
    commandLine: h.command(old), signal: () => assert.fail(), now: () => now }), /没有结束任何会话/, 'A new unproven part the person did not see stops the move');
  assert.deepEqual(methods(old), []);
  const seen = [], two = [claudeNew(), claudeNew({ id: 'c2', nativeId: 'native-c2', name: 'Claude 3', owner: 'view-c' })];
  const h2 = harness(t, two); const old2 = await service(h2.directory, { runtimeVersion: '0.1.0-alpha.157', capabilities: caps, sessions: structuredClone(two), room: { messages: [] } },
    { onStop: r => { seen.push([r.id, readRecords(h2.dataDir)[h2.key].sessions.map(s => s.id)]); } }); h2.services.push(old2);
  await switchBackend({ dataDir: h2.dataDir, key: h2.key, executablePath: 'unused', ensure: h2.ensure(), owner: 'view-b', applicationVersion: '0.1.0-alpha.158',
    commandLine: h2.command(old2), signal: () => assert.fail(), now: () => now });
  assert.deepEqual(seen, [['c', ['c']], ['c2', ['c', 'c2']]]);
});


test('a human changing controller or input mode after confirmation prevents every stop', async t => {
  for (const [label, change] of [
    ['controller', r => { r.owner = 'human-new-window'; }],
    ['input mode', r => { r.view = 'terminal'; }],
    ['control generation', r => { r.controlRevision++; }],
    ['native connection generation', r => { r.connectionRevision++; }],
  ]) {
    const h = harness(t, [claudeNew({ view: 'chat', controlRevision: 4, connectionRevision: 2, liveDraft: 'preserve this draft' })]);
    const old = await h.old(), expected = backendPlan(old.state, r => r.state);
    change(old.state.sessions[0]);
    let error;
    try { await switchBackend({ dataDir: h.dataDir, key: h.key, executablePath: 'unused', expected, ensure: h.ensure(), owner: 'view-default',
      applicationVersion: '0.1.0-alpha.158', commandLine: h.command(old), signal: h.signal(old), now: () => now }); }
    catch (e) { error = e; }
    assert.deepEqual(methods(old), [], label + ': the confirmed older controller must not stop or reclaim the session');
    assert.match(error?.message || '', /没有结束任何会话/, label);
    assert.equal(h.services.length, 1, label + ': no replacement service');
    assert.equal(old.state.sessions[0].liveDraft, 'preserve this draft');
    assert.equal(record(h.dataDir, h.key), null);
  }
});

test('a human control change while another session stops preserves the changed session and restores only the stopped one', async t => {
  for (const [label, change] of [
    ['controller', r => { r.owner = 'human-new-window'; }],
    ['input mode', r => { r.view = 'terminal'; }],
    ['control generation', r => { r.controlRevision++; }],
    ['native connection generation', r => { r.connectionRevision++; }],
  ]) {
    const sessions = [claudeNew({ view: 'chat', controlRevision: 4, connectionRevision: 2 }),
      claudeNew({ id: 'c2', nativeId: 'native-c2', name: 'Claude 3', owner: 'view-c', view: 'chat', controlRevision: 8, connectionRevision: 3, liveDraft: 'second human draft' })];
    const h = harness(t, sessions), old = await service(h.directory,
      { runtimeVersion: '0.1.0-alpha.157', capabilities: caps, sessions: structuredClone(sessions), room: { messages: [] } },
      { onStop: (r, state) => { if (r.id === 'c') change(state.sessions.find(s => s.id === 'c2')); } });
    h.services.push(old);
    const expected = backendPlan(old.state, r => r.state); let error;
    try { await switchBackend({ dataDir: h.dataDir, key: h.key, executablePath: 'unused', expected, ensure: h.ensure(), owner: 'view-default',
      applicationVersion: '0.1.0-alpha.158', commandLine: h.command(old), signal: h.signal(old), now: () => now }); }
    catch (e) { error = e; }
    assert.deepEqual(methods(old), ['maintenanceStop:c', 'maintenanceResume:c'], label + ": do not stop the person's changed session");
    assert.match(error?.message || '', /Claude 3 的状态已变化/, label);
    assert.deepEqual(ownersOf(old, 'maintenanceResume'), ['c:view-a']);
    assert.equal(h.services.length, 1, label + ': retain existing service');
    assert.equal(old.state.sessions[1].state, 'idle');
    assert.equal(old.state.sessions[1].nativeId, 'native-c2');
    assert.equal(old.state.sessions[1].liveDraft, 'second human draft');
    assert.equal(record(h.dataDir, h.key), null);
  }
});

test('missing or malformed menu control proof cannot match a plan', () => {
  const plan = backendPlan({ servicePid: 42, capabilities: caps, sessions: [claudeNew()] });
  for (const value of [undefined, null, {}, { stops: null }, { stops: [null] }, { stops: [] }]) assert.equal(samePlan(plan, value), false);
  assert.equal(samePlan(plan, JSON.parse(JSON.stringify(plan))), true, 'The real menu transport preserves the proof');
});

for (const occupied of [false, true]) test('carried recoverable records pass the real final guard, occupied='+occupied, async t => {
  const carried = claudeNew({ id: 'saved', nativeId: 'saved-native', state: 'recoverable', owner: null });
  const h = harness(t, [...(occupied ? [codexNew()] : []), carried]), old = await h.old();
  const result = await switchBackend({ dataDir: h.dataDir, key: h.key, executablePath: 'unused', ensure: h.ensure(), owner: 'original-view',
    applicationVersion: '0.1.0-alpha.158', commandLine: h.command(old), signal: () => assert.fail('No signal bypass'), now: () => now });
  assert.deepEqual(result.resumed, occupied ? ['x'] : []);
  assert.equal(record(h.dataDir, h.key), null);
  assert.ok(!methods(h.services[1]).some(m => m.endsWith(':saved')), 'Do not start a merely carried session');
});
