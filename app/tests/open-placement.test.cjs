// B5 prerequisite: a session opened under the person's creation grant can receive work.
// The backend's quota gate is unchanged. When the person named a space in the grant, the desktop
// joins the new session to it and records that; ordinary dispatch then sends it queued work. The
// opener's task is not delivered or queued, as the tool and the consent text say. Zero model: a
// real backend journal, a real space store, and the function from main.cjs; only the space join
// itself (covered by its own suites and by the hidden GUI run) is replaced by a recorder.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events'), { randomUUID } = require('node:crypto');
const { Workspace } = require('../workspace.cjs'), { RoomState } = require('../room-state.cjs');
const { tools } = require('../operator-control.cjs'), locale = require('../ui-locale.js'), spaces = require('../collaboration-spaces.cjs');
const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');

async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-open-placement-')));
  const host = { binaries: {}, close() {}, create(s) {
    const r = new EventEmitter(); r.record = s; s.nativeId ||= randomUUID(); r.operatorAvailable = true; r.chatAvailable = true;
    r.liveTurn = { id: 'turn-' + s.id, promptId: 'prompt-' + s.id };
    r.start = async () => { r.emit('model', 'fixture-native-model'); r.emit('state', 'idle'); };
    r.send = async (text, tag) => { r.emit('submitted', tag); };
    return r;
  } };
  const w = new Workspace(host, root), id = await w.create('claude', root, 'owner', 'Initiator');
  const desk = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-open-desk-'));
  t.after(() => { w.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(desk, { recursive: true, force: true }); });
  const s = w.get(id), r = w.runtimes.get(id); s.nativePermissionMode = 'default';
  w.operatorAction(null, 'enabled', true); w.operatorAction(id, 'enabled', true);
  const roomState = new RoomState(desk), space = roomState.create('Synthetic work space'), elsewhere = roomState.create('Somewhere else');
  const joins = [], calls = []; let joinFails = 0, placedFails = 0, recordFails = 0;
  const proofs = []; let duringJoin = null;
  roomState.membership = async (client, sessionId, join, label, room, expected) => {
    if (joinFails > 0) { joinFails -= 1; throw Error('Synthetic busy space'); }
    joins.push([sessionId, join, room]); proofs.push(expected);
    if (duringJoin) { const act = duringJoin; duringJoin = null; act(); }
    // Like the real join: the session now has this space as its home.
    Object.assign(w.get(sessionId), spaces.withPlacement(w.get(sessionId), room));
    return { changed: true };
  };
  const record = roomState.recordOpened.bind(roomState);
  roomState.recordOpened = (...args) => { if (recordFails > 0) { recordFails -= 1; throw Error('Synthetic storage failure'); } return record(...args); };
  const timers = [];
  const client = { snapshot: () => w.snapshot(), call: async (method, ...args) => {
    calls.push([method, args[1]]);
    if (method !== 'operatorAction') throw Error('Unexpected backend call ' + method);
    if (args[1] === 'placed' && placedFails > 0) { placedFails -= 1; throw Error('Synthetic write-back failure'); }
    return w.operatorAction(...args);
  } };
  const start = main.indexOf('const openPlacing = new Set()'), end = main.indexOf('function auditBackgroundOperation(record) {');
  assert.ok(start > 0 && end > start, 'The placement step exists in main.cjs');
  let broadcasts = 0, schedules = 0;
  let clock = 1_800_000_000_000;
  const windows = new Map([['agent', { background: true, client: { snapshot() { throw Error('An agent window is never used'); } }, win: { isDestroyed: () => false } }],
    ['closed', { background: false, client: { snapshot() { throw Error('A closed window is never used'); } }, win: { isDestroyed: () => true } }],
    ['closing', { background: false, client: { closing: true, snapshot() { throw Error('A closing client is never used'); } }, win: { isDestroyed: () => false } }],
    ['disconnected', { background: false, client: { socket: { destroyed: true }, snapshot() { throw Error('A disconnected client is never used'); } }, win: { isDestroyed: () => false } }],
    ['person', { background: false, client, win: { isDestroyed: () => false } }]]);
  const sandbox = { roomState, windows, roomIds: spaces.roomIds, placementRevision: spaces.placementRevision, Date: { now: () => clock }, setTimeout: (run, delay) => { timers.push({ run, delay }); return { unref() {} }; },
    sessionLabels: { labels: new Map([[id, 'Lead']]) }, broadcastRoom: async () => { broadcasts += 1; }, queueDispatcher: { schedule: () => { schedules += 1; } } };
  vm.createContext(sandbox); vm.runInContext(main.slice(start, end) + '\nthis.placeOpened = placeOpened; this.OPEN_RETRY_MS = OPEN_RETRY_MS;', sandbox);
  const grant = (extra = {}) => w.operatorAction(id, 'grant', { providers: ['claude'], directories: [root], permission: 'default', daily: 2, concurrent: 2, expiresAt: Date.now() + 60000, ...extra });
  const identity = () => ({ nativeId: s.nativeId, turnId: r.liveTurn.id, promptId: r.liveTurn.promptId, callId: randomUUID() });
  const open = (extra = {}) => r.operatorCall(identity(), 'workspace_open', { action_id: randomUUID(), provider: 'claude', cwd: root, name: 'Opened', task: 'Synthetic first task', permission: 'default', ...extra });
  const place = (advance = 0) => { clock += advance; return sandbox.placeOpened(client, w.snapshot(), clock); };
  const facts = (room = space) => roomState.metadata(room).events.filter(event => event.monitor?.kind === 'opened');
  return { w, id, s, r, root, roomState, space, elsewhere, client, grant, open, place, facts, joins, calls, sandbox,
    failJoins: n => { joinFails = n; }, failPlaced: n => { placedFails = n; }, failRecords: n => { recordFails = n; }, counts: () => ({ broadcasts, schedules }),
    proofs, timers, windows, during: act => { duringJoin = act; }, advance: ms => { clock += ms; } };
}
const listed = f => f.w.snapshot().operatorPolicy.placements;

