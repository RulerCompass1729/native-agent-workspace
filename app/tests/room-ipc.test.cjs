const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
async function desktop(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-room-ipc-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const handlers = new Map(), main = path.join(__dirname, '../main.cjs'), nativeRequire = createRequire(main), noop = () => {};
  const electron = {
    app: { setName: noop, getVersion: () => 'fixture', commandLine: { appendSwitch: noop }, requestSingleInstanceLock: () => false, quit: noop, on: noop, getPath: () => dir },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, dialog: { showMessageBox: async () => ({ response: 1 }) },
    session: { defaultSession: { setPermissionRequestHandler: noop, setPermissionCheckHandler: noop, webRequest: { onBeforeRequest: noop } } }, Menu: { setApplicationMenu: noop, buildFromTemplate: value => value },
  };
  const sandbox = vm.createContext({ require: name => name === 'electron' ? electron : name === './service-client.cjs' ? { ensureService: async () => {} } : name === './dsh-host.cjs' ? { startDsh: async () => ({ origin: 'http://127.0.0.1:10101', url: 'http://127.0.0.1:10101/', stop: noop }) } : nativeRequire(name), __dirname: path.dirname(main), process: { env: {}, execPath: process.execPath }, URL, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(main, 'utf8'), sandbox); vm.runInContext('openWindow = async () => {};', sandbox); await vm.runInContext('boot()', sandbox);
  const state = { sessions: [], room: { messages: [] } }, client = { socket: { destroyed: false }, call: async () => structuredClone(state) };
  sandbox.actor = { client, win: { isDestroyed: () => false, webContents: { send: noop } } };
  vm.runInContext('windows.set(1, actor);', sandbox);
  const invoke = (name, ...args) => { const frame = { url: 'http://127.0.0.1:10101/' }; return handlers.get(`workspace:${name}`)({ sender: { id: 1, mainFrame: frame }, senderFrame: frame }, ...args); };
  return { client, sandbox, invoke, room: () => vm.runInContext('roomState.value', sandbox) };
}
test('real desktop clear handler retains concurrently saved note instead of losing it after delayed daemon acknowledgement', async t => {
  const d = await desktop(t); await d.invoke('roomNotes', 'old', d.room().revision);
  let release, entered; const waiting = new Promise(resolve => { entered = resolve; });
  const call = d.client.call; d.client.call = async (method, ...args) => { if (method === 'clearSharedHistory') { entered(); await new Promise(resolve => { release = resolve; }); return true; } return call(method, ...args); };
  const clearing = d.invoke('clearSharedHistory'); await waiting;
  assert.equal((await d.invoke('roomNotes', 'newer', d.room().revision)).ok, true); release();
  const result = await clearing; assert.equal(result.ok, false); assert.match(result.error, /清除期间更新/); assert.equal(d.room().notes, 'newer');
});
test('closing or disconnected observer does not turn successful metadata write into a failed save', async t => {
  const d = await desktop(t);
  d.sandbox.observer = { win: { isDestroyed: () => false }, client: { socket: { destroyed: false }, call: async () => { throw Error('Observer closed'); } } };
  vm.runInContext('windows.set(2, observer);', d.sandbox);
  assert.equal((await d.invoke('roomRename', 'Saved')).ok, true); assert.equal(d.room().name, 'Saved');
  assert.equal((await d.invoke('roomNotes', 'Saved notes', d.room().revision)).ok, true); assert.equal(d.room().notes, 'Saved notes');
});
