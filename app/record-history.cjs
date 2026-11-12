'use strict';
// Records kept whole, in blocks (the person, 2026-11-11: 「全保留，然后切分成小块（比如按天保持），然后超过 30 天/或者整个
// 记录大小超过 0.5G 这样的，界面有个小铃铛弹提醒」; the butler's read log 「一样」). Shared by every record kept this way:
// where the blocks live, how they are named, the manifest that describes them, the lines at which the person is
// reminded, and which reminders are due. NAW never deletes, compresses or merges a block by itself.
//
// <data folder>/history/<record>/
//   manifest.json                 which blocks there are and what each holds (written whole, atomically)
//   000000001-2026-11-09.jsonl    a block: named by the global number of its first line and the UTC day it was opened
//   migration.json                only while an older single file is being taken in
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

// One place for the numbers the person set and the size of one block.
const BLOCK_MAX_BYTES = 32 * 1024 * 1024;
const REMIND_AGE_DAYS = 30;
const REMIND_TOTAL_BYTES = 512 * 1024 * 1024;
const HISTORY_DIR = 'history', MANIFEST = 'manifest.json', INTENT = 'migration.json';
const MANIFEST_MAX_BYTES = 8 * 1024 * 1024, INTENT_MAX_BYTES = 16 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

const integer = value => Number.isSafeInteger(value) && value >= 0;
const isDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value + 'T00:00:00Z').toISOString().startsWith(value);
const isHash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function privateFile(stat) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600;
}
function privateDirectory(stat) {
  return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700;
}

// A block's name: the global number of its first line, then the UTC day it was opened.
function blockName(firstSequence, day) {
  if (!integer(firstSequence) || firstSequence < 1 || firstSequence > 999_999_999_999 || !isDay(day)) throw Error('Invalid block name');
  return `${String(firstSequence).padStart(9, '0')}-${day}.jsonl`;
}
function parseBlockName(name) {
  const match = typeof name === 'string' && /^(\d{9,12})-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
  if (!match || !isDay(match[2])) return null;
  const firstSequence = Number(match[1]);
  return firstSequence >= 1 && blockName(firstSequence, match[2]) === name ? { firstSequence, day: match[2] } : null;
}

// One block as the manifest describes it. `offset` is added to the numbers a block holds to give their global
// numbers: 0 for blocks this version writes, more for a single file an older version wrote and that was taken in
// after others. `days` counts the block's lines per UTC day. `sha256` is set when the block is sealed.
// A block the person exported (checked) and then deleted keeps its entry, status `deleted`, with when (`deletedAt`):
// its numbers, days and counts stay, so numbering, a day's count and what was recorded are not lost with its file.
const BLOCK_KEYS = ['name', 'firstSequence', 'lastSequence', 'offset', 'count', 'bytes', 'oldestTime', 'newestTime', 'days', 'sha256', 'status', 'origin'];
function blockEntry(value) {
  const deleted = plain(value) && value.status === 'deleted';
  if (!exact(value, deleted ? [...BLOCK_KEYS, 'deletedAt'] : BLOCK_KEYS) || deleted && !integer(value.deletedAt)) throw Error('Invalid block entry');
  const parsed = parseBlockName(value.name);
  if (!parsed || value.firstSequence !== parsed.firstSequence || !integer(value.lastSequence) || !integer(value.offset) || value.offset >= value.firstSequence ||
      !integer(value.count) || value.lastSequence !== value.firstSequence + value.count - 1 || !integer(value.bytes) || value.bytes > BLOCK_MAX_BYTES ||
      !['open', 'sealed', 'unreadable', 'deleted'].includes(value.status) || !['native', 'legacy'].includes(value.origin) ||
      (value.origin === 'native' && value.offset !== 0) || (['sealed', 'deleted'].includes(value.status)) !== isHash(value.sha256) && value.status !== 'unreadable' ||
      (value.sha256 !== null && !isHash(value.sha256)) || !plain(value.days)) throw Error('Invalid block entry');
  let sum = 0;
  for (const [day, count] of Object.entries(value.days)) { if (!isDay(day) || !integer(count) || count < 1) throw Error('Invalid block entry'); sum += count; }
  if (sum !== value.count) throw Error('Invalid block entry');
  if (value.count === 0 ? value.oldestTime !== null || value.newestTime !== null : !integer(value.oldestTime) || !integer(value.newestTime)) throw Error('Invalid block entry');
  return { ...value, days: { ...value.days } };
}
// The manifest: blocks in global order, numbers following on without a gap or an overlap; only the last may be open.
function manifestValue(value, record) {
  if (!exact(value, ['version', 'record', 'blocks']) || value.version !== 1 || value.record !== record || !Array.isArray(value.blocks)) throw Error('Invalid manifest');
  const blocks = value.blocks.map(blockEntry);
  blocks.forEach((block, index) => {
    const previous = blocks[index - 1];
    if (block.firstSequence !== (previous ? previous.lastSequence + 1 : 1)) throw Error('Invalid manifest');
    if (block.status === 'open' && index !== blocks.length - 1) throw Error('Invalid manifest');
    if (new Set(blocks.map(item => item.name)).size !== blocks.length) throw Error('Invalid manifest');
  });
  return { version: 1, record, blocks };
}
const lastSequence = manifest => manifest.blocks.length ? manifest.blocks[manifest.blocks.length - 1].lastSequence : 0;
// What the record takes on disk: a deleted block's file is gone.
const totalBytes = manifest => manifest.blocks.reduce((sum, block) => sum + (block.status === 'deleted' ? 0 : block.bytes), 0);

