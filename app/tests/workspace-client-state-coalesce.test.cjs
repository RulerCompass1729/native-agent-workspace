const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setTimeout: wait } = require('node:timers/promises');
const { WorkspaceClient, STATE_EMIT_WAIT } = require('../workspace-client.cjs');

function backend(key, id) {
  const client = new EventEmitter();
  const state = { owner: 'view', runtimeVersion: key, capabilities: [], sessions: [{ id, provider: 'claude', state: 'idle', messages: [] }], room: { revision: 0, messages: [], run: null } };
  client.call = async () => structuredClone(state);
  client.close = () => client.emit('closed');
  return { key, client, state: structuredClone(state), frame: value => client.emit('state', { ...state, sessions: [{ ...state.sessions[0], state: value }] }) };
}

function view() {
  const a = backend('a', 'one'), b = backend('b', 'two');
  const c = new WorkspaceClient([a, b], 'a', Symbol());
  let snapshots = 0;
  const real = c.snapshot.bind(c);
  c.snapshot = (...args) => { snapshots++; return real(...args); };
  const emitted = [];
  c.on('state', value => emitted.push(value));
  return { a, b, c, emitted, snapshots: () => snapshots };
}

test('a burst of backend state frames builds one combined snapshot at once and one with the newest state after the wait (R255)', async () => {
  const { a, b, c, emitted, snapshots } = view();
  try {
    a.frame('working');
    assert.equal(emitted.length, 1, 'a single change is not delayed');
    assert.equal(emitted[0].sessions.find(s => s.id === 'one').state, 'working');
    for (let i = 0; i < 40; i++) { a.frame(i % 2 ? 'working' : 'idle'); b.frame(i % 2 ? 'idle' : 'working'); }
    a.frame('approval'); b.frame('error');
    assert.equal(emitted.length, 1, 'frames within the wait do not each build the combined snapshot');
    assert.equal(snapshots(), 1);
    assert.equal(c.snapshot().sessions.find(s => s.id === 'two').state, 'error', 'each backend state is current at once');
    await wait(STATE_EMIT_WAIT + 60);
    assert.equal(emitted.length, 2);
    const last = emitted.at(-1).sessions;
    assert.equal(last.find(s => s.id === 'one').state, 'approval');
    assert.equal(last.find(s => s.id === 'two').state, 'error');
  } finally { c.close(); }
});

test('a closed view emits nothing that was waiting (R255)', async () => {
  const { a, c, emitted } = view();
  a.frame('working'); a.frame('idle');
  assert.equal(emitted.length, 1);
  c.close();
  await wait(STATE_EMIT_WAIT + 60);
  assert.equal(emitted.length, 1);
});
