const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const rules = require('../queue-dispatch.cjs');
const { IntegrationHandoffs, FILE } = require('../integrator-handoff.cjs');
const { IntegratorEngine, HEAD_WAIT_MS } = require('../integrator-engine.cjs');

// Settling a handoff and telling the person, through the engine (B6 E2b, checkpoint H5). Synthetic
// spaces, sessions and replies; the send, git, the space-record writer and the notice are stand-ins.
const NOW = 1_800_000_000_000, LATER = NOW + 60000;
const MAIN = 'a'.repeat(40), HEAD2 = 'b'.repeat(40), HEAD3 = 'c'.repeat(40);
const INTEGRATOR = { sessionId: 'integrator', nativeId: 'native-integrator' };
const NAMES = ['a', 'b', 'c', 'd', 'e'];
const commitOf = name => (name.charCodeAt(0).toString(16).padStart(2, '0')).repeat(20);
const key = name => `ready:space-1:${name}`;
function fact(name, extra = {}) {
  const branch = extra.branch || `lane/${name}`, commit = commitOf(name);
  return { id: `event-${name}`, role: 'system', kind: 'queue', time: NOW + 1, sessionId: `member-${name}`,
    uiMessage: { version: 1, key: 'notice.queue.ready', params: { name: `Member ${name}`, text: `Private task text of ${name}`, branch, commit: commit.slice(0, 12) } },
    monitor: { kind: 'ready', key: key(name), itemId: name, branch, commit } };
}
const space = events => ({ id: 'space-1', name: 'Space one', events });
function integratorSession(extra = {}) {
  return { id: INTEGRATOR.sessionId, nativeId: INTEGRATOR.nativeId, provider: 'claude', state: 'idle', background: 0, scheduled: 0, backgroundStale: false,
    chatAvailable: true, liveDraft: '', controlRevision: 3, serviceCapabilities: [rules.CAPABILITY], fleet: [], messages: [], roomIds: [], ...extra };
}
const at = (now, sessions = [integratorSession()], extra = {}) => ({ sessions, complete: true, wakePolicy: { enabled: true }, now,
  idleSince: new Map([[INTEGRATOR.sessionId, now - rules.IDLE_SETTLE_MS]]), humanAt: new Map(), ...extra });
// The integrator's session after it answered the handoff that was sent with this tag.
const answered = (tag, ...replies) => integratorSession({ messages: [{ id: tag, role: 'user', text: 'handoff', time: NOW },
  ...replies.map((text, index) => ({ id: `reply-${index}`, role: 'assistant', text, time: NOW + 1 + index }))] });
// git with fixed answers: every delivery was cherry-picked and HEAD2 holds them all.
function reader(overrides = {}) {
  // A short id names the one known commit that begins with it, as in a real repository.
  const known = [MAIN, HEAD2, ...NAMES.map(commitOf)], full = value => known.find(id => id.startsWith(value)) || null;
  return { commit: async value => full(value), isAncestor: async (a, b) => b === HEAD2,
    changes: async (base, tip) => tip === HEAD2 ? NAMES.map(name => ({ commit: 'm' + name, change: 'x-' + commitOf(name).slice(0, 2) })) : [{ commit: tip, change: 'x-' + tip.slice(0, 2) }], ...overrides };
}
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-engine-settle-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const handoffs = new IntegrationHandoffs(directory);
  const f = { directory, file: path.join(directory, FILE), handoffs, head: HEAD2, clock: NOW, heads: 0, looks: 0, fresh: undefined, sent: [], records: [], notices: [],
    recording: fact => { f.records.push(fact); }, notifying: async info => { f.notices.push(info); } };
  const base = { handoffs, now: () => f.clock, designation: () => INTEGRATOR, reader: reader(),
    mainHead: async () => { f.heads += 1; if (f.head instanceof Error) throw f.head; return f.head; },
    send: async (session, text, handoffId) => { f.sent.push(handoffId); return { tag: `tag-${f.sent.length}`, control: 3 }; },
    record: fact => f.recording(fact), notify: info => f.notifying(info) };
  f.engine = new IntegratorEngine({ ...base, ...options });
  f.look = current => async () => { f.looks += 1; if (f.fresh instanceof Error) throw f.fresh; return f.fresh === undefined ? current : f.fresh; };
  // Deliver the given names and hand them out; the main head at that moment is MAIN.
  f.handed = async names => {
    f.engine.intake([space(names.map(name => fact(name)))]);
    const before = f.head; f.head = MAIN;
    const result = await f.engine.handOut(at(NOW + 10), async () => at(NOW + 10));
    f.head = before; f.heads = 0; f.looks = 0;
    assert.equal(result.kind, 'opened', JSON.stringify(result));
    return result;
  };
  f.settle = (session, extra) => { const view = at(LATER, session ? [session] : [], extra); return f.engine.settle(view, f.look(view)); };
  f.states = () => Object.fromEntries(handoffs.snapshot().ready.map(entry => [entry.itemId, entry.state + (entry.reason ? ':' + entry.reason : '')]));
  f.bytes = () => fs.readFileSync(f.file, 'utf8');
  return f;
}
const outcomes = result => Object.fromEntries(result.facts.map(fact => [fact.itemId, fact.outcome + (fact.reason ? ':' + fact.reason : '')]));

test('an answer without merges is settled as it stands: git is not read and no fresh look is taken', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.settle(integratorSession()), { kind: 'none', why: 'no-handoff' });
  const opened = await f.handed(['a', 'b']);
  // While the integrator still works, or has not been idle long enough, nothing happens.
  assert.deepEqual(await f.settle({ ...answered('tag-1', `RETURNED ${commitOf('a')} x`), state: 'working' }), { kind: 'none', why: 'integrator-working' });
  const reply = `RETURNED ${commitOf('a')} the suite failed\nHELD ${commitOf('b')} review-off`;
  const early = at(LATER, [answered('tag-1', reply)], { idleSince: new Map([['integrator', LATER - rules.IDLE_SETTLE_MS + 1]]) });
  assert.deepEqual(await f.engine.settle(early, f.look(early)), { kind: 'none', why: 'integrator-working' });
  // Who is designated cannot be read just now: nothing is decided from that, and the handoff is not failed.
  const unreadable = new IntegratorEngine({ handoffs: f.handoffs, now: () => NOW, designation: () => { throw Error('Synthetic record failure'); }, mainHead: async () => HEAD2, send: async () => 'x' });
  const seen = at(LATER, [answered('tag-1', reply)]);
  assert.deepEqual(await unreadable.settle(seen, async () => seen), { kind: 'none', why: 'designation-unknown' });
  const result = await f.settle(answered('tag-1', reply));
  assert.deepEqual([result.kind, result.handoffId, result.status, outcomes(result), result.notify, result.install], ['settled', opened.handoffId, 'done', { a: 'returned:the suite failed', b: 'held:review-off' }, ['review-off'], null]);
  assert.deepEqual([f.heads, f.looks], [0, 0]);
  assert.equal(f.handoffs.snapshot().handoff, null);
  // The fall-backs that need no reply go the same way: an unconfirmed send, a missing integrator, no reply.
  const g = fixture(t, { send: async () => { throw Error('send-timeout'); } });
  g.engine.intake([space([fact('a')])]); g.head = MAIN;
  assert.equal((await g.engine.handOut(at(NOW + 10), async () => at(NOW + 10))).kind, 'unconfirmed');
  assert.deepEqual(await g.settle(integratorSession()), { kind: 'none', why: 'send-pending' });
  const overdue = at(NOW + rules.UNCONFIRMED_SEND_MS + 1);
  const failed = await g.engine.settle(overdue, g.look(overdue));
  assert.deepEqual([failed.status, outcomes(failed), failed.notify], ['failed', { a: 'held:send-unconfirmed' }, ['send-unconfirmed']]);
  const h = fixture(t);
  await h.handed(['a']);
  const silent = await h.settle(answered('tag-1'));
  assert.deepEqual([silent.status, outcomes(silent), silent.notify], ['waiting', { a: 'waiting:no-reply' }, ['no-reply']]);
  assert.deepEqual(await h.settle(answered('tag-1', 'late')), { kind: 'none', why: 'handoff-waiting' });
});

