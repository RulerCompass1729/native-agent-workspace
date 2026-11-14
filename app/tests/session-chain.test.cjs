// Synthetic recorded handoffs exercise the production chain reader without
// launching Electron, a native session or a model.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { rotationChains } = require('../queue-dispatch.cjs');
const localeUI = require('./fixtures/locale-ui.cjs');
const renderer = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
const BASE = Date.parse('2026-11-09T12:00:00Z');
const recorded = (id, name = id) => ({ id, name, nativeId: 'native-' + id });
const handoff = (old, next, offset, event = 'done') => ({ time: BASE + offset, event, spaces: ['synthetic-space'], old: recorded(old), new: next ? recorded(next) : null });
const session = (id, offset = 0, patch = {}) => ({ ...recorded(id), provider: 'claude', state: 'idle', createdAt: BASE + offset, messages: [], ...patch });

function fixture(entries, sessions) {
  const state = { sessions, rotationChains: rotationChains(entries) };
  const start = renderer.indexOf('// Only recorded NAW handoffs');
  const end = renderer.indexOf('function renderDraftRecovery(', start);
  assert.ok(start >= 0 && end > start, 'Production session-chain helpers must be present');
  const context = vm.createContext({ state, Number, Date, Set, Map,
    participantLabel: record => record.name || record.id,
    uiText: key => key,
  });
  vm.runInContext(renderer.slice(start, end), context);
  assert.equal(typeof context.sessionChainModel, 'function');
  return { state, model: id => context.sessionChainModel(id), context };
}
const ids = model => Array.from(model.sessions, row => row.id);
const successors = row => Array.from(row.successors, next => ({ id: next.id, time: next.time }));

test('the chain dialog survives the production build template extraction before the first script', () => {
  const html = fs.readFileSync(require.resolve('../renderer/index.html'), 'utf8');
  // scripts/build-ui.cjs embeds only this body prefix into the DSH template.
  // Nodes inserted between script tags exist in source but vanish from the app.
  const body = html.split('<body>')[1].split('<script')[0];
  for (const id of ['session-chain-dialog', 'session-chain-list', 'close-session-chain']) {
    assert.ok(body.includes(`id="${id}"`), `${id} must be part of the built UI template`);
  }
});

test('only completed or kept NAW handoffs connect sessions; matching names and native identities do not', () => {
  const records = [session('old'), session('next', 100), session('manual', 150, { name: 'next', nativeId: 'native-next' }), session('requested'), session('failed')];
  const f = fixture([handoff('old', 'next', 100), handoff('requested', 'unused', 200, 'requested'), handoff('failed', null, 300, 'failed')], records);
  assert.deepEqual(ids(f.model('old')), ['old', 'next']);
  assert.equal(f.model('manual'), null);
  assert.equal(f.model('requested'), null);
  assert.equal(f.model('failed'), null);
  assert.equal(f.model('missing'), null);
});

test('the successor records when the previous segment handed over; all entry points show the whole chronological chain', () => {
  const records = [session('old'), session('middle', 100), session('latest', 200)];
  const f = fixture([handoff('middle', 'latest', 200), handoff('old', 'middle', 100)], records);
  for (const id of ['old', 'middle', 'latest']) {
    const model = f.model(id);
    assert.deepEqual(ids(model), ['old', 'middle', 'latest']);
    assert.deepEqual(Array.from(model.sessions, row => row.startedAt), [BASE, BASE + 100, BASE + 200]);
    assert.deepEqual(successors(model.sessions[0]), [{ id: 'middle', time: BASE + 100 }]);
    assert.deepEqual(successors(model.sessions[1]), [{ id: 'latest', time: BASE + 200 }]);
    assert.deepEqual(successors(model.sessions[2]), []);
    assert.deepEqual(Array.from(model.currentIds), ['latest']);
  }
});

