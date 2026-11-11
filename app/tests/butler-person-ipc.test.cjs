'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { ButlerRole } = require('../butler-role.cjs');
const { ButlerPerson } = require('../butler-person.cjs');
const { ButlerLedger } = require('../butler-ledger.cjs');
const { ButlerReadAudit } = require('../butler-read-audit.cjs');
const { bindQueueOutcomes } = require('../butler-ingress.cjs');
const { BackgroundControl } = require('../background-control.cjs');
const uiLocale = require('../ui-locale.js'), { uiError } = require('../ui-errors.cjs');
const butlerEntryHost = require('../butler-entry-host.cjs');
const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
const { createRequire } = require('node:module');
function actualModule(filename, spawnSync) {
  const load = filename => {
    const target = require.resolve(filename), localRequire = createRequire(target), module = { exports: {} };
    new Function('require', 'module', '__dirname', 'process', fs.readFileSync(target, 'utf8'))(name => {
      if (name === 'node:child_process') return { spawnSync, spawn() { throw Error('No native spawn'); } };
      if (name === './platform.cjs') return { pythonExecutable: () => '/synthetic/python', nativeEnvironment: () => Object.freeze({}) };
      if (['./butler-runner.cjs', './butler-dsh-driver.cjs'].includes(name)) return load(path.join(path.dirname(target), name));
      return localRequire(name);
    }, module, path.dirname(target), { env: new Proxy({}, { get() { throw Error('No environment values in this fixture'); } }) });
    return module.exports;
  };
  return load(filename);
}
function actualMainPresence(spawnSync) {
  const match = main.match(/const \{ (\w+): butlerCredentialPresent \} = require\('(\.\/[^']+)'\);/);
  assert.ok(match, 'Actual Main declares its presence dependency');
  return actualModule(path.join(__dirname, '..', match[2]), spawnSync)[match[1]];
}
function section(start, end) {
  const first = main.indexOf(start), last = main.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, 'Actual Main section: ' + start); return main.slice(first, last);
}
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-butler-person-ipc-')); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const windows = new Map(), handlers = new Map(), ipc = new Map(), notifications = [], calls = { presence: 0, roles: 0 };
  const context = (id, background) => {
    let destroyed = false;
    const frame = { url: 'synthetic-trusted' }, webContents = { id, mainFrame: frame };
    const value = { background, win: { webContents, isDestroyed: () => destroyed, destroy: () => { destroyed = true; } }, client: { close() {} } };
    windows.set(id, value); return { context: value, event: { sender: webContents, senderFrame: frame }, destroy: () => { destroyed = true; } };
  };
  const person = context(1, false), agent = context(2, true), ledger = new ButlerLedger(directory);
  const roomState = {}, ingress = { ledger, captureOutcome: () => ({ status: 'ignored' }) };
  let backend = { snapshot: () => ({ state: 'unprepared', ready: false, blocked: ['runtime-unqualified'] }) };
  const Role = class extends ButlerRole { constructor(...args) { super(...args); calls.roles++; } };
  const dependencies = { windows, applicationHandlers: handlers, ipcMain: { handle: (name, fn) => ipc.set(name, fn) },
    trusted: url => url === 'synthetic-trusted', uiLocale, uiError, backgroundOperation: require('../background-operation.cjs'),
    backgroundTest: options.backgroundTest ?? true, process: { execPath: '/synthetic/electron', env:
      Object.hasOwn(options, 'entryFlag') ? options.entryFlag === null ? {} : { NAW_TEST_BUTLER_ENTRY: options.entryFlag } : { NAW_TEST_BUTLER_ENTRY: '1' } },
    dataDir: directory, ButlerRole: Role, ButlerPerson: options.Person || ButlerPerson, ButlerReadAudit,
    butlerCredentialPresent: () => { calls.presence++; return options.presence ? options.presence() : true; }, butlerIngress: ingress, roomState,
    bindQueueOutcomes, notifyQueueOutcome: (...args) => notifications.push(args), path,
    app: { getVersion: () => 'synthetic-person' }, createDedicatedBackend: (...args) => options.factory ? options.factory(...args) : backend, butlerEntryHost };
  const host = new Function('dependencies', `
    const { windows, applicationHandlers, ipcMain, trusted, uiLocale, uiError, backgroundOperation,
      dataDir, ButlerRole, ButlerPerson, ButlerReadAudit, butlerCredentialPresent, roomState, bindQueueOutcomes,
      notifyQueueOutcome, path, app, createDedicatedBackend, backgroundTest, process, butlerEntryHost } = dependencies;
    ${section('const butlerEntryEnabled =', '\n')}
    let { butlerIngress } = dependencies, butlerBackend = null, butlerRole = null, butlerPerson = null, butlerReadAudit = null;
    ${section('function isCurrentHumanContext(', '\nfunction showDialog(')}
    ${section('function register(name, handler)', '\nasync function replaceBackendSockets(')}
    function initialize() {
      ${section('  bindQueueOutcomes(roomState, butlerIngress, notifyQueueOutcome);', '  queueSecretary = new QueueSecretary(')}
      return 'ordinary-startup-continues';
    }
    ${section("  register('butler',", "  register('queueSecretary',")}
    return { initialize, person: () => butlerPerson, role: () => butlerRole, audit: () => butlerReadAudit, verify: isCurrentHumanContext };
  `)(dependencies);
  if (options.initialize !== false) host.initialize();
  const call = (action, ...args) => ipc.get('workspace:butler')(person.event, action, ...args);
  // What crosses IPC is the entry a window draws. The core's own view is read from the same real object, after the
  // same call went through the real handler and was answered.
  const seen = async (action, ...args) => { const result = await call(action, ...args); assert.equal(result.ok, true, `${action} is answered`); return host.person().status(person.context); };
  return { directory, windows, handlers, ipc, calls, notifications, roomState, ledger, host, person, agent,
    backend: value => { backend = value; }, call, seen };
}
const designation = { identity: { sessionId: 'ipc-butler', nativeId: 'ipc-native' }, runner: { runnerRef: 'ipc-runner', backendRef: 'ipc-backend',
  purpose: 'butler', profile: 'host-profile', provider: 'host-provider', model: 'host-model' } };

