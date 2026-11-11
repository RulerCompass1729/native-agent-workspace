const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const rules = require('../queue-dispatch.cjs');
const worktree = require('../git-worktree.cjs');
const { reader } = require('../integrator-git.cjs');
const { IntegrationHandoffs, parseResults, verifyMerged, verifyResults, FILE, RETURN_LIMIT, CLOSED_KEPT } = require('../integrator-handoff.cjs');

// Settling a handoff from the integrator's reply (B6 E2b, checkpoint H2). Synthetic sessions and
// replies; the only real program is git, reading a temporary repository. No model, no message, no lock.
const NOW = 1_800_000_000_000;
const START = 'a'.repeat(40), MAIN2 = 'b'.repeat(40), MAIN3 = 'c'.repeat(40);
const INTEGRATOR = { sessionId: 'integrator', nativeId: 'native-integrator' };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-settle-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, FILE), open: () => new IntegrationHandoffs(directory), backlog: new IntegrationHandoffs(directory) };
}
const commitOf = name => (name.charCodeAt(0).toString(16).padStart(2, '0')).repeat(20);
function ready(name, extra = {}) {
  return { key: `ready:space-1:${name}`, roomId: 'space-1', itemId: name, branch: `lane/${name}`, commit: commitOf(name), memberId: `member-${name}`, memberName: `Member ${name}`, spaceName: 'Space one', text: `Task ${name}`, ...extra };
}
const key = name => `ready:space-1:${name}`;
function integratorSession(extra = {}) {
  return { id: INTEGRATOR.sessionId, nativeId: INTEGRATOR.nativeId, provider: 'claude', state: 'idle', background: 0, scheduled: 0, backgroundStale: false,
    chatAvailable: true, liveDraft: '', controlRevision: 0, serviceCapabilities: [rules.CAPABILITY], fleet: [], messages: [], ...extra };
}
function observed(extra = {}) {
  return { integrator: INTEGRATOR, session: integratorSession(), complete: true, wakePolicy: { enabled: true }, now: NOW,
    idleSince: new Map([[INTEGRATOR.sessionId, NOW - rules.IDLE_SETTLE_MS]]), humanAt: new Map(), mainHead: START, ...extra };
}
const states = backlog => Object.fromEntries(backlog.snapshot().ready.map(entry => [entry.itemId, entry.state + (entry.reason ? ':' + entry.reason : '')]));
// Deliver the given names, open a handoff for them and confirm it as sent.
function handed(backlog, names, tag = 'tag-1') {
  for (const name of names) if (!backlog.snapshot().ready.some(entry => entry.itemId === name)) backlog.noteReady(ready(name), NOW);
  const action = backlog.advance(observed(), NOW);
  assert.equal(action.kind, 'open', JSON.stringify(action));
  backlog.confirmSent(action.handoffId, { tag, control: 0 }, NOW);
  return action;
}
// The integrator's session after it answered the handoff.
const answered = (tag, reply, extra = {}) => integratorSession({ messages: [{ id: tag, role: 'user', text: 'handoff', time: NOW }, ...(reply === null ? [] : [{ id: 'reply', role: 'assistant', text: reply, time: NOW + 1 }])], ...extra });
const later = (session, extra = {}) => observed({ session, now: NOW + 60000, idleSince: new Map([[INTEGRATOR.sessionId, NOW + 60000 - rules.IDLE_SETTLE_MS]]), ...extra });
const ok = (names, as = MAIN2) => Object.fromEntries(names.map(name => [key(name), { verified: true, as }]));
function settleWith(backlog, tag, reply, checked = {}) {
  const action = backlog.plan(later(answered(tag, reply)));
  assert.equal(action.kind, 'settle', JSON.stringify(action));
  return backlog.settle(action, checked, NOW + 60000);
}
const outcomes = result => Object.fromEntries(result.facts.map(fact => [fact.itemId, fact.outcome + (fact.reason ? ':' + fact.reason : '')]));

