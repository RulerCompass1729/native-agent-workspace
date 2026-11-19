const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createMobileClient, KEY, receiptContext } = require('../mobile-web/client.js');
const { createWorkspaceActions, ACTION_KEY, receiptVisible } = require('../mobile-web/workspace.js');
const deviceId = '10000000-0000-4000-8000-000000000001';
function fixture(disk = new Map()) {
  const calls = [], storage = { getItem: k => disk.get(k), setItem: (k, v) => disk.set(k, v) };
  const session = { deviceId, csrf: 'c'.repeat(43), workspace: true,
    sessions: [{ id: 'member', nativeId: 'native', name: 'LOCAL_ONLY_TARGET', available: true, actions: ['read', 'send', 'answer'] }] };
  const request = async (route, value) => {
    calls.push({ route, value: structuredClone(value) });
    if (route === '/mobile/session') return structuredClone(session);
    if (route.startsWith('/mobile/read/')) return { id: 'member', contextId: 'x'.repeat(43), canSend: true,
      question: { questions: [{ id: 'q', question: 'LOCAL_ONLY_QUESTION' }] }, messages: [] };
    if (route === '/mobile/logout') return { authorizationRevoked: true };
    const row = JSON.parse(disk.get(route === '/mobile/workspace/action' ? ACTION_KEY : KEY)).pending.find(p => p.requestId === value.requestId);
    assert.ok(row.context.at > 0, 'local context was persisted before the request');
    if (route === '/mobile/workspace/action') return { requestId: value.requestId, status: 'complete' };
    return { requestId: value.requestId, sessionId: 'member', action: row.action, status: row.action === 'answer' ? 'reply-written' : 'submitted' };
  };
  return { disk, calls, session, client: createMobileClient({ storage, newId: randomUUID, request }),
    actions: createWorkspaceActions({ storage, newId: randomUUID, request }) };
}
test('native correlation survives reload and target rename, with exact send and receipt payloads', async () => {
  const f = fixture(), c = f.client; await c.start(); await c.select('member'); c.setDraft('ORIGINAL_INPUT'); await c.send();
  const original = structuredClone(c.state.pending[0].context);
  assert.equal(original.target, 'LOCAL_ONLY_TARGET'); assert.equal(original.scope, 'session'); assert.equal(original.nativeId, 'native');
  assert.deepEqual(Object.keys(f.calls.find(c => c.route === '/mobile/send').value).sort(), ['contextId', 'requestId', 'text']);
  assert.equal(JSON.stringify(f.calls).includes('LOCAL_ONLY_TARGET'), false);
  const next = fixture(f.disk); next.session.sessions[0].name = 'RENAMED'; await next.client.start(); await next.client.select('member');
  assert.deepEqual(next.client.state.pending[0].context, original);
  await next.client.receipt(next.client.state.pending[0].requestId);
  assert.deepEqual(next.calls.at(-1).value, { requestId: next.client.state.pending[0].requestId });
});
test('answer correlation retains the original question locally without extending remote fields', async () => {
  const f = fixture(), c = f.client; await c.start(); await c.select('member'); await c.answer({ q: ['Choice'] });
  assert.match(c.state.pending[0].context.text, /LOCAL_ONLY_QUESTION.*\nChoice/);
  const sent = f.calls.find(c => c.route === '/mobile/answer').value;
  assert.deepEqual(Object.keys(sent).sort(), ['answers', 'contextId', 'requestId']); assert.deepEqual(sent.answers, { q: ['Choice'] });
  assert.equal(JSON.stringify(sent).includes('LOCAL_ONLY_'), false);
});
test('all workspace actions separate local snapshots from exact remote fields, including receipt queries', async () => {
  const f = fixture();
  for (const fields of [{ action: 'queueAdd', roomId: 'room', text: 'ORIGINAL_TASK', assignee: null },
    { action: 'queueCancel', roomId: 'room', itemId: 'task' }, { action: 'queueResolve', roomId: 'room', itemId: 'task' },
    { action: 'recordAcknowledge', record: 'operations', kind: 'age', level: 1 }]) {
    await f.actions.act(f.session, fields, { target: 'LOCAL_ONLY_ROOM', text: 'LOCAL_ONLY_ORIGINAL' });
    const row = f.actions.state.pending.at(-1), snapshot = structuredClone(row.context);
    assert.equal(snapshot.target, 'LOCAL_ONLY_ROOM'); assert.equal(snapshot.text, 'LOCAL_ONLY_ORIGINAL');
    assert.deepEqual(f.calls.at(-1).value, { ...fields, requestId: row.requestId });
    await f.actions.receipt(f.session, row); assert.deepEqual(f.calls.at(-1).value, { action: 'receipt', requestId: row.requestId });
    assert.deepEqual(row.context, snapshot);
  }
  assert.equal(JSON.stringify(f.calls).includes('LOCAL_ONLY_'), false);
  assert.deepEqual(fixture(f.disk).actions.state.pending, JSON.parse(JSON.stringify(f.actions.state.pending)));
});
test('old pending formats remain readable and do not invent a historical context', async () => {
  const f = fixture(); await f.client.start(); await f.client.select('member'); f.client.setDraft('Legacy'); await f.client.send();
  await f.actions.act(f.session, { action: 'queueAdd', roomId: 'room', text: 'Legacy', assignee: null });
  for (const key of [KEY, ACTION_KEY]) { const saved = JSON.parse(f.disk.get(key)); delete saved.pending[0].context; f.disk.set(key, JSON.stringify(saved)); }
  const next = fixture(f.disk); assert.equal(next.client.state.storageError, false); assert.equal(next.actions.state.storageError, false);
  assert.equal(next.client.state.pending[0].context, undefined); assert.equal(next.actions.state.pending[0].context, undefined);
});
test('context text is bounded and well formed; new context counts toward the existing workspace quota', async () => {
  const context = receiptContext({ target: 'X'.repeat(199) + '😀', text: 'X'.repeat(15999) + '😀', scope: 'room', targetId: 'room' });
  assert.ok(context.target.length <= 200 && context.target.isWellFormed()); assert.ok(context.text.length <= 16000 && context.text.isWellFormed()); assert.equal(context.clipped, true);
  const f = fixture(); let refused = false;
  for (let i = 0; i < 20; i++) {
    const before = f.calls.length;
    try { await f.actions.act(f.session, { action: 'queueCancel', roomId: 'room', itemId: 'task' }, { target: 'Room', text: 'X'.repeat(16000) }); }
    catch { assert.equal(f.calls.length, before, 'quota failure is before HTTP'); assert.equal(f.actions.state.pending.length, before, 'a request that never reached HTTP is not retained as uncertain'); refused = true; break; }
  }
  assert.equal(refused, true); assert.equal(f.actions.state.storageError, true); assert.ok(f.disk.get(ACTION_KEY).length <= 256 * 1024);
});
test('malformed optional contexts block both clients rather than becoming an HTTP retry', async () => {
  const f = fixture(); await f.client.start(); await f.client.select('member'); f.client.setDraft('Original'); await f.client.send();
  await f.actions.act(f.session, { action: 'queueAdd', roomId: 'room', text: 'Original' });
  for (const value of [null, { target: 'X' }, { ...f.client.state.pending[0].context, at: 'yesterday' }, { ...f.client.state.pending[0].context, target: 'X'.repeat(201) }]) {
    const disk = new Map(f.disk);
    for (const key of [KEY, ACTION_KEY]) { const saved = JSON.parse(disk.get(key)); saved.pending[0].context = value; disk.set(key, JSON.stringify(saved)); }
    const next = fixture(disk); assert.equal(next.client.state.storageError, true); assert.equal(next.actions.state.storageError, true);
    await assert.rejects(next.actions.act(next.session, { action: 'queueAdd' })); assert.equal(next.calls.length, 0);
  }
});
test('correlation is disclosed only under the current device, native identity and read scope', () => {
  const f = fixture(), row = { native: true, deviceId, sessionId: 'member', context: receiptContext({ target: 'Original', scope: 'session', targetId: 'member', nativeId: 'native' }) };
  assert.equal(receiptVisible(row, f.session), true); assert.equal(receiptVisible(row, null), false);
  for (const session of [{ ...f.session, deviceId: randomUUID() }, { ...f.session, candidate: true }, { ...f.session, sessions: [] },
    ...[{ available: false }, { nativeId: 'successor' }, { actions: ['send'] }].map(change => ({ ...f.session, sessions: [{ ...f.session.sessions[0], ...change }] }))]) assert.equal(receiptVisible(row, session), false);
});
test('workspace correlation is masked after room/record scope loss, even with a retained same-device row', () => {
  const f = fixture(), view = { rooms: [{ id: 'room' }], capabilities: { records: true }, reminders: { records: [{ record: 'operations' }] } };
  for (const scope of ['room', 'record']) {
    const row = { deviceId, context: receiptContext({ target: 'Original', scope, targetId: scope === 'room' ? 'room' : 'operations' }) };
    assert.equal(receiptVisible(row, f.session, view), true); assert.equal(receiptVisible(row, f.session, null), false);
    assert.equal(receiptVisible(row, { ...f.session, workspace: false }, view), false);
    assert.equal(receiptVisible(row, f.session, { rooms: [], capabilities: { records: false }, reminders: null }), false);
  }
});
test('removing one settled receipt keeps the other request, current draft and send count', async () => {
  const f = fixture(), c = f.client; await c.start(); await c.select('member');
  for (const original of ['First', 'Second']) { c.setDraft(original); await c.send(); }
  c.setDraft('UNSENT'); const keep = c.state.pending[0].requestId; c.forget(c.state.pending[1].requestId);
  assert.deepEqual(c.state.pending.map(p => p.requestId), [keep]); assert.equal(c.state.draft, 'UNSENT');
  assert.equal(f.calls.filter(c => c.route === '/mobile/send').length, 2);
  c.state.pending[0].status = 'unconfirmed'; assert.throws(() => c.forget(keep));
});