test('actual human Main status keeps a readable designation revocable with unknown current identity and a broken log', async t => {
  const f = fixture(t), role = f.host.role(); role.set(f.person.context, designation, 0);
  fs.writeFileSync(role.logFile, '{partial-tail\n', { mode: 0o600 });
  const view = (await f.seen('status'));
  assert.equal(view.state, 'unknown'); assert.equal(view.role.available, true); assert.equal(view.role.currentAvailable, false);
  assert.equal(view.role.revision, 1); assert.equal(view.role.selected.identity, null);
  assert.deepEqual(view.role.selected.configuration, { profile: 'host-profile', provider: 'host-provider', model: 'host-model' });
  assert.equal(view.actions.revoke, true); assert.equal(view.actions.close, false); assert.equal(view.pause, null);
  const result = await f.call('revoke', 1); assert.equal(result.ok, true); assert.equal(result.value.revoked, true);
  assert.equal(Object.hasOwn(result.value.shutdown, 'target'), false, 'What was to be stopped stays in the main process'); assert.equal(result.value.shutdown.stopped, null);
  assert.equal(role.snapshot().selected, null);
});

test('actual Main denies the dedicated person IPC unless the verified isolated test and explicit flag both enable it', async t => {
  for (const options of [{ backgroundTest: false, entryFlag: '1' }, { backgroundTest: true, entryFlag: null }, { backgroundTest: false, entryFlag: null },
    { backgroundTest: true, entryFlag: 'true' }]) {
    const f = fixture(t, options); let personCalls = 0;
    for (const method of ['status', 'recheck', 'designate', 'revoke', 'setActive'])
      f.host.person()[method] = () => { personCalls++; throw Error('A closed entry must not call the core'); };
    for (const args of [['status'], ['recheck', 0], ['designate', 0], ['revoke', 0], ['setActive', false, 0], ['setActive', true, 0]]) {
      const refused = await f.call(...args);
      assert.equal(refused.ok, false); assert.equal(refused.uiMessage.key, 'error.butler.entryDisabled');
    }
    assert.equal(personCalls, 0); assert.equal(f.calls.presence, 0);
    const agent = await f.ipc.get('workspace:butler')(f.agent.event, 'status');
    assert.equal(agent.uiMessage.key, 'error.butler.personOnly', 'The real person check must precede the closed entry gate');
  }
  const enabled = fixture(t, { backgroundTest: true, entryFlag: '1' });
  assert.equal((await enabled.seen('status')).state, 'empty'); assert.equal(enabled.calls.presence, 0);
  assert.equal((await enabled.seen('recheck', 0)).credentialPresent, true); assert.equal(enabled.calls.presence, 1);
});

