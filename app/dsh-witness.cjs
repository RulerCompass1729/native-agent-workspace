'use strict';
// The record of every connection the DSH TUI sandbox refuses. The kernel
// reports each refusal to the unified log, tagged with the session's nonce by
// the profile's `(with message ...)`; NAW reads that log, so a refusal by any
// process in the session's tree (a tool child, a DNS lookup, a socket bind)
// leaves a record, not only what passes the egress proxy. The witness is
// trusted only after a canary process, run under the same profile, has made
// one refused connection and its report has arrived.
const { spawn: spawnProcess } = require('node:child_process');

const LOG = '/usr/bin/log';
const ARM_TIMEOUT_MS = 10000;
const CANARY_INTERVAL_MS = 500;
// "Sandbox: node(4242) deny(1) network-outbound /private/var/run/mDNSResponder"
// A repeated refusal arrives as "1 duplicate report for Sandbox: ...".
const DENIAL = /Sandbox: (.+?)\((\d+)\) deny\(\d+\) (\S+)(?: (.*))?$/;

function validNonce(nonce) {
  return typeof nonce === 'string' && /^[a-z0-9-]{12,64}$/.test(nonce);
}

// The first line of the kernel's message; the nonce follows on the next line.
function parseDenial(message) {
  const first = String(message || '').split('\n')[0];
  const match = DENIAL.exec(first);
  if (!match) return null;
  return {
    process: match[1],
    pid: Number(match[2]),
    operation: match[3],
    target: (match[4] || '').trim(),
  };
}

// `runCanary()` starts one sandboxed process that makes a refused connection
// and returns it (anything with a `pid`). Resolves once the witness is armed;
// rejects, with the log reader stopped, if no canary report arrives in time.
// After arming, every other report goes to `onDenial`, and the log reader
// ending before `close()` goes to `onLost`. `spawn` is replaced only in tests.
function startWitness({ nonce, runCanary, onDenial, onLost = () => {}, spawn = spawnProcess, armTimeoutMs = ARM_TIMEOUT_MS }) {
  if (!validNonce(nonce)) throw Error('DSH witness: invalid nonce');
  const predicate = `senderImagePath ENDSWITH "/Sandbox" AND eventMessage CONTAINS "${nonce}"`;
  return new Promise((resolve, reject) => {
    const reader = spawn(LOG, ['stream', '--style', 'ndjson', '--predicate', predicate], { stdio: ['ignore', 'pipe', 'ignore'] });
    const canaries = new Set();
    let armed = false;
    let closed = false;
    let pending = '';
    let canaryTimer = null;
    let deadline = null;
    const stopTimers = () => {
      clearTimeout(deadline);
      clearInterval(canaryTimer);
    };
    const witness = {
      get armed() {
        return armed;
      },
      close() {
        closed = true;
        stopTimers();
        reader.kill('SIGTERM');
      },
    };
    const fail = error => {
      if (armed || closed) return;
      witness.close();
      reject(error);
    };
    deadline = setTimeout(() => fail(Error('DSH witness: no canary report')), armTimeoutMs);
    const startCanary = () => {
      try {
        const canary = runCanary();
        if (canary && Number.isInteger(canary.pid)) canaries.add(canary.pid);
      } catch (error) {
        fail(error);
      }
    };
    const handle = denial => {
      if (canaries.has(denial.pid)) {
        if (armed || closed) return;
        armed = true;
        stopTimers();
        resolve(witness);
        return;
      }
      if (closed) return;
      try {
        onDenial(denial);
      } catch {
        // The refusal already happened in the kernel; a failing listener changes nothing.
      }
    };
    const readLine = line => {
      if (!line.startsWith('{')) {
        // The header: the stream is starting. Canaries repeat until one is seen.
        if (canaryTimer === null && !armed && !closed) {
          startCanary();
          canaryTimer = setInterval(startCanary, CANARY_INTERVAL_MS);
        }
        return;
      }
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      const denial = parseDenial(event.eventMessage);
      if (denial) handle(denial);
    };
    reader.stdout.setEncoding('utf8');
    reader.stdout.on('data', chunk => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) readLine(line.trim());
    });
    const ended = () => {
      if (!armed) {
        fail(Error('DSH witness: the log reader ended'));
        return;
      }
      if (closed) return;
      closed = true;
      stopTimers();
      onLost();
    };
    reader.on('error', ended);
    reader.on('exit', ended);
  });
}

module.exports = { LOG, validNonce, parseDenial, startWitness };
