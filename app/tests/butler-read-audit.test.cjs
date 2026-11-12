'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { ButlerReadAudit, MAX_PAGES_PER_UTC_DAY } = require('../butler-read-audit.cjs');
const history = require('../record-history.cjs');
const FILE_NAME = 'butler-business-reads.jsonl', DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 11, 23, 59, 59, 999), UUID = '11111111-1111-4111-8111-111111111111';
const code = suffix => error => error.code === (suffix === 'LIMIT' ? 'ERR_BUTLER_READ_LIMIT' : 'ERR_BUTLER_READ_AUDIT_' + suffix);
function page(kind = 'queue', extra = {}) {
  const query = { kind, spaceId: kind === 'spaces' ? null : 'shared', limit: 20,
    ...(kind === 'deliveries' ? { fromTime: NOW - DAY, throughTime: NOW } : {}) };
  const ref = kind === 'spaces' ? 'naw:space:shared' : 'naw:space:shared/' + (kind === 'queue' ? 'item' : 'event') + ':synthetic-id';
  return { actor: { sessionId: 'synthetic-session', nativeId: 'synthetic-native', selectionRevision: 1, runnerRef: 'synthetic-runner' },
    query, result: { count: 1, recordRefs: [ref], scanned: 1, truncated: false }, ...extra };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-read-audit-'));
  const directory = path.join(root, 'private'); fs.mkdirSync(directory, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = NOW;
  const person = Symbol('synthetic person'), options = { authorizePerson: x => x === person, now: () => now };
  const reopen = () => new ButlerReadAudit(directory, options);
  // The single file of earlier versions, and the folder of blocks this version keeps.
  const legacy = path.join(directory, FILE_NAME), store = path.join(directory, 'history', 'butler-reads');
  const manifest = () => JSON.parse(fs.readFileSync(path.join(store, 'manifest.json'), 'utf8'));
  return { root, directory, legacy, store, manifest, lock: legacy + '.lock', person, reopen, audit: reopen(), at: value => { now = value; },
    // The newest block, as the manifest names it.
    get file() { return path.join(store, manifest().blocks.at(-1).name); } };
}
// Every line of the log, block after block.
const logBytes = f => Buffer.concat(f.manifest().blocks.map(block => fs.readFileSync(path.join(f.store, block.name))));
function poison(target, key, hit) {
  Object.defineProperty(target, key, { enumerable: true, configurable: true, get() { hit(); throw Error('synthetic getter executed'); } });
}
// What the person is told of the log's size: there is no cap, only the line at which they are reminded.
function storage(usedBytes, blocks = usedBytes ? 1 : 0, unreadableBlocks = 0) {
  return { usedBytes, remindBytes: 536_870_912, blocks, unreadableBlocks, warning: usedBytes > 536_870_912 };
}
const blocksBytes = f => f.manifest().blocks.reduce((sum, block) => sum + block.bytes, 0);

test('construction creates nothing; an authorized empty read leaves no log and consumes no pages', t => {
  const f = fixture(t);
  assert.equal(MAX_PAGES_PER_UTC_DAY, 64);
  assert.deepEqual(fs.readdirSync(f.directory), []);
  assert.deepEqual(f.audit.read(f.person), { records: [], gaps: [], throughSequence: 0, nextAfterSequence: 0, truncated: false, storage: storage(0) });
  assert.deepEqual(fs.readdirSync(f.directory), []);
  assert.equal(f.audit.recordPage(page()).pageOfDay, 1);
});

test('only metadata is durable, with private permissions and a host receipt that does not claim model delivery', t => {
  const f = fixture(t), input = page();
  const receipt = f.audit.recordPage(input);
  assert.deepEqual(receipt, { sequence: 1, time: NOW, day: '2026-11-11', pageOfDay: 1 });
  assert.deepEqual(fs.readdirSync(f.directory), ['history']);
  assert.deepEqual(fs.readdirSync(f.store).sort(), ['000000001-2026-11-11.jsonl', 'manifest.json']);
  for (const folder of [path.join(f.directory, 'history'), f.store]) assert.equal(fs.statSync(folder).mode & 0o777, 0o700);
  for (const file of [f.file, path.join(f.store, 'manifest.json')]) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // The manifest describes the block and holds no record content.
  assert.equal(JSON.stringify(f.manifest()).includes('synthetic-id'), false);
  const raw = fs.readFileSync(f.file, 'utf8'); assert.ok(raw.endsWith('\n'));
  const record = JSON.parse(raw);
  assert.deepEqual(Object.keys(record).sort(), ['actor', 'day', 'pageOfDay', 'query', 'result', 'sequence', 'time', 'version']);
  assert.deepEqual(record.actor, input.actor); assert.deepEqual(record.query, input.query); assert.deepEqual(record.result, input.result);
  input.actor.nativeId = 'changed'; input.result.recordRefs[0] = 'changed';
  const first = f.audit.read(f.person).records[0]; assert.equal(first.actor.nativeId, 'synthetic-native');
  first.result.recordRefs[0] = 'changed returned data';
  assert.equal(f.reopen().read(f.person).records[0].result.recordRefs[0], 'naw:space:shared/item:synthetic-id');
});

test('a person capability is opaque and checked before touching any log or lock', t => {
  const f = fixture(t); f.audit.recordPage(page());
  let accesses = 0;
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (...args) => { accesses++; return open(...args); });
  for (const person of [undefined, null, 'person', { kind: 'person', approved: true }, Symbol('synthetic person')])
    assert.throws(() => f.audit.read(person), code('PERSON'));
  assert.throws(() => new ButlerReadAudit(f.directory).read(f.person), code('PERSON'));
  assert.equal(accesses, 0);
  const throwing = new ButlerReadAudit(f.directory, { authorizePerson: () => { throw Error('synthetic private reason'); } });
  assert.throws(() => throwing.read(f.person), error => code('PERSON')(error) && !error.message.includes('private'));
});

test('source text, secret/header fields, raw cursors and unknown options cannot enter the log', t => {
  const f = fixture(t), canary = 'SYNTHETIC_PRIVATE_BODY_DO_NOT_STORE';
  const rejected = [
    { ...page(), body: canary },
    { ...page(), actor: { ...page().actor, name: canary } },
    { ...page(), actor: { ...page().actor, header: canary } },
    { ...page(), query: { ...page().query, cursor: canary } },
    { ...page(), query: { ...page().query, env: canary } },
    { ...page(), result: { ...page().result, records: [{ text: canary }] } },
    { ...page(), result: { ...page().result, question: canary } },
    { ...page(), result: { ...page().result, reply: canary } },
    { ...page(), result: { ...page().result, reason: canary } },
    { ...page(), result: { ...page().result, secret: canary } },
    { ...page(), result: { ...page().result, recordRefs: [canary] } },
  ];
  for (const input of rejected) assert.throws(() => f.audit.recordPage(input), code('INPUT'));
  assert.throws(() => new ButlerReadAudit(f.directory, { maxPagesPerUtcDay: 100 }), code('INPUT'));
  assert.deepEqual(fs.readdirSync(f.directory), []);
  f.audit.recordPage(page()); assert.equal(logBytes(f).includes(canary), false); assert.equal(JSON.stringify(f.manifest()).includes(canary), false);
});

