const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { RoomState } = require('../room-state.cjs');
const { MobileWorkspace } = require('../mobile-workspace.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-mobile-workspace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const room = new RoomState(root), hidden = room.create('Unshared synthetic space');
  const source = { sessions: [
    { id: 'a', nativeId: 'native-a', name: 'Synthetic A', provider: 'codex', state: 'idle', roomIds: ['shared'], liveDraft: 'PRIVATE_DESKTOP_DRAFT', messages: [
      { id: 'human', role: 'user', text: 'Original human text', time: 1 }, { id: 'reply', role: 'assistant', text: '<script>literal original</script>', time: 2 }] },
    { id: 'b', nativeId: 'native-b', name: 'Synthetic B', state: 'idle', roomIds: [hidden], messages: [{ role: 'assistant', text: 'UNPAIRED_PRIVATE_BODY' }] },
  ], backgroundConfirmations: [] };
  const status = { count: 1, records: [{ record: 'operations', items: [{ kind: 'age', level: 1, shown: true }] }] }, acknowledgements = [];
  const client = { async refresh() {}, route: () => ({ key: '.' }) };
  const snapshot = () => ({ ...source, rooms: [{ id: 'shared', name: 'Shared', messages: [{ role: 'human', text: 'Shared message' }], queue: room.queueItems('shared') },
    { id: hidden, name: 'Unshared', messages: [{ role: 'human', text: 'UNSHARED_SPACE_BODY' }], queue: [] }] });
  const adapter = new MobileWorkspace({ snapshot, roomState: room, now: () => 100,
    records: { status: () => structuredClone(status), acknowledge: (...args) => acknowledgements.push(args) } });
  const scopes = [{ serviceKey: '.', sessionId: 'a', nativeId: 'native-a', actions: ['read', 'send'] }];
  return { adapter, client, room, source, status, acknowledgements, scopes, hidden, grant: { roomIds: ['shared'], records: true }, spec: extra => ({ requestId: randomUUID(), ...extra }) };
}
test('phone confirmation routing preserves opaque desktop operation ids and their full length', t => {
  const f = fixture(t);
  for (const operationId of ['approval.stage:original/card', 'x'.repeat(160)]) {
    f.adapter.confirmation = (sessionId, nativeId, id, decision) => {
      assert.equal(id, operationId); return { sessionId, nativeId, operationId: id, decision, version: 'original', expiresAt: 200 };
    };
    const binding = f.adapter.confirmationBinding(f.client, f.scopes, { id: 'a:' + operationId, version: 'original', decision: 'approve' });
    assert.equal(binding.operationId, operationId); assert.equal(binding.nativeId, 'native-a');
  }
});
test('question home indicator is only a boolean and never copies native approval fields', async t => {
  const f = fixture(t), session = f.source.sessions[0];
  session.approvals = [{ requestId: 'PRIVATE_NATIVE_REQUEST', method: 'item/tool/requestUserInput', nativeOnlyField: 'PRIVATE_NATIVE_FIELD',
    params: { isBlocking: false, questions: [{ id: 'q', header: 'PRIVATE_HEADER', question: 'PRIVATE_QUESTION', isOther: true }] } }];
  const view = await f.adapter.read(f.client, f.grant, f.scopes), row = view.sessions[0];
  assert.equal(row.question, true);
  assert.deepEqual(Object.keys(row).sort(), ['earlierMessagesOmitted', 'id', 'messages', 'name', 'provider', 'question', 'roomIds', 'state']);
  for (const secret of ['PRIVATE_NATIVE_REQUEST', 'PRIVATE_NATIVE_FIELD', 'PRIVATE_HEADER', 'PRIVATE_QUESTION']) assert.equal(JSON.stringify(view).includes(secret), false);
  session.approvals[0].pending = true;
  assert.equal((await f.adapter.read(f.client, f.grant, f.scopes)).sessions[0].question, false);
});
test('phone projection contains only explicit native and room grants and the desktop reminder source', async t => {
  const f = fixture(t), view = await f.adapter.read(f.client, f.grant, f.scopes), raw = JSON.stringify(view);
  assert.equal(view.sessions.length, 1); assert.equal(view.rooms.length, 1);
  assert.equal(view.sessions[0].messages[0].text, 'Original human text'); assert.equal(view.sessions[0].messages[1].text, '<script>literal original</script>'); assert.deepEqual(view.reminders, f.status);
  for (const secret of ['PRIVATE_DESKTOP_DRAFT', 'UNPAIRED_PRIVATE_BODY', 'UNSHARED_SPACE_BODY']) assert.equal(raw.includes(secret), false);
  const readOnly = await f.adapter.read(f.client, { roomIds: [], records: false }, f.scopes); assert.deepEqual(readOnly.rooms, []); assert.equal(readOnly.reminders, null);
  f.source.sessions[0].nativeId = 'successor'; assert.deepEqual((await f.adapter.read(f.client, f.grant, f.scopes)).sessions, []);
});
test('phone queue controls use RoomState and the desktop assignee gate', async t => {
  const f = fixture(t), sent = await f.adapter.action(f.client, f.grant, f.spec({ action: 'queueAdd', roomId: 'shared', text: 'Phone original', assignee: 'a' }), () => {});
  assert.equal(f.room.queueFind('shared', sent.itemId).text, 'Phone original');
  await assert.rejects(f.adapter.action(f.client, f.grant, f.spec({ action: 'queueAdd', roomId: 'shared', text: 'Not a member', assignee: 'b' }), () => {}));
  await assert.rejects(f.adapter.action(f.client, f.grant, f.spec({ action: 'queueAdd', roomId: f.hidden, text: 'No grant', assignee: null }), () => {}));
  await f.adapter.action(f.client, f.grant, f.spec({ action: 'queueCancel', roomId: 'shared', itemId: sent.itemId }), () => {}); assert.equal(f.room.queueFind('shared', sent.itemId).status, 'cancelled');
});
test('revocation while assignee validation waits prevents the later write', async t => {
  const f = fixture(t); let active = true; f.client.refresh = async () => { active = false; };
  await assert.rejects(f.adapter.action(f.client, f.grant, f.spec({ action: 'queueAdd', roomId: 'shared', text: 'Unsent', assignee: 'a' }), () => { if (!active) throw Error('Revoked'); })); assert.equal(f.room.queueItems('shared').length, 0);
});
test('phone reminder acknowledgement cannot hide a future level', async t => {
  const f = fixture(t); await f.adapter.action(f.client, f.grant, f.spec({ action: 'recordAcknowledge', record: 'operations', kind: 'age', level: 1 }), () => {});
  assert.deepEqual(f.acknowledgements, [['operations', 'age', 1]]);
  await assert.rejects(f.adapter.action(f.client, f.grant, f.spec({ action: 'recordAcknowledge', record: 'operations', kind: 'age', level: 999 }), () => {})); assert.equal(f.acknowledgements.length, 1);
});
test('phone cards retain desktop expiry/disposition and grant no sensitive approval', async t => {
  const f = fixture(t); f.source.sessions[0].messages.push({ id: 'card', role: 'system', time: 10, backgroundOperation: { id: 'card-a', nativeId: 'native-a', state: 'not-executed', disposition: 'expired', expiresAt: 120010, confirmation: { options: { message: 'Original action', detail: 'Exact scope' } } } });
  const view = await f.adapter.read(f.client, f.grant, f.scopes); assert.equal(view.confirmations[0].disposition, 'expired'); assert.equal(view.confirmations[0].expiresAt, 120010); assert.equal(view.confirmations[0].canDecide, false);
  await assert.rejects(f.adapter.action(f.client, f.grant, f.spec({ action: 'backgroundDecision', operationId: 'card-a', response: 1 }), () => {}));
});

