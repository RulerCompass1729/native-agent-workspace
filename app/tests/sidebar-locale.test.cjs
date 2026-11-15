const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const vendorMarks = require('./fixtures/vendor-marks.cjs');
const locale = require('../ui-locale.js'), spaces = require('../collaboration-spaces.cjs');
const renderer = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
const bootstrap = fs.readFileSync(require.resolve('../dsh/bootstrap.js'), 'utf8');
const start = bootstrap.indexOf('    function createDisplayBindings('), end = bootstrap.indexOf('    function mountWorkspace(', start);
assert.ok(start >= 0 && end > start);
const createBindings = vm.runInNewContext('(' + bootstrap.slice(start, end).trim() + ')');
class Element {
  constructor(tag = 'div', text = '') { this.tagName = tag; this.content = text; this.children = []; this.attrs = new Map(); this.dataset = {}; this.style = {}; this.value = ''; this.hidden = false; this.disabled = false; this.isConnected = true; const classes = new Set(); this.classList = { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name), toggle(name, yes) { if (yes) classes.add(name); else classes.delete(name); } }; }
  get childElementCount() { return this.children.length; }
  get textContent() { return this.content + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.content = String(value); this.children = []; }
  setAttribute(key, value) { this.attrs.set(key, String(value)); }
  getAttribute(key) { return this.attrs.get(key) ?? null; }
  hasAttribute(key) { return this.attrs.has(key); }
  removeAttribute(key) { this.attrs.delete(key); }
  add(option) { this.append(option); }
  get nextSibling() { const siblings = this.parentElement?.children || []; return siblings[siblings.indexOf(this) + 1] || null; }
  after(...nodes) { const next = this.nextSibling; for (const node of nodes) this.parentElement.insertBefore(node, next); }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  insertBefore(node, before) { node.remove(); node.parentElement = this; const index = before ? this.children.indexOf(before) : -1; this.children.splice(index < 0 ? this.children.length : index, 0, node); }
  replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.content = ''; this.append(...nodes); }
  remove() { if (this.parentElement) { this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; } }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  addEventListener() {}
  getClientRects() { return [1]; }
  querySelector(selector) { if (selector === '.group-chevron') return this.chevron ||= new Element('span'); return this.children.find(child => selector === 'button' && child.tagName === 'button') || null; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(selector === '[data-naw-i18n-bound]' && child.hasAttribute('data-naw-i18n-bound') ? [child] : []), ...child.querySelectorAll(selector)]); }
}
function fixture() {
  let language = 'zh'; const root = new Element(), elements = new Map(), calls = [], layoutWrites = [];
  const document = { activeElement: null, querySelector: () => ({ value: 'claude' }) };
  const node = (tag, text) => { const el = new Element(tag, text); el.focus = () => { document.activeElement = el; }; return el; };
  const $ = id => { if (!elements.has(id)) { const element = node('div'); element.id = id; elements.set(id, element); root.append(element); } return elements.get(id); };
  const uiText = (key, params) => locale.format(language, key, params), display = createBindings(uiText);
  const room = { id: 'shared', name: 'RAW SPACE 中文', archived: false }, people = [{ id: 'session-original-a', name: 'RAW NAME 中文', provider: 'codex', state: 'working', nativeId: 'original-native', owner: 'original-owner', liveDraft: 'UNSENT 中文', runtimeVersion: '0.1.0-alpha.1', roomIds: ['shared'], fleet: [], createdAt: 1793331000000, lastActivityAt: 1793331100000, messages: [] }];
  const state = { sessions: people, room, rooms: [room], sidebar: { archiveCollapsed: false }, appVersion: '0.1.0-alpha.2', capabilities: ['nativePermissionDefaults', 'createSkipPermissions', 'claudeHistory', 'gitWorktreeV1'], preflight: { python: true, claude: true } };
  const context = vm.createContext({ spaceName: room => spaces.untouchedDefault(room) ? uiText('space.defaultName') : room?.name, $, state, document, uiText, ui: { display, displayText: (raw, message) => locale.displayText(language, raw, message), language: { getSnapshot: () => ({ active: language }) } }, node,
    button: (text, onclick) => Object.assign(node('button', text), { onclick }), window: { nativeWorkspaceCollaboration: require('../renderer/collaboration-overview.js'), nativeWorkspaceSpaces: spaces, nativeWorkspaceFleet: require('../renderer/fleet-observation.js') },
    checkingBackendVersions: false, backendVersionMenu: null, backendVersionTicket: 0, disconnected: false, selected: people[0].id, spaceId: 'shared', sidebarView: 'flat', sidebarSpaceFilter: '', hoverSpace: '', renameTarget: null, sessionMenu: null, roomMenu: null,
    sessionRows: new Map(), sidebarGroups: new Map(), spaceRows: new Map(), sidebarLayout: { update: value => layoutWrites.push(value) },
    allSpaces: () => state.rooms, members: () => people, orderedMembers: () => people, spaceRecord: id => state.rooms.find(room => room.id === id), inSpace: (s, id) => spaces.isMember(s, id),
    roomTone: () => 'space-tone-0', draggableSession() {}, sidebarDropRow() {}, bindSpaceHighlight() {}, dropTarget() {}, highlightSpace() {}, icon: () => node('span', 'Cx'),
    participantLabel: s => s.name, focusAfterRemoval() {}, restoreArchivedRoom() {}, restoreArchivedSession() {},
    api: new Proxy({}, { get(_target, method) { calls.push(method); throw Error('Locale repaint reached product API: ' + method); } }),
    dialogTickets: new Map(), Option: function(text,value) { return Object.assign(node('option', text), { value }); }, creatingSession: false, newDirectory: false, gitPreviewLoading: false, gitWorktreePlan: null, folder: '/synthetic/original', invalidateGitPreview: () => calls.push('invalidateGitPreview'),
  });
  vendorMarks(renderer, context);
  function load(from, to) { const a = renderer.indexOf(from), b = renderer.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, from); vm.runInContext(renderer.slice(a, b), context); }
  load('const uiNode =', 'let state,'); load('function sessionTime(', 'function renderDraftRecovery(');
  load('function sidebarSessions(', 'async function restoreArchivedSession('); load('function renderSpaceNavigation(', 'function openSpaceCreate('); load('function createReadiness(', 'function renderArchives('); vm.runInContext(['createSpaceChoice', 'renderCreateSpaces'].map(name => renderer.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n}'))[0]).join('\n'), context); $('create-space-kind').value = 'independent';
  return { $, state, people, root, calls, layoutWrites, document, context, load, run: code => vm.runInContext(code, context), refresh(value) { language = value; display.refresh(root); } };
}

