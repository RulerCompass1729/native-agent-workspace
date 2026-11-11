'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const nodePolicy = require('../butler-review-policy.js');
const source = fs.readFileSync(path.join(__dirname, '../butler-review-policy.js'), 'utf8');
const browser = { window: {} };
vm.runInNewContext(source, browser, { filename: 'butler-review-policy.js' });
const browserPolicy = browser.window.NativeButlerReviewPolicy;
const summary = (policy, distinctSuggestions, agreedSuggestions, confirmed = true) =>
  policy.agreementSummary({ distinctSuggestions, agreedSuggestions, confirmed });
const local = result => ({ ...result });

test('Node and browser export one frozen policy and the same minimum sample count', () => {
  assert.equal(nodePolicy.MIN_REVIEW_SUGGESTIONS, 10);
  assert.equal(browserPolicy.MIN_REVIEW_SUGGESTIONS, nodePolicy.MIN_REVIEW_SUGGESTIONS);
  for (const policy of [nodePolicy, browserPolicy]) {
    assert.equal(Object.isFrozen(policy), true);
    assert.deepEqual(Object.keys(policy).sort(), ['MIN_REVIEW_SUGGESTIONS', 'agreementSummary']);
    assert.throws(() => { policy.MIN_REVIEW_SUGGESTIONS = 0; }, TypeError);
    assert.equal(policy.MIN_REVIEW_SUGGESTIONS, 10);
  }
});

for (const [name, policy] of [['Node', nodePolicy], ['browser', browserPolicy]]) {
  test(`${name}: zero through nine distinct suggestions stay insufficient even when confirmed`, () => {
    for (const n of [0, 1, 9]) for (const confirmed of [false, true]) {
      assert.deepEqual(local(summary(policy, n, n, confirmed)), {
        status: 'insufficient-samples', agreementRate: null, agreementMeetsThreshold: null });
    }
  });
  test(`${name}: ten samples still need explicit confirmation before any agreement conclusion`, () => {
    for (const n of [10, 100]) for (const agree of [0, n]) {
      assert.deepEqual(local(summary(policy, n, agree, false)), {
        status: 'unreviewed', agreementRate: null, agreementMeetsThreshold: null });
    }
  });
  test(`${name}: confirmed ten-sample agreement separates nine of ten from eight of ten`, () => {
    assert.deepEqual(local(summary(policy, 10, 9)), { status: 'reviewed', agreementRate: 0.9, agreementMeetsThreshold: true });
    assert.deepEqual(local(summary(policy, 10, 8)), { status: 'reviewed', agreementRate: 0.8, agreementMeetsThreshold: false });
    assert.deepEqual(local(summary(policy, 10, 0)), { status: 'reviewed', agreementRate: 0, agreementMeetsThreshold: false });
    assert.deepEqual(local(summary(policy, 10, 10)), { status: 'reviewed', agreementRate: 1, agreementMeetsThreshold: true });
  });
  test(`${name}: the nine-tenths threshold stays exact at safe-integer limits`, () => {
    const n = Number.MAX_SAFE_INTEGER, firstPassing = Number((BigInt(n) * 9n + 9n) / 10n);
    assert.equal(summary(policy, n, firstPassing).agreementMeetsThreshold, true);
    assert.equal(summary(policy, n, firstPassing - 1).agreementMeetsThreshold, false);
    assert.equal(summary(policy, n, n).agreementRate, 1);
    assert.equal(summary(policy, 20, 18).agreementMeetsThreshold, true);
    assert.equal(summary(policy, 20, 17).agreementMeetsThreshold, false);
  });
  test(`${name}: invalid counts and non-Boolean confirmation never produce a summary`, () => {
    for (const bad of [undefined, null, false, true, '10', NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, 10n]) {
      assert.throws(() => summary(policy, bad, 0));
      assert.throws(() => summary(policy, 10, bad));
    }
    assert.throws(() => summary(policy, 10, 11));
    for (const confirmed of [undefined, null, 0, 1, 'true', {}, new Boolean(true)]) {
      assert.throws(() => policy.agreementSummary({ distinctSuggestions: 10, agreedSuggestions: 9, confirmed }));
    }
    for (const bad of [undefined, null, [], 10, 'counts', {}, () => {}]) assert.throws(() => policy.agreementSummary(bad));
  });
  test(`${name}: the arithmetic exposes no overall acceptance or activation decision`, () => {
    const result = summary(policy, 10, 9);
    assert.deepEqual(Object.keys(result).sort(), ['agreementMeetsThreshold', 'agreementRate', 'status']);
    assert.equal(Object.hasOwn(result, 'passed'), false); assert.equal(Object.hasOwn(result, 'activation'), false);
    assert.equal(Object.hasOwn(result, 'repeatedQuestions'), false);
  });
}
