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
  // The checks are those made for this handoff, unless a test names another one.
  return backlog.settle(action, { handoffId: action.handoffId, ...checked }, NOW + 60000);
}
const outcomes = result => Object.fromEntries(result.facts.map(fact => [fact.itemId, fact.outcome + (fact.reason ? ':' + fact.reason : '')]));

test('the reply names each delivery by its own commit; decoration, list marks and numbers are tolerated, a quoted line is not read', () => {
  const entries = ['a', 'b', 'c', 'd'].map(name => ({ key: key(name), commit: commitOf(name) }));
  const text = ['需要你决定：两件冲突', `MERGED ${commitOf('a')} as ${MAIN2} tests 4830/4830 review 0a2298c6`,
    '`RETURNED` `' + commitOf('b').slice(0, 7) + '`   full   suite failed in queue-dispatch.',
    `**HELD ${commitOf('c').toUpperCase()} review-off**`,
    `- MERGED ${commitOf('d')} as ${MAIN2} tests 1/1`, `> HELD ${commitOf('d')} review-off`, `merged ${commitOf('d')} as ${MAIN2} tests 1/1`,
    `HELD ${'9'.repeat(40)} review-off`, 'READY lane/x abcdef1', ''].join('\n');
  assert.deepEqual(parseResults(text, entries), { ignored: 1, results: {
    [key('a')]: { kind: 'merged', as: MAIN2, tests: { passed: 4830, total: 4830 }, review: '0a2298c6' },
    [key('b')]: { kind: 'returned', reason: 'full suite failed in queue-dispatch' },
    [key('c')]: { kind: 'held', reason: 'review-off' },
    // The list line is the integrator's own; the quoted line and the lower-case one are not results.
    [key('d')]: { kind: 'merged', as: MAIN2, tests: { passed: 1, total: 1 } } } });
  // The handoff numbers its deliveries, so the answer often comes numbered.
  const numbered = [`1. MERGED ${commitOf('a')} as ${MAIN2} tests 2/2`, `2) RETURNED ${commitOf('b')} needs a rebase`, `3、HELD ${commitOf('c')} review-off`, `- **HELD** \`${commitOf('d')}\` checkpoint-invalid.`].join('\n');
  assert.deepEqual(parseResults(numbered, entries), { ignored: 0, results: {
    [key('a')]: { kind: 'merged', as: MAIN2, tests: { passed: 2, total: 2 } }, [key('b')]: { kind: 'returned', reason: 'needs a rebase' },
    [key('c')]: { kind: 'held', reason: 'review-off' }, [key('d')]: { kind: 'held', reason: 'checkpoint-invalid' } } });
  // A line that begins like a result but cannot be read is counted, not passed over in silence.
  assert.deepEqual(parseResults(`MERGED everything, all green\nHELD\n4. RETURNED abc short\nMERGEDX ${commitOf('a')}\nHELDER ${commitOf('b')} x`, entries), { ignored: 3, results: {} });
  // A colon after the first word is tolerated; a MERGED line without its parts stays a claim that is never taken as merged.
  assert.deepEqual(parseResults(`MERGED: ${commitOf('a')}\nRETURNED：${commitOf('b')} needs a rebase\n- HELD: ${commitOf('c')} review-off`, entries), { ignored: 0, results: {
    [key('a')]: { kind: 'merged', malformed: true }, [key('b')]: { kind: 'returned', reason: 'needs a rebase' }, [key('c')]: { kind: 'held', reason: 'review-off' } } });
  // The last line about a delivery counts; a reason may be missing; a MERGED line that cannot be read stays a claim.
  assert.deepEqual(parseResults(`HELD ${commitOf('a')} review-off\nRETURNED ${commitOf('a')}\nMERGED ${commitOf('b')} as main tests ok\nHELD ${commitOf('c')} lock-held:Claude 终端 two`, entries).results, {
    [key('a')]: { kind: 'returned', reason: 'unspecified' }, [key('b')]: { kind: 'merged', malformed: true }, [key('c')]: { kind: 'held', reason: 'lock-held:Claude 终端 two' } });
  // A commit that names several deliveries, or none, is ignored.
  const twins = [{ key: 'k1', commit: 'abcdef1' + '0'.repeat(33) }, { key: 'k2', commit: 'abcdef1' + '1'.repeat(33) }];
  assert.deepEqual(parseResults('RETURNED abcdef1 wrong\nRETURNED abcdef10 right', twins), { ignored: 1, results: { k1: { kind: 'returned', reason: 'right' } } });
  assert.deepEqual(parseResults(undefined, entries), { ignored: 0, results: {} });
  assert.deepEqual(parseResults('The work is done.\nREADY lane/x abcdef1\nmerged all', entries), { ignored: 0, results: {} });
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
  // A designation that could not be read says nothing: the handoff is neither failed nor settled from it.
  for (const integrator of [undefined, {}, 'integrator']) assert.deepEqual(backlog.plan(later(answered('tag-1', reply), { integrator })), { kind: 'none', why: 'designation-unknown' });
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
  // The answer is the integrator's last message that reads like one (a result line, or a decision asked):
  // a closing remark after it loses nothing, and a later answer replaces an earlier one whole.
  const several = (first, second) => integratorSession({ messages: [{ id: 'tag-1', role: 'user', text: 'handoff', time: NOW }, { id: 'r1', role: 'assistant', text: first, time: NOW + 1 }, { id: 'r2', role: 'assistant', text: second, time: NOW + 2 }] });
  assert.deepEqual(backlog.plan(later(several(reply, 'All done.'))), settle('done', '', { results: parsed }));
  assert.deepEqual(backlog.plan(later(several('需要你决定：先合哪一件\n' + reply, 'That is all from me.'))), settle('waiting', '', { decision: true, question: '先合哪一件', results: parsed }), 'A remark after the answer does not hide that it asked the person');
  assert.deepEqual(backlog.plan(later(several(reply, `RETURNED ${commitOf('a')} the suite failed after all`))), settle('done', '', { results: { ignored: 0, results: { [key('a')]: { kind: 'returned', reason: 'the suite failed after all' } } } }));
  assert.deepEqual(backlog.plan(later(several(reply, '需要你决定：先合哪一件'))), settle('waiting', '', { decision: true, question: '先合哪一件', results: { ignored: 0, results: {} } }), 'A later answer is not filled in from an earlier message');
  assert.deepEqual(backlog.plan(later(several('Working on it.', 'Still nothing to report.'))), settle('done', '', { results: { ignored: 0, results: {} } }));
  // Planning changed nothing, and advance does not settle by itself: git has to be asked first.
  assert.equal(backlog.snapshot().handoff.status, 'sent');
  assert.equal(backlog.advance(later(answered('tag-1', reply)), NOW).kind, 'settle');
  assert.equal(backlog.snapshot().handoff.status, 'sent');
});

