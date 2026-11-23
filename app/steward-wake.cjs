'use strict';
// Waking the designated butler when NAW has recorded something new (the person, 2026-11-09: 「我希望 NAW 自己可以监控
// 自己的 agent，并通过自带的 agent（aka 大管家）来进行汇报」). Decided on the task board by the butler then designated,
// 2026-11-13 01:20:41: 「事件来时唤醒大管家，我定了：做，默认关」, on five conditions, each kept here or in the
// dispatcher's pass that runs it (queue-dispatch.cjs wakeSteward):
// (1) the message carries only a position: the butler reads stewardEvents from it itself (main.cjs);
// (2) a butler at work is not called; once it is idle (the same readiness, idle settling and quiet after the person as a
//     member before its next queue item), one message covers everything recorded since;
// (3) two wakes are at least a minute apart, the limit of NAW's other automatic messages (session-wake.cjs COOLDOWN);
//     an attempt that failed counts too, so a send that keeps failing is tried once a minute at most;
// (4) a butler running on DeepSeek is never called, nor one whose model NAW does not know;
// (5) every wake is a line in 「大管家的记录」 under NAW's name, written before the message is sent: a wake whose line
//     cannot be written is not sent.
// The switch is the person's and the designated butler's alone (main.cjs stewardWake), off by default. It holds for the
// designation it was turned on for: designating or revoking the butler, the same session again included, turns it off
// (main.cjs steward), and it is not on for a session other than the one designated. Nothing here calls a model: a wake is one NAW
// message into the butler's own conversation, under the person's automatic-message switch, like a queue item.
// Patrol while idle (R120, PM brief 2026-11-23): with the switch on and an interval set, a butler idle that long while
// work is unfinished gets one 【NAW 巡查】 with counts only, through the same checks and record as a wake. With nothing
// changed since the last patrol the interval doubles, up to PATROL_MAX; off with the switch.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const FILE = 'steward-wake.json', RECORD_MAX = 4096, GAP_MS = 60 * 1000;
const STALL_MS = 10 * 60 * 1000, MAX_BLOCK_RECORDS = 16;
// The person, 2026-11-23: 「如果我不理你的话感觉就卡在这里了」. A refused butler call is recorded as an event
// (butler-ingress.cjs controlRefused) so the butler is woken; wakes that only announce refusals stop after this many
// in a row, until one of its calls succeeds, so a call refused every time cannot keep waking it.
const REFUSAL_WAKES = 3, REFUSED = 'control-refused';
const PATROL_CHOICES = Object.freeze([null, 15, 30, 60]), PATROL_MAX = 240;
const BLOCK_REASONS = Object.freeze(['identity-unavailable','in-space','not-settled','engaged','identity-changed','model-unknown','model-excluded','cooldown',
  'source-unavailable','record-unavailable','send-not-sent','send-unconfirmed','state-unavailable','missing','archived','backend-update-needed',
  'automatic-messages-off','paused','waiting-provider','usage-limit-exceeded','rotation-control-unresolved','native-terminal-dialog','not-idle','busy',
  'unavailable','background-unconfirmed','background-work','person-typing','native-goal-active','team-running','person-recent','trust-unknown','trust-hold',
  'control-refused-limit']);
// A position of the event record (butler-ledger.cjs eventsAfter): `<origin>:<sequence>`.
const POSITION = /^([0-9a-f]{16}):(0|[1-9][0-9]{0,15})$/u;
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 100 && !/[\u0000-\u001f\u007f]/u.test(value);
const identity = value => Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === 'nativeId,sessionId' &&
  validId(value.sessionId) && validId(value.nativeId));