test('actual Main constructs one real role and source core without probing presence or starting a provider', async t => {
  const f = fixture(t), core = f.host.person(), role = f.host.role();
  assert.ok(core instanceof ButlerPerson); assert.ok(role instanceof ButlerRole); assert.equal(core.ledger, f.ledger);
  const audit = f.host.audit(); assert.ok(audit instanceof ButlerReadAudit, 'The shared initializer must not swallow a missing audit dependency');
  assert.deepEqual(audit.read(f.person.context, {}).records, []);
  assert.equal(core.stopOwned, undefined); assert.equal(f.calls.presence, 0); assert.equal(f.calls.roles, 1);
  const status = await f.seen('status'); assert.equal(status.state, 'empty');
  assert.equal(status.credentialPresent, null); assert.equal(f.calls.presence, 0);
  assert.equal((await f.seen('recheck', 0)).credentialPresent, true); assert.equal(f.calls.presence, 1);
  const updated = { snapshot: () => ({ state: 'blocked', ready: false }) }; f.backend(updated);
  assert.equal(f.host.initialize(), 'ordinary-startup-continues');
  assert.equal(f.host.person(), core); assert.equal(f.host.role(), role); assert.equal(f.calls.roles, 1);
  assert.equal(f.host.audit(), audit, 'Repeated initialization reuses the independent audit writer');
  assert.equal(core.backend, updated); assert.equal(core.ledger, f.ledger);
  assert.equal((await f.seen('status')).credentialPresent, true); assert.equal(f.calls.presence, 1);
});

test('actual Main with its actual presence adapter preserves subprocess failure as unknown, not absent', async t => {
  for (const failure of [() => { throw Error('Synthetic spawn failure'); }, () => ({ status: null, error: { code: 'ETIMEDOUT' }, stdout: '' }),
    () => ({ status: 1, stdout: '{"credentialPresent":false}' }), () => ({ status: 0, stdout: 'invalid' }),
    () => ({ status: 0, stdout: '{"credentialPresent":"false"}' })]) {
    let probes = 0;
    const presence = actualMainPresence(() => { probes++; return failure(); }), f = fixture(t, { presence });
    assert.equal((await f.seen('status')).credentialPresent, null); assert.equal(probes, 0);
    assert.equal((await f.seen('recheck', 0)).credentialPresent, null);
    assert.equal((await f.seen('status')).credentialPresent, null); assert.equal(probes, 1);
  }
});

test('actual Main accepts exact successful display false and true, once per explicit recheck only', async t => {
  for (const present of [false, true]) {
    const spawned = [], presence = actualMainPresence((...args) => { spawned.push(args); return { status: 0, stdout: JSON.stringify({ credentialPresent: present }) + '\n' }; });
    const f = fixture(t, { presence }); assert.equal(spawned.length, 0);
    assert.equal((await f.seen('recheck', 0)).credentialPresent, present); assert.equal(spawned.length, 1);
    assert.equal((await f.seen('status')).credentialPresent, present); assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0][1], ['-I', path.join(__dirname, '../butler-dsh-launch.py'), '--presence']);
    assert.equal(spawned[0][2].env, undefined, 'No environment values are read or copied into JS options');
  }
});

test('actual Main and DSH factory do not present its cached failed startup probe as known missing credentials', async t => {
  let response = { status: null, error: { code: 'ETIMEDOUT' }, stdout: '' }, backend;
  const mockSpawn = () => response;
  const factory = actualModule(require.resolve('../butler-backend-host.cjs'), mockSpawn).createDedicatedBackend;
  const f = fixture(t, { presence: actualMainPresence(mockSpawn), factory: (...args) => { backend = factory(...args); return backend; } });
  f.host.role().set(f.person.context, designation, 0);
  const refused = await backend.ensure(); assert.equal(refused.ready, false);
  assert.ok(backend.snapshot().blocked.includes('credential-missing'), 'The unchanged startup Boolean gate remains fail closed');
  let view = (await f.seen('status'));
  assert.equal(view.credentialPresent, null); assert.equal(view.backend.blocked.includes('credential-missing'), false);
  view = (await f.seen('recheck', 1));
  assert.equal(view.credentialPresent, null); assert.equal(view.backend.blocked.includes('credential-missing'), false);
  // The window is told the same: the reason is in the answer only after a successful negative probe.
  const told = async () => (await f.call('status')).value.backend.blocked.includes('credential-missing');
  assert.equal(await told(), false);
  response = { status: 0, stdout: '{"credentialPresent":false}' };
  view = (await f.seen('recheck', 1));
  assert.equal(view.credentialPresent, false); assert.equal(view.backend.blocked.includes('credential-missing'), true); assert.equal(await told(), true);
  response = { status: 0, stdout: '{"credentialPresent":true}' };
  view = (await f.seen('recheck', 1));
  assert.equal(view.credentialPresent, true); assert.equal(view.backend.blocked.includes('credential-missing'), false); assert.equal(await told(), false);
  assert.ok(backend.snapshot().blocked.includes('credential-missing'), 'Display projection never rewrites the saved startup refusal');
});

