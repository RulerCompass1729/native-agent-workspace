#!/usr/bin/env node
'use strict';
// Offline check of a DSH TUI session started the way NAW starts it.
// No network, no model, no real key. Needs a runtime installed by
// scripts/install-dsh-tui.cjs in a test data directory (not the daily one:
// the session writes its own home under <data-dir>/dsh-tui/home).
//   node scripts/dsh-tui-offline-check.cjs --data-dir <test data directory>
// The sandbox rules and what a session does with a refused connection are
// checked without a runtime by scripts/dsh-tui-sandbox-check.cjs.
// Checks:
// 1. Chat: the TUI in NAW's PTY sends one turn through the egress proxy to a
//    loopback stand-in for api.deepseek.com (a certificate trusted for this
//    run only). The turn uses deepseek-flash and the fake key, carries no
//    anonymous harness identifiers, and the reply reaches the screen. The
//    session's sandbox refuses anything else, so the turn also shows that the
//    real TUI starts and answers without a refused connection.
// 2. Block: a CONNECT to another host through the same proxy reports that
//    target and stops the session.
// 3. Lost: the witness's log reader ending stops the session.
// Each of the three stops (stop, blocked, witness lost) ends the TUI within
// the PTY host's SIGTERM grace, so its SIGKILL fallback never runs, and
// after each session no process of the runtime remains.
// The log drops reports about once a minute, and the witness then stops the
// session (dsh-witness.cjs). Such a session showed nothing about the path
// under test, so it runs again, at most ATTEMPTS times in all.
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const { Terminal } = require('../app/adapters.cjs');
const dshTui = require('../app/dsh-tui.cjs');

const FAKE_KEY = 'sk-naw-offline-check-not-a-key';
const REPLY = 'FAKE-REPLY-OK';
const BLOCKED_TARGET = 'example.com:443';
// pty_host.py sends SIGKILL only once this long has passed since its SIGTERM.
const PTY_TERM_GRACE_MS = 5000;
const ATTEMPTS = 3;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--data-dir' || !path.isAbsolute(argv[1])) {
    throw Error('usage: dsh-tui-offline-check.cjs --data-dir <absolute test data directory>');
  }
  return { dataDir: argv[1] };
}

// --- results -------------------------------------------------------------

const results = [];
// The current attempt's outcomes, reported once it is known to count.
let buffer = null;

function report(outcome) {
  results.push(outcome);
  const mark = outcome.passed ? 'PASS' : 'FAIL';
  console.log(`${mark} ${outcome.name}${outcome.detail === undefined ? '' : ` — ${outcome.detail}`}`);
}

function check(name, passed, detail) {
  const outcome = { name, passed: passed === true, detail };
  if (buffer !== null) {
    buffer.push(outcome);
    return;
  }
  report(outcome);
}

// Runs one session check, `run` resolving with its session, again while the
// witness stopped that session at a missing beat.
async function attempts(name, run) {
  for (let index = 1; index <= ATTEMPTS; index++) {
    const outcomes = [];
    buffer = outcomes;
    let session = null;
    try {
      session = await run();
    } finally {
      buffer = null;
      if (session === null) {
        for (const outcome of outcomes) report(outcome);
      }
    }
    const silent = session.violations.some(record => record.source === 'witness' && record.target === 'witness-silent');
    if (!silent || index === ATTEMPTS) {
      for (const outcome of outcomes) report(outcome);
      return;
    }
    console.log(`NOTE ${name}: the witness stopped the session at a missing beat during attempt ${index}`);
  }
}

// --- fixtures ------------------------------------------------------------

function makeCertificate(dir) {
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('/usr/bin/openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key,
    '-out', cert,
    '-days', '1',
    '-subj', '/CN=api.deepseek.com',
    '-addext', 'subjectAltName=DNS:api.deepseek.com',
  ], { stdio: 'ignore' });
  return { key, cert };
}

