const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { RoomState } = require('../room-state.cjs');
const locale = require('../ui-locale.js');
const localeUI = require('./fixtures/locale-ui.cjs');
const source = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
}
class Element {
  constructor(tag, text, cls) { this.tagName = tag; this.content = text ?? ''; this.className = cls || ''; this.children = []; this.dataset = {}; this.attrs = new Map(); this.isConnected = true; }
  append(...children) { this.children.push(...children); for (const child of children) child.parentElement = this; }
  get textContent() { return this.content + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.content = value; this.children = []; }
  setAttribute(k, v) { this.attrs.set(k, v); }
  getAttribute(k) { return this.attrs.get(k) ?? null; }
  hasAttribute(k) { return this.attrs.has(k); }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(selector === '[data-naw-i18n-bound]' && child.hasAttribute('data-naw-i18n-bound') ? [child] : []), ...child.querySelectorAll(selector)]); }
  removeAttribute(k) { this.attrs.delete(k); }
  focus() {}
  getClientRects() { return [1]; }
  getBoundingClientRect() { return { left: 0, right: 20, top: 0, bottom: 20 }; }
  closest() { return null; }
}
function fixture() {
  const l = localeUI();
  const calls = [], menus = [], record = { id: 'manager-one', nativeId: 'native-one', name: 'Literal <name>', state: 'idle', serviceCapabilities: ['observe'], roomIds: ['shared'] };
  const space = { id: 'shared', name: 'Plans' };
  const state = { sessions: [record], spaceManagers: {} };
  const row = { more: new Element('button') };
  const c = vm.createContext({ ...l, state, disconnected: false, node: (tag, text, cls) => new Element(tag, text, cls),
    queueSpace: 'shared', queueMemberName: id => 'Recipient ' + id, queueReasonKey: () => null, queueOutcomeNode: () => null, queueAnswerNode: () => null,
    button: (text, action, cls) => { const el = new Element('button', text, cls); el.click = action; return el; },
    api: { spaceManager: async (roomId, id) => calls.push(['manager', roomId, id]), initial: async () => state, spaceAction: async (...args) => calls.push(args) },
    updateState: () => calls.push(['refresh']), render: () => calls.push(['render']), renderQueue() {},
    allSpaces: () => [], spaceRecord: id => id === 'shared' ? space : null, spaceName: room => room.name, window: { nativeWorkspaceSpaces: { roomIds: record => record.roomIds || [] } }, sidebarSessions: () => [record], orderedMembers: () => [record], backendVersionNotice: () => null, sessionChainModel: () => null, sidebarDetails: () => [], sidebarFactsKey: () => '',
    sessionRows: new Map([[record.id, row]]), sessionRow: () => row, contentMenu: null, roomMenu: null, sessionMenu: null, attempt: fn => fn(), focusSessionAction() {},
    ui: { ...l.ui, menu: options => { menus.push(options); return () => {}; } },
  });
  vm.runInContext(section('const uiNode =', 'const states ='), c);
  vm.runInContext(section('function managedSpace(', 'function hierRole('), c);
  vm.runInContext(section('let operatorSettingBusy =', '// A background operation'), c);
  vm.runInContext(section('function sessionMenuModel(', 'function memberMenuKey('), c);
  vm.runInContext(section('function queueRow(', 'function renderQueue('), c);
  return { c, record, calls, menus, state, space, l };
}
function descendants(el, cls) { return el.children.flatMap(child => [...(child.className?.split(' ').includes(cls) ? [child] : []), ...descendants(child, cls)]); }
const own = record => ({ shared: { sessionId: record.id, nativeId: record.nativeId } });
test('a queued row says why it waits for each member, in both languages, and nothing else from the wait', () => {
  const f = fixture();
  vm.runInContext(section('// Why a queued item has not gone out', '// `items`:'), f.c);
  const row = f.c.queueRow({ id: 'held', text: 'Synthetic task', status: 'queued', wait: [
    { sessionId: 'one', reason: 'person-recent' },
    { sessionId: 'two', reason: 'space-run', readiness: 'not-idle' },
    { sessionId: 'three', reason: 'error.submission.nativeDraft' },
    { reason: 'no-members' },
    { reason: 'private draft must not appear' },
  ] }, new Set());
  const outcome = descendants(row, 'queue-outcome')[0];
  assert.ok(outcome, 'the wait is in the row, not only in the snapshot');
  assert.match(outcome.textContent, /Recipient one · 正在给你最近的操作让路；Recipient two · 正在参与空间协作 · 会话尚未空闲；Recipient three · 原生终端有未发送输入，请先处理；空间没有成员；暂时无法派发/u);
  assert.ok(!row.textContent.includes('private draft'));
  f.l.setLanguage('en'); f.l.ui.display.refresh(row);
  assert.match(outcome.textContent, /Recipient one · Yielding to your recent activity; Recipient two · Taking part in a space collaboration · .+; Recipient three · The native terminal has unsent input; resolve it first; Space has no members; Dispatch is waiting/u);
  assert.ok(!outcome.textContent.includes('private draft'));
  const sent = f.c.queueRow({ id: 'out', text: 'Synthetic task', status: 'sent', wait: [{ reason: 'person-recent' }] }, new Set());
  assert.equal(descendants(sent, 'queue-outcome').length, 0, 'only a queued item says it waits');
});
test("the existing session menu can designate, replace and revoke its space's project manager without confirmation", async () => {
  const f = fixture();
  f.c.openSessionMenu(f.record.id);
  let menu = f.menus.at(-1);
  const set = menu.items.find(item => item.id === 'manager-set');
  assert.equal(set?.label, '设为「Plans」的项目经理');
  await menu.onSelect('manager-set');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, [['manager', 'shared', f.record.id], ['refresh'], ['render']]);
  f.state.spaceManagers = own(f.record);
  const model = f.c.sessionMenuModel(f.record.id, { more: {} });
  assert.equal(model.items.find(item => item.id === 'manager-revoke')?.label, '撤销项目经理');
  assert.ok(!model.items.find(item => item.id === 'manager-set'));
  f.c.openSessionMenu(f.record.id, { x: 0, y: 0 });
  await f.menus.at(-1).onSelect('manager-revoke');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.at(-3), ['manager', 'shared', null]);
  f.state.spaceManagers = { shared: { sessionId: 'another-session', nativeId: 'another-native' } };
  assert.ok(f.c.sessionMenuModel(f.record.id, {}).items.find(item => item.id === 'manager-set'));
});
test('only a member of one open space is offered the role; a manager that left its space still shows the revoke', () => {
  const f = fixture(), items = () => Array.from(f.c.sessionMenuModel(f.record.id, {}).items).filter(item => item.id.startsWith('manager-')).map(item => item.id);
  assert.deepEqual(items(), ['manager-set']);
  for (const change of [{ roomIds: [] }, { roomIds: ['elsewhere'] }, { roomIds: ['shared', 'space-2'] }, { nativeId: null }, { archived: true }]) {
    const saved = { ...f.record }; Object.assign(f.record, change);
    assert.deepEqual(items(), change.roomIds?.length === 2 ? ['manager-set'] : [], JSON.stringify(change));
    for (const name of Object.keys(change)) { if (name in saved) f.record[name] = saved[name]; else delete f.record[name]; }
  }
  f.space.archived = true;
  assert.deepEqual(items(), []);
  f.space.archived = false; f.state.spaceManagers = own(f.record); f.record.roomIds = [];
  assert.deepEqual(items(), ['manager-revoke']);
});
test('rows a project manager added display the recorded name and full session id as text in the existing task cell', () => {
  const f = fixture(), creator = { kind: 'secretary', name: '<Manager & 中文>', sessionId: 'manager-1234-5678-full-id' };
  const row = f.c.queueRow({ id: 'item', text: '<Original task>', status: 'queued', creator }, new Set());
  const body = descendants(row, 'queue-text')[0];
  assert.ok(body.textContent.includes('<Original task>'));
  assert.ok(body.textContent.includes('项目经理 <Manager & 中文>（manager-1234-5678-full-id）添加'));
  assert.equal(descendants(row, 'queue-creator').length, 1);
  f.l.setLanguage('en'); f.l.ui.display.refresh(row);
  assert.ok(body.textContent.includes('Added by project manager <Manager & 中文> (manager-1234-5678-full-id)'));
  assert.ok(body.textContent.includes('<Original task>'));
});
test('person and legacy rows distinguish recorded human input from an unknown historical source', () => {
  const f = fixture();
  const human = f.c.queueRow({ id: 'human', text: 'Task', status: 'queued', creator: { kind: 'person', name: 'You', sessionId: null } }, new Set());
  const legacy = f.c.queueRow({ id: 'legacy', text: 'Old task', status: 'queued' }, new Set());
  assert.equal(descendants(human, 'queue-creator')[0]?.textContent, '你添加');
  assert.equal(descendants(legacy, 'queue-creator')[0]?.textContent, '来源未记录');
});
test('only a still-queued row offers cancellation; a waiting row retains the person\'s handled action', () => {
  const f = fixture();
  const actions = status => descendants(f.c.queueRow({ id: status, text: 'Task', status }, new Set()), 'queue-actions')[0].children.map(x => x.textContent);
  assert.deepEqual(actions('queued'), ['取消']);
  assert.deepEqual(actions('waiting'), ['已处理']);
  for (const status of ['sent', 'done', 'cancelled', 'failed']) assert.deepEqual(actions(status), []);
  for (const lang of ['zh', 'en']) assert.match(locale.format(lang, 'queue.dispatchHelp'), /10/);
});

