// Local process/protocol checks; no native model task or provider login.
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Terminal, NativeHost, executable } = require('../adapters.cjs');

test('Codex can finish human setup after two minutes without a model call', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = new NativeHost(os.tmpdir());
  const record = { provider: 'codex', nativeId: null, view: 'terminal', cwd: os.tmpdir() };
  const runtime = host.create(record);
  const terminal = new (require('node:events').EventEmitter)();
  runtime.makeTerminal = argv => {
    assert.ok(argv.includes(record.cwd));
    assert.ok(!argv.some(arg => ['-a', '--ask-for-approval', '-s', '--sandbox'].includes(arg)));
    return (runtime.terminal = terminal);
  };
  runtime.observeFirstTurn = async () => {};
  const states = []; runtime.on('state', state => states.push(state));
  const pending = runtime.startFromTerminal();
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(121000);
  assert.equal(typeof host.pendingCodex, 'function');
  assert.equal(record.nativeId, null);
  assert.ok(!states.includes('error'));
  host.pendingCodex({ id: 'late-trust-thread' });
  await pending;
  assert.equal(record.nativeId, 'late-trust-thread');
  assert.equal(host.codexTargets.get(record.nativeId), runtime);
  assert.equal(host.pendingCodex, null);
  assert.equal(terminal.listenerCount('closed'), 0);
  assert.equal(states.at(-1), 'idle');
});

test('canceling Codex setup releases its creation slot only after terminal exit', async () => {
  const host = new NativeHost(os.tmpdir());
  const runtime = host.create({ provider: 'codex', nativeId: null, view: 'terminal', cwd: os.tmpdir() });
  const terminal = new (require('node:events').EventEmitter)();
  let confirmExit;
  terminal.stop = () => new Promise(resolve => { confirmExit = () => { terminal.emit('closed', { confirmed: true }); resolve(); }; });
  runtime.makeTerminal = () => (runtime.terminal = terminal);
  const pending = host.createCodex(() => runtime.startFromTerminal());
  await new Promise(resolve => setImmediate(resolve));
  const rejection = assert.rejects(pending, /初始化已退出/);
  await Promise.resolve();
  let nextStarted = false;
  const next = host.createCodex(() => { nextStarted = true; });
  const stopping = runtime.stop();
  await Promise.resolve();
  assert.equal(nextStarted, false);
  assert.equal(typeof host.pendingCodex, 'function');
  confirmExit();
  assert.deepEqual(await stopping, { state: 'ended' });
  await rejection; await next;
  assert.equal(host.pendingCodex, null);
  assert.equal(nextStarted, true);
});

test('PTY stream EOF and ignored termination do not count as process exit', { timeout: 7000 }, async () => {
  const script = 'import os,signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);signal.signal(signal.SIGHUP,signal.SIG_IGN);print("READY",flush=True);[os.close(fd) for fd in (0,1,2)];time.sleep(60)';
  const terminal = new Terminal([executable('python3'), '-c', script], os.tmpdir());
  try {
    await new Promise(resolve => terminal.on('data', event => { if (event.data.includes('READY')) resolve(); }));
    await assert.rejects(terminal.stop(200), /未确认退出/);
    assert.equal(terminal.nativeExited, false);
    assert.equal(terminal.alive, true);
    assert.doesNotThrow(() => process.kill(terminal.pid, 0));
    const exited = once(terminal, 'closed');
    process.kill(terminal.pid, 'SIGKILL'); // Only the synthetic child created above.
    const [result] = await exited; assert.equal(result.confirmed, true);
    assert.throws(() => process.kill(terminal.pid, 0), { code: 'ESRCH' });
    await terminal.stop();
    terminal.screen.dispose();
  } finally {
    if (terminal.alive) { try { process.kill(terminal.pid, 'SIGKILL'); } catch {} }
  }
});

