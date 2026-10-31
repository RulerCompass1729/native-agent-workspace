const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const spaces = require('../collaboration-spaces.cjs');
const source = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../renderer/index.html'), 'utf8');
function fixture() {
  const elements = new Map(), writes = [], calls = [], notices = [], listeners = new Map();
  const $ = id => {
    if (!elements.has(id)) elements.set(id, {
      hidden: false, open: false, value: '',
      contains(other) { return other === this || id === 'terminal-display-dialog' && ['terminal-font-size', 'terminal-palette', 'reset-terminal-display', 'close-terminal-display'].some(key => elements.get(key) === other); },
      show() { this.open = true; calls.push('nonmodal'); },
      showModal() { this.open = true; calls.push('modal'); },
      close() { this.open = false; calls.push('close'); },
    });
    return elements.get(id);
  };
  const context = vm.createContext({ $, selected: 'a', spaceId: 'shared', selectionRevision: 1, disconnected: false,
    window: { nativeWorkspaceSpaces: spaces },
    sessionMenu: null, roomMenu: null, contentMenu: null, renameTarget: null, disposers: [],
    document: { addEventListener(type, listener, capture) { listeners.set(type, { listener, capture }); }, removeEventListener(type, listener, capture) { const entry = listeners.get(type); if (entry?.listener === listener && entry.capture === capture) listeners.delete(type); }, querySelector() { return $('terminal-display-dialog').open ? $('terminal-display-dialog') : null; } },
    record: spaces.withMembership({ id: 'a', nativeId: 'native-a', owner: 'window-a', archived: false, memberRevision: 0 }, 'shared', true),
    terminalDisplay: { fontSize: 20, palette: 'green' },
    current: () => context.record,
    attempt: async action => { try { return await action(); } catch (e) { notices.push(e.message); } },
    applyTerminalDisplay: () => calls.push('apply'),
    persistView: async () => { writes.push(JSON.parse(vm.runInContext('JSON.stringify(terminalDisplay)', context))); },
    focusTerminal: () => calls.push('focus'),
  });
  vm.runInContext(source.match(/^const pairRevision = .+;$/m)[0], context);
  vm.runInContext(source.match(/^const inputFocusAllowed = .+;$/m)[0], context);
  vm.runInContext(source.slice(source.indexOf('const headerMenuKey ='), source.indexOf('function openHeaderMenu(')), context);
  const start = source.includes('let terminalDisplayKey;') ? source.indexOf('let terminalDisplayKey;') : source.indexOf("$('terminal-display').onclick");
  vm.runInContext(source.slice(start, source.indexOf("$('terminal-more').onclick", start)), context);
  vm.runInContext(source.slice(source.indexOf('const saveTerminalDisplay ='), source.indexOf('let filePreview =')), context);
  const renderGuard = source.split('\n').find(line => line.includes("$('terminal-display-dialog').open && (!terminalVisible"));
  return { $, context, calls, writes, notices,
    open: () => $('terminal-display').onclick(),
    focus(target) { listeners.get('focusin')?.listener({ target }); },
    inputAllowed: () => vm.runInContext('inputFocusAllowed()', context),
    listenerCount: () => listeners.size,
    save: () => $('terminal-font-size').onchange(),
    render(visible = true) { context.terminalVisible = visible; if (renderGuard) vm.runInContext(renderGuard, context); },
    value: () => JSON.parse(vm.runInContext('JSON.stringify(terminalDisplay)', context)),
  };
}
test('the existing display form opens nonmodally with the accepted window preferences', () => {
  const f = fixture(); f.open();
  assert.deepEqual(f.calls, ['nonmodal']);
  assert.equal(f.$('terminal-font-size').value, 20);
  assert.equal(f.$('terminal-palette').value, 'green');
  assert.equal(f.writes.length, 0);
});
test('hidden terminal and missing session cannot create an invisible editor', () => {
  for (const missing of [false, true]) {
    const f = fixture(); f.$('native-pane').hidden = !missing;
    if (missing) f.context.record = undefined;
    f.open(); assert.equal(f.$('terminal-display-dialog').open, false); assert.equal(f.writes.length, 0);
  }
});
test('ordinary snapshots preserve edits while selection, identity, or surface changes dismiss them', async () => {
  for (const change of [
    f => f.context.selectionRevision++,
    f => { f.context.spaceId = '11111111-1111-4111-8111-111111111111'; },
    f => { f.context.record = spaces.withMembership(f.context.record, 'shared', false); },
    f => { f.context.record.nativeId = 'replacement'; },
    f => { f.context.record.owner = 'window-b'; },
    f => { f.context.record = undefined; },
    f => { f.context.disconnected = true; },
    f => { f.context.terminalVisible = false; },
  ]) {
    const f = fixture(); f.open(); f.$('terminal-font-size').value = '18'; f.render();
    assert.equal(f.$('terminal-display-dialog').open, true);
    assert.equal(f.$('terminal-font-size').value, '18');
    change(f); f.render(f.context.terminalVisible !== false);
    assert.equal(f.$('terminal-display-dialog').open, false);
    await f.save(); assert.equal(f.writes.length, 0);
  }
});
test('size bounds, palette, and accepted values use the existing save callback', async () => {
  for (const value of ['10', '24', '13']) {
    const f = fixture(); f.open(); f.$('terminal-font-size').value = value; await f.save();
    assert.deepEqual(f.writes, [{ fontSize: Number(value), palette: 'green' }]);
    assert.deepEqual(f.calls, ['nonmodal', 'apply']);
  }
  for (const value of ['9', '25', '13.5', '']) {
    const f = fixture(); f.open(); f.$('terminal-font-size').value = value; await f.save();
    assert.equal(f.writes.length, 0); assert.equal(f.value().fontSize, 20);
    assert.deepEqual(f.notices, ['字号请设为 10–24。']);
  }
});
test('close rejects late blur and reopening reads the accepted setting', async () => {
  const f = fixture(); f.open(); f.$('terminal-font-size').value = '18';
  f.$('terminal-display-dialog').close(); await f.save();
  assert.equal(f.writes.length, 0); f.open(); assert.equal(f.$('terminal-font-size').value, 20);
});
test('restore default still uses the existing reset and save behavior', async () => {
  const f = fixture(); f.open(); f.$('reset-terminal-display').onclick();
  await Promise.resolve(); assert.deepEqual(f.value(), { fontSize: 14, palette: 'dark' });
  assert.deepEqual(f.writes, [{ fontSize: 14, palette: 'dark' }]);
});
test('the single existing form is inside the original native pane with an accessible heading', () => {
  const pane = html.indexOf('<section id="native-pane"'), form = html.indexOf('<dialog closedby="any" id="terminal-display-dialog"');
  const terminal = html.indexOf('<div id="terminal-area"', pane);
  assert.ok(pane < form && form < terminal);
  assert.equal(html.split('id="terminal-display-dialog"').length, 2);
  assert.ok(html.includes('aria-labelledby="terminal-display-title"'));
  assert.ok(html.includes('id="terminal-display-title"'));
});