test('the actual same-realm handler exposes exactly five person actions and real revision-controlled revoke', async t => {
  const f = fixture(t), actor = f.person.context, role = f.host.role();
  assert.equal((await f.call('designate', 0)).value.reason, 'trusted-candidate-unavailable');
  assert.equal(role.snapshot().selected, null);
  assert.throws(() => role.set({ ...actor }, designation, 0), { code: 'ERR_BUTLER_PERSON' });
  assert.throws(() => role.set({ kind: 'person' }, designation, 0), { code: 'ERR_BUTLER_PERSON' });
  role.set(actor, designation, 0);
  const status = (await f.seen('status'));
  assert.equal(status.role.revision, 1); assert.equal(status.actions.close, false); assert.equal(status.actions.open, false);
  assert.equal((await f.call('recheck', 0)).uiMessage.key, 'error.butler.changed'); assert.equal(f.calls.presence, 0);
  assert.equal((await f.seen('recheck', 1)).credentialPresent, true); assert.equal(f.calls.presence, 1);
  const disabled = await f.call('setActive', true, 1); assert.equal(disabled.ok, false); assert.equal(disabled.uiMessage.key, 'error.butler.activationDisabled');
  const close = (await f.call('setActive', false, 1)).value;
  assert.equal(close.status, 'unconfirmed'); assert.equal(close.stopped, null); assert.equal(close.cleanupConfirmed, null);
  const stale = await f.call('revoke', 0); assert.equal(stale.ok, false); assert.equal(stale.uiMessage.key, 'error.butler.changed');
  const revoked = (await f.call('revoke', 1)).value;
  assert.equal(revoked.revoked, true); assert.equal(revoked.revision, 2); assert.equal(revoked.shutdown.status, 'unconfirmed');
  assert.equal(role.snapshot().selected, null); assert.equal((await f.seen('status')).recordPeriod, 'off');
});

test('trusted background direct IPC cannot read or control the core, regardless of claimed actor fields', async t => {
  const f = fixture(t), invoke = f.ipc.get('workspace:butler');
  for (const args of [['status'], ['recheck'], ['designate', 0], ['revoke', 0], ['setActive', false, 0], ['status', { kind: 'person' }]]) {
    const result = await invoke(f.agent.event, ...args); assert.equal(result.ok, false); assert.equal(result.uiMessage.key, 'error.butler.personOnly');
  }
  assert.equal(f.calls.presence, 0); assert.equal(f.host.role().snapshot().revision, 0);
});

test('the actual frame gate and opaque verifier reject subframes, copied contexts, stale windows and destroyed windows', async t => {
  const f = fixture(t), original = f.person.context;
  await assert.rejects(f.ipc.get('workspace:butler')({ ...f.person.event, senderFrame: { url: 'synthetic-trusted' } }, 'status'), /Unexpected IPC source/);
  assert.equal(f.host.verify({ ...original }), false);
  f.windows.set(1, { ...original }); assert.equal(f.host.verify(original), false);
  assert.throws(() => f.host.person().status(original), { code: 'ERR_BUTLER_PERSON' });
  f.windows.set(1, original); f.person.destroy(); assert.equal((await f.call('status')).uiMessage.key, 'error.butler.personOnly');
  f.windows.delete(1); await assert.rejects(f.call('status'), /Unexpected IPC source/);
  assert.equal(f.calls.presence, 0);
});

