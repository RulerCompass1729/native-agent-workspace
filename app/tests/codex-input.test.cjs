// Synthetic native protocol, no provider process or model call.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { NativeHost } = require('../adapters.cjs');
function fixture() {
  const host = new NativeHost(os.tmpdir());
  const runtime = host.create({ provider: 'codex', nativeId: 'thread-test', view: 'chat', cwd: os.tmpdir() });
  const events = [], calls = [];
  let resolve, reject;
  host.rpc = { call(method, params) { calls.push({ method, params }); return new Promise((yes, no) => { resolve = yes; reject = no; }); } };
  for (const event of ['submitted', 'replyBound', 'nativeInput', 'complete', 'failed', 'state']) runtime.on(event, (...args) => events.push({ event, args }));
  const notify = (method, params) => runtime.event({ method, params: { threadId: 'thread-test', ...params } });
  const user = (clientId, text) => notify('item/completed', { turnId: 'turn-test', item: { type: 'userMessage', clientId, content: [{ type: 'text', text }] } });
  const reply = (turnId, text) => notify('item/completed', { turnId, item: { type: 'agentMessage', id: `answer-${turnId}`, text } });
  const complete = (id, status = 'completed') => notify('turn/completed', { turn: { id, status } });
  return { runtime, calls, events, notify, user, reply, complete, ack: id => resolve({ turn: { id } }), reject: error => reject(error) };
}
test('only explicitly correlated GUI echoes are omitted, including after acknowledgement/completion', async () => {
  const f = fixture(), sending = f.runtime.send('same text', 'gui-tag', () => true);
  assert.equal(f.calls[0].params.clientUserMessageId, 'gui-tag');
  assert.deepEqual(f.calls[0].params.input, [{ type: 'text', text: 'same text', text_elements: [] }]);
  f.user('gui-tag', 'same text');
  f.user('native-client', 'same text'); // Identical human input is still input.
  f.user(null, 'unknown client input');
  f.ack('turn-test'); await sending;
  f.user('native-steer', 'change direction');
  f.reply('turn-test', 'new direction answer'); f.complete('turn-test');
  f.user('gui-tag', 'same text');
  assert.deepEqual(f.events.filter(e => e.event === 'nativeInput').map(e => e.args[0]), ['same text', 'unknown client input', 'change direction']);
  assert.equal(f.events.find(e => e.event === 'complete').args[0].tag, 'gui-tag');
});
for (const beforeAck of [false, true]) test(`turn completion ${beforeAck ? 'before' : 'after'} acknowledgement uses its own ID and final answer`, async () => {
  const f = fixture(), sending = f.runtime.send('question', 'gui-tag', () => true);
  f.notify('turn/started', { turn: { id: 'turn-test' } });
  if (!beforeAck) { f.ack('turn-test'); await sending; }
  f.reply('unrelated', 'wrong answer'); f.complete('unrelated');
  assert.equal(f.runtime.pending.tag, 'gui-tag');
  assert.equal(f.runtime.turnId, 'turn-test');
  f.reply('turn-test', 'right answer'); f.complete('turn-test');
  if (beforeAck) {
    assert.equal(f.events.filter(e => e.event === 'complete').length, 0);
    f.ack('turn-test'); await sending;
  }
  const own = f.events.filter(e => e.event === 'complete' && e.args[0].tag === 'gui-tag');
  assert.equal(own.length, 1); assert.equal(own[0].args[0].text, 'right answer');
  assert.equal(own[0].args[0].messageId, 'answer-turn-test');
  const bound = f.events.find(e => e.event === 'replyBound');
  assert.deepEqual(bound.args[0], { tag: 'gui-tag', nativeId: 'thread-test', turnId: 'turn-test' });
  assert.ok(f.events.indexOf(bound) < f.events.indexOf(own[0]));
  assert.ok(f.events.findIndex(e => e.event === 'submitted') < f.events.indexOf(own[0]));
  assert.equal(f.runtime.pending, null); assert.equal(f.runtime.turnId, null);
  assert.equal(f.runtime.turns.size, 0);
});
test('a late old completion cannot finish or idle the next native turn', async () => {
  const f = fixture(), sending = f.runtime.send('question', 'current-tag', () => true);
  f.ack('current'); await sending;
  f.notify('turn/started', { turn: { id: 'current' } });
  f.reply('old', 'old answer'); f.complete('old');
  f.complete('old-failed', 'interrupted');
  assert.equal(f.runtime.pending.tag, 'current-tag'); assert.equal(f.runtime.turnId, 'current');
  assert.ok(!f.events.some(e => e.event === 'state' && e.args[0] === 'idle'));
  assert.ok(!f.events.some(e => ['complete', 'failed'].includes(e.event) && e.args.at(-1)?.tag === 'current-tag'));
  f.reply('current', 'current answer'); f.complete('current');
  assert.equal(f.events.at(-1).args[0].text, 'current answer');
});
test('uncertain acknowledgement does not assign a buffered result or retry the input', async () => {
  const f = fixture(), sending = f.runtime.send('question', 'uncertain-tag', () => true);
  f.reply('maybe-accepted', 'answer'); f.complete('maybe-accepted');
  f.reject(Error('connection lost')); await assert.rejects(sending, /connection lost/);
  assert.equal(f.calls.length, 1); assert.equal(f.runtime.pending, null);
  assert.equal(f.events.find(e => e.event === 'complete').args[0].tag, undefined);
  assert.ok(!f.events.some(e => e.event === 'replyBound'));
});
for (const nativeVersion of ['0.163.0', '0.164.0', '0.165.0']) for (const outcome of ['accepted', 'rejected', 'wrong-turn']) test(`active-turn steering ${nativeVersion} ${outcome} preserves original turn correlation without retry`, async () => {
  const f = fixture(); f.runtime.host.rpc.nativeVersion = nativeVersion;
  f.notify('turn/started', { turn: { id: 'active' } });
  const original = f.runtime.pending = { tag: 'original-task', turnId: 'active' };
  const calls = [], sent = [];
  f.runtime.on('submitted', tag => sent.push(tag));
  f.runtime.host.rpc.call = async (method, params) => {
    calls.push({ method, params });
    if (outcome === 'rejected') throw Error('Native turn mismatch');
    return { turnId: outcome === 'accepted' ? 'active' : 'other' };
  };
  const steering = f.runtime.steer('Change the requirement', 'steer-id', 'active', () => true);
  if (outcome === 'accepted') await steering; else await assert.rejects(steering);
  assert.equal(calls.length, 1); assert.equal(calls[0].method, 'turn/steer');
  assert.equal(calls[0].params.expectedTurnId, 'active');
  assert.equal(calls[0].params.clientUserMessageId, 'steer-id');
  assert.equal(f.runtime.pending, original); assert.equal(f.runtime.turnId, 'active');
  assert.deepEqual(sent, outcome === 'accepted' ? ['steer-id'] : []);
  assert.equal(f.events.filter(e => ['complete', 'failed', 'replyBound'].includes(e.event)).length, 0);
  f.user('steer-id', 'Change the requirement');
  assert.equal(f.events.filter(e => e.event === 'nativeInput').length, 0);
});

test('stale, denied, unverified-version and permission-blocked steer never reach native RPC', async () => {
  const f = fixture(); f.runtime.host.rpc.nativeVersion = '0.163.0'; f.runtime.turnId = 'current';
  await assert.rejects(f.runtime.steer('text', 'a', 'old', () => true));
  await assert.rejects(f.runtime.steer('text', 'b', 'current', () => false));
  f.runtime.host.rpc.nativeVersion = 'unknown';
  await assert.rejects(f.runtime.steer('text', 'c', 'current', () => true));
  f.runtime.host.rpc.nativeVersion = '0.163.0'; f.runtime.nativeRequests.set(1, {});
  await assert.rejects(f.runtime.steer('text', 'd', 'current', () => true));
  assert.equal(f.calls.length, 0);
});
