'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { BackgroundControl } = require('../background-control.cjs');
const { ButlerLedger } = require('../butler-ledger.cjs');
const { ButlerIngress } = require('../butler-ingress.cjs');
const { randomUUID } = require('node:crypto');
const locale = require('../ui-locale.js'), { uiError } = require('../ui-errors.cjs');
const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
function section(start, end) {
  const first = main.indexOf(start), last = main.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, 'Actual Main section exists: ' + start);
  return main.slice(first, last);
}
const request = () => ({ reviewId: 'review:one', contentDigest: 'review-content:synthetic', expectedRevision: 0,
  disagreedSuggestionIds: ['suggestion:one'], disagreedCandidateIds: [], allRead: true });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-review-ipc-')); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const handlers = new Map(), ipc = new Map(), windows = new Map(), calls = [];
  const makeContext = (id, background = false) => {
    let destroyed = false;
    const frame = { url: 'synthetic-trusted' }, webContents = { id, mainFrame: frame };
    const context = { background, win: { webContents, isDestroyed: () => destroyed, destroy: () => { destroyed = true; } },
      client: { close() {} }, view: { selected: 'synthetic-agent' } };
    windows.set(id, context);
    return { context, event: { sender: webContents, senderFrame: frame }, destroy: () => { destroyed = true; } };
  };
  const person = makeContext(1), agent = makeContext(2, true);
  const ledger = {
    healthy() {},
    latestReview(actor) { calls.push(['latest', actor]); return { reviewId: 'review:one', source: 'host-stored' }; },
    review(id, actor) { calls.push(['read', id, actor]); return { reviewId: id, source: 'host-stored' }; },
    freezeReview(scope, actor) { calls.push(['freeze', scope, actor]); return { reviewId: 'review:frozen', provenance: { kind: 'audit' } }; },
    confirmReview(id, value, actor) { calls.push(['confirm', id, value, actor]); return { reviewId: id, revision: 1 }; },
    snapshot() { throw Error('Availability must not copy the ledger snapshot'); },
  };
  const auditCalls = [], audit = { read(actor, options) {
    auditCalls.push({ actor, options });
    return { records: [{ sequence: 1, result: { count: 1 } }], throughSequence: 1, nextAfterSequence: 1, truncated: false };
  } };
  const sandbox = { butlerReadAudit: audit, windows, applicationHandlers: handlers, ipcMain: { handle: (name, fn) => ipc.set(name, fn) },
    trusted: url => url === 'synthetic-trusted', uiLocale: locale, uiError, butlerIngress: { ledger },
    backgroundOperation: require('../background-operation.cjs') };
  vm.createContext(sandbox);
  vm.runInContext(section('function isCurrentHumanContext(', '\nfunction showDialog('), sandbox);
  vm.runInContext(section('function register(name, handler)', '\nasync function replaceBackendSockets('), sandbox);
  vm.runInContext(section("  register('butlerReview',", "  register('queueSecretary',"), sandbox);
  const call = (action, ...args) => ipc.get('workspace:butlerReview')(person.event, action, ...args);
  return { directory, handlers, ipc, windows, calls, ledger, audit, auditCalls, sandbox, person, agent, makeContext, call };
}

test('actual Main IPC routes the five human operations to the same host writer and fixes audit scope at zero', async t => {
  const f = fixture(t);
  assert.deepEqual(JSON.parse(JSON.stringify(await f.call('availability'))), { ok: true, value: { available: true, activation: 'off', recordPeriod: 'off' } });
  assert.equal(f.calls.length, 0);
  assert.equal((await f.call('latest')).value.source, 'host-stored');
  assert.equal((await f.call('read', 'review:one')).value.reviewId, 'review:one');
  assert.equal((await f.call('freeze')).value.provenance.kind, 'audit');
  assert.equal((await f.call('confirm', request())).value.revision, 1);
  assert.equal(f.calls[0][1], f.person.context);
  assert.equal(f.calls[1][2], f.person.context);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[2][1])), { afterSequence: 0 });
  assert.equal(f.calls[2][2], f.person.context);
  assert.equal(f.calls[3][1], 'review:one');
  const expected = request(); delete expected.reviewId;
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[3][2])), expected);
  assert.equal(f.calls[3][3], f.person.context);
  assert.equal(f.sandbox.butlerIngress.ledger, f.ledger);
});

