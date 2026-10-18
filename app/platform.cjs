const fs = require('node:fs');
const path = require('node:path');
function executable(name) {
  const candidates = (process.env.PATH || '').split(path.delimiter).map(p => path.join(p, name));
  candidates.push(path.join(require('node:os').homedir(), '.local/bin', name), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`);
  return candidates.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } });
}
function nativeEnvironment(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CLAUDECODE;
  delete env.CODEX_THREAD_ID;
  return env;
}

module.exports = { executable, nativeEnvironment };
