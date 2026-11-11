const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const rules = require('../queue-dispatch.cjs');
const { IntegrationHandoffs, plan, handoffText, reasonKey, MARKER, FILE, OPEN_LIMIT, CLOSED_KEPT, AGED_MS } = require('../integrator-handoff.cjs');

// Synthetic records only: no model, no message, no git and no lock is involved in this module.
const NOW = 1_800_000_000_000;
const MAIN = 'a'.repeat(40);
const INTEGRATOR = { sessionId: 'integrator', nativeId: 'native-integrator' };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-handoff-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, FILE), open: () => new IntegrationHandoffs(directory), backlog: new IntegrationHandoffs(directory) };
}
function ready(name, extra = {}) {
  return { key: `ready:space-1:${name}`, roomId: 'space-1', itemId: name, branch: `lane/${name}`, commit: (name.charCodeAt(0).toString(16).padStart(2, '0')).repeat(20),
    memberId: `member-${name}`, memberName: `Member ${name}`, spaceName: 'Space one', text: `Task ${name}`, ...extra };
}
function integratorSession(extra = {}) {
  return { id: INTEGRATOR.sessionId, nativeId: INTEGRATOR.nativeId, provider: 'claude', state: 'idle', background: 0, scheduled: 0, backgroundStale: false,
    chatAvailable: true, liveDraft: '', controlRevision: 0, serviceCapabilities: [rules.CAPABILITY], fleet: [], messages: [], ...extra };
}
// What the caller observes when the integrator can take a handoff now.
function observed(extra = {}) {
  return { integrator: INTEGRATOR, session: integratorSession(), complete: true, wakePolicy: { enabled: true }, now: NOW,
    idleSince: new Map([[INTEGRATOR.sessionId, NOW - rules.IDLE_SETTLE_MS]]), humanAt: new Map(), mainHead: MAIN, ...extra };
}
const states = backlog => Object.fromEntries(backlog.snapshot().ready.map(entry => [entry.itemId, entry.state + (entry.reason ? ':' + entry.reason : '')]));
function openHandoff(backlog, extra) {
  const action = backlog.plan(observed(extra));
  assert.equal(action.kind, 'open');
  backlog.open(action, NOW);
  return action;
}

test('a delivery is recorded once, and an invalid one is refused and not stored', t => {
  const { backlog, file } = fixture(t);
  assert.deepEqual(backlog.noteReady(ready('a'), NOW), { stored: true, superseded: [] });
  const before = fs.readFileSync(file, 'utf8');
  assert.deepEqual(backlog.noteReady(ready('a', { commit: 'f'.repeat(40), text: 'Other text' }), NOW + 5), { stored: false, why: 'known', superseded: [] });
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'The same key again changes nothing');
  for (const bad of [{ branch: 'lane/../main' }, { branch: '-rf' }, { branch: 'has space' }, { commit: 'abc' }, { commit: 'G'.repeat(40) }, { key: '' }, { key: undefined },
    { roomId: 'bad\nroom' }, { itemId: '' }, { memberName: 'x'.repeat(201) }, { memberId: 'a\u0007' }, { spaceName: 7 }, { text: { a: 1 } }]) {
    assert.throws(() => backlog.noteReady(ready('b', bad), NOW), { code: 'HANDOFF_STATE' }, JSON.stringify(bad));
  }
  assert.throws(() => backlog.noteReady(null, NOW), { code: 'HANDOFF_STATE' });
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'A refused delivery is not stored');
  // The task text is kept short and on one line; the names are optional.
  backlog.noteReady(ready('c', { text: 'line one\nline two ' + 'x'.repeat(300), memberName: undefined, spaceName: '' }), NOW);
  const stored = backlog.snapshot().ready.find(entry => entry.itemId === 'c');
  assert.ok(stored.text.length <= 120 && !/\n/.test(stored.text) && stored.text.startsWith('line one line two'));
  assert.equal(stored.memberName, undefined); assert.equal(stored.spaceName, undefined);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a newer delivery of a branch replaces one that is waiting or held, and leaves one inside the open handoff', t => {
  const { backlog } = fixture(t);
  backlog.noteReady(ready('a'), NOW); backlog.noteReady(ready('b'), NOW);
  backlog.hold('ready:space-1:b', 'review-off', NOW);
  assert.deepEqual(backlog.noteReady(ready('a2', { branch: 'lane/a' }), NOW + 1), { stored: true, superseded: ['ready:space-1:a'] });
  assert.deepEqual(backlog.noteReady(ready('b2', { branch: 'lane/b' }), NOW + 1), { stored: true, superseded: ['ready:space-1:b'] });
  assert.deepEqual(states(backlog), { a: 'superseded', b: 'superseded', a2: 'deliverable', b2: 'deliverable' });
  const action = openHandoff(backlog);
  assert.deepEqual(action.keys, ['ready:space-1:a2', 'ready:space-1:b2']);
  assert.deepEqual(backlog.noteReady(ready('a3', { branch: 'lane/a' }), NOW + 2), { stored: true, superseded: [] });
  assert.deepEqual(states(backlog), { a: 'superseded', b: 'superseded', a2: 'handed', b2: 'handed', a3: 'deliverable' });
});

