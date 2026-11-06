const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const app = process.env.NAW_T117_APP_ROOT || path.resolve(__dirname, '..');
const { Codex } = require(path.join(app, 'adapters.cjs'));
const { Workspace } = require(path.join(app, 'workspace.cjs'));

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-goal-status-unit-'));
  const calls = [], host = { binaries: {}, codexTargets: new Map(), rpc: {
    call(...args) { calls.push(args); throw Error('This test must not issue RPC'); },
    reply() { throw Error('This test must not reply to native requests'); },
  }, close() {} };
  const w = new Workspace(host, dir), s = { id: 'goal-status-fixture', provider: 'codex',
    nativeId: 'synthetic-native-goal-status', cwd: dir, messages: [], state: 'idle',
    owner: 'synthetic-owner', controlRevision: 4, memberRevision: 0, roomId: 'shared' };
  const r = new Codex(s, host);
  w.sessions.set(s.id, s); w.runtimes.set(s.id, r); w.bind(s, r);
  host.codexTargets.set(s.nativeId, r);
  w.setDraft(s.id, 'Synthetic unsent draft', s.owner);
  const snapshot = () => w.snapshot().sessions.find(row => row.id === s.id);
  const update = (status, options = {}) => r.event({ method: 'thread/goal/updated', params: {
    threadId: options.outerId ?? s.nativeId, turnId: options.turnId ?? null,
    goal: { threadId: options.innerId ?? s.nativeId, status, objective: 'Synthetic private objective',
      tokenBudget: 300, tokensUsed: options.tokens ?? 29, timeUsedSeconds: 8, createdAt: 10, updatedAt: 20 },
  } }, options.rpc ?? host.rpc);
  t.after(() => { assert.deepEqual(calls, [], 'Observation adds no RPC reads, writes or turns');
    w.close(); fs.rmSync(dir, { recursive: true }); });
  return { w, s, r, host, calls, snapshot, update };
}

for (const status of ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']) {
  test('native goal status projects ' + status + ' without changing the session or exposing the goal', t => {
    const f = fixture(t); f.update(status);
    const row = f.snapshot();
    assert.equal(row.nativeGoal?.nativeId, f.s.nativeId);
    assert.equal(row.nativeGoal?.status, status);
    assert.ok(Number.isFinite(row.nativeGoal.observedAt));
    assert.deepEqual(Object.keys(row.nativeGoal).sort(), ['nativeId', 'observedAt', 'status']);
    assert.equal(row.state, 'idle'); assert.equal(row.owner, 'synthetic-owner');
    assert.equal(row.controlRevision, 4); assert.equal(row.liveDraft, 'Synthetic unsent draft');
    assert.ok(!JSON.stringify(row.nativeGoal).includes('Synthetic private objective'));
  });
}

test('unobserved is unknown, while an exact cleared notification proves no goal', t => {
  const f = fixture(t); assert.equal(f.snapshot().nativeGoal, null);
  f.r.event({ method: 'thread/goal/cleared', params: { threadId: f.s.nativeId } });
  assert.equal(f.snapshot().nativeGoal?.status, null);
  assert.equal(f.snapshot().nativeGoal?.nativeId, f.s.nativeId);
  f.update('blocked'); assert.equal(f.snapshot().nativeGoal.status, 'blocked');
  f.r.event({ method: 'thread/goal/cleared', params: { threadId: f.s.nativeId } });
  assert.equal(f.snapshot().nativeGoal?.status, null);
});

test('wrong thread notifications cannot change a verified observation', t => {
  const f = fixture(t); f.update('paused');
  f.update('active', { outerId: 'different-native-thread', innerId: 'different-native-thread' });
  assert.equal(f.snapshot().nativeGoal?.status, 'paused');
  f.r.event({ method: 'thread/goal/cleared', params: { threadId: 'different-native-thread' } });
  assert.equal(f.snapshot().nativeGoal?.status, 'paused');
});