for (const [name, rooms, hidden] of [
  ['no stored spaces', [], true],
  ['untouched hidden default space', [{ id: 'shared', name: 'Untouched', archived: false }], true],
  ['only archived spaces', [{ id: 'archived', name: 'Archived', archived: true }], false],
  ['an active space', [{ id: 'active', name: 'Active', archived: false }], true],
  ['active and archived spaces', [{ id: 'active', name: 'Active', archived: false }, { id: 'archived', name: 'Archived', archived: true }], true]
]) test(`archive recovery hint describes real archived spaces: ${name}`, () => {
  const f = fixture(); f.state.rooms = structuredClone(rooms); f.people[0].roomIds = [];
  // Exercise the actual legacy-default filtering, not the locale fixture's stub.
  for (const name of ['storedSpaces', 'allSpaces']) {
    const match = renderer.match(new RegExp('^const ' + name + ' = (.*);$', 'm')); assert.ok(match);
    f.context[name] = vm.runInContext('(' + match[1] + ')', f.context);
  }
  const before = structuredClone(f.state);
  f.run('renderSpaceNavigation()');
  assert.equal(f.$('workspace-empty').hidden, hidden);
  f.refresh('en'); assert.equal(f.$('workspace-empty').hidden, hidden);
  assert.deepEqual(f.state, before); assert.deepEqual(f.calls, []);
});

