const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ButlerLedger } = require('../butler-ledger.cjs');

const selection = { selectionRevision: 1, identity: { sessionId: 'butler-1', nativeId: 'native-1' }, runnerRef: 'runner-deepseek' };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-ledger-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let serial = 0, now = 100; const person = Symbol('verified-person');
  const open = (options = {}) => new ButlerLedger(directory, { now: () => now++, id: () => 'local-' + ++serial, authorizePerson: token => token === person, ...options });
  return { directory, person, file: path.join(directory, 'butler-ledger.jsonl'), open, ledger: open() };
}
function event(eventId = 'event-1', sourceRef = 'task:one', payload = { text: 'Synthetic request' }, kind = 'request') {
  return { eventId, sourceRef, payload, kind };
}
function decisionEvent(eventId = 'event-1', sourceRef = 'task:one', payload = {}, kind = 'request') {
  return event(eventId, sourceRef, { text: 'Synthetic request', questionKey: 'decision:release', decisionKind: 'approval', ...payload }, kind);
}
function question(overrides = {}) {
  return { sourceRef: 'task:one', decisionKind: 'approval', text: 'Should this synthetic task proceed?', ...overrides };
}
function lines(file) { return fs.readFileSync(file, 'utf8').trimEnd().split('\n'); }

test('no work creates no batch; event replay is stable and changed event identity is refused', t => {
  const f = fixture(t), ledger = f.ledger;
  assert.equal(ledger.beginBatch(selection), null);
  assert.equal(fs.existsSync(f.file), false);
  const first = ledger.ingest(event()); const size = fs.statSync(f.file).size;
  assert.deepEqual(ledger.ingest(event()), first);
  assert.equal(fs.statSync(f.file).size, size, 'A replay does not append another event');
  assert.throws(() => ledger.ingest(event('event-1', 'task:one', { text: 'Different content under the old event id' })), { code: 'BUTLER_EVENT_CONFLICT' });
  assert.equal(ledger.pendingEvents().length, 1);
  assert.equal(fs.statSync(f.file).mode & 0o7777, 0o600);
});

test('event payload is a bounded business projection; extra environment/history fields cannot be persisted', t => {
  const { ledger, file } = fixture(t);
  for (const payload of [{ text: 'A task', env: {} }, { nativeHistory: [] }, { text: 'A task', arbitrary: 'extra' }, { reason: { raw: 'object' } }])
    assert.throws(() => ledger.ingest(event('rejected', 'task:one', payload)));
  assert.throws(() => ledger.ingest({ ...event(), credentials: 'synthetic-placeholder' }));
  assert.throws(() => ledger.ingest(event('secret-shape', 'task:one', { text: 'Authorization: Bearer synthetic-not-a-credential' })));
  assert.throws(() => ledger.ingest(event('too-long', 'task:one', { text: 'x'.repeat(12001) })));
  assert.deepEqual(ledger.pendingEvents(), []);
  assert.equal(ledger.snapshot().sequence, 0);
  assert.equal(fs.existsSync(file), false, 'Rejected business inputs never create a journal');
});

test('a queue-empty source records one atomic episode across repeated observations and restart', t => {
  const f = fixture(t), source = 'queue-empty:space-one', payload = { spaceId: 'space-one', spaceName: 'Synthetic team' };
  assert.deepEqual(f.ledger.observeSource(source, false, payload), { changed: true, event: null });
  assert.deepEqual(f.ledger.snapshot().sourceStates, [{ sourceRef: source, active: false, generation: 0 }]);
  assert.deepEqual(f.ledger.pendingEvents(), []);
  assert.equal(lines(f.file).length, 1);
  assert.deepEqual(f.ledger.observeSource(source, false, payload), { changed: false, event: null });
  const first = f.ledger.observeSource(source, true, payload), saved = f.ledger.snapshot();
  assert.equal(first.changed, true); assert.equal(first.event.kind, 'queue-empty');
  assert.equal(first.event.sourceRef, source); assert.deepEqual(first.event.payload, payload);
  assert.equal(first.event.sequence, 1); assert.equal(lines(f.file).length, 2);
  assert.deepEqual(saved.sourceStates, [{ sourceRef: source, active: true, generation: 1, eventId: first.event.eventId }]);
  const row = JSON.parse(lines(f.file)[1]);
  assert.equal(row.type, 'source-transition'); assert.equal(row.data.event.eventId, first.event.eventId);
  const restored = f.open(), bytes = fs.readFileSync(f.file);
  assert.deepEqual(restored.observeSource(source, true, { ...payload, spaceName: 'Renamed team' }), { changed: false, event: first.event });
  assert.deepEqual(restored.snapshot(), saved); assert.deepEqual(fs.readFileSync(f.file), bytes);
  first.event.payload.spaceName = 'Changed returned copy';
  assert.equal(restored.pendingEvents()[0].payload.spaceName, payload.spaceName);
});

test('a later queue-empty edge gets a new stable generation without depending on time or random IDs', t => {
  const f = fixture(t), source = 'queue-empty:space-one', payload = { spaceId: 'space-one' };
  const first = f.ledger.observeSource(source, true, payload).event;
  assert.equal(f.ledger.observeSource(source, false, payload).event, null);
  const restored = f.open(), second = restored.observeSource(source, true, payload).event;
  assert.notEqual(first.eventId, second.eventId); assert.equal(second.sequence, 2);
  assert.equal(restored.snapshot().sourceStates[0].generation, 2);
  const other = fixture(t), matching = other.ledger.observeSource(source, true, payload).event;
  assert.equal(matching.eventId, first.eventId, 'The stable source and episode determine its identity');
  assert.equal(f.open().observeSource(source, true, payload).event.eventId, second.eventId);
  assert.deepEqual(f.open().pendingEvents().map(e => e.eventId), [first.eventId, second.eventId]);
});

test('source episodes are independent and a conflicting event ID cannot consume a source edge', t => {
  const f = fixture(t), one = 'queue-empty:space-one', two = 'queue-empty:space-two';
  const first = f.ledger.observeSource(one, true).event, second = f.ledger.observeSource(two, true).event;
  assert.notEqual(first.eventId, second.eventId);
  assert.deepEqual(f.ledger.snapshot().sourceStates.map(s => [s.sourceRef, s.generation]), [[one, 1], [two, 1]]);
  const collision = fixture(t);
  collision.ledger.ingest(event(first.eventId, 'unrelated-host-source'));
  const before = fs.readFileSync(collision.file), sequence = collision.ledger.snapshot().sequence;
  assert.throws(() => collision.ledger.observeSource(one, true));
  assert.equal(collision.ledger.snapshot().sequence, sequence);
  assert.deepEqual(collision.ledger.snapshot().sourceStates, []); assert.deepEqual(fs.readFileSync(collision.file), before);
});

