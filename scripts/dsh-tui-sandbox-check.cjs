#!/usr/bin/env node
'use strict';
// Real-kernel check of the DSH TUI sandbox and of what a session does with a
// refused connection. No DSH runtime, no model, no key and no network beyond
// loopback: the "TUI" is a stand-in program in a synthetic session home.
//   node scripts/dsh-tui-sandbox-check.cjs [--hold-only] [--dsh-tui <absolute path to dsh-tui.cjs>]
// `--dsh-tui` runs the same checks against another commit's module (the red
// run); the default is this checkout's.
// 1. Rules. Each fixture is its own sandboxed process under the session
//    profile; the check's own log reader, not the app's witness, collects
//    the reports carrying the session nonce.
//    - IPv4 TCP to the proxy's port connects, without a report.
//    - UDP and IPv6 to the same port, listening for an outside connection,
//      a DNS lookup, a spawned helper's direct connection and a Unix-socket
//      listener are refused, and each refusal is reported.
//    - The TUI's injection socket is refused without a report.
//    - Outside the sandbox `localhost` resolves (the DNS control).
// 2. Sessions. The stand-in runs as the TUI root in NAW's PTY with the real
//    egress proxy and witness.
//    - The normal path (the injection socket at mount, pipes, IPC, a worker,
//      a tunnel through the proxy) runs without a refusal while the witness's
//      canary beats beside it.
//    - Each forbidden path stops the session by itself with a sandbox record.
//    - An idle session survives five minutes of ordinary report gaps; then
//      withholding its reader's output loses the lease and stops it (hold).
//    - After a stop nothing passes, through the proxy or directly, and no
//      canary is left.
// The log drops reports: for programs that are not Apple's, Node.js among
// them, about a second of reports goes missing roughly once a minute
// (dsh-witness.cjs). So the check keeps its own heartbeat, a canary refused
// every HEARTBEAT_MS. A fixture during which a beat went unseen runs again,
// and so does a session the app's witness stopped at a missing beat, at most
// ATTEMPTS times in all. A rule or path no attempt could check fails.
// Needs macOS sandbox-exec and `log stream` (an administrator account).
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const dns = require('node:dns');
const path = require('node:path');
const dgram = require('node:dgram');
const { randomBytes } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { Terminal } = require('../app/adapters.cjs');

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const FAKE_KEY = 'sk-naw-sandbox-check-not-a-key';
const SETTLE_MS = 800;
const HEARTBEAT_MS = 250;
// A beat's report reached a reader within 8 ms in 631 measured beats.
const HEARTBEAT_LATE_MS = 500;
const ATTEMPTS = 3;
const HOLD_SECONDS = 300;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  const suffix = detail ? ` — ${detail}` : '';
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${suffix}`);
}

function parseArguments(argv) {
  const holdOnly = argv.includes('--hold-only');
  argv = argv.filter(arg => arg !== '--hold-only');
  if (argv.length === 0) return { module: path.join(__dirname, '../app/dsh-tui.cjs'), holdOnly };
  if (argv.length === 2 && argv[0] === '--dsh-tui' && path.isAbsolute(argv[1])) return { module: argv[1], holdOnly };
  throw Error('usage: dsh-tui-sandbox-check.cjs [--hold-only] [--dsh-tui <absolute path to dsh-tui.cjs>]');
}

async function waitFor(condition, seconds) {
  for (let index = 0; index < seconds * 10; index++) {
    if (condition()) return true;
    await wait(100);
  }
  return condition();
}

// --- the check's own report reader ------------------------------------------

// The log's "2026-11-17 23:59:21.485450-0800" as milliseconds since the epoch.
function logTime(stamp) {
  const iso = String(stamp)
    .replace(' ', 'T')
    .replace(/(\.\d{3})\d*/, '$1')
    .replace(/([+-]\d\d)(\d\d)$/, '$1:$2');
  return Date.parse(iso);
}

// Every sandbox report whose message contains `text`: a nonce, or the
// prefix all session nonces share.
function startReader(text) {
  const reports = [];
  const predicate = `senderImagePath ENDSWITH "/Sandbox" AND eventMessage CONTAINS "${text}"`;
  const reader = spawn('/usr/bin/log', ['stream', '--style', 'ndjson', '--predicate', predicate], { stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise(resolve => { reader.once('exit', resolve); reader.once('error', resolve); });
  let pending = '';
  reader.stdout.setEncoding('utf8');
  reader.stdout.on('data', chunk => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('{')) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const full = String(event.eventMessage || '');
      const match = /\((\d+)\) deny\(\d+\) (.*)$/.exec(full.split('\n')[0]);
      if (!match) continue;
      reports.push({
        pid: Number(match[1]),
        text: match[2],
        at: logTime(event.timestamp),
        seenAt: Date.now(),
        full,
      });
    }
  });
  return {
    reports,
    forPid: pid => reports.filter(report => report.pid === pid).map(report => report.text),
    close: async () => { reader.kill('SIGTERM'); await exited; },
  };
}

// A sandboxed Node.js process; `-e` code reads its arguments from argv[1...].
function sandboxed(profile, code, args, cwd) {
  const child = spawn(SANDBOX_EXEC, ['-p', profile, process.execPath, '-e', code, ...args.map(String)], {
    cwd,
    env: { PATH: '/usr/bin:/bin', HOME: cwd, TMPDIR: cwd },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let out = '';
  child.stdout.on('data', chunk => {
    out += chunk;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  const done = new Promise(resolve => {
    child.on('exit', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, out: out.trim() });
    });
  });
  return { pid: child.pid, output: () => out, done };
}

async function runFixture(reader, profile, code, args, cwd) {
  const run = sandboxed(profile, code, args, cwd);
  const result = await run.done;
  await wait(SETTLE_MS);
  return { ...result, pid: run.pid, reports: reader.forPid(run.pid) };
}

// The check's own heartbeat, like the app witness's (dsh-witness.cjs): a
// canary under a minimal profile carrying the nonce connects to the next
// loopback port every HEARTBEAT_MS, and the reader should see each refusal.
// A beat the reader does not see means the log dropped reports then.
function startHeartbeat(reader, nonce, cwd) {
  const profile = `(version 1)\n(allow default)\n(deny network-outbound (with message "${nonce}"))`;
  const child = spawn(SANDBOX_EXEC, ['-p', profile, process.execPath, '-e', CODE.beat], {
    cwd,
    env: { PATH: '/usr/bin:/bin', HOME: cwd, TMPDIR: cwd },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  const sent = [];
  let port = 0;
  const timer = setInterval(() => {
    if (exited) return;
    port = (port % 999) + 1;
    sent.push({ port, at: Date.now() });
    child.stdin.write(`${port}\n`);
  }, HEARTBEAT_MS);
  const seen = beat => reader.reports.some(report => {
    if (report.pid !== child.pid) return false;
    if (!report.text.startsWith('network-outbound ')) return false;
    if (!report.text.endsWith(`:${beat.port}`)) return false;
    return report.seenAt >= beat.at && report.seenAt - beat.at <= HEARTBEAT_LATE_MS;
  });
  return {
    get alive() {
      return !exited;
    },
    armed: () => waitFor(() => sent.some(seen), 10),
    // Whether the log may have dropped reports between `from` and `to`: a
    // beat sent within one interval of that time went unseen, or none was
    // sent. A drop of at least one interval always takes such a beat.
    async missedBetween(from, to) {
      const last = to + HEARTBEAT_MS;
      const due = last + HEARTBEAT_LATE_MS - Date.now();
      if (due > 0) await wait(due);
      const beats = sent.filter(beat => beat.at >= from - HEARTBEAT_MS && beat.at <= last);
      if (exited || beats.length === 0) return true;
      return !beats.every(seen);
    },
    close() {
      clearInterval(timer);
      if (exited) return;
      child.stdin.end();
      child.kill('SIGTERM');
    },
  };
}

// Runs one fixture. When the heartbeat shows the log may have dropped
// reports during the run, what it reported proves nothing either way, so it
// runs again, at most ATTEMPTS times in all. `pids` lists every attempt's
// process; `dropped` stays true when every attempt was hit.
async function clear(heartbeat, name, attempt) {
  const pids = [];
  let result = null;
  for (let index = 1; index <= ATTEMPTS; index++) {
    const from = Date.now();
    result = await attempt();
    pids.push(result.pid);
    const dropped = await heartbeat.missedBetween(from, Date.now());
    if (!dropped) return { ...result, pids, dropped: false };
    console.log(`NOTE ${name}: the log may have dropped reports during attempt ${index}`);
  }
  return { ...result, pids, dropped: true };
}

// --- outside listeners -------------------------------------------------------

function tcpListener(host, port = 0) {
  return new Promise(resolve => {
    const received = [];
    const server = net.createServer(socket => {
      socket.on('data', chunk => received.push(String(chunk)));
      socket.on('error', () => {});
    });
    server.listen(port, host, () => resolve({ server, port: server.address().port, received }));
  });
}

function echoServer() {
  return new Promise(resolve => {
    const state = { connections: 0 };
    const server = net.createServer(socket => {
      state.connections++;
      socket.on('error', () => {});
      socket.pipe(socket);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state }));
  });
}

function udpListener(port) {
  return new Promise(resolve => {
    const received = [];
    const socket = dgram.createSocket('udp4');
    socket.on('message', message => received.push(String(message)));
    socket.bind(port, '127.0.0.1', () => resolve({ socket, received }));
  });
}

function freePort() {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function connectThrough(port, target) {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let answer = '';
    socket.on('data', chunk => {
      answer += chunk;
    });
    socket.on('close', () => resolve(answer.split('\r\n')[0]));
    socket.on('error', error => resolve(answer.split('\r\n')[0] || error.code));
  });
}

function knock(port) {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write('HELLO'));
    let text = '';
    socket.on('data', chunk => {
      text += chunk;
    });
    socket.on('close', () => resolve(text));
    socket.on('error', error => resolve(`error ${error.code}`));
  });
}

// --- 1. rules ------------------------------------------------------------------

const CODE = {
  canary: "require('node:net').connect(1, '127.0.0.1').on('error', error => console.log(error.code))",
  // The heartbeat: one connection per port number read from its input.
  beat: "let pending = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { pending += chunk; const lines = pending.split('\\n'); pending = lines.pop(); for (const line of lines) { const socket = require('node:net').connect(Number(line), '127.0.0.1'); socket.on('error', () => {}); socket.on('connect', () => socket.destroy()); } }); process.stdin.on('end', () => process.exit(0))",
  tcp4: "const s = require('node:net').connect(Number(process.argv[1]), '127.0.0.1', () => s.write('PING')); s.on('data', data => { console.log(String(data)); s.destroy(); }); s.on('error', error => console.log('error ' + error.code))",
  udp: "const s = require('node:dgram').createSocket('udp4'); s.send('SYNTHETIC_REVIEW_CANARY', Number(process.argv[1]), '127.0.0.1', error => { console.log(error ? 'error ' + error.code : 'sent'); s.close(); })",
  ipv6: "const s = require('node:net').connect(Number(process.argv[1]), '::1', () => { s.end('SYNTHETIC_IPV6_CANARY'); console.log('connected'); }); s.on('error', error => console.log('error ' + error.code))",
  listen: "const server = require('node:net').createServer(c => c.end('SYNTHETIC_ACCEPTED_CANARY')); server.on('error', error => { console.log('error ' + error.code); process.exit(0); }); server.listen(Number(process.argv[1]), '127.0.0.1', () => console.log('LISTENING')); setTimeout(() => process.exit(0), 2500)",
  unix: "const server = require('node:net').createServer(); server.on('error', error => { console.log('error ' + error.code); process.exit(0); }); server.listen(process.argv[1], () => { console.log('LISTENING'); setTimeout(() => process.exit(0), 1000); })",
  dns: "require('node:dns').lookup('api.deepseek.com', error => console.log(error ? 'error ' + error.code : 'resolved'))",
  helper: "const { spawn } = require('node:child_process'); const code = \"require('node:net').connect(Number(process.argv[1]), '127.0.0.1').on('connect', () => process.exit(11)).on('error', () => process.exit(12))\"; const h = spawn(process.execPath, ['-e', code, process.argv[1]], { stdio: 'ignore' }); h.on('exit', (code, signal) => console.log(JSON.stringify({ helper: h.pid, code, signal })))",
};

async function checkRules(dshTui, work) {
  const nonce = `naw-dsh-${randomBytes(12).toString('hex')}`;
  const reader = startReader(nonce);
  const cwd = fs.mkdtempSync(path.join(work, 'rules-'));
  const injectDir = path.join(cwd, 'home/.dsh-tui/inject');
  const otherDir = path.join(cwd, 'other');
  fs.mkdirSync(injectDir, { recursive: true });
  fs.mkdirSync(otherDir, { recursive: true });
  const heartbeat = startHeartbeat(reader, nonce, cwd);
  try {
    const live = await heartbeat.armed();
    check('reader: the check sees its heartbeat reports carrying the nonce', live);
    if (!live) return;
    const proxy = await echoServer();
    const profile = dshTui.sandboxProfile({ proxyPort: proxy.port, nonce, injectDir, personHome: path.join(cwd, 'person') });
    const fixture = (code, args, dir = cwd) => () => runFixture(reader, profile, code, args, dir);
    const quiet = run => run.pids.every(pid => reader.forPid(pid).length === 0);

    const canary = await clear(heartbeat, 'canary', fixture(CODE.canary, []));
    check('rules: a refused connection is reported with the session nonce', !canary.dropped && canary.reports.length > 0, JSON.stringify(canary));

    const tcp4 = await clear(heartbeat, 'tcp4', fixture(CODE.tcp4, [proxy.port]));
    check('rules: IPv4 TCP to the proxy port connects without a report', !tcp4.dropped && tcp4.out === 'PING' && quiet(tcp4), JSON.stringify(tcp4));

    // F's udp-bypass, ipv6-bypass and inbound-bypass. The listeners stay up
    // across attempts, so anything that crosses in any attempt is counted.
    const udp = await udpListener(proxy.port);
    const udpRun = await clear(heartbeat, 'udp', fixture(CODE.udp, [proxy.port]));
    udp.socket.close();
    check('rules: UDP to the proxy port is refused and reported', !udpRun.dropped && udp.received.length === 0 && udpRun.reports.length > 0, JSON.stringify({ received: udp.received, ...udpRun }));

    const v6 = await tcpListener('::1', proxy.port);
    const v6Run = await clear(heartbeat, 'ipv6', fixture(CODE.ipv6, [proxy.port]));
    v6.server.close();
    check('rules: IPv6 TCP to the proxy port is refused and reported', !v6Run.dropped && v6.received.length === 0 && v6Run.reports.length > 0, JSON.stringify({ received: v6.received, ...v6Run }));

    const inboundPort = await freePort();
    const answers = [];
    const listenRun = await clear(heartbeat, 'listen', async () => {
      const run = sandboxed(profile, CODE.listen, [inboundPort], cwd);
      await wait(SETTLE_MS);
      answers.push(await knock(inboundPort));
      const listened = await run.done;
      await wait(SETTLE_MS);
      return { pid: run.pid, out: listened.out, reports: reader.forPid(run.pid) };
    });
    const accepted = answers.some(answer => answer.includes('SYNTHETIC_ACCEPTED_CANARY'));
    check('rules: listening for an outside connection is refused and reported', !listenRun.dropped && !accepted && listenRun.reports.length > 0, JSON.stringify({ answers, ...listenRun }));

    // F's stop-policy-probe: DNS in the root, then a helper connects elsewhere.
    const dnsRun = await clear(heartbeat, 'dns', fixture(CODE.dns, []));
    check('rules: a DNS lookup is refused and reported', !dnsRun.dropped && dnsRun.out.startsWith('error') && dnsRun.reports.length > 0, JSON.stringify(dnsRun));
    const elsewhere = await tcpListener('127.0.0.1');
    const helperRun = await clear(heartbeat, 'helper', async () => {
      const run = await runFixture(reader, profile, CODE.helper, [elsewhere.port], cwd);
      let helper = {};
      try {
        helper = JSON.parse(run.out);
      } catch {
        helper = {};
      }
      const reports = Number.isInteger(helper.helper) ? reader.forPid(helper.helper) : [];
      return { pid: run.pid, helper, reports };
    });
    elsewhere.server.close();
    check('rules: a helper process connecting directly is refused and reported', !helperRun.dropped && elsewhere.received.length === 0 && helperRun.reports.length > 0, JSON.stringify({ received: elsewhere.received, ...helperRun }));

    const localhost = await new Promise(resolve => dns.lookup('localhost', { family: 4 }, (error, address) => resolve(error ? error.code : address)));
    check('rules: outside the sandbox localhost resolves (DNS control)', localhost === '127.0.0.1', localhost);

    const inject = await clear(heartbeat, 'inject', fixture(CODE.unix, ['s.sock'], injectDir));
    check('rules: the TUI injection socket is refused without a report', !inject.dropped && inject.out.startsWith('error') && quiet(inject), JSON.stringify(inject));
    const other = await clear(heartbeat, 'other-unix', fixture(CODE.unix, ['o.sock'], otherDir));
    check('rules: any other Unix-socket listener is refused and reported', !other.dropped && other.out.startsWith('error') && other.reports.length > 0, JSON.stringify(other));
    proxy.server.close();
    check('rules: the check\'s heartbeat ran throughout', heartbeat.alive);
  } finally {
    heartbeat.close();
    await reader.close();
  }
}

// --- 2. sessions -----------------------------------------------------------------

const STAND_IN = String.raw`'use strict';
// Stand-in for the DSH TUI root, run by the sandbox check inside the session.
// In 'hold' mode it only waits.
const fs = require('node:fs');
const net = require('node:net');
const dns = require('node:dns');
const path = require('node:path');
const dgram = require('node:dgram');
const { spawn, fork } = require('node:child_process');
const { Worker } = require('node:worker_threads');

