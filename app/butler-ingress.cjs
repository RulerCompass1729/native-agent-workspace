'use strict';
// Local business facts only. This intake has no native/model, timer, queue-write
// or lifecycle dependency. The working-day recording trial remains off.
const { createHash } = require('node:crypto');
const { ButlerLedger } = require('./butler-ledger.cjs');
const { validateEvent } = require('./butler-policy.cjs');
const { storedReadySource, storedDoneSource } = require('./butler-ready.cjs');
const { nonBlockingQuestion } = require('./approval-policy.js');
const { codexQuotaBlock } = require('./native-usage.js');
const { automaticInput } = require('./queue-dispatch.cjs');
const { roomIds } = require('./collaboration-spaces.cjs');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unavailable = () => Object.assign(Error('Butler source unavailable'), { code: 'BUTLER_SOURCE_UNAVAILABLE' });
const clipped = (value, limit) => typeof value === 'string' && value ? value.slice(0, limit) : undefined;
const recoveryFailureReasons = Object.freeze({ capacity: 'capacity-retry-exhausted', routing: 'routing-retry-exhausted',
  forbidden: 'forbidden-retry-exhausted', connection: 'connection-retry-exhausted' });
const CODE = /^[a-z0-9-]{1,80}$/;
// Not CODE.test alone: it reads undefined as the string 'undefined'.
const isCode = value => typeof value === 'string' && CODE.test(value);
// A message key as a code: 'error.wake.recipientIdentityChanged' is 'recipient-identity-changed'.
function keyCode(key) {
  const last = typeof key === 'string' ? key.split('.').pop() : '';
  const code = last.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase());
  return isCode(code) ? code : 'unknown';
}
// A sender's row of an automatic message that did not go out: refused, withdrawn, or its one attempt failed.
function undeliveredRow(row) {
  const intent = row?.wake;
  if (row?.origin !== 'agent-wake-intent' || typeof row.id !== 'string' || !row.id || !intent || typeof intent.recipientId !== 'string') return null;
  // When it failed, not when it was staged: a row staged before main restarted can fail after. A backend without
  // settledAt gives the staging time.
  const at = Number.isSafeInteger(intent.settledAt) ? intent.settledAt : intent.time;
  if (intent.status === 'not-sent') return { outcome: 'not-sent', code: keyCode(row.uiMessage?.cause?.key), at };
  if (intent.status === 'cancelled') {
    const code = isCode(intent.cancellation?.code) ? intent.cancellation.code : keyCode(row.uiMessage?.key);
    return { outcome: 'cancelled', code, at: intent.cancellation?.at ?? at };
  }
  if (intent.status === 'unconfirmed' && row.uiMessage?.key === 'error.wake.deliveryUnconfirmed') return { outcome: 'unconfirmed', code: 'delivery-failed', at };
  return null;
}
const sourceId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\s\u0000-\u001f\u007f]/u.test(value);
const exactFields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
  Object.keys(value).sort().join(',') === keys;
const quotaResetAt = quota => Number.isSafeInteger(quota?.resetsAt) && quota.resetsAt >= 0 && quota.resetsAt <= 8640000000000
  ? new Date(quota.resetsAt * 1000).toISOString() : null;
