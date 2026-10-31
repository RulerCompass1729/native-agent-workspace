const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a); return source.slice(a, b);
}
function windowRecord() {
  return { destroyed: false, minimized: false, shows: 0, focuses: 0, restores: 0,
    isDestroyed() { return this.destroyed; }, isMinimized() { return this.minimized; },
    show() { this.shows++; }, focus() { this.focuses++; }, restore() { this.restores++; this.minimized = false; } };
}
function harness(kind) {
  const origin = windowRecord(), other = windowRecord(), notifications = [], opens = [], starts = [];
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; notifications.push(this); }
    show() {}
  }
  const view = { owner: 'synthetic-owner', selected: 'synthetic-session', draft: { id: 'synthetic-session', text: 'UNSENT synthetic draft' } };
  const nativeId = 'synthetic-native', turnId = 'synthetic-turn';
  const row = { id: 'synthetic-session', nativeId, activeTurnId: turnId, state: kind === 'capacity' ? 'idle' : 'working',
    capacityRecovery: { nativeId, turnId, status: 'exhausted', attempt: 3, reason: 'capacity' },
    nativeActivity: { nativeId, turnId, phase: 'tool', stale: false, toolWait: { marker: 'synthetic-tool', progressAt: 0 },
      waitNotice: { kind: 'tool-wait', nativeId, turnId, marker: 'synthetic-tool', progressAt: 0, createdAt: 300000 } } };
  const snapshot = { sessions: [row] }, original = JSON.stringify(snapshot);
  const state = { Notification, toolWaitNotifications: new Map(), capacityNotifications: new Map(), windows: new Map([[1, { win: origin }]]),
    displayText: key => key, backgroundLaunch: false, backgroundTest: false, startupWindow: null, starting: false, quitting: false,
    dsh: {}, wired: true, views: [view], process: { platform: 'darwin' }, app: Object.assign(new EventEmitter(), { setActivationPolicy() {} }),
    openWindow: async saved => { opens.push(saved); return windowRecord(); }, start: () => starts.push(true) };
  vm.createContext(state);
  vm.runInContext(section('function notifyToolWait(', '\nfunction bindClient(') + '\n' + section('function focusOrOpen(', "\nif (primary)"), state);
  state[kind === 'capacity' ? 'notifyCapacity' : 'notifyToolWait'](snapshot, origin);
  assert.equal(notifications.length, 1, 'An eligible actual production notifier creates one notification');
  return { origin, other, opens, starts, state, view, snapshot, notifications,
    closeOrigin() { origin.destroyed = true; state.windows.delete(1); },
    addOther() { state.windows.set(2, { win: other }); },
    click() { notifications[0].emit('click'); assert.equal(JSON.stringify(snapshot), original, 'A click never mutates the old turn'); } };
}
for (const kind of ['capacity', 'tool-wait']) {
  test(kind + ': a destroyed origin falls back to a live window using the normal activation path', () => {
    const h = harness(kind); h.addOther(); h.other.minimized = true; h.closeOrigin(); h.click();
    assert.equal(h.other.shows, 1); assert.equal(h.other.focuses, 1); assert.equal(h.other.restores, 1);
    assert.equal(h.origin.shows, 0); assert.equal(h.opens.length, 0); assert.equal(h.starts.length, 0);
  });
  test(kind + ': after every window closes a click reopens the existing saved view', async () => {
    const h = harness(kind), saved = JSON.stringify(h.view); h.closeOrigin(); h.click(); await Promise.resolve();
    assert.deepEqual(h.opens, [h.view]); assert.equal(JSON.stringify(h.view), saved);
    assert.equal(h.starts.length, 0); assert.equal(h.origin.shows, 0);
  });
  test(kind + ': stale click cannot reveal another window while quitting', () => {
    const h = harness(kind); h.addOther(); h.closeOrigin(); h.state.quitting = true; h.click();
    assert.equal(h.other.shows, 0); assert.equal(h.other.focuses, 0); assert.equal(h.opens.length, 0); assert.equal(h.starts.length, 0);
  });
  test(kind + ': the original live-window click path is preserved', () => {
    const h = harness(kind); h.addOther(); h.click();
    assert.equal(h.origin.shows, 1); assert.equal(h.other.shows, 0); assert.equal(h.opens.length, 0); assert.equal(h.starts.length, 0);
  });
  test(kind + ': a stale click does not duplicate an in-progress startup', () => {
    const h = harness(kind); h.closeOrigin(); h.state.starting = true; h.click();
    assert.equal(h.opens.length, 0); assert.equal(h.starts.length, 0);
  });
  test(kind + ': fallback preserves the existing isolated-test visibility policy', () => {
    const h = harness(kind); h.addOther(); h.closeOrigin(); h.state.backgroundTest = true; h.click();
    assert.equal(h.other.shows, 0); assert.equal(h.other.focuses, 0); assert.equal(h.other.restores, 0); assert.equal(h.opens.length, 0);
  });
}

const settlePromises = () => new Promise(resolve => setImmediate(resolve));
for (const kind of ['capacity', 'tool-wait']) {
  test(kind + ': overlapping stale notices and ordinary activation share one pending saved-view open', async () => {
    const h = harness(kind), row = h.snapshot.sessions[0];
    if (kind === 'capacity') row.capacityRecovery.turnId = 'synthetic-next-turn';
    else { row.activeTurnId = row.nativeActivity.turnId = row.nativeActivity.waitNotice.turnId = 'synthetic-next-turn'; row.nativeActivity.waitNotice.createdAt++; }
    h.state[kind === 'capacity' ? 'notifyCapacity' : 'notifyToolWait'](h.snapshot, h.origin);
    assert.equal(h.notifications.length, 2, 'Two distinct real notification callbacks are retained');
    h.closeOrigin(); let release;
    const pending = new Promise(resolve => { release = resolve; });
    h.state.openWindow = saved => { h.opens.push(saved); return pending; };
    try {
      h.notifications[0].emit('click'); h.notifications[1].emit('click');
      h.state.app.emit('activate'); h.state.app.emit('second-instance', null, ['electron']);
      assert.equal(h.opens.length, 1, 'Only one client/view open may own the shared saved descriptor while connect awaits');
      assert.equal(h.state.starting, true); assert.equal(h.starts.length, 0);
      assert.strictEqual(h.opens[0], h.view);
    } finally { release(); await settlePromises(); }
    assert.equal(h.state.starting, false, 'Successful or early-return open releases its existing guard');
  });
}
test('failed saved-view restoration releases its own guard before normal startup takes over', async () => {
  const h = harness('capacity'); h.closeOrigin(); let rejectOpen, finishBoot;
  const opening = new Promise((_, reject) => { rejectOpen = reject; });
  const boot = new Promise(resolve => { finishBoot = resolve; });
  h.state.openWindow = saved => { h.opens.push(saved); return opening; };
  h.state.start = () => {
    assert.equal(h.state.starting, false, 'Normal start must receive an unlocked entry');
    h.starts.push(true); h.state.starting = true;
    return boot.finally(() => { h.state.starting = false; });
  };
  try {
    h.notifications[0].emit('click'); rejectOpen(Error('Synthetic UI connection failure'));
    await settlePromises(); assert.equal(h.starts.length, 1);
    assert.equal(h.state.starting, true, 'The old opening completion cannot release the new startup owner');
  } finally { finishBoot(); await settlePromises(); }
  assert.equal(h.state.starting, false);
});
