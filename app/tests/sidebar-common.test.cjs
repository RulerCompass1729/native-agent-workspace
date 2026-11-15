// The sidebar parts both looks share (a44dc91d A 「清爽列表」 / B 「卡片分层」): a visible collapse button that follows
// DSH's own state, the chain chip's click, and the one style layer that holds the A/B differences. Synthetic DOM only;
// no Electron, provider or model.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const localeUI = require('./fixtures/locale-ui.cjs');
const messages = require('../ui-messages.js');
const read = file => fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
const renderer = read('app/renderer/renderer.js');

function wiring({ collapsed = 'false', look } = {}) {
  const locale = localeUI(), calls = [], observers = [], elements = new Map();
  const surface = { dataset: { collapsed } };
  class Element {
    constructor(id) { this.id = id; this.attrs = new Map(); this.dataset = {}; this.content = ''; }
    setAttribute(name, value) { this.attrs.set(name, String(value)); }
    getAttribute(name) { return this.attrs.get(name) ?? null; }
    hasAttribute(name) { return this.attrs.has(name); }
    removeAttribute(name) { this.attrs.delete(name); }
    get childElementCount() { return 0; }
    get textContent() { return this.content; }
    set textContent(value) { this.content = String(value); }
  }
  const $ = id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); };
  $('sidebar-toggle').closest = selector => selector === '.naw[data-native-surface="sidebar"]' ? surface : null;
  class MutationObserver { constructor(callback) { this.callback = callback; observers.push(this); } observe(target, options) { this.target = target; this.options = options; } }
  const documentElement = { dataset: look ? { sidebarLook: look } : {} };
  const ui = { ...locale.ui, toggleSidebar: () => calls.push(['toggle']) };
  const context = vm.createContext({ $, ui, uiText: locale.uiText, MutationObserver, document: { documentElement }, openSessionChain: id => calls.push(['chain', id]) });
  const start = renderer.indexOf("$('session-chain-chip').onclick"), end = renderer.indexOf("$('session-chain-dialog').addEventListener('close'", start);
  assert.ok(start >= 0 && end > start, 'Production sidebar wiring must be present');
  vm.runInContext(renderer.slice(start, end), context);
  const toggle = $('sidebar-toggle');
  return { $, toggle, calls, observers, surface, documentElement, context,
    // DSH flips the attribute (⌥⌘B, the narrow-window rail, or our own button); the observer repaints the button.
    dsh(value) { surface.dataset.collapsed = value; for (const observer of observers) observer.callback([]); },
    language(value) { locale.setLanguage(value); locale.ui.display.refresh({ querySelectorAll: () => [toggle] }); },
    read: () => ({ expanded: toggle.getAttribute('aria-expanded'), label: toggle.getAttribute('aria-label'), title: toggle.getAttribute('title') }) };
}

test('the visible collapse button shows DSH\'s state, follows ⌥⌘B and the narrow-window rail, and asks DSH to toggle', () => {
  const w = wiring();
  assert.deepEqual(w.read(), { expanded: 'true', label: '收起侧栏', title: '收起侧栏（⌥⌘B）' });
  assert.equal(w.observers.length, 1);
  assert.equal(w.observers[0].target, w.surface);
  assert.deepEqual(Array.from(w.observers[0].options.attributeFilter), ['data-collapsed']);
  w.toggle.onclick();
  assert.deepEqual(w.calls, [['toggle']]);
  // The button never decides the state itself: it changes only when DSH's attribute does.
  assert.equal(w.read().expanded, 'true');
  w.dsh('true');
  assert.deepEqual(w.read(), { expanded: 'false', label: '展开侧栏', title: '展开侧栏（⌥⌘B）' });
  w.language('en');
  assert.deepEqual(w.read(), { expanded: 'false', label: 'Show sidebar', title: 'Show sidebar (⌥⌘B)' });
  w.dsh('false');
  assert.deepEqual(w.read(), { expanded: 'true', label: 'Hide sidebar', title: 'Hide sidebar (⌥⌘B)' });
  w.context.syncSidebarToggle();
  assert.equal(w.observers.length, 1, 'repainting must not add a second observer');
});

