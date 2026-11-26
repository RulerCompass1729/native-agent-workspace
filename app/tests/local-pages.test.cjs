const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { uiError } = require('../ui-errors.cjs');
const uiLocale = require('../ui-locale.js');
const { createLocalPages, readDeclarations, pageUrl, allowedRequest, FILE, BOUNDS_FILE } = require('../local-pages.cjs');

const tempDir = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-local-pages-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const declare = (dir, pages) => fs.writeFileSync(path.join(dir, FILE), typeof pages === 'string' ? pages : JSON.stringify({ pages }));
const key = fn => { try { fn(); } catch (error) { return error.uiMessage?.key; } return null; };
const rejection = async promise => { try { await promise; } catch (error) { return error.uiMessage?.key; } return null; };
const board = { id: 'board', title: 'Board', url: 'http://127.0.0.1:7301/' };

function electron() {
  const created = [], partitions = new Map(), external = [];
  class Contents extends EventEmitter {
    constructor() { super(); this.loads = []; this.reloads = 0; this.closed = false; this.focused = 0; }
    setWindowOpenHandler(handler) { this.openHandler = handler; }
    loadURL(url) { this.loads.push(url); return Promise.resolve(); }
    getURL() { return this.loads.at(-1) || ''; }
    reload() { this.reloads++; }
    focus() { this.focused++; }
    isDestroyed() { return this.closed; }
    close() { this.closed = true; this.emit('destroyed'); }
  }
  const views = [];
  class View {
    constructor(options) { this.options = options; this.webContents = new Contents(); this.visible = true; this.bounds = null; views.push(this); }
    setBounds(bounds) { this.bounds = bounds; }
    setVisible(visible) { this.visible = visible; }
  }
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = new Contents(); this.destroyed = false; this.shown = 0; this.title = options.title; created.push(this); }
    isDestroyed() { return this.destroyed; }
    setTitle(title) { if (this.destroyed) throw new TypeError('Object has been destroyed'); this.title = title; }
    getNormalBounds() { return this.bounds; }
    isMinimized() { return false; }
    restore() {}
    show() { this.shown++; }
    focus() {}
    close() { this.emit('close'); this.destroyed = true; this.emit('closed'); }
  }
  const session = {
    fromPartition(name) {
      if (!partitions.has(name)) {
        const ses = { name, webRequest: { onBeforeRequest(handler) { ses.filter = handler; } } };
        ses.setPermissionRequestHandler = handler => { ses.request = handler; };
        ses.setPermissionCheckHandler = handler => { ses.check = handler; };
        ses.setDevicePermissionHandler = handler => { ses.device = handler; };
        partitions.set(name, ses);
      }
      return partitions.get(name);
    },
    get defaultSession() { throw Error('The main window session must not be touched'); },
  };
  const shell = { openExternal: url => { external.push(url); return Promise.resolve(); } };
  const screen = { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] };
  return { created, views, partitions, external, BrowserWindow: Window, WebContentsView: View, session, shell, screen };
}
function clock() {
  let now = 0, next = 1;
  const pending = new Map();
  return {
    set(fn, ms) { const id = next++; pending.set(id, { at: now + ms, fn }); return id; },
    clear(id) { pending.delete(id); },
    advance(ms) { now += ms; for (const [id, job] of [...pending]) if (job.at <= now) { pending.delete(id); job.fn(); } },
    get pending() { return pending.size; },
  };
}
// A main window as main.cjs hands it over: its context, its content view and its zoom.
function owner(width = 1240, height = 822) {
  const children = [];
  const contents = new EventEmitter();
  Object.assign(contents, { zoom: 1, focused: 0, getZoomFactor() { return this.zoom; }, focus() { this.focused++; }, isDestroyed: () => false });
  const win = new EventEmitter();
  Object.assign(win, {
    width, height, destroyed: false, webContents: contents,
    contentView: { children, addChildView(view) { children.push(view); }, removeChildView(view) { const i = children.indexOf(view); if (i >= 0) children.splice(i, 1); } },
    getContentBounds() { return { x: 0, y: 0, width: this.width, height: this.height }; },
    isDestroyed() { return this.destroyed; },
  });
  return { win };
}
function pages(t, list = [board]) {
  const dataDir = tempDir(t); declare(dataDir, list);
  const fake = electron(), timers = clock(), pushed = [];
  const local = createLocalPages({ dataDir, ...fake, uiError, displayText: (k, p) => uiLocale.format('zh', k, p), timers, notify: (to, state) => pushed.push({ to, state }) });
  return { dataDir, fake, local, timers, pushed };
}

