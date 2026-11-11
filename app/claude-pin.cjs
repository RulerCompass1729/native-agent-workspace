// Temporary fallback for a Claude Code version NAW has not qualified (B3, b3-spec.md
// section 2). The vendor's updater repoints the launcher into .../versions/<version>.
// When that version is not qualified, a session NAW starts uses the newest qualified
// version still installed beside it, for at most seven days per fallback version, and
// the session says so. Nothing running is touched, and no session is ever reopened by
// an older version than the one that last ran it.
//
// The fallback ends by itself: once a NAW update qualifies the new version, or the
// vendor removes the old one, or the seven days pass, the next session NAW starts uses
// the launcher again. While it lasts, those sessions do not get the vendor's newer
// features or fixes.
const fs = require('node:fs'), path = require('node:path');

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
function readState(file) { try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return exact(s?.pinned) && Number.isFinite(s?.since) ? s : null; } catch { return null; } }
function writeState(file, state) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(temp, file);
}

// Which program starts this session. fresh: a new native session (not a resume or a fork of
// an existing one). lastVersion: the version NAW last started this session with, if known.
// Returns { binary, version, pin }: version is null when the layout is not the vendor's;
// pin is null, or { requested, pinned, since, until } while the fallback applies, or the same
// with expired: true once its time limit has passed (the launcher is used again).
function choose({ launcher, fresh, lastVersion, stateFile, now = Date.now() }) {
  const current = installed(launcher);
  if (!current) return { binary: launcher, version: null, pin: null };
  const direct = pin => ({ binary: launcher, version: current.version, pin });
  if (QUALIFIED.includes(current.version)) return direct(null);
  const older = newestQualified(current.dir);
  // Only ever fall back to an older qualified version, never sideways or forward.
  if (!older || compare(older.version, current.version) >= 0) return direct(null);
  // Never reopen a session with an older version than the one that last ran it; unknown counts as newer.
  if (!fresh && !(exact(lastVersion) && compare(lastVersion, older.version) <= 0)) return direct(null);
  let state = readState(stateFile);
  if (state?.pinned !== older.version) { state = { pinned: older.version, since: now }; try { writeState(stateFile, state); } catch { return direct(null); } }
  const pin = { requested: current.version, pinned: older.version, since: new Date(state.since).toISOString(), until: new Date(state.since + LIMIT_MS).toISOString() };
  if (now - state.since >= LIMIT_MS) return direct({ ...pin, expired: true });
  return { binary: older.file, version: older.version, pin };
}

module.exports = { QUALIFIED, LIMIT_MS, choose, installed, newestQualified };