test('a window that opens narrow starts with the button saying 展开侧栏', () => {
  assert.deepEqual(wiring({ collapsed: 'true' }).read(), { expanded: 'false', label: '展开侧栏', title: '展开侧栏（⌥⌘B）' });
});

test('the chain chip opens the chain of the session it names; a hidden chip with no session opens nothing', () => {
  const w = wiring(), chip = w.$('session-chain-chip');
  chip.dataset.sessionId = 'latest'; chip.onclick();
  chip.dataset.sessionId = ''; chip.onclick();
  assert.deepEqual(w.calls, [['chain', 'latest']]);
});

test('the chosen look B is always used, including a prior A selection', () => {
  assert.equal(wiring().documentElement.dataset.sidebarLook, 'b');
  assert.equal(wiring({ look: 'a' }).documentElement.dataset.sidebarLook, 'b');
  assert.equal(wiring({ look: 'b' }).documentElement.dataset.sidebarLook, 'b');
});

test('the button sits in the sidebar brand and the chip right after the title, inside the built template', () => {
  // scripts/build-ui.cjs embeds only the body before the first script, split at </aside> into the two surfaces.
  const body = read('app/renderer/index.html').split('<body>')[1].split('<script')[0];
  const cut = body.indexOf('</aside>'), sidebar = body.slice(0, cut), main = body.slice(cut);
  assert.match(sidebar, /<div class="brand"><button id="sidebar-toggle" class="sidebar-toggle" type="button" aria-expanded="true"[^>]* data-naw-aria-label="sidebar\.hidePanel" data-naw-title="sidebar\.hidePanel">/);
  assert.match(main, /<h1 id="title"[^>]*><\/h1><button id="session-chain-chip" class="session-chain-chip" type="button" aria-haspopup="dialog" hidden><\/button>/);
  assert.match(read('app/dsh/bootstrap.js'), /\n\s+toggleSidebar\(\) \{ ctx\.layout\.toggleSidebar\(\); \},\n/);
});

test('every A/B difference lives in sidebar-look.css, which the build appends after the existing styles', () => {
  const build = read('scripts/build-ui.cjs');
  const look = build.indexOf("read('app/renderer/sidebar-look.css')");
  assert.ok(look > build.indexOf("read('app/renderer/butler-review.css')") && build.indexOf("read('app/renderer/butler-review.css')") > 0, 'sidebar-look.css must come last so it can adjust the shared rules');
  const css = read('app/renderer/sidebar-look.css');
  assert.ok(!css.includes(':root[data-sidebar-look="a"]') && css.includes(':root[data-sidebar-look="b"]'));
  for (const file of fs.readdirSync(path.join(__dirname, '..', 'renderer')).filter(name => name.endsWith('.css') && name !== 'sidebar-look.css')) {
    assert.ok(!read('app/renderer/' + file).includes('data-sidebar-look'), file + ' must not hold look-specific rules');
  }
  assert.equal(renderer.split('sidebarLook').length - 1, 1, 'the renderer only sets the default look');
});

test('zh and en carry the new texts with the same placeholders', () => {
  const placeholders = text => (text.match(/\{\w+\}/g) || []).sort().join();
  for (const [key, expected] of [['chain.from', '{count},{name}'], ['sidebar.hidePanel', ''], ['sidebar.showPanel', ''], ['sidebar.panelShortcut', '{action}']]) {
    for (const language of ['zh', 'en']) {
      assert.equal(typeof messages[language][key], 'string', `${language} ${key}`);
      assert.equal(placeholders(messages[language][key]), expected, `${language} ${key}`);
    }
  }
});

