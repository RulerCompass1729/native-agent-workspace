const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readLocations, isExecutable, backendLocations } = require('./runtime-locations.cjs');
// locations: the configured locations to use instead of this process's own file (a check of another backend).
function executable(name, acceptable = () => true, locations = null) {
  let configured;
  try { configured = (locations || readLocations())[name]; } catch { return undefined; }
  // An explicitly selected but missing program must not silently switch to a
  // different installation. Show the setting as unavailable until repaired.
  if (configured) return isExecutable(configured) && acceptable(configured) ? configured : undefined;
  const candidates = (process.env.PATH || '').split(path.delimiter).map(p => path.join(p, name));
  candidates.push(path.join(require('node:os').homedir(), '.local/bin', name), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`);
  return candidates.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile() && acceptable(p); } catch { return false; } });
}
function pythonExecutable(locations = null) {
  // Finder's PATH can find the developer-tools installer shim before a real
  // Python installed by python.org. Skip the shim while searching, not after
  // choosing it, so installation followed by Recheck works without restarting.
  return executable('python3', python => process.platform !== 'darwin' ||
    python !== '/usr/bin/python3' || fs.existsSync('/Library/Developer/CommandLineTools/usr/bin/python3'), locations);
}
// What the backend in <dataDir>/<key> would run for each program if it started now, without changing anything:
// the shared Settings file, else discovery on this process's PATH. Entries of the backend's own locations file
// are taken out at a real start (runtime-locations.cjs) and are listed as wouldDrop. Used to check an update
// before it is installed.
function backendPrograms(dataDir, key = '.') {
  const shared = path.join(dataDir, 'runtime-locations.json');
  const result = backendLocations(path.join(dataDir, key), shared, { repair: false }), locations = readLocations(shared);
  const programs = {};
  for (const name of ['claude', 'codex', 'python3']) {
    const found = name === 'python3' ? pythonExecutable(locations) : executable(name, undefined, locations);
    programs[name] = { available: Boolean(found), path: found || locations[name] || null, source: locations[name] ? 'settings' : found ? 'found' : 'missing' };
  }
  return { backend: key, wouldDrop: result.removed, programs, ok: Object.values(programs).every(program => program.available) };
}
// What an agent program sets for the commands it runs, to describe its own session: who it is, how to reach it,
// where it keeps its files. None of these is a setting a person makes; those (CLAUDE_CODE_SUBAGENT_MODEL,
// CLAUDE_CODE_EFFORT_LEVEL, CODEX_HOME and the like) are kept. Sources: Claude Code's documented list and the
// child-environment list of 2.1.322; the per-thread and per-call names of Codex 0.167.1.
const LAUNCHER_SESSION = [
  // Which session it is and how it was entered.
  'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_BRIDGE_SESSION_ID',
  // Its process, its executable, its effort level at that moment, and its background job's folder.
  'CLAUDE_PID', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_EFFORT', 'CLAUDE_JOB_DIR',
  // Its message inbox, and the token that proves a sender belongs to it.
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_TOOL_CALL_ID', 'CODEX_CI',
];
function nativeEnvironment(extra = {}) {
  const env = { ...process.env };
  // NAW gives a native Claude its own hook token and sockets with the launch (in `extra`), and never puts them
  // into a process's own environment. Found there, they are those of a NAW session whose command tool started
  // this NAW; a launch that is given none of its own (Codex) must not get that session's.
  for (const key of ['NAW_HOOK_TOKEN', 'NAW_HOOK_SOCKET', 'NAW_SUBMIT_SOCKET']) delete env[key];
  Object.assign(env, extra);
  // Finder launches with a small PATH; preserve the user's order and append
  // the same conventional locations used by executable discovery.
  env.PATH = [...new Set([...(env.PATH || '').split(path.delimiter).filter(Boolean), path.join(require('node:os').homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])].join(path.delimiter);
  delete env.ELECTRON_RUN_AS_NODE;
  // A NAW started from an agent's command tool must not pass that agent's
  // session on. Codex marks its non-interactive tool shell CODEX_CI=1
  // and sets NO_COLOR=1 there, which would leave every native terminal colourless;
  // a person's own NO_COLOR (no such marker) is kept.
  if (env.CODEX_CI === '1') delete env.NO_COLOR;
  for (const key of LAUNCHER_SESSION) delete env[key];
  // AI_AGENT says an agent is running this process. Claude Code writes claude-code_… (earlier claude-code/…)
  // and itself replaces only such a value; any other value is someone's own and is kept.
  if (/^claude-code[_/]/.test(env.AI_AGENT || '')) delete env.AI_AGENT;
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

module.exports = { executable, pythonExecutable, nativeEnvironment, processIdentity, processMayBeAlive, backendPrograms };