test('leaving the nonmodal display form permits the original input focus path while internal edits stay protected', () => {
  const f = fixture(); f.open();
  f.focus(f.$('terminal-font-size')); assert.equal(f.$('terminal-display-dialog').open, true);
  assert.equal(f.inputAllowed(), false);
  f.focus(f.$('shared-input')); assert.equal(f.$('terminal-display-dialog').open, false);
  assert.equal(f.inputAllowed(), true);
});

test('unmount removes the document focus listener before the old UI becomes unavailable', () => {
  const f = fixture(); f.open(); assert.equal(f.listenerCount(), 1);
  for (const dispose of f.context.disposers) dispose();
  f.context.$ = () => null;
  assert.doesNotThrow(() => f.focus({ id: 'unrelated-app-control' }));
  assert.equal(f.listenerCount(), 0);
});

for (const inDialog of [false, true]) test(`the original DSH menu host stays out of document flow${inDialog ? ' inside a dialog' : ' on the body'}`, () => {
  const bootstrap = fs.readFileSync(require.resolve('../dsh/bootstrap.js'), 'utf8');
  const start = bootstrap.indexOf('menu({ items, getAnchorRect, onSelect, onClose, contextElement })');
  const menuSource = bootstrap.slice(start, bootstrap.indexOf('\n          markdown(', start));
  const appended = [], effects = [], rendered = [], closes = [], removed = [];
  const modal = inDialog ? { append(el) { appended.push(el); }, removeEventListener() {} , addEventListener() {} } : null;
  const opener = { closest() { return modal; } };
  const context = vm.createContext({
    document: { activeElement: opener, body: { append(el) { appended.push(el); } },
      createElement() { return { style: {}, remove() { removed.push(this); } }; }, addEventListener() {}, removeEventListener() {} },
    window: { addEventListener() {}, removeEventListener() {} },
    React: { createElement(type, props) { return { type, props }; }, useEffect(effect) { effects.push(effect); } },
    ReactDOM: { createRoot() { return { render(element) { rendered.push(element); }, unmount() {} }; } }, Menu: Symbol('existing Menu'),
  });
  const ui = vm.runInContext(`({${menuSource}})`, context);
  const close = ui.menu({ items: [], getAnchorRect: () => ({}), onSelect() {}, onClose() { closes.push(true); } });
  assert.equal(appended.length, 1);
  assert.equal(appended[0].style.position, 'fixed');
  assert.equal(appended[0].style.width, '0px');
  assert.equal(appended[0].style.height, '0px');
  const menu = rendered[0].type();
  assert.equal(menu.props.portal, !inDialog);
  close(); close(); assert.equal(closes.length, 1); assert.equal(removed.length, 1);
});