test('declarations accept only http on 127.0.0.1 or localhost', t => {
  const dir = tempDir(t);
  declare(dir, [board, { id: 'b.2_x-y', title: ' Other ', url: 'http://localhost:9000/start?x=1' }]);
  const read = readDeclarations(dir, uiError);
  assert.deepEqual([...read.values()], [
    { id: 'board', title: 'Board', url: 'http://127.0.0.1:7301/', origin: 'http://127.0.0.1:7301' },
    { id: 'b.2_x-y', title: 'Other', url: 'http://localhost:9000/start?x=1', origin: 'http://localhost:9000' },
  ]);
  for (const url of ['https://127.0.0.1:7301/', 'http://example.com/', 'http://127.0.0.2/', 'http://user:pw@localhost/', 'http://localhost.evil.example/',
    'http://[::1]:7300/', 'http://0.0.0.0:7301/', 'file:///etc/hosts', 'javascript:alert(1)', 'ftp://localhost/', 'ws://localhost/', '', 7, undefined]) {
    declare(dir, [{ ...board, url }]);
    assert.equal(key(() => readDeclarations(dir, uiError)), 'error.localPage.entryUrl', String(url));
  }
});

test('declaration problems name the entry or the file', t => {
  const dir = tempDir(t);
  assert.equal(key(() => readDeclarations(dir, uiError)), 'error.localPage.noDeclarations');
  declare(dir, '{ not json'); assert.equal(key(() => readDeclarations(dir, uiError)), 'error.localPage.unreadable');
  declare(dir, '[]'); assert.equal(key(() => readDeclarations(dir, uiError)), 'error.localPage.shape');
  declare(dir, JSON.stringify({ pages: Array.from({ length: 51 }, (_, i) => ({ ...board, id: 'p' + i })) })); assert.equal(key(() => readDeclarations(dir, uiError)), 'error.localPage.shape');
  declare(dir, ' '.repeat(64 * 1024 + 1)); assert.equal(key(() => readDeclarations(dir, uiError)), 'error.localPage.shape');
  for (const id of ['', '-x', '.x', 'a/b', 'a b', 'x'.repeat(65), 3]) { declare(dir, [{ ...board, id }]); assert.equal(key(() => readDeclarations(dir, uiError)), 'error.localPage.entryId', String(id)); }
  declare(dir, [board, board]);
  try { readDeclarations(dir, uiError); assert.fail(); } catch (error) { assert.deepEqual(error.uiMessage.params, { index: 2, id: 'board' }); }
  declare(dir, [board, { ...board, id: 'Board' }]);
  try { readDeclarations(dir, uiError); assert.fail(); } catch (error) { assert.deepEqual(error.uiMessage.params, { index: 2, id: 'Board' }); }
  for (const title of ['', '   ', 'x'.repeat(101), null]) { declare(dir, [{ ...board, title }]); assert.equal(key(() => readDeclarations(dir, uiError)), 'error.localPage.entryTitle'); }
});

