const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ButlerLedger } = require('../butler-ledger.cjs');
const { projectReview } = require('../butler-review-projection.cjs');

const selection = { selectionRevision: 1, identity: { sessionId: 'review-butler', nativeId: 'review-native' }, runnerRef: 'review-runner' };
const event = (eventId, sourceRef, payload = {}, kind = 'request') => ({ eventId, sourceRef, kind, payload: { text: 'Original synthetic request', ...payload } });
const queue = (sourceRef, text = 'Verify the local fixture', spaceId = 'target-space') => ({ kind: 'queue', sourceRef, text, spaceId });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-review-project-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let serial = 0, time = 100;
  const person = Symbol('person');
  const ledger = new ButlerLedger(directory, { id: () => 'projection-' + ++serial, now: () => time++, authorizePerson: actor => actor === person });
  const complete = (events, actions, suspended = []) => {
    for (const source of events) ledger.ingest(source);
    const batch = ledger.beginBatch(selection, 100);
    return ledger.completeBatch(batch.batchId, selection, { actions, suspended });
  };
  return { ledger, complete, person };
}
const distinct = view => new Set(view.rows.filter(row => !row.suspended).map(row => row.suggestionId)).size;

test('actual ledger occurrences retain different tasks even under the same legacy action id', t => {
  const f = fixture(t);
  f.complete([event('request-a', 'task:one')], [queue('task:one', 'Task A'), queue('task:one', 'Task B')]);
  const snapshot = f.ledger.snapshot(), view = projectReview(snapshot);
  assert.equal(snapshot.actions.length, 1);
  assert.equal(view.rows.length, 2); assert.equal(distinct(view), 2);
  assert.equal(view.rows[0].actionId, view.rows[1].actionId);
  assert.deepEqual(view.rows.map(row => row.id), snapshot.batches[0].actions.map((_, index) => snapshot.batches[0].batchId + ':action:' + index));
});

test('same trusted task and full business payload across batches has one suggestion identity', t => {
  const f = fixture(t), task = { spaceId: 'source-space', itemId: 'task-a' };
  f.complete([event('request-a', 'queue-outcome:first', task)], [queue('queue-outcome:first')]);
  f.complete([event('request-b', 'queue-outcome:later', task)], [queue('queue-outcome:later')]);
  const view = projectReview(f.ledger.snapshot());
  assert.equal(view.rows.length, 2); assert.equal(distinct(view), 1);
  assert.notEqual(view.rows[0].id, view.rows[1].id);
  assert.deepEqual(view.rows[0].sources.map(source => source.eventId), ['request-a']);
  assert.deepEqual(view.rows[1].sources.map(source => source.eventId), ['request-b']);
});

test('different source task, source space, destination or exact payload stays distinct', t => {
  const f = fixture(t);
  for (const [i, sourceSpace, itemId, target, text] of [
    [0, 'space-a', 'one', 'target', 'Task'], [1, 'space-a', 'two', 'target', 'Task'],
    [2, 'space-b', 'one', 'target', 'Task'], [3, 'space-a', 'one', 'other', 'Task'],
    [4, 'space-a', 'one', 'target', 'Task ']
  ]) {
    const ref = 'source:' + i;
    f.complete([event('event-' + i, ref, { spaceId: sourceSpace, itemId })], [queue(ref, text, target)]);
  }
  assert.equal(distinct(projectReview(f.ledger.snapshot())), 5);
});

test('fixed trusted reference reuses identical payload without borrowing a later same-ref event', t => {
  const f = fixture(t);
  f.complete([event('first', 'request:fixed', { title: 'Original title' })], [queue('request:fixed')]);
  const initial = projectReview(f.ledger.snapshot());
  f.complete([event('later', 'request:fixed', { title: 'Later title' })], [queue('request:fixed')]);
  const later = projectReview(f.ledger.snapshot());
  assert.equal(distinct(later), 1);
  assert.deepEqual(later.rows[0], initial.rows[0]);
  assert.deepEqual(later.rows[0].sources.map(source => source.payload.title), ['Original title']);
});