function quotaSource(memberId, quota) {
  const resetsAt = quotaResetAt(quota);
  return { eventId: `codex-quota:${hash([memberId, quota.nativeId, quota.turnId])}`,
    sourceRef: `codex-quota:${memberId}`, kind: 'blocked', payload: { memberId, reason: 'codex-usage-limit-exceeded',
      ...(resetsAt ? { resetsAt } : {}) } };
}
function noReplyFact(roomId, eventId, item, session) {
  const quota = session?.id === item.sentTo && !session.archived && session.nativeId === item.sentNative ? codexQuotaBlock(session) : null;
  return { version: 1, roomId, eventId, itemId: item.id, memberId: item.sentTo,
    dispatch: { nativeId: item.sentNative ?? null, sentAt: item.sentAt, tag: item.tag ?? null, control: item.control ?? null },
    status: 'waiting', reason: 'no-reply', quota: quota && sourceId(quota.nativeId) && sourceId(quota.turnId) ? {
      provider: 'codex', kind: quota.kind, nativeId: quota.nativeId, turnId: quota.turnId, observedAt: quota.observedAt,
      ...(quotaResetAt(quota) ? { resetsAt: quota.resetsAt } : {}) } : null };
}
function noReplyContext(fact) {
  const d = fact.dispatch, q = fact.quota;
  const quotaFields = q && [q.provider, q.kind, q.nativeId, q.turnId, q.observedAt];
  if (q && Object.hasOwn(q, 'resetsAt')) quotaFields.push(q.resetsAt);
  return { version: 2, roomId: fact.roomId, eventId: fact.eventId, itemId: fact.itemId, memberId: fact.memberId,
    quota: q ? { nativeId: q.nativeId, turnId: q.turnId } : null,
    factHash: hash([fact.roomId, fact.eventId, fact.itemId, fact.memberId, [d.nativeId, d.sentAt, d.tag, d.control],
      fact.status, fact.reason, quotaFields]) };
}
function checkedNoReplyFact(roomId, event) {
  const fact = event.queueSettlement, context = event.butlerNoReplySource, d = fact?.dispatch, q = fact?.quota;
  if (!exactFields(fact, 'dispatch,eventId,itemId,memberId,quota,reason,roomId,status,version') || fact.version !== 1 ||
      fact.roomId !== roomId || fact.eventId !== event.id || !sourceId(fact.roomId) || !sourceId(fact.eventId) ||
      !sourceId(fact.itemId) || !sourceId(fact.memberId) || fact.itemId !== event.itemId || fact.memberId !== event.sessionId ||
      fact.status !== 'waiting' || fact.reason !== 'no-reply' || event.kind !== 'queue' || event.role !== 'system' ||
      event.uiMessage?.key !== 'notice.queue.lookAt' || event.monitor !== undefined ||
      Object.hasOwn(event, 'butlerSource') || Object.hasOwn(event, 'butlerDoneSource') ||
      !exactFields(d, 'control,nativeId,sentAt,tag') || !Number.isFinite(d.sentAt) || d.sentAt < 0 ||
      d.nativeId !== null && !(typeof d.nativeId === 'string' && d.nativeId.length > 0 && d.nativeId.length <= 2000 && !/[\u0000-\u001f]/u.test(d.nativeId)) ||
      d.tag !== null && !sourceId(d.tag) || d.control !== null && !(Number.isSafeInteger(d.control) && d.control >= 0) ||
      q !== null && (!exactFields(q, q && Object.hasOwn(q, 'resetsAt') ? 'kind,nativeId,observedAt,provider,resetsAt,turnId' : 'kind,nativeId,observedAt,provider,turnId') || q.provider !== 'codex' || q.kind !== 'usage_limit_exceeded' ||
        !sourceId(q.nativeId) || q.nativeId !== d.nativeId || !sourceId(q.turnId) || !Number.isSafeInteger(q.observedAt) || q.observedAt < 0 ||
        Object.hasOwn(q, 'resetsAt') && !quotaResetAt(q))) throw unavailable();
  const expected = noReplyContext(fact);
  if (!exactFields(context, 'eventId,factHash,itemId,memberId,quota,roomId,version') || context.version !== expected.version ||
      context.roomId !== expected.roomId || context.eventId !== expected.eventId || context.itemId !== expected.itemId ||
      context.memberId !== expected.memberId || context.factHash !== expected.factHash ||
      (q === null ? context.quota !== null : !exactFields(context.quota, 'nativeId,turnId') ||
        context.quota.nativeId !== q.nativeId || context.quota.turnId !== q.turnId)) throw unavailable();
  return fact;
}

