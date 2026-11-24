// Automatic qualification changes only future launches. No real credentials, model, or external network.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { fork } = require('node:child_process');
const mod = require('./claude-mod-check.cjs');
const { processIdentityUTC: processIdentity, processGroup } = require('./platform.cjs');
const REFERENCE = '2.1.327';
const WORK_TIMEOUT_MS = 300000, CLEANUP_GRACE_MS = 20000;
const JOURNEYS = Object.freeze(['solo-queue', 'shared-queue', 'shared-model']);
const exact = value => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);
function identity(binary) {
  try {
    const file = fs.realpathSync(binary), s = fs.statSync(file);
    return s.isFile() ? { file, dev: s.dev, ino: s.ino, size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs } : null;
  } catch { return null; }
}
function basis() {
  const hash = crypto.createHash('sha256').update(mod.modHash());
  for (const name of ['claude-qualification.cjs', 'claude-native-journeys.cjs', 'claude-loopback.cjs', 'adapters.cjs', 'workspace.cjs', 'claude-mod-check.cjs', 'claude-pin.cjs', 'claude-compat-plugin.cjs', 'record-history.cjs', 'claude_hook.py', 'claude-submit.cjs', 'shared-replies.cjs', 'platform.cjs', 'pty_host.py']) hash.update(fs.readFileSync(path.join(__dirname, name)));
  return hash.digest('hex');
}
function load(file) {
  try { const data = JSON.parse(fs.readFileSync(file, 'utf8')); return data.format === 1 && data.checks && !Array.isArray(data.checks) ? data.checks : {}; } catch { return {}; }
}
function current(record, binary, fingerprint = basis()) {
  const id = identity(binary);
  return Boolean(id && record?.basis === fingerprint && record.reference === REFERENCE && JSON.stringify(record.binary) === JSON.stringify(id));
}
function passed(record) {
  return record?.status === 'passed' && mod.passed(record.mod) && JOURNEYS.every(name => record.journeys?.[name] === true);
}
function decision({ file, binary, version }) {
  const record = load(file)[version];
  return record?.version === version && current(record, binary) ? record : null;
}
function save(file, record) {
  const checks = { ...load(file), [record.version]: record };
  const retained = Object.fromEntries(Object.entries(checks).sort((a, b) => String(b[1]?.at).localeCompare(String(a[1]?.at))).slice(0, 20));
  const temp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify({ format: 1, checks: retained }), { mode: 0o600 }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
// Other backends of this data root: <root>/backends/<20-hex key>/claude-qualification.json.
function siblingFiles(file) {
  const own = path.dirname(path.resolve(file)), parent = path.dirname(own);
  if (!/^[a-f0-9]{20}$/.test(path.basename(own)) || path.basename(parent) !== 'backends') return [];
  let names = [];
  try { names = fs.readdirSync(parent); } catch { return []; }
  const files = [];
  for (const name of names.filter(n => /^[a-f0-9]{20}$/.test(n) && n !== path.basename(own)).sort().slice(0, 32)) {
    const candidate = path.join(parent, name, 'claude-qualification.json');
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isFile() && stat.uid === process.getuid() && stat.size <= 1 << 20) files.push(candidate);
    } catch { /* No record there. */ }
  }
  return files;
}
function approvedVersions(file, dir) {
  const fingerprint = basis(), own = load(file);
  const valid = ([version, record]) => exact(version) && record?.version === version && passed(record) && current(record, path.join(dir, version), fingerprint);
  const versions = new Set(Object.entries(own).filter(valid).map(([version]) => version));
  // A restarted backend re-checks while its sessions resume (2026-11-23 18:11Z). A sibling's pass of the
  // same code basis and binary identity is the same result; this backend's own current failure still wins.
  for (const sibling of siblingFiles(file)) {
    for (const entry of Object.entries(load(sibling)).filter(valid)) {
      const mine = own[entry[0]];
      if (!(mine?.version === entry[0] && mine.status === 'failed' && current(mine, path.join(dir, entry[0]), fingerprint))) versions.add(entry[0]);
    }
  }
  return [...versions];
}
function launch({ launcher, file }) {
  const current = require('./claude-pin.cjs').installed(launcher);
  if (!current || require('./claude-pin.cjs').QUALIFIED.includes(current.version)) return { approvedVersions: [], check: null, qualifiedVersion: '' };
  const binary = path.join(current.dir, current.version), record = decision({ file, binary, version: current.version });
  const versions = approvedVersions(file, current.dir);
  return { approvedVersions: versions, qualifiedVersion: versions.includes(current.version) ? current.version : '',
    check: record ? { status: record.status, reason: record.reason || record.status } : { status: 'checking', reason: 'checking' } };
}

