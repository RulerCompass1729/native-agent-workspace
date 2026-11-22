const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createStatePush } = require('../state-push.cjs');

// The 2026-11-10 panic: full-state snapshots were sent to a slow page faster than it handled them, and
// each unhandled one stayed in memory that no process owned. These tests keep the bound in place.

const mainSource = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, '../preload.cjs'), 'utf8');

function recorder() {
  const sent = [];
  const push = createStatePush((value, sequence) => {
    sent.push({ value, sequence });
  });
  return { sent, push };
}

test('one snapshot is in transit; while it is, only the newest later one is kept', () => {
  const { sent, push } = recorder();
  assert.equal(push.push('a'), true);
  assert.equal(push.push('b'), false);
  assert.equal(push.push('c'), false);
  assert.deepEqual(sent, [{ value: 'a', sequence: 1 }]);
  assert.deepEqual(push.status(), { sequence: 1, unacknowledged: 1, waiting: true, superseded: 1 });

  assert.equal(push.acknowledged(1), true);
  assert.deepEqual(sent, [{ value: 'a', sequence: 1 }, { value: 'c', sequence: 2 }]);
  assert.equal(push.status().waiting, false);

  assert.equal(push.acknowledged(2), true);
  assert.equal(push.status().unacknowledged, 0);
  assert.equal(push.push('d'), true);
  assert.equal(sent.at(-1).value, 'd');
});

test('a late, repeated or foreign acknowledgement never opens a second snapshot in transit', () => {
  const { sent, push } = recorder();
  push.push('a');
  assert.equal(push.acknowledged(7), false);
  assert.equal(push.acknowledged(0), false);
  assert.equal(push.acknowledged(undefined), false);
  push.push('b');
  assert.equal(sent.length, 1);

  assert.equal(push.acknowledged(1), true);
  assert.equal(sent.length, 2);
  // The first acknowledgement arrives again: 'b' is still in transit.
  assert.equal(push.acknowledged(1), false);
  push.push('c');
  assert.equal(sent.length, 2);
  assert.equal(push.status().unacknowledged, 2);
});

test('a slow page under a flood receives a bounded number of snapshots and always the last state', () => {
  const sent = [];
  let inTransit = 0;
  let mostInTransit = 0;
  const push = createStatePush((value, sequence) => {
    sent.push({ value, sequence });
    inTransit += 1;
    mostInTransit = Math.max(mostInTransit, inTransit);
  });
  let acknowledgements = 0;
  for (let index = 1; index <= 3000; index += 1) {
    push.push('state ' + index);
    // The page handles one snapshot for every forty the main process produces.
    if (index % 40 === 0) {
      inTransit -= 1;
      acknowledgements += 1;
      push.acknowledged(push.status().unacknowledged);
    }
  }
  assert.equal(mostInTransit, 1);
  assert.equal(sent.length, acknowledgements + 1);
  // Whatever was superseded, the newest state is in transit or waiting, never lost.
  inTransit -= 1;
  push.acknowledged(push.status().unacknowledged);
  assert.equal(sent.at(-1).value, 'state 3000');
});

test('a send that throws loses that snapshot only; the window is not left waiting for a reply', () => {
  const sent = [];
  let fail = true;
  const push = createStatePush((value, sequence) => {
    if (fail) {
      throw new Error('value could not be cloned');
    }
    sent.push({ value, sequence });
  });
  assert.throws(() => push.push('a'), /could not be cloned/);
  assert.equal(push.status().unacknowledged, 0);
  fail = false;
  assert.equal(push.push('b'), true);
  assert.deepEqual(sent, [{ value: 'b', sequence: 2 }]);

  // The same failure while handing over the waiting snapshot after an acknowledgement.
  push.push('c');
  fail = true;
  assert.throws(() => push.acknowledged(2), /could not be cloned/);
  assert.deepEqual(push.status(), { sequence: 3, unacknowledged: 0, waiting: false, superseded: 0 });
  fail = false;
  assert.equal(push.push('d'), true);
  assert.equal(sent.at(-1).value, 'd');
});

test('a newer complete state sent by another path discards the waiting snapshot, not the one in transit', () => {
  const { sent, push } = recorder();
  push.push('in transit');
  push.push('older than the refresh');
  push.discardWaiting();
  assert.deepEqual(push.status(), { sequence: 1, unacknowledged: 1, waiting: false, superseded: 1 });
  assert.equal(push.acknowledged(1), true);
  assert.equal(sent.length, 1, 'nothing older is delivered after the refresh');
  assert.equal(push.push('after the refresh'), true);
  assert.equal(sent.at(-1).value, 'after the refresh');
  // With nothing waiting it changes nothing.
  push.discardWaiting();
  assert.equal(push.status().superseded, 1);
});

