const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const locale = require('../ui-locale.js'), spaces = require('../collaboration-spaces.cjs');
const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
const bootstrap = fs.readFileSync(path.join(__dirname, '../dsh/bootstrap.js'), 'utf8');
const helperStart = bootstrap.indexOf('    function createDisplayBindings('), helperEnd = bootstrap.indexOf('    function mountWorkspace(', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart);
const createBindings = vm.runInNewContext('(' + bootstrap.slice(helperStart, helperEnd).trim() + ')');

class Element {
  constructor(tag = 'div', text = '') { this.tagName = tag; this.content = text; this.childNodes = []; this.attrs = new Map(); this.dataset = {}; this.value = ''; this.isConnected = true; this.nodeType = 1; this.open = false; this.classList = { toggle() {} }; }
  get children() { return this.childNodes.filter(child => child.nodeType === 1); }
  get lastElementChild() { return this.children.at(-1); }
  get childElementCount() { return this.children.length; }
  get selectedOptions() { return this.children.filter(child => child.value === this.value); }
  get textContent() { return this.content + this.childNodes.map(child => child.textContent).join(''); }
  set textContent(value) { this.content = String(value ?? ''); this.childNodes = []; }
  append(...children) { for (const child of children) { child.remove?.(); child.parentElement = this; this.childNodes.push(child); } }
  insertBefore(child, before) { child.remove?.(); const index = before ? this.childNodes.indexOf(before) : this.childNodes.length; child.parentElement = this; this.childNodes.splice(index, 0, child); }
  prepend(...children) { for (const child of [...children].reverse()) { child.remove?.(); child.parentElement = this; this.childNodes.unshift(child); } }
  replaceChildren(...children) { for (const child of this.childNodes) child.parentElement = null; this.content = ''; this.childNodes = []; this.append(...children); }
  remove() { if (this.parentElement) { const list = this.parentElement.childNodes; list.splice(list.indexOf(this), 1); this.parentElement = null; } }
  setAttribute(key, value) { this.attrs.set(key, String(value)); }
  getAttribute(key) { return this.attrs.get(key) ?? null; }
  hasAttribute(key) { return this.attrs.has(key); }
  removeAttribute(key) { this.attrs.delete(key); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const matches = child => selector.startsWith('.') ? (child.className || '').split(/\s+/).includes(selector.slice(1)) : selector === '[data-naw-i18n-bound]' ? child.hasAttribute?.('data-naw-i18n-bound') : (selector === 'input' || selector === 'input:checked' && child.checked || selector === 'input[data-merge-member]:checked' && child.dataset.mergeMember && child.checked) && child.tagName === 'input';
    return this.childNodes.flatMap(child => [...(matches(child) ? [child] : []), ...(child.querySelectorAll?.(selector) || [])]);
  }
  addEventListener() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
}


