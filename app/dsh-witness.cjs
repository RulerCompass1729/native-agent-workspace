'use strict';
// The record of every connection the DSH TUI sandbox refuses. The kernel
// reports each refusal to the unified log, tagged with the session's nonce by
// the profile's `(with message ...)`; NAW reads that log, so a refusal by any
// process in the session's tree (a tool child, a DNS lookup, a socket bind)
// leaves a record, not only what passes the egress proxy.
// The observed log channel omits some reports, also absent from historical
// queries. Node.js canary gaps measured on 2026-11-18 reached 2267 ms, roughly
// once a minute, while every operation still returned EPERM. So a canary
// process runs beside the session for as long as it
// lasts, under the same profile and with the same Node.js, and makes one
// refused connection every BEAT_MS: a beat. The witness arms on the first
// beat's report. After that, only a newer, timely beat renews a bounded
// freshness lease. Short report gaps are recorded; loss of progress ends
// the lease and stops the session. Kernel refusals remain unchanged.
const { spawn: spawnProcess } = require('node:child_process');

const LOG = '/usr/bin/log';
const ARM_TIMEOUT_MS = 10000;
const BEAT_MS = 250;
// Approved offline candidate: ordinary log gaps measured up to 2267ms.
// This is a freshness bound, not a promise that every refusal was logged.
const BEAT_REPORT_MS = 3000;
// Each beat connects to the next loopback port in 1..BEAT_PORTS. A new port
// each time keeps the kernel from folding beats into one duplicate report,
// and each report names its beat.
const BEAT_PORTS = 999;
const BEAT_OPERATION = 'network-outbound';
const BEAT_TARGET = /^remote:\*:(\d+)$/;
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

