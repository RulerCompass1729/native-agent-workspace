'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const policy = require('../butler-policy.cjs');
const event = { eventId: 'business-event', kind: 'request', sourceRef: 'business:request', payload: { text: 'Approved synthetic request',
  questionKey: 'business:space-choice', decisionKind: 'space-selection' } };
const space = (id, extra = {}) => ({ id, name: 'Synthetic space ' + id, archived: false, writable: true, members: [], queue: [], ...extra });
const counts = (extra = {}) => ({ queued: 0, sent: 0, waiting: 0, done: 0, failed: 0, cancelled: 0, ...extra });
const input = catalog => policy.buildInput({ batchId: 'synthetic-batch', events: [event], catalog });
const interpret = (actions, catalog) => policy.interpretResult({ actions }, { events: [event], catalog });
const action = (kind, spaceId) => ({ kind, sourceRef: event.sourceRef, text: 'Synthetic proposal', ...(spaceId === undefined ? {} : { spaceId }) });

test('the default business index includes read-only active spaces without giving them queue authority', () => {
  const readonly = space('readonly', { writable: false }), writable = space('writable');
  assert.deepEqual(input([readonly, writable]).spaces, [
    { id: 'readonly', name: readonly.name, writable: false, queueCounts: counts() },
    { id: 'writable', name: writable.name, writable: true, queueCounts: counts() }
  ]);
  const result = interpret([action('queue', readonly.id), action('queue', writable.id), action('report', readonly.id), action('question', readonly.id)], [readonly, writable]);
  assert.equal(result.suspended.length, 1); assert.equal(result.suspended[0].kind, 'queue');
  assert.deepEqual(result.actions.map(row => [row.kind, row.spaceId]), [['queue', 'writable'], ['report', 'readonly'], ['question', 'readonly']]);
});

test('default archived spaces are neither read nor writable and no archived detail getter is touched', () => {
  let reads = 0; const archived = { archived: true };
  for (const key of ['id', 'name', 'writable', 'queue', 'members', 'messages', 'environment']) {
    Object.defineProperty(archived, key, { enumerable: true, get() { reads++; throw Error('Archived details require the separate reader'); } });
  }
  assert.deepEqual(input([archived]).spaces, []); assert.equal(reads, 0);
  assert.deepEqual(interpret([action('queue')], [space('live'), archived]).actions, [action('queue', 'live')]);
  assert.equal(reads, 0, 'Queue-only validation does not request archived metadata');
  const target = space('archived-target', { archived: true });
  const result = interpret([action('queue', target.id), action('report', target.id), action('question', target.id)], [target]);
  assert.deepEqual(result.actions.map(row => [row.kind, row.spaceId]), [['report', target.id], ['question', target.id]]);
  assert.equal(result.suspended.length, 1); assert.equal(result.suspended[0].kind, 'queue');
});

test('indexing and result validation read queue status only, never bodies, membership, delivery or private session fields', () => {
  let reads = 0;
  const queues = ['queued', 'queued', 'sent', 'waiting', 'done', 'failed', 'cancelled'].map(status => {
    const row = { status };
    for (const key of ['id', 'text', 'reply', 'messages', 'environment', 'nativeHistory', 'deliveries']) {
      Object.defineProperty(row, key, { enumerable: true, get() { reads++; throw Error('Queue detail is not part of the index'); } });
    }
    return row;
  });
  const original = space('approved', { queue: queues });
  for (const key of ['members', 'messages', 'ownSession', 'nativeId', 'environment', 'nativeHistory', 'deliveries']) {
    Object.defineProperty(original, key, { enumerable: true, get() { reads++; throw Error('Private space data must remain untouched'); } });
  }
  const result = input([original]);
  assert.deepEqual(result.spaces[0], { id: original.id, name: original.name, writable: true,
    queueCounts: counts({ queued: 2, sent: 1, waiting: 1, done: 1, failed: 1, cancelled: 1 }) });
  assert.deepEqual(interpret([action('queue')], [original]).actions, [action('queue', original.id)]);
  assert.equal(reads, 0);
  assert.equal(JSON.stringify(result).includes('nativeId'), false);
  assert.equal(Object.hasOwn(result.spaces[0], 'members'), false); assert.equal(Object.hasOwn(result.spaces[0], 'queue'), false);
});

