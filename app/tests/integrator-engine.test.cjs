const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const rules = require('../queue-dispatch.cjs');
const { RoomState } = require('../room-state.cjs');
const { IntegrationHandoffs, FILE, OPEN_LIMIT } = require('../integrator-handoff.cjs');
const { IntegratorEngine } = require('../integrator-engine.cjs');

// Handing delivered work to the integrator (B6 E2b, checkpoint H4). Synthetic spaces and sessions; the
// send, the designation and main's head are stand-ins. No model, no message, no git, no lock.
const NOW = 1_800_000_000_000;
const MAIN = 'a'.repeat(40);
const INTEGRATOR = { sessionId: 'integrator', nativeId: 'native-integrator' };
const OTHER_SPACE = 'abcdef01-2345-4678-9abc-def012345678';
const commitOf = name => (name.charCodeAt(0).toString(16).padStart(2, '0')).repeat(20);
const key = (name, room = 'space-1') => `ready:${room}:${name}`;
// A READY fact as NAW writes it into a space's record.
function fact(name, extra = {}, room = 'space-1') {
  const branch = extra.branch || `lane/${name}`, commit = extra.commit || commitOf(name);
  return { id: `event-${room}-${name}`, role: 'system', kind: 'queue', time: NOW + 1, sessionId: `member-${name}`,
    uiMessage: { version: 1, key: 'notice.queue.ready', params: { name: `Member ${name}`, text: `Task ${name}`, branch, commit: commit.slice(0, 12) } },
    monitor: { kind: 'ready', key: key(name, room), itemId: name, branch, commit }, ...extra.event };
}
const space = (events, id = 'space-1', name = 'Space one') => ({ id, name, events });
function integratorSession(extra = {}) {
  return { id: INTEGRATOR.sessionId, nativeId: INTEGRATOR.nativeId, provider: 'claude', state: 'idle', background: 0, scheduled: 0, backgroundStale: false,
    chatAvailable: true, liveDraft: '', controlRevision: 3, serviceCapabilities: [rules.CAPABILITY], fleet: [], messages: [], roomIds: [], ...extra };
}
function view(extra = {}) {
  return { sessions: [integratorSession()], complete: true, wakePolicy: { enabled: true }, now: NOW + 10,
    idleSince: new Map([[INTEGRATOR.sessionId, NOW + 10 - rules.IDLE_SETTLE_MS]]), humanAt: new Map(), ...extra };
}
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-engine-'));
  t.after(() => { try { fs.chmodSync(directory, 0o700); } catch {} fs.rmSync(directory, { recursive: true, force: true }); });
  const handoffs = new IntegrationHandoffs(directory);
  const f = { directory, file: path.join(directory, FILE), handoffs, designated: INTEGRATOR, head: MAIN, sent: [], heads: 0, looks: 0, fresh: undefined,
    sending: async () => ({ tag: `tag-${f.sent.length}`, control: 3 }) };
  f.engine = new IntegratorEngine({ handoffs, now: () => NOW,
    designation: () => { if (f.designated instanceof Error) throw f.designated; return f.designated; },
    mainHead: async () => { f.heads += 1; if (f.head instanceof Error) throw f.head; return f.head; },
    send: async (session, text, handoffId) => { f.sent.push({ sessionId: session.id, nativeId: session.nativeId, text, handoffId, recorded: handoffs.summary() }); return f.sending(session, text, handoffId); },
    ...options });
  // The fresh look returns the given view unless a test sets another one (or null).
  f.handOut = current => f.engine.handOut(current, async () => { f.looks += 1; if (f.fresh instanceof Error) throw f.fresh; return f.fresh === undefined ? current : f.fresh; });
  f.states = () => Object.fromEntries(handoffs.snapshot().ready.map(entry => [entry.itemId, entry.state + (entry.reason ? ':' + entry.reason : '')]));
  f.bytes = () => (fs.existsSync(f.file) ? fs.readFileSync(f.file, 'utf8') : '');
  return f;
}
const refusal = (extra = {}) => Object.assign(Error('not sent'), { notSent: true, ...extra });