function streamedReply(text) {
  const events = [
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_offline',
        type: 'message',
        role: 'assistant',
        model: 'deepseek-flash',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  const lines = [];
  for (const [name, data] of events) {
    lines.push(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  return lines.join('');
}

// A loopback stand-in for api.deepseek.com. It records method, path, header
// names, the model and whether the key arrived; never header values or bodies.
function startFakeDeepSeek(certificate) {
  const requests = [];
  const options = { key: fs.readFileSync(certificate.key), cert: fs.readFileSync(certificate.cert) };
  const server = https.createServer(options, (request, response) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
    });
    request.on('end', () => {
      let model = null;
      try {
        model = JSON.parse(body).model || null;
      } catch {
        model = null;
      }
      const headerKey = request.headers['x-api-key'];
      const bearer = request.headers.authorization;
      requests.push({
        method: request.method,
        path: request.url,
        headers: Object.keys(request.headers).sort(),
        model,
        fakeKeyArrived: headerKey === FAKE_KEY || bearer === `Bearer ${FAKE_KEY}`,
      });
      if (request.method === 'POST' && /\/v1\/messages$/.test(request.url)) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(streamedReply(REPLY));
        return;
      }
      if (request.method === 'GET' && request.url === '/user/balance') {
        const balance = { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '1.00', granted_balance: '0.00', topped_up_balance: '1.00' }] };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(balance));
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":{"message":"not found","type":"not_found"}}');
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        requests,
        close: () => new Promise(done => {
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}

// --- sessions ------------------------------------------------------------

// The visible screen only: scrollback keeps frames the TUI has replaced.
function screenText(terminal) {
  const buffer = terminal.screen.buffer.active;
  const lines = [];
  for (let index = buffer.baseY; index < buffer.baseY + terminal.screen.rows; index++) {
    const line = buffer.getLine(index)?.translateToString(true);
    if (line && line.trim()) lines.push(line);
  }
  return lines.join('\n');
}

async function waitFor(condition, seconds) {
  for (let index = 0; index < seconds * 4; index++) {
    if (condition()) return true;
    await wait(250);
  }
  return condition();
}

// Processes whose command line names this runtime, other than this script.
function runtimeProcesses(where) {
  const out = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  const found = [];
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match || Number(match[1]) === process.pid) continue;
    if (match[2].includes(where.root)) found.push({ pid: Number(match[1]), command: match[2] });
  }
  return found;
}

// NAW's PTY, timed: when the first stop was asked for, and when and how the
// PTY host reported the TUI's exit (a negative code is the signal).
class TimedTerminal extends Terminal {
  constructor(argv, cwd, env, options) {
    super(argv, cwd, env, options);
    this.profile = argv[2];
    this.stopAskedAt = null;
    this.exitAt = null;
    this.exitCode = undefined;
    let lines = '';
    this.worker.stdout.on('data', chunk => {
      lines += chunk;
      const parts = lines.split('\n');
      lines = parts.pop();
      for (const line of parts) {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.type === 'exit' && this.exitAt === null) {
          this.exitAt = Date.now();
          this.exitCode = message.code;
        }
      }
    });
  }
  stop(...args) {
    if (this.stopAskedAt === null) this.stopAskedAt = Date.now();
    return super.stop(...args);
  }
}

function checkGrace(name, terminal) {
  const elapsed = terminal.exitAt !== null && terminal.stopAskedAt !== null ? terminal.exitAt - terminal.stopAskedAt : null;
  const within = elapsed !== null && elapsed < PTY_TERM_GRACE_MS && terminal.exitCode !== -9;
  check(`${name}: the TUI exits within the SIGTERM grace, without SIGKILL`, within, `${elapsed} ms, exit ${terminal.exitCode}`);
}

function newSession(options) {
  const events = { states: [], activities: [] };
  const host = { dataDir: options.dataDir, binaries: { dsh: process.execPath } };
  const record = { id: options.id, cwd: options.work };
  const session = new dshTui.DshTui(record, host, {
    Terminal: TimedTerminal,
    key: async () => FAKE_KEY,
    testOnly: {
      route: () => ['127.0.0.1', options.fake.port],
      caFile: options.certificate.cert,
      execPath: process.execPath,
    },
  });
  session.on('state', state => events.states.push(state));
  session.on('activity', (...activity) => events.activities.push(activity));
  return { session, events };
}

