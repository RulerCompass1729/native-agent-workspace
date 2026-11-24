const test = require('node:test'), assert = require('node:assert/strict');
const { outcome, owned } = require('../rotation-handoff.cjs');
const input = () => ({ id: 'handoff', role: 'user', origin: 'naw-dispatch', dispatchPurpose: { kind: 'rotation-handoff' }, nativeId: 'native', turnId: 'first' });
const proof = { nativeId: 'native', controlRevision: 0, draftRevision: 0, placementRevision: 0 };
for (const extra of [{ nativeId: 'other' }, { turnId: 'other' }, { status: 'running' }, { status: undefined }, { kind: 'response' }]) test('handoff ignores unrelated or nonterminal proof ' + JSON.stringify(extra), () => {
  const s = { nativeId: 'native', state: 'idle', messages: [input(), { kind: 'turn', nativeId: 'native', turnId: 'first', status: 'complete', ...extra }] };
  assert.equal(outcome(s, 'handoff'), 'pending');
});
test('an incomplete complete boundary is failure, and current identity cannot borrow old completion', () => {
  const s = { nativeId: 'native', state: 'idle', messages: [input(), { kind: 'turn', nativeId: 'native', turnId: 'first', status: 'complete', incomplete: true }] };
  assert.equal(outcome(s, 'handoff'), 'failed'); s.nativeId = 'new-native'; assert.equal(outcome(s, 'handoff'), 'pending');
});
test('cleanup refuses malformed owner proof, queued input and unknown active goal', () => {
  const s = { nativeId: 'native', messages: [input()] };
  assert.equal(owned(s, proof, 'handoff'), true);
  assert.equal(owned(s, { ...proof, controlRevision: -1 }, 'handoff'), false);
  assert.equal(owned({ ...s, pendingQueue: ['queued'] }, proof, 'handoff'), false);
  assert.equal(owned({ ...s, nativeGoal: { known: false } }, proof, 'handoff'), false);
});