test('an answer that reports merges is checked with git, read again on a fresh look, and settled only if it still says the same', async t => {
  const f = fixture(t);
  const opened = await f.handed(['a', 'b', 'c']);
  const reply = `MERGED ${commitOf('a')} as ${HEAD2} tests 9/9 review 0a2298c6\nMERGED ${commitOf('b').slice(0, 9)} as ${HEAD2.slice(0, 9)} tests 9/9\nRETURNED ${commitOf('c')} needs a rebase`;
  const result = await f.settle(answered('tag-1', reply));
  assert.deepEqual([result.kind, result.status, outcomes(result)], ['settled', 'done', { a: 'merged', b: 'merged', c: 'returned:needs a rebase' }]);
  assert.deepEqual([result.install, result.notify], [{ commit: HEAD2 }, [`installable:${HEAD2}`]]);
  assert.deepEqual([f.heads, f.looks], [1, 1], 'Main\'s head and the fresh look were each asked once');
  assert.deepEqual(f.handoffs.snapshot().ready.map(entry => entry.mergedAs), [HEAD2, HEAD2, undefined]);
  assert.equal(opened.handoffId, result.handoffId);
  // What git does not confirm is not merged.
  const g = fixture(t, { reader: reader({ isAncestor: async () => false }) });
  await g.handed(['a']);
  const refused = await g.settle(answered('tag-1', `MERGED ${commitOf('a')} as ${HEAD2} tests 9/9`));
  assert.deepEqual([outcomes(refused), refused.install, refused.notify], [{ a: 'held:merge-unverified' }, null, ['merge-unverified']]);
  // Without a git reader nothing can be confirmed.
  const h = fixture(t, { reader: null });
  await h.handed(['a']);
  assert.deepEqual(outcomes(await h.settle(answered('tag-1', `MERGED ${commitOf('a')} as ${HEAD2} tests 9/9`))), { a: 'held:merge-unverified' });
});

test('if the answer changed while git was read, nothing is settled on that pass', async t => {
  const f = fixture(t);
  await f.handed(['a', 'b']);
  const first = `MERGED ${commitOf('a')} as ${HEAD2} tests 9/9`;
  const before = f.bytes();
  // The integrator went on writing: one more line, a different line, back at work, or the person typed.
  const changes = [
    answered('tag-1', first, `MERGED ${commitOf('a')} as ${HEAD2} tests 9/9\nMERGED ${commitOf('b')} as ${HEAD2} tests 9/9`),
    answered('tag-1', first, `RETURNED ${commitOf('a')} the suite failed after all`),
    { ...answered('tag-1', first), state: 'working' },
    integratorSession({ messages: [{ id: 'tag-1', role: 'user', text: 'handoff', time: NOW }, { id: 'r', role: 'assistant', text: first, time: NOW + 1 }, { id: 'u', role: 'user', text: 'stop', time: NOW + 2 }] }),
  ];
  for (const [index, session] of changes.entries()) {
    f.fresh = at(LATER, [session]);
    assert.deepEqual(await f.settle(answered('tag-1', first)), { kind: 'none', why: 'changed-while-checking' }, `change ${index}`);
    assert.equal(f.bytes(), before, `change ${index}`);
  }
  // The moment passed, or the fresh look failed.
  for (const fresh of [null, Error('refresh timeout')]) {
    f.fresh = fresh;
    assert.deepEqual(await f.settle(answered('tag-1', first)), { kind: 'none', why: 'not-ready-now' });
    assert.equal(f.bytes(), before);
  }
  // On a later pass the settled answer is the one that stands then.
  f.fresh = undefined;
  const final = await f.settle(answered('tag-1', first, `RETURNED ${commitOf('a')} the suite failed after all`));
  assert.deepEqual(outcomes(final), { a: 'returned:the suite failed after all', b: 'again' });
});

test('an answer with merges waits a bounded while for main\'s head, then is settled without git', async t => {
  // Unreadable: nothing, a failure, or something that is not a full commit id.
  for (const unreadable of [null, undefined, Error('git failed'), 'main', '', HEAD2.slice(0, 12), 7]) {
    const f = fixture(t);
    await f.handed(['a']);
    f.head = unreadable; f.clock = LATER;
    const session = answered('tag-1', `MERGED ${commitOf('a')} as ${HEAD2} tests 9/9`);
    assert.deepEqual(await f.settle(session), { kind: 'none', why: 'main-unknown' }, String(unreadable));
    // The first time is kept with the handoff; nothing else is written while it waits.
    assert.equal(f.handoffs.snapshot().handoff.headUnreadAt, LATER);
    const before = f.bytes();
    f.clock = LATER + HEAD_WAIT_MS - 1;
    assert.deepEqual(await f.settle(session), { kind: 'none', why: 'main-unknown' });
    assert.equal(f.bytes(), before); assert.equal(f.looks, 0, 'Nothing is looked at afresh while the head is unknown');
    // The wait is over: the place is not left taken in silence. The person is told that main could not
    // be read, which is NAW's own trouble with git, not that the integrator's claim failed.
    f.clock = LATER + HEAD_WAIT_MS;
    const result = await f.settle(session);
    assert.deepEqual([outcomes(result), result.notify, result.install], [{ a: 'held:main-unreadable' }, ['main-unreadable'], null], String(unreadable));
    assert.equal(f.looks, 1, 'The answer is still read again before it is settled');
  }
  assert.equal(HEAD_WAIT_MS, 10 * 60 * 1000);
  // The bound holds across restarts and for a caller that builds a new engine on every pass.
  const r = fixture(t);
  await r.handed(['a', 'b']);
  const waiting = answered('tag-1', `MERGED ${commitOf('a')} as ${HEAD2} tests 9/9\nMERGED ${commitOf('b')} into main`);
  const fresh = clock => new IntegratorEngine({ handoffs: new IntegrationHandoffs(r.directory), now: () => clock, designation: () => INTEGRATOR, reader: reader(), mainHead: async () => null, send: async () => 'x' });
  for (const [clock, expected] of [[LATER, 'main-unknown'], [LATER + 60000, 'main-unknown'], [LATER + HEAD_WAIT_MS - 1, 'main-unknown']]) {
    const view = at(clock, [waiting]);
    assert.deepEqual(await fresh(clock).settle(view, async () => view), { kind: 'none', why: expected }, String(clock));
  }
  const due = at(LATER + HEAD_WAIT_MS, [waiting]);
  const ended = await fresh(LATER + HEAD_WAIT_MS).settle(due, async () => due);
  assert.deepEqual([ended.kind, outcomes(ended)], ['settled', { a: 'held:main-unreadable', b: 'held:merge-unverified' }], 'A merge line that cannot be read stays an unverified claim, whatever git says');
  // Only a sent handoff can wait for the head, and the time kept with it must be a time.
  assert.throws(() => r.handoffs.headUnreadSince('H9-other', NOW), { code: 'HANDOFF_STATE' });
  const w = fixture(t);
  await w.handed(['a']);
  const kept = w.handoffs.snapshot();
  fs.writeFileSync(w.file, JSON.stringify({ ...kept, handoff: { ...kept.handoff, headUnreadAt: 'a while ago' } }), { mode: 0o600 });
  assert.throws(() => new IntegrationHandoffs(w.directory).snapshot(), { code: 'HANDOFF_STATE' });
  // The head becomes readable within the wait: the answer is settled with git as usual, and a later handoff waits anew.
  const f = fixture(t);
  await f.handed(['a']);
  f.head = null; f.clock = LATER;
  const session = answered('tag-1', `MERGED ${commitOf('a')} as ${HEAD2} tests 9/9`);
  assert.equal((await f.settle(session)).why, 'main-unknown');
  f.head = HEAD2; f.clock = LATER + 5000;
  assert.deepEqual(outcomes(await f.settle(session)), { a: 'merged' });
  f.engine.intake([space([fact('a'), fact('b')])]);
  f.head = HEAD2; f.clock = NOW;
  const second = await f.engine.handOut(at(LATER + 9000), async () => at(LATER + 9000));
  assert.equal(second.kind, 'opened');
  f.head = null; f.clock = LATER + HEAD_WAIT_MS + 5000;
  const again = integratorSession({ messages: [{ id: 'tag-2', role: 'user', text: 'handoff', time: NOW }, { id: 'r', role: 'assistant', text: `MERGED ${commitOf('b')} as ${HEAD2} tests 9/9`, time: NOW + 1 }] });
  const view = at(LATER + HEAD_WAIT_MS + 5000, [again]);
  assert.deepEqual(await f.engine.settle(view, f.look(view)), { kind: 'none', why: 'main-unknown' }, 'The second handoff\'s wait starts when its own answer is first seen');
});

