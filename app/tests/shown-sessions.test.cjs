// A window's page gets the messages only of the sessions it shows (UI lag, 2026-11-12). These tests run
// the actual module, the actual page readers and the actual main handlers on synthetic records.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { messageSummary, omitHidden, reportShown, validShown } = require('../shown-sessions.cjs');
const { rotationChains } = require('../queue-dispatch.cjs');
const collaboration = require('../renderer/collaboration-overview.js');
const renderer = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
function between(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'the actual source: ' + start);
  return source.slice(a, b);
}
const BASE = Date.parse('2026-11-12T12:00:00Z');

// Deterministic lists with every case the page rules distinguish: roles, gaps, volatile rows, bad times,
// ids and texts that do or do not count as a reply.
function lists(count = 300) {
  let seed = 7;
  const next = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const pick = values => values[next(values.length)];
  const result = [[]];
  for (let i = 0; i < count; i++) {
    const length = next(9), messages = [];
    for (let j = 0; j < length; j++) messages.push({
      id: pick(['m' + i + '-' + j, '', 42, undefined]),
      role: pick(['user', 'assistant', 'assistant', 'tool', 'system', undefined]),
      kind: pick([undefined, undefined, 'gap', 'tool']),
      volatile: pick([false, false, true]),
      time: pick([BASE + next(100000), BASE - next(100000), NaN, null, Infinity, 1e20, '2026', undefined]),
      text: pick(['reply ' + j, '  ', '', 7, undefined, '一段很长的回复'.repeat(next(60))]),
      nativeId: pick([undefined, 'native-a', 'native-old']), turnId: pick([undefined, 'turn-' + j]), incomplete: pick([undefined, true]),
    });
    result.push(messages);
  }
  return result;
}
// Objects made inside a vm context have that context's prototypes.
const plain = value => JSON.parse(JSON.stringify(value));
const omit = session => omitHidden({ sessions: [session] }, new Set()).sessions[0];

test('a window without a report gets every message; a report leaves out the rest, unchanged otherwise', () => {
  const a = { id: 'a', name: 'A', messages: [{ id: '1', role: 'assistant', text: 'x', time: BASE }] }, b = { id: 'b', name: 'B', state: 'working', messages: [{ id: '2', role: 'user', text: 'y', time: BASE }] };
  const display = { sessions: [a, b], room: { id: 'shared' } }, before = JSON.stringify(display);
  assert.equal(omitHidden(display, null), display);
  const sent = omitHidden(display, new Set(['a']));
  assert.equal(sent.sessions[0], a); assert.equal(sent.room, display.room);
  assert.deepEqual(sent.sessions[1], { id: 'b', name: 'B', state: 'working', messages: [], messagesOmitted: true,
    messageSummary: { latestAt: BASE, turnFirstAt: BASE, turnLastAt: BASE, hasAssistant: false, lastAssistant: null } });
  assert.equal(JSON.stringify(display), before, 'what main holds is not changed');
  assert.deepEqual(omitHidden(display, new Set()).sessions.map(s => s.messagesOmitted), [true, true]);
  assert.equal(omitHidden(null, new Set()), null);
});

test('a report is a list of at most 1000 session ids', () => {
  for (const ids of [[], ['a'], Array(1000).fill('x'), ['x'.repeat(100)]]) assert.equal(validShown(ids), true);
  for (const ids of [null, 'a', {}, [1], [''], ['x'.repeat(101)], Array(1001).fill('x'), [null]]) assert.equal(validShown(ids), false, JSON.stringify(ids)?.slice(0, 40));
});

test('a report returns the messages only of sessions the page did not get until now, read once', () => {
  let reads = 0;
  const display = () => { reads++; return { sessions: [{ id: 'a', messages: ['A'] }, { id: 'b', messages: ['B'] }, { id: 'c', messages: ['C'] }] }; };
  // Until its first report the page has had every message.
  let report = reportShown(null, ['a'], display);
  assert.deepEqual([...report.shown], ['a']); assert.deepEqual(report.messages, {}); assert.equal(reads, 0);
  report = reportShown(report.shown, ['a', 'b', 'c'], display);
  assert.deepEqual(report.messages, { b: ['B'], c: ['C'] }); assert.equal(reads, 1);
  report = reportShown(report.shown, ['c'], display);
  assert.deepEqual(report.messages, {}); assert.equal(reads, 1);
  report = reportShown(report.shown, ['a', 'gone'], display);
  assert.deepEqual(report.messages, { a: ['A'] });
});

