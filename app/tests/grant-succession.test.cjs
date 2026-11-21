// B5 prerequisite: the person's creation grant follows a session NAW replaced, along the one
// unambiguous successor and no further. Nothing is widened: the same grant, the same counts, the
// same expiry, a revoke that stays a revoke. Zero model: a real backend journal, a real space
// store, the real log rule from queue-secretary.cjs and the step from main.cjs. The rotation log
// lines have the shape QueueDispatcher.appendLog writes (queue-dispatch.cjs).
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events'), { randomUUID } = require('node:crypto');
const { Workspace } = require('../workspace.cjs'), { RoomState } = require('../room-state.cjs');
const { tools } = require('../operator-control.cjs'), locale = require('../ui-locale.js'), spaces = require('../collaboration-spaces.cjs');
const { follow } = require('../queue-secretary.cjs');
const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
const hostFor = () => ({ binaries: {}, close() {}, create(s) {
  const r = new EventEmitter(); r.record = s; s.nativeId ||= randomUUID(); r.operatorAvailable = true; r.chatAvailable = true;
  r.liveTurn = { id: 'turn-' + s.id, promptId: 'prompt-' + s.id };
  r.start = async () => { r.emit('model', 'fixture-native-model'); r.emit('state', 'idle'); };
  r.send = async (text, tag) => { r.emit('submitted', tag); };
  r.stop = async () => ({ state: 'ended' });
  return r;
} });

async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-grant-succession-')));
  const w = new Workspace(hostFor(), root), id = await w.create('claude', root, 'owner', 'Lead');
  const desk = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-grant-desk-'));
  t.after(() => { w.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(desk, { recursive: true, force: true }); });
  w.get(id).nativePermissionMode = 'default';
  w.operatorAction(null, 'enabled', true); w.operatorAction(id, 'enabled', true);
  const roomState = new RoomState(desk), space = roomState.create('Synthetic work space');
  const logFile = path.join(desk, 'rotation-log.jsonl');
  const calls = [], follows = []; let broadcasts = 0, backendFails = 0, recordFails = 0, clock = Date.now();
  const client = { snapshot: () => w.snapshot(), call: async (method, ...args) => {
    if (method !== 'operatorAction' || args[1] !== 'succession') throw Error('Unexpected backend call ' + method + ' ' + args[1]);
    calls.push(args[2].step);
    if (backendFails > 0) { backendFails -= 1; throw Error('Synthetic backend failure'); }
    return w.operatorAction(...args);
  } };
  const record = roomState.recordCarried.bind(roomState);
  let deadRoom = null;
  roomState.recordCarried = (...args) => { if (args[0] === deadRoom) throw Error('Synthetic unusable space'); if (recordFails > 0) { recordFails -= 1; throw Error('Synthetic busy space'); } return record(...args); };
  const start = main.indexOf('const grantCarrying = new Set()'), end = main.indexOf('function auditBackgroundOperation(record) {');
  assert.ok(start > 0 && end > start, 'The carrying step exists in main.cjs');
  const desktop = () => {
    const sandbox = { fs, path, dataDir: desk, roomState, roomIds: spaces.roomIds, sessionLabels: { labels: new Map() }, broadcastRoom: async () => { broadcasts += 1; },
      followRotation: (...args) => { follows.push(args[1].sessionId); return follow(...args); } };
    vm.createContext(sandbox); vm.runInContext(main.slice(start, end) + '\nthis.carryGrants = carryGrants;', sandbox);
    return sandbox;
  };
  let sandbox = desktop();
  const grant = (extra = {}) => w.operatorAction(id, 'grant', { providers: ['claude'], directories: [root], permission: 'default', daily: 2, concurrent: 5, expiresAt: Date.now() + 3600000, ...extra });
  const identity = sessionId => { const s = w.get(sessionId), r = w.runtimes.get(sessionId); return { nativeId: s.nativeId, turnId: r.liveTurn.id, promptId: r.liveTurn.promptId, callId: randomUUID() }; };
  const open = (sessionId, extra = {}) => w.runtimes.get(sessionId).operatorCall(identity(sessionId), 'workspace_open',
    { action_id: randomUUID(), provider: 'claude', cwd: root, name: 'Opened', task: 'Synthetic first task', permission: 'default', ...extra });
  // A session the holder opened reports back, as its own root turn would.
  const report = (helper, body = 'Still working') => {
    const dispatch = Object.values(w.operator.data.dispatches).find(d => d.executorId === helper);
    return w.runtimes.get(helper).operatorCall(identity(helper), 'workspace_report', { request_id: dispatch.requestId, dispatch_id: dispatch.id, state: 'progress', body });
  };
  // One line of the rotation log, as QueueDispatcher.appendLog writes it. A replacement is logged after the
  // holder's interface was turned on, as a real one is.
  const logged = (event, old, next, at = Date.now() + 1) => fs.appendFileSync(logFile, JSON.stringify({ time: at, event, spaces: [space],
    old: { id: old.id, nativeId: old.nativeId, name: old.name }, new: next ? { id: next.id, nativeId: next.nativeId, name: next.name } : null }) + '\n', { mode: 0o600 });
  // What NAW's replacement does to the backend: a new session in the old one's space, and the old one stopped.
  const successor = async (name = 'Lead · 续') => {
    const next = await w.create('claude', root, 'owner', name); w.get(next).nativePermissionMode = 'default';
    Object.assign(w.get(next), spaces.withPlacement(w.get(next), space));
    return next;
  };
  const replace = async (of = id, event = 'done', name) => {
    const next = await successor(name); if (event === 'done') await w.stop(of);
    logged(event, w.get(of), w.get(next)); return next;
  };
  // The desktop's clock: never behind the real one, and moved on by the test where it waits.
  const carry = (snapshot = w.snapshot(), advance = 0) => { clock = Math.max(clock, Date.now()) + advance; return sandbox.carryGrants(client, snapshot, clock); };
  const records = (room = space) => roomState.metadata(room).events.filter(event => event.monitor?.kind === 'carried');
  const grants = () => JSON.stringify(w.operator.data.domains);
  return { w, id, root, desk, roomState, space, logFile, client, calls, follows, grant, open, report, logged, successor, replace, carry, records, grants,
    counts: () => ({ broadcasts }), failBackend: n => { backendFails = n; }, failRecords: n => { recordFails = n; }, failRoom: room => { deadRoom = room; }, restartDesktop: () => { sandbox = desktop(); } };
}
const text = (event, language = 'zh') => locale.format(language, event.uiMessage.key, event.uiMessage.params);
const listed = f => f.w.snapshot().operatorPolicy.successions;
const pair = (f, old, next, loggedAt = Date.now() + 1) => ({ step: 'carry', nativeId: f.w.get(old).nativeId, to: { id: next, nativeId: f.w.get(next).nativeId }, loggedAt });
test('a human quota change follows the same grant and reservation counts to the confirmed successor', async t => {
  const f = await fixture(t), id = f.grant({ daily: 8, concurrent: 6 }); await f.open(f.id);
  const original = structuredClone(f.w.operator.data.domains[id]);
  f.w.operatorAction(f.id, 'quota', { domainId: id, daily: 16, concurrent: 6, revision: 0, nativeId: f.w.get(f.id).nativeId, consent: true });
  const next = await f.replace(); await f.carry();
  const domain = f.w.operator.policy().domains.find(d => d.id === id);
  assert.deepEqual(domain.initiators, [{ id: next, nativeId: f.w.get(next).nativeId }]);
  assert.deepEqual([domain.daily, domain.concurrent, domain.quotaRevision, domain.expiresAt, domain.createdAt, domain.usage.usedToday, domain.usage.concurrent],
    [16, 6, 1, original.expiresAt, original.createdAt, 1, 1]);
  assert.throws(() => f.w.operatorAction(f.id, 'quota', { domainId: id, daily: 32, concurrent: 6, revision: 1, nativeId: f.w.get(f.id).nativeId, consent: true }), /changed|holder/);
  f.w.operatorAction(next, 'quota', { domainId: id, daily: 4, concurrent: 2, revision: 1, nativeId: f.w.get(next).nativeId, consent: true });
  assert.equal((await f.open(next)).status, 'created'); await assert.rejects(f.open(next), /quota/);
  assert.equal(f.w.operator.policy().domains.find(d => d.id === id).usage.concurrent, 2);
});

