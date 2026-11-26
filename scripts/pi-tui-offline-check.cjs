#!/usr/bin/env node
'use strict';
// Offline check of a pi TUI session started the way NAW starts it: no network, no model, no real key.
// Needs a runtime installed by scripts/install-pi-tui.cjs for a test data folder (not the daily one).
//   node scripts/pi-tui-offline-check.cjs --data-dir <test data directory>
// 1. Chat: pi in NAW's PTY sends one turn through the egress proxy to a loopback stand-in for
//    api.deepseek.com (a certificate trusted for this run only), with deepseek-flash and the fake key.
//    The sandbox refuses anything else, so a reply also shows pi starts and answers without any other
//    connection (no tool download, version check or telemetry). The request carries none of the
//    person's rule files or skills.
// 2. Again: the same record opens the same pi session.
// 3. Block: a CONNECT to another host through the same proxy reports that target and stops the session.
// 4. Lost: the witness's log reader ending stops the session.
// 5. Confirm: the stand-in asks for tool calls. A command, a write, an edit and a read outside the
//    working folder each wait for the person in pi's terminal: declined, it does not run; allowed, it
//    does. A read inside the working folder runs without asking.
// 6. No gate: a gate that fails to load stops pi; one that loads but turns nothing on leaves the model
//    without tools.
// After each session no process of the runtime remains.
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const { Terminal } = require('../app/adapters.cjs');
const piTui = require('../app/pi-tui.cjs');

const FAKE_KEY = 'sk-naw-offline-check-not-a-key';
const REPLY = 'FAKE-REPLY-OK';
const BLOCKED_TARGET = 'example.com:443';
const MODEL = 'deepseek/deepseek-flash';
const REQUEST_FIELDS = new Set(['max_tokens', 'messages', 'model', 'reasoning_effort', 'stream', 'stream_options', 'thinking', 'tools']);
// Text that only the person's own agent files would put into a request.
// CANARY sits in rule files in the working folder and its parent, which pi reads without --no-context-files.
const CANARY = 'NAW-PI-CONTEXT-CANARY';
const PERSONAL_MARKERS = ['/.claude/', '/.agents/', 'CLAUDE.md', 'AGENTS.md', os.homedir(), CANARY];

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];

