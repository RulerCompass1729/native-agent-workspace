'use strict';
// pi TUI sessions without a model, a network or the real Keychain. The real start (sandbox, PTY, fake
// DeepSeek, blocked host, lost witness) is scripts/pi-tui-offline-check.cjs, which needs an installed runtime.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const piTui = require('../pi-tui.cjs');
const installer = require('../../scripts/install-pi-tui.cjs');
const { Workspace } = require('../workspace.cjs');
const { NativeHost } = require('../adapters.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
const NONCE = 'naw-pi-0123456789abcdef';

function temporaryDirectory(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A runtime tree with the pinned package files only.
function fakeRuntime(t, { version = piTui.PI_VERSION, backend = true } = {}) {
  const base = temporaryDirectory(t, 'naw-pi-test-');
  const dataDir = backend ? path.join(base, 'backends', 'abc') : base;
  fs.mkdirSync(dataDir, { recursive: true });
  const where = piTui.paths(dataDir);
  for (const [dir, packageVersion] of [[where.pkg, version], [where.ai, version]]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: packageVersion }));
  }
  fs.mkdirSync(path.dirname(where.cli), { recursive: true });
  fs.writeFileSync(where.cli, '');
  return { base, dataDir, where };
}

test('every backend of one data folder shares one runtime and keeps its own home and sessions', t => {
  const base = temporaryDirectory(t, 'naw-pi-paths-');
  const root = piTui.paths(base);
  const backend = piTui.paths(path.join(base, 'backends', 'abc'));
  assert.equal(root.root, path.join(base, 'pi-tui-runtime', piTui.PI_VERSION));
  assert.equal(backend.root, root.root);
  assert.equal(backend.home, path.join(base, 'backends', 'abc', 'pi-tui', 'home'));
  assert.notEqual(backend.sessionDir, root.sessionDir);
  assert.ok(backend.agentDir.startsWith(backend.home + path.sep) && backend.tmp.startsWith(backend.home + path.sep));
});

test('the runtime is offered only with the pinned versions and refused unless every entry is safe', async t => {
  const { dataDir, where } = fakeRuntime(t);
  assert.equal(piTui.installed(dataDir), true);
  assert.equal((await piTui.verifyRuntime(dataDir)).root, where.root);
  fs.chmodSync(where.cli, 0o666);
  await assert.rejects(piTui.verifyRuntime(dataDir), error => error.code === 'pi-runtime-unsafe' && error.file === where.cli);
  fs.chmodSync(where.cli, 0o644);
  const outside = path.join(where.pkg, 'outside');
  fs.symlinkSync(os.tmpdir(), outside);
  await assert.rejects(piTui.verifyRuntime(dataDir), error => error.code === 'pi-runtime-unsafe' && error.file === outside);
  fs.unlinkSync(outside);
  fs.symlinkSync('package.json', outside);
  await piTui.verifyRuntime(dataDir);
  const other = fakeRuntime(t, { version: '1.6.0' });
  assert.equal(piTui.installed(other.dataDir), false);
  await assert.rejects(piTui.verifyRuntime(other.dataDir), /is not 1\.6\.1/);
});

