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
const { PassThrough, Writable } = require('node:stream');
const { pathToFileURL } = require('node:url');
const dshTui = require('../dsh-tui.cjs');
const egress = require('../dsh-egress.cjs');
const witness = require('../dsh-witness.cjs');
const updateOff = require('../dsh-tui-update-off.cjs');
const installer = require('../../scripts/install-dsh-tui.cjs');
const { Workspace } = require('../workspace.cjs');
const { pythonExecutable } = require('../platform.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
const NONCE = 'naw-dsh-0123456789abcdef';
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
  const profile = dshTui.sandboxProfile({ proxyPort: 40123, nonce: NONCE, injectDir: '/synthetic/data/dsh-tui/session-home/.dsh-tui/inject', personHome: '/synthetic/person' });
  const spec = dshTui.launchSpec({
    where,
    proxyPort: 40123,
    profile,
    apiKey: 'sk-synthetic-key',
    execPath: '/usr/local/bin/node',
    lang: 'zh_CN.UTF-8',
  });
  assert.equal(spec.argv[0], '/usr/bin/sandbox-exec');
  assert.equal(spec.argv[1], '-p');
  assert.equal(spec.argv[2], profile);
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
  const unsafe = dshTui.launchSpec({ where, proxyPort: 1, profile, apiKey: 'k', execPath: '/n', lang: 'C; rm -rf /' });
  assert.equal(unsafe.env.LANG, 'en_US.UTF-8');
  const offline = dshTui.launchSpec({ where, proxyPort: 1, profile, apiKey: 'k', execPath: '/n', caFile: '/synthetic/ca.pem' });
  assert.equal(offline.env.NODE_EXTRA_CA_CERTS, '/synthetic/ca.pem');
  assert.throws(() => dshTui.launchSpec({ where, proxyPort: 1, profile, apiKey: '', execPath: '/n' }), /no DeepSeek key/);
  assert.throws(() => dshTui.launchSpec({ where, proxyPort: 1, profile, apiKey: 'k', execPath: 'node' }), /no Node\.js program/);
  assert.throws(() => dshTui.launchSpec({ where, proxyPort: 1, apiKey: 'k', execPath: '/n' }), /no sandbox profile/);
});

// The rules themselves are checked against the real kernel by
// scripts/dsh-tui-sandbox-check.cjs; this pins their text and order.
test('the sandbox records every refusal, allows only IPv4 TCP to the proxy, and refuses listening', () => {
  const injectDir = '/synthetic/session-home/.dsh-tui/inject';
  const profile = dshTui.sandboxProfile({ proxyPort: 40123, nonce: NONCE, injectDir, personHome: '/synthetic/a "b"' }).split('\n');
  const outbound = profile.indexOf(`(deny network-outbound (with message "${NONCE}"))`);
  const proxy = profile.indexOf('(allow network-outbound (remote tcp4 "localhost:40123"))');
  const inbound = profile.indexOf(`(deny network-inbound (with message "${NONCE}"))`);
  const inject = profile.indexOf(`(deny network-bind (local unix-socket (subpath "${injectDir}")))`);
  // The last matching rule wins, so the order is the policy.
  assert.ok(outbound > 0 && proxy > outbound && inbound > proxy && inject > inbound, profile.join('\n'));
  // No rule kills: the witness records the refusal before the session stops.
  assert.ok(!profile.some(line => line.includes('send-signal')));
  assert.ok(!profile.some(line => line.includes('remote ip')), 'no exception that also admits UDP or IPv6');
  const homes = profile.find(line => line.startsWith('(deny file-read* file-write*'));
  assert.ok(homes.includes('(subpath "/synthetic/a \\"b\\"/.dsh")'));
  assert.ok(homes.includes('(subpath "/synthetic/a \\"b\\"/.dsh-tui")'));
  for (const port of [0, 65536, 1.5, '443']) {
    assert.throws(() => dshTui.sandboxProfile({ proxyPort: port, nonce: NONCE, injectDir }), /invalid proxy port/);
  }
  for (const nonce of [undefined, 'short', 'naw-dsh-"quoted"-0123', 'NAW-DSH-UPPER-0123']) {
    assert.throws(() => dshTui.sandboxProfile({ proxyPort: 1, nonce, injectDir }), /invalid nonce/);
  }
  assert.throws(() => dshTui.sandboxProfile({ proxyPort: 1, nonce: NONCE, injectDir: 'relative' }), /invalid inject folder/);
});

