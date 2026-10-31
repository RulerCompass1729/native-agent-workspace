const test = require('node:test');
const assert = require('node:assert/strict');
const { project, pruneReading, create } = require('../renderer/collaboration-panorama.js');
const { validViews } = require('../view-store.cjs');

const B = '11111111-1111-4111-8111-111111111111';
const UNKNOWN = '22222222-2222-4222-8222-222222222222';
const rooms = [{ id: 'shared', name: 'A' }, { id: B, name: 'B' }];
const session = (id, roomIds = [], extra = {}) => ({ id, nativeId: `native-${id}`, name: '同名成员', state: 'idle', roomIds, messages: [], ...extra });

test('one primary projection reaches B-only U and counts shared S only once', () => {
  const sessions = [session('S', ['shared', B]), session('T', ['shared']), session('U', [B]), session('V')];
  const before = JSON.stringify({ rooms, sessions });
  const result = project({ rooms, sessions });
  assert.deepEqual(result.people.map(p => p.record.id), ['S', 'T', 'U', 'V']);
  assert.equal(result.total, 4); assert.equal(result.memberships, 4);
  assert.deepEqual(result.people[0].spaces.map(s => s.id), ['shared', B]);
  assert.equal(result.people[3].spaces.length, 0);
  assert.equal(JSON.stringify({ rooms, sessions }), before, 'observation changes no input, identity or membership');
});

test('filtering retains the full denominator and every original membership', () => {
  const state = { rooms, sessions: [session('S', ['shared', B]), session('T', ['shared']), session('U', [B])] };
  const a = project(state, { spaceId: 'shared' });
  assert.deepEqual(a.people.map(p => p.record.id), ['S', 'T']);
  assert.equal(a.total, 3); assert.equal(a.memberships, 4);
  assert.deepEqual(a.people[0].spaces.map(s => s.id), ['shared', B]);
  assert.deepEqual(project(state, { spaceId: 'missing' }).people, [], 'missing scope never silently broadens');
  assert.deepEqual(project(state, { query: 'native-U' }).people.map(p => p.record.id), ['U']);
});

test('stream updates and repeated names cannot reorder or replace selected identities', () => {
  const first = project({ rooms, sessions: [session('S'), session('T'), session('U')] });
  const second = project({ rooms, sessions: [session('U', [], { state: 'working' }), session('S'), session('T'), session('N')] }, { order: first.order });
  assert.deepEqual(second.people.map(p => p.record.id), ['S', 'T', 'U', 'N']);
  assert.equal(second.people[2].record.nativeId, 'native-U');
  assert.equal(second.people[2].record.state, 'working');
  assert.deepEqual(project({ rooms, sessions: [session('__proto__'), session('constructor')] }).order, ['__proto__', 'constructor']);
});

test('100 synthetic logical sessions have 118 relationships, not 118 agents', () => {
  const sessions = Array.from({ length: 100 }, (_, i) => session(`s${i}`, i < 18 ? ['shared', B] : [i % 2 ? 'shared' : B]));
  const result = project({ rooms, sessions });
  assert.equal(result.total, 100); assert.equal(result.people.length, 100); assert.equal(result.memberships, 118);
  assert.equal(new Set(result.people.map(p => p.record.nativeId)).size, 100);
  assert.deepEqual(result.people.flatMap(p => p.spaces.map(s => s.id)).sort(), sessions.flatMap(s => s.roomIds).sort());
});

test('archived participants are excluded while unknown space references are retained', () => {
  const result = project({ rooms, sessions: [session('S', [UNKNOWN]), session('T', ['shared'], { archived: true })] });
  assert.equal(result.total, 1); assert.equal(result.memberships, 1);
  assert.deepEqual(result.people[0].spaces, [{ id: UNKNOWN, name: UNKNOWN, unavailable: true, archived: false }]);
});

test('status projection keeps disconnected observations, missing clocks and fleet limits explicit', () => {
  const records = [session('S', ['shared'], { transportDisconnected: true }), session('T', [B], { state: 'unknown' }), session('U', [B])];
  const result = project({ rooms, sessions: records }, {}, true, 10000);
  assert.equal(result.people[0].facts.stale, true);
  assert.equal(result.people[0].facts.state, '连接状态待核对');
  assert.equal(result.people[1].facts.state, '状态未报告');
  assert.equal(result.people[2].facts.child, '子任务：未报告');
  assert.equal(result.people[2].facts.freshness, '更新时间未报告');
});