test('kept branches remain one deduplicated conversation with every recorded successor reachable', () => {
  const records = [session('root'), session('late', 300), session('early', 100), session('early-next', 200), session('unrelated', 50)];
  const f = fixture([handoff('root', 'late', 300), handoff('root', 'early', 100, 'kept'), handoff('early', 'early-next', 200), handoff('unrelated', 'other', 400)], records);
  for (const id of ['root', 'late', 'early', 'early-next']) {
    const model = f.model(id);
    assert.deepEqual(ids(model), ['root', 'early', 'early-next', 'late']);
    assert.deepEqual(successors(model.sessions[0]).sort((a, b) => a.time - b.time), [{ id: 'early', time: BASE + 100 }, { id: 'late', time: BASE + 300 }]);
    assert.deepEqual(Array.from(model.currentIds).sort(), ['early-next', 'late']);
  }
});

test('a missing or archived session keeps its recorded segment and name without joining a same-named replacement', () => {
  const logs = [handoff('old', 'middle', 100), handoff('middle', 'latest', 200)];
  logs[0].old.name = 'Recorded old name';
  const archived = session('middle', 100, { archived: true, state: 'ended', name: 'Renamed archived segment' });
  const f = fixture(logs, [archived, session('latest', 200), session('manual', 150, { name: 'Recorded old name' })]);
  const model = f.model('latest');
  assert.deepEqual(ids(model), ['old', 'middle', 'latest']);
  assert.equal(model.sessions[0].name, 'Recorded old name');
  assert.ok(model.sessions[0].record == null);
  assert.equal(model.sessions[1].record, archived);
  assert.equal(model.sessions[1].name, archived.name);
  assert.equal(f.model('manual'), null);
});

test('post-handoff conversation requires a later timestamped user or assistant message, never resume/activity or an unsent draft', () => {
  const old = session('old', 0, { state: 'ended', liveDraft: 'Unsent synthetic draft', lastActivityAt: BASE + 900,
    messages: [{ role: 'user', time: BASE + 99, text: 'before' }, { role: 'assistant', time: BASE + 100, text: 'at handoff' },
      { role: 'system', time: BASE + 500, text: 'Native connection resumed' }, { role: 'tool', time: BASE + 600, text: 'tool output' },
      { role: 'assistant', volatile: true, time: BASE + 700, text: 'volatile' }, { role: 'user', kind: 'gap', time: BASE + 800 },
      { role: 'user', time: NaN }, { role: 'assistant', time: Infinity }, { role: 'user', time: String(BASE + 900) }, { role: 'assistant' }] });
  const f = fixture([handoff('old', 'new', 100)], [old, session('new', 100)]);
  assert.ok(f.model('old').sessions[0].continuedAt == null);
  old.state = 'idle'; old.connectionRevision = 2; old.lastActivityAt = BASE + 2000;
  assert.ok(f.model('old').sessions[0].continuedAt == null, 'Continuing the same native session is not itself conversation');
  old.messages.push({ role: 'user', time: BASE + 101, text: 'Sent on the previous segment' });
  assert.equal(f.model('old').sessions[0].continuedAt, BASE + 101);
  old.messages.push({ role: 'assistant', time: BASE + 102, text: 'A later reply on the previous segment' });
  assert.equal(f.model('new').sessions[0].continuedAt, BASE + 102, 'The list updates from the latest recorded conversation time');
});

test('an assistant reply alone marks old-segment use; the active leaf is never marked as post-handoff conversation', () => {
  const f = fixture([handoff('old', 'new', 100)], [session('old', 0, { messages: [{ role: 'assistant', time: BASE + 101, text: 'Reply after handoff' }] }),
    session('new', 100, { messages: [{ role: 'user', time: BASE + 200, text: 'Current conversation' }] })]);
  const model = f.model('new');
  assert.equal(model.sessions[0].continuedAt, BASE + 101);
  assert.ok(model.sessions[1].continuedAt == null);
});

test('chain inspection does not mutate records, messages or the shared rotationChains payload', () => {
  const f = fixture([handoff('old', 'middle', 100, 'kept'), handoff('middle', 'latest', 200)],
    [session('latest', 200), session('old', 0, { messages: [{ role: 'user', time: BASE + 101, text: 'Literal <raw> {name}' }] }), session('middle', 100)]);
  const before = JSON.stringify(f.state);
  f.model('middle'); f.model('old'); f.model('latest');
  assert.equal(JSON.stringify(f.state), before);
});

