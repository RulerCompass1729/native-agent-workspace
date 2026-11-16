const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const ownership = require('../temp-ownership.cjs'), { TempReminders } = require('../temp-reminders.cjs');
const root = path.resolve(__dirname, '../..');
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-store-strays-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home'); fs.mkdirSync(home, { mode: 0o700 });
  const env = { ...process.env, HOME: home };
  for (const k of ['NAW_DATA_DIR', 'NAW_TEMP_REGISTRY_DIR', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'NAW_TEST_TEMP_JOURNAL', 'NAW_TEST_TEMP_REPORT']) delete env[k];
  const store = path.join(home, ...(process.platform === 'darwin' ? ['Library', 'Application Support'] : ['.local', 'share']), 'Native Agent Workspace', 'temp-ownership');
  fs.mkdirSync(store, { recursive: true, mode: 0o700 });
  return { base, home, env, store };
}
function runSuite(f, passing = true) {
  const file = path.join(f.base, 'mini-suite.cjs');
  fs.writeFileSync(file, `require('node:test')('synthetic ${passing ? 'passing' : 'failing'} test',()=>{${passing ? '' : "throw Error('Expected synthetic failure');"}});`);
  return spawnSync(process.execPath, ['scripts/test.cjs', file], { cwd: root, env: f.env, encoding: 'utf8', timeout: 30000 });
}
for (const name of ['.DS_Store', 'stray-note.txt']) test(`passing suite keeps exit zero and leaves ${name} in the default fake-HOME store`, t => {
  const f = fixture(t), file = path.join(f.store, name); fs.writeFileSync(file, 'unrelated data');
  const result = runSuite(f);
  assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /TEMP GUARD: PASS/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'unrelated data');
});
test('read and batches ignore unrelated files, directories and symlinks without touching them', async t => {
  const f = fixture(t), dir = path.join(f.base, 'candidate'); fs.mkdirSync(dir);
  const id = ownership.register(dir, { registryDir: f.store });
  fs.writeFileSync(path.join(f.store, '.DS_Store'), 'Finder data');
  fs.mkdirSync(path.join(f.store, 'backup-folder'));
  fs.symlinkSync('missing-unrelated-target', path.join(f.store, 'backup-link'));
  fs.writeFileSync(path.join(f.store, '.pending-00000000-0000-4000-8000-000000000001'), 'incomplete pending data');
  assert.deepEqual(ownership.read(f.store).map(r => r.id), [id]);
  const found = []; for await (const batch of ownership.batches(f.store)) found.push(...batch);
  assert.deepEqual(found.map(r => r.id), [id]); assert.equal(await ownership.pruneMissing(f.store), 0);
  assert.equal(fs.readFileSync(path.join(f.store, '.DS_Store'), 'utf8'), 'Finder data');
  assert.equal(fs.readlinkSync(path.join(f.store, 'backup-link')), 'missing-unrelated-target');
  assert.equal(fs.statSync(path.join(f.store, 'backup-folder')).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(f.store, '.pending-00000000-0000-4000-8000-000000000001'), 'utf8'), 'incomplete pending data');
});
test('a stray .DS_Store does not hide a real eight-day-old cleanup candidate', async t => {
  const f = fixture(t), dataDir = path.join(f.base, 'profile'), area = path.join(f.base, 'area'), now = Date.now(), old = now - 8 * 86400000;
  fs.mkdirSync(dataDir, { mode: 0o700 }); fs.mkdirSync(area);
  const dir = path.join(area, 'candidate'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'data'), 'synthetic');
  for (const p of [path.join(dir, 'data'), dir]) fs.utimesSync(p, new Date(old), new Date(old));
  ownership.register(dir, { registryDir: f.store, now: () => old, owner: { pid: 2 ** 30, started: 'synthetic exited owner' } });
  fs.writeFileSync(path.join(f.store, '.DS_Store'), 'Finder data');
  const manager = new TempReminders({ dataDir, registryDir: f.store, roots: [area], now: () => now,
    inspect: async () => ({ opened: [], mounted: [] }), isAlive: () => false, isPerson: () => true });
  const status = await manager.status();
  assert.equal(status.anomaly, null); assert.equal(status.directories, 1); assert.equal(status.shown, true);
  assert.equal(manager.candidates[0].record.path, dir); assert.equal(fs.readFileSync(path.join(f.store, '.DS_Store'), 'utf8'), 'Finder data');
});
for (const mode of ['bad-json', 'unsafe-mode', 'symlink', 'uppercase-hex']) test(`receipt-shaped ${mode} still blocks read, batches and scanning`, async t => {
  const f = fixture(t), dir = path.join(f.base, 'candidate'); fs.mkdirSync(dir);
  const id = ownership.register(dir, { registryDir: f.store }); let file = path.join(f.store, id + '.json');
  if (mode === 'bad-json') fs.writeFileSync(file, '{');
  else if (mode === 'unsafe-mode') fs.chmodSync(file, 0o644);
  else if (mode === 'symlink') {
    const target = path.join(f.base, 'original-receipt.json'); fs.renameSync(file, target); fs.symlinkSync(target, file);
  } else {
    assert.notEqual(id.toUpperCase(), id); const renamed = path.join(f.store, id.toUpperCase() + '.json'); fs.renameSync(file, renamed); file = renamed;
  }
  assert.throws(() => ownership.read(f.store));
  await assert.rejects(async () => { for await (const _ of ownership.batches(f.store)) {} });
  const dataDir = path.join(f.base, 'profile'); fs.mkdirSync(dataDir, { mode: 0o700 });
  const manager = new TempReminders({ dataDir, registryDir: f.store, roots: [f.base], isPerson: () => true, inspect: async () => ({ opened: [], mounted: [] }) });
  assert.equal((await manager.status()).anomaly, 'inspection-unavailable'); assert.ok(fs.lstatSync(file));
});
for (const passing of [true, false]) test(`a failed receipt sweep preserves the ${passing ? 'passing' : 'failing'} suite result and names its store`, t => {
  const f = fixture(t), file = path.join(f.store, 'a'.repeat(64) + '.json'); fs.writeFileSync(file, '{', { mode: 0o600 });
  const result = runSuite(f, passing);
  assert.equal(result.status, passing ? 0 : 1, result.stdout + result.stderr);
  const notices = result.stderr.split('\n').filter(line => line.startsWith('TEMP RECEIPTS: sweep skipped'));
  assert.equal(notices.length, 1); assert.ok(notices[0].includes(f.store));
  assert.equal(fs.readFileSync(file, 'utf8'), '{');
});
