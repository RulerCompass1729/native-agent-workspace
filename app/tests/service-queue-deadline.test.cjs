// Found porting test-native-queue's shared journey to real Claude 2.1.322 (B11, 2026-11-10): a message queued to a busy
// member from a collaboration space showed "本地操作等待确认超时" after 40 s. A queued native input is confirmed when
// its turn starts, so it has no local deadline; the space route sends it as spaceAction(roomId, 'queueShared', …),
// which the exemption did not recognise.
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ServiceClient } = require('../service-connection.cjs');

function fixture(t) {
  const socket = Object.assign(new EventEmitter(), { destroyed: false, written: [], setEncoding() {}, write(line) { this.written.push(JSON.parse(line)); }, end() {} });
  const client = new ServiceClient(socket);
  t.after(() => { for (const pending of client.pending.values()) clearTimeout(pending.timer); });
  const deadline = (...args) => { client.call(...args).catch(() => {}); return [...client.pending.values()].at(-1).timer; };
  return { client, socket, deadline };
}
test('a queued native input has no local deadline, sent directly or through a collaboration space', t => {
  const f = fixture(t);
  for (const args of [['queue', 'session', 'text', 'native'], ['queueShared', 'session', 'text', 'native'],
    ['spaceAction', 'shared', 'queueShared', ['session', 'text', 'native'], {}], ['spaceAction', 'space-b', 'queueShared', ['session', 'text', 'native'], {}],
    // An automatic message to a session mid-turn goes into the same native queue (the wake proposal, item 1).
    ['wakeReceive', { id: 'wake' }]]) {
    assert.equal(f.deadline(...args), null, args.slice(0, 3).join(' '));
  }
  assert.deepEqual(f.socket.written.map(row => row.method), ['queue', 'queueShared', 'spaceAction', 'spaceAction', 'wakeReceive'], 'the calls are sent unchanged');
});
test('every other call keeps its confirmation deadline', t => {
  const f = fixture(t);
  for (const args of [['send', 'session', 'text'], ['forward', 'session', 'text'], ['spaceAction', 'shared', 'forward', ['session', 'text']],
    ['spaceAction', 'shared', 'steerShared', ['session', 'text']], ['spaceAction', 'shared', 'queueAdd', ['text', null]],
    // A space whose id is the word itself is not the action.
    ['spaceAction', 'queueShared', 'forward', ['session', 'text']], ['spaceAction'],
    // The wake's readiness check and its credential step are not native input.
    ['wakeCheck', { id: 'wake' }], ['wakeTake', { id: 'wake' }]]) {
    assert.ok(f.deadline(...args), args.slice(0, 3).join(' '));
  }
});
