'use strict';
// The one secretary NAW used to have, retired for a project manager in each space (space-managers.cjs). Its record is
// only read, once, to make it the manager of its own space; it is never written, so an older build finds it as it was.
// The rotation log and the rules that follow it are here too, for every record that names a session.
const fs = require('node:fs');
const path = require('node:path');
const { uiError } = require('./ui-errors.cjs');

const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 100 && !/[\u0000-\u001f\u007f]/u.test(value);
function identity(value) {
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'nativeId,sessionId' || !validId(value.sessionId) || !validId(value.nativeId)) throw Error('Invalid secretary identity');
  return { sessionId: value.sessionId, nativeId: value.nativeId };
}
function readPrivate(file, limit) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > limit) throw Error('Unsafe secretary record');
  return fs.readFileSync(file, 'utf8');
}
function successor(selected, entries) {
  const edges = new Map(), parents = new Map();
  for (const entry of entries) {
    if (!['done', 'kept'].includes(entry?.event) || !validId(entry.old?.id)) continue;
    const from = entry.old.id;
    const to = JSON.stringify([entry.new?.id, entry.new?.nativeId]);
    if (!edges.has(from)) edges.set(from, new Map());
    const existing = edges.get(from).get(to);
    // A kept edge is never upgraded merely because another line says done.
    edges.get(from).set(to, { ...entry, event: existing && (existing.event === 'kept' || existing.old.nativeId !== entry.old.nativeId) ? 'kept' : entry.event });
    if (!parents.has(to)) parents.set(to, new Set());
    parents.get(to).add(from);
  }
  let current = identity(selected);
  const seen = new Set();
  while (true) {
    const key = current.sessionId;
    if (seen.has(key)) return identity(selected);
    seen.add(key);
    const next = edges.get(key);
    if (!next || next.size !== 1) return current;
    const [to, entry] = next.entries().next().value;
    if (entry.event !== 'done' || parents.get(to).size !== 1 || entry.old.nativeId !== current.nativeId || !validId(entry.new?.id) || !validId(entry.new?.nativeId)) return current;
    current = { sessionId: entry.new.id, nativeId: entry.new.nativeId };
  }
}

// A space's project manager moves at the confirmed handoff (R254), and at a kept or finished one, to the one successor;
// a handoff that failed afterwards gives it back. Every session the role passed through, the current one last.
function handoffChain(selected, entries) {
  return handoffSteps(selected, entries).map(({ sessionId, nativeId }) => ({ sessionId, nativeId }));
}
// The same, each step marked `final` when no later failure can give it back: reached through kept or done lines only.
// `since`: the place in `entries` of the person's designation of `selected` (designatedAt). A handed or kept line of a
// handoff of it logged before that line does not take the role from it; a done line does, before or after: its old
// session is ended.
function handoffSteps(selected, entries, since = -1) {
  const edges = new Map(), parents = new Map(), earlier = new Set();
  for (const [at, entry] of entries.entries()) {
    if (!validId(entry?.old?.id)) continue;
    const from = entry.old.id;
    const to = JSON.stringify([entry.new?.id, entry.new?.nativeId]);
    if (from === selected?.sessionId && since >= 0 && entry.event !== 'done') {
      if (at < since) {
        earlier.add(to);
        continue;
      }
      if (earlier.has(to)) continue;
    }
    const edge = edges.get(from)?.get(to);
    if (entry.event === 'failed') {
      if (edge?.handedOnly) {
        edges.get(from).delete(to);
        parents.get(to).delete(from);
      }
      continue;
    }
    if (!['handed', 'kept', 'done'].includes(entry.event)) continue;
    if (edge) {
      edge.mixed ||= edge.entry.old.nativeId !== entry.old.nativeId;
      edge.handedOnly &&= entry.event === 'handed';
      continue;
    }
    if (!edges.has(from)) edges.set(from, new Map());
    edges.get(from).set(to, { entry, handedOnly: entry.event === 'handed', mixed: false });
    if (!parents.has(to)) parents.set(to, new Set());
    parents.get(to).add(from);
  }
  let current = identity(selected), final = true;
  const chain = [{ ...current, final }], seen = new Set();
  while (true) {
    if (seen.has(current.sessionId)) return [{ ...identity(selected), final: true }];
    seen.add(current.sessionId);
    const next = edges.get(current.sessionId);
    if (!next || next.size !== 1) return chain;
    const [to, { entry, mixed, handedOnly }] = next.entries().next().value;
    if (mixed || parents.get(to).size !== 1 || entry.old.nativeId !== current.nativeId || !validId(entry.new?.id) || !validId(entry.new?.nativeId)) return chain;
    current = { sessionId: entry.new.id, nativeId: entry.new.nativeId };
    final &&= !handedOnly;
    chain.push({ ...current, final });
  }
}

