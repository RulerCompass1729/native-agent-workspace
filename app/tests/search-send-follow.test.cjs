const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
// The send dialog's own receipt, unconfirmed outcome and frozen form (review F, f7f33a0d B1–B3), on the real
// renderer/search-view functions with a synthetic page, IPC and clock. NAW_SEARCH_SEND_ROOT: an older tree, to
// check these tests fail on it.
const root = process.env.NAW_SEARCH_SEND_ROOT || path.join(__dirname, '../..');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const search = fs.readFileSync(path.join(root, 'app/renderer/search-view.js'), 'utf8');
const reading = fs.readFileSync(path.join(root, 'app/renderer/reading-list.js'), 'utf8');
const messages = require(path.join(root, 'app/ui-messages.js'));

function take(source, name) {
  const start = source.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, 'missing ' + name);
  const next = /\n(?:async )?function /g;
  next.lastIndex = start + 1;
  const end = next.exec(source);
  return source.slice(start, end ? end.index : source.length);
}

class El {
  constructor(id = '') {
    Object.assign(this, { id, open: false, disabled: false, readOnly: false, value: '', textContent: '', hidden: false, children: [] });
    this.classList = { toggle() {}, remove() {}, add() {} };
  }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  focus() { this.page.document.activeElement = this; }
  showModal() { this.open = true; }
  close() {
    this.open = false;
    if (this.id === 'send-dialog') this.page.finishSearchSend();
  }
  querySelector() { return this.action || null; }
}

function page(locale = 'en') {
  const elements = new Map(), calls = [];
  let context;
  const $ = id => {
    if (!elements.has(id)) { const e = new El(id); e.page = context; elements.set(id, e); }
    return elements.get(id);
  };
  const text = (key, params = {}) => {
    const values = typeof params === 'function' ? params() : params;
    return (messages[locale][key] || key).replace(/\{(\w+)\}/g, (_, k) => String(values[k]));
  };
  const session = (id, name) => ({ id, nativeId: 'native-' + id, name, provider: 'claude', state: 'idle', owner: 'self', messages: [], liveDraft: '' });
  context = vm.createContext({
    console, Date, setTimeout: () => 0, clearTimeout() {}, structuredClone,
    state: { sessions: [session('a', 'Actor A'), session('b', 'Actor B')] },
    owner: 'self', disconnected: false, pendingInterrupts: new Set(), pendingMode: null, creatingSession: false,
    inputRecoveries: new Map(), sessionComposers: new Map(), draftRevisions: new Map(), queuedInputs: new Map(), dialogTickets: new WeakMap(),
    canResume: () => false, nativeUsable: () => true, heldElsewhere: s => s.owner !== 'self',
    document: { body: new El('body'), activeElement: null, querySelector: () => null },
    $, node: tag => Object.assign(new El(), { tagName: tag.toUpperCase() }),
    ui: {
      display: { unbind() {}, text: (e, k, p) => { e.textContent = text(k, p); }, computed: (e, prop, f) => { e.textContent = f(); } },
      showError: (e, error) => { e.textContent = error.message; },
    },
    uiText: text, participantLabel: s => s.name, providerName: p => p, sessionShortId: id => id, stateText: s => s.state,
    reportShown() {}, ensureMessages: () => undefined, stateArrivals: 0, nextStateArrival: async () => {},
    toastError: error => { $('toast').hidden = false; $('toast-text').textContent = error.message; },
    toastMessage: (key, params) => { $('toast').hidden = false; $('toast-text').textContent = text(key, params); },
    sessionNotice: () => { $('toast').hidden = false; $('toast').action = {}; },
    currentDialogTicket: () => false, staleMethodRefusals: new Set(['error.workspace.nativeWaitingInputUnavailable']),
  });
  context.api = {
    send: async (id, value) => { calls.push({ method: 'send', id, text: value }); return 'tag-' + calls.length; },
    steer: async (id, value) => { calls.push({ method: 'steer', id, text: value }); return 'steer-tag'; },
    queue: async (id, value) => { calls.push({ method: 'queue', id, text: value }); return new Promise(() => {}); },
  };
  vm.runInContext([
    renderer.match(/^const interruptPending = .*$/m)[0],
    take(renderer, 'soloAction'), take(renderer, 'sessionInputMethod'), take(renderer, 'sessionSendDisabled'),
    take(renderer, 'deliverSessionInput'), take(renderer, 'followQueuedInput'),
  ].join('\n'), context);
  vm.runInContext(take(reading, 'readingDeliveryStatusKey') + '\n' + search, context);
  const queueing = s => Object.assign(s, { state: 'working', queueAvailable: true });
  return { context, $, calls, a: context.state.sessions[0], queueing, get: expr => vm.runInContext(expr, context) };
}
const refusal = (message, extra = {}) => Object.assign(new Error(message), extra);
const flush = () => new Promise(resolve => setImmediate(resolve));

