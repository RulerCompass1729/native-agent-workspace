'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { ButlerLedger } = require('../butler-ledger.cjs');

const selection = { selectionRevision: 1, identity: { sessionId: 'availability-butler', nativeId: 'availability-native' }, runnerRef: 'availability-runner' };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-review-availability-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let serial = 0, time = 100;
  const person = Symbol('verified-person'), open = (options = {}) => new ButlerLedger(directory, {
    now: () => time++, id: () => 'availability-' + ++serial, authorizePerson: actor => actor === person, ...options,
  });
  const ledger = open(), file = path.join(directory, 'butler-ledger.jsonl');
  const input = () => ledger.ingest({ eventId: 'source', kind: 'request', sourceRef: 'task:availability', payload: { text: 'Synthetic review source' } });
  const begin = () => { input(); return ledger.beginBatch(selection); };
  return { ledger, person, open, file, input, begin };
}
function bytes(file) { return fs.existsSync(file) ? fs.readFileSync(file) : null; }
function presence(f, expected, ledger = f.ledger) {
  const before = bytes(f.file);
  assert.equal(ledger.hasReviewData(f.person), expected);
  assert.deepEqual(bytes(f.file), before, 'Availability never creates or appends a journal record');
}

test('review data presence requires the verified person and a healthy writer', t => {
  const f = fixture(t);
  for (const actor of [undefined, null, {}, { kind: 'person' }, Symbol('another-person')])
    assert.throws(() => f.ledger.hasReviewData(actor), { code: 'BUTLER_PERSON_ONLY' });
  assert.throws(() => f.open({ authorizePerson: undefined }).hasReviewData(f.person), { code: 'BUTLER_PERSON_ONLY' });
  assert.throws(() => f.open({ authorizePerson: () => { throw Error('Rejected verifier'); } }).hasReviewData(f.person), { code: 'BUTLER_PERSON_ONLY' });
  f.ledger.failed = true;
  assert.throws(() => f.ledger.hasReviewData(f.person), { code: 'BUTLER_LEDGER_FAILED' });
  assert.throws(() => f.ledger.hasReviewData({ kind: 'person' }), { code: 'BUTLER_PERSON_ONLY' });
  assert.equal(fs.existsSync(f.file), false);
});

test('empty, pending-only, metric-only and running ledgers have no review data', t => {
  const f = fixture(t); presence(f, false);
  f.input(); presence(f, false);
  f.ledger.openQuestionMetricEpoch('availability-epoch'); presence(f, false);
  f.ledger.beginBatch(selection); presence(f, false);
  assert.equal(f.ledger.latestReview(f.person), null);
});

test('an empty completed batch and an empty frozen record do not create review data', t => {
  const f = fixture(t), batch = f.begin();
  f.ledger.completeBatch(batch.batchId, selection, { actions: [] }); presence(f, false);
  const frozen = f.ledger.freezeReview({}, f.person);
  assert.deepEqual(frozen.frozen.rows, []); assert.deepEqual(frozen.frozen.failed, []);
  assert.equal(f.ledger.latestReview(f.person).reviewId, frozen.reviewId);
  presence(f, false); presence(f, false, f.open());
  assert.equal(Object.hasOwn(f.ledger.snapshot(), 'hasStoredReviewData'), false);
  for (const record of fs.readFileSync(f.file, 'utf8').trim().split('\n').map(JSON.parse))
    assert.equal(Object.hasOwn(record.data, 'hasStoredReviewData'), false);
});

test('unfrozen completed proposals are available even while latest review is null', t => {
  const f = fixture(t), batch = f.begin();
  f.ledger.completeBatch(batch.batchId, selection, { actions: [{ kind: 'queue', sourceRef: 'task:availability', spaceId: 'target', text: 'Synthetic suggestion' }] });
  assert.equal(f.ledger.latestReview(f.person), null);
  presence(f, true); presence(f, true, f.open());
});

test('a suspended-only batch is reviewable even when its candidate has no text', t => {
  const f = fixture(t), batch = f.begin();
  f.ledger.completeBatch(batch.batchId, selection, { actions: [], suspended: [{ stage: 'policy', index: 0, reason: 'ERR_BUTLER_RESULT', redacted: true }] });
  assert.equal(f.ledger.latestReview(f.person), null);
  presence(f, true); presence(f, true, f.open());
});

test('failure alone is reviewable; retry without a saved review removes that failure entry', t => {
  const f = fixture(t), batch = f.begin();
  f.ledger.failBatch(batch.batchId, 'Synthetic parse failure');
  presence(f, true); presence(f, true, f.open());
  f.ledger.retryBatch(batch.batchId, selection);
  presence(f, false); presence(f, false, f.open());
});

test('a nonempty failure review remains available after retry, empty completion and replay', t => {
  const f = fixture(t), batch = f.begin();
  f.ledger.failBatch(batch.batchId, 'Synthetic parse failure');
  const frozen = f.ledger.freezeReview({}, f.person);
  assert.equal(frozen.frozen.rows.length, 0); assert.equal(frozen.frozen.failed.length, 1);
  f.ledger.retryBatch(batch.batchId, selection);
  presence(f, true); presence(f, true, f.open());
  f.ledger.completeBatch(batch.batchId, selection, { actions: [] });
  const later = f.ledger.freezeReview({}, f.person);
  assert.equal(later.frozen.rows.length, 0); assert.equal(later.frozen.failed.length, 0);
  presence(f, true); presence(f, true, f.open());
  assert.deepEqual(later.provenance, { kind: 'audit', recordPeriod: 'off', activation: 'off' });
});

test('presence uses constant-time indexes without copying or projecting the ledger', t => {
  const f = fixture(t), batch = f.begin();
  f.ledger.failBatch(batch.batchId, 'Synthetic parse failure');
  const frozen = f.ledger.freezeReview({}, f.person);
  f.ledger.retryBatch(batch.batchId, selection);
  const before = bytes(f.file), snapshot = f.ledger.snapshot();
  const denied = () => { throw Error('Presence must not enumerate, copy, freeze or project historical data'); };
  for (const method of ['snapshot', 'latestReview', 'freezeReview']) t.mock.method(f.ledger, method, denied);
  for (const map of [f.ledger.state.batches, f.ledger.state.reviews]) {
    t.mock.method(map, 'values', denied); t.mock.method(map, 'entries', denied); t.mock.method(map, Symbol.iterator, denied);
  }
  t.mock.method(globalThis, 'structuredClone', denied);
  for (let i = 0; i < 20; i++) assert.equal(f.ledger.hasReviewData(f.person), true);
  t.mock.restoreAll();
  assert.deepEqual(bytes(f.file), before);
  assert.deepEqual(f.ledger.snapshot(), snapshot);
  assert.equal(f.ledger.review(frozen.reviewId, f.person).confirmation, null);
});
