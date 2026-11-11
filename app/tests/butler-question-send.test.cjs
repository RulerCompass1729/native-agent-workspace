'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ButlerLedger } = require('../butler-ledger.cjs');
const selection = { selectionRevision: 1, identity: { sessionId: 'synthetic-butler', nativeId: 'synthetic-native' }, runnerRef: 'synthetic-runner' };

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-question-send-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let clock = 100, serial = 0;
  const person = Symbol('synthetic-person');
  const open = () => new ButlerLedger(directory, { now: () => clock++, id: () => 'synthetic-' + ++serial, authorizePerson: value => value === person });
  return { directory, person, file: path.join(directory, 'butler-ledger.jsonl'), open, ledger: open() };
}
function question(ledger, label = 'one', extra = {}) {
  const sourceEventId = 'decision-' + label, sourceRef = 'task:' + label;
  ledger.ingest({ eventId: sourceEventId, sourceRef, kind: 'decision', payload: { text: 'Synthetic question source',
    title: 'Proceed with the synthetic task?', questionKey: 'issue:' + label, decisionKind: 'approval', ...extra } });
  return { ...ledger.reserveQuestion({ sourceRef, decisionKind: 'approval', text: 'Proceed with the synthetic task?' }), sourceEventId };
}
function intent(ledger, q, attemptId = 'send-one', channel = 'notification') {
  return ledger.beginQuestionSend({ attemptId, questionId: q.question.questionId, deliveryId: q.deliveryId, sourceEventId: q.sourceEventId, channel });
}
function shown(ledger, q, attemptId = 'send-one', channel = 'notification') {
  intent(ledger, q, attemptId, channel); return ledger.ackQuestionSend(attemptId, 'shown');
}

test('no metric epoch is unavailable, not a certified zero', t => {
  const f = fixture(t), stats = f.ledger.questionSendMetrics();
  assert.equal(stats.coverage, 'unavailable'); assert.equal(stats.repeatedQuestions, null);
  assert.equal(stats.shownAttempts, 0); assert.equal(fs.existsSync(f.file), false);
});

test('one real shown receipt is zero repeats; another cross-channel attempt is a repeat', t => {
  const f = fixture(t); f.ledger.openQuestionMetricEpoch('epoch-one');
  const q = question(f.ledger); shown(f.ledger, q);
  let stats = f.ledger.questionSendMetrics();
  assert.equal(stats.coverage, 'complete'); assert.equal(stats.shownAttempts, 1); assert.equal(stats.repeatedQuestions, 0);
  shown(f.ledger, q, 'send-two', 'butler-ask');
  stats = f.ledger.questionSendMetrics();
  assert.equal(stats.shownAttempts, 2); assert.equal(stats.knownRepeatedSends, 1); assert.equal(stats.repeatedQuestions, 1);
  assert.equal(f.ledger.snapshot().deliveries.length, 1, 'One logical delivery cannot erase two physical sends');
});

test('same-attempt ACK replay is idempotent and does not append or inflate delivery counts', t => {
  const f = fixture(t); f.ledger.openQuestionMetricEpoch('epoch-one'); const q = question(f.ledger);
  const first = shown(f.ledger, q), bytes = fs.readFileSync(f.file);
  assert.deepEqual(f.ledger.ackQuestionSend('send-one', 'shown'), first);
  assert.deepEqual(intent(f.ledger, q), first);
  assert.deepEqual(fs.readFileSync(f.file), bytes);
  assert.equal(f.ledger.questionSendMetrics().shownAttempts, 1);
  assert.equal(f.ledger.questionSendMetrics().knownRepeatedSends, 0);
});