test('a plugin path stays under the declared origin; a raw address is refused', () => {
  const page = { ...board, origin: 'http://127.0.0.1:7301' };
  assert.equal(pageUrl(page, undefined, uiError), 'http://127.0.0.1:7301/');
  assert.equal(pageUrl(page, '/?view=list', uiError), 'http://127.0.0.1:7301/?view=list');
  assert.equal(pageUrl(page, '/a/../b?x=1#y', uiError), 'http://127.0.0.1:7301/b?x=1#y');
  for (const requested of ['http://evil.example/', 'https://127.0.0.1:7301/', 'http://127.0.0.1:7302/', '//evil.example/x', '/\\evil.example', '\\\\evil.example',
    'javascript:alert(1)', 'data:text/html,x', '?tab=x', 'tab', '/\nx', 42, {}, '/' + 'x'.repeat(2048)]) {
    assert.equal(key(() => pageUrl(page, requested, uiError)), 'error.localPage.path', String(requested));
  }
});

test('the window partition reaches only the declared origin', () => {
  const origin = 'http://127.0.0.1:7301';
  for (const url of ['http://127.0.0.1:7301/', 'http://127.0.0.1:7301/api?x=1', 'ws://127.0.0.1:7301/socket', 'blob:http://127.0.0.1:7301/1234', 'data:image/png;base64,AA=='])
    assert.equal(allowedRequest(origin, url), true, url);
  for (const url of ['http://127.0.0.1:7302/', 'http://localhost:7301/', 'https://127.0.0.1:7301/', 'wss://127.0.0.1:7301/', 'ws://127.0.0.1:7302/',
    'http://example.com/', 'file:///etc/hosts', 'blob:http://example.com/1', 'not a url'])
    assert.equal(allowedRequest(origin, url), false, url);
  assert.equal(allowedRequest(undefined, 'http://127.0.0.1:7301/'), false);
});

test('opening a page makes one isolated window without the workspace bridge', async t => {
  const { fake, local } = pages(t);
  const result = await local.open('board', '/?tab=a');
  assert.deepEqual(result, { id: 'board', url: 'http://127.0.0.1:7301/?tab=a', reused: false });
  assert.equal(fake.created.length, 1);
  const [win] = fake.created, prefs = win.options.webPreferences;
  assert.equal(prefs.partition, 'persist:naw-local-page-board');
  assert.equal('preload' in prefs, false);
  assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.webviewTag, false);
  assert.equal(win.options.title, 'Board');
  assert.deepEqual(win.webContents.loads, ['http://127.0.0.1:7301/?tab=a']);
  assert.equal(win.shown, 1);
  assert.deepEqual([...fake.partitions.keys()], ['persist:naw-local-page-board']);
  const ses = fake.partitions.get('persist:naw-local-page-board');
  for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read']) { let granted; ses.request(null, permission, value => { granted = value; }); assert.equal(granted, false); }
  assert.equal(ses.check(), false); assert.equal(ses.device(), false);
  const filter = url => { let reply; ses.filter({ url }, value => { reply = value; }); return reply.cancel; };
  assert.equal(filter('http://127.0.0.1:7301/api'), false);
  assert.equal(filter('http://127.0.0.1:9999/'), true);
  assert.equal(filter('https://example.com/x.js'), true);
});

test('the window keeps the declared title; a title that arrives after the window is destroyed is ignored', async t => {
  const { fake, local } = pages(t);
  await local.open('board');
  const [win] = fake.created;
  const retitle = () => { let prevented = false; win.webContents.emit('page-title-updated', { preventDefault: () => { prevented = true; } }, 'From the page'); return prevented; };
  win.title = 'From the page';
  assert.equal(retitle(), true); assert.equal(win.title, 'Board');
  win.destroyed = true; win.title = 'before destroy';
  assert.equal(retitle(), true); assert.equal(win.title, 'before destroy');
});