test('a line written while the integrator still worked is not mixed into its later answer', t => {
  const { backlog } = fixture(t);
  handed(backlog, ['a', 'b']);
  // Mid-work it wrote that a was returned; its answer then names only b. The earlier line is not a's result.
  const session = integratorSession({ messages: [{ id: 'tag-1', role: 'user', text: 'handoff', time: NOW },
    { id: 'r1', role: 'assistant', text: `RETURNED ${commitOf('a')} the suite failed, trying once more`, time: NOW + 1 },
    { id: 'r2', role: 'assistant', text: `MERGED ${commitOf('b')} as ${MAIN2} tests 9/9`, time: NOW + 2 }, { id: 'r3', role: 'assistant', text: 'Done.', time: NOW + 3 }] });
  const action = backlog.plan(later(session));
  assert.deepEqual(Object.keys(action.results.results), [key('b')]);
  const result = backlog.settle(action, { handoffId: action.handoffId, verified: ok(['b']), mainHead: MAIN2 }, NOW + 60000);
  assert.deepEqual(outcomes(result), { a: 'again', b: 'merged' }, 'a has no result: it is handed once more, not recorded as returned');
  // A final answer whose lines cannot be read is still the answer: the earlier line does not stand in for it.
  for (const final of ['MERGED all of them as abc123d tests 10/10', `HELD ${'9'.repeat(40)} review-off`, 'RETURNED: everything, see above']) {
    const { backlog: other } = fixture(t);
    handed(other, ['a', 'b']);
    const unread = integratorSession({ messages: [{ id: 'tag-1', role: 'user', text: 'handoff', time: NOW },
      { id: 'r1', role: 'assistant', text: `HELD ${commitOf('a')} review-off (will check again)`, time: NOW + 1 }, { id: 'r2', role: 'assistant', text: final, time: NOW + 2 }] });
    const planned = other.plan(later(unread));
    assert.deepEqual(planned.results, { ignored: 1, results: {} }, final);
    assert.deepEqual(outcomes(other.settle(planned, {}, NOW + 60000)), { a: 'again', b: 'again' }, final);
  }
  // A decision first and a full answer after it: the later answer is the answer, as the last message decides for a queue item.
  const { backlog: decided } = fixture(t);
  const opened = handed(decided, ['a', 'b']);
  const both = integratorSession({ messages: [{ id: 'tag-1', role: 'user', text: 'handoff', time: NOW }, { id: 'r1', role: 'assistant', text: '需要你决定：a 和 b 冲突', time: NOW + 1 },
    { id: 'r2', role: 'assistant', text: `HELD ${commitOf('a')} conflict\nRETURNED ${commitOf('b')} needs a rebase`, time: NOW + 2 }] });
  const later2 = decided.plan(later(both));
  assert.equal(later2.status, 'done'); assert.equal(later2.decision, undefined);
  const settled = decided.settle(later2, {}, NOW + 60000);
  assert.deepEqual(outcomes(settled), { a: `held:conflict:${opened.handoffId}`, b: 'returned:needs a rebase' });
  assert.deepEqual(settled.notify, [`conflict:${opened.handoffId}`], 'The person is still told once about the conflict');
});