test('the reply names each delivery by its own commit; decoration is tolerated, another line is not read', () => {
  const entries = ['a', 'b', 'c', 'd'].map(name => ({ key: key(name), commit: commitOf(name) }));
  const text = ['需要你决定：两件冲突', `MERGED ${commitOf('a')} as ${MAIN2} tests 4830/4830 review 0a2298c6`,
    '`RETURNED` `' + commitOf('b').slice(0, 7) + '`   full   suite failed in queue-dispatch.',
    `**HELD ${commitOf('c').toUpperCase()} review-off**`,
    `- MERGED ${commitOf('d')} as ${MAIN2} tests 1/1`, `> HELD ${commitOf('d')} review-off`, `merged ${commitOf('d')} as ${MAIN2} tests 1/1`,
    `HELD ${'9'.repeat(40)} review-off`, 'READY lane/x abcdef1', ''].join('\n');
  assert.deepEqual(parseResults(text, entries), { ignored: 1, results: {
    [key('a')]: { kind: 'merged', as: MAIN2, tests: { passed: 4830, total: 4830 }, review: '0a2298c6' },
    [key('b')]: { kind: 'returned', reason: 'full suite failed in queue-dispatch' },
    [key('c')]: { kind: 'held', reason: 'review-off' } } });
  // The last line about a delivery counts; a reason may be missing; a MERGED line that cannot be read stays a claim.
  assert.deepEqual(parseResults(`HELD ${commitOf('a')} review-off\nRETURNED ${commitOf('a')}\nMERGED ${commitOf('b')} as main tests ok\nHELD ${commitOf('c')} lock-held:Claude 终端 two`, entries).results, {
    [key('a')]: { kind: 'returned', reason: 'unspecified' }, [key('b')]: { kind: 'merged', malformed: true }, [key('c')]: { kind: 'held', reason: 'lock-held:Claude 终端 two' } });
  // A commit that names several deliveries, or none, is ignored.
  const twins = [{ key: 'k1', commit: 'abcdef1' + '0'.repeat(33) }, { key: 'k2', commit: 'abcdef1' + '1'.repeat(33) }];
  assert.deepEqual(parseResults('RETURNED abcdef1 wrong\nRETURNED abcdef10 right', twins), { ignored: 1, results: { k1: { kind: 'returned', reason: 'right' } } });
  assert.deepEqual(parseResults(undefined, entries), { ignored: 0, results: {} });
  assert.deepEqual(parseResults('RETURNED abc short', entries), { ignored: 0, results: {} });
});

test('a handoff settles by the queue\'s own times and fall-backs', t => {
  const { backlog } = fixture(t);
  backlog.noteReady(ready('a'), NOW);
  const opened = backlog.advance(observed(), NOW);
  // Never confirmed as sent: nothing happens until the queue's wait is over, then it fails and is not sent again.
  assert.deepEqual(backlog.plan(observed({ now: NOW + rules.UNCONFIRMED_SEND_MS })), { kind: 'none', why: 'send-pending' });
  assert.deepEqual(backlog.plan(observed({ now: NOW + rules.UNCONFIRMED_SEND_MS + 1 })), { kind: 'settle', handoffId: opened.handoffId, status: 'failed', reason: 'send-unconfirmed' });
  assert.equal(rules.UNCONFIRMED_SEND_MS, 120000);
  backlog.confirmSent(opened.handoffId, { tag: 'tag-1', control: 0 }, NOW);
  const settle = (status, reason, extra = {}) => ({ kind: 'settle', handoffId: opened.handoffId, status, ...(reason ? { reason } : {}), ...extra });
  const reply = `MERGED ${commitOf('a')} as ${MAIN2} tests 3/3`, parsed = { ignored: 0, results: { [key('a')]: { kind: 'merged', as: MAIN2, tests: { passed: 3, total: 3 } } } };
  // The integrator is still at work, or has not been idle long enough.
  for (const session of [answered('tag-1', reply, { state: 'working' }), answered('tag-1', reply, { pendingTag: 'x' })]) assert.deepEqual(backlog.plan(later(session)), { kind: 'none', why: 'integrator-working' });
  assert.deepEqual(backlog.plan(later(answered('tag-1', reply), { idleSince: new Map([[INTEGRATOR.sessionId, NOW + 60000 - rules.IDLE_SETTLE_MS + 1]]) })), { kind: 'none', why: 'integrator-working' });
  assert.deepEqual(backlog.plan(later(answered('tag-1', reply), { now: undefined })), { kind: 'none', why: 'integrator-working' });
  // The integrator is no longer the designated one, or its session is gone from a complete list.
  for (const integrator of [null, { sessionId: 'another', nativeId: 'native-another' }, { ...INTEGRATOR, nativeId: 'rotated' }]) {
    assert.deepEqual(backlog.plan(later(answered('tag-1', reply), { integrator, complete: false })), settle('failed', 'integrator-missing:integrator'));
  }
  for (const session of [undefined, answered('tag-1', reply, { archived: true }), answered('tag-1', reply, { nativeId: 'other' })]) {
    assert.deepEqual(backlog.plan(later(session, { complete: false })), { kind: 'none', why: 'sessions-incomplete' });
    assert.deepEqual(backlog.plan(later(session)), settle('failed', 'integrator-missing:integrator'));
  }
  // No record of the handoff or anything after it; the person typed after it or took control; an empty reply.
  assert.deepEqual(backlog.plan(later(integratorSession({ messages: [] }))), settle('failed', 'record-missing'));
  const typed = integratorSession({ messages: [{ id: 'tag-1', role: 'user', text: 'handoff', time: NOW }, { id: 'u2', role: 'user', text: 'wait', time: NOW + 1 }, { id: 'r', role: 'assistant', text: reply, time: NOW + 2 }] });
  assert.deepEqual(backlog.plan(later(typed)), settle('waiting', 'person-intervened'));
  assert.deepEqual(backlog.plan(later(answered('tag-1', reply, { controlRevision: 1 }))), settle('waiting', 'person-intervened'));
  assert.deepEqual(backlog.plan(later(answered('tag-1', null))), settle('waiting', 'no-reply'));
  assert.deepEqual(backlog.plan(later(answered('tag-1', '   '))), settle('waiting', 'no-reply'), 'A blank reply is no reply, as for a queue item');
  // A reply: its first line decides between done and a decision for the person; the result lines are read either way.
  assert.deepEqual(backlog.plan(later(answered('tag-1', reply))), settle('done', '', { results: parsed }));
  assert.deepEqual(backlog.plan(later(answered('tag-1', '需要你决定：两件冲突，建议交给一人合成一份\n' + reply))), settle('waiting', '', { decision: true, question: '两件冲突，建议交给一人合成一份', results: parsed }));
  // Planning changed nothing, and advance does not settle by itself: git has to be asked first.
  assert.equal(backlog.snapshot().handoff.status, 'sent');
  assert.equal(backlog.advance(later(answered('tag-1', reply)), NOW).kind, 'settle');
  assert.equal(backlog.snapshot().handoff.status, 'sent');
});

