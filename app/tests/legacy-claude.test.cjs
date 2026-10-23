const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { LegacyClaude } = require('../legacy-claude.cjs');
const { processIdentity } = require('../platform.cjs');
function fixture(t, state = 'idle') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retained-claude-'));
  const record = { id: 'retained', nativeId: crypto.randomUUID(), pid: process.pid,
    processIdentity: processIdentity(process.pid), state, messages: [{ id: 'old', role: 'assistant', text: 'old visible answer' }] };
  const readers = [], create = () => { const r = new LegacyClaude(record, dir, async () => record); readers.push(r); return r; };
  t.after(() => { readers.forEach(r => r.close()); fs.rmSync(dir, { recursive: true, force: true }); });
  return { record, dir, create, r: create() };
}
async function bind(f) { return { sessionId: f.record.nativeId, ...await f.r.bindRoot({ sessionId: f.record.nativeId, nativeBlocks: true }) }; }
function block(f, b, sequence, extra) { return f.r.observeRoot({ ...b, epoch: b.observationEpoch, sequence, block: true, id: 'display:visible', kind: 'response', turnId: 'turn-1', promptId: 'prompt-1', index: 0, delta: 'visible prefix', status: 'streaming', ...extra }); }

test('attach-only reader waits for old work to finish and never starts or controls a CLI', async t => {
  const f = fixture(t, 'working');
  assert.equal(fs.readdirSync(f.dir).length, 0);
  await assert.rejects(bind(f), /idle/); assert.equal(f.r.initialized, false);
  f.record.messages.push({ id: 'last-old-final', role: 'assistant', text: 'finished old work' }); f.record.state = 'idle';
  await bind(f); assert.ok(f.r.record.messages.some(m => m.id === 'last-old-final'));
  assert.equal(f.r.record.pid, process.pid);
  for (const method of ['send', 'stop', 'interrupt', 'clearRoot']) assert.throws(() => f.r[method]());
  await assert.rejects(f.r.queue('not ready', crypto.randomUUID(), () => true));
});
test('native inputs, transformed display and tool output use stable blocks without old final duplicates', async t => {
  const f = fixture(t), b = await bind(f);
  block(f, b, 1, { id: 'prompt:accepted', kind: 'input', turnId: undefined, index: undefined, delta: undefined, text: 'native user input', status: 'complete' });
  block(f, b, 2); block(f, b, 3, { index: 1, delta: ' and final', status: 'complete' });
  f.record.messages.push({ id: 'random-old-cache', role: 'assistant', text: 'untransformed final' });
  assert.equal(f.r.record.messages.filter(m => m.role === 'user').length, 1);
  assert.equal(f.r.record.messages.filter(m => m.id.includes('display:visible')).length, 1);
  assert.ok(!JSON.stringify(f.r.record.messages).includes('untransformed final'));
  block(f, b, 4, { id: 'tool:orphan', kind: 'tool', text: 'unknown tool', delta: undefined, index: undefined, status: 'complete' });
  assert.ok(!f.r.record.messages.some(m => m.id.includes('tool:orphan')));
  block(f, b, 5, { id: 'tool:known', kind: 'tool', input: '{"test":true}', delta: undefined, index: undefined, status: 'running' });
  block(f, b, 6, { id: 'tool:known', kind: 'tool', text: 'public output', delta: undefined, index: undefined, status: 'complete' });
  assert.equal(f.r.record.messages.find(m => m.id.includes('tool:known')).text, 'public output');
});
test('persisted private reader survives reopen; raw legacy final cannot replace it; old epochs and roots fail', async t => {
  const f = fixture(t), b = await bind(f); block(f, b, 1); f.r.close();
  assert.equal(fs.statSync(f.r.filename).mode & 0o777, 0o600);
  f.record.messages.push({ id: 'late-raw', role: 'assistant', text: 'raw unmatched body' });
  f.r = f.create(); const next = await bind(f);
  assert.equal(f.r.record.messages.find(m => m.id.includes('display:visible')).text, 'visible prefix');
  assert.ok(!f.r.record.messages.some(m => m.id === 'late-raw'));
  assert.throws(() => block(f, b, 2, { index: 1, delta: 'old epoch' }));
  f.r.endRoot({ ...next, reason: 'clear' });
  assert.throws(() => block(f, next, 1)); await assert.rejects(bind(f));
  assert.equal(f.r.record.nativeId, f.record.nativeId);
});
test('unsafe or corrupt projection does not fall back to raw private content', t => {
  const f = fixture(t); fs.writeFileSync(f.r.filename, '{}', { mode: 0o600 });
  assert.throws(f.create, /identity/);
  fs.chmodSync(f.r.filename, 0o644); assert.throws(f.create, /Unsafe/);
});

