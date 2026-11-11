'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ButlerLedger } = require('../butler-ledger.cjs');
const { projectReview } = require('../butler-review-projection.cjs');

const selection = { selectionRevision: 1, identity: { sessionId: 'review-butler', nativeId: 'review-native' }, runnerRef: 'review-runner' };
const event = (id, extra = {}) => ({ eventId: id, sourceRef: 'task:' + id, kind: 'request', payload: { text: 'Original synthetic request', ...extra } });
const proposal = (ref, text = 'Synthetic suggestion') => ({ kind: 'queue', sourceRef: ref, text, spaceId: 'synthetic-space' });
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-review-store-')); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let serial = 0, time = 100; const person = Symbol('verified-person');
  const open = (extra = {}) => new ButlerLedger(directory, { id: () => 'review-fixture-' + ++serial, now: () => time++,
    authorizePerson: actor => actor === person, ...options, ...extra });
  const ledger = open();
  const complete = (events, actions, suspended = []) => {
    for (const source of events) ledger.ingest(source);
    const batch = ledger.beginBatch(selection, 100); return ledger.completeBatch(batch.batchId, selection, { actions, suspended });
  };
  const ten = (count = 10) => complete([event('source')], Array.from({ length: count }, (_, i) => proposal('task:source', 'Task ' + i)));
  return { directory, person, ledger, open, complete, ten, file: path.join(directory, 'butler-ledger.jsonl') };
}
function request(review, extra = {}) {
  return { contentDigest: review.contentDigest, expectedRevision: review.revision,
    disagreedSuggestionIds: [], disagreedCandidateIds: [], allRead: true, ...extra };
}
const ids = review => [...new Set(review.frozen.rows.filter(row => !row.suspended).map(row => row.suggestionId))];
const personError = { code: 'BUTLER_PERSON_ONLY' };

test('freeze, read, latest and confirmation require an opaque verified person; default access is denied', t => {
  const f = fixture(t); f.ten();
  const bytes = fs.readFileSync(f.file);
  for (const actor of [undefined, null, {}, { kind: 'person' }]) {
    assert.throws(() => f.ledger.freezeReview({}, actor), personError);
    assert.throws(() => f.ledger.review('review:missing', actor), personError);
    assert.throws(() => f.ledger.latestReview(actor), personError);
    assert.throws(() => f.ledger.confirmReview('review:missing', {}, actor), personError);
  }
  assert.throws(() => f.open({ authorizePerson: undefined }).freezeReview({}, f.person), personError);
  assert.deepEqual(fs.readFileSync(f.file), bytes);
});

test('latest reads never create a review, and freeze persists the host full projection with audit-only provenance', t => {
  const f = fixture(t);
  assert.equal(f.ledger.latestReview(f.person), null); assert.equal(fs.existsSync(f.file), false);
  f.ten(); const snapshot = f.ledger.snapshot(), expected = projectReview(snapshot);
  const frozen = f.ledger.freezeReview({}, f.person);
  assert.equal(frozen.revision, 0); assert.equal(frozen.confirmation, null); assert.deepEqual(frozen.confirmations, []);
  assert.equal(frozen.window.throughSequence, snapshot.sequence); assert.equal(frozen.physicalSeq, snapshot.sequence + 1);
  assert.deepEqual(frozen.frozen, expected); assert.equal(frozen.projectionVersion, expected.projectionVersion);
  assert.deepEqual(frozen.provenance, { kind: 'audit', recordPeriod: 'off', activation: 'off' });
  assert.equal(frozen.questionMetrics.repeatedQuestions, null);
  assert.equal(frozen.summary.distinctSuggestions, 10); assert.equal(frozen.summary.agreedSuggestions, 0);
  assert.equal(frozen.summary.status, 'unreviewed');
  const bytes = fs.readFileSync(f.file);
  assert.deepEqual(f.ledger.review(frozen.reviewId, f.person), frozen);
  assert.deepEqual(f.ledger.latestReview(f.person), frozen); assert.deepEqual(fs.readFileSync(f.file), bytes);
});

