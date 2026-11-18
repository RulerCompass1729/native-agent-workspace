const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const locale = require('./fixtures/locale-ui.cjs');
class Element {
  constructor() { this.children = []; this.attrs = new Map(); this.scrollTop = 180; this.isConnected = true; this.clientHeight = 0; }
  get firstChild() { return this.children[0]; }
  get nextSibling() { const siblings = this.parentElement?.children || []; return siblings[siblings.indexOf(this) + 1] || null; }
  insertBefore(child, before) { child.remove(); const i = before ? this.children.indexOf(before) : this.children.length; assert.ok(i >= 0); this.children.splice(i, 0, child); child.parentElement = this; }
  append(...children) { for (const child of children) this.insertBefore(child, null); }
  before(child) { this.parentElement.insertBefore(child, this); }
  remove() { if (this.parentElement) { this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; } }
  setAttribute(key, value) { this.attrs.set(key, String(value)); }
  getAttribute(key) { return this.attrs.get(key) ?? null; }
  hasAttribute(key) { return this.attrs.has(key); }
  removeAttribute(key) { this.attrs.delete(key); }
  addEventListener() {} removeEventListener() {} replaceChildren() { for (const child of [...this.children]) child.remove(); }
  getClientRects() { return []; }
}
function fixture(room = false) {
  const doc = { addEventListener() {}, removeEventListener() {} }, make = (_tag, _text, cls) => Object.assign(new Element(), { ownerDocument: doc, className: cls || '', dataset: {} });
  const parent = make(), el = make(); parent.append(el);
  const context = vm.createContext({ ...locale(), node: make, button: (_label, onclick, cls) => Object.assign(make('', '', cls), { onclick }), ui: { ...locale().ui, clearMarkdown() {} }, ResizeObserver: class { observe() {} disconnect() {} }, cancelAnimationFrame() {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/reading-list.js'), 'utf8'), context);
  const view = context.readingView(el, 'fixture', room); el.scrollTop = 180;
  return { context, parent, el, view };
}
test('a conversation keeps its exact scrolling element inside one persistent reading surface', () => {
  const f = fixture(); assert.equal(f.parent.children.length, 1); assert.equal(f.parent.firstChild.className, 'reading-surface');
  assert.equal(f.el.parentElement, f.view.readingSurface); assert.equal(f.view.readingSurface.children[0], f.el);
  assert.equal(f.view.jumpSlot.className, 'reading-slot'); assert.equal(f.view.jumpBar.parentElement, f.view.jumpSlot); assert.equal(f.el.scrollTop, 180);
  assert.equal(f.context.readingView(f.el, 'fixture'), f.view); assert.equal(f.parent.children.length, 1, 'redraw never nests another surface');
});
test('hiding the inner jump bar leaves the reserved slot mounted', () => {
  const f = fixture(); f.view.jumpBar.hidden = true;
  assert.ok(f.view.jumpSlot, 'there is a persistent slot'); assert.equal(f.view.jumpSlot.parentElement, f.view.readingSurface); assert.equal(f.view.jumpSlot.hidden, undefined);
});
test('disposing a conversation removes the slot and restores the original parent without moving its scroll position', () => {
  const f = fixture(); f.view.dispose(); assert.deepEqual(f.parent.children, [f.el]); assert.equal(f.el.scrollTop, 180);
  assert.equal(f.view.jumpBar.parentElement, null); assert.equal(f.view.jumpSlot.parentElement, null);
});
test('shared records retain their existing reading layout', () => {
  const f = fixture(true); assert.deepEqual(f.parent.children, [f.el]); assert.equal(f.view.jumpSlot, undefined);
});
