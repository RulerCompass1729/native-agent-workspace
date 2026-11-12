// The shared rules for records kept whole, in blocks: names, the manifest, private files and the reminders.
// Synthetic values only; nothing is started and no model is called.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const history = require('../record-history.cjs');

const DAY = 24 * 3600 * 1000, NOW = Date.UTC(2026, 10, 11, 9, 30), MIB = 1024 * 1024;
const block = (first, count, day, extra = {}) => ({ name: history.blockName(first, day), firstSequence: first, lastSequence: first + count - 1, offset: 0, count,
  bytes: count * 100, oldestTime: count ? Date.parse(day + 'T01:00:00Z') : null, newestTime: count ? Date.parse(day + 'T02:00:00Z') : null,
  days: count ? { [day]: count } : {}, sha256: 'a'.repeat(64), status: 'sealed', origin: 'native', ...extra });
const manifest = blocks => ({ version: 1, record: 'butler-reads', blocks });
function folder(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-record-history-')); fs.chmodSync(dir, 0o700); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('the lines the person set are the shared ones', () => {
  assert.deepEqual([history.REMIND_AGE_DAYS, history.REMIND_TOTAL_BYTES, history.BLOCK_MAX_BYTES], [30, 512 * MIB, 32 * MIB]);
  assert.ok(Object.isFrozen(history));
});

test('a block is named by the number of its first line and the UTC day it was opened, and only such names are blocks', () => {
  assert.equal(history.blockName(1, '2026-11-11'), '000000001-2026-11-11.jsonl');
  assert.equal(history.blockName(1234567890, '2026-11-11'), '1234567890-2026-11-11.jsonl');
  assert.deepEqual(history.parseBlockName('000000059-2026-11-12.jsonl'), { firstSequence: 59, day: '2026-11-12' });
  for (const name of ['00000001-2026-11-11.jsonl', '000000000-2026-11-11.jsonl', '000000001-2026-02-30.jsonl', '000000001-2026-11-11.json', '0000000001-2026-11-11.jsonl',
    'manifest.json', 'migration.json', '../000000001-2026-11-11.jsonl', null, 7]) assert.equal(history.parseBlockName(name), null, String(name));
  for (const [first, day] of [[0, '2026-11-11'], [1.5, '2026-11-11'], [-1, '2026-11-11'], [1e12, '2026-11-11'], [1, '2026-13-01'], [1, 'today']]) assert.throws(() => history.blockName(first, day));
});

test('a manifest is accepted only when its blocks follow on without a gap or overlap and only the last is open', () => {
  const two = [block(1, 2, '2026-11-10'), block(3, 1, '2026-11-11', { status: 'open', sha256: null })];
  assert.deepEqual(history.manifestValue(manifest(two), 'butler-reads').blocks.map(item => item.name), ['000000001-2026-11-10.jsonl', '000000003-2026-11-11.jsonl']);
  assert.equal(history.lastSequence(history.manifestValue(manifest(two), 'butler-reads')), 3);
  assert.equal(history.totalBytes(history.manifestValue(manifest(two), 'butler-reads')), 300);
  // A block set aside as unreadable keeps its counts, with or without its checksum.
  assert.doesNotThrow(() => history.manifestValue(manifest([block(1, 2, '2026-11-10', { status: 'unreadable' }), block(3, 1, '2026-11-11', { status: 'unreadable', sha256: null })]), 'butler-reads'));
  // A single file taken in from an older version is numbered after what came before it.
  assert.doesNotThrow(() => history.manifestValue(manifest([block(1, 2, '2026-11-10'), block(3, 60, '2026-11-11', { offset: 2, origin: 'legacy' })]), 'butler-reads'));
  const bad = {
    'another record': [manifest(two), 'operations'], 'version 2': [{ ...manifest(two), version: 2 }], 'an extra key': [{ ...manifest(two), extra: 1 }],
    'starts after 1': [manifest([block(2, 1, '2026-11-11')])], 'a hole': [manifest([block(1, 2, '2026-11-10'), block(4, 1, '2026-11-11')])],
    'an overlap': [manifest([block(1, 2, '2026-11-10'), block(2, 1, '2026-11-11')])], 'open in the middle': [manifest([block(1, 2, '2026-11-10', { status: 'open', sha256: null }), block(3, 1, '2026-11-11')])],
    'sealed without a checksum': [manifest([block(1, 2, '2026-11-10', { sha256: null })])], 'open with a checksum': [manifest([block(1, 2, '2026-11-10', { status: 'open' })])],
    'days that do not add up': [manifest([block(1, 2, '2026-11-10', { days: { '2026-11-10': 1 } })])], 'a count that does not match': [manifest([block(1, 2, '2026-11-10', { lastSequence: 3 })])],
    'a name that does not match': [manifest([block(1, 2, '2026-11-10', { firstSequence: 2, lastSequence: 3 })])], 'a native block with an offset': [manifest([block(2, 1, '2026-11-10', { offset: 1 })])],
    'a block over its size': [manifest([block(1, 2, '2026-11-10', { bytes: 32 * MIB + 1 })])], 'an unknown status': [manifest([block(1, 2, '2026-11-10', { status: 'archived' })])],
    'a missing key': [manifest([(({ origin, ...rest }) => rest)(block(1, 2, '2026-11-10'))])], 'not an object': ['manifest'],
  };
  for (const [label, [value, record = 'butler-reads']] of Object.entries(bad)) assert.throws(() => history.manifestValue(value, record), /Invalid/, label);
});

