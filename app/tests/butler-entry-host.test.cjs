'use strict';
// The entry a person window is given, built from the real core's person view. Nothing is started and no model is
// called: the record store and the ledger are the real ones in a temporary folder, the host is a stand-in, and the
// identities, references and amounts are synthetic.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { entry, outcome, ENTRY_ACTIONS, STARTABLE } = require('../butler-entry-host.cjs');
const { entryView, ACTIONS } = require('../butler-entry-view.js');
const { ButlerRole } = require('../butler-role.cjs');
const { ButlerLedger } = require('../butler-ledger.cjs');
const { ButlerPerson } = require('../butler-person.cjs');

const person = Symbol('the person'), now = Date.UTC(2026, 10, 11, 12);
// What must never reach a window.
const identity = { sessionId: 'host-butler-session', nativeId: 'host-butler-native' };
const runner = { runnerRef: 'host-runner-ref', backendRef: 'host-backend-ref', purpose: 'butler', profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro' };
const PRIVATE = [identity.sessionId, identity.nativeId, runner.runnerRef, runner.backendRef];
const selected = (extra = {}) => ({ identity: { ...identity }, runner: { ...runner }, ...extra });
const reminder = { amountMicros: 2_000_000, dayBoundary: 'UTC' };
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-entry-host-')); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const role = new ButlerRole(directory, { authorizePerson: actor => actor === person });
  const ledger = new ButlerLedger(directory, { now: () => now });
  const backend = { snapshot: () => ({ state: 'unprepared', ready: false, blocked: ['runtime-unqualified'] }) };
  const make = extra => new ButlerPerson({ role, ledger, backend, now: () => now, authorizePerson: actor => actor === person, ...options, ...extra });
  return { directory, role, ledger, make };
}
const hidden = value => { const text = JSON.stringify(value); for (const word of PRIVATE) assert.equal(text.includes(word), false, word); return value; };

test('nothing designated: the entry says so, offers no designation, and the window is told none can be made', t => {
  const f = fixture(t), view = f.make().status(person), shown = entry(view);
  assert.equal(view.state, 'empty');
  assert.deepEqual(shown, { version: 1, role: { revision: 0, selected: null }, reminder, uncertain: false, startable: false,
    backend: { state: 'unprepared', ready: false, blocked: ['runtime-unqualified'] }, intake: { recordPeriod: 'off' }, hold: null, usage: null,
    reviewAvailable: false, actions: ['recheck'] });
  assert.deepEqual(entryView(shown), { visible: true, state: 'empty', revision: 0, actions: [], choice: null, usage: null, offer: null, startable: null, later: true });
  // A record table is never offered where nothing is designated.
  assert.equal(entry(view, { reviewAvailable: true }).reviewAvailable, false);
});