// Condition ②: every page reader of a session's messages gives the same result for a left-out session.
test('the sidebar time, the handoff chain, the terminal start and the reply excerpt read the same from a left-out session', () => {
  const page = vm.createContext({ Date, Number, Set, Map, state: null, participantLabel: record => record.name || record.id, uiText: (key, params) => key + JSON.stringify(params || {}), ui: { language: { getSnapshot: () => ({ active: 'zh' }) } } });
  vm.runInContext(between(renderer, 'function sessionTime(', '\nfunction renderDraftRecovery(') + '\n' + between(renderer, 'function hasAssistantMessage(', '\nfunction sessionMessages('), page);
  const entries = [{ time: BASE, event: 'done', spaces: ['space'], old: { id: 'old', name: 'old', nativeId: 'native-old' }, new: { id: 'new', name: 'new', nativeId: 'native-new' } }];
  let compared = 0;
  for (const messages of lists()) {
    const record = { id: 'old', name: 'old', nativeId: 'native-a', createdAt: BASE - 5000, messages }, left = omit(record);
    assert.equal(page.sessionActivityTime(left), page.sessionActivityTime(record));
    assert.equal(page.hasAssistantMessage(left), page.hasAssistantMessage(record));
    assert.deepEqual(collaboration.excerpt(left), collaboration.excerpt(record));
    // The overview passes no list for a left-out member (renderer.js options.messages): the same default.
    assert.deepEqual(collaboration.excerpt(left, undefined), collaboration.excerpt(record));
    const other = { id: 'new', name: 'new', nativeId: 'native-new', createdAt: BASE + 10, messages: messages.slice(0, 2) };
    // The model carries each record itself: compared without it, the rest is what the dialog shows.
    const chain = sessions => { page.state = { sessions, rotationChains: rotationChains(entries) }; const model = page.sessionChainModel('new'); return JSON.stringify({ ...model, sessions: model.sessions.map(({ record: _record, ...row }) => row) }); };
    assert.equal(chain([left, omit(other)]), chain([record, other]));
    compared++;
  }
  assert.ok(compared > 300);
});

function pageShown({ sessions, active = 'a', room = false, roomMembers = [], queued = [] } = {}) {
  const calls = [], renders = [];
  const context = vm.createContext({ Map, Set, Promise, Object, Array, state: { sessions }, selected: room ? 'room' : active,
    activeSessionId: () => context.active, members: () => context.roomMembers.map(id => context.state.sessions.find(s => s.id === id)).filter(Boolean),
    queuedInputs: new Map(queued.map(id => [id, {}])), render: () => renders.push(true),
    api: { shownSessions: ids => { const call = { ids }; calls.push(call); return new Promise((resolve, reject) => Object.assign(call, { resolve, reject })); } } });
  Object.assign(context, { active, roomMembers });
  vm.runInContext(between(renderer, 'const shownPending = new Map();', '\nfunction orderedMembers(') + '\n' + between(renderer, 'function updateState(', '\n// Like a native TUI queue'), context);
  Object.assign(context, { projectSpace: s => s, legacyProgressOffline: () => false, latestViewStorage: undefined, sessionComposers: new Map(), queuedRoomInputs: new Map(), followQueuedInput() {} });
  return { context, calls, renders };
}
const left = (id, extra = {}) => ({ id, messages: [], messagesOmitted: true, messageSummary: { latestAt: null }, ...extra });

