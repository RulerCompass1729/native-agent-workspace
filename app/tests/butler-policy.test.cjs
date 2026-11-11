'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { validateEvent, catalogRows, buildInput, interpretResult, rotationCandidates } = require('../butler-policy.cjs');
const event = { eventId: 'event-a', kind: 'request', sourceRef: 'message-a', payload: { text: 'Prepare the synthetic task' } };
const space = { id: 'shared', name: 'Example space', archived: false, writable: true, members: [{ id: 'worker-a', name: 'Example member', state: 'idle' }], queue: [] };
function expectSuspended(action, options, reason = 'ERR_BUTLER_RESULT') {
  const result = interpretResult({ actions: [action] }, options);
  assert.deepEqual(result.actions, []); assert.equal(result.suspended.length, 1);
  assert.deepEqual(Object.fromEntries(['stage', 'index', 'reason'].map(k => [k, result.suspended[0][k]])), { stage: 'policy', index: 0, reason });
  return result.suspended[0];
}
test('outbound context contains only approved business fields, never private native history or environment', () => {
  const source = { ...space };
  Object.defineProperty(source, 'messages', { enumerable: true, get() { throw Error('Private history must not be read'); } });
  const result = buildInput({ batchId: 'batch-a', events: [event], catalog: [source], questions: [] });
  assert.equal(result.mode, 'record-only'); assert.deepEqual(result.spaces, [{ id: space.id, name: space.name, members: space.members, queue: [] }]);
  for (const extra of ['environment', 'nativeHistory', 'privateMessages']) assert.throws(() => buildInput({ batchId: 'batch-a', events: [{ ...event, payload: { ...event.payload, [extra]: 'synthetic' } }], catalog: [space] }));
  const assignment = ['DEEPSEEK_API_KEY', 'synthetic-only'].join('=');
  assert.throws(() => buildInput({ batchId: 'batch-a', events: [{ ...event, payload: { text: assignment } }], catalog: [space] }));
});
test('model output cannot select an executor, grant itself authority or report an actual lifecycle effect', () => {
  const action = { kind: 'queue', sourceRef: event.sourceRef, text: 'Task' }, options = { events: [event], catalog: [space] };
  assert.deepEqual(interpretResult({ actions: [action] }, options).actions, [{ ...action, spaceId: 'shared' }]);
  for (const patch of [{ assignee: 'worker-a' }, { sessionId: 'butler' }, { effect: 'executed' }, { method: 'archiveSession' }, { actionId: 'model-invented' }]) expectSuspended({ ...action, ...patch }, options);
  assert.equal(expectSuspended({ ...action, sourceRef: 'old-unrelated-message' }, options).sourceRef, undefined);
  assert.throws(() => interpretResult({ actions: [action], usage: { costMicros: 0 } }, options), 'The model cannot override trusted usage');
  for (const kind of ['open', 'archive']) assert.deepEqual(interpretResult({ actions: [{ ...action, kind }] }, options), { actions: [{ ...action, kind }] });
});
test('ambiguous or unwritable spaces become a stable decision instead of guessing or creating a space', () => {
  const action = { kind: 'queue', sourceRef: event.sourceRef, text: 'Task' };
  const host = { ...event, payload: { ...event.payload, questionKey: 'task-a-space', decisionKind: 'space-selection' } };
  for (const catalog of [[], [space, { ...space, id: 'other-space' }], [{ ...space, archived: true }]]) {
    assert.deepEqual(interpretResult({ actions: [action] }, { events: [host], catalog }), { actions: [{ ...action, kind: 'question', decisionKind: 'space-selection' }] });
    expectSuspended(action, { events: [event], catalog }, 'ERR_BUTLER_QUESTION_SOURCE');
  }
  expectSuspended({ ...action, spaceId: 'unlisted' }, { events: [event], catalog: [space] });
});
test('event validation matches ledger text and identity limits before private storage', () => {
  const limits = { text: 12000, title: 400, spaceId: 200, spaceName: 200, memberName: 200,
    memberId: 200, itemId: 200, outcome: 200, reason: 2000, decisionKind: 200, questionKey: 600, supersedes: 200 };
  const payload = Object.fromEntries(Object.entries(limits).map(([key, limit]) => [key, 'x'.repeat(limit)]));
  const full = { eventId: 'i'.repeat(200), sourceRef: 's'.repeat(600), kind: 'request', payload };
  assert.deepEqual(validateEvent(full), full);
  const outbound = buildInput({ batchId: 'b'.repeat(200), events: [{ ...full, sequence: 1, time: 123 }], catalog: [] });
  assert.deepEqual(outbound.events, [full]);
  for (const [key, limit] of Object.entries(limits)) assert.throws(() => validateEvent({ ...event, payload: { [key]: 'x'.repeat(limit + 1) } }), { code: 'ERR_BUTLER_BUSINESS_DATA' }, key);
  for (const patch of [{ eventId: 'i'.repeat(201) }, { eventId: 'white space' }, { sourceRef: 's'.repeat(601) }, { kind: 'heartbeat' }, { payload: { text: 'control\u0001' } }]) assert.throws(() => validateEvent({ ...event, ...patch }), { code: 'ERR_BUTLER_BUSINESS_DATA' });
  assert.deepEqual(validateEvent({ ...event, payload: { text: 'Line one\n\tLine two\r\n' } }).payload, { text: 'Line one\n\tLine two\r\n' });
});
test('unknown event fields and obvious secret forms are rejected without reading their values', () => {
  for (const location of ['event', 'payload']) for (const key of ['env', 'environment', 'nativeHistory', 'privateMessages']) {
    let read = false; const value = { ...event, payload: { ...event.payload } };
    Object.defineProperty(location === 'event' ? value : value.payload, key, { enumerable: true, get() { read = true; throw Error('Forbidden context getter'); } });
    assert.throws(() => validateEvent(value), { code: 'ERR_BUTLER_BUSINESS_DATA' });assert.equal(read, false);
  }
  const synthetic = ['DEEPSEEK_API_KEY', 'synthetic-placeholder'].join('=');
  for (const key of ['eventId', 'sourceRef']) assert.throws(() => validateEvent({ ...event, [key]: synthetic }), { code: 'ERR_BUTLER_BUSINESS_DATA' });
  for (const value of [synthetic, 'Authorization: Bearer synthetic-placeholder', '-----BEGIN PRIVATE KEY-----']) assert.throws(() => validateEvent({ ...event, payload: { text: value } }), { code: 'ERR_BUTLER_BUSINESS_DATA' });
});
test('catalog and open-question context use ledger limits and omit all private getters', () => {
  const catalog = { ...space, name: 'n'.repeat(200), members: [{ ...space.members[0], name: 'm'.repeat(200) }], queue: [{ id: 'queued-a', status: 'queued', text: 'q'.repeat(12000) }] };
  for (const value of [catalog, catalog.members[0], catalog.queue[0]]) Object.defineProperty(value, 'nativeHistory', { enumerable: true, get() { throw Error('Private context must remain untouched'); } });
  const question = { questionId: 'q'.repeat(200), sourceRef: 's'.repeat(600), decisionSource: 'd'.repeat(600), decisionKind: 'k'.repeat(200), text: 't'.repeat(12000), status: 'open' };
  Object.defineProperty(question, 'conversation', { enumerable: true, get() { throw Error('Private question context'); } });
  const result = buildInput({ batchId: 'batch-a', events: [event], catalog: [catalog], questions: [question] });
  assert.equal(result.spaces[0].name.length, 200);assert.equal(result.spaces[0].members[0].name.length, 200);assert.equal(result.spaces[0].queue[0].text.length, 12000);
  assert.deepEqual(result.pendingQuestions, [{ questionId: question.questionId, sourceRef: question.sourceRef, decisionSource: question.decisionSource, decisionKind: question.decisionKind, text: question.text }]);
  const archived = { archived: true, writable: true };Object.defineProperty(archived, 'messages', { enumerable: true, get() { throw Error('Archived private history'); } });
  assert.deepEqual(catalogRows([archived]), []);
  const closed = Array.from({ length: 501 }, () => ({ status: 'answered' }));
  assert.deepEqual(buildInput({ batchId: 'batch-a', events: [event], catalog: [], questions: closed }).pendingQuestions, [], 'Closed history does not consume the pending-question context allowance');
});
test('context capacity failures are typed before a batch needs to start', () => {
  for (const catalog of [Array.from({ length: 201 }, () => space), [{ ...space, name: 'n'.repeat(201) }],
    [{ ...space, members: Array.from({ length: 101 }, () => space.members[0]) }],
    [{ ...space, members: [{ ...space.members[0], name: 'm'.repeat(201) }] }],
    [{ ...space, queue: Array.from({ length: 301 }, (_, i) => ({ id: 'q-' + i, status: 'done', text: 'Recorded' })) }],
    [{ ...space, queue: [{ id: 'q', status: 'queued', text: 'q'.repeat(12001) }] }]]) assert.throws(() => catalogRows(catalog), { code: 'ERR_BUTLER_CATALOG' });
  const question = { questionId: 'q', sourceRef: event.sourceRef, decisionKind: 'approval', text: 'Pending', status: 'open' };
  for (const questions of [[{ ...question, text: 'q'.repeat(12001) }], Array.from({ length: 501 }, () => question)]) assert.throws(() => buildInput({ batchId: 'batch-a', events: [event], catalog: [space], questions }), { code: 'ERR_BUTLER_CATALOG' });
});
test('question source and decision kind come only from trusted host metadata', () => {
  const host = { ...event, payload: { ...event.payload, questionKey: 'task-a-approval', decisionKind: 'approval' } };
  const action = { kind: 'question', sourceRef: host.sourceRef, text: 'Need your decision' }, options = { events: [host], catalog: [] };
  assert.deepEqual(interpretResult({ actions: [action] }, options), { actions: [{ ...action, decisionKind: 'approval' }] });
  assert.equal(interpretResult({ actions: [{ ...action, decisionKind: 'approval' }] }, options).actions[0].decisionKind, 'approval');
  expectSuspended({ ...action, decisionKind: 'approval-rephrased' }, options, 'ERR_BUTLER_QUESTION_SOURCE');
  for (const payload of [{ text: 'Unclassified' }, { questionKey: 'task-a-approval' }, { decisionKind: 'approval' }]) expectSuspended(action, { ...options, events: [{ ...host, payload }] }, 'ERR_BUTLER_QUESTION_SOURCE');
  expectSuspended({ ...action, decisionSource: 'model-chosen-key' }, options);
});
test('same-ref host contradictions suspend only question candidates and cross-ref canonical decisions retain the host kind', () => {
  const host = { ...event, payload: { questionKey: 'canonical-task', decisionKind: 'approval' } };
  const action = { kind: 'question', sourceRef: host.sourceRef, text: 'Need a decision' };
  for (const payload of [{ questionKey: 'other-task', decisionKind: 'approval' }, { questionKey: 'canonical-task', decisionKind: 'different' }, {}]) {
    const events = [host, { ...host, eventId: 'event-b', payload }];
    expectSuspended(action, { events, catalog: [] }, 'ERR_BUTLER_QUESTION_SOURCE');
    assert.equal(buildInput({ batchId: 'batch-a', events, catalog: [] }).events.length, 2);
    assert.deepEqual(interpretResult({ actions: [{ ...action, kind: 'report' }] }, { events, catalog: [] }), { actions: [{ ...action, kind: 'report' }] });
  }
  const other = { ...host, eventId: 'event-b', sourceRef: 'another-delivery-ref' };
  assert.deepEqual(interpretResult({ actions: [action, { ...action, sourceRef: other.sourceRef, text: 'Another wording' }] }, { events: [host, other], catalog: [] }),
    { actions: [{ ...action, decisionKind: 'approval' }, { ...action, sourceRef: other.sourceRef, text: 'Another wording', decisionKind: 'approval' }] });
});
test('reopening requires host-linked new facts and a closed prior for the same canonical decision', () => {
  const host = { ...event, eventId: 'new-facts', payload: { questionKey: 'canonical-task', decisionKind: 'approval', outcome: 'facts-changed', supersedes: 'old-question', text: 'A changed task fact' } };
  const prior = { questionId: 'old-question', decisionSource: 'canonical-task', decisionKind: 'approval', status: 'answered' };
  const action = { kind: 'question', sourceRef: host.sourceRef, text: 'The new fact changes your decision', evidenceRevision: host.eventId, supersedes: prior.questionId };
  const options = { events: [host], catalog: [], questions: [prior] };
  assert.deepEqual(interpretResult({ actions: [action] }, options), { actions: [{ ...action, decisionKind: 'approval' }] });
  assert.equal(interpretResult({ actions: [action] }, { ...options, questions: [{ ...prior, status: 'withdrawn' }] }).actions.length, 1);
  for (const patch of [{ evidenceRevision: 'unrelated-event' }, { supersedes: 'unrelated-question' }, { evidenceRevision: undefined }, { supersedes: undefined }]) expectSuspended({ ...action, ...patch }, options, 'ERR_BUTLER_QUESTION_SOURCE');
  for (const patch of [{ outcome: 'unchanged' }, { supersedes: 'another-question' }]) expectSuspended(action, { ...options, events: [{ ...host, payload: { ...host.payload, ...patch } }] }, 'ERR_BUTLER_QUESTION_SOURCE');
  for (const questions of [[], [{ ...prior, status: 'open' }], [{ ...prior, decisionSource: 'unrelated-task' }], [{ ...prior, decisionKind: 'other' }], [prior, prior]]) expectSuspended(action, { ...options, questions }, 'ERR_BUTLER_QUESTION_SOURCE');
  const unrelated = { ...event, eventId: 'unrelated-event', sourceRef: 'another-task', payload: { questionKey: 'another-key', decisionKind: 'approval', outcome: 'facts-changed', supersedes: prior.questionId } };
  expectSuspended({ ...action, evidenceRevision: unrelated.eventId }, { ...options, events: [host, unrelated] }, 'ERR_BUTLER_QUESTION_SOURCE');
});
test('queue proposals stay within 6000 characters; other record-only suggestions allow ledger text limits', () => {
  const base = { sourceRef: event.sourceRef, text: 't'.repeat(12000) }, options = { events: [event], catalog: [space] };
  for (const kind of ['report', 'open', 'archive']) assert.equal(interpretResult({ actions: [{ ...base, kind }] }, options).actions[0].text.length, 12000);
  assert.equal(interpretResult({ actions: [{ ...base, kind: 'queue', text: 'q'.repeat(6000) }] }, options).actions[0].text.length, 6000);
  assert.equal(expectSuspended({ ...base, kind: 'queue', text: 'q'.repeat(6001) }, options).redacted, true);
  assert.equal(expectSuspended({ ...base, kind: 'report', text: 'q'.repeat(12001) }, options).redacted, true);
  for (const patch of [{ assignee: 'worker-a' }, { effect: 'executed' }, { usage: { costMicros: 0 } }]) expectSuspended({ ...base, kind: 'report', ...patch }, options);
  assert.throws(() => interpretResult({ actions: [], usage: { costMicros: 0 } }, options), { code: 'ERR_BUTLER_RESULT' });
});
test('one invalid question preserves independent queue and READY report candidates in original order', () => {
  const ready = { eventId: 'ready-a', kind: 'ready', sourceRef: 'ready-task', payload: { title: 'Synthetic delivery' } };
  const actions = [
    { kind: 'question', sourceRef: event.sourceRef, text: 'Unclassified decision' },
    { kind: 'queue', sourceRef: event.sourceRef, text: 'Ready to queue', spaceId: space.id },
    { kind: 'report', sourceRef: ready.sourceRef, text: 'Synthetic READY summary' }
  ];
  const result = interpretResult({ actions }, { events: [event, ready], catalog: [space] });
  assert.deepEqual(result.actions, actions.slice(1));
  assert.deepEqual(result.suspended, [{ stage: 'policy', index: 0, reason: 'ERR_BUTLER_QUESTION_SOURCE', kind: 'question', sourceRef: event.sourceRef, text: 'Unclassified decision' }]);
  assert.equal(Object.hasOwn(result.suspended[0], 'candidateId'), false, 'The ledger owns candidate identity');
});
test('suspension metadata strips unsafe text, invented sources and unknown fields without reading getters', () => {
  const synthetic = ['DEEPSEEK_API_KEY', 'synthetic-placeholder'].join('=');
  const options = { events: [event], catalog: [space] };
  const secret = expectSuspended({ kind: 'report', sourceRef: event.sourceRef, text: synthetic }, options);
  assert.deepEqual(secret, { stage: 'policy', index: 0, reason: 'ERR_BUTLER_RESULT', kind: 'report', sourceRef: event.sourceRef, redacted: true });
  let read = false;
  const candidate = { kind: 'report', sourceRef: event.sourceRef, text: 'Safe audit text' };
  Object.defineProperty(candidate, 'environment', { enumerable: true, get() { read = true; throw Error('Forbidden context'); } });
  const row = expectSuspended(candidate, options);
  assert.equal(read, false); assert.equal(Object.hasOwn(row, 'environment'), false);
  const result = interpretResult({ actions: [null, { kind: 'execute', sourceRef: 'invented', text: 'Invalid action' }, { kind: 'report', sourceRef: event.sourceRef, text: 'Good action' }] }, options);
  assert.deepEqual(result.actions, [{ kind: 'report', sourceRef: event.sourceRef, text: 'Good action' }]);
  assert.deepEqual(result.suspended, [
    { stage: 'policy', index: 0, reason: 'ERR_BUTLER_RESULT', redacted: true },
    { stage: 'policy', index: 1, reason: 'ERR_BUTLER_RESULT', text: 'Invalid action' }
  ]);
});
test('malformed reply containers still fail atomically and cannot inject host suspension records', () => {
  const options = { events: [event], catalog: [space] };
  for (const reply of ['not JSON', null, [], {}, { actions: null }, { actions: [], suspended: [] },
    { actions: Array.from({ length: 101 }, () => ({ kind: 'report', sourceRef: event.sourceRef, text: 'Over limit' })) }]) {
    assert.throws(() => interpretResult(reply, options), { code: 'ERR_BUTLER_RESULT' });
  }
});
test('only the currently resolved dedicated non-member can become an additional rotation candidate', () => {
  const runner = { runnerRef: 'butler-runner-a', profile: 'deepseek-pro' };
  const selection = { mode: 'record-only', identity: { sessionId: 'butler-a', nativeId: 'native-a' }, runner };
  const record = { id: 'butler-a', nativeId: 'native-a', provider: 'dsh', state: 'idle', roomIds: [], runner };
  assert.deepEqual(rotationCandidates(selection, [record]), ['butler-a']);
  for (const patch of [{ nativeId: 'old-native' }, { runner: { ...runner, profile: 'default' } }, { roomIds: ['shared'], roomId: 'shared' }, { archived: true }, { nativeContextPending: true }]) assert.deepEqual(rotationCandidates(selection, [{ ...record, ...patch }]), []);
});
