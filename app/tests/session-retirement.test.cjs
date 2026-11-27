'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const { Workspace } = require('../workspace.cjs');
const { RoomState } = require('../room-state.cjs');

const NOW = Date.parse('2026-11-26T23:00:00Z');
const MINUTE = 60000;
const CACHE_TTL = 60 * MINUTE;
const VERSION = '0.1.0-alpha.316';

async function fixture(t, provider = 'claude') {
  const { SessionRetirement, CAPABILITY } = require('../session-retirement.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-retirement-'));
  const observed = [], stops = [], diagnostics = [], contexts = new Map();
  const controls = { protected: new Set(), rotations: [], pause: null, stopState: 'ended' };
  const workspace = new Workspace({ binaries: {}, close() {}, create(record) {
    if (!record.nativeId) record.nativeId = 'codex-thread';
    const runtime = new EventEmitter();
    runtime.start = async () => runtime.emit('state', 'idle');
    runtime.terminal = { alive: true, nativeExited: false, journal: { epoch: 'terminal-epoch', index: 1 },
      async observe() {
        const { epoch, index } = this.journal;
        observed.push(record.id);
        await controls.pause?.();
        return { alive: this.alive, epoch, index };
      } };
    runtime.stopForMaintenance = check => {
      check();
      stops.push({ id: record.id, nativeId: record.nativeId });
      controls.afterStop?.();
      return { state: controls.stopState };
    };
    return runtime;
  } }, dir);
  const room = new RoomState(dir);
  t.after(() => { workspace.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const id = await workspace.create(provider, dir, 'previous-owner', 'Synthetic session');
  const record = workspace.get(id);
  record.createdAt = record.lastActivityAt = NOW - 2 * CACHE_TTL;
  if (provider === 'claude') contexts.set(id, { at: record.lastActivityAt, ttlMs: CACHE_TTL });
  const snapshot = () => ({ ...workspace.snapshot(), runtimeVersion: VERSION, capabilities: [CAPABILITY] });
  const transport = { async call(method, ...args) {
    if (method === 'initial') return snapshot();
    if (method === 'observeRetirement') return workspace.observeRetirement(...args);
    if (method === 'retireSession') {
      const result = await workspace.retireSession(...args);
      if (controls.changeReceipt) result.stoppedState.nativeId = 'another-native';
      return result;
    }
    throw Error(method);
  } };
  const entry = { client: transport, key: '.', get state() { return snapshot(); } };
  const client = { ...transport, snapshot, route: () => entry, operationGuard: () => () => {},
    retainRestoredSuccessor: (id, observed) => workspace.retainRestoredSuccessor(id, observed.nativeId) };
  const retirement = new SessionRetirement({ room, now: () => NOW, protectedIds: () => controls.protected,
    rotations: () => controls.rotations, log: event => diagnostics.push(event),
    counter: { contexts, async sample() {}, async recheck() {} } });
  const use = () => {
    record.messages.push({ id: 'a-turn', role: 'user', time: record.lastActivityAt, status: 'complete' });
    record.background = 0;
    record.scheduled = 0;
    workspace.changed();
    record.lastActivityAt = record.messages.at(-1).time;
  };
  return { workspace, room, id, record, runtime: workspace.runtimes.get(id), client, entry, controls, contexts, use,
    retirement, observed, stops, diagnostics, run: () => retirement.pass(client, VERSION) };
}

test('a new unused session waits for its observed cache lifetime before stopping', async t => {
  const f = await fixture(t);
  const startedAt = NOW - 3 * MINUTE;
  f.record.createdAt = f.record.lastActivityAt = startedAt;
  const { CompactionCounter } = require('../compaction-count.cjs');
  f.record.nativeTranscript = path.join(f.workspace.dataDir, f.record.nativeId + '.jsonl');
  fs.writeFileSync(f.record.nativeTranscript, JSON.stringify({
    type: 'assistant', sessionId: f.record.nativeId, isSidechain: false, timestamp: new Date(startedAt).toISOString(),
    message: { model: 'fixture-model', usage: { input_tokens: 1, cache_creation_input_tokens: 100, cache_read_input_tokens: 0,
      cache_creation: { ephemeral_1h_input_tokens: 100 } } },
  }) + '\n');
  f.retirement.counter = new CompactionCounter({ claudeRoot: f.workspace.dataDir, sampleMs: 0, retirement: true });
  assert.equal(f.workspace.retirementUnused(f.record), true);

  assert.equal(await f.run(), false, 'three minutes is inside the observed cache lifetime');
  assert.equal(f.retirement.counter.contexts.get(f.id)?.ttlMs, CACHE_TTL);
  assert.deepEqual(f.observed, []);
  assert.deepEqual(f.stops, []);
  assert.equal(f.room.value.archivedSessions.includes(f.id), false);

  f.retirement.now = () => startedAt + CACHE_TTL - 1;
  assert.equal(await f.run(), false, 'no stop just before expiration');
  f.retirement.now = () => startedAt + CACHE_TTL + 1;
  assert.equal(await f.run(), true);
  assert.deepEqual(f.stops.map(stop => stop.id), [f.id]);
  assert.equal(f.record.state, 'ended');
  assert.equal(f.room.value.archivedSessions.includes(f.id), true);
});

test('an unused independent session with no known cache lifetime is retained', async t => {
  const f = await fixture(t);
  f.contexts.delete(f.id);
  assert.equal(f.workspace.retirementUnused(f.record), true);
  assert.equal(await f.run(), false);
  assert.deepEqual(f.observed, []);
  assert.deepEqual(f.stops, []);
  assert.equal(f.record.state, 'idle');
});

test("a proven successor does not shorten the old session's cache lifetime", async t => {
  const f = await fixture(t);
  f.record.lastActivityAt = NOW - 3 * MINUTE;
  f.use();
  const id = await f.workspace.create('claude', f.workspace.dataDir, null, 'Successor');
  const successor = f.workspace.get(id);
  f.controls.rotations.push({ event: 'done', time: NOW - MINUTE, old: { id: f.id, nativeId: f.record.nativeId },
    new: { id, nativeId: successor.nativeId } });
  f.contexts.set(f.id, { at: f.record.lastActivityAt, ttlMs: CACHE_TTL });
  assert.equal(await f.run(), false);
  assert.deepEqual(f.observed, []);
  assert.deepEqual(f.stops, []);
  f.retirement.now = () => NOW + CACHE_TTL;
  const cache = f.contexts.get(f.id);
  f.contexts.delete(f.id);
  assert.equal(await f.run(), false, 'the successor does not substitute for unknown cache lifetime');
  f.contexts.set(f.id, cache);
  assert.equal(await f.run(), true);
  assert.deepEqual(f.stops.map(stop => stop.id), [f.id]);
});

test('an unused independent session stops once and can be recovered from the durable archive', async t => {
  const f = await fixture(t);
  assert.equal(await f.run(), true);
  assert.equal(f.record.state, 'ended');
  assert.equal(f.stops.length, 1);
  assert.equal(new RoomState(f.workspace.dataDir).apply(f.client.snapshot()).sessions.find(s => s.id === f.id).archived, true);
  await f.room.restoreSession(f.client, f.id);
  assert.equal(f.room.apply(f.client.snapshot()).sessions.find(s => s.id === f.id).archived, false);
  assert.equal(await f.run(), false);
  assert.equal(f.stops.length, 1);
});

test('known expired cache and a confirmed successor provide independent reasons to retire', async t => {
  for (const reason of ['cache', 'successor']) await t.test(reason, async t => {
    const f = await fixture(t);
    f.use();
    if (reason === 'successor') {
      const id = await f.workspace.create('claude', f.workspace.dataDir, null, 'Successor');
      const current = f.workspace.get(id);
      f.controls.rotations.push({ event: 'done', time: NOW - 600000,
        old: { id: f.id, nativeId: f.record.nativeId }, new: { id, nativeId: current.nativeId } });
    }
    assert.equal(await f.run(), true);
    assert.deepEqual(f.stops.map(s => s.id), [f.id]);
  });
});

test('only eligible records get past preflight', async t => {
  for (const reason of ['unknown ttl', 'warm cache', 'kept', 'pending turn', 'approval', 'teammate', 'background work',
    'unknown work', 'unobserved reused process', 'draft', 'sole member', 'protected']) await t.test(reason, async t => {
    const f = await fixture(t);
    if (reason === 'unknown ttl' || reason === 'warm cache') f.use();
    if (reason === 'unknown ttl') f.contexts.delete(f.id);
    if (reason === 'warm cache') f.contexts.set(f.id, { at: NOW - 1000, ttlMs: CACHE_TTL });
    if (reason === 'kept') f.controls.rotations.push({ event: 'kept', old: { id: f.id, nativeId: f.record.nativeId } });
    if (reason === 'pending turn') f.runtime.turnId = 'turn-pending';
    if (reason === 'approval') f.record.approval = { requestId: 'synthetic' };
    if (reason === 'teammate') f.record.fleet = [{ event: 'TeammateIdle' }];
    if (reason === 'background work') f.record.background = 1;
    if (reason === 'unknown work') f.record.backgroundStale = true;
    if (reason === 'unobserved reused process') {
      f.use();
      f.record.background = f.record.scheduled = null;
    }
    if (reason === 'draft') f.workspace.setDraft(f.id, 'Not submitted.');
    if (reason === 'sole member') f.workspace.join(f.id, true);
    if (reason === 'protected') f.controls.protected.add(f.id);
    assert.equal(await f.run(), false);
    assert.deepEqual(f.observed, []);
    assert.deepEqual(f.stops, []);
  });
});

test('changes during native observation can prevent an otherwise eligible stop', async t => {
  for (const change of ['view opened', 'view reopened and closed', 'native reuse', 'cache lifetime lost']) await t.test(change, async t => {
    const f = await fixture(t);
    let release, reached;
    const started = new Promise(resolve => { reached = resolve; });
    f.controls.pause = () => { reached(); return new Promise(resolve => { release = resolve; }); };
    const running = f.run();
    await Promise.race([started, running.then(() => assert.fail('no native observation'))]);
    if (change === 'view opened') f.controls.protected.add(f.id);
    else if (change === 'view reopened and closed') f.retirement.protect(f.id);
    else if (change === 'native reuse') f.runtime.turnId = 'new-turn';
    else f.retirement.counter.recheck = async () => { f.contexts.delete(f.id); };
    release();
    assert.equal(await running, false);
    assert.equal(f.record.state, 'idle');
    assert.deepEqual(f.stops, []);
  });
});

test('a Codex thread and a non-ended stop receipt both stay out of the archive', async t => {
  const codex = await fixture(t, 'codex');
  assert.equal(await codex.run(), false);
  assert.deepEqual(codex.stops, []);
  assert.ok(codex.diagnostics.some(event => event.reason === 'native-exit-receipt-unavailable'));
  const claude = await fixture(t);
  claude.controls.stopState = 'disconnected';
  assert.equal(await claude.run(), false);
  assert.equal(claude.record.state, 'disconnected');
  assert.equal(claude.room.value.archivedSessions.length, 0);
});

test('orphaned queue assignment and an open decision protect their former member', async t => {
  for (const status of ['queued', 'waiting']) await t.test(status, async t => {
    const f = await fixture(t);
    const id = f.room.queueAdd('Synthetic task', f.id, 'shared', { kind: 'person', name: 'You', sessionId: null });
    if (status === 'waiting') {
      f.room.queueMarkSent('shared', id, f.id, f.record.name, NOW, false, f.record.nativeId);
      f.room.queueSettle('shared', id, 'waiting', undefined, f.record.name, '', 'Synthetic decision');
    }
    assert.equal(f.room.queueItems('shared')[0].status, status);
    assert.equal(await f.run(), false);
    assert.deepEqual(f.stops, []);
  });
});

function mainProtection(sessions, overrides = {}) {
  const mainFile = require.resolve('../main.cjs');
  const main = fs.readFileSync(mainFile, 'utf8');
  const start = main.indexOf('function retirementProtectedIds(');
  const end = main.indexOf('async function retireIdleSession(', start);
  const role = sessionId => ({ current: () => ({ sessionId }) });
  const context = vm.createContext({ require: createRequire(mainFile),
    quitting: false, backendSwitching: null, viewStorageWarning: null, mobileBroker: null,
    queueDispatcher: { rotations: {} }, modelChanges: () => ({ ids: () => [] }),
    backgroundControl: { failed: false, holdsSessionWork: () => false },
    stewardRole: role('butler'), integratorRole: role('integrator'), queueSecretary: role('secretary'),
    butlerRole: { current: () => ({ identity: { sessionId: 'record-holder' } }) },
    spaceManagers: { all: () => [] }, openingSessionViews: new Map(), views: [], windows: new Map(),
    ...overrides });
  vm.runInContext(main.slice(start, end), context);
  return context.retirementProtectedIds({ sessions: sessions.map(id => ({ id })) });
}

test('the Main protection read includes selections, shown rows, in-flight windows and all role holders', () => {
  const ids = ['selected', 'shown', 'opening', 'butler', 'record-holder', 'secretary', 'manager', 'integrator', 'rotating', 'successor', 'awaiting-card'];
  const held = mainProtection([...ids, 'free', 'background-view'], {
    queueDispatcher: { rotations: { rotating: { newId: 'successor' } } },
    backgroundControl: { failed: false, holdsSessionWork: id => id === 'awaiting-card' },
    spaceManagers: { all: () => [['space', { sessionId: 'manager' }]] },
    openingSessionViews: new Map([['opening', 1]]),
    views: [{ active: true, selected: 'selected' }],
    windows: new Map([[1, { shown: new Set(['shown']), win: { isDestroyed: () => false }, view: { selected: 'selected' } }],
      [2, { background: true, view: { selected: 'background-view' } }]]) });
  assert.deepEqual([...held].sort(), ids.sort());
});

test('a mismatched stop receipt or a later desktop view keeps the ended record visible', async t => {
  for (const change of ['identity', 'view']) await t.test(change, async t => {
    const f = await fixture(t);
    if (change === 'identity') f.controls.changeReceipt = true;
    else f.controls.afterStop = () => f.retirement.protect(f.id);
    assert.equal(await f.run(), false);
    assert.equal(f.stops.length, 1);
    assert.equal(f.record.state, 'ended');
    assert.equal(f.room.value.archivedSessions.length, 0);
  });
});

test('a successor record missing any one proof keeps the old session', async t => {
  for (const gap of ['control', 'successor native differs', 'used after the handoff', 'old native differs', 'successor missing']) await t.test(gap, async t => {
    const f = await fixture(t);
    f.use();
    const id = await f.workspace.create('claude', f.workspace.dataDir, null, 'Successor');
    const current = f.workspace.get(id);
    const entry = { event: 'done', time: NOW - 600000, old: { id: f.id, nativeId: f.record.nativeId }, new: { id, nativeId: current.nativeId } };
    if (gap === 'successor native differs') entry.new.nativeId = 'another-native';
    if (gap === 'used after the handoff') entry.time = f.record.lastActivityAt - 1;
    if (gap === 'old native differs') entry.old.nativeId = 'previous-native';
    if (gap === 'successor missing') entry.new.id = 'no-such-session';
    f.controls.rotations.push(entry);
    if (gap === 'control') {
      assert.equal(await f.run(), true);
      assert.deepEqual(f.stops.map(s => s.id), [f.id]);
      return;
    }
    assert.equal(await f.run(), false);
    assert.deepEqual(f.observed, []);
    assert.deepEqual(f.stops, []);
  });
});

test('work held elsewhere keeps an otherwise eligible session', async t => {
  for (const hold of ['control', 'wake control', 'sent queue item', 'wake waiting for it', 'own message awaiting native', 'unused for under two minutes']) await t.test(hold, async t => {
    const f = await fixture(t);
    if (hold === 'sent queue item') {
      const item = f.room.queueAdd('Synthetic task', f.id, 'shared', { kind: 'person', name: 'You', sessionId: null });
      f.room.queueMarkSent('shared', item, f.id, f.record.name, NOW, false, f.record.nativeId);
      assert.equal(f.room.queueItems('shared')[0].status, 'sent');
    }
    if (hold === 'wake waiting for it' || hold === 'wake control') {
      const other = f.workspace.get(await f.workspace.create('claude', f.workspace.dataDir, null, 'Sender'));
      other.messages.push({ id: 'wake-1', role: 'system', time: NOW, wake: { status: hold === 'wake control' ? 'delivered' : 'held', recipientId: f.id } });
      f.workspace.changed();
    }
    if (hold === 'own message awaiting native') {
      f.use();
      f.record.messages.push({ id: 'pending', role: 'user', time: f.record.lastActivityAt, status: 'awaiting-native' });
    }
    if (hold === 'unused for under two minutes') f.record.createdAt = f.record.lastActivityAt = NOW - MINUTE / 2;
    if (hold === 'control' || hold === 'wake control') {
      assert.equal(await f.run(), true);
      assert.deepEqual(f.stops.map(s => s.id), [f.id]);
      return;
    }
    assert.equal(await f.run(), false);
    assert.deepEqual(f.stops, []);
    assert.equal(f.record.state, 'idle');
  });
});

test('an open phone entry or a missing role reader stops the Main protection read', () => {
  const read = overrides => mainProtection(['free'], overrides);
  assert.deepEqual([...read({})].sort(), ['butler', 'integrator', 'record-holder', 'secretary']);
  assert.equal(read({ mobileBroker: { openUntil: () => Date.now() + MINUTE } }), null);
  assert.equal(read({ butlerRole: null }), null);
  assert.equal(read({ backgroundControl: { failed: true, holdsSessionWork: () => false } }), null);
});

test('a waiting card guarding another session protects that session until it expires', () => {
  const { BackgroundControl } = require('../background-control.cjs');
  const holds = (records, id) => BackgroundControl.prototype.holdsSessionWork.call({ data: { records }, expired: row => row.gone === true }, id);
  const card = { state: 'confirmation-required', actor: { id: 'asker' }, guard: { sessions: [{ id: 'target' }] } };
  assert.equal(holds([card], 'target'), true);
  assert.equal(holds([card], 'asker'), true);
  assert.equal(holds([{ ...card, gone: true }], 'target'), false);
  assert.equal(holds([{ ...card, state: 'running', gone: true }], 'target'), true);
  assert.equal(holds([{ ...card, state: 'complete' }], 'target'), false);
});
