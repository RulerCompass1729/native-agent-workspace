const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../renderer/coordinator-context.js');

const A = 'shared', B = '11111111-1111-4111-8111-111111111111';
const C = '22222222-2222-4222-8222-222222222222', PRIVATE = '33333333-3333-4333-8333-333333333333';
const now = 10000;
const room = (id, name = id) => ({ id, name, notes: '', revision: 2, metadataRevision: 3 });
const person = (id, roomIds, extra = {}) => ({ id, nativeId: 'native-' + id, name: '同名成员', provider: 'claude', state: 'idle', roomIds, messages: [], ...extra });
const state = (sessions, rooms = [room(A, 'A'), room(B, 'B')]) => ({ sessions, rooms, room: rooms[0] });
const deny = (object, keys) => {
  for (const key of keys) Object.defineProperty(object, key, { enumerable: true, get() { throw Error('Forbidden private field: ' + key); } });
  return object;
};

test('explicit selected spaces deduplicate the same session and retain every selected relationship', () => {
  const input = state([person('S', [A, B]), person('T', [A]), person('U', [B])]);
  const before = JSON.stringify(input), ids = [A, B, A];
  const result = build(input, ids, { now });
  assert.deepEqual(result.spaceIds, [A, B]);
  assert.equal(result.coverage.uniqueSessions, 3); assert.equal(result.coverage.memberships, 4);
  for (const id of ['S', 'T', 'U']) assert.equal(result.text.split(' · ' + id + '\n').length - 1, 1);
  assert.match(result.text, /归属：shared、11111111/);
  assert.equal(JSON.stringify(input), before); assert.deepEqual(ids, [A, B, A]);
  assert.equal(result.coverage.omittedMembers, 0);
});

test('selected-space output never reads private records, unselected metadata or current-space activity fallback', () => {
  const selected = person('S', [B, PRIVATE]);
  deny(selected, ['messages', 'liveDraft', 'cwd', 'nativeSettings', 'terminalFrame', 'sharedActivity']);
  const clock = deny({ nativeId: selected.nativeId, observedAt: 9000 }, ['label', 'text']);
  selected.nativeActivity = clock;
  selected.sharedActivities = deny({}, [A, PRIVATE]);
  const child = deny({ event: 'SubagentStart', id: 'PRIVATE_CHILD', stale: false }, ['name', 'model']);
  selected.fleet = [child];
  const other = deny(person('P', [PRIVATE]), ['name', 'nativeActivity', 'liveDraft']);
  const outside = deny({ id: PRIVATE }, ['name', 'notes', 'metadataRevision', 'merge']);
  const input = state([selected, other], [room(B, 'B'), outside]);
  const result = build(input, [B], { now });
  assert.equal(result.coverage.uniqueSessions, 1); assert.equal(result.coverage.memberships, 1);
  assert.doesNotMatch(result.text, /PRIVATE_CHILD|33333333|Forbidden|nativeSettings/);
  assert.match(result.text, /子任务：1 项进行中（部分观察）/);
  assert.match(result.text, /1970-01-01T00:00:09.000Z/);
});

test('a B-only snapshot never borrows the window A observation clock', () => {
  const record = person('S', [A, B], { state: 'working', sharedActivity: { nativeId: 'native-S', observedAt: 9999 },
    sharedActivities: { [A]: { nativeId: 'native-S', observedAt: 9999 }, [B]: { nativeId: 'native-S', observedAt: 7000 } } });
  const result = build(state([record]), [B], { now });
  assert.match(result.text, /1970-01-01T00:00:07.000Z/);
  assert.doesNotMatch(result.text, /09.999Z/);
  delete record.sharedActivities[B];
  assert.match(build(state([record]), [B], { now }).text, /观察时间：未报告/);
});

test('unknown, foreign-turn, foreign-native and future observations stay unknown instead of using message time', () => {
  const record = person('S', [A], { activeTurnId: 'current', lastActivityAt: now,
    messages: [{ role: 'assistant', id: 'PRIVATE_MESSAGE', text: 'PRIVATE_HISTORY', time: now }] });
  const invalid = [null, { nativeId: 'other', observedAt: 9999 }, { nativeId: 'native-S', turnId: 'old', observedAt: 9999 },
    { nativeId: 'native-S', observedAt: now + 1 }, { nativeId: 'native-S', observedAt: -1e20 }];
  for (const clock of invalid) {
    record.nativeActivity = clock;
    const result = build(state([record]), [A], { now });
    assert.match(result.text, /观察时间：未报告/); assert.match(result.text, /更新时间未报告/);
    assert.doesNotMatch(result.text, /PRIVATE_MESSAGE|PRIVATE_HISTORY/);
  }
});

test('root idle, child lifecycle and incomplete coverage never become a whole-task completion claim', () => {
  const record = person('S', [A], { fleet: [{ event: 'TaskCompleted', id: 'task-only', stale: false }] });
  let result = build(state([record]), [A], { now });
  assert.match(result.text, /会话就绪；子任务：未报告/);
  record.fleet = [{ event: 'SubagentStart', id: 'child', stale: false }];
  result = build(state([record]), [A], { now });
  assert.match(result.text, /会话就绪；子任务：1 项进行中（部分观察）/);
  record.transportDisconnected = true;
  result = build(state([record]), [A], { now });
  assert.match(result.text, /连接状态待核对/); assert.match(result.text, /1 项状态未知/);
});