test('everything sent to a window\'s page goes through sendToPage or pushState', () => {
  const helperStart = mainSource.indexOf('function sendToPage(context, channel, ...data)');
  const helperEnd = mainSource.indexOf('function bindClient(context)');
  assert.ok(helperStart > 0 && helperEnd > helperStart);
  const outside = mainSource.slice(0, helperStart) + mainSource.slice(helperEnd);
  // The only direct sends left are to windows that always have a page: the startup window, the focused
  // window of a menu command, and the locale broadcast, which leaves background windows out.
  const direct = outside.split('\n').filter(line => /webContents\.send\(/.test(line));
  for (const line of direct) {
    assert.match(line, /startupWindow\.webContents\.send\(|'workspace:locale'|'workspace:new'/, 'unexpected direct send: ' + line.trim().slice(0, 120));
  }
  assert.match(outside, /filter\(c => !c\.background\)\.map\(c => c\.win\)\]\);\n  for \(const win of targets\)/, 'the locale broadcast skips background windows');
  assert.doesNotMatch(outside, /[^.]send\('workspace:state'/, 'no send of full state bypasses pushState');
  assert.equal((outside.match(/pushState\(context, /g) || []).length, 3, 'the state event, the room broadcast and the quit notice');
  assert.match(outside, /if \(context\.background \|\| context\.win\.isDestroyed\(\) \|\| context\.client\.socket\.destroyed\) return;\n    const snapshot = await context\.client\.call\('initial'\);/, 'the room broadcast does not fetch state for a background window');
  assert.match(outside, /register\('uiReady', c => \{[^\n]*c\.armStatePush\?\.\(\)/);
  assert.equal((outside.match(/bindStatePush\(context\);/g) || []).length, 1, 'ordinary windows; a background window loads no document and never reports ready');
  // The reconnect refresh is the one other complete state sent to the page; nothing older may follow it.
  const reconnect = outside.slice(outside.indexOf("context.statePush?.discardWaiting();"), outside.indexOf("sendToPage(context, 'workspace:reconnected', omitHidden(refreshed, context.shown));"));
  assert.ok(reconnect.length > 0 && reconnect.length < 80, 'the waiting snapshot is discarded right before the reconnect refresh is sent');
});

// The actual helpers from main.cjs, run against a synthetic window.
function fakeClock() {
  let time = 1000;
  const timers = new Map();
  let next = 0;
  return {
    timers: {
      now: () => time,
      setTimer: (callback, ms) => { next += 1; timers.set(next, { at: time + ms, callback }); return next; },
      clearTimer: id => { timers.delete(id); },
    },
    tick(ms) {
      time += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= time && timers.has(id)) { timers.delete(id); timer.callback(); }
      }
    },
    pending: () => timers.size,
  };
}

function mainHelpers() {
  const helpers = mainSource.slice(mainSource.indexOf('function sendToPage(context, channel, ...data)'), mainSource.indexOf('function bindClient(context)'));
  const handler = mainSource.slice(mainSource.indexOf("ipcMain.handle('workspace:state-rendered'"), mainSource.indexOf("ipcMain.handle('workspace:retry-startup'"));
  const sent = [];
  const pageEvents = new Map();
  let destroyed = false;
  const mainFrame = { url: 'app://trusted/' };
  const webContents = {
    id: 7,
    mainFrame,
    send(channel, value, sequence) {
      sent.push({ channel, value, sequence });
    },
    on(name, listener) {
      pageEvents.set(name, listener);
    },
  };
  const context = { win: { isDestroyed: () => destroyed, webContents } };
  const handlers = new Map();
  // main.cjs's own wait, on a clock the test moves.
  const clock = fakeClock();
  // What main would make now: the test sets it as the backend and other channels change things.
  const current = { value: null };
  context.client = { snapshot: () => current.value };
  const sandbox = {
    displayState: snapshot => snapshot,
    omitHidden: require('../shown-sessions.cjs').omitHidden,
    createStatePush: (send, options) => createStatePush(send, { ...options, ...clock.timers }),
    windows: new Map([[7, context]]),
    trusted: url => url === 'app://trusted/',
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    context,
  };
  vm.createContext(sandbox);
  vm.runInContext(helpers + '\n' + handler + '\nbindStatePush(context);', sandbox);
  const pushState = vm.runInContext('pushState', sandbox);
  return {
    sent,
    context,
    pageEvents,
    tick: clock.tick,
    current,
    webContents,
    mainFrame,
    push(value) {
      current.value = value;
      pushState(context, value);
    },
    sendToPage(channel, ...data) {
      vm.runInContext('sendToPage', sandbox)(context, channel, ...data);
    },
    acknowledge(sequence, senderFrame = mainFrame, sender = webContents) {
      return handlers.get('workspace:state-rendered')({ sender, senderFrame }, sequence);
    },
    destroy() {
      destroyed = true;
    },
  };
}

test('a window whose page has not reported ready is sent state as before and is never held', () => {
  const h = mainHelpers();
  h.push('a');
  h.push('b');
  h.push('c');
  assert.deepEqual(h.sent.map(entry => [entry.value, entry.sequence]), [['a', 0], ['b', 0], ['c', 0]]);
  // A stray acknowledgement before the bound is armed is harmless.
  h.acknowledge(0);
  h.acknowledge(5);
  assert.equal(h.sent.length, 3);
});

test('a ready page gets one snapshot at a time; a reload or a renderer crash releases the bound', () => {
  const h = mainHelpers();
  h.context.armStatePush();
  h.push('a');
  h.push('b');
  h.push('c');
  assert.deepEqual(h.sent.map(entry => [entry.value, entry.sequence]), [['a', 1]]);
  h.acknowledge(1);
  // The newest waits until 250 ms after 'a' left.
  assert.deepEqual(h.sent.map(entry => [entry.value, entry.sequence]), [['a', 1]]);
  h.tick(250);
  assert.deepEqual(h.sent.map(entry => [entry.value, entry.sequence]), [['a', 1], ['c', 2]]);

  // The page reloads while 'c' is unacknowledged: nothing waits on the old document.
  h.pageEvents.get('did-start-loading')();
  h.push('d');
  assert.deepEqual(h.sent.at(-1), { channel: 'workspace:state', value: 'd', sequence: 0 });
  h.acknowledge(2);
  h.push('e');
  assert.equal(h.sent.at(-1).value, 'e');

  // The new document reports ready and the bound applies again from a fresh sequence.
  h.context.armStatePush();
  h.push('f');
  h.push('g');
  assert.deepEqual(h.sent.at(-1), { channel: 'workspace:state', value: 'f', sequence: 1 });
  // A second ready report from the same document keeps the bound: 'g' still waits and numbering goes on.
  h.context.armStatePush();
  h.push('g2');
  assert.deepEqual(h.sent.at(-1), { channel: 'workspace:state', value: 'f', sequence: 1 });
  h.acknowledge(1);
  h.tick(250);
  assert.deepEqual(h.sent.at(-1), { channel: 'workspace:state', value: 'g2', sequence: 2 });
  h.pageEvents.get('render-process-gone')();
  h.push('h');
  assert.deepEqual(h.sent.at(-1), { channel: 'workspace:state', value: 'h', sequence: 0 });
});

test('a page gets the messages of the sessions it shows only, decided when a snapshot leaves', () => {
  const h = mainHelpers(), made = n => ({ sessions: [{ id: 'a', messages: ['a' + n] }, { id: 'b', messages: ['b' + n] }] });
  const shape = () => h.sent.at(-1).value.sessions.map(s => s.messagesOmitted ? 'omitted' : s.messages[0]);
  h.context.shown = new Set(['a']);
  h.push(made(0)); assert.deepEqual(shape(), ['a0', 'omitted'], 'before the page is ready, too');
  h.context.armStatePush();
  h.push(made(1)); assert.deepEqual(shape(), ['a1', 'omitted']);
  h.push(made(2));
  // The page starts showing b while that snapshot waits: it leaves with b's messages.
  h.context.shown = new Set(['a', 'b']);
  h.acknowledge(1); h.tick(250);
  assert.deepEqual(shape(), ['a2', 'b2']);
  // A new document has none of the messages: everything until it reports.
  h.pageEvents.get('did-start-loading')();
  assert.equal(h.context.shown, null);
  h.context.shown = new Set(['b']); h.pageEvents.get('render-process-gone')(); assert.equal(h.context.shown, null);
  h.push(made(3)); assert.deepEqual(shape(), ['a3', 'b3']);
});

test('only the window\'s own trusted main frame can acknowledge, and a destroyed window is not sent to', () => {
  const h = mainHelpers();
  h.context.armStatePush();
  h.push('a');
  h.push('b');
  h.acknowledge(1, { url: 'app://trusted/' });
  h.acknowledge(1, h.mainFrame, { id: 99, mainFrame: h.mainFrame });
  const untrusted = { url: 'https://example.invalid/' };
  h.acknowledge(1, untrusted, { id: 7, mainFrame: untrusted });
  assert.equal(h.sent.length, 1, 'a subframe, another window and an untrusted page change nothing');
  h.destroy();
  h.acknowledge(1);
  h.push('c');
  assert.equal(h.sent.length, 1);
});

// 2026-11-10: one hidden window per agent that had used workspace control received every state change,
// terminal chunk and progress line. It loads no document, so nothing was ever received and the browser
// kept all of it. A minimal program showed about 2.3 GB held for 297 sends of 10 MB until it quit.
test('nothing is sent to a background window, armed or not', () => {
  const h = mainHelpers();
  h.context.background = true;
  h.push('a');
  h.context.armStatePush();
  h.push('b');
  h.sendToPage('workspace:terminal', { id: 's1', data: 'x' });
  h.sendToPage('workspace:backend-switched', {});
  assert.deepEqual(h.sent, []);

  h.context.background = false;
  h.sendToPage('workspace:terminal', { id: 's1', data: 'x' });
  assert.deepEqual(h.sent.map(entry => entry.channel), ['workspace:terminal']);
  h.destroy();
  h.sendToPage('workspace:terminal', { id: 's1', data: 'y' });
  assert.equal(h.sent.length, 1, 'a destroyed window is not sent to');
});

test('the actual client wiring forwards state, terminal and progress to a page and nothing to a background window', () => {
  const { EventEmitter } = require('node:events');
  const helpers = mainSource.slice(mainSource.indexOf('function sendToPage(context, channel, ...data)'), mainSource.indexOf('function bindClient(context)'));
  const binding = mainSource.slice(mainSource.indexOf('function bindClient(context)'), mainSource.indexOf('\nfunction displayState('));
  function wire(background) {
    const sent = [], reconnects = [];
    let displays = 0, personSamples = 0;
    const client = new EventEmitter();
    const context = {
      client,
      background,
      win: { isDestroyed: () => false, webContents: { send: (channel, ...data) => sent.push([channel, ...data]) } },
    };
    const sandbox = {
      createStatePush,
      context,
      omitHidden: require('../shown-sessions.cjs').omitHidden,
      displayState: value => {
        displays += 1;
        return value;
      },
      notifyToolWait() {},
      notifyCapacity() {},
      observePersonActions: snapshot => { assert.ok(Array.isArray(snapshot.sessions)); personSamples++; },
      // The state listener's record and placement steps have their own suites (stuck-records, open-placement).
      placeOpened: async () => {}, carryGrants: async () => {},
      uiError: () => ({ message: 'disconnected', uiMessage: null }),
      // A closed connection goes to the reconnection (service-reconnect.test.cjs), which tells the page when it fails.
      reconnectClosed: async (target, closed) => { reconnects.push(target === context && closed === client); },
    };
    vm.createContext(sandbox);
    vm.runInContext(helpers + '\n' + binding + '\nbindClient(context);', sandbox);
    client.emit('state', { sessions: [] });
    client.emit('terminal', { id: 's1', data: 'x' });
    client.emit('progress', { id: 's1' });
    client.emit('closed');
    return { sent, reconnects, displays: () => displays, personSamples: () => personSamples };
  }
  const page = wire(false);
  assert.deepEqual(page.sent.map(entry => entry[0]), ['workspace:state', 'workspace:terminal', 'workspace:progress']);
  assert.deepEqual(page.reconnects, [true]);
  assert.equal(page.displays(), 1);
  assert.equal(page.personSamples(), 1);

  const hidden = wire(true);
  assert.deepEqual(hidden.sent, []);
  assert.deepEqual(hidden.reconnects, [true]);
  assert.equal(hidden.displays(), 0, 'the display state of a background window is not even computed');
  assert.equal(hidden.personSamples(), 0);
});

test('the page acknowledges every numbered snapshot exactly once, also when a subscriber throws or none exists yet', () => {
  const start = preloadSource.indexOf('const stateCallbacks = new Set();');
  const end = preloadSource.indexOf('for (const [name, channel] of [[');
  assert.ok(start > 0 && end > start, 'the eager state listener precedes the generic subscriptions');
  assert.doesNotMatch(preloadSource.slice(end), /'workspace:state'\]/, 'state is not also subscribed through the generic list');

  const listeners = new Map();
  const acknowledgements = [];
  const api = {};
  const ipcRenderer = {
    on(channel, listener) {
      listeners.set(channel, listener);
    },
    invoke(channel, sequence) {
      acknowledgements.push([channel, sequence]);
      return Promise.reject(new Error('main process gone'));
    },
  };
  vm.runInNewContext(preloadSource.slice(start, end), { ipcRenderer, api, Set });
  const deliver = listeners.get('workspace:state');
  assert.equal(typeof deliver, 'function');

  // Before the page subscribed; a failed acknowledgement call is not an unhandled rejection.
  deliver({}, 'early', 1);
  assert.deepEqual(acknowledgements, [['workspace:state-rendered', 1]]);

  // Sequence 0 is a snapshot sent before the page was ready: delivered, not acknowledged.
  const seen = [];
  const unsubscribe = api.onState(value => {
    seen.push(value);
  });
  deliver({}, 'unnumbered', 0);
  assert.deepEqual(seen, ['unnumbered']);
  assert.equal(acknowledgements.length, 1);

  api.onState(() => {
    throw new Error('render failed');
  });
  assert.throws(() => deliver({}, 'second', 2), /render failed/);
  assert.deepEqual(seen, ['unnumbered', 'second']);
  assert.deepEqual(acknowledgements.at(-1), ['workspace:state-rendered', 2]);
  assert.equal(acknowledgements.length, 2);

  unsubscribe();
  assert.throws(() => deliver({}, 'third', 3), /render failed/);
  assert.deepEqual(seen, ['unnumbered', 'second']);
  assert.equal(acknowledgements.length, 3);
});

// UI lag, 2026-11-12: changes in quick succession are one redraw; a single change is not delayed.
function clocked(wait = 250) {
  const sent = [], clock = fakeClock();
  const push = createStatePush((value, sequence) => { sent.push([value, sequence]); }, { wait, ...clock.timers });
  return { sent, push, clock };
}

test('a single change goes at once; changes within the wait are one snapshot, the newest, when it is up', () => {
  const { sent, push, clock } = clocked();
  assert.equal(push.push('a'), true);
  push.acknowledged(1);
  clock.tick(100);
  assert.equal(push.push('b'), false, 'Within 250 ms of the last one');
  push.push('c');
  push.push('d');
  assert.deepEqual(sent, [['a', 1]]);
  clock.tick(149);
  assert.deepEqual(sent, [['a', 1]]);
  clock.tick(1);
  assert.deepEqual(sent, [['a', 1], ['d', 2]]);
  assert.equal(push.status().superseded, 2);
  push.acknowledged(2);
  clock.tick(1000);
  assert.equal(push.push('e'), true, 'A change long after the last one is not delayed');
  assert.deepEqual(sent.at(-1), ['e', 3]);
  assert.equal(clock.pending(), 0);
});

test('a flood is at most one snapshot per wait, the last state always arrives, one in transit at a time', () => {
  const clock = fakeClock(), sent = [];
  const push = createStatePush((value, sequence) => { sent.push({ value, sequence, at: clock.timers.now() }); }, { wait: 250, ...clock.timers });
  let produced = 0;
  // A change every 50 ms for two seconds; the page acknowledges each snapshot 30 ms after it arrives.
  const page = () => {
    const last = sent.at(-1);
    if (last && !last.acked && clock.timers.now() - last.at >= 30) { last.acked = true; push.acknowledged(last.sequence); }
  };
  for (let t = 0; t < 2000; t += 10) {
    if (t % 50 === 0) push.push('v' + ++produced);
    page(); clock.tick(10);
  }
  for (let t = 0; t < 1000; t += 10) { page(); clock.tick(10); }
  assert.ok(sent.length <= 2000 / 250 + 1, `${sent.length} snapshots for ${produced} changes`);
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i].at - sent[i - 1].at >= 250, 'Spaced by the wait');
  assert.equal(sent.at(-1).value, 'v' + produced);
  assert.equal(push.status().waiting, false);
});

