'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const gate = require('../../scripts/check-install-state.cjs');
const frame = { x: 20, y: 40, width: 1200, height: 800 }, box = { x: 0, y: 940, width: 500, height: 500 };
const proven = [{ bounds: box, basis: 'outside-electron' }], unproven = [{ bounds: box, basis: 'unproven' }];
function pair(before, after) {
  const expected = { version: '0.1.0-alpha.999', revision: 'a'.repeat(40) };
  const base = { profile: '/synthetic', gui: { pid: 100, started: 'before' }, views: [{ owner: 'owner', bounds: { ...frame } }], windows: [{ onScreen: true, bounds: { ...frame } }],
    bundle: { ...expected, runtimeHash: 'b'.repeat(16) }, backend: { key: 'old', ...expected, runtimeHash: 'b'.repeat(16), evidence: 'active-key+live-lock+runtime-source' },
    dsh: { status: 'qualified', digest: 'same' }, inferredMenuWindows: [] };
  const pre = { ...structuredClone(base), ...(before === undefined ? {} : { offscreenWindows: before }) };
  return { pre, post: { ...structuredClone(base), gui: { pid: 101, started: 'after' }, offscreenWindows: after }, expected };
}
const row = rows => rows.find(r => r[0].startsWith('offscreen windows outside Electron'));
test('install keeps one system window outside Electron when the count is unchanged', () => {
  for (const before of [unproven, proven]) {
    const { pre, post, expected } = pair(before, proven);
    assert.equal(row(gate.compare(pre, post, expected))[3], true);
  }
  const { pre, post, expected } = pair([], []);
  assert.equal(row(gate.compare(pre, post, expected))[3], true);
});
test('a changed count, an old GUI after install, or no row at all refuses', () => {
  for (const [name, before, after] of [['one appears after install', [], proven], ['old snapshot without the field', undefined, proven],
    ['one disappears after install', unproven, []], ['post GUI without the Electron list', unproven, unproven]]) {
    const { pre, post, expected } = pair(before, after);
    assert.equal(row(gate.compare(pre, post, expected))[3], false, name);
  }
});
test('post fails on the offscreen row before running the worker gate', async () => {
  const { pre, post, expected } = pair([], proven); let calls = 0;
  const result = await gate.post(pre, () => post, expected, async () => calls++, { minimumMs: 0, quietMs: 0 });
  assert.equal(result.ok, false); assert.equal(calls, 0);
  post.offscreenWindows = []; assert.equal((await gate.post(pre, () => post, expected, async () => calls++, { minimumMs: 0, quietMs: 0 })).ok, true);
});
test('offscreen rows are strict: at most one, a known basis and a real rectangle', () => {
  assert.deepEqual(gate.offscreenInference(proven), proven);
  for (const bad of [[...proven, ...proven], [{ bounds: box, basis: 'menu' }], [{ bounds: { ...box, width: 0 }, basis: 'unproven' }],
    [{ bounds: box, basis: 'unproven', id: 1071 }], [{ basis: 'unproven' }], 'unproven', null]) assert.throws(() => gate.offscreenInference(bad));
});
