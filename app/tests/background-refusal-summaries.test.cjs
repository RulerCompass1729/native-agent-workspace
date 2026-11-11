const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { randomUUID } = require('node:crypto');
const { BackgroundControl, dialog } = require('../background-control.cjs');
const { RoomState } = require('../room-state.cjs');
const request = (method, id = randomUUID(), args = []) => ({ action: 'invoke', method, arguments: args, operation_id: id });
const nextId = () => randomUUID();
function fixture(t, provider = 'codex') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-refusal-summary-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const actor = { id: 'agent', nativeId: 'native-agent', name: 'Synthetic Agent', provider }, room = new RoomState(dir);
  let clock = 60000, auditRooms = ['shared'], writes = 0;
  const snapshot = { sessions: [{ ...actor }, { id: 'target', nativeId: 'native-target' }] }, notices = [], audits = [];
  const context = { background: true, view: {}, client: { snapshot: () => snapshot, close() {} }, win: { destroy() {} }, checkActor() {}, refresh: async () => {},
    confirmationActors: () => snapshot.sessions,
    fingerprint: () => ({ auditRooms, sessions: snapshot.sessions.map(s => ({ id: s.id, nativeId: s.nativeId, archived: s.archived, nativeContextPending: s.nativeContextPending })) }) };
  const handlers = new Map([['spaceCreate', () => ++writes], ['plain', () => ++writes], ['input', () => ++writes], ['stop', async c => { await dialog(c, 'message', { message: 'Stop?', buttons: ['Cancel', 'Stop'], cancelId: 0 }); return ++writes; }]]);
  const binding = { sender: actor, identity: { callId: 'native-call', turnId: 'native-turn' }, valid: () => true };
  const config = { dataDir: dir, handlers, context: () => context, now: () => clock,
    confirmation: () => ({ message: 'Create?', buttons: ['Cancel', 'Create'], cancelId: 0 }), confirmationPending: row => notices.push(row),
    audit: row => { audits.push(row); room.recordControlOperation(row, row.guard?.auditRooms || ['shared']); } };
  const controller = new BackgroundControl(config);
  return { dir, actor, room, snapshot, context, handlers, config, controller, binding, notices, audits,
    setTime: value => { clock = value; }, setRooms: value => { auditRooms = value; }, get writes() { return writes; } };
}
async function fill(f) {
  const row = await f.controller.call(f.binding, request('spaceCreate', 'seed', ['Small'])); assert.equal(row.state, 'confirmation-required');
  f.controller.commit(data => { for (let n = 1; n < 32; n++) { const copy = JSON.parse(JSON.stringify(row)); copy.id = 'seed-' + n; copy.command.operation_id = copy.id; copy.actor.operationId = copy.id; data.records.push(copy); } });
  f.notices.length = 0;
}
for (const provider of ['claude', 'codex']) for (const reason of ['confirmation-limit', 'originating-session-unavailable']) test(`${provider}: repeated ${reason} requests store one small counted summary without arguments`, async t => {
  const f = fixture(t, provider); if (reason === 'confirmation-limit') await fill(f); else f.snapshot.sessions[0].archived = true;
  const before = fs.existsSync(f.controller.file) ? fs.statSync(f.controller.file).size : 0, marker = 'SYNTHETIC_LARGE_REFUSED_PAYLOAD', body = marker + 'x'.repeat(120 * 1024);
  let id = 'first', last;
  for (let n = 0; n < 40; n++) {
    last = await f.controller.call(f.binding, request(n % 2 ? 'stop' : 'spaceCreate', id, ['target', body]));
    assert.equal(last.state, 'not-executed'); assert.equal(last.reason, reason); assert.equal(last.confirmation, undefined); id = nextId(last);
  }
  const text = fs.readFileSync(f.controller.file, 'utf8');
  t.diagnostic(JSON.stringify({ calls: 40, beforeBytes: before, afterBytes: Buffer.byteLength(text), ordinaryRows: f.controller.data.records.length, summaryRows: f.controller.data.refusals?.length || 0, spaceEvents: f.room.value.events.length, handlersExecuted: f.writes, newNotifications: f.notices.length }));
  assert.equal(text.includes(marker), false);
  assert.ok(Buffer.byteLength(text) - before < 64 * 1024); assert.equal(f.controller.data.refusals.length, 1);
  const summary = f.controller.data.refusals[0]; assert.equal(summary.refusalSummary.count, 40);
  assert.equal(f.room.value.events.filter(e => e.controlAudit?.refusalSummary).length, 1);
  assert.equal(f.room.value.events.at(-1).controlAudit.refusalSummary.count, 40);
  assert.equal(f.notices.length, 0); assert.equal(f.writes, 0);
  assert.equal((await f.controller.call(f.binding, { action: 'receipt', operation_id: last.summaryId })).receipt.refusalSummary.count, 40);
});
test('a compacted refused ID is a new request after a restart and still requires current consent', async t => {
  const f = fixture(t); await fill(f); const args = request('spaceCreate', 'rejected-original', ['Space']);
  const refused = await f.controller.call(f.binding, args); assert.equal(refused.state, 'not-executed');
  assert.equal(refused.retryOperationIdPrefix, undefined); assert.match(refused.retryHint, /invoke or snapshot/);
  await f.controller.decide('agent', 'native-agent', 'seed', 0);
  const resumed = new BackgroundControl(f.config);
  assert.equal((await resumed.call(f.binding, args)).state, 'confirmation-required'); assert.equal(f.writes, 0);
  assert.equal((await resumed.call(f.binding, args)).duplicate, true);
  await assert.rejects(resumed.call(f.binding, { ...args, arguments: ['Changed'] }), /different command/);
  assert.equal((await resumed.decide('agent', 'native-agent', args.operation_id, 1)).state, 'complete'); assert.equal(f.writes, 1);
  assert.equal((await new BackgroundControl(f.config).call(f.binding, args)).duplicate, true); assert.equal(f.writes, 1);
  assert.equal((await resumed.call(f.binding, request('plain', 'ordinary'))).state, 'complete'); assert.equal(f.writes, 2);
});
test('minute buckets and space events have a hard global bound; evicted refused IDs require current consent', async t => {
  const f = fixture(t); f.snapshot.sessions[0].archived = true;
  const original = request('spaceCreate', 'old-refusal', ['Space']); let result = await f.controller.call(f.binding, original);
  for (let n = 1; n <= 130; n++) { f.setTime(60000 * (n + 1)); result = await f.controller.call(f.binding, request('spaceCreate', nextId(result), ['Space'])); }
  assert.equal(f.controller.data.refusals.length, 128); assert.equal(f.room.value.events.filter(e => e.controlAudit?.refusalSummary).length, 128);
  assert.equal(f.controller.data.refusals.some(r => r.refusalSummary.windowStart === 60000), false);
  f.snapshot.sessions[0].archived = false;
  assert.equal((await new BackgroundControl(f.config).call(f.binding, original)).state, 'confirmation-required'); assert.equal(f.writes, 0);
});
test('room counters reveal only that room; duplicate and older audit receipts cannot increase or decrease them', async t => {
  const f = fixture(t), other = f.room.create('Other'); f.snapshot.sessions[0].archived = true;
  let result = await f.controller.call(f.binding, request('spaceCreate', 'one', ['Space'])), old = JSON.parse(JSON.stringify(f.controller.data.refusals[0]));
  f.setRooms([other]); result = await f.controller.call(f.binding, request('spaceCreate', nextId(result), ['Space']));
  f.setRooms(['shared', other]); result = await f.controller.call(f.binding, request('spaceCreate', nextId(result), ['Space']));
  const summary = f.controller.data.refusals[0]; assert.equal(summary.refusalSummary.count, 3);
  for (const id of ['shared', other]) assert.equal(f.room.metadata(id).events.at(-1).controlAudit.refusalSummary.count, 2);
  f.room.recordControlOperation(summary, ['shared', other]); f.room.recordControlOperation(old, ['shared']);
  for (const id of ['shared', other]) assert.equal(f.room.metadata(id).events.at(-1).controlAudit.refusalSummary.count, 2);
});
test('a failed refusal save rolls back the summary counter and performs no action', async t => {
  const f = fixture(t); await fill(f); const before = fs.readFileSync(f.controller.file, 'utf8');
  f.controller.file = path.join(f.dir, 'missing', 'background-operations.json');
  await assert.rejects(f.controller.call(f.binding, request('spaceCreate', 'no-persist', ['Space'])), /save/);
  assert.equal(f.controller.data.refusalActors?.[f.controller.key(f.actor)], undefined); assert.equal(f.writes, 0); assert.equal(f.notices.length, 0);
  assert.equal(fs.readFileSync(path.join(f.dir, 'background-operations.json'), 'utf8'), before);
});
test('summary eviction within the same minute preserves the actor counter and stable space event', async t => {
  const f = fixture(t); f.snapshot.sessions[0].archived = true;
  let result = await f.controller.call(f.binding, request('spaceCreate', 'one', ['Space'])); const summaryId = result.summaryId;
  result = await f.controller.call(f.binding, request('spaceCreate', nextId(result), ['Space']));
  for (let n = 0; n < 129; n++) {
    const binding = { ...f.binding, sender: { ...f.actor, id: 'other-' + n, nativeId: 'native-other-' + n } };
    assert.equal((await f.controller.call(binding, request('spaceCreate', randomUUID(), ['Space']))).state, 'not-executed');
  }
  assert.equal(f.controller.data.refusals.some(r => r.id === summaryId), false);
  const restored = await f.controller.call(f.binding, request('spaceCreate', nextId(result), ['Space']));
  assert.equal(restored.summaryId, summaryId); assert.equal(restored.count, 3);
  assert.equal(f.room.value.events.find(e => e.controlAudit?.operationId === summaryId).controlAudit.refusalSummary.count, 3);
});
test('reused compacted IDs recheck admission and only increment the same bounded summary', async t => {
  const f = fixture(t); f.snapshot.sessions[0].archived = true;
  const args = request('spaceCreate', 'once', ['Space']), refused = await f.controller.call(f.binding, args);
  for (let n = 0; n < 10; n++) {
    const result = await f.controller.call(f.binding, args); assert.equal(result.summaryId, refused.summaryId); assert.equal(result.reason, 'originating-session-unavailable');
  }
  assert.equal(f.controller.data.refusals.length, 1); assert.equal(f.controller.data.refusals[0].refusalSummary.count, 11);
  assert.equal(f.room.value.events.length, 1); assert.equal(f.notices.length, 0); assert.equal(f.writes, 0);
  const actor = { ...f.actor, id: 'other', nativeId: 'other-native' }; f.snapshot.sessions.push(actor);
  assert.equal((await f.controller.call({ ...f.binding, sender: actor }, request('plain', 'unrelated'))).state, 'complete');
});
test('missing persisted summary counters fail closed rather than silently resetting audit counts', async t => {
  const f = fixture(t); f.snapshot.sessions[0].archived = true;
  await f.controller.call(f.binding, request('spaceCreate', 'old', ['Space']));
  const data = JSON.parse(fs.readFileSync(f.controller.file)); delete data.refusalActors;
  fs.writeFileSync(f.controller.file, JSON.stringify(data), { mode: 0o600 });
  assert.throws(() => new BackgroundControl(f.config), /Invalid refusal/); assert.equal(f.writes, 0);
});
test('a backwards clock cannot evict the new caller from a full summary cache', async t => {
  const f = fixture(t); f.snapshot.sessions[0].archived = true;
  let result = await f.controller.call(f.binding, request('spaceCreate', 'old-clock', ['Space']));
  for (let n = 1; n < 130; n++) { f.setTime((n + 1) * 60000); result = await f.controller.call(f.binding, request('spaceCreate', nextId(result), ['Space'])); }
  f.setTime(60000);
  const actor = { ...f.actor, id: 'new-clock', nativeId: 'native-new-clock' };
  const current = await f.controller.call({ ...f.binding, sender: actor }, request('spaceCreate', 'new-clock', ['Space']));
  assert.equal(current.state, 'not-executed'); assert.equal(current.count, 1); assert.ok(f.controller.data.refusals.some(r => r.id === current.summaryId));
});
test('an unavailable audit space is reported without executing or creating an unrelated-space event', async t => {
  const f = fixture(t); f.snapshot.sessions[0].archived = true; f.setRooms([randomUUID()]);
  const result = await f.controller.call(f.binding, request('spaceCreate', 'missing-space', ['Space']));
  assert.equal(result.state, 'not-executed'); assert.match(result.auditError, /space event/);
  assert.equal(f.room.value.events.length, 0); assert.equal(f.writes, 0); assert.equal(f.controller.data.refusals.length, 1);
});
test('legacy per-ID refusals remain bound to their original command', async t => {
  const f = fixture(t), args = request('spaceCreate', 'legacy-refusal', ['Legacy']);
  f.controller.commit(data => data.records.push({ id: args.operation_id, actor: f.actor, command: args, state: 'not-executed', reason: 'confirmation-limit', at: 1 }));
  const cold = new BackgroundControl(f.config);
  assert.equal((await cold.call(f.binding, args)).duplicate, true);
  await assert.rejects(cold.call(f.binding, { ...args, arguments: ['Changed'] }), /different command/);
  assert.equal(cold.data.refusals.length, 0); assert.equal(f.writes, 0);
});
for (const provider of ['claude', 'codex']) for (const reason of ['confirmation-limit', 'originating-session-unavailable']) test(`${provider}: ordinary send and viewState keep arbitrary new IDs after ${reason}`, async t => {
  const f = fixture(t, provider); if (reason === 'confirmation-limit') await fill(f); else f.snapshot.sessions[0].archived = true;
  await f.controller.call(f.binding, request('spaceCreate', 'refused', ['Space'])); f.snapshot.sessions[0].archived = false;
  let sends = 0; f.handlers.set('send', () => ++sends); f.handlers.set('viewState', (c, value) => { Object.assign(c.view, value); return true; });
  assert.equal((await f.controller.call(f.binding, request('send', 'ordinary-new-id', ['target', 'Message']))).state, 'complete');
  assert.equal(sends, 1);
  assert.equal((await f.controller.call(f.binding, request('viewState', 'view-new-id', [{ selected: 'agent' }]))).state, 'complete');
  assert.equal(f.context.view.selected, 'agent');
});
for (const provider of ['claude', 'codex']) test(`${provider}: an implicit foreign snapshot can ask after a transient source refusal`, async t => {
  const f = fixture(t, provider); f.snapshot.sessions[0].archived = true;
  await f.controller.call(f.binding, request('spaceCreate', 'unavailable', ['Space'])); f.snapshot.sessions[0].archived = false;
  f.context.view.selected = 'target'; f.handlers.set('initial', () => f.snapshot);
  const first = await f.controller.call(f.binding, { action: 'snapshot' }); assert.equal(first.state, 'confirmation-required');
  const again = await f.controller.call(f.binding, { action: 'snapshot' }); assert.equal(again.id, first.id); assert.equal(again.duplicate, true);
});
test('an approved operation is retained when a follow-up confirmation is refused after an effect', { timeout: 15000 }, async t => {
  const f = fixture(t), others = Array.from({ length: 4 }, (_, n) => ({ ...f.actor, id: 'other-' + n, nativeId: 'other-native-' + n }));
  f.snapshot.sessions.push(...others);
  let entered, release, effects = 0; const started = new Promise(resolve => { entered = resolve; }), waiting = new Promise(resolve => { release = resolve; });
  f.handlers.set('stop', async c => {
    await dialog(c, 'message', { message: 'First question', buttons: ['Cancel', 'Approve'], cancelId: 0 });
    effects++; entered(); await waiting;
    await dialog(c, 'message', { message: 'Follow-up question', buttons: ['Cancel', 'Approve'], cancelId: 0 });
  });
  const args = request('stop', 'approved-operation'), original = await f.controller.call(f.binding, args);
  f.controller.commit(data => { for (let actor = 0; actor < others.length; actor++) for (let n = 0; n < (actor === 3 ? 31 : 32); n++) {
    const copy = JSON.parse(JSON.stringify(original)); copy.id = `other-${actor}-${n}`; copy.actor = { ...copy.actor, ...others[actor], operationId: copy.id }; copy.command.operation_id = copy.id; data.records.push(copy);
  } });
  const decision = f.controller.decide(f.actor.id, f.actor.nativeId, original.id, 1); await started;
  const last = await f.controller.call({ ...f.binding, sender: others[3] }, request('stop', 'last-global-slot')); assert.equal(last.state, 'confirmation-required');
  release(); const result = await decision, saved = f.controller.receipt(f.actor, original.id);
  t.diagnostic(JSON.stringify({ effects, state: result.state, originalRetained: Boolean(saved) }));
  assert.equal(result.state, 'unconfirmed'); assert.ok(saved); assert.equal(saved.humanDecision, 1);
  assert.ok(f.controller.rows(f.actor.id).some(row => row.id.endsWith(original.id)));
  assert.equal((await f.controller.call(f.binding, args)).duplicate, true); assert.equal(effects, 1);
});