test('a holder NAW replaced: its successor opens under the same grant with no new approval, and what the old session opened still counts', async t => {
  const f = await fixture(t), grantId = f.grant();
  const first = await f.open(f.id); assert.equal(first.status, 'created'); assert.equal(first.domainId, grantId);
  assert.deepEqual(listed(f), [], 'A running holder is not listed');
  const next = await f.replace();
  assert.deepEqual(listed(f), [{ id: f.id, nativeId: f.w.get(f.id).nativeId }]);
  // Before the desktop's step the successor has nothing: this is what a replacement cost until now.
  await assert.rejects(async () => f.open(next), /has not enabled this initiator interface/);
  await f.carry();
  const sessions = f.w.snapshot().sessions;
  assert.equal(sessions.find(s => s.id === next).operatorEnabled, true); assert.equal(sessions.find(s => s.id === f.id).operatorEnabled, false, 'One holder');
  const domain = f.w.operator.data.domains[grantId];
  assert.deepEqual(domain.initiators, [{ id: next, nativeId: f.w.get(next).nativeId }]);
  assert.equal(domain.revokedAt, undefined); assert.equal(Object.keys(f.w.operator.data.domains).length, 1, 'The same grant, not a new one');
  const second = await f.open(next);
  assert.equal(second.status, 'created', 'No new approval'); assert.equal(second.domainId, grantId);
  // Two a day: one by the old session, one by its successor. The third stops, as it would have for the old session.
  await assert.rejects(async () => f.open(next), /quota is exhausted/);
  assert.deepEqual(listed(f), [], 'Decided and told: no longer listed'); assert.deepEqual(f.calls, ['carry', 'told']);
  const [record] = f.records(), outcome = f.w.operator.data.sessions[f.id].succession; assert.equal(f.records().length, 1);
  assert.deepEqual(outcome, { at: outcome.at, carried: true, to: { id: next, nativeId: f.w.get(next).nativeId }, told: true });
  assert.deepEqual(record.monitor, { kind: 'carried', key: `carried:${f.id}:${outcome.at}`, oldId: f.id, newId: next, carried: true, grants: 1 });
  assert.equal(text(record), 'Lead 换会话后，你给它的 agent 控制接口许可和建会话授权由 Lead · 续 接续；额度和到期时间不变');
  assert.equal(text(record, 'en'), 'After Lead was replaced, Lead · 续 holds the agent control interface permission and the session-creation grants you gave it; quotas and expiry are unchanged');
  const audit = f.w.operator.data.audit.find(entry => entry.tool === 'operator_succession');
  assert.equal(audit.result, 'carried'); assert.equal(audit.by, 'desktop'); assert.equal(audit.callerId, f.id); assert.equal(audit.targetId, next); assert.deepEqual(audit.domains, [grantId]);
  assert.equal(f.counts().broadcasts, 1);
});

test('it is the same grant: the space it names goes with it, and what the old session had started still counts under it', async t => {
  const f = await fixture(t), grantId = f.grant({ space: f.space });
  const helper = (await f.open(f.id)).sessionId;
  assert.equal(f.w.snapshot().operatorPolicy.placements.length, 1, 'The old session\'s new session waits to join the named space');
  assert.equal((await f.report(helper)).status, 'saved');
  const next = await f.replace(); await f.carry();
  assert.equal(f.w.operator.data.domains[grantId].space, f.space, 'The named space is unchanged');
  // The session the old holder opened is still placed, and still reports: the grant is in force, only its holder changed.
  assert.deepEqual(f.w.snapshot().operatorPolicy.placements.map(p => p.sessionId), [helper]);
  assert.equal((await f.report(helper, 'After the replacement')).status, 'saved');
  const later = (await f.open(next)).sessionId;
  assert.deepEqual(f.w.snapshot().operatorPolicy.placements.map(p => [p.sessionId, p.space]), [[helper, f.space], [later, f.space]]);
  // Turned off by the person, it all ends, for what the old session started too.
  f.w.operatorAction(next, 'enabled', false);
  assert.deepEqual(f.w.snapshot().operatorPolicy.placements, []);
  await assert.rejects(async () => f.report(helper, 'After the person turned it off'), /revoked or expired|not eligible|no longer/i);
  // The same when it is the old session the person turns off after the carry: the grant that went on from it is
  // revoked, so nothing the old session started under it goes on either.
  const g = await fixture(t), other = g.grant({ space: g.space });
  const started = (await g.open(g.id)).sessionId;
  await g.replace(); await g.carry();
  assert.deepEqual(g.w.snapshot().operatorPolicy.placements.map(p => p.sessionId), [started]);
  assert.equal((await g.report(started, 'Before the person turned the old session off')).status, 'saved');
  g.w.operatorAction(g.id, 'enabled', false);
  assert.ok(g.w.operator.data.domains[other].revokedAt);
  assert.deepEqual(g.w.snapshot().operatorPolicy.placements, []);
  await assert.rejects(async () => g.report(started, 'After the person turned the old session off'), /revoked or expired|not eligible|no longer/i);
});

test('nothing is widened by the move: beside a grant in force, a revoked grant stays revoked and an expired one expired, and a bypass session still needs a holder in bypass', async t => {
  const f = await fixture(t), live = f.grant(), revoked = f.grant(), expired = f.grant();
  f.w.operatorAction(f.id, 'revoke', revoked);
  f.w.operator.data.domains[expired].expiresAt = Date.now() - 1;
  const next = await f.replace(); await f.carry();
  assert.equal(f.records()[0].monitor.carried, true);
  // All three went with it as they were: the entry counts the one that is in force, and the other two are no more usable than before.
  assert.equal(f.records()[0].monitor.grants, 1); assert.equal(f.records()[0].uiMessage.key, 'notice.monitor.grantCarried');
  for (const grantId of [live, revoked, expired]) assert.deepEqual(f.w.operator.data.domains[grantId].initiators.map(i => i.id), [next]);
  assert.ok(f.w.operator.data.domains[revoked].revokedAt, 'Still revoked'); assert.ok(f.w.operator.data.domains[expired].expiresAt < Date.now(), 'Still expired');
  assert.equal((await f.open(next, { permission: 'bypass' })).status, 'pending-authorization', 'The holder is not in bypass');
  assert.equal((await f.open(next)).status, 'created', 'The grant in force covers an open, as it did for the old session');
  // With the one in force revoked too, neither of the others covers an open: the person is asked.
  f.w.operatorAction(next, 'revoke', live);
  assert.equal((await f.open(next)).status, 'pending-authorization', 'A revoked or expired grant that went on covers nothing');
});

