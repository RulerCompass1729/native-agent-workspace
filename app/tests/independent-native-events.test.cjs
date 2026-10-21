const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Workspace } = require('../workspace.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, start = true, count = 3) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-independent-events-')), runtimes = [], sends = [];
  const host = { binaries: {}, close() {}, create(record) {
    const r = new EventEmitter(); r.start = async () => r.emit('state', 'idle');
    r.send = async (text, tag, guard) => { assert.equal(guard(), true); sends.push({ id: record.id, tag, text }); r.emit('submitted', tag); };
    runtimes.push(r); return r;
  } };
  const w = new Workspace(host, directory); t.after(() => { w.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const ids = []; for (let i = 0; i < count; i++) ids.push(await w.create('claude', directory, 'owner', 'Partner ' + i));
  ids.forEach(id => w.join(id, true)); if (start) await w.startRun(ids.slice(0, 2), 'Verify 20 plus 15', 2, 'replies');
  return { w, ids, runtimes, sends };
}
const events = [
  ['approval-state', r => r.emit('state', 'approval')],
  ['approval-request', r => r.emit('approval', { requestId: 1, method: 'item/commandExecution/requestApproval', params: { command: 'synthetic private' } })],
  ['native-error', r => r.emit('state', 'error')],
  ['native-exit', r => r.emit('state', 'ended')],
  ['native-recoverable', r => r.emit('state', 'recoverable')],
  ['unattributed', (r, tag) => r.emit('unattributed', tag)],
  ['failed-reply', r => r.emit('failed', 'Independent failure')],
];
for (const [kind, emit] of events) for (const selected of [false, true]) test(`${kind} ${selected ? 'selected participant pauses sharing' : 'outside selected participants preserves the run'}`, async t => {
  const { w, ids, runtimes, sends } = await fixture(t);
  const run = w.room.run, target = selected ? (kind === 'unattributed' ? 0 : 1) : 2;
  // Model the existing private send identity; unattributed notifications whose
  // tag does not match are intentionally ignored by the native adapter path.
  if (kind === 'unattributed' && !selected) w.get(ids[target]).pendingTag = 'private-pending';
  emit(runtimes[target], w.get(ids[target]).pendingTag);
  assert.equal(run.status, selected ? 'paused' : 'running');
  const first = sends[0]; runtimes[0].emit('complete', { tag: first.tag, text: '35 minutes' }); await tick();
  assert.equal(sends.length, selected ? 1 : 2);
  if (!selected) {
    assert.equal(sends[1].id, ids[1]); assert.ok(!sends[1].text.includes('Private unrelated'));
    runtimes[1].emit('complete', { tag: sends[1].tag, text: 'Verified 35 minutes' }); await tick();
    assert.equal(run.status, 'completed');
  }
});

function holdSend(runtime) {
  let reject;
  const pending = new Promise((_, fail) => { reject = fail; });
  runtime.send = async (_, __, guard) => { assert.equal(guard(), true); await pending; };
  return reason => reject(new Error(reason));
}
test('a delayed private send rejection restores its draft without pausing a later selected pair', async t => {
  const { w, ids, runtimes, sends } = await fixture(t, false);
  const reject = holdSend(runtimes[2]), text = 'Private draft awaiting confirmation';
  w.setDraft(ids[2], text, 'owner');
  const privateSend = assert.rejects(w.send(ids[2], text, 'owner'), /private acknowledgement failed/);
  assert.equal(w.drafts.get(ids[2]), '');
  await w.startRun(ids.slice(0, 2), 'Verify the public schedule', 2, 'replies');
  const run = w.room.run;
  reject('private acknowledgement failed'); await privateSend;
  assert.equal(w.drafts.get(ids[2]), text); assert.equal(w.get(ids[2]).pendingTag, null);
  assert.equal(w.get(ids[2]).messages.at(-1).status, 'unconfirmed');
  assert.equal(w.room.run, run); assert.equal(run.status, 'running');
  assert.ok(w.room.messages.every(m => !m.text.includes('private acknowledgement failed')));
  runtimes[0].emit('complete', { tag: sends[0].tag, text: '35 minutes' }); await tick();
  runtimes[1].emit('complete', { tag: sends[1].tag, text: '175 minutes per week' }); await tick();
  assert.equal(run.status, 'completed');
});
for (const phase of ['initial', 'handoff']) for (const replaced of [false, true]) test(`delayed ${phase} rejection ${replaced ? 'cannot pause a new authorization' : 'pauses its current authorization'}`, async t => {
  const { w, ids, runtimes, sends } = await fixture(t, false, 4);
  const target = phase === 'initial' ? 0 : 1, reject = holdSend(runtimes[target]);
  let initial;
  if (phase === 'initial') initial = assert.rejects(w.startRun(ids.slice(0, 2), 'Original schedule', 2, 'replies'), /old send failed/);
  else {
    await w.startRun(ids.slice(0, 2), 'Original schedule', 2, 'replies');
    runtimes[0].emit('complete', { tag: sends[0].tag, text: '35 minutes' }); await tick();
  }
  const original = w.room.run;
  assert.equal(original.awaiting.sessionId, ids[target]);
  if (replaced) {
    w.pause('Human stops the original exchange');
    await w.startRun(ids.slice(2), 'Different schedule', 2, 'replies');
  }
  const current = w.room.run;
  reject('old send failed'); if (initial) await initial; await tick();
  assert.equal(w.get(ids[target]).pendingTag, null);
  assert.equal(w.get(ids[target]).messages.at(-1).status, 'unconfirmed');
  assert.equal(w.room.run, current); assert.equal(current.status, replaced ? 'running' : 'paused');
  if (replaced) {
    assert.notEqual(original.id, current.id);
    assert.ok(w.room.messages.every(m => m.runId !== current.id || !m.text.includes('old send failed')));
    const first = sends.find(s => s.id === ids[2]); runtimes[2].emit('complete', { tag: first.tag, text: '40 minutes' }); await tick();
    const next = sends.find(s => s.id === ids[3]); runtimes[3].emit('complete', { tag: next.tag, text: '200 minutes per week' }); await tick();
    assert.equal(current.status, 'completed');
  } else assert.equal(current.reason, 'old send failed');
});
