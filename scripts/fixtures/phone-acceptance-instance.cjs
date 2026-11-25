const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
function mainMobile(root, profile, roomState, labels, background, steward) {
  const require = createRequire(path.join(root, 'scripts/test-phone-workspace.cjs'));
  const recordReminders = require('../app/record-reminders.cjs');
  const mainSource = fs.readFileSync(path.join(root, 'app/main.cjs'), 'utf8');
  const human = new Map(), scheduled = [];
  const context = vm.createContext({ require: createRequire(path.join(root, 'app/main.cjs')), primary: true, quitting: false,
    dataDir: profile, roomState, sessionLabels: labels, recordReminders, operationsUnavailable: null, stewardRecord: null,
    confirmationInbox: require('../app/confirmation-inbox.cjs'), tempReminders: null,
    tempSummary: require('../app/temp-reminders.cjs').tempSummary, readTempSummary: require('../app/temp-reminders.cjs').readSummary,
    personActions: null, stewardWake: null, usageAlerts: null,
    backgroundControl: background, backgroundUnavailable: false, outboxQuitFailed: false, outboxUnavailable: false,
    activeManagers: () => ({}), integratorRole: null, stewardRole: { current: () => steward }, butlerIngress: null,
    queueDispatcher: { integration: null, integrationError: null, rotationChains: () => [], schedule: () => scheduled.push(true), noteHuman: id => human.set(id, Date.now()) },
    submissionState: require('../app/submission-policy.cjs').submissionState,
    roomPeerIdentity: require('../app/peer-handoffs.cjs').identity,
    localVendorIcons: () => ({}), endedByMove: () => [], viewStorageWarning: null, viewStorageWarningUiMessage: null,
    displayText: (key, params) => require('../app/ui-locale.js').format('en', key, params),
    broadcastRoom: async () => {}, Date, setTimeout, clearTimeout, AbortController,
  });
  const a = mainSource.indexOf('function displayState('), b = mainSource.indexOf('function reportViewStorage(', a);
  const c = mainSource.indexOf('let mobileBroker;'), d = mainSource.indexOf('const startupFile =', c);
  assert.ok(a > 0 && b > a && c > 0 && d > c);
  const r = mainSource.indexOf('function recordPersonAction('), s = mainSource.indexOf('function observePersonActions(', r);
  assert.ok(r > 0 && s > r);
  vm.runInContext(mainSource.slice(r, s), context);
  vm.runInContext(mainSource.slice(a, b), context); vm.runInContext(mainSource.slice(c, d), context);
  return { context, human, scheduled, broker: () => context.appMobileBroker(), stop: async () => { context.revokeAppMobile(); await vm.runInContext('mobileStopped', context); } };
}
module.exports = { mainMobile };