test('retained queue waits without timeout or retry and reconciles only its exact native input tag', async t => {
  const { EventEmitter } = require('node:events');
  const f = fixture(t);
  const b = { sessionId: f.record.nativeId, ...await f.r.bindRoot({ sessionId: f.record.nativeId, nativeBlocks: true, nativeQueue: true }) };
  const wire = [], response = new EventEmitter(); response.end = body => wire.push(JSON.parse(body));
  f.r.submission.timeout = 15; f.r.submission.receive(response);
  const tag = crypto.randomUUID(), text = 'queued native instruction';
  const done = f.r.queue(text, tag, () => true);
  assert.equal(f.r.pendingQueue, tag); assert.equal(wire.length, 1);
  assert.equal(f.r.submission.authorize({ id: tag, text }), true);
  await new Promise(r => setTimeout(r, 45));
  assert.equal(f.r.pendingQueue, tag);
  await assert.rejects(f.r.queue('duplicate', crypto.randomUUID(), () => true));
  block(f, b, 1, { id: 'prompt:foreign', kind: 'input', turnId: undefined, index: undefined, delta: undefined, text, status: 'complete' });
  assert.equal(f.r.record.messages.find(m => m.id === tag).status, 'awaiting-native', 'Same text from another ingress is not acceptance');
  block(f, b, 2, { id: 'prompt:ours', kind: 'input', turnId: undefined, index: undefined, delta: undefined, text, inputTag: tag, status: 'complete' });
  f.r.submission.result({ id: tag, status: 'accepted' }); await done;
  assert.equal(f.r.pendingQueue, null);
  assert.equal(f.r.record.messages.filter(m => m.text === text).length, 2, 'Exactly one native row for each actual input');
  assert.ok(!f.r.record.messages.some(m => m.id === tag));
  assert.equal(wire.length, 1);
  response.emit('close');
});

test('queued input becomes uncertain on observer close and is never replayed after reopen', async t => {
  const { EventEmitter } = require('node:events');
  const f = fixture(t); await f.r.bindRoot({ sessionId: f.record.nativeId, nativeBlocks: true, nativeQueue: true });
  const wire = [], response = new EventEmitter(); response.end = body => wire.push(JSON.parse(body));
  f.r.submission.receive(response);
  const tag = crypto.randomUUID(), done = f.r.queue('preserved queue text', tag, () => true);
  assert.equal(f.r.submission.authorize({ id: tag, text: 'preserved queue text' }), true);
  const rejected = assert.rejects(done, /关闭/); f.r.close(); await rejected;
  f.r = f.create();
  assert.equal(f.r.pendingQueue, null); assert.equal(f.r.queueAvailable, false);
  assert.equal(f.r.record.messages.find(m => m.id === tag).status, 'unconfirmed');
  assert.equal(wire.filter(row => row.id === tag).length, 1);
  response.emit('close');
});


