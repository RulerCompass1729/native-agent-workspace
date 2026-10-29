const test = require('node:test'), assert = require('node:assert/strict');
const { valid, edited, body } = require('../room-mention.js');
const draft = '@核查 · Codex · abc123 检查这个 @literal';
const token = '@核查 · Codex · abc123';
const binding = { id: 'explicit-session-id', start: 0, end: token.length, text: token };
test('only the selected exact token grants an identity; body retains ordinary mentions', () => {
  assert.equal(valid(binding, draft), true);
  assert.equal(body(binding, draft), '检查这个 @literal');
  for (const value of [null, { ...binding, start: -1 }, { ...binding, end: 999 }, { ...binding, id: '' }, { ...binding, text: '@别的' }]) assert.equal(valid(value, draft), false);
  assert.equal(body(null, '@核查 检查'), '');
});
test('editing the message preserves ID, while deleting/replacing/pasting over a mention revokes it', () => {
  const at = draft.length;
  assert.deepEqual(edited(binding, draft, draft + '。', { start: at, end: at, type: 'insertText' }), binding);
  assert.equal(edited(binding, draft, draft.slice(1), { start: 0, end: 1, type: 'deleteContentForward' }), null);
  assert.equal(edited(binding, draft, draft, { start: 0, end: draft.length, type: 'insertFromPaste' }), null);
  assert.equal(edited(binding, draft, draft, { start: at, end: at, type: 'historyUndo' }), null);
  assert.equal(edited(binding, draft, draft, null), null);
  assert.equal(edited(binding, draft, '@核查x' + draft.slice(3), { start: 3, end: 3, type: 'insertText' }), null);
});
test('changes before a token rebase the exact range without matching by name', () => {
  const before = '问： ' + draft, b = { ...binding, start: 3, end: token.length + 3 };
  assert.deepEqual(edited(b, before, '请' + before, { start: 0, end: 0, type: 'insertText' }), { ...b, start: 4, end: b.end + 1 });
  assert.equal(edited(binding, draft, draft.slice(0, token.length - 1) + draft.slice(token.length), { start: token.length, end: token.length, type: 'deleteContentBackward' }), null);
  assert.equal(valid(binding, token + 'x'), false);
});

