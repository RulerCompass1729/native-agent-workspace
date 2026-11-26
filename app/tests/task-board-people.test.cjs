// 11-23 old dispatches leave 等你; since R250 (11-25) the board lists tasks only, and the header squares (R178) show the agents.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const board = require('../renderer/task-board.js'), stream = require('../task-stream.js'), locale = require('../ui-locale.js');
const { fixture } = require('./fixtures/task-board-dom.cjs');
const now = new Date(2026, 10, 23, 12).getTime(), minute = 60000;
const LONG = 'Synthetic worker with a deliberately long display name that must stay whole';
const shown = (look, agentStatus, statusText) => ({ look, agentStatus, statusText });

function input() {
  return {
    rooms: [{ id: 'dev', name: 'Dev space', queue: [
      { id: 'aaaaaaaa1111', status: 'sent', sentTo: 'w1', text: 'Current synthetic item\nsecond line', sentAt: now - 52 * minute },
      { id: 'bbbbbbbb2222', status: 'waiting', sentTo: 'w1', text: 'Decide synthetic A' },
      { id: 'cccccccc3333', status: 'waiting', sentTo: 'w1', text: 'Decide synthetic B' },
      { id: 'dddddddd4444', status: 'queued', assignee: 'w1', text: 'Queued synthetic' },
      { id: 'eeeeeeee5555', status: 'waiting', sentTo: 'old1', text: 'Old dispatch to an archived session' },
      { id: 'ffffffff6666', status: 'waiting', sentTo: 'end1', text: 'Old dispatch to an ended session' },
      { id: 'gggggggg7777', status: 'waiting', sentTo: 'a1', text: 'Asker decision' },
      { id: 'hhhhhhhh8888', status: 'waiting', sentTo: 'gone', text: 'Owner not in the list' },
    ] }, { id: 'ops', name: 'Ops space', queue: [] }],
    sessions: [
      { id: 'w1', nativeId: 'n-w1', name: LONG, state: 'working', roomIds: ['dev'], ...shown('state-dot working', 'working', 'Working') },
      { id: 'a1', nativeId: 'n-a1', name: 'Asker', state: 'approval', roomIds: ['dev'], approval: { pending: false }, ...shown('state-dot approval', 'waiting', 'Needs approval') },
      { id: 'i1', nativeId: 'n-i1', name: 'Idle member', state: 'idle', roomIds: ['dev', 'ops'], ...shown('state-dot idle', 'idle', 'Idle') },
      { id: 'd1', nativeId: 'n-d1', name: 'Offline member', state: 'disconnected', roomIds: ['dev'], ...shown('state-dot disconnected', 'stuck', 'Disconnected') },
      { id: 'old1', name: 'Rotated', state: 'idle', archived: true, roomIds: ['dev'] },
      { id: 'end1', name: 'Ended member', state: 'ended', roomIds: ['dev'] },
      { id: 'solo', nativeId: 'n-solo', name: 'Solo live', state: 'working', roomIds: [], ...shown('state-dot working', 'working', 'Working') },
      { id: 'solo-off', name: 'Solo offline', state: 'disconnected', roomIds: [] },
    ],
    confirmations: [], confirmationsAvailable: true, connected: true,
  };
}
function setup(language = 'zh', data = input()) {
  const f = fixture(), calls = [];
  f.board = board.bind({ host: f.host, document: f.doc, text: (k, p) => locale.format(language, k, p), now: () => now,
    onQueue: id => calls.push(['queue', id]), onSession: (...a) => calls.push(['session', ...a]) });
  f.board.update(data); f.board.open(); f.calls = calls;
  f.people = () => f.host.querySelector('.task-board-people');
  f.space = id => f.people().querySelector('[data-people-space="' + id + '"]');
  f.ids = node => node.querySelectorAll('[data-person-id]').map(e => e.dataset.personId);
  f.person = (id, space = 'dev') => f.space(space).querySelector('[data-person-id="' + id + '"]');
  return f;
}
const kinds = status => Object.fromEntries(status.historyGroups.find(p => p.id === 'dev').all.map(q => [q.id.slice(0, 8), q.kind]));

test('an item still waiting for a decision from an archived or ended session is an old dispatch under 异常, not 等你', () => {
  const status = board.overview(input(), now), k = kinds(status);
  assert.equal(k.eeeeeeee, 'stale'); assert.equal(k.ffffffff, 'stale');
  assert.equal(k.bbbbbbbb, 'waiting'); assert.equal(k.gggggggg, 'waiting');
  assert.equal(k.hhhhhhhh, 'waiting', 'a session missing from the list may simply not be loaded yet');
  assert.equal(status.waiting, 4);
  const f = setup(), group = key => f.host.querySelectorAll('.task-board-group').find(g => g.dataset.groupKey === key);
  assert.deepEqual(group('problem').querySelectorAll('.task-board-entry').map(e => e.dataset.itemId).sort(), ['eeeeeeee5555', 'ffffffff6666']);
  assert.deepEqual(group('problem').querySelectorAll('.task-board-sub').map(e => e.textContent), ['旧派单', '旧派单']);
  assert.equal(group('waiting').querySelectorAll('.task-board-entry').length, 4);
  assert.equal(f.host.querySelector('.task-status-need').textContent, '4 件等你');
  f.board.dispose();
});

