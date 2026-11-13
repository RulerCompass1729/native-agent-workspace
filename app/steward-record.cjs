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
const { AsyncLocalStorage } = require('node:async_hooks');
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
// Outcomes NAW may still settle later; any other outcome is final as recorded.
const OPEN = Object.freeze(['confirmation-required', 'awaiting-native', 'running']);

// What a line may hold. A step: who, what was asked (method and a bounded copy of its arguments), its operation id.
// An outcome: the step it ends, the state and reason NAW answered, a bounded error. A role line: who became or stopped
// being the butler, and how.
function check(value) {
  const at = Number.isSafeInteger(value?.at) && value.at >= 0;
  const ok = !at ? false : value?.kind === 'step' ? exact(value, ['kind', 'at', 'id', 'session', 'action', 'method', 'arguments', 'operationId']) && token(value.id) && session(value.session) &&
      ['invoke', 'snapshot'].includes(value.action) && (value.method === null || token(value.method)) && (value.arguments === null || text(value.arguments, ARGUMENTS_MAX + 1)) &&
      (value.operationId === null || token(value.operationId))
    : value?.kind === 'outcome' ? exact(value, ['kind', 'at', 'step', 'state', 'reason', 'error', 'duplicate', 'operationId']) && token(value.step) && token(value.state) && (value.reason === null || token(value.reason)) &&
      (value.error === null || text(value.error, ERROR_MAX)) && typeof value.duplicate === 'boolean' && (value.operationId === null || token(value.operationId))
    : value?.kind === 'role' ? exact(value, ['kind', 'at', 'event', 'session']) && EVENTS.includes(value.event) && (value.session === null || exact(value.session, ['id', 'nativeId']) && token(value.session.id) && token(value.session.nativeId))
    : false;
  if (!ok) throw Error('Invalid steward record line');
}
// A copy of what was asked, never longer than the bound: each text cut, lists and depth limited, so the copy still
// reads as the arguments it came from. Paths (`paths`) are not kept.
function bounded(value, depth = 0, cut = 300) {
  if (typeof value === 'string') return value.length > cut ? value.slice(0, cut) + '…' : value;
  if (value === null || ['number', 'boolean'].includes(typeof value)) return value;
  if (depth >= 3 || typeof value !== 'object') return '…';
  if (Array.isArray(value)) return value.slice(0, 12).map(item => bounded(item, depth + 1, cut));
  return Object.fromEntries(Object.entries(value).slice(0, 12).map(([key, item]) => [key.slice(0, 40), bounded(item, depth + 1, cut)]));
}
function argumentsOf(args) {
  if (args.action !== 'invoke') return null;
  // Shorter texts until the copy fits; only arguments that do not fit even then are left out.
  for (const cut of [300, 80, 20]) { const copy = JSON.stringify(bounded(args.arguments ?? [], 0, cut)); if (copy.length <= ARGUMENTS_MAX) return copy; }
  return null;
}
// The state and reason NAW answered. Never a value: a snapshot's or a read's contents are not kept.
function outcomeOf(result) {
  const state = token(result?.state) ? result.state : 'unconfirmed';
  const reason = token(result?.reason) ? result.reason : token(result?.refusalSummary?.reason) ? result.refusalSummary.reason : null;
  const error = typeof result?.error === 'string' ? result.error.slice(0, ERROR_MAX) : null;
  // The same operation id and command again: NAW answered with the earlier one and ran nothing. The id NAW gave a
  // snapshot of another session (which asks the person) is kept, so its later answer can be found.
  return { state, reason, error, duplicate: result?.duplicate === true, operationId: token(result?.id) ? result.id : null };
}

