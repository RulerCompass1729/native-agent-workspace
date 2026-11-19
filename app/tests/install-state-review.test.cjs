const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const code = process.env.NAW_INSTALL_GATE_TEST_ROOT || path.resolve(__dirname, '../../scripts'), g = require(path.join(code, 'check-install-state.cjs'));
const runtime = require('../../scripts/fixtures/install-runtime.cjs');
const expected = { version: '0.1.0-alpha.999', revision: 'a'.repeat(40) }, box = { x: 20, y: 30, width: 1240, height: 820 }, runtimeHash = 'b'.repeat(16);
function state() { return { profile: '/synthetic/profile', gui: { pid: 100, started: 'old' }, views: [{ owner: 'view', bounds: { ...box } }], windows: [{ id: 1, onScreen: true, bounds: { ...box } }], bundle: { ...expected, runtimeHash }, backend: { key: 'old', ...expected, runtimeHash, evidence: 'active-key+live-lock+runtime-source' }, dsh: { status: 'qualified', digest: 'same-tree' } }; }
async function run(mutate) { const before = state(), after = state(); after.gui = { pid: 101, started: 'new' }; after.backend.key = 'new'; mutate(before, after); return g.post(before, () => after, expected, async () => {}, { minimumMs: 0, quietMs: 0 }); }
test('H-I1: native collection projection never materializes target or unrelated titles', () => {
  let reads = 0, foreignBounds = 0, ownerReads = 0;
  const own = { kCGWindowOwnerPID: 777, kCGWindowLayer: 0, kCGWindowNumber: 1, kCGWindowIsOnscreen: true, kCGWindowBounds: { X: 20, Y: 30, Width: 640, Height: 480 } };
  const foreign = { kCGWindowLayer: 0, kCGWindowNumber: 2, kCGWindowIsOnscreen: true };
  Object.defineProperty(foreign, 'kCGWindowOwnerPID', { enumerable: true, get() { ownerReads++; return 888; } });
  Object.defineProperty(foreign, 'kCGWindowBounds', { enumerable: true, get() { foreignBounds++; return { X: 0, Y: 0, Width: 100, Height: 100 }; } });
  for (const row of [foreign, own]) Object.defineProperty(row, 'kCGWindowName', { enumerable: true, get() { reads++; return 'synthetic title must not materialize'; } });
  const dict = object => ({ objectForKey(key) { const value = object[key]; return value && typeof value === 'object' ? dict(value) : value; } });
  const rows = [foreign, own]; Object.defineProperties(rows, { count: { value: '2' }, objectAtIndex: { value: i => dict(rows[i]) } });
  const context = vm.createContext({ ObjC: { import() {}, unwrap: x => x, castRefToObject: x => x, deepUnwrap: x => JSON.parse(JSON.stringify(x)) }, $: { CGWindowListCopyWindowInfo: () => rows } });
  vm.runInContext(fs.readFileSync(path.join(code, 'fixtures/install-windows.js'), 'utf8'), context);
  const result = JSON.parse(context.run(['777']));
  assert.equal(reads, 0); assert.equal(foreignBounds, 0); assert.equal(ownerReads, 1);
  assert.deepEqual(result, [{ pid: 777, id: 1, onScreen: true, bounds: { x: 20, y: 30, width: 640, height: 480 } }]);
});
test('H-I2: saved view and native window moving together is not position retention', async () => {
  const result = await run((_b, a) => { a.views[0].bounds.x += 200; a.views[0].bounds.y += 100; a.windows[0].bounds = { ...a.views[0].bounds }; });
  assert.equal(result.ok, false);
});
test('H-I4: missing active runtime can recover only from a recorded qualified donor', async () => {
  const result = await run((b, _a) => { b.dsh = { status: 'degraded', reason: 'runtime-missing', donors: [{ key: 'backends/' + 'c'.repeat(20), status: 'qualified', digest: 'same-tree' }] }; });
  assert.equal(result.ok, true); assert.match(result.rows.find(r => r[0] === 'DSH runtime')[2], /restored.*donor/);
});
test('H-I4: currently qualified without donor evidence is unconfirmed, not called degraded', async () => {
  const result = await run((b, _a) => { b.dsh = { status: 'degraded', reason: 'runtime-missing' }; });
  assert.equal(result.ok, false); assert.match(result.rows.find(r => r[0] === 'DSH runtime')[2], /qualified.*unconfirmed/);
});
test('H-I4: missing digests or an unrecorded donor key do not prove recovery', async () => {
  assert.equal(g.preDshReady({ status: 'degraded', reason: 'runtime-missing' }), false);
  assert.equal((await run((b, a) => { delete b.dsh.digest; delete a.dsh.digest; })).ok, false);
  assert.equal((await run((b, _a) => { b.dsh = { status: 'degraded', reason: 'runtime-missing', donors: [{ key: 'unknown', status: 'qualified', digest: 'same-tree' }] }; })).ok, false);
});
test('H-I3: honest same-version old live closure is refused, despite equal four identity files', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'install-state-review-'))); let live;
  try {
    const f = runtime.fixture(root, { stale: true }); live = await runtime.start(f); assert.equal(live.loaded.sha, 'old');
    assert.throws(() => g.backendState(f.profile, live.target), /[Rr]untime.*(?:closure|hash|source).*unconfirmed/);
  } finally { await live?.close(); fs.rmSync(root, { recursive: true }); }
});
test('H-I3: closure includes plugin files/tests, and the hash-named live directory cannot lie', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'install-state-review-'))); let live;
  try {
    const f = runtime.fixture(root); live = await runtime.start(f);
    const result = g.backendState(f.profile, live.target);
    assert.equal(result.runtimeHash, f.runtimeHash); assert.equal(Object.hasOwn(result, 'revision'), false);
    for (const name of ['dsh-tui.cjs', 'claude-bridge/hooks/register.js', 'claude-bridge-tests/submission.test.ts']) {
      const file = path.join(f.runtime, name), content = fs.readFileSync(file); fs.appendFileSync(file, '\n// changed');
      assert.throws(() => g.backendState(f.profile, live.target), /Runtime closure source unconfirmed/); fs.writeFileSync(file, content);
    }
  } finally { await live?.close(); fs.rmSync(root, { recursive: true }); }
});
test('H-I3: a complete matching closure in a falsely named live directory is refused', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'install-state-review-'))); let live;
  try {
    const f = runtime.fixture(root), renamed = path.join(f.directory, 'runtimes', 'f'.repeat(16));
    fs.renameSync(f.runtime, renamed); f.runtime = renamed; live = await runtime.start(f);
    assert.throws(() => g.backendState(f.profile, live.target), /Runtime closure hash unconfirmed/);
  } finally { await live?.close(); fs.rmSync(root, { recursive: true }); }
});
test('H-I4 pre records qualified retained donors, refuses unqualified trees, and changes no files', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'install-state-donor-')));
  try {
    const profile = path.join(root, 'profile'), app = path.join(root, 'app'), active = 'backends/' + 'a'.repeat(20), donor = 'backends/' + 'b'.repeat(20);
    for (const key of [active, donor]) fs.mkdirSync(path.join(profile, key), { recursive: true }); fs.mkdirSync(path.join(app, 'app'), { recursive: true });
    // A fake verifier isolates donor plumbing; real verifier refusal is covered by install-state/dsh-tui tests.
    fs.writeFileSync(path.join(app, 'app/dsh-tui.cjs'), "const fs=require('node:fs'),path=require('node:path');exports.verifyRuntime=p=>{if(fs.readFileSync(path.join(p,'dsh-tui/runtime/qualified'),'utf8')!=='yes')throw Error('unqualified');};");
    const tree = path.join(profile, donor, 'dsh-tui/runtime'); fs.mkdirSync(tree, { recursive: true }); fs.writeFileSync(path.join(tree, 'qualified'), 'yes');
    const layout = JSON.stringify({ format: 1, active, entries: [active, donor] }); fs.writeFileSync(path.join(profile, 'services.json'), layout);
    const before = g.preDsh(profile, { key: active, directory: path.join(profile, active) }, app);
    assert.equal(before.status, 'degraded'); assert.equal(before.donors.length, 1); assert.equal(g.preDshReady(before), true);
    fs.cpSync(tree, path.join(profile, active, 'dsh-tui/runtime'), { recursive: true });
    const after = g.dshState(path.join(profile, active), app); assert.equal(after.status, 'qualified'); assert.equal(after.digest, before.donors[0].digest);
    assert.equal(fs.readFileSync(path.join(profile, 'services.json'), 'utf8'), layout);
    fs.writeFileSync(path.join(tree, 'qualified'), 'no'); fs.rmSync(path.join(profile, active, 'dsh-tui'), { recursive: true });
    assert.equal(g.preDshReady(g.preDsh(profile, { key: active, directory: path.join(profile, active) }, app)), false);
  } finally { fs.rmSync(root, { recursive: true }); }
});
