const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const scratch = require('./fixtures/test-scratch.cjs'), current = require('./check-install-state.cjs');
const [input, gateFile] = process.argv.slice(2);
if (!input || !path.isAbsolute(input) || gateFile && !path.isAbsolute(gateFile)) throw Error('Usage: node scripts/test-install-dsh-recovery.cjs /absolute/exported/app [absolute/check-install-state.cjs]');
const app = fs.realpathSync(input), gate = gateFile ? require(gateFile) : current;
const registry = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-i4-registry-'))), registryIdentity = fs.lstatSync(registry), oldRegistry = process.env.NAW_TEMP_REGISTRY_DIR;
process.env.NAW_TEMP_REGISTRY_DIR = registry;
const cp = require('node:child_process'); let launchCalls = 0;
const originals = [cp.spawn, cp.execFile];
cp.spawn = cp.execFile = () => { launchCalls++; throw Error('This recovery fixture must not launch a provider or credential program'); };
const helper = require(path.join(app, 'tests/helpers/dsh-runtime.cjs')), tui = require(path.join(app, 'dsh-tui.cjs')), layout = require(path.join(app, 'service-layout.cjs')), locks = require(path.join(app, 'service-lock.cjs'));
const patched = [];
helper.qualification({ mock: { method(object, key, value) { patched.push([object, key, object[key]]); object[key] = value; } } });
const source = fs.readFileSync(path.join(app, 'service-client.cjs'), 'utf8'), start = source.indexOf('async function ensureService(dataDir,'), end = source.indexOf('\nfunction continuationStatus', start);
assert.ok(start > 0 && end > start, 'Use the actual exported startup function');
const version = '0.1.0-alpha.999', revision = 'a'.repeat(40), box = { x: 20, y: 30, width: 640, height: 480 }, runtimeHash = 'b'.repeat(16);
function envelope(root, key, dsh, after = false) {
  return { profile: root, gui: { pid: after ? 101 : 100, started: after ? 'new' : 'old' }, views: [{ owner: 'synthetic-view', bounds: box }], windows: [{ id: 1, onScreen: true, bounds: box }], bundle: { version, revision, runtimeHash }, backend: { key, version, revision, runtimeHash, evidence: 'active-key+live-lock+runtime-source' }, dsh };
}
let passed = 0, failed = 0;
(async () => {
  for (const mode of ['retained', 'empty-donor-retired', 'transient-retry']) {
    const root = fs.realpathSync(scratch.directory(path.join(os.tmpdir(), 'naw-i4-recovery-'))), active = 'backends/' + 'd'.repeat(20), donor = 'backends/' + 'e'.repeat(20);
    const destination = path.join(root, active), donorDir = path.join(root, donor), donorTree = helper.runtime(donorDir);
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 }); fs.mkdirSync(donorTree.home, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(donorTree.home, 'sentinel'), 'synthetic donor home');
    layout.writeLayout(root, { format: 1, active, entries: [donor, active] });
    const before = envelope(root, active, current.preDsh(root, { key: active, directory: destination }, path.dirname(app)));
    assert.equal(before.dsh.reason, 'runtime-missing'); assert.equal(before.dsh.donors.length, 1); assert.equal(current.preDshReady(before.dsh), true);
    let copies = 0, boots = 0, workerChecks = 0, broken = mode === 'transient-retry'; const retired = [], warnings = [];
    const open = fs.promises.open;
    fs.promises.open = async function(file, ...args) { if (broken && String(file).startsWith(donorTree.root)) throw Object.assign(Error('synthetic EIO'), { code: 'EIO' }); return Reflect.apply(open, this, [file, ...args]); };
    const state = dir => ({ runtimeVersion: version, servicePid: 0, sessions: mode === 'retained' && dir === donorDir ? [{ id: 'synthetic retained record', state: 'ended' }] : [], room: { messages: [] } });
    const ctx = { fs, path, crypto, __dirname: app, process: { env: { NAW_APP_VERSION: version } }, uiError: key => Error(key), ...layout, ...locks, console: { warn: (...args) => warnings.push(args) },
      require(name) { assert.equal(name, './dsh-tui.cjs'); assert.ok(fs.existsSync(path.join(root, 'services.lock'))); return { ...tui, inheritRuntime: async (...args) => { copies++; return tui.inheritRuntime(...args); } }; },
      ensureServiceAt: async dir => { boots++; return state(dir); }, connectService: async dir => ({ call: async method => { if (method === 'initial') return state(dir); if (method === 'shutdown') retired.push(dir); }, close() {} }), waitForShutdown: async () => {} };
    const predicates = source.indexOf('function emptyService(state)'); assert.ok(predicates >= 0 && predicates < start);
    Object.assign(ctx, vm.runInNewContext(source.slice(predicates, start) + '\n({emptyService,emptyStore})', ctx));
    const ensure = vm.runInNewContext(source.slice(start, end) + '\nensureService', ctx);
    try {
      await ensure(root, '/synthetic/electron');
      if (broken) {
        assert.equal(tui.installed(destination), false); assert.ok(layout.readLayout(root).entries.includes(donor));
        broken = false; await ensure(root, '/synthetic/electron');
      }
      assert.equal(tui.installed(destination), true); tui.verifyRuntime(destination);
      const after = envelope(root, active, current.dshState(destination, path.dirname(app)), true);
      assert.equal(after.dsh.status, 'qualified'); assert.equal(after.dsh.digest, before.dsh.donors[0].digest);
      assert.equal(fs.existsSync(tui.paths(destination).home), false); assert.equal(fs.readFileSync(path.join(donorTree.home, 'sentinel'), 'utf8'), 'synthetic donor home');
      const result = await gate.post(before, () => after, { version, revision }, async () => { workerChecks++; }, { minimumMs: 0, quietMs: 0 });
      const failedChecks = result.rows.filter(row => !row[3]).map(row => row[0]);
      if (!result.ok) assert.deepEqual(failedChecks, ['DSH runtime'], 'The old counterexample must fail only on recovery acceptance');
      const calls = copies; await ensure(root, '/synthetic/electron'); assert.equal(copies, calls, 'Recovered active runtime does not copy again');
      assert.equal(fs.existsSync(path.join(root, 'services.lock')), false);
      if (mode === 'retained') assert.ok(layout.readLayout(root).entries.includes(donor));
      else { assert.ok(!layout.readLayout(root).entries.includes(donor)); assert.ok(retired.includes(donorDir)); }
      console.log(JSON.stringify({ mode, startup: 'actual ensureService source', copy: 'actual inheritRuntime', syntheticEnvelope: true, before: before.dsh, after: after.dsh, copies, boots, warnings, donorRetired: retired.includes(donorDir), accepted: result.ok, failedChecks, workerChecks, launchCalls }));
      if (result.ok && workerChecks === 1) passed++; else failed++;
    } finally { fs.promises.open = open; }
  }
  assert.equal(launchCalls, 0); console.log(JSON.stringify({ passed, failed, launchCalls, modelCalls: 0, realServices: 0, qualificationFixture: 'G test helper: synthetic update source only' }));
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const [object, key, value] of patched.reverse()) object[key] = value;
  [cp.spawn, cp.execFile] = originals;
  try { await scratch.release(); } finally {
    if (oldRegistry === undefined) delete process.env.NAW_TEMP_REGISTRY_DIR; else process.env.NAW_TEMP_REGISTRY_DIR = oldRegistry;
    const now = fs.lstatSync(registry); assert.ok(now.isDirectory() && !now.isSymbolicLink() && now.uid === registryIdentity.uid && now.dev === registryIdentity.dev && now.ino === registryIdentity.ino);
    fs.rmSync(registry, { recursive: true });
  }
});