class StewardRecord {
  // `steward()` names the designated butler as it is now ({ sessionId, nativeId } or null) and throws when the
  // designation cannot be read; `selected()` names the session the person designated, before any rotation.
  // `failed()` is told once when a line cannot be written while NAW runs (the bell works its reminders out again).
  constructor(dataDir, { steward, selected = () => null, now = Date.now, failed = () => {} }) {
    this.now = now; this.steward = steward; this.selected = selected; this.onFailed = failed;
    this.log = new history.BlockLog(dataDir, RECORD, check);
    this.lines = []; this.keptRoles = []; this.failed = false; this.calls = new AsyncLocalStorage();
    try { this.lines = this.log.load(); this.keptRoles = this.log.kept().filter(item => item.kind === 'role'); }
    catch (error) { this.failed = true; this.loadError = error; }
  }
  // Role lines, those in deleted blocks included (deleting keeps them without contents), oldest first.
  roles() { return [...this.keptRoles, ...this.lines.filter(value => value.kind === 'role')].sort((a, b) => a.at - b.at); }
  // The last role line's butler: who the record last said held the role.
  get recorded() { return this.roles().at(-1)?.session ?? null; }
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
    let current;
    try { current = this.steward(); }
    catch {
      // Who the butler is cannot be read: the one the record last named is not let through unrecorded.
      const last = this.recorded;
      if (last && last.id === sender?.id && last.nativeId === sender?.nativeId) throw uiError('error.steward.designationUnreadable');
      return run();
    }
    if (!current || current.sessionId !== sender?.id || current.nativeId !== sender?.nativeId) return run();
    const id = randomUUID();
    try {
      this.sync(current);
      this.append({ kind: 'step', id, session: { id: sender.id, nativeId: sender.nativeId, provider: sender.provider, name: String(sender.name ?? '').slice(0, NAME_MAX) },
        action: args.action, method: args.action === 'invoke' ? args.method : null, arguments: argumentsOf(args), operationId: args.operation_id ?? null });
    } catch { throw uiError('error.steward.recordUnavailable'); }
    let result;
    try { result = await this.calls.run({ id: sender.id, nativeId: sender.nativeId }, run); }
    catch (error) { this.finish(id, { state: 'unconfirmed', reason: null, error: String(error?.message ?? '').slice(0, ERROR_MAX) || null, duplicate: false, operationId: null }); throw error; }
    this.finish(id, outcomeOf(result));
    return result;
  }
  // Whether the call now running is one this record wrote as a step of `actor` (main.cjs lets only such a call read
  // a conversation without the person confirming it: a designation made while a call is under way does not count).
  recording(actor) {
    const call = this.calls.getStore();
    return Boolean(call && actor && call.id === actor.id && call.nativeId === actor.nativeId);
  }
  // An outcome that cannot be written leaves its step without one; the view says so, and the record stops taking new
  // steps (the next call is refused).
  finish(step, outcome) { try { this.append({ kind: 'outcome', step, ...outcome }); } catch { /* Seen as no outcome. */ } }
  // Steps with their outcomes and the role lines, oldest first. `stateOf(step)` may give a later state NAW knows of the
  // operation; it is taken only for an outcome that was still open (waiting for the person, handed over, running),
  // answered without an error, and for the same command: an id reused for another command keeps its own outcome.
  entries({ stateOf = () => null } = {}) {
    const outcomes = new Map();
    for (const value of this.lines) if (value.kind === 'outcome') outcomes.set(value.step, value);
    return this.lines.filter(value => value.kind !== 'outcome').map(value => {
      if (value.kind === 'role') return { at: value.at, kind: 'role', event: value.event, session: value.session };
      const outcome = outcomes.get(value.id) || null, operationId = value.operationId ?? outcome?.operationId ?? null;
      const open = outcome && !outcome.error && !outcome.duplicate && OPEN.includes(outcome.state) && operationId;
      let later = open ? stateOf({ ...value, operationId }) : null;
      // A snapshot NAW runs as `initial`.
      const method = value.action === 'snapshot' ? 'initial' : value.method;
      if (later && later.method !== undefined && later.method !== null && later.method !== method) later = null;
      return { at: value.at, kind: 'step', id: value.id, session: value.session, action: value.action, method: value.method, arguments: value.arguments, operationId,
        state: later?.state ?? outcome?.state ?? null, reason: later ? later.reason ?? null : outcome?.reason ?? null, error: outcome?.error ?? null, duplicate: outcome?.duplicate === true, recorded: Boolean(outcome) };
    });
  }
  // The periods each session held the role, from the role lines: for messages, which the backend keeps on the
  // sender's own conversation and not here.
  // A successor a rotation handed the role to held it from its start, before the line that noticed it.
  periods() {
    const out = [];
    for (const value of this.roles()) {
      if (out.length && out.at(-1).to === null) out.at(-1).to = value.at;
      if (value.session) out.push({ session: value.session, from: value.event === 'followed' ? 0 : value.at, to: null });
    }
    return out;
  }
  // Deleting exported blocks: only which steps they held stays, without what was asked.
  deleteBlocks(names) {
    if (this.failed) throw Error('The butler record is unavailable');
    // Role lines keep who held the role and from when, so the periods and the last butler outlive the contents.
    const deleted = this.log.delete(names, value => ({ kind: value.kind, at: value.at, ...(value.kind === 'role' ? { event: value.event, session: value.session } : {}) }), this.now());
    try { this.lines = this.log.load(); this.keptRoles = this.log.kept().filter(item => item.kind === 'role'); } catch (error) { this.failed = true; throw error; }
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
// `readOf(step)` names the conversation a read step read and how far ({ sessionId, name, messages, through, unasked }),
// from NAW's record of that operation; a step without one is said as it was asked.
function view(record, snapshot, { current = null, stateOf = () => null, readOf = () => null, limit = 300, now = Date.now() } = {}) {
  const sessions = new Map((snapshot?.sessions || []).map(s => [s.id, s])), rooms = new Map([snapshot?.room, ...(snapshot?.rooms || [])].filter(Boolean).map(r => [r.id || 'shared', r]));
  const nameOf = id => typeof id === 'string' && sessions.has(id) ? sessions.get(id).name : null;
  const spaceOf = id => typeof id === 'string' && rooms.has(id) ? rooms.get(id).name || id : null;
  const cut = value => typeof value === 'string' ? (value.length > 300 ? value.slice(0, 300) + '…' : value) : null;
  const entries = record.entries({ stateOf }).map(entry => {
    if (entry.kind === 'role') return { at: entry.at, kind: 'role', event: entry.event, name: entry.session ? nameOf(entry.session.id) || entry.session.id.slice(0, 8) : null };
    let args = null; try { args = entry.arguments === null ? null : JSON.parse(entry.arguments); } catch { args = null; }
    const out = { at: entry.at, kind: entry.action === 'snapshot' ? 'snapshot' : 'invoke', method: entry.method, state: entry.state, reason: entry.reason, error: cut(entry.error), duplicate: entry.duplicate, recorded: entry.recorded };
    if (entry.method === 'spaceAction' && Array.isArray(args)) {
      Object.assign(out, { space: spaceOf(args[0]) || (typeof args[0] === 'string' ? args[0] : null), spaceAction: typeof args[1] === 'string' ? args[1].slice(0, 40) : null });
      if (args[1] === 'queueAdd' && Array.isArray(args[2])) Object.assign(out, { text: cut(args[2][0]), target: nameOf(args[2][1]) });
    } else if (Array.isArray(args)) out.target = nameOf(args[0]);
    // A read of another session's conversation (a snapshot NAW ran as `initial`, or one of its images): whom it read,
    // from what NAW actually ran rather than what was asked, and how far.
    if (entry.action === 'snapshot' || ['initial', 'previewImage'].includes(entry.method)) {
      let read = null; try { read = entry.operationId ? readOf(entry) : null; } catch { read = null; }
      if (read?.gone === true) { out.read = { gone: true, image: entry.method === 'previewImage' }; delete out.target; }
      else if (read && typeof read.sessionId === 'string' && read.sessionId) {
        out.read = { target: nameOf(read.sessionId) || (typeof read.name === 'string' ? read.name : null) || read.sessionId.slice(0, 8), image: entry.method === 'previewImage',
          messages: Number.isSafeInteger(read.messages) ? read.messages : null, through: Number.isSafeInteger(read.through) ? read.through : null, unasked: read.unasked === true };
        delete out.target;
      }
    }
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
    total: entries.length, entries: entries.slice(0, limit), at: now, writeFailed: record.failed && !record.loadError };
}

module.exports = Object.freeze({ RECORD, ARGUMENTS_MAX, check, argumentsOf, outcomeOf, StewardRecord, cachedSteward, view });
