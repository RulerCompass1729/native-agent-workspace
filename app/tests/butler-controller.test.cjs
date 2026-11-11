'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { ButlerRole } = require('../butler-role.cjs'), { ButlerLedger } = require('../butler-ledger.cjs'), { ButlerController } = require('../butler-controller.cjs');
const runner = { runnerRef: 'butler:runner-a', backendRef: 'butler:backend-a', purpose: 'butler', profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro' };
const envelope = (input, selection, reply = { actions: [] }, costMicros = 1) => ({ batchId: input.batchId, attempt: input.attempt, selection, reply, usage: { costMicros } });
const selectionFor = role => { const selected = role.current(); return { selectionRevision: selected.selectionRevision, identity: selected.identity, runnerRef: selected.runner.runnerRef }; };
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-controller-')); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const person = Symbol('person'), role = new ButlerRole(directory, { authorizePerson: actor => actor === person });
  role.set(person, { identity: { sessionId: 'butler-a', nativeId: 'native-a' }, runner, budget: { limitMicros: 100 } }, 0);
  const records = [{ id: 'butler-a', nativeId: 'native-a', provider: 'codex', state: 'idle', roomIds: [], runner }];
  const spaces = [{ id: 'shared', name: 'Example space', archived: false, writable: true, members: [], queue: [] }];
  let time = Date.UTC(2026, 10, 9); const now = () => time;
  const newLedger = () => new ButlerLedger(directory, { now, authorizePerson: actor => actor === person });
  const ledger = newLedger(), calls = [], invocations = [], timers = new Map(), blocked = [], reports = [], questions = [];
  const run = async (input, selection) => {
    calls.push(input); invocations.push({ input, selection });
    if (options.run) return options.run(input, selection);
    return envelope(input, selection, { actions: input.events.filter(e => ['request', 'queue-empty'].includes(e.kind)).map(e => ({ kind: 'queue', sourceRef: e.sourceRef, text: 'Proposed synthetic task' })).concat([{ kind: 'report', sourceRef: input.events[0].sourceRef, text: 'New synthetic progress' }]) });
  };
  const publish = async r => { reports.push(r); return { deliveryId: r.deliveryId, status: 'sent' }; };
  const ask = async q => { questions.push(q); return { deliveryId: q.deliveryId, status: 'sent' }; };
  const makeController = (actualLedger, overrides = {}) => {
    const value = new ButlerController({ role, ledger: actualLedger, backend: { ensure: async () => ({ ready: true, binding: runner }) }, view: () => ({ records, spaces }), run,
    publish, ask,
    now, schedule: (fn, delay) => { const token = {}; timers.set(token, { fn, delay }); return token; }, cancel: token => timers.delete(token),
    estimateBatchCost: () => 1, onBlocked: x => blocked.push(x), ...options.controller, ...overrides });
    t.after(() => value.close()); return value;
  };
  const controller = makeController(ledger);
  const event = (n, kind = 'request') => ({ eventId: 'event-' + n, sourceRef: 'message-' + n, kind, payload: { text: 'Synthetic request ' + n } });
  const questionEvent = (n, key, kind = 'request', decisionKind = 'approval') => ({ ...event(n, kind), payload: { text: 'Synthetic question ' + n, questionKey: key, decisionKind } });
  return { controller, ledger, role, person, records, spaces, calls, invocations, timers, blocked, reports, questions, event, questionEvent, directory, publish, ask, newLedger,
    reopen: overrides => { const next = newLedger(); return { ledger: next, controller: makeController(next, overrides) }; }, advance: n => { time += n; } };
}
function completeFixtureBatch(f, event, actions) {
  f.ledger.ingest(event);
  const selection = selectionFor(f.role), batch = f.ledger.beginBatch(selection), attempt = f.ledger.beginAttempt(batch.batchId, selection);
  f.ledger.recordAttemptUsage(batch.batchId, selection, { costMicros: 0 }, attempt.attempt);
  f.ledger.completeBatch(batch.batchId, selection, { actions });
  return { batch, selection, attempt: attempt.attempt };
}
test('READY has one non-extending timer and a report even when the model emits no actions', async t => {
  const f = fixture(t, { run: async (input, selection) => envelope(input, selection) }); await f.controller.receive(f.event(1, 'ready'));
  const first = [...f.timers.values()][0]; assert.equal(first.delay, 30000);
  f.advance(10000); await f.controller.receive(f.event(2, 'ready')); assert.equal(f.timers.size, 1); assert.equal([...f.timers.values()][0], first); assert.equal(f.calls.length, 0);
  f.timers.clear(); first.fn(); await f.controller.running;
  assert.equal(f.calls.length, 1); assert.equal(f.reports.length, 1); assert.equal(f.timers.size, 0);
  assert.deepEqual(f.reports[0].eventIds, ['event-1', 'event-2']);
  await f.controller.receive(f.event(1, 'ready')); await f.controller.flushReports(); assert.equal(f.calls.length, 1); assert.equal(f.reports.length, 1);
});
test('requests become unassigned record-only queue proposals and no lifecycle API exists', async t => {
  const f = fixture(t); assert.equal((await f.controller.receive(f.event(1))).status, 'recorded');
  const actions = f.ledger.snapshot().actions; assert.ok(actions.some(a => a.kind === 'queue' && a.spaceId === 'shared')); assert.ok(actions.every(a => a.effect === 'none' && !Object.hasOwn(a, 'assignee')));
  assert.equal(f.calls.length, 1); assert.equal(f.ledger.pendingEvents().length, 0);
});
test('B1 decisions and failures persist without model work or blocking a later request', async t => {
  const f = fixture(t);
  for (let i = 0; i < 110; i++) await f.controller.receive(f.event(i, i % 2 ? 'decision' : 'failure'));
  assert.equal(f.calls.length, 0); assert.equal(f.ledger.pendingEvents().length, 0);
  await f.controller.receive(f.event('next')); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].events.length, 1); assert.equal(f.ledger.snapshot().events.length, 111);
});
test('durable pending questions produce zero repeat notifications across wording changes and restart', async t => {
  const f = fixture(t, { run: async (input, selection) => envelope(input, selection, { actions: [{ kind: 'question', sourceRef: input.events[0].sourceRef, decisionKind: 'approval', text: 'Question wording ' + input.events[0].eventId }] }) });
  for (let i = 0; i < 18; i++) {
    // Different source refs for the same host-owned decision must still dedupe.
    await f.controller.receive(f.questionEvent('question-' + i, 'canonical-decision-' + (i % 11)));
  }
  assert.equal(f.questions.length, 11); assert.equal(f.ledger.snapshot().questions.length, 11);
  assert.equal(f.calls.length, 18);
  const reopened = f.newLedger(), question = reopened.snapshot().questions[0];
  assert.equal(reopened.reserveQuestion({ sourceRef: question.sourceRef, decisionKind: question.decisionKind, text: 'Another wording' }).shouldNotify, false);
});
test('failure retains the same batch and performs no paid-style automatic retry', async t => {
  let attempt = 0;
  const f = fixture(t, { run: async (input, selection) => { if (++attempt === 1) throw Error('Synthetic transport failure'); return envelope(input, selection); } });
  const failed = await f.controller.receive(f.event(1)); assert.equal(failed.status, 'blocked'); const batchId = f.ledger.snapshot().activeBatch.batchId;
  await f.controller.receive(f.event(2)); assert.equal(attempt, 1); assert.equal(f.ledger.snapshot().activeBatch.batchId, batchId);
  assert.equal((await f.controller.receive(f.event(3, 'recovery'))).reason, 'usage-cost-unknown');
  assert.equal(attempt, 1, 'Recovery is not permission to treat the prior unknown spend as zero');
  const original = f.invocations[0];
  f.ledger.recordAttemptUsage(batchId, original.selection, { costMicros: 0 }, original.input.attempt);
  await f.controller.receive(f.event(4, 'recovery'));
  assert.equal(f.ledger.snapshot().activeBatch, null); assert.equal(f.ledger.snapshot().batches[0].batchId, batchId); assert.ok(attempt >= 2);
});
test('old native reply is refused after the person revokes the role', async t => {
  let finish; const waiting = new Promise(resolve => { finish = resolve; });
  const f = fixture(t, { run: async (input, selection) => { await waiting; return envelope(input, selection); } });
  const running = f.controller.receive(f.event(1));
  await new Promise(resolve => setImmediate(resolve)); f.role.revoke(f.person, 1); finish();
  assert.equal((await running).status, 'blocked'); assert.equal(f.ledger.snapshot().actions.length, 0); assert.equal(f.ledger.pendingEvents().some(e => e.eventId === 'event-1'), true);
  assert.equal(f.ledger.snapshot().attempts[0].usage.costMicros, 1, 'A stale role reply still has trusted native usage');
});
test('unknown amount and absent budget never turn into zero or start another native batch', async t => {
  const f = fixture(t, { controller: { estimateBatchCost: () => null } });
  assert.equal((await f.controller.receive(f.event(1))).reason, 'next-batch-cost-unknown'); assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
  f.role.set(f.person, { identity: { sessionId: 'butler-a', nativeId: 'native-a' }, runner }, 1);
  assert.equal((await f.controller.receive(f.event(2, 'recovery'))).reason, 'budget-unset'); assert.equal(f.calls.length, 0);
});
test('restart never repeats an unconfirmed native turn and restores the original READY deadline', async t => {
  const f = fixture(t); f.ledger.ingest(f.event(1, 'ready')); f.advance(10000);
  await f.controller.resume(); assert.equal([...f.timers.values()][0].delay, 20000); await f.controller.close();
  const s = f.role.current(); f.ledger.beginBatch({ selectionRevision: s.selectionRevision, identity: s.identity, runnerRef: s.runner.runnerRef });
  const restored=new ButlerController({role:f.role,ledger:f.newLedger(),backend:{},view:()=>({records:f.records,spaces:[]}),run:async()=>{throw Error('No repeat native turn');}});t.after(()=>restored.close());
  assert.equal((await restored.resume()).status,'awaiting-retry');assert.equal(f.calls.length,0);assert.equal(restored.ledger.snapshot().activeBatch.failure,'restart-unconfirmed');
});
test('events arriving during a turn are processed once afterward, with no concurrent native turns', async t => {
  let finish, active = 0, maximum = 0, count = 0;
  const pause = new Promise(resolve => { finish = resolve; });
  const f = fixture(t, { run: async (input, selection) => {
    active++; maximum = Math.max(maximum, active); if (++count === 1) await pause; active--;
    return envelope(input, selection);
  } });
  const first = f.controller.receive(f.event(1)); await new Promise(resolve => setImmediate(resolve));
  const second = f.controller.receive(f.event(2)); finish(); await Promise.all([first, second]);
  assert.equal(count, 2); assert.equal(maximum, 1); assert.equal(f.ledger.pendingEvents().length, 0); assert.equal(f.timers.size, 0);
});
test('reaching the daily amount reports it once and prevents new automatic batches', async t => {
  const f = fixture(t, { run: async (input, selection) => envelope(input, selection, { actions: [] }, 100) });
  await f.controller.receive(f.event(1)); assert.equal(f.blocked.filter(b => b.reason === 'daily-budget-reached').length, 1);
  assert.equal((await f.controller.receive(f.event(2))).reason, 'daily-budget-reached');
  assert.equal(f.blocked.filter(b => b.reason === 'daily-budget-reached').length, 1);
  assert.equal(f.ledger.snapshot().batches.filter(b => b.status === 'completed').length, 1);
});
test('a non-member role follows only a completed handoff and rebinds its pending batch without a new ID', async t => {
  let qualified = false;
  const f = fixture(t); f.controller.backend.ensure = async () => ({ ready: qualified, binding: runner });
  await f.controller.receive(f.event(1)); const batchId = f.ledger.snapshot().activeBatch.batchId;
  f.records[0].state = 'ended'; f.records.push({ ...f.records[0], id: 'butler-next', nativeId: 'native-next', state: 'idle' });
  fs.writeFileSync(path.join(f.directory, 'rotation-log.jsonl'), JSON.stringify({ event: 'done', old: { id: 'butler-a', nativeId: 'native-a' }, new: { id: 'butler-next', nativeId: 'native-next' } }) + '\n', { mode: 0o600 });
  qualified = true; assert.equal((await f.controller.receive(f.event(2, 'recovery'))).status, 'recorded');
  const batch = f.ledger.snapshot().batches[0]; assert.equal(batch.batchId, batchId); assert.equal(batch.selection.identity.sessionId, 'butler-next');
  assert.equal(f.role.current().selectionRevision, 1); assert.equal(f.ledger.pendingEvents().length, 0);
  assert.deepEqual(require('../butler-policy.cjs').rotationCandidates(f.role.current(), f.records), ['butler-next']);
});
test('a question already handled by B1 is kept pending without asking it again', async t => {
  const f = fixture(t), event = f.questionEvent(1, 'b1-decision', 'decision'); await f.controller.receive(event);
  f.controller.observeQuestion({ sourceRef: event.sourceRef, decisionKind: 'approval', text: 'Already asked by the system' });
  await f.controller.flushQuestions(); assert.equal(f.questions.length, 0); assert.equal(f.calls.length, 0);
  assert.equal(f.ledger.snapshot().questions[0].status, 'open'); assert.equal(f.ledger.snapshot().deliveries[0].status, 'unknown');
});

