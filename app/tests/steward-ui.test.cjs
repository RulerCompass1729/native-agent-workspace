const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const vendorMarks = require('./fixtures/vendor-marks.cjs');
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
  setAttribute(name, value) { (this.attributes ??= {})[name] = String(value); }
  getAttribute(name) { return this.attributes?.[name] ?? null; }
  focus() { this.focused = true; }
  closest() { return this; }
  scrollIntoView() { this.shown = true; }
  close() { this.open = false; }
  showModal() { this.open = true; }
}
const S = (id, extra = {}) => ({ id, nativeId: 'native-' + id, name: id.toUpperCase(), provider: 'claude', state: 'idle', ...extra });
function fixture({ sessions, steward = null, order = [], disconnected = false, refuse = null, duty = undefined, standing = undefined } = {}) {
  const elements = new Map(), calls = [], selected = [], shown = [], duties = [], toasts = [], standings = [], handoffs = [];
  const $ = id => { if (!elements.has(id)) elements.set(id, new Element(id === 'steward-dialog' ? 'dialog' : 'div')); return elements.get(id); };
  const state = { sessions, steward, sidebar: { order }, rooms: [{ id: 'shared', name: '网站改版' }] };
  const context = vm.createContext({ state, $, disconnected, document: { activeElement: null }, window: { nativeWorkspaceSpaces: spaces },
    api: { ...(standing === undefined ? {} : { stewardStanding: async () => { if (standing instanceof Error) throw standing; return standing; } }), steward: async (id, text, keep, said) => { calls.push(id); duties.push(text); standings.push(keep); handoffs.push(said); if (refuse) throw refuse; state.steward = id === null ? null : { sessionId: id, nativeId: 'native-' + id }; return duty === undefined ? (id === null ? null : { duty: { state: 'sent' } }) : duty; }, initial: async () => state },
    toast: () => {}, toastMessage: (key, params) => toasts.push(locale.format('zh', key, params?.())),
    uiText: (key, params) => locale.format('zh', key, params), updateState: next => { calls.push('state'); return next; }, render: () => calls.push('render'), select: async id => { selected.push(id); },
    ui: { display: { text: (el, key) => { el.textContent = locale.format('zh', key); }, computed: (el, slot, read) => { if (slot === 'text') { el.textContent = read(); if (el === $('toast-text')) toasts.push(el.textContent); } else el.setAttribute(slot, read()); } }, showError: (el, error) => { shown.push(error); el.textContent = 'shown'; },
      errorText: error => error.uiMessage ? locale.format('zh', error.uiMessage.key, error.uiMessage.params) : error.message },
    node: (tag, text, cls) => { const el = new Element(tag, text); if (cls) el.className = cls; return el; }, icon: provider => new Element('span', provider),
    spaceRecord: id => state.rooms.find(room => room.id === id), spaceName: room => room.name, sidebarPresentation: record => ({ compact: record.state === 'working' ? '正在工作' : '会话就绪' }),
    uiError: (key, params) => Object.assign(Error(key), { uiMessage: { key, params } }), crypto: { randomUUID: () => 'folder-1' }, setTimeout, Date, TextEncoder,
    contentMenu: null, sessionMenu: null, roomMenu: null, dialogTickets: new Map() });
  vendorMarks(renderer, context);
  vm.runInContext(cut('function sidebarSessions() {', 'function sameNameSessions('), context);
  vm.runInContext(cut('function stewardAction(record) {', '// The integrator is one session outside every space (B6).'), context);
  vm.runInContext(cut('function openTransientDialog(id) {', 'let trustScope = null'), context);
  // Values made inside the renderer's context are copied out, so they compare as plain values here.
  const run = code => { const value = vm.runInContext(code, context); return value && typeof value === 'object' && typeof value.then !== 'function' ? JSON.parse(JSON.stringify(value)) : value; };
  const rows = () => $('steward-list').children.map(row => { const [radio, , text] = row.children; return [text.children[0].textContent, text.children[1].textContent, radio.disabled, radio.checked]; });
  return { state, context, calls, selected, shown, duties, toasts, standings, handoffs, $, run, rows, pick: id => $('steward-list').children.map(row => row.children[0]).find(radio => radio.value === id).onchange() };
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

  // Revoking goes to the main process and the window reads the state back. (Designating goes through the chooser.)
  const g = fixture({ sessions, steward: { sessionId: 'free', nativeId: 'native-free' } });
  // A menu opened before the designation moved must not revoke somebody else's.
  await g.run("revokeSteward('butler')"); assert.deepEqual(g.calls, [], 'butler is no longer the butler: nothing is revoked');
  await g.run("revokeSteward('free')"); assert.deepEqual(g.calls, [null, 'state', 'render']); assert.equal(g.state.steward, null);
  // "Make it the butler" in a session's menu opens the chooser with that session chosen.
  const h = fixture({ sessions, steward: { sessionId: 'butler', nativeId: 'native-butler' } });
  h.run("openStewardChooser('free')"); assert.deepEqual([h.$('steward-dialog').open, h.rows().find(row => row[0] === 'FREE')[3], h.$('steward-confirm').textContent], [true, true, zh('steward.choose.confirm')]);
});

