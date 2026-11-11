// PID liveness is not ownership: after a reboot that PID may name another app.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
// Lock timestamps use a fixed locale/timezone, independent of the launcher.
function lockIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return null;
  try {
    const started = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).trim();
    return started ? { pid, started } : null;
  } catch { return null; }
}
const held = new Map();
function parseLock(text) {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (Number.isSafeInteger(value) && value > 1) return { pid: value };
  if (value?.format !== 1 || !Number.isSafeInteger(value.pid) || value.pid < 2 ||
      !['service', 'startup'].includes(value.kind) || typeof value.directory !== 'string' || !path.isAbsolute(value.directory) ||
      !(value.started === null || typeof value.started === 'string' && value.started.trim()) || typeof value.token !== 'string' || !value.token) return null;
  return value;
}
function readLock(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.uid !== process.getuid()) return null;
  const text = fs.readFileSync(file, 'utf8'), record = parseLock(text);
  return record && { ...record, text, ino: stat.ino, dev: stat.dev };
}
function createLock(file, kind, directory) {
  const record = { format: 1, pid: process.pid, started: lockIdentity(process.pid)?.started || null,
    kind, directory: fs.realpathSync(directory), token: crypto.randomUUID() };
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(record)); } finally { fs.closeSync(fd); }
  const lock = readLock(file); held.set(file, lock); return lock;
}
function releaseLock(file, lock) {
  try {
    const current = readLock(file);
    if (!lock || !current || current.ino !== lock.ino || current.dev !== lock.dev || current.text !== lock.text) return false;
    fs.unlinkSync(file);
    if (held.get(file) === lock) held.delete(file);
    return true;
  } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
function commandLine(pid) {
  const read = field => execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', field + '='],
    { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  return { executable: read('comm'), command: read('command') };
}
function live(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; } // EPERM still permits a read-only identity check.
}
function sameDirectory(a, b) {
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return null; }
}
function legacyOwner(record, directory, kind, info) {
  if (!info?.command || !info.executable) return null;
  // NAW's daemon command ends with its single absolute store argument. An
  // unexpected command shape is unknown, not permission to replace a backend.
  const marker = 'daemon.cjs ', at = info.command.lastIndexOf(marker);
  if (at >= 0) {
    const target = info.command.slice(at + marker.length).trim();
    return path.isAbsolute(target) ? sameDirectory(target, directory) : null;
  }
  if (info.command.includes('daemon.cjs')) return null;
  if (kind === 'service') return false; // A GUI/root helper is not this store's daemon.
  // This process only writes versioned startup locks. An inherited numeric
  // self-PID lock predates this launch, unless this module has an active owner.
  if (record.pid === process.pid) return held.has(path.join(directory, 'services.lock'));
  // Old GUI/Node launchers did not expose their profile in argv. Do not guess
  // which store a live legacy launcher is bootstrapping.
  const name = path.basename(info.executable);
  if (/^(?:node(?:js)?|electron|Native Agent Workspace)(?:\s|$)/i.test(name)) return null;
  return false;
}
function ownerMayBeAlive(record, directory, kind, probes = {}) {
  if (!Number.isSafeInteger(record?.pid) || record.pid < 2) return false;
  const alive = probes.live || live, identity = probes.identity || lockIdentity, command = probes.command || commandLine;
  try {
    if (!alive(record.pid)) return false;
    if (record.format === 1 && (record.kind !== kind || sameDirectory(record.directory, directory) !== true)) return true;
    const before = identity(record.pid);
    if (record.started) return !before || before.started === record.started;
    const owner = legacyOwner(record, directory, kind, command(record.pid));
    if (owner !== false) return true;
    // Bind the command observation to one process lifetime, including EPERM.
    const after = identity(record.pid);
    if (!alive(record.pid)) return false;
    return !before || !after || before.started !== after.started;
  } catch { return true; }
}
module.exports = { lockIdentity, parseLock, readLock, createLock, releaseLock, ownerMayBeAlive };
