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
const board = { id: 'board', title: 'Board', url: 'http://127.0.0.1:8001/' };

function electron() {
  const created = [], partitions = new Map(), external = [];
  class Contents extends EventEmitter {
    constructor() { super(); this.loads = []; }
    setWindowOpenHandler(handler) { this.openHandler = handler; }
    loadURL(url) { this.loads.push(url); return Promise.resolve(); }
  }
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = new Contents(); this.destroyed = false; this.shown = 0; this.title = options.title; created.push(this); }
    isDestroyed() { return this.destroyed; }
    setTitle(title) { this.title = title; }
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
  return { created, partitions, external, BrowserWindow: Window, session, shell, screen };
}
function pages(t, list = [board]) {
  const dataDir = tempDir(t); declare(dataDir, list);
  const fake = electron();
  const local = createLocalPages({ dataDir, ...fake, uiError, displayText: (k, p) => uiLocale.format('zh', k, p) });
  return { dataDir, fake, local };
}

test('declarations accept only http on 127.0.0.1 or localhost', t => {
  const dir = tempDir(t);
  declare(dir, [board, { id: 'b.2_x-y', title: ' Other ', url: 'http://localhost:9000/start?x=1' }]);
  const read = readDeclarations(dir, uiError);
  assert.deepEqual([...read.values()], [
    { id: 'board', title: 'Board', url: 'http://127.0.0.1:8001/', origin: 'http://127.0.0.1:8001' },
    { id: 'b.2_x-y', title: 'Other', url: 'http://localhost:9000/start?x=1', origin: 'http://localhost:9000' },
  ]);
  for (const url of ['https://127.0.0.1:8001/', 'http://example.com/', 'http://127.0.0.2/', 'http://user:pw@localhost/', 'http://localhost.evil.example/',
    'http://[::1]:8000/', 'http://0.0.0.0:8001/', 'file:///etc/hosts', 'javascript:alert(1)', 'ftp://localhost/', 'ws://localhost/', '', 7, undefined]) {
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
  const page = { ...board, origin: 'http://127.0.0.1:8001' };
  assert.equal(pageUrl(page, undefined, uiError), 'http://127.0.0.1:8001/');
  assert.equal(pageUrl(page, '/?tab=research', uiError), 'http://127.0.0.1:8001/?tab=research');
  assert.equal(pageUrl(page, '/a/../b?x=1#y', uiError), 'http://127.0.0.1:8001/b?x=1#y');
  for (const requested of ['http://evil.example/', 'https://127.0.0.1:8001/', 'http://127.0.0.1:8002/', '//evil.example/x', '/\\evil.example', '\\\\evil.example',
    'javascript:alert(1)', 'data:text/html,x', '?tab=x', 'tab', '/\nx', 42, {}, '/' + 'x'.repeat(2048)]) {
    assert.equal(key(() => pageUrl(page, requested, uiError)), 'error.localPage.path', String(requested));
  }
});

test('the window partition reaches only the declared origin', () => {
  const origin = 'http://127.0.0.1:8001';
  for (const url of ['http://127.0.0.1:8001/', 'http://127.0.0.1:8001/api?x=1', 'ws://127.0.0.1:8001/socket', 'blob:http://127.0.0.1:8001/1234', 'data:image/png;base64,AA=='])
    assert.equal(allowedRequest(origin, url), true, url);
  for (const url of ['http://127.0.0.1:8002/', 'http://localhost:8001/', 'https://127.0.0.1:8001/', 'wss://127.0.0.1:8001/', 'ws://127.0.0.1:8002/',
    'http://example.com/', 'file:///etc/hosts', 'blob:http://example.com/1', 'not a url'])
    assert.equal(allowedRequest(origin, url), false, url);
  assert.equal(allowedRequest(undefined, 'http://127.0.0.1:8001/'), false);
});

test('opening a page makes one isolated window without the workspace bridge', async t => {
  const { fake, local } = pages(t);
  const result = await local.open('board', '/?tab=a');
  assert.deepEqual(result, { id: 'board', url: 'http://127.0.0.1:8001/?tab=a', reused: false });
  assert.equal(fake.created.length, 1);
  const [win] = fake.created, prefs = win.options.webPreferences;
  assert.equal(prefs.partition, 'persist:naw-local-page-board');
  assert.equal('preload' in prefs, false);
  assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.webviewTag, false);
  assert.equal(win.options.title, 'Board');
  assert.deepEqual(win.webContents.loads, ['http://127.0.0.1:8001/?tab=a']);
  assert.equal(win.shown, 1);
  assert.deepEqual([...fake.partitions.keys()], ['persist:naw-local-page-board']);
  const ses = fake.partitions.get('persist:naw-local-page-board');
  for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read']) { let granted; ses.request(null, permission, value => { granted = value; }); assert.equal(granted, false); }
  assert.equal(ses.check(), false); assert.equal(ses.device(), false);
  const filter = url => { let reply; ses.filter({ url }, value => { reply = value; }); return reply.cancel; };
  assert.equal(filter('http://127.0.0.1:8001/api'), false);
  assert.equal(filter('http://127.0.0.1:9999/'), true);
  assert.equal(filter('https://example.com/x.js'), true);
});