test('event-id aliases join only their exact batch source and share its business identity', t => {
  const f = fixture(t);
  f.complete([event('exact-source', 'task:one')], [queue('exact-source'), queue('task:one')]);
  const view = projectReview(f.ledger.snapshot());
  assert.equal(distinct(view), 1);
  assert.deepEqual(view.rows.map(row => row.sources.map(source => source.eventId)), [['exact-source'], ['exact-source']]);
});

test('an exact event identity wins over a colliding source-reference namespace', t => {
  const f = fixture(t);
  f.complete([event('a', 'task:first'), event('b', 'a')], [queue('a')]);
  assert.deepEqual(projectReview(f.ledger.snapshot()).rows[0].sources.map(source => source.eventId), ['a']);
});

test('a shared ref with different trusted task boundaries is preserved as ambiguous exact evidence', t => {
  const f = fixture(t);
  f.complete([event('a', 'shared', { spaceId: 'source', itemId: 'one' }), event('b', 'shared', { spaceId: 'source', itemId: 'two' })], [queue('shared')]);
  const row = projectReview(f.ledger.snapshot()).rows[0];
  assert.equal(row.assessable, false); assert.equal(row.reason, 'source-ambiguous');
  assert.deepEqual(row.sources.map(source => source.eventId), ['a', 'b']);
  assert.ok(row.suggestionId);
});

test('canonical question ids merge reworded candidates but a host-validated new version stays distinct', t => {
  const f = fixture(t), metadata = { questionKey: 'decision:approval', decisionKind: 'approval' };
  const ask = (text, extra = {}) => ({ kind: 'question', sourceRef: 'task:approval', decisionKind: 'approval', text, ...extra });
  f.complete([event('first', 'task:approval', metadata)], [ask('Proceed?'), ask('May this proceed?')]);
  const originalQuestion = f.ledger.snapshot().questions[0];
  f.ledger.answerQuestion(originalQuestion.questionId, 'Proceed', f.person);
  f.complete([event('changed', 'task:approval', { ...metadata, outcome: 'facts-changed', supersedes: originalQuestion.questionId })],
    [ask('Proceed with the new facts?', { evidenceRevision: 'changed', supersedes: originalQuestion.questionId })]);
  const view = projectReview(f.ledger.snapshot());
  assert.equal(view.rows.length, 3); assert.equal(distinct(view), 2);
  assert.equal(view.rows[0].suggestionId, view.rows[1].suggestionId);
  assert.notEqual(view.rows[0].suggestionId, view.rows[2].suggestionId);
  assert.equal(view.rows[0].questionStatus, 'answered'); assert.equal(view.rows[2].questionStatus, 'open');
  assert.deepEqual(view.rows[2].supplementalSources.map(source => source.eventId), ['changed']);
});

test('frozen output is independent of future ledger mutation and caller changes', t => {
  const f = fixture(t);
  f.complete([event('first', 'task:one')], [queue('task:one')]);
  const snapshot = f.ledger.snapshot(), frozen = projectReview(snapshot), expected = structuredClone(frozen);
  snapshot.events[0].payload.text = 'Caller changed input'; snapshot.batches[0].actions[0].text = 'Caller changed proposal';
  f.ledger.ingest(event('later', 'task:one', { text: 'Later input' }));
  assert.deepEqual(frozen, expected);
  frozen.rows[0].sources[0].payload.text = 'Caller changed projection';
  assert.equal(f.ledger.snapshot().events[0].payload.text, 'Original synthetic request');
});