test('a malformed current-thread goal becomes unknown rather than no-goal or a guessed state', t => {
  const f = fixture(t);
  for (const status of ['unrecognized', '', null, {}, []]) {
    f.update('blocked'); f.update(status); assert.deepEqual(f.snapshot().nativeGoal, { nativeId: f.s.nativeId, known: false });
  }
  f.update('blocked'); f.update('active', { innerId: 'different-native-thread' });
  assert.deepEqual(f.snapshot().nativeGoal, { nativeId: f.s.nativeId, known: false });
});

test('the selected notification source excludes old RPCs and the secondary host stream', t => {
  const f = fixture(t), terminal = { connected: true };
  f.update('blocked');
  f.update('active', { rpc: {} }); assert.equal(f.snapshot().nativeGoal?.status, 'blocked');
  f.r.terminalRpc = terminal; f.r.terminalNotificationSource = true;
  assert.deepEqual(f.snapshot().nativeGoal, { nativeId: f.s.nativeId, known: false }, 'Changing source invalidates the old host observation');
  f.update('active'); assert.deepEqual(f.snapshot().nativeGoal, { nativeId: f.s.nativeId, known: false }, 'The host is no longer authoritative');
  f.update('paused', { rpc: terminal }); assert.equal(f.snapshot().nativeGoal?.status, 'paused');
  terminal.connected = false; assert.deepEqual(f.snapshot().nativeGoal, { nativeId: f.s.nativeId, known: false });
});

test('native identity, lifecycle, observation and connection gaps hide prior known status', t => {
  const f = fixture(t); f.update('blocked');
  f.r.lifecycleRevision++; assert.deepEqual(f.snapshot().nativeGoal, { nativeId: f.s.nativeId, known: false });
  f.update('paused'); assert.equal(f.snapshot().nativeGoal?.status, 'paused');
  f.s.nativeId = 'replacement-native-thread'; assert.deepEqual(f.snapshot().nativeGoal, { nativeId: f.s.nativeId, known: false });
  f.update('active'); assert.equal(f.snapshot().nativeGoal?.status, 'active');
  f.r.nativeObservationPending = true; assert.deepEqual(f.snapshot().nativeGoal, { nativeId: f.s.nativeId, known: false });
  f.r.nativeObservationPending = false; f.r.transportDisconnected = true;
  assert.deepEqual(f.snapshot().nativeGoal, { nativeId: f.s.nativeId, known: false });
});

test('a same-thread goal applies across ordinary turns and never replaces working or approval', t => {
  const f = fixture(t);
  f.r.observeStatus({ type: 'active', activeFlags: [] });
  f.update('blocked', { turnId: 'prior-goal-turn' });
  assert.equal(f.snapshot().state, 'working'); assert.equal(f.snapshot().nativeGoal?.status, 'blocked');
  f.r.observeStatus({ type: 'active', activeFlags: ['waitingOnApproval'] });
  f.update('paused');
  assert.equal(f.snapshot().state, 'approval'); assert.equal(f.snapshot().nativeGoal?.status, 'paused');
});

test('a gap after explicit cleared does not invent an ongoing goal hint', t => {
  const f = fixture(t);
  f.r.event({ method: 'thread/goal/cleared', params: { threadId: f.s.nativeId } });
  f.r.lifecycleRevision++; assert.equal(f.snapshot().nativeGoal, null);
});

test('returning to an earlier source cannot revive its status across a native context request', t => {
  const f = fixture(t); f.update('blocked');
  f.r.observeTerminalContext({ kind: 'request', method: 'thread/resume', threadId: f.s.nativeId, key: 'same-thread-request' });
  const terminal = { connected: true };
  f.r.terminalNotificationSource = true; f.r.terminalRpc = terminal;
  // No view is required to read a snapshot while the intermediate source owns it.
  f.r.terminalNotificationSource = false; f.r.terminalRpc = null;
  assert.deepEqual(f.snapshot().nativeGoal, { nativeId: f.s.nativeId, known: false });
});

