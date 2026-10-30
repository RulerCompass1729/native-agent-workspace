const { executable, pythonExecutable } = require('./platform.cjs');
const { readLocations } = require('./runtime-locations.cjs');
const { execFile } = require('node:child_process');
const path = require('node:path');
function preflight() {
  // Avoid the macOS developer-tools installer shim during startup.
  try {
    const paths = { python: pythonExecutable(), claude: executable('claude'), codex: executable('codex') };
    const configured = readLocations();
    return { ...Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, Boolean(value)])), paths, configured };
  } catch (error) { return { python: false, claude: false, codex: false, paths: {}, configured: {}, error: error.message }; }
}
async function appBuildInfo(app) {
  const info = { version: null, commit: null, installedAt: null };
  try {
    info.version = app.getVersion();
    if (!app.isPackaged) return info;
    const file = path.join(path.dirname(path.dirname(process.execPath)), 'Info.plist');
    const raw = await new Promise(resolve => execFile('/usr/bin/plutil', ['-extract', 'NAWSourceRevision', 'raw', '-o', '-', file],
      { encoding: 'utf8', timeout: 1000, maxBuffer: 4096 }, (error, stdout) => resolve(error ? null : stdout)));
    const commit = typeof raw === 'string' ? raw.replace(/\n$/, '') : '';
    if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit)) info.commit = commit;
  } catch { /* Missing build metadata must never prevent a session from opening. */ }
  // No installation receipt exists. File times and first launch are not one.
  return info;
}
module.exports = { preflight, appBuildInfo };
