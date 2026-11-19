const test = require('node:test'), assert = require('node:assert/strict');
require('../renderer/confirmation-batch.js');
const { plan, find, itemState, batchable } = globalThis.nativeWorkspaceConfirmationBatch;
let time = 0;
function card(id, changes = {}, op = {}) {
  const base = { key: 'agent:native:' + id, operationId: id, sessionId: 'agent', nativeId: 'native', time: ++time, state: 'confirmation-required', actionable: true,
    replacedBy: null, summary: { action: 'archiveSession', method: 'archiveSession', risks: [] },
    message: { backgroundOperation: { id, state: 'confirmation-required', confirmation: { kind: 'message', options: { buttons: ['Cancel', 'Archive'], cancelId: 0 } }, ...op } } };
  return { ...base, ...changes };
}
const keys = batches => batches.map(b => b.cards.map(c => c.operationId));
test('archive cards of one agent with no risk mark become one batch, oldest first', () => {
  const cards = [card('a'), card('b'), card('c')];
  assert.deepEqual(keys(plan(cards)), [['a', 'b', 'c']]);
  const batches = plan(cards);
  assert.deepEqual(find(batches, cards[2].key), { batch: batches[0], anchor: true });
  assert.equal(find(batches, cards[0].key).anchor, false);
});
test('cards are not merged across risk, method, agent, replacement, repetition, an answer already given or a single card', () => {
  const risky = card('r', { summary: { action: 'archiveSession', method: 'archiveSession', risks: ['shared'] } });
  const other = card('o', { summary: { action: 'deleteSession', method: 'deleteSession', risks: [] } });
  const elsewhere = card('e', { sessionId: 'other', nativeId: 'other-native', key: 'other:other-native:e' });
  const replaced = card('p', { replacedBy: { id: 'x' } }), repeated = card('q', {}, { repeated: true });
  const answered = card('w', {}, { answer: 'queued' }), closed = card('n', { actionable: false });
  for (const c of [risky, other, replaced, repeated, answered, closed]) assert.equal(batchable(c), false, c.operationId);
  assert.deepEqual(plan([card('only'), risky, other, elsewhere, replaced, repeated, answered, closed]), []);
  assert.deepEqual(keys(plan([card('a'), elsewhere, card('b'), risky])), [['a', 'b']]);
});
test('a started batch keeps exactly the cards it was shown with while they settle', () => {
  const a = card('a'), b = card('b'), later = card('later');
  const started = [{ key: 'batch', keys: [a.key, b.key] }];
  const settled = [card('a', { state: 'complete', actionable: false }, { state: 'complete' }), card('b', {}, { answer: 'running' }), later];
  assert.deepEqual(keys(plan(settled, started)), [['a', 'b']]);
  assert.deepEqual(settled.slice(0, 2).map(itemState), ['done', 'running']);
  assert.equal(itemState(card('v', { state: 'not-executed' }, { state: 'not-executed', disposition: 'invalidated' })), 'void');
  assert.equal(itemState(card('x', {}, { answer: 'queued' })), 'queued');
});