function uiFixture(entries, sessions) {
  const f = fixture(entries, sessions), locale = localeUI();
  const actions = [], notices = [], elements = new Map(), document = { activeElement: null };
  class Element {
    constructor(tag, text = '', cls = '') { this.tagName = tag; this.content = text; this.className = cls; this.children = []; this.dataset = {}; this.attrs = new Map(); this.ownerDocument = document; this.open = false; this.hidden = false; this.disabled = false; }
    get isConnected() { return this === root || Boolean(this.parentElement?.isConnected); }
    get childElementCount() { return this.children.length; }
    get textContent() { return this.content + this.children.map(child => child.textContent).join(''); }
    set textContent(text) { this.replaceChildren(); this.content = String(text ?? ''); }
    setAttribute(name, value) { this.attrs.set(name, String(value)); }
    getAttribute(name) { return this.attrs.get(name) ?? null; }
    hasAttribute(name) { return this.attrs.has(name); }
    removeAttribute(name) { this.attrs.delete(name); }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    append(...children) { for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child); } }
    prepend(...children) { for (const child of children.reverse()) { child.remove(); child.parentElement = this; this.children.unshift(child); } }
    remove() { if (!this.parentElement) return; if (this.contains(document.activeElement)) document.activeElement = null; const children = this.parentElement.children; children.splice(children.indexOf(this), 1); this.parentElement = null; }
    replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.content = ''; this.append(...children); }
    matches(selector) { return selector === 'button' ? this.tagName === 'button' : selector === '[data-session-id]' ? Boolean(this.dataset.sessionId) : selector.startsWith('.') ? this.className.split(/\s+/).includes(selector.slice(1)) : selector.startsWith('[') && this.hasAttribute(selector.slice(1, -1)); }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    focus() { if (!this.disabled && this.isConnected) document.activeElement = this; }
    close() { this.open = false; actions.push(['close', this.id]); }
    getClientRects() { return this.isConnected ? [{}] : []; }
  }
  const node = (tag, text, cls) => new Element(tag, text ?? '', cls), root = node('div');
  const $ = id => { if (!elements.has(id)) { const element = node('div'); element.id = id; root.append(element); elements.set(id, element); } return elements.get(id); };
  const button = (text, action, cls) => Object.assign(node('button', text, cls), { onclick: action });
  const uiButton = (key, action, cls, params) => { const element = button('', action, cls); locale.ui.display.text(element, key, params); return element; };
  Object.assign(f.context, locale, { document, node, $, button, uiButton, selected: 'unchanged-current',
    stateText: record => locale.uiText('state.' + record.state),
    openTransientDialog: id => { $(id).open = true; },
    select: async (id, mode) => { actions.push(['select', id, mode]); },
    api: { archiveSession: async id => actions.push(['archive', id]) },
    toastMessage: (key, params) => notices.push({ key, params }),
  });
  const start = renderer.indexOf('function sessionChainTime('), end = renderer.indexOf('function sessionMenuModel(', start);
  assert.ok(start >= 0 && end > start, 'Production chain UI helpers must be present');
  vm.runInContext(renderer.slice(start, end), f.context);
  // The production marker for an archived session's name (it reads the archived flag and the UI language).
  const marker = renderer.indexOf('function archivedName('), markerEnd = renderer.indexOf('\n}\n', marker) + 3;
  assert.ok(marker >= 0 && markerEnd > marker, 'Production archived-name marker must be present');
  vm.runInContext(renderer.slice(marker, markerEnd), f.context);
  return { ...f, $, root, node, document, actions, notices,
    switch(language) { locale.setLanguage(language); locale.ui.display.refresh(root); },
  };
}

