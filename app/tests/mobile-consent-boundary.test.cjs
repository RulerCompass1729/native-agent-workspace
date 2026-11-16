const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { BackgroundControl, dialog } = require('../background-control.cjs');
test('phone authorization revoked while the original actor refresh awaits cannot reach the existing handler', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-mobile-consent-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let valid = true, calls = 0, release;
  const waiting = new Promise(resolve => { release = resolve; });
  const actor = { id: 'agent', nativeId: 'native', provider: 'codex', name: 'Synthetic agent', turnId: 'turn', callId: 'call', operationId: 'card' };
  const options = { message: 'Synthetic approval', buttons: ['Cancel', 'Approve'], cancelId: 0 };
  const context = { background: true, view: {}, checkActor: async () => { await waiting; }, client: { close() {} }, win: { destroy() {} } };
  const controller = new BackgroundControl({ dataDir: root, handlers: new Map([['synthetic', async c => { await dialog(c, 'message', options); calls++; return true; }]]), context: async () => context });
  t.after(() => controller.close());
  controller.commit(d => d.records.push({ id: 'card', actor, command: { action: 'invoke', operation_id: 'card', method: 'synthetic', arguments: [] }, state: 'confirmation-required', at: Date.now(), confirmation: { kind: 'message', options } }));
  const promise = controller.decide(actor.id, actor.nativeId, 'card', 1, () => { if (!valid) throw Error('Mobile proof revoked'); });
  await new Promise(resolve => setImmediate(resolve)); valid = false; release();
  await promise.catch(() => {}); assert.equal(calls, 0, 'Revocation must be checked after the actor refresh, before executing');
});