test('a verified merge is recorded once and registers the main commit to install once', t => {
  const { backlog, open } = fixture(t);
  handed(backlog, ['a', 'b']);
  const reply = `MERGED ${commitOf('a')} as ${MAIN2} tests 4830/4830 review 0a2298c6\nMERGED ${commitOf('b').slice(0, 9)} as ${MAIN2.slice(0, 12)} tests 4830/4830`;
  const result = settleWith(backlog, 'tag-1', reply, { verified: ok(['a', 'b']), mainHead: MAIN2 });
  assert.deepEqual(outcomes(result), { a: 'merged', b: 'merged' });
  assert.deepEqual(result.notify, [`installable:${MAIN2}`]); assert.deepEqual(result.install, { commit: MAIN2 });
  assert.deepEqual(result.facts[0], { key: key('a'), roomId: 'space-1', itemId: 'a', branch: 'lane/a', commit: commitOf('a'), outcome: 'merged', as: MAIN2, tests: { passed: 4830, total: 4830 }, review: '0a2298c6' });
  const state = backlog.snapshot();
  assert.equal(state.handoff, null);
  assert.deepEqual(state.ready.map(entry => [entry.state, entry.mergedAs, entry.closedAt]), [['merged', MAIN2, NOW + 60000], ['merged', MAIN2, NOW + 60000]]);
  assert.deepEqual(backlog.pendingNotices(), [`installable:${MAIN2}`]);
  // The same settlement again does nothing: the handoff is gone.
  assert.throws(() => backlog.settle({ kind: 'settle', handoffId: 'H1-ffffffff', status: 'done', results: { results: {} } }, {}, NOW), { code: 'HANDOFF_STATE' });
  // A later batch on a newer main replaces the open question; the same main head never registers twice.
  handed(backlog, ['c'], 'tag-2');
  const second = settleWith(backlog, 'tag-2', `MERGED ${commitOf('c')} as ${MAIN3} tests 1/1`, { verified: ok(['c'], MAIN3), mainHead: MAIN3 });
  assert.deepEqual(second.install, { commit: MAIN3 });
  let reasons = backlog.snapshot().reasons;
  assert.equal(reasons[`installable:${MAIN2}`].open, false); assert.equal(reasons[`installable:${MAIN3}`].open, true);
  handed(backlog, ['d'], 'tag-3');
  const third = settleWith(backlog, 'tag-3', `MERGED ${commitOf('d')} as ${MAIN3} tests 1/1`, { verified: ok(['d'], MAIN3), mainHead: MAIN3 });
  assert.equal(third.install, null); assert.deepEqual(third.notify, []);
  // The question ends only with the person's answer, also across a restart and a retry.
  assert.deepEqual(open().retryReason(`installable:${MAIN3}`), { released: [] });
  assert.equal(open().snapshot().reasons[`installable:${MAIN3}`].open, true);
  assert.deepEqual(backlog.answer(`installable:${MAIN3}`), { answered: true });
  assert.deepEqual(backlog.answer(`installable:${MAIN3}`), { answered: false });
  for (const bad of ['review-off', 'installable:', 'made-up', 7]) assert.throws(() => backlog.answer(bad), { code: 'HANDOFF_STATE' }, String(bad));
});