test('other origins cannot be navigated to; new windows go to the system browser', async t => {
  const { fake, local } = pages(t);
  await local.open('board');
  const wc = fake.created[0].webContents;
  const navigate = url => { let prevented = false; wc.emit('will-navigate', { preventDefault: () => { prevented = true; } }, url); return prevented; };
  assert.equal(navigate('http://127.0.0.1:8001/?tab=b'), false);
  for (const url of ['http://example.com/', 'http://127.0.0.1:8002/', 'file:///etc/hosts', 'https://127.0.0.1:8001/']) assert.equal(navigate(url), true, url);
  let attached = false; wc.emit('will-attach-webview', { preventDefault: () => { attached = true; } }); assert.equal(attached, true);
  assert.deepEqual(wc.openHandler({ url: 'https://example.com/doc' }), { action: 'deny' });
  assert.deepEqual(wc.openHandler({ url: 'http://127.0.0.1:8001/other' }), { action: 'deny' });
  assert.deepEqual(wc.openHandler({ url: 'file:///etc/hosts' }), { action: 'deny' });
  assert.deepEqual(wc.openHandler({ url: 'javascript:alert(1)' }), { action: 'deny' });
  assert.deepEqual(fake.external, ['https://example.com/doc', 'http://127.0.0.1:8001/other']);
  assert.equal(fake.created.length, 1);
});

test('the same id focuses its window and moves it to the new path', async t => {
  const { fake, local } = pages(t);
  await local.open('board', '/?tab=a');
  assert.deepEqual(await local.open('board', '/?tab=b'), { id: 'board', url: 'http://127.0.0.1:8001/?tab=b', reused: true });
  assert.deepEqual(await local.open('board'), { id: 'board', url: 'http://127.0.0.1:8001/', reused: true });
  assert.equal(fake.created.length, 1);
  assert.deepEqual(fake.created[0].webContents.loads, ['http://127.0.0.1:8001/?tab=a', 'http://127.0.0.1:8001/?tab=b']);
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
  wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:8001/?tab=a', false);
  wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://127.0.0.1:8001/?tab=a', true);
  assert.equal(wc.loads.length, 1);
  wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:8001/?tab=a', true);
  assert.equal(wc.loads.length, 2);
  const shown = wc.loads[1];
  assert.match(shown, /^data:text\/html;charset=utf-8,/u);
  const html = decodeURIComponent(shown.slice(shown.indexOf(',') + 1));
  assert.match(html, /「Board」打不开/u);
  assert.match(html, /http:\/\/127\.0\.0\.1:8001 没有正常响应（ERR_CONNECTION_REFUSED）/u);
  assert.match(html, /<a href="http:\/\/127\.0\.0\.1:8001\/\?tab=a">重试<\/a>/u);
  assert.match(html, /default-src 'none'/u);
  assert.doesNotMatch(html, /<script/u);
  wc.emit('did-fail-load', {}, -2, 'ERR_FAILED', shown, true);
  assert.equal(wc.loads.length, 2);
  // A blocked jump to another origin retries the declared page, never the other origin.
  wc.emit('did-fail-load', {}, -20, 'ERR_BLOCKED_BY_CLIENT', 'http://example.com/', true);
  assert.match(decodeURIComponent(wc.loads[2]), /<a href="http:\/\/127\.0\.0\.1:8001\/">/u);
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
  assert.match(main, /register\('openLocalPage', \(c, id, requested\) => \(localPages \|\|= createLocalPages\(\{[\s\S]*?\}\)\)\.open\(id, requested, \{ background: c\.background \}\)\);/u);
  const source = fs.readFileSync(path.join(__dirname, '../local-pages.cjs'), 'utf8');
  assert.doesNotMatch(source, /defaultSession|preload\s*:/u);
  assert.match(fs.readFileSync(path.join(__dirname, '../preload.cjs'), 'utf8'), /'openLocalFile', 'openLocalPage'/u);
});
