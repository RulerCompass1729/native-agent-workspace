const test = require('node:test');
const assert = require('node:assert/strict');
const { project, pruneReading, create } = require('../renderer/collaboration-panorama.js');
const { validViews } = require('../view-store.cjs');

const B = '11111111-1111-4111-8111-111111111111';
const UNKNOWN = '22222222-2222-4222-8222-222222222222';
const rooms = [{ id: 'shared', name: 'A' }, { id: B, name: 'B' }];
const session = (id, roomIds = [], extra = {}) => ({ id, nativeId: `native-${id}`, name: '同名成员', state: 'idle', roomIds, messages: [], ...extra });

// A minimal DOM for panorama rendering with real display bindings.
function fakeDom() {
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.dataset = {}; this.attrs = new Map(); this.classList = { add() {} }; this.clientHeight = 0; this.scrollTop = 0; this._text = ''; }
    set textContent(value) { this._text = String(value); this.children = []; this.firstChild = value ? { textContent: String(value), parentElement: this } : null; }
    get textContent() { return this._text || this.children.map(child => child.textContent).join(''); }
    setAttribute(key, value) { this.attrs.set(key, String(value)); }
    getAttribute(key) { return this.attrs.get(key) ?? null; }
    hasAttribute(key) { return this.attrs.has(key); }
    removeAttribute(key) { this.attrs.delete(key); }
    addEventListener() {}
    append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } this.firstChild = this.children[0] || null; }
    insertBefore(node, before) { if (node === before) return; node.remove(); node.parentElement = this; const index = this.children.indexOf(before); this.children.splice(index < 0 ? this.children.length : index, 0, node); this.firstChild = this.children[0] || null; }
    replaceChildren(...nodes) { for (const node of this.children) node.parentElement = null; this.children = []; this._text = ''; this.append(...nodes); }
    remove() { if (this.parentElement) { const list = this.parentElement.children; list.splice(list.indexOf(this), 1); this.parentElement = null; } }
    querySelectorAll(selector) {
      assert.equal(selector, '[data-naw-i18n-bound]'); const found = [];
      const visit = element => { for (const child of element.children) { if (child.hasAttribute('data-naw-i18n-bound')) found.push(child); visit(child); } };
      visit(this); return found;
    }
  }
  const doc = { createElement: tag => new Element(tag), getSelection: () => null, addEventListener() {}, activeElement: null };
  doc.Element = Element;
  return { doc };
}

test('one primary projection reaches B-only U and counts shared S only once', () => {
  const sessions = [session('S', ['shared', B]), session('T', ['shared']), session('U', [B]), session('V')];
  const before = JSON.stringify({ rooms, sessions });
  const result = project({ rooms, sessions });
  assert.deepEqual(result.people.map(p => p.record.id), ['S', 'T', 'U', 'V']);
  assert.equal(result.total, 4); assert.equal(result.memberships, 4);
  assert.deepEqual(result.people[0].spaces.map(s => s.id), ['shared', B]);
  assert.equal(result.people[3].spaces.length, 0);
  assert.equal(JSON.stringify({ rooms, sessions }), before, 'observation changes no input, identity or membership');
});

test('projection paints the same observed facts in English without changing membership or raw source text', () => {
  const value = { rooms, sessions: [session('S', ['shared', B], { background: 2, backgroundKinds: ['shell', 'monitor'], backgroundAt: 1,
    messages: [{ id: 'source', role: 'assistant', text: 'NATIVE 中文 original' }] })] };
  const before = JSON.stringify(value), result = project(value, { language: 'en' }, true, 10000), person = result.people[0];
  assert.equal(person.facts.state, 'Background tasks running · 2 (Command 1, Monitor 1)');
  assert.equal(person.paintFacts('zh').state, '后台任务在跑 · 2 项（命令 1、监视 1）');
  assert.equal(person.paintFacts('en').freshness, person.facts.freshness);
  assert.deepEqual(person.spaces.map(room => room.id), ['shared', B]); assert.equal(person.excerpt.text, 'NATIVE 中文 original');
  assert.equal(result.total, 1); assert.equal(result.memberships, 2); assert.equal(JSON.stringify(value), before);
});

