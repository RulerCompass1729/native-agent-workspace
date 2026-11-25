const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { Workspace } = require('../workspace.cjs');
const { OperatorControl, validate } = require('../operator-control.cjs');

async function fixture(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'operator-test-'))), runtimes = [], writes = [];
  const host = { binaries: {}, close() {}, create(s) {
    const r = new EventEmitter(); r.record = s; s.nativeId ||= randomUUID();
    r.operatorAvailable = true; r.chatAvailable = true;
    r.liveTurn = { id: 'turn-' + s.id, promptId: 'prompt-' + s.id };
    r.start = async () => { r.emit('model', 'fixture-native-model'); r.emit('state', 'idle'); await options.start?.(s, r); };
    r.send = async (text, tag) => { writes.push(text); r.emit('submitted', tag); };
    runtimes.push(r); return r;
  } };
  const w = new Workspace(host, root), id = await w.create('claude', root, 'owner', 'Initiator');
  t.after(() => { w.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const s = w.get(id), r = w.runtimes.get(id); s.nativePermissionMode = 'default';
  const identity = (record = s, runtime = r, callId = randomUUID()) => ({ nativeId: record.nativeId, turnId: runtime.liveTurn.id, promptId: runtime.liveTurn.promptId, callId });
  const call = (name, args, record = s, runtime = r, proof = identity(record, runtime)) => runtime.operatorCall(proof, 'workspace_' + name, args);
  const enable = () => { w.operatorAction(null, 'enabled', true); w.operatorAction(id, 'enabled', true); };
  const grant = (extra = {}) => w.operatorAction(id, 'grant', { providers: ['claude', 'codex'], directories: [root], permission: 'default', daily: 5, concurrent: 5, expiresAt: Date.now() + 60000, ...extra });
  const open = (extra = {}) => call('open', { action_id: randomUUID(), provider: 'claude', cwd: root, task: 'Synthetic pending task', permission: 'default', ...extra });
  const report = (opened, extra = {}, proof) => {
    const executor = w.get(opened.sessionId), runtime = w.runtimes.get(executor.id);
    return call('report', { request_id: opened.requestId, dispatch_id: opened.dispatchId, state: 'progress', body: 'Synthetic evidence reference', ...extra }, executor, runtime, proof || identity(executor, runtime));
  };
  return { w, root, id, s, r, identity, call, enable, grant, open, report, runtimes, writes };
}

const quotaSpec = (f, domainId, daily = 16, concurrent = 6, revision = 0) => ({ domainId, daily, concurrent, revision, nativeId: f.s.nativeId, consent: true });
test('human quota edits keep the same grant, usage, expiry and scope through disk reload', async t => {
  const f = await fixture(t); f.enable(); const id = f.grant({ daily: 8, concurrent: 6, space: 'shared' }); await f.open();
  const before = structuredClone(f.w.operator.data.domains[id]), records = JSON.stringify(f.w.operator.data.actions);
  const saved = f.w.operatorAction(f.id, 'quota', quotaSpec(f, id));
  assert.deepEqual([saved.id, saved.daily, saved.concurrent, saved.quotaRevision], [id, 16, 6, 1]);
  for (const key of Object.keys(before).filter(k => !['daily', 'concurrent'].includes(k))) assert.deepEqual(saved[key], before[key], key);
  assert.equal(JSON.stringify(f.w.operator.data.actions), records); assert.equal(f.runtimes.length, 2); assert.deepEqual(f.writes, []);
  f.w.operator = new OperatorControl(f.w); assert.equal(f.w.operator.error, null);
  const domain = f.w.snapshot().operatorPolicy.domains.find(d => d.id === id);
  assert.deepEqual([domain.daily, domain.concurrent, domain.usage.usedToday, domain.usage.concurrent], [16, 6, 1, 1]);
  assert.equal(f.w.operator.data.audit.at(-1).tool, 'operator_quota');
});
test('usage counts UTC reservations and uncertainty, preserves daily use when a session ends, and separates domains', async t => {
  const f = await fixture(t); f.enable(); const id = f.grant({ daily: 8, concurrent: 6 });
  const first = await f.open(), second = await f.open();
  const actions = Object.values(f.w.operator.data.actions); f.w.get(first.sessionId).state = 'ended';
  actions[0].startedAt = Date.now() - 86400000; actions[1].status = 'unconfirmed'; actions[1].sessionId = null;
  const empty = f.grant(); const domains = f.w.snapshot().operatorPolicy.domains;
  assert.deepEqual(domains.find(d => d.id === id).usage, { day: new Date().toISOString().slice(0, 10), usedToday: 1, concurrent: 1 });
  assert.deepEqual(domains.find(d => d.id === empty).usage, { day: new Date().toISOString().slice(0, 10), usedToday: 0, concurrent: 0 });
  actions[1].startedAt = null;
  assert.equal(f.w.operator.policy().domains.find(d => d.id === id).usage.usedToday, 1, 'An unknown reservation time stays charged conservatively');
  assert.equal(f.w.get(second.sessionId).state, 'idle');
});
test('lowering limits below used reservations blocks new creation and leaves existing sessions running', async t => {
  const f = await fixture(t); f.enable(); const id = f.grant({ daily: 8, concurrent: 6 }); const one = await f.open(), two = await f.open();
  f.w.operatorAction(f.id, 'quota', quotaSpec(f, id, 1, 1));
  await assert.rejects(f.open(), /quota/);
  assert.deepEqual([f.w.get(one.sessionId).state, f.w.get(two.sessionId).state], ['idle', 'idle']);
  assert.deepEqual([f.w.operator.policy().domains[0].usage.usedToday, f.w.operator.policy().domains[0].usage.concurrent], [2, 2]);
  assert.equal(f.runtimes.length, 3); assert.deepEqual(f.writes, []);
});
test('a stale quota revision cannot overwrite a newer human decision', async t => {
  const f = await fixture(t); f.enable(); const id = f.grant({ daily: 8, concurrent: 6 }), spec = quotaSpec(f, id);
  f.w.operatorAction(f.id, 'quota', spec); const before = fs.readFileSync(f.w.operator.file, 'utf8');
  assert.throws(() => f.w.operatorAction(f.id, 'quota', { ...spec, daily: 4 }), /changed|stale/);
  assert.equal(fs.readFileSync(f.w.operator.file, 'utf8'), before);
});
test('quota changes require fresh consent and accept only positive safe integer limits and the exact scope', async t => {
  const f = await fixture(t); f.enable(); const id = f.grant(), before = fs.readFileSync(f.w.operator.file, 'utf8');
  for (const delta of [{ consent: false }, { consent: 1 }, { daily: 0 }, { daily: -1 }, { daily: 1.5 }, { daily: '16' }, { daily: Infinity }, { concurrent: 0 }, { concurrent: 9007199254740992 }, { revision: -1 }, { permission: 'bypass' }, { expiresAt: Date.now() + 86400000 }, { space: 'shared' }]) {
    assert.throws(() => f.w.operatorAction(f.id, 'quota', { ...quotaSpec(f, id), ...delta }), /quota|consent|Invalid|Explicit|changed/i, JSON.stringify(delta));
    assert.equal(fs.readFileSync(f.w.operator.file, 'utf8'), before);
  }
});
for (const reason of ['revoked', 'expired', 'native', 'ended', 'pending', 'foreign']) test('quota change refuses an invalid grant or holder before writing: ' + reason, async t => {
  const f = await fixture(t); f.enable(); const id = f.grant(), spec = quotaSpec(f, id);
  if (reason === 'revoked') f.w.operatorAction(f.id, 'revoke', id);
  if (reason === 'expired') f.w.operator.data.domains[id].expiresAt = Date.now() - 1;
  if (reason === 'native') f.s.nativeId = 'different-native';
  if (reason === 'ended') f.s.state = 'ended';
  if (reason === 'pending') f.s.nativeContextPending = true;
  if (reason === 'foreign') f.w.operator.data.domains[id].initiators = [{ id: 'another', nativeId: f.s.nativeId }];
  const before = fs.readFileSync(f.w.operator.file, 'utf8');
  assert.throws(() => f.w.operatorAction(f.id, 'quota', spec), /changed|stale|expired|revoked|holder/i);
  assert.equal(fs.readFileSync(f.w.operator.file, 'utf8'), before);
});
test('native tools and background actors cannot adjust quotas, even with forged consent', async t => {
  const f = await fixture(t); f.enable(); const id = f.grant(), spec = quotaSpec(f, id), before = fs.readFileSync(f.w.operator.file, 'utf8');
  await assert.rejects(f.call('quota', spec), /Invalid operator tool|Unknown operator tool/);
  const actor = { id: f.id, nativeId: f.s.nativeId, name: 'Synthetic actor', provider: 'claude', callId: 'quota-call', turnId: 'quota-turn', operationId: 'quota-operation' };
  assert.throws(() => require('../background-operation.cjs').run(actor, () => f.w.operatorAction(f.id, 'quota', spec)), /person|human|真人|本人/i);
  assert.equal(fs.readFileSync(f.w.operator.file, 'utf8'), before);
});
test('a failed quota save does not acknowledge or change the authoritative grant', async t => {
  const f = await fixture(t); f.enable(); const id = f.grant(), real = f.w.operator.file, before = fs.readFileSync(real, 'utf8');
  const block = path.join(f.root, 'quota-rename-block'); fs.mkdirSync(block); f.w.operator.file = block;
  assert.throws(() => f.w.operatorAction(f.id, 'quota', quotaSpec(f, id)), /not saved/);
  assert.equal(f.w.operator.data.domains[id].daily, 5); assert.equal(fs.readFileSync(real, 'utf8'), before);
});
for (const revision of [-1, 1.5, '1']) test('a malformed saved quota revision fails closed on reload: ' + revision, async t => {
  const f = await fixture(t); f.enable(); const id = f.grant(), data = structuredClone(f.w.operator.data); data.domains[id].quotaRevision = revision;
  fs.writeFileSync(f.w.operator.file, JSON.stringify(data), { mode: 0o600 }); const restored = new OperatorControl(f.w);
  assert.match(restored.error, /could not be read/); assert.equal(restored.policy().enabled, false);
});
test('pending creation projects existing coverage without granting, creating or writing a record', async t => {
  const f = await fixture(t); f.enable(); await f.open({ action_id: 'pending-card' });
  const row = () => f.w.snapshot().sessions.find(s => s.id === f.id).messages.find(m => m.operator?.actionKey);
  assert.equal(row().operator.coveredDomainId, null);
  const grant = f.grant(), before = fs.readFileSync(f.w.operator.file, 'utf8');
  assert.equal(row().operator.coveredDomainId, grant);
  assert.equal(f.runtimes.length, 1); assert.deepEqual(f.writes, []);
  assert.equal(fs.readFileSync(f.w.operator.file, 'utf8'), before);
  f.w.operatorAction(f.id, 'revoke', grant);
  assert.equal(row().operator.coveredDomainId, null);
});
for (const change of ['expired', 'native', 'provider', 'directory', 'permission', 'disabled']) test('creation coverage stays absent after ' + change, async t => {
  const f = await fixture(t); f.enable(); await f.open({ action_id: 'pending-card' }); const id = f.grant();
  const domain = f.w.operator.data.domains[id];
  if (change === 'expired') domain.expiresAt = Date.now() - 1;
  if (change === 'native') f.s.nativeId = 'replacement-native';
  if (change === 'provider') domain.providers = ['codex'];
  if (change === 'directory') domain.directories = [path.join(f.root, 'other')];
  if (change === 'permission') f.s.nativePermissionMode = 'unknown';
  if (change === 'disabled') f.w.operatorAction(f.id, 'enabled', false);
  const before = fs.readFileSync(f.w.operator.file, 'utf8');
  const row = f.w.snapshot().sessions.find(s => s.id === f.id).messages.find(m => m.operator?.actionKey);
  assert.equal(row.operator.coveredDomainId, null);
  assert.equal(f.runtimes.length, 1); assert.equal(fs.readFileSync(f.w.operator.file, 'utf8'), before);
});

test('workspace_open defaults Codex to terminal and preserves explicit chat without delivering its task', async t => {
  const f = await fixture(t); f.enable(); const grant_id = f.grant();
  for (const view of [undefined, 'chat']) {
    const opened = await f.open({ provider: 'codex', grant_id, ...(view ? { view } : {}) });
    const s = f.w.get(opened.sessionId);
    assert.equal(s.view, view || 'terminal'); assert.equal(s.skipPermissions, undefined);
    assert.deepEqual(s.operatorCreation, { permission: 'default' });
  }
  assert.equal(f.runtimes.length, 3); assert.deepEqual(f.writes, []);
});

test('default disabled; explicit complete grant; creation is idempotent and never delivers initial task', async t => {
  const f = await fixture(t);
  await assert.rejects(f.open(), /not enabled/); f.enable();
  assert.throws(() => f.grant({ daily: undefined }), /Explicit/);
  const grant = f.grant(), args = { action_id: 'one-action', grant_id: grant };
  const first = await f.open(args), second = await f.open(args);
  assert.equal(first.status, 'created'); assert.equal(first.sessionId, second.sessionId); assert.equal(f.runtimes.length, 2);
  assert.equal(first.model, 'fixture-native-model'); assert.equal(first.delivery, 'pending-1b'); assert.equal(f.writes.length, 0);
  assert.equal(f.w.get(first.sessionId).owner, null); assert.equal(f.w.get(first.sessionId).view, 'chat');
  assert.deepEqual(f.w.get(first.sessionId).operatorCreation, { permission: 'default' });
  await assert.rejects(f.call('sessions', {}, f.w.get(first.sessionId), f.w.runtimes.get(first.sessionId)), /not enabled/);
  await assert.rejects(f.open({ ...args, task: 'Changed action' }), /different arguments/);
  const saved = JSON.parse(fs.readFileSync(f.w.operator.file));
  assert.equal(Object.keys(saved.actions).length, 1); assert.equal(saved.dispatches[first.dispatchId].executorNativeId, f.w.get(first.sessionId).nativeId);
});

test('missing grant yields existing-record confirmation, exact human grant creates once without a native turn', async t => {
  const f = await fixture(t); f.enable(); const pending = await f.open({ action_id: 'confirm' });
  assert.equal(pending.status, 'pending-authorization'); assert.equal(f.runtimes.length, 1);
  const row = f.w.snapshot().sessions.find(s => s.id === f.id).messages.find(m => m.operator?.creation === 'pending-authorization');
  assert.ok(row.operator.actionKey); assert.match(row.text, /Synthetic pending task/);
  const grant = f.grant(); const result = await f.w.operatorAction(f.id, 'authorize', { key: row.operator.actionKey, domainId: grant });
  assert.equal(result.status, 'created'); assert.equal(f.writes.length, 0);
  await assert.rejects(async () => f.w.operatorAction(f.id, 'authorize', { key: row.operator.actionKey, domainId: grant }), /stale/);
});

test('current native identity/turn/prompt/capability enforced independently of peer and permission revisions', async t => {
  const f = await fixture(t); f.enable(); f.grant(); const opened = await f.open();
  const s = f.w.get(opened.sessionId), r = f.w.runtimes.get(s.id), valid = f.identity(s, r);
  for (const field of ['nativeId', 'turnId', 'promptId']) await assert.rejects(f.report(opened, {}, { ...valid, [field]: 'wrong' }), /root turn/);
  r.operatorAvailable = false; await assert.rejects(f.report(opened), /root turn/); r.operatorAvailable = true;
  r.retainedReader = true; await assert.rejects(f.report(opened), /root turn/); r.retainedReader = false;
  s.peerRevision = 90; s.controlRevision = 80; s.state = 'approval';
  assert.equal((await f.report(opened)).status, 'saved');
  const wrongRequest = randomUUID(); await assert.rejects(f.report(opened, { request_id: wrongRequest }), /does not belong/);
  await assert.rejects(f.call('report', { request_id: opened.requestId, dispatch_id: opened.dispatchId, state: 'progress', body: 'Impersonated' }), /does not belong/);
});

test('report ACK is durable; duplicate call does not add a report; cold restore never creates or sends', async t => {
  const f = await fixture(t); f.enable(); f.grant(); const opened = await f.open();
  const s = f.w.get(opened.sessionId), r = f.w.runtimes.get(s.id), proof = f.identity(s, r);
  const result = await f.report(opened, {}, proof), saved = JSON.parse(fs.readFileSync(f.w.operator.file));
  assert.equal(saved.reports[result.reportId].body, 'Synthetic evidence reference');
  assert.equal((await f.report(opened, {}, proof)).status, 'duplicate'); assert.equal(Object.keys(f.w.operator.data.reports).length, 1);
  const restored = new OperatorControl(f.w); assert.equal(restored.data.reports[result.reportId].version, 1);
  assert.equal(Object.keys(restored.data.actions).length, 1); assert.equal(f.writes.length, 0); assert.equal(f.runtimes.length, 2);
});

test('save failure never ACKs or changes authoritative report state; uncertain rename never permits blind retry', async t => {
  const f = await fixture(t); f.enable(); f.grant(); const opened = await f.open();
  const before = fs.readFileSync(f.w.operator.file, 'utf8'), real = f.w.operator.file;
  const dir = path.join(f.root, 'rename-block'); fs.mkdirSync(dir); f.w.operator.file = dir;
  await assert.rejects(f.report(opened), /not saved/); assert.equal(Object.keys(f.w.operator.data.reports).length, 0);
  assert.equal(fs.readFileSync(real, 'utf8'), before); await assert.rejects(f.report(opened), /not saved/);
  f.w.operator = new OperatorControl(f.w);
  const sync = fs.fsyncSync; fs.fsyncSync = fd => { if (fs.fstatSync(fd).isDirectory()) throw Error('Synthetic directory sync failure'); return sync(fd); };
  try { await assert.rejects(f.report(opened), /unconfirmed/); } finally { fs.fsyncSync = sync; }
  assert.equal(Object.keys(f.w.operator.data.reports).length, 0);
  const restored = new OperatorControl(f.w); assert.equal(Object.keys(restored.data.reports).length, 1);
  await assert.rejects(f.report(opened), /unconfirmed/);
});

test('six states, exact question text, omission/null/ready; only explicit accepted/cancelled closes', async t => {
  const f = await fixture(t); f.enable(); f.grant(); const opened = await f.open(), op = f.w.operator;
  const view = () => op.view(op.data.requests[opened.requestId]);
  for (const state of ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']) {
    await f.report(opened, { state }); assert.equal(view().reportState, state); assert.equal(view().state === 'closed', false);
  }
  for (const state of [undefined, 'done', '', null]) await assert.rejects(f.report(opened, { state }), /state/);
  for (const question of [null, 'A question']) await assert.rejects(f.report(opened, { state: 'ready', question }), /ready/);
  const question = '  Exact question 中文\nunchanged?  ';
  await f.report(opened, { question }); assert.equal(view().question, question); assert.equal(view().state, 'question');
  await f.report(opened, { state: 'waiting' }); assert.equal(view().question, question);
  await f.report(opened, { question: null }); assert.equal(view().question, null);
  await f.report(opened, { question }); await f.report(opened, { state: 'ready' }); assert.equal(view().question, null); assert.equal(view().state, 'ready');
  f.w.operatorAction(f.id, 'close', { requestId: opened.requestId, reason: 'accepted' }); assert.equal(view().closedReason, 'accepted');
  await assert.rejects(f.report(opened), /closed/); assert.ok(Object.keys(op.data.reports).length > 6);
});

test('both request endings void undelivered tasks in the human view and initiator session metadata', async t => {
  const f = await fixture(t); f.enable(); f.grant();
  for (const reason of ['accepted', 'cancelled']) {
    const opened = await f.open({ action_id: reason }), op = f.w.operator;
    const view = () => op.view(op.data.requests[opened.requestId]);
    const listed = async () => (await f.call('sessions', {})).requests.find(r => r.id === opened.requestId);
    assert.equal(view().delivery, 'pending'); assert.equal((await listed()).delivery, 'pending');
    if (reason === 'accepted') await f.report(opened, { state: 'ready' });
    f.w.operatorAction(f.id, 'close', { requestId: opened.requestId, reason });
    assert.equal(view().delivery, 'voided'); assert.equal((await listed()).delivery, 'voided');
    assert.equal((await f.open({ action_id: reason })).delivery, 'voided');
    await assert.rejects(f.report(opened), /closed/);
  }
  assert.equal(f.writes.length, 0);
});

test('proven GUI/mobile/terminal inputs update attention; unknown or automatic input does not impersonate the person', async t => {
  const f = await fixture(t); f.enable(); f.grant(); const opened = await f.open(), op = f.w.operator;
  const s = f.w.get(opened.sessionId), r = f.w.runtimes.get(s.id), view = () => op.view(op.data.requests[opened.requestId]);
  await f.report(opened, { state: 'blocked', question: 'Answer in executor' });
  r.emit('nativeInput', 'Unknown source', { id: randomUUID() }); assert.equal(view().state, 'question');
  r.emit('nativeInput', 'Automatic message', { id: randomUUID(), source: 'naw-peer' }); assert.equal(view().state, 'question');
  r.emit('nativeInput', 'Proven person', { id: randomUUID(), source: 'user' }); assert.equal(view().state, 'answered'); assert.equal(view().attention, false); assert.equal(view().question, 'Answer in executor');
  for (const origin of ['agent-wake', 'capacity-recovery', 'room']) {
    await f.report(opened, { question: 'New exact question' }); const id = randomUUID(); s.messages.push({ id, role: 'user', origin }); r.emit('submitted', id); assert.equal(view().state, 'question');
  }
  for (const origin of ['human', 'human-mobile']) {
    await f.report(opened, { question: 'New exact question' }); const id = randomUUID(); s.messages.push({ id, role: 'user', origin }); r.emit('submitted', id); assert.equal(view().state, 'answered');
  }
  await f.report(opened, { state: 'dropped', question: null }); assert.equal(view().state, 'attention');
  await f.report(opened, { state: 'progress' }); assert.equal(view().state, 'processing');
  f.w.operatorAction(f.id, 'close', { requestId: opened.requestId, reason: 'cancelled' }); assert.equal(view().state, 'closed'); assert.equal(view().question, null); assert.equal(view().closedReason, 'cancelled');
});

test('T53: marking an unanswered report as read preserves its pending question and attention', async t => {
  const f = await fixture(t); f.enable(); f.grant(); const opened = await f.open(), op = f.w.operator;
  await f.report(opened, { state: 'blocked', question: 'Synthetic unresolved decision' });
  const request = () => op.data.requests[opened.requestId], view = () => op.view(request());
  const before = view();
  assert.equal(before.state, 'question'); assert.equal(before.attention, true); assert.equal(before.unread, 1);
  const writes = f.writes.slice();
  for (let i = 0; i < 2; i++) {
    f.w.operatorAction(f.id, 'read', opened.requestId);
    assert.deepEqual(view(), { ...before, unread: 0 });
    assert.equal(request().closed, undefined);
    const row = op.rows(f.id).find(row => row.operator?.requestId === opened.requestId);
    assert.equal(row.operator.unread, false); assert.equal(row.operator.attention, true);
    assert.equal(row.operator.question, before.question); assert.equal(row.operator.state, 'question');
  }
  assert.deepEqual(f.writes, writes, 'Reading does not send an answer or a new task');
  f.w.operatorAction(f.id, 'close', { requestId: opened.requestId, reason: 'cancelled' });
  assert.equal(view().state, 'closed'); assert.equal(view().attention, false);
});

test('late old dispatch reports keep their own immutable version and cannot clear the current question', async t => {
  const f = await fixture(t); f.enable(); f.grant(); const opened = await f.open(), op = f.w.operator;
  const newer = randomUUID(); op.commit(data => { const old = data.dispatches[opened.dispatchId]; data.dispatches[newer] = { ...old, id: newer, version: 2 }; Object.assign(data.requests[opened.requestId], { version: 2, currentDispatchId: newer }); });
  const v2 = { ...opened, dispatchId: newer };
  await f.report(v2, { question: 'Current question' });
  for (const state of ['ready', 'blocked']) { const result = await f.report(opened, { state }); assert.equal(result.version, 1); assert.equal(op.view(op.data.requests[opened.requestId]).question, 'Current question'); }
  assert.equal((await f.report(v2)).version, 2);
  await assert.rejects(f.report(opened, { version: 9 }), /arguments/);
  const oldRow = op.rows(f.id).find(m => m.operator?.old); assert.equal(oldRow.operator.reportVersion, 1); assert.equal(oldRow.operator.actionable, false);
});

test('expiry, domain/session/global revocation preserve saved markers and reject new reports without ending native sessions', async t => {
  for (const mode of ['expiry', 'domain', 'session', 'executor', 'global']) {
    const f = await fixture(t); f.enable(); const grant = f.grant(); const opened = await f.open(); await f.report(opened, { question: 'Still recorded' });
    if (mode === 'expiry') f.w.operator.commit(data => { data.domains[grant].expiresAt = Date.now() - 1; });
    else if (mode === 'domain') f.w.operatorAction(f.id, 'revoke', grant);
    else f.w.operatorAction(mode === 'global' ? null : mode === 'executor' ? opened.sessionId : f.id, 'enabled', false);
    await assert.rejects(f.report(opened), /revoked|expired/);
    const view = f.w.operator.view(f.w.operator.data.requests[opened.requestId]); assert.equal(view.question, 'Still recorded'); assert.equal(view.cannotUpdate, true);
    assert.equal(f.w.get(opened.sessionId).state, 'idle');
  }
});

test('quotas aggregate by domain; concurrent uncertainty is counted; expiry and permission do not fall back to implicit grants', async t => {
  const f = await fixture(t); f.enable(); const grant = f.grant({ daily: 2, concurrent: 1 }); const opened = await f.open();
  await assert.rejects(f.open(), /quota/); f.w.get(opened.sessionId).state = 'ended';
  const second = await f.open(); f.w.get(second.sessionId).state = 'ended'; await assert.rejects(f.open(), /quota/);
  f.s.nativePermissionMode = 'plan'; assert.throws(() => f.grant(), /ceiling/);
  f.s.nativePermissionMode = 'default'; assert.throws(() => f.grant({ permission: 'bypass' }), /cannot exceed/);
  const bypass = await f.open({ permission: 'bypass', grant_id: grant }); assert.equal(bypass.status, 'pending-authorization');
  f.s.nativePermissionMode = 'bypassPermissions'; const explicit = f.grant({ permission: 'bypass', concurrent: 1 });
  const created = await f.open({ permission: 'bypass', grant_id: explicit }); assert.equal(f.w.get(created.sessionId).skipPermissions, true);
});

test('metadata read has no private chat, draft, terminal, approval or credentials; actual unknown stays unknown', async t => {
  const f = await fixture(t); f.enable(); f.grant();
  f.s.messages.push({ id: 'secret', text: 'PRIVATE BODY', role: 'user' }); f.w.drafts.set(f.id, 'PRIVATE DRAFT'); f.s.approval = { secret: 'PRIVATE APPROVAL' };
  const other = await f.w.create('codex', f.root, null, 'Visible metadata'); f.w.runtimes.delete(other);
  const result = await f.call('sessions', {}), raw = JSON.stringify(result);
  for (const secret of ['PRIVATE BODY', 'PRIVATE DRAFT', 'PRIVATE APPROVAL']) assert.equal(raw.includes(secret), false);
  assert.equal(result.sessions.find(s => s.id === other).state, 'unknown'); assert.equal(result.sessions.find(s => s.id === other).canReport, false);
  const opened = await f.open({ provider: 'codex' }); assert.equal(opened.canReport, false);
  delete f.w.get(opened.sessionId).model; assert.equal(f.w.operator.openResult(Object.values(f.w.operator.data.actions).at(-1)).model, 'unknown');
});

test('same-space report mirrors are fixed on save; new membership does not back-share and abnormal turns retain reports', async t => {
  const f = await fixture(t); f.enable(); f.grant(); const opened = await f.open();
  f.w.get(f.id).roomId = 'shared'; f.w.get(opened.sessionId).roomId = 'shared';
  const saved = await f.report(opened, { state: 'ready' }); const s = f.w.get(opened.sessionId), r = f.w.runtimes.get(s.id);
  r.emit('nativeTurnEnd', { nativeId: s.nativeId, turnId: r.liveTurn.id, status: 'failed' });
  let snapshot = f.w.snapshot(); const row = snapshot.room.messages.find(m => m.operator?.reportId === saved.reportId);
  assert.equal(row.operator.turnAbnormal, true); assert.equal(row.operator.executorId, opened.sessionId); assert.equal(row.sessionId, undefined);
  assert.equal(snapshot.sessions.find(s => s.id === f.id).messages.filter(m => m.operator?.reportId === saved.reportId).length, 1);
  f.w.get(f.id).roomId = null; snapshot = f.w.snapshot(); assert.equal(snapshot.room.messages.filter(m => m.operator?.reportId === saved.reportId).length, 1);
});
test('a report\'s turn that native ended normally but NAW could not confirm whole is not called abnormal (steward step 2, batch 0)', async t => {
  const f = await fixture(t); f.enable(); f.grant(); const opened = await f.open();
  const saved = await f.report(opened, { state: 'ready' }); const s = f.w.get(opened.sessionId), r = f.w.runtimes.get(s.id);
  const abnormal = () => f.w.operator.data.reports[saved.reportId].turnAbnormal === true;
  r.emit('nativeTurnEnd', { nativeId: s.nativeId, turnId: r.liveTurn.id, status: 'incomplete' });
  assert.equal(abnormal(), false, '「所在原生回合未正常结束」 would be untrue');
  r.emit('nativeTurnEnd', { nativeId: s.nativeId, turnId: r.liveTurn.id, status: 'failed' });
  assert.equal(abnormal(), true);
});

test('uncertain creation is durably reserved before runtime allocation and is never repeated after restoration', async t => {
  const f = await fixture(t, { start: s => { if (s.name === 'Uncertain executor') throw Error('Synthetic native boot lost'); } });
  f.enable(); f.grant(); await assert.rejects(f.open({ action_id: 'uncertain', name: 'Uncertain executor' }), /boot lost/);
  const action = Object.values(f.w.operator.data.actions)[0]; assert.equal(action.status, 'unconfirmed'); assert.ok(action.sessionId);
  const disk = JSON.parse(fs.readFileSync(path.join(f.root, 'workspace.json'))); assert.ok(disk.sessions.some(s => s.id === action.sessionId));
  f.w.operator = new OperatorControl(f.w); assert.equal((await f.open({ action_id: 'uncertain', name: 'Uncertain executor' })).status, 'unconfirmed'); assert.equal(f.runtimes.length, 2); assert.equal(f.writes.length, 0);
});

test('schema rejects oversize, malformed state/question, hidden caller/version and an arbitrary model selector', () => {
  for (const args of [{}, { state: 'done' }, { state: 'ready', question: null }, { state: 'progress', body: 'x'.repeat(8001) }, { state: 'progress', version: 1 }])
    assert.throws(() => validate('workspace_report', { request_id: 'request', dispatch_id: 'dispatch', body: 'body', ...args }));
  assert.throws(() => validate('workspace_open', { action_id: 'a', provider: 'claude', cwd: '/tmp', task: 'task', permission: 'default', model: 'chosen-by-agent' }));
  assert.throws(() => validate('workspace_sessions', { caller_id: 'self-claimed' }));
});

test('visible retained backend metadata is whitelisted; unavailable and duplicate ownership remain unknown', async t => {
  const f = await fixture(t); f.enable();
  const backend = 'backends/aaaaaaaaaaaaaaaaaaaa'; fs.mkdirSync(path.join(f.root, backend), { recursive: true, mode: 0o700 }); fs.chmodSync(path.join(f.root, 'backends'), 0o700);
  fs.writeFileSync(path.join(f.root, 'services.json'), JSON.stringify({ format: 1, active: '.', entries: ['.', backend] }), { mode: 0o600 });
  const closed = [];
  f.w.peerRunner = { root: () => f.root, connect: async () => ({ close: () => closed.push(true), call: async method => {
    assert.equal(method, 'initial'); return { sessions: [{ id: 'visible-peer', name: 'Metadata only', provider: 'claude', state: 'idle', messages: [{ text: 'PRIVATE PEER CHAT' }], liveDraft: 'PRIVATE PEER DRAFT' }, { ...f.s, messages: [{ text: 'DUPLICATE PRIVATE CHAT' }] }] };
  } }) };
  let result = await f.call('sessions', {}); assert.equal(result.sessions.find(s => s.id === 'visible-peer').canReport, false); assert.equal(result.sessions.find(s => s.id === f.id).state, 'unknown');
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false); assert.equal(closed.length, 1);
  f.w.peerRunner.connect = async () => { throw Error('Synthetic unavailable backend'); };
  result = await f.call('sessions', {}); assert.equal(result.metadataIncomplete, true); assert.ok(result.sessions.some(s => s.id === f.id));
});

