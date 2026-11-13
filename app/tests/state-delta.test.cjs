// Backend state frames that carry only the changed part of each session's and space's messages (state-delta.cjs).
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createStateEncoder, sendState, rebuildState } = require('../state-delta.cjs');
const { ServiceClient } = require('../service-connection.cjs');

const message = (id, text) => ({ id, role: 'assistant', text, status: 'complete', time: 1 });
// What the daemon broadcasts: new outer objects that share the live message objects.
const snapshotOf = live => ({ version: live.version, sessions: live.sessions.map(s => ({ ...s })), room: live.room && { ...live.room }, rooms: live.rooms.map(r => ({ ...r })), storageWarning: null });
function liveState() {
  const shared = { id: 'shared', messages: [message('r1', 'space hello')] };
  return { version: 1, room: shared, rooms: [shared, { id: 'space-a', messages: [] }], sessions: [
    { id: 'a', name: 'A', state: 'working', messages: [message('a1', 'one'), message('a2', 'two')] },
    { id: 'b', name: 'B', state: 'idle', messages: [message('b1', 'only')] },
  ] };
}
// Encode one broadcast whole and as a delta from the one before; the rebuilt delta must equal the
// whole frame byte for byte once re-encoded. The first broadcast has nothing to build on.
const lastOf = new WeakMap();
function step(encoder, base, live) {
  const frames = encoder.frames(snapshotOf(live), true), previous = lastOf.get(encoder) ?? null; lastOf.set(encoder, frames.generation);
  const deltaBytes = frames.delta(previous).length, full = JSON.parse(frames.full()), delta = JSON.parse(frames.delta(previous));
  encoder.keep(new Set([frames.generation]));
  assert.equal(full.delta, undefined); assert.equal(delta.delta, previous === null ? undefined : 1); assert.equal(delta.event, 'state');
  const rebuilt = delta.delta === 1 ? rebuildState(base, delta.data) : delta.data;
  assert.equal(JSON.stringify(rebuilt), JSON.stringify(full.data));
  return { rebuilt, delta: delta.data, fullBytes: frames.full().length, deltaBytes };
}
const kept = (data, list, id) => (list === 'room' ? data.room : data[list].find(r => r.id === id))?.messagesKeep;

