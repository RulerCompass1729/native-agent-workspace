'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const vm = require('node:vm');
const runtimeFixture = require('../../scripts/fixtures/install-runtime.cjs');
const gate = require('../../scripts/check-install-state.cjs');
const revision = 'a'.repeat(40), expected = { version: '0.1.0-alpha.999', revision };
const box = { x: 20, y: 30, width: 1240, height: 820 };
function state() {
  return { profile: '/synthetic/profile', gui: { pid: 100, started: 'before' }, views: [{ owner: 'synthetic-view', bounds: { ...box } }],
    windows: [{ id: 1, onScreen: true, bounds: { ...box } }], bundle: { ...expected, runtimeHash: 'b'.repeat(16) },
    backend: { key: 'old', ...expected, runtimeHash: 'b'.repeat(16), evidence: 'active-key+live-lock+runtime-source' }, dsh: { status: 'qualified', digest: 'same-tree' } };
}
function pair() { const before = state(), after = state(); after.gui = { pid: 101, started: 'after' }; after.backend.key = 'new'; return { before, after }; }
const instant = { minimumMs: 0, quietMs: 0 };
for (const [name, change] of [
  ['extra on-screen window', s => s.windows.push({ id: 2, onScreen: true, bounds: { ...box, x: 80 } })],
  ['wrong position', s => { s.windows[0].bounds.x += 20; }],
  ['DSH downgrade', s => { s.dsh = { status: 'degraded', reason: 'runtime-missing' }; }],
  ['wrong bundle version', s => { s.bundle.version = '0.1.0-alpha.998'; }],
  ['wrong backend version', s => { s.backend.version = '0.1.0-alpha.998'; }],
  ['wrong backend runtime hash', s => { s.backend.runtimeHash = 'c'.repeat(16); }],
  ['changed DSH tree', s => { s.dsh.digest = 'different-tree'; }],
  ['lost view replaced at same count', s => { s.views[0].owner = 'replacement'; }],
  ['old GUI not restarted', s => { s.gui = { pid: 100, started: 'before' }; }],
]) test(`post refuses ${name} before running worker checks`, async () => {
  const { before, after } = pair(); change(after); let workers = 0;
  const result = await gate.post(before, () => after, expected, async () => workers++, instant);
  assert.equal(result.ok, false); assert.equal(workers, 0); assert.ok(result.rows.some(r => r[3] === false));
});
test('consistent installation runs the original worker gate once and passes', async () => {
  const { before, after } = pair(); let workers = 0;
  const result = await gate.post(before, () => after, expected, async () => workers++, instant);
  assert.equal(result.ok, true); assert.equal(workers, 1);
  assert.match(result.rows.find(r => r[0] === 'DSH runtime')[2], /inherited/);
});
test('observed off-screen windows may retain zero on-screen count; a newly shown window fails', () => {
  const { before, after } = pair(); before.windows[0].onScreen = false; after.windows[0].onScreen = false;
  assert.ok(gate.compare(before, after, expected).every(r => r[3]));
  after.windows[0].onScreen = true; assert.equal(gate.compare(before, after, expected)[0][3], false);
});
test('synthetic command exit codes: consistent 0; extra window, position, DSH and version each 1', () => {
  for (const mode of ['consistent', 'extra-window', 'position', 'dsh', 'version']) {
    const { before, after } = pair();
    if (mode === 'extra-window') after.windows.push({ id: 2, onScreen: true, bounds: box });
    if (mode === 'position') after.windows[0].bounds.y += 50;
    if (mode === 'dsh') after.dsh = { status: 'degraded', reason: 'runtime-missing' };
    if (mode === 'version') after.bundle.version = '0.1.0-alpha.998';
    const code = `const g=require(process.argv[1]),p=JSON.parse(process.argv[2]);g.post(p.before,()=>p.after,p.expected,async()=>{},{minimumMs:0,quietMs:0}).then(r=>{console.log(JSON.stringify(r));process.exitCode=r.ok?0:1;});`;
    const run = spawnSync(process.execPath, ['-e', code, require.resolve('../../scripts/check-install-state.cjs'), JSON.stringify({ before, after, expected })], { encoding: 'utf8', timeout: 3000 });
    assert.equal(run.status, mode === 'consistent' ? 0 : 1, mode + ': ' + run.stderr);
    console.log('synthetic ' + mode + ' exit=' + run.status);
  }
});
test('a window restored during worker checks still fails the combined command', async () => {
  const { before, after } = pair();
  const result = await gate.post(before, () => after, expected, async () => {
    after.windows.push({ id: 2, onScreen: true, bounds: { ...box, x: 40 } });
  }, instant);
  assert.equal(result.ok, false); assert.equal(result.rows[0][3], false);
});
test('worker failure is not swallowed or retried', async () => {
  const { before, after } = pair(); let calls = 0;
  const result = await gate.post(before, () => after, expected, async () => { calls++; throw Error('synthetic failure'); }, instant);
  assert.equal(result.ok, false); assert.equal(calls, 1);
});
test('stability observation includes late restoration and a minimum observation interval', async () => {
  let now = 0, reads = 0;
  const result = await gate.stable(() => { reads++; return { windows: now >= 3000 ? 2 : 1 }; }, {
    now: () => now, sleep: async ms => { now += ms; }, timeoutMs: 15000, minimumMs: 10000, quietMs: 5000, intervalMs: 1000,
  });
  assert.equal(result.windows, 2); assert.equal(now, 10000); assert.equal(reads, 11);
});
test('unavailable or changing metadata times out instead of reporting zero windows as PASS', async () => {
  let n = 0;
  for (const collect of [() => { throw Error('unavailable'); }, () => ({ n: ++n })]) {
    let now = 0; n = 0;
    await assert.rejects(gate.stable(collect, { now: () => now, sleep: async ms => { now += ms; }, timeoutMs: 10, minimumMs: 2, quietMs: 3, intervalMs: 1 }), /did not stabilize/);
    assert.ok(now <= 11);
  }
});
test('views projection excludes drafts, selected sessions, text, and inactive views', () => {
  const result = gate.projectViews([{ owner: 'synthetic', active: true, bounds: box, draft: { text: 'private sentinel' }, selected: 'private session', messages: ['private'] }, { owner: 'closed', active: false, bounds: box }]);
  assert.deepEqual(result, [{ owner: 'synthetic', bounds: box }]);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.throws(() => gate.projectViews([{ owner: 'x', active: true }]), /geometry/);
});
test('native projection never retains window titles and geometry matches one-to-one', () => {
  const windows = gate.projectWindows([{ pid: 100, id: 4, onScreen: true, bounds: box, frame: box, frameBasis: 'native-window-frame-v1', title: 'private sentinel' }], 100);
  assert.equal(JSON.stringify(windows).includes('private'), false);
  assert.equal(gate.geometry([{ bounds: box }, { bounds: box }], windows), false);
  assert.equal(gate.geometry([{ bounds: box }], [{ bounds: { ...box, x: 20.5 } }]), true);
});
test('metadata and runtime FIFO/symlink inputs refuse promptly; valid copied trees retain identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-state-fixture-'));
  try {
    const a = path.join(root, 'a'), b = path.join(root, 'b'); fs.mkdirSync(a); fs.writeFileSync(path.join(a, 'file'), 'synthetic');
    fs.symlinkSync('file', path.join(a, 'internal-link')); fs.cpSync(a, b, { recursive: true, verbatimSymlinks: true });
    assert.deepEqual(gate.runtimeDigest(a), gate.runtimeDigest(b));
    fs.writeFileSync(path.join(b, 'file'), 'changed'); assert.notEqual(gate.runtimeDigest(a).digest, gate.runtimeDigest(b).digest);
    const fifo = path.join(root, 'fifo'); execFileSync('/usr/bin/mkfifo', [fifo]);
    assert.throws(() => gate.read(fifo), /Unsafe metadata/);
    fs.symlinkSync('../b/file', path.join(a, 'escape')); assert.throws(() => gate.runtimeDigest(a), /escaped/);
    fs.unlinkSync(path.join(a, 'escape')); execFileSync('/usr/bin/mkfifo', [path.join(a, 'pipe')]);
    assert.throws(() => gate.runtimeDigest(a), /inventory limit/);
  } finally { fs.rmSync(root, { recursive: true }); }
});
test('missing DSH tree is reported as degradation without loading provider or reading credentials', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-state-dsh-'));
  try { assert.deepEqual(gate.dshState(root, '/nonexistent-app'), { status: 'degraded', reason: 'runtime-missing' }); }
  finally { fs.rmSync(root, { recursive: true }); }
});
test('snapshot output cannot write through a parent alias into the profile or application', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'install-state-output-')));
  try {
    const profile = path.join(root, 'profile'), bundle = path.join(root, 'Synthetic.app'), output = path.join(root, 'output');
    for (const directory of [profile, bundle, output]) fs.mkdirSync(directory, { mode: 0o700 });
    fs.symlinkSync(profile, path.join(root, 'profile-alias')); fs.symlinkSync(bundle, path.join(root, 'bundle-alias'));
    assert.equal(gate.snapshotPath(path.join(output, 'before.json'), profile, bundle), path.join(output, 'before.json'));
    for (const alias of ['profile-alias', 'bundle-alias']) assert.throws(() => gate.snapshotPath(path.join(root, alias, 'before.json'), profile, bundle), /separate private/);
    assert.deepEqual(fs.readdirSync(profile), []); assert.deepEqual(fs.readdirSync(bundle), []);
  } finally { fs.rmSync(root, { recursive: true }); }
});
test('a present but unqualified DSH tree is degradation, not a successful inheritance', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-state-unqualified-'));
  try {
    const dsh = require('../dsh-tui.cjs'), where = dsh.paths(root);
    for (const [directory, version] of [[where.tui, dsh.TUI_VERSION], [where.dsh, dsh.DSH_VERSION]]) {
      fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version }));
    }
    fs.mkdirSync(path.dirname(where.hostEntry), { recursive: true }); fs.writeFileSync(where.hostEntry, '// synthetic, no LLM implementation');
    assert.equal(gate.dshState(root, path.resolve(__dirname, '../..')).status, 'degraded');
  } finally { fs.rmSync(root, { recursive: true }); }
});
test('pre metadata accepts an older bundle without discoveries modules and refuses escaped resources', () => {
  if (process.platform !== 'darwin') { assert.equal(typeof gate.bundleMetadata, 'function'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-state-bundle-'));
  try {
    const app = path.join(root, 'Synthetic.app'); fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true }); fs.mkdirSync(path.join(app, 'Contents/Resources/app'), { recursive: true });
    fs.writeFileSync(path.join(app, 'Contents/MacOS/fixture'), 'synthetic executable metadata only');
    fs.writeFileSync(path.join(app, 'Contents/Info.plist'), JSON.stringify({ CFBundleIdentifier: 'io.github.rulercompass1729.native-agent-workspace.fixture', CFBundleExecutable: 'fixture', CFBundleShortVersionString: '0.1.0-alpha.998', NAWSourceRevision: revision }));
    assert.equal(gate.bundleMetadata(app).version, '0.1.0-alpha.998');
    fs.rmSync(path.join(app, 'Contents/Resources/app'), { recursive: true }); fs.symlinkSync(root, path.join(app, 'Contents/Resources/app'));
    assert.throws(() => gate.bundleMetadata(app), /escaped/);
  } finally { fs.rmSync(root, { recursive: true }); }
});
test('backend metadata binds live process lifetime, full closure, and the read-only version receipt', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'install-state-backend-'))); let live;
  try {
    const f = runtimeFixture.fixture(root); live = await runtimeFixture.start(f);
    const value = gate.backendState(f.profile, live.target);
    assert.equal(value.version, expected.version); assert.equal(value.runtimeHash, f.runtimeHash);
    assert.equal(Object.hasOwn(value, 'revision'), false); assert.equal(value.files, f.entries.length);
    fs.writeFileSync(path.join(f.runtime, 'workspace.cjs'), '// old source'); assert.throws(() => gate.backendState(f.profile, live.target), /source mismatch/);
    fs.copyFileSync(path.join(f.app, 'app/workspace.cjs'), path.join(f.runtime, 'workspace.cjs'));
    fs.writeFileSync(path.join(f.directory, 'service.lock'), JSON.stringify({ ...live.lock, started: 'wrong lifetime' }));
    assert.throws(() => gate.backendState(f.profile, live.target), /process mismatch/);
  } finally { await live?.close(); fs.rmSync(root, { recursive: true }); }
});
test('CoreGraphics helper refuses unavailable native metadata without requesting access', () => {
  const context = vm.createContext({ ObjC: { import() {}, unwrap: x => x, castRefToObject: x => x }, $: { CGWindowListCopyWindowInfo: () => null } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../scripts/fixtures/install-windows.js'), 'utf8'), context);
  assert.throws(() => context.run(['100']), /metadata unavailable/);
  assert.throws(() => context.run([]), /Explicit PID/);
});