test('the chooser lists the butler first, says why a session cannot be chosen, designates a usable choice, and shows the duty statement it sends', async () => {
  const sessions = [S('free', { state: 'working' }), S('member', { roomIds: ['shared'] }), S('butler'), S('raw', { nativeId: null }), S('done', { state: 'ended' }), S('old', { archived: true })];
  const f = fixture({ sessions, steward: { sessionId: 'butler', nativeId: 'native-butler' }, order: ['member', 'free'] });
  f.run('openStewardChooser()');
  assert.equal(f.$('steward-dialog').open, true);
  assert.deepEqual(f.rows(), [['BUTLER', zh('steward.choose.current'), false, true], ['MEMBER', zh('steward.choose.inSpace', { space: '网站改版' }), true, false], ['FREE', '正在工作', false, false],
    ['RAW', zh('steward.choose.unusable'), true, false], ['DONE', zh('steward.choose.unusable'), true, false]], 'The archived session is not listed');
  // The vendor mark beside each name is one labelled image, so a screen reader hears who made the model, not a bare letter.
  const mark = f.$('steward-list').children[0].children[1], label = zh('vendor.label', { vendor: 'Anthropic', shell: 'Claude Code' });
  assert.deepEqual([mark.getAttribute('role'), mark.getAttribute('aria-label'), mark.getAttribute('title')], ['img', label, label]);
  // The butler chosen: confirming sends it the duty statement again, and the button says so.
  assert.deepEqual([f.$('steward-none').hidden, f.$('steward-confirm').disabled, f.$('steward-confirm').textContent], [true, false, zh('steward.choose.resend')]);
  assert.deepEqual([f.$('steward-duty').hidden, f.$('steward-duty-label').hidden, f.$('steward-duty').value], [false, false, zh('steward.duty.default')], 'The default text of the person\'s language, to edit');
  f.pick('free'); assert.deepEqual([f.rows()[2][3], f.rows()[0][3], f.$('steward-confirm').disabled, f.$('steward-confirm').textContent], [true, false, false, zh('steward.choose.confirm')]);
  await f.run('confirmSteward()');
  assert.deepEqual([f.calls, f.duties, f.selected, f.$('steward-dialog').open], [['free', 'state'], [null], ['free'], false], 'Designated with the default (sent as null, so it follows the language), closed, and shown');

  // Text the person wrote is sent as written, and is what the chooser shows next time.
  const own = fixture({ sessions: [S('a')] }); own.run('openStewardChooser()'); own.pick('a'); own.$('steward-duty').value = '只做排期，不做执行。';
  await own.run('confirmSteward()'); assert.deepEqual(own.duties, ['只做排期，不做执行。']);
  own.state.stewardDuty = '只做排期，不做执行。'; own.run('openStewardChooser()'); assert.equal(own.$('steward-duty').value, '只做排期，不做执行。');

  // Designated, but the statement did not go in: the dialog stays open and says why; dismissed meanwhile, a toast says it.
  const busy = { duty: { state: 'not-sent', error: { message: 'x', uiMessage: { key: 'error.steward.dutyBusy' } } } };
  const late = fixture({ sessions: [S('a')], duty: busy }); late.run('openStewardChooser()'); late.pick('a'); await late.run('confirmSteward()');
  assert.deepEqual([late.$('steward-dialog').open, late.$('steward-error').hidden, late.$('steward-error').textContent, late.selected, late.$('steward-confirm').textContent],
    [true, false, zh('steward.duty.notSent', { reason: zh('error.steward.dutyBusy') }), [], zh('steward.choose.resend')]);
  let letGo; const gone = fixture({ sessions: [S('a')], duty: busy }); const send = gone.context.api.steward; gone.context.api.steward = (...args) => new Promise(resolve => { letGo = () => resolve(send(...args)); });
  gone.run('openStewardChooser()'); gone.pick('a'); const waiting = gone.run('confirmSteward()'); gone.$('steward-dialog').close(); gone.context.dialogTickets.delete(gone.$('steward-dialog')); letGo(); await waiting;
  assert.deepEqual([gone.toasts, gone.selected], [[zh('steward.duty.notSent', { reason: zh('error.steward.dutyBusy') })], []]);

  // A choice that stops being usable while the dialog is open is dropped, not sent.
  const g = fixture({ sessions: [S('a'), S('b')] }); g.run('openStewardChooser()'); g.pick('a'); assert.equal(g.$('steward-confirm').disabled, false);
  g.state.sessions[0].roomIds = ['shared']; g.run('renderStewardChooser()');
  assert.deepEqual([g.$('steward-confirm').disabled, g.rows()[0][3]], [true, false]); await g.run('confirmSteward()'); assert.deepEqual(g.calls, []);

  // Nobody to choose: the dialog says what to do, and there is nothing to confirm.
  const none = fixture({ sessions: [S('member', { roomIds: ['shared'] })] }); none.run('openStewardChooser()');
  assert.deepEqual([none.$('steward-none').hidden, none.$('steward-confirm').disabled, none.rows().length, none.$('steward-duty').hidden, none.$('steward-duty-label').hidden], [false, true, 1, true, true]);

  // A refusal from the main process is said in the dialog, which stays open with the choice.
  const refusal = Object.assign(Error('refused'), { uiMessage: { key: 'error.steward.inSpace' } }), h = fixture({ sessions: [S('a'), S('b')], refuse: refusal });
  h.run('openStewardChooser()'); h.pick('b'); await h.run('confirmSteward()');
  assert.deepEqual([h.shown, h.$('steward-error').hidden, h.$('steward-dialog').open, h.selected, h.rows()[1][3]], [[refusal], false, true, [], true]);

  // The person dismissed the chooser and moved on while the call was on its way: the designation stands, and the
  // window is not pulled to the butler.
  let release; const slow = fixture({ sessions: [S('a'), S('b')] }); slow.context.api.steward = id => new Promise(resolve => { release = () => { slow.state.steward = { sessionId: id, nativeId: 'native-' + id }; resolve(); }; });
  slow.run('openStewardChooser()'); slow.pick('a'); const pending = slow.run('confirmSteward()'); slow.$('steward-dialog').close(); slow.context.dialogTickets.delete(slow.$('steward-dialog')); release(); await pending;
  assert.deepEqual([slow.state.steward.sessionId, slow.selected], ['a', []]);
  // While disconnected the chooser does not open.
  const off = fixture({ sessions: [S('a')], disconnected: true }); off.run('openStewardChooser()'); assert.equal(off.$('steward-dialog').open, false);
});

test('a text that cannot be sent is said before there is a session, by the same rule the main process has', async () => {
  const { DUTY_MAX, validDuty } = require('../steward-role.cjs');
  for (const [id, key] of [['steward-duty', 'error.steward.dutyInvalid'], ['steward-handoff', 'error.steward.handoffInvalid']]) for (const bad of ['x'.repeat(DUTY_MAX), '说'.repeat(Math.ceil(DUTY_MAX / 3)), 'a\u0000b', ...(id === 'steward-duty' ? ['  '] : [])]) {
    const f = making(); f.open(); f.$(id).value = bad; await f.run('confirmSteward()');
    assert.deepEqual([f.created, f.shown.map(error => error.uiMessage.key), f.handoffs, f.$('steward-dialog').open, f.$('steward-confirm').disabled], [[], [key], [], true, false], JSON.stringify([id, bad.slice(0, 5)]));
  }
  const f = making(); for (const text of ['', ' ', 'a', '说\n做', 'x'.repeat(DUTY_MAX - 2), 'x'.repeat(DUTY_MAX - 1), '"'.repeat(DUTY_MAX / 2 - 1), '"'.repeat(DUTY_MAX / 2), 'a\u0007', 'a\tb', 'a\u007f']) {
    f.context.text = text; assert.equal(f.run('stewardTextValid(text)'), validDuty(text), JSON.stringify(text.slice(0, 6)));
  }
});

