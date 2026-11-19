const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { createOutboxBroker } = require('../computer-use-outbox-broker.cjs');
const { processIdentityUTC } = require('../platform.cjs');
const gate = require('../../scripts/check-install-state.cjs');
const frame = { x: 285, y: 160, width: 1904, height: 1042 };
function context(owner = 'synthetic-owner', number = 1) {
  return { view: { owner, bounds: { x: 1, y: 2, width: 3, height: 4 } }, background: false,
    win: { isDestroyed: () => false, isVisible: () => true, isFocusable: () => true,
      getMediaSourceId: () => `window:${number}:0`, getBounds: () => ({ ...frame }),
      getTitle() { throw Error('Window titles must never be read'); } } };
}
function collectBackground(extra = [], includeUnknown = false) {
  const { windowFrames } = require('../window-frames.cjs');
  const background = context('background-owner', 2); background.background = true;
  background.win.isVisible = () => false; background.win.isFocusable = () => false;
  const proof = windowFrames([context(), background, ...(includeUnknown ? [context('unknown-owner', 3)] : [])]);
  const records = [{ pid: 424242, id: 1, onScreen: true, bounds: frame },
    { pid: 424242, id: 2, onScreen: false, bounds: frame }, ...extra];
  const code = "import importlib.util,json,sys; s=importlib.util.spec_from_file_location('f',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)\n" +
    "p=json.load(sys.stdin); proof=p['proof']; live={r['id']:r for r in proof} if isinstance(proof,list) else {k:{r['id']:r for r in rows} for k,rows in proof.items()}\n" +
    "print(json.dumps(m.collect(424242,'/synthetic','lifetime',sample=lambda _:p['records'],frames=lambda *_:live)))";
  return require('node:child_process').spawnSync('/usr/bin/python3', ['-I', '-B', '-c', code,
    path.join(__dirname, '../../scripts/install-electron-frames.py')], { input: JSON.stringify({ proof, records }), encoding: 'utf8', timeout: 5000 });
}
test('G F1: correct human frame plus a proven hidden background window is collectable', () => {
  const result = collectBackground(); assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.deepEqual(value.windows.map(w => w.id), [1]); assert.deepEqual(value.windows[0].frame, frame);
});
test('G F1: an unknown human window beside a legitimate background window is still refused', () => {
  const result = collectBackground([{ pid: 424242, id: 3, onScreen: true, bounds: frame }]);
  assert.equal(result.status, 1); assert.match(result.stderr, /frame 口径待核实/);
});
test('an extra managed human owner cannot be hidden behind the background exclusion', () => {
  const result = collectBackground([{ pid: 424242, id: 3, onScreen: false, bounds: frame }], true);
  assert.equal(result.status, 0, result.stderr);
  const windows = gate.projectWindows(JSON.parse(result.stdout).windows, 424242);
  assert.equal(gate.geometry([{ owner: 'synthetic-owner', bounds: frame }], windows), false);
});
test('Electron evidence reads live getBounds and never saved bounds or titles', () => {
  const { windowFrames } = require('../window-frames.cjs');
  assert.deepEqual(windowFrames([context()]), { windows: [{ id: 1, owner: 'synthetic-owner', frame }], hiddenBackgroundWindows: [] });
});
test('Electron evidence separates proven hidden background windows and rejects duplicate owners or IDs', () => {
  const { windowFrames } = require('../window-frames.cjs');
  const background = context('background', 2); background.background = true;
  background.win.isVisible = () => false; background.win.isFocusable = () => false;
  assert.deepEqual(windowFrames([context(), background, { ...context('destroyed', 3), win: { isDestroyed: () => true } }]),
    { windows: [{ id: 1, owner: 'synthetic-owner', frame }], hiddenBackgroundWindows: [{ id: 2, owner: 'background', frame }] });
  for (const rows of [[context(), context()], [context(), context('other', 1)]]) assert.throws(() => windowFrames(rows));
  const bad = context(); bad.win.getBounds = () => ({ ...frame, width: NaN }); assert.throws(() => windowFrames([bad]));
});
test('background exclusion requires hidden, nonfocusable and stable Main classification', () => {
  const { windowFrames } = require('../window-frames.cjs');
  for (const change of [b => { b.win.isVisible = () => true; }, b => { b.win.isFocusable = () => true; },
    b => { delete b.win.isVisible; }, b => { delete b.win.isFocusable; },
    b => { b.win.getBounds = () => { b.background = false; return frame; }; },
    b => { b.win.getBounds = () => { b.win.isVisible = () => true; return frame; }; },
    b => { b.win.getBounds = () => { b.win.isFocusable = () => true; return frame; }; }]) {
    const b = context('background', 2); b.background = true;
    b.win.isVisible = () => false; b.win.isFocusable = () => false; change(b);
    assert.throws(() => windowFrames([context(), b]));
  }
});
test('a window destroyed or rebound while sampling cannot yield a partial frame proof', () => {
  const { windowFrames } = require('../window-frames.cjs');
  const changed = context(); let calls = 0;
  changed.win.getMediaSourceId = () => `window:${++calls}:0`;
  assert.throws(() => windowFrames([changed]));
  const closed = context(); closed.win.getBounds = () => { closed.win.isDestroyed = () => true; return frame; };
  assert.throws(() => windowFrames([closed]));
});
async function request(file, change = {}) {
  const d = JSON.parse(fs.readFileSync(file));
  return new Promise((resolve, reject) => {
    const socket = net.connect(d.socketPath); let body = '';
    socket.setTimeout(1000, () => { socket.destroy(); reject(Error('fixture deadline')); });
    socket.on('error', reject); socket.on('data', b => body += b);
    socket.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    socket.on('connect', () => socket.write(JSON.stringify({ kind: 'window-frames', capability: d.capability,
      identity: d.issuer, nonce: '1'.repeat(32), ...change }) + '\n'));
  });
}
test('existing authenticated GUI socket provides fresh frame metadata without control, AX or native input', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-frame-owner-')); fs.chmodSync(root, 0o700);
  let reads = 0;
  const no = () => { throw Error('No action or AX may run'); };
  const broker = await createOutboxBroker({ descriptorFile: path.join(root, 'owner.json'), bind: no, createView: no,
    control: no, acquireAccessibility: no, windowFrames: () => { reads++; return {
      windows: [{ id: 1, owner: 'synthetic-owner', frame }], hiddenBackgroundWindows: [{ id: 2, owner: 'background', frame }] }; } });
  t.after(async () => { await broker.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const result = await request(broker.descriptorFile);
  assert.equal(result.basis, 'electron-getbounds-v1'); assert.equal(result.pid, process.pid);
  assert.equal(result.started, processIdentityUTC(process.pid).started); assert.equal(result.nonce, '1'.repeat(32));
  const directory = fs.statSync(root, { bigint: true });
  assert.deepEqual(result.profile, { dev: String(directory.dev), ino: String(directory.ino) });
  assert.ok(Date.now() - result.capturedAt < 1000); assert.deepEqual(result.windows, [{ id: 1, owner: 'synthetic-owner', frame }]);
  assert.deepEqual(result.hiddenBackgroundWindows, [{ id: 2, owner: 'background', frame }]);
  for (const row of [...result.windows, ...result.hiddenBackgroundWindows]) assert.deepEqual(Object.keys(row).sort(), ['frame', 'id', 'owner']);
  assert.equal(reads, 1);
  for (const bad of [{ capability: '0'.repeat(64) }, { nonce: 'bad' }, { identity: { pid: process.pid, started: 'stale' } }, { extra: true }]) {
    assert.equal((await request(broker.descriptorFile, bad)).basis, undefined);
  }
  assert.equal(reads, 1, 'invalid requests cannot even read the window getter');
});
function rows() { return [{ pid: 424242, id: 1, owner: 'synthetic-owner', onScreen: true,
  bounds: { x: 297, y: 168, width: 1867, height: 1022 }, frame: { ...frame }, frameBasis: 'electron-getbounds-v1' }]; }
test('G oracle: CG is false, matching Electron frame true, real 2px displacement false', () => {
  const views = [{ owner: 'synthetic-owner', bounds: frame }];
  assert.equal(gate.geometry(views, rows()), false);
  assert.equal(gate.geometry(views, gate.projectWindows(rows(), 424242)), true);
  const moved = rows(); moved[0].frame.x += 2;
  assert.equal(gate.geometry(views, gate.projectWindows(moved, 424242)), false);
});
test('matching rectangles from another view owner cannot satisfy the gate', () => {
  const windows = gate.projectWindows(rows(), 424242);
  assert.equal(gate.geometry([{ owner: 'other-owner', bounds: frame }], windows), false);
});
test('public GUI frame bridge refuses stale, foreign, malformed and changing identity evidence', () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync('/usr/bin/python3', ['-I', '-B', path.join(__dirname, '../../scripts/fixtures/test-install-electron-frames.py')], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stdout + result.stderr); console.log(result.stderr);
});
test('Main wires only its managed contexts and packages the public getter module', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  assert.match(source, /windowFrames:\s*\(\) => require\('\.\/window-frames\.cjs'\)\.windowFrames\(windows\.values\(\)\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '../../scripts/package-mac.cjs'), 'utf8'), /'window-frames\.cjs'/);
});
test('real kernel peer PID mismatch receives no capability bytes', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'install-peer-'))); fs.chmodSync(root, 0o700);
  const socketPath = path.join(root, 'outbox.sock'); let bytes = 0;
  const server = net.createServer(socket => { socket.on('error', () => {}); socket.on('data', b => bytes += b.length); });
  await new Promise(resolve => server.listen(socketPath, resolve)); fs.chmodSync(socketPath, 0o600);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, 'outbox-owner.json'), JSON.stringify({ version: 1, socketPath, capability: 'a'.repeat(64), issuer: { pid: 424242, started: 'synthetic' } }), { mode: 0o600 });
  const code = "import importlib.util,sys; s=importlib.util.spec_from_file_location('f',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)\ntry:m.request(sys.argv[2],424242,'synthetic')\nexcept ValueError:sys.exit(0)\nsys.exit(3)";
  const result = require('node:child_process').spawnSync('/usr/bin/python3', ['-I', '-B', '-c', code, path.join(__dirname, '../../scripts/install-electron-frames.py'), root], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr); await new Promise(resolve => setImmediate(resolve));
  assert.equal(bytes, 0);
});
