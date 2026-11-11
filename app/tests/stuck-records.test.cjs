// B6 step 1, checkpoint B (E4): a session that stays stuck is recorded in its spaces, once, and once
// more when it no longer is. Stuck here means an interrupt the native side has not confirmed, or a
// permission request nobody answered, for five minutes (or more requests than can be shown).
// The backend only marks the session; the desktop only writes the record. Zero model.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto'), { EventEmitter } = require('node:events');
const { Claude } = require('../adapters.cjs'), { Workspace } = require('../workspace.cjs'), { SubmissionChannel } = require('../claude-submit.cjs');
const { RoomState } = require('../room-state.cjs'), locale = require('../ui-locale.js');

const START = Date.UTC(2026, 10, 10, 20, 0), MINUTE = 60000, LIMIT = 5 * MINUTE;
function backend(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-stuck-backend-')), w = new Workspace({ binaries: {}, close() {} }, dir);
  const r = Object.create(Claude.prototype); EventEmitter.call(r);
  r.record = { nativeId: randomUUID() }; r.terminal = { alive: true, keys: [], input(key) { this.keys.push(key); } };
  r.submission = new SubmissionChannel(); r.bindRoot({ sessionId: r.record.nativeId });
  const s = r.record; Object.assign(s, { id: 'synthetic', name: 'Synthetic', owner: 'window', view: 'chat', controlRevision: 0, memberRevision: 0, provider: 'claude', messages: [], fleet: [], state: 'working' });
  w.sessions.set(s.id, s); w.runtimes.set(s.id, r); w.bind(s, r);
  r.nativeAbortAvailable = false; r.rootTurn = { id: 'native-turn', status: 'working' }; r.ready = true; r.chatAvailable = true;
  let changes = 0; w.on('change', () => { changes += 1; });
  t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const marks = () => w.snapshot().sessions.find(session => session.id === s.id).stuck;
  return { w, r, s, dir, marks, changes: () => changes, tick: ms => t.mock.timers.tick(ms) };
}

test('E4 backend: an interrupt that has not taken effect is marked after five minutes, by one state change and no other timer', async t => {
  const f = backend(t);
  f.r.emit('fleet', { event: 'SubagentStart', id: 'agent-1', name: 'general-purpose' });
  await f.w.interrupt(f.s.id, 'window');
  assert.equal(f.s.activityUiMessage.key, 'notice.activity.interruptWaitsForSubagent');
  assert.equal(f.marks(), undefined, 'Not stuck yet');
  const before = f.changes();
  f.tick(LIMIT - 1);
  assert.equal(f.marks(), undefined); assert.equal(f.changes(), before, 'Nothing is sent before the limit');
  f.tick(1);
  assert.equal(f.changes(), before + 1, 'One state change at the limit');
  const [mark] = f.marks();
  assert.deepEqual({ kind: mark.kind, since: mark.since, key: mark.key }, { kind: 'interrupt', since: START, key: `stuck:synthetic:interrupt:${START}` });
  assert.equal(mark.held.key, 'notice.activity.interruptWaitsForSubagent'); assert.equal(mark.held.params.name, 'general-purpose');
  f.tick(60 * MINUTE);
  assert.equal(f.changes(), before + 1, 'No periodic check follows');
  assert.equal(f.marks().length, 1);
  assert.deepEqual(f.r.terminal.keys, ['\x1b'], 'Nothing was sent to the session because of it');
});

test('E4 backend: the timer firing is what makes the wait due, even when the wall clock reads a moment short', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const realNow = Date.now; let clock = START; Date.now = () => clock; t.after(() => { Date.now = realNow; });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-stuck-clock-')), w = new Workspace({ binaries: {}, close() {} }, dir);
  t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const s = { id: 'synthetic', name: 'Synthetic', provider: 'codex', state: 'approval', messages: [], fleet: [], approvals: [{ requestId: 'r', params: {} }] };
  w.sessions.set(s.id, s); w.runtimes.set(s.id, {}); let changes = 0; w.on('change', () => { changes += 1; });
  w.noteWait(s, 'approval');
  clock = START + LIMIT - 1;
  t.mock.timers.tick(LIMIT);
  assert.equal(changes, 1, 'The state change is sent although the clock says one millisecond is missing');
  assert.deepEqual(w.snapshot().sessions[0].stuck, [{ kind: 'approval', since: START, key: `stuck:synthetic:approval:${START}` }]);
});

