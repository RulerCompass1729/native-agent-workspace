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
test('native human input invalidates shared reply return while retaining the private conversation', async t => {
  const { workspace: w, runtimes, ids } = await fixture(t, 2);
  for (const [i, id] of ids.entries()) {
    const r = runtimes[i], s = w.get(id); let tag;
    r.send = async (_text, value) => { tag = value; };
    w.join(id, true); await w.forward(id, 'selected shared task', 'owner');
    const control = s.controlRevision;
    // Can originate in an external native view, without Workspace.input().
    r.emit('nativeInput', 'private change of direction');
    if (s.provider === 'codex') r.emit('messageItem', { id: 'private-answer', text: 'private result' });
    r.emit('complete', { tag, text: 'private result' }); await tick();
    assert.equal(s.controlRevision, control + 1);
    assert.equal(s.messages.at(-2).text, 'private change of direction');
    assert.equal(s.messages.at(-1).text, 'private result');
    assert.ok(!w.room.messages.some(m => m.text.includes('private')));
    assert.equal(s.pendingTag, null); assert.equal(w.forwards.has(tag), false);
  }
});
test('view changes and terminal device replies preserve sharing; unrelated completions preserve the pending task', async t => {
  const { workspace: w, runtimes: [r], ids: [id] } = await fixture(t);
  w.get(id).provider = 'codex';
  let tag; r.send = async (_text, value) => { tag = value; };
  r.terminal = { alive: true, input() {} };
  w.join(id, true); await w.forward(id, 'shared task', 'owner');
  w.claim(id, 'owner', 'terminal'); w.input(id, '\x1b[1;1R', 'owner'); w.claim(id, 'owner', 'chat');
  r.emit('complete', { tag: 'older-task', text: 'older result' });
  assert.equal(w.get(id).pendingTag, tag);
  r.emit('failed', 'older interrupted turn', { tag: undefined });
  assert.equal(w.get(id).pendingTag, tag);
  r.emit('complete', { tag, text: 'shared result' }); await tick();
  assert.equal(w.room.messages.at(-1).text, 'shared result');
  assert.equal(w.get(id).pendingTag, null);
});
test('sharing and interrupt preserve the native terminal view and accept the next human key', async t => {
  const { workspace: w, runtimes: [r], ids: [id] } = await fixture(t);
  const inputs = []; r.terminal = { alive: true, input: data => inputs.push(data) };
  w.join(id, true); w.claim(id, 'owner', 'terminal');
  await w.forward(id, 'shared task', 'owner');
  assert.equal(w.get(id).view, 'terminal');
  w.input(id, '\r', 'owner'); assert.deepEqual(inputs, ['\r']);
  r.interrupt = async () => {};
  await w.interrupt(id, 'owner'); assert.equal(w.get(id).view, 'terminal');
  w.input(id, 'next input', 'owner'); assert.deepEqual(inputs, ['\r', 'next input']);
});
for (const intervention of ['native input', 'interrupt']) test(`Claude ${intervention} followed by an untagged root Stop releases GUI input without sharing its reply`, async t => {
  const { workspace: w, ids: [id] } = await fixture(t);
  const s = w.get(id);
  const { Claude } = require('../adapters.cjs');
  // Exercise the actual adapter hook/interrupt semantics, without starting CLI.
  const runtime = Object.create(Claude.prototype); EventEmitter.call(runtime);
  runtime.record = s; runtime.ready = true; runtime.chatAvailable = true;
  runtime.submission = { request: async () => {} };
  runtime.terminal = { input() {} };
  w.runtimes.set(id, runtime); w.bind(s, runtime);
  w.join(id, true); await w.forward(id, 'shared task', 'owner');
  assert.ok(s.pendingTag);
  if (intervention === 'native input') runtime.hook({ hook_event_name: 'UserPromptSubmit', session_id: s.nativeId, prompt: 'private change' });
  else await w.interrupt(id, 'owner');
  runtime.hook({ hook_event_name: 'Stop', session_id: s.nativeId, last_assistant_message: 'private result' });
  assert.equal(s.state, 'idle'); assert.equal(s.pendingTag, null);
  assert.equal(s.messages.at(-1).text, 'private result');
  assert.ok(!JSON.stringify(w.room.messages).includes('private result'));
  assert.equal(w.room.messages.at(-1).status, 'reply-private');
  assert.equal(w.forwards.size, 0);
  await w.send(id, 'next solo input', 'owner');
  assert.ok(s.pendingTag);
});
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
    runtimes[sent.index].emit('complete', { tag: sent.tag, text: '42', background: 0, scheduled: 0, fleetPending: 0, stopHookActive: false }); await tick();
  }
  assert.equal(sends.length, 3); assert.equal(w.room.run.status, 'completed');
  assert.deepEqual(sends.map(s => s.index), [0, 1, 0]);
});
test('unknown or active native work pauses routing without losing the reply or blocking explicit sharing', async t => {
  const clear = { background: 0, scheduled: 0, fleetPending: 0, stopHookActive: false };
  const cases = [
    {}, { background: null, scheduled: null, fleetPending: null, stopHookActive: null },
    ...['background', 'scheduled', 'fleetPending'].flatMap(key => [undefined, null, -1, '0', false, NaN, Infinity, 0.5, 1].map(value => ({ ...clear, [key]: value }))),
    { ...clear, stopHookActive: undefined }, { ...clear, stopHookActive: true },
  ];
  for (const [index, info] of cases.entries()) await t.test(`state case ${index}`, async t => {
    const { workspace: w, runtimes, ids } = await fixture(t, 2);
    const sends = [];
    ids.forEach(id => w.join(id, true));
    runtimes.forEach((r, i) => { r.send = async (text, tag) => sends.push({ i, text, tag }); });
    await w.startRun(ids, 'check shared material', 2);
    const event = { ...info, text: 'answer to review', tag: sends[0].tag };
    runtimes[0].emit('complete', event); await tick();
    assert.equal(sends.length, 1); assert.equal(w.room.run.status, 'paused');
    assert.equal(w.room.run.steps, 1); assert.equal(w.room.run.awaiting, null);
    assert.match(w.room.run.reason, /原生/);
    assert.equal(w.room.messages.at(-1).text, event.text);
    // Neither a duplicate completion nor later state observations resume work.
    runtimes[0].emit('complete', event);
    runtimes[0].emit('background', { count: 0, scheduled: 0 }); await tick();
    assert.equal(sends.length, 1); assert.equal(w.room.messages.length, 2);
    w.persist(); assert.equal(JSON.parse(fs.readFileSync(path.join(w.dataDir, 'workspace.json'))).room.messages.at(-1).text, event.text);
    await w.forward(ids[1], 'only this human-selected text', 'owner');
    assert.equal(sends.length, 2); assert.equal(sends[1].text, 'only this human-selected text');
    assert.equal(w.room.run.status, 'paused');
  });
});
test('unknown fleet state at the reply cap is paused, never presented as confirmed completion', async t => {
  const { workspace: w, runtimes, ids } = await fixture(t, 2);
  const sends = []; ids.forEach(id => w.join(id, true));
  runtimes.forEach((r, i) => { r.send = async (text, tag) => sends.push({ i, tag }); });
  await w.startRun(ids, 'shared check', 2);
  runtimes[0].emit('complete', { tag: 'unrelated', text: 'unrelated reply' }); await tick();
  assert.equal(w.room.run.steps, 0); assert.equal(sends.length, 1);
  runtimes[0].emit('complete', { tag: sends[0].tag, text: 'first reply', background: 0, scheduled: 0, fleetPending: 0, stopHookActive: false }); await tick();
  runtimes[1].emit('complete', { tag: sends[1].tag, text: 'last root reply', background: 0, scheduled: 0, fleetPending: null, stopHookActive: false }); await tick();
  assert.equal(sends.length, 2); assert.equal(w.room.run.status, 'paused'); assert.equal(w.room.run.steps, 2);
  assert.equal(w.room.messages.at(-1).text, 'last root reply');
});
test('leaving cancels pending explicit sharing; human interrupt cancels pending direct submission', async t => {
  const { workspace: w, runtimes: [r], ids: [id] } = await fixture(t);
  let guard;
  r.send = async (_text, _tag, allowed) => { guard = allowed; };
  r.interrupt = async () => {};
  w.join(id, true); await w.forward(id, 'only shared text', 'owner');
  assert.equal(guard(), true); w.join(id, false); assert.equal(guard(), false);
  w.get(id).pendingTag = null; await w.send(id, 'direct text', 'owner');
  assert.equal(guard(), true); await w.interrupt(id, 'owner'); assert.equal(guard(), false);
});
test('a reply completed during send is captured in order and does not erase a private draft', async t => {
  const { workspace: w, runtimes: [r], ids: [id] } = await fixture(t);
  w.join(id, true); w.setDraft(id, 'private draft');
  r.send = async (_text, tag) => { r.emit('submitted', tag); r.emit('complete', { tag, text: '42', background: 0, scheduled: 0, fleetPending: 0, stopHookActive: false }); };
  await w.forward(id, 'check the shared sum', 'owner');
  assert.deepEqual(w.room.messages.map(m => m.role), ['human', 'assistant']);
  assert.equal(w.room.messages[1].text, '42'); assert.equal(w.snapshot().sessions[0].liveDraft, 'private draft');
});

