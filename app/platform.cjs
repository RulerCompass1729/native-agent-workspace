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
  // A NAW started from an agent's command tool must not pass that agent's
  // session identity on. Codex marks its non-interactive tool shell CODEX_CI=1
  // and sets NO_COLOR=1 there, which would leave every native terminal colourless;
  // a person's own NO_COLOR (no such marker) is kept.
  if (env.CODEX_CI === '1') delete env.NO_COLOR;
  for (const key of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_TOOL_CALL_ID', 'CODEX_CI']) delete env[key];
  // Native programs run in this app's terminal, not the one NAW was started from.
  // The launcher terminal's identity would choose their keyboard protocol, clipboard,
  // colours and image protocol for a terminal they are not in.
  // __CFBundleIdentifier names the app that launched this process tree (iTerm's when
  // started there); Claude reads it as a terminal identity too.
  for (const key of Object.keys(env)) if (/^(__CFBundleIdentifier|TERM_PROGRAM|TERM_PROGRAM_VERSION|TERM_SESSION_ID|TERM_FEATURES|TERMINFO_DIRS|LC_TERMINAL|LC_TERMINAL_VERSION|COLORFGBG|TMUX|TMUX_PANE|STY|WT_SESSION|WT_PROFILE_ID|VTE_VERSION|KONSOLE_VERSION|TERMINAL_EMULATOR|ZED_TERM)$|^(ITERM|KITTY|WEZTERM|GHOSTTY|ALACRITTY|ZELLIJ)_|^ZELLIJ$/.test(key)) delete env[key];
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