test('E4 backend: a later tool or status notice does not end an interrupt wait; the native interrupt or the end of the turn does', async t => {
  const f = backend(t);
  await f.w.interrupt(f.s.id, 'window');
  f.tick(MINUTE);
  f.r.emit('activity', 'Bash', undefined);
  assert.equal(f.s.activityUiMessage, undefined, 'The interrupt notice was replaced, as a running root tool does');
  f.tick(4 * MINUTE);
  assert.deepEqual(f.marks().map(mark => mark.since), [START], 'Still waiting, and marked on time');
  f.r.emit('activity', 'Read', undefined);
  assert.equal(f.marks().length, 1, 'A notice after the mark is not its end');
  // This session has no native turn identity, so the native interrupt is what ends the wait.
  f.r.emit('interrupted', {});
  assert.equal(f.marks(), undefined); assert.equal(f.w.stuckWaits.size, 0);
  // The next interrupt is a new wait; the end of its turn ends it.
  f.s.state = 'working'; f.tick(MINUTE);
  await f.w.interrupt(f.s.id, 'window'); f.tick(LIMIT);
  assert.deepEqual(f.marks().map(mark => mark.since), [START + 6 * MINUTE]);
  f.r.emit('state', 'idle');
  assert.equal(f.marks(), undefined); assert.equal(f.w.stuckWaits.size, 0);
});

test('E4 backend: with a native turn identity the wait follows that turn: a completion reported while it goes on does not end it, the next turn does', async t => {
  const f = backend(t);
  f.r.liveTurn = { id: 'turn-1' };
  await f.w.interrupt(f.s.id, 'window');
  assert.equal(f.w.stuckWaits.get('synthetic:interrupt').turn, 'turn-1');
  f.tick(LIMIT);
  assert.equal(f.marks().length, 1);
  // A blocking stop hook, or a late report for an earlier turn: the turn itself is still the current one.
  f.r.emit('interrupted', {});
  assert.equal(f.marks().length, 1, 'Still the same turn, still waiting');
  f.r.liveTurn = { id: 'turn-2' };
  f.r.emit('activity', 'Bash', undefined);
  assert.equal(f.marks(), undefined, 'A different turn is not the one that was interrupted');
  assert.equal(f.w.stuckWaits.size, 0);
  f.tick(10 * MINUTE);
  assert.equal(f.marks(), undefined, 'The new turn never inherits the wait');
});

test('E4 backend: a turn that began while the native side was being asked is not waiting on that interrupt', async t => {
  const f = backend(t);
  f.r.liveTurn = { id: 'turn-1' };
  f.r.interrupt = async () => { f.r.liveTurn = { id: 'turn-2' }; };
  await f.w.interrupt(f.s.id, 'window');
  assert.equal(f.w.stuckWaits.size, 0);
  f.tick(10 * MINUTE);
  assert.equal(f.marks(), undefined);
});

test('E4 backend: a second interrupt during the same wait keeps the first time; a turn nobody interrupted is never marked', async t => {
  const f = backend(t);
  await f.w.interrupt(f.s.id, 'window');
  f.tick(3 * MINUTE);
  await f.w.interrupt(f.s.id, 'window');
  f.tick(2 * MINUTE);
  assert.deepEqual(f.marks().map(mark => mark.since), [START], 'Five minutes from the first interrupt, not the second');
  f.r.emit('state', 'idle');
  assert.equal(f.marks(), undefined);
  assert.equal(f.w.stuckWaits.size, 0, 'The wait is forgotten with the change that ended it');
  f.r.emit('state', 'working');
  f.tick(10 * MINUTE);
  assert.equal(f.marks(), undefined, 'Working for long is not being stuck');
});

test('E4 backend: a wait that ends before the limit is never marked, and its timer sends nothing', async t => {
  const f = backend(t);
  await f.w.interrupt(f.s.id, 'window');
  f.tick(MINUTE);
  f.r.emit('state', 'idle');
  const before = f.changes();
  f.tick(10 * MINUTE);
  assert.equal(f.changes(), before); assert.equal(f.marks(), undefined);
});

test('E4 backend: an interrupt the native side confirms starts no wait', async t => {
  const f = backend(t);
  f.r.interrupt = async () => ({ interrupted: true });
  await f.w.interrupt(f.s.id, 'window');
  assert.equal(f.w.stuckWaits.size, 0);
  f.tick(10 * MINUTE);
  assert.equal(f.marks(), undefined);
});

