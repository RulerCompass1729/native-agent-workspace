'use strict';
// A single, person-selected session may add queue items. This grants no native
// execution tools or other queue powers. Rotation follows only the written log.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
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

// Where a session's standing went, by the same log and the same rule as the selection, one step at a time:
// the session that replaced it, with the time that replacement was logged, or the same session when no
// finished, unambiguous replacement exists. `replaced` says whether the log holds a replacement of it at
// all, and `spaces` where those were recorded. A chain is walked by asking again for the session returned.
function follow(logFile, value) {
  const from = identity(value);
  let entries = [];
  try {
    const text = readPrivate(logFile, 32 * 1024 * 1024);
    entries = text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
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
      const text = readPrivate(this.logFile, 32 * 1024 * 1024);
      entries = text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    } catch (error) { if (error.code !== 'ENOENT') throw uiError('error.queue.secretaryState'); }
    return successor(this.selected, entries);
  }
  set(value) {
    const selected = value === null ? null : identity(value);
    const temp = `${this.file}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ version: 1, selected }));
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, this.file);
      const directory = fs.openSync(path.dirname(this.file), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch { this.failed = true; throw uiError('error.queue.secretaryState'); }
    finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
    this.selected = selected;
    this.failed = false;
  }
  creator(actor, records, labels) {
    const current = this.current();
    const record = usableRecord(actor, records);
    if (!current || current.sessionId !== actor?.id || current.nativeId !== actor?.nativeId || !record) throw uiError('error.queue.secretaryOnly');
    return { kind: 'secretary', name: labels.get(record.id) || record.name, sessionId: record.id };
  }
  // A session taking back an item it queued itself (the person, 2026-11-12 21:1x, 「可以」), or claiming one queued
  // for it: the caller as the person's record has it now, whether or not it is still the secretary. Room state
  // compares it with the item's creator or assignee, and status, in the same step as the change.
  author(actor, records, labels, refusal = 'error.queue.withdrawOwnOnly') {
    const record = usableRecord(actor, records);
    if (!record) throw uiError(refusal);
    return { name: labels.get(record.id) || record.name, sessionId: record.id };
  }
}
// The caller's own session as the person's record has it now: the very native session, not archived, ended,
// in the background or still moving in.
function usableRecord(actor, records) {
  return records.find(record => record.id === actor?.id && record.nativeId === actor?.nativeId && !record.archived && !record.nativeContextPending && !['ended', 'background'].includes(record.state)) || null;
}
module.exports = { QueueSecretary, successor, follow };