test('getters at each input layer, array accessors and hidden/symbol fields are rejected without evaluation', t => {
  const f = fixture(t); let calls = 0;
  for (const [layer, key] of [['root', 'actor'], ['actor', 'nativeId'], ['query', 'limit'], ['result', 'count'], ['refs', '0']]) {
    const input = page(), target = layer === 'root' ? input : layer === 'refs' ? input.result.recordRefs : input[layer];
    poison(target, key, () => calls++);
    assert.throws(() => f.audit.recordPage(input), code('INPUT'));
  }
  const hidden = page(); Object.defineProperty(hidden.result, 'body', { value: 'synthetic', enumerable: false });
  const symbol = page(); symbol.actor[Symbol('synthetic field')] = 'synthetic';
  const sparse = page(); sparse.result.recordRefs = new Array(1);
  const extraArray = page(); extraArray.result.recordRefs.body = 'synthetic';
  const objectRef = page(); objectRef.result.recordRefs[0] = { toJSON() { calls++; return 'synthetic'; } };
  const proxy = page(); proxy.result = new Proxy(proxy.result, { get() { calls++; throw Error('synthetic proxy trap'); } });
  const proxyArray = page(); proxyArray.result.recordRefs = new Proxy(proxyArray.result.recordRefs, { get() { calls++; throw Error('synthetic proxy trap'); } });
  for (const input of [hidden, symbol, sparse, extraArray, objectRef, proxy, proxyArray]) assert.throws(() => f.audit.recordPage(input), code('INPUT'));
  const options = {}; poison(options, 'now', () => calls++);
  assert.throws(() => new ButlerReadAudit(f.directory, options), code('INPUT'));
  assert.equal(calls, 0); assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('actor, query, scan and reference bounds are strict and cannot be expanded by metadata input', t => {
  const f = fixture(t);
  const bad = [
    { ...page(), actor: { ...page().actor, selectionRevision: -1 } },
    { ...page(), actor: { ...page().actor, nativeId: 'contains whitespace' } },
    { ...page(), query: { ...page().query, limit: 51 } },
    { ...page(), query: { ...page().query, limit: 0 } },
    { ...page(), query: { ...page().query, kind: 'nativeHistory' } },
    { ...page(), query: { ...page().query, spaceId: null } },
    { ...page(), query: { ...page('spaces').query, spaceId: 'shared' } },
    { ...page(), query: { ...page().query, includeArchived: true } },
    { ...page(), query: { ...page('deliveries').query, throughTime: NOW - 2 * DAY } },
    { ...page(), result: { ...page().result, count: 0 } },
    { ...page(), result: { ...page().result, scanned: 2001 } },
    { ...page(), result: { ...page().result, scanned: 0 } },
    { ...page(), result: { ...page().result, truncated: 'false' } },
    { ...page(), result: { ...page().result, recordRefs: ['naw:space:shared/event:wrong-kind'] } },
    { ...page(), result: { ...page().result, recordRefs: ['naw:space:' + UUID + '/item:wrong-space'] } },
    { ...page(), result: { ...page().result, recordRefs: ['naw:space:shared/item:%20'] } },
    { ...page(), result: { ...page().result, recordRefs: ['naw:space:shared/item:' + 'x'.repeat(2048)] } },
  ];
  for (const input of bad) assert.throws(() => f.audit.recordPage(input), code('INPUT'));
  assert.deepEqual(fs.readdirSync(f.directory), []);
  for (const kind of ['spaces', 'queue', 'deliveries']) f.audit.recordPage(page(kind));
  assert.equal(f.audit.read(f.person).records.length, 3);
});

test('the maximum fifty refs and two thousand scanned metadata rows remain bounded and retain no bodies', t => {
  const f = fixture(t), input = page(); input.query.limit = 50;
  input.result = { count: 50, scanned: 2000, truncated: true,
    recordRefs: Array.from({ length: 50 }, () => 'naw:space:shared/item:' + encodeURIComponent('测'.repeat(200))) };
  f.audit.recordPage(input);
  assert.ok(fs.statSync(f.file).size < 128 * 1024);
  assert.equal(f.audit.read(f.person).records[0].result.recordRefs.length, 50);
  const over = page(); over.query.limit = 50; over.result.count = 51; over.result.scanned = 51;
  over.result.recordRefs = Array(51).fill('naw:space:shared/item:synthetic');
  assert.throws(() => f.audit.recordPage(over), code('INPUT'));
});

test('sixty-four approved pages is a shared UTC limit across reopening, new roles and native rotations', t => {
  const f = fixture(t);
  for (let n = 1; n <= 64; n++) {
    const input = page(); input.actor.nativeId += '-' + n; input.actor.selectionRevision = n;
    input.actor.runnerRef += '-' + n;
    const receipt = (n % 2 ? f.audit : f.reopen()).recordPage(input);
    assert.equal(receipt.pageOfDay, n); assert.equal(receipt.sequence, n);
  }
  const before = fs.readFileSync(f.file);
  assert.throws(() => f.audit.recordPage(page()), code('LIMIT'));
  assert.throws(() => f.reopen().recordPage(page()), code('LIMIT'));
  assert.deepEqual(fs.readFileSync(f.file), before);
  const first = f.audit.read(f.person), second = f.audit.read(f.person, { afterSequence: first.nextAfterSequence });
  assert.equal(first.records.length, 50); assert.equal(first.truncated, true); assert.equal(first.throughSequence, 64);
  assert.equal(second.records.length, 14); assert.equal(second.truncated, false); assert.equal(second.nextAfterSequence, 64);
  assert.throws(() => f.audit.recordPage(page()), code('LIMIT'));
});

test('empty pages consume one approval and crossing UTC midnight resets only that day, preserving the history', t => {
  const f = fixture(t), empty = page(); empty.result = { count: 0, recordRefs: [], scanned: 0, truncated: false };
  for (let n = 0; n < 64; n++) f.audit.recordPage(empty);
  f.at(NOW + 1);
  assert.deepEqual(f.reopen().recordPage(empty), { sequence: 65, time: NOW + 1, day: '2026-11-12', pageOfDay: 1 });
  f.at(NOW); assert.throws(() => f.reopen().recordPage(empty), code('LIMIT'));
  f.at(NOW + 2); assert.equal(f.audit.recordPage(empty).pageOfDay, 2);
  assert.equal(f.audit.read(f.person, { afterSequence: 64 }).records.length, 2);
});

test('quota reads, writing and durability stay inside one lock; a competing instance cannot take page sixty-five', t => {
  const f = fixture(t); for (let n = 0; n < 63; n++) f.audit.recordPage(page());
  const other = f.reopen(), original = fs.fsyncSync; let attempts = 0;
  t.mock.method(fs, 'fsyncSync', fd => {
    const stat = fs.fstatSync(fd);
    if (stat.isFile() && stat.ino === fs.statSync(f.file).ino) {
      attempts++; assert.ok(fs.existsSync(f.lock)); assert.throws(() => other.recordPage(page()), code('BUSY'));
    }
    return original(fd);
  });
  assert.equal(f.audit.recordPage(page()).pageOfDay, 64); assert.equal(attempts, 1);
  assert.throws(() => other.recordPage(page()), code('LIMIT')); assert.equal(fs.existsSync(f.lock), false);
});

test('person pagination has strict finite options and does not poison later business reads', t => {
  const f = fixture(t); for (let n = 0; n < 3; n++) f.audit.recordPage(page());
  const first = f.audit.read(f.person, { limit: 2 }); assert.deepEqual(first.records.map(r => r.sequence), [1, 2]);
  assert.equal(first.nextAfterSequence, 2); assert.equal(first.truncated, true);
  assert.deepEqual(f.reopen().read(f.person, { afterSequence: 2, limit: 1 }).records.map(r => r.sequence), [3]);
  for (const options of [{ limit: 51 }, { limit: 0 }, { afterSequence: -1 }, { cursor: 'synthetic' }, { afterSequence: 4 }])
    assert.throws(() => f.audit.read(f.person, options), code('INPUT'));
  assert.equal(f.audit.recordPage(page()).pageOfDay, 4);
});

test('unknown lock files and symlinks are preserved; no timeout steals a lock', t => {
  const f = fixture(t); fs.writeFileSync(f.lock, 'synthetic unknown owner', { mode: 0o600 });
  assert.throws(() => f.audit.recordPage(page()), code('BUSY')); assert.throws(() => f.audit.read(f.person), code('BUSY'));
  assert.equal(fs.readFileSync(f.lock, 'utf8'), 'synthetic unknown owner'); assert.equal(fs.existsSync(path.join(f.directory, 'history')), false);
  fs.unlinkSync(f.lock); const target = path.join(f.root, 'lock-target'); fs.writeFileSync(target, 'synthetic untouched'); fs.symlinkSync(target, f.lock);
  assert.throws(() => f.audit.recordPage(page()), code('BUSY')); assert.equal(fs.lstatSync(f.lock).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'synthetic untouched');
});

test('cleanup does not delete a replacement lock inode or return a successful page', t => {
  const f = fixture(t), original = fs.fsyncSync; let changed = false;
  t.mock.method(fs, 'fsyncSync', fd => {
    if (!changed && fs.fstatSync(fd).isFile()) {
      changed = true; fs.unlinkSync(f.lock); fs.writeFileSync(f.lock, 'synthetic replacement lock', { mode: 0o600 });
    }
    return original(fd);
  });
  assert.throws(() => f.audit.recordPage(page()), error => code('STATE')(error) || code('WRITE')(error));
  assert.equal(changed, true); assert.equal(fs.readFileSync(f.lock, 'utf8'), 'synthetic replacement lock');
  assert.throws(() => f.audit.recordPage(page()), code('STATE'));
});

test('unsafe directories, replaced directories and symlink roots cannot acquire an audit', t => {
  const f = fixture(t), link = path.join(f.root, 'link'); fs.symlinkSync(f.directory, link);
  assert.throws(() => new ButlerReadAudit(link), code('STATE'));
  fs.chmodSync(f.directory, 0o750); assert.throws(() => f.audit.recordPage(page()), code('STATE'));
  fs.chmodSync(f.directory, 0o700);
  const other = f.reopen(); fs.renameSync(f.directory, f.directory + '-old'); fs.mkdirSync(f.directory, { mode: 0o700 });
  assert.throws(() => other.recordPage(page()), code('STATE')); assert.deepEqual(fs.readdirSync(f.directory), []);
});

// One line of the older single file, as an earlier version wrote it.
function legacyLine(sequence, time, pageOfDay, input = page()) {
  return JSON.stringify({ version: 1, sequence, time, day: new Date(time).toISOString().split('T')[0], pageOfDay, ...input }) + '\n';
}
// The same damage to one stored line, whichever file it is in.
function damage(kind, bytes) {
  const row = JSON.parse(bytes);
  if (kind === 'torn') return bytes.subarray(0, bytes.length - 1);
  if (kind === 'blank') return Buffer.from('\n');
  if (kind === 'invalid-json') return Buffer.from('{invalid}\n');
  if (kind === 'sequence') row.sequence = 2;
  if (kind === 'day') row.day = '2026-11-12';
  if (kind === 'pageOfDay') row.pageOfDay = 2;
  if (kind === 'body') row.result.body = 'synthetic forbidden body';
  if (kind === 'invalid-utf8') return Buffer.from([0xff, 10]);
  return Buffer.from(JSON.stringify(row) + '\n');
}

test('log symlinks, hardlinks and non-private permissions fail closed without altering their targets', async t => {
  for (const kind of ['symlink', 'hardlink', 'permissions']) await t.test(kind, t => {
    // An older single file like that is never taken in, and nothing is made.
    const f = fixture(t), target = path.join(f.root, 'target');
    fs.writeFileSync(target, legacyLine(1, NOW, 1), { mode: 0o600 }); const original = fs.readFileSync(target);
    if (kind === 'symlink') fs.symlinkSync(target, f.legacy);
    if (kind === 'hardlink') fs.linkSync(target, f.legacy);
    if (kind === 'permissions') { fs.renameSync(target, f.legacy); fs.chmodSync(f.legacy, 0o640); }
    assert.throws(() => f.reopen().recordPage(page()), code('STATE'));
    assert.deepEqual(fs.readFileSync(kind === 'permissions' ? f.legacy : target), original);
    assert.equal(fs.existsSync(f.lock), false); assert.equal(fs.existsSync(path.join(f.directory, 'history')), false);
    // A block like that: the instance that wrote it refuses; a new one sets it aside, still counts its page, and goes
    // on in a new block. Neither touches what the block points at.
    const g = fixture(t); g.audit.recordPage(page()); const block = g.file, before = fs.readFileSync(block), aside = path.join(g.root, 'target');
    if (kind === 'symlink') { fs.renameSync(block, aside); fs.symlinkSync(aside, block); }
    if (kind === 'hardlink') fs.linkSync(block, aside);
    if (kind === 'permissions') fs.chmodSync(block, 0o640);
    assert.throws(() => g.audit.recordPage(page()), code('STATE'));
    assert.deepEqual(g.reopen().recordPage(page()), { sequence: 2, time: NOW, day: '2026-11-11', pageOfDay: 2 });
    assert.deepEqual(fs.readFileSync(kind === 'symlink' ? aside : block), before);
    assert.deepEqual(g.manifest().blocks.map(entry => [entry.name, entry.status]), [['000000001-2026-11-11.jsonl', 'unreadable'], ['000000002-2026-11-11.jsonl', 'open']]);
    assert.equal(fs.existsSync(g.lock), false);
  });
});

test('a foreign log owner is refused even with safe mode and syntax', t => {
  const f = fixture(t); fs.writeFileSync(f.legacy, legacyLine(1, NOW, 1), { mode: 0o600 });
  const g = fixture(t); g.audit.recordPage(page());
  const original = fs.fstatSync, inodes = [fs.statSync(f.legacy).ino, fs.statSync(g.file).ino];
  t.mock.method(fs, 'fstatSync', fd => {
    const stat = original(fd); return inodes.includes(stat.ino) ? Object.assign(Object.create(stat), { uid: stat.uid + 1 }) : stat;
  });
  assert.throws(() => f.reopen().recordPage(page()), code('STATE'));
  // A block of another owner is never read or written; its page still counts.
  assert.equal(g.reopen().recordPage(page()).pageOfDay, 2);
  t.mock.restoreAll(); assert.equal(g.manifest().blocks[0].status, 'unreadable');
});

test('a known non-regular log is refused before open, and log opens retain NONBLOCK against path-swap FIFOs', async t => {
  for (const alias of [false, true]) await t.test(alias ? 'symlink ancestor directory' : 'temporary directory', t => {
    const f = fixture(t);
    let directory = f.directory;
    if (alias) {
      const link = path.join(f.root, 'ancestor-alias'); fs.symlinkSync(f.root, link);
      directory = path.join(link, 'private');
      assert.notEqual(directory, fs.realpathSync(directory));
    }
    const canonicalFile = path.join(fs.realpathSync(directory), FILE_NAME);
    const makeAudit = () => new ButlerReadAudit(directory, { now: () => NOW });
    const audit = makeAudit(); fs.mkdirSync(f.legacy, { mode: 0o700 });
    let opened = 0, inspected = 0;
    const open = fs.openSync, lstat = fs.lstatSync;
    t.mock.method(fs, 'lstatSync', (...args) => { if (args[0] === canonicalFile) inspected++; return lstat(...args); });
    t.mock.method(fs, 'openSync', (...args) => { if (args[0] === canonicalFile) opened++; return open(...args); });
    assert.throws(() => audit.recordPage(page()), code('STATE'));
    assert.ok(inspected > 0, 'the canonical log path was actually inspected before rejection');
    assert.equal(opened, 0);
    t.mock.restoreAll(); fs.rmdirSync(f.legacy);
    const clean = makeAudit(); clean.recordPage(page());
    const canonicalBlock = path.join(fs.realpathSync(directory), 'history', 'butler-reads', '000000001-2026-11-11.jsonl');
    const observedFlags = [];
    t.mock.method(fs, 'openSync', (...args) => {
      if (args[0] === canonicalBlock) { observedFlags.push(args[1]); assert.ok(args[1] & fs.constants.O_NONBLOCK); }
      return open(...args);
    });
    clean.recordPage(page());
    assert.equal(observedFlags.length, 2, 'both the read and append open must be intercepted');
    assert.equal(observedFlags[0] & fs.constants.O_APPEND, 0);
    assert.ok(observedFlags[1] & fs.constants.O_APPEND);
  });
});

test('torn, invalid, non-contiguous and metadata-forged records never become a fresh zero-day count', async t => {
  for (const kind of ['torn', 'blank', 'invalid-json', 'sequence', 'day', 'pageOfDay', 'body', 'invalid-utf8']) await t.test(kind, t => {
    // An older single file like that is never taken in: nothing is written and nothing is read.
    const f = fixture(t), bytes = damage(kind, Buffer.from(legacyLine(1, NOW, 1)));
    fs.writeFileSync(f.legacy, bytes, { mode: 0o600 });
    const reopened = f.reopen(); assert.throws(() => reopened.recordPage(page()), code('STATE'));
    assert.deepEqual(fs.readFileSync(f.legacy), bytes); assert.throws(() => reopened.read(f.person), code('STATE'));
    assert.equal(fs.existsSync(path.join(f.directory, 'history')), false);
    // The same damage in a block: it is kept as it is and set aside, and its page still counts.
    const g = fixture(t); g.audit.recordPage(page()); const block = g.file, damaged = damage(kind, fs.readFileSync(block));
    fs.writeFileSync(block, damaged);
    const next = g.reopen(); assert.equal(next.recordPage(page()).pageOfDay, 2); assert.deepEqual(fs.readFileSync(block), damaged);
    const read = next.read(g.person);
    assert.deepEqual([read.gaps, read.records.map(row => row.sequence), read.storage.unreadableBlocks], [[{ fromSequence: 1, throughSequence: 1, count: 1, days: ['2026-11-11'] }], [2], 1]);
    // With the manifest gone as well the day's count cannot be known: nothing is let through, and nothing rewritten.
    const h = fixture(t); h.audit.recordPage(page()); const lone = h.file; fs.writeFileSync(lone, damaged); fs.rmSync(path.join(h.store, 'manifest.json'));
    assert.throws(() => h.reopen().recordPage(page()), code('STATE')); assert.deepEqual(fs.readFileSync(lone), damaged);
    assert.throws(() => h.reopen().read(h.person), code('STATE'));
  });
});

test('an oversized file or record is rejected before any append, with no truncation', async t => {
  for (const kind of ['file', 'record']) await t.test(kind, t => {
    const f = fixture(t); fs.writeFileSync(f.legacy, '', { mode: 0o600 });
    if (kind === 'file') fs.truncateSync(f.legacy, 32 * 1024 * 1024 + 1);
    else fs.writeFileSync(f.legacy, 'x'.repeat(128 * 1024) + '\n');
    const size = fs.statSync(f.legacy).size;
    assert.throws(() => f.audit.recordPage(page()), code(kind === 'file' ? 'CAPACITY' : 'STATE'));
    assert.equal(fs.statSync(f.legacy).size, size); assert.equal(fs.existsSync(f.lock), false);
  });
});

test('removing or truncating a previously observed log is not treated as a new quota', async t => {
  for (const kind of ['remove', 'truncate', 'folder']) await t.test(kind, t => {
    const f = fixture(t); f.audit.recordPage(page()); const block = f.file;
    if (kind === 'remove') fs.unlinkSync(block); else if (kind === 'truncate') fs.truncateSync(block, 0); else fs.rmSync(path.join(f.directory, 'history'), { recursive: true });
    assert.throws(() => f.audit.recordPage(page()), code('STATE'));
    assert.equal(fs.existsSync(block), kind === 'truncate');
    // A new instance has no memory of what was there: it goes by the manifest, which still counts the page.
    if (kind !== 'folder') assert.equal(f.reopen().recordPage(page()).pageOfDay, 2);
  });
});

test('partial writes expose only fixed failure codes, poison that writer and retain torn evidence across restart', t => {
  const f = fixture(t); f.audit.recordPage(page()); const original = fs.writeSync; let count = 0;
  t.mock.method(fs, 'writeSync', (fd, buffer, offset, length, ...rest) => {
    if (++count === 1) return original(fd, buffer, offset, Math.min(length, 17), ...rest);
    throw Object.assign(Error('SYNTHETIC_PRIVATE_FILESYSTEM_ERROR'), { path: f.file });
  });
  assert.throws(() => f.audit.recordPage(page()), error => code('WRITE')(error) && error.message === error.code && !Object.hasOwn(error, 'path'));
  assert.equal(fs.existsSync(f.lock), false); t.mock.restoreAll();
  assert.throws(() => f.audit.recordPage(page()), code('STATE'));
  // After a restart the torn block is kept as it is and set aside. The page that tore was never approved: it does not
  // count, and the one before it still does.
  const block = f.file, torn = fs.readFileSync(block), reopened = f.reopen(), read = reopened.read(f.person);
  assert.deepEqual([read.records, read.gaps], [[], [{ fromSequence: 1, throughSequence: 1, count: 1, days: ['2026-11-11'] }]]);
  assert.deepEqual(fs.readFileSync(block), torn); assert.equal(reopened.recordPage(page()).pageOfDay, 2);
});

test('fsync failure never returns success, and a surviving complete intent conservatively still consumes quota', t => {
  const f = fixture(t); f.audit.recordPage(page());
  t.mock.method(fs, 'fsyncSync', () => { throw Error('synthetic storage failure'); });
  assert.throws(() => f.audit.recordPage(page()), code('WRITE')); t.mock.restoreAll();
  assert.throws(() => f.audit.recordPage(page()), code('STATE'));
  // The line reached the block before the manifest counted it; the next reader takes it in.
  assert.equal(f.manifest().blocks[0].count, 1);
  const reopened = f.reopen(), rows = reopened.read(f.person).records;
  assert.equal(rows.length, 2); assert.equal(reopened.recordPage(page()).pageOfDay, 3); assert.equal(f.manifest().blocks[0].count, 3);
});

test('no-progress writes fail rather than looping or returning an approval', async t => {
  for (const where of ['manifest', 'block']) await t.test(where, t => {
    const f = fixture(t); if (where === 'block') f.audit.recordPage(page());
    const before = where === 'block' ? fs.statSync(f.file).size : 0;
    t.mock.method(fs, 'writeSync', () => 0);
    assert.throws(() => f.audit.recordPage(page()), code('WRITE'));
    t.mock.restoreAll();
    if (where === 'manifest') assert.equal(fs.existsSync(path.join(f.store, '000000001-2026-11-11.jsonl')), false);
    else assert.equal(fs.statSync(f.file).size, before);
    assert.equal(fs.existsSync(f.lock), false);
  });
});

// Sixteen sealed blocks of a full 32 MiB each, as sparse files the manifest describes: the log is exactly at the
// reminder line. Nothing reads them unless a person's read reaches them.
function atTheLine(f) {
  fs.mkdirSync(path.join(f.directory, 'history'), { mode: 0o700 }); fs.mkdirSync(f.store, { mode: 0o700 });
  const blocks = [];
  for (let n = 0; n < 16; n++) {
    const time = NOW - (40 - n) * DAY, day = new Date(time).toISOString().slice(0, 10), name = history.blockName(n + 1, day), file = path.join(f.store, name);
    fs.writeFileSync(file, '', { mode: 0o600 }); fs.truncateSync(file, 32 * 1024 * 1024);
    blocks.push({ name, firstSequence: n + 1, lastSequence: n + 1, offset: 0, count: 1, bytes: 32 * 1024 * 1024, oldestTime: time, newestTime: time,
      days: { [day]: 1 }, sha256: 'a'.repeat(64), status: 'sealed', origin: 'native' });
  }
  fs.writeFileSync(path.join(f.store, 'manifest.json'), JSON.stringify({ version: 1, record: 'butler-reads', blocks }), { mode: 0o600 });
  return 16 * 32 * 1024 * 1024;
}

test('human storage status uses actual byte counts, stays separate from page receipts, and has five fixed metadata fields', t => {
  const f = fixture(t); assert.deepEqual(f.audit.read(f.person).storage, storage(0));
  const receipt = f.audit.recordPage(page());
  assert.deepEqual(Object.keys(receipt).sort(), ['day', 'pageOfDay', 'sequence', 'time']);
  const result = f.audit.read(f.person);
  assert.deepEqual(result.storage, storage(fs.statSync(f.file).size));
  assert.deepEqual(Object.keys(result.storage).sort(), ['blocks', 'remindBytes', 'unreadableBlocks', 'usedBytes', 'warning']);
  result.storage.usedBytes = -1; assert.deepEqual(f.audit.read(f.person).storage, storage(fs.statSync(f.file).size));
  for (const option of [{ warningThresholdBytes: 1 }, { remindBytes: 1 }, { blockMaxBytes: 1 }]) assert.throws(() => new ButlerReadAudit(f.directory, option), code('INPUT'));
  // The numbers are the shared module's: the person's 0.5 GiB and 30 days, and 32 MiB to a block.
  assert.deepEqual([history.REMIND_TOTAL_BYTES, history.REMIND_AGE_DAYS, history.BLOCK_MAX_BYTES], [536_870_912, 30, 33_554_432]);
});

test('a durable crossing of the reminder line warns once after unlock; a new reader can warn again without consuming a page', t => {
  const f = fixture(t), line = atTheLine(f), notices = [];
  const audit = new ButlerReadAudit(f.directory, { authorizePerson: value => value === f.person, now: () => NOW,
    onCapacityWarning: value => {
      assert.equal(fs.existsSync(f.lock), false, 'the callback cannot run while the audit is locked');
      assert.deepEqual(value, storage(blocksBytes(f), f.manifest().blocks.length)); assert.equal(Object.isFrozen(value), true);
      assert.equal(Reflect.set(value, 'usedBytes', -1), false); notices.push(value);
    } });
  assert.equal(audit.read(f.person, { afterSequence: 16, limit: 1 }).storage.warning, false, 'At the line is not past it'); assert.equal(notices.length, 0);
  const receipt = audit.recordPage(page());
  assert.equal(receipt.pageOfDay, 1, 'old UTC days do not consume the current day');
  assert.equal(receipt.sequence, 17); assert.equal(notices.length, 1); assert.ok(notices[0].usedBytes > line);
  assert.equal(audit.recordPage(page()).pageOfDay, 2); assert.equal(notices.length, 1);
  const nextNotices = [], reopened = new ButlerReadAudit(f.directory, { authorizePerson: value => value === f.person,
    onCapacityWarning: value => nextNotices.push(value) });
  const read = reopened.read(f.person, { afterSequence: 16, limit: 2 });
  assert.deepEqual(read.storage, storage(blocksBytes(f), 17)); assert.equal(nextNotices.length, 1);
  assert.notEqual(nextNotices[0], read.storage); assert.equal(Object.isFrozen(nextNotices[0]), true);
  assert.deepEqual(read.records.map(row => row.pageOfDay), [1, 2]);
  reopened.read(f.person, { afterSequence: 16, limit: 1 }); assert.equal(nextNotices.length, 1);
  // Past the line nothing is refused and nothing removed: the line only reminds.
  assert.equal(f.manifest().blocks.length, 17); assert.ok(f.manifest().blocks.every(block => fs.existsSync(path.join(f.store, block.name))));
});

test('warning callback errors and rejected promises cannot change a successful read or write or its storage status', async t => {
  const f = fixture(t); atTheLine(f);
  let syncCalls = 0;
  const writer = new ButlerReadAudit(f.directory, { now: () => NOW, onCapacityWarning: () => { syncCalls++; throw Error('synthetic callback failure'); } });
  assert.equal(writer.recordPage(page()).pageOfDay, 1); assert.equal(syncCalls, 1);
  let asyncCalls = 0;
  const reader = new ButlerReadAudit(f.directory, { authorizePerson: value => value === f.person,
    onCapacityWarning: async () => { asyncCalls++; throw Error('synthetic asynchronous callback failure'); } });
  const result = reader.read(f.person, { afterSequence: 16, limit: 1 });
  assert.deepEqual(result.storage, storage(blocksBytes(f), 17)); assert.equal(asyncCalls, 1);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(reader.read(f.person, { afterSequence: 16, limit: 1 }).storage.warning, true); assert.equal(asyncCalls, 1);
});

test('uncertain writes and failed lock cleanup never call a capacity callback or claim an approved page', async t => {
  for (const fault of ['fsync', 'unlock']) await t.test(fault, t => {
    // Already past the line, with today's block open: the faulting page is appended to it.
    const f = fixture(t); atTheLine(f); f.reopen().recordPage(page());
    const block = f.file, size = fs.statSync(block).size;
    let called = 0;
    const audit = new ButlerReadAudit(f.directory, { now: () => NOW, onCapacityWarning: () => called++ });
    if (fault === 'fsync') t.mock.method(fs, 'fsyncSync', () => { throw Error('synthetic fsync failure'); });
    else {
      const unlink = fs.unlinkSync, canonicalLock = path.join(fs.realpathSync(f.directory), FILE_NAME + '.lock');
      t.mock.method(fs, 'unlinkSync', file => { if (file === canonicalLock) throw Error('synthetic cleanup failure'); return unlink(file); });
    }
    assert.throws(() => audit.recordPage(page()), code(fault === 'fsync' ? 'WRITE' : 'STATE'));
    assert.equal(called, 0); t.mock.restoreAll();
    assert.ok(fs.statSync(block).size > size, 'failure did not roll back or truncate the complete intent');
  });
});

test('a quota-rejected page above the storage threshold emits no warning event and adds no failed-attempt record', t => {
  const f = fixture(t); atTheLine(f); const writer = f.reopen();
  for (let n = 1; n <= 64; n++) writer.recordPage(page());
  const block = f.file, size = fs.statSync(block).size, manifest = fs.readFileSync(path.join(f.store, 'manifest.json'));
  let calls = 0;
  const audit = new ButlerReadAudit(f.directory, { now: () => NOW, onCapacityWarning: () => calls++ });
  assert.throws(() => audit.recordPage(page()), code('LIMIT'));
  assert.equal(calls, 0); assert.equal(fs.statSync(block).size, size); assert.deepEqual(fs.readFileSync(path.join(f.store, 'manifest.json')), manifest);
  assert.equal(fs.existsSync(f.lock), false);
});

// Blocks and the older single file (the person, 2026-11-11: keep everything, in blocks by day).

test('an older single file is taken in whole as the first block on first use, bytes unchanged, and its pages count', t => {
  const f = fixture(t), lines = legacyLine(1, NOW - DAY, 1) + legacyLine(2, NOW, 1) + legacyLine(3, NOW, 2);
  fs.writeFileSync(f.legacy, lines, { mode: 0o600 });
  // Construction does not take it in; the first locked use does, also a person's read.
  f.reopen(); assert.equal(fs.existsSync(path.join(f.directory, 'history')), false);
  assert.deepEqual(f.audit.read(f.person).records.map(row => row.sequence), [1, 2, 3]);
  assert.equal(fs.existsSync(f.legacy), false);
  assert.deepEqual(fs.readdirSync(f.store).sort(), ['000000001-2026-11-10.jsonl', 'manifest.json']);
  assert.equal(fs.readFileSync(path.join(f.store, '000000001-2026-11-10.jsonl'), 'utf8'), lines, 'The same bytes, moved');
  assert.deepEqual(f.manifest().blocks.map(block => [block.status, block.origin, block.offset, block.count, block.days]), [['sealed', 'legacy', 0, 3, { '2026-11-10': 1, '2026-11-11': 2 }]]);
  // Its two pages of today count: the next is the third, in a new block.
  assert.deepEqual(f.audit.recordPage(page()), { sequence: 4, time: NOW, day: '2026-11-11', pageOfDay: 3 });
  assert.deepEqual(fs.readdirSync(f.store).sort(), ['000000001-2026-11-10.jsonl', '000000004-2026-11-11.jsonl', 'manifest.json']);
  // An empty older file holds nothing: it is removed and there is no log.
  const g = fixture(t); fs.writeFileSync(g.legacy, '', { mode: 0o600 });
  assert.equal(g.audit.read(g.person).throughSequence, 0); assert.deepEqual(fs.readdirSync(g.directory), []);
});

test('a single file an older version wrote after going back is taken in after everything, numbered on, and never resets a day', t => {
  const f = fixture(t); for (let n = 0; n < 3; n++) f.audit.recordPage(page());
  // The older version found no file (it was taken in), started its own at 1 and counted today from 1.
  let lines = ''; for (let n = 1; n <= 60; n++) lines += legacyLine(n, NOW, n);
  fs.writeFileSync(f.legacy, lines, { mode: 0o600 });
  const reopened = f.reopen();
  // 3 + 60 pages today: one more is let through, then the day is over.
  assert.deepEqual(reopened.recordPage(page()), { sequence: 64, time: NOW, day: '2026-11-11', pageOfDay: 64 });
  assert.throws(() => reopened.recordPage(page()), code('LIMIT'));
  assert.deepEqual(f.manifest().blocks.map(block => [block.name, block.status, block.origin, block.offset, block.firstSequence, block.lastSequence]), [
    ['000000001-2026-11-11.jsonl', 'sealed', 'native', 0, 1, 3], ['000000004-2026-11-11.jsonl', 'sealed', 'legacy', 3, 4, 63], ['000000064-2026-11-11.jsonl', 'open', 'native', 0, 64, 64]]);
  assert.equal(fs.readFileSync(path.join(f.store, '000000004-2026-11-11.jsonl'), 'utf8'), lines, 'Its bytes are not renumbered');
  // The person pages through one numbering, without a repeat or a hole.
  const first = reopened.read(f.person), second = reopened.read(f.person, { afterSequence: first.nextAfterSequence });
  assert.deepEqual([...first.records, ...second.records].map(row => row.sequence), Array.from({ length: 64 }, (_, n) => n + 1));
  // Already past the day's count, an older file of the same day is still taken in and still counts.
  fs.writeFileSync(f.legacy, legacyLine(1, NOW, 1), { mode: 0o600 });
  assert.throws(() => f.reopen().recordPage(page()), code('LIMIT')); assert.equal(f.manifest().blocks.at(-1).origin, 'legacy');
});

test('a taking-in that stopped half way is finished from where it stopped, and a record of it that does not match stops everything', async t => {
  for (const stop of ['before-move', 'after-move', 'mismatch', 'moved-mismatch']) await t.test(stop, t => {
    const f = fixture(t); f.audit.recordPage(page());
    const lines = legacyLine(1, NOW, 1) + legacyLine(2, NOW, 2); fs.writeFileSync(f.legacy, lines, { mode: 0o600 });
    // What the interrupted version had written: the plan, and maybe the move.
    const writer = f.reopen(), open = f.manifest().blocks[0];
    const sealed = { ...open, status: 'sealed', sha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(f.file)).digest('hex') };
    fs.writeFileSync(path.join(f.store, 'manifest.json'), JSON.stringify({ version: 1, record: 'butler-reads', blocks: [sealed] }), { mode: 0o600 });
    const entry = { name: '000000002-2026-11-11.jsonl', firstSequence: 2, lastSequence: 3, offset: 1, count: 2, bytes: Buffer.byteLength(lines), oldestTime: NOW, newestTime: NOW,
      days: { '2026-11-11': 2 }, sha256: require('node:crypto').createHash('sha256').update(lines).digest('hex'), status: 'sealed', origin: 'legacy' };
    if (stop === 'mismatch' || stop === 'moved-mismatch') entry.bytes += 1;
    fs.writeFileSync(path.join(f.store, 'migration.json'), JSON.stringify({ version: 1, record: 'butler-reads', entry }), { mode: 0o600 });
    if (stop === 'after-move' || stop === 'moved-mismatch') fs.renameSync(f.legacy, path.join(f.store, entry.name));
    if (stop === 'moved-mismatch') {
      // Moved already, and what is in its place is not what the plan says: nothing is committed or started over it.
      assert.throws(() => writer.recordPage(page()), code('STATE')); assert.equal(fs.existsSync(path.join(f.store, 'migration.json')), true);
      assert.deepEqual(f.manifest().blocks.map(block => block.name), ['000000001-2026-11-11.jsonl']); return;
    }
    if (stop === 'mismatch') {
      assert.throws(() => writer.recordPage(page()), code('STATE')); assert.equal(fs.existsSync(path.join(f.store, 'migration.json')), true);
      assert.equal(fs.readFileSync(f.legacy, 'utf8'), lines); return;
    }
    assert.equal(writer.recordPage(page()).pageOfDay, 4);
    assert.equal(fs.existsSync(path.join(f.store, 'migration.json')), false); assert.equal(fs.existsSync(f.legacy), false);
    assert.deepEqual(f.manifest().blocks.map(block => [block.name, block.status]), [['000000001-2026-11-11.jsonl', 'sealed'], [entry.name, 'sealed'], ['000000004-2026-11-11.jsonl', 'open']]);
  });
});

test('a log put back to an earlier state under the running app stops it, and does not give the day back', t => {
  const f = fixture(t); f.audit.recordPage(page());
  const earlier = new Map(fs.readdirSync(f.store).map(name => [name, fs.readFileSync(path.join(f.store, name))]));
  // The next day's page seals the first block and opens another, which the running app is now writing.
  f.at(NOW + DAY); f.audit.recordPage(page()); assert.equal(f.manifest().blocks.length, 2);
  for (const name of fs.readdirSync(f.store)) fs.rmSync(path.join(f.store, name));
  for (const [name, bytes] of earlier) fs.writeFileSync(path.join(f.store, name), bytes, { mode: 0o600 });
  assert.throws(() => f.audit.read(f.person), code('STATE'), 'One line it wrote is gone');
  assert.throws(() => f.audit.recordPage(page()), code('STATE'), 'Its page is not numbered again');
});

test('a new UTC day seals the block; a sealed block that no longer matches is one gap, and today goes on', t => {
  const f = fixture(t); f.audit.recordPage(page()); f.audit.recordPage(page());
  f.at(NOW + DAY); f.audit.recordPage(page());
  const [first, second] = f.manifest().blocks;
  assert.deepEqual([first.name, first.status, first.count, Boolean(first.sha256), second.name, second.status], ['000000001-2026-11-11.jsonl', 'sealed', 2, true, '000000003-2026-11-12.jsonl', 'open']);
  // The clock back on an earlier day: the line goes into the open block, and that day's count goes on.
  f.at(NOW); assert.deepEqual(f.audit.recordPage(page()), { sequence: 4, time: NOW, day: '2026-11-11', pageOfDay: 3 });
  assert.equal(f.manifest().blocks.length, 2);
  // An old block changed on disk: shown as one gap with its days, the rest read, and today unaffected.
  fs.appendFileSync(path.join(f.store, first.name), 'x');
  f.at(NOW + DAY);
  const read = f.reopen().read(f.person);
  assert.deepEqual(read.gaps, [{ fromSequence: 1, throughSequence: 2, count: 2, days: ['2026-11-11'] }]); assert.deepEqual(read.records.map(row => row.sequence), [3, 4]);
  assert.equal(f.reopen().recordPage(page()).pageOfDay, 2);
  assert.equal(f.manifest().blocks[0].status, 'unreadable');
  // Put back other than it was sealed, it stays a gap; put back exactly, it reads again, also for the instance
  // that set it aside, and it is no longer counted as unreadable.
  const audit = f.reopen(); assert.equal(audit.read(f.person).gaps.length, 1);
  fs.truncateSync(path.join(f.store, first.name), first.bytes - 1); fs.appendFileSync(path.join(f.store, first.name), '}');
  assert.equal(audit.read(f.person).gaps.length, 1); assert.equal(f.manifest().blocks[0].status, 'unreadable');
  fs.truncateSync(path.join(f.store, first.name), first.bytes - 1); fs.appendFileSync(path.join(f.store, first.name), '\n');
  const again = audit.read(f.person);
  assert.deepEqual([again.gaps, again.records.map(row => row.sequence), f.manifest().blocks[0].status, again.storage.unreadableBlocks], [[], [1, 2, 3, 4, 5], 'sealed', 0]);
  // Changed on disk and still well formed, it no longer matches its checksum: a gap, not a quietly different record.
  const text = fs.readFileSync(path.join(f.store, first.name), 'utf8'), edited = text.replace(/"time":(\d+)/, (_, value) => `"time":${Number(value) - 1}`);
  assert.notEqual(edited, text); assert.equal(edited.length, text.length);
  fs.writeFileSync(path.join(f.store, first.name), edited, { mode: 0o600 });
  assert.deepEqual(f.reopen().read(f.person).gaps, [{ fromSequence: 1, throughSequence: 2, count: 2, days: ['2026-11-11'] }]);
});

test('a block opened for a line that was never written is dropped on the next day, not sealed empty', t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.directory, 'history'), { mode: 0o700 }); fs.mkdirSync(f.store, { mode: 0o700 });
  const empty = { name: '000000001-2026-11-11.jsonl', firstSequence: 1, lastSequence: 0, offset: 0, count: 0, bytes: 0, oldestTime: null, newestTime: null, days: {}, sha256: null, status: 'open', origin: 'native' };
  for (const made of [false, true]) {
    fs.writeFileSync(path.join(f.store, 'manifest.json'), JSON.stringify({ version: 1, record: 'butler-reads', blocks: [empty] }), { mode: 0o600 });
    if (made) fs.writeFileSync(path.join(f.store, empty.name), '', { mode: 0o600 });
    f.at(NOW + DAY * (made ? 2 : 1)); const audit = f.reopen();
    assert.deepEqual(audit.recordPage(page()), { sequence: 1, time: NOW + DAY * (made ? 2 : 1), day: made ? '2026-11-13' : '2026-11-12', pageOfDay: 1 });
    assert.deepEqual(f.manifest().blocks.map(block => [block.name, block.count, block.status]), [[made ? '000000001-2026-11-13.jsonl' : '000000001-2026-11-12.jsonl', 1, 'open']]);
    assert.equal(fs.existsSync(path.join(f.store, empty.name)), false); assert.equal(f.reopen().read(f.person).throughSequence, 1);
    for (const name of fs.readdirSync(f.store)) fs.rmSync(path.join(f.store, name));
  }
});