async function queueRouter(t) {
  const { EventEmitter } = require('node:events');
  const { WorkspaceClient } = require('../workspace-client.cjs'), { LegacyInput } = require('../legacy-input.cjs');
  const f = fixture(t);
  Object.assign(f.record, { provider: 'claude', name: 'Claude A', terminalAvailable: true, owner: 'view', roomId: 'shared', memberRevision: 2, controlRevision: 1, liveDraft: 'PRIVATE DRAFT' });
  const binding = { sessionId: f.record.nativeId, ...await f.r.bindRoot({ sessionId: f.record.nativeId, nativeBlocks: true, nativeQueue: true, nativeSharedDisplay: true }) };
  f.record.state = 'working'; f.r.record.provider = 'claude';
  const bridge = new LegacyInput(f.dir); bridge.targets.set(f.record.id, f.r); bridge.readers.set(f.record.id, f.r);
  f.r.on('readerBlock', m => bridge.observeReader(f.r, m));
  f.r.on('sharingBoundary', () => bridge.sharedReplies.revoke(f.record.id));
  f.r.on('contextEnd', () => bridge.sharedReplies.revoke(f.record.id));
  const state = { runtimeVersion: '0.1.0-alpha.2', owner: 'view', capabilities: [], sessions: [f.record], room: { messages: [] }, diagnostics: {} };
  const client = new EventEmitter(); client.call = async (method, ...args) => {
    if (method === 'initial') return structuredClone(state);
    if (method === 'draft') f.record.liveDraft = args[1];
    return true;
  }; client.close = () => client.emit('closed');
  const router = new WorkspaceClient([{ key: '.', state: structuredClone(state), client }], '.'); router.control.legacyInput = bridge;
  t.after(() => { router.close(); bridge.close(); });
  const wire = [], response = new EventEmitter(); response.end = body => wire.push(JSON.parse(body));
  f.r.submission.timeout = 15; f.r.submission.receive(response);
  t.after(() => response.emit('close'));
  let sequence = 0;
  const event = extra => f.r.observeRoot({ ...binding, epoch: binding.observationEpoch, sequence: ++sequence, block: true,
    id: 'display:private', kind: 'response', turnId: 'private-turn', promptId: crypto.randomUUID(), index: 0, delta: '', status: 'complete', ...extra });
  return { ...f, bridge, router, wire, event };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
test('a newer shared queue cancels an older delayed send intent without replaying it after acceptance', async t => {
  const f = await queueRouter(t); let release, calls = 0;
  const pause = f.router.pauseExcept.bind(f.router);
  f.router.pauseExcept = async (...args) => { if (++calls === 1) await new Promise(resolve => { release = resolve; }); return pause(...args); };
  const old = f.router.call('queueShared', f.record.id, 'obsolete delayed input', f.record.nativeId);
  const rejected = assert.rejects(old, /已变化|草稿保留/);
  await settle();
  const current = f.router.call('queueShared', f.record.id, 'newer input', f.record.nativeId);
  current.catch(() => {}); await settle(); const tag = f.r.pendingQueue;
  assert.equal(f.r.submission.authorize({ id: tag, text: 'newer input' }), true);
  const promptId = crypto.randomUUID();
  f.event({ id: `prompt:${promptId}`, kind: 'input', text: 'newer input', inputTag: tag, turnId: 'newer-turn', promptId });
  f.r.submission.result({ id: tag, status: 'accepted', turnId: 'newer-turn', promptId }); await current;
  release(); await rejected;
  assert.equal(f.r.pendingQueue, null); assert.equal(f.wire.filter(row => row.text === 'newer input').length, 1);
  assert.ok(!JSON.stringify(f.wire).includes('obsolete delayed input'));
});
test('retained shared waiting input preserves the running public reply until its native boundary', async t => {
  const f = await queueRouter(t), sharing = f.bridge.sharedReplies, oldTag = crypto.randomUUID(), oldPrompt = crypto.randomUUID();
  sharing.authorize(f.record, f.r, oldTag, { id: oldTag }, f.router.legacyShareAuthority(f.router.entries[0], f.record));
  f.event({ id: `prompt:${oldPrompt}`, kind: 'input', text: 'original shared task', inputTag: oldTag, turnId: 'old-public', promptId: oldPrompt });
  sharing.receipt(oldTag, { turnId: 'old-public', promptId: oldPrompt });
  let index = 0;
  const output = extra => f.event({ id: 'display:old-public', turnId: 'old-public', promptId: oldPrompt, index: index++, status: 'streaming', ...extra });
  output({ delta: 'Original public prefix. ' });
  const old = sharing.snapshot().find(m => m.role === 'assistant'); assert.ok(old);
  const done = f.router.call('queueShared', f.record.id, 'next public task', f.record.nativeId);
  done.catch(() => {}); // Cleanup may close a still-waiting native request after a failed assertion.
  await settle(); const nextTag = f.r.pendingQueue; assert.ok(nextTag);
  assert.equal(f.r.submission.authorize({ id: nextTag, text: 'next public task' }), true);
  assert.equal(sharing.valid(sharing.grants.get(oldTag)), true);
  output({ delta: 'Still working while input waits.' });
  assert.match(old.text, /Still working while input waits/); assert.equal(old.status, 'streaming');
  output({ status: 'complete' });
  f.event({ id: 'turn:old-public', kind: 'turn', turnId: 'old-public', promptId: oldPrompt, finalDisplayId: 'display:old-public', text: 'native end' });
  assert.equal(old.finalReply, true); assert.equal(old.sharingStopped, undefined);
  const nextPrompt = crypto.randomUUID();
  f.event({ id: `prompt:${nextPrompt}`, kind: 'input', text: 'next public task', inputTag: nextTag, turnId: 'next-public', promptId: nextPrompt });
  f.r.submission.result({ id: nextTag, status: 'accepted', turnId: 'next-public', promptId: nextPrompt }); await done;
  f.event({ id: 'display:next-public', turnId: 'next-public', promptId: nextPrompt, delta: 'Next public reply.' });
  const next = sharing.snapshot().find(m => m.text === 'Next public reply.');
  assert.equal(next.replyTo, nextTag); assert.equal(old.replyTo, oldTag); assert.equal(f.record.liveDraft, 'PRIVATE DRAFT');
});
for (const order of ['input-first', 'ack-first']) test(`retained shared queue uses original native waiting path; ${order}; old work and drafts stay private`, async t => {
  const f = await queueRouter(t), text = 'queued room instruction';
  const done = f.router.call('queueShared', f.record.id, text, f.record.nativeId);
  await settle(); const tag = f.r.pendingQueue; assert.ok(tag);
  assert.equal(f.router.snapshot().sessions[0].legacySharedQueue, true);
  assert.equal(f.r.submission.authorize({ id: tag, text }), true);
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(f.wire.filter(row => row.id === tag).length, 1);
  assert.equal(f.r.pendingQueue, tag);
  assert.equal(f.bridge.sharedMessages().find(m => m.id === tag).status, 'awaiting-native');
  assert.equal(f.bridge.sharedMessages().find(m => m.id === tag).deliveries[0].status, 'awaiting-native');
  f.event({ delta: 'PRIVATE OLD WORK' }); f.event({ id: 'turn:private-turn', kind: 'turn', text: 'old work finished', finalDisplayId: 'display:private' });
  assert.equal(f.bridge.sharedMessages().filter(m => m.role === 'assistant').length, 0);
  const promptId = crypto.randomUUID();
  const input = () => f.event({ id: `prompt:${promptId}`, kind: 'input', text, inputTag: tag, turnId: 'queued-turn', promptId, status: 'complete' });
  const ack = () => f.r.submission.result({ id: tag, status: 'accepted', turnId: 'queued-turn', promptId });
  if (order === 'input-first') input();
  ack(); assert.equal(await done, tag);
  if (order === 'ack-first') input();
  f.event({ id: 'display:queue', turnId: 'queued-turn', promptId, delta: 'ROOM REPLY', status: 'complete' });
  f.event({ id: 'turn:queued-turn', kind: 'turn', turnId: 'queued-turn', promptId, text: 'native ended', finalDisplayId: 'display:queue' });
  const messages = f.bridge.sharedMessages(), finals = messages.filter(m => m.finalReply);
  assert.equal(finals.length, 1); assert.equal(finals[0].text, 'ROOM REPLY'); assert.equal(finals[0].replyTo, tag);
  assert.equal(messages.find(m => m.id === tag).status, 'submitted');
  assert.equal(f.record.liveDraft, 'PRIVATE DRAFT'); assert.ok(!JSON.stringify(messages).includes('PRIVATE'));
  assert.equal(f.r.record.messages.filter(m => m.text === text).length, 1);
});
for (const boundary of ['owner', 'member', 'native', 'permission', 'manual', 'clear', 'close']) test(`retained shared queued ${boundary} cannot publish a late accepted reply`, async t => {
  const f = await queueRouter(t), text = 'queued room instruction';
  const done = f.router.call('queueShared', f.record.id, text, f.record.nativeId);
  const result = done.catch(error => error); await settle(); const tag = f.r.pendingQueue;
  assert.equal(f.r.submission.authorize({ id: tag, text }), true);
  if (boundary === 'owner') f.record.owner = 'other';
  if (boundary === 'member') { f.record.roomId = null; f.record.memberRevision++; }
  if (boundary === 'native') f.record.nativeId = crypto.randomUUID();
  if (boundary === 'permission') f.event({ id: 'control:permission', kind: 'control' });
  if (boundary === 'manual') await f.router.intervene(async () => {}, f.record.id);
  if (boundary === 'clear') f.bridge.clearSharedHistory([tag]);
  if (boundary === 'close') f.r.submission.close();
  await f.router.refresh();
  const promptId = crypto.randomUUID();
  f.event({ id: `prompt:${promptId}`, kind: 'input', text, inputTag: tag, turnId: 'queued-turn', promptId });
  f.r.submission.result({ id: tag, status: 'accepted', turnId: 'queued-turn', promptId }); await result;
  f.event({ id: 'display:private-later', turnId: 'queued-turn', promptId, delta: 'PRIVATE LATER' });
  assert.equal(f.bridge.sharedMessages().filter(m => m.role === 'assistant').length, 0);
  assert.equal(f.wire.filter(row => row.id === tag).length, 1);
  assert.equal(f.record.liveDraft, 'PRIVATE DRAFT');
  if (boundary === 'close') assert.equal(f.bridge.sharedMessages().find(m => m.id === tag).status, 'submitted');
});

test('fresh native queue input repairs a reopened receipt without reviving reply authority', async t => {
  const f = await queueRouter(t), tag = crypto.randomUUID(), promptId = crypto.randomUUID();
  const row = { id: tag, sessionId: f.record.id, nativeId: f.record.nativeId, shared: true, sharedReply: true, inputMode: 'queue', text: 'accepted while closed', status: 'unconfirmed' };
  f.bridge.records.push(row); f.bridge.save();
  assert.equal(f.bridge.sharedReplies.grants.size, 0);
  f.event({ id: `prompt:${promptId}`, kind: 'input', text: row.text, inputTag: tag, promptId: undefined, turnId: 'offline-turn' });
  f.event({ id: 'display:offline', promptId, turnId: 'offline-turn', delta: 'PRIVATE OFFLINE REPLY' });
  assert.equal(f.bridge.sharedMessages().find(m => m.id === tag).status, 'submitted');
  assert.equal(f.bridge.sharedMessages().find(m => m.id === tag).manualReply, true);
  assert.equal(JSON.parse(fs.readFileSync(f.bridge.filename))[0].status, 'accepted');
  assert.equal(f.bridge.sharedReplies.grants.size, 0);
  assert.equal(f.bridge.sharedMessages().filter(m => m.role === 'assistant').length, 0);
  assert.equal(f.wire.length, 0);
});

for (const mismatch of ['tag', 'text', 'session', 'native', 'kind', 'status', 'incomplete', 'prompt', 'cleared', 'retired']) test(`native receipt reconciliation rejects ${mismatch}`, async t => {
  const f = await queueRouter(t), tag = crypto.randomUUID(), promptId = crypto.randomUUID();
  const row = { id: tag, sessionId: f.record.id, nativeId: f.record.nativeId, shared: true, inputMode: 'queue', text: 'exact input', status: 'unconfirmed' };
  f.bridge.records.push(row);
  const message = { id: `native:${f.record.nativeId}:prompt:${promptId}`, nativeId: f.record.nativeId, nativeBlock: true,
    kind: 'input', role: 'user', status: 'complete', text: row.text, inputTag: tag, promptId };
  if (mismatch === 'tag') message.inputTag = crypto.randomUUID();
  if (mismatch === 'text') message.text += ' changed';
  if (mismatch === 'session') row.sessionId = 'another-session';
  if (mismatch === 'native') message.nativeId = crypto.randomUUID();
  if (mismatch === 'kind') message.kind = 'response';
  if (mismatch === 'status') message.status = 'awaiting-native';
  if (mismatch === 'incomplete') message.incomplete = true;
  if (mismatch === 'prompt') message.id = `native:${f.record.nativeId}:prompt:not-a-native-uuid`;
  if (mismatch === 'cleared') f.bridge.clearSharedHistory([tag]);
  if (mismatch === 'retired') f.bridge.targets.delete(f.record.id);
  f.bridge.observeReader(f.r, message);
  assert.equal(f.bridge.records[0].status, 'unconfirmed');
  assert.equal(f.bridge.sharedReplies.grants.size, 0);
});

test('receipt save failure preserves uncertainty and blocks further dispatch', async t => {
  const f = await queueRouter(t), tag = crypto.randomUUID(), promptId = crypto.randomUUID();
  const row = { id: tag, sessionId: f.record.id, nativeId: f.record.nativeId, shared: true, inputMode: 'queue', text: 'exact input', status: 'unconfirmed' };
  f.bridge.records.push(row); const save = f.bridge.save; f.bridge.save = () => { throw Error('Disk unavailable'); };
  f.event({ id: `prompt:${promptId}`, kind: 'input', text: row.text, inputTag: tag, promptId });
  assert.equal(row.status, 'unconfirmed'); assert.equal(f.bridge.storageError, true);
  assert.match(f.bridge.storageWarning, /没有重发/); assert.equal(f.wire.length, 0);
  f.bridge.save = save;
  await assert.rejects(f.bridge.send(f.record, 'another task', async () => {}, () => true), /无法读取/);
  assert.equal(f.wire.length, 0);
});


test('retained native interruption blocks plugin sends until a fresh native start, including after reopen', async t => {
  const f = await queueRouter(t);
  f.event({ id: 'control:turn-start', kind: 'control', turnId: 'A', status: 'running' });
  f.event({ id: 'turn:A', kind: 'turn', turnId: 'A', status: 'interrupted' });
  assert.equal(f.router.snapshot().sessions[0].state, 'idle');
  assert.equal(f.router.snapshot().sessions[0].nativeInputRequired, true);
  for (const method of ['send', 'forward', 'queue', 'queueShared']) await assert.rejects(f.router.call(method, f.record.id, 'must stay in draft', f.record.nativeId));
  assert.equal(f.wire.length, 0); assert.equal(f.record.liveDraft, 'PRIVATE DRAFT');
  f.r.submission.status(false);
  assert.equal(f.router.snapshot().sessions[0].nativeInputRequired, true, 'Saved native pause remains visible while reconnecting');
  assert.equal(f.router.snapshot().sessions[0].chatAvailable, false);
  f.r.submission.status(true);
  f.r.save(); const restored = f.create(); assert.equal(restored.nativeInputRequired, true);
  f.event({ id: 'control:turn-start', kind: 'control', turnId: 'A', status: 'running' });
  assert.equal(f.r.nativeInputRequired, true, 'Duplicate start never removes the native pause');
  f.event({ id: 'control:turn-start', kind: 'control', turnId: 'B', status: 'running', replayed: true });
  assert.equal(f.r.nativeInputRequired, true, 'Replayed start cannot reopen input');
  f.event({ id: 'control:turn-start', kind: 'control', turnId: 'C', status: 'running' });
  assert.equal(f.r.nativeInputRequired, false);
  f.event({ id: 'turn:A', kind: 'turn', turnId: 'A', status: 'interrupted' });
  assert.equal(f.r.nativeInputRequired, false, 'Old interruption cannot pause newer work');
});


test('retained model projection uses current native metadata rather than old host startup or cache', async t => {
  const f = await queueRouter(t);
  assert.equal(f.router.snapshot().sessions[0].model, '原生未报告');
  const before = f.r.record.messages.length;
  f.event({ id: 'control:model', kind: 'control', model: 'claude-native-selected' });
  assert.equal(f.router.snapshot().sessions[0].model, 'claude-native-selected');
  assert.equal(f.r.record.messages.length, before);
  f.r.save(); const reopened = f.create();
  assert.equal(reopened.model, undefined, 'Saved history is not proof of a live model selection');
});


test('native tool input, result and identity survive private reader reopening with uncertain running state', async t => {
  const f = fixture(t), b = await bind(f);
  block(f, b, 1, { id: 'tool:done', kind: 'tool', input: '{"path":"synthetic.txt"}', text: 'saved result', delta: undefined, index: undefined, status: 'complete' });
  block(f, b, 2, { id: 'tool:working', kind: 'tool', input: '{"command":"synthetic"}', text: 'partial result', delta: undefined, index: undefined, status: 'running' });
  f.r.close(); const restored = f.create();
  const done = restored.record.messages.find(m => m.id.endsWith('tool:done'));
  assert.equal(done.text, 'saved result'); assert.equal(done.input, '{"path":"synthetic.txt"}'); assert.equal(done.status, 'complete');
  assert.equal(restored.record.messages.find(m => m.id.endsWith('tool:working')).status, 'unconfirmed');
  assert.equal(restored.rootLease, undefined); assert.equal(restored.queueAvailable, false);
  assert.equal(fs.statSync(restored.filename).mode & 0o777, 0o600);
});
