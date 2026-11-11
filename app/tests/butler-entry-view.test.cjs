// The butler entry's display states, over snapshots the real core modules produce. Nothing is started and no
// model is called: the host is a stand-in driver, the identities and amounts are synthetic.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { entryView, BUILD_REASONS, HOLD_REASONS, ACTIONS } = require('../butler-entry-view.js');
const { ButlerRole } = require('../butler-role.cjs');
const { ButlerBackend } = require('../butler-backend.cjs');
const { ButlerIngress } = require('../butler-ingress.cjs');
const { summarizeUsage } = require('../butler-usage.cjs');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-entry-view-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const folder = name => { const dir = path.join(scratch, name); fs.mkdirSync(dir, { mode: 0o700 }); return dir; };
const person = Object.freeze({ person: true }), LIMIT = 2_000_000;
const all = value => ({ tools: value, context: value, provider: value, s2: value });
let ids = 0;
async function backend(name, { present, qualified, driver }) {
  const host = new ButlerBackend(folder(name), { runtimeVersion: '0.1.0-test', configuration: { profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro' }, credentialPresent: async () => present, qualify: async () => all(qualified), driver, now: () => Date.UTC(2026, 10, 11, 9), id: () => `view-${++ids}` });
  await host.ensure().catch(() => {});
  return host.snapshot();
}
const started = { recover: async () => ({ status: 'absent' }), start: async proof => ({ status: 'present', binding: { ...proof } }) };
let backends, empty, designated;
test.before(async () => {
  backends = {
    ready: await backend('ready', { present: true, qualified: true, driver: started }),
    nokey: await backend('nokey', { present: false, qualified: true, driver: started }),
    build: await backend('build', { present: true, qualified: false, driver: started }),
    buildnokey: await backend('buildnokey', { present: false, qualified: false, driver: started }),
    unknown: await backend('unknown', { present: true, qualified: true, driver: { recover: async () => ({ status: 'somewhere' }), start: started.start } }),
  };
  const role = new ButlerRole(folder('role'), { authorizePerson: actor => actor === person });
  empty = role.snapshot();
  const binding = backends.ready.binding;
  designated = role.set(person, { identity: { sessionId: 'butler-session-test', nativeId: 'butler-native-test' },
    runner: { runnerRef: binding.runnerRef, backendRef: binding.backendRef, purpose: 'butler', profile: binding.profile, provider: binding.provider, model: binding.model },
    budget: { limitMicros: LIMIT } }, 0);
});
const every = [...ACTIONS];
const offer = () => designated.selected;
const entry = extra => ({ version: 1, role: designated, startable: true, backend: backends.ready, intake: { recordPeriod: 'off' }, actions: every, ...extra });

test('normal window state gives no entry view; the dedicated preload IPC remains closed by the actual Main gate', () => {
  for (const value of [undefined, null, 'on', 1, {}, { version: 2, role: { revision: 0, selected: null } }, { version: 1 }, { version: 1, role: { revision: '0', selected: null } }]) assert.deepEqual(entryView(value), { visible: false });
  // The window state's butler field is ButlerIngress.status(); it carries no entry, and no code adds one.
  const status = ButlerIngress.prototype.status.call({ errors: new Map() });
  assert.deepEqual(Object.keys(status).sort(), ['activation', 'errorCode', 'intake', 'recordPeriod']);
  assert.equal(Object.hasOwn(status, 'entry'), false); assert.deepEqual(entryView(status.entry), { visible: false });
  const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
  assert.equal(/\bentry\s*:/.test(read('main.cjs').split('\n').filter(line => line.includes('butlerIngress?.status()')).join('\n')), false);
  let api;
  vm.runInNewContext(read('preload.cjs'), { require(name) {
    assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld(key, value) { if (key === 'workspace') api = value; } },
      ipcRenderer: { on() {}, invoke() { throw Error('Inspecting the closed entry must not invoke a handler'); } } };
  } });
  assert.equal(typeof api.butler, 'function', 'The dedicated IPC surface exists; actual Main IPC tests prove its default-off gate');
});

test('with no butler designated the person is asked only when the confirmation can be complete', () => {
  const none = { version: 1, role: empty, actions: every };
  assert.deepEqual(entryView(none), { visible: true, state: 'empty', revision: 0, actions: [], choice: null, usage: null, offer: null, startable: null });
  const asked = entryView({ ...none, offer: offer(), startable: false });
  assert.deepEqual(asked.actions, ['designate']); assert.equal(asked.startable, false);
  assert.deepEqual(asked.offer, { name: 'DeepSeek pro', profile: 'deepseek-pro', provider: 'deepseek', model: designated.selected.runner.model, limitMicros: LIMIT, dayBoundary: 'UTC' });
  assert.equal(entryView({ ...none, offer: offer(), startable: true }).startable, true);
  // Without knowing whether it would start, or with a selection this version cannot describe, nothing is offered.
  assert.deepEqual(entryView({ ...none, offer: offer() }).actions, []);
  assert.deepEqual(entryView({ ...none, offer: offer(), startable: 'yes' }).actions, []);
  const other = structuredClone(offer()); other.runner.provider = 'another';
  assert.deepEqual(entryView({ ...none, offer: other, startable: true }).actions, []);
  const unbounded = structuredClone(offer()); delete unbounded.budget.limitMicros;
  assert.deepEqual(entryView({ ...none, offer: unbounded, startable: true }).actions, []);
  // Only what the main process says it accepts is offered.
  assert.deepEqual(entryView({ ...none, offer: offer(), startable: true, actions: ['revoke'] }).actions, []);
  assert.deepEqual(entryView({ ...none, offer: offer(), startable: true, actions: 'designate' }).actions, []);
});

test('a designated butler is shown by what the host and the core report, never as more than that', () => {
  const state = extra => entryView(entry(extra));
  // Ready is the host's confirmation, not a model at work; the record period only when the core says it began.
  assert.equal(state({}).state, 'ready'); assert.equal(state({ intake: { recordPeriod: 'on' } }).state, 'recording');
  assert.equal(state({ intake: null }).state, 'ready');
  assert.deepEqual(state({}).actions, ['revoke']);
  assert.deepEqual(state({}).choice, { name: 'DeepSeek pro', profile: 'deepseek-pro', provider: 'deepseek', model: designated.selected.runner.model, limitMicros: LIMIT, dayBoundary: 'UTC' });
  // "The checks passed" is said only when the main process says so; a host that reports ready is not enough.
  for (const value of [undefined, null, 'true', 1]) assert.equal(state({ startable: value }).state, 'unknown');
  // A missing key alone is the person's to fix; anything this version cannot do comes first.
  const nokey = state({ backend: backends.nokey });
  assert.equal(nokey.state, 'blocked-credential'); assert.deepEqual(nokey.actions, ['recheck', 'revoke']);
  const build = state({ backend: backends.build, startable: false });
  assert.equal(build.state, 'blocked-build'); assert.equal(build.alsoMissingKey, false); assert.deepEqual(build.actions, ['revoke']);
  const both = state({ backend: backends.buildnokey, startable: false });
  assert.equal(both.state, 'blocked-build'); assert.equal(both.alsoMissingKey, true);
  assert.equal(state({ backend: backends.build, startable: true }).state, 'blocked-build', 'the host\'s own reasons are enough');
  assert.ok(backends.build.blocked.some(reason => BUILD_REASONS.includes(reason)));
  // This version: no host is created at all, and the main process says it cannot start.
  assert.equal(state({ backend: null, startable: false }).state, 'blocked-build');
  assert.equal(state({ backend: backends.ready, startable: false }).state, 'blocked-build', 'a contradiction is not shown as ready');
  // Anything else is not guessed.
  assert.equal(state({ backend: backends.unknown }).state, 'unknown'); assert.deepEqual(state({ backend: backends.unknown }).actions, ['recheck', 'revoke']);
  assert.equal(state({ backend: null }).state, 'unknown'); assert.equal(state({ backend: null, startable: undefined }).state, 'unknown');
  assert.equal(state({ backend: { state: 'blocked', ready: false, blocked: [], binding: null } }).state, 'unknown');
  assert.equal(state({ backend: { state: 'blocked', ready: false, blocked: ['credential-missing', 'liveness-unconfirmed'] } }).state, 'unknown');
  // A designation this version cannot describe can only be revoked.
  const strange = structuredClone(designated); strange.selected.runner.provider = 'another';
  const odd = entryView(entry({ role: strange }));
  assert.equal(odd.state, 'unknown'); assert.deepEqual(odd.actions, ['revoke']); assert.equal(odd.choice, null); assert.equal(odd.usage, null);
});

test('paused is only a refusal the core recorded, and there is no "off" the core does not have', () => {
  const state = extra => entryView(entry(extra));
  // The core keeps no "turned off" yet: such a field or action from anywhere changes nothing.
  assert.equal(state({ off: true }).state, 'ready'); assert.equal(state({ off: true, backend: backends.buildnokey, startable: false }).state, 'blocked-build');
  assert.deepEqual(state({ actions: ['turnOff', 'turnOn', 'setActive', 'revoke'] }).actions, ['revoke']);
  for (const reason of HOLD_REASONS) assert.deepEqual([state({ hold: reason }).state, state({ hold: reason }).holdReason], ['held', reason]);
  assert.equal(state({ hold: 'a-reason-added-later' }).holdReason, 'other');
  for (const value of [undefined, null, '', 0, true, {}]) assert.equal(state({ hold: value }).state, 'ready');
  // A butler that is not ready is not "paused": the reason it cannot start is what the person needs.
  assert.equal(state({ hold: 'daily-budget-reached', backend: backends.nokey }).state, 'blocked-credential');
  assert.equal(state({ hold: 'daily-budget-reached', startable: false }).state, 'blocked-build');
});

test('usage comes only from the core\'s shared reading; a missing or broken reading is unknown, never zero', () => {
  const NOW = Date.UTC(2026, 10, 11, 9), usage = value => entryView(entry({ usage: value })).usage;
  const run = (value, at = NOW - 60_000) => ({ batchId: `usage-${++ids}`, startedAt: at, usage: value });
  const spent = (totalTokens, costMicros) => ({ inputTokens: totalTokens - 10, cachedInputTokens: 0, outputTokens: 10, totalTokens, costMicros });
  const reading = attempts => summarizeUsage({ attempts, batches: [] }, { now: NOW });
  assert.deepEqual(usage(reading([])), { day: '2026-11-11', runs: 0, unknown: 0, totalTokens: 0, costMicros: 0 });
  // Yesterday's run is not today's.
  assert.deepEqual(usage(reading([run(spent(1722, 2031)), run(spent(1609, 1909)), run(spent(900, 1100), NOW - 86_400_000)])), { day: '2026-11-11', runs: 2, unknown: 0, totalTokens: 3331, costMicros: 3940 });
  // A wake-up without recorded usage is counted, named, and left out of the sums; so is one missing only its cost or only its tokens.
  assert.deepEqual(usage(reading([run(spent(1722, 2031)), run(null), run(spent(1609, 1909))])), { day: '2026-11-11', runs: 3, unknown: 1, totalTokens: 3331, costMicros: 3940 });
  assert.deepEqual(usage(reading([run({ ...spent(100, 5), costMicros: null })])), { day: '2026-11-11', runs: 1, unknown: 1, totalTokens: 100, costMicros: 0 });
  assert.deepEqual(usage(reading([run({ ...spent(100, 5), totalTokens: null })])), { day: '2026-11-11', runs: 1, unknown: 1, totalTokens: 0, costMicros: 5 });
  const good = reading([run(spent(1722, 2031))]), today = extra => ({ ...good, today: { ...good.today, ...extra } });
  for (const value of [undefined, null, {}, [], { ...good, utcDay: '' }, { ...good, utcDay: 'today' }, { ...good, utcDay: 20261111 }, { ...good, today: null }, today({ recordedRunCount: '1' }), today({ costMicros: null }), today({ tokens: {} }),
    today({ costMicros: { value: null, knownLowerBound: null, unknownRuns: 0, overflow: true } }), today({ costMicros: { ...good.today.costMicros, knownLowerBound: -1 } }), today({ costMicros: { ...good.today.costMicros, unknownRuns: 5 } }),
    { day: '2026-11-11', runs: 3, unknown: 0, totalTokens: 1, costMicros: 1 }]) assert.equal(usage(value), null);
  assert.equal(entryView({ version: 1, role: empty, usage: good }).usage, null, 'no butler, no usage line');
});

test('only named, known actions are offered, and the record table only when one exists', () => {
  const state = extra => entryView(entry(extra));
  assert.deepEqual(state({ actions: [] }).actions, []);
  assert.deepEqual(state({ actions: undefined }).actions, []);
  assert.deepEqual(state({ actions: ['revoke', 'setActive', 'designate', 'erase'] }).actions, ['revoke']);
  assert.deepEqual(state({ reviewAvailable: true }).actions, ['review', 'revoke']);
  assert.deepEqual(state({ reviewAvailable: true, actions: [] }).actions, ['review']);
  for (const value of [undefined, 'true', 1]) assert.equal(state({ reviewAvailable: value }).actions.includes('review'), false);
  assert.deepEqual(state({ reviewAvailable: true, backend: backends.nokey }).actions, ['recheck', 'revoke'], 'a butler that never ran has no table to open');
});

test('the renderer loads the same module as a plain script', () => {
  const browser = { self: {} }; browser.self.self = browser.self;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../butler-entry-view.js'), 'utf8'), browser, { filename: 'butler-entry-view.js' });
  const view = browser.self.nativeWorkspaceButlerEntryView.entryView(JSON.parse(JSON.stringify(entry({ backend: backends.buildnokey, startable: false }))));
  assert.deepEqual(JSON.parse(JSON.stringify(view)), JSON.parse(JSON.stringify(entryView(entry({ backend: backends.buildnokey, startable: false })))));
  assert.deepEqual(JSON.parse(JSON.stringify(browser.self.nativeWorkspaceButlerEntryView.entryView(undefined))), { visible: false });
});