test('without a designated integrator the person is asked once; a session that is gone is asked about once too', t => {
  const { backlog } = fixture(t);
  assert.deepEqual(backlog.plan(observed({ integrator: null })), { kind: 'none', why: 'nothing-deliverable' });
  backlog.noteReady(ready('a'), NOW);
  const ask = backlog.plan(observed({ integrator: null }));
  assert.deepEqual(ask, { kind: 'ask-integrator', reason: 'integrator-unset' });
  assert.deepEqual(backlog.askIntegrator(ask.reason, NOW), { notify: { reason: 'integrator-unset' } });
  assert.deepEqual(backlog.askIntegrator(ask.reason, NOW + 1), { notify: null });
  backlog.noteReady(ready('b'), NOW);
  assert.deepEqual(backlog.plan(observed({ integrator: null })), { kind: 'none', why: 'integrator-asked' });
  assert.deepEqual(states(backlog), { a: 'deliverable', b: 'deliverable' }, 'The deliveries wait; they are not held');
  // The designated session is missing or archived: only a complete session list can say so.
  for (const session of [undefined, integratorSession({ archived: true }), integratorSession({ nativeId: 'other-native' })]) {
    assert.deepEqual(backlog.plan(observed({ session, complete: false })), { kind: 'none', why: 'sessions-incomplete' });
    assert.deepEqual(backlog.plan(observed({ session })), { kind: 'ask-integrator', reason: 'integrator-missing:integrator' });
  }
  assert.deepEqual(backlog.askIntegrator('integrator-missing:integrator', NOW), { notify: { reason: 'integrator-missing:integrator' } });
  assert.deepEqual(backlog.plan(observed({ session: undefined })), { kind: 'none', why: 'integrator-asked' });
  assert.throws(() => backlog.askIntegrator('review-off', NOW), { code: 'HANDOFF_STATE' });
  // Designating an integrator ends both questions; the same lack later is a new occurrence.
  assert.deepEqual(backlog.reasonCleared('integrator-designated'), { released: [] });
  assert.deepEqual(backlog.plan(observed({ integrator: null })), { kind: 'ask-integrator', reason: 'integrator-unset' });
  assert.equal(backlog.plan(observed()).kind, 'open');
});

test('an integrator that cannot take a message now gets none, and nothing is lost', t => {
  const { backlog } = fixture(t);
  backlog.noteReady(ready('a'), NOW); backlog.noteReady(ready('b'), NOW);
  const cases = [
    [{ wakePolicy: { enabled: false } }, 'automatic-messages-off'], [{ wakePolicy: undefined }, 'automatic-messages-off'],
    [{ session: integratorSession({ wakeDisabled: true }) }, 'paused'], [{ session: integratorSession({ state: 'working' }) }, 'not-idle'],
    [{ session: integratorSession({ approval: { id: 'x' } }) }, 'busy'], [{ session: integratorSession({ interruptPending: true }) }, 'busy'],
    [{ session: integratorSession({ pendingTag: 'tag' }) }, 'busy'], [{ session: integratorSession({ liveDraft: 'typing' }) }, 'person-typing'],
    [{ session: integratorSession({ background: 1 }) }, 'background-work'], [{ session: integratorSession({ serviceCapabilities: [] }) }, 'backend-update-needed'],
    [{ session: integratorSession({ chatAvailable: false }) }, 'unavailable'],
    [{ idleSince: new Map([[INTEGRATOR.sessionId, NOW - rules.IDLE_SETTLE_MS + 1]]) }, 'not-settled'], [{ idleSince: new Map() }, 'not-settled'], [{ now: undefined }, 'not-settled'],
    [{ humanAt: new Map([[INTEGRATOR.sessionId, NOW - rules.HUMAN_QUIET_MS + 1]]) }, 'person-recent'],
    [{ mainHead: 'abc' }, 'main-unknown'], [{ mainHead: undefined }, 'main-unknown'],
  ];
  for (const [change, why] of cases) assert.deepEqual(backlog.plan(observed(change)), { kind: 'none', why }, why);
  assert.deepEqual(states(backlog), { a: 'deliverable', b: 'deliverable' });
  // The same readiness rule as a queue dispatch decides it.
  assert.equal(rules.sessionReady(integratorSession(), { enabled: true }).ready, true);
  const action = backlog.plan(observed({ humanAt: new Map([[INTEGRATOR.sessionId, NOW - rules.HUMAN_QUIET_MS]]) }));
  assert.equal(action.kind, 'open'); assert.deepEqual(action.keys, ['ready:space-1:a', 'ready:space-1:b']);
});

