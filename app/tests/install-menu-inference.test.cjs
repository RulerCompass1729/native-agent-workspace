'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path'), { spawnSync } = require('node:child_process');
const gate = require('../../scripts/check-install-state.cjs');
const pid = 424242, frame = { x: 20, y: 40, width: 1200, height: 800 };
function fixture() {
  return { windows: [{ pid, id: 1, onScreen: true, bounds: frame, layer: 0 },
    ...Array.from({ length: 4 }, (_, i) => ({ pid, id: i + 2, onScreen: false, layer: 0, bounds: { x: 0, y: 0, width: 2560, height: 30 } }))],
  displays: [{ id: 9, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, menuBarHeight: 30 }] };
}
function collect(input, after = input, managed = [1]) {
  const code = "import importlib.util,json,sys\ns=importlib.util.spec_from_file_location('f',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\np=json.load(sys.stdin);samples=iter([p['before'],p['after']]);proof={'windows':{i:{'id':i,'owner':'owner-'+str(i),'frame':p['frame']} for i in p['managed']},'hiddenBackgroundWindows':{}}\nprint(json.dumps(m.collect(424242,'/synthetic','synthetic',sample=lambda _:next(samples),frames=lambda *_:proof)))";
  return spawnSync('/usr/bin/python3', ['-I', '-B', '-c', code, path.join(__dirname, '../../scripts/install-electron-frames.py')], {
    input: JSON.stringify({ before: input, after, managed, frame }), encoding: 'utf8', timeout: 5000 });
}
test('top-aligned full-width unregistered windows are recorded as geometry inference only', () => {
  const p = collect(fixture()); assert.equal(p.status, 0, p.stderr);
  const value = JSON.parse(p.stdout); assert.deepEqual(value.windows.map(w => w.id), [1]);
  assert.deepEqual(value.inferredMenuWindows, [{ display: 9, count: 4, bounds: fixture().displays[0].bounds, menuBarHeight: 30 }]);
});
for (const [name, change] of [
  ['500x500 unknown', p => { p.windows[1].bounds = { x: 0, y: 940, width: 500, height: 500 }; }],
  ['not at display top', p => { p.windows[1].bounds.y = 1; }],
  ['31 high with menu height30', p => { p.windows[1].bounds.height = 31; }],
  ['one pixel narrower', p => { p.windows[1].bounds.width--; }],
  ['one pixel shifted horizontally', p => { p.windows[1].bounds.x++; }],
  ['five per display', p => { p.windows.push({ ...p.windows[1], id: 20 }); }],
  ['wrong layer', p => { p.windows[1].layer = 24; }],
  ['foreign PID', p => { p.windows[1].pid++; }],
  ['menu height unavailable', p => { p.displays[0].menuBarHeight = null; }],
  ['displays unavailable', p => { p.displays = []; }],
  ['ambiguous display match', p => { p.displays.push({ ...p.displays[0], id: 10 }); }],
]) test('geometry inference refuses ' + name, () => {
  const p = fixture(); change(p); const result = collect(p);
  assert.equal(result.status, 1); assert.match(result.stderr, /frame 口径待核实/);
});
test('endpoint-managed thin windows remain business windows', () => {
  const value = JSON.parse(collect(fixture(), undefined, [1, 2]).stdout);
  assert.deepEqual(value.windows.map(w => w.id), [1, 2]); assert.equal(value.inferredMenuWindows[0].count, 3);
});
test('nonzero display origins and independent per-display limits are respected', () => {
  const p = fixture(); p.displays[0].bounds.x = -2560; p.displays[0].bounds.y = -1440;
  for (const row of p.windows.slice(1)) { row.bounds.x = -2560; row.bounds.y = -1440; }
  const result = collect(p); assert.equal(result.status, 0, result.stderr);
  p.displays.push({ id: 10, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, menuBarHeight: 24 });
  p.windows.push(...Array.from({ length: 4 }, (_, i) => ({ pid, id: i + 30, layer: 0, onScreen: false, bounds: { x: 0, y: 0, width: 1920, height: 24 } })));
  const two = collect(p); assert.equal(two.status, 0, two.stderr);
  assert.deepEqual(JSON.parse(two.stdout).inferredMenuWindows.map(g => g.count), [4, 4]);
  p.windows.push({ ...p.windows.at(-1), id: 40 }); assert.equal(collect(p).status, 1);
});
test('display metadata and excluded windows must stay stable across both samples', () => {
  const before = fixture(), after = fixture(); after.displays[0].menuBarHeight = 29;
  assert.equal(collect(before, after).status, 1);
  const changed = fixture(); changed.windows[1].id = 90;
  assert.equal(collect(before, changed).status, 1);
});
function pair() {
  const expected = { version: '0.1.0-alpha.999', revision: 'a'.repeat(40) };
  const base = { profile: '/synthetic', gui: { pid: 100, started: 'before' }, views: [{ owner: 'owner', bounds: { ...frame } }], windows: [{ onScreen: true, bounds: { ...frame } }],
    bundle: { ...expected, runtimeHash: 'b'.repeat(16) }, backend: { key: 'old', ...expected, runtimeHash: 'b'.repeat(16), evidence: 'active-key+live-lock+runtime-source' },
    dsh: { status: 'qualified', digest: 'same' }, inferredMenuWindows: [{ display: 9, count: 4, bounds: fixture().displays[0].bounds, menuBarHeight: 30 }] };
  return { before: base, after: { ...structuredClone(base), gui: { pid: 101, started: 'after' } }, expected };
}
test('pre/post compares inferred counts; a late worker-interval change is refused', async () => {
  const { before, after, expected } = pair(); let calls = 0;
  const result = await gate.post(before, () => after, expected, async () => { calls++; after.inferredMenuWindows[0].count--; }, { minimumMs: 0, quietMs: 0 });
  assert.equal(result.ok, false); assert.equal(calls, 1);
});
test('pre/post rejects changed counts before workers, unchanged inference still passes', async () => {
  const { before, after, expected } = pair(); let calls = 0;
  after.inferredMenuWindows[0].count--;
  assert.equal((await gate.post(before, () => after, expected, async () => calls++, { minimumMs: 0, quietMs: 0 })).ok, false);
  assert.equal(calls, 0); after.inferredMenuWindows[0].count++;
  assert.equal((await gate.post(before, () => after, expected, async () => calls++, { minimumMs: 0, quietMs: 0 })).ok, true);
});
test('NSScreen frame/visibleFrame supplies menu height without reading titles; unavailable displays give no exclusion', () => {
  const vm = require('node:vm'), fs = require('node:fs'); let titles = 0;
  const row = { kCGWindowOwnerPID: pid, kCGWindowLayer: 0, kCGWindowNumber: 1, kCGWindowIsOnscreen: false, kCGWindowBounds: { X: 0, Y: 0, Width: 2560, Height: 30 } };
  Object.defineProperty(row, 'kCGWindowName', { get() { titles++; throw Error('No title reads'); } });
  const dict = object => ({ objectForKey(key) { const v = object[key]; return v && typeof v === 'object' ? dict(v) : v; } });
  const screens = { count: 1, objectAtIndex: () => ({ deviceDescription: dict({ NSScreenNumber: 9 }), frame: { origin: { x: 0, y: 0 }, size: { width: 2560, height: 1440 } }, visibleFrame: { origin: { x: 0, y: 0 }, size: { width: 2560, height: 1410 } } }) };
  const api = { CGWindowListCopyWindowInfo: () => ({ count: 1, objectAtIndex: () => dict(row) }), NSScreen: { screens }, CGDisplayBounds: () => ({ origin: { x: 0, y: 0 }, size: { width: 2560, height: 1440 } }) };
  const c = vm.createContext({ ObjC: { import() {}, unwrap: v => v, castRefToObject: v => v }, $: api });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../scripts/fixtures/install-windows.js'), 'utf8'), c);
  const result = JSON.parse(c.run([String(pid), '--menu-metadata'])); assert.equal(result.displays[0].menuBarHeight, 30); assert.equal(titles, 0);
  api.NSScreen = undefined; assert.deepEqual(JSON.parse(c.run([String(pid), '--menu-metadata'])).displays, []);
});
test('pre captures live bounds of the same owner; post must retain that live position', async () => {
  const { before, after, expected } = pair(), saved = structuredClone(before.views);
  before.windows[0].owner = 'owner'; before.windows[0].bounds.y += 10;
  before.views = gate.liveViewBaseline(before.views, before.windows);
  assert.equal(saved[0].bounds.y, 40); assert.equal(before.views[0].bounds.y, 50);
  after.views[0].bounds.y = 50; after.windows[0].bounds.y = 50;
  assert.equal((await gate.post(before, () => after, expected, async () => {}, { minimumMs: 0, quietMs: 0 })).ok, true);
  after.views[0].bounds.y = 40; after.windows[0].bounds.y = 40;
  assert.equal((await gate.post(before, () => after, expected, async () => {}, { minimumMs: 0, quietMs: 0 })).ok, false);
});
test('live pre baseline refuses missing, extra, duplicate or unbound business owners', () => {
  const views = [{ owner: 'owner', bounds: frame }], window = { owner: 'owner', bounds: frame };
  for (const rows of [[], [window, window], [{ ...window, owner: 'other' }], [{ bounds: frame }]]) {
    assert.throws(() => gate.liveViewBaseline(views, rows));
  }
});
