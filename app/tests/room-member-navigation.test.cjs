const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { validViews } = require('../view-store.cjs');
const source = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function actualFunction(name) {
  const start = source.indexOf(`function ${name}(`); assert.ok(start >= 0, name);
  const next = /\n(?:async )?function /g; next.lastIndex = start + 1;
  const end = next.exec(source); assert.ok(end, `function boundary for ${name}`);
  return source.slice(start, end.index);
}
function fixture() {
  const elements = new Map(), events = [], nativeCalls = [], notices = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', children: [], focus: () => events.push(['focus', id]), contains: () => false });
    return elements.get(id);
  };
  element('shared-input').value = 'Unsent room material'; element('recipient').value = 'b';
  element('room-filter').value = 'departed'; element('room-search').value = 'old source';
  const sessions = ['a', 'b'].map(id => ({ id, nativeId: `native-${id}`, roomId: 'shared', liveDraft: `Unsent private ${id}`, queuedInputs: [{ id: `queued-${id}`, text: `Original queued ${id}` }] }));
  const feedPeople = [];
  const context = vm.createContext({getActivityStream:()=>null, getSpaceFeed: () => ({ showPerson: id => feedPeople.push(id) }),
    structuredClone, roomViews: {}, spaceId: 'shared', selected: 'room', roomSurface: 'overview', roomSession: 'a', mode: 'terminal', terminalLayout: 'split',
    roomRecordScope: '', roomRecordReturn: null, roomFilterHistory: null, readingPositions: { 'collaboration-focus:a': { top: 314, follow: false, anchor: 'original', offset: 4 } },
    roomReturnReading: null, roomThread: 'old-thread', roomReplyTo: 'reply-original', pendingRoomFilter: '', selectionRevision: 4,
    roomDraftRevision: 8, roomSubmitting: { id: 'still-in-flight' }, roomMention: null, roomMentionHistory: {}, roomHistories: new Map(), lastRoomMessages: '', lastMessages: '',
    state: { sessions, room: { id: 'shared' } }, document: { getSelection: () => ({ rangeCount: 0, isCollapsed: true }) },
    terminals: new Map([['a', { composing: true, term: { blur: () => events.push(['blur', 'a']) } }]]),
    $: element, focusedRoomMember: () => context.selected === 'room' && context.roomSurface === 'overview' && Boolean(context.roomSession),
    activeSessionId: () => context.selected === 'room' ? context.roomSession : context.selected,
    current: () => context.state.sessions.find(s => s.id === context.roomSession), members: () => context.state.sessions.filter(s => s.roomId === context.spaceId),
    orderedMembers: () => context.members(),
    captureReadingViews: () => events.push(['capture']), suspendColumnInputs: () => events.push(['suspend']),
    activateSoloComposer: id => events.push(['composer', id]), render: () => events.push(['render']), persistView: () => context.captureRoomView(),
    attempt: fn => fn(), normalizeRoomMention() {}, populateSelect() {}, roomRecipient: () => element('recipient').value,
    nativeWorkspaceMentions: { editHistory: () => ({}) }, toastMessage: key => notices.push(key),
    api: new Proxy({}, { get: (_, name) => (...args) => { nativeCalls.push([name, args]); throw Error('Viewing must not call native APIs'); } }),
  });
  context.roomOverview = { key: id => `collaboration:shared:${id}`, focus: id => context.focusRoomMember(id, context.roomSession, `collaboration:shared:${id}`) };
  const fields = source.match(/const roomViewFields = (\[[^;]+\]);/); assert.ok(fields);
  const surfaces = source.match(/const ROOM_SURFACES = (\[[^;]+\]);/); assert.ok(surfaces);
  vm.runInContext(`const roomViewFields = ${fields[1]};\nconst ROOM_SURFACES = ${surfaces[1]};\n` + ['roomRecentPreview', 'roomMemberChoice', 'showRoomSurface', 'focusRoomMember', 'rememberRoomMemberView', 'restoreRoomMemberView', 'openRoomMember', 'timelineParticipants', 'showRoomRecords', 'clearRoomRecordFilter', 'restoreRoomRecordFilter', 'captureRoomView', 'restoreRoomView', 'persistedRoomViews', 'openSidebarRow'].map(actualFunction).join('\n'), context);
  return { context, element, events, nativeCalls, notices, feedPeople };
}

