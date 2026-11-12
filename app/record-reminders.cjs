'use strict';
// What the bell reminds the person of, and what they can do about it (the person, 2026-11-11: 「超过 30 天/或者整个记录
// 大小超过 0.5G 这样的，界面有个小铃铛弹提醒，看如何处理」; design section 9, taken as recommended on 2026-11-11:
// each record counted on its own; "知道了" holds until the same condition gets one notch worse; export copies blocks
// as they are and checks them). Worked out from each record's manifest only, when asked: nothing here polls, and
// nothing here deletes, compresses or merges a block.
const fs = require('node:fs');
const path = require('node:path');
const history = require('./record-history.cjs');

// The butler's own record (steward step 2, batch 1) is kept and reminded of the same way.
const RECORDS = Object.freeze(['operations', 'butler-reads', 'steward']);
const KINDS = Object.freeze(['age', 'size', 'unreadable', 'unavailable']);
const ACKNOWLEDGED = 'reminders.json', ACKNOWLEDGED_MAX_BYTES = 64 * 1024;
const record = value => { if (!RECORDS.includes(value)) throw Error('Unknown record'); return value; };
const storeOf = (dataDir, name) => path.join(dataDir, history.HISTORY_DIR, record(name));

// A record's manifest: empty when the record has no blocks yet, null when it cannot be read.
function manifestOf(dataDir, name) {
  let top, store;
  try { top = history.existingDirectory(dataDir, history.HISTORY_DIR); store = top && history.existingDirectory(top, record(name)); } catch { return null; }
  if (!store) return { version: 1, record: name, blocks: [] };
  try { const value = history.readPrivateJson(path.join(store, history.MANIFEST), history.MANIFEST_MAX_BYTES); return value === null ? { version: 1, record: name, blocks: [] } : history.manifestValue(value, name); }
  catch { return null; }
}
// Older single files kept beside the blocks count toward the size of the record they came from.
function keptBytes(dataDir, name) {
  let total = 0;
  try { for (const entry of fs.readdirSync(storeOf(dataDir, name))) if (/^legacy-\d{4}\.json$/.test(entry)) total += fs.lstatSync(path.join(storeOf(dataDir, name), entry)).size; }
  catch { /* No folder yet. */ }
  return total;
}
function acknowledged(dataDir) {
  try {
    const top = history.existingDirectory(dataDir, history.HISTORY_DIR); if (!top) return {};
    const value = history.readPrivateJson(path.join(top, ACKNOWLEDGED), ACKNOWLEDGED_MAX_BYTES);
    if (!value || value.version !== 1 || !value.acknowledged || typeof value.acknowledged !== 'object') return {};
    return Object.fromEntries(Object.entries(value.acknowledged).filter(([key, level]) => new RegExp(`^(${RECORDS.join('|')}):(${KINDS.join('|')})$`).test(key) && Number.isSafeInteger(level) && level >= 0));
  } catch { return {}; }
}