// M82 (the person, 2026-11-21): the butler changed for a session opened there and then, from the same dialog.
const CAN = ['createSettingsV1', 'createSkipPermissions'];
function making(options = {}, { ready = 0, record = {}, capabilities = CAN, refuseCreate = null } = {}) {
  const f = fixture({ sessions: [S('butler', { name: '大管家 7', cwd: '/synthetic/butler' }), S('a')], steward: { sessionId: 'butler', nativeId: 'native-butler' }, ...options }), created = [];
  let reads = 0; f.state.capabilities = capabilities; f.created = created;
  f.context.api.create = async value => {
    created.push(JSON.parse(JSON.stringify(value))); if (refuseCreate) throw refuseCreate;
    f.state.sessions.push(S('made', { name: value.name, state: 'starting', nativeId: null })); reads = 0; f.due = ready; return 'made';
  };
  f.context.api.createDefaults = async () => ({ directory: '' });
  // The session is there at once and can take a message only a little later, as a native start does.
  const settle = () => { const made = f.state.sessions.find(s => s.id === 'made'); if (made && made.state === 'starting' && ++reads > f.due) Object.assign(made, { state: 'idle', nativeId: 'native-made' }, record); };
  f.context.updateState = value => { f.calls.push('state'); settle(); return value; };
  // The renderer polls its own state: each pause is one step of the session's start.
  f.context.setTimeout = (done, ms) => setImmediate(() => { settle(); f.paused?.(ms); done(); });
  f.open = chosen => { f.run('openStewardChooser()'); f.pick(chosen ?? 'new'); };
  return f;
}
const boxes = f => Object.fromEntries(['steward-new', 'steward-handoff', 'steward-handoff-label', 'steward-new-note', 'steward-new-permission', 'steward-none', 'steward-duty'].map(id => [id, !f.$(id).hidden]));
const HIDDEN = { 'steward-new': false, 'steward-handoff': false, 'steward-handoff-label': false, 'steward-new-note': false, 'steward-new-permission': false, 'steward-none': false, 'steward-duty': true };

test('the chooser\'s last row opens a new session as the butler; its box is there only while that row is chosen, and skipping permission checks is not ticked', () => {
  // A backend that cannot open a session with a model and an effort is not offered it, and the chooser is as it was.
  for (const capabilities of [undefined, [], ['createSettingsV1'], ['createSkipPermissions']]) {
    const f = making({}, {}); f.state.capabilities = capabilities; f.run('openStewardChooser()');
    assert.deepEqual([f.rows().length, boxes(f)], [2, HIDDEN], JSON.stringify(capabilities));
  }
  const without = making(); delete without.context.api.create; without.run('openStewardChooser()'); assert.equal(without.rows().length, 2);

  const f = making(); f.$('steward-new-model').value = 'claude-haiku-5-5'; f.$('steward-new-skip').checked = true;
  f.run('openStewardChooser()');
  assert.deepEqual(f.rows().at(-1), [zh('steward.new.title'), zh('steward.new.folder', { folder: '/synthetic/butler' }), false, false]);
  assert.deepEqual([f.rows().length, f.rows()[0][3], boxes(f)], [3, true, HIDDEN], 'The butler there is stays chosen');
  f.pick('new');
  assert.deepEqual(boxes(f), { ...HIDDEN, 'steward-new': true, 'steward-handoff': true, 'steward-handoff-label': true, 'steward-new-note': true });
  assert.deepEqual([f.$('steward-new-model').value, f.$('steward-new-effort').value, f.$('steward-new-skip').checked], ['claude-opus-5-5', 'xhigh', false], 'Whatever was chosen the last time');
  assert.deepEqual([f.$('steward-handoff').value, f.$('steward-duty').value], [zh('steward.new.handoffDefault', { name: '大管家 7' }), zh('steward.duty.default')]);
  assert.deepEqual([f.$('steward-confirm').textContent, f.$('steward-confirm').disabled, f.$('steward-duty-label').textContent], [zh('steward.new.confirm'), false, zh('steward.new.duty')]);
  // A butler whose own session skips permission checks: the new one is asked for it, not given it.
  for (const extra of [{ skipPermissions: true }, { nativePermissionMode: 'bypassPermissions' }]) {
    const g = making({ sessions: [S('butler', { name: '大管家 7', cwd: '/synthetic/butler', ...extra })] }); g.open(); assert.equal(g.$('steward-new-skip').checked, false);
  }
  f.$('steward-new-skip').checked = true; f.run('renderStewardChooser()'); assert.equal(boxes(f)['steward-new-permission'], true);
  f.pick('a'); assert.deepEqual([boxes(f), f.$('steward-confirm').textContent, f.$('steward-duty-label').textContent], [{ ...HIDDEN, 'steward-new-permission': true }, zh('steward.choose.confirm'), zh('steward.duty.label')], 'inside the hidden box');

  // Nobody is the butler: it is the one thing to choose, with nobody to take over from.
  const first = making({ sessions: [], steward: null }); first.run('openStewardChooser()');
  assert.deepEqual([first.rows(), boxes(first), first.$('steward-confirm').disabled], [[[zh('steward.new.title'), zh('steward.new.outside'), false, false]], HIDDEN, true]);
  first.pick('new'); assert.deepEqual([boxes(first), first.$('steward-confirm').disabled, first.$('steward-handoff').value], [{ ...HIDDEN, 'steward-new': true }, false, '']);
  // While disconnected it cannot be chosen; a choice the backend no longer offers is dropped, not sent.
  const g = making(); g.open(); g.context.disconnected = true; g.run('renderStewardChooser()'); assert.deepEqual([g.rows().at(-1)[2], g.$('steward-confirm').disabled], [true, true]);
  g.context.disconnected = false; g.state.capabilities = []; g.run('renderStewardChooser()'); assert.deepEqual([g.rows().length, g.$('steward-confirm').disabled, boxes(g)], [2, true, HIDDEN]);
});