// `runCanary()` starts the canary and returns it (a ChildProcess: `pid`, a
// writable `stdin`, `kill()`, 'exit'). For each port number written to its
// input as one line, it connects once to that loopback port; it exits when
// its input ends. Resolves with the witness once a beat's report has arrived.
// Rejects, with the log reader and the canary stopped, if none arrives in
// time or either of them ends first. After arming, every report that is not
// a beat's goes to `onDenial`, and `onLost(reason)` is called once when the
// witness can no longer vouch for the record: 'witness-lost' when the log
// reader ends, 'witness-silent' when fresh reports stop, or the canary
// ends or stops taking beats. close() ends the log reader and the canary with
// SIGTERM, never SIGKILL. `spawn` and the times are replaced only in tests.
function startWitness({
  nonce,
  runCanary,
  onDenial,
  onLost = () => {},
  onGap = () => {},
  spawn = spawnProcess,
  armTimeoutMs = ARM_TIMEOUT_MS,
  beatMs = BEAT_MS,
  beatReportMs = BEAT_REPORT_MS,
}) {
  if (!validNonce(nonce)) throw Error('DSH witness: invalid nonce');
  const predicate = `senderImagePath ENDSWITH "/Sandbox" AND eventMessage CONTAINS "${nonce}"`;
  return new Promise((resolve, reject) => {
    const reader = spawn(LOG, ['stream', '--style', 'ndjson', '--predicate', predicate], { stdio: ['ignore', 'pipe', 'ignore'] });
    // { child, exited }, from the stream's header on.
    let canary = null;
    // Beats whose report has not arrived: port -> sequence and send times.
    const waiting = new Map();
    let port = 0;
    let beats = 0;
    let sequence = 0;
    let confirmed = null;
    // arming: no beat report yet. armed: resolved. closed: stopped, refused or lost.
    let phase = 'arming';
    let pending = '';
    let beatTimer = null;
    let armDeadline = null;
    let freshnessDeadline = null;
    const witness = {
      get armed() {
        return phase === 'armed';
      },
      // Beats whose report arrived (read by the sandbox check).
      get beats() {
        return beats;
      },
      close() {
        if (phase === 'closed') return;
        phase = 'closed';
        clearTimeout(armDeadline);
        clearInterval(beatTimer);
        clearTimeout(freshnessDeadline);
        reader.kill('SIGTERM');
        if (canary !== null && !canary.exited) {
          canary.child.stdin.end();
          canary.child.kill('SIGTERM');
        }
      },
    };
    const fail = error => {
      if (phase !== 'arming') return;
      witness.close();
      reject(error);
    };
    const lose = reason => {
      if (phase !== 'armed') return;
      witness.close();
      onLost(reason);
    };
    // Before arming, trouble refuses the witness; after, it loses it.
    const broken = (problem, reason) => {
      if (phase === 'arming') {
        fail(Error(`DSH witness: ${problem}`));
        return;
      }
      lose(reason);
    };
    let clockFloor = -Infinity;
    const trustedClock = () => {
      // Bound clock offset across the wall read; allow 1ms rounding and one beat.
      // A backward mapping makes reused ports ambiguous: fail closed.
      const before = performance.now(), wall = Date.now(), at = performance.now();
      if (!Number.isFinite(wall) || !Number.isFinite(at) || at < before || wall + 1 - before + beatMs < clockFloor) {
        broken('the clock mapping moved backwards', 'witness-silent');
        return null;
      }
      clockFloor = Math.max(clockFloor, wall - at);
      return { wall, at };
    };
    armDeadline = setTimeout(() => fail(Error('DSH witness: no canary report')), armTimeoutMs);
    // Timers use monotonic send time. Neither a new send nor a replay renews
    // the lease; a report must advance the confirmed sequence before expiry.
    const judge = () => {
      if (phase === 'closed') return;
      const clock = trustedClock();
      if (!clock) return;
      const now = clock.at;
      if (phase === 'armed') {
        if (now - confirmed.at >= beatReportMs) lose('witness-silent');
        else {
          clearTimeout(freshnessDeadline);
          freshnessDeadline = setTimeout(judge, Math.max(1, beatReportMs - (now - confirmed.at)));
        }
        return;
      }
      for (const [beatPort, sent] of waiting) {
        if (now - sent.at <= beatReportMs) continue;
        // Before arming a missing report only delays arming.
        waiting.delete(beatPort);
      }
    };
    const beat = () => {
      if (phase === 'closed') return;
      const clock = trustedClock();
      if (!clock) return;
      port = (port % BEAT_PORTS) + 1;
      waiting.set(port, { seq: ++sequence, ...clock });
      canary.child.stdin.write(`${port}\n`);
      setImmediate(judge);
    };
    const startCanary = () => {
      let child;
      try {
        child = runCanary();
      } catch (error) {
        fail(error);
        return;
      }
      if (!child || !Number.isInteger(child.pid) || !child.stdin) {
        fail(Error('DSH witness: the canary did not start'));
        return;
      }
      canary = { child, exited: false };
      child.stdin.on('error', () => broken('the canary stopped taking beats', 'witness-silent'));
      child.on('error', () => broken('the canary failed', 'witness-silent'));
      child.once('exit', () => {
        canary.exited = true;
        broken('the canary ended', 'witness-silent');
      });
      beat();
      if (phase !== 'closed') beatTimer = setInterval(beat, beatMs);
    };
    // The port of a beat, if this is the running canary's report of one.
    const beatOf = denial => {
      if (canary === null || canary.exited || denial.pid !== canary.child.pid) return null;
      if (denial.operation !== BEAT_OPERATION) return null;
      const match = BEAT_TARGET.exec(denial.target);
      if (!match) return null;
      const beatPort = Number(match[1]);
      return beatPort >= 1 && beatPort <= BEAT_PORTS ? beatPort : null;
    };
    const handle = (denial, stamp) => {
      if (phase === 'closed') return;
      const clock = trustedClock();
      if (!clock) return;
      if (phase === 'armed' && clock.at - confirmed.at >= beatReportMs) {
        lose('witness-silent');
        return;
      }
      const beatPort = beatOf(denial);
      if (beatPort !== null) {
        const sent = waiting.get(beatPort);
        // A late or repeated report of a beat changes nothing.
        if (!sent || !Number.isFinite(stamp) || stamp < sent.wall) return;
        waiting.delete(beatPort);
        if (confirmed && sent.seq <= confirmed.seq) return;
        if (performance.now() - sent.at >= beatReportMs) return;
        const missed = [...waiting.values()].filter(item => item.seq < sent.seq);
        for (const [key, item] of waiting) if (item.seq < sent.seq) waiting.delete(key);
        if (phase === 'armed' && missed.length) {
          try { onGap({ at: Date.now(), from: missed[0].seq, to: missed.at(-1).seq,
            missing: missed.length, elapsedMs: Math.round(performance.now() - missed[0].at) }); } catch {}
        }
        confirmed = sent;
        beats++;
        if (phase === 'arming') {
          // Earlier beats were before the session; only later ones count.
          phase = 'armed';
          clearTimeout(armDeadline);
          resolve(witness);
        }
        judge();
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
        // The header: the stream is starting, so the beats can begin.
        if (canary === null && phase === 'arming') startCanary();
        return;
      }
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      const denial = parseDenial(event.eventMessage);
      const stamp = Date.parse(String(event.timestamp || '').replace(' ', 'T')
        .replace(/(\.\d{3})\d*/, '$1').replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
      if (denial) handle(denial, stamp);
    };
    reader.stdout.setEncoding('utf8');
    reader.stdout.on('data', chunk => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) readLine(line.trim());
    });
    const ended = () => broken('the log reader ended', 'witness-lost');
    reader.on('error', ended);
    reader.on('exit', ended);
  });
}

module.exports = { LOG, BEAT_PORTS, validNonce, parseDenial, startWitness };
