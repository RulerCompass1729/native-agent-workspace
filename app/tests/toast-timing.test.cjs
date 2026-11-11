const localeUI = require('./fixtures/locale-ui.cjs');
// T-128: a notice with an action keeps no time limit, but any press that is not
// on one of its own buttons ends it, on the notice or anywhere else. Plain
// notices are unchanged (6.5 s).
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
const part = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));
const code = part('function toast(', 'function sessionNotice(') + '\n' + part('// T-128: a notice with an action keeps no time limit', 'async function attempt(');
function fixture() {
  let now = 0, timers = [], seq = 0, action = null; let reviewDisposals = 0;
  const documentListeners = {}, captures = new Map();
  class Element {
    setAttribute() {} removeAttribute() {}
    constructor(id, isButton = false) { this.id = id; this.isButton = isButton; this.isConnected = true; this.visible = true; }
    closest(selector) { return selector === 'button' && this.isButton ? this : null; }
    getClientRects() { return this.isConnected && this.visible ? [{}] : []; }
    focus(options) {
      const relatedTarget = document.activeElement; document.activeElement = this; this.focusOptions = options;
      for (const fn of documentListeners.focusin || []) fn({ target: this, relatedTarget });
    }
    blur() { if (document.activeElement === this) document.activeElement = body; }
  }
  const body = new Element('body'), outside = new Element('continue-native', true), text = new Element('toast-text'), close = new Element('toast-close', true);
  const document = { body, activeElement: body,
    addEventListener(type, fn, capture) { (documentListeners[type] ||= []).push(fn); captures.set(fn, capture === true); },
    removeEventListener(type, fn, capture) {
      if (captures.get(fn) !== (capture === true)) return;
      documentListeners[type] = (documentListeners[type] || []).filter(f => f !== fn); captures.delete(fn);
    },
  };
  const toast = new Element('toast'); Object.assign(toast, { hidden: true,
    contains: el => el != null && (el === toast || el === text || el === close || el === action),
    querySelector: () => action, insertBefore: el => { action = el; } });
  const button = (label, run) => { const el = new Element('toast-action', true); Object.assign(el, { label, isConnected: true, setAttribute() {}, remove() { el.isConnected = false; if (action === el) action = null; }, click: run }); return el; };
  const context = vm.createContext({ ...localeUI(), document, button, Element, mobileSetup: { dispose() {} }, butlerEntry: { dispose() {} }, disposeButlerReview() { reviewDisposals++; },
    $: id => ({ toast, 'toast-text': text, 'toast-close': close })[id],
    setTimeout: (fn, ms) => { const id = ++seq; timers.push({ id, at: now + ms, fn }); return id; },
    clearTimeout: id => { timers = timers.filter(t => t.id !== id); } });
  vm.runInContext('let toastTimer;\n' + code + '\nthis.toast = toast;', context);
  const advance = ms => { now += ms; for (const t of timers.filter(t => t.at <= now)) { timers = timers.filter(x => x !== t); t.fn(); } };
  return { context, toast, text, close, outside, body, document, documentListeners, advance, action: () => action, reviewDisposals: () => reviewDisposals,
    dispose() {
      // Exercise the actual renderer cleanup registry, without running its event callbacks.
      context.api = new Proxy({}, { get: () => () => () => {} }); context.updateLegacyProgress = () => {};
      const start = source.indexOf('const disposers = ['), end = source.indexOf('\n];', start) + 3;
      vm.runInContext(source.slice(start, end).replace('const disposers =', 'this.fixtureDisposers ='), context);
      context.fixtureDisposers.forEach(fn => fn());
    },
    focus: target => target.focus({ preventScroll: true }),
    press: target => (documentListeners.pointerdown || []).forEach(fn => fn({ target })),
    key(target, options = {}) {
      const event = { key: 'Escape', target, defaultPrevented: false, stopped: false,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; },
        stopImmediatePropagation() { this.stopped = true; this.immediate = true; }, ...options };
      // stopPropagation leaves other listeners on this same document phase running.
      for (const fn of documentListeners.keydown || []) if (captures.get(fn) && !event.immediate) fn(event);
      if (!event.stopped) target.onkeydown?.(event);
      if (!event.stopped) for (const fn of documentListeners.keydown || []) if (!captures.get(fn) && !event.immediate) fn(event);
      return event;
    },
  };
}
test('a plain notice still leaves after 6.5 s, and a press elsewhere does not end it early', () => {
  const f = fixture();
  f.context.toast('已复制'); f.press(f.outside); assert.equal(f.toast.hidden, false);
  f.advance(6499); assert.equal(f.toast.hidden, false); f.advance(1); assert.equal(f.toast.hidden, true);
});
test('a notice with an action keeps no time limit and survives presses on its own buttons', () => {
  const f = fixture();
  f.context.toast('已加入「Research」；原来的空间归属保留。', { label: '撤销加入', run() {} });
  f.advance(10 * 60 * 1000); assert.equal(f.toast.hidden, false); assert.equal(f.action().label, '撤销加入');
  f.press(f.action()); f.press(f.close); assert.equal(f.toast.hidden, false);
});
test('a press anywhere else, or on the notice text, ends a notice with an action', () => {
  for (const where of ['outside', 'text', 'toast']) {
    const f = fixture();
    f.context.toast('已加入「Research」；原来的空间归属保留。', { label: '撤销加入', run() {} });
    f.press(f[where]); assert.equal(f.toast.hidden, true, where);
    f.press(f.outside); assert.equal(f.toast.hidden, true, 'nothing brings it back');
  }
});
test('a newer plain notice replaces an action notice and its rules', () => {
  const f = fixture();
  f.context.toast('已加入', { label: '撤销加入', run() {} });
  f.context.toast('已复制'); assert.equal(f.action(), null);
  f.press(f.outside); assert.equal(f.toast.hidden, false, 'a plain notice is not ended by a press');
  f.advance(6500); assert.equal(f.toast.hidden, true);
});
test('Escape dismisses a notice without consuming the native or dialog key or moving outside focus', () => {
  for (const action of [undefined, { label: 'Undo', run() { throw Error('Escape must not activate Undo'); } }]) {
    const f = fixture(); let nativeKeys = 0;
    f.context.toast('Original notice', action); f.focus(f.outside);
    f.outside.onkeydown = event => { nativeKeys++; assert.equal(event.defaultPrevented, false); event.stopPropagation(); };
    f.key(f.outside);
    assert.equal(f.toast.hidden, true); assert.equal(nativeKeys, 1); assert.equal(f.document.activeElement, f.outside);
  }
});
test('Escape inside a notice consumes only that key and returns to the prior visible control', () => {
  const f = fixture(); let actions = 0, underlyingKeys = 0;
  f.context.toast('Joined', { label: 'Undo', run() { actions++; } });
  f.focus(f.outside); f.focus(f.action());
  f.document.addEventListener('keydown', () => { underlyingKeys++; });
  const event = f.key(f.action());
  assert.equal(f.toast.hidden, true); assert.equal(actions, 0); assert.equal(underlyingKeys, 0);
  assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true);
  assert.equal(f.document.activeElement, f.outside); assert.equal(f.outside.focusOptions.preventScroll, true);
});
test('replacing a focused action does not make the removed action the Escape return target', () => {
  const f = fixture(); f.context.toast('First', { label: 'Undo', run() {} });
  f.focus(f.outside); f.focus(f.action()); const old = f.action();
  f.context.toast('Second', { label: 'Open', run() {} }); assert.equal(f.document.activeElement, f.close);
  f.key(f.close); assert.equal(f.toast.hidden, true); assert.equal(old.isConnected, false);
  assert.equal(f.document.activeElement, f.outside);
});
test('Escape does not restore a removed or hidden control or swallow IME and modified keys', () => {
  for (const options of [{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { key: 'Enter' }, { defaultPrevented: true }]) {
    const f = fixture(); f.context.toast('Joined', { label: 'Undo', run() {} }); f.focus(f.outside);
    const event = f.key(f.outside, options); assert.equal(f.toast.hidden, false); assert.equal(event.stopped, false);
  }
  for (const missing of ['isConnected', 'visible']) {
    const f = fixture(); f.context.toast('Joined', { label: 'Undo', run() {} }); f.focus(f.outside); f.focus(f.close);
    f.outside[missing] = false; f.key(f.close);
    assert.equal(f.toast.hidden, true); assert.equal(f.document.activeElement, f.body);
  }
});
test('hidden or disposed toast keyboard handling leaves keys and focus alone', () => {
  const f = fixture(); f.focus(f.outside);
  const hidden = f.key(f.outside); assert.equal(hidden.defaultPrevented, false); assert.equal(hidden.stopped, false);
  f.context.toast('Joined', { label: 'Undo', run() {} });
  f.dispose(); f.key(f.outside); assert.equal(f.reviewDisposals(), 1);
  assert.equal(f.toast.hidden, false); assert.equal(f.document.activeElement, f.outside);
  assert.equal(f.documentListeners.keydown?.length || 0, 0); assert.equal(f.documentListeners.focusin?.length || 0, 0);
});