test('a send from the dialog keeps its own queue mark: the composer\'s row is not its receipt (B1)', async () => {
  const f = page(), s = f.queueing(f.a);
  const input = { value: 'composer draft' }, binding = { ui: { input, setValue: v => { input.value = v; return true; } } };
  f.context.sessionComposers.set('a', binding); f.context.draftRevisions.set('a', 7);
  let composerDone, searchRefuse, n = 0;
  f.context.api.queue = (id, value) => {
    f.calls.push({ method: 'queue', id, text: value });
    return ++n === 1 ? new Promise(r => { composerDone = r; }) : new Promise((_, r) => { searchRefuse = r; });
  };
  const composer = f.context.deliverSessionInput(s, { method: 'queue' }, 'composer draft', 7);
  const composerMark = f.context.queuedInputs.get('a');
  f.context.openSearchSend('search sentence', 'a');
  const sending = f.context.confirmSearchSend();
  assert.equal(f.context.queuedInputs.get('a'), composerMark, 'the composer mark is not replaced');
  // The composer's own row arrives first, still waiting for native: it clears the composer only.
  s.messages.push({ id: 'composer-row', text: 'composer draft', inputMode: 'queue', status: 'awaiting-native' });
  f.context.followQueuedInput('a', composerMark); f.context.followSearchSend();
  assert.equal(input.value, '', 'the composer clears for its own queued row');
  assert.equal(composerMark.tag, 'composer-row');
  assert.equal(f.$('send-dialog').open, true, 'the dialog does not take the composer row as its receipt');
  assert.equal(f.$('toast-text').textContent, '', 'no notice yet');
  searchRefuse(refusal('Second queue refused', { notSent: true })); await sending;
  assert.equal(f.$('send-dialog').open, true);
  assert.equal(f.$('send-text').value, 'search sentence', 'its words stay');
  assert.equal(f.$('send-note').textContent, 'Second queue refused', 'with its own error');
  assert.ok(!f.$('send-confirm').disabled, 'proven not sent: it may be sent again');
  composerDone('composer-row'); await composer;
  assert.deepEqual(f.calls.map(c => c.text), ['composer draft', 'search sentence']);
});

test('a dialog\'s queued row does not clear an unrelated composer draft (B1, the other way)', () => {
  const f = page(), s = f.queueing(f.a);
  const input = { value: 'my own words' }, binding = { ui: { input, setValue: v => { input.value = v; return true; } } };
  f.context.sessionComposers.set('a', binding); f.context.draftRevisions.set('a', 3);
  f.context.deliverSessionInput(s, { method: 'queue' }, 'my own words', 3);
  const composerMark = f.context.queuedInputs.get('a');
  s.messages.push({ id: 'search-row', text: 'search sentence', inputMode: 'queue', status: 'awaiting-native' });
  f.context.followQueuedInput('a', composerMark);
  assert.equal(input.value, 'my own words'); assert.equal(composerMark.tag, undefined);
  s.messages.push({ id: 'own-row', text: 'my own words', inputMode: 'queue', status: 'awaiting-native' });
  f.context.followQueuedInput('a', composerMark);
  assert.equal(composerMark.tag, 'own-row'); assert.equal(input.value, '');
});

