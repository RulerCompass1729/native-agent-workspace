const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const model = require('../renderer/butler-review-model.js');
const policy = require('../butler-review-policy.js');
const { MIN_REAL_SUGGESTIONS, rowKey, summarize } = model;
const measured = (count = 0) => ({ complete: true, count });
const options = (patch = {}) => ({ confirmed: true, synthetic: false, sampleKind: 'real', repeatedQuestionsToPerson: measured(), ...patch, ...(patch.synthetic === true && patch.sampleKind === undefined ? { sampleKind: 'synthetic' } : {}) });
const row = (id, suggestionId, patch = {}) => ({ id, suggestionId, suspended: false, assessable: true, ...patch });
const fixture = () => [
  row('first-queue', 'queue'), row('report', 'report'), row('first-question', 'question'),
  row('paused-known', null, { suspended: true, candidateId: 'known-candidate' }),
  row('repeat-question', 'question'), row('repeat-queue', 'queue'),
  row('paused-unknown', null, { suspended: true, candidateId: 'unknown-candidate', assessable: false }),
];
const marksFor = rows => new Set([rowKey(rows[0])]);

test('seven occurrences preserve the complete table but count distinct unsuspended suggestions', () => {
  const rows = fixture(), s = summarize(rows, marksFor(rows), options());
  assert.deepEqual(s, {
    total: 7, denominator: 3, agreed: 2, disagreed: 1, unable: 0,
    pendingOccurrences: 0, suspended: 2, unknownOccurrences: 1, realSamples: 3,
    measurement: { complete: true, count: 0, reason: null }, minimumSamples: 10,
    pausedDisagreed: 0, pausedUnable: 1, pausedAgreed: 1, sampleKind: 'real', markedSuggestions: 1,
    quality: policy.agreementSummary({ distinctSuggestions: 3, agreedSuggestions: 2, confirmed: true }),
  });
  assert.equal(rowKey(rows[0]), rowKey(rows[5]));
  assert.equal(rowKey(rows[2]), rowKey(rows[4]));
});

test('missing report source stays in N and cannot become agreement', () => {
  const rows = fixture(); rows[1].assessable = false;
  const s = summarize(rows, marksFor(rows), options());
  assert.equal(s.denominator, 3); assert.equal(s.agreed, 1); assert.equal(s.unable, 1);
  assert.equal(s.unknownOccurrences, 2); assert.equal(s.realSamples, 3);
});

test('an unknown repeat makes its entire suggestion unassessable without shrinking N', () => {
  const rows = fixture(); rows[4].assessable = false;
  const s = summarize(rows, new Set(), options());
  assert.equal(s.denominator, 3); assert.equal(s.agreed, 2); assert.equal(s.unable, 1);
  const marked = summarize(rows, new Set([rowKey(rows[2])]), options());
  assert.equal(marked.disagreed, 0); assert.equal(marked.unable, 1); assert.equal(marked.markedSuggestions, 1); assert.equal(marked.agreed, 2);
});

test('no confirmation or attestation-shaped extra option creates agreement', () => {
  const rows = fixture();
  const s = summarize(rows, marksFor(rows), options({ confirmed: false, attested: true }));
  assert.equal(s.agreed, 0); assert.equal(s.disagreed, 0); assert.equal(s.markedSuggestions, 1); assert.equal(s.pendingOccurrences, 5);
  assert.equal(s.pausedAgreed, 0); assert.equal(s.realSamples, 3);
  const missingConfirmed = options(); delete missingConfirmed.confirmed;
  assert.equal(summarize(rows, new Set(), missingConfirmed).agreed, 0);
});

test('synthetic data has zero real samples; real sample count is N, never days', () => {
  const rows = fixture(), marks = marksFor(rows);
  assert.equal(summarize(rows, marks, options({ synthetic: true })).realSamples, 0);
  assert.equal(summarize(rows, marks, options({ days: 1 })).realSamples, 3);
  assert.equal(MIN_REAL_SUGGESTIONS, 10);
  assert.equal(summarize(rows, marks, options()).minimumSamples, 10);
});

test('zero and positive measured repeated-question counts remain available as real data', () => {
  for (const count of [0, 2]) {
    const s = summarize(fixture(), new Set(), options({ repeatedQuestionsToPerson: measured(count) }));
    assert.deepEqual(s.measurement, { complete: true, count, reason: null });
  }
});