test('each change sends only the messages after the first one that differs, and rebuilds to the whole state', () => {
  const encoder = createStateEncoder(), live = liveState();
  let { rebuilt } = step(encoder, null, live); // The first frame has nothing to build on: everything is whole.
  // A streamed reply grows: everything before it is kept.
  live.sessions[0].messages.push(message('a3', 'stre'));
  let r = step(encoder, rebuilt, live); rebuilt = r.rebuilt;
  assert.equal(kept(r.delta, 'sessions', 'a'), 2); assert.deepEqual(r.delta.sessions[0].messages.map(m => m.id), ['a3']);
  assert.equal(kept(r.delta, 'sessions', 'b'), 1); assert.deepEqual(r.delta.sessions[1].messages, []);
  // The same message object changed in place (the workspace does this): it is sent again.
  live.sessions[0].messages[2].text = 'streaming more';
  r = step(encoder, rebuilt, live); rebuilt = r.rebuilt;
  assert.equal(kept(r.delta, 'sessions', 'a'), 2); assert.equal(r.delta.sessions[0].messages[0].text, 'streaming more');
  // An older message changed in place: the delta starts there.
  live.sessions[0].messages[0].status = 'superseded';
  r = step(encoder, rebuilt, live); rebuilt = r.rebuilt;
  assert.equal(kept(r.delta, 'sessions', 'a'), undefined, 'nothing kept when the first message changed');
  // A message moved to the end (workspace.cjs splices and pushes).
  const moved = live.sessions[0].messages.splice(1, 1)[0]; live.sessions[0].messages.push(moved);
  r = step(encoder, rebuilt, live); rebuilt = r.rebuilt;
  assert.equal(kept(r.delta, 'sessions', 'a'), 1);
  // Fewer messages than before: the kept part is all there is.
  live.sessions[1].messages = [];
  r = step(encoder, rebuilt, live); rebuilt = r.rebuilt;
  assert.equal(kept(r.delta, 'sessions', 'b'), undefined);
  live.sessions[1].messages.push(message('b2', 'again'), message('b3', 'and again')); r = step(encoder, rebuilt, live); rebuilt = r.rebuilt;
  live.sessions[1].messages.pop(); r = step(encoder, rebuilt, live); rebuilt = r.rebuilt;
  assert.equal(kept(r.delta, 'sessions', 'b'), 1); assert.deepEqual(r.delta.sessions[1].messages, []);
  // A space's messages: the shared room appears as room and among rooms, each keyed on its own.
  live.room.messages.push(message('r2', 'space reply'));
  r = step(encoder, rebuilt, live); rebuilt = r.rebuilt;
  assert.equal(kept(r.delta, 'room'), 1); assert.equal(kept(r.delta, 'rooms', 'shared'), 1); assert.equal(kept(r.delta, 'rooms', 'space-a'), undefined);
  // A new session is whole; a removed one is simply absent; order follows the snapshot.
  live.sessions.unshift({ id: 'c', name: 'C', state: 'idle', messages: [message('c1', 'new')] });
  r = step(encoder, rebuilt, live); rebuilt = r.rebuilt;
  assert.equal(kept(r.delta, 'sessions', 'c'), undefined); assert.deepEqual(r.rebuilt.sessions.map(s => s.id), ['c', 'a', 'b']);
  live.sessions.splice(1, 1);
  r = step(encoder, rebuilt, live); rebuilt = r.rebuilt;
  assert.deepEqual(r.rebuilt.sessions.map(s => s.id), ['c', 'b']);
  // Other fields always go whole.
  live.sessions[0].state = 'working'; live.version = 2;
  r = step(encoder, rebuilt, live);
  assert.equal(r.rebuilt.sessions[0].state, 'working'); assert.equal(r.rebuilt.version, 2);
});

test('a long history that grows by one message goes as that message, not the history', () => {
  const encoder = createStateEncoder(), live = liveState();
  live.sessions[0].messages = Array.from({ length: 500 }, (_, i) => message(`h${i}`, 'x'.repeat(2000)));
  let { rebuilt } = step(encoder, null, live);
  live.sessions[0].messages.push(message('new', 'tail'));
  const r = step(encoder, rebuilt, live);
  assert.ok(r.fullBytes > 1000000 && r.deltaBytes < 2000, `${r.fullBytes} → ${r.deltaBytes}`);
  rebuilt = r.rebuilt;
});

test('random changes over many frames always rebuild to the whole state', () => {
  let seed = 7; const random = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const encoder = createStateEncoder(), live = liveState();
  let rebuilt = step(encoder, null, live).rebuilt, deltas = 0;
  for (let i = 0; i < 400; i++) {
    const s = live.sessions[random(live.sessions.length)] || live.room;
    switch (random(9)) {
      case 0: case 1: s.messages.push(message(`m${i}`, `text ${i}`)); break;
      case 2: if (s.messages.length) s.messages[s.messages.length - 1].text += ' more'; break;
      case 3: if (s.messages.length) s.messages[random(s.messages.length)].status = `s${i}`; break;
      case 4: if (s.messages.length > 1) s.messages.push(s.messages.splice(random(s.messages.length), 1)[0]); break;
      case 5: s.messages.pop(); break;
      case 6: live.sessions.push({ id: `n${i}`, name: 'N', messages: [message(`n${i}`, 'new')] }); break;
      case 7: if (live.sessions.length > 1) live.sessions.splice(random(live.sessions.length), 1); break;
      default: live.room.messages.push(message(`r${i}`, 'space'));
    }
    const r = step(encoder, rebuilt, live); rebuilt = r.rebuilt;
    if (JSON.stringify(r.delta).includes('messagesKeep')) deltas++;
  }
  assert.ok(deltas > 300, `most frames carried a delta (${deltas})`);
});

