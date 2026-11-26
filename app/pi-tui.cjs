'use strict';
// A pi TUI session: `@earendil-works/pi-coding-agent` 1.6.1 (MIT) on DeepSeek, run in NAW's own PTY.
// - One pinned install per pi version, shared by every backend of a NAW data folder. It never changes
//   once installed, so no backend copies it (unlike dsh-tui.cjs).
// - Its own HOME, agent folder and session folder. Context files (each AGENTS.md/CLAUDE.md from the
//   working folder up to /), skills, prompt templates, extensions, MCP and project-local settings are
//   off: pi would otherwise put the person's ~/CLAUDE.md and ~/.agents/skills into every request.
// - pi's own network is off (--offline, PI_TELEMETRY=0): no install report, version check, model
//   catalog or tool download. The sandbox keeps the person's agent homes unreadable as well.
// - Network: only the loopback egress proxy, which passes api.deepseek.com (dsh-egress.cjs). Any other
//   attempt, by any process of the session, is refused, recorded and stops the session (dsh-witness.cjs).
// - The DeepSeek key: the DSH TUI's Keychain item, into the child's environment only.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { uiError, uiActivity } = require('./ui-errors.cjs');
const dshTui = require('./dsh-tui.cjs');

const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const AI_PACKAGE = '@earendil-works/pi-ai';
const PI_VERSION = '1.6.1';
const PI_INTEGRITY = 'sha512-+VSb95N4PB+G7TLceg7wkbJT31BEeIBnUT9500g9a1rOsCx78CUw1YFGtLcRhS6jj8pdfm0fFwrakrMLu6lVAQ==';
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const MAX_VIOLATIONS = 200;
// pi's own rule for session ids.
const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;

// A backend's data folder is the NAW data folder or backends/<hash> inside it (service-layout.cjs).
function dataRoot(dataDir) {
  const resolved = path.resolve(dataDir);
  const parent = path.dirname(resolved);
  return path.basename(parent) === 'backends' ? path.dirname(parent) : resolved;
}

function paths(dataDir) {
  const base = path.join(path.resolve(dataDir), 'pi-tui');
  const runtimeBase = path.join(dataRoot(dataDir), 'pi-tui-runtime');
  const root = path.join(runtimeBase, PI_VERSION);
  const home = path.join(base, 'home');
  const pkg = path.join(root, 'node_modules', PI_PACKAGE);
  return {
    base,
    runtimeBase,
    root,
    home,
    agentDir: path.join(home, '.pi', 'agent'),
    sessionDir: path.join(base, 'sessions'),
    tmp: path.join(home, 'tmp'),
    pkg,
    ai: path.join(root, 'node_modules', AI_PACKAGE),
    cli: path.join(pkg, 'dist', 'bundle', 'cli.js'),
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
  if (readVersion(where.pkg) !== PI_VERSION) return false;
  if (readVersion(where.ai) !== PI_VERSION) return false;
  return fs.existsSync(where.cli);
}

function unsafeRuntime(file) {
  return Object.assign(Error('Unsafe pi runtime entry'), { code: 'pi-runtime-unsafe', file });
}

// Every entry of the runtime belongs to this user and nobody else can write it: the session runs this
// code with the DeepSeek key. Links stay inside the tree. It yields now and then: the backend serves
// every session while a start checks the runtime.
async function verifyTree(root) {
  const uid = process.getuid?.();
  // The tree's own folder and its parent too: either one writable by others lets them swap the tree.
  for (const dir of [root, path.dirname(root)]) {
    const top = fs.lstatSync(dir);
    if (!top.isDirectory() || top.isSymbolicLink()) throw unsafeRuntime(dir);
    if ((uid !== undefined && top.uid !== uid) || (top.mode & 0o022)) throw unsafeRuntime(dir);
  }
  const pending = [root];
  let count = 0;
  while (pending.length) {
    const dir = pending.pop();
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file);
      if ((uid !== undefined && stat.uid !== uid) || (stat.mode & 0o022)) throw unsafeRuntime(file);
      if (stat.isSymbolicLink()) {
        const target = path.resolve(dir, fs.readlinkSync(file));
        if (target !== root && !target.startsWith(root + path.sep)) throw unsafeRuntime(file);
      } else if (stat.isDirectory()) {
        pending.push(file);
      } else if (!stat.isFile() || stat.nlink !== 1) {
        throw unsafeRuntime(file);
      }
      if (++count > 200000) throw unsafeRuntime(root);
      if (count % 256 === 0) await new Promise(resolve => setImmediate(resolve));
    }
  }
  return count;
}

