'use strict';
// 大管家的记录: what the butler the person talks to did through NAW, under its own name (steward step 2, batch 1).
// The person, 2026-11-11 21:1x: 「我觉得你把任务放进队列这件事本身其实也需要有地方 log 下来」; 2026-11-08, of automatic
// operations: 「需要有提醒和可查的 log…需要可以追溯」; the activation checklist, item 8, taken as recommended on 2026-11-12
// (「都按推荐的来」): every step in 「大管家的记录」, visible at any time.
//
// Every workspace_control call the designated butler makes that reads or changes NAW (invoke, snapshot) gets a line
// before it runs and a line with its outcome after; a call whose first line cannot be written is refused, nothing run.
// Designating, revoking, and a rotation that hands the role on each get a line. Lines are kept whole in daily blocks
// like the other records (history/steward). A result is never kept here: what a read returned stays where the read
// rules keep it, or nowhere.
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const history = require('./record-history.cjs');
const { validate } = require('./background-control.cjs');
const { uiError } = require('./ui-errors.cjs');

const RECORD = 'steward';
const ARGUMENTS_MAX = 2000, ERROR_MAX = 300, NAME_MAX = 160;
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(value);
const text = (value, max) => typeof value === 'string' && value.length <= max;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const session = value => exact(value, ['id', 'nativeId', 'provider', 'name']) && token(value.id) && token(value.nativeId) && ['claude', 'codex'].includes(value.provider) && text(value.name, NAME_MAX);
const EVENTS = Object.freeze(['designated', 'revoked', 'followed', 'started']);

// What a line may hold. A step: who, what was asked (method and a bounded copy of its arguments), its operation id.
// An outcome: the step it ends, the state and reason NAW answered, a bounded error. A role line: who became or stopped
// being the butler, and how.
function check(value) {
  const at = Number.isSafeInteger(value?.at) && value.at >= 0;
  const ok = !at ? false : value?.kind === 'step' ? exact(value, ['kind', 'at', 'id', 'session', 'action', 'method', 'arguments', 'operationId']) && token(value.id) && session(value.session) &&
      ['invoke', 'snapshot'].includes(value.action) && (value.method === null || token(value.method)) && (value.arguments === null || text(value.arguments, ARGUMENTS_MAX + 1)) &&
      (value.operationId === null || token(value.operationId))
    : value?.kind === 'outcome' ? exact(value, ['kind', 'at', 'step', 'state', 'reason', 'error']) && token(value.step) && token(value.state) && (value.reason === null || token(value.reason)) &&
      (value.error === null || text(value.error, ERROR_MAX))
    : value?.kind === 'role' ? exact(value, ['kind', 'at', 'event', 'session']) && EVENTS.includes(value.event) && (value.session === null || exact(value.session, ['id', 'nativeId']) && token(value.session.id) && token(value.session.nativeId))
    : false;
  if (!ok) throw Error('Invalid steward record line');
}
// A copy of what was asked, never longer than the bound: each text cut, lists and depth limited, so the copy still
// reads as the arguments it came from. Paths (`paths`) are not kept.
function bounded(value, depth = 0) {
  if (typeof value === 'string') return value.length > 300 ? value.slice(0, 300) + '…' : value;
  if (value === null || ['number', 'boolean'].includes(typeof value)) return value;
  if (depth >= 3 || typeof value !== 'object') return '…';
  if (Array.isArray(value)) return value.slice(0, 12).map(item => bounded(item, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 12).map(([key, item]) => [key.slice(0, 40), bounded(item, depth + 1)]));
}
function argumentsOf(args) {
  if (args.action !== 'invoke') return null;
  const copy = JSON.stringify(bounded(args.arguments ?? []));
  return copy.length > ARGUMENTS_MAX ? null : copy;
}
// The state and reason NAW answered. Never a value: a snapshot's or a read's contents are not kept.
function outcomeOf(result) {
  const state = token(result?.state) ? result.state : 'unconfirmed';
  const reason = token(result?.reason) ? result.reason : token(result?.refusalSummary?.reason) ? result.refusalSummary.reason : null;
  const error = typeof result?.error === 'string' ? result.error.slice(0, ERROR_MAX) : null;
  return { state, reason, error };
}

