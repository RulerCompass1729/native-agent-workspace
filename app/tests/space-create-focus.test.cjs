const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');

function fixture() {
  const elements = new Map(), document = { activeElement: null };
  class Element {
    constructor(id) { this.id = id; this.isConnected = true; this.visible = true; this.disabled = false; this.open = false; this.value = ''; this.listeners = new Map(); this.focusCount = 0; }
    getClientRects() { return this.visible && this.isConnected ? [{}] : []; }
    contains(element) { for (let node = element; node; node = node.parentElement) if (node === this) return true; return false; }
    focus(options) { this.focusCount++; this.focusOptions = options; document.activeElement = this; }
    showModal() { this.open = true; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
  }
  const $ = id => {
    if (!elements.has(id)) {
      const element = new Element(id);
      if (['space-create-name', 'space-create-error', 'confirm-space-create', 'cancel-space-create'].includes(id)) element.parentElement = elements.get('space-create-dialog');
      elements.set(id, element);
    }
    return elements.get(id);
  };
  const dialog = $('space-create-dialog'), other = $('unrelated-dialog');
  document.body = new Element('body'); document.activeElement = document.body;
  document.querySelectorAll = selector => { assert.equal(selector, 'dialog'); return [dialog, other]; };
  document.querySelector = selector => { assert.equal(selector, 'dialog[open]'); return [dialog, other].find(item => item.open) || null; };
  const context = vm.createContext({ $, document, offerManager() {} });
  const tickets = source.slice(source.indexOf('const dialogTickets ='), source.indexOf('let trustScope ='));
  const openStart = source.indexOf('function openSpaceCreate()'), openEnd = source.indexOf('\nlet mergeDialog;', openStart);
  const closeStart = source.indexOf("for (const dialog of document.querySelectorAll('dialog'))"), closeEnd = source.indexOf("$('setup-button').onclick", closeStart);
  assert.ok(openStart >= 0 && openEnd > openStart && closeStart >= 0 && closeEnd > closeStart);
  vm.runInContext(tickets + '\n' + source.slice(openStart, openEnd) + '\n' + source.slice(closeStart, closeEnd) + '\nglobalThis.ticket = () => dialogTickets.get($("space-create-dialog"));', context);
  const open = (opener = $('new-space')) => { document.activeElement = opener; context.openSpaceCreate(); return opener; };
  const close = (active = document.body) => { dialog.open = false; document.activeElement = active; dialog.listeners.get('close')(); };
  return { $, document, dialog, other, open, close, ticket: context.ticket };
}

for (const unavailable of ['hidden', 'disconnected']) test('closing after the opener becomes ' + unavailable + ' restores an existing contextual control', () => {
  const f = fixture(), opener = f.open(), fallback = f.$('workspace-toggle');
  if (unavailable === 'hidden') opener.visible = false; else opener.isConnected = false;
  f.$('space-create-name').value = 'Unsaved name remains unchanged';
  f.close();
  assert.equal(f.document.activeElement, fallback);
  assert.equal(fallback.focusCount, 1);
  assert.equal(fallback.focusOptions.preventScroll, true);
  assert.equal(f.$('space-create-name').value, 'Unsaved name remains unchanged');
});

test('ordinary native focus on the visible opener is preserved', () => {
  const f = fixture(), opener = f.open(); f.close(opener);
  assert.equal(f.document.activeElement, opener); assert.equal(f.$('workspace-toggle').focusCount, 0);
});

test('BODY alone does not authorize replacing a still visible opener', () => {
  const f = fixture(); f.open(); f.close();
  assert.equal(f.document.activeElement, f.document.body); assert.equal(f.$('workspace-toggle').focusCount, 0);
});

test('an already focused real control is never replaced', () => {
  const f = fixture(), opener = f.open(), input = f.$('shared-input'); opener.visible = false; f.close(input);
  assert.equal(f.document.activeElement, input); assert.equal(f.$('workspace-toggle').focusCount, 0);
});

test('another open modal prevents background focus restoration even when BODY is active', () => {
  const f = fixture(), opener = f.open(); opener.visible = false; f.other.open = true; f.close();
  assert.equal(f.document.activeElement, f.document.body); assert.equal(f.$('workspace-toggle').focusCount, 0);
});

test('a queued old close cannot affect a reopened dialog or its current ticket and edit', () => {
  const f = fixture(), old = f.open(); old.visible = false; f.dialog.open = false;
  const fresh = f.$('workspace-toggle'); f.open(fresh); const ticket = f.ticket();
  f.$('space-create-name').value = 'New opening draft'; f.dialog.listeners.get('close')();
  assert.equal(f.dialog.open, true); assert.equal(f.ticket(), ticket);
  assert.equal(f.$('space-create-name').value, 'New opening draft'); assert.equal(fresh.focusCount, 0);
});

for (const unavailable of ['hidden', 'disabled', 'disconnected']) test('a ' + unavailable + ' fallback never receives focus', () => {
  const f = fixture(), opener = f.open(), fallback = f.$('workspace-toggle'); opener.visible = false;
  if (unavailable === 'hidden') fallback.visible = false;
  if (unavailable === 'disabled') fallback.disabled = true;
  if (unavailable === 'disconnected') fallback.isConnected = false;
  f.close(); assert.equal(f.document.activeElement, f.document.body); assert.equal(fallback.focusCount, 0);
});

test('an unrelated dialog close does not apply the space-create fallback', () => {
  const f = fixture(), opener = f.open(); opener.visible = false; f.dialog.open = false;
  f.document.activeElement = f.document.body; f.other.listeners.get('close')();
  assert.equal(f.document.activeElement, f.document.body); assert.equal(f.$('workspace-toggle').focusCount, 0);
});

test('a close without an owned opening ticket does not invent an opener', () => {
  const f = fixture(); f.close();
  assert.equal(f.document.activeElement, f.document.body); assert.equal(f.$('workspace-toggle').focusCount, 0);
});

test('native close may still focus Cancel inside the closed dialog before later falling to BODY', () => {
  const f = fixture(), opener = f.open(), cancel = f.$('cancel-space-create'); opener.visible = false;
  f.close(cancel);
  assert.equal(f.document.activeElement, f.$('workspace-toggle'));
  assert.equal(f.$('workspace-toggle').focusCount, 1);
});

test('a control inside another closed dialog is not stolen', () => {
  const f = fixture(), opener = f.open(), input = f.$('another-dialog-input'); opener.visible = false; input.parentElement = f.other;
  f.close(input);
  assert.equal(f.document.activeElement, input); assert.equal(f.$('workspace-toggle').focusCount, 0);
});

test('another open modal also protects focus while the closed space dialog still owns Cancel', () => {
  const f = fixture(), opener = f.open(), cancel = f.$('cancel-space-create'); opener.visible = false; f.other.open = true;
  f.close(cancel);
  assert.equal(f.document.activeElement, cancel); assert.equal(f.$('workspace-toggle').focusCount, 0);
});