test('opening it makes one Claude session outside every space and designates it only once it can take a message, the handoff with it', async () => {
  const f = making({}, { ready: 3 }), seen = []; f.open();
  f.paused = () => seen.push([f.state.steward.sessionId, f.$('steward-confirm').disabled, f.$('steward-confirm').textContent, f.rows().every(row => row[2])]);
  await f.run('confirmSteward()');
  assert.equal(f.created.length, 1); const { name, ...rest } = f.created[0];
  assert.deepEqual(rest, { provider: 'claude', cwd: '/synthetic/butler', view: 'chat', settings: { model: 'claude-opus-5-5', effort: 'xhigh' } });
  assert.match(name, /^大管家 \d\d-\d\d \d\d:\d\d$/);
  assert.ok(seen.length >= 2, 'it waited'); for (const step of seen.slice(0, -1)) assert.deepEqual(step, ['butler', true, zh('steward.new.making'), true], 'The butler has not changed and nothing can be clicked meanwhile');
  assert.deepEqual([f.calls.filter(c => c === 'made'), f.handoffs, f.duties, f.standings], [['made'], [zh('steward.new.handoffDefault', { name: '大管家 7' })], [null], [null]]);
  assert.deepEqual([f.state.steward.sessionId, f.selected, f.$('steward-dialog').open, f.toasts], ['made', ['made'], false, []]);

  // What the person changed is what is used; cleared fields are left to the native defaults, a cleared handoff is not sent.
  const own = making(); own.open(); own.$('steward-new-model').value = 'claude-sonnet-5-5'; own.$('steward-new-effort').value = ''; own.$('steward-new-skip').checked = true; own.$('steward-handoff').value = '  \n'; own.$('steward-duty').value = '只管派活。';
  await own.run('confirmSteward()'); assert.deepEqual([own.created[0].settings, own.created[0].skipPermissions, own.handoffs, own.duties], [{ model: 'claude-sonnet-5-5' }, true, [null], ['只管派活。']]);
  const native = making(); native.open(); native.$('steward-new-model').value = native.$('steward-new-effort').value = ''; await native.run('confirmSteward()'); assert.equal(Object.hasOwn(native.created[0], 'settings'), false);
  // Choosing an ordinary session is as it was: nothing made, nothing handed over.
  const plain = making(); plain.open('a'); await plain.run('confirmSteward()'); assert.deepEqual([plain.created, plain.handoffs, plain.state.steward.sessionId], [[], [null], 'a']);

  // With nobody to replace: the person's own default folder, else the ordinary new folder, else the workspace.
  for (const [defaults, state, place] of [[{ directory: '/synthetic/chosen' }, {}, { cwd: '/synthetic/chosen' }],
    [{ directory: '' }, { capabilities: [...CAN, 'newSessionDirectory'], newWorkspaceRoot: '/synthetic/new' }, { cwd: '/synthetic/new/folder-1', newDirectory: true }],
    [null, { defaultWorkspace: '/synthetic/workspace' }, { cwd: '/synthetic/workspace' }]]) {
    const first = making({ sessions: [], steward: null }); Object.assign(first.state, state); first.context.api.createDefaults = async () => defaults; first.open();
    await first.run('confirmSteward()'); const { cwd, newDirectory } = first.created[0];
    assert.deepEqual([{ cwd, ...(newDirectory ? { newDirectory } : {}) }, first.handoffs, first.state.steward.sessionId], [place, [null], 'made']);
  }
});