test('later source and question changes cannot rewrite frozen evidence or question status', t => {
  const f = fixture(t), metadata = { questionKey: 'issue:approval', decisionKind: 'approval' };
  f.complete([event('source', metadata)], [{ kind: 'question', sourceRef: 'task:source', decisionKind: 'approval', text: 'Proceed?' }]);
  const review = f.ledger.freezeReview({}, f.person), saved = structuredClone(review);
  f.ledger.answerQuestion(f.ledger.snapshot().questions[0].questionId, 'Approved', f.person);
  f.ledger.ingest(event('later', { text: 'Later synthetic facts' }));
  review.frozen.rows[0].sources[0].payload.text = 'Caller changed source'; review.questionMetrics.coverage = 'complete';
  assert.deepEqual(f.ledger.review(saved.reviewId, f.person), saved);
  assert.equal(saved.frozen.rows[0].questionStatus, 'open');
  assert.deepEqual(f.open().review(saved.reviewId, f.person), saved);
});

test('a restart restores frozen content, exact digest and saved personal confirmation without answering business questions', t => {
  const f = fixture(t); f.ten(); const frozen = f.ledger.freezeReview({}, f.person);
  const confirmed = f.ledger.confirmReview(frozen.reviewId, request(frozen), f.person), bytes = fs.readFileSync(f.file);
  assert.deepEqual(f.open().latestReview(f.person), confirmed);
  assert.deepEqual(f.open().review(frozen.reviewId, f.person), confirmed);
  assert.deepEqual(fs.readFileSync(f.file), bytes);
});

test('personal review confirmation never answers or withdraws a pending business question', t => {
  const f = fixture(t);
  f.complete([event('source', { questionKey: 'issue:approval', decisionKind: 'approval' })],
    [{ kind: 'question', sourceRef: 'task:source', decisionKind: 'approval', text: 'Proceed?' },
      ...Array.from({ length: 9 }, (_, i) => proposal('task:source', 'Task ' + i))]);
  const questions = f.ledger.snapshot().questions, frozen = f.ledger.freezeReview({}, f.person);
  f.ledger.confirmReview(frozen.reviewId, request(frozen), f.person);
  assert.equal(f.ledger.snapshot().questions[0].status, 'open');
  assert.deepEqual(f.ledger.snapshot().questions, questions);
  assert.deepEqual(f.ledger.snapshot().deliveries, []);
});

test('canonical distinct suggestions form N even when legacy action ids collide and duplicate occurrences remain visible', t => {
  const f = fixture(t); f.ten();
  f.complete([event('same-task-later')], [proposal('task:same-task-later', 'Extra task')]);
  const originalBatch = f.ledger.snapshot().batches[0];
  assert.equal(new Set(originalBatch.actions.map(action => action.actionId)).size, 1);
  const frozen = f.ledger.freezeReview({}, f.person), marked = ids(frozen).slice(0, 1);
  const confirmed = f.ledger.confirmReview(frozen.reviewId, request(frozen, { disagreedSuggestionIds: marked }), f.person);
  assert.equal(confirmed.summary.distinctSuggestions, 11); assert.equal(confirmed.summary.agreedSuggestions, 10);
  assert.equal(confirmed.summary.disagreedSuggestions, 1); assert.equal(confirmed.summary.agreementMeetsThreshold, true);
});

test('nine of ten agrees meets the shared threshold, while fewer than ten stays insufficient', t => {
  for (const n of [9, 10]) {
    const f = fixture(t); f.ten(n); const frozen = f.ledger.freezeReview({}, f.person);
    const confirmed = f.ledger.confirmReview(frozen.reviewId, request(frozen, { disagreedSuggestionIds: n === 10 ? ids(frozen).slice(0, 1) : [] }), f.person);
    assert.equal(confirmed.summary.distinctSuggestions, n);
    assert.equal(confirmed.summary.agreedSuggestions, 9);
    assert.equal(confirmed.summary.status, n === 10 ? 'reviewed' : 'insufficient-samples');
    assert.equal(confirmed.summary.agreementMeetsThreshold, n === 10 ? true : null);
    assert.equal(confirmed.provenance.recordPeriod, 'off');
  }
});