// --- witness ------------------------------------------------------------------

class FakeReader extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.signals = [];
  }
  kill(signal) {
    this.signals.push(signal);
    setImmediate(() => this.emit('exit', null, signal));
  }
  // One unified-log event, as `log stream --style ndjson` prints it.
  report(message) {
    this.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), senderImagePath: '/S/Sandbox', eventMessage: `${message}\n${NONCE}` }) + '\n');
  }
}

// The canary process. `ports` are the beats written to its input; it emits
// 'beat' for each. It exits on SIGTERM, unless `stubborn`.
class FakeCanary extends EventEmitter {
  constructor(pid, stubborn = false) {
    super();
    this.pid = pid;
    this.stubborn = stubborn;
    this.signals = [];
    this.ports = [];
    this.inputEnded = false;
    this.stdin = new Writable({
      write: (chunk, encoding, done) => {
        for (const line of String(chunk).split('\n')) {
          if (line === '') continue;
          this.ports.push(Number(line));
          this.emit('beat', Number(line));
        }
        done();
      },
      final: done => {
        this.inputEnded = true;
        done();
      },
    });
  }
  kill(signal) {
    this.signals.push(signal);
    if (!this.stubborn) setImmediate(() => this.emit('exit', null, signal));
    return true;
  }
}

// The kernel's report of each beat, while `answering`.
function answerBeats(reader, canary) {
  const answers = { answering: true };
  canary.on('beat', port => {
    if (!answers.answering) return;
    setImmediate(() => reader.report(`Sandbox: node(${canary.pid}) deny(1) network-outbound remote:*:${port}`));
  });
  return answers;
}

function fakeWitness(options = {}) {
  const reader = new FakeReader();
  const spawned = [];
  const denials = [];
  const reasons = [];
  const canaries = [];
  const runCanary = options.runCanary || (() => {
    const canary = new FakeCanary(901 + canaries.length, options.stubborn === true);
    canaries.push(canary);
    return canary;
  });
  const started = witness.startWitness({
    nonce: NONCE,
    runCanary,
    onDenial: denial => denials.push(denial),
    onLost: reason => reasons.push(reason),
    spawn: (program, args, spawnOptions) => {
      spawned.push({ program, args, spawnOptions });
      return reader;
    },
    armTimeoutMs: options.armTimeoutMs || 2000,
    beatMs: options.beatMs || 10000,
    beatReportMs: options.beatReportMs || 2000,
  });
  return { reader, spawned, denials, canaries, started, reasons, lost: () => reasons.length };
}

// Starts the stream and reports the first beat.
async function armedWitness(options = {}) {
  const run = fakeWitness(options);
  run.reader.stdout.write('Filtering the log data using ...\n');
  await tick();
  const canary = run.canaries[0];
  run.reader.report(`Sandbox: node(${canary.pid}) deny(1) network-outbound remote:*:${canary.ports[0]}`);
  return { ...run, canary, armed: await run.started };
}

test('a denial report is parsed from the first line of the kernel message', () => {
  assert.deepEqual(witness.parseDenial(`Sandbox: node(4242) deny(1) network-outbound /private/var/run/mDNSResponder\n${NONCE}`), {
    process: 'node',
    pid: 4242,
    operation: 'network-outbound',
    target: '/private/var/run/mDNSResponder',
  });
  assert.deepEqual(witness.parseDenial('1 duplicate report for Sandbox: Python Helper(7) deny(1) network-bind local:*:5000'), {
    process: 'Python Helper',
    pid: 7,
    operation: 'network-bind',
    target: 'local:*:5000',
  });
  assert.equal(witness.parseDenial('something else'), null);
  assert.equal(witness.parseDenial(undefined), null);
});