test('a new session that cannot be opened, cannot start or does not get ready leaves the butler as it is, and the dialog says why', async () => {
  // Refused before there is a session.
  const refusal = Object.assign(Error('refused'), { uiMessage: { key: 'error.steward.inSpace' } }), refused = making({}, { refuseCreate: refusal }); refused.$('steward-dialog').scrollHeight = 900; refused.open(); await refused.run('confirmSteward()');
  assert.deepEqual([refused.shown.map(error => ({ key: error.uiMessage.key, params: { ...error.uiMessage.params } })), refused.$('steward-error').hidden, refused.$('steward-dialog').open, refused.handoffs, refused.state.steward.sessionId, refused.$('steward-dialog').scrollTop], [[{ key: 'error.steward.newRefused', params: { reason: zh('error.steward.inSpace') } }], false, true, [], 'butler', 900]);
  assert.deepEqual([refused.rows().at(-1)[3], refused.$('steward-confirm').disabled, refused.$('steward-confirm').textContent], [true, false, zh('steward.new.confirm')], 'It can be tried again');
  // The row that comes in above it afterwards does not push it away; a person who has scrolled up is left there.
  Object.assign(refused.$('steward-dialog'), { clientHeight: 400, scrollTop: 500 }); const grow = { get: () => 600 + refused.rows().length * 100, configurable: true };
  Object.defineProperty(refused.$('steward-dialog'), 'scrollHeight', grow); assert.equal(refused.rows().length, 3);
  refused.state.sessions.push(S('failed', { state: 'error' })); refused.run('renderStewardChooser()'); assert.equal(refused.$('steward-dialog').scrollTop, 1000);
  refused.$('steward-dialog').scrollTop = 100; refused.state.sessions.push(S('c')); refused.run('renderStewardChooser()'); assert.equal(refused.$('steward-dialog').scrollTop, 100);
  refused.$('steward-error').hidden = true; refused.$('steward-dialog').scrollTop = 700; refused.state.sessions.push(S('d')); refused.run('renderStewardChooser()'); assert.equal(refused.$('steward-dialog').scrollTop, 700);
  // Made, but it ended, went to the background, or was archived meanwhile.
  for (const record of [{ state: 'ended' }, { state: 'error' }, { state: 'recoverable' }, { state: 'background' }, { archived: true }]) {
    const f = making({}, { record }); f.open(); await f.run('confirmSteward()');
    assert.deepEqual([f.shown.map(error => error.uiMessage.key), f.handoffs, f.state.steward.sessionId, f.$('steward-dialog').open], [['error.steward.newFailed'], [], 'butler', true], JSON.stringify(record));
    // It is not left chosen: one more click opens another and does not make the butler of the one that failed.
    assert.deepEqual([f.run('[stewardChoice, stewardMade]'), f.$('steward-confirm').textContent, f.$('steward-confirm').disabled], [['new', ''], zh('steward.new.confirm'), false], JSON.stringify(record));
  }
  const vanished = making({}, { ready: 99 }); vanished.open(); vanished.paused = () => { vanished.state.sessions = vanished.state.sessions.filter(s => s.id !== 'made'); }; await vanished.run('confirmSteward()');
  assert.deepEqual([vanished.shown.map(error => error.uiMessage.key), vanished.state.steward.sessionId], [['error.steward.newFailed'], 'butler']);
  // Not ready in time (signing in, trusting the folder, a native start screen): the butler stays, and the session is in the list.
  for (const record of [{ state: 'working' }, { state: 'idle', nativeId: null }, { state: 'idle', nativeStartupPrompt: true }, { state: 'idle', nativeContextPending: true }]) {
    const f = making({}, { record }); let now = 0; f.context.Date = class extends Date { static now() { return now += 1000; } };
    f.open(); await f.run('confirmSteward()');
    assert.deepEqual([f.shown.map(error => error.uiMessage.key), f.handoffs, f.state.steward.sessionId, f.$('steward-dialog').open, f.created.length], [['error.steward.newNotReady'], [], 'butler', true, 1], JSON.stringify(record));
    // It stays chosen, and cannot be made the butler before it is ready, whoever clicks.
    assert.deepEqual([f.run('stewardChoice'), f.$('steward-confirm').textContent, f.$('steward-confirm').disabled], ['made', zh('steward.choose.confirm'), true], JSON.stringify(record));
    await f.run('confirmSteward()'); assert.deepEqual([f.handoffs, f.created.length, f.state.steward.sessionId], [[], 1, 'butler'], JSON.stringify(record));
  }
  const off = making({}, { ready: 99 }); off.open(); off.paused = () => { off.context.disconnected = true; }; await off.run('confirmSteward()');
  assert.deepEqual([off.shown.map(error => error.uiMessage.key), off.state.steward.sessionId, off.$('steward-confirm').disabled], [['error.steward.newDisconnected'], 'butler', true]);

  // Ready later: the same session is chosen, with the handoff still in the box, and no second one is made.
  const late = making({}, { record: { state: 'working' } }); let clock = 0; late.context.Date = class extends Date { static now() { return clock += 1000; } };
  late.open(); await late.run('confirmSteward()');
  late.pick('a'); assert.deepEqual([late.$('steward-confirm').disabled, late.$('steward-confirm').textContent], [false, zh('steward.choose.confirm')], 'Another session can be chosen instead');
  late.pick('made'); assert.equal(late.$('steward-confirm').disabled, true); late.state.sessions.find(s => s.id === 'made').state = 'idle'; late.run('renderStewardChooser()'); assert.equal(late.$('steward-confirm').disabled, false);
  assert.deepEqual([late.run('stewardChoice'), late.$('steward-confirm').textContent, boxes(late)],
    ['made', zh('steward.choose.confirm'), { ...HIDDEN, 'steward-handoff': true, 'steward-handoff-label': true, 'steward-new-note': true }]);
  await late.run('confirmSteward()');
  assert.deepEqual([late.created.length, late.handoffs, late.state.steward.sessionId], [1, [zh('steward.new.handoffDefault', { name: '大管家 7' })], 'made']);

  // Designated, but nothing could be sent: the dialog stays, says why, and sends both again.
  const busy = { duty: { state: 'not-sent', error: { message: 'x', uiMessage: { key: 'error.steward.dutyBusy' } } } };
  const silent = making({ duty: busy }); silent.$('steward-dialog').scrollHeight = 700; silent.open(); await silent.run('confirmSteward()'); assert.equal(silent.$('steward-dialog').scrollTop, 700);
  assert.deepEqual([silent.$('steward-dialog').open, silent.$('steward-error').textContent, silent.state.steward.sessionId, silent.$('steward-confirm').textContent], [true, zh('steward.duty.notSent', { reason: zh('error.steward.dutyBusy') }), 'made', zh('steward.choose.resend')]);
  assert.deepEqual(boxes(silent), { ...HIDDEN, 'steward-handoff': true, 'steward-handoff-label': true }, 'the note is about a change that has been made');
  // A made session that is put into a space, or is the butler and has ended, is dropped as any other choice.
  const joined = making({}, { record: { state: 'working' } }); let tick = 0; joined.context.Date = class extends Date { static now() { return tick += 1000; } };
  joined.open(); await joined.run('confirmSteward()'); joined.state.sessions.find(s => s.id === 'made').roomIds = ['shared']; joined.run('renderStewardChooser()'); assert.equal(joined.run('stewardChoice'), '');
  const gone = making({ duty: { duty: { state: 'not-sent', error: { message: 'x', uiMessage: { key: 'error.steward.dutyBusy' } } } } }); gone.open(); await gone.run('confirmSteward()');
  gone.state.sessions.find(s => s.id === 'made').state = 'ended'; gone.run('renderStewardChooser()'); assert.deepEqual([gone.run('stewardChoice'), gone.$('steward-confirm').disabled], ['', true]);
  // It is the butler now: sent again also while it is in a turn, as to any butler.
  silent.state.sessions.find(s => s.id === 'made').state = 'working'; silent.run('renderStewardChooser()'); assert.equal(silent.$('steward-confirm').disabled, false);
  await silent.run('confirmSteward()'); assert.deepEqual([silent.created.length, silent.handoffs.length, silent.handoffs[1]], [1, 2, silent.handoffs[0]]);
  // Opened again for another change, what was made before is an ordinary row.
  silent.$('steward-dialog').close(); silent.run('openStewardChooser()'); assert.deepEqual(boxes(silent), HIDDEN);
});

test('each opening starts at the heading with the chosen row in sight, wherever the last one was scrolled', () => {
  const f = making(), tops = ['steward-dialog', 'steward-list', 'steward-duty', 'steward-handoff']; for (const id of tops) f.$(id).scrollTop = 120;
  f.run("openStewardChooser('a')"); assert.deepEqual(tops.map(id => f.$(id).scrollTop), [0, 0, 0, 0]);
  assert.deepEqual(f.$('steward-list').querySelectorAll('input').filter(input => input.shown).map(input => input.value), ['a']);
});