test('invalid queue-empty source observations never append or create state', t => {
  const f = fixture(t), source = 'queue-empty:space-one';
  for (const active of [undefined, null, 0, 1, 'true', {}, []]) assert.throws(() => f.ledger.observeSource(source, active));
  for (const ref of ['', 'x'.repeat(601), 'Authorization: Bearer synthetic-placeholder'])
    assert.throws(() => f.ledger.observeSource(ref, false));
  for (const active of [false, true]) for (const payload of [null, [], { env: {} }, { text: 'x'.repeat(12001) }, { text: 'Authorization: Bearer synthetic-placeholder' }])
    assert.throws(() => f.ledger.observeSource(source, active, payload));
  assert.equal(f.ledger.snapshot().sequence, 0); assert.deepEqual(f.ledger.snapshot().sourceStates, []);
  assert.deepEqual(f.ledger.pendingEvents(), []); assert.equal(fs.existsSync(f.file), false);
  f.ledger.observeSource(source, true);
  const before = fs.readFileSync(f.file);
  assert.throws(() => f.ledger.observeSource(source, true, { history: [] }));
  assert.deepEqual(fs.readFileSync(f.file), before, 'A repeated boolean does not skip input validation');
});

test('source-transition replay refuses changed generations, identities and unsupported event kinds', t => {
  for (const mutate of [
    row => { row.data.generation = 2; },
    row => { row.data.active = 'true'; },
    row => { row.data.event.kind = 'request'; },
    row => { row.data.event.eventId = 'invented-event'; },
    row => { row.data.event.sourceRef = 'queue-empty:another-space'; },
    row => { delete row.data.event; },
    row => { row.data.authority = true; },
  ]) {
    const f = fixture(t); f.ledger.observeSource('queue-empty:space-one', true, { spaceId: 'space-one' });
    const row = JSON.parse(lines(f.file)[0]); mutate(row); fs.writeFileSync(f.file, JSON.stringify(row) + '\n');
    const before = fs.readFileSync(f.file); assert.throws(() => f.open());
    assert.deepEqual(fs.readFileSync(f.file), before, 'Replay retains malformed source evidence');
  }
  const inactive = fixture(t); inactive.ledger.observeSource('queue-empty:space-one', false);
  const row = JSON.parse(lines(inactive.file)[0]); row.data.event = event();
  fs.writeFileSync(inactive.file, JSON.stringify(row) + '\n'); assert.throws(() => inactive.open());
});

test('a refused source-transition write cannot acknowledge its edge or advance the stored episode', t => {
  const f = fixture(t), source = 'queue-empty:space-one'; f.ledger.observeSource(source, false);
  const before = fs.readFileSync(f.file);
  t.mock.method(fs, 'writeSync', () => { throw Object.assign(Error('Synthetic write refusal'), { code: 'EIO' }); });
  assert.throws(() => f.ledger.observeSource(source, true), { code: 'BUTLER_LEDGER_WRITE' });
  t.mock.restoreAll(); assert.throws(() => f.ledger.snapshot(), { code: 'BUTLER_LEDGER_FAILED' });
  assert.deepEqual(fs.readFileSync(f.file), before);
  const restored = f.open(); assert.deepEqual(restored.snapshot().sourceStates, [{ sourceRef: source, active: false, generation: 0 }]);
  assert.deepEqual(restored.pendingEvents(), []);
  assert.equal(restored.observeSource(source, true).event.sequence, 1);
});

test('an uncertain fsync after a whole source row recovers both edge and event without repeating either', t => {
  const f = fixture(t), source = 'queue-empty:space-one'; f.ledger.observeSource(source, false);
  const original = fs.fsyncSync;
  t.mock.method(fs, 'fsyncSync', fd => { original(fd); throw Object.assign(Error('Synthetic acknowledgement loss'), { code: 'EIO' }); });
  assert.throws(() => f.ledger.observeSource(source, true, { spaceId: 'space-one' }), { code: 'BUTLER_LEDGER_WRITE' });
  t.mock.restoreAll(); const restored = f.open(), before = fs.readFileSync(f.file);
  const result = restored.observeSource(source, true, { spaceId: 'space-one' });
  assert.equal(result.changed, false); assert.equal(result.event.sequence, 1);
  assert.equal(restored.snapshot().sourceStates[0].eventId, result.event.eventId);
  assert.deepEqual(fs.readFileSync(f.file), before); assert.equal(restored.pendingEvents().length, 1);
});

test('one active batch survives a restart and completion consumes its prefix in one durable record', t => {
  const f = fixture(t);
  f.ledger.ingest(event()); f.ledger.ingest(event('event-2', 'task:two'));
  const batch = f.ledger.beginBatch(selection, 1);
  assert.deepEqual(batch.eventIds, ['event-1']);
  assert.equal(f.ledger.beginBatch(selection, 2).batchId, batch.batchId);
  const restored = f.open();
  assert.equal(restored.snapshot().activeBatch.batchId, batch.batchId);
  const before = lines(f.file).length;
  const completed = restored.completeBatch(batch.batchId, selection, { actions: [
    { kind: 'queue', sourceRef: 'task:one', spaceId: 'space-one', text: 'Proposed queue entry' },
    { kind: 'archive', sourceRef: 'task:one', text: 'Proposed archive only' }
  ], usage: { inputTokens: 10, cachedInputTokens: null, outputTokens: 3, costMicros: null } });
  assert.equal(lines(f.file).length, before + 1, 'Suggestions and consumption commit together');
  assert.ok(completed.actions.every(action => action.effect === 'none'));
  assert.deepEqual(completed.result.usage, { inputTokens: 10, cachedInputTokens: null, outputTokens: 3, costMicros: null });
  assert.equal(restored.snapshot().cursors.processed, 1);
  assert.equal(restored.snapshot().cursors.reported, 0);
  assert.deepEqual(restored.pendingEvents().map(row => row.eventId), ['event-2']);
  assert.equal(f.open().snapshot().cursors.processed, 1);
  const sequence = restored.snapshot().sequence;
  assert.deepEqual(restored.completeBatch(batch.batchId, selection, completed.result), completed);
  assert.equal(restored.snapshot().sequence, sequence);
});

test('old revision, native identity and runner cannot complete another selection batch', t => {
  const f = fixture(t); f.ledger.ingest(event());
  const batch = f.ledger.beginBatch(selection);
  const wrong = [
    { ...selection, selectionRevision: 2 },
    { ...selection, identity: { ...selection.identity, nativeId: 'another-native' } },
    { ...selection, runnerRef: 'ordinary-codex' }
  ];
  for (const actor of wrong) {
    assert.throws(() => f.ledger.completeBatch(batch.batchId, actor, { actions: [] }), { code: 'BUTLER_BATCH_SELECTION' });
    assert.throws(() => f.ledger.beginBatch(actor), { code: 'BUTLER_BATCH_SELECTION' });
  }
  assert.equal(f.open().snapshot().cursors.processed, 0);
  assert.equal(f.ledger.pendingEvents().length, 1);
});

