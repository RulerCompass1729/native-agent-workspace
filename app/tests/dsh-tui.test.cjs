'use strict';
// DSH TUI sessions without a model, a network or the real Keychain. The real
// TUI start (sandbox, PTY, fake DeepSeek, blocked host) is
// scripts/dsh-tui-offline-check.cjs, which needs an installed runtime.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const dshTui = require('../dsh-tui.cjs');
const egress = require('../dsh-egress.cjs');
const updateOff = require('../dsh-tui-update-off.cjs');
const installer = require('../../scripts/install-dsh-tui.cjs');
const { Workspace } = require('../workspace.cjs');
const { pythonExecutable } = require('../platform.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function temporaryDirectory(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// --- egress proxy ----------------------------------------------------------

function echoServer(t) {
  return new Promise(resolve => {
    const server = net.createServer(socket => socket.pipe(socket));
    server.listen(0, '127.0.0.1', () => resolve(server));
    t.after(() => server.close());
  });
}

// Opens a CONNECT tunnel; resolves with the status line and the socket.
function connect(port, target) {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let answer = '';
    const done = () => resolve({ status: answer.split('\r\n')[0], socket });
    socket.on('data', function first(chunk) {
      answer += chunk;
      if (answer.includes('\r\n\r\n')) {
        socket.off('data', first);
        done();
      }
    });
    socket.on('close', done);
    socket.on('error', done);
  });
}

test('the egress proxy passes api.deepseek.com:443 to its route and records only targets', async t => {
  const upstream = await echoServer(t);
  const proxy = await egress.startEgress({ route: () => ['127.0.0.1', upstream.address().port] });
  t.after(() => proxy.close());
  const tunnel = await connect(proxy.port, 'API.DeepSeek.com:443');
  assert.equal(tunnel.status, 'HTTP/1.1 200 Connection Established');
  const echoed = new Promise(resolve => tunnel.socket.once('data', chunk => resolve(String(chunk))));
  tunnel.socket.write('synthetic payload');
  assert.equal(await echoed, 'synthetic payload');
  tunnel.socket.destroy();
  const records = proxy.records();
  assert.equal(records.length, 1);
  assert.deepEqual(Object.keys(records[0]).sort(), ['at', 'target', 'verdict']);
  assert.equal(records[0].target, 'api.deepseek.com:443');
  assert.equal(records[0].verdict, 'allowed');
  assert.equal(proxy.violated, null);
});

test('another host is refused and reported once, and then nothing passes, open tunnels included', async t => {
  const upstream = await echoServer(t);
  const found = [];
  const proxy = await egress.startEgress({
    route: () => ['127.0.0.1', upstream.address().port],
    onViolation: violation => found.push(violation),
  });
  t.after(() => proxy.close());
  const open = await connect(proxy.port, 'api.deepseek.com:443');
  assert.equal(open.status, 'HTTP/1.1 200 Connection Established');
  const openClosed = new Promise(resolve => open.socket.once('close', resolve));
  const blocked = await connect(proxy.port, 'example.com:443');
  assert.equal(blocked.status, 'HTTP/1.1 403 Forbidden');
  await openClosed;
  assert.equal(found.length, 1);
  assert.equal(found[0].target, 'example.com:443');
  const after = await connect(proxy.port, 'api.deepseek.com:443');
  assert.equal(after.status, 'HTTP/1.1 403 Forbidden');
  const again = await connect(proxy.port, 'example.com:443');
  assert.equal(again.status, 'HTTP/1.1 403 Forbidden');
  assert.equal(found.length, 1, 'one report per session');
  assert.deepEqual(proxy.records().map(record => record.verdict), ['allowed', 'blocked', 'blocked', 'blocked']);
});

