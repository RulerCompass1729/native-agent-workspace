const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
const section = (a, b) => {
  const start = source.indexOf(a), end = source.indexOf(b, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
};

function fixture({ flat = false, archived = false } = {}) {
  const document = { activeElement: null }, nodes = new Map(), persisted = [], notices = [];
  let narrow = true;
  class Element {
    constructor(className = '') { this.className = className; this.dataset = {}; this.children = []; this.value = ''; this.hidden = false; }
    append(child) { child.parentElement = this; this.children.push(child); }
    contains(child) { return this === child || this.children.some(node => node.contains(child)); }
    closest(selector) { for (let e = this; e; e = e.parentElement) if (e.className.split(' ').includes(selector.slice(1))) return e; return null; }
    get classList() { return { add() {}, remove() {} }; }
    getClientRects() { for (let e = this; e; e = e.parentElement) if (e.hidden) return []; return [{}]; }
    focus() { if (this.getClientRects().length) document.activeElement = this; }
    select() {}
  }
  const $ = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const group = id => {
    const element = new Element('session-space-group'), body = new Element();
    element.dataset.sessionGroup = id; element.append(body); return { element, body };
  };
  const groups = new Map(['A', 'B', 'independent'].map(id => [id, group(id)]));
  const row = (id, groupId) => {
    const element = new Element('session-row'), name = new Element(), more = new Element();
    element.append(name); element.append(more); if (groupId) groups.get(groupId).body.append(element);
    return { element, name, more, id };
  };
  const rows = new Map([['A', row('S', flat ? null : 'A')], ['B', row('S', 'B')], ['independent', row('I', 'independent')]]);
  const roomRow = row('room', null), record = { id: 'S', name: 'Original member', nativeId: 'same-native', owner: 'same-owner', liveDraft: 'UNSENT private', archived };
  const state = { sidebar: { workspaceCollapsed: false }, sessions: [record, { id: 'I', name: 'Independent' }] };
  const room = { id: 'A', name: 'Space A' };
  $('rename-editor').append($('rename-name')); $('rename-editor').hidden = true;
  $('header').parentElement = $('header-parent');
  const collapsed = new Set(['A', 'B', 'independent']);
  const render = () => { for (const [id, group] of groups) group.body.hidden = !narrow && collapsed.has(id); };
  const context = vm.createContext({ $, document, state, spaceId: 'A', spaceRecord: () => room,
    spaceRows: new Map([['A', roomRow]]), sessionRows: rows,
    sessionRow: id => rows.get(id === 'I' ? 'independent' : 'A'),
    sidebarCollapsedGroups: collapsed, sidebarGroups: groups,
    ui: { revealSidebar() { narrow = false; render(); }, display: { text() {}, unbind() {} } },
    toastMessage: key => notices.push(key), render, renderSessions: render,
    persistView: () => persisted.push([...collapsed]), attempt: fn => fn(),
  });
  vm.runInContext('let renameTarget=null,renaming=false,renameRevision=0,renameComposing=false;\n'
    + section('function openRename(', 'function renameProblem(')
    + section('function closeRename(', 'function focusSessionAction(')
    + section('function toggleSidebarGroup(', 'function renderSessions() {')
    + '\nglobalThis.rename={openRename,target:()=>renameTarget};', context);
  render();
  return { $, rows, roomRow, spaceRows: context.spaceRows, state, collapsed, groups, persisted, notices, document,
    open: context.rename.openRename, target: context.rename.target,
    narrowAgain() { narrow = true; render(); }, fold(id) { collapsed.add(id); render(); },
  };
}

test('rename from the narrow rail reveals only its folded session group and focuses the editor', () => {
  const f = fixture(), before = JSON.stringify(f.state.sessions);
  f.open('S', f.rows.get('A').more);
  assert.equal(f.collapsed.has('A'), false);
  assert.equal(f.collapsed.has('B'), true);
  assert.equal(f.groups.get('A').body.hidden, false);
  assert.equal(f.$('rename-editor').getClientRects().length, 1);
  assert.equal(f.document.activeElement, f.$('rename-name'));
  assert.equal(f.$('rename-name').value, 'Original member');
  assert.equal(f.persisted.length, 1);
  assert.equal(JSON.stringify(f.state.sessions), before);
});

test('an independent session uses the same reveal path without unfolding spaces', () => {
  const f = fixture(); f.open('I', f.rows.get('independent').more);
  assert.equal(f.collapsed.has('independent'), false);
  assert.equal(f.collapsed.has('A'), true); assert.equal(f.collapsed.has('B'), true);
  assert.equal(f.document.activeElement, f.$('rename-name'));
});

test('a member appearing in two spaces reveals the actual clicked occurrence', () => {
  const f = fixture(); f.open('S', f.rows.get('B').more);
  assert.equal(f.collapsed.has('A'), true); assert.equal(f.collapsed.has('B'), false);
  assert.equal(f.target().row, f.rows.get('B').element);
  assert.equal(f.document.activeElement, f.$('rename-name'));
});

test('an existing dirty editor is revealed in its own group without replacing its draft', () => {
  const f = fixture(); f.open('S', f.rows.get('A').more);
  f.$('rename-name').value = 'UNSENT edited name'; f.fold('A'); f.narrowAgain();
  f.open('S', f.rows.get('B').more);
  assert.equal(f.collapsed.has('A'), false); assert.equal(f.collapsed.has('B'), true);
  assert.equal(f.target().row, f.rows.get('A').element);
  assert.equal(f.$('rename-name').value, 'UNSENT edited name');
  assert.equal(f.document.activeElement, f.$('rename-name'));
  assert.deepEqual(f.notices, ['toast.finishRename']);
  assert.equal(f.state.sessions[0].liveDraft, 'UNSENT private');
});

test('flat session and space editors do not change session fold preferences', () => {
  for (const kind of ['session', 'space']) {
    const f = fixture({ flat: true });
    f.open(kind === 'space' ? 'room' : 'S', kind === 'space' ? null : f.rows.get('A').more, 'A');
    assert.deepEqual([...f.collapsed], ['A', 'B', 'independent']);
    assert.equal(f.persisted.length, 0);
    assert.equal(f.document.activeElement, f.$('rename-name'));
  }
  // renderSpaceNavigation marks the active space even when its sidebar is
  // collapsed. The existing row map supplies this state without a new global.
  const f = fixture({ flat: true });
  f.spaceRows.get('A').nav = { getAttribute: name => name === 'aria-current' ? 'page' : null };
  f.$('title').parentElement = f.$('header-parent');
  f.state.sidebar.workspaceCollapsed = true;
  f.open('room', null, 'A');
  assert.equal(f.target().row, f.$('title').parentElement);
  assert.equal(f.persisted.length, 0);
  assert.deepEqual([...f.collapsed], ['A', 'B', 'independent']);
});

test('an archived member opens no editor or group and changes no stored draft', () => {
  const f = fixture({ archived: true }), before = JSON.stringify(f.state.sessions);
  f.open('S', f.rows.get('A').more);
  assert.equal(f.target(), null); assert.equal(f.persisted.length, 0);
  assert.deepEqual([...f.collapsed], ['A', 'B', 'independent']);
  assert.equal(JSON.stringify(f.state.sessions), before);
});
