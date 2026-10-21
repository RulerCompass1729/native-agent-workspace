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
test('a delayed reopened terminal snapshot cannot finish under an obsolete owner', async t => {
  const { workspace: w, runtimes: [r], ids: [id] } = await fixture(t);
  r.terminal = { alive: false, nativeExited: true };
  let release, snapshots = 0;
  r.openTerminal = async guard => {
    assert.equal(guard(), true);
    return { snapshot: () => { snapshots++; return new Promise(resolve => { release = resolve; }); } };
  };
  w.claim(id, 'owner', 'terminal');
  const pending = w.terminalSnapshot(id, 'owner');
  await tick(); assert.equal(snapshots, 1);
  w.claim(id, 'new-owner', 'chat'); release({ buffer: 'old snapshot', epoch: 'old-display' });
  await assert.rejects(pending, /控制权已变化/);
  assert.equal(w.get(id).owner, 'new-owner'); assert.equal(w.get(id).view, 'chat');
  assert.equal(w.versions.dispatches, 0);
});
test('observed native children survive window reads; transport/service gaps invalidate freshness without replay', async t => {
  const { workspace: w, runtimes: [r], ids: [id], directory } = await fixture(t);
  const { observedFleet } = require('../renderer/fleet-observation.js');
  const started = { event: 'SubagentStart', id: 'child', name: 'check' };
  r.emit('fleet', started);
  assert.equal(observedFleet(w.snapshot().sessions[0]).running, 1);
  r.emit('state', 'disconnected'); r.emit('state', 'idle');
  assert.equal(observedFleet(w.snapshot().sessions[0]).unknown, 1);
  r.emit('fleet', started); w.persist();
  assert.equal(observedFleet(w.snapshot().sessions[0]).running, 1);
  const cold = new Workspace({ binaries: {}, close() {} }, directory); t.after(() => cold.close());
  cold.get(id).state = 'idle'; // Even a resumed root is not a refreshed child inventory.
  assert.equal(observedFleet(cold.snapshot().sessions[0]).unknown, 1);
  assert.equal(cold.versions.dispatches, 0);
});
test('continuous output checkpoints before it becomes quiet and reload never sends a task', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { workspace: w, runtimes: [r], ids: [id], directory } = await fixture(t);
  w.join(id, true); w.setDraft(id, '未发送的草稿'); w.persist();
  let saves = 0;
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (...args) => { saves++; return rename(...args); });
  for (let i = 0; i < 20; i++) {
    r.emit('delta', { id: 'continuous-reply', text: `第${i}段。` });
    t.mock.timers.tick(50);
  }
  const stored = JSON.parse(fs.readFileSync(path.join(directory, 'workspace.json')));
  assert.equal(stored.sessions[0].messages[0]?.text, w.get(id).messages[0].text);
  assert.equal(saves, 1, 'One bounded checkpoint, not one disk write per output chunk');
  assert.equal(stored.drafts[id], '未发送的草稿');
  assert.equal(stored.sessions[0].roomId, 'shared');
  let starts = 0, sends = 0;
  const recovered = new Workspace({ binaries: {}, close() {}, create() { starts++; return { send() { sends++; } }; } }, directory);
  t.after(() => recovered.close());
  assert.deepEqual(recovered.get(id).messages, stored.sessions[0].messages);
  assert.equal(recovered.get(id).state, 'recoverable');
  assert.equal(starts, 0); assert.equal(sends, 0);
  r.emit('delta', { id: 'continuous-reply', text: '最后一段。' });
  t.mock.timers.tick(150);
  assert.equal(saves, 2, 'Quiet output still saves promptly');
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'workspace.json'))).sessions[0].messages[0].text, w.get(id).messages[0].text);
  t.mock.timers.tick(2000);
  assert.equal(saves, 2, 'Completed checkpoints leave no redundant timer');
});

test('explicit persistence and close drain both save deadlines', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { workspace: w, ids: [id], directory } = await fixture(t);
  w.setDraft(id, 'first'); w.persist();
  let saves = 0; const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (...args) => { saves++; return rename(...args); });
  t.mock.timers.tick(1200);
  assert.equal(saves, 0);
  w.setDraft(id, 'last edit before close'); w.close();
  assert.equal(saves, 1);
  t.mock.timers.tick(1200);
  assert.equal(saves, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'workspace.json'))).drafts[id], 'last edit before close');
});