test('deliveries recorded in spaces are taken in once; what is older than the record, or not this space\'s own fact, is not', t => {
  const f = fixture(t);
  // The first intake sets the starting line and takes what was recorded from then on.
  const old = fact('o', { event: { time: NOW - 1 } }), a = fact('a'), b = fact('b', { event: { time: NOW } });
  assert.deepEqual(f.engine.intake([space([old, a, b])]), { stored: [key('a'), key('b')], superseded: [], skipped: 0, full: false });
  assert.equal(f.handoffs.summary().since, NOW);
  assert.deepEqual(f.states(), { a: 'deliverable', b: 'deliverable' });
  const taken = f.handoffs.snapshot().ready[0];
  assert.deepEqual([taken.roomId, taken.branch, taken.commit, taken.memberId, taken.memberName, taken.spaceName, taken.text, taken.notedAt],
    ['space-1', 'lane/a', commitOf('a'), 'member-a', 'Member a', 'Space one', 'Task a', NOW + 1]);
  // The same facts again change nothing and write nothing; neither does a later start of the engine.
  const before = f.bytes();
  assert.deepEqual(f.engine.intake([space([old, a, b])]), { stored: [], superseded: [], skipped: 0, full: false });
  const again = new IntegratorEngine({ handoffs: new IntegrationHandoffs(f.directory), now: () => NOW + 99999, designation: () => null, mainHead: async () => MAIN, send: async () => ({}) });
  assert.deepEqual(again.intake([space([old, a, b])]).stored, []);
  assert.equal(f.bytes(), before);
  assert.equal(new IntegrationHandoffs(f.directory).summary().since, NOW, 'The starting line is set once');
  // Facts that are not what NAW writes for this space are passed over and counted.
  const foreign = fact('f', {}, 'space-2'), strange = [
    { ...fact('g'), monitor: { ...fact('g').monitor, branch: '--upload-pack=x' } }, { ...fact('h'), monitor: { ...fact('h').monitor, commit: 'main' } },
    { ...fact('i'), monitor: { ...fact('i').monitor, key: 'ready:space-1:other' } }, { ...fact('j'), time: undefined }, { ...fact('k'), monitor: { ...fact('k').monitor, itemId: 7 } }, foreign];
  const others = [{ id: 'e1', role: 'system', kind: 'queue', time: NOW + 2, monitor: { kind: 'queue-dry', key: 'x' } }, { id: 'e2', role: 'user', text: 'READY lane/x abcdef1', time: NOW + 2 }, null];
  assert.deepEqual(f.engine.intake([space([...strange, ...others]), null, { id: 'space-3' }, { events: [fact('z')] }]), { stored: [], superseded: [], skipped: 6, full: false });
  assert.equal(f.bytes(), before);
  // The same item name in another space is that space's own delivery.
  assert.deepEqual(f.engine.intake([space([foreign], 'space-2', 'Space two')]).stored, [key('f', 'space-2')]);
  // A newer delivery of a branch replaces the waiting one of the same space.
  assert.deepEqual(f.engine.intake([space([a, b, fact('a2', { branch: 'lane/a', event: { time: NOW + 5 } })])]), { stored: [key('a2')], superseded: [key('a')], skipped: 0, full: false });
  assert.deepEqual(f.states(), { a: 'superseded', b: 'deliverable', f: 'deliverable', a2: 'deliverable' });
});

