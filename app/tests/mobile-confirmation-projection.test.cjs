const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { BackgroundControl } = require('../background-control.cjs');
const { MobileWorkspace } = require('../mobile-workspace.cjs');
const { RoomState } = require('../room-state.cjs');
const operation = require('../background-operation.cjs');

function fixture(t, lang, unified = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-phone-projection-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const actor = { id: 'synthetic-session', nativeId: 'synthetic-native', provider: 'codex', name: 'Synthetic member' };
  const record = { ...actor, state: 'idle', messages: [], approvals: [], roomIds: ['shared'] };
  const snapshot = { sessions: [record], rooms: [{ id: 'shared', name: 'Shared', messages: [], queue: [] }] };
  const roomState = new RoomState(dir);
  const command = { action: 'invoke', operation_id: 'approval.stage:fixture', method: 'synthetic', arguments: ['approval.stage:fixture'] };
  const options = { message: lang === 'zh' ? '允许读取项目文档？' : 'Allow access to project docs?', detail: 'demo-project/docs/ · Read only', buttons: ['Cancel', 'Approve'], cancelId: 0 };
  const fingerprint = (value, state = snapshot) => operation.controlFingerprint(value, { state, actor, context: { view: {} }, roomState });
  const background = new BackgroundControl({ dataDir: dir, handlers: new Map(),
    confirmationFingerprint: (row, state) => fingerprint(row.command, state),
    context: async () => assert.fail('Reading must not execute or open a view') });
  t.after(() => background.close());
  background.commit(d => d.records.push({ id: command.operation_id, actor, command, guard: fingerprint(command), state: 'confirmation-required', at: Date.now(), confirmation: { kind: 'message', options } }));
  const state = { ...snapshot, sessions: [{ ...record, messages: background.rows(actor.id) }] };
  if (unified) state.backgroundConfirmations = background.confirmations(state, state);
  const mobile = new MobileWorkspace({ snapshot: () => state, roomState,
    records: { status: () => ({ count: 1, confirmations: state.backgroundConfirmations }), acknowledge: () => {} },
    confirmation: (...args) => background.mobileBinding(...args) });
  const client = { refresh: async () => {}, route: () => ({ key: 'synthetic-service' }) };
  const scopes = [{ sessionId: actor.id, nativeId: actor.nativeId, serviceKey: 'synthetic-service', actions: ['read'] }];
  const read = () => mobile.read(client, { roomIds: [], records: true }, scopes);
  return { actor, options, command, background, mobile, state, scopes, client, read };
}

for (const lang of ['zh', 'en']) for (const unified of [true, false]) {
  test(lang + ' real ' + (unified ? 'unified inbox' : 'legacy projection') + ' retains exact decision details and proof', async t => {
    const f = fixture(t, lang, unified), before = structuredClone(f.state.backgroundConfirmations);
    if (unified) assert.equal(Object.hasOwn(before[0], 'detail'), false, 'Exercise the actual desktop contract');
    const view = await f.read();
    assert.equal(view.confirmations.length, 1);
    const card = view.confirmations[0], binding = f.background.mobileBinding(f.actor.id, f.actor.nativeId, f.command.operation_id, 1);
    assert.equal(card.id, [f.actor.id, f.actor.nativeId, f.command.operation_id].join(':'));
    assert.equal(card.version, binding.version, 'Complete real confirmation retains its presentation-bound version');
    assert.equal(card.title, f.options.message); assert.equal(card.detail, f.options.detail);
    assert.equal(card.canDecide, false, 'Reading alone never enables approval');
    const decisionId = unified ? card.id : f.actor.id + ':' + f.command.operation_id;
    assert.equal(f.mobile.confirmationBinding(f.client, f.scopes, { id: decisionId, version: card.version, decision: 'approve' }).version, binding.version);
    assert.equal(JSON.stringify(view.reminders).includes(f.options.message), false);
    assert.equal(JSON.stringify(view.reminders).includes(f.options.detail), false);
    assert.deepEqual(f.state.backgroundConfirmations, before, 'The desktop/bell source is not mutated');
  });
}

test('unified private decision content is not read before session/native/service grants pass', async t => {
  for (const gate of ['scope', 'native', 'service', 'archived', 'pending']) {
    const f = fixture(t, 'en'); let bindings = 0;
    f.mobile.confirmation = () => { bindings++; assert.fail('Unpermitted card cannot request decision proof'); };
    Object.defineProperty(f.state.backgroundConfirmations[0], 'message', { get: () => assert.fail('Unpermitted private content read') });
    if (gate === 'scope') f.scopes.length = 0;
    if (gate === 'native') f.scopes[0].nativeId = 'old-native';
    if (gate === 'service') f.scopes[0].serviceKey = 'other-service';
    if (gate === 'archived') f.state.sessions[0].archived = true;
    if (gate === 'pending') f.state.sessions[0].nativeContextPending = true;
    const view = await f.read();
    assert.deepEqual(view.confirmations, []); assert.equal(bindings, 0);
  }
});

test('nested content from another native session or operation cannot gain a decision version', async t => {
  for (const field of ['nativeId', 'id']) {
    const f = fixture(t, 'en');
    f.state.backgroundConfirmations[0].message.backgroundOperation[field] = 'different-origin';
    const card = (await f.read()).confirmations[0];
    assert.equal(card.version, undefined); assert.equal(card.canDecide, false);
    assert.notEqual(card.detail, f.options.detail);
  }
});

test('changed or oversized nested presentation remains disabled without leaking unverified contents', async t => {
  for (const field of ['changed', 'oversized']) {
    const f = fixture(t, 'en'), raw = f.state.backgroundConfirmations[0].message.backgroundOperation.confirmation.options;
    raw.detail = field === 'changed' ? 'UNVERIFIED_SYNTHETIC_DETAIL' : 'x'.repeat(16001);
    const view = await f.read(), card = view.confirmations[0];
    assert.equal(card.version, undefined); assert.equal(card.canDecide, false);
    assert.equal(JSON.stringify(view).includes(raw.detail), false);
  }
});