test('a question about a merge that git does not answer waits the same bounded while and is asked again; then the merge is held as "could not be checked"', async t => {
  // Main's head is read, but git answers nothing about the merge itself: each question in turn, and all of them.
  const silent = { commit: async () => undefined }, cases = [silent, { isAncestor: async () => undefined }, { changes: async () => undefined }];
  for (const [index, overrides] of cases.entries()) {
    const f = fixture(t, { reader: reader(overrides) });
    await f.handed(['a']);
    f.clock = LATER;
    const session = answered('tag-1', `MERGED ${commitOf('a')} as ${HEAD2} tests 9/9`);
    assert.deepEqual(await f.settle(session), { kind: 'none', why: 'git-unanswered' }, String(index));
    // The first time is kept with the handoff, as for a head that cannot be read; nothing else is written and nothing is settled while it waits.
    assert.equal(f.handoffs.snapshot().handoff.headUnreadAt, LATER);
    const before = f.bytes();
    f.clock = LATER + HEAD_WAIT_MS - 1;
    assert.deepEqual(await f.settle(session), { kind: 'none', why: 'git-unanswered' });
    assert.deepEqual([f.bytes(), f.looks, f.states()], [before, 0, { a: 'handed' }], 'The handoff keeps its place and the answer is not read afresh');
    // The wait is over: the merge is held as one NAW could not check, which is said as that and not as a claim that failed.
    f.clock = LATER + HEAD_WAIT_MS;
    const result = await f.settle(session);
    assert.deepEqual([outcomes(result), result.notify, result.install, f.looks], [{ a: 'held:main-unreadable' }, ['main-unreadable'], null, 1], String(index));
  }
  // Git answers again within the wait: the merge is checked and recorded as usual.
  const g = fixture(t);
  await g.handed(['a', 'b']);
  let answers = false;
  g.engine.reader = reader({ commit: async value => (answers ? reader().commit(value) : undefined) });
  g.clock = LATER;
  const both = answered('tag-1', `MERGED ${commitOf('a')} as ${HEAD2} tests 9/9\nRETURNED ${commitOf('b')} needs a rebase`);
  assert.deepEqual(await g.settle(both), { kind: 'none', why: 'git-unanswered' });
  assert.deepEqual(g.states(), { a: 'handed', b: 'handed' }, 'The returned delivery waits with it: one answer is settled as a whole');
  answers = true; g.clock = LATER + 60000;
  assert.deepEqual(outcomes(await g.settle(both)), { a: 'merged', b: 'returned:needs a rebase' });
  // One merge git did not answer for and one it confirmed, after the wait: each as it is.
  const h = fixture(t, { reader: reader({ changes: async (base, tip) => (tip === commitOf('a') ? undefined : reader().changes(base, tip)) }) });
  await h.handed(['a', 'b']);
  h.clock = LATER;
  const two = answered('tag-1', `MERGED ${commitOf('a')} as ${HEAD2} tests 9/9\nMERGED ${commitOf('b')} as ${HEAD2} tests 9/9`);
  assert.deepEqual(await h.settle(two), { kind: 'none', why: 'git-unanswered' });
  h.clock = LATER + HEAD_WAIT_MS;
  const mixed = await h.settle(two);
  assert.deepEqual([outcomes(mixed), mixed.install], [{ a: 'held:main-unreadable', b: 'merged' }, { commit: HEAD2 }]);
  // An answered "no" never waits: it is an unverified claim at once.
  const n = fixture(t, { reader: reader({ isAncestor: async () => false }) });
  await n.handed(['a']);
  n.clock = LATER;
  assert.deepEqual(outcomes(await n.settle(answered('tag-1', `MERGED ${commitOf('a')} as ${HEAD2} tests 9/9`))), { a: 'held:merge-unverified' });
  assert.equal(n.handoffs.snapshot().ready[0].state, 'held');
});

test('the person\'s "check again": the claim kept with a merge that could not be checked is asked of git against the main commit of its own handoff', async t => {
  // A handoff whose merge check went unanswered until the wait was over: the delivery is held with what was reported.
  const held = async (f, line = `MERGED ${commitOf('a')} as ${HEAD2} tests 9/9`) => {
    await f.handed(['a']);
    f.engine.reader = reader({ commit: async () => undefined });
    f.clock = LATER + HEAD_WAIT_MS;
    const session = answered('tag-1', line);
    assert.equal((await f.settle(session)).why, 'git-unanswered');
    f.clock = LATER + 2 * HEAD_WAIT_MS;
    assert.deepEqual(outcomes(await f.settle(session)), { a: 'held:main-unreadable' });
    assert.deepEqual(f.handoffs.snapshot().ready[0].claim, { as: HEAD2, tests: line.includes('3/9') ? { passed: 3, total: 9 } : { passed: 9, total: 9 }, startHead: MAIN });
  };
  // Git answers now. Main has moved on since: the merge is still "new", because it is judged against the main commit the handoff began on.
  const f = fixture(t);
  await held(f);
  const asked = [], one = reader({ isAncestor: async (a, b) => b === HEAD3 });
  f.engine.reader = { commit: one.commit, isAncestor: async (a, b) => { asked.push([a, b]); return one.isAncestor(a, b); }, changes: one.changes };
  f.head = HEAD3;
  assert.deepEqual(await f.engine.recheck(key('a')), { outcome: 'merged', notify: [`installable:${HEAD3}`], install: { commit: HEAD3 } });
  assert.deepEqual(asked, [[HEAD2, HEAD3], [HEAD2, MAIN]], 'On main now; not on main when its handoff began');
  const merged = f.handoffs.snapshot().ready[0];
  assert.deepEqual([merged.state, merged.mergedAs, merged.tests, merged.claim], ['merged', HEAD2, { passed: 9, total: 9 }, undefined]);
  // Done once: there is nothing left to check again.
  await assert.rejects(f.engine.recheck(key('a')), { code: 'HANDOFF_STATE', stale: true });
  // Git still does not answer, or main's head cannot be read: nothing changes, and with no head git is not asked at all.
  const g = fixture(t);
  await held(g);
  const before = g.bytes();
  assert.deepEqual(await g.engine.recheck(key('a')), { outcome: 'unanswered', head: true, notify: [], install: null }, 'The head was read; git said nothing about the merge');
  let questions = 0;
  g.engine.reader = reader({ commit: async value => { questions += 1; return reader().commit(value); } });
  for (const unreadable of [null, Error('git failed'), 'main', HEAD2.slice(0, 12)]) {
    g.head = unreadable;
    assert.deepEqual(await g.engine.recheck(key('a')), { outcome: 'unanswered', head: false, notify: [], install: null }, String(unreadable));
  }
  assert.deepEqual([g.bytes(), questions, g.states()], [before, 0, { a: 'held:main-unreadable' }]);
  // Git answers "no": the claim is an unverified one from then on, and is not offered for another check.
  g.head = HEAD2; g.engine.reader = reader({ isAncestor: async () => false });
  assert.deepEqual(await g.engine.recheck(key('a')), { outcome: 'unverified', notify: ['merge-unverified'], install: null });
  assert.deepEqual([g.states(), g.handoffs.snapshot().ready[0].claim], [{ a: 'held:merge-unverified' }, undefined]);
  await assert.rejects(g.engine.recheck(key('a')), { code: 'HANDOFF_STATE', stale: true });
  // While the check is asking git, another step registers a newer main as installable. The check then finishes for the
  // older main it had read: the newer question stands, and the older main is not offered in its place.
  const r = fixture(t);
  await r.handed(['a', 'b']);
  r.engine.reader = reader({ commit: async () => undefined });
  r.clock = LATER + HEAD_WAIT_MS;
  const pair = answered('tag-1', `MERGED ${commitOf('a')} as ${HEAD2} tests 9/9\nMERGED ${commitOf('b')} as ${HEAD2} tests 9/9`);
  await r.settle(pair); r.clock = LATER + 2 * HEAD_WAIT_MS;
  assert.deepEqual(outcomes(await r.settle(pair)), { a: 'held:main-unreadable', b: 'held:main-unreadable' });
  const T1 = LATER + 3 * HEAD_WAIT_MS;
  r.clock = T1; r.head = HEAD2;
  let meanwhile = false;
  r.engine.reader = reader({ commit: async value => {
    if (!meanwhile) { meanwhile = true; r.clock = T1 + 5000; assert.equal(r.handoffs.recheck(r.handoffs.claimOf(key('b')), { verified: true, as: HEAD2 }, HEAD3, T1 + 5000).install.commit, HEAD3); r.clock = T1 + 9000; }
    return reader().commit(value);
  } });
  assert.deepEqual(await r.engine.recheck(key('a')), { outcome: 'merged', notify: [], install: null });
  assert.deepEqual([r.states(), Object.entries(r.handoffs.snapshot().reasons).filter(([name, reason]) => name.startsWith('installable:') && reason.open).map(([name]) => name)], [{ a: 'merged', b: 'merged' }, [`installable:${HEAD3}`]]);
  // A claim whose tests did not all pass can never count: it is settled without asking git.
  const h = fixture(t);
  await h.handed(['a']);
  h.head = null; h.clock = LATER + HEAD_WAIT_MS * 2;
  const failing = answered('tag-1', `MERGED ${commitOf('a')} as ${HEAD2} tests 3/9`);
  await h.settle(failing); h.clock += HEAD_WAIT_MS;
  assert.deepEqual(outcomes(await h.settle(failing)), { a: 'held:main-unreadable' });
  h.head = HEAD2; h.heads = 0;
  h.engine.reader = reader({ commit: async () => { throw Error('git must not be asked'); } });
  assert.deepEqual(await h.engine.recheck(key('a')), { outcome: 'unverified', notify: ['merge-unverified'], install: null });
  assert.equal(h.heads, 0, 'Main\'s head is not read either');
  // With one checked look at the repository, that look's reader and head are the ones asked, once.
  let looks = 0;
  const k = fixture(t, { open: async () => { looks += 1; return { reader: reader(), mainHead: async () => HEAD2 }; }, reader: reader({ commit: async () => { throw Error('The general reader must not be asked'); } }),
    mainHead: async () => { throw Error('The general head must not be read'); } });
  k.engine.intake([space([fact('a')])]);
  const opened = k.handoffs.advance({ ...at(NOW + 10), integrator: INTEGRATOR, session: integratorSession(), mainHead: MAIN, repository: true }, NOW);
  assert.equal(opened.kind, 'open', JSON.stringify(opened));
  k.handoffs.confirmSent(opened.handoffId, { tag: 'tag-1', control: 3 }, NOW);
  const action = k.handoffs.plan({ ...at(LATER, [answered('tag-1', `MERGED ${commitOf('a')} as ${HEAD2} tests 9/9`)]), integrator: INTEGRATOR, session: answered('tag-1', `MERGED ${commitOf('a')} as ${HEAD2} tests 9/9`), repository: true });
  k.handoffs.settle(action, { handoffId: opened.handoffId, mainUnreadable: true }, LATER);
  looks = 0;
  assert.equal((await k.engine.recheck(key('a'))).outcome, 'merged');
  assert.equal(looks, 1);
  // A look that cannot be had is no answer.
  const m = fixture(t, { open: async () => { throw Error('The repository cannot be read now'); } });
  m.engine.intake([space([fact('a')])]);
  const again = m.handoffs.advance({ ...at(NOW + 10), integrator: INTEGRATOR, session: integratorSession(), mainHead: MAIN, repository: true }, NOW);
  m.handoffs.confirmSent(again.handoffId, { tag: 'tag-1', control: 3 }, NOW);
  m.handoffs.settle(m.handoffs.plan({ ...at(LATER), integrator: INTEGRATOR, session: answered('tag-1', `MERGED ${commitOf('a')} as ${HEAD2} tests 9/9`), repository: true }), { handoffId: again.handoffId, mainUnreadable: true }, LATER);
  assert.deepEqual(await m.engine.recheck(key('a')), { outcome: 'unanswered', head: false, notify: [], install: null });
  // Only a delivery held that way can be checked again.
  for (const other of [key('zz'), undefined, 7]) await assert.rejects(m.engine.recheck(other), { code: 'HANDOFF_STATE', stale: true }, String(other));
});