test('E4 backend: a Claude permission prompt the bridge reports is marked after five minutes and ends the moment it is answered', async t => {
  const f = backend(t), prompt = () => { f.r.livePermissions = new Map([['permission:1', { id: 'permission:1', title: 'Bash', input: '' }]]); f.r.emit('state', 'approval'); };
  prompt();
  assert.equal(f.s.approval ?? null, null, 'Claude gives the backend no request object');
  assert.ok(f.r.nativeApproval, 'The adapter itself says a prompt is open');
  f.tick(LIMIT - 1);
  assert.equal(f.marks(), undefined);
  f.tick(1);
  assert.deepEqual(f.marks(), [{ kind: 'approval', since: START, key: `stuck:synthetic:approval:${START}` }]);
  // Answered: the bridge ends the prompt. The mark goes with it, before any later state arrives.
  f.r.livePermissions.clear(); f.r.emit('activity', 'Bash', undefined);
  assert.equal(f.s.state, 'approval'); assert.equal(f.marks(), undefined); assert.equal(f.w.stuckWaits.size, 0);
  f.r.emit('state', 'working');
  // The next prompt is a new wait with its own time.
  f.tick(MINUTE); prompt(); f.tick(LIMIT);
  assert.deepEqual(f.marks().map(mark => mark.since), [START + 6 * MINUTE]);
});

test('E4 backend: the approval state without an open prompt is not a wait (no bridge, an approved command still running, a sign-in notice)', async t => {
  const f = backend(t);
  f.r.emit('state', 'approval');
  assert.equal(f.w.stuckWaits.size, 0);
  f.tick(30 * MINUTE);
  assert.equal(f.s.state, 'approval'); assert.equal(f.marks(), undefined, 'An approved build that runs for half an hour is not a session waiting for permission');
});

test('E4 backend: a Codex request counts from the first one still open and ends when resolved, before the state changes; one that does not block is not a wait', async t => {
  const f = backend(t);
  f.r.emit('approval', { requestId: 9, method: 'item/tool/requestUserInput', params: { isBlocking: false } });
  f.tick(10 * MINUTE);
  assert.equal(f.marks(), undefined, 'The session keeps working, so it is not stuck');
  f.r.emit('approval', { requestId: 1 }); f.r.emit('state', 'approval');
  f.tick(2 * MINUTE);
  f.r.emit('approval', { requestId: 2 });
  f.tick(3 * MINUTE);
  assert.deepEqual(f.marks().map(mark => mark.since), [START + 10 * MINUTE], 'Counted from the first blocking request');
  f.r.emit('approvalResolved', 1);
  assert.equal(f.marks().length, 1, 'One blocking request is still open');
  f.r.emit('approvalResolved', 2);
  assert.equal(f.s.state, 'approval', 'Codex has not reported a new status yet');
  assert.equal(f.marks(), undefined, 'Nothing blocking is open any more'); assert.equal(f.w.stuckWaits.size, 0);
});

test('E4 backend: a Codex request left by a backend that exited, or by a turn that is over, is not an open prompt', async t => {
  for (const [label, leave] of [
    ['the backend exited', f => { f.r.backendExitConfirmed = true; f.r.emit('state', 'error'); }],
    ['the transport is gone', f => { f.r.transportDisconnected = true; f.r.emit('activity', 'x', undefined); }],
    ['the turn is over', f => f.r.emit('state', 'idle')],
  ]) {
    const f = backend(t);
    f.r.emit('approval', { requestId: 1 }); f.r.emit('state', 'approval');
    f.tick(LIMIT);
    assert.equal(f.marks().length, 1, label);
    leave(f);
    // The request object is still listed: nothing resolved it.
    f.s.approvals = [{ requestId: 'left-behind', params: {} }];
    f.r.emit('activity', 'y', undefined);
    assert.equal(f.marks(), undefined, label); assert.equal(f.w.stuckWaits.size, 0, label);
    f.tick(30 * MINUTE);
    assert.equal(f.marks(), undefined, label);
    t.mock.timers.reset();
  }
});

