const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function versionValue('), source.indexOf('function renderVersions(')), context);
const plain = value => JSON.parse(JSON.stringify(value));
const current = '0.1.0-alpha.139';

test('compact labels distinguish older, newer, incomparable and unreported backends without hiding their exact versions', () => {
  const old = context.backendVersionNotice({ runtimeVersion: '0.1.0-alpha.120' }, current);
  assert.equal(old.label, '旧后台'); assert.equal(old.kind, 'old');
  assert.match(old.title, /0\.1\.0-alpha\.120/); assert.match(old.title, /0\.1\.0-alpha\.139/);
  for (const version of ['0.1.0-alpha.140', 'development', '1.0.0']) {
    const notice = context.backendVersionNotice({ runtimeVersion: version }, current);
    assert.equal(notice.label, '版本不同'); assert.equal(notice.kind, 'different'); assert.ok(notice.title.includes(version));
  }
  assert.equal(context.backendVersionNotice({ runtimeVersion: current }, current), null);
  assert.equal(context.backendVersionNotice({}, current).label, '版本未知');
  assert.equal(context.backendVersionNotice({ runtimeVersion: '0.1.0-alpha.120' }, undefined).label, '版本不同');
});

test('numeric alpha ordering handles different widths and rejects unbounded or nonstandard parts', () => {
  assert.equal(context.backendVersionNotice({ runtimeVersion: '0.1.0-alpha.99' }, current).kind, 'old');
  for (const version of ['0.1.0-alpha.139-extra', '0.1.0-alpha.999999999999999999999', '0.1.0-alpha.0140']) {
    assert.equal(context.backendVersionNotice({ runtimeVersion: version }, current).kind, 'different');
  }
});

test('summary counts unique nonarchived sessions, including hidden and grouped occurrences, rather than DOM rows', () => {
  const old = { id: 'old', runtimeVersion: '0.1.0-alpha.120', roomIds: ['a', 'b'] };
  const records = [old, { ...old }, { id: 'second', runtimeVersion: '0.1.0-alpha.118' },
    { id: 'current', runtimeVersion: current }, { id: 'newer', runtimeVersion: '0.1.0-alpha.140' },
    { id: 'unknown' }, { id: 'archived', runtimeVersion: '0.1.0-alpha.114', archived: true }];
  const before = JSON.stringify(records), summary = plain(context.backendVersionSummary(records, current));
  assert.equal(summary.old, 2); assert.equal(summary.different, 1); assert.equal(summary.unknown, 1);
  assert.equal(summary.count, 4); assert.match(summary.label, /2 个旧后台会话/);
  assert.equal(JSON.stringify(records), before);
  assert.equal(context.backendVersionSummary([{ id: 's', runtimeVersion: current }], current).count, 0);
});

function mainOptions(client, version = current, profile) {
  const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
  const start = main.indexOf('function connectionUpdateOptions('), end = main.indexOf('function register(', start);
  assert.ok(start >= 0 && end > start);
  const fn = vm.runInNewContext(main.slice(start, end) + ';connectionUpdateOptions', {
    continuationStatus: require('../service-client.cjs').continuationStatus,
  });
  return plain(fn(client, version, profile));
}
test('profile-archived sessions are excluded from displayed counts but still block a backend update while working', t => {
  const os = require('node:os'), path = require('node:path'), { RoomState } = require('../room-state.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-version-count-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const profile = new RoomState(directory); profile.value.archivedSessions = ['hidden'];
  const records = [{ id: 'visible', nativeId: 'native-visible', state: 'ended' }, { id: 'hidden', nativeId: 'native-hidden', state: 'working' }];
  const entry = { key: 'old', state: { runtimeVersion: '0.1.0-alpha.120', sessions: records, capabilities: ['atomicShutdown'] } };
  const client = { entries: [entry], snapshot: () => ({ sessions: records, room: { messages: [] } }) };
  const options = mainOptions(client, current, profile);
  assert.equal(options[0].count, 1); assert.equal(options[0].id, 'visible'); assert.equal(options[0].ready, false);
  profile.value.archivedSessions.push('visible'); assert.deepEqual(mainOptions(client, current, profile), []);
});
test('read-only update choices deduplicate backend owners and refuse mixed active/unknown/failed connections', () => {
  const entry = (key, version, sessions, extra = {}) => ({ key, state: { runtimeVersion: version, sessions, capabilities: ['atomicShutdown'], ...extra } });
  const ended = { id: 'ended', nativeId: 'native-ended', state: 'ended' };
  const entries = [entry('old', '0.1.0-alpha.120', [ended, { ...ended, id: 'peer' }]),
    entry('mixed', '0.1.0-alpha.118', [{ ...ended, id: 'old-ended' }, { id: 'busy', state: 'working', nativeId: 'native-busy' }]),
    entry('missing', undefined, [{ ...ended, id: 'unknown' }]), entry('newer', '0.1.0-alpha.140', [{ ...ended, id: 'newer' }]),
    entry('current', current, [{ ...ended, id: 'current' }]), entry('disk', '0.1.0-alpha.114', [{ ...ended, id: 'disk' }], { storageWarning: 'Synthetic refusal' })];
  const client = { entries, control: { maintenance: new Set() } }, before = JSON.stringify(entries);
  const result = mainOptions(client);
  assert.equal(result.length, 5); assert.equal(result.filter(value => value.ready).length, 1);
  assert.equal(result.find(value => value.backendKey === 'old').count, 2);
  assert.equal(result.find(value => value.backendKey === 'old').id, 'ended');
  assert.equal(result.find(value => value.backendKey === 'mixed').ready, false);
  assert.equal(result.find(value => value.backendKey === 'newer').ready, false);
  assert.equal(result.find(value => value.backendKey === 'missing').ready, false);
  assert.equal(result.find(value => value.backendKey === 'disk').ready, false);
  assert.equal(JSON.stringify(entries), before);
  client.control.maintenance.add('old'); assert.equal(mainOptions(client).find(value => value.backendKey === 'old').ready, false);
  client.control.maintenance.clear(); client.entries.push(entries[0]); assert.equal(mainOptions(client).length, 5);
  client.sessionState = value => value.id === 'peer' ? 'working' : value.state;
  assert.equal(mainOptions(client).find(value => value.backendKey === 'old').ready, false);
});

function handlers(client, answer, events) {
  const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8'), registered = {};
  const start = main.indexOf("  register('connectionUpdates',"), end = main.indexOf("  for (const action of ['resume', 'forget'])", start);
  assert.ok(start > 0 && end > start);
  const scope = { register: (name, handler) => registered[name] = handler, roomState: undefined,
    app: { getVersion: () => current }, connectionUpdateOptions: (c, version) => mainOptions(c, version),
    continuationStatus: require('../service-client.cjs').continuationStatus,
    dialog: { async showMessageBox() { events.dialog++; return answer(); } },
    async continueService() { events.update++; throw Error('Unexpected backend write'); },
    dataDir: 'synthetic-profile', process: { execPath: 'synthetic-node' } };
  vm.runInNewContext(main.slice(start, end), scope); return registered;
}
function clientFixture() {
  const entry = { key: 'old', state: { runtimeVersion: '0.1.0-alpha.120', sessions: [{ id: 's', nativeId: 'native-s', state: 'ended' }], capabilities: ['atomicShutdown'] } };
  const events = { refresh: 0, dialog: 0, update: 0, maintenance: 0 }, client = {
    entries: [entry], control: { maintenance: new Set() },
    async refresh() { events.refresh++; }, route(id) { assert.equal(id, 's'); return entry; }, operationGuard() { return () => {}; },
    maintainService() { events.maintenance++; throw Error('Unexpected maintenance'); },
  };
  return { entry, events, client, context: { client, win: {} }, expected: { backendKey: 'old', nativeId: 'native-s', version: entry.state.runtimeVersion } };
}
test('the actual read-only IPC reports choices without confirmation, maintenance, service start or input', async () => {
  const f = clientFixture(), h = handlers(f.client, () => { throw Error('Unexpected dialog'); }, f.events);
  const choices = await h.connectionUpdates(f.context);
  assert.equal(choices[0].ready, true); assert.deepEqual(f.events, { refresh: 1, dialog: 0, update: 0, maintenance: 0 });
});
test('a stale summary native identity is refused before presenting an update confirmation', async () => {
  const f = clientFixture(), h = handlers(f.client, () => ({ response: 1 }), f.events);
  await assert.rejects(h.continueConnection(f.context, 's', { ...f.expected, nativeId: 'another-native' }), /身份、版本或更新资格已变化/);
  assert.equal(f.events.dialog, 0); assert.equal(f.events.update, 0); assert.equal(f.events.maintenance, 0);
});
test('cancellation preserves the connection; a new active turn or identity after confirmation also prevents any update', async () => {
  const f = clientFixture(), canceled = handlers(f.client, () => ({ response: 0 }), f.events);
  assert.equal(await canceled.continueConnection(f.context, 's', f.expected), false);
  assert.equal(f.events.maintenance, 0); assert.equal(f.events.update, 0);
  for (const change of [entry => entry.state.sessions[0].state = 'working', entry => entry.state.sessions[0].nativeId = 'changed-native']) {
    const fixture = clientFixture(), h = handlers(fixture.client, () => { change(fixture.entry); return { response: 1 }; }, fixture.events);
    await assert.rejects(h.continueConnection(fixture.context, 's', fixture.expected), /核对期间/);
    assert.equal(fixture.events.maintenance, 0); assert.equal(fixture.events.update, 0);
  }
});

function menuFixture() {
  let resolve, requestCount = 0, menu;
  const pending = new Promise(value => resolve = value), control = { isConnected: true, hidden: false }, calls = { updates: [], toasts: [], renders: 0 };
  const c = vm.createContext({ checkingBackendVersions: false, backendVersionMenu: null, backendVersionTicket: 0, selectionRevision: 1, disconnected: false, state: {},
    $: () => control, document: { activeElement: control, querySelector: () => null },
    api: { connectionUpdates() { requestCount++; return pending; }, async continueConnection(...args) { calls.updates.push(args); return false; } },
    ui: { menu(value) { menu = value; return () => {}; } }, renderVersions() { calls.renders++; },
    versionValue: value => value, toast: value => calls.toasts.push(value), attempt: work => work() });
  // Model a browser dropping focus on native disable. This is an async focus
  // contract test, not a claim that a real Chromium GUI has been exercised.
  let disabled = false;
  Object.defineProperty(control, 'disabled', { get: () => disabled, set(value) { disabled = value; if (value) c.document.activeElement = {}; } });
  control.attributes = {}; control.setAttribute = (name, value) => control.attributes[name] = value;
  vm.runInContext(source.slice(source.indexOf('async function openBackendVersions('), source.indexOf("$('backend-version-summary').onclick")) + ';this.open = openBackendVersions;', c);
  return { c, control, calls, resolve, get requests() { return requestCount; }, get menu() { return menu; } };
}
test('an earlier read-only version check cannot open a menu after navigation or focus leaves its button', async () => {
  for (const change of [f => f.c.selectionRevision++, f => f.c.document.activeElement = {}, f => f.c.backendVersionTicket++]) {
    const f = menuFixture(), opening = f.c.open(); change(f);
    f.resolve([{ version: 'old', count: 1, ready: false }]); await opening;
    assert.equal(f.menu, undefined); assert.equal(f.c.checkingBackendVersions, false); assert.equal(f.calls.renders, 1);
  }
});
test('one read-only check stays in flight, and a canceled update never claims that work was scheduled or updated', async () => {
  const f = menuFixture(), opening = f.c.open(); await f.c.open(); assert.equal(f.requests, 1);
  assert.equal(f.control.disabled, false); assert.equal(f.c.document.activeElement, f.control);
  const option = { id: 's', backendKey: 'old', nativeId: 'native-s', version: '0.1.0-alpha.120', count: 2, ready: true };
  f.resolve([option]); await opening; await f.menu.onSelect('0');
  assert.equal(f.calls.updates.length, 1); assert.deepEqual(plain(f.calls.updates[0]), ['s', { backendKey: 'old', nativeId: 'native-s', version: '0.1.0-alpha.120' }]);
  assert.deepEqual(f.calls.toasts, []);
  const blocked = menuFixture(), loading = blocked.c.open(); blocked.resolve([{ ...option, ready: false, reason: 'Working connection retained' }]); await loading;
  blocked.menu.onSelect('0'); assert.deepEqual(blocked.calls.toasts, ['Working connection retained']); assert.equal(blocked.calls.updates.length, 0);
});