test('a merge made during an earlier handoff of the delivery is held for the person, said as that, and recorded only by the person\'s own step', async t => {
  // The first handoff (main at MAIN) gets no reply and waits; the person has the delivery sent again, by which time main is at HEAD2.
  const twice = async f => {
    const first = await f.handed(['a']);
    f.clock = LATER;
    await f.settle(integratorSession({ messages: [{ id: 'tag-1', role: 'user', text: 'handoff', time: NOW }] }));
    f.handoffs.resolveHandoff(first.handoffId, { retry: true });
    f.head = HEAD2;
    const second = await f.engine.handOut(at(LATER + 9000), async () => at(LATER + 9000));
    assert.deepEqual([second.kind, f.handoffs.snapshot().handoff.mainHead, f.handoffs.snapshot().ready[0].firstHead], ['opened', HEAD2, MAIN], JSON.stringify(second));
    return second;
  };
  const reply = integratorSession({ messages: [{ id: 'tag-2', role: 'user', text: 'handoff', time: LATER + 9000 }, { id: 'r', role: 'assistant', text: `MERGED ${commitOf('a')} as ${HEAD2} tests 9/9`, time: LATER + 9001 }] });
  const settle = f => { const view = at(f.clock, [reply]); return f.engine.settle(view, f.look(view)); };
  // git: the named commit is on main now (HEAD3) and was on the main the second handoff began on (HEAD2), but not on MAIN.
  const earlier = () => reader({ isAncestor: async (a, b) => b === HEAD2 || b === HEAD3 });
  const f = fixture(t);
  await twice(f);
  f.head = HEAD3; f.clock = LATER + 70000; f.engine.reader = earlier();
  const result = await settle(f);
  assert.deepEqual([outcomes(result), result.notify, result.install], [{ a: 'held:merged-earlier' }, ['merged-earlier'], null]);
  assert.deepEqual(f.handoffs.snapshot().ready[0].claim, { as: HEAD2, tests: { passed: 9, total: 9 }, startHead: MAIN });
  // The space and the person are told that it waits for the person; nothing says "merged", and no main is offered for installing.
  f.records.length = 0; f.notices.length = 0;
  await f.engine.tell();
  assert.deepEqual([f.records.map(record => [record.itemId, record.outcome, record.reason, record.as]), f.notices.map(info => [info.reason, info.count])], [[['a', 'held', 'merged-earlier', undefined]], [['merged-earlier', 1]]]);
  assert.deepEqual(Object.keys(f.handoffs.snapshot().reasons).filter(name => name.startsWith('installable:')), []);
  // The person's step: asked of git against the main of the first handoff, and only then recorded.
  const asked = [], one = earlier();
  f.engine.reader = { commit: one.commit, isAncestor: async (a, b) => { asked.push([a, b]); return one.isAncestor(a, b); }, changes: one.changes };
  // "Check again" is another step: it does not act on a delivery that waits for the person's confirmation, and asks git nothing.
  await assert.rejects(f.engine.recheck(key('a')), { code: 'HANDOFF_STATE', stale: true });
  assert.deepEqual([asked, f.states()], [[], { a: 'held:merged-earlier' }]);
  assert.deepEqual(await f.engine.confirm(key('a')), { outcome: 'merged', notify: [`installable:${HEAD3}`], install: { commit: HEAD3 } });
  assert.deepEqual([asked, f.states(), f.handoffs.snapshot().ready[0].mergedAs], [[[HEAD2, HEAD3], [HEAD2, MAIN]], { a: 'merged' }, HEAD2]);
  // The person's step when the merge is no longer in main's history (main was moved back): it does not count, and is said as unverified.
  const g = fixture(t);
  await twice(g);
  g.head = HEAD3; g.clock = LATER + 70000; g.engine.reader = earlier();
  assert.deepEqual(outcomes(await settle(g)), { a: 'held:merged-earlier' });
  g.head = MAIN;
  assert.deepEqual(await g.engine.confirm(key('a')), { outcome: 'unverified', notify: ['merge-unverified'], install: null });
  assert.deepEqual([g.states(), g.handoffs.snapshot().ready[0].claim], [{ a: 'held:merge-unverified' }, undefined]);
  // A merge that could not be checked at first, checked again: found to be an earlier one, it waits for the person and is not recorded by that check.
  const h = fixture(t);
  await twice(h);
  h.head = HEAD3; h.clock = LATER + 70000; h.engine.reader = reader({ commit: async () => undefined });
  assert.equal((await settle(h)).why, 'git-unanswered');
  h.clock += HEAD_WAIT_MS;
  assert.deepEqual(outcomes(await settle(h)), { a: 'held:main-unreadable' });
  h.engine.reader = earlier();
  // (A confirmation is not what this hold waits for.)
  await assert.rejects(h.engine.confirm(key('a')), { code: 'HANDOFF_STATE', stale: true });
  assert.deepEqual(await h.engine.recheck(key('a')), { outcome: 'earlier', notify: ['merged-earlier'], install: null });
  assert.deepEqual([h.states(), h.handoffs.snapshot().ready[0].claim.startHead], [{ a: 'held:merged-earlier' }, MAIN]);
  // A second "check again", from a button that was not drawn anew, does not confirm it.
  await assert.rejects(h.engine.recheck(key('a')), { code: 'HANDOFF_STATE', stale: true });
  assert.deepEqual(h.states(), { a: 'held:merged-earlier' });
  assert.equal((await h.engine.confirm(key('a'))).outcome, 'merged');
});

