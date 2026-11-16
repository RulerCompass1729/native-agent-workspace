const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

// Space view cost (2026-11-15: the person's window used about half a core while a space was open). Drawing a
// space measured each column's height while the columns were still being drawn: reading a height after the
// previous column's messages changed forces the page to lay out again, once per column, on every redraw
// (in an isolated 8-column space at about 4 redraws a second, 2.4 s of every 6.4 s went to these reads). The
// overview already measures every column once after the whole space is drawn (refreshColumnTerminalHeights),
// so drawing a column only places it. The real renderer functions run here on a page that counts layouts.
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
function take(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, 'Production renderer function boundaries exist: ' + start);
  return source.slice(a, b);
}

function space(count) {
  // A layout happens when something reads a size after the page changed; an unchanged value changes nothing.
  const page = { changed: true, layouts: 0 };
  const read = value => { if (page.changed) { page.layouts++; page.changed = false; } return value; };
  const change = () => { page.changed = true; };
  class Style {
    constructor() { this.values = new Map(); }
    get height() { return this.values.get('height') || ''; }
    set height(value) { if (this.height !== value) { this.values.set('height', value); change(); } }
    getPropertyValue(name) { return this.values.get(name) || ''; }
    setProperty(name, value) { if (this.getPropertyValue(name) !== value) { this.values.set(name, value); change(); } }
  }
  class Element {
    constructor(height = 0) { this.children = []; this.hidden = false; this.style = new Style(); this.attributes = new Map(); this.height = height; this.isConnected = true; }
    append(child) {
      if (child.parentElement) child.parentElement.children.splice(child.parentElement.children.indexOf(child), 1);
      this.children.push(child); child.parentElement = this; change();
    }
    insertBefore(child, next) { this.append(child); this.children.pop(); this.children.splice(this.children.indexOf(next), 0, child); }
    get nextSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1]; }
    get offsetHeight() { return read(this.height); }
    get clientHeight() { return read(this.height); }
    setAttribute(name, value) { if (this.attributes.get(name) !== String(value)) { this.attributes.set(name, String(value)); change(); } }
    closest(selector) { return selector === '.collaboration-member-reader' ? this.reader : null; }
    querySelector(selector) {
      if (selector === '.session-compose-hint') return this.hint;
      if (selector === '.column-native-footer:not([hidden])') return this.footer && !this.footer.hidden ? this.footer : null;
      return null;
    }
  }
  const records = [], hosts = new Map(), bindings = new Map();
  for (let i = 0; i < count; i++) {
    const record = { id: 'member-' + i, view: 'terminal', terminalState: { alive: true } };
    // A 600px column: a 200px input area holding the 112px terminal and a 32px hint.
    const reader = new Element(600), host = new Element(200);
    host.reader = reader; host.hint = new Element(32); reader.footer = new Element(0); reader.footer.hidden = true;
    records.push(record); hosts.set(record.id, host);
    bindings.set(record.id, { id: record.id, revision: 0, ui: { form: new Element(), suspend() {} } });
  }
  const context = vm.createContext({
    state: { sessions: records }, sessionComposers: bindings, terminals: new Map(), columnTerminalHeights: {},
    soloComposer: {}, composerParking: new Element(), getSessionComposer: id => bindings.get(id),
    node: () => new Element(112), columnTerminalSash: binding => binding.nativeSash ||= new Element(),
    composerCurrent: binding => bindings.get(binding.id) === binding && Boolean(binding.visible),
    updateSessionComposer() {}, takeFreeSession() {}, cancelColumnComposition() {},
    ui: { display: { attribute() {} } }, participantLabel: record => record.id,
    nativeUsable: () => false, syncTerminalMount() {}, revealTerminalCursor() {},
    attempt() {}, persistView() {}, fitTerminal() {},
  });
  vm.runInContext([
    take('const COLUMN_TERMINAL = ', '\n'),
    take('function renderColumnInput(', '// T-135:'),
    take('function columnTerminalLimits(', 'function columnTerminalAlignment('),
    take('function refreshColumnTerminalHeights(', "window.addEventListener('resize'"),
    take('function columnTerminalBinding(', 'function terminalContextVisible('),
  ].join('\n'), context);
  // One overview redraw as collaboration-overview.js and renderRoomOverview do it: the page has changed,
  // each column's input is placed and its messages are drawn, then the columns are measured together.
  const redraw = () => {
    change();
    for (const record of records) {
      context.renderColumnInput(hosts.get(record.id), record, true);
      hosts.get(record.id).reader.footer.hidden = false; change(); // its messages and footer
    }
    context.refreshColumnTerminalHeights();
  };
  return { page, redraw, bindings };
}

