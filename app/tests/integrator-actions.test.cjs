const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const vm = require('node:vm');
const { uiError } = require('../ui-errors.cjs');
const locale = require('../ui-locale.js');
const rules = require('../queue-dispatch.cjs');
const backgroundOperation = require('../background-operation.cjs');
const { IntegrationHandoffs, FILE } = require('../integrator-handoff.cjs');

// The person's own actions on an integration handoff (B6 E2b, checkpoint H7a): the real `register`
// wrapper, the real `handoff` entry and the real overview from main.cjs, on a real record.
// Synthetic deliveries; nothing is sent.
const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
const NOW = 1_800_000_000_000, MAIN = 'a'.repeat(40), HEAD2 = 'b'.repeat(40);
const INTEGRATOR = { sessionId: 'integrator', nativeId: 'native-integrator' };
const commitOf = name => (name.charCodeAt(0).toString(16).padStart(2, '0')).repeat(20);
const key = name => `ready:shared:${name}`;
const ready = name => ({ key: key(name), roomId: 'shared', itemId: name, branch: `lane/${name}`, commit: commitOf(name), memberName: `Member ${name}`, text: `Task ${name}` });
const integratorSession = (extra = {}) => ({ id: 'integrator', nativeId: 'native-integrator', provider: 'claude', state: 'idle', background: 0, scheduled: 0, backgroundStale: false,
  chatAvailable: true, liveDraft: '', controlRevision: 0, serviceCapabilities: [rules.CAPABILITY], fleet: [], messages: [], ...extra });
function slice(start, end) { const a = source.indexOf(start), b = source.indexOf(end, a + start.length); assert.ok(a > 0 && b > a, start); return source.slice(a, b); }
function fixture(t, enabled = true, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-integrator-actions-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const handoffs = new IntegrationHandoffs(directory);
  const handlers = new Map(), f = { directory, file: path.join(directory, FILE), handoffs, handlers, broadcasts: 0, schedules: 0 };
  // The dispatcher as the entry sees it: its schedule, and the engine fault it kept (none unless a test sets one).
  f.dispatcher = { schedule() { f.schedules += 1; }, integrationError: null };
  const context = vm.createContext({ applicationHandlers: handlers, backgroundOperation, uiError, ipcMain: { handle() {} }, integrationHandoffs: enabled ? handoffs : null, integrationFault: null, Date,
    broadcastRoom: async () => { f.broadcasts += 1; }, queueDispatcher: options.noDispatcher ? null : f.dispatcher });
  vm.runInContext(slice('function register(name, handler) {', 'async function replaceBackendSockets'), context);
  vm.runInContext(slice('function handoffOverview(handoffs) {', '\n// One notice for one reason of the integration handoff'), context);
  vm.runInContext(slice("  register('handoff', async (c, action, value, choice) => {", "  register('rename',"), context);
  const client = { call: async () => ({ sessions: [] }), entries: [{ state: { sessions: [{ id: 'old' }], capabilities: [] } }], refresh: async () => {}, snapshot: () => ({ wakePolicy: { enabled: true }, sessions: [{ id: 'old' }] }) };
  f.person = (...args) => handlers.get('handoff')({ client }, ...args);
  f.agent = (...args) => {
    const actor = { id: 'integrator', nativeId: 'native-integrator', name: 'Integrator', provider: 'claude', turnId: 'turn', callId: 'call', operationId: 'op' };
    const c = { background: true, actor, client, view: { selected: actor.id }, win: { destroy() {} }, checkActor: async () => {} };
    return backgroundOperation.run(actor, () => handlers.get('handoff')(c, ...args), { context: c, valid: async () => {} });
  };
  f.states = () => Object.fromEntries(handoffs.snapshot().ready.map(entry => [entry.itemId, entry.state + (entry.reason ? ':' + entry.reason : '')]));
  f.bytes = () => fs.readFileSync(f.file, 'utf8');
  // Deliver the names, hand them out and let the handoff wait without a reply.
  f.waiting = names => {
    for (const name of names) handoffs.noteReady(ready(name), NOW);
    const view = { integrator: INTEGRATOR, session: integratorSession(), complete: true, wakePolicy: { enabled: true }, now: NOW, idleSince: new Map([['integrator', NOW - rules.IDLE_SETTLE_MS]]), humanAt: new Map(), mainHead: MAIN };
    const opened = handoffs.advance(view, NOW);
    handoffs.confirmSent(opened.handoffId, { tag: 'tag-1', control: 0 }, NOW);
    const silent = { integrator: INTEGRATOR, complete: true, now: NOW + 60000, idleSince: new Map([['integrator', NOW + 60000 - rules.IDLE_SETTLE_MS]]),
      session: integratorSession({ messages: [{ id: 'tag-1', role: 'user', text: 'handoff', time: NOW }] }) };
    handoffs.settle(handoffs.plan(silent), {}, NOW + 60000);
    return opened.handoffId;
  };
  return f;
}
const refused = name => error => error.uiMessage?.key === name;

