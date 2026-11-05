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

// Exercise the actual existing separator handlers, including screen geometry that differs by form/footer.
function sashHarness({ hidden = false, disjoint = false } = {}) {
  let creating;
  const map = new Map(), calls = { fit: [], persist: 0, toast: [], appends: [] };
  const root = { append(...nodes) { calls.appends.push('root'); }, getBoundingClientRect: () => ({ left: 20, right: 1000 }) };
  const make = (tag, text, cls) => {
    if (cls !== 'column-terminal-sash') return { style: {}, setAttribute() {}, offsetWidth: 220, offsetHeight: 49 };
    const binding = creating, handlers = new Map();
    return { attributes: {}, setAttribute(k, v) { this.attributes[k] = v; }, setPointerCapture() {}, matches: () => false,
      getBoundingClientRect: () => ({ top: binding.bottom - binding.terminalHeight, left: 0, width: 240, height: 8 }),
      closest: () => root,
      addEventListener(k, fn) { if (!handlers.has(k)) handlers.set(k, []); handlers.get(k).push(fn); },
      fire(k, args = {}) { const e = { pointerId: 1, button: 0, buttons: 1, clientY: 440, preventDefault() {}, stopPropagation() {}, ...args }; for (const fn of handlers.get(k) || []) fn(e); },
    };
  };
  const context = vm.createContext({
    COLUMN_TERMINAL: { initial: 112, min: 64, step: 16 }, columnTerminalHeights: {},
    columnTerminalLimits: b => ({ min: 64, max: b.limit }), node: make,
    fitTerminal: id => calls.fit.push(id), revealTerminalCursor() {}, terminals: new Map(),
    attempt: fn => fn(), persistView: () => calls.persist++, toastMessage: key => calls.toast.push(key),
    sessionComposers: map, document: { activeElement: null, body: { append() { calls.appends.push('body'); } } }, window: { innerWidth: 1000 }, uiText: () => 'Two-line hint', spaceId: 'original-space',
    memberMenuKey: () => context.spaceId + ':original-member-key',
    orderedMembers: () => context.people,
    columnTerminalBinding: id => map.get(id)?.nativeVisible ? map.get(id) : null,
  });
  context.people = ['a', 'b', 'c', 'd', ...(hidden ? ['chat'] : [])].map(id => ({ id }));
  const begin = renderer.indexOf('function columnTerminalHeight('), end = renderer.indexOf('// A smaller window', begin);
  vm.runInContext(renderer.slice(begin, end), context);
  context.actualShowHint = context.showColumnTerminalHint; context.showColumnTerminalHint = () => {}; context.hideColumnTerminalHint = () => {};
  const bs = [600, disjoint ? 2000 : 624, 600, 612], hs = [160, 120, 128, 112], limits = [400, 380, 360, 400];
  for (const [i, id] of ['a', 'b', 'c', 'd'].entries()) {
    creating = { id, bottom: bs[i], terminalHeight: hs[i], limit: limits[i], nativeVisible: true, nativeHost: { style: {} } };
    map.set(id, creating); context.columnTerminalHeights[id] = hs[i]; context.columnTerminalSash(creating);
  }
  return { context, map, calls, source: map.get('a'), heights: () => [...map.values()].map(b => b.terminalHeight), lines: () => [...map.values()].map(b => b.nativeSash.getBoundingClientRect().top) };
}
test('double-click aligns actual divider positions despite different forms and remembers hidden members without fitting them', () => {
  const h = sashHarness({ hidden: true }); h.source.nativeSash.fire('dblclick');
  assert.deepEqual(h.lines(), [440, 440, 440, 440]); assert.deepEqual(h.heights(), [160, 184, 160, 172]);
  assert.deepEqual(h.calls.fit, ['a', 'b', 'c', 'd']); assert.equal(h.calls.persist, 1);
  assert.equal(h.context.columnTerminalHeights.chat, 160); assert.equal(h.source.terminalDrag, null);
});
test('ordinary drag still changes one column while Shift drag adjusts all without fitting until one release', () => {
  const h = sashHarness(), a = h.source.nativeSash;
  a.fire('pointerdown'); a.fire('pointermove', { clientY: 424 }); a.fire('pointerup', { clientY: 424 });
  assert.deepEqual(h.heights(), [176, 120, 128, 112]); assert.equal(h.calls.persist, 1); assert.deepEqual(h.calls.fit, ['a']);
  h.calls.fit.length = 0; h.calls.persist = 0;
  a.fire('pointerdown', { shiftKey: true, clientY: 424 });
  for (const clientY of [410, 400, 384]) a.fire('pointermove', { clientY });
  assert.deepEqual(h.lines(), [384, 384, 384, 384]); assert.equal(h.calls.persist, 0); assert.deepEqual(h.calls.fit, []);
  a.fire('pointerup', { clientY: 384 }); a.fire('lostpointercapture', { clientY: 384 });
  assert.equal(h.calls.persist, 1); assert.deepEqual(h.calls.fit, ['a', 'b', 'c', 'd']);
});
test('group gestures abort before affecting a different space or changed membership', () => {
  for (const mutate of [h => { h.context.spaceId = 'other-space'; }, h => { h.context.people.pop(); }, h => { h.map.get('b').nativeVisible = false; }]) {
    const h = sashHarness(), old = h.heights(), a = h.source.nativeSash;
    a.fire('pointerdown', { shiftKey: true }); mutate(h); a.fire('pointermove', { clientY: 400 }); a.fire('pointerup', { clientY: 400 });
    assert.deepEqual(h.heights(), old); assert.equal(h.calls.persist, 0); assert.deepEqual(h.calls.fit, []);
  }
});
test('alignment uses a common feasible line rather than separately clamping and silently leaving lines apart', () => {
  const h = sashHarness(), a = h.source.nativeSash;
  a.fire('pointerdown', { shiftKey: true }); a.fire('pointermove', { clientY: -1000 }); a.fire('pointerup', { clientY: -1000 });
  assert.deepEqual(h.lines(), [244, 244, 244, 244]);
  for (const b of h.map.values()) assert.ok(b.terminalHeight >= 64 && b.terminalHeight <= b.limit);
  assert.equal(h.calls.persist, 1); assert.equal(h.calls.toast.at(-1), 'toast.terminalAlignLimited');
});
test('no common feasible line reports the limitation without partial alignment or native fit', () => {
  const h = sashHarness({ disjoint: true }), old = h.heights(); h.source.nativeSash.fire('dblclick');
  assert.deepEqual(h.heights(), old); assert.deepEqual(h.calls.fit, []); assert.equal(h.calls.persist, 0);
  assert.equal(h.calls.toast.at(-1), 'toast.terminalAlignUnavailable');
});
test('Enter has the same alignment action and arrows keep the original single-column behavior', () => {
  const h = sashHarness(); let prevented = 0, stopped = 0;
  h.source.nativeSash.fire('keydown', { key: 'Enter', preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
  assert.deepEqual(h.lines(), [440, 440, 440, 440]); assert.equal(prevented, 1); assert.equal(stopped, 1);
  h.source.nativeSash.fire('keydown', { key: 'ArrowUp' });
  assert.deepEqual(h.heights(), [176, 184, 160, 172]); assert.equal(h.calls.persist, 2);
});

test('the fixed overlay lives inside the existing DSH style scope rather than an unstyled body portal', () => {
  const h = sashHarness(); h.context.actualShowHint(h.source); assert.deepEqual(h.calls.appends, ['root']);
});

test('a mid-drag space, member or geometry change restores saved heights without fitting or persistence', () => {
  for (const mutate of [h => { h.context.spaceId = 'other'; }, h => { h.context.people.pop(); }, h => { h.map.get('b').bottom += 20; }]) {
    const h = sashHarness(), a = h.source.nativeSash, before = h.heights();
    a.fire('pointerdown', { shiftKey: true }); a.fire('pointermove', { clientY: 410 });
    assert.notDeepEqual(h.heights(), before, 'A real preview happened before the interruption');
    mutate(h); a.fire('pointermove', { clientY: 390 }); a.fire('pointerup', { clientY: 390 });
    assert.deepEqual(h.heights(), before); assert.deepEqual(h.calls.fit, []); assert.equal(h.calls.persist, 0);
    assert.equal(h.calls.toast.filter(k => k === 'toast.terminalAlignCancelled').length, 1);
    assert.equal(h.source.terminalDrag, null);
  }
});

test('rollback does not mutate a replacement binding after a preview', () => {
  const h = sashHarness(), a = h.source.nativeSash;
  a.fire('pointerdown', { shiftKey: true }); a.fire('pointermove', { clientY: 410 });
  const replacement = { ...h.map.get('b'), terminalHeight: 222 }; h.map.set('b', replacement);
  a.fire('pointermove', { clientY: 390 });
  assert.equal(replacement.terminalHeight, 222);
  assert.equal(h.map.get('a').terminalHeight, 160); assert.equal(h.map.get('c').terminalHeight, 128);
  assert.deepEqual(h.calls.fit, []); assert.equal(h.calls.persist, 0);
});
test('a hidden captured binding cannot carry an unsaved preview into its next mount', () => {
  const h = sashHarness(), a = h.source.nativeSash, b = h.map.get('b');
  a.fire('pointerdown', { shiftKey: true }); a.fire('pointermove', { clientY: 410 }); b.nativeVisible = false;
  a.fire('pointermove', { clientY: 390 }); assert.equal(b.terminalHeight, undefined);
  b.nativeVisible = true; h.context.applyColumnTerminalHeight(b, h.context.columnTerminalHeight('b'), 'adjust');
  assert.equal(b.terminalHeight, 120); assert.deepEqual(h.calls.fit, []); assert.equal(h.calls.persist, 0);
});