test('a line written before the manifest caught up is taken in and counts; a manifest that is lost is built again from the blocks', t => {
  const f = fixture(t); f.audit.recordPage(page()); const manifest = fs.readFileSync(path.join(f.store, 'manifest.json'));
  f.audit.recordPage(page()); fs.writeFileSync(path.join(f.store, 'manifest.json'), manifest);
  assert.equal(f.reopen().recordPage(page()).pageOfDay, 3); assert.equal(f.manifest().blocks[0].count, 3);
  f.at(NOW + DAY); f.audit.recordPage(page());
  const before = f.manifest();
  for (const loss of ['missing', 'unreadable']) {
    if (loss === 'missing') fs.rmSync(path.join(f.store, 'manifest.json')); else fs.writeFileSync(path.join(f.store, 'manifest.json'), '{broken', { mode: 0o600 });
    assert.equal(f.reopen().read(f.person).throughSequence, 4 + (loss === 'unreadable' ? 1 : 0));
    assert.deepEqual(f.manifest().blocks.map(block => [block.name, block.count, block.days]), before.blocks.map(block => [block.name, block.count + (loss === 'unreadable' && block.status === 'open' ? 1 : 0), loss === 'unreadable' && block.status === 'open' ? { '2026-11-12': 2 } : block.days]));
    if (loss === 'missing') assert.equal(f.reopen().recordPage(page()).pageOfDay, 2);
  }
});

