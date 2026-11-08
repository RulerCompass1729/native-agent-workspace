const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const identity = { threadId: 'synthetic-sender', sessionId: 'synthetic-session', callId: 'synthetic-call',
  'x-codex-turn-metadata': { thread_id: 'synthetic-sender', turn_id: 'synthetic-turn' } };
const body = { recipient_id: 'synthetic-recipient', message: '  Keep this body\nunchanged.  ' };

async function fixture(t, respond) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'message-transport-'));
  const socketPath = path.join(dir, 'hook.sock');
  let connections = 0, requests = [];
  const sockets = new Set();
  const server = respond && net.createServer(socket => {
    connections++; sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {}); socket.setEncoding('utf8'); let input = '';
    socket.on('data', chunk => {
      input += chunk;
      if (!input.includes('\n')) return;
      requests.push(JSON.parse(input.slice(0, input.indexOf('\n'))));
      respond(socket);
    });
  });
  if (server) { server.listen(socketPath); await once(server, 'listening'); }
  const child = spawn(process.execPath, [path.join(__dirname, '../claude-message-tool.cjs'), '--codex'], {
    env: { ...process.env, NAW_MESSAGE_SOCKET: socketPath, NAW_MESSAGE_TOKEN: 'synthetic-token' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const exited = once(child, 'exit');
  let stdout = '', stderr = ''; const pending = new Map(); let sequence = 0;
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => {
    stdout += chunk;
    for (let end; (end = stdout.indexOf('\n')) >= 0;) {
      const row = JSON.parse(stdout.slice(0, end)); stdout = stdout.slice(end + 1);
      pending.get(row.id)?.(row); pending.delete(row.id);
    }
  });
  t.after(async () => {
    child.stdin.end(); await exited;
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(stderr, '');
  });
  const call = (method, params) => new Promise(resolve => {
    const id = ++sequence; pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await call('initialize', {});
  return { call: () => call('tools/call', { name: 'workspace_message', arguments: body, _meta: identity }),
    observed: () => ({ connections, requests }) };
}

test('actual MCP reports no send when the local socket never connects', { timeout: 5000 }, async t => {
  const f = await fixture(t, null); const result = await f.call();
  assert.match(result.error.message, /not sent/i);
  assert.doesNotMatch(result.error.message, /unconfirmed/i);
  assert.match(result.error.message, /do not retry/i);
  assert.deepEqual(f.observed(), { connections: 0, requests: [] });
});

for (const [name, reply] of [
  ['closed response', socket => socket.end()],
  ['invalid response', socket => socket.end('not-json\n')],
  ['oversized response', socket => socket.end('x'.repeat(16385))]
]) test('actual MCP retains unknown outcome after one write: ' + name, { timeout: 5000 }, async t => {
  const f = await fixture(t, reply); const result = await f.call();
  assert.match(result.error.message, /unconfirmed; do not retry/i);
  assert.doesNotMatch(result.error.message, /not sent/i);
  const actual = f.observed(); assert.equal(actual.connections, 1); assert.equal(actual.requests.length, 1);
  assert.deepEqual(actual.requests[0], { token: 'synthetic-token', workspaceMessage: true,
    identity: { nativeId: identity.threadId, sessionId: identity.sessionId, turnId: 'synthetic-turn', callId: identity.callId }, arguments: body });
});
