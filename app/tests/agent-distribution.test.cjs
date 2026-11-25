const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const distribution = require('../renderer/agent-distribution.js'), locale = require('../ui-locale.js');
const { fixture } = require('./fixtures/task-board-dom.cjs');
const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
const slice = (from, to) => { const start = renderer.indexOf(from), end = renderer.indexOf(to, start); assert.ok(start >= 0 && end > start, from); return renderer.slice(start, end); };

const ROOMS = [{ id: 'room-a-id', name: 'Space A' }, { id: 'room-b-id', name: 'Space B' }];
const SESSIONS = [
  { id: 'synthetic-1', name: 'Member working', state: 'working', model: 'claude-opus-5-5', roomIds: ['room-a-id'] },
  { id: 'synthetic-2', name: 'Member idle', state: 'idle', model: 'gpt-6.1-sol', roomIds: ['room-a-id', 'room-b-id'] },
  { id: 'synthetic-3', name: 'Solo working', state: 'working', model: 'deepseek-flash', roomIds: [] },
  { id: 'synthetic-4', name: 'Solo idle', state: 'idle', roomIds: [] },
  { id: 'synthetic-5', name: 'Member offline', state: 'disconnected', model: 'gpt-6.1-sol', roomIds: ['room-a-id'] },
  { id: 'synthetic-6', name: 'Solo offline', state: 'disconnected', roomIds: [] },
  { id: 'synthetic-7', name: 'Archived', state: 'working', archived: true, roomIds: ['room-a-id'] },
  { id: 'synthetic-8', name: 'Unknown state', state: 'zzz', roomIds: [] },
  { id: 'synthetic-9', name: 'Other space asks', state: 'approval', model: 'claude-opus-5-5', roomIds: ['room-b-id'] },
  { id: 'synthetic-10', name: 'Other space offline', state: 'disconnected', roomIds: ['room-b-id'] },
];
const presentation = record => ({ tone: { working: 'working', idle: 'idle', approval: 'approval' }[record.state] || 'disconnected', workTone: '', waiting: record.state === 'approval', compact: 'state ' + record.state });

// The production universe code from renderer.js, with only its inputs stubbed.
function universe(sessions = SESSIONS, { steward, rooms = ROOMS } = {}) {
  let captured;
  const context = vm.createContext({ window: { nativeWorkspaceAgentDistribution: distribution }, state: { sessions, steward }, allSpaces: () => rooms, uiText: key => locale.format('zh', key),
    sidebarPresentation: presentation, inSpace: (s, id = 'room-a-id') => s.roomIds.includes(id), spaceName: room => room.name,
    ui: { displayText: value => value }, agentDistribution: { update: (entries, skipped) => { captured = { entries, skipped }; } } });
  vm.runInContext(renderer.split('\n').find(line => line.startsWith('const states = {')).replace('const states', 'var states'), context);
  vm.runInContext(slice('function distributionStewardRole(', '// A space\'s name as shown') + '\nupdateAgentDistribution();', context);
  return captured;
}
const text = language => (key, params) => locale.format(language, key, params);

test('the squares include every non-archived session, including offline and unknown agents', () => {
  const { entries, skipped } = universe();
  assert.deepEqual(Array.from(entries, e => e.id), ['synthetic-1', 'synthetic-2', 'synthetic-3', 'synthetic-4', 'synthetic-5', 'synthetic-6', 'synthetic-8', 'synthetic-9', 'synthetic-10']);
  assert.deepEqual({ ...skipped }, { archived: 1, other: 0 });
  const byStatus = distribution.groupBy(entries, 'status', key => key);
  assert.deepEqual(JSON.parse(JSON.stringify(byStatus.map(g => [g.status, g.members.map(e => e.id)]))), [['waiting', ['synthetic-9']], ['stuck', ['synthetic-5', 'synthetic-6', 'synthetic-8', 'synthetic-10']], ['working', ['synthetic-1', 'synthetic-3']], ['idle', ['synthetic-2', 'synthetic-4']]]);
  assert.equal(byStatus.reduce((n, g) => n + g.members.length, 0), entries.length);
});