test('trusted agent renderer IPC is refused for every operation before any ledger call', async t => {
  const f = fixture(t), invoke = f.ipc.get('workspace:butlerReview');
  for (const [action, args] of [['availability', []], ['latest', []], ['read', ['review:one']], ['freeze', []], ['confirm', [request()]]]) {
    const result = await invoke(f.agent.event, action, ...args);
    assert.equal(result.ok, false); assert.match(result.error, /person window/);
  }
  assert.equal(f.calls.length, 0);
});

test('a forged actor, replaced window context, destroyed window and removed mapping are never person authority', async t => {
  const f = fixture(t), verify = f.sandbox.isCurrentHumanContext, old = f.person.context;
  assert.equal(verify(old), true);
  assert.equal(verify({ kind: 'person', win: old.win }), false);
  assert.equal(verify({ ...old }), false);
  f.windows.set(1, { ...old }); assert.equal(verify(old), false);
  f.windows.set(1, old); old.background = true; assert.equal(verify(old), false); old.background = false;
  f.person.destroy(); assert.equal(verify(old), false);
  assert.equal((await f.call('latest')).ok, false);
  f.windows.delete(1); assert.equal(verify(old), false);
  await assert.rejects(f.call('availability'), /Unexpected IPC source/);
  assert.equal(f.calls.length, 0);
});

test('the actual register frame gate refuses a same-URL subframe before reaching review data', async t => {
  const f = fixture(t), event = { ...f.person.event, senderFrame: { url: 'synthetic-trusted' } };
  await assert.rejects(f.ipc.get('workspace:butlerReview')(event, 'latest'), /Unexpected IPC source/);
  assert.equal(f.calls.length, 0);
});

test('unknown actions, renderer scopes and extra review facts fail before reaching the host writer', async t => {
  const f = fixture(t);
  const cases = [[], ['unknown'], ['freeze', {}], ['freeze', { scope: 'another-space', afterSequence: 99 }],
    ['availability', { kind: 'person' }], ['latest', 'review:one'], ['read'], ['read', 'review:one', {}], ['read', 'bad id'],
    ['confirm'], ['confirm', request(), {}], ['confirm', { ...request(), allRead: false }],
    ['confirm', { ...request(), expectedRevision: -1 }], ['confirm', { ...request(), disagreedSuggestionIds: [null] }]];
  for (const key of ['rows', 'counts', 'provenance', 'scope', 'actor', 'activation', 'recordPeriod']) cases.push(['confirm', { ...request(), [key]: {} }]);
  for (const args of cases) assert.equal((await f.call(...args)).ok, false, JSON.stringify(args));
  assert.equal(f.calls.length, 0);
});

test('availability exposes only an availability bit and off flags, including absent or failed storage', async t => {
  const f = fixture(t);
  f.ledger.healthy = () => { throw Error('Synthetic storage unavailable'); };
  assert.deepEqual(JSON.parse(JSON.stringify((await f.call('availability')).value)), { available: false, activation: 'off', recordPeriod: 'off' });
  f.sandbox.butlerIngress = null;
  assert.deepEqual(JSON.parse(JSON.stringify((await f.call('availability')).value)), { available: false, activation: 'off', recordPeriod: 'off' });
  assert.equal((await f.call('latest')).ok, false); assert.equal(f.calls.length, 0);
});

test('the agent catalog and invoke path cannot discover or execute the human-only IPC command', async t => {
  const f = fixture(t);
  assert.equal(f.handlers.has('butlerReview'), false);
  const controller = new BackgroundControl({ dataDir: f.directory, handlers: f.handlers, context: async () => f.agent.context });
  t.after(() => controller.close());
  const binding = { sender: { id: 'agent', nativeId: 'native-a', name: 'Agent', provider: 'codex' },
    identity: { turnId: 'turn', callId: 'call' }, valid: () => true };
  const catalog = await controller.call(binding, { action: 'catalog' });
  assert.equal(catalog.commands.some(command => command.method === 'butlerReview'), false);
  const result = await controller.call(binding, { action: 'invoke', operation_id: 'try-review', method: 'butlerReview', arguments: ['freeze'] });
  assert.equal(result.state, 'not-executed'); assert.equal(result.reason, 'unknown-command');
  assert.equal(f.calls.length, 0);
});