// The person's decision of 2026-11-11: the agent control interface follows a replaced session only together
// with a grant in force. Without one the successor is an ordinary new session.
test('the interface does not go on by itself: a holder with no grant in force is not followed, its successor gets nothing, and nothing is said', async t => {
  for (const [label, prepare] of [
    ['no grant was ever given', () => {}],
    ['its only grant was revoked', f => { f.w.operatorAction(f.id, 'revoke', f.grant()); }],
    ['its only grant has run out', f => { const grantId = f.grant(); f.w.operator.data.domains[grantId].expiresAt = Date.now() - 1; }],
    ['one grant revoked and one run out', f => { f.w.operatorAction(f.id, 'revoke', f.grant()); const grantId = f.grant(); f.w.operator.data.domains[grantId].expiresAt = Date.now() - 1; }],
  ]) {
    const f = await fixture(t); prepare(f);
    const next = await f.replace(), journal = JSON.stringify(f.w.operator.data);
    assert.deepEqual(listed(f), [], label + ': the holder is not listed for a decision');
    await f.carry(); await f.carry(undefined, 31000);
    assert.equal(f.calls.length, 0, label + ': the desktop asks the journal nothing'); assert.equal(f.follows.length, 0, label + ': and does not read the rotation log for it');
    assert.equal(JSON.stringify(f.w.operator.data), journal, label + ': nothing is decided or saved');
    assert.equal(Object.hasOwn(f.w.operator.data.sessions, next), false, label + ': the successor has no interface setting');
    assert.ok(!f.w.snapshot().sessions.find(s => s.id === next).operatorEnabled, label + ': and is not shown as holding the interface');
    await assert.rejects(f.open(next), /has not enabled this initiator interface/, label + ': the successor cannot use the interface');
    assert.equal(f.records().length + f.records('shared').length, 0, label + ': nothing is said in any space');
    // Asked all the same, to carry or to refuse, the journal answers that there is no grant and saves nothing.
    assert.deepEqual(f.w.operatorAction(f.id, 'succession', pair(f, f.id, next)), { carried: false, reason: 'no-grant', saved: false }, label);
    assert.deepEqual(f.w.operatorAction(f.id, 'succession', { step: 'refuse', nativeId: f.w.get(f.id).nativeId, reason: 'ambiguous', loggedAt: Date.now() + 1 }), { carried: false, reason: 'no-grant', saved: false }, label);
    assert.equal(JSON.stringify(f.w.operator.data), journal, label + ': still nothing is saved, and no audit line is written');
    // The old session keeps the setting the person gave it; brought back, it is what it was.
    assert.equal(f.w.operator.data.sessions[f.id].enabled, true, label + ': the old session\'s own setting is untouched');
  }
  // A grant that runs out after the holder was listed and before the step: the journal checks again and carries nothing.
  const g = await fixture(t), late = g.grant(), heir = await g.replace(), state = g.w.snapshot();
  assert.deepEqual(state.operatorPolicy.successions, [{ id: g.id, nativeId: g.w.get(g.id).nativeId }], 'Listed while its grant is in force');
  g.w.operator.data.domains[late].expiresAt = Date.now() - 1;
  const before = JSON.stringify(g.w.operator.data);
  await g.carry(state);
  assert.deepEqual(g.calls, ['carry'], 'The desktop asked, from the earlier state');
  assert.equal(JSON.stringify(g.w.operator.data), before, 'and the journal carried nothing');
  assert.equal(Object.hasOwn(g.w.operator.data.sessions, heir), false); assert.equal(g.records().length, 0);
  // With a grant in force the interface goes on together with it: the narrowing takes nothing from that.
  const h = await fixture(t), kept = h.grant(), follower = await h.replace(); await h.carry();
  assert.equal(h.w.operator.data.sessions[follower].enabled, true); assert.deepEqual(h.w.operator.data.domains[kept].initiators.map(i => i.id), [follower]);
  assert.equal(h.w.operator.data.sessions[h.id].enabled, false, 'One holder: the old session no longer has the interface');
  assert.equal((await h.open(follower)).status, 'created');
});

test('a grant given to a session after it was replaced does not make that replacement one to follow: it stays with the old session, and nothing is said', async t => {
  // The interface on for two hours and no grant; replaced an hour ago; only now the person gives the old session a
  // grant (one it had asked for before it was replaced, approved late).
  const f = await fixture(t);
  f.w.operator.data.sessions[f.id].enabledAt = Date.now() - 7200000;
  const next = await f.successor(); await f.w.stop(f.id);
  const at = Date.now() - 3600000; f.logged('done', f.w.get(f.id), f.w.get(next), at);
  assert.deepEqual(listed(f), [], 'No grant: not listed');
  const late = f.grant(), journal = JSON.stringify(f.w.operator.data);
  assert.deepEqual(listed(f), [{ id: f.id, nativeId: f.w.get(f.id).nativeId }], 'Listed, having a grant in force: when it was replaced is known only at the step');
  await f.carry(); await f.carry(undefined, 31000);
  assert.deepEqual(f.calls, ['carry'], 'Asked once for this state of the log');
  assert.equal(JSON.stringify(f.w.operator.data), journal, 'Nothing is decided or saved, and no audit line is written');
  assert.deepEqual(f.w.operator.data.domains[late].initiators.map(i => i.id), [f.id], 'The grant stays with the session the person gave it to');
  assert.equal(Object.hasOwn(f.w.operator.data.sessions, next), false, 'The successor has no interface setting');
  await assert.rejects(f.open(next), /has not enabled this initiator interface/);
  assert.equal(f.records().length + f.records('shared').length, 0, 'Nothing is said in any space');
  assert.deepEqual(f.w.operatorAction(f.id, 'succession', pair(f, f.id, next, at)), { carried: false, reason: 'no-grant', saved: false });
  assert.deepEqual(f.w.operatorAction(f.id, 'succession', { step: 'refuse', nativeId: f.w.get(f.id).nativeId, reason: 'ambiguous', loggedAt: at }), { carried: false, reason: 'no-grant', saved: false });
  assert.equal(JSON.stringify(f.w.operator.data), journal);
  // Given in the same millisecond as the replacement was logged, the grant was there: that replacement is followed.
  assert.equal(f.w.operatorAction(f.id, 'succession', pair(f, f.id, next, f.w.operator.data.domains[late].createdAt)).carried, true);
  // The grant it had when it was replaced has since been revoked, and the one in force was given afterwards: the same.
  const g = await fixture(t), had = g.grant();
  g.w.operator.data.sessions[g.id].enabledAt = Date.now() - 7200000; g.w.operator.data.domains[had].createdAt = Date.now() - 7000000;
  const heir = await g.successor(); await g.w.stop(g.id);
  g.logged('done', g.w.get(g.id), g.w.get(heir), Date.now() - 3600000);
  g.w.operatorAction(g.id, 'revoke', had); const since = g.grant(), saved = JSON.stringify(g.w.operator.data);
  await g.carry();
  assert.deepEqual(g.calls, ['carry']); assert.equal(JSON.stringify(g.w.operator.data), saved);
  assert.deepEqual([had, since].map(id => g.w.operator.data.domains[id].initiators.map(i => i.id)), [[g.id], [g.id]]);
  assert.equal(Object.hasOwn(g.w.operator.data.sessions, heir), false); assert.equal(g.records().length, 0);
  // A grant with no time of its own cannot be shown to have been there when the holder was replaced: it does not count.
  const m = await fixture(t), timeless = m.grant(); delete m.w.operator.data.domains[timeless].createdAt;
  const after = await m.replace(), unchanged = JSON.stringify(m.w.operator.data);
  assert.deepEqual(m.w.operatorAction(m.id, 'succession', pair(m, m.id, after)), { carried: false, reason: 'no-grant', saved: false });
  assert.equal(JSON.stringify(m.w.operator.data), unchanged);
  // A line in the log with no time can only be refused, and a refusal moves nothing: there any grant in force
  // counts, and the person is told that the grant stayed.
  const k = await fixture(t); const untimed = await k.successor(); await k.w.stop(k.id);
  k.logged('done', k.w.get(k.id), k.w.get(untimed), null); const stays = k.grant();
  await k.carry();
  assert.deepEqual(k.records().map(record => [record.monitor.carried, record.monitor.reason]), [[false, 'ambiguous']]);
  assert.deepEqual(k.w.operator.data.domains[stays].initiators.map(i => i.id), [k.id]); assert.equal(Object.hasOwn(k.w.operator.data.sessions, untimed), false);
  // With a grant in force that it had when it was replaced, the replacement is followed as before. What goes on is
  // what it had then, in force or not; a grant the person gave it after that, before the desktop's step, stays.
  const h = await fixture(t), early = h.grant(), lapsed = h.grant(), withdrawn = h.grant();
  h.w.operator.data.sessions[h.id].enabledAt = Date.now() - 7200000;
  for (const id of [early, lapsed, withdrawn]) h.w.operator.data.domains[id].createdAt = Date.now() - 7000000;
  h.w.operator.data.domains[lapsed].expiresAt = Date.now() - 1; h.w.operatorAction(h.id, 'revoke', withdrawn);
  const follower = await h.successor(); await h.w.stop(h.id);
  h.logged('done', h.w.get(h.id), h.w.get(follower), Date.now() - 3600000);
  const between = h.grant(), undated = h.grant(); delete h.w.operator.data.domains[undated].createdAt;
  await h.carry();
  const holders = id => h.w.operator.data.domains[id].initiators.map(i => i.id);
  assert.deepEqual([early, lapsed, withdrawn].map(holders), [[follower], [follower], [follower]], 'What it had when it was replaced goes on, as it is');
  assert.deepEqual([between, undated].map(holders), [[h.id], [h.id]], 'What it was given afterwards, or cannot be shown to have had, stays');
  assert.deepEqual([between, undated].map(id => h.w.operator.data.domains[id].carried), [undefined, undefined], 'and is not marked as having gone on');
  assert.equal(h.w.operator.data.sessions[follower].enabled, true); assert.equal(h.w.operator.data.sessions[h.id].enabled, false);
  assert.deepEqual([h.records()[0].monitor.carried, h.records()[0].monitor.grants], [true, 1], 'The entry counts the one grant in force that went on');
  assert.deepEqual(h.w.operator.data.audit.find(entry => entry.tool === 'operator_succession').domains.sort(), [early, lapsed, withdrawn].sort());
  // The successor opens under the grant that went on, and not under the one that stayed.
  const opened = await h.open(follower); assert.equal(opened.status, 'created'); assert.equal(opened.domainId, early);
  const refused = await h.open(follower, { grant_id: between });
  assert.deepEqual([refused.status, refused.sessionId], ['pending-authorization', null], 'Named by the successor, the grant that stayed creates nothing: the request waits for the person');
  // Nothing new can be started under the grant that stayed: the old session has ended and its interface is off.
  // The person can revoke it from the old session's menu (what that item sends); the journal's own off switch
  // for that session reaches it too.
  assert.equal(h.w.operator.data.domains[between].revokedAt, undefined);
  h.w.operatorAction(h.id, 'revoke', between); assert.ok(h.w.operator.data.domains[between].revokedAt);
  h.w.operatorAction(h.id, 'enabled', false); assert.ok(h.w.operator.data.domains[undated].revokedAt);
});

