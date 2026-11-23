const test = require('node:test'), assert = require('node:assert/strict');
require('../renderer/session-timers.js');
const { collect, label, shape, HOLD_MS } = globalThis.nativeWorkspaceSessionTimers;
const locale = require('../ui-locale.js');
const place = card => ({ id: card.anchor || card.id, title: 'Title ' + card.id });
function waiting(id, expiresAt, extra = {}) {
  return { id, key: 'agent:native:' + id, sessionId: 'agent', state: 'confirmation-required', expiresAt, ...extra,
    message: { backgroundOperation: { id, state: 'confirmation-required', ...(extra.op || {}) } } };
}
function running(id, startedAt, extra = {}) {
  return { id, key: 'agent:native:' + id, sessionId: 'agent', state: 'running', expiresAt: null, ...extra,
    message: { backgroundOperation: { id, state: 'running', startedAt } } };
}
const view = items => items.map(item => [item.target, item.kind]);
test('the soonest countdown leads, then expired, then running; other sessions and settled cards stay out', () => {
  const now = 100000;
  const cards = [running('r', now - 10000), waiting('late', now + 90000), waiting('soon', now + 30000), waiting('gone', now - HOLD_MS - 1),
    waiting('answered', now + 5000, { op: { answer: 'queued' } }), waiting('other', now + 1000, { sessionId: 'someone' }),
    { ...waiting('done', now + 1000), state: 'complete', message: { backgroundOperation: { id: 'done', state: 'complete' } } }];
  assert.deepEqual(view(collect({ sessionId: 'agent', cards, place, now })), [['soon', 'countdown'], ['late', 'countdown'], ['r', 'running']]);
});
test('a merged batch is one timer at the card that draws it, with its soonest deadline', () => {
  const now = 0, cards = [waiting('a', 50000, { anchor: 'c' }), waiting('b', 20000, { anchor: 'c' }), waiting('c', 80000, { anchor: 'c' })];
  const items = collect({ sessionId: 'agent', cards, place, now });
  assert.deepEqual(view(items), [['c', 'countdown']]); assert.equal(items[0].at, 20000);
  const started = [running('a', 1000, { anchor: 'c' }), waiting('c', 80000, { anchor: 'c', op: { answer: 'queued' } })];
  assert.deepEqual(view(collect({ sessionId: 'agent', cards: started, place, now: 5000 })), [['c', 'running']]);
});
test('a countdown that reached zero says so for five seconds, even once its card is gone, then leaves', () => {
  const card = waiting('a', 10000), first = collect({ sessionId: 'agent', cards: [card], place, now: 9000 });
  assert.deepEqual(view(first), [['a', 'countdown']]);
  assert.deepEqual(view(collect({ sessionId: 'agent', cards: [card], place, now: 10000 })), [['a', 'expired']]);
  const gone = collect({ sessionId: 'agent', cards: [], place, held: first, now: 12000 });
  assert.deepEqual(view(gone), [['a', 'expired']]);
  assert.deepEqual(view(collect({ sessionId: 'agent', cards: [], place, held: gone, now: 10000 + HOLD_MS })), []);
  assert.deepEqual(view(collect({ sessionId: 'agent', cards: [], place, held: first, now: 9500 })), [], 'cancelled before its deadline: no expired notice');
});
test('labels reuse the card words; names spell out the time and the jump', () => {
  const zh = (key, params) => locale.format('zh', key, params), en = (key, params) => locale.format('en', key, params);
  const words = (fmt, l) => [l.text.map(([key, params]) => fmt(key, params)).join(' '), fmt(...l.name)];
  assert.deepEqual(words(zh, label({ kind: 'countdown', at: 83000 }, 0)), ['等你确认 · 剩余 1:23', '等你确认，剩余 1 分 23 秒，跳到这条消息']);
  assert.deepEqual(words(zh, label({ kind: 'running', at: 0 }, 10400)), ['执行中 · 已 10 秒', '执行中，已 10 秒，跳到这条消息']);
  assert.deepEqual(words(zh, label({ kind: 'expired', at: 0 }, 1000)), ['已到期 · 未执行', '已到期，未执行，跳到这条消息']);
  assert.deepEqual(words(zh, label({ kind: 'countdown', at: 23000 }, 0)), ['等你确认 · 剩余 0:23', '等你确认，剩余 23 秒，跳到这条消息']);
  assert.deepEqual(words(en, label({ kind: 'countdown', at: 83000 }, 0)), ['Waiting for confirmation · 1:23 left', 'Waiting for confirmation, 1 min 23 s left. Jump to this message']);
  assert.deepEqual(words(en, label({ kind: 'running', at: 0 }, 10400)), ['Running · 10s elapsed', 'Running, 10 s elapsed. Jump to this message']);
  assert.equal(shape([{ target: 'a', kind: 'countdown', at: 1 }]), shape([{ target: 'a', kind: 'countdown', at: 2 }]));
  assert.notEqual(shape([{ target: 'a', kind: 'countdown' }]), shape([{ target: 'a', kind: 'expired' }]));
});