test('language repaint keeps sidebar rows, controls, focus and original identity while updating status and accessibility', () => {
  const f = fixture(), before = structuredClone(f.state); f.run('renderSessions(); renderSpaceNavigation();');
  const row = f.context.sessionRows.get(f.people[0].id), link = row.link, more = row.more, body = f.$('session-list');
  f.document.activeElement = link; const action = link.onclick, layout = f.layoutWrites.length;
  // Real DOM visits a parent button before its child summary. No stale text may be copied from it.
  f.root.children = [f.$('solo-drop'), ...f.root.children.filter(child => child !== f.$('solo-drop'))];
  f.refresh('en');
  assert.equal(row.link, link); assert.equal(link.onclick, action); assert.equal(f.document.activeElement, link); assert.equal(body.children[0], row.element);
  assert.equal(row.name.textContent, 'RAW NAME 中文'); assert.equal(f.people[0].nativeId, 'original-native'); assert.equal(f.people[0].liveDraft, 'UNSENT 中文');
  assert.match(row.status.textContent, /^Working/); assert.match(link.getAttribute('aria-label'), /Spaces: RAW SPACE 中文/);
  assert.match(f.$('solo-drop').getAttribute('aria-label'), /Sessions · 1 · 1 working/);
  assert.match(more.getAttribute('aria-label'), /Session actions: RAW NAME 中文/); assert.equal(row.version.textContent, '↑'); assert.match(row.version.getAttribute('title'), /older backend/i);
  assert.match(f.$('room-nav').getAttribute('title'), /Open space “RAW SPACE 中文” · Members: 1/);
  assert.equal(f.layoutWrites.length, layout); assert.deepEqual(f.calls, []); assert.deepEqual(f.state, before);
  f.refresh('zh'); assert.match(row.status.textContent, /^正在工作/); assert.equal(f.document.activeElement, link);
});

test('create repaint keeps takeover ID, explicit Git and permission choices without rerunning readiness', () => {
  const f = fixture(); f.$('create-dialog').open = true; f.$('claude-history-id').value = 'original-native'; f.$('git-worktree').checked = true; f.$('skip-permissions').checked = true;
  f.run('createReadiness()'); const disabled = f.$('confirm-create').disabled, count = f.calls.length;
  f.document.activeElement = f.$('claude-history-id'); f.refresh('en');
  assert.equal(f.$('claude-history-id').value, 'original-native'); assert.equal(f.$('git-worktree').checked, true); assert.equal(f.$('skip-permissions').checked, true);
  assert.equal(f.$('confirm-create').disabled, disabled); assert.equal(f.document.activeElement, f.$('claude-history-id')); assert.equal(f.calls.length, count);
  assert.match(f.$('create-readiness').textContent, /original working directory/); assert.match(f.$('create-permission-note').textContent, /without asking/);
  assert.equal(f.$('open-native-history').textContent, 'Take over this Claude session');
  assert.equal(f.$('create-permission-note').textContent, locale.format('en', 'create.directoryCopy') + ' ' + locale.format('en', 'create.permissionsSkipped'));
  f.refresh('zh'); assert.equal(f.$('create-permission-note').textContent, locale.format('zh', 'create.directoryCopy') + locale.format('zh', 'create.permissionsSkipped'));
});

test('space choice labels repaint in place while keeping the selected raw workspace and draft', () => {
  const f = fixture(); f.$('create-dialog').open = true; f.$('create-space-kind').value = 'existing';
  f.run('renderCreateSpaces(); createSpaceReadiness()');
  const select = f.$('create-space-existing'), placeholder = select.children[0], rawOption = select.children[1];
  select.value = 'shared'; f.$('create-space-name').value = 'UNSENT 中文'; f.document.activeElement = select;
  f.refresh('en');
  assert.equal(select.children[0], placeholder); assert.equal(placeholder.textContent, 'Choose a space');
  assert.equal(select.children[1], rawOption); assert.equal(rawOption.textContent, 'RAW SPACE 中文');
  assert.equal(select.value, 'shared'); assert.equal(f.$('create-space-name').value, 'UNSENT 中文'); assert.equal(f.document.activeElement, select);
  assert.equal(f.$('create-space-help').textContent, locale.format('en', 'create.spaceHelpForExisting'));
  f.$('create-space-kind').value = 'independent'; f.run('createSpaceReadiness()'); f.refresh('zh');
  assert.equal(f.$('create-space-help').textContent, ''); assert.equal(f.$('create-space-help').hasAttribute('data-naw-i18n-bound'), false);
  // Exercise the actual close handler: a later locale refresh must not resurrect discarded help.
  f.$('create-space-kind').value = 'existing'; f.run('createSpaceReadiness()');
  const dialog = f.$('create-dialog'), listeners = new Map();
  dialog.addEventListener = (type, listener) => listeners.set(type, listener); f.document.querySelectorAll = () => [dialog];
  f.load("for (const dialog of document.querySelectorAll('dialog')) {", "$('setup-button').onclick");
  dialog.open = false; listeners.get('close')(); f.refresh('en');
  assert.equal(f.$('create-space-help').textContent, ''); assert.equal(f.$('create-space-help').hasAttribute('data-naw-i18n-bound'), false);
  assert.deepEqual(f.calls, []);
});

