const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { ButlerLedger } = require('../butler-ledger.cjs');
const { create } = require('../renderer/butler-review-adapter.js');
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const words = {
  questionMetricUnavailable: 'This period has no complete question-delivery measurement.',
  questionMetricUnknown: '{count} delivery attempts have an unknown outcome.',
  questionMetricUnattributed: '{count} attempts cannot be attributed to a question.',
  questionMetricUnobserved: '{count} question sources or deliveries lack physical delivery records.',
  questionMetricBaseline: '{count} questions have an uncertain earlier baseline.',
  questionMetricIncomplete: 'The delivery records do not cover this entire period.',
  adapterInvalid: 'The stored review response could not be verified.', adapterChanged: 'This review has changed. Read it again.',
  adapterDisposed: 'This review window has closed.', adapterConflict: 'Another review revision is current. Your draft is retained.',
  adapterCapacity: 'The complete review is too large to save. Your draft is retained.', adapterPersonOnly: 'Use the person’s desktop window.',
  adapterUnavailable: 'Review storage is unavailable.', adapterFailed: 'The review operation did not finish.',
};
function text(key, params = {}) { const template = words[key.replace(/^butlerReview\./, '')]; assert.ok(template, key); return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name])); }
function fixture(t, { metrics = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-review-adapter-')); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const person = Symbol('person'); let serial = 0;
  const reopen = () => new ButlerLedger(directory, { authorizePerson: actor => actor === person, id: () => 'adapter-' + ++serial });
  const ledger = reopen(); if (metrics) ledger.openQuestionMetricEpoch('adapter-epoch');
  ledger.ingest({ eventId: 'source', sourceRef: 'task:source', kind: 'request', payload: { text: 'A complete synthetic original request.' } });
  const selection = { selectionRevision: 1, identity: { sessionId: 'butler', nativeId: 'native' }, runnerRef: 'runner' };
  const batch = ledger.beginBatch(selection);
  ledger.completeBatch(batch.batchId, selection, {
    actions: ['First distinct task', 'Second distinct task', 'First distinct task'].map(value => ({ kind: 'queue', sourceRef: 'task:source', text: value, spaceId: 'space' })),
    suspended: [{ stage: 'policy', index: 3, kind: 'queue', sourceRef: 'task:source', text: 'Suspended task', reason: 'ERR_BUTLER_AMBIGUOUS_SPACE' }],
  });
  const calls = [];
  const apiFor = (instance = ledger) => ({ butlerReview: async (action, ...args) => {
    calls.push([action, ...structuredClone(args)]);
    if (action === 'latest') return instance.latestReview(person);
    if (action === 'freeze') return instance.freezeReview({ afterSequence: 0 }, person);
    if (action === 'read') return instance.review(args[0], person);
    if (action === 'confirm') { const { reviewId, ...request } = args[0]; return instance.confirmReview(reviewId, request, person); }
    throw Error('Unexpected adapter operation');
  } });
  return { ledger, person, apiFor, calls, reopen, file: path.join(directory, 'butler-ledger.jsonl') };
}
const draft = (view, marks = []) => ({ token: view.token, marks, allRead: true });

test('read never freezes implicitly; explicit open freezes only when latest is absent', async t => {
  const f = fixture(t), adapter = create({ api: f.apiFor(), text }), before = fs.readFileSync(f.file);
  assert.equal(await adapter.read(), null); assert.deepEqual(fs.readFileSync(f.file), before); assert.deepEqual(f.calls.map(c => c[0]), ['latest']);
  const first = await adapter.open(); assert.ok(first.token); assert.deepEqual(f.calls.map(c => c[0]), ['latest', 'latest', 'freeze']);
  const after = fs.readFileSync(f.file), again = await adapter.open(); assert.equal(again.token, first.token);
  assert.deepEqual(fs.readFileSync(f.file), after); assert.equal(typeof adapter.availability, 'undefined');
});

test('only an explicit new audit incorporates later business records and leaves the saved review intact', async t => {
  const f = fixture(t), adapter = create({ api: f.apiFor(), text });
  const first = await adapter.open(), saved = await adapter.confirm(draft(first));
  f.ledger.ingest({ eventId: 'later-source', sourceRef: 'task:later', kind: 'request', payload: { text: 'A later complete task.' } });
  const selection = { selectionRevision: 1, identity: { sessionId: 'butler', nativeId: 'native' }, runnerRef: 'runner' };
  const batch = f.ledger.beginBatch(selection);
  f.ledger.completeBatch(batch.batchId, selection, { actions: [{ kind: 'queue', sourceRef: 'task:later', text: 'A later distinct suggestion', spaceId: 'space' }] });
  const before = fs.readFileSync(f.file), restored = await adapter.open();
  assert.equal(restored.token, saved.token); assert.deepEqual(restored.confirmation, saved.confirmation);
  assert.deepEqual(fs.readFileSync(f.file), before);
  const fresh = await adapter.freeze();
  assert.notEqual(fresh.token, saved.token); assert.equal(fresh.rows.length, saved.rows.length + 1);
  assert.equal(fresh.confirmation, null); assert.equal(fresh.summary.distinctSuggestions, 3);
  assert.equal(f.ledger.review(JSON.parse(saved.token)[0], f.person).revision, 1);
});

test('explicit opening recovers from an old empty latest review after new suggestions arrive', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-review-empty-latest-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const person = Symbol('person'), ledger = new ButlerLedger(directory, { authorizePerson: actor => actor === person });
  const empty = ledger.freezeReview({}, person), calls = [];
  const adapter = create({ text, api: { butlerReview: async action => {
    calls.push(action);
    if (action === 'latest') return ledger.latestReview(person);
    if (action === 'freeze') return ledger.freezeReview({}, person);
    throw Error('Unexpected operation');
  } } });
  assert.equal((await adapter.read()).rows.length, 0); assert.deepEqual(calls, ['latest']);
  ledger.ingest({ eventId: 'later', sourceRef: 'task:later', kind: 'request', payload: { text: 'A later original request' } });
  const selection = { selectionRevision: 1, identity: { sessionId: 'butler', nativeId: 'native' }, runnerRef: 'runner' };
  const batch = ledger.beginBatch(selection);
  ledger.completeBatch(batch.batchId, selection, { actions: [{ kind: 'queue', sourceRef: 'task:later', text: 'A later suggestion', spaceId: 'space' }] });
  assert.equal(ledger.hasReviewData(person), true);
  const view = await adapter.open();
  assert.equal(view.rows.length, 1); assert.notEqual(JSON.parse(view.token)[0], empty.reviewId);
  assert.deepEqual(calls, ['latest', 'latest', 'freeze']);
});

