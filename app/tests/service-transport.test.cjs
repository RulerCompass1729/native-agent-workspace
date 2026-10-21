const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const net = require('node:net');
const { readFrames, encodeFrame, createWriter, RESPONSE_BYTES } = require('../service-transport.cjs');
const { ServiceClient } = require('../service-client.cjs');
function peer() {
  const socket = new EventEmitter(); socket.setEncoding = () => {};
  socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
  return socket;
}

test('frame limits are per UTF-8 message, independent of chunk boundaries', () => {
  const first = JSON.stringify({ text: '中文' }), second = JSON.stringify({ text: 'next' });
  const limit = Buffer.byteLength(first), values = [], socket = peer();
  readFrames(socket, limit, value => values.push(value));
  socket.emit('data', first.slice(0, 5));
  socket.emit('data', first.slice(5) + '\n' + second + '\n' + first + '\n');
  assert.deepEqual(values, [{ text: '中文' }, { text: 'next' }, { text: '中文' }]);
  assert.equal(socket.destroyed, undefined);
  socket.emit('data', JSON.stringify({ text: '中文多' }));
  assert.equal(socket.destroyed, true);
  socket.emit('data', '\n' + second + '\n');
  assert.equal(values.length, 3, 'No dispatch after an oversized frame');
});

test('backpressure preserves replies and terminal bytes; a newer state stays after older responses', () => {
  const socket = peer(), sent = []; let accept = false;
  socket.write = frame => { sent.push(JSON.parse(frame)); return accept; };
  const writer = createWriter(socket);
  writer.send({ event: 'state', data: { revision: 1 } }, 'state');
  writer.send({ event: 'state', data: { revision: 2 } }, 'state');
  writer.send({ id: 1, ok: true, value: { revision: 2 } });
  writer.send({ event: 'terminal', data: 'exact terminal bytes' });
  writer.send({ event: 'state', data: { revision: 3 } }, 'state');
  assert.equal(sent.length, 1, 'A false write is accepted once; wait for drain');
  accept = true; socket.emit('drain');
  assert.deepEqual(sent, [
    { event: 'state', data: { revision: 1 } },
    { id: 1, ok: true, value: { revision: 2 } },
    { event: 'terminal', data: 'exact terminal bytes' },
    { event: 'state', data: { revision: 3 } },
  ]);
  socket.emit('drain'); assert.equal(sent.length, 4);
});

test('reliable backlog stays bounded and closes instead of dropping acknowledged work', () => {
  for (const options of [{ maxFrames: 2 }, { maxBytes: 70 }]) {
    const socket = peer(); socket.write = () => false;
    const writer = createWriter(socket, options);
    writer.send({ event: 'terminal', data: 'x' });
    for (let i = 0; i < 4; i++) writer.send({ id: i, ok: true, value: 'reply' });
    assert.equal(socket.destroyed, true);
    assert.equal(writer.send({ id: 9 }), false);
  }
  assert.throws(() => encodeFrame({ text: 'x'.repeat(RESPONSE_BYTES) }), RangeError);
});

test('real slow socket carries large history, following RPC reply and latest state without disconnection', { timeout: 20000 }, async t => {
  let producer;
  const server = net.createServer(socket => { producer = socket; socket.on('error', () => {}); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const socket = net.connect(server.address().port, '127.0.0.1');
  t.after(() => { socket.destroy(); producer?.destroy(); server.close(); });
  await once(socket, 'connect');
  const client = new ServiceClient(socket), states = [], terminal = [];
  client.on('state', state => states.push(state)); client.on('terminal', text => terminal.push(text));
  const pending = client.call('initial');
  const text = 'synthetic history '.repeat(1200000); // > former 16 MiB cap
  const writer = createWriter(producer);
  socket.pause();
  writer.send({ event: 'state', data: { revision: 1, text } }, 'state');
  writer.send({ event: 'state', data: { revision: 2, text } }, 'state');
  writer.send({ id: 1, ok: true, value: { revision: 2, text } });
  writer.send({ event: 'terminal', data: '\u001b[2Jexact\r\n' });
  writer.send({ event: 'state', data: { revision: 3, text } }, 'state');
  assert.ok(producer.writableLength > 8 * 1024 * 1024, 'Exercise the old send disconnect gate');
  const last = new Promise(resolve => client.on('state', state => { if (state.revision === 3) resolve(state); }));
  socket.resume();
  const [response, latest] = await Promise.all([pending, last]);
  assert.equal(response.text, text); assert.equal(latest.text, text);
  assert.deepEqual(states.map(s => s.revision), [1, 3]);
  assert.deepEqual(terminal, ['\u001b[2Jexact\r\n']);
  assert.ok(client.receivedOrder(latest) > client.receivedOrder(response));
  assert.equal(socket.destroyed, false); assert.equal(producer.destroyed, false);
});