test('a merge that is not verified is never recorded as merged and registers nothing', t => {
  const cases = [
    ['git could not confirm it', `MERGED ${commitOf('a')} as ${MAIN2} tests 9/9`, { verified: { [key('a')]: { verified: false, why: 'not-new' } }, mainHead: MAIN2 }],
    ['nothing was checked', `MERGED ${commitOf('a')} as ${MAIN2} tests 9/9`, {}],
    ['the checked commit is not a full id', `MERGED ${commitOf('a')} as ${MAIN2} tests 9/9`, { verified: { [key('a')]: { verified: true, as: 'abcdef1' } }, mainHead: MAIN2 }],
    ['the main head is unknown', `MERGED ${commitOf('a')} as ${MAIN2} tests 9/9`, { verified: ok(['a']) }],
    ['not every test passed', `MERGED ${commitOf('a')} as ${MAIN2} tests 8/9`, { verified: ok(['a']), mainHead: MAIN2 }],
    ['no test ran', `MERGED ${commitOf('a')} as ${MAIN2} tests 0/0`, { verified: ok(['a']), mainHead: MAIN2 }],
    ['the line cannot be read', `MERGED ${commitOf('a')} into main, all green`, { verified: ok(['a']), mainHead: MAIN2 }],
  ];
  for (const [name, reply, checked] of cases) {
    const { backlog } = fixture(t);
    handed(backlog, ['a']);
    const result = settleWith(backlog, 'tag-1', reply, checked);
    assert.deepEqual(outcomes(result), { a: 'held:merge-unverified' }, name);
    assert.deepEqual(result.notify, ['merge-unverified'], name); assert.equal(result.install, null, name);
    assert.deepEqual(states(backlog), { a: 'held:merge-unverified' }, name);
    assert.equal(Object.keys(backlog.snapshot().reasons).some(reason => reason.startsWith('installable:')), false, name);
    // Main has moved: it is not handed again by itself.
    assert.deepEqual(backlog.advance(later(integratorSession()), NOW + 60000), { kind: 'none', why: 'nothing-deliverable' }, name);
  }
});

test('returned work is recorded and suggested for a redo; after too many returns of a branch it is the person\'s to decide', t => {
  const { backlog } = fixture(t);
  const give = (name, tag) => { backlog.noteReady(ready(name, { branch: 'lane/same' }), NOW); const action = handed(backlog, [name], tag); return action; };
  for (let round = 1; round <= RETURN_LIMIT; round += 1) {
    give(`r${round}`, `tag-${round}`);
    const result = settleWith(backlog, `tag-${round}`, `RETURNED ${commitOf('r')} full suite failed`);
    assert.deepEqual(result.facts.map(fact => [fact.outcome, fact.reason, fact.suggestRequeue]), [['returned', 'full suite failed', true]]);
    assert.deepEqual(result.notify, []);
  }
  give('r9', 'tag-9');
  const over = settleWith(backlog, 'tag-9', `RETURNED ${commitOf('r')} stale-commit`);
  assert.deepEqual(over.facts.map(fact => [fact.outcome, fact.reason, fact.suggestRequeue]), [['returned', 'stale-commit', false]]);
  assert.deepEqual(over.notify, ['returned-limit:lane/same']);
  assert.equal(RETURN_LIMIT, 2);
  const state = backlog.snapshot();
  assert.deepEqual(state.returns, { 'space-1:lane/same': 3 });
  assert.deepEqual(state.ready.map(entry => [entry.state, entry.note, entry.closedAt]), [['returned', 'full suite failed', NOW + 60000], ['returned', 'full suite failed', NOW + 60000], ['returned', 'stale-commit', NOW + 60000]]);
  // Asked once: another return of that branch does not ask again until the person answered.
  give('ra', 'tag-a');
  assert.deepEqual(settleWith(backlog, 'tag-a', `RETURNED ${commitOf('r')} again`).notify, []);
  assert.deepEqual(backlog.answer('returned-limit:lane/same'), { answered: true });
  give('rb', 'tag-b');
  assert.deepEqual(settleWith(backlog, 'tag-b', `RETURNED ${commitOf('r')} once more`).notify, ['returned-limit:lane/same']);
  // Nothing was added to any queue: the module only reports.
  assert.equal(backlog.snapshot().handoff, null);
});

test('held deliveries keep their reason; a standing condition does not take the handoff\'s place', t => {
  const { backlog } = fixture(t);
  const action = handed(backlog, ['a', 'b', 'c', 'd', 'e', 'f']);
  const reply = [`HELD ${commitOf('a')} review-off`, `HELD ${commitOf('b')} review-cap`, `HELD ${commitOf('c')} checkpoint-invalid`, `HELD ${commitOf('d')} lock-held:Claude 终端`,
    `HELD ${commitOf('e')} waiting for a design answer`, `HELD ${commitOf('f')} conflict`].join('\n');
  const result = settleWith(backlog, 'tag-1', reply);
  const conflict = `conflict:${action.handoffId}`;
  assert.deepEqual(outcomes(result), { a: 'held:review-off', b: 'held:review-cap', c: 'held:checkpoint-invalid', d: 'held:lock-held:Claude 终端', e: 'held:held-other', f: 'held:' + conflict });
  assert.deepEqual(result.notify, ['review-off', 'review-cap', 'checkpoint-invalid', 'lock-held:Claude 终端', 'held-other', conflict]);
  assert.equal(backlog.snapshot().ready.find(entry => entry.itemId === 'e').note, 'waiting for a design answer');
  // The handoff is done although nothing merged: a new delivery is handed without waiting for the person.
  assert.equal(backlog.snapshot().handoff, null);
  backlog.noteReady(ready('g'), NOW);
  const next = backlog.advance(later(integratorSession()), NOW + 60000);
  assert.equal(next.kind, 'open'); assert.deepEqual(next.keys, [key('g')]);
  // A second delivery held for the same standing condition tells nobody again.
  backlog.confirmSent(next.handoffId, { tag: 'tag-2', control: 0 }, NOW);
  assert.deepEqual(settleWith(backlog, 'tag-2', `HELD ${commitOf('g')} review-off`).notify, []);
  // The lock being released brings back exactly what it held.
  assert.deepEqual(backlog.reasonCleared('lock-released', 'Claude 终端'), { released: [key('d')] });
});

