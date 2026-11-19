// Lists that grow keep every item within the person's reach (progressive disclosure, 2026-11-19): content that is
// recorded but has no way onto the screen. Each test acts as the person would: open every disclosure and press every
// control until nothing new appears, and asks what was on screen at some point. Counts per page are left open.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const localeUI = require('./fixtures/locale-ui.cjs');
const spaces = require('../collaboration-spaces.cjs');
const handoffQueue = require('../renderer/handoff-queue.js');
const { StewardRecord, view, argumentsOf } = require('../steward-record.cjs');
const { bind } = require('../renderer/steward-record.js');
const renderer = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');

class Text {
  constructor(value) { this.nodeType = 3; this.data = String(value); this.parentElement = null; }
  get textContent() { return this.data; }
  remove() { detach(this); }
}
function detach(child) {
  const parent = child.parentElement;
  if (!parent) return;
  parent.childNodes.splice(parent.childNodes.indexOf(child), 1);
  child.parentElement = null;
}
function adopt(child, parent) {
  const value = typeof child === 'string' ? new Text(child) : child;
  detach(value);
  value.parentElement = parent;
  return value;
}
const focus = { active: null };
class El {
  constructor(tag = 'div', text, cls) {
    Object.assign(this, { nodeType: 1, tagName: tag, className: cls || '', childNodes: [], dataset: {}, attrs: new Map(), listeners: new Map(), parentElement: null,
      id: '', title: '', type: '', value: '', hidden: false, open: false, disabled: false, checked: false, style: {} });
    if (text !== undefined && text !== null && text !== '') this.append(String(text));
  }
  get children() { return this.childNodes.filter(child => child.nodeType === 1); }
  get textContent() { return this.childNodes.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); if (value !== undefined && value !== null && value !== '') this.append(String(value)); }
  get isConnected() { return true; }
  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    return { contains: name => names().includes(name), add: name => { if (!names().includes(name)) this.className = [...names(), name].join(' '); },
      remove: name => { this.className = names().filter(n => n !== name).join(' '); }, toggle: (name, on) => { const want = on ?? !names().includes(name); if (want) this.classList.add(name); else this.classList.remove(name); return want; } };
  }
  append(...children) { for (const child of children) this.childNodes.push(adopt(child, this)); }
  prepend(...children) { this.childNodes.unshift(...children.map(child => adopt(child, this))); }
  after(...children) { const parent = this.parentElement; if (!parent) return; const added = children.map(child => adopt(child, parent)); parent.childNodes.splice(parent.childNodes.indexOf(this) + 1, 0, ...added); }
  before(...children) { const parent = this.parentElement; if (!parent) return; const added = children.map(child => adopt(child, parent)); parent.childNodes.splice(parent.childNodes.indexOf(this), 0, ...added); }
  insertBefore(child, before) { const value = adopt(child, this); const index = before ? this.childNodes.indexOf(before) : -1; this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, value); return value; }
  replaceChildren(...children) { for (const child of this.childNodes) child.parentElement = null; this.childNodes = []; this.append(...children); }
  remove() { detach(this); }
  setAttribute(key, value) { this.attrs.set(key, String(value)); if (key === 'id') this.id = String(value); }
  getAttribute(key) { return this.attrs.has(key) ? this.attrs.get(key) : null; }
  hasAttribute(key) { return this.attrs.has(key); }
  removeAttribute(key) { this.attrs.delete(key); }
  toggleAttribute(key, on) { const want = on ?? !this.attrs.has(key); if (want) this.attrs.set(key, ''); else this.attrs.delete(key); return want; }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
  removeEventListener(type, listener) { const list = this.listeners.get(type) || []; if (list.includes(listener)) list.splice(list.indexOf(listener), 1); }
  dispatch(type) {
    const event = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} };
    const results = [];
    if (typeof this['on' + type] === 'function') results.push(this['on' + type](event));
    for (const listener of [...(this.listeners.get(type) || [])]) results.push(listener(event));
    return Promise.allSettled(results);
  }
  click() { return this.disabled ? Promise.resolve() : this.dispatch('click'); }
  focus() { focus.active = this; }
  blur() { if (focus.active === this) focus.active = null; }
  showModal() { this.open = true; }
  show() { this.open = true; }
  close() { this.open = false; }
  scrollIntoView() {}
  getClientRects() { return [1]; }
  getBoundingClientRect() { return { left: 0, right: 20, top: 0, bottom: 20, width: 20, height: 20 }; }
  // Simple selectors only: tag, #id, .class and one [attribute] or [attribute="value"]. Anything else matches nothing.
  matches(selector) {
    const parts = /^([a-z0-9]*)(?:#([\w-]+))?((?:\.[\w-]+)*)(?:\[([\w-]+)(?:="([^"]*)")?\])?$/.exec(String(selector).trim());
    if (!parts || !parts[0]) return false;
    const [, tag, id, classes, attribute, value] = parts;
    if (tag && this.tagName !== tag) return false;
    if (id && this.id !== id) return false;
    for (const name of classes.split('.').filter(Boolean)) if (!this.classList.contains(name)) return false;
    if (attribute) {
      const data = attribute.startsWith('data-') ? this.dataset[attribute.slice(5).replace(/-([a-z])/g, (all, c) => c.toUpperCase())] : undefined;
      const actual = this.attrs.has(attribute) ? this.attrs.get(attribute) : data;
      if (actual === undefined || actual === null) return false;
      if (value !== undefined && String(actual) !== value) return false;
    }
    return true;
  }
  querySelectorAll(selector) { return elementsBelow(this).filter(el => el.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { for (let el = this; el; el = el.parentElement) if (el.matches(selector)) return el; return null; }
}
function elementsBelow(el) { return el.children.flatMap(child => [child, ...elementsBelow(child)]); }
function attached(el, root) { for (let at = el; at; at = at.parentElement) if (at === root) return true; return false; }
// What the person can see: not what is hidden, and of a closed <details> only its summary. Attributes (title) are not
// counted: a tooltip is neither reachable by keyboard nor read in full.
function onScreen(el) {
  if (el.nodeType === 3) return el.data;
  if (el.hidden === true) return '';
  const shown = el.tagName === 'details' && !el.open ? el.childNodes.filter(child => child.tagName === 'summary') : el.childNodes;
  return shown.map(onScreen).join('\n');
}
function hiddenWithin(el, root) {
  for (let at = el; at && at !== root; at = at.parentElement) {
    if (at.hidden === true) return true;
    if (at.parentElement?.tagName === 'details' && !at.parentElement.open && at.tagName !== 'summary') return true;
  }
  return false;
}
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
// The person opens every disclosure and presses every visible control, again while that brings something new to the
// screen. Returns every screen seen on the way. `after` runs after each press (a dialog the press closed is reopened).
async function explore(root, { after = () => {}, rounds = 5000 } = {}) {
  const screens = new Set([onScreen(root)]);
  for (let round = 0; round < rounds; round++) {
    const before = screens.size;
    for (const details of elementsBelow(root).filter(el => el.tagName === 'details' && !el.open)) {
      details.open = true;
      await details.dispatch('toggle');
      screens.add(onScreen(root));
    }
    const controls = elementsBelow(root).filter(el => (el.tagName === 'button' || el.getAttribute('role') === 'button' || el.tagName === 'summary') && !el.disabled);
    for (const control of controls) {
      if (!attached(control, root) || hiddenWithin(control, root) || control.tagName === 'summary') continue;
      await control.click();
      await settle();
      after();
      screens.add(onScreen(root));
    }
    if (screens.size === before) break;
  }
  return [...screens];
}
const pad = n => String(n).padStart(4, '0');
const reachedAll = (screens, marks) => marks.filter(mark => !screens.some(screen => screen.includes(mark)));
function missingLine(missing, total, what) {
  if (!missing.length) return '';
  return `${missing.length} of ${total} ${what} never reach the screen (${missing[0]} … ${missing.at(-1)})`;
}

// ① The butler's record: every step NAW kept is one the person can get to, the earliest ones included.
const butler = { sessionId: 'butler', nativeId: 'native-butler' };
const butlerSender = { id: 'butler', nativeId: 'native-butler', provider: 'claude', name: '合成大管家' };
async function stewardFixture(t, steps) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-reach-steward-'));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse('2026-11-12T10:00:00Z');
  const options = { steward: () => butler, selected: () => butler, now: () => clock += 1000 };
  const marks = Array.from({ length: steps }, (_, i) => `[S${pad(i + 1)}]`);
  const input = i => ({ action: 'invoke', method: 'spaceAction', arguments: ['room-a', 'queueAdd', [`${marks[i]} 合成任务`, null]], operation_id: `op-${i + 1}` });
  // The first step goes through the butler's call as NAW records it; the rest are its lines again, written in one
  // block (one fsync instead of two per step), and the record is read back from disk as NAW opens it.
  const first = new StewardRecord(dir, options);
  await first.around(butlerSender, input(0), async () => ({ id: 'op-1', state: 'complete' }));
  const step = first.lines.find(line => line.kind === 'step'), outcome = first.lines.find(line => line.kind === 'outcome' && line.step === step.id);
  assert.ok(step && outcome, 'one step and its outcome were recorded');
  const more = [];
  for (let i = 1; i < steps; i++) {
    const id = `${step.id.slice(0, -4)}${pad(i)}`, at = clock += 1000;
    more.push({ time: at, value: { ...step, id, at, arguments: argumentsOf(input(i)), operationId: `op-${i + 1}` } }, { time: at + 1, value: { ...outcome, step: id, at: at + 1, operationId: `op-${i + 1}` } });
  }
  first.log.append(more, clock += 1000);
  const record = new StewardRecord(dir, options);
  assert.equal(record.failed, false, 'the record reads back');
  const snapshot = { sessions: [{ ...butlerSender, messages: [] }], rooms: [{ id: 'room-a', name: '合成空间' }] };
  const asked = [];
  // As main.cjs's stewardRecord handler: the dialog's request, if it sends one, goes on to view() as it is.
  const api = { stewardRecord: async (...args) => { asked.push(args); return view(record, snapshot, Object.assign({ current: butler, now: clock }, ...args.filter(a => a && typeof a === 'object'))); } };
  const dialog = new El('dialog');
  dialog.id = 'steward-record-dialog';
  const l = localeUI();
  const shown = bind({ dialog, document: { createElement: tag => new El(tag), createTextNode: text => new Text(text) }, api, text: l.uiText, display: l.ui.display });
  return { dialog, shown, marks, asked, api };
}

test('every step in the butler\'s record can be reached in its dialog, the earliest included', async t => {
  const steps = 700;
  const f = await stewardFixture(t, steps);
  await f.shown.open();
  const first = onScreen(f.dialog);
  assert.ok(first.includes(f.marks.at(-1)), 'the newest step is on screen when the record opens');
  const screens = await explore(f.dialog, { after: () => { f.dialog.open = true; } });
  const missing = reachedAll(screens, f.marks);
  assert.ok(!missing.includes(f.marks[0]), `the person can reach the earliest step ${f.marks[0]}: ${missingLine(missing, steps, 'steps')}`);
  assert.equal(missing.length, 0, missingLine(missing, steps, 'steps'));
});

// ② The space's queue ("查看全部"): every finished task and the whole text of a long one can be reached.
function queueFixture(items, { handoff = null } = {}) {
  const l = localeUI();
  const root = new El('body'), elements = new Map(), calls = [];
  const $ = id => {
    if (!elements.has(id)) {
      const el = new El(id.endsWith('-dialog') ? 'dialog' : id === 'queue-assignee' ? 'select' : 'div');
      el.id = id;
      elements.set(id, el);
      root.append(el);
    }
    return elements.get(id);
  };
  const member = { id: 'member-a', nativeId: 'native-member-a', name: '合成成员 A', provider: 'claude', roomIds: ['shared'], state: 'idle', serviceCapabilities: ['queueDispatchV1'] };
  const room = { id: 'shared', name: '合成空间', metadataRevision: 1, queue: items, messages: [], files: [], events: [] };
  const state = { room, rooms: [room], sessions: [member], wakePolicy: { enabled: true }, rotationChains: [], handoffEnabled: Boolean(handoff), integrator: null };
  const document = { createElement: tag => new El(tag), createTextNode: text => new Text(text), querySelector: () => null, get activeElement() { return focus.active; } };
  const api = {
    initial: async () => state,
    spaceAction: async (...args) => { calls.push(['spaceAction', ...args]); },
    handoff: async (...args) => { calls.push(['handoff', ...args]); if (args[0] !== 'space') throw Error('Not a read'); return handoff; },
  };
  const context = vm.createContext({
    ...l, $, document, state, api, structuredClone, setTimeout, clearTimeout, console,
    window: { nativeWorkspaceHandoffQueue: handoffQueue, nativeWorkspaceSpaces: spaces, nativeWorkspaceDisclosure: require('../renderer/disclosure-list.js') },
    node: (tag, text, cls) => new El(tag, text, cls),
    button: (text, action, cls) => { const el = new El('button', text, cls); el.onclick = action; return el; },
    spaceId: 'shared', disconnected: false, spaceName: value => value?.name, spaceRecord: id => state.rooms.find(r => r.id === id), allSpaces: () => state.rooms,
    inSpace: spaces.isMember, sessionShortId: id => String(id).slice(0, 6), updateState() {}, render() {},
    queueAnswerNode: () => null, queueAnswerFocus: () => null, restoreQueueAnswerFocus() {},
  });
  const load = (from, to) => {
    const a = renderer.indexOf(from), b = renderer.indexOf(to, a + from.length);
    assert.ok(a >= 0 && b > a, from);
    vm.runInContext(renderer.slice(a, b), context);
  };
  load('const uiNode =', 'const states =');
  load('const dialogTickets =', 'function openSetupDialog(');
  load('function archivedName(', 'function sessionWindowTitle(');
  load('let queueSpace = null;', "$('room-queue').onclick");
  return { context, $, root, calls, state };
}
const finishedTask = (i, over = {}) => ({ id: `t${pad(i)}`, text: `[Q${pad(i)}] 合成任务`, assignee: null, status: 'done', createdAt: i, sentTo: 'member-a', reply: '收到', ...over });
const queueRows = f => f.$('queue-list').querySelectorAll('.queue-row').map(row => row.dataset.queueItem);
const acted = f => f.calls.filter(call => call[0] === 'spaceAction' || call[0] === 'handoff' && call[1] !== 'space');

test('every finished task in a space\'s queue can be reached from 查看全部, the earliest included', async () => {
  const total = 240;
  const items = Array.from({ length: total }, (_, i) => finishedTask(i + 1));
  const f = queueFixture(items);
  f.context.openQueue('shared');
  await settle();
  assert.ok(f.$('queue-dialog').open, 'the queue opens');
  assert.ok(onScreen(f.root).includes(items.at(-1).text), 'the latest finished task is on screen when the queue opens');
  const screens = await explore(f.root, { after: () => { f.$('queue-dialog').open = true; } });
  const marks = items.map(item => item.text.slice(0, 7));
  const missing = reachedAll(screens, marks);
  assert.deepEqual(acted(f), [], 'looking through the list does nothing to any task');
  assert.ok(!missing.includes(marks[0]), `the person can reach the earliest finished task ${marks[0]}: ${missingLine(missing, total, 'finished tasks')}`);
  assert.equal(missing.length, 0, missingLine(missing, total, 'finished tasks'));
});

test('the whole text of a long task can be read in the queue', async () => {
  const long = '[QLONG] ' + '这是一段很长的合成任务说明，'.repeat(40) + '[QEND]';
  assert.ok(long.length > 500);
  const items = [finishedTask(1), finishedTask(2, { text: long }), { id: 'open-long', text: long.replace('[QLONG]', '[QOPEN]'), assignee: null, status: 'queued', createdAt: 3 }];
  const f = queueFixture(items);
  f.context.openQueue('shared');
  await settle();
  assert.ok(onScreen(f.root).includes('[QLONG]'), 'the long task is listed');
  // (The queued task's cancel is pressed too; the fake API changes nothing, so it brings nothing to the screen.)
  const screens = await explore(f.root, { after: () => { f.$('queue-dialog').open = true; } });
  const read = text => screens.some(screen => screen.includes(text));
  assert.ok(read(long), 'the whole text of a finished long task reaches the screen');
  assert.ok(read(long.replace('[QLONG]', '[QOPEN]')), 'the whole text of a queued long task reaches the screen');
});

// Kept: what still waits for the person stays in the list however old it is (queueShownItems `keep`, 11-12).
test('a task left for the person to look at is listed when the queue opens, however old it is', async () => {
  const items = [
    finishedTask(1, { id: 'old-returned', text: '[QKEEP] 合成任务：交付被退回，等你看' }),
    { id: 'old-look', text: '[QLOOK] 合成任务：它没有回话，留给你看一眼', assignee: null, status: 'waiting', reason: 'no-reply', createdAt: 2, sentTo: 'member-a' },
    ...Array.from({ length: 200 }, (_, i) => finishedTask(i + 3)),
  ];
  const handoff = { started: true, items: { 'old-returned': { state: 'returned', key: 'k-old', memberId: 'member-a', note: null } }, summary: {}, waiting: null, reasons: [] };
  const f = queueFixture(items, { handoff });
  f.context.openQueue('shared');
  await settle();
  assert.deepEqual(f.calls.filter(call => call[0] === 'handoff'), [['handoff', 'space', 'shared']], 'the handoff view was read for this space');
  const rows = queueRows(f), screen = onScreen(f.root);
  assert.ok(rows.includes('old-returned') && screen.includes('[QKEEP]'), 'a finished task whose delivery waits for the person is listed without pressing anything');
  assert.ok(rows.includes('old-look') && screen.includes('[QLOOK]'), 'a task left for the person to look at is listed without pressing anything');
});

// The approved defaults (the person, 2026-11-19 09:3x: 「渐进式的 UI 改动看着可以,继续」): 15 lines a page in the
// butler's record and 10 finished tasks in the queue, the button says how many come and how many in all, the count is
// read out (role=status), and focus goes on from the first item that appeared.
test('the butler\'s record opens on its latest 15 steps, and each press brings 15 earlier ones, focus on the first of them', async t => {
  const f = await stewardFixture(t, 40);
  const { total } = await f.api.stewardRecord({ limit: 1 });
  f.asked.length = 0;
  assert.ok(total >= 40 && total < 45, 'the 40 steps, and the record\'s own lines');
  await f.shown.open();
  const lines = () => f.dialog.querySelectorAll('li.disclosure-item');
  const more = f.dialog.querySelector('button.disclosure-more'), status = f.dialog.querySelector('p.disclosure-status');
  assert.equal(lines().length, 15);
  assert.deepEqual(f.asked, [[{ limit: 15 }]], 'NAW is asked for one page');
  assert.ok(onScreen(lines()[0]).includes(f.marks.at(-1)), 'newest first');
  assert.equal(more.textContent, `显示更早的 15 条 · 共 ${total} 条`);
  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(status.textContent, `已显示 15/${total} 条`);
  await more.click();
  await settle();
  assert.equal(lines().length, 30);
  assert.deepEqual(f.asked.at(-1), [{ limit: 30 }]);
  assert.equal(focus.active, lines()[15].querySelector('summary'), 'focus on the first step that appeared');
  assert.ok(onScreen(focus.active).includes(f.marks[40 - 16]));
  assert.equal(more.textContent, `显示更早的 ${Math.min(15, total - 30)} 条 · 共 ${total} 条`);
  assert.equal(status.textContent, `已显示 30/${total} 条`);
  await more.click();
  await settle();
  assert.equal(lines().length, total);
  assert.equal(more.hidden, true, 'no button once every step is shown');
  assert.equal(status.textContent, `已显示 ${total}/${total} 条`);
});

test('a long message the butler sent is one line in its record and opens in place to the whole of it', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-reach-message-'));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse('2026-11-12T10:00:00Z');
  const record = new StewardRecord(dir, { steward: () => butler, selected: () => butler, now: () => clock += 1000 });
  record.designated(butler);
  const long = '[MLONG] ' + '合成的长消息内容，'.repeat(60) + '[MEND]';
  assert.ok(long.length > 300);
  const snapshot = { sessions: [{ ...butlerSender, messages: [{ id: 'w', wake: { senderId: 'butler', nativeId: 'native-butler', recipientId: 'member-a', body: long, time: clock + 5000, status: 'submitted' } }] },
    { id: 'member-a', name: '合成成员 A', messages: [] }], rooms: [] };
  const shown = view(record, snapshot, { current: butler, now: clock + 10_000, limit: 15 });
  assert.equal(shown.entries[0].text, long, 'NAW gives the dialog the whole message');
  const dialog = new El('dialog');
  const l = localeUI();
  await bind({ dialog, document: { createElement: tag => new El(tag), createTextNode: text => new Text(text) }, api: { stewardRecord: async () => shown }, text: l.uiText, display: l.ui.display }).open();
  const line = dialog.querySelector('li.disclosure-item');
  const details = line.querySelector('details');
  assert.equal(line.dataset.kind, 'message');
  assert.equal(details.open, false, 'closed: one line');
  assert.ok(onScreen(line).includes('[MLONG]'));
  details.open = true;
  await details.dispatch('toggle');
  assert.ok(onScreen(line.querySelector('.disclosure-body')).includes(long), 'opened: the whole message');
});

