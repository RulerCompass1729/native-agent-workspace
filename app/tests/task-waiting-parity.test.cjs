const test = require('node:test'), assert = require('node:assert/strict');
const { scene } = require('./fixtures/waiting-stream-dom.cjs');
for (const language of ['zh', 'en']) test(language + ': the button counts every waiting item once and the card keeps its deadline', t => {
  const now = Date.now(), f = (k, p) => require('../ui-locale.js').format(language, k, p);
  const sessions = [{ id: 'member', nativeId: 'native', name: 'Member', state: 'working', roomIds: ['space'] }, { id: 'solo', state: 'approval', roomIds: [] }];
  const rooms = [{ id: 'space', queue: [{ id: 'a', status: 'waiting' }, { id: 'b', status: 'waiting' }] }];
  const confirmations = [{ key: 'member:native:op', id: 'card', operationId: 'op', sessionId: 'member', nativeId: 'native', state: 'confirmation-required', actionable: true, expiresAt: now + 100000 }];
  const s = scene(language, { rooms, sessions, confirmations, confirmationsAvailable: true }); t.after(s.dispose);
  // Two queue decisions, one native approval and one card; the stream's own decide items are the queue rows, not extra ones.
  assert.equal(s.count(), 4); assert.equal(s.observed.at(-1), 4); assert.equal(s.strip(), null, 'no second waiting strip');
  assert.equal(s.label(), [f('taskBoard.boardButton'), f('taskBoard.need', { count: 4 }), f('taskBoard.cardDueLabel', { time: '1:40' })].join(f('taskBoard.labelSeparator')));
  assert.match(s.deadline(), /1:40/);
  s.advance(100000); assert.equal(s.cardHidden(), true); assert.equal(s.count(), 3);
  rooms[0].queue[0].reason = 'no-reply'; s.render();
  assert.equal(s.count(), 3);
  // The untitled approval names its kind once, as its title (task-board-dialog), so no sub repeats it.
  assert.deepEqual(s.subs(), [f('taskBoard.status.review'), f('taskBoard.status.waiting')].sort());
});