test('actions cannot smuggle executable effects, assignees or an unknown kind into a completion', t => {
  const f = fixture(t); f.ledger.ingest(event()); const batch = f.ledger.beginBatch(selection);
  for (const action of [
    { kind: 'queue', sourceRef: 'task:one', text: 'A task', effect: 'execute' },
    { kind: 'queue', sourceRef: 'task:one', text: 'A task', assignee: 'chosen-agent' },
    { kind: 'shell', sourceRef: 'task:one', text: 'not an allowed action' }
  ]) assert.throws(() => f.ledger.completeBatch(batch.batchId, selection, { actions: [action] }));
  assert.equal(f.ledger.snapshot().cursors.processed, 0);
  assert.deepEqual(f.ledger.snapshot().actions, []);
});

test('a failed batch requires explicit retry with the same batch identity and preserves events', t => {
  const f = fixture(t); f.ledger.ingest(event()); const batch = f.ledger.beginBatch(selection);
  f.ledger.failBatch(batch.batchId, 'offline');
  const restored = f.open();
  assert.throws(() => restored.beginBatch(selection), { code: 'BUTLER_BATCH_RETRY_REQUIRED' });
  assert.equal(restored.snapshot().cursors.processed, 0);
  const retry = restored.retryBatch(batch.batchId, selection);
  assert.equal(retry.batchId, batch.batchId); assert.equal(retry.attempt, 2);
  restored.completeBatch(batch.batchId, selection, { actions: [] });
  assert.equal(restored.pendingEvents().length, 0);
});

test('an authenticated replacement rebinds only a failed batch; an old response cannot commit it', t => {
  const f = fixture(t); f.ledger.ingest(event()); const batch = f.ledger.beginBatch(selection);
  const next = { ...selection, identity: { sessionId: 'butler-2', nativeId: 'native-2' } };
  assert.throws(() => f.ledger.rebindBatch(batch.batchId, selection, next), { code: 'BUTLER_BATCH_SELECTION' });
  f.ledger.failBatch(batch.batchId, 'rotation');
  assert.throws(() => f.ledger.retryBatch(batch.batchId, next), { code: 'BUTLER_BATCH_SELECTION' });
  assert.throws(() => f.ledger.rebindBatch(batch.batchId, { ...selection, runnerRef: 'wrong-runner' }, next), { code: 'BUTLER_BATCH_SELECTION' });
  const rebound = f.ledger.rebindBatch(batch.batchId, selection, next);
  assert.equal(rebound.batchId, batch.batchId); assert.equal(rebound.status, 'failed');
  assert.equal(f.ledger.snapshot().cursors.processed, 0);
  const restored = f.open(); restored.retryBatch(batch.batchId, next);
  assert.throws(() => restored.completeBatch(batch.batchId, selection, { actions: [] }), { code: 'BUTLER_BATCH_SELECTION' });
  restored.completeBatch(batch.batchId, next, { actions: [] });
  assert.equal(restored.snapshot().cursors.processed, 1);
});

test('each native attempt durably starts unknown and failed attempt usage remains separately reconcilable', t => {
  const f = fixture(t); f.ledger.ingest(event()); const batch = f.ledger.beginBatch(selection);
  const first = f.ledger.beginAttempt(batch.batchId, selection);
  assert.equal(first.attempt, 1); assert.equal(first.usage, null);
  const sequence = f.ledger.snapshot().sequence;
  assert.deepEqual(f.ledger.beginAttempt(batch.batchId, selection), first);
  assert.equal(f.ledger.snapshot().sequence, sequence, 'Repeated native-attempt preparation is not a second attempt');
  f.ledger.failBatch(batch.batchId, 'parse-failed-after-native-turn');
  const restored = f.open();
  assert.equal(restored.snapshot().attempts[0].usage, null, 'A crash or failure never turns unknown billing into zero');
  restored.retryBatch(batch.batchId, selection);
  restored.beginAttempt(batch.batchId, selection);
  assert.deepEqual(restored.snapshot().attempts.map(row => [row.attempt, row.usage]), [[1, null], [2, null]]);
  const old = restored.recordAttemptUsage(batch.batchId, selection, { inputTokens: 17, costMicros: 42 }, 1);
  assert.equal(old.usage.costMicros, 42);
  assert.equal(restored.snapshot().attempts[1].usage, null, 'An old callback cannot confirm a newer attempt');
  assert.throws(() => restored.recordAttemptUsage(batch.batchId, selection, { costMicros: 43 }, 1), { code: 'BUTLER_USAGE_CONFLICT' });
  assert.throws(() => restored.recordAttemptUsage(batch.batchId, selection, { costMicros: null }, 1), { code: 'BUTLER_USAGE_CONFLICT' });
  assert.throws(() => restored.recordAttemptUsage(batch.batchId, selection, null, 1), { code: 'BUTLER_USAGE_CONFLICT' });
  assert.throws(() => restored.recordAttemptUsage(batch.batchId, selection, { costMicros: 1 }), { code: 'BUTLER_USAGE_ATTEMPT' });
  assert.throws(() => restored.recordAttemptUsage(batch.batchId, selection, { costMicros: 1 }, 3), { code: 'BUTLER_BATCH_SELECTION' });
  restored.recordAttemptUsage(batch.batchId, selection, { costMicros: 51 }, 2);
  assert.deepEqual(f.open().snapshot().attempts.map(row => row.usage.costMicros), [42, 51]);
  assert.equal(restored.snapshot().cursors.processed, 0, 'Billing confirmation is not business completion');
  assert.equal(restored.pendingEvents().length, 1);
});

test('a rebind preserves metering ownership of the old attempt without letting it meter the new one', t => {
  const f = fixture(t); f.ledger.ingest(event()); const batch = f.ledger.beginBatch(selection);
  const next = { ...selection, selectionRevision: 2, identity: { sessionId: 'butler-next', nativeId: 'native-next' } };
  f.ledger.beginAttempt(batch.batchId, selection); f.ledger.failBatch(batch.batchId, 'rotation');
  f.ledger.rebindBatch(batch.batchId, selection, next); f.ledger.retryBatch(batch.batchId, next); f.ledger.beginAttempt(batch.batchId, next);
  f.ledger.recordAttemptUsage(batch.batchId, selection, { costMicros: 7 }, 1);
  assert.throws(() => f.ledger.recordAttemptUsage(batch.batchId, selection, { costMicros: 8 }, 2), { code: 'BUTLER_BATCH_SELECTION' });
  assert.throws(() => f.ledger.recordAttemptUsage(batch.batchId, next, { costMicros: 7 }, 1), { code: 'BUTLER_BATCH_SELECTION' });
  assert.throws(() => f.ledger.beginAttempt(batch.batchId, selection), { code: 'BUTLER_BATCH_SELECTION' });
  const state = f.open().snapshot();
  assert.equal(state.attempts[0].usage.costMicros, 7); assert.equal(state.attempts[1].usage, null);
  assert.equal(state.activeBatch.attempt, 2); assert.equal(state.cursors.processed, 0);
});