test('the witness arms on its canary’s first beat report and then passes every other refusal on', async () => {
  const run = fakeWitness();
  assert.equal(run.spawned[0].program, '/usr/bin/log');
  assert.deepEqual(run.spawned[0].args.slice(0, 3), ['stream', '--style', 'ndjson']);
  assert.ok(run.spawned[0].args[4].includes(`eventMessage CONTAINS "${NONCE}"`));
  run.reader.stdout.write('Filtering the log data using ...\n');
  await tick();
  assert.equal(run.canaries.length, 1, 'the header starts the canary');
  const canary = run.canaries[0];
  assert.deepEqual(canary.ports, [1], 'and its first beat');
  run.reader.report('Sandbox: curl(55) deny(1) network-outbound remote:*:443');
  run.reader.report(`Sandbox: node(${canary.pid}) deny(1) network-outbound remote:*:1`);
  const armed = await run.started;
  assert.equal(armed.armed, true);
  assert.equal(armed.beats, 1);
  // A report that came before arming is still a refusal.
  assert.deepEqual(run.denials.map(denial => denial.pid), [55]);
  run.reader.report(`1 duplicate report for Sandbox: node(${canary.pid}) deny(1) network-outbound remote:*:1`);
  run.reader.report('Sandbox: python3(66) deny(1) network-bind local:*:8000');
  await tick();
  assert.deepEqual(run.denials.map(denial => denial.pid), [55, 66]);
  assert.equal(armed.beats, 1, 'a repeated report is not another beat');
  armed.close();
  await tick();
  assert.deepEqual(run.reader.signals, ['SIGTERM']);
  assert.deepEqual(canary.signals, ['SIGTERM']);
  assert.equal(canary.inputEnded, true);
  assert.equal(run.lost(), 0, 'closing is not a loss');
  run.reader.report('Sandbox: curl(77) deny(1) network-outbound remote:*:443');
  await tick();
  assert.deepEqual(run.denials.map(denial => denial.pid), [55, 66]);
});

test('without a beat report, or with the reader or the canary gone, the witness refuses to arm', async () => {
  const silent = fakeWitness({ armTimeoutMs: 100, beatMs: 20 });
  silent.reader.stdout.write('Filtering the log data using ...\n');
  await assert.rejects(silent.started, /no canary report/);
  assert.deepEqual(silent.reader.signals, ['SIGTERM']);
  assert.equal(silent.canaries.length, 1, 'one canary, beating');
  assert.ok(silent.canaries[0].ports.length >= 3, JSON.stringify(silent.canaries[0].ports));
  assert.deepEqual(silent.canaries[0].signals, ['SIGTERM']);
  const ended = fakeWitness();
  ended.reader.emit('exit', 1, null);
  await assert.rejects(ended.started, /the log reader ended/);
  const gone = fakeWitness();
  gone.reader.stdout.write('header\n');
  await tick();
  gone.canaries[0].emit('exit', 1, null);
  await assert.rejects(gone.started, /the canary ended/);
  assert.deepEqual(gone.reader.signals, ['SIGTERM']);
  const unstarted = fakeWitness({ runCanary: () => ({ pid: undefined }) });
  unstarted.reader.stdout.write('header\n');
  await assert.rejects(unstarted.started, /the canary did not start/);
  const throwing = fakeWitness({ runCanary: () => { throw Error('no sandbox-exec'); } });
  throwing.reader.stdout.write('header\n');
  await assert.rejects(throwing.started, /no sandbox-exec/);
  assert.throws(() => witness.startWitness({ nonce: 'bad' }), /invalid nonce/);
});