// Where in `entries` the person last designated this session for this space (space-managers.cjs set), or -1.
function designatedAt(entries, roomId, identity) {
  return entries.findLastIndex(entry => entry?.event === 'designated' && entry.spaces?.[0] === roomId &&
    entry.old?.id === identity?.sessionId && entry.old?.nativeId === identity?.nativeId);
}

// The rotation log's finished and kept replacements, the only lines the selection rule reads (the secretary, the
// integrator and the butler designation all follow them). The log only grows, so each call reads only what was
// added since the last one: a long log is read once, not on every call, and has no size past which the
// designation is lost (it was 32 MB; review note 5, 2026-11-14). Memory is the kept lines and one read; every
// line must still parse, as before, or the record is an error, never "nobody". `handoffs` adds the handed and failed
// lines handoffChain reads, and the changes of a space manager's record (space-managers.cjs).
const EDGE_EVENTS = ['done', 'kept'], HANDOFF_EVENTS = ['done', 'kept', 'handed', 'failed', 'designated', 'settled'];
const LOG_READ = 4 * 1024 * 1024, LOG_LINE_MAX = 1024 * 1024, LOG_FILES = 8, LOG_MARK = 256;
const logs = new Map();
function rotationEdges(logFile, { handoffs = false } = {}) {
  // Open first, then judge what was opened: a link is refused and nothing can be swapped in between.
  const fd = fs.openSync(logFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077) throw Error('Unsafe rotation log');
    let state = logs.get(logFile);
    // The bytes just before where the last call stopped, to tell a file written over in place from one added to.
    const mark = Buffer.alloc(state ? Math.min(state.offset, LOG_MARK) : 0);
    if (mark.length) fs.readSync(fd, mark, 0, mark.length, state.offset - mark.length);
    // Another file at the path, one cut shorter or written over: read again from its start.
    if (!state || state.dev !== stat.dev || state.ino !== stat.ino || stat.size < state.offset || !mark.equals(state.mark)) {
      state = { dev: stat.dev, ino: stat.ino, offset: 0, entries: [], broken: false, mark: Buffer.alloc(0) };
      logs.delete(logFile);
      logs.set(logFile, state);
      if (logs.size > LOG_FILES) logs.delete(logs.keys().next().value);
    }
    if (state.broken) throw Error('Unreadable rotation log');
    const take = line => {
      if (!line.trim()) return;
      const entry = JSON.parse(line);
      if (HANDOFF_EVENTS.includes(entry?.event)) state.entries.push(entry);
    };
    let rest = Buffer.alloc(0);
    try {
      while (state.offset + rest.length < stat.size) {
        const buffer = Buffer.allocUnsafe(Math.min(LOG_READ, stat.size - state.offset - rest.length));
        const read = fs.readSync(fd, buffer, 0, buffer.length, state.offset + rest.length);
        if (!read) break;
        const data = rest.length ? Buffer.concat([rest, buffer.subarray(0, read)]) : buffer.subarray(0, read);
        let start = 0;
        for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
          take(data.subarray(start, end).toString('utf8'));
          start = end + 1;
        }
        state.offset += start;
        // data starts where the mark ends, so a short step still leaves the last LOG_MARK bytes (review, 2026-11-14).
        if (start) state.mark = Buffer.from(Buffer.concat([state.mark, data.subarray(0, start)]).subarray(-LOG_MARK));
        rest = Buffer.from(data.subarray(start));
        if (rest.length > LOG_LINE_MAX) throw Error('Rotation log line too long');
      }
    } catch (error) { state.broken = true; throw error; }
    // A last line without its newline yet is read as it is now, and again next time.
    // A copy: a caller cannot change what the next call returns.
    const entries = state.entries.slice();
    if (rest.toString('utf8').trim()) {
      const entry = JSON.parse(rest.toString('utf8'));
      if (HANDOFF_EVENTS.includes(entry?.event)) entries.push(entry);
    }
    return handoffs ? entries : entries.filter(entry => EDGE_EVENTS.includes(entry.event));
  } finally { fs.closeSync(fd); }
}

