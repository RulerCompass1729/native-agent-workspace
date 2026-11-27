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
  assert.deepEqual(find(batches, cards[0].key), { batch: batches[0], anchor: true });
  assert.equal(find(batches, cards[2].key).anchor, false);
});
test('an elapsed card releases the batch anchor while started batches retain their receipt rows', () => {
  const a = card('a', { expiresAt: 100 }), b = card('b', { expiresAt: 200 }), c = card('c', { expiresAt: 300 });
  assert.deepEqual(keys(plan([a, b, c], [], 100)), [['b', 'c']]);
  assert.deepEqual(keys(plan([a, b, c], [{ key: 'started', keys: [a.key, b.key, c.key] }], 100)), [['a', 'b', 'c']]);
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
  assert.equal(find(plan(settled, started), a.key).anchor, true);
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
function input(id, target, changes = {}, detail = JSON.stringify({ method: 'input', arguments: [target, 'synthetic text for ' + target] })) {
  return card(id, { summary: { action: 'input', method: 'input', target, risks: [] }, ...changes },
    { confirmation: { kind: 'message', options: { buttons: ['Cancel', 'Confirm'], cancelId: 0, ...(detail === null ? {} : { detail }) } } });
}
test('two input cards from one sender become one batch; another sender keeps its own', () => {
  const elsewhere = input('e', 'Target E', { sessionId: 'other', nativeId: 'other-native', key: 'other:other-native:e' });
  assert.deepEqual(keys(plan([input('a', 'Target A'), input('b', 'Target B'), elsewhere])), [['a', 'b']]);
});
test('input and archive cards present together each merge on their own', () => {
  const batches = plan([input('i1', 'Target A'), card('a1'), input('i2', 'Target B'), card('a2')]);
  assert.deepEqual(keys(batches).sort(), [['a1', 'a2'], ['i1', 'i2']]);
  assert.deepEqual(batches.map(b => b.cards[0].summary.method).sort(), ['archiveSession', 'input']);
});
test('an input card whose full text cannot be shown, or with a risk mark, is never merged', () => {
  const blank = input('blank', 'Target C', {}, ''), missing = input('missing', 'Target D', {}, null);
  const risky = input('risky', 'Target E', { summary: { action: 'input', method: 'input', target: 'Target E', risks: ['shared'] } });
  for (const c of [blank, missing, risky]) assert.equal(batchable(c), false, c.operationId);
  assert.deepEqual(keys(plan([input('a', 'Target A'), blank, missing, risky, input('b', 'Target B')])), [['a', 'b']]);
});
function stop(id, target, action = 'endSession', changes = {}, op = {}) {
  return card(id, { summary: { action, method: 'stop', target, risks: ['stopsWork'] }, ...changes },
    { confirmation: { kind: 'message', options: { message: 'End?', detail: 'What ending does', buttons: ['Keep session', action === 'disconnectCodex' ? 'Disconnect' : 'End session'], cancelId: 0 } }, ...op });
}
test('four stop cards from one agent become one batch, and so do four resume cards (the person, 2026-11-24)', () => {
  assert.deepEqual(keys(plan(['a', 'b', 'c', 'd'].map(id => stop(id, 'Target ' + id)))), [['a', 'b', 'c', 'd']]);
  const resume = id => card(id, { summary: { action: 'resume', method: 'resume', target: id, risks: [] } });
  assert.deepEqual(keys(plan(['e', 'f', 'g', 'h'].map(resume))), [['e', 'f', 'g', 'h']]);
});
test('ending a session and disconnecting Codex are never one card, by the action or by the question itself', () => {
  const mixed = [stop('a', 'Claude A'), stop('x', 'Codex X', 'disconnectCodex'), stop('b', 'Claude B'), stop('y', 'Codex Y', 'disconnectCodex')];
  assert.deepEqual(keys(plan(mixed)), [['a', 'b'], ['x', 'y']]);
  assert.deepEqual(plan([stop('c', 'Claude C'), stop('z', 'Codex Z', 'disconnectCodex')]), []);
  const said = stop('d', 'Claude D', 'endSession', {}, { confirmation: { kind: 'message', options: { message: 'Disconnect?', buttons: ['Keep session', 'Disconnect'], cancelId: 0 } } });
  assert.deepEqual(plan([stop('e', 'Claude E'), said]), [], 'the same action with another answer stays single');
});
test('a stop card without its named action, with any other risk mark or from another agent stays single', () => {
  const older = stop('old', 'Target', null), unmarked = stop('gone', 'Target', undefined);
  unmarked.summary.action = 'stop';
  const risky = stop('risky', 'Target', 'endSession', { summary: { action: 'endSession', method: 'stop', risks: ['stopsWork', 'deletesSharedHistory'] } });
  for (const c of [older, unmarked, risky]) assert.equal(batchable(c), false, c.operationId);
  const elsewhere = stop('e', 'Target', 'endSession', { sessionId: 'other', nativeId: 'other-native', key: 'other:other-native:e' });
  assert.deepEqual(keys(plan([stop('a', 'A'), older, elsewhere, risky, stop('b', 'B')])), [['a', 'b']]);
});
test('only stop joined the methods one answer may cover; the other work-stopping actions and deletions stay single', () => {
  assert.deepEqual([...globalThis.nativeWorkspaceConfirmationBatch.METHODS], ['archiveSession', 'create', 'resume', 'restoreSession', 'input', 'stop']);
  for (const method of ['interrupt', 'pause', 'quitService', 'forget', 'switchBackend', 'deleteSession'])
    assert.equal(batchable(card(method, { summary: { action: method, method, risks: ['stopsWork'] } })), false, method);
  assert.equal(batchable(card('archive', { summary: { action: 'archiveSession', method: 'archiveSession', risks: ['stopsWork'] } })), false);
});
