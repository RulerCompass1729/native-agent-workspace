const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createInitialResponse } = require('../state-delta.cjs');
const { ServiceClient } = require('../service-connection.cjs');
const snapshot = () => ({ sessions: [{ id: 'actor', nativeId: 'native-a', messages: Array.from({ length: 100 }, (_, i) => ({ id: String(i), text: 'synthetic '.repeat(1000) })) }], rooms: [], available: { codex: true } });
function fixture() {
  const socket = new EventEmitter(); socket.setEncoding = () => {}; socket.write = () => {};
  socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
  socket.end = socket.destroy;
  const client = new ServiceClient(socket);
  return { client, reply(value) { socket.emit('data', JSON.stringify(value) + '\n'); } };
}
async function read(f, encoder, value, method = 'initial') {
  const pending = f.client.call(method);
  f.reply({ id: f.client.sequence, ok: true, ...encoder(value) });
  return pending;
}
test('fresh initial replies retain full metadata and bodies while unchanged history stays off the wire', async () => {
  const f = fixture(), encoder = createInitialResponse(), live = snapshot();
  const first = await read(f, encoder, live); assert.deepEqual(first, live);
  let frame; const capture = value => (frame = encoder(value));
  live.sessions[0].nativeId = 'native-b'; live.available.codex = false;
  const next = await read(f, capture, live);
  assert.deepEqual(next, live); assert.equal(next.sessions[0].messages.length, 100);
  assert.ok(JSON.stringify(frame).length < 1000); assert.equal(frame.initialDelta, 1);
  assert.ok(f.client.receivedOrder(next) > f.client.receivedOrder(first));
  live.sessions[0].messages[0].text = 'edited in place';
  assert.deepEqual(await read(f, encoder, live), live);
  live.sessions[0].messages.splice(3, 50);
  assert.deepEqual(await read(f, encoder, live), live);
  f.client.close();
});
test('RPC delta history is independent of coalesced state events and overlapping initial requests', async () => {
  const f = fixture(), encoder = createInitialResponse(), live = snapshot();
  await read(f, encoder, live);
  const broadcast = snapshot(); broadcast.sessions[0].messages = [{ text: 'different broadcast history' }];
  f.reply({ event: 'state', data: broadcast });
  const one = f.client.request('initial', [], null), idOne = f.client.sequence;
  const two = f.client.request('initial', [], null), idTwo = f.client.sequence;
  assert.notEqual(idOne, idTwo);
  assert.equal(f.client.pending.size, 2);
  assert.equal(f.client.pending.get(idOne).method, 'initial');
  assert.equal(f.client.pending.get(idTwo).method, 'initial');
  live.sessions[0].state = 'working'; const a = structuredClone(live);
  f.reply({ id: idTwo, ok: true, ...encoder(a) });
  live.sessions[0].messages.push({ text: 'fresh tail' });
  f.reply({ id: idOne, ok: true, ...encoder(live) });
  assert.deepEqual(await two, a); assert.deepEqual(await one, live);
  assert.deepEqual(f.client.lastState, broadcast);
  f.client.close();
});
test('old full initial responses still work; a new connection cannot borrow another connection history', async () => {
  const old = fixture(), live = snapshot();
  assert.deepEqual(await read(old, value => ({ value }), live), live);
  old.client.close();
  const encoder = createInitialResponse(); encoder(live);
  const fresh = fixture(), pending = fresh.client.call('initial');
  const rejected = assert.rejects(pending, /断开/);
  fresh.reply({ id: 1, ok: true, ...encoder(live) });
  await rejected; assert.equal(fresh.client.closeReason, 'initial-rebuild');
});
test('malformed or misrouted initial deltas fail closed and never settle a non-initial operation', async () => {
  for (const method of ['initial', 'create']) {
    const f = fixture(), encoder = createInitialResponse(), live = snapshot();
    await read(f, encoder, live);
    const pending = f.client.call(method), rejected = assert.rejects(pending, /断开/);
    const value = { sessions: [{ id: 'actor', messagesKeep: 101, messages: [] }], rooms: [] };
    f.reply({ id: f.client.sequence, ok: true, initialDelta: 1, value });
    await rejected; assert.equal(f.client.pending.size, 0);
  }
});

test('the daemon negotiates compact fresh replies; clients without negotiation still get full initial snapshots', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
  const { fork } = require('node:child_process'), { once } = require('node:events');
  const { connectService } = require('../service-connection.cjs');
  const responses = new WeakMap(), originalConnect = net.connect;
  net.connect = function (...args) {
    const socket = Reflect.apply(originalConnect, this, args), frames = [];
    responses.set(socket, frames); let buffered = '';
    socket.on('data', chunk => {
      buffered += chunk; let end;
      while ((end = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
        const frame = JSON.parse(line);
        if (Object.hasOwn(frame, 'id') && !frame.event && !frame.ready) frames.push({ id: frame.id, bytes: Buffer.byteLength(line + '\n') });
      }
    });
    return socket;
  };
  t.after(() => { net.connect = originalConnect; });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-snapshot-'));
  const child = fork(path.join(__dirname, 'fixtures/initial-delta-daemon.cjs'), [dir], {
    env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, NODE_OPTIONS: '--max-old-space-size=256' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let client, legacy, errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => {
    client?.close(); legacy?.close();
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    if (child.connected) child.disconnect();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const filename = path.join(dir, 'connection.json'), deadline = Date.now() + 8000;
  while (!fs.existsSync(filename)) {
    assert.equal(child.exitCode, null, errors); assert.ok(Date.now() < deadline, errors);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  client = await connectService(dir, 'observer', { page: false });
  const first = await client.call('initial'); assert.equal(first.sessions[0].messages.length, 100);
  const before = responses.get(client.socket).length;
  for (let i = 0; i < 8; i++) {
    const next = await client.call('initial');
    assert.ok(next.fixtureRevision > first.fixtureRevision); assert.deepEqual(next.sessions[0].messages, first.sessions[0].messages);
    assert.equal(next.servicePid, child.pid);
  }
  const replies = responses.get(client.socket).slice(before);
  assert.equal(replies.length, 8);
  const bytes = replies.reduce((sum, frame) => sum + frame.bytes, 0);
  assert.ok(bytes < 100000, `eight unchanged fresh snapshots used ${bytes} bytes`);
  const info = JSON.parse(fs.readFileSync(filename)), socket = net.connect(info.endpoint);
  legacy = new ServiceClient(socket);
  const ready = once(legacy, 'ready');
  socket.once('connect', () => socket.write(JSON.stringify({ protocol: 1, owner: 'legacy', token: info.token, page: false }) + '\n'));
  await ready;
  const at = responses.get(socket).length;
  await legacy.call('initial'); const full = await legacy.call('initial');
  assert.ok(full.fixtureRevision > first.fixtureRevision); const legacyReplies = responses.get(socket).slice(at);
  assert.equal(legacyReplies.length, 2);
  assert.ok(legacyReplies.reduce((sum, frame) => sum + frame.bytes, 0) > 1500000);
  t.diagnostic(`eight negotiated initial replies: ${bytes} bytes; legacy full replies preserved`);
});
