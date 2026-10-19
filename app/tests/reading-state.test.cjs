const test = require('node:test');
const assert = require('node:assert/strict');
const { readingState } = require('../reading-state.cjs');
const position = { top: 123.5, follow: false, anchor: 'message-3', offset: -20 };

test('reading metadata retains geometry and drops text or unknown fields', () => {
  const result = readingState({ session: { ...position, selection: 'SYNTHETIC_PRIVATE_SELECTION', text: 'not persisted' } });
  assert.deepEqual(result.session, position);
  assert.equal(Object.getPrototypeOf(result), null);
  assert.equal(JSON.stringify(result).includes('SELECTION'), false);
  // IDs are data, including reserved property names.
  assert.deepEqual(readingState(JSON.parse('{"__proto__":' + JSON.stringify(position) + '}')).__proto__, position);
});
test('invalid or unbounded reading metadata is rejected', () => {
  for (const value of [null, [], 'text', Object.fromEntries(Array.from({ length: 129 }, (_, i) => [i, position]))]) assert.throws(() => readingState(value));
  for (const bad of [{ top: NaN }, { top: -1 }, { top: 1e10 }, { offset: Infinity }, { offset: -1e10 }, { follow: 'yes' }, { anchor: 'x'.repeat(101) }]) assert.throws(() => readingState({ session: { ...position, ...bad } }));
  assert.throws(() => readingState({ ['x'.repeat(101)]: position }));
});