test('the entry says what went on: the grants that are in force, or the interface permission alone when the grant was revoked before the entry could be written', async t => {
  // One grant in force beside a revoked one: the entry speaks of grants, and counts the one that is in force.
  const g = await fixture(t), live = g.grant(), dead = g.grant(); g.w.operatorAction(g.id, 'revoke', dead);
  await g.replace(); await g.carry();
  assert.deepEqual([g.records()[0].monitor.carried, g.records()[0].monitor.grants], [true, 1]);
  assert.equal(g.records()[0].uiMessage.key, 'notice.monitor.grantCarried'); assert.ok(!g.w.operator.data.domains[live].revokedAt);
  // Written later, from a state that already shows the move, it counts the same grants and not one the old session was given since.
  const h = await fixture(t); h.grant();
  await h.replace(); h.failRecords(1); await h.carry();
  h.w.operatorAction(h.id, 'enabled', true); h.grant(); h.grant();
  await h.carry(undefined, 31000);
  assert.deepEqual([h.records()[0].monitor.carried, h.records()[0].monitor.grants], [true, 1]);
  // The grant went on and the person revoked it before the entry could be written: the entry does not read as if a
  // usable grant had moved, and grants given to the old session since do not make it speak of grants.
  const k = await fixture(t), moved = k.grant();
  const heir = await k.replace(); k.failRecords(1); await k.carry();
  assert.equal(k.records().length, 0); assert.deepEqual(k.w.operator.data.domains[moved].initiators.map(i => i.id), [heir]);
  k.w.operatorAction(heir, 'revoke', moved);
  k.w.operatorAction(k.id, 'enabled', true); k.grant(); k.grant();
  await k.carry(undefined, 31000);
  assert.deepEqual([k.records()[0].monitor.carried, k.records()[0].monitor.grants], [true, 0]);
  assert.equal(k.records()[0].uiMessage.key, 'notice.monitor.interfaceCarried');
  assert.equal(text(k.records()[0]), 'Lead 换会话后，你给它的 agent 控制接口许可由 Lead · 续 接续；它名下没有有效的建会话授权，已撤销或已到期的仍然无效');
  assert.equal(text(k.records()[0], 'en'), 'After Lead was replaced, Lead · 续 holds the agent control interface permission you gave it. It has no session-creation grant in force; a revoked or expired grant stays revoked or expired');
});

test('the person\'s own off switches win: a holder whose interface was turned off, or the interface turned off for everyone, carries nothing', async t => {
  const f = await fixture(t), grantId = f.grant();
  f.w.operatorAction(f.id, 'enabled', false);
  const next = await f.replace(); await f.carry();
  assert.deepEqual(listed(f), []); assert.equal(f.calls.length, 0); assert.equal(f.records().length, 0);
  assert.equal(Object.hasOwn(f.w.operator.data.sessions, next), false); assert.ok(f.w.operator.data.domains[grantId].revokedAt);
  assert.deepEqual(f.w.operatorAction(f.id, 'succession', pair(f, f.id, next)), { carried: false, reason: 'not-held', saved: false });
  const g = await fixture(t); g.grant();
  const other = await g.replace(); g.w.operatorAction(null, 'enabled', false); await g.carry();
  assert.deepEqual(listed(g), []); assert.equal(g.records().length, 0);
  assert.deepEqual(g.w.operatorAction(g.id, 'succession', pair(g, g.id, other)), { carried: false, reason: 'interface-off', saved: false });
  // Turned back on, the grants it revoked stay revoked, so the holder has none in force: nothing goes on, nothing is said.
  g.w.operatorAction(null, 'enabled', true); await g.carry();
  assert.deepEqual(listed(g), []); assert.equal(g.records().length, 0); assert.equal(Object.hasOwn(g.w.operator.data.sessions, other), false);
  await assert.rejects(g.open(other), /has not enabled this initiator interface/);
});

test('a holder the person stopped, with no replacement in the log, is left alone and the log is not read again until it changes', async t => {
  const f = await fixture(t); f.grant();
  await f.w.stop(f.id);
  const before = JSON.stringify(f.w.operator.data);
  for (let state = 0; state < 20; state += 1) await f.carry();
  assert.equal(f.follows.length, 1, 'Twenty states, one look at the log'); assert.equal(f.calls.length, 0); assert.equal(f.records().length, 0); assert.equal(JSON.stringify(f.w.operator.data), before);
  // The log changes (another session was replaced): one more look, and still nothing for this holder.
  const other = await f.w.create('claude', f.root, 'owner', 'Other'), third = await f.w.create('claude', f.root, 'owner', 'Other');
  f.logged('done', f.w.get(other), f.w.get(third));
  for (let state = 0; state < 5; state += 1) await f.carry();
  assert.equal(f.follows.length, 2); assert.equal(JSON.stringify(f.w.operator.data), before); assert.equal(f.records().length, 0);
});

