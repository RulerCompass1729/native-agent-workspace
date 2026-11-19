'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
const path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { startWitness } = require(path.join(root, 'app/dsh-witness.cjs'));
const { DshTui } = require(path.join(root, 'app/dsh-tui.cjs'));

test('normal session survives the measured eight-report gap while reader and canary stay alive', async () => {
  const reader = new EventEmitter(), canary = new EventEmitter(), timers = [];
  reader.stdout = new PassThrough();
  reader.kill = () => true;
  canary.pid = 901; canary.stdin = new PassThrough(); canary.kill = () => true;
  let sent = 0, stops = 0, returned = 0, armed;
  const gaps = [];
  const runtime = new DshTui({ id: 'synthetic', cwd: '/synthetic' }, { dataDir: '/synthetic' });
  runtime.terminal = { alive: true, stop: async () => { stops++; } };
  canary.stdin.on('data', chunk => {
    for (const line of String(chunk).trim().split('\n')) {
      const port = Number(line); sent++;
      // The 5-minute kernel probe saw eight refusals missing between two
      // reports 2261–2267ms apart, although every refusal returned EPERM.
      if (sent >= 2 && sent <= 9) continue;
      timers.push(setTimeout(() => { returned++; reader.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), eventMessage:
        `Sandbox: node(901) deny(1) network-outbound remote:*:${port}\nnaw-dsh-false-stop-red` }) + '\n'); }, 0));
    }
  });
  try {
    const pending = startWitness({ nonce: 'naw-dsh-false-stop-red', runCanary: () => canary,
      spawn: () => reader, onDenial: denial => runtime.blocked({ source: 'sandbox', ...denial }),
      onLost: reason => runtime.witnessLost(reason), onGap: gap => gaps.push(gap) });
    reader.stdout.write('header\n'); armed = await pending;
    await new Promise(resolve => setTimeout(resolve, 2800));
    console.log(JSON.stringify({ productionBeatMs: 250,
      missingReports: 8, sent, returned, stops, violations: runtime.violations }));
    assert.equal(stops, 0, 'a live, normally idle session must survive this measured reporting gap');
    assert.deepEqual(runtime.violations, []);
    assert.equal(gaps.length, 1);
    assert.deepEqual([gaps[0].from, gaps[0].to, gaps[0].missing], [2, 9, 8]);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    armed?.close();
  }
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, { beatMs = 10, beatReportMs = 100 } = {}) {
  const reader = new EventEmitter(), canary = new EventEmitter(), sent = [], lost = [], gaps = [];
  reader.stdout = new PassThrough(); reader.kill = () => true;
  canary.pid = 901; canary.stdin = new PassThrough(); canary.kill = () => true;
  canary.stdin.on('data', chunk => sent.push({ port: Number(String(chunk).trim()), stamp: Date.now() }));
  const report = (port, stamp = Date.now()) => reader.stdout.write(JSON.stringify({ timestamp: new Date(stamp).toISOString(),
    eventMessage: `Sandbox: node(901) deny(1) network-outbound remote:*:${port}\nnaw-dsh-freshness-test` }) + '\n');
  const pending = startWitness({ nonce: 'naw-dsh-freshness-test', runCanary: () => canary, spawn: () => reader,
    onDenial: () => assert.fail('no non-beat refusal expected'), onLost: reason => lost.push(reason),
    onGap: gap => gaps.push(gap), beatMs, beatReportMs });
  reader.stdout.write('header\n');
  report(1);
  const armed = await pending;
  t.after(() => armed.close());
  return { reader, canary, sent, lost, gaps, report, armed };
}

test('duplicate and out-of-order reports do not renew the latest confirmed sequence', async t => {
  const run = await fixture(t);
  await wait(35);
  const newer = run.sent.at(-1);
  run.report(newer.port);
  assert.equal(run.armed.beats, 2);
  const replay = setInterval(() => {
    run.report(newer.port);
    run.report(2);
  }, 10);
  try {
    await wait(160);
    assert.equal(run.armed.beats, 2);
    assert.deepEqual(run.lost, ['witness-silent']);
  } finally { clearInterval(replay); }
});

test('an old timestamp cannot acknowledge a reused port', async t => {
  const run = await require('./helpers/dsh-witness-clock.cjs').fixture();
  t.after(() => run.close());
  run.auto = true; run.advance(249500); run.auto = false;
  const confirmed = run.armed.beats;
  run.advance(250);
  assert.ok(run.sent.length >= 1000, 'the port actually wrapped');
  assert.equal(run.sent[999].port, run.sent[0].port);
  run.report(1); // original wire timestamp, default 250ms beat
  assert.equal(run.armed.beats, confirmed, 'stale report must not acknowledge the new use of port 1');
  run.report(1000);
  assert.equal(run.armed.beats, confirmed + 1, 'a current report of a newer sequence renews');
  assert.deepEqual(run.lost, []);
});

test('queued fresh output cannot revive a lease whose deadline already elapsed', async t => {
  const run = await fixture(t, { beatMs: 10, beatReportMs: 60 });
  await wait(20);
  const latest = run.sent.at(-1);
  // Hold the event loop across expiry, then deliver before timers can judge.
  const until = performance.now() + 70;
  while (performance.now() < until) {}
  run.report(latest.port);
  assert.deepEqual(run.lost, ['witness-silent']);
  assert.equal(run.armed.beats, 1);
});
