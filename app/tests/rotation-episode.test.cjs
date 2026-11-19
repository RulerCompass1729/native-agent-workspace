const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events'), { randomUUID } = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Workspace } = require('../workspace.cjs'), { RoomState } = require('../room-state.cjs');
const rules = require('../queue-dispatch.cjs');
const NOW = 1_800_000_000_000, AWAKE = { enabled: true };
const control = epoch => ({ kind: 'rotation-request', epoch });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-rotation-episode-')), writes = [], calls = [];
  const host = { binaries: {}, close() {}, rpc: {} }, w = new Workspace(host, dir);
  const s = { id: 'member-a', nativeId: 'native-a', provider: 'codex', model: 'model-a', view: 'chat', cwd: dir, owner: 'window',
    state: 'idle', createdAt: NOW - 10000, messages: [], fleet: [], roomId: 'shared', roomIds: ['shared'], controlRevision: 0, memberRevision: 0,
    serviceCapabilities: [rules.CAPABILITY, 'rotationControlEpochV1'] };
  const runtime = new EventEmitter(); runtime.host = host; runtime.chatAvailable = true;
  runtime.send = async (text, tag, guard) => { if (!guard()) throw Object.assign(Error('not-sent'), { notSent: true }); writes.push({ text, tag }); runtime.emit('submitted', tag); };
  w.sessions.set(s.id, s); w.runtimes.set(s.id, runtime); w.bind(s, runtime); s.background = 0; s.scheduled = 0;
  const room = new RoomState(dir), client = { snapshot: () => w.snapshot(), refresh: async () => w.snapshot(),
    route: () => ({ client, state: { capabilities: [rules.CAPABILITY, 'rotationControlEpochV1'] } }),
    call: async (method, ...args) => { calls.push([method, ...args]);
      if (method === 'invalidateRotation') return w.invalidateRotation(...args);
      if (method === 'completeRotation') return w.completeRotation(...args);
      if (method === 'dispatch') return w.send(args[0], args[1], 'naw-dispatcher', null, null, null, null, null, null, null, { itemId: args[3], control: args[4] });
      throw Error('Unexpected control call: ' + method);
    } };
  const dispatcher = new rules.QueueDispatcher({ dataDir: dir, roomState: room, clients: () => client, now: () => NOW, settleMs: 0, tickMs: 3600000 });
  dispatcher.client = client; dispatcher.closed = false;
  t.after(() => { dispatcher.close(); w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const snapshot = () => w.snapshot().sessions[0];
  const send = async (itemId, purpose) => { const tag = await client.call('dispatch', s.id, 'Synthetic input', s.nativeId, itemId, purpose); s.pendingTag = null; s.state = 'idle'; return tag; };
  return { dir, w, s, runtime, writes, calls, room, client, dispatcher, snapshot, send };
}
function input(s, itemId, tag, epoch = null) { return { id: tag, role: 'user', origin: 'naw-dispatch', dispatchItem: itemId,
  dispatchPurpose: { kind: 'queue', nativeId: s.nativeId, itemId, epoch }, text: 'Synthetic task', status: 'submitted' }; }
function settle(s, tag = 'task-tag', itemId = 'task-a') {
  const item = { id: itemId, text: 'Synthetic task', assignee: null, status: 'sent', createdAt: NOW - 10000, sentAt: NOW - 2000, sentTo: s.id, sentNative: s.nativeId, tag, control: 0 };
  return rules.planDispatch({ rooms: [{ id: 'shared', name: 'Synthetic team', queue: [item] }], sessions: [s],
    wakePolicy: AWAKE, idleSince: new Map([[s.id, NOW - 60000]]), now: NOW }).find(a => a.kind === 'settle');
}
test('a persisted rotation request blocks public readiness and the backend before another queue item can enter', async t => {
  const f = fixture(t), epoch = randomUUID(); const tag = await f.send('rotation:' + f.s.id, control(epoch));
  assert.equal(f.s.rotationEpisode?.epoch, epoch); assert.equal(f.s.rotationEpisode.tag, tag);
  assert.deepEqual(rules.sessionReady(f.snapshot(), AWAKE), { ready: false, reason: 'rotation-control-unresolved' });
  await assert.rejects(f.send('task-b')); assert.equal(f.writes.length, 1);
  f.w.persist(); const restored = new Workspace({ binaries: {}, close() {} }, f.dir);
  try { assert.equal(rules.sessionReady(restored.snapshot().sessions[0], AWAKE).ready, false); }
  finally { restored.close(); }
});
test('failRotation invalidates the native control epoch durably, including an unknown send result', async t => {
  const f = fixture(t), epoch = randomUUID(); await f.send('rotation:' + f.s.id, control(epoch));
  const record = { phase: 'requested', episodeEpoch: epoch, requestedAt: NOW - 1000, oldId: f.s.id, oldNativeId: f.s.nativeId, oldControl: 0, provider: 'codex', cwd: f.dir, name: 'Synthetic', roomIds: ['shared'], tag: null };
  f.dispatcher.rotations[f.s.id] = record;
  await f.dispatcher.failRotation(f.s.id, record, 'handoff-request-unconfirmed', NOW, f.client.snapshot());
  assert.equal(record.episodeState, 'invalid'); assert.equal(f.s.rotationEpisode?.state, 'invalid');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'workspace.json'))).sessions[0].rotationEpisode.state, 'invalid');
  assert.equal(f.writes.length, 1, 'Invalidation cannot replay the unknown request');
  f.s.messages.push({ role: 'assistant', text: 'Synthetic late handoff' });
  assert.equal(rules.sessionReady(f.snapshot(), AWAKE).ready, false);
});
test('a late handoff even labelled with the new input tag cannot settle a new queue item as done', t => {
  const f = fixture(t), epoch = randomUUID();
  f.s.rotationEpisode = { nativeId: f.s.nativeId, epoch, state: 'invalid', tag: 'old-control' };
  f.s.messages = [input(f.s, 'task-a', 'task-tag'), { role: 'assistant', inputTag: 'task-tag', text: 'Synthetic handoff for the old purpose' }];
  const action = settle(f.snapshot()); assert.equal(action.status, 'waiting'); assert.equal(action.reason, 'rotation-control-unresolved');
  assert.equal(action.reply, undefined); assert.equal(action.ready, undefined);
});
test('epoch mismatch refuses stale queue receipts even when the current control was proven not sent', t => {
  const f = fixture(t); f.s.rotationEpisode = { nativeId: f.s.nativeId, epoch: 'new-epoch', state: 'not-sent' };
  f.s.messages = [input(f.s, 'task-a', 'task-tag', 'old-epoch'), { role: 'assistant', inputTag: 'task-tag', text: 'Synthetic stale receipt' }];
  assert.equal(settle(f.snapshot()).status, 'waiting');
});
test('a rotation-purpose row cannot stand in for the queue input and assistant tag mismatches cannot finish it', t => {
  const f = fixture(t); f.s.messages = [input(f.s, 'task-a', 'task-tag'), { role: 'assistant', inputTag: 'old-tag', text: 'Synthetic stale control reply' }];
  assert.notEqual(settle(f.snapshot()).status, 'done');
  f.s.messages[0].dispatchPurpose.kind = 'rotation-request'; f.s.messages[1].inputTag = 'task-tag';
  assert.notEqual(settle(f.snapshot()).status, 'done');
});
test('normal backend queue input and matching reply still settle done; quota remains an independent stop gate', async t => {
  const f = fixture(t); const tag = await f.send('task-a');
  f.s.messages.push({ role: 'assistant', inputTag: tag, text: 'Synthetic completed task' });
  const action = settle(f.snapshot(), tag); assert.equal(action.status, 'done'); assert.equal(action.reply, 'Synthetic completed task');
  f.s.nativeQuota = { nativeId: f.s.nativeId, turnId: 'quota-turn', kind: 'usage_limit_exceeded', model: f.s.model, observedAt: NOW };
  assert.equal(rules.sessionReady(f.snapshot(), AWAKE).reason, 'usage-limit-exceeded'); await assert.rejects(f.send('another-task'));
});
test('backend invalidation revokes an already prepared native send guard without touching another native context', async t => {
  const f = fixture(t), epoch = randomUUID(); let proceed, started;
  const ready = new Promise(resolve => { started = resolve; });
  f.runtime.send = async (text, tag, guard) => { started(); await new Promise(resolve => { proceed = resolve; });
    if (!guard()) throw Object.assign(Error('refused'), { notSent: true }); f.writes.push({ text, tag }); };
  const pending = f.send('rotation:' + f.s.id, control(epoch)); await ready;
  if (typeof f.w.invalidateRotation === 'function') f.w.invalidateRotation(f.s.id, f.s.nativeId, epoch);
  proceed(); await assert.rejects(pending); assert.equal(f.writes.length, 0);
  const saved = structuredClone(f.s.rotationEpisode); f.s.nativeId = 'replacement-native';
  assert.throws(() => f.w.invalidateRotation(f.s.id, 'native-a', epoch)); assert.deepEqual(f.s.rotationEpisode, saved);
});
test('all public planning, vacancy and fresh execution entry points see the same unresolved episode', async t => {
  const f = fixture(t); f.s.rotationEpisode = { nativeId: f.s.nativeId, epoch: randomUUID(), state: 'invalid', tag: 'control-tag' };
  const member = f.snapshot(), waits = new Map(), queued = { id: 'task-a', text: 'Synthetic task', assignee: null, status: 'queued', createdAt: NOW - 2000 };
  const args = { rooms: [{ id: 'shared', name: 'Synthetic team', queue: [queued] }], sessions: [member], wakePolicy: AWAKE,
    idleSince: new Map([[member.id, NOW - 60000]]), vacancySince: new Map([[member.id, NOW - 60000]]), now: NOW, settleMs: 0, waits };
  assert.equal(rules.planDispatch(args).some(a => ['dispatch','rotate'].includes(a.kind)), false);
  assert.equal(waits.get('task-a')?.[0]?.reason, 'rotation-control-unresolved');
  const other = { ...member, id: 'member-b', nativeId: 'native-b', rotationEpisode: undefined, messages: [] };
  assert.deepEqual(rules.planDispatch({ ...args, sessions: [member, other], idleSince: new Map([[member.id, NOW-60000], [other.id, NOW-60000]]) }).filter(a => a.kind === 'dispatch').map(a => a.sessionId), ['member-b']);
  const vacancies = rules.queueVacancies({ ...args, rooms: [{ id: 'shared', name: 'Synthetic team', queue: [] }] });
  assert.equal(vacancies[0].active, false); assert.deepEqual(vacancies[0].availableIds, []); assert.deepEqual(vacancies[0].candidateIds, []);
  const why = {}; assert.equal(await f.dispatcher.freshReady(member.id, 0, why), null); assert.equal(why.reason, 'rotation-control-unresolved');
  f.dispatcher.view(); f.dispatcher.observeVacancyReadiness(f.client.snapshot(), NOW); assert.equal(f.dispatcher.vacancySince.has(member.id), false);
});