// Review F r2: the same words queued from the composer and the dialog at once. updateState follows the composer first.
const arrive = f => {
  for (const [id, mark] of f.context.queuedInputs) f.context.followQueuedInput(id, mark);
  f.context.followSearchSend();
};
const waitingRefusal = () => refusal('Waiting input refused', { uiMessage: { version: 1, key: 'error.workspace.nativeWaitingInputUnavailable' } });
for (const schedule of ['submitted-first', 'awaiting-then-submitted']) {
  test(`the same words queued from the composer first: its row is not the dialog's receipt (B1 r2, ${schedule})`, async () => {
    const f = page(), s = f.queueing(f.a), words = 'same sentence';
    const input = { value: words };
    f.context.sessionComposers.set('a', { ui: { input, setValue: v => { input.value = v; return true; } } }); f.context.draftRevisions.set('a', 7);
    let composerDone, dialogRefuse, n = 0;
    f.context.api.queue = (id, value) => {
      f.calls.push({ method: 'queue', id, text: value });
      return ++n === 1 ? new Promise(r => { composerDone = r; }) : new Promise((_, r) => { dialogRefuse = r; });
    };
    const composer = f.context.deliverSessionInput(s, { method: 'queue' }, words, 7);
    f.context.openSearchSend(words, 'a');
    const sending = f.context.confirmSearchSend();
    s.messages.push({ id: 'composer-row', text: words, inputMode: 'queue', status: schedule === 'submitted-first' ? 'submitted' : 'awaiting-native' });
    arrive(f);
    if (schedule === 'awaiting-then-submitted') { s.messages[0].status = 'submitted'; arrive(f); }
    assert.equal(f.$('send-dialog').open, true, 'the dialog does not take the composer row');
    assert.equal(f.$('toast-text').textContent, '', 'no notice');
    assert.equal(input.value, words, 'neither entry takes the row by its words; the composer keeps them until its call answers');
    dialogRefuse(waitingRefusal()); await sending;
    assert.equal(f.$('send-dialog').open, true);
    assert.equal(f.$('send-text').value, words, 'its words stay');
    assert.equal(f.$('send-note').textContent, 'Waiting input refused', 'with its own error');
    assert.ok(!f.$('send-confirm').disabled);
    composerDone('composer-row'); await composer;
    assert.equal(f.calls.length, 2);
  });
}

test('the same words queued from the dialog first: its row clears no composer and its receipt names it (B1 r2)', async () => {
  const f = page(), s = f.queueing(f.a), words = 'same sentence';
  const input = { value: words };
  f.context.sessionComposers.set('a', { ui: { input, setValue: v => { input.value = v; return true; } } }); f.context.draftRevisions.set('a', 7);
  let dialogDone, composerRefuse, n = 0;
  f.context.api.queue = (id, value) => {
    f.calls.push({ method: 'queue', id, text: value });
    return ++n === 1 ? new Promise(r => { dialogDone = r; }) : new Promise((_, r) => { composerRefuse = r; });
  };
  f.context.openSearchSend(words, 'a');
  const sending = f.context.confirmSearchSend();
  const composer = f.context.deliverSessionInput(s, { method: 'queue' }, words, 7);
  s.messages.push({ id: 'dialog-row', text: words, inputMode: 'queue', status: 'awaiting-native' });
  arrive(f);
  assert.equal(input.value, words, 'the composer is not cleared by the dialog row');
  assert.equal(f.$('toast-text').textContent, '');
  composerRefuse(waitingRefusal()); await composer.catch(() => {});
  assert.equal(f.context.queuedInputs.has('a'), false);
  arrive(f);
  assert.equal(input.value, words, 'the refused composer keeps its words');
  s.messages[0].status = 'submitted'; dialogDone('dialog-row'); await sending;
  assert.equal(f.$('send-dialog').open, false);
  assert.equal(f.$('toast-text').textContent, 'Actor A: Received by native session', 'the dialog\'s own receipt');
});

test('a queue with no other open call of the same words still finds its own row by them (B1 r2)', async () => {
  const f = page(), s = f.queueing(f.a);
  s.messages.push({ id: 'earlier', text: 'same sentence', inputMode: 'queue', status: 'submitted' });
  f.context.openSearchSend('same sentence', 'a');
  f.context.confirmSearchSend();
  s.messages.push({ id: 'own', text: 'same sentence', inputMode: 'queue', status: 'awaiting-native' });
  arrive(f);
  assert.equal(f.$('send-dialog').open, false, 'closed on its own recorded row');
  assert.equal(f.get('searchSendFollow').mark.tag, 'own');
});

for (const locale of ['en', 'zh']) {
  test(`an unconfirmed queue stays unconfirmed past any wait and its late row decides; one request (B2, ${locale})`, async () => {
    const f = page(locale), s = f.queueing(f.a);
    f.context.api.queue = async (id, value) => { f.calls.push({ method: 'queue', id, text: value }); throw refusal('Uncertain queue transport failure'); };
    f.context.openSearchSend('queued sentence', 'a');
    await f.context.confirmSearchSend();
    const note = f.$('send-note').textContent;
    assert.equal(note, messages[locale]['send.unconfirmed'].replace('{name}', 'Actor A'));
    assert.ok(locale === 'zh' ? /没能确认/.test(note) : /Couldn’t confirm/.test(note));
    assert.equal(f.$('send-dialog').open, true); assert.equal(f.$('send-confirm').disabled, true);
    assert.equal(f.$('send-text').readOnly, true, 'the words stay as sent');
    await f.context.confirmSearchSend();
    f.context.followSearchSend();
    assert.equal(f.calls.length, 1, 'nothing re-offered while no row is known');
    // The row arrives long after the call failed.
    s.messages.push({ id: 'late', text: 'queued sentence', inputMode: 'queue', status: 'unconfirmed' });
    f.context.followSearchSend();
    assert.equal(f.$('send-dialog').open, false);
    assert.equal(f.$('toast-text').textContent, messages[locale]['delivery.recipient'].replace('{recipient}', 'Actor A').replace('{status}', messages[locale]['delivery.unconfirmed']));
    assert.equal(f.calls.length, 1);
  });
}