test('Codex unsubscribe acknowledgement is not thread termination', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-protocol-'));
  const host = new NativeHost(directory); host.binaries = { codex: 'synthetic', python: 'synthetic' };
  const runtime = host.create({ provider: 'codex', nativeId: 'synthetic-thread', view: 'chat', cwd: directory });
  host.codexTargets.set('synthetic-thread', runtime);
  let status = 'unsubscribed'; const calls = [];
  host.rpc = { call: async (method, params) => { calls.push(method); return { status }; } };
  try {
    assert.deepEqual(await runtime.stop(), { state: 'disconnected' });
    assert.equal(host.codexTargets.get('synthetic-thread'), runtime);
    status = 'notSubscribed'; assert.deepEqual(await runtime.stop(), { state: 'disconnected' });
    runtime.event({ method: 'thread/closed', params: { threadId: 'synthetic-thread' } });
    assert.deepEqual(await runtime.stop(), { state: 'ended' });
    assert.equal(host.codexTargets.has('synthetic-thread'), false);
    assert.ok(calls.every(method => method === 'thread/unsubscribe'));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('new Codex conversation delegates permission selection to native configuration for its directory', async () => {
  const host = new NativeHost(os.tmpdir());
  const record = { provider: 'codex', nativeId: null, view: 'chat', cwd: os.tmpdir() };
  const runtime = host.create(record), calls = [];
  host.startCodex = async () => {}; host.codexProcess = { pid: 123 };
  host.rpc = { call: async (method, params) => { calls.push({ method, params }); return { thread: { id: 'configured-native-thread' }, model: 'synthetic' }; } };
  await runtime.start();
  assert.equal(calls.length, 1); assert.equal(calls[0].method, 'thread/start');
  assert.equal(calls[0].params.cwd, record.cwd);
  for (const key of ['approvalPolicy', 'sandbox', 'permissions', 'config']) assert.equal(Object.hasOwn(calls[0].params, key), false);
  assert.equal(record.nativeId, 'configured-native-thread');
  assert.equal(host.codexTargets.get(record.nativeId), runtime);
});

test('failed Codex disconnect retains event observation and ownership for recovery', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-protocol-'));
  const host = new NativeHost(directory); host.binaries = { codex: 'synthetic', python: 'synthetic' };
  const runtime = host.create({ provider: 'codex', nativeId: 'synthetic-thread', view: 'chat', cwd: directory });
  host.codexTargets.set('synthetic-thread', runtime);
  host.rpc = { call: async () => { throw Error('Native connection failed'); } };
  const states = []; runtime.on('state', state => states.push(state));
  try {
    await assert.rejects(runtime.stop(), /Native connection failed/);
    assert.equal(runtime.stopped, false); assert.equal(host.codexTargets.get('synthetic-thread'), runtime);
    runtime.event({ method: 'turn/started', params: { turn: { id: 'synthetic-turn' } } });
    assert.equal(states.at(-1), 'working');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a restarted native display clears only its own obsolete exit notice', async t => {
  const { once } = require('node:events');
  const { Codex } = require('../adapters.cjs');
  const record = { cwd: require('node:os').tmpdir(), activity: '' };
  const r = new Codex(record, {});
  r.on('activity', text => { record.activity = text; });
  t.after(async () => { if (r.terminal?.alive) await r.terminal.stop(); });
  let terminal = r.makeTerminal([process.execPath, '-e', 'process.exit(0)']);
  await once(terminal, 'closed'); assert.match(record.activity, /原生终端已退出/);
  terminal = r.makeTerminal([process.execPath, '-e', 'setInterval(() => {}, 1000)']);
  await once(terminal, 'started'); assert.equal(record.activity, '');
  await terminal.stop(); record.activity = '保留其他原生确认状态';
  terminal = r.makeTerminal([process.execPath, '-e', 'setInterval(() => {}, 1000)']);
  await once(terminal, 'started'); assert.equal(record.activity, '保留其他原生确认状态');
});

test('remote display reopening rejects unknown exits and stale control, and concurrent opens share one display', async () => {
  const { Codex } = require('../adapters.cjs');
  let releaseRead, reads = 0, creations = 0;
  const record = { nativeId: 'same-thread', cwd: os.tmpdir() };
  const host = { codexTargets: new Map(), binaries: { codex: 'codex' }, rpc: { call: async () => { reads++; await new Promise(resolve => { releaseRead = resolve; }); return { thread: { id: record.nativeId, turns: [{ id: 'first-turn' }] } }; } } };
  const runtime = new Codex(record, host);
  runtime.terminal = { alive: false, nativeExited: false };
  runtime.makeTerminal = () => { creations++; return (runtime.terminal = { alive: true }); };
  await assert.rejects(runtime.openTerminal(), /退出尚未确认/);
  assert.equal(reads, 0);
  runtime.terminal.nativeExited = true;
  let owned = true;
  const stale = runtime.openTerminal(() => owned);
  await new Promise(resolve => setImmediate(resolve)); owned = false; releaseRead();
  await assert.rejects(stale, /控制权已变化/);
  assert.equal(creations, 0);
  runtime.hasHistory = true;
  const [a, b] = await Promise.all([runtime.openTerminal(), runtime.openTerminal()]);
  assert.equal(a, b); assert.equal(creations, 1);
  runtime.terminal = { alive: false, nativeExited: true };
  runtime.transportDisconnected = true;
  await assert.rejects(runtime.openTerminal(), /原生连接已断开/);
  assert.equal(creations, 1);
});
