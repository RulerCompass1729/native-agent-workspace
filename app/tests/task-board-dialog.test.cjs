// The task board lists tasks only (R250–R251, 11-25): groups, search, rows that open in place.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const board = require('../renderer/task-board.js'), locale = require('../ui-locale.js'), { fixture } = require('./fixtures/task-board-dom.cjs');

function setup(language = 'zh', options = {}) {
  const f = fixture();
  let now = new Date(2026, 10, 18, 12).getTime();
  f.calls = [];
  f.input = {
    connected: true, confirmationsAvailable: true, confirmations: [], activeSpace: 'space',
    rooms: [{ id: 'space', name: 'Synthetic space', queue: [
      { id: 'sent1234abcd', status: 'sent', text: 'Synthetic request\nsecond line', sentTo: 'member', createdAt: now - 3600000, sentAt: now - 1800000 },
      { id: 'review', status: 'waiting', reason: 'no-reply', text: 'Synthetic review', sentTo: 'member', sentAt: now - 600000 },
    ] }],
    sessions: [{ id: 'member', nativeId: 'native-member', name: 'Synthetic member', state: 'working', roomIds: ['space'] }],
  };
  f.format = (k, p) => locale.format(language, k, p);
  f.board = board.bind({
    host: f.host, document: f.doc, text: f.format, now: () => now,
    onQueue: id => f.calls.push(['queue', id]),
    onSession: (id, nativeId) => f.calls.push(['session', id, nativeId]),
    onConfirmation: target => f.calls.push(['card', target]),
    onOriginal: target => f.calls.push(['original', target]),
    onWaiting: options.onWaiting,
  });
  f.board.update(f.input);
  f.button = f.host.querySelector('.task-board-toggle');
  f.panel = f.host.querySelector('.task-board-panel');
  f.advance = ms => { now += ms; f.board.tick(); };
  f.now = () => now;
  f.groups = () => f.host.querySelectorAll('.task-board-group').map(g => ({
    key: g.dataset.groupKey,
    open: g.querySelector('.task-board-fold').getAttribute('aria-expanded') === 'true',
    rows: g.querySelectorAll('.task-board-entry').map(e => e.dataset.itemId),
  }));
  f.entry = id => f.host.querySelectorAll('.task-board-entry').find(e => e.dataset.itemId === id);
  f.row = id => f.entry(id)?.parentElement.parentElement;
  f.search = value => { const input = f.host.querySelector('.task-board-search'); input.value = value; input.fire('input', { isComposing: false }); };
  return f;
}
const card = (f, seconds, extra = {}) => ({
  id: 'actor:native:operation', kind: 'background-confirmation', title: 'Synthetic card', actorId: 'member', actorName: 'Synthetic member', time: f.now(),
  card: { key: 'actor:native:operation', id: 'message', sessionId: 'member', nativeId: 'native-member', operationId: 'operation', expiresAt: f.now() + seconds * 1000, message: { id: 'message' } }, ...extra,
});

test('the global bar uses no separate height and keeps one original panel', () => {
  const f = setup();
  assert.equal(board.BAR_HEIGHT, 0);
  assert.equal(f.host.querySelectorAll('.task-board-toggle').length, 1);
  assert.match(fs.readFileSync(require.resolve('../renderer/task-board.css'), 'utf8'), /\.task-board-panel\{[^}]*position:fixed/);
  f.board.dispose();
});

test('native popover lifecycle does not move content and returns focus to the same trigger', () => {
  const f = setup(), before = f.content.getBoundingClientRect();
  f.button.focus(); f.button.fire('click');
  assert.equal(f.doc.modal, undefined); assert.equal(f.panel.matches(':popover-open'), true);
  assert.equal(f.button.getAttribute('aria-expanded'), 'true'); assert.deepEqual(f.content.getBoundingClientRect(), before);
  assert.ok(parseFloat(f.panel.style.width) <= 1140); assert.ok(parseFloat(f.panel.style.top) + parseFloat(f.panel.style.maxHeight) <= 600);
  f.key('Escape');
  assert.equal(f.panel.matches(':popover-open'), false); assert.equal(f.doc.activeElement, f.button); assert.equal(f.button.getAttribute('aria-expanded'), 'false');
  f.board.dispose();
});

test('another modal Escape is never consumed by a closed task board', () => {
  const f = setup(), other = f.doc.createElement('dialog');
  f.doc.body.append(other); other.showModal(); f.key('Escape');
  assert.equal(other.open, false); f.board.dispose();
});

