const test = require('node:test'), assert = require('node:assert/strict');
const board = require('../renderer/task-board.js');
const now = new Date(2026, 10, 18, 12).getTime(), start = new Date(2026, 10, 18).getTime();
const room = queue => ({ id: 'a', name: 'Example', queue });
const task = (status, id, extra = {}) => ({ id, status, text: 'Synthetic task', ...extra });
test('300 old outcomes do not hide four sent and one queued task', () => {
  const queue = Array.from({ length: 300 }, (_, i) => task(i < 293 ? 'done' : 'cancelled', 'old' + i, { finishedAt: start - 1 }));
  queue.push(...Array.from({ length: 4 }, (_, i) => task('sent', 'sent' + i)), task('queued', 'queued'));
  const [project] = board.project([room(queue)], [], now);
  assert.equal(project.current.length, 5); assert.equal(project.transit, 5);
  assert.equal(project.counts.sent, 4); assert.equal(project.counts.queued, 1); assert.equal(project.all.length, 305);
});
test('old decisions and reviews form the full transit count; failed and unknown stay separate', () => {
  const [p] = board.project([room([task('sent', 's'), task('waiting', 'w'), task('waiting', 'v', { reason: 'no-reply' }), task('failed', 'f'), task('new-status', 'u')])], [], now);
  assert.equal(p.transit, 3); assert.equal(p.attention, 4);
  assert.equal(p.counts.waiting, 1); assert.equal(p.counts.review, 1); assert.equal(p.counts.unknown, 1); assert.equal(p.current.length, 5);
});
test('today uses only a valid finishedAt and keeps cancellation separate', () => {
  const q = [task('done', 'today', { finishedAt: start }), task('done', 'old', { finishedAt: start - 1 }), task('cancelled', 'end', { finishedAt: start + 86400000 - 1 }), task('done', 'next', { finishedAt: start + 86400000 })];
  for (const [i, finishedAt] of [undefined, NaN, Infinity, String(now)].entries()) q.push(task('done', 'bad' + i, { finishedAt, createdAt: now }));
  const [p] = board.project([room(q)], [], now);
  assert.deepEqual(p.current.map(t => t.id), ['today', 'end']); assert.equal(p.counts.done, 1); assert.equal(p.counts.cancelled, 1);
});
test('empty, only history and today finished are different model states', () => {
  const [a, b, c] = board.project([room([]), { ...room([task('done', 'old')]), id: 'b' }, { ...room([task('done', 'new', { finishedAt: now })]), id: 'c' }], [], now);
  assert.equal(a.all.length, 0); assert.equal(b.all.length, 1); assert.equal(b.current.length, 0); assert.equal(c.counts.done, 1);
});
test('member grouping uses actual recipient before requested assignee', () => {
  const [p] = board.project([room([task('sent', 's', { sentTo: 'actual', assignee: 'requested' })])], [{ id: 'actual', name: 'Actual' }, { id: 'requested', name: 'Requested' }], now);
  assert.equal(p.current[0].memberKey, 'actual'); assert.equal(p.current[0].memberName, 'Actual');
});
test('projection never reads conversation bodies or queue replies', () => {
  const q = task('sent', 'safe'), r = room([q]), s = { id: 'member', name: 'Member' };
  for (const [o, k] of [[r, 'messages'], [s, 'messages'], [q, 'reply']]) Object.defineProperty(o, k, { get() { throw Error('Conversation access forbidden'); } });
  assert.equal(board.project([r], [s], now)[0].transit, 1);
});
test('unknown/unavailable queues are not presented as empty and healthy', () => {
  const [p] = board.project([{ id: 'missing', name: 'Missing', unavailable: true }], [], now);
  assert.equal(p.available, false);
});
test('the palette separates decisions, reviews, queued tasks and empty tracks', () => {
  assert.notEqual(board.COLORS.review, board.COLORS.waiting); assert.notEqual(board.COLORS.queued, board.COLORS.empty);
});
