'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { RoomState } = require('../room-state.cjs');
const { ButlerIngress, bindQueueOutcomes } = require('../butler-ingress.cjs');
const { showQuestionNotification } = require('../butler-question-notification.cjs');
const locale = require('../ui-locale.js'), queueRules = require('../queue-dispatch.cjs');
const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
const section = (start, end) => { const a = main.indexOf(start), b = main.indexOf(end, a + start.length); assert.ok(a >= 0 && b > a); return main.slice(a, b); };
function fixture(t, mode = 'show') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-question-notification-'));
  fs.chmodSync(directory, 0o700); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const room = new RoomState(directory), ingress = new ButlerIngress(directory, { roomState: room }), ledger = ingress.ledger;
  ledger.openQuestionMetricEpoch('synthetic-epoch');
  const notifications = []; let supported = true;
  class Notification extends EventEmitter {
    static isSupported() { return supported; }
    constructor(options) { super(); this.options = options; notifications.push(this); }
    show() {
      this.intentAtShow = ledger.snapshot().questionSends.at(-1);
      if (mode === 'show') this.emit('show');
      else if (mode === 'failed') this.emit('failed', {}, 'Synthetic OS failure');
      else if (mode === 'throws') throw Error('Synthetic show failure');
    }
  }
  const context = { Notification, roomState: room, butlerIngress: ingress, showQuestionNotification, queueRules,
    untouchedDefault: require('../collaboration-spaces.cjs').untouchedDefault,
    queueOutcomeSeen: new Set(), queueOutcomeNotifications: new Map(), quitting: false,
    displayText: (key, args) => locale.format('en', key, args), revealRecord: () => {} };
  vm.createContext(context); vm.runInContext(section('function notifyQueueOutcome(', '\nfunction revealRecord('), context);
  bindQueueOutcomes(room, ingress, (...args) => context.notifyQueueOutcome(...args));
  function settle(status = 'waiting', reason = '') {
    const item = room.queueAdd('Synthetic work', null);
    room.queueMarkSent('shared', item, 'synthetic-member', 'Synthetic member', Date.now());
    room.queueSettle('shared', item, status, reason, 'Synthetic member', '', 'Proceed?');
    return room.metadata().events.at(-1);
  }
  return { room, ledger, ingress, context, notifications, settle, set supported(value) { supported = value; } };
}

test('actual B1 notifier journals canonical intent before show and counts actual show only', t => {
  const f = fixture(t), event = f.settle(), send = f.ledger.snapshot().questionSends[0];
  assert.equal(f.notifications.length, 1); assert.equal(f.notifications[0].intentAtShow.status, 'intent');
  assert.equal(send.sourceEventId, event.butlerSource.eventId); assert.notEqual(send.sourceEventId, event.id);
  assert.equal(send.questionId, f.ledger.snapshot().questions[0].questionId); assert.equal(send.attributed, true);
  assert.equal(f.ledger.questionSendMetrics().shownAttempts, 1); assert.equal(f.ledger.questionSendMetrics().repeatedQuestions, 0);
  f.context.notifyQueueOutcome({ roomId: 'shared', eventId: event.id, status: 'waiting', reason: '' });
  assert.equal(f.notifications.length, 1); assert.equal(f.ledger.questionSendMetrics().shownAttempts, 1);
});

test('show() returning void without OS receipt remains unknown, including after reload', t => {
  const f = fixture(t, 'silent'); f.settle();
  assert.equal(f.ledger.questionSendMetrics().shownAttempts, 0); assert.equal(f.ledger.questionSendMetrics().unknownAttempts, 1);
  assert.equal(f.ledger.questionSendMetrics().repeatedQuestions, null);
  const { ButlerLedger } = require('../butler-ledger.cjs');
  assert.equal(new ButlerLedger(f.ledger.directory).questionSendMetrics().repeatedQuestions, null);
  f.notifications[0].emit('show'); assert.equal(f.ledger.questionSendMetrics().repeatedQuestions, 0);
});

for (const mode of ['failed', 'unsupported']) test(`known non-display is recorded without inventing a shown question: ${mode}`, t => {
  const f = fixture(t, mode); if (mode === 'unsupported') f.supported = false; f.settle();
  const stats = f.ledger.questionSendMetrics();
  assert.equal(stats.shownAttempts, 0); assert.equal(stats.repeatedQuestions, 0);
  assert.equal(f.ledger.snapshot().questionSends[0].status, 'failed');
});