function queueOutcomeSource(outcome) {
  if (outcome?.status === 'waiting' && outcome.reason === 'no-reply') {
    const { roomId, itemId, eventId, memberId, quota } = outcome;
    return validateEvent(quota ? quotaSource(memberId, quota) : {
      eventId: `butler-source:${hash([roomId, eventId])}`, sourceRef: `queue-outcome:${roomId}:${eventId}`,
      kind: 'failure', payload: { memberId, itemId, reason: 'no-reply-unconfirmed' } });
  }
  if (!outcome || !(outcome.status === 'failed' || outcome.status === 'waiting' && !outcome.reason)) return null;
  const { roomId, itemId, eventId } = outcome;
  const sourceRef = `queue-outcome:${roomId}:${eventId}`;
  const decision = outcome.status === 'waiting';
  const payload = { spaceId: roomId, itemId };
  if (clipped(outcome.memberId, 200)) payload.memberId = clipped(outcome.memberId, 200);
  if (clipped(outcome.memberName, 200)) payload.memberName = clipped(outcome.memberName, 200);
  if (clipped(outcome.task, 6000)) payload.text = clipped(outcome.task, 6000);
  if (decision) {
    payload.questionKey = `queue-decision:${roomId}:${itemId}`;
    payload.decisionKind = 'queue-decision';
    payload.title = clipped(outcome.question, 400) || clipped(outcome.task, 400) || 'Queue decision';
  } else if (clipped(outcome.reason, 2000)) payload.reason = clipped(outcome.reason, 2000);
  const event = { eventId: `butler-source:${hash([roomId, eventId])}`, sourceRef, kind: decision ? 'decision' : 'failure', payload };
  try { return validateEvent(event); }
  catch {
    // Keep a safe source reference instead of copying rejected business text.
    return validateEvent({ eventId: event.eventId, sourceRef, kind: 'blocked', payload: { spaceId: roomId, itemId, reason: 'input-rejected' } });
  }
}

// Auxiliary B4 data is interpreted after the space has loaded. A damaged or
// newly rejected source cannot change the availability of its original space.
function storedQueueSource(roomId, event) {
  const source = event.butlerDoneSource ?? event.butlerSource;
  const noReply = Object.hasOwn(event, 'butlerNoReplySource');
  if (!noReply && (Object.hasOwn(event, 'butlerDoneSource') || event.monitor?.kind === 'done' || source?.kind === 'done' ||
      typeof source?.eventId === 'string' && source.eventId.startsWith('butler-done:') ||
      typeof source?.sourceRef === 'string' && source.sourceRef.startsWith('queue-done:'))) return storedDoneSource(roomId, event);
  if (!noReply && (event.monitor?.kind === 'ready' || source?.kind === 'ready' ||
      typeof source?.eventId === 'string' && source.eventId.startsWith('butler-ready:') ||
      typeof source?.sourceRef === 'string' && source.sourceRef.startsWith('queue-ready:'))) return storedReadySource(roomId, event);
  const parent = [roomId, event.id], sourceRef = `queue-outcome:${roomId}:${event.id}`;
  try {
    if (noReply) {
      const fact = checkedNoReplyFact(roomId, event);
      return queueOutcomeSource({ roomId, eventId: event.id, itemId: fact.itemId, memberId: fact.memberId,
        status: fact.status, reason: fact.reason, quota: fact.quota });
    }
    const value = validateEvent(event.butlerSource);
    if (value.eventId !== `butler-source:${hash(parent)}` || value.sourceRef !== sourceRef ||
        value.payload.spaceId !== roomId || !value.payload.itemId || !['decision', 'failure', 'blocked'].includes(value.kind) ||
        value.kind === 'blocked' && value.payload.reason !== 'input-rejected' ||
        value.kind === 'decision' && (!value.payload.title || value.payload.decisionKind !== 'queue-decision' ||
          value.payload.questionKey !== `queue-decision:${roomId}:${value.payload.itemId}`)) throw unavailable();
    return value;
  } catch {
    const rejected = { eventId: `butler-source-rejected:${hash(parent)}`, sourceRef, kind: 'blocked',
      payload: { spaceId: roomId, itemId: event.id, reason: 'source-invalid' } };
    try { return validateEvent(rejected); }
    catch { return validateEvent({ eventId: rejected.eventId, sourceRef: `room-event:${hash(parent)}`,
      kind: 'blocked', payload: { reason: 'source-invalid' } }); }
  }
}