test('the handoff\'s own session in a space: the engine settles it as waiting without reading the answer or git; an unreadable membership settles nothing', async t => {
  const line = `MERGED ${commitOf('a')} as ${HEAD2} tests 9/9`;
  const untouched = reader({ commit: async () => { throw Error('git must not be asked'); } });
  const f = fixture(t, { reader: untouched });
  await f.handed(['a']);
  f.clock = LATER;
  const member = answered('tag-1', line); member.roomIds = ['shared'];
  const result = await f.settle(member);
  assert.deepEqual([result.kind, result.status, outcomes(result), result.notify, f.heads, f.looks], ['settled', 'waiting', { a: 'waiting:integrator-in-space' }, ['integrator-in-space'], 0, 0]);
  assert.deepEqual([f.handoffs.snapshot().handoff.status, f.handoffs.snapshot().handoff.reason, f.states()], ['waiting', 'integrator-in-space', { a: 'handed' }]);
  // Also while it is still at work, and by the older single-space field.
  const legacy = answered('tag-1', line); delete legacy.roomIds; legacy.roomId = 'shared';
  for (const session of [integratorSession({ state: 'working', roomIds: ['shared'], messages: [{ id: 'tag-1', role: 'user', text: 'handoff', time: NOW }] }), legacy]) {
    const g = fixture(t, { reader: untouched });
    await g.handed(['a']);
    g.clock = LATER;
    assert.deepEqual(outcomes(await g.settle(session)), { a: 'waiting:integrator-in-space' });
  }
  // A membership record that cannot be read says neither yes nor no: nothing is settled, by that look or by the fresh one.
  const h = fixture(t);
  await h.handed(['a']);
  h.clock = LATER;
  const unreadable = { ...answered('tag-1', line), roomIds: 'shared' };
  assert.deepEqual(await h.settle(unreadable), { kind: 'none', why: 'membership-unknown' });
  h.fresh = at(LATER, [unreadable]);
  assert.deepEqual(await h.settle(answered('tag-1', line)), { kind: 'none', why: 'membership-unknown' });
  assert.deepEqual([h.states(), h.handoffs.snapshot().handoff.status], [{ a: 'handed' }, 'sent']);
  // The same for an answer without merges, which is settled from the first look alone.
  const p = fixture(t);
  await p.handed(['a']);
  p.clock = LATER;
  assert.deepEqual(await p.settle({ ...answered('tag-1', `RETURNED ${commitOf('a')} needs a rebase`), roomIds: 'shared' }), { kind: 'none', why: 'membership-unknown' });
  assert.deepEqual([p.states(), p.looks], [{ a: 'handed' }, 0]);
  // It is put into a space while git is being read: the fresh look no longer reads that answer either.
  h.fresh = at(LATER, [member]);
  assert.deepEqual(await h.settle(answered('tag-1', line)), { kind: 'none', why: 'changed-while-checking' });
  h.fresh = undefined;
  assert.deepEqual(outcomes(await h.settle(member)), { a: 'waiting:integrator-in-space' });
  // Another native session under the designated id is not the handoff's session: its spaces say nothing about the handoff, which fails as "gone".
  const k = fixture(t);
  await k.handed(['a']);
  k.clock = LATER;
  const impostor = { ...answered('tag-1', line), nativeId: 'native-other', roomIds: 'unreadable' };
  assert.deepEqual(outcomes(await k.settle(impostor)), { a: 'held:integrator-missing:integrator' });
});

test('with one checked look at the repository per settlement, every git question goes to that look; a repository that cannot be read is an unreadable head, never an unknown commit', async t => {
  const session = answered('tag-1', `MERGED ${commitOf('a')} as ${HEAD2} tests 3/3`);
  // The look is taken once, and its reader and head are the only ones asked: the engine's general reader and head are not.
  const asked = [], untouched = reader({ commit: async () => { throw Error('The general reader must not be asked'); } });
  const one = reader(), counting = { commit: async (...args) => { asked.push('commit'); return one.commit(...args); }, isAncestor: async (...args) => { asked.push('isAncestor'); return one.isAncestor(...args); },
    changes: async (...args) => { asked.push('changes'); return one.changes(...args); } };
  let opened = 0;
  const f = fixture(t, { reader: untouched, open: async () => { opened += 1; return { mainHead: async () => HEAD2, reader: counting }; } });
  await f.handed(['a']);
  f.head = Error('The general head must not be asked');
  const settled = await f.settle(session);
  assert.deepEqual([settled.kind, Object.fromEntries(settled.facts.map(fact => [fact.itemId, fact.outcome])), opened, f.heads], ['settled', { a: 'merged' }, 1, 0]);
  assert.ok(asked.includes('commit') && asked.includes('isAncestor'));
  // No repository that can be read now (none, a failed check, a throw): the answer waits the bounded while for main's head
  // and is then settled as "main could not be read". The merge is never judged against a reader that answers "unknown".
  for (const look of [async () => null, async () => { throw Error('Synthetic check failure'); }, async () => ({ mainHead: async () => null, reader: counting }), async () => ({ mainHead: async () => { throw Error('Synthetic'); }, reader: counting })]) {
    const g = fixture(t, { open: look });
    await g.handed(['a']);
    asked.length = 0;
    assert.deepEqual(await g.settle(session), { kind: 'none', why: 'main-unknown' });
    g.clock = LATER + HEAD_WAIT_MS + 1;
    const late = await g.engine.settle(at(g.clock, [session]), g.look(at(g.clock, [session])));
    assert.deepEqual([late.kind, Object.fromEntries(late.facts.map(fact => [fact.itemId, fact.outcome + ':' + fact.reason])), asked], ['settled', { a: 'held:main-unreadable' }, []]);
  }
});

test('each delivery\'s space is told once where the delivery stands, and again only when that changes', async t => {
  const f = fixture(t);
  f.engine.intake([space([fact('a'), fact('b'), fact('c')])]);
  assert.deepEqual(await f.engine.tell(), { shown: 0, told: [], unknown: [] }, 'A delivery that only waits has nothing to say beyond its own READY record');
  const opened = await f.handed(['a', 'b', 'c']);
  assert.equal((await f.engine.tell()).shown, 3);
  assert.deepEqual(f.records.map(record => [record.itemId, record.outcome, record.label, record.handoffId]), ['a', 'b', 'c'].map(name => [name, 'handed', `handed:${opened.handoffId}`, opened.handoffId]));
  const one = f.records[0];
  assert.deepEqual([one.key, one.roomId, one.branch, one.commit, one.memberId, one.memberName, one.text], [key('a'), 'space-1', 'lane/a', commitOf('a'), 'member-a', 'Member a', 'Private task text of a']);
  assert.equal((await f.engine.tell()).shown, 0); assert.equal(f.records.length, 3);
  // After the answer: one record per delivery for its outcome.
  const reply = `MERGED ${commitOf('a')} as ${HEAD2} tests 9/9 review r-1\nRETURNED ${commitOf('b')} needs a rebase\nHELD ${commitOf('c')} review-off (reviews are off)`;
  await f.settle(answered('tag-1', reply));
  f.records.length = 0;
  assert.equal((await f.engine.tell()).shown, 3);
  assert.deepEqual(f.records.map(record => [record.itemId, record.outcome, record.label, record.reason, record.as, record.note]), [
    ['a', 'merged', `merged:${HEAD2}`, undefined, HEAD2, undefined], ['b', 'returned', 'returned', undefined, undefined, 'needs a rebase'], ['c', 'held', 'held:review-off', 'review-off', undefined, 'review-off (reviews are off)']]);
  assert.deepEqual([f.records[0].tests, f.records[0].review], [{ passed: 9, total: 9 }, 'r-1']);
  for (let pass = 0; pass < 3; pass += 1) assert.equal((await f.engine.tell()).shown, 0);
  assert.equal(new IntegrationHandoffs(f.directory).showable().length, 0, 'Also after a restart');
  // Retried and handed again: a new record for the new handoff; while it only waits again, nothing.
  f.handoffs.retryReady(key('c'));
  assert.equal((await f.engine.tell()).shown, 0);
  f.head = MAIN;
  const second = await f.engine.handOut(at(LATER + 5), async () => at(LATER + 5));
  f.records.length = 0; await f.engine.tell();
  assert.deepEqual(f.records.map(record => [record.itemId, record.label]), [['c', `handed:${second.handoffId}`]]);
  // A handoff that waits for the person: its deliveries say so, with the reason.
  await f.settle(integratorSession({ messages: [{ id: 'tag-2', role: 'user', text: 'handoff', time: NOW }] }));
  f.records.length = 0; await f.engine.tell();
  assert.deepEqual(f.records.map(record => [record.itemId, record.outcome, record.reason, record.label]), [['c', 'waiting', 'no-reply', `waiting:${second.handoffId}:no-reply`]]);
});