test('one unassessable peer keeps its canonical suggestion in N and prevents that whole group agreeing', t => {
  const f = fixture(t), metadata = { questionKey: 'issue:approval', decisionKind: 'approval' };
  f.complete([event('source', { ...metadata, spaceId: 'source-space', itemId: 'task-one' })],
    [{ kind: 'question', sourceRef: 'task:source', decisionKind: 'approval', text: 'Proceed?' }]);
  const a = event('ambiguous-a', { ...metadata, spaceId: 'source-space', itemId: 'task-one' });
  const b = event('ambiguous-b', { ...metadata, spaceId: 'source-space', itemId: 'task-two' });
  a.sourceRef = b.sourceRef = 'task:ambiguous';
  f.complete([a, b], [{ kind: 'question', sourceRef: 'task:ambiguous', decisionKind: 'approval', text: 'Rephrased same question?' }]);
  const beforeGood = f.ledger.snapshot().sequence;
  f.complete([event('good')], Array.from({ length: 9 }, (_, i) => proposal('task:good', 'Good suggestion ' + i)));
  const frozen = f.ledger.freezeReview({}, f.person);
  const questionRows = frozen.frozen.rows.filter(row => row.kind === 'question');
  assert.equal(questionRows[0].suggestionId, questionRows[1].suggestionId);
  assert.equal(questionRows[0].assessable, true); assert.equal(questionRows[1].assessable, false);
  const goodId = frozen.frozen.rows.find(row => row.physicalSeq > beforeGood).suggestionId;
  const confirmed = f.ledger.confirmReview(frozen.reviewId, request(frozen, { disagreedSuggestionIds: [goodId] }), f.person);
  assert.equal(confirmed.summary.distinctSuggestions, 10); assert.equal(confirmed.summary.unableSuggestions, 1);
  assert.equal(confirmed.summary.agreedSuggestions, 8); assert.equal(confirmed.summary.agreementMeetsThreshold, false);
});

test('suspended candidate opinions persist separately and never enter the suggestion denominator', t => {
  const f = fixture(t);
  f.complete([event('source')], Array.from({ length: 10 }, (_, i) => proposal('task:source', 'Task ' + i)), [
    { stage: 'policy', index: 10, kind: 'queue', sourceRef: 'task:source', text: 'Unconfirmed candidate', reason: 'ERR_SYNTHETIC' },
    { stage: 'policy', index: 11, kind: 'question', redacted: true, reason: 'ERR_SYNTHETIC' }
  ]);
  const frozen = f.ledger.freezeReview({}, f.person), disagreedCandidateIds = frozen.frozen.rows.filter(row => row.suspended).map(row => row.candidateId);
  const confirmed = f.ledger.confirmReview(frozen.reviewId, request(frozen, { disagreedCandidateIds }), f.person);
  assert.equal(confirmed.summary.distinctSuggestions, 10); assert.equal(confirmed.summary.agreedSuggestions, 10);
  assert.equal(confirmed.summary.suspendedCandidates, 2); assert.equal(confirmed.summary.disagreedCandidates, 2);
  assert.deepEqual(confirmed.confirmation.disagreedCandidateIds, [...disagreedCandidateIds].sort());
  assert.deepEqual(f.open().review(frozen.reviewId, f.person), confirmed);
});

test('digest, identifiers, all-read attestation and revision are checked before any confirmation is written', t => {
  const f = fixture(t); f.ten(); const frozen = f.ledger.freezeReview({}, f.person), bytes = fs.readFileSync(f.file);
  for (const extra of [{ contentDigest: 'review-content:wrong' }, { allRead: false }, { allRead: 1 }, { allRead: undefined },
    { expectedRevision: 1 }, { expectedRevision: -1 }, { disagreedSuggestionIds: ['suggestion:unknown'] },
    { disagreedCandidateIds: ['candidate:unknown'] }, { disagreedSuggestionIds: [ids(frozen)[0], ids(frozen)[0]] }, { summary: { agreedSuggestions: 10 } }])
    assert.throws(() => f.ledger.confirmReview(frozen.reviewId, request(frozen, extra), f.person));
  assert.equal(f.ledger.review(frozen.reviewId, f.person).revision, 0); assert.deepEqual(fs.readFileSync(f.file), bytes);
});

test('same normalized confirmation is idempotent and competing dialogs cannot overwrite a newer revision', t => {
  const f = fixture(t); f.ten(); const frozen = f.ledger.freezeReview({}, f.person), marks = ids(frozen).slice(0, 2);
  const payload = request(frozen, { disagreedSuggestionIds: marks }), confirmed = f.ledger.confirmReview(frozen.reviewId, payload, f.person);
  const bytes = fs.readFileSync(f.file);
  assert.deepEqual(f.ledger.confirmReview(frozen.reviewId, { ...payload, disagreedSuggestionIds: [...marks].reverse() }, f.person), confirmed);
  assert.deepEqual(fs.readFileSync(f.file), bytes);
  assert.throws(() => f.ledger.confirmReview(frozen.reviewId, request(frozen), f.person), { code: 'BUTLER_REVIEW_REVISION' });
  assert.throws(() => f.open().confirmReview(frozen.reviewId, request(frozen), f.person), { code: 'BUTLER_REVIEW_REVISION' });
});