test('dispose detaches contents, observers and listeners without a countdown lease', () => {
  const f = setup();
  f.board.dispose();
  assert.equal(f.host.children.length, 0); assert.equal(f.timers.size, 0);
  assert.equal(f.win.listeners.get('resize')?.size || 0, 0); assert.equal(f.doc.listeners.get('visibilitychange')?.size || 0, 0);
  f.advance(1000);
});

// R251: the three header chips are gone; the button alone says how many wait and when a card runs out.
test('the button reads 任务板 · N 件等你 · 卡 m:ss and nothing else', () => {
  for (const lang of ['zh', 'en']) {
    const f = setup(lang), need = f.host.querySelector('.task-status-need'), due = f.host.querySelector('.task-status-due');
    assert.equal(f.host.querySelector('.task-status-chips'), null); assert.equal(f.host.querySelector('.task-status-warning'), null);
    assert.equal(f.host.querySelector('.task-status-board').textContent, f.format('taskBoard.boardButton'));
    assert.deepEqual([need.hidden, need.textContent], [false, { zh: '1 件等你', en: '1 needs you' }[lang]], 'a no-reply review waits for the person; one is singular (N1)');
    assert.equal(due.hidden, true);
    f.board.setWaiting([card(f, 100)]);
    assert.equal(need.textContent, { zh: '2 件等你', en: '2 need you' }[lang]);
    assert.deepEqual([due.hidden, due.textContent], [false, f.format('taskBoard.cardDue', { time: '1:40' })]);
    assert.equal(f.button.getAttribute('aria-label'), [f.format('taskBoard.boardButton'), f.format('taskBoard.need', { count: 2 }), f.format('taskBoard.cardDueLabel', { time: '1:40' })].join(f.format('taskBoard.labelSeparator')));
    f.input.rooms[0].queue = [f.input.rooms[0].queue[0]]; f.board.setWaiting([]);
    assert.deepEqual([need.hidden, due.hidden, f.button.textContent], [true, true, f.format('taskBoard.boardButton') + '⌄']);
    f.board.dispose();
  }
});

test('a card counts down while the board is closed and leaves at expiry without any call', () => {
  const f = setup(), due = f.host.querySelector('.task-status-due');
  f.board.setWaiting([card(f, 100)]);
  assert.equal(due.textContent, '卡 1:40');
  f.advance(1000); assert.equal(due.textContent, '卡 1:39');
  f.board.open(); assert.equal(f.host.querySelector('[data-sub="card"]')?.textContent, '确认卡 · 1:39');
  f.advance(99000);
  assert.equal(due.hidden, true); assert.equal(f.entry('actor:native:operation'), undefined);
  assert.equal(f.timers.size, 0); assert.deepEqual(f.calls, []);
  f.board.dispose();
});

// F: every opening groups by status, 等你 first, finished groups folded; no memory of the last choice.
test('every opening starts by status with 等你 first and finished groups folded', () => {
  const f = setup(), q = f.input.rooms[0].queue;
  q.push({ id: 'queued', status: 'queued', text: 'Synthetic queued' }, { id: 'failed', status: 'failed', text: 'Synthetic failure', finishedAt: f.now() },
    { id: 'done', status: 'done', text: 'Synthetic done', finishedAt: f.now() }, { id: 'cancelled', status: 'cancelled', text: 'Synthetic cancelled', finishedAt: f.now() });
  f.board.update(f.input); f.board.open();
  assert.deepEqual(f.groups(), [
    { key: 'waiting', open: true, rows: ['review'] }, { key: 'sent', open: true, rows: ['sent1234abcd'] }, { key: 'queued', open: true, rows: ['queued'] },
    { key: 'problem', open: true, rows: ['failed'] }, { key: 'done', open: false, rows: [] }, { key: 'cancelled', open: false, rows: [] },
  ]);
  const head = f.host.querySelector('.task-board-group-head');
  assert.equal(head.classList.contains('waiting'), true);
  assert.equal(head.querySelector('.task-board-group-name').textContent, '等你'); assert.equal(head.querySelector('.task-board-group-count').textContent, '1');
  assert.equal(head.querySelector('.task-board-latest').textContent, '派出 11:50');
  f.host.querySelectorAll('.task-board-mode').find(b => b.dataset.grouping === 'agent').fire('click');
  assert.deepEqual(f.host.querySelectorAll('.task-board-mode').map(b => b.getAttribute('aria-pressed')), ['false', 'true', 'false']);
  f.host.querySelectorAll('.task-board-fold')[0].fire('click');
  f.board.close(); f.board.open();
  assert.deepEqual(f.host.querySelectorAll('.task-board-mode').map(b => b.getAttribute('aria-pressed')), ['true', 'false', 'false']);
  assert.deepEqual(f.groups().map(g => [g.key, g.open]), [['waiting', true], ['sent', true], ['queued', true], ['problem', true], ['done', false], ['cancelled', false]]);
  f.host.querySelectorAll('.task-board-fold').find(b => b.parentElement.parentElement.dataset.groupKey === 'done').fire('click');
  assert.deepEqual(f.groups().find(g => g.key === 'done').rows, ['done']);
  f.board.dispose();
});

