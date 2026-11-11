'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { summarizeUsage } = require('../butler-usage.cjs');
const { ButlerController } = require('../butler-controller.cjs');
const { ButlerLedger } = require('../butler-ledger.cjs');

const today = Date.UTC(2026, 10, 11, 12), yesterday = today - 86400000;
const snapshot = (attempts = [], batches = []) => ({ attempts, batches });
const attempt = (batchId, usage, startedAt = today, number = 1) => ({ batchId, attempt: number, startedAt, usage });
const legacy = (batchId, usage, completedAt = today, status = 'completed') => ({ batchId, status, completedAt, result: { usage } });
const sum = value => summarizeUsage(value, { now: today });
const selection = { budget: { currency: 'USD', dayBoundary: 'UTC', limitMicros: 100 } };
function budget(value, { selected = selection, estimate = 1, now = () => today } = {}) {
  return ButlerController.prototype.budgetReady.call({ ledger: { snapshot: () => value }, now, estimateBatchCost: () => estimate }, selected, []);
}

test('empty healthy ledger readings mean no recorded runs, without certifying provider request count', () => {
  const value = sum(snapshot());
  assert.equal(value.utcDay, '2026-11-11'); assert.equal(value.asOf, today);
  assert.equal(value.today.recordedRunCount, 0); assert.equal(value.today.providerRequestCount, null);
  assert.equal(value.today.attemptCount, 0); assert.equal(value.today.legacyBatchCount, 0);
  assert.deepEqual(value.today.costMicros, { value: 0, knownLowerBound: 0, unknownRuns: 0, overflow: false });
  for (const reading of Object.values(value.today.tokens)) assert.deepEqual(reading, { value: 0, knownLowerBound: 0, unknownRuns: 0, overflow: false });
  assert.deepEqual(value.guard, { reason: null, unknownAttempts: 0 });
});

test('a partial native usage record preserves each unknown token and never converts costUsd', () => {
  const value = sum(snapshot([attempt('partial', { costUsd: 0.0005, inputTokens: 7, outputTokens: null, source: 'native' })]));
  assert.deepEqual(value.today.costMicros, { value: null, knownLowerBound: 0, unknownRuns: 1, overflow: false });
  assert.equal(value.today.tokens.inputTokens.value, 7);
  for (const field of ['cachedInputTokens', 'outputTokens', 'totalTokens']) {
    assert.equal(value.today.tokens[field].value, null); assert.equal(value.today.tokens[field].unknownRuns, 1);
  }
  assert.equal(value.guard.reason, 'usage-cost-unknown');
  assert.deepEqual(value.today.sources, { values: ['native'], unknownRuns: 0 });
  assert.deepEqual(value.today.estimated, { yes: 0, no: 0, unknown: 1 });
});

test('known lower bounds survive mixed unknown records and source/estimate classifications remain explicit', () => {
  const value = sum(snapshot([
    attempt('one', { costMicros: 11, inputTokens: 10, cachedInputTokens: 4, outputTokens: 5, totalTokens: 15, source: 'native-a', estimated: false }),
    attempt('two', null),
    attempt('three', { costMicros: 9, inputTokens: 3, cachedInputTokens: 0, outputTokens: 2, totalTokens: 5, source: 'native-b', estimated: true })
  ]));
  assert.equal(value.today.recordedRunCount, 3); assert.equal(value.today.attemptCount, 3);
  assert.deepEqual(value.today.costMicros, { value: null, knownLowerBound: 20, unknownRuns: 1, overflow: false });
  assert.deepEqual(value.today.tokens.inputTokens, { value: null, knownLowerBound: 13, unknownRuns: 1, overflow: false });
  assert.deepEqual(value.today.sources, { values: ['native-a', 'native-b'], unknownRuns: 1 });
  assert.deepEqual(value.today.estimated, { yes: 1, no: 1, unknown: 1 });
  assert.equal(value.guard.unknownAttempts, 1);
});

