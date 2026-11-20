const test = require('node:test'), assert = require('node:assert/strict');
const board = require('../renderer/task-board.js'), locale = require('../ui-locale.js');
const { fixture } = require('./fixtures/task-board-dom.cjs');
const now = 1700000000000;
function setup(kind, route, language) {
  const f = fixture(), calls = [], actor = { id: 'member', nativeId: 'native', name: 'Synthetic member', state: 'idle', roomIds: ['space'] };
  if (kind === 'unknown' && route === 'session') actor.transportDisconnected = true;
  const item = { id: 'task', text: 'Synthetic request to inspect', status: kind === 'unknown' ? 'sent' : 'waiting', sentTo: route === 'session' ? actor.id : 'missing-member',
    ...(kind === 'review' ? { reason: 'no-reply' } : {}) };
  f.input = { rooms: [{ id: 'space', name: 'Example', queue: route === 'card' ? [] : [item] }], sessions: [actor], connected: true, confirmationsAvailable: true,
    confirmations: route === 'card' ? [{ key: 'card-key', id: 'card-message', sessionId: actor.id, nativeId: actor.nativeId, operationId: 'operation',
      state: kind === 'unknown' ? 'unverifiable' : 'confirmation-required', actionable: kind !== 'unknown', expiresAt: now + 100000 }] : [] };
  f.board = board.bind({ host: f.host, document: f.doc, text: (k, p) => locale.format(language, k, p), now: () => now,
    onSession: (...args) => calls.push(['session', ...args]), onQueue: id => calls.push(['queue', id]), onConfirmation: target => calls.push(['card', target]) });
  f.board.update(f.input); f.board.open(); f.host.querySelector('[data-board-tab="' + kind + '"]').fire('click'); f.calls = calls;
  return f;
}
for (const lang of ['zh', 'en']) for (const kind of ['waiting', 'review', 'unknown']) test(lang + ' ' + kind + ': the page explains response duty and the next step', () => {
  const f = setup(kind, 'queue', lang);
  try {
    const help = f.host.querySelector('.task-board-state-help'); assert.ok(help); assert.equal(help.hidden, false);
    const checks = lang === 'zh' ? { waiting: ['需要你答复或确认', '会话', '队列', '确认卡'], review: ['不要求你回复', '查看上轮结果', '判断是否继续'], unknown: ['是否需要你回应还不确定', '核实当前状态'] }
      : { waiting: ['need your reply or confirmation', 'conversation', 'queue', 'confirmation card'], review: ['No reply is requested', 'last outcome', 'whether to continue'], unknown: ['reply is needed is not yet known', 'check its current state'] };
    for (const phrase of checks[kind]) assert.ok(help.textContent.includes(phrase), phrase);
    assert.equal(f.host.querySelector('.task-board-list').getAttribute('aria-describedby'), help.id);
  } finally { f.board.dispose(); }
});
test('state-specific action names match the unchanged session, queue and card routes', () => {
  const names = {
    waiting: { session: '去会话处理', queue: '去队列看问题', card: '去确认卡处理' },
    review: { session: '查看会话结果', queue: '查看队列结果' },
    unknown: { session: '核实会话状态', queue: '核实队列状态', card: '核实确认卡' }
  };
  for (const [kind, routes] of Object.entries(names)) for (const [route, name] of Object.entries(routes)) {
    const f = setup(kind, route, 'zh');
    try {
      const row = f.host.querySelector('.task-board-entry'); assert.equal(row.querySelector('.task-board-row-action').textContent, name);
      row.fire('click'); assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], route);
      if (route === 'session') assert.deepEqual(f.calls[0], ['session', 'member', 'native']);
      if (route === 'queue') assert.deepEqual(f.calls[0], ['queue', 'space']);
      if (route === 'card') assert.deepEqual(Object.keys(f.calls[0][1]).sort(), ['history', 'messageId', 'nativeId', 'operationId', 'sessionId']);
    } finally { f.board.dispose(); }
  }
});
test('summary and retention names are literal, and narrow tabs advertise scrolling', () => {
  const f = setup('waiting', 'queue', 'zh');
  try {
    assert.ok(f.host.querySelector('[data-board-tab="active"]').textContent.startsWith('未收尾'));
    const all = f.host.querySelector('.task-board-scope').options.find(o => o.value === 'all'); assert.equal(all.textContent, '全部留存');
    const hint = f.host.querySelector('.task-board-tabs-hint'); assert.ok(hint.textContent.includes('左右滑动')); assert.ok(hint.textContent.includes('更多状态'));
  } finally { f.board.dispose(); }
});