test('by agent and by space, each head names its group and opens that session or queue', () => {
  const f = setup();
  f.input.rooms.push({ id: 'other', name: 'Second space', queue: [{ id: 'elsewhere', status: 'queued', text: 'Synthetic other' }] });
  f.board.update(f.input); f.board.open();
  f.host.querySelectorAll('.task-board-mode').find(b => b.dataset.grouping === 'agent').fire('click');
  const agentHeads = f.host.querySelectorAll('.task-board-group').map(g => [g.dataset.groupKey, g.querySelector('.task-board-group-name').textContent, g.querySelector('.task-board-go').hidden]);
  assert.deepEqual(agentHeads, [['member', 'Synthetic member', false], ['-', '未分配', true]]);
  assert.equal(f.host.querySelector('.task-board-agent').hidden, true, 'the agent column is the group head');
  f.host.querySelector('.task-board-go').fire('click');
  assert.deepEqual(f.calls.pop(), ['session', 'member', 'native-member']);
  f.board.open(); f.host.querySelectorAll('.task-board-mode').find(b => b.dataset.grouping === 'space').fire('click');
  assert.deepEqual(f.host.querySelectorAll('.task-board-group').map(g => g.querySelector('.task-board-group-name').textContent), ['Synthetic space', 'Second space']);
  f.host.querySelectorAll('.task-board-go')[1].fire('click');
  assert.deepEqual(f.calls.pop(), ['queue', 'other']);
  f.board.dispose();
});

test('eight rows a group, then 再显示 shows eight more with the total', () => {
  for (const lang of ['zh', 'en']) {
    const f = setup(lang);
    f.input.rooms[0].queue.push(...Array.from({ length: 11 }, (_, i) => ({ id: 'queued' + i, status: 'queued', text: 'Synthetic queued ' + i, createdAt: f.now() - i * 1000 })));
    f.board.update(f.input); f.board.open();
    const queued = () => f.groups().find(g => g.key === 'queued').rows, more = f.host.querySelector('.task-board-more');
    assert.equal(queued().length, 8); assert.equal(more.textContent, f.format('taskBoard.more', { count: 3, total: 11 }));
    assert.deepEqual(queued().slice(0, 2), ['queued0', 'queued1'], 'newest first');
    more.fire('click');
    assert.equal(queued().length, 11); assert.equal(f.host.querySelector('.task-board-more'), null);
    f.board.dispose();
  }
});

test('one search covers title, full text, agent, space, #id and READY commit, and marks the match', () => {
  const f = setup(), q = f.input.rooms[0].queue;
  q.push({ id: 'done5678', status: 'done', text: 'Finished synthetic item', sentTo: 'member', finishedAt: f.now(), ready: { commit: 'abcdef1234' } });
  for (const key of ['reply', 'answer']) Object.defineProperty(q[0], key, { enumerable: true, get() { throw Error('Replies are not board material'); } });
  Object.defineProperty(f.input.sessions[0], 'messages', { get() { throw Error('Conversation bodies are not board material'); } });
  f.board.update(f.input); f.board.open();
  const found = term => { f.search(term); return f.groups().flatMap(g => g.rows); };
  assert.deepEqual(found('second line'), ['sent1234abcd']);
  assert.deepEqual(found('synthetic member'), ['review', 'sent1234abcd', 'done5678']);
  assert.deepEqual(found('Synthetic space').length, 3);
  assert.deepEqual(found('#sent12'), ['sent1234abcd']);
  assert.deepEqual(found('abcdef'), ['done5678'], 'a folded group opens while searching');
  assert.equal(f.host.querySelector('.task-board-total').textContent, '找到 1 件');
  assert.deepEqual(found('reply body'), []);
  assert.equal(f.host.querySelector('.task-board-empty').textContent, f.format('taskBoard.noMatches'));
  found('request');
  const mark = f.entry('sent1234abcd').querySelector('mark');
  assert.equal(mark.textContent, 'request'); assert.equal(f.entry('sent1234abcd').textContent, 'Synthetic request');
  f.search('');
  assert.equal(f.host.querySelector('.task-board-total').textContent, '共 3 件');
  f.board.dispose();
});