test('the person closing the dialog while a new session is being opened designates nobody', async () => {
  const f = making({}, { ready: 99 }); f.open(); let steps = 0;
  f.paused = () => { if (++steps === 2) f.$('steward-dialog').close(); };
  await f.run('confirmSteward()');
  assert.deepEqual([f.created.length, f.handoffs, f.state.steward.sessionId, f.selected, f.toasts], [1, [], 'butler', [], [zh('steward.new.closed')]]);
  // Closed before there is a session: none is made. Closed and opened again: the new dialog is not designated from the old click.
  const early = making({ sessions: [], steward: null }); let answer; early.context.api.createDefaults = () => new Promise(resolve => { answer = resolve; });
  early.open(); const waiting = early.run('confirmSteward()'); early.$('steward-dialog').close(); answer({ directory: '/synthetic/chosen' }); await waiting;
  assert.deepEqual([early.created, early.handoffs, early.toasts], [[], [], []]);
  const again = making({}, { ready: 99 }); again.open(); let reopened = false;
  again.paused = () => { if (reopened) return; reopened = true; again.$('steward-dialog').close(); again.run('openStewardChooser()'); again.pick('a'); };
  await again.run('confirmSteward()');
  assert.deepEqual([again.handoffs, again.state.steward.sessionId, again.toasts, again.$('steward-dialog').open, again.rows().find(row => row[0] === 'A')[3], again.$('steward-confirm').disabled], [[], 'butler', [zh('steward.new.closed')], true, true, false]);
  // The same while the session itself is still being made: the choice in the new dialog is the person's.
  const during = making(); during.open(); const create = during.context.api.create; let finish; during.context.api.create = value => new Promise(resolve => { finish = async () => resolve(await create(value)); });
  const clicked = during.run('confirmSteward()'); await new Promise(resolve => setImmediate(resolve)); during.$('steward-dialog').close(); during.run('openStewardChooser()'); during.pick('a'); await finish(); await clicked;
  assert.deepEqual([during.run('stewardChoice'), boxes(during), during.handoffs, during.state.steward.sessionId], ['a', HIDDEN, [], 'butler']);
  // While the designation itself is on its way the button stays off and the fields with it, also over a state update; a
  // second click designates nothing more. The same for a session chosen from the list.
  for (const chosen of ['new', 'a']) {
    const going = making(); going.open(chosen); const designate = going.context.api.steward; let arrive; going.context.api.steward = (...args) => new Promise(resolve => { arrive = () => resolve(designate(...args)); });
    going.$('steward-error').hidden = false; const first = going.run('confirmSteward()'); for (let i = 0; i < 20 && !arrive; i++) await new Promise(resolve => setImmediate(resolve));
    const FIELDS = ['steward-new-model', 'steward-new-effort', 'steward-new-skip', 'steward-handoff', 'steward-duty', 'steward-standing-keep'], off = () => FIELDS.map(id => going.$(id).disabled);
    going.run('renderStewardChooser()'); assert.equal(going.$('steward-error').hidden, true, 'an earlier reason is gone');
    assert.deepEqual([going.$('steward-confirm').disabled, going.$('steward-confirm').textContent, off().every(Boolean), going.rows().every(row => row[2])], [true, zh(chosen === 'new' ? 'steward.new.making' : 'steward.choose.confirm'), true, true], chosen);
    await going.run('confirmSteward()'); arrive(); await first; assert.deepEqual([going.handoffs.length, going.state.steward.sessionId], [1, chosen === 'new' ? 'made' : 'a']);
    going.run('openStewardChooser()'); assert.deepEqual([off().some(Boolean), going.$('steward-confirm').disabled], [false, false], 'nothing is left off');
  }
  // Closed while it is on its way, a new opening is the person's to use.
  const hung = making(); hung.open('a'); hung.context.api.steward = () => new Promise(() => {}); hung.run('confirmSteward()'); hung.$('steward-dialog').close(); hung.run('openStewardChooser()'); hung.pick('a');
  assert.equal(hung.$('steward-confirm').disabled, false);
  // A second click while one is being opened makes nothing more.
  const twice = making({}, { ready: 3 }); twice.open(); const one = twice.run('confirmSteward()'); await twice.run('confirmSteward()'); await one;
  assert.deepEqual([twice.created.length, twice.state.steward.sessionId], [1, 'made']);
});

test('with the permission to organize on, the line is there for the new session too and what the person left goes with it', async () => {
  const settle = () => new Promise(resolve => setImmediate(resolve)), standing = { on: true, limit: 30, unavailable: false };
  const f = making({ standing }); f.run('openStewardChooser()'); await settle(); f.pick('new'); assert.deepEqual([f.$('steward-standing').hidden, f.$('steward-standing-keep').checked], [false, true]);
  f.$('steward-standing-keep').checked = false; await f.run('confirmSteward()'); assert.deepEqual([f.standings, f.state.steward.sessionId], [[false], 'made']);
});

test('the new session\'s box is in the chooser: Claude only, Codex there with the reason it cannot be chosen, named fields, the handoff before the duty statement', () => {
  const dialog = html.match(/<dialog closedby="any" id="steward-dialog".*/)[0];
  assert.match(dialog, /<p id="steward-none"[^>]*><\/p><div id="steward-new" class="steward-new" hidden>/);
  assert.match(dialog, /<input type="radio" name="steward-new-provider" value="claude" checked> Claude<\/label><label><input type="radio" name="steward-new-provider" value="codex" disabled aria-describedby="steward-new-codex"> Codex<\/label><small id="steward-new-codex" data-naw-text="steward\.new\.codex"><\/small>/);
  for (const id of ['steward-new-model', 'steward-new-effort', 'steward-handoff']) assert.match(dialog, new RegExp(`<label[^>]* for="${id}"`), id);
  assert.match(dialog, /<input id="steward-new-skip" type="checkbox" aria-describedby="steward-new-permission"><span data-naw-text="create\.skipPermissions"><\/span><\/label><small id="steward-new-permission" data-naw-text="create\.permissionsSkipped" hidden>/);
  assert.equal(dialog.includes('id="steward-new-skip" type="checkbox" checked'), false);
  assert.ok(dialog.indexOf('id="steward-handoff"') < dialog.indexOf('id="steward-duty"'));
  assert.deepEqual([...dialog.matchAll(/<select id="steward-new-effort">(.*?)<\/select>/g)][0][1].match(/value="([^"]*)"/g).map(v => v.slice(7, -1)), ['low', 'medium', 'high', 'xhigh', 'max', '']);
  assert.match(locale.format('zh', 'steward.new.codex'), /还不能选/); assert.match(locale.format('zh', 'steward.new.note'), /变回普通会话。.*自动叫醒先关着/);
});

