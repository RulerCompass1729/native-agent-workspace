const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
class Element {
  constructor() { this.value = ''; this.hidden = false; this.disabled = false; this.open = false; this.isConnected = true; this.children = []; this.textContent = ''; this.events = {}; this.dataset = {}; }
  addEventListener(name, fn) { this.events[name] = fn; }
  querySelectorAll(selector) { return selector === 'input:checked' ? this.children.filter(child => child.checked) : this.children; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { this.focused = true; }
}
function fixture() {
  const elements = new Map(), copies = [], problems = [], writes = [], builds = [];
  const $ = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const context = vm.createContext({ $, selected: 'room', spaceId: 'shared', mode: 'chat', roomSession: '', contextTarget: { room: true, roomId: 'shared' },
    selectionRevision: 1, roomDraftRevision: 0, state: { fixture: true }, disconnected: false,
    attempt: action => action(), render() {}, toast: text => problems.push(text), roomRecipient: () => '',
    persistView: async () => writes.push($('shared-input').value), api: { copy: async text => copies.push(text) },
    window: { nativeWorkspaceContextSnapshot: { build: (state, ids, options) => { builds.push({ state, ids: [...ids], options }); return { text: 'Generated ' + ids.join(','), spaceIds: [...ids] }; } } },
  });
  vm.runInContext(source.slice(source.indexOf('const dialogTickets ='), source.indexOf('let trustScope =')), context);
  vm.runInContext(source.slice(source.indexOf('let contextSnapshot ='), source.indexOf('function mentionRosterKey(')), context);
  vm.runInContext(source.slice(source.indexOf("$('context-text').addEventListener"), source.indexOf("$('share-recipient').onchange")), context);
  context.openTransientDialog('context-dialog');
  vm.runInContext("contextSnapshot = {text:'Generated shared',spaceIds:['shared']}", context);
  $('context-text').value = 'Generated shared'; $('shared-input').value = '@S original draft';
  return { $, context, copies, problems, writes, builds };
}

test('a changed room or closed ticket cannot append context or change the original draft', async () => {
  const f = fixture(); f.context.spaceId = 'other-space';
  await f.$('insert-context').onclick();
  assert.equal(f.$('shared-input').value, '@S original draft'); assert.deepEqual(f.writes, []);
  assert.equal(f.$('context-error').hidden, false); assert.match(f.$('context-error').textContent, /视图已变化/);
  f.context.spaceId = 'shared'; f.$('context-dialog').close();
  await f.$('insert-context').onclick(); assert.deepEqual(f.writes, []);
});

test('the existing 16000 combined-draft limit refuses insertion without changing either edit', async () => {
  const f = fixture(), draft = 'D'.repeat(15990); f.$('shared-input').value = draft;
  await f.$('insert-context').onclick();
  assert.equal(f.$('shared-input').value, draft); assert.equal(f.$('context-text').value, 'Generated shared');
  assert.deepEqual(f.writes, []); assert.equal(f.$('context-dialog').open, true);
  assert.match(f.$('context-error').textContent, /16000/);
});

test('valid insertion uses the actual draft append path once and closes only its current dialog', async () => {
  const f = fixture(); await f.$('insert-context').onclick();
  assert.equal(f.$('shared-input').value, '@S original draft\n\nGenerated shared');
  assert.deepEqual(f.writes, ['@S original draft\n\nGenerated shared']);
  assert.equal(f.context.roomDraftRevision, 1); assert.equal(f.$('context-dialog').open, false);
  assert.equal(f.$('shared-input').focused, true); assert.deepEqual(f.copies, []);
});

test('copy guards keep malformed or oversized manual text local; a valid copy does not append or send', async () => {
  const f = fixture();
  for (const text of ['', 'X'.repeat(12001), String.fromCharCode(0xd800)]) {
    f.$('context-text').value = text; await f.$('copy-context').onclick();
    assert.equal(f.$('context-text').value, text); assert.deepEqual(f.copies, []);
  }
  f.$('context-text').value = 'Explicitly edited human context'; await f.$('copy-context').onclick();
  assert.deepEqual(f.copies, ['Explicitly edited human context']); assert.deepEqual(f.writes, []);
  assert.equal(f.$('shared-input').value, '@S original draft');
});

test('edited text freezes scope without regenerating; reverting allows selected-only generation with current connection state', () => {
  const f = fixture(), a = new Element(), b = new Element(); a.dataset.contextSpace = 'shared'; b.dataset.contextSpace = 'B';
  a.checked = false; b.checked = true; f.$('context-space-choices').children = [a, b];
  f.$('context-text').value = 'Generated shared\nHuman edit'; f.$('context-text').events.input();
  assert.equal(f.$('context-spaces').disabled, true); assert.equal(f.$('context-scope-note').hidden, false);
  f.context.generateContextPreview(); assert.deepEqual(f.builds, []);
  assert.equal(a.checked, true); assert.equal(b.checked, false); assert.equal(f.$('context-text').value, 'Generated shared\nHuman edit');
  f.$('context-text').value = 'Generated shared'; f.$('context-text').events.input();
  assert.equal(f.$('context-spaces').disabled, false);
  a.checked = false; b.checked = true; f.context.disconnected = true; f.context.generateContextPreview();
  assert.equal(f.builds.length, 1); assert.deepEqual(f.builds[0].ids, ['B']); assert.equal(f.builds[0].options.connected, false);
  assert.equal(f.$('context-text').value, 'Generated B');
});

test('a repeated open of the same editor preserves its transient human text and scope', () => {
  const f = fixture(); f.$('context-text').value = 'Keep this uninserted edit';
  f.context.openContext();
  assert.equal(f.$('context-text').value, 'Keep this uninserted edit'); assert.deepEqual(f.builds, []);
  assert.equal(f.$('context-text').focused, true);
});
