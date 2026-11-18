'use strict';
// Deterministic clocks around the real witness; the system clock stays unchanged.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');

async function fixture() {
  const clock = { mono: 0, wall: 1700000000000 }, timers = new Map(), immediates = [];
  const sent = [], lost = [], gaps = [], denials = [];
  let id = 0, auto = false;
  const schedule = (fn, ms, interval = 0) => {
    const key = ++id;
    timers.set(key, { fn, at: clock.mono + ms, interval });
    return key;
  };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.wall])); }
    static now() { return clock.wall; }
  }
  const reader = new EventEmitter(), canary = new EventEmitter();
  reader.stdout = new PassThrough(); reader.signals = [];
  reader.kill = signal => { reader.signals.push(signal); return true; };
  canary.pid = 901; canary.stdin = new PassThrough(); canary.signals = [];
  canary.kill = signal => { canary.signals.push(signal); return true; };
  const mod = { exports: {} };
  const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../../..');
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app/dsh-witness.cjs'), 'utf8'), {
    module: mod, exports: mod.exports, require, Date: ClockDate, performance: { now: () => clock.mono },
    setTimeout: (fn, ms) => schedule(fn, ms), clearTimeout: key => timers.delete(key),
    setInterval: (fn, ms) => schedule(fn, ms, ms), clearInterval: key => timers.delete(key),
    setImmediate: fn => immediates.push(fn),
  });
  const report = (seq, stamp) => {
    const row = sent[seq - 1];
    reader.stdout.write(JSON.stringify({ timestamp: new Date(stamp ?? row.wall).toISOString(),
      eventMessage: `Sandbox: node(901) deny(1) network-outbound remote:*:${row.port}\nnaw-dsh-clock-test` }) + '\n');
  };
  canary.stdin.on('data', chunk => {
    const row = { seq: sent.length + 1, port: Number(String(chunk).trim()), wall: clock.wall, at: clock.mono };
    sent.push(row);
    if (auto) report(row.seq);
  });
  const flush = () => { while (immediates.length) immediates.shift()(); };
  const pending = mod.exports.startWitness({ nonce: 'naw-dsh-clock-test', runCanary: () => canary,
    spawn: () => reader, onDenial: denial => denials.push(denial),
    onLost: reason => lost.push({ reason, at: clock.mono }), onGap: gap => gaps.push(gap) });
  reader.stdout.write('header\n'); report(1);
  const armed = await pending;
  flush();
  const advance = ms => {
    const end = clock.mono + ms;
    let count = 0;
    for (;;) {
      let key = null, timer = null;
      for (const [k, value] of timers) if (value.at <= end && (!timer || value.at < timer.at)) { key = k; timer = value; }
      if (!timer) break;
      if (++count > 100000) throw Error('clock fixture timer budget');
      clock.wall += timer.at - clock.mono; clock.mono = timer.at;
      if (timer.interval) timers.set(key, { ...timer, at: timer.at + timer.interval }); else timers.delete(key);
      timer.fn(); flush();
    }
    clock.wall += end - clock.mono; clock.mono = end; flush();
  };
  return { clock, reader, canary, sent, lost, gaps, denials, report, advance, armed,
    set auto(value) { auto = value; }, close: () => armed.close() };
}
module.exports = { fixture };
