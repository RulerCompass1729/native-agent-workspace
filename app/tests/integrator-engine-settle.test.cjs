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
const MAIN = 'a'.repeat(40), HEAD2 = 'b'.repeat(40);
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
