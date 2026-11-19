'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const workers = require('./test-discoveries-bundle.cjs');
const { literalLists } = require('./runtime-closure-source.cjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const refusal = reason => Object.assign(new Error(reason), { installStateReason: reason });
const invoke = (file, args, timeout = 1000) => execFileSync(file, args, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const identityFiles = ['daemon.cjs', 'adapters.cjs', 'codex-terminal-bridge.cjs', 'workspace.cjs'];
function safePath(input) {
  const lexical = path.resolve(input);
  for (const name of ['Containers', 'Group Containers']) {
    const forbidden = path.join(os.homedir(), 'Library', name);
    if (lexical === forbidden || lexical.startsWith(forbidden + path.sep)) throw refusal('App containers are outside this check');
  }
  const real = fs.realpathSync(lexical);
  for (const name of ['Containers', 'Group Containers']) {
    const forbidden = path.join(os.homedir(), 'Library', name);
    if (real === forbidden || real.startsWith(forbidden + path.sep)) throw refusal('App containers are outside this check');
  }
  return real;
}
function bundleMetadata(input) {
  const bundle = safePath(input), info = JSON.parse(invoke('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(bundle, 'Contents/Info.plist')]));
  if (!/^io\.github\.rulercompass1729\.native-agent-workspace(?:\.[a-z0-9.-]+)?$/.test(info.CFBundleIdentifier) || !/^[a-f0-9]{40}$/.test(info.NAWSourceRevision) || typeof info.CFBundleExecutable !== 'string' || path.basename(info.CFBundleExecutable) !== info.CFBundleExecutable) throw refusal('Bundle identity unavailable');
  const executable = safePath(path.join(bundle, 'Contents/MacOS', info.CFBundleExecutable)), app = safePath(path.join(bundle, 'Contents/Resources/app'));
  if (![executable, app].every(p => p.startsWith(bundle + path.sep))) throw refusal('Bundle resource escaped');
  return { bundle, executable, app, version: info.CFBundleShortVersionString, revision: info.NAWSourceRevision };
}
function runtimeClosure(app) {
  let source;
  try { source = read(path.join(app, 'app/service-client.cjs')).toString('utf8'); }
  catch { throw refusal('Runtime closure definition unconfirmed'); }
  let lists;
  try { lists = literalLists(source); }
  catch { throw refusal('Runtime closure definition unconfirmed'); }
  for (const name of ['names', 'pluginFiles', 'pluginTests']) {
    if (lists[name].some(file => file.startsWith('/') || file.split('/').includes('..'))) throw refusal('Runtime closure path unconfirmed');
  }
  if (!identityFiles.every(file => lists.names.includes(file)) || !lists.names.includes('dsh-tui.cjs')) throw refusal('Runtime closure coverage unconfirmed');
  const files = [...lists.names.map(file => [file, file]), ...lists.pluginFiles.map(file => ['claude-bridge/' + file, 'claude-bridge/' + file]), ...lists.pluginTests.map(file => ['claude-bridge/' + file, 'claude-bridge-tests/' + file])];
  const digest = createHash('sha256');
  try { for (const [file] of files) digest.update(read(path.join(app, 'app', file))); }
  catch { throw refusal('Runtime closure inputs unconfirmed'); }
  return { files, hash: digest.digest('hex').slice(0, 16) };
}
function snapshotPath(input, profile, bundle) {
  const requested = path.resolve(input), parent = safePath(path.dirname(requested)), stat = fs.statSync(parent);
  const destination = path.join(parent, path.basename(requested));
  if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o077 || [profile, bundle].some(root => destination === root || destination.startsWith(root + path.sep))) throw refusal('Snapshot needs a separate private output directory');
  return destination;
}
function read(file, limit = 16 * 1024 * 1024) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid() || s.nlink !== 1 || s.size > limit) throw refusal('Unsafe metadata file');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
const json = file => JSON.parse(read(file).toString('utf8'));
function bounds(value) {
  if (!value || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(value[k])) || value.width <= 0 || value.height <= 0) throw refusal('Missing window geometry');
  return Object.fromEntries(['x', 'y', 'width', 'height'].map(k => [k, value[k]]));
}
function projectViews(values) {
  if (!Array.isArray(values) || values.length > 10000) throw refusal('Invalid views record');
  const result = values.filter(v => v.active === true).map(v => {
    if (typeof v.owner !== 'string' || !v.owner || v.owner.length > 200) throw refusal('Invalid view owner');
    return { owner: v.owner, bounds: bounds(v.bounds) };
  }).sort((a, b) => a.owner.localeCompare(b.owner));
  if (!result.length || new Set(result.map(v => v.owner)).size !== result.length) throw refusal('Active views unavailable');
  return result;
}
function projectWindows(values) {
  if (!Array.isArray(values) || values.length > 1000) throw refusal('Window metadata unavailable');
  return values.map(w => {
    if (!Number.isSafeInteger(w.id) || w.id <= 0 || typeof w.onScreen !== 'boolean') throw refusal('Invalid native window metadata');
    return { id: w.id, onScreen: w.onScreen, bounds: bounds(w.bounds) };
  }).sort((a, b) => a.id - b.id);
}
const near = (a, b) => ['x', 'y', 'width', 'height'].every(k => Math.abs(a[k] - b[k]) <= 1);
function geometry(views, windows) {
  // Identical bounds can belong to several views; require a one-to-one match.
  const used = new Set();
  return views.every(v => { const i = windows.findIndex((w, i) => !used.has(i) && near(v.bounds, w.bounds)); if (i < 0) return false; used.add(i); return true; });
}
function runtimeDigest(root) {
  const digest = createHash('sha256'), started = performance.now(); let entries = 0, bytes = 0;
  const tick = () => { if (performance.now() - started > 30000) throw refusal('Runtime inspection deadline'); };
  const visit = relative => {
    tick(); const file = path.join(root, relative), s = fs.lstatSync(file);
    if (++entries > 120000 || relative.split(path.sep).length > 32 || s.uid !== process.getuid() || !s.isSymbolicLink() && s.mode & 0o022) throw refusal('Unsafe runtime tree');
    digest.update(JSON.stringify(relative));
    if (s.isSymbolicLink()) {
      const target = fs.readlinkSync(file), resolved = fs.realpathSync(file);
      if (path.isAbsolute(target) || !resolved.startsWith(root + path.sep)) throw refusal('Runtime link escaped');
      digest.update('link:' + target); return;
    }
    if (s.isDirectory()) { digest.update('directory'); for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name)); return; }
    if (!s.isFile() || s.nlink !== 1 || (bytes += s.size) > 2 * 1024 ** 3) throw refusal('Runtime inventory limit');
    digest.update('file:' + s.size + ':');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK), buffer = Buffer.alloc(128 * 1024);
    try {
      if (fs.fstatSync(fd).ino !== s.ino) throw refusal('Runtime changed');
      let n; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) { tick(); digest.update(buffer.subarray(0, n)); }
      const end = fs.fstatSync(fd);
      if (end.size !== s.size || end.mtimeMs !== s.mtimeMs || end.ctimeMs !== s.ctimeMs) throw refusal('Runtime changed');
    } finally { fs.closeSync(fd); }
  };
  visit(''); return { digest: digest.digest('hex'), entries, bytes };
}
function dshState(backend, app) {
  const root = path.join(backend, 'dsh-tui/runtime');
  if (!fs.existsSync(root)) return { status: 'degraded', reason: 'runtime-missing' };
  try {
    const inventory = runtimeDigest(root);
    require(path.join(app, 'app/dsh-tui.cjs')).verifyRuntime(backend);
    return { status: 'qualified', ...inventory };
  } catch { return { status: 'degraded', reason: 'runtime-unqualified-or-inspection-failed' }; }
}
function preDsh(profile, backend, app) {
  const state = dshState(backend.directory, app);
  if (state.reason !== 'runtime-missing') return state;
  const layout = json(path.join(profile, 'services.json'));
  if (!Array.isArray(layout.entries) || layout.entries.length > 100) throw refusal('Donor layout unconfirmed');
  state.donors = [];
  for (const key of layout.entries) {
    if (key === backend.key) continue;
    if (!(key === '.' || /^backends\/[a-f0-9]{20}$/.test(key))) throw refusal('Donor directory unconfirmed');
    const directory = path.join(profile, key);
    if (safePath(directory) !== directory) throw refusal('Donor directory linked');
    const donor = dshState(directory, app);
    if (donor.status === 'qualified') state.donors.push({ key, ...donor });
  }
  return state;
}
const qualified = state => state?.status === 'qualified' && typeof state.digest === 'string' && state.digest.length > 0;
const donorKey = key => key === '.' || /^backends\/[a-f0-9]{20}$/.test(key);
const preDshReady = state => Boolean(qualified(state) || state?.status === 'degraded' && state.reason === 'runtime-missing' && state.donors?.some(d => qualified(d) && donorKey(d.key)));
function processInfo(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) throw refusal('Explicit GUI PID required');
  const env = { ...process.env, LC_ALL: 'C', TZ: 'UTC' };
  const started = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1000, env }).trim();
  const executable = invoke('/bin/ps', ['-ww', '-p', String(pid), '-o', 'comm=']).trim();
  if (!started || !path.isAbsolute(executable)) throw refusal('Process identity unavailable');
  return { pid, started, executable };
}
function backendState(profile, target) {
  const layout = json(path.join(profile, 'services.json')), key = layout.active;
  if (layout.format !== 1 || !/^backends\/[a-f0-9]{20}$/.test(key) || !Array.isArray(layout.entries) || !layout.entries.includes(key) || layout.pending) throw refusal('Active backend layout unconfirmed');
  const directory = path.join(profile, key);
  if (safePath(directory) !== directory) throw refusal('Backend directory linked');
  const lock = json(path.join(directory, 'service.lock'));
  if (lock.format !== 1 || lock.kind !== 'service' || lock.directory !== directory) throw refusal('Backend ownership unconfirmed');
  const owner = processInfo(lock.pid);
  if (owner.started !== lock.started || owner.executable !== target.executable) throw refusal('Backend process mismatch');
  const command = invoke('/bin/ps', ['-ww', '-p', String(lock.pid), '-o', 'command=']).trim();
  const suffix = ' ' + directory;
  if (!command.endsWith(suffix)) throw refusal('Backend command unconfirmed');
  const runtimeMatch = command.slice(0, -suffix.length).match(/ (\/.*\/runtimes\/[a-f0-9]{16})\/daemon\.cjs$/);
  if (!runtimeMatch || !runtimeMatch[1].startsWith(directory + '/runtimes/')) throw refusal('Backend runtime unconfirmed');
  const runtime = runtimeMatch[1];
  if (safePath(runtime) !== runtime) throw refusal('Runtime closure directory unconfirmed');
  for (const name of identityFiles) {
    const source = read(path.join(target.app, 'app', name)), running = read(path.join(runtime, name));
    if (!source.equals(running)) throw refusal('Backend source mismatch');
  }
  const closure = runtimeClosure(target.app), liveHash = createHash('sha256');
  for (const [source, destination] of closure.files) {
    let actual, expected;
    try { actual = read(path.join(runtime, destination)); expected = read(path.join(target.app, 'app', source)); }
    catch { throw refusal('Runtime closure source unconfirmed'); }
    if (!actual.equals(expected)) throw refusal('Runtime closure source unconfirmed');
    liveHash.update(actual);
  }
  const runtimeHash = liveHash.digest('hex').slice(0, 16);
  if (path.basename(runtime) !== runtimeHash || runtimeHash !== closure.hash) throw refusal('Runtime closure hash unconfirmed');
  // Slot names survive reuse; only the verified live daemon can report its version.
  let receipt;
  try {
    receipt = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'install-backend-version.cjs'), directory], {
      encoding: 'utf8', timeout: 6000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'pipe'], env: { ELECTRON_RUN_AS_NODE: '1' },
    }));
  } catch { throw refusal('Backend version unconfirmed'); }
  if (!receipt || Object.keys(receipt).sort().join(',') !== 'runtimeVersion,servicePid' || receipt.servicePid !== owner.pid ||
      typeof receipt.runtimeVersion !== 'string' || !receipt.runtimeVersion || receipt.runtimeVersion !== target.version) throw refusal('Backend version unconfirmed');
  const current = processInfo(lock.pid), latest = json(path.join(directory, 'service.lock'));
  if (current.started !== owner.started || current.executable !== owner.executable ||
      invoke('/bin/ps', ['-ww', '-p', String(lock.pid), '-o', 'command=']).trim() !== command ||
      JSON.stringify(latest) !== JSON.stringify(lock) || JSON.stringify(json(path.join(profile, 'services.json'))) !== JSON.stringify(layout)) throw refusal('Backend process changed');
  return { key, pid: owner.pid, started: owner.started, version: receipt.runtimeVersion, runtimeHash, files: closure.files.length, evidence: 'active-key+live-lock+runtime-source', directory };
}
function collector(options, helper, target) {
  return () => {
    const gui = processInfo(options.pid);
    if (gui.executable !== target.executable) throw refusal('GUI executable mismatch');
    const views = projectViews(json(path.join(options.profile, 'views.json')));
    const windows = projectWindows(JSON.parse(invoke('/usr/bin/osascript', ['-l', 'JavaScript', helper, String(options.pid)], 3000)));
    if (!windows.length) throw refusal('No GUI window metadata; unlock or verify the explicit PID, do not request permissions');
    const backend = backendState(options.profile, target);
    return { profile: options.profile, gui, views, windows, backend, bundle: { version: target.version, revision: target.revision, runtimeHash: runtimeClosure(target.app).hash } };
  };
}
async function stable(collect, { timeoutMs = 60000, minimumMs = 20000, quietMs = 5000, intervalMs = 1000, now = () => performance.now(), sleep = wait } = {}) {
  const start = now(); let previous, unchanged = start, lastReason = 'none';
  while (now() - start <= timeoutMs) {
    let state;
    try { state = collect(); } catch (error) { lastReason = error.installStateReason || 'metadata-unavailable'; previous = undefined; unchanged = now(); await sleep(intervalMs); continue; }
    const signature = JSON.stringify(state);
    if (signature !== previous) { previous = signature; unchanged = now(); }
    if (now() - start >= minimumMs && now() - unchanged >= quietMs) return state;
    await sleep(intervalMs);
  }
  throw refusal('UI metadata did not stabilize within the bounded observation; last condition: ' + lastReason);
}
function compare(before, after, expected) {
  const count = state => state.windows.filter(w => w.onScreen).length;
  const inherited = qualified(after.dsh) && qualified(before.dsh) && before.dsh.digest === after.dsh.digest;
  const donor = before.dsh.status === 'degraded' && before.dsh.reason === 'runtime-missing' && before.dsh.donors?.find(d => qualified(d) && donorKey(d.key) && d.digest === after.dsh.digest);
  const restored = qualified(after.dsh) && Boolean(donor);
  const dshNotice = inherited ? (before.backend.key === after.backend.key ? 'retained, qualified' : 'inherited (identical tree), qualified') : restored ? 'restored, qualified; donor=' + donor.key : after.dsh.status === 'qualified' ? 'qualified; recovery provenance unconfirmed' : 'degraded: ' + after.dsh.reason;
  const saved = new Map(before.views.map(v => [v.owner, v.bounds]));
  const retainedBounds = after.views.every(v => saved.has(v.owner) && near(saved.get(v.owner), v.bounds));
  const closureMatches = /^[a-f0-9]{16}$/.test(after.backend.runtimeHash || '') && after.backend.runtimeHash === after.bundle.runtimeHash;
  return [
    ['on-screen windows', count(before), count(after), count(before) === count(after)],
    ['active view owners', before.views.length, after.views.length, JSON.stringify(before.views.map(v => v.owner)) === JSON.stringify(after.views.map(v => v.owner))],
    ['saved bounds retained (±1px)', 'same owner / same bounds', retainedBounds ? 'preserved' : 'changed; no automatic display/clamp exception', retainedBounds],
    ['views ↔ native bounds (±1px)', 'one-to-one', geometry(after.views, after.windows) ? 'match' : 'mismatch', geometry(after.views, after.windows)],
    ['profile identity', 'same', before.profile === after.profile ? 'same' : 'different', before.profile === after.profile],
    ['GUI restarted', 'new process lifetime', 'checked', before.gui.pid !== after.gui.pid || before.gui.started !== after.gui.started],
    ['bundle version / SHA', expected.version + ' / ' + expected.revision, after.bundle.version + ' / ' + after.bundle.revision, after.bundle.version === expected.version && after.bundle.revision === expected.revision],
    ['active backend closure', 'release-matching version / complete runtime hash', after.backend.version + ' / ' + (after.backend.runtimeHash || 'unconfirmed'), after.backend.version === expected.version && closureMatches && after.backend.evidence === 'active-key+live-lock+runtime-source'],
    ['DSH runtime', 'qualified inheritance or proved donor recovery', dshNotice, inherited || restored],
  ];
}
async function post(before, collect, expected, gate, options) {
  const after = await stable(collect, options);
  const rows = compare(before, after, expected);
  if (!rows.every(row => row[3])) return { ok: false, rows };
  try { await gate(); rows.push(['r6 sandbox workers', '5 pass; ips +0', 'pass', true]); }
  catch { rows.push(['r6 sandbox workers', '5 pass; ips +0', 'failed (see gate output)', false]); }
  // A late restored window must not be hidden by the worker-check interval.
  const final = collect(true), finalRows = compare(before, final, expected);
  return { ok: rows.every(row => row[3]) && finalRows.every(row => row[3]), rows: [...finalRows, rows.at(-1)] };
}
function print(rows) {
  console.log('| Check | Before / expected | After | Result |\n|---|---|---|---|');
  for (const [name, expected, actual, ok] of rows) console.log(`| ${name} | ${expected} | ${actual} | ${ok ? 'PASS' : 'FAIL'} |`);
}
async function main(argv = process.argv.slice(2)) {
  const [mode, ...args] = argv, options = {};
  if (!['pre', 'post'].includes(mode) || args.length % 2) throw refusal('Usage: pre|post --bundle APP --profile DATA --pid PID --snapshot PRIVATE_FILE [--version VERSION --revision SHA]');
  for (let i = 0; i < args.length; i += 2) {
    if (!['--bundle', '--profile', '--pid', '--snapshot', '--version', '--revision'].includes(args[i]) || options[args[i].slice(2)]) throw refusal('Unknown or duplicate argument');
    options[args[i].slice(2)] = args[i + 1];
  }
  if (process.platform !== 'darwin' || !options.bundle || !options.profile || !options.snapshot || !/^\d+$/.test(options.pid || '')) throw refusal('Explicit macOS bundle, profile, PID and private snapshot required');
  options.pid = Number(options.pid); options.profile = safePath(options.profile);
  const target = bundleMetadata(options.bundle);
  const snapshot = snapshotPath(options.snapshot, options.profile, target.bundle);
  const helper = path.join(__dirname, 'fixtures/install-windows.js');
  {
    const collect = collector(options, helper, target), expected = { version: options.version, revision: options.revision };
    if (mode === 'pre') {
      const state = collect(); state.dsh = preDsh(options.profile, state.backend, target.app);
      if (!geometry(state.views, state.windows)) throw refusal('Pre-install views/native geometry mismatch');
      fs.writeFileSync(snapshot, JSON.stringify({ format: 1, capturedAt: new Date().toISOString(), ...state }, null, 2), { flag: 'wx', mode: 0o600 });
      print([['pre snapshot', 'private metadata only', 'recorded', true], ['on-screen windows', state.windows.filter(w => w.onScreen).length, 'recorded', true], ['active views / geometry', state.views.length, 'one-to-one match', true], ['active backend closure', state.backend.version, state.backend.runtimeHash, true], ['DSH runtime', 'qualified or known recovery donor', state.dsh.status + (state.dsh.reason ? ': ' + state.dsh.reason : '') + '; qualified donors=' + (state.dsh.donors?.length || 0), preDshReady(state.dsh)]]);
      return preDshReady(state.dsh) ? 0 : 1;
    }
    if (!/^0\.1\.0-alpha\.\d+$/.test(expected.version || '') || !/^[a-f0-9]{40}$/.test(expected.revision || '')) throw refusal('Post requires explicit release version and full revision');
    const s = fs.lstatSync(snapshot);
    if (s.mode & 0o077) throw refusal('Snapshot is not private');
    const before = json(snapshot);
    const age = Date.now() - Date.parse(before.capturedAt);
    if (before.format !== 1 || !Number.isFinite(age) || age < 0 || age > 6 * 3600000) throw refusal('Unsupported or stale snapshot');
    let dsh, dshKey;
    const result = await post(before, fresh => {
      const value = collect();
      if (fresh || dshKey !== value.backend.key || dsh?.status !== 'qualified') { dsh = dshState(value.backend.directory, target.app); dshKey = value.backend.key; }
      value.dsh = dsh; return value;
    }, expected, () => workers.run(options.bundle));
    print(result.rows); return result.ok ? 0 : 1;
  }
}
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(error => { console.error('FAIL: ' + (error.installStateReason || 'Metadata unavailable; verify input files and OS metadata access without changing permissions') + '. No settings or permissions were changed.'); process.exitCode = 1; });
module.exports = { runtimeClosure, preDsh, preDshReady, snapshotPath, bundleMetadata, read, projectViews, projectWindows, geometry, runtimeDigest, dshState, backendState, stable, compare, post, main };