test('a delivery without a result line is handed once more by itself, then held', t => {
  const { backlog } = fixture(t);
  handed(backlog, ['a', 'b']);
  const first = settleWith(backlog, 'tag-1', `RETURNED ${commitOf('b')} needs a rebase\nAll done.`);
  assert.deepEqual(outcomes(first), { a: 'again', b: 'returned:needs a rebase' });
  assert.deepEqual(states(backlog), { a: 'deliverable', b: 'returned' });
  assert.equal(backlog.snapshot().ready[0].resends, 1);
  const again = backlog.advance(later(integratorSession()), NOW + 60000);
  assert.deepEqual(again.keys, [key('a')]);
  backlog.confirmSent(again.handoffId, { tag: 'tag-2', control: 0 }, NOW);
  const second = settleWith(backlog, 'tag-2', 'Nothing to report.');
  assert.deepEqual(outcomes(second), { a: 'held:no-result' }); assert.deepEqual(second.notify, ['no-result']);
  assert.deepEqual(backlog.advance(later(integratorSession()), NOW + 60000), { kind: 'none', why: 'nothing-deliverable' });
  // After the person's retry it is handed again, and a result ends the count.
  backlog.retryReady(key('a'));
  const third = backlog.advance(later(integratorSession()), NOW + 60000);
  backlog.confirmSent(third.handoffId, { tag: 'tag-3', control: 0 }, NOW);
  settleWith(backlog, 'tag-3', `MERGED ${commitOf('a')} as ${MAIN2} tests 2/2`, { verified: ok(['a']), mainHead: MAIN2 });
  const merged = backlog.snapshot().ready[0];
  assert.equal(merged.state, 'merged'); assert.equal(merged.resends, undefined);
});

test('a failed handoff holds its deliveries for the person and sends nothing again', t => {
  for (const [reason, observation] of [['send-unconfirmed', null], ['record-missing', later(integratorSession({ messages: [] }))], ['integrator-missing:integrator', later(undefined)]]) {
    const { backlog } = fixture(t);
    backlog.noteReady(ready('a'), NOW); backlog.noteReady(ready('b'), NOW);
    const opened = backlog.advance(observed(), NOW);
    if (observation) backlog.confirmSent(opened.handoffId, { tag: 'tag-1', control: 0 }, NOW);
    const action = backlog.plan(observation || observed({ now: NOW + rules.UNCONFIRMED_SEND_MS + 1 }));
    assert.deepEqual([action.status, action.reason], ['failed', reason]);
    const result = backlog.settle(action, {}, NOW + 200000);
    assert.deepEqual(outcomes(result), { a: 'held:' + reason, b: 'held:' + reason }, reason);
    assert.deepEqual(result.notify, [reason]);
    assert.equal(backlog.snapshot().handoff, null, 'The place is free again');
    for (let tick = 0; tick < 3; tick += 1) assert.deepEqual(backlog.advance(later(integratorSession()), NOW + 300000 + tick).kind, 'none', reason);
    assert.deepEqual(states(backlog), { a: 'held:' + reason, b: 'held:' + reason });
  }
  // A failure the plan did not produce is refused.
  const { backlog } = fixture(t);
  const action = handed(backlog, ['a']);
  for (const bad of [{ status: 'failed', reason: 'made-up' }, { status: 'failed', reason: 'integrator-missing:someone-else' }, { status: 'waiting', reason: 'review-off' }, { status: 'gone' }, { status: 'done', kind: 'open' }]) {
    assert.throws(() => backlog.settle({ kind: 'settle', handoffId: action.handoffId, ...bad }, {}, NOW), { code: 'HANDOFF_STATE' }, JSON.stringify(bad));
  }
  assert.deepEqual(states(backlog), { a: 'handed' });
});