test('an acknowledgement after the wait is up sends the newest at once; one before it waits for the rest', () => {
  const { sent, push, clock } = clocked();
  push.push('a');
  push.push('b');
  clock.tick(300);
  push.acknowledged(1);
  assert.deepEqual(sent, [['a', 1], ['b', 2]], 'Slow page: no extra wait on top');
  push.push('c');
  clock.tick(50);
  push.acknowledged(2);
  assert.deepEqual(sent.at(-1), ['b', 2]);
  clock.tick(199);
  assert.deepEqual(sent.at(-1), ['b', 2]);
  clock.tick(1);
  assert.deepEqual(sent.at(-1), ['c', 3]);
});

test('a snapshot waiting for its time is never sent after the bound is closed or a newer state was sent', () => {
  const { sent, push, clock } = clocked();
  push.push('a');
  push.acknowledged(1);
  push.push('b');
  push.close();
  clock.tick(1000);
  assert.deepEqual(sent, [['a', 1]]);
  const second = clocked();
  second.push.push('a');
  second.push.acknowledged(1);
  second.push.push('b');
  second.push.discardWaiting();
  second.clock.tick(1000);
  assert.deepEqual(second.sent, [['a', 1]]);
  assert.equal(second.clock.pending(), 0);
});

test('a send that throws when the time is up loses that snapshot and does not reach the event loop', () => {
  const clock = fakeClock();
  let fail = false;
  const sent = [];
  const push = createStatePush((value, sequence) => { if (fail) throw Error('gone'); sent.push([value, sequence]); }, { wait: 250, ...clock.timers });
  push.push('a');
  push.acknowledged(1);
  push.push('b');
  fail = true;
  assert.doesNotThrow(() => clock.tick(250));
  assert.equal(push.status().unacknowledged, 0);
  fail = false;
  clock.tick(250);
  assert.equal(push.push('c'), true);
  assert.deepEqual(sent.at(-1), ['c', 3]);
});