test('plain HTTP through the proxy and malformed targets are violations', async t => {
  const found = [];
  const proxy = await egress.startEgress({ onViolation: violation => found.push(violation.target) });
  t.after(() => proxy.close());
  const status = await new Promise(resolve => {
    const socket = net.connect(proxy.port, '127.0.0.1', () => {
      socket.write('GET http://example.com/ HTTP/1.1\r\nHost: example.com:80\r\n\r\n');
    });
    let answer = '';
    socket.on('data', chunk => {
      answer += chunk;
    });
    socket.on('close', () => resolve(answer.split('\r\n')[0]));
  });
  assert.equal(status, 'HTTP/1.1 403 Forbidden');
  assert.deepEqual(found, ['http:example.com:80']);
  assert.equal(egress.normalTarget('api.deepseek.com'), null);
  assert.equal(egress.normalTarget('api.deepseek.com:0'), null);
  assert.equal(egress.normalTarget('api.deepseek.com:70000'), null);
  assert.equal(egress.normalTarget('a b:443'), null);
  assert.equal(egress.normalTarget('API.DEEPSEEK.COM:443'), 'api.deepseek.com:443');
});

// --- the two source patches --------------------------------------------------

test('the update-off patch refuses any other TUI version or update.js source', t => {
  assert.throws(() => updateOff.patchSource(updateOff.ANCHOR, '0.18.1'), /unqualified TUI version/);
  assert.throws(() => updateOff.patchSource(`${updateOff.ANCHOR}  return null;\n}\n`, updateOff.VERSION), /unqualified update\.js source/);
  // install() checks before it registers anything; the real file's positive
  // path is the offline check (no registry.npmjs.org connection).
  const root = temporaryDirectory(t, 'dsh-update-off-');
  const tui = path.join(root, 'node_modules/@deepseek-harness-tui/dsh-tui');
  writeFile(path.join(tui, 'package.json'), JSON.stringify({ version: updateOff.VERSION }));
  writeFile(path.join(tui, 'lib/types/update.js'), `${updateOff.ANCHOR}  return { kind: 'available' };\n}\n`);
  assert.throws(() => updateOff.install({ from: root }), /unqualified update\.js source/);
});

test('the privacy patch resolves the DeepSeek LLM package from the TUI runtime it is given', t => {
  const privacy = require('../butler-dsh-privacy.cjs');
  const real = require.resolve('@deepseek-ai/dsh-llm-deepseek');
  const realPackage = path.join(path.dirname(real), '..');
  const entry = path.relative(realPackage, real);
  const root = temporaryDirectory(t, 'dsh-privacy-from-');
  // A copy whose source differs by one byte: refused, so `from` was read.
  const copy = path.join(root, 'node_modules/@deepseek-ai/dsh-llm-deepseek');
  writeFile(path.join(copy, 'package.json'), fs.readFileSync(path.join(realPackage, 'package.json')));
  writeFile(path.join(copy, entry), fs.readFileSync(real, 'utf8') + '\n');
  assert.throws(() => privacy.install({ from: root }), /unqualified upstream source/);
  const empty = temporaryDirectory(t, 'dsh-privacy-empty-');
  assert.throws(() => privacy.install({ from: empty }), error => error.code === 'MODULE_NOT_FOUND');
});

// --- launch -----------------------------------------------------------------