test('the same chain list opens from either end and opens an archived segment as chat records only', async () => {
  const old = session('old', 0, { name: 'Original <old> {name}', archived: true, state: 'ended' });
  const f = uiFixture([handoff('old', 'new', 100)], [old, session('new', 100)]);
  const before = JSON.stringify(f.state);
  f.context.openSessionChain('new');
  assert.equal(f.$('session-chain-dialog').open, true);
  const rows = f.$('session-chain-list').children;
  assert.deepEqual(rows.map(row => row.dataset.sessionId), ['old', 'new']);
  // The archived segment is marked in front of its unchanged stored name (the user, 11-13: 「[archived]」 before archived names).
  assert.equal(rows[0].children[0].textContent, '[已归档] ' + old.name);
  assert.equal(rows[1].children[0].textContent, 'new');
  assert.match(rows[0].textContent, /已归档/);
  assert.equal(rows[0].children[0].getAttribute('aria-current'), null);
  assert.equal(rows[1].children[0].getAttribute('aria-current'), 'true');
  assert.match(rows[1].textContent, /正在用的段/);
  assert.match(rows[0].textContent, /2026/);
  assert.deepEqual(f.actions, []);
  assert.equal(JSON.stringify(f.state), before);
  await rows[0].children[0].onclick();
  assert.equal(f.$('session-chain-dialog').open, false);
  assert.deepEqual(f.actions, [['close', 'session-chain-dialog'], ['select', 'old', 'chat']]);
  assert.equal(JSON.stringify(f.state), before, 'Navigation does not restore or resume the archived native session');
  f.context.openSessionChain('old');
  assert.deepEqual(f.$('session-chain-list').children.map(row => row.dataset.sessionId), ['old', 'new']);
});

test('a live post-handoff update repaints the list while keeping keyboard focus on the same segment', () => {
  const old = session('old', 0, { state: 'ended' }), f = uiFixture([handoff('old', 'new', 100)], [old, session('new', 100)]);
  f.context.openSessionChain('new');
  const original = f.$('session-chain-list').children[0].children[0]; original.focus();
  old.messages.push({ role: 'assistant', text: 'A late reply', time: BASE + 101 });
  f.context.renderSessionChain();
  const row = f.$('session-chain-list').children[0];
  assert.match(row.textContent, /交接后仍有对话/);
  assert.ok(f.document.activeElement?.isConnected, 'A state refresh must not strand focus on a removed button');
  assert.equal(f.document.activeElement.closest('[data-session-id]')?.dataset.sessionId, 'old');
  assert.equal(f.context.selected, 'unchanged-current');
  assert.deepEqual(f.actions, []);
});

test('chain text switches language in place without navigating or changing raw names, state or focus', () => {
  const old = session('old', 0, { state: 'ended', archived: true, messages: [{ role: 'user', text: 'Synthetic sent message', time: BASE + 101 }] });
  const f = uiFixture([handoff('old', 'new', 100)], [old, session('new', 100, { name: 'RAW 中文 <new> {name}' })]);
  f.context.openSessionChain('old');
  const list = f.$('session-chain-list'), rows = [...list.children], names = rows.map(row => row.children[0].textContent), before = JSON.stringify(f.state);
  rows[0].children[0].focus(); const focused = f.document.activeElement;
  f.switch('en');
  assert.deepEqual(list.children, rows);
  // Only the archived marker follows the language; the stored names themselves stay byte for byte.
  assert.deepEqual(names, ['[已归档] old', 'RAW 中文 <new> {name}']);
  assert.deepEqual(rows.map(row => row.children[0].textContent), ['[archived] old', 'RAW 中文 <new> {name}']);
  assert.match(rows[0].textContent, /Archived/);
  assert.match(rows[0].textContent, /Conversation after handoff/);
  assert.match(rows[1].textContent, /Current segment/);
  assert.equal(f.document.activeElement, focused);
  assert.equal(JSON.stringify(f.state), before);
  assert.deepEqual(f.actions, []);
});