test('physical completion sequence selects full batches even when all their events predate the window', t => {
  const f = fixture(t);
  f.complete([event('first', 'task:one')], [queue('task:one')]);
  f.ledger.ingest(event('later', 'task:two'));
  const afterSequence = f.ledger.snapshot().sequence;
  const batch = f.ledger.beginBatch(selection);
  f.ledger.completeBatch(batch.batchId, selection, { actions: [queue('task:two')] });
  const view = projectReview(f.ledger.snapshot(), { afterSequence });
  assert.equal(view.rows.length, 1); assert.equal(view.rows[0].text, 'Verify the local fixture');
  assert.equal(view.rows[0].sources[0].eventId, 'later');
  assert.ok(view.rows[0].sources[0].physicalSeq <= afterSequence);
  assert.equal(view.throughSequence, f.ledger.snapshot().sequence);
});

test('suspended candidates and failed batches remain auditable without entering the suggestion denominator', t => {
  const f = fixture(t);
  f.complete([event('first', 'task:one')], [], [
    { stage: 'policy', index: 2, reason: 'ERR_BUTLER_RESULT', kind: 'queue', sourceRef: 'task:one', text: 'Unresolved proposal' },
    { stage: 'policy', index: 3, reason: 'ERR_BUTLER_RESULT', redacted: true }
  ]);
  f.ledger.ingest(event('second', 'task:two'));
  const batch = f.ledger.beginBatch(selection); f.ledger.failBatch(batch.batchId, 'Invalid reply');
  const snapshot = f.ledger.snapshot(), view = projectReview(snapshot);
  assert.equal(distinct(view), 0); assert.equal(view.rows.length, 2); assert.equal(view.failed.length, 1);
  assert.ok(view.rows.every(row => row.suspended && !Object.hasOwn(row, 'suggestionId')));
  assert.deepEqual(view.rows.map(row => row.candidateId), snapshot.batches[0].suspended.map(candidate => candidate.candidateId));
  assert.equal(view.rows[1].assessable, false); assert.equal(view.rows[1].redacted, true);
  assert.equal(view.failed[0].failure, 'Invalid reply'); assert.equal(view.failed[0].events[0].eventId, 'second');
});

test('derived READY reports and rule-reserved questions do not become extra suggestion rows', t => {
  const f = fixture(t);
  f.ledger.ingest(event('decision', 'decision:one', { questionKey: 'question:one', decisionKind: 'approval' }, 'decision'));
  f.ledger.reserveQuestion({ sourceRef: 'decision:one', decisionKind: 'approval', text: 'Rule-owned question?' });
  f.ledger.consumeRecorded(['decision']);
  f.complete([event('ready', 'delivery:one', { title: 'Ready for review' }, 'ready')], []);
  const snapshot = f.ledger.snapshot();
  assert.equal(snapshot.reports.length, 1); assert.equal(snapshot.questions.length, 1);
  assert.equal(projectReview(snapshot).rows.length, 0);
});

test('missing accepted source stays in N with a stable identity and explicit inability to judge', t => {
  const f = fixture(t);
  f.complete([event('source', 'task:one')], [queue('task:one')]);
  const snapshot = f.ledger.snapshot(); snapshot.events = [];
  const view = projectReview(snapshot), again = projectReview(snapshot);
  assert.equal(distinct(view), 1); assert.equal(view.rows[0].assessable, false);
  assert.equal(view.rows[0].reason, 'source-unavailable'); assert.ok(view.rows[0].suggestionId);
  assert.deepEqual(view, again); assert.deepEqual(view.rows[0].missingSourceEventIds, ['source']);
});

test('model-shaped extra identifiers do not override canonical projection identities', t => {
  const f = fixture(t);
  f.complete([event('source', 'task:one')], [queue('task:one', 'Task A'), queue('task:one', 'Task B')]);
  const snapshot = f.ledger.snapshot(), before = projectReview(snapshot);
  for (const action of snapshot.batches[0].actions) Object.assign(action, { suggestionId: 'invented-same', sourceBusinessIdentity: 'invented-same' });
  snapshot.actions = [{ suggestionId: 'invented-top-level' }]; snapshot.suspended = [{ candidateId: 'invented-top-level' }];
  assert.deepEqual(projectReview(snapshot), before);
});