test('the person retries one delivery or a whole reason, deals with a waiting handoff, and answers a question', async t => {
  const f = fixture(t);
  for (const name of ['a', 'b', 'c']) f.handoffs.noteReady(ready(name), NOW);
  f.handoffs.hold(key('a'), 'review-off', NOW); f.handoffs.hold(key('b'), 'merge-unverified', NOW); f.handoffs.hold(key('c'), 'merge-unverified', NOW);
  // One delivery; then everything under one reason.
  assert.deepEqual(await f.person('retryDelivery', key('a')), { released: [key('a')] });
  assert.deepEqual(await f.person('retryReason', 'merge-unverified'), { released: [key('b'), key('c')] });
  assert.deepEqual(f.states(), { a: 'deliverable', b: 'deliverable', c: 'deliverable' });
  assert.deepEqual([f.broadcasts, f.schedules], [2, 2], 'Every window is told and the dispatcher looks again after each change');
  // A handoff that waits: dealt with, with a retry.
  const g = fixture(t);
  const first = g.waiting(['a', 'b']);
  assert.deepEqual(await g.person('resolve', first, true), { released: [key('a'), key('b')], held: [] });
  assert.equal(g.handoffs.snapshot().handoff, null);
  // Dealt with, without a retry: what was inside stays on hold, and the person can retry the reason later.
  const h = fixture(t);
  const second = h.waiting(['a']);
  assert.deepEqual(await h.person('resolve', second), { released: [], held: [key('a')] });
  assert.deepEqual(h.states(), { a: 'held:no-reply' });
  assert.deepEqual(await h.person('retryReason', 'no-reply'), { released: [key('a')] });
  // The retry on the reason a handoff waits on is the same as "dealt with, retry".
  const i = fixture(t);
  i.waiting(['a']);
  assert.deepEqual(await i.person('retryReason', 'no-reply'), { released: [key('a')] });
  assert.equal(i.handoffs.snapshot().handoff, null);
  // A question (a main commit that may be installed) ends with the person's answer.
  const q = fixture(t);
  const id = q.waiting(['a']);
  q.handoffs.resolveHandoff(id, { retry: true }, NOW);
  const view = { integrator: INTEGRATOR, session: integratorSession(), complete: true, wakePolicy: { enabled: true }, now: NOW + 70000, idleSince: new Map([['integrator', NOW + 70000 - rules.IDLE_SETTLE_MS]]), humanAt: new Map(), mainHead: MAIN };
  const again = q.handoffs.advance(view, NOW + 70000);
  q.handoffs.confirmSent(again.handoffId, { tag: 'tag-2', control: 0 }, NOW + 70000);
  const answered = { integrator: INTEGRATOR, complete: true, now: NOW + 130000, idleSince: new Map([['integrator', NOW + 130000 - rules.IDLE_SETTLE_MS]]),
    session: integratorSession({ messages: [{ id: 'tag-2', role: 'user', text: 'handoff', time: NOW }, { id: 'r', role: 'assistant', text: `MERGED ${commitOf('a')} as ${HEAD2} tests 3/3`, time: NOW + 1 }] }) };
  q.handoffs.settle(q.handoffs.plan(answered), { handoffId: again.handoffId, mainHead: HEAD2, verified: { [key('a')]: { verified: true, as: HEAD2 } } }, NOW + 130000);
  assert.deepEqual(await q.person('answer', `installable:${HEAD2}`), { answered: true });
  assert.deepEqual(await q.person('answer', `installable:${HEAD2}`), { answered: false });
});