test('a space always ends up saying where the delivery stands now; a state passed through between two tellings is not told', async t => {
  const f = fixture(t);
  await f.handed(['a']);
  // Nothing was told while it was handed out (the writer was down, say); by the next telling it is merged.
  await f.settle(answered('tag-1', `MERGED ${commitOf('a')} as ${HEAD2} tests 9/9`));
  assert.equal((await f.engine.tell()).shown, 1);
  assert.deepEqual(f.records.map(record => [record.itemId, record.outcome]), [['a', 'merged']]);
});

test('a writer that answers later is waited for, and its failure keeps the record for a later pass', async t => {
  const f = fixture(t);
  await f.handed(['a', 'b', 'c']);
  let calls = 0;
  f.recording = async fact => { calls += 1; await new Promise(resolve => setImmediate(resolve)); if (calls === 2) throw Error('space record unavailable'); f.records.push(fact); };
  assert.equal((await f.engine.tell()).shown, 1);
  assert.deepEqual([f.records.map(record => record.itemId), f.handoffs.showable().map(record => record.itemId)], [['a'], ['b', 'c']]);
  assert.equal((await f.engine.tell()).shown, 2);
  assert.deepEqual(f.records.map(record => record.itemId), ['a', 'b', 'c']);
});

test('a space record that could not be written is written on a later pass; a crash before it is marked writes the same record again', async t => {
  const f = fixture(t);
  const opened = await f.handed(['a', 'b', 'c']);
  // The writer fails at the second record: the first is kept as written, the rest wait.
  let calls = 0;
  f.recording = fact => { calls += 1; if (calls === 2) throw Error('space record unavailable'); f.records.push(fact); };
  assert.equal((await f.engine.tell()).shown, 1);
  assert.deepEqual(f.records.map(record => record.itemId), ['a']);
  f.recording = fact => { f.records.push(fact); };
  assert.equal((await f.engine.tell()).shown, 2);
  assert.deepEqual(f.records.map(record => record.itemId), ['a', 'b', 'c']);
  // The record was written but the app stopped before marking it: after the restart the same key and label come again.
  const g = fixture(t);
  await g.handed(['a']);
  const written = g.handoffs.showable();
  const restarted = new IntegrationHandoffs(g.directory);
  assert.deepEqual(restarted.showable(), written);
  assert.deepEqual(written.map(record => [record.key, record.label]), [[key('a'), `handed:${g.sent[0]}`]]);
  // Marking is exact: only the delivery's current label counts, once.
  assert.deepEqual(restarted.markShown([{ key: key('a'), label: 'handed:H9-other' }, { key: key('zz'), label: written[0].label }, { key: key('a') }, null, { key: key('a'), label: 'x'.repeat(501) }]), { marked: 0 });
  assert.deepEqual(restarted.markShown('nothing'), { marked: 0 });
  assert.deepEqual(restarted.markShown(written), { marked: 1 });
  assert.deepEqual(restarted.markShown(written), { marked: 0 });
  assert.equal(restarted.showable().length, 0);
  // A label kept in the record that is not text is a record no start accepts.
  const state = restarted.snapshot();
  fs.writeFileSync(g.file, JSON.stringify({ ...state, ready: state.ready.map(entry => ({ ...entry, shown: 7 })) }), { mode: 0o600 });
  assert.throws(() => new IntegrationHandoffs(g.directory).snapshot(), { code: 'HANDOFF_STATE' });
  assert.equal(opened.kind, 'opened');
});

test('the person is told once per reason, with a count and a place, never with task text', async t => {
  const f = fixture(t);
  await f.handed(['a', 'b', 'c']);
  await f.settle(answered('tag-1', `HELD ${commitOf('a')} review-off\nHELD ${commitOf('b')} review-off\nMERGED ${commitOf('c')} as ${HEAD2} tests 9/9`));
  // One more delivery waits to be handed out: it belongs to neither notice below.
  f.engine.intake([space([fact('a'), fact('b'), fact('c'), fact('d')])]);
  const told = await f.engine.tell();
  assert.deepEqual([told.told, told.unknown], [['review-off', `installable:${HEAD2}`], []]);
  assert.deepEqual(f.notices, [{ reason: 'review-off', count: 2, roomId: 'space-1', itemId: 'a' }, { reason: `installable:${HEAD2}`, count: 0, roomId: null, itemId: null }]);
  assert.ok(!JSON.stringify(f.notices).includes('Private task text'));
  // Never twice, also after a restart; one more delivery under the same condition tells nobody.
  for (let pass = 0; pass < 2; pass += 1) assert.deepEqual((await f.engine.tell()).told, []);
  assert.deepEqual(new IntegrationHandoffs(f.directory).pendingNotices(), []);
  f.engine.intake([space([fact('a'), fact('b'), fact('c'), fact('d')])]); f.handoffs.hold(key('d'), 'review-off', NOW);
  assert.deepEqual((await f.engine.tell()).told, []); assert.equal(f.notices.length, 2);
  // A handoff that waits names the integrator's session, where its question can be read.
  f.engine.intake([space([fact('e')])]); f.head = MAIN;
  await f.engine.handOut(at(LATER + 5), async () => at(LATER + 5));
  await f.settle(integratorSession({ messages: [{ id: 'tag-2', role: 'user', text: 'handoff', time: NOW }, { id: 'r', role: 'assistant', text: '需要你决定：e 和别的冲突', time: NOW + 1 }] }));
  f.notices.length = 0;
  const waiting = await f.engine.tell();
  assert.equal(waiting.told.length, 1); assert.match(waiting.told[0], /^conflict:H2-/);
  assert.deepEqual(f.notices, [{ reason: waiting.told[0], count: 1, roomId: 'space-1', itemId: 'e', sessionId: 'integrator' }]);
  // A handoff that waits with nothing left inside still tells the person, and says where to read the question.
  const d = fixture(t);
  await d.handed(['a']);
  await d.settle(answered('tag-1', `需要你决定：要不要现在装\nRETURNED ${commitOf('a')} needs a rebase`));
  await d.engine.tell();
  assert.equal(d.notices.length, 1);
  assert.deepEqual([d.notices[0].count, d.notices[0].roomId, d.notices[0].sessionId], [0, null, 'integrator']);
  // The person's own typing in the integrator's session is recorded but not announced to them.
  const g = fixture(t);
  await g.handed(['a']);
  await g.settle(integratorSession({ messages: [{ id: 'tag-1', role: 'user', text: 'handoff', time: NOW }, { id: 'u', role: 'user', text: 'stop', time: NOW + 1 }] }));
  assert.deepEqual([(await g.engine.tell()).told, g.notices], [[], []]);
  // A condition with no deliveries under it counts what waits to be handed out.
  const h = fixture(t, { designation: () => null });
  h.engine.intake([space([fact('a'), fact('b')])]);
  await h.engine.handOut(at(NOW + 10), async () => at(NOW + 10));
  await h.engine.tell();
  assert.deepEqual(h.notices, [{ reason: 'integrator-unset', count: 2, roomId: 'space-1', itemId: 'a' }]);
  assert.equal(h.handoffs.noticeInfo('never-heard-of'), null);
});

