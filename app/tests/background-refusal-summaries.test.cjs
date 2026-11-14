const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { randomUUID } = require('node:crypto');
const { BackgroundControl, PreconditionRefused, dialog } = require('../background-control.cjs');
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
for (const provider of ['claude', 'codex']) for (const reason of ['another-operation-running', 'explicit-paths-required', 'invalid-file-path-count', 'file-preview-changed'])
test(`${provider}: proven pre-handler ${reason} refusals have bounded storage and fresh consent after correction`, async t => {
  const f = fixture(t, provider), marker = 'SYNTHETIC_REFUSED_ARGUMENT', body = marker + 'x'.repeat(4096);
  const method = reason === 'another-operation-running' ? 'spaceCreate' : reason === 'explicit-paths-required' ? 'chooseFolder' : 'openLocalFile';
  let invalid = true, entered = 0;
  const confirm = f.config.confirmation;
  f.config.confirmation = (...args) => {
    if (invalid && ['invalid-file-path-count', 'file-preview-changed'].includes(reason)) throw new PreconditionRefused(Error('Synthetic file precondition'), reason);
    return confirm(...args);
  };
  const controller = new BackgroundControl(f.config), key = controller.key(f.actor);
  f.handlers.set(method, async c => {
    entered++;
    if (method === 'chooseFolder') return (await dialog(c, 'open', { properties: ['openDirectory'] })).filePaths[0];
    return 'executed';
  });
  if (reason === 'another-operation-running') controller.inflight.set(key, Promise.resolve());
  const before = fs.existsSync(controller.file) ? fs.statSync(controller.file).size : 0;
  let first, last;
  for (let n = 0; n < 40; n++) {
    const args = request(method, 'refused-' + n, [body]); first ||= args;
    last = await controller.call(f.binding, args);
    assert.equal(last.state, 'not-executed'); assert.equal(last.reason, reason);
  }
  assert.equal(entered, 0, 'The handler has never started'); assert.equal(f.notices.length, 0);
  const text = fs.readFileSync(controller.file, 'utf8');
  t.diagnostic(JSON.stringify({ reason, calls: 40, beforeBytes: before, afterBytes: Buffer.byteLength(text), records: controller.data.records.length, summaries: controller.data.refusals.length }));
  assert.equal(controller.data.records.length, 0); assert.equal(controller.data.refusals.length, 1);
  assert.equal(controller.data.refusals[0].refusalSummary.count, 40);
  assert.ok(Buffer.byteLength(text) < 24000); assert.equal(text.includes(marker), false);
  assert.equal(f.room.value.events.length, 1); assert.equal(f.room.value.events[0].controlAudit.refusalSummary.count, 40);
  assert.notEqual(f.room.value.events[0].uiMessage.key, 'notice.background.refusalActor');
  assert.equal((await controller.call(f.binding, { action: 'receipt', operation_id: first.operation_id })).receipt.id, last.summaryId);
  controller.inflight.delete(key); invalid = false;
  const cold = new BackgroundControl(f.config);
  const corrected = { ...first, arguments: [], ...(method === 'chooseFolder' ? { paths: [f.dir] } : {}) };
  const result = await cold.call(f.binding, corrected);
  assert.equal(result.state, method === 'chooseFolder' ? 'complete' : 'confirmation-required');
  if (method !== 'chooseFolder') {
    assert.equal(entered, 0); assert.equal((await cold.decide(f.actor.id, f.actor.nativeId, corrected.operation_id, 1)).state, 'complete');
  }
  assert.equal(entered, 1); assert.equal((await cold.call(f.binding, corrected)).duplicate, true); assert.equal(entered, 1);
});
test('ordinary completed operations retain their exact IDs, results and delivery guards instead of becoming refusal summaries', async t => {
  const f = fixture(t), args = request('plain', 'executed', ['exact original arguments']);
  const first = await f.controller.call(f.binding, args);
  const cold = new BackgroundControl(f.config), again = await cold.call(f.binding, args);
  assert.equal(again.duplicate, true); assert.equal(again.value, first.value); assert.deepEqual(again.guard, first.guard);
  await assert.rejects(cold.call(f.binding, { ...args, arguments: ['changed'] }), /different command/);
  assert.equal(f.writes, 1); assert.equal(cold.data.records.length, 1); assert.equal(cold.data.refusals.length, 0);
});
for (const state of ['complete', 'received', 'awaiting-native']) test(`a successfully audited ${state} retains identity and result without the whole consent snapshot`, async t => {
  const f = fixture(t), marker = 'SYNTHETIC_OBSOLETE_CONSENT', previous = f.context.fingerprint;
  f.context.fingerprint = () => ({ ...previous(), rooms: [{ id: 'shared', name: marker, memberOrder: Array.from({ length: 100 }, (_, n) => 'member-' + n) }],
    sessions: f.snapshot.sessions.map(s => ({ ...s, state: marker, approval: { body: marker } })), sessionArchives: { old: marker } });
  f.context.delivery = () => state === 'complete' ? null : { nativeReceived: state === 'received', status: state };
  let beforeBytes = 0; const publish = f.controller.publish.bind(f.controller);
  f.controller.publish = (row, context) => { beforeBytes = Buffer.byteLength(JSON.stringify(row.guard)); return publish(row, context); };
  const args = request('plain', 'completed-record', ['PRESERVE_ARGUMENTS']);
  const result = await f.controller.call(f.binding, args);
  assert.equal(result.state, state); assert.equal(result.value, 1);
  assert.ok(f.audits.every(r => !r.guard || r.guard.rooms));
  assert.deepEqual(result.guard, { auditRooms: ['shared'], sessions: f.snapshot.sessions.map(s => ({ id: s.id, nativeId: s.nativeId })) });
  const afterBytes = Buffer.byteLength(JSON.stringify(result.guard));
  t.diagnostic(JSON.stringify({ state, consentBytes: beforeBytes, retainedGuardBytes: afterBytes })); assert.ok(afterBytes < beforeBytes / 2);
  const text = fs.readFileSync(f.controller.file, 'utf8'); assert.equal(text.includes(marker), false); assert.ok(text.includes('PRESERVE_ARGUMENTS'));
  const cold = new BackgroundControl(f.config), duplicate = await cold.call(f.binding, args);
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.value, 1); assert.equal(f.writes, 1);
  await assert.rejects(cold.call(f.binding, { ...args, arguments: ['DIFFERENT'] }), /different command/);
});
test('an audit failure keeps the complete consent snapshot with the unknown outcome', async t => {
  const f = fixture(t), previous = f.context.fingerprint;
  f.context.fingerprint = () => ({ ...previous(), rooms: [{ id: 'shared', name: 'PRESERVE_UNCONFIRMED_CONSENT' }] });
  const controller = new BackgroundControl(f.config), args = request('spaceCreate', 'audit-failure', ['Space']);
  // Fail the completion audit, after the existing pre-mutation running audit succeeded.
  let audits = 0; controller.audit = row => { if (row.state === 'complete') throw Error('Synthetic audit failure'); audits++; };
  const pending = await controller.call(f.binding, args);
  const result = await controller.decide(f.actor.id, f.actor.nativeId, pending.id, 1);
  assert.equal(result.state, 'unconfirmed'); assert.equal(result.resultState, 'complete');
  assert.equal(result.guard.rooms[0].name, 'PRESERVE_UNCONFIRMED_CONSENT'); assert.ok(audits > 0);
  assert.equal((await controller.call(f.binding, args)).duplicate, true); assert.equal(f.writes, 1);
});
test('the real receipt delivery consumer still pins native identity after consent compaction and restart', async t => {
  const f = fixture(t), args = request('send', 'real-delivery', ['target', 'Synthetic message', 'native-target']); let sends = 0;
  const target = f.snapshot.sessions[1];
  target.messages = [{ id: 'synthetic-message', status: 'queued', text: 'Synthetic message', agentControl: { operationId: args.operation_id, id: f.actor.id, nativeId: f.actor.nativeId } }];
  f.handlers.set('send', () => { sends++; return { messageId: 'synthetic-message' }; });
  f.context.client.refresh = async () => {};
  const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8'), start = main.indexOf('      context.delivery = async (command'), end = main.indexOf('\n      const id = win.webContents.id;', start);
  assert.ok(start >= 0 && end > start);
  require('node:vm').runInNewContext(main.slice(start, end), { context: f.context, client: f.context.client });
  const prior = f.context.fingerprint;
  f.context.fingerprint = () => ({ ...prior(), sessions: f.snapshot.sessions.map(s => ({ id: s.id, nativeId: s.nativeId, state: 'OBSOLETE_STATE', controlRevision: 100 })), rooms: [{ id: 'shared', memberIds: ['agent', 'target'] }] });
  const sent = await f.controller.call(f.binding, args); assert.equal(sent.state, 'awaiting-native');
  assert.deepEqual(sent.guard.sessions.find(s => s.id === 'target'), { id: 'target', nativeId: 'native-target' });
  const cold = new BackgroundControl(f.config);
  target.nativeId = 'replacement'; target.messages[0].status = 'submitted';
  const changed = (await cold.call(f.binding, { action: 'receipt', operation_id: args.operation_id })).receipt;
  assert.equal(changed.delivery.status, 'context-changed'); assert.equal(changed.delivery.nativeReceived, false);
  target.nativeId = 'native-target';
  const received = (await cold.call(f.binding, { action: 'receipt', operation_id: args.operation_id })).receipt;
  assert.equal(received.state, 'received'); assert.equal(received.delivery.messageId, 'synthetic-message'); assert.equal(sends, 1);
  assert.equal((await cold.call(f.binding, args)).duplicate, true); assert.equal(sends, 1);
});
test('an entered arbitrary selector keeps its original ID even when its file dialog cannot run', async t => {
  const f = fixture(t); let effects = 0;
  f.handlers.set('customSelector', async c => { effects++; return dialog(c, 'open', { properties: ['openDirectory'] }); });
  const args = request('customSelector', 'entered-selector'), first = await f.controller.call(f.binding, args);
  assert.equal(first.reason, 'explicit-paths-required'); assert.equal(f.controller.data.refusals.length, 0);
  assert.ok(f.controller.receipt(f.actor, args.operation_id));
  assert.equal((await new BackgroundControl(f.config).call(f.binding, args)).duplicate, true); assert.equal(effects, 1);
});
for (const changed of [false, true]) test(`a request waiting for refresh cannot summarize another call's running ID (${changed ? 'changed arguments' : 'same command'})`, async t => {
  const f = fixture(t), args = request('spaceCreate', 'same-inflight-id', ['Original']);
  let releaseRefresh, refreshEntered, releaseHandler, handlerEntered, effects = 0, reads = 0;
  const refreshGate = new Promise(resolve => { releaseRefresh = resolve; }), refreshing = new Promise(resolve => { refreshEntered = resolve; });
  const handlerGate = new Promise(resolve => { releaseHandler = resolve; }), started = new Promise(resolve => { handlerEntered = resolve; });
  f.context.refresh = async () => { if (++reads === 1) { refreshEntered(); await refreshGate; } };
  f.handlers.set('spaceCreate', async () => { effects++; handlerEntered(); await handlerGate; return 'done'; });
  const waiting = f.controller.call(f.binding, changed ? { ...args, arguments: ['Changed'] } : args);
  // Attach a rejection observer before releasing either deterministic barrier.
  const outcome = waiting.then(value => ({ value }), error => ({ error }));
  let decision;
  try {
    await refreshing;
    assert.equal((await f.controller.call(f.binding, args)).state, 'confirmation-required');
    decision = f.controller.decide(f.actor.id, f.actor.nativeId, args.operation_id, 1); decision.catch(() => {});
    await started; releaseRefresh();
    const result = await outcome;
    if (changed) assert.match(result.error?.message || '', /different command/);
    else { assert.equal(result.value.duplicate, true); assert.equal(result.value.state, 'running'); }
    assert.equal(f.controller.data.records.find(r => r.id === args.operation_id)?.state, 'running');
    assert.equal(f.controller.data.refusals.length, 0); assert.equal(effects, 1);
  } finally {
    releaseRefresh(); releaseHandler(); await outcome; if (decision) await decision;
  }
  const cold = new BackgroundControl(f.config);
  assert.equal((await cold.call(f.binding, args)).duplicate, true); assert.equal(effects, 1);
});
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
  assert.equal(f.controller.data.refusals.length, 32); assert.equal(f.room.value.events.filter(e => e.controlAudit?.refusalSummary).length, 32);
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
for (const provider of ['claude', 'codex']) test(`${provider}: stored summary and returned hints agree, including old candidate files`, async t => {
  const f = fixture(t, provider); f.snapshot.sessions[0].archived = true;
  const result = await f.controller.call(f.binding, request('spaceCreate', 'hint', ['Space']));
  const summary = (await f.controller.call(f.binding, { action: 'receipt', operation_id: result.summaryId })).receipt;
  assert.equal(summary.retryHint, result.retryHint); assert.match(summary.retryHint, /compacted refused ID/);
  const old = JSON.parse(fs.readFileSync(f.controller.file)); old.refusals[0].retryHint = 'This refused operation_id will not execute';
  fs.writeFileSync(f.controller.file, JSON.stringify(old), { mode: 0o600 });
  const cold = new BackgroundControl(f.config);
  assert.equal(cold.receipt(f.actor, result.summaryId).retryHint, result.retryHint);
  assert.equal(JSON.parse(fs.readFileSync(cold.file)).refusals[0].retryHint, result.retryHint);
});
for (const provider of ['claude', 'codex']) test(`${provider}: original refused IDs resolve to their summary without binding a later invocation`, async t => {
  const f = fixture(t, provider); f.snapshot.sessions[0].archived = true;
  const args = request('spaceCreate', 'original-refused-id', ['Space']), denied = await f.controller.call(f.binding, args);
  const receipt = (await f.controller.call(f.binding, { action: 'receipt', operation_id: args.operation_id })).receipt;
  assert.ok(receipt); assert.equal(receipt.id, denied.summaryId); assert.equal(receipt.refusalSummary.count, 1);
  assert.equal(new BackgroundControl(f.config).receipt(f.actor, args.operation_id).id, denied.summaryId);
  assert.equal(f.controller.receipt({ ...f.actor, nativeId: 'other-native' }, args.operation_id), null);
  assert.equal(f.controller.receipt({ ...f.actor, id: 'other-agent' }, args.operation_id), null);
  assert.equal(f.controller.receipt({ ...f.actor, provider: provider === 'claude' ? 'codex' : 'claude' }, args.operation_id), null);
  f.snapshot.sessions[0].archived = false;
  assert.equal((await f.controller.call(f.binding, args)).state, 'confirmation-required'); assert.equal(f.writes, 0);
  assert.equal((await f.controller.decide(f.actor.id, f.actor.nativeId, args.operation_id, 0)).state, 'cancelled');
  assert.equal(f.controller.receipt(f.actor, args.operation_id).state, 'cancelled', 'Exact normal records take precedence over receipt aliases');
  assert.equal((await f.controller.call(f.binding, args)).duplicate, true); assert.equal(f.writes, 0);
});
test('one session cannot evict another session through repeated minute summaries or native replacements', async t => {
  const f = fixture(t); f.snapshot.sessions[0].archived = true;
  const quiet = { ...f.actor, id: 'quiet', nativeId: 'quiet-native' };
  const first = await f.controller.call({ ...f.binding, sender: quiet }, request('spaceCreate', 'quiet-refusal', ['Space']));
  for (let n = 0; n < 130; n++) {
    f.setTime((n + 2) * 60000);
    await f.controller.call({ ...f.binding, sender: { ...f.actor, nativeId: 'changing-native-' + n } }, request('spaceCreate', 'spam-' + n, ['Space']));
  }
  assert.ok(f.controller.data.refusals.some(r => r.id === first.summaryId));
  assert.equal(f.controller.data.refusals.filter(r => r.actor.id === f.actor.id).length, 32);
  assert.equal(f.room.value.events.filter(e => e.controlAudit?.refusalSummary && e.sessionId === f.actor.id).length, 32);
  assert.ok(f.room.value.events.some(e => e.controlAudit?.operationId === first.summaryId));
  assert.equal(f.controller.receipt(quiet, 'quiet-refusal').id, first.summaryId);
});
test('receipt aliases are bounded and fairly retained; evicted summaries have no dangling aliases', { timeout: 60000 }, async t => {
  const f = fixture(t); f.snapshot.sessions[0].archived = true;
  const quiet = { ...f.actor, id: 'quiet', nativeId: 'quiet-native' };
  const first = await f.controller.call({ ...f.binding, sender: quiet }, request('spaceCreate', 'quiet-original', ['Space']));
  for (let n = 0; n < 140; n++) await f.controller.call(f.binding, request('spaceCreate', 'crowded-' + n, ['Space']));
  assert.ok(f.controller.data.refusalReceipts.length <= 512);
  assert.equal(f.controller.data.refusalReceipts.filter(r => r.actor.id === f.actor.id).length, 128);
  assert.equal(f.controller.receipt(quiet, 'quiet-original').id, first.summaryId);
  assert.equal(f.controller.receipt(f.actor, 'crowded-0'), null);
  assert.ok(f.controller.receipt(f.actor, 'crowded-139'));
  for (let actor = 0; actor < 4; actor++) for (let n = 0; n < 128; n++) {
    const sender = { ...f.actor, id: 'alias-actor-' + actor, nativeId: 'alias-native-' + actor };
    await f.controller.call({ ...f.binding, sender }, request('spaceCreate', `alias-${actor}-${n}`, ['Space']));
  }
  assert.equal(f.controller.data.refusalReceipts.length, 512);
  assert.equal(f.controller.receipt(quiet, 'quiet-original').id, first.summaryId, 'An oldest quiet receipt is not evicted by busy actors');
  for (let n = 0; n < 129; n++) { f.setTime((n + 2) * 60000); await f.controller.call(f.binding, request('spaceCreate', 'later-' + n, ['Space'])); }
  assert.equal(f.controller.receipt(f.actor, 'crowded-139'), null);
  assert.ok(f.controller.data.refusalReceipts.every(a => f.controller.data.refusals.some(r => r.id === a.summaryId && r.actor.id === a.actor.id && r.actor.nativeId === a.actor.nativeId)));
});
test('a full legacy refusal file migrates its old hint without growing or erasing history', async t => {
  const f = fixture(t); f.snapshot.sessions[0].archived = true;
  const result = await f.controller.call(f.binding, request('spaceCreate', 'old-full-file', ['Space']));
  const old = JSON.parse(fs.readFileSync(f.controller.file)); delete old.refusalReceipts;
  old.refusals[0].retryHint = 'Refresh the originating session, then use a new operation_id. This refused operation_id will not execute.';
  old.padding = ''; old.padding = 'x'.repeat(32 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(old)));
  fs.writeFileSync(f.controller.file, JSON.stringify(old), { mode: 0o600 });
  assert.equal(fs.statSync(f.controller.file).size, 32 * 1024 * 1024);
  const cold = new BackgroundControl(f.config);
  assert.equal(cold.receipt(f.actor, result.summaryId).retryHint, result.retryHint);
  assert.equal(cold.data.padding.length, old.padding.length); assert.equal(cold.data.refusals.length, 1);
  assert.ok(fs.statSync(cold.file).size <= 32 * 1024 * 1024); assert.equal(f.writes, 0);
});