test('personal amendments append a revision and preserve previous receipts; replaying an old receipt changes nothing', t => {
  const f = fixture(t); f.ten(); const frozen = f.ledger.freezeReview({}, f.person);
  const firstPayload = request(frozen, { disagreedSuggestionIds: ids(frozen).slice(0, 1) });
  const first = f.ledger.confirmReview(frozen.reviewId, firstPayload, f.person);
  const second = f.ledger.confirmReview(frozen.reviewId, request(first), f.person), bytes = fs.readFileSync(f.file);
  assert.equal(second.revision, 2); assert.equal(second.confirmations.length, 2); assert.equal(second.summary.agreedSuggestions, 10);
  assert.deepEqual(second.confirmations[0], first.confirmation);
  assert.deepEqual(f.ledger.confirmReview(frozen.reviewId, firstPayload, f.person), second);
  assert.deepEqual(fs.readFileSync(f.file), bytes); assert.deepEqual(f.open().latestReview(f.person), second);
});

test('freeze options cannot claim rows, counts, a working day or caller-supplied metric proofs', t => {
  const f = fixture(t); f.ten(); const bytes = fs.readFileSync(f.file);
  for (const extra of [{ rows: [] }, { questionMetrics: { repeatedQuestions: 0 } }, { provenance: { kind: 'working-day' } },
    { recordPeriod: 'on' }, { afterSequence: -1 }, { throughSequence: 1 }, { metricEpochId: 'forged' }])
    assert.throws(() => f.ledger.freezeReview(extra, f.person));
  assert.deepEqual(fs.readFileSync(f.file), bytes); assert.equal(f.ledger.latestReview(f.person), null);
});

test('explicit freeze certifies the current writer prefix atomically and keeps metrics fixed after later displays', t => {
  const f = fixture(t); f.ledger.openQuestionMetricEpoch('metric-epoch'); f.ten();
  f.ledger.ingest({ eventId: 'decision', sourceRef: 'task:decision', kind: 'decision', payload: { text: 'Synthetic decision',
    questionKey: 'issue:decision', decisionKind: 'approval' } });
  const q = f.ledger.reserveQuestion({ sourceRef: 'task:decision', decisionKind: 'approval', text: 'Proceed?' });
  const send = attemptId => f.ledger.beginQuestionSend({ attemptId, questionId: q.question.questionId, deliveryId: q.deliveryId,
    sourceEventId: 'decision', channel: 'notification' });
  send('send-one'); f.ledger.ackQuestionSend('send-one', 'shown');
  const before = f.ledger.snapshot().sequence, frozen = f.ledger.freezeReview({}, f.person);
  assert.equal(frozen.window.throughSequence, before); assert.equal(f.ledger.snapshot().sequence, before + 1);
  assert.equal(frozen.questionMetrics.coverage, 'complete'); assert.equal(frozen.questionMetrics.repeatedQuestions, 0);
  assert.equal(f.open().questionSendMetrics(frozen.window).coverage, 'complete');
  send('send-two'); f.ledger.ackQuestionSend('send-two', 'shown');
  assert.equal(f.ledger.questionSendMetrics().repeatedQuestions, 1);
  assert.deepEqual(f.open().review(frozen.reviewId, f.person).questionMetrics, frozen.questionMetrics);
});

test('missing epoch or an existing gap does not block audit review and never turns into a verified zero', t => {
  for (const gap of [false, true]) {
    const f = fixture(t); f.ten();
    if (gap) { f.ledger.openQuestionMetricEpoch('metric-epoch'); f.ledger.markQuestionMetricGap('unexpected-display'); }
    const frozen = f.ledger.freezeReview({}, f.person);
    assert.equal(frozen.questionMetrics.repeatedQuestions, null);
    assert.notEqual(frozen.questionMetrics.coverage, 'complete');
    assert.deepEqual(f.open().review(frozen.reviewId, f.person), frozen);
  }
});

