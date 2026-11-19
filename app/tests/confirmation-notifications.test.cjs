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
    displayText: (key, params) => locale.format(language, key, params), backgroundControl: control, backgroundNotifications: null,
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
  h.context.roomState.value.sessionArchives.target = { nativeId: s.nativeId, detached: {}, rooms: [{ id: 'shared' }] };
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
  const c = new ConfirmationNotifications({ Notification: h.context.Notification, control: h.context.backgroundControl, snapshot: async () => ({ state: h.snapshot }), format: h.context.displayText, reveal() {}, schedule: fn => (scheduled.push(fn), 1), cancel: timer => cancelled.push(timer) });
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
  await h.notify(); assert.doesNotMatch(JSON.stringify(captured), /PRIVATE/); assert.equal(captured.archives.target.detached, true);
  assert.deepEqual(Object.keys(captured.state.rooms[0]).sort(), ['archived', 'id', 'name']);
});
test('disposing while metadata is pending never creates a late notification', async () => {
  const h = harness(); let release; const pending = new Promise(resolve => { release = resolve; });
  const c = new ConfirmationNotifications({ Notification: h.context.Notification, control: h.context.backgroundControl, snapshot: () => pending, format: h.context.displayText, reveal() {} });
  const notification = c.notify(h.record); c.dispose(); release({ state: h.snapshot }); await notification; assert.equal(h.notices.length, 0);
});
for (const [method, args] of [['create', [{ provider: 'codex', cwd: 'PRIVATE_PATH' }]], ['importHistory', ['PRIVATE_ID']], ['archiveRoom', []], ['restoreRoom', []], ['roomMemberOrder', [{ order: ['PRIVATE_ID'] }]], ['spaceMerge', ['commit', { private: 'PRIVATE_TEXT' }]], ['initial', ['target']], ['runtimeLocation', ['claude']], ['pause', []], ['interrupt', ['target']], ['terminal', ['target']], ['openLocalFile', ['PRIVATE_PATH']], ['saveLocalFile', ['PRIVATE_TOKEN']], ['pasteNativeContent', ['target']], ['answer', ['target', 'PRIVATE_ANSWER']], ['spaceAction', ['shared', 'memberOrder', ['PRIVATE_ID']]]]) test('non-allowlisted action is open-only: ' + method + '/' + args[1], async t => {
  const h = harness(method, args); t.after(() => h.dispose()); await h.notify();
  assert.equal(h.notices[0].options.actions, undefined); assert.doesNotMatch(JSON.stringify(h.notices[0].options), /PRIVATE/);
});
test('duplicate delivery during pending metadata emits only once', async () => {
  const h = harness(); let release; const pending = new Promise(resolve => { release = resolve; });
  const c = new ConfirmationNotifications({ Notification: h.context.Notification, control: h.context.backgroundControl, snapshot: () => pending, format: h.context.displayText, reveal() {} });
  const first = c.notify(h.record), second = c.notify(h.record); release({ state: h.snapshot }); await Promise.all([first, second]); assert.equal(h.notices.length, 1); c.dispose();
});
for (const name of ['a\u2028b', 'a\u2029b', 'a\u202eb', 'a\ud800b']) test('invisible or invalid name cannot hide notification facts: ' + JSON.stringify(name), async t => {
  const h = harness('rename', ['target', name]); t.after(() => h.dispose()); await h.notify(); assert.equal(h.notices[0].options.actions, undefined);
});
test('notification cannot present a different request after asynchronous metadata lookup', async () => {
  const h = harness(); const original = structuredClone(h.record); h.context.backgroundControl.receipt = () => original;
  let release; const pending = new Promise(resolve => { release = resolve; });
  const c = new ConfirmationNotifications({ Notification: h.context.Notification, control: h.context.backgroundControl, snapshot: () => pending, format: h.context.displayText, reveal() {} });
  const notification = c.notify(h.record); h.record.command.arguments[0] = 'Different'; release({ state: h.snapshot }); await notification;
  assert.equal(h.notices[0].options.actions, undefined); c.dispose();
});
test('shared seen-set eviction cannot duplicate a still-live notification', async () => {
  const h = harness(), seen = new Set();
  const c = new ConfirmationNotifications({ Notification: h.context.Notification, control: h.context.backgroundControl, snapshot: async () => ({ state: h.snapshot }), format: h.context.displayText, reveal() {}, seen });
  await c.notify(h.record); seen.clear(); await c.notify(h.record); assert.equal(h.notices.length, 1); c.dispose();
});
test('incomplete binding never enables quick approval', async t => {
  const h = harness(); t.after(() => h.dispose()); h.context.backgroundControl.mobileBinding = () => ({}); await h.notify();
  assert.equal(h.notices[0].options.actions, undefined); assert.match(h.notices[0].options.body, /截止/);
});
