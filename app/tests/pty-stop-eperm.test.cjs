// Real Terminal.stop -> real PTY host -> owned synthetic child. No provider.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const cp = require('node:child_process');
const { once } = require('node:events');
const { pythonExecutable } = require('../platform.cjs');

test('Terminal.stop confirms a child that exited before SIGTERM returned zombie EPERM', { timeout: 10000 }, async t => {
  const file = require.resolve('../adapters.cjs'), isolated = new Module(file, module);
  isolated.filename = file; isolated.paths = Module._nodeModulePaths(path.dirname(file));
  const original = isolated.require.bind(isolated);
  const trace = []; let stderr = '', worker, wire = '';
  isolated.require = name => name === 'node:child_process' ? { ...cp, spawn(binary, args, options) {
    assert.equal(path.basename(args[0]), 'pty_host.py');
    worker = cp.spawn(binary, ['-B', path.join(__dirname, 'fixtures/pty-term-zombie.py'), ...args],
      { ...options, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    let pending = '';
    worker.stdio[3].setEncoding('utf8');
    worker.stdio[3].on('data', chunk => {
      pending += chunk;
      for (let at; (at = pending.indexOf('\n')) >= 0;) {
        trace.push(JSON.parse(pending.slice(0, at))); pending = pending.slice(at + 1);
      }
    });
    worker.stderr.on('data', chunk => { stderr += chunk; });
    worker.stdout.on('data', chunk => { wire += chunk; });
    return worker;
  } } : original(name);
  isolated._compile(fs.readFileSync(file, 'utf8'), file);
  const terminal = new isolated.exports.Terminal([pythonExecutable(), '-B', '-c', 'import os;os._exit(23)'],
    path.resolve(__dirname, '../..'));
  const closed = once(terminal, 'closed');
  t.after(async () => {
    if (terminal.alive) worker.stdin.end();
    await closed;
    terminal.cursorModes.dispose(); terminal.keyboardModes.dispose(); terminal.screen.dispose();
  });
  let error;
  try { await terminal.stop(); } catch (failure) { error = failure; }
  const [result] = await closed;
  const records = wire.trim().split('\n').map(line => JSON.parse(line));
  t.diagnostic(JSON.stringify({ trace, records, stderr, stopError: error?.message, confirmed: result.confirmed }));
  assert.ok(trace.some(row => row.phase === 'zombie'), 'The real owned child is a zombie before TERM');
  if (process.platform === 'darwin') assert.ok(trace.some(row => row.phase === 'killpg' && row.signal === 15 && row.errno === 1), 'Actual macOS EPERM');
  assert.ifError(error);
  assert.equal(result.confirmed, true);
  assert.equal(terminal.nativeExited, true);
  assert.equal(worker.exitCode, 0, stderr);
  assert.deepEqual(records.filter(row => row.type === 'exit'), [{ type: 'exit', code: 23 }]);
  assert.ok(trace.some(row => row.phase === 'waitpid' && row.pid === terminal.pid && !row.cleanup), 'The product reaps its own child');
  assert.equal(trace.filter(row => row.phase === 'killpg' && row.signal).length, 1, 'No retry or SIGKILL after reap');
  assert.throws(() => process.kill(terminal.pid, 0), { code: 'ESRCH' });
});
