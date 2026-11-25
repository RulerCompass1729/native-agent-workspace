// 「现在就换」 (R207) in the windows: the row above the composer (or the terminal) and the menu items.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const localeUI = require('./fixtures/locale-ui.cjs');
const locale = require('../ui-locale.js');
const source = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
const styles = fs.readFileSync(require.resolve('../renderer/styles.css'), 'utf8');

function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
}

const plain = value => JSON.parse(JSON.stringify(value));

class Element {
  constructor(document, tag, text = '', cls = '') {
    this.document = document;
    this.tagName = tag;
    this.content = text;
    this.className = cls;
    this.children = [];
    this.dataset = {};
    this.attrs = new Map();
    this.listeners = [];
  }
  get textContent() { return this.content + this.children.map(child => child.textContent).join(''); }
  set textContent(text) { this.replaceChildren(); this.content = String(text ?? ''); }
  get isConnected() { return this.root === true || Boolean(this.parentElement?.isConnected); }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  hasAttribute(name) { return this.attrs.has(name); }
  removeAttribute(name) { this.attrs.delete(name); }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  insert(index, nodes) {
    for (const node of nodes) node.remove();
    for (const node of nodes) node.parentElement = this;
    this.children.splice(index, 0, ...nodes);
  }
  append(...nodes) { this.insert(this.children.length, nodes); }
  prepend(...nodes) { this.insert(0, nodes); }
  before(...nodes) { this.parentElement.insert(this.parentElement.children.indexOf(this), nodes); }
  remove() {
    if (!this.parentElement) return;
    if (this.contains(this.document.activeElement)) this.document.activeElement = null;
    this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.content = ''; this.append(...nodes); }
  querySelectorAll(selector) {
    assert.equal(selector, '[data-naw-i18n-bound]');
    return this.children.flatMap(child => [...(child.hasAttribute('data-naw-i18n-bound') ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  addEventListener(type, listener, capture = false) { this.listeners.push({ type, listener, capture }); }
  async click(detail = 1) {
    if (this.disabled) return;
    let stopped = false;
    const event = { detail, stopImmediatePropagation() { stopped = true; } };
    for (const capture of [true, false]) {
      for (const item of this.listeners.filter(l => l.type === 'click' && l.capture === capture)) {
        if (!stopped) await item.listener(event);
      }
    }
  }
  focus() { if (this.isConnected && !this.disabled) this.document.activeElement = this; }
  closest() { return null; }
  getClientRects() { return [1]; }
  getBoundingClientRect() { return { left: 0, right: 20, top: 0, bottom: 20 }; }
}

const OLD = { id: 'old', name: 'Old one', nativeId: 'native-old', provider: 'claude', state: 'idle', messages: [], roomIds: [] };
const NEXT = { id: 'new', name: 'Old one · 续', nativeId: 'native-new', provider: 'claude', state: 'idle', messages: [], roomIds: [] };
const AT = Date.UTC(2026, 10, 26, 5, 34);

function fixture({ row, chain = null, records = [{ ...OLD }, { ...NEXT }] } = {}) {
  const l = localeUI(), document = { activeElement: null }, calls = [], menus = [], toasts = [];
  const node = (tag, text, cls) => new Element(document, tag, text ?? '', cls ?? '');
  const root = node('div');
  root.root = true;
  const state = { sessions: records, sessionRotations: row ? { old: row } : {}, rotationChains: [], appVersion: '0.1.0', capabilities: [] };
  const c = vm.createContext({
    ...l, document, node, state, disconnected: false, $: () => root, backendVersionNotice: () => null,
    archivedName: (record, name) => record?.archived ? l.uiText('archive.marker') + name : name,
    sessionChainModel: id => chain?.sessions.some(link => link.id === id) ? chain : null,
    openSessionChainSegment: id => calls.push(['go', id]), updateSessionBackend: id => calls.push(['update', id]),
    sessionChainTime: String, attempt: async action => { try { return await action(); } catch (error) { toasts.push(error.message); } },
    api: { sessionRotation: async (...args) => { calls.push(['rotation', ...args]); }, initial: async () => state },
    updateState: () => calls.push(['state']), render: () => calls.push(['render']),
    ui: { ...l.ui, menu: options => { menus.push(options); return () => {}; } },
  });
  vm.runInContext(section('const button = (text', 'const states ='), c);
  vm.runInContext(section('// 「现在就换」 (R207)', 'function sessionMenuModel('), c);
  vm.runInContext(section('function backendUpdateAction(', 'async function releaseSessionRotation('), c);
  vm.runInContext(section('// 「现在就换会话」 / 「撤销换会话」', '// A space\'s project manager is one of its members'), c);
  const form = node('form');
  root.append(form);
  return { c, l, state, root, form, node, calls, menus, toasts, document, record: records[0], binding: { ui: { form } },
    paint() { c.renderSessionHandoff(this.binding, this.record); return this.binding.chainNotice; },
    language(value) { l.setLanguage(value); l.ui.display.refresh(root); },
  };
}

const next = { id: 'new', name: 'Old one · 续' };
// [row, zh, en, buttons, the person's own step ends it]
const STATES = {
  who: [{ state: 'due', gate: 'person-quiet', at: AT, now: true }, '换会话：等你停一会儿，最早 {time}', 'Rotation: waiting for you to pause, earliest {time}', ['now']],
  turn: [{ state: 'due', gate: 'busy', now: true }, '换会话：等这一轮结束', 'Rotation: waiting for this turn to end', ['now']],
  turnAsked: [{ state: 'requested', gate: 'not-idle', undo: true }, '换会话：这一轮结束就换', 'Rotation: rotates when this turn ends', ['undo']],
  writing: [{ state: 'writing', undo: true }, '换会话：正在写交接', 'Rotation: writing the handoff', ['undo']],
  taking: [{ state: 'taking' }, '换会话：新会话在接手', 'Rotation: the new session is taking over', []],
  takingButler: [{ state: 'taking', butler: true }, '换会话：新会话在接手，换完后它是大管家', 'Rotation: the new session is taking over; it will be the butler', []],
  handed: [{ state: 'handed', gate: 'person-quiet', at: AT, next, now: true }, '这段已交给「Old one · 续」 · 等你停一会儿，最早 {time}',
    'This segment was handed over to “Old one · 续” · waiting for you to pause, earliest {time}', ['now', 'go']],
  handedButler: [{ state: 'handed', gate: 'person-quiet', at: AT, next, now: true, butler: true }, '这段已交给「Old one · 续」，换完后它是大管家 · 等你停一会儿，最早 {time}',
    'This segment was handed over to “Old one · 续”, which will be the butler · waiting for you to pause, earliest {time}', ['now', 'go']],
  draft: [{ state: 'requested', gate: 'person-typing', undo: true }, '换会话：有没发出的草稿，发出或清空后换', 'Rotation: unsent draft; send or clear it first', ['undo'], true],
  background: [{ state: 'requested', gate: 'background-work', undo: true }, '换会话：后台命令在跑，结束后换', 'Rotation: background command running; rotates when it ends', ['undo']],
  team: [{ state: 'due', gate: 'team-running', now: true }, '换会话：队友在运行，结束后换', 'Rotation: teammates running; rotates when they end', ['now']],
  decisions: [{ state: 'requested', gate: 'decisions-stay', undo: true }, '换会话：待你决定的事项带不下，答几条后换', 'Rotation: too many open decisions to carry; answer some first', ['undo'], true],
  mode: [{ state: 'requested', gate: 'permission-mode', undo: true }, '换会话：权限模式带不过去，改回默认模式后换', 'Rotation: permission mode can’t carry over; set it to default first', ['undo'], true],
  model: [{ state: 'requested', gate: 'model-unknown', undo: true }, '换会话：还不知道它的模型，跑一轮后换', 'Rotation: model not known yet; run a turn first', ['undo'], true],
  spaces: [{ state: 'requested', gate: 'several-spaces', undo: true }, '换会话：它在两个空间里，留下一个后换', 'Rotation: it is in two spaces; leave one first', ['undo'], true],
  old: [{ state: 'requested', gate: 'backend-cannot-carry-settings', undo: true }, '换会话：后台太旧，带不了模型和设置', 'Rotation: backend too old to carry model and settings', ['update', 'undo'], true],
  slot: [{ state: 'requested', gate: 'no-slot', undo: true }, '换会话：另一个会话在换，轮到后开始', 'Rotation: another session is rotating; this one starts in its turn', ['undo']],
};
const WORDS = {
  now: ['现在就换', 'Rotate now'], undo: ['撤销', 'Undo'], go: ['前往「Old one · 续」', 'Go to “Old one · 续”'],
  update: ['结束并更新这个后台…', null],
};

for (const [name, [row, zh, en, buttons, blocked]] of Object.entries(STATES)) {
  test(`R207: the row of a session in the state "${name}", in both languages`, () => {
    const f = fixture({ row });
    f.c.backendVersionNotice = () => ({ kind: 'old' });
    const notice = f.paint(), [line, ...shown] = notice.children;
    const time = language => new Date(AT).toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit' });
    assert.equal(f.form.children[0], notice);
    assert.equal(notice.hidden, false);
    assert.equal(line.getAttribute('role'), 'status');
    assert.equal(line.textContent, zh.replace('{time}', time('zh')));
    assert.deepEqual(shown.map(button => button.textContent), buttons.map(id => WORDS[id][0]));
    assert.equal(notice.className.split(' ').includes('rotation-blocked'), blocked === true);
    f.language('en');
    assert.equal(line.textContent, en.replace('{time}', time('en')));
    assert.deepEqual(shown.map(button => button.textContent), buttons.map(id => WORDS[id][1] ?? locale.format('en', 'menu.updateThisBackend')));
  });
}

test('R207: every gate a rotation can wait at has words, and the gate of nothing of its own has no row', () => {
  const groups = {
    turn: ['not-idle', 'busy', 'sent-item-open', 'send-unconfirmed', 'previous-item', 'took-item', 'settling', 'turn-running', 'space-run'], goal: ['native-goal-active'],
    draft: ['person-typing', 'terminal-input'], background: ['background-work'], team: ['team-running'], decisions: ['decisions-stay'],
    model: ['model-unknown', 'waiting-model'], spaces: ['several-spaces'], old: ['backend-cannot-carry-settings', 'backend-update-needed'], slot: ['no-slot'], mode: ['permission-mode'],
  };
  const said = (gate, state) => {
    const f = fixture({ row: { state, gate, ...(state === 'due' ? { now: true } : { undo: true }) } }), notice = f.paint();
    return notice && !notice.hidden ? notice.children[0].textContent : null;
  };
  const line = key => locale.format('zh', 'rotation.row', { line: locale.format('zh', key) });
  for (const [wait, gates] of Object.entries(groups)) {
    for (const gate of gates) {
      assert.equal(said(gate, 'requested'), line('rotation.wait.' + (wait === 'turn' ? 'turnAsked' : wait)), gate);
      if (gate !== 'space-run') assert.equal(said(gate, 'due'), line('rotation.wait.' + wait), gate);
    }
  }
  const own = { 'collaboration-mode': 'notice.rotation.cause.mode', 'spaces-unreadable': 'notice.rotation.cause.spaces' };
  for (const [gate, key] of Object.entries(own)) {
    assert.equal(said(gate, 'requested'), line(key), gate);
    assert.equal(said(gate, 'due'), line(key), gate);
  }
  const held = {
    'handoff-request-not-sent': 'notice.rotation.cause.handoffRequest', paused: 'stewardWake.reason.paused', unavailable: 'stewardWake.reason.unavailable',
    'automatic-messages-off': 'stewardWake.reason.automatic-messages-off', 'quiet-window': 'stewardWake.reason.quiet-window', missing: 'stewardWake.reason.missing',
    'background-unconfirmed': 'stewardWake.reason.background-unconfirmed', 'native-terminal-dialog': 'stewardWake.reason.native-terminal-dialog',
    'rotation-control-unresolved': 'stewardWake.reason.rotation-control-unresolved', 'trust-hold': 'stewardWake.reason.trust-hold', 'trust-unknown': 'stewardWake.reason.trust-unknown',
    'usage-limit-exceeded': 'stewardWake.reason.usage-limit-exceeded', 'waiting-provider': 'stewardWake.reason.waiting-provider', toString: 'notice.rotation.cause.notReady',
  };
  for (const [gate, key] of Object.entries(held)) {
    assert.equal(said(gate, 'requested'), line(key), gate);
    assert.equal(said(gate, 'due'), null, gate);
  }
});

const rowLine = key => locale.format('zh', 'rotation.row', { line: locale.format('zh', key) });
test('R207: a handoff being written says what holds it, and only that', () => {
  for (const [gate, key] of [['not-idle', 'rotation.writing'], ['busy', 'rotation.writing'], ['background-work', 'rotation.wait.background'], ['person-typing', 'rotation.wait.draft'],
    ['paused', 'stewardWake.reason.paused'], ['automatic-messages-off', 'stewardWake.reason.automatic-messages-off'], ['native-goal-active', 'rotation.wait.goal']]) {
    const f = fixture({ row: { state: 'writing', gate, undo: true } });
    assert.equal(f.paint().children[0].textContent, rowLine(key), gate);
    assert.equal(f.binding.chainNotice.children[1].textContent, '撤销', gate);
  }
  for (const [state, key] of [['working', 'rotation.writing'], ['starting', 'rotation.writing'], ['approval', 'rotation.wait.answer'], ['error', 'rotation.wait.error'], ['disconnected', 'rotation.wait.disconnected']]) {
    const f = fixture({ row: { state: 'writing', undo: true } });
    f.record.state = state;
    assert.equal(f.paint().children[0].textContent, rowLine(key), state);
    assert.equal(f.binding.chainNotice.className.includes('rotation-blocked'), state === 'approval', state);
  }
});

test('R207: a session that is not idle or not free says its turn, its question, or that it is not there', () => {
  const cases = [
    [{ state: 'working' }, 'rotation.wait.turnAsked', 'rotation.wait.turn', false], [{ state: 'starting' }, 'rotation.wait.turnAsked', 'rotation.wait.turn', false],
    [{ state: 'idle', pendingTag: 'x' }, 'rotation.wait.turnAsked', 'rotation.wait.turn', false],
    [{ state: 'approval' }, 'rotation.wait.answer', 'rotation.wait.answer', true], [{ state: 'working', approval: { id: 1 } }, 'rotation.wait.answer', 'rotation.wait.answer', true],
    [{ state: 'idle', claudeQuestion: { pending: 1 } }, 'rotation.wait.answer', 'rotation.wait.answer', true],
    [{ state: 'idle', nativeInputRequired: true }, 'rotation.wait.answer', 'rotation.wait.answer', true],
    [{ state: 'error' }, 'rotation.wait.error', 'rotation.wait.error', false], [{ state: 'disconnected' }, 'rotation.wait.disconnected', 'rotation.wait.disconnected', false],
    [{ state: 'stopping' }, 'stewardWake.reason.unavailable', 'stewardWake.reason.unavailable', false],
  ];
  for (const [fields, asked, due, red] of cases) {
    for (const gate of ['not-idle', 'busy']) {
      for (const [row, key] of [[{ state: 'requested', gate, undo: true }, asked], [{ state: 'due', gate, now: true }, due]]) {
        const f = fixture({ row });
        Object.assign(f.record, fields);
        assert.equal(f.paint().children[0].textContent, rowLine(key), JSON.stringify([fields, row]));
        assert.equal(f.binding.chainNotice.className.includes('rotation-blocked'), red, JSON.stringify([fields, row]));
      }
    }
  }
  // The words follow the session while the row itself stays as it was.
  const f = fixture({ row: { state: 'requested', gate: 'not-idle', undo: true } });
  f.record.state = 'working';
  const line = f.paint().children[0];
  f.record.state = 'approval';
  assert.equal(f.paint().children[0], line);
  assert.equal(line.textContent, rowLine('rotation.wait.answer'));
  f.language('en');
  assert.equal(line.textContent, 'Rotation: it is waiting for your reply; rotates after it');
});

test('R207: one handed over says what its old session still waits for', () => {
  const handed = { state: 'handed', next, now: true };
  const said = (gate, fields = {}) => {
    const f = fixture({ row: { ...handed, gate } });
    Object.assign(f.record, fields);
    return [f.paint().children[0].textContent.split(' · ').slice(1).join(' · ').replace(/^续」 ?·? ?/, ''), f.binding.chainNotice.className.includes('rotation-blocked')];
  };
  for (const [gate, key, red] of [['turn-running', 'rotation.wait.turn', false], ['settling', 'rotation.wait.turn', false], ['state-approval', 'rotation.wait.answer', true], ['state-error', 'rotation.wait.error', false],
    ['state-disconnected', 'rotation.wait.disconnected', false], ['state-starting', 'rotation.wait.turn', false], ['state-stopping', 'stewardWake.reason.unavailable', false],
    ['terminal-input', 'rotation.wait.draft', true], ['paused', 'stewardWake.reason.paused', true], ['native-goal-active', 'rotation.wait.goal', false], ['person-message', null, false]]) {
    const [text, blocked] = said(gate);
    assert.equal(text, key ? locale.format('zh', key) : '', gate);
    assert.equal(blocked, red, gate);
  }
});

test('R207: unsent text in a Codex terminal ends with a message, in a Claude terminal with the prompt cleared too', () => {
  for (const [provider, key] of [['codex', 'rotation.wait.terminal'], ['claude', 'rotation.wait.draft']]) {
    for (const state of ['requested', 'handed']) {
      const f = fixture({ row: { state, gate: 'terminal-input', undo: true, next } });
      f.record.provider = provider;
      assert.ok(f.paint().children[0].textContent.endsWith(locale.format('zh', key)), provider + state);
      assert.equal(f.binding.chainNotice.className.includes('rotation-blocked'), true);
    }
  }
});

test('R207: red only where only the person can end it', () => {
  const red = (gate, state = 'requested') => {
    const f = fixture({ row: { state, gate, undo: true } });
    return f.paint().className.includes('rotation-blocked');
  };
  for (const gate of ['paused', 'automatic-messages-off', 'native-terminal-dialog', 'rotation-control-unresolved', 'person-typing', 'terminal-input', 'decisions-stay', 'permission-mode', 'several-spaces', 'backend-update-needed']) {
    assert.equal(red(gate), true, gate);
  }
  for (const gate of ['not-idle', 'busy', 'settling', 'no-slot', 'background-work', 'background-unconfirmed', 'team-running', 'quiet-window', 'native-goal-active', 'usage-limit-exceeded', 'waiting-provider', 'trust-hold', 'unavailable', 'handoff-request-not-sent', 'missing']) {
    assert.equal(red(gate), false, gate);
  }
});

test('R207: Enter held down from 现在就换 does not press the 撤销 that takes its place', () => {
  const f = fixture({ row: { state: 'requested', gate: 'busy', undo: true } });
  const undo = f.paint().children[1], keys = undo.listeners.filter(l => l.type === 'keydown');
  assert.equal(keys.length, 1);
  for (const repeat of [true, false]) {
    let prevented = false;
    keys[0].listener({ key: 'Enter', repeat, preventDefault() { prevented = true; } });
    assert.equal(prevented, repeat);
  }
});

test('R207: no row for a session with none, put away, or in a window that cannot ask', () => {
  for (const change of [f => { f.state.sessionRotations = {}; }, f => { f.record.archived = true; }, f => { delete f.c.api.sessionRotation; }, f => { delete f.state.sessionRotations; }]) {
    const f = fixture({ row: { state: 'requested', gate: 'busy', undo: true } });
    change(f);
    assert.equal(f.paint(), undefined);
    assert.equal(f.form.children.length, 0);
  }
  const f = fixture({ row: { state: 'requested', gate: 'busy', undo: true } });
  f.paint();
  f.state.sessionRotations = {};
  assert.equal(f.paint().hidden, true);
});

test('R207: 现在就换 and 撤销 ask for this session once, then read the state again', async () => {
  const f = fixture({ row: { state: 'due', gate: 'busy', now: true } });
  await f.paint().children[1].click();
  assert.deepEqual(f.calls, [['rotation', 'old', 'now'], ['state'], ['render']]);
  f.calls.length = 0;
  f.state.sessionRotations = { old: { state: 'requested', gate: 'busy', undo: true } };
  const undo = f.paint().children[1];
  assert.equal(undo.textContent, '撤销');
  // The second click of the double-click that asked.
  await undo.click(2);
  assert.deepEqual(f.calls, []);
  await undo.click(1);
  assert.deepEqual(f.calls, [['rotation', 'old', 'undo'], ['state'], ['render']]);
  f.c.api.sessionRotation = async () => { throw new Error('cannot undo'); };
  await undo.click(1);
  assert.deepEqual(f.toasts, ['cannot undo']);
});

test('R207: the buttons of the row go where they say', async () => {
  const f = fixture({ row: STATES.handed[0] });
  await f.paint().children[2].click();
  assert.deepEqual(f.calls, [['go', 'new']]);
  const old = fixture({ row: STATES.old[0] });
  assert.deepEqual(old.paint().children.slice(1).map(button => button.textContent), ['撤销'], 'A backend that is not older has nothing to update');
  old.c.backendVersionNotice = () => ({ kind: 'old' });
  await old.paint().children[1].click();
  assert.deepEqual(old.calls, [['update', 'old']]);
});

test('R207: disconnected, the row stays and its buttons wait', async () => {
  const f = fixture({ row: { state: 'due', gate: 'busy', now: true } });
  f.c.disconnected = true;
  const button = f.paint().children[1];
  assert.equal(button.disabled, true);
  await button.click();
  assert.deepEqual(f.calls, []);
  f.c.disconnected = false;
  assert.equal(f.paint().children[1].disabled, false);
});

test('R207: a successor that is gone or renamed, and segments handed over before', () => {
  const gone = fixture({ row: { ...STATES.handed[0], now: undefined }, records: [{ ...OLD }] });
  assert.match(gone.paint().children[0].textContent, /这段已交给「Old one · 续」/);
  assert.equal(gone.binding.chainNotice.children[1].disabled, true);
  const f = fixture({ row: STATES.handed[0], chain: { sessions: [
    { id: 'old', name: 'Old one', successors: [{ id: 'new', time: 1 }, { id: 'earlier', time: 0 }], continuedAt: null, record: {} },
    { id: 'new', name: 'Old one · 续', successors: [], record: {} }, { id: 'earlier', name: 'Earlier', successors: [], record: {} }] } });
  const texts = () => f.paint().children.map(child => child.textContent);
  assert.match(texts()[0], /^这段已交给「Old one · 续」 · 等你停一会儿，最早 \S+ · 这段已交给「Earlier」$/);
  assert.deepEqual(texts().slice(1), ['现在就换', '前往「Old one · 续」', '前往「Earlier」']);
  f.state.sessions[1].name = 'Renamed';
  assert.match(texts()[0], /这段已交给「Renamed」/);
  assert.equal(texts()[2], '前往「Renamed」');
  f.state.sessionRotations = {};
  assert.deepEqual(texts(), ['这段已交给「Old one · 续 / Earlier」', '前往「Old one · 续」', '前往「Earlier」']);
  assert.equal(f.binding.chainNotice.children[0].getAttribute('role'), null, 'What is only a record is not read out');
});

test('R207: the line changes in place and the keyboard stays on the row', () => {
  const f = fixture({ row: { state: 'due', gate: 'busy', now: true } });
  const input = f.node('textarea');
  f.form.append(input);
  const notice = f.paint(), line = notice.children[0], first = notice.children[1];
  f.paint();
  assert.equal(notice.children[1], first, 'Nothing changed: nothing is made again');
  first.focus();
  f.state.sessionRotations = { old: { state: 'requested', gate: 'busy', undo: true } };
  f.paint();
  assert.equal(notice.children[0], line);
  assert.equal(line.textContent, '换会话：这一轮结束就换');
  assert.equal(f.document.activeElement, notice.children[1]);
  f.state.sessionRotations = { old: { state: 'requested', gate: 'team-running', undo: true } };
  f.paint();
  assert.equal(line.textContent, '换会话：队友在运行，结束后换');
  input.focus();
  f.state.sessionRotations = { old: { state: 'taking' } };
  f.paint();
  assert.equal(f.document.activeElement, input);
  assert.equal(notice.children.length, 1);
  assert.deepEqual(f.form.children, [notice, input]);
});

test('R207: one binding shown for another session paints that one', async () => {
  const f = fixture({ row: { state: 'requested', gate: 'busy', undo: true } });
  f.state.sessionRotations.new = { state: 'requested', gate: 'busy', undo: true };
  f.paint();
  f.record = f.state.sessions[1];
  await f.paint().children[1].click();
  assert.deepEqual(f.calls[0], ['rotation', 'new', 'undo']);
});

test('R207: the person\'s own step is in red, by the theme\'s ink', () => {
  assert.match(styles, /\.session-chain-notice\.rotation-blocked > span \{ color: var\(--approval-ink\); \}/);
  assert.ok(styles.match(/--approval-ink:/g).length >= 2);
});

test('R207: where the session has no input shown, the row is above its terminal', () => {
  const f = fixture({ row: { state: 'due', gate: 'busy', now: true } }), pane = f.node('section'), scope = f.node('p');
  f.root.append(pane);
  pane.append(scope);
  f.c.$ = id => { assert.equal(id, 'room-scope'); return scope; };
  f.c.renderTerminalRotation(f.record, false);
  assert.deepEqual(pane.children, [scope]);
  f.c.renderTerminalRotation(f.record, true);
  const host = pane.children[0];
  assert.equal(pane.children[1], scope);
  assert.equal(host.className, 'terminal-rotation');
  assert.equal(host.hidden, false);
  assert.equal(host.textContent, '换会话：等这一轮结束现在就换');
  f.c.renderTerminalRotation(f.record, false);
  assert.equal(host.hidden, true);
  f.c.renderTerminalRotation(f.record, true);
  assert.deepEqual(pane.children, [host, scope]);
  assert.equal(host.hidden, false);
  f.c.renderTerminalRotation(undefined, true);
  assert.equal(host.hidden, true);
  f.state.sessionRotations = {};
  f.c.renderTerminalRotation(f.record, true);
  assert.equal(host.hidden, true);
  assert.match(styles, /\.terminal-rotation\[hidden\] \{ display: none; \}/);
});

test('R207: the terminal has the row only where no input of that session is shown', () => {
  const call = section('    const columnInput = sessionComposers.get(s?.id);', '    renderPaneSwitches(s, inRoom);');
  const shown = given => {
    const told = [], c = vm.createContext({ s: { id: 'old' }, terminalVisible: true, terminalLayout: 'split', inRoom: false, sessionComposers: new Map(), $: () => ({ hidden: given.chatHidden === true }),
      renderTerminalRotation: (s, value) => told.push([s?.id, Boolean(value)]), ...given });
    vm.runInContext(call, c);
    return told;
  };
  const column = visible => new Map([['old', { column: true, visible }]]);
  assert.deepEqual(shown({}), [['old', false]], 'The chat pane has the composer');
  assert.deepEqual(shown({ terminalLayout: 'maximized' }), [['old', true]]);
  assert.deepEqual(shown({ chatHidden: true }), [['old', true]]);
  assert.deepEqual(shown({ chatHidden: true, inRoom: true, sessionComposers: column(true) }), [['old', false]], 'Its column has the input');
  assert.deepEqual(shown({ chatHidden: true, inRoom: true, sessionComposers: column(false) }), [['old', true]]);
  assert.deepEqual(shown({ chatHidden: true, inRoom: true, terminalLayout: 'maximized', sessionComposers: column(true) }), [['old', true]]);
  assert.deepEqual(shown({ terminalLayout: 'maximized', terminalVisible: false }), [['old', false]]);
  assert.deepEqual(shown({ s: undefined, chatHidden: true }), [[undefined, true]]);
});

test('R207: the menu has one item: 现在就换会话, or 撤销换会话 while it can be taken back', () => {
  const ids = (row, change = {}, chain = null) => {
    const f = fixture({ row, chain });
    Object.assign(f.record, change);
    return plain(f.c.sessionRotationAction(f.record)).map(item => [item.id, item.label]);
  };
  const now = [['rotation-now', '现在就换会话']], undo = [['rotation-undo', '撤销换会话']];
  assert.deepEqual(ids(), now);
  assert.deepEqual(ids(undefined, { provider: 'codex' }), now);
  assert.deepEqual(ids({ state: 'due', gate: 'paused', now: true }), now);
  assert.deepEqual(ids({ state: 'handed', gate: 'person-quiet', at: AT, next, now: true }), now);
  assert.deepEqual(ids({ state: 'requested', gate: 'busy', undo: true }), undo);
  assert.deepEqual(ids({ state: 'writing', undo: true }), undo);
  assert.deepEqual(ids({ state: 'taking' }), []);
  assert.deepEqual(ids({ state: 'handed', gate: 'settling', next }), []);
  for (const change of [{ provider: 'agy' }, { provider: 'dsh' }, { provider: undefined }, { archived: true }, { state: 'ended' }, { state: 'background' }, { state: 'error' }, { state: 'recoverable' }, { state: 'disconnected' }]) {
    assert.deepEqual(ids({ state: 'requested', gate: 'busy', undo: true }, change), [], JSON.stringify(change));
    assert.deepEqual(ids(undefined, change), [], JSON.stringify(change));
  }
  const chain = { sessions: [{ id: 'old', successors: [{ id: 'new' }] }, { id: 'new', successors: [] }] };
  assert.deepEqual(ids(undefined, {}, chain), [], 'Handed over already');
  assert.deepEqual(ids(undefined, { id: 'new' }, chain), now, 'The segment in use');
  const f = fixture();
  delete f.c.api.sessionRotation;
  assert.deepEqual(plain(f.c.sessionRotationAction(f.record)), []);
  assert.deepEqual(plain(f.c.sessionRotationAction(undefined)), []);
  f.l.setLanguage('en');
  f.c.api.sessionRotation = async () => {};
  assert.equal(f.c.sessionRotationAction(f.record)[0].label, 'Rotate session now');
  f.state.sessionRotations = { old: { state: 'writing', undo: true } };
  assert.equal(f.c.sessionRotationAction(f.record)[0].label, 'Undo session rotation');
});

function menuFixture(row) {
  const f = fixture({ row, chain: { sessions: [{ id: 'old', successors: [] }, { id: 'before', successors: [] }] } });
  const control = f.node('button');
  Object.assign(f.c, {
    allSpaces: () => [], sidebarSessions: () => [f.record], orderedMembers: () => [f.record], members: () => [f.record], sidebarDetails: () => [], sidebarFactsKey: () => '',
    window: { nativeWorkspaceSpaces: require('../collaboration-spaces.cjs') }, rotationReleaseAction: () => [], integratorAction: () => [], stewardAction: () => [{ id: 'steward-set', label: 'steward' }],
    managerAction: () => [{ id: 'manager-set', label: 'manager' }],
    modelAction: () => [{ id: 'change-model', label: 'model' }], sessionRows: new Map([['old', { more: control }]]), contentMenu: null, roomMenu: null, sessionMenu: null, focusSessionAction() {}, focusMemberAction() {},
    current: () => f.record, selectionRevision: 1, selected: 'old', spaceId: 'shared', pairRevision: () => 1, headerControls: { membership: control, selectedText: control, usage: control },
    operatorSettingAction: () => [], operatorSettingBusy: new Set(), Element, toastMessage: key => f.toasts.push(key),
  });
  return Object.assign(f, { control });
}

test('R207: the session\'s own menu has it under 这串会话 and above model, butler and project manager', async () => {
  for (const [row, id, action] of [[undefined, 'rotation-now', 'now'], [{ state: 'writing', undo: true }, 'rotation-undo', 'undo']]) {
    const f = menuFixture(row);
    vm.runInContext(section('function sessionMenuModel(', '// Changing the model of one session'), f.c);
    vm.runInContext(section('function openSessionMenu(', 'function memberMenuKey('), f.c);
    f.c.openSessionMenu('old');
    const menu = f.menus.at(-1), ids = plain(menu.items.map(item => item.id));
    const at = ids.indexOf(id);
    assert.deepEqual(ids.slice(at - 1, at + 3), ['session-chain', id, 'change-model', 'steward-set']);
    assert.ok(ids.indexOf('manager-set') > at);
    await menu.onSelect(id);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.calls, [['rotation', 'old', action], ['state'], ['render']]);
  }
});

test('R207: the title bar\'s menu has it, off while disconnected', async () => {
  for (const [row, id, action] of [[undefined, 'rotation-now', 'now'], [{ state: 'writing', undo: true }, 'rotation-undo', 'undo']]) {
    const f = menuFixture(row);
    vm.runInContext(section('const headerMenuKey =', 'function renderHeaderLayout('), f.c);
    f.c.openHeaderMenu(f.control);
    const menu = f.menus.at(-1), ids = plain(menu.items.map(item => item.id));
    assert.equal(ids.indexOf(id) + 1, ids.indexOf('change-model'));
    assert.equal(menu.items.find(item => item.id === id).disabled, false);
    await menu.onSelect(id);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.calls, [['rotation', 'old', action], ['state'], ['render']]);
    f.calls.length = 0;
    f.c.disconnected = true;
    f.c.openHeaderMenu(f.node('button'));
    assert.equal(f.menus.at(-1).items.find(item => item.id === id).disabled, true);
    f.menus.at(-1).onSelect(id);
    assert.deepEqual(f.calls, []);
    f.c.disconnected = false;
    f.c.openHeaderMenu(f.node('button'), true);
    assert.ok(!f.menus.at(-1).items.some(item => item.id.startsWith('rotation-')), 'Not in the terminal\'s own menu');
  }
});

test('R207: a member\'s menu has it above its project manager', async () => {
  for (const [row, id, action] of [[undefined, 'rotation-now', 'now'], [{ state: 'writing', undo: true }, 'rotation-undo', 'undo']]) {
    const f = menuFixture(row);
    Object.assign(f.c, { selected: 'room', roomSurface: 'overview', roomSession: '', columnTerminalBinding: () => null, $: () => f.control });
    f.state.room = { archived: false };
    f.root.append(f.control);
    vm.runInContext(section('function memberMenuKey(', 'function sidebarSessions('), f.c);
    f.c.openMemberMenu('old', f.control);
    const menu = f.menus.at(-1), ids = plain(menu.items.map(item => item.id));
    assert.ok(ids.includes(id), ids.join());
    assert.ok(ids.indexOf('manager-set') > ids.indexOf(id), ids.join());
    await menu.onSelect(id);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.calls.slice(0, 1), [['rotation', 'old', action]]);
  }
});

test('R207: a row that changes does not close an open menu or a terminal dialog', () => {
  assert.doesNotMatch(section('function memberMenuKey(', 'function openMemberMenu('), /otation/);
  assert.doesNotMatch(section('const headerMenuKey =', 'function openHeaderMenu('), /otation/);
});