test('steward roles follow the recorded designation and team space', () => {
  const rooms = ROOMS.map((room, index) => ({ ...room, stewardTeam: index === 1 }));
  const { entries } = universe(SESSIONS, { steward: { sessionId: 'synthetic-3' }, rooms });
  assert.equal(entries.find(entry => entry.id === 'synthetic-3').stewardRole, '大管家');
  assert.equal(entries.find(entry => entry.id === 'synthetic-9').stewardRole, '大管家团成员');
  assert.equal(entries.find(entry => entry.id === 'synthetic-1').stewardRole, '');
});

test('every grouping has readable names and no internal ids, in both languages', () => {
  const { entries } = universe();
  for (const language of ['zh', 'en']) {
    const t = key => text(language)('distribution.' + key);
    const status = distribution.groupBy(entries, 'status', t), model = distribution.groupBy(entries, 'model', t), space = distribution.groupBy(entries, 'space', t);
    assert.deepEqual(status.map(g => g.label), ['waiting', 'stuck', 'working', 'idle'].map(k => t('status.' + k)));
    assert.deepEqual(Object.fromEntries(model.map(g => [g.label, g.members.length])), { 'opus-5-5': 2, 'gpt-6.1-sol': 2, 'deepseek-flash': 1, [t('modelUnknown')]: 4 });
    assert.ok(model.every((g, i) => i === 0 || model[i - 1].members.length >= g.members.length), 'largest model group first');
    assert.deepEqual(space.map(g => [g.label, g.members.length]), [['Space A', 3], ['Space B', 3], [t('independent'), 4]]);
    for (const group of [...status, ...model, ...space]) {
      assert.ok(group.label && !/synthetic-|room-[ab]-id/u.test(group.label), group.label);
      assert.ok(!/^distribution\./u.test(group.label), 'translated: ' + group.label);
    }
  }
});

function strip(language = 'zh', options = {}) {
  const f = fixture(), host = f.doc.createElement('div'), jumps = [], modes = [];
  f.doc.createTextNode = value => { const n = f.doc.createElement('#text'); n.textContent = value; return n; };
  globalThis.innerWidth = 850;
  f.doc.body.append(host);
  const view = distribution.bind({ host, document: f.doc, text: text(language), onSession: id => jumps.push(id), onMode: mode => modes.push(mode), ...options });
  const { entries, skipped } = universe();
  view.update(entries, skipped);
  return { f, host, view, jumps, modes, entries };
}

test('each square has an accessible name, clicking one jumps to its session, and the strip summarises the groups', () => {
  const { host, jumps } = strip();
  const cells = host.querySelectorAll('.agent-cell');
  assert.equal(cells.length, 9);
  assert.equal(cells[0].getAttribute('aria-label'), 'Other space asks · state approval · claude-opus-5-5');
  assert.ok(cells.every(c => c.getAttribute('aria-label').split(' · ').length === 3 && !c.getAttribute('aria-label').includes('synthetic-')));
  assert.equal(host.querySelectorAll('.agent-cell').find(c => c.dataset.sessionId === 'synthetic-4').getAttribute('aria-label'), 'Solo idle · state idle · 未报告模型');
  assert.equal(host.querySelector('.agent-strip').getAttribute('aria-label'), '9 个 agent：等你 1 · 卡住或断开 4 · 在做 2 · 空闲 2');
  assert.equal(host.querySelector('.agent-strip').getAttribute('role'), 'group');
  assert.equal(host.querySelector('.agent-strip-toggle').getAttribute('aria-label'), 'agent 分布（按状态）：分组、图例和名单');
  host.querySelectorAll('.agent-cell').find(c => c.dataset.sessionId === 'synthetic-3').fire('click');
  assert.deepEqual(jumps, ['synthetic-3']);
});

