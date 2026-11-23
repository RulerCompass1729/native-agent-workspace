const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const localeUI = require('./fixtures/locale-ui.cjs'), spaces = require('../collaboration-spaces.cjs');
const source = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
function actual(name) { const start = source.indexOf(`function ${name}(`); assert.ok(start >= 0); const next = /\n(?:async )?function /g; next.lastIndex = start + 1; return source.slice(start, next.exec(source).index); }
function harness() {
  const calls = [], nodes = new Map(), surface = { dataset: { collapsed: 'false' } }, locale = localeUI('en'); let menu;
  const $ = id => { if (!nodes.has(id)) nodes.set(id, { hidden: false, attrs: {}, isConnected: true, setAttribute(k, v) { this.attrs[k] = v; }, getBoundingClientRect: () => ({ left: 0, top: 0 }), getClientRects: () => [{}], focus() {}, closest: () => surface }); return nodes.get(id); };
  const context = vm.createContext({ ...locale, $, selected: 'room', spaceId: 'shared', spaceNavigationMenu: null, spaceRecord: id => context.roomList.find(room => room.id === id), switched: [], renderSpaceSwitch: room => context.switched.push(room?.id || null),
    focusedRoomMember: () => Boolean(context.selected === 'room' && context.roomSurface === 'overview' && context.roomSession), roomSurface: 'overview', roomSession: '',
    state: { room: { name: 'Demo' }, sessions: [], steward: {} }, roomList: [{ id: 'shared', name: 'Demo' }, { id: '00000000-0000-4000-8000-000000000001', name: 'Archived', archived: true }],
    allSpaces() { return context.roomList; }, inSpace: (record, id) => spaces.isMember(record, id), members: () => [], orderedMembers: () => context.state.sessions,
    participantLabel: record => record.name, spaceName: room => room.name, sidebarPresentation: () => ({ full: 'Ready' }),
    attempt: fn => fn(), select: id => calls.push(['session', id]), selectSpace: id => calls.push(['space', id]), toastMessage: key => calls.push(['toast', key]),
  });
  context.ui.toggleSidebar = () => { calls.push(['toggle']); surface.dataset.collapsed = String(surface.dataset.collapsed !== 'true'); };
  context.ui.menu = value => { menu = value; return () => { value.onClose(); }; };
  vm.runInContext(['spaceMemberLabel', 'sidebarSessions', 'independentNavigationSessions', 'openSpaceNavigation', 'renderSpaceRail'].map(actual).join('\n'), context);
  return { context, calls, $, surface, menu: () => menu };
}
test('space labels strip only the exact contextual prefix and retain ambiguous or empty identities', () => {
  const { context: c } = harness();
  const record = { id: 'a', name: 'Demo · Codex test · 续' }; c.state.sessions = [record];
  assert.equal(c.spaceMemberLabel(record), 'Codex test · 续');
  for (const name of ['Demonstration · Codex', 'Demo · ', '<script>literal</script>']) { record.name = name; assert.equal(c.spaceMemberLabel(record), name); }
  record.name = 'Demo · Codex test'; c.state.sessions.push({ id: 'b', name: 'Codex test' });
  assert.equal(c.spaceMemberLabel(record), 'Demo · Codex test', 'A shortened-name collision falls back to the full identity');
});
test('independent navigation excludes active-space members, archived sessions and the designated butler', () => {
  const { context: c } = harness();
  c.state.sessions = [{ id: 'free', name: 'Independent' }, spaces.withMembership({ id: 'joined', name: 'Joined' }, 'shared', true), spaces.withMembership({ id: 'old-home', name: 'Old home' }, '00000000-0000-4000-8000-000000000001', true), { id: 'archived', name: 'Archived', archived: true }, { id: 'butler', name: 'Butler' }];
  c.state.steward.sessionId = 'butler';
  assert.deepEqual(Array.from(c.independentNavigationSessions(), r => r.id), ['free', 'old-home']);
});
test('space and independent menus invoke only the existing navigation routes with exact IDs', () => {
  const { context: c, $, menu, calls } = harness(); c.state.sessions = [{ id: 'free', name: 'Independent' }];
  c.openSpaceNavigation('spaces', $('space')); assert.deepEqual(Array.from(menu().items, r => r.id), ['shared']); assert.equal(menu().items[0].label.endsWith(' · Current space'), true); menu().onSelect('shared'); assert.deepEqual(calls, [['space', 'shared']]);
  menu().onClose(); c.openSpaceNavigation('sessions', $('sessions')); assert.deepEqual(Array.from(menu().items, r => r.id), ['free']); menu().onSelect('free'); assert.deepEqual(calls.at(-1), ['session', 'free']);
});
for (const change of ['space archived', 'session joined', 'session archived', 'butler designated']) test(`an open navigation menu rechecks ${change} before selecting`, () => {
  const { context: c, $, menu, calls } = harness(); c.state.sessions = [{ id: 'free', name: 'Independent' }];
  const kind = change === 'space archived' ? 'spaces' : 'sessions'; c.openSpaceNavigation(kind, $('anchor'));
  if (change === 'space archived') c.roomList[0].archived = true;
  if (change === 'session joined') c.state.sessions[0] = spaces.withMembership(c.state.sessions[0], 'shared', true);
  if (change === 'session archived') c.state.sessions[0].archived = true;
  if (change === 'butler designated') c.state.steward.sessionId = 'free';
  menu().onSelect(kind === 'spaces' ? 'shared' : 'free'); assert.deepEqual(calls, [['toast', 'navigation.changed']]);
});
// 11-23 requirement change: entering a space used to collapse the sidebar (one toggle in, one out);
// the person now wants that space's members listed at full width, so the width never changes here.
test('entering or leaving a space leaves the sidebar width as the person set it', () => {
  const { context: c, calls, $, surface } = harness();
  for (const collapsed of ['false', 'true']) {
    surface.dataset.collapsed = collapsed; calls.length = 0;
    c.selected = 'room'; c.renderSpaceRail(); c.renderSpaceRail(); assert.equal($('space-rail-routes').hidden, false);
    c.selected = 'free'; c.renderSpaceRail(); assert.equal($('switch-space').hidden, true);
    assert.deepEqual(calls, [], `no DSH toggle from ${collapsed === 'true' ? 'collapsed' : 'expanded'}`); assert.equal(surface.dataset.collapsed, collapsed);
  }
  assert.deepEqual(Array.from(c.switched), ['shared', 'shared', null, 'shared', 'shared', null], 'The switch carries the space name only while the space view is shown');
});
test('the independent empty state offers no implicit create, join or native-control action', () => {
  const { context: c, $, menu, calls } = harness(); c.openSpaceNavigation('sessions', $('anchor'));
  assert.equal(menu().items.length, 1); assert.equal(menu().items[0].disabled, true); assert.match(menu().items[0].label, /No independent/); assert.deepEqual(calls, []);
});
