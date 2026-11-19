const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const appRoot = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..', '..');
const { MobileWorkspace } = require(path.join(appRoot, 'app/mobile-workspace.cjs'));
const { RoomState } = require(path.join(appRoot, 'app/room-state.cjs'));
function fixture(t, count = 3) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-mobile-selection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessions = Array.from({ length: count }, (_, i) => ({ id: 's' + i, nativeId: 'native-' + i,
    name: 'Synthetic ' + i, provider: i % 2 ? 'codex' : 'claude', state: 'idle', roomIds: ['shared'],
    messages: [{ id: 'u' + i, role: 'user', text: 'Synthetic question ' + i }, { id: 'a' + i, role: 'assistant', text: 'Synthetic answer ' + i }] }));
  const rooms = [{ id: 'shared', name: 'Synthetic shared', messages: [{ id: 'room-message', role: 'human', text: 'Synthetic room body' }], queue: [] }];
  const source = { sessions, rooms, room: rooms[0], backgroundConfirmations: [] };
  const client = { async refresh() {}, route: () => ({ key: '.' }) };
  const adapter = new MobileWorkspace({ snapshot: () => source, roomState: new RoomState(root), now: () => 100,
    records: { status: () => ({ count: 0, records: [] }), acknowledge() {} } });
  const scopes = sessions.map(s => ({ sessionId: s.id, nativeId: s.nativeId, serviceKey: '.', actions: ['read', 'send'] }));
  const grant = { roomIds: ['shared'], records: true };
  return { source, client, adapter, scopes, grant, read: (choice, g = grant, s = scopes) => adapter.read(client, g, s, choice) };
}
const summary = { kind: 'summary' }, session = id => ({ kind: 'session', id }), room = id => ({ kind: 'room', id });
function unloaded(rows) {
  for (const row of rows) {
    assert.equal(row.conversationLoaded, false);
    assert.equal(Object.hasOwn(row, 'messages'), false);
    assert.equal(Object.hasOwn(row, 'earlierMessagesOmitted'), false);
  }
}
test('summary returns summaries without any conversation bodies or omission placeholders', async t => {
  const f = fixture(t), view = await f.read(summary);
  unloaded(view.sessions); unloaded(view.rooms);
  assert.equal(JSON.stringify(view).includes('Synthetic answer'), false);
  assert.equal(JSON.stringify(view).includes('Synthetic room body'), false);
  assert.deepEqual(view.reminders, { count: 0, records: [] });
});
test('summary never reads a native message array', async t => {
  const f = fixture(t);
  Object.defineProperty(f.source.sessions[0], 'messages', { get() { throw Error('summary read a native message array'); } });
  const view = await f.read(summary); unloaded(view.sessions);
});
test('session selection preserves exact canonical conversation and omissions only for its target', async t => {
  const f = fixture(t), full = await f.read(), view = await f.read(session('s1'));
  assert.equal(view.sessions[1].conversationLoaded, true);
  assert.deepEqual(view.sessions[1].messages, full.sessions[1].messages);
  assert.equal(view.sessions[1].earlierMessagesOmitted, full.sessions[1].earlierMessagesOmitted);
  unloaded(view.sessions.filter(s => s.id !== 's1')); unloaded(view.rooms);
  assert.deepEqual(view.confirmations, full.confirmations); assert.deepEqual(view.capabilities, full.capabilities);
});
test('room selection preserves exact canonical room messages and leaves sessions unloaded', async t => {
  const f = fixture(t), full = await f.read(), view = await f.read(room('shared'));
  assert.equal(view.rooms[0].conversationLoaded, true);
  assert.deepEqual(view.rooms[0].messages, full.rooms[0].messages);
  assert.equal(view.rooms[0].earlierMessagesOmitted, full.rooms[0].earlierMessagesOmitted);
  unloaded(view.sessions);
});
test('empty selected room is loaded rather than unavailable', async t => {
  const f = fixture(t); f.source.rooms[0].messages = [];
  const view = await f.read(room('shared'));
  assert.equal(view.rooms[0].conversationLoaded, true); assert.deepEqual(view.rooms[0].messages, []);
});
test('120-session summaries fit 32KiB and selected view fits 70KiB', async t => {
  const f = fixture(t, 120);
  f.source.rooms[0].messages = [];
  for (const s of f.source.sessions) s.messages = Array.from({ length: 9 }, (_, i) => ({ id: s.id + '-' + i, role: 'assistant', text: 'Synthetic ' + 'x'.repeat(6000) }));
  const all = { allRooms: true, records: true }, compact = await f.read(summary, all), chosen = await f.read(session('s0'), all);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < 32 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(chosen)) < 70 * 1024);
});
test('all-mode body budget uses all authorized objects, not one selected object', async t => {
  const f = fixture(t, 120);
  for (const s of f.source.sessions) s.messages = [{ id: s.id + '-body', role: 'assistant', text: '𠮷中文'.repeat(16000) }];
  const all = { allRooms: true, records: true }, full = await f.read(undefined, all), view = await f.read(session('s0'), all);
  assert.equal(view.sessions[0].conversationLoaded, true);
  assert.deepEqual(view.sessions[0].messages, full.sessions[0].messages);
  assert.equal(view.sessions[0].earlierMessagesOmitted, full.sessions[0].earlierMessagesOmitted);
  assert.equal(view.sessions[0].messages[0].text.includes('\ufffd'), false);
  assert.ok(Buffer.byteLength(JSON.stringify(view.sessions[0].messages[0])) <= Math.floor(4 * 1024 * 1024 / 121));
});
test('selected conversation preserves the 200-message ceiling', async t => {
  const f = fixture(t); f.source.sessions[0].messages = Array.from({ length: 220 }, (_, i) => ({ id: 'm' + i, role: 'assistant', text: 'x' }));
  const full = await f.read(), view = await f.read(session('s0'));
  assert.equal(view.sessions[0].conversationLoaded, true);
  assert.deepEqual(view.sessions[0].messages, full.sessions[0].messages);
  assert.equal(view.sessions[0].messages.length, 200); assert.equal(view.sessions[0].earlierMessagesOmitted, 20);
});
test('native context boundary and old native bodies retain canonical filtering', async t => {
  const f = fixture(t), s = f.source.sessions[0];
  s.nativeContexts = [{ boundaryId: 'boundary' }];
  s.messages = [{ id: 'old', role: 'assistant', text: 'OLD_CONTEXT' }, { id: 'boundary', role: 'system', text: '' },
    { id: 'old-native', nativeId: 'old-native', role: 'assistant', text: 'OLD_NATIVE' },
    { id: 'fresh', nativeId: s.nativeId, role: 'assistant', text: 'CURRENT_BODY' }];
  const full = await f.read(), view = await f.read(session(s.id));
  assert.equal(view.sessions[0].conversationLoaded, true); assert.deepEqual(view.sessions[0].messages, full.sessions[0].messages);
  assert.deepEqual(view.sessions[0].messages.map(m => m.id), ['fresh']);
});
test('legacy full projection remains unchanged for callers without a selection', async t => {
  const f = fixture(t), view = await f.read();
  assert.ok(view.sessions.every(s => Array.isArray(s.messages)));
  assert.equal(Object.hasOwn(view.sessions[0], 'conversationLoaded'), false);
});
for (const [label, change, select] of [
  ['ungranted session', f => { f.scopes.splice(1); }, session('s1')],
  ['stale native identity', f => { f.source.sessions[1].nativeId = 'replacement'; }, session('s1')],
  ['archived session', f => { f.source.sessions[1].archived = true; }, session('s1')],
  ['pending native identity', f => { f.source.sessions[1].nativeContextPending = true; }, session('s1')],
  ['wrong service route', f => { f.client.route = () => ({ key: 'other' }); }, session('s1')],
  ['ungranted room', f => { f.grant.roomIds = []; }, room('shared')],
  ['archived room', f => { f.source.rooms[0].archived = true; }, room('shared')],
]) test('selection rejects ' + label + ' instead of falling back to full data', async t => {
  const f = fixture(t); change(f);
  await assert.rejects(f.read(select), e => e.code === 'MOBILE_WORKSPACE_DENIED');
});
for (const choice of [null, {}, { kind: 'all' }, { kind: 'summary', id: 's0' }, { kind: 'session' }, { kind: 'session', id: '' }, { kind: 'session', id: '../s0' }])
  test('malformed selection is rejected: ' + JSON.stringify(choice), async t => {
    const f = fixture(t); await assert.rejects(f.read(choice), e => e.code === 'MOBILE_WORKSPACE_DENIED');
  });
test('read-only grant can still read its selected conversation without gaining send authority', async t => {
  const f = fixture(t); f.scopes[0].actions = ['read'];
  const full = await f.read(), view = await f.read(session('s0'));
  assert.equal(view.sessions[0].conversationLoaded, true); assert.deepEqual(view.sessions[0].messages, full.sessions[0].messages);
  assert.deepEqual(f.scopes[0].actions, ['read']);
});
