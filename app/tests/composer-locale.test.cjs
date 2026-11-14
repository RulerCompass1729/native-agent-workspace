const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const locale = require('../ui-locale.js'), composer = require('../renderer/session-composer.js');
const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
const bootstrap = fs.readFileSync(path.join(__dirname, '../dsh/bootstrap.js'), 'utf8');
const a = bootstrap.indexOf('    function createDisplayBindings('), b = bootstrap.indexOf('    function mountWorkspace(', a);
assert.ok(a >= 0 && b > a);
const createBindings = vm.runInNewContext('(' + bootstrap.slice(a, b).trim() + ')');

class Element {
  constructor(document, tag = 'div') { this.ownerDocument = document; this.tagName = tag; this.children = []; this.attributes = new Map(); this.listeners = new Map(); this.dataset = {}; this.value = ''; this.content = ''; }
  get childElementCount() { return this.children.length; }
  get textContent() { return this.content; }
  set textContent(value) { this.content = String(value ?? ''); this.children = []; }
  get placeholder() { return this.getAttribute('placeholder') || ''; }
  set placeholder(value) { this.setAttribute('placeholder', value); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  prepend(...children) { for (const child of children) child.parentElement = this; this.children.unshift(...children); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  before(child) { const siblings = this.parentElement.children; child.parentElement = this.parentElement; siblings.splice(siblings.indexOf(this), 0, child); }
  contains(child) { return child === this || this.children.some(value => value.contains(child)); }
  querySelectorAll(selector) { assert.equal(selector, '[data-naw-i18n-bound]'); return this.children.flatMap(child => [...(child.hasAttribute('data-naw-i18n-bound') ? [child] : []), ...child.querySelectorAll(selector)]); }
  addEventListener(name, listener) { const list = this.listeners.get(name) || []; list.push(listener); this.listeners.set(name, list); }
  removeEventListener(name, listener) { this.listeners.set(name, (this.listeners.get(name) || []).filter(fn => fn !== listener)); }
  event(name, properties = {}) { for (const listener of this.listeners.get(name) || []) listener({ preventDefault() {}, ...properties }); }
}
function fixture(overrides = {}) {
  let language = 'zh';
  const actorCalls = [], document = { activeElement: null, createElement(tag) { return new Element(document, tag); } };
  const form = document.createElement('form'), input = document.createElement('textarea'), send = document.createElement('button'), hint = document.createElement('span');
  form.append(input, hint, send); form.querySelector = selector => ({ textarea: input, '.session-send-button': send, '.session-compose-hint': hint })[selector];
  form.requestSubmit = () => actorCalls.push('submit');
  const uiText = (key, params) => locale.format(language, key, params), display = createBindings(uiText);
  const ui = composer.create({ form, nativeText: uiText('composer.nativeInput'), onInput: () => actorCalls.push('input'), onError: () => actorCalls.push('error'),
    onSubmit: () => actorCalls.push('send'), onAction: () => actorCalls.push('action'), onNative: () => actorCalls.push('native'), onImages: () => actorCalls.push('images') });
  input.value = 'UNSENT 中文\n<raw>{name}'; input.selectionStart = 2; input.selectionEnd = 7; document.activeElement = input;
  const record = { id: 'session-A', name: 'RAW 名称', nativeId: 'native-A', owner: 'owner', provider: 'claude', state: 'idle', view: 'chat', liveDraft: input.value, model: 'original-model', permissions: 'unchanged', ...overrides };
  const binding = { id: record.id, ui, changing: false };
  const context = vm.createContext({ uiError: locale.createError, uiText, ui: { display, language: { getSnapshot: () => ({ active: language }) } }, state: { sessions: [record] }, inputRecoveries: new Map(), pendingMode: null,
    owner: 'owner', disconnected: false, focusedRoomMember: () => false, mode: 'chat', nativeUsable: () => true, canResume: value => value.transportDisconnected === true,
    participantLabel: value => value.name });
  const pendingStart = renderer.indexOf('const pendingInterrupts ='), pendingEnd = renderer.indexOf('let shareRevision =', pendingStart);
  vm.runInContext(renderer.slice(pendingStart, pendingEnd), context);
  const decisionStart = renderer.indexOf('function soloAction('), updateEnd = renderer.indexOf('function toast(', decisionStart);
  vm.runInContext(renderer.slice(decisionStart, updateEnd), context);
  const paint = column => context.updateSessionComposer(binding, record, column);
  paint(false);
  return { context, ui, form, input, send, hint, record, binding, document, actorCalls, paint,
    switch(value) { language = value; display.refresh(form); } };
}

test('language-only repaint preserves the actual composer input, IME state, selection, draft and native identity', () => {
  const f = fixture(), original = JSON.stringify(f.record), input = f.input;
  input.event('compositionstart'); assert.equal(f.ui.composing, true);
  const flags = [input.readOnly, f.send.disabled, f.send.type, f.ui.native.hidden];
  f.switch('en');
  assert.equal(f.ui.input, input); assert.equal(input.value, f.record.liveDraft); assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 7);
  assert.equal(f.document.activeElement, input); assert.equal(f.ui.composing, true);
  assert.equal(f.send.textContent, 'Send ↑'); assert.equal(input.placeholder, 'Say what you want to do…');
  assert.equal(input.getAttribute('aria-label'), 'Message to the current agent'); assert.equal(f.hint.textContent, 'Enter to send · Shift Enter for a new line');
  assert.deepEqual([input.readOnly, f.send.disabled, f.send.type, f.ui.native.hidden], flags);
  input.event('keydown', { key: 'Enter', isComposing: true });
  assert.equal(JSON.stringify(f.record), original); assert.deepEqual(f.actorCalls, []);
});

for (const column of [false, true]) test(`an ended rotated segment keeps its handoff notice in the real ${column ? 'column' : 'solo'} composer binding`, () => {
  const f = fixture({ state: 'ended', transportDisconnected: true }), now = Date.now();
  const next = { id: 'next-session', name: 'Successor · 续', state: 'idle' };
  f.context.state.sessions.push(next);
  f.context.state.rotationChains = [{ sessions: [{ id: f.record.id, handedAt: null }, { id: next.id, handedAt: now }] }];
  const node = tag => f.document.createElement(tag);
  Object.assign(f.context, { document: f.document, node,
    uiButton(key, action, cls, params) { const button = node('button'); f.context.ui.display.text(button, key, params); button.addEventListener('click', action); return button; },
    renderDraftRecovery() {}, activateSoloComposer: id => { assert.equal(id, f.record.id); return f.binding; },
  });
  vm.runInContext(renderer.slice(renderer.indexOf('// Only recorded NAW handoffs'), renderer.indexOf('function renderDraftRecovery(')), f.context);
  vm.runInContext(renderer.slice(renderer.indexOf('function sessionChainTime('), renderer.indexOf('function sessionMenuModel(')), f.context);
  // The notice names the successor as people read it (an archived one carries the marker): the production helper.
  vm.runInContext(renderer.slice(renderer.indexOf('function archivedName('), renderer.indexOf('function sessionWindowTitle(')), f.context);
  const paint = () => column ? f.paint(true) : f.context.renderComposer(f.record);
  assert.equal(f.binding.ui.form, f.form, 'session-composer.create exposes the actual input form');
  f.input.event('compositionstart'); paint();
  assert.equal(f.form.children[0], f.binding.chainNotice);
  assert.match(f.binding.chainNotice.children[0].textContent, /已交给「Successor · 续」/);
  assert.equal(f.input.readOnly, true); assert.equal(f.send.type, 'button');
  assert.match(f.send.textContent, /继续原生会话/);
  f.record.messages = [{ role: 'user', time: now + 1, text: 'After handoff' }]; paint();
  assert.match(f.binding.chainNotice.children[0].textContent, /交接后仍有对话/);
  f.switch('en');
  assert.match(f.binding.chainNotice.children[0].textContent, /Conversation after handoff/);
  assert.equal(f.input, f.ui.input); assert.equal(f.input.value, f.record.liveDraft);
  assert.equal(f.input.selectionStart, 2); assert.equal(f.input.selectionEnd, 7);
  assert.equal(f.document.activeElement, f.input); assert.equal(f.ui.composing, true);
  assert.deepEqual(f.actorCalls, []);
});

test('moving from a column to solo clears the earlier recipient aria binding and keeps the same input', () => {
  const f = fixture(), input = f.input;
  f.paint(true); f.switch('en');
  assert.equal(f.send.getAttribute('aria-label'), 'Send ↑: RAW 名称');
  assert.equal(f.input.placeholder, 'Message RAW 名称…'); assert.equal(f.hint.hidden, true);
  f.paint(false); f.switch('zh');
  assert.equal(f.send.hasAttribute('aria-label'), false); assert.equal(f.input, input); assert.equal(f.input.value, f.record.liveDraft);
  assert.equal(f.hint.hidden, false); assert.deepEqual(f.actorCalls, []);
});

for (const [name, overrides, expected] of [
  ['queued', { state: 'working', queueAvailable: true }, 'send'],
  ['pending queue', { state: 'working', pendingQueue: { text: 'CONFIRMED 原文' } }, 'send'],
  ['steering', { state: 'working', steerAvailable: true, activeTurnId: 'original-turn' }, 'send'],
  ['interruption', { interruptPending: true, nativeInputRequired: true }, 'send'],
  ['native input', { nativeInputRequired: true }, 'terminal'],
  ['other owner', { owner: 'other' }, 'claim'],
  ['disconnected', { transportDisconnected: true }, 'resume'],
  ['archived', { archived: true }, 'none'],
]) test('locale cannot change the existing ' + name + ' decision or action guards', () => {
  const f = fixture(overrides), before = JSON.stringify(f.record), input = f.input;
  const kind = () => f.context.soloAction(f.record).kind;
  assert.equal(kind(), expected);
  const flags = [input.readOnly, f.send.disabled, f.send.type, f.ui.native.hidden, f.ui.native.disabled];
  f.switch('en');
  assert.equal(kind(), expected); assert.deepEqual([input.readOnly, f.send.disabled, f.send.type, f.ui.native.hidden, f.ui.native.disabled], flags);
  assert.equal(input.value, f.record.liveDraft); assert.equal(JSON.stringify(f.record), before); assert.deepEqual(f.actorCalls, []);
});

for (const column of [false, true]) for (const [name, record, confirmation] of [
  ['busy without an input route', { state: 'working' }, false],
  ['unconfirmed previous input', { state: 'idle', pendingTag: 'original-input' }, true],
  ['unconfirmed steering', { state: 'working', steerAvailable: true, activeTurnId: 'original-turn', pendingSteer: true }, true],
]) test((column ? 'column' : 'solo') + ' explains why ' + name + ' cannot send and retains the draft', () => {
  const f = fixture(record); f.paint(column);
  const before = JSON.stringify(f.record), input = f.input;
  assert.equal(input.readOnly, false); assert.equal(Boolean(f.send.disabled), true); assert.equal(f.send.type, 'submit');
  assert.match(f.hint.textContent, /不能.*发送/);
  if (confirmation) assert.match(f.hint.textContent, /确认/);
  input.event('keydown', { key: 'Enter' }); assert.deepEqual(f.actorCalls, []);
  input.event('compositionstart'); f.switch('en');
  assert.match(f.hint.textContent, /cannot send/i);
  if (confirmation) assert.match(f.hint.textContent, /confirmation/i);
  assert.equal(f.ui.input, input); assert.equal(input.value, f.record.liveDraft);
  assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 7);
  assert.equal(f.ui.composing, true); assert.equal(Boolean(f.send.disabled), true);
  input.event('keydown', { key: 'Enter', isComposing: true });
  assert.equal(JSON.stringify(f.record), before); assert.deepEqual(f.actorCalls, []);
});