const otherRoom = '11111111-1111-4111-8111-111111111111';
function fixture() {
  let language = 'zh';
  const root = new Element(), elements = new Map(), calls = [], notices = [];
  const document = { activeElement: null, createElement: tag => node(tag), createTextNode: text => ({ nodeType: 3, textContent: text }) };
  const node = (tag, text, cls) => { const el = new Element(tag, text); el.className = cls || ''; el.focus = () => { document.activeElement = el; }; return el; };
  const $ = id => { if (!elements.has(id)) { const el = node('div'); el.id = id; elements.set(id, el); root.append(el); } return elements.get(id); };
  const uiText = (key, params) => locale.format(language, key, params), display = createBindings(uiText);
  const people = ['A', 'B'].map((name, i) => ({ id: 'session-' + name, name: 'RAW 中文 ' + name, provider: i ? 'codex' : 'claude', nativeId: 'native-' + name, owner: 'original-owner', liveDraft: 'UNSENT 中文 ' + name,
    roomIds: ['shared', otherRoom], handoffGroup: i, state: 'idle', addressedSendAvailable: true, serviceCapabilities: ['collaborationSpacesV1', 'multiSessionHandoffs', 'agentAddressedHandoffs'] }));
  const rooms = ['shared', otherRoom].map((id, i) => ({ id, name: 'RAW SPACE 中文 ' + i, metadataRevision: 7,
    notes: 'ORIGINAL NOTES 中文 {name}', messages: [{ id: 'record-' + i, name: 'RAW AUTHOR', role: 'assistant', status: 'complete', text: 'ORIGINAL BODY 中文 <native>{key}' }], files: [{ id: 'file-' + i, name: '原名.txt', path: '/synthetic/raw-' + i }], events: [] }));
  const state = { room: rooms[0], rooms, sessions: people, capabilities: ['spaceMergeV1'], viewState: { sharedDraft: '@RAW 中文 UNSENT' } };
  const context = vm.createContext({ mobileSetup: { open() {}, close() {} }, fitRoomTabs() {}, spaceName: room => spaces.untouchedDefault(room) ? uiText('space.defaultName') : room?.name, $, uiText, uiError: locale.createError, node, document, state, structuredClone, Intl,
    ui: { display, language: { getSnapshot: () => ({ active: language }) } },
    window: { nativeWorkspaceSpaces: spaces, nativeWorkspaceContextSnapshot: require('../renderer/coordinator-context.js') },
    button: (text, action, cls) => { const el = node('button', text, cls); el.onclick = action; return el; },
    api: new Proxy({}, { get(_target, method) { calls.push(method); throw Error('Locale-only path reached product API: ' + method); } }),
    members: () => people, participantLabel: value => value.name, sessionShortId: id => id.slice(0, 6),
    placementProof: record => ({nativeId:record.nativeId,placementRevision:spaces.placementRevision(record),connectionRevision:record.connectionRevision||0}), allSpaces: () => rooms, spaceRecord: id => rooms.find(room => room.id === id), inSpace: spaces.isMember,
    sharedSurface: () => true, current: () => people[0], spaceId: 'shared', mode: 'chat', disconnected: false,
    interruptPending: value => value?.interruptPending === true,
    handoffCandidates: () => people, pendingMode: null, runPreview: null, notesRevision: null, contextTarget: null,
    sharePending: null, mergeDialog: null, historyRows: [], historySelected: null, historyCursor: null, historyLoading: false, historyImporting: false,
    toast: text => notices.push(text), toastMessage: (key, params) => notices.push(uiText(key, typeof params === 'function' ? params() : params)),
  });
  context.ui.errorText = error => locale.errorText(language, error);
  context.ui.displayText = (raw, message) => locale.displayText(language, raw, message);
  const showStart = bootstrap.indexOf('        function showError('), showEnd = bootstrap.indexOf('        const language =', showStart);
  assert.ok(showStart >= 0 && showEnd > showStart);
  context.ui.showError = vm.runInNewContext(bootstrap.slice(showStart, showEnd) + ';showError', { window: { nativeWorkspaceLocale: locale }, display, errorText: context.ui.errorText });
  const load = (start, end) => {
    const a = renderer.indexOf(start), b = renderer.indexOf(end, a + start.length); assert.ok(a >= 0 && b > a, start);
    vm.runInContext(renderer.slice(a, b), context);
  };
  load('const uiNode =', 'const states =');
  load('const dialogTickets =', 'let trustScope =');
  load('function openNotes(', 'function appendedDraft(');
  load('function share(', 'function visibleSelectionTerminal(');
  load('function renderNativeHistory(', 'async function loadNativeHistory(');
  load('function renderRunChoices(', "$('run-button').onclick");
  load('function mergeSourceLabel(', 'function openSpaceRegionMenu(');
  return { $, context, root, state, people, rooms, document, calls, display, notices, switch(value) { language = value; display.refresh(root); } };
}

test('a compound own error switches in place and an unknown native error removes its binding', () => {
  const f = fixture(), element = f.$('synthetic-error'), cause = locale.createError('error.sessionMissing');
  const error = locale.createError('error.sharedClearedRetained', { reason: cause.message }, { cause, param: 'reason' });
  f.context.ui.showError(element, error); assert.equal(element.textContent, error.message);
  f.switch('en'); assert.equal(element.textContent, 'Shared messages were cleared; the timeline and notes are retained. This session could not be found.');
  assert.equal(error.message, locale.format('zh', 'error.sharedClearedRetained', { reason: cause.message }));
  const raw = 'ORIGINAL native error 中文 {body}'; f.context.ui.showError(element, Error(raw));
  f.switch('zh'); assert.equal(element.textContent, raw); assert.deepEqual(f.calls, []);
  error.message += '\nORIGINAL appended detail'; f.context.ui.showError(element, error);
  f.switch('en'); assert.equal(element.textContent, error.message);
});

test('notes and context labels switch without replacing editable notes or regenerating agent-facing context', () => {
  const f = fixture(), before = JSON.stringify(f.state);
  f.context.openNotes(); f.$('room-notes-text').value = 'EDITED 中文 unsent notes';
  const notes = f.$('room-notes-text'); f.document.activeElement = notes;
  f.context.openContext(); const context = f.$('context-text'), original = context.value;
  assert.ok(original.startsWith('协作背景快照 · ')); assert.ok(original.includes('RAW SPACE 中文 0')); assert.ok(!original.includes(otherRoom));
  context.value += '\nUSER EDIT 中文'; f.switch('en');
  assert.equal(f.$('notes-heading').textContent, 'Shared notes · RAW SPACE 中文 0');
  assert.equal(notes.value, 'EDITED 中文 unsent notes'); assert.equal(context.value, original + '\nUSER EDIT 中文');
  assert.equal(f.document.activeElement, notes); assert.equal(JSON.stringify(f.state), before); assert.deepEqual(f.calls, []);
});