test('the overview shows what is on hold and why, the handoff that waits with its question, and the open reasons; looking changes nothing', async t => {
  const f = fixture(t);
  for (const name of ['a', 'b', 'c', 'd']) f.handoffs.noteReady(ready(name), NOW);
  f.handoffs.hold(key('c'), 'review-off', NOW); f.handoffs.hold(key('d'), 'review-off', NOW);
  const view = { integrator: INTEGRATOR, session: integratorSession(), complete: true, wakePolicy: { enabled: true }, now: NOW, idleSince: new Map([['integrator', NOW - rules.IDLE_SETTLE_MS]]), humanAt: new Map(), mainHead: MAIN };
  const opened = f.handoffs.advance(view, NOW);
  f.handoffs.confirmSent(opened.handoffId, { tag: 'tag-1', control: 0 }, NOW);
  // A handoff that only awaits the integrator's answer is not shown as waiting for the person.
  const sent = await f.person('list');
  assert.deepEqual([sent.waiting, sent.summary.handoff.status, sent.summary.handed], [null, 'sent', 2]);
  const asking = { integrator: INTEGRATOR, complete: true, now: NOW + 60000, idleSince: new Map([['integrator', NOW + 60000 - rules.IDLE_SETTLE_MS]]),
    session: integratorSession({ messages: [{ id: 'tag-1', role: 'user', text: 'handoff', time: NOW }, { id: 'r', role: 'assistant', text: '需要你决定：a 和 b 改了同一处', time: NOW + 1 }] }) };
  f.handoffs.settle(f.handoffs.plan(asking), {}, NOW + 60000);
  const before = f.bytes();
  const seen = JSON.parse(JSON.stringify(await f.person('list')));
  assert.deepEqual(seen.summary, { deliverable: 0, held: 2, handed: 2, since: null, handoff: { id: opened.handoffId, status: 'waiting', confirmed: true, sentAt: NOW, integrator: INTEGRATOR } });
  assert.deepEqual(seen.held, [{ reason: 'review-off', count: 2, entries: ['c', 'd'].map(name => ({ key: key(name), roomId: 'shared', itemId: name, branch: `lane/${name}`, commit: commitOf(name), text: `Task ${name}`, memberName: `Member ${name}` })) }]);
  assert.deepEqual([seen.waiting.handoffId, seen.waiting.reason, seen.waiting.question, seen.waiting.sessionId, seen.waiting.entries.map(entry => entry.itemId)],
    [opened.handoffId, `conflict:${opened.handoffId}`, 'a 和 b 改了同一处', 'integrator', ['a', 'b']]);
  assert.deepEqual(seen.reasons.map(reason => [reason.reason, reason.notice]), [['review-off', 'pending'], [`conflict:${opened.handoffId}`, 'pending']]);
  assert.deepEqual(seen.unknownNotices, []);
  assert.equal(f.bytes(), before); assert.deepEqual([f.broadcasts, f.schedules], [0, 0], 'Looking announces nothing');
});

test('an agent can do none of this, whatever it names; without an originating operation its call does not reach the entry', async t => {
  const f = fixture(t);
  const id = f.waiting(['a']);
  f.handoffs.noteReady(ready('b'), NOW); f.handoffs.hold(key('b'), 'review-off', NOW);
  const before = f.bytes();
  for (const args of [['list'], ['retryDelivery', key('b')], ['retryReason', 'review-off'], ['retryReason', 'no-reply'], ['resolve', id, true], ['resolve', id], ['answer', `installable:${HEAD2}`], ['made-up'], []]) {
    await assert.rejects(f.agent(...args), refused('error.handoff.personOnly'), JSON.stringify(args));
  }
  assert.equal(f.bytes(), before); assert.deepEqual([f.broadcasts, f.schedules], [0, 0]);
  // The refusal is the entry's own: the general background gate has no row for this method.
  assert.equal(backgroundOperation.deliveryTargets('handoff', ['resolve', id, true]), null);
  await assert.rejects(f.handlers.get('handoff')({ background: true, client: {} }, 'resolve', id, true), /originating operation/);
  assert.equal(f.bytes(), before);
  // Also with the switch closed an agent is told it is the person's, not whether the feature exists.
  const closed = fixture(t, false);
  await assert.rejects(closed.agent('list'), refused('error.handoff.personOnly'));
});