test('E4 backend: more permission requests than can be shown are marked at once', async t => {
  const f = backend(t);
  for (let id = 1; id <= 200; id += 1) f.r.emit('approval', { requestId: id, method: 'item/tool/requestUserInput', params: { isBlocking: false } });
  assert.equal(f.marks(), undefined);
  f.r.emit('approval', { requestId: 201, method: 'item/tool/requestUserInput', params: { isBlocking: false } });
  assert.equal(f.s.approvalOverflow, true);
  assert.deepEqual(f.marks(), [{ kind: 'approval', since: START, key: `stuck:synthetic:approval:${START}` }]);
});

test('E4 backend: closing clears the timers, and a restarted backend has nothing pending to mark', async t => {
  const f = backend(t);
  await f.w.interrupt(f.s.id, 'window'); f.r.emit('approval', { requestId: 1 });
  assert.equal(f.w.stuckWaits.size, 2);
  f.tick(LIMIT);
  assert.deepEqual(f.marks().map(mark => mark.kind), ['interrupt', 'approval'], 'Both waits are marked, each with its own key');
  f.w.close();
  assert.equal(f.w.stuckWaits.size, 0);
  const again = new Workspace({ binaries: {}, close() {} }, f.dir);
  t.after(() => again.close());
  const restored = again.snapshot().sessions.find(session => session.id === 'synthetic');
  assert.equal(restored.state, 'recoverable'); assert.equal(restored.approval, null);
  assert.equal(restored.stuck, undefined); assert.equal(again.stuckWaits.size, 0);
});

function desk(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-stuck-desk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = new RoomState(dir), other = state.create('Other synthetic space'), unrelated = state.create('Unrelated synthetic space');
  const mark = (kind, since = START, held) => ({ kind, since, key: `stuck:member:${kind}:${since}`, ...(held ? { held } : {}) });
  const member = (extra = {}) => ({ id: 'member', name: 'Native name', roomIds: ['shared', other], state: 'working', ...extra });
  const label = session => session.id === 'member' ? 'Member' : session.name;
  const facts = (id, source = state) => source.metadata(id).events.filter(event => event.monitor);
  return { dir, state, other, unrelated, mark, member, label, facts, reopen: () => new RoomState(dir) };
}

test('E4 record: a stuck interrupt is written once in each space the session belongs to, with who holds it and for how long', t => {
  const f = desk(t), held = { key: 'notice.activity.interruptWaitsForSubagent', params: { name: 'general-purpose', since: '20:00', count: 2 } };
  const sessions = [f.member({ stuck: [f.mark('interrupt', START, held)] }), { id: 'bystander', name: 'Bystander', roomIds: [f.unrelated], state: 'idle' }];
  assert.equal(f.state.recordStuck(sessions, f.label, START + LIMIT), true);
  for (const id of ['shared', f.other]) {
    const [event] = f.facts(id);
    assert.equal(f.facts(id).length, 1);
    assert.deepEqual(event.monitor, { kind: 'stuck', key: `stuck:member:interrupt:${START}`, cause: 'interrupt', sessionId: 'member', since: START });
    assert.equal(event.kind, 'monitor'); assert.equal(event.sessionId, 'member'); assert.equal(event.role, 'system');
    assert.equal(event.text, 'Member 的中断等了 5 分钟还没生效：后台子 agent「general-purpose」还在运行（共 2 个）');
    assert.equal(locale.format('en', event.uiMessage.key, event.uiMessage.params), 'Member: the interrupt has not taken effect after 5 min. Background sub-agent “general-purpose” is still running (2 in all)');
  }
  assert.equal(f.facts(f.unrelated).length, 0, 'A space the session is not in records nothing');
  assert.equal(f.state.recordStuck(sessions, f.label, START + LIMIT + 1000), false, 'The same mark again, from another window or a later state, is not a second record');
  assert.equal(f.reopen().recordStuck(sessions, f.label, START + 2 * LIMIT), false, 'Nor after the desktop restarts');
  assert.equal(f.facts('shared', f.reopen()).length, 1);
});