test('quarantine preserves failed work and unknown billing while allowing a later event to progress', t => {
  const f = fixture(t); f.ledger.ingest(event()); const batch = f.ledger.beginBatch(selection);
  f.ledger.beginAttempt(batch.batchId, selection); f.ledger.failBatch(batch.batchId, 'invalid-model-candidate');
  const wrong = { ...selection, runnerRef: 'wrong-runner' };
  assert.throws(() => f.ledger.quarantineBatch(batch.batchId, wrong, 'invalid-candidate'), { code: 'BUTLER_BATCH_SELECTION' });
  const held = f.ledger.quarantineBatch(batch.batchId, selection, 'invalid-candidate');
  assert.deepEqual(held.eventIds, ['event-1']); assert.deepEqual(held.sourceRefs, ['task:one']);
  const sequence = f.ledger.snapshot().sequence;
  assert.deepEqual(f.ledger.quarantineBatch(batch.batchId, selection, 'invalid-candidate'), held);
  assert.equal(f.ledger.snapshot().sequence, sequence);
  f.ledger.ingest(event('event-2', 'task:two'));
  const restored = f.open(), state = restored.snapshot();
  assert.equal(state.events.length, 2); assert.equal(state.activeBatch, null);
  assert.equal(state.batches[0].failure, 'invalid-model-candidate'); assert.equal(state.batches[0].status, 'quarantined');
  assert.equal(state.attempts[0].usage, null); assert.deepEqual(state.cursors, { processed: 0, reported: 0 });
  assert.deepEqual(restored.pendingEvents().map(row => row.eventId), ['event-2']);
  assert.deepEqual(restored.beginBatch(selection).eventIds, ['event-2']);
  restored.recordAttemptUsage(batch.batchId, selection, { costMicros: 19 }, 1);
  assert.equal(restored.snapshot().attempts[0].usage.costMicros, 19, 'Quarantine retains a host reconciliation path');
  assert.throws(() => restored.completeBatch(batch.batchId, selection, { actions: [] }), { code: 'BUTLER_BATCH_STATE' });
});

test('running work may be quarantined, but completed work and rule consumption cannot undo quarantine', t => {
  const f = fixture(t); f.ledger.ingest(event('blocked', 'issue:blocked', { reason: 'invalid-input' }, 'blocked'));
  const batch = f.ledger.beginBatch(selection); f.ledger.quarantineBatch(batch.batchId, selection, 'invalid-input');
  assert.throws(() => f.ledger.consumeRecorded(['blocked']), { code: 'BUTLER_EVENT_QUARANTINED' });
  assert.throws(() => f.ledger.retryBatch(batch.batchId, selection), { code: 'BUTLER_BATCH_STATE' });
  f.ledger.ingest(event('new-request', 'task:new')); const next = f.ledger.beginBatch(selection);
  f.ledger.completeBatch(next.batchId, selection, { actions: [] });
  assert.throws(() => f.ledger.quarantineBatch(next.batchId, selection, 'late-change'), { code: 'BUTLER_BATCH_STATE' });
  assert.equal(f.ledger.snapshot().quarantined.length, 1); assert.equal(f.ledger.snapshot().cursors.processed, 0);
});

test('open question wording or a model-invented revision cannot cause a second notification after restart', t => {
  const f = fixture(t); f.ledger.ingest(decisionEvent());
  const first = f.ledger.reserveQuestion(question()); assert.equal(first.shouldNotify, true);
  const beforeAck = f.open(), recordCount = lines(f.file).length;
  const reservedAgain = beforeAck.reserveQuestion(question({ text: 'Retry after a crash before the receipt' }));
  assert.equal(reservedAgain.shouldNotify, false);
  assert.equal(reservedAgain.deliveryId, first.deliveryId);
  assert.equal(lines(f.file).length, recordCount, 'The durable reservation prevents replay before any receipt exists');
  assert.throws(() => beforeAck.reserveQuestion({ ...question(), kind: 'question' }), { code: 'BUTLER_LEDGER_INVALID' });
  f.ledger.ackDelivery(first.deliveryId, 'unknown');
  const restored = f.open();
  const duplicate = restored.reserveQuestion(question({ text: 'Different wording for the same decision', evidenceRevision: 'invented-by-model' }));
  assert.equal(duplicate.shouldNotify, false); assert.equal(duplicate.question.questionId, first.question.questionId);
  assert.equal(duplicate.deliveryId, first.deliveryId);
  assert.equal(restored.snapshot().questions.length, 1);
  assert.equal(restored.snapshot().deliveries[0].status, 'unknown');
  assert.equal(restored.snapshot().questions[0].text, first.question.text);
});

test('host decision metadata fixes the vocabulary and deduplicates alternate event sources', t => {
  const f = fixture(t); f.ledger.ingest(decisionEvent());
  const first = f.ledger.reserveQuestion(question());
  assert.throws(() => f.ledger.reserveQuestion(question({ decisionKind: 'renamed-by-model' })), { code: 'BUTLER_QUESTION_SOURCE' });
  f.ledger.ingest(decisionEvent('event-other-ref', 'task:another-reference'));
  const duplicate = f.ledger.reserveQuestion(question({ sourceRef: 'task:another-reference', text: 'The same issue through another event' }));
  assert.equal(duplicate.shouldNotify, false); assert.equal(duplicate.question.questionId, first.question.questionId);
  assert.equal(duplicate.question.sourceRef, 'task:one');
  assert.equal(duplicate.question.decisionSource, 'decision:release');
  f.ledger.ingest(event('no-vocabulary', 'task:untagged'));
  assert.throws(() => f.ledger.reserveQuestion(question({ sourceRef: 'task:untagged' })), { code: 'BUTLER_QUESTION_SOURCE' });
  assert.equal(f.ledger.snapshot().questions.length, 1);
});

