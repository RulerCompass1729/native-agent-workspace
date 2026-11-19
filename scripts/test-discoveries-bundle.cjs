'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { spawn, execFileSync } = require('node:child_process'), { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const { verifyPackageFuses } = require('./package-fuses.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const signingOptions = { timeout: 20000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 };
const verifySignature = bundle => execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], signingOptions);
function reports() {
  const directory = path.join(os.homedir(), 'Library/Logs/DiagnosticReports');
  return fs.readdirSync(directory).filter(name => /^(Electron-|Native Agent Workspace-|NAW-|node-).*\.ips$/.test(name) && fs.lstatSync(path.join(directory, name)).isFile()).sort();
}
function within(root, file) { const real = fs.realpathSync(file); if (!real.startsWith(root + path.sep)) throw Error('Bundle resource escaped its root'); return real; }
function removeOwned(root, identity) {
  const now = fs.lstatSync(root);
  if (!now.isDirectory() || now.isSymbolicLink() || now.uid !== identity.uid || now.dev !== identity.dev || now.ino !== identity.ino) throw Error('Owned scratch identity changed');
  fs.rmSync(root, { recursive: true });
}
function seal(t) {
  const stat = fs.lstatSync(t.bundle); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Bundle identity changed');
  const hashes = ['Contents/Info.plist', 'Contents/_CodeSignature/CodeResources', 'Contents/MacOS/' + path.basename(t.executable)].map(name =>
    createHash('sha256').update(fs.readFileSync(within(t.bundle, path.join(t.bundle, name)))).digest('hex'));
  return { dev: stat.dev, ino: stat.ino, hashes };
}
function target(input) {
  const requested = path.resolve(input), forbidden = ['Containers', 'Group Containers'].map(name => path.join(os.homedir(), 'Library', name));
  if (forbidden.some(p => requested === p || requested.startsWith(p + path.sep))) throw Error('App containers are outside this check');
  const bundle = fs.realpathSync(requested);
  if (!bundle.endsWith('.app') || forbidden.some(p => bundle === p || bundle.startsWith(p + path.sep))) throw Error('Expected an explicit NAW application bundle');
  const info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', within(bundle, path.join(bundle, 'Contents/Info.plist'))], signingOptions));
  if (!/^io\.github\.rulercompass1729\.native-agent-workspace(?:\.[a-z0-9.-]+)?$/.test(info.CFBundleIdentifier) || !/^[a-f0-9]{40}$/.test(info.NAWSourceRevision) || typeof info.CFBundleExecutable !== 'string' || path.basename(info.CFBundleExecutable) !== info.CFBundleExecutable) throw Error('NAW bundle identity/revision is missing');
  const executable = within(bundle, path.join(bundle, 'Contents/MacOS', info.CFBundleExecutable));
  if (!fs.statSync(executable).isFile()) throw Error('Bundle executable is not a regular file');
  const app = within(bundle, path.join(bundle, 'Contents/Resources/app'));
  for (const file of ['regular-popup.cjs', 'regular-popup-transport.cjs', 'regular-popup-worker.mjs', 'regular-popup-dsh.cjs']) within(bundle, path.join(app, 'app', file));
  return { bundle, app, executable, revision: info.NAWSourceRevision, identifier: info.CFBundleIdentifier, version: info.CFBundleShortVersionString };
}
async function run(input) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('This check requires Apple Silicon macOS');
  const t = target(input); verifySignature(t.bundle); await verifyPackageFuses(t.bundle); const initialSeal = seal(t);
  const before = reports(), root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-discoveries-bundle-'))), identity = fs.lstatSync(root);
  let runWorker, RegularPopup, create, probeSource, wireSource;
  try {
    ({ runWorker } = require(path.join(t.app, 'app/regular-popup-transport.cjs')));
    ({ RegularPopup, create } = require(path.join(t.app, 'app/regular-popup.cjs')));
    probeSource = fs.readFileSync(path.join(__dirname, 'fixtures/regular-popup-worker.cjs'), 'utf8');
    const rawWire = fs.readFileSync(path.join(__dirname, 'fixtures/regular-popup-dsh.cjs'), 'utf8'), anchor = "import('../../app/regular-popup-worker.mjs');";
    assert.equal(rawWire.split(anchor).length, 2, 'Requalify the synthetic wire fixture');
    const wireStart = 'globalThis.fetch = async (url, init) => {'; assert.equal(rawWire.split(wireStart).length, 2);
    wireSource = 'let gateWireCalls=0;const gateExit=process.exit.bind(process);process.exit=(code=0)=>gateExit(code===0&&gateWireCalls!==1?1:code);\n' + rawWire.replace(wireStart, wireStart + '\nif(++gateWireCalls!==1)throw Error("Synthetic wire called more than once");').replace(anchor, `import(${JSON.stringify(pathToFileURL(path.join(t.app, 'app/regular-popup-worker.mjs')).href)});`);
  } catch (error) { removeOwned(root, identity); throw error; }
  const cases = [], children = new Set(); let failure;
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  try {
    const off = create({ store: { read: () => null, write() { assert.fail('Default factory wrote settings'); } } });
    assert.equal(off.status().config.enabled, false); off.dispose();
    for (const mode of ['permissions', 'dsh-success', 'missing-key', 'missing-entry', 'dispatch-denied']) {
      const directory = path.join(root, mode); fs.mkdirSync(directory, { mode: 0o700 }); fs.writeFileSync(path.join(directory, 'must-not-read'), 'synthetic outside marker');
      const trace = { mode, spawns: 0, authorizations: 0, fakeCredentialReads: 0, fakeSourceReads: 0, proxyConnections: 0, durableGrant: false, closes: 0, exits: [] };
      let entry, child, waitForExit, server, engine;
      const deps = {
        execPath: t.executable, get entry() { return entry; }, readKey: async () => { trace.fakeCredentialReads++; return mode === 'missing-key' ? '' : 'fixture-only-not-a-key'; },
        egress: { startEgress: async () => {
          const homes = fs.readdirSync(directory).filter(name => name.startsWith('discovery-worker-') && fs.lstatSync(path.join(directory, name)).isDirectory());
          assert.equal(homes.length, 1); const home = path.join(directory, homes[0]);
          if (mode !== 'missing-key') { entry = path.join(home, 'gate-entry.cjs'); if (mode !== 'missing-entry') fs.writeFileSync(entry, mode === 'permissions' ? probeSource : wireSource, { mode: 0o600 }); }
          server = net.createServer(socket => { trace.proxyConnections++; socket.destroy(); });
          await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
          return { port: server.address().port, get violated() { return trace.proxyConnections > 0; }, close: () => new Promise(resolve => { trace.closes++; server.close(resolve); }) };
        } },
        spawn(command, args, options) {
          assert.equal(command, '/usr/bin/sandbox-exec'); assert.equal(args[2], t.executable); assert.ok(!JSON.stringify(args).includes('fixture-only-not-a-key'));
          trace.spawns++; child = spawn(command, args, options); children.add(child); trace.pid = child.pid;
          waitForExit = new Promise(resolve => child.once('close', (code, signal) => { trace.exits.push({ code, signal }); children.delete(child); resolve(); })); return child;
        },
      };
      const authorize = callback => () => {
        trace.authorizations++; if (mode === 'dispatch-denied') throw Error('Synthetic dispatch refusal');
        const grant = callback();
        if (mode !== 'permissions') {
          const saved = JSON.parse(fs.readFileSync(path.join(directory, 'regular-popup.json'), 'utf8')).runs[0];
          assert.equal(saved.chargedMicros, 7000); assert.equal(saved.budgetDay, grant.budgetDay); trace.durableGrant = true;
        }
        return grant;
      };
      try {
        if (mode === 'permissions') {
          const result = await runWorker({ concern: 'synthetic public tools', candidates: [] }, { directory, signal: new AbortController().signal, authorize: authorize(() => ({ budgetDay: today() })) }, deps);
          assert.deepEqual(result.probe, { readDenied: true, writeDenied: true, execDenied: true, credentialPresent: true, keyInArgv: false });
          assert.equal(fs.readFileSync(path.join(directory, 'must-not-read'), 'utf8'), 'synthetic outside marker');
        } else {
          engine = new RegularPopup({ directory, permitted: true,
            readSource: async () => { trace.fakeSourceReads++; return [{ id: 'fixture', title: 'Synthetic public tool', description: 'Public synthetic candidate', url: 'https://github.com/example/tool' }]; },
            select: (input, options) => runWorker(input, { directory, signal: options.signal, authorize: authorize(options.authorize) }, deps), notify: () => {} });
          engine.configure({ enabled: true, concern: 'synthetic public tools', time: '00:00' }); await engine.tick();
          const firstAt = engine.status().runs[0].at; engine.now = () => firstAt; await engine.tick();
          const status = engine.status(); assert.equal(status.runs.length, 1);
          if (mode === 'dsh-success') { assert.equal(status.runs[0].state, 'ready'); assert.equal(status.runs[0].chargedMicros, 421); assert.equal(status.runs[0].usage.totalTokens, 1200); assert.equal(status.runs[0].items[0].id, 'fixture'); assert.equal(trace.durableGrant, true); }
          else { assert.equal(status.runs[0].state, 'unconfirmed'); assert.equal(status.runs[0].chargedMicros, 7000); assert.equal(status.runs[0].attempted, true); }
        }
        if (waitForExit) await waitForExit;
        assert.equal(trace.spawns, 1); assert.equal(trace.proxyConnections, 0); assert.equal(trace.closes, 1); assert.equal(trace.fakeCredentialReads, 1); assert.equal(trace.fakeSourceReads, mode === 'permissions' ? 0 : 1);
        assert.equal(trace.authorizations, ['permissions', 'dsh-success', 'dispatch-denied'].includes(mode) ? 1 : 0);
        assert.deepEqual(trace.exits, [{ code: ['permissions', 'dsh-success'].includes(mode) ? 0 : 1, signal: null }]);
        assert.ok(!fs.readdirSync(directory).some(name => name.startsWith('discovery-worker-'))); cases.push(trace);
        console.log('PASS ' + JSON.stringify(trace));
      } finally { engine?.dispose(); if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); if (waitForExit) await waitForExit; } if (server?.listening) await new Promise(resolve => server.close(resolve)); }
    }
  } catch (error) { failure = error; }
  finally {
    for (const child of children) child.kill('SIGKILL');
    await pause(20000);
    try {
      verifySignature(t.bundle); assert.deepEqual(seal(t), initialSeal, 'The bundle changed during its check'); const after = reports(), added = after.filter(name => !before.includes(name));
      console.log(JSON.stringify({ revision: t.revision, version: t.version, identifier: t.identifier, cases: cases.length, bundleUnchanged: true, before, after, added, realSourceCalls: 0, realCredentialReads: 0, realModelCalls: 0, osNotifications: 0 }));
      if (added.length) failure ||= Error('New crash reports were generated');
    } catch (error) { failure ||= error; }
    try { removeOwned(root, identity); } catch (error) { failure ||= error; }
  }
  if (failure) throw failure;
  assert.equal(cases.length, 5); return { revision: t.revision, cases: cases.length };
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') console.log('Usage: node scripts/test-discoveries-bundle.cjs /absolute/path/to/trusted-NAW.app\nRead-only bundle check; private synthetic fixtures only.');
  else if (args.length !== 1 || !path.isAbsolute(args[0])) { console.error('Expected one absolute NAW bundle path'); process.exitCode = 1; }
  else run(args[0]).then(value => console.log('PASS ' + JSON.stringify(value)), error => { console.error('BLOCKED ' + error.message); process.exitCode = 1; });
}
module.exports = { run, target };
