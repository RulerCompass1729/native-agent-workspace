const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const spaces = require('../collaboration-spaces.cjs');
const A = '10000000-0000-4000-8000-000000000001', B = '20000000-0000-4000-8000-000000000002';
const session = extra => ({ id: 'logical-session', nativeId: 'original-native', roomId: 'shared', memberRevision: 7,
  controlRevision: 11, connectionRevision: 3, draft: 'UNSENT ORIGINAL', ...extra });

test('legacy shared membership reads without rewriting the original session', () => {
  const s = Object.freeze(session()), before = JSON.stringify(s);
  assert.deepEqual(spaces.roomIds(s), ['shared']); assert.equal(spaces.membershipRevision(s, 'shared'), 7);
  assert.equal(spaces.isMember(s, A), false); assert.equal(spaces.membershipRevision(s, A), 0);
  assert.equal(Object.hasOwn(s, 'roomIds'), false); assert.equal(JSON.stringify(s), before);
});
test('legacy standalone session stays outside the default room', () => {
  const s = session({ roomId: null, memberRevision: undefined });
  assert.deepEqual(spaces.roomIds(s), []); assert.equal(spaces.isMember(s), false); assert.equal(spaces.membershipRevision(s), 0);
});
test('one existing native identity joins several rooms without copying its execution or draft', () => {
  const goal = { status: 'blocked', objective: 'Original goal', createdAt: 1, tokenBudget: null }, runtime = {};
  const s = session({ goal, runtime }), a = spaces.withMembership(s, A, true), b = spaces.withMembership(a, B, true);
  assert.deepEqual(spaces.roomIds(b), ['shared', A, B]); assert.equal(b.nativeId, s.nativeId); assert.equal(b.id, s.id);
  for (const key of ['controlRevision', 'connectionRevision', 'draft', 'memberRevision']) assert.equal(b[key], s[key]);
  assert.equal(b.goal, goal); assert.equal(b.runtime, runtime); assert.equal(spaces.membershipRevision(b, 'shared'), 7);
  assert.deepEqual(spaces.roomIds(s), ['shared']); assert.deepEqual(spaces.roomIds(a), ['shared', A]);
});
test('joining only a new room never grants compatibility access to shared', () => {
  const s = spaces.withMembership(session({ roomId: null }), A, true);
  assert.equal(s.roomId, null); assert.deepEqual(spaces.roomIds(s), [A]); assert.equal(spaces.isMember(s, 'shared'), false);
});
test('leaving one room preserves another room and never revives a departed membership revision', () => {
  let s = spaces.withMembership(spaces.withMembership(session(), A, true), B, true);
  const aRevision = spaces.membershipRevision(s, A), firstB = spaces.membershipRevision(s, B);
  s = spaces.withMembership(s, B, false);
  assert.equal(spaces.isMember(s, B), false); assert.equal(spaces.membershipRevision(s, B), firstB + 1);
  assert.equal(spaces.membershipRevision(s, A), aRevision); assert.equal(spaces.membershipRevision(s), 7);
  s = spaces.withMembership(s, B, true);
  assert.equal(spaces.membershipRevision(s, B), firstB + 2); assert.equal(spaces.membershipRevision(s, A), aRevision);
});
test('default-room changes retain the legacy revision while preserving other membership proofs', () => {
  const a = spaces.withMembership(session(), A, true), aRevision = spaces.membershipRevision(a, A);
  const left = spaces.withMembership(a, 'shared', false);
  assert.equal(left.roomId, null); assert.equal(left.memberRevision, 8); assert.equal(spaces.membershipRevision(left), 8);
  assert.equal(spaces.membershipRevision(left, A), aRevision); assert.deepEqual(spaces.roomIds(left), [A]);
  const back = spaces.withMembership(left, 'shared', true);
  assert.equal(back.roomId, 'shared'); assert.equal(back.memberRevision, 9); assert.equal(spaces.membershipRevision(back, A), aRevision);
});
test('repeated acknowledged membership actions are exact no-ops', () => {
  const s = session(); assert.equal(spaces.withMembership(s, 'shared', true), s);
  assert.equal(spaces.withMembership(s, A, false), s);
  const joined = spaces.withMembership(s, A, true); assert.equal(spaces.withMembership(joined, A, true), joined);
});
test('returned room lists cannot change stored membership through an alias', () => {
  const s = spaces.withMembership(session(), A, true), ids = spaces.roomIds(s); ids.length = 0;
  assert.deepEqual(spaces.roomIds(s), ['shared', A]);
});
test('unrecognized room IDs and caller flags fail without changing any session fields', () => {
  const s = session(), before = JSON.stringify(s);
  for (const id of ['', null, '../shared', '__proto__', 'constructor', 'room', 'a'.repeat(100), 'ABCDEF00-0000-4000-8000-000000000001']) {
    assert.throws(() => spaces.withMembership(s, id, true)); assert.throws(() => spaces.isMember(s, id));
  }
  for (const flag of [1, 'true', null, undefined]) assert.throws(() => spaces.withMembership(s, A, flag));
  assert.equal(JSON.stringify(s), before);
});
test('malformed membership vectors fail closed instead of silently falling back to the legacy flag', () => {
  for (const ids of [null, 'shared', {}, ['shared', 'shared'], ['shared', '../outside'], ['shared', , A]]) {
    const s = session({ roomIds: ids }), before = JSON.stringify(s);
    assert.throws(() => spaces.roomIds(s)); assert.equal(JSON.stringify(s), before);
  }
  assert.throws(() => spaces.roomIds(session({ roomIds: [A] })), 'Contradicting legacy shared access must not be guessed');
});
test('malformed or conflicting membership revisions never authorize a room operation', () => {
  for (const revisions of [null, undefined, [], 'bad', { [A]: -1 }, { [A]: .5 }, { [A]: Number.MAX_SAFE_INTEGER + 1 }, { outside: 1 }, { shared: 6 }]) {
    const s = session({ roomMembershipRevisions: revisions });
    assert.throws(() => spaces.withMembership(s, A, true)); assert.throws(() => spaces.membershipRevision(s, A));
  }
  const hostile = JSON.parse('{"__proto__":1}');
  assert.throws(() => spaces.roomIds(session({ roomMembershipRevisions: hostile })));
  const overflow = session({ roomMembershipRevisions: { [A]: Number.MAX_SAFE_INTEGER } });
  assert.throws(() => spaces.withMembership(overflow, A, true));
});
test('seven logical sessions can belong to three spaces without becoming extra native sessions', () => {
  const originals = Array.from({ length: 7 }, (_, i) => session({ id: 'session-' + i, nativeId: randomUUID(), roomId: i < 5 ? 'shared' : null }));
  const next = originals.map((s, i) => i % 2 ? spaces.withMembership(s, A, true) : spaces.withMembership(s, B, true));
  assert.equal(new Set(next.map(s => s.nativeId)).size, 7); assert.equal(new Set(next.map(s => s.id)).size, 7);
  assert.equal(next.filter(s => spaces.isMember(s, 'shared')).length, 5);
  assert.equal(next.filter(s => spaces.isMember(s, A)).length, 3); assert.equal(next.filter(s => spaces.isMember(s, B)).length, 4);
  for (let i = 0; i < next.length; i++) { assert.equal(next[i].nativeId, originals[i].nativeId); assert.equal(next[i].draft, originals[i].draft); }
});
