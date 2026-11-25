// One object per message over every connection to one backend (state-share.cjs, service-connection.cjs).
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { createStateEncoder, createInitialResponse, sendState } = require('../state-delta.cjs');
const { ServiceClient } = require('../service-connection.cjs');
const stateShare = require('../state-share.cjs');

const message = (id, text) => ({ id, role: 'assistant', text, parts: [{ type: 'text', text }], time: 1 });
function liveState() {
  const shared = { id: 'shared', messages: [message('r1', 'space hello')] };
  return { version: 1, room: shared, rooms: [shared, { id: 'space-a', messages: [message('s1', 'a')] }], sessions: [
    { id: 'a', name: 'A', messages: [message('a1', 'one'), message('a2', 'two'), message('a3', 'three')] },
    { id: 'b', name: 'B', messages: [message('b1', 'only')] },
  ] };
}
const snapshotOf = live => ({ version: live.version, sessions: live.sessions.map(s => ({ ...s })), room: { ...live.room }, rooms: live.rooms.map(r => ({ ...r })) });

function connection(endpoint) {
  const socket = new EventEmitter(); socket.setEncoding = () => {}; socket.write = () => {};
  socket.destroy = socket.end = () => { if (!socket.destroyed) { socket.destroyed = true; socket.emit('close'); } };
  const client = new ServiceClient(socket, { endpoint }), states = [];
  client.on('state', state => states.push(state));
  return { client, socket, states, feed: value => socket.emit('data', JSON.stringify(value) + '\n'), newest: () => states.at(-1) };
}
// One backend's broadcasts to several connections, as daemon.cjs sends them.
function backend(live) {
  const encoder = createStateEncoder();
  return { encoder, targets: new Map(), add(c) {
    this.targets.set(c, { writer: { queued: () => false, sendFrame: frame => c.socket.emit('data', frame.toString()) }, delta: { sent: null, waiting: null } });
  }, send() { sendState(encoder, [...this.targets.values()], snapshotOf(live)); } };
}
const messagesOf = state => [...state.sessions, ...state.rooms, state.room].flatMap(record => record.messages);
let endpoints = 0;
const endpoint = () => `/synthetic/${++endpoints}.sock`;

test('connections to one backend keep one object for each message', () => {
  const live = liveState(), at = endpoint(), b = backend(live), one = connection(at), two = connection(at);
  b.add(one); b.add(two); b.send();
  assert.deepEqual(two.newest(), one.newest());
  messagesOf(two.newest()).forEach((m, i) => assert.equal(m, messagesOf(one.newest())[i]));
  assert.notEqual(two.newest().sessions[0], one.newest().sessions[0], 'a record stays each connection\'s own');
  assert.notEqual(two.newest().sessions[0].messages, one.newest().sessions[0].messages, 'so does its list of messages');
  one.client.close(); two.client.close();
});

test('a connection\'s initial reply shares with its own state and with the others\'', async () => {
  const live = liveState(), at = endpoint(), b = backend(live), one = connection(at), two = connection(at);
  b.add(one); b.send();
  const initial = async c => { const reply = createInitialResponse(), pending = c.client.call('initial'); c.feed({ id: c.client.sequence, ok: true, ...reply(snapshotOf(live)) }); return pending; };
  for (const c of [one, two]) {
    const value = await initial(c);
    assert.equal(JSON.stringify(value), JSON.stringify(snapshotOf(live)));
    messagesOf(value).forEach((m, i) => assert.equal(m, messagesOf(one.newest())[i]));
  }
  one.client.close(); two.client.close();
});

test('a changed message is never the old one, and is one object again once both have it', () => {
  const live = liveState(), at = endpoint(), b = backend(live), one = connection(at), two = connection(at);
  b.add(one); b.add(two); b.send();
  const before = one.newest(), text = JSON.stringify(before);
  live.sessions[0].messages[1].text = 'edited in place'; live.sessions[0].messages.push(message('a4', 'new'));
  b.send();
  assert.equal(JSON.stringify(before), text, 'the state handed out before reads as it did');
  for (const c of [one, two]) assert.equal(JSON.stringify(c.newest()), JSON.stringify(snapshotOf(live)));
  messagesOf(two.newest()).forEach((m, i) => assert.equal(m, messagesOf(one.newest())[i]));
  assert.notEqual(one.newest().sessions[0].messages[1], before.sessions[0].messages[1]);
  assert.equal(one.newest().sessions[0].messages[0], before.sessions[0].messages[0]);
  one.client.close(); two.client.close();
});

test('messages found by id when their places differ; same id with other content stays apart', () => {
  const at = endpoint(), one = connection(at), two = connection(at);
  one.feed({ event: 'state', data: { sessions: [{ id: 'a', messages: [message('1', 'x'), message('2', 'y'), message('3', 'z')] }], rooms: [] } });
  two.feed({ event: 'state', data: { sessions: [{ id: 'a', messages: [message('2', 'y'), message('3', 'other')] }], rooms: [] } });
  assert.equal(two.newest().sessions[0].messages[0], one.newest().sessions[0].messages[1]);
  assert.notEqual(two.newest().sessions[0].messages[1], one.newest().sessions[0].messages[2]);
  assert.equal(two.newest().sessions[0].messages[1].text, 'other');
  one.client.close(); two.client.close();
});

test('a connection that hears twice in a row still shares with what the others hold', () => {
  const at = endpoint(), one = connection(at), two = connection(at), frame = () => ({ event: 'state', data: { sessions: [{ id: 'a', messages: [message('1', 'x')] }], rooms: [] } });
  one.feed(frame()); two.feed(frame()); two.feed(frame());
  assert.equal(two.newest().sessions[0].messages[0], one.newest().sessions[0].messages[0]);
  one.client.close(); two.client.close();
});

