// 11-22 the window closed three times with write-queue-bytes while seven confirmation cards ran: every card change
// asked the service for a whole state, each reply was a 28 MB snapshot the service cannot merge, and the replies
// piled up past its 128 MiB per-client limit. Concurrent reads of the whole state now share one request.
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ServiceClient } = require('../service-connection.cjs');
const background = require('../background-operation.cjs');

function fixture(t) {
  const socket = Object.assign(new EventEmitter(), { destroyed: false, written: [], setEncoding() {}, write(line) { this.written.push(JSON.parse(line)); }, end() {},
    destroy() { this.destroyed = true; this.emit('close'); } });
  const client = new ServiceClient(socket);
  t.after(() => { if (!socket.destroyed) socket.destroy(); });
  const reply = (id, value) => socket.emit('data', JSON.stringify({ id, ok: true, value }) + '\n');
  return { client, socket, reply, reads: () => socket.written.filter(row => row.method === 'initial') };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const actor = (operationId) => ({ id: 'agent', name: 'Agent', nativeId: 'native-agent', provider: 'codex', callId: 'call-' + operationId, turnId: 'turn', operationId });

test('seven reads at once keep at most one whole snapshot on the connection', async t => {
  const f = fixture(t);
  const reads = Array.from({ length: 7 }, () => f.client.call('initial'));
  assert.equal(f.reads().length, 1, 'one request in flight for seven readers');
  f.reply(f.reads()[0].id, { revision: 1 });
  await settle();
  assert.equal(f.reads().length, 2, 'the six that asked during it share one request, sent after its reply');
  f.reply(f.reads()[1].id, { revision: 2 });
  const values = await Promise.all(reads);
  assert.deepEqual(values.map(v => v.revision), [1, 2, 2, 2, 2, 2, 2]);
  assert.equal(f.client.receivedOrder(values[1]), f.client.receivedOrder(values[6]), 'readers of one reply see one receive order');
});
test('a read asked while one is in flight gets a later request, so it sees changes made before it asked', async t => {
  const f = fixture(t);
  const first = f.client.call('initial');
  f.client.call('create', { name: 'x' }).catch(() => {});
  const after = [f.client.call('initial'), f.client.call('initial')];
  assert.equal(f.reads().length, 1, 'the later reads wait for the reply in flight');
  f.reply(f.reads()[0].id, { revision: 1 });
  assert.equal((await first).revision, 1);
  await settle();
  assert.equal(f.reads().length, 2, 'both later readers share one request, sent after the first reply');
  assert.ok(f.socket.written.indexOf(f.reads()[1]) > f.socket.written.findIndex(row => row.method === 'create'), 'the later read follows the write');
  f.reply(f.reads()[1].id, { revision: 2 });
  assert.deepEqual((await Promise.all(after)).map(v => v.revision), [2, 2]);
  f.client.call('initial').catch(() => {});
  assert.equal(f.reads().length, 3, 'a read after both replies sends its own request');
});
test('reads from different background operations share a request; it carries the first waiting reader\'s actor', async t => {
  const f = fixture(t);
  const reads = ['op-1', 'op-2', 'op-3'].map(id => background.run(actor(id), () => f.client.call('initial')));
  assert.equal(f.reads().length, 1);
  assert.equal(f.reads()[0].backgroundActor.operationId, 'op-1');
  f.reply(f.reads()[0].id, { revision: 1 });
  await settle();
  assert.equal(f.reads().length, 2, 'one card operation per request would put three snapshots on the connection');
  assert.equal(f.reads()[1].backgroundActor.operationId, 'op-2');
  f.reply(f.reads()[1].id, { revision: 2 });
  assert.deepEqual((await Promise.all(reads)).map(v => v.revision), [1, 2, 2]);
  const solo = f.client.call('initial');
  assert.equal(f.reads()[2].backgroundActor, undefined, 'a read outside any operation carries no actor, as before');
  f.reply(f.reads()[2].id, { revision: 3 });
  assert.equal((await solo).revision, 3);
});
test('a failed read rejects its readers; the reader waiting behind it still asks', async t => {
  const f = fixture(t);
  const first = f.client.call('initial'), waiting = f.client.call('initial');
  f.socket.emit('data', JSON.stringify({ id: f.reads()[0].id, ok: false, error: 'boom' }) + '\n');
  await assert.rejects(first, /boom/);
  await settle();
  assert.equal(f.reads().length, 2, 'the waiting reader still gets its own request');
  f.reply(f.reads()[1].id, { revision: 2 });
  assert.equal((await waiting).revision, 2);
});
test('a closed connection rejects the read in flight and the one waiting behind it', async t => {
  const f = fixture(t);
  const first = f.client.call('initial'), waiting = [f.client.call('initial'), f.client.call('initial')];
  assert.equal(f.reads().length, 1);
  f.socket.destroy();
  await assert.rejects(first); for (const read of waiting) await assert.rejects(read);
  assert.equal(f.reads().length, 1, 'nothing is written to the closed connection');
});
test('a read with arguments, and every other method, is sent as asked', async t => {
  const f = fixture(t);
  f.client.call('initial', 'x').catch(() => {}); f.client.call('initial', 'x').catch(() => {});
  f.client.call('snapshot').catch(() => {}); f.client.call('snapshot').catch(() => {});
  assert.deepEqual(f.socket.written.map(row => row.method), ['initial', 'initial', 'snapshot', 'snapshot']);
});
test('each reader keeps its own 40-second deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  const first = f.client.call('initial');
  t.mock.timers.tick(30000);
  const late = f.client.call('initial');
  f.reply(f.reads()[0].id, { revision: 1 });
  await first; await settle();
  t.mock.timers.tick(10001);
  await settle();
  let settled = false; late.then(() => { settled = true; }, () => { settled = true; });
  await settle();
  assert.equal(settled, false, 'the later reader waits on its own deadline, not the first one\'s');
  t.mock.timers.tick(30000);
  await assert.rejects(late, error => error.uiMessage?.key === 'error.confirmationTimeout');
});
