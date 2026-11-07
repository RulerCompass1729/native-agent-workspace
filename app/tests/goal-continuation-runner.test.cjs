const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { Workspace } = require('../workspace.cjs');
const { REQUIREMENTS } = require('../goal-continuation.cjs');
const turn = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-continuation-'));
  let runtime, writes = 0;
  const host = { binaries: {}, close() {}, create(s) {
    runtime = new EventEmitter(); s.nativeId = 'original-native';
    runtime.start = async () => runtime.emit('state', 'idle');
    runtime.chatAvailable = true;
    return runtime;
  } };
  const w = new Workspace(host, dir);
  t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const id = await w.create('codex', dir, 'human-owner', 'Original');
  w.join(id, true);
  const record = w.get(id);
  const native = { known: true, nativeId: record.nativeId, state: 'idle', controlRevision: 0,
    approvalPending: false, inputPending: false, waitingOnUser: false, usageLimited: false, budgetLimited: false,
    settings: { model: 'fixture-model', effort: 'high' },
    goal: { threadId: record.nativeId, createdAt: 10, updatedAt: 20, status: 'blocked',
      objective: 'Original synthetic task', tokenBudget: null, tokensUsed: 42, timeUsedSeconds: 3 } };
  runtime.goalContinuationObserve = async () => structuredClone(native);
  runtime.goalContinuationCapabilities = [...REQUIREMENTS];
  runtime.goalContinuationResume = async (intent, { valid }) => {
    assert.equal(valid(), true);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json')));
    assert.equal(saved.goalContinuation.policy.waits.wait.status, 'attempting');
    assert.ok(saved.room.messages.some(m => m.goalContinuation?.id === intent.id && m.goalContinuation.status === 'attempting'));
    writes++; native.goal.status = 'active'; native.goal.updatedAt++;
    return { status: 'confirmed' };
  };
  const authorization = { id: 'human-grant', version: 1, scopeId: 'shared',
    source: 'human', status: 'granted', capability: 'dependency-goal-continuation' };
  assert.equal(w.configureGoalContinuation(authorization).status, 'enabled');
  const wait = { id: 'wait', scopeId: 'shared', reason: 'agent-handoff', source: 'agent',
    taskId: 'original-task', triggers: [{ kind: 'dependency-completed', subjectId: 'dependency' }] };
  const event = { id: 'accepted-change', source: 'task-board', confirmed: true, scopeId: 'shared',
    kind: 'dependency-completed', subjectId: 'dependency' };
  const register = () => w.registerGoalContinuationWait(id, wait);
  return { w, dir, id, record, runtime, native, wait, event, register, writes: () => writes };
}

test('actual Workspace lifecycle persists scoped intent before one conditional native port call', async t => {
  const f = await fixture(t); assert.equal((await f.register()).status, 'waiting');
  const before = { native: f.record.nativeId, owner: f.record.owner, goal: structuredClone(f.native.goal) };
  assert.equal((await f.w.goalContinuationEvent(f.event))[0].status, 'confirmed');
  await f.w.goalContinuationEvent(f.event); await f.w.goalContinuation.boundary(f.id);
  assert.equal(f.writes(), 1);
  assert.equal(f.record.nativeId, before.native); assert.equal(f.record.owner, before.owner);
  for (const key of ['objective', 'createdAt', 'tokenBudget', 'tokensUsed', 'timeUsedSeconds']) {
    assert.equal(f.native.goal[key], before.goal[key]);
  }
  assert.deepEqual(f.w.room.messages.filter(m => m.goalContinuation).map(m => m.goalContinuation.status),
    ['waiting', 'attempting', 'confirmed']);
  assert.ok(!JSON.stringify(f.w.goalContinuation.data).includes(f.native.goal.objective));
});

test('busy handoff event drains on the real native idle event, with no clock or repeated prompt', async t => {
  const f = await fixture(t); await f.register();
  f.runtime.emit('state', 'working');
  assert.equal((await f.w.goalContinuationEvent(f.event))[0].status, 'deferred');
  assert.equal(f.writes(), 0);
  f.runtime.emit('state', 'idle'); await turn(); await turn();
  assert.equal(f.writes(), 1);
});

for (const [name, change] of [
  ['manual pause', f => { f.native.goal.status = 'paused'; }],
  ['budget limit', f => { f.native.goal.status = 'budgetLimited'; }],
  ['approval', f => { f.record.approval = { id: 'approval' }; }],
  ['private draft', f => { f.w.setDraft(f.id, 'DO NOT LOSE', 'human-owner'); }],
  ['human control revision', f => { f.record.controlRevision++; }],
  ['membership', f => { f.w.join(f.id, false); }],
  ['goal replacement', f => { f.native.goal.objective = 'Replacement'; }],
  ['human revocation', f => { f.w.configureGoalContinuation(null); }],
]) test(name + ' prevents native writes', async t => {
  const f = await fixture(t); await f.register(); change(f);
  await f.w.goalContinuationEvent(f.event); assert.equal(f.writes(), 0);
  if (name === 'private draft') assert.equal(f.w.drafts.get(f.id), 'DO NOT LOSE');
});

