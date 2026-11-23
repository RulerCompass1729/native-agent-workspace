// The steward resuming several sessions in one turn asks once (the person, 2026-11-23). Resume is already
// in the batch methods with no risk mark; this keeps it that way, with one receipt per session.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
test('three resume cards from the steward in one turn are one confirmation, with a receipt for each', async () => {
  require('../renderer/confirmation-batch.js');
  const { plan } = globalThis.nativeWorkspaceConfirmationBatch;
  const { BackgroundControl } = require('../background-control.cjs');
  const actor = { id: 'steward', nativeId: 'steward-native', provider: 'claude', name: 'Steward' };
  const identity = { nativeId: 'steward-native', sessionId: 'steward-session', turnId: 'turn', callId: 'call' };
  const sessions = [{ ...actor, state: 'idle', roomIds: [] }, ...['A', 'B', 'C'].map(id => ({
    id, nativeId: 'native-' + id, name: 'Session ' + id, provider: 'codex', state: 'recoverable', roomIds: [],
  }))];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-resume-all-'));
  const resumed = [];
  const c = { background: true, view: { selected: actor.id, draft: '' }, confirmationActors: () => [actor], checkActor: async () => {},
    client: { snapshot: () => ({ sessions }), close() {} }, win: { destroy() {} },
    fingerprint: command => ({ target: command.arguments[0] }) };
  const control = new BackgroundControl({ dataDir: dir, context: async () => c,
    handlers: new Map([['resume', async (_context, id) => { resumed.push(id); }]]),
    confirmation: () => ({ message: 'Resume?', buttons: ['Cancel', 'Resume'], cancelId: 0 }),
    audit: () => {}, confirmationFingerprint: row => c.fingerprint(row.command) });
  try {
    for (const id of ['A', 'B', 'C']) {
      const asked = await control.call({ sender: actor, identity, valid: () => true }, { action: 'invoke', operation_id: 'resume-' + id, method: 'resume', arguments: [id] });
      assert.equal(asked.state, 'confirmation-required');
    }
    const cards = control.confirmations({ sessions, rooms: [] });
    assert.deepEqual(cards.map(card => card.summary.risks), [[], [], []], 'Resuming carries no risk mark');
    const batches = plan(cards);
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].cards.map(card => card.operationId), ['resume-A', 'resume-B', 'resume-C']);
    for (const card of batches[0].cards) assert.equal((await control.decide(actor.id, actor.nativeId, card.operationId, 1)).state, 'complete');
    assert.deepEqual(resumed, ['A', 'B', 'C']);
    assert.deepEqual(['A', 'B', 'C'].map(id => control.receipt(actor, 'resume-' + id).state), ['complete', 'complete', 'complete']);
  } finally {
    await control.close();
    fs.rmSync(dir, { recursive: true });
  }
});