test('duplicate and suspended candidates remain separate from actual delivery', t => {
  const f = fixture(t); f.ledger.openQuestionMetricEpoch('epoch-one');
  f.ledger.ingest({ eventId: 'request-one', sourceRef: 'task:one', kind: 'request',
    payload: { text: 'Synthetic task', questionKey: 'issue:one', decisionKind: 'approval' } });
  const batch = f.ledger.beginBatch(selection), proposal = { kind: 'question', sourceRef: 'task:one', decisionKind: 'approval', text: 'Proceed?' };
  f.ledger.completeBatch(batch.batchId, selection, { actions: [proposal, { ...proposal, text: 'Same question, different wording?' }],
    suspended: [{ stage: 'policy', index: 2, kind: 'question', sourceRef: 'task:one', reason: 'ERR_SYNTHETIC', text: 'Suspended question?' }] });
  const stats = f.ledger.questionSendMetrics();
  assert.equal(stats.duplicateQuestionCandidatesBlocked, 1); assert.equal(stats.suspendedQuestionCandidates, 1);
  assert.equal(stats.shownAttempts, 0); assert.equal(stats.repeatedQuestions, 0); assert.equal(stats.coverage, 'complete');
});

test('intent and unknown receipt cannot be counted as a shown notification or as zero repeats', t => {
  const f = fixture(t); f.ledger.openQuestionMetricEpoch('epoch-one'); const q = question(f.ledger);
  intent(f.ledger, q); let stats = f.ledger.questionSendMetrics();
  assert.equal(stats.unknownAttempts, 1); assert.equal(stats.shownAttempts, 0); assert.equal(stats.repeatedQuestions, null);
  f.ledger.ackQuestionSend('send-one', 'unknown'); stats = f.ledger.questionSendMetrics();
  assert.equal(stats.unknownAttempts, 1); assert.equal(stats.coverage, 'incomplete');
  f.ledger.ackQuestionSend('send-one', 'shown'); stats = f.ledger.questionSendMetrics();
  assert.equal(stats.unknownAttempts, 0); assert.equal(stats.shownAttempts, 1); assert.equal(stats.repeatedQuestions, 0);
});

test('failed native notification is known not-shown, and a later shown attempt is not a repeat', t => {
  const f = fixture(t); f.ledger.openQuestionMetricEpoch('epoch-one'); const q = question(f.ledger);
  intent(f.ledger, q); f.ledger.ackQuestionSend('send-one', 'failed');
  assert.equal(f.ledger.questionSendMetrics().repeatedQuestions, 0);
  shown(f.ledger, q, 'send-two');
  assert.equal(f.ledger.questionSendMetrics().shownAttempts, 1);
  assert.equal(f.ledger.questionSendMetrics().repeatedQuestions, 0);
});

test('display followed by crash before ACK remains unknown and is never automatically adopted or resent', t => {
  const f = fixture(t); f.ledger.openQuestionMetricEpoch('epoch-one'); const q = question(f.ledger); intent(f.ledger, q);
  // The OS may have displayed it. Without its durable ACK a restart cannot know.
  const bytes = fs.readFileSync(f.file), restored = f.open();
  assert.deepEqual(restored.snapshot(), f.ledger.snapshot());
  assert.equal(restored.questionSendMetrics().unknownAttempts, 1);
  assert.equal(restored.questionSendMetrics().repeatedQuestions, null);
  assert.throws(() => restored.openQuestionMetricEpoch('epoch-one'), { code: 'BUTLER_QUESTION_METRIC_EPOCH' });
  assert.throws(() => restored.closeQuestionMetricEpoch(), { code: 'BUTLER_QUESTION_METRIC_EPOCH' });
  assert.throws(() => restored.checkpointQuestionMetrics(), { code: 'BUTLER_QUESTION_METRIC_EPOCH' });
  assert.throws(() => restored.ackQuestionSend('send-one', 'shown'), { code: 'BUTLER_QUESTION_METRIC_EPOCH' });
  assert.deepEqual(fs.readFileSync(f.file), bytes);
});