// R220: the permission to organize goes with the new butler, in the same confirmation.
test('choosing another butler shows one line for the permission that is on, checked, and sends what the person left', async () => {
  const sessions = [S('butler'), S('a'), S('b')], steward = { sessionId: 'butler', nativeId: 'native-butler' }, settle = () => new Promise(resolve => setImmediate(resolve));
  const open = async (standing, chosen) => { const f = fixture({ sessions, steward: { ...steward }, standing }); f.run('openStewardChooser()'); f.before = f.$('steward-confirm').disabled; await settle(); if (chosen) f.pick(chosen); return f; };
  const line = f => [f.$('steward-standing').hidden, f.$('steward-standing-keep').checked];
  const on = { on: true, limit: 30, unavailable: false };
  const f = await open(on);
  assert.equal(f.before, true, 'not confirmed before it is known whether to ask');
  assert.deepEqual([line(f), f.$('steward-confirm').disabled], [[true, true], false], 'the same butler: nothing to ask');
  f.pick('a'); assert.deepEqual(line(f), [false, true]);
  f.pick('butler'); assert.equal(f.$('steward-standing').hidden, true); f.pick('b'); assert.equal(f.$('steward-standing').hidden, false);
  await f.run('confirmSteward()'); assert.deepEqual([f.calls, f.standings], [['b', 'state'], [true]]);
  // Opened again, it is checked again.
  const un = await open(on, 'a'); un.$('steward-standing-keep').checked = false; un.run('renderStewardChooser()'); assert.deepEqual(line(un), [false, false], 'a state update does not check it again');
  await un.run('confirmSteward()'); assert.deepEqual(un.standings, [false]);
  un.run('openStewardChooser()'); assert.equal(un.$('steward-standing-keep').checked, true);
  // The same butler again: not asked.
  const same = await open(on, 'butler'); await same.run('confirmSteward()'); assert.deepEqual(same.standings, [null]);
  // Off, off for this butler, unreadable, or a window without the call: no line, and nothing is sent.
  for (const value of [{ on: false, limit: 30, unavailable: false }, { on: false, limit: 30, unavailable: false, reason: 'other-designation' }, { on: false, limit: 30, unavailable: true }, Error('synthetic'), undefined]) {
    const g = await open(value, 'a'); assert.deepEqual([line(g)[0], g.$('steward-confirm').disabled], [true, false]);
    await g.run('confirmSteward()'); assert.deepEqual(g.standings, [null]);
  }
  // Nobody chosen yet: nothing to ask.
  const none = fixture({ sessions: [S('a')], steward: { ...steward }, standing: on }); none.run('openStewardChooser()'); await settle();
  assert.equal(none.$('steward-standing').hidden, true); none.pick('a'); assert.equal(none.$('steward-standing').hidden, false);
  // Before it is read, a click that got through does nothing.
  const early = fixture({ sessions, steward: { ...steward }, standing: on }); early.run('openStewardChooser()'); early.pick('a'); await early.run('confirmSteward()'); assert.deepEqual(early.calls, []);
  // An answer for a dialog that was closed and opened again is not used for the new one.
  let answer; const late = fixture({ sessions, steward: { ...steward }, standing: on }); late.context.api.stewardStanding = () => new Promise(resolve => { answer ??= resolve; });
  late.run('openStewardChooser()'); late.$('steward-dialog').close(); late.run('openStewardChooser()'); late.pick('a'); answer(on); await settle();
  assert.deepEqual([late.$('steward-standing').hidden, late.$('steward-confirm').disabled], [true, true]);
  // Not saved: said, and the new butler is shown.
  const lost = await open(on, 'a'); const send = lost.context.api.steward; lost.context.api.steward = async (...args) => ({ ...await send(...args), standingLost: true });
  await lost.run('confirmSteward()'); assert.deepEqual([lost.toasts, lost.selected], [[zh('standing.notKept')], ['a']]);
  // Taken back and not saved: what that leaves is said, not that it can be turned on.
  const left = await open(on, 'a'); const leave = left.context.api.steward; left.context.api.steward = async (...args) => ({ ...await leave(...args), standingLost: true });
  left.$('steward-standing-keep').checked = false; await left.run('confirmSteward()'); assert.deepEqual(left.toasts, [zh('standing.notOff')]);
  // With the duty statement not sent too: both in the dialog that stays, or both in the toast of one dismissed meanwhile.
  const notSent = { duty: { state: 'not-sent', error: { message: 'x', uiMessage: { key: 'error.steward.dutyBusy' } } }, standingLost: true };
  const both = zh('steward.duty.notSent', { reason: zh('error.steward.dutyBusy') }) + ' ' + zh('standing.notKept');
  const stays = fixture({ sessions, steward: { ...steward }, standing: on, duty: notSent }); stays.run('openStewardChooser()'); await settle(); stays.pick('a'); await stays.run('confirmSteward()');
  assert.deepEqual([stays.$('steward-error').textContent, stays.toasts], [both, []]);
  stays.pick('b'); assert.equal(stays.$('steward-standing').hidden, true, 'the new butler does not have it: nothing to ask');
  const gone = fixture({ sessions, steward: { ...steward }, standing: on, duty: notSent }); gone.run('openStewardChooser()'); await settle(); gone.pick('a');
  const sending = gone.run('confirmSteward()'); gone.$('steward-dialog').close(); await sending; assert.deepEqual(gone.toasts, [both]);
  // The butler's session in another native conversation is not the same butler: asked.
  const moved = fixture({ sessions: [S('butler', { nativeId: 'native-after-clear' }), S('a')], steward: { ...steward }, standing: on }); moved.run('openStewardChooser()'); await settle();
  assert.deepEqual([line(moved), moved.$('steward-confirm').textContent], [[false, true], zh('steward.choose.resend')]); await moved.run('confirmSteward()'); assert.deepEqual(moved.standings, [true]);
  // Taken back, then the duty statement did not go in: the dialog that stays open does not ask again.
  const back = fixture({ sessions, steward: { ...steward }, standing: on, duty: { duty: { state: 'not-sent', error: { message: 'x', uiMessage: { key: 'error.steward.dutyBusy' } } } } });
  back.run('openStewardChooser()'); await settle(); back.pick('a'); back.$('steward-standing-keep').checked = false; await back.run('confirmSteward()'); back.pick('b');
  assert.equal(back.$('steward-standing').hidden, true);
  assert.match(html, /<\/textarea><label id="steward-standing" class="steward-standing" hidden><input id="steward-standing-keep" type="checkbox"><span data-naw-text="standing\.keep"><\/span><\/label><p id="steward-new-note" class="quiet" data-naw-text="steward\.new\.note" hidden><\/p><p id="steward-error"/);
  for (const language of ['zh', 'en']) for (const key of ['standing.keep', 'standing.notKept', 'standing.notOff']) assert.notEqual(locale.format(language, key), key);
  assert.equal(locale.format('zh', 'standing.keep'), '也允许新大管家直接整理本机工作');
});