test('unknown actions and caller identity, budget, receipt or revision objects fail before reaching core', async t => {
  const f = fixture(t), core = f.host.person(); let calls = 0;
  for (const name of ['status', 'recheck', 'designate', 'revoke', 'setActive']) core[name] = () => { calls++; throw Error('Not reached'); };
  for (const args of [[], ['unknown'], ['status', {}], ['recheck', true], ['designate'], ['designate', -1],
    ['designate', { expectedRevision: 0 }], ['revoke', '0'], ['revoke', 0, {}], ['setActive', false], ['setActive', 'false', 0],
    ['setActive', false, { expectedRevision: 0 }], ['setActive', false, 0, { receipt: true }]]) {
    const result = await f.call(...args); assert.equal(result.ok, false); assert.equal(result.uiMessage.key, 'error.butler.invalidRequest');
  }
  for (const key of ['actor', 'identity', 'runner', 'budget', 'capabilities', 'receipt', 'scope']) {
    const result = await f.call('designate', { expectedRevision: 0, [key]: {} }); assert.equal(result.uiMessage.key, 'error.butler.invalidRequest');
  }
  assert.equal(calls, 0); assert.equal(f.calls.presence, 0);
});

test('agent catalog/invoke cannot discover the butler command and generic display state does not contain Person data', async t => {
  const f = fixture(t); assert.equal(f.handlers.has('butler'), false);
  const control = new BackgroundControl({ dataDir: f.directory, handlers: f.handlers, context: async () => f.agent.context }); t.after(() => control.close());
  const binding = { sender: { id: 'agent', nativeId: 'agent-native', name: 'Agent', provider: 'codex' }, identity: { turnId: 'turn', callId: 'call' }, valid: () => true };
  const catalog = await control.call(binding, { action: 'catalog' }); assert.equal(catalog.commands.some(item => item.method === 'butler'), false);
  const result = await control.call(binding, { action: 'invoke', operation_id: 'person-test', method: 'butler', arguments: ['status'] });
  assert.equal(result.state, 'not-executed'); assert.equal(result.reason, 'unknown-command');
  assert.equal(section('function displayState(', '\nfunction ').includes('butlerPerson'), false);
});

test('a failed person initialization leaves existing B1 delivery and ordinary startup available, then retries the same role', async t => {
  let creates = 0;
  class InitialFailure extends ButlerPerson { constructor(options) { if (++creates === 1) throw Error('PRIVATE_INITIALIZATION_DETAILS'); super(options); } }
  const f = fixture(t, { Person: InitialFailure, initialize: false });
  assert.equal(f.host.initialize(), 'ordinary-startup-continues'); assert.equal(f.host.person(), null);
  const unavailable = await f.call('status'); assert.equal(unavailable.uiMessage.key, 'error.butler.unavailable');
  assert.equal(JSON.stringify(unavailable).includes('PRIVATE_INITIALIZATION_DETAILS'), false);
  f.roomState.onQueueOutcome({ roomId: 'shared', eventId: 'synthetic-outcome' }); assert.equal(f.notifications.length, 1);
  const role = f.host.role(); assert.equal(f.host.initialize(), 'ordinary-startup-continues');
  assert.ok(f.host.person() instanceof ButlerPerson); assert.equal(f.host.role(), role); assert.equal(f.calls.roles, 1); assert.equal(f.calls.presence, 0);
});

test('only fixed localized errors cross IPC, including unknown or hostile upstream error codes', async t => {
  const f = fixture(t);
  for (const error of [Error('PRIVATE_FILESYSTEM_BODY'), Object.assign(Error('PRIVATE_FILESYSTEM_BODY'), { code: 'constructor' }),
    Object.defineProperty(Error('PRIVATE_FILESYSTEM_BODY'), 'code', { get() { throw Error('PRIVATE_CODE_GETTER'); } })]) {
    f.host.person().status = () => { throw error; }; const result = await f.call('status');
    assert.equal(result.ok, false); assert.equal(result.uiMessage.key, 'error.butler.unavailable');
    assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  }
});

test('a busy role is reported as busy, not as a changed designation', async t => {
  const f = fixture(t);
  f.host.role().revoke = () => { throw Object.assign(Error('PRIVATE_BUSY_DETAILS'), { code: 'ERR_BUTLER_BUSY' }); };
  const result = await f.call('revoke', 0);
  assert.equal(result.ok, false); assert.equal(result.uiMessage.key, 'error.butler.busy'); assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
});

