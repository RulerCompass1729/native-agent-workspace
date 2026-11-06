// Exercise the real reader with the existing DOM model and a controlled clock.
// No provider, browser, native input, clipboard or workspace transport runs.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const locale = require('../ui-locale.js');
const helperFile = path.join(__dirname, 'reading-locale.test.cjs');
let helpers = fs.readFileSync(helperFile, 'utf8').split("test('typed own notices")[0];
assert.ok(helpers.includes('function fixture('));
if (process.env.NAW_READING_SOURCE) {
  const original = "const source = fs.readFileSync(path.join(__dirname, '../renderer/reading-list.js'), 'utf8');";
  assert.ok(helpers.includes(original));
  helpers = helpers.replace(original, `const source = fs.readFileSync(${JSON.stringify(path.resolve(process.env.NAW_READING_SOURCE))}, 'utf8');`);
}
helpers = helpers.replace('scheduleReading = () => {}; updateJump = () => {};', 'globalThis.originalScheduleReading = scheduleReading; scheduleReading = () => {}; updateJump = () => {};');
const shared = vm.createContext({ require: createRequire(helperFile), __dirname, console });
vm.runInContext(helpers + '\nglobalThis.makeFixture = fixture;', shared);
vm.runInContext(`
Element.prototype.addEventListener = function(type, listener) { (this.listeners ||= {})[type] = listener; };
Element.prototype.removeEventListener = function(type) { if (this.listeners) delete this.listeners[type]; };
Object.defineProperty(Element.prototype, 'open', {
  get() { return Boolean(this._open); },
  set(value) { if (Boolean(value) !== Boolean(this._open)) { this._open = Boolean(value); this.pendingToggle = true; } }
});`, shared);
const body = 'EXACT BODY {status} <native> & original';
function notice(status = 'staged', extra = {}) {
  return { id: 'wake-1', role: 'system', kind: 'notice', origin: 'agent-wake-intent', name: 'Automatic message', status: 'complete', time: 1000,
    ...locale.createNotice('notice.wake.registered', { name: 'Mira', body }),
    wake: { id: 'wake-1', nativeId: 'native-A', turnId: 'turn-A', callId: 'call-A', senderId: 'session-A', senderName: 'Jun', recipientId: 'recipient-B', body, time: 1000, status }, ...extra };
}
function fixture(row = notice(), room = false) {
  const rows = [row], f = shared.makeFixture(rows, room, {}, { readingState: () => Promise.resolve() });
  f.context.attempt = fn => fn();
  Object.assign(f.root, { clientWidth: 800, clientHeight: 500, scrollHeight: 1000, scrollTop: 120,
    getClientRects: () => [{}], getBoundingClientRect: () => ({ top: 0, bottom: 500 }) });
  let now = 0, serial = 0;
  const timers = new Map();
  f.context.setTimeout = (callback, ms) => { const id = ++serial; timers.set(id, { callback, due: now + ms }); return id; };
  f.context.clearTimeout = id => timers.delete(id);
  f.context.performance = { now: () => now };
  f.state.sessions.push({ id: 'recipient-B', name: 'Mira', nativeId: 'native-B' });
  const descendants = el => [el, ...el.childNodes.flatMap(descendants)];
  f.flushToggles = () => { for (const el of descendants(f.root)) if (el.pendingToggle) { el.pendingToggle = false; el.listeners?.toggle?.({ target: el }); } };
  f.entry = () => f.view.entries.get(row.id);
  f.redraw = () => { f.context.messageList(f.root, rows, room, room ? 'room' : 'session-A'); f.flushToggles(); };
  f.update = status => {
    row.wake.status = status;
    // The real complete callback updates BOTH descriptor and raw text as well.
    if (['submitted', 'unconfirmed'].includes(status)) Object.assign(row, locale.createNotice('notice.wake.' + status, { body: row.wake.body }));
    f.redraw();
  };
  f.advance = ms => { now += ms; for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.callback(); } f.flushToggles(); };
  f.saved = () => JSON.parse(vm.runInContext('JSON.stringify(readingPositions)', f.context))['session-A'];
  f.latest = () => { f.context.changeReadingPage(f.view, 'latest'); f.root.scrollTop = 500; f.view.assignedTop = 500; };
  f.manual = open => {
    const entry = f.entry(); assert.ok(entry.disclosure);
    const summary = entry.disclosure.childNodes.find(el => el.tagName === 'summary');
    assert.notEqual(entry.disclosure.open, open);
    summary.listeners.click({ target: summary, preventDefault() {} }); f.flushToggles();
    assert.equal(entry.disclosure.open, open);
  };
  const search = fs.readFileSync(path.join(__dirname, '../renderer/search-view.js'), 'utf8');
  const pointStart = search.indexOf('function pointToMessage('), pointEnd = search.indexOf('\nasync function openSearchResult(', pointStart);
  assert.ok(pointStart >= 0 && pointEnd > pointStart);
  vm.runInContext(search.slice(pointStart, pointEnd), f.context);
  f.document.querySelectorAll = selector => { assert.equal(selector, '[data-search-target]'); return descendants(f.root).filter(el => el.dataset.searchTarget !== undefined); };
  f.entry().item.focus = () => { f.document.activeElement = f.entry().item; };
  f.rows = rows; f.row = row; f.timers = timers; f.redraw(); return f;
}