test('a person\'s page is bounded by its limit across blocks and gaps, and its cursor goes past a gap', t => {
  const f = fixture(t);
  for (let day = 0; day < 3; day++) { f.at(NOW + day * DAY); for (let n = 0; n < 3; n++) f.audit.recordPage(page()); }
  fs.appendFileSync(path.join(f.store, f.manifest().blocks[1].name), 'x');
  const reader = f.reopen(), seen = [];
  let after = 0, pages = 0;
  for (;;) {
    const result = reader.read(f.person, { afterSequence: after, limit: 2 }); pages++;
    assert.ok(result.records.length + result.gaps.reduce((sum, gap) => sum + gap.count, 0) <= 2);
    seen.push(...result.records.map(row => row.sequence), ...result.gaps.map(gap => `${gap.fromSequence}-${gap.throughSequence}`));
    if (!result.truncated) break; after = result.nextAfterSequence;
  }
  // Two positions a page: [1, 2], [3, 4-4], [5-6], [7, 8], [9]. A gap takes its positions like lines do.
  assert.deepEqual(seen, [1, 2, 3, '4-4', '5-6', 7, 8, 9]); assert.equal(pages, 5);
});

test('a block with no room left is sealed and the next line opens another block the same day', t => {
  const f = fixture(t), large = page(); large.query.limit = 50;
  large.result = { count: 50, scanned: 50, truncated: false, recordRefs: Array.from({ length: 50 }, (_, n) => 'naw:space:shared/item:' + encodeURIComponent('测'.repeat(197) + String(n).padStart(3, '0'))) };
  // Earlier days written into today's block (the clock had gone back), until it is nearly full.
  const lines = []; let size = 0, sequence = 0;
  for (let day = 200; size < 32 * 1024 * 1024 - 300_000; day--) for (let n = 1; n <= 64 && size < 32 * 1024 * 1024 - 300_000; n++) {
    const line = Buffer.from(legacyLine(++sequence, NOW - day * DAY, n, large)); lines.push(line); size += line.length;
  }
  fs.mkdirSync(path.join(f.directory, 'history'), { mode: 0o700 }); fs.mkdirSync(f.store, { mode: 0o700 });
  const bytes = Buffer.concat(lines), days = {};
  for (const line of lines) { const day = JSON.parse(line).day; days[day] = (days[day] || 0) + 1; }
  fs.writeFileSync(path.join(f.store, '000000001-2026-11-11.jsonl'), bytes, { mode: 0o600 });
  fs.writeFileSync(path.join(f.store, 'manifest.json'), JSON.stringify({ version: 1, record: 'butler-reads', blocks: [{ name: '000000001-2026-11-11.jsonl', firstSequence: 1, lastSequence: sequence,
    offset: 0, count: sequence, bytes: bytes.length, oldestTime: NOW - 200 * DAY, newestTime: JSON.parse(lines.at(-1)).time, days, sha256: null, status: 'open', origin: 'native' }] }), { mode: 0o600 });
  const audit = f.reopen();
  for (let n = 1; f.manifest().blocks.length === 1; n++) assert.equal(audit.recordPage(large).pageOfDay, n);
  const [full, next] = f.manifest().blocks;
  assert.deepEqual([full.status, next.name.endsWith('-2026-11-11.jsonl'), next.status], ['sealed', true, 'open']);
  assert.ok(full.bytes <= 32 * 1024 * 1024 && full.bytes + fs.statSync(path.join(f.store, next.name)).size > 32 * 1024 * 1024);
});
