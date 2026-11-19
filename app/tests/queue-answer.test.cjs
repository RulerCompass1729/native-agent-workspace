const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
// Answering a 等你决定 queue row in place, on the real renderer/search-view functions with a synthetic page, IPC and
// clock, and the real spaceAction handler and room state. NAW_QUEUE_ANSWER_ROOT: an older tree, to see these fail.
const root = process.env.NAW_QUEUE_ANSWER_ROOT || path.join(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const renderer = read('app/renderer/renderer.js'), search = read('app/renderer/search-view.js');
const reading = read('app/renderer/reading-list.js'), taskStream = read('app/task-stream.js');
const messages = require(path.join(root, 'app/ui-messages.js'));
const { uiError } = require(path.join(root, 'app/ui-errors.cjs'));
const { RoomState } = require(path.join(root, 'app/room-state.cjs'));
const queueRules = require(path.join(root, 'app/queue-dispatch.cjs'));

function take(source, name) {
  const start = source.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, 'missing ' + name);
  const next = /\n(?:async )?function |\n\/\//g;
  next.lastIndex = start + 1;
  const end = next.exec(source);
  return source.slice(start, end ? end.index : source.length);
}

class El {
  constructor(tag = 'div', page) {
    Object.assign(this, { tagName: tag.toUpperCase(), page, disabled: false, readOnly: false, hidden: false, value: '', textContent: '', children: [], parent: null, dataset: {}, attributes: {}, listeners: {}, open: false });
    const classes = new Set();
    this.classList = { toggle: (c, on) => (on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c), add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) };
  }
  set className(v) { for (const c of String(v).split(/\s+/).filter(Boolean)) this.classList.add(c); }
  append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
  replaceChildren(...items) { for (const old of this.children) old.parent = null; this.children = []; this.append(...items); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn(); }
  type(text) { this.value = text; for (const fn of this.listeners.input || []) fn(); }
  focus() { this.page.document.activeElement = this; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  get isConnected() { let n = this; while (n.parent) n = n.parent; return n === this.page.documentRoot; }
  querySelector() { return null; }
  all() { return [this, ...this.children.flatMap(c => c.all ? c.all() : [])]; }
  find(cls) { return this.all().find(e => e.classList.contains(cls)); }
}