test('the fact the real space record writes for a finished queue item is the one the engine takes in', t => {
  const f = fixture(t);
  const room = new RoomState(f.directory);
  // Space events are stamped with the real clock, so this engine's clock is the real one too.
  const live = new IntegratorEngine({ handoffs: f.handoffs, designation: () => null, mainHead: async () => MAIN, send: async () => ({}) });
  live.intake([]);   // the record begins before the item is delivered
  const itemId = room.queueAdd('Synthetic task with a long name', null);
  room.queueMarkSent('shared', itemId, 'member-a', 'Synthetic member', NOW + 5);
  room.queueSetDelivery('shared', itemId, 'tag-a', 0);
  const ready = { branch: 'lane/synthetic', commit: commitOf('s') };
  room.queueSettle('shared', itemId, 'done', '', 'Synthetic member', 'READY lane/synthetic ' + commitOf('s'), undefined, ready);
  const recorded = room.metadata('shared');
  assert.ok(recorded.events.some(event => event.monitor?.kind === 'ready'), 'The space record holds a READY fact');
  const report = live.intake([{ id: 'shared', name: recorded.name, events: recorded.events }]);
  assert.deepEqual(report, { stored: [`ready:shared:${itemId}`], superseded: [], skipped: 0, full: false });
  const taken = f.handoffs.snapshot().ready[0];
  assert.deepEqual([taken.roomId, taken.itemId, taken.branch, taken.commit, taken.memberId, taken.memberName, taken.text], ['shared', itemId, 'lane/synthetic', commitOf('s'), 'member-a', 'Synthetic member', 'Synthetic task with a long name']);
});

test('a full backlog takes nothing in, tells once, and takes the delivery in when there is room again', t => {
  const f = fixture(t);
  f.engine.intake([]);
  const filler = Array.from({ length: OPEN_LIMIT }, (_, index) => ({ key: key(`m-${index}`), roomId: 'space-1', itemId: `m-${index}`, branch: `lane/m-${index}`, commit: commitOf('m'), state: 'deliverable', notedAt: NOW }));
  fs.writeFileSync(f.file, JSON.stringify({ ...f.handoffs.snapshot(), ready: filler }), { mode: 0o600 });
  const handoffs = new IntegrationHandoffs(f.directory);
  const engine = new IntegratorEngine({ handoffs, now: () => NOW, designation: () => null, mainHead: async () => MAIN, send: async () => ({}) });
  assert.deepEqual(engine.intake([space([fact('a')])]), { stored: [], superseded: [], skipped: 0, full: true });
  assert.deepEqual(handoffs.pendingNotices(), ['backlog-full']);
  assert.equal(handoffs.knows(key('a')), false, 'It is not forgotten: it was never taken');
  assert.deepEqual(engine.intake([space([fact('a')])]).full, true);
  assert.deepEqual(handoffs.pendingNotices(), ['backlog-full'], 'Told once');
  // A newer delivery of a branch that is already inside still gets in, in the place of the one it replaces.
  assert.deepEqual(engine.intake([space([fact('n', { branch: 'lane/m-0' })])]), { stored: [key('n')], superseded: [key('m-0')], skipped: 0, full: false });
});

test('without a usable designation nothing is handed out, and the person is asked once', async t => {
  const f = fixture(t);
  f.engine.intake([space([fact('a')])]);
  const before = f.bytes();
  // The designation cannot be read: nothing is decided, nothing is asked.
  f.designated = Error('Synthetic record failure');
  assert.deepEqual(await f.handOut(view()), { kind: 'none', why: 'designation-unknown', released: [] });
  assert.equal(f.bytes(), before);
  // Nobody is designated: asked once, then silence.
  f.designated = null;
  assert.deepEqual(await f.handOut(view()), { kind: 'ask-integrator', reason: 'integrator-unset', notify: { reason: 'integrator-unset' }, released: [] });
  assert.deepEqual(await f.handOut(view()), { kind: 'none', why: 'integrator-asked', released: [] });
  // The designated session is gone: only a complete list says so; asked once about that session.
  f.designated = INTEGRATOR;
  assert.deepEqual(await f.handOut(view({ sessions: [], complete: false })), { kind: 'none', why: 'sessions-incomplete', released: [] });
  assert.deepEqual(await f.handOut(view({ sessions: [] })), { kind: 'ask-integrator', reason: 'integrator-missing:integrator', notify: { reason: 'integrator-missing:integrator' }, released: [] });
  assert.deepEqual(await f.handOut(view({ sessions: [integratorSession({ nativeId: 'another' })] })), { kind: 'none', why: 'integrator-asked', released: [] });
  // It was put into a space after it was designated: handed nothing, asked once.
  assert.deepEqual(await f.handOut(view({ sessions: [integratorSession({ roomIds: [OTHER_SPACE] })] })), { kind: 'ask-integrator', reason: 'integrator-in-space', notify: { reason: 'integrator-in-space' }, released: [] });
  // An older record says it with roomId alone.
  const { roomIds: _none, ...legacy } = integratorSession({ roomId: 'shared' });
  assert.deepEqual(await f.handOut(view({ sessions: [legacy] })), { kind: 'none', why: 'integrator-asked', released: [] });
  // Its membership cannot be read: nothing is decided.
  const asked = f.bytes();
  for (const unreadable of ['shared', ['not-a-space-id'], ['shared', 'shared']]) assert.deepEqual(await f.handOut(view({ sessions: [integratorSession({ roomIds: unreadable })] })), { kind: 'none', why: 'membership-unknown' }, JSON.stringify(unreadable));
  assert.equal(f.bytes(), asked);
  // Through all of this nothing was sent, git was not read and no fresh look was taken.
  assert.deepEqual([f.sent.length, f.heads, f.looks], [0, 0, 0]);
  assert.deepEqual(f.states(), { a: 'deliverable' });
  assert.deepEqual(f.handoffs.pendingNotices().sort(), ['integrator-in-space', 'integrator-missing:integrator', 'integrator-unset']);
  // Out of the space again, it takes the handoff, and the three questions are over.
  assert.equal((await f.handOut(view())).kind, 'opened');
  const reasons = f.handoffs.snapshot().reasons;
  assert.deepEqual(['integrator-unset', 'integrator-in-space', 'integrator-missing:integrator'].map(reason => reasons[reason].open), [false, false, false]);
});