test('multiple readable spaces with exactly one writable space auto-select only that writable target', () => {
  const catalog = [space('read-a', { writable: false }), space('write-a'), space('read-b', { writable: 'true' }), space('old', { archived: true })];
  assert.equal(input(catalog).spaces.length, 3);
  assert.deepEqual(interpret([action('queue')], catalog).actions, [action('queue', 'write-a')]);
  for (const writable of [false, undefined, null, 1, 'true']) {
    const readonly = space('read-only', { writable });
    const result = interpret([action('queue', readonly.id)], [readonly]);
    assert.equal(result.actions.length, 0); assert.equal(result.suspended.length, 1);
  }
});

test('zero or several writable targets retain the stable host decision instead of treating readability as a choice', () => {
  for (const catalog of [[space('read', { writable: false })], [space('read', { writable: false }), space('write-a'), space('write-b')]]) {
    const result = interpret([action('queue')], catalog);
    assert.deepEqual(result.actions, [{ ...action('question'), decisionKind: event.payload.decisionKind }]);
  }
});

test('named read/write projection APIs and the compatibility alias retain the same explicit contract', () => {
  const catalog = [space('read', { writable: false }), space('write'), space('old', { archived: true })];
  assert.equal(policy.catalogRows, policy.readableCatalogRows);
  assert.deepEqual(policy.readableCatalogRows(catalog), input(catalog).spaces);
  assert.deepEqual(policy.writableCatalogRows(catalog), input(catalog).spaces.filter(row => row.writable));
  assert.deepEqual(policy.readableCatalogRows(catalog, { includeArchived: true }).map(row => [row.id, row.writable]),
    [['read', false], ['write', true], ['old', false]]);
});

test('the index has finite space, queue and serialized-byte limits and rejects instead of truncating', () => {
  assert.equal(policy.MAX_BUSINESS_INDEX_BYTES, 128 * 1024);
  const small = Array.from({ length: 200 }, (_, n) => space('s-' + n));
  assert.equal(input(small).spaces.length, 200);
  const large = Array.from({ length: 200 }, (_, n) => space('s-' + n + '-'.repeat(190), { name: '界'.repeat(200) }));
  for (const catalog of [large, [...small, space('overflow')], [space('bad-status', { queue: [{ status: 'unknown' }] })],
    [space('too-many-items', { queue: Array.from({ length: 301 }, () => ({ status: 'done' })) })]]) {
    assert.throws(() => input(catalog), { code: 'ERR_BUTLER_CATALOG' });
    assert.throws(() => interpret([], catalog), { code: 'ERR_BUTLER_CATALOG' });
  }
  assert.equal(input([space('max-items', { queue: Array.from({ length: 300 }, () => ({ status: 'done' })) })]).spaces[0].queueCounts.done, 300);
});

test('business events and pending questions retain their approved fields without widening to private context', () => {
  let reads = 0;
  const request = { ...event, payload: { ...event.payload, memberName: 'Synthetic member' } };
  const question = { questionId: 'synthetic-question', sourceRef: event.sourceRef, decisionSource: event.payload.questionKey,
    decisionKind: 'space-selection', text: 'Synthetic pending decision', status: 'open' };
  for (const value of [request, question]) for (const key of ['messages', 'environment', 'ownSession']) {
    Object.defineProperty(value, key, { enumerable: true, get() { reads++; throw Error('Unapproved context'); } });
  }
  const built = policy.buildInput({ batchId: 'synthetic-batch', events: [request], catalog: [space('read', { writable: false })], questions: [question] });
  assert.deepEqual(built.events, [{ eventId: request.eventId, kind: request.kind, sourceRef: request.sourceRef, payload: request.payload }]);
  assert.deepEqual(built.pendingQuestions, [{ questionId: question.questionId, sourceRef: question.sourceRef,
    decisionSource: question.decisionSource, decisionKind: question.decisionKind, text: question.text }]);
  assert.equal(reads, 0);
  const bad = { eventId: request.eventId, kind: request.kind, sourceRef: request.sourceRef, payload: { ...request.payload } };
  Object.defineProperty(bad.payload, 'privateMessages', { enumerable: true, get() { reads++; throw Error('Rejected extra payload'); } });
  assert.throws(() => policy.buildInput({ batchId: 'synthetic-batch', events: [bad], catalog: [] }), { code: 'ERR_BUTLER_BUSINESS_DATA' });
  assert.equal(reads, 0);
});