test('explicit save retry retains latest memory after a real write failure without restarting native work', async t => {
  const { workspace: w, runtimes: [r], ids: [id], directory } = await fixture(t);
  w.get(id).nativeId = 'original-native-id';
  w.join(id, true); w.setDraft(id, 'saved draft'); w.persist();
  const file = path.join(directory, 'workspace.json'), temp = file + '.tmp';
  const original = fs.readFileSync(file, 'utf8');
  fs.mkdirSync(temp); // A real filesystem error, without affecting other files.
  w.setDraft(id, 'latest in-memory draft'); r.emit('delta', { id: 'partial', text: '收到的内容' }); w.persist();
  assert.equal(w.snapshot().storageRetryable, true);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.throws(() => w.retrySave(), /仍未能保存/);
  assert.equal(w.snapshot().storageRetryable, true);
  fs.rmdirSync(temp);
  assert.equal(w.retrySave(), true);
  const saved = JSON.parse(fs.readFileSync(file));
  assert.equal(saved.drafts[id], 'latest in-memory draft');
  assert.equal(saved.sessions[0].nativeId, 'original-native-id');
  assert.equal(saved.sessions[0].roomId, 'shared');
  assert.deepEqual(saved.sessions[0].messages, w.get(id).messages);
  assert.equal(w.runtimes.get(id), r); assert.equal(w.get(id).state, 'idle');
  assert.equal(w.snapshot().storageWarning, null); assert.equal(w.snapshot().storageRetryable, false);
  assert.equal(w.versions.dispatches, 0);
  assert.throws(() => w.retrySave(), /没有可重试/);
});