test('missing native capability does not consume an unsent handoff; the ready port receives it once', async t => {
  const f = await fixture(t); await f.register(); f.runtime.goalContinuationCapabilities = [];
  const result = (await f.w.goalContinuationEvent(f.event))[0];
  assert.equal(result.status, 'denied'); assert.equal(result.reason, 'conditional-native-resume-unavailable');
  assert.equal(f.writes(), 0);
  assert.equal(f.w.goalContinuation.data.policy.waits.wait.status, 'waiting');
  assert.equal(f.w.goalContinuation.data.pending.wait.id, f.event.id);
  assert.equal(f.w.room.messages.some(row => row.goalContinuation?.status === 'attempting'), false);
  await f.w.goalContinuationEvent(f.event);
  assert.equal(f.w.room.messages.filter(row => row.goalContinuation?.reason === 'conditional-native-resume-unavailable').length, 1);
  f.runtime.goalContinuationCapabilities = [...REQUIREMENTS];
  f.runtime.emit('goalContinuationReady');
  await turn(); await turn();
  assert.equal(f.writes(), 1);
  await f.w.goalContinuationEvent(f.event);
  assert.equal(f.writes(), 1);
});

test('uncertain native operation is terminal and is not replayed on service reconstruction', async t => {
  const f = await fixture(t); await f.register(); let attempts = 0;
  f.runtime.goalContinuationResume = async () => { attempts++; throw Error('Disconnected after write'); };
  assert.equal((await f.w.goalContinuationEvent(f.event))[0].status, 'unconfirmed');
  f.w.persist();
  const restored = new Workspace({ binaries: {}, close() {} }, f.dir);
  try {
    assert.equal(restored.goalContinuation.data.policy.waits.wait.status, 'unconfirmed');
    await restored.goalContinuationEvent(f.event); assert.equal(attempts, 1);
  } finally { restored.close(); }
});

test('a failed persistence before write cannot dispatch or retry', async t => {
  const f = await fixture(t); await f.register();
  const persist = f.w.persist; let saves = 0;
  f.w.persist = function () { if (++saves === 2) return false; return persist.call(this); };
  await assert.rejects(f.w.goalContinuationEvent(f.event), /not-saved/);
  assert.equal(f.writes(), 0); assert.equal(f.w.goalContinuation.data.policy.waits.wait.status, 'attempting');
  f.w.persist = persist;
});

test('fresh result is independently read; a positive port ACK cannot invent an active original goal', async t => {
  const f = await fixture(t); await f.register();
  f.runtime.goalContinuationResume = async () => ({ status: 'confirmed' });
  const result = (await f.w.goalContinuationEvent(f.event))[0];
  assert.equal(result.status, 'unconfirmed');
  assert.equal(f.w.goalContinuation.data.policy.waits.wait.status, 'unconfirmed');
});

test('caller snapshots and unrelated/mtime events never arm a write', async t => {
  const f = await fixture(t);
  assert.equal((await f.w.registerGoalContinuationWait(f.id, { ...f.wait, blockedSnapshot: f.native })).status, 'denied');
  await f.register();
  assert.equal((await f.w.goalContinuationEvent({ ...f.event, source: 'mtime' })).status, 'denied');
  assert.deepEqual(await f.w.goalContinuationEvent({ ...f.event, subjectId: 'other-task' }), []);
  assert.equal(f.writes(), 0);
});

test('revocation during native metadata read is checked again before the port write', async t => {
  const f = await fixture(t); await f.register();
  f.runtime.goalContinuationObserve = async () => {
    f.w.configureGoalContinuation(null); return structuredClone(f.native);
  };
  await f.w.goalContinuationEvent(f.event); assert.equal(f.writes(), 0);
});

test('a corrupt journal is retained and blocks automatic continuation without blocking ordinary saves', async t => {
  const f = await fixture(t); f.w.persist();
  const file = path.join(f.dir, 'workspace.json'), stored = JSON.parse(fs.readFileSync(file));
  stored.goalContinuation = { version: 1, policy: 'BROKEN_KEEP_THIS', bindings: null, pending: [] };
  fs.writeFileSync(file, JSON.stringify(stored));
  const restored = new Workspace({ binaries: {}, close() {} }, f.dir);
  try {
    assert.equal(restored.goalContinuation.error, 'invalid-continuation-journal');
    assert.equal(restored.persist(), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).goalContinuation, stored.goalContinuation);
    assert.throws(() => restored.configureGoalContinuation(null), /unavailable/);
  } finally { restored.close(); }
});

for (const mode of ['scope', 'all', 'deferred-scope']) test('a real ' + mode + ' pause ends the registered wait', async t => {
  const f = await fixture(t); await f.register();
  if (mode === 'deferred-scope') {
    f.runtime.emit('state', 'working'); await f.w.goalContinuationEvent(f.event);
  }
  if (mode === 'all') f.w.pause(); else f.w.pauseRoom('shared');
  assert.equal(f.w.goalContinuation.data.policy.waits.wait.status, 'invalidated');
  await f.w.goalContinuationEvent(f.event);
  f.runtime.emit('state', 'idle'); await turn(); await turn();
  assert.equal(f.writes(), 0);
});

