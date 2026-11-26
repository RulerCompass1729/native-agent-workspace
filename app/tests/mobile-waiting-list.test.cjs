const test = require('node:test');
const assert = require('node:assert/strict');
const { waitingList } = require('../mobile-web/workspace.js');

// Synthetic phone summary in the shape of MobileWorkspace.read().
function view(extra = {}) {
  const sessions = [
    { id: 'a', name: 'Synthetic A', provider: 'codex', state: 'idle', question: false, roomIds: ['r'] },
    { id: 'b', name: 'Synthetic B', provider: 'claude', state: 'approval', question: false, roomIds: ['r'] },
    { id: 'c', name: 'Synthetic C', provider: 'codex', state: 'idle', question: true, roomIds: [] },
  ];
  const queue = [
    { id: 'old-decide', text: 'Old decision task', status: 'waiting', sentTo: 'a', question: 'Which option?', time: 10, ownerEnded: false },
    { id: 'look', text: 'Look task', status: 'waiting', sentTo: 'a', reason: 'no-reply', time: 30, ownerEnded: false },
    { id: 'new-decide', text: 'New decision task', status: 'waiting', assignee: 'a', time: 20, ownerEnded: false },
    { id: 'running', text: 'Running task', status: 'sent', sentTo: 'a' },
    { id: 'done', text: 'Done task', status: 'done', sentTo: 'a' },
  ];
  return { sessions, rooms: [{ id: 'r', name: 'Synthetic space', queue, members: sessions.slice(0, 2) }], confirmations: [], ...extra };
}

test('the phone list keeps the desktop order: decisions, confirmations, approvals, questions, then look', () => {
  const card = { id: 'card', sessionId: 'a', actorName: 'Synthetic A', actionable: true, time: 5, title: 'Run a command' };
  const list = waitingList(view({ confirmations: [card] }));
  assert.deepEqual(list.map(i => i.kind + ':' + (i.itemId || i.card?.id || i.sessionId)),
    ['decide:new-decide', 'decide:old-decide', 'background-confirmation:card', 'approval:b', 'question:c', 'look:look']);
  const decision = list[1];
  assert.deepEqual([decision.title, decision.actor, decision.spaces, decision.roomId], ['Which option?', 'Synthetic A', ['Synthetic space'], 'r']);
  assert.equal(list[0].title, 'New decision task');
  assert.deepEqual([list[2].actor, list[2].spaces], ['Synthetic A', ['Synthetic space']]);
});

test('held reasons are look, other waiting reasons are decisions', () => {
  for (const reason of ['person-intervened', 'no-reply', 'input-purpose-unconfirmed']) {
    const v = view(); v.rooms[0].queue = [{ id: 'x', text: 'x', status: 'waiting', sentTo: 'a', reason }];
    assert.equal(waitingList(v).find(i => i.itemId === 'x').kind, 'look', reason);
  }
  const v = view(); v.rooms[0].queue = [{ id: 'x', text: 'x', status: 'waiting', sentTo: 'a', reason: 'other' }];
  assert.equal(waitingList(v).find(i => i.itemId === 'x').kind, 'decide');
});

test('a decision whose session ended is not waiting; a look item stays', () => {
  const v = view(); for (const item of v.rooms[0].queue) item.ownerEnded = true;
  const kinds = waitingList(v).filter(i => i.itemId).map(i => i.kind + ':' + i.itemId);
  assert.deepEqual(kinds, ['look:look']);
});

test('only actionable cards count, and one batch is one row', () => {
  const cards = [
    { id: 'one', sessionId: 'a', actionable: true, batch: 'one', time: 2 },
    { id: 'two', sessionId: 'a', actionable: true, batch: 'one', time: 3 },
    { id: 'stale', sessionId: 'a', actionable: false, time: 4 },
    { id: 'single', sessionId: 'b', actionable: true, time: 1 },
  ];
  const rows = waitingList(view({ confirmations: cards })).filter(i => i.card);
  assert.deepEqual(rows.map(r => [r.card.id, r.cards?.map(c => c.id) || null]), [['one', ['one', 'two']], ['single', null]]);
  assert.equal(rows[1].actor, 'Synthetic B');
});

test('nothing waiting gives an empty list', () => {
  assert.deepEqual(waitingList({ sessions: [], rooms: [], confirmations: [] }), []);
  assert.deepEqual(waitingList(null), []);
});

// The phone keeps its own copy of the desktop rules (it loads only app/mobile-web); this fails when the desktop changes them.
test('the phone copy follows the desktop rules in task-stream.js', () => {
  const desktop = require('../task-stream.js');
  for (const reason of desktop.UNHELD_WAITING) {
    const v = view(); v.rooms[0].queue = [{ id: 'x', text: 'x', status: 'waiting', sentTo: 'a', reason }];
    assert.equal(waitingList(v).find(i => i.itemId === 'x').kind, desktop.taskStatus({ status: 'waiting', reason }), reason);
  }
  const card = { id: 'card', sessionId: 'a', actionable: true, time: 5 };
  const kinds = [...new Set(waitingList(view({ confirmations: [card] })).map(i => i.kind))];
  assert.deepEqual(kinds, [...kinds].sort((a, b) => desktop.RANK[a] - desktop.RANK[b]));
  assert.equal(kinds.length, 5);
});
