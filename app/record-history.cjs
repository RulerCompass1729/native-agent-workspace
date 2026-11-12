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
const BLOCK_KEYS = ['name', 'firstSequence', 'lastSequence', 'offset', 'count', 'bytes', 'oldestTime', 'newestTime', 'days', 'sha256', 'status', 'origin'];
function blockEntry(value) {
  if (!exact(value, BLOCK_KEYS)) throw Error('Invalid block entry');
  const parsed = parseBlockName(value.name);
  if (!parsed || value.firstSequence !== parsed.firstSequence || !integer(value.lastSequence) || !integer(value.offset) || value.offset >= value.firstSequence ||
      !integer(value.count) || value.lastSequence !== value.firstSequence + value.count - 1 || !integer(value.bytes) || value.bytes > BLOCK_MAX_BYTES ||
      !['open', 'sealed', 'unreadable'].includes(value.status) || !['native', 'legacy'].includes(value.origin) ||
      (value.origin === 'native' && value.offset !== 0) || (value.status === 'sealed') !== isHash(value.sha256) && value.status !== 'unreadable' ||
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
const totalBytes = manifest => manifest.blocks.reduce((sum, block) => sum + block.bytes, 0);

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
  const old = manifest.blocks.filter(block => block.count > 0 && block.newestTime !== null && block.newestTime < cutoff);
  if (old.length) due.push({ kind: 'age', blocks: old.length, bytes: old.reduce((sum, block) => sum + block.bytes, 0),
    oldestDay: old.map(block => Object.keys(block.days).sort()[0]).sort()[0], newestDay: old.map(block => Object.keys(block.days).sort().at(-1)).sort().at(-1) });
  const bytes = totalBytes(manifest);
  if (bytes > REMIND_TOTAL_BYTES) due.push({ kind: 'size', bytes, line: REMIND_TOTAL_BYTES });
  const unreadable = manifest.blocks.filter(block => block.status === 'unreadable');
  if (unreadable.length) due.push({ kind: 'unreadable', blocks: unreadable.length, fromSequence: unreadable[0].firstSequence, throughSequence: unreadable.at(-1).lastSequence });
  return due;
}

module.exports = Object.freeze({ BLOCK_MAX_BYTES, REMIND_AGE_DAYS, REMIND_TOTAL_BYTES, HISTORY_DIR, MANIFEST, INTENT, MANIFEST_MAX_BYTES, INTENT_MAX_BYTES,
  privateFile, privateDirectory, blockName, parseBlockName, blockEntry, manifestValue, lastSequence, totalBytes, isDay, isHash,
  ensureDirectory, existingDirectory, syncDirectory, readPrivateJson, writePrivateJson, removeFile, sha256, reminders });
