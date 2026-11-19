'use strict';
// Keep F's five r3 counterexamples together, against the real witness and
// runtime. The added stdin only accommodates r4's persistent canary contract;
// no real PID, signal, socket, log reader, key or model is used here.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const witness = require('../dsh-witness.cjs');
const { DshTui } = require('../dsh-tui.cjs');

class Reader extends EventEmitter {
  constructor() { super(); this.stdout = new PassThrough(); }
  kill() { return true; }
  report(program, port) {
    this.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), eventMessage:
      `Sandbox: ${program} deny(1) network-outbound remote:*:${port}\nnaw-dsh-review-r3` }) + '\n');
  }
}

class Canary extends EventEmitter {
  constructor() { super(); this.pid = 901; this.stdin = new PassThrough(); this.exited = false; }
  kill(signal) {
    setImmediate(() => { this.exited = true; this.emit('exit', null, signal); });
    return true;
  }
}

test('all five F r3 PID/port counterexamples leave a recorded stop after the canary exits', async () => {
  const cases = [
    { program: 'curl(901)', port: 1, delay: 1000 },
    { program: 'node(901)', port: 1, delay: 1000 },
    { program: 'curl(901)', port: 443, delay: 1000 },
    { program: 'node(901)', port: 1, delay: 5001 },
    { program: 'node(902)', port: 1, delay: 1000 },
  ];
  const rows = [];
  for (const sample of cases) {
    const reader = new Reader(), canary = new Canary();
    const runtime = new DshTui({ id: 'synthetic', cwd: '/synthetic' }, { dataDir: '/synthetic' });
    let stops = 0, armed;
    runtime.terminal = { alive: false, stop: async () => { stops++; } };
    const originalNow = Date.now;
    let now = 1700000000000;
    Date.now = () => now;
    try {
      const pending = witness.startWitness({
        nonce: 'naw-dsh-review-r3', runCanary: () => canary, spawn: () => reader,
        onDenial: denial => runtime.blocked({ source: 'sandbox', pid: denial.pid,
          operation: denial.operation, target: `${denial.target} (${denial.process})` }),
        onLost: reason => runtime.witnessLost(reason), armTimeoutMs: 1000,
      });
      reader.stdout.write('header\n');
      reader.report('node(901)', 1);
      armed = await pending;
      if (!canary.exited) { canary.exited = true; canary.emit('exit', 0, null); }
      now += sample.delay;
      reader.report(sample.program, sample.port);
      await new Promise(resolve => setImmediate(resolve));
      rows.push({ ...sample, stops, violations: runtime.violations.length,
        source: runtime.violations[0]?.source, pass: stops === 1 && runtime.violations.length === 1 });
    } finally {
      Date.now = originalNow;
      armed?.close();
    }
  }
  console.log(JSON.stringify({ pass: rows.filter(row => row.pass).length,
    fail: rows.filter(row => !row.pass).length, rows }));
  assert.deepEqual(rows.map(row => row.pass), cases.map(() => true));
});

test('an open reader that goes silent after its first canary report stops the session', async () => {
  const reader = new Reader(), canary = new Canary();
  const runtime = new DshTui({ id: 'synthetic', cwd: '/synthetic' }, { dataDir: '/synthetic' });
  let stops = 0, armed;
  runtime.terminal = { alive: false, stop: async () => { stops++; } };
  try {
    const pending = witness.startWitness({
      nonce: 'naw-dsh-review-r3', runCanary: () => canary, spawn: () => reader,
      onDenial: denial => runtime.blocked({ source: 'sandbox', ...denial }),
      onLost: reason => runtime.witnessLost(reason), armTimeoutMs: 1000,
      beatMs: 10, beatReportMs: 40,
    });
    reader.stdout.write('header\n');
    reader.report('node(901)', 1);
    armed = await pending;
    // No more reports and no reader exit/error event. The old one-shot
    // witness stays armed here; the persistent witness must fail closed.
    await new Promise(resolve => setTimeout(resolve, 150));
    console.log(JSON.stringify({ openReaderSilent: true, stops, violations: runtime.violations }));
    assert.equal(stops, 1);
    assert.deepEqual(runtime.violations.map(row => [row.source, row.target]), [['witness', 'witness-silent']]);
  } finally {
    armed?.close();
  }
});
