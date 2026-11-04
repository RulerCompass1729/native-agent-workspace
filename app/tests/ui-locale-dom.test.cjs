const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const locale = require('../ui-locale.js');
const messages = require('../ui-messages.js');
const bootstrap = fs.readFileSync(path.join(__dirname, '../dsh/bootstrap.js'), 'utf8');
const start = bootstrap.indexOf('    function createDisplayBindings(');
const end = bootstrap.indexOf('    function mountWorkspace(', start);
assert.ok(start >= 0 && end > start);
const createBindings = vm.runInNewContext('(' + bootstrap.slice(start, end).trim() + ')');

// The fixture supplies only the DOM operations used by the actual helper.
// It neither translates content nor implements the binding behaviour itself.
class Element {
  constructor(text = '', attributes = {}, children = []) {
    this.content = text; this.attrs = new Map(Object.entries(attributes)); this.children = children;
    this.textWrites = 0; this.attributeWrites = 0;
  }
  get childElementCount() { return this.children.length; }
  get textContent() { return this.content; }
  set textContent(value) { this.textWrites++; this.content = String(value); this.children = []; }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  hasAttribute(name) { return this.attrs.has(name); }
  setAttribute(name, value) { this.attributeWrites++; this.attrs.set(name, String(value)); }
  removeAttribute(name) { this.attrs.delete(name); }
  querySelectorAll(selector) {
    const names = selector.split(',').map(part => part.trim().slice(1, -1));
    return this.children.flatMap(child => [...(names.some(name => child.hasAttribute(name)) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
}
function fixture() {
  let language = 'zh';
  const bindings = createBindings((key, params) => locale.format(language, key, params));
  return { bindings, setLanguage(value) { language = value; } };
}

test('changing language preserves controls, values, handlers, icons, original bodies and focus', () => {
  const f = fixture();
  const label = new Element('', { 'data-naw-text': 'search.open' });
  const icon = new Element('ICON');
  const rail = new Element('', { 'aria-label': '', 'data-naw-aria-label': 'search.open' }, [icon, label]);
  const input = new Element('', { 'placeholder': '', 'data-naw-placeholder': 'search.placeholder' });
  const file = new Element('ORIGINAL 中文 <native>{key}', { 'aria-label': '', 'data-naw-aria-label': 'file.contents' });
  const option = new Element('', { 'data-naw-text': 'terminal.dark' });
  const select = new Element('', {}, [option]);
  const root = new Element('', {}, [rail, input, file, select]);
  const handler = () => {}; rail.onclick = handler; rail.hidden = true; rail.disabled = true;
  input.value = 'UNSENT 中文 query'; input.selectionStart = 2; input.selectionEnd = 7;
  select.value = 'dark'; select.selectedIndex = 0; option.value = 'dark';
  const document = { activeElement: input };
  f.bindings.template(root);
  assert.equal(label.textContent, messages.zh['search.open']);
  const writes = label.textWrites; f.bindings.refresh(root);
  assert.equal(label.textWrites, writes, 'Same-value refresh must preserve the existing text node');
  f.setLanguage('en'); f.bindings.refresh(root);
  assert.equal(label.textContent, 'Find sessions and records');
  assert.deepEqual(rail.children, [icon, label]);
  assert.equal(rail.onclick, handler); assert.equal(rail.hidden, true); assert.equal(rail.disabled, true);
  assert.equal(rail.getAttribute('aria-label'), 'Find sessions and records');
  assert.equal(input.getAttribute('placeholder'), 'Find a session or message\u2026');
  assert.equal(input.value, 'UNSENT 中文 query'); assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 7);
  assert.equal(document.activeElement, input);
  assert.equal(file.textContent, 'ORIGINAL 中文 <native>{key}'); assert.equal(file.textWrites, 0);
  assert.equal(file.getAttribute('aria-label'), 'File contents');
  assert.equal(select.value, 'dark'); assert.equal(select.selectedIndex, 0); assert.equal(option.value, 'dark');
  assert.equal(option.textContent, 'Neutral dark');
});

test('native or user markup cannot gain a translation binding by forging template attributes', () => {
  const f = fixture();
  const own = new Element('', { 'data-naw-text': 'common.copy' });
  const root = new Element('', {}, [own]);
  f.bindings.template(root);
  assert.equal(own.hasAttribute('data-naw-text'), false);
  const forged = new Element('ORIGINAL RAW 复制', { 'data-naw-text': 'common.copy', 'data-naw-i18n-bound': '' });
  root.children.push(forged);
  f.setLanguage('en'); f.bindings.refresh(root);
  assert.equal(own.textContent, 'Copy');
  assert.equal(forged.textContent, 'ORIGINAL RAW 复制'); assert.equal(forged.textWrites, 0);
});

test('a dynamic slot can drop only its text binding while preserving its independent accessible name', () => {
  const f = fixture(), el = new Element();
  const root = new Element('', {}, [el]);
  f.bindings.text(el, 'common.copy');
  f.bindings.attribute(el, 'aria-label', 'common.copy');
  f.bindings.unbind(el); el.textContent = 'USER NAME 中文 Copy';
  f.setLanguage('en'); f.bindings.refresh(root);
  assert.equal(el.textContent, 'USER NAME 中文 Copy'); assert.equal(el.getAttribute('aria-label'), 'Copy');
  f.bindings.unbind(el, 'aria-label');
  assert.equal(el.hasAttribute('data-naw-i18n-bound'), false);
});

test('owned ordering descriptions repaint without restoring a cleared drag hint', () => {
  const f = fixture(), el = new Element(), root = new Element('', {}, [el]);
  f.bindings.attribute(el, 'aria-description', 'collab.orderPosition', () => ({ index: 1, count: 2, help: '' }));
  f.bindings.attribute(el, 'data-order-hint', 'collab.orderAfter'); f.setLanguage('en'); f.bindings.refresh(root);
  assert.match(el.getAttribute('aria-description'), /Position 1 of 2/); assert.equal(el.getAttribute('data-order-hint'), 'Move after this member');
  f.bindings.unbind(el, 'data-order-hint'); el.removeAttribute('data-order-hint'); f.setLanguage('zh'); f.bindings.refresh(root);
  assert.equal(el.getAttribute('data-order-hint'), null); assert.match(el.getAttribute('aria-description'), /第 1 位/);
});

test('parameters stay raw and can be read without storing a translated body', () => {
  const f = fixture(), el = new Element(), root = new Element('', {}, [el]);
  let app = '中文 <native>{app}';
  f.bindings.text(el, 'menu.about', () => ({ app }));
  f.setLanguage('en'); f.bindings.refresh(root);
  assert.equal(el.textContent, 'About 中文 <native>{app}');
  app = 'NEW 原文'; f.bindings.refresh(root); assert.equal(el.textContent, 'About NEW 原文');
});

test('binding text to a container refuses before deleting child controls; input values are not bindable', () => {
  const f = fixture(), input = new Element(), label = new Element('', {}, [input]);
  assert.throws(() => f.bindings.text(label, 'search.archived'), /leaf/);
  assert.equal(label.children[0], input); assert.equal(label.textWrites, 0);
  for (const attribute of ['value', 'innerHTML', 'src', 'href', 'onclick']) {
    assert.throws(() => f.bindings.attribute(input, attribute, 'common.copy'), /Unsupported/);
  }
});

test('known backend errors repaint, but a later raw error clears that binding even when its text matches', () => {
  const { uiError } = require('../ui-errors.cjs');
  const f = fixture(), element = new Element(), root = new Element('', {}, [element]);
  const start = bootstrap.indexOf('        function showError('), end = bootstrap.indexOf('        const language =', start);
  assert.ok(start >= 0 && end > start);
  const showError = vm.runInNewContext('(' + bootstrap.slice(start, end).trim() + ')', { display: f.bindings, window: { nativeWorkspaceLocale: locale } });
  const known = uiError('error.sessionMissing');
  showError(element, known); f.setLanguage('en'); f.bindings.refresh(root);
  assert.equal(element.textContent, 'This session could not be found.');
  showError(element, Error(known.message)); f.bindings.refresh(root);
  assert.equal(element.textContent, known.message, 'Raw native/old error must not be identified by text equality');
  assert.equal(element.hasAttribute('data-naw-i18n-bound'), false);
});

test('the actual toast writer removes an earlier translation binding before displaying raw content', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  const start = source.indexOf('function toast('), end = source.indexOf('function sessionNotice(', start);
  assert.ok(start >= 0 && end > start);
  const f = fixture(), text = new Element(), root = new Element('', {}, [text]);
  const container = { querySelector: () => null, hidden: true };
  const context = vm.createContext({ ui: { display: f.bindings }, $: id => id === 'toast' ? container : text,
    document: { activeElement: {} }, clearTimeout() {}, setTimeout: () => 1, toastTimer: null });
  vm.runInContext(source.slice(start, end), context);
  f.bindings.text(text, 'error.sessionMissing');
  context.toast('RAW native 中文 复制'); f.setLanguage('en'); f.bindings.refresh(root);
  assert.equal(text.textContent, 'RAW native 中文 复制'); assert.equal(text.hasAttribute('data-naw-i18n-bound'), false);
});

test('every project template binding has a catalog key and text bindings target only empty leaf nodes', () => {
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  const tags = [...html.matchAll(/<([a-z][\w-]*)([^<>]*\bdata-naw-(?:text|aria-label|title|placeholder)="[^<>]*?)>/g)];
  assert.ok(tags.length > 40, 'Check the actual template, including help and accessibility labels');
  for (const match of tags) {
    for (const binding of match[2].matchAll(/data-naw-(text|aria-label|title|placeholder)="([^"]+)"/g)) {
      assert.equal(typeof messages.en[binding[2]], 'string', binding[2]);
      assert.equal(typeof messages.zh[binding[2]], 'string', binding[2]);
      if (binding[1] === 'text') assert.ok(html.slice(match.index + match[0].length).startsWith('</' + match[1] + '>'), binding[2]);
    }
  }
  for (const id of ['file-content', 'file-title', 'file-info', 'file-error', 'search-preview-body', 'search-preview-title', 'search-results', 'privacy-heading', 'clear-shared-history', 'refresh-trust', 'native-pane-title', 'message-input', 'shared-input']) {
    const tag = html.match(new RegExp('<[a-z][^<>]*\\bid="' + id + '"[^<>]*>'));
    assert.ok(tag, id); assert.ok(!tag[0].includes('data-naw-text='), id + ' contains dynamic or raw content');
  }
});
