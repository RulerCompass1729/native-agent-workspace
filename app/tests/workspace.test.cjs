const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Workspace } = require('../workspace.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, count = 1) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-test-'));
  const runtimes = [];
  const host = { binaries: {}, close() {}, create() { const runtime = new EventEmitter(); runtime.start = async () => runtime.emit('state', 'idle'); runtime.send = async () => {}; runtimes.push(runtime); return runtime; } };
  const workspace = new Workspace(host, directory);
  t.after(() => { workspace.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const ids = [];
  for (let i = 0; i < count; i++) ids.push(await workspace.create(i ? 'codex' : 'claude', directory, 'owner', `Test ${i}`));
  return { workspace, runtimes, ids, directory };
}
test('an unconfirmed send restores its draft, but never overwrites later edits', async t => {
  const { workspace: w, runtimes: [r], ids: [id] } = await fixture(t);
  const draft = '  未发送的草稿\n第二行  ';
  w.setDraft(id, draft); r.send = async () => { throw Error('No delivery acknowledgement'); };
  await assert.rejects(w.send(id, draft, 'owner'));
  assert.equal(w.snapshot().sessions[0].liveDraft, draft);
  assert.equal(w.get(id).messages.at(-1).status, 'unconfirmed');
  w.persist(); assert.equal(JSON.parse(fs.readFileSync(path.join(w.dataDir, 'workspace.json'))).drafts[id], draft);
  r.send = async () => { w.setDraft(id, ''); throw Error('No delivery acknowledgement'); };
  await assert.rejects(w.send(id, draft, 'owner'));
  assert.equal(w.snapshot().sessions[0].liveDraft, '');
});
test('a view without control cannot send or write terminal input', async t => {
  const { workspace: w, ids: [id] } = await fixture(t);
  await assert.rejects(w.send(id, 'hello', 'observer'));
  assert.throws(() => w.input(id, 'hello', 'observer'));
  assert.equal(w.versions.dispatches, 0);
});
test('switching your own view does not cancel a pending send; actual input or takeover does', async t => {
  const { workspace: w, runtimes: [r], ids: [id] } = await fixture(t);
  let allowed;
  r.send = async (_text, _tag, guard) => { allowed = guard; };
  r.terminal = { alive: true, input() {} };
  await w.send(id, 'test', 'owner');
  w.claim(id, 'owner', 'terminal'); assert.equal(allowed(), true);
  w.input(id, 'human input', 'owner'); assert.equal(allowed(), false);
  w.get(id).pendingTag = null;
  await w.send(id, 'another test', 'owner');
  w.claim(id, 'second-view', 'chat'); assert.equal(allowed(), false);
});
test('leaving during a pending handoff invalidates native submission without replacing its session', async t => {
  const { workspace: w, runtimes: [r], ids } = await fixture(t, 2);
  ids.forEach(id => w.join(id, true));
  let release, writes = 0;
  r.send = async (_text, _tag, guard) => { await new Promise(resolve => { release = resolve; }); if (!guard()) throw Error('Canceled before native write'); writes++; };
  const pending = w.startRun(ids, 'check the synthetic sum', 3);
  const original = w.get(ids[0]);
  w.join(ids[0], false); release(); await assert.rejects(pending);
  assert.equal(w.get(ids[0]), original); assert.equal(w.runtime(ids[0]), r);
  assert.equal(writes, 0); assert.equal(w.room.run.status, 'paused');
});
test('bounded routing sends only the goal and current answer, and stops at the reply limit', async t => {
  const { workspace: w, runtimes, ids } = await fixture(t, 2);
  const sends = [];
  ids.forEach(id => { w.join(id, true); w.get(id).messages.push({ id: 'private', role: 'user', text: 'PRIVATE_HISTORY_MARKER' }); });
  runtimes.forEach((r, index) => { r.send = async (text, tag, guard) => { assert.ok(guard()); sends.push({ index, text, tag }); }; });
  await w.startRun(ids, 'Check 17 + 25', 3);
  for (let i = 0; i < 3; i++) {
    const sent = sends[i]; assert.ok(sent); assert.ok(!sent.text.includes('PRIVATE_HISTORY_MARKER'));
    runtimes[sent.index].emit('complete', { tag: sent.tag, text: '42', background: 0, scheduled: 0 }); await tick();
  }
  assert.equal(sends.length, 3); assert.equal(w.room.run.status, 'completed');
  assert.deepEqual(sends.map(s => s.index), [0, 1, 0]);
});
test('a reply completed during send is captured in order and does not erase a private draft', async t => {
  const { workspace: w, runtimes: [r], ids: [id] } = await fixture(t);
  w.join(id, true); w.setDraft(id, 'private draft');
  r.send = async (_text, tag) => { r.emit('submitted', tag); r.emit('complete', { tag, text: '42', background: 0, scheduled: 0 }); };
  await w.forward(id, 'check the shared sum', 'owner');
  assert.deepEqual(w.room.messages.map(m => m.role), ['human', 'assistant']);
  assert.equal(w.room.messages[1].text, '42'); assert.equal(w.snapshot().sessions[0].liveDraft, 'private draft');
});
