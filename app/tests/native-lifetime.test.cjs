// Local process/protocol checks; no native model task or provider login.
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Terminal, NativeHost, executable } = require('../adapters.cjs');

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