test('save retry never replaces an original that could not be read', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-unread-'));
  const file = path.join(directory, 'workspace.json'), original = '{ unread original';
  fs.writeFileSync(file, original, { mode: 0o600 });
  const w = new Workspace({ binaries: {}, close() {} }, directory);
  t.after(() => { w.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  assert.equal(w.snapshot().storageRetryable, false);
  assert.throws(() => w.retrySave(), /原文件不会被覆盖/);
  w.persist();
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.ok(w.snapshot().storageWarning);
});

test('a former window cannot overwrite a draft after another window takes control', async t => {
  const { workspace: w, ids: [id] } = await fixture(t);
  w.setDraft(id, 'first draft', 'owner');
  w.claim(id, 'new-owner', 'chat');
  w.setDraft(id, 'newest draft', 'new-owner');
  assert.throws(() => w.setDraft(id, 'late stale write', 'owner'), /另一窗口控制/);
  assert.equal(w.snapshot().sessions[0].liveDraft, 'newest draft');
  assert.equal(w.versions.dispatches, 0);
});
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
  runtime.submission = { request: async () => ({promptId:'fixture-prompt'}) };
  runtime.terminal = { input() {} };
  w.runtimes.set(id, runtime); w.bind(s, runtime);
  w.join(id, true); await w.forward(id, 'shared task', 'owner');
  assert.ok(s.pendingTag);
  if (intervention === 'native input') runtime.hook({ hook_event_name: 'UserPromptSubmit', session_id: s.nativeId, prompt: 'private change' });
  else await w.interrupt(id, 'owner');
  runtime.hook({ hook_event_name: 'Stop', prompt_id: 'fixture-prompt', session_id: s.nativeId, last_assistant_message: 'private result' });
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
test('a rejected old-owner send releases its own pending slot without changing the new owner draft or work', async t => {
  const { workspace: w, runtimes: [r], ids: [id] } = await fixture(t);
  let reject;
  r.send = () => new Promise((_resolve, fail) => { reject = fail; });
  w.setDraft(id, 'old draft', 'owner');
  const pending = w.send(id, 'old draft', 'owner'), rejected = assert.rejects(pending);
  w.claim(id, 'next-owner');
  w.setDraft(id, 'new draft', 'next-owner');
  w.room.run = { id: 'new-work', status: 'running', ids: [] };
  reject(Error('Old submission canceled')); await rejected;
  assert.equal(w.get(id).pendingTag, null);
  assert.equal(w.get(id).messages.at(-1).status, 'unconfirmed');
  assert.equal(w.get(id).state, 'idle');
  assert.equal(w.drafts.get(id), 'new draft');
  assert.equal(w.room.run.status, 'running');
  r.send = async () => {};
  await w.send(id, 'new draft', 'next-owner');
  assert.ok(w.get(id).pendingTag);
});
for (const edit of [false, true]) test('backend retirement before a rejected ACK preserves the right draft: ' + edit, async t => {
  const { workspace: w, runtimes: [r], ids: [id] } = await fixture(t);
  let reject; r.send = () => new Promise((_resolve, fail) => { reject = fail; });
  w.setDraft(id, 'pending draft', 'owner');
  const sending = w.send(id, 'pending draft', 'owner'), rejected = assert.rejects(sending);
  r.emit('state', 'recoverable');
  if (edit) w.setDraft(id, 'new edit', 'owner');
  reject(Error('Transport lost')); await rejected;
  assert.equal(w.drafts.get(id), edit ? 'new edit' : 'pending draft');
  assert.equal(w.get(id).messages.at(-1).status, 'unconfirmed');
  assert.equal(w.get(id).state, 'recoverable');
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
test('explicit reply exchange preserves unknowns, rejects duplicate results and never resumes on service recovery', async t => {
  const { workspace: w, runtimes, ids, directory } = await fixture(t, 2);
  const sends = []; ids.forEach(id => w.join(id, true));
  runtimes.forEach((r, i) => { r.send = async (text, tag) => sends.push({ i, text, tag }); });
  await assert.rejects(w.startRun(ids, 'task', 3, 'anything'), /未知/);
  await w.startRun(ids, 'task', 4, 'replies');
  const event = { tag: sends[0].tag, text: 'first reply' };
  runtimes[0].emit('complete', event); await tick();
  assert.equal(sends.length, 2); assert.equal(w.room.run.nativeWorkUnknown, true);
  runtimes[0].emit('complete', event); await tick(); assert.equal(sends.length, 2);
  w.persist(); const restored = new Workspace({ binaries: {}, close() {} }, directory);
  assert.equal(restored.room.run.status, 'paused'); assert.equal(restored.room.run.awaiting, null); restored.close();
  runtimes[1].emit('complete', { tag: sends[1].tag, text: 'second reply' }); await tick();
  runtimes[0].emit('complete', { tag: sends[2].tag, text: 'first reply' }); await tick();
  assert.equal(sends.length, 3); assert.equal(w.room.run.status, 'paused'); assert.match(w.room.run.reason, /重复/);
});
for (const intervention of ['approval', 'leave', 'native', 'background']) test(`reply authorization stops on ${intervention}`, async t => {
  const { workspace: w, runtimes, ids } = await fixture(t, 2);
  const sends = []; ids.forEach(id => w.join(id, true));
  runtimes.forEach((r, i) => { r.send = async (text, tag) => sends.push({ i, tag }); });
  await w.startRun(ids, 'task', 3, 'replies');
  if (intervention === 'approval') runtimes[0].emit('state', 'approval');
  if (intervention === 'leave') w.join(ids[1], false);
  if (intervention === 'native') runtimes[0].emit('nativeInput', 'human correction');
  runtimes[0].emit('complete', { tag: sends[0].tag, text: 'reply', background: intervention === 'background' ? 1 : null }); await tick();
  assert.equal(sends.length, 1); assert.equal(w.room.run.status, 'paused');
});
for (const event of ['background', 'scheduled', 'SubagentStart', 'thread/started']) test(`activity in another member pauses reply exchange: ${event}`, async t => {
  const { workspace: w, runtimes, ids } = await fixture(t, 2);
  const sends = []; ids.forEach(id => w.join(id, true));
  runtimes.forEach((r, i) => { r.send = async (text, tag) => sends.push({ i, tag }); });
  await w.startRun(ids, 'task', 3, 'replies');
  if (event === 'background' || event === 'scheduled') runtimes[1].emit('background', { count: event === 'background' ? 1 : 0, scheduled: event === 'scheduled' ? 1 : 0 });
  else runtimes[1].emit('fleet', { id: 'child', event });
  runtimes[0].emit('complete', { tag: sends[0].tag, text: 'reply' }); await tick();
  assert.equal(sends.length, 1); assert.equal(w.room.run.status, 'paused');
  assert.equal(w.runtime(ids[1]), runtimes[1], 'Native member remains available');
});
for (const key of ['background', 'scheduled']) test(`reply exchange cannot start with known ${key}`, async t => {
  const { workspace: w, ids } = await fixture(t, 2);
  ids.forEach(id => w.join(id, true)); w.get(ids[1])[key] = 1;
  await assert.rejects(w.startRun(ids, 'task', 3, 'replies'), /后台或定时/);
  assert.equal(w.versions.dispatches, 0);
});
for (const activity of ['background', 'fleet']) test(`actual Claude hook sequence retains current reply before stopping ${activity} handoffs`, async t => {
  const { workspace: w, ids } = await fixture(t, 2);
  const { Claude } = require('../adapters.cjs');
  const runtime = Object.create(Claude.prototype); EventEmitter.call(runtime);
  runtime.record = w.get(ids[0]); runtime.ready = true; runtime.chatAvailable = true;
  runtime.submission = { request: async () => ({promptId:'fixture-prompt'}) }; runtime.terminal = { input() {} };
  w.runtimes.set(ids[0], runtime); w.bind(runtime.record, runtime);
  ids.forEach(id => w.join(id, true)); await w.startRun(ids, 'shared question', 3, 'replies');
  if (activity === 'fleet') runtime.hook({ hook_event_name: 'SubagentStart', session_id: runtime.record.nativeId, agent_id: 'child' });
  runtime.hook({ hook_event_name: 'Stop', prompt_id: 'fixture-prompt', session_id: runtime.record.nativeId, last_assistant_message: 'authorized reply', background_tasks: activity === 'background' ? [{ id: 'job' }] : [], session_crons: [], stop_hook_active: false });
  await tick(); assert.equal(w.room.run.status, 'paused');
  assert.equal(w.versions.dispatches, 1);
  assert.equal(w.room.messages.filter(m => m.role === 'assistant').at(-1).text, 'authorized reply');
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
    assert.equal(w.room.messages.filter(m => m.role === 'assistant').at(-1).text, event.text);
    // Neither a duplicate completion nor later state observations resume work.
    runtimes[0].emit('complete', event);
    runtimes[0].emit('background', { count: 0, scheduled: 0 }); await tick();
    assert.equal(sends.length, 1); assert.equal(w.room.messages.filter(m => m.role !== 'system').length, 2);
    w.persist(); assert.equal(JSON.parse(fs.readFileSync(path.join(w.dataDir, 'workspace.json'))).room.messages.filter(m => m.role === 'assistant').at(-1).text, event.text);
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
  assert.equal(w.room.messages.filter(m => m.role === 'assistant').at(-1).text, 'last root reply');
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

test('native closed followed by rejection of the same resume keeps the confirmed ended state', async t => {
  const { workspace: w, runtimes: [old], ids: [id] } = await fixture(t);
  w.setDraft(id, 'keep after closed resume');
  old.emit('messageItem', { id: 'old-answer', text: 'Existing native history' });
  old.emit('state', 'ended');
  const before = structuredClone(w.get(id).messages), nativeId = w.get(id).nativeId;
  let starts = 0;
  w.host.create = () => {
    const r = new EventEmitter();
    r.start = async () => {
      starts++;
      r.emit('state', 'ended');
      await tick();
      throw Error('Late resume rejection after native close');
    };
    return r;
  };
  await assert.rejects(w.resume(id, 'owner'), /Late resume rejection/);
  assert.equal(w.get(id).state, 'ended');
  assert.equal(w.get(id).recovering, false);
  assert.equal(w.runtimes.has(id), false);
  assert.equal(w.get(id).nativeId, nativeId);
  assert.deepEqual(w.get(id).messages, before);
  assert.equal(w.snapshot().sessions[0].liveDraft, 'keep after closed resume');
  assert.equal(starts, 1); assert.equal(w.versions.dispatches, 0);
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
for (const item of [
  { type: 'subAgentActivity', kind: 'started', agentThreadId: 'child', agentPath: '/root/check', model: 'synthetic-small' },
  { type: 'subAgentActivity', kind: 'interacted', agentThreadId: 'child' },
  { type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'inProgress' },
  { type: 'collabAgentToolCall', tool: 'followupTask', status: 'inProgress' },
]) test(`native Codex fleet protocol blocks subsequent handoff: ${item.type}/${item.kind || item.tool}`, async t => {
  const { workspace: w, ids } = await fixture(t, 2), { Codex } = require('../adapters.cjs');
  const s = w.get(ids[1]), runtime = new Codex(s, { codexTargets: new Map() });
  w.runtimes.set(s.id, runtime); w.bind(s, runtime); ids.forEach(id => w.join(id, true));
  await w.startRun(ids, 'shared question', 3, 'replies');
  runtime.event({ method: 'item/started', params: { threadId: s.nativeId, item: { id: 'fleet-item', ...item } } });
  assert.equal(w.room.run.status, 'paused'); assert.equal(w.versions.dispatches, 1);
  assert.equal(s.fleet.at(-1).active, true);
  if (item.kind === 'started') assert.equal(s.fleet.at(-1).model, 'synthetic-small');
});