test('with the switch closed the person is told handoffs are not enabled, and nothing is created', async t => {
  const f = fixture(t, false);
  for (const args of [['list'], ['retryDelivery', key('a')], ['retryReason', 'review-off'], ['resolve', 'H1-00000000', true], ['answer', `installable:${HEAD2}`]]) {
    await assert.rejects(f.person(...args), refused('error.handoff.unavailable'), JSON.stringify(args));
  }
  assert.equal(fs.existsSync(f.file), false); assert.deepEqual([f.broadcasts, f.schedules], [0, 0]);
});

test('a fault the dispatcher kept for the engine is shown to the person, also when the engine never started', async t => {
  // The engine runs and one of its passes failed: the overview carries the fault, as a copy.
  const f = fixture(t);
  assert.deepEqual([(await f.person('list')).started, (await f.person('list')).engineFault], [true, null]);
  f.dispatcher.integrationError = { message: 'Synthetic pass fault', at: NOW, count: 3 };
  const seen = await f.person('list');
  // (What the entry returns was made in the entry's own context: compared by content.)
  const plain = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(seen.engineFault), { message: 'Synthetic pass fault', at: NOW, count: 3 });
  seen.engineFault.message = 'changed by the caller';
  assert.equal(f.dispatcher.integrationError.message, 'Synthetic pass fault');
  assert.deepEqual([f.broadcasts, f.schedules], [0, 0], 'Looking changes and announces nothing');
  // The switch is open but the engine could not be built: there is no record. Looking says why;
  // every action is refused as "did not start", not as "not enabled"; nothing is created.
  const g = fixture(t, false);
  g.dispatcher.integrationError = { message: 'Synthetic build fault', at: NOW, count: 1 };
  const unstarted = await g.person('list');
  assert.deepEqual(plain(unstarted), { started: false, engineFault: { message: 'Synthetic build fault', at: NOW, count: 1 } });
  unstarted.engineFault.message = 'changed by the caller';
  assert.equal(g.dispatcher.integrationError.message, 'Synthetic build fault', 'A copy here too');
  for (const args of [['retryDelivery', key('a')], ['retryReason', 'review-off'], ['resolve', 'H1-00000000', true], ['answer', `installable:${HEAD2}`], ['made-up']]) {
    await assert.rejects(g.person(...args), refused('error.handoff.notStarted'), JSON.stringify(args));
  }
  assert.equal(fs.existsSync(g.file), false); assert.deepEqual([g.broadcasts, g.schedules], [0, 0]);
  // An agent is refused first, whatever the state.
  await assert.rejects(g.agent('list'), refused('error.handoff.personOnly'));
  // No dispatcher at all (it could not start): as with the switch closed.
  const h = fixture(t, false, { noDispatcher: true });
  for (const args of [['list'], ['retryDelivery', key('a')]]) await assert.rejects(h.person(...args), refused('error.handoff.unavailable'), JSON.stringify(args));
});