// Queue 794d3cd7 (大管家, 2026-11-13 20:35): every answer to an agent carried NAW's whole guard (all 36 sessions,
// 10 KB and more), which the agent never uses. main.cjs answers each workspace_control call without it.
test('an agent gets each answer without NAW\'s guard, while NAW keeps the guard', async t => {
  const vm = require('node:vm'), { agentReply } = require('../background-control.cjs');
  const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
  const f = fixture(t);
  // As many sessions as the person's list held when measured.
  f.snapshot.sessions.push(...Array.from({ length: 34 }, (_, n) => ({ id: 'session-' + n, nativeId: 'native-' + n, name: 'Session ' + n, provider: n % 2 ? 'claude' : 'codex', cwd: '/work/repo-' + n, state: 'idle' })));
  f.context.fingerprint = () => ({ auditRooms: ['shared'], rooms: [{ id: 'shared', name: 'Shared', memberOrder: f.snapshot.sessions.map(s => s.id) }], sessions: f.snapshot.sessions.map(s => ({ ...s })) });
  const a = main.indexOf('        control: async (binding, args) => {'), b = main.indexOf('\n        createView:', a);
  assert.ok(a > 0 && b > a, 'main.cjs answers every workspace_control call in one place');
  const edge = vm.runInNewContext('(' + main.slice(a + '        control: '.length, b).trim().replace(/,$/, '') + ')',
    { backgroundControl: f.controller, stewardRecord: null, background: require('../background-control.cjs'), Error });
  const ask = request('spaceCreate', 'pending-create', ['Small']);
  const pending = await edge(f.binding, ask);
  assert.equal(pending.state, 'confirmation-required'); assert.equal(Object.hasOwn(pending, 'guard'), false);
  const kept = f.controller.receipt(f.actor, 'pending-create');
  assert.equal(kept.guard.sessions.length, 36, 'NAW keeps the whole guard to bind the person\'s answer');
  const { guard: _guard, ...rest } = kept; assert.deepEqual(pending, { ...rest, retry: false }, 'everything else is as it was');
  const before = Buffer.byteLength(JSON.stringify({ ...kept, retry: false })), after = Buffer.byteLength(JSON.stringify(pending));
  t.diagnostic(JSON.stringify({ before, after })); assert.ok(after * 4 < before);
  const receipt = await edge(f.binding, { action: 'receipt', operation_id: 'pending-create' });
  assert.equal(receipt.receipt.id, 'pending-create'); assert.equal(Object.hasOwn(receipt.receipt, 'guard'), false);
  const again = await edge(f.binding, ask);
  assert.equal(again.duplicate, true); assert.equal(Object.hasOwn(again, 'guard'), false);
  const done = await edge(f.binding, request('plain', 'plain-done', ['X']));
  assert.equal(done.state, 'complete'); assert.equal(done.value, 1); assert.equal(Object.hasOwn(done, 'guard'), false);
  // call() itself still answers with the guard (NAW's own uses), and agentReply changes no value it is given.
  const own = await f.controller.call(f.binding, { action: 'receipt', operation_id: 'pending-create' });
  assert.equal(own.receipt.guard.sessions.length, 36);
  const copy = JSON.parse(JSON.stringify(own)); agentReply(own); assert.deepEqual(own, copy);
  for (const value of [null, undefined, 'text', [{ guard: 1 }], { state: 'complete' }]) assert.deepEqual(agentReply(value), value);
});