test('preload exposes only the dedicated butler method and approved package additions preserve the historical floor', async () => {
  const source = fs.readFileSync(require.resolve('../preload.cjs'), 'utf8'), calls = []; let api;
  vm.runInNewContext(source, { require(name) { assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld(key, value) { if (key === 'workspace') api = value; } },
    ipcRenderer: { on() {}, invoke: async (...args) => { calls.push(args); return { ok: true, value: 'host-status' }; } } }; } });
  assert.equal(await api.butler('status'), 'host-status'); assert.deepEqual(calls, [['workspace:butler', 'status']]);
  assert.equal(api.invoke, undefined); assert.equal(api.call, undefined);
  const packaging = fs.readFileSync(path.join(__dirname, '../../scripts/package-mac.cjs'), 'utf8');
  const begin = packaging.indexOf('const sources = ['), end = packaging.indexOf('];', begin), entries = [...packaging.slice(begin, end).matchAll(/'([^']+)'/g)].map(match => match[1]);
  for (const name of require('./fixtures/package-sources-butler-person.json')) assert.ok(entries.includes(name), name);
  for (const name of require('./fixtures/package-sources-before-format.json')) assert.ok(entries.includes(name), 'Historical package source retained: ' + name);
});

// --- What a person window is answered with (the entry adapter in the same handler) ---