test('an action that does not fit the record\'s state is refused in words, and nothing changes', async t => {
  const f = fixture(t);
  const id = f.waiting(['a']);
  f.handoffs.noteReady(ready('b'), NOW);
  const before = f.bytes();
  const stale = [['retryDelivery', key('a')], ['retryDelivery', key('b')], ['retryDelivery', key('zz')], ['retryDelivery', undefined], ['retryReason', 'made-up'], ['retryReason', undefined],
    ['resolve', 'H9-other', true], ['resolve', undefined], ['answer', 'review-off'], ['answer', 'installable:'], ['answer', 7], ['made-up', id], [undefined], ['constructor'], ['__proto__']];
  for (const args of stale) await assert.rejects(f.person(...args), refused('error.handoff.invalid'), JSON.stringify(args));
  assert.equal(f.bytes(), before); assert.deepEqual([f.broadcasts, f.schedules], [0, 0]);
  // A handoff that was already dealt with (from another window, say) cannot be dealt with twice.
  await f.person('resolve', id, true);
  await assert.rejects(f.person('resolve', id, true), refused('error.handoff.invalid'));
  // A retry that is true only when it is exactly true: anything else leaves the deliveries on hold.
  const g = fixture(t);
  const other = g.waiting(['a']);
  assert.deepEqual(await g.person('resolve', other, 'yes'), { released: [], held: [key('a')] });
  // A record that cannot be read is an error of its own, not "cannot be done now".
  const h = fixture(t);
  h.waiting(['a']);
  fs.chmodSync(h.directory, 0o500);
  try { await assert.rejects(h.person('retryReason', 'no-reply'), refused('error.handoff.record')); }
  finally { fs.chmodSync(h.directory, 0o700); }
  await assert.rejects(h.person('list'), refused('error.handoff.record'), 'Until the record is read again, nothing is shown from it');
  assert.deepEqual([h.broadcasts, h.schedules], [0, 0]);
  // A refusal of the record that is not about the action fitting (the next state would be invalid, or too
  // large to save) is a fault of the record: said as that, never as "look again and retry", and kept.
  const k = fixture(t);
  k.handoffs.noteReady(ready('a'), NOW); k.handoffs.hold(key('a'), 'review-off', NOW);
  const real = k.handoffs.retryReady.bind(k.handoffs);
  k.handoffs.retryReady = () => { throw Object.assign(Error('The handoff record would be too large; nothing was changed'), { code: 'HANDOFF_STATE' }); };
  await assert.rejects(k.person('retryDelivery', key('a')), refused('error.handoff.record'));
  assert.deepEqual([k.broadcasts, k.schedules, k.states()], [0, 0, { a: 'held:review-off' }]);
  const fault = (await k.person('list')).fault;
  assert.equal(fault.message, 'The handoff record would be too large; nothing was changed'); assert.ok(Number.isFinite(fault.at));
  // The record marks its own "does not fit" refusals; nothing else counts as stale.
  k.handoffs.retryReady = real;
  for (const call of [() => k.handoffs.retryReady(key('zz')), () => k.handoffs.retryReason('made-up'), () => k.handoffs.resolveHandoff('H9-other', {}), () => k.handoffs.answer('review-off')]) {
    assert.throws(call, error => error.code === 'HANDOFF_STATE' && error.stale === true);
  }
  assert.throws(() => k.handoffs.hold(key('zz'), 'review-off', NOW), error => error.code === 'HANDOFF_STATE' && error.stale === undefined);
});

test('the entry is wired for the person\'s window, and its words exist in both languages', () => {
  const preload = fs.readFileSync(path.join(__dirname, '../preload.cjs'), 'utf8');
  assert.match(preload, /for \(const name of \['queueSecretary', 'integrator', 'handoff', /);
  assert.match(source, /const localQueue = name === 'queueSecretary' \|\| name === 'integrator' \|\| name === 'handoff' \|\| /);
  // The record the entry acts on is the one the engine was built with, and is set nowhere else.
  assert.equal(source.match(/integrationHandoffs = /g).length, 2, 'Its declaration as null and the one assignment');
  assert.match(source, /let integrationHandoffs = null;/);
  const builder = source.indexOf('function integrationEngine(dispatcher) {'), next = source.indexOf('\nfunction ', builder + 10), assigned = source.indexOf('  integrationHandoffs = handoffs;');
  assert.ok(assigned > builder && assigned < next);
  for (const name of ['error.handoff.personOnly', 'error.handoff.unavailable', 'error.handoff.notStarted', 'error.handoff.invalid', 'error.handoff.record']) {
    const zh = locale.format('zh', name), en = locale.format('en', name);
    assert.ok(zh && en && zh !== en && zh !== name && en !== name, name);
  }
});
