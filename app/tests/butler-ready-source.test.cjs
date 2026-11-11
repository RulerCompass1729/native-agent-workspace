'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { queueReadySource, storedReadySource } = require('../butler-ready.cjs');
const { validateEvent } = require('../butler-policy.cjs');
const READY = { branch: 'lane/synthetic-delivery', commit: 'abcdef1' };
const item = (extra = {}) => ({ id: 'item-a', status: 'done', text: 'Approved synthetic task', sentTo: 'member-a', ready: { ...READY }, ...extra });
function parent(source = queueReadySource('shared', item(), 'Member A'), extra = {}) {
  return { id: 'event-a', role: 'system', kind: 'queue', text: 'Visible B6 READY line', time: 123, sessionId: 'member-a',
    monitor: { kind: 'ready', key: 'ready:shared:item-a', itemId: 'item-a', ...READY }, butlerSource: source, ...extra };
}
function assertBlocked(source, reason) {
  assert.equal(source.kind, 'blocked'); assert.equal(source.payload.reason, reason);
  assert.deepEqual(validateEvent(source), source);
  assert.equal(Object.hasOwn(source.payload, 'text'), false);
  assert.equal(Object.hasOwn(source.payload, 'title'), false);
  assert.equal(Object.hasOwn(source.payload, 'memberName'), false);
}

test('typed READY keeps the complete approved task and binds replay identity to space and item', () => {
  const task = 'Complete task body '.repeat(300), original = item({ text: task, reply: 'Truncated reply is not the source' });
  const source = queueReadySource('shared', original, 'Member A');
  assert.equal(source.kind, 'ready'); assert.equal(source.payload.text, task);
  assert.equal(source.payload.title, 'READY lane/synthetic-delivery abcdef1');
  assert.equal(source.sourceRef, 'queue-ready:shared:item-a');
  assert.equal(source.payload.memberId, 'member-a'); assert.equal(source.payload.memberName, 'Member A');
  assert.equal(source.eventId, queueReadySource('shared', item({ text: 'Another wording', reply: 'Another reply' })).eventId);
  assert.equal(source.eventId, queueReadySource('shared', item({ ready: { branch: 'lane/new-head', commit: '1111111' } })).eventId);
  assert.notEqual(source.eventId, queueReadySource('shared', item({ id: 'item-b' })).eventId);
  assert.notEqual(source.eventId, queueReadySource('other-space', original).eventId);
  assert.deepEqual(storedReadySource('shared', parent(source)), source);
});

test('ordinary done or READY-looking reply without typed metadata produces no source', () => {
  const ordinary = item(); delete ordinary.ready;
  ordinary.reply = 'READY lane/synthetic-delivery abcdef1';
  assert.equal(queueReadySource('shared', ordinary), null);
  assert.equal(queueReadySource('shared', item({ ready: undefined })), null);
  assert.equal(queueReadySource('shared', null), null);
});

test('only approved queue fields are read and projected', () => {
  const value = item({ ready: { ...READY, extra: 'Future B6 metadata' } }); let reads = 0;
  for (const key of ['messages', 'privateHistory', 'environment', 'credentials', 'reply']) {
    Object.defineProperty(value, key, { enumerable: true, get() { reads++; throw Error('Unapproved read'); } });
  }
  const source = queueReadySource('shared', value);
  assert.equal(source.kind, 'ready'); assert.equal(reads, 0);
  assert.deepEqual(Object.keys(source.payload).sort(), ['itemId', 'memberId', 'spaceId', 'text', 'title']);
  const historical = parent(source);
  Object.defineProperty(historical, 'privateHistory', { get() { reads++; throw Error('Unapproved parent read'); } });
  assert.deepEqual(storedReadySource('shared', historical), source); assert.equal(reads, 0);
});

for (const bad of [null, 'READY lane/x abcdef1', { branch: '-wrong', commit: 'abcdef1' },
  { branch: 'lane/../wrong', commit: 'abcdef1' }, { branch: 'lane/x', commit: 'bad-sha' }, { branch: 'lane/x', commit: 'ABCDEF1' }]) {
  test('malformed typed READY is retained only as input-rejected metadata', () => {
    const source = queueReadySource('shared', item({ ready: bad }));
    assertBlocked(source, 'input-rejected'); assert.equal(source.payload.spaceId, 'shared'); assert.equal(source.payload.itemId, 'item-a');
  });
}