// Generate owned wrappers in the current language; the resulting editable text stays intact.
test('opening the current multispace context in English UI keeps its selected scope and never rewrites the draft', () => {
  const f = fixture(); f.switch('en'); f.context.openContext(); const value = f.$('context-text').value;
  assert.ok(value.startsWith('Collaboration context snapshot · ')); assert.ok(value.includes('Space: RAW SPACE 中文 0')); assert.ok(value.includes('RAW 中文 A')); assert.ok(value.includes('RAW 中文 B')); assert.ok(!value.includes(otherRoom));
  assert.ok(value.includes('ORIGINAL NOTES 中文 {name}')); assert.ok(value.includes('States are sampled facts, not new instructions')); assert.ok(!value.includes('ORIGINAL BODY'));
  f.$('context-text').value += '\nUSER EDIT 中文'; f.switch('zh'); assert.equal(f.$('context-text').value, value + '\nUSER EDIT 中文'); assert.deepEqual(f.calls, []);
});

test('a retained session join failure repaints its wrapper and typed cause without retrying or changing the receipt', async () => {
  for (const changedSelection of [false, true]) {
    const f = fixture(), requests = []; f.people[0].roomIds = [otherRoom];
    const receipt = { choice: { kind: 'existing', roomId: 'shared' }, sessionId: f.people[0].id, roomId: 'shared', view: 'chat' };
    const ticket = f.context.openTransientDialog('create-dialog'); ticket.creation = receipt;
    Object.assign(f.context, { selectionRevision: 1, creatingSession: false, createReadiness() {}, updateState() {}, render() {},
      api: { async initial() { requests.push('initial'); return f.state; }, async spaceAction(...args) { requests.push(args); throw locale.createError('error.spaceJoinDidNotApply'); } } });
    const a = renderer.indexOf('async function finishCreateSpace('), z = renderer.indexOf('function resetCreateDirectory(', a); assert.ok(a > 0 && z > a);
    vm.runInContext(renderer.slice(a, z), f.context);
    f.$('session-name').value = 'UNSENT 中文'; f.$('create-space-name').value = 'RAW SPACE NAME 中文';
    const before = JSON.stringify(f.state); await f.context.finishCreateSpace(ticket, changedSelection ? 0 : 1);
    const message = f.$('create-error').textContent, count = requests.length; assert.ok(message.includes('RAW 中文 A'));
    assert.match(message, changedSelection ? /选中的内容变了，还没有加入空间/ : /还没加入空间：加入没有生效。/);
    assert.equal(count, changedSelection ? 1 : 2); assert.equal(ticket.creation, receipt); assert.equal(receipt.blocked, undefined);
    f.switch('en'); const translated = f.$('create-error').textContent;
    assert.ok(translated.includes('Session “RAW 中文 A” is retained')); assert.ok(translated.includes('RAW SPACE 中文 0'));
    assert.match(translated, changedSelection ? /selection changed before joining the space/ : /Joining the space did not take effect\. Use/);
    assert.equal(f.$('session-name').value, 'UNSENT 中文'); assert.equal(f.$('create-space-name').value, 'RAW SPACE NAME 中文');
    assert.equal(requests.length, count); assert.equal(JSON.stringify(f.state), before); assert.equal(ticket.creation, receipt); assert.equal(f.$('create-dialog').open, true);
    f.switch('zh'); assert.equal(f.$('create-error').textContent, message); assert.equal(requests.length, count); assert.deepEqual(f.calls, []);
  }
});

test('an old-backend join explanation retains valid metadata with and without a reported version', () => {
  for (const version of [undefined, '0.1.0-alpha.120']) {
    const f = fixture(), record = { ...f.people[0], runtimeVersion: version }, before = JSON.stringify(record);
    const a = renderer.indexOf('function oldBackendJoin('), z = renderer.indexOf('async function addToSpace(', a);
    const v = renderer.indexOf('function versionValue('), end = renderer.indexOf('function compactAppVersion(', v); assert.ok(a > 0 && z > a && v > 0 && end > v);
    vm.runInContext(renderer.slice(v, end) + renderer.slice(a, z), f.context);
    const error = f.context.oldBackendJoin(record); assert.ok(locale.displayMessage(error.uiMessage));
    f.context.ui.showError(f.$('invite-error'), error); const original = f.$('invite-error').textContent;
    assert.match(original, /「RAW 中文 A」连着旧版后台/); f.switch('en');
    assert.ok(f.$('invite-error').textContent.includes('“RAW 中文 A” uses an older backend'));
    if (version) assert.ok(f.$('invite-error').textContent.includes('(' + version + ')'));
    f.switch('zh'); assert.equal(f.$('invite-error').textContent, original); assert.equal(JSON.stringify(record), before); assert.deepEqual(f.calls, []);
  }
});

