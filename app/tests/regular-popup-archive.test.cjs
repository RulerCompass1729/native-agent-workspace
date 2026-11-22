const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { FileStore, RegularPopup, emptyState } = require('../regular-popup.cjs');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'df-retention-')), before = fs.lstatSync(directory);
  t.after(() => {
    const after = fs.lstatSync(directory);
    for (const key of ['uid', 'dev', 'ino']) assert.equal(after[key], before[key]);
    t.diagnostic(JSON.stringify({ cleanup: directory, uid: before.uid, dev: before.dev, ino: before.ino, matched: true }));
    fs.rmSync(directory, { recursive: true });
  });
  const store = new FileStore(directory), state = emptyState();
  state.config = { enabled: true, concern: 'Synthetic tools', time: '09:00' };
  state.runs = Array.from({ length: 61 }, (_, i) => {
    const at = new Date(2026, 10, 22 - i, 10).getTime(), date = new Date(at);
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return { id: `synthetic-${i}`, day, budgetDay: day, budgetAt: at, at, state: 'ready', chargedMicros: 500, costKnown: true, attempted: true,
      items: [{ id: 'tool', title: 'Synthetic tool', url: 'https://github.com/example/tool', why: 'Public fixture', read: true, ignored: true }] };
  });
  const archive = run => path.join(directory, `regular-popup-archive-${run.budgetDay.slice(0, 7)}.jsonl`);
  return { directory, store, state, archive };
}
test('61st run keeps 60 in main and memory, appending the complete oldest record at mode 0600', t => {
  const f = fixture(t), oldest = structuredClone(f.state.runs[60]);
  fs.writeFileSync(f.store.file, JSON.stringify({ ...f.state, runs: f.state.runs.slice(1) }), { mode: 0o600 });
  const e = new RegularPopup({ directory: f.directory });
  e.save(f.state);
  assert.equal(e.status().runs.length, 60); assert.deepEqual(JSON.parse(fs.readFileSync(f.store.file)).runs, f.state.runs.slice(0, 60));
  assert.deepEqual(JSON.parse(fs.readFileSync(f.archive(oldest), 'utf8')), oldest);
  assert.equal(fs.statSync(f.archive(oldest)).mode & 0o777, 0o600); assert.equal(fs.statSync(f.store.file).mode & 0o777, 0o600);
  e.dispose();
});
test('scheduled engine path persists the 61st run and keeps every older result intact', async t => {
  const f = fixture(t), oldest = structuredClone(f.state.runs[60]); let sources = 0;
  f.store.write({ ...f.state, runs: f.state.runs.slice(1) });
  const e = new RegularPopup({ directory: f.directory, now: () => f.state.runs[0].at, permitted: true,
    readSource: async () => { sources++; return []; }, select: () => assert.fail('no model needed for empty source') });
  await e.tick(); const saved = f.store.read();
  assert.equal(sources, 1); assert.equal(saved.runs.length, 60); assert.equal(saved.runs[0].state, 'ready'); assert.equal(e.status().runs.length, 60);
  assert.deepEqual(saved.runs.slice(1), f.state.runs.slice(1, 60)); assert.deepEqual(JSON.parse(fs.readFileSync(f.archive(oldest))), oldest); e.dispose();
});
test('legacy history migrates across months and repeated saves never rewrite or duplicate archives', t => {
  const f = fixture(t); f.state.runs.push({ ...f.state.runs[60], id: 'another-month', budgetDay: '2026-08-01' });
  fs.writeFileSync(f.store.file, JSON.stringify(f.state));
  assert.equal(f.store.read().runs.length, 60);
  const files = f.state.runs.slice(60).map(f.archive), bytes = files.map(file => fs.readFileSync(file));
  f.store.write(f.state); files.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), bytes[i]));
  f.state.runs.unshift({ ...f.state.runs[0], id: 'new-run' });
  f.store.write(f.state);
  assert.deepEqual(fs.readFileSync(files[0]).subarray(0, bytes[0].length), bytes[0]);
});
test('archive failure preserves main byte-for-byte and dispatches nothing', async t => {
  const f = fixture(t), old = { ...f.state, runs: f.state.runs.slice(1) };
  f.store.write(old); const before = fs.readFileSync(f.store.file);
  fs.mkdirSync(f.archive(f.state.runs[60]));
  const e = new RegularPopup({ directory: f.directory, permitted: true, readSource: () => assert.fail('source forbidden'), select: () => assert.fail('model forbidden') });
  assert.throws(() => e.save(f.state), /storage-unavailable/);
  assert.deepEqual(fs.readFileSync(f.store.file), before); await e.tick(); assert.equal(e.status().error, 'storage-unavailable'); e.dispose();
});
test('retry after main rename failure reuses durable archive without duplicates', t => {
  const f = fixture(t); fs.mkdirSync(f.store.file);
  assert.throws(() => f.store.write(f.state)); const before = fs.readFileSync(f.archive(f.state.runs[60]));
  fs.rmdirSync(f.store.file); f.store.write(f.state);
  assert.deepEqual(fs.readFileSync(f.archive(f.state.runs[60])), before); assert.equal(f.store.read().runs.length, 60);
});
test('migration I/O failure is not mistaken for a missing main file', t => {
  const f = fixture(t); fs.writeFileSync(f.store.file, JSON.stringify(f.state)); const before = fs.readFileSync(f.store.file);
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(Error('synthetic rename failure'), { code: 'ENOENT' }); });
  assert.throws(() => f.store.read(), /storage-unavailable/); assert.deepEqual(fs.readFileSync(f.store.file), before);
});
test('archive symlinks, hard links, unsafe permissions and partial tails fail closed', t => {
  const f = fixture(t), archive = f.archive(f.state.runs[60]), target = path.join(f.directory, 'target');
  fs.writeFileSync(target, 'untouched', { mode: 0o600 });
  fs.symlinkSync(target, archive); assert.throws(() => f.store.write(f.state)); fs.unlinkSync(archive);
  fs.linkSync(target, archive); assert.throws(() => f.store.write(f.state)); fs.unlinkSync(archive);
  fs.writeFileSync(archive, '', { mode: 0o644 }); assert.throws(() => f.store.write(f.state)); fs.chmodSync(archive, 0o600);
  fs.writeFileSync(archive, '{'); assert.throws(() => f.store.write(f.state)); assert.equal(fs.readFileSync(archive, 'utf8'), '{');
  assert.equal(fs.readFileSync(target, 'utf8'), 'untouched');
});
test('conflicting archived identity is rejected while preserving main and archive', t => {
  const f = fixture(t), old = f.state.runs[60]; f.store.write({ ...f.state, runs: f.state.runs.slice(1) });
  const before = fs.readFileSync(f.store.file), conflict = JSON.stringify({ ...old, chargedMicros: 600 }) + '\n';
  fs.writeFileSync(f.archive(old), conflict, { mode: 0o600 });
  assert.throws(() => f.store.write(f.state)); assert.deepEqual(fs.readFileSync(f.store.file), before); assert.equal(fs.readFileSync(f.archive(old), 'utf8'), conflict);
});
test('archived source day and execution budget still block clock rollback, including after restart', async t => {
  const f = fixture(t), oldest = f.state.runs[60];
  // The execution day can differ from its source day after an asynchronous clock change.
  oldest.budgetDay = '2026-08-01'; f.store.write(f.state);
  let at = oldest.at, reads = 0, models = 0; const delays = [];
  const e = new RegularPopup({ directory: f.directory, now: () => at, permitted: true,
    readSource: () => { reads++; return []; }, select: () => { models++; }, setTimer: (_, delay) => { delays.push(delay); return 1; }, clearTimer() {} });
  e.start(); await e.tick(); assert.equal(reads, 0); assert.equal(models, 0); assert.ok(delays[0] > 0);
  at = new Date(2026, 7, 1, 10).getTime(); await e.tick();
  assert.equal(e.status().runs[0].state, 'daily-limit'); assert.equal(reads, 0); assert.equal(models, 0); e.dispose();
});
test('unreadable historical state refuses a paid attempt and does not create timer loops', async t => {
  const f = fixture(t); f.store.write(f.state); fs.appendFileSync(f.archive(f.state.runs[60]), '{');
  let timers = 0; const e = new RegularPopup({ directory: f.directory, now: () => new Date(2026, 10, 23, 10).getTime(), permitted: true,
    readSource: () => assert.fail('source forbidden'), select: () => assert.fail('model forbidden'), setTimer: () => timers++ });
  e.start(); await e.tick(); assert.equal(timers, 0); assert.equal(e.status().error, 'storage-unavailable'); e.dispose();
});