test('the old-segment notice preserves the composer, marks later messages and jumps to its successor', async () => {
  const old = session('old', 0, { state: 'ended', liveDraft: 'Unsent original draft' }), next = session('new', 100, { name: '秘书 · 续' });
  const f = uiFixture([handoff('old', 'new', 100)], [old, next]);
  const form = f.node('form'), input = f.node('textarea'); input.value = old.liveDraft; input.selectionStart = 2; input.selectionEnd = 7;
  form.append(input); f.root.append(form); input.focus();
  const binding = { ui: { form, input } };
  f.context.renderSessionHandoff(binding, old);
  assert.equal(form.children[0], binding.chainNotice);
  assert.equal(form.children[1], input);
  assert.match(binding.chainNotice.textContent, /这段已交给「秘书 · 续」/);
  assert.doesNotMatch(binding.chainNotice.textContent, /交接后仍有对话/);
  assert.equal(f.document.activeElement, input);
  old.messages.push({ role: 'user', time: BASE + 101, text: 'Sent after continuing the old segment' });
  f.context.renderSessionHandoff(binding, old);
  assert.match(binding.chainNotice.textContent, /交接后仍有对话/);
  f.switch('en');
  assert.match(binding.chainNotice.textContent, /handed over to/);
  assert.match(binding.chainNotice.textContent, /Conversation after handoff/);
  assert.equal(binding.ui.input, input);
  assert.equal(input.value, old.liveDraft);
  assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 7);
  assert.equal(f.document.activeElement, input);
  const jump = binding.chainNotice.children[1]; jump.focus();
  next.name = '秘书 · 续 · renamed'; f.context.renderSessionHandoff(binding, old);
  assert.ok(f.document.activeElement?.isConnected);
  assert.equal(f.document.activeElement.tagName, 'button');
  await binding.chainNotice.children[1].onclick();
  assert.deepEqual(f.actions, [['close', 'session-chain-dialog'], ['select', 'new', 'chat']]);
  f.context.renderSessionHandoff(binding, next);
  assert.equal(binding.chainNotice.hidden, true);
});

// Archived or restored elsewhere (another window, the butler) while the old segment is open: the notice follows the flag.
test('the handoff notice repaints its successor\'s archived marker when that successor is archived or restored', () => {
  const old = session('old', 0, { state: 'ended' }), next = session('new', 100, { name: '秘书 · 续' });
  const f = uiFixture([handoff('old', 'new', 100)], [old, next]);
  const form = f.node('form'); f.root.append(form);
  const binding = { ui: { form } }, before = JSON.stringify(f.state);
  f.context.renderSessionHandoff(binding, old);
  assert.match(binding.chainNotice.textContent, /这段已交给「秘书 · 续」/);
  next.archived = true; f.context.renderSessionHandoff(binding, old);
  assert.match(binding.chainNotice.textContent, /这段已交给「\[已归档\] 秘书 · 续」/);
  delete next.archived; f.context.renderSessionHandoff(binding, old);
  assert.match(binding.chainNotice.textContent, /这段已交给「秘书 · 续」/);
  assert.equal(JSON.stringify(f.state), before);
});

test('archiving one segment names its siblings and archives exactly that segment once', async () => {
  const f = uiFixture([handoff('old', 'middle', 100), handoff('middle', 'latest', 200)], [session('old'), session('middle', 100), session('latest', 200)]);
  const before = JSON.stringify(f.state);
  await f.context.archiveChainSession('latest');
  assert.deepEqual(f.actions, [['archive', 'latest']]);
  assert.equal(f.notices.length, 1);
  assert.equal(f.notices[0].key, 'chain.archiveNotice');
  assert.equal(f.notices[0].params().names, 'old / middle');
  assert.equal(JSON.stringify(f.state), before);
  // A sibling archived earlier is named with the marker when the notice paints, in the language shown then.
  f.state.sessions.find(s => s.id === 'old').archived = true;
  assert.equal(f.notices[0].params().names, '[已归档] old / middle');
  f.switch('en');
  assert.equal(f.notices[0].params().names, '[archived] old / middle');
});

test('missing recorded segments stay visible but disabled; stale clicks do not navigate', async () => {
  const f = uiFixture([handoff('old', 'new', 100)], [session('new', 100)]);
  f.context.openSessionChain('new');
  const missing = f.$('session-chain-list').children.find(row => row.dataset.sessionId === 'old');
  assert.ok(missing); assert.equal(missing.children[0].disabled, true);
  await f.context.openSessionChainSegment('old');
  assert.deepEqual(f.actions, []);
  assert.equal(f.$('session-chain-dialog').open, true);
});