test('sender notice uses wake state, exact recipient and original body, not its complete row status', () => {
  const f = fixture(), entry = f.entry(), original = JSON.stringify(f.row), drafts = JSON.stringify(f.state.viewState);
  assert.ok(entry.disclosure, 'the original sender record has a disclosure');
  assert.equal(entry.disclosure.open, true);
  assert.equal(entry.body.textContent, body);
  assert.equal(entry.preview.textContent, '', 'the compact heading does not repeat a receipt sentence');
  assert.match(entry.heading.textContent, /Jun.*Mira.*recipient-B/);
  assert.match(entry.heading.textContent, /\u5df2\u767b\u8bb0/);
  assert.ok(!entry.heading.textContent.includes('\u539f\u751f\u5df2\u63a5\u6536'));
  f.switch('en'); assert.match(entry.heading.textContent, /Registered.*not yet delivered/i);
  assert.equal(entry.body.textContent, body); assert.equal(JSON.stringify(f.row), original);
  assert.equal(JSON.stringify(f.state.viewState), drafts); assert.equal(f.calls.length, 0);
});

test('only observed submitted transition collapses after readable exposure and preserves Latest through layout scroll', () => {
  const f = fixture(); assert.ok(f.entry().disclosure);
  f.update('sending'); f.update('consumed'); f.advance(10000); assert.equal(f.entry().disclosure.open, true);
  f.update('submitted'); assert.equal(f.entry().disclosure.open, true); assert.equal(f.timers.size, 1);
  f.latest(); const intent = f.view.intent, saved = JSON.stringify(f.saved());
  f.advance(2499); assert.equal(f.entry().disclosure.open, true);
  f.advance(1); assert.equal(f.entry().disclosure.open, false);
  assert.equal(f.view.intent, intent); assert.equal(JSON.stringify(f.saved()), saved);
  f.root.scrollTop = 0; f.root.listeners.scroll();
  assert.equal(f.view.intent, intent); assert.equal(f.saved().follow, true);
  f.redraw(); assert.equal(f.entry().disclosure.open, false); assert.equal(f.timers.size, 0);
  assert.equal(f.calls.length, 0);
});

test('old submitted history is compact immediately and does not replay a timer on reload', () => {
  const f = fixture(notice('submitted')); assert.ok(f.entry().disclosure);
  assert.equal(f.entry().disclosure.open, false); assert.equal(f.timers.size, 0);
  f.redraw(); f.advance(10000); assert.equal(f.entry().disclosure.open, false);
  assert.equal(f.timers.size, 0);
});

test('unconfirmed, cancelled and future states keep their original reason and never auto-collapse', () => {
  for (const status of ['unconfirmed', 'cancelled', 'future-state', 'toString', '__proto__', null, { toString: null }, undefined]) {
    const raw = 'EXACT CAUSE\n' + body, row = notice(status, { text: raw, uiMessage: undefined });
    if (status === undefined) delete row.wake.status;
    const f = fixture(row);
    assert.ok(f.entry().disclosure); assert.equal(f.entry().disclosure.open, true);
    assert.equal(f.entry().body.textContent, raw); f.advance(10000);
    assert.equal(f.entry().disclosure.open, true); assert.equal(f.timers.size, 0);
  }
});

test('manual choice, focus, selection and search reveal all defeat a later automatic collapse', () => {
  for (const guard of ['manual', 'focus', 'selection', 'search']) {
    const f = fixture(); assert.ok(f.entry().disclosure); f.update('submitted');
    if (guard === 'manual') { f.manual(false); f.manual(true); }
    if (guard === 'focus') f.document.activeElement = f.entry().body;
    if (guard === 'selection') Object.assign(f.context.window.getSelection(), { isCollapsed: false, anchorNode: f.entry().body, focusNode: f.entry().body });
    if (guard === 'search') assert.equal(f.context.pointToMessage(f.root, 'session-A', f.row.id, 'EXACT'), true);
    f.advance(3000); assert.equal(f.entry().disclosure.open, true, guard);
    f.redraw(); assert.equal(f.entry().disclosure.open, true, guard + ' rerender');
  }
});

test('newer status, view disposal, session change and removed rows cancel their owned timer', () => {
  for (const change of ['status', 'dispose', 'session', 'remove']) {
    const f = fixture(); assert.ok(f.entry().disclosure); f.update('submitted'); assert.equal(f.timers.size, 1);
    if (change === 'status') f.update('unconfirmed');
    if (change === 'dispose') f.view.dispose();
    if (change === 'session') f.context.messageList(f.root, [], false, 'other-session');
    if (change === 'remove') { f.rows.length = 0; f.redraw(); }
    assert.equal(f.timers.size, 0, change); f.advance(10000); assert.equal(f.calls.length, 0);
  }
});