test('a key seen twice is never sent as a delta', () => {
  const encoder = createStateEncoder(), live = liveState();
  live.sessions.push({ id: 'a', name: 'A again', messages: [message('x', 'other')] });
  let { rebuilt } = step(encoder, null, live);
  live.sessions[0].messages.push(message('a3', 'more'));
  const r = step(encoder, rebuilt, live);
  assert.equal(kept(r.delta, 'sessions', 'a'), undefined); assert.equal(r.delta.sessions[2].messagesKeep, undefined);
  rebuilt = r.rebuilt;
});

test('a delta that does not fit the previous state is refused, never guessed', () => {
  const base = { sessions: [{ id: 'a', messages: [message('a1', 'one')] }, { id: 'd', messages: [] }, { id: 'd', messages: [] }] };
  for (const record of [{ id: 'a', messagesKeep: 2, messages: [] }, { id: 'a', messagesKeep: 0, messages: [] }, { id: 'a', messagesKeep: 1.5, messages: [] },
    { id: 'a', messagesKeep: '1', messages: [] }, { id: 'a', messagesKeep: 1 }, { id: 'missing', messagesKeep: 1, messages: [] }, { id: 'd', messagesKeep: 1, messages: [] }]) {
    assert.throws(() => rebuildState(base, { sessions: [record] }), /Invalid state delta/, JSON.stringify(record));
  }
  assert.throws(() => rebuildState(null, { sessions: [{ id: 'a', messagesKeep: 1, messages: [] }] }), /Invalid state delta/);
  assert.throws(() => rebuildState(base, null), /Invalid state delta/);
  assert.deepEqual(rebuildState(base, { sessions: [{ id: 'a', messagesKeep: 1, messages: [message('a2', 'two')] }] }).sessions[0].messages.map(m => m.id), ['a1', 'a2']);
});

test('who gets a delta: only a client that asked and holds a state, built on what its next frame will find', () => {
  const writer = () => { const w = { frames: [], waiting: false, queued: key => key === 'state' && w.waiting, sendFrame: (frame, key) => { assert.equal(key, 'state'); w.frames.push(JSON.parse(frame)); } }; return w; };
  const plain = writer(), asked = writer(), slow = writer(), encoder = createStateEncoder(), live = liveState();
  const targets = [{ writer: plain, delta: null }, { writer: asked, delta: { sent: null, waiting: null } }, { writer: slow, delta: { sent: null, waiting: null } }];
  sendState(encoder, targets, snapshotOf(live));
  assert.deepEqual([plain, asked, slow].map(w => w.frames.at(-1).delta), [undefined, undefined, undefined], 'first frame whole for everyone');
  live.sessions[0].messages.push(message('a3', 'new')); slow.waiting = true;
  sendState(encoder, targets, snapshotOf(live));
  assert.deepEqual([plain, asked, slow].map(w => w.frames.at(-1).delta), [undefined, 1, undefined], 'a client whose only state is still queued, to be dropped, holds nothing yet: whole again');
  slow.waiting = false; live.sessions[0].messages.push(message('a4', 'newer'));
  sendState(encoder, targets, snapshotOf(live));
  assert.equal(slow.frames.at(-1).delta, 1);
  // What each client holds after its frames, as ServiceClient rebuilds them.
  const held = w => w.frames.reduce((base, f) => f.delta === 1 ? rebuildState(base, f.data) : f.data, null);
  assert.equal(JSON.stringify(held(asked)), JSON.stringify(plain.frames[2].data));
  assert.equal(JSON.stringify(held(slow)), JSON.stringify(plain.frames[2].data));
});