test('a previously reserved question never resends when its task later has different decision metadata', t => {
  for (const status of ['reserved', 'sent', 'unknown']) {
    const f = fixture(t); f.ledger.ingest(decisionEvent());
    const first = f.ledger.reserveQuestion(question());
    if (status !== 'reserved') f.ledger.ackDelivery(first.deliveryId, status);
    f.ledger.ingest(decisionEvent('second-decision', 'task:one', { questionKey: 'decision:new-owner', decisionKind: 'ownership' }));
    // Another host decision type does not change this question's identity.
    assert.equal(f.ledger.reserveQuestion(question()).question.questionId, first.question.questionId);
    f.ledger.ingest(decisionEvent('another-approval', 'task:one', { questionKey: 'decision:another-release' }));
    assert.throws(() => f.ledger.reserveQuestion(question()), { code: 'BUTLER_QUESTION_SOURCE' });
    const restored = f.open(), sequence = restored.snapshot().sequence;
    const duplicate = restored.reserveStoredQuestion(first.question.questionId);
    assert.equal(duplicate.shouldNotify, false); assert.equal(duplicate.deliveryId, first.deliveryId);
    assert.deepEqual(duplicate.question, first.question);
    assert.equal(restored.snapshot().sequence, sequence, 'An existing delivery remains the single durable delivery attempt');
    assert.equal(restored.snapshot().deliveries[0].status, status);
    assert.deepEqual(f.open().reserveStoredQuestion(first.question.questionId), duplicate);
  }
});

test('distinct host decision types on one task each open once without changing the earlier question', t => {
  const f = fixture(t); f.ledger.ingest(decisionEvent());
  const first = f.ledger.reserveQuestion(question());
  f.ledger.ingest(decisionEvent('owner-decision', 'task:one', { questionKey: 'decision:owner', decisionKind: 'ownership' }));
  const ownerInput = question({ decisionKind: 'ownership', text: 'Which group owns this synthetic task?' });
  const second = f.ledger.reserveQuestion(ownerInput);
  assert.equal(second.shouldNotify, true); assert.notEqual(second.question.questionId, first.question.questionId);
  assert.equal(second.question.decisionSource, 'decision:owner'); assert.equal(second.question.decisionKind, 'ownership');
  assert.deepEqual(f.ledger.snapshot().questions[0], first.question);
  assert.equal(f.ledger.reserveQuestion(question()).shouldNotify, false);
  assert.equal(f.ledger.reserveQuestion(ownerInput).shouldNotify, false);
  assert.equal(f.open().snapshot().questions.length, 2);
  assert.throws(() => f.ledger.reserveQuestion(question({ decisionKind: 'invented-kind' })), { code: 'BUTLER_QUESTION_SOURCE' });
  f.ledger.ingest(decisionEvent('other-owner-decision', 'task:one', { questionKey: 'decision:other-owner', decisionKind: 'ownership' }));
  assert.throws(() => f.ledger.reserveQuestion(ownerInput), { code: 'BUTLER_QUESTION_SOURCE' }, 'Distinct host keys of one type need an exact event reference');
  const exact = f.ledger.reserveQuestion({ ...ownerInput, sourceRef: 'owner-decision' });
  assert.equal(exact.shouldNotify, false); assert.equal(exact.question.questionId, second.question.questionId);
  assert.deepEqual(f.open().snapshot().questions[0], first.question);
});

test('an undelivered stored question remains deliverable after another decision on the same task and after restart', t => {
  const f = fixture(t); f.ledger.ingest(decisionEvent());
  const batch = f.ledger.beginBatch(selection);
  f.ledger.completeBatch(batch.batchId, selection, { actions: [{ kind: 'question', ...question() }] });
  const [stored] = f.ledger.snapshot().questions;
  assert.deepEqual(f.ledger.snapshot().deliveries, []);
  f.ledger.ingest(decisionEvent('second-decision', 'task:one', { questionKey: 'decision:new-owner', decisionKind: 'ownership' }));
  f.ledger.ingest(decisionEvent('another-approval', 'task:one', { questionKey: 'decision:another-release' }));
  const restored = f.open(), before = restored.snapshot().sequence;
  assert.throws(() => restored.reserveStoredQuestion('question:unknown'), { code: 'BUTLER_QUESTION_STATE' });
  assert.equal(restored.snapshot().sequence, before, 'Delivery by id cannot create a new question');
  const reserved = restored.reserveStoredQuestion(stored.questionId);
  assert.equal(reserved.shouldNotify, true); assert.deepEqual(reserved.question, stored);
  assert.equal(restored.snapshot().sequence, before + 1);
  assert.equal(JSON.parse(lines(f.file).at(-1)).type, 'stored-question-reserve');
  const replayed = f.open();
  const again = replayed.reserveStoredQuestion(stored.questionId);
  assert.equal(again.shouldNotify, false); assert.equal(again.deliveryId, reserved.deliveryId);
  assert.deepEqual(replayed.snapshot().questions, [stored]);
  replayed.ackDelivery(reserved.deliveryId, 'sent');
  assert.equal(f.open().snapshot().deliveries[0].status, 'sent');
});

test('resolving a stored question prevents first delivery without changing its admitted identity', t => {
  const f = fixture(t); f.ledger.ingest(decisionEvent());
  const batch = f.ledger.beginBatch(selection);
  f.ledger.completeBatch(batch.batchId, selection, { actions: [{ kind: 'question', ...question() }] });
  const [stored] = f.ledger.snapshot().questions;
  f.ledger.answerQuestion(stored.questionId, 'Already decided', f.person);
  const sequence = f.ledger.snapshot().sequence;
  const reserved = f.ledger.reserveStoredQuestion(stored.questionId);
  assert.equal(reserved.shouldNotify, false); assert.equal(reserved.deliveryId, null);
  assert.equal(reserved.question.status, 'answered');
  assert.equal(f.ledger.snapshot().sequence, sequence); assert.deepEqual(f.open().snapshot().deliveries, []);
});

test('person verification defaults to deny and a literal person object cannot authorize resolution', t => {
  const f = fixture(t); f.ledger.ingest(decisionEvent());
  const first = f.ledger.reserveQuestion(question());
  const defaultDenied = new ButlerLedger(f.directory);
  assert.throws(() => defaultDenied.answerQuestion(first.question.questionId, 'Yes', { kind: 'person' }), { code: 'BUTLER_PERSON_ONLY' });
  assert.throws(() => defaultDenied.answerQuestion(first.question.questionId, 'Yes', f.person), { code: 'BUTLER_PERSON_ONLY' });
  const truthyDenied = f.open({ authorizePerson: () => ({ allowed: true }) });
  assert.throws(() => truthyDenied.answerQuestion(first.question.questionId, 'Yes', f.person), { code: 'BUTLER_PERSON_ONLY' });
  assert.equal(f.ledger.append, undefined, 'Raw ledger writes are not a public authority bypass');
  assert.equal(f.ledger.answerQuestion(first.question.questionId, 'Yes', f.person).status, 'answered');
});

