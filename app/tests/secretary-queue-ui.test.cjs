const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
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
  const calls = [], menus = [], record = { id: 'secretary-one', nativeId: 'native-one', name: 'Literal <name>', state: 'idle', serviceCapabilities: ['observe'] };
  const state = { sessions: [record], queueSecretary: null };
  const row = { more: new Element('button') };
  const c = vm.createContext({ ...l, state, disconnected: false, node: (tag, text, cls) => new Element(tag, text, cls),
    queueSpace: 'shared', queueMemberName: id => 'Recipient ' + id, queueReasonKey: () => null, queueOutcomeNode: () => null,
    button: (text, action, cls) => { const el = new Element('button', text, cls); el.click = action; return el; },
    api: { queueSecretary: async id => calls.push(['secretary', id]), initial: async () => state, spaceAction: async (...args) => calls.push(args) },
    updateState: () => calls.push(['refresh']), render: () => calls.push(['render']), renderQueue() {},
    allSpaces: () => [], sidebarSessions: () => [record], orderedMembers: () => [record], backendVersionNotice: () => null, sidebarDetails: () => [], sidebarFactsKey: () => '',
    sessionRows: new Map([[record.id, row]]), sessionRow: () => row, contentMenu: null, roomMenu: null, sessionMenu: null, attempt: fn => fn(), focusSessionAction() {},
    ui: { ...l.ui, menu: options => { menus.push(options); return () => {}; } },
  });
  vm.runInContext(section('const uiNode =', 'const states ='), c);
  vm.runInContext(section('function sessionMenuModel(', 'function memberMenuKey('), c);
  vm.runInContext(section('function queueRow(', 'function renderQueue('), c);
  return { c, record, calls, menus, state, l };
}
function descendants(el, cls) { return el.children.flatMap(child => [...(child.className?.split(' ').includes(cls) ? [child] : []), ...descendants(child, cls)]); }
test('the existing session menu can designate, replace and revoke the unique secretary without confirmation', async () => {
  const f = fixture();
  f.c.openSessionMenu(f.record.id);
  let menu = f.menus.at(-1);
  const set = menu.items.find(item => item.id === 'queue-secretary-set');
  assert.equal(set?.label, '设为秘书（可替我加到队列）');
  await menu.onSelect('queue-secretary-set');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, [['secretary', f.record.id], ['refresh'], ['render']]);
  f.state.queueSecretary = { sessionId: f.record.id, nativeId: f.record.nativeId };
  const model = f.c.sessionMenuModel(f.record.id, { more: {} });
  assert.ok(model.items.find(item => item.id === 'queue-secretary-revoke'));
  assert.ok(!model.items.find(item => item.id === 'queue-secretary-set'));
  f.c.openSessionMenu(f.record.id, { x: 0, y: 0 });
  await f.menus.at(-1).onSelect('queue-secretary-revoke');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.at(-3), ['secretary', null]);
  f.state.queueSecretary = { sessionId: 'another-session', nativeId: 'another-native' };
  assert.ok(f.c.sessionMenuModel(f.record.id, {}).items.find(item => item.id === 'queue-secretary-set'));
});
test('secretary rows display the recorded name and full session id as text in the existing task cell', () => {
  const f = fixture(), creator = { kind: 'secretary', name: '<Secretary & 中文>', sessionId: 'secretary-1234-5678-full-id' };
  const row = f.c.queueRow({ id: 'item', text: '<Original task>', status: 'queued', creator }, new Set());
  const body = descendants(row, 'queue-text')[0];
  assert.ok(body.textContent.includes('<Original task>'));
  assert.ok(body.textContent.includes('秘书 <Secretary & 中文>（secretary-1234-5678-full-id）添加'));
  assert.equal(descendants(row, 'queue-creator').length, 1);
  f.l.setLanguage('en'); f.l.ui.display.refresh(row);
  assert.ok(body.textContent.includes('Added by secretary <Secretary & 中文> (secretary-1234-5678-full-id)'));
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

test('the compact session menu and member menu expose the same secretary choice and reject a changed role', async () => {
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
      vm.runInContext(section('function memberMenuKey(', 'function sidebarSessions('), f.c);
      f.c.openMemberMenu(f.record.id, anchor);
    }
    const menu = f.menus.at(-1);
    assert.equal(menu.items.find(item => item.id === 'queue-secretary-set')?.label, '设为秘书（可替我加到队列）');
    await menu.onSelect('queue-secretary-set');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.calls[0], ['secretary', f.record.id]);
    f.calls.length = 0;
    f.state.queueSecretary = { sessionId: f.record.id, nativeId: f.record.nativeId };
    // The open menu was rendered against the earlier role: no stale action may now run.
    if (kind === 'member') f.c.toastMessage = () => {};
    menu.onSelect('queue-secretary-set');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.calls, []);
  }
});

test('unavailable sessions cannot become secretary and disconnected menus cannot execute it', async () => {
  const f = fixture();
  f.record.nativeId = null;
  assert.ok(!f.c.sessionMenuModel(f.record.id, {}).items.some(item => item.id.startsWith('queue-secretary-')));
  f.record.nativeId = 'native-one';
  f.c.disconnected = true;
  const action = f.c.sessionMenuModel(f.record.id, {}).items.find(item => item.id === 'queue-secretary-set');
  assert.equal(action.disabled, true);
  f.c.openSessionMenu(f.record.id);
  f.menus.at(-1).onSelect('queue-secretary-set');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, []);
});

test('disconnected header keeps existing usage control while blocking secretary changes', () => {
  const f = fixture(), anchor = new Element('button'), control = new Element('button');
  control.click = () => f.calls.push(['existing-usage']);
  Object.assign(f.c, { current: () => f.record, selectionRevision: 1, selected: f.record.id, spaceId: 'shared',
    pairRevision: () => 1, disconnected: true, headerControls: { membership: control, selectedText: control, usage: control }, $: () => control });
  vm.runInContext(section('const headerMenuKey =', 'function renderHeaderLayout('), f.c);
  f.c.openHeaderMenu(anchor);
  const menu = f.menus.at(-1);
  assert.equal(menu.items.find(item => item.id === 'queue-secretary-set').disabled, true);
  assert.equal(menu.items.find(item => item.id === 'usage').disabled, false);
  menu.onSelect('queue-secretary-set');
  assert.deepEqual(f.calls, []);
  menu.onSelect('usage');
  assert.deepEqual(f.calls, [['existing-usage']]);
});