// The default space shows its interface-language name while its stored name is absent or the untouched system default
// (T-60, coordinator 2026-11-08); the same words on another space are that person's name and stay raw.
test('search repaints the default space name and an absent fallback while preserving identical words on another space', async () => {
  for (const [rawName, id, english] of [['', 'shared', 'Shared work'], ['共同工作', 'shared', 'Shared work'], ['共同工作', '33333333-3333-4333-8333-333333333333', '共同工作']]) {
    const f = fixture(); f.rooms[0].name = rawName; f.rooms[0].id = id; f.$('search-dialog').open = true;
    Object.assign(f.context, { searchOrigin: {}, searchLimit: 60, searchTimer: null, clearTimeout() {}, searchOptions: () => ({ scope: 'room' }) });
    f.context.ui.clearMarkdown = () => {};
    // Main runs the same search over the full state (main.cjs 'search'); the stub answers from this state.
    const product = f.context.api, { searchRecords } = require('../renderer/local-search.js');
    Object.assign(f.context, { searchRevision: 0, api: new Proxy({}, { get: (_target, key) => key === 'search' ? async (query, options) => searchRecords(f.state, query, options) : product[key] }) });
    const source = fs.readFileSync(path.join(__dirname, '../renderer/search-view.js'), 'utf8'), a = source.indexOf('async function renderSearch('), z = source.indexOf('function searchInputKey(', a);
    assert.ok(a > 0 && z > a); vm.runInContext(source.slice(a, z), f.context); await f.context.renderSearch();
    const row = f.$('search-results').children[0], name = row.children[0], before = JSON.stringify(f.state); assert.equal(name.textContent, '共同工作');
    f.document.activeElement = row; f.switch('en'); assert.equal(name.textContent, english);
    assert.equal(f.$('search-results').children[0], row); assert.equal(row.children[0], name); assert.equal(f.document.activeElement, row);
    assert.equal(JSON.stringify(f.state), before); assert.deepEqual(f.calls, []); f.switch('zh'); assert.equal(name.textContent, '共同工作');
  }
});

test('explicit file insertion generates its wrapper in the current language once and preserves every original body character', async () => {
  const f = fixture(), input = f.$('message-input'), body = 'RAW FILE 中文 <body>{key}\n  ', closed = [], events = [];
  input.value = 'UNSENT 中文'; input.readOnly = false; input.dispatchEvent = event => events.push(event.type);
  Object.assign(f.context, { filePreview: { name: '原名.txt', text: body, token: 'original-token' }, fileTarget: { room: false }, fileTargetMatches: () => true, fileDraftInput: () => input,
    attempt: action => action(), api: { closeLocalFile: token => closed.push(token) }, Event: class { constructor(type) { this.type = type; } } });
  const start = renderer.indexOf('function appendedDraft('), end = renderer.indexOf('\n}', start) + 2;
  assert.ok(start > 0 && end > start); vm.runInContext(renderer.slice(start, end), f.context);
  const from = renderer.indexOf("$('insert-file').onclick ="), to = renderer.indexOf("$('save-file').onclick =", from);
  assert.ok(from > 0 && to > from); vm.runInContext(renderer.slice(from, to), f.context); f.switch('en');
  f.$('file-dialog').open = true; await f.$('insert-file').onclick();
  assert.equal(input.value, 'UNSENT 中文\n\nFile: 原名.txt\n' + body); assert.deepEqual(closed, ['original-token']); assert.deepEqual(events, ['input']);
  const inserted = input.value; f.switch('zh'); assert.equal(input.value, inserted); assert.equal(f.context.filePreview, null); assert.deepEqual(f.calls, []);
});

test('share keeps the confirmed text, recipient and busy guard; a raw native notice removes its previous binding', () => {
  const f = fixture(), body = 'CONFIRMED 中文 <native>{name}';
  f.$('share-dialog').open = true; f.$('share-text').value = body; f.$('share-recipient').value = f.people[0].id;
  f.context.sharePending = { original: body }; f.context.updateSharingControls(); f.switch('en');
  assert.equal(f.$('confirm-share').textContent, 'Sending…'); assert.equal(f.$('confirm-share').disabled, true);
  assert.ok(f.$('share-help').textContent.startsWith('Sending the content just confirmed.'));
  assert.equal(f.$('share-text').value, body); assert.equal(f.$('share-recipient').value, f.people[0].id);
  f.context.sharePending = null; f.people[0].sharingNotice = 'RAW native notice 中文';
  f.context.updateSharingControls(); f.switch('zh');
  assert.equal(f.$('share-help').textContent, 'RAW native notice 中文'); assert.equal(f.$('share-help').hasAttribute('data-naw-i18n-bound'), false);
  assert.deepEqual(f.calls, []);
});

test('an open share dialog repaints its owned service notice while keeping the actual recipient and confirmed text', () => {
  const f = fixture(), notice = locale.createNotice('notice.client.sharingPrivate');
  f.$('share-dialog').open = true; f.$('share-text').value = 'RAW share 中文'; f.$('share-recipient').value = f.people[0].id;
  Object.assign(f.people[0], { sharingNotice: notice.text, sharingNoticeUiMessage: notice.uiMessage });
  f.context.updateSharingControls(); const help = f.$('share-help'); f.switch('en');
  assert.equal(help.textContent, 'Only the content you select is sent. View replies in the member view. You choose whether to share again; private replies are never forwarded automatically.');
  assert.equal(f.$('share-help'), help); assert.equal(f.$('share-text').value, 'RAW share 中文'); assert.equal(f.$('share-recipient').value, f.people[0].id);
  assert.equal(f.$('confirm-share').disabled, false); assert.deepEqual(f.calls, []);
});