// r4: the log drops reports for about a second roughly once a minute. A beat
// whose report is missing means a refusal could be missing too.
test('a beat report missing after arming loses the witness', async () => {
  const run = fakeWitness({ beatMs: 10, beatReportMs: 60 });
  run.reader.stdout.write('header\n');
  await tick();
  const canary = run.canaries[0];
  const answers = answerBeats(run.reader, canary);
  const armed = await run.started;
  await wait(200);
  assert.equal(run.lost(), 0, 'every beat reported: the witness holds');
  assert.ok(armed.beats >= 8, String(armed.beats));
  const ports = new Set(canary.ports);
  assert.equal(ports.size, canary.ports.length, 'each beat has its own port');
  assert.ok(canary.ports.every(port => port >= 1 && port <= witness.BEAT_PORTS));
  answers.answering = false;
  await wait(200);
  assert.deepEqual(run.reasons, ['witness-silent']);
  assert.equal(armed.armed, false);
  assert.deepEqual(run.reader.signals, ['SIGTERM']);
  assert.deepEqual(canary.signals, ['SIGTERM']);
  const sent = canary.ports.length;
  await wait(50);
  assert.equal(canary.ports.length, sent, 'no beats after the loss');
  run.reader.report('Sandbox: curl(77) deny(1) network-outbound remote:*:443');
  await tick();
  assert.deepEqual(run.denials, [], 'nothing is passed on after the loss');
});

// Seen in the real smoke run: the drop came while arming, and beats still
// unreported then must not count against the session that starts after.
test('beats missing before arming only delay it', async () => {
  const run = fakeWitness({ beatMs: 10, beatReportMs: 40 });
  run.reader.stdout.write('header\n');
  await tick();
  await wait(70);
  const canary = run.canaries[0];
  assert.ok(canary.ports.length >= 4, JSON.stringify(canary.ports));
  answerBeats(run.reader, canary);
  const armed = await run.started;
  await wait(150);
  assert.equal(run.lost(), 0, JSON.stringify(run.reasons));
  assert.ok(armed.beats >= 5, String(armed.beats));
  armed.close();
});

test('the log reader ending after arming loses the witness', async () => {
  const run = await armedWitness();
  run.reader.emit('exit', 0, null);
  run.reader.emit('error', Error('gone'));
  assert.deepEqual(run.reasons, ['witness-lost']);
});

test('the canary ending or refusing beats after arming loses the witness', async () => {
  const exited = await armedWitness();
  exited.canary.emit('exit', 0, null);
  assert.deepEqual(exited.reasons, ['witness-silent']);
  assert.deepEqual(exited.reader.signals, ['SIGTERM']);
  assert.deepEqual(exited.canary.signals, [], 'an ended canary is not signalled');
  const refusing = await armedWitness();
  refusing.canary.stdin.emit('error', Error('EPIPE'));
  assert.deepEqual(refusing.reasons, ['witness-silent']);
  assert.deepEqual(refusing.canary.signals, ['SIGTERM']);
});

// R2-B1: only reports of beats from the canary itself, while it runs, are the
// witness's own. Its end loses the witness, so no later process can reuse
// its PID unrecorded.
test('a refusal is the canary’s own only when it is a beat of the running canary', async () => {
  const run = await armedWitness();
  const pid = run.canary.pid;
  run.reader.report(`Sandbox: node(${pid}) deny(1) network-outbound remote:*:5000`);
  run.reader.report(`Sandbox: node(${pid}) deny(1) network-bind local:*:7`);
  run.reader.report('Sandbox: node(4321) deny(1) network-outbound remote:*:1');
  await tick();
  const seen = run.denials.map(denial => [denial.pid, denial.operation, denial.target]);
  assert.deepEqual(seen, [
    [pid, 'network-outbound', 'remote:*:5000'],
    [pid, 'network-bind', 'local:*:7'],
    [4321, 'network-outbound', 'remote:*:1'],
  ]);
  run.canary.emit('exit', 0, null);
  assert.deepEqual(run.reasons, ['witness-silent']);
});