test('a handoff carries every deliverable delivery under its own marker, and only one is open at a time', t => {
  const { backlog, open } = fixture(t);
  backlog.noteReady(ready('a'), NOW); backlog.noteReady(ready('b'), NOW); backlog.noteReady(ready('c'), NOW);
  backlog.hold('ready:space-1:c', 'review-off', NOW);
  const action = backlog.plan(observed({ checkpoint: 'review 0a2298c6 at ' + MAIN.slice(0, 12) }));
  assert.equal(action.kind, 'open'); assert.deepEqual(action.integrator, INTEGRATOR); assert.equal(action.mainHead, MAIN);
  assert.match(action.handoffId, /^H1-[0-9a-f]{8}$/);
  assert.ok(action.text.startsWith(MARKER + action.handoffId), 'The handoff starts with its own marker and id');
  assert.equal(MARKER, '【NAW 集成交接】'); assert.ok(!action.text.includes('【NAW 派活】'), 'It is not a queue dispatch');
  for (const name of ['a', 'b']) {
    const entry = ready(name);
    for (const part of [entry.branch, entry.commit, entry.memberName, entry.text, '「Space one」']) assert.ok(action.text.includes(part), part);
  }
  assert.ok(!action.text.includes('lane/c'), 'A held delivery is not carried along');
  for (const part of ['MERGED <READY 的提交号> as <main 上的提交号> tests', 'RETURNED <READY 的提交号> <原因>', 'HELD <READY 的提交号> <原因>', '需要你决定：', '不装机，不推送', 'review 0a2298c6']) assert.ok(action.text.includes(part), part);
  assert.equal(handoffText('H9-x', [{ branch: 'b', commit: 'c', roomId: 'room-id' }]).includes('交活人：未记录　空间：「room-id」　任务：未记录'), true);
  assert.equal(handoffText('H9-x', []).includes('上次独审的检查点：没有记录'), true);

  assert.deepEqual(backlog.open(action, NOW), { opened: true });
  const state = backlog.snapshot();
  assert.deepEqual(state.handoff, { id: action.handoffId, status: 'sent', keys: action.keys, integrator: INTEGRATOR, mainHead: MAIN, sentAt: NOW, tag: null });
  assert.deepEqual(states(backlog), { a: 'handed', b: 'handed', c: 'held:review-off' });
  assert.equal(state.seq, 1);
  // One at a time: a new delivery waits, and the same action again opens nothing.
  backlog.noteReady(ready('d'), NOW);
  assert.deepEqual(backlog.plan(observed()), { kind: 'none', why: 'handoff-open' });
  assert.deepEqual(backlog.open(action, NOW + 9), { opened: false, why: 'known' });
  assert.deepEqual(open().snapshot(), backlog.snapshot(), 'A restart reads the same record');
  assert.throws(() => backlog.open({ ...action, handoffId: 'H2-other' }, NOW), { code: 'HANDOFF_STATE' });
});

