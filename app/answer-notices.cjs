'use strict';
// Telling an agent what the person answered on its confirmation cards (the person, 2026-11-13 20:0x: 「我发现我每次做完
// 操作之后你没有反应,这其实也算是一个 bug」). The answer was kept only on the operation record and in the space's audit
// line; nothing told the agent that asked, and the butler's event wake does not see it (it wakes only the butler, on
// the butler's event record). What is asked (queue e4432e37): to any agent, once the person confirmed or cancelled, one
// short NAW message with the operation id, the answer and whether it was carried out, telling it to read the receipt;
// an agent at work hears it when its turn has ended; several answers go in one message; NAW only tells, it never runs
// or repeats anything for the agent.
//
// Here: what is owed to whom. BackgroundControl.decide adds an answer once its outcome is recorded; the agent reading
// that receipt itself takes it back (it knows); the queue dispatcher's pass sends what is owed to a session it finds
// ready and settled, like a queue item, under the person's automatic-message switch (queue-dispatch.cjs
// notifyAnswers). Kept in memory only: NAW restarting forgets what was not sent yet, and the receipts stay readable.
const HOLD_MS = 10 * 1000, RETRY_MS = 60 * 1000, MAX_AGE_MS = 24 * 60 * 60 * 1000, MAX_NOTICES = 200;
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(value);
const key = (sessionId, nativeId) => JSON.stringify([sessionId, nativeId]);

class AnswerNotices {
  // `holdMs`: how long after the person's latest answer to an agent its message waits for more answers (the person
  // answers several cards a few seconds apart: 2026-11-13 19:36:44, :49, :51). `retryMs`: after a send that failed.
  constructor({ now = Date.now, holdMs = HOLD_MS, retryMs = RETRY_MS, maxAgeMs = MAX_AGE_MS } = {}) {
    Object.assign(this, { now, holdMs, retryMs, maxAgeMs });
    this.owed = new Map();
  }
  // The person answered card `receipt.id` of `actor` with `decision` ('confirmed' or 'cancelled'; 'expired': not in
  // time); `receipt` is the record as decide() returned it. A later outcome of the same operation replaces the earlier one.
  add(actor, receipt, decision) {
    if (!token(actor?.id) || !token(actor?.nativeId) || !token(receipt?.id) || !['confirmed', 'cancelled', 'expired'].includes(decision)) return false;
    // A follow-up card: the person is asked again on the same operation, and only their last answer is told.
    if (receipt.state === 'confirmation-required') return false;
    const k = key(actor.id, actor.nativeId), entry = this.owed.get(k) || { sessionId: actor.id, nativeId: actor.nativeId, notices: new Map(), retryAt: 0 };
    entry.notices.set(receipt.id, { operationId: receipt.id, method: token(receipt.command?.method) ? receipt.command.method : null, decision,
      state: token(receipt.state) ? receipt.state : null, at: this.now() });
    this.owed.set(k, entry);
    this.trim();
    return true;
  }
  // The agent read this operation's receipt itself: it knows the outcome, and is not told again.
  read(actor, operationId) {
    const k = key(actor?.id, actor?.nativeId), entry = this.owed.get(k);
    if (!entry || !entry.notices.delete(operationId)) return false;
    if (!entry.notices.size) this.owed.delete(k);
    return true;
  }
  waiting() { return this.owed.size > 0; }
  // The sessions whose message may go now: the person's latest answer to it at least `holdMs` ago, and no failed send
  // within `retryMs`. The dispatcher then checks the session itself.
  due(now = this.now()) {
    const due = [];
    for (const entry of this.owed.values()) {
      const latest = Math.max(...[...entry.notices.values()].map(n => n.at));
      if (now - latest >= this.holdMs && now >= entry.retryAt) due.push({ sessionId: entry.sessionId, nativeId: entry.nativeId });
    }
    return due;
  }
  // Whether a hold ends within `windowMs` before `now`: the dispatcher runs a pass then rather than at its next full one.
  endingSoon(now, windowMs) {
    for (const entry of this.owed.values()) {
      const end = Math.max(...[...entry.notices.values()].map(n => n.at)) + this.holdMs;
      if (now >= end && now - end <= windowMs) return true;
    }
    return false;
  }
  // What is owed to that session now, oldest answer first.
  take(target) {
    const entry = this.owed.get(key(target.sessionId, target.nativeId));
    return entry ? [...entry.notices.values()].sort((a, b) => a.at - b.at) : [];
  }
  // Sent: those answers are told. One added while the send was on its way stays owed.
  sent(target, notices) {
    const k = key(target.sessionId, target.nativeId), entry = this.owed.get(k);
    if (!entry) return;
    for (const n of notices) if (entry.notices.get(n.operationId) === n) entry.notices.delete(n.operationId);
    if (!entry.notices.size) this.owed.delete(k);
  }
  // Not sent, or not known to have arrived: tried again after `retryMs` (a message that may have arrived can come twice;
  // the receipt it points to is the same).
  failed(target) {
    const entry = this.owed.get(key(target.sessionId, target.nativeId));
    if (entry) entry.retryAt = this.now() + this.retryMs;
  }
  // Nobody is left to tell: the session is archived, or now runs another native conversation. A session missing from the
  // list (its backend away for a moment) keeps what it is owed until `maxAgeMs`.
  prune(sessions, now = this.now()) {
    const listed = new Map((Array.isArray(sessions) ? sessions : []).map(s => [s?.id, s]));
    for (const [k, entry] of this.owed) {
      const session = listed.get(entry.sessionId);
      for (const [id, n] of entry.notices) if (now - n.at > this.maxAgeMs) entry.notices.delete(id);
      if (!entry.notices.size || session && (session.archived || session.nativeId !== entry.nativeId)) this.owed.delete(k);
    }
  }
  // At most MAX_NOTICES answers in all: the oldest go first.
  trim() {
    const all = [...this.owed.values()].flatMap(entry => [...entry.notices.values()].map(n => [entry, n])).sort((a, b) => a[1].at - b[1].at);
    for (const [entry, n] of all.slice(0, Math.max(0, all.length - MAX_NOTICES))) {
      entry.notices.delete(n.operationId);
      if (!entry.notices.size) this.owed.delete(key(entry.sessionId, entry.nativeId));
    }
  }
}

// The message: which operations, what the person answered, what NAW recorded, and where to read the rest. In the
// language of NAW's other automatic messages to agents (steward-wake.cjs wakeText).
function noticeText(notices) {
  const lines = notices.map(n => `- ${n.operationId}${n.method ? `（${n.method}）` : ''}：${{ cancelled: '人点了取消', expired: '人没在时限内答复，卡已过期，没执行' }[n.decision] || '人点了确认'}，回执状态 ${n.state || 'unknown'}`);
  return `【NAW 确认结果】你在等人答复的操作有了结果：\n${lines.join('\n')}\n用 workspace_control 的 receipt 读回执再决定下一步。NAW 只通知，不替你重发或续做。`;
}

module.exports = Object.freeze({ AnswerNotices, noticeText, HOLD_MS, RETRY_MS, MAX_AGE_MS, MAX_NOTICES });
