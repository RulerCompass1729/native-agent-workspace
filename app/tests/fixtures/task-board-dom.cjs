const hover = require('../../renderer/sidebar-hover-card.js');
class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  fire(type, values = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...values };
    this['on' + type]?.(event); for (const fn of this.listeners.get(type) || []) fn(event); return event;
  }
}
class Element extends Events {
  constructor(tag, doc) {
    super(); this.tagName = tag.toUpperCase(); this.doc = doc; this.children = []; this.attributes = new Map(); this.dataset = {}; this.className = ''; this.hidden = false;
    this.style = { setProperty(name, value) { this[name] = value; } }; this.scrollTop = 0; this.value = ''; this._text = ''; this.popoverOpen = false;
    this.classList = { add: key => { if (!this.classList.contains(key)) this.className += ' ' + key; }, remove: key => { this.className = this.className.split(' ').filter(k => k !== key).join(' '); }, contains: key => this.className.split(' ').includes(key), toggle: (key, on) => on ? this.classList.add(key) : this.classList.remove(key) };
  }
  set textContent(value) { this._text = value; for (const e of this.children) e.parentElement = null; this.children = []; }
  get textContent() { return this._text + this.children.map(e => e.textContent).join(''); }
  append(...nodes) { for (const e of nodes) this.insertBefore(e, null); }
  insertBefore(e, before) { e.remove(); const i = before ? this.children.indexOf(before) : this.children.length; this.children.splice(i, 0, e); e.parentElement = this; }
  remove() { if (this.parentElement) { const p = this.parentElement; p.children.splice(p.children.indexOf(this), 1); this.parentElement = null; } }
  replaceChildren(...nodes) { this.textContent = ''; this.append(...nodes); }
  get firstElementChild() { return this.children[0]; }
  get lastElementChild() { return this.children.at(-1); }
  get options() { return this.children; }
  get isConnected() { return this === this.doc.body || Boolean(this.parentElement?.isConnected); }
  getRootNode() { return this.doc; }
  contains(node) { return node === this || this.children.some(e => e.contains(node)); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return key === 'id' ? this.id || null : key.startsWith('data-') ? this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] ?? null : this.attributes.get(key) ?? null; }
  hasAttribute(key) { return this.getAttribute(key) !== null; }
  removeAttribute(key) { this.attributes.delete(key); }
  matches(selector) {
    if (selector === ':popover-open') return Boolean(this.popoverOpen);
    if (selector === ':modal') return this.doc.modal === this && this.open;
    if (selector === 'dialog:modal') return this.tagName === 'DIALOG' && this.doc.modal === this && this.open;
    return selector.split(',').some(s => { s = s.trim(); if (s[0] === '.') return this.classList.contains(s.slice(1)); if (s[0] === '[') { const [, key, value] = s.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/); return value === undefined ? this.hasAttribute(key) : this.getAttribute(key) === value; } return this.tagName.toLowerCase() === s; });
  }
  querySelectorAll(selector) { return this.children.flatMap(e => [e, ...e.querySelectorAll('*')]).filter(e => selector === '*' || e.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() { const left = parseFloat(this.style.left) || 60, top = parseFloat(this.style.top) || 0, width = parseFloat(this.style.width) || (this.classList.contains('task-board') ? 790 : 300), height = parseFloat(this.style.height) || (this.classList.contains('task-board') ? 36 : 180); return { left, top, width, height, right: left + width, bottom: top + height }; }
  getClientRects() { return this.hidden ? [] : [this.getBoundingClientRect()]; }
  scrollIntoView() {}
  focus() { if (this.doc.activeElement === this) return; const before = this.doc.activeElement; this.doc.activeElement = this; before?.fire('focusout', { relatedTarget: this }); this.fire('focusin', { relatedTarget: before }); }
  showModal() { this.invoker = this.doc.activeElement; this.open = true; this.doc.modal = this; }
  close() { if (!this.open) return; this.open = false; this.doc.modal = null; this.invoker?.focus(); this.fire('close'); }
  showPopover() { this.popoverOpen = true; }
  hidePopover() { this.popoverOpen = false; }
}
function fixture() {
  const doc = new Events(), win = new Events(), timers = new Map(); let tick = 0, next = 0;
  win.innerWidth = 850; win.innerHeight = 600; win.nativeWorkspaceHoverCard = hover;
  win.setTimeout = (fn, ms) => { timers.set(++next, { fn, at: tick + ms }); return next; }; win.clearTimeout = key => timers.delete(key);
  win.ResizeObserver = class { observe() {} disconnect() { this.disconnected = true; } };
  doc.defaultView = win; doc.createElement = tag => new Element(tag, doc); doc.body = doc.createElement('body'); doc.activeElement = doc.body; doc.querySelector = selector => doc.body.querySelector(selector);
  const main = doc.createElement('main'), host = doc.createElement('section'), content = doc.createElement('article'); host.id = 'task-board'; doc.body.append(main); main.append(host, content);
  return { doc, win, host, content, timers, tick(ms) { tick += ms; for (const [id, timer] of [...timers]) if (timers.has(id) && timer.at <= tick) { timers.delete(id); timer.fn(); } }, key(key) { const e = doc.fire('keydown', { key }); if (key === 'Escape' && !e.defaultPrevented) doc.modal?.close(); } };
}
module.exports = { fixture };
