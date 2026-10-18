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
  runtime.makeTerminal = () => (runtime.terminal = terminal);
  runtime.observeFirstTurn = async () => {};
  const states = []; runtime.on('state', state => states.push(state));
  const pending = runtime.startFromTerminal();
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