test('only a consumed matching control can be completed, and its revoked epoch cannot be reused', async t => {
  const f = fixture(t), epoch = randomUUID(); const tag = await f.send('rotation:' + f.s.id, control(epoch));
  assert.throws(() => f.w.completeRotation(f.s.id, f.s.nativeId, epoch, 'wrong-tag'));
  f.runtime.emit('complete', { tag, text: 'Synthetic consumed handoff' });
  f.w.completeRotation(f.s.id, f.s.nativeId, epoch, tag);
  assert.equal(f.s.rotationEpisode.state, 'complete');
  f.w.invalidateRotation(f.s.id, f.s.nativeId, epoch); assert.equal(f.s.rotationEpisode.state, 'complete');
  await assert.rejects(f.send('rotation:' + f.s.id, control(epoch)));
  await f.send('task-after-disposition'); assert.equal(f.writes.length, 2);
});
test('a proven unsent control permits a new epoch, while a lost ACK leaves the member held without replay', async t => {
  for (const proven of [true, false]) {
    const f = fixture(t), epoch = randomUUID();
    f.runtime.send = async () => { throw Object.assign(Error('Synthetic refused or unknown receipt'), proven ? { notSent: true } : {}); };
    await assert.rejects(f.send('rotation:' + f.s.id, control(epoch)));
    assert.equal(f.s.rotationEpisode.state, proven ? 'not-sent' : 'open');
    if (!proven) { await assert.rejects(f.send('next-task')); assert.equal(f.writes.length, 0); }
  }
});
test('a stored request tag without a verified native completion cannot resolve a control purpose', async t => {
  const f = fixture(t), epoch = randomUUID(); const tag = await f.send('rotation:' + f.s.id, control(epoch));
  assert.throws(() => f.w.completeRotation(f.s.id, f.s.nativeId, epoch, tag));
  f.runtime.emit('complete', { tag: 'unrelated', text: 'Synthetic other completion' });
  assert.throws(() => f.w.completeRotation(f.s.id, f.s.nativeId, epoch, tag));
});