test('a handoff is recorded before it is sent, sent once to the integrator as it is now, and confirmed', async t => {
  const f = fixture(t);
  f.engine.intake([space([fact('a'), fact('b')])]);
  // The fresh look shows a later control revision than the first view.
  f.fresh = view({ sessions: [integratorSession({ controlRevision: 4 })] });
  f.sending = async () => ({ tag: 'tag-one', control: 4 });
  const result = await f.handOut(view());
  assert.equal(result.kind, 'opened'); assert.match(result.handoffId, /^H1-[0-9a-f]{8}$/);
  assert.deepEqual([result.keys, result.sessionId, result.released], [[key('a'), key('b')], 'integrator', []]);
  assert.equal(f.sent.length, 1);
  const sent = f.sent[0];
  assert.deepEqual([sent.sessionId, sent.nativeId, sent.handoffId], ['integrator', 'native-integrator', result.handoffId]);
  assert.ok(sent.text.startsWith(`【NAW 集成交接】${result.handoffId}：`) && sent.text.includes(commitOf('a')) && sent.text.includes(commitOf('b')));
  // When the message went out, the record already held the handoff, unconfirmed.
  assert.deepEqual([sent.recorded.handoff.id, sent.recorded.handoff.status, sent.recorded.handoff.confirmed, sent.recorded.handed], [result.handoffId, 'sent', false, 2]);
  const handoff = f.handoffs.snapshot().handoff;
  assert.deepEqual([handoff.tag, handoff.control, handoff.mainHead, handoff.integrator], ['tag-one', 4, MAIN, INTEGRATOR]);
  assert.deepEqual([f.heads, f.looks], [1, 1], 'git and the fresh look were asked once, when it was about to open');
  // While it is open nothing else is handed out, however often the engine runs.
  f.engine.intake([space([fact('c')])]);
  for (let pass = 0; pass < 3; pass += 1) assert.deepEqual(await f.handOut(view()), { kind: 'none', why: 'handoff-open' });
  assert.equal(f.sent.length, 1); assert.deepEqual(f.states(), { a: 'handed', b: 'handed', c: 'deliverable' });
  assert.equal(f.engine.hasWork(), true);
});