test('a plan that no longer matches the backlog opens nothing', t => {
  const { backlog } = fixture(t);
  backlog.noteReady(ready('a'), NOW);
  const action = backlog.plan(observed());
  backlog.noteReady(ready('b'), NOW);
  const before = backlog.snapshot();
  assert.throws(() => backlog.open(action, NOW), { code: 'HANDOFF_STATE' });
  for (const bad of [null, { ...action, kind: 'ask-integrator' }, { ...action, mainHead: 'short' }, { ...action, integrator: { sessionId: 'x' } }, { ...action, keys: [] }, { ...action, handoffId: '' }]) {
    assert.throws(() => backlog.open(bad, NOW), { code: 'HANDOFF_STATE' });
  }
  assert.deepEqual(backlog.snapshot(), before);
  // Two plans of different backlogs never share an id.
  const second = backlog.plan(observed());
  assert.notEqual(second.handoffId, action.handoffId); assert.deepEqual(second.keys, ['ready:space-1:a', 'ready:space-1:b']);
});

test('a handoff is recorded as sent before it is sent; a refusal before sending is not a handoff', t => {
  const { backlog } = fixture(t);
  backlog.noteReady(ready('a'), NOW);
  let action = openHandoff(backlog);
  assert.throws(() => backlog.confirmSent('H9-none', { tag: 'tag-1' }, NOW), { code: 'HANDOFF_STATE' });
  assert.throws(() => backlog.confirmSent(action.handoffId, { tag: '' }, NOW), { code: 'HANDOFF_STATE' });
  assert.deepEqual(backlog.confirmSent(action.handoffId, { tag: 'tag-1', control: 4 }, NOW + 3), { confirmed: true });
  assert.deepEqual(backlog.confirmSent(action.handoffId, { tag: 'tag-1' }, NOW + 4), { confirmed: true });
  assert.deepEqual(backlog.confirmSent(action.handoffId, { tag: 'tag-2' }, NOW + 4), { confirmed: false }, 'A second tag does not replace the first');
  const sent = backlog.snapshot().handoff;
  assert.equal(sent.tag, 'tag-1'); assert.equal(sent.control, 4); assert.equal(sent.confirmedAt, NOW + 3);
  assert.throws(() => backlog.sendRefused(action.handoffId, NOW), { code: 'HANDOFF_STATE' }, 'A confirmed handoff cannot be called refused');
});

test('refusals before sending put the deliveries back, and the queue limit of refusals in a row hands them to the person', t => {
  const { backlog } = fixture(t);
  backlog.noteReady(ready('a'), NOW); backlog.noteReady(ready('b'), NOW);
  const ids = new Set();
  for (let attempt = 1; attempt < rules.NOT_SENT_ATTEMPTS; attempt += 1) {
    const action = openHandoff(backlog); ids.add(action.handoffId);
    assert.deepEqual(backlog.sendRefused(action.handoffId, NOW), { held: [], notify: null });
    assert.deepEqual(states(backlog), { a: 'deliverable', b: 'deliverable' }); assert.equal(backlog.snapshot().handoff, null);
  }
  assert.equal(ids.size, rules.NOT_SENT_ATTEMPTS - 1, 'Each attempt has its own id');
  const last = openHandoff(backlog);
  assert.deepEqual(backlog.sendRefused(last.handoffId, NOW), { held: ['ready:space-1:a', 'ready:space-1:b'], notify: { reason: 'send-refused' } });
  assert.deepEqual(states(backlog), { a: 'held:send-refused', b: 'held:send-refused' });
  assert.deepEqual(backlog.plan(observed()), { kind: 'none', why: 'nothing-deliverable' });
  // A send that went through starts the count again.
  backlog.retryReason('send-refused');
  for (let attempt = 1; attempt < rules.NOT_SENT_ATTEMPTS; attempt += 1) backlog.sendRefused(openHandoff(backlog).handoffId, NOW);
  const delivered = openHandoff(backlog); backlog.confirmSent(delivered.handoffId, { tag: 'tag' }, NOW);
  assert.equal(backlog.snapshot().refusals, 0);
});

