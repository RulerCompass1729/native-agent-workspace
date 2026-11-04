const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { Workspace } = require('../workspace.cjs'), { WorkspaceClient } = require('../workspace-client.cjs');
const { RoomState } = require('../room-state.cjs'), { SessionLabels } = require('../session-labels.cjs');
const locale = require('../ui-locale.js'), { uiError } = require('../ui-errors.cjs');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
function workspaceFixture(t, prepare) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-warning-locale-')); let w;
  t.after(() => { try { w?.close(); } finally { fs.rmSync(folder, { recursive: true, force: true }); } });
  prepare?.(folder); w = new Workspace({ binaries: {}, close() {} }, folder);
  return { folder, w };
}
function clientEntry(key, state) {
  const client = new EventEmitter(), calls = [];
  client.call = async method => { calls.push(method); assert.equal(method, 'initial'); return state; };
  client.close = () => client.emit('closed');
  return { key, client, calls, state: { owner: 'original-view', runtimeVersion: 'synthetic', sessions: [], capabilities: [], room: { revision: 0, messages: [], run: null }, diagnostics: {}, ...state } };
}
function alertFixture(state) {
  let language = 'zh'; const bootstrap = read('dsh/bootstrap.js'), renderer = read('renderer/renderer.js');
  const a = bootstrap.indexOf('    function createDisplayBindings('), b = bootstrap.indexOf('    function mountWorkspace(', a);
  const createBindings = vm.runInNewContext('(' + bootstrap.slice(a, b).trim() + ')');
  const element = { textContent: '', childElementCount: 0, setAttribute() {}, removeAttribute() {} };
  const root = { querySelectorAll: () => [element] }, uiText = (key, params) => locale.format(language, key, params);
  const display = createBindings(uiText), ui = { display, displayText: (raw, message) => locale.displayText(language, raw, message) };
  const start = renderer.indexOf('    const warningText ='), end = renderer.indexOf("    $('reconnect-button')", start); assert.ok(start >= 0 && end > start);
  const paint = () => vm.runInNewContext(renderer.slice(start, end), { state, disconnected: false, ui, uiText, $: id => { assert.equal(id, 'alert'); return element; } });
  paint(); return { element, paint, switch(value) { language = value; display.refresh(root); } };
}

test('real unreadable record producers retain corrupt files while joined warnings and guard errors localize without changing raw state', t => {
  const { folder, w } = workspaceFixture(t, folder => {
    for (const file of ['workspace.json', 'room-state.json', 'session-labels.json']) fs.writeFileSync(path.join(folder, file), '{', { mode: 0o600 });
  });
  const room = new RoomState(folder), labels = new SessionLabels(folder);
  const first = clientEntry('one', w.snapshot()), raw = 'ORIGINAL older/native warning 中文 {body}';
  const other = clientEntry('two', { storageWarning: raw });
  const client = new WorkspaceClient([first, other], 'one', Symbol()); t.after(() => client.close());
  const snapshot = room.apply(labels.apply(client.snapshot()));
  assert.equal(snapshot.storageWarning, w.storageWarning + '\n' + raw);
  const saved = JSON.stringify(snapshot), alert = alertFixture(snapshot);
  alert.switch('en'); assert.ok(alert.element.textContent.startsWith('Local records could not be read.'));
  assert.ok(alert.element.textContent.includes(raw)); assert.ok(alert.element.textContent.includes('Original names and order are shown.'));
  assert.ok(alert.element.textContent.includes('Collaboration data cannot be read yet.'));
  assert.equal(JSON.stringify(snapshot), saved); assert.deepEqual([...first.calls, ...other.calls], []);
  assert.throws(() => room.mergeSources(snapshot, []), error => {
    assert.equal(error.message, snapshot.storageWarning);
    assert.equal(locale.errorText('en', error), 'Local records could not be read. The original file is retained. Check it before saving.\n' + raw); return true;
  });
  alert.switch('zh'); assert.equal(alert.element.textContent, [snapshot.storageWarning, snapshot.sessionNameWarning, snapshot.roomStorageWarning].join(' '));
  w.persist(); for (const file of ['workspace.json', 'room-state.json', 'session-labels.json']) assert.equal(fs.readFileSync(path.join(folder, file), 'utf8'), '{');
});

test('the existing successful write retry clears both warning text and its descriptor without a native action', t => {
  const { folder, w } = workspaceFixture(t), conflict = path.join(folder, 'workspace.json.tmp');
  fs.mkdirSync(conflict); w.persist(); assert.equal(w.storageFailure, 'write');
  assert.ok(w.storageWarningUiMessage); assert.ok(locale.displayText('en', w.storageWarning, w.storageWarningUiMessage).startsWith('The local save failed.'));
  fs.rmdirSync(conflict); assert.equal(w.retrySave(), true);
  assert.equal(w.storageWarning, null); assert.equal(Object.hasOwn(w, 'storageWarningUiMessage'), false);
  assert.equal(w.snapshot().storageWarningUiMessage, null); assert.equal(w.sessions.size, 0); assert.equal(w.versions.dispatches, 0);
});

test('sandbox preload retains original event arguments and forwards optional warning metadata without another channel', () => {
  const callbacks = new Map(), exposed = {};
  vm.runInNewContext(read('preload.cjs'), { process: { argv: [] }, require(name) {
    assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld(key, value) { exposed[key] = value; } }, ipcRenderer: { on(channel, listener) { callbacks.set(channel, listener); }, removeListener() {}, invoke() { throw Error('No IPC action is allowed'); } } };
  } });
  const received = [], warning = uiError('error.warning.viewSave'); exposed.workspace.onViewStorage((...args) => received.push(args));
  callbacks.get('workspace:view-storage')({}, warning.message, warning.uiMessage);
  assert.equal(received[0][0], warning.message); assert.equal(received[0][1], warning.uiMessage);
  callbacks.get('workspace:view-storage')({}, 'ORIGINAL older warning'); assert.deepEqual(received[1], ['ORIGINAL older warning']);
});

test('Main retains its no-duplicate warning receipt and clears optional display metadata on the existing clear event', () => {
  const source = read('main.cjs'), a = source.indexOf('function reportViewStorage('), b = source.indexOf('async function broadcastRoom(', a), calls = [];
  const context = vm.createContext({ windows: new Map([[1, { win: { isDestroyed: () => false, webContents: { send: (...args) => calls.push(args) } } }]]) });
  vm.runInContext('let viewStorageWarning = null, viewStorageWarningUiMessage = null;\n' + source.slice(a, b), context);
  context.notice = uiError('error.warning.viewSave');
  vm.runInContext('reportViewStorage(notice.message, notice.uiMessage); reportViewStorage(notice.message, notice.uiMessage); reportViewStorage(null);', context);
  assert.equal(calls.length, 2); assert.equal(calls[0][1], context.notice.message); assert.equal(calls[0][2], context.notice.uiMessage);
  assert.deepEqual(calls[1], ['workspace:view-storage', null, null]);
});