test('a later qualified epoch cannot replace the unknown metrics saved in an earlier audit review', t => {
  const f = fixture(t); f.ten(); const frozen = f.ledger.freezeReview({}, f.person);
  const epoch = f.ledger.openQuestionMetricEpoch('metric-epoch');
  assert.equal(f.ledger.questionSendMetrics({ afterSequence: epoch.physicalSeq - 1 }).repeatedQuestions, 0);
  assert.equal(f.ledger.review(frozen.reviewId, f.person).questionMetrics.repeatedQuestions, null);
  assert.deepEqual(f.open().review(frozen.reviewId, f.person).questionMetrics, frozen.questionMetrics);
});

test('physical completion window includes full sources from earlier rows and latest selects the newest freeze', t => {
  const f = fixture(t); f.ledger.ingest(event('source')); const afterSequence = f.ledger.snapshot().sequence;
  const batch = f.ledger.beginBatch(selection); f.ledger.completeBatch(batch.batchId, selection, { actions: [proposal('task:source')] });
  const first = f.ledger.freezeReview({ afterSequence }, f.person);
  assert.equal(first.frozen.rows.length, 1); assert.equal(first.frozen.rows[0].sources[0].physicalSeq, afterSequence);
  const second = f.ledger.freezeReview({}, f.person);
  assert.notEqual(second.reviewId, first.reviewId); assert.deepEqual(f.ledger.latestReview(f.person), second);
  assert.deepEqual(f.ledger.review(first.reviewId, f.person), first);
});

test('freeze over the actual 2 MiB record cap fails without truncating evidence or committing a checkpoint', t => {
  const f = fixture(t); f.ledger.openQuestionMetricEpoch('metric-epoch');
  const sources = Array.from({ length: 100 }, (_, i) => event('source-' + i, { text: 'Synthetic '.repeat(110) }));
  f.complete(sources, Array.from({ length: 30 }, (_, i) => proposal('task:source-0', 'Suggestion ' + i)));
  const bytes = fs.readFileSync(f.file), before = f.ledger.snapshot();
  const projectionBytes = Buffer.byteLength(JSON.stringify(projectReview(before, { maxBytes: 8 * 1024 * 1024 })));
  assert.ok(projectionBytes > 2 * 1024 * 1024);
  t.diagnostic('Oversized synthetic projection bytes: ' + projectionBytes);
  assert.throws(() => f.ledger.freezeReview({}, f.person), /capacity/);
  assert.deepEqual(fs.readFileSync(f.file), bytes); assert.equal(f.ledger.snapshot().sequence, before.sequence);
  assert.deepEqual(f.ledger.snapshot().questionMetricEpochs, before.questionMetricEpochs);
  assert.equal(f.ledger.latestReview(f.person), null);
});

test('failed freeze write cannot report saved data or silently persist its atomic metric certification', t => {
  const f = fixture(t); f.ledger.openQuestionMetricEpoch('metric-epoch'); f.ten(); const bytes = fs.readFileSync(f.file);
  const write = t.mock.method(fs, 'writeSync', () => { throw Error('Synthetic disk failure'); });
  assert.throws(() => f.ledger.freezeReview({}, f.person), { code: 'BUTLER_LEDGER_WRITE' }); write.mock.restore();
  assert.deepEqual(fs.readFileSync(f.file), bytes);
  const restored = f.open(); assert.equal(restored.latestReview(f.person), null);
  assert.equal(restored.questionSendMetrics().repeatedQuestions, null);
  assert.deepEqual(restored.snapshot().questionMetricEpochs[0].checkpoints, []);
});

test('failed confirmation write leaves the existing frozen review unconfirmed on recovery', t => {
  const f = fixture(t); f.ten(); const frozen = f.ledger.freezeReview({}, f.person), bytes = fs.readFileSync(f.file);
  const write = t.mock.method(fs, 'writeSync', () => { throw Error('Synthetic disk failure'); });
  assert.throws(() => f.ledger.confirmReview(frozen.reviewId, request(frozen), f.person), { code: 'BUTLER_LEDGER_WRITE' }); write.mock.restore();
  assert.deepEqual(fs.readFileSync(f.file), bytes); assert.deepEqual(f.open().review(frozen.reviewId, f.person), frozen);
});

