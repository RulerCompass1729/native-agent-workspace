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
function created(id, name, summary = {}, changes = {}, op = {}) {
  const base = { action: 'create', method: 'create', name, provider: 'codex', risks: [], createKey: 'cfg-a', ...summary };
  return card(id, { summary: base, ...changes }, op);
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
test('five same-configuration create cards become one batch while their names stay distinct', () => {
  const cards = ['A', 'B', 'C', 'D', 'E'].map((name, index) => created('c' + index, 'Session ' + name));
  const batches = plan(cards);
  assert.deepEqual(keys(batches), [['c0', 'c1', 'c2', 'c3', 'c4']]);
  assert.equal(batches[0].key, 'agent\nnative\ncreate\ncfg-a');
  assert.deepEqual(batches[0].cards.map(item => item.summary.name), ['Session A', 'Session B', 'Session C', 'Session D', 'Session E']);
});
test('create cards split across permissions, model configuration, directory and backend', () => {
  const defaults = [created('a', 'A'), created('b', 'B')];
  const edits = [created('c', 'C', { createKey: 'cfg-edits', permissionMode: 'acceptEdits', risks: ['acceptEdits'] }),
    created('d', 'D', { createKey: 'cfg-edits', permissionMode: 'acceptEdits', risks: ['acceptEdits'] })];
  const model = [created('e', 'E', { createKey: 'cfg-model', model: 'sonnet' }), created('f', 'F', { createKey: 'cfg-model', model: 'sonnet' })];
  const otherDir = [created('g', 'G', { createKey: 'cfg-dir' }), created('h', 'H', { createKey: 'cfg-dir' })];
  const otherBackend = [created('i', 'I', { createKey: 'cfg-claude', provider: 'claude' }), created('j', 'J', { createKey: 'cfg-claude', provider: 'claude' })];
  assert.deepEqual(keys(plan([...defaults, ...edits, ...model, ...otherDir, ...otherBackend])),
    [['a', 'b'], ['c', 'd'], ['e', 'f'], ['g', 'h'], ['i', 'j']]);
});
test('a create card without a configuration key or already settled is never merged', () => {
  const legacy = created('l', 'Legacy', { createKey: undefined });
  const expired = created('x', 'Expired', {}, { state: 'expired', actionable: false });
  const answered = created('y', 'Answered', {}, { actionable: false }, { answer: 'running' });
  const fresh = [created('a', 'A'), created('b', 'B')];
  for (const item of [legacy, expired, answered]) assert.equal(batchable(item), false, item.operationId);
  assert.deepEqual(keys(plan([...fresh, legacy, expired, answered])), [['a', 'b']]);
});
test('a partially expired create batch contains only the actionable cards', () => {
  const fresh = ['a', 'b', 'c', 'd'].map((id, index) => created(id, 'Session ' + index));
  const expired = created('e', 'Expired', {}, { state: 'expired', actionable: false });
  const batches = plan([...fresh, expired]);
  assert.deepEqual(keys(batches), [['a', 'b', 'c', 'd']]);
  assert.ok(!batches[0].cards.includes(expired));
});
test('create permissions may carry a risk mark, but archive keeps its risk-free rule', () => {
  const skip = [created('a', 'A', { createKey: 'cfg-skip', risks: ['skipPermissions'] }),
    created('b', 'B', { createKey: 'cfg-skip', risks: ['skipPermissions'] })];
  assert.equal(batchable(skip[0]), true);
  assert.deepEqual(keys(plan(skip)), [['a', 'b']]);
  assert.equal(batchable(card('r', { summary: { action: 'archiveSession', method: 'archiveSession', risks: ['skipPermissions'] } })), false);
});