test('a question resolves only from an explicit person context, never a failure or a timeout', t => {
  const f = fixture(t); f.ledger.ingest(decisionEvent());
  const reserved = f.ledger.reserveQuestion(question());
  for (const actor of [{ kind: 'agent' }, {}, { kind: 'person', sessionId: 'spoofed-extra' }])
    assert.throws(() => f.ledger.answerQuestion(reserved.question.questionId, 'Yes', actor));
  const batch = f.ledger.beginBatch(selection); f.ledger.failBatch(batch.batchId, 'timed-out');
  assert.equal(f.ledger.snapshot().questions[0].status, 'open');
  const answered = f.ledger.answerQuestion(reserved.question.questionId, 'Yes, proceed.', f.person);
  assert.equal(answered.status, 'answered');
  const duplicate = f.ledger.reserveQuestion(question({ text: 'Ask it again later?' }));
  assert.equal(duplicate.shouldNotify, false); assert.equal(duplicate.question.status, 'answered');
});

test('superseding a resolved question needs exact same-decision facts ingested after the answer', t => {
  const f = fixture(t); f.ledger.ingest(decisionEvent());
  const first = f.ledger.reserveQuestion(question());
  f.ledger.ingest(decisionEvent('old-unused', 'task:old', { outcome: 'facts-changed', supersedes: first.question.questionId }));
  const resolved = f.ledger.answerQuestion(first.question.questionId, null, f.person);
  assert.equal(resolved.resolvedSequence, 2);
  const ask = (eventId, sourceRef = 'task:one') => question({ sourceRef, evidenceRevision: eventId, supersedes: first.question.questionId });
  assert.throws(() => f.ledger.reserveQuestion(ask('not-an-event')), { code: 'BUTLER_UNKNOWN_EVIDENCE' });
  assert.throws(() => f.ledger.reserveQuestion(ask('task:one')), { code: 'BUTLER_UNKNOWN_EVIDENCE' });
  assert.throws(() => f.ledger.reserveQuestion(ask('event-1')), { code: 'BUTLER_QUESTION_EVIDENCE' });
  assert.throws(() => f.ledger.reserveQuestion(ask('old-unused')), { code: 'BUTLER_QUESTION_EVIDENCE' });
  f.ledger.ingest(decisionEvent('unrelated-new', 'task:other', { questionKey: 'decision:unrelated', outcome: 'facts-changed', supersedes: first.question.questionId }));
  assert.throws(() => f.ledger.reserveQuestion(ask('unrelated-new')), { code: 'BUTLER_QUESTION_EVIDENCE' });
  f.ledger.ingest(decisionEvent('not-marked-new', 'task:one', { supersedes: first.question.questionId }));
  assert.throws(() => f.ledger.reserveQuestion(ask('not-marked-new')), { code: 'BUTLER_QUESTION_EVIDENCE' });
  f.ledger.ingest(decisionEvent('wrong-prior', 'task:one', { outcome: 'facts-changed', supersedes: 'another-question' }));
  assert.throws(() => f.ledger.reserveQuestion(ask('wrong-prior')), { code: 'BUTLER_QUESTION_EVIDENCE' });
  f.ledger.ingest(decisionEvent('event-2', 'task:updated', { text: 'An actual new fact', outcome: 'facts-changed', supersedes: first.question.questionId }, 'recovery'));
  assert.throws(() => f.ledger.reserveQuestion({ ...ask('event-2', 'task:updated'), supersedes: 'another-question' }));
  const next = f.ledger.reserveQuestion(ask('event-2', 'task:updated'));
  assert.equal(next.shouldNotify, true); assert.notEqual(next.question.questionId, first.question.questionId);
  assert.equal(next.question.supersedes, first.question.questionId);
  assert.equal(next.question.sourceRef, 'task:one', 'The decision retains its first source');
  assert.equal(next.question.decisionSource, 'decision:release');
  assert.equal(f.open().snapshot().questions[0].status, 'withdrawn');
  assert.equal(f.open().snapshot().questions.length, 2);
});

test('a completed batch preserves duplicate question candidates for audit while deduplicating authority', t => {
  const f = fixture(t); f.ledger.ingest(decisionEvent()); const batch = f.ledger.beginBatch(selection);
  const completed = f.ledger.completeBatch(batch.batchId, selection, { actions: [
    { kind: 'question', ...question() }, { kind: 'question', ...question({ text: 'Repeated differently' }) }
  ] });
  assert.equal(completed.result.actions.length, 2, 'Raw validated proposals remain auditable');
  assert.equal(completed.actions[1].duplicateQuestion, true);
  assert.equal(completed.actions[0].actionId, completed.actions[1].actionId);
  assert.equal(f.ledger.snapshot().actions.length, 1);
  assert.equal(f.ledger.snapshot().questions.length, 1);
  assert.ok(completed.actions.every(action => action.effect === 'none'));
  assert.equal(f.open().snapshot().batches[0].result.actions[1].text, 'Repeated differently');
});

test('invented question authority is suspended while a canonical decision field cannot be smuggled in', t => {
  const f = fixture(t); f.ledger.ingest(decisionEvent()); const batch = f.ledger.beginBatch(selection);
  assert.throws(() => f.ledger.completeBatch(batch.batchId, selection, { actions: [{ kind: 'question', ...question(), decisionSource: 'model-invented' }] }));
  assert.equal(f.ledger.snapshot().cursors.processed, 0); assert.equal(f.ledger.snapshot().questions.length, 0);
  assert.equal(f.ledger.snapshot().activeBatch.batchId, batch.batchId);
  const completed = f.ledger.completeBatch(batch.batchId, selection, { actions: [{ kind: 'question', ...question({ decisionKind: 'model-invented' }) }] });
  assert.equal(completed.actions.length, 0); assert.equal(completed.suspended.length, 1);
  assert.equal(completed.suspended[0].reason, 'BUTLER_QUESTION_SOURCE');
  assert.equal(f.ledger.snapshot().questions.length, 0); assert.equal(f.ledger.snapshot().cursors.processed, 1);
});

