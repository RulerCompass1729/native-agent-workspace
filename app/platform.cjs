const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
function executable(name) {
  const candidates = (process.env.PATH || '').split(path.delimiter).map(p => path.join(p, name));
  candidates.push(path.join(require('node:os').homedir(), '.local/bin', name), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`);
  return candidates.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } });
}
function pythonExecutable() {
  const python = executable('python3');
  return python === '/usr/bin/python3' && !fs.existsSync('/Library/Developer/CommandLineTools/usr/bin/python3') ? undefined : python;
}
function nativeEnvironment(extra = {}) {
  const env = { ...process.env, ...extra };
  // Finder launches with a small PATH; preserve the user's order and append
  // the same conventional locations used by executable discovery.
  env.PATH = [...new Set([...(env.PATH || '').split(path.delimiter).filter(Boolean), path.join(require('node:os').homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])].join(path.delimiter);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CLAUDECODE;
  delete env.CODEX_THREAD_ID;
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
