// R117 (the person, 2026-11-23: 「我点了卡,但是你这边完全没反应」): the butler's own rotation episode left invalid
// holds every wake; the person is told at once which step ends it, and nothing is sent meanwhile.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const vm = require('node:vm'), { EventEmitter } = require('node:events');
const { ButlerLedger } = require('../butler-ledger.cjs'), { ButlerIngress } = require('../butler-ingress.cjs'), { RoomState } = require('../room-state.cjs');
const { StewardWake } = require('../steward-wake.cjs'), { QueueDispatcher, CAPABILITY } = require('../queue-dispatch.cjs'), { PersonActions } = require('../person-actions.cjs');
const locale = require('../ui-locale.js');
const NOW = 1800000000000, identity = { sessionId: 'butler', nativeId: 'native-butler' };

function session(id, nativeId, extra = {}) {
  return { id, nativeId, provider: 'claude', model: 'claude-test-model', state: 'idle', roomIds: [], serviceCapabilities: [CAPABILITY], chatAvailable: true,
    background: 0, scheduled: 0, messages: [], fleet: [], liveDraft: '', createdAt: NOW - 3600000, ...extra };
}
function fixture(t, sessions, { runtimeVersion, event = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-b-own-handoff-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { now: NOW }, room = new RoomState(dir), ledger = new ButlerLedger(dir, { now: () => clock.now });
  const ingress = new ButlerIngress(dir, { roomState: room, ledger, now: () => clock.now }), actions = new PersonActions({ ingress, now: () => clock.now });
  const calls = [], records = [], changes = [];
  const client = Object.assign(new EventEmitter(), {
    close() {}, refresh: async () => {},
    snapshot: () => ({ sessions, rooms: [], wakePolicy: { enabled: true }, operatorPolicy: { domains: [] } }),
    route: () => ({ client, state: { capabilities: [CAPABILITY], ...(runtimeVersion ? { runtimeVersion } : {}) } }),
    call: async (method, ...args) => {
      calls.push([method, ...args]);
      if (method === 'dispatch') { sessions.find(s => s.id === args[0]).state = 'working'; return 'receipt-tag'; }
      if (method === 'initial') return client.snapshot();
      throw Error(method);
    },
  });
  const wake = new StewardWake(dir, { ledger: () => ledger, selected: () => identity, now: () => clock.now, record: line => records.push(line), changed: () => changes.push(clock.now) });
  wake.set(true);
  const d = new QueueDispatcher({ roomState: room, dataDir: dir, connect: async () => client, steward: () => identity, stewardWake: wake, now: () => clock.now,
    settleMs: 8000, tickMs: 3600000, observePersonActions: s => actions.observe(s, []), transcriptRoot: path.join(dir, 'none') });
  // The person's click on a card: a person-action event the butler should hear about.
  if (event) actions.call('operatorAction', ['member', 'grant', {}], 'synthetic-domain');
  const dispatches = () => calls.filter(c => c[0] === 'dispatch').map(c => c[1]);
  const pass = async (ms = 9000) => { await d.schedule(); clock.now += ms; await d.schedule(); };
  return { clock, wake, d, dispatches, records, changes, pass };
}
const invalid = { nativeId: 'native-butler', epoch: 'epoch-a', tag: 'tag-a', state: 'invalid' };

test('the person clicks a card while the butler\'s own handoff is unresolved: told at once with the step, nothing sent', async t => {
  const butler = session('butler', 'native-butler', { rotationEpisode: { ...invalid } }), f = fixture(t, [butler]);
  assert.equal(f.wake.due(), true);
  await f.pass();
  assert.deepEqual(f.dispatches(), []);
  assert.deepEqual(f.wake.view().blocked, { since: NOW, reason: 'rotation-control-unresolved', minutes: 0, step: 'release' });
  assert.deepEqual(f.records, [{ kind: 'wakeBlocked', reason: 'rotation-control-unresolved', since: NOW }]);
  f.clock.now += 11 * 60000; await f.pass();
  assert.deepEqual(f.dispatches(), []);
  assert.equal(f.wake.view().blocked.step, 'release'); assert.equal(f.wake.view().blocked.minutes, 11);
  assert.equal(f.records.length, 1, 'one record line per hold');
});

test('the hold is said whether or not anything is due', async t => {
  const butler = session('butler', 'native-butler', { rotationEpisode: { ...invalid } }), f = fixture(t, [butler], { event: false });
  assert.equal(f.wake.due(), false);
  await f.pass();
  assert.deepEqual(f.dispatches(), []);
  assert.equal(f.wake.view().blocked?.step, 'release');
});

test('a butler backend before alpha.284 is told to update first', async t => {
  const butler = session('butler', 'native-butler', { rotationEpisode: { ...invalid } }), f = fixture(t, [butler], { runtimeVersion: '0.1.0-alpha.270' });
  await f.pass();
  assert.deepEqual(f.dispatches(), []);
  assert.equal(f.wake.view().blocked.step, 'update-backend');
});

test('once the person discards the handoff the hold ends and the waiting event wakes the butler once', async t => {
  const butler = session('butler', 'native-butler', { rotationEpisode: { ...invalid } }), f = fixture(t, [butler]);
  await f.pass();
  assert.equal(f.wake.view().blocked.step, 'release');
  butler.rotationEpisode = { ...invalid, state: 'released' };
  f.clock.now += 60000; await f.pass();
  assert.deepEqual(f.dispatches(), ['butler']);
  assert.equal(f.wake.view().blocked, undefined);
});

test('unchanged: a butler with a closed episode is woken once, as before', async t => {
  for (const state of ['complete', 'released', 'not-sent']) {
    const butler = session('butler', 'native-butler', { rotationEpisode: { ...invalid, state } }), f = fixture(t, [butler]);
    await f.pass();
    assert.deepEqual(f.dispatches(), ['butler'], state);
    assert.equal(f.wake.view().blocked, undefined, state);
  }
});

test('unchanged: another session\'s unresolved episode, an older episode of the butler, or a provider wait hold nothing', async t => {
  const other = session('member', 'native-member', { rotationEpisode: { ...invalid, nativeId: 'native-member' } });
  const f = fixture(t, [session('butler', 'native-butler'), other]);
  await f.pass();
  assert.deepEqual(f.dispatches(), ['butler']);
  const older = fixture(t, [session('butler', 'native-butler', { rotationEpisode: { ...invalid, nativeId: 'native-butler-before' } })]);
  await older.pass();
  assert.deepEqual(older.dispatches(), ['butler']);
  const waiting = fixture(t, [session('butler', 'native-butler', { rotationEpisode: { ...invalid, state: 'waiting-provider' } })]);
  await waiting.pass();
  assert.deepEqual(waiting.dispatches(), []);
  assert.equal(waiting.wake.view().blocked, undefined, 'still the ordinary ten-minute stall rule');
  assert.equal(waiting.wake.view({ held: true }).blocked.reason, 'waiting-provider');
});

test('a butler in a space keeps the in-space rule; the switch off shows nothing', async t => {
  const f = fixture(t, [session('butler', 'native-butler', { roomIds: ['room'], rotationEpisode: { ...invalid } })]);
  await f.pass();
  assert.equal(f.wake.view({ held: true }).blocked.reason, 'in-space');
  assert.equal(f.wake.view({ held: true }).blocked.step, undefined);
  const off = fixture(t, [session('butler', 'native-butler', { rotationEpisode: { ...invalid } })]);
  off.wake.set(false); await off.pass();
  assert.equal(off.wake.view().blocked, undefined);
});

test('the banner says only the reason and the person\'s step, with the butler\'s own menu label, in both languages', () => {
  const root = path.resolve(__dirname, '..', '..'), source = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
  const start = source.indexOf('function renderStewardWakeWarning('), end = source.indexOf('function render() {', start);
  const p = { textContent: '' }, parts = { p, '.steward-wake-step': {}, '.steward-wake-record': {} }, box = { hidden: true, querySelector: selector => parts[selector] };
  // No menu item for this record (steward-wake-banner-step.test.cjs has the ones with): the text names the menu path.
  const context = vm.createContext({ state: null, disconnected: false, rotationReleaseAction: () => [], backendUpdateAction: () => [], $: () => box, stewardSteps: { open() {} }, uiText: null });
  vm.runInContext(source.slice(start, end), context);
  for (const language of ['zh', 'en']) {
    context.uiText = (k, v) => locale.format(language, k, v);
    context.state = { steward: { sessionId: 'butler' }, sessions: [{ id: 'butler', name: 'Synthetic butler' }] };
    context.renderStewardWakeWarning({ minutes: 3, reason: 'rotation-control-unresolved', step: 'release' });
    assert.equal(box.hidden, false);
    assert.ok(p.textContent.includes(locale.format(language, 'queue.releaseRotation', { name: 'Synthetic butler' })), p.textContent);
    assert.ok(!p.textContent.includes(locale.format(language, 'menu.updateThisBackend')));
    context.renderStewardWakeWarning({ minutes: 3, reason: 'rotation-control-unresolved', step: 'update-backend' });
    assert.ok(p.textContent.includes(locale.format(language, 'menu.updateThisBackend')), p.textContent);
    context.state = null;
    context.renderStewardWakeWarning({ minutes: 3, reason: 'rotation-control-unresolved', step: 'release' });
    assert.ok(p.textContent.includes(locale.format(language, 'stewardWake.ownHandoff.action')), 'before the state loads');
    context.renderStewardWakeWarning({ minutes: 12, reason: 'source-unavailable' });
    assert.equal(p.textContent, locale.format(language, 'stewardWake.stalled', { minutes: 12, reason: locale.format(language, 'stewardWake.reason.source-unavailable') }));
  }
});
