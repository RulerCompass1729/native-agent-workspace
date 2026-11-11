#!/usr/bin/env node
'use strict';
// Opt-in macOS integration test: synthetic hidden bundles + real isolated ended-session backends.
// Required: --old-release --release --old-version --new-version --scratch --slot --evidence
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const { digest } = require('./install-daily.cjs');
const { createPlatform } = require('./install-platform.cjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = (cmd, args, options = {}) => cp.execFileSync(cmd, args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'], ...options });
const options = {};
for (let i = 2; i < process.argv.length; i += 2) options[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
for (const key of ['old-release', 'release', 'old-version', 'new-version', 'scratch', 'slot', 'evidence']) assert.ok(options[key], 'Missing --' + key);
for (const key of ['old-release', 'release', 'scratch', 'slot', 'evidence']) assert.ok(path.isAbsolute(options[key]));
assert.ok(!options.scratch.startsWith('/Applications')); assert.ok(!options.scratch.includes('/Application Support/Native Agent Workspace'));
const version = options['new-version'], oldVersion = options['old-version'], release = options.release;
const commit = run('/usr/bin/git', ['-C', release, 'rev-parse', 'HEAD']).trim();
const token = crypto.randomUUID(), results = [];
const rollbackPath = c => path.join(c.resultDir, 'rollback.noindex/previous.app'); let lease = false, cleanupVerified = true;
const pin = file => ({ path: file, sha256: digest(file) });
const safeEnv = home => ({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: '/tmp', GIT_OPTIONAL_LOCKS: '0' });
function build(mode, binary) {
  const root = path.join(options.scratch, crypto.randomUUID().slice(0, 12)); fs.mkdirSync(root, { mode: 0o700 });
  const c = { format: 1, applyAllowed: true, testRoot: root, testFault: mode, app: path.join(root, 'Applications/Synthetic Installer.app'), candidate: path.join(root, 'candidate/Synthetic Installer.app'), data: path.join(root, 'data'), resultDir: path.join(root, 'result'), slot: path.join(root, 'installer-slot'), oldVersion, newVersion: version, release, commit, executableName: 'Installer Fixture', bundleId: 'test.naw.installer.' + crypto.randomUUID(), swift: pin(path.join(__dirname, 'install-apps.swift')), operatorSha256: digest(path.join(__dirname, 'install-daily.cjs')), code: { platform: pin(path.join(__dirname, 'fixtures/install-fault-platform.cjs')), inspector: pin(path.join(__dirname, 'install-runtime.cjs')), productionPlatform: pin(path.join(__dirname, 'install-platform.cjs')) } };
  c.executable = path.join(c.app, 'Contents/MacOS', c.executableName);
  if (mode === 'quit-refused') c.guiTimeoutMs = 1000;
  for (const dir of [c.data, path.join(root, 'home'), path.dirname(c.app), path.dirname(c.candidate)]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [destination, v, source] of [[c.app, oldVersion, options['old-release']], [c.candidate, version, release]]) {
    const runtime = path.join(root, v); fs.mkdirSync(runtime);
    fs.cpSync(path.join(source, 'app'), path.join(runtime, 'app'), { recursive: true }); fs.copyFileSync(path.join(source, 'package.json'), path.join(runtime, 'package.json'));
    for (const name of ['ws', '@xterm/headless', '@xterm/addon-serialize', '@xterm/xterm', '@deepseek-ai/dsh-sdk-protocol']) fs.cpSync(path.dirname(require.resolve(name + '/package.json', { paths: [source] })), path.join(runtime, 'node_modules', name), { recursive: true });
    const contents = path.join(destination, 'Contents'), resources = path.join(contents, 'Resources');
    fs.mkdirSync(path.join(resources, 'app'), { recursive: true }); fs.mkdirSync(path.join(contents, 'MacOS'));
    fs.copyFileSync(binary, path.join(contents, 'MacOS', c.executableName)); fs.chmodSync(path.join(contents, 'MacOS', c.executableName), 0o755);
    if (mode === 'bundled-backend') {
      const embedded = path.join(contents, 'MacOS/backend-node');
      fs.copyFileSync(process.execPath, embedded); fs.chmodSync(embedded, 0o755);
      // Homebrew's small launcher resolves libnode relative to itself. Keep the copied
      // executable inside the bundle; use its already-installed library directory.
      const libraries = path.resolve(path.dirname(fs.realpathSync(process.execPath)), '../lib');
      if (fs.existsSync(libraries) && fs.readdirSync(libraries).some(name => /^libnode[.].*[.]dylib$/.test(name))) {
        run('/usr/bin/install_name_tool', ['-add_rpath', libraries, embedded]);
        run('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', c.bundleId + '.backend', '--requirements', '=designated => identifier ' + JSON.stringify(c.bundleId + '.backend'), embedded]);
      }
      assert.equal(run(embedded, ['--version']).trim(), process.version);
    }
    fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${c.bundleId}</string><key>CFBundleExecutable</key><string>${c.executableName}</string><key>CFBundleName</key><string>Synthetic Installer</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/><key>CFBundleShortVersionString</key><string>${v}</string><key>NAWSourceRevision</key><string>${commit}</string></dict></plist>`);
    fs.writeFileSync(path.join(resources, 'app/package.json'), JSON.stringify({ version: v }));
    fs.copyFileSync(path.join(__dirname, 'fixtures/installer-bootstrap.cjs'), path.join(resources, 'bootstrap.cjs'));
    const log = path.join(root, v + '.log'); fs.writeFileSync(log, '');
    fs.writeFileSync(path.join(resources, 'fixture.json'), JSON.stringify({ node: mode === 'bundled-backend' ? '../MacOS/backend-node' : process.execPath, bootstrap: 'bootstrap.cjs', dataDir: c.data, home: path.join(root, 'home'), tmp: '/tmp', runtime, version: v, newVersion: version, mode: mode === 'new-crash' ? 'changed-draft' : mode, log }));
    // The nested backend was signed separately; do not replace its requirement with the GUI's.
    run('/usr/bin/codesign', ['--force', '--sign', '-', '--requirements', '=designated => identifier ' + JSON.stringify(c.bundleId), destination]);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', destination]);
  }
  const platform = createPlatform(c); c.oldSignature = platform.signature(c.app); c.newSignature = platform.signature(c.candidate);
  const cold = path.join(root, 'cold.json'); fs.writeFileSync(cold, JSON.stringify({ pass: true, commit, cdhash: c.newSignature.cdhash, fixtureOnly: true })); c.coldLaunch = pin(cold);
  for (const [app, name] of [[c.app, 'old.zip'], [c.candidate, 'new.zip']]) run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, path.join(root, name)]);
  c.previousArchive = pin(path.join(root, 'old.zip')); c.archive = pin(path.join(root, 'new.zip'));
  fs.writeFileSync(path.join(c.data, 'workspace.json'), JSON.stringify({ sessions: [{ id: 'retained', nativeId: 'synthetic-native', provider: 'claude', state: mode === 'bundled-backend' ? 'background' : 'ended', model: 'synthetic-model', name: 'Synthetic', roomId: 'shared', messages: [{ id: 'm1', role: 'user', text: 'Synthetic history', status: 'complete' }] }], room: { messages: [{ id: 'r1', role: 'system', text: 'Synthetic shared record', status: 'complete' }] }, drafts: { retained: 'DRAFT_BEFORE_UPGRADE' } }), { mode: 0o600 });
  fs.writeFileSync(path.join(c.data, 'backend-switch-settings.json'), JSON.stringify({ auto: false, migrate: false }), { mode: 0o600 });
  fs.writeFileSync(path.join(c.data, 'views.json'), JSON.stringify([{ owner: 'fixture-view', draft: 'UNSENT_SYNTHETIC_UI_DRAFT' }]), { mode: 0o600 });
  const stat = fs.statSync(c.executable, { bigint: true });
  fs.writeFileSync(path.join(c.data, 'installation.json'), JSON.stringify({ version: oldVersion, commit, installedAt: '2026-01-01T00:00:00.000Z', executable: { dev: stat.dev.toString(), ino: stat.ino.toString() } }) + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'approval.json'), JSON.stringify(c), { mode: 0o600 });
  return c;
}
async function readReceipt(c) {
  const module = { exports: {} };
  require('node:vm').runInNewContext(fs.readFileSync(path.join(release, 'app/preflight.cjs'), 'utf8'), { module, process: { execPath: c.executable, getuid: process.getuid }, require(name) {
    if (name === './platform.cjs' || name === './runtime-locations.cjs') return {};
    return require(name);
  } });
  return module.exports.appBuildInfo({ isPackaged: true, getVersion: () => JSON.parse(fs.readFileSync(path.join(c.app, 'Contents/Resources/app/package.json'))).version }, c.data);
}
async function state(c) {
  const { connectService } = require(path.join(release, 'app/service-connection.cjs'));
  const { readLayout } = require(path.join(release, 'app/service-layout.cjs'));
  const client = await connectService(path.join(c.data, readLayout(c.data).active), 'installer-fixture-observe');
  try { return await client.call('initial'); } finally { client.close(); }
}
async function cleanup(c) {
  const platform = createPlatform(c), rows = platform.bundleApps();
  for (const row of rows) { assert.equal(row.executable, c.executable); process.kill(row.pid, 'SIGTERM'); }
  for (let i = 0; i < 100 && platform.bundleApps().length; i++) await wait(50);
  assert.equal(platform.bundleApps().length, 0);
  const { readLayout } = require(path.join(release, 'app/service-layout.cjs')), { connectService } = require(path.join(release, 'app/service-connection.cjs'));
  const exited = [];
  for (const key of readLayout(c.data).entries) {
    const client = await connectService(path.join(c.data, key), 'installer-fixture-cleanup');
    try {
      const s = await client.call('initial'); assert.ok(s.sessions.every(x => x.state === 'ended' || c.testFault === 'bundled-backend' && x.id === 'retained' && x.state === 'background' && !x.pid)); assert.equal(s.diagnostics.shellModelCalls, 0);
      await client.call('shutdown'); let gone = false;
      for (let i = 0; i < 100; i++) { try { process.kill(s.servicePid, 0); } catch (e) { if (e.code !== 'ESRCH') throw e; gone = true; break; } await wait(50); }
      assert.ok(gone, 'Owned backend exited'); exited.push(s.servicePid);
    } finally { client.close(); }
  }
  const registered = () => JSON.parse(run('/usr/bin/swift', [c.swift.path, 'registered', c.bundleId, c.executable]));
  const unregistered = [];
  for (const app of registered()) {
    assert.ok([c.app, c.candidate, path.join(c.resultDir, 'previous.app'), rollbackPath(c)].includes(app), 'Foreign registration refused');
    const r = cp.spawnSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-u', app], { encoding: 'utf8', timeout: 30000 });
    assert.ok(!registered().includes(app), 'Fixture registration remains: ' + (r.stderr || r.error?.message || 'unknown'));
    unregistered.push(app);
  }
  assert.deepEqual(registered(), []);
  fs.writeFileSync(path.join(c.testRoot, 'cleanup.json'), JSON.stringify({ guiGone: true, backendPidsExited: exited, unregistered }), { mode: 0o600 });
}
(async () => {
  fs.mkdirSync(options.scratch, { recursive: true, mode: 0o700 }); fs.mkdirSync(options.evidence, { recursive: true, mode: 0o700 });
  const binary = path.join(options.scratch, 'fixture-app'); run('/usr/bin/swiftc', [path.join(__dirname, 'fixtures/installer-app.swift'), '-o', binary]);
  for (let i = 0; i < 120 && !lease; i++) { try { fs.mkdirSync(options.slot); lease = true; } catch (e) { if (e.code !== 'EEXIST') throw e; if (!i) console.log('Waiting for canonical GUI slot'); await wait(5000); } }
  assert.ok(lease, 'Canonical GUI slot occupied; nothing launched');
  fs.writeFileSync(path.join(options.slot, 'owner.json'), JSON.stringify({ token, pid: process.pid, owner: 'installer-real-faults' }), { mode: 0o600 });
  for (const mode of (options.modes || 'changed-draft,active-timeout,new-crash,pre-launch,old-reopen-fails,success,bundled-backend,quit-refused').split(',')) {
    const c = build(mode, binary); cleanupVerified = false; console.log('BEGIN ' + mode);
    try {
      run('/usr/bin/open', ['-g', '-j', '-a', c.app, ...(mode === 'profile-args' ? ['--args', '--synthetic-profile'] : [])]);
      for (let i = 0; i < 200 && !fs.existsSync(path.join(c.data, 'fixture-started.json')); i++) await wait(50);
      const initial = await state(c); assert.equal(initial.runtimeVersion, oldVersion);
      const oldPid = initial.servicePid;
      const before = fs.readFileSync(path.join(c.data, 'installation.json')), beforeReceiptStat = fs.statSync(path.join(c.data, 'installation.json'), { bigint: true });
      const approval = path.join(c.testRoot, 'approval.json');
      const child = cp.spawn(process.execPath, [path.join(__dirname, 'install-daily.cjs'), '--approval', approval, '--approval-sha256', digest(approval), '--result-dir', c.resultDir, '--apply'], { env: safeEnv(path.join(c.testRoot, 'home')), stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x);
      const timer = setTimeout(() => child.kill('SIGTERM'), 180000);
      const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); }); clearTimeout(timer);
      fs.writeFileSync(path.join(options.evidence, mode + '.log'), output);
      assert.equal(exit.signal, null, 'Operator deadline was not exceeded');
      const r = JSON.parse(fs.readFileSync(path.join(c.resultDir, 'result.json'))), after = await state(c);
      assert.equal(after.diagnostics.shellModelCalls, 0); assert.equal(after.diagnostics.dispatches, 0);
      const expected = mode === 'quit-refused' ? 'unchanged' : mode === 'bundled-backend' ? 'installed-cleanup-pending' : mode === 'success' ? 'installed' : mode === 'pre-launch' ? 'rolled-back' : mode === 'profile-args' ? 'unchanged' : 'recovery-required';
      if (mode === 'bundled-backend') {
        const location = fs.existsSync(rollbackPath(c)) ? rollbackPath(c) : path.join(c.resultDir, 'previous.app');
        fs.copyFileSync(path.join(c.resultDir, 'result.json'), path.join(options.evidence, mode + '.result.json'));
        const mapped = cp.spawnSync('/usr/sbin/lsof', ['-nP', '-F', 'pfn', '-p', String(oldPid)], { encoding: 'utf8', timeout: 10000 });
        fs.writeFileSync(path.join(options.evidence, mode + '.lsof.json'), JSON.stringify({ oldPid, location, status: mapped.status, stdout: mapped.stdout, stderr: mapped.stderr, error: mapped.error?.message }));
        if (fs.existsSync(path.join(c.testRoot, 'bundle-use.json'))) fs.copyFileSync(path.join(c.testRoot, 'bundle-use.json'), path.join(options.evidence, mode + '.bundle-use.json'));
        assert.ok(mapped.stdout.includes(location + '/Contents/MacOS/backend-node'), 'Old daemon must still map the displaced binary');
      }
      assert.equal(r.status, expected, output); assert.equal(exit.code, ['success', 'bundled-backend'].includes(mode) ? 0 : 1);
      const failure = r.errors.map(e => e.message).join('\n');
      if (mode === 'archive-fails') assert.match(failure, /ditto/);
      if (['pre-launch', 'old-reopen-fails'].includes(mode)) assert.match(failure, /codesign/);
      if (mode === 'changed-draft') assert.match(failure, /Drafts retained|Native draft retained/);
      if (mode === 'active-timeout') assert.match(failure, /New backend did not become active/);
      if (mode === 'new-crash') assert.match(failure, /did not finish launching/);
      if (['pre-launch', 'old-reopen-fails', 'profile-args', 'quit-refused'].includes(mode)) assert.deepEqual(fs.readFileSync(path.join(c.data, 'installation.json')), before);
      else { assert.equal(JSON.parse(fs.readFileSync(path.join(c.data, 'installation.json'))).version, version); assert.equal(r.observed.rollbackBundlePresent, ['archive-fails', 'bundled-backend'].includes(mode)); }
      if (mode === 'old-reopen-fails') { assert.equal(r.observed.gui.length, 0); assert.equal(r.receiptRestored, true); }
      if (mode === 'profile-args') assert.match(failure, /Unexpected profile\/debug arguments/);
      if (mode === 'quit-refused') {
        assert.match(failure, /did not quit/); assert.equal(r.exposure, false);
        const current = fs.statSync(path.join(c.data, 'installation.json'), { bigint: true });
        assert.equal(current.ino, beforeReceiptStat.ino); assert.equal(current.mtimeNs, beforeReceiptStat.mtimeNs);
        assert.deepEqual(r.observed.gui.map(row => row.pid), r.oldGuiPids);
      }
      if (mode === 'pre-launch') assert.equal(after.runtimeVersion, oldVersion);
      if (['changed-draft', 'new-crash'].includes(mode)) assert.equal(after.sessions[0].liveDraft, 'DRAFT_WRITTEN_BY_NEW_APP');
      let buildInfo = null;
      if (fs.existsSync(c.executable)) { buildInfo = await readReceipt(c); assert.equal(buildInfo.installedAt, JSON.parse(fs.readFileSync(path.join(c.data, 'installation.json'))).installedAt); }
      let mappedBackend;
      if (mode === 'bundled-backend') {
        const old = r.before.services.find(s => s.pid === oldPid), kept = r.after.services.find(s => s.key === old.key);
        assert.equal(kept.pid, oldPid); assert.equal(kept.version, oldVersion);
        const location = fs.existsSync(rollbackPath(c)) ? rollbackPath(c) : path.join(c.resultDir, 'previous.app');
        const usage = JSON.parse(fs.readFileSync(path.join(options.evidence, mode + '.lsof.json'))).stdout;
        assert.ok(usage.includes('p' + oldPid + '\n')); assert.ok(usage.includes(location + '/Contents/MacOS/backend-node'));
        // The raw PID-scoped receipt was saved before checking the installation status.
        mappedBackend = { pid: oldPid, version: kept.version, location };
      }
      const row = { mode, mappedBackend, buildInfo, result: path.join(c.resultDir, 'result.json'), status: r.status, backend: after.runtimeVersion, modelCalls: 0, dispatches: 0, exit };
      results.push(row); console.log(JSON.stringify(row));
      fs.copyFileSync(path.join(c.resultDir, 'result.json'), path.join(options.evidence, mode + '.result.json'));
    } finally { await cleanup(c); cleanupVerified = true; }
  }
})().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(() => {
  fs.writeFileSync(path.join(options.evidence, 'results.json'), JSON.stringify(results, null, 2));
  if (lease && cleanupVerified) { assert.equal(JSON.parse(fs.readFileSync(path.join(options.slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(options.slot, 'owner.json')); fs.rmdirSync(options.slot); }
});
