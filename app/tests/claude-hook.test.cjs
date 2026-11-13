const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { pythonExecutable } = require('../platform.cjs');

const HOOK = path.join(__dirname, '..', 'claude_hook.py');

// Runs the real forwarder with one hook payload and returns what it sent NAW.
async function forward(t, message) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-hook-')), socket = path.join(dir, 'h.sock');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const received = [];
  const server = net.createServer(c => { let body = ''; c.on('data', d => { body += d; }); c.on('end', () => received.push(body)); });
  await new Promise(resolve => server.listen(socket, resolve));
  t.after(() => server.close());
  const child = spawn(pythonExecutable(), ['-I', HOOK], { env: { PATH: process.env.PATH, NAW_HOOK_SOCKET: socket, NAW_HOOK_TOKEN: 'synthetic-token' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stdin.end(JSON.stringify(message));
  await new Promise(resolve => child.on('exit', resolve));
  for (let i = 0; i < 50 && !received.length; i += 1) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(stdout, '', 'An observation hook prints nothing');
  assert.equal(received.length, 1);
  return JSON.parse(received[0]);
}

const post = (tool, response) => ({ hook_event_name: 'PostToolUse', session_id: 'synthetic-native', prompt_id: 'turn', tool_name: tool, tool_use_id: 'toolu_1',
  tool_input: { command: 'PRIVATE_COMMAND', run_in_background: true }, tool_response: response });

test('a tool that starts background work forwards only that task\'s ID, as real Claude 2.1.322 reports it in PostToolUse', async t => {
  // Field names and values as the loopback probe recorded them (11-12).
  const bash = await forward(t, post('Bash', { stdout: 'PRIVATE_OUTPUT', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: 'boibvmuuk' }));
  assert.equal(bash.background_task_id, 'boibvmuuk');
  assert.deepEqual([bash.hook_event_name, bash.tool_name, bash.tool_use_id, bash.token], ['PostToolUse', 'Bash', 'toolu_1', 'synthetic-token']);
  const monitor = await forward(t, post('Monitor', { persistent: false, taskId: 'b4mkp6r05', timeoutMs: 10000 }));
  assert.equal(monitor.background_task_id, 'b4mkp6r05');
  for (const event of [bash, monitor]) {
    assert.ok(!JSON.stringify(event).includes('PRIVATE'), 'Nothing the tool ran or printed leaves the hook');
    assert.ok(!('tool_response' in event) && !('tool_input' in event));
  }
});

test('nothing else is forwarded as a background task', async t => {
  const cases = [
    ['a foreground Bash', post('Bash', { stdout: 'x', stderr: '', interrupted: false })],
    ['another tool\'s taskId', post('TaskCreate', { taskId: 'b4mkp6r05' })],
    ['a Bash taskId, not backgroundTaskId', post('Bash', { taskId: 'b4mkp6r05' })],
    ['a Monitor backgroundTaskId, not taskId', post('Monitor', { backgroundTaskId: 'b4mkp6r05' })],
    ['a number', post('Bash', { backgroundTaskId: 12345 })],
    ['a response that is not an object', post('Bash', 'b4mkp6r05')],
    ['the start of the call', { ...post('Bash', { backgroundTaskId: 'b4mkp6r05' }), hook_event_name: 'PreToolUse' }],
  ];
  for (const [label, message] of cases) assert.equal((await forward(t, message)).background_task_id, undefined, label);
  // Too long to be an ID: dropped whole, never cut to a different one.
  assert.equal((await forward(t, post('Bash', { backgroundTaskId: 'b'.repeat(65) }))).background_task_id, undefined);
  assert.equal((await forward(t, post('Bash', { backgroundTaskId: 'b'.repeat(64) }))).background_task_id, 'b'.repeat(64));
});