// Follow-up 4 (11-12): only a decision asks the person to decide; an item the person stepped into, or whose turn
// came back empty, is left for them to look at while its member goes on. The 已处理 button stays on both.
test('a waiting row says 「等你决定」 only for a decision; with a reason it is left for the person to look at', () => {
  const f = fixture();
  const queueRow = item => f.c.queueRow({ id: item.reason || 'decision', text: 'Task', status: 'waiting', sentTo: 'member', ...item }, new Set());
  const status = row => descendants(row, 'queue-status')[0].textContent;
  const decision = queueRow({});
  assert.equal(status(decision), '等你决定 · Recipient member');
  // A decision on an item refused once before it was sent still asks for a decision. The item is made that way in a
  // real RoomState: queueRequeue stores the refusal's reason, queueMarkSent drops it once the item is sent, and
  // queueSettle writes only a non-empty reason. One saved by an older build, which kept the reason through the
  // send, still carries it; it asks for a decision too.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-queue-row-'));
  try {
    const rooms = new RoomState(dir), id = rooms.queueAdd('Task', null);
    rooms.queueMarkSent('shared', id, 'member', 'Member', Date.now());
    rooms.queueRequeue('shared', id, 'Native send refused: session busy', 5, 'Member');
    rooms.queueMarkSent('shared', id, 'member', 'Member', Date.now());
    rooms.queueSettle('shared', id, 'waiting', '', 'Member', '需要你决定：Proceed?');
    const stored = rooms.queueFind('shared', id);
    assert.equal(stored.reason, undefined);
    assert.equal(rooms.metadata().events.at(-1).uiMessage.key, 'notice.queue.waiting');
    for (const item of [stored, { ...stored, reason: 'Native send refused: session busy' }]) {
      assert.equal(status(f.c.queueRow(item, new Set())), '等你决定 · Recipient member', item.reason);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const reason of ['person-intervened', 'no-reply']) {
    const row = queueRow({ reason });
    assert.equal(status(row), '留给你看一眼 · Recipient member', reason);
    assert.deepEqual(descendants(row, 'queue-actions')[0].children.map(x => x.textContent), ['已处理']);
    f.l.setLanguage('en'); f.l.ui.display.refresh(row);
    assert.equal(status(row), 'For you to look at · Recipient member', reason);
    f.l.setLanguage('zh'); f.l.ui.display.refresh(row);
  }
  f.l.setLanguage('en'); f.l.ui.display.refresh(decision);
  assert.equal(status(decision), 'Needs your decision · Recipient member');
});

test('the compact session menu and member menu expose the same project manager choice and reject a changed role', async () => {
  for (const kind of ['header', 'member']) {
    const f = fixture(), anchor = new Element('button');
    const control = new Element('button'); control.click = () => f.calls.push(['original']);
    Object.assign(f.c, { current: () => f.record, selectionRevision: 1, selected: kind === 'member' ? 'room' : f.record.id, spaceId: 'shared',
      pairRevision: () => 1, members: () => f.state.sessions, roomSurface: 'overview', roomSession: '', columnTerminalBinding: () => null,
      headerControls: { membership: control, selectedText: control, usage: control }, $: () => control,
    });
    f.state.room = { archived: false };
    if (kind === 'header') {
      vm.runInContext(section('const headerMenuKey =', 'function renderHeaderLayout('), f.c);
      f.c.openHeaderMenu(anchor);
    } else {
      vm.runInContext(section('function listedSpaceManager(', 'function openSidebarRow('), f.c);
      vm.runInContext(section('function memberMenuKey(', 'function sidebarSessions('), f.c);
      f.c.openMemberMenu(f.record.id, anchor);
    }
    const menu = f.menus.at(-1);
    assert.equal(menu.items.find(item => item.id === 'manager-set')?.label, '设为「Plans」的项目经理');
    await menu.onSelect('manager-set');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.calls[0], ['manager', 'shared', f.record.id]);
    f.calls.length = 0;
    f.state.spaceManagers = own(f.record);
    // The open menu was rendered against the earlier role: no stale action may now run.
    if (kind === 'member') f.c.toastMessage = () => {};
    menu.onSelect('manager-set');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.calls, []);
  }
});

