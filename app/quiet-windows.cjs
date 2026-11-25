'use strict';
// A quiet window before a migration (the PM's 11-23 brief, approved by the butler): when the person's migration
// setting is on and an old backend waits only for its sessions to stop and stay quiet, NAW stops starting new work
// there for a bounded time, so the running turns can end and the existing quiet rule can be met. The dispatcher
// sends that backend's sessions no new item or NAW message (queue-dispatch.cjs sessionReady 'quiet-window'), except
// the butler's wake for the person's own act (wakeSteward); a
// backend on this code holds the automatic messages its sessions send there (session-wake.cjs). Nothing running is
// interrupted and the quiet rule itself is unchanged. The window closes when the move is made or failed, when the
// setting is turned off, when the backend stops waiting only for quiet, when the person works with one of its
// sessions, when one is still at work after GRACE_MS, or at its deadline; after any of the last four NAW opens none
// for that backend for two hours, counted from the deadline when it closed early. Only NAW opens one, only for a
// migration.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const FILE = 'quiet-windows.json', MAX_BYTES = 64 * 1024, HISTORY = 50, MAX_SESSIONS = 200;
const GRACE_MS = 30 * 60 * 1000, REOPEN_MS = 2 * 60 * 60 * 1000;
// A sanity bound on what a reader accepts: GRACE_MS plus the longest quiet rule, with room.
const LONGEST_MS = 2 * 60 * 60 * 1000;
// What moveWait says when the backend waits only for its sessions: at work, or not yet quiet long enough.
const OPENING = Object.freeze(['quiet-10m', 'quiet-30m', 'busy']);
// Closes before the deadline that free its sessions only: what opens next is timed as if it had run to its deadline.
const EARLY = Object.freeze(['person', 'still-busy']);
// Closes after which NAW does not open another window for that backend for REOPEN_MS.
const COOLING = Object.freeze(['timeout', 'not-waiting', ...EARLY]);
const isCooling = (history, scope, now) => history.some(h => h.scope === scope && COOLING.includes(h.code) &&
  now < (EARLY.includes(h.code) ? h.deadline : h.closedAt) + REOPEN_MS);
const KEY = /^(\.|backends\/[a-f0-9]{20})$/u;
const ID = /^[a-f0-9-]{36}$/u;

const safeTime = value => Number.isSafeInteger(value) && value > 0;
const keyOf = scope => typeof scope === 'string' && scope.startsWith('backend:') && KEY.test(scope.slice(8)) ? scope.slice(8) : null;
function validWindow(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && ID.test(value.id) && keyOf(value.scope) &&
    value.reason === 'migration' && value.openedBy === 'naw' && OPENING.includes(value.waited) &&
    safeTime(value.openedAt) && safeTime(value.deadline) && value.deadline > value.openedAt && value.deadline - value.openedAt <= LONGEST_MS &&
    Array.isArray(value.sessions) && value.sessions.length <= MAX_SESSIONS &&
    value.sessions.every(id => typeof id === 'string' && id.length > 0 && id.length <= 100));
}
const pick = value => ({ id: value.id, scope: value.scope, reason: value.reason, openedBy: value.openedBy, openedAt: value.openedAt,
  deadline: value.deadline, waited: value.waited, sessions: [...value.sessions] });

