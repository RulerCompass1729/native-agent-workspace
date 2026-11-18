'use strict';
// A DSH TUI session: the community `@deepseek-harness-tui/dsh-tui` 0.18.0
// over the official `@deepseek-ai/dsh` 0.2.1-rc.2, run in NAW's own PTY.
// - Pinned install in its own prefix, checked by version and source digest.
// - Its own HOME and DSH_HOME; the person's ~/.dsh is never read.
// - Telemetry off, update check off, anonymous identifiers removed (preload).
// - Network: only the loopback egress proxy, which passes api.deepseek.com.
// - The DeepSeek key comes from its own Keychain item into the child's
//   environment; never into argv, files or logs.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { uiError, uiActivity } = require('./ui-errors.cjs');

const TUI_PACKAGE = '@deepseek-harness-tui/dsh-tui';
const TUI_VERSION = '0.18.0';
const DSH_PACKAGE = '@deepseek-ai/dsh';
const DSH_VERSION = '0.2.1-rc.2';
const TUI_INTEGRITY = 'sha512-3LMtBYYR3uyW1mx4CsqS13w7k7+YJ7u6/DefpxySbftnyzJOLSKM4I/OYwIK5hvom0P2n2OPsHt7HI42ENbrgg==';
const TUI_TARBALL_SHA256 = '93b88acd5ff59043f8b25ef283514408a2cc21bfe5f44e73409b5f21113e5ecf';
const PROFILE = 'dsh-tui';
// The person creates this item; NAW only reads it (see docs in the README).
const KEYCHAIN_SERVICE = 'NAW DSH TUI DeepSeek API key';
const KEYCHAIN_ACCOUNT = 'deepseek';
const SECURITY = '/usr/bin/security';
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

function paths(dataDir) {
  const base = path.join(dataDir, 'dsh-tui');
  const root = path.join(base, 'runtime');
  const home = path.join(base, 'home');
  return {
    base,
    root,
    home,
    dshHome: path.join(home, '.dsh'),
    tmp: path.join(home, 'tmp'),
    tui: path.join(root, 'node_modules', TUI_PACKAGE),
    dsh: path.join(root, 'node_modules', DSH_PACKAGE),
    hostEntry: path.join(root, 'node_modules', TUI_PACKAGE, 'lib/types/dsh-adapter/host-entry.js'),
  };
}

function readVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  } catch {
    return undefined;
  }
}

// Cheap: called whenever the client asks which programs exist.
function installed(dataDir) {
  const where = paths(dataDir);
  if (readVersion(where.tui) !== TUI_VERSION) return false;
  if (readVersion(where.dsh) !== DSH_VERSION) return false;
  return fs.existsSync(where.hostEntry);
}

// Every installed copy of `scope/name` under a node_modules tree, nested
// copies included (pkg/node_modules/..., @scope/pkg/node_modules/...).
function packageCopies(nodeModules, scope, name) {
  const found = [];
  const listDirectories = dir => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const names = [];
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) names.push(entry.name);
    }
    return names;
  };
  const visitPackage = (dir, fullName, depth) => {
    if (fullName === `${scope}/${name}` && fs.existsSync(path.join(dir, 'package.json'))) found.push(dir);
    visitTree(path.join(dir, 'node_modules'), depth + 1);
  };
  const visitTree = (dir, depth) => {
    if (depth > 12) return;
    for (const entry of listDirectories(dir)) {
      const child = path.join(dir, entry);
      if (!entry.startsWith('@')) {
        visitPackage(child, entry, depth);
        continue;
      }
      for (const scoped of listDirectories(child)) {
        visitPackage(path.join(child, scoped), `${entry}/${scoped}`, depth);
      }
    }
  };
  visitTree(nodeModules, 0);
  return found;
}

// Full check before a launch: versions, the single DeepSeek LLM copy, and
// the two sources the preload patches. Throws with a short reason.
function verifyRuntime(dataDir) {
  const where = paths(dataDir);
  if (readVersion(where.tui) !== TUI_VERSION) throw Error(`DSH TUI runtime: ${TUI_PACKAGE} is not ${TUI_VERSION}`);
  if (readVersion(where.dsh) !== DSH_VERSION) throw Error(`DSH TUI runtime: ${DSH_PACKAGE} is not ${DSH_VERSION}`);
  if (!fs.existsSync(where.hostEntry)) throw Error('DSH TUI runtime: host entry missing');
  const copies = packageCopies(path.join(where.root, 'node_modules'), '@deepseek-ai', 'dsh-llm-deepseek');
  if (copies.length !== 1) throw Error(`DSH TUI runtime: expected one dsh-llm-deepseek, found ${copies.length}`);
  const privacy = require('./butler-dsh-privacy.cjs');
  const llm = path.join(copies[0], 'lib/index.js');
  privacy.patchSource(fs.readFileSync(llm, 'utf8'), readVersion(copies[0]));
  const updateOff = require('./dsh-tui-update-off.cjs');
  updateOff.patchSource(fs.readFileSync(path.join(where.tui, 'lib/types/update.js'), 'utf8'), TUI_VERSION);
  return where;
}