test('changed persisted evidence and invalid confirmation identities fail replay without repairing the private journal', t => {
  for (const part of ['frozen', 'confirmation']) {
    const f = fixture(t); f.ten(); const frozen = f.ledger.freezeReview({}, f.person);
    f.ledger.confirmReview(frozen.reviewId, request(frozen), f.person);
    const records = fs.readFileSync(f.file, 'utf8').trimEnd().split('\n').map(JSON.parse);
    if (part === 'frozen') records.find(record => record.type === 'review-freeze').data.frozen.rows[0].text = 'Changed persisted suggestion';
    else records.find(record => record.type === 'review-confirm').data.disagreedSuggestionIds = ['suggestion:unknown'];
    const changed = records.map(record => JSON.stringify(record)).join('\n') + '\n'; fs.writeFileSync(f.file, changed);
    assert.throws(() => f.open()); assert.equal(fs.readFileSync(f.file, 'utf8'), changed);
  }
});

test('a self-consistent rewritten digest cannot certify invented source content or fabricated zero-repeat metrics', t => {
  const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' :
    value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
  for (const part of ['source', 'metrics']) {
    const f = fixture(t); f.ten(); f.ledger.freezeReview({}, f.person);
    const records = fs.readFileSync(f.file, 'utf8').trimEnd().split('\n').map(JSON.parse), data = records.find(record => record.type === 'review-freeze').data;
    if (part === 'source') data.frozen.rows[0].sources[0].payload.text = 'Changed frozen source';
    else { data.questionMetrics.coverage = 'complete'; data.questionMetrics.repeatedQuestions = 0; }
    const content = { projectionVersion: data.projectionVersion, window: data.window, provenance: data.provenance,
      frozen: data.frozen, questionMetrics: data.questionMetrics };
    data.contentDigest = 'review-content:' + createHash('sha256').update(canonical(content)).digest('hex');
    const changed = records.map(record => JSON.stringify(record)).join('\n') + '\n'; fs.writeFileSync(f.file, changed);
    assert.throws(() => f.open(), { code: 'BUTLER_REVIEW_INVALID' });
    assert.equal(fs.readFileSync(f.file, 'utf8'), changed);
  }
});


test('repeated freezes reuse unchanged evidence and the latest saved review after reopening the ledger without growing the shared journal', t => {
  const f = fixture(t); f.ten(); const first = f.ledger.freezeReview({}, f.person);
  const saved = f.ledger.confirmReview(first.reviewId, request(first, { disagreedSuggestionIds: ids(first).slice(0, 1) }), f.person);
  const bytes = fs.readFileSync(f.file), sequence = f.ledger.snapshot().sequence;
  for (let i = 0; i < 3; i++) assert.deepEqual(f.ledger.freezeReview({}, f.person), saved);
  assert.deepEqual(f.open().freezeReview({}, f.person), saved);
  assert.equal(f.ledger.snapshot().sequence, sequence); assert.deepEqual(fs.readFileSync(f.file), bytes);
});

test('new business facts, metric boundaries and a different requested window each require a fresh freeze', t => {
  const f = fixture(t); f.ten(); const first = f.ledger.freezeReview({}, f.person);
  f.ledger.ingest(event('later')); const second = f.ledger.freezeReview({}, f.person);
  assert.notEqual(second.reviewId, first.reviewId); assert.equal(second.window.throughSequence, second.physicalSeq - 1);
  f.ledger.openQuestionMetricEpoch('new-metric-epoch'); const third = f.ledger.freezeReview({}, f.person);
  assert.notEqual(third.reviewId, second.reviewId);
  const scoped = f.ledger.freezeReview({ afterSequence: first.window.throughSequence }, f.person);
  assert.notEqual(scoped.reviewId, third.reviewId); assert.deepEqual(scoped.frozen.rows, []);
  assert.deepEqual(f.open().latestReview(f.person), scoped);
});

test('confirming an older review does not make unchanged latest evidence consume another full record', t => {
  const f = fixture(t); f.ten(); const old = f.ledger.freezeReview({}, f.person);
  f.ledger.ingest(event('later')); const latest = f.ledger.freezeReview({}, f.person);
  f.ledger.confirmReview(old.reviewId, request(old), f.person);
  const bytes = fs.readFileSync(f.file);
  assert.deepEqual(f.ledger.freezeReview({}, f.person), latest);
  assert.deepEqual(f.open().freezeReview({}, f.person), latest); assert.deepEqual(fs.readFileSync(f.file), bytes);
});