test('other origins cannot be navigated to; new windows go to the system browser', async t => {
  const { fake, local } = pages(t);
  await local.open('board');
  const wc = fake.created[0].webContents;
  const navigate = url => { let prevented = false; wc.emit('will-navigate', { preventDefault: () => { prevented = true; } }, url); return prevented; };
  assert.equal(navigate('http://127.0.0.1:7301/?tab=b'), false);
  for (const url of ['http://example.com/', 'http://127.0.0.1:7302/', 'file:///etc/hosts', 'https://127.0.0.1:7301/']) assert.equal(navigate(url), true, url);
  let attached = false; wc.emit('will-attach-webview', { preventDefault: () => { attached = true; } }); assert.equal(attached, true);
  assert.deepEqual(wc.openHandler({ url: 'https://example.com/doc' }), { action: 'deny' });
  assert.deepEqual(wc.openHandler({ url: 'http://127.0.0.1:7301/other' }), { action: 'deny' });
  assert.deepEqual(wc.openHandler({ url: 'file:///etc/hosts' }), { action: 'deny' });
  assert.deepEqual(wc.openHandler({ url: 'javascript:alert(1)' }), { action: 'deny' });
  assert.deepEqual(fake.external, ['https://example.com/doc', 'http://127.0.0.1:7301/other']);
  assert.equal(fake.created.length, 1);
});

test('the same id focuses its window and moves it to the new path', async t => {
  const { fake, local } = pages(t);
  await local.open('board', '/?tab=a');
  assert.deepEqual(await local.open('board', '/?tab=b'), { id: 'board', url: 'http://127.0.0.1:7301/?tab=b', reused: true });
  assert.deepEqual(await local.open('board'), { id: 'board', url: 'http://127.0.0.1:7301/', reused: true });
  assert.equal(fake.created.length, 1);
  assert.deepEqual(fake.created[0].webContents.loads, ['http://127.0.0.1:7301/?tab=a', 'http://127.0.0.1:7301/?tab=b']);
  assert.equal(fake.created[0].shown, 3);
});

test('refusals open nothing', async t => {
  const { fake, local } = pages(t);
  assert.equal(await rejection(local.open('board', '/', { background: true })), 'error.localPage.background');
  assert.equal(await rejection(local.open('missing')), 'error.localPage.unknown');
  assert.equal(await rejection(local.open(null)), 'error.localPage.unknown');
  assert.equal(await rejection(local.open('board', 'http://evil.example/')), 'error.localPage.path');
  assert.equal(await rejection(local.open('board', '//evil.example/')), 'error.localPage.path');
  assert.equal(fake.created.length, 0);
  assert.equal(fake.partitions.size, 0);
});

test('a page that cannot load says so in the window', async t => {
  const { fake, local } = pages(t);
  await local.open('board', '/?tab=a');
  const wc = fake.created[0].webContents;
  wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:7301/?tab=a', false);
  wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://127.0.0.1:7301/?tab=a', true);
  assert.equal(wc.loads.length, 1);
  wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:7301/?tab=a', true);
  assert.equal(wc.loads.length, 2);
  const shown = wc.loads[1];
  assert.match(shown, /^data:text\/html;charset=utf-8,/u);
  const html = decodeURIComponent(shown.slice(shown.indexOf(',') + 1));
  assert.match(html, /「Board」打不开/u);
  assert.match(html, /http:\/\/127\.0\.0\.1:7301 没有正常响应（ERR_CONNECTION_REFUSED）/u);
  assert.match(html, /<a href="http:\/\/127\.0\.0\.1:7301\/\?tab=a">重试<\/a>/u);
  assert.match(html, /default-src 'none'/u);
  assert.doesNotMatch(html, /<script/u);
  wc.emit('did-fail-load', {}, -2, 'ERR_FAILED', shown, true);
  assert.equal(wc.loads.length, 2);
  // A blocked jump to another origin retries the declared page, never the other origin.
  wc.emit('did-fail-load', {}, -20, 'ERR_BLOCKED_BY_CLIENT', 'http://example.com/', true);
  assert.match(decodeURIComponent(wc.loads[2]), /<a href="http:\/\/127\.0\.0\.1:7301\/">/u);
});