test('the page reports what it shows once per change, and the views it opens wait for their messages', async () => {
  const p = pageShown({ sessions: [{ id: 'a', messages: ['A'] }, left('b', { name: 'B' }), left('c'), { id: 'q', messages: [] }], queued: ['q'] });
  assert.equal(p.context.ensureMessages(['a']), null, 'a shown session switches at once, as before');
  assert.equal(p.calls.length, 0);
  p.context.reportShown();
  assert.deepEqual(p.calls.map(c => [...c.ids]), [['a', 'q']], 'the open session and one with a queued input');
  p.context.reportShown(); assert.equal(p.calls.length, 1, 'nothing new, nothing sent');
  p.calls[0].resolve({ messages: {} });
  const opening = p.context.ensureMessages(['b', 'b', 'a']);
  assert.deepEqual(p.calls.map(c => [...c.ids]).at(-1), ['a', 'b', 'q']);
  p.context.reportShown(); assert.equal(p.calls.length, 2, 'a render meanwhile does not ask again');
  p.calls[1].resolve({ messages: { b: ['B1'], a: ['ignored: not left out'] } }); await opening;
  assert.deepEqual(plain(p.context.state.sessions[1]), { id: 'b', name: 'B', messages: ['B1'] });
  assert.deepEqual(plain(p.context.state.sessions[0].messages), ['A']);
  assert.equal(p.renders.length, 0, 'b is not on screen until the view that asked switches');
  assert.equal(vm.runInContext('shownPending.size', p.context), 0);
  // A failed report is asked again by the next render.
  p.context.active = 'c'; p.context.reportShown(); p.calls[2].reject(Error('closed')); await new Promise(setImmediate);
  p.context.reportShown(); assert.equal(p.calls.length, 4);
  p.calls[3].resolve({ messages: { c: ['C1'] } }); await new Promise(setImmediate);
  assert.equal(p.renders.length, 1, 'c is on screen: drawn again with its messages');
});

test('an open space counts its members as shown', () => {
  const p = pageShown({ sessions: [{ id: 'a', messages: [] }, { id: 'm1', messages: [] }, { id: 'm2', messages: [] }], room: true, active: '', roomMembers: ['m2', 'm1', 'gone'] });
  p.context.reportShown();
  assert.deepEqual([...p.calls[0].ids], ['m1', 'm2']);
});

test('an older state that still leaves out a session the page now shows does not take its messages away', async () => {
  const p = pageShown({ sessions: [{ id: 'a', messages: ['A'] }, left('b')] });
  const opening = p.context.ensureMessages(['b']);
  p.calls[0].resolve({ messages: { b: ['B1'] } }); await opening;
  // Main made this state before it learned that the page shows b; it arrives after the reply.
  p.context.updateState({ sessions: [{ id: 'a', messages: ['A2'] }, left('b', { state: 'working' })] });
  assert.deepEqual(plain(p.context.state.sessions[1]), { id: 'b', state: 'working', messages: ['B1'] });
  // A session the page does not show is taken as main sends it.
  p.context.updateState({ sessions: [{ id: 'a', messages: ['A2'] }, { id: 'b', messages: ['B2'] }, left('z')] });
  assert.equal(p.context.state.sessions[2].messagesOmitted, true);
  p.context.updateState({ sessions: [left('a'), { id: 'b', messages: ['B2'] }, left('z')] });
  assert.deepEqual(plain(p.context.state.sessions.map(s => Boolean(s.messagesOmitted))), [false, false, true], 'a stays: the last answered report has it');
});

function mainHandlers(snapshot) {
  const handlers = new Map();
  const context = vm.createContext({ require, uiError: key => Object.assign(Error(key), { key }), displayState: value => structuredClone(value),
    register: (name, fn) => handlers.set(name, fn), ...require('../shown-sessions.cjs'), ...require('../renderer/local-search.js') });
  vm.runInContext(between(main, "  register('shownSessions',", "\n  register('mobilePairing',"), context);
  const window = { client: { snapshot: () => snapshot }, shown: null, view: {} };
  return { handlers, window };
}

test('main records what a page shows and answers with the messages it newly needs', () => {
  const snapshot = { sessions: [{ id: 'a', messages: ['A'] }, { id: 'b', messages: ['B'] }], room: { id: 'shared', messages: [] } };
  const { handlers, window } = mainHandlers(snapshot), report = handlers.get('shownSessions');
  assert.throws(() => report({ ...window, background: true }, ['a']), /invalidViewState/);
  assert.throws(() => report(window, 'a'), /invalidViewState/);
  assert.deepEqual(plain(report(window, ['a'])), { messages: {} });
  assert.deepEqual([...window.shown], ['a']);
  assert.deepEqual(plain(report(window, ['a', 'b'])), { messages: { b: ['B'] } });
});