// Full check before a launch: the pinned versions and the whole tree. Throws with a short reason.
async function verifyRuntime(dataDir) {
  const where = paths(dataDir);
  if (readVersion(where.pkg) !== PI_VERSION) throw Error(`pi runtime: ${PI_PACKAGE} is not ${PI_VERSION}`);
  if (readVersion(where.ai) !== PI_VERSION) throw Error(`pi runtime: ${AI_PACKAGE} is not ${PI_VERSION}`);
  if (!fs.existsSync(where.cli)) throw Error('pi runtime: cli missing');
  await verifyTree(where.root);
  return where;
}

function homeUnsafe() {
  return Object.assign(uiError('error.pi.homeUnsafe'), { code: 'pi-home-unsafe' });
}

// The session's folders, each a real folder NAW made (dsh-tui.cjs ownFolder). NAW writes no pi
// settings: what the person changes in pi's /settings stays, and the environment below overrides
// what matters for privacy (PI_OFFLINE, PI_TELEMETRY, the proxy).
function prepareHome(where) {
  for (const dir of [where.agentDir, where.tmp, where.sessionDir]) dshTui.ownFolder(where, dir, homeUnsafe);
}

// The real path, which sandbox rules match. A missing folder resolves through its nearest existing parent.
function realOrGiven(file) {
  const given = path.resolve(file);
  try {
    return fs.realpathSync(given);
  } catch {
    const parent = path.dirname(given);
    if (parent === given) return given;
    return path.join(realOrGiven(parent), path.basename(given));
  }
}

// Programs that hand work to processes outside the sandbox: a browser (open), other apps (osascript,
// automator, shortcuts) or launchd (launchctl).
const HANDOFF_PROGRAMS = Object.freeze(['/usr/bin/open', '/usr/bin/osascript', '/usr/bin/automator', '/usr/bin/shortcuts', '/bin/launchctl']);
// Files under the person's home that programs outside the sandbox read or run later.
const STARTUP_FILES = Object.freeze(['.zshrc', '.zshenv', '.zprofile', '.zlogin', '.bashrc', '.bash_profile', '.profile', '.gitconfig']);

// macOS sandbox rules for the pi process tree. The last matching rule wins.
// - Network as for the DSH TUI (dsh-tui.cjs sandboxProfile): outbound only IPv4 TCP to the egress
//   proxy's loopback port, nothing listens, and each refusal reaches the unified log with the nonce.
// - pi runs the model's commands without asking, so no command may reach the network through another
//   process either: Apple Events, LaunchServices, background URL sessions and launchd jobs are refused,
//   and so are the programs that use them.
// - Writes only in the working folder, pi's own folder, the temporary folders and /dev: nothing outside
//   that a program outside the sandbox runs later (launch agents, shell startup files, NAW's data
//   folder, this runtime).
// - The person's agent homes and rule files stay unreadable even though HOME points elsewhere.
// Refusals other than the network ones are quiet: the command fails and the session goes on.
function sandboxProfile({ proxyPort, nonce, where, cwd, personHome = os.homedir() }) {
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) throw Error('pi sandbox: invalid proxy port');
  if (!require('./dsh-witness.cjs').validNonce(nonce)) throw Error('pi sandbox: invalid nonce');
  if (typeof personHome !== 'string' || !path.isAbsolute(personHome)) throw Error('pi sandbox: invalid home');
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw Error('pi sandbox: invalid working folder');
  const q = dshTui.sbplString;
  const home = realOrGiven(personHome);
  const recorded = `(with message ${q(nonce)})`;
  const subpaths = list => list.map(dir => `(subpath ${q(dir)})`).join(' ');
  const literals = list => list.map(file => `(literal ${q(file)})`).join(' ');
  const agentFolders = ['.pi', '.claude', '.codex', '.agents', '.dsh', '.dsh-tui'].map(name => path.join(home, name));
  const agentFiles = ['CLAUDE.md', 'AGENTS.md'].map(name => path.join(home, name));
  const kept = [path.join(home, 'Library'), path.join(home, '.ssh'), path.join(home, '.config'), realOrGiven(path.dirname(where.runtimeBase))];
  return [
    '(version 1)',
    '(allow default)',
    `(deny network-outbound ${recorded})`,
    `(allow network-outbound (remote tcp4 ${q(`localhost:${proxyPort}`)}))`,
    `(deny network-inbound ${recorded})`,
    '(deny appleevent-send)',
    '(deny job-creation)',
    `(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.nsurlsessiond") (global-name-regex #"^com\\.apple\\.lsd\\."))`,
    `(deny process-exec ${literals(HANDOFF_PROGRAMS)})`,
    '(deny file-write*)',
    `(allow file-write* ${subpaths([realOrGiven(cwd), '/private/tmp', '/private/var/folders', '/dev'])})`,
    `(deny file-write* ${subpaths(kept)} ${literals(STARTUP_FILES.map(name => path.join(home, name)))})`,
    `(allow file-write* ${subpaths([realOrGiven(where.base)])})`,
    `(deny file-write* ${subpaths([realOrGiven(where.runtimeBase)])})`,
    `(deny file-read* file-write* ${subpaths(agentFolders)} ${literals(agentFiles)})`,
  ].join('\n');
}

