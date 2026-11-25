const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
const section = (from, to) => {
  const start = main.indexOf(from), end = main.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, from);
  return main.slice(start, end);
};
const settle = () => new Promise(resolve => setImmediate(resolve));

// The app's own start(), openWindow() and the two requests its page makes, on a clock the test moves.
function app() {
  const timers = new Map(), handlers = new Map(), pages = [], starts = [], menu = [];
  let now = 0, lastTimer = 0;
  const setTimeout = (run, ms) => { timers.set(++lastTimer, { run, at: now + ms }); return lastTimer; };
  const page = () => {
    const win = new EventEmitter(), load = {};
    load.done = new Promise((resolve, reject) => Object.assign(load, { resolve, reject }));
    win.webContents = Object.assign(new EventEmitter(), { id: pages.length + 1, setWindowOpenHandler() {}, send: (channel, status) => { if (channel === 'workspace:startup') win.startup = status; } });
    Object.assign(win, { gone: false, load, isDestroyed: () => win.gone, loadFile: async () => {}, loadURL: () => load.done, getBounds: () => ({}), setTitle() {},
      destroy: () => { if (!win.gone) { win.gone = true; win.emit('closed'); } } });
    pages.push(win);
    return win;
  };
  const stopped = [];
  const sandbox = { setTimeout, clearTimeout: id => timers.delete(id), windows: new Map(), views: [], dataDir: '', entry: 'app', startupWindow: null, startupFile: '', quitting: false, starting: false, wired: true,
    pendingReveal: null, localeHostGeneration: 0, backgroundControl: null, dsh: null, backendSwitchTimer: {}, applicationBuild: {}, roomState: { apply: value => value },
    backend: () => Promise.resolve({ sessions: [] }), createWindow: page, startupMessage: () => 'generic', displayLanguage: () => 'en', displayText: key => key, uiLocale: { startupCode: code => code }, randomUUID: () => 'owner',
    backups() {}, saveViews() {}, bindClient() {}, bindStatePush() {}, discardReveal() {}, closeAppMobileSetup() {}, trusted: () => true, localPages: null, flushReveal() {},
    updateApplicationMenu: () => menu.push(sandbox.starting), readStartupLocale: async () => {}, resumeAppMobileOnBoot: async () => {}, register: (name, handler) => handlers.set(name, handler),
    backgroundOperation: { request: () => null }, displayState: value => value, notifyCapacity() {}, app: { getVersion: () => '' }, localeWarning: null, preflight() {}, omitHidden: value => value,
    connect: async () => ({ call: () => sandbox.backend(), close() {} }), startDsh: async () => ({ stop: () => stopped.push(true) }) };
  vm.createContext(sandbox);
  vm.runInContext(section('async function openWindow(', '\nfunction hasSavedSpaceDraft(') + section('async function start()', '// The page handled') +
    section("  register('uiReady',", '  // Asked once by a window') + section("  register('initial',", '  // The sessions whose messages') +
    'async function boot() { dsh = await startDsh(); await openWindow(views.at(-1)); }', sandbox);
  return {
    sandbox, pages, stopped, menu,
    start: () => { const starting = sandbox.start().then(() => { starts[starts.indexOf(starting)] = null; }); starts.push(starting); return settle(); },
    starting: () => starts.filter(Boolean).length,
    // The page's own steps (renderer.js, as it starts): one whole state, then ready.
    ask: () => { const context = [...sandbox.windows.values()].at(-1); return handlers.get('initial')(context).then(() => handlers.get('uiReady')(context)).then(settle, async error => { await settle(); return error; }); },
    pass: async ms => {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.run(); }
      await settle();
    },
    timers: () => timers.size,
    failedPage: () => pages.filter(win => !win.gone && win.startup?.kind === 'failed').map(win => [win.startup.retry, win.startup.title, win.startup.detail]),
    openPages: () => pages.filter(win => !win.gone).length,
  };
}
const FAILED = [[true, 'startup.failed', 'generic']];
const later = () => { const wait = {}; wait.promise = new Promise((resolve, reject) => Object.assign(wait, { resolve, reject })); return wait; };