// Where a session's standing went, by the same log and the same rule as the selection, one step at a time:
// the session that replaced it, with the time that replacement was logged, or the same session when no
// finished, unambiguous replacement exists. `replaced` says whether the log holds a replacement of it at
// all, and `spaces` where those were recorded. A chain is walked by asking again for the session returned.
function follow(logFile, value) {
  const from = identity(value);
  let entries = [];
  try {
    entries = rotationEdges(logFile);
  } catch (error) { if (error.code !== 'ENOENT') throw uiError('error.queue.secretaryState'); }
  const edges = entries.filter(entry => ['done', 'kept'].includes(entry?.event) && entry.old?.id === from.sessionId);
  const spaces = [...new Set(edges.flatMap(entry => Array.isArray(entry.spaces) ? entry.spaces.filter(id => typeof id === 'string') : []))];
  // When it stays, `at` is the latest time any replacement of it was logged, if every such line has one.
  const times = edges.map(entry => entry.time);
  const stays = { ...from, at: times.length && times.every(Number.isSafeInteger) ? Math.max(...times) : null, replaced: edges.length > 0, spaces };
  // The selection rule decides whether it moved at all. When it did, every line about this session names the
  // same finished replacement, so the first of them is the step taken.
  if (successor(from, entries).sessionId === from.sessionId) return stays;
  const step = edges[0];
  if (!Number.isSafeInteger(step.time)) return stays;
  return { sessionId: step.new.id, nativeId: step.new.nativeId, at: step.time, replaced: true, spaces };
}

class QueueSecretary {
  constructor(directory) {
    this.file = path.join(directory, 'queue-secretary.json');
    this.logFile = path.join(directory, 'rotation-log.jsonl');
    this.selected = null;
    this.failed = false;
    try {
      const data = JSON.parse(readPrivate(this.file, 4096));
      if (data.version !== 1 || !Object.hasOwn(data, 'selected')) throw Error('Invalid secretary record');
      this.selected = data.selected === null ? null : identity(data.selected);
    } catch (error) { if (error.code !== 'ENOENT') this.failed = true; }
  }
  current() {
    if (this.failed) throw uiError('error.queue.secretaryState');
    if (!this.selected) return null;
    let entries = [];
    try {
      entries = rotationEdges(this.logFile);
    } catch (error) { if (error.code !== 'ENOENT') throw uiError('error.queue.secretaryState'); }
    return successor(this.selected, entries);
  }
}
// A session taking back an item it queued itself (the person, 2026-11-12 21:1x, 「可以」), or claiming one queued
// for it: the caller as the person's record has it now. Room state compares it with the item's creator or assignee,
// and status, in the same step as the change.
function author(actor, records, labels, refusal = 'error.queue.withdrawOwnOnly') {
  const record = usableRecord(actor, records);
  if (!record) throw uiError(refusal);
  return { name: labels.get(record.id) || record.name, sessionId: record.id };
}
// The caller's own session as the person's record has it now: the very native session, not archived, ended,
// in the background or still moving in.
function usableRecord(actor, records) {
  return records.find(record => record.id === actor?.id && record.nativeId === actor?.nativeId && !record.archived && !record.nativeContextPending && !['ended', 'background'].includes(record.state)) || null;
}
module.exports = { QueueSecretary, successor, handoffChain, handoffSteps, designatedAt, follow, rotationEdges, usableRecord, author };
