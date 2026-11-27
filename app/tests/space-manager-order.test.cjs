const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
const slice = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const workers = ['first', 'second', 'manager'].map(id => ({ id, name: id, nativeId: 'native-' + id }));

function room() {
  const stored = ['second', 'first', 'manager'], moves = [], secondary = ['first', 'second'];
  const state = { spaceManagers: { shared: { sessionId: 'manager', nativeId: 'native-manager' } } };
  const context = vm.createContext({
    state,
    spaceId: 'shared',
    members: id => id === 'shared' ? workers : workers.slice(0, 2),
    spaceRecord: id => ({ memberOrder: id === 'shared' ? stored : secondary }),
    participantLabel: member => member.name,
    api: { spaceAction: (...args) => moves.push(structuredClone(args)) },
    uiError: key => Error(key),
  });
  vm.runInContext(slice('function orderedMembers(', '// R248:') +
    slice('async function moveRoomMember(', 'function draggableSession('), context);
  const ordered = id => Array.from(context.orderedMembers(id), row => row.id);
  return { state, ordered, stored, moves, move: (...args) => context.moveRoomMember(...args) };
}

test('the current manager leads each member list without changing the stored order', () => {
  const f = room();
  assert.deepEqual(f.ordered(), ['manager', 'second', 'first']);
  assert.deepEqual(f.ordered('another'), ['first', 'second']);
  assert.deepEqual(f.stored, ['second', 'first', 'manager']);
  f.state.spaceManagers.shared = { sessionId: 'first', nativeId: 'native-first' };
  assert.deepEqual(f.ordered(), ['first', 'second', 'manager']);
  f.state.spaceManagers.shared.nativeId = 'previous-native';
  assert.deepEqual(f.ordered(), f.stored);
  delete f.state.spaceManagers.shared;
  assert.deepEqual(f.ordered(), f.stored);
});

test('visual moves leave the manager pinned and reorder only the ordinary rows', async () => {
  const f = room();
  assert.equal((await f.move('manager', 'second', true)).index, 1);
  await f.move('second', 'manager', false);
  assert.deepEqual(f.moves, []);
  await f.move('first', 'manager', false);
  assert.deepEqual(f.moves, [['shared', 'memberOrder', [{ id: 'first', target: 'second', after: false }]]]);
});