test('even a resolved send cannot certify an old unclosed epoch after restart', t => {
  const f = fixture(t); f.ledger.openQuestionMetricEpoch('epoch-one'); const q = question(f.ledger); shown(f.ledger, q);
  assert.equal(f.ledger.questionSendMetrics().coverage, 'complete');
  const restored = f.open();
  assert.equal(restored.questionSendMetrics().shownAttempts, 1);
  assert.equal(restored.questionSendMetrics().repeatedQuestions, null);
  const epoch = restored.openQuestionMetricEpoch('epoch-two');
  assert.equal(restored.questionSendMetrics().coverage, 'incomplete');
  assert.equal(restored.questionSendMetrics({ afterSequence: epoch.physicalSeq - 1 }).repeatedQuestions, 0,
    'A newly owned period does not silently certify the preceding crashed period');
});

test('normal epoch close certifies a fully observed historical window without claiming ownership on reload', t => {
  const f = fixture(t); f.ledger.openQuestionMetricEpoch('epoch-one'); const q = question(f.ledger); shown(f.ledger, q);
  f.ledger.closeQuestionMetricEpoch();
  const restored = f.open(), stats = restored.questionSendMetrics();
  assert.equal(stats.coverage, 'complete'); assert.equal(stats.repeatedQuestions, 0);
  assert.throws(() => restored.beginQuestionSend({ attemptId: 'another', channel: 'notification' }), { code: 'BUTLER_QUESTION_METRIC_EPOCH' });
});

test('a checkpoint certifies only its frozen prefix; a later crash cannot wash uncertainty into that prefix', t => {
  const f = fixture(t); f.ledger.openQuestionMetricEpoch('epoch-one'); const q = question(f.ledger); shown(f.ledger, q);
  const throughSequence = f.ledger.snapshot().sequence, certificate = f.ledger.checkpointQuestionMetrics(throughSequence);
  assert.equal(certificate.throughSequence, throughSequence);
  const q2 = question(f.ledger, 'two'); intent(f.ledger, q2, 'send-two');
  const restored = f.open();
  assert.equal(restored.questionSendMetrics({ throughSequence }).repeatedQuestions, 0);
  assert.equal(restored.questionSendMetrics({ throughSequence }).shownAttempts, 1);
  assert.equal(restored.questionSendMetrics().repeatedQuestions, null);
  assert.equal(restored.questionSendMetrics().unknownAttempts, 1);
});

test('a shown receipt after the freeze is not retroactively inserted into a past frozen count', t => {
  const f = fixture(t); f.ledger.openQuestionMetricEpoch('epoch-one'); const q = question(f.ledger); intent(f.ledger, q);
  const throughSequence = f.ledger.snapshot().sequence; f.ledger.checkpointQuestionMetrics(); f.ledger.ackQuestionSend('send-one', 'shown');
  const old = f.ledger.questionSendMetrics({ throughSequence });
  assert.equal(old.shownAttempts, 0); assert.equal(old.unknownAttempts, 1); assert.equal(old.repeatedQuestions, null);
  assert.equal(f.ledger.questionSendMetrics().shownAttempts, 1);
});

test('checkpointed prefix survives a later persistent gap; closing the gap epoch never certifies its tail', t => {
  const f = fixture(t); f.ledger.openQuestionMetricEpoch('epoch-one'); const q = question(f.ledger); shown(f.ledger, q);
  const throughSequence = f.ledger.snapshot().sequence; f.ledger.checkpointQuestionMetrics();
  f.ledger.markQuestionMetricGap('unexpected-display');
  assert.throws(() => f.ledger.checkpointQuestionMetrics(), { code: 'BUTLER_QUESTION_METRIC_EPOCH' });
  f.ledger.closeQuestionMetricEpoch();
  const restored = f.open();
  assert.equal(restored.questionSendMetrics({ throughSequence }).coverage, 'complete');
  assert.equal(restored.questionSendMetrics().repeatedQuestions, null);
  assert.equal(restored.snapshot().questionMetricGaps[0].reason, 'unexpected-display');
});