for (const [label, arrange, reason] of [
  ['the old session is still in use beside its successor, and is stopped later', async f => { const next = await f.replace(f.id, 'kept'); await f.w.stop(f.id); return next; }, 'ambiguous'],
  ['the log names two successors for it (a fork)', async f => { const next = await f.replace(); const second = await f.successor(); f.logged('done', f.w.get(f.id), f.w.get(second)); return next; }, 'ambiguous'],
  ['its successor also replaced another session', async f => { const next = await f.replace(); const other = await f.w.create('claude', f.root, 'owner', 'Other'); f.logged('done', f.w.get(other), f.w.get(next)); return next; }, 'ambiguous'],
  ['the log has another native id for it', async f => { const next = await f.successor(); await f.w.stop(f.id); f.logged('done', { ...f.w.get(f.id), nativeId: 'another-native-id' }, f.w.get(next)); return next; }, 'ambiguous'],
  ['the line in the log has no time', async f => { const next = await f.successor(); await f.w.stop(f.id); f.logged('done', f.w.get(f.id), f.w.get(next), null); return next; }, 'ambiguous'],
  ['the successor already has a setting the person made', async f => { const next = await f.replace(); f.w.operatorAction(next, 'enabled', false); return next; }, 'successor-has-setting'],
  ['the log names a session with another native id as its successor', async f => { const next = await f.successor(); await f.w.stop(f.id); f.logged('done', f.w.get(f.id), { ...f.w.get(next), nativeId: 'not-its-native-id' }); return next; }, 'successor-mismatch'],
  ['the successor was archived by the person', async f => { const next = await f.replace(); f.roomState.value.archivedSessions.push(next); return next; }, 'successor-unavailable'],
]) test('not carried when ' + label + ': the grant stays where it was, the person is told once, and it is never moved later', async t => {
  const f = await fixture(t), grantId = f.grant();
  const next = await arrange(f);
  const before = f.grants(), settingBefore = JSON.stringify(f.w.operator.data.sessions[next] || null);
  for (let state = 0; state < 3; state += 1) await f.carry();
  assert.equal(f.grants(), before, 'No grant moved');
  assert.deepEqual(f.w.operator.data.domains[grantId].initiators, [{ id: f.id, nativeId: f.w.get(f.id).nativeId }]);
  assert.equal(JSON.stringify(f.w.operator.data.sessions[next] || null), settingBefore, 'Nothing was set for the other session');
  const outcome = f.w.operator.data.sessions[f.id].succession;
  assert.deepEqual(outcome, { at: outcome.at, carried: false, reason, told: true });
  assert.equal(f.records().length, 1);
  const [record] = f.records();
  assert.equal(record.monitor.carried, false); assert.equal(record.monitor.reason, reason);
  assert.equal(text(record), 'Lead 换会话后，你给它的 agent 控制接口许可和建会话授权没有跟过去；要继续用，请给新会话重新授权');
  assert.equal(text(record, 'en'), 'After Lead was replaced, the agent control interface permission and the session-creation grants you gave it were not carried over; to keep using them, grant them to the new session again');
  assert.equal(f.w.operator.data.audit.filter(entry => entry.tool === 'operator_succession').map(entry => entry.result).join(), 'not-carried');
  assert.deepEqual(listed(f), []);
  // Whatever stood in the way goes away, the log changes and the desktop restarts: the person was told it stayed, so it stays.
  f.roomState.value.archivedSessions.length = 0;
  if (f.w.operator.data.sessions[next] && !f.w.operator.data.sessions[next].enabled) delete f.w.operator.data.sessions[next];
  const other = await f.w.create('claude', f.root, 'owner', 'Other'), third = await f.w.create('claude', f.root, 'owner', 'Other');
  f.logged('done', f.w.get(other), f.w.get(third));
  f.restartDesktop(); for (let state = 0; state < 3; state += 1) await f.carry();
  assert.equal(f.grants(), before); assert.equal(f.records().length, 1);
  assert.deepEqual(f.w.operatorAction(f.id, 'succession', pair(f, f.id, next)), { ...outcome, saved: true }, 'Asked directly, the journal repeats what it decided');
  assert.equal(f.grants(), before);
});

test('not carried when the successor is in another backend: this backend is not asked to guess', async t => {
  const f = await fixture(t); f.grant();
  await f.w.stop(f.id);
  const elsewhere = { id: randomUUID(), nativeId: randomUUID(), name: 'Lead · 续', provider: 'claude', state: 'idle', roomIds: [f.space] };
  f.logged('done', f.w.get(f.id), elsewhere);
  const before = f.grants(), snapshot = f.w.snapshot();
  // The desktop sees the sessions of every backend; the journal's own backend does not have this one.
  await f.carry({ ...snapshot, sessions: [...snapshot.sessions, elsewhere] });
  assert.equal(f.grants(), before); assert.equal(f.records()[0].monitor.reason, 'successor-elsewhere'); assert.equal(Object.hasOwn(f.w.operator.data.sessions, elsewhere.id), false);
});

test('a forged line gets nowhere when it does not match what is there: a running holder keeps its grant, and a log others can write is not read', async t => {
  const f = await fixture(t), grantId = f.grant();
  const accomplice = await f.successor('Accomplice');
  // A finished replacement is claimed for a holder that is still running.
  f.logged('done', f.w.get(f.id), f.w.get(accomplice));
  const before = JSON.stringify(f.w.operator.data);
  for (let state = 0; state < 3; state += 1) await f.carry();
  assert.deepEqual(listed(f), [], 'A running holder is never listed'); assert.equal(f.calls.length, 0); assert.equal(JSON.stringify(f.w.operator.data), before); assert.equal(f.records().length, 0);
  assert.deepEqual(f.w.operatorAction(f.id, 'succession', pair(f, f.id, accomplice)), { carried: false, reason: 'old-in-use', saved: false }, 'Even through the desktop\'s own path');
  assert.equal(JSON.stringify(f.w.operator.data), before);
  assert.equal((await f.open(f.id)).domainId, grantId, 'The holder goes on using its grant');
  // A log that is not private to the person is not trusted at all.
  const g = await fixture(t); g.grant();
  const claimed = await g.replace(); fs.chmodSync(g.logFile, 0o666);
  const untouched = JSON.stringify(g.w.operator.data);
  for (let state = 0; state < 3; state += 1) await g.carry();
  assert.equal(JSON.stringify(g.w.operator.data), untouched); assert.equal(g.calls.length, 0); assert.equal(g.records().length, 0);
  assert.equal(Object.hasOwn(g.w.operator.data.sessions, claimed), false);
});

test('a chain is walked one finished replacement at a time, and the person\'s setting for a session in between stops it there', async t => {
  const f = await fixture(t), grantId = f.grant();
  const middle = await f.replace(f.id, 'done', 'Lead · 续'), last = await f.replace(middle, 'done', 'Lead · 续 · 续');
  // Both replacements happened while the desktop was closed.
  await f.carry();
  assert.deepEqual(f.w.operator.data.domains[grantId].initiators, [{ id: middle, nativeId: f.w.get(middle).nativeId }], 'First to the session that replaced it');
  await f.carry();
  assert.deepEqual(f.w.operator.data.domains[grantId].initiators, [{ id: last, nativeId: f.w.get(last).nativeId }], 'Then on to the one that stands there now');
  assert.equal(f.w.snapshot().sessions.find(s => s.id === middle).operatorEnabled, false);
  assert.deepEqual(f.records().map(record => [record.monitor.oldId, record.monitor.newId]), [[f.id, middle], [middle, last]], 'One entry for each step');
  assert.equal((await f.open(last)).status, 'created'); assert.equal((await f.open(last)).status, 'created');
  await assert.rejects(async () => f.open(last), /quota is exhausted/, 'Two a day across all three holders');
  // The person turned the interface off for the session in between: the grant does not jump over that.
  const g = await fixture(t), other = g.grant();
  const between = await g.replace(g.id, 'done', 'Lead · 续'); g.w.operatorAction(between, 'enabled', false);
  const end = await g.replace(between, 'done', 'Lead · 续 · 续');
  for (let state = 0; state < 3; state += 1) await g.carry();
  assert.deepEqual(g.w.operator.data.domains[other].initiators, [{ id: g.id, nativeId: g.w.get(g.id).nativeId }]);
  assert.equal(g.records()[0].monitor.reason, 'successor-has-setting'); assert.equal(Object.hasOwn(g.w.operator.data.sessions, end), false);
});