test('receive without an earlier resume never repeats a disk-running native attempt', async t => {
  const f = fixture(t), event = f.event('before-restart');
  f.ledger.ingest(event);
  const selection = selectionFor(f.role), batch = f.ledger.beginBatch(selection);
  const attempt = f.ledger.beginAttempt(batch.batchId, selection);
  await f.controller.close();
  const restored = f.reopen();
  assert.equal(restored.ledger.snapshot().activeBatch.status, 'failed', 'The constructor recovers the unsafe running state');
  assert.equal(restored.ledger.snapshot().activeBatch.failure, 'restart-unconfirmed');
  await restored.controller.receive(f.event('new-request'));
  assert.equal(f.calls.length, 0, 'The old native turn must not be submitted a second time');
  assert.equal(restored.ledger.snapshot().activeBatch.batchId, batch.batchId);
  assert.equal(restored.ledger.snapshot().attempts.find(row => row.attempt === attempt.attempt).usage, null);
  assert.equal((await restored.controller.receive(f.event('explicit-recovery', 'recovery'))).reason, 'usage-cost-unknown');
  assert.equal(f.calls.length, 0, 'Explicit recovery cannot convert unknown prior spend to zero');
});

for (const kind of ['question', 'report']) test(`the first receive after completion recovers a pending ${kind} once without model work`, async t => {
  const f = fixture(t);
  const event = kind === 'question' ? f.questionEvent('pending-question', 'canonical-pending') : f.event('pending-report', 'ready');
  const actions = kind === 'question' ? [{ kind, sourceRef: event.sourceRef, decisionKind: 'approval', text: 'Pending synthetic question' }] : [];
  completeFixtureBatch(f, event, actions);
  assert.equal(f.ledger.snapshot().deliveries.length, 0, 'The crash happens before reserving a delivery');
  await f.controller.close();
  const restored = f.reopen(), delivery = f.event('first-receive', 'decision');
  await restored.controller.receive(delivery);
  assert.equal(kind === 'question' ? f.questions.length : f.reports.length, 1);
  await restored.controller.receive(delivery);
  await restored.controller.resume(); await restored.controller.drain();
  assert.equal(kind === 'question' ? f.questions.length : f.reports.length, 1);
  assert.equal(f.calls.length, 0, 'Recovery of a business delivery is local, not a new native turn');
  assert.equal(restored.ledger.snapshot().deliveries[0].status, 'sent');
});

