const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const overview = fs.readFileSync(require.resolve('../renderer/collaboration-overview.js'), 'utf8');
const renderer = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
const content = fs.readFileSync(require.resolve('../renderer/context-menu.js'), 'utf8');
// Executes the real header event bindings and existing member/content routers.
// This small event tree models document capture before target/bubble listeners;
// it does not qualify browser layout, physical input, clipboard or screen readers.
class Element {
  constructor(tag = 'div', className = '') { this.tagName = tag; this.className = className; this.dataset = {}; this.attributes = {}; this.listeners = []; this.children = []; this.parentElement = null; this.rect = { left: 10, right: 30, top: 20, bottom: 40 }; }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  matches(selector) { return selector.split(',').some(s => {
    s = s.trim();
    if (s.startsWith('.')) return this.className.split(' ').includes(s.slice(1));
    if (s.startsWith('#')) return this.id === s.slice(1);
    if (s.startsWith('[data-')) return s.slice(6, -1).replace(/-([a-z])/g, (_, c) => c.toUpperCase()) in this.dataset;
    if (s.startsWith('[')) return Object.hasOwn(this.attributes, s.slice(1, -1));
    if (s.includes('[')) return this.tagName === s.slice(0, s.indexOf('[')) && this.matches(s.slice(s.indexOf('[')));
    return this.tagName === s;
  }); }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  addEventListener(type, callback, capture = false) { this.listeners.push({ type, callback, capture }); }
  removeEventListener(type, callback) { this.listeners = this.listeners.filter(l => l.type !== type || l.callback !== callback); }
  get isConnected() { return this.connected || Boolean(this.parentElement?.isConnected); }
  getBoundingClientRect() { return this.rect; }
  getClientRects() { return this.isConnected && !this.hidden ? [this.rect] : []; }
  focus() { this.document.activeElement = this; }
}
function fixture(member = 0) {
  const document = new Element('document'); document.connected = true;
  const node = (tag = 'div', cls = '') => Object.assign(new Element(tag, cls), { document });
  const host = node('div', 'naw'), band = node('div', 'collaboration-statuses'), header = node('section', 'collaboration-member-status'); document.append(host); host.append(band); band.append(header);
  band.rect = { left: 0, right: 800, top: 10, bottom: 80 };
  const name = node('button', 'collaboration-member-name'), label = node('span'), next = node('button', 'collaboration-member-next'), status = node('span'), heading = node('div'); name.append(label); header.append(heading, status);
  const elements = new Map(['manage-members', 'room-nav'].map(id => { const value = node('button'); value.id = id; host.append(value); return [id, value]; }));
  const menus = [], copies = [], changed = [], notices = [], records = [{ id: 'naw-alpha', nativeId: 'native-alpha', name: 'Same name', roomId: 'shared', memberRevision: 1 }, { id: 'naw-beta', nativeId: 'native-beta', name: 'Same name', roomId: 'shared', memberRevision: 1 }];
  const button = (text, action, cls) => { const value = node('button', cls); value.textContent = text; value.addEventListener('click', action); return value; };
  const context = vm.createContext({ Element, document, window: { getSelection: () => ({ toString: () => 'Previously selected private reading text' }) },
    selectionRevision: 1, selected: 'room', disconnected: false, state: { room: { archived: false }, members: records }, roomSurface: 'overview', roomSession: '', sessionMenu: null, roomMenu: null,
    members: () => context.state.members, orderedMembers: () => context.state.members, $: id => elements.get(id),
    activeSessionId: () => 'naw-alpha', current: () => records[0], terminals: new Map(), sessionComposers: new Map(), owner: 'fixture-owner',
    toast: text => notices.push(text), attempt: action => action(), detach: id => changed.push(id),
    captureReadingViews() {}, restoreOverviewReading() {}, moveRoomMember: (...args) => changed.push(args),
    api: { copy: id => copies.push(id) }, ui: { menu: config => { const entry = { config, closed: false }; const close = () => { if (entry.closed) return; entry.closed = true; config.onClose(); }; entry.close = close; menus.push(entry); return close; } },
    header, name, heading, next, record: records[member], button,
  });
  vm.runInContext(content, context);
  vm.runInContext(renderer.slice(renderer.indexOf('function memberMenuKey('), renderer.indexOf('function sidebarSessions(')), context);
  context.options = { onMemberMenu: context.openMemberMenu };
  const first = overview.indexOf("      const more = button('⋯'");
  assert.ok(first > 0); const last = overview.indexOf('      heading.append(name, more, next);', first);
  vm.runInContext(overview.slice(first, last + '      heading.append(name, more, next);'.length) + '\nglobalThis.more = more;', context);
  context.bindContentMenus(); const more = context.more;
  function emit(target, type, props = {}) {
    const event = { type, target, button: 0, defaultPrevented: false, stopped: false, ...props, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    const path = []; for (let p = target; p; p = p.parentElement) path.push(p);
    for (const item of [...path].reverse()) { for (const l of item.listeners) if (l.type === type && l.capture) l.callback(event); if (event.stopped) return event; }
    for (const item of path) { for (const l of item.listeners) if (l.type === type && !l.capture) l.callback(event); if (event.stopped) break; }
    return event;
  }
  // Existing outside-click lifecycle: a header pointerdown must not close the
  // active menu before contextmenu reaches the original same-anchor toggle.
  document.addEventListener('pointerdown', () => vm.runInContext('sessionMenu?.close()', context));
  document.activeElement = name;
  return { node, host, band, header, name, label, status, next, more, menus, copies, changed, notices, records, context, document, emit };
}
const memberMenus = f => f.menus.filter(m => m.config.contextElement === f.more);
test('right-clicking a member name or title padding opens only its existing anchored menu', () => {
  for (const target of ['label', 'header', 'status']) for (const member of [0, 1]) {
    const f = fixture(member); const event = f.emit(f[target], 'contextmenu', { button: 2, clientX: 900, clientY: 700 });
    assert.equal(memberMenus(f).length, 1); assert.equal(event.defaultPrevented, true); assert.equal(f.menus.length, 1);
    const menu = memberMenus(f)[0]; assert.equal(menu.config.contextElement, f.more);
    assert.deepEqual({ ...menu.config.getAnchorRect() }, { left: 10, right: 30, top: 80, bottom: 80 });
    assert.deepEqual(Array.from(menu.config.items, x => x.id), ['detach', 'copy-id', member ? 'earlier' : 'later']); assert.equal(f.more.getAttribute('aria-expanded'), 'true'); assert.deepEqual(f.copies, []); assert.deepEqual(f.changed, []);
    menu.config.onSelect('copy-id'); assert.deepEqual(f.copies, [f.records[member].id]); assert.notEqual(f.copies[0], f.records[member].nativeId);
    menu.close(); assert.equal(f.more.getAttribute('aria-expanded'), 'false'); assert.equal(f.document.activeElement, f.more);
  }
});
test('ContextMenu and Shift+F10 on the name beat document text-copy capture and use the same more anchor', () => {
  for (const props of [{ key: 'ContextMenu' }, { key: 'F10', shiftKey: true }]) {
    const f = fixture(); const event = f.emit(f.name, 'keydown', props);
    assert.equal(memberMenus(f).length, 1); assert.equal(f.menus.length, 1); assert.equal(event.defaultPrevented, true); assert.equal(f.document.activeElement, f.more);
  }
});
test('repeated right-click keeps the original same-anchor toggle instead of closing then rebuilding', () => {
  for (const pointer of [{ button: 2 }, { button: 0, ctrlKey: true }]) {
    const f = fixture(); f.emit(f.label, 'contextmenu'); assert.equal(memberMenus(f).length, 1);
    const down = f.emit(f.label, 'pointerdown', pointer); assert.equal(down.stopped, true); assert.equal(memberMenus(f)[0].closed, false);
    f.emit(f.label, 'contextmenu'); assert.equal(memberMenus(f).length, 1); assert.equal(memberMenus(f)[0].closed, true); assert.equal(f.more.getAttribute('aria-expanded'), 'false');
  }
});
test('the original more button still opens exactly once by click, context menu or menu key', () => {
  for (const [type, props] of [['click', {}], ['contextmenu', {}], ['keydown', { key: 'ContextMenu' }]]) {
    const f = fixture(); f.emit(f.more, type, props); assert.equal(memberMenus(f).length, 1); assert.equal(f.menus.length, 1);
  }
});
test('nested controls and ordinary reading retain their original content menus', () => {
  for (const target of ['next', 'link', 'field', 'reading']) {
    const f = fixture(), link = f.node('a'), field = f.node('input'), reading = f.node('div', 'messages'); link.href = 'https://example.test/original'; link.setAttribute('href', link.href); field.value = 'Unsent input'; field.selectionStart = 0; field.selectionEnd = 6;
    f.header.append(link, field); f.host.append(reading); const node = { next: f.next, link, field, reading }[target];
    f.emit(node, 'contextmenu'); assert.equal(memberMenus(f).length, 0); assert.equal(f.menus.length, 1); assert.equal(f.menus[0].config.contextElement, node);
    assert.deepEqual(Array.from(f.menus[0].config.items, x => x.id), target === 'field' ? ['cut', 'copy', 'paste', 'all'] : target === 'link' ? ['copy', 'link'] : ['copy']);
  }
});
test('offline, unavailable or detached headers do not open a member menu', () => {
  for (const state of ['disabled', 'hidden', 'detached']) {
    const f = fixture(); if (state === 'detached') f.header.parentElement = null; else f.more[state] = true;
    f.emit(f.label, 'contextmenu'); assert.equal(memberMenus(f).length, 0); assert.deepEqual(f.changed, []); assert.deepEqual(f.copies, []);
  }
});
test('IME, modified keys and ordinary function keys do not turn into member actions', () => {
  for (const props of [{ key: 'F10' }, { key: 'ContextMenu', isComposing: true }, { key: 'ContextMenu', keyCode: 229 }, { key: 'ContextMenu', ctrlKey: true }, { key: 'F10', shiftKey: true, altKey: true }]) {
    const f = fixture(); f.emit(f.name, 'keydown', props); assert.equal(memberMenus(f).length, 0); assert.deepEqual(f.changed, []);
  }
});
test('existing identity, membership and selection guards reject stale header menu actions', () => {
  for (const change of [f => f.records[0].nativeId = 'changed-native', f => f.records[0].memberRevision++, f => f.context.selectionRevision++, f => f.context.state.room.archived = true, f => f.context.disconnected = true, f => f.context.state.members = []]) {
    const f = fixture(); f.emit(f.label, 'contextmenu'); const menu = memberMenus(f)[0]; assert.ok(menu); change(f);
    for (const action of ['copy-id', 'detach', 'later']) menu.config.onSelect(action);
    assert.deepEqual(f.copies, []); assert.deepEqual(f.changed, []); assert.equal(f.notices.length, 3); menu.close(); assert.equal(f.document.activeElement.id, 'manage-members');
  }
});