test('audit provenance stays distinct from synthetic examples and never becomes a real trial sample', async t => {
  const f = fixture(t), adapter = create({ api: f.apiFor(), text }), view = await adapter.open();
  assert.equal(view.rows.length, 4); assert.equal(view.summary.distinctSuggestions, 2);
  assert.equal(view.sampleKind, 'audit'); assert.equal(view.synthetic, false); assert.equal(view.realSamples, 0);
  assert.equal(view.confirmation, null); assert.equal(view.repeatedQuestionsToPerson.complete, false);
  assert.equal(view.repeatedQuestionsToPerson.count, null); assert.equal(view.repeatedQuestionsToPerson.reason, words.questionMetricUnavailable);
  assert.equal(view.blockedRepeatQuestionCandidates, 0);
});

test('formal confirmation strips one UI prefix, validates the current receipt and restores it after restart', async t => {
  const f = fixture(t), adapter = create({ api: f.apiFor(), text }), view = await adapter.open();
  const suggestion = view.rows.find(r => !r.suspended), candidate = view.rows.find(r => r.suspended);
  assert.match(suggestion.suggestionId, /^suggestion:/);
  const marks = ['suggestion:' + suggestion.suggestionId, 'candidate:' + candidate.candidateId];
  const confirmed = await adapter.confirm(draft(view, marks));
  assert.notEqual(confirmed.token, view.token); assert.equal(confirmed.confirmation.allRead, true); assert.equal(confirmed.confirmation.revision, 1);
  assert.deepEqual(new Set(confirmed.confirmation.marks), new Set(marks));
  const request = f.calls.find(c => c[0] === 'confirm')[1];
  assert.deepEqual(request.disagreedSuggestionIds, [suggestion.suggestionId]); assert.deepEqual(request.disagreedCandidateIds, [candidate.candidateId]);
  const restored = await create({ api: f.apiFor(f.reopen()), text }).read();
  assert.deepEqual(restored, confirmed);
});

