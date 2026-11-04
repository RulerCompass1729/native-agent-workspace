const test = require('node:test'), assert = require('node:assert/strict');
const { replyReference, threadIndex } = require('../room-threads.js');
test('explicit parent edges group interleaved streams and nested replies; cycles and orphans remain visible', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'a1', replyTo: 'a' }, { id: 'b1', replyTo: 'b' }, { id: 'a2', replyTo: 'a1' },
    { id: 'orphan', replyTo: 'gone' }, { id: 'x', replyTo: 'y' }, { id: 'y', replyTo: 'x' }];
  const index = threadIndex(rows);
  assert.deepEqual(index.groups.get('a').map(m => m.id), ['a', 'a1', 'a2']);
  assert.deepEqual(index.groups.get('b').map(m => m.id), ['b', 'b1']);
  assert.deepEqual([...index.groups.values()].flat().map(m => m.id).sort(), rows.map(m => m.id).sort());
  assert.equal(index.roots.get('orphan'), 'orphan'); assert.equal(index.roots.get('x'), 'x');
  for (const bad of [42, {}, 'x'.repeat(101), 'bad\nvalue']) assert.throws(() => replyReference(bad));
});

test('invalid reply identity carries display metadata while the standalone data contract keeps its original fallback', () => {
  const fs = require('node:fs'), vm = require('node:vm'), locale = require('../ui-locale.js');
  assert.throws(() => replyReference('bad\nreply'), error => error.message === '无效的回复关联。' && locale.errorText('en', error) === 'Invalid reply reference.');
  const source = fs.readFileSync(require.resolve('../room-threads.js'), 'utf8'), standalone = {};
  vm.runInNewContext(source, standalone);
  assert.throws(() => standalone.nativeWorkspaceThreads.replyReference(42), error => error.message === '无效的回复关联。' && !error.uiMessage);
  const display = { nativeWorkspaceLocale: locale }; vm.runInNewContext(source, display);
  assert.throws(() => display.nativeWorkspaceThreads.replyReference({}), error => locale.errorText('en', error) === 'Invalid reply reference.');
});