test('window size and position are remembered per page', async t => {
  const { dataDir, fake, local } = pages(t, [board, { id: 'two', title: 'Two', url: 'http://localhost:9000/' }]);
  await local.open('board');
  fake.created[0].bounds = { x: 40, y: 60, width: 900, height: 700 };
  fake.created[0].close();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, BOUNDS_FILE), 'utf8')), { board: { x: 40, y: 60, width: 900, height: 700 } });
  await local.open('board');
  assert.equal(fake.created.length, 2);
  assert.deepEqual([fake.created[1].options.x, fake.created[1].options.y, fake.created[1].options.width, fake.created[1].options.height], [40, 60, 900, 700]);
  await local.open('two');
  assert.equal(fake.created[2].options.x, undefined);
  fake.created[2].bounds = { x: 5000, y: 5000, width: 800, height: 600 };
  fake.created[2].close();
  await local.open('two');
  assert.deepEqual([fake.created[3].options.x, fake.created[3].options.width], [undefined, 800]);
});

test('the main window keeps its own session filter and the bridge stays on the main window', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  const filter = "  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => callback({ cancel: new URL(details.url).host !== new URL(dsh.origin).host }));\n";
  assert.equal(main.split(filter).length, 2);
  assert.equal(main.match(/defaultSession\.webRequest/gu).length, 1);
  assert.match(main, /register\('openLocalPage', \(c, id, requested\) => currentLocalPages\(\)\.open\(id, requested, \{ background: c\.background, owner: c \}\)\);/u);
  assert.match(main, /localPages \|\|= createLocalPages\(\{/u);
  const source = fs.readFileSync(path.join(__dirname, '../local-pages.cjs'), 'utf8');
  assert.doesNotMatch(source, /defaultSession|preload\s*:/u);
  assert.match(fs.readFileSync(path.join(__dirname, '../preload.cjs'), 'utf8'), /'openLocalFile', 'openLocalPage'/u);
});

const tabPage = { ...board, tab: true };
const other = { id: 'other', title: 'Other', url: 'http://localhost:9000/' };
const MINUTE = 60 * 1000;

test('a declaration may ask for a tab; anything but true or false is refused', t => {
  const dir = tempDir(t);
  declare(dir, [tabPage, { ...other, tab: false }]);
  assert.deepEqual([...readDeclarations(dir, uiError).values()], [
    { id: 'board', title: 'Board', url: 'http://127.0.0.1:7301/', origin: 'http://127.0.0.1:7301', tab: true },
    { id: 'other', title: 'Other', url: 'http://localhost:9000/', origin: 'http://localhost:9000' },
  ]);
  for (const tab of ['true', 1, null, {}]) {
    declare(dir, [board, { ...other, tab }]);
    try { readDeclarations(dir, uiError); assert.fail(String(tab)); } catch (error) { assert.equal(error.uiMessage?.key, 'error.localPage.entryTab', String(tab)); assert.deepEqual(error.uiMessage.params, { index: 2 }); }
  }
});

test('without a tab page every window has no tabs', async t => {
  const empty = pages(t, [board]), w = owner();
  assert.deepEqual(empty.local.tabs(w), { tabs: [], active: null });
  const none = pages(t, []);
  fs.rmSync(path.join(none.dataDir, FILE));
  assert.deepEqual(none.local.tabs(w), { tabs: [], active: null });
  declare(none.dataDir, '{ broken');
  assert.deepEqual(none.local.tabs(w), { tabs: [], active: null });
  await empty.local.open('board', undefined, { owner: w });
  assert.equal(empty.fake.created.length, 1, 'A page without "tab" still opens its own window');
  assert.equal(empty.fake.views.length, 0);
  assert.equal(w.win.contentView.children.length, 0);
});

test('a tab page opens in the asking window under the tab strip, isolated like a page window', async t => {
  const { fake, local, pushed } = pages(t, [tabPage, other]), w = owner();
  assert.deepEqual(local.tabs(w), { tabs: [{ id: 'board', title: 'Board' }], active: null });
  const result = await local.open('board', undefined, { owner: w });
  assert.deepEqual(result, { id: 'board', url: 'http://127.0.0.1:7301/', reused: false, tab: true });
  assert.equal(fake.created.length, 0, 'No window is opened for a tab page');
  assert.equal(fake.views.length, 1);
  const [view] = fake.views, prefs = view.options.webPreferences;
  assert.deepEqual(w.win.contentView.children, [view]);
  assert.equal(prefs.partition, 'persist:naw-local-page-board');
  assert.equal('preload' in prefs, false);
  assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.webviewTag, false);
  assert.deepEqual(view.webContents.loads, ['http://127.0.0.1:7301/']);
  assert.deepEqual(view.bounds, { x: 0, y: 30, width: 1240, height: 792 });
  assert.equal(view.visible, true);
  assert.equal(view.webContents.focused, 1);
  assert.deepEqual(pushed.at(-1), { to: w, state: { tabs: [{ id: 'board', title: 'Board' }], active: 'board' } });
  const wc = view.webContents;
  const navigate = url => { let prevented = false; wc.emit('will-navigate', { preventDefault: () => { prevented = true; } }, url); return prevented; };
  assert.equal(navigate('http://127.0.0.1:7301/?x=1'), false);
  assert.equal(navigate('http://example.com/'), true);
  let attached = false; wc.emit('will-attach-webview', { preventDefault: () => { attached = true; } }); assert.equal(attached, true);
  assert.deepEqual(wc.openHandler({ url: 'https://example.com/doc' }), { action: 'deny' });
  assert.deepEqual(fake.external, ['https://example.com/doc']);
  const ses = fake.partitions.get('persist:naw-local-page-board');
  const filter = url => { let reply; ses.filter({ url }, value => { reply = value; }); return reply.cancel; };
  assert.equal(filter('http://127.0.0.1:7301/api'), false);
  assert.equal(filter('http://localhost:9000/'), true);
});