// pi's switches that keep the person's files out of requests and pi off the network.
const PRIVATE_FLAGS = Object.freeze(['--offline', '--no-context-files', '--no-skills', '--no-prompt-templates',
  '--no-extensions', '--no-mcp', '--no-approve']);

// argv and the complete child environment. Nothing from NAW's environment passes unless listed here;
// the key is the only secret and only by value in the environment the PTY host hands to the child.
// `execPath`: a system Node.js. `sessionId`: pi's session id, which NAW chooses and keeps, so the same
// session opens again. `model` and `caFile` exist for tests only (the cheapest model, a fake DeepSeek).
function launchSpec({ where, sessionId, proxyPort, profile, apiKey, execPath, lang = process.env.LANG, model = null, caFile = null }) {
  if (typeof apiKey !== 'string' || apiKey === '') throw Error('pi: no DeepSeek key');
  if (typeof execPath !== 'string' || !path.isAbsolute(execPath)) throw Error('pi: no Node.js program');
  if (typeof profile !== 'string' || !profile.startsWith('(version 1)')) throw Error('pi: no sandbox profile');
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw Error('pi: invalid session id');
  if (model !== null && !/^deepseek\/[a-z0-9.-]{1,64}$/.test(model)) throw Error('pi: invalid model');
  const argv = [SANDBOX_EXEC, '-p', profile, execPath, '--disable-sigusr1', where.cli, ...PRIVATE_FLAGS,
    '--session-dir', where.sessionDir, '--session-id', sessionId];
  if (model !== null) argv.push('--model', model);
  const proxy = `http://127.0.0.1:${proxyPort}`;
  const env = {
    // The usual program folders, so pi's tools can run a project's own commands; the sandbox, not
    // PATH, decides what leaves the machine.
    PATH: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: where.home,
    PI_CODING_AGENT_DIR: where.agentDir,
    TMPDIR: where.tmp,
    LANG: typeof lang === 'string' && /^[A-Za-z0-9_.@-]{1,40}$/.test(lang) ? lang : 'en_US.UTF-8',
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    NODE_USE_ENV_PROXY: '1',
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    DEEPSEEK_API_KEY: apiKey,
  };
  if (caFile !== null) env.NODE_EXTRA_CA_CERTS = caFile;
  return { argv, env };
}

function readKey() {
  return dshTui.readKey({ missing: 'error.pi.keyMissing', code: 'pi-key-missing' });
}