// The branch table for "a held delivery does not go round in circles":
// held under a reason x every event that is not that reason changing -> still held, never handed.
test('a held delivery comes back only when its own reason changes or the person retries', t => {
  const { backlog, open } = fixture(t);
  const held = { a: 'review-off', b: 'lock-held:owner-1', c: 'conflict:H1-abcd', d: 'send-unconfirmed', e: 'integrator-missing:old', f: 'review-cap', g: 'checkpoint-invalid', h: 'merge-unverified' };
  for (const [name, reason] of Object.entries(held)) { backlog.noteReady(ready(name), NOW); backlog.hold(`ready:space-1:${name}`, reason, NOW); }
  const all = () => Object.fromEntries(Object.entries(held).map(([name, reason]) => [name, 'held:' + reason]));
  assert.deepEqual(states(backlog), all());
  // Events that change none of these reasons.
  for (let tick = 0; tick < 5; tick += 1) assert.deepEqual(backlog.plan(observed({ now: NOW + tick * 3000 })), { kind: 'none', why: 'nothing-deliverable' });
  assert.deepEqual(backlog.reasonCleared('lock-released', 'owner-2'), { released: [] });
  assert.deepEqual(backlog.retryReason('record-missing'), { released: [] });
  assert.deepEqual(backlog.retryReason('conflict:H2-other'), { released: [] });
  assert.deepEqual(backlog.askIntegrator('integrator-unset', NOW), { notify: { reason: 'integrator-unset' } });
  assert.deepEqual(open().snapshot().ready.map(entry => entry.state), Array(8).fill('held'), 'A restart releases nothing');
  // A new delivery is handed alone; the held ones are not carried along with it.
  backlog.noteReady(ready('n'), NOW);
  const action = openHandoff(backlog);
  assert.deepEqual(action.keys, ['ready:space-1:n']);
  for (const reasonHeld of Object.values(held)) assert.ok(!action.text.includes(reasonHeld));
  assert.deepEqual(states(backlog), { ...all(), n: 'handed' });
  assert.deepEqual(backlog.sendRefused(action.handoffId, NOW), { held: [], notify: null });
  backlog.hold('ready:space-1:n', 'no-result', NOW);
  // Each reason changing releases exactly what was held under it.
  const expect = { ...all(), n: 'held:no-result' };
  const step = (released, call) => { assert.deepEqual(call(), { released: released.map(name => `ready:space-1:${name}`) }); for (const name of released) expect[name] = 'deliverable'; assert.deepEqual(states(backlog), expect); };
  step(['a'], () => backlog.reasonCleared('review-opened'));
  step(['b'], () => backlog.reasonCleared('lock-released', 'owner-1'));
  step(['c'], () => backlog.retryReason('conflict:H1-abcd'));
  step(['d'], () => backlog.retryReady('ready:space-1:d'));
  step(['e'], () => backlog.reasonCleared('integrator-designated'));
  step(['f'], () => backlog.reasonCleared('review-cap-raised'));
  step(['g'], () => backlog.retryReason('checkpoint-invalid'));
  step([], () => backlog.reasonCleared('review-opened'));
  assert.throws(() => backlog.reasonCleared('time-passed'), { code: 'HANDOFF_STATE' });
  assert.throws(() => backlog.reasonCleared('lock-released'), { code: 'HANDOFF_STATE' });
  assert.throws(() => backlog.retryReady('ready:space-1:a'), { code: 'HANDOFF_STATE' }, 'A delivery that is not held cannot be retried');
  assert.throws(() => backlog.retryReason('made-up'), { code: 'HANDOFF_STATE' });
  // Only the released ones are in the next handoff.
  assert.deepEqual(backlog.plan(observed()).keys, ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(name => `ready:space-1:${name}`));
});