// R2-B2: SIGTERM, never SIGKILL, even for a canary that outlives it.
test('a canary that outlives SIGTERM gets nothing stronger', async () => {
  const run = await armedWitness({ stubborn: true });
  run.armed.close();
  run.armed.close();
  await wait(50);
  assert.deepEqual(run.canary.signals, ['SIGTERM']);
  assert.deepEqual(run.reader.signals, ['SIGTERM']);
  assert.equal(run.lost(), 0);
});

// The canary program itself, under a profile that allows everything, so the
// connections arrive: one per port written, and an exit when the input ends.
test('the canary connects once to each port it is given and exits when its input ends', { skip: process.platform !== 'darwin' }, async t => {
  let connections = 0;
  const server = net.createServer(socket => {
    connections++;
    socket.on('error', () => {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const child = dshTui.runCanary('(version 1)\n(allow default)', process.execPath);
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  const port = server.address().port;
  child.stdin.write(`${port}\n`);
  child.stdin.write(`${port}\n`);
  for (let index = 0; index < 100 && connections < 2; index++) await wait(50);
  assert.equal(connections, 2);
  child.stdin.end();
  assert.equal(await exited, 0);
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

// The sandbox refuses every listening socket, so the TUI's sign-in callback
// server stays off: the home-level patch outranks the profile's own patch,
// where the TUI's /settings saves, and is restored on every launch.
test('the home patch disables sign-in and title LLM for new and existing homes', t => {
  const { where } = fakeRuntime(t);
  const profileDir = dshTui.prepareHome(where);
  const patch = path.join(where.dshHome, 'cordis.patch.yml');
  assert.equal(fs.readFileSync(patch, 'utf8'), dshTui.HOME_PATCH);
  const rows = dshTui.HOME_PATCH.split('\n').filter(line => line !== '' && !line.startsWith('#'));
  assert.deepEqual(rows, ['- id: dsh-tui-webserver', "  name: '@deepseek-ai/dsh-host-webserver'", '  disabled: true',
    '- id: session-title-llm', '  disabled: true']);
  writeFile(patch, '- id: dsh-tui-webserver\n  disabled: false\n- id: session-title-llm\n  disabled: false\n');
  writeFile(path.join(profileDir, 'cordis.patch.yml'), 'settings saved by the TUI\n');
  const manifest = path.join(profileDir, 'package.json');
  const before = [fs.statSync(patch).ino, fs.statSync(manifest).ino];
  dshTui.prepareHome(where);
  assert.equal(fs.readFileSync(patch, 'utf8'), dshTui.HOME_PATCH);
  assert.match(fs.readFileSync(patch, 'utf8'), /- id: session-title-llm\n  disabled: true/);
  assert.equal(fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8'), 'settings saved by the TUI\n');
  // R2-B3: each file is replaced by a new one, never written in place, and
  // no temporary file is left behind.
  assert.notEqual(fs.statSync(patch).ino, before[0]);
  assert.notEqual(fs.statSync(manifest).ino, before[1]);
  assert.deepEqual(fs.readdirSync(where.dshHome).sort(), ['cordis.patch.yml', 'profiles']);
  assert.deepEqual(fs.readdirSync(profileDir).sort(), ['cordis.patch.yml', 'node_modules', 'package.json']);
});

// A synthetic person folder stands outside the TUI home; a link put in the
// home's place must not let NAW write into it, or delete from it.
// R2-B3: a hard link is a plain file too; it is refused, and the person's
// file it shares stays as it was. So is a folder where a file belongs.
test('a link in the TUI home refuses the launch and nothing outside is written or removed', t => {
  const packageJson = where => path.join(where.dshHome, 'profiles/dsh-tui/package.json');
  const homePatch = where => path.join(where.dshHome, 'cordis.patch.yml');
  const cases = [
    ['home', where => where.home, 'folder link'],
    ['dshHome', where => where.dshHome, 'folder link'],
    ['scope', where => path.join(where.dshHome, 'profiles/dsh-tui/node_modules/@deepseek-harness-tui'), 'folder link'],
    ['tmp', where => where.tmp, 'folder link'],
    ['packageJson', packageJson, 'file link'],
    ['homePatch', homePatch, 'file link'],
    ['packageJson hard link', packageJson, 'hard link'],
    ['homePatch hard link', homePatch, 'hard link'],
    ['packageJson folder', packageJson, 'folder'],
    ['homePatch folder', homePatch, 'folder'],
  ];
  for (const [name, place, kind] of cases) {
    const { where } = fakeRuntime(t);
    const outside = temporaryDirectory(t, 'dsh-person-');
    const keep = path.join(outside, 'keep.txt');
    writeFile(keep, 'person file');
    writeFile(path.join(outside, 'dsh-tui/work.txt'), 'person work');
    const at = place(where);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    if (kind === 'folder link') fs.symlinkSync(outside, at);
    if (kind === 'file link') fs.symlinkSync(keep, at);
    if (kind === 'hard link') fs.linkSync(keep, at);
    if (kind === 'folder') writeFile(path.join(at, 'work.txt'), 'kept');
    assert.throws(() => dshTui.prepareHome(where), error => error.code === 'dsh-home-unsafe' && error.uiMessage.key === 'error.dsh.homeUnsafe', name);
    assert.deepEqual(fs.readdirSync(outside).sort(), ['dsh-tui', 'keep.txt'], name);
    assert.equal(fs.readFileSync(keep, 'utf8'), 'person file', name);
    assert.deepEqual(fs.readdirSync(path.join(outside, 'dsh-tui')), ['work.txt'], name);
    if (kind === 'folder') assert.equal(fs.readFileSync(path.join(at, 'work.txt'), 'utf8'), 'kept', name);
  }
  // A real folder where the TUI link belongs is not removed either.
  const { where } = fakeRuntime(t);
  const link = path.join(dshTui.prepareHome(where), 'node_modules/@deepseek-harness-tui/dsh-tui');
  fs.unlinkSync(link);
  writeFile(path.join(link, 'work.txt'), 'kept');
  assert.throws(() => dshTui.prepareHome(where), error => error.code === 'dsh-home-unsafe');
  assert.equal(fs.readFileSync(path.join(link, 'work.txt'), 'utf8'), 'kept');
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

// launch() with fake guards: what the session does with each refusal. The
// real kernel, log and PTY are scripts/dsh-tui-sandbox-check.cjs.
function launched(t, { witnessFails = false, witnessModule = null } = {}) {
  const { where } = fakeRuntime(t);
  const guards = { proxyClosed: 0, witnessClosed: 0, egress: null, witness: null };
  const fakeEgress = {
    startEgress: async options => {
      guards.egress = options;
      return { port: 40123, close: async () => { guards.proxyClosed++; } };
    },
  };
  const fakeWitnessModule = {
    startWitness: async options => {
      guards.witness = options;
      if (witnessFails) throw Error('DSH witness: no canary report');
      return { close: () => { guards.witnessClosed++; } };
    },
  };
  const terminals = [];
  class RecordingTerminal extends FakeTerminal {
    constructor(argv) {
      super();
      this.argv = argv;
      terminals.push(this);
    }
  }
  const runtime = new dshTui.DshTui({ id: 's', cwd: '/synthetic' }, { dataDir: '/synthetic/none' }, {
    Terminal: RecordingTerminal,
    key: async () => 'sk-synthetic',
    egress: fakeEgress,
    witness: witnessModule || fakeWitnessModule,
  });
  const activities = [];
  runtime.on('activity', (text, uiMessage) => activities.push(uiMessage));
  return { runtime, where, guards, terminals, activities };
}

test('a refusal anywhere in the sandbox is recorded with its program and stops the session', async t => {
  const { runtime, where, guards, terminals, activities } = launched(t);
  await runtime.launch(where, '/synthetic/node');
  assert.equal(terminals.length, 1);
  const profile = terminals[0].argv[2];
  assert.ok(profile.includes(`(with message "${guards.witness.nonce}")`), 'the session profile carries the witness nonce');
  assert.ok(profile.includes(`(subpath "${path.join(fs.realpathSync(where.home), '.dsh-tui/inject')}")`));
  assert.equal(typeof guards.witness.runCanary, 'function');
  guards.witness.onDenial({ process: 'curl', pid: 77, operation: 'network-outbound', target: 'remote:*:443' });
  guards.witness.onDenial({ process: 'node', pid: 78, operation: 'network-outbound', target: '/private/var/run/mDNSResponder' });
  guards.egress.onViolation({ at: 3, target: 'example.com:443' });
  await tick();
  assert.equal(terminals[0].stops, 1);
  assert.deepEqual(activities, [{ version: 1, key: 'notice.activity.dshEgressBlocked', params: { target: 'remote:*:443 (curl)' } }]);
  const sources = runtime.violations.map(found => [found.source, found.pid ?? found.target]);
  assert.deepEqual(sources, [['sandbox', 77], ['sandbox', 78], ['proxy', 'example.com:443']]);
  terminals[0].emit('closed', { confirmed: true });
  await tick();
  assert.equal(guards.witnessClosed, 1);
  assert.equal(guards.proxyClosed, 1);
});

test('a session stops when its witness is lost and does not start without one', async t => {
  const cases = [
    [undefined, 'witness-lost'],
    ['witness-lost', 'witness-lost'],
    ['witness-silent', 'witness-silent'],
    ['something else', 'witness-lost'],
  ];
  for (const [reason, target] of cases) {
    const lost = launched(t);
    await lost.runtime.launch(lost.where, '/synthetic/node');
    lost.guards.witness.onLost(reason);
    await tick();
    assert.equal(lost.terminals[0].stops, 1, String(reason));
    assert.deepEqual(lost.runtime.violations.map(found => [found.source, found.target]), [['witness', target]]);
    assert.deepEqual(lost.activities.map(message => message.key), ['notice.activity.dshWitnessLost']);
  }
  const failing = launched(t, { witnessFails: true });
  await assert.rejects(failing.runtime.launch(failing.where, '/synthetic/node'), error => {
    return error.code === 'dsh-witness-unavailable' && error.uiMessage.key === 'error.dsh.witnessUnavailable';
  });
  assert.equal(failing.terminals.length, 0);
  assert.equal(failing.guards.proxyClosed, 1);
});

test('a witness report gap is forwarded without stopping the session', async t => {
  const { runtime, where, guards, terminals } = launched(t);
  const gaps = [];
  runtime.on('dshWitnessGap', gap => gaps.push(gap));
  await runtime.launch(where, '/synthetic/node');
  const gap = { at: 100, from: 2, to: 9, missing: 8, elapsedMs: 2000 };
  guards.witness.onGap(gap);
  assert.deepEqual(gaps, [gap]);
  assert.equal(terminals[0].stops, 0);
  assert.deepEqual(runtime.violations, []);
  await runtime.stop();
});

// The real witness over a fake log and canary.
function beatingWitness(reader, canary) {
  return {
    startWitness: options => witness.startWitness({ ...options, runCanary: () => canary, spawn: () => reader, beatMs: 10, beatReportMs: 60 }),
  };
}

// End to end: while fresh beat reports arrive the session runs; losing
// report progress past the lease stops it.
test('a session stops when fresh witness reports cease', async t => {
  const reader = new FakeReader();
  const canary = new FakeCanary(901);
  const answers = answerBeats(reader, canary);
  const { runtime, where, terminals, activities } = launched(t, { witnessModule: beatingWitness(reader, canary) });
  reader.stdout.write('header\n');
  await runtime.launch(where, '/synthetic/node');
  assert.equal(terminals.length, 1);
  await wait(150);
  assert.equal(terminals[0].stops, 0, 'beats reported: the session runs');
  answers.answering = false;
  await wait(200);
  assert.equal(terminals[0].stops, 1);
  assert.deepEqual(runtime.violations.map(found => [found.source, found.target]), [['witness', 'witness-silent']]);
  assert.deepEqual(activities.map(message => message.key), ['notice.activity.dshWitnessLost']);
  assert.deepEqual(canary.signals, ['SIGTERM']);
  await runtime.stop();
});

// R2-B1 end to end: a refusal from the canary's PID that is not a beat is
// recorded and stops the session; so does the canary's end.
test('a refusal from the canary’s PID that is not a beat stops the session, and so does its end', async t => {
  const reader = new FakeReader();
  const canary = new FakeCanary(901);
  answerBeats(reader, canary);
  const blocked = launched(t, { witnessModule: beatingWitness(reader, canary) });
  reader.stdout.write('header\n');
  await blocked.runtime.launch(blocked.where, '/synthetic/node');
  reader.report('Sandbox: node(901) deny(1) network-outbound remote:*:5000');
  await wait(30);
  assert.equal(blocked.terminals[0].stops, 1);
  assert.deepEqual(blocked.runtime.violations.map(found => [found.source, found.pid, found.target]), [['sandbox', 901, 'remote:*:5000 (node)']]);
  assert.deepEqual(blocked.activities.map(message => message.key), ['notice.activity.dshEgressBlocked']);
  await blocked.runtime.stop();
  const endReader = new FakeReader();
  const endCanary = new FakeCanary(902);
  answerBeats(endReader, endCanary);
  const ended = launched(t, { witnessModule: beatingWitness(endReader, endCanary) });
  endReader.stdout.write('header\n');
  await ended.runtime.launch(ended.where, '/synthetic/node');
  endCanary.emit('exit', 0, null);
  await tick();
  assert.equal(ended.terminals[0].stops, 1);
  assert.deepEqual(ended.runtime.violations.map(found => [found.source, found.target]), [['witness', 'witness-silent']]);
  await ended.runtime.stop();
});

// F's two r3 counterexamples (R2-B1): one second after the canary ends, curl
// or node with its PID reports a refusal in a beat's form. No time after the
// end is trusted; the end itself stops the session, and the report changes
// nothing.
test('a report from an ended canary’s PID a second later finds the session already stopped', async t => {
  for (const program of ['curl', 'node']) {
    const reader = new FakeReader();
    const canary = new FakeCanary(901);
    answerBeats(reader, canary);
    const run = launched(t, { witnessModule: beatingWitness(reader, canary) });
    reader.stdout.write('header\n');
    await run.runtime.launch(run.where, '/synthetic/node');
    canary.emit('exit', 0, null);
    await tick();
    assert.equal(run.terminals[0].stops, 1, program);
    await wait(1000);
    reader.report(`Sandbox: ${program}(901) deny(1) network-outbound remote:*:1`);
    await wait(30);
    assert.equal(run.terminals[0].stops, 1, program);
    assert.deepEqual(run.runtime.violations.map(found => [found.source, found.target]), [['witness', 'witness-silent']], program);
    await run.runtime.stop();
  }
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
  assert.throws(() => host.create({ id: 'a', provider: 'dsh', cwd: dir }), error => error.uiMessage?.key === 'error.dsh.runtimeUnqualified');
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
  runtimes[0].emit('dshWitnessGap', { at: 1, from: 2, to: 9, missing: 8, elapsedMs: 2000, ignored: 'not stored' });
  runtimes[0].emit('dshWitnessGap', { at: 2, from: 9, to: 2, missing: 8, elapsedMs: 2000 });
  assert.deepEqual(record.dshWitnessGaps, [{ at: 1, from: 2, to: 9, missing: 8, elapsedMs: 2000 }]);
  for (let index = 2; index <= 201; index++) runtimes[0].emit('dshWitnessGap', { at: index, from: index, to: index, missing: 1, elapsedMs: 250 });
  assert.equal(record.dshWitnessGaps.length, 200);
  assert.equal(record.dshWitnessGaps[0].at, 2);
  workspace.persist();
  workspace.close();
  workspace = new Workspace(host, directory);
  assert.equal(workspace.get(id).state, 'ended');
  assert.deepEqual(workspace.get(id).dshWitnessGaps, record.dshWitnessGaps);
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
