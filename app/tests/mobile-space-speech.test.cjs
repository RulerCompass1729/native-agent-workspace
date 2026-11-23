const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const appRoot = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..', '..');
const { MobileWorkspace } = require(path.join(appRoot, 'app/mobile-workspace.cjs'));
const { RoomState } = require(path.join(appRoot, 'app/room-state.cjs'));
// Synthetic space: the person asks A; A answers in its own session; B gets a wake that the space did not record.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-mobile-speech-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessions = [
    { id: 'a', nativeId: 'na', name: 'Synthetic A', provider: 'claude', state: 'idle', roomIds: ['shared'], messages: [
      { id: 'tag-a', role: 'user', origin: 'room', text: 'A, check the build.', time: 10 },
      { id: 'a-tool', role: 'assistant', kind: 'tool', text: 'npm test', time: 11 },
      { id: 'a-think', role: 'assistant', phase: 'commentary', status: 'complete', text: 'Looking.', time: 12 },
      { id: 'a-reply', role: 'assistant', status: 'complete', text: 'Build passes.', time: 13 },
      { id: 'a-timer', role: 'user', origin: 'native', inputSource: 'codex_wakeup', name: 'timer', text: 'wake', time: 14 }] },
    { id: 'b', nativeId: 'nb', name: 'Synthetic B', provider: 'claude', state: 'idle', roomIds: ['shared'], messages: [
      { id: 'b-wake', role: 'user', origin: 'agent-wake', name: 'from A', text: '[Workspace message from Synthetic A · a at x]\nB, private plan.', time: 20, wakeSource: { id: 'w-ab', senderId: 'a' } },
      { id: 'b-reply', role: 'assistant', status: 'complete', text: 'B private reply.', time: 21 }] },
  ];
  const rooms = [{ id: 'shared', name: 'Synthetic shared', queue: [], messages: [
    { id: 'h1', role: 'human', recipientId: 'a', text: 'A, check the build.', time: 10, deliveries: [{ id: 'tag-a', recipientId: 'a', recipientName: 'Synthetic A' }] },
    { id: 'pause', role: 'system', name: 'NAW', text: 'Paused', time: 15 },
    { id: 'w-ba', role: 'system', kind: 'agent-wake', text: 'Delivered.\nA, thanks.', time: 30, wake: { id: 'w-ba', senderId: 'b', recipientId: 'a', senderName: 'Synthetic B', recipientName: 'Synthetic A', body: 'A, thanks.' } }] }];
  const source = { sessions, rooms, room: rooms[0], backgroundConfirmations: [] };
  const client = { async refresh() {}, route: () => ({ key: '.' }) };
  const adapter = new MobileWorkspace({ snapshot: () => source, roomState: new RoomState(root), now: () => 100, records: { status: () => ({ count: 0, records: [] }), acknowledge() {} } });
  const scopes = sessions.map(s => ({ sessionId: s.id, nativeId: s.nativeId, serviceKey: '.', actions: ['read', 'send'] }));
  return { source, scopes, read: (choice, grant = { roomIds: ['shared'], records: true }) => adapter.read(client, grant, scopes, choice) };
}
const line = i => `${i.fromKind}:${i.fromName || ''}>${i.to.map(r => r.name).join(',')}:${i.text}`;
test('a space on the phone lists only what was said, oldest first', async t => {
  const view = await fixture(t).read({ kind: 'room', id: 'shared' });
  assert.deepEqual(view.rooms[0].speech.map(line), [
    'person:>Synthetic A:A, check the build.', 'agent:Synthetic A>:Build passes.', 'agent:Synthetic A>Synthetic B:B, private plan.',
    'agent:Synthetic B>:B private reply.', 'agent:Synthetic B>Synthetic A:A, thanks.']);
  assert.equal(view.rooms[0].earlierSpeechOmitted, 0);
  assert.ok(view.rooms[0].speech.every(i => !Object.hasOwn(i, 'target')));
});
test('a member this phone may not read adds nothing from its own session', async t => {
  const f = fixture(t); f.scopes.splice(1);
  const text = JSON.stringify((await f.read({ kind: 'room', id: 'shared' })).rooms[0].speech);
  assert.equal(text.includes('private'), false);
  assert.ok(text.includes('A, thanks.'));
});
test('the space list and a session view carry no speech', async t => {
  const f = fixture(t);
  for (const choice of [{ kind: 'summary' }, { kind: 'session', id: 'a' }]) assert.equal(Object.hasOwn((await f.read(choice)).rooms[0], 'speech'), false);
});
test('speech keeps the newest 200 within its share of the budget', async t => {
  const f = fixture(t);
  f.source.rooms[0].messages = Array.from({ length: 260 }, (_, i) => ({ id: 'h' + i, role: 'human', recipientId: 'a', text: 'Message ' + i + ' ' + '中'.repeat(i === 259 ? 20000 : 10), time: 100 + i }));
  const selected = (await f.read({ kind: 'room', id: 'shared' })).rooms[0];
  assert.equal(selected.speech.length, 200);
  assert.ok(selected.speech.at(-1).text.startsWith('Message 259') && selected.speech.at(-1).textOmitted);
  assert.ok(selected.earlierSpeechOmitted >= 60);
  const all = (await f.read({ kind: 'room', id: 'shared' }, { allRooms: true, records: true })).rooms[0];
  assert.ok(Buffer.byteLength(JSON.stringify(all.speech)) <= Math.floor(4 * 1024 * 1024 / 3 / 2));
});
// Review round 1, finding 5: only the space page shows speech, so a read of every space at once adds none.
test('a read of every space at once carries no speech', async t => {
  const f = fixture(t);
  for (const grant of [undefined, { allRooms: true, records: true }]) {
    const view = await f.read(undefined, grant);
    assert.ok(view.rooms[0].messages.length > 0);
    assert.equal(Object.hasOwn(view.rooms[0], 'speech'), false);
  }
});