for (const kind of ['question', 'report']) test(`a crash after ${kind} reservation becomes unknown and never resends`, async t => {
  const f = fixture(t);
  const event = kind === 'question' ? f.questionEvent('reserved-question', 'canonical-reserved') : f.event('reserved-report', 'ready');
  completeFixtureBatch(f, event, kind === 'question' ? [{ kind, sourceRef: event.sourceRef, decisionKind: 'approval', text: 'Reserved synthetic question' }] : []);
  if (kind === 'question') {
    const question = f.ledger.snapshot().questions[0];
    f.ledger.reserveQuestion({ sourceRef: question.sourceRef, decisionKind: question.decisionKind, text: question.text });
  } else f.ledger.reserveReport(f.ledger.snapshot().reports[0].reportId);
  assert.equal(f.ledger.snapshot().deliveries[0].status, 'reserved');
  await f.controller.close();
  const restored = f.reopen();
  assert.equal(restored.ledger.snapshot().deliveries[0].status, 'unknown');
  await restored.controller.receive(f.event('after-uncertain-delivery', 'decision'));
  await restored.controller.resume(); await restored.controller.flushQuestions(); await restored.controller.flushReports();
  assert.equal(f.questions.length, 0); assert.equal(f.reports.length, 0); assert.equal(f.calls.length, 0);
  assert.equal(restored.ledger.snapshot().deliveries[0].status, 'unknown');
});