test('the panel switches grouping, keeps a legend and the exclusion note, and its names jump too', () => {
  const { host, jumps, modes, view } = strip('en');
  const toggle = host.querySelector('.agent-strip-toggle'), panel = host.querySelector('.agent-strip-panel');
  const group = host.querySelector('.agent-group-trigger');
  group.fire('click');
  assert.equal(group.getAttribute('aria-expanded'), 'true');
  assert.equal(group.getAttribute('aria-controls'), 'agent-strip-panel');
  assert.equal(panel.matches(':popover-open'), true); assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  const radios = host.querySelectorAll('.agent-strip-mode');
  assert.deepEqual(radios.map(r => [r.dataset.mode, r.getAttribute('role'), r.getAttribute('aria-checked')]), [['status', 'radio', 'true'], ['model', 'radio', 'false'], ['space', 'radio', 'false']]);
  assert.equal(host.querySelector('.agent-strip-modes').getAttribute('aria-label'), 'Group by');
  assert.equal(host.querySelectorAll('.agent-legend-swatch').length, 6);
  assert.equal(host.querySelector('.agent-strip-note').textContent, 'Not counted: 1 archived; 0 outside this space and not running');
  radios[1].fire('click');
  assert.deepEqual(modes, ['model']); assert.equal(view.mode, 'model');
  assert.deepEqual(host.querySelector('.agent-strip').querySelectorAll('.agent-group-label').map(l => l.textContent), ['Model not reported', 'gpt-6.1-sol', 'opus-5-5', 'deepseek-flash']);
  host.querySelectorAll('.agent-strip-member').find(b => b.dataset.sessionId === 'synthetic-9').fire('click');
  assert.deepEqual(jumps, ['synthetic-9']); assert.equal(panel.matches(':popover-open'), false);
});

test('a roster update keeps keyboard focus on the same listed agent', () => {
  const { f, host, view, entries } = strip();
  host.querySelector('.agent-group-trigger').fire('click');
  const member = host.querySelectorAll('.agent-strip-member').find(row => row.dataset.sessionId === 'synthetic-1');
  member.focus();
  view.update(entries.map(entry => entry.id === 'synthetic-2' ? { ...entry, status: 'working' } : entry));
  assert.equal(f.doc.activeElement.dataset.sessionId, member.dataset.sessionId);
  assert.notEqual(f.doc.activeElement, member);
  assert.equal(host.querySelector('.agent-strip-panel').matches(':popover-open'), true);
});

test('a status update keeps keyboard focus on an agent square after it changes group', () => {
  const { f, host, view, entries } = strip();
  const square = () => host.querySelectorAll('.agent-cell').find(cell => cell.dataset.sessionId === 'synthetic-4');
  const original = square();
  original.focus();
  view.update(entries.map(entry => entry.id === 'synthetic-4' ? { ...entry, status: 'working' } : entry));
  assert.notEqual(square(), original);
  assert.equal(square().dataset.agentStatus, 'working');
  assert.ok(f.doc.activeElement === square(), 'focus moves to the replacement square');
});

test('the grouping choice is saved through the view store and restored on reopen without saving again', () => {
  const { validViews } = require('../view-store.cjs');
  assert.equal(validViews([{ owner: 'person', agentGrouping: 'model' }]), true);
  assert.equal(validViews([{ owner: 'person', agentGrouping: 'provider-id' }]), false);
  const main = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  assert.match(main, /for \(const key of \[[^\]]*'agentGrouping'[^\]]*\]\) if \(next\[key\] !== undefined\) c\.view\[key\]/u);
  assert.match(slice('function persistView()', '\n'), /agentGrouping: agentDistribution\.mode/u);
  assert.match(renderer, /agentDistribution\.setMode\(state\.viewState\.agentGrouping \|\| 'status'\)/u);
  const { host, modes, view } = strip('zh', { mode: 'space' });
  assert.equal(view.mode, 'space'); assert.deepEqual(host.querySelector('.agent-strip').querySelectorAll('.agent-group-label').map(l => l.textContent), ['Space A', 'Space B', '独立会话']);
  view.setMode('status'); assert.deepEqual(modes, [], 'restoring is not a new choice');
  view.setMode('not-a-mode'); assert.equal(view.mode, 'status');
});