// The profile the TUI host entry loads: the base bundle and the TUI bundle.
// DSH finds a non-built-in bundle only as a declared dependency under the
// profile's node_modules, so the TUI package is linked there from this
// runtime. NAW owns this profile and rewrites it on every launch; nothing is
// fetched.
function prepareHome(where) {
  for (const dir of [where.home, where.dshHome, where.tmp]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const profileDir = path.join(where.dshHome, 'profiles', PROFILE);
  const scopeDir = path.join(profileDir, 'node_modules', '@deepseek-harness-tui');
  fs.mkdirSync(scopeDir, { recursive: true, mode: 0o700 });
  const body = {
    name: `dsh-profile-${PROFILE}`,
    private: true,
    dependencies: { [TUI_PACKAGE]: TUI_VERSION },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', TUI_PACKAGE] } },
  };
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
  const link = path.join(scopeDir, 'dsh-tui');
  let current = null;
  try {
    current = fs.readlinkSync(link);
  } catch {
    current = null;
  }
  if (current !== where.tui) {
    fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(where.tui, link, 'dir');
  }
  return profileDir;
}

function sbplString(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// macOS sandbox rules for the TUI process tree. Outbound network is denied
// except TCP to the egress proxy's loopback port; an IP connection anywhere
// else kills the process. The person's own DSH homes stay unreadable even
// though HOME points elsewhere.
function sandboxProfile({ proxyPort, personHome = os.homedir() }) {
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) throw Error('DSH TUI sandbox: invalid proxy port');
  const lines = [
    '(version 1)',
    '(allow default)',
    // Last match wins. Non-IP outbound (the system DNS resolver's socket) is
    // refused without a kill: the model client looks the host up before it
    // uses the proxy, and that lookup must fail quietly, not end the session.
    '(deny network-outbound)',
    // Any IP connection except the egress proxy kills the process.
    '(deny network-outbound (with send-signal SIGKILL) (remote ip "*:*"))',
    `(allow network-outbound (remote ip ${sbplString(`localhost:${proxyPort}`)}))`,
    `(deny file-read* file-write* (subpath ${sbplString(path.join(personHome, '.dsh'))}) (subpath ${sbplString(path.join(personHome, '.dsh-tui'))}))`,
  ];
  return lines.join('\n');
}

// argv and the complete child environment. Nothing from NAW's environment
// passes unless listed here; the key is the only secret and only by value
// in the environment the PTY host hands to the child.
// `execPath`: a system Node.js (^22.19 or >=24). Not Electron: DSH's native
// addon refuses Electron 44.9, and the host entry would then fall back to an
// unpatched `dsh` CLI (which the PATH below cannot find).
// `caFile` exists for offline tests only (a fake api.deepseek.com certificate).
function launchSpec({ where, proxyPort, apiKey, execPath, lang = process.env.LANG, personHome = os.homedir(), caFile = null }) {
  if (typeof apiKey !== 'string' || apiKey === '') throw Error('DSH TUI: no DeepSeek key');
  if (typeof execPath !== 'string' || !path.isAbsolute(execPath)) throw Error('DSH TUI: no Node.js program');
  const preload = pathToFileURL(path.join(__dirname, 'dsh-tui-preload.mjs')).href;
  const argv = [
    SANDBOX_EXEC,
    '-p',
    sandboxProfile({ proxyPort, personHome }),
    execPath,
    '--disable-sigusr1',
    '--import',
    preload,
    where.hostEntry,
  ];
  const proxy = `http://127.0.0.1:${proxyPort}`;
  const env = {
    // System tools only: no `node` on PATH, so the host entry's fallback to
    // an unpatched `dsh` CLI cannot start.
    PATH: [path.join(where.root, 'node_modules/.bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: where.home,
    DSH_HOME: where.dshHome,
    TMPDIR: where.tmp,
    LANG: typeof lang === 'string' && /^[A-Za-z0-9_.@-]{1,40}$/.test(lang) ? lang : 'en_US.UTF-8',
    ELECTRON_RUN_AS_NODE: '1',
    NODE_COMPILE_CACHE: path.join(where.home, '.dsh-tui', 'compile-cache'),
    NODE_USE_ENV_PROXY: '1',
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_TUI_PROFILE: PROFILE,
    DSH_TUI_HOST_ENTRY_PATH: where.hostEntry,
    DSH_TUI_LAUNCHER_VERSION: TUI_VERSION,
    DSH_BUNDLED_SKILL_DIR: path.join(where.tui, 'guide'),
    NAW_DSH_TUI_ROOT: where.root,
    DEEPSEEK_API_KEY: apiKey,
  };
  if (caFile !== null) env.NODE_EXTRA_CA_CERTS = caFile;
  return { argv, env };
}

// Reads the key from the dedicated Keychain item. It is held in memory only
// for the launch; a missing item refuses the session rather than letting the
// TUI's own setup save a key to disk. `program` is replaced only in tests,
// which never read the real Keychain.
function readKey({ program = SECURITY } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'];
    execFile(program, args, { timeout: 10000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      const key = String(stdout || '').replace(/\r?\n$/, '');
      if (error || key === '') {
        reject(Object.assign(uiError('error.dsh.keyMissing'), { code: 'dsh-key-missing' }));
        return;
      }
      resolve(key);
    });
  });
}

// The runtime NativeHost hands to the workspace for provider `dsh`: one
// terminal, no conversation channel. Closing the egress proxy and the
// terminal is all a stop needs; a blocked connection stops the session.
class DshTui extends EventEmitter {
  // `testOnly` ({ route, caFile, execPath }) points an offline test at a fake
  // DeepSeek; NativeHost never passes it.
  constructor(record, host, { Terminal, key = readKey, egress = require('./dsh-egress.cjs'), testOnly = {} } = {}) {
    super();
    this.record = record;
    this.host = host;
    this.Terminal = Terminal;
    this.key = key;
    this.egress = egress;
    this.testOnly = testOnly;
    this.terminal = null;
    this.proxy = null;
    this.stopped = false;
    this.chatAvailable = false;
    this.violation = null;
  }
  async start() {
    let where;
    try {
      where = verifyRuntime(this.host.dataDir);
    } catch (error) {
      throw Object.assign(uiError('error.dsh.runtimeUnqualified'), { code: 'dsh-runtime-unqualified', cause: error });
    }
    const execPath = this.testOnly.execPath || this.host.binaries?.dsh;
    if (!execPath) throw uiError('error.nativeRuntimeMissing');
    prepareHome(where);
    const apiKey = await this.key();
    const proxy = await this.egress.startEgress({ route: this.testOnly.route || null, onViolation: found => this.blocked(found) });
    this.proxy = proxy;
    if (this.stopped) {
      await proxy.close();
      return;
    }
    const options = { where, proxyPort: proxy.port, apiKey, execPath };
    if (this.testOnly.caFile) options.caFile = this.testOnly.caFile;
    const spec = launchSpec(options);
    this.attach(new this.Terminal(spec.argv, this.record.cwd, spec.env, { isolatedEnv: true }));
  }
  attach(terminal) {
    this.terminal = terminal;
    terminal.on('data', event => this.emit('terminal', event));
    terminal.on('started', pid => {
      this.emit('pid', pid);
      this.emit('state', 'idle');
    });
    terminal.on('closed', result => {
      this.proxy?.close().catch(() => {});
      // As for Claude: an exit the PTY host could not confirm is not an end.
      if (!result?.confirmed) {
        this.emit('activity', ...uiActivity('notice.activity.terminalDisconnectedExitUnconfirmed'));
        this.emit('state', 'error');
        return;
      }
      this.emit('state', 'ended');
    });
  }
  blocked(found) {
    if (this.violation) return;
    this.violation = found;
    this.emit('activity', ...uiActivity('notice.activity.dshEgressBlocked', { target: found.target }));
    this.terminal?.stop().catch(() => {});
  }
  openTerminal() {
    if (!this.terminal) throw Object.assign(Error('DSH TUI terminal is not running'), { code: 'dsh-terminal-missing' });
    return this.terminal;
  }
  async interrupt() {
    return { interrupted: false };
  }
  async stop() {
    this.stopped = true;
    try {
      if (this.terminal?.alive) await this.terminal.stop();
    } finally {
      await this.proxy?.close().catch(() => {});
    }
    return { state: 'ended' };
  }
}

module.exports = {
  TUI_PACKAGE,
  TUI_VERSION,
  DSH_PACKAGE,
  DSH_VERSION,
  TUI_INTEGRITY,
  TUI_TARBALL_SHA256,
  PROFILE,
  KEYCHAIN_SERVICE,
  KEYCHAIN_ACCOUNT,
  paths,
  installed,
  packageCopies,
  verifyRuntime,
  prepareHome,
  sandboxProfile,
  launchSpec,
  readKey,
  DshTui,
};