test('E4 record: the other causes have their own words', t => {
  for (const [session, zh, en] of [
    [{ stuck: [{ kind: 'interrupt' }], held: { key: 'notice.activity.interruptWaitsForBackground', params: { count: 3 } } },
      'Member 的中断等了 7 分钟还没生效：还有 3 项原生后台任务在运行', 'Member: the interrupt has not taken effect after 7 min. Native background work still running: 3'],
    [{ stuck: [{ kind: 'interrupt' }], held: { key: 'notice.activity.interruptRequested' } },
      'Member 的中断等了 7 分钟还没生效', 'Member: the interrupt has not taken effect after 7 min'],
    // The session's own status line may show something else by now; only what the backend marked is used.
    [{ stuck: [{ kind: 'interrupt' }], activityUiMessage: { key: 'notice.activity.interruptWaitsForSubagent', params: { name: 'stale', count: 9 } } },
      'Member 的中断等了 7 分钟还没生效', 'Member: the interrupt has not taken effect after 7 min'],
    [{ stuck: [{ kind: 'interrupt' }], held: { key: 'notice.activity.interruptWaitsForSubagent', params: { name: 'long '.repeat(40) + '\nsecond line', count: 'many' } } },
      'Member 的中断等了 7 分钟还没生效：后台子 agent「' + ('long '.repeat(40) + 'second line').slice(0, 79) + '…」还在运行（共 1 个）', null],
    [{ stuck: [{ kind: 'approval' }], state: 'approval' }, 'Member 等原生确认已经 7 分钟', 'Member has waited 7 min for a native confirmation'],
    [{ stuck: [{ kind: 'approval' }], approvalOverflow: true },
      'Member 等确认的原生请求超过了上限，后面的没有显示', 'Member has more native requests waiting for confirmation than can be shown'],
  ]) {
    const f = desk(t), kind = session.stuck[0].kind, { held, ...fields } = session;
    f.state.recordStuck([f.member({ ...fields, stuck: [f.mark(kind, START, held)] })], f.label, START + 7 * MINUTE);
    const [event] = f.facts('shared');
    assert.equal(event.text, zh); if (en) assert.equal(locale.format('en', event.uiMessage.key, event.uiMessage.params), en);
    assert.equal(event.monitor.cause, kind);
  }
});

test('E4 record: when the mark is gone the end is written once, with the whole time; a session missing from the state ends nothing', t => {
  const f = desk(t), stuck = [f.member({ stuck: [f.mark('interrupt'), f.mark('approval')], approval: { requestId: 'r' } })];
  f.state.recordStuck(stuck, f.label, START + LIMIT);
  assert.equal(f.facts('shared').length, 2, 'An interrupt and a permission request are two records');
  assert.equal(f.state.recordStuck([{ id: 'someone-else', name: 'Else', roomIds: ['shared'] }], f.label, START + 20 * MINUTE), false,
    'Its backend may only be disconnected');
  const stillApproval = [f.member({ stuck: [f.mark('approval')], approval: { requestId: 'r' } })];
  assert.equal(f.state.recordStuck(stillApproval, f.label, START + 47 * MINUTE), true);
  for (const id of ['shared', f.other]) {
    const ended = f.facts(id).filter(event => event.monitor.kind === 'stuck-ended');
    assert.equal(ended.length, 1);
    assert.deepEqual(ended[0].monitor, { kind: 'stuck-ended', key: `stuck:member:interrupt:${START}`, cause: 'interrupt', sessionId: 'member', since: START, ended: START + 47 * MINUTE });
    assert.equal(ended[0].text, 'Member 不再等中断生效（共等了 47 分钟）');
    assert.equal(locale.format('en', ended[0].uiMessage.key, ended[0].uiMessage.params), 'Member no longer waits for the interrupt (47 min in all)');
  }
  assert.equal(f.state.recordStuck(stillApproval, f.label, START + 48 * MINUTE), false);
  // After a restart of the desktop the open mark is rebuilt from the records, and its end is still written once.
  const later = f.reopen();
  assert.equal(later.recordStuck([f.member()], f.label, START + 60 * MINUTE), true);
  const ends = later.metadata().events.filter(event => event.monitor?.kind === 'stuck-ended');
  assert.deepEqual(ends.map(event => event.monitor.cause), ['interrupt', 'approval']);
  assert.equal(ends[1].text, 'Member 不再等原生确认（共等了 60 分钟）');
  assert.equal(locale.format('en', ends[1].uiMessage.key, ends[1].uiMessage.params), 'Member no longer waits for a native confirmation (60 min in all)');
  assert.equal(later.recordStuck([f.member()], f.label, START + 61 * MINUTE), false);
  assert.equal(f.reopen().recordStuck([f.member()], f.label, START + 62 * MINUTE), false);
});