test('main spaces a ready page\'s snapshots by 250 ms, and a reload drops the one waiting for its time', () => {
  const h = mainHelpers();
  h.context.armStatePush();
  h.push('a');
  h.acknowledge(1);
  h.tick(100);
  h.push('b');
  assert.deepEqual(h.sent.map(entry => entry.value), ['a']);
  h.pageEvents.get('did-start-loading')();
  h.tick(1000);
  assert.deepEqual(h.sent.map(entry => entry.value), ['a'], 'Nothing for the old document reaches the new one');
  h.context.armStatePush();
  h.push('c');
  assert.deepEqual(h.sent.at(-1), { channel: 'workspace:state', value: 'c', sequence: 1 });
  assert.match(mainSource, /const STATE_PUSH_WAIT = 250;/);
});

test('the page\'s own action sends what waits at once, or as soon as the snapshot in transit is acknowledged', () => {
  const { sent, push, clock } = clocked();
  push.push('a');
  push.acknowledged(1);
  clock.tick(10);
  push.push('b');
  assert.deepEqual(sent, [['a', 1]]);
  assert.equal(push.flushNow(), true, 'Before the action\'s reply, not 240 ms later');
  assert.deepEqual(sent, [['a', 1], ['b', 2]]);
  assert.equal(clock.pending(), 0);
  push.push('c');
  assert.equal(push.flushNow(), false, 'One in transit still holds');
  clock.tick(10);
  push.acknowledged(2);
  assert.deepEqual(sent.at(-1), ['c', 3], 'Acknowledged: sent without waiting out the rest');
  assert.equal(push.flushNow(), false, 'Nothing waiting');
  push.acknowledged(3);
  push.push('d');
  assert.deepEqual(sent.at(-1), ['c', 3], 'The hurry was for that action only');
  clock.tick(250);
  assert.deepEqual(sent.at(-1), ['d', 4]);
});