test('incomplete records preserve their explanation and any explicitly partial count', () => {
  for (const count of [null, 2]) {
    const measurement = { complete: false, count, reason: 'Delivery records for the beginning of this period are missing.' };
    const s = summarize(fixture(), new Set(), options({ repeatedQuestionsToPerson: measurement }));
    assert.deepEqual(s.measurement, measurement); assert.notEqual(s.measurement, measurement);
  }
});

test('absent or invalid measurements cannot silently become not-verified or zero', () => {
  const invalid = [undefined, null, {}, { complete: true, count: null },
    { complete: true }, { complete: false, count: undefined, reason: 'Earlier records are missing.' },
    { complete: false, count: null }, { complete: false, count: null, reason: ' ' },
    { complete: false, count: null, reason: 'ERR_BUTLER_MISSING_RECORDS' },
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '0'].map(count => ({ complete: true, count })),
  ];
  for (const measurement of invalid) assert.throws(() => summarize([], new Set(), options({ repeatedQuestionsToPerson: measurement })), TypeError);
});

test('semantic ids, not action ids or similar text, define distinct suggestions', () => {
  const rows = [row('one', 'task-one', { actionId: 'legacy-same' }), row('two', 'task-two', { actionId: 'legacy-same' })];
  assert.equal(summarize(rows, new Set(), options()).denominator, 2);
  for (const suggestionId of [undefined, null, '', ' ']) {
    assert.throws(() => rowKey(row('one', suggestionId, { actionId: 'legacy-id' })), /semantic suggestionId/);
  }
});

test('paused candidate keys stay separate from suggestions even when metadata names the same suggestion', () => {
  const rows = [row('real', 'same'), row('paused', 'same', { suspended: true, candidateId: 'candidate', assessable: false })];
  assert.notEqual(rowKey(rows[0]), rowKey(rows[1]));
  const s = summarize(rows, new Set([rowKey(rows[1])]), options());
  assert.equal(s.denominator, 1); assert.equal(s.agreed, 1); assert.equal(s.disagreed, 0);
  assert.equal(s.suspended, 1); assert.equal(s.pausedDisagreed, 1);
  assert.equal(rowKey(row('only-occurrence', null, { suspended: true })), 'occurrence:only-occurrence');
});

test('repeated suspended candidate occurrences count once and any unknown source keeps the candidate unassessable', () => {
  const rows = [row('real', 'real'),
    row('paused-first', null, { suspended: true, candidateId: 'same-candidate' }),
    row('paused-repeat', null, { suspended: true, candidateId: 'same-candidate', assessable: false }),
    row('other-paused', null, { suspended: true, candidateId: 'other-candidate' })];
  const s = summarize(rows, new Set(), options());
  assert.equal(s.total, 4); assert.equal(s.suspended, 2); assert.equal(s.unknownOccurrences, 1);
  assert.equal(s.pausedUnable, 1); assert.equal(s.pausedAgreed, 1); assert.equal(s.pausedDisagreed, 0);
  assert.equal(s.denominator, 1); assert.equal(s.agreed, 1); assert.equal(s.realSamples, 1);
  const marked = summarize(rows, new Set([rowKey(rows[2])]), options());
  assert.equal(marked.total, 4); assert.equal(marked.suspended, 2);
  assert.equal(marked.pausedDisagreed, 1); assert.equal(marked.pausedUnable, 0); assert.equal(marked.pausedAgreed, 1);
  assert.equal(marked.denominator, 1); assert.equal(marked.agreed, 1); assert.equal(marked.disagreed, 0);
});

test('fully assessable repeated paused candidates agree once only after confirmation', () => {
  const rows = [row('paused-first', null, { suspended: true, candidateId: 'same-candidate' }),
    row('paused-repeat', null, { suspended: true, candidateId: 'same-candidate' })];
  const pending = summarize(rows, new Set(), options({ confirmed: false }));
  assert.equal(pending.total, 2); assert.equal(pending.suspended, 1); assert.equal(pending.pendingOccurrences, 2); assert.equal(pending.pausedAgreed, 0);
  const confirmed = summarize(rows, new Set(), options());
  assert.equal(confirmed.pausedAgreed, 1); assert.equal(confirmed.pausedUnable, 0); assert.equal(confirmed.denominator, 0); assert.equal(confirmed.agreed, 0);
});