test('on the rail, where ⋯ is not drawn, Shift+F10 opens the row menu beside the row and Escape gives focus back to the row', () => {
  const slice = (start, end) => { const a = renderer.indexOf(start), b = renderer.indexOf(end, a + start.length); assert.ok(a >= 0 && b > a, start); return renderer.slice(a, b); };
  const box = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height, width, height });
  const control = (rect, drawn) => ({ isConnected: true, focused: 0, focus() { this.focused += 1; }, setAttribute() {}, getClientRects: () => drawn ? [rect] : [], getBoundingClientRect: () => rect });
  function open(moreDrawn) {
    // Rail geometry from the isolated window: the row's button at x 10–44; ⋯ is display:none there (a zero box).
    const row = { link: control(box(10, 372, 34, 42), true), more: moreDrawn ? control(box(240, 380, 28, 32), true) : control(box(0, 0, 0, 0), false) }, menus = [];
    const context = vm.createContext({ state: { sessions: [{ id: 's' }] }, contentMenu: null, sessionMenu: null, roomMenu: null, disconnected: false,
      sessionRows: new Map([['s', row]]), sessionRow: () => row, sessionMenuModel: () => ({ record: { id: 's' }, items: [], actionsKey: '' }), sidebarFactsKey: () => '',
      $: () => null, ui: { menu: options => { menus.push(options); return () => {}; } } });
    vm.runInContext(slice('function focusSessionAction(', 'async function setOperatorEnabled(') + slice('function openSessionMenu(', 'function memberMenuKey('), context);
    context.openSessionMenu('s');
    const anchor = menus[0].getAnchorRect(); menus[0].onClose();
    return { anchor: { left: anchor.left, top: anchor.top, bottom: anchor.bottom }, link: row.link.focused, more: row.more.focused };
  }
  // Rail: anchored at the row's right edge (not the window corner); focus goes back to the row itself.
  assert.deepEqual(open(false), { anchor: { left: 44, top: 372, bottom: 414 }, link: 1, more: 1 });
  // Expanded sidebar, unchanged: anchored at ⋯, and ⋯ takes focus back.
  assert.deepEqual(open(true), { anchor: { left: 268, top: 380, bottom: 412 }, link: 0, more: 2 });
  // Only session rows lose ⋯ on the rail; a space's menu still anchors at, and returns focus to, its own ⋯ (drawn on
  // the flat-view rail by styles.css). Strict on purpose: any rule here that reaches a space's ⋯ needs openRoomMenu checked.
  const css = read('app/renderer/sidebar-look.css');
  assert.ok(css.includes('.session-row .session-more{display:none!important}'));
  assert.ok(! /\.space-group-more\s*\{[^}]*display\s*:\s*none/.test(css), 'a space\'s ⋯ must stay on the rail');
});

test('a rename that closes after the sidebar folded to the rail gives focus to the row, not to the drop area', () => {
  const a = renderer.indexOf('function closeRename('), b = renderer.indexOf('function focusSessionAction(', a);
  assert.ok(a >= 0 && b > a, 'Production closeRename must be present');
  const control = drawn => ({ isConnected: true, disabled: false, focused: 0, focus() { this.focused += 1; }, getClientRects: () => drawn ? [{}] : [] });
  function close(moreDrawn) {
    const row = { link: control(true), more: control(moreDrawn) }, elements = { 'rename-editor': { hidden: false }, header: { parentElement: { append() {} } }, 'solo-drop': control(true), 'workspace-toggle': control(true), 'room-more': control(true) };
    const context = vm.createContext({ renameTarget: { id: 's', row: { classList: { remove() {} } }, label: { hidden: true }, origin: row.more }, renaming: false, renameRevision: 0, renameComposing: false,
      render() {}, $: id => elements[id], sessionRow: () => row });
    vm.runInContext(renderer.slice(a, b), context);
    context.closeRename();
    return { link: row.link.focused, more: row.more.focused, drop: elements['solo-drop'].focused };
  }
  // Rail (⌥⌘B or a narrow window while the name was being edited): ⋯ has no box, the row's button takes focus.
  assert.deepEqual(close(false), { link: 1, more: 0, drop: 0 });
  // Expanded sidebar, unchanged: ⋯ that opened the rename takes focus back.
  assert.deepEqual(close(true), { link: 0, more: 1, drop: 0 });
});
