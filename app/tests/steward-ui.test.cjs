const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const locale = require('../ui-locale.js'), spaces = require('../collaboration-spaces.cjs');

// The window side of the butler the person talks to (大管家), step 1: which sessions the lists hold, what the menus
// offer, the chooser, and the wiring in the page. The renderer's own functions, as written, over stand-ins.
// The real window, with its real rows and menus, is scripts/test-steward-entry.cjs.
const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8'), css = fs.readFileSync(path.join(__dirname, '../renderer/styles.css'), 'utf8');
const cut = (from, to) => { const start = renderer.indexOf(from), end = renderer.indexOf(to, start + from.length); assert.ok(start > 0 && end > start, from); return renderer.slice(start, end); };
class Element {
  constructor(tag = 'div', text) { this.tag = tag; this.children = []; this.hidden = false; this.disabled = false; this.textContent = text ?? ''; this.className = ''; this.open = false; this.value = ''; this.checked = false; this.isConnected = true; }
  append(...values) { this.children.push(...values); }
  replaceChildren(...values) { this.children = values; }
  querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
  focus() { this.focused = true; }
  close() { this.open = false; }
  showModal() { this.open = true; }
}
const S = (id, extra = {}) => ({ id, nativeId: 'native-' + id, name: id.toUpperCase(), provider: 'claude', state: 'idle', ...extra });
function fixture({ sessions, steward = null, order = [], disconnected = false, refuse = null } = {}) {
  const elements = new Map(), calls = [], selected = [], shown = [];
  const $ = id => { if (!elements.has(id)) elements.set(id, new Element(id === 'steward-dialog' ? 'dialog' : 'div')); return elements.get(id); };
  const state = { sessions, steward, sidebar: { order }, rooms: [{ id: 'shared', name: '网站改版' }] };
  const context = vm.createContext({ state, $, disconnected, document: { activeElement: null }, window: { nativeWorkspaceSpaces: spaces },
    api: { steward: async id => { calls.push(id); if (refuse) throw refuse; state.steward = id === null ? null : { sessionId: id, nativeId: 'native-' + id }; }, initial: async () => state },
    uiText: (key, params) => locale.format('zh', key, params), updateState: next => { calls.push('state'); return next; }, render: () => calls.push('render'), select: async id => { selected.push(id); },
    ui: { display: { text: (el, key) => { el.textContent = locale.format('zh', key); }, computed: (el, _slot, read) => { el.textContent = read(); } }, showError: (el, error) => { shown.push(error); el.textContent = 'shown'; } },
    node: (tag, text, cls) => { const el = new Element(tag, text); if (cls) el.className = cls; return el; }, icon: provider => new Element('span', provider),
    spaceRecord: id => state.rooms.find(room => room.id === id), spaceName: room => room.name, sidebarPresentation: record => ({ compact: record.state === 'working' ? '正在工作' : '会话就绪' }),
    contentMenu: null, sessionMenu: null, roomMenu: null, dialogTickets: new Map() });
  vm.runInContext(cut('function sidebarSessions() {', 'function sameNameSessions('), context);
  vm.runInContext(cut('function stewardAction(record) {', '// The integrator is one session outside every space (B6).'), context);
  vm.runInContext(cut('function openTransientDialog(id) {', 'let trustScope = null'), context);
  // Values made inside the renderer's context are copied out, so they compare as plain values here.
  const run = code => { const value = vm.runInContext(code, context); return value && typeof value === 'object' && typeof value.then !== 'function' ? JSON.parse(JSON.stringify(value)) : value; };
  const rows = () => $('steward-list').children.map(row => { const [radio, , text] = row.children; return [text.children[0].textContent, text.children[1].textContent, radio.disabled, radio.checked]; });
  return { state, context, calls, selected, shown, $, run, rows, pick: id => $('steward-list').children.map(row => row.children[0]).find(radio => radio.value === id).onchange() };
}
const zh = (key, params) => locale.format('zh', key, params);

test('the lists hold every unarchived session but the butler, which is looked up apart; an archived or missing butler is nobody', () => {
  const sessions = [S('a'), S('b'), S('c', { archived: true }), S('d')];
  const f = fixture({ sessions, steward: { sessionId: 'b', nativeId: 'native-b' }, order: ['d', 'b', 'a'] });
  assert.deepEqual(f.run('sidebarSessions().map(s => s.id)'), ['d', 'a']); assert.equal(f.run('stewardRecord().id'), 'b');
  // The count beside "Sessions" is of the listed ones (the renderer's own line).
  const count = cut('  const visible = state.sessions.filter(s => !s.archived && s.id !== state.steward?.sessionId);', '\n');
  assert.equal(vm.runInContext(count + ' visible.length', f.context), 2);
  for (const steward of [null, { sessionId: 'c', nativeId: 'native-c' }, { sessionId: 'gone', nativeId: 'x' }]) {
    const g = fixture({ sessions, steward });
    assert.equal(g.run('stewardRecord()'), null); assert.deepEqual(g.run('sidebarSessions().map(s => s.id)'), ['a', 'b', 'd']);
  }
});