test('a human selection revision change cannot authorize delivery of an old completed report', async t => {
  const f = fixture(t);
  completeFixtureBatch(f, f.event('before-new-selection', 'ready'), []);
  f.role.set(f.person, { identity: { sessionId: 'butler-a', nativeId: 'native-a' }, runner, budget: { limitMicros: 100 } }, 1);
  assert.equal(f.role.current().selectionRevision, 2);
  await f.controller.close();
  const restored = f.reopen();
  await restored.controller.receive(f.event('after-new-selection', 'decision'));
  assert.equal(f.reports.length, 0); assert.equal(f.calls.length, 0);
  assert.equal(restored.ledger.snapshot().reports.length, 1, 'The old report remains auditable');
  assert.equal(restored.ledger.snapshot().deliveries.length, 0, 'Another human selection must not reserve the old report');
});

test('a unique completed handoff with the same selection revision may deliver the pending report', async t => {
  const f = fixture(t);
  completeFixtureBatch(f, f.event('before-valid-handoff', 'ready'), []);
  f.records[0].state = 'ended';
  f.records.push({ ...f.records[0], id: 'butler-next', nativeId: 'native-next', state: 'idle' });
  fs.writeFileSync(path.join(f.directory, 'rotation-log.jsonl'), JSON.stringify({ event: 'done', old: { id: 'butler-a', nativeId: 'native-a' }, new: { id: 'butler-next', nativeId: 'native-next' } }) + '\n', { mode: 0o600 });
  assert.equal(f.role.current().selectionRevision, 1);
  assert.equal(f.role.current().identity.nativeId, 'native-next');
  await f.controller.close();
  const restored = f.reopen();
  await restored.controller.receive(f.event('after-valid-handoff', 'decision'));
  assert.equal(f.reports.length, 1); assert.equal(f.calls.length, 0);
  assert.equal(restored.ledger.snapshot().reports[0].status, 'sent');
});

test('secret-shaped business text is rejected before ingest, reservation or batching', async t => {
  const f = fixture(t), secret = 'Authorization: Bearer NOT_A_REAL_TOKEN';
  const event = f.event('secret-shaped'); event.payload.text = secret;
  await assert.rejects(Promise.resolve().then(() => f.controller.receive(event)));
  const snapshot = f.ledger.snapshot();
  assert.equal(snapshot.events.length, 0); assert.equal(snapshot.batches.length, 0); assert.equal(snapshot.activeBatch, null);
  assert.equal(f.calls.length, 0);
  const saved = fs.existsSync(f.ledger.file) ? fs.readFileSync(f.ledger.file, 'utf8') : '';
  assert.equal(saved.includes(secret), false, 'Refusing to send must also avoid persisting the prohibited bytes');
});

for (const invalid of ['name', 'members', 'queue']) test(`an invalid ${invalid} catalog cannot create an active batch or wedge the next request`, async t => {
  const f = fixture(t), original = structuredClone(f.spaces[0]);
  if (invalid === 'name') f.spaces[0].name = 'x'.repeat(201);
  if (invalid === 'members') f.spaces[0].members = Array.from({ length: 101 }, (_, i) => ({ id: 'member-' + i, name: 'Synthetic member', state: 'idle' }));
  if (invalid === 'queue') f.spaces[0].queue = Array.from({ length: 301 }, (_, i) => ({ id: 'item-' + i, text: 'Finished synthetic item', status: 'done' }));
  const rejected = await f.controller.receive(f.event('bad-catalog'));
  assert.notEqual(rejected.status, 'recorded');
  assert.equal(f.ledger.snapshot().activeBatch, null); assert.equal(f.ledger.snapshot().batches.length, 0); assert.equal(f.calls.length, 0);
  Object.assign(f.spaces[0], original);
  assert.equal((await f.controller.receive(f.event('catalog-restored'))).status, 'recorded');
  assert.equal(f.calls.length, 1); assert.equal(f.ledger.snapshot().activeBatch, null);
  assert.ok(f.calls[0].events.some(event => event.eventId === 'event-catalog-restored'));
});