test('a successor that has itself been stopped still receives the grant, and holds it when the person brings it back', async t => {
  const f = await fixture(t), grantId = f.grant();
  const next = await f.replace(); await f.w.stop(next);
  await f.carry();
  assert.deepEqual(f.w.operator.data.domains[grantId].initiators, [{ id: next, nativeId: f.w.get(next).nativeId }]);
  assert.equal(f.records()[0].monitor.carried, true);
  // Now itself an ended holder with no replacement: listed, looked at, and left alone.
  assert.deepEqual(listed(f), [{ id: next, nativeId: f.w.get(next).nativeId }]);
  await f.carry(); assert.equal(f.records().length, 1);
});

test('a repeat, a second window, a failing backend and a restarted desktop decide once and say it once', async t => {
  const f = await fixture(t), grantId = f.grant();
  const next = await f.replace();
  f.failBackend(2); await f.carry();
  assert.equal(f.records().length, 0, 'Nothing was carried or said'); assert.equal(Object.hasOwn(f.w.operator.data.sessions, next), false);
  // Not asked again with every state: half a minute apart, and only when a state arrives.
  for (let state = 0; state < 10; state += 1) await f.carry(undefined, 1000);
  assert.deepEqual(f.calls, ['carry']);
  await f.carry(undefined, 21000); assert.deepEqual(f.calls, ['carry', 'carry'], 'Asked again after half a minute'); assert.equal(f.records().length, 0);
  // A restarted desktop looks again at once; three windows at the same moment are one attempt.
  f.restartDesktop();
  await Promise.all([f.carry(), f.carry(), f.carry()]);
  assert.deepEqual(f.calls, ['carry', 'carry', 'carry', 'told']);
  assert.equal(f.w.operator.data.domains[grantId].carried.length, 1); assert.equal(f.records().length, 1);
  f.restartDesktop(); await f.carry();
  assert.equal(f.records().length, 1); assert.equal(f.w.operator.data.audit.filter(entry => entry.tool === 'operator_succession').length, 1);
  // Asked again for the same pair, the journal says what it decided and changes nothing.
  const before = JSON.stringify(f.w.operator.data), outcome = f.w.operator.data.sessions[f.id].succession;
  assert.deepEqual(f.w.operatorAction(f.id, 'succession', pair(f, f.id, next)), { ...outcome, saved: true });
  assert.equal(JSON.stringify(f.w.operator.data), before);
});

test('a notice that could not be written is written later: the holder stays listed until the person can read the outcome', async t => {
  const f = await fixture(t), grantId = f.grant();
  const next = await f.replace();
  f.failRecords(1); await f.carry();
  assert.deepEqual(f.w.operator.data.domains[grantId].initiators.map(i => i.id), [next], 'The grant moved');
  assert.equal(f.records().length, 0, 'but nothing could be said');
  const outcome = f.w.operator.data.sessions[f.id].succession;
  assert.equal(outcome.told, undefined);
  assert.deepEqual(listed(f), [{ id: f.id, nativeId: f.w.get(f.id).nativeId, outcome }], 'Still listed, with what was decided');
  for (let state = 0; state < 5; state += 1) await f.carry(undefined, 1000);
  assert.equal(f.records().length, 0, 'Half a minute apart');
  // The desktop restarts in between; the journal still knows it owes the person a notice.
  f.restartDesktop(); await f.carry();
  assert.equal(f.records().length, 1); assert.equal(f.records()[0].monitor.carried, true); assert.equal(f.records()[0].monitor.newId, next);
  assert.equal(f.w.operator.data.sessions[f.id].succession.told, true); assert.deepEqual(listed(f), []);
  assert.deepEqual(f.calls, ['carry', 'told'], 'Decided once, acknowledged once');
  // The notice was written but the acknowledgement was lost: the next state acknowledges, and writes nothing twice.
  const g = await fixture(t); g.grant();
  await g.replace(); g.failRecords(0);
  const told = g.client.call; let dropped = false;
  g.client.call = async (method, ...args) => { if (args[2]?.step === 'told' && !dropped) { dropped = true; throw Error('Synthetic lost acknowledgement'); } return told(method, ...args); };
  await g.carry(); assert.equal(g.records().length, 1); assert.equal(listed(g).length, 1);
  await g.carry(undefined, 31000); assert.equal(g.records().length, 1); assert.deepEqual(listed(g), []);
  // A space that cannot take the entry at all: said in the default space at the second try, not waited on for ever.
  const k = await fixture(t); k.grant();
  await k.replace(); k.failRoom(k.space);
  await k.carry(); assert.equal(k.records('shared').length, 0, 'The first time it waits for the space the successor is in');
  await k.carry(undefined, 31000);
  assert.equal(k.records('shared').length, 1); assert.equal(k.records('shared')[0].monitor.carried, true); assert.deepEqual(listed(k), []);
  // With no space left to say it in, it is said in the default space.
  const h = await fixture(t); h.grant();
  const heir = await h.successor(); Object.assign(h.w.get(heir), spaces.withPlacement(h.w.get(heir), null)); await h.w.stop(h.id);
  fs.appendFileSync(h.logFile, JSON.stringify({ time: Date.now() + 1, event: 'done', spaces: [], old: { id: h.id, nativeId: h.w.get(h.id).nativeId, name: 'Lead' }, new: { id: heir, nativeId: h.w.get(heir).nativeId, name: 'Lead · 续' } }) + '\n', { mode: 0o600 });
  await h.carry();
  assert.equal(h.records('shared').length, 1); assert.equal(h.records().length, 0);
});

test('the step is the desktop\'s own: no agent tool reaches it, and only exact requests are accepted', async t => {
  const f = await fixture(t); f.grant();
  assert.deepEqual(tools.map(tool => tool.name), ['workspace_sessions', 'workspace_open', 'workspace_report'], 'The agent tool list is unchanged');
  const accomplice = await f.successor('Accomplice');
  const s = f.w.get(f.id), r = f.w.runtimes.get(f.id), identity = { nativeId: s.nativeId, turnId: r.liveTurn.id, promptId: r.liveTurn.promptId, callId: randomUUID() };
  await assert.rejects(async () => r.operatorCall(identity, 'workspace_succession', { to: accomplice }), /Invalid operator tool arguments|Unknown operator tool/);
  const exact = pair(f, f.id, accomplice);
  for (const value of [null, {}, { nativeId: s.nativeId }, { ...exact, extra: true }, { ...exact, step: 'move' }, { ...exact, loggedAt: 'now' }, { ...exact, to: { id: accomplice } }, { ...exact, to: { ...exact.to, more: 1 } },
    { ...exact, nativeId: 7 }, { ...exact, to: { id: f.id, nativeId: 'x' } }, { ...exact, to: { id: accomplice, nativeId: s.nativeId } },
    { step: 'refuse', nativeId: s.nativeId, reason: 'because', loggedAt: null }, { step: 'refuse', nativeId: s.nativeId, reason: 'ambiguous' }, { step: 'refuse', nativeId: s.nativeId, reason: 'ambiguous', loggedAt: 'now' },
    { step: 'refuse', nativeId: s.nativeId, reason: 'ambiguous', loggedAt: null, to: exact.to }, { step: 'told', nativeId: s.nativeId, told: true }]) {
    assert.throws(() => f.w.operatorAction(f.id, 'succession', value), /Invalid succession/, JSON.stringify(value));
  }
  assert.deepEqual(f.w.operatorAction(accomplice, 'succession', pair(f, accomplice, f.id)), { carried: false, reason: 'not-held', saved: false });
  assert.deepEqual(f.w.operatorAction(f.id, 'succession', { step: 'told', nativeId: s.nativeId }), { carried: false, reason: 'not-decided', saved: false });
  assert.deepEqual(f.w.operatorAction(f.id, 'succession', { step: 'refuse', nativeId: s.nativeId, reason: 'ambiguous', loggedAt: null }), { carried: false, reason: 'old-in-use', saved: false }, 'Nothing is decided for a running holder');
  // The desktop refuses the call from an agent's context before any confirmation is shown, and only a person's window runs the step.
  const start = main.indexOf('function register(name, handler) {'), end = main.indexOf("if (backgroundOperation.deliveryTargets(name, args))", start), guard = main.slice(start, end);
  assert.ok(guard.includes("if (name === 'operatorAction' && args[1] === 'succession') throw uiError('error.operator.desktopOnly');"));
  assert.ok(guard.indexOf('if (c.background) {') < guard.indexOf("throw uiError('error.operator.desktopOnly')"), 'Inside the agent-context branch');
  assert.ok(main.indexOf("throw uiError('error.operator.desktopOnly')") < main.indexOf("const answer = await showDialog(c, 'message', { type: 'warning', message: name"), 'Refused before the generic confirmation');
  assert.equal(main.split('carryGrants(').length, 3, 'Its definition and the state listener: no other caller');
  assert.ok(main.includes('if (!context.background) carryGrants(client, data).catch(() => {});'));
  assert.equal(locale.format('zh', 'error.operator.desktopOnly'), '这一步由 NAW 自己在你的窗口里做，agent 不能调用。');
  assert.equal(locale.format('en', 'error.operator.desktopOnly'), 'NAW does this step itself in your window; an agent cannot call it.');
});