test('stop waits for confirmation, invalidates queued input, and retains an unsubscribed runtime', async t => {
  const { workspace: w, runtimes: [r], ids: [id] } = await fixture(t);
  let guard, release, calls = 0;
  r.send = async (_text, _tag, allowed) => { guard = allowed; };
  await w.send(id, 'pending input', 'owner');
  r.stop = () => { calls++; return new Promise(resolve => { release = resolve; }); };
  const pending = w.stop(id); assert.equal(w.stop(id), pending); await tick();
  assert.equal(calls, 1); assert.equal(guard(), false);
  assert.equal(w.get(id).state, 'stopping'); assert.equal(w.runtime(id), r);
  r.emit('state', 'idle'); assert.equal(w.get(id).state, 'stopping');
  release({ state: 'disconnected' }); await pending;
  assert.equal(w.get(id).state, 'disconnected'); assert.equal(w.runtime(id), r);
  r.emit('state', 'ended'); assert.equal(w.get(id).state, 'ended');
});

test('failed stop keeps the runtime and draft available for a confirmed retry', async t => {
  const { workspace: w, runtimes: [r], ids: [id] } = await fixture(t);
  w.setDraft(id, 'unsent draft'); r.stop = async () => { throw Error('No native confirmation'); };
  await assert.rejects(w.stop(id), /No native confirmation/);
  assert.equal(w.get(id).state, 'error'); assert.equal(w.runtime(id), r);
  assert.equal(w.snapshot().sessions[0].liveDraft, 'unsent draft');
  r.stop = async () => ({ state: 'ended' }); await w.stop(id);
  assert.equal(w.get(id).state, 'ended'); assert.equal(w.runtimes.has(id), false);
  assert.equal(w.snapshot().sessions[0].liveDraft, 'unsent draft');
});