test('the launch keeps the key out of argv and passes exactly the listed environment', () => {
  const where = dshTui.paths('/synthetic/data');
  const spec = dshTui.launchSpec({
    where,
    proxyPort: 40123,
    apiKey: 'sk-synthetic-key',
    execPath: '/usr/local/bin/node',
    lang: 'zh_CN.UTF-8',
    personHome: '/synthetic/person',
  });
  assert.equal(spec.argv[0], '/usr/bin/sandbox-exec');
  assert.equal(spec.argv[1], '-p');
  assert.deepEqual(spec.argv.slice(3), [
    '/usr/local/bin/node',
    '--disable-sigusr1',
    '--import',
    pathToFileURL(path.join(__dirname, '../dsh-tui-preload.mjs')).href,
    where.hostEntry,
  ]);
  for (const argument of spec.argv) assert.ok(!argument.includes('sk-synthetic-key'));
  assert.deepEqual(Object.keys(spec.env).sort(), [
    'DEEPSEEK_API_KEY',
    'DSH_BUNDLED_SKILL_DIR',
    'DSH_HOME',
    'DSH_TELEMETRY_DISABLED',
    'DSH_TUI_HOST_ENTRY_PATH',
    'DSH_TUI_LAUNCHER_VERSION',
    'DSH_TUI_PROFILE',
    'ELECTRON_RUN_AS_NODE',
    'HOME',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'LANG',
    'NAW_DSH_TUI_ROOT',
    'NODE_COMPILE_CACHE',
    'NODE_USE_ENV_PROXY',
    'PATH',
    'TMPDIR',
  ]);
  assert.equal(spec.env.DEEPSEEK_API_KEY, 'sk-synthetic-key');
  assert.equal(spec.env.DSH_TELEMETRY_DISABLED, '1');
  assert.equal(spec.env.HTTPS_PROXY, 'http://127.0.0.1:40123');
  assert.equal(spec.env.HOME, where.home);
  assert.equal(spec.env.DSH_HOME, where.dshHome);
  assert.equal(spec.env.LANG, 'zh_CN.UTF-8');
  assert.ok(!spec.env.PATH.split(':').some(dir => dir.includes('/usr/local')), 'no other Node.js or dsh on PATH');
  const unsafe = dshTui.launchSpec({ where, proxyPort: 1, apiKey: 'k', execPath: '/n', lang: 'C; rm -rf /' });
  assert.equal(unsafe.env.LANG, 'en_US.UTF-8');
  const offline = dshTui.launchSpec({ where, proxyPort: 1, apiKey: 'k', execPath: '/n', caFile: '/synthetic/ca.pem' });
  assert.equal(offline.env.NODE_EXTRA_CA_CERTS, '/synthetic/ca.pem');
  assert.throws(() => dshTui.launchSpec({ where, proxyPort: 1, apiKey: '', execPath: '/n' }), /no DeepSeek key/);
  assert.throws(() => dshTui.launchSpec({ where, proxyPort: 1, apiKey: 'k', execPath: 'node' }), /no Node\.js program/);
});

test('the sandbox refuses outbound quietly, kills IP connections, allows only the proxy port', () => {
  const profile = dshTui.sandboxProfile({ proxyPort: 40123, personHome: '/synthetic/a "b"' }).split('\n');
  const quiet = profile.indexOf('(deny network-outbound)');
  const kill = profile.indexOf('(deny network-outbound (with send-signal SIGKILL) (remote ip "*:*"))');
  const allow = profile.indexOf('(allow network-outbound (remote ip "localhost:40123"))');
  // The last matching rule wins, so the order is the policy.
  assert.ok(quiet > 0 && kill > quiet && allow > kill, profile.join('\n'));
  const homes = profile.find(line => line.startsWith('(deny file-read* file-write*'));
  assert.ok(homes.includes('(subpath "/synthetic/a \\"b\\"/.dsh")'));
  assert.ok(homes.includes('(subpath "/synthetic/a \\"b\\"/.dsh-tui")'));
  for (const port of [0, 65536, 1.5, '443']) {
    assert.throws(() => dshTui.sandboxProfile({ proxyPort: port }), /invalid proxy port/);
  }
});

// --- runtime checks -----------------------------------------------------------

function fakeRuntime(t, { tuiVersion = dshTui.TUI_VERSION, dshVersion = dshTui.DSH_VERSION, llmCopies = 1 } = {}) {
  const dataDir = temporaryDirectory(t, 'dsh-runtime-');
  const where = dshTui.paths(dataDir);
  writeFile(path.join(where.tui, 'package.json'), JSON.stringify({ version: tuiVersion }));
  writeFile(path.join(where.dsh, 'package.json'), JSON.stringify({ version: dshVersion }));
  writeFile(where.hostEntry, '// synthetic\n');
  const llmHomes = [path.join(where.root, 'node_modules'), path.join(where.dsh, 'node_modules')];
  for (let index = 0; index < llmCopies; index++) {
    const llm = path.join(llmHomes[index], '@deepseek-ai/dsh-llm-deepseek');
    writeFile(path.join(llm, 'package.json'), JSON.stringify({ version: '0.2.1-rc.2' }));
    writeFile(path.join(llm, 'lib/index.js'), '// synthetic\n');
  }
  return { dataDir, where };
}

