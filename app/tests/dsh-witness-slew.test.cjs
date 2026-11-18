'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture } = require('./helpers/dsh-witness-clock.cjs');

function healthy(f, duration) {
  let minWallDelta = Infinity;
  for (let index = 1; index < f.sent.length; index++) minWallDelta = Math.min(minWallDelta, f.sent[index].wall - f.sent[index - 1].wall);
  console.log(JSON.stringify({ duration, sends: f.sent.length, beats: f.armed.beats, minWallDelta, lost: f.lost }));
  assert.ok(minWallDelta > 0, 'wall time is increasing at every send');
  assert.equal(f.lost.length, 0, 'genuine reports under a smooth correction must keep the session alive');
  assert.equal(f.armed.beats, Math.floor(duration / 250) + 1);
  assert.equal(f.denials.length, 0);
}

for (const ppm of [0, 500, -500, -100, -5000])
test(`continuous ${ppm}ppm wall-clock rate stays live`, async t => {
  const f = await fixture({ wallClock: clock => 1700000000000 + Math.floor(clock.mono * (1 + ppm / 1000000)) });
  t.after(() => f.close());
  const duration = ppm === -100 ? 3000000 : 600000;
  f.auto = true; f.advance(duration);
  healthy(f, duration);
});

for (const spec of [
  { name: 'stable', step: 0, every: 2000, total: 600000 },
  { name: 'one -100ms correction', step: -100, every: 600000, total: 600000, once: true },
  { name: '-500ppm until -200ms then stable', step: -1, every: 2000, total: 600000, limit: 200 },
  { name: '+500ppm', step: 1, every: 2000, total: 600000 },
  { name: '-500ppm', step: -1, every: 2000, total: 600000 },
  { name: '-100ppm', step: -1, every: 10000, total: 3000000 },
])
test(`stepped clock correction ${spec.name} stays live`, async t => {
  const f = await fixture(); t.after(() => f.close());
  f.auto = true;
  let correction = 0;
  for (let at = 0; at < spec.total; at += spec.every) {
    if ((!spec.once || at === 0) && (spec.limit === undefined || Math.abs(correction) < spec.limit)) {
      f.clock.wall += spec.step; correction += spec.step;
    }
    f.advance(Math.min(spec.every, spec.total - at));
    if (f.lost.length) break;
  }
  healthy(f, spec.total);
});

test('a slower wall clock leaves the monotonic lease at exactly 3000ms', async t => {
  const f = await fixture({ wallClock: clock => 1700000000000 + Math.floor(clock.mono * .9995) });
  t.after(() => f.close());
  f.auto = true; f.advance(600000);
  assert.equal(f.lost.length, 0);
  const lastGenuine = f.clock.mono;
  f.auto = false; f.advance(2999);
  assert.equal(f.lost.length, 0);
  f.advance(1);
  assert.equal(f.lost.length, 1);
  assert.equal(f.lost[0].at, lastGenuine + 3000);
});

for (const rollbackMs of [249750, 300000])
test(`old reports cannot renew after long slewing then ${rollbackMs}ms rollback`, async t => {
  const f = await fixture(); t.after(() => f.close());
  f.auto = true;
  for (let index = 0; index < 300; index++) { f.clock.wall -= 1; f.advance(2000); }
  assert.equal(f.lost.length, 0);
  const beats = f.armed.beats, lastGenuine = f.clock.mono;
  const oldSequence = f.sent.length + 1 - 999;
  const nextPort = (f.sent.at(-1).port % 999) + 1;
  f.auto = false; f.clock.wall -= rollbackMs; f.advance(250);
  assert.equal(f.sent[oldSequence - 1].port, nextPort);
  f.report(oldSequence);
  f.advance(3250);
  assert.equal(f.armed.beats, beats);
  assert.equal(f.lost.length, 1);
  assert.ok(f.lost[0].at - lastGenuine <= 3000);
});