test('empty and only-suspended reviews have N zero and no real samples or agreement', () => {
  for (const rows of [[], fixture().filter(r => r.suspended)]) {
    const s = summarize(rows, new Set(), options());
    assert.equal(s.denominator, 0); assert.equal(s.agreed, 0); assert.equal(s.realSamples, 0);
    assert.equal(s.total, rows.length);
  }
});

test('invalid occurrence identity or flags fail rather than dropping records', () => {
  const invalid = [[row('same', 'one'), row('same', 'two')], [row('', 'one')],
    [row('one', 'one', { suspended: undefined })], [row('one', 'one', { assessable: undefined })]];
  for (const rows of invalid) assert.throws(() => summarize(rows, new Set(), options()), TypeError);
  assert.throws(() => summarize([], [], options()), /Set/);
  assert.throws(() => summarize([], new Set(), options({ synthetic: undefined })), /synthetic/i);
  assert.throws(() => summarize([], new Set(), options({ confirmed: 'true' })), /boolean/);
});

test('summaries do not mutate rows, marks or source measurements', () => {
  const rows = fixture().map(Object.freeze), marks = marksFor(rows), configuration = options({ repeatedQuestionsToPerson: Object.freeze(measured(2)) });
  Object.freeze(rows); Object.freeze(configuration);
  const before = JSON.stringify(rows), markBefore = [...marks];
  summarize(rows, marks, configuration);
  assert.equal(JSON.stringify(rows), before); assert.deepEqual([...marks], markBefore);
});

test('the same model loads as a browser global without Node or DOM access', () => {
  const context = vm.createContext({ NativeButlerReviewPolicy: policy });
  vm.runInContext(fs.readFileSync(require.resolve('../renderer/butler-review-model.js'), 'utf8'), context);
  const api = context.nativeWorkspaceButlerReviewModel;
  assert.equal(api.MIN_REAL_SUGGESTIONS, 10);
  const s = api.summarize(fixture(), new Set(), options());
  assert.equal(s.denominator, 3); assert.equal(s.agreed, 3); assert.equal(s.realSamples, 3);
});

test('nine and ten real distinct suggestions retain numeric readings without an automatic verdict', () => {
  for (const count of [9, 10]) {
    const rows = Array.from({ length: count }, (_, i) => row('occurrence-' + i, 'suggestion-' + i));
    const s = summarize(rows, new Set(), options());
    assert.equal(s.realSamples, count); assert.equal(s.denominator, count); assert.equal(s.agreed, count);
    assert.equal(s.minimumSamples, 10); assert.equal('passed' in s, false); assert.equal('verdict' in s, false);
    assert.equal(s.realSamples < s.minimumSamples, count === 9);
  }
});

test('audit and synthetic samples never become real working-day sample counts', () => {
  for (const sampleKind of ['audit', 'synthetic', 'real']) {
    const s = summarize(fixture(), new Set(), options({ sampleKind, synthetic: sampleKind === 'synthetic' }));
    assert.equal(s.denominator, 3); assert.equal(s.realSamples, sampleKind === 'real' ? 3 : 0);
    assert.equal(s.sampleKind, sampleKind);
  }
  assert.throws(() => summarize([], new Set(), options({ sampleKind: undefined })), /sample kind/);
  assert.throws(() => summarize([], new Set(), options({ sampleKind: 'audit', synthetic: true })), /match/);
});

test('browser arithmetic uses the supplied shared policy rather than a copied threshold', () => {
  let supplied;
  const context = vm.createContext({ NativeButlerReviewPolicy: { MIN_REVIEW_SUGGESTIONS: 17, agreementSummary(value) { supplied = value; return { status: 'shared-policy-result' }; } } });
  vm.runInContext(fs.readFileSync(require.resolve('../renderer/butler-review-model.js'), 'utf8'), context);
  const s = context.nativeWorkspaceButlerReviewModel.summarize(fixture(), new Set(), options());
  assert.equal(s.minimumSamples, 17); assert.equal(s.quality.status, 'shared-policy-result');
  assert.deepEqual(JSON.parse(JSON.stringify(supplied)), { distinctSuggestions: 3, agreedSuggestions: 3, confirmed: true });
});