class StewardRecord {
  // `steward()` names the designated butler as it is now ({ sessionId, nativeId } or null) and throws when the
  // designation cannot be read; `selected()` names the session the person designated, before any rotation.
  // `failed()` is told once when a line cannot be written while NAW runs (the bell works its reminders out again).
  constructor(dataDir, { steward, selected = () => null, now = Date.now, failed = () => {} }) {
    this.now = now; this.steward = steward; this.selected = selected; this.onFailed = failed;
    this.log = new history.BlockLog(dataDir, RECORD, check);
    this.lines = []; this.failed = false;
    try { this.lines = this.log.load(); }
    catch (error) { this.failed = true; this.loadError = error; }
  }
  // The last role line's butler: who the record last said held the role.
  get recorded() { for (let i = this.lines.length - 1; i >= 0; i--) if (this.lines[i].kind === 'role') return this.lines[i].session; return null; }
  append(fields) {
    if (this.failed) throw Error('The butler record is unavailable');
    const at = this.now(), value = { ...fields, at };
    try { this.log.append([{ time: at, value }], at); }
    catch (error) { this.failed = true; try { this.onFailed(); } catch { /* The refused call still says so. */ } throw error; }
    this.lines.push(value);
  }
  // The person designated or revoked the butler (the person-only `steward` call).
  designated(value) {
    this.append({ kind: 'role', event: value ? 'designated' : 'revoked', session: value ? { id: value.sessionId, nativeId: value.nativeId } : null });
  }
  // When the butler is not the one the record last named: a rotation handed the role on, or the record started with
  // a butler already designated (or the record could not be told at the time).
  sync(current) {
    const last = this.recorded, same = (a, b) => a?.id === b?.sessionId && a?.nativeId === b?.nativeId || !a && !b;
    if (same(last, current)) return;
    let designated = null; try { designated = this.selected(); } catch { /* Said as started. */ }
    const event = !current ? 'revoked' : designated && designated.sessionId !== current.sessionId ? 'followed' : 'started';
    this.append({ kind: 'role', event, session: current ? { id: current.sessionId, nativeId: current.nativeId } : null });
  }
  // One workspace_control call. Only the butler's invoke and snapshot calls are recorded; anything else runs as it is.
  async around(sender, input, run) {
    let args; try { args = validate(input); } catch { return run(); }
    if (!['invoke', 'snapshot'].includes(args.action)) return run();
    // A designation that cannot be read cannot say who the butler is: the call runs unrecorded, and the entry shows
    // the broken designation to the person.
    let current; try { current = this.steward(); } catch { return run(); }
    if (!current || current.sessionId !== sender?.id || current.nativeId !== sender?.nativeId) return run();
    const id = randomUUID();
    try {
      this.sync(current);
      this.append({ kind: 'step', id, session: { id: sender.id, nativeId: sender.nativeId, provider: sender.provider, name: String(sender.name ?? '').slice(0, NAME_MAX) },
        action: args.action, method: args.action === 'invoke' ? args.method : null, arguments: argumentsOf(args), operationId: args.operation_id ?? null });
    } catch { throw uiError('error.steward.recordUnavailable'); }
    let result;
    try { result = await run(); }
    catch (error) { this.finish(id, { state: 'unconfirmed', reason: null, error: String(error?.message ?? '').slice(0, ERROR_MAX) || null }); throw error; }
    this.finish(id, outcomeOf(result));
    return result;
  }
  // An outcome that cannot be written leaves its step without one; the view says so, and the record stops taking new
  // steps (the next call is refused).
  finish(step, outcome) { try { this.append({ kind: 'outcome', step, ...outcome }); } catch { /* Seen as no outcome. */ } }
  // Steps with their outcomes and the role lines, oldest first; `stateOf(step)` may give a later state NAW knows of
  // an operation (a confirmation answered, a delivery received).
  entries({ stateOf = () => null } = {}) {
    const outcomes = new Map();
    for (const value of this.lines) if (value.kind === 'outcome') outcomes.set(value.step, value);
    return this.lines.filter(value => value.kind !== 'outcome').map(value => {
      if (value.kind === 'role') return { at: value.at, kind: 'role', event: value.event, session: value.session };
      const outcome = outcomes.get(value.id) || null, later = value.operationId ? stateOf(value) : null;
      return { at: value.at, kind: 'step', id: value.id, session: value.session, action: value.action, method: value.method, arguments: value.arguments, operationId: value.operationId,
        state: later?.state ?? outcome?.state ?? null, reason: later ? later.reason ?? null : outcome?.reason ?? null, error: outcome?.error ?? null, recorded: Boolean(outcome) };
    });
  }
  // The periods each session held the role, from the role lines: for messages, which the backend keeps on the
  // sender's own conversation and not here.
  periods() {
    const out = [];
    for (const value of this.lines) {
      if (value.kind !== 'role') continue;
      if (out.length && out.at(-1).to === null) out.at(-1).to = value.at;
      if (value.session) out.push({ session: value.session, from: value.at, to: null });
    }
    return out;
  }
  // Deleting exported blocks: only which steps they held stays, without what was asked.
  deleteBlocks(names) {
    if (this.failed) throw Error('The butler record is unavailable');
    const deleted = this.log.delete(names, value => ({ kind: value.kind, at: value.at }), this.now());
    try { this.lines = this.log.load(); } catch (error) { this.failed = true; throw error; }
    return deleted;
  }
}