function page(locale = 'en') {
  const elements = new Map(), calls = [], resolves = [];
  let context;
  const $ = id => { if (!elements.has(id)) { const e = new El('div', context); e.id = id; elements.set(id, e); } return elements.get(id); };
  const text = (key, params = {}) => {
    const values = typeof params === 'function' ? params() : params;
    return (messages[locale][key] || key).replace(/\{(\w+)\}/g, (_, k) => String(values[k]));
  };
  const session = (id, name) => ({ id, nativeId: 'native-' + id, name, provider: 'codex', state: 'idle', owner: 'self', messages: [], liveDraft: '', spaces: ['space'] });
  const reply = 'Needs your decision: two commits change the same column cache (commit 1 and r4). A: merge both; B: merge only commit 1.';
  const room = { id: 'space', queue: [{ id: 'item-1', text: 'Merge r4', status: 'waiting', sentTo: 'g', sentNative: 'native-g', reply, createdAt: 1 }] };
  context = vm.createContext({
    console, Date, setTimeout: () => 0, clearTimeout() {}, structuredClone, globalThis: null,
    state: { sessions: [session('g', 'Codex G'), session('h', 'Codex H')] },
    owner: 'self', disconnected: false, pendingInterrupts: new Set(), pendingMode: null, creatingSession: false, queueSpace: 'space',
    inputRecoveries: new Map(), sessionComposers: new Map(), draftRevisions: new Map(), queuedInputs: new Map(), dialogTickets: new WeakMap(),
    canResume: () => false, nativeUsable: s => s.state !== 'ended', heldElsewhere: s => s.owner !== 'self',
    inSpace: (s, id) => (s.spaces || []).includes(id), spaceRecord: id => id === 'space' ? room : null, queueMemberName: id => context.state.sessions.find(s => s.id === id)?.name || id,
    document: { body: new El('body'), activeElement: null, querySelector: () => null },
    $, node: (tag, value, cls) => { const e = new El(tag, context); if (value !== undefined) e.textContent = value; if (cls) e.className = cls; return e; },
    ui: {
      display: { unbind() {}, text: (e, k, p) => { e.textContent = text(k, p); }, computed: (e, prop, f) => { e.textContent = f(); }, attribute: (e, a, k, p) => { e.attributes[a] = text(k, p); } },
      showError: (e, error) => { e.textContent = error.message; },
    },
    uiText: text, participantLabel: s => s.name, providerName: p => p, sessionShortId: id => id, stateText: s => s.state,
    reportShown() {}, ensureMessages: () => undefined, stateArrivals: 0, nextStateArrival: async () => {},
    toastError: error => { context.toasted = error.message; }, toastMessage() {}, sessionNotice() {}, currentDialogTicket: () => false,
    staleMethodRefusals: new Set(['error.workspace.nativeWaitingInputUnavailable']),
    attempt: async action => { try { return await action(); } catch (error) { context.toasted = error.message; } },
    updateState() {}, renderQueue() {},
  });
  context.globalThis = context;
  context.documentRoot = new El('root', context);
  context.api = {
    send: async (id, value) => { calls.push({ method: 'send', id, text: value }); return 'tag-' + calls.length; },
    steer: async (id, value) => { calls.push({ method: 'steer', id, text: value }); return 'steer-tag'; },
    queue: async (id, value) => { calls.push({ method: 'queue', id, text: value }); return new Promise(() => {}); },
    spaceAction: async (roomId, action, args) => { resolves.push([roomId, action, ...args]); },
    initial: async () => ({}),
  };
  vm.runInContext(taskStream, context);
  vm.runInContext([
    renderer.match(/^const interruptPending = .*$/m)[0], renderer.match(/^const queuedRowFor = .*$/m)[0],
    take(renderer, 'soloAction'), take(renderer, 'sessionInputMethod'), take(renderer, 'sessionSendDisabled'),
    take(renderer, 'deliverSessionInput'), 'const openQueueMarks = new Set();',
  ].join('\n'), context);
  vm.runInContext(take(reading, 'readingDeliveryStatusKey') + '\n' + search, context);
  // The queue row itself, as renderQueue builds it, attached to the page.
  const row = (index = 0) => {
    const parts = vm.runInContext(`(${take(renderer, 'queueRow')})`, Object.assign(context, {
      uiNode: (tag, key, params, cls) => { const e = context.node(tag, undefined, cls); context.ui.display.text(e, key, params); return e; },
      uiButton: (key, action, cls) => { const e = context.node('button', undefined, cls); context.ui.display.text(e, key); e.addEventListener('click', () => context.attempt(action)); return e; },
      queueOutcomeNode: item => item.reply ? context.node('div', item.reply, 'queue-outcome') : null, queueReasonKey: () => '',
    }));
    const built = parts(room.queue[index], new Set(['g', 'h']));
    context.documentRoot.replaceChildren(built);
    const answer = built.find('queue-answer');
    const [box, foot, line, note] = answer?.children || [];
    return { built, answer, box: box?.tagName === 'TEXTAREA' ? box : undefined, send: foot?.children[1], why: foot?.children[0], line, note,
      handled: built.all().some(e => e.tagName === 'BUTTON' && e.textContent === 'Handled') };
  };
  const g = context.state.sessions[0];
  const deliver = status => {
    const row = g.messages.find(m => m.id === 'tag-1');
    if (row) row.status = status; else g.messages.push({ id: 'tag-1', role: 'user', text: 'x', status });
    context.followQueueAnswers();
  };
  return { context, $, calls, resolves, room, g, row, deliver, get: expr => vm.runInContext(expr, context) };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('a waiting row has an answer box whose first line quotes the question; the text survives a rebuilt row', () => {
  const f = page();
  let r = f.row();
  assert.ok(r.answer, 'the waiting row has an answer box');
  assert.equal(r.box.value, 'About “two commits change the same column cache”:\n', 'the quote line comes first, cut at the first clause');
  assert.equal(r.box.attributes['aria-label'], 'Answer Codex G');
  assert.equal(r.send.textContent, 'Send to Codex G');
  assert.ok(r.handled, '「已处理」 stays');
  r.box.focus(); r.box.type('Pick A.'); r.box.setSelectionRange(3, 5);
  const kept = f.context.queueAnswerFocus();
  r = f.row(); f.context.restoreQueueAnswerFocus(kept);
  assert.equal(r.box.value, 'Pick A.', 'the person\'s words are kept by item id, not by the node');
  assert.equal(f.context.document.activeElement, r.box, 'and so are its focus');
  assert.deepEqual([r.box.selectionStart, r.box.selectionEnd], [3, 5], 'and selection');
  r.box.type(''); assert.equal(r.send.disabled, true, 'an empty box sends nothing');
});

test('a look-at row or one in progress has no answer box', () => {
  const f = page();
  f.room.queue[0] = { ...f.room.queue[0], reason: 'no-reply' };
  assert.equal(f.row().answer, undefined);
  f.room.queue[0] = { ...f.room.queue[0], status: 'sent', reason: undefined };
  assert.equal(f.row().answer, undefined);
});

test('the answer goes once, to the item\'s own session; only its native receipt marks the row handled, with the answer', async () => {
  const f = page();
  let r = f.row(); r.box.type('Pick A.');
  r.send.click(); r.send.click(); await flush();
  assert.deepEqual(f.calls, [{ method: 'send', id: 'g', text: 'Pick A.' }], 'one send to Codex G with exactly the box text');
  r = f.row();
  assert.equal(r.box.readOnly, true, 'the text locks');
  assert.equal(r.box.value, 'Pick A.');
  assert.equal(r.line.textContent, 'To Codex G · Awaiting native confirmation');
  assert.deepEqual(f.resolves, [], 'a returned call is not a receipt');
  f.deliver('awaiting-native');
  assert.deepEqual(f.resolves, []);
  f.deliver('submitted');
  r.send.click(); f.context.followQueueAnswers(); await flush();
  assert.equal(f.calls.length, 1, 'never sent again');
  assert.deepEqual(f.resolves, [['space', 'queueResolve', 'item-1', 'Pick A.']], 'handled once, as the button does, with the answer');
  f.room.queue[0] = { ...f.room.queue[0], status: 'done', answer: { text: 'Pick A.', deliveredAt: 5 } };
  f.context.followQueueAnswers();
  r = f.row();
  assert.equal(r.box, undefined, 'a handled row has no box');
  assert.deepEqual(r.answer.children.map(e => e.textContent || e.children[0]?.textContent), ['To Codex G · Received by native session', 'Pick A.'], 'the stored answer and its receipt stay on the row');
});

test('a busy member: queued, still waiting for the person, handled once it is received', async () => {
  const f = page();
  Object.assign(f.g, { state: 'working', queueAvailable: true });
  let r = f.row(); r.box.type('Pick B.'); r.send.click(); await flush();
  assert.deepEqual(f.calls, [{ method: 'queue', id: 'g', text: 'Pick B.' }]);
  f.g.messages.push({ id: 'q-row', role: 'user', inputMode: 'queue', text: 'Pick B.', status: 'awaiting-native' }); f.context.followQueueAnswers();
  r = f.row();
  assert.equal(r.line.textContent, 'To Codex G · Queued; sends when idle');
  assert.deepEqual(f.resolves, []);
  f.g.messages[0].status = 'submitted'; f.context.followQueueAnswers(); await flush();
  assert.deepEqual(f.resolves, [['space', 'queueResolve', 'item-1', 'Pick B.']]);
});

test('an unconfirmed send is never sent again and never marks the row handled', async () => {
  const f = page();
  f.context.api.send = async (id, value) => { f.calls.push({ id, text: value }); throw new Error('socket closed'); };
  let r = f.row(); r.box.type('Pick A.'); r.send.click(); await flush();
  r = f.row();
  assert.equal(r.line.textContent, 'To Codex G · Receipt unconfirmed');
  assert.match(r.note.textContent, /won’t be sent again from here/);
  assert.equal(r.box.readOnly, true); assert.equal(r.send.parent.hidden, true, 'no send button');
  for (let i = 0; i < 3; i++) { r.send.click(); f.context.followQueueAnswers(); await flush(); }
  await f.context.queueAnswerSend(f.get("queueAnswers.get('item-1')"));
  assert.equal(f.calls.length, 1, 'not resent');
  assert.deepEqual(f.resolves, [], 'not handled');
  assert.ok(f.row().handled, 'the person checks and presses 已处理');
});

test('proof that nothing was sent unlocks the same words for the person to send again', async () => {
  const f = page();
  let n = 0;
  f.context.api.send = async (id, value) => { f.calls.push({ id, text: value }); if (++n === 1) throw Object.assign(new Error('Refused'), { notSent: true }); return 'tag-1'; };
  let r = f.row(); r.box.type('Pick A.'); r.send.click(); await flush();
  r = f.row();
  assert.equal(r.box.readOnly, false); assert.equal(r.box.value, 'Pick A.'); assert.equal(r.why.textContent, 'Refused');
  assert.equal(f.calls.length, 1, 'nothing goes by itself');
  r.send.click(); await flush();
  assert.equal(f.calls.length, 2);
});

test('the member\'s session ended or it left: only 「把这句话发给…」, which opens the send dialog with the text', async () => {
  for (const [change, why] of [[g => { g.state = 'ended'; }, 'Codex G’s session has ended, so this can’t be sent'],
    [g => { g.nativeId = 'native-successor'; }, 'Codex G’s session has ended, so this can’t be sent'],
    [g => { g.archived = true; }, 'Codex G’s session has ended, so this can’t be sent'],
    [g => { g.spaces = []; }, 'Codex G is no longer in this space']]) {
    const f = page();
    let r = f.row(); r.box.type('Pick A.');
    change(f.g); r = f.row();
    assert.equal(r.why.textContent, why);
    assert.equal(r.send.textContent, 'Send this to…');
    assert.equal(r.box.readOnly, false, 'the box stays editable'); assert.equal(r.box.value, 'Pick A.');
    r.send.click(); await flush();
    assert.deepEqual(f.calls, [], 'nothing sent to it or to a successor');
    assert.equal(f.$('send-dialog').open, true, 'the existing dialog opens');
    assert.equal(f.$('send-text').value, 'Pick A.');
    assert.equal(f.get('searchSend.prefer'), '', 'with no session chosen for the person');
    assert.deepEqual(f.resolves, []);
  }
});

test('a way that changed while messages loaded sends nothing and asks again', async () => {
  const f = page();
  let done;
  f.context.ensureMessages = () => new Promise(r => { done = r; });
  let r = f.row(); r.box.type('Pick A.'); r.send.click(); await flush();
  Object.assign(f.g, { state: 'working', queueAvailable: true }); done(); await flush();
  r = f.row();
  assert.deepEqual(f.calls, []);
  assert.match(r.why.textContent, /How this reaches Codex G changed/);
});

// The real spaceAction handler from main.cjs and the real room state.
function spaceAction(roomState) {
  const source = read('app/main.cjs');
  const start = source.indexOf("  register('spaceAction', async (c, roomId, action, args = []) => {"), end = source.indexOf("  register('spaceFiles',", start);
  let handler;
  vm.runInContext(source.slice(start, end), vm.createContext({ register: (_n, fn) => { handler = fn; }, validRoomId: () => true, uiError, roomState,
    broadcastRoom: async () => {}, queueDispatcher: { schedule() {} }, sessionLabels: { labels: new Map() },
    stewardCaller: async c => c.steward ? { id: 'butler', name: 'Butler' } : null }));
  return handler;
}
function waitingRoom(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-queue-answer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const room = new RoomState(dir), id = room.queueAdd('Merge r4', null, 'shared', { kind: 'person', name: 'You', sessionId: null });
  room.queueMarkSent('shared', id, 'g', 'Codex G', 1);
  room.queueSettle('shared', id, 'waiting', '', 'Codex G', 'Needs your decision: A or B?');
  return { dir, room, id };
}

test('only the person\'s window records an answer: an agent or the butler cannot, and the item stays waiting', async t => {
  const { dir, room, id } = waitingRoom(t), handler = spaceAction(room);
  const client = { call: async () => ({ sessions: [] }) };
  for (const c of [{ background: true, client }, { background: true, steward: true, client }]) {
    await assert.rejects(handler(c, 'shared', 'queueResolve', [id, 'Pick A.']), error => error.uiMessage?.key === 'error.queue.personOnly');
  }
  assert.equal(room.queueItems('shared')[0].status, 'waiting');
  assert.equal(room.queueItems('shared')[0].answer, undefined);
  await handler({}, 'shared', 'queueResolve', [id, 'Pick A.']);
  const item = new RoomState(dir).queueItems('shared')[0];
  assert.equal(item.status, 'done');
  assert.equal(item.answer.text, 'Pick A.');
  assert.ok(Number.isFinite(item.answer.deliveredAt) && item.answer.deliveredAt === item.finishedAt);
  assert.equal(item.finishedBy, undefined, 'the person, as with 已处理');
});

test('the butler still marks handled without an answer, and a null filler is no answer', async t => {
  const { room, id } = waitingRoom(t), handler = spaceAction(room);
  await handler({ background: true, steward: true, client: { call: async () => ({ sessions: [] }) } }, 'shared', 'queueResolve', [id, null]);
  const item = room.queueItems('shared')[0];
  assert.deepEqual([item.status, item.finishedBy, item.answer], ['done', 'steward', undefined]);
});

test('the room state keeps an answer only on a waiting item, from the person, in one checked field', t => {
  const { room, id } = waitingRoom(t);
  assert.throws(() => room.queueResolve(id, 'shared', 'steward', 'Pick A.'), error => error.uiMessage?.key === 'error.queue.notWaiting');
  assert.throws(() => room.queueResolve(id, 'shared', null, 'bad\u0001text'), error => error.uiMessage?.key === 'error.queue.invalid');
  assert.throws(() => room.queueResolve(id, 'shared', null, 'x'.repeat(6001)), error => error.uiMessage?.key === 'error.queue.invalid');
  assert.equal(room.queueItems('shared')[0].status, 'waiting', 'a refused answer changes nothing');
  const other = room.queueAdd('Other', 'g', 'shared', { kind: 'person', name: 'You', sessionId: null });
  assert.throws(() => room.queueResolve(other, 'shared', null, 'Pick A.'), error => error.uiMessage?.key === 'error.queue.notWaiting', 'a queued item takes no answer');
  room.queueResolve(id, 'shared', null, 'Pick A.');
  const item = room.queueItems('shared')[0];
  for (const bad of [{ text: 'a' }, { text: 'a', deliveredAt: 1, extra: 1 }, { text: '', deliveredAt: 1 }, 'Pick A.', [1, 2]]) {
    assert.throws(() => queueRules.validateQueue([{ ...item, answer: bad }]), /answer/, JSON.stringify(bad));
  }
});

// F's review Q2: the native session is the one NAW sent the item to, never the one the row first sees.
test('a native session changed before the row is first shown, or an item without the one it went to, gets only 「把这句话发给…」', async () => {
  for (const [change, why] of [[(f) => { f.g.nativeId = 'replacement-native-before-open'; }, 'Codex G’s session has ended, so this can’t be sent'],
    [(f) => { delete f.room.queue[0].sentNative; }, 'Can’t tell whether this is the session Codex G asked from, so this can’t be sent']]) {
    const f = page(), sent = [];
    f.context.api.send = async (id, text, native) => { sent.push({ id, text, native }); return 'tag-1'; };
    change(f);
    const r = f.row(); r.box.type('Answer for the original question');
    assert.equal(r.why.textContent, why);
    assert.equal(r.send.textContent, 'Send this to…');
    r.send.click(); await flush();
    await f.context.queueAnswerSend(f.get("queueAnswers.get('item-1')"));
    f.g.messages.push({ id: 'tag-1', role: 'user', text: 'Answer for the original question', status: 'submitted' }); f.context.followQueueAnswers(); await flush();
    assert.deepEqual(sent, [], 'nothing goes to the replacement or to an unproven session');
    assert.deepEqual(f.resolves, [], 'and the old question stays open');
    assert.equal(f.$('send-dialog').open, true, 'the person picks the recipient');
  }
});

test('after a reload the row sends to the same native session it went to, and is handled on that receipt', async () => {
  // A fresh page is what a reload gives: no box state, only the item and the sessions.
  const f = page(), sent = [];
  f.context.api.send = async (id, text, native) => { sent.push({ id, native }); return 'tag-1'; };
  assert.equal(f.get('queueAnswers.size'), 0);
  const r = f.row(); r.box.type('Pick A.');
  assert.equal(r.send.textContent, 'Send to Codex G');
  r.send.click(); await flush();
  assert.deepEqual(sent, [{ id: 'g', native: 'native-g' }]);
  f.deliver('submitted'); await flush();
  assert.deepEqual(f.resolves, [['space', 'queueResolve', 'item-1', 'Pick A.']]);
});

// F's review Q1: the receipt comes through the member's messages, which main sends only for subscribed sessions.
test('answers still waiting for their receipt keep their members subscribed when another session is shown; each late receipt handles its row once', async () => {
  const f = page(), shown = require(path.join(root, 'app/shown-sessions.cjs')), c = f.context, reported = [];
  f.room.queue.push({ ...f.room.queue[0], id: 'item-2', text: 'Ship r5', sentTo: 'h', sentNative: 'native-h', createdAt: 2 });
  c.state.sessions.push({ ...c.state.sessions[1], id: 'k', nativeId: 'native-k', name: 'Codex K', messages: [] });
  const full = { sessions: c.state.sessions };
  let serverShown = null;
  Object.assign(c, { selected: 'room', activeSessionId: () => c.selected === 'room' ? null : c.selected, members: () => c.state.sessions, render() {},
    projectSpace: v => v, legacyProgressOffline: () => false, latestViewStorage: undefined, queuedRoomInputs: new Map() });
  vm.runInContext(renderer.slice(renderer.indexOf('const shownPending = new Map();'), renderer.indexOf('function orderedMembers(')) + '\n' + take(renderer, 'updateState'), c);
  c.api.shownSessions = async ids => { reported.push(ids); const v = shown.reportShown(serverShown, ids, () => full); serverShown = v.shown; return v; };
  await c.reportShown();
  const held = new Map();
  c.api.send = (id, text) => { f.calls.push({ id, text }); return new Promise(resolve => held.set(id, resolve)); };
  f.row(0).box.type('Answer G'); const first = c.queueAnswerSend(f.get("queueAnswers.get('item-1')"));
  f.row(1).box.type('Answer H'); const second = c.queueAnswerSend(f.get("queueAnswers.get('item-2')"));
  await flush();
  // The queue closes and another session is shown.
  c.selected = 'k'; await c.reportShown();
  assert.deepEqual([...c.shownSessionIds()], ['g', 'h', 'k'], 'both targets stay subscribed');
  for (const [id, tag, text] of [['g', 'tag-g', 'Answer G'], ['h', 'tag-h', 'Answer H']]) full.sessions.find(s => s.id === id).messages.push({ id: tag, role: 'user', text, status: 'submitted' });
  c.updateState(shown.omitHidden(full, serverShown));
  assert.equal(c.state.sessions.find(s => s.id === 'g').messagesOmitted, undefined, 'the receipt reaches the page');
  held.get('g')('tag-g'); held.get('h')('tag-h'); await first; await second; await flush();
  c.updateState(shown.omitHidden(full, serverShown)); await flush();
  assert.deepEqual(f.resolves.map(r => [...r]), [['space', 'queueResolve', 'item-1', 'Answer G'], ['space', 'queueResolve', 'item-2', 'Answer H']], 'each row once, from its own receipt');
  assert.equal(f.calls.length, 2, 'nothing resent');
  // Handled: the follows end and so does the subscription.
  for (const item of f.room.queue) Object.assign(item, { status: 'done', answer: { text: 'x', deliveredAt: 3 } });
  c.followQueueAnswers(); await flush();
  assert.deepEqual([...c.shownSessionIds()], ['k']);
  assert.deepEqual([...reported.at(-1)], ['k'], 'main is told at once');
});

test('the item keeps the native session NAW sent it to; a requeue drops it, and the field is checked', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-queue-native-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const room = new RoomState(dir), id = room.queueAdd('Merge r4', null, 'shared', { kind: 'person', name: 'You', sessionId: null });
  room.queueMarkSent('shared', id, 'g', 'Codex G', 1, false, 'native-g');
  assert.equal(room.queueFind('shared', id).sentNative, 'native-g');
  room.queueSettle('shared', id, 'waiting', '', 'Codex G', 'Needs your decision: A or B?');
  assert.equal(room.queueFind('shared', id).sentNative, 'native-g', 'kept while it waits');
  const other = room.queueAdd('Ship r5', null, 'shared', { kind: 'person', name: 'You', sessionId: null });
  room.queueMarkSent('shared', other, 'g', 'Codex G', 1, false, 'native-g');
  room.queueRequeue('shared', other, 'busy', 5, 'Codex G');
  assert.equal(room.queueFind('shared', other).sentNative, undefined, 'a requeued item is not bound to a session');
  room.queueMarkSent('shared', other, 'g', 'Codex G', 2);
  assert.equal(room.queueFind('shared', other).sentNative, undefined, 'no native session, nothing kept');
  const base = room.queueFind('shared', id);
  for (const bad of ['', 'x\u0001', 'x'.repeat(2001), 7]) assert.throws(() => queueRules.validateQueue([{ ...base, sentNative: bad }]));
  assert.doesNotThrow(() => queueRules.validateQueue([base]));
});