test('unknown ids, duplicate marks and stale UI tokens fail before a host write', async t => {
  const f = fixture(t), adapter = create({ api: f.apiFor(), text }), view = await adapter.open(); const before = fs.readFileSync(f.file);
  const known = 'suggestion:' + view.rows[0].suggestionId;
  for (const value of [draft(view, ['suggestion:unknown']), draft(view, [known, known]), draft(view, ['bad-prefix:id']), { ...draft(view), allRead: false }, { ...draft(view), token: 'stale' }]) await assert.rejects(adapter.confirm(value));
  assert.deepEqual(fs.readFileSync(f.file), before); assert.equal(f.calls.filter(c => c[0] === 'confirm').length, 0);
});

test('two windows cannot silently replace each other’s saved revision', async t => {
  const f = fixture(t), first = create({ api: f.apiFor(), text }), second = create({ api: f.apiFor(), text });
  const a = await first.open(), b = await second.open();
  await first.confirm(draft(a, ['suggestion:' + a.rows[0].suggestionId])); const bytes = fs.readFileSync(f.file);
  await assert.rejects(second.confirm(draft(b)), { code: 'BUTLER_REVIEW_REVISION' });
  assert.deepEqual(fs.readFileSync(f.file), bytes);
});

test('an idempotent old request returning a later amendment is not accepted as the old draft', async t => {
  const f = fixture(t); let adapter;
  const base = f.apiFor(); const api = { butlerReview: async (action, ...args) => {
    if (action !== 'confirm') return base.butlerReview(action, ...args);
    const { reviewId, ...input } = args[0]; const first = f.ledger.confirmReview(reviewId, input, f.person);
    f.ledger.confirmReview(reviewId, { ...input, expectedRevision: first.revision, disagreedSuggestionIds: [], disagreedCandidateIds: [] }, f.person);
    return f.ledger.confirmReview(reviewId, input, f.person);
  } };
  adapter = create({ api, text }); const view = await adapter.open();
  await assert.rejects(adapter.confirm(draft(view, ['suggestion:' + view.rows[0].suggestionId])));
  assert.equal(f.ledger.latestReview(f.person).revision, 2);
});

test('abnormal current receipts never become accepted confirmations', async t => {
  const f = fixture(t); const frozen = f.ledger.freezeReview({}, f.person);
  const input = { contentDigest: frozen.contentDigest, expectedRevision: frozen.revision, disagreedSuggestionIds: [], disagreedCandidateIds: [], allRead: true };
  const valid = f.ledger.confirmReview(frozen.reviewId, input, f.person);
  const mutations = [r => r.reviewId = 'review:other', r => r.contentDigest = 'digest:other', r => r.revision++,
    r => r.confirmation = null, r => r.confirmation.allRead = false, r => r.confirmation.expectedRevision++,
    r => r.confirmation.revision++, r => r.confirmation.contentDigest = 'digest:other',
    r => r.confirmation.disagreedSuggestionIds = [frozen.frozen.rows[0].suggestionId],
    r => r.confirmation.disagreedCandidateIds = [frozen.frozen.rows.find(row => row.suspended).candidateId]];
  for (const mutate of mutations) {
    const malformed = structuredClone(valid); mutate(malformed);
    const adapter = create({ api: { butlerReview: async action => action === 'latest' ? structuredClone(frozen) : malformed }, text });
    const view = await adapter.read(); await assert.rejects(adapter.confirm(draft(view)));
  }
});

for (const repeated of [0, 2]) test(`complete physical measurements retain repeated count ${repeated}`, async t => {
  const f = fixture(t, { metrics: true });
  if (repeated) {
    f.ledger.ingest({ eventId: 'decision', sourceRef: 'task:decision', kind: 'decision', payload: { text: 'Choose one.', questionKey: 'issue:decision', decisionKind: 'approval' } });
    const q = f.ledger.reserveQuestion({ sourceRef: 'task:decision', decisionKind: 'approval', text: 'Proceed?' });
    for (let i = 0; i <= repeated; i++) { const attemptId = 'shown-' + i; f.ledger.beginQuestionSend({ attemptId, questionId: q.question.questionId, deliveryId: q.deliveryId, sourceEventId: 'decision', channel: 'notification' }); f.ledger.ackQuestionSend(attemptId, 'shown'); }
  }
  const view = await create({ api: f.apiFor(), text }).open();
  assert.deepEqual(view.repeatedQuestionsToPerson, { complete: true, count: repeated, reason: null });
});

