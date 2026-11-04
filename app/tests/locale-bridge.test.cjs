const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const locale = require('../ui-locale.js');
const detached = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function preload(argv) {
  const exposed = {}, listeners = new Map(), calls = [];
  const ipcRenderer = { invoke: (...args) => { calls.push(args); return Promise.reject(Error('IPC unavailable')); }, on: (name, callback) => { const list = listeners.get(name) || []; list.push(callback); listeners.set(name, list); }, removeListener() {} };
  const context = vm.createContext({ require: name => { assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } }, ipcRenderer }; }, process: { argv }, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../preload.cjs'), 'utf8'), context);
  return { exposed, calls, emit(name, value) { for (const callback of listeners.get(name) || []) callback({}, value); } };
}

test('actual sandbox preload read stays valid offline and ignores malformed push snapshots and optimistic callbacks', async () => {
  const native = { languages: ['ja', 'en-US', 'zh'], preference: 'zh' };
  const p = preload(['renderer', `--naw-ui-locale=${JSON.stringify(native)}`]);
  const bridge = p.exposed.__DSH_LOCALE__;
  assert.deepEqual(detached(await bridge.read()), native);
  assert.equal(p.calls.length, 0, 'Locale boot must not wait on workspace IPC');
  assert.doesNotThrow(() => bridge.onChange('en'));
  assert.deepEqual(detached(await bridge.read()), native, 'Optimistic paint is not accepted persistence');
  for (const malformed of [undefined, {}, { languages: [], preference: 12 }, { languages: ['en', false], preference: 'en' }]) {
    p.emit('workspace:locale', malformed);
    assert.deepEqual(detached(await bridge.read()), native);
  }
  const accepted = { languages: native.languages, preference: 'en', warning: null };
  p.emit('workspace:locale', accepted);
  assert.deepEqual(detached(await bridge.read()), { languages: native.languages, preference: 'en' });
  assert.equal(p.calls.length, 0, 'Read and presentation callbacks cannot send native/control/write requests');
});

test('unavailable native bootstrap still gives DSH a complete nonthrowing envelope', async () => {
  for (const argv of [[], ['--naw-ui-locale={bad'], ['--naw-ui-locale={"languages":[5],"preference":"en"}']]) {
    const p = preload(argv);
    assert.equal(locale.validSnapshot(await p.exposed.__DSH_LOCALE__.read()), true);
    assert.equal(p.calls.length, 0);
  }
});