test('a handoff that waits for the person keeps the one place until the person resolves it', t => {
  const { backlog, open } = fixture(t);
  const action = handed(backlog, ['a', 'b']);
  const result = backlog.settle(backlog.plan(later(answered('tag-1', null))), {}, NOW + 60000);
  assert.deepEqual(outcomes(result), { a: 'waiting:no-reply', b: 'waiting:no-reply' });
  assert.deepEqual(result.notify, ['no-reply'], 'It holds the only place, so the person is told once');
  assert.deepEqual(states(backlog), { a: 'handed', b: 'handed' });
  // Nothing else is handed and nothing settles it again, also after a restart.
  backlog.noteReady(ready('c'), NOW);
  for (const view of [later(answered('tag-1', `MERGED ${commitOf('a')} as ${MAIN2} tests 1/1`)), later(integratorSession()), observed()]) assert.deepEqual(open().advance(view, NOW + 70000), { kind: 'none', why: 'handoff-waiting' });
  assert.equal(open().snapshot().reasons['no-reply'].open, true);
  assert.throws(() => backlog.settle({ kind: 'settle', handoffId: action.handoffId, status: 'done', results: { results: {} } }, {}, NOW), { code: 'HANDOFF_STATE' }, 'A waiting handoff is not settled a second time');
  assert.throws(() => backlog.resolveHandoff('H9-other', { retry: true }, NOW), { code: 'HANDOFF_STATE' });
  // Resolved without a retry: the place is free, the question is answered, and what was inside stays held.
  assert.deepEqual(backlog.resolveHandoff(action.handoffId, {}, NOW + 80000), { released: [], held: [key('a'), key('b')] });
  assert.deepEqual(states(backlog), { a: 'held:no-reply', b: 'held:no-reply', c: 'deliverable' });
  assert.equal(backlog.snapshot().reasons['no-reply'].open, false);
  assert.throws(() => backlog.resolveHandoff(action.handoffId, { retry: true }, NOW), { code: 'HANDOFF_STATE' });
  const next = backlog.advance(later(integratorSession()), NOW + 90000);
  assert.deepEqual(next.keys, [key('c')], 'Only the new delivery is handed; the held ones wait for a retry');
  // The person's own typing is recorded without a notice; resolved with a retry, everything inside may be handed again.
  backlog.confirmSent(next.handoffId, { tag: 'tag-2', control: 0 }, NOW);
  const typed = integratorSession({ messages: [{ id: 'tag-2', role: 'user', text: 'handoff', time: NOW }, { id: 'u', role: 'user', text: 'stop', time: NOW + 1 }] });
  const quiet = backlog.settle(backlog.plan(later(typed)), {}, NOW + 100000);
  assert.deepEqual(quiet.notify, []); assert.deepEqual(outcomes(quiet), { c: 'waiting:person-intervened' });
  assert.deepEqual(backlog.pendingNotices(), ['no-reply'].filter(() => false));
  assert.deepEqual(backlog.resolveHandoff(next.handoffId, { retry: true }, NOW + 110000), { released: [key('c')], held: [] });
  assert.deepEqual(backlog.retryReason('no-reply'), { released: [key('a'), key('b')] });
  // A later handoff without a reply is a new occurrence.
  const third = backlog.advance(later(integratorSession()), NOW + 120000);
  backlog.confirmSent(third.handoffId, { tag: 'tag-3', control: 0 }, NOW);
  assert.deepEqual(backlog.settle(backlog.plan(later(answered('tag-3', null))), {}, NOW + 130000).notify, ['no-reply']);
});

test('a decision for the person: lines given are recorded, the rest stays inside the waiting handoff', t => {
  const { backlog } = fixture(t);
  const action = handed(backlog, ['a', 'b', 'c', 'd']);
  const conflict = `conflict:${action.handoffId}`;
  const reply = `需要你决定：c 和 d 改了同一处，建议交给一人合成一份\nMERGED ${commitOf('a')} as ${MAIN2} tests 7/7\nRETURNED ${commitOf('b')} needs a rebase`;
  const result = settleWith(backlog, 'tag-1', reply, { verified: ok(['a']), mainHead: MAIN2 });
  assert.deepEqual(outcomes(result), { a: 'merged', b: 'returned:needs a rebase', c: 'waiting:' + conflict, d: 'waiting:' + conflict });
  assert.deepEqual(result.notify, [conflict, `installable:${MAIN2}`]);
  const waiting = backlog.snapshot().handoff;
  assert.deepEqual([waiting.status, waiting.reason, waiting.keys, waiting.question], ['waiting', conflict, [key('c'), key('d')], 'c 和 d 改了同一处，建议交给一人合成一份']);
  assert.deepEqual(backlog.advance(later(integratorSession()), NOW + 70000), { kind: 'none', why: 'handoff-waiting' });
  // Answering without choosing a retry does not hand them again; the retry does.
  assert.deepEqual(backlog.resolveHandoff(action.handoffId, { retry: false }, NOW + 80000), { released: [], held: [key('c'), key('d')] });
  assert.deepEqual(backlog.advance(later(integratorSession()), NOW + 90000), { kind: 'none', why: 'nothing-deliverable' });
  assert.deepEqual(backlog.retryReason(conflict), { released: [key('c'), key('d')] });
  // A decision line with a result for every delivery leaves nothing to wait for: the handoff is done.
  const second = backlog.advance(later(integratorSession()), NOW + 100000);
  backlog.confirmSent(second.handoffId, { tag: 'tag-2', control: 0 }, NOW);
  const done = settleWith(backlog, 'tag-2', `需要你决定：仍然冲突\nHELD ${commitOf('c')} conflict\nHELD ${commitOf('d')} conflict`);
  assert.deepEqual(outcomes(done), { c: `held:conflict:${second.handoffId}`, d: `held:conflict:${second.handoffId}` });
  assert.deepEqual(done.notify, [`conflict:${second.handoffId}`]);
  assert.equal(backlog.snapshot().handoff, null);
});