test("a space's project manager is told of its own space's sessions only, here and on other backends", async t => {
  const f = await fixture(t); f.enable(); f.grant();
  const ONE = '11111111-1111-1111-1111-111111111111', TWO = '22222222-2222-2222-2222-222222222222', mate = await f.w.create('codex', f.root, 'owner', 'Mate'), other = await f.w.create('codex', f.root, 'owner', 'Other');
  for (const [id, ...rooms] of [[f.id, ONE], [mate, ONE], [other, TWO]]) Object.assign(f.w.get(id), { roomIds: rooms, roomId: null });
  const backend = 'backends/aaaaaaaaaaaaaaaaaaaa'; fs.mkdirSync(path.join(f.root, backend), { recursive: true, mode: 0o700 }); fs.chmodSync(path.join(f.root, 'backends'), 0o700);
  fs.writeFileSync(path.join(f.root, 'services.json'), JSON.stringify({ format: 1, active: '.', entries: ['.', backend] }), { mode: 0o600 });
  const far = (id, ...rooms) => ({ id, name: id, provider: 'claude', state: 'idle', roomIds: rooms, roomId: null });
  f.w.peerRunner = { root: () => f.root, connect: async () => ({ close() {}, call: async () => ({ sessions: [far('far-mate', ONE), far('far-other', TWO), far('far-independent')] }) }) };
  const listed = async () => (await f.call('sessions', {})).sessions.map(s => s.id).sort();
  const everyone = [f.id, mate, other, 'far-mate', 'far-other', 'far-independent'].sort(), own = [f.id, mate, 'far-mate'].sort();
  assert.deepEqual(await listed(), everyone, 'a member that manages nothing');
  const { SpaceManagers } = require('../space-managers.cjs'), managers = new SpaceManagers(f.root);
  managers.set(ONE, { sessionId: f.id, nativeId: f.s.nativeId });
  assert.deepEqual(await listed(), own);
  f.s.roomIds = [TWO];
  assert.deepEqual(await listed(), everyone, 'the role counts only in its space');
  f.s.roomIds = [ONE]; managers.set(ONE, null);
  assert.deepEqual(await listed(), everyone, 'revoked');
  fs.writeFileSync(managers.file, '{broken', { mode: 0o600 });
  assert.deepEqual(await listed(), own, 'a record that cannot be read: the sessions it shares a space with');
});

