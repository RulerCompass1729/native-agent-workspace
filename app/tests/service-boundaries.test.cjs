// Malformed local/native frames must not take down unrelated conversations.
// Real local daemon for authentication checks; no provider process or model.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { fork } = require('node:child_process'), { once, EventEmitter } = require('node:events');
const { connectService, ServiceClient } = require('../service-client.cjs');
const { Rpc } = require('../adapters.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('malformed or unauthorized local clients cannot crash or read the service', async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-boundary-test-'));
  const child = fork(path.resolve(__dirname, '../daemon.cjs'), [profile], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let client;
  t.after(async () => {
    client?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    }
    if (child.connected) child.disconnect();
    fs.rmSync(profile, { recursive: true, force: true });
  });
  const file = path.join(profile, 'connection.json');
  for (let i = 0; i < 150 && !fs.existsSync(file); i++) await delay(20);
  const info = JSON.parse(fs.readFileSync(file));
  client = await connectService(profile, 'valid-observer');
  const before = await client.call('initial');
  assert.equal(fs.statSync(info.endpoint).mode & 0o077, 0);
  assert.equal(fs.statSync(path.dirname(info.endpoint)).mode & 0o077, 0);
  assert.equal(fs.statSync(file).mode & 0o077, 0);
  const auth = JSON.stringify({ protocol: 1, token: info.token, owner: 'invalid-frame-client' }) + '\n';
  async function rejected(payload, authenticated) {
    const socket = net.connect(info.endpoint); socket.setEncoding('utf8');
    socket.on('error', () => {});
    let received = '';
    socket.on('data', chunk => { received += chunk; });
    const closed = once(socket, 'close');
    const timeout = setTimeout(() => socket.destroy(new Error('Peer did not reject malformed data')), 1500);
    try {
      await once(socket, 'connect');
      socket.write((authenticated ? auth : '') + payload + '\n');
      await closed;
      assert.equal(received, authenticated ? '{"ready":true}\n' : '');
      assert.equal(child.exitCode, null, 'Only the malformed client may be closed');
      const after = await client.call('initial');
      assert.equal(after.servicePid, before.servicePid);
      assert.deepEqual(after.sessions, before.sessions);
      assert.equal(after.diagnostics.dispatches, 0);
    } finally { clearTimeout(timeout); socket.destroy(); }
  }
  for (const payload of ['null', '[]', '1', '"text"', 'true', '{broken']) {
    await rejected(payload, false);
    await rejected(payload, true);
  }
  await rejected(JSON.stringify({ protocol: 1, token: 'wrong-synthetic-token', owner: 'unknown' }), false);
  await rejected(JSON.stringify({ protocol: 2, token: info.token, owner: 'wrong-protocol' }), false);
  await rejected('x'.repeat(2 * 1024 * 1024 + 1), false);
  await assert.rejects(client.call('nonexistent-operation'), /不支持/);
  assert.equal((await client.call('initial')).servicePid, before.servicePid);
});

test('non-object service responses close only their client and reject pending calls', async () => {
  for (const value of [null, [], 1, 'text', true]) {
    const socket = new EventEmitter(); socket.setEncoding = () => {}; socket.write = () => {};
    socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
    const client = new ServiceClient(socket);
    const pending = client.call('initial'), rejected = assert.rejects(pending, /断开/);
    assert.doesNotThrow(() => socket.emit('data', JSON.stringify(value) + '\n'));
    assert.equal(socket.destroyed, true); await rejected;
    assert.equal(client.pending.size, 0);
  }
});

test('non-object native RPC frames are ignored without losing a valid pending reply', async () => {
  const socket = new EventEmitter(); let request;
  socket.send = text => { request = JSON.parse(text); };
  const rpc = new Rpc(socket), pending = rpc.call('thread/read', { threadId: 'synthetic' });
  for (const value of [null, [], 1, 'text', true]) assert.doesNotThrow(() => socket.emit('message', Buffer.from(JSON.stringify(value))));
  socket.emit('message', Buffer.from(JSON.stringify({ id: request.id, result: { thread: { id: 'synthetic' } } })));
  assert.deepEqual(await pending, { thread: { id: 'synthetic' } });
  assert.equal(rpc.pending.size, 0);
});

test('a closed native RPC refuses a new call immediately without creating a timeout or write', async () => {
  const socket = new EventEmitter(); socket.readyState = 3;
  socket.send = () => { throw Error('A closed socket must not be written'); };
  const rpc = new Rpc(socket);
  await assert.rejects(rpc.call('thread/read', { threadId: 'synthetic' }), /连接已断开/);
  assert.equal(rpc.pending.size, 0);
});

test('empty-turn error is recognized exactly without leaking the native body', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const message = `thread ${id} is not materialized yet; thread/turns/list is unavailable before first user message`;
  for (const [code, text, expected] of [[-32600, message, id], [-32601, message, undefined], [-32600, message + ' private detail', undefined], [-32600, 'other native error', undefined]]) {
    const socket = new EventEmitter(); let sent;
    socket.send = text => { sent = JSON.parse(text); };
    const rpc = new Rpc(socket), pending = rpc.call('thread/turns/list', { threadId: id });
    socket.emit('message', JSON.stringify({ id: sent.id, error: { code, message: text } }));
    await assert.rejects(pending, error => error.nativeUnmaterializedThread === expected && !error.message.includes(id) && !error.message.includes('private detail'));
  }
});

test('missing-rollout classification carries only the exact native thread identity', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  for (const [text, expected] of [[`no rollout found for thread id ${id}`, id], [`no rollout found for thread id ${id} private detail`, undefined]]) {
    const socket = new EventEmitter(); let sent; socket.send = text => { sent = JSON.parse(text); };
    const rpc = new Rpc(socket), pending = rpc.call('thread/read', { threadId: id });
    socket.emit('message', JSON.stringify({ id: sent.id, error: { code: -32600, message: text } }));
    await assert.rejects(pending, error => error.nativeMissingHistoryThread === expected && !error.message.includes(id) && !error.message.includes('private detail'));
  }
});
