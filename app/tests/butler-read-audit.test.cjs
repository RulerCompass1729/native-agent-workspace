'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { ButlerReadAudit, MAX_PAGES_PER_UTC_DAY } = require('../butler-read-audit.cjs');
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
  const file = path.join(directory, FILE_NAME);
  return { root, directory, file, lock: file + '.lock', person, reopen, audit: reopen(), at: value => { now = value; } };
}
function poison(target, key, hit) {
  Object.defineProperty(target, key, { enumerable: true, configurable: true, get() { hit(); throw Error('synthetic getter executed'); } });
}
function storage(usedBytes) {
  return { usedBytes, maxBytes: 33_554_432, remainingBytes: 33_554_432 - usedBytes,
    warningThresholdBytes: 25_165_824, warning: usedBytes >= 25_165_824 };
}

test('construction creates nothing; an authorized empty read leaves no log and consumes no pages', t => {
  const f = fixture(t);
  assert.equal(MAX_PAGES_PER_UTC_DAY, 64);
  assert.deepEqual(fs.readdirSync(f.directory), []);
  assert.deepEqual(f.audit.read(f.person), { records: [], throughSequence: 0, nextAfterSequence: 0, truncated: false, storage: storage(0) });
  assert.deepEqual(fs.readdirSync(f.directory), []);
  assert.equal(f.audit.recordPage(page()).pageOfDay, 1);
});