test('semantically corrupt private journal fails closed without overwriting it or preventing ordinary session snapshots', async t => {
  const f = await fixture(t); const bytes = JSON.stringify({ ...f.w.operator.data, reports: { broken: { id: 'broken', dispatchId: 'missing' } } });
  fs.writeFileSync(f.w.operator.file, bytes, { mode: 0o600 }); f.w.operator = new OperatorControl(f.w);
  assert.match(f.w.operator.error, /could not be read/); assert.equal(f.w.snapshot().operatorPolicy.enabled, false);
  assert.throws(() => f.w.operator.settings(null, true), /could not be read/); assert.equal(fs.readFileSync(f.w.operator.file, 'utf8'), bytes);
});

test('snapshot insertion preserves original native and imported-source order even when timestamps differ', async t => {
  const f = await fixture(t); f.enable(); f.grant();
  f.s.messages = [{ id: 'first-native', role: 'assistant', time: 20, text: 'First native source row' }, { id: 'second-native', role: 'assistant', time: 10, text: 'Second native source row' }];
  f.w.room.messages = [{ id: 'first-import', snapshotBatch: 'one', time: 20 }, { id: 'second-import', snapshotBatch: 'two', time: 10 }];
  const original = ['first-native', 'second-native'], imported = ['first-import', 'second-import'];
  assert.deepEqual(f.w.snapshot().sessions.find(s => s.id === f.id).messages.map(m => m.id), original);
  assert.deepEqual(f.w.snapshot().room.messages.map(m => m.id), imported);
  const opened = await f.open(); f.s.roomId = 'shared'; f.w.get(opened.sessionId).roomId = 'shared'; await f.report(opened);
  const snapshot = f.w.snapshot();
  assert.deepEqual(snapshot.sessions.find(s => s.id === f.id).messages.filter(m => !m.operator).map(m => m.id), original);
  assert.deepEqual(snapshot.room.messages.filter(m => !m.operator).map(m => m.id), imported);
  assert.deepEqual(snapshot.rooms[0].messages.filter(m => !m.operator).map(m => m.id), imported);
  assert.equal(snapshot.room.messages.filter(m => m.operator).length, 1);
});