test('native history keeps raw names, native IDs and selected radio nodes across language changes', () => {
  const f = fixture(), row = { nativeId: 'native-original', name: '原名 RAW', cwd: '/synthetic/original', updatedAt: 1000, existingIds: ['session-A'] };
  f.$('native-history-dialog').open = true; f.context.historyRows = [row]; f.context.historySelected = row.nativeId; f.context.historyImporting = true;
  f.context.renderNativeHistory(); const label = f.$('native-history-list').children[0], radio = label.children[0], text = label.children[1];
  f.document.activeElement = radio; const before = JSON.stringify(row); f.switch('en');
  assert.equal(f.$('native-history-list').children[0], label); assert.equal(label.children[0], radio);
  assert.equal(radio.value, row.nativeId); assert.equal(radio.checked, true); assert.equal(f.document.activeElement, radio);
  assert.equal(text.children[0].textContent, row.name); assert.equal(text.children[1].textContent, row.cwd);
  assert.ok(text.children[2].textContent.includes('Already in workspace')); assert.equal(f.$('confirm-native-history').textContent, 'Connecting…');
  assert.equal(JSON.stringify(row), before); assert.deepEqual(f.calls, []);
});

test('a review round preserves consent, order, reply limit and exact preview instead of reinitializing the dialog', () => {
  const f = fixture(), mode = f.$('run-mode'), limit = f.$('run-limit');
  mode.value = 'replies'; mode.options = [{ value: 'replies' }, { value: 'directed' }];
  limit.value = '3'; limit.options = [2, 3, 4, 5, 6].map(value => ({ value: String(value) }));
  f.$('run-consent').checked = true; f.$('run-preview').textContent = 'EXACT CONFIRMED 中文 @RAW';
  f.context.runPreview = { recipient: f.people[0].id, ids: f.people.map(person => person.id), text: f.$('run-preview').textContent };
  f.context.renderRunChoices(); const rows = [...f.$('run-participants').children], check = rows[0].children[0].children[0];
  const preview = f.$('run-preview').textContent, state = JSON.stringify(f.state); f.document.activeElement = check; f.switch('en');
  assert.equal(f.$('run-consent').checked, true); assert.equal(limit.value, '3'); assert.equal(mode.value, 'replies');
  assert.equal(f.$('run-preview').textContent, preview); assert.equal(f.$('confirm-run').disabled, false);
  assert.deepEqual(f.$('run-participants').children, rows); assert.equal(f.document.activeElement, check);
  assert.ok(f.$('run-order').textContent.startsWith('Handoff order: RAW 中文 A'));
  assert.ok(f.$('run-mode-help').textContent.startsWith('Members keep their own backends.'));
  assert.equal(JSON.stringify(f.state), state); assert.deepEqual(f.calls, []);
});

test('merge labels and previews switch without reinitializing source/member selections, original text or name drafts', () => {
  const f = fixture(); f.context.openSpaceMerge();
  f.$('space-merge-name').value = 'EDITED 中文 name'; f.context.mergeDialog.sourceInputs.get(otherRoom).checked = true;
  f.context.renderMergeChoices(); const memberRows = [...f.$('space-merge-members').children];
  const summary = f.$('space-merge-selection').children[0]; summary.open = true; summary.ontoggle();
  const sourceChoice = f.context.mergeDialog.selections.get('shared'), chosenMessages = [...sourceChoice.messages];
  const batch = { name: 'ORIGINAL NAME 中文', memberIds: f.people.map(person => person.id), disposition: 'keep', bytes: 1024, conflicts: [], sources: f.rooms.map(({ id, name }) => ({ id, name })),
    blocks: f.rooms.map(room => ({ roomId: room.id, name: room.name, notes: room.notes, entries: room.messages.map(payload => ({ payload })), files: room.files, omitted: [], pending: false })) };
  f.context.renderMergeBatch(batch, null); const preview = f.$('space-merge-preview'), block = preview.children[3], original = block.children[3].children[1];
  const before = JSON.stringify(f.state), originalBody = original.textContent;
  f.document.activeElement = f.$('space-merge-name'); f.switch('en');
  assert.equal(f.$('space-merge-name').value, 'EDITED 中文 name'); assert.equal(f.$('space-merge-disposition').value, 'keep');
  assert.equal(f.context.mergeDialog.sourceInputs.get(otherRoom).checked, true); assert.deepEqual([...sourceChoice.messages], chosenMessages);
  assert.deepEqual(f.$('space-merge-members').children, memberRows); assert.equal(block.open, false);
  assert.equal(original.textContent, originalBody); assert.ok(originalBody.includes('ORIGINAL BODY 中文'));
  assert.ok(preview.children[1].textContent.includes('2 complete records')); assert.equal(preview.children[0].textContent, batch.name);
  assert.equal(JSON.stringify(f.state), before); assert.deepEqual(f.calls, []);
});

