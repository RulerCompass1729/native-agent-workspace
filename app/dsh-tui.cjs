'use strict';
// A DSH TUI session: the community `@deepseek-harness-tui/dsh-tui` 0.18.0
// over the official `@deepseek-ai/dsh` 0.2.1-rc.2, run in NAW's own PTY.
// - Pinned install in its own prefix, checked by version and source digest.
// - Its own HOME and DSH_HOME; the person's ~/.dsh is never read.
// - Telemetry off, update check off, anonymous identifiers removed (preload).
// - Network: only the loopback egress proxy, which passes api.deepseek.com.
//   Any other attempt, by any process of the session, is refused, recorded
//   and stops the session (dsh-egress.cjs, dsh-witness.cjs).
// - The DeepSeek key comes from its own Keychain item into the child's
//   environment; never into argv, files or logs.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { uiError, uiActivity } = require('./ui-errors.cjs');
const { validNonce } = require('./dsh-witness.cjs');

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
const MAX_VIOLATIONS = 200;

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

// Only the immutable runtime crosses backends; each backend keeps its own home and guards.
async function inheritRuntime(sourceDataDir, targetDataDir, { cleanStaging = false } = {}) {
  const { performance } = require('node:perf_hooks');
  const started = performance.now(), io = fs.promises, uid = process.getuid?.();
  if (uid === undefined) return { status: 'unsupported' };
  if (![sourceDataDir, targetDataDir].every(value => typeof value === 'string' && path.isAbsolute(value))) throw uiError('error.dsh.runtimeUnqualified');
  const source = paths(path.resolve(sourceDataDir)), target = paths(path.resolve(targetDataDir));
  let deadlineStarted = started;
  const tick = () => { if (performance.now() - deadlineStarted > 30000) throw Error('Runtime inheritance deadline'); };
  const refusal = (message, file, s) => Object.assign(Error(message), { runtimeEntry: [path.relative(targetDataDir, file),
    s.dev, s.ino, s.uid, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs] });
  const directory = file => {
    const s = fs.lstatSync(file);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== uid || s.mode & 0o022) throw refusal('Unsafe runtime directory', file, s);
    return s;
  };
  const rootState = (data, where) => {
    directory(data);
    if (!lstatOrNull(where.base)) return null;
    directory(where.base);
    const found = lstatOrNull(where.root);
    if (found) directory(where.root);
    return found;
  };
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && b.nlink === 1;
  async function tree(root, links = true) {
    const entries = new Map(), dirs = ['']; let bytes = 0, count = 0;
    while (dirs.length) {
      const rel = dirs.shift(), dir = path.join(root, rel); directory(dir);
      for (const name of fs.readdirSync(dir)) {
        const relative = path.join(rel, name), file = path.join(root, relative), s = fs.lstatSync(file);
        if (++count > 120000 + (links ? 0 : 2) || relative.split(path.sep).length > (links ? 32 : 34) || s.uid !== uid) throw Error('Runtime tree limit or owner');
        const entry = { relative, stat: s };
        if (s.isSymbolicLink()) {
          if (!links) throw Error('Linked staging entry');
          entry.link = fs.readlinkSync(file);
        }
        else if (s.mode & 0o022) throw refusal('Writable runtime entry', file, s);
        else if (s.isDirectory()) { entry.kind = 'dir'; dirs.push(relative); }
        else if (s.isFile() && s.nlink === 1 && s.size <= 256 * 1024 * 1024) { entry.kind = 'file'; bytes += s.size; }
        else throw refusal('Unsafe runtime entry', file, s);
        if (bytes > 2 * 1024 * 1024 * 1024) throw Error('Runtime byte limit');
        entries.set(relative, entry);
        if (count % 128 === 0) { tick(); await new Promise(resolve => setImmediate(resolve)); }
      }
    }
    // Resolve links from the inventory, never by following an unchecked path on disk.
    for (const entry of entries.values()) if (entry.link !== undefined) {
      let parts = entry.relative.split(path.sep), hops = 0;
      for (let index = 0; index < parts.length; index++) {
        const item = entries.get(parts.slice(0, index + 1).join(path.sep));
        if (!item) throw Error('Dangling runtime link');
        if (item.link !== undefined) {
          if (++hops > 32 || path.isAbsolute(item.link)) throw Error('Unsafe runtime link');
          const next = path.normalize(path.join(path.dirname(item.relative), item.link, ...parts.slice(index + 1)));
          if (next === '..' || next.startsWith('..' + path.sep) || path.isAbsolute(next)) throw Error('Runtime link escapes');
          parts = next.split(path.sep); index = -1;
        } else if (index < parts.length - 1 && item.kind !== 'dir') throw Error('Invalid runtime link path');
      }
    }
    tick(); return { entries, bytes };
  }
  let staging, stagingIdentity, placeholder, published = false, checkingTarget = true;
  try {
    if (cleanStaging) {
      // The service startup lock excludes a live copier; unknown trees remain untouched.
      directory(targetDataDir);
      for (const name of fs.readdirSync(targetDataDir)) {
        tick();
        if (!/^\.dsh-tui-inherit-[A-Za-z0-9]{6}$/.test(name)) continue;
        const old = path.join(targetDataDir, name), where = paths(old);
        try {
          const identity = directory(old);
          if (fs.readdirSync(old).some(entry => entry !== 'dsh-tui')) continue;
          if (lstatOrNull(where.base)) {
            directory(where.base);
            if (fs.readdirSync(where.base).some(entry => entry !== 'runtime')) continue;
          }
          if (lstatOrNull(where.root)) directory(where.root);
          await tree(old, false);
          const current = directory(old);
          if (current.dev === identity.dev && current.ino === identity.ino) await io.rm(old, { recursive: true });
        } catch (error) {
          if (error.message === 'Runtime inheritance deadline') throw error;
        }
      }
    }
    deadlineStarted = performance.now();
    if (rootState(targetDataDir, target)) { await tree(target.root); verifyRuntime(targetDataDir); return { status: 'existing' }; }
    checkingTarget = false;
    if (!rootState(sourceDataDir, source)) return { status: 'absent' };
    if (target.root.startsWith(source.root + path.sep) || source.root.startsWith(target.root + path.sep)) throw Error('Overlapping runtime roots');
    const inventory = await tree(source.root); verifyRuntime(sourceDataDir); tick();
    staging = await io.mkdtemp(path.join(targetDataDir, '.dsh-tui-inherit-')); stagingIdentity = directory(staging);
    const staged = paths(staging); await io.mkdir(staged.root, { recursive: true, mode: 0o700 });
    for (const entry of inventory.entries.values()) if (entry.kind === 'dir') await io.mkdir(path.join(staged.root, entry.relative), { mode: 0o700 });
    const files = [...inventory.entries.values()].filter(entry => entry.kind === 'file'); let cursor = 0, failure;
    await Promise.all(Array.from({ length: Math.min(8, files.length) }, async () => {
      const buffer = Buffer.allocUnsafe(128 * 1024);
      while (!failure && cursor < files.length) {
        const entry = files[cursor++]; let input, output;
        try {
          tick(); input = await io.open(path.join(source.root, entry.relative), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          if (!same(entry.stat, await input.stat())) throw Error('Runtime source changed');
          output = await io.open(path.join(staged.root, entry.relative), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, entry.stat.mode & 0o700);
          let position = 0;
          while (position < entry.stat.size) {
            tick();
            const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, entry.stat.size - position), position);
            if (!bytesRead) throw Error('Short runtime read');
            let written = 0;
            while (written < bytesRead) {
              const { bytesWritten } = await output.write(buffer, written, bytesRead - written, position + written);
              if (!bytesWritten) throw Error('Short runtime write');
              written += bytesWritten;
            }
            position += bytesRead;
          }
          if (!same(entry.stat, await input.stat()) || (await output.stat()).size !== entry.stat.size) throw Error('Runtime copy changed');
          tick();
        } catch (error) { failure ||= error; }
        finally {
          const closed = await Promise.allSettled([input?.close(), output?.close()]);
          for (const item of closed) if (item.status === 'rejected') failure ||= item.reason;
        }
      }
    }));
    if (failure) throw failure;
    for (const entry of inventory.entries.values()) if (entry.link !== undefined) await io.symlink(entry.link, path.join(staged.root, entry.relative));
    const copied = await tree(staged.root);
    if (copied.bytes !== inventory.bytes || copied.entries.size !== inventory.entries.size) throw Error('Incomplete runtime copy');
    verifyRuntime(staging); verifyRuntime(sourceDataDir); tick();
    await io.mkdir(target.base, { recursive: true, mode: 0o700 }); const parent = directory(target.base);
    // An exclusive empty reservation prevents rename from replacing another install's directory.
    try { await io.mkdir(target.root, { mode: 0o700 }); placeholder = directory(target.root); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      directory(target.root); await tree(target.root); verifyRuntime(targetDataDir); return { status: 'existing' };
    }
    const current = directory(target.base), reserved = directory(target.root);
    if (current.dev !== parent.dev || current.ino !== parent.ino || reserved.dev !== placeholder.dev || reserved.ino !== placeholder.ino || fs.readdirSync(target.root).length) throw Error('Runtime destination changed');
    await io.rename(staged.root, target.root); published = true;
    return { status: 'copied', entries: inventory.entries.size, bytes: inventory.bytes, elapsedMs: performance.now() - started };
  } catch (cause) {
    // Refused before the source was read: the source's qualification is unknown.
    const reason = cause.message === 'Runtime inheritance deadline' ? 'deadline' : checkingTarget ? 'target' : cause.code ? 'filesystem' : 'unqualified';
    throw Object.assign(uiError('error.dsh.runtimeUnqualified'), { code: 'dsh-runtime-inheritance-refused', reason, cause,
      ...(reason === 'target' && cause.runtimeEntry ? { targetEntry: cause.runtimeEntry } : {}) });
  } finally {
    if (placeholder && !published) {
      const current = lstatOrNull(target.root);
      if (current?.isDirectory() && !current.isSymbolicLink() && current.dev === placeholder.dev && current.ino === placeholder.ino && !fs.readdirSync(target.root).length) await io.rmdir(target.root);
    }
    if (staging && stagingIdentity) {
      const current = lstatOrNull(staging);
      if (current?.isDirectory() && !current.isSymbolicLink() && current.dev === stagingIdentity.dev && current.ino === stagingIdentity.ino) await io.rm(staging, { recursive: true, force: true });
    }
  }
}