test('the person is told about a reason once while it is open, and again only after a retry closed it', t => {
  const { backlog } = fixture(t);
  for (const name of ['a', 'b', 'c', 'd']) backlog.noteReady(ready(name), NOW);
  assert.deepEqual(backlog.hold('ready:space-1:a', 'review-off', NOW), { notify: { reason: 'review-off' } });
  assert.deepEqual(backlog.hold('ready:space-1:b', 'review-off', NOW + 1), { notify: null });
  assert.deepEqual(backlog.held(), [{ reason: 'review-off', count: 2, entries: backlog.snapshot().ready.slice(0, 2) }]);
  // Retrying one of two leaves the reason open: a later hold under it tells nobody again.
  backlog.retryReady('ready:space-1:a');
  assert.deepEqual(backlog.hold('ready:space-1:c', 'review-off', NOW + 2), { notify: null });
  assert.equal(backlog.snapshot().reasons['review-off'].open, true);
  // Retrying the last one, or the reason itself, closes it: the next occurrence is new.
  backlog.retryReady('ready:space-1:b'); backlog.retryReady('ready:space-1:c');
  assert.equal(backlog.snapshot().reasons['review-off'].open, false);
  assert.deepEqual(backlog.hold('ready:space-1:d', 'review-off', NOW + 3), { notify: { reason: 'review-off' } });
  // Each owner of the lock is its own reason.
  assert.deepEqual(backlog.hold('ready:space-1:a', 'lock-held:owner-1', NOW), { notify: { reason: 'lock-held:owner-1' } });
  assert.deepEqual(backlog.hold('ready:space-1:b', 'lock-held:owner-2', NOW), { notify: { reason: 'lock-held:owner-2' } });
  assert.deepEqual(backlog.hold('ready:space-1:c', 'lock-held:owner-1', NOW), { notify: null });
  for (const bad of ['', 'made-up', 'lock-held', 'lock-held:', 'integrator-unset', 7]) assert.throws(() => backlog.hold('ready:space-1:a', bad, NOW), { code: 'HANDOFF_STATE' }, String(bad));
  // A new day lets what was held for the cap be handed again, but the unanswered question stays open:
  // reaching the cap again does not ask twice. Raising the amount closes it.
  backlog.noteReady(ready('e'), NOW); backlog.noteReady(ready('f'), NOW);
  assert.deepEqual(backlog.hold('ready:space-1:e', 'review-cap', NOW), { notify: { reason: 'review-cap' } });
  assert.deepEqual(backlog.reasonCleared('review-cap-new-day'), { released: ['ready:space-1:e'] });
  assert.deepEqual(backlog.hold('ready:space-1:e', 'review-cap', NOW + 1), { notify: null });
  assert.deepEqual(backlog.reasonCleared('review-cap-raised'), { released: ['ready:space-1:e'] });
  assert.deepEqual(backlog.hold('ready:space-1:f', 'review-cap', NOW + 2), { notify: { reason: 'review-cap' } });
  assert.throws(() => backlog.hold('ready:space-1:zz', 'review-off', NOW), { code: 'HANDOFF_STATE' });
  assert.equal(reasonKey('conflict:H1-abcd'), 'conflict:H1-abcd'); assert.equal(reasonKey('conflict'), null); assert.equal(reasonKey('review-off:x'), null);
});

test('a notice starts once, is confirmed after it was shown, and is not sent again when its outcome is unknown', t => {
  const { backlog, open } = fixture(t);
  backlog.noteReady(ready('a'), NOW); backlog.noteReady(ready('b'), NOW);
  backlog.hold('ready:space-1:a', 'review-off', NOW); backlog.hold('ready:space-1:b', 'lock-held:owner-1', NOW);
  assert.deepEqual(backlog.pendingNotices(), ['review-off', 'lock-held:owner-1']);
  assert.deepEqual(open().pendingNotices(), ['review-off', 'lock-held:owner-1'], 'A restart before telling still tells');
  assert.deepEqual(backlog.reserveNotice('review-off'), { reserved: true });
  assert.deepEqual(backlog.reserveNotice('review-off'), { reserved: false }, 'It cannot start twice');
  assert.deepEqual(backlog.pendingNotices(), ['lock-held:owner-1']);
  // A crash between starting and confirming leaves it unknown: after a restart it is not sent again.
  const restarted = open();
  assert.deepEqual(restarted.pendingNotices(), ['lock-held:owner-1']);
  assert.deepEqual(restarted.reserveNotice('review-off'), { reserved: false });
  assert.equal(restarted.snapshot().reasons['review-off'].notice, 'reserved');
  assert.deepEqual(restarted.confirmNotice('review-off'), { confirmed: true });
  assert.deepEqual(restarted.confirmNotice('review-off'), { confirmed: false });
  assert.deepEqual(restarted.confirmNotice('lock-held:owner-1'), { confirmed: false }, 'Only a started notice can be confirmed');
  assert.deepEqual(restarted.reserveNotice('made-up'), { reserved: false });
  // A closed reason is not told about; a new occurrence is pending again.
  restarted.reasonCleared('lock-released', 'owner-1');
  assert.deepEqual(restarted.pendingNotices(), []);
  assert.deepEqual(restarted.reserveNotice('lock-held:owner-1'), { reserved: false });
  restarted.hold('ready:space-1:b', 'lock-held:owner-1', NOW + 9);
  assert.deepEqual(restarted.pendingNotices(), ['lock-held:owner-1']);
});