function check(name, passed, detail) {
  results.push({ name, passed: passed === true });
  console.log(`${passed === true ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--data-dir' || !path.isAbsolute(argv[1])) {
    throw Error('usage: pi-tui-offline-check.cjs --data-dir <absolute test data directory>');
  }
  return { dataDir: argv[1] };
}

function makeCertificate(dir) {
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=api.deepseek.com', '-addext', 'subjectAltName=DNS:api.deepseek.com'], { stdio: 'ignore' });
  return { key, cert };
}

// Tool calls the stand-in answers with, by the person's message.
const TOOL_CALLS = {
  'go-bash': () => ['bash', { command: 'echo ran > ran-by-bash.txt' }],
  'go-write': () => ['write', { path: 'made-by-write.txt', content: 'written\n' }],
  'go-edit': () => ['edit', { path: 'edit-me.txt', edits: [{ oldText: 'before', newText: 'after' }] }],
  'go-read': () => ['read', { path: 'inside.txt' }],
  'go-read-outside': options => ['read', { path: options.outsideFile }],
};
const TOOL_DONE = 'FAKE-TOOL-DONE';
const INSIDE_MARKER = 'NAW-PI-INSIDE-MARKER';
const OUTSIDE_MARKER = 'NAW-PI-OUTSIDE-MARKER';

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) return message.content.map(part => part?.text || '').join('');
  return '';
}

function chunk(delta, finish, usage) {
  const body = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason: finish }] };
  if (usage) body.usage = usage;
  return `data: ${JSON.stringify(body)}\n\n`;
}

// A loopback stand-in for api.deepseek.com's OpenAI-compatible API. It keeps header names, the body's
// field names, the model, whether the key arrived and whether a personal marker appears in the body.
function startFakeDeepSeek(certificate, script = {}) {
  const requests = [];
  let callNumber = 0;
  const server = https.createServer({ key: fs.readFileSync(certificate.key), cert: fs.readFileSync(certificate.cert) }, (request, response) => {
    let body = '';
    request.on('data', part => {
      body += part;
    });
    request.on('end', () => {
      let json = null;
      try {
        json = JSON.parse(body);
      } catch {
        json = null;
      }
      requests.push({
        method: request.method,
        path: request.url,
        headers: Object.keys(request.headers).sort(),
        fields: json ? Object.keys(json).sort() : [],
        parsed: json !== null,
        model: json?.model ?? null,
        fakeKeyArrived: request.headers.authorization === `Bearer ${FAKE_KEY}`,
        personal: PERSONAL_MARKERS.filter(marker => body.includes(marker)),
        tools: Array.isArray(json?.tools) ? json.tools.map(tool => tool?.function?.name).sort() : [],
        lastRole: Array.isArray(json?.messages) ? json.messages.at(-1)?.role ?? null : null,
        body,
      });
      if (request.method === 'POST' && request.url === '/chat/completions') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const last = Array.isArray(json?.messages) ? json.messages.at(-1) : null;
        const wanted = last?.role === 'user' ? TOOL_CALLS[messageText(last).trim()] : null;
        if (wanted) {
          const [name, input] = wanted(script);
          const call = { index: 0, id: `call_${++callNumber}`, type: 'function', function: { name, arguments: JSON.stringify(input) } };
          response.write(chunk({ role: 'assistant', content: null, tool_calls: [call] }, null));
          response.write(chunk({}, 'tool_calls', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }));
          response.end('data: [DONE]\n\n');
          return;
        }
        response.write(chunk({ role: 'assistant', content: last?.role === 'tool' ? TOOL_DONE : REPLY }, null));
        response.write(chunk({}, 'stop', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }));
        response.end('data: [DONE]\n\n');
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":{"message":"not found"}}');
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      requests,
      close: () => new Promise(done => {
        server.closeAllConnections();
        server.close(() => done());
      }),
    }));
  });
}

function screenText(terminal) {
  const buffer = terminal.screen.buffer.active;
  const lines = [];
  for (let index = 0; index < buffer.length; index++) {
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

function runtimeProcesses(where) {
  const out = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  const found = [];
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match && Number(match[1]) !== process.pid && match[2].includes(where.root)) found.push(match[2]);
  }
  return found;
}

class ProfileTerminal extends Terminal {
  constructor(argv, cwd, env, options) {
    super(argv, cwd, env, options);
    this.profile = argv[2];
  }
}

function newSession(options, record, gateSource) {
  const events = { states: [], activities: [] };
  const host = { dataDir: options.dataDir, binaries: { pi: process.execPath } };
  const testOnly = { route: () => ['127.0.0.1', options.fake.port], caFile: options.certificate.cert, execPath: process.execPath, model: MODEL };
  if (gateSource !== undefined) testOnly.gateSource = gateSource;
  const session = new piTui.PiTui(record, host, { Terminal: ProfileTerminal, key: async () => FAKE_KEY, testOnly });
  session.on('state', state => events.states.push(state));
  session.on('activity', (...activity) => events.activities.push(activity));
  return { session, events };
}

// pi's footer names the model once the editor is ready.
const ready = terminal => /deepseek-flash/.test(screenText(terminal));

async function finish(name, session, events, terminal, where) {
  await session.stop();
  await waitFor(() => events.states.includes('ended'), 15);
  check(`${name}: stop ends the session with a confirmed exit`, events.states.at(-1) === 'ended' && terminal.nativeExited === true, events.states.join('>'));
  await waitFor(() => runtimeProcesses(where).length === 0, 10);
  check(`${name}: no runtime process remains`, runtimeProcesses(where).length === 0);
}

function sessionFiles(dataDir) {
  const dir = piTui.paths(dataDir).sessionDir;
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

// Files under a folder whose bytes contain the text.
function filesHolding(dir, text) {
  const found = [];
  const pending = fs.existsSync(dir) ? [dir] : [];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && fs.readFileSync(file).includes(text)) found.push(path.relative(dir, file));
    }
  }
  return found;
}

async function checkChat(options, where, record) {
  const earlier = sessionFiles(options.dataDir);
  const { session, events } = newSession(options, record);
  await session.start();
  const terminal = session.openTerminal();
  await waitFor(() => runtimeProcesses(where).length > 0, 15);
  check('chat: the key is not on any command line', !runtimeProcesses(where).join('\n').includes(FAKE_KEY));
  const started = await waitFor(() => ready(terminal), 60);
  check('chat: pi is ready', started === true);
  await wait(1000);
  terminal.input('say hi');
  await wait(800);
  terminal.input('\r');
  const replied = await waitFor(() => screenText(terminal).includes(REPLY), 60);
  check('chat: the reply reached the screen', replied === true);
  if (!replied) console.log(`--- screen ---\n${screenText(terminal)}\n--- end of screen ---`);
  const turns = options.fake.requests.filter(request => request.method === 'POST' && request.path === '/chat/completions');
  check('chat: one model request reached the stand-in', turns.length === 1, `${turns.length} request(s), ${options.fake.requests.length} in all`);
  check('chat: model deepseek-flash, the fake key as the credential', turns.length > 0 && turns.every(request => request.model === 'deepseek-flash' && request.fakeKeyArrived));
  const extra = [...new Set(turns.flatMap(request => request.fields.filter(name => !REQUEST_FIELDS.has(name))))];
  check('chat: the request carries only the expected fields', turns.length > 0 && turns.every(request => request.parsed) && extra.length === 0, extra.join(',') || 'none');
  const personal = [...new Set(options.fake.requests.flatMap(request => request.personal))];
  check('chat: no rule file, skill or home path of the person in any request', personal.length === 0, personal.length ? `${personal.length} marker(s)` : 'none');
  const targets = [...new Set(session.proxy.records().map(item => `${item.target}:${item.verdict}`))];
  check('chat: egress saw only api.deepseek.com:443', targets.length > 0 && targets.every(item => item === 'api.deepseek.com:443:allowed'), targets.join(','));
  check('chat: no refusal was recorded', session.violations.length === 0, session.violations.map(item => item.target).join(',') || 'none');
  const files = sessionFiles(options.dataDir);
  const added = files.filter(name => !earlier.includes(name));
  check('chat: pi wrote its session in NAW\'s session folder', added.length === 1, added.join(','));
  await finish('chat', session, events, terminal, where);
  return files;
}

async function checkAgain(options, where, record, before) {
  const { session, events } = newSession(options, record);
  await session.start();
  const terminal = session.openTerminal();
  await waitFor(() => ready(terminal), 60);
  const reopened = await waitFor(() => screenText(terminal).includes('say hi'), 20);
  check('again: the same record opens the same pi session', reopened === true && !/creating a new session/.test(screenText(terminal)));
  const files = sessionFiles(options.dataDir);
  check('again: no second session file', JSON.stringify(files) === JSON.stringify(before), files.join(','));
  await finish('again', session, events, terminal, where);
}

function connectThrough(port, target) {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let answer = '';
    socket.on('data', part => {
      answer += part;
    });
    socket.on('close', () => resolve(answer.split('\r\n')[0]));
    socket.on('error', () => resolve(answer.split('\r\n')[0]));
  });
}

async function checkBlock(options, where) {
  const { session, events } = newSession(options, { id: 'offline-block', cwd: options.work });
  await session.start();
  const terminal = session.openTerminal();
  check('block: pi is running first', await waitFor(() => ready(terminal), 60));
  const answer = await connectThrough(session.proxy.port, BLOCKED_TARGET);
  check('block: the proxy refused the other host', answer === 'HTTP/1.1 403 Forbidden', answer);
  const ended = await waitFor(() => events.states.includes('ended'), 15);
  const notice = events.activities.find(activity => activity[1]?.key === 'notice.activity.dshEgressBlocked');
  check('block: the session reported the target', notice?.[1].params?.target === BLOCKED_TARGET, notice ? notice[0] : 'no notice');
  check('block: the session stopped by itself', ended && terminal.alive === false && terminal.nativeExited === true, events.states.join('>'));
  await waitFor(() => runtimeProcesses(where).length === 0, 10);
  check('block: no runtime process remains', runtimeProcesses(where).length === 0);
  await session.stop();
}

function witnessReader(terminal) {
  const nonce = /\(with message "(naw-pi-[0-9a-f]+)"\)/.exec(terminal.profile)?.[1];
  if (!nonce) return null;
  const out = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  const found = [];
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match && Number(match[2]) === process.pid && match[3].startsWith('/usr/bin/log stream ') && match[3].includes(nonce)) found.push(Number(match[1]));
  }
  return found.length === 1 ? found[0] : null;
}

async function checkLost(options, where) {
  const { session, events } = newSession(options, { id: 'offline-lost', cwd: options.work });
  await session.start();
  const terminal = session.openTerminal();
  check('lost: pi is running first', await waitFor(() => ready(terminal), 60));
  const reader = witnessReader(terminal);
  check('lost: the witness log reader is found', reader !== null, String(reader));
  if (reader !== null) process.kill(reader, 'SIGTERM');
  const ended = await waitFor(() => events.states.includes('ended'), 15);
  check('lost: the session reported the lost witness', events.activities.some(activity => activity[1]?.key === 'notice.activity.dshWitnessLost'));
  check('lost: the session stopped by itself', ended && terminal.alive === false && terminal.nativeExited === true, events.states.join('>'));
  await waitFor(() => runtimeProcesses(where).length === 0, 10);
  check('lost: no runtime process remains', runtimeProcesses(where).length === 0);
  await session.stop();
}

const DIALOG = /Allow (this command|writing this file|this edit|read outside the working folder)\?/;

// One message that makes the stand-in ask for a tool call; resolves once a dialog shows or the tool's
// result reached the stand-in (pi sends it on when the tool ran; a declined call ends the turn).
async function askForTool(terminal, fake, message) {
  const before = fake.requests.length;
  terminal.input(message);
  await wait(600);
  terminal.input('\r');
  const answered = () => fake.requests.slice(before).some(request => request.lastRole === 'tool');
  await waitFor(() => fake.requests.length > before && (DIALOG.test(screenText(terminal)) || answered()), 30);
  return { before, dialog: DIALOG.test(screenText(terminal)), answered };
}

// Enter on the first choice ("No"), or down then Enter for "Yes".
async function choose(terminal, allow) {
  if (allow) {
    terminal.input('\x1b[B');
    await wait(300);
  }
  terminal.input('\r');
  await waitFor(() => !DIALOG.test(screenText(terminal)), 10);
  await wait(1500);
}

async function checkConfirm(options, where) {
  const fake = options.gateFake;
  const work = options.gateWork;
  const record = { id: 'offline-confirm', cwd: work };
  const { session, events } = newSession({ ...options, fake }, record);
  await session.start();
  const terminal = session.openTerminal();
  check('confirm: pi is ready', await waitFor(() => ready(terminal), 60));
  await wait(1000);
  const ranFile = path.join(work, 'ran-by-bash.txt');
  const madeFile = path.join(work, 'made-by-write.txt');
  const editFile = path.join(work, 'edit-me.txt');
  const cases = [
    ['a command', 'go-bash', () => fs.existsSync(ranFile)],
    ['a write', 'go-write', () => fs.existsSync(madeFile)],
    ['an edit', 'go-edit', () => fs.readFileSync(editFile, 'utf8').includes('after')],
  ];
  for (const [label, message, happened] of cases) {
    const declined = await askForTool(terminal, fake, message);
    check(`confirm: ${label} waits for the person`, declined.dialog && !happened(), declined.dialog ? 'dialog' : 'no dialog');
    if (!declined.dialog) {
      console.log(`--- screen ---\n${screenText(terminal)}\n--- end of screen ---`);
      continue;
    }
    await choose(terminal, false);
    check(`confirm: ${label} the person declines does not run`, !happened() && !declined.answered());
    const allowed = await askForTool(terminal, fake, message);
    check(`confirm: ${label} asks again the next time`, allowed.dialog && !happened());
    if (!allowed.dialog) continue;
    await choose(terminal, true);
    await waitFor(() => happened() && allowed.answered(), 20);
    check(`confirm: ${label} the person allows runs`, happened() && allowed.answered());
  }
  const declinedNote = fake.requests.some(request => request.body.includes('The person did not allow this bash call.'));
  check('confirm: the model learns a call was not allowed', declinedNote);
  const inside = await askForTool(terminal, fake, 'go-read');
  await waitFor(() => inside.answered(), 20);
  check('confirm: a read in the working folder runs without asking', !inside.dialog && inside.answered());
  check('confirm: its content reached the model', fake.requests.slice(inside.before).some(request => request.body.includes(INSIDE_MARKER)));
  const outside = await askForTool(terminal, fake, 'go-read-outside');
  check('confirm: a read outside the working folder waits for the person', outside.dialog);
  if (outside.dialog) await choose(terminal, false);
  check('confirm: declined, the outside file never reaches the model', !fake.requests.some(request => request.body.includes(OUTSIDE_MARKER)));
  const declared = [...new Set(fake.requests.flatMap(request => request.tools))].sort();
  check('confirm: the model is offered pi\'s usual tools and ls', ['bash', 'edit', 'ls', 'read', 'write'].every(name => declared.includes(name)), declared.join(','));
  check('confirm: no refusal was recorded', session.violations.length === 0, session.violations.map(item => item.target).join(',') || 'none');
  await finish('confirm', session, events, terminal, where);
}

async function checkNoGate(options, where) {
  const fake = options.gateFake;
  const failing = newSession({ ...options, fake }, { id: 'offline-gate-fails', cwd: options.gateWork }, 'throw new Error("gate failed on purpose");\n');
  await failing.session.start();
  const failed = failing.session.openTerminal();
  await waitFor(() => ready(failed) || !failed.alive, 60);
  const refusal = /Failed to load extension .*gate failed on purpose/s.test(screenText(failed).replace(/\n/g, ''));
  check('no gate: a gate that fails to load stops pi', !failed.alive && failing.events.states.includes('ended') && refusal, failing.events.states.join('>'));
  await failing.session.stop();
  await waitFor(() => runtimeProcesses(where).length === 0, 10);
  const { session, events } = newSession({ ...options, fake }, { id: 'offline-no-gate', cwd: options.gateWork }, 'export default function () {}\n');
  await session.start();
  const terminal = session.openTerminal();
  check('no gate: pi is ready', await waitFor(() => ready(terminal), 60));
  await wait(1000);
  const before = fake.requests.length;
  terminal.input('say hi');
  await wait(600);
  terminal.input('\r');
  await waitFor(() => fake.requests.length > before && screenText(terminal).includes(REPLY), 30);
  const turns = fake.requests.slice(before);
  check('no gate: the model is offered no tools', turns.length > 0 && turns.every(request => request.tools.length === 0), turns.map(request => request.tools.join(',')).join(' | '));
  await finish('no gate', session, events, terminal, where);
}

async function main() {
  const { dataDir } = parseArguments(process.argv.slice(2));
  const where = await piTui.verifyRuntime(dataDir);
  console.log(`runtime verified: ${where.root}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-pi-tui-check-'));
  let fake = null;
  let gateFake = null;
  try {
    const certificate = makeCertificate(dir);
    fake = await startFakeDeepSeek(certificate);
    const work = path.join(dir, 'work');
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(work, 'AGENTS.md'), `${CANARY}\n`);
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `${CANARY}\n`);
    const options = { dataDir, work, fake, certificate };
    const record = { id: 'offline-chat', cwd: work };
    const files = await checkChat(options, where, record);
    await checkAgain(options, where, record, files);
    await checkBlock(options, where);
    await checkLost(options, where);
    const gateWork = path.join(dir, 'gate-work');
    fs.mkdirSync(gateWork);
    fs.writeFileSync(path.join(gateWork, 'edit-me.txt'), 'before\n');
    fs.writeFileSync(path.join(gateWork, 'inside.txt'), `${INSIDE_MARKER}\n`);
    const outsideFile = path.join(dir, 'outside.txt');
    fs.writeFileSync(outsideFile, `${OUTSIDE_MARKER}\n`);
    gateFake = await startFakeDeepSeek(certificate, { outsideFile });
    await checkConfirm({ ...options, gateFake, gateWork }, where);
    await checkNoGate({ ...options, gateFake, gateWork }, where);
    const holding = filesHolding(piTui.paths(dataDir).base, FAKE_KEY);
    check('after: no file in pi\'s home or sessions holds the key', holding.length === 0, holding.join(',') || 'none');
  } finally {
    if (fake) await fake.close();
    if (gateFake) await gateFake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const failed = results.filter(item => !item.passed);
  console.log(`${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(`pi-tui-offline-check: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
