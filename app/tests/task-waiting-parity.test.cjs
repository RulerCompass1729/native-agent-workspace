const test = require('node:test'), assert = require('node:assert/strict');
const { scene } = require('./fixtures/waiting-stream-dom.cjs');
for (const language of ['zh', 'en']) test(language + ': banner and status share non-card waiting while the card keeps its deadline', t => {
  const now = Date.now();
  const sessions = [{ id: 'member', nativeId: 'native', name: 'Member', state: 'working', roomIds: ['space'] }, { id: 'solo', state: 'approval', roomIds: [] }];
  const rooms = [{ id: 'space', queue: [{ id: 'a', status: 'waiting' }, { id: 'b', status: 'waiting' }] }];
  const confirmations = [{ key: 'member:native:op', id: 'card', operationId: 'op', sessionId: 'member', nativeId: 'native', state: 'confirmation-required', actionable: true, expiresAt: now + 100000 }];
  const s = scene(language, { rooms, sessions, confirmations, confirmationsAvailable: true }); t.after(s.dispose);
  assert.equal(s.count(), 3); assert.equal(s.observed.at(-1), 3); assert.equal(s.barRepeats(), false);
  assert.equal(s.label(), language === 'zh' ? '有 1 件等你确认 · 3 件待你处理' : '1 action needs your confirmation · 3 to handle');
  assert.match(s.deadline(), /1:40/);
  s.advance(100000); assert.equal(s.cardHidden(), true); assert.equal(s.count(), 3);
  rooms[0].queue[0].reason = 'no-reply'; s.render();
  assert.equal(s.count(), 2); assert.equal(s.observed.at(-1), 2);
  assert.match(s.label(), language === 'zh' ? /2 件待你处理 · 1 件待查看/ : /2 to handle · 1 to review/);
});