test('unavailable sessions cannot become project manager and disconnected menus cannot execute it', async () => {
  const f = fixture();
  f.record.nativeId = null;
  assert.ok(!f.c.sessionMenuModel(f.record.id, {}).items.some(item => item.id.startsWith('manager-')));
  f.record.nativeId = 'native-one';
  f.c.disconnected = true;
  const action = f.c.sessionMenuModel(f.record.id, {}).items.find(item => item.id === 'manager-set');
  assert.equal(action.disabled, true);
  f.c.openSessionMenu(f.record.id);
  f.menus.at(-1).onSelect('manager-set');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, []);
});

test('disconnected header keeps existing usage control while blocking project manager changes', () => {
  const f = fixture(), anchor = new Element('button'), control = new Element('button');
  control.click = () => f.calls.push(['existing-usage']);
  Object.assign(f.c, { current: () => f.record, selectionRevision: 1, selected: f.record.id, spaceId: 'shared',
    pairRevision: () => 1, disconnected: true, headerControls: { membership: control, selectedText: control, usage: control }, $: () => control });
  vm.runInContext(section('const headerMenuKey =', 'function renderHeaderLayout('), f.c);
  f.c.openHeaderMenu(anchor);
  const menu = f.menus.at(-1);
  assert.equal(menu.items.find(item => item.id === 'manager-set').disabled, true);
  assert.equal(menu.items.find(item => item.id === 'usage').disabled, false);
  menu.onSelect('manager-set');
  assert.deepEqual(f.calls, []);
  menu.onSelect('usage');
  assert.deepEqual(f.calls, [['existing-usage']]);
});

