'use strict';
// Private metadata only. A record means NAW approved a page for return, not that
// a provider received it. Quota and durable approval share the same file lock.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { TextDecoder, types: { isProxy } } = require('node:util');
const { roomId } = require('./collaboration-spaces.cjs');

const history = require('./record-history.cjs');
// The log is kept whole, in blocks by day (record-history.cjs). The single file of earlier versions is taken in
// as the first block the first time the log is used; its lock keeps its old name, so an older version and this
// one never write at the same time.
const LEGACY_NAME = 'butler-business-reads.jsonl', RECORD = 'butler-reads';
// Business independently caps each page at 64 KiB; 64 approvals bound a UTC day
// to at most 4 MiB of business pages, including empty or repeated pages.
const MAX_PAGES_PER_UTC_DAY = 64;
// An older version stopped its single file at this size; a larger one is not something it wrote.
const LEGACY_MAX_BYTES = 32 * 1024 * 1024, MAX_RECORD_BYTES = 128 * 1024;
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
const { privateFile, privateDirectory } = history;
// What the person is shown about the log's size. There is no cap: the line is where the person is reminded.
function storageStatus(manifest) {
  const usedBytes = manifest ? history.totalBytes(manifest) : 0;
  return { usedBytes, remindBytes: history.REMIND_TOTAL_BYTES, blocks: manifest ? manifest.blocks.length : 0,
    unreadableBlocks: manifest ? manifest.blocks.filter(block => block.status === 'unreadable').length : 0,
    warning: usedBytes > history.REMIND_TOTAL_BYTES };
}
const addDays = (into, days) => { for (const [day, count] of Object.entries(days || {})) into[day] = (into[day] || 0) + count; return into; };
const daysBefore = (blocks, index) => blocks.slice(0, index).reduce((days, item) => addDays(days, item.days), {});
const openDay = block => history.parseBlockName(block.name).day;
const exists = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
// Whether a block's place is free. An empty private file there (a block dropped before its file could be removed)
// holds nothing and is removed; anything else keeps the place taken.
function vacant(directory, name) {
  const file = path.join(directory, name);
  let stat; try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  if (!privateFile(stat) || stat.size !== 0) return false;
  history.removeFile(directory, name); return true;
}
const errorOf = cause => typeof cause?.code === 'string' && cause.code.startsWith(PREFIX) || cause?.code === 'ERR_BUTLER_READ_LIMIT';

