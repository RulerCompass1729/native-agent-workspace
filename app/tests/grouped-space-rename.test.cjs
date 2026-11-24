const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
function section(a, b) { const i = source.indexOf(a), j = source.indexOf(b, i); assert.ok(i >= 0 && j > i); return source.slice(i, j); }
// Execute the actual section renderer and rename lifecycle. Inherited hidden
// state models DOM visibility; geometry and CSS are qualified in the owned GUI.
function fixture(view = 'grouped') {
  const nodes = new Map(), writes = [], document = { activeElement: null };
  class Element {
    constructor(id) { this.id = id; this.dataset = {}; this.hidden = false; this.children = []; this.value = ''; this.classList = { add() {}, remove() {} }; }
    append(child) { child.parentElement = this; this.children.push(child); }
    insertBefore(child) { this.append(child); }
    contains(child) { return this === child || this.children.some(c => c.contains(child)); }
    querySelector(selector) { return $(this.id + selector); }
    closest() { return null; }
    setAttribute() {}
    focus() { document.activeElement = this; }
    select() {}
    getClientRects() { for (let e = this; e; e = e.parentElement) if (e.hidden) return []; return [{}]; }
  }
  const $ = id => { if (!nodes.has(id)) nodes.set(id, new Element(id)); return nodes.get(id); };
  const room = { id: 'A', name: 'Room A' }, session = { id: 'S', name: 'Member', nativeId: 'original-native', liveDraft: 'UNSENT private' };
  $('workspace-group').append($('workspace-group-body')); $('workspace-group-body').append($('room-A')); $('room-A').append($('room-label-A'));
  $('sessions-group').append($('session-list')); $('session-list').append($('session-S')); $('session-S').append($('session-label-S'));
  $('header').parentElement = $('header-parent'); $('header-identity').append($('title')); $('rename-editor').hidden = true;
  const state = { sidebar: { workspaceCollapsed: false }, room, sessions: [session] };
  const context = vm.createContext({ $, document, state, selected: '', sidebarView: view, spaceId: 'A', allSpaces: () => [room], members: () => [session], spaceRecord: () => room,
    spaceRows: new Map([['A', { element: $('room-A'), name: $('room-label-A') }]]), sessionRows: new Map([['S', { element: $('session-S'), name: $('session-label-S'), more: $('session-more-S') }]]),
    sessionRow: () => ({ element: $('session-S'), name: $('session-label-S'), more: $('session-more-S') }),
    ui: { revealSidebar() {}, display: { text() {}, computed() {}, attribute() {}, unbind() {} } }, uiText: key => key,
    sidebarLayout: { update() {} }, sessionMenu: null, roomMenu: null, toastMessage() {},
    api: { sidebar: async action => { writes.push(action); state.sidebar.workspaceCollapsed = action.collapsed; } }, attempt: fn => fn(),
  });
  document.querySelector = selector => $(selector);
  vm.runInContext('let renameTarget=null,renaming=false,renameRevision=0,renameComposing=false;\n' + section('function renderSidebarGroups()', '// Each grouped-view section')
    + section('function openRename(', 'function renameProblem(') + section('function closeRename(', 'function focusSessionAction(')
    + '\nfunction render(){renderSidebarGroups()}\nglobalThis.rename={openRename,closeRename,target:()=>renameTarget};', context);
  context.renderSidebarGroups();
  return { $, state, writes, context, room, open: context.rename.openRename, close: () => context.rename.closeRename(false), target: context.rename.target };
}
test('normal grouped view has no duplicate space section; room rename exposes only its existing editor lifecycle', () => {
  const f = fixture(), before = JSON.stringify(f.state.sessions);
  assert.equal(f.$('workspace-group').hidden, true); assert.equal(f.$('workspace-group').dataset.groupedSessions, 'true');
  f.open('room', null, 'A'); assert.equal(f.$('rename-editor').getClientRects().length, 1); assert.equal(f.target().row, f.$('room-A'));
  f.$('rename-name').value = 'UNSENT new space name'; f.context.renderSidebarGroups();
  assert.equal(f.$('rename-name').value, 'UNSENT new space name'); assert.equal(f.$('rename-editor').getClientRects().length, 1);
  f.close(); assert.equal(f.$('workspace-group').hidden, true); assert.equal(f.$('rename-editor').hidden, true);
  assert.equal(JSON.stringify(f.state.sessions), before); assert.equal(f.room.name, 'Room A'); assert.equal(f.writes.length, 0);
});
test('flat view preserves its original section and editor row', () => {
  const f = fixture('flat'); f.open('room', null, 'A'); assert.equal(f.$('workspace-group').hidden, false);
  assert.equal(f.$('workspace-group').dataset.groupedSessions, 'false'); assert.equal(f.$('rename-editor').getClientRects().length, 1);
  f.close(); assert.equal(f.$('workspace-group').hidden, false);
});
test('member rename in the grouped list does not reveal duplicate space navigation', () => {
  const f = fixture(); f.open('S'); assert.equal(f.$('workspace-group').hidden, true); assert.equal(f.$('rename-editor').getClientRects().length, 1);
  assert.equal(f.target().id, 'S'); f.close(); assert.equal(f.$('workspace-group').hidden, true);
});
test('the existing folded-section action still unfolds before exposing the same editor', async () => {
  const f = fixture(); f.state.sidebar.workspaceCollapsed = true; await f.open('room', null, 'A');
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].section, 'workspace'); assert.equal(f.writes[0].collapsed, false);
  assert.equal(f.$('rename-editor').getClientRects().length, 1); f.close(); assert.equal(f.$('workspace-group').hidden, true);
});

for (const changed of [{ servicePid: 42, runtimeVersion: 'test-version' }, { servicePid: 41, runtimeVersion: 'development' }]) {
  test('GUI harness refuses a replacement or wrong-version service before opening Create: ' + JSON.stringify(changed), async () => {
    const script = fs.readFileSync(require.resolve('../../scripts/test-grouped-space-rename.cjs'), 'utf8');
    const a = script.indexOf('async function create('), b = script.indexOf('async function openRename()', a);
    assert.ok(a >= 0 && b > a); let touches = 0;
    const context = vm.createContext({ assert, snapshot: async () => changed, child: { pid: 41 }, require: name => { assert.equal(name, '../package.json'); return { version: 'test-version' }; }, page: { locator() { touches++; throw Error('Must not open the UI'); } } });
    vm.runInContext(script.slice(a, b), context);
    await assert.rejects(context.create('Never created', 'claude'), { name: 'AssertionError' }); assert.equal(touches, 0);
  });
}

test('an open space reuses the inline name editor in its title without reviving the hidden member sidebar', () => {
  const f = fixture(); f.context.selected = 'room'; f.state.sidebar.workspaceCollapsed = true;
  // The real renderSpaceNavigation publishes this active-page marker before UI actions.
  f.context.spaceRows.get('A').nav = { getAttribute: name => name === 'aria-current' ? 'page' : null };
  f.context.renderSidebarGroups(); f.open('room', null, 'A');
  assert.equal(f.target().row, f.$('header-identity'));
  assert.equal(f.$('rename-editor').getClientRects().length, 1);
  // 11-23 requirement change: the sessions group stays and lists the space's members; the workspace group stays hidden.
  assert.equal(f.$('workspace-group').hidden, true); assert.equal(f.$('sessions-group').hidden, false);
  assert.equal(f.$('title').hidden, true); assert.deepEqual(f.writes, []);
  f.close(); assert.equal(f.$('title').hidden, false); assert.equal(f.$('rename-editor').hidden, true);
});