test('Main startup injects the current-window verifier into the existing real ledger and reuses its epoch owner', async t => {
  const f = fixture(t); let created = 0;
  Object.assign(f.sandbox, { butlerIngress: null, dataDir: f.directory, roomState: { id: 'first' }, randomUUID: () => 'review-test-epoch', ButlerLedger,
    ButlerIngress: class { constructor(_dir, { roomState, ledger }) { created++; this.roomState = roomState; this.ledger = ledger; } recover() {} } });
  const boot = section('    // One writer owns the display-measurement epoch.', '\n    butlerIngress.recover();') + '\n    butlerIngress.recover();';
  vm.runInContext(boot, f.sandbox);
  const ledger = f.sandbox.butlerIngress.ledger;
  assert.equal(ledger instanceof ButlerLedger, true); assert.equal((await f.call('latest')).value, null);
  assert.throws(() => ledger.latestReview({ kind: 'person' }), { code: 'BUTLER_PERSON_ONLY' });
  f.sandbox.roomState = { id: 'second' }; vm.runInContext(boot, f.sandbox);
  assert.equal(created, 1); assert.equal(f.sandbox.butlerIngress.ledger, ledger);
  assert.equal(f.sandbox.butlerIngress.roomState.id, 'second');
  assert.equal(ledger.snapshot().questionMetricEpochs.length, 1);
  f.windows.set(1, { ...f.person.context });
  assert.throws(() => ledger.latestReview(f.person.context), { code: 'BUTLER_PERSON_ONLY' });
  ledger.closeQuestionMetricEpoch();
});