test('native history preserves a correlated queue input purpose instead of guessing by timestamp', async t => {
  const f = fixture(t), tag = await f.send('task-a');
  const { applyCodexHistory } = require('../native-blocks.cjs');
  applyCodexHistory(f.s, [{ type: 'userMessage', id: 'native-user-id', clientId: tag, turnId: 'turn-a', content: [{ type: 'text', text: 'Synthetic input' }] },
    { type: 'agentMessage', id: 'native-answer', turnId: 'turn-a', text: 'Synthetic task result' }], f.runtime);
  assert.equal(f.s.messages.find(m => m.id === tag).dispatchPurpose.itemId, 'task-a');
  assert.equal(settle(f.snapshot(), tag).status, 'done');
});
test('a native-idle clock for the coordinator does not turn its own open request into dispatch readiness', async t => {
  const f = fixture(t), epoch = randomUUID(); await f.send('rotation:' + f.s.id, control(epoch));
  f.dispatcher.rotations[f.s.id] = { phase: 'requested', episodeEpoch: epoch };
  f.dispatcher.view(); assert.equal(f.dispatcher.idleSince.has(f.s.id), true);
  assert.equal(rules.sessionReady(f.snapshot(), AWAKE).ready, false);
  f.w.invalidateRotation(f.s.id, f.s.nativeId, epoch); f.dispatcher.view();
  assert.equal(f.dispatcher.idleSince.has(f.s.id), false); assert.equal(f.writes.length, 1);
});
test('an unqualified retained backend cannot receive a new rotation control request', async t => {
  const f = fixture(t); f.client.route = () => ({ client: f.client, state: { capabilities: [rules.CAPABILITY] } });
  f.dispatcher.rotations[f.s.id] = { phase: 'requested', oldNativeId: f.s.nativeId, episodeEpoch: randomUUID() };
  await assert.rejects(f.dispatcher.send(f.snapshot(), 'Synthetic handoff control', 'rotation:' + f.s.id), e => e.notSent === true);
  assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0);
});
test('the created successor branch cannot hand work to a member with an unresolved control', async t => {
  const f = fixture(t), snapshot = f.client.snapshot();
  const successor = { ...f.snapshot(), id: 'successor', nativeId: 'native-successor', rotationEpisode: { nativeId: 'native-successor', epoch: randomUUID(), state: 'invalid' } };
  snapshot.sessions.push(successor);
  const record = { phase: 'created', newId: successor.id, oldNativeId: f.s.nativeId, createdNewAt: NOW, provider: 'codex', view: 'chat', oldControl: 0 };
  await f.dispatcher.advanceRotation(f.s.id, record, snapshot, NOW); assert.equal(f.calls.length, 0); assert.equal(record.phase, 'created');
});