// The parent retains this exact short-path root so a forced worker exit cannot
// bypass its finally cleanup. Never remove a replaced directory or symlink.
function nativeRoot(owner) {
  const root = owner?.root;
  if (typeof root !== 'string' || path.dirname(root) !== fs.realpathSync('/tmp') || !/^ncq-[A-Za-z0-9]{6}$/.test(path.basename(root))) throw Error('Invalid native check directory');
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.uid !== owner.uid || stat.dev !== owner.dev || stat.ino !== owner.ino) throw Error('Native check directory identity changed');
  return root;
}
function removeNativeRoot(owner) {
  try { fs.rmSync(nativeRoot(owner), { recursive: true, force: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function ownedWorkerGroup(child) {
  const identity = processIdentity(child.pid);
  return identity && identity.pid !== process.pid && processGroup(identity.pid) === identity.pid ? identity : null;
}
function forceWorker(child, owned) {
  // A spawn failure has no OS PID. This also leaves the existing process-free
  // clock fixtures usable; it never turns a missing PID into a group signal.
  if (!child.pid) return child.kill('SIGKILL');
  if (!owned || typeof owned.started !== 'string' || !owned.started || owned.pid !== child.pid || child.exitCode !== null || child.signalCode !== null) return false;
  const current = processIdentity(owned.pid);
  if (current?.started !== owned.started || processGroup(owned.pid) !== owned.pid || owned.pid === process.pid) return false;
  // Do not signal a released/reused leader. Kill only the worker: its PTY
  // supervisors must remain able to finish their own groups after stdin EOF.
  if (child.exitCode !== null || child.signalCode !== null) return false;
  try { process.kill(owned.pid, 'SIGKILL'); return true; }
  catch (error) { if (error.code !== 'ESRCH') throw error; return false; }
}
function stopVersionProcess(owned) {
  if (!owned || !Number.isSafeInteger(owned.pid) || owned.pid < 2 || owned.pid === process.pid || typeof owned.started !== 'string' || !owned.started || processIdentity(owned.pid)?.started !== owned.started) return false;
  try { process.kill(owned.pid, 'SIGKILL'); return true; }
  catch (error) { if (error.code !== 'ESRCH') throw error; return false; }
}
async function versionProcessExited(owned, killed = false) {
  while (owned) {
    try { process.kill(owned.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; if (error.code !== 'EPERM') throw error; }
    const current = processIdentity(owned.pid);
    if (current && current.started !== owned.started) return;
    // A failed identity query is unknown, not exit. Retry observation; signal
    // only once a fresh identity matches, and never a reused or unknown PID.
    if (!killed && current) killed = stopVersionProcess(owned);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
async function workerGroupExited(owned) {
  if (!owned) return;
  for (;;) {
    try { process.kill(-owned.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; if (error.code !== 'EPERM') throw error; }
    // After close the leader is reaped: only observe, never signal its old
    // group number. Keep both the root and caller pending until exit is proven.
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

// The worker owns its native sessions and handles cancellation before it exits. The IPC channel also
// closes when its daemon goes away, so a parent crash cannot leave an unattended qualification.
function nativeJourneys({ binary, version, privateDir, signal, timeoutMs = WORK_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Error('cancelled'));
    const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin', LANG: 'en_US.UTF-8', ELECTRON_RUN_AS_NODE: '1' };
    const root = fs.realpathSync(fs.mkdtempSync('/tmp/ncq-')), stat = fs.lstatSync(root);
    const owner = { root, uid: stat.uid, dev: stat.dev, ino: stat.ino };
    let child;
    try { child = fork(path.join(__dirname, 'claude-native-journeys.cjs'), [binary, version, JSON.stringify(owner)], { env, silent: true, detached: true }); }
    catch (error) { removeNativeRoot(owner); return reject(error); }
    const owned = ownedWorkerGroup(child);
    let result, stopped = false, force, failure, versionProcess, versionExitConfirmed = false, versionKilled = false;
    const cancel = () => {
      if (stopped) return; stopped = true;
      if (child.connected) child.send({ cancel: true });
      force = setTimeout(() => {
        try { if (!versionExitConfirmed) versionKilled = stopVersionProcess(versionProcess); forceWorker(child, owned); } catch (error) { failure = error; }
      }, CLEANUP_GRACE_MS);
    };
    const timer = setTimeout(cancel, timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    child.on('message', message => {
      if (message?.type === 'qualification-ready') {
        // No version executable can start until this detached group has been
        // identified. A failed ownership observation refuses the launch.
        if (owned && !stopped) child.send({ type: 'qualification-start' });
        else cancel();
      }
      if (message?.type === 'version-ready') {
        const identity = message.identity;
        // The version process is still in its pre-exec gate. Register its
        // exact identity before allowing provider code to run or change groups.
        if (owned && !stopped && Number.isSafeInteger(identity?.pid) && identity.pid > 1 && identity.pid !== child.pid && typeof identity.started === 'string' && identity.started &&
            processIdentity(identity.pid)?.started === identity.started && processGroup(identity.pid) === owned.pid) {
          versionProcess = { pid: identity.pid, started: identity.started };
          child.send({ type: 'version-start' });
        } else cancel();
      }
      if (message?.type === 'version-exited' && versionProcess && message.identity?.pid === versionProcess.pid && message.identity.started === versionProcess.started) versionExitConfirmed = true;
      if (message?.type === 'result') result = message.result;
    });
    child.stdout.resume(); child.stderr.resume();
    const finish = () => { clearTimeout(timer); clearTimeout(force); signal?.removeEventListener('abort', cancel); };
    child.once('error', error => { failure = error; if (child.pid) cancel(); });
    child.once('close', async code => {
      finish();
      try {
        // A worker crash cannot turn its registered version process into an
        // unowned orphan, even if that process has changed its own group.
        if (!versionExitConfirmed) await versionProcessExited(versionProcess, versionKilled);
        await workerGroupExited(owned);
        removeNativeRoot(owner);
      } catch (error) { return reject(error); }
      if (failure) reject(failure);
      else if (stopped || signal?.aborted) reject(Error('cancelled'));
      else if (code !== 0 || !result) resolve({ passed: false, reason: result?.passed === false ? result.reason : 'native-startup', journeys: result?.journeys || {} });
      else resolve(result);
    });
  });
}
async function checkOnce({ file, binary, version, privateDir, signal, runMod = mod.run, runJourneys = nativeJourneys }) {
  if (!exact(version)) return null;
  const existing = decision({ file, binary, version });
  if (existing && ['passed', 'failed'].includes(existing.status)) return existing;
  const record = { version, reference: REFERENCE, binary: identity(binary), basis: basis(), at: new Date().toISOString(), status: 'checking', journeys: {} };
  if (!record.binary) return null;
  save(file, record);
  const work = new AbortController(), deadline = performance.now() + WORK_TIMEOUT_MS;
  let timedOut = false;
  const expire = () => { timedOut = true; work.abort(); };
  const cancel = () => work.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(expire, WORK_TIMEOUT_MS);
  const remaining = () => {
    const ms = Math.max(0, Math.ceil(deadline - performance.now()));
    if (!ms) expire();
    if (work.signal.aborted) throw Error('cancelled');
    return ms;
  };
  try {
    record.mod = await runMod({ binary, version, privateDir, signal: work.signal, timeoutMs: Math.min(60000, remaining()) });
    remaining();
    if (!mod.passed(record.mod)) { record.status = 'failed'; record.reason = 'mod-tests'; }
    else {
      const result = await runJourneys({ binary, version, privateDir, signal: work.signal, timeoutMs: remaining() });
      remaining();
      record.journeys = Object.fromEntries(JOURNEYS.map(name => [name, result.journeys?.[name] === true]));
      record.status = result.passed && JOURNEYS.every(name => record.journeys[name]) ? 'passed' : 'failed';
      if (record.status === 'failed') record.reason = JOURNEYS.includes(result.reason) ? result.reason : 'native-startup';
    }
  } catch { record.status = 'failed'; record.reason = timedOut ? 'timed-out' : signal?.aborted ? 'cancelled' : 'native-startup'; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  if (signal?.aborted) return null;
  if (!current(record, binary)) { record.status = 'failed'; record.reason = 'binary-changed'; }
  save(file, record); return record;
}
module.exports = { REFERENCE, JOURNEYS, WORK_TIMEOUT_MS, CLEANUP_GRACE_MS, identity, basis, load, current, passed, decision, save, approvedVersions, launch, nativeRoot, removeNativeRoot, nativeJourneys, checkOnce };