test('actual Main and Ledger freeze, confirm and restore the same audit without answering a business question', async t => {
  const f = fixture(t);
  const boot = section('    // One writer owns the display-measurement epoch.', '\n    butlerIngress.recover();') + '\n    butlerIngress.recover();';
  const environment = { windows: f.windows, applicationHandlers: f.handlers,
    ipcMain: { handle: (name, handler) => f.ipc.set(name, handler) }, trusted: url => url === 'synthetic-trusted',
    uiLocale: locale, uiError, backgroundOperation: require('../background-operation.cjs'),
    ButlerLedger, ButlerIngress, dataDir: f.directory, roomState: { butlerSources: () => [] }, randomUUID };
  // These exact Main sections execute in the Ledger's realm, as in Electron.
  // VM object literals have another Object.prototype and are correctly rejected
  // by the production Ledger; its plain-object boundary must stay intact.
  const open = () => new Function(...Object.keys(environment), 'let butlerIngress = null;\n' +
    section('function isCurrentHumanContext(', '\nfunction showDialog(') + '\n' +
    section('function register(name, handler)', '\nasync function replaceBackendSockets(') + '\n' + boot + '\n' +
    section("  register('butlerReview',", "  register('queueSecretary',") + '\nreturn butlerIngress;')(...Object.values(environment));
  const ingress = open(), ledger = ingress.ledger;
  assert.ok(ledger instanceof ButlerLedger); assert.equal(f.handlers.has('butlerReview'), false);
  assert.deepEqual((await f.call('availability')).value, { available: true, activation: 'off', recordPeriod: 'off' });
  assert.equal((await f.call('latest')).value, null);
  const fullText = 'Original synthetic task: ' + 'source detail '.repeat(120);
  ledger.ingest({ eventId: 'audit-source', sourceRef: 'task:audit', kind: 'request', payload: { text: fullText, spaceId: 'source-space', itemId: 'source-item' } });
  ledger.ingest({ eventId: 'audit-decision', sourceRef: 'decision:audit', kind: 'decision',
    payload: { text: 'Synthetic business decision', questionKey: 'issue:audit', decisionKind: 'approval' } });
  const selection = { selectionRevision: 1, identity: { sessionId: 'audit-butler', nativeId: 'audit-native' }, runnerRef: 'audit-runner' };
  const batch = ledger.beginBatch(selection);
  ledger.completeBatch(batch.batchId, selection, { actions: [
    ...Array.from({ length: 10 }, (_, i) => ({ kind: 'queue', sourceRef: 'task:audit', spaceId: 'target-space', text: 'Synthetic suggestion ' + i })),
    { kind: 'question', sourceRef: 'decision:audit', decisionKind: 'approval', text: 'Proceed with the synthetic task?' }
  ] });
  const reserved = ledger.reserveQuestion({ sourceRef: 'decision:audit', decisionKind: 'approval', text: 'Proceed with the synthetic task?' });
  ledger.ackDelivery(reserved.deliveryId, 'unknown');
  const send = attemptId => {
    ledger.beginQuestionSend({ attemptId, questionId: reserved.question.questionId, deliveryId: reserved.deliveryId,
      sourceEventId: 'audit-decision', channel: 'notification' });
    ledger.ackQuestionSend(attemptId, 'shown');
  };
  send('audit-show-one');
  const beforeInvalid = ledger.snapshot().sequence;
  for (const args of [['freeze', { scope: 'working-day', afterSequence: 1 }], ['configure', { activation: 'on' }], ['freeze', { rows: [], counts: {} }]])
    assert.equal((await f.call(...args)).ok, false);
  assert.equal(ledger.snapshot().sequence, beforeInvalid);
  const denied = await f.ipc.get('workspace:butlerReview')(f.agent.event, 'freeze');
  assert.equal(denied.ok, false); assert.equal(ledger.snapshot().sequence, beforeInvalid);
  assert.throws(() => ledger.latestReview({ kind: 'person' }), { code: 'BUTLER_PERSON_ONLY' });
  const response = await f.call('freeze'); assert.equal(response.ok, true, response.error);
  const frozen = response.value, expected = structuredClone(frozen);
  assert.deepEqual(frozen.provenance, { kind: 'audit', recordPeriod: 'off', activation: 'off' });
  assert.equal(frozen.window.afterSequence, 0); assert.equal(frozen.window.throughSequence, beforeInvalid);
  assert.equal(frozen.frozen.rows[0].sources[0].payload.text, fullText);
  assert.equal(frozen.questionMetrics.repeatedQuestions, 0); assert.equal(frozen.questionMetrics.shownAttempts, 1);
  assert.equal(frozen.frozen.rows.find(row => row.kind === 'question').questionStatus, 'open');
  frozen.frozen.rows[0].sources[0].payload.text = 'Caller changed source'; frozen.questionMetrics.shownAttempts = 999;
  assert.deepEqual((await f.call('read', frozen.reviewId)).value, expected);
  send('audit-show-two');
  ledger.ingest({ eventId: 'later-audit-source', sourceRef: 'task:audit', kind: 'request', payload: { text: 'Later synthetic source' } });
  assert.equal(ledger.questionSendMetrics().repeatedQuestions, 1);
  const questions = ledger.snapshot().questions; let businessAnswers = 0;
  ledger.answerQuestion = () => { businessAnswers++; throw Error('A review cannot answer a business question'); };
  const value = { reviewId: expected.reviewId, contentDigest: expected.contentDigest, expectedRevision: expected.revision,
    disagreedSuggestionIds: [expected.frozen.rows[0].suggestionId], disagreedCandidateIds: [], allRead: true };
  assert.equal((await f.call('confirm', { ...value, disagreedSuggestionIds: ['suggestion:unknown'] })).ok, false);
  const confirmed = await f.call('confirm', value); assert.equal(confirmed.ok, true, confirmed.error);
  assert.equal(confirmed.value.revision, 1); assert.equal(confirmed.value.confirmation.allRead, true);
  assert.equal(businessAnswers, 0); assert.deepEqual(ledger.snapshot().questions, questions);
  assert.deepEqual(confirmed.value.frozen, expected.frozen); assert.deepEqual(confirmed.value.questionMetrics, expected.questionMetrics);
  assert.equal((await f.call('confirm', value)).value.revision, 1);
  ledger.closeQuestionMetricEpoch();
  const restarted = open();
  assert.notEqual(restarted.ledger, ledger);
  assert.deepEqual((await f.call('latest')).value, confirmed.value);
  assert.deepEqual((await f.call('read', expected.reviewId)).value, confirmed.value);
  assert.deepEqual((await f.call('confirm', value)).value, confirmed.value);
  assert.equal(restarted.ledger.snapshot().questions[0].status, 'open');
  assert.equal((await f.call('availability')).value.recordPeriod, 'off');
  restarted.ledger.closeQuestionMetricEpoch();
});

