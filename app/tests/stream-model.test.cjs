const test = require('node:test'), assert = require('node:assert/strict');
const stream = require('../task-stream.js');
const task = (id, createdAt = 1) => ({ id, createdAt, text: 'Repeated task', status: 'queued' });
const event = (id, itemId, time = 20) => ({ id, itemId, time, kind: 'queue', role: 'system',
  uiMessage: { key: 'notice.queue.dispatched', params: { text: 'Repeated task', name: 'A' } } });
test('exact item IDs win even when tasks have identical text', () => {
  const result = stream.roomTasks({ queue: [task('first'), task('second', 2)], events: [event('e', 'first')] });
  assert.deepEqual(result.tasks.map(t => t.history.map(e => e.id)), [['e'], []]);
});
test('ambiguous legacy records remain readable without assigning them to a guessed task', () => {
  const result = stream.roomTasks({ queue: [task('first'), task('second', 2)], events: [event('e', undefined)] });
  assert.deepEqual(result.tasks.map(t => t.history), [[], []]);
  assert.equal(result.system[0].id, 'e');
});
test('a unique legacy record still associates and a missing explicit ID never falls back to text', () => {
  const result = stream.roomTasks({ queue: [task('first')], events: [event('legacy'), event('missing', 'removed')] });
  assert.deepEqual(result.tasks[0].history.map(e => e.id), ['legacy']);
  assert.deepEqual(result.system.map(e => e.id), ['missing']);
});
test('feed sorts messages, imports and events by time without mutating inputs', () => {
  const room = { messages: [{ id: 'old', time: 1 }, { id: 'import', snapshotBatch: 'b', time: 3 }], events: [{ id: 'new', time: 4 }, { id: 'unknown' }] };
  const before = JSON.stringify(room);
  assert.deepEqual(stream.records(room).map(e => e.id), ['new', 'import', 'old', 'unknown']);
  assert.equal(JSON.stringify(room), before);
});
test('invalid stored clocks remain readable at the end of the feed', () => {
  assert.deepEqual(stream.records({ events: [{ id: 'invalid', time: 1e20 }, { id: 'valid', time: 3 }] }).map(r => r.id), ['valid', 'invalid']);
  assert.equal(stream.plainName('Agent · 续2'), 'Agent · 续2');
});
test('original targets use message identities, not matching text or current selection', () => {
  const row = { id: 'shared', role: 'assistant', sessionId: 'a', nativeId: 'native-a', nativeMessageId: 'original', sharedStream: true, text: 'Same reply' };
  assert.deepEqual(stream.originalTarget(row), { sessionId: 'a', nativeId: 'native-a', messageId: 'original' });
  assert.deepEqual(stream.originalTarget({ ...row, nativeMessageId: undefined }), { sessionId: 'a', nativeId: 'native-a', messageId: '' });
  assert.equal(stream.originalTarget({ role: 'system', text: 'A said something' }), null);
});
test('wake and background-send originals belong to the sender, not the recipient', () => {
  assert.deepEqual(stream.originalTarget({ wake: { id: 'wake-1', senderId: 'a', recipientId: 'b', nativeId: 'native-a' } }),
    { sessionId: 'a', nativeId: 'native-a', messageId: 'wake-1' });
  assert.equal(stream.originalTarget({ role: 'human', recipientId: 'b', agentControl: { id: 'a', nativeId: 'native-a' } }).sessionId, 'a');
});
test('background audit links to its exact operation card and original native identity', () => {
  assert.deepEqual(stream.originalTarget({ role: 'system', sessionId: 'a',
    controlAudit: { actor: { id: 'a', nativeId: 'native-a' }, operationId: 'op-1' } }),
    { sessionId: 'a', nativeId: 'native-a', messageId: 'background:native-a:op-1' });
});
test('waiting strip excludes replaced or different-native cards while preserving confirmation detail', () => {
  const card = { id: 'card', sessionId: 'a', nativeId: 'native-a', title: 'Confirm', detail: 'Full destructive-action warning', buttons: ['Cancel', 'Confirm'], time: 3 };
  const state = { sessions: [{ id: 'a', nativeId: 'native-a', name: 'A' }], confirmations: [card, { ...card, id: 'old', replacedBy: 'card' }, { ...card, id: 'wrong', nativeId: 'different' }] };
  const items = stream.waitingItems(state);
  assert.deepEqual(items.map(i => i.id), ['card']);
  assert.equal(items[0].card.detail, card.detail);
});
