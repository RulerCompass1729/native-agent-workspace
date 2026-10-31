const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { Workspace } = require('../workspace.cjs');
const app = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(app, 'main.cjs'), 'utf8');
const renderer = fs.readFileSync(path.join(app, 'renderer/renderer.js'), 'utf8');
const record = (extra = {}) => ({ id: 'synthetic-a', nativeId: 'native-a', name: 'Synthetic private task',
  state: 'error', fleet: [], liveDraft: '', messages: [{ text: 'Synthetic private body' }],
  capacityRecovery: { nativeId: 'native-a', turnId: 'failed-a', status: 'exhausted', attempt: 3, due: 0, reason: 'capacity' }, ...extra });
function section(start, end) {
  const a = main.indexOf(start), b = main.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'Actual production function exists: ' + start);
  return main.slice(a, b);
}
function harness() {
  const notifications = [], delivered = [], sent = [], callbacks = new Map();
  let supported = true, failDelivery = false, shows = 0, destroyed = false;
  class Notification extends EventEmitter {
    static isSupported() { return supported; }
    constructor(options) { super(); this.options = options; notifications.push(this); }
    show() { if (failDelivery) throw Error('Synthetic OS delivery failure'); delivered.push(this.options); }
  }
  const client = new EventEmitter(), win = { isDestroyed: () => destroyed, show: () => shows++,
    webContents: { send: (...args) => sent.push(args) } };
  const context = { client, win };
  const sandbox = { Notification, capacityNotifications: new Map(), context,
    roomState: { assertAvailable() {} }, displayState: value => value,
    notifyToolWait() {}, register: (name, callback) => callbacks.set(name, callback),
    applicationBuild: null, appBuildInfo: async () => ({}), app: { getVersion: () => 'synthetic' },
    dataDir: '/synthetic/profile', preflight: () => ({ synthetic: true }) };
  vm.createContext(sandbox);
  const notifier = section('function notifyCapacity(', '\nfunction bindClient(');
  const binding = section('function bindClient(', '\nfunction displayState(');
  const initial = section("register('initial',", '\n  register(');
  vm.runInContext(notifier + '\n' + binding + '\n' + initial + '\nbindClient(context);', sandbox);
  return { notifications, delivered, sent, client, win, sandbox,
    fire(sessions) { client.emit('state', { sessions }); },
    initial: value => { client.call = async method => { assert.equal(method, 'initial'); return value; }; return callbacks.get('initial')(context); },
    set supported(value) { supported = value; }, set failDelivery(value) { failDelivery = value; },
    set destroyed(value) { destroyed = value; }, get shows() { return shows; } };
}
function status(row, badge = true, connected = true) {
  const prefix = renderer.slice(0, renderer.indexOf('\nlet state, owner,'));
  assert.ok(prefix.includes('const sessionStatus ='));
  return vm.runInNewContext(prefix + '\nconst disconnected = !connected; sessionStatus(row, badge);',
    { window: { workspace: {}, nativeWorkspaceFleet: require('../renderer/fleet-observation.js') }, row, badge, connected });
}
test('the actual recovery descriptor carries only its failed native identity and existing facts', () => {
  const value = { ...record().capacityRecovery, runtime: { private: true }, owner: 'window' };
  const w = Object.create(Workspace.prototype); w.capacityRecoveries = new Map([['synthetic-a', value]]);
  const actual = w.capacityStatus('synthetic-a');
  assert.equal(actual.nativeId, value.nativeId); assert.equal(actual.turnId, value.turnId);
  assert.deepEqual(Object.keys(actual).sort(), ['attempt', 'due', 'nativeId', 'reason', 'status', 'turnId']);
  assert.equal(w.capacityStatus('missing'), null);
});
test('actual state and initial wiring notify each exhausted native episode once, including delayed repeats', async () => {
  const h = harness(), first = record(), before = JSON.stringify(first);
  h.fire([first]); assert.equal(h.delivered.length, 1);
  h.fire([first]); await h.initial({ sessions: [first] }); assert.equal(h.delivered.length, 1);
  const second = record({ capacityRecovery: { ...first.capacityRecovery, turnId: 'failed-b', reason: 'routing' } });
  h.fire([second]); await h.initial({ sessions: [first] }); h.fire([second]);
  assert.equal(h.delivered.length, 2, 'K1, K2, stale K1 cannot re-notify K1');
  for (const request of h.delivered) {
    assert.ok(!JSON.stringify(request).includes(first.name));
    assert.ok(!JSON.stringify(request).includes(first.messages[0].text));
  }
  assert.equal(JSON.stringify(first), before);
  assert.ok(h.sent.some(([channel]) => channel === 'workspace:state'));
  h.notifications[0].emit('click'); assert.equal(h.shows, 1);
  h.destroyed = true; h.notifications[1].emit('click'); assert.equal(h.shows, 1);
});
test('actual initial and live wiring both use the archive display projection', async () => {
  for (const initial of [false, true]) {
    const h = harness(), row = record();
    h.sandbox.displayState = data => ({ ...data, sessions: data.sessions.map(s => ({ ...s, archived: true })) });
    if (initial) await h.initial({ sessions: [row] }); else h.fire([row]);
    assert.equal(h.delivered.length, 0);
  }
  const h = harness(); await h.initial({ sessions: [record()] }); assert.equal(h.delivered.length, 1, 'Initial alone covers an exhausted session on reopen');
});
test('a window closed during the awaited initial snapshot cannot claim a notification episode', async () => {
  const h = harness(); let release;
  const pending = h.initial(new Promise(resolve => { release = resolve; }));
  h.destroyed = true; release({ sessions: [record()] }); await pending;
  assert.equal(h.delivered.length, 0); assert.equal(h.sandbox.capacityNotifications.size, 0);
});
test('the production notifier retains live notification objects and releases closed or failed delivery without rearming', () => {
  const h = harness(), row = record(); h.fire([row]);
  const notices = h.sandbox.capacityNotifications.get(row.id), notification = h.notifications[0];
  assert.ok(notices.active.has(notification), 'Main owns the object until its close event');
  notification.emit('close'); assert.equal(notices.active.size, 0);
  h.fire([row]); assert.equal(h.delivered.length, 1, 'Closing the object never re-arms the same failed episode');
  const failed = harness(); failed.failDelivery = true; failed.fire([row]);
  assert.equal(failed.sandbox.capacityNotifications.get(row.id).active.size, 0);
});
test('unsupported and failed OS delivery are remembered without altering the in-app status', () => {
  for (const fail of [false, true]) {
    const h = harness(), row = record(); h.supported = fail; h.failDelivery = fail;
    h.fire([row]); h.fire([row]); assert.equal(h.delivered.length, 0);
    assert.equal(h.notifications.length, fail ? 1 : 0);
    assert.notEqual(status(row), status(row, false));
  }
});
test('only a current eligible exhausted descriptor adds the sidebar notice or OS request', () => {
  const original = record(), r = original.capacityRecovery;
  const invalid = [
    { archived: true }, { transportDisconnected: true }, { backendUnavailable: true },
    { nativeContextPending: {} }, { approval: {} }, { approvalOverflow: true },
    { claudeQuestion: {} }, { nativeApproval: {} }, { nativeInputRequired: true },
    ...['working', 'approval', 'ended', 'recoverable', 'disconnected', 'stopping', 'background'].map(state => ({ state })),
    ...[{ nativeId: 'another-native' }, { nativeId: undefined }, { turnId: undefined }, { turnId: '' },
      { status: 'scheduled' }, { attempt: 2 }, { attempt: 4 }, { reason: 'other' }].map(delta => ({ capacityRecovery: { ...r, ...delta } })),
  ];
  for (const change of invalid) {
    const row = record(change), h = harness(); h.fire([row]); assert.equal(h.delivered.length, 0, JSON.stringify(change));
    assert.equal(status(row), status(row, false), JSON.stringify(change));
  }
  assert.equal(status(original, true, false), status(original, false, false), 'Disconnected display does not advertise stale recovery');
});
test('sidebar and accessible labels opt in while selected header and native fleet observations remain intact', () => {
  const row = record({ state: 'idle', fleet: [{ event: 'subAgentActivity', nativeId: 'child', kind: 'started', stale: false }] });
  const normal = status(row, false), notice = status(row);
  assert.ok(notice.startsWith(normal)); assert.ok(notice.length > normal.length);
  const routing = record({ capacityRecovery: { ...row.capacityRecovery, reason: 'routing' } });
  assert.notEqual(status(routing), status(routing, false));
  assert.equal((renderer.match(/sessionStatus\(record, true\)/g) || []).length, 2, 'Existing sidebar text and aria caller only');
  assert.ok(renderer.includes('sessionStatus(s)')); assert.ok(!renderer.includes('sessionStatus(s, true)'));
});