test('a client whose socket drains slower than the broadcasts still gets deltas against what it holds, never only whole frames', () => {
  const { createWriter } = require('../service-transport.cjs');
  // Takes every frame but asks to wait for a drain; the test drains it after every third broadcast.
  const socket = new EventEmitter(); socket.destroyed = false; socket.delivered = [];
  socket.write = frame => { socket.delivered.push(JSON.parse(frame)); return false; };
  socket.destroy = () => { socket.destroyed = true; };
  const plain = { frames: [], queued: () => false, sendFrame: frame => plain.frames.push(JSON.parse(frame)) };
  const encoder = createStateEncoder(), live = liveState(), targets = [{ writer: plain, delta: null }, { writer: createWriter(socket), delta: { sent: null, waiting: null } }];
  for (let i = 0; i < 30; i++) {
    live.version = i; live.sessions[0].messages.push(message(`s${i}`, 'x'.repeat(50)));
    sendState(encoder, targets, snapshotOf(live));
    if (i % 3 === 2) socket.emit('drain');
  }
  assert.equal(socket.destroyed, false);
  assert.ok(socket.delivered.length >= 10, `${socket.delivered.length} frames left the queue`);
  assert.deepEqual(socket.delivered.map(f => f.delta === 1 ? 'delta' : 'whole').filter(k => k === 'whole'), ['whole'], 'only the first frame is whole');
  // Each frame that left the queue, rebuilt on the one before it, reads as the whole frame of the same broadcast.
  let held = null;
  for (const frame of socket.delivered) {
    held = frame.delta === 1 ? rebuildState(held, frame.data) : frame.data;
    assert.equal(JSON.stringify(held), JSON.stringify(plain.frames.find(f => f.data.version === held.version).data), `broadcast ${held.version}`);
  }
  assert.ok(encoder.held() <= 3, `digests kept for ${encoder.held()} states`);
});

test('with no client that takes deltas nothing is digested', () => {
  let digests = 0; const encoder = createStateEncoder(text => { digests++; return text; });
  const w = { queued: () => false, sendFrame() {} }, live = liveState();
  sendState(encoder, [{ writer: w, delta: null }], snapshotOf(live)); sendState(encoder, [{ writer: w, delta: null }], snapshotOf(live));
  assert.equal(digests, 0); assert.equal(encoder.held(), 0);
  sendState(encoder, [{ writer: w, delta: { sent: null, waiting: null } }], snapshotOf(live));
  assert.ok(digests > 0);
});

function peer() {
  const socket = new EventEmitter(); socket.setEncoding = () => {}; socket.written = [];
  socket.write = text => { socket.written.push(text); return true; };
  socket.destroy = () => { if (socket.destroyed) return; socket.destroyed = true; socket.emit('close'); };
  return socket;
}
test('ServiceClient rebuilds delta frames before anything sees the state, and closes on one that does not fit', () => {
  const socket = peer(), client = new ServiceClient(socket), states = [];
  client.on('state', state => states.push(state));
  const frame = value => socket.emit('data', JSON.stringify(value) + '\n');
  frame({ event: 'state', data: { sessions: [{ id: 'a', messages: [message('a1', 'one')] }] } });
  frame({ event: 'state', delta: 1, data: { sessions: [{ id: 'a', messages: [message('a2', 'two')], messagesKeep: 1 }] } });
  assert.deepEqual(states[1].sessions[0].messages.map(m => m.id), ['a1', 'a2']);
  assert.equal(Object.hasOwn(states[1].sessions[0], 'messagesKeep'), false);
  assert.ok(client.receivedOrder(states[1]) > client.receivedOrder(states[0]), 'the rebuilt state keeps its place in the received order');
  // A whole frame replaces the base, as from a service that sends no deltas.
  frame({ event: 'state', data: { sessions: [{ id: 'a', messages: [] }] } });
  frame({ event: 'state', delta: 1, data: { sessions: [{ id: 'a', messages: [], messagesKeep: 1 }] } });
  assert.equal(states.length, 3); assert.equal(socket.destroyed, true, 'a delta that does not fit closes the connection');
});