test('a question without host decision metadata is suspended without quarantining its batch or blocking later work', async t => {
  let count = 0;
  const f = fixture(t, { run: async (input, selection) => envelope(input, selection, { actions: ++count === 1
    ? [{ kind: 'question', sourceRef: input.events[0].sourceRef, decisionKind: 'approval', text: 'Model-invented decision' }] : [] }) });
  const source = f.event('missing-decision-metadata');
  assert.equal((await f.controller.receive(source)).status, 'recorded');
  const snapshot = f.ledger.snapshot();
  assert.equal(snapshot.activeBatch, null); assert.equal(snapshot.questions.length, 0); assert.equal(f.questions.length, 0);
  assert.equal(snapshot.events.find(event => event.eventId === source.eventId).payload.text, source.payload.text);
  assert.equal(snapshot.quarantined.length, 0); assert.equal(snapshot.suspended.length, 1);
  assert.equal(snapshot.suspended[0].sourceRef, source.sourceRef);
  assert.equal(snapshot.suspended[0].effect, 'none');
  assert.equal(snapshot.batches[0].status, 'completed', 'The candidate is retained as suspended, while its batch completes');
  assert.equal(f.ledger.pendingEvents().some(event => event.eventId === source.eventId), false);
  assert.equal((await f.controller.receive(f.event('valid-after-suspension'))).status, 'recorded');
  assert.equal(f.calls.length, 2); assert.equal(f.ledger.snapshot().activeBatch, null);
  assert.equal(f.calls[1].events.some(event => event.eventId === source.eventId), false);
});

test('a mixed reply suspends only its bad candidate and keeps valid queue work and the trusted READY report', async t => {
  const f = fixture(t, { run: async (input, selection) => {
    const request = input.events.find(event => event.kind === 'request');
    const ready = input.events.find(event => event.kind === 'ready');
    return envelope(input, selection, { actions: [
      { kind: 'question', sourceRef: request.sourceRef, decisionKind: 'approval', text: 'No host decision metadata exists for this candidate' },
      { kind: 'queue', sourceRef: request.sourceRef, text: 'Preserve this valid queue proposal' },
      { kind: 'report', sourceRef: ready.sourceRef, text: 'Preserve this valid progress report' }
    ] });
  } });
  const ready = f.event('mixed-ready', 'ready'), request = f.event('mixed-request');
  await f.controller.receive(ready);
  assert.equal((await f.controller.receive(request)).status, 'recorded');
  const snapshot = f.ledger.snapshot();
  assert.equal(snapshot.suspended.length, 1); assert.equal(snapshot.suspended[0].sourceRef, request.sourceRef);
  assert.equal(snapshot.quarantined.length, 0); assert.equal(snapshot.activeBatch, null); assert.equal(snapshot.pendingEvents.length, 0);
  assert.equal(snapshot.actions.filter(action => action.kind === 'queue').length, 1);
  assert.equal(snapshot.actions.filter(action => action.kind === 'report').length, 1);
  assert.equal(f.questions.length, 0); assert.equal(f.reports.length, 1); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.reports[0].readyEvents.map(event => event.eventId), [ready.eventId]);
  assert.ok(f.reports[0].text.includes('Preserve this valid progress report'));
  const replayed = f.newLedger().snapshot();
  assert.deepEqual(replayed.suspended, snapshot.suspended); assert.deepEqual(replayed.actions, snapshot.actions);
  await f.controller.resume(); assert.equal(f.reports.length, 1); assert.equal(f.calls.length, 1);
});

test('READY still reports when every model candidate is suspended', async t => {
  const f = fixture(t, { run: async (input, selection) => envelope(input, selection, { actions: [
    { kind: 'question', sourceRef: input.events[0].sourceRef, text: 'Unsupported host decision' }
  ] }) });
  const ready = f.event('all-suspended-ready', 'ready');
  await f.controller.receive(ready); const timer = [...f.timers.values()][0]; f.timers.clear(); timer.fn(); await f.controller.running;
  assert.equal(f.ledger.snapshot().suspended.length, 1); assert.equal(f.ledger.snapshot().quarantined.length, 0);
  assert.equal(f.ledger.snapshot().actions.length, 0); assert.equal(f.questions.length, 0); assert.equal(f.reports.length, 1);
  assert.deepEqual(f.reports[0].readyEvents.map(event => event.eventId), [ready.eventId]);
});

for (const failure of ['throws', 'undefined']) test(`a host view that ${failure} preserves pending work without creating or quarantining a batch`, async t => {
  const f = fixture(t), source = f.event('host-view-' + failure);
  f.controller.view = () => { if (failure === 'throws') throw Error('Synthetic context unavailable'); return undefined; };
  const outcome = await f.controller.receive(source);
  assert.equal(outcome.status, 'blocked'); assert.equal(outcome.reason, 'context-unavailable');
  const snapshot = f.ledger.snapshot();
  assert.equal(snapshot.activeBatch, null); assert.equal(snapshot.batches.length, 0); assert.equal(snapshot.quarantined.length, 0);
  assert.ok(snapshot.pendingEvents.some(event => event.eventId === source.eventId)); assert.equal(f.calls.length, 0);
  assert.equal(f.blocked.filter(notice => notice.reason === 'context-unavailable').length, 1);
  f.controller.view = () => ({ records: f.records, spaces: f.spaces });
  assert.equal((await f.controller.receive(f.event('host-view-restored-' + failure, 'recovery'))).status, 'recorded');
  assert.equal(f.calls.length, 1); assert.ok(f.calls[0].events.some(event => event.eventId === source.eventId));
});