test('send intent write failure cannot erase the durable open epoch or make a restart report zero', t => {
  const f = fixture(t); f.ledger.openQuestionMetricEpoch('epoch-one'); const q = question(f.ledger), before = fs.readFileSync(f.file);
  const write = t.mock.method(fs, 'writeSync', () => { throw Error('Synthetic disk failure'); });
  assert.throws(() => intent(f.ledger, q), { code: 'BUTLER_LEDGER_WRITE' }); write.mock.restore();
  assert.equal(f.ledger.questionSendMetrics().coverage, 'unavailable');
  assert.equal(f.ledger.questionSendMetrics().repeatedQuestions, null);
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal(f.open().questionSendMetrics().repeatedQuestions, null);
  assert.equal(f.open().snapshot().questionMetricEpochs[0].status, 'open');
});

test('gap write failure is remembered in memory and the old open epoch protects recovery', t => {
  const f = fixture(t); f.ledger.openQuestionMetricEpoch('epoch-one'); const before = fs.readFileSync(f.file);
  const write = t.mock.method(fs, 'writeSync', () => { throw Error('Synthetic disk failure'); });
  assert.throws(() => f.ledger.markQuestionMetricGap('write-failed'), { code: 'BUTLER_LEDGER_WRITE' }); write.mock.restore();
  assert.equal(f.ledger.questionSendMetrics().coverage, 'unavailable');
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal(f.open().questionSendMetrics().coverage, 'incomplete');
  assert.equal(f.open().questionSendMetrics().repeatedQuestions, null);
});

test('epoch persistence failure never gives this writer authority to begin a send', t => {
  const f = fixture(t), write = t.mock.method(fs, 'writeSync', () => { throw Error('Synthetic disk failure'); });
  assert.throws(() => f.ledger.openQuestionMetricEpoch('epoch-one'), { code: 'BUTLER_LEDGER_WRITE' }); write.mock.restore();
  assert.equal(f.ledger.questionSendMetrics().repeatedQuestions, null);
  assert.throws(() => f.ledger.beginQuestionSend({ attemptId: 'send-one', channel: 'notification' }), { code: 'BUTLER_LEDGER_FAILED' });
});

test('a period counts an earlier period shown question as repeated when actually shown again', t => {
  const f = fixture(t); f.ledger.openQuestionMetricEpoch('epoch-one'); const q = question(f.ledger); shown(f.ledger, q);
  f.ledger.closeQuestionMetricEpoch(); const afterSequence = f.ledger.snapshot().sequence;
  const next = f.open(); next.openQuestionMetricEpoch('epoch-two'); shown(next, q, 'send-two', 'butler-ask');
  const stats = next.questionSendMetrics({ afterSequence });
  assert.equal(stats.coverage, 'complete'); assert.equal(stats.shownAttempts, 1); assert.equal(stats.knownRepeatedSends, 1); assert.equal(stats.repeatedQuestions, 1);
});

test('unrelated legacy logical receipts do not poison a new period, but the same-question baseline remains unknown', t => {
  const f = fixture(t), old = question(f.ledger, 'old'); f.ledger.ackDelivery(old.deliveryId, 'sent');
  const epoch = f.ledger.openQuestionMetricEpoch('epoch-one'), afterSequence = epoch.physicalSeq - 1;
  const fresh = question(f.ledger, 'fresh'); shown(f.ledger, fresh, 'send-fresh');
  assert.equal(f.ledger.questionSendMetrics({ afterSequence }).repeatedQuestions, 0);
  shown(f.ledger, old, 'send-old');
  const stats = f.ledger.questionSendMetrics({ afterSequence });
  assert.equal(stats.shownAttempts, 2); assert.equal(stats.knownRepeatedSends, 0);
  assert.equal(stats.uncertainBaselineQuestions, 1); assert.equal(stats.repeatedQuestions, null);
});