test('exporting a decorated shared report keeps its body but cannot export control authority or private session messages', async t => {
  const f = await fixture(t); f.enable(); f.grant(); const opened = await f.open(); f.s.roomId = 'shared'; f.w.get(opened.sessionId).roomId = 'shared';
  await f.report(opened); f.s.messages.push({ id: 'private', role: 'user', text: 'PRIVATE CONVERSATION MUST NOT EXPORT' });
  const snapshot = f.w.snapshot(), room = { ...snapshot.room, revision: 0, metadataRevision: 0, name: 'Synthetic room', notes: '', files: [], events: [] };
  const captured = require('../space-merge.cjs').captureSource(room, snapshot.sessions);
  assert.equal(captured.rows.length, 1); assert.match(captured.rows[0].payload.text, /Synthetic evidence reference/);
  assert.equal(Object.hasOwn(captured.rows[0].payload, 'operator'), false); assert.equal(JSON.stringify(captured).includes('PRIVATE CONVERSATION'), false);
});

test('created receipt durably includes the actual native executor identity, before the ordinary deferred workspace save', async t => {
  const f = await fixture(t); f.enable(); f.grant(); const opened = await f.open({ provider: 'codex' });
  const disk = JSON.parse(fs.readFileSync(path.join(f.root, 'workspace.json'))), saved = disk.sessions.find(s => s.id === opened.sessionId);
  assert.equal(saved.nativeId, f.w.get(opened.sessionId).nativeId);
  assert.equal(saved.nativeId, f.w.operator.data.dispatches[opened.dispatchId].executorNativeId);
  const restarted = new Workspace({ binaries: {}, close() {} }, f.root); t.after(() => restarted.close());
  assert.equal(restarted.get(opened.sessionId).nativeId, saved.nativeId); assert.equal(Object.values(restarted.operator.data.actions)[0].status, 'created');
});