test('a failing catalog getter during preflight retains pending events and does not quarantine them', async t => {
  const f = fixture(t); await f.controller.resume();
  f.controller.view = () => ({ records: f.records, get spaces() { throw Error('Synthetic catalog read unavailable'); } });
  const source = f.event('preflight-getter'), result = await f.controller.receive(source);
  assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'context-unavailable');
  assert.equal(f.ledger.snapshot().activeBatch, null); assert.equal(f.ledger.snapshot().batches.length, 0);
  assert.equal(f.ledger.snapshot().quarantined.length, 0); assert.ok(f.ledger.pendingEvents().some(event => event.eventId === source.eventId));
  assert.equal(f.calls.length, 0); assert.equal(f.blocked.filter(notice => notice.reason === 'context-unavailable').length, 1);
  f.controller.view = () => ({ records: f.records, spaces: f.spaces });
  assert.equal((await f.controller.receive(f.event('preflight-getter-restored', 'recovery'))).status, 'recorded');
  assert.equal(f.calls.length, 1);
});

for (const failure of ['view', 'missing-record', 'native-context-pending']) test(`publication recovery exposes ${failure} failures while consuming B1 events without model work`, async t => {
  const f = fixture(t), ready = f.event('pending-before-' + failure, 'ready');
  completeFixtureBatch(f, ready, []); await f.controller.close();
  const restored = f.reopen({ view: () => {
    if (failure === 'view') throw Error('Synthetic publication context unavailable');
    return { records: failure === 'missing-record' ? [] : f.records.map(record => ({ ...record, nativeContextPending: true })), spaces: f.spaces };
  } });
  const decision = f.event('b1-while-' + failure, 'decision');
  const result = await restored.controller.receive(decision);
  assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'context-unavailable');
  const snapshot = restored.ledger.snapshot();
  assert.ok(snapshot.events.some(event => event.eventId === decision.eventId));
  assert.equal(snapshot.pendingEvents.some(event => event.eventId === decision.eventId), false, 'B1 is retained and consumed before publication recovery');
  assert.equal(snapshot.quarantined.length, 0); assert.equal(snapshot.activeBatch, null);
  assert.equal(snapshot.reports[0].status, 'pending'); assert.equal(snapshot.deliveries.length, 0);
  assert.equal(f.calls.length, 0); assert.equal(f.reports.length, 0);
  assert.equal(f.blocked.filter(notice => notice.reason === 'context-unavailable').length, 1);
  restored.controller.view = () => ({ records: f.records, spaces: f.spaces });
  await restored.controller.receive(f.event('publication-recovery-restored-' + failure, 'failure'));
  await restored.controller.resume();
  assert.equal(f.reports.length, 1); assert.equal(f.calls.length, 0);
  assert.equal(restored.ledger.snapshot().reports[0].status, 'sent'); assert.equal(restored.ledger.pendingEvents().length, 0);
});

test('a READY timer exposes a later host failure and preserves the pending READY for recovery', async t => {
  const f = fixture(t), ready = f.event('ready-before-context-loss', 'ready');
  await f.controller.receive(ready); const timer = [...f.timers.values()][0];
  f.controller.view = () => { throw Error('Synthetic timer context unavailable'); };
  f.timers.clear(); timer.fn(); await f.controller.running;
  assert.equal(f.blocked.filter(notice => notice.reason === 'context-unavailable').length, 1);
  assert.equal(f.ledger.snapshot().activeBatch, null); assert.equal(f.ledger.snapshot().quarantined.length, 0);
  assert.ok(f.ledger.pendingEvents().some(event => event.eventId === ready.eventId)); assert.equal(f.calls.length, 0);
  f.controller.view = () => ({ records: f.records, spaces: f.spaces });
  await f.controller.receive(f.event('ready-context-restored', 'recovery'));
  assert.equal(f.calls.length, 1); assert.equal(f.reports.length, 1);
  assert.deepEqual(f.reports[0].readyEvents.map(event => event.eventId), [ready.eventId]);
});

for (const amount of [99, 100]) test(`a parse-invalid reply still charges its known ${amount}/100 cost before any recovery`, async t => {
  const f = fixture(t, { run: async (input, selection) => envelope(input, selection, '{not valid JSON', amount), controller: { estimateBatchCost: () => amount === 99 ? 2 : 1 } });
  await f.controller.receive(f.event('invalid-reply-' + amount));
  const snapshot = f.ledger.snapshot();
  assert.equal(snapshot.attempts.length, 1); assert.equal(snapshot.attempts[0].usage.costMicros, amount);
  assert.equal(snapshot.batches.some(batch => batch.status === 'completed'), false);
  await f.controller.close();
  const restored = f.reopen();
  assert.equal((await restored.controller.receive(f.event('recovery-after-' + amount, 'recovery'))).reason, 'daily-budget-reached');
  assert.equal(f.calls.length, 1, 'Failed parsing and restart cannot reset the billed attempt to zero');
});