test('cards with equal operation IDs in different paired sessions remain distinct', async t => {
  const f = fixture(t);
  f.source.sessions[1].messages = [];
  for (const s of f.source.sessions) s.messages.push({ id: 'card-' + s.id, role: 'system', time: 1, backgroundOperation: {
    id: 'same-request', nativeId: s.nativeId, state: 'confirmation-required', expiresAt: 600001,
    confirmation: { options: { message: 'For ' + s.name } },
  } });
  const view = await f.adapter.read(f.client, f.grant, [...f.scopes, { serviceKey: '.', sessionId: 'b', nativeId: 'native-b', actions: ['read'] }]);
  assert.deepEqual(view.confirmations.map(c => c.id), ['a:same-request', 'b:same-request']);
});

test('the desktop card projection supplies two-minute input and ten-minute other deadlines', () => {
  const { BackgroundControl } = require('../background-control.cjs');
  const control = Object.create(BackgroundControl.prototype);
  control.now = () => 1000;
  control.inflight = new Map();
  control.archivedBySession = new Map();
  control.data = { records: ['input', 'observe'].map(method => ({ id: method, actor: { id: 'a', nativeId: 'n', name: 'Synthetic' }, command: { method, arguments: [] }, at: 1000, state: 'confirmation-required' })) };
  const rows = control.rows('a', null);
  assert.deepEqual(rows.map(r => r.backgroundOperation.expiresAt - r.time), [120000, 600000]);
});
