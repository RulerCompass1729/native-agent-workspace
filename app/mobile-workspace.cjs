'use strict';
// A scoped projection/adaptation of the desktop's state and business operations.
// No listener, native process, reminder store or generic application-command API.
const { roomIds } = require('./collaboration-spaces.cjs');
const queueRules = require('./queue-dispatch.cjs');
const { createHash } = require('node:crypto');
const presentation = card => 'sha256:' + createHash('sha256').update(JSON.stringify([card.title, card.detail])).digest('hex');
const { nonBlockingQuestion } = require('./approval-policy.js');
const { confirmationSummary } = require('./confirmation-inbox.cjs');
const { tempSummary } = require('./temp-reminders.cjs');
const { currentTarget } = require('./mobile-session.cjs');
const { storedQueueSource } = require('./butler-ingress.cjs');
const denied = () => Object.assign(Error('Mobile workspace authorization or state changed'), { code: 'MOBILE_WORKSPACE_DENIED', notSent: true });
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const identifier = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(s);
const text = (s, limit = 65536) => typeof s === 'string' ? s.slice(0, limit) : '';
function healthSummary(wake, reasons) {
  if (!Array.isArray(reasons) || !reasons.length || !wake || typeof wake.on !== 'boolean' || wake.failed !== false ||
      wake.blocked && !reasons.includes(wake.blocked.reason)) return { available: false, alerts: [] };
  return { available: true, alerts: wake.blocked ? [{ code: 'steward-wake-stalled' }] : [] };
}
// cards: the confirmation ids this view can show. Other background operations and rows with no text
// are not messages; on the phone they only took row slots as "earlier messages not shown" notes.
function conversation(rows = [], sessionId, budget, cards) {
  let bytes = 0, omitted = 0;
  const result = [];
  const limit = budget ?? 128 * 1024;
  const prefix = (value, count) => {
    const data = Buffer.from(value); let end = Math.min(count, data.length);
    while (end > 0 && (data[end] & 0xc0) === 0x80) end--;
    return data.subarray(0, end).toString('utf8');
  };
  for (const m of rows.slice().reverse()) {
    if (!m || !['user', 'human', 'assistant', 'system'].includes(m.role)) continue;
    const card = sessionId && m.backgroundOperation?.id ? [sessionId, m.backgroundOperation.nativeId, m.backgroundOperation.id].join(':') : null;
    if (m.backgroundOperation ? !cards?.has(card) : !(typeof m.text === 'string' && m.text.trim()) && !m.images?.length) continue;
    let content = m.backgroundOperation ? '' : text(m.text);
    if (budget !== undefined && /[\ud800-\udbff]$/.test(content)) content = content.slice(0, -1);
    const row = { id: text(m.id, 200), role: m.role, text: content, name: text(m.name, 200), time: m.time,
      status: text(m.status, 80), kind: text(m.kind, 80), textOmitted: !card && typeof m.text === 'string' && m.text.length > content.length,
      ...(card ? { confirmationId: card } : {}),
      attachments: Array.isArray(m.images) ? m.images.length : 0 };
    let size = budget === undefined ? Buffer.byteLength(content) : Buffer.byteLength(JSON.stringify(row));
    if (budget !== undefined && size > limit - bytes) {
      row.textOmitted = true; row.text = '';
      const overhead = Buffer.byteLength(JSON.stringify(row));
      let low = 0, high = Math.min(Buffer.byteLength(content), Math.max(0, limit - bytes - overhead));
      while (low < high) {
        const mid = Math.ceil((low + high) / 2); row.text = prefix(content, mid);
        if (Buffer.byteLength(JSON.stringify(row)) <= limit - bytes) low = mid; else high = mid - 1;
      }
      row.text = prefix(content, low); size = Buffer.byteLength(JSON.stringify(row));
    }
    if (result.length >= 200 || bytes + size > limit) { omitted++; continue; }
    bytes += size; result.push(row);
  }
  return { messages: result.reverse(), earlierMessagesOmitted: omitted };
}
class MobileWorkspace {
  constructor({ snapshot, roomState, labels = new Map(), records, confirmation, decide, broadcast = async () => {}, schedule = () => {}, now = Date.now, steward, personAction = () => {} }) {
    if (typeof snapshot !== 'function' || !roomState || !records || typeof records.status !== 'function' || typeof records.acknowledge !== 'function') throw denied();
    Object.assign(this, { snapshot, roomState, labels, records, confirmation, decide, broadcast, schedule, now, steward, personAction });
  }
  waitingQuestions(roomId, items) {
    const questions = new Map();
    if (!items.length) return questions;
    const events = this.roomState.metadata?.(roomId)?.events || [], byId = new Map(items.map(i => [i.id, i]));
    for (let n = events.length - 1; n >= 0; n--) {
      const event = events[n], item = byId.get(event.itemId);
      // The member that asked: a decision that went to a successor keeps its question (room-state.cjs queueCarry).
      const asker = item?.askedBy?.id ?? item?.sentTo;
      if (!item || questions.has(item.id) || event.kind !== 'queue' || event.sessionId !== asker) continue;
      const source = storedQueueSource(roomId, event);
      if (source.kind === 'decision' && source.payload.itemId === item.id && source.payload.memberId === asker && source.payload.title)
        questions.set(item.id, { question: source.payload.title, questionId: event.id });
    }
    return questions;
  }
  // earlier: the session an answer was already delivered to, when the item went to a successor meanwhile. Only the
  // one the item names as its holder just before (carriedFrom) is accepted, under the same checks.
  queueAnswerTarget(client, grant, target, earlier) {
    if (!exact(target, ['roomId', 'itemId', 'questionId']) || ![target.roomId, target.itemId, target.questionId].every(identifier)) throw denied();
    grant = this.resolveGrant(grant, this.snapshot(client));
    if (!grant.roomIds.includes(target.roomId)) throw denied();
    const item = this.roomState.queueFind(target.roomId, target.itemId);
    const holder = earlier === undefined ? { id: item.sentTo, nativeId: item.sentNative } : item.carriedFrom;
    if (!holder || earlier !== undefined && holder.id !== earlier) throw denied();
    const session = this.snapshot(client).sessions.find(s => s.id === holder.id);
    if (item.status !== 'waiting' || !session || session.archived || session.nativeContextPending || !holder.nativeId ||
        session.nativeId !== holder.nativeId || this.waitingQuestions(target.roomId, [item]).get(item.id)?.questionId !== target.questionId) throw denied();
    return { ...target, sessionId: session.id, nativeId: session.nativeId, serviceKey: client.route(session.id).key };
  }
  // Which phone entry the Mac's butler gets. Only a session this phone already reads is named; otherwise only why not.
  stewardEntry(all, permitted, scopes) {
    let current = null;
    try { current = this.steward(); } catch { return { state: 'unavailable' }; }
    if (!current) return { state: 'none' };
    const record = permitted.get(current.sessionId);
    // A selected pairing still reads an ended or closed session; only a current one is the butler's entry.
    if (record && record.nativeId === current.nativeId) return currentTarget(record) ? { state: 'shared', sessionId: record.id } : { state: 'unavailable' };
    const chosen = scopes.some(s => s.sessionId === current.sessionId && s.nativeId === current.nativeId && s.actions.includes('read'));
    return { state: all || chosen ? 'unavailable' : 'notSelected' };
  }
  grant(client, value) {
    if (exact(value, ['allRooms', 'records']) && value.allRooms === true && typeof value.records === 'boolean') return structuredClone(value);
    if (!exact(value, ['roomIds', 'records']) || !Array.isArray(value.roomIds) || value.roomIds.length > 32 ||
        value.roomIds.some(id => !identifier(id)) || new Set(value.roomIds).size !== value.roomIds.length || typeof value.records !== 'boolean') throw denied();
    const state = this.snapshot(client);
    for (const id of value.roomIds) if (!(state.rooms || [state.room]).some(r => r?.id === id && !r.archived)) throw denied();
    return structuredClone(value);
  }
  async read(client, grant, scopes, selection) {
    if (selection !== undefined && !(exact(selection, ['kind']) && selection.kind === 'summary' ||
        exact(selection, ['kind', 'id']) && ['session', 'room'].includes(selection.kind) && identifier(selection.id))) throw denied();
    await client.refresh();
    const state = this.snapshot(client), permitted = new Map(), cards = new Map(), originals = new Map();
    const all = exact(grant, ['allRooms','records']) && grant.allRooms === true;
    grant = this.resolveGrant(grant, state);
    for (const scope of scopes.filter(s => s.actions.includes('read'))) {
      const record = state.sessions.find(s => s.id === scope.sessionId);
      if (!record || record.archived || record.nativeContextPending || record.nativeId !== scope.nativeId || all && !currentTarget(record)) continue;
      try { if (client.route(record.id).key !== scope.serviceKey) continue; } catch { continue; }
      permitted.set(record.id, record);
      // Older desktop projections did not expose the unified array. Keep their
      // read-only fallback, still using the same whitelist and native identity.
      for (const message of Array.isArray(state.backgroundConfirmations) ? [] : record.messages || []) {
        const card = message.backgroundOperation;
        if (!card?.confirmation || card.nativeId !== record.nativeId) continue;
        const id = [record.id, record.nativeId, card.id].join(':');
        cards.set(id, { ...confirmationSummary({ ...card, id: message.id, operationId: card.id, sessionId: record.id, nativeId: record.nativeId,
          actorName: record.name, time: message.time, state: card.replacedBy ? 'replaced' : card.state, actionable: false }), id, messageId: message.id });
        const options = card.confirmation.options || {};
        originals.set(id, { title: text(options.message, 2000), detail: text(options.detail, 16000) });
      }
    }
    // The same pending/card projection as the desktop. Never infer permission
    // to approve from read/send/answer or from the transport's bearer identity.
    for (const card of state.backgroundConfirmations || []) {
      const record = permitted.get(card.sessionId);
      if (!record || card.nativeId !== record.nativeId) continue;
      const id = card.key || [card.sessionId, card.nativeId, card.operationId].join(':');
      cards.set(id, { ...confirmationSummary(card), id, messageId: card.id });
      // Only this scoped decision view reads the complete original prompt.
      // The shared inbox/bell summary deliberately has no top-level detail.
      const original = card.message?.backgroundOperation;
      const options = original?.id === card.operationId && original.nativeId === record.nativeId ? original.confirmation?.options : null;
      originals.set(id, options ? { title: text(options.message, 2000), detail: text(options.detail, 16000) }
        : { title: text(card.title, 2000), detail: text(card.detail, 16000) });
    }
    for (const card of cards.values()) {
      try {
        const binding = this.confirmation(card.sessionId, permitted.get(card.sessionId).nativeId, card.operationId, 1);
        // Decision content remains exactly what the existing phone authority
        // signed. Read-only reminders below still receive safe summaries only.
        const original = originals.get(card.id);
        if (binding.presentation === presentation(original)) {
          Object.assign(card, original, { version: binding.version }); delete card.titles;
        }
      } catch { /* Readable cards without complete, current proof remain disabled. */ }
    }
    const roomRows = (state.rooms || [state.room]).filter(r => r && grant.roomIds.includes(r.id) && !r.archived);
    if (selection?.kind === 'session' && !permitted.has(selection.id) || selection?.kind === 'room' && !roomRows.some(r => r.id === selection.id)) throw denied();
    // Share a body budget across all threads; leave the existing response cap
    // for metadata, exact confirmation content and reminders. Selected mode
    // keeps its original per-thread contract. Native data is never modified.
    const bodyBudget = all ? Math.min(128 * 1024, Math.floor(4 * 1024 * 1024 / Math.max(1, permitted.size + roomRows.length))) : undefined;
    const sessions = [...permitted.values()].map(s => {
      // question: a Codex question that does not block the turn is open; the home row says it needs you, as 等你 does.
      const row = { id: s.id, name: s.name, provider: s.provider, state: s.state, question: (s.approvals || []).some(r => !r.pending && nonBlockingQuestion(r)), roomIds: roomIds(s).filter(id => grant.roomIds.includes(id)) };
      if (selection && (selection.kind !== 'session' || selection.id !== s.id)) return { ...row, conversationLoaded: false };
      const boundary = (s.messages || []).findLastIndex(m => s.nativeContexts?.some(c => c.boundaryId === m.id));
      return { ...row, ...(selection ? { conversationLoaded: true } : {}),
        ...conversation((s.messages || []).slice(boundary + 1).filter(m => (!m.nativeId || m.nativeId === s.nativeId) &&
          (!m.backgroundOperation?.nativeId || m.backgroundOperation.nativeId === s.nativeId)), s.id, bodyBudget, cards) };
    });
    const rooms = roomRows.map(r => {
      const questions = this.waitingQuestions(r.id, r.queue || []);
      return {
      id: r.id, name: r.name, queue: (r.queue || []).map(i => ({ id: i.id, text: i.text, status: i.status,
        assignee: i.assignee, sentTo: i.sentTo, reply: i.reply, reason: i.reason, ...questions.get(i.id),
        ...(i.answer ? { answer: { text: i.answer.text, deliveredAt: i.answer.deliveredAt } } : {}),
        canAnswer: i.status === 'waiting' && permitted.get(i.sentTo)?.nativeId === i.sentNative &&
          scopes.some(s => s.sessionId === i.sentTo && s.nativeId === i.sentNative && s.actions.includes('send')) })),
      members: state.sessions.filter(s => !s.archived && roomIds(s).includes(r.id)).map(s => ({ id: s.id, name: s.name, provider: s.provider, state: s.state })),
      ...(selection && (selection.kind !== 'room' || selection.id !== r.id) ? { conversationLoaded: false }
        : { ...conversation(r.messages, undefined, bodyBudget), ...(selection ? { conversationLoaded: true } : {}) }),
      };
    });
    const shared = grant.records ? this.records.status(state, client) : null;
    const reminders = shared && { ...shared,
      ...(shared.temp ? { temp: tempSummary(shared.temp) } : {}),
      ...(shared.confirmations ? { confirmations: [...cards.values()].map(confirmationSummary) } : {}) };
    const result = { sessions, rooms, confirmations: [...cards.values()], reminders, syncedAt: this.now(),
      ...(typeof this.steward === 'function' ? { steward: this.stewardEntry(all, permitted, scopes) } : {}),
      capabilities: { queue: grant.roomIds.length > 0, records: grant.records, sensitiveDecisions: false, nativeTerminal: false } };
    if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024) throw denied();
    return result;
  }
  confirmationBinding(client, scopes, value, running = false) {
    if (!value || !['approve', 'deny'].includes(value.decision) || typeof value.id !== 'string' || typeof value.version !== 'string') throw denied();
    const separator = value.id.indexOf(':'), sessionId = value.id.slice(0, separator);
    let operationId = value.id.slice(separator + 1);
    // Desktop operation IDs are opaque tokens, including ':' and '.', not
    // session UUIDs. The authoritative controller matches the exact record.
    if (separator < 1 || !identifier(sessionId) || !operationId) throw denied();
    const scope = scopes.find(s => s.sessionId === sessionId && s.actions.includes('read'));
    const state = this.snapshot(client), record = state.sessions.find(s => s.id === sessionId);
    if (!scope || !record || record.archived || record.nativeContextPending || record.nativeId !== scope.nativeId || client.route(sessionId).key !== scope.serviceKey) throw denied();
    // Match full inbox keys against the current native identity, without
    // guessing where an opaque operation ID containing ':' begins. Legacy
    // requests remain valid through the original exact controller lookup.
    const candidates = new Set((state.backgroundConfirmations || [])
      .filter(card => card.sessionId === sessionId && card.nativeId === scope.nativeId &&
        ([sessionId, scope.nativeId, card.operationId].join(':') === value.id || sessionId + ':' + card.operationId === value.id))
      .map(card => card.operationId));
    if (candidates.size > 1) throw denied();
    if (candidates.size === 1) operationId = [...candidates][0];
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
  async action(client, grant, value, valid, answerProof) {
    if (typeof valid !== 'function') throw denied();
    grant = this.resolveGrant(grant, this.snapshot(client));
    if (value.action === 'recordAcknowledge') {
      if (!grant.records || !exact(value, ['requestId', 'action', 'record', 'kind', 'level'])) throw denied();
      const source = this.records.status(null, client), record = source.records.find(r => r.record === value.record);
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
      const answering = value.action === 'queueResolve' && Object.hasOwn(value, 'answerRequestId');
      if (!exact(value, answering ? ['requestId', 'action', 'roomId', 'itemId', 'questionId', 'answerRequestId'] : ['requestId', 'action', 'roomId', 'itemId']) || !identifier(value.itemId)) throw denied();
      itemId = value.itemId; valid();
      if (value.action === 'queueCancel') this.roomState.queueCancel(itemId, value.roomId, null);
      else if (answering) {
        if (typeof answerProof !== 'function') throw denied();
        await client.refresh();
        const asked = { roomId: value.roomId, itemId, questionId: value.questionId };
        let target = null, refused = null;
        try { target = this.queueAnswerTarget(client, grant, asked); } catch (error) { refused = error; }
        let proof;
        try { proof = answerProof(); } catch (error) { throw refused || error; }
        valid();
        // Sent to the session before, received there, and the item went to a successor meanwhile: closed once, for
        // that one, whatever state the successor is in. Any other refusal stays the one the holder's check gave.
        if (typeof proof.sessionId === 'string' && proof.sessionId !== target?.sessionId) {
          try { target = this.queueAnswerTarget(client, grant, asked, proof.sessionId); } catch (error) { throw refused || error; }
        }
        if (!target) throw refused;
        if (proof.requestId !== value.answerRequestId || proof.sessionId !== target.sessionId || proof.nativeId !== target.nativeId ||
            proof.serviceKey !== target.serviceKey || typeof proof.text !== 'string' || !proof.text.trim() || proof.text.length > 6000) throw denied();
        this.roomState.queueResolve(itemId, value.roomId, null, proof.text, target.sessionId);
      } else this.roomState.queueResolve(itemId, value.roomId, null);
    }
    if (['queueCancel', 'queueResolve'].includes(value.action))
      this.personAction('spaceAction', [value.roomId, value.action, Object.hasOwn(value, 'answerRequestId') ? [itemId, null] : [itemId]]);
    await this.broadcast(); this.schedule();
    return { status: 'complete', itemId };
  }
  resolveGrant(grant, state) {
    if (exact(grant, ['allRooms','records']) && grant.allRooms === true && typeof grant.records === 'boolean') {
      return { roomIds: (state.rooms || [state.room]).filter(r => r && !r.archived).map(r => r.id), records: grant.records };
    }
    return grant;
  }
}
module.exports = { MobileWorkspace, healthSummary };