function homeUnsafe() {
  return Object.assign(uiError('error.dsh.homeUnsafe'), { code: 'dsh-home-unsafe' });
}

function lstatOrNull(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Each folder from `where.base` down to `dir` is a real folder NAW made
// (0700). A symlink or a file anywhere on the way refuses the launch: the
// TUI and its tools can write in this home, and nothing NAW writes or
// replaces here may land outside it.
function ownFolder(where, dir) {
  const parts = path.relative(where.base, dir).split(path.sep).filter(part => part !== '');
  let current = where.base;
  for (const part of ['', ...parts]) {
    current = path.join(current, part);
    const stat = lstatOrNull(current);
    if (stat === null) {
      fs.mkdirSync(current, { mode: 0o700 });
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw homeUnsafe();
  }
}

// Replaces a file NAW owns in the TUI home. Anything there NAW did not
// write refuses the launch: a symlink, a folder, or a file with another
// name elsewhere (a hard link). The text goes into a new file of NAW's own,
// which then takes the old one's place: whatever is put at `file` after the
// check, a link included, is replaced and never written through.
function writeOwnFile(file, text) {
  const found = lstatOrNull(file);
  if (found !== null && (!found.isFile() || found.nlink !== 1)) throw homeUnsafe();
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.naw-${randomBytes(8).toString('hex')}`);
  // O_EXCL with O_CREAT: a new file, never one already there or a link.
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  const descriptor = fs.openSync(temporary, flags, 0o600);
  try {
    try {
      fs.writeSync(descriptor, text);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, file);
  } catch (error) {
    // Removes only the name made above; unlink never empties a folder.
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Already gone.
    }
    throw error;
  }
}

// DSH's home-level patch layer, applied over the profile's own patch (where
// the TUI's /settings saves). It turns off the TUI's loopback web server,
// which exists only for the DeepSeek account sign-in callback: NAW sessions
// use the Keychain key, and the sandbox refuses every listening socket, so
// leaving it on would stop each session as it starts. Nothing in DSH writes
// this file.
const HOME_PATCH = [
  '# Written by NAW on every launch.',
  '- id: dsh-tui-webserver',
  "  name: '@deepseek-ai/dsh-host-webserver'",
  '  disabled: true',
  '',
].join('\n');

// The profile the TUI host entry loads: the base bundle and the TUI bundle.
// DSH finds a non-built-in bundle only as a declared dependency under the
// profile's node_modules, so the TUI package is linked there from this
// runtime. NAW owns this profile and the home-level patch and rewrites both
// on every launch; nothing is fetched.
function prepareHome(where) {
  ownFolder(where, where.dshHome);
  ownFolder(where, where.tmp);
  const profileDir = path.join(where.dshHome, 'profiles', PROFILE);
  const scopeDir = path.join(profileDir, 'node_modules', '@deepseek-harness-tui');
  ownFolder(where, scopeDir);
  const body = {
    name: `dsh-profile-${PROFILE}`,
    private: true,
    dependencies: { [TUI_PACKAGE]: TUI_VERSION },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', TUI_PACKAGE] } },
  };
  writeOwnFile(path.join(profileDir, 'package.json'), JSON.stringify(body, null, 2) + '\n');
  writeOwnFile(path.join(where.dshHome, 'cordis.patch.yml'), HOME_PATCH);
  const link = path.join(scopeDir, 'dsh-tui');
  const current = lstatOrNull(link);
  if (current !== null && !current.isSymbolicLink()) throw homeUnsafe();
  if (current !== null && fs.readlinkSync(link) === where.tui) return profileDir;
  // Removes the link itself, never what it points to.
  if (current !== null) fs.unlinkSync(link);
  fs.symlinkSync(where.tui, link, 'dir');
  return profileDir;
}

// The TUI's injection sockets live in ~/.dsh-tui/inject under its HOME. The
// sandbox matches real paths, so the home is resolved first.
function injectDirectory(where) {
  return path.join(fs.realpathSync(where.home), '.dsh-tui', 'inject');
}

function sbplString(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// macOS sandbox rules for the TUI process tree. The last matching rule wins.
// - Outbound: only IPv4 TCP to the egress proxy's loopback port. Everything
//   else is refused: other ports, UDP, IPv6, the DNS resolver's socket and
//   every other Unix socket.
// - Inbound: no listening on any port or Unix socket, so nothing outside the
//   sandbox can connect in. (The TUI's only listening port, the sign-in
//   callback server, is turned off by the home patch in prepareHome.)
// Each refusal reaches the unified log with the session's nonce, where the
// witness records it and the session is stopped. Nothing is killed by the
// kernel, so the record always comes before the stop.
// One refusal is quiet: at every start the TUI opens an injection socket in
// its home, through which any local program could type into the session.
// Refusing it turns that channel off, which the TUI treats as non-fatal.
// The person's own DSH homes stay unreadable even though HOME points elsewhere.
function sandboxProfile({ proxyPort, nonce, injectDir, personHome = os.homedir() }) {
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) throw Error('DSH TUI sandbox: invalid proxy port');
  if (!validNonce(nonce)) throw Error('DSH TUI sandbox: invalid nonce');
  if (typeof injectDir !== 'string' || !path.isAbsolute(injectDir)) throw Error('DSH TUI sandbox: invalid inject folder');
  const recorded = `(with message ${sbplString(nonce)})`;
  const lines = [
    '(version 1)',
    '(allow default)',
    `(deny network-outbound ${recorded})`,
    `(allow network-outbound (remote tcp4 ${sbplString(`localhost:${proxyPort}`)}))`,
    `(deny network-inbound ${recorded})`,
    `(deny network-bind (local unix-socket (subpath ${sbplString(injectDir)})))`,
    `(deny file-read* file-write* (subpath ${sbplString(path.join(personHome, '.dsh'))}) (subpath ${sbplString(path.join(personHome, '.dsh-tui'))}))`,
  ];
  return lines.join('\n');
}

// The witness's canary: one sandboxed process beside the session, with the
// session's profile and Node.js, for as long as the session lasts. For each
// port number the witness writes to its input it connects once to that
// loopback port, which the profile refuses. It exits when its input ends (also
// when NAW itself goes away) or on SIGTERM.
const CANARY_SOURCE = [
  "const net = require('node:net');",
  "let pending = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', chunk => {",
  "  pending += chunk;",
  "  const lines = pending.split('\\n');",
  "  pending = lines.pop();",
  "  for (const line of lines) {",
  "    const socket = net.connect(Number(line), '127.0.0.1');",
  "    socket.on('error', () => {});",
  "    socket.on('connect', () => socket.destroy());",
  "  }",
  "});",
  "process.stdin.on('end', () => process.exit(0));",
].join('\n');

function runCanary(profile, execPath) {
  const child = spawn(SANDBOX_EXEC, ['-p', profile, execPath, '-e', CANARY_SOURCE], { stdio: ['pipe', 'ignore', 'ignore'], env: { PATH: '/usr/bin:/bin' } });
  // A canary that cannot start, or stops, makes the witness refuse or lose
  // the session; the witness also listens for these.
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  return child;
}

// argv and the complete child environment. Nothing from NAW's environment
// passes unless listed here; the key is the only secret and only by value
// in the environment the PTY host hands to the child.
// `execPath`: a system Node.js (^22.19 or >=24). Not Electron: DSH's native
// addon refuses Electron 44.9, and the host entry would then fall back to an
// unpatched `dsh` CLI (which the PATH below cannot find).
// `profile`: the session's sandboxProfile() text.
// `caFile` exists for offline tests only (a fake api.deepseek.com certificate).
function launchSpec({ where, proxyPort, profile, apiKey, execPath, lang = process.env.LANG, caFile = null }) {
  if (typeof apiKey !== 'string' || apiKey === '') throw Error('DSH TUI: no DeepSeek key');
  if (typeof execPath !== 'string' || !path.isAbsolute(execPath)) throw Error('DSH TUI: no Node.js program');
  if (typeof profile !== 'string' || !profile.startsWith('(version 1)')) throw Error('DSH TUI: no sandbox profile');
  const preload = pathToFileURL(path.join(__dirname, 'dsh-tui-preload.mjs')).href;
  const argv = [
    SANDBOX_EXEC,
    '-p',
    profile,
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

// A sandbox refusal as a session record. The target names what was refused
// and which program tried, e.g. "remote:*:443 (curl)".
function sandboxViolation(denial) {
  const what = denial.target || denial.operation;
  return {
    at: Date.now(),
    source: 'sandbox',
    target: `${what} (${denial.process})`,
    operation: denial.operation,
    pid: denial.pid,
  };
}

// The runtime NativeHost hands to the workspace for provider `dsh`: one
// terminal, no conversation channel. Closing the egress proxy, the witness
// and the terminal is all a stop needs. Any refused connection, at the proxy
// or in the sandbox, is recorded and stops the session.
class DshTui extends EventEmitter {
  // `testOnly` ({ route, caFile, execPath }) points an offline test at a fake
  // DeepSeek; NativeHost never passes it.
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
      await inheritRuntime(this.host.dataDir, this.host.dataDir);
      where = verifyRuntime(this.host.dataDir);
    } catch (error) {
      const unsafe = ['Unsafe runtime directory', 'Writable runtime entry', 'Unsafe runtime entry'].includes(error.cause?.message);
      throw Object.assign(uiError(unsafe ? 'error.dsh.runtimeUnsafe' : 'error.dsh.runtimeUnqualified'), { code: 'dsh-runtime-unqualified', cause: error });
    }
    const execPath = this.testOnly.execPath || this.host.binaries?.dsh;
    if (!execPath) throw uiError('error.nativeRuntimeMissing');
    await this.launch(where, execPath);
  }
  // Everything after the runtime check. The sandbox check script calls it
  // with a synthetic runtime; start() always verifies the real one first.
  async launch(where, execPath) {
    prepareHome(where);
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
    const nonce = `naw-dsh-${randomBytes(12).toString('hex')}`;
    const profile = sandboxProfile({ proxyPort: proxy.port, nonce, injectDir: injectDirectory(where) });
    try {
      this.witness = await this.witnessModule.startWitness({
        nonce,
        runCanary: () => runCanary(profile, execPath),
        onDenial: denial => this.blocked(sandboxViolation(denial)),
        onLost: reason => this.witnessLost(reason),
        onGap: gap => this.emit('dshWitnessGap', gap),
      });
    } catch (error) {
      await this.closeGuards();
      // Without the record a refused connection would not stop the session.
      throw Object.assign(uiError('error.dsh.witnessUnavailable'), { code: 'dsh-witness-unavailable', cause: error });
    }
    if (this.stopped || this.violation) {
      await this.closeGuards();
      return;
    }
    const options = { where, proxyPort: proxy.port, profile, apiKey, execPath };
    if (this.testOnly.caFile) options.caFile = this.testOnly.caFile;
    const spec = launchSpec(options);
    this.attach(new this.Terminal(spec.argv, this.record.cwd, spec.env, { isolatedEnv: true }));
  }
  async closeGuards() {
    this.witness?.close();
    await this.proxy?.close().catch(() => {});
  }
  attach(terminal) {
    this.terminal = terminal;
    this.record.nativeId = null;
    terminal.on('data', event => this.emit('terminal', event));
    terminal.on('started', pid => {
      if (this.terminal !== terminal) return;
      const epoch = terminal.journal?.epoch;
      // A NAW terminal-instance identity, never an upstream history/resume ID.
      this.record.nativeId = Number.isSafeInteger(pid) && pid > 1 && typeof epoch === 'string' &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(epoch) ? `naw-dsh:${epoch}` : null;
      this.emit('pid', pid);
      this.emit('state', 'idle');
    });
    terminal.on('closed', result => {
      if (this.terminal !== terminal) return;
      this.record.nativeId = null;
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
  // Every refusal is kept (the newest 200); the first one is reported and
  // stops the session.
  blocked(found) {
    this.violations.push(found);
    if (this.violations.length > MAX_VIOLATIONS) this.violations.shift();
    if (this.violation) return;
    this.violation = found;
    this.emit('activity', ...uiActivity('notice.activity.dshEgressBlocked', { target: found.target }));
    this.terminal?.stop().catch(() => {});
  }
  // The witness can no longer vouch for the record: its log reader ended
  // ('witness-lost') or fresh canary reports ceased / the canary ended
  // ('witness-silent'), so a refusal could have gone unrecorded. The session
  // does not go on without the record.
  witnessLost(reason) {
    if (this.stopped || this.violation) return;
    const target = reason === 'witness-silent' ? 'witness-silent' : 'witness-lost';
    this.violation = { at: Date.now(), source: 'witness', target };
    this.violations.push(this.violation);
    this.emit('activity', ...uiActivity('notice.activity.dshWitnessLost'));
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
      await this.closeGuards();
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
  HOME_PATCH,
  KEYCHAIN_SERVICE,
  KEYCHAIN_ACCOUNT,
  paths,
  installed,
  packageCopies,
  verifyRuntime,
  inheritRuntime,
  prepareHome,
  injectDirectory,
  sandboxProfile,
  runCanary,
  launchSpec,
  readKey,
  DshTui,
};
