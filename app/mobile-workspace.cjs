'use strict';
// A scoped projection/adaptation of the desktop's state and business operations.
// No listener, native process, reminder store or generic application-command API.
const { roomIds } = require('./collaboration-spaces.cjs');
const queueRules = require('./queue-dispatch.cjs');
const { createHash } = require('node:crypto');
const presentation = card => 'sha256:' + createHash('sha256').update(JSON.stringify([card.title, card.detail])).digest('hex');
const denied = () => Object.assign(Error('Mobile workspace authorization or state changed'), { code: 'MOBILE_WORKSPACE_DENIED', notSent: true });
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const identifier = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(s);
const text = (s, limit = 65536) => typeof s === 'string' ? s.slice(0, limit) : '';
function conversation(rows = [], sessionId) {
  let bytes = 0, omitted = 0;
  const result = [];
  for (const m of rows.slice().reverse()) {
    if (!m || !['user', 'human', 'assistant', 'system'].includes(m.role)) continue;
    const content = text(m.text), size = Buffer.byteLength(content);
    if (result.length >= 200 || bytes + size > 128 * 1024) { omitted++; continue; }
    bytes += size;
    result.push({ id: text(m.id, 200), role: m.role, text: content, name: text(m.name, 200), time: m.time,
      status: text(m.status, 80), kind: text(m.kind, 80), textOmitted: typeof m.text === 'string' && m.text.length > content.length,
      ...(sessionId && m.backgroundOperation?.id ? { confirmationId: sessionId + ':' + m.backgroundOperation.id } : {}),
      attachments: Array.isArray(m.images) ? m.images.length : 0 });
  }
  return { messages: result.reverse(), earlierMessagesOmitted: omitted };
}
class MobileWorkspace {
  constructor({ snapshot, roomState, labels = new Map(), records, confirmation, decide, broadcast = async () => {}, schedule = () => {}, now = Date.now }) {
    if (typeof snapshot !== 'function' || !roomState || !records || typeof records.status !== 'function' || typeof records.acknowledge !== 'function') throw denied();
    Object.assign(this, { snapshot, roomState, labels, records, confirmation, decide, broadcast, schedule, now });
  }
  grant(client, value) {
    if (!exact(value, ['roomIds', 'records']) || !Array.isArray(value.roomIds) || value.roomIds.length > 32 ||
        value.roomIds.some(id => !identifier(id)) || new Set(value.roomIds).size !== value.roomIds.length || typeof value.records !== 'boolean') throw denied();
    const state = this.snapshot(client);
    for (const id of value.roomIds) if (!(state.rooms || [state.room]).some(r => r?.id === id && !r.archived)) throw denied();
    return structuredClone(value);
  }
  async read(client, grant, scopes) {
    await client.refresh();
    const state = this.snapshot(client), permitted = new Map(), cards = new Map();
    for (const scope of scopes.filter(s => s.actions.includes('read'))) {
      const record = state.sessions.find(s => s.id === scope.sessionId);
      if (!record || record.archived || record.nativeContextPending || record.nativeId !== scope.nativeId) continue;
      try { if (client.route(record.id).key !== scope.serviceKey) continue; } catch { continue; }
      permitted.set(record.id, record);
      for (const message of record.messages || []) {
        const card = message.backgroundOperation;
        if (!card?.confirmation || card.nativeId !== record.nativeId) continue;
        const options = card.confirmation.options || {};
        const id = record.id + ':' + card.id;
        cards.set(id, { id, operationId: card.id, sessionId: record.id, actorName: record.name,
          title: text(options.message, 2000), detail: text(options.detail, 16000), time: message.time,
          expiresAt: Number.isSafeInteger(card.expiresAt) ? card.expiresAt : null,
          state: card.replacedBy ? 'replaced' : card.state, disposition: card.disposition || null, canDecide: false });
      }
    }
    // The same pending/card projection as the desktop. Never infer permission
    // to approve from read/send/answer or from the transport's bearer identity.
    for (const card of state.backgroundConfirmations || []) {
      const record = permitted.get(card.sessionId);
      if (!record || card.nativeId !== record.nativeId) continue;
      const operation = card.message?.backgroundOperation;
      const id = card.sessionId + ':' + card.operationId;
      cards.set(id, { id, operationId: card.operationId, sessionId: card.sessionId, actorName: card.actorName,
        title: text(card.title, 2000), detail: text(card.detail, 16000), time: card.time,
        expiresAt: Number.isSafeInteger(operation?.expiresAt) ? operation.expiresAt : null,
        state: operation?.state || 'confirmation-required', disposition: operation?.disposition || null, canDecide: false });
    }
    for (const card of cards.values()) {
      try {
        const binding = this.confirmation(card.sessionId, permitted.get(card.sessionId).nativeId, card.operationId, 1);
        if (binding.presentation === presentation(card)) card.version = binding.version;
      } catch { /* Readable cards without complete, current proof remain disabled. */ }
    }
    const sessions = [...permitted.values()].map(s => {
      const boundary = (s.messages || []).findLastIndex(m => s.nativeContexts?.some(c => c.boundaryId === m.id));
      return { id: s.id, name: s.name, provider: s.provider, state: s.state, roomIds: roomIds(s).filter(id => grant.roomIds.includes(id)),
        ...conversation((s.messages || []).slice(boundary + 1).filter(m => !m.nativeId || m.nativeId === s.nativeId), s.id) };
    });
    const rooms = (state.rooms || [state.room]).filter(r => r && grant.roomIds.includes(r.id) && !r.archived).map(r => ({
      id: r.id, name: r.name, queue: (r.queue || []).map(i => ({ id: i.id, text: i.text, status: i.status,
        assignee: i.assignee, sentTo: i.sentTo, reply: i.reply, reason: i.reason, question: i.question })),
      members: state.sessions.filter(s => !s.archived && roomIds(s).includes(r.id)).map(s => ({ id: s.id, name: s.name, provider: s.provider, state: s.state })),
      ...conversation(r.messages),
    }));
    const result = { sessions, rooms, confirmations: [...cards.values()], reminders: grant.records ? this.records.status() : null, syncedAt: this.now(),
      capabilities: { queue: grant.roomIds.length > 0, records: grant.records, sensitiveDecisions: false, nativeTerminal: false } };
    if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024) throw denied();
    return result;
  }
  confirmationBinding(client, scopes, value, running = false) {
    if (!value || !['approve', 'deny'].includes(value.decision) || typeof value.id !== 'string' || typeof value.version !== 'string') throw denied();
    const separator = value.id.indexOf(':'), sessionId = value.id.slice(0, separator), operationId = value.id.slice(separator + 1);
    // Desktop operation IDs are opaque tokens, including ':' and '.', not
    // session UUIDs. The authoritative controller matches the exact record.
    if (separator < 1 || !identifier(sessionId) || !operationId) throw denied();
    const scope = scopes.find(s => s.sessionId === sessionId && s.actions.includes('read'));
    const record = this.snapshot(client).sessions.find(s => s.id === sessionId);
    if (!scope || !record || record.archived || record.nativeContextPending || record.nativeId !== scope.nativeId || client.route(sessionId).key !== scope.serviceKey) throw denied();
    // Current desktop cards have Cancel=0, Approve=1. Other button schemes are
    // deliberately left on the Mac, rather than guessing a sensitive decision.
    const binding = this.confirmation(sessionId, scope.nativeId, operationId, value.decision === 'approve' ? 1 : 0, running);
    if (binding.version !== value.version || !binding.expiresAt || binding.expiresAt <= this.now()) throw denied();
    return binding;
  }
  async decision(client, scopes, value, permit, valid) {
    await client.refresh();
    const check = () => { permit.check(valid(), this.confirmationBinding(client, scopes, value, true)); };
    check();
    const binding = this.confirmationBinding(client, scopes, value);
    return this.decide(binding.sessionId, binding.nativeId, binding.operationId, binding.decision, check);
  }
  async action(client, grant, value, valid) {
    if (typeof valid !== 'function') throw denied();
    if (value.action === 'recordAcknowledge') {
      if (!grant.records || !exact(value, ['requestId', 'action', 'record', 'kind', 'level'])) throw denied();
      const source = this.records.status(), record = source.records.find(r => r.record === value.record);
      if (!record?.items.some(i => i.shown && i.kind === value.kind && i.level === value.level)) throw denied();
      valid(); this.records.acknowledge(value.record, value.kind, value.level);
      return { status: 'complete' };
    }
    if (!['queueAdd', 'queueCancel', 'queueResolve'].includes(value.action) || !grant.roomIds.includes(value.roomId)) throw denied();
    this.roomState.metadata(value.roomId);
    let itemId;
    if (value.action === 'queueAdd') {
      if (!exact(value, ['requestId', 'action', 'roomId', 'text', 'assignee']) || value.assignee !== null && !identifier(value.assignee)) throw denied();
      if (value.assignee !== null) {
        await client.refresh();
        const sessions = this.snapshot(client).sessions;
        const refusal = queueRules.assigneeRefusal(value.assignee, { id: value.roomId, memberOrder: this.roomState.metadata(value.roomId).memberOrder }, sessions,
          s => this.labels.get(s.id) || s.name || s.id);
        if (refusal) throw Object.assign(refusal, { notSent: true });
      }
      valid();
      itemId = this.roomState.queueAdd(value.text, value.assignee, value.roomId, { kind: 'person', name: 'You', sessionId: null }, null);
    } else {
      if (!exact(value, ['requestId', 'action', 'roomId', 'itemId']) || !identifier(value.itemId)) throw denied();
      itemId = value.itemId; valid();
      if (value.action === 'queueCancel') this.roomState.queueCancel(itemId, value.roomId, null);
      else this.roomState.queueResolve(itemId, value.roomId, null);
    }
    await this.broadcast(); this.schedule();
    return { status: 'complete', itemId };
  }
}
module.exports = { MobileWorkspace };
