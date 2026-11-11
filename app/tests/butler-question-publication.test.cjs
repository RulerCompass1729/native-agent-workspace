'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { ButlerRole } = require('../butler-role.cjs');
const { ButlerLedger } = require('../butler-ledger.cjs');
const { ButlerController } = require('../butler-controller.cjs');

const runner = { runnerRef: 'publication-runner', backendRef: 'publication-backend', purpose: 'butler',
  profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro' };
const selected = role => { const value = role.current(); return { selectionRevision: value.selectionRevision,
  identity: value.identity, runnerRef: value.runner.runnerRef }; };
function fixture(t, { epoch = true, ask } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-question-publication-')); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const person = Symbol('person'), role = new ButlerRole(directory, { authorizePerson: actor => actor === person });
  role.set(person, { identity: { sessionId: 'publication-session', nativeId: 'publication-native' }, runner,
    budget: { limitMicros: 100 } }, 0);
  const records = [{ id: 'publication-session', nativeId: 'publication-native', provider: 'codex', state: 'idle', roomIds: [], runner }];
  const open = () => new ButlerLedger(directory, { authorizePerson: actor => actor === person });
  const ledger = open(), asks = [], blocked = []; let runs = 0;
  if (epoch) ledger.openQuestionMetricEpoch('publication-epoch');
  const make = actualLedger => {
    const controller = new ButlerController({ role, ledger: actualLedger, backend: {}, view: () => ({ records, spaces: [] }),
      run: async () => { runs++; throw Error('Publication must not run a model'); },
      ask: async (question, observer) => {
        asks.push({ question, observer });
        return ask ? ask(question, observer, actualLedger) : { deliveryId: question.deliveryId, status: 'sent' };
      }, onBlocked: notice => blocked.push(notice) });
    t.after(() => controller.close()); return controller;
  };
  return { directory, person, role, ledger, open, make, asks, blocked, get runs() { return runs; }, controller: make(ledger) };
}
function completeQuestion(f, { label = 'one', kind = 'request', extra = {}, action = {} } = {}) {
  const eventId = 'publication-event-' + label, sourceRef = 'publication-task-' + label;
  f.ledger.ingest({ eventId, sourceRef, kind, payload: { text: 'Synthetic decision source',
    questionKey: 'publication-issue-' + label, decisionKind: 'approval', ...extra } });
  const selection = selected(f.role), batch = f.ledger.beginBatch(selection);
  f.ledger.completeBatch(batch.batchId, selection, { actions: [{ kind: 'question', sourceRef,
    decisionKind: 'approval', text: 'Approve this synthetic decision?', ...action }] });
  return f.ledger.snapshot().questions.find(question => question.evidenceRevision === (action.evidenceRevision || eventId));
}

test('ask gets a durable canonical intent before a trusted shown observer ACK; duplicate ACK is idempotent', async t => {
  const f = fixture(t, { ask: async (question, observer, ledger) => {
    const send = ledger.snapshot().questionSends[0];
    assert.equal(typeof observer, 'function'); assert.equal(send.status, 'intent');
    assert.equal(send.questionId, question.questionId); assert.equal(send.deliveryId, question.deliveryId);
    assert.equal(send.sourceEventId, question.evidenceRevision); assert.equal(send.channel, 'butler-ask');
    assert.match(send.attemptId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    observer('shown'); const sequence = ledger.snapshot().sequence; observer('shown');
    assert.equal(ledger.snapshot().sequence, sequence, 'A duplicate physical ACK cannot append another showing');
    return { deliveryId: question.deliveryId, status: 'sent' };
  } });
  completeQuestion(f); await f.controller.flushQuestions();
  const snapshot = f.ledger.snapshot(), metrics = f.ledger.questionSendMetrics();
  assert.equal(snapshot.questionSends.length, 1); assert.equal(snapshot.questionSends[0].status, 'shown');
  assert.equal(snapshot.deliveries[0].status, 'sent'); assert.equal(metrics.shownAttempts, 1);
  assert.equal(metrics.knownRepeatedSends, 0); assert.equal(metrics.repeatedQuestions, 0);
  await f.controller.flushQuestions(); assert.equal(f.asks.length, 1); assert.equal(f.runs, 0);
});

test('a generic sent receipt without a display callback remains unknown; a late real callback can resolve it', async t => {
  const f = fixture(t); completeQuestion(f); await f.controller.flushQuestions();
  let metrics = f.ledger.questionSendMetrics();
  assert.equal(f.ledger.snapshot().deliveries[0].status, 'sent', 'Existing logical receipt compatibility is preserved');
  assert.equal(f.ledger.snapshot().questionSends[0].status, 'unknown');
  assert.equal(metrics.shownAttempts, 0); assert.equal(metrics.unknownAttempts, 1); assert.equal(metrics.repeatedQuestions, null);
  f.asks[0].observer('shown'); metrics = f.ledger.questionSendMetrics();
  assert.equal(metrics.shownAttempts, 1); assert.equal(metrics.unknownAttempts, 0); assert.equal(metrics.repeatedQuestions, 0);
  await f.controller.flushQuestions(); assert.equal(f.asks.length, 1);
});

for (const status of ['failed', 'unknown']) test(`a trusted ${status} display result never becomes shown from its logical receipt`, async t => {
  const f = fixture(t, { ask: async (question, observer) => { observer(status); return { deliveryId: question.deliveryId, status: 'sent' }; } });
  completeQuestion(f); await f.controller.flushQuestions();
  const metrics = f.ledger.questionSendMetrics();
  assert.equal(f.ledger.snapshot().questionSends[0].status, status); assert.equal(metrics.shownAttempts, 0);
  assert.equal(metrics.repeatedQuestions, status === 'failed' ? 0 : null);
});

test('an ask exception stays unknown and never becomes an automatic publication retry', async t => {
  const f = fixture(t, { ask: async () => { throw Error('Synthetic publication failure'); } });
  completeQuestion(f); await f.controller.flushQuestions(); await f.controller.flushQuestions();
  assert.equal(f.asks.length, 1); assert.equal(f.ledger.snapshot().deliveries[0].status, 'unknown');
  assert.equal(f.ledger.snapshot().questionSends[0].status, 'unknown'); assert.equal(f.ledger.questionSendMetrics().repeatedQuestions, null);
});

test('a real shown ACK survives a later transport exception while its logical delivery stays unknown', async t => {
  const f = fixture(t, { ask: async (_question, observer) => { observer('shown'); throw Error('Synthetic failure after display'); } });
  completeQuestion(f); await f.controller.flushQuestions();
  assert.equal(f.ledger.snapshot().deliveries[0].status, 'unknown');
  assert.equal(f.ledger.snapshot().questionSends[0].status, 'shown');
  assert.equal(f.ledger.questionSendMetrics().shownAttempts, 1); assert.equal(f.ledger.questionSendMetrics().repeatedQuestions, 0);
  await f.controller.flushQuestions(); assert.equal(f.asks.length, 1);
});

test('an ACK persistence failure leaves unknown coverage and cannot fabricate a shown receipt', async t => {
  const f = fixture(t, { ask: async (question, observer, ledger) => {
    const ack = ledger.ackQuestionSend.bind(ledger);
    ledger.ackQuestionSend = () => { const error = Error('Synthetic ACK write failure'); error.code = 'BUTLER_LEDGER_WRITE'; throw error; };
    assert.equal(observer('shown'), false); ledger.ackQuestionSend = ack;
    return { deliveryId: question.deliveryId, status: 'sent' };
  } });
  completeQuestion(f); await f.controller.flushQuestions();
  const metrics = f.ledger.questionSendMetrics();
  assert.equal(metrics.shownAttempts, 0); assert.equal(metrics.unknownAttempts, 1); assert.equal(metrics.repeatedQuestions, null);
  assert.ok(f.ledger.snapshot().questionMetricGaps.some(gap => gap.reason === 'write-failed'));
  assert.ok(f.blocked.some(notice => notice.reason === 'question-metric-unavailable'));
});

test('a status object or other unsupported display claim cannot be accepted as a trusted shown ACK', async t => {
  const f = fixture(t, { ask: async (question, observer) => {
    assert.equal(observer({ status: 'shown' }), false);
    return { deliveryId: question.deliveryId, status: 'sent', shown: true };
  } });
  completeQuestion(f); await f.controller.flushQuestions();
  assert.equal(f.ledger.snapshot().questionSends[0].status, 'unknown');
  assert.equal(f.ledger.questionSendMetrics().shownAttempts, 0); assert.equal(f.ledger.questionSendMetrics().repeatedQuestions, null);
  assert.ok(f.ledger.snapshot().questionMetricGaps.some(gap => gap.reason === 'unexpected-display'));
});

test('a crash after a durable physical intent cannot be adopted or resent after restart', async t => {
  const f = fixture(t), question = completeQuestion(f), delivery = f.ledger.reserveStoredQuestion(question.questionId);
  f.ledger.beginQuestionSend({ attemptId: 'crashed-publication-intent', questionId: question.questionId,
    deliveryId: delivery.deliveryId, sourceEventId: question.evidenceRevision, channel: 'butler-ask' });
  await f.controller.close();
  const ledger = f.open(); ledger.openQuestionMetricEpoch('after-publication-crash');
  const restored = f.make(ledger); await restored.resume(); await restored.flushQuestions();
  assert.equal(f.asks.length, 0); assert.equal(f.runs, 0); assert.equal(ledger.snapshot().questionSends.length, 1);
  assert.equal(ledger.snapshot().deliveries[0].status, 'unknown');
  assert.equal(ledger.questionSendMetrics().unknownAttempts, 1); assert.equal(ledger.questionSendMetrics().repeatedQuestions, null);
});

test('a B1 notification and a butler ask that actually show the same question count as two physical sends', async t => {
  const f = fixture(t, { ask: async (question, observer) => { observer('shown'); return { deliveryId: question.deliveryId, status: 'sent' }; } });
  const question = completeQuestion(f, { kind: 'decision' });
  f.ledger.beginQuestionSend({ attemptId: 'b1-notification-attempt', questionId: question.questionId,
    sourceEventId: question.evidenceRevision, channel: 'notification' });
  f.ledger.ackQuestionSend('b1-notification-attempt', 'shown');
  await f.controller.flushQuestions(); const metrics = f.ledger.questionSendMetrics();
  assert.equal(metrics.shownAttempts, 2); assert.equal(metrics.knownRepeatedSends, 1); assert.equal(metrics.repeatedQuestions, 1);
  assert.deepEqual(f.ledger.snapshot().questionSends.map(send => send.channel), ['notification', 'butler-ask']);
});

test('a new facts version after an answer has its own canonical source and is not an old-question repeat', async t => {
  const f = fixture(t, { ask: async (question, observer) => { observer('shown'); return { deliveryId: question.deliveryId, status: 'sent' }; } });
  const original = completeQuestion(f); await f.controller.flushQuestions();
  f.ledger.answerQuestion(original.questionId, 'Approved', f.person);
  const next = completeQuestion(f, { label: 'two', kind: 'decision', extra: { questionKey: original.decisionSource,
    outcome: 'facts-changed', supersedes: original.questionId }, action: { evidenceRevision: 'publication-event-two', supersedes: original.questionId } });
  await f.controller.flushQuestions();
  assert.notEqual(next.questionId, original.questionId); assert.equal(f.asks.length, 2);
  assert.deepEqual(f.ledger.snapshot().questionSends.map(send => send.sourceEventId), ['publication-event-one', 'publication-event-two']);
  const metrics = f.ledger.questionSendMetrics();
  assert.equal(metrics.shownAttempts, 2); assert.equal(metrics.repeatedQuestions, 0);
});

test('failure to persist intent stops the ask and records a metric gap rather than fabricating zero sends', async t => {
  const f = fixture(t); completeQuestion(f);
  f.ledger.beginQuestionSend = () => { const error = Error('Synthetic intent persistence failure'); error.code = 'BUTLER_LEDGER_WRITE'; throw error; };
  await f.controller.flushQuestions();
  assert.equal(f.asks.length, 0); assert.equal(f.ledger.snapshot().questionSends.length, 0);
  assert.ok(f.ledger.snapshot().questionMetricGaps.some(gap => gap.reason === 'write-failed'));
  assert.equal(f.ledger.questionSendMetrics().repeatedQuestions, null);
  assert.ok(f.blocked.some(notice => notice.reason === 'question-metric-unavailable'));
});

test('without a host-owned metric epoch the controller cannot send or certify a question', async t => {
  const f = fixture(t, { epoch: false }); completeQuestion(f); await f.controller.flushQuestions();
  assert.equal(f.asks.length, 0); assert.equal(f.ledger.snapshot().questionSends.length, 0);
  assert.equal(f.ledger.snapshot().questionMetricEpochs.length, 0, 'The controller must not create or adopt the host epoch');
  assert.equal(f.ledger.questionSendMetrics().coverage, 'unavailable'); assert.equal(f.ledger.questionSendMetrics().repeatedQuestions, null);
  assert.ok(f.blocked.some(notice => notice.reason === 'question-metric-unavailable'));
});