class ButlerIngress {
  constructor(directory, { roomState, ledger = new ButlerLedger(directory), now = Date.now } = {}) {
    if (!roomState || typeof roomState.butlerSources !== 'function') throw unavailable();
    this.roomState = roomState; this.ledger = ledger; this.errors = new Map(); this.terminalDialogs = new Map(); this.nativeQuestions = new Map(); this.recoveryFailures = new Set();
    this.now = now; this.humanSince = now(); this.humanInputs = new Set(); this.controlRefusals = new Set(); this.undeliveredWakes = new Set(); this.unbound = new Set();
    this.rotationStalls = new Set();
    for (const event of ledger.snapshot().events) {
      this.sourceStatus(event);
      if (/^rotation-stalled:[a-f0-9]{64}$/.test(event.eventId)) this.rotationStalls.add(event.eventId);
      if (/^control-refused:[a-f0-9]{64}$/.test(event.eventId)) this.controlRefusals.add(event.eventId);
      if (/^wake-undelivered:[a-f0-9]{64}$/.test(event.eventId)) this.undeliveredWakes.add(event.eventId);
      if (/^native-unbound:[a-f0-9]{64}$/.test(event.eventId) && event.kind === 'failure' && event.payload?.reason === 'native-unbound' &&
          event.sourceRef === `native-unbound:${event.payload.memberId}`) this.unbound.add(event.eventId);
      if (event.eventId.startsWith('human-input:') && event.kind === 'blocked' &&
          ['human-message', 'human-message-content-unavailable'].includes(event.payload.reason)) this.humanInputs.add(event.eventId);
      const failure = /^(connection|recovery)-exhausted:([a-f0-9]{64})$/.exec(event.eventId);
      if (failure && event.kind === 'failure' && Object.values(recoveryFailureReasons).includes(event.payload.reason) &&
          (failure[1] !== 'connection' || event.payload.reason === recoveryFailureReasons.connection) && event.sourceRef === `${failure[1]}-exhausted:${event.payload.memberId}`)
        this.recoveryFailures.add(failure[2]);
      const question = /^native-question:([a-f0-9]{64}):(open|ended)$/.exec(event.eventId);
      if (question && event.sourceRef === `native-question:${event.payload.memberId}`) {
        if (event.kind === 'blocked' && event.payload.reason === 'native-question') this.nativeQuestions.set(question[1], { memberId: event.payload.memberId });
        else if (event.kind === 'recovery' && event.payload.reason === 'native-question-ended') this.nativeQuestions.delete(question[1]);
        continue;
      }
      // Keep the saved payload immutable, including a member's former name.
      const match = /^terminal-dialog:([a-f0-9]{64}):(open|ended)$/.exec(event.eventId);
      if (!match || event.sourceRef !== `terminal-dialog:${event.payload.memberId}`) continue;
      if (event.kind === 'blocked' && event.payload.reason === 'native-terminal-dialog') this.terminalDialogs.set(event.payload.memberId, { identity: match[1] });
      else if (event.kind === 'recovery' && event.payload.reason === 'native-terminal-dialog-ended') this.terminalDialogs.delete(event.payload.memberId);
    }
  }
  sourceStatus(event) {
    if (event.kind === 'blocked' && ['input-rejected', 'source-invalid'].includes(event.payload.reason)) this.errors.set(event.sourceRef, 'source-rejected');
    else this.errors.delete(event.sourceRef);
  }
  status() {
    const errorCode = [...this.errors.values()].includes('source-unavailable') ? 'source-unavailable' : this.errors.size ? 'source-rejected' : null;
    return { intake: errorCode ? 'blocked' : 'ready', errorCode,
      activation: 'off', recordPeriod: 'off' };
  }
  record(event) {
    const scope = event?.sourceRef || 'unknown-source';
    try {
      validateEvent(event);
      this.ledger.ingest(event);
      let questionReceipt;
      if (event.kind === 'decision') {
        const reserved = this.ledger.reserveQuestion({ sourceRef: event.sourceRef, decisionKind: event.payload.decisionKind,
          text: event.payload.title || event.payload.text });
        // B1 owns the direct notification. An intake receipt cannot prove that
        // the operating system delivered it, and must never cause another ask.
        if (reserved.shouldNotify) this.ledger.ackDelivery(reserved.deliveryId, 'unknown');
        questionReceipt = { questionId: reserved.question.questionId, deliveryId: reserved.deliveryId };
      }
      if (['decision', 'failure', 'blocked'].includes(event.kind) || event.kind === 'recovery' && ['native-terminal-dialog-ended', 'native-question-ended'].includes(event.payload.reason)) this.ledger.consumeRecorded([event.eventId]);
      this.sourceStatus(event);
      return { status: 'recorded', eventId: event.eventId, ...questionReceipt };
    } catch { this.errors.set(scope, 'source-unavailable'); throw unavailable(); }
  }
  captureOutcome(roomId, eventId) {
    const scope = `queue-outcome:${roomId}:${eventId}`;
    try {
      const event = this.roomState.metadata(roomId).events.find(value => value.id === eventId);
      return event && (Object.hasOwn(event, 'butlerSource') || Object.hasOwn(event, 'butlerDoneSource') || Object.hasOwn(event, 'butlerNoReplySource'))
        ? this.record(storedQueueSource(roomId, event)) : { status: 'ignored' };
    } catch { this.errors.set(scope, 'source-unavailable'); throw unavailable(); }
  }
  recover() {
    try {
      let count = 0;
      for (const delivery of this.ledger.snapshot().deliveries) {
        if (delivery.status === 'reserved') this.ledger.ackDelivery(delivery.deliveryId, 'unknown');
      }
      let failed = false;
      for (const event of this.roomState.butlerSources()) {
        try { this.record(event); count++; } catch { failed = true; }
      }
      if (failed) throw unavailable();
      this.errors.delete('source-store'); return { status: 'recorded', count };
    } catch { this.errors.set('source-store', 'source-unavailable'); throw unavailable(); }
  }
  humanInputTask(session, message, spaces, index) {
    const matches = [];
    for (const spaceId of spaces) {
      let items; try { items = this.roomState.queueItems(spaceId); } catch { continue; }
      for (const item of items) {
        if (item.sentTo !== session.id || item.sentNative && item.sentNative !== session.nativeId ||
            !Number.isFinite(item.sentAt) || item.sentAt > message.time ||
            Number.isFinite(item.finishedAt) && item.finishedAt < message.time ||
            !['sent', 'waiting', 'done', 'failed', 'cancelled'].includes(item.status)) continue;
        const anchor = session.messages.findIndex(row => row?.id === item.tag);
        if (anchor >= index || anchor < 0 && item.sentNative !== session.nativeId) continue;
        matches.push({ spaceId, itemId: item.id });
      }
    }
    return matches.length === 1 ? matches[0] : {};
  }
  observeHumanInputs(sessions = [], { steward, name = s => s.name } = {}) {
    const now = this.now();
    for (const s of Array.isArray(sessions) ? sessions : []) {
      if (typeof s?.id !== 'string' || !s.id || s.archived || this.roomState.value?.archivedSessions?.includes(s.id) || !Array.isArray(s.messages)) continue;
      let spaces; try { spaces = roomIds(s).filter(id => !this.roomState.metadata(id).archived); } catch { continue; }
      if (!spaces.length) continue;
      for (let index = 0; index < s.messages.length; index++) {
        const message = s.messages[index];
        if (!Number.isSafeInteger(message?.time) || message.time < this.humanSince || message.time > now ||
            message.role !== 'user' || message.agentControl || typeof message.id !== 'string' || !message.id) continue;
        const human = ['human', 'human-mobile'].includes(message.origin) && message.inputSource === undefined ||
          message.origin === 'native' && message.inputSource === 'user';
        if (!human || automaticInput(message)) continue;
        const eventId = `human-input:${hash([s.id, message.id])}`;
        if (this.humanInputs.has(eventId)) continue;
        const designated = steward?.();
        if (!designated?.sessionId || s.id === designated.sessionId) continue;
        if (typeof message.text !== 'string' || !message.text.trim()) continue;
        const payload = { memberId: s.id, reason: 'human-message', title: new Date(message.time).toISOString(),
          text: Array.from(message.text.slice(0, 401)).slice(0, 200).join(''), ...this.humanInputTask(s, message, spaces, index) };
        const memberName = clipped(name(s), 200); if (memberName) payload.memberName = memberName;
        const event = { eventId, sourceRef: `human-input:${s.id}`, kind: 'blocked', payload };
        try { validateEvent(event); }
        catch { delete payload.text; delete payload.memberName; payload.reason = 'human-message-content-unavailable'; }
        this.record(event); this.humanInputs.add(eventId);
      }
    }
  }
  // One refused workspace_control call of the designated butler, so NAW wakes it (steward-wake.cjs REFUSAL_WAKES).
  // Only the reason code is kept, never the call's arguments. `occurrence` tells one refusal from another.
  controlRefused(memberId, nativeId, occurrence, code) {
    if (![memberId, nativeId].every(v => typeof v === 'string' && v) || occurrence === undefined || !/^[a-z0-9-]{1,80}$/.test(code)) return false;
    const eventId = `control-refused:${hash([memberId, nativeId, occurrence])}`;
    if (this.controlRefusals.has(eventId)) return false;
    this.record({ eventId, sourceRef: `control-refused:${memberId}`, kind: 'blocked', payload: { memberId, reason: 'control-refused', outcome: code } });
    this.controlRefusals.add(eventId);
    return true;
  }
  // One workspace_control call NAW answered (main.cjs control): 'refused' when the designated butler's call was
  // refused and is now recorded, 'succeeded' when it went through, otherwise null. A repeated answer is neither.
  controlResult(sender, args, result, { steward } = {}) {
    let current = null; try { current = steward?.(); } catch { return null; }
    if (!current || sender?.id !== current.sessionId || sender.nativeId !== current.nativeId || result?.duplicate === true) return null;
    if (['complete', 'received', 'awaiting-native'].includes(result?.state)) return 'succeeded';
    if (result?.state !== 'not-executed') return null;
    const code = /^[a-z0-9-]{1,80}$/.test(result.reason) ? result.reason : 'refused';
    return this.controlRefused(sender.id, sender.nativeId, ['gui', args?.operation_id ?? null, this.now()], code) ? 'refused' : null;
  }
  // A Claude butler's own plugin refuses some calls before NAW sees them (claude-bridge register.js); its backend
  // counts them on the session (workspace.cjs controlRefusal).
  observeControlRefusals(sessions = [], { steward } = {}) {
    let current = null; try { current = steward?.(); } catch { return; }
    if (!current) return;
    for (const s of Array.isArray(sessions) ? sessions : []) {
      const r = s?.controlRefusal;
      if (s?.id !== current.sessionId || s.nativeId !== current.nativeId || !r || !Number.isSafeInteger(r.count) || !Number.isSafeInteger(r.at)) continue;
      this.controlRefused(s.id, s.nativeId, ['plugin', r.at, r.count], r.reason);
    }
  }
  // R119: an automatic message to the designated butler that did not go out, so NAW wakes the butler (the ordinary
  // stewardWake path). Only the sender, the outcome with its code, and the time; never the message. Rows come from any
  // backend; a refusal before its row existed only from a backend that keeps `wakeUndelivered` (session-wake.cjs).
  // Only failures since this intake started: the history before it is not announced again.
  // `formerly(id)`: the sessions the butler continued from (done rotations); one to those is the current butler's too.
  observeWakeUndelivered(sessions = [], { steward, formerly } = {}) {
    let current = null; try { current = steward?.(); } catch { return; }
    if (typeof current?.sessionId !== 'string' || !current.sessionId) return;
    let earlier = []; try { earlier = formerly?.(current.sessionId) || []; } catch { /* The current session alone. */ }
    const butler = new Set([current.sessionId, ...(Array.isArray(earlier) ? earlier : []).filter(id => typeof id === 'string' && id)]);
    for (const s of Array.isArray(sessions) ? sessions : []) {
      if (typeof s?.id !== 'string' || !s.id || butler.has(s.id)) continue;
      for (const row of Array.isArray(s.messages) ? s.messages : []) {
        const failed = undeliveredRow(row);
        if (failed && butler.has(row.wake.recipientId) && row.wake.senderId === s.id) this.undeliveredWake(s.id, row.id, failed);
      }
      for (const entry of Array.isArray(s.wakeUndelivered) ? s.wakeUndelivered : []) {
        if (!butler.has(entry?.recipientId)) continue;
        const code = isCode(entry.sourceIssue) ? entry.sourceIssue : keyCode(entry.key);
        this.undeliveredWake(s.id, entry.id, { outcome: 'not-sent', code, at: entry.at });
      }
    }
  }
  undeliveredWake(memberId, id, { outcome, code, at }) {
    if (typeof id !== 'string' || !id || !Number.isSafeInteger(at) || at < this.humanSince) return false;
    const eventId = `wake-undelivered:${hash([memberId, id])}`;
    if (this.undeliveredWakes.has(eventId)) return false;
    this.record({ eventId, sourceRef: `wake-undelivered:${memberId}`, kind: 'blocked',
      payload: { memberId, reason: 'wake-undelivered', outcome: `${outcome}:${code}`, title: new Date(at).toISOString() } });
    this.undeliveredWakes.add(eventId);
    return true;
  }
  // A live Claude session got input but its plugin never bound NAW (adapters.cjs watchUnbound): its NAW tools are
  // refused and its backend sees no turn. One failure event per occurrence, so NAW wakes the butler.
  observeUnbound(sessions = []) {
    for (const s of Array.isArray(sessions) ? sessions : []) {
      const u = s?.nativeUnbound;
      if (!u || s.archived || typeof s.id !== 'string' || !s.id || typeof s.nativeId !== 'string' || !s.nativeId ||
          u.nativeId !== s.nativeId || !Number.isSafeInteger(u.at)) continue;
      const eventId = `native-unbound:${hash([s.id, s.nativeId, u.at])}`;
      if (this.unbound.has(eventId)) continue;
      this.record({ eventId, sourceRef: `native-unbound:${s.id}`, kind: 'failure', payload: { memberId: s.id, reason: 'native-unbound' } });
      this.unbound.add(eventId);
    }
  }
  // A session due for rotation an hour and still not rotated (queue-dispatch.cjs noteRotationStalls): one line per
  // native session, reason and gate, kept across restarts by its id.
  rotationStalled({ memberId, nativeId, reason, gate, since }) {
    if (!Number.isSafeInteger(since)) return false;
    const eventId = `rotation-stalled:${hash([memberId, nativeId, reason, gate])}`;
    if (this.rotationStalls.has(eventId)) return false;
    this.record({ eventId, sourceRef: `rotation-stalled:${memberId}`, kind: 'blocked',
      payload: { memberId, reason: 'rotation-stalled', outcome: `${reason}:${gate}`, title: new Date(since).toISOString() } });
    this.rotationStalls.add(eventId);
    return true;
  }
  // The backend validates the live failed turn; intake never settles or replays its task.
  observeRecoveryFailures(sessions = []) {
    for (const s of Array.isArray(sessions) ? sessions : []) {
      const quota = codexQuotaBlock(s);
      if (quota && typeof s.id === 'string' && s.id && !s.archived) {
        this.record(quotaSource(s.id, quota));
      }
      const r = s?.capacityRecovery, reason = Object.hasOwn(recoveryFailureReasons, r?.reason) ? recoveryFailureReasons[r.reason] : null;
      if (!reason || !(s?.provider === 'claude' && r.reason !== 'routing' || s?.provider === 'codex' && ['capacity', 'routing'].includes(r.reason)) ||
          s.state !== 'error' && !(s.provider === 'codex' && s.state === 'idle') || s.archived || s.backendUnavailable || s.transportDisconnected || s.nativeContextPending ||
          s.liveDraft || s.pendingTag || s.activeTurnId || s.approval || s.approvalOverflow || s.claudeQuestion || s.nativeApproval || s.nativeInputRequired ||
          (s.provider === 'claude' && !s.terminalState?.alive || s.terminalState?.alive === false) ||
          typeof s.id !== 'string' || !s.id || typeof s.nativeId !== 'string' || !s.nativeId ||
          r.status !== 'exhausted' || r.attempt !== 3 || r.due !== 0 || r.nativeId !== s.nativeId || typeof r.turnId !== 'string' || !r.turnId) continue;
      const identity = hash([s.id, s.nativeId, r.turnId]);
      if (this.recoveryFailures.has(identity)) continue;
      this.record({ eventId: `recovery-exhausted:${identity}`, sourceRef: `recovery-exhausted:${s.id}`, kind: 'failure', payload: { memberId: s.id, reason } });
      this.recoveryFailures.add(identity);
    }
  }
  // Terminal titles only, explicitly requested for stewardEvents. No transcript or model call.
  observeTerminalDialogs(sessions = []) {
    for (const session of sessions) {
      const current = session.nativeTerminalDialog, previous = this.terminalDialogs.get(session.id);
      // A disconnected or older backend cannot prove the choice disappeared.
      if (!current && previous && (!Object.hasOwn(session, 'nativeTerminalDialog') || !session.terminalState?.alive || session.backendUnavailable || session.transportDisconnected || ['ended', 'recoverable', 'disconnected', 'background'].includes(session.state))) continue;
      const identity = current ? hash([session.id, session.nativeId, current.since, current.title]) : null;
      if (identity === previous?.identity || !identity && !previous) continue;
      const episode = identity || previous.identity;
      const sourceRef = `terminal-dialog:${session.id}`;
      const payload = { memberId: session.id, reason: current ? 'native-terminal-dialog' : 'native-terminal-dialog-ended' };
      if (clipped(session.name, 200)) payload.memberName = clipped(session.name, 200);
      if (current) payload.title = current.title;
      try { validateEvent({ eventId: 'terminal-dialog-check', sourceRef, kind: current ? 'blocked' : 'recovery', payload }); }
      catch { delete payload.title; delete payload.memberName; }
      this.record({ eventId: `terminal-dialog:${episode}:${current ? 'open' : 'ended'}`, sourceRef, kind: current ? 'blocked' : 'recovery', payload });
      if (current) this.terminalDialogs.set(session.id, { identity }); else this.terminalDialogs.delete(session.id);
    }
  }
  // Codex questions that do not block their turn (isBlocking false), read from the same state as 「等你」: the first
  // question's header and text, requested for stewardEvents (11-15). No transcript or model call. A question ends
  // when it is answered, when native drops it, or when NAW can no longer answer it: ending the session, losing its
  // transport or its backend clears the session's requests (workspace.cjs), so that is recorded as ended too, unlike
  // a terminal dialog that may still be on the native screen. A session missing from the state proves nothing.
  observeNativeQuestions(sessions = []) {
    const listed = new Map((Array.isArray(sessions) ? sessions : []).filter(s => typeof s?.id === 'string').map(s => [s.id, s])), open = new Map();
    for (const s of listed.values()) for (const r of Array.isArray(s.approvals) ? s.approvals : []) {
      if (!r?.pending && nonBlockingQuestion(r)) open.set(hash([s.id, s.nativeId, r.requestId, r.params.questions]), { session: s, question: r.params.questions[0] });
    }
    for (const [identity, { session, question }] of open) {
      if (this.nativeQuestions.has(identity)) continue;
      this.recordQuestion(identity, session, question);
      this.nativeQuestions.set(identity, { memberId: session.id });
    }
    for (const [identity, { memberId }] of this.nativeQuestions) {
      if (open.has(identity) || !listed.has(memberId)) continue;
      this.recordQuestion(identity, listed.get(memberId), null);
      this.nativeQuestions.delete(identity);
    }
  }
  recordQuestion(identity, session, question) {
    const sourceRef = `native-question:${session.id}`, kind = question ? 'blocked' : 'recovery';
    const payload = { memberId: session.id, reason: question ? 'native-question' : 'native-question-ended' };
    if (clipped(session.name, 200)) payload.memberName = clipped(session.name, 200);
    if (clipped(question?.header, 400)) payload.title = clipped(question.header, 400);
    if (clipped(question?.question, 2000)) payload.text = clipped(question.question, 2000);
    try { validateEvent({ eventId: 'native-question-check', sourceRef, kind, payload }); }
    catch { delete payload.title; delete payload.text; delete payload.memberName; }
    this.record({ eventId: `native-question:${identity}:${question ? 'open' : 'ended'}`, sourceRef, kind, payload });
  }
  observeQueues(states) {
    let failed = false;
    for (const value of states) {
      const scope = `queue-vacancy:${value.roomId}`;
      try {
        // Settling after an app restart is unknown, not evidence that a
        // previously recorded empty episode ended while the app was closed.
        if (!value.active && value.candidateIds?.length) continue;
        const payload = { spaceId: value.roomId };
        if (clipped(value.name, 200)) payload.spaceName = clipped(value.name, 200);
        let rejected = false;
        try { validateEvent({ eventId: 'vacancy-projection', kind: 'queue-empty', sourceRef: scope, payload }); }
        catch {
          delete payload.spaceName; rejected = true;
          validateEvent({ eventId: 'vacancy-projection', kind: 'queue-empty', sourceRef: scope, payload });
        }
        this.ledger.observeSource(scope, value.active, payload);
        if (rejected) this.errors.set(scope, 'source-rejected'); else this.errors.delete(scope);
      } catch { this.errors.set(scope, 'source-unavailable'); failed = true; }
    }
    if (failed) throw unavailable();
  }
}

function bindQueueOutcomes(roomState, ingress, notify) {
  // READY/done/no-reply facts share intake; B1 owns person-facing questions.
  // No controller or model is notified while the host remains dormant.
  roomState.onButlerReady = (roomId, eventId) => ingress?.captureOutcome(roomId, eventId);
  roomState.onQueueOutcome = outcome => {
    let receipt;
    try { receipt = ingress?.captureOutcome(outcome.roomId, outcome.eventId); }
    finally { notify(outcome, receipt); }
  };
}
module.exports = { ButlerIngress, queueOutcomeSource, storedQueueSource, bindQueueOutcomes, noReplyContext, noReplyFact };