test('private files are written whole and read back only when private, small and not a link', t => {
  const dir = folder(t), store = history.ensureDirectory(dir, 'history');
  assert.equal(fs.statSync(store).mode & 0o777, 0o700); assert.equal(history.existingDirectory(dir, 'missing'), null);
  history.writePrivateJson(store, 'manifest.json', { a: 1 });
  assert.deepEqual(history.readPrivateJson(path.join(store, 'manifest.json'), 1024), { a: 1 });
  assert.equal(fs.statSync(path.join(store, 'manifest.json')).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(store), ['manifest.json'], 'No temporary file is left beside it');
  assert.equal(history.readPrivateJson(path.join(store, 'missing.json'), 1024), null);
  assert.throws(() => history.readPrivateJson(path.join(store, 'manifest.json'), 4), /Unsafe/, 'Too large');
  fs.chmodSync(path.join(store, 'manifest.json'), 0o644); assert.throws(() => history.readPrivateJson(path.join(store, 'manifest.json'), 1024), /Unsafe/, 'Shared');
  fs.chmodSync(path.join(store, 'manifest.json'), 0o600); fs.symlinkSync(path.join(store, 'manifest.json'), path.join(store, 'link.json'));
  assert.throws(() => history.readPrivateJson(path.join(store, 'link.json'), 1024), /Unsafe/, 'A link');
  fs.chmodSync(store, 0o755); assert.throws(() => history.existingDirectory(dir, 'history'), /Unsafe/, 'A shared directory');
  fs.chmodSync(store, 0o700); history.removeFile(store, 'link.json'); history.removeFile(store, 'link.json');
  assert.deepEqual(fs.readdirSync(store), ['manifest.json']);
});

test('the reminders are worked out from the manifest alone: blocks past 30 days, a whole past 0.5 GiB, blocks that cannot be read', () => {
  const day = time => new Date(time).toISOString().slice(0, 10);
  const at = (first, time, extra = {}) => block(first, 1, day(time), { oldestTime: time, newestTime: time, ...extra });
  assert.deepEqual(history.reminders(manifest([]), NOW), []);
  // The age line is on a block's newest line: 30 days and a minute ago is past it, exactly 30 days is not.
  const old = [at(1, NOW - 40 * DAY), at(2, NOW - 30 * DAY - 60000), at(3, NOW - 30 * DAY), at(4, NOW - DAY, { status: 'open', sha256: null })];
  assert.deepEqual(history.reminders(manifest(old), NOW), [{ kind: 'age', blocks: 2, bytes: 200, oldestDay: day(NOW - 40 * DAY), newestDay: day(NOW - 30 * DAY - 60000) }]);
  // The size line: exactly 0.5 GiB is not past it, one byte more is.
  const sized = bytes => manifest([at(1, NOW - DAY, { bytes: 32 * MIB }), at(2, NOW, { bytes: bytes - 32 * MIB, status: 'open', sha256: null })]);
  assert.deepEqual(history.reminders(sized(512 * MIB), NOW), []);
  assert.deepEqual(history.reminders(sized(512 * MIB + 1), NOW), [{ kind: 'size', bytes: 512 * MIB + 1, line: 512 * MIB }]);
  // Blocks that cannot be read, by the numbers they hold.
  const damaged = manifest([at(1, NOW - DAY, { status: 'unreadable' }), at(2, NOW - DAY), at(3, NOW, { status: 'unreadable', sha256: null })]);
  assert.deepEqual(history.reminders(damaged, NOW), [{ kind: 'unreadable', blocks: 2, fromSequence: 1, throughSequence: 3 }]);
});

test('a block log adds lines to the open block, seals it on a later UTC day, and reads every line back in order', t => {
  const dir = folder(t), check = value => { if (!value || typeof value.id !== 'string') throw Error('bad'); };
  const log = new history.BlockLog(dir, 'operations', check), day1 = Date.UTC(2026, 10, 1, 12), day2 = day1 + DAY;
  assert.deepEqual(log.load(), []); assert.equal(fs.existsSync(path.join(dir, 'history')), false, 'Loading makes nothing');
  log.append([{ time: day1 - DAY, value: { id: 'a' } }, { time: day1, value: { id: 'b' } }], day1);
  log.append([{ time: day2, value: { id: 'c' } }], day2);
  const again = new history.BlockLog(dir, 'operations', check);
  assert.deepEqual(again.load().map(value => value.id), ['a', 'b', 'c']);
  assert.deepEqual(again.manifest.blocks.map(block => [block.name, block.status, block.count, block.days]), [
    ['000000001-2026-11-01.jsonl', 'sealed', 2, { '2026-10-31': 1, '2026-11-01': 1 }], ['000000003-2026-11-02.jsonl', 'open', 1, { '2026-11-02': 1 }]]);
  assert.throws(() => again.append([{ time: day2, value: { id: 7 } }], day2), /bad/, 'A value the record does not accept is not written');
  assert.throws(() => again.append([{ time: day2, value: { id: 'd' } }], day2), /unavailable/, 'After a failure the log stays closed for this run');
  assert.deepEqual(new history.BlockLog(dir, 'operations', check).load().map(value => value.id), ['a', 'b', 'c']);
});