test('a persisted merge failure switches both source status and error without changing the receipt or original material', () => {
  const f = fixture(); f.context.openSpaceMerge();
  const failure = locale.createError('error.room.archivedSourceChanged');
  const batch = { name: 'ORIGINAL NAME 中文', memberIds: [], disposition: 'keep', bytes: 12, conflicts: [], sources: f.rooms.map(({ id, name }) => ({ id, name })), blocks: [] };
  const record = { stage: 'partial', sources: [{ id: 'shared', status: 'changed', error: failure.message, errorUiMessage: failure.uiMessage }], failures: [failure.message], failuresUiMessage: failure.uiMessage };
  f.context.renderMergeBatch(batch, record); const before = JSON.stringify(record), element = f.$('space-merge-preview');
  f.switch('en'); assert.ok(element.textContent.includes('The source changed after archiving.'));
  assert.equal(f.$('space-merge-error').textContent, locale.errorText('en', failure));
  assert.equal(JSON.stringify(record), before); assert.ok(element.textContent.includes('RAW SPACE 中文 0')); assert.deepEqual(f.calls, []);
});

// Found porting test-native-summaries to Codex 0.167 (B11, 2026-11-10): the room status bar showed the native
// state name itself ("Native summaries · inProgress") while the session header showed its text.
test('the room status bar shows a working member\'s native state in the interface language, and native text as it is', () => {
  const f = fixture(), member = f.people[0], other = f.people[1];
  Object.assign(member, { state: 'working', nativeId: 'native-A', activeTurnId: 'turn-A', sharedActivity: { nativeId: 'native-A', turnId: 'turn-A', label: 'inProgress', observedAt: 1 } });
  Object.assign(other, { state: 'working', nativeId: 'native-B', activeTurnId: 'turn-B', sharedActivity: { nativeId: 'native-B', turnId: 'turn-B', label: 'NATIVE permission title 中文', observedAt: 1 } });
  f.state.room.run = null;
  Object.assign(f.context, { roomSubmitting: null, roomPendingRecipients: new Map(), roomSession: '', roomSurface: 'overview', roomMention: null, roomReplyTo: '', roomThreads: { rows: new Map() },
    roomViews: {}, roomImageRefs: () => [], renderRoomImageDraft() {},
    nativeStatusFresh: value => value?.stale !== true, nativeUsable: () => true, nativeWorkspaceMentions: require('../room-mention.js'),
    normalizeRoomMention() {}, roomRecipient: () => member.id, renderTimeline() {}, selectRoom() {}, draggableSession() {},
    orderedMembers: () => f.people,
  });
  f.context.window.nativeWorkspaceCollaboration = require('../renderer/collaboration-overview.js');
  const load = (from, to) => { const a = renderer.indexOf(from), b = renderer.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a); vm.runInContext(renderer.slice(a, b), f.context); };
  load('function populateSelect(', 'function participantLabel('); load('function roomSteerAvailable(', 'function renderRunChoices(');
  load('function refreshRoomMemberTabs(', 'function activeReturnReadingKeys('); load('const nativeActivityLabels = ', 'const elapsedText');
  const start = renderer.indexOf('      const run = state.room.run;', renderer.indexOf('function render()')), end = renderer.indexOf("      if (!$('mention-list').hidden", start); assert.ok(start > 0 && end > start);
  vm.runInContext('function paintRoom() { ' + renderer.slice(start, end) + ' }', f.context);
  f.$('recipient').value = member.id; f.context.paintRoom();
  const zh = f.$('run-status').textContent;
  assert.ok(zh.includes(`${member.name} · ${locale.format('zh', 'activity.inProgress')}`), zh); assert.ok(!zh.includes('inProgress'), 'no native state name is shown');
  assert.ok(zh.includes(`${other.name} · NATIVE permission title 中文`), 'native text without an entry stays exact');
  assert.equal(f.$('run-status').parentElement.hidden, false);
  f.switch('en'); const en = f.$('run-status').textContent;
  assert.ok(en.includes(`${member.name} · ${locale.format('en', 'activity.inProgress')}`), en); assert.ok(en.includes(`${other.name} · NATIVE permission title 中文`));
  assert.deepEqual(f.calls, []);
});