test('an old unresolved physical intent may still display later and cannot become zero by starting a new period', t => {
  const f = fixture(t); f.ledger.openQuestionMetricEpoch('epoch-one'); const old = question(f.ledger, 'old');
  intent(f.ledger, old); f.ledger.ackQuestionSend('send-one', 'unknown'); f.ledger.closeQuestionMetricEpoch();
  const afterSequence = f.ledger.snapshot().sequence, next = f.open(); next.openQuestionMetricEpoch('epoch-two');
  const fresh = question(next, 'fresh'); shown(next, fresh, 'fresh-send');
  const stats = next.questionSendMetrics({ afterSequence });
  assert.equal(stats.shownAttempts, 1); assert.equal(stats.unknownAttempts, 1); assert.equal(stats.repeatedQuestions, null);
});

test('unassociated physical shown attempts are retained and block a certified zero', t => {
  const f = fixture(t); f.ledger.openQuestionMetricEpoch('epoch-one');
  f.ledger.beginQuestionSend({ attemptId: 'send-one', questionId: null, sourceEventId: 'not-yet-associated', deliveryId: null, channel: 'notification' });
  f.ledger.ackQuestionSend('send-one', 'shown');
  const stats = f.ledger.questionSendMetrics();
  assert.equal(stats.shownAttempts, 1); assert.equal(stats.unattributedAttempts, 1); assert.equal(stats.repeatedQuestions, null);
  assert.equal(f.ledger.snapshot().questionSends[0].sourceEventId, 'not-yet-associated');
});

test('an earlier unassociated request source is not forgotten when the same question is shown in a new period', t => {
  const f = fixture(t); f.ledger.openQuestionMetricEpoch('epoch-one');
  const q = question(f.ledger);
  f.ledger.ingest({ eventId: 'alternate-request', sourceRef: 'task:alternate', kind: 'request',
    payload: { text: 'Rephrased synthetic issue', questionKey: 'issue:one', decisionKind: 'approval' } });
  f.ledger.beginQuestionSend({ attemptId: 'unassociated', sourceEventId: 'alternate-request', channel: 'butler-ask' });
  f.ledger.ackQuestionSend('unassociated', 'shown'); f.ledger.closeQuestionMetricEpoch();
  const afterSequence = f.ledger.snapshot().sequence, next = f.open(); next.openQuestionMetricEpoch('epoch-two');
  shown(next, q, 'associated');
  const stats = next.questionSendMetrics({ afterSequence });
  assert.equal(stats.shownAttempts, 1); assert.equal(stats.uncertainBaselineQuestions, 1); assert.equal(stats.repeatedQuestions, null);
});

test('logical sent and durable decision sources without observed attempts are unknown, not confirmed delivery', t => {
  const f = fixture(t); f.ledger.openQuestionMetricEpoch('epoch-one'); const q = question(f.ledger);
  f.ledger.ackDelivery(q.deliveryId, 'sent');
  const stats = f.ledger.questionSendMetrics();
  assert.equal(stats.shownAttempts, 0); assert.equal(stats.unobservedDecisionSources, 1); assert.equal(stats.unobservedLogicalDeliveries, 1);
  assert.equal(stats.repeatedQuestions, null);
});

test('new facts after an explicit answer create a different question rather than a repeat', t => {
  const f = fixture(t); f.ledger.openQuestionMetricEpoch('epoch-one'); const q = question(f.ledger); shown(f.ledger, q);
  f.ledger.answerQuestion(q.question.questionId, 'Approved', f.person);
  f.ledger.ingest({ eventId: 'changed-facts', sourceRef: 'task:one', kind: 'decision', payload: { text: 'New synthetic facts',
    questionKey: 'issue:one', decisionKind: 'approval', outcome: 'facts-changed', supersedes: q.question.questionId } });
  const next = { ...f.ledger.reserveQuestion({ sourceRef: 'task:one', decisionKind: 'approval', text: 'Decide after new facts?',
    supersedes: q.question.questionId, evidenceRevision: 'changed-facts' }), sourceEventId: 'changed-facts' };
  assert.notEqual(next.question.questionId, q.question.questionId); shown(f.ledger, next, 'send-two');
  assert.equal(f.ledger.questionSendMetrics().shownAttempts, 2); assert.equal(f.ledger.questionSendMetrics().repeatedQuestions, 0);
});

