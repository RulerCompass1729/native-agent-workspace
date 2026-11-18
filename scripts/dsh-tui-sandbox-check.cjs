#!/usr/bin/env node
'use strict';
// Real-kernel check of the DSH TUI sandbox and of what a session does with a
// refused connection. No DSH runtime, no model, no key and no network beyond
// loopback: the "TUI" is a stand-in program in a synthetic session home.
//   node scripts/dsh-tui-sandbox-check.cjs [--dsh-tui <absolute path to dsh-tui.cjs>]
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
//      a tunnel through the proxy) runs without a refusal.
//    - Each forbidden path stops the session by itself with a sandbox record.
//    - After a stop nothing passes, through the proxy or directly.
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
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  const suffix = detail ? ` — ${detail}` : '';
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${suffix}`);
}

function parseArguments(argv) {
  if (argv.length === 0) return { module: path.join(__dirname, '../app/dsh-tui.cjs') };
  if (argv.length === 2 && argv[0] === '--dsh-tui' && path.isAbsolute(argv[1])) return { module: argv[1] };
  throw Error('usage: dsh-tui-sandbox-check.cjs [--dsh-tui <absolute path to dsh-tui.cjs>]');
}

// --- the check's own report reader ------------------------------------------

function startReader(nonce) {
  const reports = [];
  const predicate = `senderImagePath ENDSWITH "/Sandbox" AND eventMessage CONTAINS "${nonce}"`;
  const reader = spawn('/usr/bin/log', ['stream', '--style', 'ndjson', '--predicate', predicate], { stdio: ['ignore', 'pipe', 'ignore'] });
  let pending = '';
  reader.stdout.setEncoding('utf8');
  reader.stdout.on('data', chunk => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('{')) continue;
      let message = '';
      try {
        message = JSON.parse(line).eventMessage.split('\n')[0];
      } catch {
        continue;
      }
      const match = /\((\d+)\) deny\(\d+\) (.*)$/.exec(message);
      if (match) reports.push({ pid: Number(match[1]), text: match[2] });
    }
  });
  return {
    forPid: pid => reports.filter(report => report.pid === pid).map(report => report.text),
    close: () => reader.kill('SIGTERM'),
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

// --- 1. rules ------------------------------------------------------------------

const CODE = {
  canary: "require('node:net').connect(1, '127.0.0.1').on('error', error => console.log(error.code))",
  tcp4: "const s = require('node:net').connect(Number(process.argv[1]), '127.0.0.1', () => s.write('PING')); s.on('data', data => { console.log(String(data)); s.destroy(); }); s.on('error', error => console.log('error ' + error.code))",
  udp: "const s = require('node:dgram').createSocket('udp4'); s.send('SYNTHETIC_REVIEW_CANARY', Number(process.argv[1]), '127.0.0.1', error => { console.log(error ? 'error ' + error.code : 'sent'); s.close(); })",
  ipv6: "const s = require('node:net').connect(Number(process.argv[1]), '::1', () => { s.end('SYNTHETIC_IPV6_CANARY'); console.log('connected'); }); s.on('error', error => console.log('error ' + error.code))",
  listen: "const server = require('node:net').createServer(c => c.end('SYNTHETIC_ACCEPTED_CANARY')); server.on('error', error => { console.log('error ' + error.code); process.exit(0); }); server.listen(Number(process.argv[1]), '127.0.0.1', () => console.log('LISTENING')); setTimeout(() => process.exit(0), 2500)",
  unix: "const server = require('node:net').createServer(); server.on('error', error => { console.log('error ' + error.code); process.exit(0); }); server.listen(process.argv[1], () => { console.log('LISTENING'); setTimeout(() => process.exit(0), 1000); })",
  dns: "require('node:dns').lookup('api.deepseek.com', error => console.log(error ? 'error ' + error.code : 'resolved'))",
  helper: "const { spawn } = require('node:child_process'); const code = \"require('node:net').connect(Number(process.argv[1]), '127.0.0.1').on('connect', () => process.exit(11)).on('error', () => process.exit(12))\"; const h = spawn(process.execPath, ['-e', code, process.argv[1]], { stdio: 'ignore' }); h.on('exit', (code, signal) => console.log(JSON.stringify({ helper: h.pid, code, signal })))",
};

async function armReader(reader, nonce, cwd) {
  const minimal = `(version 1)\n(allow default)\n(deny network-outbound (with message "${nonce}"))`;
  for (let attempt = 0; attempt < 20; attempt++) {
    const run = await runFixture(reader, minimal, CODE.canary, [], cwd);
    if (run.reports.length > 0) return true;
  }
  return false;
}

async function checkRules(dshTui, work) {
  const nonce = `naw-dsh-${randomBytes(12).toString('hex')}`;
  const reader = startReader(nonce);
  const cwd = fs.mkdtempSync(path.join(work, 'rules-'));
  const injectDir = path.join(cwd, 'home/.dsh-tui/inject');
  const otherDir = path.join(cwd, 'other');
  fs.mkdirSync(injectDir, { recursive: true });
  fs.mkdirSync(otherDir, { recursive: true });
  try {
    const live = await armReader(reader, nonce, cwd);
    check('reader: the check sees sandbox reports carrying the nonce', live);
    if (!live) return;
    const proxy = await echoServer();
    const profile = dshTui.sandboxProfile({ proxyPort: proxy.port, nonce, injectDir, personHome: path.join(cwd, 'person') });

    const canary = await runFixture(reader, profile, CODE.canary, [], cwd);
    check('rules: a refused connection is reported with the session nonce', canary.reports.length > 0, JSON.stringify(canary.reports));

    const tcp4 = await runFixture(reader, profile, CODE.tcp4, [proxy.port], cwd);
    check('rules: IPv4 TCP to the proxy port connects without a report', tcp4.out === 'PING' && tcp4.reports.length === 0, JSON.stringify(tcp4));

    // F's udp-bypass, ipv6-bypass and inbound-bypass.
    const udp = await udpListener(proxy.port);
    const udpRun = await runFixture(reader, profile, CODE.udp, [proxy.port], cwd);
    udp.socket.close();
    check('rules: UDP to the proxy port is refused and reported', udp.received.length === 0 && udpRun.reports.length > 0, JSON.stringify({ received: udp.received, ...udpRun }));

    const v6 = await tcpListener('::1', proxy.port);
    const v6Run = await runFixture(reader, profile, CODE.ipv6, [proxy.port], cwd);
    v6.server.close();
    check('rules: IPv6 TCP to the proxy port is refused and reported', v6.received.length === 0 && v6Run.reports.length > 0, JSON.stringify({ received: v6.received, ...v6Run }));

    const inboundPort = await freePort();
    const listenRun = sandboxed(profile, CODE.listen, [inboundPort], cwd);
    await wait(SETTLE_MS);
    const answer = await new Promise(resolve => {
      const socket = net.connect(inboundPort, '127.0.0.1', () => socket.write('HELLO'));
      let text = '';
      socket.on('data', chunk => {
        text += chunk;
      });
      socket.on('close', () => resolve(text));
      socket.on('error', error => resolve(`error ${error.code}`));
    });
    const listened = await listenRun.done;
    await wait(SETTLE_MS);
    const listenReports = reader.forPid(listenRun.pid);
    check('rules: listening for an outside connection is refused and reported', !answer.includes('SYNTHETIC_ACCEPTED_CANARY') && listenReports.length > 0, JSON.stringify({ answer, out: listened.out, reports: listenReports }));

    // F's stop-policy-probe: DNS in the root, then a helper connects elsewhere.
    const dnsRun = await runFixture(reader, profile, CODE.dns, [], cwd);
    check('rules: a DNS lookup is refused and reported', dnsRun.out.startsWith('error') && dnsRun.reports.length > 0, JSON.stringify(dnsRun));
    const elsewhere = await tcpListener('127.0.0.1');
    const helperRun = await runFixture(reader, profile, CODE.helper, [elsewhere.port], cwd);
    elsewhere.server.close();
    let helper = {};
    try {
      helper = JSON.parse(helperRun.out);
    } catch {
      helper = {};
    }
    const helperReports = Number.isInteger(helper.helper) ? reader.forPid(helper.helper) : [];
    check('rules: a helper process connecting directly is refused and reported', elsewhere.received.length === 0 && helperReports.length > 0, JSON.stringify({ helper, reports: helperReports }));

    const localhost = await new Promise(resolve => dns.lookup('localhost', { family: 4 }, (error, address) => resolve(error ? error.code : address)));
    check('rules: outside the sandbox localhost resolves (DNS control)', localhost === '127.0.0.1', localhost);

    const inject = await runFixture(reader, profile, CODE.unix, ['s.sock'], injectDir);
    check('rules: the TUI injection socket is refused without a report', inject.out.startsWith('error') && inject.reports.length === 0, JSON.stringify(inject));
    const other = await runFixture(reader, profile, CODE.unix, ['o.sock'], otherDir);
    check('rules: any other Unix-socket listener is refused and reported', other.out.startsWith('error') && other.reports.length > 0, JSON.stringify(other));
    proxy.server.close();
  } finally {
    reader.close();
  }
}

// --- 2. sessions -----------------------------------------------------------------

const STAND_IN = String.raw`'use strict';
// Stand-in for the DSH TUI root, run by the sandbox check inside the session.
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