test('a notice that may not have been shown is not shown again and is reported as unknown', async t => {
  const f = fixture(t);
  await f.handed(['a', 'b']);
  await f.settle(answered('tag-1', `HELD ${commitOf('a')} review-off\nHELD ${commitOf('b')} checkpoint-invalid`));
  // The first notice fails while being shown; the second goes out.
  f.notifying = async info => { if (info.reason === 'review-off') throw Error('notification failed'); f.notices.push(info); };
  assert.deepEqual(await f.engine.tell(), { shown: 2, told: ['checkpoint-invalid'], unknown: ['review-off'] });
  f.notifying = async info => { f.notices.push(info); };
  for (let pass = 0; pass < 3; pass += 1) assert.deepEqual(await f.engine.tell(), { shown: 0, told: [], unknown: ['review-off'] });
  assert.deepEqual(f.notices.map(info => info.reason), ['checkpoint-invalid']);
  // The app stopped between "started" and "shown": after the restart it is unknown, not sent.
  const g = fixture(t);
  await g.handed(['a']);
  await g.settle(answered('tag-1', `HELD ${commitOf('a')} review-off`));
  assert.deepEqual(g.handoffs.reserveNotice('review-off'), { reserved: true });
  const restarted = new IntegratorEngine({ handoffs: new IntegrationHandoffs(g.directory), now: () => NOW, designation: () => INTEGRATOR, mainHead: async () => MAIN, send: async () => 'x',
    record: () => {}, notify: async info => { g.notices.push(info); } });
  assert.deepEqual(await restarted.tell(), { shown: 1, told: [], unknown: ['review-off'] });
  assert.deepEqual(g.notices, []);
});

// The app's bound on how long a question to git is waited for, as the main process gives it to the engine.
const within = (answer, ms, late) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => resolve(late), ms);
  answer.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