function shell(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-locale-shell-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let menu, installs = 0;
  const sent = [];
  const noop = () => {};
  const makeMenu = rows => ({ items: rows.map(row => {
    const item = { ...row };
    if (row.submenu) item.submenu = makeMenu(row.submenu);
    else if (row.role === 'editMenu') item.submenu = makeMenu([{ role: 'copy', accelerator: 'CmdOrCtrl+C' }, { role: 'paste' }]);
    else if (row.role === 'windowMenu') item.submenu = makeMenu([{ role: 'minimize' }, { label: 'Native window 中文', id: 'native-content' }]);
    return item;
  }) });
  class Window {
    constructor(options) { this.options = options; this.webContents = { id: 1, send: (channel, value) => sent.push([channel, detached(value)]) }; }
    isDestroyed() { return false; }
  }
  const electron = { app: { name: 'Native Agent Workspace', setName: noop, getVersion: () => 'locale-test', getPath: () => dir, getPreferredSystemLanguages: () => ['ja', 'en-US'], commandLine: { appendSwitch: noop }, requestSingleInstanceLock: () => false, quit: noop, on: noop },
    BrowserWindow: Window, ipcMain: { handle: noop }, Menu: { buildFromTemplate: makeMenu, setApplicationMenu: value => { menu = value; installs++; } } };
  const main = path.join(__dirname, '../main.cjs'), nativeRequire = createRequire(main);
  const context = vm.createContext({ require: name => name === 'electron' ? electron : nativeRequire(name), __dirname: path.dirname(main), process: { env: {}, argv: [], execPath: process.execPath }, URL, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(main, 'utf8'), context, { filename: main });
  return { context, sent, get menu() { return menu; }, get installs() { return installs; }, run: source => vm.runInContext(source, context) };
}

test('native-shell menu relabeling keeps every action and instance; stale Host generations cannot change it', async t => {
  const s = shell(t);
  await s.run('readStartupLocale()'); // VM has no dynamic importer: exercises read-failure/system-language fallback.
  const original = s.menu;
  const shape = current => current.items.map(item => ({ role: item.role, id: item.id, accelerator: item.accelerator, action: typeof item.click, submenu: item.submenu && shape(item.submenu) }));
  const before = shape(original);
  const nativeContent = () => s.menu.items.find(item => item.role === 'windowMenu').submenu.items.find(item => item.id === 'native-content').label;
  assert.equal(s.menu.items.find(item => item.id === 'naw-menu-file').label, 'File');
  s.run("acceptLocale({preference:'zh',revision:1,warning:null},0)");
  assert.equal(s.menu, original, 'Update labels on the existing native menu, without rebuilding actions');
  assert.equal(s.installs, 1);
  assert.deepEqual(shape(s.menu), before);
  assert.equal(s.menu.items.find(item => item.id === 'naw-menu-file').label, '文件');
  assert.equal(nativeContent(), 'Native window 中文');
  s.run("localeHostGeneration=1; acceptLocale({preference:'en',revision:2,warning:null},0)");
  assert.equal(s.menu.items.find(item => item.id === 'naw-menu-file').label, '文件');
  s.run("acceptLocale({preference:'en',revision:2,warning:null},1)");
  assert.equal(s.menu.items.find(item => item.id === 'naw-menu-file').label, 'File');
  assert.deepEqual(shape(s.menu), before);
});

test('actual window options deliver the native snapshot to actual preload without granting any APIs', t => {
  const s = shell(t);
  s.run("acceptLocale({preference:'zh',revision:1,warning:null},0)");
  const options = s.run('createWindow().options');
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.sandbox, true);
  const p = preload(options.webPreferences.additionalArguments);
  assert.equal(p.exposed.__DSH_LOCALE__.bootstrap.preference, 'zh');
  assert.equal(p.calls.length, 0);
});

test('parent installs the accepted-settings listener before the URL and strips all unrelated config', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-locale-parent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.pid = 2147483000; child.connected = true; child.disconnect = () => { child.connected = false; };
  const file = path.join(__dirname, '../dsh-host.cjs'), nativeRequire = createRequire(file);
  let didSpawn; const spawned = new Promise(resolve => { didSpawn = resolve; });
  const context = vm.createContext({ module: { exports: {} }, require: name => name === 'node:child_process' ? { spawn: () => { didSpawn(); return child; } } : nativeRequire(name), __dirname: path.dirname(file), process: { env: {}, execPath: process.execPath, pid: process.pid }, setTimeout, clearTimeout, Promise, URL });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  const received = [];
  const starting = context.module.exports.startDsh(dir, { onLocale: value => received.push(detached(value)) });
  await spawned;
  assert.equal(child.listenerCount('message'), 1);
  child.emit('message', { type: 'ui-locale', preference: 'en', revision: 0, secret: 'MUST_NOT_LEAVE_HOST', warning: null });
  assert.deepEqual(received, [{ preference: 'en', revision: 0, explicit: false, warning: null }]);
  child.emit('message', { type: 'ui-locale', preference: 'invalid value', revision: 1, secret: 'MUST_NOT_LEAVE_HOST' });
  assert.equal(received.length, 1);
  child.stdout.write('dsh web: http://127.0.0.1:12345/?synthetic\n');
  const host = await starting;
  assert.equal(host.url, 'http://127.0.0.1:12345/?synthetic');
  host.stop(); child.emit('exit', 0);
  assert.equal(fs.existsSync(path.join(dir, 'ui-host.json')), false);
});