test('a row shows title, sub-label, agent, space, latest event and #id, and opens in place', () => {
  const f = setup(), line = () => f.row('sent1234abcd').querySelector('.task-board-line');
  f.board.open();
  const parts = line().children.map(e => e.className.split(' ')[0]);
  assert.deepEqual(parts, ['task-board-dot', 'task-board-entry', 'task-board-sub', 'task-board-agent', 'task-board-space', 'task-board-when', 'task-board-id']);
  assert.deepEqual(line().children.slice(3).map(e => e.textContent), ['Synthetic member', 'Synthetic space', '派出11:30', '#sent1234']);
  assert.equal(f.row('review').querySelector('.task-board-sub').textContent, '待查看');
  f.entry('sent1234abcd').fire('click');
  const detail = f.row('sent1234abcd').querySelector('.task-board-detail');
  assert.equal(f.entry('sent1234abcd').getAttribute('aria-expanded'), 'true');
  assert.equal(detail.querySelector('.task-board-full').textContent, 'Synthetic request\nsecond line');
  assert.equal(detail.querySelector('.task-board-timeline').textContent, '创建 11:00 → 派出 11:30');
  assert.deepEqual(detail.querySelectorAll('.task-board-action').map(b => [b.dataset.action, b.textContent]),
    [['openSessionOf', '打开 Synthetic member 的会话 ↗'], ['openQueueOf', '打开「Synthetic space」队列 ↗']]);
  f.entry('review').fire('click');
  assert.equal(f.row('sent1234abcd').querySelector('.task-board-detail'), null, 'one row open at a time');
  assert.equal(f.row('review').querySelector('.task-board-reason').textContent, f.format('taskBoard.reasonNoReply'));
  assert.equal(f.row('review').querySelector('.task-board-action').dataset.action, 'checkIn');
  f.row('review').querySelectorAll('.task-board-action')[1].fire('click');
  assert.deepEqual(f.calls, [['queue', 'space']]); assert.equal(f.panel.matches(':popover-open'), false);
  f.board.open(); f.host.querySelector('.task-board-agent').fire('click');
  assert.deepEqual(f.calls.pop(), ['session', 'member', 'native-member']);
  f.board.dispose();
});

// ③: while the board is open, rows keep their places; the next opening regroups and reorders.
test('an open board changes only text; the next opening moves the row', () => {
  const f = setup(), q = f.input.rooms[0].queue;
  f.board.open(); f.entry('sent1234abcd').fire('click');
  const node = f.row('sent1234abcd');
  q[0] = { ...q[0], status: 'done', finishedAt: f.now() };
  q.push({ id: 'late', status: 'sent', text: 'Synthetic late arrival', sentTo: 'member', sentAt: f.now() });
  f.board.update(f.input);
  assert.deepEqual(f.groups().find(g => g.key === 'sent').rows, ['sent1234abcd', 'late'], 'a new row goes to the end of its group');
  assert.equal(f.row('sent1234abcd'), node); assert.equal(f.row('sent1234abcd').querySelector('.task-board-sub').textContent, '已完成');
  assert.ok(node.querySelector('.task-board-detail'), 'the open row stays open');
  f.board.close(); f.board.open();
  assert.deepEqual(f.groups().find(g => g.key === 'sent').rows, ['late']);
  assert.equal(f.groups().find(g => g.key === 'done').open, false);
  f.board.dispose();
});

test('English counts of one are singular on the board (N1)', () => {
  const f = setup('en');
  f.input.rooms[0].queue = [f.input.rooms[0].queue[0]]; f.board.update(f.input); f.board.open();
  assert.equal(f.host.querySelector('.task-board-total').textContent, '1 task');
  f.input.rooms[0].queue.push({ id: 'second', status: 'queued', text: 'Synthetic second', createdAt: f.now() }); f.board.update(f.input);
  assert.equal(f.host.querySelector('.task-board-total').textContent, '2 tasks');
  f.board.dispose();
});

const mode = (f, value) => f.host.querySelectorAll('.task-board-mode').find(b => b.dataset.grouping === value);
const waitingItems = (f, n, from = 0) => Array.from({ length: n }, (_, i) => ({ id: 'wait' + (from + i), status: 'waiting', text: 'Synthetic decision ' + (from + i), sentTo: 'member', sentAt: f.now() - (from + i) * 1000 }));

