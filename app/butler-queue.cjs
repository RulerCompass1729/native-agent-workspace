'use strict';
// Dormant queue transaction contract. There is deliberately no RoomState,
// background-control, native tool or lifecycle implementation in this module.
// The future trusted host must supply the actual authenticated record and its
// authoritative global space directory, then resolve space ownership locally.
const { createHash } = require('node:crypto');
const { roomId } = require('./collaboration-spaces.cjs');
const { validateEvent } = require('./butler-policy.cjs');
const fail = code => { throw Object.assign(Error(code), { code }); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\s\u0000-\u001f\u007f]/u.test(value);
const fields = (value, keys) => plain(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const fingerprint = action => createHash('sha256').update(JSON.stringify([
  action.actionId, action.sourceRef, action.spaceId, action.text, null,
])).digest('hex');
const knownRefusal = error => /^(?:ERR_BUTLER_|BUTLER_)/u.test(error?.code || '');

class ButlerQueue {
  constructor({ role, ledger, view, adapter = null, authorizeQueue = () => false }) {
    if (!role || !ledger || typeof view !== 'function' || typeof authorizeQueue !== 'function' ||
        adapter !== null && typeof adapter.transact !== 'function') fail('ERR_BUTLER_QUEUE_OPTIONS');
    Object.assign(this, { role, ledger, view, adapter, authorizeQueue });
  }
  context(actualRecord, expected, actionId) {
    if (!id(actionId)) fail('ERR_BUTLER_QUEUE_ACTION');
    const view = this.view();
    if (!view || !Array.isArray(view.records) || !Array.isArray(view.spaces)) fail('ERR_BUTLER_QUEUE_CONTEXT');
    const selected = this.role.authorize(actualRecord, expected, view.records);
    const snapshot = this.ledger.snapshot(), action = snapshot.actions.find(value => value.actionId === actionId);
    const batch = action && snapshot.batches.find(value => value.batchId === action.batchId);
    if (!action || action.kind !== 'queue' || action.effect !== 'none' || Object.hasOwn(action, 'assignee') ||
        typeof action.text !== 'string' || action.text.length > 6000 || !roomId(action.spaceId) ||
        !batch || batch.status !== 'completed' || batch.selection.selectionRevision !== selected.selectionRevision ||
        batch.selection.runnerRef !== selected.runner.runnerRef || !batch.actions.some(value => value.actionId === actionId) ||
        !batch.eventIds.some(eventId => snapshot.events.some(event => event.eventId === eventId &&
          (event.eventId === action.sourceRef || event.sourceRef === action.sourceRef)))) fail('ERR_BUTLER_QUEUE_ACTION');
    validateEvent({ eventId: 'queue-validation', kind: 'request', sourceRef: action.sourceRef, payload: { text: action.text } });
    const targets = view.spaces.filter(space => space?.id === action.spaceId);
    if (targets.length !== 1 || targets[0].archived !== false || targets[0].writable !== true) fail('ERR_BUTLER_QUEUE_SPACE');
    return { selected, action };
  }
  grant(context) {
    // A model cannot choose a mode or supply a grant in its action. Only this
    // host dependency can return a literal boolean, synchronously.
    const value = this.authorizeQueue(Object.freeze({
      selectionRevision: context.selected.selectionRevision, runnerRef: context.selected.runner.runnerRef,
      actionId: context.action.actionId, spaceId: context.action.spaceId,
    }));
    if (value !== true && value !== false) {
      if (value instanceof Promise) value.catch(() => {});
      fail('ERR_BUTLER_QUEUE_GRANT');
    }
    return value;
  }
  async add(actualRecord, expected, actionId) {
    if (!fields(expected, ['selectionRevision', 'runnerRef'])) fail('ERR_BUTLER_UNAUTHORIZED');
    expected = Object.freeze({ selectionRevision: expected.selectionRevision, runnerRef: expected.runnerRef });
    const context = this.context(actualRecord, expected, actionId), action = context.action;
    const operationId = `butler:${actionId}`, digest = fingerprint(action);
    const proposal = { operationId, sourceActionId: actionId, sourceRef: action.sourceRef, spaceId: action.spaceId,
      text: action.text, assignee: null, fingerprint: digest };
    if (!this.grant(context)) return { status: 'recorded', wouldQueue: proposal, effect: 'none' };
    if (!this.adapter) fail('ERR_BUTLER_QUEUE_ADAPTER');
    const name = actualRecord.name || actualRecord.id;
    if (typeof name !== 'string' || name.length > 100 || /[\u0000-\u001f\u007f]/u.test(name)) fail('ERR_BUTLER_QUEUE_ACTOR');
    validateEvent({ eventId: 'queue-actor', kind: 'request', sourceRef: action.sourceRef, payload: { memberName: name } });
    const request = Object.freeze({ ...proposal,
      creator: Object.freeze({ kind: 'butler', name, sessionId: actualRecord.id }),
    });
    let guarded = false, guardFailure = null, open = true, receipt;
    const guard = () => {
      try {
        if (!open) fail('ERR_BUTLER_QUEUE_TRANSACTION');
        const current = this.context(actualRecord, expected, actionId);
        if (fingerprint(current.action) !== digest) fail('ERR_BUTLER_QUEUE_CONFLICT');
        if (!this.grant(current)) fail('ERR_BUTLER_QUEUE_GRANT');
        guarded = true; return true;
      } catch (error) { guardFailure = error; throw error; }
    };
    // Adapter obligation: serialize per-space, invoke guard synchronously inside
    // its transaction immediately before writing OR reading an existing receipt,
    // and atomically retain sourceActionId/fingerprint/itemId alongside the item.
    // Receipt retention must survive removal of finished queue rows. A separate
    // write to this ledger is not an atomic queue commit or proof of delivery.
    try { receipt = await this.adapter.transact(request, guard); }
    catch (error) {
      open = false;
      if (guardFailure) throw guardFailure;
      if (knownRefusal(error)) throw error;
      return { status: 'unconfirmed', operationId, effect: 'unknown' };
    }
    open = false;
    if (guardFailure) throw guardFailure;
    if (!guarded || !fields(receipt, ['operationId', 'fingerprint', 'spaceId', 'itemId', 'duplicate']) ||
        receipt.operationId !== operationId || receipt.fingerprint !== digest || receipt.spaceId !== action.spaceId ||
        !id(receipt.itemId) || typeof receipt.duplicate !== 'boolean') {
      return { status: 'unconfirmed', operationId, effect: 'unknown' };
    }
    // Queued is a transaction receipt, never dispatched, delivered or completed.
    return { status: 'queued', operationId, itemId: receipt.itemId, duplicate: receipt.duplicate, effect: 'queued' };
  }
}
module.exports = { ButlerQueue };
