// 11-23 「点开之后状态条…至少需要完全展开」: the board lists every agent, and old dispatches leave 等你.
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

test('an item still waiting for a decision from an archived or ended session is an old dispatch, not 等你', () => {
  const status = board.overview(input(), now), k = kinds(status);
  assert.equal(k.eeeeeeee, 'stale'); assert.equal(k.ffffffff, 'stale');
  assert.equal(k.bbbbbbbb, 'waiting'); assert.equal(k.gggggggg, 'waiting');
  assert.equal(k.hhhhhhhh, 'waiting', 'a session missing from the list may simply not be loaded yet');
  assert.equal(status.waiting, 4);
  const counts = board.selectTasks(status.historyGroups.flatMap(p => p.all), { tab: 'stale' }, now).counts;
  assert.equal(counts.stale, 2); assert.equal(counts.waiting, 4);
  assert.equal(counts.active, ['sent', 'queued', 'waiting', 'review', 'stale', 'failed', 'unknown'].reduce((n, key) => n + counts[key], 0), 'old dispatches stay unfinished, not hidden');
});

test('the header 等你 strip leaves old dispatches out and keeps every live decision', () => {
  const data = input(), items = stream.waitingItems({ rooms: data.rooms, sessions: data.sessions });
  assert.deepEqual(items.filter(i => i.kind === 'decide').map(i => i.itemId).sort(), ['bbbbbbbb2222', 'cccccccc3333', 'gggggggg7777', 'hhhhhhhh8888']);
});

for (const language of ['zh', 'en']) test(language + ': old dispatches have their own tab with a one-line explanation', () => {
  const f = setup(language);
  try {
    const tab = f.host.querySelector('[data-board-tab="stale"]');
    assert.ok(tab); assert.equal(tab.dataset.count, '2'); assert.equal(f.host.querySelector('[data-board-tab="waiting"]').dataset.count, '4');
    tab.fire('click');
    const help = f.host.querySelector('.task-board-state-help');
    assert.equal(help.hidden, false);
    assert.ok(help.textContent.includes(language === 'zh' ? '会话已结束' : 'has ended'), help.textContent);
    assert.equal(f.host.querySelectorAll('.task-board-task').length, 2);
  } finally { f.board.dispose(); }
});

test('the open board starts with every agent, grouped by space, above the task tabs', () => {
  const f = setup();
  try {
    const panel = f.host.querySelector('.task-board-panel'), people = f.people();
    assert.ok(people, 'member section');
    assert.ok(panel.children.indexOf(people) >= 0 && panel.children.indexOf(people) < panel.children.indexOf(f.host.querySelector('.task-board-tabs')));
    assert.deepEqual(f.ids(f.space('dev')), ['a1', 'w1', 'd1', 'end1', 'i1'], 'waiting and working cards first, then the rest; archived left out');
    assert.deepEqual(f.ids(f.space('ops')), ['i1']);
    assert.deepEqual(f.ids(f.space('@independent')), ['solo'], 'an independent conversation that is not running is not listed');
    const summary = people.querySelector('.task-board-people-summary').textContent;
    for (const part of ['成员 6', '1 个等你', '2 个卡住或断开', '2 个在做', '1 个空闲']) assert.ok(summary.includes(part), part + ' in ' + summary);
    assert.ok(people.querySelector('.task-board-people-excluded').textContent.includes('已归档 1'));
    assert.ok(!f.host.textContent.includes('至少'));
    assert.ok(!people.textContent.includes('…'), 'nothing in the member section is cut');
  } finally { f.board.dispose(); }
});

test('a working agent card shows its state, minutes, current item with id and what waits under it', () => {
  const f = setup();
  try {
    const card = f.person('w1');
    assert.ok(card.classList.contains('task-board-person-card'));
    for (const part of [LONG, '在做 52 分', 'Current synthetic item', '#aaaaaaaa', '名下 2 件等你', '1 件排队']) assert.ok(card.textContent.includes(part), part);
    assert.ok(!card.textContent.includes('second line'));
    const label = card.getAttribute('aria-label');
    for (const part of [LONG, '在做 52 分', 'Current synthetic item']) assert.ok(label.includes(part), part + ' in ' + label);
    assert.equal(card.querySelector('.task-board-person-square').className, 'state-dot working task-board-person-square', 'the same square as the header');
    const asker = f.person('a1');
    assert.ok(asker.classList.contains('task-board-person-card'));
    assert.ok(asker.textContent.includes('Asker decision') && asker.textContent.includes('#gggggggg'));
    const strip = f.person('i1');
    assert.ok(strip.classList.contains('task-board-person-strip'));
    assert.ok(strip.textContent.includes('Idle member') && strip.textContent.includes('Idle'));
    card.fire('click');
    assert.deepEqual(f.calls, [['session', 'w1', 'n-w1']]);
    assert.equal(f.host.querySelector('.task-board-panel').hidden, true);
  } finally { f.board.dispose(); }
});