test('the send may return its tag alone: the control revision is then the one of the session the message went to', async t => {
  for (const [name, sending, control] of [['a plain tag', async () => 'tag-plain', 4], ['a tag without a control revision', async () => ({ tag: 'tag-only' }), 4], ['a newer control revision', async () => ({ tag: 'tag-new', control: 9 }), 9],
    ['a control revision that is not a number', async () => ({ tag: 'tag-odd', control: 'x' }), 4]]) {
    const f = fixture(t);
    f.engine.intake([space([fact('a')])]);
    f.fresh = view({ sessions: [integratorSession({ controlRevision: 4 })] });
    f.sending = sending;
    assert.equal((await f.handOut(view())).kind, 'opened', name);
    assert.equal(f.handoffs.snapshot().handoff.control, control, name);
    // So the person taking control afterwards is still noticed when the handoff settles.
    const later = { integrator: INTEGRATOR, complete: true, now: NOW + 60000, idleSince: new Map([['integrator', NOW + 60000 - rules.IDLE_SETTLE_MS]]),
      session: integratorSession({ controlRevision: control + 1, messages: [{ id: f.handoffs.snapshot().handoff.tag, role: 'user', text: 'handoff', time: NOW }, { id: 'r', role: 'assistant', text: 'ok', time: NOW + 1 }] }) };
    assert.deepEqual([f.handoffs.plan(later).status, f.handoffs.plan(later).reason], ['waiting', 'person-intervened'], name);
  }
  // A session record without a control revision counts as revision 0.
  const f = fixture(t);
  f.engine.intake([space([fact('a')])]);
  f.sending = async () => 'tag';
  await f.handOut(view({ sessions: [integratorSession({ controlRevision: undefined })] }));
  assert.equal(f.handoffs.snapshot().handoff.control, 0);
});

test('when the integrator cannot take it now, nothing is recorded, read from git or sent', async t => {
  const cases = [
    ['automatic messages are off', view({ wakePolicy: { enabled: false } }), undefined, 'automatic-messages-off', 0, 0],
    ['it is working', view({ sessions: [integratorSession({ state: 'working' })] }), undefined, 'not-idle', 0, 0],
    ['the person is typing there', view({ sessions: [integratorSession({ liveDraft: 'hello' })] }), undefined, 'person-typing', 0, 0],
    ['NAW itself is busy with it', view({ busy: id => id === 'integrator' }), undefined, 'busy', 0, 0],
    ['it has not been idle long enough', view({ idleSince: new Map([['integrator', NOW + 10 - rules.IDLE_SETTLE_MS + 1]]) }), undefined, 'not-settled', 0, 0],
    ['the person typed there a moment ago', view({ humanAt: new Map([['integrator', NOW + 10 - rules.HUMAN_QUIET_MS + 1]]) }), undefined, 'person-recent', 0, 0],
    ['the moment passed before the fresh look', view(), null, 'not-ready-now', 1, 0],
    ['the fresh look failed', view(), Error('refresh timeout'), 'not-ready-now', 1, 0],
    ['the fresh look shows it at work', view(), view({ sessions: [integratorSession({ state: 'working' })] }), 'not-idle', 1, 0],
    ['the fresh look shows it inside a space', view(), view({ sessions: [integratorSession({ roomIds: ['shared', OTHER_SPACE] })] }), null, 1, 0],
    ['the fresh look cannot read its membership', view(), view({ sessions: [integratorSession({ roomIds: 7 })] }), 'membership-unknown', 1, 0],
  ];
  for (const [name, first, fresh, why, looks, heads] of cases) {
    const f = fixture(t);
    f.engine.intake([space([fact('a')])]);
    const before = f.bytes();
    f.fresh = fresh;
    const result = await f.handOut(first);
    if (why === null) assert.deepEqual([result.kind, result.reason], ['ask-integrator', 'integrator-in-space'], name);
    else { assert.deepEqual([result.kind, result.why], ['none', why], name); assert.equal(f.bytes(), before, name); }
    assert.deepEqual([f.sent.length, f.looks, f.heads], [0, looks, heads], name);
    assert.deepEqual(f.states(), { a: 'deliverable' }, name);
    assert.equal(f.handoffs.snapshot().handoff, null, name);
  }
  // Main's head cannot be read: nothing opens.
  for (const head of [null, 'main', Error('git failed')]) {
    const f = fixture(t);
    f.engine.intake([space([fact('a')])]);
    const before = f.bytes();
    f.head = head;
    assert.deepEqual(await f.handOut(view()), { kind: 'none', why: 'main-unknown', released: [] }, String(head));
    assert.equal(f.bytes(), before); assert.equal(f.sent.length, 0);
  }
  // Nothing to hand out: git is not read and no fresh look is taken.
  const f = fixture(t);
  f.engine.intake([]);
  assert.deepEqual(await f.handOut(view()), { kind: 'none', why: 'nothing-deliverable', released: [] });
  assert.deepEqual([f.looks, f.heads], [0, 0]); assert.equal(f.engine.hasWork(), false);
});