const { atomicRange, caretPosition, editHistory } = require('../room-mention.js');
test('selected recipient edits cover the whole token and its one separator, leaving the body intact', () => {
  const raw = token + ' body';
  for (const edit of [
    { start: token.length + 1, end: token.length + 1, type: 'deleteContentBackward' },
    { start: 0, end: 0, type: 'deleteContentForward' },
    { start: 2, end: 4, type: 'insertText' },
    { start: 2, end: 4, type: 'insertFromPaste' },
    { start: 0, end: token.length, type: 'deleteByCut' },
  ]) assert.deepEqual(atomicRange(binding, raw, edit), { start: 0, end: token.length + 1 });
  assert.equal(atomicRange(binding, raw, { start: raw.length, end: raw.length, type: 'deleteContentBackward' }), null);
  assert.equal(atomicRange(binding, raw, { start: 2, end: 4, type: 'insertCompositionText' }), null);
  assert.equal(atomicRange(binding, raw, { start: 2, end: 4, type: 'historyUndo' }), null);
  assert.equal(atomicRange(null, raw, { start: 2, end: 4, type: 'insertText' }), null);
  assert.deepEqual(atomicRange(binding, token, { start: 0, end: 0, type: 'deleteContentForward' }), { start: 0, end: token.length });
});
test('caret skips the selected token as a unit while body positions stay native', () => {
  const raw = token + ' body', end = token.length + 1;
  assert.equal(caretPosition(binding, raw, 0, 1), end);
  assert.equal(caretPosition(binding, raw, end, -1), 0);
  assert.equal(caretPosition(binding, raw, 2, 0), 0);
  assert.equal(caretPosition(binding, raw, end - 1, 0), end);
  assert.equal(caretPosition(binding, raw, raw.length, -1), raw.length);
});
test('native undo/redo restores explicit metadata for exact edit occurrences, including coalesced body edits', () => {
  const h = editHistory(), raw = token + ' body';
  h.record('', null, raw, binding); h.record(raw, binding, 'body', null);
  assert.deepEqual(h.travel('historyUndo', 'body', null, raw, true), binding);
  assert.equal(h.travel('historyRedo', raw, binding, 'body', true), null);
  assert.deepEqual(h.travel('historyUndo', 'body', null, raw, true), binding);
  h.record(raw, binding, raw + '!', binding); h.record(raw + '!', binding, raw + '!?', binding);
  assert.deepEqual(h.travel('historyUndo', raw + '!?', binding, raw, true), binding);
});
test('identical manually typed text does not inherit authority from an earlier selected occurrence', () => {
  const h = editHistory(), raw = token + ' body', other = '@Other body', b = { id: 'other', text: '@Other', start: 0, end: 6 };
  h.record('', null, raw, binding); h.record(raw, binding, '', null); h.record('', null, raw, null); h.record(raw, null, other, b);
  assert.equal(h.travel('historyUndo', other, b, raw, true), null);
});
test('untrusted, unmatched, changed programmatic state and discarded redo never acquire recipient authority', () => {
  const raw = token + ' body';
  for (const trusted of [false, undefined]) { const h = editHistory(); h.record('', null, raw, binding); h.record(raw, binding, '', null); assert.equal(h.travel('historyUndo', '', null, raw, trusted), null); }
  const h = editHistory(); h.record('', null, raw, binding); h.record(raw, binding, 'body', null);
  assert.equal(h.travel('historyUndo', 'unknown state', null, raw, true), null);
  h.record(raw, null, 'new draft', null); assert.equal(h.travel('historyRedo', 'new draft', null, raw, true), null);
});
test('history keeps the original member revision and fails closed beyond its finite retention', () => {
  const h = editHistory(3), original = { ...binding, active: true, memberRevision: 4 }, raw = token + ' body';
  h.record('', null, raw, original); h.record(raw, original, 'body', null);
  const restored = h.travel('historyUndo', 'body', null, raw, true); assert.equal(restored.memberRevision, 4);
  let before = raw, prior = original;
  for (let i = 0; i < 5; i++) { const text = '@New' + i, next = { id: 'next-' + i, text, start: 0, end: text.length }; h.record(before, prior, text, next); before = text; prior = next; }
  assert.equal(h.travel('historyUndo', before, prior, raw, true), null);
});

test('long body typing retains the explicit selection anchor when native Undo coalesces the text', () => {
  const h = editHistory(), raw = token + ' body'; h.record('', null, raw, binding);
  let before = raw;
  for (let i = 0; i < 100; i++) { const after = before + 'x'; h.record(before, binding, after, binding); before = after; }
  assert.deepEqual(h.travel('historyUndo', before, binding, raw, true), binding);
});

test('the exact latest edit can restore its selected binding despite an older unbound identical value', () => {
  const h = editHistory(), raw = token + ' body';
  h.record('', null, raw, null); h.record(raw, null, 'body', null); h.record('body', null, raw, binding);
  h.record(raw, binding, 'replacementbody', null);
  assert.deepEqual(h.travel('historyUndo', 'replacementbody', null, raw, true), binding);
  assert.equal(h.travel('historyRedo', raw, binding, 'replacementbody', true), null);
});

test('native word deletion adjacent to a selected name cannot leave a partial token', () => {
  const raw = 'before ' + token + '   body', shifted = { ...binding, start: 7, end: 7 + token.length };
  assert.deepEqual(atomicRange(shifted, raw, { start: 6, end: 6, type: 'deleteWordForward' }), { start: 6, end: shifted.end + 1 });
  assert.deepEqual(atomicRange(shifted, raw, { start: shifted.end + 3, end: shifted.end + 3, type: 'deleteWordBackward' }), { start: 7, end: shifted.end + 3 });
});

test('native line deletion retains its native target rather than becoming an atomic Backspace', () => {
  for (const type of ['deleteSoftLineBackward', 'deleteHardLineBackward', 'deleteSoftLineForward', 'deleteEntireSoftLine']) {
    assert.equal(atomicRange(binding, draft, { start: binding.end, end: binding.end, type }), null);
  }
});