test('main hurries the waiting state before every page action\'s reply, except while typing, scrolling or resizing', () => {
  const start = mainSource.indexOf("ipcMain.handle(`workspace:${name}`");
  const wrapper = mainSource.slice(start, mainSource.indexOf('\n}', start));
  assert.match(wrapper, /finally \{ if \(hurries\) try \{ context\.statePush\?\.flushNow\(\); \} catch/);
  // The page's report of what it shows and its search are read-only and arrive while the person types.
  assert.match(mainSource, /const hurries = !\['input', 'resize', 'readingState', 'draft', 'viewState', 'shownSessions', 'search', 'textPath'\]\.includes\(name\);\n  ipcMain\.handle\(`workspace:\$\{name\}`/);
});

test('a clock set back never holds a snapshot longer than the wait', () => {
  const { sent, push, clock } = clocked();
  push.push('a');
  push.acknowledged(1);
  clock.tick(-10000);
  push.push('b');
  clock.tick(250);
  assert.deepEqual(sent.at(-1), ['b', 2]);
});

test('a snapshot that waited is made again when it is sent; if that fails, the one held is sent', () => {
  const { sent, push, clock } = clocked();
  push.push('a', () => 'unused');
  push.acknowledged(1);
  let now = 'b as it is now';
  push.push('b as it was', () => now);
  now = 'b with the new name';
  clock.tick(250);
  assert.deepEqual(sent.at(-1), ['b with the new name', 2]);
  push.acknowledged(2);
  push.push('c as it was', () => { throw Error('client closing'); });
  clock.tick(250);
  assert.deepEqual(sent.at(-1), ['c as it was', 3]);
  push.acknowledged(3);
  clock.tick(250);
  push.push('d', () => 'd now');
  assert.deepEqual(sent.at(-1), ['d', 4], 'Sent at once: made just now, not again');
});

test('main: a session renamed while a snapshot waits is not renamed back when that snapshot is sent', () => {
  const h = mainHelpers();
  h.context.armStatePush();
  h.push({ name: 'Old' });
  h.acknowledge(1);
  h.push({ name: 'Old', history: 2 });
  // The rename goes to the page at once on its own channel; main's snapshot now has the new name.
  h.current.value = { name: 'Renamed', history: 2 };
  h.tick(250);
  assert.deepEqual(h.sent.at(-1).value, { name: 'Renamed', history: 2 });
});

// Typing (UI lag, 2026-11-12): every key made a new full state, and each snapshot that reached the page
// made the next key wait for it. While the person types, a snapshot waits for a pause, within a bound.
function typingClock() {
  const sent = [], clock = fakeClock();
  const push = createStatePush((value, sequence) => { sent.push({ value, sequence, at: clock.timers.now() }); }, { wait: 250, quiet: 400, maxHold: 1500, ...clock.timers });
  return { sent, push, clock };
}

test('while the person types, snapshots go at most once per 1.5 s, and the newest arrives after the typing stops', () => {
  const { sent, push, clock } = typingClock();
  push.push('start');
  push.acknowledged(1);
  let produced = 0;
  // Nine keys a second for three seconds; each key and a streaming reply both make a new state.
  for (let t = 0; t < 3000; t += 110) {
    push.typed();
    push.push('v' + ++produced);
    clock.tick(55);
    push.push('v' + ++produced);
    clock.tick(55);
    const last = sent.at(-1);
    if (push.status().unacknowledged === last.sequence) push.acknowledged(last.sequence);
  }
  const during = sent.slice(1);
  assert.ok(during.length >= 1 && during.length <= 3, `${during.length} snapshots while typing`);
  // Each goes when its hold is up (the clock moves in 55 ms steps here), not later.
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i].at - sent[i - 1].at >= 1500 && sent[i].at - sent[i - 1].at <= 1500 + 110, `One per hold while typing: ${sent.map(s => s.at)}`);
  clock.tick(1500);
  const last = sent.at(-1);
  if (push.status().unacknowledged === last.sequence) push.acknowledged(last.sequence);
  clock.tick(1500);
  assert.equal(sent.at(-1).value, 'v' + produced, 'The last state arrives');
  assert.equal(push.status().waiting, false);
  assert.equal(clock.pending(), 0);
});