test('real display bindings repaint panorama labels without replacing its focused control, raw source node or scroll', () => {
  const binding = require('./fixtures/locale-ui.cjs')('zh');
  const { doc } = fakeDom(); const Element = doc.Element;
  const host = new Element('div'), api = create({ host, display: binding.ui.display, language: binding.ui.language, view: { spaceId: 'shared' } });
  const record = session('S', ['shared'], { background: 2, backgroundKinds: ['shell', 'monitor'], backgroundAt: 1 });
  const data = { rooms: [{ id: 'shared', name: 'RAW 中文 space' }], sessions: [record] };
  api.update(data); // First bind the owned no-excerpt fallback.
  const row = api.reader.children[0], quote = row.children.find(child => child.tagName === 'BLOCKQUOTE');
  const source = row.children.find(child => child.dataset.panoramaSource === 'S');
  const body = 'NATIVE 中文 original\n{literal}'; record.messages = [{ id: 'source', role: 'assistant', text: body }];
  api.update(data); // Native content must remove the old owned-text binding.
  const rawNode = quote.firstChild, reference = row.children[1].children[0], referenceNode = reference.firstChild;
  const filter = host.children[0].children.find(child => child.tagName === 'SELECT');
  api.reader.scrollTop = 27; doc.activeElement = source;
  doc.getSelection = () => { throw Error('Locale repaint must not rerender or navigate the original reader'); };
  binding.setLanguage('en'); binding.ui.display.refresh(host);
  assert.equal(source.textContent, 'View original'); assert.equal(row.children[0].children[1].textContent, 'Background tasks running · 2 (Command 1, Monitor 1)');
  assert.equal(filter.children[0].textContent, 'Sessions overview'); assert.equal(filter.value, 'shared');
  assert.equal(quote.textContent, body); assert.equal(quote.firstChild, rawNode);
  assert.equal(reference.textContent, 'RAW 中文 space'); assert.equal(reference.firstChild, referenceNode);
  assert.equal(api.reader.children[0], row); assert.equal(doc.activeElement, source); assert.equal(api.reader.scrollTop, 27);
});

test('filtering retains the full denominator and every original membership', () => {
  const state = { rooms, sessions: [session('S', ['shared', B]), session('T', ['shared']), session('U', [B])] };
  const a = project(state, { spaceId: 'shared' });
  assert.deepEqual(a.people.map(p => p.record.id), ['S', 'T']);
  assert.equal(a.total, 3); assert.equal(a.memberships, 4);
  assert.deepEqual(a.people[0].spaces.map(s => s.id), ['shared', B]);
  assert.deepEqual(project(state, { spaceId: 'missing' }).people, [], 'missing scope never silently broadens');
  assert.deepEqual(project(state, { query: 'native-U' }).people.map(p => p.record.id), ['U']);
});

test('stream updates and repeated names cannot reorder or replace selected identities', () => {
  const first = project({ rooms, sessions: [session('S'), session('T'), session('U')] });
  const second = project({ rooms, sessions: [session('U', [], { state: 'working' }), session('S'), session('T'), session('N')] }, { order: first.order });
  assert.deepEqual(second.people.map(p => p.record.id), ['S', 'T', 'U', 'N']);
  assert.equal(second.people[2].record.nativeId, 'native-U');
  assert.equal(second.people[2].record.state, 'working');
  assert.deepEqual(project({ rooms, sessions: [session('__proto__'), session('constructor')] }).order, ['__proto__', 'constructor']);
});

test('100 synthetic logical sessions have 118 relationships, not 118 agents', () => {
  const sessions = Array.from({ length: 100 }, (_, i) => session(`s${i}`, i < 18 ? ['shared', B] : [i % 2 ? 'shared' : B]));
  const result = project({ rooms, sessions });
  assert.equal(result.total, 100); assert.equal(result.people.length, 100); assert.equal(result.memberships, 118);
  assert.equal(new Set(result.people.map(p => p.record.nativeId)).size, 100);
  assert.deepEqual(result.people.flatMap(p => p.spaces.map(s => s.id)).sort(), sessions.flatMap(s => s.roomIds).sort());
});

test('archived participants are excluded while unknown space references are retained', () => {
  const result = project({ rooms, sessions: [session('S', [UNKNOWN]), session('T', ['shared'], { archived: true })] });
  assert.equal(result.total, 1); assert.equal(result.memberships, 1);
  assert.deepEqual(result.people[0].spaces, [{ id: UNKNOWN, name: UNKNOWN, unavailable: true, archived: false }]);
});

test('status projection keeps disconnected observations, missing clocks and fleet limits explicit', () => {
  const records = [session('S', ['shared'], { transportDisconnected: true }), session('T', [B], { state: 'unknown' }), session('U', [B])];
  const result = project({ rooms, sessions: records }, {}, true, 10000);
  assert.equal(result.people[0].facts.stale, true);
  assert.equal(result.people[0].facts.state, '连接状态待核对');
  assert.equal(result.people[1].facts.state, '状态未报告');
  assert.equal(result.people[2].facts.child, '子任务：未报告');
  assert.equal(result.people[2].facts.freshness, '更新时间未报告');
});