test('attempt UTC start day governs runs that complete or report usage after midnight', () => {
  const beforeMidnight = Date.UTC(2026, 10, 10, 23, 59, 59, 999);
  const atMidnight = beforeMidnight + 1;
  const value = summarizeUsage(snapshot([
    attempt('old', { costMicros: 15, reportedAt: today }, beforeMidnight),
    attempt('new', { costMicros: 6 }, atMidnight)
  ], [legacy('old', { costMicros: 500 }, today)]), { now: atMidnight });
  assert.equal(value.today.recordedRunCount, 1); assert.equal(value.today.costMicros.value, 6);
  assert.equal(value.today.legacyBatchCount, 0);
  assert.equal(value.guard.reason, null);
});

test('historical unknown attempts keep the global guard blocked without poisoning known current-day sums', () => {
  const data = snapshot([attempt('old', null, yesterday), attempt('new', { costMicros: 5 })]);
  const value = sum(data);
  assert.equal(value.today.recordedRunCount, 1); assert.equal(value.today.costMicros.value, 5);
  assert.equal(value.today.costMicros.unknownRuns, 0);
  assert.deepEqual(value.guard, { reason: 'usage-cost-unknown', unknownAttempts: 1 });
  assert.equal(budget(data), 'usage-cost-unknown');
});

test('legacy completed batches use completion UTC day, exclude noncompleted records and dedupe any attempt coverage', () => {
  const data = snapshot([attempt('covered', { costMicros: 7 }, yesterday)], [
    legacy('covered', { costMicros: 800 }), legacy('legacy-today', { costMicros: 3, totalTokens: 4 }),
    legacy('old-unknown', null, yesterday), legacy('not-completed', { costMicros: 500 }, today, 'failed')
  ]);
  const value = sum(data);
  assert.equal(value.today.recordedRunCount, 1); assert.equal(value.today.attemptCount, 0); assert.equal(value.today.legacyBatchCount, 1);
  assert.equal(value.today.costMicros.value, 3); assert.equal(value.today.tokens.totalTokens.value, 4);
  assert.equal(value.guard.reason, null); assert.equal(budget(data), null);
  assert.equal(budget(snapshot([], [legacy('today-unknown', null)])), 'usage-cost-unknown');
});

test('all physical attempt records count irrespective of failed, late or quarantined batch status', () => {
  const data = snapshot([
    attempt('failed', { costMicros: 3 }), attempt('failed', { costMicros: 4 }, today, 2),
    attempt('quarantined', { costMicros: 5 }), attempt('stale-revision', { costMicros: 6 })
  ], [legacy('failed', { costMicros: 1000 }, today, 'failed'), legacy('quarantined', { costMicros: 1000 }, today, 'quarantined')]);
  const value = sum(data);
  assert.equal(value.today.recordedRunCount, 4); assert.equal(value.today.costMicros.value, 18);
  assert.equal(value.today.legacyBatchCount, 0);
});

test('cost overflow is invalid while token overflow cannot block an otherwise known monetary budget', () => {
  const costData = snapshot([attempt('a', { costMicros: Number.MAX_SAFE_INTEGER }), attempt('b', { costMicros: 1 })]);
  const costs = sum(costData);
  assert.deepEqual(costs.today.costMicros, { value: null, knownLowerBound: null, unknownRuns: 0, overflow: true });
  assert.equal(costs.guard.reason, 'usage-cost-invalid'); assert.equal(budget(costData), 'usage-cost-invalid');
  const tokenData = snapshot([
    attempt('a', { costMicros: 1, inputTokens: Number.MAX_SAFE_INTEGER }), attempt('b', { costMicros: 1, inputTokens: 1 })
  ]);
  const tokens = sum(tokenData);
  assert.equal(tokens.today.tokens.inputTokens.value, null); assert.equal(tokens.today.tokens.inputTokens.overflow, true);
  assert.equal(tokens.today.tokens.inputTokens.knownLowerBound, null); assert.equal(tokens.guard.reason, null);
  assert.equal(budget(tokenData), null);
});