test('the runtime is offered only with the pinned versions and refused unless every check passes', t => {
  assert.equal(dshTui.installed(temporaryDirectory(t, 'dsh-none-')), false);
  assert.equal(dshTui.installed(fakeRuntime(t, { tuiVersion: '0.18.1' }).dataDir), false);
  const good = fakeRuntime(t);
  assert.equal(dshTui.installed(good.dataDir), true);
  // Synthetic sources: the digest gate refuses them.
  assert.throws(() => dshTui.verifyRuntime(good.dataDir), /unqualified upstream source/);
  assert.throws(() => dshTui.verifyRuntime(fakeRuntime(t, { dshVersion: '0.2.1' }).dataDir), /@deepseek-ai\/dsh is not 0\.2\.1-rc\.2/);
  assert.throws(() => dshTui.verifyRuntime(fakeRuntime(t, { llmCopies: 0 }).dataDir), /expected one dsh-llm-deepseek, found 0/);
  assert.throws(() => dshTui.verifyRuntime(fakeRuntime(t, { llmCopies: 2 }).dataDir), /expected one dsh-llm-deepseek, found 2/);
});

test('the TUI home is NAW-owned: its profile is rewritten and linked to this runtime', t => {
  const { where } = fakeRuntime(t);
  const profileDir = dshTui.prepareHome(where);
  const body = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
  assert.deepEqual(body.dependencies, { [dshTui.TUI_PACKAGE]: dshTui.TUI_VERSION });
  assert.deepEqual(body.dsh.profile.bundles, ['@deepseek-ai/dsh-base', dshTui.TUI_PACKAGE]);
  const link = path.join(profileDir, 'node_modules/@deepseek-harness-tui/dsh-tui');
  assert.equal(fs.readlinkSync(link), where.tui);
  fs.rmSync(link);
  fs.symlinkSync('/synthetic/elsewhere', link, 'dir');
  dshTui.prepareHome(where);
  assert.equal(fs.readlinkSync(link), where.tui);
  assert.equal((fs.statSync(where.home).mode & 0o777), 0o700);
});