test('a refused send hands nothing over: the deliveries wait, and after the queue\'s limit they are held for the person', async t => {
  const f = fixture(t);
  f.engine.intake([space([fact('a'), fact('b')])]);
  f.sending = async () => { throw refusal(); };
  const ids = new Set();
  for (let attempt = 1; attempt < rules.NOT_SENT_ATTEMPTS; attempt += 1) {
    const result = await f.handOut(view());
    assert.deepEqual([result.kind, result.held, result.typing], ['refused', [], false], `attempt ${attempt}`);
    ids.add(result.handoffId);
    assert.deepEqual(f.states(), { a: 'deliverable', b: 'deliverable' });
    assert.equal(f.handoffs.snapshot().handoff, null);
  }
  const last = await f.handOut(view());
  assert.deepEqual([last.kind, last.held], ['refused', [key('a'), key('b')]]);
  ids.add(last.handoffId);
  assert.equal(ids.size, rules.NOT_SENT_ATTEMPTS, 'Every attempt was a handoff of its own');
  assert.deepEqual(f.states(), { a: 'held:send-refused', b: 'held:send-refused' });
  assert.deepEqual(f.handoffs.pendingNotices(), ['send-refused']);
  assert.deepEqual(await f.handOut(view()), { kind: 'none', why: 'nothing-deliverable', released: [] });
  assert.equal(f.sent.length, rules.NOT_SENT_ATTEMPTS);
  // A known "not sent" key of the app counts as a refusal too.
  const g = fixture(t);
  g.engine.intake([space([fact('a')])]);
  g.sending = async () => { throw Object.assign(Error('backend-update-needed'), { notSent: true }); };
  assert.equal((await g.handOut(view())).kind, 'refused');
});

test('a prompt the person left unsent in the integrator\'s session never uses up the attempts', async t => {
  const f = fixture(t);
  f.engine.intake([space([fact('a')])]);
  f.sending = async () => { throw Object.assign(Error('draft'), { uiMessage: { version: 1, key: rules.NATIVE_DRAFT_KEY, params: {} } }); };
  for (let attempt = 0; attempt < rules.NOT_SENT_ATTEMPTS * 2; attempt += 1) {
    const result = await f.handOut(view());
    assert.deepEqual([result.kind, result.typing, result.sessionId, result.held], ['refused', true, 'integrator', []], `attempt ${attempt}`);
  }
  assert.deepEqual(f.states(), { a: 'deliverable' });
  assert.equal(f.handoffs.snapshot().refusals, 0);
  // A real refusal after it still starts its own count.
  f.sending = async () => { throw refusal(); };
  await f.handOut(view());
  assert.equal(f.handoffs.snapshot().refusals, 1);
  // The engine tells its caller that the person is at work there, and the caller then leaves the session
  // alone: no handoff is opened and refused again on every pass.
  const told = [], humanAt = new Map();
  const g = fixture(t, { typing: id => { told.push(id); humanAt.set(id, NOW + 10); } });
  g.engine.intake([space([fact('a')])]);
  g.sending = async () => { throw Object.assign(Error('draft'), { uiMessage: { version: 1, key: rules.NATIVE_DRAFT_KEY, params: {} } }); };
  assert.equal((await g.handOut(view({ humanAt }))).typing, true);
  assert.deepEqual(told, ['integrator']);
  const opened = g.handoffs.snapshot().seq;
  for (let pass = 0; pass < 3; pass += 1) assert.deepEqual(await g.handOut(view({ humanAt })), { kind: 'none', why: 'person-recent', released: [] });
  assert.deepEqual([g.handoffs.snapshot().seq, g.sent.length, told.length], [opened, 1, 1]);
  // A caller whose own note fails does not undo the refusal.
  const h = fixture(t, { typing: () => { throw Error('caller failed'); } });
  h.engine.intake([space([fact('a')])]);
  h.sending = g.sending;
  assert.deepEqual([(await h.handOut(view())).kind, h.states()], ['refused', { a: 'deliverable' }]);
});

