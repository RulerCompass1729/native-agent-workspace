'use strict';
// The integration handoff backlog (B6, E2b): what NAW remembers about delivered work (READY)
// until the person's designated integrator has dealt with it.
//
// This module only records and decides. It sends nothing, merges nothing, takes no lock,
// starts no timer and calls no model: every effect is returned as data for a caller to carry out.
// It is not connected to the app yet.
//
// A delivery is either deliverable or held. A held one carries its reason and becomes
// deliverable again only when that reason changes or the person says "retry"; no tick, new
// delivery or other event brings it back. One handoff is open at a time.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { validReady, sessionReady, shortText, IDLE_SETTLE_MS, HUMAN_QUIET_MS, NOT_SENT_ATTEMPTS } = require('./queue-dispatch.cjs');

const FILE = 'integration-handoffs.json';
const FILE_LIMIT = 4 * 1024 * 1024;
const OPEN_LIMIT = 500;       // deliveries still waiting for an outcome
const CLOSED_KEPT = 200;      // merged, returned and superseded ones kept for the record
const AGED_MS = 4 * 60 * 60 * 1000;
const MARKER = '【NAW 集成交接】';
const OPEN_STATES = ['deliverable', 'held', 'handed'];
const STATES = [...OPEN_STATES, 'merged', 'returned', 'superseded'];
// Reasons that exist once for the whole backlog, and those that exist once per subject.
const GLOBAL_REASONS = ['review-off', 'review-cap', 'checkpoint-invalid', 'merge-unverified', 'send-unconfirmed',
  'record-missing', 'send-refused', 'no-result', 'integrator-unset'];
const SUBJECT_REASONS = ['lock-held', 'integrator-missing', 'conflict', 'returned-limit'];
// Telling the person about a reason: not tried yet, started, or done. A notice that was
// started but never confirmed (a crash in between) is left unknown and is not sent again.
const NOTICE_STATES = ['pending', 'reserved', 'done'];

function fail(message) { const error = new Error(message); error.code = 'HANDOFF_STATE'; return error; }
const plain = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value);
const optional = (value, limit) => value === undefined || value === null || value === '' ? '' : plain(value, limit) ? value : null;
const sha = value => typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
const identity = value => value && typeof value === 'object' && !Array.isArray(value) && plain(value.sessionId, 100) && plain(value.nativeId, 100)
  ? { sessionId: value.sessionId, nativeId: value.nativeId } : null;

// A reason key is a known kind, or a known per-subject kind followed by its subject.
function reasonKey(value) {
  if (!plain(value, 300)) return null;
  if (GLOBAL_REASONS.includes(value)) return value;
  const split = value.indexOf(':');
  return split > 0 && SUBJECT_REASONS.includes(value.slice(0, split)) && value.length > split + 1 ? value : null;
}

function empty() { return { version: 1, seq: 0, ready: [], handoff: null, reasons: {}, refusals: 0 }; }

function checkEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !plain(entry.key, 300) || !plain(entry.roomId, 100) || !plain(entry.itemId, 100) ||
      !validReady({ branch: entry.branch, commit: entry.commit }) || !STATES.includes(entry.state) || !Number.isFinite(entry.notedAt) ||
      optional(entry.memberId, 100) === null || optional(entry.memberName, 200) === null || optional(entry.spaceName, 200) === null || optional(entry.text, 200) === null ||
      (entry.state === 'held') !== (reasonKey(entry.reason) !== null) || (entry.state !== 'held' && entry.reason !== undefined)) throw fail('Invalid delivery record');
}
function checkState(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.version !== 1 || !Number.isSafeInteger(data.seq) || data.seq < 0 ||
      !Array.isArray(data.ready) || !data.reasons || typeof data.reasons !== 'object' || Array.isArray(data.reasons) ||
      !Number.isSafeInteger(data.refusals) || data.refusals < 0) throw fail('Invalid handoff record');
  const keys = new Set();
  for (const entry of data.ready) { checkEntry(entry); if (keys.has(entry.key)) throw fail('Duplicate delivery record'); keys.add(entry.key); }
  const handed = data.ready.filter(entry => entry.state === 'handed').map(entry => entry.key);
  const handoff = data.handoff;
  if (handoff === null) { if (handed.length) throw fail('A handed delivery has no handoff'); }
  else if (!handoff || typeof handoff !== 'object' || !plain(handoff.id, 100) || !['sent', 'waiting'].includes(handoff.status) || !identity(handoff.integrator) ||
      !sha(handoff.mainHead) || !Number.isFinite(handoff.sentAt) || !(handoff.tag === null || plain(handoff.tag, 200)) ||
      !Array.isArray(handoff.keys) || !handoff.keys.length || handoff.keys.length !== handed.length || handoff.keys.some(key => !handed.includes(key))) throw fail('Invalid open handoff');
  for (const [key, reason] of Object.entries(data.reasons)) {
    if (reasonKey(key) === null || !reason || typeof reason !== 'object' || typeof reason.open !== 'boolean' || !NOTICE_STATES.includes(reason.notice) ||
        !Number.isFinite(reason.firstAt)) throw fail('Invalid reason record');
  }
  return data;
}