test('a grant without a space behaves as before: the session is created and nothing else happens', async t => {
  const f = await fixture(t); f.grant();
  const opened = await f.open();
  assert.equal(opened.status, 'created'); assert.equal(opened.delivery, 'pending-1b'); assert.equal(opened.space, null); assert.equal(opened.placement, null);
  assert.deepEqual(listed(f), []);
  await f.place();
  assert.deepEqual(f.joins, []); assert.deepEqual(f.calls, []); assert.equal(f.facts().length, 0);
});

test('a grant that names a space: the new session joins it once and is recorded there; the task is neither read nor queued', async t => {
  const f = await fixture(t); f.grant({ space: f.space });
  const args = { action_id: 'one-open' }, opened = await f.open(args);
  assert.equal(opened.status, 'created'); assert.equal(opened.space, f.space); assert.equal(opened.placement, 'pending');
  assert.deepEqual(listed(f), [{ key: listed(f)[0].key, initiatorId: f.id, sessionId: opened.sessionId, space: f.space }]);
  assert.equal(JSON.stringify(f.w.snapshot().operatorPolicy).includes('Synthetic first task'), false, 'The task text is not in the state every window receives');
  await f.place();
  assert.deepEqual(f.joins, [[opened.sessionId, true, f.space]]);
  const [record] = f.facts();
  assert.deepEqual(record.monitor, { kind: 'opened', key: `opened:${opened.sessionId}`, sessionId: opened.sessionId, initiatorId: f.id, joined: true });
  assert.equal(record.text, '按你的授权，Lead 新开了 Opened，已加入这个空间');
  assert.equal(locale.format('en', record.uiMessage.key, record.uiMessage.params), 'Under your grant, Lead opened Opened; it has joined this space');
  assert.equal(f.roomState.queueItems(f.space).length, 0, 'Only the person or the secretary adds queue items');
  assert.equal(JSON.stringify(f.w.operatorAction(f.id, 'placement', { key: `["${f.s.nativeId}","one-open"]` })).includes('Synthetic first task'), false, 'The desktop is never handed the task');
  assert.deepEqual(listed(f), [], 'Placed: no longer listed');
  const again = await f.open(args);
  assert.equal(again.sessionId, opened.sessionId); assert.equal(again.placement, 'joined'); assert.equal(again.delivery, 'pending-1b', 'The task is still undelivered, as the tool says');
  assert.deepEqual(f.counts(), { broadcasts: 1, schedules: 1 });
  await f.place(60000); await f.place(60000);
  assert.equal(f.joins.length, 1); assert.equal(f.facts().length, 1);
});

