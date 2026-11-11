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
  const reconnect = outside.slice(outside.indexOf("context.statePush?.discardWaiting();"), outside.indexOf("sendToPage(context, 'workspace:reconnected', refreshed);"));
  assert.ok(reconnect.length > 0 && reconnect.length < 80, 'the waiting snapshot is discarded right before the reconnect refresh is sent');
});

// The actual helpers from main.cjs, run against a synthetic window.
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
  const sandbox = {
    createStatePush,
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
    webContents,
    mainFrame,
    push(value) {
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
  assert.deepEqual(h.sent.at(-1), { channel: 'workspace:state', value: 'g2', sequence: 2 });
  h.pageEvents.get('render-process-gone')();
  h.push('h');
  assert.deepEqual(h.sent.at(-1), { channel: 'workspace:state', value: 'h', sequence: 0 });
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
    const sent = [];
    let displays = 0;
    const client = new EventEmitter();
    const context = {
      client,
      background,
      win: { isDestroyed: () => false, webContents: { send: (channel, ...data) => sent.push([channel, ...data]) } },
    };
    const sandbox = {
      createStatePush,
      context,
      displayState: value => {
        displays += 1;
        return value;
      },
      notifyToolWait() {},
      notifyCapacity() {},
      uiError: () => ({ message: 'disconnected', uiMessage: null }),
    };
    vm.createContext(sandbox);
    vm.runInContext(helpers + '\n' + binding + '\nbindClient(context);', sandbox);
    client.emit('state', { sessions: [] });
    client.emit('terminal', { id: 's1', data: 'x' });
    client.emit('progress', { id: 's1' });
    client.emit('closed');
    return { sent, displays: () => displays };
  }
  const page = wire(false);
  assert.deepEqual(page.sent.map(entry => entry[0]), ['workspace:state', 'workspace:terminal', 'workspace:progress', 'workspace:disconnected']);
  assert.equal(page.displays(), 1);

  const hidden = wire(true);
  assert.deepEqual(hidden.sent, []);
  assert.equal(hidden.displays(), 0, 'the display state of a background window is not even computed');
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