test('switching to NAW and back within 20 minutes keeps the page loaded', async t => {
  const { fake, local, timers } = pages(t, [tabPage]), w = owner();
  await local.open('board', undefined, { owner: w });
  const [view] = fake.views;
  local.show(w, null);
  assert.equal(view.visible, false);
  assert.equal(w.win.webContents.focused, 1);
  assert.deepEqual(local.tabs(w).active, null);
  timers.advance(19 * MINUTE + 59 * 1000);
  local.show(w, 'board');
  assert.equal(view.visible, true);
  assert.equal(fake.views.length, 1);
  assert.deepEqual(view.webContents.loads, ['http://127.0.0.1:7301/']);
  assert.equal(view.webContents.reloads, 0);
  assert.equal(timers.pending, 0, 'A shown page has no release timer');
  local.show(w, null);
  timers.advance(10 * MINUTE);
  assert.deepEqual(await local.open('board', undefined, { owner: w }), { id: 'board', url: 'http://127.0.0.1:7301/', reused: true, tab: true });
  assert.deepEqual(view.webContents.loads, ['http://127.0.0.1:7301/'], 'Opening without a path only switches');
  await local.open('board', '/?tab=b', { owner: w });
  assert.deepEqual(view.webContents.loads, ['http://127.0.0.1:7301/', 'http://127.0.0.1:7301/?tab=b'], 'A plugin path still moves the page');
});

test('a page hidden for 20 minutes is released and loads again when shown', async t => {
  const { fake, local, timers } = pages(t, [tabPage]), w = owner();
  await local.open('board', '/?tab=a', { owner: w });
  const [first] = fake.views;
  local.show(w, null);
  timers.advance(20 * MINUTE);
  assert.equal(first.webContents.closed, true);
  assert.deepEqual(w.win.contentView.children, []);
  assert.deepEqual(local.tabs(w), { tabs: [{ id: 'board', title: 'Board' }], active: null }, 'The tab stays after its page is released');
  local.show(w, 'board');
  assert.equal(fake.views.length, 2);
  const [, second] = fake.views;
  assert.deepEqual(w.win.contentView.children, [second]);
  assert.deepEqual(second.webContents.loads, ['http://127.0.0.1:7301/?tab=a'], 'It reloads where the person left it');
});

test('the reload button reloads the shown page', async t => {
  const { fake, local } = pages(t, [tabPage]), w = owner();
  await local.open('board', undefined, { owner: w });
  local.reload(w, 'board');
  assert.equal(fake.views[0].webContents.reloads, 1);
  assert.equal(fake.views.length, 1);
});