for (const [name, end] of [
  ['revokes the grant', (f, grantId) => f.w.operatorAction(f.id, 'revoke', grantId)],
  ['turns the interface off for this initiator', f => f.w.operatorAction(f.id, 'enabled', false)],
  ['turns the interface off for everyone', f => f.w.operatorAction(null, 'enabled', false)],
  ['lets the grant run out', f => { for (const domain of Object.values(f.w.operator.data.domains)) domain.expiresAt = Date.now() - 1; }],
  ['removes the initiator', f => { f.w.sessions.delete(f.id); }],
]) {
  test(`the person ${name} after the session was created but before it was placed: it is not placed`, async t => {
    const f = await fixture(t), grantId = f.grant({ space: f.space });
    const args = { action_id: 'ended-grant' }, opened = await f.open(args);
    f.failJoins(1); await f.place();
    assert.equal(f.joins.length, 0, 'The space was busy at the first attempt');
    end(f, grantId);
    assert.deepEqual(listed(f), [], 'No longer offered for placement');
    await f.place(60000); await f.place(60000);
    assert.deepEqual(f.joins, []); assert.equal(f.facts().length, 0);
    // A desktop that still holds an old state cannot place it either: the journal that owns the action refuses.
    const stale = { operatorPolicy: { placements: [{ key: `["${f.s.nativeId}","ended-grant"]`, initiatorId: f.id, sessionId: opened.sessionId, space: f.space }] }, sessions: f.w.snapshot().sessions };
    for (let attempt = 0; attempt < 8; attempt += 1) await f.sandbox.placeOpened(f.client, stale, 1_900_000_000_000 + attempt * 60000);
    assert.deepEqual(f.joins, []); assert.equal(f.facts().length, 0);
    if (f.w.sessions.has(f.id) && f.w.operator.data.enabled && f.w.operator.data.sessions[f.id].enabled) {
      const result = await f.open(args);
      assert.equal(result.placement, 'not-placed'); assert.equal(result.placementError, 'grant-ended');
    }
  });
}

test('archiving is the desktop\'s own list: an archived initiator or an archived new session is not placed, and no record is written', async t => {
  for (const [who, error] of [['initiator', 'initiator-archived'], ['opened', 'session-unavailable']]) {
    const f = await fixture(t); f.grant({ space: f.space });
    const args = { action_id: 'archived-' + who }, opened = await f.open(args);
    f.roomState.value.archivedSessions.push(who === 'initiator' ? f.id : opened.sessionId);
    await f.place();
    assert.deepEqual(f.joins, []); assert.equal(f.facts().length, 0);
    const result = await f.open(args);
    assert.equal(result.placement, 'not-placed'); assert.equal(result.placementError, error);
    await f.place(60000); assert.deepEqual(f.joins, []);
  }
});

test('the join carries the placement this state showed, so a move the person makes in between fails it; a member is never joined twice', async t => {
  const f = await fixture(t); f.grant({ space: f.space });
  const args = { action_id: 'proof' }, opened = await f.open(args), session = f.w.get(opened.sessionId);
  await f.place();
  assert.equal(JSON.stringify(f.proofs), JSON.stringify([{ nativeId: session.nativeId, placementRevision: 0, connectionRevision: session.connectionRevision || 0 }]));
  // Already a member, result not yet saved (the write-back failed): the next attempt records and saves, without another join.
  const g = await fixture(t); g.grant({ space: g.space });
  const other = { action_id: 'member-already' }; await g.open(other);
  g.failPlaced(1); await g.place();
  assert.equal(g.joins.length, 1);
  g.failJoins(99);
  await g.place(60000);
  assert.equal(g.joins.length, 1, 'No second join, so a join that would now fail cannot turn a member into "not joined"');
  assert.equal((await g.open(other)).placement, 'joined');
});