test('panorama uses valid observations from B while the current projection is A', () => {
  const record = session('S', ['shared', B], { state: 'working', activeTurnId: 'current',
    sharedActivity: null, sharedActivities: { [B]: { nativeId: 'native-S', turnId: 'current', observedAt: 9998 } } });
  const before = JSON.stringify(record);
  const observed = project({ rooms, sessions: [record] }, {}, true, 10000);
  assert.equal(observed.people[0].facts.freshness, '刚更新');
  assert.equal(observed.stats.unreportedTime, 0);
  assert.equal(JSON.stringify(record), before);
  for (const observation of [{ nativeId: 'another-native', observedAt: 9999 },
    { nativeId: 'native-S', turnId: 'old-turn', observedAt: 9999 },
    { nativeId: 'native-S', turnId: 'current', observedAt: 10001 }]) {
    const result = project({ rooms, sessions: [{ ...record, sharedActivities: { [B]: observation } }] }, {}, true, 10000);
    assert.equal(result.stats.unreportedTime, 1);
    assert.equal(result.people[0].facts.freshness, '更新时间未报告');
  }
});

test('global status counts use unique sessions and keep unknown clocks separate from connection state', () => {
  const records = [session('S', ['shared', B], { state: 'approval' }),
    session('T', ['shared'], { transportDisconnected: true }),
    session('U', [B], { state: 'not-reported' })];
  const result = project({ rooms, sessions: records }, { spaceId: B });
  assert.equal(result.total, 3); assert.equal(result.people.length, 2);
  assert.deepEqual(result.stats, { waiting: 1, disconnected: 1, unknownState: 1, unreportedTime: 3, stale: 1 });
});

test('an active return anchor survives more than 128 historical reading keys', () => {
  const position = { top: 15, follow: false, anchor: 'original-message', offset: -3 };
  const positions = Object.fromEntries([['origin', position], ...Array.from({ length: 130 }, (_, i) => [`old-${i}`, { ...position, anchor: `message-${i}` }])]);
  const bounded = pruneReading(positions, ['origin']);
  assert.equal(Object.keys(bounded).length, 128);
  assert.equal(bounded.origin, position); assert.equal(bounded['old-129'].anchor, 'message-129');
  assert.equal(bounded['old-0'], undefined); assert.equal(Object.keys(positions).length, 131);
  assert.equal(Object.hasOwn(bounded.origin, 'text'), false);
});

test('saved panorama metadata is bounded presentation data, never selected private text', () => {
  const panorama = { layout: 'list', query: 'same member', spaceId: B, top: 123.5, returning: true, focusId: 'S' };
  const view = { owner: 'synthetic-window', selected: 'panorama', panorama };
  assert.equal(validViews([view]), true);
  for (const delta of [{ query: 'x'.repeat(1001) }, { top: NaN }, { top: -1 }, { top: 1e10 },
    { spaceId: 'not-a-space-id' }, { layout: 'terminal' }, { returning: 'yes' }, { focusId: 'x'.repeat(101) },
    { text: 'private selected text' }, { recipient: 'someone else' }]) {
    assert.equal(validViews([{ ...view, panorama: { ...panorama, ...delta } }]), false);
  }
  assert.equal(validViews([{ owner: 'old-window', selected: 'room' }]), true, 'older view records remain valid');
});

test('an earlier pointer release cannot erase a newer source-reading snapshot', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const listeners = new Map();
  const doc = { activeElement: null, createElement: () => ({ dataset: {}, scrollTop: 0, classList: { add() {} }, append() {},
    addEventListener() {}, setAttribute() {} }), addEventListener: (name, fn) => listeners.set(name, fn) };
  const host = { ownerDocument: doc, classList: { add() {} }, append() {} };
  const api = create({ host });
  const article = { dataset: { panoramaSession: 'S' } };
  const quote = { dataset: { messageId: 'original' }, closest: () => article, contains: () => true };
  const text = { parentElement: { closest: () => quote } };
  const range = { startContainer: text, endContainer: text };
  api.reader.contains = node => node === quote;
  let selected = false;
  doc.getSelection = () => selected ? { isCollapsed: false, anchorNode: text, focusNode: text, getRangeAt: () => ({ cloneRange: () => range }) } : null;
  doc.activeElement = { dataset: { panoramaFocus: 'S' }, closest(selector) { return selector === '[data-panorama-session]' ? article : this; } };

  api.captureOrigin(true); listeners.get('pointerup')(); t.mock.timers.tick(1);
  assert.equal(api.captureOrigin().pointerCaptured, false, 'an unconsumed released pointer is discarded');

  api.captureOrigin(true); listeners.get('pointerup')();
  selected = true;
  const newer = api.captureOrigin(true);
  selected = false; // The browser button default can collapse the live selection.
  t.mock.timers.tick(1);
  assert.equal(api.captureOrigin(), newer, 'an older release owns only its original pending snapshot');
  assert.equal(newer.range, range, 'the newer original reading range survives until navigation consumes it');

  api.captureOrigin(true); listeners.get('pointercancel')();
  assert.equal(api.captureOrigin().pointerCaptured, false, 'cancelled pointers are still discarded');
});
