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
test('a redraw shows the remembered height, lowered to what fits without a native resize', () => {
  const { context, binding, calls, limits } = harness({ min: 64, max: 90 });
  context.columnTerminalHeights['naw-a'] = 300;
  assert.equal(context.applyColumnTerminalHeight(binding, context.columnTerminalHeight('naw-a')), 90, 'a small window keeps the computed conversation allowance');
  assert.equal(binding.nativeSash.attributes['aria-valuemax'], '90');
  limits.max = 250; assert.equal(context.applyColumnTerminalHeight(binding, 300), 250); assert.equal(calls.reveal, 1, 'a changed box keeps the cursor in view');
  limits.max = 500; assert.equal(context.applyColumnTerminalHeight(binding, 300), 300);
  assert.equal(context.applyColumnTerminalHeight(binding, 70), 70, 'a chosen small height is kept');
  assert.equal(binding.resizeAllowed, undefined); assert.deepEqual(calls.fit, []); assert.equal(calls.persist, 0);
  assert.equal(context.columnTerminalHeights['naw-a'], 300, 'a redraw never changes what the person chose');
  assert.equal(context.columnTerminalHeight('missing'), 112); context.columnTerminalHeights.bad = 12.5; assert.equal(context.columnTerminalHeight('bad'), 112);
});
test('a person\'s change stays within a small window budget below the default height', () => {
  const { context, binding, calls } = harness({ min: 64, max: 90 });
  assert.equal(context.applyColumnTerminalHeight(binding, 112), 90);
  assert.equal(context.applyColumnTerminalHeight(binding, 128, 'save'), 90, 'An upward request cannot squeeze the conversation');
  assert.equal(binding.nativeSash.attributes['aria-valuemax'], '90'); assert.equal(context.columnTerminalTallest(binding), 90);
  assert.equal(context.applyColumnTerminalHeight(binding, 96, 'save'), 90); assert.deepEqual(calls.fit, ['naw-a', 'naw-a']);
});
test('the actual column budget reserves the conversation even when less than the old default fits', () => {
  const calls = { persist: 0, fit: [], reveal: 0 }, attributes = {};
  const nativeHost = { style: {}, get offsetHeight() { return Number.parseInt(this.style.height, 10) || 112; } };
  const reader = { clientHeight: 250, querySelector: () => ({ offsetHeight: 12 }) };
  // The hint under the input (T-163): two lines now; the column says how many it may show.
  const properties = {}, hint = { offsetHeight: 32 }, style = { getPropertyValue: key => properties[key] || '', setProperty: (key, value) => { properties[key] = value; } };
  const input = { closest: () => reader, querySelector: selector => selector === '.session-compose-hint' ? hint : null, style, get offsetHeight() { return nativeHost.offsetHeight + 68; } };
  const binding = { id: 'small', columnHost: input, nativeHost, nativeSash: { setAttribute(k, v) { attributes[k] = v; } } };
  const context = vm.createContext({
    COLUMN_TERMINAL: { initial: 112, min: 64, most: 4000, step: 16, conversation: 80 },
    columnTerminalHeights: { small: 300 }, attempt: action => action(), persistView: () => { calls.persist++; },
    fitTerminal: id => calls.fit.push(id), revealTerminalCursor: () => { calls.reveal++; }, terminals: new Map(),
  });
  const begin = renderer.indexOf('function columnTerminalLimits(');
  vm.runInContext(renderer.slice(begin, end), context);
  assert.equal(context.columnTerminalLimits(binding).max, 90);
  assert.equal(context.applyColumnTerminalHeight(binding, context.columnTerminalHeight('small')), 90);
  assert.equal(reader.clientHeight - input.offsetHeight - 12, 80, 'The redraw keeps the computed conversation allowance');
  assert.equal(attributes['aria-valuemax'], '90');
  // 250px column: 80 conversation, 64 terminal, 36 for the rest of the input without its hint, 12 footer: 58px, three lines.
  assert.equal(properties['--column-hint-lines'], '3', 'The hint may show the lines that fit beside the conversation and the smallest terminal');
  assert.equal(context.columnTerminalHeights.small, 300, 'The saved choice is not overwritten on redraw');
  assert.equal(calls.persist, 0); assert.deepEqual(calls.fit, []);
  reader.clientHeight = 500;
  assert.equal(context.applyColumnTerminalHeight(binding, context.columnTerminalHeight('small')), 300, 'More room restores the saved choice');
  assert.equal(calls.reveal, 1); assert.equal(calls.persist, 0); assert.deepEqual(calls.fit, []);
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

test('a remounted column restores its cursor only when the person is not reading older content', () => {
  let visible = true, reveals = 0;
  const parking = { append(el) { el.parentElement = this; } }, host = { append(el) { el.parentElement = this; } };
  const entry = { element: { parentElement: parking, hidden: true }, columnReading: false };
  const context = vm.createContext({ terminals: new Map([['a', entry]]),
    columnTerminalBinding: () => visible ? { nativeHost: host } : null,
    activeSessionId: () => 'a', selected: 'room', focusedRoomMember: () => false,
    terminalParking: parking, revealTerminalCursor: () => { reveals++; },
  });
  const begin = renderer.indexOf('function syncTerminalMount('), finish = renderer.indexOf('const queuedInputs', begin);
  assert.ok(begin > 0 && finish > begin); vm.runInContext(renderer.slice(begin, finish), context);
  context.syncTerminalMount('a'); assert.equal(reveals, 1); assert.equal(entry.element.hidden, false);
  context.syncTerminalMount('a'); assert.equal(reveals, 1, 'Passive redraw does not scroll an unchanged mount');
  visible = false; context.syncTerminalMount('a'); assert.equal(entry.element.hidden, true); assert.equal(reveals, 1);
  entry.columnReading = true; visible = true; context.syncTerminalMount('a');
  assert.equal(entry.element.hidden, false); assert.equal(reveals, 1, 'Reading an older native frame never jumps to the cursor');
});

test('a passive height clamp does not pull a person reading older native content to the cursor', () => {
  const { context, binding, calls, limits } = harness();
  const entry = { columnReading: true }; context.terminals.set(binding.id, entry);
  context.columnTerminalHeights[binding.id] = 300;
  context.applyColumnTerminalHeight(binding, 300);
  limits.max = 90; assert.equal(context.applyColumnTerminalHeight(binding, 300), 90);
  assert.equal(calls.reveal, 0, 'A smaller display keeps the explicit reading state');
  entry.columnReading = false; limits.max = 80;
  assert.equal(context.applyColumnTerminalHeight(binding, 300), 80); assert.equal(calls.reveal, 1, 'Cursor following still works when the person is not reading older output');
  assert.equal(context.columnTerminalHeights[binding.id], 300); assert.equal(calls.persist, 0); assert.deepEqual(calls.fit, []);
});


test('the actual overview measures column heights after its final header and shared-composer layout', () => {
  const { context, binding, limits, calls } = harness({ min: 64, max: 96 });
  const nodes = new Map();
  const element = id => { if (!nodes.has(id)) nodes.set(id, { hidden: false, setAttribute() {}, querySelector() { return element(id + ":child"); }, classList: { toggle() {} } }); return nodes.get(id); };
  Object.assign(context, {
    sessionComposers: new Map([[binding.id, binding]]), columnTerminalBinding: () => binding,
    document: { activeElement: null }, members: () => [], orderedMembers: () => [],
    focusedRoomMember: () => false, roomSurface: 'overview', disconnected: false,
    roomOverview: { toolbar: {}, update() { context.applyColumnTerminalHeight(binding, 112); } },
    renderHeaderLayout() { limits.max = 64; }, current: () => null, selected: 'room',
    // T-163: the header's row is fitted once the page has shown or hidden the overview's own controls in it.
    fitRoomTabs() { calls.fittedWithToolbar = context.roomOverview.toolbar.hidden; },
    $: element,
  });
  const refresh = renderer.indexOf('function fitColumnTerminalWidth(');
  if (refresh >= 0) vm.runInContext(renderer.slice(refresh, renderer.indexOf("window.addEventListener('resize'", refresh)), context);
  const begin = renderer.indexOf('function renderRoomOverview(');
  vm.runInContext(renderer.slice(begin, renderer.indexOf('const nativeUsable =', begin)), context);
  context.renderRoomOverview();
  assert.equal(binding.nativeHost.style.height, '64px', 'Late layout must replace the earlier 96px budget');
  assert.equal(calls.fittedWithToolbar, false, 'The header row is fitted after the layout controls are shown, not before');
  assert.equal(binding.terminalHeight, 64);
  assert.deepEqual(calls.fit, [], 'Passive layout never resizes the native grid');
  assert.equal(calls.persist, 0, 'Passive layout keeps the saved preference');
});


test('the existing resize observer clamps a late overview resize without fitting a private native grid', () => {
  const elements = new Map(), observed = [], fitted = []; let callback, refreshed = 0;
  const context = vm.createContext({
    ResizeObserver: class { constructor(fn) { callback = fn; } observe(el) { observed.push(el); } },
    $: id => { if (!elements.has(id)) elements.set(id, { id }); return elements.get(id); },
    activeSessionId: () => 'private', splitDragging: false,
    fitTerminal: id => fitted.push(id), refreshColumnTerminalHeights: () => { refreshed++; },
  });
  const line = renderer.split('\n').find(s => s.startsWith('const observer = new ResizeObserver('));
  vm.runInContext(line, context);
  assert.ok(observed.includes(elements.get('collaboration-overview')), 'Late container geometry needs the existing observer');
  callback([{ target: elements.get('collaboration-overview') }]);
  assert.equal(refreshed, 1); assert.deepEqual(fitted, [], 'An overview resize never fits another private native grid');
  callback([{ target: elements.get('terminal-area') }]);
  assert.equal(refreshed, 1); assert.deepEqual(fitted, ['private'], 'The original terminal-only fit remains');
});