test('a pause in typing lets the waiting snapshot go 400 ms after the last key', () => {
  const { sent, push, clock } = typingClock();
  push.push('a');
  push.acknowledged(1);
  clock.tick(1000);
  push.typed();
  push.push('b');
  assert.deepEqual(sent.map(s => s.value), ['a'], 'A key just now: the snapshot waits');
  clock.tick(399);
  assert.deepEqual(sent.map(s => s.value), ['a']);
  clock.tick(1);
  assert.deepEqual(sent.map(s => s.value), ['a', 'b']);
});

test('a key typed while a snapshot waits for its 250 ms extends the wait to the pause', () => {
  const { sent, push, clock } = typingClock();
  push.push('a');
  push.acknowledged(1);
  clock.tick(100);
  push.push('b');
  clock.tick(100);
  push.typed();
  clock.tick(50);
  assert.deepEqual(sent.map(s => s.value), ['a'], 'The 250 ms are up, but a key came 50 ms ago');
  clock.tick(349);
  assert.deepEqual(sent.map(s => s.value), ['a']);
  clock.tick(1);
  assert.deepEqual(sent.map(s => s.value), ['a', 'b']);
});

test('typing never holds the page\'s own action: what waits goes before its reply', () => {
  const { sent, push, clock } = typingClock();
  push.push('a');
  push.acknowledged(1);
  push.typed();
  push.push('b');
  assert.equal(push.flushNow(), true);
  assert.deepEqual(sent.map(s => s.value), ['a', 'b']);
  push.typed();
  push.push('c');
  assert.equal(push.flushNow(), false, 'One in transit');
  push.acknowledged(2);
  assert.deepEqual(sent.map(s => s.value), ['a', 'b', 'c'], 'Acknowledged: the hurried one goes without the typing wait');
  assert.equal(clock.pending(), 0);
});