test('service restart retains membership and draft without replay; explicit resume reuses native identity', async t => {
  const { workspace: before, directory, ids: [id] } = await fixture(t);
  before.join(id, true); before.setDraft(id, 'unsent recovery draft'); before.persist();
  const nativeId = before.get(id).nativeId; let resumed, sends = 0;
  const host = { binaries: {}, close() {}, create(record) {
    resumed = { ...record }; const r = new EventEmitter();
    r.start = async () => r.emit('state', 'idle'); r.send = async () => sends++; return r;
  } };
  const after = new Workspace(host, directory); t.after(() => after.close());
  assert.equal(after.get(id).state, 'recoverable'); assert.equal(after.get(id).roomId, 'shared');
  assert.equal(after.snapshot().sessions[0].liveDraft, 'unsent recovery draft');
  assert.equal(after.room.run, null); assert.equal(after.runtimes.size, 0);
  await after.resume(id, 'new-view');
  assert.equal(resumed.nativeId, nativeId); assert.equal(resumed.recovering, true);
  assert.equal(after.get(id).state, 'idle'); assert.equal(sends, 0);
});

test('recovery refuses a live previous process and local removal preserves shared history', async t => {
  const { workspace: w, ids: [id] } = await fixture(t);
  w.runtimes.delete(id); const s = w.get(id); s.state = 'recoverable'; s.processIdentity = { pid: process.pid };
  await assert.rejects(w.resume(id, 'owner'), /仍在运行/);
  assert.throws(() => w.forget(id), /仍存在/);
  s.processIdentity = null; w.setDraft(id, 'private draft'); w.room.messages.push({ text: 'shared material' });
  w.forget(id); assert.equal(w.sessions.has(id), false); assert.equal(w.drafts.has(id), false);
  assert.equal(w.room.messages.length, 1);
});


test('clearing shared history refuses an active run and prevents late shared replies without deleting native history', async t => {
  const { workspace: w, runtimes: [r], ids: [id] } = await fixture(t);
  w.join(id, true); w.room.run = { status: 'running' };
  assert.throws(() => w.clearSharedHistory());
  w.room.run = null; let tag; r.send = async (_text, sentTag) => { tag = sentTag; };
  await w.forward(id, 'synthetic shared material', 'owner');
  w.setDraft(id, 'private draft'); w.clearSharedHistory();
  r.emit('complete', { tag, text: 'late answer', background: 0, scheduled: 0, fleetPending: 0, stopHookActive: false });
  assert.equal(w.room.messages.length, 0);
  assert.equal(w.get(id).messages.at(-1).text, 'late answer');
  assert.equal(w.snapshot().sessions[0].liveDraft, 'private draft');
  assert.ok(w.runtime(id));
});