test('monetary guard retains the original traversal precedence of unknown versus overflow', () => {
  const overflow = [attempt('a', { costMicros: Number.MAX_SAFE_INTEGER }), attempt('b', { costMicros: 1 })];
  const unknown = attempt('old', null, yesterday);
  for (const [attempts, reason] of [[[...overflow, unknown], 'usage-cost-invalid'], [[unknown, ...overflow], 'usage-cost-unknown']]) {
    const data = snapshot(attempts);
    assert.equal(sum(data).guard.reason, reason); assert.equal(budget(data), reason);
    assert.equal(sum(data).guard.unknownAttempts, 1, 'Readings still inspect all records after finding the first guard reason');
  }
});

test('budget and estimate authorization stays in the controller without introducing a reminder threshold', () => {
  assert.equal(budget(snapshot(), { selected: {} }), 'budget-unset');
  assert.equal(budget(snapshot(), { selected: { budget: { currency: 'EUR', dayBoundary: 'UTC', limitMicros: 100 } } }), 'budget-unset');
  assert.equal(budget(snapshot(), { estimate: null }), 'next-batch-cost-unknown');
  assert.equal(budget(snapshot([attempt('a', { costMicros: 99 })]), { estimate: 1 }), null);
  assert.equal(budget(snapshot([attempt('a', { costMicros: 99 })]), { estimate: 2 }), 'daily-budget-reached');
  assert.equal(budget(snapshot([attempt('a', { costMicros: 100 })])), 'daily-budget-reached');
  assert.equal(budget(snapshot([attempt('a', { costMicros: 2500000 })]), {
    selected: { budget: { currency: 'USD', dayBoundary: 'UTC', limitMicros: 3000000 } }
  }), null, 'A two-dollar reminder is not a new execution cap');
});

test('retry, selection handoff and restart preserve the same attempt accounting on the real ledger', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-usage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let clock = yesterday, serial = 0;
  const open = () => new ButlerLedger(directory, { now: () => clock, id: () => 'usage-' + ++serial });
  const ledger = open();
  const first = { selectionRevision: 1, identity: { sessionId: 'first', nativeId: 'first-native' }, runnerRef: 'runner' };
  const next = { selectionRevision: 2, identity: { sessionId: 'next', nativeId: 'next-native' }, runnerRef: 'runner' };
  ledger.ingest({ eventId: 'request', sourceRef: 'task', kind: 'request', payload: { text: 'Synthetic local verification' } });
  const batch = ledger.beginBatch(first); ledger.beginAttempt(batch.batchId, first);
  ledger.recordAttemptUsage(batch.batchId, first, { costMicros: 10, inputTokens: 2 }, 1);
  ledger.failBatch(batch.batchId, 'Synthetic failed attempt'); clock = today;
  ledger.rebindBatch(batch.batchId, first, next); ledger.retryBatch(batch.batchId, next);
  ledger.beginAttempt(batch.batchId, next); ledger.recordAttemptUsage(batch.batchId, next, { costMicros: 20, totalTokens: 3 }, 2);
  ledger.completeBatch(batch.batchId, next, { actions: [], usage: { costMicros: 999 } });
  const before = fs.readFileSync(ledger.file), value = sum(ledger.snapshot());
  assert.equal(value.today.recordedRunCount, 1); assert.equal(value.today.costMicros.value, 20);
  assert.equal(value.today.tokens.totalTokens.value, 3); assert.equal(value.today.tokens.inputTokens.value, null);
  assert.deepEqual(sum(open().snapshot()), value);
  assert.deepEqual(fs.readFileSync(ledger.file), before, 'Readings are pure and do not reconcile or write usage');
});

test('usage reading is detached, ignores extra caller fields and rejects an unavailable snapshot', () => {
  const data = snapshot([attempt('a', { costMicros: 1, source: 'native', estimated: false, inputTokens: 2 })]);
  const before = structuredClone(data), value = sum(data);
  value.today.sources.values.push('caller'); value.today.tokens.inputTokens.value = 999;
  assert.deepEqual(data, before);
  assert.equal(sum(data).today.tokens.inputTokens.value, 2);
  assert.throws(() => sum({ attempts: [] }), TypeError);
  assert.throws(() => summarizeUsage(data, { now: NaN }), TypeError);
});