test('the launch turns pi\'s own network and the person\'s files off and passes exactly the listed environment', () => {
  const where = piTui.paths('/synthetic/data');
  const spec = piTui.launchSpec({ where, sessionId: 'abc-1', proxyPort: 40123, profile: '(version 1)\n', apiKey: 'sk-synthetic', execPath: '/synthetic/node', lang: 'zh_CN.UTF-8' });
  assert.deepEqual(spec.argv.slice(0, 6), ['/usr/bin/sandbox-exec', '-p', '(version 1)\n', '/synthetic/node', '--disable-sigusr1', where.cli]);
  for (const flag of ['--offline', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-extensions', '--no-mcp', '--no-approve']) assert.ok(spec.argv.includes(flag), flag);
  assert.deepEqual(spec.argv.slice(-4), ['--session-dir', where.sessionDir, '--session-id', 'abc-1']);
  assert.ok(!spec.argv.includes('--model'), 'pi chooses its own default model');
  assert.ok(!spec.argv.join(' ').includes('sk-synthetic'));
  assert.deepEqual(Object.keys(spec.env).sort(), ['DEEPSEEK_API_KEY', 'HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'LANG', 'NODE_USE_ENV_PROXY', 'PATH', 'PI_CODING_AGENT_DIR', 'PI_OFFLINE', 'PI_SKIP_VERSION_CHECK', 'PI_TELEMETRY', 'TMPDIR']);
  assert.equal(spec.env.HOME, where.home);
  assert.equal(spec.env.PI_CODING_AGENT_DIR, where.agentDir);
  assert.equal(spec.env.HTTPS_PROXY, 'http://127.0.0.1:40123');
  assert.equal(spec.env.PI_OFFLINE, '1');
  assert.equal(spec.env.PI_TELEMETRY, '0');
  assert.equal(spec.env.DEEPSEEK_API_KEY, 'sk-synthetic');
  const test = piTui.launchSpec({ where, sessionId: 'abc-1', proxyPort: 40123, profile: '(version 1)', apiKey: 'k', execPath: '/n', model: 'deepseek/deepseek-flash', caFile: '/synthetic/ca.pem', lang: 'bad lang;' });
  assert.deepEqual(test.argv.slice(-2), ['--model', 'deepseek/deepseek-flash']);
  assert.equal(test.env.NODE_EXTRA_CA_CERTS, '/synthetic/ca.pem');
  assert.equal(test.env.LANG, 'en_US.UTF-8');
  for (const bad of [{ sessionId: '../x' }, { sessionId: '-x' }, { apiKey: '' }, { execPath: 'node' }, { profile: '' }, { model: 'openai/gpt' }]) {
    assert.throws(() => piTui.launchSpec({ where, sessionId: 'abc', proxyPort: 1, profile: '(version 1)', apiKey: 'k', execPath: '/n', ...bad }));
  }
});

test('the sandbox allows only the proxy port, refuses listening, and keeps the person\'s agent files unreadable', () => {
  const profile = piTui.sandboxProfile({ proxyPort: 40123, nonce: NONCE, personHome: '/synthetic/home' });
  const lines = profile.split('\n');
  assert.equal(lines[0], '(version 1)');
  assert.ok(lines.includes(`(deny network-outbound (with message "${NONCE}"))`));
  assert.ok(lines.includes('(allow network-outbound (remote tcp4 "localhost:40123"))'));
  assert.ok(lines.includes(`(deny network-inbound (with message "${NONCE}"))`));
  const files = lines.find(line => line.startsWith('(deny file-read* file-write*'));
  for (const name of ['.pi', '.claude', '.codex', '.agents', '.dsh', '.dsh-tui']) assert.ok(files.includes(`(subpath "/synthetic/home/${name}")`), name);
  for (const name of ['CLAUDE.md', 'AGENTS.md']) assert.ok(files.includes(`(literal "/synthetic/home/${name}")`), name);
  assert.ok(!files.includes('with message'), 'file refusals are not network violations');
  assert.throws(() => piTui.sandboxProfile({ proxyPort: 0, nonce: NONCE }));
  assert.throws(() => piTui.sandboxProfile({ proxyPort: 1, nonce: 'short' }));
  assert.throws(() => piTui.sandboxProfile({ proxyPort: 1, nonce: NONCE, personHome: 'relative' }));
});

test('the committed install lock names the pinned pi, all from the public registry', () => {
  installer.checkLock();
  assert.throws(() => installer.parseArguments(['--data-dir', 'relative']));
  assert.deepEqual(installer.parseArguments(['--data-dir', '/x', '--offline']), { dataDir: '/x', cache: null, offline: true });
});

class FakeTerminal extends EventEmitter {
  constructor(argv, cwd, env, options) {
    super();
    Object.assign(this, { argv, cwd, env, options, alive: true, stops: 0 });
  }
  async stop() {
    this.stops++;
    this.alive = false;
  }
}

function launched(t, { record = { id: 's', cwd: '/synthetic' }, witnessFails = false, key = async () => 'sk-synthetic' } = {}) {
  const { dataDir } = fakeRuntime(t);
  const guards = { proxyClosed: 0, witnessClosed: 0, egress: null, witness: null };
  const terminals = [];
  class RecordingTerminal extends FakeTerminal {
    constructor(...args) {
      super(...args);
      terminals.push(this);
    }
  }
  const runtime = new piTui.PiTui(record, { dataDir, binaries: { pi: '/synthetic/node' } }, {
    Terminal: RecordingTerminal,
    key,
    egress: { startEgress: async options => { guards.egress = options; return { port: 40123, close: async () => { guards.proxyClosed++; } }; } },
    witness: {
      startWitness: async options => {
        guards.witness = options;
        if (witnessFails) throw Error('no canary report');
        return { close: () => { guards.witnessClosed++; } };
      },
    },
  });
  const events = { states: [], activities: [] };
  runtime.on('state', state => events.states.push(state));
  runtime.on('activity', (text, uiMessage) => events.activities.push(uiMessage));
  return { runtime, dataDir, guards, terminals, events, record };
}

test('a start opens pi\'s session by NAW\'s id in an isolated terminal, with its folders NAW-owned', async t => {
  const { runtime, dataDir, guards, terminals, record } = launched(t, { record: { id: 's', cwd: '/synthetic', nativeId: 'kept-id' } });
  await runtime.start();
  assert.equal(terminals.length, 1);
  const [terminal] = terminals;
  assert.deepEqual(terminal.options, { isolatedEnv: true });
  assert.equal(terminal.cwd, '/synthetic');
  assert.equal(terminal.argv[terminal.argv.indexOf('--session-id') + 1], 'kept-id');
  assert.ok(terminal.argv[2].includes(`(with message "${guards.witness.nonce}")`));
  assert.match(guards.witness.nonce, /^naw-pi-[0-9a-f]{24}$/);
  assert.equal(record.nativeId, 'kept-id');
  for (const dir of ['agentDir', 'tmp', 'sessionDir']) assert.ok(fs.lstatSync(piTui.paths(dataDir)[dir]).isDirectory(), dir);
  const fresh = launched(t);
  await fresh.runtime.start();
  assert.match(fresh.record.nativeId, /^[0-9a-f-]{36}$/, 'a record without an id gets one');
});

test('a refusal or a lost witness stops the session once; without a witness or a key it does not start', async t => {
  const { runtime, guards, terminals, events } = launched(t);
  await runtime.start();
  guards.egress.onViolation({ at: 1, target: 'example.com:443' });
  guards.witness.onDenial({ operation: 'network-outbound', target: 'remote:*:53', process: 'curl', pid: 7 });
  await tick();
  assert.equal(terminals[0].stops, 1);
  assert.deepEqual(events.activities.map(item => item.key), ['notice.activity.dshEgressBlocked']);
  assert.equal(runtime.violations.length, 2);
  const lost = launched(t);
  await lost.runtime.start();
  lost.guards.witness.onLost('witness-silent');
  await tick();
  assert.equal(lost.terminals[0].stops, 1);
  assert.deepEqual(lost.events.activities.map(item => item.key), ['notice.activity.dshWitnessLost']);
  const blind = launched(t, { witnessFails: true });
  await assert.rejects(blind.runtime.start(), error => error.code === 'pi-witness-unavailable' && error.uiMessage.key === 'error.pi.witnessUnavailable');
  assert.equal(blind.terminals.length, 0);
  assert.equal(blind.guards.proxyClosed, 1);
  const keyless = launched(t, { key: async () => { throw Object.assign(Error('no key'), { code: 'pi-key-missing' }); } });
  await assert.rejects(keyless.runtime.start(), error => error.code === 'pi-key-missing');
  assert.equal(keyless.terminals.length, 0);
});

test('the key comes from the DSH Keychain item; a missing one names that item', async () => {
  const dshTui = require('../dsh-tui.cjs');
  const program = path.join(os.tmpdir(), 'naw-pi-no-such-security');
  await assert.rejects(dshTui.readKey({ program, missing: 'error.pi.keyMissing', code: 'pi-key-missing' }), error => error.code === 'pi-key-missing' && error.uiMessage.key === 'error.pi.keyMissing');
  assert.deepEqual([dshTui.KEYCHAIN_SERVICE, dshTui.KEYCHAIN_ACCOUNT], ['NAW DSH TUI DeepSeek API key', 'deepseek']);
  await assert.rejects(dshTui.readKey({ program }), error => error.code === 'dsh-key-missing' && error.uiMessage.key === 'error.dsh.keyMissing');
});

test('an unqualified runtime refuses the start before the key is read', async t => {
  let reads = 0;
  const { dataDir } = fakeRuntime(t, { version: '1.0.0' });
  const runtime = new piTui.PiTui({ id: 's', cwd: '/synthetic' }, { dataDir, binaries: { pi: '/synthetic/node' } }, { Terminal: FakeTerminal, key: async () => { reads++; return 'k'; } });
  await assert.rejects(runtime.start(), error => error.code === 'pi-runtime-unqualified' && error.uiMessage.key === 'error.pi.runtimeUnqualified');
  assert.equal(reads, 0);
  assert.equal(runtime.chatAvailable, false);
  assert.throws(() => runtime.openTerminal(), error => error.code === 'pi-terminal-missing');
});

test('a confirmed exit ends the session; an unconfirmed one is an error', async t => {
  for (const [confirmed, state] of [[true, 'ended'], [false, 'error']]) {
    const { runtime, events } = launched(t);
    const terminal = new FakeTerminal();
    runtime.attach(terminal);
    terminal.emit('started', 4242);
    terminal.emit('closed', { confirmed });
    await tick();
    assert.deepEqual(events.states, ['idle', state]);
  }
});

test('NativeHost offers pi only with an installed runtime and creates the pi runtime for it', t => {
  const dir = temporaryDirectory(t, 'naw-pi-host-');
  const host = new NativeHost(dir, dir);
  t.after(() => host.close());
  assert.equal(host.resolvePrograms().pi, undefined);
  assert.throws(() => host.create({ id: 'a', provider: 'pi', cwd: dir }), error => error.uiMessage?.key === 'error.pi.runtimeUnqualified');
  const { dataDir } = fakeRuntime(t);
  const offered = new NativeHost(dir, dataDir);
  t.after(() => offered.close());
  // The tests themselves run on Node.js from PATH, so it is found.
  const node = offered.resolvePrograms().pi;
  assert.ok(typeof node === 'string' && path.isAbsolute(node), String(node));
  const runtime = offered.create({ id: 'b', provider: 'pi', cwd: dir });
  assert.ok(runtime instanceof piTui.PiTui);
  assert.ok(offered.piTargets.has(runtime));
  runtime.emit('state', 'ended');
  assert.equal(offered.piTargets.has(runtime), false);
});

test('a pi session is terminal-only on DeepSeek, refuses settings and bypass, and keeps its id across a restart', async t => {
  const directory = temporaryDirectory(t, 'naw-pi-workspace-');
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
  const id = await workspace.create('pi', directory, 'owner', undefined, 'chat');
  const record = workspace.get(id);
  assert.equal(record.provider, 'pi');
  assert.equal(record.view, 'terminal');
  assert.equal(record.name, 'pi 1');
  assert.equal(record.modelProvider, 'deepseek');
  assert.match(record.nativeId, /^[0-9a-f-]{36}$/);
  assert.equal(runtimes[0].record.nativeId, record.nativeId, 'the runtime opens pi by the id NAW chose');
  for (const extra of [{ skipPermissions: true }, { settings: {} }]) {
    await assert.rejects(workspace.create('pi', directory, 'owner', 'X', 'terminal', extra), error => error.uiMessage?.key === 'error.workspace.invalidSettings');
  }
  runtimes[0].emit('dshWitnessGap', { at: 1, from: 2, to: 9, missing: 8, elapsedMs: 2000 });
  assert.deepEqual(record.dshWitnessGaps, [{ at: 1, from: 2, to: 9, missing: 8, elapsedMs: 2000 }]);
  workspace.persist();
  workspace.close();
  workspace = new Workspace(host, directory);
  const restored = workspace.get(id);
  assert.equal(restored.nativeId, record.nativeId, 'the same pi session can open again');
  assert.equal(restored.state, 'recoverable');
});