test('incomplete metric details use human explanations rather than an invented zero or reason code', async t => {
  const f = fixture(t, { metrics: true });
  f.ledger.ingest({ eventId: 'decision', sourceRef: 'task:decision', kind: 'decision', payload: { text: 'Choose one.', questionKey: 'issue:decision', decisionKind: 'approval' } });
  const q = f.ledger.reserveQuestion({ sourceRef: 'task:decision', decisionKind: 'approval', text: 'Proceed?' });
  f.ledger.beginQuestionSend({ attemptId: 'uncertain', questionId: q.question.questionId, deliveryId: q.deliveryId, sourceEventId: 'decision', channel: 'notification' });
  const view = await create({ api: f.apiFor(), text }).open();
  assert.equal(view.repeatedQuestionsToPerson.complete, false); assert.equal(view.repeatedQuestionsToPerson.count, null);
  assert.match(view.repeatedQuestionsToPerson.reason, /1 delivery attempts have an unknown outcome/);
  assert.doesNotMatch(view.repeatedQuestionsToPerson.reason, /ERR_|BUTLER_/);
});

test('late reads and confirmations cannot replace a newer lightweight binding', async t => {
  const f = fixture(t), oldReview = f.ledger.freezeReview({}, f.person), newReview = f.ledger.freezeReview({}, f.person);
  const old = deferred(); let reads = 0;
  const adapter = create({ api: { butlerReview: async (action, ...args) => {
    if (action === 'latest') return ++reads === 1 ? old.promise : newReview;
    return f.apiFor().butlerReview(action, ...args);
  } }, text });
  const earlier = adapter.read(), later = await adapter.read(); old.resolve(oldReview); await assert.rejects(earlier, { code: 'BUTLER_REVIEW_STALE_UI' });
  assert.equal((await adapter.confirm(draft(later))).confirmation.revision, 1);
  const held = deferred(), realApi = f.apiFor(); let saved;
  const another = create({ api: { butlerReview: async (action, ...args) => { if (action !== 'confirm') return realApi.butlerReview(action, ...args); saved = await realApi.butlerReview(action, ...args); return held.promise; } }, text });
  const view = await another.read(), pending = another.confirm(draft(view)); await new Promise(resolve => setImmediate(resolve));
  const fresh = await another.read(); held.resolve(saved); await assert.rejects(pending, { code: 'BUTLER_REVIEW_STALE_UI' });
  assert.notEqual(fresh.token, view.token);
});

test('normalization does not mutate host records and the adapter binds ids independently of the returned VM', async t => {
  const f = fixture(t), stored = f.ledger.freezeReview({}, f.person), original = JSON.stringify(stored), bytes = fs.readFileSync(f.file);
  const adapter = create({ api: { butlerReview: async action => { assert.equal(action, 'latest'); return stored; } }, text });
  const view = await adapter.read(); view.rows[0].sources[0].payload.text = 'UI changed clone'; view.rows[0].suggestionId = 'suggestion:forged';
  await assert.rejects(adapter.confirm(draft(view, ['suggestion:suggestion:forged'])));
  assert.equal(JSON.stringify(stored), original); assert.deepEqual(fs.readFileSync(f.file), bytes);
});

test('dispose invalidates pending work and prevents future API calls', async t => {
  const f = fixture(t), review = f.ledger.freezeReview({}, f.person), pending = deferred(); let calls = 0;
  const adapter = create({ api: { butlerReview: async () => { calls++; return pending.promise; } }, text });
  const read = adapter.read(); adapter.dispose(); pending.resolve(review); await assert.rejects(read, { code: 'BUTLER_REVIEW_STALE_UI' });
  await assert.rejects(adapter.read(), { code: 'BUTLER_REVIEW_DISPOSED' }); await assert.rejects(adapter.open(), { code: 'BUTLER_REVIEW_DISPOSED' });
  await assert.rejects(adapter.confirm({}), { code: 'BUTLER_REVIEW_DISPOSED' }); assert.equal(calls, 1);
});