// B6: the integrator designation uses the same menus. Synthetic sessions; no entry is called for real.
const INTEGRATOR_SET = '设为集成者（把交上来的活合进主线）';
const tick = () => new Promise(resolve => setImmediate(resolve));
function integratorFixture() {
  const f = fixture();
  f.record.roomIds = [];
  f.c.api.integrator = async id => f.calls.push(['integrator', id]);
  // The model's arrays belong to the page's own context: copy them before comparing.
  f.actions = () => Array.from(f.c.sessionMenuModel(f.record.id, {}).items).filter(item => !item.type);
  return f;
}
test('the session menu offers the integrator designation only outside every space, and the revoke where it is set', async () => {
  const f = integratorFixture();
  // Before rename, with its words in both languages; the project manager is a member's role, so it is not offered here.
  assert.deepEqual(f.actions().slice(0, 2).map(item => item.id), ['integrator-set', 'rename']);
  assert.equal(f.actions()[0].label, INTEGRATOR_SET);
  assert.equal(locale.format('en', 'menu.integratorSet'), 'Use as integrator (merges delivered work)');
  f.c.openSessionMenu(f.record.id);
  await f.menus.at(-1).onSelect('integrator-set'); await tick();
  assert.deepEqual(f.calls, [['integrator', f.record.id], ['refresh'], ['render']]);
  // A member of a space, a session without a native id, and an archived one are not offered it.
  for (const change of [{ roomIds: ['shared'] }, { roomIds: ['shared', 'space-2'] }, { nativeId: null }, { archived: true }]) {
    const saved = { ...f.record }; Object.assign(f.record, change);
    assert.ok(!f.actions().some(item => item.id.startsWith('integrator-')), JSON.stringify(change));
    for (const name of Object.keys(change)) { if (name in saved) f.record[name] = saved[name]; else delete f.record[name]; }
  }
  // The designated session shows the revoke, also after it was put into a space: the person can always take it back.
  f.state.integrator = { sessionId: f.record.id, nativeId: f.record.nativeId };
  for (const roomIds of [[], ['shared']]) {
    f.record.roomIds = roomIds;
    assert.deepEqual(f.actions().filter(item => item.id.startsWith('integrator-')).map(item => [item.id, item.label]), [['integrator-revoke', '撤销集成者']], JSON.stringify(roomIds));
  }
  f.calls.length = 0; f.c.openSessionMenu(f.record.id, { x: 0, y: 0 });
  await f.menus.at(-1).onSelect('integrator-revoke'); await tick();
  assert.deepEqual(f.calls, [['integrator', null], ['refresh'], ['render']]);
  // Another session holds the designation: this one, outside every space, can take it over.
  f.record.roomIds = []; f.state.integrator = { sessionId: 'another-session', nativeId: 'another-native' };
  assert.ok(f.actions().some(item => item.id === 'integrator-set'));
  // A menu opened while this session was the integrator must not revoke the session designated since.
  f.state.integrator = { sessionId: f.record.id, nativeId: f.record.nativeId };
  f.c.openSessionMenu(f.record.id, { x: 1, y: 1 });
  const stale = f.menus.at(-1);
  f.state.integrator = { sessionId: 'another-session', nativeId: 'another-native' };
  f.calls.length = 0; await stale.onSelect('integrator-revoke'); await tick();
  assert.deepEqual(f.calls, []);
  // An app whose window has no such entry shows the menu as it was.
  delete f.c.api.integrator;
  assert.ok(!f.actions().some(item => item.id.startsWith('integrator-')));
});