test('a designation is shown by its configuration and a line, never by its identity or references', t => {
  const f = fixture(t); f.role.set(person, selected(), 0);
  const view = f.make().status(person), shown = hidden(entry(view, { reviewAvailable: true }));
  assert.equal(view.state, 'selected-disabled'); assert.deepEqual(view.role.selected.identity, identity, 'The core\'s own view carries the identity');
  assert.deepEqual(shown.role, { revision: 1, selected: { runner: { profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro' }, budget: null } });
  assert.deepEqual([shown.uncertain, shown.reviewAvailable, shown.actions], [false, true, ['revoke', 'recheck']]);
  // No limit of its own: the window shows the reminder line the person agreed to, and this version cannot start it.
  const drawn = entryView(shown);
  assert.equal(drawn.state, 'blocked-build'); assert.deepEqual(drawn.actions, ['revoke']);
  assert.deepEqual(drawn.choice, { name: 'DeepSeek pro', profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro', limitMicros: 2_000_000, dayBoundary: 'UTC' });
  assert.equal(drawn.usage, null, 'No recorded wake-up is no reading, not zero');
  // A limit the designation records is passed on as recorded and comes first.
  f.role.set(person, selected({ budget: { limitMicros: 500_000 } }), 1);
  const limited = hidden(entry(f.make().status(person)));
  assert.deepEqual(limited.role.selected.budget, { limitMicros: 500_000, dayBoundary: 'UTC' }); assert.deepEqual(limited.reminder, reminder);
  assert.equal(entryView(limited).choice.limitMicros, 500_000);
  // A limit that is recorded but cannot be read stays unreadable: the reminder line does not take its place.
  for (const budget of [{ limitMicros: '500000', dayBoundary: 'UTC' }, { limitMicros: -1, dayBoundary: 'UTC' }, { dayBoundary: 'UTC' }, { limitMicros: 500_000 }, 'half a dollar', 500_000, []]) {
    const odd = entry({ ...view, role: { ...view.role, selected: { ...view.role.selected, budget } } });
    assert.deepEqual(odd.role.selected.budget, { limitMicros: null, dayBoundary: null }, JSON.stringify(budget)); assert.deepEqual(odd.reminder, reminder);
    assert.equal(entryView(odd).state, 'unknown'); assert.equal(entryView(odd).choice, null); assert.deepEqual(entryView(odd).actions, ['revoke']);
  }
  for (const budget of [null, undefined]) assert.equal(entry({ ...view, role: { ...view.role, selected: { ...view.role.selected, budget } } }).role.selected.budget, null);
});

test('a host that reports ready is not a butler that can start: this version cannot, and the entry says only that', t => {
  const f = fixture(t); f.role.set(person, selected({ budget: { limitMicros: 2_000_000 } }), 0);
  const view = f.make({ backend: { snapshot: () => ({ state: 'ready', ready: true, binding: { secret: 'omit' } }) } }).status(person), shown = hidden(entry(view, { reviewAvailable: true }));
  assert.deepEqual(shown.backend, { state: 'ready', ready: true, blocked: [] }); assert.equal(shown.startable, false);
  assert.equal(entryView(shown).state, 'blocked-build'); assert.equal(JSON.stringify(shown).includes('omit'), false);
  assert.equal(STARTABLE, false);
  // The constant is a statement about this build. The desktop gives the host no pre-start qualification (its four
  // checks default to false) and the core's activation is off. If either changes, this fails first: `STARTABLE`
  // and the states that follow from it (ready, recording, held, the record table) then have to be decided on purpose.
  const host = fs.readFileSync(path.join(__dirname, '../butler-backend-host.cjs'), 'utf8');
  const composed = host.slice(host.indexOf('return new DesktopButlerBackend('), host.indexOf('module.exports'));
  assert.ok(composed.length > 0); assert.equal(/qualif/i.test(composed.replace(/\/\/[^\n]*/g, '')), false, 'The desktop passes the host no qualification');
  assert.deepEqual([view.activation, view.recordPeriod, view.actions.open], ['off', 'off', false]);
});

test('what the core cannot establish is passed on as uncertain, and an unreadable record as unreadable', t => {
  const f = fixture(t); f.role.set(person, selected(), 0);
  // The ledger cannot be read: the core's state is unknown, and so is the window's, whatever else adds up.
  const view = f.make({ ledger: { snapshot() { throw Error('PRIVATE_LEDGER_BODY'); } } }).status(person), shown = hidden(entry(view));
  assert.equal(view.state, 'unknown'); assert.equal(shown.uncertain, true); assert.equal(shown.usage, null);
  assert.deepEqual([entryView(shown).state, entryView(shown).actions], ['unknown', ['recheck', 'revoke']]); assert.equal(JSON.stringify(shown).includes('PRIVATE'), false);
  // A host that cannot be read gives no host answer at all.
  const lost = entry(f.make({ backend: { snapshot() { throw Error('PRIVATE_HOST_BODY'); } } }).status(person));
  assert.equal(lost.backend, null); assert.equal(lost.uncertain, true); assert.equal(JSON.stringify(lost).includes('PRIVATE'), false);
  // No readable designation record: not "none designated", and nothing to do from the window.
  const missing = f.make({ role: null }).status(person);
  assert.equal(missing.role.available, false);
  assert.deepEqual(entry(missing), { version: 1, unavailable: true, actions: [] });
  assert.deepEqual(entryView(entry(missing)), { visible: true, state: 'unknown', revision: null, actions: [], choice: null, usage: null });
  for (const value of [undefined, null, 'view', [], { role: null }, { role: { available: true, revision: -1, selected: null } }, { role: { available: true, revision: '0', selected: null } },
    { role: { available: 'yes', revision: 0, selected: null } }, { role: { available: true, revision: 0, selected: 'butler' } }, { role: { available: true, revision: 0, selected: [] } }])
    assert.deepEqual(entry(value), { version: 1, unavailable: true, actions: [] });
});

test('usage is passed on only as a recorded reading, and a pause only as the core\'s recorded reason', t => {
  const f = fixture(t); f.role.set(person, selected(), 0);
  const snapshot = { attempts: [
    { batchId: 'known', startedAt: now, usage: { costMicros: 6100, inputTokens: 2, totalTokens: 5074, source: 'PRIVATE_SOURCE_BODY', estimated: true } },
    { batchId: 'unknown', startedAt: now, usage: null }], batches: [], events: [], activeBatch: null, sequence: 4 };
  const view = f.make({ ledger: { snapshot: () => snapshot } }).status(person), shown = hidden(entry(view));
  assert.equal(view.usage.state, 'recorded');
  assert.deepEqual(shown.usage, { utcDay: '2026-11-11', today: { recordedRunCount: 2, costMicros: { knownLowerBound: 6100, unknownRuns: 1 }, tokens: { totalTokens: { knownLowerBound: 5074, unknownRuns: 1 } } } });
  assert.deepEqual(entryView(shown).usage, { day: '2026-11-11', runs: 2, unknown: 1, totalTokens: 5074, costMicros: 6100 });
  assert.equal(JSON.stringify(shown).includes('PRIVATE_SOURCE_BODY'), false); assert.equal(Object.hasOwn(shown.usage, 'guard'), false);
  // No recorded wake-up is "unverified" to the core: no reading reaches the window, and nothing is turned into a zero.
  const idle = f.make().status(person); assert.equal(idle.usage.state, 'unverified'); assert.equal(entry(idle).usage, null);
  for (const usage of [{ state: 'unavailable' }, { ...view.usage, state: 'unverified' }, { ...view.usage, utcDay: 20261111 }, { ...view.usage, today: { ...view.usage.today, recordedRunCount: -1 } },
    { ...view.usage, today: { ...view.usage.today, costMicros: { knownLowerBound: null, unknownRuns: 0 } } }, { ...view.usage, today: { ...view.usage.today, tokens: {} } }])
    assert.equal(entry({ ...view, usage }).usage, null);
  // A pause is the reason of a failed batch the core recorded for this designation; its ids and positions stay behind.
  f.ledger.ingest({ eventId: 'request', sourceRef: 'task:one', kind: 'request', payload: { text: 'Synthetic task' } });
  const batch = f.ledger.beginBatch({ selectionRevision: 1, identity, runnerRef: runner.runnerRef });
  assert.equal(entry(f.make().status(person)).hold, null, 'A running batch is not a pause');
  f.ledger.failBatch(batch.batchId, 'usage-cost-unknown');
  const paused = f.make().status(person), held = hidden(entry(paused));
  assert.equal(paused.pause.batchId, batch.batchId); assert.equal(held.hold, 'usage-cost-unknown'); assert.equal(JSON.stringify(held).includes(batch.batchId), false);
  for (const pause of [null, undefined, 'usage-cost-unknown', { reason: '' }, { reason: 7 }, { reason: 'x'.repeat(121) }]) assert.equal(entry({ ...paused, pause }).hold, null);
});

test('only the actions the main process\'s call has a name for are offered, and only the reminder the person agreed to', t => {
  const f = fixture(t); f.role.set(person, selected(), 0);
  const view = f.make({ stopOwned: async () => ({}) }).status(person);
  // The core says it could stop this instance (`close`); the window has no control for it and the call has no such name.
  assert.equal(view.actions.close, true); assert.deepEqual(entry(view).actions, ['revoke', 'recheck']);
  assert.deepEqual(entry({ ...view, actions: { designate: true, revoke: true, recheck: true, open: true, close: true, setActive: true, status: true, anything: true } }).actions, ['designate', 'revoke', 'recheck']);
  for (const actions of [undefined, null, ['designate', 'revoke'], 'revoke', { revoke: 'true' }, { revoke: 1 }]) assert.deepEqual(entry({ ...view, actions }).actions, []);
  // The names are the ones the window knows and the main process's handler accepts.
  assert.deepEqual([...ENTRY_ACTIONS].sort(), [...ACTIONS].sort());
  const main = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8'), handler = main.slice(main.indexOf("register('butler',"), main.indexOf("applicationHandlers.delete('butler')"));
  const accepted = JSON.parse(handler.match(/if \(!(\[[^\]]+\])\.includes\(action\)/)[1].replace(/'/g, '"'));
  assert.deepEqual(accepted, ['status', 'recheck', 'designate', 'revoke', 'setActive']);
  for (const name of ENTRY_ACTIONS) assert.ok(accepted.includes(name), name);
  for (const name of ['open', 'close']) { assert.equal(accepted.includes(name), false); assert.equal(ENTRY_ACTIONS.includes(name), false); }
  // The reminder line is the one recorded as agreed (USD, per UTC day); anything else is no line.
  assert.deepEqual(view.dailyReminder, { currency: 'USD', amountMicros: 2_000_000, dayBoundary: 'UTC', onReached: 'undecided' }); assert.deepEqual(entry(view).reminder, reminder);
  for (const dailyReminder of [undefined, null, { ...view.dailyReminder, currency: 'EUR' }, { ...view.dailyReminder, amountMicros: 2.5 }, { ...view.dailyReminder, dayBoundary: 'local' }, 2_000_000])
    assert.equal(entry({ ...view, dailyReminder }).reminder, null);
  // Names that are not short plain words are not passed on.
  const odd = entry({ ...view, role: { ...view.role, selected: { ...view.role.selected, configuration: { profile: 7, provider: '', model: 'm'.repeat(121) } } } });
  assert.deepEqual(odd.role.selected.runner, { profile: null, provider: null, model: null }); assert.equal(entryView(odd).state, 'unknown');
});

test('the result of an action keeps its plain facts and leaves behind what it acted on', async t => {
  const f = fixture(t); f.role.set(person, selected(), 0);
  let stopped; const api = f.make({ stopOwned: async target => { stopped = target; return { target, stopped: true, cleanupConfirmed: true }; } });
  const raw = await api.revoke(person, 1);
  assert.deepEqual(raw.shutdown.target.identity, identity, 'The core\'s own result names what it stopped'); assert.equal(stopped.runner.runnerRef, runner.runnerRef);
  assert.deepEqual(hidden(outcome(raw)), { activation: 'off', recordPeriod: 'off', revoked: true, revision: 2,
    shutdown: { activation: 'off', recordPeriod: 'off', status: 'confirmed', stopped: true, cleanupConfirmed: true } });
  // Without a way to stop, the result says the stop is unconfirmed and why, and no more.
  f.role.set(person, selected(), 2);
  assert.deepEqual(hidden(outcome(await f.make().setActive(person, false, 3))), { activation: 'off', recordPeriod: 'off', status: 'unconfirmed', reason: 'owned-stop-unavailable', stopped: null, cleanupConfirmed: null });
  assert.deepEqual(outcome(f.make().designate(person, 3)), { activation: 'off', recordPeriod: 'off', status: 'blocked', reason: 'trusted-candidate-unavailable' });
  // Only named plain facts: no objects, no long text, nothing nested deeper than the stop's own result.
  assert.deepEqual(outcome({ status: 'confirmed', target: { identity }, identity, runner, revoked: 'yes', revision: -1, reason: 'r'.repeat(121), stopped: { yes: true },
    shutdown: { status: 'unconfirmed', target: { identity }, shutdown: { status: 'nested' }, extra: 'x' } }), { status: 'confirmed', shutdown: { status: 'unconfirmed' } });
  for (const value of [undefined, null, 'done', 7, [], new (class Result {})()]) assert.equal(outcome(value), null);
  assert.deepEqual(outcome({ shutdown: 'stopped' }), { shutdown: null });
});
