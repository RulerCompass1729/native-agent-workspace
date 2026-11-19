// Actual reading-list source and existing DOM fixture; no app or provider calls.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const locale = require('../ui-locale.js');
const helperFile = path.join(__dirname, 'reading-locale.test.cjs');
let helpers = fs.readFileSync(helperFile, 'utf8').split("test('typed own notices")[0];
if (process.env.NAW_READING_SOURCE) {
  const original = "const source = fs.readFileSync(path.join(__dirname, '../renderer/reading-list.js'), 'utf8');";
  assert.ok(helpers.includes(original));
  helpers = helpers.replace(original, `const source = fs.readFileSync(${JSON.stringify(path.resolve(process.env.NAW_READING_SOURCE))}, 'utf8');`);
}
const scope = vm.createContext({ require: createRequire(helperFile), __dirname, console });
vm.runInContext(helpers + '\nglobalThis.makeFixture = fixture;', scope);
const body = 'EXACT original 中文 <text>\n  keep whitespace';
const time = new Date('2026-11-09T19:08:12Z').getTime();
const mirror = (extra = {}) => ({ id: 'mirrored-wake', role: 'system', kind: 'agent-wake', name: 'Jun → Mira',
  text: 'Registered notice\n' + body, time,
  wake: { id: 'original-wake', senderId: 'session-A', senderName: 'Jun', recipientId: 'session-B', recipientName: 'Mira', body },
  wakeStatus: 'staged', ...extra });
const peer = () => ({ id: 'mirrored-peer', role: 'system', kind: 'agent-peer', name: 'Sender (unverified) → Mira', text: body, time,
  peerMessage: { senderId: null, senderName: 'Claimed sender', recipientId: 'session-B', recipientName: 'Mira' } });
function fixture(rows) {
  const f = scope.makeFixture(rows, true);
  f.state.sessions.push({ id: 'session-B', name: 'Mira', nativeId: 'native-B' });
  const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  const from = renderer.indexOf('function roomMessageLabel('), to = renderer.indexOf('function timeline()', from);
  assert.ok(from >= 0 && to > from);
  vm.runInContext(renderer.slice(from, to), f.context);
  f.redraw = () => f.context.messageList(f.root, rows, true, 'room');
  f.redraw();
  f.entry = id => f.view.entries.get(id || rows[0].id);
  return f;
}
const child = (entry, tag) => entry.heading.childNodes.find(node => node.tagName === tag);
const badge = entry => entry.heading.childNodes.find(node => node.className === 'space-message-status');

test('recorded wake and peer rows show actual participants, recorded time and separate delivery facts', () => {
  const rows = [mirror(), peer()], f = fixture(rows);
  for (const row of rows) {
    const entry = f.entry(row.id);
    assert.equal(child(entry, 'time')?.dateTime, new Date(time).toISOString());
    assert.ok(entry.heading.textContent.includes('Mira'));
    assert.ok(badge(entry), 'each recorded communication has an explicit delivery fact');
    assert.match(entry.item.className, /\bspace-message\b/, 'communication rows have a layout independent of compact system notices');
  }
  assert.match(f.entry(rows[0].id).heading.textContent, /USER 中文 name.*Mira/);
  assert.equal(badge(f.entry(rows[0].id)).textContent, locale.format('zh', 'reading.wakeRegistered'));
  assert.match(f.entry(rows[1].id).heading.textContent, /未核实/);
  assert.equal(badge(f.entry(rows[1].id)).textContent, locale.format('zh', 'delivery.peerReceived'));
  assert.equal(f.calls.length, 0);
});

test('wake receipt transitions update the badge without rewriting the selected original body or dropping reasons', () => {
  const row = mirror(), f = fixture([row]), entry = f.entry(), originalNode = entry.body;
  const originalWrites = originalNode.textWrites;
  assert.equal(originalNode.textContent, body);
  const selection = f.context.window.getSelection();
  Object.assign(selection, { isCollapsed: false, anchorNode: originalNode, focusNode: originalNode, anchorOffset: 0, focusOffset: 5 });
  for (const status of ['sending', 'submitted', 'unconfirmed', 'not-sent', 'cancelled', 'future-state', undefined]) {
    row.wakeStatus = status;
    row.text = 'Exact changed reason ' + String(status) + '\n' + body;
    f.redraw();
    assert.equal(entry.body, originalNode);
    assert.equal(originalNode.textContent, body);
    assert.equal(originalNode.textWrites, originalWrites, 'status-only updates retain original body text nodes');
    assert.ok(entry.item.textContent.includes('Exact changed reason ' + String(status)), 'the complete source reason remains readable');
    assert.equal(badge(entry).textContent, locale.format('zh', f.context.readingWakeStatus({ status })));
    assert.equal(selection.anchorNode, originalNode);
  }
  f.switch('en');
  assert.equal(originalNode.textContent, body);
  assert.equal(badge(entry).textContent, locale.format('en', 'delivery.unknown'));
});