test('revoke/regrant cannot revive a deferred wait or reuse an authority version', async t => {
  const f = await fixture(t); await f.register();
  const auth = structuredClone(f.w.goalContinuation.data.authorization);
  f.runtime.emit('state', 'working'); await f.w.goalContinuationEvent(f.event);
  f.w.configureGoalContinuation(null);
  assert.equal(f.w.goalContinuation.data.policy.waits.wait.status, 'invalidated');
  assert.equal(f.w.configureGoalContinuation(auth).status, 'denied');
  assert.equal(f.w.configureGoalContinuation({ ...auth, version: auth.version + 1 }).status, 'enabled');
  f.runtime.emit('state', 'idle'); await turn(); await turn();
  assert.equal(f.writes(), 0);
});

test('shared human input cancels a wait even though it preserves private control/draft', async t => {
  const f = await fixture(t); await f.register();
  f.runtime.send = async () => {};
  const before = f.record.controlRevision;
  await f.w.forward(f.id, 'new human direction', 'human-owner');
  assert.equal(f.record.controlRevision, before);
  assert.equal(f.w.goalContinuation.data.policy.waits.wait.status, 'invalidated');
  await f.w.goalContinuationEvent(f.event); assert.equal(f.writes(), 0);
});

test('manual pause while the port is awaiting its write withdraws valid and cannot become confirmed', async t => {
  const f = await fixture(t); await f.register();
  f.runtime.goalContinuationResume = async (intent, { valid }) => {
    f.w.pauseRoom('shared');
    assert.equal(valid(), false);
    return { status: 'rejected' };
  };
  assert.equal((await f.w.goalContinuationEvent(f.event))[0].status, 'unconfirmed');
  assert.equal(f.writes(), 0);
});

test('an interrupted attempting row gets a visible unknown recovery receipt, without native replay', async t => {
  const f = await fixture(t); await f.register();
  const data = f.w.goalContinuation.data;
  data.policy.waits.wait.status = 'attempting'; data.policy.waits.wait.intent = { id: 'uncertain-intent' };
  f.w.persist();
  const restored = new Workspace({ binaries: {}, close() {} }, f.dir);
  try {
    assert.equal(restored.goalContinuation.data.policy.waits.wait.status, 'unconfirmed');
    assert.equal(restored.room.messages.at(-1).goalContinuation.status, 'unconfirmed');
    await restored.goalContinuationEvent(f.event); assert.equal(f.writes(), 0);
  } finally { restored.close(); }
});

test('a failed cancel save cannot revive a disk wait after reconstruction', async t => {
  const f = await fixture(t); await f.register();
  f.runtime.emit('state', 'working'); await f.w.goalContinuationEvent(f.event);
  const persist = f.w.persist;
  f.w.persist = () => false;
  f.w.pauseRoom('shared');
  const restored = new Workspace({ binaries: {}, close() {} }, f.dir);
  let calls = 0;
  try {
    restored.get(f.id).state = 'idle';
    restored.get(f.id).controlRevision = f.w.goalContinuation.data.bindings.wait.controlRevision;
    restored.runtimes.set(f.id, { goalContinuationObserve: async () => structuredClone(f.native),
      goalContinuationCapabilities: [...REQUIREMENTS], goalContinuationResume: async () => { calls++; return { status: 'rejected' }; } });
    await restored.goalContinuation.boundary(f.id);
    assert.equal(calls, 0);
  } finally { restored.close(); f.w.persist = persist; }
});

for (const [name, change] of [
  ['native input pending', f => { f.native.inputPending = true; }],
  ['native approval pending', f => { f.native.approvalPending = true; }],
  ['native fresh busy disagrees with stale Workspace idle', f => { f.native.state = 'working'; }],
  ['native input knowledge missing', f => { delete f.native.inputPending; }],
]) test(name + ' cannot be replaced by display facts', async t => {
  const f = await fixture(t); await f.register(); change(f);
  await f.w.goalContinuationEvent(f.event); assert.equal(f.writes(), 0);
});

// Preserve the ordinary empty-service format until the feature is actually used.
test('unused continuation keeps empty storage unchanged and explicit revoke remains durable', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-continuation-unused-'));
  const w = new Workspace({ binaries: {}, close() {} }, dir);
  t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(w.goalContinuation.journal(), undefined);
  assert.equal(w.persist(), true);
  const read = () => JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8'));
  assert.deepEqual(read(), { sessions: [], room: { messages: [] }, drafts: {} });
  assert.equal(w.configureGoalContinuation(null).status, 'revoked');
  assert.equal(read().goalContinuation.policy.enabled, false);
  assert.equal(w.goalContinuation.journal().authorization, null);
});
