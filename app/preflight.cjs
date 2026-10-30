const { executable, pythonExecutable } = require('./platform.cjs');
const { readLocations } = require('./runtime-locations.cjs');
const { execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
function preflight() {
  // Avoid the macOS developer-tools installer shim during startup.
  try {
    const paths = { python: pythonExecutable(), claude: executable('claude'), codex: executable('codex') };
    const configured = readLocations();
    return { ...Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, Boolean(value)])), paths, configured };
  } catch (error) { return { python: false, claude: false, codex: false, paths: {}, configured: {}, error: error.message }; }
}
async function appBuildInfo(app, dataDir) {
  const info = { version: null, commit: null, installedAt: null };
  try {
    info.version = app.getVersion();
    if (!app.isPackaged) return info;
    const file = path.join(path.dirname(path.dirname(process.execPath)), 'Info.plist');
    const raw = await new Promise(resolve => execFile('/usr/bin/plutil', ['-extract', 'NAWSourceRevision', 'raw', '-o', '-', file],
      { encoding: 'utf8', timeout: 1000, maxBuffer: 4096 }, (error, stdout) => resolve(error ? null : stdout)));
    const commit = typeof raw === 'string' ? raw.replace(/\n$/, '') : '';
    if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit)) info.commit = commit;
    if (dataDir && info.commit) {
      const file = path.join(dataDir, 'installation.json'), stat = fs.lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4096 && !(stat.mode & 0o077) &&
          (typeof process.getuid !== 'function' || stat.uid === process.getuid())) {
        const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
        const executable = fs.statSync(process.execPath, { bigint: true });
        if (receipt.version === info.version && receipt.commit === info.commit &&
            receipt.executable?.dev === executable.dev.toString() && receipt.executable?.ino === executable.ino.toString() &&
            typeof receipt.installedAt === 'string' && new Date(receipt.installedAt).toISOString() === receipt.installedAt) {
          info.installedAt = receipt.installedAt;
        }
      }
    }
  } catch { /* Missing build metadata must never prevent a session from opening. */ }
  // Missing or stale receipts stay unknown. File times and first launch are not installation records.
  return info;
}
module.exports = { preflight, appBuildInfo };