test('other backends, other sessions and a key that names two records share nothing', () => {
  const at = endpoint(), one = connection(at), other = connection(endpoint()), moved = connection(at), twice = connection(at), same = () => [message('1', 'x')];
  one.feed({ event: 'state', data: { sessions: [{ id: 'a', messages: same() }], rooms: [] } });
  other.feed({ event: 'state', data: { sessions: [{ id: 'a', messages: same() }], rooms: [] } });
  moved.feed({ event: 'state', data: { sessions: [{ id: 'b', messages: same() }], rooms: [] } });
  const held = one.newest().sessions[0].messages[0];
  for (const c of [other, moved]) { assert.notEqual(c.newest().sessions[0].messages[0], held); assert.deepEqual(c.newest().sessions[0].messages[0], held); }
  one.feed({ event: 'state', data: { sessions: [{ id: 'a', messages: same() }], rooms: [] } });
  twice.feed({ event: 'state', data: { sessions: [{ id: 'a', messages: same() }, { id: 'a', messages: same() }], rooms: [] } });
  for (const record of twice.newest().sessions) assert.notEqual(record.messages[0], one.newest().sessions[0].messages[0]);
  for (const c of [one, other, moved, twice]) c.client.close();
});

test('a client with no endpoint shares nothing; a closed one is dropped from its group', async () => {
  const at = endpoint(), frame = () => ({ event: 'state', data: { sessions: [{ id: 'a', messages: [message('1', 'x')] }], rooms: [] } });
  const plain = connection(null), alone = connection(null);
  plain.feed(frame()); alone.feed(frame());
  assert.notEqual(plain.newest().sessions[0].messages[0], alone.newest().sessions[0].messages[0]);
  const one = connection(at); one.feed(frame()); const held = one.newest().sessions[0].messages[0]; one.client.close();
  const two = connection(at); two.feed(frame());
  assert.notEqual(two.newest().sessions[0].messages[0], held, 'a closed connection\'s messages are not looked up');
  for (const c of [plain, alone, two]) c.client.close();
});

test('only equal values with the keys in the same order are shared', () => {
  const { same } = stateShare;
  assert.ok(same({ a: [1, { b: null }], c: 'x' }, { a: [1, { b: null }], c: 'x' }));
  for (const [a, b] of [[{ a: 1, b: 2 }, { b: 2, a: 1 }], [{ a: 1 }, { a: '1' }], [[], {}], [{}, []], [{ a: 1 }, { a: 1, b: undefined }], [[1, 2], [1]], [null, {}], [{ a: null }, { a: {} }], [0, false]]) assert.ok(!same(a, b) && !same(b, a), JSON.stringify([a, b]));
  const deep = () => { let value = 1; for (let i = 0; i < 5000; i++) value = { value }; return value; };
  assert.equal(same(deep(), deep()), false, 'too deep to compare: kept apart, no error');
});

test('a frame with odd records is taken as it came', () => {
  const at = endpoint(), one = connection(at), two = connection(at);
  const data = { sessions: [null, 1, { id: { toString: 1 }, messages: [message('1', 'x')] }, { id: 'a', messages: [null, 'text', message('1', 'x')] }, { id: 'c', messages: 5 }], rooms: 'none', room: [] };
  for (const c of [one, two]) { c.feed({ event: 'state', data }); assert.deepEqual(c.newest(), data); assert.notEqual(c.socket.destroyed, true); }
  assert.equal(two.newest().sessions[3].messages[2], one.newest().sessions[3].messages[2]);
  one.feed({ event: 'state', data: null }); two.feed({ event: 'state', data });
  assert.deepEqual(two.newest(), data);
  one.client.close(); two.client.close();
});

test('random changes: every connection reads exactly what the backend holds, shared or not', () => {
  let seed = 20261124; const random = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const live = liveState(), at = endpoint(), b = backend(live); let connections = [], ids = 0;
  for (let step = 0; step < 400; step++) {
    if (connections.length < 4 && random(4) === 0) { const c = connection(at); connections.push(c); b.add(c); }
    if (connections.length > 1 && random(25) === 0) { const c = connections.splice(random(connections.length), 1)[0]; b.targets.delete(c); c.client.close(); }
    const records = [...live.sessions, live.room, live.rooms[1]], { messages } = records[random(records.length)], at2 = random(messages.length || 1);
    switch (random(6)) {
      case 0: case 1: messages.push(message(`n${++ids}`, 'new')); break;
      case 2: if (messages.length) { messages[at2].text += '.'; messages[at2].parts[0].text += '.'; } break;
      case 3: messages.splice(at2, 1); break;
      case 4: if (messages.length) messages.push(messages.splice(at2, 1)[0]); break;
      default: if (messages.length > 30) messages.splice(0, 15);
    }
    b.send();
    const whole = JSON.stringify(snapshotOf(live));
    for (const c of connections) assert.equal(JSON.stringify(c.newest()), whole);
    for (const c of connections.slice(1)) messagesOf(c.newest()).forEach((m, i) => assert.equal(m, messagesOf(connections[0].newest())[i]));
  }
  for (const c of connections) c.client.close();
});

test('the backend runtime and the app both pack it', () => {
  for (const file of ['service-client.cjs', '../scripts/package-mac.cjs']) assert.match(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), /'state-share\.cjs'/);
});