test('holding a delivery that is inside the open handoff takes it out; the last one closes the handoff', t => {
  const { backlog } = fixture(t);
  backlog.noteReady(ready('a'), NOW); backlog.noteReady(ready('b'), NOW);
  const action = openHandoff(backlog);
  backlog.hold('ready:space-1:a', 'review-off', NOW);
  assert.deepEqual(backlog.snapshot().handoff.keys, ['ready:space-1:b']);
  backlog.hold('ready:space-1:b', 'lock-held:owner-1', NOW);
  assert.equal(backlog.snapshot().handoff, null);
  assert.deepEqual(states(backlog), { a: 'held:review-off', b: 'held:lock-held:owner-1' });
  assert.throws(() => backlog.confirmSent(action.handoffId, { tag: 'late' }, NOW), { code: 'HANDOFF_STATE' });
});

test('a record that cannot be trusted stops everything and is left as it is', t => {
  const cases = {
    'other people can read it': file => { fs.writeFileSync(file, JSON.stringify({ version: 1, seq: 0, ready: [], handoff: null, reasons: {}, refusals: 0 }), { mode: 0o644 }); fs.chmodSync(file, 0o644); },
    'a link': file => { const target = file + '.target'; fs.writeFileSync(target, '{}', { mode: 0o600 }); fs.symlinkSync(target, file); },
    'not JSON': file => fs.writeFileSync(file, '{', { mode: 0o600 }),
    'another version': file => fs.writeFileSync(file, JSON.stringify({ version: 2, seq: 0, ready: [], handoff: null, reasons: {}, refusals: 0 }), { mode: 0o600 }),
    'a handed delivery without a handoff': file => fs.writeFileSync(file, JSON.stringify({ version: 1, seq: 1, ready: [{ ...ready('a'), state: 'handed', notedAt: NOW }], handoff: null, reasons: {}, refusals: 0 }), { mode: 0o600 }),
    'a held delivery without a reason': file => fs.writeFileSync(file, JSON.stringify({ version: 1, seq: 0, ready: [{ ...ready('a'), state: 'held', notedAt: NOW }], handoff: null, reasons: {}, refusals: 0 }), { mode: 0o600 }),
    'a delivery with an unsafe branch': file => fs.writeFileSync(file, JSON.stringify({ version: 1, seq: 0, ready: [{ ...ready('a'), branch: '--upload-pack=x', state: 'deliverable', notedAt: NOW }], handoff: null, reasons: {}, refusals: 0 }), { mode: 0o600 }),
    'the same delivery twice': file => fs.writeFileSync(file, JSON.stringify({ version: 1, seq: 0, ready: [{ ...ready('a'), state: 'deliverable', notedAt: NOW }, { ...ready('a'), state: 'deliverable', notedAt: NOW }], handoff: null, reasons: {}, refusals: 0 }), { mode: 0o600 }),
    'too large': file => fs.writeFileSync(file, ' '.repeat(4 * 1024 * 1024 + 1), { mode: 0o600 }),
  };
  for (const [name, write] of Object.entries(cases)) {
    const { directory, file } = fixture(t);
    write(file);
    const before = fs.lstatSync(file), content = before.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file, 'utf8');
    const backlog = new IntegrationHandoffs(directory);
    for (const call of [() => backlog.snapshot(), () => backlog.noteReady(ready('z'), NOW), () => backlog.plan(observed()), () => backlog.hold('ready:space-1:a', 'review-off', NOW),
      () => backlog.retryReason('review-off'), () => backlog.reasonCleared('review-opened'), () => backlog.askIntegrator('integrator-unset', NOW), () => backlog.deliverable(), () => backlog.held(), () => backlog.aged(NOW),
      () => backlog.pendingNotices(), () => backlog.reserveNotice('review-off'), () => backlog.confirmNotice('review-off')]) {
      assert.throws(call, { code: 'HANDOFF_STATE' }, name);
    }
    const after = fs.lstatSync(file);
    assert.equal(after.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file, 'utf8'), content, name + ': left as it is');
    assert.deepEqual(fs.readdirSync(directory).filter(entry => entry.endsWith('.tmp')), [], name);
  }
});