// Absolute: the injection probe changes the working folder.
const OUT = path.resolve('out.txt');

function say(text) {
  fs.appendFileSync(OUT, text + '\n');
}

function until(file) {
  return new Promise(resolve => {
    const timer = setInterval(() => {
      if (!fs.existsSync(file)) return;
      clearInterval(timer);
      resolve();
    }, 50);
  });
}

async function normal(proxyPort) {
  // The TUI's injection channel at mount: refused, and the session goes on.
  const injectDir = path.join(process.env.HOME, '.dsh-tui', 'inject');
  fs.mkdirSync(injectDir, { recursive: true });
  const here = process.cwd();
  process.chdir(injectDir);
  await new Promise(done => {
    const server = net.createServer();
    server.on('error', error => {
      say('INJECT ' + error.code);
      done();
    });
    server.listen('s.sock', () => {
      say('INJECT LISTENING');
      done();
    });
  });
  process.chdir(here);
  const echo = await new Promise(done => {
    const child = spawn('/bin/echo', ['pipes'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', chunk => {
      out += chunk;
    });
    child.on('exit', () => done(out.trim()));
  });
  const ipc = await new Promise(done => {
    const child = fork(__filename, ['ipc-child'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.on('message', done);
    child.send('ipc');
  });
  const worker = await new Promise(done => {
    new Worker("require('node:worker_threads').parentPort.postMessage('worker')", { eval: true }).once('message', done);
  });
  say('WORKLOAD ' + [echo, ipc, worker].join(','));
  const socket = net.connect(proxyPort, '127.0.0.1', () => {
    socket.write('CONNECT api.deepseek.com:443 HTTP/1.1\r\nHost: api.deepseek.com:443\r\n\r\n');
  });
  let established = false;
  socket.on('data', chunk => {
    const text = String(chunk);
    if (!established) {
      established = text.startsWith('HTTP/1.1 200');
      say('PROXY ' + text.split('\r\n')[0]);
      if (established) socket.write('PING');
      return;
    }
    if (text.includes('PING')) say('TUNNEL PING');
  });
  socket.on('error', error => say('PROXY ' + error.code));
}

async function main() {
  if (process.argv[2] === 'ipc-child') {
    process.on('message', message => {
      process.send(message);
      process.exit(0);
    });
    return;
  }
  setInterval(() => {}, 1000);
  const mode = fs.readFileSync('mode.txt', 'utf8').trim();
  const target = Number(fs.readFileSync('target.txt', 'utf8'));
  const proxyPort = Number(new URL(process.env.HTTPS_PROXY).port);
  say('READY ' + mode);
  await until('go');
  if (mode === 'normal') await normal(proxyPort);
  if (mode === 'child') {
    const code = "require('node:net').connect(Number(process.argv[1]), '127.0.0.1').on('connect', () => process.exit(11)).on('error', () => process.exit(12))";
    const helper = spawn(process.execPath, ['-e', code, String(target)], { stdio: 'ignore' });
    say('HELPER ' + helper.pid);
    helper.on('exit', (status, signal) => say('HELPER EXIT ' + status + ' ' + signal));
  }
  if (mode === 'dns') dns.lookup('api.deepseek.com', error => say('DNS ' + (error ? error.code : 'resolved')));
  if (mode === 'udp') {
    const socket = dgram.createSocket('udp4');
    socket.send('SYNTHETIC_REVIEW_CANARY', proxyPort, '127.0.0.1', error => say('UDP ' + (error ? error.code : 'sent')));
  }
  if (mode === 'ipv6') {
    const socket = net.connect(proxyPort, '::1', () => {
      socket.end('SYNTHETIC_IPV6_CANARY');
      say('IPV6 connected');
    });
    socket.on('error', error => say('IPV6 ' + error.code));
  }
  if (mode === 'inbound') {
    const server = net.createServer(client => client.end('SYNTHETIC_ACCEPTED_CANARY'));
    server.on('error', error => say('LISTEN ' + error.code));
    server.listen(target, '127.0.0.1', () => say('LISTENING'));
  }
}

main();
`;

function readOut(cwd) {
  try {
    return fs.readFileSync(path.join(cwd, 'out.txt'), 'utf8');
  } catch {
    return '';
  }
}

// f332d551 has no launch(): there the same steps follow the runtime check in
// start(), so the red run repeats them here.
async function launchSession(dshTui, runtime, where) {
  if (typeof runtime.launch === 'function') {
    await runtime.launch(where, process.execPath);
    return;
  }
  dshTui.prepareHome(where);
  const proxy = await runtime.egress.startEgress({ route: runtime.testOnly.route, onViolation: found => runtime.blocked(found) });
  runtime.proxy = proxy;
  const spec = dshTui.launchSpec({ where, proxyPort: proxy.port, apiKey: FAKE_KEY, execPath: process.execPath });
  runtime.attach(new runtime.Terminal(spec.argv, runtime.record.cwd, spec.env, { isolatedEnv: true }));
}

function standInProcesses(file) {
  const out = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return out.split('\n').filter(line => line.includes(file));
}

// Canaries this check started, the app witness's or its own; both connect
// with socket.destroy(). sandbox-exec execs Node.js, so the parent is this
// process.
function canaryProcesses() {
  const out = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  return out.split('\n').filter(line => {
    const parent = Number(line.trim().split(/\s+/)[1]);
    return parent === process.pid && line.includes('socket.destroy()');
  });
}

// One session in `mode`. Returns its outcomes, and `rerun` when the app's
// witness stopped it at a missing beat before it could show anything else.
async function runSession(dshTui, setup, mode) {
  const outcomes = [];
  const note = (name, ok, detail = '') => outcomes.push({ name, ok, detail });
  const cwd = fs.mkdtempSync(path.join(setup.work, `session-${mode}-`));
  const elsewhere = await tcpListener('127.0.0.1');
  const inboundPort = await freePort();
  fs.writeFileSync(path.join(cwd, 'mode.txt'), mode);
  fs.writeFileSync(path.join(cwd, 'target.txt'), String(mode === 'inbound' ? inboundPort : elsewhere.port));
  const launched = {};
  class StandInTerminal extends Terminal {
    constructor(argv, workDir, env, options) {
      if (argv[0] !== SANDBOX_EXEC || argv[1] !== '-p') throw Error('unexpected launch argv');
      super([argv[0], argv[1], argv[2], argv[3], setup.standIn], workDir, env, options);
      launched.profile = argv[2];
    }
  }
  let witnessReader, ownReader;
  const runtime = new dshTui.DshTui({ id: `sandbox-check-${mode}`, cwd }, { dataDir: setup.dataDir }, {
    Terminal: StandInTerminal,
    key: async () => FAKE_KEY,
    testOnly: { route: () => ['127.0.0.1', setup.upstream.port] },
    witness: { startWitness: options => {
      if (mode === 'hold') ownReader = startReader(options.nonce);
      return setup.witness.startWitness({ ...options, spawn: (...args) => {
      witnessReader = spawn(...args);
      return witnessReader;
    } }); } },
  });
  const gaps = [];
  runtime.on('dshWitnessGap', gap => { gaps.push(gap); console.log(`GAP ${JSON.stringify(gap)}`); });
  const states = [];
  let endedAt = null;
  runtime.on('state', state => {
    states.push(state);
    if (state === 'ended' || state === 'error') endedAt = Date.now();
  });
  const activities = [];
  runtime.on('activity', (text, uiMessage) => activities.push(uiMessage?.key));
  let stopCalled = false;
  const outside = {};
  try {
    await launchSession(dshTui, runtime, setup.where);
    const witness = runtime.witness;
    const proxyPort = runtime.proxy.port;
    outside.udp = await udpListener(proxyPort);
    outside.v6 = await tcpListener('::1', proxyPort);
    await waitFor(() => readOut(cwd).includes('READY'), 10);
    fs.writeFileSync(path.join(cwd, 'go'), '');
    const records = () => runtime.violations || (runtime.violation ? [runtime.violation] : []);
    const silent = () => records().some(record => record.source === 'witness' && record.target === 'witness-silent');
    if (mode === 'normal') {
      const tunnel = await waitFor(() => readOut(cwd).includes('TUNNEL PING'), 10);
      await wait(1500);
      const out = readOut(cwd);
      note('normal: a tunnel through the proxy reaches the allowed host', tunnel, out.replace(/\n/g, ' | '));
      note('normal: pipes, IPC and a worker run in the sandbox', out.includes('WORKLOAD pipes,ipc,worker'));
      note('normal: the TUI injection socket is refused', out.includes('INJECT EPERM'), out.match(/INJECT \S+/)?.[0] || 'none');
      const running = runtime.terminal?.alive === true && records().length === 0;
      note('normal: the session keeps running without a refusal', running, JSON.stringify(records()));
      note('normal: the witness canary beats beside the session', witness?.beats >= 4, `beats=${witness?.beats}`);
      const rerun = silent();
      stopCalled = true;
      await runtime.stop();
      await waitFor(() => endedAt !== null, 15);
      note('stop: the session ends with a confirmed exit', states.at(-1) === 'ended', states.join('>'));
      const through = await connectThrough(proxyPort, 'api.deepseek.com:443');
      note('stop: the proxy passes nothing after the stop', through !== 'HTTP/1.1 200 Connection Established', through || 'closed');
      const before = setup.upstream.state.connections;
      const direct = await runFixture({ forPid: () => [] }, launched.profile, CODE.tcp4, [setup.upstream.port], cwd);
      const reachedProxy = await runFixture({ forPid: () => [] }, launched.profile, CODE.tcp4, [proxyPort], cwd);
      const refused = setup.upstream.state.connections === before && direct.out !== 'PING' && reachedProxy.out !== 'PING';
      note('stop: a direct connection with the session profile is refused', refused, JSON.stringify({ direct: direct.out || direct.signal, proxy: reachedProxy.out || reachedProxy.signal }));
      return { outcomes, rerun };
    }
    if (mode === 'hold') {
      const nonce = /\(with message "(naw-dsh-[0-9a-f]+)"\)/.exec(launched.profile || '')?.[1];
      const started = Date.now();
      while (Date.now() - started < HOLD_SECONDS * 1000 && endedAt === null) {
        await wait(Math.min(30000, HOLD_SECONDS * 1000 - (Date.now() - started)));
        console.log(`HOLD ${JSON.stringify({ elapsedMs: Date.now() - started, beats: witness?.beats, alive: runtime.terminal?.alive, violations: records().length })}`);
      }
      const elapsed = Date.now() - started;
      const healthy = endedAt === null && runtime.terminal?.alive === true && records().length === 0;
      note('hold: an idle session survives five minutes without a false stop', healthy && elapsed >= HOLD_SECONDS * 1000, `${elapsed} ms; ${JSON.stringify(records())}`);
      const stamps = (ownReader?.reports || []).filter(report => report.full.includes(nonce)).map(report => report.at).sort((a, b) => a - b);
      const intervals = stamps.slice(1).map((at, index) => at - stamps[index]).sort((a, b) => a - b);
      const percentile = p => intervals[Math.min(intervals.length - 1, Math.ceil(intervals.length * p) - 1)];
      console.log(`DISTRIBUTION ${JSON.stringify({ reports: stamps.length, p50: percentile(.5), p99: percentile(.99), max: intervals.at(-1), gaps })}`);
      const pausedAt = Date.now();
      if (healthy) witnessReader?.stdout.pause();
      const stopped = await waitFor(() => endedAt !== null, 10);
      const first = records()[0];
      const lost = stopped && states.at(-1) === 'ended' && first?.source === 'witness' && first?.target === 'witness-silent';
      const detectionMs = first ? first.at - pausedAt : null;
      note('hold: loss of report progress stops the session within the lease', healthy && lost && detectionMs >= 0 && detectionMs <= 3000, `${states.join('>')}; detection=${detectionMs} ms; exit=${endedAt - pausedAt} ms; ${JSON.stringify(first || null)}`);
      note('hold: the session reported the lost witness', activities.includes('notice.activity.dshWitnessLost'), activities.join(','));
      note('hold: the canary beat before the stop', witness?.beats >= 8, `beats=${witness?.beats}`);
      return { outcomes, rerun: false };
    }
    const stopped = await waitFor(() => endedAt !== null, 12);
    const first = records()[0];
    const out = readOut(cwd);
    const latency = first && endedAt ? `${endedAt - first.at} ms to stop` : 'no stop';
    note(`${mode}: the session stopped by itself`, stopped && states.at(-1) === 'ended', `${states.join('>')}; ${latency}`);
    let recorded = first?.source === 'sandbox';
    if (mode === 'child') {
      const helperPid = Number(/HELPER (\d+)/.exec(out)?.[1]);
      recorded = recorded && first.pid === helperPid;
    }
    note(`${mode}: the session records the sandbox refusal`, recorded, JSON.stringify(first || null));
    note(`${mode}: the session reported it`, activities.includes('notice.activity.dshEgressBlocked'), activities.join(','));
    let reached = elsewhere.received.length + outside.udp.received.length + outside.v6.received.length;
    if (mode === 'inbound') {
      const answer = await knock(inboundPort);
      if (answer.includes('SYNTHETIC_ACCEPTED_CANARY')) reached++;
    }
    note(`${mode}: nothing crossed the sandbox`, reached === 0, out.replace(/\n/g, ' | '));
    // Something that crossed is a finding; it is never run again.
    return { outcomes, rerun: silent() && reached === 0 };
  } finally {
    if (!stopCalled) await runtime.stop().catch(() => {});
    await waitFor(() => standInProcesses(cwd).length === 0 && standInProcesses(setup.standIn).length === 0, 10);
    elsewhere.server.close();
    outside.udp?.socket.close();
    outside.v6?.server.close();
    await ownReader?.close();
  }
}

// A session the witness stopped at a missing beat showed nothing about the
// path under test, so it runs again, at most ATTEMPTS times in all.
async function checkMode(dshTui, setup, mode) {
  for (let index = 1; index <= ATTEMPTS; index++) {
    const { outcomes, rerun } = await runSession(dshTui, setup, mode);
    if (!rerun || index === ATTEMPTS) {
      for (const outcome of outcomes) check(outcome.name, outcome.ok, outcome.detail);
      return;
    }
    console.log(`NOTE ${mode}: the witness stopped the session at a missing beat during attempt ${index}`);
  }
}

async function checkSessions(dshTui, work, options) {
  const dataDir = path.join(work, 'data');
  fs.mkdirSync(dataDir);
  const standIn = path.join(work, 'stand-in.cjs');
  fs.writeFileSync(standIn, STAND_IN);
  const upstream = await echoServer();
  const witnessFile = path.join(path.dirname(options.module), 'dsh-witness.cjs');
  const setup = { work, dataDir, where: dshTui.paths(dataDir), standIn, upstream, witness: fs.existsSync(witnessFile) ? require(witnessFile) : null };
  try {
    for (const mode of options.holdOnly ? ['hold'] : ['normal', 'child', 'dns', 'udp', 'ipv6', 'inbound', 'hold']) await checkMode(dshTui, setup, mode);
  } finally {
    upstream.server.close();
  }
  check('sessions: no stand-in process remains', standInProcesses(standIn).length === 0);
  const noCanary = await waitFor(() => canaryProcesses().length === 0, 5);
  check('sessions: no canary process remains', noCanary, canaryProcesses().join(' | '));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const { module } = options;
  const dshTui = require(module);
  console.log(`module: ${path.relative(process.cwd(), module) || module}`);
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-dsh-sandbox-')));
  try {
    if (!options.holdOnly) await checkRules(dshTui, work);
    await checkSessions(dshTui, work, options);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  const failed = results.filter(result => !result.ok).length;
  console.log(`RESULT pass=${results.length - failed} fail=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(2);
});
