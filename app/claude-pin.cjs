// Temporary fallback for a Claude Code version NAW has not qualified (B3, b3-spec.md
// section 2). The vendor's updater repoints the launcher into .../versions/<version>.
// When that version is not qualified, a session NAW starts uses the newest qualified
// version still installed beside it, for at most seven days per fallback version, and
// the session says so. Nothing running is touched. A session is resumed with the
// fallback only when both NAW's own record and the session's transcript show that no
// newer version has run it; anything unknown keeps the launcher.
//
// The fallback ends by itself: once a NAW update qualifies the new version, or the
// vendor removes the fallback version, or the seven days pass, the next session NAW
// starts uses the launcher again; it never moves on to a still older version. While it
// lasts, those sessions do not get the vendor's newer features or fixes. The clock is
// kept in the persistent data directory, so restarting NAW does not restart it.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

// Versions the managed mod is qualified for: root binding and native blocks, the base
// of every other capability. Equal to the managed nativeBlocks list in
// claude-bridge/hooks/register.js; a test compares the two.
const QUALIFIED = Object.freeze(['2.1.307', '2.1.308', '2.1.309', '2.1.310', '2.1.311', '2.1.312', '2.1.316', '2.1.317', '2.1.318', '2.1.319', '2.1.321', '2.1.322']);
const LIMIT_MS = 7 * 24 * 60 * 60 * 1000;
const exact = v => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v);
const compare = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

// The version a launcher currently points at, only for the vendor layout and only when
// the launcher is a link. A program the person selected as an exact file is their choice.
function installed(launcher) {
  try {
    if (!fs.lstatSync(launcher).isSymbolicLink()) return null;
    const real = fs.realpathSync(launcher), dir = path.dirname(real), version = path.basename(real);
    return exact(version) && path.basename(dir) === 'versions' ? { dir, version } : null;
  } catch { return null; }
}
// The newest qualified version still installed: a regular executable file owned by this user.
function newestQualified(dir) {
  for (const version of [...QUALIFIED].sort(compare).reverse()) {
    const file = path.join(dir, version);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.uid !== process.getuid()) continue;
      fs.accessSync(file, fs.constants.X_OK);
      return { file, version };
    } catch { /* not installed */ }
  }
  return null;
}
// undefined: no fallback has been recorded yet. null: a record exists but cannot be trusted
// (unreadable, malformed, or started in the future), so its age is unknown.
function readState(file, now) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { return error.code === 'ENOENT' ? undefined : null; }
  try { const s = JSON.parse(text); return exact(s?.pinned) && Number.isFinite(s?.since) && s.since <= now ? s : null; } catch { return null; }
}
function writeState(file, state) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(temp, file);
}

// Which program starts this session. fresh: a new native session (not a resume or a fork of
// an existing one). lastVersion: the version NAW last started this session with, if known.
// Returns { binary, version, pin }: version is null when the layout is not the vendor's;
// pin is null, or { requested, pinned, since, until } while the fallback applies, or the same
// with expired: true once its time limit has passed (the launcher is used again).
function choose({ launcher, fresh, lastVersion, lastWritten, stateFile, now = Date.now() }) {
  const current = installed(launcher);
  if (!current) return { binary: launcher, version: null, pin: null };
  const direct = pin => ({ binary: launcher, version: current.version, pin });
  if (QUALIFIED.includes(current.version)) return direct(null);
  const older = newestQualified(current.dir);
  // Only ever fall back to an older qualified version, never sideways or forward.
  if (!older || compare(older.version, current.version) >= 0) return direct(null);
  // Never reopen a session with an older version than the one that last ran it; unknown counts as newer.
  // lastWritten: undefined when the session has no transcript yet, null when it has one of unknown version.
  if (!fresh && !(exact(lastVersion) && compare(lastVersion, older.version) <= 0)) return direct(null);
  if (!fresh && lastWritten !== undefined && !(exact(lastWritten) && compare(lastWritten, older.version) <= 0)) return direct(null);
  let state = readState(stateFile, now);
  // A record that cannot be trusted could hide an expired period: no fallback.
  if (state === null) { console.error('[NAW] Claude fallback record is unreadable; the launcher is used'); return direct(null); }
  // The recorded fallback version is gone (the vendor removed it): back to the launcher, never further down.
  if (state && compare(older.version, state.pinned) < 0) return direct(null);
  // First fallback, or a newer version has been qualified since: its own period starts.
  if (!state || compare(older.version, state.pinned) > 0) {
    state = { pinned: older.version, since: now };
    try { writeState(stateFile, state); } catch (error) { console.error(`[NAW] Claude fallback could not be recorded; the launcher is used: ${String(error?.message).slice(0, 160)}`); return direct(null); }
  }
  const pin = { requested: current.version, pinned: older.version, since: new Date(state.since).toISOString(), until: new Date(state.since + LIMIT_MS).toISOString() };
  if (now - state.since >= LIMIT_MS) return direct({ ...pin, expired: true });
  return { binary: older.file, version: older.version, pin };
}

// The newest Claude version recorded in the end of a session's own transcript: only the version
// field of each entry is used. undefined: no transcript; null: one exists but names no version.
// Claude keeps it at <config>/projects/<cwd, every other character as "-">/<native id>.jsonl.
const TAIL_BYTES = 1024 * 1024;
function lastWrittenVersion({ cwd, nativeId, root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects') }) {
  if (typeof cwd !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nativeId || '')) return null;
  const file = path.join(root, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${nativeId}.jsonl`);
  let text;
  try {
    const fd = fs.openSync(file, 'r');
    try { const size = fs.fstatSync(fd).size, length = Math.min(size, TAIL_BYTES), buffer = Buffer.alloc(length); fs.readSync(fd, buffer, 0, length, size - length); text = buffer.toString('utf8'); }
    finally { fs.closeSync(fd); }
  } catch (error) { return error.code === 'ENOENT' ? undefined : null; }
  let newest = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"version"')) continue;
    let entry; try { entry = JSON.parse(line); } catch { continue; } // the first line of the tail may be cut
    if (exact(entry?.version) && (!newest || compare(entry.version, newest) > 0)) newest = entry.version;
  }
  return newest;
}

module.exports = { QUALIFIED, LIMIT_MS, choose, installed, newestQualified, lastWrittenVersion };