test('without keys the bound behaves as before: a single change goes at once', () => {
  const { sent, push, clock } = typingClock();
  assert.equal(push.push('a'), true);
  push.acknowledged(1);
  clock.tick(250);
  assert.equal(push.push('b'), true);
  assert.deepEqual(sent.map(s => s.value), ['a', 'b']);
});

test('a clock set back while typing holds a snapshot no longer than the hold', () => {
  const { sent, push, clock } = typingClock();
  push.push('a');
  push.acknowledged(1);
  push.typed();
  clock.tick(-10000);
  push.typed();
  push.push('b');
  clock.tick(1500);
  assert.deepEqual(sent.map(s => s.value), ['a', 'b']);
  assert.equal(clock.pending(), 0);
});

test('a clock set back with no keys holds a snapshot no longer than the 250 ms wait', () => {
  const { sent, push, clock } = typingClock();
  push.push('a');
  push.acknowledged(1);
  clock.tick(-10000);
  push.push('b');
  clock.tick(249);
  assert.deepEqual(sent.map(s => s.value), ['a']);
  clock.tick(1);
  assert.deepEqual(sent.map(s => s.value), ['a', 'b'], 'Without keys, the typing hold plays no part');
  assert.equal(clock.pending(), 0);
});

test('main reports keys to the bound: the draft, the person\'s terminal input, a space composer\'s text', () => {
  const start = mainSource.indexOf('function terminalReplyOnly(method, args)');
  const source = mainSource.slice(start, mainSource.indexOf('async function startQueueDispatcher()', start));
  const sandbox = { queueRules: require('../queue-dispatch.cjs') };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const typingKey = vm.runInContext('typingKey', sandbox);
  const view = { sharedDraft: 'shared text', roomViews: { shared: { sharedDraft: 'shared text' }, s2: { sharedDraft: 'hello' } } };
  assert.equal(typingKey('draft', view, ['id', 'abc']), true);
  assert.equal(typingKey('input', view, ['id', 'a']), true);
  assert.equal(typingKey('input', view, ['id', '\x1b[I']), false, 'A terminal\'s focus report is not a key');
  assert.equal(typingKey('input', view, ['id', '\x1b[12;40R']), false, 'Nor its cursor report');
  assert.equal(typingKey('viewState', view, [{ selected: 'x', mode: 'chat', sharedDraft: 'shared text', roomViews: { shared: { sharedDraft: 'shared text' }, s2: { sharedDraft: 'hello!' } } }]), true, 'Typed in a space');
  assert.equal(typingKey('viewState', view, [{ selected: 'x', mode: 'chat', sharedDraft: 'hello', roomViews: { shared: { sharedDraft: 'shared text' }, s2: { sharedDraft: 'hello' } } }]), false,
    'A scroll or selection in another space carries its unchanged text');
  assert.equal(typingKey('viewState', {}, [{ selected: 'x', mode: 'chat', roomViews: { s3: { sharedDraft: 'new' } } }]), true, 'A first key in a space never seen');
  assert.equal(typingKey('viewState', view, [{ selected: 'x', mode: 'chat', sharedDraft: 'shared text!' }]), true, 'A page without roomViews');
  assert.equal(typingKey('viewState', view, [null]), false);
  assert.equal(typingKey('readingState', view, [{}]), false);
  assert.equal(typingKey('send', view, ['id', 'text']), false);
});

test('main tells a window\'s bound about each key before the handler runs, and arms it with the typing wait', () => {
  const start = mainSource.indexOf("ipcMain.handle(`workspace:${name}`");
  const wrapper = mainSource.slice(start, mainSource.indexOf('\n}', start));
  assert.match(wrapper, /\n    if \(context\.statePush && typingKey\(name, context\.view, args\)\) context\.statePush\.typed\(\);\n    try \{\n      const value = await handler\(context, \.\.\.args\);/);
  assert.match(mainSource, /const STATE_PUSH_TYPING_QUIET = 400;\nconst STATE_PUSH_TYPING_HOLD = 1500;/);
  const h = mainHelpers();
  h.context.armStatePush();
  h.push('a');
  h.acknowledge(1);
  h.tick(1000);
  h.context.statePush.typed();
  h.push('b');
  h.tick(399);
  assert.deepEqual(h.sent.map(entry => entry.value), ['a']);
  h.tick(1);
  assert.deepEqual(h.sent.map(entry => entry.value), ['a', 'b']);
});