test('panorama uses valid observations from B while the current projection is A', () => {
  const record = session('S', ['shared', B], { state: 'working', activeTurnId: 'current',
    sharedActivity: null, sharedActivities: { [B]: { nativeId: 'native-S', turnId: 'current', observedAt: 9998 } } });
  const before = JSON.stringify(record);
  const observed = project({ rooms, sessions: [record] }, {}, true, 10000);
  assert.equal(observed.people[0].facts.freshness, '刚更新');
  assert.equal(observed.stats.unreportedTime, 0);
  assert.equal(JSON.stringify(record), before);
  for (const observation of [{ nativeId: 'another-native', observedAt: 9999 },
    { nativeId: 'native-S', turnId: 'old-turn', observedAt: 9999 },
    { nativeId: 'native-S', turnId: 'current', observedAt: 10001 }]) {
    const result = project({ rooms, sessions: [{ ...record, sharedActivities: { [B]: observation } }] }, {}, true, 10000);
    assert.equal(result.stats.unreportedTime, 1);
    assert.equal(result.people[0].facts.freshness, '更新时间未报告');
  }
});

test('global status counts use unique sessions and keep unknown clocks separate from connection state', () => {
  const records = [session('S', ['shared', B], { state: 'approval' }),
    session('T', ['shared'], { transportDisconnected: true }),
    session('U', [B], { state: 'not-reported' })];
  const result = project({ rooms, sessions: records }, { spaceId: B });
  assert.equal(result.total, 3); assert.equal(result.people.length, 2);
  assert.deepEqual(result.stats, { waiting: 1, disconnected: 1, unknownState: 1, unreportedTime: 3, stale: 1 });
});

test('an active return anchor survives more than 128 historical reading keys', () => {
  const position = { top: 15, follow: false, anchor: 'original-message', offset: -3 };
  const positions = Object.fromEntries([['origin', position], ...Array.from({ length: 130 }, (_, i) => [`old-${i}`, { ...position, anchor: `message-${i}` }])]);
  const bounded = pruneReading(positions, ['origin']);
  assert.equal(Object.keys(bounded).length, 128);
  assert.equal(bounded.origin, position); assert.equal(bounded['old-129'].anchor, 'message-129');
  assert.equal(bounded['old-0'], undefined); assert.equal(Object.keys(positions).length, 131);
  assert.equal(Object.hasOwn(bounded.origin, 'text'), false);
});

test('saved panorama metadata is bounded presentation data, never selected private text', () => {
  const panorama = { layout: 'list', query: 'same member', spaceId: B, top: 123.5, returning: true, focusId: 'S' };
  const view = { owner: 'synthetic-window', selected: 'panorama', panorama };
  assert.equal(validViews([view]), true);
  for (const delta of [{ query: 'x'.repeat(1001) }, { top: NaN }, { top: -1 }, { top: 1e10 },
    { spaceId: 'not-a-space-id' }, { layout: 'terminal' }, { returning: 'yes' }, { focusId: 'x'.repeat(101) },
    { text: 'private selected text' }, { recipient: 'someone else' }]) {
    assert.equal(validViews([{ ...view, panorama: { ...panorama, ...delta } }]), false);
  }
  assert.equal(validViews([{ owner: 'old-window', selected: 'room' }]), true, 'older view records remain valid');
});

