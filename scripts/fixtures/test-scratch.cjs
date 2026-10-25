// One owner for temporary test profiles, their processes and explicit evidence.
// Production code never imports this module. Never sweep another test's files.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const cp = require('node:child_process');
const { processIdentity, processMayBeAlive } = require('../../app/platform.cjs');
const roots = new Map(), processes = new Map(), services = new Map(), applications = new Map(), unverified = new Map();
let teardown, closing, inspectionError, released = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const canonical = value => fs.realpathSync(value);
const inside = (parent, value) => value === parent || value.startsWith(parent + path.sep);
function same(file, identity) {
  try { const s = fs.lstatSync(file); return s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid() && s.ino === identity.ino && s.dev === identity.dev; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
function directory(prefix) {
  const parent = canonical(path.dirname(prefix));
  if (![canonical(os.tmpdir()), canonical('/tmp')].includes(parent) || !path.basename(prefix).startsWith('naw-')) throw Error('Test scratch requires a naw- prefix directly under an OS temporary directory');
  const file = fs.mkdtempSync(prefix), real = canonical(file), stat = fs.lstatSync(real);
  fs.chmodSync(real, 0o700); roots.set(real, { ino: stat.ino, dev: stat.dev, aliases: [real, path.resolve(file)] });
  return file;
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
function uncertain(pid, child) {
  if (child ? child.exitCode === null && child.signalCode === null : pidAlive(pid)) unverified.set(pid, child || null);
}
function confirmedParent(record) {
  if (record.child && (record.child.exitCode !== null || record.child.signalCode !== null)) return false;
  const current = processIdentity(record.identity.pid);
  if (!current) { uncertain(record.identity.pid, record.child); return false; }
  return current.started === record.identity.started;
}
function own(child) {
  if (child?.pid && child.pid !== process.pid) {
    const identity = processIdentity(child.pid);
    if (identity) processes.set(child.pid, { identity, child }); else uncertain(child.pid, child);
  }
  return child;
}
const childProcess = { ...cp, fork: (...args) => own(cp.fork(...args)), spawn: (...args) => own(cp.spawn(...args)) };
function playwright(module) {
  return { ...module, _electron: { launch: async (...args) => {
    const app = await module._electron.launch(...args); const child = app.process(); applications.set(app, child); own(child); return app;
  } } };
}
function ownService(profile) {
  let real, info, stat, identity;
  try {
    real = canonical(profile);
    if (![...roots.keys()].some(root => inside(root, real))) return;
    info = JSON.parse(fs.readFileSync(path.join(real, 'connection.json'), 'utf8'));
    if (info.protocol !== 1 || path.basename(info.endpoint || '') !== 'desktop.sock' || !Number.isSafeInteger(info.pid) || info.pid < 2 || info.pid === process.pid) return;
    if (fs.readFileSync(path.join(real, 'service.lock'), 'utf8').trim() !== String(info.pid)) return;
    const folder = canonical(path.dirname(info.endpoint));
    if (path.dirname(folder) !== canonical('/tmp') || !/^naw-service-[A-Za-z0-9]{6}$/.test(path.basename(folder))) return;
    identity = processIdentity(info.pid); if (!identity) { uncertain(info.pid); return; }
    const command = cp.execFileSync('/bin/ps', ['-p', String(info.pid), '-o', 'command='], { encoding: 'utf8', timeout: 1000 });
    const aliases = [...new Set([real, path.resolve(profile), real.replace(/^\/private(?=\/(?:var|tmp)\/)/, '')])];
    if (!command.includes('daemon.cjs') || !aliases.some(p => command.includes(p))) return;
    stat = fs.lstatSync(folder); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) return;
    services.set(folder, { ino: stat.ino, dev: stat.dev, identity });
    processes.set(info.pid, { ...processes.get(info.pid), identity, serviceProfiles: aliases });
  } catch (e) { if (!['ENOENT', 'ESRCH'].includes(e.code) && !(identity && !pidAlive(identity.pid))) throw e; }
}
const ignored = new Set(['node_modules', 'runtimes', 'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'blob_storage', '.git']);
function collectServices() {
  const visit = (folder, depth) => {
    if (fs.existsSync(path.join(folder, 'connection.json'))) ownService(folder);
    if (!depth) return;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) if (entry.isDirectory() && !ignored.has(entry.name)) visit(path.join(folder, entry.name), depth - 1);
  };
  for (const [root, identity] of roots) if (same(root, identity)) visit(root, 5);
  // Capture descendants while verified owned parents are still alive.
  const rows = cp.execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000 }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  let more = true;
  while (more) { more = false; for (const [pid, parent] of rows) if (pid !== process.pid && processes.has(parent) && !processes.has(pid) && confirmedParent(processes.get(parent))) {
    const identity = processIdentity(pid); if (identity) { processes.set(pid, { identity }); more = true; } else uncertain(pid);
  } }

}
function exportEvidence() {
  if (!process.env.NAW_EVIDENCE_DIR) return;
  const target = path.resolve(process.env.NAW_EVIDENCE_DIR);
  let existing = target; while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const destination = path.join(canonical(existing), path.relative(existing, target)), repo = canonical(path.join(__dirname, '../..'));
  if (inside(repo, destination) || [...roots.keys()].some(root => inside(root, destination))) throw Error('Evidence must be outside the repository and owned temporary profiles');
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const allowed = /\.(jsonl?|log|txt|toml|md|png|csv|sqlite(?:-wal|-shm)?|db|py|cjs)$/i;
  for (const [root, identity] of roots) if (same(root, identity)) {
    const out = path.join(destination, 'raw', path.basename(root));
    const copy = (from, to) => {
      fs.mkdirSync(to, { recursive: true, mode: 0o700 });
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || ignored.has(entry.name)) continue;
        const source = path.join(from, entry.name), dest = path.join(to, entry.name);
        if (entry.isDirectory()) copy(source, dest);
        else if (entry.isFile() && allowed.test(entry.name)) fs.copyFileSync(source, dest);
      }
    };
    copy(root, out);
    // Exported fixture launchers must use the exported isolated provider home.
    for (const name of ['codex-local', 'claude-local']) {
      const source = path.join(root, name);
      if (fs.existsSync(source) && fs.lstatSync(source).isFile()) {
        const original = fs.readFileSync(source, 'utf8');
        fs.writeFileSync(path.join(out, name + '.original.txt'), original);
        fs.writeFileSync(path.join(out, name), identity.aliases.reduce((text, alias) => text.split(alias).join(out), original), { mode: 0o700 });
      }
    }
    fs.writeFileSync(path.join(out, 'test-scratch.json'), JSON.stringify({ original: root, exported: out, producer: path.basename(process.argv[1] || ''), uid: process.getuid() }, null, 2));
    console.log(JSON.stringify({ testEvidence: out, temporaryProfileRemoved: root }));
  }
}
function removeDirectories() {
  if (inspectionError) throw inspectionError;
  for (const [pid, child] of unverified) if (child ? child.exitCode === null && child.signalCode === null : pidAlive(pid)) throw Error('Live test process identity is unconfirmed; temporary profiles retained');
  for (const [file, identity] of [...roots, ...services]) if (fs.existsSync(file) && !same(file, identity)) throw Error('Owned temporary directory identity changed; retained without touching replacement');
  if ([...processes.values()].some(p => processMayBeAlive(p.identity))) throw Error('Owned test processes have not exited; temporary profiles retained');
  exportEvidence();
  for (const [file, identity] of services) if (same(file, identity)) fs.rmSync(file, { recursive: true, force: true });
  for (const [file, identity] of roots) if (same(file, identity)) fs.rmSync(file, { recursive: true, force: true });
  released = true;
}
function terminate(record, signal) {
  if (record.child && (record.child.exitCode !== null || record.child.signalCode !== null)) return;
  if (!processMayBeAlive(record.identity)) return;
  const current = processIdentity(record.identity.pid);
  if (!current || current.started !== record.identity.started) {
    // A verified child may finish between the liveness and identity reads.
    // A second negative check permits no signal; unknown live identity still fails.
    if (!processMayBeAlive(record.identity)) return;
    throw Error('Owned test process identity is unconfirmed');
  }
  if (record.serviceProfiles) {
    const command = cp.execFileSync('/bin/ps', ['-p', String(record.identity.pid), '-o', 'command='], { encoding: 'utf8', timeout: 1000 });
    if (!command.includes('daemon.cjs') || !record.serviceProfiles.some(p => command.includes(p))) throw Error('Owned service command identity changed');
  }
  try { process.kill(record.identity.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; } // The verified process can exit before the signal.
}
async function release() {
  if (closing) return closing;
  closing = (async () => {
    try { collectServices(); } catch (e) { inspectionError = e; } let failure;
    if (process.exitCode && process.env.NAW_EVIDENCE_DIR && roots.size) {
      const root = roots.keys().next().value;
      for (const [app, child] of applications) if (child.exitCode === null && !child.signalCode) {
        let timer; try { await Promise.race([(async () => {
          const page = app.windows().find(p => !p.isClosed()); if (!page) return;
          if (!fs.existsSync(path.join(root, 'failure.txt'))) fs.writeFileSync(path.join(root, 'failure.txt'), await page.locator('body').innerText());
          if (!fs.existsSync(path.join(root, 'failure.png'))) await page.screenshot({ path: path.join(root, 'failure.png') });
        })(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Failure snapshot timed out')), 5000); })]); } catch (e) { console.error('Test failure snapshot:', e.message); } finally { clearTimeout(timer); }
      }
    }
    if (teardown) {
      let timer;
      try { await Promise.race([Promise.resolve().then(teardown), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Test teardown timed out')), 20000); })]); }
      catch (e) { failure = e; }
      finally { clearTimeout(timer); }
    }
    for (const [app, child] of applications) if (child.exitCode === null && !child.signalCode) {
      let timer; try { await Promise.race([app.close(), new Promise(resolve => { timer = setTimeout(resolve, 5000); })]); } catch {} finally { clearTimeout(timer); }
    }
    for (const record of processes.values()) terminate(record, 'SIGTERM');
    for (let n = 0; n < 50 && [...processes.values()].some(p => processMayBeAlive(p.identity)); n++) await delay(100);
    if ([...processes.values()].some(p => processMayBeAlive(p.identity))) {
      // Only exact processes created/verified in this test can be escalated.
      for (const record of processes.values()) terminate(record, 'SIGKILL');
      for (let n = 0; n < 30 && [...processes.values()].some(p => processMayBeAlive(p.identity)); n++) await delay(100);
    }
    removeDirectories(); if (failure) throw failure;
  })();
  return closing;
}
function cleanup(fn) { teardown = fn; return release; }
function fail(error) {
  console.error(error?.stack || error); process.exitCode = 1;
  release().catch(e => console.error('Test scratch cleanup:', e.message)).finally(() => process.exit(1));
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  process.exitCode = signal === 'SIGINT' ? 130 : 143;
  release().catch(e => console.error('Test scratch cleanup:', e.message)).finally(() => { process.removeAllListeners(signal); process.kill(process.pid, signal); });
});
process.once('uncaughtException', fail);
process.once('exit', () => {
  if (released || !roots.size) return;
  try { collectServices(); removeDirectories(); }
  catch (e) { console.error('Test scratch cleanup:', e.message); process.exitCode = process.exitCode || 1; }
});
module.exports = { directory, cleanup, release, ownService, childProcess, playwright };