for (const change of [value => { value.text = 'x'.repeat(6001); }, value => { value.text = ' '; },
  value => { value.text = 'Authorization: Bearer not-a-secret'; },
  value => { value.sentTo = { opaque: 'not-a-secret' }; }]) {
  test('invalid business input cannot leak task or opaque identity fields through rejection', () => {
    const value = item(); change(value);
    const source = queueReadySource('shared', value, 'Member A');
    assertBlocked(source, 'input-rejected');
    assert.equal(JSON.stringify(source).includes('not-a-secret'), false);
    assert.equal(source.payload.itemId, 'item-a');
  });
}

test('a secret-shaped member name and bad parent IDs use safe bounded metadata', () => {
  const rejected = queueReadySource('shared', item(), 'DEEPSEEK_API_KEY=not-a-secret');
  assertBlocked(rejected, 'input-rejected'); assert.equal(JSON.stringify(rejected).includes('not-a-secret'), false);
  for (const [room, id] of [[null, null], ['x'.repeat(700), 'y'.repeat(700)], ['Authorization: Bearer not-a-secret', 'item-a']]) {
    const source = queueReadySource(room, item({ id }));
    assertBlocked(source, 'input-rejected'); assert.equal(JSON.stringify(source).includes('not-a-secret'), false);
    const recovered = storedReadySource(room, { id, monitor: { kind: 'ready', key: 'wrong', itemId: id, ...READY }, butlerSource: {} });
    assertBlocked(recovered, 'source-invalid'); assert.equal(JSON.stringify(recovered).includes('not-a-secret'), false);
  }
});

for (const change of [p => { p.role = 'human'; }, p => { p.kind = 'control-audit'; },
  p => { p.monitor.kind = 'queue-dry'; }, p => { p.monitor.key = 'ready:shared:another-item'; },
  p => { p.monitor.branch = '../wrong'; }, p => { p.monitor.commit = 'not-a-commit'; },
  p => { p.butlerSource.eventId = 'invented-source-id'; }, p => { p.butlerSource.sourceRef = 'invented-source-reference'; },
  p => { p.butlerSource.payload.spaceId = 'another-space'; }, p => { p.butlerSource.payload.itemId = 'another-item'; },
  p => { p.butlerSource.payload.title = 'READY lane/changed 1111111'; }, p => { p.butlerSource.payload.memberId = 'another-member'; },
  p => { delete p.sessionId; }, p => { p.butlerSource.payload.questionKey = 'An unapproved decision grant'; },
  p => { p.butlerSource.payload.text = 'Authorization: Bearer not-a-secret'; }]) {
  test('a stored source is checked against its parent READY fact instead of trusted blindly', () => {
    const original = parent(); change(original); const before = JSON.stringify(original);
    const rejected = storedReadySource('shared', original);
    assertBlocked(rejected, 'source-invalid'); assert.equal(JSON.stringify(rejected).includes('not-a-secret'), false);
    assert.equal(JSON.stringify(original), before, 'Raw parent evidence is untouched');
    assert.equal(storedReadySource('shared', original).eventId, rejected.eventId, 'Bad-source replay is stable');
  });
}

test('input-rejected source is accepted only with matching monitor identity and no extra business text', () => {
  const rejected = queueReadySource('shared', item({ text: 'Authorization: Bearer not-a-secret' }));
  const original = parent(rejected);
  assert.deepEqual(storedReadySource('shared', original), rejected);
  const wrongReason = structuredClone(original); wrongReason.butlerSource.payload.reason = 'source-invalid';
  assertBlocked(storedReadySource('shared', wrongReason), 'source-invalid');
  const withText = structuredClone(original); withText.butlerSource.payload.text = 'Smuggled extra text';
  assertBlocked(storedReadySource('shared', withText), 'source-invalid');
});

test('stored READY needs no current queue, preserves optional unnamed delivery and supports auxiliary repair', () => {
  const source = queueReadySource('shared', item({ sentTo: undefined })), original = parent(source, { sessionId: undefined });
  assert.deepEqual(storedReadySource('shared', original), source);
  const broken = structuredClone(original); broken.butlerSource = null;
  const rejected = storedReadySource('shared', broken); assertBlocked(rejected, 'source-invalid');
  assert.notEqual(rejected.eventId, source.eventId); assert.equal(rejected.sourceRef, source.sourceRef);
  assert.deepEqual(storedReadySource('shared', { ...broken, butlerSource: source }), source);
});