const same = (a, b) => Boolean(a && b && a.sessionId === b.sessionId && a.nativeId === b.nativeId);
function parse(position) {
  const match = typeof position === 'string' ? POSITION.exec(position) : null;
  const sequence = match ? Number(match[2]) : NaN;
  return match && Number.isSafeInteger(sequence) ? { origin: match[1], sequence } : null;
}
// Whether the record's newest position `latest` names an event after `woken`, the position the last wake moved to.
// A position of another record (the record was replaced) counts every event of this one as new.
function newer(latest, woken) {
  const now = parse(latest), last = parse(woken);
  if (!now) return false;
  return last && last.origin === now.origin ? now.sequence > last.sequence : now.sequence > 0;
}
// The position a wake names: `woken` when it is of the same record as `latest`, otherwise null (from the start), so
// nothing recorded is skipped.
function from(latest, woken) {
  const now = parse(latest), last = parse(woken);
  return now && last && last.origin === now.origin ? woken : null;
}
// What the butler is sent: the position and how to read from it, nothing of what was recorded (condition 1).
function wakeText(position) {
  return `【NAW 事件】有新事件。用 workspace_control 调 stewardEvents，参数 [${JSON.stringify(position)}]；more 为 true 时从 through 接着读。`;
}
// Counts only: no session, space or item is named.
function patrolText(minutes, sessions, items) {
  return `【NAW 巡查】大管家空闲 ${minutes} 分钟，还有 ${sessions + items} 件没结的活（${sessions} 个会话在跑或等批准，${items} 件在队列里）。用 workspace_control snapshot 看。`;
}
const count = n => Number.isSafeInteger(n) && n >= 0;
function valid(data) {
  return Boolean(data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).sort().join(',') === 'at,designation,on,patrol,version,woken' &&
    data.version === 1 && typeof data.on === 'boolean' && (data.designation === null || identity(data.designation)) &&
    (data.woken === null || parse(data.woken) !== null) && (data.at === null || Number.isSafeInteger(data.at) && data.at >= 0) &&
    PATROL_CHOICES.includes(data.patrol) && (data.on || data.patrol === null));
}
function readPrivate(file) {
  // Open first, then judge what was opened: a link is refused and nothing can be swapped in between.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > RECORD_MAX) throw Error('Unsafe steward wake state');
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}
const fault = (message, code) => Object.assign(Error(message), { code });