// N3: past eight waiting rows, one that arrives while the board is open is shown, not hidden behind 再显示.
test('a waiting item that arrives on an open board is visible even past the first eight', () => {
  const f = setup(), q = f.input.rooms[0].queue;
  q.push(...waitingItems(f, 10)); f.board.update(f.input); f.board.open();
  const waiting = () => f.groups().find(g => g.key === 'waiting').rows, more = () => f.host.querySelectorAll('.task-board-group').find(g => g.dataset.groupKey === 'waiting').querySelector('.task-board-more');
  assert.equal(waiting().length, 8); assert.equal(more().textContent, f.format('taskBoard.more', { count: 3, total: 11 }));
  q.push({ id: 'arrived', status: 'waiting', text: 'Synthetic new decision', sentTo: 'member', sentAt: f.now() });
  f.board.update(f.input);
  assert.equal(waiting().length, 9); assert.equal(waiting().at(-1), 'arrived', 'it joins the end of 等你, before 再显示');
  assert.equal(more().textContent, f.format('taskBoard.more', { count: 3, total: 12 }), 'the older hidden rows stay folded');
  q.push(...Array.from({ length: 12 }, (_, i) => ({ id: 'burst' + i, status: 'queued', text: 'Synthetic burst ' + i, createdAt: f.now() })));
  f.board.update(f.input);
  assert.equal(f.groups().find(g => g.key === 'queued').rows.length, 8, 'queued arrivals, not counted on the button, still page by eight');
  more().fire('click');
  assert.deepEqual(waiting().slice(-3), ['wait9', 'review', 'arrived'], 'the older rows fill in before it');
  f.board.close(); f.board.open();
  assert.equal(waiting()[0], 'arrived', 'the next opening sorts it among the others');
  f.board.dispose();
});

// N2: a click outside hides the popover before its toggle event arrives; showing a waiting item then is a fresh opening (F).
test('showing an item right after an outside click reopens by status with a new order', () => {
  const f = setup(), q = f.input.rooms[0].queue;
  f.board.open(); f.search('synthetic'); mode(f, 'agent').fire('click');
  q[0] = { ...q[0], status: 'done', finishedAt: f.now() };
  f.board.setWaiting([card(f, 100)]);
  f.panel.popoverOpen = false;
  f.board.show('actor:native:operation');
  assert.equal(f.panel.matches(':popover-open'), true);
  assert.equal(mode(f, 'status').getAttribute('aria-pressed'), 'true');
  assert.equal(f.host.querySelector('.task-board-search').value, '');
  assert.deepEqual(f.groups().map(g => g.key), ['waiting', 'done'], 'the finished item moved to its new group');
  assert.equal(f.entry('actor:native:operation').getAttribute('aria-expanded'), 'true');
  f.board.dispose();
});

// N10: a search or a new grouping starts the list at the top; an update keeps the reading place.
test('a new search or grouping scrolls the list to the top, and an update does not', () => {
  const f = setup(), list = f.host.querySelector('.task-board-list');
  f.board.open(); list.scrollTop = 120;
  f.input.rooms[0].queue.push({ id: 'late', status: 'queued', text: 'Synthetic late', createdAt: f.now() }); f.board.update(f.input);
  assert.equal(list.scrollTop, 120);
  f.search('synthetic'); assert.equal(list.scrollTop, 0);
  list.scrollTop = 80; mode(f, 'space').fire('click'); assert.equal(list.scrollTop, 0);
  f.board.dispose();
});

// N4 (replaces the deleted "ten rows grow to twenty" test): a status update on an open board keeps focus, scroll and a half-typed answer.
test('a status update on an open board keeps focus, the scroll position and a half-typed answer', () => {
  const textarea = e => e.querySelectorAll('*').find(n => n.tagName === 'TEXTAREA') || null, answer = () => textarea(f.host);
  const f = setup('zh', { onWaiting: slot => { if (!textarea(slot.entry.actions)) slot.entry.actions.append(f.doc.createElement('textarea')); } });
  const q = f.input.rooms[0].queue, list = f.host.querySelector('.task-board-list');
  const question = { id: 'question:member:r1', kind: 'question', title: 'Synthetic question?', actorId: 'member', actorName: 'Synthetic member', sessionId: 'member', requestId: 'r1', time: f.now() };
  q.push(...waitingItems(f, 10)); f.board.setWaiting([question]);
  f.board.open(); f.entry('question:member:r1').fire('click');
  const box = answer(); box.value = 'half-typed synthetic answer'; box.focus(); list.scrollTop = 200;
  q.push(...waitingItems(f, 10, 10)); q[0] = { ...q[0], status: 'done', finishedAt: f.now() };
  f.board.update(f.input); f.board.setWaiting([question]);
  assert.equal(answer(), box, 'the same answer form'); assert.equal(box.value, 'half-typed synthetic answer');
  assert.equal(f.doc.activeElement, box); assert.equal(list.scrollTop, 200);
  assert.equal(f.host.querySelector('.task-board-total').textContent, '共 23 件');
  f.board.dispose();
});

