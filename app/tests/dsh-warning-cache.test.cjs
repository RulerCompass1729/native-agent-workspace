const test = require('node:test'), assert = require('node:assert/strict');
const { readRetiredBackend } = require('../retired-backend.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm'), crypto = require('node:crypto');
const app = path.join(__dirname, '..'), tui = require(path.join(app, 'dsh-tui.cjs'));
const helper = require(path.join(app, 'tests/helpers/dsh-runtime.cjs'));
const layout = require(path.join(app, 'service-layout.cjs')), locks = require(path.join(app, 'service-lock.cjs'));
const cache = f => f.ensure.targetWarnings || new Map();
function scene(t, retainTargets = false) {
  helper.qualification(t);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-g-dedupe-review-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); helper.runtime(root);
  const warnings = [], causes = [], retired = []; let calls = 0, unreadable = null, reason = null;
  const fakeFs = new Proxy(fs, { get(object, key) {
    if (key === 'lstatSync') return file => {
      if (file === unreadable) throw Object.assign(Error('Synthetic metadata unavailable'), { code: 'EACCES' });
      return fs.lstatSync(file);
    };
    return object[key];
  } });
  const wrapped = { ...tui, inheritRuntime: async (...args) => {
    calls++;
    try { return await tui.inheritRuntime(...args); }
    catch (error) { if (reason) error.cause = Object.assign(Error(reason), { code: 'EACCES' }); causes.push(error.cause?.message); throw error; }
  } };
  const state = directory => ({ runtimeVersion: 'synthetic-review', servicePid: 0,
    sessions: retainTargets || directory === root ? [{ id: 'synthetic-ended', state: 'ended' }] : [], room: { messages: [] } });
  const ctx = { fs: fakeFs, path, crypto, __dirname: app, process: { env: { NAW_APP_VERSION: 'synthetic-review' } },
    uiError: key => Error(key), ...layout,readRetiredBackend, ...locks, require: () => wrapped, dshCopy: helper.inProcess(wrapped), console: { warn: (...args) => warnings.push(args) },
    ensureServiceAt: async directory => state(directory),
    connectService: async directory => ({ call: async method => { if (method === 'shutdown') retired.push(directory); return state(directory); }, close() {} }),
    lockIdentity: () => null, waitForShutdown: async () => {} };
  const source = fs.readFileSync(path.join(app, 'service-client.cjs'), 'utf8');
  const start = source.indexOf('async function ensureService(dataDir,'), end = source.indexOf('\nfunction continuationStatus', start);
  const predicates = source.indexOf('function emptyService(state)');
  Object.assign(ctx, vm.runInNewContext(source.slice(predicates, start) + '\n({emptyService,emptyStore})', ctx));
  const ensure = vm.runInNewContext(source.slice(start, end) + '\nensureService', ctx);
  const target = n => {
    const key = 'backends/' + n.toString(16).padStart(20, '0'), dir = path.join(root, key);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const base = tui.paths(dir).base; fs.mkdirSync(base, { recursive: true, mode: 0o700 }); fs.chmodSync(base, 0o770);
    return { key, dir, base };
  };
  const select = (where, pending = false, source = '.') => layout.writeLayout(root, pending
    ? { format: 1, active: source, entries: [source], pending: where.key }
    : { format: 1, active: where.key, entries: [source, where.key] });
  return { root, ensure, warnings, causes, retired, target, select, calls: () => calls, start: () => ensure(root, '/synthetic/electron'),
    unreadable: file => { unreadable = file; }, reason: value => { reason = value; } };
}
test('unverifiable metadata never suppresses a repeated refusal', async t => {
  const f = scene(t), where = f.target(1); f.select(where); f.unreadable(where.base);
  for (let n = 0; n < 3; n++) await f.start();
  assert.equal(f.calls(), 3); assert.equal(f.warnings.length, 3); assert.equal(cache(f).size, 0);
  assert.ok(f.warnings.every(row => row.length === 2 && row[1] === 'target'));
});
test('cause changes and source/target changes get independent warning keys', async t => {
  const f = scene(t), a = f.target(1); f.select(a); f.reason('SYNTHETIC_PRIVATE_CAUSE_A');
  await f.start(); await f.start(); assert.equal(f.warnings.length, 1);
  f.reason('SYNTHETIC_PRIVATE_CAUSE_B'); await f.start(); assert.equal(f.warnings.length, 2);
  const b = f.target(2); f.select(b); await f.start(); assert.equal(f.warnings.length, 3);
  const source = 'backends/' + 'e'.repeat(20); helper.runtime(path.join(f.root, source));
  f.select(b, false, source); await f.start(); assert.equal(f.warnings.length, 4);
  assert.equal(f.calls(), 5);
  const retained = JSON.stringify([...cache(f)]);
  assert.ok(!retained.includes('SYNTHETIC_PRIVATE_CAUSE'));
  assert.ok(!JSON.stringify(f.warnings).includes(f.root));
});
test('obsolete target pairs are evicted or covered by an explicit cache bound', async t => {
  const f = scene(t), samples = []; let previous;
  for (let n = 1; n <= 64; n++) {
    const where = f.target(n);
    layout.writeLayout(f.root, { format: 1, active: where.key, entries: ['.', ...(previous ? [previous.key] : []), where.key] });
    await f.start(); previous = where;
    if ([8, 16, 32, 64].includes(n)) samples.push({ attempts: n, cacheSize: cache(f).size, liveEntries: layout.readLayout(f.root).entries.length });
  }
  const active = layout.readLayout(f.root).active;
  const stale = [...cache(f).keys()].filter(key => JSON.parse(key)[2] !== active).length;
  console.log('CACHE_GROWTH ' + JSON.stringify({ samples, stale, retired: f.retired.length, prechecks: f.calls(), warnings: f.warnings.length }));
  assert.equal(stale, 0, 'Retired source→target keys need eviction or an explicit finite cache cap; current source has neither');
});
test('repair and renewed refusal inside the existing runtime tree must warn again', async t => {
  const f = scene(t), where = f.target(1); fs.chmodSync(where.base, 0o700);
  const installed = helper.runtime(where.dir), file = path.join(installed.tui, 'package.json');
  fs.chmodSync(file, 0o660); f.select(where, true); await f.start();
  const first = f.warnings.length, before = fs.statSync(file), signature = [...cache(f).values()][0];
  await new Promise(resolve => setTimeout(resolve, 10));
  fs.chmodSync(file, 0o600);
  const repaired = await tui.inheritRuntime(f.root, where.dir, { cleanStaging: true });
  assert.equal(repaired.status, 'existing'); fs.chmodSync(file, 0o660);
  f.select(where, true); await f.start();
  console.log('NESTED_REPAIR ' + JSON.stringify({ first, afterRepairCycle: f.warnings.length, prechecks: f.calls(), repaired: repaired.status, cause: f.causes, leafCtimeChanged: fs.statSync(file).ctimeMs !== before.ctimeMs, unchangedCachedSignature: [...cache(f).values()][0] === signature, refusal: f.warnings.at(-1) }));
  assert.notEqual(fs.statSync(file).ctimeMs, before.ctimeMs);
  assert.equal(f.calls(), 2); assert.equal(f.warnings.length, 2, 'A repaired then unsafe nested file changes the rejected target state');
});

