'use strict';
// The record of every connection the DSH TUI sandbox refuses. The kernel
// reports each refusal to the unified log, tagged with the session's nonce by
// the profile's `(with message ...)`; NAW reads that log, so a refusal by any
// process in the session's tree (a tool child, a DNS lookup, a socket bind)
// leaves a record, not only what passes the egress proxy. The witness is
// trusted only after a canary process, run under the same profile, has made
// one refused connection, its report has arrived and every canary has exited.
const { spawn: spawnProcess } = require('node:child_process');

const LOG = '/usr/bin/log';
const ARM_TIMEOUT_MS = 10000;
const CANARY_INTERVAL_MS = 500;
// The canary's one refused connection, as the kernel reports it.
const CANARY_PORT = 1;
const CANARY_OPERATION = 'network-outbound';
const CANARY_TARGET = `remote:*:${CANARY_PORT}`;
// After SIGTERM, how long a canary has to exit before the witness gives up.
const CANARY_EXIT_MS = 5000;
// A canary's own report may arrive after it exits; after this its PID can
// belong to another process, whose refusals are recorded like any other.
const CANARY_REPORT_MS = 5000;
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

// `runCanary()` starts one sandboxed process that connects to CANARY_PORT on
// the loopback and returns it (a ChildProcess: `pid`, `kill()`, 'exit').
// Resolves once a canary's report has arrived and every canary has exited;
// canaries still running then get SIGTERM, never SIGKILL, and one that does
// not exit refuses the witness. Rejects, with the log reader and the
// canaries stopped, if that does not happen in time. After arming, every
// other report goes to `onDenial`, and the log reader ending before
// `close()` goes to `onLost`. `spawn` and the times are replaced only in tests.
function startWitness({
  nonce,
  runCanary,
  onDenial,
  onLost = () => {},
  spawn = spawnProcess,
  armTimeoutMs = ARM_TIMEOUT_MS,
  canaryExitMs = CANARY_EXIT_MS,
  canaryReportMs = CANARY_REPORT_MS,
}) {
  if (!validNonce(nonce)) throw Error('DSH witness: invalid nonce');
  const predicate = `senderImagePath ENDSWITH "/Sandbox" AND eventMessage CONTAINS "${nonce}"`;
  return new Promise((resolve, reject) => {
    const reader = spawn(LOG, ['stream', '--style', 'ndjson', '--predicate', predicate], { stdio: ['ignore', 'pipe', 'ignore'] });
    // pid -> { child, exitedAt, ended }; exitedAt is null while it runs.
    const canaries = new Map();
    // arming: no canary report yet. settling: one arrived, the canaries are
    // exiting. armed: resolved. closed: stopped or failed.
    let phase = 'arming';
    let pending = '';
    let canaryTimer = null;
    let deadline = null;
    const stopTimers = () => {
      clearTimeout(deadline);
      clearInterval(canaryTimer);
    };
    const witness = {
      get armed() {
        return phase === 'armed';
      },
      close() {
        phase = 'closed';
        stopTimers();
        reader.kill('SIGTERM');
      },
    };
    const running = () => {
      const found = [];
      for (const canary of canaries.values()) {
        if (canary.exitedAt === null) found.push(canary);
      }
      return found;
    };
    const endCanaries = () => {
      for (const canary of running()) {
        if (canary.ended) continue;
        canary.ended = true;
        canary.child.kill('SIGTERM');
      }
    };
    const fail = error => {
      if (phase === 'armed' || phase === 'closed') return;
      witness.close();
      endCanaries();
      reject(error);
    };
    const settle = () => {
      if (phase !== 'settling' || running().length > 0) return;
      clearTimeout(deadline);
      phase = 'armed';
      resolve(witness);
    };
    deadline = setTimeout(() => fail(Error('DSH witness: no canary report')), armTimeoutMs);
    const startCanary = () => {
      let child;
      try {
        child = runCanary();
      } catch (error) {
        fail(error);
        return;
      }
      // A canary that did not start never reports; the deadline covers it.
      if (!child || !Number.isInteger(child.pid)) return;
      const canary = { child, exitedAt: null, ended: false };
      canaries.set(child.pid, canary);
      child.once('exit', () => {
        canary.exitedAt = Date.now();
        settle();
      });
    };
    // The canary's own probe, from a PID that is still that canary: it runs,
    // or exited so recently that the PID cannot have been reused.
    const fromCanary = denial => {
      const canary = canaries.get(denial.pid);
      if (canary === undefined) return false;
      if (denial.operation !== CANARY_OPERATION || denial.target !== CANARY_TARGET) return false;
      return canary.exitedAt === null || Date.now() - canary.exitedAt <= canaryReportMs;
    };
    const handle = denial => {
      if (phase === 'closed') return;
      if (fromCanary(denial)) {
        // A later canary report, or a repeat of one, changes nothing.
        if (phase !== 'arming') return;
        phase = 'settling';
        stopTimers();
        endCanaries();
        deadline = setTimeout(() => fail(Error('DSH witness: a canary did not exit')), canaryExitMs);
        settle();
        return;
      }
      try {
        onDenial(denial);
      } catch {
        // The refusal already happened in the kernel; a failing listener changes nothing.
      }
    };
    const readLine = line => {
      if (!line.startsWith('{')) {
        // The header: the stream is starting. Canaries repeat until one is seen.
        if (canaryTimer === null && phase === 'arming') {
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
      if (phase === 'arming' || phase === 'settling') {
        fail(Error('DSH witness: the log reader ended'));
        return;
      }
      if (phase === 'closed') return;
      phase = 'closed';
      stopTimers();
      onLost();
    };
    reader.on('error', ended);
    reader.on('exit', ended);
  });
}

module.exports = { LOG, CANARY_PORT, validNonce, parseDenial, startWitness };
