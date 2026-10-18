const fs = require('node:fs');
const path = require('node:path');

// Relative, private paths only. Never move a live service's connection or store.
function readLayout(dataDir) {
  const file = path.join(dataDir, 'services.json');
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return { format: 1, active: '.', entries: ['.'] }; throw error; }
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('后台列表权限不安全；原会话未改动。');
  const layout = JSON.parse(fs.readFileSync(file, 'utf8'));
  const validKey = key => typeof key === 'string' && (key === '.' || /^backends\/[a-f0-9]{20}$/.test(key));
  if (layout.format !== 1 || !Array.isArray(layout.entries) || !layout.entries.length || new Set(layout.entries).size !== layout.entries.length || !layout.entries.includes(layout.active) || layout.entries.some(key => !validKey(key)) || (layout.pending !== undefined && (!validKey(layout.pending) || layout.entries.includes(layout.pending)))) throw new Error('后台列表无效；原会话未改动。');
  for (const key of [...layout.entries, ...(layout.pending ? [layout.pending] : [])]) {
    const dir = path.join(dataDir, key), parent = path.dirname(dir);
    for (const candidate of key === '.' ? [dir] : [parent, dir]) {
      const s = fs.lstatSync(candidate);
      if (!s.isDirectory() || s.uid !== process.getuid() || (s.mode & 0o077)) throw new Error('后台目录权限不安全；原会话未改动。');
    }
  }
  return layout;
}
function writeLayout(dataDir, layout) {
  const file = path.join(dataDir, 'services.json'), tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(layout), { mode: 0o600 }); fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, file);
}
module.exports = { readLayout, writeLayout };