test('the independent group disclosure keeps its localized name in both accessible labels without a layout rewrite', () => {
  const f = fixture(); f.people[0].roomIds = [];
  f.context.crypto = require('node:crypto'); f.$('session-list').closest = () => null;
  f.context.sidebarCollapsedGroups = new Set(['independent']); f.run("sidebarView = 'grouped'; renderSessions()");
  const group = f.context.sidebarGroups.get(''), toggle = group.toggle, before = f.layoutWrites.length;
  assert.equal(toggle.getAttribute('aria-label'), '展开独立会话'); assert.equal(toggle.getAttribute('title'), '展开独立会话');
  f.document.activeElement = toggle; f.refresh('en');
  assert.equal(toggle.getAttribute('aria-label'), 'Expand Independent session'); assert.equal(toggle.getAttribute('title'), 'Expand Independent session');
  assert.equal(f.document.activeElement, toggle); assert.equal(f.layoutWrites.length, before); assert.equal(f.context.sidebarGroups.get('').toggle, toggle);
  f.refresh('zh'); assert.equal(toggle.getAttribute('aria-label'), '展开独立会话'); assert.equal(toggle.getAttribute('title'), '展开独立会话'); assert.deepEqual(f.calls, []);
});

// The grouped view names the untouched default space in the interface language right after a language switch, with no
// re-render: its heading, the heading's open-space name, ⋯, the fold toggle and its members' row labels (11-09).
for (const [stored, zh, en] of [[spaces.DEFAULT_ROOM_NAME, '共同工作', 'Shared work'], ['学习小组', '学习小组', '学习小组']]) test(`grouped sidebar repaints the space named ${JSON.stringify(stored)} in place: ${zh} / ${en}`, () => {
  const f = fixture(), other = { id: '11111111-1111-4111-8111-111111111111', name: 'Team 中文', archived: false };
  f.state.room.name = stored; f.state.rooms.push(other); f.people[0].roomIds = ['shared', other.id];
  f.context.crypto = require('node:crypto'); f.$('session-list').closest = () => null; f.context.sidebarCollapsedGroups = new Set();
  f.run("sidebarView = 'grouped'; renderSessions()");
  const before = structuredClone(f.state), group = f.context.sidebarGroups.get('shared'), row = f.context.sessionRows.get('group:shared:' + f.people[0].id);
  const elements = [group.element, group.title, group.more, group.toggle, row.element, row.link], layout = f.layoutWrites.length;
  // Everything the sidebar shows or names, including a plain title property.
  const strings = element => [element.content, element.title, ...element.attrs.values(), ...element.children.flatMap(strings)].filter(value => typeof value === 'string');
  const expect = (name, language) => {
    assert.equal(group.card.name.textContent, name, language);
    assert.equal(group.card.meta.textContent, locale.format(language, 'sidebar.hierarchy.cardCount', { count: 1 }) + ' · ' + locale.format(language, 'sidebar.hierarchy.cardWorking', { count: 1 }));
    assert.equal(group.title.getAttribute('aria-label'), locale.format(language, 'sidebar.openSpace', { name }));
    for (const slot of ['aria-label', 'title']) {
      assert.equal(group.more.getAttribute(slot), locale.format(language, 'sidebar.spaceActions', { name }), slot);
      assert.equal(group.toggle.getAttribute(slot), locale.format(language, 'sidebar.collapse', { name }), slot);
      assert.ok(row.link.getAttribute(slot).includes(locale.format(language, 'sidebar.memberships', { names: `${name}、Team 中文` })), slot);
      assert.ok(row.more.getAttribute(slot).endsWith(' · ' + name), slot);
    }
    assert.equal(row.more.getAttribute('aria-description'), f.run("sidebarDetails(state.sessions[0]).join(' · ')"), 'The row details follow the language');
    assert.ok(strings(row.badges).includes(`${name}、Team 中文`), 'The +1 badge lists both spaces');
  };
  expect(zh, 'zh');
  f.refresh('en'); expect(en, 'en');
  if (zh !== en) assert.deepEqual(strings(f.$('session-list')).filter(value => value.includes(zh)), [], 'No Chinese default name is left in the English sidebar');
  f.refresh('zh'); expect(zh, 'zh');
  const after = f.context.sidebarGroups.get('shared'), rowAfter = f.context.sessionRows.get('group:shared:' + f.people[0].id);
  assert.deepEqual([after.element, after.title, after.more, after.toggle, rowAfter.element, rowAfter.link], elements, 'Repainted in place, not rebuilt');
  assert.equal(f.layoutWrites.length, layout); assert.deepEqual(f.calls, []); assert.deepEqual(f.state, before);
  assert.equal(f.state.room.name, stored, 'Display never changes the stored name');
});