// A: what waits outside a queue is answered on the board, with the conversation's own card, form or creation card.
test('cards, questions and creation permissions open in place through the existing renderers', () => {
  const seen = [], f = setup('zh', { onWaiting: (slot, item) => seen.push([item.kind, slot.entry.item === slot.box, slot.entry.actions.parentElement === slot.box, slot.question.parentElement === slot.box]) });
  f.board.setWaiting([
    card(f, 100),
    { id: 'question:member:r1', kind: 'question', title: 'Synthetic question?', actorId: 'member', actorName: 'Synthetic member', sessionId: 'member', requestId: 'r1', time: f.now() },
    { id: 'operator-creation:member:key', kind: 'operator-creation', title: 'Synthetic new session', actorId: 'member', actorName: 'Synthetic member', sessionId: 'member', messageId: 'm1', time: f.now(), message: { id: 'm1' } },
    { id: 'queue:space:review', kind: 'look', title: 'Synthetic review', actorId: 'member', roomId: 'space', itemId: 'review', time: f.now() },
  ]);
  f.board.open();
  assert.deepEqual(f.groups()[0].rows.sort(), ['actor:native:operation', 'operator-creation:member:key', 'question:member:r1', 'review'], 'a queue review is listed once');
  for (const id of ['actor:native:operation', 'question:member:r1', 'operator-creation:member:key']) f.entry(id).fire('click');
  assert.deepEqual(seen, [['background-confirmation', true, true, true], ['question', true, true, true], ['operator-creation', true, true, true]]);
  assert.equal(f.row('question:member:r1').querySelector('.task-board-sub').textContent, '问题 · 不阻塞本轮');
  f.entry('actor:native:operation').fire('click');
  const actions = f.row('actor:native:operation').querySelectorAll('.task-board-action').map(b => b.dataset.action);
  assert.deepEqual(actions, ['fullCard', 'openSessionOf']);
  f.row('actor:native:operation').querySelector('.task-board-action').fire('click');
  assert.deepEqual(f.calls.pop(), ['card', { sessionId: 'member', nativeId: 'native-member', operationId: 'operation', messageId: 'message', history: true }]);
  f.board.show('operator-creation:member:key');
  assert.equal(f.entry('operator-creation:member:key').getAttribute('aria-expanded'), 'true');
  assert.equal(seen.at(-1)[0], 'operator-creation');
  f.board.dispose();
});

// The shared card countdown (renderer.js) keeps a line ticking only under a row carrying the card's own id (not its key).
test('an open card sits under its card id, and a closed board keeps no open card ticking', () => {
  const f = setup('zh', { onWaiting: () => {} });
  f.board.setWaiting([card(f, 100)]);
  f.board.open(); f.entry('actor:native:operation').fire('click');
  assert.equal(f.row('actor:native:operation').querySelector('.task-board-waiting').dataset.waitingId, 'message');
  f.board.close();
  assert.equal(f.row('actor:native:operation').querySelector('.task-board-waiting'), null);
  assert.equal(f.entry('actor:native:operation').getAttribute('aria-expanded'), 'false');
  f.board.dispose();
});

// C: dispatched work is 在做 whatever the session reports; a decision left with an ended session is an old dispatch.
test('a dispatched item stays 在做 and a decision left with an ended session is 旧派单 under 异常', () => {
  const f = setup(), q = f.input.rooms[0].queue;
  q.push({ id: 'decide', status: 'waiting', text: 'Synthetic decision', sentTo: 'gone' });
  f.input.sessions[0].state = 'disconnected';
  f.input.sessions.push({ id: 'gone', nativeId: 'native-gone', name: 'Ended member', state: 'ended', roomIds: ['space'] });
  f.board.update(f.input); f.board.open();
  assert.deepEqual(f.groups().find(g => g.key === 'sent').rows, ['sent1234abcd']);
  assert.deepEqual(f.groups().find(g => g.key === 'problem').rows, ['decide']);
  assert.equal(f.row('decide').querySelector('.task-board-sub').textContent, '旧派单');
  assert.equal(f.host.querySelector('.task-status-need').textContent, '1 件等你');
  assert.equal(f.host.querySelector('.task-board-availability').hidden, true, 'no 状态待核 line for a session state');
  f.board.dispose();
});