test('counter-only duplicate goal notifications do not publish another workspace change', t => {
  const f = fixture(t); let changes = 0; f.r.on('nativeGoal', () => changes++);
  f.update('active', { tokens: 29 }); f.update('active', { tokens: 35 });
  assert.equal(changes, 1);
  f.update('blocked', { tokens: 40 }); assert.equal(changes, 2);
});

test('a resume snapshot in the same tick as its response is retained but hidden until identity confirmation', async t => {
  const f = fixture(t), terminal = { connected: true }, existingResumeCalls = [];
  f.r.terminalRpc = terminal; f.r.terminalNotificationSource = true;
  f.update('paused', { rpc: terminal });
  let resolveResume;
  f.host.rpc.call = (method, params) => {
    existingResumeCalls.push(method); assert.equal(method, 'thread/resume');
    assert.deepEqual(params, { threadId: f.s.nativeId, excludeTurns: true });
    return new Promise(resolve => { resolveResume = resolve; });
  };
  f.r.hydrateHistory = async () => true; // History I/O is not the observation under test.
  f.r.observeTerminalContext({ kind: 'disconnected', rpc: terminal });
  assert.equal(f.r.nativeObservationPending, true);
  resolveResume({ thread: { id: f.s.nativeId, status: { type: 'idle' } } });
  // Two native frames can be dispatched before the response Promise microtask.
  f.update('blocked');
  assert.deepEqual(f.snapshot().nativeGoal, { nativeId: f.s.nativeId, known: false });
  await f.r.observing;
  assert.equal(f.r.nativeObservationPending, false);
  assert.equal(f.snapshot().nativeGoal?.status, 'blocked');
  assert.deepEqual(existingResumeCalls, ['thread/resume'], 'No goal read, goal write or extra turn is added');
});


test('confirmed goal reaches subscribers while reconnect history remains pending', async t => {
  const f = fixture(t), terminal = { connected: true }, calls = [], published = [];
  let resolveResume, resolveHistory;
  f.host.rpc.call = (method, params) => {
    calls.push(method);
    assert.equal(params.threadId, f.s.nativeId);
    if (method === 'thread/resume') return new Promise(resolve => { resolveResume = resolve; });
    if (method === 'thread/items/list') return new Promise(resolve => { resolveHistory = resolve; });
    throw Error('Unexpected RPC: ' + method);
  };
  f.w.on('change', () => published.push(f.snapshot()));
  f.r.observeSettings({ model: 'synthetic-model', effort: 'medium' });
  f.r.terminalRpc = terminal; f.r.terminalNotificationSource = true;
  f.update('paused', { rpc: terminal });
  f.r.observeTerminalContext({ kind: 'disconnected', rpc: terminal });
  f.r.event({ method: 'thread/settings/updated', params: { threadId: f.s.nativeId,
    threadSettings: { model: 'synthetic-model', effort: 'high' } } });
  f.r.event({ method: 'thread/status/changed', params: { threadId: f.s.nativeId, status: { type: 'idle' } } });
  resolveResume({ model: 'synthetic-model', reasoningEffort: 'medium', thread: {
    id: f.s.nativeId, status: { type: 'active', activeFlags: [] },
  } });
  f.update('blocked');
  await Promise.resolve();
  const during = { direct: f.snapshot(), published: published.at(-1), historyPending: !!resolveHistory,
    observationPending: f.r.nativeObservationPending };
  resolveHistory({ data: [], nextCursor: null });
  await f.r.observing;
  assert.equal(during.historyPending, true);
  assert.equal(during.observationPending, false);
  assert.equal(during.direct.nativeGoal?.status, 'blocked');
  assert.equal(during.published.nativeGoal?.status, 'blocked', 'Publish confirmed facts before history finishes');
  assert.equal(during.published.state, 'idle', 'The older resume reply must not rewind live state');
  assert.equal(during.published.nativeSettings.effort, 'high', 'The older reply must not rewind settings');
  assert.equal(during.published.chatAvailable, false, 'History still controls chat readiness');
  assert.equal(during.published.liveDraft, 'Synthetic unsent draft');
  assert.deepEqual(calls, ['thread/resume', 'thread/items/list'], 'No extra reads or goal mutation');
});
