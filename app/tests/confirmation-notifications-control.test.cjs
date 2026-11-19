const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { EventEmitter } = require('node:events');
const { BackgroundControl } = require('../background-control.cjs');
const { ConfirmationNotifications } = require('../confirmation-notifications.cjs');
const { RoomState } = require('../room-state.cjs'), { SessionLabels } = require('../session-labels.cjs');
const operation = require('../background-operation.cjs'), locale = require('../ui-locale.js');
const flush = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-notification-consent-'));
  let now = Date.now(), writes = 0, audits = 0, controller, notifier;
  const actor = { id: 'agent', nativeId: 'native-agent', name: 'Lead', provider: 'codex' };
  const snapshot = { sessions: [{ ...actor, state: 'idle', roomIds: [] }, { id: 'target', nativeId: 'native-target', provider: 'claude', name: 'Worker', state: 'idle', roomIds: ['shared'] }], rooms: [] };
  const rooms = new RoomState(dir), labels = new SessionLabels(dir); rooms.rename('Lab');
  const client = { snapshot: () => snapshot, call: async method => { assert.equal(method, 'initial'); return snapshot; }, close() {} };
  const context = { background: true, view: { selected: 'agent', draft: '' }, client, win: { destroy() {} }, confirmationActors: () => [actor],
    checkActor: async () => { if (snapshot.sessions.find(s => s.id === actor.id)?.nativeId !== actor.nativeId) throw Error('Actor replaced'); } };
  context.fingerprint = command => operation.controlFingerprint(command, { state: snapshot, actor, context, roomState: rooms, sessionLabels: labels, client });
  const notices = [], reveals = [];
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; notices.push(this); }
    show() {} close() { this.closed = true; this.emit('close'); }
  }
  controller = new BackgroundControl({ dataDir: dir, now: () => now, context: async () => context,
    handlers: new Map([['rename', async (_c, id, name) => { writes++; labels.set(id, name); }]]),
    confirmation: () => ({ message: 'Synthetic rename', detail: 'SYNTHETIC_DETAIL_NOT_FOR_NOTIFICATION', buttons: ['Cancel', 'Confirm'], cancelId: 0 }),
    audit: () => { audits++; }, confirmationPending: row => notifier.notify(row), changed: () => notifier?.sync() });
  notifier = new ConfirmationNotifications({ Notification, control: controller, now: () => now, snapshot: async () => ({ state: labels.apply(rooms.apply(snapshot)), archives: rooms.value.sessionArchives }),
    format: (key, params) => locale.format('en', key, params), reveal: value => reveals.push(value) });
  t.after(async () => { notifier.dispose(); await controller.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const row = await controller.call({ sender: actor, identity: { callId: 'call', turnId: 'turn' }, valid: () => true }, { action: 'invoke', operation_id: 'operation', method: 'rename', arguments: ['target', 'Next'] });
  assert.equal(row.state, 'confirmation-required'); assert.equal(notices[0].options.actions.length, 2);
  return { actor, snapshot, context, controller, notifier, notices, reveals, labels, get writes() { return writes; }, get audits() { return audits; }, advance(ms) { now += ms; }, receipt() { return controller.receipt(actor, 'operation'); } };
}
for (const [index, response, state, writes] of [[0, 1, 'complete', 1], [1, 0, 'cancelled', 0]]) test('real decide and durable receipt: OS action ' + index, async t => {
  const h = await fixture(t); h.notices[0].emit('action', { actionIndex: index }); h.notices[0].emit('action', { actionIndex: index }); await flush();
  assert.equal(h.writes, writes); assert.equal(h.receipt().state, state); assert.equal(h.receipt().humanDecision, response); assert.ok(h.audits > 0);
  if (writes) assert.equal(h.labels.labels.get('target'), 'Next');
});
for (const kind of ['native-id', 'membership', 'target-missing', 'actor-native', 'expired', 'replacement-card', 'lost-binding']) test('real execution boundary refuses ' + kind, async t => {
  const h = await fixture(t);
  if (kind === 'native-id') h.snapshot.sessions[1].nativeId = 'changed';
  if (kind === 'membership') h.snapshot.sessions[1].roomIds = [];
  if (kind === 'target-missing') h.snapshot.sessions.pop();
  if (kind === 'actor-native') h.snapshot.sessions[0].nativeId = 'changed';
  if (kind === 'expired') h.advance(600000);
  if (kind === 'replacement-card') h.controller.commit(data => { data.records[0].confirmation.options.detail = 'A DIFFERENT QUESTION'; });
  if (kind === 'lost-binding') h.notifier.dispose();
  h.notices[0].emit('action', { actionIndex: 0 }); await flush(); assert.equal(h.writes, 0);
});
test('original card and notification compete for the same one decision', async t => {
  const h = await fixture(t); await h.controller.decide(h.actor.id, h.actor.nativeId, 'operation', 1); h.notices[0].emit('action', { actionIndex: 0 }); await flush();
  assert.equal(h.writes, 1); assert.equal(h.notices[0].closed, true);
});
test('clock expiry between action and authorization never reaches handler', async t => {
  const h = await fixture(t); h.context.checkActor = async () => { h.advance(600000); };
  h.notices[0].emit('action', { actionIndex: 0 }); await flush(); assert.equal(h.writes, 0);
});
test('failed OS close is best effort and does not skip real checks or duplicate execution', async t => {
  const h = await fixture(t); h.notices[0].close = () => { throw Error('OS removal unavailable'); };
  h.notices[0].emit('action', { actionIndex: 0 }); await flush(); assert.equal(h.writes, 1); assert.equal(h.receipt().state, 'complete');
});