test('a revoke reaches the grant wherever it has gone: from the card of any session that held it, and by turning any of them off', async t => {
  const chain = async () => {
    const f = await fixture(t), grantId = f.grant();
    const middle = await f.replace(f.id, 'done', 'Lead · 续'); await f.carry();
    const last = await f.replace(middle, 'done', 'Lead · 续 · 续'); await f.carry();
    assert.equal((await f.open(last)).status, 'created');
    return { f, grantId, middle, last };
  };
  for (const [label, act] of [
    ['revoked from the first holder\'s card', ({ f, grantId }) => f.w.operatorAction(f.id, 'revoke', grantId)],
    ['revoked from the card of the session in between', ({ f, grantId, middle }) => f.w.operatorAction(middle, 'revoke', grantId)],
    ['revoked from the current holder\'s card', ({ f, grantId, last }) => f.w.operatorAction(last, 'revoke', grantId)],
    ['the first holder\'s interface turned off', ({ f }) => f.w.operatorAction(f.id, 'enabled', false)],
    ['the current holder\'s interface turned off', ({ f, last }) => f.w.operatorAction(last, 'enabled', false)],
  ]) {
    const c = await chain(); act(c);
    assert.ok(c.f.w.operator.data.domains[c.grantId].revokedAt, label);
    // Turned off, the holder has no interface at all; revoked, it is asked for a new approval. Neither opens anything.
    const before = c.f.w.snapshot().sessions.length;
    await c.f.open(c.last).then(result => assert.equal(result.status, 'pending-authorization', label), error => assert.match(error.message, /has not enabled this initiator interface/, label));
    assert.equal(c.f.w.snapshot().sessions.length, before, label);
  }
  const { f, grantId } = await chain(), stranger = await f.w.create('claude', f.root, 'owner', 'Stranger');
  assert.throws(() => f.w.operatorAction(stranger, 'revoke', grantId), /another initiator/);
  // A revoke made before a replacement is not undone by it: with that grant revoked nothing goes on at all.
  const g = await fixture(t), early = g.grant(); g.w.operatorAction(g.id, 'revoke', early);
  const heir = await g.replace(); await g.carry();
  assert.ok(g.w.operator.data.domains[early].revokedAt); assert.deepEqual(g.w.operator.data.domains[early].initiators.map(i => i.id), [g.id], 'The revoked grant stays where it was');
  assert.equal(Object.hasOwn(g.w.operator.data.sessions, heir), false); assert.equal(g.records().length, 0);
  await assert.rejects(g.open(heir), /has not enabled this initiator interface/);
});

test('what was decided is part of the journal: a restarted backend knows it, and a record the journal could not have written disables the interface', async t => {
  const f = await fixture(t), grantId = f.grant();
  const next = await f.replace(); await f.carry();
  const file = f.w.operator.file; f.w.close();
  const good = fs.readFileSync(file, 'utf8');
  const restart = change => {
    const data = JSON.parse(good); change(data); fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
    const w = new Workspace(hostFor(), f.root), policy = w.operator.policy(); w.close(); return policy;
  };
  const again = restart(() => {});
  assert.equal(again.error, null); assert.equal(again.sessions[next].enabled, true); assert.equal(again.sessions[next].carriedFrom.id, f.id); assert.equal(again.sessions[f.id].succession.carried, true);
  assert.deepEqual(again.domains.find(domain => domain.id === grantId).initiators.map(i => i.id), [next]);
  assert.deepEqual(again.successions, []);
  for (const [label, change] of [
    ['where a setting came from is not a record', data => { data.sessions[next].carriedFrom = f.id; }],
    ['where a setting came from has no time', data => { delete data.sessions[next].carriedFrom.at; }],
    ['where a setting came from has a field the journal never writes', data => { data.sessions[next].carriedFrom.by = 'agent'; }],
    ['the time a setting was turned on is not a time', data => { data.sessions[next].enabledAt = 'yesterday'; }],
    ['an outcome is not a record', data => { data.sessions[f.id].succession = 'carried'; }],
    ['an outcome that carried names no successor', data => { delete data.sessions[f.id].succession.to; }],
    ['an outcome that did not carry gives free text as its reason', data => { data.sessions[f.id].succession = { at: 1, carried: false, reason: 'Free text\nwith lines' }; }],
    ['an outcome has a field the journal never writes', data => { data.sessions[f.id].succession.undo = true; }],
    ['an outcome is marked told with something other than true', data => { data.sessions[f.id].succession.told = 'yes'; }],
    ['a grant\'s history is not a list', data => { data.domains[grantId].carried = {}; }],
    ['a grant\'s history has a holder without a native id', data => { delete data.domains[grantId].carried[0].to.nativeId; }],
    ['a grant\'s history has a field the journal never writes', data => { data.domains[grantId].carried[0].note = 'x'; }],
  ]) {
    const policy = restart(change);
    assert.match(String(policy.error), /could not be read; the interface is disabled/, label); assert.deepEqual(policy.successions, [], label);
  }
});