for (const seconds of [26, 35, 39]) test(`a page whose backend answers after ${seconds} s opens in the window it was loading in`, async () => {
  const h = app(), answer = later();
  h.sandbox.backend = () => answer.promise;
  await h.start(); h.pages[0].load.resolve(); await settle();
  const asked = h.ask();
  await h.pass(seconds * 1000);
  assert.deepEqual([h.openPages(), h.failedPage(), h.stopped.length, h.starting()], [1, [], 0, 1], 'still the same window, still opening');
  answer.resolve({ sessions: [] });
  assert.equal(await asked, undefined);
  assert.deepEqual([h.pages.length, h.openPages(), h.failedPage(), h.stopped.length, h.starting(), h.timers()], [1, 1, [], 0, 0, 0], 'open, and nothing left that would end it');
  assert.equal([...h.sandbox.windows.values()][0].uiReady, true);
  await h.pass(600000);
  assert.equal(h.openPages(), 1);
});
test('a slow load of the page itself opens as well', async () => {
  const h = app();
  await h.start(); await h.pass(35000);
  assert.deepEqual([h.openPages(), h.failedPage()], [1, []]);
  h.pages[0].load.resolve(); await settle();
  assert.equal(await h.ask(), undefined);
  assert.deepEqual([h.openPages(), h.failedPage(), h.starting(), h.timers()], [1, [], 0, 0]);
});
for (const [name, loaded] of [['a page that never becomes ready', true], ['a page that never finishes loading', false]]) test(`${name} still ends in the failed page, and Retry opens a new window`, async () => {
  const h = app();
  await h.start(); if (loaded) h.pages[0].load.resolve();
  await settle();
  await h.pass(60000); assert.deepEqual([h.openPages(), h.failedPage()], [1, []]);
  await h.pass(60000);
  assert.deepEqual([h.pages[0].gone, h.failedPage(), h.stopped.length, h.starting()], [true, FAILED, 1, 0]);
  await h.start(); h.pages.at(-1).load.resolve(); await settle();
  assert.equal(await h.ask(), undefined);
  assert.deepEqual([h.openPages(), h.failedPage(), h.starting(), h.timers()], [1, [], 0, 0]);
});
test('what cannot become ready any more ends in the failed page at once', async () => {
  for (const [name, end] of [
    ['its page ended', h => h.pages[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' })],
    ['the backend went away', async (h, answer) => { const asked = h.ask(); answer.reject(Error('closed')); assert.equal((await asked)?.message, 'closed', 'the page is told as before'); }],
    ['the page could not be loaded', h => h.pages[0].load.reject(Error('ERR_CONNECTION_REFUSED'))],
  ]) {
    const h = app(), answer = later();
    h.sandbox.backend = () => answer.promise;
    await h.start(); if (!name.includes('loaded')) h.pages[0].load.resolve();
    await settle(); await end(h, answer); await settle();
    assert.deepEqual([h.pages[0].gone, h.failedPage(), h.stopped.length, h.starting(), h.timers()], [true, FAILED, 1, 0, 0], name);
  }
});
test('a window closed while it opens is not waited for, and shows no failure', async () => {
  for (const loaded of [true, false]) {
    const h = app();
    await h.start(); if (loaded) h.pages[0].load.resolve();
    await settle(); h.pages[0].destroy(); await settle();
    assert.deepEqual([h.openPages(), h.failedPage(), h.stopped.length, h.starting(), h.timers()], [0, [], 0, 0, 0], 'so the Dock icon opens a window again');
    assert.deepEqual(h.menu, [false]);
  }
});
test('a window that opened is not ended by what its page or backend does later', async () => {
  const h = app();
  await h.start(); h.pages[0].load.resolve(); await settle();
  assert.equal(await h.ask(), undefined);
  h.sandbox.backend = () => Promise.reject(Error('closed'));
  assert.equal((await h.ask())?.message, 'closed');
  h.pages[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  await h.pass(600000);
  assert.deepEqual([h.openPages(), h.failedPage(), h.stopped.length], [1, [], 0]);
});