test('a grant revoked while the join is under way: the session did join, and the saved result says so', async t => {
  const f = await fixture(t), grantId = f.grant({ space: f.space });
  const args = { action_id: 'mid-join' }; await f.open(args);
  f.during(() => f.w.operatorAction(f.id, 'revoke', grantId));
  await f.place();
  assert.equal(f.joins.length, 1); assert.equal(f.facts()[0].monitor.joined, true);
  const result = await f.open(args);
  assert.equal(result.placement, 'joined', 'Not "grant ended": it is a member'); assert.equal(result.placementError, undefined);
});

test('over quota or with no grant in force: no session is created and nothing is placed', async t => {
  const f = await fixture(t), grantId = f.grant({ space: f.space, daily: 1, concurrent: 1 });
  await f.open(); await f.place();
  await assert.rejects(f.open(), /quota is exhausted/);
  assert.deepEqual(listed(f), []);
  await f.place(60000);
  assert.equal(f.joins.length, 1); assert.equal(f.facts().length, 1);
  f.w.operatorAction(f.id, 'revoke', grantId);
  const pending = await f.open();
  assert.equal(pending.status, 'pending-authorization'); assert.equal(pending.sessionId, null); assert.equal(pending.placement, null);
  await f.place(60000);
  assert.equal(f.joins.length, 1); assert.equal(f.w.sessions.size, 2, 'The initiator and the one session created within quota');
});

test('a space that is gone or archived: the session exists, the result says it was not placed, and nothing is retried', async t => {
  for (const spoil of [f => f.roomState.update({ archived: true }, undefined, f.space), f => { f.roomState.spaces = { version: 1, rooms: [] }; }]) {
    const f = await fixture(t); f.grant({ space: f.space });
    const args = { action_id: 'no-space' }, opened = await f.open(args);
    spoil(f);
    await f.place();
    assert.deepEqual(f.joins, []);
    const result = await f.open(args);
    assert.equal(result.sessionId, opened.sessionId); assert.equal(result.placement, 'not-placed'); assert.equal(result.placementError, 'space-unavailable');
    assert.deepEqual(listed(f), []);
    await f.place(60000); assert.deepEqual(f.joins, []);
  }
});

test('a session the person already put somewhere else is left there, and the named space says it did not join', async t => {
  const f = await fixture(t); f.grant({ space: f.space });
  const args = { action_id: 'moved' }, opened = await f.open(args);
  Object.assign(f.w.get(opened.sessionId), spaces.withPlacement(f.w.get(opened.sessionId), f.elsewhere));
  await f.place();
  assert.deepEqual(f.joins, [], 'Not moved back');
  const [record] = f.facts();
  assert.equal(record.monitor.joined, false); assert.equal(record.text, '按你的授权，Lead 新开了 Opened，但它没能加入这个空间；可以手动把它拖进来');
  assert.equal(locale.format('en', record.uiMessage.key, record.uiMessage.params), 'Under your grant, Lead opened Opened, but it could not join this space; you can drag it in yourself');
  const result = await f.open(args);
  assert.equal(result.placement, 'not-placed'); assert.equal(result.placementError, 'moved-elsewhere');
  assert.equal(f.facts(f.elsewhere).length, 0);
});