// Navigation goes to whoever actually received an item, never to a planned assignee.
for (const spec of [
  { name: 'queued planned assignee without sentTo', status: 'queued', assignee: 'planned', session: false },
  { name: 'unassigned queued item', status: 'queued', session: false },
  { name: 'sent item with a different planned assignee', status: 'sent', assignee: 'planned', sentTo: 'actual', session: ['session', 'actual', 'native-actual'] },
  { name: 'missing sentTo never falls back to the planned assignee', status: 'sent', assignee: 'planned', sentTo: 'gone', session: false },
]) test('navigation: ' + spec.name, () => {
  const f = setup();
  const sessions = ['planned', 'actual'].map(id => ({ id, name: id, nativeId: 'native-' + id, roomIds: ['origin'], state: 'idle' }));
  for (const s of sessions) Object.defineProperty(s, 'messages', { get() { throw Error('Navigation must not read conversation bodies'); } });
  f.board.update({ rooms: [{ id: 'origin', name: 'Origin', queue: [{ id: 'task', text: 'Synthetic navigation task', ...spec, session: undefined }] }], sessions, connected: true, confirmationsAvailable: true, confirmations: [] });
  f.board.open(); f.entry('task').fire('click');
  const actions = f.row('task').querySelectorAll('.task-board-action');
  assert.equal(f.row('task').querySelector('.task-board-agent').disabled, !spec.session);
  assert.equal(actions.at(-1).dataset.action, 'openQueueOf');
  if (spec.session) { actions[0].fire('click'); assert.deepEqual(f.calls, [spec.session]); }
  else { assert.equal(actions.length, 1); actions[0].fire('click'); assert.deepEqual(f.calls, [['queue', 'origin']]); }
  assert.equal(f.panel.matches(':popover-open'), false);
  f.board.dispose();
});

// R251: an unreadable queue is said where it belongs, not as a header chip.
test('an unreadable space queue is named on the board, and under its head by space', () => {
  for (const lang of ['zh', 'en']) {
    const f = setup(lang);
    f.input.rooms.push({ id: 'down', name: 'Unreadable space', unavailable: true });
    f.board.update(f.input); f.board.open();
    const line = f.host.querySelector('.task-board-availability');
    assert.deepEqual([line.hidden, line.textContent], [false, f.format('taskBoard.spaceUnavailableNamed', { name: 'Unreadable space' })]);
    f.host.querySelectorAll('.task-board-mode').find(b => b.dataset.grouping === 'space').fire('click');
    const group = f.host.querySelectorAll('.task-board-group').find(g => g.dataset.groupKey === 'down');
    assert.equal(group.querySelector('.task-board-group-note').textContent, f.format('taskBoard.spaceUnavailable'));
    assert.equal(group.querySelector('.task-board-group-name').textContent, 'Unreadable space');
    assert.equal(line.hidden, true);
    f.input.connected = false; f.board.update(f.input);
    assert.equal(line.textContent, f.format('taskBoard.stale'));
    f.board.dispose();
  }
});

// ④: the footer states what the board keeps.
test('the footer states the 300-per-space retention, in both languages, with no raw keys', () => {
  for (const lang of ['zh', 'en']) {
    const f = setup(lang);
    f.input.rooms[0].queue.push({ id: 'done', status: 'done', finishedAt: f.now() }, { id: 'queued', status: 'queued' });
    f.board.setWaiting([card(f, 100)]); f.board.open();
    for (const b of f.host.querySelectorAll('.task-board-fold')) if (b.getAttribute('aria-expanded') === 'false') b.fire('click');
    for (const e of f.host.querySelectorAll('.task-board-entry')) e.fire('click');
    assert.equal(f.host.querySelector('.task-board-retention').textContent, f.format('taskBoard.retention'));
    assert.match(f.format('taskBoard.retention'), /300/);
    assert.doesNotMatch(f.host.textContent, /taskBoard\.|stream\.|\{[a-z]+\}/);
    for (const e of f.host.querySelectorAll('*')) for (const name of ['aria-label', 'placeholder']) assert.doesNotMatch(e.getAttribute(name) || e[name] || '', /taskBoard\.|\{[a-z]+\}/);
    f.board.dispose();
  }
});