test('a disconnected menu shows the integrator action disabled and does not run it', async () => {
  const f = integratorFixture();
  f.c.disconnected = true;
  assert.equal(f.actions().find(item => item.id === 'integrator-set').disabled, true);
  f.c.openSessionMenu(f.record.id);
  f.menus.at(-1).onSelect('integrator-set'); await tick();
  assert.deepEqual(f.calls, []);
});

test('the header menu carries the integrator action, ignores a changed designation, and the terminal menu does not carry it', async () => {
  const f = integratorFixture(), anchor = new Element('button'), control = new Element('button');
  control.click = () => f.calls.push(['original']);
  Object.assign(f.c, { current: () => f.record, selectionRevision: 1, selected: f.record.id, spaceId: 'shared', pairRevision: () => 1,
    headerControls: { membership: control, selectedText: control, usage: control }, $: () => control });
  vm.runInContext(section('const headerMenuKey =', 'function renderHeaderLayout('), f.c);
  f.c.openHeaderMenu(anchor);
  const menu = f.menus.at(-1);
  assert.equal(menu.items.find(item => item.id === 'integrator-set')?.label, INTEGRATOR_SET);
  assert.equal(menu.items.find(item => item.id === 'integrator-set').disabled, false);
  await menu.onSelect('integrator-set'); await tick();
  assert.deepEqual(f.calls[0], ['integrator', f.record.id]);
  // The designation changed while the menu was open: what it shows is no longer true, so it does nothing.
  f.calls.length = 0; f.state.integrator = { sessionId: 'another-session', nativeId: 'another-native' };
  menu.onSelect('integrator-set'); await tick();
  assert.deepEqual(f.calls, []);
  // Designated: the header revokes. Archived and designated: still revocable.
  f.state.integrator = { sessionId: f.record.id, nativeId: f.record.nativeId };
  for (const archived of [false, true]) {
    f.record.archived = archived; f.calls.length = 0;
    f.c.openHeaderMenu(new Element('button'));
    const open = f.menus.at(-1);
    assert.ok(open.items.some(item => item.id === 'integrator-revoke') && !open.items.some(item => item.id === 'integrator-set'), String(archived));
    await open.onSelect('integrator-revoke'); await tick();
    assert.deepEqual(f.calls[0], ['integrator', null], String(archived));
  }
  f.record.archived = false;
  // The terminal's own menu is about the terminal display only.
  f.c.openHeaderMenu(new Element('button'), true);
  assert.ok(!f.menus.at(-1).items.some(item => item.id.startsWith('integrator-')));
  // Disconnected: shown disabled, not run.
  f.c.disconnected = true; f.calls.length = 0;
  f.c.openHeaderMenu(new Element('button'));
  const offline = f.menus.at(-1);
  assert.equal(offline.items.find(item => item.id === 'integrator-revoke').disabled, true);
  offline.onSelect('integrator-revoke'); await tick();
  assert.deepEqual(f.calls, []);
});