test('a send whose outcome is unknown is never repeated', async t => {
  const outcomes = {
    'a timeout': async () => { throw Error('send-timeout'); },
    'a lost reply': async () => { throw Object.assign(Error('socket closed'), { code: 'ECONNRESET' }); },
    'no delivery tag came back': async () => ({}),
    'nothing came back': async () => undefined,
    'a tag that cannot be recorded': async () => ({ tag: 'x\ny' }),
  };
  for (const [name, sending] of Object.entries(outcomes)) {
    const f = fixture(t);
    f.engine.intake([space([fact('a')])]);
    f.sending = sending;
    const result = await f.handOut(view());
    assert.equal(result.kind, 'unconfirmed', name);
    const summary = f.handoffs.summary();
    assert.deepEqual([summary.handoff.id, summary.handoff.status, summary.handoff.confirmed, summary.handed], [result.handoffId, 'sent', false, 1], name);
    assert.deepEqual([summary.deliverable, f.engine.hasWork()], [0, true], 'An open handoff alone is work: it still has to be settled');
    // Later passes, and a restart, find the handoff open and send nothing.
    f.sending = async () => ({ tag: 'late', control: 3 });
    for (let pass = 0; pass < 3; pass += 1) assert.deepEqual(await f.handOut(view()), { kind: 'none', why: 'handoff-open' }, name);
    const restarted = new IntegratorEngine({ handoffs: new IntegrationHandoffs(f.directory), now: () => NOW + 500, designation: () => INTEGRATOR, mainHead: async () => MAIN,
      send: async () => { f.sent.push('after restart'); return { tag: 'again' }; } });
    assert.deepEqual(await restarted.handOut(view(), async () => view()), { kind: 'none', why: 'handoff-open' }, name);
    assert.equal(f.sent.length, 1, name);
    // The record settles it as an unconfirmed send after the queue's wait, which holds the delivery for the person.
    assert.deepEqual(f.handoffs.plan({ integrator: INTEGRATOR, now: NOW + rules.UNCONFIRMED_SEND_MS + 1 }), { kind: 'settle', handoffId: result.handoffId, status: 'failed', reason: 'send-unconfirmed' }, name);
  }
});

test('what was held because an integrator was gone is handed again when a designated integrator is here', async t => {
  const f = fixture(t);
  f.engine.intake([space([fact('a'), fact('b'), fact('c')])]);
  f.handoffs.hold(key('a'), 'integrator-missing:earlier-session', NOW); f.handoffs.hold(key('b'), 'integrator-missing:integrator', NOW); f.handoffs.hold(key('c'), 'review-off', NOW);
  // Not while the designated session is absent, archived, replaced by another native session, or the designation is unknown.
  for (const [name, current] of [['absent', view({ sessions: [] })], ['archived', view({ sessions: [integratorSession({ archived: true })] })], ['another native id', view({ sessions: [integratorSession({ nativeId: 'other' })] })]]) {
    const result = await f.handOut(current);
    assert.deepEqual(result.released, [], name);
    assert.deepEqual(f.states(), { a: 'held:integrator-missing:earlier-session', b: 'held:integrator-missing:integrator', c: 'held:review-off' }, name);
  }
  f.designated = Error('unreadable');
  assert.deepEqual((await f.handOut(view())).released, []);
  f.designated = INTEGRATOR;
  const result = await f.handOut(view());
  assert.deepEqual([result.kind, result.released, result.keys], ['opened', [key('a'), key('b')], [key('a'), key('b')]]);
  assert.deepEqual(f.states(), { a: 'handed', b: 'handed', c: 'held:review-off' }, 'What is held for another reason stays held');
});

