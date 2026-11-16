const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createWorkspaceActions, ACTION_KEY } = require('../mobile-web/workspace.js');
function fixture(options = {}) {
  const disk = options.disk || new Map(), calls = [], session = { deviceId: randomUUID(), csrf: 'not-stored' };
  const storage = { getItem: k => disk.get(k), setItem(k, value) { if (options.failStorage) throw Error('Full'); disk.set(k, value); } };
  const model = createWorkspaceActions({ storage, newId: randomUUID, request: async (route, value) => {
    calls.push({ route, value }); assert.ok(disk.get(ACTION_KEY).includes(value.requestId), 'The original ID was saved before posting');
    if (options.loseResult) throw Error('Unconfirmed'); return { requestId: value.requestId, status: 'complete', itemId: 'task' };
  } });
  return { model, disk, calls, session };
}
test('phone workspace saves the request before posting and stores no CSRF', async () => {
  const f = fixture(), row = await f.model.act(f.session, { action: 'queueAdd', roomId: 'shared', text: 'Original', assignee: null });
  assert.equal(row.status, 'complete'); assert.equal(f.calls.length, 1); assert.equal(f.disk.get(ACTION_KEY).includes('not-stored'), false);
  f.model.forget(f.model.state.pending[0]); assert.equal(f.model.state.pending.length, 0);
});
test('a lost workspace result and reload never resend or discard uncertain work', async () => {
  const f = fixture({ loseResult: true }); await assert.rejects(f.model.act(f.session, { action: 'queueAdd', roomId: 'shared', text: 'Original', assignee: null }));
  const reloaded = fixture({ disk: f.disk }); await assert.rejects(reloaded.model.act(f.session, { action: 'queueAdd' }));
  assert.equal(reloaded.calls.length, 0); assert.throws(() => reloaded.model.forget(reloaded.model.state.pending[0]));
  await reloaded.model.receipt(f.session, reloaded.model.state.pending[0]); assert.equal(reloaded.calls[0].value.action, 'receipt'); assert.equal(reloaded.calls.length, 1);
});
test('an unsaved workspace input never reaches HTTP', async () => {
  const f = fixture({ failStorage: true }); await assert.rejects(f.model.act(f.session, { action: 'queueAdd' })); assert.equal(f.calls.length, 0);
});