test('a session grant is not presented as enabled while the global operator switch is off', async () => {
  const f = fixture(); Object.assign(f.record, { provider: 'claude', operatorEnabled: true, serviceCapabilities: ['operatorControl1a'] });
  f.state.operatorPolicy = { enabled: false }; const calls=[];
  f.c.setOperatorEnabled = async (...args) => calls.push(args);
  const model = f.c.sessionMenuModel(f.record.id, {});
  const action = model.items.find(item => item.id === 'operator-enable-global');
  assert.ok(action, 'the menu points to the missing global prerequisite');
  assert.equal(action.label, '全局未开，点此启用控制接口');
  assert.equal(model.items.some(item => item.label === '撤销此会话的控制授权'), false);
  assert.ok(model.items.some(item => item.id === 'operator-session-revoke'), 'local revocation remains available without enabling global control');
  f.l.setLanguage('en'); assert.equal(f.c.sessionMenuModel(f.record.id, {}).items.find(item => item.id === 'operator-enable-global').label, 'Global control is off — enable it');
  f.c.openSessionMenu(f.record.id); f.state.operatorPolicy.enabled = true;
  await f.menus.at(-1).onSelect('operator-enable-global'); assert.deepEqual(calls, [[null,true]], 'a stale menu cannot revoke the session instead');
  assert.equal(f.c.sessionMenuModel(f.record.id, {}).items.find(item => item.id === 'operator-session').label, 'Revoke this session’s control authorization');
});

test('operator global status is an inert counted row and disabling is a separate action',()=>{
 const f=fixture();Object.assign(f.record,{provider:'claude',serviceCapabilities:['operatorControl1a'],operatorEnabled:true});
 f.state.operatorPolicy={enabled:true,backends:[{key:'.',enabled:true,available:true},{key:'backends/abcdef',enabled:true,available:true}]};
 let items=f.c.sessionMenuModel(f.record.id,{}).items;
 assert.equal(items.find(x=>x.id==='operator-global-status')?.type,'label');assert.equal(items.find(x=>x.id==='operator-global-status')?.text,'已启用 agent 控制接口 · 2/2 后台');
 assert.ok(items.find(x=>x.id==='operator-disable-global'));assert.equal(items.find(x=>x.id==='operator-global-status').label,undefined);
 f.state.operatorPolicy.enabled=false;f.state.operatorPolicy.backends[1].enabled=false;
 items=f.c.sessionMenuModel(f.record.id,{}).items;
 assert.equal(items.find(x=>x.id==='operator-global-status').text,'控制接口部分启用 · 1/2 后台');
 assert.ok(items.some(x=>x.type==='label'&&x.text.includes('abcdef')));assert.ok(items.some(x=>x.id==='operator-enable-global'));
});
