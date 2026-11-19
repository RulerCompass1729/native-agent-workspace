const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const locale = require('../ui-locale.js'), operation = require('../background-operation.cjs');
const source = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
function harness(method = 'roomRename', args = ['Next'], language = 'zh') {
  const notices = [], decisions = [], reveals = [];
  const actor = { id: 'agent', nativeId: 'native-agent', name: 'Lead', provider: 'claude' };
  const snapshot = { sessions: [{ ...actor }, { id: 'target', nativeId: 'native-target', name: 'Worker', provider: 'codex', roomIds: ['shared'] }], rooms: [{ id: 'shared', name: 'Lab', archived: false }] };
  const record = { id: 'operation', at: Date.now(), actor, command: { method, arguments: args }, state: 'confirmation-required', confirmation: { kind: 'message', options: { message: 'Complete confirmation', detail: 'PRIVATE_DETAIL', buttons: ['Cancel', 'Confirm'], cancelId: 0 } } };
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; notices.push(this); }
    show() {} close() { this.closed = true; this.emit('close'); }
  }
  const control = { receipt: () => record, view: async () => ({ checkActor: async () => {}, client: { snapshot: () => snapshot } }),
    mobileBinding: (_s, _n, _id, response) => { if (record.state !== 'confirmation-required') throw Error('Handled'); return { sessionId: actor.id, nativeId: actor.nativeId, operationId: record.id, expiresAt: record.at + 600000, version: 'version', presentation: 'presentation', decision: response }; },
    decide: async (...args) => { args[4]?.(); decisions.push(args.slice(0, 4)); record.state = 'complete'; } };
  const context = { require: createRequire(require.resolve('../main.cjs')), Notification, backgroundOperation: operation,
    displayText: (key, params) => locale.format(language, key, params), backgroundControl: control, backgroundNotifications: null, notificationScreen: screenState(),
    roomState: { value: { sessionArchives: {} }, apply: value => value }, sessionLabels: { apply: value => value },
    confirmationSnapshot: client => client.snapshot(), queueOutcomeSeen: new Set(), queueOutcomeNotifications: new Map(), revealRecord: value => reveals.push(value), primary: true, quitting: false };
  const start = source.lastIndexOf('\n', source.indexOf('function notifyBackgroundConfirmation(')) + 1, end = source.indexOf('\nfunction notifyQueueOutcome(', start);
  vm.runInNewContext(source.slice(start, end), context);
  return { record, snapshot, notices, decisions, reveals, context, async notify() { await context.notifyBackgroundConfirmation(record); }, dispose() { context.backgroundNotifications?.dispose(); } };
}
for (const [method, args] of [['roomRename', ['Next']], ['rename', ['target', 'Next']], ['join', ['target', false]]]) {
  test('production notification offers explicit actions for a complete short ' + method, async t => {
    const h = harness(method, args); t.after(() => h.dispose()); await h.notify();
    assert.deepEqual(h.notices[0].options.actions?.map(value => value.text), ['确认', '拒绝']);
    assert.match(h.notices[0].options.body, /截止/); assert.doesNotMatch(h.notices[0].options.body, /PRIVATE_DETAIL/);
  });
}
test('production long/private confirmation only opens the full card', async t => {
  const h = harness('input', ['target', 'PRIVATE_NATIVE_PROMPT']); t.after(() => h.dispose()); await h.notify();
  assert.equal(h.notices[0].options.actions, undefined); assert.match(h.notices[0].options.body, /点开看全文/);
  assert.doesNotMatch(JSON.stringify(h.notices[0].options), /PRIVATE/);
});
module.exports = { harness };
const { ConfirmationNotifications, shortPresentation } = require('../confirmation-notifications.cjs');
const flush = () => new Promise(resolve => setImmediate(resolve));
for (const [index, response] of [[0, 1], [1, 0]]) test('action index ' + index + ' explicitly maps to card response ' + response + ' once', async t => {
  const h = harness(); t.after(() => h.dispose()); await h.notify();
  h.notices[0].emit('action', { actionIndex: index }, index); h.notices[0].emit('action', { actionIndex: index }, index); await flush();
  assert.equal(h.decisions.length, 1); assert.deepEqual(h.decisions[0], ['agent', 'native-agent', 'operation', response]);
});
for (const kind of ['close', 'click', 'restart', 'expired', 'native-replaced', 'handled', 'presentation-changed', 'clock-backward']) test(kind + ' never approves', async t => {
  const h = harness(); t.after(() => h.dispose()); await h.notify();
  if (kind === 'close' || kind === 'click') h.notices[0].emit(kind);
  if (kind === 'restart') h.dispose();
  if (kind === 'expired') h.context.backgroundNotifications.now = () => h.record.at + 600000;
  if (kind === 'clock-backward') h.context.backgroundNotifications.now = () => h.record.at - 1;
  if (kind === 'native-replaced') h.context.backgroundControl.mobileBinding = () => { throw Error('Native replaced'); };
  if (kind === 'handled') h.record.state = 'cancelled';
  if (kind === 'presentation-changed') h.context.backgroundControl.mobileBinding = () => ({ version: 'changed' });
  h.notices[0].emit('action', { actionIndex: 0 }); await flush();
  assert.equal(h.decisions.length, 0); if (kind === 'click') assert.equal(h.reveals.length, 1);
});
for (const [event, legacy] of [[{ actionIndex: -1 }, undefined], [{ actionIndex: 2 }, undefined], [{ actionIndex: '0' }, undefined], [{ actionIndex: 0 }, 1], [{}, NaN]]) test('invalid action cannot select another card button: ' + JSON.stringify([event, legacy]), async t => {
  const h = harness(); t.after(() => h.dispose()); await h.notify(); h.notices[0].emit('action', event, legacy); await flush(); assert.equal(h.decisions.length, 0);
});
for (const language of ['zh', 'en']) test('bounded complete projection and explicit fallback in ' + language, async t => {
  const h = harness('rename', ['target', 'Next'], language); t.after(() => h.dispose()); await h.notify();
  const shown = h.notices[0].options; assert.match(shown.title, /Lead.*Claude/); assert.match(shown.body, /Worker.*Codex.*Lab.*Next/);
  assert.ok([...shown.body].length <= 120); assert.equal(shown.actions.length, 2);
  h.record.command.arguments[1] = 'long '.repeat(100);
  assert.equal(shortPresentation(h.record, { state: h.snapshot }, (key, params) => locale.format(language, key, params), Date.now()), null);
});
for (const [method, args] of [['spaceCreate', ['New']], ['spaceAction', ['shared', 'rename', ['New']]], ['spaceAction', ['shared', 'join', ['target', false]]], ['archiveSession', ['target']]]) test('allowlisted exact shape ' + JSON.stringify([method, args]), async t => {
  const h = harness(method, args); t.after(() => h.dispose()); await h.notify(); assert.equal(h.notices[0].options.actions.length, 2);
});
test('restore includes its verified saved home; ambiguous or unavailable homes fall back', async t => {
  const h = harness('restoreSession', ['target']); t.after(() => h.dispose()); const s = h.snapshot.sessions[1]; s.archived = true; s.roomIds = [];
  h.context.roomState.value.sessionArchives.target = { nativeId: s.nativeId, detached: { nativeId: s.nativeId, connectionRevision: 0, revision: 0, signature: JSON.stringify([[], 0, []]) }, rooms: [{ id: 'shared' }] };
  await h.notify(); assert.equal(h.notices[0].options.actions.length, 2); assert.match(h.notices[0].options.body, /Lab/);
  h.context.roomState.value.sessionArchives.target.rooms.push({ id: 'another' });
  assert.equal(shortPresentation(h.record, { state: h.snapshot, archives: h.context.roomState.value.sessionArchives }, (k, p) => locale.format('zh', k, p), Date.now()), null);
});
for (const mutate of [h => { h.record.handlerStarted = true; }, h => { h.snapshot.sessions[0].nativeId = 'other'; }, h => { h.record.command.arguments.push('hidden'); }, h => { h.record.command.paths = ['/private/SECRET']; }, h => { h.snapshot.sessions[1].roomIds = ['shared', 'other']; }, h => { h.snapshot.rooms[0].archived = true; }, h => { h.record.command.arguments[1] = 'bad\nname'; }]) test('incomplete or changed short-card facts get no approval action', async t => {
  const h = harness('rename', ['target', 'Next']); t.after(() => h.dispose()); mutate(h); await h.notify(); assert.equal(h.notices[0].options.actions, undefined);
});
test('private unsupported input is not inspected by the notification projection', () => {
  const h = harness('input', []); Object.defineProperty(h.record.confirmation.options, 'detail', { get() { throw Error('PRIVATE DETAIL READ'); } });
  assert.equal(shortPresentation(h.record, { state: h.snapshot }, (k, p) => locale.format('zh', k, p), Date.now()), null);
});
test('expiry and decision changes close notices; changed callback cannot throw into operation persistence', async t => {
  const h = harness(); t.after(() => h.dispose()); await h.notify(); h.record.state = 'complete'; assert.doesNotThrow(() => h.context.backgroundNotifications.sync()); assert.equal(h.notices[0].closed, true);
  const long = harness('input', []); t.after(() => long.dispose()); await long.notify(); long.context.backgroundControl.receipt = () => { throw Error('Storage unavailable'); };
  assert.doesNotThrow(() => long.context.backgroundNotifications.sync()); assert.equal(long.notices[0].closed, true);
});
test('expiry timer only removes OS notice and does not make a human decision', async () => {
  const h = harness(), scheduled = [], cancelled = []; let writes = 0;
  const c = new ConfirmationNotifications({ Notification: h.context.Notification, control: h.context.backgroundControl, screen: screenState(), snapshot: async () => ({ state: h.snapshot }), format: h.context.displayText, reveal() {}, schedule: fn => (scheduled.push(fn), 1), cancel: timer => cancelled.push(timer) });
  h.context.backgroundControl.decide = () => { writes++; }; await c.notify(h.record); scheduled[0](); assert.equal(writes, 0); assert.equal(h.notices[0].closed, true); assert.deepEqual(cancelled, [1]); c.dispose();
});
for (const kind of ['actor-provider', 'duplicate-actor', 'duplicate-target', 'duplicate-room', 'unknown-provider', 'private-name-path']) test('ambiguous display identity has no quick approval: ' + kind, async t => {
  const h = harness('rename', ['target', 'Next']); t.after(() => h.dispose());
  if (kind === 'actor-provider') h.snapshot.sessions[0].provider = 'codex';
  if (kind === 'duplicate-actor') h.snapshot.sessions.push({ ...h.snapshot.sessions[0], id: 'other' });
  if (kind === 'duplicate-target') h.snapshot.sessions.push({ ...h.snapshot.sessions[1], id: 'other' });
  if (kind === 'duplicate-room') h.snapshot.rooms.push({ ...h.snapshot.rooms[0], id: 'other' });
  if (kind === 'unknown-provider') h.snapshot.sessions[1].provider = 'unknown';
  if (kind === 'private-name-path') h.record.command.arguments[1] = '/private/file';
  await h.notify(); assert.equal(h.notices[0].options.actions, undefined);
});
test('main snapshot boundary only gives notification code necessary metadata', async () => {
  const h = harness('restoreSession', ['target']); h.snapshot.sessions[1].messages = [{ text: 'PRIVATE_BODY' }]; h.snapshot.rooms[0].notes = 'PRIVATE_NOTES';
  h.context.roomState.value.sessionArchives.target = { nativeId: 'native-target', detached: { secret: 'PRIVATE_PLAN' }, rooms: [{ id: 'shared', secret: 'PRIVATE_ROOM_PLAN' }], checkpoint: 'PRIVATE_CHECKPOINT' };
  const originalRequire = h.context.require; let captured;
  h.context.require = name => name === './confirmation-notifications.cjs' ? { ConfirmationNotifications: class { constructor(options) { this.options = options; } async notify(row) { captured = await this.options.snapshot(row); } } } : originalRequire(name);
  await h.notify(); assert.doesNotMatch(JSON.stringify(captured), /PRIVATE/); assert.equal(captured.archives.target.restorable, false);
  assert.deepEqual(Object.keys(captured.state.rooms[0]).sort(), ['archived', 'id', 'name']);
});
test('disposing while metadata is pending never creates a late notification', async () => {
  const h = harness(); let release; const pending = new Promise(resolve => { release = resolve; });
  const c = new ConfirmationNotifications({ Notification: h.context.Notification, control: h.context.backgroundControl, screen: screenState(), snapshot: () => pending, format: h.context.displayText, reveal() {} });
  const notification = c.notify(h.record); c.dispose(); release({ state: h.snapshot }); await notification; assert.equal(h.notices.length, 0);
});
for (const [method, args] of [['create', [{ provider: 'codex', cwd: 'PRIVATE_PATH' }]], ['importHistory', ['PRIVATE_ID']], ['archiveRoom', []], ['restoreRoom', []], ['roomMemberOrder', [{ order: ['PRIVATE_ID'] }]], ['spaceMerge', ['commit', { private: 'PRIVATE_TEXT' }]], ['initial', ['target']], ['runtimeLocation', ['claude']], ['pause', []], ['interrupt', ['target']], ['terminal', ['target']], ['openLocalFile', ['PRIVATE_PATH']], ['saveLocalFile', ['PRIVATE_TOKEN']], ['pasteNativeContent', ['target']], ['answer', ['target', 'PRIVATE_ANSWER']], ['spaceAction', ['shared', 'memberOrder', ['PRIVATE_ID']]]]) test('non-allowlisted action is open-only: ' + method + '/' + args[1], async t => {
  const h = harness(method, args); t.after(() => h.dispose()); await h.notify();
  assert.equal(h.notices[0].options.actions, undefined); assert.doesNotMatch(JSON.stringify(h.notices[0].options), /PRIVATE/);
});
test('duplicate delivery during pending metadata emits only once', async () => {
  const h = harness(); let release; const pending = new Promise(resolve => { release = resolve; });
  const c = new ConfirmationNotifications({ Notification: h.context.Notification, control: h.context.backgroundControl, screen: screenState(), snapshot: () => pending, format: h.context.displayText, reveal() {} });
  const first = c.notify(h.record), second = c.notify(h.record); release({ state: h.snapshot }); await Promise.all([first, second]); assert.equal(h.notices.length, 1); c.dispose();
});
for (const name of ['a\u2028b', 'a\u2029b', 'a\u202eb', 'a\ud800b']) test('invisible or invalid name cannot hide notification facts: ' + JSON.stringify(name), async t => {
  const h = harness('rename', ['target', name]); t.after(() => h.dispose()); await h.notify(); assert.equal(h.notices[0].options.actions, undefined);
});
test('notification cannot present a different request after asynchronous metadata lookup', async () => {
  const h = harness(); const original = structuredClone(h.record); h.context.backgroundControl.receipt = () => original;
  let release; const pending = new Promise(resolve => { release = resolve; });
  const c = new ConfirmationNotifications({ Notification: h.context.Notification, control: h.context.backgroundControl, screen: screenState(), snapshot: () => pending, format: h.context.displayText, reveal() {} });
  const notification = c.notify(h.record); h.record.command.arguments[0] = 'Different'; release({ state: h.snapshot }); await notification;
  assert.equal(h.notices[0].options.actions, undefined); c.dispose();
});
test('shared seen-set eviction cannot duplicate a still-live notification', async () => {
  const h = harness(), seen = new Set();
  const c = new ConfirmationNotifications({ Notification: h.context.Notification, control: h.context.backgroundControl, screen: screenState(), snapshot: async () => ({ state: h.snapshot }), format: h.context.displayText, reveal() {}, seen });
  await c.notify(h.record); seen.clear(); await c.notify(h.record); assert.equal(h.notices.length, 1); c.dispose();
});
test('incomplete binding never enables quick approval', async t => {
  const h = harness(); t.after(() => h.dispose()); h.context.backgroundControl.mobileBinding = () => ({}); await h.notify();
  assert.equal(h.notices[0].options.actions, undefined); assert.match(h.notices[0].options.body, /截止/);
});
test('failed-boot controller replacement disposes old notices and binds new ones to the replacement', async t => {
  const h = harness(); t.after(() => h.dispose()); await h.notify(); const old = h.notices[0], oldManager = h.context.backgroundNotifications;
  h.context.backgroundControl.closed = true;
  h.context.backgroundControl = { ...h.context.backgroundControl, closed: false };
  h.record.id = 'next-operation'; await h.notify();
  assert.equal(oldManager.disposed, true); assert.equal(old.closed, true); assert.equal(h.notices[1].options.actions.length, 2);
  old.emit('action', { actionIndex: 0 }); h.notices[1].emit('action', { actionIndex: 0 }); await flush(); assert.equal(h.decisions.length, 1);
});
function screenState(initial = 'unlocked') {
  let state = initial, revision = 0; const listeners = new Set();
  return { isUnlocked: () => state === 'unlocked', get revision() { return revision; }, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    set(value) { state = value; revision++; for (const fn of listeners) fn(); }, get listenerCount() { return listeners.size; } };
}
for (const invalid of ['revision', 'signature']) test('restore cannot promise a saved home with mismatched ' + invalid, async t => {
  const h = harness('restoreSession', ['target']); t.after(() => h.dispose()); const s = h.snapshot.sessions[1];
  s.archived = true; s.roomIds = []; s.placementRevision = 2;
  h.context.roomState.value.sessionArchives.target = { nativeId: s.nativeId, detached: { nativeId: s.nativeId, connectionRevision: 0, revision: invalid === 'revision' ? 1 : 2, signature: invalid === 'signature' ? 'different' : JSON.stringify([[], 0, []]) }, rooms: [{ id: 'shared' }] };
  await h.notify(); assert.equal(h.notices[0].options.actions, undefined); assert.match(h.notices[0].options.body, /点开看全文/);
});
for (const state of ['locked', 'unknown']) test(state + ' screen never offers notification decisions', async t => {
  const h = harness(); t.after(() => h.dispose()); h.context.notificationScreen = screenState(state); await h.notify(); assert.equal(h.notices[0].options.actions, undefined);
  h.notices[0].emit('action', { actionIndex: 0 }); await flush(); assert.equal(h.decisions.length, 0);
});
test('locking an existing button revokes it and defers revealing until unlock', async t => {
  const h = harness(); t.after(() => h.dispose()); const screen = screenState(); h.context.notificationScreen = screen; await h.notify();
  screen.set('locked'); h.notices[0].emit('action', { actionIndex: 0 }); await flush(); assert.equal(h.decisions.length, 0); assert.equal(h.reveals.length, 0);
  screen.set('unlocked'); assert.equal(h.reveals.length, 1); h.notices[0].emit('action', { actionIndex: 0 }); await flush(); assert.equal(h.decisions.length, 0);
});
test('power monitor starts unknown; idle or user-active assumptions cannot grant unlock', () => {
  const { NotificationScreen } = require('../confirmation-notifications.cjs'), monitor = new EventEmitter();
  let idle = 'active'; monitor.getSystemIdleState = () => idle;
  const screen = new NotificationScreen(monitor); assert.equal(screen.isUnlocked(), false);
  monitor.emit('user-did-become-active'); assert.equal(screen.isUnlocked(), false); monitor.emit('unlock-screen'); assert.equal(screen.isUnlocked(), true);
  for (const event of ['lock-screen', 'suspend', 'resume', 'user-did-resign-active']) { monitor.emit(event); assert.equal(screen.isUnlocked(), false); monitor.emit('unlock-screen'); assert.equal(screen.isUnlocked(), true); }
  idle = 'unknown'; assert.equal(screen.isUnlocked(), false); idle = 'locked'; assert.equal(screen.isUnlocked(), false); idle = 'active';
  screen.dispose(); for (const name of ['lock-screen', 'unlock-screen', 'suspend', 'resume', 'user-did-resign-active']) assert.equal(monitor.listenerCount(name), 0);
  monitor.emit('unlock-screen'); assert.equal(screen.isUnlocked(), false);
});
test('new process without a screen authority is open-only', async () => {
  const h = harness(); const c = new ConfirmationNotifications({ Notification: h.context.Notification, control: h.context.backgroundControl, snapshot: async () => ({ state: h.snapshot }), format: h.context.displayText, reveal() {} });
  await c.notify(h.record); assert.equal(h.notices[0].options.actions, undefined); h.notices[0].emit('action', { actionIndex: 0 }); await flush(); assert.equal(h.decisions.length, 0); c.dispose();
});
test('revoked button cannot revive after unlock; deferred records are metadata only and deduplicated', async t => {
  const h = harness(); t.after(() => h.dispose()); const screen = screenState(); h.context.notificationScreen = screen; await h.notify();
  screen.set('unknown'); h.notices[0].emit('action', { actionIndex: 0 }); h.notices[0].emit('action', { actionIndex: 1 }); await flush();
  const manager = h.context.backgroundNotifications; assert.equal(manager.deferred.size, 1); assert.doesNotMatch(JSON.stringify([...manager.deferred.values()]), /PRIVATE_DETAIL|Complete confirmation/);
  screen.set('unlocked'); assert.equal(h.reveals.length, 1); h.notices[0].emit('action', { actionIndex: 0 }); await flush(); assert.equal(h.reveals.length, 1); assert.equal(h.decisions.length, 0);
  h.record.id = 'fresh-operation'; await h.notify(); h.notices[1].emit('action', { actionIndex: 0 }); await flush(); assert.equal(h.decisions.length, 1);
});
test('dispose removes screen subscription and pending fullscreen reveals', async () => {
  const h = harness(); const screen = screenState(); h.context.notificationScreen = screen; await h.notify(); assert.equal(screen.listenerCount, 1);
  screen.set('locked'); h.notices[0].emit('action', { actionIndex: 0 }); h.dispose(); assert.equal(screen.listenerCount, 0); screen.set('unlocked'); assert.equal(h.reveals.length, 0);
});
test('main starts observing power events at readiness before the first notification', () => {
  const monitor = new EventEmitter(); monitor.getSystemIdleState = () => 'active'; const scope = { primary: true, notificationScreen: null, powerMonitor: monitor, require: createRequire(require.resolve('../main.cjs')), app: { whenReady: () => ({ then: fn => fn() }) } };
  const line = source.split('\n').find(value => value.startsWith('if (primary) app.whenReady().then(() => { notificationScreen'));
  assert.ok(line); vm.runInNewContext(line, scope); assert.equal(scope.notificationScreen.isUnlocked(), false); monitor.emit('unlock-screen'); assert.equal(scope.notificationScreen.isUnlocked(), true); scope.notificationScreen.dispose();
});
test('unavailable power monitor fails closed without leaking listeners', () => {
  const { NotificationScreen } = require('../confirmation-notifications.cjs'), monitor = new EventEmitter(), on = monitor.on.bind(monitor);
  monitor.on = (event, fn) => { if (event === 'resume') throw Error('No power source'); return on(event, fn); };
  const screen = new NotificationScreen(monitor); monitor.emit('unlock-screen'); assert.equal(screen.isUnlocked(), false); assert.equal(monitor.listenerCount('lock-screen'), 0);
});
test('query-only lock veto is released only by unlock and never revives the old button', async t => {
  const { NotificationScreen } = require('../confirmation-notifications.cjs'), monitor = new EventEmitter(); let idle = 'active'; monitor.getSystemIdleState = () => idle;
  const screen = new NotificationScreen(monitor), h = harness(); t.after(() => { h.dispose(); screen.dispose(); }); h.context.notificationScreen = screen;
  monitor.emit('unlock-screen'); await h.notify(); idle = 'locked'; h.notices[0].emit('action', { actionIndex: 0 }); await flush(); assert.equal(h.decisions.length, 0); assert.equal(h.reveals.length, 0);
  idle = 'active'; monitor.emit('unlock-screen'); assert.equal(h.reveals.length, 1); h.notices[0].emit('action', { actionIndex: 0 }); await flush(); assert.equal(h.decisions.length, 0);
});
test('unknown native query retires the unlock until a fresh unlock event', () => {
  const { NotificationScreen } = require('../confirmation-notifications.cjs'), monitor = new EventEmitter(); let idle = 'active'; monitor.getSystemIdleState = () => idle;
  const screen = new NotificationScreen(monitor); monitor.emit('unlock-screen'); assert.equal(screen.isUnlocked(), true); const revision = screen.revision;
  idle = 'unknown'; assert.equal(screen.isUnlocked(), false); assert.ok(screen.revision > revision); idle = 'active'; assert.equal(screen.isUnlocked(), false);
  monitor.emit('unlock-screen'); assert.equal(screen.isUnlocked(), true); screen.dispose();
});
test('unknown startup state preserves the existing body-click route to the full card', async t => {
  const h = harness(); t.after(() => h.dispose()); h.context.notificationScreen = screenState('unknown'); await h.notify();
  assert.equal(h.notices[0].options.actions, undefined); h.notices[0].emit('click'); assert.equal(h.reveals.length, 1); assert.equal(h.decisions.length, 0);
});
