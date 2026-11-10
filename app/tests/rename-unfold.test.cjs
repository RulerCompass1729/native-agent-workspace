const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
const section = (start, end) => {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
};

function fixture() {
  const pending = [], errors = [], nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', hidden: false, textContent: '', dataset: {},
      classList: { add() {}, remove() {} }, append() {}, focus() {}, select() {},
      getClientRects() { return [{}]; },
      closest() { return null; },
    });
    return nodes.get(id);
  };
  $('header').parentElement = $('header-parent');
  const rooms = new Map(['A', 'B'].map(id => [id, { id, name: 'Room ' + id }]));
  const state = { sidebar: { workspaceCollapsed: true }, sessions: [{ id: 'S', name: 'Session S' }] };
  const sessionRows = new Map([['S', { element: $('session-S'), name: $('session-label-S'), more: $('session-more-S') }]]);
  const context = vm.createContext({
    state, spaceId: 'A', spaceRecord: id => rooms.get(id),
    spaceRows: new Map([...rooms.keys()].map(id => [id, { element: $('room-' + id), name: $('room-label-' + id) }])),
    sessionRows, sessionRow: id => sessionRows.get(id), $,
    ui: { revealSidebar() {}, display: { text() {}, unbind() {} } },
    toastMessage() {}, render() {},
    api: { sidebar: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) },
    attempt: async action => { try { return await action(); } catch (error) { errors.push(error.message); } },
  });
  vm.runInContext('let renameTarget = null, renaming = false, renameRevision = 0, renameComposing = false;\n'
    + section('function openRename(', 'function renameProblem(')
    + section('function closeRename(', 'function focusSessionAction(')
    + section("$('cancel-rename').onclick =", "$('rename-name').addEventListener('compositionstart'")
    + '\nglobalThis.rename = { openRename, target: () => renameTarget && ({ id: renameTarget.id, roomId: renameTarget.roomId }) };', context);
  return {
    $, state, pending, errors, open: context.rename.openRename,
    target: () => context.rename.target(),
    type(value) { $('rename-name').value = value; $('rename-name').oninput(); },
    cancel() { $('cancel-rename').onclick(); },
  };
}

test('a folded workspace still opens its own rename editor after unfolding', async () => {
  const f = fixture(), work = f.open('room', null, 'A');
  assert.equal(f.target(), null); assert.equal(f.pending.length, 1);
  f.pending[0].resolve(); await work;
  assert.equal(f.target().roomId, 'A'); assert.equal(f.$('rename-name').value, 'Room A');
});

test('an unfolded workspace opens synchronously without another sidebar action', () => {
  const f = fixture(); f.state.sidebar.workspaceCollapsed = false; f.open('room', null, 'A');
  assert.equal(f.pending.length, 0); assert.equal(f.target().roomId, 'A');
});

test('an old unfold cannot replace a newer untouched session editor', async () => {
  const f = fixture(), work = f.open('room', null, 'A'); f.open('S');
  assert.equal(f.target().id, 'S'); f.pending[0].resolve(); await work;
  assert.equal(f.target().id, 'S'); assert.equal(f.$('rename-name').value, 'Session S');
});

test('an old unfold retains a newer typed rename draft', async () => {
  const f = fixture(), work = f.open('room', null, 'A'); f.open('S'); f.type('Unsaved synthetic name');
  f.pending[0].resolve(); await work;
  assert.equal(f.target().id, 'S'); assert.equal(f.$('rename-name').value, 'Unsaved synthetic name');
});

test('an old unfold does not resurrect its editor after a newer editor is cancelled', async () => {
  const f = fixture(), work = f.open('room', null, 'A'); f.open('S'); f.cancel();
  assert.equal(f.target(), null); f.pending[0].resolve(); await work; assert.equal(f.target(), null);
});

for (const order of [[0, 1], [1, 0]]) test('the latest pending workspace rename wins completion order ' + order.join(','), async () => {
  const f = fixture(), work = [f.open('room', null, 'A'), f.open('room', null, 'B')];
  assert.equal(f.pending.length, 2); f.pending[order[0]].resolve(); await work[order[0]];
  if (order[0] === 0) assert.equal(f.target(), null, 'The older result must not open an editor while the newer request is pending');
  f.pending[order[1]].resolve(); await work[order[1]];
  assert.equal(f.target().roomId, 'B'); assert.equal(f.$('rename-name').value, 'Room B');
});

test('an early unfold broadcast followed by another room rename invalidates the old reply', async () => {
  const f = fixture(), work = f.open('room', null, 'A');
  f.state.sidebar.workspaceCollapsed = false; f.open('room', null, 'B');
  f.pending[0].resolve(); await work; assert.equal(f.target().roomId, 'B');
});

test('a rejected unfold retains its error and opens no rename editor', async () => {
  const f = fixture(), work = f.open('room', null, 'A');
  f.pending[0].reject(Error('Synthetic unfold refusal')); await work;
  assert.equal(f.target(), null); assert.deepEqual(f.errors, ['Synthetic unfold refusal']);
});