test('room mirrors and mismatched native or sender identities retain the original notice behavior', () => {
  for (const [room, field, value] of [[true], [false, 'senderId', 'other'], [false, 'nativeId', 'other'], [false, 'id', 'other']]) {
    const row = notice(); if (field) row.wake[field] = value;
    const f = fixture(row, room); assert.equal(f.entry().item.childNodes.some(el => el.tagName === 'details' && el.className === 'process-details'), false);
    assert.equal(f.timers.size, 0); assert.equal(f.calls.length, 0);
  }
});

test('missing native identity is not proof even when both nullable fields match', () => {
  const row = notice(); row.wake.nativeId = null; const f = fixture(row);
  f.state.sessions[0].nativeId = null; f.redraw();
  assert.equal(f.entry().body.textContent, row.text); assert.equal(f.timers.size, 0);
});

test('the original source-copy payload survives compact display and status changes', async () => {
  const f = fixture(), entry = f.entry(), original = f.row.text; assert.ok(entry.disclosure);
  const copying = entry.copyText.onclick(); assert.equal(f.copies[0], original);
  f.update('submitted'); f.advance(3000); f.acceptCopy(); await copying;
  assert.equal(f.row.wake.body, body); assert.equal(f.row.text, locale.createNotice('notice.wake.submitted', { body }).text);
  assert.equal(f.copies[0], original); assert.equal(f.calls.length, 0);
});

test('automatic layout after a settled reader schedules and completes the real restore frame', () => {
  const f = fixture(); f.update('submitted'); f.view.intent = null; f.root.scrollTop = 500;
  const frames = new Map(); let serial = 0;
  f.context.requestAnimationFrame = callback => { const id = ++serial; frames.set(id, callback); return id; };
  f.context.cancelAnimationFrame = id => frames.delete(id);
  f.context.scheduleReading = f.context.originalScheduleReading;
  f.advance(2500);
  assert.equal(frames.size, 1, 'a real layout restoration frame exists even after the previous intent settled');
  for (const [id, callback] of frames) { frames.delete(id); callback(); }
  assert.equal(f.view.pageChanging, false); assert.equal(f.view.intent.position.follow, true);
  assert.equal(f.saved().follow, true); assert.equal(f.calls.length, 0);
});

test('an explicit search reveals a previously closed received record without rewriting the manual choice', () => {
  const f = fixture(notice('submitted')); assert.equal(f.entry().disclosure.open, false);
  f.manual(true); f.manual(false);
  assert.equal(f.context.pointToMessage(f.root, 'session-A', f.row.id, 'EXACT'), true); f.redraw();
  assert.equal(f.entry().disclosure.open, true); assert.equal(f.saved().folds[f.row.id], false);
  f.manual(false); f.redraw(); assert.equal(f.entry().disclosure.open, false);
});

test('losing the sender/native proof restores the original plain notice and cancels its pending timer', () => {
  const f = fixture(), bodyNode = f.entry().body; f.update('submitted');
  assert.equal(f.timers.size, 1); f.row.wake.nativeId = 'different-native'; f.redraw();
  assert.equal(f.timers.size, 0); assert.equal(f.entry().item.childNodes.some(el => el.tagName === 'details' && el.className === 'process-details'), false);
  assert.equal(f.entry().body, bodyNode); assert.equal(f.entry().body.textContent, f.row.text);
});

test('a stale cancelled callback cannot consume the newer status presentation timer', () => {
  const f = fixture(); f.update('submitted'); const old = [...f.timers.values()][0].callback;
  f.update('unconfirmed'); f.update('submitted'); const current = f.entry().wakeTimer;
  old();
  assert.equal(f.entry().disclosure.open, true); assert.equal(f.entry().wakeTimer, current); assert.equal(f.timers.size, 1);
  f.advance(2500); assert.equal(f.entry().disclosure.open, false); assert.equal(f.timers.size, 0);
});

test('a status update keeps the focused copy control attached to the same heading', () => {
  const f = fixture(), entry = f.entry();
  assert.equal(entry.actions.parentElement, entry.heading);
  f.document.activeElement = entry.copyText; let replacements = 0;
  const replace = entry.heading.replaceChildren.bind(entry.heading);
  entry.heading.replaceChildren = (...nodes) => { replacements++; replace(...nodes); };
  f.update('submitted');
  assert.equal(replacements, 0); assert.equal(entry.actions.parentElement, entry.heading);
  assert.equal(f.document.activeElement, entry.copyText); assert.equal(f.timers.size, 0);
});

test('actual received descriptor updates keep the identical body node and its text children untouched', () => {
  const f = fixture(), entry = f.entry(), originalBody = entry.body, writes = entry.body.textWrites;
  f.context.window.getSelection().isCollapsed = false;
  f.context.window.getSelection().anchorNode = entry.body; f.context.window.getSelection().focusNode = entry.body;
  f.update('submitted');
  assert.equal(entry.body, originalBody); assert.equal(entry.body.textContent, body);
  assert.equal(entry.body.textWrites, writes, 'same body must not replace selected native text nodes when only notice metadata changes');
  f.switch('en'); assert.equal(entry.body.textWrites, writes); assert.equal(entry.body.textContent, body);
  assert.equal(f.calls.length, 0);
});
