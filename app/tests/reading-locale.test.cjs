const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const locale = require('../ui-locale.js');
const source = fs.readFileSync(path.join(__dirname, '../renderer/reading-list.js'), 'utf8');
const bootstrap = fs.readFileSync(path.join(__dirname, '../dsh/bootstrap.js'), 'utf8');
const begin = bootstrap.indexOf('    function createDisplayBindings('), end = bootstrap.indexOf('    function mountWorkspace(', begin);
const createBindings = vm.runInNewContext('(' + bootstrap.slice(begin, end).trim() + ')');

class Element {
  constructor(tag = 'div', text = '') {
    this.tagName = tag; this.content = text; this.childNodes = []; this.attrs = new Map(); this.dataset = {}; this.style = {};
    this.textWrites = 0; this.clientHeight = 0; this.scrollTop = 0; this.scrollHeight = 500; this.isConnected = true; this.nodeType = 1;
    const classes = new Set();
    this.classList = { add: (...names) => names.forEach(n => classes.add(n)), remove: (...names) => names.forEach(n => classes.delete(n)), toggle(name, value) { const on = value ?? !classes.has(name); on ? classes.add(name) : classes.delete(name); return on; } };
  }
  get children() { return this.childNodes; }
  get childElementCount() { return this.childNodes.length; }
  get firstChild() { return this.childNodes[0] || null; }
  get nextSibling() { const a = this.parentElement?.childNodes || []; return a[a.indexOf(this) + 1] || null; }
  get textContent() { return this.content + this.childNodes.map(n => n.textContent).join(''); }
  set textContent(value) { this.textWrites++; this.content = String(value ?? ''); for (const child of this.childNodes) child.parentElement = null; this.childNodes = []; }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  hasAttribute(name) { return this.attrs.has(name); }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  removeAttribute(name) { this.attrs.delete(name); }
  append(...children) { for (const child of children) this.insertBefore(child, null); }
  insertBefore(child, reference) {
    if (child === reference) return child;
    child.remove(); const i = reference ? this.childNodes.indexOf(reference) : this.childNodes.length;
    assert.ok(i >= 0); this.childNodes.splice(i, 0, child); child.parentElement = this; return child;
  }
  replaceChildren(...children) { for (const child of this.childNodes) child.parentElement = null; this.childNodes = []; this.content = ''; this.append(...children); }
  remove() { if (!this.parentElement) return; const a = this.parentElement.childNodes; a.splice(a.indexOf(this), 1); this.parentElement = null; }
  before(child) { this.parentElement.insertBefore(child, this); }
  after(child) { this.parentElement.insertBefore(child, this.nextSibling); }
  addEventListener() {}
  removeEventListener() {}
  contains(other) { return other === this || this.childNodes.some(child => child.contains(other)); }
  getClientRects() { return []; }
  closest() { return null; }
  querySelectorAll(selector) {
    const marker = selector === '[data-naw-i18n-bound]';
    return this.childNodes.flatMap(child => [...(marker && child.hasAttribute('data-naw-i18n-bound') ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector() { return null; }
}
function fixture(messages, room = false, roomMetadata = {}, imageAPI = {}) {
  let language = 'zh', resolveCopy;
  const notices = [], copies = [], calls = [], markdown = [], root = new Element();
  const uiText = (key, params) => locale.format(language, key, params);
  const display = createBindings(uiText);
  const controls = new Map(['room-search', 'room-filter'].map(id => [id, { value: '' }]));
  const node = (tag, text, className) => { const el = new Element(tag); el.ownerDocument = document; if (text !== undefined) el.textContent = text; el.className = className || ''; return el; };
  const session = { id: 'session-A', name: 'USER 中文 name', nativeId: 'native-A', cwd: '/synthetic/project', provider: 'codex', state: 'idle', messages };
  const state = { sessions: [session], room: { id: 'shared', messages, ...roomMetadata }, viewState: { sharedDraft: '@USER 中文 UNSENT', privateDraft: 'PRIVATE 中文 UNSENT', owner: 'original-owner' } };
  const selection = { isCollapsed: true };
  const document = { activeElement: new Element('textarea'), createElement: tag => node(tag), addEventListener() {}, removeEventListener() {} };
  root.ownerDocument = document;
  const api = new Proxy({}, { get(_target, key) {
    if (Object.hasOwn(imageAPI, key)) return imageAPI[key];
    if (key === 'copy') return text => { copies.push(text); return new Promise(resolve => { resolveCopy = resolve; }); };
    calls.push(key); throw Error('Locale refresh called product API: ' + key);
  } });
  const context = vm.createContext({ console, Intl, Date, uiText, node, document, state, api,
    ui: { language: { getSnapshot: () => ({ active: language }) }, display, displayText: (raw, message) => locale.displayText(language, raw, message), createError: locale.createError, markdown(el, text) { markdown.push(text); el.textContent = text; }, clearMarkdown() {} },
    window: { nativeWorkspaceLocale: locale, getSelection: () => selection }, current: () => session,
    button: (text, action, cls) => { const el = node('button', text, cls); el.onclick = action; return el; },
    $: id => controls.get(id), roomMessageLabel: m => m.name || 'Original member',
    participantLabel: person => person.name, historicalParticipantLabel: (name, id) => name || id,
    roomThreads: { roots: new Map(), groups: new Map() },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, toast: text => notices.push(text), toastMessage: (key, params) => notices.push(uiText(key, typeof params === 'function' ? params() : params)),
    attempt() { throw Error('Unexpected actor'); },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/native-images.js'), 'utf8'), context);
  vm.runInContext(source, context);
  const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  const labelStart = renderer.indexOf('function mergeSourceLabel('), labelEnd = renderer.indexOf('function mergeCheckbox(', labelStart);
  assert.ok(labelStart >= 0 && labelEnd > labelStart);
  vm.runInContext(renderer.slice(labelStart, labelEnd), context);
  // Geometry is a separate, unchanged browser surface. The unit fixture never
  // schedules it, sends a message, or starts a terminal/provider/GUI process.
  vm.runInContext('scheduleReading = () => {}; updateJump = () => {};', context);
  context.messageList(root, messages, room, room ? 'room' : session.id);
  const view = vm.runInContext('messageViews.values().next().value', context);
  return { context, display, root, view, state, document, calls, copies, notices, markdown,
    controls, switch(value) { language = value; display.refresh(root); }, acceptCopy() { resolveCopy(); } };
}
const plain = value => JSON.parse(JSON.stringify(value));

test('typed own notices copy their visible language while retaining original records and clear stale metadata', async () => {
  const own = locale.createNotice('notice.legacyOffline'), rows = [{ id: 'own-notice', kind: 'notice', role: 'system', ...own }], original = rows[0].text;
  const f = fixture(rows), entry = f.view.entries.get('own-notice'), body = entry.body;
  f.switch('en'); assert.equal(entry.body, body); assert.equal(body.textContent, 'Connection status is unconfirmed. The last received process records are retained; current activity is unknown.');
  assert.equal(rows[0].text, original); assert.equal(entry.displayText, original); assert.deepEqual(f.markdown, []); assert.deepEqual(f.calls, []);
  const visibleAtClick = body.textContent, copy = entry.copyText.onclick(); assert.equal(f.copies[0], visibleAtClick); f.switch('zh'); assert.equal(f.copies[0], visibleAtClick); f.acceptCopy(); await copy;
  delete rows[0].uiMessage; f.context.messageList(f.root, rows, false, f.state.sessions[0].id); f.switch('zh');
  assert.equal(entry.body, body); assert.equal(body.textContent, original); assert.deepEqual(f.calls, []);
});

test('unknown notice metadata never translates native or user bodies', () => {
  const raw = 'ORIGINAL native 中文 <notice>{key}', rows = [{ id: 'unknown', role: 'system', kind: 'notice', text: raw, uiMessage: { version: 1, key: 'notice.unknownFuture', params: {} } },
    { id: 'user', role: 'user', text: raw, ...{ uiMessage: locale.createNotice('notice.legacyOffline').uiMessage } }];
  const f = fixture(rows); f.switch('en'); for (const row of rows) assert.equal(f.view.entries.get(row.id).body.textContent, raw); assert.deepEqual(f.calls, []);
});

test('legacy process metadata cannot reject or truncate a long original native title', () => {
  const renderer = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8'), nativeTitle = 'RAW 中文 '.repeat(5000), item = { id: 'tool-original', title: nativeTitle, text: 'ORIGINAL result 中文', status: 'complete' };
  const session = { id: 'session-A', provider: 'codex', messages: [], nativeBlockMapping: false }, cache = { items: new Map([[item.id, item]]) };
  const context = vm.createContext({ legacyProgress: new Map([[session.id, cache]]), legacyProgressOffline: () => false, ui: { createNotice: locale.createNotice }, freezeLegacyProgress() { throw Error('Unexpected state change'); } });
  const from = renderer.indexOf('function sessionMessages('), to = renderer.indexOf('function updateLegacyProgress(', from); assert.ok(from >= 0 && to > from);
  vm.runInContext(renderer.slice(from, to), context); const rows = plain(context.sessionMessages(session));
  assert.equal(rows[0].legacyOriginalTitle, nativeTitle); assert.equal(rows[0].text, item.text); assert.equal(rows[0].uiTitleMessage.params.title, '');
  const f = fixture(rows); f.switch('en'); const heading = f.view.entries.get(rows[0].id).heading.textContent;
  assert.ok(heading.includes(nativeTitle + ' · Retained-connection record')); assert.equal(f.view.entries.get(rows[0].id).body.textContent, item.text); assert.deepEqual(f.calls, []);
});

test('actual messageList changes labels and recorded dates without rerendering original bodies or reader state', async () => {
  const time = new Date(2026, 8, 6, 9, 5).getTime();
  const rows = [
    { id: 'input', role: 'user', kind: 'input', nativeBlock: true, nativeId: 'native-A', turnId: 'turn-A', text: 'USER RAW 中文 {author}', time },
    { id: 'answer', role: 'assistant', kind: 'response', nativeBlock: true, nativeId: 'native-A', turnId: 'turn-A', text: '<native data-naw-text="common.copy">复制</native>\nOriginal reply', status: 'complete', time },
    { id: 'end', role: 'system', kind: 'turn', nativeBlock: true, nativeId: 'native-A', turnId: 'turn-A', text: '', status: 'complete', nativeDurationMs: 3500, nativeCompletedAt: time + 60000 },
  ];
  const original = JSON.stringify(rows), f = fixture(rows), state = JSON.stringify(f.state);
  const input = f.view.entries.get('input'), answer = f.view.entries.get('answer'), turn = f.view.entries.get('end');
  const body = answer.body, heading = answer.heading, copy = answer.copyText;
  const timeNode = heading.childNodes.find(n => n.tagName === 'time');
  const writes = body.textWrites, beforeClock = timeNode.textContent, fold = { choice: true };
  f.view.folds = fold; f.view.el.scrollTop = 123;
  f.document.activeElement = copy;
  const pendingCopy = f.context.copyReadingMessage(answer);
  assert.deepEqual(f.copies, [rows[1].text]);
  f.switch('en');
  assert.equal(answer.body, body); assert.equal(answer.heading, heading); assert.equal(answer.copyText, copy);
  assert.equal(body.textContent, rows[1].text); assert.equal(body.textWrites, writes); assert.equal(f.markdown.length, 1);
  assert.equal(copy.textContent, 'Copy'); assert.equal(copy.getAttribute('aria-label'), 'Copy: reply from Codex');
  assert.equal(input.heading.firstChild.textContent, 'You'); assert.equal(f.view.older.textContent, 'Show earlier records');
  assert.notEqual(timeNode.textContent, beforeClock);
  assert.equal(timeNode.dateTime, new Date(time).toISOString());
  assert.ok(timeNode.getAttribute('aria-label').startsWith('Recorded at: '));
  assert.ok(turn.footer.getAttribute('aria-label').includes('Duration 3s'));
  assert.equal(f.view.folds, fold); assert.equal(f.view.el.scrollTop, 123); assert.equal(f.document.activeElement, copy);
  assert.equal(JSON.stringify(rows), original); assert.equal(JSON.stringify(f.state), state); assert.deepEqual(f.calls, []);
  answer.copyLabel = () => 'WRONG LATER TARGET'; answer.displayText = 'WRONG LATER PAYLOAD';
  f.acceptCopy(); await pendingCopy;
  assert.deepEqual(f.notices, ['Copied: reply from Codex']); assert.deepEqual(f.copies, [rows[1].text]);
});

test('delivery state and details change language while exact delivered content and open disclosure remain', () => {
  const body = 'EXACT delivered 中文\n{status} <native>复制</native>';
  const rows = [{ id: 'shared-row', role: 'human', name: 'RAW USER 中文', nativeId: 'native-A', turnId: 'turn-A', text: body, time: 1000,
    deliveryTracked: true, deliveries: [{ id: 'receipt', recipientId: 'session-A', status: 'submitted', text: body }] }];
  const f = fixture(rows, true), entry = f.view.entries.get('shared-row'), row = entry.deliveryRows.get('receipt');
  entry.delivery.open = true;
  const payload = row.payload, writes = payload.textWrites, snapshot = JSON.stringify(f.state);
  f.switch('en');
  assert.equal(row.payload, payload); assert.equal(payload.textContent, body); assert.equal(payload.textWrites, writes);
  assert.equal(entry.delivery.open, true);
  assert.ok(entry.deliverySummary.textContent.includes('Received by native session'));
  assert.ok(row.label.textContent.includes('USER 中文 name'));
  assert.ok(entry.deliveryNote.textContent.startsWith('This is the body delivered'));
  assert.equal(JSON.stringify(f.state), snapshot); assert.deepEqual(f.calls, []);
});

test('a merged snapshot retains historical receipts and source identity while its own labels change language', () => {
  const body = 'EXACT SOURCE BODY 中文 {recipient}';
  const source = { roomId: 'source-A', messageId: 'original-record' };
  const rows = [{ id: 'copied-row', role: 'human', name: 'Original shared author', text: body, time: 1000, deliveryTracked: true,
    snapshotBatch: 'original-batch', snapshotSource: source,
    deliveries: [{ id: 'old-receipt', recipientId: 'session-A', recipientName: 'HISTORICAL RECIPIENT', status: 'submitted', text: body }] }];
  const sources = [{ id: 'source-A', name: 'RAW 中文 space' }, { id: 'source-B', name: 'RAW 中文 space' }];
  const f = fixture(rows, true, { merge: { sources } }), entry = f.view.entries.get('copied-row');
  const receipt = entry.deliveryRows.get('old-receipt'), payload = receipt.payload, writes = payload.textWrites;
  const badge = entry.heading.childNodes.find(el => el.className === 'snapshot-source'), action = badge.onclick;
  const snapshot = JSON.stringify(f.state); entry.delivery.open = true;
  f.switch('en');
  assert.equal(badge.textContent, 'From RAW 中文 space · source-A · snapshot');
  assert.equal(badge.onclick, action); assert.equal(entry.delivery.open, true);
  assert.ok(entry.deliverySummary.textContent.startsWith('Source receipts · '));
  assert.ok(receipt.label.textContent.startsWith('Originally sent to HISTORICAL RECIPIENT'));
  assert.ok(!receipt.label.textContent.includes('USER 中文 name'), 'A current renamed session cannot replace the historical recipient');
  assert.equal(entry.deliveryNote.textContent, 'This is a source-space record. Merging grants no new sending or execution authority.');
  assert.equal(receipt.payload, payload); assert.equal(payload.textContent, body); assert.equal(payload.textWrites, writes);
  assert.equal(JSON.stringify(f.state), snapshot); assert.deepEqual(f.calls, []);
});

test('changing display language does not alter group IDs, original native summaries or authorization boundaries', () => {
  const f = fixture([]);
  const read = (id, sourceTag) => ({ id, role: 'tool', toolKind: 'commandExecution', nativeId: 'native-A', turnId: 'turn-A', sharedStream: true, nativeMessageId: 'native:' + id, sessionId: 'session-A', sourceTag, time: 1000,
    status: 'complete', commandSource: 'agent', commandActions: [{ type: 'read', command: 'cat ' + id, name: id, path: '/synthetic/' + id }], text: 'RAW ORIGINAL ' + id });
  const rows = [read('a', 'scope-A'), read('b', 'scope-A'), read('c', 'scope-B')], original = JSON.stringify(rows);
  const before = plain([...f.context.commandExplorations(rows, true, rows)]);
  f.switch('en');
  const after = plain([...f.context.commandExplorations(rows, true, rows)]);
  const sourceFacts = groups => groups.map(([id, { caption, ...facts }]) => [id, facts]);
  assert.deepEqual(sourceFacts(after), sourceFacts(before));
  assert.equal(before[0][1].caption, '2 次读取'); assert.equal(after[0][1].caption, 'Reads: 2');
  assert.equal(before.length, 2); assert.equal(before[0][1].summary, 'Read a, b');
  assert.equal(JSON.stringify(rows), original); assert.deepEqual(f.calls, []);
});

test('existing process disclosures repaint their counts and outcomes without regrouping or replacing original tool output', () => {
  const rows = ['a', 'b'].map((id, index) => ({ id, role: 'tool', kind: 'tool', nativeBlock: true, nativeId: 'native-A', turnId: 'turn-A', title: 'Bash', toolKind: 'commandExecution', text: 'ORIGINAL output 中文 ' + id, status: index ? 'failed' : 'complete' }));
  const f = fixture(rows), before = JSON.stringify(rows), group = [...f.view.groups.values()][0], bodies = rows.map(row => f.view.entries.get(row.id).body);
  group.disclosure.open = true; const wrapper = group.item, writes = bodies.map(body => body.textWrites); f.switch('en');
  assert.equal(group.item, wrapper); assert.equal(group.disclosure.open, true); assert.equal(group.caption.textContent, 'Commands: 2'); assert.equal(group.outcome.textContent, 'Failed 1');
  assert.match(group.summary.getAttribute('aria-label'), /Commands: 2 · Failed 1/);
  bodies.forEach((body, index) => { assert.equal(body.textContent, rows[index].text); assert.equal(body.textWrites, writes[index]); });
  assert.equal(JSON.stringify(rows), before); assert.deepEqual(f.calls, []);
});

function searchFixture(messages, notes = '') {
  const f = fixture(messages), c = f.context;
  for (const id of ['search-scope', 'search-archived', 'search-input', 'search-options', 'search-dialog', 'search-preview-body', 'search-preview', 'search-results', 'search-count', 'search-options-summary', 'search-more', 'search-preview-title', 'search-preview-copy', 'search-preview-back', 'search-button']) {
    const el = new Element(); f.controls.set(id, el); f.root.append(el);
    el.focus = () => { f.document.activeElement = el; };
  }
  const focused = new Element('option'); focused.value = 'current';
  f.controls.get('search-scope').append(focused);
  f.controls.get('search-scope').querySelector = selector => { assert.equal(selector, '[value="current"]'); return focused; };
  const dialog = f.controls.get('search-dialog');
  dialog.showModal = () => { dialog.open = true; }; dialog.close = () => { dialog.open = false; };
  f.document.querySelector = selector => { assert.equal(selector, 'dialog[open]'); return dialog.open ? dialog : null; };
  f.document.activeElement.focus = () => {};
  c.window.nativeWorkspaceSearch = require('../renderer/local-search.js');
  const room = { id: 'archived-space', name: 'RAW 中文 room', archived: true, messages, notes };
  f.state.room = room; f.state.rooms = [room];
  Object.assign(c, { clearTimeout, structuredClone, spaceId: 'shared', selected: 'session-A', roomSession: '', roomSurface: 'overview', mode: 'chat', pendingRoomFilter: '', roomThread: '',
    activeSessionId: () => 'session-A', sessionShortId: id => id.slice(0, 6), spaceRecord: id => id === room.id ? room : null });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/search-view.js'), 'utf8'), c);
  c.openSearch();
  return { ...f, dialog, room, focused, get: id => f.controls.get(id) };
}

test('actual local search keeps query, original result nodes and an archived raw preview open while language changes', async () => {
  const raw = 'needle 中文 <native>{status} 复制</native>';
  const f = searchFixture([{ id: 'message', role: 'assistant', text: raw }]);
  f.get('search-input').value = 'needle'; f.get('search-input').selectionStart = 2;
  f.get('search-archived').checked = true; f.get('search-options').open = true;
  f.context.renderSearch();
  const first = f.get('search-results').firstChild, snippet = first.childNodes.at(-1), writes = snippet.textWrites;
  await f.context.openSearchResult({ kind: 'shared', roomId: f.room.id, messageId: 'message' });
  const body = f.get('search-preview-body'), bodyWrites = body.textWrites;
  const focused = f.document.activeElement, snapshot = JSON.stringify(f.state);
  f.switch('en');
  assert.equal(f.get('search-results').firstChild, first); assert.equal(first.childNodes.at(-1), snippet);
  assert.equal(snippet.textContent, raw); assert.equal(snippet.textWrites, writes);
  assert.equal(body.textContent, raw); assert.equal(body.textWrites, bodyWrites);
  assert.equal(f.get('search-preview').hidden, false); assert.equal(f.get('search-results').hidden, true);
  assert.equal(f.get('search-preview-title').textContent, 'RAW 中文 room · archived, read-only');
  assert.ok(f.get('search-count').textContent.includes('results')); assert.ok(f.get('search-options-summary').textContent.includes('Including archived'));
  assert.equal(f.focused.textContent, 'Current session: USER 中文 name');
  assert.equal(f.get('search-input').value, 'needle'); assert.equal(f.get('search-input').selectionStart, 2);
  assert.equal(f.get('search-archived').checked, true); assert.equal(f.get('search-options').open, true);
  assert.equal(f.document.activeElement, focused); assert.equal(JSON.stringify(f.state), snapshot); assert.deepEqual(f.calls, []);
});

test('an archived app summary copies its current visible language and closing prevents stale text from returning', async () => {
  const f = searchFixture([], 'RAW notes 中文 {count} <native>');
  await f.context.openSearchResult({ kind: 'room', roomId: f.room.id });
  f.switch('en');
  const text = f.get('search-preview-body').textContent;
  assert.ok(text.includes('Shared messages: 0.')); assert.ok(text.endsWith('Shared notes:\nRAW notes 中文 {count} <native>'));
  f.context.attempt = action => action();
  const pending = f.get('search-preview-copy').onclick();
  f.switch('zh'); assert.deepEqual(f.copies, [text]);
  f.acceptCopy(); await pending;
  f.dialog.close(); f.context.finishSearch(); f.switch('en');
  assert.equal(f.get('search-preview-body').textContent, ''); assert.equal(f.get('search-preview-title').textContent, '');
  assert.equal(f.get('search-input').value, ''); assert.equal(f.get('search-count').textContent, '');
  assert.deepEqual(f.calls, []);
});

// Exercise the actual image component with the same display bindings as the reader.
// Every image operation below resolves an in-memory fixture; no OS clipboard is used.
function imageLocaleFixture(images = [{}], status = 'complete') {
  let language = 'zh', owner = 'OWNER raw 中文';
  const host = new Element(), observers = [], previews = [], expands = [], copies = [], releases = [], effects = [];
  const document = { createElement(tag) { const el = new Element(tag); el.ownerDocument = document; return el; } };
  host.ownerDocument = document;
  const uiText = (key, params) => locale.format(language, key, params), display = createBindings(uiText);
  const pending = (queue, arg) => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); queue.push({ arg, resolve, reject }); return promise; };
  const api = { previewImage: source => pending(previews, plain(source)), expandImage: token => pending(expands, token), copyImage: token => pending(copies, token), releaseImage: token => { releases.push(token); return Promise.resolve(); } };
  const context = vm.createContext({ window: { IntersectionObserver: class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {} disconnect() { effects.push('unobserve'); }
  } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/native-images.js'), 'utf8'), context);
  const widget = context.window.nativeWorkspaceImages.mount(host, api, {
    display, text: uiText, displayText: (raw, message) => locale.displayText(language, raw, message), createError: locale.createError,
    beforeLayout: () => effects.push('beforeLayout'), onLayout: () => effects.push('layout'), onOpen: (key, open) => effects.push(['fold', key, open]),
  });
  const source = { kind: 'session', sessionId: 'session-A', nativeId: 'native-A', messageId: 'image-row' };
  const update = () => widget.update(images, source, () => owner, status);
  update();
  const item = host.firstChild, toggle = item.childNodes[0], caption = item.childNodes[1], copy = item.childNodes[2].childNodes[0], note = item.childNodes[2].childNodes[1];
  return { widget, host, item, toggle, caption, copy, note, previews, expands, copies, releases, effects, images, source, update,
    start() { observers[0].callback([{ isIntersecting: true }]); },
    switch(value) { language = value; display.refresh(host); },
    owner(value) { owner = value; update(); },
    async settle() { await new Promise(resolve => setImmediate(resolve)); },
  };
}
const previewPixels = { token: 'owned-token', key: 'original-fold-key', thumbnail: 'data:image/png;base64,THUMB', width: 32, height: 16 };

test('image labels repaint while a preview is pending and retain the same pixels, source, fold and token afterward', async () => {
  const f = imageLocaleFixture(), refs = JSON.stringify(f.images); f.start();
  assert.equal(f.note.textContent, '正在读取图片…');
  const beforePending = JSON.stringify(f.effects); f.switch('en');
  assert.equal(f.toggle.textContent, 'Native image 1'); assert.equal(f.copy.textContent, 'Copy image'); assert.equal(f.note.textContent, 'Reading image…');
  assert.equal(JSON.stringify(f.effects), beforePending); assert.equal(f.previews.length, 1); assert.equal(f.expands.length, 0); assert.equal(f.copies.length, 0);
  f.previews[0].resolve(previewPixels); await f.settle();
  const image = f.toggle.firstChild, src = image.src, effects = JSON.stringify(f.effects);
  assert.equal(image.tagName, 'img'); assert.equal(f.note.textContent, ''); assert.equal(f.copy.disabled, false);
  assert.equal(image.getAttribute('alt'), 'Native image 1');
  f.switch('zh'); f.switch('en');
  assert.equal(f.toggle.firstChild, image); assert.equal(image.src, src); assert.equal(f.note.textContent, '');
  assert.equal(f.toggle.getAttribute('aria-expanded'), 'false'); assert.equal(f.toggle.getAttribute('aria-busy'), null);
  assert.equal(f.toggle.getAttribute('title'), 'Native image 1\n32 × 16');
  assert.equal(JSON.stringify(f.effects), effects); assert.equal(f.previews.length, 1); assert.equal(f.releases.length, 0); assert.equal(JSON.stringify(f.images), refs);
  assert.deepEqual(f.previews[0].arg, { ...f.source, index: 0 });
  const expanding = f.toggle.onclick(); await f.settle(); assert.equal(f.expands[0].arg, 'owned-token');
  const beforeExpand = JSON.stringify(f.effects); f.switch('zh'); assert.equal(JSON.stringify(f.effects), beforeExpand);
  f.expands[0].resolve('data:image/png;base64,FULL'); await expanding;
  assert.equal(f.toggle.firstChild, image); assert.equal(image.src, 'data:image/png;base64,FULL'); assert.equal(f.item.dataset.expanded, 'true');
  const copying = f.copy.onclick(); f.switch('en'); assert.equal(f.copies[0].arg, 'owned-token'); f.copies[0].resolve(); await copying;
  assert.equal(f.note.textContent, 'Copied image · Native image 1'); f.switch('zh'); assert.equal(f.note.textContent, '已复制图片 · 原生图片 1');
  f.widget.dispose(); assert.deepEqual(f.releases, ['owned-token']); f.switch('en'); assert.equal(f.host.childNodes.length, 0);
});

test('image names and owners stay raw, and cached updates relabel without another preview or token release', async () => {
  const f = imageLocaleFixture([{ path: '/synthetic/原名 {key}.png' }]); f.start(); f.previews[0].resolve(previewPixels); await f.settle();
  const image = f.toggle.firstChild, original = JSON.stringify(f.images); f.owner('NEW raw 中文 <owner>');
  const effects = JSON.stringify(f.effects); f.switch('en');
  assert.equal(f.toggle.firstChild, image); assert.equal(f.caption.textContent, '原名 {key}.png'); assert.equal(image.getAttribute('alt'), '原名 {key}.png');
  assert.equal(f.toggle.getAttribute('title'), '/synthetic/原名 {key}.png\n32 × 16');
  assert.equal(f.toggle.getAttribute('aria-label'), 'View image (NEW raw 中文 <owner>) 原名 {key}.png');
  assert.equal(f.copy.getAttribute('aria-label'), 'Copy image (NEW raw 中文 <owner>) 原名 {key}.png');
  assert.equal(f.previews.length, 1); assert.equal(f.releases.length, 0); assert.equal(JSON.stringify(f.effects), effects); assert.equal(JSON.stringify(f.images), original);
  f.widget.dispose();
});

test('known image format errors translate without stale loading, and unknown failures retain exact original detail', async () => {
  const f = imageLocaleFixture(); f.start(); f.previews[0].resolve({ ...previewPixels, thumbnail: 'invalid-format' }); await f.settle();
  assert.equal(f.note.textContent, '图片不可用 · 图片缩略图格式无效。'); f.switch('en');
  assert.equal(f.note.textContent, 'Image unavailable · Invalid image thumbnail format.'); assert.equal(f.toggle.textContent, 'Retry image preview');
  const retry = f.toggle.onclick(); assert.equal(f.previews.length, 2); f.previews[1].reject(Error('RAW 原文 <native>{error}')); await retry;
  assert.equal(f.note.textContent, 'Image unavailable · RAW 原文 <native>{error}'); f.switch('zh');
  assert.equal(f.note.textContent, '图片不可用 · RAW 原文 <native>{error}'); assert.equal(f.previews.length, 2); assert.equal(f.expands.length, 0);
  f.widget.dispose();
});

test('unavailable and unconfirmed image wrappers repaint without acquiring image pixels', () => {
  for (const [images, status, expected] of [
    [[{ unavailable: 'RAW 原生 detail' }], 'complete', 'Image unavailable · RAW 原生 detail'],
    [[{}], 'started', 'Waiting for native image confirmation'],
    [require('../native-images.cjs').userImageReferences([{ type: 'image' }]), 'complete', 'Image unavailable \u00b7 The native record did not provide a readable local image path.'],
  ]) {
    const f = imageLocaleFixture(images, status); f.switch('en'); assert.equal(f.note.textContent, expected); assert.equal(f.toggle.disabled, true);
    assert.equal(f.previews.length, 0); assert.equal(f.expands.length, 0); assert.equal(f.copies.length, 0); assert.equal(f.releases.length, 0); f.widget.dispose();
  }
});


test('the actual reader image call keeps its owner fallback live without replaying pixels on a locale change', async () => {
  const rows = [{ id: 'actual-image', role: 'user', kind: 'input', nativeBlock: true, nativeId: 'native-A', status: 'submitted', text: 'RAW image body', images: [{}] }];
  let reads = 0; const releases = [];
  const f = fixture(rows, false, {}, { previewImage: async () => { reads++; return previewPixels; }, releaseImage: token => { releases.push(token); return Promise.resolve(); } });
  await new Promise(resolve => setImmediate(resolve));
  f.state.sessions[0].name = '';
  f.context.messageList(f.root, rows, false, f.state.sessions[0].id);
  const entry = f.view.entries.get('actual-image'), host = entry.body.nextSibling, toggle = host.firstChild.firstChild, image = toggle.firstChild, snapshot = JSON.stringify(f.state), writes = entry.body.textWrites;
  f.switch('en');
  assert.equal(toggle.firstChild, image); assert.equal(toggle.getAttribute('aria-label'), 'View image (You) Native image 1');
  assert.equal(image.getAttribute('alt'), 'Native image 1'); assert.equal(entry.body.textContent, 'RAW image body'); assert.equal(entry.body.textWrites, writes);
  assert.equal(JSON.stringify(f.state), snapshot); assert.equal(reads, 1); assert.deepEqual(releases, []); assert.deepEqual(f.calls, []);
  entry.images.dispose(); assert.deepEqual(releases, ['owned-token']);
});


test('a stale own notice descriptor cannot hide an appended original body or change its copy', async () => {
  const own = locale.createNotice('notice.legacyOffline'), raw = own.text + '\nRAW appended 原文 <native>{key}';
  const rows = [{ id: 'stale-notice', role: 'system', kind: 'notice', ...own, text: raw }], f = fixture(rows), entry = f.view.entries.get('stale-notice');
  f.switch('en'); assert.equal(entry.body.textContent, raw);
  const copying = entry.copyText.onclick(); assert.deepEqual(f.copies, [raw]); f.acceptCopy(); await copying;
  assert.equal(rows[0].text, raw); assert.deepEqual(f.calls, []);
});

test('an explicitly owned system error body switches its bound causes while retaining the raw error and record', () => {
  const inner = locale.createError('error.sessionMissing'), outer = locale.createError('error.workspace.gitFailureContext', { reason: inner.message, target: '/synthetic/raw 中文', branch: 'RAW {branch}' }, { cause: inner, param: 'reason' });
  const rows = [{ id: 'own-error-notice', role: 'system', kind: 'notice', text: outer.message, uiMessage: outer.uiMessage }], before = JSON.stringify(rows), f = fixture(rows);
  f.switch('en'); const text = f.view.entries.get('own-error-notice').body.textContent;
  assert.equal(text, locale.errorText('en', outer)); assert.ok(text.includes('/synthetic/raw 中文')); assert.ok(text.includes('RAW {branch}'));
  assert.equal(JSON.stringify(rows), before); assert.deepEqual(f.calls, []);
});


test('an own automatic-continuation clock formats from the original recorded instant and copies only the visible language', async () => {
  const time = new Date(2026, 8, 6, 19, 5).getTime(), rawClock = new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const own = locale.createNotice('notice.capacityAutoContinueRouting', { time: rawClock, attempt: 2 });
  const rows = [{ id: 'clock', role: 'system', name: 'NAW', kind: 'notice', ...own, time }, { id: 'raw-clock', role: 'system', kind: 'notice', text: own.text, time }], before = JSON.stringify(rows), f = fixture(rows);
  f.switch('en');
  const expected = locale.format('en', own.uiMessage.key, { ...own.uiMessage.params, time: new Date(time).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' }) });
  const entry = f.view.entries.get('clock'); assert.equal(entry.body.textContent, expected); assert.equal(f.view.entries.get('raw-clock').body.textContent, own.text);
  const copying = entry.copyText.onclick(); f.switch('zh'); assert.deepEqual(f.copies, [expected]); f.acceptCopy(); await copying;
  assert.equal(JSON.stringify(rows), before); assert.deepEqual(f.calls, []);
});


test('legacy owned hook title localizes in its existing wrapper, then same-id raw replacement clears the heading cache without touching native body', () => {
  const renderer = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8'), own = locale.createNotice('notice.run.approval');
  const item = { id: 'hook-same', title: own.text, uiTitleMessage: own.uiMessage, text: 'RAW 原生通知 result', status: 'observed' };
  const session = { id: 'session-A', provider: 'claude', messages: [], nativeBlockMapping: false }, cache = { items: new Map([[item.id, item]]) };
  const context = vm.createContext({ legacyProgress: new Map([[session.id, cache]]), legacyProgressOffline: () => false, ui: { createNotice: locale.createNotice }, freezeLegacyProgress() { throw Error('Unexpected state change'); } });
  const from = renderer.indexOf('function sessionMessages('), to = renderer.indexOf('function updateLegacyProgress(', from);
  vm.runInContext(renderer.slice(from, to), context); const rows = plain(context.sessionMessages(session));
  const f = fixture(rows); f.switch('en'); const entry = f.view.entries.get(rows[0].id), body = entry.body, originalHeading = entry.heading;
  assert.ok(entry.heading.textContent.includes('Waiting for native permission approval · Retained-connection record'));
  assert.equal(body.textContent, item.text);
  const markdownCalls = f.markdown.length;
  delete rows[0].legacyOriginalTitleUiMessage;
  f.context.messageList(f.root, rows, false, f.state.sessions[0].id);
  assert.equal(entry.heading, originalHeading); assert.ok(entry.heading.textContent.includes(own.text + ' · Retained-connection record'));
  f.switch('zh'); f.switch('en'); assert.ok(entry.heading.textContent.includes(own.text + ' · Retained-connection record'));
  assert.equal(entry.body, body); assert.equal(body.textContent, item.text); assert.equal(f.markdown.length, markdownCalls); assert.deepEqual(f.calls, []);
});


test('typed room events repaint while their raw note body and untagged native lookalike stay unchanged', () => {
  const own = locale.createNotice('notice.room.joined'), rows = [{ id: 'event', role: 'system', kind: 'join', ...own }, { id: 'native-lookalike', role: 'system', kind: 'join', text: own.text }];
  const f = fixture(rows, true), raw = JSON.stringify(rows); f.switch('en');
  assert.equal(f.view.entries.get('event').body.textContent, 'Joined the workspace · No history sent or model notified'); assert.equal(f.view.entries.get('native-lookalike').body.textContent, own.text);
  assert.equal(JSON.stringify(rows), raw); assert.deepEqual(f.calls, []);
});


test('imported snapshot event paragraphs use the existing metadata binding and preserve full notes and raw untagged events', () => {
  const own = locale.createNotice('notice.room.notesUpdated', { text: 'RAW note 中文 <tag>{key}\n' }), raw = 'RAW native 中文 event';
  const f = fixture([]), material = new Element(); f.controls.set('space-snapshot-materials', material); f.root.append(material);
  f.context.roomSurface = 'records'; f.state.room.merge = { stage: 'ready', sources: [{ id: 'shared', name: 'RAW source 中文' }], notes: [{ roomId: 'shared', text: 'RAW imported note 中文' }], events: [{ roomId: 'shared', events: [{ ...own }, { text: raw }] }] };
  f.context.uiNode = (tag, key, params) => { const element = new Element(tag); f.display.text(element, key, params); return element; };
  f.context.uiButton = (_key, _action, cls) => new Element('button');
  const renderer = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8'), start = renderer.indexOf('function renderSnapshotMaterials('), end = renderer.indexOf('function ', start + 10); assert.ok(start >= 0 && end > start);
  vm.runInContext(renderer.slice(start, end), f.context); f.context.renderSnapshotMaterials(); const before = JSON.stringify(f.state.room.merge), details = material.children[1], note = details.children[1], owned = details.children[2];
  f.switch('en'); assert.equal(owned.textContent, 'Shared notes updated (not yet sent to an agent)\nRAW note 中文 <tag>{key}\n'); assert.equal(details.children[3].textContent, raw); assert.equal(note.textContent, 'RAW imported note 中文');
  assert.equal(JSON.stringify(f.state.room.merge), before); assert.deepEqual(f.calls, []);
});


test('only the two explicit owned legacy tool wrappers repaint; native text, raw lookalikes and clipboard payload remain exact', async () => {
  const body = 'RAW original 中文 <tag>{key}\n', notice = locale.createNotice('notice.legacy.nonText', { text: body });
  const rows = [{ id: 'owned-legacy', role: 'tool', source: 'claude-native-message', ...notice }, { id: 'native-raw', role: 'tool', text: notice.text }, { id: 'other-meta', role: 'tool', ...locale.createNotice('notice.run.approval') }];
  const f = fixture(rows), raw = JSON.stringify(rows); f.switch('en'); const entry = f.view.entries.get(rows[0].id);
  assert.equal(entry.body.textContent, body + '\nIncludes non-text results. View them in the native terminal.'); assert.equal(f.view.entries.get('native-raw').body.textContent, notice.text); assert.equal(f.view.entries.get('other-meta').body.textContent, rows[2].text);
  const copy = entry.copyText.onclick(); assert.equal(f.copies[0], entry.body.textContent); f.acceptCopy(); await copy; assert.equal(JSON.stringify(rows), raw); assert.deepEqual(f.calls, []);
});
test('advanced fleet metadata repaints all three own fallback names in place while exact native names and events stay raw', () => {
  const f = fixture([]), renderer = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8'), start = renderer.indexOf('  a.fleet.replaceChildren('), end = renderer.indexOf('\n  a.stop.hidden', start); assert.ok(start >= 0 && end > start);
  const names = ['notice.fleet.nativeTeamActivity', 'notice.fleet.codexNativeChild', 'notice.fleet.codexChild'].map(key => { const own = locale.createNotice(key); return { event: 'RAW_event', name: own.text, nameUiMessage: own.uiMessage }; });
  names.push({ event: 'RAW_event', name: names[0].name }); const fleet = new Element(); f.root.append(fleet); f.context.a = { fleet }; f.context.s = { fleet: names }; const raw = JSON.stringify(names);
  vm.runInContext(renderer.slice(start, end), f.context); const nodes = [...fleet.children]; f.switch('en');
  assert.deepEqual(fleet.children.map(n => n.textContent), ['RAW_event · Native team activity', 'RAW_event · Codex native child agent', 'RAW_event · Codex child agent', 'RAW_event · 原生团队活动']);
  assert.deepEqual(fleet.children, nodes); assert.equal(JSON.stringify(names), raw); assert.deepEqual(f.calls, []);
});


test('only NAW-owned gap status labels switch language; raw native statuses and same-row ownership removal stay raw', () => {
  const notice = locale.createNotice('notice.observation.nativeContentGap'), rows = [{ id: 'owned-gap', kind: 'gap', role: 'system', nativeBlock: true, status: 'unconfirmed', ...notice }, { id: 'raw-native', kind: 'gap', role: 'system', nativeBlock: true, status: 'unconfirmed', text: notice.text }];
  const f = fixture(rows), entry = f.view.entries.get(rows[0].id), raw = JSON.stringify(rows);
  assert.ok(entry.heading.textContent.includes('结果未确认')); assert.ok(f.view.entries.get('raw-native').heading.textContent.includes('unconfirmed'));
  f.switch('en'); assert.ok(entry.heading.textContent.includes('Result unconfirmed')); assert.equal(JSON.stringify(rows), raw);
  delete rows[0].uiMessage; f.context.messageList(f.root, rows, false, f.state.sessions[0].id); f.switch('zh'); assert.ok(entry.heading.textContent.includes('unconfirmed')); assert.deepEqual(f.calls, []);
});