test('a space that is busy is tried again seconds apart, not with every state; after the last try the person is told once and nothing more is tried', async t => {
  const f = await fixture(t); f.grant({ space: f.space });
  const args = { action_id: 'busy-space' }; await f.open(args);
  f.failJoins(2);
  await f.place(); for (let state = 0; state < 20; state += 1) await f.place(50);
  assert.equal(f.calls.filter(([, action]) => action === 'placement').length, 1, 'Twenty states within a second are one attempt');
  assert.deepEqual(f.timers.map(timer => timer.delay), [2100], 'One timer for the retry, so a quiet system tries again');
  await f.place(2000); assert.equal(f.joins.length, 0);
  assert.deepEqual(f.timers.map(timer => timer.delay), [2100, 5100]);
  // The second retry comes from its timer, with no state event at all.
  f.advance(5200); await f.timers[1].run(); await new Promise(resolve => setImmediate(resolve));
  for (let wait = 0; wait < 50 && f.joins.length === 0; wait += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.joins.length, 1); assert.equal(f.facts().length, 1); assert.equal((await f.open(args)).placement, 'joined');
  assert.equal(f.timers.length, 2, 'Placed: no further timer');
  // The timer takes a window of the person that is open when it fires; with none open it does nothing and spends no attempt.
  const h = await fixture(t); h.grant({ space: h.space });
  await h.open({ action_id: 'no-window' }); h.failJoins(1); await h.place();
  h.windows.delete('person'); h.advance(2200); await h.timers[0].run();
  for (let wait = 0; wait < 20; wait += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.joins.length, 0); assert.equal(h.calls.filter(([, action]) => action === 'placement').length, 1, 'No attempt was spent');
  await h.place(100); assert.equal(h.joins.length, 1, 'The next state from an open window places it');
  const audit = h.w.operator.data.audit.at(-1);
  assert.equal(audit.result, 'placed'); assert.equal(audit.by, 'desktop');
  // A state that cannot be read when the timer fires stays inside the timer: nothing is thrown, nothing is spent.
  const k = await fixture(t); k.grant({ space: k.space });
  await k.open({ action_id: 'unreadable-state' }); k.failJoins(1); await k.place();
  const snapshot = k.client.snapshot; k.client.snapshot = () => { throw Error('Synthetic ownership conflict'); };
  k.advance(2200); assert.doesNotThrow(() => k.timers[0].run());
  for (let wait = 0; wait < 20; wait += 1) await new Promise(resolve => setImmediate(resolve));
  k.client.snapshot = snapshot;
  assert.equal(k.calls.filter(([, action]) => action === 'placement').length, 1);
  await k.place(100); assert.equal(k.joins.length, 1);
  const g = await fixture(t); g.grant({ space: g.space });
  const other = { action_id: 'always-busy' }; await g.open(other);
  g.failJoins(99);
  for (let state = 0; state < 12; state += 1) await g.place(60000);
  assert.equal(g.calls.filter(([, action]) => action === 'placement').length, g.sandbox.OPEN_RETRY_MS.length + 1, 'One first try and one per retry delay');
  const result = await g.open(other);
  assert.equal(result.placement, 'not-placed'); assert.equal(result.placementError, 'join-refused');
  assert.equal(g.facts().length, 1); assert.equal(g.facts()[0].monitor.joined, false, 'The person can see that it did not join');
  assert.equal(g.calls.filter(([, action]) => action === 'placed').length, 1, 'Saved once');
});

test('a failure after the join is reported as joined, and a crash before the result is saved repeats nothing', async t => {
  const f = await fixture(t); f.grant({ space: f.space });
  const args = { action_id: 'crash-open' }; await f.open(args);
  f.failPlaced(1);
  await f.place();
  assert.equal(listed(f).length, 1, 'The result was not saved, so it is still listed'); assert.equal(f.facts().length, 1);
  await f.place(60000);
  assert.equal(f.facts().length, 1, 'One record'); assert.equal((await f.open(args)).placement, 'joined'); assert.deepEqual(listed(f), []);
  const g = await fixture(t); g.grant({ space: g.space });
  const other = { action_id: 'record-fails' }; await g.open(other);
  g.failRecords(99);
  await g.place(); g.failJoins(99);
  for (let state = 0; state < 12; state += 1) await g.place(60000);
  const result = await g.open(other);
  assert.equal(g.joins.length, 1);
  assert.equal(result.placement, 'joined', 'It is a member, and the result says so'); assert.equal(result.placementError, 'record-failed');
});