test('shared queued/native-route labels repaint without changing recipient, pending submission or send guards', () => {
  const f = fixture(), recipient = f.people[0], effects = [];
  recipient.state = 'working'; recipient.queueAvailable = true; recipient.serviceCapabilities.push('nativeSharedQueue');
  f.state.room.run = { status: 'running', steps: 1, maxSteps: 2, awaiting: { sessionId: recipient.id }, reason: 'ORIGINAL reason 中文' };
  Object.assign(f.context, { roomSubmitting: null, roomPendingRecipients: new Map([[recipient.id, { queued: true, recipientName: recipient.name }]]), roomSession: '', roomSurface: 'overview', roomMention: null, roomReplyTo: '', roomThreads: { rows: new Map() },
    roomViews: {}, roomImageRefs: () => [], renderRoomImageDraft() {},
    nativeStatusFresh: value => value?.stale !== true, nativeUsable: () => true, nativeWorkspaceMentions: require('../room-mention.js'),
    normalizeRoomMention: () => effects.push('normalize'), roomRecipient: () => recipient.id, renderTimeline: () => effects.push('timeline'), selectRoom() {}, draggableSession() {},
    orderedMembers: () => f.people,
  });
  f.context.window.nativeWorkspaceCollaboration = require('../renderer/collaboration-overview.js');
  const load = (from, to) => { const a = renderer.indexOf(from), b = renderer.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a); vm.runInContext(renderer.slice(a, b), f.context); };
  load('function populateSelect(', 'function participantLabel('); load('function roomSteerAvailable(', 'function renderRunChoices(');
  load('function refreshRoomMemberTabs(', 'function activeReturnReadingKeys(');
  const start = renderer.indexOf('      const run = state.room.run;', renderer.indexOf('function render()')), end = renderer.indexOf("      if (!$('mention-list').hidden", start); assert.ok(start > 0 && end > start);
  vm.runInContext('function paintRoom() { ' + renderer.slice(start, end) + ' }', f.context);
  f.$('recipient').value = recipient.id; f.$('shared-input').value = 'UNSENT shared draft 中文'; f.document.activeElement = f.$('shared-input');
  f.context.paintRoom(); const before = JSON.stringify(f.state), disabled = f.$('forward-button').disabled, calls = effects.length;
  f.switch('en'); assert.equal(f.$('recipient').value, recipient.id); assert.equal(f.$('shared-input').value, 'UNSENT shared draft 中文'); assert.equal(f.document.activeElement, f.$('shared-input'));
  assert.equal(f.$('forward-button').disabled, disabled); assert.equal(f.$('forward-button').type, 'submit'); assert.equal(f.$('forward-button').textContent, 'Send after this turn ↑');
  assert.match(f.$('run-status').textContent, /^Queued for RAW 中文 A:/); assert.match(f.$('run-help').textContent, /Sends only to RAW 中文 A/); assert.equal(effects.length, calls); assert.equal(JSON.stringify(f.state), before); assert.deepEqual(f.calls, []);
  recipient.nativeInputRequired = true; f.context.paintRoom(); const later = effects.length; f.switch('zh');
  assert.equal(f.$('forward-button').type, 'button'); assert.equal(f.$('forward-button').textContent, '打开原生终端'); assert.equal(f.$('recipient').value, recipient.id); assert.equal(f.$('shared-input').value, 'UNSENT shared draft 中文'); assert.equal(effects.length, later); assert.deepEqual(f.calls, []);
});


test('the actual setup view repaints known report and pending errors while preserving program controls, raw paths and the one requested read', async () => {
  const f = fixture(), from = renderer.indexOf('function renderSetupPrograms('), to = renderer.indexOf('// End language/settings display controls.', from);
  assert.ok(from > 0 && to > from); vm.runInContext(renderer.slice(from, to), f.context);
  const error = locale.createError('error.runtime.locationsUnreadable');
  f.context.setupTicket = f.context.openTransientDialog('setup-dialog'); f.context.setupLoading = false; f.context.setupFailure = null; f.context.setupRows = [];
  f.state.preflight = { python: true, claude: true, codex: true, paths: { claude: '/synthetic/RAW 中文' }, configured: {}, error: error.message, errorUiMessage: error.uiMessage };
  f.context.renderSetupPrograms(); const rows = [...f.$('setup-status').children], report = rows.at(-1), choose = f.context.setupRows[0].actions[1][0];
  f.document.activeElement = choose; const before = JSON.stringify(f.state);
  f.switch('en'); f.context.renderSetupPrograms(true);
  assert.deepEqual(f.$('setup-status').children, rows); assert.equal(report.textContent, 'Custom program locations could not be read. Check the local data file in Settings.');
  assert.equal(f.document.activeElement, choose); assert.equal(JSON.stringify(f.state), before); assert.deepEqual(f.calls, []);
  let reject, reads = 0; f.context.api = { preflight() { reads++; return new Promise((_resolve, no) => reject = no); } };
  f.context.renderInterfaceLanguage = () => {}; f.context.createReadiness = () => {};
  const loading = f.context.showSetup(); assert.equal(reads, 1); assert.equal(typeof reject, 'function'); f.switch('zh'); reject(error); await loading;
  assert.equal(f.context.setupFailure.message, error.message); f.switch('en'); f.context.renderSetupPrograms(true);
  assert.ok(f.$('setup-status').textContent.includes('Custom program locations could not be read.')); assert.equal(reads, 1);
  f.context.setupFailure = null; f.state.preflight = { ...f.state.preflight, error: 'RAW native 中文 <error>{key}', errorUiMessage: null }; f.context.renderSetupPrograms();
  f.switch('zh'); assert.equal(f.$('setup-status').children.at(-1).textContent, 'RAW native 中文 <error>{key}'); assert.equal(reads, 1);
});