test('the entry says nobody is designated only when nobody is, and drawing it asks the main process nothing', () => {
  const f = fixture({ sessions: [S('a')] });
  f.context.api = new Proxy({}, { get(_target, name) { throw Error('Drawing reached the main process: ' + String(name)); } });
  f.run('renderStewardEntry(null)'); assert.deepEqual([f.$('steward-empty').hidden, f.$('steward-empty').disabled], [false, false]);
  f.run('renderStewardEntry(state.sessions[0])'); assert.equal(f.$('steward-empty').hidden, true);
  const off = fixture({ sessions: [], disconnected: true }); off.run('renderStewardEntry(null)'); assert.deepEqual([off.$('steward-empty').hidden, off.$('steward-empty').disabled], [false, true]);
});

test('the menus offer change and revoke on the butler, "make it the butler" on a session that can be one, and nothing elsewhere', async () => {
  const sessions = [S('butler'), S('free'), S('member', { roomIds: ['shared'] }), S('old', { archived: true }), S('raw', { nativeId: null })];
  const f = fixture({ sessions, steward: { sessionId: 'butler', nativeId: 'native-butler' } });
  const ids = id => f.run(`stewardAction(state.sessions.find(s => s.id === '${id}')).map(item => [item.id, item.label])`);
  assert.deepEqual(ids('butler'), [['steward-change', zh('menu.stewardChange')], ['steward-revoke', zh('menu.stewardRevoke')]]);
  assert.deepEqual(ids('free'), [['steward-set', zh('menu.stewardSet')]]);
  for (const id of ['member', 'old', 'raw']) assert.deepEqual(ids(id), [], id);
  assert.deepEqual(f.run('stewardAction(undefined)'), []);
  // The butler is offered its two items wherever it is now, also when it has since been archived.
  f.state.steward = { sessionId: 'old', nativeId: 'native-old' }; assert.equal(ids('old').length, 2);
  // A window without the call offers nothing.
  delete f.context.api.steward; assert.deepEqual(ids('free'), []);

  // Designating and revoking go to the main process and the window reads the state back.
  const g = fixture({ sessions, steward: { sessionId: 'butler', nativeId: 'native-butler' } });
  await g.run("chooseSteward('free')"); assert.deepEqual(g.calls, ['free', 'state', 'render']);
  // A menu opened before the designation moved must not revoke somebody else's.
  g.calls.length = 0; await g.run("chooseSteward('butler', true)"); assert.deepEqual(g.calls, [], 'butler is no longer the butler: nothing is revoked');
  await g.run("chooseSteward('free', true)"); assert.deepEqual(g.calls, [null, 'state', 'render']); assert.equal(g.state.steward, null);
});

test('the chooser lists the butler first, says why a session cannot be chosen, and designates only a different, usable choice', async () => {
  const sessions = [S('free', { state: 'working' }), S('member', { roomIds: ['shared'] }), S('butler'), S('raw', { nativeId: null }), S('done', { state: 'ended' }), S('old', { archived: true })];
  const f = fixture({ sessions, steward: { sessionId: 'butler', nativeId: 'native-butler' }, order: ['member', 'free'] });
  f.run('openStewardChooser()');
  assert.equal(f.$('steward-dialog').open, true);
  assert.deepEqual(f.rows(), [['BUTLER', zh('steward.choose.current'), false, true], ['MEMBER', zh('steward.choose.inSpace', { space: '网站改版' }), true, false], ['FREE', '正在工作', false, false],
    ['RAW', zh('steward.choose.unusable'), true, false], ['DONE', zh('steward.choose.unusable'), true, false]], 'The archived session is not listed');
  assert.deepEqual([f.$('steward-none').hidden, f.$('steward-confirm').disabled], [true, true], 'Choosing the session that already is the butler is not a change');
  f.pick('free'); assert.deepEqual([f.rows()[2][3], f.rows()[0][3], f.$('steward-confirm').disabled], [true, false, false]);
  await f.run('confirmSteward()');
  assert.deepEqual([f.calls, f.selected, f.$('steward-dialog').open], [['free', 'state'], ['free'], false], 'Designated, closed, and the window shows what was chosen');

  // A choice that stops being usable while the dialog is open is dropped, not sent.
  const g = fixture({ sessions: [S('a'), S('b')] }); g.run('openStewardChooser()'); g.pick('a'); assert.equal(g.$('steward-confirm').disabled, false);
  g.state.sessions[0].roomIds = ['shared']; g.run('renderStewardChooser()');
  assert.deepEqual([g.$('steward-confirm').disabled, g.rows()[0][3]], [true, false]); await g.run('confirmSteward()'); assert.deepEqual(g.calls, []);

  // Nobody to choose: the dialog says what to do, and there is nothing to confirm.
  const none = fixture({ sessions: [S('member', { roomIds: ['shared'] })] }); none.run('openStewardChooser()');
  assert.deepEqual([none.$('steward-none').hidden, none.$('steward-confirm').disabled, none.rows().length], [false, true, 1]);

  // A refusal from the main process is said in the dialog, which stays open with the choice.
  const refusal = Object.assign(Error('refused'), { uiMessage: { key: 'error.steward.inSpace' } }), h = fixture({ sessions: [S('a'), S('b')], refuse: refusal });
  h.run('openStewardChooser()'); h.pick('b'); await h.run('confirmSteward()');
  assert.deepEqual([h.shown, h.$('steward-error').hidden, h.$('steward-dialog').open, h.selected, h.rows()[1][3]], [[refusal], false, true, [], true]);

  // While disconnected the chooser does not open.
  const off = fixture({ sessions: [S('a')], disconnected: true }); off.run('openStewardChooser()'); assert.equal(off.$('steward-dialog').open, false);
});

