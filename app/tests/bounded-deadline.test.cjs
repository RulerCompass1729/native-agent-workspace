const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { Workspace } = require('../workspace.cjs');
const { Claude } = require('../adapters.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, nativeClaude = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-deadline-'));
  const runtimes = [], sent = [];
  const host = { binaries: {}, close() {}, create(record) {
    const r = nativeClaude && record.provider === 'claude' ? Object.create(Claude.prototype) : new EventEmitter();
    if (nativeClaude && record.provider === 'claude') {
      EventEmitter.call(r); r.ready = true; r.record = record;
      r.submission = { request: async (text, tag, guard) => { assert.ok(guard()); sent.push({ id: record.id, text, tag }); return { promptId: 'synthetic-' + tag }; } };
    } else r.send = async (text, tag, guard) => { assert.ok(guard()); sent.push({ id: record.id, text, tag }); };
    r.start = async () => r.emit('state', 'idle');
    runtimes.push(r); return r;
  } };
  const w = new Workspace(host, directory);
  t.after(() => { w.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const ids = [await w.create('claude', directory, 'owner', 'First'), await w.create('codex', directory, 'owner', 'Second')];
  ids.forEach(id => w.join(id, true)); return { w, runtimes, ids, sent };
}
test('deadline blocks a held native submission even before the interval callback runs', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const { w, runtimes, ids } = await fixture(t);
  let release, writes = 0;
  runtimes[0].send = async (_text, _tag, guard) => {
    await new Promise(resolve => { release = resolve; });
    if (!guard()) throw Error('Expired authorization');
    writes++;
  };
  const pending = w.startRun(ids, 'Check 54 + 21', 2, 'replies');
  const rejected = assert.rejects(pending, /Expired authorization/);
  t.mock.timers.setTime(w.room.run.deadline); release(); await rejected;
  assert.equal(writes, 0); assert.equal(w.room.run.status, 'paused');
  assert.match(w.room.run.reason, /10 分钟/);
});
for (const extra of [0, 2000]) test(`completion at deadline + ${extra} ms stays private when timer delivery is late`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const { w, runtimes, ids, sent } = await fixture(t);
  await w.startRun(ids, 'Check 54 + 21', 2, 'replies');
  t.mock.timers.setTime(w.room.run.deadline + extra);
  runtimes[0].emit('complete', { tag: sent[0].tag, text: 'Late private answer: 75' }); await tick();
  assert.equal(sent.length, 1); assert.equal(w.room.run.status, 'paused');
  assert.equal(w.room.messages.some(m => m.text === 'Late private answer: 75'), false);
  assert.ok(w.get(ids[0]).messages.some(m => m.text === 'Late private answer: 75'));
  assert.equal(w.room.messages.at(-1).sessionId, ids[0]);
});
test('a live authorized exchange can continue before its deadline without extending that deadline', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const { w, runtimes, ids, sent } = await fixture(t);
  await w.startRun(ids, 'Check 54 + 21', 2, 'replies');
  const deadline = w.room.run.deadline;
  t.mock.timers.setTime(deadline - 1);
  runtimes[0].emit('complete', { tag: sent[0].tag, text: '75' }); await tick();
  assert.equal(sent.length, 2); assert.equal(w.room.run.deadline, deadline);
  assert.equal(w.room.run.status, 'running');
});
test('a stale expired guard cannot pause a later authorization', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const { w, runtimes, ids } = await fixture(t);
  let oldGuard, oldTag;
  runtimes[0].send = async (_text, tag, guard) => { oldGuard = guard; oldTag = tag; };
  await w.startRun(ids, 'Old task', 2, 'replies'); const oldDeadline = w.room.run.deadline;
  w.pause('Human correction'); runtimes[0].emit('complete', { tag: oldTag, text: 'Private old reply' }); await tick();
  const previousGuard = oldGuard;
  t.mock.timers.setTime(2000); await w.startRun(ids, 'New explicitly authorized task', 2, 'replies');
  t.mock.timers.setTime(oldDeadline);
  assert.equal(previousGuard(), false); assert.equal(w.room.run.status, 'running');
  assert.equal(oldGuard(), true); assert.equal(w.room.run.goal, 'New explicitly authorized task');
});
test('actual Claude completion after a late accepted ACK stays private and clears pending state', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const { w, runtimes: [r], ids, sent } = await fixture(t, true);
  let accept;
  r.submission.request = (text, tag, guard) => {
    assert.ok(guard()); sent.push({ id: ids[0], text, tag });
    return new Promise(resolve => { accept = () => resolve({ promptId: 'synthetic-' + tag }); });
  };
  const pending = w.startRun(ids, 'Check budget', 2, 'replies');
  t.mock.timers.setTime(w.room.run.deadline); accept(); await pending;
  assert.equal(w.get(ids[0]).messages.find(m => m.id === sent[0].tag).status, 'submitted');
  r.hook({ hook_event_name: 'Stop', session_id: r.record.nativeId, prompt_id: 'synthetic-' + sent[0].tag, last_assistant_message: 'Native private result: 75', background_tasks: [], session_crons: [], stop_hook_active: false });
  await tick();
  assert.equal(r.pending, null); assert.equal(w.get(ids[0]).pendingTag, null);
  assert.equal(w.room.run.status, 'paused'); assert.equal(sent.length, 1);
  assert.ok(w.get(ids[0]).messages.some(m => m.text === 'Native private result: 75'));
  assert.ok(w.room.messages.every(m => m.text !== 'Native private result: 75'));
  assert.equal(w.get(ids[0]).messages.find(m => m.id === sent[0].tag).status, 'submitted');
  r.submission.request = async (text, tag, guard) => { assert.ok(guard()); sent.push({ id: ids[0], text, tag }); return { promptId: 'synthetic-' + tag }; };
  await w.send(ids[0], 'New private instruction', 'owner');
  // A new explicit instruction is not subject to the old run's deadline.
  assert.equal(sent.length, 2); assert.equal(sent[1].text, 'New private instruction');
  r.hook({ hook_event_name: 'Stop', session_id: r.record.nativeId, prompt_id: 'synthetic-' + sent[1].tag, last_assistant_message: 'Private answer' }); await tick();
  await w.forward(ids[0], 'New explicitly shared instruction', 'owner');
  assert.equal(sent.length, 3); assert.equal(w.room.run.status, 'paused');
});