// Gets from launch to an idle composer. The home screen can draw before the
// first-run guide opens over it; the guide takes Esc only once its account
// check has settled; and a message sent while the DSH core is still
// starting opens /provider instead of a turn. So: Esc the settled guide
// (again after a pause if it stays), and accept the composer only once it
// has stayed visible, guide closed and core started, for two seconds.
async function reachComposer(terminal) {
  const deadline = Date.now() + 120000;
  let lastEscape = 0;
  let readySince = 0;
  while (Date.now() < deadline && terminal.alive) {
    const text = screenText(terminal);
    const guide = /Esc skip the guide/.test(text);
    if (guide) {
      readySince = 0;
      const settled = /Balance|Connected/.test(text);
      if (settled && Date.now() - lastEscape > 4000) {
        terminal.input('\x1b');
        lastEscape = Date.now();
      }
    } else if (/Say something/.test(text) && !/Starting DSH/.test(text)) {
      if (readySince === 0) readySince = Date.now();
      if (Date.now() - readySince >= 2000) return true;
    } else {
      readySince = 0;
    }
    await wait(250);
  }
  return false;
}

async function checkChat(options, where) {
  const { session, events } = newSession({ ...options, id: 'offline-chat' });
  await session.start();
  const terminal = session.openTerminal();
  await waitFor(() => runtimeProcesses(where).length > 0, 15);
  const argvText = runtimeProcesses(where).map(item => item.command).join('\n');
  check('chat: the key is not on any command line', argvText !== '' && !argvText.includes(FAKE_KEY));
  const composing = await reachComposer(terminal);
  check('chat: the composer is open, the guide skipped and the DSH core started', composing === true);
  if (!composing) console.log(`--- screen ---\n${screenText(terminal)}\n--- end of screen ---`);
  // Typing into the guide would act on it (its first choice is a sign-in).
  if (composing) terminal.input('Say hi');
  await wait(1500);
  if (composing) terminal.input('\r');
  const replied = composing && await waitFor(() => screenText(terminal).includes(REPLY), 60);
  check('chat: the reply reached the screen', replied === true);
  if (!replied) console.log(`--- screen ---\n${screenText(terminal)}\n--- end of screen ---`);
  const turns = options.fake.requests.filter(request => request.method === 'POST' && /\/v1\/messages$/.test(request.path));
  check('chat: one model request reached the stand-in', turns.length >= 1, `${turns.length} request(s)`);
  check('chat: model deepseek-flash', turns.length > 0 && turns.every(request => request.model === 'deepseek-flash'));
  check('chat: the fake key arrived as the credential', turns.length > 0 && turns.every(request => request.fakeKeyArrived === true));
  const identifying = options.fake.requests.flatMap(request => request.headers.filter(name => name.startsWith('x-deepseek-harness')));
  check('chat: no x-deepseek-harness-* identifiers', identifying.length === 0, identifying.join(',') || 'none');
  const targets = session.proxy.records().map(item => `${item.target}:${item.verdict}`);
  check('chat: egress saw only api.deepseek.com:443', targets.length > 0 && targets.every(item => item === 'api.deepseek.com:443:allowed'), [...new Set(targets)].join(','));
  await session.stop();
  await waitFor(() => events.states.includes('ended'), 15);
  check('chat: stop ends the session with a confirmed exit', events.states.at(-1) === 'ended' && terminal.nativeExited === true, events.states.join('>'));
  checkGrace('chat', terminal);
  await waitFor(() => runtimeProcesses(where).length === 0, 10);
  check('chat: no runtime process remains', runtimeProcesses(where).length === 0);
  return session;
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
    socket.on('error', () => resolve(answer.split('\r\n')[0]));
  });
}