test('an empty universe hides the strip instead of showing zero', () => {
  const { host, view } = strip();
  view.update([], { archived: 2, other: 0 });
  assert.equal(host.hidden, true); assert.equal(host.querySelectorAll('.agent-cell').length, 0);
});

test('the sidebar corner dot, the hover avatar, the header status dot and the square share one look', () => {
  const sites = renderer.split('\n').filter(line => line.includes('nativeWorkspaceAgentDistribution.look('));
  assert.equal(sites.length, 3, 'sidebar row, hover avatar, session status');
  assert.ok(sites.some(line => line.includes('row.dot.className')) && sites.some(line => line.includes("$('session-status')")));
  assert.equal(/className = [`'"]state-dot/u.test(renderer), false, 'no second status-to-colour mapping');
  const { entries } = universe(), { host, view } = strip();
  for (const record of SESSIONS.filter(s => entries.some(e => e.id === s.id))) {
    assert.equal(host.querySelectorAll('.agent-cell').find(c => c.dataset.sessionId === record.id).className, 'agent-cell ' + distribution.look(presentation(record)));
  }
  const changed = SESSIONS.map(s => s.id === 'synthetic-4' ? { ...s, state: 'working' } : s), next = universe(changed);
  view.update(next.entries, next.skipped);
  assert.equal(host.querySelectorAll('.agent-cell').find(c => c.dataset.sessionId === 'synthetic-4').className, 'agent-cell ' + distribution.look(presentation(changed[3])));
  assert.equal(distribution.look({ tone: 'idle', workTone: 'bg-unknown' }), 'state-dot idle bg-unknown');
  assert.equal(distribution.group({ tone: 'approval', waiting: false }), 'stuck');
  assert.equal(distribution.group({ tone: 'idle', workTone: 'goal-stopped' }), 'stuck');
  assert.equal(distribution.group({ tone: 'idle', workTone: 'bg-work' }), 'working');
});

test('raw tool names become plain words; sentences and other text stay as reported', () => {
  for (const language of ['zh', 'en']) {
    const t = text(language), plain = raw => distribution.plainActivity(raw, t);
    assert.equal(plain('mcp__native_workspace__workspace_control'), t('activity.tool.workspace_control'));
    assert.equal(plain('Bash'), t('activity.tool.Bash'));
    assert.equal(plain('mcp__playwright__browser_click'), t('activity.tool.mcp', { server: 'playwright' }));
    assert.equal(plain('NotebookEdit'), t('activity.tool.other'));
    assert.equal(plain('Reading the release notes'), 'Reading the release notes');
    assert.equal(plain('正在整理'), '正在整理');
    assert.equal(plain(''), '');
  }
  assert.equal(text('zh')('activity.tool.workspace_control'), '正在调用 NAW 控制');
});

test('the header activity line drops internal sub-task wording that the dot already shows', () => {
  const fleet = require('../renderer/fleet-observation.js');
  const context = vm.createContext({ window: { nativeWorkspaceFleet: fleet, nativeWorkspaceAgentDistribution: distribution }, disconnected: false,
    ui: { displayText: value => value }, uiText: text('zh'), stateText: () => '空闲', switchedAway: () => false });
  vm.runInContext(slice('function headerActivity(', "let state, owner, selected = ''"), context);
  const line = context.headerActivity({ id: 'synthetic-1', provider: 'claude', state: 'working', activity: 'mcp__native_workspace__workspace_control', fleet: [{ event: 'thread/started', id: 'child', time: 1 }] });
  assert.equal(line.includes('待核对'), false, line);
  assert.equal(line.includes('mcp__'), false, line);
  assert.ok(line.startsWith('正在调用 NAW 控制'), line);
});
