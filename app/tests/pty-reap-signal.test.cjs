const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { pythonExecutable } = require('../platform.cjs');

function probe(t, scenario) {
  const python = pythonExecutable(); assert.ok(python, 'A Python runtime is required');
  const result = JSON.parse(execFileSync(python, [path.join(__dirname, 'fixtures/pty-reap-signal.py'),
    path.join(__dirname, '../pty_host.py'), scenario], { encoding: 'utf8', timeout: 5000 }));
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.records.filter(r => r.type === 'exit').length, 1, 'The worker exits once');
  assert.equal(result.schedule.reaped, true, 'The schedule actually reaches the kernel reap');
  return result;
}
test('SIGTERM between kernel reap and the Python flag never signals a reused process group', t => {
  const result = probe(t, 'signal-after-reap');
  assert.equal(result.schedule.injected, true, 'SIGTERM is delivered inside waitpid after the kernel reap');
  assert.ok(result.schedule.group_checks > 2, "A stop at the reap boundary requires group absence before confirmation");
  assert.deepEqual(result.signals, [], 'No TERM or KILL may address the now-foreign group');
});
for (const scenario of ['signal-while-alive', 'stubborn-then-reuse']) test(`${scenario}: stop still reaches the owned group with its full grace period`, t => {
  const result = probe(t, scenario);
  if (scenario === 'signal-while-alive') assert.equal(result.schedule.injected, true);
  assert.deepEqual(result.signals.map(s => [s.signal, s.target]), [[15, 'owned-group'], [9, 'owned-group']]);
  assert.ok(result.signals[1].at - result.signals[0].at >= 5, 'Allow five seconds after actual TERM delivery');
});
test('a zombie-only group can be reaped promptly without signalling a reused identity', t => {
  const result = probe(t, 'zombie-eperm');
  assert.deepEqual(result.signals.map(s => [s.signal, s.target]), [[15, 'owned-group']]);
  assert.ok(result.schedule.clock < 5, 'No unnecessary force-kill deadline wait');
});

test('initial SIGTERM EPERM reaps a dead leader and waits for group absence without more signals', t => {
  const result = probe(t, 'term-zombie-eperm');
  assert.deepEqual(result.signals.map(s => [s.signal, s.target]), [[15, 'owned-group']]);
  assert.ok(result.schedule.group_checks > 2, 'A reaped leader is insufficient while the group remains');
  assert.ok(result.schedule.clock < 5, 'The zombie does not consume the force-kill budget');
});

test('initial SIGTERM EPERM against a live leader remains an unconfirmed failure', () => {
  assert.throws(() => execFileSync(pythonExecutable(), [path.join(__dirname, 'fixtures/pty-reap-signal.py'),
    path.join(__dirname, '../pty_host.py'), 'term-live-eperm'], { encoding: 'utf8', timeout: 5000, stdio: 'pipe' }),
  error => {
    const result = JSON.parse(error.stdout);
    assert.equal(result.schedule.reaped, false, 'waitpid cannot reap a live child');
    assert.deepEqual(result.signals.map(s => s.signal), [15]);
    assert.equal(result.records.some(row => row.type === 'exit'), false);
    return error.status === 1 && /PermissionError:.*Synthetic group signal denied/.test(error.stderr);
  });
});

test('initial SIGTERM EPERM cannot confirm a reaped leader while a denied group still exists', () => {
  assert.throws(() => execFileSync(pythonExecutable(), [path.join(__dirname, 'fixtures/pty-reap-signal.py'),
    path.join(__dirname, '../pty_host.py'), 'term-surviving-group-eperm'], { encoding: 'utf8', timeout: 5000, stdio: 'pipe' }),
  error => {
    const result = JSON.parse(error.stdout);
    assert.equal(result.schedule.reaped, true);
    assert.ok(result.schedule.group_checks > 2);
    assert.deepEqual(result.signals.map(s => s.signal), [15], 'Never signal again after releasing the leader identity');
    assert.equal(result.records.some(row => row.type === 'exit'), false);
    return error.status === 1 && /Worker did not finish the finite schedule/.test(error.stderr);
  });
});

test('SIGTERM during select is handled before natural reap and clears a surviving owned child', t => {
  const result = probe(t, 'signal-before-natural-reap');
  assert.equal(result.schedule.injected, true);
  assert.deepEqual(result.signals.map(s => [s.signal, s.target]), [[15, 'owned-group'], [9, 'owned-group']]);
  assert.ok(result.signals[1].at - result.signals[0].at >= 5);
  assert.equal(result.schedule.child_alive, false, 'No numeric exit while the owned child survives');
});

test('real PTY stop during select waits for the surviving child before confirming exit', { timeout: 25000 }, t => {
  const python = pythonExecutable(); assert.ok(python);
  const result = JSON.parse(execFileSync(python, [path.join(__dirname, 'fixtures/pty-stop-during-select.py'),
    path.join(__dirname, '../pty_host.py')], { encoding: 'utf8', timeout: 22000 }));
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.workerReturnCode, 0, result.stderr);
  assert.equal(result.childAliveAfterExit, false, 'A numeric exit must not leave the same-group child alive');
  assert.ok(Number.isInteger(result.records.find(row => row.type === 'exit')?.code));
  assert.ok(result.elapsed >= 5, 'The stubborn child retains the full TERM grace period');
});
