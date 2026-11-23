// The phone groups confirmation cards with the desktop's own batch rule (2026-11-23, 「别忘了 NAW 的手机端」).
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { MobileWorkspace } = require('../mobile-workspace.cjs');
const { RoomState } = require('../room-state.cjs');
const { actor, fixture } = require('./fixtures/confirmation-batch-scene.cjs');

async function phone(t, setup, change = () => {}) {
  const f = await fixture();
  const rooms = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-phone-batch-'));
  t.after(async () => { await f.cleanup(); fs.rmSync(rooms, { recursive: true, force: true }); });
  await setup(f);
  // The scene's own sessions, so each card's target is there to check.
  const sessions = f.c.client.snapshot().sessions.map(s => s.id === actor.id ? { ...s, messages: f.control.rows(actor.id), approvals: [] } : { ...s, messages: [], approvals: [] });
  const state = { sessions, rooms: [] };
  state.backgroundConfirmations = f.control.confirmations(state, state);
  change(state.backgroundConfirmations);
  const mobile = new MobileWorkspace({ snapshot: () => state, roomState: new RoomState(rooms),
    records: { status: () => ({ count: 0, confirmations: state.backgroundConfirmations }), acknowledge: () => {} },
    confirmation: (...args) => f.control.mobileBinding(...args) });
  const client = { refresh: async () => {}, route: () => ({ key: 'synthetic-service' }) };
  const scopes = [{ sessionId: actor.id, nativeId: actor.nativeId, serviceKey: 'synthetic-service', actions: ['read'] }];
  const view = await mobile.read(client, { roomIds: [], records: true }, scopes);
  return Object.fromEntries(view.confirmations.map(card => [card.operationId, card]));
}

test('two archive cards from one sender are one batch on the phone, headed by the action', async t => {
  const cards = await phone(t, async f => { await f.ask('A'); await f.ask('B'); });
  assert.ok(cards.A.version && cards.B.version, 'Both cards carry their decision proof');
  assert.equal(cards.A.batch, cards.A.id);
  assert.equal(cards.B.batch, cards.A.id);
  assert.equal(cards.A.batchTitles.zh, '归档会话');
  assert.equal(cards.A.batchTitles.en, 'Archive session');
});

test('input cards merge with their full text, separately from archive cards', async t => {
  const cards = await phone(t, async f => {
    await f.ask('A'); await f.askInput('in-1', 'B', 'first text'); await f.ask('C'); await f.askInput('in-2', 'C', 'second text');
  });
  assert.equal(cards.A.batch, cards.A.id); assert.equal(cards.C.batch, cards.A.id);
  assert.equal(cards['in-1'].batch, cards['in-1'].id); assert.equal(cards['in-2'].batch, cards['in-1'].id);
  assert.match(cards['in-2'].detail, /second text/, 'Each input row opens to its own complete text');
});

test('an input card without its full text, or a member without current proof, leaves the cards single', async t => {
  const noText = await phone(t, async f => { await f.askInput('in-1', 'A', 'one'); await f.askInput('in-2', 'B', 'two'); },
    list => { delete list[1].message.backgroundOperation.confirmation.options.detail; });
  assert.equal(noText['in-1'].batch, undefined); assert.equal(noText['in-2'].batch, undefined);
  const noProof = await phone(t, async f => { await f.ask('A'); await f.ask('B'); },
    list => { list[1].message.backgroundOperation.confirmation.options.message = 'Changed on the way'; });
  assert.equal(noProof.B.version, undefined, 'The changed card has no decision proof');
  assert.equal(noProof.A.batch, undefined); assert.equal(noProof.B.batch, undefined);
});