class StewardWake {
  // `ledger()` gives the event record (butler-ledger.cjs) or null; `selected()` the designation as the person made it
  // ({ sessionId, nativeId } or null; a rotation keeps it); `record(line)` writes a line to 「大管家的记录」 and throws
  // when it cannot.
  constructor(directory, { ledger, selected, record, now = Date.now, gapMs = GAP_MS, changed = () => {} }) {
    this.file = path.join(directory, FILE);
    Object.assign(this, { ledger, selected, record, now, gapMs, changed });
    this.blocked = null;
    // In memory only: a restart allows the butler REFUSAL_WAKES more.
    this.refusalWakes = 0;
    // In memory: the open work's hash and the interval of the last patrol sent, and whether one is wanted this pass.
    this.patrolLast = null; this.patrolWanted = false;
    this.state = { version: 1, on: false, designation: null, woken: null, at: null, patrol: null };
    // A saved state that cannot be read is off, and says so, until the person or the butler sets it again.
    this.failed = false;
    try {
      let data = JSON.parse(readPrivate(this.file));
      // Saved before patrol existed: patrol off.
      if (data && typeof data === 'object' && !Array.isArray(data) && !Object.hasOwn(data, 'patrol')) data = { ...data, patrol: null };
      if (!valid(data)) throw Error('Invalid steward wake state');
      this.state = data;
    } catch (error) { if (error.code !== 'ENOENT') this.failed = true; }
  }
  // On, for the session designated now, with its state kept.
  active() {
    if (this.failed || !this.state.on) return false;
    let designated = null; try { designated = this.selected(); } catch { return false; }
    return same(this.state.designation, designated);
  }
  // How it stands, for the person or the butler: whether it is on, and when NAW last tried to wake the butler.
  // A held wake is said whether or not anything is due now. The person sees it after STALL_MS; `held` (the butler's
  // own read) says it at once: after the 286 install restart, the butler read none for ten minutes and took the
  // rotation block as cleared (2026-11-23 04:52Z).
  view({ held = false } = {}) {
    const on = this.active(), blocked = on && this.blocked?.reason && (this.blocked.visible || held) ? {
      since: this.blocked.since, reason: this.blocked.reason, minutes: Math.floor(Math.max(0, this.now() - this.blocked.since) / 60000),
    } : null;
    return { on, at: on ? this.state.at : null, failed: this.failed, ...(on && this.state.patrol ? { patrol: this.state.patrol } : {}), ...(blocked ? { blocked } : {}) };
  }
  clearBlocked() {
    const visible = this.blocked?.visible; this.blocked = null;
    if (visible) try { this.changed(); } catch { /* Visibility never grants a send. */ }
  }
  // An event or a patrol is waiting to go out.
  pending() { return this.due() || this.patrolWanted && this.active(); }
  skip(reason) {
    if (!this.pending()) { this.clearBlocked(); return; }
    const now = this.now();
    if (!this.blocked || now < this.blocked.since) this.blocked = { since: now, reason: null, records: 0, recordedReason: null, visible: false, minute: -1 };
    const blocked = this.blocked, previous = blocked.reason;
    blocked.reason = BLOCK_REASONS.includes(reason) ? reason : 'state-unavailable';
    // The refusal limit is said at once: no later pass would clear it by itself.
    if (now - blocked.since < STALL_MS && blocked.reason !== 'control-refused-limit') return;
    if (blocked.records < MAX_BLOCK_RECORDS && blocked.recordedReason !== blocked.reason) {
      blocked.recordedReason = blocked.reason; blocked.records++;
      try { this.record({ kind: 'wakeBlocked', reason: blocked.reason, since: blocked.since }); }
      catch { blocked.reason = 'record-unavailable'; }
    }
    const minute = Math.floor((now - blocked.since) / 60000), changed = !blocked.visible || previous !== blocked.reason || minute !== blocked.minute;
    blocked.visible = true; blocked.minute = minute;
    if (changed) try { this.changed(); } catch { /* Retried by the next state read. */ }
  }
  latest() {
    const ledger = this.ledger();
    if (!ledger) throw fault('The event record is unavailable', 'STEWARD_WAKE_UNAVAILABLE');
    return ledger.latest();
  }
  // Turned on, it starts from what is recorded now: older events are not news. Turned on again while on, it keeps its
  // position, so nothing waiting is skipped. The time of the last wake is kept either way: turning it off and on does
  // not shorten the minute between wakes. Turned off, it also clears a switch kept for an earlier designation, so that
  // designating that session again does not turn it back on.
  set(on) {
    if (typeof on !== 'boolean') throw fault('Invalid steward wake switch', 'STEWARD_WAKE_INVALID');
    if (!this.failed && (on ? this.active() : !this.state.on)) return this.view();
    let next;
    if (on) {
      let designated = null; try { designated = this.selected(); } catch { throw fault('The designation cannot be read', 'STEWARD_WAKE_UNAVAILABLE'); }
      if (!identity(designated)) throw fault('No butler is designated', 'STEWARD_WAKE_NO_BUTLER');
      next = { version: 1, on: true, designation: { sessionId: designated.sessionId, nativeId: designated.nativeId }, woken: this.latest(), at: this.failed ? null : this.state.at, patrol: null };
    } else next = { version: 1, on: false, designation: null, woken: null, at: this.failed ? null : this.state.at, patrol: null };
    this.write(next);
    this.patrolLast = null; this.patrolWanted = false;
    if (!on) this.clearBlocked();
    return this.view();
  }
  // The patrol interval in minutes, or null for off. Only while the switch is on; off needs nothing.
  setPatrol(minutes) {
    if (!PATROL_CHOICES.includes(minutes)) throw fault('Invalid patrol interval', 'STEWARD_PATROL_INVALID');
    if (!this.active()) {
      if (minutes === null) return this.view();
      throw fault('The event wake is off', 'STEWARD_PATROL_WAKE_OFF');
    }
    if (this.state.patrol !== minutes) {
      this.write({ ...this.state, patrol: minutes });
      this.patrolLast = null; this.patrolWanted = false;
    }
    return this.view();
  }
  // Whether a patrol is due this pass: on, with an interval, `work` ({ sessions, items, hash }) unfinished, and the
  // butler idle `idleMs` for the interval, doubled for each patrol since which the work's hash is unchanged.
  // Gives the interval in minutes, or null.
  patrolDue(idleMs, work) {
    let minutes = null;
    const base = this.active() ? this.state.patrol : null;
    if (base && work && count(work.sessions) && count(work.items) && work.sessions + work.items > 0) {
      const last = this.patrolLast;
      minutes = last && last.hash === work.hash ? Math.min(last.minutes * 2, PATROL_MAX) : base;
      if (!(Number.isFinite(idleMs) && idleMs >= minutes * 60000)) minutes = null;
    }
    this.patrolWanted = minutes !== null;
    return minutes;
  }
  write(next) {
    if (!valid(next)) throw fault('Invalid steward wake state', 'STEWARD_WAKE_INVALID');
    const temp = `${this.file}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(next));
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, this.file);
      const directory = fs.openSync(path.dirname(this.file), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch {
      // What is on disk is not known now: no wake goes out until it is set again.
      this.failed = true;
      throw fault('The steward wake state cannot be saved', 'STEWARD_WAKE_UNAVAILABLE');
    } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch { /* Renamed, or never made. */ } }
    this.state = next; this.failed = false;
  }
  // For the dispatcher's question whether to keep passing: on, and something recorded after the position last named.
  // Reads no file.
  due() {
    try { return this.active() && newer(this.latest(), this.state.woken); } catch { return false; }
  }
  // Whether everything recorded after the position last named is a refused butler call. Unreadable counts as not.
  refusalsOnly(latest) {
    try {
      const { events, more } = this.ledger().eventsAfter(from(latest, this.state.woken), 100);
      return !more && events.length > 0 && events.every(e => e.kind === 'blocked' && e.payload?.reason === REFUSED);
    } catch { return false; }
  }
  // One of the butler's calls went through: refusals may wake it again.
  controlSucceeded() {
    this.refusalWakes = 0;
    if (this.blocked?.reason === 'control-refused-limit') this.clearBlocked();
  }
  // A minute since the last attempt (condition 3). A clock set back does not hold wakes off for longer.
  rested(now) { const at = this.state.at; return at === null || now < at || now - at >= this.gapMs; }
  // One wake of `session`, the butler as the dispatcher names it now (after a rotation, the successor the role followed
  // to; the switch holds for the person's designation, which a rotation keeps), found ready and settled (condition 2 is
  // the dispatcher's), whose model is `model`. `send(text, itemId)` is the dispatcher's own send of a NAW message and gives its delivery
  // tag. Gives what was done, or null when nothing was.
  async wake(session, model, send) {
    const now = this.now();
    if (!this.due()) { this.clearBlocked(); return null; }
    if (!this.rested(now)) { this.skip('cooldown'); return null; }
    if (typeof model !== 'string' || !model) { this.skip('model-unknown'); return null; }
    if (/deepseek/iu.test(model)) { this.skip('model-excluded'); return null; }
    const latest = this.latest(), position = from(latest, this.state.woken), id = randomUUID();
    const refusals = this.refusalsOnly(latest);
    if (refusals && this.refusalWakes >= REFUSAL_WAKES) { this.skip('control-refused-limit'); return null; }
    try { this.record({ kind: 'wake', id, session: { id: session.id, nativeId: session.nativeId }, position }); }
    catch { throw fault('The butler record cannot be written', 'STEWARD_WAKE_RECORD_UNAVAILABLE'); }
    let tag = null, outcome;
    try {
      tag = await send(wakeText(position), `steward-wake:${id}`);
      outcome = { state: 'sent', error: null };
    } catch (error) {
      // Refused before anything was written, or not known to have arrived: either way the position stays, so a later
      // wake names it again rather than skipping what it would have announced.
      outcome = { state: error?.notSent ? 'not-sent' : 'unconfirmed', error: String(error?.message ?? '').slice(0, 300) || null };
    }
    const next = { ...this.state, at: now, woken: outcome.state === 'sent' ? latest : this.state.woken };
    try { this.write(next); } catch { /* Failed: no further wake until it is set again. */ }
    try {
      this.record({ kind: 'outcome', step: id, state: outcome.state, reason: null, error: outcome.error, duplicate: false,
        operationId: typeof tag === 'string' && validId(tag) ? tag : null });
    } catch { /* Seen as a wake without an outcome. */ }
    if (outcome.state === 'sent') { this.clearBlocked(); if (refusals) this.refusalWakes++; }
    else this.skip(outcome.state === 'not-sent' ? 'send-not-sent' : 'send-unconfirmed');
    return { state: outcome.state, position, through: latest };
  }
  // One patrol of `session`, checked by the dispatcher as for a wake, after patrolDue gave `minutes` for `work`.
  // The same minute between messages, model exclusion and record-before-send as a wake; the event position is kept.
  async patrol(session, model, send, work, minutes) {
    const now = this.now();
    if (!this.patrolWanted || !this.active()) { this.patrolWanted = false; this.clearBlocked(); return null; }
    if (!this.rested(now)) { this.skip('cooldown'); return null; }
    if (typeof model !== 'string' || !model) { this.skip('model-unknown'); return null; }
    if (/deepseek/iu.test(model)) { this.skip('model-excluded'); return null; }
    const id = randomUUID();
    try { this.record({ kind: 'patrol', id, session: { id: session.id, nativeId: session.nativeId }, minutes, sessions: work.sessions, items: work.items }); }
    catch { throw fault('The butler record cannot be written', 'STEWARD_WAKE_RECORD_UNAVAILABLE'); }
    let tag = null, outcome;
    try {
      tag = await send(patrolText(minutes, work.sessions, work.items), `steward-patrol:${id}`);
      outcome = { state: 'sent', error: null };
    } catch (error) {
      outcome = { state: error?.notSent ? 'not-sent' : 'unconfirmed', error: String(error?.message ?? '').slice(0, 300) || null };
    }
    try { this.write({ ...this.state, at: now }); } catch { /* Failed: no further message until it is set again. */ }
    try {
      this.record({ kind: 'outcome', step: id, state: outcome.state, reason: null, error: outcome.error, duplicate: false,
        operationId: typeof tag === 'string' && validId(tag) ? tag : null });
    } catch { /* Seen as a patrol without an outcome. */ }
    if (outcome.state === 'sent') { this.patrolLast = { hash: work.hash, minutes }; this.patrolWanted = false; this.clearBlocked(); }
    else this.skip(outcome.state === 'not-sent' ? 'send-not-sent' : 'send-unconfirmed');
    return { state: outcome.state, minutes };
  }
}

module.exports = Object.freeze({ StewardWake, FILE, GAP_MS, STALL_MS, MAX_BLOCK_RECORDS, BLOCK_REASONS, REFUSAL_WAKES, REFUSED, PATROL_CHOICES, PATROL_MAX,
  wakeText, patrolText, newer, from });