test('the person turning the old session on again after a carry decides nothing anew and says nothing new', async t => {
  const f = await fixture(t), grantId = f.grant();
  const next = await f.replace(); await f.carry();
  assert.equal(f.records().length, 1);
  // Brought back and turned on again, the old session is a holder anew, with no grants: they went on.
  f.w.operatorAction(f.id, 'enabled', true);
  const outcome = f.w.operator.data.sessions[f.id].succession;
  assert.equal(outcome.carried, true, 'What was decided stays on record');
  assert.deepEqual(listed(f), [], 'An ended holder again, but with no grant in force it is not listed for a decision');
  // Given a grant of its own, it is listed, open for a decision about a later replacement.
  f.grant();
  assert.deepEqual(listed(f), [{ id: f.id, nativeId: f.w.get(f.id).nativeId }], 'A holder anew, with a grant in force');
  const before = JSON.stringify(f.w.operator.data);
  for (let state = 0; state < 3; state += 1) await f.carry();
  // The replacement in the log is older than this turning on: it is not a replacement of this holder.
  assert.equal(JSON.stringify(f.w.operator.data), before, 'Nothing was decided');
  assert.equal(f.records().length, 1, 'and nothing more was said: the one entry still says where the grant is');
  assert.deepEqual(f.w.operator.data.domains[grantId].initiators.map(i => i.id), [next]);
  assert.deepEqual(f.w.operatorAction(f.id, 'succession', pair(f, f.id, next, Date.now() - 1000)), { carried: false, reason: 'not-replaced', saved: false });
  // The successor's own setting, toggled by the person, still says where it came from; turned off, its grant is revoked.
  f.w.operatorAction(next, 'enabled', false); f.w.operatorAction(next, 'enabled', true);
  assert.equal(f.w.operator.data.sessions[next].carriedFrom.id, f.id); assert.ok(f.w.operator.data.domains[grantId].revokedAt);
  // Turned on again while the notice of the carry was still owed: the notice that is written is the true one.
  const g = await fixture(t), other = g.grant();
  const heir = await g.replace(); g.failRecords(1); await g.carry();
  assert.equal(g.records().length, 0);
  g.w.operatorAction(g.id, 'enabled', true);
  await g.carry(undefined, 31000); for (let state = 0; state < 3; state += 1) await g.carry(undefined, 31000);
  assert.deepEqual(g.records().map(record => [record.monitor.carried, record.monitor.newId]), [[true, heir]]);
  assert.deepEqual(g.w.operator.data.domains[other].initiators.map(i => i.id), [heir]);
  // The same after a refusal: told once that it stayed, turned on again, and nothing new is decided or said.
  const h = await fixture(t); h.grant();
  await h.replace(h.id, 'kept'); await h.w.stop(h.id); await h.carry();
  assert.deepEqual(h.records().map(record => record.monitor.reason), ['ambiguous']);
  h.w.operatorAction(h.id, 'enabled', true);
  const journal = JSON.stringify(h.w.operator.data);
  for (let state = 0; state < 3; state += 1) await h.carry();
  assert.equal(JSON.stringify(h.w.operator.data), journal); assert.equal(h.records().length, 1); assert.equal(h.records('shared').length, 0);
});

test('a replacement logged before the person turned the holder\'s interface on is not a replacement of this holder: nothing is decided, nothing is said', async t => {
  const f = await fixture(t), grantId = f.grant();
  const next = await f.successor(); await f.w.stop(f.id);
  f.logged('done', f.w.get(f.id), f.w.get(next), Date.now() - 3600000);
  const before = JSON.stringify(f.w.operator.data);
  for (let state = 0; state < 3; state += 1) await f.carry();
  assert.equal(JSON.stringify(f.w.operator.data), before); assert.equal(f.records().length, 0); assert.equal(f.records('shared').length, 0);
  assert.deepEqual(f.w.operator.data.domains[grantId].initiators.map(i => i.id), [f.id]);
  assert.deepEqual(f.calls, ['carry'], 'Asked once for this state of the log');
  // A holder anew that is then really replaced has two replacements in the log: that is a fork, and the person is told it stayed.
  const g = await fixture(t), first = g.grant();
  const heir = await g.replace(); await g.carry();
  g.w.operatorAction(g.id, 'enabled', true); const second = g.grant();
  const later = await g.successor('Lead · 再续'); g.logged('done', g.w.get(g.id), g.w.get(later), Date.now() + 5);
  for (let state = 0; state < 3; state += 1) await g.carry();
  assert.deepEqual(g.w.operator.data.domains[first].initiators.map(i => i.id), [heir], 'The first grant is where it went');
  assert.deepEqual(g.w.operator.data.domains[second].initiators.map(i => i.id), [g.id], 'The second stays with the old session');
  assert.deepEqual(g.records().map(record => [record.monitor.carried, record.monitor.reason || null]), [[true, null], [false, 'ambiguous']]);
  assert.equal(Object.hasOwn(g.w.operator.data.sessions, later), false);
});

test('a setting saved before the time of turning on was recorded gets it when the journal is loaded, and only a later replacement is followed', async t => {
  const f = await fixture(t), grantId = f.grant();
  const file = f.w.operator.file;
  // The journal as an earlier version wrote it: no time on the setting.
  const data = JSON.parse(fs.readFileSync(file, 'utf8')); delete data.sessions[f.id].enabledAt;
  // (No space for the successor here: the synthetic backend is restarted, and its own records know no desktop space.)
  const next = await f.w.create('claude', f.root, 'owner', 'Lead · 续'); await f.w.stop(f.id);
  f.w.close(); fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  const w = new Workspace(hostFor(), f.root); t.after(() => w.close());
  const stamped = w.operator.data.sessions[f.id].enabledAt;
  assert.ok(!w.storageWarning);
  assert.ok(Number.isSafeInteger(stamped) && stamped >= Date.now() - 5000, 'Stamped at load');
  const exact = at => ({ step: 'carry', nativeId: data.sessions[f.id].nativeId, to: { id: next, nativeId: w.sessions.get(next).nativeId }, loggedAt: at });
  assert.deepEqual(w.operatorAction(f.id, 'succession', exact(stamped - 1)), { carried: false, reason: 'not-replaced', saved: false }, 'Older than the stamp: not followed');
  const outcome = w.operatorAction(f.id, 'succession', exact(stamped + 1));
  assert.equal(outcome.carried, true, 'Logged after the stamp: followed'); assert.deepEqual(w.operator.data.domains[grantId].initiators.map(i => i.id), [next]);
});

test('the log rule itself: one finished, unambiguous replacement is one step, with the time it was logged', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-follow-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rotation-log.jsonl'), a = { sessionId: 'a', nativeId: 'na' };
  assert.deepEqual(follow(file, a), { ...a, at: null, replaced: false, spaces: [] }, 'No log at all');
  const line = (event, old, next, rooms = ['shared'], time = 7) => fs.appendFileSync(file, JSON.stringify({ time, event, spaces: rooms, old, new: next }) + '\n', { mode: 0o600 });
  line('requested', { id: 'a', nativeId: 'na' }, null); line('failed', { id: 'a', nativeId: 'na' }, null);
  assert.deepEqual(follow(file, a), { ...a, at: null, replaced: false, spaces: [] }, 'Asked for, or failed: not a replacement');
  line('done', { id: 'a', nativeId: 'na' }, { id: 'b', nativeId: 'nb' });
  assert.deepEqual(follow(file, a), { sessionId: 'b', nativeId: 'nb', at: 7, replaced: true, spaces: ['shared'] });
  line('done', { id: 'b', nativeId: 'nb' }, { id: 'c', nativeId: 'nc' }, ['other'], 9);
  assert.deepEqual(follow(file, a), { sessionId: 'b', nativeId: 'nb', at: 7, replaced: true, spaces: ['shared'] }, 'One step, not the end of the chain');
  assert.deepEqual(follow(file, { sessionId: 'b', nativeId: 'nb' }), { sessionId: 'c', nativeId: 'nc', at: 9, replaced: true, spaces: ['other'] });
  line('kept', { id: 'c', nativeId: 'nc' }, { id: 'd', nativeId: 'nd' }, ['shared'], 11); line('kept', { id: 'c', nativeId: 'nc' }, { id: 'd', nativeId: 'nd' }, ['shared'], 13);
  assert.deepEqual(follow(file, { sessionId: 'c', nativeId: 'nc' }), { sessionId: 'c', nativeId: 'nc', at: 13, replaced: true, spaces: ['shared'] }, 'It stops at a session that is still in use, and says when that was last logged');
  line('done', { id: 'e', nativeId: 'ne' }, { id: 'f', nativeId: 'nf' }, ['shared'], null);
  assert.deepEqual(follow(file, { sessionId: 'e', nativeId: 'ne' }), { sessionId: 'e', nativeId: 'ne', at: null, replaced: true, spaces: ['shared'] }, 'A line with no time is not followed');
  assert.throws(() => follow(file, { sessionId: 'a' }), /Invalid secretary identity/);
  fs.chmodSync(file, 0o644);
  assert.throws(() => follow(file, a), error => error.uiMessage?.key === 'error.queue.secretaryState' || /secretary/i.test(error.message), 'A log others can read is not trusted');
});