test('main searches every session, also those a page does not hold, with the page\'s own rules', () => {
  const room = { id: 'space-1', name: 'Space', messages: [{ id: 'r1', role: 'user', text: 'needle in space' }] };
  const snapshot = { sessions: [{ id: 'a', name: 'A', provider: 'codex', messages: [] }, { id: 'b', name: 'B', provider: 'claude', messages: [{ id: 'b1', role: 'assistant', text: 'a needle here' }] }],
    room: { id: 'shared', messages: [{ id: 's1', role: 'user', text: 'needle in shared' }] }, rooms: [{ id: 'shared', messages: [{ id: 's1', role: 'user', text: 'needle in shared' }] }, room] };
  const { handlers, window } = mainHandlers(snapshot), search = handlers.get('search');
  window.shown = new Set(['a']);
  const all = search(window, 'needle', { scope: 'all', limit: 60, spaceId: 'space-1' });
  assert.deepEqual(plain(all.results.map(r => r.key)), ['message:b:b1', 'shared:s1', 'shared:space-1:r1']);
  assert.deepEqual(search(window, 'needle', { scope: 'room', spaceId: 'space-1' }).results.map(r => r.key), ['shared:space-1:r1']);
  assert.deepEqual(search(window, 'needle', { scope: 'room', spaceId: 'shared' }).results.map(r => r.key), ['shared:s1']);
  assert.deepEqual(search(window, 'needle', { scope: 'room', spaceId: 'removed' }), { results: [], total: 0 });
  assert.throws(() => search(window, 'x'.repeat(1001), {}), /searchTooLong/);
  assert.throws(() => search(window, 7, {}), /searchTooLong/);
  // The page's "include archived" box.
  const old = mainHandlers({ sessions: [{ id: 'old', name: 'Old', archived: true, messages: [{ id: 'o1', role: 'user', text: 'needle archived' }] }], room: { id: 'shared', messages: [] } });
  assert.equal(old.handlers.get('search')(old.window, 'needle', {}).total, 0);
  assert.deepEqual(old.handlers.get('search')(old.window, 'needle', { archived: true }).results.map(r => r.key), ['message:old:o1']);
});

test('an agent\'s background view cannot search: search reads every conversation, its view only those it was given', () => {
  const { handlers, window } = mainHandlers({ sessions: [{ id: 'b', name: 'B', messages: [{ id: 'b1', role: 'assistant', text: 'needle' }] }], room: { id: 'shared', messages: [] } });
  assert.throws(() => handlers.get('search')({ ...window, background: true }, 'needle', {}), /desktopOnly/);
  assert.equal(handlers.get('search')(window, 'needle', {}).total, 1);
});

const tick = () => new Promise(setImmediate);
test('switching to a left-out session waits for its messages; a later switch meanwhile wins', async () => {
  const switched = [], effects = [], waits = new Map();
  const context = vm.createContext({ selectionRevision: 0, roomSession: '', members: () => [], switched, terminals: new Map(), activeSessionId: () => 'shown',
    ensureMessages: ids => ids[0] === 'shown' ? null : new Promise(resolve => waits.set(ids[0], resolve)),
    rememberRoomMemberView: () => effects.push('remember'), captureReadingViews: () => effects.push('capture'), suspendColumnInputs() {} });
  // Up to the switch itself: what runs before is what the old view must not suffer from a stale selection.
  vm.runInContext(between(renderer, 'async function select(', '\n  if (id === \'room\') roomSession = member;') + '\n  switched.push(id);\n}', context);
  await context.select('shown'); assert.deepEqual(switched, ['shown'], 'a shown session switches at once');
  const b = context.select('b'); await tick();
  assert.deepEqual(switched, ['shown'], 'the old view stays while b\'s messages are on their way');
  waits.get('b')(); await b; assert.deepEqual(switched, ['shown', 'b']);
  const c = context.select('c'), d = context.select('d');
  waits.get('d')(); await d; effects.length = 0;
  waits.get('c')(); await c;
  assert.deepEqual(switched, ['shown', 'b', 'd']);
  assert.deepEqual(effects, [], 'c, chosen before d, answered after it: it leaves d\'s view and input alone');
});

test('opening a space waits for its members\' messages; the current space stays meanwhile', async () => {
  const calls = [], spaces = new Set(['s1', 's2']);
  let answer;
  const context = vm.createContext({ spaceId: 's1', state: {}, roomOverview: null, runPreview: null, shareRevision: 0, lastRoomMessages: '', lastMessages: '', roomSession: '',
    spaceRecord: id => spaces.has(id) ? { id } : null, members: id => [{ id: id + '-member' }], uiError: key => Error(key),
    ensureMessages: ids => { calls.push(['ensure', ...ids]); return new Promise(resolve => { answer = resolve; }); },
    captureReadingViews() {}, captureRoomView() {}, closeMentions() {}, suspendColumnInputs() {}, projectSpace: s => s, restoreRoomView() {},
    selectRoom: () => calls.push(['open', context.spaceId]) });
  vm.runInContext(between(renderer, 'async function selectSpace(', '\nfunction renderSpaceNavigation('), context);
  const opening = context.selectSpace('s2'); await tick();
  assert.equal(context.spaceId, 's1'); assert.deepEqual(plain(calls), [['ensure', 's2-member']]);
  answer(); await opening;
  assert.equal(context.spaceId, 's2'); assert.deepEqual(plain(calls.at(-1)), ['open', 's2']);
  // A space removed while its members' messages were on their way is not opened.
  const removed = context.selectSpace('s1'); spaces.delete('s1'); answer();
  await assert.rejects(removed, /spaceUnavailable/); assert.equal(context.spaceId, 's2');
});

