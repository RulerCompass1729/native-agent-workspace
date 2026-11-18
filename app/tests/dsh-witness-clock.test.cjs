'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture } = require('./helpers/dsh-witness-clock.cjs');

for (const rollbackMs of [249750, 300000])
test(`old reports cannot renew across a ${rollbackMs} ms wall-clock rollback`, async t => {
  const f = await fixture();
  t.after(() => f.close());
  f.auto = true; f.advance(249500); f.auto = false;
  const lastGenuine = f.clock.mono, beats = f.armed.beats;
  assert.equal(f.sent.length, 999);
  f.clock.wall -= rollbackMs;
  f.advance(250);
  // Retirement may precede reuse; preserve the equal-timestamp input either way.
  const wrapped = f.sent[999];
  if (wrapped) assert.equal(wrapped.port, f.sent[0].port, 'the actual port wrapped');
  else assert.equal(f.lost.length, 1, 'already failed closed before reusing the port');
  const sendWall = wrapped?.wall ?? f.clock.wall;
  if (rollbackMs === 249750) assert.equal(f.sent[0].wall, sendWall, 'equal wire timestamp, not a future stamp');
  else assert.ok(f.sent[0].wall > sendWall);
  f.report(1); // unchanged original port and original timestamp
  const renewed = f.armed.beats - beats;
  for (let old = 2; old <= 14; old++) { f.advance(250); f.report(old); }
  console.log(JSON.stringify({ rollbackMs, sinceLastGenuine: f.clock.mono - lastGenuine,
    renewals: f.armed.beats - beats, stops: f.lost.length }));
  assert.equal(renewed, 0, 'a report from the preceding cycle cannot confirm the new send');
  assert.equal(f.lost.length, 1, 'stale reports cannot keep the lease alive');
  assert.equal(f.lost[0].reason, 'witness-silent');
  assert.ok(f.lost[0].at - lastGenuine <= 3000);
});

test('a report detects a backward mapping before the next beat runs', async t => {
  const f = await fixture(); t.after(() => f.close());
  f.clock.wall -= 300000;
  f.report(1);
  assert.equal(f.lost.length, 1);
  assert.equal(f.lost[0].at, 0);
  assert.equal(f.armed.beats, 1);
});

test('a mapping change after sending is caught by the queued judge', async t => {
  const f = await fixture(); t.after(() => f.close());
  f.canary.stdin.once('data', () => { f.clock.wall -= 300000; });
  f.advance(250);
  assert.equal(f.sent.length, 2);
  assert.equal(f.lost.length, 1);
  assert.equal(f.lost[0].at, 250);
});

test('millisecond clock rounding stays live across two port cycles', async t => {
  const f = await fixture(); t.after(() => f.close());
  f.auto = true;
  for (let index = 0; index < 1000; index++) {
    f.clock.wall -= 1; f.advance(250);
    f.clock.wall += 1; f.advance(250);
  }
  assert.equal(f.armed.beats, 2001);
  assert.equal(f.lost.length, 0);
});