test('invalid or missing physical boundaries fail instead of silently omitting accepted suggestions', t => {
  const f = fixture(t);
  f.complete([event('source', 'task:one')], [queue('task:one')]);
  const snapshot = f.ledger.snapshot();
  for (const afterSequence of [-1, 0.5, snapshot.sequence + 1]) assert.throws(() => projectReview(snapshot, { afterSequence }), { code: 'BUTLER_REVIEW_PROJECTION' });
  for (const completedPhysicalSeq of [undefined, 0, snapshot.sequence + 1]) {
    const malformed = structuredClone(snapshot); malformed.batches[0].completedPhysicalSeq = completedPhysicalSeq;
    assert.throws(() => projectReview(malformed), { code: 'BUTLER_REVIEW_PROJECTION' });
  }
});

test('the projection budget counts exact serialized UTF-8 bytes and never returns a partial review', t => {
  const f = fixture(t);
  f.complete([event('source', 'task:one', { text: '原始来源\n第二行' })], [queue('task:one', '核验“本地”夹具\n保留原文')]);
  const snapshot = f.ledger.snapshot(), expected = projectReview(snapshot);
  const bytes = Buffer.byteLength(JSON.stringify(expected));
  assert.deepEqual(projectReview(snapshot, { maxBytes: bytes }), expected);
  let returned;
  assert.throws(() => { returned = projectReview(snapshot, { maxBytes: bytes - 1 }); },
    { code: 'BUTLER_REVIEW_CAPACITY', message: /capacity/ });
  assert.equal(returned, undefined);
  assert.equal(f.ledger.snapshot().sequence, snapshot.sequence);
  for (const maxBytes of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1024'])
    assert.throws(() => projectReview(snapshot, { maxBytes }), { code: 'BUTLER_REVIEW_PROJECTION' });
});

test('failed and suspended context also consumes the same complete projection capacity', t => {
  const f = fixture(t);
  f.complete([event('source', 'task:one')], [], [
    { stage: 'policy', index: 0, reason: 'ERR_BUTLER_RESULT', text: 'Retain this suspended proposal', sourceRef: 'task:one' }
  ]);
  f.ledger.ingest(event('failed-source', 'task:failed'));
  const batch = f.ledger.beginBatch(selection); f.ledger.failBatch(batch.batchId, 'Retain this failed-batch context');
  const snapshot = f.ledger.snapshot(), expected = projectReview(snapshot);
  const bytes = Buffer.byteLength(JSON.stringify(expected));
  assert.deepEqual(projectReview(snapshot, { maxBytes: bytes }), expected);
  assert.throws(() => projectReview(snapshot, { maxBytes: bytes - 1 }), { code: 'BUTLER_REVIEW_CAPACITY' });
  assert.equal(expected.rows.length, 1); assert.equal(expected.failed.length, 1);
});

test('the default record capacity stops source multiplication before later occurrences are inspected', t => {
  const f = fixture(t);
  const events = Array.from({ length: 100 }, (_, index) => event('source-' + index, 'shared-source', { text: 'x'.repeat(6000) }));
  f.complete(events, [queue('shared-source', 'First occurrence'), queue('shared-source', 'Second occurrence'), queue('shared-source', 'Never inspect')]);
  const snapshot = f.ledger.snapshot(); let laterTextReads = 0;
  Object.defineProperty(snapshot.batches[0].actions[2], 'text', { get() { laterTextReads++; return 'Unreachable after capacity failure'; } });
  let returned;
  assert.throws(() => { returned = projectReview(snapshot); }, { code: 'BUTLER_REVIEW_CAPACITY' });
  assert.equal(returned, undefined);
  assert.equal(laterTextReads, 0, 'Capacity failure must stop iteration before cloning every occurrence source');
});