test('preload exposes a dedicated butlerReview IPC wrapper without a generic invocation API', async () => {
  const source = fs.readFileSync(require.resolve('../preload.cjs'), 'utf8'), calls = []; let api;
  vm.runInNewContext(source, { require(name) { assert.equal(name, 'electron'); return {
    contextBridge: { exposeInMainWorld(key, value) { if (key === 'workspace') api = value; } },
    ipcRenderer: { on() {}, invoke: async (...args) => { calls.push(args); return { ok: true, value: 'host-review' }; } },
  }; } });
  assert.equal(typeof api.butlerReview, 'function');
  assert.equal(api.invoke, undefined); assert.equal(api.call, undefined);
  assert.equal(await api.butlerReview('read', 'review:one'), 'host-review');
  assert.deepEqual(calls, [['workspace:butlerReview', 'read', 'review:one']]);
});


test('the person reads bounded read-audit metadata independently of the review journal, never through an agent command', async t => {
  const f = fixture(t), options = { afterSequence: 0, limit: 2 };
  const result = await f.call('reads', options);
  assert.equal(result.ok, true); assert.equal(result.value.records[0].result.count, 1);
  assert.equal(f.auditCalls[0].actor, f.person.context); assert.equal(f.auditCalls[0].options, options);
  assert.equal(f.calls.length, 0); assert.equal(f.handlers.has('butlerReview'), false);
  const invoke = f.ipc.get('workspace:butlerReview');
  assert.equal((await invoke(f.agent.event, 'reads', options)).ok, false);
  assert.equal(f.auditCalls.length, 1);
  f.sandbox.butlerIngress = null;
  assert.equal((await f.call('reads', {})).ok, true, 'A review-journal failure cannot hide the separate metadata audit');
  f.sandbox.butlerReadAudit = null;
  const unavailable = await f.call('reads', {}); assert.equal(unavailable.ok, false);
  assert.equal(unavailable.uiMessage.key, 'error.butler.readAuditUnavailable');
});

test('read-audit IPC refuses arbitrary scopes, counts, identities and malformed paging before storage access', async t => {
  const f = fixture(t);
  for (const args of [[], [null], [[]], [{}, {}], [{ afterSequence: -1 }], [{ afterSequence: '0' }],
    [{ limit: 0 }], [{ limit: 51 }], [{ limit: 1.5 }], [{ actor: { kind: 'person' } }],
    [{ path: 'arbitrary-file' }], [{ records: [] }], [{ text: 'arbitrary-body' }]]) {
    assert.equal((await f.call('reads', ...args)).ok, false);
  }
  assert.equal(f.auditCalls.length, 0); assert.equal(f.calls.length, 0);
});

test('the actual Main initializer and handler use the opaque person verifier with the real read-audit store', async t => {
  const { ButlerReadAudit } = require('../butler-read-audit.cjs');
  const f = fixture(t);
  const environment = { windows: f.windows, applicationHandlers: f.handlers,
    ipcMain: { handle: (name, handler) => f.ipc.set(name, handler) }, trusted: url => url === 'synthetic-trusted',
    uiLocale: locale, uiError, backgroundOperation: require('../background-operation.cjs'), dataDir: f.directory, ButlerReadAudit };
  const open = () => new Function(...Object.keys(environment), 'let butlerReadAudit = null; const butlerIngress = null;\n' +
    section('function isCurrentHumanContext(', '\nfunction showDialog(') + '\n' +
    section('function register(name, handler)', '\nasync function replaceBackendSockets(') + '\n' +
    section('  try { butlerReadAudit ||=', '  try { butlerBackend =') + '\n' +
    section("  register('butlerReview',", "  register('queueSecretary',") + '\nreturn butlerReadAudit;')(...Object.values(environment));
  const audit = open(); assert.ok(audit instanceof ButlerReadAudit);
  audit.recordPage({ actor: { sessionId: 'synthetic-instance', nativeId: 'synthetic-native', selectionRevision: 1, runnerRef: 'runner' },
    query: { kind: 'spaces', spaceId: null, includeArchived: false, limit: 20 },
    result: { count: 0, recordRefs: [], scanned: 0, truncated: false } });
  assert.equal((await f.call('reads', {})).value.records.length, 1);
  assert.throws(() => audit.read({ ...f.person.context }), { code: 'ERR_BUTLER_READ_AUDIT_PERSON' });
  f.windows.set(1, { ...f.person.context });
  assert.throws(() => audit.read(f.person.context), { code: 'ERR_BUTLER_READ_AUDIT_PERSON' });
  assert.equal((await f.call('reads', {})).ok, true, 'IPC resolves the replacement trusted human context rather than trusting the stale one');
  f.windows.delete(1); await assert.rejects(f.call('reads', {}), /Unexpected IPC source/);
});