test('an earlier pointer release cannot erase a newer source-reading snapshot', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const listeners = new Map();
  const doc = { activeElement: null, createElement: () => ({ dataset: {}, scrollTop: 0, classList: { add() {} }, append() {},
    addEventListener() {}, setAttribute() {} }), addEventListener: (name, fn) => listeners.set(name, fn) };
  const host = { ownerDocument: doc, classList: { add() {} }, append() {} };
  const api = create({ host });
  const article = { dataset: { panoramaSession: 'S' } };
  const quote = { dataset: { messageId: 'original' }, closest: () => article, contains: () => true };
  const text = { parentElement: { closest: () => quote } };
  const range = { startContainer: text, endContainer: text };
  api.reader.contains = node => node === quote;
  let selected = false;
  doc.getSelection = () => selected ? { isCollapsed: false, anchorNode: text, focusNode: text, getRangeAt: () => ({ cloneRange: () => range }) } : null;
  doc.activeElement = { dataset: { panoramaFocus: 'S' }, closest(selector) { return selector === '[data-panorama-session]' ? article : this; } };

  api.captureOrigin(true); listeners.get('pointerup')(); t.mock.timers.tick(1);
  assert.equal(api.captureOrigin().pointerCaptured, false, 'an unconsumed released pointer is discarded');

  api.captureOrigin(true); listeners.get('pointerup')();
  selected = true;
  const newer = api.captureOrigin(true);
  selected = false; // The browser button default can collapse the live selection.
  t.mock.timers.tick(1);
  assert.equal(api.captureOrigin(), newer, 'an older release owns only its original pending snapshot');
  assert.equal(newer.range, range, 'the newer original reading range survives until navigation consumes it');

  api.captureOrigin(true); listeners.get('pointercancel')();
  assert.equal(api.captureOrigin().pointerCaptured, false, 'cancelled pointers are still discarded');
});

test('the untouched default space shows its interface-language name; a renamed space stays as named (T-60)', () => {
  const binding = require('./fixtures/locale-ui.cjs')('zh'), spaces = require('../collaboration-spaces.cjs'), locale = require('../ui-locale.js');
  const { doc } = fakeDom(), host = new doc.Element('div');
  const spaceName = room => spaces.untouchedDefault(room) ? locale.format(binding.ui.language.getSnapshot().active, 'space.defaultName') : room.name;
  const api = create({ host, display: binding.ui.display, language: binding.ui.language, view: { spaceId: 'shared' }, spaceName, defaultSpace: spaces.untouchedDefault });
  api.update({ rooms: [{ id: 'shared', name: spaces.DEFAULT_ROOM_NAME }, { id: B, name: 'Team 中文' }], sessions: [session('S', ['shared', B])] });
  const filter = host.children[0].children.find(child => child.tagName === 'SELECT'), [, shared, team] = filter.children;
  assert.equal(shared.textContent, '共同工作'); assert.equal(team.textContent, 'Team 中文');
  const [sharedReference, teamReference] = api.reader.children[0].children[1].children, teamNode = teamReference.firstChild;
  assert.equal(sharedReference.textContent, '共同工作'); assert.equal(teamReference.textContent, 'Team 中文');
  binding.setLanguage('en'); binding.ui.display.refresh(host);
  assert.equal(sharedReference.textContent, 'Shared work', 'the default space reference repaints with the language');
  assert.equal(teamReference.textContent, 'Team 中文'); assert.equal(teamReference.firstChild, teamNode, 'a named reference keeps its raw node');
  assert.equal(shared.textContent, 'Shared work', 'the same option repaints in English'); assert.equal(team.textContent, 'Team 中文', 'a name the person gave is not translated');
  assert.equal(filter.children[1], shared); assert.equal(filter.value, 'shared');
});

test('a quote the person holds stays while the page no longer gets that session\'s messages (shown-sessions.cjs)', () => {
  const binding = require('./fixtures/locale-ui.cjs')('zh');
  const { doc } = fakeDom(); const Element = doc.Element;
  const host = new Element('div'), api = create({ host, display: binding.ui.display, language: binding.ui.language, view: { spaceId: 'shared' } });
  const rooms = [{ id: 'shared', name: 'A' }], record = session('S', ['shared'], { messages: [{ id: 'source', role: 'assistant', text: 'first reply' }] });
  api.update({ rooms, sessions: [record] });
  const row = api.reader.children[0], quote = row.children.find(child => child.tagName === 'BLOCKQUOTE');
  assert.equal(quote.textContent, 'first reply');
  // A selection in that quote; meanwhile a newer reply arrives and S's messages are left out of the page.
  const text = { parentElement: { closest: () => quote } };
  Object.assign(quote, { closest: selector => selector === '[data-panorama-session]' ? row : null, contains: () => true });
  api.reader.contains = node => node === quote;
  doc.getSelection = () => ({ isCollapsed: false, anchorNode: text, focusNode: text });
  const left = { ...record, messages: [], messagesOmitted: true, messageSummary: { lastAssistant: { id: 'newer', role: 'assistant', text: 'newer reply' } } };
  api.update({ rooms, sessions: [left] });
  assert.equal(quote.textContent, 'first reply'); assert.equal(quote.dataset.messageId, 'source');
  doc.getSelection = () => null;
  api.update({ rooms, sessions: [left] });
  assert.equal(quote.textContent, 'newer reply', 'let go: the newest reply, from the summary');
});