test('a delivery replaced while it was inside a handoff keeps its real outcome, and is void without one', t => {
  const { backlog } = fixture(t);
  handed(backlog, ['a', 'b']);
  backlog.noteReady(ready('a2', { branch: 'lane/a' }), NOW + 1); backlog.noteReady(ready('b2', { branch: 'lane/b' }), NOW + 1);
  const result = settleWith(backlog, 'tag-1', `MERGED ${commitOf('a')} as ${MAIN2} tests 1/1`, { verified: ok(['a']), mainHead: MAIN2 });
  assert.deepEqual(outcomes(result), { a: 'merged', b: 'superseded' });
  assert.deepEqual(states(backlog), { a: 'merged', b: 'superseded', a2: 'deliverable', b2: 'deliverable' });
  assert.deepEqual(backlog.advance(later(integratorSession()), NOW + 70000).keys, [key('a2'), key('b2')]);
});

test('finished outcomes are trimmed by when they ended', t => {
  const { directory, file } = fixture(t);
  const old = index => ({ ...ready('x'), key: key(`m-${index}`), itemId: `m-${index}`, branch: `lane/m-${index}`, state: 'merged', mergedAs: START, notedAt: NOW + index, closedAt: NOW + 1000 + index });
  fs.writeFileSync(file, JSON.stringify({ version: 1, seq: 0, handoff: null, reasons: {}, refusals: 0, seen: [], capDay: null, returns: {},
    ready: [{ ...ready('a'), state: 'deliverable', notedAt: NOW - 5000 }, ...Array.from({ length: CLOSED_KEPT }, (_, index) => old(index))] }), { mode: 0o600 });
  const backlog = new IntegrationHandoffs(directory);
  handed(backlog, ['a']);
  settleWith(backlog, 'tag-1', `RETURNED ${commitOf('a')} late outcome`);
  const kept = backlog.snapshot();
  assert.ok(kept.ready.some(entry => entry.itemId === 'a' && entry.state === 'returned'), 'The delivery that arrived first and ended last keeps its outcome');
  assert.deepEqual(kept.seen, [key('m-0')]);
});

// A reader with fixed answers, to reach each check alone.
function fake(overrides = {}) {
  const full = value => value.length === 40 ? value : value.padEnd(40, '0');
  return { commit: async value => overrides.commit ? overrides.commit(value) : full(value), isAncestor: async (a, b) => overrides.isAncestor ? overrides.isAncestor(a, b) : b === MAIN2,
    changes: async (base, tip) => overrides.changes ? overrides.changes(base, tip) : tip === MAIN2 ? [{ commit: MAIN2, change: 'x1' }, { commit: 'm1', change: 'x2' }] : [{ commit: tip, change: 'x1' }] };
}
test('a reported merge counts only when all three questions to git are answered yes', async () => {
  const claim = { ready: commitOf('a'), as: MAIN2, startHead: START, mainHead: MAIN2 };
  assert.deepEqual(await verifyMerged(fake(), claim), { verified: true, as: MAIN2 });
  const cases = [
    ['main-unknown', fake(), { ...claim, mainHead: 'short' }], ['main-unknown', fake(), { ...claim, startHead: undefined }],
    ['unknown-commit', fake({ commit: value => value === MAIN2 ? null : value }), claim], ['unknown-commit', fake({ commit: value => value === commitOf('a') ? null : value }), claim],
    ['not-on-main', fake({ isAncestor: () => false }), claim], ['not-on-main', fake({ isAncestor: () => null }), claim],
    ['not-new', fake({ isAncestor: () => true }), claim], ['not-new', fake({ isAncestor: (a, b) => b === MAIN2 ? true : null }), claim],
    ['no-changes', fake({ changes: () => null }), claim], ['no-changes', fake({ changes: (base, tip) => tip === MAIN2 ? [{ commit: MAIN2, change: 'x1' }] : [] }), claim],
    ['changes-differ', fake({ changes: (base, tip) => tip === MAIN2 ? [{ commit: MAIN2, change: 'other' }] : [{ commit: tip, change: 'x1' }] }), claim],
    ['changes-differ', fake({ changes: (base, tip) => tip === MAIN2 ? [{ commit: MAIN2, change: 'x1' }] : [{ commit: tip, change: 'x1' }, { commit: 'second', change: 'x9' }] }), claim],
    ['changes-differ', fake({ changes: (base, tip) => tip === MAIN2 ? [{ commit: MAIN2, change: 'x1' }] : [{ commit: tip, change: null }] }), claim],
  ];
  for (const [why, read, input] of cases) assert.deepEqual(await verifyMerged(read, input), { verified: false, why }, why);
});