function readPrivate(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > FILE_LIMIT) throw fail('Unsafe handoff record');
  return fs.readFileSync(file, 'utf8');
}

// The message a handoff carries. It starts with its own marker, never the queue's: the
// integrator stays outside queue spaces and its work is not a queue item.
function handoffText(handoffId, entries, checkpoint = '') {
  const lines = [`${MARKER}${handoffId}：下面 ${entries.length} 个 READY 等你集成。`, ''];
  entries.forEach((entry, index) => {
    lines.push(`${index + 1}. ${entry.branch} ${entry.commit}　交活人：${entry.memberName || '未记录'}　空间：「${entry.spaceName || entry.roomId}」　任务：${entry.text || '未记录'}`);
  });
  lines.push('', `上次独审的检查点：${checkpoint || '没有记录'}`, '',
    '照仓库 CLAUDE.md 的集成规则做：在你自己的 worktree 里合到当前 main 之上、跑全量、按风险门独审、扫描；只有把 main 快进的那一步用 scripts/integrator-lock.cjs run 拿锁。不装机，不推送。',
    '', '做完后每个 READY 回一行，用它自己的提交号：',
    'MERGED <READY 的提交号> as <main 上的提交号> tests <通过数/总数>（独审过再加 review <审查号>）',
    'RETURNED <READY 的提交号> <原因>',
    'HELD <READY 的提交号> <原因>',
    '只有多人冲突要用户定的时候，回复的第一行写「需要你决定：」。');
  return lines.join('\n');
}

// What may happen next, from the stored state and what the caller observes. Pure: it changes nothing.
// Returns { kind: 'open', handoffId, keys, text, mainHead, integrator }, { kind: 'ask-integrator', reason }
// or { kind: 'none', why }.
function plan(state, input = {}) {
  const none = why => ({ kind: 'none', why });
  if (state.handoff) return none('handoff-open');
  const deliverable = state.ready.filter(entry => entry.state === 'deliverable');
  if (!deliverable.length) return none('nothing-deliverable');
  const integrator = identity(input.integrator);
  if (!integrator) return state.reasons['integrator-unset']?.open ? none('integrator-asked') : { kind: 'ask-integrator', reason: 'integrator-unset' };
  const session = input.session;
  const verdict = sessionReady(session, input.wakePolicy);
  if (!session || session.archived || session.id !== integrator.sessionId || session.nativeId !== integrator.nativeId) {
    // Only a complete session list can say the designated session is gone.
    if (input.complete !== true) return none('sessions-incomplete');
    const reason = `integrator-missing:${integrator.sessionId}`;
    return state.reasons[reason]?.open ? none('integrator-asked') : { kind: 'ask-integrator', reason };
  }
  if (!verdict.ready) return none(verdict.reason);
  // The same waits as a queue dispatch: idle for the settle time, and no recent typing by the person.
  const now = input.now, idle = input.idleSince?.get(session.id), human = input.humanAt?.get(session.id);
  if (!Number.isFinite(now) || !Number.isFinite(idle) || now - idle < (input.settleMs ?? IDLE_SETTLE_MS)) return none('not-settled');
  if (Number.isFinite(human) && now - human < (input.humanQuietMs ?? HUMAN_QUIET_MS)) return none('person-recent');
  if (!sha(input.mainHead)) return none('main-unknown');
  const keys = deliverable.map(entry => entry.key);
  const handoffId = `H${state.seq + 1}-${createHash('sha256').update(JSON.stringify([keys, input.mainHead])).digest('hex').slice(0, 8)}`;
  return { kind: 'open', handoffId, keys, mainHead: input.mainHead, integrator, text: handoffText(handoffId, deliverable, optional(input.checkpoint, 400) || '') };
}