test('member navigation restores its own mode and existing reading without any native input/control call', () => {
  const f = fixture(), c = f.context, before = plain(c.state.sessions);
  c.focusRoomMember('b', 'a', 'collaboration:shared:b'); assert.equal(c.mode, 'chat');
  c.focusRoomMember('a', 'b', 'collaboration:shared:a'); assert.equal(c.mode, 'terminal'); assert.equal(c.terminalLayout, 'split');
  assert.equal(c.readingPositions['collaboration-focus:a'].top, 314); assert.deepEqual(plain(c.state.sessions), before);
  assert.deepEqual(f.nativeCalls, []);
  c.state.sessions[0].nativeId = 'replacement-native'; c.restoreRoomMemberView('a'); assert.equal(c.mode, 'chat', 'a saved display choice does not cross native identity');
});

// R249: a member's 「相关记录」 is the space's 信息流 on that member; the 成员 tab brings the member back as it was.
test('related records open the stream on that member without changing recipient, reply, drafts or queued input', () => {
  const f = fixture(), c = f.context, before = plain(c.state.sessions), revision = c.roomDraftRevision;
  c.showRoomRecords(true); assert.equal(c.roomSurface, 'stream'); assert.equal(c.roomSession, ''); assert.deepEqual(f.feedPeople, ['a']);
  assert.equal(c.roomThread, 'old-thread'); assert.equal(c.roomReplyTo, 'reply-original'); assert.equal(c.roomDraftRevision, revision);
  assert.equal(f.element('recipient').value, 'b'); assert.equal(f.element('shared-input').value, 'Unsent room material');
  assert.deepEqual(plain(c.state.sessions), before); assert.deepEqual(f.nativeCalls, []);
  assert.deepEqual(f.events.filter(e => e[0] === 'blur'), [['blur', 'a']]);
  c.openRoomMember(c.roomMemberChoice().id); assert.equal(c.roomSession, 'a'); assert.equal(c.roomSurface, 'overview'); assert.equal(c.mode, 'terminal');
  assert.equal(c.readingPositions['collaboration-focus:a'].top, 314); assert.equal(c.roomReplyTo, 'reply-original');
});

test('the 成员 tab never reopens a departed member', () => {
  const f = fixture(), c = f.context; c.showRoomSurface('summary'); assert.equal(c.roomMemberChoice().id, 'a');
  c.state.sessions[0].roomId = 'elsewhere'; assert.equal(c.roomMemberChoice().id, 'b');
  c.state.sessions[1].roomId = 'elsewhere'; assert.equal(c.roomMemberChoice(), null); assert.deepEqual(f.nativeCalls, []);
});

test('clear/restore changes only record viewing and never the original reply association or submitting state', () => {
  const f = fixture(), c = f.context, inFlight = c.roomSubmitting;
  c.clearRoomRecordFilter(); assert.equal(f.element('room-filter').value, ''); assert.equal(c.roomThread, '');
  c.restoreRoomRecordFilter(); assert.equal(c.pendingRoomFilter, 'departed'); assert.equal(f.element('room-search').value, 'old source');
  assert.equal(c.roomThread, 'old-thread'); assert.equal(c.roomReplyTo, 'reply-original'); assert.equal(c.roomSubmitting, inFlight);
  assert.equal(c.roomDraftRevision, 8); assert.equal(f.element('recipient').value, 'b'); assert.deepEqual(f.nativeCalls, []);
});

test('existing roomViews persistence round-trips the open view and independent member modes across reload', () => {
  const f = fixture(), c = f.context; c.showRoomRecords(true); const stored = plain(c.persistedRoomViews());
  assert.equal(validViews([{ owner: 'window', roomViews: stored }]), true);
  const restored = fixture(), next = restored.context; next.roomViews = stored; next.roomSession = ''; next.restoreRoomView();
  // R248 (review 1, F7): a space opens on its 总览, also after a restart; the member's own view stays saved.
  assert.equal(next.roomSurface, 'summary'); assert.equal(next.roomSession, ''); assert.equal(next.roomMemberChoice().id, 'a');
  assert.equal(next.roomReplyTo, 'reply-original');
  next.openRoomMember('a'); assert.equal(next.mode, 'terminal'); assert.equal(next.roomSession, 'a'); assert.deepEqual(restored.nativeCalls, []);
  next.spaceId = 'other'; next.roomViews.other = {}; next.restoreRoomMemberView('a'); assert.equal(next.mode, 'chat', 'the other space cannot borrow this space mode');
  // A view saved on the former 对话 or 共享记录 opens the 总览.
  for (const old of ['records', 'conversation']) { next.spaceId = 'shared'; next.roomViews.shared = { roomSurface: old }; assert.equal(validViews([{ owner: 'window', roomViews: { shared: { roomSurface: old } } }]), true); next.restoreRoomView(); assert.equal(next.roomSurface, 'summary'); }
});

