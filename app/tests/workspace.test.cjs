const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Workspace } = require('../workspace.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, count = 1) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-test-'));
  const runtimes = [];
  const host = { binaries: {}, close() {}, create() { const runtime = new EventEmitter(); runtime.start = async () => runtime.emit('state', 'idle'); runtime.send = async () => {}; runtime.finishTurn = () => {}; runtimes.push(runtime); return runtime; } };
  const workspace = new Workspace(host, directory);
  t.after(() => { workspace.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const ids = [];
  for (let i = 0; i < count; i++) ids.push(await workspace.create(i ? 'codex' : 'claude', directory, 'owner', `Test ${i}`));
  return { workspace, runtimes, ids, directory };
}
test('creating a seventh session keeps existing sessions and their drafts', async t => {
  const { workspace: w, runtimes, ids, directory } = await fixture(t, 6);
  w.setDraft(ids[0], 'Unsent work stays here', 'owner');
  const before = ids.map(id => ({ id, nativeId: w.get(id).nativeId, state: w.get(id).state, runtime: w.runtimes.get(id) }));
  const seventh = await w.create('codex', directory, 'owner', 'Second developer');
  assert.equal(w.sessions.size, 7); assert.equal(runtimes.length, 7);
  assert.ok(!ids.includes(seventh)); assert.equal(w.get(seventh).skipPermissions, undefined);
  assert.equal(w.drafts.get(ids[0]), 'Unsent work stays here');
  for (const old of before) {
    assert.equal(w.get(old.id).nativeId, old.nativeId); assert.equal(w.get(old.id).state, old.state);
    assert.equal(w.runtimes.get(old.id), old.runtime);
  }
});
test('only a session created without a name takes the native title, with its provider', async t => {
  const { workspace: w, runtimes: [claude, codex], ids: [a, b] } = await fixture(t, 2);
  assert.equal(w.get(a).name, 'Test 0'); claude.emit('nativeTitle', 'Ignored'); assert.equal(w.get(a).name, 'Test 0');
  const c = await w.create('codex', w.get(a).cwd, 'owner'), unnamed = w.get(c), runtime = w.runtimes.get(c);
  assert.equal(unnamed.autoName, true); assert.equal(unnamed.name, 'Codex 2');
  runtime.emit('nativeTitle', '  '); assert.equal(unnamed.name, 'Codex 2', 'An empty native name changes nothing');
  unnamed.messages.push({ id: 'first', role: 'user', text: 'Make the\nqueue test stable', status: 'submitted' }); w.changed();
  assert.equal(unnamed.name, 'Codex · Make the queue test stable', 'The first request stands in until a native title');
  unnamed.messages.push({ id: 'second', role: 'user', text: 'Later words', status: 'submitted' }); w.changed();
  assert.equal(unnamed.name, 'Codex · Make the queue test stable');
  runtime.emit('nativeTitle', 'Fix the queue'); assert.equal(unnamed.name, 'Codex · Fix the queue');
  w.changed(); assert.equal(unnamed.name, 'Codex · Fix the queue', 'A native title is not replaced by the preview');
  runtime.emit('nativeTitle', 'x'.repeat(80)); assert.equal(unnamed.name.length, 60);
  assert.equal(w.get(b).autoName, undefined);
});
test('a session records when it was created and when it was last active, not a restart', async t => {
  const { workspace: w, ids: [id] } = await fixture(t);
  const s = w.get(id); assert.ok(Number.isFinite(s.createdAt)); assert.equal(s.lastActivityAt, s.createdAt);
  w.changed(); s.lastActivityAt = 1; w.changed(); assert.equal(s.lastActivityAt, 1, 'No new activity, no new time');
  s.messages.push({ id: 'm1', role: 'user', text: 'hello', status: 'awaiting-native' }); w.changed(); assert.ok(s.lastActivityAt > 1);
  s.lastActivityAt = 2; s.messages.at(-1).status = 'submitted'; w.changed(); assert.ok(s.lastActivityAt > 2, 'The newest message changing state is activity');
  s.lastActivityAt = 3; s.messages.push({ id: 'v1', role: 'tool', volatile: true, text: 'progress', status: 'running' }); w.changed(); assert.equal(s.lastActivityAt, 3, 'A volatile display row is not saved activity');
  w.persist(); const saved = JSON.parse(require('node:fs').readFileSync(require('node:path').join(w.dataDir, 'workspace.json'), 'utf8'));
  assert.equal(saved.sessions[0].createdAt, s.createdAt);
  // After a restart, loading is no activity, but the first real change is.
  const { Workspace } = require('../workspace.cjs');
  const reopened = new Workspace({ binaries: {}, close() {}, create() { return new EventEmitter(); } }, w.dataDir); t.after(() => reopened.close());
  const r = reopened.get(id); r.lastActivityAt = 3; reopened.changed(); assert.equal(r.lastActivityAt, 3);
  r.messages.push({ id: 'm2', role: 'assistant', text: 'reply', status: 'complete' }); reopened.changed(); assert.ok(r.lastActivityAt > 3, 'The first change after loading counts');
});
test('a creation-time choice to skip confirmations is recorded for that session only', async t => {
  const { workspace: w, ids: [a] } = await fixture(t);
  const id = await w.create('claude', w.get(a).cwd, 'owner', 'Bypass', 'chat', { skipPermissions: true });
  assert.equal(w.get(id).skipPermissions, true); assert.equal(w.get(a).skipPermissions, undefined);
  // Known from the launch itself, so a crash before the first tool hook still recovers in bypass.
  assert.equal(w.get(id).nativePermissionMode, 'bypassPermissions'); assert.equal(w.get(a).nativePermissionMode, undefined);
  await assert.rejects(w.create('claude', w.get(a).cwd, 'owner', 'Bad', 'chat', { skipPermissions: 'yes' }), /无效的权限选项/);
});
test('a completed failed request permits only an explicit new task, never an automatic run or queue', async t => {
  const { workspace: w, runtimes: [r], ids: [id] } = await fixture(t);
  const s = w.get(id); s.state = 'error'; r.failedTurnInputId = 'failed-turn'; r.failedTurnInputMatches = id => id === 'failed-turn';
  r.chatAvailable = true; r.queueAvailable = true; let calls = 0, accept, guard;
  r.send = (_text, _tag, valid) => { calls++; guard = valid; return new Promise(resolve => { accept = resolve; }); };
  await assert.rejects(w.send(id, 'automatic', null, { id: 'run' }), /尚未就绪/);
  await assert.rejects(w.queue(id, 'queued', 'owner'), /不能接收/);
  const sent = w.send(id, 'new user task', 'owner');
  assert.equal(calls, 1); assert.equal(s.state, 'error'); assert.ok(guard());
  await assert.rejects(w.send(id, 'duplicate', 'owner'), /尚未就绪/);
  accept(); await sent;
});
test('private queued input retains native work, rejects duplicates and preserves a newer draft after ACK', async t => {
  const { workspace: w, runtimes: [r], ids: [id] } = await fixture(t);
  const s = w.get(id); s.state = 'working'; s.pendingTag = 'original'; r.queueAvailable = true;
  w.setDraft(id, 'next task', 'owner'); let accept;
  r.queue = () => new Promise(resolve => { accept = resolve; });
  const sending = w.queue(id, 'next task', 'owner');
  assert.equal(s.pendingTag, 'original'); assert.equal(s.state, 'working');
  assert.equal(w.snapshot().sessions[0].liveDraft, '');
  assert.equal(w.snapshot().sessions[0].pendingQueue, s.messages.at(-1).id);
  assert.equal(s.messages.at(-1).status, 'awaiting-native');
  await assert.rejects(w.queue(id, 'duplicate', 'owner'), /不能接收/);
  await assert.rejects(w.send(id, 'duplicate', 'owner'), /尚未就绪/);
  w.setDraft(id, 'new draft', 'owner'); accept(); await sending;
  assert.equal(w.snapshot().sessions[0].liveDraft, 'new draft');
  assert.equal(s.messages.at(-1).status, 'submitted'); assert.equal(r.pendingQueue, null);
});
test('uncertain queued input stays only in the record, without automatic retry', async t => {
  const { workspace: w, runtimes: [r], ids: [id] } = await fixture(t);
  const s = w.get(id); s.state = 'working'; r.queueAvailable = true;
  w.setDraft(id, 'next task', 'owner'); let calls = 0;
  r.queue = async () => { calls++; throw Error('native disconnected'); };
  await assert.rejects(w.queue(id, 'next task', 'owner'), /disconnected/);
  assert.equal(calls, 1); assert.equal(s.messages.at(-1).status, 'unconfirmed'); assert.equal(s.messages.at(-1).text, 'next task');
  assert.equal(w.snapshot().sessions[0].liveDraft, ''); assert.equal(s.state, 'working');
});
test('a queued input proven not sent returns to an untouched draft only', async t => {
  const { workspace: w, runtimes: [r], ids: [id] } = await fixture(t);
  const s = w.get(id); s.state = 'working'; r.queueAvailable = true;
  w.setDraft(id, 'next task', 'owner'); let reject;
  r.queue = () => new Promise((_resolve, fail) => { reject = fail; });
  const refused = w.queue(id, 'next task', 'owner');
  assert.equal(w.snapshot().sessions[0].liveDraft, '');
  reject(Object.assign(Error('native draft'), { notSent: true })); await assert.rejects(refused, /native draft/);
  assert.equal(s.messages.at(-1).status, 'not-sent'); assert.equal(w.snapshot().sessions[0].liveDraft, 'next task');
  const edited = w.queue(id, 'next task', 'owner');
  w.setDraft(id, 'newer words', 'owner');
  reject(Object.assign(Error('native draft'), { notSent: true })); await assert.rejects(edited, /native draft/);
  assert.equal(s.messages.at(-1).status, 'not-sent'); assert.equal(w.snapshot().sessions[0].liveDraft, 'newer words');
});
test('shared waiting input binds only its next native prompt and preserves the solo draft', async t => {
  const { workspace: w, runtimes: [r], ids: [id] } = await fixture(t);
  const s = w.get(id); w.join(id, true); s.state = 'working'; s.pendingTag = 'private-original'; r.queueAvailable = true; r.nativeBlocks = true;
  w.setDraft(id, 'solo draft', 'owner'); let accept, tag, valid;
  r.queue = (_text, value, guard) => { tag = value; valid = guard; return new Promise(resolve => { accept = resolve; }); };
  const pending = w.queue(id, 'shared next task', 'owner', { replyTo: 'discussion-parent' });
  const source = w.room.messages.find(m => m.id === tag);
  assert.equal(source.status, 'awaiting-native'); assert.equal(source.replyTo, 'discussion-parent');
  assert.equal(source.deliveries[0].text, 'shared next task'); assert.ok(valid());
  r.emit('nativeBlock', { id: 'display:private', nativeId: s.nativeId, kind: 'response', turnId: 'private-turn', promptId: 'private-prompt', text: 'PRIVATE_ORIGINAL_BODY', status: 'streaming' });
  r.emit('complete', { tag: 'private-original', text: 'PRIVATE_ORIGINAL_BODY' });
  assert.ok(!JSON.stringify(w.room.messages).includes('PRIVATE_ORIGINAL_BODY'));
  r.emit('submitted', tag);
  r.emit('replyBound', { tag, nativeId: s.nativeId, turnId: 'queued-turn', promptId: 'queued-prompt' });
  r.emit('nativeBlock', { id: 'display:next', nativeId: s.nativeId, kind: 'response', turnId: 'queued-turn', promptId: 'queued-prompt', text: 'SHARED_NEXT_BODY', status: 'complete' });
  r.emit('complete', { tag, messageId: `native:${s.nativeId}:display:next`, text: 'SHARED_NEXT_BODY' });
  accept(); await pending;
  assert.equal(w.room.messages.filter(m => m.text === 'SHARED_NEXT_BODY').length, 1);
  assert.equal(w.room.messages.find(m => m.text === 'SHARED_NEXT_BODY').replyTo, tag);
  assert.equal(source.deliveries[0].status, 'submitted');
  assert.equal(w.drafts.get(id), 'solo draft'); assert.equal(w.versions.dispatches, 1);
});
for (const change of ['leave', 'takeover', 'clear', 'context', 'approval']) test(`shared waiting input loses permission after ${change} without erasing receipt`, async t => {
  const { workspace: w, runtimes: [r], ids: [id] } = await fixture(t);
  const s = w.get(id); w.join(id, true); s.state = 'working'; r.queueAvailable = true; r.nativeBlocks = true;
  let accept, valid, tag;
  r.queue = (_text, value, guard) => { tag = value; valid = guard; return new Promise(resolve => { accept = resolve; }); };
  const pending = w.queue(id, 'queued public material', 'owner', {});
  const source = w.room.messages.find(m => m.id === tag);
  if (change === 'leave') w.join(id, false);
  if (change === 'takeover') w.claim(id, 'other');
  if (change === 'clear') w.clearSharedHistory();
  if (change === 'context') s.nativeId = 'new-native';
  if (change === 'approval') s.approval = { requestId: 'new-approval' };
  assert.equal(valid(), false);
  // Native may already have accepted it before the user changed membership.
  r.emit('submitted', tag); r.emit('replyBound', { tag, nativeId: s.nativeId, turnId: 'next-turn', promptId: 'next-prompt' });
  r.emit('nativeBlock', { id: 'display:late', nativeId: s.nativeId, kind: 'response', turnId: 'next-turn', promptId: 'next-prompt', text: 'PRIVATE_LATE_BODY', status: 'complete' });
  r.emit('complete', { tag, text: 'PRIVATE_LATE_BODY' }); accept(); await pending;
  assert.ok(!JSON.stringify(w.room.messages).includes('PRIVATE_LATE_BODY'));
  if (change !== 'clear') assert.equal(source.deliveries[0].status, 'submitted');
  else assert.equal(w.room.messages.length, 0);
});
test('unattributed waiting receipt stays visible but cannot share the next private reply', async t => {
  const { workspace: w, runtimes: [r], ids: [id] } = await fixture(t);
  const s = w.get(id); w.join(id, true); s.state = 'working'; r.queueAvailable = true; r.nativeBlocks = true;
  r.queue = async (_text, tag) => { r.emit('submitted', tag); r.emit('unattributed', tag); r.emit('complete', { text: 'PRIVATE_UNKNOWN_REPLY' }); };
  await w.queue(id, 'waiting instruction', 'owner', {});
  const source = w.room.messages.find(m => m.text === 'waiting instruction');
  assert.equal(source.status, 'reply-private'); assert.equal(source.deliveries[0].status, 'submitted');
  assert.equal(w.forwards.size, 0); assert.ok(!JSON.stringify(w.room.messages).includes('PRIVATE_UNKNOWN_REPLY'));
});
test('native tool history persists privately without automatically entering the room', async t => {
  const { workspace: w, runtimes: [r], ids: [id], directory } = await fixture(t);
  const s = w.get(id); w.join(id, true); r.nativeBlocks = true;
  r.emit('nativeBlock', { id: 'display:one', nativeId: s.nativeId, kind: 'response', text: 'visible reply', status: 'complete' });
  r.emit('nativeBlock', { id: 'tool:one', nativeId: s.nativeId, kind: 'tool', text: 'PRIVATE_TOOL_BODY', input: 'PRIVATE_INPUT', status: 'complete' });
  r.emit('complete', { text: 'visible reply' });
  assert.equal(s.messages.filter(m => m.text === 'visible reply').length, 1);
  assert.ok(s.messages.some(m => m.text === 'PRIVATE_TOOL_BODY'));
  assert.ok(!JSON.stringify(w.room.messages).includes('PRIVATE_TOOL_BODY'));
  w.persist(); const stored = fs.readFileSync(path.join(directory, 'workspace.json'), 'utf8');
  assert.ok(stored.includes('visible reply')); assert.ok(stored.includes('PRIVATE_TOOL_BODY')); assert.ok(stored.includes('PRIVATE_INPUT'));
  assert.ok(!JSON.stringify(JSON.parse(stored).room).includes('PRIVATE_TOOL_BODY'));
});
test('shared human message survives uncertain delivery and restart without replay', async t => {
  const { workspace: w, runtimes: [r], ids: [id], directory } = await fixture(t);
  w.join(id, true);
  let reject;
  r.send = () => new Promise((resolve, fail) => { reject = fail; });
  const sending = w.forward(id, 'human message remains visible', 'owner');
  const failed = assert.rejects(sending, /uncertain/);
  const message = w.room.messages.at(-1);
  assert.equal(message.text, 'human message remains visible');
  assert.equal(message.deliveries[0].recipientId, id);
  assert.equal(message.deliveries[0].status, 'awaiting-native');
  w.persist();
  const cold = new Workspace({ binaries: {}, close() {} }, directory); t.after(() => cold.close());
  assert.equal(cold.room.messages.at(-1).deliveries[0].status, 'unconfirmed');
  assert.equal(cold.versions.dispatches, 0);
  reject(Error('uncertain')); await failed;
  assert.equal(message.status, 'unconfirmed'); assert.equal(message.deliveries[0].status, 'unconfirmed');
  assert.equal(w.room.messages.at(-1).text, 'human message remains visible');
  assert.equal(w.versions.dispatches, 1);
});
test('native receipt is not revoked when the recipient leaves or reply sharing becomes private', async t => {
  const { workspace: w, runtimes: [r], ids: [id] } = await fixture(t);
  w.join(id, true); await w.forward(id, 'explicit share', 'owner');
  const message = w.room.messages.at(-1), tag = message.id;
  r.emit('submitted', tag); w.join(id, false);
  r.emit('complete', { tag, text: 'private after leaving' });
  r.emit('failed', 'later failure', { tag });
  assert.equal(message.status, 'reply-private');
  assert.equal(message.deliveries[0].status, 'submitted');
  assert.ok(!w.room.messages.some(m => m.text === 'private after leaving'));
  assert.equal(w.versions.dispatches, 1);
});
test('bounded handoff records the exact native input on its source message without broadcasting private history', async t => {
  const { workspace: w, runtimes, ids, directory } = await fixture(t, 2);
  const sent = [];
  runtimes.forEach((r, i) => { r.send = async (text, tag) => { sent.push({ id: ids[i], text, tag }); r.emit('submitted', tag); }; });
  ids.forEach(id => w.join(id, true));
  w.get(ids[0]).messages.push({ id: 'private', role: 'user', text: 'never share this previous private text' });
  await w.startRun(ids, 'add 25 and 50', 2, 'replies');
  const goal = w.room.messages.find(m => m.role === 'human');
  assert.equal(goal.deliveries.length, 1); assert.equal(goal.deliveries[0].recipientId, ids[0]);
  assert.equal(goal.deliveries[0].text, sent[0].text); assert.equal(goal.deliveries[0].status, 'submitted');
  runtimes[0].emit('complete', { tag: sent[0].tag, text: '75' }); await tick();
  const reply = w.room.messages.find(m => m.role === 'assistant');
  assert.equal(reply.text, '75'); assert.equal(reply.deliveries[0].recipientId, ids[1]);
  assert.equal(reply.deliveries[0].text, sent[1].text);
  assert.ok(reply.deliveries[0].text.includes('add 25 and 50'));
  assert.ok(!JSON.stringify(w.room.messages).includes('never share this previous private text'));
  runtimes[1].emit('complete', { tag: sent[1].tag, text: 'checked: 75' }); await tick();
  const final = w.room.messages.find(m => m.text === 'checked: 75');
  assert.equal(final.deliveryTracked, true); assert.equal(final.deliveries, undefined);
  assert.equal(sent.length, 2); assert.equal(w.versions.shellModelCalls, 0);
  w.persist();
  const cold = new Workspace({ binaries: {}, close() {} }, directory); t.after(() => cold.close());
  assert.deepEqual(cold.room.messages, w.room.messages);
  cold.clearSharedHistory();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'workspace.json'))).room.messages, []);
});

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
test('paused handoff retains its exact waiting session as a cold-readable reference without sharing private replies', async t => {
  const { workspace: w, runtimes: [r], ids, directory } = await fixture(t, 2);
  ids.forEach(id => w.join(id, true));
  await w.startRun(ids, '核查合计 75 元', 2, 'replies');
  const tag = w.room.run.awaiting.tag;
  r.emit('state', 'approval');
  const event = w.room.messages.at(-1);
  assert.equal(event.role, 'system'); assert.equal(event.name, '协作');
  assert.equal(event.sessionId, ids[0]); assert.equal(event.runId, w.room.run.id);
  r.emit('complete', { tag, text: 'Private budget answer' }); await tick();
  assert.equal(w.room.run.status, 'paused'); assert.equal(w.versions.dispatches, 1);
  assert.ok(w.get(ids[0]).messages.some(m => m.text === 'Private budget answer'));
  assert.ok(w.room.messages.every(m => m.text !== 'Private budget answer'));
  w.persist();
  const cold = new Workspace({ binaries: {}, close() {} }, directory); t.after(() => cold.close());
  assert.equal(cold.room.run.awaiting, null);
  assert.equal(cold.room.messages.find(m => m.id === event.id).sessionId, ids[0]);
  assert.equal(cold.versions.dispatches, 0);
  assert.equal(cold.get(ids[0]).state, 'recoverable');
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
  assert.deepEqual(recovered.get(id).messages, stored.sessions[0].messages.map(m => ({ ...m, status: 'unconfirmed' })));
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

test('three selected independent sessions preserve exact order, alias identity and a total reply cap; unselected history stays private', async t => {
  const { workspace: w, runtimes, ids } = await fixture(t, 4), sends = [];
  ids.forEach(id => { w.join(id, true); w.get(id).name = '伙伴'; w.get(id).messages.push({ id: 'secret-' + id, role: 'user', text: 'PRIVATE-' + id }); });
  runtimes.forEach((r, i) => { r.send = async (text, tag, guard) => { assert.ok(guard()); sends.push({ i, text, tag }); }; });
  await assert.rejects(w.startRun([ids[0], ids[1], ids[1]], 'task', 3, 'replies'), /不同会话/);
  await assert.rejects(w.startRun(ids.slice(0, 3), 'task', 2, 'replies'), /上限/);
  await w.startRun([ids[2], ids[0], ids[1]], '核对材料', 4, 'replies', { [ids[2]]: '预算复核' });
  for (let i = 0; i < 4; i++) {
    const sent = sends[i]; assert.ok(sent); assert.ok(!sent.text.includes('PRIVATE-'));
    runtimes[sent.i].emit('complete', { tag: sent.tag, text: `结果 ${i}` }); await tick();
  }
  assert.deepEqual(sends.map(s => s.i), [2, 0, 1, 2]); assert.equal(w.room.run.status, 'completed');
  assert.match(sends[1].text, /预算复核 · Codex/); assert.ok(sends[2].text.includes(ids[0].slice(0, 6)));
  assert.ok(!sends[2].text.includes('结果 0')); assert.equal(w.get(ids[3]).messages.length, 1);
});
for (const action of ['leave-third', 'takeover-third']) test(`three-party authorization stops before the next hop on ${action}`, async t => {
  const { workspace: w, runtimes, ids } = await fixture(t, 3), sends = [];
  ids.forEach(id => w.join(id, true)); runtimes.forEach((r, i) => { r.send = async (text, tag) => sends.push({ i, tag }); });
  await w.startRun(ids, 'task', 3, 'replies');
  if (action === 'leave-third') { w.join(ids[2], false); w.join(ids[2], true); }
  else w.claim(ids[2], 'another-window', 'chat');
  runtimes[0].emit('complete', { tag: sends[0].tag, text: 'late reply' }); await tick();
  assert.equal(sends.length, 1); assert.equal(w.room.run.status, 'paused');
  assert.equal(w.room.messages.some(m => m.text === 'late reply'), false);
});

test('bounded task length fails before dispatch and reports its actual limit', async t => {
  const { workspace: w, ids } = await fixture(t, 2); ids.forEach(id => w.join(id, true));
  await assert.rejects(w.startRun(ids, 'x'.repeat(6001), 2, 'replies'), /6,000/);
  assert.equal(w.versions.dispatches, 0); assert.equal(w.room.run, null);
});
test('disconnected and failed native observations stop claiming in-flight tools are running', async t => {
  const { workspace: w, runtimes: [r], ids: [id] } = await fixture(t);
  r.emit('nativeBlock', { nativeId: w.get(id).nativeId, id: 'tool:flight', kind: 'tool', turnId: 'turn', title: 'Command', status: 'running', text: 'partial' });
  r.emit('state', 'disconnected'); const tool = w.get(id).messages.find(m => m.kind === 'tool');
  assert.equal(tool.status, 'unconfirmed'); assert.equal(tool.text, 'partial');
  r.emit('nativeBlock', { nativeId: w.get(id).nativeId, id: 'tool:flight', kind: 'tool', status: 'running', delta: ' continued' });
  assert.equal(tool.status, 'running'); r.emit('failed', 'Provider unavailable'); assert.equal(tool.status, 'unconfirmed');
});

for (const accepted of [true, false]) test(`working-turn input ${accepted ? 'accepted' : 'unconfirmed'} preserves current output and newer draft`, async t => {
  const { workspace: w, runtimes: [r], ids: [id] } = await fixture(t);
  const s = w.get(id); s.provider = 'codex'; r.steerAvailable = true; r.turnId = 'active';
  s.state = 'working'; s.pendingTag = 'original';
  s.messages.push({ id: 'response', role: 'assistant', text: 'Still running', status: 'streaming' });
  w.setDraft(id, 'change requirement', 'owner');
  let finish;
  r.steer = async (text, tag, turnId, guard) => {
    assert.equal(text, 'change requirement'); assert.equal(turnId, 'active'); assert.ok(guard());
    await new Promise(resolve => { finish = resolve; });
    if (!accepted) throw Error('native result unknown');
    r.emit('submitted', tag);
  };
  const sending = w.steer(id, 'change requirement', 'owner', 'active');
  assert.equal(w.snapshot().sessions[0].pendingSteer, s.messages.at(-1).id);
  await assert.rejects(w.steer(id, 'duplicate click', 'owner', 'active'));
  w.setDraft(id, 'newer draft', 'owner'); finish();
  if (accepted) await sending; else await assert.rejects(sending);
  assert.equal(w.drafts.get(id), 'newer draft');
  assert.equal(s.messages.find(m => m.id === 'response').status, 'streaming');
  assert.equal(s.pendingTag, 'original'); assert.equal(s.state, 'working');
  assert.equal(s.messages.at(-1).status, accepted ? 'submitted' : 'unconfirmed');
  assert.equal(w.versions.dispatches, 1); assert.equal(r.pendingSteer, null);
  await assert.rejects(w.steer(id, 'stale click', 'owner', 'stale'));
  await assert.rejects(w.steer(id, 'wrong owner', 'observer', 'active'));
  assert.equal(w.versions.dispatches, 1);
});

for (const accepted of [true, false]) test(`private GUI steering (${accepted ? 'accepted' : 'unconfirmed'}) freezes the old room stream before native continuation`, async t => {
  const { workspace: w, runtimes: [r], ids: [id] } = await fixture(t);
  const s = w.get(id); s.provider = 'codex'; w.join(id, true);
  const tag = await w.send(id, 'shared task', 'owner', null, true);
  r.emit('submitted', tag); r.emit('replyBound', { tag, nativeId: s.nativeId, turnId: 'active' });
  r.emit('state', 'working'); r.turnId = 'active'; r.steerAvailable = true;
  r.nativeActivity = { nativeId: s.nativeId, turnId: 'active', label: '执行命令' };
  const block = { id: 'same-block', nativeId: s.nativeId, turnId: 'active', kind: 'response', text: 'shared prefix', status: 'streaming' };
  r.emit('nativeBlock', block);
  assert.ok(w.room.messages.some(m => m.text === 'shared prefix'));
  assert.equal(w.snapshot().sessions.find(s=>s.id===id).sharedActivity.label, '执行命令');
  r.steer = async (text, steerTag, turnId, guard) => {
    assert.ok(guard());
    r.emit('nativeBlock', { ...block, text: 'private continuation' });
    if (!accepted) throw Error('Native acknowledgement unavailable');
    r.emit('submitted', steerTag);
  };
  const sending = w.steer(id, 'private requirement', 'owner', 'active');
  if (accepted) await sending; else await assert.rejects(sending);
  assert.equal(r.turnId, 'active'); assert.equal(w.snapshot().sessions.find(s=>s.id===id).sharedActivity, null, 'Private steer retires activity proof even in the same turn');
  r.emit('complete', { tag, messageId: 'same-block', text: 'private continuation' }); await tick();
  assert.ok(s.messages.some(m => m.text === 'private continuation'));
  assert.ok(!w.room.messages.some(m => m.text?.includes('private')));
  const frozen = w.room.messages.find(m => m.text === 'shared prefix');
  assert.equal(frozen.status, 'unconfirmed'); assert.ok(frozen.sharingStopped);
  assert.equal(w.versions.dispatches, 2);
});

for (const accepted of [true, false]) test(`private Claude queue (${accepted}) revokes current room reply before later native text`, async t => {
  const { workspace: w, runtimes: [r], ids: [id] } = await fixture(t);
  const s = w.get(id); w.join(id, true); r.nativeBlocks = true;
  const tag = await w.send(id, 'shared task', 'owner', null, true);
  r.emit('submitted', tag); r.emit('replyBound', { tag, nativeId: s.nativeId, turnId: 'active', promptId: 'prompt-active' });
  r.emit('state', 'working'); r.queueAvailable = true;
  const block = { id: 'display:shared', nativeId: s.nativeId, turnId: 'active', promptId: 'prompt-active', kind: 'response', text: 'shared prefix', status: 'streaming' };
  r.emit('nativeBlock', block); assert.ok(w.room.messages.some(m => m.text === 'shared prefix'));
  r.queue = async (text, queueTag, guard) => {
    assert.ok(guard()); r.emit('nativeBlock', { ...block, text: 'private continuation' });
    if (!accepted) throw Error('No native receipt');
    r.emit('submitted', queueTag);
  };
  const sending = w.queue(id, 'private requirement', 'owner');
  if (accepted) await sending; else await assert.rejects(sending);
  r.emit('complete', { tag, messageId: 'display:shared', text: 'private continuation' }); await tick();
  assert.ok(s.messages.some(m => m.text === 'private continuation'));
  assert.ok(!w.room.messages.some(m => m.text?.includes('private')));
  assert.ok(w.room.messages.find(m => m.text === 'shared prefix').sharingStopped);
  assert.equal(w.versions.dispatches, 2);
});