async function waitFor(condition, seconds) {
  for (let index = 0; index < seconds * 10; index++) {
    if (condition()) return true;
    await wait(100);
  }
  return condition();
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

async function runSession(dshTui, setup, mode) {
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
  const runtime = new dshTui.DshTui({ id: `sandbox-check-${mode}`, cwd }, { dataDir: setup.dataDir }, {
    Terminal: StandInTerminal,
    key: async () => FAKE_KEY,
    testOnly: { route: () => ['127.0.0.1', setup.upstream.port] },
  });
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
    const proxyPort = runtime.proxy.port;
    outside.udp = await udpListener(proxyPort);
    outside.v6 = await tcpListener('::1', proxyPort);
    await waitFor(() => readOut(cwd).includes('READY'), 10);
    fs.writeFileSync(path.join(cwd, 'go'), '');
    const records = () => runtime.violations || (runtime.violation ? [runtime.violation] : []);
    if (mode === 'normal') {
      const tunnel = await waitFor(() => readOut(cwd).includes('TUNNEL PING'), 10);
      await wait(1500);
      const out = readOut(cwd);
      check('normal: a tunnel through the proxy reaches the allowed host', tunnel, out.replace(/\n/g, ' | '));
      check('normal: pipes, IPC and a worker run in the sandbox', out.includes('WORKLOAD pipes,ipc,worker'));
      check('normal: the TUI injection socket is refused', out.includes('INJECT EPERM'), out.match(/INJECT \S+/)?.[0] || 'none');
      const running = runtime.terminal?.alive === true && records().length === 0;
      check('normal: the session keeps running without a refusal', running, JSON.stringify(records()));
      stopCalled = true;
      await runtime.stop();
      await waitFor(() => endedAt !== null, 15);
      check('stop: the session ends with a confirmed exit', states.at(-1) === 'ended', states.join('>'));
      const through = await connectThrough(proxyPort, 'api.deepseek.com:443');
      check('stop: the proxy passes nothing after the stop', through !== 'HTTP/1.1 200 Connection Established', through || 'closed');
      const before = setup.upstream.state.connections;
      const direct = await runFixture({ forPid: () => [] }, launched.profile, CODE.tcp4, [setup.upstream.port], cwd);
      const reachedProxy = await runFixture({ forPid: () => [] }, launched.profile, CODE.tcp4, [proxyPort], cwd);
      const refused = setup.upstream.state.connections === before && direct.out !== 'PING' && reachedProxy.out !== 'PING';
      check('stop: a direct connection with the session profile is refused', refused, JSON.stringify({ direct: direct.out || direct.signal, proxy: reachedProxy.out || reachedProxy.signal }));
      return;
    }
    const stopped = await waitFor(() => endedAt !== null, 12);
    const first = records()[0];
    const out = readOut(cwd);
    const latency = first && endedAt ? `${endedAt - first.at} ms to stop` : 'no stop';
    check(`${mode}: the session stopped by itself`, stopped && states.at(-1) === 'ended', `${states.join('>')}; ${latency}`);
    let recorded = first?.source === 'sandbox';
    if (mode === 'child') {
      const helperPid = Number(/HELPER (\d+)/.exec(out)?.[1]);
      recorded = recorded && first.pid === helperPid;
    }
    check(`${mode}: the session records the sandbox refusal`, recorded, JSON.stringify(first || null));
    check(`${mode}: the session reported it`, activities.includes('notice.activity.dshEgressBlocked'), activities.join(','));
    let reached = elsewhere.received.length + outside.udp.received.length + outside.v6.received.length;
    if (mode === 'inbound') {
      const answer = await new Promise(resolve => {
        const socket = net.connect(inboundPort, '127.0.0.1', () => socket.write('HELLO'));
        let text = '';
        socket.on('data', chunk => {
          text += chunk;
        });
        socket.on('close', () => resolve(text));
        socket.on('error', () => resolve(''));
      });
      if (answer.includes('SYNTHETIC_ACCEPTED_CANARY')) reached++;
    }
    check(`${mode}: nothing crossed the sandbox`, reached === 0, out.replace(/\n/g, ' | '));
  } finally {
    if (!stopCalled) await runtime.stop().catch(() => {});
    await waitFor(() => standInProcesses(cwd).length === 0 && standInProcesses(setup.standIn).length === 0, 10);
    elsewhere.server.close();
    outside.udp?.socket.close();
    outside.v6?.server.close();
  }
}

async function checkSessions(dshTui, work) {
  const dataDir = path.join(work, 'data');
  fs.mkdirSync(dataDir);
  const standIn = path.join(work, 'stand-in.cjs');
  fs.writeFileSync(standIn, STAND_IN);
  const upstream = await echoServer();
  const setup = { work, dataDir, where: dshTui.paths(dataDir), standIn, upstream };
  try {
    for (const mode of ['normal', 'child', 'dns', 'udp', 'ipv6', 'inbound']) await runSession(dshTui, setup, mode);
  } finally {
    upstream.server.close();
  }
  check('sessions: no stand-in process remains', standInProcesses(standIn).length === 0);
}

async function main() {
  const { module } = parseArguments(process.argv.slice(2));
  const dshTui = require(module);
  console.log(`module: ${path.relative(process.cwd(), module) || module}`);
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-dsh-sandbox-')));
  try {
    await checkRules(dshTui, work);
    await checkSessions(dshTui, work);
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
