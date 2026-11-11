const { uiError } = require('./ui-errors.cjs');
const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const keys = ['claude', 'codex', 'python3'];
function readLocations(file = process.env.NAW_RUNTIME_CONFIG) {
  if (!file) return {};
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid())) throw Error('unsafe');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.entries(data).some(([key, value]) => !keys.includes(key) || typeof value !== 'string' || !path.isAbsolute(value))) throw Error('invalid');
    return data;
  } catch (error) { if (error.code === 'ENOENT') return {}; throw uiError("error.runtime.locationsUnreadable"); }
}
function isExecutable(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || /[\x00-\x1f]/.test(file)) return false;
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
}
function save(file, data) {
  const temp = file + '.' + randomUUID() + '.tmp';
  try { fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
  finally { try { fs.unlinkSync(temp); } catch {} }
}
function setLocation(file, key, value) {
  if (!keys.includes(key) || (value !== null && !isExecutable(value))) throw uiError("error.runtime.executableRequired");
  const data = readLocations(file);
  if (value === null) delete data[key]; else data[key] = value;
  save(file, data);
}
// The locations a backend started in dataDir uses. A backend may keep its own file, which overrides the
// shared Settings file while it has an entry. Settings edits only the shared file, so an own entry whose
// program no longer exists (vendors remove old versions) left that provider unavailable with nothing to
// show it or to repair it. Such an entry is dropped: with repair the file is rewritten without it and what
// was dropped is kept beside it; without repair nothing is written and only the result is computed. An own
// file left with no entry is no override, so the shared file applies again. An own entry whose program
// still exists is kept, whatever its version. The shared file is never changed here: a program the person
// selected in Settings stays selected and shows as missing.
// Returns { file, locations, removed }: file is what the backend reads (undefined when there is none);
// locations is given when the own file applies, otherwise read file; removed lists { key, path }.
function backendLocations(dataDir, shared, { repair = false } = {}) {
  const own = path.join(dataDir, 'runtime-locations.json');
  let present = false;
  if (!shared || path.resolve(own) !== path.resolve(shared)) { try { fs.lstatSync(own); present = true; } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  if (!present) return { file: shared || undefined, locations: null, removed: [] };
  const entries = readLocations(own);
  // No Settings file is known (a service started by hand): the own file is used as it is, as before.
  if (!shared) return { file: own, locations: entries, removed: [] };
  const removed = Object.entries(entries).filter(([, value]) => !isExecutable(value)).map(([key, value]) => ({ key, path: value }));
  const kept = Object.fromEntries(Object.entries(entries).filter(([, value]) => isExecutable(value)));
  if (repair && removed.length) {
    save(own, kept);
    // The record is for whoever checks an update afterwards; failing to write it must not stop the backend.
    try { fs.writeFileSync(path.join(dataDir, 'runtime-locations.removed.json'), JSON.stringify({ at: new Date().toISOString(), removed }), { mode: 0o600 }); } catch { /* the file itself is already repaired */ }
  }
  return Object.keys(kept).length ? { file: own, locations: kept, removed } : { file: shared, locations: null, removed };
}
module.exports = { readLocations, setLocation, isExecutable, backendLocations };