test('the page has the entry above everything else, the mark before the title and the chooser among the dialogs; the window wires them', () => {
  // Under the brand, before the built-in butler's own closed row and "new session".
  assert.match(html, /<\/div>\n    <div id="steward-entry" class="steward-entry"><button id="steward-empty" class="butler-row steward-empty" type="button" aria-haspopup="dialog" data-butler-state="empty"[^>]* hidden>.*<\/button><div id="steward-slot" class="steward-slot"><\/div><\/div>\n    <button id="butler-row" class="butler-row" type="button" aria-haspopup="dialog" hidden><\/button>\n    <button class="new-button" id="new-session"/);
  assert.ok(html.includes('data-naw-aria-label="steward.emptyLabel"') && html.includes('<span class="rail-label" data-naw-text="butler.name"></span><span class="butler-state"><span data-naw-text="butler.row.empty"></span></span>'));
  assert.ok(html.includes('<span id="steward-badge" class="steward-badge" hidden></span><h1 id="title"'));
  assert.match(html, /<dialog closedby="any" id="steward-dialog" class="butler-dialog steward-dialog" aria-labelledby="steward-dialog-title">.*<div id="steward-list" class="steward-list" role="radiogroup"[^>]*><\/div>.*<p id="steward-error" role="alert" hidden><\/p>.*<button id="steward-confirm" type="button" class="primary" data-naw-text="steward.choose.confirm"><\/button><\/div><\/dialog>\n  <dialog closedby="any" id="butler-dialog"/);
  // The row is the same row any session has, in the entry's place; it is not dragged and not reordered.
  assert.ok(renderer.includes("if (butler) { const key = `steward:${butler.id}`; occurrences.unshift({ record: butler, key, group: null, container: $('steward-slot'), steward: true }); keys.add(key); }"));
  assert.ok(renderer.includes("if (steward) element.classList.add('steward-row'); else { draggableSession(link, record.id, true, group || ''); sidebarDropRow(element, record.id, group); }"));
  assert.ok(renderer.includes("if (steward) { ui.display.text(row.name, 'butler.name'); row.shortId.textContent = ''; ui.display.computed(row.status, 'text', () => uiText('steward.rowStatus', { name: record.name, status: sidebarPresentation(record).compact })); }"));
  assert.ok(renderer.includes("...(index >= 0 && index < visible.length - 1 ? [{ id: 'down'"), 'A row that is not in the list is not offered "move down"');
  assert.ok(renderer.includes("const roomItems = isSteward && !window.nativeWorkspaceSpaces.roomIds(record).length ? [] :"));
  // Both menus offer the same items and carry them out the same way; the butler's header has no "join".
  assert.ok(renderer.includes("const actions = [...update, ...stewardAction(record), ...secretary, ...integratorAction(record), "));
  assert.ok(renderer.includes("if (!terminal) actions.push(...stewardAction(current()).map(item => ({ ...item, secretary: true })));"));
  assert.equal(renderer.match(/action === 'steward-set' \|\| action === 'steward-revoke'/g).length, 2); assert.equal(renderer.match(/action === 'steward-change'\) openStewardChooser\(\);/g).length, 2);
  assert.ok(renderer.includes("if (isButler && !inSpace(s)) h.membership.hidden = true;") && renderer.includes("&& !(item.id === 'membership' && item.control.hidden));"));
  assert.ok(renderer.includes("state.queueSecretary, state.integrator, state.steward, disconnected]);"), 'An open header menu closes when the designation moves');
  // The first window of a start lands on the butler; any other window is where it was.
  assert.ok(renderer.includes("const landing = typeof api.landing === 'function' && await api.landing() ? stewardRecord() : null;\n  await select(landing ? landing.id : state.viewState.selected || '', mode); await api.uiReady();"));
  assert.ok(renderer.includes("$('steward-empty').onclick = () => openStewardChooser();") && renderer.includes("$('steward-confirm').onclick = () => attempt(confirmSteward);"));
  // Its look: the butler's row is marked, and the chooser's rows are one line each whatever the page says of labels.
  for (const rule of ['.steward-row .agent-icon{background:var(--ink);color:var(--surface,#fff)}', '.steward-slot:empty{display:none}', 'dialog.steward-dialog label.steward-pick{display:grid;']) assert.ok(css.includes(rule), rule);
});
