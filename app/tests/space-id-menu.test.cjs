const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const renderer = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
const { format } = require('../ui-locale.js');
const { RoomState } = require('../room-state.cjs');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-space-id-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, room: new RoomState(dir) };
}

function menuFixture(room, extra = {}) {
  const rooms = [room], menus = [], copies = [], notices = [];
  const anchor = {
    disabled: false, isConnected: true,
    focus() {}, setAttribute() {}, getAttribute() { return 'false'; },
    getBoundingClientRect() { return { left: 10, right: 30, top: 10, bottom: 30 }; },
    getClientRects() { return [{ width: 20, height: 20 }]; },
  };
  const context = vm.createContext({
    spaceId: room.id, selectionRevision: 1, disconnected: false,
    spaceRecord: id => rooms.find(value => value.id === id),
    allSpaces: () => rooms, spaceRows: new Map(), $: () => null,
    roomMenu: null, contentMenu: null, sessionMenu: null,
    state: { wakePolicy: null, operatorPolicy: null },
    uiText: (key, params) => format('zh', key, params),
    ui: { menu: config => { const entry = { config, closed: false }; const close = () => { if (!entry.closed) { entry.closed = true; config.onClose(); } }; entry.close = close; menus.push(entry); return close; } },
    toastMessage: (key, params) => notices.push(format('zh', key, params)),
    attempt: action => action(),
    api: { copy: text => copies.push(text), spaceAction() {}, wakePolicy() {} },
    openSpaceCreate() {}, openSpaceMerge() {}, openMergeRecord() {}, openRename() {}, openNotes() {},
    selectSpace() {}, openSpaceFiles() {}, showTrust() {}, setOperatorEnabled() {}, operatorGlobalMenuItems: () => [], ...extra,
  });
  const start = renderer.indexOf('const roomMenuKey =');
  const end = renderer.indexOf('// Facts refresh in place', start);
  vm.runInContext(renderer.slice(start, end), context);
  context.openRoomMenu(undefined, anchor, room.id);
  return { menus, copies, notices, anchor };
}

test('the space menu shows the short ID and copies the full ID', async () => {
  const room = { id: '308f55b3-1111-2222-3333-444455556666', name: 'Claude room', archived: false };
  const f = menuFixture(room);
  assert.equal(f.menus.length, 1);
  const { config } = f.menus[0];
  assert.equal(config.items[0].id, 'space-id');
  assert.equal(config.items[0].type, 'label');
  assert.equal(config.items[0].text, 'ID 308f55b3');
  assert.equal(config.items[0].labelRead(), 'ID 308f55b3');
  assert.equal(config.items[1].type, 'separator');
  assert.equal(config.items[2].id, 'copy-id');
  assert.equal(config.items[2].label, '复制空间 ID');
  config.onSelect('copy-id');
  assert.deepEqual(f.copies, [room.id]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.notices, ['已复制']);
});

test("the space menu starts a project manager where there is none, opens or revokes the one there is, and closes when that changed", () => {
  const room = { id: '308f55b3-1111-2222-3333-444455556666', name: 'Claude room', archived: false }, calls = [];
  const state = { wakePolicy: null, operatorPolicy: null, spaceManagers: {}, preflight: { claude: true } };
  const extra = { state, api: { spaceManager() {} }, chooseManager: (...args) => calls.push(JSON.parse(JSON.stringify(args))), select: (...args) => calls.push(['select', ...args]) };
  const offered = () => menuFixture(room, extra).menus[0].config;
  const items = config => Array.from(config.items).filter(item => item.id.startsWith('manager-')).map(item => [item.id, item.label]);
  const none = offered();
  assert.deepEqual(items(none), [['manager-create', '新开一个项目经理（Claude）']]);
  none.onSelect('manager-create');
  assert.deepEqual(calls.pop(), [room.id, { create: true }]);
  state.spaceManagers = { [room.id]: { sessionId: 'manager', nativeId: 'native' } };
  none.onSelect('manager-create');
  assert.deepEqual(calls, [], 'the menu was opened before there was one');
  const one = offered();
  assert.deepEqual(items(one), [['manager-open', '打开项目经理'], ['manager-revoke', '撤销项目经理']]);
  one.onSelect('manager-open'); one.onSelect('manager-revoke');
  assert.deepEqual(calls, [['select', 'manager', 'chat'], [room.id, null]]);
  state.spaceManagers = {}; state.preflight = { claude: false };
  assert.deepEqual(items(offered()), [], 'Claude is not on this machine');
});

test('creating or renaming a space to an existing name is rejected', t => {
  const { room } = setup(t);
  const alpha = room.create('Alpha');
  assert.throws(() => room.create('Alpha'), /已经存在名为 Alpha 的协作空间/);
  assert.equal(room.spaces.rooms.length, 1);
  const beta = room.create('Beta');
  assert.throws(() => room.rename('Alpha', beta), /已经存在名为 Alpha 的协作空间/);
  assert.equal(room.metadata(beta).name, 'Beta');
  room.rename('Beta', beta);
  assert.equal(room.metadata(beta).name, 'Beta');
  room.rename('Gamma', beta);
  assert.equal(room.metadata(beta).name, 'Gamma');
  assert.equal(room.metadata(alpha).name, 'Alpha');
});

test('the default space joins the name comparison on create and rename', t => {
  const { room } = setup(t);
  const defaultName = room.value.name;
  assert.throws(() => room.create(defaultName), /已经存在/);
  const a = room.create('A');
  assert.throws(() => room.rename('A'), /已经存在/);
  assert.equal(room.value.name, defaultName);
  room.rename('Home');
  assert.equal(room.value.name, 'Home');
});

test('saving an unchanged name on a historical duplicate is a no-op', t => {
  const { dir, room } = setup(t);
  room.create('Dup');
  const spaces = JSON.parse(fs.readFileSync(room.spacesFile, 'utf8'));
  const duplicate = { ...spaces.rooms[0], id: randomUUID() };
  spaces.rooms.push(duplicate);
  fs.writeFileSync(room.spacesFile, JSON.stringify(spaces), { mode: 0o600 });
  const reloaded = new RoomState(dir);
  assert.equal(reloaded.spaces.rooms.filter(value => value.name === 'Dup').length, 2);
  reloaded.rename('Dup', duplicate.id);
  assert.equal(reloaded.metadata(duplicate.id).name, 'Dup');
});
