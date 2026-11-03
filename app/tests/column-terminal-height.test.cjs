// T-135: the rules for a grid column's terminal height, run from the renderer's own functions.
// Layout (the limits) and the native fit are stubs; the GUI check covers them.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const renderer = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
const start = renderer.indexOf('function columnTerminalHeight('), end = renderer.indexOf('function columnTerminalSash(');
assert.ok(start > 0 && end > start);
function harness(limits = { min: 64, max: 400 }) {
  const calls = { persist: 0, fit: [], reveal: 0 };
  const context = vm.createContext({
    COLUMN_TERMINAL: { initial: 112, min: 64, most: 4000, step: 16, conversation: 80 }, columnTerminalHeights: {},
    columnTerminalLimits: () => limits, attempt: action => action(), persistView: () => { calls.persist++; },
    fitTerminal: id => calls.fit.push(id), revealTerminalCursor: () => { calls.reveal++; }, terminals: new Map(),
  });
  vm.runInContext(renderer.slice(start, end), context);
  const binding = { id: 'naw-a', nativeHost: { style: {} }, nativeSash: { attributes: {}, setAttribute(k, v) { this.attributes[k] = v; } } };
  return { context, binding, calls, limits };
}
test('a person\'s change keeps to the limits, is remembered and fits the native terminal once', () => {
  const { context, binding, calls } = harness();
  assert.equal(context.applyColumnTerminalHeight(binding, 900, 'adjust'), 400); assert.deepEqual(calls.fit, []); assert.deepEqual({ ...context.columnTerminalHeights }, {});
  assert.equal(context.applyColumnTerminalHeight(binding, 10, 'save'), 64);
  assert.equal(binding.nativeHost.style.height, '64px'); assert.equal(binding.resizeAllowed, true); assert.deepEqual(calls.fit, ['naw-a']); assert.equal(calls.persist, 1);
  assert.deepEqual({ ...context.columnTerminalHeights }, { 'naw-a': 64 });
  assert.deepEqual(binding.nativeSash.attributes, { 'aria-valuemin': '64', 'aria-valuemax': '400', 'aria-valuenow': '64' });
});
test('a redraw shows the remembered height, lowered to what fits but not below 112px, without a native resize', () => {
  const { context, binding, calls, limits } = harness({ min: 64, max: 90 });
  context.columnTerminalHeights['naw-a'] = 300;
  assert.equal(context.applyColumnTerminalHeight(binding, context.columnTerminalHeight('naw-a')), 112, 'a small window keeps the old default height');
  assert.equal(binding.nativeSash.attributes['aria-valuemax'], '112');
  limits.max = 250; assert.equal(context.applyColumnTerminalHeight(binding, 300), 250); assert.equal(calls.reveal, 1, 'a changed box keeps the cursor in view');
  limits.max = 500; assert.equal(context.applyColumnTerminalHeight(binding, 300), 300);
  assert.equal(context.applyColumnTerminalHeight(binding, 70), 70, 'a chosen small height is kept');
  assert.equal(binding.resizeAllowed, undefined); assert.deepEqual(calls.fit, []); assert.equal(calls.persist, 0);
  assert.equal(context.columnTerminalHeights['naw-a'], 300, 'a redraw never changes what the person chose');
  assert.equal(context.columnTerminalHeight('missing'), 112); context.columnTerminalHeights.bad = 12.5; assert.equal(context.columnTerminalHeight('bad'), 112);
});
test('in a window too small for 112px, a person\'s change upward never makes the terminal shorter', () => {
  const { context, binding, calls } = harness({ min: 64, max: 90 });
  assert.equal(context.applyColumnTerminalHeight(binding, 112), 112);
  assert.equal(context.applyColumnTerminalHeight(binding, 128, 'save'), 112, 'ArrowUp at the old default stays there');
  assert.equal(binding.nativeSash.attributes['aria-valuemax'], '112'); assert.equal(context.columnTerminalTallest(binding), 112);
  assert.equal(context.applyColumnTerminalHeight(binding, 96, 'save'), 96); assert.deepEqual(calls.fit, ['naw-a', 'naw-a']);
});
test('at most 200 heights are kept, dropping the least recently changed', () => {
  const { context } = harness();
  for (let i = 0; i < 199; i++) context.columnTerminalHeights['s' + i] = 100;
  context.rememberColumnTerminalHeight('s0', 120);
  for (const id of ['new-1', 'new-2', 'new-3', 'new-4']) context.rememberColumnTerminalHeight(id, 128);
  const ids = Object.keys(context.columnTerminalHeights);
  assert.equal(ids.length, 200); assert.ok(!('s1' in context.columnTerminalHeights) && !('s3' in context.columnTerminalHeights));
  assert.equal(context.columnTerminalHeights.s0, 120, 's0 was changed recently, so it stays'); assert.deepEqual(ids.slice(-5), ['s0', 'new-1', 'new-2', 'new-3', 'new-4']);
});