// The stream lists only cards the person can act on; one that cannot be verified stays on the board under 异常 (B).
test('an unverifiable confirmation card is listed under 异常 for checking, with no countdown or count', () => {
  const f = setup();
  f.input.confirmations = [
    { key: 'member:native-member:check', sessionId: 'member', nativeId: 'native-member', operationId: 'check', state: 'unverifiable', actionable: false, expiresAt: f.now() + 200000 },
    { key: 'member:native-member:live', sessionId: 'member', nativeId: 'native-member', operationId: 'live', state: 'confirmation-required', actionable: true, expiresAt: f.now() + 100000 },
  ];
  f.board.update(f.input); f.board.setWaiting([]);
  f.button.fire('click');
  const problem = f.groups().find(g => g.key === 'problem');
  assert.deepEqual(problem.rows, ['member:native-member:check'], 'only the unverifiable card; an actionable one arrives as a waiting item');
  const row = f.row('member:native-member:check'), sub = row.querySelector('.task-board-sub');
  assert.equal(row.querySelector('.task-board-task-title').textContent, f.format('taskBoard.confirmation'));
  assert.equal(sub.textContent, f.format('taskBoard.cardsUnverified')); assert.doesNotMatch(sub.textContent, /\d+:\d{2}/);
  assert.equal(f.button.querySelector('.task-status-need').textContent, f.format('taskBoard.needOne', { count: 1 }), 'the fixture review only'); assert.equal(f.button.querySelector('.task-status-due').hidden, true);
  f.entry('member:native-member:check').fire('click');
  assert.deepEqual(row.querySelectorAll('.task-board-action').map(b => b.dataset.action), ['openSessionOf']);
  row.querySelector('.task-board-action').fire('click');
  assert.deepEqual(f.calls.at(-1), ['session', 'member', 'native-member']);
  f.board.dispose();
});

test('a waiting item without its own title names its kind once, as the title', () => {
  const f = setup();
  f.board.setWaiting([{ id: 'approval:member', kind: 'approval', title: '', actorId: 'member', actorName: 'Synthetic member', sessionId: 'member', time: f.now() }]);
  f.button.fire('click');
  const row = f.row('approval:member');
  assert.equal(row.querySelector('.task-board-task-title').textContent, f.format('stream.approval'));
  assert.equal(row.querySelector('.task-board-sub').textContent, ''); assert.equal(row.querySelector('.task-board-sub').hidden, true);
  f.board.dispose();
});


test('the fixed confirmation trigger opens the earliest live card and leaves other waits on the board badge', () => {
  const f = setup(), later = card(f, 100), earliest = card(f, 20, { id: 'first', title: 'First to expire' });
  earliest.card = { ...earliest.card, key: earliest.id, operationId: 'first' };
  f.input.language = 'zh';
  const unknown = { ...earliest.card, key: 'checking', operationId: 'checking', expiresAt: f.now() + 120000,
    state: 'unverifiable', actionable: false, safeSummary: { titles: { zh: '归档会话' }, detail: 'Synthetic target' } };
  f.board.update({ ...f.input, confirmations: [later.card, earliest.card].map(value => ({
    ...value, state: 'confirmation-required', actionable: true,
  })).concat(unknown) }, [later, earliest]);
  f.board.tick();
  const trigger = f.host.querySelector('.task-confirmation-entry'), need = f.button.querySelector('.task-status-need');
  assert.equal(trigger.textContent, '待确认 2');
  assert.equal(need.textContent, '1 件等你');
  trigger.fire('click');
  assert.equal(f.entry(earliest.id).getAttribute('aria-expanded'), 'true');
  assert.equal(f.entry(later.id).getAttribute('aria-expanded'), 'false');
  assert.equal(f.entry('checking').textContent, '归档会话 · Synthetic target');
  assert.equal(f.groups().find(g => g.key === 'waiting').rows.length, 3);
  assert.deepEqual(f.calls, []);
  f.key('Escape');
  assert.equal(f.doc.activeElement, trigger);

  f.advance(20000);
  assert.equal(trigger.textContent, '待确认 1');
  trigger.fire('click');
  assert.equal(f.entry(later.id).getAttribute('aria-expanded'), 'true');
  f.advance(80000);
  assert.equal(trigger.textContent, '确认卡 · 待核验');
  assert.equal(f.entry(later.id), undefined);
  trigger.fire('click');
  assert.equal(f.entry('checking').getAttribute('aria-expanded'), 'true');
  assert.equal(f.entry('checking').textContent, '归档会话 · Synthetic target');
  assert.deepEqual(f.calls, []);
  f.board.dispose();
});
