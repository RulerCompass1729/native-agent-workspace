const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
function take(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, 'Production renderer function boundaries exist');
  return source.slice(a, b);
}
class Element {
  constructor() { this.children = []; this.hidden = false; }
  append(child) {
    if (child.parentElement) child.parentElement.children.splice(child.parentElement.children.indexOf(child), 1);
    this.children.push(child); child.parentElement = this;
  }
  insertBefore(child, next) {
    this.append(child); this.children.pop(); this.children.splice(this.children.indexOf(next), 0, child);
  }
  get nextSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1]; }
}
function setup({ view = 'chat', alive = true, solo = false, usable = true } = {}) {
  const record = { id: 'member', nativeId: 'original-native', owner: 'window', view, eitherViewInput: true, connectionRevision: 4,
    terminalState: { alive, epoch: 'original-epoch' }, messages: [] };
  const host = new Element(), parking = new Element(), soloHost = new Element(), form = new Element();
  form.value = 'positive private draft'; form.selectionStart = 3; form.selectionEnd = 9;
  const calls = [], binding = { id: record.id, revision: 6, ui: { form, suspend: () => calls.push('suspend') } };
  const entry = { element: new Element(), ready: true, nativeId: record.nativeId, generation: 4, epoch: 'original-epoch',
    columnReading: true, cursor: { x: 5, y: 7 }, term: { blur: () => calls.push('blur') } };
  parking.append(form); parking.append(entry.element);
  const context = vm.createContext({
    state: { sessions: [record] }, owner: 'window', selected: 'room', mode: 'chat', disconnected: false,
    sessionComposers: new Map([[record.id, binding]]), terminals: new Map([[record.id, entry]]), terminalRenderLoads: new Map(),
    soloComposer: solo ? binding : {}, composerParking: parking, terminalParking: parking,
    getSessionComposer: () => binding, node: () => new Element(),
    composerCurrent: value => value === binding && Boolean(binding.visible),
    columnTerminalSash: value => value.nativeSash ||= new Element(),
    columnTerminalHeight: () => 128, applyColumnTerminalHeight: () => calls.push('height'),
    updateSessionComposer: () => {}, takeFreeSession: () => {},
    cancelColumnComposition: () => calls.push('cancelComposition'),
    ui: { display: { attribute: () => {} } }, participantLabel: () => 'Member',
    nativeUsable: () => usable, ensureTerminal: (...args) => { calls.push(['ensure', ...args]); return Promise.resolve(); },
    toastError: error => { throw error; }, activeSessionId: () => 'other', focusedRoomMember: () => false,
    $: () => soloHost, revealTerminalCursor: () => calls.push('reveal'),
  });
  vm.runInContext(take('function renderColumnInput(', '// T-135:') + '\n' +
    take('function renderTerminal(', 'async function ensureTerminal(') + '\n' +
    take('function columnTerminalBinding(', 'const queuedInputs') + '\n' +
    take('function terminalCanInput(', 'function canFlushComposition('), context);
  return { context, record, host, parking, soloHost, form, binding, entry, calls,
    render: visible => context.renderColumnInput(host, record, visible),
    inputAllowed: () => context.terminalCanInput(record.id) };
}

test('a live chat-view member shows its existing terminal without changing draft, identity or input view', () => {
  const h = setup(), before = JSON.stringify(h.record), originalEntry = h.entry;
  assert.equal(h.render(true), true);
  assert.equal(h.binding.nativeHost.hidden, false);
  assert.equal(h.binding.nativeSash.hidden, false);
  assert.equal(h.entry.element.parentElement, h.binding.nativeHost);
  assert.equal(h.form.parentElement, h.host);
  assert.equal(h.form.value, 'positive private draft');
  assert.deepEqual([h.form.selectionStart, h.form.selectionEnd], [3, 9]);
  assert.equal(JSON.stringify(h.record), before);
  assert.equal(h.context.terminals.get(h.record.id), originalEntry);
  assert.deepEqual(h.entry.cursor, { x: 5, y: 7 });
  assert.equal(h.binding.revision, 6);
  // Drawing a column measures nothing: the space measures all its columns after drawing them (space-column-layout.test.cjs).
  assert.deepEqual(h.calls, [['ensure', 'member']]);
  // 887d9fea: showing changes no claim (the record above is unchanged), and a terminal of a session this window
  // controls takes keys whichever side its view is on (the person, 2026-11-13: 两边的输入可以不要锁定).
  assert.equal(h.inputAllowed(), true, 'The shown terminal of a session this window controls takes keys on the conversation side');
});