// A real temporary repository for the same questions.
function repository(t) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-settle-git-')));
  const repo = path.join(temporary, 'repository'); fs.mkdirSync(repo);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/.test(name))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  const git = (...args) => execFileSync(worktree.available(), ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Synthetic fixture', '-c', 'user.email=fixture@example.com', ...args], { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let serial = 0;
  const commit = (file, text) => { fs.writeFileSync(path.join(repo, file), text); git('add', '--', file); git('commit', '--quiet', '-m', `Synthetic change ${++serial}`); return git('rev-parse', 'HEAD'); };
  git('init', '--quiet', '--initial-branch=main');
  const start = commit('base.txt', 'base\n');
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  return { git, commit, start, read: reader(repo) };
}
test('against a real repository: a fast-forward and a cherry-pick are verified; a partial, an old or a foreign merge is not', async t => {
  const { git, commit, start, read } = repository(t);
  // A delivery of two commits; main moves on by one unrelated commit; the integrator cherry-picks both.
  git('checkout', '--quiet', '-b', 'lane/work', start);
  const first = commit('one.txt', 'one\n'), second = commit('two.txt', 'two\n');
  git('checkout', '--quiet', 'main'); const moved = commit('other.txt', 'other\n');
  git('cherry-pick', first); const partial = git('rev-parse', 'HEAD');
  assert.deepEqual(await verifyMerged(read, { ready: second, as: partial, startHead: start, mainHead: partial }), { verified: false, why: 'changes-differ' }, 'Only one of the two commits is on main');
  git('cherry-pick', second); const picked = git('rev-parse', 'HEAD');
  assert.deepEqual(await verifyMerged(read, { ready: second, as: picked, startHead: start, mainHead: picked }), { verified: true, as: picked });
  assert.deepEqual(await verifyMerged(read, { ready: second.slice(0, 9), as: picked.slice(0, 9), startHead: start, mainHead: picked }), { verified: true, as: picked }, 'Short ids as the integrator writes them');
  // The named commit was already on main when the handoff began, is not on main, or does not exist.
  assert.deepEqual(await verifyMerged(read, { ready: second, as: moved, startHead: moved, mainHead: picked }), { verified: false, why: 'not-new' });
  assert.deepEqual(await verifyMerged(read, { ready: second, as: second, startHead: start, mainHead: picked }), { verified: false, why: 'not-on-main' });
  assert.deepEqual(await verifyMerged(read, { ready: second, as: 'f'.repeat(40), startHead: start, mainHead: picked }), { verified: false, why: 'unknown-commit' });
  assert.deepEqual(await verifyMerged(read, { ready: 'e'.repeat(40), as: picked, startHead: start, mainHead: picked }), { verified: false, why: 'unknown-commit' });
  // The delivery has nothing that was not on main at the start: nothing can have been merged for it.
  assert.deepEqual(await verifyMerged(read, { ready: start, as: picked, startHead: start, mainHead: picked }), { verified: false, why: 'no-changes' });
  // A different change under the same file name is not this delivery.
  git('checkout', '--quiet', '-b', 'lane/other', start); const different = commit('one.txt', 'not one\n');
  assert.deepEqual(await verifyMerged(read, { ready: different, as: picked, startHead: start, mainHead: picked }), { verified: false, why: 'changes-differ' });
  // A fast-forward: the delivery's own commits are main's new commits.
  git('checkout', '--quiet', '-b', 'main-ff', start); git('merge', '--quiet', '--ff-only', 'lane/work');
  assert.deepEqual(await verifyMerged(read, { ready: second, as: second, startHead: start, mainHead: second }), { verified: true, as: second });
});

test('every MERGED line of a settlement gets its verdict; unreadable lines and failed tests are refused before git is asked', async t => {
  const { backlog } = fixture(t);
  handed(backlog, ['a', 'b', 'c', 'd']);
  const reply = `MERGED ${commitOf('a')} as ${MAIN2} tests 5/5\nMERGED ${commitOf('b')} as ${MAIN2} tests 4/5\nMERGED ${commitOf('c')} somewhere\nRETURNED ${commitOf('d')} no`;
  const action = backlog.plan(later(answered('tag-1', reply)));
  const asked = [];
  const read = fake({ commit: value => { asked.push(value); return value; } });
  const verdicts = await verifyResults(read, backlog.snapshot(), action, MAIN2);
  assert.deepEqual(verdicts, { [key('a')]: { verified: true, as: MAIN2 }, [key('b')]: { verified: false, why: 'tests-not-all-passed' }, [key('c')]: { verified: false, why: 'unreadable-line' } });
  assert.deepEqual(asked, [MAIN2, commitOf('a')], 'git is asked only about the line that can count');
  assert.deepEqual(await verifyResults(read, backlog.snapshot(), { ...action, handoffId: 'H9-other' }, MAIN2), {});
  const result = backlog.settle(action, { verified: verdicts, mainHead: MAIN2 }, NOW + 60000);
  assert.deepEqual(outcomes(result), { a: 'merged', b: 'held:merge-unverified', c: 'held:merge-unverified', d: 'returned:no' });
  assert.deepEqual(result.install, { commit: MAIN2 });
});

test('the module still runs nothing: git is asked through the reader it is given', () => {
  const source = fs.readFileSync(path.join(__dirname, '../integrator-handoff.cjs'), 'utf8');
  assert.deepEqual([...source.matchAll(/require\('([^']+)'\)/g)].map(match => match[1]).sort(), ['./queue-dispatch.cjs', 'node:crypto', 'node:fs', 'node:path']);
  assert.ok(!source.includes('integrator-git'));
});
