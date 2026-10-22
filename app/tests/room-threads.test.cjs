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