test('the page has the entry above everything else, the mark before the title and the chooser among the dialogs; the window wires them', () => {
  // Under the brand, before the built-in entry and every navigation/create control.
  const entryOrder = require('./fixtures/sidebar-entry-order.cjs');
  entryOrder(html);
  const entry = html.match(/    <div id="steward-entry"[^\n]*\n/)[0];
  const displaced = html.replace(entry, '').replace('    <button class="new-button"', entry + '    <button class="new-button"');
  assert.throws(() => entryOrder(displaced), /Butler entries stay above/, 'Moving the designated entry below the rail must still fail');
  assert.match(html, /<\/div>\n    <div id="steward-entry" class="steward-entry"><button id="steward-empty" class="butler-row steward-empty" type="button" aria-haspopup="dialog" data-butler-state="empty"[^>]* hidden>.*<\/button><div id="steward-slot" class="steward-slot"><\/div><\/div>\n    <button id="butler-row" class="butler-row" type="button" aria-haspopup="dialog" hidden><\/button>/);
  assert.ok(html.includes('data-naw-aria-label="steward.emptyLabel"') && html.includes('<span class="rail-label" data-naw-text="butler.name"></span><span class="butler-state"><span data-naw-text="butler.row.empty"></span></span>'));
  assert.ok(html.includes('<span id="steward-badge" class="steward-badge" hidden></span><h1 id="title"'));
  assert.match(html, /<dialog closedby="any" id="steward-dialog" class="butler-dialog steward-dialog" aria-labelledby="steward-dialog-title">.*<div id="steward-list" class="steward-list" role="radiogroup"[^>]*><\/div>.*<p id="steward-error" role="alert" hidden><\/p>.*<button id="steward-confirm" type="button" class="primary" data-naw-text="steward.choose.confirm"><\/button><\/div><\/dialog>\n  <dialog closedby="any" id="butler-dialog"/);
  // The row is the same row any session has, in the entry's place; it is not dragged and not reordered.
  assert.ok(renderer.includes("if (butler) { const key = `steward:${butler.id}`; occurrences.unshift({ record: butler, key, group: null, container: $('steward-slot'), steward: true }); keys.add(key); }"));
  assert.ok(renderer.includes("if (steward) element.classList.add('steward-row'); else { draggableSession(link, record.id, true, group || ''); sidebarDropRow(element, record.id, group); }"));
  assert.ok(renderer.includes("if (steward) { ui.display.text(row.name, 'butler.name'); if (row.shortId.textContent !== '') row.shortId.textContent = ''; ui.display.computed(row.status, 'text', () => uiText('steward.rowStatus', { name: record.name, status: sidebarPresentation(record).compact })); }"));
  assert.ok(renderer.includes("...(index >= 0 && index < visible.length - 1 ? [{ id: 'down'"), 'A row that is not in the list is not offered "move down"');
  assert.ok(renderer.includes("const roomItems = isSteward && !window.nativeWorkspaceSpaces.roomIds(record).length ? [] :"));
  // Both menus offer the same items and carry them out the same way; the butler's header has no "join".
  assert.ok(renderer.includes("const actions = [...update, ...modelAction(record), ...((record.rotationEpisode && !window.nativeWorkspaceSpaces.roomIds(record).length) ? rotationReleaseAction(record) : []), ...stewardAction(record), ...managerAction(record), ...integratorAction(record), "));
  assert.ok(renderer.includes("if (!terminal) actions.push(...stewardAction(current()).map(item => ({ ...item, role: true })));"));
  assert.ok(renderer.includes("else if (action === 'steward-set') openStewardChooser(id);\n      else if (action === 'steward-revoke') attempt(() => revokeSteward(id));"));
  assert.ok(renderer.includes("else if (action === 'steward-set') openStewardChooser(current().id);\n      else if (action === 'steward-revoke') { if (!disconnected) attempt(() => revokeSteward(current().id)); }"));
  assert.equal(renderer.match(/action === 'steward-change'\) openStewardChooser\(\);/g).length, 2);
  // The duty statement sits in the chooser, named for assistive technology by its label.
  assert.ok(html.includes('<label id="steward-duty-label" class="steward-duty" for="steward-duty" data-naw-text="steward.duty.label"></label><textarea id="steward-duty" class="steward-duty" rows="7" spellcheck="false"></textarea><label id="steward-standing" '));
  assert.ok(renderer.includes("if (isButler && !inSpace(s)) h.membership.hidden = true;") && renderer.includes("&& !(item.id === 'membership' && item.control.hidden));"));
  assert.ok(renderer.includes("state.spaceManagers, state.integrator, state.steward, disconnected]);"), 'An open header menu closes when the designation moves');
  // The first window of a start lands on the butler; any other window is where it was.
  assert.ok(renderer.includes("const landing = typeof api.landing === 'function' && await api.landing() ? stewardRecord() : null;\n  await select(landing ? landing.id : state.viewState.selected || '', mode); await api.uiReady();"));
  assert.ok(renderer.includes("$('steward-empty').onclick = () => openStewardChooser();") && renderer.includes("$('steward-confirm').onclick = () => attempt(confirmSteward);"));
  // Its look: the butler's row is marked, and the chooser's rows are one line each whatever the page says of labels.
  for (const rule of ['.steward-row .agent-icon{background:var(--ink);color:var(--surface,#fff)}', '.steward-slot:empty{display:none}', 'dialog.steward-dialog label.steward-pick{display:grid;']) assert.ok(css.includes(rule), rule);
});