test('busy queue and bound steering keep their usable routes, while an unbound turn remains blocked', () => {
  for (const column of [false, true]) {
    for (const record of [{ state: 'working', queueAvailable: true, pendingTag: 'current-turn' },
      { state: 'working', steerAvailable: true, activeTurnId: 'original-turn' }]) {
      const f = fixture(record); f.paint(column); f.switch('en');
      assert.equal(Boolean(f.send.disabled), false); assert.equal(f.input.readOnly, false);
      assert.doesNotMatch(f.hint.textContent, /cannot send/i);
      f.input.event('keydown', { key: 'Enter' }); assert.deepEqual(f.actorCalls, ['submit']);
    }
    const missing = fixture({ state: 'working', steerAvailable: true }); missing.paint(column); missing.switch('en');
    assert.equal(Boolean(missing.send.disabled), true); assert.match(missing.hint.textContent, /cannot send/i);
    missing.input.event('keydown', { key: 'Enter' }); assert.deepEqual(missing.actorCalls, []);
  }
});

test('empty input, approval, owner and connection reasons retain their existing precedence; the native view adds none', () => {
  const empty = fixture(); empty.input.value = ''; empty.paint(false); empty.switch('en');
  assert.equal(empty.send.disabled, true); assert.equal(empty.hint.textContent, 'Enter to send · Shift Enter for a new line');
  for (const [record, column, hint, readOnly] of [
    [{ state: 'approval', approval: { id: 'original-approval' } }, false, /approval|confirm/i, false],
    [{ state: 'working', owner: 'another-view' }, false, /read-only/i, true],
    [{ state: 'working', transportDisconnected: true }, false, /connection/i, true],
  ]) {
    const f = fixture(record); f.paint(column); f.switch('en');
    assert.match(f.hint.textContent, hint); assert.equal(f.input.readOnly, readOnly);
    f.input.event('keydown', { key: 'Enter' }); assert.deepEqual(f.actorCalls, []);
  }
  // 887d9fea (the person, 2026-11-13: 两边的输入可以不要锁定): a column whose view is on the terminal side shows the
  // conversation box exactly as on the conversation side, with no 启用对话输入 step.
  const onChat = fixture({ state: 'working' }), onTerminal = fixture({ state: 'working', view: 'terminal' });
  for (const f of [onChat, onTerminal]) { f.paint(true); f.switch('en'); }
  assert.equal(onTerminal.hint.textContent, onChat.hint.textContent); assert.doesNotMatch(onTerminal.hint.textContent, /enable input/i);
  assert.equal(onTerminal.input.readOnly, onChat.input.readOnly); assert.equal(Boolean(onTerminal.send.disabled), Boolean(onChat.send.disabled));
});