test('after an automatic message from someone else: a later answer counts when there was none before; an earlier answer is only overlaid by later merges, and anything else later asks the person', t => {
  const user = (id, text, extra = {}) => ({ id, role: 'user', text, time: NOW + 2, ...extra });
  const says = (id, text, time) => ({ id, role: 'assistant', text, time });
  const sessionWith = (...rows) => integratorSession({ messages: [{ id: 'tag-1', role: 'user', text: 'handoff', origin: 'naw-dispatch', time: NOW }, ...rows] });
  const merged = name => `MERGED ${commitOf(name)} as ${MAIN2} tests 9/9`;
  const QUESTION = '需要你决定：这件事怎么办？';
  const UNREADABLE = `RETURNED ${'9'.repeat(40)} something else\nMERGED all of them as abc123d tests 1/1`;
  const planned = (names, session) => { const { backlog } = fixture(t); handed(backlog, names); return { backlog, action: backlog.plan(later(session)) }; };
  const shape = action => [action.status, action.reason, action.decision, Object.keys(action.results?.results || {}), action.results?.ignored];
  // Each kind of automatic message from someone else, as the queue's reply reader knows them: by origin, or by NAW's marker on a native row.
  // Another member's message through a space carries that member's name, and is one of them.
  const others = [{ origin: 'naw-dispatch' }, { origin: 'agent-wake' }, { origin: 'agent-control' }, { origin: 'room', name: 'Member B' }, { text: '【NAW 派活】Another task' }, { text: '【NAW 换会话】Hand over' }];
  for (const other of others) {
    const row = user('other', other.text || 'Synthetic words', { ...(other.origin ? { origin: other.origin } : {}), ...(other.name ? { name: other.name } : {}) }), label = JSON.stringify(other);
    // A question written after it is put to the person, with its text; it is not dropped as "no result".
    const asked = planned(['a', 'b'], sessionWith(row, says('r2', QUESTION, NOW + 3)));
    assert.deepEqual(shape(asked.action), ['waiting', undefined, true, [], 0], label);
    assert.equal(asked.action.question, '这件事怎么办？', label);
    // An answer before it and a question after it: the question may be about something else, so the person is asked,
    // and what the earlier answer said is kept, not dropped.
    const late = planned(['a', 'b'], sessionWith(says('r1', merged('a'), NOW + 1), row, says('r2', QUESTION, NOW + 3)));
    assert.deepEqual(shape(late.action), ['waiting', undefined, true, [key('a')], 0], label);
    assert.equal(late.action.question, '这件事怎么办？', label);
    assert.deepEqual(outcomes(late.backlog.settle(late.action, { handoffId: late.action.handoffId, verified: ok(['a']), mainHead: MAIN2 }, NOW + 60000)).a, 'merged', label);
    // A later message that only reports merges is laid over the earlier answer, because git decides each merge:
    // it wins over a provisional line and over lines copied from the handoff's own text, and adds to the rest.
    for (const [earlier, ignored] of [[`HELD ${commitOf('a')} review-off (will check again)`, 0], ['MERGED <READY 的提交号> as <main 上的提交号> tests <通过数/总数>', 1]]) {
      const real = planned(['a'], sessionWith(says('r1', earlier, NOW + 1), row, says('r2', merged('a'), NOW + 3)));
      assert.deepEqual(shape(real.action), ['done', undefined, undefined, [key('a')], ignored], label + earlier);
      assert.deepEqual(outcomes(real.backlog.settle(real.action, { handoffId: real.action.handoffId, verified: ok(['a']), mainHead: MAIN2 }, NOW + 60000)), { a: 'merged' }, label);
    }
    const both = planned(['a', 'b'], sessionWith(says('r1', `${merged('a')}\nRETURNED ${commitOf('b')} needs a rebase`, NOW + 1), row, says('r2', `Rebased it myself.\n${merged('b')}`, NOW + 3)));
    assert.deepEqual(shape(both.action), ['done', undefined, undefined, [key('a'), key('b')], 0], label);
    assert.deepEqual(outcomes(both.backlog.settle(both.action, { handoffId: both.action.handoffId, verified: ok(['a', 'b']), mainHead: MAIN2 }, NOW + 60000)), { a: 'merged', b: 'merged' }, label);
    // A later RETURNED or HELD does not replace an earlier MERGED (only merges are checked): the earlier results stand and the person is asked.
    for (const word of [`RETURNED ${commitOf('a')} changed my mind`, `HELD ${commitOf('a')} review-off`, `${merged('b')}\nRETURNED ${commitOf('a')} changed my mind`]) {
      const replaced = planned(['a', 'b'], sessionWith(says('r1', merged('a'), NOW + 1), row, says('r2', word, NOW + 3)));
      assert.deepEqual(shape(replaced.action).slice(0, 3), ['waiting', undefined, true], label + word);
      assert.equal(replaced.action.results.results[key('a')].kind, 'merged', label + word);
      assert.equal(replaced.action.results.results[key('b')]?.kind, word.startsWith('MERGED') ? 'merged' : undefined, label + word);
      assert.equal(replaced.action.question, '', 'No question of its own: the person is pointed to the integrator\'s session');
      // The record takes it: the earlier merge is checked and recorded (so main may be installed), the handoff waits, and the person is told once about each.
      const settled = replaced.backlog.settle(replaced.action, { handoffId: replaced.action.handoffId, verified: ok(['a', 'b']), mainHead: MAIN2 }, NOW + 60000);
      assert.deepEqual([outcomes(settled).a, replaced.backlog.snapshot().handoff.status, settled.notify], ['merged', 'waiting', [`conflict:${replaced.action.handoffId}`, `installable:${MAIN2}`]], label + word);
    }
    // Its own question stands when only merges follow; the merges are recorded. It also stands when the later message asks something:
    // that later question may be the reply to the other message, and the one about this handoff must not be hidden.
    for (const after of [merged('a'), `${QUESTION}\n${merged('a')}`]) {
      const asking = planned(['a', 'b'], sessionWith(says('r1', '需要你决定：a 和 b 冲突', NOW + 1), row, says('r2', after, NOW + 3)));
      assert.deepEqual(shape(asking.action), ['waiting', undefined, true, [key('a')], 0], label + after);
      assert.equal(asking.action.question, 'a 和 b 冲突', label + after);
    }
    // A later line that only repeats what the earlier answer said about that delivery changes nothing and asks nobody.
    const repeated = planned(['a', 'b'], sessionWith(says('r1', `${merged('a')}\nRETURNED ${commitOf('b')} needs a rebase`, NOW + 1), row, says('r2', `As I said: \nRETURNED ${commitOf('b')} needs a rebase`, NOW + 3)));
    assert.deepEqual(shape(repeated.action), ['done', undefined, undefined, [key('a'), key('b')], 0], label);
    // A later MERGED line that cannot be read is not laid over the earlier answer (git would never be asked about it): the earlier result stands, and the person is asked.
    const garbled = planned(['a'], sessionWith(says('r1', merged('a'), NOW + 1), row, says('r2', `MERGED ${commitOf('a')} already`, NOW + 3)));
    assert.deepEqual(shape(garbled.action).slice(0, 3), ['waiting', undefined, true], label);
    assert.deepEqual([garbled.action.results.results[key('a')].kind, garbled.action.results.results[key('a')].malformed], ['merged', undefined], label);
    // An earlier message with nothing but lines that cannot be read is no answer to protect: the later message is the answer, whatever it says.
    const stray = planned(['a'], sessionWith(says('r1', 'MERGED all of them as abc123d tests 1/1', NOW + 1), row, says('r2', `RETURNED ${commitOf('a')} needs work`, NOW + 3)));
    assert.deepEqual(shape(stray.action), ['done', undefined, undefined, [key('a')], 1], label);
    // Result lines for this handoff's own deliveries are read wherever they stand: a merge is still checked, a return carries its reason.
    const lines = planned(['a', 'b'], sessionWith(row, says('r2', `${merged('a')}\nRETURNED ${commitOf('b')} needs a rebase`, NOW + 3), says('r3', 'All done here.', NOW + 4)));
    assert.deepEqual(shape(lines.action), ['done', undefined, undefined, [key('a'), key('b')], 0], label);
    assert.deepEqual(outcomes(lines.backlog.settle(lines.action, { handoffId: lines.action.handoffId, verified: ok(['a']), mainHead: MAIN2 }, NOW + 60000)), { a: 'merged', b: 'returned:needs a rebase' }, label);
    // Lines that cannot be read, written after it, do not make that message the answer: the answer before it stands.
    const foreign = planned(['a'], sessionWith(says('r1', merged('a'), NOW + 1), row, says('r2', UNREADABLE, NOW + 3)));
    assert.deepEqual(shape(foreign.action), ['done', undefined, undefined, [key('a')], 0], label);
    // Before it they still do, as always; an empty row of the integrator's is not one of its messages.
    const unread = planned(['a'], sessionWith(says('r1', merged('a'), NOW + 1), says('r2', UNREADABLE, NOW + 1), row, says('r3', 'Noted.', NOW + 3)));
    assert.deepEqual(shape(unread.action), ['done', undefined, undefined, [], 2], label);
    const empty = planned(['a'], sessionWith(says('r0', '  ', NOW + 1), row, says('r1', UNREADABLE, NOW + 3), says('r2', 'Noted.', NOW + 4)));
    assert.deepEqual(shape(empty.action), ['done', undefined, undefined, [], 0], label);
    // Only words for that other message: nothing reads like an answer, and each delivery is handed once more.
    const chat = planned(['a', 'b'], sessionWith(row, says('r2', 'Replied to the other agent.', NOW + 3)));
    assert.deepEqual(shape(chat.action), ['done', undefined, undefined, [], 0], label);
    assert.deepEqual(outcomes(chat.backlog.settle(chat.action, {}, NOW + 60000)), { a: 'again', b: 'again' }, label);
  }
  // A continuation after a limit resumes the same work: an answer after it that cannot be read is still the answer.
  const resume = user('resume', 'Continue', { origin: 'capacity-recovery' });
  assert.deepEqual(shape(planned(['a'], sessionWith(says('r1', merged('a'), NOW + 1), resume, says('r2', 'MERGED all of them as abc123d tests 1/1', NOW + 3))).action), ['done', undefined, undefined, [], 1]);
  assert.deepEqual(shape(planned(['a', 'b'], sessionWith(resume, says('r2', '需要你决定：a 和 b 冲突', NOW + 3))).action).slice(0, 3), ['waiting', undefined, true]);
  // Without another message nothing changes: the last answer-shaped message is the answer, and a silent integrator waits.
  assert.deepEqual(shape(planned(['a'], sessionWith(says('r1', 'Working on it.', NOW + 1), says('r2', merged('a'), NOW + 3))).action), ['done', undefined, undefined, [key('a')], 0]);
  assert.deepEqual(shape(planned(['a'], sessionWith()).action).slice(0, 2), ['waiting', 'no-reply']);
  assert.deepEqual(shape(planned(['a'], sessionWith(user('other', 'Synthetic words', { origin: 'agent-wake' }))).action).slice(0, 2), ['waiting', 'no-reply'], 'Silent also after another message');
  // The person's own step counts wherever it came: typing before or after the other message, and a message that reached the session through a space.
  for (const rows of [[says('r1', merged('a'), NOW + 1), user('other', 'Synthetic words', { origin: 'agent-wake' }), user('typed', 'A word from the person', { origin: 'human', time: NOW + 4 })],
    [user('typed', 'A word from the person', { origin: 'human' }), user('other', 'Synthetic words', { origin: 'agent-wake', time: NOW + 3 }), says('r1', merged('a'), NOW + 4)],
    [user('space', '@integrator a word in the space', { origin: 'room' }), says('r1', merged('a'), NOW + 4)],
    [user('space', '@integrator a word in the space', { origin: 'room', name: '  ' }), says('r1', merged('a'), NOW + 4)]]) {
    assert.deepEqual(shape(planned(['a'], sessionWith(...rows)).action).slice(0, 2), ['waiting', 'person-intervened']);
  }
  // A row that only quotes this handoff's header is still the person's typing, with or without an origin.
  for (const origin of ['human', undefined]) {
    const { backlog } = fixture(t);
    const opened = handed(backlog, ['a']);
    const quoting = sessionWith(says('r1', merged('a'), NOW + 1), user('typed', `这一句是什么意思：【NAW 集成交接】${opened.handoffId}：…`, origin ? { origin } : {}));
    assert.deepEqual(shape(backlog.plan(later(quoting))).slice(0, 2), ['waiting', 'person-intervened'], String(origin));
  }
  // A native row without an origin that is not NAW's own counts as the person's typing, as before; so does another handoff's message.
  assert.deepEqual(shape(planned(['a'], sessionWith(says('r1', merged('a'), NOW + 1), user('other', '【NAW 集成交接】H9-00000000：other deliveries'))).action).slice(0, 2), ['waiting', 'person-intervened']);
  // This handoff's own message as a native row (NAW's copy replaced, with or without its origin) is neither the person's step nor a message from someone else.
  for (const origin of ['naw-dispatch', undefined]) {
    const { backlog } = fixture(t);
    const opened = handed(backlog, ['a']);
    const own = { id: 'native-1', role: 'user', text: `\n【NAW 集成交接】${opened.handoffId}：…`, time: NOW, ...(origin ? { origin } : {}) };
    assert.deepEqual(shape(backlog.plan(later(integratorSession({ messages: [own, says('r1', merged('a'), NOW + 1), says('r2', 'MERGED all of them as abc123d tests 1/1', NOW + 2)] })))), ['done', undefined, undefined, [], 1], String(origin));
  }
  // An automatic message from before the handoff, and a row of the integrator's own tools, are not messages from someone else.
  const earlier = integratorSession({ messages: [{ id: 'old', role: 'user', text: 'Synthetic words', origin: 'agent-wake', time: NOW - 5 }, { id: 'tag-1', role: 'user', text: 'handoff', origin: 'naw-dispatch', time: NOW },
    { id: 'tool', role: 'tool', text: 'output', origin: 'naw-dispatch', time: NOW + 1 }, says('r1', merged('a'), NOW + 2), says('r2', 'MERGED all of them as abc123d tests 1/1', NOW + 3)] });
  assert.deepEqual(shape(planned(['a'], earlier).action), ['done', undefined, undefined, [], 1]);
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
    ['the checks were made for another handoff', `MERGED ${commitOf('a')} as ${MAIN2} tests 9/9`, { handoffId: 'H9-other', verified: ok(['a']), mainHead: MAIN2 }],
    ['git verified another commit than the line names', `MERGED ${commitOf('a')} as ${MAIN2} tests 9/9`, { verified: ok(['a'], MAIN3), mainHead: MAIN3 }],
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
  assert.deepEqual(over.notify, ['returned-limit:space-1:lane/same'], 'The question is about that branch of that space, as the count is');
  assert.equal(RETURN_LIMIT, 2);
  const state = backlog.snapshot();
  assert.deepEqual(state.returns, { 'space-1:lane/same': 3 });
  assert.deepEqual(state.ready.map(entry => [entry.state, entry.note, entry.closedAt]), [['returned', 'full suite failed', NOW + 60000], ['returned', 'full suite failed', NOW + 60000], ['returned', 'stale-commit', NOW + 60000]]);
  // Asked once: another return of that branch does not ask again until the person answered.
  give('ra', 'tag-a');
  assert.deepEqual(settleWith(backlog, 'tag-a', `RETURNED ${commitOf('r')} again`).notify, []);
  assert.deepEqual(backlog.answer('returned-limit:space-1:lane/same'), { answered: true });
  give('rb', 'tag-b');
  assert.deepEqual(settleWith(backlog, 'tag-b', `RETURNED ${commitOf('r')} once more`).notify, ['returned-limit:space-1:lane/same']);
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

test('a comment after the reason word does not change what the reason is', t => {
  const { backlog } = fixture(t);
  const action = handed(backlog, ['a', 'b', 'c', 'd', 'e']);
  const conflict = `conflict:${action.handoffId}`;
  const reply = [`HELD ${commitOf('a')} review-off（审查没开，等用户）`, `HELD ${commitOf('b')} conflict with lane/c, both change the same file`, `HELD ${commitOf('c')} lock-held:Claude 终端 (held since the morning)`,
    `HELD ${commitOf('d')} review-cap: today's amount is used up`, `HELD ${commitOf('e')} reviewing-later`].join('\n');
  const result = settleWith(backlog, 'tag-1', reply);
  assert.deepEqual(outcomes(result), { a: 'held:review-off', b: 'held:' + conflict, c: 'held:lock-held:Claude 终端', d: 'held:review-cap', e: 'held:held-other' });
  assert.deepEqual(result.notify, ['review-off', conflict, 'lock-held:Claude 终端', 'review-cap', 'held-other']);
  // What the integrator wrote is kept beside the reason.
  assert.deepEqual(backlog.snapshot().ready.map(entry => entry.note), ['review-off（审查没开，等用户）', 'conflict with lane/c, both change the same file', 'lock-held:Claude 终端 (held since the morning)', "review-cap: today's amount is used up", 'reviewing-later']);
  // So the changes that end these conditions find their deliveries.
  assert.deepEqual(backlog.reasonCleared('review-opened'), { released: [key('a')] });
  assert.deepEqual(backlog.reasonCleared('lock-released', 'Claude 终端'), { released: [key('c')] });
  assert.deepEqual(backlog.reasonCleared('review-cap-raised'), { released: [key('d')] });
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
  let { backlog, open } = fixture(t);
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
  assert.deepEqual(backlog.pendingNotices(), [], 'The person\'s own typing leaves no notice to send');
  assert.deepEqual(backlog.resolveHandoff(next.handoffId, { retry: true }, NOW + 110000), { released: [key('c')], held: [] });
  assert.deepEqual(backlog.retryReason('no-reply'), { released: [key('a'), key('b')] });
  // A later handoff without a reply is a new occurrence.
  const third = backlog.advance(later(integratorSession()), NOW + 120000);
  backlog.confirmSent(third.handoffId, { tag: 'tag-3', control: 0 }, NOW);
  assert.deepEqual(backlog.settle(backlog.plan(later(answered('tag-3', null))), {}, NOW + 130000).notify, ['no-reply']);
  assert.deepEqual(states(backlog), { a: 'handed', b: 'handed', c: 'handed' });
  // What is inside a waiting handoff cannot be held away from outside: the place would stay taken with no question open.
  const waiting = JSON.stringify(backlog.snapshot());
  for (const name of ['a', 'b', 'c']) assert.throws(() => backlog.hold(key(name), 'review-off', NOW), { code: 'HANDOFF_STATE' }, name);
  assert.throws(() => backlog.retryReady(key('a')), { code: 'HANDOFF_STATE' });
  assert.equal(JSON.stringify(backlog.snapshot()), waiting);
  // The person's retry on the reason the handoff waits on is the same retry as in "handoff dealt with":
  // the handoff ends, what was inside may be handed again, and the place is free.
  assert.deepEqual(open().retryReason('no-reply', NOW + 140000), { released: [key('a'), key('b'), key('c')] });
  const after = open().snapshot();
  assert.equal(after.handoff, null); assert.equal(after.reasons['no-reply'].open, false);
  assert.deepEqual(states(backlog = open()), { a: 'deliverable', b: 'deliverable', c: 'deliverable' });
  assert.throws(() => backlog.resolveHandoff(third.handoffId, { retry: true }, NOW), { code: 'HANDOFF_STATE' }, 'It is already resolved');
  assert.deepEqual(backlog.advance(later(integratorSession()), NOW + 150000).keys, [key('a'), key('b'), key('c')]);
});

test('a decision for the person: lines given are recorded, the rest stays inside the waiting handoff', t => {
  const { backlog } = fixture(t);
  const action = handed(backlog, ['a', 'b', 'c', 'd']);
  const conflict = `conflict:${action.handoffId}`;
  const reply = `需要你决定：c 和 d 改了同一处，建议交给一人合成一份\nMERGED ${commitOf('a')} as ${MAIN2} tests 7/7\nRETURNED ${commitOf('b')} needs a rebase`;
  const result = settleWith(backlog, 'tag-1', reply, { verified: ok(['a']), mainHead: MAIN2 });
  assert.deepEqual(outcomes(result), { a: 'merged', b: 'returned:needs a rebase', c: 'waiting:' + conflict, d: 'waiting:' + conflict });
  assert.deepEqual(result.notify, [conflict, `installable:${MAIN2}`]);
  assert.equal(result.question, 'c 和 d 改了同一处，建议交给一人合成一份', 'The question is given to whoever writes the space record');
  const waiting = backlog.snapshot().handoff;
  assert.deepEqual([waiting.status, waiting.reason, waiting.keys, waiting.question], ['waiting', conflict, [key('c'), key('d')], 'c 和 d 改了同一处，建议交给一人合成一份']);
  assert.deepEqual(backlog.advance(later(integratorSession()), NOW + 70000), { kind: 'none', why: 'handoff-waiting' });
  // Answering without choosing a retry does not hand them again; the retry does.
  assert.deepEqual(backlog.resolveHandoff(action.handoffId, { retry: false }, NOW + 80000), { released: [], held: [key('c'), key('d')] });
  assert.deepEqual(backlog.advance(later(integratorSession()), NOW + 90000), { kind: 'none', why: 'nothing-deliverable' });
  assert.deepEqual(backlog.retryReason(conflict), { released: [key('c'), key('d')] });
  // The usual conflict reply has a HELD line for every delivery. The deliveries in conflict stay inside
  // the waiting handoff all the same: the question is the person's, and the place stays taken until then.
  const second = backlog.advance(later(integratorSession()), NOW + 100000);
  backlog.confirmSent(second.handoffId, { tag: 'tag-2', control: 0 }, NOW);
  const again = `conflict:${second.handoffId}`;
  const asked = settleWith(backlog, 'tag-2', `需要你决定：仍然冲突\nHELD ${commitOf('c')} conflict\nHELD ${commitOf('d')} conflict with lane/c`);
  assert.deepEqual(outcomes(asked), { c: 'waiting:' + again, d: 'waiting:' + again });
  assert.deepEqual(asked.notify, [again]); assert.equal(asked.question, '仍然冲突');
  const held = backlog.snapshot().handoff;
  assert.deepEqual([held.status, held.reason, held.keys, held.question], ['waiting', again, [key('c'), key('d')], '仍然冲突']);
  assert.deepEqual(backlog.snapshot().ready.filter(entry => entry.state === 'handed').map(entry => entry.note), [undefined, 'conflict with lane/c'], 'What the integrator wrote about the conflict is kept');
  backlog.noteReady(ready('e'), NOW);
  assert.deepEqual(backlog.advance(later(integratorSession()), NOW + 110000), { kind: 'none', why: 'handoff-waiting' });
  // The person's retry on that conflict, from the list of open questions, ends the handoff as "handoff dealt with, retry" does.
  assert.deepEqual(backlog.retryReason(again, NOW + 120000), { released: [key('c'), key('d')] });
  assert.equal(backlog.snapshot().handoff, null); assert.equal(backlog.snapshot().reasons[again].open, false);
  assert.deepEqual(backlog.advance(later(integratorSession()), NOW + 130000).keys, [key('c'), key('d'), key('e')]);
});

test('a reply that asks the person to decide waits even when every delivery has its line', t => {
  const { backlog, open } = fixture(t);
  const action = handed(backlog, ['a', 'b', 'c']);
  const conflict = `conflict:${action.handoffId}`;
  // No line says "conflict": the question is still the person's, and nothing may start behind their back.
  const reply = `需要你决定：a 合了，b 和 c 要不要等新的检查点\nMERGED ${commitOf('a')} as ${MAIN2} tests 7/7\nRETURNED ${commitOf('b')} needs a rebase\nHELD ${commitOf('c')} checkpoint-invalid`;
  const result = settleWith(backlog, 'tag-1', reply, { verified: ok(['a']), mainHead: MAIN2 });
  assert.deepEqual(outcomes(result), { a: 'merged', b: 'returned:needs a rebase', c: 'held:checkpoint-invalid' });
  assert.deepEqual(result.notify, ['checkpoint-invalid', conflict, `installable:${MAIN2}`], 'The person is told about the decision once');
  assert.equal(result.question, 'a 合了，b 和 c 要不要等新的检查点');
  // The record with a waiting handoff that holds nothing any more is one the next start accepts.
  const waiting = open().snapshot().handoff;
  assert.deepEqual([waiting.status, waiting.reason, waiting.keys, waiting.question], ['waiting', conflict, [], 'a 合了，b 和 c 要不要等新的检查点']);
  assert.equal(open().snapshot().reasons[conflict].open, true, 'The question stays open although nothing is held under it');
  backlog.noteReady(ready('d'), NOW);
  assert.deepEqual(open().advance(later(integratorSession()), NOW + 70000), { kind: 'none', why: 'handoff-waiting' });
  assert.deepEqual(backlog.resolveHandoff(action.handoffId, { retry: true }, NOW + 80000), { released: [], held: [] });
  assert.equal(backlog.snapshot().handoff, null); assert.equal(backlog.snapshot().reasons[conflict].open, false);
  assert.deepEqual(backlog.advance(later(integratorSession()), NOW + 90000).keys, [key('d')]);
  // An open handoff that was sent and holds nothing is still a record no start accepts.
  const { directory, file } = fixture(t);
  const state = backlog.snapshot();
  fs.writeFileSync(file, JSON.stringify({ ...state, handoff: { ...state.handoff, keys: [] }, ready: state.ready.filter(entry => entry.state !== 'handed') }), { mode: 0o600 });
  assert.throws(() => new IntegrationHandoffs(directory).snapshot(), { code: 'HANDOFF_STATE' });
  // A waiting handoff always says what it waits on.
  fs.writeFileSync(file, JSON.stringify({ ...state, handoff: { ...state.handoff, status: 'waiting' } }), { mode: 0o600 });
  assert.throws(() => new IntegrationHandoffs(directory).snapshot(), { code: 'HANDOFF_STATE' });
});

test('a result the reply reader could not have produced is refused, and nothing is recorded', t => {
  const { backlog } = fixture(t);
  const action = handed(backlog, ['a']);
  const before = JSON.stringify(backlog.snapshot());
  const crafted = [{ kind: 'held', reason: 7 }, { kind: 'held' }, { kind: 'returned', reason: '' }, { kind: 'merged', as: MAIN2 }, { kind: 'merged', as: 'main', tests: { passed: 1, total: 1 } },
    { kind: 'merged', as: MAIN2, tests: { passed: '1', total: 1 } }, { kind: 'merged', as: MAIN2, tests: { passed: 1, total: 1 }, review: 7 }, { kind: 'pushed' }, 'merged', null, ['held']];
  for (const result of crafted) {
    for (const status of ['done', 'waiting']) {
      const settlement = { kind: 'settle', handoffId: action.handoffId, status, ...(status === 'waiting' ? { decision: true } : {}), results: { ignored: 0, results: { [key('a')]: result } } };
      assert.throws(() => backlog.settle(settlement, { handoffId: action.handoffId, verified: ok(['a']), mainHead: MAIN2 }, NOW), { code: 'HANDOFF_STATE' }, JSON.stringify(result));
    }
  }
  assert.equal(JSON.stringify(backlog.snapshot()), before);
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
  assert.deepEqual([backlog.knows(key('m-0')), backlog.knows(key('m-1')), backlog.knows(key('never'))], [true, true, false], 'A trimmed delivery is still known');
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
  // The very same commit on main counts although it has no single change (a merge commit that was fast-forwarded).
  const same = fake({ changes: (base, tip) => tip === MAIN2 ? [{ commit: MAIN2, change: null }, { commit: commitOf('a'), change: null }] : [{ commit: tip, change: null }] });
  assert.deepEqual(await verifyMerged(same, claim), { verified: true, as: MAIN2 });
  // What was merged is read up to the named commit, not up to wherever main is now.
  const asked = [];
  const upTo = fake({ isAncestor: (a, b) => b === MAIN3, changes: (base, tip) => { asked.push([base, tip]); return [{ commit: tip, change: 'x1' }]; } });
  assert.deepEqual(await verifyMerged(upTo, { ...claim, mainHead: MAIN3 }), { verified: true, as: MAIN2 });
  assert.deepEqual(asked, [[START, commitOf('a')], [START, MAIN2]]);
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
  // The named commit is on main and new, but it is not one that holds the delivery: the unrelated commit
  // main moved on by, or the first of the two picks.
  assert.deepEqual(await verifyMerged(read, { ready: second, as: moved, startHead: start, mainHead: picked }), { verified: false, why: 'changes-differ' });
  assert.deepEqual(await verifyMerged(read, { ready: second, as: partial, startHead: start, mainHead: picked }), { verified: false, why: 'changes-differ' });
  // A branch named like the short id of the pick points somewhere else: the name is not taken for the commit.
  git('branch', picked.slice(0, 9), moved);
  assert.deepEqual(await verifyMerged(read, { ready: second, as: picked.slice(0, 9), startHead: start, mainHead: picked }), { verified: false, why: 'unknown-commit' });
  assert.deepEqual(await verifyMerged(read, { ready: second, as: picked, startHead: start, mainHead: picked }), { verified: true, as: picked });
  // A fast-forward: the delivery's own commits are main's new commits.
  git('checkout', '--quiet', '-b', 'main-ff', start); git('merge', '--quiet', '--ff-only', 'lane/work');
  assert.deepEqual(await verifyMerged(read, { ready: second, as: second, startHead: start, mainHead: second }), { verified: true, as: second });
  // A delivery that holds a merge commit: fast-forwarded it is the same commits and counts; picked, the merge
  // commit has no single change to find again and it does not.
  git('checkout', '--quiet', '-b', 'lane/side', start); commit('side.txt', 'side\n');
  git('checkout', '--quiet', '-b', 'lane/merged', start); commit('own.txt', 'own\n');
  git('merge', '--quiet', '--no-ff', '-m', 'Synthetic merge', 'lane/side'); const withMerge = git('rev-parse', 'HEAD');
  assert.deepEqual(await verifyMerged(read, { ready: withMerge, as: withMerge, startHead: start, mainHead: withMerge }), { verified: true, as: withMerge });
  assert.deepEqual(await verifyMerged(read, { ready: withMerge, as: picked, startHead: start, mainHead: picked }), { verified: false, why: 'changes-differ' });
});

test('the real reader, the verdicts and the settlement together: what git confirms is merged, what it does not is held', async t => {
  const { git, commit, start, read } = repository(t);
  git('checkout', '--quiet', '-b', 'lane/a', start); const a = commit('a.txt', 'a\n');
  git('checkout', '--quiet', '-b', 'lane/b', start); const b = commit('b.txt', 'b\n');
  git('checkout', '--quiet', 'main'); commit('other.txt', 'other\n');
  const { backlog } = fixture(t);
  backlog.noteReady(ready('a', { commit: a }), NOW); backlog.noteReady(ready('b', { commit: b }), NOW);
  // The handoff begins on the main head of that moment; the integrator then picks one of the two.
  const opened = backlog.advance(observed({ mainHead: git('rev-parse', 'main') }), NOW);
  backlog.confirmSent(opened.handoffId, { tag: 'tag-1', control: 0 }, NOW);
  git('cherry-pick', a); const head = git('rev-parse', 'HEAD');
  const reply = `1. MERGED ${a.slice(0, 9)} as ${head.slice(0, 9)} tests 12/12\n2. MERGED ${b.slice(0, 9)} as ${head.slice(0, 9)} tests 12/12`;
  const action = backlog.plan(later(answered('tag-1', reply)));
  const checked = await verifyResults(read, backlog.snapshot(), action, head);
  assert.deepEqual(checked, { handoffId: opened.handoffId, mainHead: head, verified: { [key('a')]: { verified: true, as: head }, [key('b')]: { verified: false, why: 'changes-differ' } } });
  const result = backlog.settle(action, checked, NOW + 60000);
  assert.deepEqual(outcomes(result), { a: 'merged', b: 'held:merge-unverified' });
  assert.deepEqual(result.install, { commit: head });
  assert.equal(backlog.snapshot().ready[0].mergedAs, head, 'The full id of the commit git confirmed is what is recorded');
});

test('every MERGED line of a settlement gets its verdict; unreadable lines and failed tests are refused before git is asked', async t => {
  const { backlog } = fixture(t);
  handed(backlog, ['a', 'b', 'c', 'd']);
  const reply = `MERGED ${commitOf('a')} as ${MAIN2} tests 5/5\nMERGED ${commitOf('b')} as ${MAIN2} tests 4/5\nMERGED ${commitOf('c')} somewhere\nRETURNED ${commitOf('d')} no`;
  const action = backlog.plan(later(answered('tag-1', reply)));
  const asked = [];
  const read = fake({ commit: value => { asked.push(value); return value; } });
  const checked = await verifyResults(read, backlog.snapshot(), action, MAIN2);
  // The verdicts come with the handoff and the main head they were made for: settle takes exactly this.
  assert.deepEqual(checked, { handoffId: action.handoffId, mainHead: MAIN2,
    verified: { [key('a')]: { verified: true, as: MAIN2 }, [key('b')]: { verified: false, why: 'tests-not-all-passed' }, [key('c')]: { verified: false, why: 'unreadable-line' } } });
  assert.deepEqual(asked, [MAIN2, commitOf('a')], 'git is asked only about the line that can count');
  assert.deepEqual(await verifyResults(read, backlog.snapshot(), { ...action, handoffId: 'H9-other' }, MAIN2), { handoffId: 'H9-other', mainHead: MAIN2, verified: {} });
  const result = backlog.settle(action, checked, NOW + 60000);
  assert.deepEqual(outcomes(result), { a: 'merged', b: 'held:merge-unverified', c: 'held:merge-unverified', d: 'returned:no' });
  assert.deepEqual(result.install, { commit: MAIN2 });
  // Several deliveries merged as one main commit: each question is put to git once.
  const { backlog: batch } = fixture(t);
  handed(batch, ['a', 'b', 'c']);
  const lines = ['a', 'b', 'c'].map(name => `MERGED ${commitOf(name)} as ${MAIN2} tests 5/5`).join('\n');
  const calls = [];
  const counting = fake({ commit: value => { calls.push(`commit ${value}`); return value; }, isAncestor: (a, b) => { calls.push(`ancestor ${a} ${b}`); return b === MAIN2; },
    changes: (base, tip) => { calls.push(`changes ${tip}`); return tip === MAIN2 ? ['a', 'b', 'c'].map(name => ({ commit: 'm' + name, change: 'x' + name })) : [{ commit: tip, change: 'x' + String.fromCharCode(parseInt(tip.slice(0, 2), 16)) }]; } });
  const all = await verifyResults(counting, batch.snapshot(), batch.plan(later(answered('tag-1', lines))), MAIN2);
  assert.deepEqual(Object.values(all.verified), [{ verified: true, as: MAIN2 }, { verified: true, as: MAIN2 }, { verified: true, as: MAIN2 }]);
  assert.equal(calls.filter(call => call === `changes ${MAIN2}`).length, 1, 'What was merged is read once for the batch');
  assert.equal(calls.filter(call => call === `commit ${MAIN2}`).length, 1);
  assert.equal(new Set(calls).size, calls.length, 'No question is asked twice');
});

test('the module still runs nothing: git is asked through the reader it is given', () => {
  const source = fs.readFileSync(path.join(__dirname, '../integrator-handoff.cjs'), 'utf8');
  assert.deepEqual([...source.matchAll(/require\('([^']+)'\)/g)].map(match => match[1]).sort(), ['./queue-dispatch.cjs', 'node:crypto', 'node:fs', 'node:path']);
  assert.ok(!source.includes('integrator-git'));
});