// The runtime NativeHost hands to the workspace for provider `pi`: one terminal, no conversation
// channel, as for the DSH TUI. Any refused connection, at the proxy or in the sandbox, is recorded and
// stops the session.
class PiTui extends EventEmitter {
  // `testOnly` ({ route, caFile, execPath, model }) points a test at a fake DeepSeek or the cheapest
  // model; NativeHost never passes it.
  constructor(record, host, { Terminal, key = readKey, egress = require('./dsh-egress.cjs'), witness = require('./dsh-witness.cjs'), testOnly = {} } = {}) {
    super();
    this.record = record;
    this.host = host;
    this.Terminal = Terminal;
    this.key = key;
    this.egress = egress;
    this.witnessModule = witness;
    this.testOnly = testOnly;
    this.terminal = null;
    this.proxy = null;
    this.witness = null;
    this.stopped = false;
    this.chatAvailable = false;
    this.violation = null;
    this.violations = [];
  }
  async start() {
    let where;
    try {
      where = await verifyRuntime(this.host.dataDir);
    } catch (error) {
      const unsafe = error.code === 'pi-runtime-unsafe';
      throw Object.assign(uiError(unsafe ? 'error.pi.runtimeUnsafe' : 'error.pi.runtimeUnqualified'), { code: 'pi-runtime-unqualified', cause: error });
    }
    const execPath = this.testOnly.execPath || this.host.binaries?.pi;
    if (!execPath) throw uiError('error.nativeRuntimeMissing');
    await this.launch(where, execPath);
  }
  async launch(where, execPath) {
    prepareHome(where);
    // A record from before NAW chose pi's id gets one now; the same id opens the same session again.
    if (typeof this.record.nativeId !== 'string' || !SESSION_ID.test(this.record.nativeId)) this.record.nativeId = randomUUID();
    const apiKey = await this.key();
    const proxy = await this.egress.startEgress({
      route: this.testOnly.route || null,
      onViolation: found => this.blocked({ ...found, source: 'proxy' }),
    });
    this.proxy = proxy;
    if (this.stopped) {
      await this.closeGuards();
      return;
    }
    const nonce = `naw-pi-${randomBytes(12).toString('hex')}`;
    const profile = sandboxProfile({ proxyPort: proxy.port, nonce, where, cwd: this.record.cwd });
    try {
      this.witness = await this.witnessModule.startWitness({
        nonce,
        runCanary: () => dshTui.runCanary(profile, execPath),
        onDenial: denial => this.blocked(dshTui.sandboxViolation(denial)),
        onLost: reason => this.witnessLost(reason),
        onGap: gap => this.emit('dshWitnessGap', gap),
      });
    } catch (error) {
      await this.closeGuards();
      // Without the record a refused connection would not stop the session.
      throw Object.assign(uiError('error.pi.witnessUnavailable'), { code: 'pi-witness-unavailable', cause: error });
    }
    if (this.stopped || this.violation) {
      await this.closeGuards();
      return;
    }
    const options = { where, sessionId: this.record.nativeId, proxyPort: proxy.port, profile, apiKey, execPath };
    if (this.testOnly.caFile) options.caFile = this.testOnly.caFile;
    if (this.testOnly.model) options.model = this.testOnly.model;
    const spec = launchSpec(options);
    this.attach(new this.Terminal(spec.argv, this.record.cwd, spec.env, { isolatedEnv: true }));
  }
  async closeGuards() {
    this.witness?.close();
    await this.proxy?.close().catch(() => {});
  }
  attach(terminal) {
    this.terminal = terminal;
    terminal.on('data', event => this.emit('terminal', event));
    terminal.on('started', pid => {
      if (this.terminal !== terminal) return;
      this.emit('pid', pid);
      this.emit('state', 'idle');
    });
    terminal.on('closed', result => {
      if (this.terminal !== terminal) return;
      this.closeGuards().catch(() => {});
      // As for Claude: an exit the PTY host could not confirm is not an end.
      if (!result?.confirmed) {
        this.emit('activity', ...uiActivity('notice.activity.terminalDisconnectedExitUnconfirmed'));
        this.emit('state', 'error');
        return;
      }
      this.emit('state', 'ended');
    });
  }
  // Every refusal is kept (the newest 200); the first one is reported and stops the session.
  blocked(found) {
    this.violations.push(found);
    if (this.violations.length > MAX_VIOLATIONS) this.violations.shift();
    if (this.violation) return;
    this.violation = found;
    this.emit('activity', ...uiActivity('notice.activity.dshEgressBlocked', { target: found.target }));
    this.terminal?.stop().catch(() => {});
  }
  // The witness can no longer vouch for the record, so the session does not go on (dsh-tui.cjs).
  witnessLost(reason) {
    if (this.stopped || this.violation) return;
    const target = reason === 'witness-silent' ? 'witness-silent' : 'witness-lost';
    this.violation = { at: Date.now(), source: 'witness', target };
    this.violations.push(this.violation);
    this.emit('activity', ...uiActivity('notice.activity.dshWitnessLost'));
    this.terminal?.stop().catch(() => {});
  }
  openTerminal() {
    if (!this.terminal) throw Object.assign(Error('pi terminal is not running'), { code: 'pi-terminal-missing' });
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
      await this.closeGuards();
    }
    return { state: 'ended' };
  }
}

module.exports = {
  PI_PACKAGE,
  AI_PACKAGE,
  PI_VERSION,
  PI_INTEGRITY,
  PRIVATE_FLAGS,
  HANDOFF_PROGRAMS,
  STARTUP_FILES,
  SESSION_ID,
  dataRoot,
  paths,
  installed,
  verifyTree,
  verifyRuntime,
  prepareHome,
  sandboxProfile,
  launchSpec,
  readKey,
  PiTui,
};