test('the old-dispatch line in a space opens their tab', () => {
  const f = setup();
  try {
    const line = f.space('dev').querySelector('.task-board-people-stale');
    assert.ok(line.textContent.includes('旧派单 2 件'), line.textContent);
    // The summary above counts agents, never items: name the counts these really leave.
    assert.ok(line.textContent.includes('不计入顶栏和「等你」标签的件数') && !line.textContent.includes('上面'), line.textContent);
    assert.equal(f.space('ops').querySelector('.task-board-people-stale'), null);
    line.fire('click');
    assert.equal(f.host.querySelector('[data-board-tab="stale"]').getAttribute('aria-selected'), 'true');
  } finally { f.board.dispose(); }
});

test('31 members across 4 spaces are all listed with whole names', () => {
  const spaces = ['s1', 's2', 's3', 's4'], data = { rooms: spaces.map(id => ({ id, name: 'Space ' + id, queue: [] })), sessions: [], confirmations: [], confirmationsAvailable: true, connected: true };
  for (let i = 0; i < 31; i++) data.sessions.push({ id: 'm' + i, name: 'Synthetic member number ' + i + ' with a long name', state: i % 3 ? 'idle' : 'working', roomIds: [spaces[i % 4]],
    ...shown(i % 3 ? 'state-dot idle' : 'state-dot working', i % 3 ? 'idle' : 'working', i % 3 ? 'Idle' : 'Working') });
  const f = setup('zh', data);
  try {
    assert.equal(f.ids(f.people()).length, 31);
    for (const s of data.sessions) assert.ok(f.person(s.id, s.roomIds[0]).textContent.includes(s.name), s.name);
  } finally { f.board.dispose(); }
});

test('en: the member section has no missing or Chinese-only text', () => {
  const f = setup('en');
  try {
    const text = f.people().textContent;
    for (const part of ['6 members', '1 needs you', '2 stuck or offline', '2 working', '1 idle', '52 min', '2 waiting for you', '1 queued', 'not counted in the header or the Needs you tab']) assert.ok(text.includes(part), part + ' in ' + text);
    assert.ok(!/[一-鿿]/.test(text), text);
  } finally { f.board.dispose(); }
});

test('the renderer hands the board each session\'s header square, group and short state', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  const start = source.indexOf('function updateTaskBoard('), end = source.indexOf('const spaceCall', start);
  assert.ok(start >= 0 && end > start);
  let captured;
  const distribution = require('../renderer/agent-distribution.js');
  const context = vm.createContext({ state: { sessions: [{ id: 'x', name: 'X', state: 'working' }, { id: 'y', name: 'Y', state: 'approval' }] }, disconnected: false, spaceId: 'dev',
    allSpaces: () => [], spaceName: r => r.name, taskBoard: { update: value => { captured = value; } },
    sidebarPresentation: s => s.state === 'working' ? { tone: 'working', workTone: '', compact: 'Working now', waiting: false } : { tone: 'approval', workTone: '', compact: 'Needs approval', waiting: true },
    window: { nativeWorkspaceAgentDistribution: distribution, nativeWorkspaceSpaces: { roomIds: () => [] }, nativeWorkspaceFleet: { currentFleet: () => ({ running: 0, unknown: 0, work: { unconfirmed: false } }) } } });
  vm.runInContext(source.slice(start, end) + '\nupdateTaskBoard();', context);
  assert.deepEqual(captured.sessions.map(s => [s.look, s.agentStatus, s.statusText]), [['state-dot working', 'working', 'Working now'], ['state-dot approval', 'waiting', 'Needs approval']]);
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
