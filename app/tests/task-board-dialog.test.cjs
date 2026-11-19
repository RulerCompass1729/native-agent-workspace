const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), board = require('../renderer/task-board.js'), locale = require('../ui-locale.js');
const { fixture } = require('./fixtures/task-board-dom.cjs');
function setup(language = 'zh') {
  const f = fixture(); f.input = { connected: true, activeSpace: 'space', rooms: [{ id: 'space', name: 'Synthetic space', queue: [
    { id: 'sent', status: 'sent', text: 'Synthetic request', sentTo: 'member' }, { id: 'review', status: 'waiting', reason: 'no-reply', text: 'Synthetic review' },
  ] }], sessions: [{ id: 'member', name: 'Synthetic member' }] };
  f.board = board.bind({ host: f.host, document: f.doc, text: (key, params) => locale.format(language, key, params), onQueue() {} }); f.board.update(f.input);
  f.button = f.host.querySelector('.task-board-project'); f.panel = f.host.querySelector('.task-board-panel'); return f;
}
test('36px is the only strip height and the full panel has no layout track', () => {
  assert.equal(board.BAR_HEIGHT, 36);
  const css = fs.readFileSync(require.resolve('../renderer/task-board.css'), 'utf8');
  assert.match(css, /\.task-board-panel\{[^}]*position:fixed/); assert.doesNotMatch(css, /height:36px/);
});
test('hover and focus show live short metadata without moving keyboard focus', () => {
  const f = setup(); f.button.fire('pointerenter', { pointerType: 'mouse' }); f.tick(600);
  const hint = f.host.querySelector('.task-board-hint'); assert.ok(hint?.popoverOpen); assert.equal(f.doc.activeElement, f.doc.body);
  assert.equal(hint.getAttribute('role'), 'tooltip'); assert.equal(f.button.getAttribute('aria-describedby'), hint.id);
  assert.ok(hint.textContent.includes('Synthetic member')); assert.ok(hint.textContent.includes('未收到')); assert.ok(hint.textContent.includes('待查看'));
  f.board.dispose(); assert.equal(f.timers.size, 0);
});
test('Escape quiets the short preview until the trigger is left', () => {
  const f = setup(); f.button.focus(); f.tick(600); const hint = f.host.querySelector('.task-board-hint'); assert.ok(hint?.popoverOpen);
  f.key('Escape'); assert.equal(hint.popoverOpen, false); f.tick(600); assert.equal(hint.popoverOpen, false);
  f.doc.body.focus(); f.button.focus(); f.tick(600); assert.equal(hint.popoverOpen, true); f.board.dispose();
});
test('full board uses native modal lifecycle and returns to its space trigger', () => {
  const f = setup(), before = f.content.getBoundingClientRect(); f.button.focus(); f.button.fire('click');
  assert.equal(f.panel.tagName, 'DIALOG'); assert.equal(f.panel.open, true); assert.equal(f.doc.modal, f.panel);
  assert.equal(f.button.getAttribute('aria-expanded'), 'true'); assert.deepEqual(f.content.getBoundingClientRect(), before);
  assert.ok(parseFloat(f.panel.style.width) <= 826); assert.ok(parseFloat(f.panel.style.top) + parseFloat(f.panel.style.height) <= 600);
  f.key('Escape'); assert.equal(f.panel.open, false); assert.equal(f.button.getAttribute('aria-expanded'), 'false'); assert.equal(f.doc.activeElement, f.button);
  f.tick(1000); assert.equal(f.host.querySelector('.task-board-hint').popoverOpen, false); f.board.dispose();
});
test('short preview stays hoverable and closes after both focus and pointer leave', () => {
  const f = setup(); f.button.fire('pointerenter', { pointerType: 'mouse' }); f.tick(600); const hint = f.host.querySelector('.task-board-hint'); assert.ok(hint?.popoverOpen);
  f.button.fire('pointerleave'); hint.fire('pointerenter'); f.tick(1000); assert.equal(hint.popoverOpen, true);
  hint.fire('pointerleave'); f.tick(200); assert.equal(hint.popoverOpen, false); f.board.dispose();
});
test('state pushes update the same preview and removal cancels its lease', () => {
  const f = setup(); f.button.focus(); f.tick(600); const hint = f.host.querySelector('.task-board-hint'); assert.ok(hint?.popoverOpen);
  f.input.sessions[0].name = 'Updated member'; f.board.update(f.input); assert.ok(hint.textContent.includes('Updated member')); assert.equal(f.doc.activeElement, f.button);
  f.input.rooms = []; f.board.update(f.input); assert.equal(hint.isConnected, false); assert.equal(f.timers.size, 0); f.board.dispose();
});
test('short metadata separates review from decisions in both languages and hides raw reasons', () => {
  for (const language of ['zh', 'en']) { const f = setup(language); f.input.rooms[0].queue[1].reason = 'PRIVATE_REASON_NOT_DISPLAYED'; f.board.update(f.input);
    const hint = f.host.querySelector('.task-board-hint'); assert.ok(hint); assert.equal(hint.textContent.includes('PRIVATE_REASON_NOT_DISPLAYED'), false);
    assert.equal(f.button.querySelector('.task-board-project-name').textContent.includes('!'), true); f.board.dispose(); }
});
test('unavailable and disconnected snapshots never claim nothing is waiting', () => {
  for (const unavailable of [true, false]) { const f = setup(); f.input.rooms[0].queue = []; f.input.rooms[0].unavailable = unavailable; f.input.connected = unavailable; f.board.update(f.input);
    const hint = f.host.querySelector('.task-board-hint'); assert.ok(hint); assert.equal(hint.textContent.includes('当前没有等待或异常'), false); assert.equal(hint.textContent.includes('当前没有在派任务'), false); f.board.dispose(); }
});
test('a delayed preview cannot cover another dialog, and dispose cancels a pending one', () => {
  const f = setup(); f.button.focus(); const other = f.doc.createElement('dialog'); f.doc.body.append(other); other.showModal(); f.tick(600);
  assert.equal(f.host.querySelector('.task-board-hint').popoverOpen, false); other.close(); f.doc.body.focus(); f.button.focus(); assert.equal(f.timers.size, 1); f.board.dispose(); f.tick(1000); assert.equal(f.timers.size, 0);
});
test('a pending preview never consumes Escape for another modal', () => {
  const f = setup(); f.button.fire('pointerenter', { pointerType: 'mouse' }); const other = f.doc.createElement('dialog'); f.doc.body.append(other); other.showModal();
  f.key('Escape'); assert.equal(other.open, false); f.board.dispose();
});