test('the queue opens on its latest 10 finished tasks, and each press brings 10 earlier ones above them, focus on the first', async () => {
  const items = Array.from({ length: 25 }, (_, i) => finishedTask(i + 1));
  const f = queueFixture(items);
  f.context.openQueue('shared');
  await settle();
  const list = f.$('queue-list');
  const more = () => list.querySelector('button.disclosure-more'), status = () => f.root.querySelector('p.disclosure-status');
  assert.deepEqual(queueRows(f), items.slice(-10).map(item => item.id));
  assert.equal(more().textContent, '显示更早的 10 条 · 共 25 条');
  assert.equal(status().getAttribute('role'), 'status');
  assert.equal(status().textContent, '已显示 10/25 条');
  await more().click();
  await settle();
  assert.deepEqual(queueRows(f), items.slice(-20).map(item => item.id), 'the earlier ten above the latest ten, in order');
  assert.equal(focus.active?.dataset.queueItem, items.at(-20).id, 'focus on the first task that appeared');
  assert.equal(more().textContent, '显示更早的 5 条 · 共 25 条');
  assert.equal(status().textContent, '已显示 20/25 条');
  await more().click();
  await settle();
  assert.deepEqual(queueRows(f), items.map(item => item.id));
  assert.equal(focus.active?.dataset.queueItem, items[0].id);
  assert.ok(!more() || more().hidden, 'no button once every task is shown');
  assert.equal(status().textContent, '已显示 25/25 条');
  assert.deepEqual(acted(f), [], 'looking back does nothing to any task');
  assert.equal(f.root.querySelectorAll('p.disclosure-status').length, 1, 'one count, kept in place, read out as it changes');
  f.context.openQueue('shared');
  await settle();
  assert.deepEqual(queueRows(f), items.slice(-10).map(item => item.id), 'opened again: the latest ten');
});

test('a long task is one preview line in the queue that opens in place to its whole text', async () => {
  const long = '[QLONG] ' + '这是一段很长的合成任务说明，'.repeat(40) + '[QEND]';
  const f = queueFixture([finishedTask(1, { text: long })]);
  f.context.openQueue('shared');
  await settle();
  const whole = f.$('queue-list').querySelector('details.queue-text-whole');
  assert.ok(whole, 'a text over the preview length is a disclosure');
  assert.equal(whole.open, false);
  const screen = onScreen(f.root);
  assert.ok(screen.includes('[QLONG]') && !screen.includes('[QEND]'), 'closed: the start of it');
  whole.open = true;
  await whole.dispatch('toggle');
  assert.ok(onScreen(f.root).includes(long), 'opened: all of it');
  f.context.renderQueue();
  assert.equal(f.$('queue-list').querySelector('details.queue-text-whole').open, true, 'it stays open when the queue is drawn again');
  const short = queueFixture([finishedTask(1)]);
  short.context.openQueue('shared');
  await settle();
  assert.equal(short.$('queue-list').querySelector('details.queue-text-whole'), null, 'a short task is plain text');
});
