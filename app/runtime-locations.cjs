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
// The locations a backend started in dataDir uses: the shared Settings file, and nothing else.
// A backend's own file used to override it. Settings edits only the shared file, so nothing in the interface
// showed or could change such an entry; one naming a version the vendor had removed left the backend unable
// to run that provider, and one naming a version that still existed kept the backend on it (decided for the
// person on 2026-11-10 after 「为啥不把 agent 更新到最新」, and theirs to reverse). So when a backend starts,
// every entry of its own file is taken out: with repair the entries are first added to the record beside the
// file (the last twenty removals, each entry with whether its program still existed, so they can be put
// back), then the file is rewritten empty; without repair nothing is written and only the result is
// computed. If the record or the file cannot be written, nothing is taken out and the file is used as it
// is, as before, so this never stops a backend that started before it existed and never loses an entry.
// A record that exists but cannot be read is not written over: it is moved aside under a dated name and a
// new one is started; if it cannot be moved, nothing is taken out.
// An own file that cannot be read is an error, as it was before. The shared file is never changed here: a
// program the person selected in Settings stays selected and shows as missing. A service started by hand,
// with no Settings file known, keeps using its own file.
// Returns { file, locations, removed }: file is what the backend reads (undefined when there is none);
// locations is given only when the own file applies, otherwise read file; removed lists { key, path, existed }.
function backendLocations(dataDir, shared, { repair = false } = {}) {
  const own = path.join(dataDir, 'runtime-locations.json');
  let present = false;
  try { fs.lstatSync(own); present = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // The root backend's own file is the Settings file itself, whatever the two paths are spelled like (a linked
  // folder, another letter case): the same file is never treated as a backend's own.
  if (present && shared) { try { const a = fs.statSync(own), b = fs.statSync(shared); if (a.dev === b.dev && a.ino === b.ino) present = false; } catch { /* one of them is not there: not the same file */ } }
  if (!present) return { file: shared || undefined, locations: null, removed: [] };
  const entries = readLocations(own);
  if (!shared) return { file: own, locations: entries, removed: [] };
  const removed = Object.entries(entries).map(([key, value]) => ({ key, path: value, existed: isExecutable(value) }));
  if (repair && removed.length) {
    const record = path.join(dataDir, 'runtime-locations.removed.json');
    try {
      let earlier = [], text = null;
      try { text = fs.readFileSync(record, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') text = undefined; }
      if (text !== null) {
        let kept; try { kept = JSON.parse(text); } catch { /* unreadable */ }
        if (Array.isArray(kept?.removals)) earlier = kept.removals;
        // Earlier removals exist only here: a record that cannot be used is kept under another name, never written over.
        else fs.renameSync(record, `${record}.${new Date().toISOString().replace(/[:.]/g, '-')}.unreadable`);
      }
      // The record first: an entry is never taken out of the file without being kept here.
      save(record, { removals: [...earlier, { at: new Date().toISOString(), removed }].slice(-20) });
      save(own, {});
    } catch { return { file: own, locations: entries, removed: [] }; }
  }
  return { file: shared, locations: null, removed };
}
module.exports = { readLocations, setLocation, isExecutable, backendLocations };