test('archived rows repaint without reopening a process or replacing focused restore controls', () => {
  const f = fixture(); f.people[0].archived = true; f.people[0].state = 'recoverable'; f.$('archive-group-body').hidden = false;
  f.run('renderArchives()'); const row = f.$('archive-list').children[0], restore = row.children.at(-1).querySelector('button'); f.document.activeElement = restore;
  f.refresh('en'); assert.equal(f.$('archive-list').children[0], row); assert.equal(f.document.activeElement, restore); assert.equal(restore.textContent, 'Restore session');
  assert.equal(row.children[0].textContent, 'RAW NAME 中文'); assert.match(row.children[1].textContent, /Awaiting recovery.*Resume native history/); assert.deepEqual(f.calls, []);
});
test('archive rows offer the same chain list beside restore without adding a menu or restoring on inspection', () => {
  const f = fixture(), opened = [];
  f.people[0].archived = true;
  f.state.rotationChains = [{ sessions: [{ id: f.people[0].id, handedAt: null }, { id: 'new', handedAt: 100 }] }];
  f.context.openSessionChain = id => opened.push(id);
  f.run('renderArchives()');
  const actions = f.$('archive-list').children[0].children.at(-1);
  assert.deepEqual(actions.children.map(button => button.textContent), ['这串会话', '恢复会话']);
  actions.children[0].onclick(); assert.deepEqual(opened, [f.people[0].id]);
  f.refresh('en');
  assert.deepEqual(actions.children.map(button => button.textContent), ['Conversation chain', 'Restore session']);
  assert.deepEqual(f.calls, []);
  f.state.rotationChains = []; f.run('renderArchives()');
  assert.equal(f.$('archive-list').children[0].children.at(-1).children.length, 1);
});

test('subtitle native fields remain raw while the last own membership label repaints in place', () => {
  const f = fixture(); const from = renderer.indexOf('  const settings = s?.nativeSettings', renderer.indexOf('function renderHeaderLayout(')), to = renderer.indexOf('  if (sessionMenu?.anchor', from);
  assert.ok(from > 0 && to > from); vm.runInContext('function paintIdentity(s, inRoom, compact, compactRoom) { ' + renderer.slice(from, to) + ' }', f.context);
  f.people[0].model = 'RAW 模型'; f.run('paintIdentity(state.sessions[0], false, true, false)');
  const fields = [...f.$('subtitle').children]; f.document.activeElement = fields[2]; f.refresh('en');
  assert.deepEqual(f.$('subtitle').children, fields); assert.equal(fields[2].textContent, 'RAW 模型'); assert.equal(f.document.activeElement, fields[2]);
  assert.equal(fields.at(-1).textContent, 'Collaborating; independent use available'); assert.equal(fields.at(-1).getAttribute('aria-label'), fields.at(-1).textContent); assert.deepEqual(f.calls, []);
  const notice = locale.createNotice('notice.model.nativeUnreported');
  Object.assign(f.people[0], { model: notice.text, modelUiMessage: notice.uiMessage }); f.run('paintIdentity(state.sessions[0], false, true, false)');
  const model = f.$('subtitle').children[2]; f.document.activeElement = model; f.refresh('zh'); f.refresh('en');
  assert.equal(f.$('subtitle').children[2], model); assert.equal(f.document.activeElement, model);
  assert.equal(model.textContent, 'Not reported by native process'); assert.equal(model.getAttribute('title'), model.textContent); assert.equal(model.getAttribute('aria-label'), model.textContent);
  delete f.people[0].modelUiMessage; f.run('paintIdentity(state.sessions[0], false, true, false)');
  assert.equal(f.$('subtitle').children[2].textContent, '原生未报告', 'A real model name equal to an owned placeholder invalidates the cached descriptor');
  Object.assign(f.people[0], { modelUiMessage: notice.uiMessage }); f.run('paintIdentity(state.sessions[0], false, false, false)');
  assert.match(f.$('subtitle').textContent, /Not reported by native process/); assert.deepEqual(f.calls, []);
});