test('every render ends by reporting what it shows', () => {
  // render() is the one place that knows what is on screen; reportShown sends only a change (tested above).
  assert.match(between(renderer, '\nfunction render() {', '\nfunction '), /\} finally \{[^\n]*rendering = false; reportShown\(\); \}\n/);
});

test('the open session\'s list is hidden, never drawn as "no messages", should its messages still be missing', () => {
  const list = { hidden: false }, drawn = [];
  // state: the drawn signature also reads which sessions are archived (their names are marked in the messages).
  const context = vm.createContext({ JSON, state: { sessions: [] }, lastMessages: 'before', $: () => list, sessionMessages: s => s.messages, focusedReadingKey: id => id, messageViews: new Map(),
    messageList: (_el, rows) => drawn.push(rows) });
  // render() shows the list again at its start each time (renderer.js: $('messages').hidden = false).
  vm.runInContext('function drawMessages(s) {\n' + between(renderer, '      const visibleMessages = sessionMessages(s);', '\n      renderAdvanced(s);') + '\n}', context);
  context.drawMessages(left('b'));
  assert.equal(list.hidden, true); assert.deepEqual(drawn, []); assert.equal(context.lastMessages, '', 'drawn once they are here');
  context.drawMessages({ id: 'b', name: 'B', messages: ['B1'] });
  assert.deepEqual(plain(drawn), [['B1']]);
});

test('a column whose messages have not arrived yet neither sends nor is drawn empty', async () => {
  let reached = 0;
  const context = vm.createContext({ mode: 'chat', state: { sessions: [left('m'), { id: 'n', messages: [] }] }, soloAction: () => ({ kind: 'send' }), composerCurrent: () => true,
    inputFocusAllowed: () => { reached++; throw Error('reached the send'); } });
  vm.runInContext(between(renderer, 'async function submitSession(', '\n  const { id, nativeId } = s, text') + '\n}', context);
  const binding = id => ({ id, column: true, ui: { send: { disabled: false }, composing: false, input: {} } });
  assert.equal(await context.submitSession(binding('m')), undefined); assert.equal(reached, 0);
  await assert.rejects(context.submitSession(binding('n')), /reached the send/);
  // The space overview's columns: no list for a left-out member, so its column keeps what it shows.
  const drawn = [];
  const page = vm.createContext({ roomOverview: null, state: { room: { id: 'space' }, sessions: [] }, $: () => ({}), ui: {}, sessionMessages: s => s.messages,
    messageList: (_el, rows) => drawn.push(rows), window: { nativeWorkspaceCollaboration: { create: options => options } },
    moveRoomMember() {}, renderColumnInput() {}, removeColumnInput() {}, suspendColumnInputs() {}, focusRoomMember() {}, openMemberMenu() {} });
  vm.runInContext(between(renderer, '  if (!roomOverview) roomOverview = window.nativeWorkspaceCollaboration.create({', '\n  const focused = focusedRoomMember()'), page);
  const options = page.roomOverview, shown = { id: 'n', messages: ['N'] };
  assert.equal(options.messages(left('m')), undefined);
  options.renderMessages({}, left('m'), options.messages(left('m')), 'key');
  options.renderMessages({}, shown, options.messages(shown), 'key');
  assert.deepEqual(plain(drawn), [['N']]);
});