test('the placement calls are the desktop\'s own: no agent tool reaches them, another initiator cannot use them, and a saved result cannot be changed', async t => {
  const f = await fixture(t); f.grant({ space: f.space });
  assert.deepEqual(tools.map(tool => tool.name), ['workspace_sessions', 'workspace_open', 'workspace_report'], 'The agent tool list is unchanged');
  assert.equal(tools[1].description, 'Create at most one native session per action_id under an explicit human grant. Creation only: the initial task remains pending delivery. No model selection or inherited general control.');
  const opened = await f.open({ action_id: 'guarded' }), key = listed(f)[0].key;
  const identity = { nativeId: f.s.nativeId, turnId: f.r.liveTurn.id, promptId: f.r.liveTurn.promptId, callId: randomUUID() };
  await assert.rejects(async () => f.r.operatorCall(identity, 'workspace_placed', { key }), /Invalid operator tool arguments/);
  const other = await f.w.create('claude', f.root, 'owner', 'Other');
  assert.throws(() => f.w.operatorAction(other, 'placed', { key, result: { joined: true } }), /another initiator/);
  assert.throws(() => f.w.operatorAction(other, 'placement', { key }), /another initiator/);
  for (const result of [null, {}, { joined: 'yes' }, { joined: false }, { joined: true, queued: true }, { joined: false, error: 'Free text\nwith lines' }, { joined: false, error: 7 }]) {
    assert.throws(() => f.w.operatorAction(f.id, 'placed', { key, result }), /Invalid placement result/, JSON.stringify(result));
  }
  assert.throws(() => f.w.operatorAction(f.id, 'placed', { key: 'no-such-action', result: { joined: true } }), /another initiator/);
  assert.deepEqual(f.w.operatorAction(f.id, 'placement', { key }), { key, space: f.space, sessionId: opened.sessionId, placed: false });
  const first = f.w.operatorAction(f.id, 'placed', { key, result: { joined: true } });
  assert.deepEqual(f.w.operatorAction(f.id, 'placed', { key, result: { joined: false, error: 'join-refused' } }), first, 'The first saved result stands');
  assert.throws(() => f.grant({ space: '../outside' }), /not a space/);
  assert.throws(() => f.grant({ space: 7 }), /not a space/);
  // The saved result is part of the journal: a restarted backend still knows it and offers nothing again.
  f.w.close();
  const again = new Workspace({ binaries: {}, close() {} }, f.root); t.after(() => again.close());
  assert.deepEqual(again.operator.policy().placements, []); assert.equal(again.operator.data.actions[key].placement.joined, true);
});

test('from an agent\'s context the desktop refuses a grant that names a space and both placement calls, before any confirmation is shown', () => {
  const start = main.indexOf('function register(name, handler) {'), end = main.indexOf("if (backgroundOperation.deliveryTargets(name, args))", start);
  assert.ok(start > 0 && end > start);
  const guard = main.slice(start, end);
  assert.ok(guard.includes("if (name === 'operatorAction' && (['placement', 'placed'].includes(args[1]) || args[1] === 'grant' && args[2] && typeof args[2] === 'object' && Object.hasOwn(args[2], 'space'))) throw uiError('error.operator.personOnlySpace');"));
  assert.ok(guard.indexOf('if (c.background) {') < guard.indexOf("throw uiError('error.operator.personOnlySpace')"), 'Inside the agent-context branch');
  assert.ok(main.indexOf("throw uiError('error.operator.personOnlySpace')") < main.indexOf("const answer = await showDialog(c, 'message', { type: 'warning', message: name"), 'Refused before the generic confirmation');
  assert.equal(locale.format('en', 'error.operator.personOnlySpace'), 'Only you can choose the space in a grant; NAW itself records where a new session went.');
  // And only a person's window runs the placement step.
  assert.equal(main.split('placeOpened(').length, 4, 'Its definition, the state listener and its own retry timer: no other caller');
  assert.ok(main.includes('if (!context.background) placeOpened(client, data).catch(() => {});'));
});

test('the opened record is keyed by the session: a repeat, another outcome or a restart writes nothing more', async t => {
  const f = await fixture(t), opened = { sessionId: 'new-session', name: 'Opened', initiator: 'Lead', initiatorId: f.id };
  const before = f.roomState.metadata(f.space).revision;
  assert.deepEqual(f.roomState.recordOpened(f.space, { ...opened, joined: true }), { recorded: true, joined: true });
  assert.equal(f.roomState.metadata(f.space).revision, before + 1, 'One write');
  assert.deepEqual(f.roomState.recordOpened(f.space, { ...opened, joined: false }), { recorded: false, joined: true });
  assert.equal(f.roomState.queueItems(f.space).length, 0);
  assert.deepEqual(new RoomState(path.dirname(f.roomState.file)).recordOpened(f.space, { ...opened, joined: true }), { recorded: false, joined: true }, 'After the desktop restarts');
});