class ButlerReadAudit {
  #directory; #identity; #legacy; #lock; #now; #authorizePerson; #failed = false;
  // What this instance has seen: the highest number, and the open block as it last saw it. A log that goes back
  // from either while this instance runs is refused, never taken as a new quota.
  #known = 0; #observed = null;
  #onCapacityWarning; #capacityWarned = false;
  // Host composition only: no model method, path disclosure or overridable
  // instance predicate. A prototype/JSON stand-in has no private store brand.
  static matchesDataDir(audit, dataDir) {
    if (!audit || typeof audit !== 'object' || isProxy(audit) || !(#directory in audit) ||
        typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) return false;
    let fd;
    try {
      const expected = fs.statSync(dataDir);
      if (!privateDirectory(expected)) return false;
      fd = audit.#directoryFd();
      const current = fs.statSync(dataDir);
      return privateDirectory(current) && sameFile(current, expected) && sameFile(fs.fstatSync(fd), expected);
    } catch { return false; }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { return false; } }
  }
  static record(audit, input) {
    if (!audit || typeof audit !== 'object' || isProxy(audit) || !(#directory in audit)) fail('INPUT');
    return audit.#recordPage(input);
  }
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
    // Construction touches nothing: the folders are made, and an older single file taken in, by the first locked use.
    this.#legacy = path.join(this.#directory, LEGACY_NAME); this.#lock = this.#legacy + '.lock';
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
  // One file of the log, read whole and checked line by line. `first` is the number its first line must carry,
  // `startDays` the pages each day already had before it (a day's running count goes on from there). Lines after
  // `after` are kept, up to `take`. Any line that is torn, not a record, out of order or over a day's count fails.
  // tail: a last line cut short by a stop during its append is allowed and left as it is (sealed blocks are also held
  // to their checksum). local: the block was written by an older version, whose page numbers count its own lines only;
  // they are checked as such and given back as the day's running count across the whole log.
  #scan(file, { first, startDays = {}, maxBytes, after = Infinity, take = 0, observed = null, tail = false, local = false }) {
    let fd, start;
    try {
      const named = fs.lstatSync(file);
      if (!privateFile(named)) fail('STATE');
      if (named.size > maxBytes) fail('CAPACITY');
      // Checking before open avoids opening known devices/FIFOs. NONBLOCK also
      // bounds the open if a path is replaced by a FIFO between these calls.
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      start = fs.fstatSync(fd);
      if (!privateFile(start)) fail('STATE');
      if (start.size > maxBytes) fail('CAPACITY');
      if (!unchanged(named, start) || observed &&
          (!sameFile(start, observed) || start.size < observed.size || start.size === observed.size && !unchanged(start, observed))) fail('STATE');
      const days = {}, running = { ...startDays }, own = {}, records = [], block = Buffer.alloc(64 * 1024), decoder = new TextDecoder('utf-8', { fatal: true }), hash = history.sha256();
      let offset = 0, pending = Buffer.alloc(0), next = first, count = 0, oldestTime = null, newestTime = null;
      while (offset < start.size) {
        const read = fs.readSync(fd, block, 0, Math.min(block.length, start.size - offset), offset);
        if (!read) fail('STATE'); offset += read; hash.update(block.subarray(0, read));
        pending = Buffer.concat([pending, block.subarray(0, read)]);
        let newline;
        while ((newline = pending.indexOf(10)) !== -1) {
          if (newline + 1 > MAX_RECORD_BYTES || newline === 0) fail('STATE');
          let record; try { record = storedRecord(JSON.parse(decoder.decode(pending.subarray(0, newline)))); } catch { fail('STATE'); }
          const pages = (running[record.day] || 0) + 1, written = local ? (own[record.day] || 0) + 1 : pages;
          if (record.sequence !== next || record.pageOfDay !== written || written > MAX_PAGES_PER_UTC_DAY) fail('STATE');
          running[record.day] = pages; own[record.day] = written; days[record.day] = (days[record.day] || 0) + 1; next++; count++;
          oldestTime = oldestTime === null ? record.time : Math.min(oldestTime, record.time); newestTime = newestTime === null ? record.time : Math.max(newestTime, record.time);
          if (record.sequence > after && records.length < take) records.push(local ? { ...record, pageOfDay: pages } : record);
          pending = pending.subarray(newline + 1);
        }
        if (pending.length >= MAX_RECORD_BYTES) fail('STATE');
      }
      const end = fs.fstatSync(fd), present = fs.lstatSync(file);
      if (pending.length && (!tail || pending.includes(10)) || !privateFile(end) || !privateFile(present) || !unchanged(start, end) || !unchanged(end, present)) fail('STATE');
      return { count, days, records, bytes: end.size, sha256: hash.digest('hex'), oldestTime, newestTime, identity: end, tail: pending.length };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  #store() { return history.existingDirectory(this.#directory, history.HISTORY_DIR) && history.existingDirectory(path.join(this.#directory, history.HISTORY_DIR), RECORD); }
  #makeStore() { return history.ensureDirectory(history.ensureDirectory(this.#directory, history.HISTORY_DIR), RECORD); }
  #writeManifest(store, manifest) {
    try { history.writePrivateJson(store, history.MANIFEST, { version: 1, record: RECORD, blocks: manifest.blocks }); }
    catch (cause) { if (errorOf(cause)) throw cause; fail('WRITE'); }
  }
  #readManifest(store) {
    // Only a manifest that is not there or whose contents do not parse is built again; one that cannot be opened safely
    // (a link, a shared file, too large, an error reading it) stops the log rather than being replaced from the blocks.
    let value; try { value = history.readPrivateJson(path.join(store, history.MANIFEST), history.MANIFEST_MAX_BYTES); } catch (error) { if (error instanceof SyntaxError) return undefined; fail('STATE'); }
    if (value === null) return null;
    try { return history.manifestValue(value, RECORD); } catch { return undefined; }
  }
  // The manifest built again from the blocks themselves, when it is missing or cannot be read. Every block must
  // read whole: the counts of a day cannot be guessed, so a block that cannot be read stops this (fail closed).
  #rebuild(store) {
    const names = fs.readdirSync(store).map(name => ({ name, parsed: history.parseBlockName(name) })).filter(item => item.parsed && fs.lstatSync(path.join(store, item.name)).size > 0)
      .sort((a, b) => a.parsed.firstSequence - b.parsed.firstSequence);
    const manifest = { blocks: [] };
    for (const { name, parsed } of names) {
      const file = path.join(store, name), expected = history.lastSequence(manifest) + 1;
      if (parsed.firstSequence !== expected) fail('STATE');
      let scan, offset = 0, origin = 'native';
      try { scan = this.#scan(file, { first: parsed.firstSequence, startDays: daysBefore(manifest.blocks, manifest.blocks.length), maxBytes: history.BLOCK_MAX_BYTES, tail: true }); }
      catch { offset = parsed.firstSequence - 1; origin = 'legacy'; scan = this.#scan(file, { first: 1, maxBytes: LEGACY_MAX_BYTES, local: true }); }
      if (!scan.count) fail('STATE');
      manifest.blocks.push(this.#entry(name, parsed.firstSequence, offset, origin, scan, 'sealed'));
    }
    const last = manifest.blocks.at(-1);
    // The newest block this version wrote is the one still open, as when the manifest was lost. If its last line was
    // cut short, the open block's own check finds that before anything is appended, and seals it.
    if (last && last.origin === 'native') Object.assign(last, { status: 'open', sha256: null });
    this.#writeManifest(store, manifest);
    return history.manifestValue({ version: 1, record: RECORD, blocks: manifest.blocks }, RECORD);
  }
  #entry(name, firstSequence, offset, origin, scan, status) {
    return { name, firstSequence, lastSequence: firstSequence + scan.count - 1, offset, count: scan.count, bytes: scan.bytes, oldestTime: scan.oldestTime,
      newestTime: scan.newestTime, days: scan.days, sha256: status === 'open' ? null : scan.sha256, status, origin };
  }
  // The open block as a new instance finds it when it does not read as written: a last line cut short by a stop during
  // its append is left as it is and the block is sealed with it (the page it would have logged was never released);
  // anything else, or a block grown past its size, is kept as unreadable with the counts the manifest has for it.
  // A block that holds no line at all, only one cut short, held no page that was released: it is moved aside under a
  // name that is not a block's (kept, not read) and null is returned, so the next block can start at the same number.
  // One that holds nothing readable and was meant to hold nothing stops the log: its contents cannot be accounted for.
  #recoverOpen(store, manifest, open) {
    let scan = null;
    try { scan = this.#scan(path.join(store, open.name), { first: open.firstSequence, startDays: daysBefore(manifest.blocks, manifest.blocks.length - 1), maxBytes: history.BLOCK_MAX_BYTES, tail: true }); }
    catch (cause) { if (![errorCode('STATE'), errorCode('CAPACITY'), 'ENOENT'].includes(cause.code)) throw cause; }
    if (scan && scan.count === 0 && open.count === 0) {
      fs.renameSync(path.join(store, open.name), path.join(store, `${open.name}.${randomUUID()}.torn`)); history.syncDirectory(store);
      return null;
    }
    if (scan && scan.count >= open.count) return this.#entry(open.name, open.firstSequence, 0, 'native', scan, 'sealed');
    if (open.count === 0) fail('STATE');
    return { ...open, status: 'unreadable' };
  }
  #withoutOpen(store, manifest, open) {
    const kept = this.#recoverOpen(store, manifest, open);
    return { blocks: [...manifest.blocks.slice(0, -1), ...(kept ? [kept] : [])] };
  }
  // The open block sealed: its bytes and their checksum are what it holds from now on. One that cannot be read is
  // kept as unreadable with the counts the manifest has for it.
  #seal(store, manifest) {
    const open = manifest.blocks.at(-1);
    if (!open || open.status !== 'open') return manifest;
    let scan = null;
    try { scan = this.#scanOpen(store, manifest, open); }
    catch (cause) { if (this.#observed?.name === open.name || ![errorCode('STATE'), errorCode('CAPACITY')].includes(cause.code)) throw cause; }
    // A block opened for a line whose write then failed holds nothing: it is dropped rather than sealed, so the next
    // block starts at the same number. Its empty file, if one was made, goes after the manifest no longer names it.
    if (scan && scan.count === 0) {
      const next = { blocks: manifest.blocks.slice(0, -1) };
      this.#writeManifest(store, next);
      try { history.removeFile(store, open.name); } catch { /* An empty file left behind is opened again if the name comes round. */ }
      if (this.#observed?.name === open.name) this.#observed = null;
      return next;
    }
    const next = scan ? { blocks: [...manifest.blocks.slice(0, -1), this.#entry(open.name, open.firstSequence, 0, 'native', scan, 'sealed')] } : this.#withoutOpen(store, manifest, open);
    this.#writeManifest(store, next);
    if (this.#observed?.name === open.name) this.#observed = null;
    return next;
  }
  // The open block read and checked against the manifest. Lines beyond the manifest's count (a stop between an
  // append and the manifest's update) are taken; fewer lines, or lines that do not read, are an error.
  #scanOpen(store, manifest, open) {
    const file = path.join(store, open.name);
    let scan;
    try {
      scan = this.#scan(file, { first: open.firstSequence, startDays: daysBefore(manifest.blocks, manifest.blocks.length - 1), maxBytes: history.BLOCK_MAX_BYTES,
        observed: this.#observed?.name === open.name ? this.#observed.identity : null });
    } catch (cause) {
      // A block not made yet: the manifest names it and has nothing in it.
      if (cause.code === 'ENOENT' && open.count === 0 && this.#observed?.name !== open.name) return { count: 0, days: {}, records: [], bytes: 0, sha256: null, oldestTime: null, newestTime: null, identity: null };
      throw errorOf(cause) ? cause : Object.assign(Error(errorCode('STATE')), { code: errorCode('STATE') });
    }
    if (scan.count < open.count) fail('STATE');
    return scan;
  }
  // Everything that has to be true before the log is read or written, done under the lock: an interrupted taking-in
  // finished, an older single file taken in, the manifest read (or built again). Null when there is no log at all.
  #prepare() {
    let store = this.#store(), manifest = null;
    if (store) {
      manifest = this.#readManifest(store);
      if (manifest === undefined || manifest === null && fs.readdirSync(store).some(name => history.parseBlockName(name))) manifest = this.#rebuild(store);
      manifest = this.#finishIntent(store, manifest);
    }
    let legacy = null; try { legacy = fs.lstatSync(this.#legacy); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (legacy) {
      // An older file is taken in only whole: one with a line cut short stops the log here as it stopped that version.
      const scan = this.#scan(this.#legacy, { first: 1, maxBytes: LEGACY_MAX_BYTES, local: true });
      if (!scan.count) history.removeFile(this.#directory, LEGACY_NAME);
      else { store ||= this.#makeStore(); manifest ||= { version: 1, record: RECORD, blocks: [] }; manifest = this.#takeIn(store, manifest, scan); }
    }
    if (!manifest) {
      if (this.#known) fail('STATE');
      return null;
    }
    if (history.lastSequence(manifest) < this.#known) fail('STATE');
    return { store, manifest };
  }
  // An older version's single file taken in as a sealed block, numbered after everything already logged, bytes
  // unchanged. Its pages count toward their days; a file an older version wrote after going back never resets one.
  #takeIn(store, manifest, scan) {
    manifest = this.#seal(store, manifest);
    const offset = history.lastSequence(manifest), firstDay = Object.keys(scan.days).sort()[0];
    const entry = this.#entry(history.blockName(offset + 1, firstDay), offset + 1, offset, 'legacy', scan, 'sealed');
    if (!vacant(store, entry.name)) fail('STATE');
    try { history.writePrivateJson(store, history.INTENT, { version: 1, record: RECORD, entry }); } catch { fail('WRITE'); }
    this.#moveIn(store, entry.name);
    return this.#commitIntent(store, manifest, entry);
  }
  // The older file moved into the store under its block name, never over a file already there.
  #moveIn(store, name) {
    if (!vacant(store, name)) fail('STATE');
    fs.renameSync(this.#legacy, path.join(store, name)); history.syncDirectory(this.#directory); history.syncDirectory(store);
  }
  #commitIntent(store, manifest, entry) {
    const next = { blocks: [...manifest.blocks, entry] };
    history.manifestValue({ version: 1, record: RECORD, blocks: next.blocks }, RECORD);
    this.#writeManifest(store, next);
    try { history.removeFile(store, history.INTENT); } catch { fail('WRITE'); }
    return history.manifestValue({ version: 1, record: RECORD, blocks: next.blocks }, RECORD);
  }
  // A taking-in that stopped half way is finished from where it stopped, never started again or left half done.
  #finishIntent(store, manifest) {
    let intent; try { intent = history.readPrivateJson(path.join(store, history.INTENT), history.INTENT_MAX_BYTES); } catch { fail('STATE'); }
    if (intent === null) return manifest;
    let entry; try { if (intent.version !== 1 || intent.record !== RECORD) throw Error('Invalid intent'); entry = history.blockEntry(intent.entry); } catch { fail('STATE'); }
    manifest ||= { version: 1, record: RECORD, blocks: [] };
    if (manifest.blocks.some(block => block.name === entry.name)) { history.removeFile(store, history.INTENT); return manifest; }
    const target = path.join(store, entry.name), matches = file => { const scan = this.#scan(file, { first: 1, maxBytes: LEGACY_MAX_BYTES, local: true }); return scan.bytes === entry.bytes && scan.sha256 === entry.sha256; };
    // Moved already: the block in its place must be the one planned. A file in the older place meanwhile is one an
    // older version started after that; it is taken in after this one.
    if (exists(target)) { if (!matches(target)) fail('STATE'); }
    else if (exists(this.#legacy) && matches(this.#legacy)) this.#moveIn(store, entry.name);
    // Planned and never moved, and the older file has changed since (an older version wrote to it): nothing was
    // moved, so the plan is dropped and the file is taken in as it is now.
    else if (exists(this.#legacy)) { history.removeFile(store, history.INTENT); return manifest; }
    // Neither: the log is not started again as if empty.
    else fail('STATE');
    manifest = this.#seal(store, manifest);
    if (history.lastSequence(manifest) !== entry.offset) fail('STATE');
    return this.#commitIntent(store, manifest, entry);
  }
  recordPage(input) { return this.#recordPage(input); }
  #recordPage(input) {
    const page = pageInput(input);
    const approved = this.#locked(({ directoryFd, owned }) => {
      let prepared = this.#prepare(), store = prepared?.store, manifest = prepared?.manifest;
      if (!prepared) { store = this.#makeStore(); manifest = { version: 1, record: RECORD, blocks: [] }; }
      // The open block as it is on disk. One that cannot be read is kept, as unreadable, with the manifest's counts.
      let open = manifest.blocks.at(-1)?.status === 'open' ? manifest.blocks.at(-1) : null, scan = null;
      if (open) {
        try { scan = this.#scanOpen(store, manifest, open); }
        catch (cause) {
          if (this.#observed?.name === open.name || ![errorCode('STATE'), errorCode('CAPACITY')].includes(cause.code)) throw cause;
          manifest = this.#withoutOpen(store, manifest, open); this.#writeManifest(store, manifest); open = null;
        }
        if (open && scan.count > open.count) {
          open = this.#entry(open.name, open.firstSequence, 0, 'native', scan, 'open');
          manifest = { blocks: [...manifest.blocks.slice(0, -1), open] };
        }
      }
      const time = this.#now(), day = dayOf(time), sequence = history.lastSequence(manifest) + 1;
      const used = manifest.blocks.reduce((sum, block) => sum + (block.days[day] || 0), 0);
      if (used >= MAX_PAGES_PER_UTC_DAY) fail('QUOTA');
      if (sequence > Number.MAX_SAFE_INTEGER - 1) fail('CAPACITY');
      const record = { version: 1, sequence, time, day, pageOfDay: used + 1, ...page };
      const bytes = Buffer.from(JSON.stringify(record) + '\n');
      if (bytes.length > MAX_RECORD_BYTES) fail('CAPACITY');
      // A new UTC day, or no room left in this block: it is sealed and a new one opened for this line.
      if (open && (day > openDay(open) || open.bytes + bytes.length > history.BLOCK_MAX_BYTES)) { manifest = this.#seal(store, manifest); open = null; scan = null; }
      if (!open) {
        if (!vacant(store, history.blockName(sequence, day))) fail('STATE');
        open = { name: history.blockName(sequence, day), firstSequence: sequence, lastSequence: sequence - 1, offset: 0, count: 0, bytes: 0,
          oldestTime: null, newestTime: null, days: {}, sha256: null, status: 'open', origin: 'native' };
        manifest = { blocks: [...manifest.blocks, open] }; this.#writeManifest(store, manifest);
      }
      const file = path.join(store, open.name);
      this.#checkLock(owned);
      let fd, after;
      try {
        fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK |
          (scan?.identity ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL), 0o600);
        const start = fs.fstatSync(fd), named = fs.lstatSync(file);
        if (!privateFile(start) || !privateFile(named) || !unchanged(start, named) ||
            (scan?.identity ? !unchanged(start, scan.identity) : start.size !== 0)) fail('STATE');
        let offset = 0;
        while (offset < bytes.length) {
          const count = fs.writeSync(fd, bytes, offset, bytes.length - offset);
          if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - offset) fail('WRITE'); offset += count;
        }
        fs.fsyncSync(fd); if (!scan?.identity) fs.fsyncSync(directoryFd), history.syncDirectory(store);
        after = fs.fstatSync(fd); const present = fs.lstatSync(file);
        if (!privateFile(after) || !privateFile(present) || !sameFile(start, after) || after.size !== start.size + bytes.length || !unchanged(after, present)) fail('STATE');
        this.#checkLock(owned);
      } catch { fail('WRITE'); }
      finally { if (fd !== undefined) fs.closeSync(fd); }
      const entry = { ...open, lastSequence: sequence, count: open.count + 1, bytes: after.size, days: addDays({ ...open.days }, { [day]: 1 }),
        oldestTime: open.oldestTime === null ? time : Math.min(open.oldestTime, time), newestTime: open.newestTime === null ? time : Math.max(open.newestTime, time) };
      manifest = { blocks: [...manifest.blocks.slice(0, -1), entry] };
      // The line is durable before the manifest says so: a stop here leaves one more line than the manifest counts,
      // which the next use takes in. The page is not approved until the manifest has it too.
      this.#writeManifest(store, manifest);
      this.#known = sequence; this.#observed = { name: entry.name, identity: after };
      return { receipt: { sequence, time, day, pageOfDay: record.pageOfDay }, storage: storageStatus(manifest) };
    });
    this.#warnCapacity(approved.storage); return approved.receipt;
  }
  // The person's read: positions after `afterSequence`, up to `limit` of them, in order. A block that cannot be
  // read is one gap (its numbers, its days, how many lines), never left out and never shown as nothing.
  read(person, options = {}) {
    let permitted = false; try { permitted = this.#authorizePerson(person) === true; } catch {}
    if (!permitted) fail('PERSON');
    fields(options, ['afterSequence', 'limit'], []);
    const { afterSequence = 0, limit = MAX_LIMIT } = options;
    if (!integer(afterSequence) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) fail('INPUT');
    const result = this.#locked(() => {
      const prepared = this.#prepare();
      if (!prepared) {
        if (afterSequence > 0) fail('INPUT');
        return { records: [], gaps: [], throughSequence: 0, nextAfterSequence: 0, truncated: false, storage: storageStatus(null) };
      }
      let { store, manifest } = prepared, changed = false;
      const through = history.lastSequence(manifest), records = [], gaps = [];
      let open = manifest.blocks.at(-1)?.status === 'open' ? manifest.blocks.at(-1) : null;
      // The open block may hold a line the manifest does not count yet; the count of the log includes it.
      if (open) {
        try {
          const scan = this.#scanOpen(store, manifest, open);
          if (scan.count > open.count) { open = this.#entry(open.name, open.firstSequence, 0, 'native', scan, 'open'); manifest = { blocks: [...manifest.blocks.slice(0, -1), open] }; changed = true; }
          if (scan.identity) this.#observed = { name: open.name, identity: scan.identity };
        } catch (cause) {
          if (this.#observed?.name === open.name || ![errorCode('STATE'), errorCode('CAPACITY')].includes(cause.code)) throw cause;
          manifest = this.#withoutOpen(store, manifest, open); changed = true;
        }
      }
      const last = history.lastSequence(manifest);
      if (afterSequence > last) fail('INPUT');
      let next = afterSequence, taken = 0;
      const blocks = manifest.blocks;
      for (const [index, block] of blocks.entries()) {
        if (taken >= limit) break;
        if (block.lastSequence <= next || block.count === 0) continue;
        let scan = null;
        const wanted = limit - taken;
        // A block set aside as unreadable is tried again when its checksum is known: one put back exactly as it was
        // sealed reads again. One that was still open when it was set aside has no checksum and stays set aside.
        if (block.status !== 'unreadable' || block.sha256) {
          try {
            scan = this.#scan(path.join(store, block.name), { first: block.firstSequence - block.offset, startDays: daysBefore(blocks, index), local: block.origin === 'legacy',
              maxBytes: block.origin === 'native' ? history.BLOCK_MAX_BYTES : LEGACY_MAX_BYTES, after: next - block.offset, take: wanted, tail: block.origin === 'native' && block.status !== 'open' });
            if (block.status !== 'open' && (scan.bytes !== block.bytes || scan.sha256 !== block.sha256) || scan.count < block.count) scan = null;
          } catch (cause) { if (cause.code === errorCode('CAPACITY') || cause.code === errorCode('STATE') || cause.code === 'ENOENT') scan = null; else throw cause; }
          const status = scan ? (block.status === 'open' ? 'open' : 'sealed') : 'unreadable';
          if (status !== block.status) { manifest = { blocks: manifest.blocks.map((item, at) => at === index ? { ...block, status } : item) }; changed = true; }
        }
        if (!scan) {
          const from = Math.max(next + 1, block.firstSequence), to = Math.min(block.lastSequence, from + (limit - taken) - 1);
          gaps.push({ fromSequence: from, throughSequence: to, count: to - from + 1, days: Object.keys(block.days).sort() });
          taken += to - from + 1; next = to; continue;
        }
        for (const record of scan.records) records.push({ ...record, sequence: record.sequence + block.offset });
        taken += scan.records.length;
        // Fewer than asked for: the block was read to its end.
        next = scan.records.length < wanted ? block.lastSequence : scan.records.at(-1).sequence + block.offset;
      }
      if (changed) this.#writeManifest(store, manifest);
      this.#known = Math.max(this.#known, last);
      return { records, gaps, throughSequence: last, nextAfterSequence: next, truncated: next < last, storage: storageStatus(manifest) };
    });
    this.#warnCapacity(result.storage); return result;
  }
}
// Prevent host composition from replacing the base checks or private-record
// entry with an instance/subclass override. This is not a same-process RCE boundary.
Object.freeze(ButlerReadAudit);
module.exports = { ButlerReadAudit, MAX_PAGES_PER_UTC_DAY };
Object.freeze(module.exports);