const searchView = fs.readFileSync(require.resolve('../renderer/search-view.js'), 'utf8');
test('a search result in a left-out session opens once its messages are here', async () => {
  const calls = [], record = { id: 'b', name: 'B', messages: [{ id: 'b1', role: 'assistant', text: 'needle' }] };
  const context = vm.createContext({ clearTimeout() {}, searchTimer: 0, searchRevision: 0, searchOrigin: { selected: 'a' }, searchReturn: null, searchNavigating: false,
    state: { sessions: [left('b', { name: 'B' })] }, members: () => [], uiText: key => key, toast: text => calls.push(['toast', text]), renderSearch: () => calls.push('list again'),
    ensureMessages: ids => { calls.push(['ensure', ...ids]); return Promise.resolve().then(() => { context.state.sessions = [record]; }); },
    $: id => id === 'search-dialog' ? { close: () => calls.push('close') } : id === 'search-input' ? { value: 'needle' } : {},
    select: async (...args) => calls.push(['select', ...args]), pointToMessage: (_el, key, id) => calls.push(['point', key, id]), persistView: async () => {} });
  vm.runInContext(between(searchView, 'async function openSearchResult(', '\nasync function showBackgroundConfirmation('), context);
  await context.openSearchResult({ kind: 'message', sessionId: 'b', messageId: 'b1' });
  assert.deepEqual(plain(calls), [['ensure', 'b'], 'close', ['select', 'b', 'chat'], ['point', 'b', 'b1']]);
  // Gone by the time the messages are here: said so, nothing opens.
  calls.length = 0; context.state.sessions = [left('b')]; context.ensureMessages = () => Promise.resolve();
  await context.openSearchResult({ kind: 'message', sessionId: 'b', messageId: 'b1' });
  assert.deepEqual(plain(calls), ['list again', ['toast', 'search.changed']]);
});

test('of two searches on their way, only the newer draws; an opened result is not drawn over', async () => {
  const replies = [], elements = new Map(), errors = [];
  const element = () => ({ hidden: false, open: true, value: 'needle', checked: false, dataset: {}, children: [], cleared: 0, clicked: 0,
    append(...nodes) { this.children.push(...nodes); }, replaceChildren() { this.children = []; this.cleared++; }, querySelectorAll() { return this.children; }, click() { this.clicked++; }, focus() {} });
  const context = vm.createContext({ $: id => elements.get(id) || elements.set(id, element()).get(id), clearTimeout() {}, searchTimer: 0, searchRevision: 0, searchLimit: 60,
    searchOrigin: { selected: 'a' }, spaceId: 'shared', searchOptions: () => ({}), toastError: error => errors.push(error.message), uiText: key => key, sessionShortId: id => id,
    ui: { clearMarkdown() {}, display: { computed() {}, text() {} } }, node: element, button: element, openSearchResult() {},
    api: { search: () => new Promise(resolve => replies.push(resolve)) } });
  vm.runInContext(between(searchView, 'async function renderSearch(', '\nfunction searchResultKey('), context);
  const reply = key => ({ results: [{ key, kind: 'session', sessionId: key }], total: 1 }), list = context.$('search-results');
  const older = context.renderSearch(), newer = context.renderSearch();
  replies[1](reply('newer')); await newer; replies[0](reply('older')); await older;
  assert.deepEqual(list.children.map(row => row.dataset.searchKey), ['newer']); assert.equal(list.cleared, 1);
  // openSearchResult counts as newer.
  const pending = context.renderSearch(); context.searchRevision++;
  replies[2](reply('late')); await pending;
  assert.deepEqual(list.children.map(row => row.dataset.searchKey), ['newer']);
  // Enter opens the first row of the list it asked for, never one left from before.
  const enter = { key: 'Enter', preventDefault() {}, stopPropagation() {} };
  context.api.search = () => Promise.reject(Error('closed'));
  context.searchInputKey(enter); await tick();
  assert.deepEqual(errors, ['closed']); assert.equal(list.children[0].clicked, 0, 'a failed search clicks nothing');
  context.api.search = async () => reply('fresh');
  context.searchInputKey(enter); await tick();
  assert.deepEqual(list.children.map(row => [row.dataset.searchKey, row.clicked]), [['fresh', 1]]);
});

test('every complete state main sends to a page goes through the omission', () => {
  const sends = main.split('\n').filter(line => /webContents\.send\('workspace:state'|'workspace:reconnected'|register\('initial'/.test(line));
  assert.ok(sends.length >= 3);
  for (const line of sends.filter(line => line.includes('send'))) assert.match(line, /omitHidden\(/, line.trim());
  assert.match(between(main, "  register('initial',", "\n  register("), /: omitHidden\(result, c\.shown\)/);
  assert.equal((main.match(/context\.shown = null;/g) || []).length, 2, 'a reload and a renderer crash');
});