test('native input requires the correct owner and display identity, on either side of the view', () => {
  const h = setup(); h.render(true);
  assert.equal(h.inputAllowed(), true, 'The conversation-side view does not lock the terminal');
  h.record.view = 'terminal';
  h.render(true);
  assert.equal(h.inputAllowed(), true, 'Positive witness: the unchanged valid native claim can type');
  for (const [target, field, value] of [[h.record, 'owner', 'other-window'], [h.record, 'nativeId', 'different-native'],
    [h.entry, 'generation', 3], [h.entry, 'epoch', 'old-epoch']]) {
    const old = target[field]; target[field] = value;
    assert.equal(h.inputAllowed(), false, field + ' mismatch must still reject native input');
    target[field] = old;
    assert.equal(h.inputAllowed(), true, field + ' restored');
  }
  // A service from before 887d9fea refuses terminal keys while the view is on the conversation side: keep its rule.
  h.record.eitherViewInput = false; assert.equal(h.inputAllowed(), true, 'An older service still takes keys on the terminal side');
  h.record.view = 'chat'; assert.equal(h.inputAllowed(), false, 'An older service gets no keys on the conversation side');
});

test('chat-view members with absent or stopped displays do not gain an empty terminal area', () => {
  for (const alive of [false, undefined]) {
    const h = setup({ alive });
    if (alive === undefined) delete h.record.terminalState.alive;
    assert.equal(h.render(true), false);
    assert.equal(h.binding.nativeHost.hidden, true);
    assert.equal(h.binding.nativeSash.hidden, true);
    assert.equal(h.entry.element.parentElement, h.parking);
    assert.deepEqual(h.calls, []);
  }
});

test('an explicit terminal view retains its existing stopped-display area without a passive restart', () => {
  const h = setup({ view: 'terminal', alive: false });
  assert.equal(h.render(true), true);
  assert.equal(h.binding.nativeHost.hidden, false);
  assert.equal(h.inputAllowed(), false);
  assert.deepEqual(h.calls, []);
});

test('a solo composer keeps its terminal outside the column', () => {
  const h = setup({ solo: true });
  h.context.activeSessionId = () => h.record.id;
  h.context.selected = h.record.id;
  assert.equal(h.render(true), false);
  assert.equal(h.binding.nativeHost.hidden, true);
  assert.equal(h.entry.element.parentElement, h.soloHost);
  assert.equal(h.form.parentElement, h.parking);
  assert.deepEqual(h.calls, []);
});

test('hiding and returning to the column preserves the same terminal and positive draft', () => {
  const h = setup(); h.render(true);
  const originalEntry = h.entry, before = JSON.stringify(h.record);
  assert.equal(h.render(false), false);
  assert.equal(h.entry.element.parentElement, h.parking);
  assert.equal(h.form.parentElement, h.parking);
  assert.equal(h.render(true), true);
  assert.equal(h.context.terminals.get(h.record.id), originalEntry);
  assert.equal(h.entry.element.parentElement, h.binding.nativeHost);
  assert.equal(h.form.value, 'positive private draft');
  assert.deepEqual([h.form.selectionStart, h.form.selectionEnd], [3, 9]);
  assert.deepEqual(h.entry.cursor, { x: 5, y: 7 });
  assert.equal(JSON.stringify(h.record), before);
  assert.equal(h.inputAllowed(), true);
});

test('an unavailable backend can show an existing live display but cannot start or accept native input', () => {
  const h = setup({ usable: false });
  assert.equal(h.render(true), true);
  assert.equal(h.entry.element.parentElement, h.binding.nativeHost);
  assert.deepEqual(h.calls, []);
  h.record.view = 'terminal';
  assert.equal(h.inputAllowed(), false);
});