test('the key is read from its own Keychain item and a missing item refuses the session', async t => {
  const dir = temporaryDirectory(t, 'dsh-key-');
  const record = path.join(dir, 'arguments.json');
  const found = path.join(dir, 'found.cjs');
  writeFile(found, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write('sk-synthetic\\n');\n`);
  fs.chmodSync(found, 0o700);
  assert.equal(await dshTui.readKey({ program: found }), 'sk-synthetic');
  assert.deepEqual(JSON.parse(fs.readFileSync(record, 'utf8')), [
    'find-generic-password', '-s', 'NAW DSH TUI DeepSeek API key', '-a', 'deepseek', '-w',
  ]);
  const empty = path.join(dir, 'empty.cjs');
  writeFile(empty, `#!${process.execPath}\n`);
  fs.chmodSync(empty, 0o700);
  for (const program of ['/usr/bin/false', empty]) {
    await assert.rejects(dshTui.readKey({ program }), error => {
      return error.code === 'dsh-key-missing' && error.uiMessage.key === 'error.dsh.keyMissing';
    });
  }
});

// --- the session runtime ---------------------------------------------------------

class FakeTerminal extends EventEmitter {
  constructor() {
    super();
    this.alive = true;
    this.stops = 0;
  }
  async stop() {
    this.stops++;
    this.alive = false;
  }
}

function session(options = {}) {
  const host = { dataDir: options.dataDir || '/synthetic/none', binaries: { dsh: '/synthetic/node' } };
  const runtime = new dshTui.DshTui({ id: 's', cwd: '/synthetic' }, host, {
    Terminal: FakeTerminal,
    key: options.key || (async () => 'sk-synthetic'),
  });
  const events = { states: [], activities: [], pids: [] };
  runtime.on('state', state => events.states.push(state));
  runtime.on('activity', (text, uiMessage) => events.activities.push(uiMessage));
  runtime.on('pid', pid => events.pids.push(pid));
  return { runtime, events };
}

test('an unqualified runtime refuses the start before the key is read', async t => {
  let reads = 0;
  const { runtime } = session({ dataDir: fakeRuntime(t).dataDir, key: async () => { reads++; return 'k'; } });
  await assert.rejects(runtime.start(), error => error.code === 'dsh-runtime-unqualified' && error.uiMessage.key === 'error.dsh.runtimeUnqualified');
  assert.equal(reads, 0);
  assert.equal(runtime.chatAvailable, false);
  assert.deepEqual(await runtime.interrupt(), { interrupted: false });
  assert.throws(() => runtime.openTerminal(), error => error.code === 'dsh-terminal-missing');
});

test('a confirmed exit ends the session; an unconfirmed one is an error, as for Claude', async () => {
  for (const [confirmed, state] of [[true, 'ended'], [false, 'error']]) {
    const { runtime, events } = session();
    let proxyClosed = 0;
    runtime.proxy = { close: async () => { proxyClosed++; } };
    const terminal = new FakeTerminal();
    runtime.attach(terminal);
    assert.equal(runtime.openTerminal(), terminal);
    terminal.emit('started', 4242);
    terminal.emit('closed', { confirmed });
    await tick();
    assert.deepEqual(events.pids, [4242]);
    assert.deepEqual(events.states, ['idle', state]);
    assert.equal(proxyClosed, 1);
    const keys = events.activities.map(message => message.key);
    assert.deepEqual(keys, confirmed ? [] : ['notice.activity.terminalDisconnectedExitUnconfirmed']);
  }
});

test('a blocked connection reports its target once and stops the terminal', async () => {
  const { runtime, events } = session();
  const terminal = new FakeTerminal();
  runtime.attach(terminal);
  runtime.blocked({ at: 1, target: 'example.com:443' });
  runtime.blocked({ at: 2, target: 'other.example:443' });
  await tick();
  assert.equal(terminal.stops, 1);
  assert.deepEqual(events.activities, [{ version: 1, key: 'notice.activity.dshEgressBlocked', params: { target: 'example.com:443' } }]);
  let proxyClosed = 0;
  runtime.proxy = { close: async () => { proxyClosed++; } };
  terminal.alive = true;
  assert.deepEqual(await runtime.stop(), { state: 'ended' });
  assert.equal(terminal.stops, 2);
  assert.equal(proxyClosed, 1);
});

// --- PTY environment ------------------------------------------------------------

test('an isolated terminal child gets only its listed environment, not NAW’s', async t => {
  assert.ok(pythonExecutable(), 'A real Python runtime is required');
  const { Terminal } = require('../adapters.cjs');
  const dir = temporaryDirectory(t, 'dsh-env-');
  process.env.NAW_SYNTHETIC_PARENT_ONLY = 'parent';
  t.after(() => delete process.env.NAW_SYNTHETIC_PARENT_ONLY);
  const run = async (isolated, file) => {
    const script = `import json,os,sys\nopen(sys.argv[1],'w').write(json.dumps(sorted(os.environ)))\n`;
    const options = isolated ? { isolatedEnv: true } : {};
    const terminal = new Terminal([pythonExecutable(), '-c', script, file], dir, { NAW_SYNTHETIC_LISTED: '1' }, options);
    for (let index = 0; index < 200 && terminal.alive; index++) await wait(25);
    assert.equal(terminal.alive, false);
    assert.equal(terminal.nativeExited, true);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  const isolated = await run(true, path.join(dir, 'isolated.json'));
  const inherited = await run(false, path.join(dir, 'inherited.json'));
  assert.ok(inherited.includes('NAW_SYNTHETIC_PARENT_ONLY'));
  assert.ok(!isolated.includes('NAW_SYNTHETIC_PARENT_ONLY'));
  assert.ok(!isolated.includes('PATH'));
  for (const name of ['COLORTERM', 'NAW_SYNTHETIC_LISTED', 'PWD', 'TERM']) assert.ok(isolated.includes(name), name);
});

// --- service wiring --------------------------------------------------------------

test('NativeHost offers dsh only with an installed runtime and creates the DSH runtime for it', t => {
  const { NativeHost } = require('../adapters.cjs');
  const dir = temporaryDirectory(t, 'dsh-host-');
  const host = new NativeHost(dir, dir);
  t.after(() => host.close());
  assert.equal(host.resolvePrograms().dsh, undefined);
  assert.throws(() => host.create({ id: 'a', provider: 'dsh', cwd: dir }), error => error.uiMessage?.key === 'error.nativeRuntimeMissing');
  const { dataDir } = fakeRuntime(t);
  const offered = new NativeHost(dir, dataDir);
  t.after(() => offered.close());
  // The tests themselves run on Node.js from PATH, so it is found.
  const node = offered.resolvePrograms().dsh;
  assert.ok(typeof node === 'string' && path.isAbsolute(node), String(node));
  const runtime = offered.create({ id: 'b', provider: 'dsh', cwd: dir });
  assert.ok(runtime instanceof dshTui.DshTui);
  assert.ok(offered.dshTargets.has(runtime));
  runtime.emit('state', 'ended');
  assert.equal(offered.dshTargets.has(runtime), false);
});

test('a DSH session is terminal-only, keeps DSH approvals and its route, and is ended after a restart', async t => {
  const directory = temporaryDirectory(t, 'dsh-workspace-');
  const runtimes = [];
  const host = {
    binaries: {},
    close() {},
    create(record) {
      const runtime = new EventEmitter();
      runtime.record = record;
      runtime.start = async () => runtime.emit('state', 'idle');
      runtime.stop = async () => ({ state: 'ended' });
      runtimes.push(runtime);
      return runtime;
    },
  };
  let workspace = new Workspace(host, directory);
  t.after(() => workspace.close());
  const id = await workspace.create('dsh', directory, 'owner', undefined, 'chat');
  const record = workspace.get(id);
  assert.equal(record.provider, 'dsh');
  assert.equal(record.view, 'terminal');
  assert.equal(record.name, 'DSH 1');
  assert.equal(record.modelProvider, 'deepseek');
  assert.equal(record.nativeId, null);
  assert.equal(record.skipPermissions, undefined);
  for (const extra of [{ skipPermissions: true }, { settings: {} }]) {
    await assert.rejects(workspace.create('dsh', directory, 'owner', 'X', 'terminal', extra), error => error.uiMessage?.key === 'error.workspace.invalidSettings');
  }
  workspace.persist();
  workspace.close();
  workspace = new Workspace(host, directory);
  assert.equal(workspace.get(id).state, 'ended');
});

// --- installer ---------------------------------------------------------------------

test('the committed install lock names the pinned packages, all from the public registry', () => {
  assert.doesNotThrow(() => installer.checkLock());
  const lock = JSON.parse(fs.readFileSync(path.join(installer.SOURCE, 'package-lock.json'), 'utf8'));
  const tui = lock.packages[`node_modules/${dshTui.TUI_PACKAGE}`];
  assert.equal(tui.integrity, dshTui.TUI_INTEGRITY);
  assert.equal(tui.resolved, 'https://registry.npmjs.org/@deepseek-harness-tui/dsh-tui/-/dsh-tui-0.18.0.tgz');
  const text = fs.readFileSync(path.join(installer.SOURCE, 'package-lock.json'), 'utf8');
  assert.ok(!text.includes('/Users/') && !text.includes('/private/') && !text.includes('file:'), 'no local paths');
  assert.ok(!text.includes('"workspace:'), 'npm ci refuses workspace: specs');
  assert.throws(() => installer.parseArguments(['--data-dir', 'relative']), /absolute/);
  assert.throws(() => installer.parseArguments(['--data-dir', '/a', '--unknown']), /unknown argument/);
  assert.deepEqual(installer.parseArguments(['--data-dir', '/a', '--offline']), { dataDir: '/a', cache: null, offline: true });
});
