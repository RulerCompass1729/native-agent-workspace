const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { randomUUID } = require('node:crypto');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
const { Codex } = require(path.join(root, 'app/adapters.cjs'));
const { RoomState } = require(path.join(root, 'app/room-state.cjs'));
const { ButlerIngress, bindQueueOutcomes } = require(path.join(root, 'app/butler-ingress.cjs'));
const rules = require(path.join(root, 'app/queue-dispatch.cjs'));
const { codexQuotaBlock } = require(path.join(root, 'app/native-usage.js'));
const { queuePurposeValid } = require(path.join(root, 'app/submission-policy.cjs'));
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-d-a3-rotation-')), calls = [];
  const host = { binaries: {}, codexTargets: new Map(), close() {}, rpc: { call: async method => {
    calls.push(method); throw Error('This observation-only test must not submit native input');
  } } };
  const w = new Workspace(host, dir), nativeId = randomUUID(), tag = randomUUID(), epoch = randomUUID(), now = Date.now();
  const s = { id: 'member-a', nativeId, provider: 'codex', model: 'synthetic-model', view: 'chat', cwd: dir,
    owner: 'synthetic-window', state: 'idle', createdAt: now - 60000, roomId: 'shared', roomIds: ['shared'],
    controlRevision: 0, memberRevision: 0, fleet: [], background: 0, scheduled: 0,
    serviceCapabilities: [rules.CAPABILITY, rules.ROTATION_CAPABILITY],
    rotationEpisode: { nativeId, epoch, state: 'open', tag, itemId: 'rotation:member-a' },
    messages: [{ id: tag, role: 'user', text: 'Synthetic historical handoff', time: now - 1000, nativeId,
      origin: 'naw-dispatch', status: 'submitted', dispatchItem: 'rotation:member-a',
      dispatchPurpose: { kind: 'rotation-request', nativeId, itemId: 'rotation:member-a', epoch } }] };
  const runtime = new Codex(s, host); runtime.chatAvailable = true;
  w.sessions.set(s.id, s); w.runtimes.set(s.id, runtime); w.bind(s, runtime);
  const room = new RoomState(dir), ingress = new ButlerIngress(dir, { roomState: room });
  let personNotices = 0; bindQueueOutcomes(room, ingress, () => personNotices++);
  const client = { snapshot: () => w.snapshot(), refresh: async () => w.snapshot(),
    route: () => ({ client, state: { capabilities: s.serviceCapabilities } }) };
  const dispatcher = new rules.QueueDispatcher({ dataDir: dir, roomState: room, clients: () => client, settleMs: 0 });
  dispatcher.client = client; dispatcher.closed = false; dispatcher.broadcast = async () => {};
  t.after(async () => { dispatcher.close(); await w.close(); assert.equal(calls.length, 0); fs.rmSync(dir, { recursive: true, force: true }); });
  const notify = (method, params) => runtime.event({ method, params: { threadId: s.nativeId, ...params } }, host.rpc);
  // Seed past delivery records; no queue dispatch or native send is performed.
  const delivered = label => {
    const id = room.queueAdd('Synthetic ' + label, null);
    room.queueMarkSent('shared', id, s.id, 'Synthetic member', now - 500, false, nativeId);
    room.queueSetDelivery('shared', id, randomUUID(), 0); return id;
  };
  const first = delivered('first task'), second = delivered('second task');
  const record = { phase: 'requested', episodeEpoch: epoch, episodeState: 'open', requestedAt: now - 1000,
    tag, oldId: s.id, oldNativeId: nativeId, oldControl: 0, provider: 'codex', cwd: dir, name: 'Synthetic member', roomIds: ['shared'], view: 'chat' };
  dispatcher.rotations[s.id] = record;
  const settle = (itemId, planned) => dispatcher.settle({ roomId: 'shared', itemId, sessionId: s.id,
    status: 'waiting', reason: 'no-reply', reply: '' }, { sessions: [planned] });
  const events = () => ingress.ledger.snapshot().events;
  return { dir, w, s, runtime, room, ingress, dispatcher, notify, record, nativeId, tag, epoch,
    first, second, settle, events, calls, personNotices: () => personNotices };
}
for (const transition of ['quota-cleared', 'context-switch']) test('A3/B1/B2: no-reply uses current quota after ' + transition, async t => {
  const f = fixture(t), { s, runtime } = f;
  runtime.pending = { tag: f.tag, turnId: 'old-quota-turn' };
  f.notify('turn/started', { turn: { id: 'old-quota-turn' } });
  f.notify('turn/completed', { turn: { id: 'old-quota-turn', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' } } });
  assert.equal(s.rotationEpisode.state, 'waiting-provider'); assert.ok(codexQuotaBlock(s));
  await f.dispatcher.advanceRotations(f.w.snapshot(), Date.now()); assert.equal(f.record.phase, 'waiting-provider');
  f.ingress.observeRecoveryFailures([s]); const quotaEvent = f.events()[0];
  assert.equal(quotaEvent.payload.reason, 'codex-usage-limit-exceeded');
  f.settle(f.first, structuredClone(s)); f.ingress.observeRecoveryFailures([s]);
  assert.equal(f.events().length, 1); assert.equal(f.events()[0].eventId, quotaEvent.eventId);
  const planned = structuredClone(s);
  if (transition === 'quota-cleared') {
    f.notify('turn/started', { turn: { id: 'observed-recovery-turn' } });
    f.notify('turn/completed', { turn: { id: 'observed-recovery-turn', status: 'completed' } });
    assert.equal(s.nativeQuota, undefined); assert.equal(s.rotationEpisode.state, 'waiting-provider');
    assert.ok(s.rotationEpisode.providerBlock);
    assert.equal(rules.sessionReady(f.w.snapshot().sessions[0], { enabled: true }).reason, 'waiting-provider');
  } else {
    const next = randomUUID(), key = 'synthetic-context-switch', rpc = runtime.host.rpc;
    runtime.observeTerminalContext({ kind: 'request', method: 'thread/start', key, rpc });
    runtime.observeTerminalContext({ kind: 'response', method: 'thread/start', key, rpc,
      result: { model: s.model, thread: { id: next, cwd: f.dir, status: { type: 'idle' }, turns: [] } } });
    await runtime.observing; assert.equal(s.nativeId, next); assert.equal(s.nativeContextPending, null);
    assert.equal(s.rotationEpisode.state, 'released'); assert.equal(s.rotationEpisode.disposition.action, 'context-switch');
    assert.equal(s.rotationEpisode.disposition.outcome, 'failed'); assert.equal(s.messages.find(m => m.id === f.tag).status, 'failed');
    await f.dispatcher.advanceRotations(f.w.snapshot(), Date.now()); assert.equal(f.dispatcher.rotations[s.id], undefined);
  }
  assert.equal(codexQuotaBlock(s), null);
  f.settle(f.second, planned);
  assert.equal(f.events().length, 2, 'A cleared or previous-native quota cannot hide a new no-reply');
  assert.deepEqual(f.events()[1].payload, { memberId: s.id, itemId: f.second, reason: 'no-reply-unconfirmed' });
  const sources = f.room.butlerSources();
  assert.equal(sources.filter(e => e.eventId === quotaEvent.eventId).length, 1, 'The first outcome binds the original quota once');
  const bytes = fs.readFileSync(f.ingress.ledger.file);
  const restored = new ButlerIngress(f.dir, { roomState: new RoomState(f.dir) });
  restored.recover(); restored.recover(); restored.observeRecoveryFailures([s]);
  assert.deepEqual(fs.readFileSync(restored.ledger.file), bytes, 'Old frozen facts recover without replay or changed causes');
  assert.equal(f.room.queueFind('shared', f.second).sentNative, f.nativeId); assert.equal(f.personNotices(), 0);
  if (transition === 'context-switch') {
    s.background = 0; s.scheduled = 0;
    const id = f.room.queueAdd('Synthetic current task', null), tag = randomUUID(), now = Date.now();
    f.room.queueMarkSent('shared', id, s.id, 'Synthetic member', now - 1000, false, s.nativeId);
    f.room.queueSetDelivery('shared', id, tag, s.controlRevision || 0);
    const input = { id: tag, role: 'user', text: 'Synthetic existing current input', time: now - 1000, nativeId: s.nativeId,
      origin: 'naw-dispatch', status: 'submitted', dispatchItem: id,
      dispatchPurpose: { kind: 'queue', nativeId: s.nativeId, itemId: id, epoch: null } };
    s.messages.push(input); assert.equal(queuePurposeValid(s, input, id, s.nativeId), true);
    runtime.emit('messageItem', { id: randomUUID(), nativeId: f.nativeId, text: 'Synthetic late old handoff', inputTag: f.tag });
    runtime.emit('complete', { tag: f.tag, text: 'Synthetic late old handoff', inputTag: f.tag });
    const plan = () => rules.planDispatch({ rooms: [{ ...f.room.metadata(), id: 'shared' }], sessions: f.w.snapshot().sessions,
      wakePolicy: { enabled: true }, idleSince: new Map([[s.id, now - 60000]]), settleMs: 0, now });
    assert.equal(plan().some(a => a.kind === 'settle' && a.itemId === id && a.status === 'done'), false);
    runtime.emit('messageItem', { id: randomUUID(), nativeId: s.nativeId, text: 'Synthetic current verified reply', inputTag: tag });
    runtime.emit('complete', { tag, text: 'Synthetic current verified reply', inputTag: tag });
    assert.equal(plan().some(a => a.kind === 'settle' && a.itemId === id && a.status === 'done'), true, 'Matching current input is a positive control');
    assert.equal(s.messages.find(m => m.id === f.tag).status, 'failed');
    f.notify('turn/started', { turn: { id: 'new-native-quota' } });
    f.notify('turn/completed', { turn: { id: 'new-native-quota', status: 'failed', error: { codex_error_info: 'usage_limit_exceeded' } } });
    assert.equal(codexQuotaBlock(s).nativeId, s.nativeId);
    assert.equal(rules.sessionReady(f.w.snapshot().sessions[0], { enabled: true }).reason, 'usage-limit-exceeded');
  }
  await assert.rejects(f.w.send(s.id, 'Must never reach native', s.owner, null, null, null, null, null, null, null, { itemId: 'blocked-input' }));
  assert.equal(f.calls.length, 0);
});
