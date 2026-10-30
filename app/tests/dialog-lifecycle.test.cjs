const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
class Element {
  constructor(text = '') { this.textContent = text; this.open = false; this.isConnected = true; this.children = []; this.value = ''; this.hidden = true; this.disabled = false; }
  append(...values) { this.children.push(...values); }
  replaceChildren(...values) { this.children = values; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
const pending = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { resolve, reject, promise }; };
function fixture() {
  const elements = new Map(), calls = [], messages = [];
  const $ = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const context = vm.createContext({ $, state: { appVersion: 'fixture', room: { notes: 'Saved original', metadataRevision: 7 } }, notesRevision: 0,
    toast: text => messages.push(text), node: (_tag, text) => new Element(text), button: (text, onclick) => Object.assign(new Element(text), { onclick }), createReadiness() {},
    api: Object.fromEntries(['preflight', 'roomNotes', 'runtimeLocation'].map(method => [method, (...args) => { const request = pending(); calls.push({ method, args, ...request }); return request.promise; }])) });
  vm.runInContext(source.slice(source.indexOf('const dialogTickets ='), source.indexOf('let trustScope =')), context);
  vm.runInContext(source.slice(source.indexOf('async function showSetup()'), source.indexOf('function populateSelect(')), context);
  vm.runInContext(source.slice(source.indexOf('function openNotes()'), source.indexOf('function openContext()')), context);
  vm.runInContext(source.slice(source.indexOf("$('room-notes').onclick"), source.indexOf("$('attach-context').onclick")), context);
  const openNotes = text => { context.openNotes(); if (text !== undefined) $('room-notes-text').value = text; };
  const save = () => $('notes-form').onsubmit({ preventDefault() {} });
  return { $, context, calls, messages, openNotes, save };
}
const preflight = () => ({ paths: {}, configured: {} });
test('an old setup result cannot reopen a closed window or overwrite a newer check', async () => {
  const f = fixture(), old = f.context.showSetup(); assert.equal(f.$('setup-dialog').open, true);
  f.$('setup-dialog').close(); const fresh = f.context.showSetup(); f.calls[0].resolve(preflight()); await old;
  assert.equal(f.$('setup-status').children[0].textContent, '正在检查本机程序…');
  f.$('setup-dialog').close(); f.calls[1].resolve(preflight()); await fresh;
  assert.equal(f.$('setup-dialog').open, false); assert.equal(f.$('setup-status').children[0].textContent, '正在检查本机程序…');
});
test('a late program-choice acknowledgement does not request a new setup window after dismissal', async () => {
  const f = fixture(), work = f.context.showSetup(); f.calls[0].resolve(preflight()); await work;
  const row = f.$('setup-status').children[0], actions = row.children.at(-1), choice = actions.children.find(e => e.textContent === '选择已有程序…');
  const selecting = choice.onclick(); assert.equal(f.calls[1].method, 'runtimeLocation');
  f.$('setup-dialog').close(); f.calls[1].resolve(); await selecting;
  assert.equal(f.calls.length, 2); assert.equal(f.$('setup-dialog').open, false);
});
test('an earlier accepted save cannot close the new notes editor or discard its edits', async () => {
  const f = fixture(); f.openNotes('First accepted edit'); const old = f.save(); f.$('notes-dialog').close(); f.openNotes('New unsaved edit');
  f.calls[0].resolve(); await old;
  assert.equal(f.$('notes-dialog').open, true); assert.equal(f.$('room-notes-text').value, 'New unsaved edit');
  assert.deepEqual(f.calls[0].args, ['First accepted edit', 7]); assert.deepEqual(f.messages, ['此前提交的笔记已保存。']);
});
test('an earlier save failure does not write into a new notes editor', async () => {
  const f = fixture(); f.openNotes('First'); const old = f.save(); f.$('notes-dialog').close(); f.openNotes('Fresh');
  f.calls[0].reject(Error('Synthetic old failure')); await old;
  assert.equal(f.$('notes-error').hidden, true); assert.equal(f.$('room-notes-text').value, 'Fresh'); assert.equal(f.$('notes-dialog').open, true);
  assert.deepEqual(f.messages, ['此前提交的笔记未能保存：Synthetic old failure']);
});
test('an earlier finally cannot re-enable a newer in-flight save', async () => {
  const f = fixture(); f.openNotes('First'); const old = f.save(); f.$('notes-dialog').close(); f.openNotes('Second'); const fresh = f.save();
  f.calls[0].resolve(); await old; assert.equal(f.$('save-notes').disabled, true);
  f.calls[1].resolve(); await fresh; assert.equal(f.$('notes-dialog').open, false);
});
test('one open editor prevents duplicate saves and retains retry input after a current failure', async () => {
  const f = fixture(); f.openNotes('Keep this'); const work = f.save(); await f.save(); assert.equal(f.calls.length, 1);
  f.calls[0].reject(Error('Synthetic current failure')); await work;
  assert.equal(f.$('notes-error').hidden, false); assert.equal(f.$('save-notes').disabled, false); assert.equal(f.$('room-notes-text').value, 'Keep this');
  const retry = f.save(); f.calls[1].resolve(); await retry; assert.equal(f.$('notes-dialog').open, false);
});
test('a detached editor acknowledgement never closes a newly mounted editor', async () => {
  const f = fixture(); f.openNotes('Before remount'); const work = f.save(), dialog = f.$('notes-dialog'); dialog.isConnected = false;
  f.calls[0].resolve(); await work; assert.equal(dialog.open, true); assert.equal(f.context.state.room.notes, 'Saved original');
});

test('Escape blur cannot persist a terminal display edit after the dialog has closed', async () => {
  const f = fixture(), writes = [];
  Object.assign(f.context, { attempt: action => action(), terminalDisplay: { fontSize: 14, palette: 'dark' }, applyTerminalDisplay() {}, persistView: async () => writes.push(structuredClone(f.context.terminalDisplay)) });
  vm.runInContext(source.slice(source.indexOf('const saveTerminalDisplay ='), source.indexOf("$('terminal-font-size').onchange")) + '\nglobalThis.saveDisplay = saveTerminalDisplay;', f.context);
  f.$('terminal-font-size').value = '18'; f.$('terminal-palette').value = 'green';
  await f.context.saveDisplay(); assert.equal(writes.length, 0); assert.equal(f.context.terminalDisplay.fontSize, 14);
  f.$('terminal-display-dialog').showModal(); await f.context.saveDisplay();
  assert.deepEqual(writes, [{ fontSize: 18, palette: 'green' }]);
});
test('a queued search render after close does not rebuild private results', () => {
  const search = fs.readFileSync(require.resolve('../renderer/search-view.js'), 'utf8'), f = fixture();
  Object.assign(f.context, { clearTimeout() {}, searchTimer: 1, searchOrigin: { selected: 'fixture' }, ui: { clearMarkdown() { throw Error('Closed results touched'); } } });
  vm.runInContext(search.slice(search.indexOf('function renderSearch()'), search.indexOf('function searchInputKey(')), f.context);
  f.context.renderSearch(); assert.equal(f.$('search-results').children.length, 0);
});

test('a pending create keeps Cancel available while duplicate folder changes stay disabled', () => {
  const f = fixture(); f.$('create-dialog').showModal();
  Object.assign(f.context, { document: { querySelector: () => ({ value: 'codex' }) }, creatingSession: true, newDirectory: false });
  f.context.state.capabilities = ['nativePermissionDefaults', 'nativeHistory']; f.context.state.preflight = { codex: true, python: true };
  vm.runInContext(source.slice(source.indexOf('function createReadiness()'), source.indexOf('function renderArchives()')), f.context);
  f.context.createReadiness(); assert.equal(f.$('cancel-create').disabled, false); assert.equal(f.$('choose-folder').disabled, true); assert.equal(f.$('new-folder').disabled, true); assert.equal(f.$('confirm-create').disabled, true);
});