// (A pass that waited for git after all would never end here: the test gives up after twenty seconds.)
test('one pass waits for git only so long in all: what it cut off counts as unanswered and is asked again by later passes, and the person\'s own check waits as long as it takes', { timeout: 20000 }, async t => {
  const never = new Promise(() => {});
  const merged = (tag, ...names) => answered(tag, names.map(name => `MERGED ${commitOf(name)} as ${HEAD2} tests 9/9`).join('\n'));
  const pass = (f, session, rooms = []) => { const view = at(f.clock, [session]); return f.engine.pass(rooms, view, f.look(view)); };
  // A reader whose commit lookups are answered only when the test lets them go.
  let release;
  const gate = new Promise(resolve => { release = resolve; }), asked = [];
  const slow = reader({ commit: async value => { asked.push(value); await gate; return reader().commit(value); } });
  const f = fixture(t, { within, gitAllowanceMs: 40, reader: slow });
  await f.handed(['a']);
  f.clock = LATER;
  // Git does not answer the first question about the merge. The pass does not wait for it: the answer stays unsettled, as
  // when git fails to answer, and nothing more is asked in that pass (not the merge's second commit).
  const rooms = [space([fact('a'), fact('b')])];
  const first = await pass(f, merged('tag-1', 'a'), rooms);
  assert.deepEqual([first.settled, first.handed.why, asked, f.heads, f.states()], [{ kind: 'none', why: 'git-unanswered' }, 'handoff-open', [HEAD2], 1, { a: 'handed', b: 'deliverable' }]);
  // The next pass has an allowance of its own and asks again.
  const second = await pass(f, merged('tag-1', 'a'), rooms);
  assert.deepEqual([second.settled, asked, f.heads], [{ kind: 'none', why: 'git-unanswered' }, [HEAD2, HEAD2], 2]);
  // When the bounded wait is over the merge is held with what was reported. The allowance of that pass is used up by then,
  // so main's head is not asked for the delivery that arrived meanwhile: it is handed out by the pass after.
  f.clock = LATER + HEAD_WAIT_MS;
  const third = await pass(f, merged('tag-1', 'a'), rooms);
  assert.deepEqual([third.settled.kind, outcomes(third.settled), third.settled.install, f.handoffs.snapshot().ready[0].claim],
    ['settled', { a: 'held:main-unreadable' }, null, { as: HEAD2, tests: { passed: 9, total: 9 }, startHead: MAIN }]);
  assert.deepEqual([asked.length, f.heads, third.handed, f.sent.length], [3, 3, { kind: 'none', why: 'main-unknown', released: [] }, 1]);
  f.head = MAIN;
  const fourth = await pass(f, integratorSession(), rooms);
  assert.deepEqual([fourth.handed.kind, fourth.handed.keys, f.sent.length], ['opened', [key('b')], 2]);
  // The person's own check is no part of a pass: it waits for git, however long that takes, and records the merge.
  f.head = HEAD2;
  let finished = false;
  const check = f.engine.recheck(key('a')).then(value => { finished = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(finished, false, 'Several allowances later it still waits');
  release();
  assert.equal((await check).outcome, 'merged');

  // Answered for one merge and not for the other: nothing is settled while the wait lasts; then each as it is.
  const base = reader();
  const g = fixture(t, { within, gitAllowanceMs: 40, reader: reader({ changes: async (start, tip) => (tip === commitOf('b') ? never : base.changes(start, tip)) }) });
  await g.handed(['a', 'b']);
  g.clock = LATER;
  assert.deepEqual([(await pass(g, merged('tag-1', 'a', 'b'))).settled, g.states()], [{ kind: 'none', why: 'git-unanswered' }, { a: 'handed', b: 'handed' }]);
  g.clock = LATER + HEAD_WAIT_MS;
  const mixed = await pass(g, merged('tag-1', 'a', 'b'));
  assert.deepEqual([outcomes(mixed.settled), mixed.settled.install], [{ a: 'merged', b: 'held:main-unreadable' }, { commit: HEAD2 }]);

  // Ancestry is a question like the others.
  const anc = fixture(t, { within, gitAllowanceMs: 40, reader: reader({ isAncestor: () => never }) });
  await anc.handed(['a']);
  anc.clock = LATER;
  assert.deepEqual((await pass(anc, merged('tag-1', 'a'))).settled, { kind: 'none', why: 'git-unanswered' });

  // Main's head is not answered in time, by the engine's own reader or by a checked look at the repository: an unread
  // head, which waits the bounded while and is then settled as "main could not be read". The reader is never asked.
  for (const look of [false, true]) {
    const refuse = reader({ commit: async () => { throw Error('The reader must not be asked'); } });
    const h = fixture(t, { within, gitAllowanceMs: 40, reader: refuse, ...(look ? { open: () => never } : {}) });
    await h.handed(['a']);
    if (!look) h.head = never;
    h.clock = LATER;
    assert.deepEqual((await pass(h, merged('tag-1', 'a'))).settled, { kind: 'none', why: 'main-unknown' }, String(look));
    h.clock = LATER + HEAD_WAIT_MS;
    const unread = await pass(h, merged('tag-1', 'a'));
    assert.deepEqual([unread.settled.kind, outcomes(unread.settled), h.handoffs.snapshot().ready[0].claim], ['settled', { a: 'held:main-unreadable' }, { as: HEAD2, tests: { passed: 9, total: 9 }, startHead: MAIN }], String(look));
  }

  // Handing out: main's head not answered in time opens nothing and sends nothing; the delivery waits for a later pass.
  const o = fixture(t, { within, gitAllowanceMs: 40 });
  o.head = never;
  const waiting = await pass(o, integratorSession(), [space([fact('a')])]);
  assert.deepEqual([waiting.handed, o.sent.length, o.handoffs.summary().handoff], [{ kind: 'none', why: 'main-unknown', released: [] }, 0, null]);
  o.head = MAIN;
  assert.equal((await pass(o, integratorSession(), [space([fact('a')])])).handed.kind, 'opened');

  // The second look at a merge that is not new for this handoff (was it made earlier?) cut off by the allowance: that is
  // not git's "no". The merge is not called "not found": it counts as unanswered, and in the end is held with its claim.
  // The person's check, which waits for git, then finds the earlier merge.
  const twice = async (options = {}) => {
    const k = fixture(t, { within, gitAllowanceMs: 40, ...options });
    const opened = await k.handed(['a']);
    k.clock = LATER;
    await k.settle(integratorSession({ messages: [{ id: 'tag-1', role: 'user', text: 'handoff', time: NOW }] }));
    k.handoffs.resolveHandoff(opened.handoffId, { retry: true });
    k.head = HEAD2;
    assert.equal((await k.engine.handOut(at(LATER + 9000), async () => at(LATER + 9000))).kind, 'opened');
    k.head = HEAD3; k.clock = LATER + 70000;
    return k;
  };
  const reply = integratorSession({ messages: [{ id: 'tag-2', role: 'user', text: 'handoff', time: LATER + 9000 }, { id: 'r', role: 'assistant', text: `MERGED ${commitOf('a')} as ${HEAD2} tests 9/9`, time: LATER + 9001 }] });
  // git: the named commit is on main now and was on the main this handoff began on; whether it was on the first main is never answered.
  const cut = await twice({ reader: reader({ isAncestor: (a, b) => (b === MAIN ? never : Promise.resolve(b === HEAD2 || b === HEAD3)) }) });
  assert.deepEqual((await pass(cut, reply)).settled, { kind: 'none', why: 'git-unanswered' });
  cut.clock += HEAD_WAIT_MS;
  const held = await pass(cut, reply);
  assert.deepEqual([outcomes(held.settled), cut.handoffs.snapshot().ready[0].claim], [{ a: 'held:main-unreadable' }, { as: HEAD2, tests: { passed: 9, total: 9 }, startHead: HEAD2 }]);
  cut.engine.reader = reader({ isAncestor: async (a, b) => b === HEAD2 || b === HEAD3 });
  assert.deepEqual([(await cut.engine.recheck(key('a'))).outcome, cut.states()], ['earlier', { a: 'held:merged-earlier' }]);
  // The same when the time was simply over before the second look could be asked (no question had to be given up).
  let used = 0;
  const over = await twice({ elapsed: () => used, reader: reader({ isAncestor: async (a, b) => { if (b === HEAD2) used = 1000; return b === HEAD2 || b === HEAD3; } }) });
  assert.deepEqual([(await pass(over, reply)).settled, over.states()], [{ kind: 'none', why: 'git-unanswered' }, { a: 'handed' }]);
  // The same second look when git itself says quickly that it cannot answer (the first commit is gone, say) and the
  // allowance is not used up: the strict verdict stands, as it did.
  const gone = await twice({ gitAllowanceMs: 5000, reader: reader({ isAncestor: async (a, b) => (b === MAIN ? undefined : b === HEAD2 || b === HEAD3) }) });
  assert.deepEqual(outcomes((await pass(gone, reply)).settled), { a: 'held:merge-unverified' });

  // Git that says quickly that it cannot answer has used up nothing: that waits the bounded while and is asked again, as before.
  const q = fixture(t, { within, gitAllowanceMs: 5000, reader: reader({ commit: async () => undefined }) });
  await q.handed(['a']);
  q.clock = LATER;
  assert.deepEqual((await pass(q, merged('tag-1', 'a'))).settled, { kind: 'none', why: 'git-unanswered' });
  assert.deepEqual(q.states(), { a: 'handed' });

  // An answer that fails after the pass gave it up troubles nobody, also when the bound that was supplied does not look at it again.
  const unhandled = [], note = reason => unhandled.push(reason);
  process.on('unhandledRejection', note);
  t.after(() => process.off('unhandledRejection', note));
  for (const careless of [false, true]) {
    let fail;
    const failing = new Promise((_, reject) => { fail = reject; });
    // (The careless bound only counts the time: it never looks at the answer, so it takes no failure upon itself.)
    const bound = careless ? (answer, ms, late) => new Promise(resolve => { setTimeout(() => resolve(late), ms); }) : within;
    const m = fixture(t, { within: bound, gitAllowanceMs: 40, reader: reader({ commit: () => failing }) });
    await m.handed(['a']);
    if (careless) m.head = failing;
    m.clock = LATER;
    assert.deepEqual((await pass(m, merged('tag-1', 'a'))).settled, { kind: 'none', why: careless ? 'main-unknown' : 'git-unanswered' });
    fail(Error('git failed after it was given up'));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.deepEqual(unhandled, []);

  // Without a bound from the app, a question that was asked is waited for; but once the allowance is over nothing more is asked.
  let ticks = 0;
  const later = [];
  const n = fixture(t, { gitAllowanceMs: 10, elapsed: () => ticks, reader: reader({ commit: async value => { later.push(value); ticks += 100; return reader().commit(value); } }) });
  await n.handed(['a']);
  n.clock = LATER;
  assert.deepEqual([(await pass(n, merged('tag-1', 'a'))).settled, later], [{ kind: 'none', why: 'git-unanswered' }, [HEAD2]]);
  // And once a question was given up, nothing more is asked in that pass even if the clock says a moment is left
  // (a timer may run out a little before the clock it is compared with).
  let bounds = 0;
  const early = [];
  const e = fixture(t, { gitAllowanceMs: 40, elapsed: () => 0, within: async (answer, ms, late) => ((bounds += 1) === 2 ? late : answer),
    reader: reader({ commit: async value => { early.push(value); return reader().commit(value); } }) });
  await e.handed(['a']);
  e.clock = LATER;
  assert.deepEqual([(await pass(e, merged('tag-1', 'a'))).settled, early], [{ kind: 'none', why: 'git-unanswered' }, [HEAD2]]);

  // A direct call (no pass) has no allowance.
  const direct = fixture(t, { within, gitAllowanceMs: 40, reader: slow });
  await direct.handed(['a']);
  direct.clock = LATER;
  assert.deepEqual(outcomes(await direct.settle(merged('tag-1', 'a'))), { a: 'merged' }, 'The gate was opened above: a direct call simply asks and waits');
  assert.equal(require('../integrator-engine.cjs').GIT_ALLOWANCE_MS, 15000);
});

test('one whole pass takes in, settles, hands out and tells, in that order; an unreadable record stops it', async t => {
  const f = fixture(t);
  await f.handed(['a']);
  // The integrator has answered, and meanwhile another delivery arrived.
  const session = answered('tag-1', `MERGED ${commitOf('a')} as ${HEAD2} tests 9/9`);
  const view = at(LATER, [session]);
  const result = await f.engine.pass([space([fact('a'), fact('b')])], view, f.look(view));
  assert.equal(result.kind, 'passed');
  assert.deepEqual(result.taken.stored, [key('b')]);
  assert.deepEqual([result.settled.kind, outcomes(result.settled)], ['settled', { a: 'merged' }]);
  assert.deepEqual([result.handed.kind, result.handed.keys], ['opened', [key('b')]], 'The place the first handoff left is taken by the next in the same pass');
  assert.deepEqual(f.records.map(record => [record.itemId, record.outcome]), [['a', 'merged'], ['b', 'handed']]);
  assert.deepEqual(result.told.told, [`installable:${HEAD2}`]);
  assert.deepEqual(f.states(), { a: 'merged', b: 'handed' });
  assert.equal(f.sent.length, 2);
  // A pass with nothing to do changes nothing.
  const before = f.bytes(), idle = at(LATER + 100, [integratorSession({ state: 'working' })]);
  const quiet = await f.engine.pass([space([fact('a'), fact('b')])], idle, f.look(idle));
  assert.deepEqual([quiet.taken.stored, quiet.settled.why, quiet.handed.why, quiet.told], [[], 'integrator-working', 'handoff-open', { shown: 0, told: [], unknown: [] }]);
  assert.equal(f.bytes(), before);
  // The record cannot be read: nothing is done and the caller is told so, without an exception.
  fs.writeFileSync(f.file, '{', { mode: 0o600 });
  const broken = new IntegratorEngine({ handoffs: new IntegrationHandoffs(f.directory), now: () => NOW, designation: () => INTEGRATOR, mainHead: async () => MAIN,
    send: async () => { f.sent.push('x'); return 'x'; }, record: fact => f.records.push(fact), notify: async info => f.notices.push(info) });
  assert.deepEqual(await broken.pass([space([fact('c')])], view, f.look(view)), { kind: 'unreadable' });
  assert.equal(f.sent.length, 2); assert.equal(fs.readFileSync(f.file, 'utf8'), '{');
  // A failure that is not the record's own is not swallowed, and it does not keep a notice from going out.
  const g = fixture(t, { reader: reader({ commit: async () => { throw Error('Unexpected reader failure'); } }) });
  await g.handed(['a']);
  const stuck = at(LATER, [answered('tag-1', `MERGED ${commitOf('a')} as ${HEAD2} tests 9/9`)]);
  // The settling fails on every pass (a fault in the reader); what the spaces are owed is still told.
  await assert.rejects(g.engine.pass([], stuck, g.look(stuck)), error => /Unexpected reader failure/.test(error.message) && error.done.taken.stored.length === 0 && error.done.told.shown === 1);
  assert.deepEqual(g.records.map(record => [record.itemId, record.outcome]), [['a', 'handed']], 'The telling still happened');
  // The record breaks in the middle of a pass: the caller is told so, with what the pass had done by then.
  const h = fixture(t);
  h.engine.intake([]);
  const view2 = at(NOW + 10);
  const half = await h.engine.pass([space([fact('a')])], view2, async () => { fs.chmodSync(h.directory, 0o500); return view2; });
  fs.chmodSync(h.directory, 0o700);
  assert.deepEqual([half.kind, half.taken.stored, half.settled], ['unreadable', [key('a')], { kind: 'none', why: 'no-handoff' }]);
  assert.equal(half.handed, undefined); assert.equal(h.sent.length, 0);
});
