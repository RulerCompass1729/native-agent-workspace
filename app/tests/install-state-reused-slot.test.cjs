const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const runtime = require('../../scripts/fixtures/install-runtime.cjs');
function fixture(t, reused = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'install-reused-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = runtime.fixture(root), pid = 424242, started = 'synthetic lifetime';
  if (reused) {
    const key = 'backends/' + 'c'.repeat(20), directory = path.join(f.profile, key);
    fs.renameSync(f.directory, directory); f.key = key; f.directory = directory; f.runtime = path.join(directory, 'runtimes', f.runtimeHash);
  }
  fs.writeFileSync(path.join(f.profile, 'services.json'), JSON.stringify({ format: 1, active: f.key, entries: [f.key] }));
  const lock = { format: 1, kind: 'service', directory: f.directory, pid, started };
  fs.writeFileSync(path.join(f.directory, 'service.lock'), JSON.stringify(lock));
  const target = { app: f.app, executable: process.execPath, version: f.version };
  const observations = { pid, started, executable: target.executable, command: process.execPath + ' ' + path.join(f.runtime, 'daemon.cjs') + ' ' + f.directory,
    receipt: { servicePid: pid, runtimeVersion: f.version }, queries: 0 };
  const filename = require.resolve('../../scripts/check-install-state.cjs'), normal = createRequire(filename), module = { exports: {} };
  const localRequire = name => name === 'node:child_process' ? { execFileSync(bin, args) {
    if (bin === '/bin/ps') {
      assert.equal(Number(args[args.indexOf('-p') + 1]), observations.pid);
      return observations[{ 'lstart=': 'started', 'comm=': 'executable', 'command=': 'command' }[args.at(-1)]];
    }
    assert.equal(bin, process.execPath); assert.equal(args[0], path.join(path.dirname(filename), 'install-backend-version.cjs'));
    assert.equal(args[1], f.directory); observations.queries++;
    if (observations.queryError) throw Error('synthetic unavailable version');
    if (observations.afterQuery) observations.afterQuery();
    return JSON.stringify(observations.receipt);
  } } : normal(name);
  const run = vm.runInNewContext('(function(require,module,__filename,__dirname){' + fs.readFileSync(filename, 'utf8') + '\n})', { process, console, setTimeout, clearTimeout, Buffer });
  run(localRequire, module, filename, path.dirname(filename));
  return { ...f, target, observations, lock, gate: module.exports, read() { return module.exports.backendState(f.profile, target); } };
}
test('a proved reused slot passes without changing layout, files, or runtime identity', t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.profile, 'services.json'));
  const result = f.read(); assert.equal(result.version, f.version); assert.equal(result.key, f.key); assert.equal(result.runtimeHash, f.runtimeHash);
  assert.equal(f.observations.queries, 1); assert.deepEqual(fs.readFileSync(path.join(f.profile, 'services.json')), before);
});
test('a hash-named slot also needs the live version receipt', t => {
  const f = fixture(t, false); assert.equal(f.read().version, f.version); assert.equal(f.observations.queries, 1);
});
for (const [name, change] of [
  ['wrong PID lifetime', f => { f.observations.started = 'other lifetime'; }],
  ['wrong executable', f => { f.observations.executable = '/synthetic/other-node'; }],
  ['wrong command directory', f => { f.observations.command += '/other'; }],
  ['runtime outside the owned backend', f => { f.observations.command = process.execPath + ' /synthetic/runtimes/' + 'a'.repeat(16) + '/daemon.cjs ' + f.directory; }],
  ['identity source mismatch', f => { fs.appendFileSync(path.join(f.runtime, 'workspace.cjs'), '\n// other'); }],
  ['complete closure mismatch', f => { fs.appendFileSync(path.join(f.runtime, 'dsh-tui.cjs'), '\n// other'); }],
  ['wrong reported version', f => { f.observations.receipt.runtimeVersion = '0.1.0-alpha.998'; }],
  ['wrong response PID', f => { f.observations.receipt.servicePid++; }],
  ['missing version', f => { delete f.observations.receipt.runtimeVersion; }],
  ['unavailable version', f => { f.observations.queryError = true; }],
  ['process changes during the query', f => { f.observations.afterQuery = () => { f.observations.started = 'replaced'; }; }],
  ['command changes during the query', f => { f.observations.afterQuery = () => { f.observations.command += ' other'; }; }],
  ['layout changes during the query', f => { f.observations.afterQuery = () => { fs.writeFileSync(path.join(f.profile, 'services.json'), JSON.stringify({ format: 1, active: f.key, entries: [f.key], pending: 'other' })); }; }],
  ['lock changes during the query', f => { f.observations.afterQuery = () => { fs.writeFileSync(path.join(f.directory, 'service.lock'), JSON.stringify({ ...f.lock, started: 'replaced' })); }; }],
  ['extra private response fields', f => { f.observations.receipt.messages = ['not metadata']; }],
]) test('reused slot refuses ' + name, t => {
  const f = fixture(t); change(f); assert.throws(() => f.read());
});
test('the same source under a hash-named slot cannot hide a wrong live version', t => {
  const f = fixture(t, false); f.observations.receipt.runtimeVersion = '0.1.0-alpha.998'; assert.throws(() => f.read());
});

test('a real isolated backend in a reused slot proves version through the existing protocol', async t => {
  const f = fixture(t); let live;
  try {
    live = await runtime.start(f);
    const g = require('../../scripts/check-install-state.cjs'), result = g.backendState(f.profile, live.target);
    assert.equal(result.key, f.key); assert.equal(result.pid, live.child.pid); assert.equal(result.version, f.version); assert.equal(result.runtimeHash, f.runtimeHash);
  } finally { await live?.close(); }
});
test('a real isolated backend with matching source but a different live version refuses', async t => {
  const f = fixture(t, false); let live;
  try {
    live = await runtime.start(f);
    const g = require('../../scripts/check-install-state.cjs');
    assert.throws(() => g.backendState(f.profile, { ...live.target, version: '0.1.0-alpha.998' }), /Backend version unconfirmed/);
  } finally { await live?.close(); }
});

test('another real Node PID cannot stand in for the active backend', async t => {
  const a=fixture(t),b=fixture(t,false);let first,other;
  try {
    first=await runtime.start(a);other=await runtime.start(b);
    fs.writeFileSync(path.join(a.directory,'service.lock'),JSON.stringify({...first.lock,pid:other.lock.pid,started:other.lock.started}));
    assert.throws(()=>require('../../scripts/check-install-state.cjs').backendState(a.profile,first.target),/Backend command unconfirmed/);
  } finally { await first?.close();await other?.close(); }
});