// Open first, then judge what was opened: a link, another owner's file, one others can read or write, or one too
// large is not a record. null: no readable record.
function read(directory) {
  let fd;
  try {
    fd = fs.openSync(path.join(directory, FILE), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > MAX_BYTES) return null;
    const data = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!data || data.format !== 1 || !Array.isArray(data.windows)) return null;
    const history = Array.isArray(data.history) ? data.history : [];
    return {
      windows: data.windows.filter(validWindow).map(pick),
      history: history.filter(h => validWindow(h) && safeTime(h.closedAt) && typeof h.code === 'string' && h.code.length <= 40)
        .map(h => ({ ...pick(h), closedAt: h.closedAt, code: h.code })).slice(-HISTORY),
    };
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function write(directory, windows, history) {
  const file = path.join(directory, FILE), temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify({ format: 1, windows, history }), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}

// For a backend's own reader (session-wake.cjs): the window open now for this services.json key, or null.
function openWindow(directory, key, now = Date.now()) {
  const record = read(directory);
  if (!record) return null;
  return record.windows.find(w => w.scope === `backend:${key}` && now < w.deadline) || null;
}

class QuietWindows {
  // moveWait: queue-dispatch.cjs's, passed in so a backend's copy reads windows without the dispatcher's modules.
  constructor(directory, { now = Date.now, moveWait = null } = {}) {
    this.directory = directory; this.now = now; this.moveWait = moveWait;
    const record = read(directory) || { windows: [], history: [] };
    const at = now(), kept = [], history = [...record.history];
    // A window whose deadline passed while NAW was not running is void: it never outlives its deadline.
    for (const window of record.windows) {
      if (at < window.deadline) kept.push(window);
      else history.push({ ...window, closedAt: at, code: 'expired-at-start' });
    }
    this.windows = kept; this.history = history.slice(-HISTORY);
    if (kept.length !== record.windows.length) {
      try { write(directory, this.windows, this.history); } catch { /* Readers ignore a window past its deadline. */ }
    }
  }
  // Each session id in a window open now, with its window id.
  sessionIds(now = this.now()) {
    const ids = new Map();
    for (const window of this.windows) if (now < window.deadline) for (const id of window.sessions) ids.set(id, window.id);
    return ids;
  }
  windowOf(sessionId, now = this.now()) {
    return this.windows.find(w => now < w.deadline && w.sessions.includes(sessionId)) || null;
  }
  // For the butler (main.cjs stewardWake): each window open now and how many queued items it holds, from what the
  // dispatcher's last pass found for each item's members (`waits`, queue-dispatch.cjs planDispatch): the window alone
  // keeps it from one of them, or all of them are in it. One whose assignee left its space waits for that instead.
  holding(rooms, waits, now = this.now()) {
    const items = (rooms || []).filter(room => room && !room.archived).flatMap(room => (room.queue || []).filter(item => item.status === 'queued'));
    return this.windows.filter(w => now < w.deadline).map(w => {
      const inside = id => w.sessions.includes(id);
      const queued = items.filter(item => {
        const list = waits?.get(item.id) || (item.assignee ? [{ sessionId: item.assignee }] : []);
        return list.some(e => e.reason === 'quiet-window' && inside(e.sessionId)) || list.length > 0 && list.every(e => e.reason !== 'not-member' && inside(e.sessionId));
      });
      return { backend: keyOf(w.scope), openedAt: w.openedAt, deadline: w.deadline, sessions: [...w.sessions], queued: queued.length };
    });
  }
  cooling(scope, now = this.now()) {
    return isCooling(this.history, scope, now);
  }
  // Written first: memory follows the file, so a reader never sees a window NAW does not keep, or misses one it does.
  commit(windows, history) {
    const trimmed = history.slice(-HISTORY);
    write(this.directory, windows, trimmed);
    this.windows = windows; this.history = trimmed;
  }
  // The move of `key` ended: 'moved' or 'move-failed'. The closed window, or null.
  moved(key, code) {
    const window = this.windows.find(w => w.scope === `backend:${key}`);
    if (!window) return null;
    const closed = { ...window, closedAt: this.now(), code };
    this.commit(this.windows.filter(w => w !== window), [...this.history, closed]);
    return closed;
  }
  // One pass with the inputs of main.cjs autoBackendSwitchOnce, judged by the same rule as the move (moveWait).
  // Returns the windows it opened and closed (each closed one with its code).
  pass({ options, settings, sessions, humanAt, failed, quietMs, unprovenQuietMs }) {
    const moveWait = this.moveWait;
    if (typeof moveWait !== 'function') throw TypeError('QuietWindows needs moveWait to pass');
    const now = this.now(), migrate = Boolean(settings && settings.migrate), list = Array.isArray(options) ? options : [];
    const windows = [], closed = [], opened = [];
    const waitOf = option => moveWait(option, settings, sessions, humanAt, now, failed, quietMs, unprovenQuietMs);
    const ids = option => (option.sessions || []).map(s => s.id).filter(id => typeof id === 'string' && id.length > 0 && id.length <= 100).slice(0, MAX_SESSIONS);
    for (const window of this.windows) {
      const option = list.find(o => `backend:${o.backendKey}` === window.scope);
      let code = null;
      if (!migrate) code = 'migrate-off';
      else if (!option) code = 'gone';
      else {
        const wait = waitOf(option);
        // Movable now: the move runs in this same pass and closes it.
        if (wait && now >= window.deadline) code = 'timeout';
        else if (wait && !OPENING.includes(wait.code)) code = 'not-waiting';
        // It holds neither the person's own turns nor one that outlasted the grace for running turns (11-24: five of
        // eleven windows ran to their deadline for nothing, 281 minutes).
        else if (wait?.code === 'busy' && wait.ids.some(id => humanAt.get(id) > window.openedAt)) code = 'person';
        else if (wait?.code === 'busy' && now >= window.openedAt + GRACE_MS) code = 'still-busy';
        else { windows.push({ ...window, sessions: ids(option) }); continue; }
      }
      closed.push({ ...window, closedAt: now, code });
    }
    const history = [...this.history, ...closed];
    // A window closed early keeps its place until its deadline while its backend still waits, so no window opens sooner
    // than if it had run on: windows at other times would meet other turns, and held again what it freed.
    const placed = history.some(h => EARLY.includes(h.code) && now < h.deadline && list.some(o => {
      const wait = `backend:${o.backendKey}` === h.scope ? waitOf(o) : undefined;
      return wait === null || OPENING.includes(wait?.code);
    }));
    if (migrate && !windows.length && !placed) {
      for (const option of list) {
        const scope = `backend:${option.backendKey}`;
        if (!KEY.test(String(option.backendKey)) || failed.has(option.backendKey) || isCooling(history, scope, now)) continue;
        const wait = waitOf(option);
        if (!wait || !OPENING.includes(wait.code)) continue;
        // At work, a session may need the longer rule once it stops: the window allows for it.
        const term = wait.code === 'quiet-10m' ? quietMs : Math.max(quietMs, unprovenQuietMs);
        const window = { id: randomUUID(), scope, reason: 'migration', openedBy: 'naw', openedAt: now,
          deadline: now + GRACE_MS + Math.min(term, LONGEST_MS - GRACE_MS), waited: wait.code, sessions: ids(option) };
        windows.push(window); opened.push(window);
        break;
      }
    }
    if (closed.length || opened.length || windows.some((w, i) => w.sessions.join('\n') !== this.windows[i]?.sessions.join('\n'))) this.commit(windows, history);
    return { opened, closed };
  }
}

module.exports = Object.freeze({ QuietWindows, openWindow, read, FILE, GRACE_MS, REOPEN_MS, LONGEST_MS, OPENING });