test('the actual handler answers a window with the entry it draws, never with the identity or references behind it', async t => {
  const { entryView } = require('../butler-entry-view.js');
  const f = fixture(t), role = f.host.role(), secrets = [designation.identity.sessionId, designation.identity.nativeId, designation.runner.runnerRef, designation.runner.backendRef];
  const empty = await f.call('status'); assert.equal(empty.ok, true);
  assert.deepEqual(empty.value, { version: 1, role: { revision: 0, selected: null }, reminder: { amountMicros: 2000000, dayBoundary: 'UTC' }, uncertain: false, startable: false,
    backend: { state: 'unprepared', ready: false, blocked: ['runtime-unqualified'] }, intake: { recordPeriod: 'off' }, hold: null, usage: null, reviewAvailable: false, actions: ['recheck'] });
  assert.deepEqual([entryView(empty.value).state, entryView(empty.value).later, entryView(empty.value).actions], ['empty', true, []]);
  role.set(f.person.context, { ...designation, runner: { ...designation.runner, profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro' } }, 0);
  assert.deepEqual(f.host.person().status(f.person.context).role.selected.identity, designation.identity, 'The core holds the identity');
  const answers = [await f.call('status'), await f.call('recheck', 1), await f.call('designate', 1), await f.call('setActive', false, 1), await f.call('revoke', 1), await f.call('status')];
  for (const answer of answers) { assert.equal(answer.ok, true); for (const secret of secrets) assert.equal(JSON.stringify(answer).includes(secret), false, secret); }
  const [selected, rechecked, blocked, closed, revoked, after] = answers.map(answer => answer.value);
  assert.deepEqual(selected.role, { revision: 1, selected: { runner: { profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro' }, budget: null } });
  assert.deepEqual(selected.actions, ['revoke', 'recheck']); assert.equal(entryView(selected).state, 'blocked-build'); assert.equal(entryView(selected).choice.limitMicros, 2000000);
  assert.equal(rechecked.version, 1); assert.deepEqual(rechecked.role, selected.role);
  assert.deepEqual(blocked, { activation: 'off', recordPeriod: 'off', status: 'blocked', reason: 'trusted-candidate-unavailable' });
  assert.deepEqual(closed, { activation: 'off', recordPeriod: 'off', status: 'unconfirmed', reason: 'owned-stop-unavailable', stopped: null, cleanupConfirmed: null });
  assert.deepEqual(revoked, { activation: 'off', recordPeriod: 'off', revoked: true, revision: 2,
    shutdown: { activation: 'off', recordPeriod: 'off', status: 'unconfirmed', reason: 'owned-stop-unavailable', stopped: null, cleanupConfirmed: null } });
  assert.deepEqual(after.role, { revision: 2, selected: null });
  // A designation record that cannot be read is answered as unreadable, not as "none designated".
  fs.writeFileSync(role.file, '{broken', { mode: 0o600 });
  assert.deepEqual(await f.call('status'), { ok: true, value: { version: 1, unavailable: true, actions: [] } });
  // Nothing can be done from the window in that state: a recheck is refused before any probe.
  const refused = await f.call('recheck', 2); assert.equal(refused.ok, false); assert.equal(refused.uiMessage.key, 'error.butler.unavailable'); assert.equal(f.calls.presence, 1);
});

test('every call the entry in the window makes is one the actual handler accepts, and no other shape of them is', async t => {
  const { CALLS } = require('../renderer/butler-entry.js');
  const f = fixture(t); f.host.role().set(f.person.context, designation, 0);
  assert.deepEqual(Object.keys(CALLS).sort(), ['designate', 'recheck', 'revoke', 'status']);
  // In the order a person could make them: revoking last, since it changes the revision.
  for (const action of ['status', 'recheck', 'designate', 'revoke']) {
    const args = CALLS[action].map(kind => { assert.equal(kind, 'revision'); return 1; });
    const answer = await f.call(action, ...args);
    assert.equal(answer.ok, true, `${action}(${args.join(', ')}) is carried out`);
  }
  // What the window used to send with a designation, and any other extra, is refused before the core is reached.
  const core = f.host.person(); let reached = 0;
  for (const name of ['status', 'recheck', 'designate', 'revoke', 'setActive']) core[name] = () => { reached++; throw Error('Not reached'); };
  const confirmed = { profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro', limitMicros: 2000000, dayBoundary: 'UTC', startable: false };
  for (const args of [['designate', 2, confirmed], ['designate', 2, undefined], ['recheck', 2, confirmed], ['revoke', 2, confirmed], ['status', 2], ['open', 2], ['close', 2], ['open'], ['close']]) {
    const answer = await f.call(...args); assert.equal(answer.ok, false); assert.equal(answer.uiMessage.key, 'error.butler.invalidRequest', JSON.stringify(args));
  }
  assert.equal(reached, 0);
});

test('the record table is offered only for a designation, from the ledger\'s own answer, and a failed answer is "no"', async t => {
  const f = fixture(t); let asked = 0, answer = () => true;
  f.ledger.hasReviewData = context => { asked++; assert.equal(context, f.person.context, 'The person\'s own window is who asks'); return answer(); };
  assert.equal((await f.call('status')).value.reviewAvailable, false); assert.equal(asked, 0, 'Nothing designated: the ledger is not asked');
  f.host.role().set(f.person.context, designation, 0);
  assert.equal((await f.call('status')).value.reviewAvailable, true); assert.equal((await f.call('recheck', 1)).value.reviewAvailable, true); assert.equal(asked, 2);
  for (const other of [() => false, () => 'yes', () => 1, () => { throw Error('PRIVATE_LEDGER_BODY'); }]) {
    answer = other; const result = await f.call('status');
    assert.equal(result.ok, true); assert.equal(result.value.reviewAvailable, false); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  }
});


test('actual Main retains one shared Role and its refused rotation history across status calls and reinitialization', async t => {
  const f = fixture(t), role = f.host.role(), core = f.host.person();
  assert.equal(core.role, role, "The person core must use Main's exact shared Role");
  role.set(f.person.context, designation, 0);
  const next = { sessionId: 'ipc-successor', nativeId: 'ipc-successor-native' };
  fs.writeFileSync(role.logFile, JSON.stringify({ event: 'done', old: { id: designation.identity.sessionId, nativeId: designation.identity.nativeId },
    new: { id: next.sessionId, nativeId: next.nativeId } }) + '\n', { mode: 0o600 });
  assert.deepEqual((await f.seen('status')).role.selected.identity, next);
  assert.equal(f.host.initialize(), 'ordinary-startup-continues');
  assert.equal(f.host.role(), role); assert.equal(f.host.person(), core); assert.equal(core.role, role); assert.equal(f.calls.roles, 1);
  fs.writeFileSync(role.logFile, '');
  for (let attempt = 0; attempt < 2; attempt++) {
    const view = await f.seen('status');
    assert.equal(view.role.available, true); assert.equal(view.role.currentAvailable, false);
    assert.equal(view.role.selected.identity, null); assert.equal(view.actions.revoke, true);
    assert.throws(() => role.current(), { code: 'ERR_BUTLER_STATE' });
    assert.equal(f.host.initialize(), 'ordinary-startup-continues');
    assert.equal(f.host.role(), role); assert.equal(f.host.person(), core); assert.equal(core.role, role); assert.equal(f.calls.roles, 1);
  }
  assert.equal((await f.call('revoke', 1)).value.revoked, true);
  assert.equal(role.snapshot().selected, null); assert.equal(f.calls.presence, 0);
});