test('a block log keeps a cut-short last line and seals its block, builds a lost manifest again, and stops on anything else', t => {
  const dir = folder(t), check = () => {}, day1 = Date.UTC(2026, 10, 1, 12);
  const log = new history.BlockLog(dir, 'operations', check); log.append([{ time: day1, value: { id: 'a' } }], day1);
  const store = path.join(dir, 'history', 'operations'), open = path.join(store, '000000001-2026-11-01.jsonl');
  fs.appendFileSync(open, '{"sequence":2,"ti'); const cut = fs.readFileSync(open);
  const reopened = new history.BlockLog(dir, 'operations', check);
  assert.deepEqual(reopened.load().map(value => value.id), ['a']); assert.deepEqual(fs.readFileSync(open), cut, 'Left as it is');
  assert.equal(reopened.manifest.blocks[0].status, 'sealed');
  reopened.append([{ time: day1, value: { id: 'b' } }], day1);
  assert.deepEqual(reopened.manifest.blocks.map(block => block.name), ['000000001-2026-11-01.jsonl', '000000002-2026-11-01.jsonl'], 'Nothing follows the cut-short line');
  // A manifest that does not parse is built again from the blocks.
  fs.writeFileSync(path.join(store, 'manifest.json'), '{broken', { mode: 0o600 });
  assert.deepEqual(new history.BlockLog(dir, 'operations', check).load().map(value => value.id), ['a', 'b']);
  // A sealed block changed, a block missing, or a manifest that cannot be opened safely stops the load.
  fs.writeFileSync(open, Buffer.concat([cut, Buffer.from('x')]), { mode: 0o600 });
  assert.throws(() => new history.BlockLog(dir, 'operations', check).load(), /Unreadable/);
  fs.writeFileSync(open, cut, { mode: 0o600 }); fs.chmodSync(path.join(store, 'manifest.json'), 0o644);
  assert.throws(() => new history.BlockLog(dir, 'operations', check).load(), /Unsafe/);
  fs.chmodSync(path.join(store, 'manifest.json'), 0o600); fs.rmSync(path.join(store, '000000002-2026-11-01.jsonl'));
  assert.throws(() => new history.BlockLog(dir, 'operations', check).load(), /Unreadable/);
});

test('a block log deletes only sealed blocks that match, keeps a list without contents first, and never reads them again', t => {
  const dir = folder(t), check = () => {}, day1 = Date.UTC(2026, 10, 1, 12);
  const log = new history.BlockLog(dir, 'operations', check);
  log.append([{ time: day1, value: { id: 'a', body: 'secret a' } }, { time: day1, value: { id: 'b', body: 'secret b' } }], day1);
  log.append([{ time: day1 + DAY, value: { id: 'c', body: 'secret c' } }], day1 + DAY);
  const store = path.join(dir, 'history', 'operations'), [first, open] = log.manifest.blocks.map(block => block.name);
  assert.throws(() => log.delete([open], value => ({ id: value.id }), day1 + DAY), /sealed/, 'Never the block being written');
  assert.deepEqual(log.delete([first], value => ({ id: value.id }), day1 + 2 * DAY), [{ name: first, kept: [{ id: 'a' }, { id: 'b' }] }]);
  assert.equal(fs.existsSync(path.join(store, first)), false);
  assert.equal(fs.readFileSync(path.join(store, first + '.kept.json'), 'utf8').includes('secret'), false, 'The list holds no contents');
  const again = new history.BlockLog(dir, 'operations', check);
  assert.deepEqual(again.load().map(value => value.id), ['c']);
  assert.deepEqual(again.kept(), [{ id: 'a', deletedAt: day1 + 2 * DAY }, { id: 'b', deletedAt: day1 + 2 * DAY }]);
  assert.deepEqual(again.manifest.blocks.map(block => [block.status, block.count, history.totalBytes({ blocks: [block] })]), [['deleted', 2, 0], ['open', 1, again.manifest.blocks[1].bytes]]);
  assert.deepEqual(history.reminders(again.manifest, day1 + 40 * DAY).map(item => [item.kind, item.blocks]), [['age', 1]], 'A deleted block is not reminded of');
  // The list gone too: what those ids were cannot be known, and the load stops.
  fs.rmSync(path.join(store, first + '.kept.json'));
  const lost = new history.BlockLog(dir, 'operations', check); lost.load(); assert.throws(() => lost.kept(), /Unreadable/);
});