test('merge provenance uses only stored selected-room references and never invents original cut versions', () => {
  const c = room(C, 'C'); c.notes = 'Current shared C notes';
  const source = deny({ id: A, name: 'Original A', status: 'done' }, ['revision', 'notes', 'events', 'error']);
  c.merge = deny({ sources: [source, { id: B, name: 'Original B', status: 'pending' }] }, ['notes', 'events', 'failures', 'binding']);
  const liveA = deny({ id: A }, ['name', 'notes', 'metadataRevision']);
  const result = build(state([person('S', [C])], [c, liveA]), [C], { now });
  assert.match(result.text, /Original A（shared，done）/); assert.match(result.text, /Original B/);
  assert.match(result.text, /原截点版本未报告/); assert.match(result.text, /Current shared C notes/);
  assert.match(result.text, /合并导入的原空间笔记与记录未附上/);
  assert.equal(result.coverage.spaces, 1);
});

test('empty current notes never imply that stored merged originals are absent', () => {
  const c = room(C, 'C');
  c.merge = deny({ sources: [] }, ['notes', 'events']);
  const result = build(state([], [c]), [C], { now });
  assert.equal(result.coverage.notes, 0);
  assert.equal(result.coverage.importedOriginalsUnknown, true);
  assert.match(result.text, /合并导入的原空间笔记与记录未附上，数量未核对/);
});

test('the generator enforces the actual 12000 UTF16 bound with exact omitted member coverage', () => {
  const sessions = Array.from({ length: 100 }, (_, i) => person('00000000-0000-4000-8000-' + String(i).padStart(12, '0'), [A, B], { name: '名😀'.repeat(20) }));
  const input = state(sessions); input.rooms[0].notes = '😀'.repeat(4000);
  const result = build(input, [A, B], { now });
  assert.ok(result.text.length <= 12000); assert.ok(result.coverage.omittedMembers > 0);
  assert.equal(result.coverage.uniqueSessions, 100); assert.equal(result.coverage.memberships, 200);
  assert.equal(result.coverage.includedMembers + result.coverage.omittedMembers, 100);
  assert.match(result.text, new RegExp('省略：0 份空间资料、' + result.coverage.omittedMembers + ' 份成员事实'));
  assert.equal(result.text.toWellFormed(), result.text);
});

test('original note excerpts keep Unicode intact and explicitly disclose every omitted or shortened note', () => {
  const a = room(A, 'A'); a.notes = '原文😀'.repeat(1000);
  const result = build(state([person('S', [A])], [a]), [A], { now, maxChars: 1024 });
  assert.ok(result.text.length <= 1024); assert.equal(result.text.toWellFormed(), result.text);
  assert.equal(result.coverage.notes, 1);
  assert.equal(result.coverage.includedNotes + result.coverage.omittedNotes, 1);
  assert.equal(result.coverage.truncatedNotes, 1); assert.match(result.text, /本次笔记原文已截断/);
  assert.match(result.text, /原文😀原文😀/);
});

test('missing input, unavailable selections and invalid bounds fail instead of silently widening or reporting zero', () => {
  const input = state([person('S', [A])]);
  for (const ids of [[], [PRIVATE], ['bad-id']]) assert.throws(() => build(input, ids, { now }));
  assert.throws(() => build({ rooms: input.rooms }, [A], { now }), /尚未报告/);
  assert.throws(() => build({ ...input, rooms: [room(A), room(A)] }, [A], { now }), /不可用/);
  for (const maxChars of [0, 1023, 12001, Infinity, 1200.5]) assert.throws(() => build(input, [A], { now, maxChars }));
  for (const time of [NaN, Infinity, 1e20]) assert.throws(() => build(input, [A], { now: time }));
  input.rooms[0].archived = true; assert.throws(() => build(input, [A], { now }), /不可用/);
});

test('duplicate native identity or membership ambiguity fails while identical repeated records count once', () => {
  const s = person('S', [A, B]);
  assert.equal(build(state([s, s]), [A, B], { now }).coverage.uniqueSessions, 1);
  assert.equal(build(state([s, s]), [A, B], { now }).coverage.memberships, 2);
  assert.throws(() => build(state([s, { ...s, nativeId: 'other-native' }]), [A, B], { now }), /身份或归属/);
  assert.throws(() => build(state([s, { ...s, roomIds: [B] }]), [A, B], { now }), /身份或归属/);
  assert.throws(() => build(state([person('S', [A, A])]), [A], { now }));
  for (const delta of [{ name: 'Other' }, { state: 'working' }, { provider: 'codex' },
    { nativeActivity: { nativeId: s.nativeId, observedAt: 9000 } }, { fleet: [{ event: 'SubagentStart', id: 'child', stale: false }] }]) {
    assert.throws(() => build(state([s, { ...s, ...delta }]), [A, B], { now }), /身份或归属/);
  }
});

test('unreadable shared storage cannot become an apparently empty set of notes', () => {
  for (const field of ['roomStorageWarning', 'storageWarning']) {
    const input = state([person('S', [A])]); input[field] = 'Synthetic read failure';
    assert.throws(() => build(input, [A], { now }), /资料.*读取/);
  }
});

test('a missing native identity keeps the original record addressable but marks its observed state uncertain', () => {
  for (const nativeId of [null, '', 42]) {
    const result = build(state([person('S', [A], { nativeId, nativeActivity: { nativeId, observedAt: 9000 } })]), [A], { now });
    assert.match(result.text, / · S\n/); assert.match(result.text, /原生上下文待核对/);
    assert.match(result.text, /观察时间：未报告/);
  }
});

test('a malformed original Unicode string is refused instead of being silently replaced during transport', () => {
  const a = room(A, 'A'); a.notes = 'Original ' + String.fromCharCode(0xd800);
  assert.throws(() => build(state([person('S', [A])], [a]), [A], { now }), /文字.*核对/);
});