test('another window takes the page over without reloading it', async t => {
  const { fake, local, pushed } = pages(t, [tabPage]), a = owner(), b = owner(850, 572);
  await local.open('board', undefined, { owner: a });
  const [view] = fake.views;
  local.show(b, 'board');
  assert.equal(fake.views.length, 1);
  assert.deepEqual(a.win.contentView.children, []);
  assert.deepEqual(b.win.contentView.children, [view]);
  assert.deepEqual(view.bounds, { x: 0, y: 30, width: 850, height: 542 });
  assert.equal(view.webContents.loads.length, 1);
  assert.equal(local.tabs(a).active, null);
  assert.equal(local.tabs(b).active, 'board');
  assert.ok(pushed.some(p => p.to === a && p.state.active === null), 'The first window is told it shows NAW again');
});

test('the page follows the window size, the strip height and zoom', async t => {
  const { fake, local } = pages(t, [tabPage]), w = owner();
  await local.open('board', undefined, { owner: w });
  const [view] = fake.views;
  w.win.width = 900; w.win.height = 640; w.win.emit('resize');
  assert.deepEqual(view.bounds, { x: 0, y: 30, width: 900, height: 610 });
  w.win.webContents.zoom = 1.25; local.layout(w, 30);
  assert.deepEqual(view.bounds, { x: 0, y: 38, width: 900, height: 602 });
  for (const top of [-1, 'x', 500, NaN]) assert.throws(() => local.layout(w, top));
});

test('closing a window releases its page at once', async t => {
  const { fake, local, timers } = pages(t, [tabPage, { ...other, tab: true }]), w = owner();
  await local.open('board', undefined, { owner: w });
  local.show(w, 'other');
  assert.equal(fake.views.length, 2);
  assert.equal(timers.pending, 1);
  local.closeOwner(w);
  assert.deepEqual(fake.views.map(v => v.webContents.closed), [true, true]);
  assert.equal(timers.pending, 0);
  assert.deepEqual(local.tabs(owner()).active, null);
});

test('Control-Tab moves between tabs from NAW and from inside the page', async t => {
  const { fake, local } = pages(t, [tabPage]), w = owner();
  local.tabs(w);
  const key = (wc, input) => { let prevented = false; wc.emit('before-input-event', { preventDefault: () => { prevented = true; } }, { type: 'keyDown', key: 'Tab', control: true, shift: false, alt: false, meta: false, ...input }); return prevented; };
  assert.equal(key(w.win.webContents, {}), true);
  assert.equal(local.tabs(w).active, 'board');
  const [view] = fake.views;
  assert.equal(key(view.webContents, { shift: true }), true);
  assert.equal(local.tabs(w).active, null);
  assert.equal(key(w.win.webContents, { control: false }), false);
  assert.equal(key(w.win.webContents, { type: 'keyUp' }), false);
});