test('existing merge event selection labels repaint only typed owned text and retain selected IDs and raw events', () => {
  const f = fixture(), own = locale.createNotice('notice.room.joined');
  f.rooms[0].events.push({ id: 'owned-event', ...own }, { id: 'raw-event', text: own.text });
  f.context.openSpaceMerge(); const choice = f.context.mergeDialog.selections.get('shared'), selected = [...choice.events];
  const details = f.$('space-merge-selection').children[0]; details.open = true; details.ontoggle();
  const before = JSON.stringify(f.state); f.switch('en'); assert.ok(details.textContent.includes('Joined the workspace · No history sent or model notified')); assert.ok(details.textContent.includes(own.text));
  assert.deepEqual([...choice.events], selected); assert.equal(JSON.stringify(f.state), before); assert.deepEqual(f.calls, []);
});

// The person could not tell who had received a queued item or what came back (2026-11-09).
test('a queue row names its recipient and shows what came back; rotation links stay short with the full ids reachable', () => {
  const f = fixture();
  const longName = 'Codex · ' + '秘'.repeat(52);
  assert.equal([...longName].length, 60);
  f.people[0].name = longName;
  const load = (from, to) => {
    const a = renderer.indexOf(from), b = renderer.indexOf(to, a + from.length);
    assert.ok(a >= 0 && b > a, from);
    vm.runInContext(renderer.slice(a, b), f.context);
  };
  load('let queueSpace = null;', "$('room-queue').onclick");
  const oldLink = { id: f.people[1].id, nativeId: 'native-B-0001-0002', name: null, handedAt: Date.parse('2026-11-09T22:54:00Z'), outcome: 'done' };
  const newLink = { id: 'c3b28d9a-12ba-585a-9d8b-6dacfa0ce5e6', nativeId: '12b28ccc-b9b7-8c22-cbcb-278cf34b4e4f', name: 'Codex 2 · 续' };
  f.state.rotationChains = [{ spaces: ['shared'], sessions: [oldLink, newLink] }];
  f.rooms[0].queue = [
    { id: 'i1', text: '请只回复“收到”，', assignee: null, status: 'sent', createdAt: 1, sentTo: f.people[0].id },
    { id: 'i2', text: '第二件', assignee: null, status: 'done', createdAt: 2, sentTo: f.people[0].id, reply: '收到' },
    { id: 'i3', text: '第三件', assignee: null, status: 'waiting', createdAt: 3, sentTo: f.people[1].id, reason: 'no-reply' },
    { id: 'i4', text: '第四件', assignee: null, status: 'failed', createdAt: 4, sentTo: f.people[1].id, reason: 'not-sent: error.queue.personTyping' },
    { id: 'i5', text: '第五件', assignee: null, status: 'failed', createdAt: 5, sentTo: f.people[1].id, reason: 'synthetic-unmapped' },
    { id: 'i6', text: '第六件', assignee: null, status: 'failed', createdAt: 6, sentTo: f.people[1].id, reason: 'send-failed' },
  ];
  f.context.openQueue();
  const rows = f.$('queue-list').querySelectorAll('.queue-row');
  const row = id => rows.find(el => el.dataset.queueItem === id);
  const outcome = id => row(id).querySelectorAll('.queue-outcome').map(el => el.textContent);
  const status = id => row(id).querySelectorAll('.queue-status')[0];
  assert.equal(rows.length, 6);
  assert.ok(status('i1').textContent.includes(longName), 'a sent row names the member that received it');
  assert.equal(status('i1').title, longName, 'the whole name stays reachable however it is laid out');
  assert.deepEqual(outcome('i2'), ['收到']);
  assert.deepEqual(outcome('i3'), ['它没有回话']);
  assert.deepEqual(outcome('i4'), ['没能发出']);
  assert.deepEqual(outcome('i5'), [], 'an internal reason is not shown as an outcome');
  assert.ok(status('i5').title.endsWith(' · synthetic-unmapped'), 'but it stays readable on the status line: ' + status('i5').title);
  assert.deepEqual(outcome('i6'), ['发送失败，不会重发']);
  const chains = f.$('queue-rotation-list').querySelectorAll('.rotation-chain');
  assert.equal(chains.length, 1);
  const links = chains[0].children;
  assert.equal(links.length, 2);
  assert.equal(links[0].textContent.startsWith('RAW 中文 B sessio · 原生 native-B'), true, links[0].textContent);
  const handed = new Date(oldLink.handedAt).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  assert.ok(links[0].textContent.endsWith(` · ${handed} 交接`), 'the handoff time reads as its own part, not glued to the native id: ' + links[0].textContent);
  assert.equal(links[0].title, `RAW 中文 B · ${f.people[1].id} · ${oldLink.nativeId}`);
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(links[1].textContent), false, links[1].textContent);
  assert.equal(links[1].title, `Codex 2 · 续 · ${newLink.id} · ${newLink.nativeId}`);
  f.switch('en');
  assert.deepEqual(outcome('i3'), ['It did not reply']);
  assert.deepEqual(outcome('i4'), ['It could not be sent']);
  assert.ok(links[1].textContent.includes('native 12b28ccc'), links[1].textContent);
  assert.deepEqual(f.calls, []);
});