test('the 等你 list leaves old dispatches out and keeps every live decision', () => {
  const data = input(), items = stream.waitingItems({ rooms: data.rooms, sessions: data.sessions });
  assert.deepEqual(items.filter(i => i.kind === 'decide').map(i => i.itemId).sort(), ['bbbbbbbb2222', 'cccccccc3333', 'gggggggg7777', 'hhhhhhhh8888']);
});

test('the open board lists tasks only: no agent cards, row steps or conversation rows', () => {
  for (const language of ['zh', 'en']) {
    const f = setup(language), ids = input().rooms[0].queue.map(q => q.id);
    assert.equal(f.host.querySelector('.task-board-people'), null); assert.equal(f.host.querySelector('.task-board-person'), null);
    assert.equal(f.host.querySelector('.task-board-task-step'), null);
    for (const b of f.host.querySelectorAll('.task-board-fold')) if (b.getAttribute('aria-expanded') === 'false') b.fire('click');
    const rows = f.host.querySelectorAll('.task-board-entry');
    assert.deepEqual(rows.map(e => e.dataset.itemId).sort(), ids.sort(), 'a working conversation without a task is not a row');
    assert.ok(rows.every(e => e.dataset.source === 'space'));
    assert.ok(f.host.querySelectorAll('.task-board-agent').some(e => e.textContent === LONG), 'the whole name stays');
    f.board.dispose();
  }
});

test('the renderer hands the board only each session\'s name and whether it has ended', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  const start = source.indexOf('function updateTaskBoard('), end = source.indexOf('const spaceCall', start);
  assert.ok(start >= 0 && end > start);
  let captured;
  const sessions = [{ id: 'x', nativeId: 'n-x', name: 'X', state: 'working' }, { id: 'y', name: 'Y', state: 'ended', archived: true }];
  for (const s of sessions) for (const key of ['messages', 'approval', 'claudeQuestion', 'nativeApproval']) Object.defineProperty(s, key, { get() { throw Error('The board reads no conversation or request'); } });
  const context = vm.createContext({ state: { sessions }, disconnected: false, spaceId: 'dev', allSpaces: () => [], spaceName: r => r.name, taskBoard: { update: value => { captured = value; } },
    window: { nativeWorkspaceTaskBoard: board, nativeWorkspaceSpaces: { roomIds: () => [] } } });
  vm.runInContext(source.slice(start, end) + '\nupdateTaskBoard();', context);
  assert.deepEqual(JSON.parse(JSON.stringify(captured.sessions)), [{ id: 'x', nativeId: 'n-x', name: 'X', state: 'working' }, { id: 'y', name: 'Y', state: 'ended', archived: true }]);
});

test('the header shows +N for squares that do not fit, and every square comes back when they do', () => {
  const distribution = require('../renderer/agent-distribution.js'), f = fixture();
  const host = f.doc.createElement('div'); f.content.append(host);
  const view = distribution.bind({ host, document: f.doc, text: (k, p) => locale.format('zh', k, p) });
  const strip = host.querySelector('.agent-strip'); let room = 200;
  // Geometry stand-ins: the strip ends at `room`; its last group ends after the visible squares, plus a 2px hit-area overhang.
  const need = () => strip.querySelectorAll('.agent-cell').filter(c => !c.hidden).length * 13 + 40;
  Object.defineProperty(strip, 'getBoundingClientRect', { value: () => ({ left: 0, right: room }) });
  const proto = Object.getPrototypeOf(strip), base = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function () { return this.classList.contains('agent-group') ? { left: 0, right: this.hidden ? 0 : need() } : base.call(this); };
  try {
  Object.defineProperty(strip, 'scrollWidth', { get: () => need() + 2 });
  Object.defineProperty(strip, 'clientWidth', { get: () => Math.min(room, need()) });
  const entries = Array.from({ length: 25 }, (_, i) => ({ id: 'e' + i, name: 'E' + i, look: 'state-dot ' + (i < 5 ? 'working' : 'approval'), status: i < 5 ? 'working' : 'waiting', statusText: '', model: '', rooms: [] }));
  view.update(entries);
  assert.equal(host.querySelectorAll('[data-agent-status="working"]').length, 5, 'five 在做 squares beside twenty 等你');
  const more = host.querySelector('.agent-strip-more'), hidden = () => host.querySelectorAll('.agent-cell').filter(c => c.hidden).length;
  assert.equal(more.hidden, false); assert.equal(more.textContent, '+' + hidden()); assert.ok(hidden() > 0);
  assert.ok(!host.textContent.includes('…'));
  const orphans = () => host.querySelectorAll('.agent-group').filter(g => !g.hidden && g.querySelectorAll('.agent-cell').every(c => c.hidden)).length;
  const working = () => host.querySelectorAll('[data-agent-status="working"]').filter(c => !c.hidden).length;
  assert.equal(working(), 1, 'extra squares go first: 在做 keeps one square and its count');
  assert.equal(orphans(), 0, 'no group count is left without squares beside +N');
  room = 60; f.win.fire('resize'); f.tick(0);
  assert.equal(host.querySelector('[data-group="status:working"]').hidden, true, 'only when one square each does not fit does a whole group go');
  assert.equal(orphans(), 0); assert.equal(more.textContent, '+' + hidden());
  room = 1000; f.win.fire('resize'); f.tick(0);
  assert.equal(hidden(), 0); assert.equal(more.hidden, true, 'the 2px hit-area overhang alone does not make a +N');
  assert.equal(host.querySelectorAll('.agent-group').filter(g => g.hidden).length, 0, 'every group comes back');
  } finally { proto.getBoundingClientRect = base; }
});
