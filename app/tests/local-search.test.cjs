const test = require('node:test'), assert = require('node:assert/strict');
const { searchRecords } = require('../renderer/local-search.js');
const state = {
  sessions: [
    { id: 'a', name: '计划', provider: 'claude', liveDraft: 'SECRET-DRAFT', messages: [{ id: 'a1', role: 'user', text: '明日计划：先看代码，再散步。' }, { id: 'a2', role: 'assistant', text: 'CaseSensitive <script> *.js' }] },
    { id: 'b', name: '计划', provider: 'codex', archived: true, messages: [{ id: 'b1', role: 'assistant', text: '先看代码' }] },
  ],
  room: { name: '共享计划', messages: [{ id: 's1', role: 'human', text: '共享给伙伴的代码' }], events: [{ id: 'e1', role: 'system', text: '伙伴加入' }], notes: 'PRIVATE-NOTE' },
};
test('local reading search keeps private, shared and archived scope explicit', () => {
  assert.deepEqual(searchRecords(state, '代码', { scope: 'current', sessionId: 'a' }).results.map(r => r.key), ['message:a:a1']);
  assert.deepEqual(searchRecords(state, '代码', { scope: 'room' }).results.map(r => r.key), ['shared:s1']);
  assert.equal(searchRecords(state, '代码').total, 2);
  assert.equal(searchRecords(state, '代码', { archived: true }).total, 3);
  assert.equal(searchRecords(state, '代码', { scope: 'current', sessionId: 'missing' }).total, 0);
  assert.equal(searchRecords(state, '代码', { scope: 'current', sessionId: 'b' }).total, 1);
});
test('search does not inspect drafts or notes, interprets text literally and retains stable duplicate-name identities', () => {
  const before = JSON.stringify(state);
  assert.equal(searchRecords(state, 'SECRET-DRAFT').total, 0);
  assert.equal(searchRecords(state, 'PRIVATE-NOTE').total, 0);
  assert.equal(searchRecords(state, 'casesensitive').total, 1);
  assert.equal(searchRecords(state, '*.js').total, 1);
  assert.equal(searchRecords(state, '[.*').total, 0);
  assert.deepEqual(searchRecords(state, '', { archived: true }).results.map(r => r.key), ['session:a', 'session:b', 'room']);
  assert.equal(JSON.stringify(state), before);
});
test('large results expose total and bounded snippets without truncating source records', () => {
  const data = { sessions: [{ id: 'a', name: 'Long', messages: Array.from({ length: 750 }, (_, i) => ({ id: String(i), text: 'x'.repeat(500) + 'needle' + '尾'.repeat(500) })) }] };
  const first = searchRecords(data, 'needle');
  assert.equal(first.total, 750); assert.equal(first.results.length, 60);
  assert.ok(first.results.every(r => r.text.includes('needle') && r.text.length <= 222));
  assert.equal(searchRecords(data, 'needle', { limit: 1000 }).results.length, 600);
  assert.equal(data.sessions[0].messages[0].text.length, 1006);
});

test('the untouched default space is found by its stored and shown names in both languages; renamed spaces by their own (T-60)', () => {
  const B = '11111111-1111-4111-8111-111111111111';
  const state = { sessions: [], rooms: [{ id: 'shared', name: '共同工作', messages: [] }, { id: B, name: 'Team', messages: [] }] };
  for (const query of ['Shared', 'shared work', '共同']) {
    const rooms = searchRecords(state, query).results.filter(r => r.kind === 'room');
    assert.deepEqual(rooms.map(r => [r.roomId, r.nameKey]), [['shared', 'space.defaultName']], query);
  }
  const renamed = { sessions: [], rooms: [{ id: 'shared', name: 'Lab', messages: [] }, { id: B, name: '共同工作', messages: [] }] };
  assert.deepEqual(searchRecords(renamed, 'Shared').results, [], 'a renamed default space and another space keep their stored names only');
  assert.deepEqual(searchRecords(renamed, '共同').results.map(r => [r.roomId, r.nameKey]), [[B, undefined]]);
  const unnamed = { sessions: [], rooms: [{ id: 'shared', name: '', messages: [] }] };
  for (const query of ['Shared', '共同']) assert.deepEqual(searchRecords(unnamed, query).results.map(r => [r.roomId, r.nameKey]), [['shared', 'search.sharedFallback']], 'a space shown under the fallback name is found by it: ' + query);
});