test('an old attempt reply with the same batch ID cannot complete the new attempt', async t => {
  let firstAttempt, count = 0;
  const f = fixture(t, { run: async (input, selection) => {
    if (++count === 1) { firstAttempt = input.attempt; throw Error('Synthetic uncertain native result'); }
    return { ...envelope(input, selection, { actions: [{ kind: 'report', sourceRef: input.events[0].sourceRef, text: 'Stale reply must not publish' }] }, 0), attempt: firstAttempt };
  } });
  await f.controller.receive(f.event('attempt-race'));
  const first = f.invocations[0], batchId = first.input.batchId;
  f.ledger.recordAttemptUsage(batchId, first.selection, { costMicros: 0 }, firstAttempt);
  const result = await f.controller.receive(f.event('retry-attempt-race', 'recovery'));
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].batchId, batchId);
  assert.notEqual(f.calls[1].attempt, firstAttempt); assert.notEqual(result.status, 'recorded');
  const snapshot = f.ledger.snapshot();
  assert.equal(snapshot.activeBatch.batchId, batchId); assert.equal(snapshot.activeBatch.status, 'failed');
  assert.equal(snapshot.attempts.find(row => row.batchId === batchId && row.attempt === firstAttempt).usage.costMicros, 0, 'Old usage remains attached to its original attempt');
  assert.equal(snapshot.attempts.find(row => row.attempt === f.calls[1].attempt).usage, null, 'Old cost evidence does not confirm the new native attempt');
  assert.equal(snapshot.actions.length, 0); assert.equal(f.reports.length, 0);
});

test('the model cannot change the host decision kind or cite another source to open the same question twice', async t => {
  let count = 0;
  const f = fixture(t, { run: async (input, selection) => envelope(input, selection, { actions: [{ kind: 'question', sourceRef: input.events[0].sourceRef,
    decisionKind: ++count === 1 ? 'approval' : 'space-selection', text: 'Same decision with changed wording' }] }) });
  await f.controller.receive(f.questionEvent('original-question', 'same-host-decision'));
  assert.equal(f.questions.length, 1);
  const first = f.ledger.snapshot().questions[0];
  const outcome = await f.controller.receive(f.questionEvent('another-ref', 'same-host-decision'));
  assert.equal(outcome.status, 'recorded'); assert.equal(f.questions.length, 1);
  assert.equal(f.ledger.snapshot().suspended.length, 1); assert.equal(f.ledger.snapshot().quarantined.length, 0);
  assert.equal(f.ledger.snapshot().questions.length, 1);
  assert.equal(f.ledger.snapshot().questions[0].questionId, first.questionId);
});

test('the controller fixture ledger only accepts the authenticated person capability for question answers', async t => {
  const f = fixture(t), event = f.questionEvent('system-question', 'person-authority', 'decision');
  await f.controller.receive(event);
  const question = f.controller.observeQuestion({ sourceRef: event.sourceRef, decisionKind: 'approval', text: 'Already delivered by B1' });
  assert.throws(() => f.ledger.answerQuestion(question.questionId, 'Synthetic answer', { kind: 'person' }));
  f.ledger.answerQuestion(question.questionId, 'Synthetic answer', f.person);
  assert.equal(f.ledger.snapshot().questions[0].status, 'answered'); assert.equal(f.calls.length, 0);
});
test('an unreconciled attempt does not become free at the next UTC day or repeat its notice', async t => {
  const f=fixture(t,{run:async()=>{throw Error('Synthetic uncertain native result');}});
  await f.controller.receive(f.event('uncertain'));
  const before=f.blocked.filter(b=>b.reason==='usage-cost-unknown').length;
  f.advance(24*60*60*1000);await f.controller.receive(f.event('next-day','recovery'));
  assert.equal(f.ledger.snapshot().attempts.length,1);
  assert.equal(f.blocked.filter(b=>b.reason==='usage-cost-unknown').length,before);
  assert.equal(f.ledger.snapshot().activeBatch.failure,'usage-cost-unknown');
});

test('a host outage after durable completion leaves the report pending and recovers it once without rerunning work', async t => {
  const f = fixture(t), complete = f.ledger.completeBatch.bind(f.ledger);
  // Inject the outage at the persistence boundary, after the real ledger has
  // committed its result and before the controller authorizes publication.
  f.ledger.completeBatch = (...args) => {
    const result = complete(...args);
    f.controller.view = () => { throw Error('Synthetic host outage after completion'); };
    return result;
  };
  const outcome = await f.controller.receive(f.event('completed-before-outage'));
  assert.equal(outcome.status, 'report-pending');
  const snapshot = f.ledger.snapshot();
  assert.equal(snapshot.activeBatch, null); assert.equal(snapshot.batches[0].status, 'completed');
  assert.equal(snapshot.reports.length, 1); assert.equal(snapshot.reports[0].status, 'pending');
  assert.equal(snapshot.deliveries.length, 0, 'Unavailable publication authority must not reserve delivery');
  assert.equal(f.blocked.filter(notice => notice.reason === 'publication-recovery-unavailable').length, 1);
  assert.equal(f.reports.length, 0); assert.equal(f.calls.length, 1);
  f.controller.view = () => ({ records: f.records, spaces: f.spaces });
  const failure = f.event('b1-after-completed-outage', 'failure');
  assert.equal((await f.controller.receive(failure)).status, 'recorded');
  await f.controller.resume();
  assert.equal(f.reports.length, 1); assert.equal(f.calls.length, 1, 'Recovery publishes the committed report without another model turn');
  assert.equal(f.ledger.snapshot().reports[0].status, 'sent');
  assert.equal(f.ledger.pendingEvents().some(event => event.eventId === failure.eventId), false);
});

