const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const board = require('../renderer/task-board.js');
const now = 1700000000000;
function intake(queue) {
  const source = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
  const start = source.indexOf('function updateTaskBoard() {'), end = source.indexOf('\nconst spaceCall', start);
  assert.ok(start >= 0 && end > start);
  let input;
  const context = vm.createContext({ window: { nativeWorkspaceSpaces: require('../collaboration-spaces.cjs'), nativeWorkspaceFleet: require('../renderer/fleet-observation.js'), nativeWorkspaceAgentDistribution: require('../renderer/agent-distribution.js'), nativeWorkspaceTaskBoard: board },
    state: { sessions: [{ id: 'actor', name: 'Synthetic actor', nativeId: 'native', roomIds: ['space'], state: 'working' }], backgroundConfirmations: [], backgroundConfirmationsAvailable: true },
    disconnected: false, spaceId: 'space', allSpaces: () => [{ id: 'space', name: 'Synthetic space', queue }], spaceName: r => r.name,
    taskBoard: { update(value) { input = value; } } });
  vm.runInContext(source.slice(start, end) + '\nupdateTaskBoard();', context);
  return input;
}
const task = extra => ({ id: 'task', status: 'sent', text: 'Synthetic queue material', sentTo: 'actor', ...extra });
const plain = value => JSON.parse(JSON.stringify(value));

test('real renderer intake projects task dates and only the ready commit', () => {
  const ready = { commit: 'abcdef1234567' }, wait = [null];
  const q = task({ createdAt: now - 2000, sentAt: now - 1000, finishedAt: now, ready, wait });
  const forbidden = () => { throw Error('Non-board material must not be read'); };
  for (const key of ['branch', 'reply', 'text']) Object.defineProperty(ready, key, { enumerable: true, get: forbidden });
  for (const key of ['reply', 'answer', 'arguments', 'unused']) Object.defineProperty(q, key, { enumerable: true, get: forbidden });
  Object.defineProperty(wait, 0, { get: forbidden });
  const input = intake([q]), projected = input.rooms[0].queue[0];
  assert.equal(projected.createdAt, q.createdAt); assert.equal(projected.sentAt, q.sentAt);
  assert.deepEqual(plain(projected.ready), { commit: ready.commit }); assert.notEqual(projected.ready, ready);
  assert.deepEqual(Object.keys(projected).sort(), ['assignee', 'createdAt', 'finishedAt', 'id', 'ready', 'reason', 'sentAt', 'sentTo', 'status', 'text', 'waiting']);
  assert.equal(projected.text, 'Synthetic queue material'); assert.equal(projected.waiting, true);
  assert.equal(Object.hasOwn(projected, 'reply'), false); assert.equal(Object.hasOwn(projected, 'wait'), false);
  const row = board.overview(input, now).groups[0].all[0];
  assert.equal(row.createdAt, q.createdAt); assert.equal(row.sentAt, q.sentAt);
  assert.deepEqual(plain(row.ready), { commit: ready.commit });
});

test('missing task dates stay null instead of borrowing finished or current time', () => {
  const input = intake([task({ finishedAt: now })]), q = input.rooms[0].queue[0];
  assert.equal(q.createdAt, null); assert.equal(q.sentAt, null); assert.equal(q.ready, null);
  const row = board.project(input.rooms, input.sessions, now)[0].all[0];
  assert.equal(row.createdAt, null); assert.equal(row.sentAt, null); assert.equal(row.ready, null);
});

test('invalid dates and non-string commits are not coerced into board metadata', () => {
  for (const value of [null, undefined, '1700000000000', NaN, Infinity, -1]) {
    const q = intake([task({ createdAt: value, sentAt: value, ready: { commit: 123 } })]).rooms[0].queue[0];
    assert.equal(q.createdAt, null); assert.equal(q.sentAt, null); assert.equal(q.ready, null);
  }
  const q = intake([task({ createdAt: 0, sentAt: 1, ready: null })]).rooms[0].queue[0];
  assert.equal(q.createdAt, 0); assert.equal(q.sentAt, 1);
});
// Independent conversations are not board rows since R250 (11-25): task-board-people.test.cjs checks the board lists tasks only.