test('the release of what was held for a missing integrator is decided on the fresh look, like the handoff itself', async t => {
  const held = f => { f.engine.intake([space([fact('a'), fact('b')])]); f.handoffs.hold(key('a'), 'integrator-missing:integrator', NOW); f.handoffs.hold(key('b'), 'integrator-missing:integrator', NOW); };
  // The first view still shows the integrator; the fresh look shows it gone from a complete list.
  let f = fixture(t); held(f);
  f.fresh = view({ sessions: [] });
  const before = f.bytes();
  assert.deepEqual(await f.handOut(view()), { kind: 'none', why: 'nothing-deliverable', released: [] });
  assert.equal(f.bytes(), before, 'Nothing is released, and the person is not asked a second time about the same absence');
  assert.deepEqual([f.looks, f.heads, f.sent.length], [1, 0, 0]);
  // Nothing is deliverable, but the integrator is back: the fresh look releases them and the handoff opens.
  f = fixture(t); held(f);
  const result = await f.handOut(view());
  assert.deepEqual([result.kind, result.released, result.keys], ['opened', [key('a'), key('b')], [key('a'), key('b')]]);
  // Back but at work: they are released to wait, nothing is sent and git is not read.
  f = fixture(t); held(f);
  const working = view({ sessions: [integratorSession({ state: 'working' })] });
  assert.deepEqual(await f.handOut(working), { kind: 'none', why: 'not-idle', released: [key('a'), key('b')] });
  assert.deepEqual([f.states(), f.heads, f.sent.length], [{ a: 'deliverable', b: 'deliverable' }, 0, 0]);
  assert.deepEqual(await f.handOut(working), { kind: 'none', why: 'not-idle', released: [] });
  assert.equal(f.looks, 1, 'With nothing left to release, a later pass takes no fresh look');
  // Another native session under the integrator's id is not the integrator, whatever its membership says.
  f = fixture(t); held(f); f.engine.intake([space([fact('c')])]);
  const other = view({ sessions: [integratorSession({ nativeId: 'another', roomIds: 'unreadable' })] });
  // (The person was told about that absence when the deliveries were held; it is not "membership unknown".)
  assert.deepEqual(await f.handOut(other), { kind: 'none', why: 'integrator-asked', released: [] });
  assert.deepEqual(f.states(), { a: 'held:integrator-missing:integrator', b: 'held:integrator-missing:integrator', c: 'deliverable' });
});

test('an unreadable record stops the engine: nothing is taken in, handed out or sent', async t => {
  const f = fixture(t);
  f.engine.intake([space([fact('a')])]);
  fs.writeFileSync(f.file, '{', { mode: 0o600 });
  const engine = new IntegratorEngine({ handoffs: new IntegrationHandoffs(f.directory), now: () => NOW, designation: () => INTEGRATOR, mainHead: async () => MAIN, send: async () => { f.sent.push('x'); return { tag: 't' }; } });
  assert.throws(() => engine.intake([space([fact('b')])]), { code: 'HANDOFF_STATE' });
  await assert.rejects(engine.handOut(view(), async () => view()), { code: 'HANDOFF_STATE' });
  assert.equal(engine.hasWork(), false);
  assert.deepEqual([engine.unreadable(), f.engine.unreadable()], [true, false], 'The caller can see that the record is broken and tell the person');
  assert.equal(f.sent.length, 0); assert.equal(fs.readFileSync(f.file, 'utf8'), '{', 'The record is left as it is');
});

test('the engine reaches the app only through what it is given', () => {
  const source = fs.readFileSync(path.join(__dirname, '../integrator-engine.cjs'), 'utf8');
  assert.deepEqual([...source.matchAll(/require\('([^']+)'\)/g)].map(match => match[1]).sort(), ['./collaboration-spaces.cjs', './queue-dispatch.cjs']);
  for (const word of ['child_process', 'execFile', 'spawn', 'setTimeout', 'setInterval', 'fetch(', 'ipcMain', 'electron', 'integrator-git', 'integrator-lock', 'writeFile']) assert.ok(!source.replace(/^\s*\/\/.*$/gm, '').includes(word), word);
});