class IntegrationHandoffs {
  constructor(directory) {
    this.file = path.join(directory, FILE);
    this.failed = false;
    this.state = empty();
    try { this.state = checkState(JSON.parse(readPrivate(this.file))); }
    catch (error) { if (error.code !== 'ENOENT') this.failed = true; }
  }
  // An unreadable record stops everything here: nothing is accepted and no handoff opens.
  usable() { if (this.failed) throw fail('The handoff record cannot be read; it is left as it is'); }
  snapshot() { this.usable(); return structuredClone(this.state); }
  commit(next) {
    checkState(next);
    const temp = `${this.file}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(next));
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, this.file);
      const directory = fs.openSync(path.dirname(this.file), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch (error) { this.failed = true; throw fail('The handoff record could not be saved'); }
    finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
    this.state = next;
  }
  draft() { this.usable(); return structuredClone(this.state); }

  // A delivery NAW recorded in a space (the READY fact of a queue item that became done).
  // The same key again changes nothing. A newer delivery of a branch replaces an older one
  // that is still waiting; one already inside the open handoff is left to that handoff.
  noteReady(fact, now = Date.now()) {
    const next = this.draft();
    const entry = { key: fact?.key, roomId: fact?.roomId, itemId: fact?.itemId, branch: fact?.branch, commit: fact?.commit, state: 'deliverable', notedAt: now };
    for (const [name, limit] of [['memberId', 100], ['memberName', 200], ['spaceName', 200]]) {
      const value = optional(fact?.[name], limit);
      if (value === null) throw fail('Invalid delivery');
      if (value) entry[name] = value;
    }
    if (fact?.text !== undefined && fact.text !== null && typeof fact.text !== 'string') throw fail('Invalid delivery');
    const text = typeof fact?.text === 'string' ? shortText(fact.text.replace(/[\u0000-\u001f\u007f\u2028\u2029]/gu, ' '), 120) : '';
    if (text) entry.text = text;
    try { checkEntry(entry); } catch { throw fail('Invalid delivery'); }
    if (next.ready.some(existing => existing.key === entry.key)) return { stored: false, why: 'known', superseded: [] };
    if (next.ready.filter(existing => OPEN_STATES.includes(existing.state)).length >= OPEN_LIMIT) return { stored: false, why: 'backlog-full', superseded: [] };
    const superseded = [];
    for (const existing of next.ready) {
      if (existing.branch === entry.branch && ['deliverable', 'held'].includes(existing.state)) {
        existing.state = 'superseded'; delete existing.reason; superseded.push(existing.key);
      }
    }
    next.ready.push(entry);
    this.trim(next);
    this.commit(next);
    return { stored: true, superseded };
  }
  trim(next) {
    const closed = next.ready.filter(entry => !OPEN_STATES.includes(entry.state));
    if (closed.length <= CLOSED_KEPT) return;
    const drop = new Set(closed.slice(0, closed.length - CLOSED_KEPT).map(entry => entry.key));
    next.ready = next.ready.filter(entry => !drop.has(entry.key));
  }

  plan(input) { this.usable(); return plan(this.state, input); }

  // Carry out a planned 'open': the deliveries are now inside this handoff. It is recorded as
  // sent before anything is sent, like a queue item, so a crash cannot send it twice.
  open(action, now = Date.now()) {
    const next = this.draft();
    if (next.handoff) {
      if (next.handoff.id === action?.handoffId) return { opened: false, why: 'known' };
      throw fail('Another handoff is open');
    }
    // The plan must still describe the backlog: exactly the deliveries that are deliverable now.
    const deliverable = next.ready.filter(entry => entry.state === 'deliverable').map(entry => entry.key);
    if (!action || action.kind !== 'open' || !plain(action.handoffId, 100) || !identity(action.integrator) || !sha(action.mainHead) ||
        !Array.isArray(action.keys) || !action.keys.length || JSON.stringify(action.keys) !== JSON.stringify(deliverable)) throw fail('This handoff no longer matches the backlog');
    for (const entry of next.ready) if (entry.state === 'deliverable') entry.state = 'handed';
    next.seq += 1;
    next.handoff = { id: action.handoffId, status: 'sent', keys: action.keys, integrator: identity(action.integrator), mainHead: action.mainHead, sentAt: now, tag: null };
    this.commit(next);
    return { opened: true };
  }
  // The send returned its record tag: the handoff is confirmed as delivered.
  confirmSent(handoffId, delivery, now = Date.now()) {
    const next = this.draft();
    if (next.handoff?.id !== handoffId || next.handoff.status !== 'sent') throw fail('No such open handoff');
    if (!plain(delivery?.tag, 200)) throw fail('Invalid delivery tag');
    if (next.handoff.tag !== null) return { confirmed: next.handoff.tag === delivery.tag };
    next.handoff.tag = delivery.tag;
    if (Number.isSafeInteger(delivery.control)) next.handoff.control = delivery.control;
    next.handoff.confirmedAt = now;
    next.refusals = 0;
    this.commit(next);
    return { confirmed: true };
  }
  // The send was refused before anything was sent (a switch went off in that moment, say).
  // That is not a handoff: the deliveries wait again. After the queue's limit of refusals in a
  // row they are held for the person instead of being tried for ever.
  sendRefused(handoffId, now = Date.now()) {
    const next = this.draft();
    if (next.handoff?.id !== handoffId || next.handoff.status !== 'sent' || next.handoff.tag !== null) throw fail('No such unsent handoff');
    const keys = next.handoff.keys;
    next.handoff = null;
    next.refusals += 1;
    const limit = next.refusals >= NOT_SENT_ATTEMPTS;
    let notify = null;
    for (const entry of next.ready) {
      if (!keys.includes(entry.key)) continue;
      entry.state = limit ? 'held' : 'deliverable';
      if (limit) entry.reason = 'send-refused';
    }
    if (limit) { next.refusals = 0; notify = this.occur(next, 'send-refused', now); }
    this.commit(next);
    return { held: limit ? keys : [], notify };
  }

  // A reason happened. The first time while it is not already open, the person is to be told
  // once; later occurrences only add to what is held under it.
  occur(next, key, now) {
    const existing = next.reasons[key];
    if (existing?.open) return null;
    next.reasons[key] = { open: true, notice: 'pending', firstAt: now };
    return { reason: key };
  }
  // The caller is about to tell the person about this reason: only a notice not tried before
  // may start. After it was shown, the caller confirms it.
  reserveNotice(reason) {
    const next = this.draft();
    const record = next.reasons[reason];
    if (!record?.open || record.notice !== 'pending') return { reserved: false };
    record.notice = 'reserved';
    this.commit(next);
    return { reserved: true };
  }
  confirmNotice(reason) {
    const next = this.draft();
    const record = next.reasons[reason];
    if (!record || record.notice !== 'reserved') return { confirmed: false };
    record.notice = 'done';
    this.commit(next);
    return { confirmed: true };
  }
  // Open reasons the person has not been told about yet (after a restart, for example).
  pendingNotices() { this.usable(); return Object.entries(this.state.reasons).filter(([, record]) => record.open && record.notice === 'pending').map(([reason]) => reason); }
  // Hold one delivery for a reason. Used when a handoff's outcome leaves it unprocessed.
  hold(key, reason, now = Date.now()) {
    const next = this.draft();
    const entry = next.ready.find(candidate => candidate.key === key);
    if (!entry || !['deliverable', 'handed'].includes(entry.state)) throw fail('This delivery cannot be held');
    if (reasonKey(reason) === null || reason === 'integrator-unset') throw fail('Unknown reason');
    if (entry.state === 'handed') {
      next.handoff.keys = next.handoff.keys.filter(candidate => candidate !== key);
      if (!next.handoff.keys.length) next.handoff = null;
    }
    entry.state = 'held'; entry.reason = reason;
    const notify = this.occur(next, reason, now);
    this.commit(next);
    return { notify };
  }
  // No integrator is designated, or the designated session is gone: ask the person once.
  askIntegrator(reason, now = Date.now()) {
    const next = this.draft();
    if (reason !== 'integrator-unset' && !(typeof reason === 'string' && reason.startsWith('integrator-missing:') && reasonKey(reason))) throw fail('Unknown reason');
    const notify = this.occur(next, reason, now);
    if (notify) this.commit(next);
    return { notify };
  }

  release(next, match, close = true) {
    const released = [];
    for (const entry of next.ready) {
      if (entry.state === 'held' && match(entry.reason)) { entry.state = 'deliverable'; delete entry.reason; released.push(entry.key); }
    }
    if (close) for (const [key, reason] of Object.entries(next.reasons)) if (reason.open && match(key)) reason.open = false;
    return released;
  }
  // The person's "retry" on one held delivery. Its reason stays open while others are held under it.
  retryReady(key) {
    const next = this.draft();
    const entry = next.ready.find(candidate => candidate.key === key);
    if (!entry || entry.state !== 'held') throw fail('This delivery is not held');
    const reason = entry.reason;
    entry.state = 'deliverable'; delete entry.reason;
    if (!next.ready.some(other => other.state === 'held' && other.reason === reason) && next.reasons[reason]) next.reasons[reason].open = false;
    this.commit(next);
    return { released: [key] };
  }
  // The person's "retry" on a reason: everything held under it may be handed again, and a new
  // occurrence of the reason counts as new.
  retryReason(reason) {
    const next = this.draft();
    if (reasonKey(reason) === null) throw fail('Unknown reason');
    const released = this.release(next, candidate => candidate === reason);
    this.commit(next);
    return { released };
  }
  // The reason itself changed. Only what was held under that reason comes back.
  // - 'review-opened': the person turned reviews on.
  // - 'review-cap-raised': the person raised the daily amount.
  // - 'review-cap-new-day': a new day began. The deliveries may be handed again, but the
  //   person's question from the day before stays open, so reaching the cap again does not ask twice.
  // - 'lock-released' with the owner whose lock was let go.
  // - 'integrator-designated': the person designated an integrator.
  reasonCleared(kind, subject) {
    const next = this.draft();
    let match, close = true;
    if (kind === 'review-opened') match = reason => reason === 'review-off';
    else if (kind === 'review-cap-raised') match = reason => reason === 'review-cap';
    else if (kind === 'review-cap-new-day') { match = reason => reason === 'review-cap'; close = false; }
    else if (kind === 'lock-released' && plain(subject, 160)) match = reason => reason === `lock-held:${subject}`;
    else if (kind === 'integrator-designated') match = reason => reason === 'integrator-unset' || reason.startsWith('integrator-missing:');
    else throw fail('Unknown change');
    const released = this.release(next, match, close);
    this.commit(next);
    return { released };
  }

  // What the person or a report can be shown.
  deliverable() { this.usable(); return structuredClone(this.state.ready.filter(entry => entry.state === 'deliverable')); }
  held() {
    this.usable();
    const reasons = new Map();
    for (const entry of this.state.ready) {
      if (entry.state !== 'held') continue;
      if (!reasons.has(entry.reason)) reasons.set(entry.reason, []);
      reasons.get(entry.reason).push(structuredClone(entry));
    }
    return [...reasons].map(([reason, entries]) => ({ reason, count: entries.length, entries }));
  }
  // Deliveries that have waited longer than four hours without an outcome.
  aged(now = Date.now(), ms = AGED_MS) {
    this.usable();
    return structuredClone(this.state.ready.filter(entry => OPEN_STATES.includes(entry.state) && now - entry.notedAt > ms));
  }
}

module.exports = { IntegrationHandoffs, plan, handoffText, reasonKey, MARKER, FILE, OPEN_LIMIT, CLOSED_KEPT, AGED_MS };
