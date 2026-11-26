'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
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
test('after install, none or one window outside Electron with the v4 proof passes, whatever was there before', () => {
  for (const [name, before, after] of [['none before, one after (the 288 case)', [], proven], ['one before, one after', unproven, proven],
    ['proven before and after', proven, proven], ['none before or after', [], []], ['one disappears after install', unproven, []],
    ['old snapshot without the field', undefined, proven]]) {
    const { pre, post, expected } = pair(before, after);
    assert.equal(row(gate.compare(pre, post, expected))[3], true, name);
  }
});
test('after install, a window without the v4 proof refuses', () => {
  for (const before of [[], unproven, proven, undefined]) {
    const { pre, post, expected } = pair(before, unproven);
    assert.equal(row(gate.compare(pre, post, expected))[3], false, JSON.stringify(before));
  }
});
test('after install, two windows outside Electron refuse', async () => {
  const { pre, post, expected } = pair([], [...proven, ...proven]); let calls = 0;
  assert.throws(() => gate.compare(pre, post, expected), /frame 口径待核实/);
  await assert.rejects(gate.post(pre, () => post, expected, async () => calls++, { minimumMs: 0, quietMs: 0 }), /frame 口径待核实/);
  assert.equal(calls, 0);
});
test('post fails on the offscreen row before running the worker gate', async () => {
  const { pre, post, expected } = pair([], unproven); let calls = 0;
  const result = await gate.post(pre, () => post, expected, async () => calls++, { minimumMs: 0, quietMs: 0 });
  assert.equal(result.ok, false); assert.equal(calls, 0);
  post.offscreenWindows = proven; assert.equal((await gate.post(pre, () => post, expected, async () => calls++, { minimumMs: 0, quietMs: 0 })).ok, true);
});
test('background windows Electron already dropped do not count toward the one outside window (alpha.309, 11-26)', () => {
  const closed = Array.from({ length: 3 }, () => ({ bounds: { x: 660, y: 295, width: 1240, height: 850 }, basis: 'closed-background' }));
  for (const [name, after] of [['the window beside three closed ones', [...proven, ...closed]], ['closed ones only', closed],
    ['the most closed ones', [...proven, ...Array(64).fill(closed[0])]]]) {
    const { pre, post, expected } = pair([...unproven, ...closed], after);
    assert.equal(row(gate.compare(pre, post, expected))[3], true, name);
  }
  const { pre, post, expected } = pair([], [...unproven, ...closed]);
  assert.equal(row(gate.compare(pre, post, expected))[3], false, 'a window without the v4 proof still refuses');
  assert.equal(gate.offscreenInference(Array(64).fill(closed[0])).length, 64);
  for (const [name, bad] of [['two other windows', [...proven, ...proven, ...closed]], ['65 closed beside one', [...proven, ...Array(65).fill(closed[0])]],
    ['65 closed alone', Array(65).fill(closed[0])]]) assert.throws(() => gate.offscreenInference(bad), /frame 口径待核实/, name);
});
test('the closed background limit is the one install-electron-frames.py applies', () => {
  const python = fs.readFileSync(path.join(__dirname, '../../scripts/install-electron-frames.py'), 'utf8');
  assert.equal(Number(python.match(/^CLOSED_BACKGROUND_LIMIT = (\d+)$/m)?.[1]), gate.CLOSED_BACKGROUND_LIMIT);
});
test('offscreen rows are strict: at most one, a known basis and a real rectangle', () => {
  assert.deepEqual(gate.offscreenInference(proven), proven);
  for (const bad of [[...proven, ...proven], [{ bounds: box, basis: 'menu' }], [{ bounds: { ...box, width: 0 }, basis: 'unproven' }],
    [{ bounds: box, basis: 'unproven', id: 1071 }], [{ basis: 'unproven' }], 'unproven', null]) assert.throws(() => gate.offscreenInference(bad));
});