test('unmeasured legacy delivery of an answered version does not poison a new-facts question in a new period', t => {
  const f = fixture(t), old = question(f.ledger); f.ledger.ackDelivery(old.deliveryId, 'sent');
  f.ledger.answerQuestion(old.question.questionId, 'Approved', f.person);
  const epoch = f.ledger.openQuestionMetricEpoch('epoch-one'), afterSequence = epoch.physicalSeq - 1;
  f.ledger.ingest({ eventId: 'changed-facts', sourceRef: 'task:one', kind: 'decision', payload: { text: 'New synthetic facts',
    questionKey: 'issue:one', decisionKind: 'approval', outcome: 'facts-changed', supersedes: old.question.questionId } });
  const next = { ...f.ledger.reserveQuestion({ sourceRef: 'task:one', decisionKind: 'approval', text: 'New decision?',
    supersedes: old.question.questionId, evidenceRevision: 'changed-facts' }), sourceEventId: 'changed-facts' };
  shown(f.ledger, next, 'send-new-version');
  const stats = f.ledger.questionSendMetrics({ afterSequence });
  assert.equal(stats.coverage, 'complete'); assert.equal(stats.shownAttempts, 1); assert.equal(stats.repeatedQuestions, 0);
});

test('new-facts evidence cannot be attributed to the answered old question even when a host supplies that old ID', t => {
  const f = fixture(t); f.ledger.openQuestionMetricEpoch('epoch-one'); const old = question(f.ledger); shown(f.ledger, old);
  f.ledger.answerQuestion(old.question.questionId, 'Approved', f.person);
  f.ledger.ingest({ eventId: 'changed-facts', sourceRef: 'task:one', kind: 'decision', payload: { text: 'New synthetic facts',
    questionKey: 'issue:one', decisionKind: 'approval', outcome: 'facts-changed', supersedes: old.question.questionId } });
  const next = f.ledger.reserveQuestion({ sourceRef: 'task:one', decisionKind: 'approval', text: 'New decision?',
    supersedes: old.question.questionId, evidenceRevision: 'changed-facts' });
  assert.notEqual(next.question.questionId, old.question.questionId);
  const wrong = f.ledger.beginQuestionSend({ attemptId: 'wrong-version', questionId: old.question.questionId,
    deliveryId: old.deliveryId, sourceEventId: 'changed-facts', channel: 'notification' });
  assert.equal(wrong.attributed, false, 'Same issue metadata cannot move new-version evidence back to the old canonical question');
  f.ledger.ackQuestionSend('wrong-version', 'shown');
  const stats = f.ledger.questionSendMetrics();
  assert.equal(stats.shownAttempts, 2); assert.equal(stats.unattributedAttempts, 1);
  assert.equal(stats.knownRepeatedSends, 0); assert.equal(stats.repeatedQuestions, null);
  f.ledger.ingest({ eventId: 'later-new-version-source', sourceRef: 'task:later-version', kind: 'decision',
    payload: { text: 'Later source in the replacement version', questionKey: 'issue:one', decisionKind: 'approval' } });
  assert.equal(f.ledger.beginQuestionSend({ attemptId: 'wrong-later-version', questionId: old.question.questionId,
    deliveryId: old.deliveryId, sourceEventId: 'later-new-version-source', channel: 'notification' }).attributed, false);
});

test('a valid facts change ends attribution to the old version before its replacement question is reserved', t => {
  const f = fixture(t); f.ledger.openQuestionMetricEpoch('epoch-one'); const old = question(f.ledger);
  f.ledger.answerQuestion(old.question.questionId, 'Approved', f.person);
  f.ledger.ingest({ eventId: 'changed-facts', sourceRef: 'task:one', kind: 'decision', payload: { text: 'New synthetic facts',
    questionKey: 'issue:one', decisionKind: 'approval', outcome: 'facts-changed', supersedes: old.question.questionId } });
  assert.equal(f.ledger.snapshot().questions.length, 1);
  const send = f.ledger.beginQuestionSend({ attemptId: 'too-early-for-replacement', questionId: old.question.questionId,
    deliveryId: old.deliveryId, sourceEventId: 'changed-facts', channel: 'notification' });
  assert.equal(send.attributed, false);
});

