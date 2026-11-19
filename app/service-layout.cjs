const { uiError } = require('./ui-errors.cjs');
const fs = require('node:fs');
const path = require('node:path');
const DSH_INHERIT_ATTEMPTS = 2;

// Relative, private paths only. Never move a live service's connection or store.
function readLayout(dataDir) {
  const file = path.join(dataDir, 'services.json');
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return { format: 1, active: '.', entries: ['.'] }; throw error; }
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw uiError("error.service.layoutPermissions");
  const layout = JSON.parse(fs.readFileSync(file, 'utf8'));
  const validKey = key => typeof key === 'string' && (key === '.' || /^backends\/[a-f0-9]{20}$/.test(key));
  if (layout.format !== 1 || !Array.isArray(layout.entries) || !layout.entries.length || new Set(layout.entries).size !== layout.entries.length || !layout.entries.includes(layout.active) || layout.entries.some(key => !validKey(key)) || (layout.pending !== undefined && (!validKey(layout.pending) || layout.entries.includes(layout.pending)))) throw uiError("error.service.invalidLayout");
  if (layout.dshInheritance !== undefined) {
    const history = layout.dshInheritance, pairs = new Set();
    if (!history || typeof history.version !== 'string' || !history.version || !Array.isArray(history.failures) || history.failures.some(row => {
      if (!row || !validKey(row.source) || !validKey(row.target) || row.source === row.target || !Number.isInteger(row.attempts) || row.attempts < 1 || row.attempts > DSH_INHERIT_ATTEMPTS || !['deadline', 'filesystem', 'unqualified', 'unavailable'].includes(row.reason)) return true;
      const key = JSON.stringify([row.source, row.target]); if (pairs.has(key)) return true; pairs.add(key); return false;
    })) throw uiError("error.service.invalidLayout");
  }
  for (const key of [...layout.entries, ...(layout.pending ? [layout.pending] : [])]) {
    const dir = path.join(dataDir, key), parent = path.dirname(dir);
    for (const candidate of key === '.' ? [dir] : [parent, dir]) {
      const s = fs.lstatSync(candidate);
      if (!s.isDirectory() || s.uid !== process.getuid() || (s.mode & 0o077)) throw uiError("error.service.backendDirectoryPermissions");
    }
  }
  return layout;
}
function writeLayout(dataDir, layout) {
  const file = path.join(dataDir, 'services.json'), tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(layout), { mode: 0o600 }); fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, file);
}
module.exports = { readLayout, writeLayout, DSH_INHERIT_ATTEMPTS };