function startup(initial) {
  const elements = Object.fromEntries(['title', 'detail', 'retry', 'data'].map(id => [id, { textContent: '', hidden: false, disabled: false }]));
  const listeners = {}, calls = [];
  const workspace = { onLocale: fn => { listeners.locale = fn; }, onStartup: fn => { listeners.startup = fn; }, retryStartup: () => calls.push('retry'), startupData: () => calls.push('data') };
  const window = { workspace, __DSH_LOCALE__: { bootstrap: initial } };
  const document = { documentElement: {}, getElementById: id => elements[id] };
  const context = vm.createContext({ window, document });
  for (const name of ['ui-messages.js', 'ui-locale.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), context);
  window.nativeWorkspaceLocale = context.nativeWorkspaceLocale;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../startup.js'), 'utf8'), context);
  return { elements, document, listeners, calls };
}

test('startup first render and failure/retry text use the same native snapshot without exposing upstream details', () => {
  const s = startup({ languages: ['en-US'], preference: null });
  assert.equal(s.elements.title.textContent, 'Opening your workspace');
  assert.equal(s.document.documentElement.lang, 'en');
  s.listeners.startup({ kind: 'failed', code: 'NAW_VIEW_RECORD', detail: 'SECRET_URL_MUST_NOT_RENDER', retry: true, data: true });
  assert.match(s.elements.detail.textContent, /original file is retained/);
  assert.doesNotMatch(s.elements.detail.textContent, /SECRET_URL/);
  s.listeners.locale({ languages: ['en-US'], preference: 'zh' });
  assert.equal(s.document.documentElement.lang, 'zh-CN');
  assert.equal(s.elements.retry.textContent, '重试');
  s.elements.retry.onclick(); assert.equal(s.elements.retry.disabled, true);
  s.elements.data.onclick(); assert.deepEqual(s.calls, ['retry', 'data']);
  const legacy = startup({ languages: ['en-US'], preference: null, startupLanguage: 'zh' });
  assert.equal(legacy.document.documentElement.lang, 'zh-CN', 'A1 provisional display is separate from accepted preference');
});

test('actual bootstrap language action waits for an accepted Host receipt and never calls optimistic locale.setLocale', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../dsh/bootstrap.js'), 'utf8');
  const begin = source.indexOf("        const t = ctx.locale.bind('naw');");
  const end = source.indexOf('        // The workspace occupies', begin);
  assert.ok(begin >= 0 && end > begin);
  let preference = 'zh', accepted = false;
  const calls = [];
  const ctx = { effect: callback => callback(), locale: { bind: () => (key, params) => locale.format(preference, key, params), subscribe: () => () => {}, getSnapshot: () => ({ active: preference }), setLocale() { throw Error('Optimistic setter must never be called'); } },
    configForms: { get: name => { assert.equal(name, 'locale'); return { getSnapshot: () => ({ value: { preference } }), async set(field, value) { calls.push([field, value]); if (accepted) preference = value; return accepted; } }; } } };
  const helperStart = source.indexOf('    function createDisplayBindings('), helperEnd = source.indexOf('    function mountWorkspace(', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const language = vm.runInNewContext(source.slice(helperStart, helperEnd) + `\n(() => {${source.slice(begin, end)} return language;})()`, { ctx, window: { nativeWorkspaceLocale: locale } });
  await assert.rejects(language.set('en'), /语言未能保存/);
  assert.equal(preference, 'zh');
  assert.equal(language.getSnapshot().active, 'zh');
  accepted = true;
  await language.set('en');
  assert.equal(preference, 'en');
  assert.deepEqual(calls, [['preference', 'en'], ['preference', 'en']]);
});

test('legacy provisional bootstrap survives an unreadable Host and never becomes a write receipt', async t => {
  const s = shell(t);
  s.run("localeProvisional='zh'; startupWindow=createWindow(); acceptLocale({warning:'unavailable'},0)");
  const options = s.run('startupWindow.options');
  const p = preload(options.webPreferences.additionalArguments);
  const pushed = s.sent.at(-1)[1];
  assert.equal(pushed.preference, null, 'The native-shell authority still has no saved choice');
  assert.equal(pushed.startupLanguage, 'zh');
  p.emit('workspace:locale', pushed);
  const initial = await p.exposed.__DSH_LOCALE__.read();
  assert.equal(initial.preference, 'zh', 'Only provisional display initialization retains the verified old language');
  let exported;
  const source = fs.readFileSync(path.join(path.dirname(require.resolve('@deepseek-ai/dsh-client-locale')), 'client.js'), 'utf8');
  const window = { __ModuleLoader__: { load(plugin) { exported = plugin.factory(() => ({})); } } };
  vm.runInNewContext(source, { window, console });
  const host = { getSnapshot: () => ({ value: undefined }), subscribe: () => () => {}, set() { throw Error('Bootstrap must never write'); } };
  const runtime = new exported.LocaleRuntime({ emit() {}, effect: fn => fn() }, host, initial);
  assert.equal(runtime.getSnapshot().active, 'zh');
  assert.equal(p.calls.length, 0);
  assert.equal(s.menu.items.find(item => item.id === 'naw-menu-file').label, '文件');
});

test('startup and native-shell locale dependencies are included in the actual package source list', () => {
  const script = fs.readFileSync(path.join(__dirname, '../../scripts/package-mac.cjs'), 'utf8');
  const begin = script.indexOf('const sources = [') + 'const sources = '.length;
  const end = script.indexOf('];', begin) + 1;
  assert.ok(begin > 0 && end > begin);
  const sources = vm.runInNewContext(script.slice(begin, end));
  for (const name of ['ui-locale-profile.mjs', 'ui-locale.js', 'ui-messages.js']) {
    assert.equal(sources.filter(value => value === name).length, 1, name);
    assert.equal(fs.existsSync(path.join(__dirname, '..', name)), true);
  }
});

test('early startup menu cannot open a workspace or send a new-session event before boot', t => {
  const s = shell(t);
  s.context.effectCount = { windows: 0 };
  s.run('openWindow = () => { effectCount.windows++; }; startupWindow=createWindow(); updateApplicationMenu();');
  const actions = s.menu.items.find(item => item.id === 'naw-menu-file').submenu.items;
  const newWindow = actions.find(item => item.id === 'naw-menu-new-window');
  newWindow.click();
  assert.equal(s.context.effectCount.windows, 0, 'A disabled or stale accelerator must be harmless before startup completes');
  assert.equal(newWindow.enabled, false);
  const newSession = actions.find(item => item.id === 'naw-menu-new-session');
  assert.equal(newSession.enabled, false);
  assert.doesNotThrow(() => newSession.click(), 'Even a direct stale accelerator cannot send to the startup page');
  assert.equal(s.sent.filter(value => value[0] === 'workspace:new').length, 0);
});


test('workspace menu actions become available only after startup and still route to the registered workspace window', t => {
  const s = shell(t);
  s.context.effectCount = { windows: 0 };
  s.run("openWindow=()=>{effectCount.windows++;}; startupWindow=createWindow(); updateApplicationMenu();");
  s.run("wired=true; dataDir='synthetic-profile'; viewStore={loaded:true}; dsh={origin:'http://127.0.0.1:12345'}; entry='http://127.0.0.1:12345/'; starting=false; updateApplicationMenu();");
  const actions = s.menu.items.find(item => item.id === 'naw-menu-file').submenu.items;
  const newWindow = actions.find(item => item.id === 'naw-menu-new-window'), newSession = actions.find(item => item.id === 'naw-menu-new-session');
  assert.equal(newWindow.enabled, false, 'A failed startup page cannot be mistaken for a ready workspace');
  s.run("focusWindow=startupWindow; startupWindow=null; BrowserWindow.getFocusedWindow=()=>focusWindow; windows.set(focusWindow.webContents.id,{win:focusWindow}); updateApplicationMenu();");
  assert.equal(newWindow.enabled, true); assert.equal(newSession.enabled, true);
  newWindow.click(); newSession.click();
  assert.equal(s.context.effectCount.windows, 1);
  assert.equal(s.sent.filter(value => value[0] === 'workspace:new').length, 1);
});
