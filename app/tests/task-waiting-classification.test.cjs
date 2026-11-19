const test = require('node:test'), assert = require('node:assert/strict');
const { scene } = require('./fixtures/waiting-stream-dom.cjs');
const input = fields => ({ connected: true, confirmationsAvailable: true, confirmations: [], rooms: [{ id: 'space', queue: [] }],
  sessions: [{ id: 'member', name: 'Synthetic', nativeId: 'native', state: 'approval', roomIds: ['space'], ...fields }] });
const cases = [
  ['approval', { approval: { pending: true } }],
  ['claudeQuestion', { claudeQuestion: { pending: true } }],
  ['approvals', { approvals: [{ pending: true }] }],
  ['nativeApproval', { nativeApproval: { requests: [{ pending: true }] } }],
];
for (const language of ['zh', 'en']) {
  for (const [name, template] of cases) test(`${language}: submitted ${name} leaves the banner and real waitingChanged count`, t => {
    const fields = structuredClone(template);
    const s = scene(language, input(fields)); t.after(s.dispose);
    assert.equal(s.observed.at(-1), 0); assert.equal(s.count(), 0); assert.equal(s.hidden(), true);
    const request = fields[name];
    if (Array.isArray(request)) request[0].pending = false;
    else if (request.requests) request.requests[0].pending = false;
    else request.pending = false;
    s.render(); assert.equal(s.observed.at(-1), 1); assert.equal(s.count(), 1); assert.equal(s.hidden(), false);
  });
  for (const reason of ['no-reply', 'person-intervened']) test(`${language}: ${reason} remains reviewable without asking for a decision`, t => {
    const v = input(); v.sessions = []; v.rooms[0].queue = [{ id: 'review', status: 'waiting', reason, text: 'Synthetic review' }];
    const s = scene(language, v); t.after(s.dispose);
    assert.equal(s.count(), 0); assert.equal(s.observed.at(-1), 0); assert.equal(s.hidden(), false);
    assert.equal(s.label(), language === 'zh' ? '1 件待查看' : '1 to review');
  });
  test(`${language}: card, unanswered decisions and reviews have distinct labels`, t => {
    const v = input({ state: 'working' });
    v.rooms[0].queue = [1, 2, 3].map(id => ({ id: String(id), status: 'waiting' }));
    v.rooms[0].queue.push({ id: 'review', status: 'waiting', reason: 'no-reply' });
    v.confirmations = [{ id: 'card', key: 'card', sessionId: 'member', nativeId: 'native', actionable: true, expiresAt: Date.now() + 100000 }];
    const s = scene(language, v); t.after(s.dispose);
    assert.equal(s.count(), 3);
    assert.equal(s.label(), language === 'zh' ? '有 1 件等你确认 · 3 件等你 · 1 件待查看' : '1 action needs your confirmation · 3 waiting for you · 1 to review');
  });
}
test('an unclassified approval state and overflow still ask the person; pending neighbours never hide a live request', t => {
  for (const fields of [{}, { approval: { pending: true }, approvalOverflow: true }, { approvals: [{ pending: true }, { pending: false }] },
    { nativeApproval: { requests: [{ pending: true }, { pending: false }] } }, { approval: { pending: true }, claudeQuestion: { pending: false } }]) {
    const s = scene('zh', input(fields)); t.after(s.dispose); assert.equal(s.count(), 1);
  }
});