test('E4 record: a session in no space, an archived space, a mark that is not the backend\'s shape, or an older backend records nothing', t => {
  const f = desk(t);
  assert.equal(f.state.recordStuck([f.member({ roomIds: [], stuck: [f.mark('interrupt')] })], f.label, START + LIMIT), false, 'Nowhere to record');
  f.state.update({ archived: true }, undefined, f.other);
  assert.equal(f.state.recordStuck([f.member({ roomIds: [f.other], stuck: [f.mark('interrupt')] })], f.label, START + LIMIT), false, 'An archived space is left alone');
  for (const stuck of [
    [{ kind: 'interrupt', since: START, key: `stuck:another:interrupt:${START}` }], [{ kind: 'version', since: START, key: `stuck:member:version:${START}` }],
    [{ kind: 'interrupt', since: 'now', key: 'stuck:member:interrupt:now' }], [null], 'stuck', { kind: 'interrupt' },
  ]) assert.equal(f.state.recordStuck([f.member({ stuck })], f.label, START + LIMIT), false, JSON.stringify(stuck));
  assert.equal(f.state.recordStuck([f.member()], f.label, START + LIMIT), false, 'A backend without the field');
  for (const value of [undefined, null, 'sessions', {}]) assert.equal(f.state.recordStuck(value, f.label), false);
  assert.equal(f.state.recordStuck([f.member({ roomIds: 'shared', stuck: [f.mark('interrupt')] })], f.label, START + LIMIT), false, 'Unreadable membership');
  for (const id of ['shared', f.other, f.unrelated]) assert.equal(f.facts(id).length, 0);
});

test('E4 record: a space that is busy when the mark arrives, or when the wait ends, gets its record at the next state, once', t => {
  const f = desk(t), stuck = [f.member({ stuck: [f.mark('interrupt')] })];
  const writable = f.state.writable.bind(f.state); let busy = true;
  f.state.writable = id => { if (busy && id === f.other) throw Error('Synthetic busy space'); return writable(id); };
  assert.equal(f.state.recordStuck(stuck, f.label, START + LIMIT), true, 'The shared space got the mark');
  assert.equal(f.facts(f.other).length, 0);
  assert.equal(f.state.recordStuck(stuck, f.label, START + LIMIT + 1000), false, 'Still busy: nothing new, and no second record in the shared space');
  busy = false;
  assert.equal(f.state.recordStuck(stuck, f.label, START + LIMIT + 2000), true, 'The busy space gets the mark at the next state');
  assert.equal(f.facts(f.other).length, 1); assert.equal(f.facts('shared').length, 1);
  assert.equal(f.state.recordStuck(stuck, f.label, START + LIMIT + 3000), false);
  busy = true;
  assert.equal(f.state.recordStuck([f.member()], f.label, START + 10 * MINUTE), true, 'The shared space got its end');
  assert.equal(f.facts(f.other).filter(event => event.monitor.kind === 'stuck-ended').length, 0);
  busy = false;
  assert.equal(f.state.recordStuck([f.member()], f.label, START + 11 * MINUTE), true, 'The busy space gets it at the next state');
  assert.equal(f.facts(f.other).filter(event => event.monitor.kind === 'stuck-ended').length, 1);
  assert.equal(f.facts('shared').filter(event => event.monitor.kind === 'stuck-ended').length, 1);
  assert.equal(f.state.recordStuck([f.member()], f.label, START + 12 * MINUTE), false);
});

test('E4 wiring: the desktop records from every backend state and only then refreshes the space, and it does nothing else there', () => {
  const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
  const start = main.indexOf("// B6 E4: what the backend marks as stuck"), end = main.indexOf("client.on('terminal'", start);
  assert.ok(start > 0 && end > start, 'The listener exists');
  const block = main.slice(start, end);
  assert.ok(block.includes("client.on('state', data => {"));
  assert.ok(block.includes("const name = s => sessionLabels.labels.get(s.id) || s.name, wrote = ['recordStuck', 'recordVersionGates'].map(writer => { try { return roomState[writer](data?.sessions, name); } catch { return false; } });"));
  assert.ok(block.includes('if (wrote.some(Boolean)) broadcastRoom().catch(() => {});'));
  assert.equal(main.split("'recordStuck'").length, 2, 'One call site');
  for (const forbidden of ['Notification', 'interrupt(', 'approve', 'send(', 'queueAdd']) assert.equal(block.includes(forbidden), false, forbidden);
});
