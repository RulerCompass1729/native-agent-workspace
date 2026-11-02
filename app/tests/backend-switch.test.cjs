// Moving idle sessions to the current backend (T-122). Services here are
// synthetic sockets in temporary directories; the "service process" is a
// sleeping child this test owns, so no real backend can ever be signalled.
for (const key of ['NAW_WORKSPACE', 'NAW_APP_VERSION', 'NAW_RUNTIME_CONFIG']) delete process.env[key];
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { backendPlan, sessionPlan, switchBackend, readRecords, clearRecord, readSettings, writeSettings } = require('../backend-switch.cjs');

const now = 1_800_000_000_000;
const claudeNew = (extra = {}) => ({ id: 'c', nativeId: 'native-c', provider: 'claude', name: 'Claude 2', state: 'idle', owner: 'view-a',
  terminalInputPending: false, backgroundStale: false, background: 0, scheduled: 0, ...extra });
const codexNew = (extra = {}) => ({ id: 'x', nativeId: 'native-x', provider: 'codex', name: 'Codex 秘书', state: 'idle', owner: 'view-b', terminalInputPending: false, ...extra });
const caps = ['atomicShutdown', 'resume'];

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
test('the automatic setting defaults on and is one stored boolean', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-switch-settings-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(readSettings(dir), { auto: true });
  assert.deepEqual(writeSettings(dir, false), { auto: false }); assert.deepEqual(writeSettings(dir, true), { auto: true });
  assert.equal((fs.statSync(path.join(dir, 'backend-switch-settings.json')).mode & 0o777), 0o600);
});

// A synthetic service on a short Unix socket. Its process is a sleeping child.
async function service(directory, state, { onStop } = {}) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const transport = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-')), endpoint = path.join(transport, 's.sock'), sockets = new Set(), calls = [];
  const child = spawn('/bin/sleep', ['60'], { stdio: 'ignore' }); state.servicePid = child.pid;
  fs.writeFileSync(path.join(directory, 'service.lock'), String(child.pid));
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = '', owner;
    socket.on('data', chunk => {
      buffer += chunk;
      for (let end; (end = buffer.indexOf('\n')) >= 0;) {
        const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (owner === undefined) { owner = request.owner; socket.write(JSON.stringify({ ready: true }) + '\n'); continue; }
        calls.push([request.method, request.args?.[0], owner]);
        let value = true, error = null;
        const record = state.sessions.find(s => s.id === request.args?.[0]);
        if (request.method === 'initial') value = state;
        else if (request.method === 'stop') { const next = onStop?.(record, state); if (next === 'reject') { record.state = 'error'; error = '原生未确认结束状态。'; } else record.state = next || (record.provider === 'codex' ? 'disconnected' : 'ended'); }
        else if (request.method === 'resume') { // Same states the real resume accepts (ended/recoverable/error; disconnected Codex reconnects).
          if (!['ended', 'recoverable', 'error', 'disconnected'].includes(record.state)) error = '这个会话目前不能恢复。'; else record.state = 'idle'; }
        else if (request.method === 'shutdown') {
          if (state.sessions.some(s => !['ended', 'background'].includes(s.state))) error = '请先结束各原生会话，再关闭运行服务。';
          else setTimeout(() => api.die(), 10);
        }
        socket.write(JSON.stringify({ id: request.id, ok: !error, error, value }) + '\n');
      }
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
    ensure: (stateFor = old => old.sessions.map(r => ({ ...r, state: r.state === 'ended' ? 'ended' : 'recoverable' }))) => async (dir, exe, k) => {
      assert.equal(dir, dataDir); assert.equal(k, key);
      const next = await service(directory, { runtimeVersion: '0.1.0-alpha.158', capabilities: caps, sessions: stateFor(services[0].state), room: { messages: [] } }); services.push(next);
    },
    command: s => pid => { assert.equal(pid, s.pid); return `/Applications/NAW --disable-sigusr1 ${directory}/runtimes/0123456789abcdef/daemon.cjs ${directory}`; },
    signal: s => (pid, name) => { assert.ok(directory.startsWith(fs.realpathSync(os.tmpdir())), 'Only a temporary test service can be signalled'); assert.equal(pid, s.pid); s.signals.push(name); s.die(); },
  };
}
const methods = s => s.calls.map(([method, id]) => id ? `${method}:${id}` : method).filter(m => m !== 'initial');

const record = (dir, key) => readRecords(dir)[key] || null;
const ownersOf = (s, method) => s.calls.filter(([m]) => m === method).map(([, id, owner]) => `${id}:${owner}`);
test('a Claude and a Codex session are stopped, the proven old service is retired, and only they are reconnected as their own owners', async t => {
  const h = harness(t, [claudeNew(), codexNew(), { id: 'done', nativeId: 'native-done', provider: 'claude', name: 'Ended', state: 'ended' }]);
  const old = await h.old(), expected = backendPlan(old.state, r => r.state);
  const result = await switchBackend({ dataDir: h.dataDir, key: h.key, executablePath: 'unused', expected, ensure: h.ensure(), owner: 'window-default',
    applicationVersion: '0.1.0-alpha.158', commandLine: h.command(old), signal: h.signal(old), now: () => now });
  assert.deepEqual(methods(old), ['stop:c', 'stop:x'], 'The old guard refuses shutdown with a disconnected Codex, so no shutdown call is made');
  assert.deepEqual(old.signals, ['SIGTERM']);
  const next = h.services[1];
  assert.deepEqual(methods(next), ['resume:c', 'resume:x'], 'The already-ended session is not reconnected');
  assert.deepEqual(ownersOf(next, 'resume'), ['c:view-a', 'x:view-b'], 'Each session keeps its previous owner');
  assert.ok(!next.calls.some(([m]) => ['send', 'queue', 'steer', 'run', 'input'].includes(m)), 'NAW sends nothing');
  assert.deepEqual(result, { key: h.key, resumed: ['c', 'x'], left: [] }); assert.equal(record(h.dataDir, h.key), null);
});
test('an all-Claude backend is retired with its own shutdown call, never a signal', async t => {
  const h = harness(t, [claudeNew()]); const old = await h.old();
  await switchBackend({ dataDir: h.dataDir, key: h.key, executablePath: 'unused', ensure: h.ensure(), owner: 'view-b', applicationVersion: '0.1.0-alpha.158', requireAuto: true,
    commandLine: h.command(old), signal: () => assert.fail('No signal when shutdown is allowed'), now: () => now });
  assert.deepEqual(methods(old), ['stop:c', 'shutdown']); assert.deepEqual(methods(h.services[1]), ['resume:c']);
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
  assert.deepEqual(methods(old2), ['stop:c', 'resume:c'], 'Typing in the second session during the move stops it before its stop');
  assert.deepEqual(ownersOf(old2, 'resume'), ['c:view-a'], 'Put back as its own owner'); assert.equal(record(h2.dataDir, h2.key), null);
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
    assert.deepEqual(methods(old2), ['stop:c', 'stop:x', 'resume:c', 'resume:x'], outcome);
    assert.deepEqual(ownersOf(old2, 'resume'), ['c:view-a', 'x:view-b']);
    assert.equal(record(h2.dataDir, h2.key), null, 'Everything was put back');
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
    ensure: async () => { h.services.push(await service(otherDir, { runtimeVersion: '0.1.0-alpha.158', capabilities: caps, sessions: [claudeNew({ id: 'o', nativeId: 'native-o', name: 'Other', state: 'ended' })], room: { messages: [] } })); },
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
    assert.ok(h2.services.slice(1).every(s => !methods(s).includes('resume:c')), 'No resume onto a different or missing service: ' + label);
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
