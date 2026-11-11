'use strict';
// Private metadata only. A record means NAW approved a page for return, not that
// a provider received it. Quota and durable approval share the same file lock.
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder, types: { isProxy } } = require('node:util');
const { roomId } = require('./collaboration-spaces.cjs');

const FILE_NAME = 'butler-business-reads.jsonl';
// Business independently caps each page at 64 KiB; 64 approvals bound a UTC day
// to at most 4 MiB of business pages, including empty or repeated pages.
const MAX_PAGES_PER_UTC_DAY = 64;
const MAX_FILE_BYTES = 32 * 1024 * 1024, MAX_RECORD_BYTES = 128 * 1024;
// An engineering prewarning only. It never changes the cap or removes records.
const WARNING_THRESHOLD_BYTES = MAX_FILE_BYTES * 3 / 4;
const MAX_LIMIT = 50, MAX_SCAN_RECORDS = 2000, MAX_REFERENCE_LENGTH = 2048;
const PREFIX = 'ERR_BUTLER_READ_AUDIT_';
const errorCode = suffix => suffix === 'QUOTA' ? 'ERR_BUTLER_READ_LIMIT' : PREFIX + suffix;
const fail = suffix => { const code = errorCode(suffix); throw Object.assign(Error(code), { code }); };
const integer = value => Number.isSafeInteger(value) && value >= 0;
const timestamp = value => integer(value) && value <= 8_640_000_000_000_000;
const dayOf = value => { if (!timestamp(value)) fail('INPUT'); return new Date(value).toISOString().split('T')[0]; };
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const unchanged = (a, b) => sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
function fields(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INPUT');
  const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key) || !descriptors[key].enumerable ||
      !Object.hasOwn(descriptors[key], 'value')) || required.some(key => !Object.hasOwn(descriptors, key))) fail('INPUT');
}
function metadataId(value) {
  if (typeof value !== 'string' || !value.length || value.length > 200 || /[\s\u0000-\u001f\u007f]/u.test(value)) fail('INPUT');
  return value;
}
function actorInput(value) {
  fields(value, ['sessionId', 'nativeId', 'selectionRevision', 'runnerRef']);
  if (!integer(value.selectionRevision)) fail('INPUT');
  return { sessionId: metadataId(value.sessionId), nativeId: metadataId(value.nativeId),
    selectionRevision: value.selectionRevision, runnerRef: metadataId(value.runnerRef) };
}
function queryInput(value) {
  fields(value, ['kind', 'spaceId', 'includeArchived', 'fromTime', 'throughTime', 'limit'], ['kind', 'spaceId', 'limit']);
  if (!['spaces', 'queue', 'deliveries'].includes(value.kind) || !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > MAX_LIMIT) fail('INPUT');
  const query = { kind: value.kind, spaceId: value.spaceId, limit: value.limit };
  if (value.kind === 'spaces') {
    if (value.spaceId !== null || Object.hasOwn(value, 'fromTime') || Object.hasOwn(value, 'throughTime')) fail('INPUT');
    if (Object.hasOwn(value, 'includeArchived')) {
      if (typeof value.includeArchived !== 'boolean') fail('INPUT'); query.includeArchived = value.includeArchived;
    }
  } else {
    if (!roomId(value.spaceId) || Object.hasOwn(value, 'includeArchived')) fail('INPUT');
    if (value.kind === 'queue') {
      if (Object.hasOwn(value, 'fromTime') || Object.hasOwn(value, 'throughTime')) fail('INPUT');
    } else {
      if (!timestamp(value.fromTime) || !timestamp(value.throughTime) || value.throughTime < value.fromTime) fail('INPUT');
      query.fromTime = value.fromTime; query.throughTime = value.throughTime;
    }
  }
  return query;
}
function reference(value, query) {
  if (typeof value !== 'string' || !value.length || value.length > MAX_REFERENCE_LENGTH || /[\s\u0000-\u001f\u007f]/u.test(value)) fail('INPUT');
  const match = /^naw:space:([^/]+)(?:\/(item|event):((?:[A-Za-z0-9_.!~*'()-]|%[0-9a-fA-F]{2})+))?$/u.exec(value);
  if (!match || !roomId(match[1])) fail('INPUT');
  if (query.kind === 'spaces') { if (match[2]) fail('INPUT'); }
  else {
    if (match[1] !== query.spaceId || match[2] !== (query.kind === 'queue' ? 'item' : 'event')) fail('INPUT');
    try { metadataId(decodeURIComponent(match[3])); } catch { fail('INPUT'); }
  }
  return value;
}
function resultInput(value, query) {
  fields(value, ['count', 'recordRefs', 'scanned', 'truncated']);
  const refs = value.recordRefs;
  if (isProxy(refs) || !Array.isArray(refs) || Object.getPrototypeOf(refs) !== Array.prototype || refs.length > MAX_LIMIT ||
      !integer(value.count) || value.count !== refs.length || value.count > query.limit ||
      !integer(value.scanned) || value.scanned < value.count || value.scanned > MAX_SCAN_RECORDS || typeof value.truncated !== 'boolean') fail('INPUT');
  const descriptors = Object.getOwnPropertyDescriptors(refs), keys = Reflect.ownKeys(refs);
  if (keys.length !== refs.length + 1 || keys.some(key => key !== 'length' &&
      (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= refs.length ||
       !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value')))) fail('INPUT');
  const copied = [];
  for (let index = 0; index < refs.length; index++) {
    const descriptor = descriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('INPUT'); copied.push(reference(descriptor.value, query));
  }
  return { count: value.count, recordRefs: copied, scanned: value.scanned, truncated: value.truncated };
}
function pageInput(value) {
  fields(value, ['actor', 'query', 'result']);
  const actor = actorInput(value.actor), query = queryInput(value.query), result = resultInput(value.result, query);
  return { actor, query, result };
}
function storedRecord(value) {
  fields(value, ['version', 'sequence', 'time', 'day', 'pageOfDay', 'actor', 'query', 'result']);
  if (value.version !== 1 || !integer(value.sequence) || value.sequence < 1 || value.day !== dayOf(value.time) ||
      !integer(value.pageOfDay) || value.pageOfDay < 1 || value.pageOfDay > MAX_PAGES_PER_UTC_DAY) fail('INPUT');
  return { version: 1, sequence: value.sequence, time: value.time, day: value.day, pageOfDay: value.pageOfDay,
    ...pageInput({ actor: value.actor, query: value.query, result: value.result }) };
}
function privateFile(stat) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600;
}
function privateDirectory(stat) {
  return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700;
}
function storageStatus(usedBytes) {
  return { usedBytes, maxBytes: MAX_FILE_BYTES, remainingBytes: MAX_FILE_BYTES - usedBytes,
    warningThresholdBytes: WARNING_THRESHOLD_BYTES, warning: usedBytes >= WARNING_THRESHOLD_BYTES };
}

class ButlerReadAudit {
  #directory; #identity; #file; #lock; #now; #authorizePerson; #failed = false; #observed = null;
  #onCapacityWarning; #capacityWarned = false;
  constructor(directory, options = {}) {
    fields(options, ['authorizePerson', 'now', 'onCapacityWarning'], []);
    const { authorizePerson = () => false, now = Date.now, onCapacityWarning = () => {} } = options;
    if (typeof directory !== 'string' || !path.isAbsolute(directory) ||
        ![authorizePerson, now, onCapacityWarning].every(value => typeof value === 'function')) fail('OPTIONS');
    this.#now = now; this.#authorizePerson = authorizePerson; this.#onCapacityWarning = onCapacityWarning;
    try {
      this.#identity = fs.lstatSync(directory);
      if (!privateDirectory(this.#identity)) fail('STATE');
      this.#directory = fs.realpathSync(directory);
      if (!sameFile(this.#identity, fs.lstatSync(this.#directory))) fail('STATE');
    } catch { fail('STATE'); }
    this.#file = path.join(this.#directory, FILE_NAME); this.#lock = this.#file + '.lock';
  }
  #warnCapacity(storage) {
    if (!storage.warning || this.#capacityWarned) return;
    this.#capacityWarned = true;
    // This runs only after the locked operation and cleanup succeed. A host
    // notifier cannot mutate the reader's status or undo a durable approval.
    try { Promise.resolve(this.#onCapacityWarning(Object.freeze({ ...storage }))).catch(() => {}); }
    catch { /* Notification failure never changes audit or business outcomes. */ }
  }
  #directoryFd() {
    if (this.#failed) fail('STATE');
    const named = fs.lstatSync(this.#directory);
    if (!privateDirectory(named) || !sameFile(named, this.#identity)) fail('STATE');
    const fd = fs.openSync(this.#directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { const opened = fs.fstatSync(fd); if (!privateDirectory(opened) || !sameFile(opened, named)) fail('STATE'); }
    catch (error) { fs.closeSync(fd); throw error; }
    return fd;
  }
  #checkLock(owned) {
    const named = fs.lstatSync(this.#lock);
    if (!privateFile(named) || !sameFile(named, owned)) fail('STATE');
    const fd = this.#directoryFd(); fs.closeSync(fd);
  }
  #locked(operation) {
    let directoryFd, lockFd, owned, value, error;
    try {
      directoryFd = this.#directoryFd();
      try { lockFd = fs.openSync(this.#lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600); }
      catch (cause) { if (cause.code === 'EEXIST') fail('BUSY'); throw cause; }
      owned = fs.fstatSync(lockFd); if (!privateFile(owned)) fail('STATE');
      this.#checkLock(owned); value = operation({ directoryFd, owned }); this.#checkLock(owned);
    } catch (cause) {
      error = cause;
      if (!['BUSY', 'QUOTA', 'CAPACITY', 'INPUT'].some(suffix => cause.code === errorCode(suffix))) this.#failed = true;
    } finally {
      if (owned) try {
        const directory = fs.lstatSync(this.#directory), named = fs.lstatSync(this.#lock);
        if (!privateDirectory(directory) || !sameFile(directory, this.#identity) || !privateFile(named) || !sameFile(named, owned)) this.#failed = true;
        else fs.unlinkSync(this.#lock);
      } catch { this.#failed = true; }
      // Keep the owned inode open through cleanup so a replacement cannot reuse
      // its inode number after an unlink. Never remove an unowned replacement.
      for (const fd of [lockFd, directoryFd]) if (fd !== undefined) try { fs.closeSync(fd); } catch { this.#failed = true; }
    }
    if (this.#failed) fail(error?.code === PREFIX + 'WRITE' ? 'WRITE' : 'STATE');
    if (error) {
      if (['BUSY', 'QUOTA', 'CAPACITY', 'INPUT'].some(suffix => error.code === errorCode(suffix))) throw error;
      fail('STATE');
    }
    return value;
  }
  #load({ afterSequence = 0, limit = 0 } = {}) {
    let fd, before;
    try {
      let named;
      try { named = fs.lstatSync(this.#file); }
      catch (error) { if (error.code === 'ENOENT' && !this.#observed) return { sequence: 0, days: new Map(), records: [], identity: null }; throw error; }
      if (!privateFile(named)) fail('STATE');
      if (named.size > MAX_FILE_BYTES) fail('CAPACITY');
      // Checking before open avoids opening known devices/FIFOs. NONBLOCK also
      // bounds the open if a path is replaced by a FIFO between these calls.
      fd = fs.openSync(this.#file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      before = fs.fstatSync(fd);
      if (!privateFile(before)) fail('STATE');
      if (before.size > MAX_FILE_BYTES) fail('CAPACITY');
      if (!unchanged(named, before) || this.#observed &&
          (!sameFile(before, this.#observed) || before.size < this.#observed.size || before.size === this.#observed.size && !unchanged(before, this.#observed))) fail('STATE');
      const days = new Map(), records = [], block = Buffer.alloc(64 * 1024), decoder = new TextDecoder('utf-8', { fatal: true });
      let offset = 0, pending = Buffer.alloc(0), sequence = 0;
      while (offset < before.size) {
        const count = fs.readSync(fd, block, 0, Math.min(block.length, before.size - offset), offset);
        if (!count) fail('STATE'); offset += count;
        pending = Buffer.concat([pending, block.subarray(0, count)]);
        let newline;
        while ((newline = pending.indexOf(10)) !== -1) {
          if (newline + 1 > MAX_RECORD_BYTES || newline === 0) fail('STATE');
          let record; try { record = storedRecord(JSON.parse(decoder.decode(pending.subarray(0, newline)))); } catch { fail('STATE'); }
          const pages = (days.get(record.day) || 0) + 1;
          if (record.sequence !== sequence + 1 || record.pageOfDay !== pages || pages > MAX_PAGES_PER_UTC_DAY) fail('STATE');
          sequence = record.sequence; days.set(record.day, pages);
          if (sequence > afterSequence && records.length < limit) records.push(record);
          pending = pending.subarray(newline + 1);
        }
        if (pending.length >= MAX_RECORD_BYTES) fail('STATE');
      }
      const after = fs.fstatSync(fd), present = fs.lstatSync(this.#file);
      if (pending.length || !privateFile(after) || !privateFile(present) || !unchanged(before, after) || !unchanged(after, present)) fail('STATE');
      this.#observed = after;
      return { sequence, days, records, identity: after };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  recordPage(input) {
    const page = pageInput(input);
    const approved = this.#locked(({ directoryFd, owned }) => {
      const loaded = this.#load(), time = this.#now(), day = dayOf(time), pageOfDay = (loaded.days.get(day) || 0) + 1;
      if (pageOfDay > MAX_PAGES_PER_UTC_DAY) fail('QUOTA');
      if (loaded.sequence === Number.MAX_SAFE_INTEGER) fail('CAPACITY');
      const record = { version: 1, sequence: loaded.sequence + 1, time, day, pageOfDay, ...page };
      const bytes = Buffer.from(JSON.stringify(record) + '\n');
      if (bytes.length > MAX_RECORD_BYTES || (loaded.identity?.size || 0) + bytes.length > MAX_FILE_BYTES) fail('CAPACITY');
      this.#checkLock(owned);
      let fd;
      try {
        fd = fs.openSync(this.#file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK |
          (loaded.identity ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL), 0o600);
        const before = fs.fstatSync(fd), named = fs.lstatSync(this.#file);
        if (!privateFile(before) || !privateFile(named) || !unchanged(before, named) ||
            (loaded.identity ? !unchanged(before, loaded.identity) : before.size !== 0)) fail('STATE');
        let offset = 0;
        while (offset < bytes.length) {
          const count = fs.writeSync(fd, bytes, offset, bytes.length - offset);
          if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - offset) fail('WRITE'); offset += count;
        }
        fs.fsyncSync(fd); if (!loaded.identity) fs.fsyncSync(directoryFd);
        const after = fs.fstatSync(fd), present = fs.lstatSync(this.#file);
        if (!privateFile(after) || !privateFile(present) || !sameFile(before, after) || after.size !== before.size + bytes.length || !unchanged(after, present)) fail('STATE');
        this.#checkLock(owned); this.#observed = after;
      } catch { fail('WRITE'); }
      finally { if (fd !== undefined) fs.closeSync(fd); }
      return { receipt: { sequence: record.sequence, time, day, pageOfDay }, storage: storageStatus(this.#observed.size) };
    });
    this.#warnCapacity(approved.storage); return approved.receipt;
  }
  read(person, options = {}) {
    let permitted = false; try { permitted = this.#authorizePerson(person) === true; } catch {}
    if (!permitted) fail('PERSON');
    fields(options, ['afterSequence', 'limit'], []);
    const { afterSequence = 0, limit = MAX_LIMIT } = options;
    if (!integer(afterSequence) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) fail('INPUT');
    const result = this.#locked(() => {
      const loaded = this.#load({ afterSequence, limit });
      if (afterSequence > loaded.sequence) fail('INPUT');
      const nextAfterSequence = loaded.records.at(-1)?.sequence ?? afterSequence;
      return { records: loaded.records, throughSequence: loaded.sequence, nextAfterSequence, truncated: nextAfterSequence < loaded.sequence,
        storage: storageStatus(loaded.identity?.size || 0) };
    });
    this.#warnCapacity(result.storage); return result;
  }
}
module.exports = { ButlerReadAudit, MAX_PAGES_PER_UTC_DAY };