test('one invalid question does not discard a valid action or trusted READY report, and suspension replays', t => {
  const f = fixture(t); f.ledger.ingest(decisionEvent());
  const first = f.ledger.reserveQuestion(question());
  f.ledger.answerQuestion(first.question.questionId, 'Proceed', f.person);
  // The historical evidence is deliberately older than the answer. It has the
  // right decision metadata but cannot reopen that already answered question.
  f.ledger.ingest(event('ready-one', 'delivery:one', { title: 'Independent synthetic change' }, 'ready'));
  const batch = f.ledger.beginBatch(selection), result = { actions: [
    { kind: 'question', ...question({ evidenceRevision: 'event-1', supersedes: first.question.questionId }) },
    { kind: 'queue', sourceRef: 'task:one', spaceId: 'space-one', text: 'A valid independent proposal' },
    { kind: 'report', sourceRef: 'another-private-source', text: 'An unrelated source must not become authority' }
  ], suspended: [{ stage: 'policy', index: 4, reason: 'ERR_BUTLER_QUESTION_SOURCE', kind: 'question', sourceRef: 'task:one', text: 'An unclassified candidate' }] };
  const completed = f.ledger.completeBatch(batch.batchId, selection, result), state = f.ledger.snapshot();
  assert.equal(completed.status, 'completed'); assert.equal(state.activeBatch, null); assert.deepEqual(state.quarantined, []);
  assert.deepEqual(completed.actions.map(action => action.kind), ['queue']);
  assert.deepEqual(completed.suspended.map(candidate => [candidate.stage, candidate.index, candidate.reason]), [
    ['policy', 4, 'ERR_BUTLER_QUESTION_SOURCE'], ['ledger', 0, 'BUTLER_QUESTION_EVIDENCE'], ['ledger', 2, 'BUTLER_ACTION_SOURCE']
  ]);
  assert.ok(completed.suspended.every(candidate => candidate.status === 'suspended' && candidate.effect === 'none'));
  assert.equal(new Set(completed.suspended.map(candidate => candidate.candidateId)).size, 3);
  assert.equal(completed.suspended[2].sourceRef, undefined, 'An untrusted source is omitted from suspended audit metadata');
  assert.equal(state.questions.length, 1); assert.equal(state.questions[0].status, 'answered');
  assert.deepEqual(state.pendingEvents, []); assert.equal(state.cursors.processed, 2);
  assert.match(state.reports[0].text, /READY delivery:one: Independent synthetic change/u);
  assert.deepEqual(f.open().snapshot().suspended, state.suspended);
  assert.deepEqual(f.open().snapshot().batches[0].suspended, completed.suspended);
  const sequence = state.sequence;
  assert.deepEqual(f.ledger.completeBatch(batch.batchId, selection, result), completed);
  assert.equal(f.ledger.snapshot().sequence, sequence, 'Completion replay retains stable suspension IDs without appending');
});

test('unclassified question candidates can all suspend without dropping READY or creating questions', t => {
  const f = fixture(t); f.ledger.ingest(event());
  f.ledger.ingest(event('ready', 'delivery:ready', { title: 'Still report this' }, 'ready'));
  const batch = f.ledger.beginBatch(selection);
  f.ledger.completeBatch(batch.batchId, selection, { actions: [{ kind: 'question', ...question() }] });
  const state = f.open().snapshot();
  assert.equal(state.actions.length, 0); assert.equal(state.questions.length, 0);
  assert.equal(state.suspended[0].reason, 'BUTLER_QUESTION_SOURCE');
  assert.match(state.reports[0].text, /delivery:ready: Still report this/u);
  assert.deepEqual(state.pendingEvents, []); assert.deepEqual(state.quarantined, []);
});

test('suspension metadata is a strict safe host projection rather than an alternative effect channel', t => {
  const f = fixture(t); f.ledger.ingest(event()); const batch = f.ledger.beginBatch(selection);
  const candidate = { stage: 'policy', index: 0, reason: 'ERR_BUTLER_RESULT' };
  for (const bad of [
    { ...candidate, effect: 'execute' }, { ...candidate, candidateId: 'chosen-id' },
    { ...candidate, stage: 'ledger' }, { ...candidate, index: 100 }, { ...candidate, reason: 'model authored explanation' },
    { ...candidate, sourceRef: 'Authorization: Bearer synthetic-not-a-credential' },
    { ...candidate, text: 'Authorization: Bearer synthetic-not-a-credential' },
    { ...candidate, redacted: false }
  ]) assert.throws(() => f.ledger.completeBatch(batch.batchId, selection, { actions: [], suspended: [bad] }));
  assert.throws(() => f.ledger.completeBatch(batch.batchId, selection, { actions: [], suspended: [candidate, candidate] }));
  assert.equal(f.ledger.snapshot().cursors.processed, 0); assert.deepEqual(f.ledger.snapshot().suspended, []);
  const completed = f.ledger.completeBatch(batch.batchId, selection, { actions: [], suspended: [{ ...candidate, redacted: true }] });
  assert.equal(completed.suspended[0].text, undefined); assert.equal(completed.suspended[0].redacted, true);
  assert.equal(f.open().snapshot().suspended[0].candidateId, completed.suspended[0].candidateId);
});

test('READY events always produce one stable report containing every trusted source and title', t => {
  for (const suppliedReport of [false, true]) {
    const f = fixture(t);
    f.ledger.ingest(event('ready-one', 'delivery:one', { title: 'First synthetic change' }, 'ready'));
    f.ledger.ingest(event('ready-two', 'delivery:two', { title: 'Second synthetic change' }, 'ready'));
    const batch = f.ledger.beginBatch(selection), result = { actions: suppliedReport ? [{ kind: 'report', sourceRef: 'delivery:one', text: 'Only mentioned the first change' }] : [] };
    f.ledger.completeBatch(batch.batchId, selection, result);
    const [report] = f.open().pendingReports();
    assert.ok(report); assert.match(report.text, /delivery:one: First synthetic change/u); assert.match(report.text, /delivery:two: Second synthetic change/u);
    assert.deepEqual(report.readyEvents.map(row => row.eventId), ['ready-one', 'ready-two']);
    assert.equal(f.ledger.snapshot().reports.length, 1);
    f.ledger.completeBatch(batch.batchId, selection, result);
    assert.equal(f.ledger.pendingReports()[0].reportId, report.reportId, 'Completion replay cannot create a second READY report');
    assert.deepEqual(f.ledger.snapshot().cursors, { processed: 2, reported: 0 });
  }
});

test('report consumption and reporting cursors are independent; unknown delivery never automatically resends', t => {
  const f = fixture(t); f.ledger.ingest(event()); f.ledger.ingest(event('event-2', 'task:two', { title: 'Ready work' }, 'ready'));
  const batch = f.ledger.beginBatch(selection);
  f.ledger.completeBatch(batch.batchId, selection, { actions: [{ kind: 'report', sourceRef: 'task:one', text: 'Only new synthetic progress' }] });
  assert.deepEqual(f.ledger.snapshot().cursors, { processed: 2, reported: 0 });
  const [report] = f.ledger.pendingReports(); const first = f.ledger.reserveReport(report.reportId);
  assert.equal(first.shouldNotify, true); f.ledger.ackDelivery(first.deliveryId, 'unknown');
  const restored = f.open();
  assert.deepEqual(restored.pendingReports(), []);
  assert.equal(restored.reserveReport(report.reportId).shouldNotify, false);
  assert.deepEqual(restored.snapshot().cursors, { processed: 2, reported: 0 });
  restored.ackDelivery(first.deliveryId, 'sent');
  assert.deepEqual(restored.snapshot().cursors, { processed: 2, reported: 2 });
  const sequence = restored.snapshot().sequence; restored.ackDelivery(first.deliveryId, 'sent');
  assert.equal(restored.snapshot().sequence, sequence);
  assert.throws(() => restored.ackDelivery(first.deliveryId, 'unknown'));
});