test('the backlog is bounded: a full one refuses new deliveries without dropping any, and old outcomes are trimmed', t => {
  const { directory, file } = fixture(t);
  const entry = (index, state) => ({ ...ready('x'), key: `ready:space-1:${state}-${index}`, itemId: `${state}-${index}`, branch: `lane/${state}-${index}`, state, notedAt: NOW + index });
  const full = { version: 1, seq: 0, handoff: null, reasons: {}, refusals: 0, ready: [
    ...Array.from({ length: OPEN_LIMIT }, (_, index) => entry(index, 'deliverable')), ...Array.from({ length: CLOSED_KEPT + 3 }, (_, index) => entry(index, 'merged'))] };
  fs.writeFileSync(file, JSON.stringify(full), { mode: 0o600 });
  let backlog = new IntegrationHandoffs(directory);
  assert.deepEqual(backlog.noteReady(ready('new'), NOW), { stored: false, why: 'backlog-full', superseded: [] });
  assert.equal(backlog.snapshot().ready.length, OPEN_LIMIT + CLOSED_KEPT + 3, 'Nothing is dropped to make room');
  // With room again, storing trims the oldest finished ones and never one that still waits.
  full.ready.shift();
  fs.writeFileSync(file, JSON.stringify(full), { mode: 0o600 });
  backlog = new IntegrationHandoffs(directory);
  assert.deepEqual(backlog.noteReady(ready('new'), NOW), { stored: true, superseded: [] });
  const kept = backlog.snapshot().ready;
  assert.equal(kept.filter(item => item.state === 'deliverable').length, OPEN_LIMIT);
  assert.deepEqual(kept.filter(item => item.state === 'merged').map(item => item.itemId), Array.from({ length: CLOSED_KEPT }, (_, index) => `merged-${index + 3}`));
});

test('deliveries that have waited more than four hours are listed apart', t => {
  const { backlog } = fixture(t);
  backlog.noteReady(ready('a'), NOW - AGED_MS - 1); backlog.noteReady(ready('b'), NOW - AGED_MS); backlog.noteReady(ready('c'), NOW - AGED_MS - 5);
  backlog.hold('ready:space-1:c', 'review-off', NOW);
  assert.deepEqual(backlog.aged(NOW).map(entry => entry.itemId), ['a', 'c']);
  assert.deepEqual(backlog.deliverable().map(entry => entry.itemId), ['a', 'b']);
  assert.equal(AGED_MS, 4 * 60 * 60 * 1000);
});

test('planning is pure, and the module only records: no timer, process, network, git, lock or model', () => {
  const state = { version: 1, seq: 3, handoff: null, reasons: {}, refusals: 0, ready: [{ ...ready('a'), state: 'deliverable', notedAt: NOW }] };
  const frozen = structuredClone(state), input = observed();
  const first = plan(state, input), second = plan(state, input);
  assert.deepEqual(first, second); assert.deepEqual(state, frozen); assert.match(first.handoffId, /^H4-/);
  const source = fs.readFileSync(path.join(__dirname, '../integrator-handoff.cjs'), 'utf8');
  const required = [...source.matchAll(/require\('([^']+)'\)/g)].map(match => match[1]).sort();
  assert.deepEqual(required, ['./queue-dispatch.cjs', 'node:crypto', 'node:fs', 'node:path']);
  // The message text tells the integrator about the lock; the code outside that text never names it.
  const start = source.indexOf('function handoffText('), end = source.indexOf('\n}\n', start);
  assert.ok(start > 0 && end > start);
  const code = (source.slice(0, start) + source.slice(end)).replace(/^\s*\/\/.*$/gm, '');
  for (const word of ['setTimeout', 'setInterval', 'setImmediate', 'child_process', 'spawn', 'execFile', 'fetch(', 'http', 'net.', 'integrator-lock', 'merge --', "'git'", 'rev-parse']) {
    assert.ok(!code.includes(word), word);
  }
  // Not connected yet: nothing in the app loads it.
  const app = path.join(__dirname, '..');
  for (const name of fs.readdirSync(app).filter(file => /\.(cjs|js)$/.test(file) && file !== 'integrator-handoff.cjs')) {
    assert.ok(!fs.readFileSync(path.join(app, name), 'utf8').includes('integrator-handoff'), name);
  }
});