test('a later decision source for the same still-open question retains the canonical question and counts actual repeats', t => {
  const f = fixture(t); f.ledger.openQuestionMetricEpoch('epoch-one'); const first = question(f.ledger); shown(f.ledger, first);
  f.ledger.ingest({ eventId: 'later-decision', sourceRef: 'task:another-reference', kind: 'decision',
    payload: { text: 'Same open decision, new event', questionKey: 'issue:one', decisionKind: 'approval' } });
  const later = { ...f.ledger.reserveQuestion({ sourceRef: 'task:another-reference', decisionKind: 'approval', text: 'Rephrased question?' }),
    sourceEventId: 'later-decision' };
  assert.equal(later.question.questionId, first.question.questionId);
  assert.equal(shown(f.ledger, later, 'send-two').attributed, true);
  const stats = f.ledger.questionSendMetrics();
  assert.equal(stats.coverage, 'complete'); assert.equal(stats.shownAttempts, 2); assert.equal(stats.repeatedQuestions, 1);
});

test('conflicting failed/shown receipts preserve positive shown evidence and mark coverage incomplete', t => {
  for (const order of [['failed', 'shown'], ['shown', 'failed']]) {
    const f = fixture(t); f.ledger.openQuestionMetricEpoch('epoch-one'); const q = question(f.ledger); intent(f.ledger, q);
    for (const status of order) f.ledger.ackQuestionSend('send-one', status);
    const stats = f.ledger.questionSendMetrics();
    assert.equal(stats.shownAttempts, 1); assert.equal(stats.repeatedQuestions, null);
    assert.equal(f.ledger.snapshot().questionSends[0].status, 'shown');
    assert.equal(f.ledger.snapshot().questionMetricGaps[0].reason, 'delivery-unconfirmed');
  }
});

test('journal physical sequence is distinct from the original event sequence and snapshots contain only data', t => {
  const f = fixture(t); f.ledger.openQuestionMetricEpoch('epoch-one'); const q = question(f.ledger); shown(f.ledger, q);
  const snapshot = f.ledger.snapshot();
  assert.equal(snapshot.events[0].sequence, 1); assert.equal(snapshot.events[0].physicalSeq, 2);
  assert.ok(snapshot.deliveries[0].physicalSeq > snapshot.events[0].physicalSeq);
  assert.equal(Object.hasOwn(snapshot, 'questionSendMetrics'), false);
  assert.deepEqual(f.open().snapshot(), snapshot);
  snapshot.questionSends[0].acknowledgements.length = 0;
  assert.equal(f.ledger.snapshot().questionSends[0].acknowledgements.length, 1);
});

test('metric interfaces reject forged claims, unknown channel, extra text and conflicting attempt reuse', t => {
  const f = fixture(t); f.ledger.openQuestionMetricEpoch('epoch-one'); const q = question(f.ledger); intent(f.ledger, q);
  const bytes = fs.readFileSync(f.file);
  for (const input of [{ attemptId: 'two', channel: 'model' }, { attemptId: 'two', channel: 'notification', text: 'No body in metric records' }])
    assert.throws(() => f.ledger.beginQuestionSend(input));
  assert.throws(() => f.ledger.beginQuestionSend({ attemptId: 'send-one', channel: 'butler-ask' }), { code: 'BUTLER_QUESTION_SEND_STATE' });
  assert.throws(() => f.ledger.questionSendMetrics({ ownedEpoch: 'epoch-one' }));
  assert.throws(() => f.ledger.questionSendMetrics({ throughSequence: f.ledger.snapshot().sequence + 1 }), { code: 'BUTLER_QUESTION_METRIC_WINDOW' });
  assert.throws(() => f.ledger.markQuestionMetricGap('raw operating-system error'));
  assert.deepEqual(fs.readFileSync(f.file), bytes);
});