test('known native activity enums repaint but original permission titles and turn identity stay raw', () => {
  const f = fixture(); f.context.nativeStatusFresh = status => status?.stale !== true; f.load('// Only known activity enums', 'const nativeActivityClock =');
  const s = f.people[0]; s.activeTurnId = 'original-turn'; s.nativeActivity = { nativeId: s.nativeId, turnId: s.activeTurnId, label: 'thinking', startedAt: Date.now() - 5000 };
  f.run('renderNativeActivity(state.sessions[0])'); f.refresh('en'); assert.match(f.$('native-phase').textContent, /RAW NAME 中文 · Thinking/); assert.match(f.$('native-elapsed').textContent, /Elapsed/);
  s.nativeActivity.label = 'ORIGINAL 权限请求'; f.run('renderNativeActivity(state.sessions[0])'); f.refresh('zh');
  assert.equal(f.$('native-phase').textContent, 'RAW NAME 中文 · ORIGINAL 权限请求'); assert.equal(s.activeTurnId, 'original-turn'); assert.deepEqual(f.calls, []);
});

test('version reports translate only owned labels and keep exact backend version and UTC receipt', () => {
  const f = fixture(); f.state.appBuild = { commit: 'b'.repeat(40), installedAt: '2026-10-30T06:08:01.000Z' };
  f.refresh('en'); const text = f.run('appVersionReport(state)'); assert.match(text, /App version: 0.1.0-alpha.2/); assert.match(text, /Installed: 2026-10-30T06:08:01.000Z/);
  assert.equal(text.includes(f.people[0].name), false); assert.equal(text.includes(f.people[0].liveDraft), false); assert.deepEqual(f.calls, []);
});

// A stopped create must retain its real action and explanation across a locale refresh (T-115/T-60).
test('language refresh preserves an unconfirmed, retained or join-only create without creating again', () => {
  for (const kind of ['unconfirmed', 'retained', 'join']) {
    const f = fixture(), session = f.people[0], before = JSON.stringify(f.state);
    const ticket = kind === 'join' ? { creation: { sessionId: session.id, roomId: 'shared' } } : { created: kind === 'unconfirmed' ? 'unconfirmed' : session.id };
    f.$('create-dialog').open = true; f.context.dialogTickets.set(f.$('create-dialog'), ticket);
    f.run('createReadiness()'); f.refresh('en');
    assert.equal(f.$('cancel-create').textContent, 'Close and keep results', kind);
    assert.equal(f.$('confirm-create').disabled, kind !== 'join', kind);
    assert.equal(f.$('choose-folder').disabled, true, kind);
    if (kind === 'join') { assert.equal(f.$('confirm-create').textContent, 'Join only'); assert.equal(f.$('create-readiness').textContent, ''); }
    else assert.match(f.$('create-readiness').textContent, kind === 'unconfirmed' ? /Unable to confirm/ : /already created and kept/);
    assert.equal(JSON.stringify(f.state), before); assert.equal(session.liveDraft, 'UNSENT 中文'); assert.equal(ticket.creation?.sessionId || ticket.created, kind === 'unconfirmed' ? 'unconfirmed' : session.id);
    assert.deepEqual(f.calls, []);
  }
});