test('redrawing an eight-column space lays the page out once, not once per column', () => {
  const s = space(8);
  s.redraw();
  s.page.layouts = 0;
  s.redraw();
  assert.equal(s.page.layouts, 1, `one redraw of 8 columns forced ${s.page.layouts} layouts`);
});

test('every column still gets its terminal height and hint lines by the end of the redraw that shows it', () => {
  const s = space(3);
  s.redraw();
  for (const binding of s.bindings.values()) {
    assert.equal(binding.nativeHost.style.height, '112px');
    assert.equal(binding.terminalHeight, 112);
    assert.equal(binding.columnHost.style.getPropertyValue('--column-hint-lines'), '4');
    assert.equal(binding.nativeSash.attributes.get('aria-valuenow'), '112');
  }
});

// What dirtied the page between columns (2026-11-15 timeline trace, invalidation tracking: text nodes removed at
// session-composer.js update): every redraw rewrote each column input's placeholder, button label and hint with the
// same text, and replacing equal text still replaces the text node. The real composer runs here on counting elements.
test('updating a column input with what it already shows writes nothing, and a change writes only that part', () => {
  const composer = require(path.join(root, 'app/renderer/session-composer.js'));
  const writes = [];
  class Element {
    constructor(document) { this.ownerDocument = document; this.values = { textContent: '', placeholder: '', type: 'submit', readOnly: false, disabled: false, hidden: false }; this.attributes = new Map(); this.className = ''; }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    setAttribute(name, value) { writes.push(name); this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener() {} removeEventListener() {} before() {} contains() { return false; }
  }
  for (const name of ['textContent', 'placeholder', 'type', 'readOnly', 'disabled', 'hidden']) Object.defineProperty(Element.prototype, name, {
    get() { return this.values[name]; },
    set(value) { writes.push(name); this.values[name] = name === 'textContent' || name === 'placeholder' || name === 'type' ? String(value ?? '') : Boolean(value); },
  });
  const document = { activeElement: null, createElement: () => new Element(document) };
  const input = new Element(document), send = new Element(document), hint = new Element(document);
  const form = { ownerDocument: document, querySelector: selector => ({ textarea: input, '.session-send-button': send, '.session-compose-hint': hint })[selector], contains: () => false, addEventListener() {}, removeEventListener() {} };
  const ui = composer.create({ form, nativeText: 'Native', onInput() {}, onError() {}, onSubmit() {}, onAction() {}, onNative() {}, onImages() {} });
  const view = { readOnly: false, submit: true, disabled: false, label: 'Send', actionLabel: 'Send to A', placeholder: 'Message A', inputLabel: 'Input for A',
    hint: 'Enter sends', showNative: true, nativeDisabled: false, nativeLabel: 'Native input of A' };
  ui.update(view);
  const shown = () => ({ label: send.textContent, hint: hint.textContent, hintHidden: hint.hidden, placeholder: input.placeholder, input: input.getAttribute('aria-label'),
    action: send.getAttribute('aria-label'), native: ui.native.getAttribute('aria-label'), nativeHidden: ui.native.hidden, type: send.type, readOnly: input.readOnly });
  const first = shown();
  assert.deepEqual(first, { label: 'Send', hint: 'Enter sends', hintHidden: false, placeholder: 'Message A', input: 'Input for A', action: 'Send to A',
    native: 'Native input of A', nativeHidden: false, type: 'submit', readOnly: false });
  writes.length = 0;
  ui.update({ ...view });
  assert.deepEqual(writes, [], 'an unchanged input is left as it is');
  ui.update({ ...view, hint: 'Waiting for A' });
  assert.deepEqual(writes, ['textContent']);
  assert.equal(hint.textContent, 'Waiting for A');
  writes.length = 0;
  ui.update({ ...view, hint: '', readOnly: true, submit: false, actionLabel: '' });
  assert.deepEqual(shown(), { ...first, hint: '', hintHidden: true, action: null, type: 'button', readOnly: true });
});
