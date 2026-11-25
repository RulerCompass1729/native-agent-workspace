const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const sourceFile = process.env.NAW_TEST_MESSAGE_TOOL_SOURCE || path.resolve(__dirname, '../claude-message-tool.cjs');
const source = fs.readFileSync(sourceFile, 'utf8');
const payloadStart = source.indexOf('function stagePayload(');
const start = payloadStart >= 0 ? payloadStart : source.indexOf('function stageNative(');
const end = source.indexOf('\nasync function main()', start);
assert.ok(start >= 0 && end > start, 'Rebind this test to the actual native transport if its entry point changes.');
const identity = { nativeId: 'owned-native', sessionId: 'owned-session', turnId: 'owned-turn', callId: 'owned-call' };
const args = { recipient_id: 'owned-recipient', message: 'One  task 中文 🙂\nSecond line stays literal.' };
const tick = () => new Promise(resolve => setImmediate(resolve));

// This is the current transport body, not a second implementation. The
// caller's provenance, new outbox wiring and actual CLI receipt are outside
// this fixture. No socket, server, child process or native provider is opened.
function fixture(connectError = false) {
  const socket = new EventEmitter(), writes = [];
  let connections = 0, timeout;
  socket.setEncoding = encoding => assert.equal(encoding, 'utf8');
  socket.setTimeout = (ms, callback) => { assert.equal(ms, 10000); timeout = callback; };
  socket.write = line => { writes.push(line); return true; };
  socket.destroy = () => { socket.destroyed = true; };
  const stage = vm.runInNewContext(source.slice(start, end) + '\nstageNative;', {
    process: { env: { NAW_MESSAGE_SOCKET: 'owned-in-memory-hook', NAW_MESSAGE_TOKEN: 'synthetic-host-token' } },
    net: { connect(target) {
      assert.equal(target, 'owned-in-memory-hook'); connections++;
      if (connectError) throw Error('Controlled connection setup refusal');
      return socket;
    } },
  }, { filename: sourceFile });
  const pending = stage(identity, args);
  return { socket, writes, pending, connections: () => connections, timeout: () => timeout() };
}

test('current native transport sends exact recipient, identity and literal body once; fragmented ACK stays a staging result', { timeout: 1000 }, async () => {
  const f = fixture(); f.socket.emit('connect');
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].endsWith('\n'), true);
  assert.deepEqual(JSON.parse(f.writes[0]), {
    token: 'synthetic-host-token', workspaceMessage: true, identity, arguments: args,
  });
  let settled = false; f.pending.then(() => { settled = true; });
  f.socket.emit('data', '{"status":"sta'); await Promise.resolve(); assert.equal(settled, false);
  f.socket.emit('data', 'ged","id":"owned-ticket"}\n');
  const result = await f.pending;
  assert.equal(result.status, 'staged'); assert.equal(result.id, 'owned-ticket');
  assert.equal(result.nativeReceived, undefined); assert.equal(result.firstCommand, undefined);
  assert.equal(f.socket.destroyed, true); assert.equal(f.connections(), 1); assert.equal(f.writes.length, 1);
});

for (const scenario of ['timeout', 'socket-error', 'truncated-end', 'malformed-json', 'oversized-reply']) {
  test('current native transport refuses ' + scenario + ' without reconnect or repeated write', { timeout: 1000 }, async () => {
    const f = fixture(); f.socket.emit('connect');
    const rejection = assert.rejects(f.pending, error => {
      assert.equal(error.message, 'Workspace staging result is unconfirmed; do not retry.'); return true;
    });
    if (scenario === 'timeout') f.timeout();
    if (scenario === 'socket-error') f.socket.emit('error', Error('CONTROLLED_UPSTREAM_DETAIL'));
    if (scenario === 'truncated-end') { f.socket.emit('data', '{"status":"staged"'); f.socket.emit('end'); }
    if (scenario === 'malformed-json') f.socket.emit('data', '{invalid-json}\n');
    if (scenario === 'oversized-reply') f.socket.emit('data', 'x'.repeat(16385));
    await rejection; await tick();
    // Late data or another failure cannot turn the old call into a retry.
    f.socket.emit('data', '{"status":"staged","id":"late-ticket"}\n'); f.timeout(); await tick();
    assert.equal(f.socket.destroyed, true); assert.equal(f.connections(), 1); assert.equal(f.writes.length, 1);
  });
}

test('repeated replies after one ACK do not send the native request again', { timeout: 1000 }, async () => {
  const f = fixture(); f.socket.emit('connect');
  const reply = '{"status":"staged","id":"owned-ticket"}\n';
  f.socket.emit('data', reply); const result = await f.pending;
  f.socket.emit('data', reply); f.socket.emit('end'); f.timeout(); await tick();
  assert.equal(result.id, 'owned-ticket'); assert.equal(f.connections(), 1); assert.equal(f.writes.length, 1);
});

test('synchronous connection refusal makes one attempt and no write', { timeout: 1000 }, async () => {
  const f = fixture(true); await assert.rejects(f.pending, /Controlled connection setup refusal/); await tick();
  assert.equal(f.connections(), 1); assert.equal(f.writes.length, 0);
});