test('timeline participant union retains both direct endpoints, deliveries, wake and peer endpoints', () => {
  const c = fixture().context, row = { sessionId: 'a', recipientId: 'b', deliveries: [{ recipientId: 'c' }], wake: { senderId: 'd', recipientId: 'e' }, peerMessage: { senderId: 'f', recipientId: 'g' } };
  assert.deepEqual(plain(c.timelineParticipants(row)), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
});

test('new persisted navigation fields reject malformed or unbounded content before the view store accepts it', () => {
  const good = { roomMemberViews: { a: { mode: 'terminal', terminalLayout: 'split', nativeId: 'native-a' } }, roomRecordScope: 'a', roomRecordReturn: { id: 'a', nativeId: 'native-a' }, roomFilterHistory: { roomFilter: 'a', roomSearch: '', roomThread: '' } };
  assert.equal(validViews([{ owner: 'window', roomViews: { shared: good } }]), true);
  for (const bad of [
    { roomRecordScope: 'a'.repeat(101) }, { roomRecordReturn: { id: 'a', nativeId: [], raw: 'not a view field' } },
    { roomFilterHistory: { roomFilter: '', roomSearch: 'x'.repeat(1001), roomThread: '' } },
    { roomMemberViews: { a: { mode: 'native-input', terminalLayout: 'split', nativeId: 'original' } } },
    { roomMemberViews: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [String(i), { mode: 'chat', terminalLayout: 'hidden', nativeId: '' }])) },
  ]) assert.equal(validViews([{ owner: 'window', roomViews: { shared: { ...good, ...bad } } }]), false);
});

test('restoring a second space opens its 总览, and the old space mode never reaches its member view', () => {
  const f = fixture(), c = f.context;
  c.spaceId = 'other'; c.state.sessions[0].roomId = 'other';
  c.roomViews.other = { roomSession: 'a', roomSurface: 'overview', roomMemberViews: { a: { mode: 'chat', terminalLayout: 'hidden', nativeId: 'native-a' } } };
  c.mode = 'terminal'; c.terminalLayout = 'maximized'; c.restoreRoomView();
  assert.equal(c.roomSurface, 'summary'); assert.equal(c.roomSession, ''); assert.equal(c.mode, 'chat');
  c.captureRoomView(); assert.equal(c.roomViews.other.roomMemberViews.a.mode, 'chat');
  c.openRoomMember('a'); assert.equal(c.mode, 'chat'); assert.equal(c.terminalLayout, 'hidden'); assert.deepEqual(f.nativeCalls, []);
});

// R247 (review 1, F5): outside a space a row opens its session alone, also under a space in 按空间分组; in a space a
// member opens in its 成员 view and any other row opens alone.
test('a left row opens a member of the open space in its 成员 view and any other session alone', () => {
  const f = fixture(), c = f.context, opened = [];
  c.select = id => opened.push(id);
  c.selected = 'b'; c.roomSession = ''; c.openSidebarRow('a'); assert.deepEqual(opened, ['a']); assert.equal(c.roomSession, '');
  c.selected = 'room'; c.roomSurface = 'summary'; c.openSidebarRow('b'); assert.equal(c.roomSession, 'b'); assert.equal(c.roomSurface, 'overview');
  c.state.sessions.push({ id: 'z', nativeId: 'native-z', roomId: 'elsewhere' }); c.openSidebarRow('z'); assert.deepEqual(opened, ['a', 'z']);
  assert.deepEqual(f.nativeCalls, []);
});

test('valid native IDs up to the existing512-character contract do not block member-view or return persistence', () => {
  const nativeId = 'n'.repeat(512);
  const view = { roomMemberViews: { a: { mode: 'chat', terminalLayout: 'hidden', nativeId } }, roomRecordReturn: { id: 'a', nativeId } };
  assert.equal(validViews([{ owner: 'window', roomViews: { shared: view } }]), true);
  for (const field of ['roomMemberViews', 'roomRecordReturn']) {
    const bad = structuredClone(view);
    if (field === 'roomMemberViews') bad.roomMemberViews.a.nativeId += 'x'; else bad.roomRecordReturn.nativeId += 'x';
    assert.equal(validViews([{ owner: 'window', roomViews: { shared: bad } }]), false);
  }
});