// Electron takes the view of a page that closes itself out of the window and drops its webContents.
function closesItself(w, view) {
  const wc = view.webContents;
  wc.closed = true; view.webContents = undefined; w.win.contentView.removeChildView(view); wc.emit('destroyed');
}
for (const shown of [true, false])
test(`a tab page that closes itself while ${shown ? 'shown' : 'hidden'} leaves NAW and opens again`, async t => {
  const { fake, local, timers, pushed } = pages(t, [tabPage]), w = owner();
  await local.open('board', undefined, { owner: w });
  if (!shown) local.show(w, null);
  pushed.length = 0;
  closesItself(w, fake.views[0]);
  assert.equal(local.tabs(w).active, null);
  assert.deepEqual(pushed.map(p => [p.to, p.state.active]), [[w, null]]);
  assert.equal(timers.pending, 0, 'no release is left for a page that is gone');
  assert.equal(local.reload(w, 'board').active, 'board');
  assert.equal(fake.views.length, 2); assert.deepEqual(w.win.contentView.children, [fake.views[1]]);
  closesItself(w, fake.views[1]); local.closeOwner(w);
  assert.equal(timers.pending, 0);
});
test('a tab page whose declared address changed loads the new one when shown again, not the one it was left on', async t => {
  const { dataDir, fake, local, timers } = pages(t, [tabPage]), w = owner();
  await local.open('board', undefined, { owner: w });
  local.show(w, null);
  declare(dataDir, [{ ...tabPage, url: 'http://127.0.0.1:7302/' }]);
  local.show(w, 'board');
  assert.deepEqual(fake.views[0].webContents.loads, ['http://127.0.0.1:7301/', 'http://127.0.0.1:7302/']);
  local.show(w, 'board');
  assert.equal(fake.views[0].webContents.loads.length, 2, 'the same address is not loaded again');
  local.show(w, null); timers.advance(20 * 60 * 1000);
  declare(dataDir, [{ ...tabPage, url: 'http://127.0.0.1:8003/' }]);
  local.show(w, 'board');
  assert.deepEqual(fake.views[1].webContents.loads, ['http://127.0.0.1:8003/']);
});
test('showing the workspace uncovers NAW and leaves a window already on it alone', async t => {
  const { fake, local, pushed } = pages(t, [tabPage]), w = owner();
  local.workspace(w); local.workspace(owner());
  assert.deepEqual([pushed.length, w.win.webContents.focused], [0, 0]);
  await local.open('board', undefined, { owner: w });
  local.workspace(w);
  assert.equal(local.tabs(w).active, null); assert.equal(fake.views[0].visible, false); assert.equal(w.win.webContents.focused, 1);
});

test('tab actions refuse unknown pages, page windows and background agents', async t => {
  const { fake, local } = pages(t, [tabPage, other]), w = owner();
  assert.equal(key(() => local.show(w, 'missing')), 'error.localPage.unknown');
  assert.equal(key(() => local.show(w, 'other')), 'error.localPage.unknown');
  assert.equal(await rejection(local.open('board', '/', { background: true, owner: w })), 'error.localPage.background');
  assert.equal(await rejection(local.open('board', 'http://evil.example/', { owner: w })), 'error.localPage.path');
  assert.equal(fake.views.length, 0);
  assert.equal(fake.created.length, 0);
});

test('the strip ships in both builds, and its IPC is the person\'s window only', () => {
  const read = name => fs.readFileSync(path.join(__dirname, '..', '..', name), 'utf8');
  const build = read('scripts/build-ui.cjs'), html = read('app/renderer/index.html'), main = read('app/main.cjs'), preload = read('app/preload.cjs');
  assert.ok(build.indexOf("'window-tabs.js'") > 0 && build.indexOf("'window-tabs.js'") < build.indexOf("'renderer.js'"));
  assert.ok(build.includes("css += `\\n#window-tabs{${palette}}\\n` + read('app/renderer/window-tabs.css');"), 'The strip sits outside .naw and needs its own palette');
  assert.ok(html.indexOf('src="window-tabs.js"') > 0 && html.indexOf('src="window-tabs.js"') < html.indexOf('src="renderer.js"'));
  assert.ok(html.includes('<link rel="stylesheet" href="window-tabs.css">'));
  assert.match(main, /register\('localPageTabs', \(c, action, value\) => \{\n    if \(c\.background\) throw uiError\('error\.localPage\.background'\);/u);
  assert.ok(main.includes("applicationHandlers.delete('localPageTabs');"));
  assert.match(main, /context\.client\.close\([^\n]*\n    localPages\?\.closeOwner\(context\);/u, 'The window is gone from the list whatever its pages do');
  assert.match(main, /localPages\?\.workspace\(context\);\n  sendToPage\(context, 'workspace:reveal-record', target\);/u, 'A clicked notice uncovers NAW');
  assert.match(main, /localPages\?\.workspace\(context\);\n    sendToPage\(context, 'workspace:switch-mode', mode\);/u);
  assert.ok(preload.includes("'openLocalPage', 'localPageTabs'") && preload.includes("['onLocalPageTabs', 'workspace:local-page-tabs']"));
});