test('a late row that proves not sent offers the same words again (B2)', async () => {
  const f = page(), s = f.queueing(f.a);
  f.context.api.queue = async (id, value) => { f.calls.push({ method: 'queue', id, text: value }); throw refusal('Uncertain queue transport failure'); };
  f.context.openSearchSend('queued sentence', 'a');
  await f.context.confirmSearchSend();
  assert.equal(f.$('send-confirm').disabled, true);
  s.messages.push({ id: 'late', text: 'queued sentence', inputMode: 'queue', status: 'not-sent' });
  f.context.followSearchSend();
  assert.equal(f.$('send-dialog').open, true); assert.equal(f.$('send-text').value, 'queued sentence');
  assert.equal(f.$('send-note').textContent, 'Actor A: Not sent');
  assert.ok(!f.$('send-confirm').disabled); assert.equal(f.$('send-text').readOnly, false);
});

test('a row still awaiting native when the call fails keeps the dialog unconfirmed until it records the outcome (B2)', async () => {
  const f = page(), s = f.queueing(f.a);
  f.context.api.queue = async (id, value) => {
    f.calls.push({ method: 'queue', id, text: value });
    s.messages.push({ id: 'row', text: value, inputMode: 'queue', status: 'awaiting-native' });
    throw refusal('Uncertain');
  };
  f.context.openSearchSend('queued sentence', 'a');
  await f.context.confirmSearchSend();
  assert.equal(f.$('send-dialog').open, true); assert.equal(f.$('send-confirm').disabled, true);
  f.context.followSearchSend();
  assert.equal(f.$('send-dialog').open, true, 'still waiting for the outcome');
  s.messages[0].status = 'not-sent'; f.context.followSearchSend();
  assert.ok(!f.$('send-confirm').disabled); assert.equal(f.calls.length, 1);
});

test('a refusal recorded before anything was sent keeps the words and its error (B2)', async () => {
  const f = page(), s = f.queueing(f.a);
  f.context.api.queue = async () => { f.calls.push('queue'); throw refusal('Not ready', { uiMessage: { version: 1, key: 'error.workspace.nativeWaitingInputUnavailable' } }); };
  f.context.openSearchSend('queued sentence', 'a');
  await f.context.confirmSearchSend();
  assert.equal(f.$('send-note').textContent, 'Not ready'); assert.ok(!f.$('send-confirm').disabled);
  assert.equal(f.get('searchSendFollow'), null); assert.equal(s.messages.length, 0);
});

test('while the click waits for messages the words and recipient are frozen; Cancel still works (B3)', async () => {
  for (const cancel of [false, true]) {
    const f = page();
    let release;
    f.a.messagesOmitted = true;
    f.context.ensureMessages = () => new Promise(r => { release = r; });
    f.context.openSearchSend('original confirmed sentence', 'a');
    const sending = f.context.confirmSearchSend();
    const rowB = f.get("searchSend.rows.find(x => x.id === 'b')");
    assert.equal(f.$('send-text').readOnly, true);
    assert.equal(rowB.ui.radio.disabled, true); assert.equal(f.get('searchSend.newRow.ui.radio.disabled'), true);
    f.context.searchSendChoose({ target: { name: 'send-target', value: 'b' } });
    assert.equal(f.get('searchSend.selected'), 'a', 'a change of recipient is not taken');
    assert.equal(f.$('send-cancel').disabled, false);
    if (cancel) f.$('send-dialog').close();
    f.a.messagesOmitted = false; release(); await sending; await flush();
    assert.deepEqual(f.calls, cancel ? [] : [{ method: 'send', id: 'a', text: 'original confirmed sentence' }]);
    assert.equal(f.$('send-text').readOnly, false);
  }
});