// The directory of one record, made private when missing. Returns its path; never follows a link.
function ensureDirectory(parent, name) {
  const target = path.join(parent, name);
  try { fs.mkdirSync(target, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(target);
  if (!privateDirectory(stat)) throw Error('Unsafe history directory');
  syncDirectory(parent);
  return target;
}
function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
// A directory that may be missing: null when it is, its path when it is a private directory, an error otherwise.
function existingDirectory(parent, name) {
  const target = path.join(parent, name);
  let stat; try { stat = fs.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!privateDirectory(stat)) throw Error('Unsafe history directory');
  return target;
}
// A small private JSON file, or null when it is missing. A link, a shared file or one too large is an error.
function readPrivateJson(file, limit) {
  let named; try { named = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!privateFile(named) || named.size > limit) throw Error('Unsafe history file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!privateFile(stat) || stat.dev !== named.dev || stat.ino !== named.ino || stat.size > limit) throw Error('Unsafe history file');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}
// Written whole: a new private file beside it, synced, then renamed over it, then the directory synced.
function writePrivateJson(directory, name, value) {
  const temp = path.join(directory, `${name}.${randomUUID()}.tmp`), bytes = Buffer.from(JSON.stringify(value));
  let fd;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    let offset = 0;
    while (offset < bytes.length) { const count = fs.writeSync(fd, bytes, offset, bytes.length - offset); if (!Number.isSafeInteger(count) || count <= 0) throw Error('No progress'); offset += count; }
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, path.join(directory, name));
    syncDirectory(directory);
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* Reported by the caller's own failure. */ }
    try { fs.unlinkSync(temp); } catch { /* Renamed, or never made. */ }
  }
}
function removeFile(directory, name) {
  try { fs.unlinkSync(path.join(directory, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  syncDirectory(directory);
}
const sha256 = () => createHash('sha256');

// What the person is reminded of for one record, worked out from its manifest alone: blocks whose newest line is
// older than the age line, a whole that has passed the size line, and blocks that cannot be read. Nothing here is
// polled; the caller asks when it starts, when it seals a block and when something fails.
function reminders(manifest, now) {
  const due = [], cutoff = now - REMIND_AGE_DAYS * DAY_MS;
  const old = manifest.blocks.filter(block => block.status !== 'deleted' && block.count > 0 && block.newestTime !== null && block.newestTime < cutoff);
  if (old.length) due.push({ kind: 'age', blocks: old.length, bytes: old.reduce((sum, block) => sum + block.bytes, 0),
    oldestDay: old.map(block => Object.keys(block.days).sort()[0]).sort()[0], newestDay: old.map(block => Object.keys(block.days).sort().at(-1)).sort().at(-1) });
  const bytes = totalBytes(manifest);
  if (bytes > REMIND_TOTAL_BYTES) due.push({ kind: 'size', bytes, line: REMIND_TOTAL_BYTES });
  const unreadable = manifest.blocks.filter(block => block.status === 'unreadable');
  if (unreadable.length) due.push({ kind: 'unreadable', blocks: unreadable.length, fromSequence: unreadable[0].firstSequence, throughSequence: unreadable.at(-1).lastSequence });
  return due;
}

const dayOf = time => new Date(time).toISOString().slice(0, 10);
const openDayOf = block => parseBlockName(block.name).day;
const presentFile = file => { try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

// A record kept whole in blocks and read back whole at start (the executed-operations record). Each line is
// {"sequence":n,"time":t,"day":"YYYY-MM-DD","value":...}: its number in the whole record, its own time and UTC day,
// and the value, which `check` must accept. Lines are only ever added; a value that changes later is added again,
// and the later line is the one that holds. The open block is sealed with its size and checksum when a line arrives
// on a later UTC day than it was opened, or would take it past its size. Loading reads every block: a sealed block
// that is missing or no longer matches, or a line that does not read, stops the load and the caller fails closed;
// a last line cut short by a stop during an append is left as it is and its block sealed.
class BlockLog {
  #parent; #record; #check; #manifest = { version: 1, record: '', blocks: [] }; #store = null; #failed = false;
  constructor(parent, record, check) {
    if (typeof parent !== 'string' || !path.isAbsolute(parent) || typeof record !== 'string' || !/^[a-z][a-z-]{0,40}$/.test(record) || typeof check !== 'function') throw Error('Invalid block log');
    this.#parent = parent; this.#record = record; this.#check = check; this.#manifest = { version: 1, record, blocks: [] };
  }
  get manifest() { return { version: 1, record: this.#record, blocks: this.#manifest.blocks.map(item => ({ ...item, days: { ...item.days } })) }; }
  get directory() { return this.#store; }
  #existing() { const top = existingDirectory(this.#parent, HISTORY_DIR); return top && existingDirectory(top, this.#record); }
  #write(manifest) { writePrivateJson(this.#store, MANIFEST, { version: 1, record: this.#record, blocks: manifest.blocks }); this.#manifest = manifestValue({ version: 1, record: this.#record, blocks: manifest.blocks }, this.#record); }
  // One block read whole: its values in order and what the manifest says of it.
  #scan(name, first, tail) {
    const file = path.join(this.#store, name), named = fs.lstatSync(file);
    if (!privateFile(named) || named.size > BLOCK_MAX_BYTES) throw Error('Unreadable history block');
    const bytes = fs.readFileSync(file), hash = sha256().update(bytes).digest('hex'), decoder = new TextDecoder('utf-8', { fatal: true });
    const values = [], days = {}; let start = 0, next = first, oldestTime = null, newestTime = null;
    for (;;) {
      const end = bytes.indexOf(10, start);
      if (end === -1) break;
      let line; try { line = JSON.parse(decoder.decode(bytes.subarray(start, end))); } catch { throw Error('Unreadable history block'); }
      if (!exact(line, ['sequence', 'time', 'day', 'value']) || line.sequence !== next || !integer(line.time) || line.day !== dayOf(line.time)) throw Error('Unreadable history block');
      try { this.#check(line.value); } catch { throw Error('Unreadable history block'); }
      values.push(line.value); days[line.day] = (days[line.day] || 0) + 1; next++; start = end + 1;
      oldestTime = oldestTime === null ? line.time : Math.min(oldestTime, line.time); newestTime = newestTime === null ? line.time : Math.max(newestTime, line.time);
    }
    if (start < bytes.length && (!tail || bytes.length - start > BLOCK_MAX_BYTES)) throw Error('Unreadable history block');
    return { values, count: values.length, days, bytes: bytes.length, sha256: hash, oldestTime, newestTime, tail: bytes.length - start };
  }
  #entry(name, first, scan, status) {
    return { name, firstSequence: first, lastSequence: first + scan.count - 1, offset: 0, count: scan.count, bytes: scan.bytes, oldestTime: scan.oldestTime,
      newestTime: scan.newestTime, days: scan.days, sha256: status === 'sealed' ? scan.sha256 : null, status, origin: 'native' };
  }
  // Every value in the record, in order. Called once, at start.
  load() {
    this.#store = this.#existing();
    if (!this.#store) return [];
    let manifest;
    try { const value = readPrivateJson(path.join(this.#store, MANIFEST), MANIFEST_MAX_BYTES); manifest = value === null ? null : manifestValue(value, this.#record); }
    catch (error) { if (!(error instanceof SyntaxError) && !/^Invalid (manifest|block entry)$/.test(error.message)) throw error; manifest = undefined; }
    const names = fs.readdirSync(this.#store).filter(name => parseBlockName(name)).sort((a, b) => parseBlockName(a).firstSequence - parseBlockName(b).firstSequence);
    if (manifest === null && !names.length) return [];
    let changed = false;
    if (!manifest) {
      // Built again from the blocks, every one of which must read; the newest is the one still open.
      manifest = { blocks: [] };
      for (const name of names) {
        const first = lastSequence(manifest) + 1;
        if (parseBlockName(name).firstSequence !== first) throw Error('Unreadable history block');
        const scan = this.#scan(name, first, true);
        if (!scan.count) throw Error('Unreadable history block');
        manifest.blocks.push(this.#entry(name, first, scan, 'sealed'));
      }
      if (manifest.blocks.length) Object.assign(manifest.blocks.at(-1), { status: 'open', sha256: null });
      changed = true;
    }
    const values = [];
    manifest = { blocks: manifest.blocks.map(item => ({ ...item })) };
    for (const [index, block] of manifest.blocks.entries()) {
      if (block.status === 'unreadable') throw Error('Unreadable history block');
      if (block.status === 'deleted') continue;
      if (block.status === 'sealed') {
        const scan = this.#scan(block.name, block.firstSequence, true);
        if (scan.bytes !== block.bytes || scan.sha256 !== block.sha256 || scan.count !== block.count) throw Error('Unreadable history block');
        values.push(...scan.values); continue;
      }
      // The open block: lines past the manifest's count (a stop before it caught up) are taken in; a last line cut
      // short seals it as it is; fewer lines than counted stop the load.
      if (!presentFile(path.join(this.#store, block.name))) { if (block.count) throw Error('Unreadable history block'); manifest.blocks.splice(index, 1); changed = true; break; }
      const scan = this.#scan(block.name, block.firstSequence, true);
      if (scan.count < block.count) throw Error('Unreadable history block');
      if (!scan.count) {
        fs.renameSync(path.join(this.#store, block.name), path.join(this.#store, `${block.name}.${randomUUID()}.torn`)); syncDirectory(this.#store);
        manifest.blocks.splice(index, 1); changed = true; break;
      }
      const entry = this.#entry(block.name, block.firstSequence, scan, scan.tail ? 'sealed' : 'open');
      if (scan.tail || scan.count !== block.count || scan.bytes !== block.bytes) { manifest.blocks[index] = entry; changed = true; }
      values.push(...scan.values);
    }
    if (changed) this.#write(manifest); else this.#manifest = manifestValue({ version: 1, record: this.#record, blocks: manifest.blocks }, this.#record);
    return values;
  }
  // What the deleted blocks held, without their contents: the lists kept beside the manifest when they were deleted.
  // One that is missing stops the load, as a block that cannot be read does.
  kept() {
    const out = [];
    for (const block of this.#manifest.blocks.filter(item => item.status === 'deleted')) {
      let value; try { value = readPrivateJson(path.join(this.#store, `${block.name}.kept.json`), MANIFEST_MAX_BYTES); } catch { value = null; }
      if (!value || value.version !== 1 || value.name !== block.name || !Array.isArray(value.kept) || value.kept.length !== block.count) throw Error('Unreadable history block');
      out.push(...value.kept.map(item => ({ ...item, deletedAt: block.deletedAt })));
    }
    return out;
  }
  // Sealed blocks the person exported and NAW checked, deleted at the person's word: first a list of what each held
  // (`keep` picks what must outlive the contents, such as an operation id), then the manifest marks it deleted, then
  // its file goes. A stop in between leaves the file, already marked deleted and never read again.
  delete(names, keep, now) {
    if (this.#failed) throw Error('History record is unavailable');
    const manifest = { blocks: this.#manifest.blocks.map(item => ({ ...item, days: { ...item.days } })) };
    const chosen = names.map(name => manifest.blocks.find(block => block.name === name && block.status === 'sealed'));
    if (!names.length || chosen.some(block => !block)) throw Error('Only sealed blocks can be deleted');
    const lists = chosen.map(block => {
      const scan = this.#scan(block.name, block.firstSequence, true);
      if (scan.bytes !== block.bytes || scan.sha256 !== block.sha256) throw Error('A block does not match its record');
      return { block, kept: scan.values.map(keep) };
    });
    for (const { block, kept } of lists) writePrivateJson(this.#store, `${block.name}.kept.json`, { version: 1, name: block.name, kept });
    for (const block of chosen) Object.assign(block, { status: 'deleted', deletedAt: now });
    this.#write(manifest);
    for (const block of chosen) removeFile(this.#store, block.name);
    return lists.map(({ block, kept }) => ({ name: block.name, kept }));
  }
  // Values added at the end, each with its own time; written and synced before this returns. A failure leaves the
  // record unusable for this run (the caller fails closed); what reached the disk is taken in at the next start.
  append(items, now) {
    if (this.#failed) throw Error('History record is unavailable');
    if (!Array.isArray(items) || !items.length) return;
    try { this.#append(items, now); } catch (error) { this.#failed = true; throw error; }
  }
  #append(items, now) {
    this.#store ||= ensureDirectory(ensureDirectory(this.#parent, HISTORY_DIR), this.#record);
    let manifest = { blocks: this.#manifest.blocks.map(item => ({ ...item, days: { ...item.days } })) }, sequence = lastSequence(manifest);
    const writeDay = dayOf(now), lines = items.map(item => {
      if (!integer(item.time)) throw Error('Invalid history line');
      this.#check(item.value); sequence++;
      const text = Buffer.from(JSON.stringify({ sequence, time: item.time, day: dayOf(item.time), value: item.value }) + '\n');
      if (text.length > BLOCK_MAX_BYTES) throw Error('History line is too large');
      return { text, time: item.time, day: dayOf(item.time) };
    });
    for (let index = 0; index < lines.length;) {
      let open = manifest.blocks.at(-1)?.status === 'open' ? manifest.blocks.at(-1) : null;
      if (open && (writeDay > openDayOf(open) || open.bytes + lines[index].text.length > BLOCK_MAX_BYTES)) {
        const scan = this.#scan(open.name, open.firstSequence, false);
        if (scan.count !== open.count || scan.bytes !== open.bytes) throw Error('History block changed');
        manifest.blocks[manifest.blocks.length - 1] = this.#entry(open.name, open.firstSequence, scan, 'sealed'); this.#write(manifest); open = null;
      }
      if (!open) {
        const first = lastSequence(manifest) + 1, name = blockName(first, writeDay);
        if (presentFile(path.join(this.#store, name))) throw Error('History block place is taken');
        open = { name, firstSequence: first, lastSequence: first - 1, offset: 0, count: 0, bytes: 0, oldestTime: null, newestTime: null, days: {}, sha256: null, status: 'open', origin: 'native' };
        manifest.blocks.push(open); this.#write(manifest);
      }
      const batch = []; let size = open.bytes;
      while (index < lines.length && size + lines[index].text.length <= BLOCK_MAX_BYTES) { batch.push(lines[index]); size += lines[index].text.length; index++; }
      const bytes = Buffer.concat(batch.map(line => line.text)), file = path.join(this.#store, open.name);
      let fd;
      try {
        fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW | (open.bytes ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL), 0o600);
        const before = fs.fstatSync(fd);
        if (!privateFile(before) || before.size !== open.bytes) throw Error('History block changed');
        let offset = 0;
        while (offset < bytes.length) { const count = fs.writeSync(fd, bytes, offset, bytes.length - offset); if (!Number.isSafeInteger(count) || count <= 0) throw Error('No progress'); offset += count; }
        fs.fsyncSync(fd);
        if (fs.fstatSync(fd).size !== open.bytes + bytes.length) throw Error('History block changed');
      } finally { if (fd !== undefined) fs.closeSync(fd); }
      if (!open.bytes) syncDirectory(this.#store);
      const days = { ...open.days }; for (const line of batch) days[line.day] = (days[line.day] || 0) + 1;
      const times = batch.map(line => line.time);
      Object.assign(open, { lastSequence: open.lastSequence + batch.length, count: open.count + batch.length, bytes: open.bytes + bytes.length, days,
        oldestTime: Math.min(...(open.oldestTime === null ? [] : [open.oldestTime]), ...times), newestTime: Math.max(...(open.newestTime === null ? [] : [open.newestTime]), ...times) });
      this.#write(manifest);
    }
  }
}

module.exports = Object.freeze({ BLOCK_MAX_BYTES, REMIND_AGE_DAYS, REMIND_TOTAL_BYTES, HISTORY_DIR, MANIFEST, INTENT, MANIFEST_MAX_BYTES, INTENT_MAX_BYTES,
  privateFile, privateDirectory, blockName, parseBlockName, blockEntry, manifestValue, lastSequence, totalBytes, isDay, isHash,
  ensureDirectory, existingDirectory, syncDirectory, readPrivateJson, writePrivateJson, removeFile, sha256, reminders, BlockLog });