test('actual notifier exception cannot undo the durable queue outcome and remains unknown', t => {
  const f = fixture(t, 'throws'), event = f.settle();
  assert.equal(f.room.metadata().events.at(-1).id, event.id);
  assert.equal(f.ledger.questionSendMetrics().unknownAttempts, 1); assert.equal(f.ledger.questionSendMetrics().repeatedQuestions, null);
  assert.equal(f.context.queueOutcomeNotifications.size, 0);
});

test('ledger intent failure does not suppress B1, and open epoch cannot certify zero on restart', t => {
  const f = fixture(t);
  const original = f.ledger.beginQuestionSend.bind(f.ledger);
  f.ledger.beginQuestionSend = () => { throw Error('Synthetic metric write failure'); };
  f.settle(); f.ledger.beginQuestionSend = original;
  assert.equal(f.notifications.length, 1);
  assert.equal(f.ledger.questionSendMetrics().repeatedQuestions, null);
  assert.equal(f.ledger.snapshot().questionMetricGaps[0].reason, 'unobserved-send');
});

test('intake failure still displays B1 but its physical shown record is unattributed', t => {
  const f = fixture(t); f.ingress.captureOutcome = () => { throw Error('Synthetic intake failure'); }; f.settle();
  assert.equal(f.notifications.length, 1); assert.equal(f.ledger.questionSendMetrics().shownAttempts, 1);
  assert.equal(f.ledger.questionSendMetrics().unattributedAttempts, 1); assert.equal(f.ledger.questionSendMetrics().repeatedQuestions, null);
});

test('failure alerts and S2 confirmation do not count as B4 questions', t => {
  const f = fixture(t); f.settle('failed', 'member-missing');
  assert.equal(f.notifications.length, 1); assert.equal(f.ledger.snapshot().questionSends.length, 0);
  assert.equal(f.ledger.questionSendMetrics().repeatedQuestions, 0);
  const confirmation = section('function notifyBackgroundConfirmation(', '\nfunction notifyQueueOutcome(');
  assert.ok(!confirmation.includes('showQuestionNotification('));
});

test('an unexpected second OS display is not silently treated as an idempotent receipt', t => {
  const f = fixture(t); f.settle(); f.notifications[0].emit('show');
  assert.equal(f.ledger.questionSendMetrics().shownAttempts, 1);
  assert.equal(f.ledger.questionSendMetrics().repeatedQuestions, null);
  assert.equal(f.ledger.snapshot().questionMetricGaps[0].reason, 'unexpected-display');
});

test('shutdown prevents new B1 notifications after the owned epoch is closed', t => {
  const f = fixture(t); f.ledger.closeQuestionMetricEpoch(); f.context.quitting = true; f.settle();
  assert.equal(f.notifications.length, 0); assert.equal(f.ledger.snapshot().questionSends.length, 0);
});

test('Main retries reuse the same epoch owner and quit closes it without starting a model', t => {
  let created = 0, opened = 0, recovered = 0, closed = 0, dispatcherClosed = 0, notificationsDisposed = 0, screensDisposed = 0;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-question-main-epoch-')); fs.chmodSync(dataDir, 0o700);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const { ButlerLedger } = require('../butler-ledger.cjs');
  const context = { butlerIngress: null, roomState: { id: 'first' }, dataDir, randomUUID: () => 'synthetic-epoch',
    ButlerLedger, isCurrentHumanContext: () => false,
    ButlerIngress: class { constructor(_dir, { roomState, ledger }) { created++; this.roomState = roomState; this.ledger = ledger;
      const open = ledger.openQuestionMetricEpoch.bind(ledger), close = ledger.closeQuestionMetricEpoch.bind(ledger);
      ledger.openQuestionMetricEpoch = (...args) => { opened++; return open(...args); };
      ledger.closeQuestionMetricEpoch = (...args) => { closed++; return close(...args); }; }
      recover() { recovered++; } } };
  vm.createContext(context);
  const boot = section('    // One writer owns the display-measurement epoch.', '\n    butlerIngress.recover();') + '\n    butlerIngress.recover();';
  vm.runInContext(boot, context); context.roomState = { id: 'second' }; vm.runInContext(boot, context);
  assert.equal(created, 1); assert.equal(opened, 1); assert.equal(recovered, 2); assert.equal(context.butlerIngress.roomState.id, 'second');
  context.notificationScreen = { dispose: () => screensDisposed++ };
  context.backgroundNotifications = { dispose: () => notificationsDisposed++ };
  context.app = { on: (_event, fn) => fn() }; context.queueDispatcher = { close: () => dispatcherClosed++ };
  vm.runInContext(section("app.on('will-quit',", '\n// A session rotation'), context);
  assert.equal(closed, 1); assert.equal(dispatcherClosed, 1); assert.equal(notificationsDisposed, 1); assert.equal(screensDisposed, 1);
});
