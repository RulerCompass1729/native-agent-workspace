'use strict';
const { createHash, randomUUID } = require('node:crypto');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value) ? value : undefined;
const ref = value => typeof value === 'string' && value.length > 0 ? hash(value) : null;
const OUTCOMES = new Set(['complete', 'cancelled', 'running', 'failed', 'not-executed', 'unknown']);
const eventKey = (surface, action, identity) => `person-action:${hash([surface, action, identity])}`;
const card = row => [ref(row.id), ref(row.actor.id), ref(row.actor.nativeId)];
const answer = row => [...card(row), row.humanDecision, row.humanDecisionAt ?? row.finishedAt];
// Whether `event` records the person's answer on the card of operation record `row`. Its id is of the whole answer, the
// native session that asked included; its itemId leaves out an operation id that is not plain.
const answers = (row, { eventId, payload }) => id(row.id) === payload.itemId && ['confirm', 'reject']
  .some(action => payload.reason === `person-action:confirmation:${action}` && eventId === eventKey('confirmation', action, answer(row)));
const METHODS = new Set(['operatorAction', 'spaceAction', 'approve', 'answer']);

class PersonActions {
  constructor({ ingress, now = Date.now }) {
    this.ingress = ingress; this.now = now; this.pending = new Map(); this.seen = new Set(); this.overflow = false;
  }
  event(surface, action, identity, outcome = action, metadata = {}) {
    const key = eventKey(surface, action, identity);
    if (this.seen.has(key) || this.pending.has(key)) return;
    if (this.pending.size >= 512) {
      this.overflow = true; this.ingress.errors.set('person-actions', 'source-unavailable');
      return;
    }
    this.pending.set(key, { eventId: key, sourceRef: key, kind: 'request',
      payload: { reason: `person-action:${surface}:${action}`, outcome, ...metadata } });
  }
  flush() {
    for (const [key, event] of this.pending) {
      try { this.ingress.record(event); }
      catch { this.ingress.errors.set('person-actions', 'source-unavailable'); return; }
      this.pending.delete(key); this.seen.add(key);
      if (this.seen.size > 8192) this.seen.delete(this.seen.values().next().value);
    }
    if (!this.overflow) this.ingress.errors.delete('person-actions');
  }
  call(name, args, result) {
    if (!METHODS.has(name) || result === false || result?.cancelled === true) return;
    if (name === 'operatorAction') {
      const action = args[1];
      if (action === 'grant' && ref(result)) this.event('operator', 'grant', ref(result), 'grant', { ...(id(result) ? { itemId: id(result) } : {}) });
      else if (['authorize', 'dismiss', 'revoke', 'close'].includes(action))
        this.event('operator', action, randomUUID(), action, { ...(id(args[0]) ? { memberId: id(args[0]) } : {}),
          ...(id(args[2]?.key) ? { itemId: id(args[2].key) } : {}) });
    } else if (name === 'spaceAction') {
      const metadata = { ...(id(args[0]) ? { spaceId: id(args[0]) } : {}), ...(id(args[2]?.[0]) ? { itemId: id(args[2][0]) } : {}) };
      if (args[1] === 'queueResolve') this.event('queue', args[2]?.length > 1 ? 'answer' : 'resolve', randomUUID(), 'resolved', metadata);
      if (args[1] === 'queueCancel') this.event('queue', 'cancel', randomUUID(), 'cancelled', metadata);
    } else this.event('native', name === 'answer' ? 'answer' : args[2] === 'accept' ? 'confirm' : 'reject', randomUUID(), 'responded', {
      ...(id(args[0]) ? { memberId: id(args[0]) } : {}), ...(id(args[1]) ? { itemId: id(args[1]) } : {}) });
    this.flush();
  }
  observe(snapshot, records = []) {
    for (const domain of snapshot?.operatorPolicy?.domains || []) {
      if (domain.source !== 'human' || !ref(domain.id)) continue;
      this.event('operator', 'grant', ref(domain.id), 'grant', { ...(id(domain.id) ? { itemId: id(domain.id) } : {}) });
      if (!domain.revokedAt && Number.isFinite(domain.expiresAt) && this.now() >= domain.expiresAt)
        this.event('operator', 'expire', [ref(domain.id), domain.expiresAt], 'expired', { ...(id(domain.id) ? { itemId: id(domain.id) } : {}) });
    }
    for (const row of records) {
      if (!ref(row.id) || !ref(row.actor?.id)) continue;
      const metadata = { ...(id(row.id) ? { itemId: id(row.id) } : {}), ...(id(row.actor.id) ? { memberId: id(row.actor.id) } : {}) };
      if (Number.isSafeInteger(row.humanDecision) && Number.isFinite(row.humanDecisionAt ?? row.finishedAt)) {
        const action = row.humanDecision === (row.confirmation?.options?.cancelId ?? 0) ? 'reject' : 'confirm';
        // A permit is not an execution receipt; never copy command arguments or card text.
        this.event('confirmation', action, answer(row), action, metadata);
      }
      if (row.disposition === 'expired' && Number.isFinite(row.finishedAt))
        this.event('confirmation', 'expire', [...card(row), row.finishedAt], OUTCOMES.has(row.state) ? row.state : 'unknown', metadata);
    }
    this.flush();
  }
}
// The native session whose card the person answered in `event`, by its session's operation records, or null.
const asker = (records, event) => records.find(row => answers(row, event))?.actor.nativeId ?? null;
module.exports = { PersonActions, asker };
