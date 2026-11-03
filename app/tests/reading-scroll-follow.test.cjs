// T-134: the real reading-view wheel and key handlers, with a stubbed element.
// While following, moving toward the latest neither ends following nor drops the
// render guard (pageChanging); moving away ends it, as before.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function harness() {
  const frames = [], saved = [], clock = { now: 10000 };
  const element = () => ({ hidden: false, dataset: {}, append() {}, onclick: null });
  const context = vm.createContext({
    Map, Set, Object, Number, Math, JSON, structuredClone, performance: { now: () => clock.now },
    window: { getSelection: () => ({ isCollapsed: true }) }, document: { activeElement: null },
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; }, cancelAnimationFrame() {},
    ResizeObserver: class { observe() {} disconnect() {} },
    button: (text, onclick) => ({ ...element(), text, onclick }), node: () => element(),
    ui: { clearMarkdown() {} }, api: { readingState: positions => saved.push(JSON.parse(JSON.stringify(positions))) }, attempt: fn => fn(),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/reading-list.js'), 'utf8'), context);
  const listeners = {}, documentListeners = {}, row = { closest: selector => selector === '[data-message-id]' ? row : null };
  const el = {
    scrollTop: 0, scrollHeight: 3000, clientHeight: 500, isConnected: true, attrs: {}, tabIndex: -1,
    hasAttribute(name) { return name in this.attrs; }, setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener(type, fn) { listeners[type] = fn; }, removeEventListener() {}, replaceChildren() {},
    getClientRects: () => [{}], getBoundingClientRect: () => ({ top: 0, bottom: 500, left: 0, right: 400 }), querySelectorAll: () => [],
    contains: node => node === row,
    ownerDocument: { addEventListener(type, fn) { documentListeners[type] = fn; }, removeEventListener() {} },
  };
  const view = vm.runInContext('readingView', context)(el, 'session-a');
  view.pageRange = { start: 0, end: 1, tail: true }; // a rendered list whose last page is loaded
  view.seen = { top: 2500, height: 3000 }; el.scrollTop = 2500; // its last frame left it at the end
  return { context, view, el, listeners, documentListeners, frames, saved, row, clock };
}
test('while following, a wheel-down, ArrowDown, PageDown or Space keeps following and the render guard', () => {
  const target = { closest: () => null };
  for (const input of [{ type: 'wheel', deltaY: 120 }, { type: 'keydown', key: 'ArrowDown', target }, { type: 'keydown', key: 'PageDown', target }, { type: 'keydown', key: ' ', target }]) {
    const h = harness(), following = h.view.intent; h.view.pageChanging = true;
    h.listeners[input.type](input);
    assert.strictEqual(h.view.intent, following, input.type + ' ' + (input.key || input.deltaY) + ' keeps the same following intent');
    assert.equal(h.view.pageChanging, true, 'the render guard stays until the follow frame');
  }
});
test('moving away ends following as before: wheel-up, ArrowUp, PageUp, Home and Shift+Space', () => {
  const target = { closest: () => null };
  for (const input of [{ type: 'wheel', deltaY: -120 }, { type: 'keydown', key: 'ArrowUp', target }, { type: 'keydown', key: 'PageUp', target }, { type: 'keydown', key: 'Home', target, preventDefault() {} }, { type: 'keydown', key: ' ', shiftKey: true, target }]) {
    const h = harness(); h.view.pageChanging = true;
    h.listeners[input.type](input);
    assert.equal(h.view.intent, null, (input.key || input.deltaY) + ' ends following'); assert.equal(h.view.pageChanging, false);
  }
});
test('a key typed in an editable field inside the reader is not a move toward the latest', () => {
  const h = harness(); h.listeners.keydown({ type: 'keydown', key: ' ', target: { closest: selector => selector.includes('textarea') ? {} : null } });
  assert.equal(h.view.intent, null);
});
test('not following, a wheel-down is the person reading, as before', () => {
  const h = harness(); h.view.intent = { position: { top: 900, follow: false, anchor: 'row-1', offset: 0 } };
  h.listeners.wheel({ type: 'wheel', deltaY: 120 });
  assert.equal(h.view.intent, null);
});
test('the following-render guard steps aside while the person moves away, and returns after', () => {
  const h = harness(), guard = () => h.context.followRenderGuard(h.view, h.clock.now);
  assert.equal(guard(), true, 'following with no input: guard');
  h.listeners.keydown({ type: 'keydown', key: 'PageUp', target: { closest: () => null } });
  h.clock.now += 300; assert.equal(guard(), false, 'within 500ms of PageUp: no guard');
  h.clock.now += 300; assert.equal(guard(), true, 'after 500ms: guard again');
  h.listeners.wheel({ type: 'wheel', deltaY: -80 }); assert.equal(guard(), false, 'a wheel-up steps it aside too');
  const p = harness(), held = () => p.context.followRenderGuard(p.view, p.clock.now);
  p.listeners.pointerdown({ target: p.el, clientX: 395 }); assert.equal(held(), false, 'a held pointer on the reader itself (its scrollbar): no guard');
  p.documentListeners.pointerup(); assert.equal(held(), true, 'released: guard again, so a click on a row keeps following');
  p.listeners.pointerdown({ target: p.el, clientX: 395 }); p.listeners.pointermove({ buttons: 0 }); assert.equal(held(), true, 'a move with no button ends a hold whose release was missed');
});
test('a press on a row or button inside the reader keeps the guard, so a click on 复制 keeps following', () => {
  const h = harness();
  h.listeners.pointerdown({ target: h.row, clientX: 100 }); assert.equal(h.context.followRenderGuard(h.view, h.clock.now), true);
});
test('a scrollbar drag let go within 80px of the end starts following; let go far away it does not', () => {
  const h = harness(); h.el.scrollTop = 1200; h.listeners.pointerdown({ target: h.el, clientX: 395 });
  h.view.intent = { position: { top: 1200, follow: false, anchor: '', offset: 0 } }; // a render during the drag
  h.el.scrollTop = 2460; h.documentListeners.pointerup();
  assert.equal(h.view.intent?.position.follow, true); assert.equal(vm.runInContext('readingPositions', h.context)['session-a'].follow, true, 'saved as following');
  const far = harness(); far.listeners.pointerdown({ target: far.el, clientX: 395 }); far.el.scrollTop = 1500; far.documentListeners.pointerup();
  assert.equal(far.view.intent, null);
  const row = harness(); row.listeners.pointerdown({ target: row.row, clientX: 100 }); row.el.scrollTop = 2460; row.documentListeners.pointerup();
  assert.equal(row.view.intent, null, 'a release after a row press changes nothing');
});
test('a frame that finds no intent clears the following-render guard', () => {
  const h = harness(); h.context.scheduleReading(h.view); assert.equal(h.frames.length, 1);
  h.view.intent = null; h.view.pageChanging = true; h.frames.shift()();
  assert.equal(h.view.pageChanging, false);
});
test('a press in the padding or gaps of the reader is not a scrollbar hold', () => {
  const h = harness(); h.listeners.pointerdown({ target: h.el, clientX: 200 });
  assert.equal(h.context.followRenderGuard(h.view, h.clock.now), true);
});
test('a missed release cleared by a pointer move applies the same release rule', () => {
  const h = harness(); h.el.scrollTop = 1200; h.listeners.pointerdown({ target: h.el, clientX: 395 });
  h.el.scrollTop = 2460; h.listeners.pointermove({ buttons: 0 });
  assert.equal(h.view.intent?.position.follow, true); assert.equal(h.view.pointerHeld, false);
});
test('a press on a row inside the scrollbar strip, as on a 复制 button at its edge, keeps the guard', () => {
  const h = harness(); h.listeners.pointerdown({ target: h.row, clientX: 395 });
  assert.equal(h.context.followRenderGuard(h.view, h.clock.now), true);
});
test('a press in the padding let go near the end does not start following', () => {
  const h = harness(); h.el.scrollTop = 1200; h.listeners.pointerdown({ target: h.el, clientX: 200 });
  h.el.scrollTop = 2460; h.documentListeners.pointerup();
  assert.equal(h.view.intent, null);
});
test('the content key is equal for the same rows drawn again, and changes when a row a render draws changes', () => {
  const { context } = harness(), key = rows => context.readingContentKey(rows);
  const rows = [{ id: 'a', role: 'assistant', text: 'Hello', status: 'complete' }, { id: 'b', role: 'tool', kind: 'tool', title: 'Bash', input: 'ls', status: 'running' }];
  assert.equal(key(structuredClone(rows)), key(rows), 'a fresh copy of the same rows (each state update) is unchanged');
  for (const change of [r => { r[0].text += ' world'; }, r => { r[1].status = 'complete'; }, r => { r[0].images = [{ pending: true }]; }, r => { r.push({ id: 'c', role: 'assistant', text: '' }); }, r => { r[1].incomplete = true; }]) {
    const next = structuredClone(rows); change(next); assert.notEqual(key(next), key(rows));
  }
});