test('rule-handled decisions cannot fill a model batch ahead of the next real request', t => {
  const f = fixture(t), recorded = [];
  for (let i = 0; i < 101; i++) {
    const eventId = 'decision-' + i; recorded.push(eventId);
    f.ledger.ingest(event(eventId, 'issue:' + i, { text: 'Already notified by the rule path' }, 'decision'));
  }
  const before = lines(f.file).length;
  assert.equal(f.ledger.consumeRecorded(recorded).recordedCount, 101);
  assert.equal(lines(f.file).length, before + 1, 'One durable transition records the whole rule-handled set');
  assert.equal(f.ledger.consumeRecorded(recorded).recordedCount, 0);
  assert.equal(lines(f.file).length, before + 1, 'Repeated consumption is idempotent');
  f.ledger.ingest(event('new-request', 'task:new'));
  const restored = f.open();
  assert.equal(restored.snapshot().events.length, 102, 'Rule-handled source events are retained');
  assert.deepEqual(restored.pendingEvents().map(row => row.eventId), ['new-request']);
  assert.deepEqual(restored.snapshot().cursors, { processed: 101, reported: 0 });
  assert.deepEqual(restored.beginBatch(selection).eventIds, ['new-request']);
  assert.throws(() => restored.consumeRecorded(['new-request']));
  assert.throws(() => restored.consumeRecorded(['missing-event']));
});

test('record-only rule consumption refuses events owned by an active batch and model-worthy event kinds', t => {
  const f = fixture(t); f.ledger.ingest(event('blocked', 'task:blocked', { reason: 'permission' }, 'blocked'));
  f.ledger.beginBatch(selection);
  assert.throws(() => f.ledger.consumeRecorded(['blocked']), { code: 'BUTLER_BATCH_STATE' });
  for (const kind of ['request', 'ready', 'queue-empty', 'recovery']) {
    const id = 'event-' + kind; f.ledger.ingest(event(id, 'task:' + kind, {}, kind));
    assert.throws(() => f.ledger.consumeRecorded([id]));
  }
  assert.equal(f.ledger.snapshot().cursors.processed, 0);
});

test('returned state cannot mutate persisted event or batch identity', t => {
  const f = fixture(t); const input = event(); const saved = f.ledger.ingest(input);
  input.payload.text = 'Changed caller input'; saved.payload.text = 'Changed returned record';
  const batch = f.ledger.beginBatch(selection); batch.selection.identity.nativeId = 'Changed returned actor';
  const snapshot = f.ledger.snapshot(); snapshot.pendingEvents[0].payload.text = 'Changed snapshot';
  assert.equal(f.ledger.pendingEvents()[0].payload.text, 'Synthetic request');
  assert.equal(f.ledger.snapshot().activeBatch.selection.identity.nativeId, 'native-1');
  assert.equal(f.open().pendingEvents()[0].payload.text, 'Synthetic request');
});

test('incomplete or malformed source journals fail closed without truncation', t => {
  for (const suffix of ['{', '{"version":1}\n', '\n']) {
    const f = fixture(t); f.ledger.ingest(event()); fs.appendFileSync(f.file, suffix);
    const before = fs.readFileSync(f.file);
    assert.throws(() => f.open());
    assert.deepEqual(fs.readFileSync(f.file), before, 'Damaged source is retained for recovery');
  }
});

test('invalid UTF-8 inside otherwise valid JSON is not silently repaired during replay', t => {
  const f = fixture(t); f.ledger.ingest(event());
  const bytes = fs.readFileSync(f.file), position = bytes.indexOf(Buffer.from('Synthetic'));
  assert.ok(position >= 0); bytes[position] = 255; fs.writeFileSync(f.file, bytes);
  assert.throws(() => f.open()); assert.deepEqual(fs.readFileSync(f.file), bytes);
});

test('unsafe file permissions, symlinks, hardlinks and a symlinked directory are refused', t => {
  const f = fixture(t); f.ledger.ingest(event()); const original = fs.readFileSync(f.file);
  fs.chmodSync(f.file, 0o644); assert.throws(() => f.open(), { code: 'BUTLER_LEDGER_UNSAFE' }); fs.chmodSync(f.file, 0o600);
  const alias = path.join(f.directory, 'alias'); fs.linkSync(f.file, alias);
  assert.throws(() => f.open(), { code: 'BUTLER_LEDGER_UNSAFE' }); fs.unlinkSync(alias);
  const other = fixture(t), link = path.join(other.directory, 'linked'); fs.symlinkSync(f.directory, link, 'dir');
  assert.throws(() => new ButlerLedger(link), { code: 'BUTLER_LEDGER_UNSAFE' });
  const target = path.join(f.directory, 'original'); fs.renameSync(f.file, target); fs.symlinkSync(target, f.file);
  assert.throws(() => f.open()); assert.deepEqual(fs.readFileSync(target), original);
});

test('a partial append makes the writer fail closed and preserves the torn source instead of acknowledging work', t => {
  const f = fixture(t); f.ledger.ingest(event()); const batch = f.ledger.beginBatch(selection);
  const before = fs.readFileSync(f.file); const originalWrite = fs.writeSync;
  t.mock.method(fs, 'writeSync', (fd, buffer, offset, length) => {
    originalWrite(fd, buffer, offset, Math.min(length, 11));
    throw Object.assign(Error('Synthetic disk failure'), { code: 'EIO' });
  });
  assert.throws(() => f.ledger.completeBatch(batch.batchId, selection, { actions: [] }), { code: 'BUTLER_LEDGER_WRITE' });
  t.mock.restoreAll();
  assert.throws(() => f.ledger.snapshot(), { code: 'BUTLER_LEDGER_FAILED' });
  const after = fs.readFileSync(f.file); assert.deepEqual(after.subarray(0, before.length), before); assert.ok(after.length > before.length);
  assert.throws(() => f.open()); assert.deepEqual(fs.readFileSync(f.file), after);
});

test('a stale second writer cannot append over another writers committed events', t => {
  const f = fixture(t); f.ledger.ingest(event()); const stale = f.open();
  f.ledger.ingest(event('event-2', 'task:two'));
  const before = fs.readFileSync(f.file);
  assert.throws(() => stale.ingest(event('event-3', 'task:three')), { code: 'BUTLER_LEDGER_WRITE' });
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.deepEqual(f.open().pendingEvents().map(row => row.eventId), ['event-1', 'event-2']);
});