// The designation as it is now, read again only when its files change: `current()` reads the rotation log.
function cachedSteward(role) {
  let memo = null;
  return () => {
    const stamp = [role.file, role.logFile].map(file => { try { const s = fs.statSync(file); return `${s.ino}:${s.size}:${s.mtimeMs}`; } catch { return '-'; } }).join('|');
    if (memo && memo.stamp === stamp && memo.selected === role.selected) return memo.value;
    const value = role.current();
    memo = { stamp, selected: role.selected, value };
    return value;
  };
}

// What the person's 「大管家的记录」 shows, newest first: the butler's steps through workspace_control, its messages
// (workspace_message, which the backend keeps on the sender's own conversation, counted only while that session held
// the role), and the role lines. Names come from the current state; nothing here is a value an operation returned.
function view(record, snapshot, { current = null, stateOf = () => null, limit = 300, now = Date.now() } = {}) {
  const sessions = new Map((snapshot?.sessions || []).map(s => [s.id, s])), rooms = new Map([snapshot?.room, ...(snapshot?.rooms || [])].filter(Boolean).map(r => [r.id || 'shared', r]));
  const nameOf = id => typeof id === 'string' && sessions.has(id) ? sessions.get(id).name : null;
  const spaceOf = id => typeof id === 'string' && rooms.has(id) ? rooms.get(id).name || id : null;
  const cut = value => typeof value === 'string' ? (value.length > 300 ? value.slice(0, 300) + '…' : value) : null;
  const entries = record.entries({ stateOf }).map(entry => {
    if (entry.kind === 'role') return { at: entry.at, kind: 'role', event: entry.event, name: entry.session ? nameOf(entry.session.id) || entry.session.id.slice(0, 8) : null };
    let args = null; try { args = entry.arguments === null ? null : JSON.parse(entry.arguments); } catch { args = null; }
    const out = { at: entry.at, kind: entry.action === 'snapshot' ? 'snapshot' : 'invoke', method: entry.method, state: entry.state, reason: entry.reason, error: cut(entry.error), recorded: entry.recorded };
    if (entry.method === 'spaceAction' && Array.isArray(args)) {
      Object.assign(out, { space: spaceOf(args[0]) || (typeof args[0] === 'string' ? args[0] : null), spaceAction: typeof args[1] === 'string' ? args[1].slice(0, 40) : null });
      if (args[1] === 'queueAdd' && Array.isArray(args[2])) Object.assign(out, { text: cut(args[2][0]), target: nameOf(args[2][1]) });
    } else if (Array.isArray(args)) out.target = nameOf(args[0]);
    return out;
  });
  // Messages: the wake rows on each session while it held the role.
  for (const period of record.periods()) {
    const s = sessions.get(period.session.id);
    for (const row of s?.messages || []) {
      const wake = row.wake;
      if (!wake || wake.senderId !== period.session.id || wake.nativeId !== period.session.nativeId || !Number.isSafeInteger(wake.time) || wake.time < period.from || (period.to !== null && wake.time >= period.to)) continue;
      entries.push({ at: wake.time, kind: 'message', target: nameOf(wake.recipientId), text: cut(wake.body), state: typeof wake.status === 'string' ? wake.status : null });
    }
  }
  entries.sort((a, b) => b.at - a.at);
  const s = current && sessions.get(current.sessionId);
  return { current: s ? { id: s.id, name: s.name, provider: s.provider, usage: s.usage || null } : current ? { id: current.sessionId, name: null, provider: null, usage: null } : null,
    total: entries.length, entries: entries.slice(0, limit), at: now };
}

module.exports = Object.freeze({ RECORD, ARGUMENTS_MAX, check, argumentsOf, outcomeOf, StewardRecord, cachedSteward, view });
