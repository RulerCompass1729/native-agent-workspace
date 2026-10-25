const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readLocations, isExecutable } = require('./runtime-locations.cjs');
function executable(name, acceptable = () => true) {
  let configured;
  try { configured = readLocations()[name]; } catch { return undefined; }
  // An explicitly selected but missing program must not silently switch to a
  // different installation. Show the setting as unavailable until repaired.
  if (configured) return isExecutable(configured) && acceptable(configured) ? configured : undefined;
  const candidates = (process.env.PATH || '').split(path.delimiter).map(p => path.join(p, name));
  candidates.push(path.join(require('node:os').homedir(), '.local/bin', name), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`);
  return candidates.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile() && acceptable(p); } catch { return false; } });
}
function pythonExecutable() {
  // Finder's PATH can find the developer-tools installer shim before a real
  // Python installed by python.org. Skip the shim while searching, not after
  // choosing it, so installation followed by Recheck works without restarting.
  return executable('python3', python => process.platform !== 'darwin' ||
    python !== '/usr/bin/python3' || fs.existsSync('/Library/Developer/CommandLineTools/usr/bin/python3'));
}
function nativeEnvironment(extra = {}) {
  const env = { ...process.env, ...extra };
  // Finder launches with a small PATH; preserve the user's order and append
  // the same conventional locations used by executable discovery.
  env.PATH = [...new Set([...(env.PATH || '').split(path.delimiter).filter(Boolean), path.join(require('node:os').homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])].join(path.delimiter);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CLAUDECODE;
  delete env.CODEX_THREAD_ID;
  // The service's own locations: a NAW started from a native terminal must not
  // inherit this service's profile, workspace, runtime configuration or version.
  delete env.NAW_WORKSPACE;
  delete env.NAW_RUNTIME_CONFIG;
  delete env.NAW_APP_VERSION;
  delete env.NAW_DATA_DIR;
  return env;
}

function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return null;
  try {
    const started = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return started ? { pid, started } : null;
  } catch { return null; }
}
function processMayBeAlive(identity) {
  if (!identity?.pid) return false;
  try { process.kill(identity.pid, 0); } catch (error) { return error.code !== 'ESRCH'; }
  const current = processIdentity(identity.pid);
  return !identity.started || !current || current.started === identity.started;
}

module.exports = { executable, pythonExecutable, nativeEnvironment, processIdentity, processMayBeAlive };