// For each record: its blocks, size, oldest day and the reminders due. A reminder is shown when its level (how many
// blocks are past 30 days; how many 0.5 GiB the whole has passed; how many blocks cannot be read) is above the level
// the person last acknowledged. `unavailable` maps a record the app could not load at start to why ('history' or 'other').
function status(dataDir, now, { unavailable = {} } = {}) {
  const seen = acknowledged(dataDir), records = []; let cleared = false;
  for (const name of RECORDS) {
    const manifest = manifestOf(dataDir, name), items = [], bytes = history.totalBytes({ blocks: manifest ? manifest.blocks : [] }) + keptBytes(dataDir, name);
    if (!manifest) items.push({ kind: 'unreadable', level: 1, blocks: 0, manifest: true });
    else {
      // The size line is on everything the record keeps, an older version's file beside the blocks included.
      const found = history.reminders(manifest, now), size = bytes > history.REMIND_TOTAL_BYTES ? [{ kind: 'size', bytes, line: history.REMIND_TOTAL_BYTES }] : [];
      for (const item of [...found.filter(entry => entry.kind === 'age'), ...size, ...found.filter(entry => entry.kind === 'unreadable')]) {
        // One notch: another 0.5 GiB; another 30 blocks past 30 days (about a month, not every day); one more unreadable block.
        const level = item.kind === 'size' ? Math.floor(item.bytes / history.REMIND_TOTAL_BYTES) : item.kind === 'age' ? Math.ceil(item.blocks / 30) : item.blocks;
        items.push({ ...item, level });
      }
      if (Object.hasOwn(unavailable, name)) items.push({ kind: 'unavailable', level: 1, cause: unavailable[name] === 'history' ? 'history' : 'other' });
    }
    const blocks = manifest ? manifest.blocks : [];
    const days = blocks.flatMap(block => Object.keys(block.days)).sort();
    for (const item of items) item.shown = item.level > (seen[`${name}:${item.kind}`] ?? 0);
    // "知道了" lasts while its condition does: once it is no longer due, the next time is a new one.
    for (const kind of KINDS) if (Object.hasOwn(seen, `${name}:${kind}`) && !items.some(item => item.kind === kind)) { delete seen[`${name}:${kind}`]; cleared = true; }
    records.push({ record: name, blocks: blocks.length, bytes, oldestDay: days[0] || null, items });
  }
  if (cleared) try { history.writePrivateJson(history.existingDirectory(dataDir, history.HISTORY_DIR), ACKNOWLEDGED, { version: 1, acknowledged: seen }); } catch { /* Kept as it was; asked again next time. */ }
  return { records, count: records.reduce((sum, item) => sum + item.items.filter(entry => entry.shown).length, 0) };
}
// "知道了": this reminder stays put until its level rises above what it is now.
function acknowledge(dataDir, name, kind, level) {
  if (!KINDS.includes(kind) || !Number.isSafeInteger(level) || level < 0) throw Error('Invalid reminder');
  const top = history.ensureDirectory(dataDir, history.HISTORY_DIR), value = acknowledged(dataDir), key = `${record(name)}:${kind}`;
  value[key] = Math.max(value[key] ?? 0, level);
  history.writePrivateJson(top, ACKNOWLEDGED, { version: 1, acknowledged: value });
}
// The sealed blocks of a record, for the person to choose what to export. The open block is still being written.
function blocks(dataDir, name, now) {
  record(name);
  const manifest = manifestOf(dataDir, name);
  if (!manifest) throw Error('The record cannot be read');
  const cutoff = now - history.REMIND_AGE_DAYS * 24 * 3600 * 1000;
  return manifest.blocks.filter(block => block.status === 'sealed').map(block => {
    const days = Object.keys(block.days).sort();
    return { name: block.name, first: days[0], last: days.at(-1), count: block.count, bytes: block.bytes, old: block.newestTime !== null && block.newestTime < cutoff };
  });
}
// A copy is a file of its own: not a link, and not the block itself under another name.
function separateCopy(file, source) {
  let stat; try { stat = fs.lstatSync(file); } catch { return false; }
  return stat.isFile() && !stat.isSymbolicLink() && !(stat.dev === source.dev && stat.ino === source.ino);
}
// Each chosen sealed block copied, as it is, into <folder>/<record>/, never over a different file, then read back and
// checked against the size and checksum the manifest holds. Nothing in NAW's own folder changes.
function exportBlocks(dataDir, name, names, folder) {
  record(name);
  if (!Array.isArray(names) || !names.length || names.length > 4096 || new Set(names).size !== names.length) throw Error('Choose the blocks to export');
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw Error('Choose a folder');
  const resolved = fs.realpathSync(folder), data = fs.realpathSync(dataDir);
  if (!fs.statSync(resolved).isDirectory()) throw Error('Choose a folder');
  if (resolved === data || resolved.startsWith(data + path.sep)) throw Error('Export goes outside NAW\'s own folder');
  const manifest = manifestOf(dataDir, name);
  if (!manifest) throw Error('The record cannot be read');
  const chosen = names.map(item => manifest.blocks.find(block => block.name === item && block.status === 'sealed'));
  if (chosen.some(block => !block)) throw Error('Only sealed blocks can be exported');
  const target = path.join(resolved, name);
  try { fs.mkdirSync(target, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!fs.lstatSync(target).isDirectory()) throw Error('Choose a folder');
  const exported = [];
  for (const block of chosen) {
    const from = path.join(storeOf(dataDir, name), block.name), to = path.join(target, block.name);
    const source = fs.lstatSync(from);
    if (!history.privateFile(source) || source.size !== block.bytes) throw Error('A block does not match its record');
    try { fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); fs.chmodSync(to, 0o600); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!separateCopy(to, source)) throw Error(`The copy of ${block.name} does not match; nothing more is exported`);
    const copy = fs.readFileSync(to);
    if (copy.length !== block.bytes || history.sha256().update(copy).digest('hex') !== block.sha256) throw Error(`The copy of ${block.name} does not match; nothing more is exported`);
    const fd = fs.openSync(to, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    exported.push({ name: block.name, bytes: block.bytes });
  }
  history.syncDirectory(target);
  return { folder: target, exported, bytes: exported.reduce((sum, item) => sum + item.bytes, 0) };
}
// The copies of these blocks in `folder` are there and still match the record (size and checksum), checked again
// right before the person can remove the blocks from NAW.
function verifyExport(dataDir, name, names, folder) {
  record(name);
  const manifest = manifestOf(dataDir, name);
  if (!manifest || !Array.isArray(names) || !names.length) throw Error('The record cannot be read');
  for (const item of names) {
    const block = manifest.blocks.find(entry => entry.name === item && entry.status === 'sealed');
    if (!block) throw Error('Only sealed blocks can be removed');
    let source; try { source = fs.lstatSync(path.join(storeOf(dataDir, name), item)); } catch { throw Error('The record cannot be read'); }
    if (!separateCopy(path.join(folder, item), source)) throw Error(`The exported copy of ${item} is not there`);
    let copy; try { copy = fs.readFileSync(path.join(folder, item)); } catch { throw Error(`The exported copy of ${item} is not there`); }
    if (copy.length !== block.bytes || history.sha256().update(copy).digest('hex') !== block.sha256) throw Error(`The exported copy of ${item} does not match`);
  }
  return true;
}
// Where a record's blocks are, for the person to look (the block itself when it is there).
function location(dataDir, name, block) {
  const store = storeOf(dataDir, name);
  if (typeof block === 'string' && history.parseBlockName(block) && fs.existsSync(path.join(store, block))) return path.join(store, block);
  return fs.existsSync(store) ? store : path.join(dataDir, history.HISTORY_DIR);
}

module.exports = Object.freeze({ RECORDS, KINDS, status, acknowledge, blocks, exportBlocks, verifyExport, location });