for (const delivered of [false, true]) test(`a ${delivered ? 'sent' : 'pending'} stored question remains recoverable when its source gains another host decision`, async t => {
  const f = fixture(t), source = f.questionEvent('stored-before-source-reuse', 'original-host-decision', 'ready');
  completeFixtureBatch(f, source, [{ kind: 'question', sourceRef: source.sourceRef, decisionKind: 'approval', text: 'Original pending decision' }]);
  const original = f.ledger.snapshot().questions[0];
  if (delivered) {
    await f.controller.resume();
    assert.equal(f.questions.length, 1); assert.equal(f.reports.length, 1);
  }
  const nextDecision = f.questionEvent('second-host-decision', 'different-host-decision', 'decision', 'space-selection');
  nextDecision.sourceRef = source.sourceRef;
  f.ledger.ingest(nextDecision); f.ledger.consumeRecorded([nextDecision.eventId]);
  await f.controller.close();
  const restored = f.reopen();
  assert.equal((await restored.controller.receive(f.event('recover-reused-source', 'failure'))).status, 'recorded');
  const recovered = restored.ledger.snapshot();
  assert.equal(f.questions.length, 1, 'The original pending question is sent once, and an already sent question is never sent again');
  assert.equal(f.questions[0].questionId, original.questionId); assert.equal(f.questions[0].decisionKind, 'approval');
  assert.equal(f.questions[0].decisionSource, 'original-host-decision');
  assert.equal(f.reports.length, 1); assert.equal(recovered.reports[0].status, 'sent');
  assert.equal(f.calls.length, 0, 'Recovery uses the committed question and report without model work');
  assert.equal(f.blocked.some(notice => notice.reason === 'publication-recovery-unavailable'), false);
  assert.equal((await restored.controller.receive(f.event('work-after-reused-source'))).status, 'recorded');
  assert.equal(f.calls.length, 1); assert.equal(f.questions.length, 1); assert.equal(f.reports.length, 2);
  assert.equal(restored.ledger.snapshot().activeBatch, null);
});

test('one unavailable stored question does not suppress another question, READY reporting or later work', async t => {
  const f = fixture(t), first = f.questionEvent('isolated-question', 'isolated-host-decision'),
    second = f.questionEvent('deliverable-question', 'deliverable-host-decision'), ready = f.event('question-isolation-ready', 'ready');
  for (const event of [first, second, ready]) f.ledger.ingest(event);
  const selection = selectionFor(f.role), batch = f.ledger.beginBatch(selection), attempt = f.ledger.beginAttempt(batch.batchId, selection);
  f.ledger.recordAttemptUsage(batch.batchId, selection, { costMicros: 0 }, attempt.attempt);
  f.ledger.completeBatch(batch.batchId, selection, { actions: [
    { kind: 'question', sourceRef: first.sourceRef, decisionKind: 'approval', text: 'Unavailable stored decision' },
    { kind: 'question', sourceRef: second.sourceRef, decisionKind: 'approval', text: 'Deliverable stored decision' }
  ] });
  const unavailable = f.ledger.snapshot().questions.find(question => question.sourceRef === first.sourceRef),
    deliverable = f.ledger.snapshot().questions.find(question => question.sourceRef === second.sourceRef);
  const reserve = f.ledger.reserveStoredQuestion.bind(f.ledger);
  f.ledger.reserveStoredQuestion = questionId => {
    if (questionId === unavailable.questionId) {
      const error = Error('Synthetic unavailable stored decision'); error.code = 'BUTLER_QUESTION_STATE'; throw error;
    }
    return reserve(questionId);
  };
  await f.controller.resume();
  assert.equal(f.calls.length, 0); assert.equal(f.questions.length, 1); assert.equal(f.questions[0].questionId, deliverable.questionId);
  assert.equal(f.reports.length, 1); assert.deepEqual(f.reports[0].readyEvents.map(event => event.eventId), [ready.eventId]);
  const notice = f.blocked.filter(item => item.reason === 'question-delivery-unavailable');
  assert.equal(notice.length, 1); assert.equal(notice[0].questionId, unavailable.questionId);
  let snapshot = f.ledger.snapshot();
  assert.equal(snapshot.events.find(event => event.eventId === notice[0].eventId).payload.itemId, unavailable.questionId);
  assert.equal(snapshot.deliveries.some(delivery => delivery.targetId === unavailable.questionId), false);
  assert.equal(snapshot.deliveries.find(delivery => delivery.targetId === deliverable.questionId).status, 'sent');
  assert.equal(snapshot.reports[0].status, 'sent'); assert.equal(snapshot.questions.find(question => question.questionId === unavailable.questionId).status, 'open');
  await f.controller.flushQuestions();
  assert.equal((await f.controller.receive(f.event('work-after-isolated-question'))).status, 'recorded');
  snapshot = f.ledger.snapshot();
  assert.equal(f.calls.length, 1, 'One question fault causes no recovery model call and cannot block the next real request');
  assert.equal(f.questions.length, 1); assert.equal(f.reports.length, 2); assert.equal(snapshot.activeBatch, null);
  assert.equal(f.blocked.filter(item => item.reason === 'question-delivery-unavailable').length, 1, 'The durable question-specific fault notice is not repeated');
  assert.equal(f.blocked.some(item => item.reason === 'publication-recovery-unavailable'), false);
});