test('control messages use only the addressed recipient receipt, not another recipient success', () => {
  const row = { id: 'control', role: 'human', name: 'Jun', recipientId: 'session-B', time, text: body,
    agentControl: { id: 'session-A', nativeId: 'native-A', name: 'Jun' },
    deliveries: [{ id: 'other-receipt', recipientId: 'other', status: 'submitted', text: body }, { id: 'target-receipt', recipientId: 'session-B', status: 'unconfirmed', text: body }] };
  const f = fixture([row]), entry = f.entry();
  assert.equal(badge(entry)?.textContent, locale.format('zh', 'delivery.unconfirmed'));
  row.deliveries[1].status = 'submitted'; f.redraw();
  assert.equal(badge(entry).textContent, locale.format('zh', 'delivery.submitted'));
  row.deliveries.pop(); f.redraw();
  assert.equal(badge(entry).textContent, locale.format('zh', 'delivery.unknown'));
  assert.equal(entry.body.textContent, body);
});

test('real typed receipt notices change language and status without replacing their original body', async () => {
  const row = mirror({ ...locale.createNotice('notice.wake.registered', { name: 'Mira', body }) });
  const f = fixture([row]), entry = f.entry(), originalNode = entry.body, writes = originalNode.textWrites;
  Object.assign(row, locale.createNotice('notice.wake.submitted', { body }), { wakeStatus: 'submitted' });
  f.redraw();
  assert.equal(entry.body, originalNode);
  assert.equal(originalNode.textContent, body);
  assert.equal(originalNode.textWrites, writes);
  assert.ok(entry.spaceNotice.textContent.includes('原生已接收'));
  f.switch('en');
  assert.equal(originalNode.textContent, body);
  assert.equal(originalNode.textWrites, writes);
  assert.ok(entry.spaceNotice.textContent.includes('accepted by the native process'));
  const copy = entry.copyText.onclick(); f.acceptCopy(); await copy;
  assert.equal(f.copies[0], locale.format('en', 'notice.wake.submitted', { body }));
});

test('only typed communication rows gain clocks or facts; missing receipt/time remain unknown', () => {
  const f = fixture([]), r = f.context;
  for (const row of [mirror(), peer()]) assert.ok(r.readingMessageClock(row));
  for (const row of [{ role: 'system', kind: 'notice', text: body, time }, { role: 'system', kind: 'turn', time },
    { role: 'system', kind: 'agent-wake', wake: {}, time }, { role: 'system', kind: 'agent-peer', peerMessage: {}, time }]) {
    assert.equal(r.readingMessageClock(row), null);
    assert.equal(r.readingSpaceMessageStatus(row, true), null);
  }
  assert.equal(r.readingSpaceMessageStatus(mirror(), false), null, 'solo native notices keep their existing behavior');
  const missing = mirror({ time: undefined, wakeStatus: undefined });
  const unknown = fixture([missing]);
  assert.equal(badge(unknown.entry())?.textContent, locale.format('zh', 'delivery.unknown'));
  assert.ok(unknown.entry().heading.textContent.includes(locale.format('zh', 'reading.unknownTime')));
});

test('legacy text without an exact body suffix remains intact and source-copy keeps the complete notice', async () => {
  const row = mirror({ text: 'LEGACY entire original: ' + body + '\ntrailing data' });
  const f = fixture([row]), entry = f.entry();
  assert.equal(entry.body.textContent, row.text);
  const copy = entry.copyText.onclick(); f.acceptCopy(); await copy;
  assert.equal(f.copies[0], row.text);
  const typed = mirror(), g = fixture([typed]), typedCopy = g.entry().copyText.onclick();
  g.acceptCopy(); await typedCopy;
  assert.equal(g.copies[0], typed.text, 'splitting the visible original body never drops its source notice from Copy');
});

// Progressive disclosure ③ (the person, 2026-11-19): the space stream pages like a chat, 50 records at a time,
// with the earlier ones on top; it never folds a single message.
test('a long space stream shows the latest fifty records, reaches every earlier one, and keeps each message whole', () => {
  const long = 'Whole shared message 中文 '.repeat(400);
  const rows = Array.from({ length: 400 }, (_, i) => ({ id: 'shared-' + i, role: 'user', name: 'Mira',
    text: i === 399 ? long : 'Shared record ' + i, time: time + i * 1000 }));
  const f = fixture(rows), r = f.context;
  r.attempt = () => {};
  f.root.focus = () => {};
  const shown = () => rows.filter(row => f.view.entries.has(row.id)).map(row => row.id);
  assert.equal(shown().length, 50);
  assert.equal(shown()[0], 'shared-350');
  assert.equal(f.root.childNodes[0], f.view.older, 'the earlier records come in at the top, as in a chat');
  assert.equal(f.view.older.hidden, false);
  assert.equal(f.view.newer.hidden, true);
  assert.equal(f.entry('shared-399').body.textContent, long, 'the newest message is drawn whole, not folded to a line');
  for (let presses = 0; presses < 7; presses++) r.changeReadingPage(f.view, 'older', true);
  assert.equal(shown().length, 400);
  assert.equal(shown()[0], 'shared-0');
  assert.equal(f.view.older.hidden, true, 'no button once the first record is shown');
});