test('live warning pairs have a 64-entry LRU bound without skipping prechecks', async t => {
  const f = scene(t, true), targets = [], select = where => layout.writeLayout(f.root, {
    format: 1, active: where.key, entries: ['.', ...targets.map(target => target.key)],
  });
  for (let n = 1; n <= 64; n++) {
    const where = f.target(n); targets.push(where); select(where); await f.start();
  }
  assert.equal(cache(f).size, 64); assert.equal(f.warnings.length, 64);
  select(targets[0]); await f.start();
  assert.equal(f.warnings.length, 64, 'An unchanged live pair still deduplicates and refreshes its recency');
  const extra = f.target(65); targets.push(extra); select(extra); await f.start();
  assert.equal(cache(f).size, 64);
  const cachedTargets = [...cache(f).keys()].map(key => JSON.parse(key)[2]);
  assert.ok(cachedTargets.includes(targets[0].key)); assert.ok(!cachedTargets.includes(targets[1].key));
  select(targets[1]); await f.start();
  assert.equal(f.warnings.length, 66, 'An evicted pair warns when next checked');
  assert.equal(f.calls(), 67); assert.equal(cache(f).size, 64); assert.deepEqual(f.retired, []);
});

test('unknown failure identity stays uncached and existing leaf refusal deduplicates', async t => {
  const f = scene(t), where = f.target(1); fs.chmodSync(where.base, 0o700);
  const installed = helper.runtime(where.dir), file = path.join(installed.tui, 'package.json');
  fs.chmodSync(file, 0o660); f.select(where, true); await f.start();
  f.select(where, true); await f.start();
  assert.equal(f.calls(), 2); assert.equal(f.warnings.length, 1, 'The same unchanged bad leaf warns once');
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(path.join(installed.tui, 'package.json'), JSON.stringify({ version: 'synthetic-wrong-version' }));
  for (let n = 0; n < 2; n++) { f.select(where, true); await f.start(); }
  assert.equal(f.warnings.length, 3, 'A payload failure without a trustworthy node identity must not be deduplicated');
  assert.equal(cache(f).size, 0);
});
