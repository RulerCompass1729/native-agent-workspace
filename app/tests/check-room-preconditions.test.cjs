const test = require('node:test'), assert = require('node:assert/strict');
const { checkRoom } = require('../../scripts/check-room.cjs');
const other = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const person = id => ({ id, owner: 'test-owner', state: 'idle', terminalAvailable: true, roomId: null, liveDraft: '', messages: [] });

for (const [name, patch] of [
  ['legacy shared membership', { roomId: 'shared' }],
  ['another space in canonical memberships', { roomIds: [other] }],
  ['several canonical memberships', { roomId: 'shared', roomIds: ['shared', other] }],
  ['unrecognized membership shape', { roomIds: {} }],
]) test(`desktop room workflow refuses ${name} before any UI action`, async () => {
  const before = { owner: 'test-owner', room: { messages: [], run: null }, sessions: [Object.assign(person('a'), patch), person('b')] };
  const original = structuredClone(before), result = {};
  await checkRoom({ evaluate: async () => before, locator() { assert.fail('Existing space must not be changed'); } }, null, result);
  assert.equal(result.skipped, true); assert.equal(result.changed, undefined);
  assert.deepEqual(before, original);
});

test('two independent idle terminals reach the actual workflow rather than skipping', async () => {
  const result = {}, before = { owner: 'test-owner', room: { messages: [], run: null }, sessions: [person('a'), { ...person('b'), roomIds: [] }] };
  await assert.rejects(checkRoom({ evaluate: async () => before, locator() { throw Error('Positive branch reached first UI action'); } }, null, result), /Positive branch reached first UI action/);
  assert.equal(result.skipped, undefined); assert.equal(result.changed, true);
  assert.equal(result.people.length, 2);
});
