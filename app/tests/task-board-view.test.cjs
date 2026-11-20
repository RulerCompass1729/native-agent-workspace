const test = require('node:test'), assert = require('node:assert/strict');
const board = require('../renderer/task-board.js'), locale = require('../ui-locale.js');
const { fixture } = require('./fixtures/task-board-dom.cjs');
const now = new Date(2026, 10, 19, 16).getTime();
const task = (id, kind, extra = {}) => ({ key: id, id, kind, text: 'Synthetic task ' + id, spaceId: 'space', spaceName: 'Example', memberKey: 'member', memberName: 'Member', ...extra });
function setup(language = 'zh', count = 24) {
  const f = fixture(), calls = [];
  f.input = { rooms: [{ id: 'space', name: 'Example', queue: Array.from({ length: count }, (_, i) => ({ id: String(i), status: 'queued', text: 'Synthetic ' + i, createdAt: now - i * 1000 })) }],
    sessions: [{ id: 'solo', name: 'Independent actor', nativeId: 'native-solo', roomIds: [], state: 'working' }], confirmations: [], confirmationsAvailable: true };
  f.board = board.bind({ host: f.host, document: f.doc, text: (k, p) => locale.format(language, k, p), now: () => now, onQueue: id => calls.push(['queue', id]), onSession: (...a) => calls.push(['session', ...a]) });
  f.board.update(f.input); f.calls = calls;
  f.tab = value => f.host.querySelector('[data-board-tab="' + value + '"]');
  f.change = (cls, value, event = 'change') => { const e = f.host.querySelector('.' + cls); assert.ok(e, cls); e.value = value; e.fire(event); };
  return f;
}
test('one click opens the global flat board and never preselects the caller space', () => {
  const f = setup();
  try {
    f.host.querySelector('.task-board-toggle').fire('click');
    assert.ok(f.tab('active')); assert.equal(f.tab('active').getAttribute('aria-selected'), 'true');
    assert.equal(f.host.querySelector('.task-board-space').value, 'all');
    assert.equal(f.host.querySelector('.task-board-mode').value, 'flat');
    assert.equal(f.host.querySelector('.task-board-full'), null); assert.equal(f.host.querySelector('.task-board-queue'), null);
    f.board.close(); f.board.open('space'); assert.equal(f.host.querySelector('.task-board-space').value, 'all');
  } finally { f.board.dispose(); }
});
test('status counts add up and history does not bury the current work', () => {
  const rows = [...Array.from({ length: 300 }, (_, i) => task('old' + i, 'done')),
    ...['sent', 'waiting', 'queued', 'review', 'unknown', 'failed', 'cancelled'].map(k => task(k, k))];
  const result = board.selectTasks(rows, {}, now);
  assert.equal(result.counts.active, 6); assert.equal(result.items.length, 6);
  assert.equal(result.counts.all, Object.keys(board.COLORS).filter(k => k !== 'empty').reduce((n, k) => n + result.counts[k], 0));
  assert.equal(result.counts.active, ['sent', 'waiting', 'queued', 'review', 'unknown', 'failed'].reduce((n, k) => n + result.counts[k], 0));
});
test('search reads only task materials, member, space and id/sha prefixes', () => {
  const row = task('abcdef01', 'queued', { text: 'First line\nMaterials detail', ready: { commit: 'fedcba987654321' }, reason: 'REASON_NOT_SEARCHABLE' });
  for (const k of ['messages', 'reply', 'answer', 'wait']) Object.defineProperty(row, k, { get() { throw Error('Private body read'); } });
  for (const search of ['detail', 'member', 'example', 'abcd', 'fedcba']) assert.equal(board.selectTasks([row], { search }, now).items.length, 1);
  for (const search of ['REASON_NOT_SEARCHABLE', 'bcdef01', 'dcba987']) assert.equal(board.selectTasks([row], { search }, now).items.length, 0);
});
test('create/finish/recent sort both ways with stable ties and missing times last', () => {
  const rows = [task('b', 'done', { createdAt: 1, sentAt: 6, finishedAt: 8 }), task('a', 'done', { createdAt: 1, finishedAt: 7 }), task('c', 'queued')];
  assert.deepEqual(board.selectTasks(rows, { tab: 'all', sort: 'create' }, now).items.map(q => q.id), ['a', 'b', 'c']);
  assert.deepEqual(board.selectTasks(rows, { tab: 'all', sort: 'finish' }, now).items.map(q => q.id), ['b', 'a', 'c']);
  assert.deepEqual(board.selectTasks(rows, { tab: 'all', sort: 'finish', descending: false }, now).items.map(q => q.id), ['a', 'b', 'c']);
  assert.deepEqual(board.selectTasks(rows, { tab: 'all', sort: 'recent' }, now).items.map(q => q.id), ['b', 'a', 'c']);
  assert.equal(board.selectTasks([task('bad', 'done', { finishedAt: Infinity })], { tab: 'all' }, now).items.length, 1);
});
test('today and seven-day completion ranges preserve every old unfinished item', () => {
  const midnight = new Date(2026, 10, 19).getTime();
  const rows = [task('wait', 'waiting', { createdAt: 1 }), task('review', 'review'), task('old', 'done', { finishedAt: midnight - 86400000 }),
    task('today', 'cancelled', { finishedAt: midnight }), task('missing', 'done'), task('future', 'done', { finishedAt: midnight + 86400000 })];
  assert.deepEqual(board.selectTasks(rows, { tab: 'all', scope: 'today' }, now).items.map(q => q.id).sort(), ['review', 'today', 'wait']);
  assert.deepEqual(board.selectTasks(rows, { tab: 'all', scope: 'week' }, now).items.map(q => q.id).sort(), ['old', 'review', 'today', 'wait']);
});
test('ten rows grow to twenty, and pushes retain loaded count, row nodes and focus', () => {
  const f = setup();
  try {
    f.board.open(); const list = f.host.querySelector('.task-board-list');
    assert.equal(f.host.querySelectorAll('.task-board-task').length, 10);
    const more = f.host.querySelector('.task-board-more'); more.fire('click');
    assert.equal(f.host.querySelectorAll('.task-board-task').length, 20);
    const first = f.host.querySelector('.task-board-entry'); first.focus(); list.scrollTop = 120;
    f.input.rooms[0].queue[10].createdAt = now + 1; f.board.update(f.input);
    assert.equal(f.host.querySelectorAll('.task-board-task').length, 20); assert.equal(f.doc.activeElement, first);
    assert.equal(f.host.querySelector('.task-board-entry'), first); assert.equal(list.scrollTop, 120);
    assert.equal(f.host.querySelector('.task-board-more'), more);
  } finally { f.board.dispose(); }
});
test('independent work is in the global scope and its exact route stays reachable', () => {
  const f = setup();
  try {
    f.board.open(); f.change('task-board-space', '@independent');
    const row = f.host.querySelector('.task-board-entry'); assert.equal(row.dataset.source, 'conversation');
    row.fire('click'); assert.deepEqual(f.calls, [['session', 'solo', 'native-solo']]);
  } finally { f.board.dispose(); }
});
test('literal search never matches session bodies or queue reply contents', () => {
  const f = setup();
  try {
    f.input.sessions[0].messages = [{ text: 'BODY_SENTINEL' }]; f.input.rooms[0].queue[0].reply = 'REPLY_SENTINEL'; f.board.update(f.input); f.board.open();
    for (const search of ['BODY_SENTINEL', 'REPLY_SENTINEL']) { f.change('task-board-search', search, 'input'); assert.equal(f.host.querySelectorAll('.task-board-task').length, 0); }
    f.change('task-board-search', 'Synthetic', 'input'); assert.equal(f.host.querySelectorAll('.task-board-task').length, 10);
  } finally { f.board.dispose(); }
});
test('keyboard arrows, Home/End and Escape work without losing the trigger', () => {
  const f = setup();
  try {
    const trigger = f.host.querySelector('.task-board-toggle'); trigger.focus(); trigger.fire('click');
    f.tab('active').fire('keydown', { key: 'ArrowRight' }); assert.equal(f.doc.activeElement, f.tab('waiting'));
    f.tab('waiting').fire('keydown', { key: 'End' }); assert.equal(f.tab('all').getAttribute('aria-selected'), 'true');
    f.tab('all').fire('keydown', { key: 'Home' }); assert.equal(f.tab('active').getAttribute('aria-selected'), 'true');
    f.tab('active').fire('keydown', { key: 'ArrowLeft' }); assert.equal(f.doc.activeElement, f.tab('all'));
    f.key('Escape'); assert.equal(f.host.querySelector('.task-board-panel').hidden, true); assert.equal(f.doc.activeElement, trigger);
  } finally { f.board.dispose(); }
});
test('flat/space/member views keep rows open and fallback titles identify the task', () => {
  const f = setup();
  try {
    f.input.rooms[0].queue[0].text = '\nFirst task line\nSecond line'; f.input.rooms[0].queue[1].text = ' '; f.board.update(f.input); f.board.open();
    assert.equal(f.host.querySelector('.task-board-task-title').textContent, 'First task line');
    assert.ok(f.host.querySelectorAll('.task-board-task-title').some(e => e.textContent.includes('（无标题）') && e.textContent.includes('1')));
    for (const mode of ['space', 'member', 'flat']) { f.change('task-board-mode', mode); assert.equal(f.host.querySelectorAll('.task-board-task').length, 10); }
    assert.ok(f.host.querySelector('.task-board-retention').textContent.includes('300'));
  } finally { f.board.dispose(); }
});
