const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const localeUI = require('./fixtures/locale-ui.cjs');
const source = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');

class Element {
  constructor() { this.value = ''; this.disabled = false; this.hidden = false; this.open = false; this.isConnected = true; this.textContent = ''; this.children = []; this.events = {}; }
  setAttribute(k, v) { (this.attrs ||= {})[k] = String(v); }
  getAttribute(k) { return this.attrs?.[k] ?? null; }
  removeAttribute(k) { if (this.attrs) delete this.attrs[k]; }
  addEventListener(name, fn) { this.events[name] = fn; }
  querySelectorAll() { return this.children; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { this.focused = true; }
}

function fixture() {
  const elements = new Map(), writes = [], pending = [], errors = [];
  const $ = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const context = vm.createContext({ ...localeUI(), $, selected: 'room', spaceId: 'shared', mode: 'chat', contextTarget: { room: true, roomId: 'shared' },
    selectionRevision: 1, roomDraftRevision: 0, state: {}, disconnected: false,
    attempt: async action => { try { return await action(); } catch (error) { errors.push(error); } },
    render() {}, toastMessage() {}, roomRecipient: () => '',
    persistView: () => {
      writes.push($('shared-input').value);
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
  });
  function load(start, end) {
    const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
    assert.ok(a >= 0 && b > a); vm.runInContext(source.slice(a, b), context);
  }
  load('const dialogTickets =', 'let trustScope =');
  load('let contextSnapshot =', 'function mentionRosterKey(');
  load("$('context-text').addEventListener", "$('share-recipient').onchange");
  function open(text = 'Generated shared') {
    context.openTransientDialog('context-dialog');
    vm.runInContext('contextSnapshot = { text: "Generated shared", spaceIds: ["shared"] }', context);
    $('context-text').value = text; context.updateContextControls();
  }
  open(); $('shared-input').value = 'Original draft';
  return { $, context, writes, pending, errors, open, insert: () => $('insert-context').onclick(), edit(text) { $('context-text').value = text; $('context-text').events.input(); } };
}

test('a pending insertion appends once and rejects repeated activation while keeping the editor editable', async () => {
  const f = fixture(), first = f.insert();
  const pendingDisabled = f.$('insert-context').disabled;
  assert.equal(f.$('context-text').disabled, false);
  const repeated = f.insert();
  assert.deepEqual(f.writes, ['Original draft\n\nGenerated shared']);
  assert.equal(pendingDisabled, true);
  assert.equal(f.context.roomDraftRevision, 1);
  f.pending[0].resolve(); await first;
  await repeated;
});

test('editing during insertion stays local until the person explicitly inserts that newer text', async () => {
  const f = fixture(), first = f.insert();
  f.edit('Newer human context');
  const pendingDisabled = f.$('insert-context').disabled;
  assert.equal(f.$('context-text').disabled, false);
  f.pending[0].resolve(); await first;
  assert.equal(f.$('context-dialog').open, true);
  assert.equal(pendingDisabled, true);
  assert.equal(f.$('context-text').value, 'Newer human context');
  assert.equal(f.$('insert-context').disabled, false);
  assert.deepEqual(f.writes, ['Original draft\n\nGenerated shared']);
  const second = f.insert();
  assert.deepEqual(f.writes, ['Original draft\n\nGenerated shared', 'Original draft\n\nGenerated shared\n\nNewer human context']);
  f.pending[1].resolve(); await second;
  assert.equal(f.$('context-dialog').open, false);
});

test('an unchanged successful insertion closes its own current dialog and returns focus', async () => {
  const f = fixture(), first = f.insert();
  assert.equal(f.$('context-dialog').open, true);
  f.pending[0].resolve(); await first;
  assert.equal(f.$('context-dialog').open, false);
  assert.equal(f.$('shared-input').focused, true);
  assert.equal(f.$('shared-input').value, 'Original draft\n\nGenerated shared');
});

test('reopening the already-open editor preserves its pending insertion ticket', async () => {
  const f = fixture(), first = f.insert();
  f.context.openContext();
  assert.equal(f.$('context-text').focused, true);
  assert.equal(f.$('context-text').value, 'Generated shared');
  const repeated = f.insert();
  assert.equal(f.writes.length, 1);
  assert.equal(f.$('insert-context').disabled, true);
  f.pending[0].resolve(); await first; await repeated;
});

test('a late completion cannot close or unlock a newer opening with its own pending insertion', async () => {
  const f = fixture(), old = f.insert();
  f.$('context-dialog').close(); f.open('New opening');
  assert.equal(f.$('insert-context').disabled, false);
  const fresh = f.insert();
  assert.equal(f.$('insert-context').disabled, true);
  f.pending[0].resolve(); await old;
  assert.equal(f.$('context-dialog').open, true);
  assert.equal(f.$('context-text').value, 'New opening');
  assert.equal(f.$('insert-context').disabled, true);
  f.pending[1].resolve(); await fresh;
  assert.equal(f.$('context-dialog').open, false);
});

test('changing selection while insertion waits keeps the editor open and does not move focus', async () => {
  const f = fixture(), first = f.insert(); f.context.selectionRevision++;
  f.pending[0].resolve(); await first;
  assert.equal(f.$('context-dialog').open, true);
  assert.equal(f.$('shared-input').focused, undefined);
  assert.equal(f.$('insert-context').disabled, false);
});

test('a failed save keeps both edits, releases the pending action and does not automatically insert again', async () => {
  const f = fixture(), first = f.insert(); f.edit('Keep this newer context');
  f.pending[0].reject(new Error('Controlled view save failure')); await first;
  assert.equal(f.$('context-dialog').open, true);
  assert.equal(f.$('context-text').value, 'Keep this newer context');
  assert.equal(f.$('shared-input').value, 'Original draft\n\nGenerated shared');
  assert.equal(f.$('insert-context').disabled, false);
  assert.equal(f.writes.length, 1); assert.equal(f.errors.length, 1);
});

test('oversized or malformed replacement text remains local after the earlier insertion completes', async () => {
  for (const text of ['X'.repeat(12001), String.fromCharCode(0xd800), '   ']) {
    const f = fixture(), first = f.insert(); f.edit(text);
    f.pending[0].resolve(); await first;
    assert.equal(f.$('context-dialog').open, true);
    assert.equal(f.$('context-text').value, text);
    assert.equal(f.$('insert-context').disabled, true);
    assert.equal(f.writes.length, 1);
  }
});