async function checkBlock(options, where) {
  const { session, events } = newSession({ ...options, id: 'offline-block' });
  await session.start();
  const terminal = session.openTerminal();
  const ready = await waitFor(() => /Esc skip the guide|Say something/.test(screenText(terminal)), 60);
  check('block: the TUI is running before the blocked connection', ready === true && terminal.alive === true);
  const answer = await connectThrough(session.proxy.port, BLOCKED_TARGET);
  check('block: the proxy refused the other host', answer === 'HTTP/1.1 403 Forbidden', answer);
  const ended = await waitFor(() => events.states.includes('ended'), 15);
  // An activity is [text, { key, params }].
  const notice = events.activities.find(activity => activity[1]?.key === 'notice.activity.dshEgressBlocked');
  check('block: the session reported the target', notice !== undefined && notice[1].params?.target === BLOCKED_TARGET, notice ? notice[0] : 'no notice');
  check('block: the session stopped by itself', ended === true && terminal.alive === false && terminal.nativeExited === true, events.states.join('>'));
  checkGrace('block', terminal);
  const after = await connectThrough(session.proxy.port, 'api.deepseek.com:443');
  check('block: nothing passes after the violation, the allowed host included', after !== 'HTTP/1.1 200 Connection Established', after || 'closed');
  await waitFor(() => runtimeProcesses(where).length === 0, 10);
  check('block: no runtime process remains', runtimeProcesses(where).length === 0);
  await session.stop();
  return session;
}

// The witness's own log reader: a child of this process streaming the
// session's nonce. Found by parent and command line, never by name alone.
function witnessReader(terminal) {
  const nonce = /\(with message "(naw-dsh-[0-9a-f]+)"\)/.exec(terminal.profile)?.[1];
  if (!nonce) return null;
  const out = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  const found = [];
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match || Number(match[2]) !== process.pid) continue;
    if (match[3].startsWith('/usr/bin/log stream ') && match[3].includes(nonce)) found.push(Number(match[1]));
  }
  return found.length === 1 ? found[0] : null;
}

async function checkLost(options, where) {
  const { session, events } = newSession({ ...options, id: 'offline-lost' });
  await session.start();
  const terminal = session.openTerminal();
  const ready = await waitFor(() => /Esc skip the guide|Say something/.test(screenText(terminal)), 60);
  check('lost: the TUI is running before its witness ends', ready === true && terminal.alive === true);
  const reader = witnessReader(terminal);
  check('lost: the witness log reader is found', reader !== null, String(reader));
  if (reader !== null) process.kill(reader, 'SIGTERM');
  const ended = await waitFor(() => events.states.includes('ended'), 15);
  const notice = events.activities.some(activity => activity[1]?.key === 'notice.activity.dshWitnessLost');
  check('lost: the session reported the lost witness', notice === true);
  check('lost: the session stopped by itself', ended === true && terminal.alive === false && terminal.nativeExited === true, events.states.join('>'));
  checkGrace('lost', terminal);
  await waitFor(() => runtimeProcesses(where).length === 0, 10);
  check('lost: no runtime process remains', runtimeProcesses(where).length === 0);
  await session.stop();
  return session;
}

async function main() {
  const { dataDir } = parseArguments(process.argv.slice(2));
  const where = dshTui.verifyRuntime(dataDir);
  console.log(`runtime verified: ${where.root}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-dsh-tui-check-'));
  let fake = null;
  try {
    const certificate = makeCertificate(dir);
    fake = await startFakeDeepSeek(certificate);
    const work = path.join(dir, 'work');
    fs.mkdirSync(work);
    const options = { dataDir, work, fake, certificate };
    await attempts('chat', () => checkChat(options, where));
    await attempts('block', () => checkBlock(options, where));
    await attempts('lost', () => checkLost(options, where));
  } finally {
    if (fake) await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const failed = results.filter(item => !item.passed);
  console.log(`${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(`dsh-tui-offline-check: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
