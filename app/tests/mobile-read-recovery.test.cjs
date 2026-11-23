const test = require('node:test'), assert = require('node:assert/strict');
const { createReadRecovery } = require('../mobile-web/client.js');
function fixture(read = async () => true) {
  const jobs = new Map(); let id = 0, active = true, visible = true, online = true, reads = 0;
  const recovery = createReadRecovery({ read: () => { reads++; return read(); }, active: () => active,
    visible: () => visible, online: () => online,
    schedule: (fn, delay) => { jobs.set(++id, { fn, delay }); return id; }, cancel: n => jobs.delete(n) });
  const step = async () => { assert.equal(jobs.size, 1); const [n, job] = [...jobs][0]; jobs.delete(n); await job.fn(); return job.delay; };
  return { recovery, jobs, step, reads: () => reads, delay: () => [...jobs.values()][0]?.delay,
    active: v => active = v, visible: v => visible = v, online: v => online = v };
}
test('successful reads keep one bounded refresh for new replies without any send callback', async () => {
  const f = fixture(); f.recovery.start(); f.recovery.start();
  assert.equal(await f.step(), 0); assert.equal(f.reads(), 1); assert.equal(f.delay(), 5000);
  await f.step(); assert.equal(f.reads(), 2); assert.equal(f.jobs.size, 1);
  f.recovery.stop(); assert.equal(f.jobs.size, 0);
});
test('failed reads back off and a successful read resets the delay', async () => {
  let okay = false; const f = fixture(async () => okay); f.recovery.start();
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) { await f.step(); assert.equal(f.delay(), delay); }
  okay = true; await f.step(); assert.equal(f.delay(), 5000); f.recovery.stop();
});
test('network, page visibility and authorization gates stop reads until explicitly woken', async () => {
  const f = fixture(); f.recovery.start(); f.online(false); f.recovery.wake(); assert.equal(f.jobs.size, 0);
  f.online(true); f.recovery.wake(); await f.step();
  f.visible(false); f.recovery.wake(); assert.equal(f.jobs.size, 0);
  f.visible(true); f.active(false); f.recovery.wake(); assert.equal(f.jobs.size, 0);
  f.active(true); f.recovery.wake(); await f.step(); assert.equal(f.reads(), 2); f.recovery.stop();
});
test('repeated wake events never overlap an unfinished read', async () => {
  let release; const f = fixture(() => new Promise(r => { release = r; })); f.recovery.start();
  const pending = f.step(); f.recovery.wake(); f.recovery.wake(); assert.equal(f.reads(), 1); assert.equal(f.jobs.size, 0);
  release(true); await pending; assert.equal(f.jobs.size, 1); assert.equal(f.delay(), 0); f.recovery.stop();
});
test('stopping during a read never leaves another scheduled request', async () => {
  let release; const f = fixture(() => new Promise(r => { release = r; })); f.recovery.start();
  const pending = f.step(); f.recovery.stop(); release(true); await pending; assert.equal(f.jobs.size, 0);
});
test('rejected reads remain recoverable while an expired grant stops further reads', async () => {
  let expired = false; const f = fixture(async () => { if (expired) f.active(false); throw Error('Synthetic network failure'); });
  f.recovery.start(); await f.step(); assert.equal(f.delay(), 1000);
  expired = true; await f.step(); assert.equal(f.jobs.size, 0); f.recovery.stop();
});