test('only metadata is durable, with private permissions and a host receipt that does not claim model delivery', t => {
  const f = fixture(t), input = page();
  const receipt = f.audit.recordPage(input);
  assert.deepEqual(receipt, { sequence: 1, time: NOW, day: '2026-11-11', pageOfDay: 1 });
  assert.deepEqual(fs.readdirSync(f.directory), [FILE_NAME]);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
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
  f.audit.recordPage(page()); assert.equal(fs.readFileSync(f.file, 'utf8').includes(canary), false);
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
  assert.equal(fs.readFileSync(f.lock, 'utf8'), 'synthetic unknown owner'); assert.equal(fs.existsSync(f.file), false);
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

test('log symlinks, hardlinks and non-private permissions fail closed without altering their targets', async t => {
  for (const kind of ['symlink', 'hardlink', 'permissions']) await t.test(kind, t => {
    const f = fixture(t); f.audit.recordPage(page()); const original = fs.readFileSync(f.file), target = path.join(f.root, 'target');
    if (kind === 'symlink') { fs.renameSync(f.file, target); fs.symlinkSync(target, f.file); }
    if (kind === 'hardlink') fs.linkSync(f.file, target);
    if (kind === 'permissions') fs.chmodSync(f.file, 0o640);
    assert.throws(() => f.reopen().recordPage(page()), code('STATE'));
    assert.deepEqual(fs.readFileSync(kind === 'symlink' ? target : f.file), original);
    assert.equal(fs.existsSync(f.lock), false);
  });
});

test('a foreign log owner is refused even with safe mode and syntax', t => {
  const f = fixture(t); f.audit.recordPage(page()); const original = fs.fstatSync, inode = fs.statSync(f.file).ino;
  t.mock.method(fs, 'fstatSync', fd => {
    const stat = original(fd); return stat.ino === inode ? Object.assign(Object.create(stat), { uid: stat.uid + 1 }) : stat;
  });
  assert.throws(() => f.reopen().recordPage(page()), code('STATE'));
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
    const audit = makeAudit(); fs.mkdirSync(f.file, { mode: 0o700 });
    let opened = 0, inspected = 0;
    const open = fs.openSync, lstat = fs.lstatSync;
    t.mock.method(fs, 'lstatSync', (...args) => { if (args[0] === canonicalFile) inspected++; return lstat(...args); });
    t.mock.method(fs, 'openSync', (...args) => { if (args[0] === canonicalFile) opened++; return open(...args); });
    assert.throws(() => audit.recordPage(page()), code('STATE'));
    assert.ok(inspected > 0, 'the canonical log path was actually inspected before rejection');
    assert.equal(opened, 0);
    t.mock.restoreAll(); fs.rmdirSync(f.file);
    const clean = makeAudit(); clean.recordPage(page());
    const observedFlags = [];
    t.mock.method(fs, 'openSync', (...args) => {
      if (args[0] === canonicalFile) { observedFlags.push(args[1]); assert.ok(args[1] & fs.constants.O_NONBLOCK); }
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
    const f = fixture(t); f.audit.recordPage(page()); let bytes = fs.readFileSync(f.file), row = JSON.parse(bytes);
    if (kind === 'torn') bytes = bytes.subarray(0, bytes.length - 1);
    if (kind === 'blank') bytes = Buffer.from('\n');
    if (kind === 'invalid-json') bytes = Buffer.from('{invalid}\n');
    if (kind === 'sequence') { row.sequence = 2; bytes = Buffer.from(JSON.stringify(row) + '\n'); }
    if (kind === 'day') { row.day = '2026-11-12'; bytes = Buffer.from(JSON.stringify(row) + '\n'); }
    if (kind === 'pageOfDay') { row.pageOfDay = 2; bytes = Buffer.from(JSON.stringify(row) + '\n'); }
    if (kind === 'body') { row.result.body = 'synthetic forbidden body'; bytes = Buffer.from(JSON.stringify(row) + '\n'); }
    if (kind === 'invalid-utf8') bytes = Buffer.from([0xff, 10]);
    fs.writeFileSync(f.file, bytes);
    const reopened = f.reopen(); assert.throws(() => reopened.recordPage(page()), code('STATE'));
    assert.deepEqual(fs.readFileSync(f.file), bytes); assert.throws(() => reopened.read(f.person), code('STATE'));
  });
});

test('an oversized file or record is rejected before any append, with no truncation', async t => {
  for (const kind of ['file', 'record']) await t.test(kind, t => {
    const f = fixture(t); fs.writeFileSync(f.file, '', { mode: 0o600 });
    if (kind === 'file') fs.truncateSync(f.file, 32 * 1024 * 1024 + 1);
    else fs.writeFileSync(f.file, 'x'.repeat(128 * 1024) + '\n');
    const size = fs.statSync(f.file).size;
    assert.throws(() => f.audit.recordPage(page()), code(kind === 'file' ? 'CAPACITY' : 'STATE'));
    assert.equal(fs.statSync(f.file).size, size); assert.equal(fs.existsSync(f.lock), false);
  });
});

test('removing or truncating a previously observed log is not treated as a new quota', async t => {
  for (const kind of ['remove', 'truncate']) await t.test(kind, t => {
    const f = fixture(t); f.audit.recordPage(page());
    if (kind === 'remove') fs.unlinkSync(f.file); else fs.truncateSync(f.file, 0);
    assert.throws(() => f.audit.recordPage(page()), code('STATE'));
    assert.equal(fs.existsSync(f.file), kind !== 'remove');
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
  assert.throws(() => f.reopen().read(f.person), code('STATE'));
});

test('fsync failure never returns success, and a surviving complete intent conservatively still consumes quota', t => {
  const f = fixture(t); f.audit.recordPage(page());
  t.mock.method(fs, 'fsyncSync', () => { throw Error('synthetic storage failure'); });
  assert.throws(() => f.audit.recordPage(page()), code('WRITE')); t.mock.restoreAll();
  assert.throws(() => f.audit.recordPage(page()), code('STATE'));
  const reopened = f.reopen(), rows = reopened.read(f.person).records;
  assert.equal(rows.length, 2); assert.equal(reopened.recordPage(page()).pageOfDay, 3);
});

test('no-progress writes fail rather than looping or returning an approval', t => {
  const f = fixture(t); t.mock.method(fs, 'writeSync', () => 0);
  assert.throws(() => f.audit.recordPage(page()), code('WRITE')); assert.equal(fs.statSync(f.file).size, 0);
  assert.equal(fs.existsSync(f.lock), false);
});

// A real replay-valid journal near the fixed threshold, with no filler fields
// or mocked file statistics. All page payloads are bounded metadata references.
let nearWarning;
function nearWarningJournal() {
  if (nearWarning) return nearWarning;
  const large = page();
  large.result = { count: 20, scanned: 20, truncated: false, recordRefs: Array.from({ length: 20 }, (_, n) =>
    'naw:space:shared/item:' + encodeURIComponent('测'.repeat(197) + String(n).padStart(3, '0'))) };
  const small = page(), lines = []; let sequence = 0, size = 0;
  function line(input) {
    const time = NOW - (100 - Math.floor(sequence / 64)) * DAY;
    return Buffer.from(JSON.stringify({ version: 1, sequence: sequence + 1, time, day: new Date(time).toISOString().split('T')[0],
      pageOfDay: sequence % 64 + 1, ...input }) + '\n');
  }
  function add(bytes) { lines.push(bytes); size += bytes.length; sequence++; }
  for (;;) { const next = line(large); if (size + next.length >= 25_165_824) break; add(next); }
  while (25_165_824 - size > 20_000) add(line(small));
  nearWarning = { bytes: Buffer.concat(lines), large, sequence };
  return nearWarning;
}

test('human storage status uses actual byte counts, stays separate from page receipts, and has five fixed metadata fields', t => {
  const f = fixture(t); assert.deepEqual(f.audit.read(f.person).storage, storage(0));
  const receipt = f.audit.recordPage(page());
  assert.deepEqual(Object.keys(receipt).sort(), ['day', 'pageOfDay', 'sequence', 'time']);
  const result = f.audit.read(f.person);
  assert.deepEqual(result.storage, storage(fs.statSync(f.file).size));
  assert.deepEqual(Object.keys(result.storage).sort(), ['maxBytes', 'remainingBytes', 'usedBytes', 'warning', 'warningThresholdBytes']);
  result.storage.usedBytes = -1; assert.deepEqual(f.audit.read(f.person).storage, storage(fs.statSync(f.file).size));
  assert.throws(() => new ButlerReadAudit(f.directory, { warningThresholdBytes: 1 }), code('INPUT'));
});

test('a durable crossing of seventy-five percent warns once after unlock; a new reader can warn again without consuming a page', t => {
  const f = fixture(t), large = nearWarningJournal(), notices = [];
  fs.writeFileSync(f.file, large.bytes, { mode: 0o600 });
  const audit = new ButlerReadAudit(f.directory, { authorizePerson: value => value === f.person, now: () => NOW,
    onCapacityWarning: value => {
      assert.equal(fs.existsSync(f.lock), false, 'the callback cannot run while the audit is locked');
      assert.deepEqual(value, storage(fs.statSync(f.file).size)); assert.equal(Object.isFrozen(value), true);
      assert.equal(Reflect.set(value, 'usedBytes', -1), false); notices.push(value);
    } });
  assert.ok(large.bytes.length < 25_165_824);
  assert.equal(audit.read(f.person, { limit: 1 }).storage.warning, false); assert.equal(notices.length, 0);
  const receipt = audit.recordPage(large.large);
  assert.equal(receipt.pageOfDay, 1, 'old UTC days do not consume the current day');
  assert.equal(receipt.sequence, large.sequence + 1); assert.equal(notices.length, 1);
  assert.ok(notices[0].usedBytes >= 25_165_824); assert.ok(notices[0].remainingBytes > 0);
  t.diagnostic(JSON.stringify({ journalBeforeBytes: large.bytes.length, journalAfterBytes: notices[0].usedBytes,
    warningThresholdBytes: 25_165_824, priorApprovedPages: large.sequence, newPageOfUtcDay: receipt.pageOfDay }));
  assert.equal(audit.recordPage(page()).pageOfDay, 2); assert.equal(notices.length, 1);
  const nextNotices = [], reopened = new ButlerReadAudit(f.directory, { authorizePerson: value => value === f.person,
    onCapacityWarning: value => nextNotices.push(value) });
  const read = reopened.read(f.person, { afterSequence: large.sequence, limit: 2 });
  assert.deepEqual(read.storage, storage(fs.statSync(f.file).size)); assert.equal(nextNotices.length, 1);
  assert.notEqual(nextNotices[0], read.storage); assert.equal(Object.isFrozen(nextNotices[0]), true);
  assert.deepEqual(read.records.map(row => row.pageOfDay), [1, 2]);
  reopened.read(f.person, { limit: 1 }); assert.equal(nextNotices.length, 1);
  assert.deepEqual(fs.readdirSync(f.directory), [FILE_NAME]);
});

test('warning callback errors and rejected promises cannot change a successful read or write or its storage status', async t => {
  const f = fixture(t), large = nearWarningJournal(); fs.writeFileSync(f.file, large.bytes, { mode: 0o600 });
  let syncCalls = 0;
  const writer = new ButlerReadAudit(f.directory, { now: () => NOW, onCapacityWarning: () => { syncCalls++; throw Error('synthetic callback failure'); } });
  assert.equal(writer.recordPage(large.large).pageOfDay, 1); assert.equal(syncCalls, 1);
  let asyncCalls = 0;
  const reader = new ButlerReadAudit(f.directory, { authorizePerson: value => value === f.person,
    onCapacityWarning: async () => { asyncCalls++; throw Error('synthetic asynchronous callback failure'); } });
  const result = reader.read(f.person, { limit: 1 });
  assert.deepEqual(result.storage, storage(fs.statSync(f.file).size)); assert.equal(asyncCalls, 1);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(reader.read(f.person, { limit: 1 }).storage.warning, true); assert.equal(asyncCalls, 1);
});

test('uncertain writes and failed lock cleanup never call a capacity callback or claim an approved page', async t => {
  for (const fault of ['fsync', 'unlock']) await t.test(fault, t => {
    const f = fixture(t), large = nearWarningJournal(); fs.writeFileSync(f.file, large.bytes, { mode: 0o600 });
    let called = 0;
    const audit = new ButlerReadAudit(f.directory, { now: () => NOW, onCapacityWarning: () => called++ });
    if (fault === 'fsync') t.mock.method(fs, 'fsyncSync', () => { throw Error('synthetic fsync failure'); });
    else {
      const unlink = fs.unlinkSync, canonicalLock = path.join(fs.realpathSync(f.directory), FILE_NAME + '.lock');
      t.mock.method(fs, 'unlinkSync', file => { if (file === canonicalLock) throw Error('synthetic cleanup failure'); return unlink(file); });
    }
    assert.throws(() => audit.recordPage(large.large), code(fault === 'fsync' ? 'WRITE' : 'STATE'));
    assert.equal(called, 0); t.mock.restoreAll();
    assert.ok(fs.statSync(f.file).size >= 25_165_824, 'failure did not roll back or truncate the complete intent');
  });
});

test('a quota-rejected page above the storage threshold emits no warning event and adds no failed-attempt record', t => {
  const f = fixture(t), large = nearWarningJournal(), lines = [large.bytes];
  for (let n = 1; n <= 64; n++) lines.push(Buffer.from(JSON.stringify({ version: 1, sequence: large.sequence + n,
    time: NOW, day: '2026-11-11', pageOfDay: n, ...large.large }) + '\n'));
  const bytes = Buffer.concat(lines); assert.ok(bytes.length < 33_554_432); assert.ok(bytes.length >= 25_165_824);
  fs.writeFileSync(f.file, bytes, { mode: 0o600 }); let calls = 0;
  const audit = new ButlerReadAudit(f.directory, { now: () => NOW, onCapacityWarning: () => calls++ });
  assert.throws(() => audit.recordPage(page()), code('LIMIT'));
  assert.equal(calls, 0); assert.equal(fs.statSync(f.file).size, bytes.length); assert.equal(fs.existsSync(f.lock), false);
});
