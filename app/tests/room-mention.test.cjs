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
