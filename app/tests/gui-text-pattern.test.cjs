// GUI scripts wait for the app's own catalog text through scripts/fixtures/ui-text.cjs (2026-11-08 census).
// A reworded or reverted string must fail the wait, so the pattern accepts the current catalog text only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { textPattern } = require('../../scripts/fixtures/ui-text.cjs');
const locale = require('../ui-locale.js');

test('textPattern matches the current catalog text and rejects the old wording', () => {
  const joined = textPattern('toast.joinedSpace'), created = textPattern('toast.createdSessionJoined');
  assert.ok(joined.test(locale.format('zh', 'toast.joinedSpace', { arg1: '学习小组' })));
  assert.ok(created.test(locale.format('zh', 'toast.createdSessionJoined', { name: '学习小组' })));
  for (const old of ['已加入「学习小组」', '已加入「学习小组」。']) assert.equal(joined.test(old), false, old);
  assert.equal(created.test('新会话已移到「学习小组」。'), false);
  assert.equal(joined.test('已移到「」。'), false, 'the space name is required');
  assert.throws(() => textPattern('toast.noSuchKey'), /Unknown catalog key/);
});

test('scripts that wait for join notices use catalog text, not a hard-coded wording', () => {
  for (const name of ['grid-follow', 'forget-images', 'membership-navigation', 'room-waiting', 'create-space-choice', 'space-join-empty']) {
    const source = fs.readFileSync(path.join(__dirname, '../../scripts', `test-${name}.cjs`), 'utf8');
    assert.match(source, /textPattern\('toast\.(?:joinedSpace|createdSessionJoined)'\)/, name);
    assert.doesNotMatch(source, /hasText: '已加入'|已加入\|已移到|新会话已移到/, name);
  }
});
