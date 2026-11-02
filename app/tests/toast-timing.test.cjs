// T-128: a notice with an action keeps no time limit, but any press that is not
// on one of its own buttons ends it, on the notice or anywhere else. Plain
// notices are unchanged (6.5 s).
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
const part = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));
const code = part('function toast(', 'function sessionNotice(') + '\n' + part('// T-128: a notice with an action keeps no time limit', 'async function attempt(');
function fixture() {
  let now = 0, timers = [], seq = 0, action = null;
  const documentListeners = {};
  class Element { constructor(id, isButton = false) { this.id = id; this.isButton = isButton; } closest(selector) { return selector === 'button' && this.isButton ? this : null; } }
  const body = new Element('body'), outside = new Element('continue-native', true), text = new Element('toast-text'), close = new Element('toast-close', true);
  close.focus = () => { document.activeElement = close; };
  const document = { activeElement: body, addEventListener: (type, fn) => { (documentListeners[type] ||= []).push(fn); } };
  const toast = new Element('toast'); Object.assign(toast, { hidden: true,
    contains: el => el === toast || el === text || el === close || el === action,
    querySelector: () => action, insertBefore: el => { action = el; } });
  const button = (label, run) => { const el = new Element('toast-action', true); Object.assign(el, { label, isConnected: true, setAttribute() {}, remove() { el.isConnected = false; if (action === el) action = null; }, click: run }); return el; };
  const context = vm.createContext({ document, button, Element,
    $: id => ({ toast, 'toast-text': text, 'toast-close': close })[id],
    setTimeout: (fn, ms) => { const id = ++seq; timers.push({ id, at: now + ms, fn }); return id; },
    clearTimeout: id => { timers = timers.filter(t => t.id !== id); } });
  vm.runInContext('let toastTimer;\n' + code + '\nthis.toast = toast;', context);
  const advance = ms => { now += ms; for (const t of timers.filter(t => t.at <= now)) { timers = timers.filter(x => x !== t); t.fn(); } };
  return { context, toast, text, close, outside, advance, action: () => action,
    press: target => (documentListeners.pointerdown || []).forEach(fn => fn({ target })) };
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
