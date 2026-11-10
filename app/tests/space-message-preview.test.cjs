const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const locale = require('../ui-locale.js'), localeUI = require('./fixtures/locale-ui.cjs');
const source = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
const reading = fs.readFileSync(require.resolve('../renderer/reading-list.js'), 'utf8');
function take(text, start, end) {
  const a = text.indexOf(start), b = text.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start); return text.slice(a, b);
}
const code = take(source, 'function participantLabel(', 'function timeline()') +
  take(source, 'function timelineParticipants(', 'function filteredTimeline()') +
  take(reading, 'function readingDeliveryStatusKey(', '// A sender') +
  take(reading, 'function readingWakeStatus(', 'function cancelReadingWakeCollapse(') +
  take(source, 'let spaceMessagePreview;', 'function renderHeader(');
const sender = { id: 'sender-a', nativeId: 'native-a', provider: 'codex', name: 'Jun' };
const recipient = { id: 'receiver-b', nativeId: 'native-b', provider: 'claude', name: 'Mira' };
function wake(id, time, status = 'staged') {
  return { id, time, role: 'system', text: 'Registered, not delivered.\n  ORIGINAL <body> 中文\n \t', wakeStatus: status,
    wake: { senderId: sender.id, recipientId: recipient.id, senderName: 'Old Jun', recipientName: 'Old Mira', body: '  ORIGINAL <body> 中文\n \t' } };
}
function fixture(rooms, language = 'en') {
  const document = { activeElement: null, body: null }, bindings = localeUI(language);
  class Element {
    constructor(tag, text = '', cls = '') { this.tag = tag; this.content = text; this.className = cls; this.children = []; this.attrs = new Map(); this.events = new Map(); this.writes = 0; }
    get childElementCount() { return this.children.length; }
    get textContent() { return this.content; }
    set textContent(value) { this.content = value; this.writes++; }
    setAttribute(k, v) { this.attrs.set(k, String(v)); }
    getAttribute(k) { return this.attrs.get(k) ?? null; }
    removeAttribute(k) { this.attrs.delete(k); }
    addEventListener(k, fn) { this.events.set(k, fn); }
    append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
    insertBefore(node, next) { node.remove(); const i = next ? this.children.indexOf(next) : this.children.length; this.children.splice(i, 0, node); node.parent = this; }
    replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
    remove() { if (this.parent) { const p = this.parent; p.children.splice(p.children.indexOf(this), 1); this.parent = null; } }
    focus() { document.activeElement = this; }
    matches() { return Boolean(this.popoverOpen); }
    hidePopover() { this.popoverOpen = false; this.events.get('toggle')?.(); }
    togglePopover() { this.popoverOpen = !this.popoverOpen; this.events.get('toggle')?.(); }
    click() { this.events.get('click')?.(); }
  }
  document.body = new Element('body');
  const node = (tag, text, cls) => new Element(tag, text, cls);
  const uiNode = (tag, key, params, cls) => { const el = node(tag, '', cls); bindings.ui.display.text(el, key, params); return el; };
  const uiButton = (key, fn) => { const el = uiNode('button', key); el.addEventListener('click', fn); return el; };
  const state = { rooms, sessions: [sender, recipient] };
  // Any call to a native/input API or navigation/persistence helper is a failure.
  const forbidden = () => { throw new Error('Preview must not send, navigate, or persist drafts/reading state'); };
  const context = vm.createContext({ state, document, node, uiNode, uiButton, ...bindings,
    selected: sender.id, roomSurface: 'overview', mode: 'chat', roomViews: Object.freeze({ draft: 'SPACE DRAFT' }),
    readingPositions: Object.freeze({ anchor: 'ORIGINAL ANCHOR' }), privateDraft: 'PRIVATE DRAFT',
    api: new Proxy({}, { get: () => forbidden }), persistView: forbidden, render: forbidden, captureReadingViews: forbidden,
    current: () => state.sessions[0], members: () => state.sessions, storedSpaces: () => state.rooms,
    sessionShortId: id => id.slice(0, 6), spaceName: room => room.name });
  vm.runInContext(code, context);
  const view = vm.runInContext('spaceMessagePreview = createSpaceMessagePreview()', context);
  return { context, view, state, document, Element, bindings, rows: id => context.spaceMessagePreviewRows(id),
    update: (record = state.sessions[0], force = false) => context.renderSpaceMessagePreview(record, force) };
}
test('only existing shared communication involving this exact agent is selected, across spaces/providers', () => {
  const first = wake('first', 1), second = wake('second', 2);
  const unrelated = wake('other', 99); unrelated.wake = { senderId: 'elsewhere', recipientId: 'another' };
  const privateRow = { id: 'private', sessionId: sender.id, role: 'assistant', text: 'PRIVATE' };
  const f = fixture([{ id: 'a', name: 'A', messages: [first, unrelated, privateRow] }, { id: 'b', name: 'B', messages: [second] },
    { id: 'unavailable', unavailable: true, messages: [wake('unavailable', 100)] }]);
  const before = JSON.stringify(f.state);
  assert.deepEqual(Array.from(f.rows(sender.id), r => r.message.id), ['second', 'first']);
  assert.deepEqual(Array.from(f.rows(recipient.id), r => r.message.id), ['second', 'first']);
  assert.equal(f.rows('new-agent').length, 0); assert.equal(f.rows('').length, 0);
  assert.equal(JSON.stringify(f.state), before);
});
test('a native control outbox record retains its real sender and recipient, without a selected-page identity guess', () => {
  const message = { id: 'outbox', role: 'human', text: 'EXACT', recipientId: recipient.id,
    agentControl: { ...sender }, deliveries: [{ recipientId: recipient.id, status: 'submitted' }] };
  const f = fixture([{ id: 'a', name: 'A', messages: [message] }]);
  assert.equal(f.rows(sender.id).length, 1); assert.equal(f.rows(recipient.id).length, 1);
  assert.equal(f.context.roomMessageLabel(message), 'Jun → Mira');
  assert.equal(f.context.spaceMessagePreviewStatus(message), locale.format('en', 'delivery.submitted'));
});
for (const language of ['en', 'zh']) test(language + ': delivery uses only authoritative status; complete is not delivered/read/resumed', () => {
  const f = fixture([], language);
  for (const [status, key] of Object.entries({ staged: 'reading.wakeRegistered', sending: 'delivery.awaiting', submitted: 'delivery.submitted', cancelled: 'delivery.notSent', unconfirmed: 'delivery.unconfirmed', unknown: 'delivery.unknown' }))
    assert.equal(f.context.spaceMessagePreviewStatus(wake('x', 1, status)), locale.format(language, key));
  const missing = wake('missing', 1); delete missing.wakeStatus; missing.status = 'complete';
  assert.equal(f.context.spaceMessagePreviewStatus(missing), locale.format(language, 'delivery.unknown'));
  assert.equal(f.context.spaceMessagePreviewStatus({ peerMessage: {}, text: 'received' }), locale.format(language, 'spacePreview.recorded'));
  const control = { recipientId: recipient.id, agentControl: { ...sender }, deliveries: [
    { recipientId: 'another-recipient', status: 'submitted' }, { recipientId: recipient.id, status: 'unconfirmed' },
  ] };
  assert.equal(f.context.spaceMessagePreviewStatus(control), locale.format(language, 'delivery.unconfirmed'));
  control.deliveries.pop();
  assert.equal(f.context.spaceMessagePreviewStatus(control), locale.format(language, 'delivery.unknown'));
});
test('preview opening, stream refresh, folding and Escape preserve page, exact text, drafts and reading state', () => {
  const message = wake('first', 1), f = fixture([{ id: 'a', name: 'A', messages: [message] }]);
  f.update(); f.view.trigger.click();
  assert.equal(f.view.panel.matches(':popover-open'), true);
  assert.equal(f.view.trigger.getAttribute('aria-expanded'), 'true');
  const entry = [...f.view.rows.values()][0], body = entry.body;
  assert.ok(body.textContent.includes(message.wake.body)); assert.equal(entry.who.textContent, 'Jun → Mira');
  entry.item.open = false; const writes = body.writes;
  message.wakeStatus = 'unconfirmed'; message.text = 'EXACT original refusal reason.\n' + message.wake.body; f.update();
  assert.equal([...f.view.rows.values()][0].body, body); assert.equal(body.writes, writes);
  assert.equal(body.textContent, message.wake.body); assert.equal(entry.notice.textContent, 'EXACT original refusal reason.\n');
  assert.equal(entry.item.open, false); assert.equal(entry.status.textContent, locale.format('en', 'delivery.unconfirmed'));
  const event = { key: 'Escape', preventDefault() { this.prevented = true; }, stopPropagation() {} };
  f.view.panel.events.get('keydown')(event);
  assert.ok(event.prevented); assert.equal(f.view.panel.matches(':popover-open'), false);
  assert.equal(f.document.activeElement, f.view.trigger);
  assert.equal(f.context.selected, sender.id); assert.equal(f.context.mode, 'chat');
  assert.equal(f.context.roomViews.draft, 'SPACE DRAFT'); assert.equal(f.context.privateDraft, 'PRIVATE DRAFT');
  assert.equal(f.context.readingPositions.anchor, 'ORIGINAL ANCHOR');
  assert.equal(message.wake.body, '  ORIGINAL <body> 中文\n \t');
});
test('empty records and identity changes close stale previews without publishing or replaying anything', () => {
  const f = fixture([]); f.update(); f.view.trigger.click(); assert.equal(f.view.empty.hidden, false);
  f.update({ ...sender, nativeId: 'new-native-identity' });
  assert.equal(f.view.panel.matches(':popover-open'), false);
  f.update(null); assert.equal(f.view.trigger.hidden, true); assert.equal(f.view.rows.size, 0);
});
test('a changed failure reason retains every character, and unexpected legacy notices are never stripped', () => {
  const f = fixture([]), message = wake('original', 1);
  message.text = 'Exact refusal: permission changed.\n\n' + message.wake.body;
  let parts = f.context.spaceMessagePreviewText(message);
  assert.equal(parts.notice + parts.body, message.text);
  assert.equal(parts.body, message.wake.body);
  message.text = 'Unexpected legacy receipt with original reason, not the expected suffix.';
  parts = f.context.spaceMessagePreviewText(message);
  assert.equal(parts.body, message.text); assert.equal(parts.notice, '');
});
test('latest twenty records are bounded, missing times stay unknown, and removed rows disappear', () => {
  const rows = Array.from({ length: 25 }, (_, i) => wake('row-' + i, i));
  rows.push(wake('unknown-time', undefined));
  const room = { id: 'a', name: 'A', messages: rows }, f = fixture([room]);
  assert.equal(f.rows(sender.id).length, 20); assert.equal(f.rows(sender.id)[0].message.id, 'row-24');
  f.update(); f.view.trigger.click();
  room.messages = [rows[25]]; f.update();
  assert.equal(f.view.rows.size, 1); assert.match([...f.view.rows.values()][0].meta.textContent, /A · /);
  assert.ok([...f.view.rows.values()][0].meta.textContent.includes(locale.format('en', 'reading.unknownTime')));
  rows[25].time = 1e20; f.update();
  assert.ok([...f.view.rows.values()][0].meta.textContent.includes(locale.format('en', 'reading.unknownTime')));
  assert.equal(room.messages.length, 1);
});
