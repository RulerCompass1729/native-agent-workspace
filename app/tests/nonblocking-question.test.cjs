const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Codex } = require('../adapters.cjs'), { Workspace } = require('../workspace.cjs');
const model = require('../task-stream.js'), { MobileWorkspace } = require('../mobile-workspace.cjs');

// 11-15 (the person: 「agent 需要问的问题我根本可能看不见」): a Codex question that does not block its turn
// (isBlocking false) was only in the native terminal. It is now in 「等你」 with its text, answerable from NAW
// through the existing answer path, on the phone, and in the butler's record; once answered it leaves them all.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-nonblocking-')), replies = [];
  const host = { binaries: {}, codexTargets: new Map(), close() {}, rpc: { reply: (id, result) => replies.push({ id, result }) } };
  const w = new Workspace(host, dir);
  const s = { id: 'synthetic', nativeId: 'native-synthetic', name: 'Synthetic member', provider: 'codex', state: 'idle', owner: 'window', messages: [], fleet: [], controlRevision: 0, memberRevision: 0 };
  const r = new Codex(s, host); w.sessions.set(s.id, s); w.runtimes.set(s.id, r); w.bind(s, r);
  t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const ask = (id, isBlocking = false, question = 'Which synthetic way?') => r.event({ id, method: 'item/tool/requestUserInput', params: { threadId: s.nativeId, isBlocking,
    questions: [{ id: 'q', header: 'Way', question, options: [{ label: 'First', description: '' }, { label: 'Second', description: '' }] }] } });
  const resolve = id => r.event({ method: 'serverRequest/resolved', params: { threadId: s.nativeId, requestId: id } });
  return { dir, w, s, r, replies, ask, resolve };
}

test('a question that does not block the turn is answered from NAW while the turn works and after it ends', t => {
  const f = fixture(t); f.r.emit('state', 'working'); f.ask('nb');
  assert.equal(f.s.state, 'working', 'the turn keeps running');
  const requestId = f.s.approval.requestId;
  f.w.answer(f.s.id, requestId, { q: ['Second'] }, 'window');
  assert.deepEqual(f.replies, [{ id: 'nb', result: { answers: { q: { answers: ['Second'] } } } }]);
  assert.equal(f.s.approvals[0].pending, true);
  f.resolve('nb'); assert.equal(f.s.approval, null);
  // After the turn ended the question can still be open.
  const g = fixture(t); g.r.emit('state', 'working'); g.ask('later'); g.r.emit('state', 'idle');
  g.w.answer(g.s.id, g.s.approval.requestId, { q: ['First'] }, 'window');
  assert.deepEqual(g.replies, [{ id: 'later', result: { answers: { q: { answers: ['First'] } } } }]);
});

test('only a non-blocking question is answerable outside the waiting state; owner and stale checks stay', t => {
  const f = fixture(t); f.r.emit('state', 'working');
  // A blocking question reported while the session reads working is not answered from that state.
  f.ask('held', true); f.s.state = 'working';
  assert.throws(() => f.w.answer(f.s.id, f.s.approval.requestId, { q: ['First'] }, 'window'), /问题已变化/);
  const g = fixture(t); g.r.emit('state', 'working'); g.ask('nb');
  assert.throws(() => g.w.answer(g.s.id, g.s.approval.requestId, { q: ['First'] }, 'other-window'), /问题已变化/);
  g.r.transportDisconnected = true;
  assert.throws(() => g.w.answer(g.s.id, g.s.approval.requestId, { q: ['First'] }, 'window'), /问题已变化/);
  assert.deepEqual([...f.replies, ...g.replies], []);
});

test('a written non-blocking answer cannot be resent before or after native resolves it', t => {
  const f = fixture(t); f.r.emit('state', 'working'); f.ask('nb');
  const requestId = f.s.approval.requestId, answer = { q: ['Second'] };
  f.w.answer(f.s.id, requestId, answer, 'window');
  assert.throws(() => f.w.answer(f.s.id, requestId, answer, 'window'), /问题已变化/);
  f.resolve('nb');
  assert.throws(() => f.w.answer(f.s.id, requestId, answer, 'window'), /问题已变化/);
  assert.deepEqual(f.replies, [{ id: 'nb', result: { answers: { q: { answers: ['Second'] } } } }]);
});

test('ending the session or losing its transport clears unanswered questions and refuses late answers', t => {
  for (const ended of [true, false]) {
    const f = fixture(t); f.r.emit('state', 'working'); f.ask('nb');
    const requestId = f.s.approval.requestId;
    if (!ended) f.r.transportDisconnected = true;
    f.r.emit('state', ended ? 'ended' : 'disconnected');
    assert.equal(f.s.approval, null); assert.deepEqual(f.s.approvals, []);
    assert.deepEqual(model.waitingItems({ sessions: [f.s] }), []);
    assert.throws(() => f.w.answer(f.s.id, requestId, { q: ['First'] }, 'window'), /问题已变化/);
    assert.deepEqual(f.replies, []);
  }
});

test('「等你」 lists each open non-blocking question with its text and a steady time, and drops it once answered', t => {
  const f = fixture(t); f.r.emit('state', 'working'); f.ask('nb', false, 'Which synthetic way should the member take?');
  const first = model.waitingItems({ sessions: [f.s], now: 1 }), again = model.waitingItems({ sessions: [f.s], now: 2 });
  assert.deepEqual(first.map(i => [i.kind, i.title, i.actorName, i.sessionId, i.requestId]),
    [['question', 'Which synthetic way should the member take?', 'Synthetic member', f.s.id, f.s.approval.requestId]]);
  assert.equal(first[0].time, again[0].time, 'the row keeps the time NAW first saw the question');
  assert.ok(Number.isFinite(first[0].time) && first[0].time > 2);
  // A permission request in the same session keeps its own row, ranked first.
  f.r.event({ id: 'cmd', method: 'item/commandExecution/requestApproval', params: { threadId: f.s.nativeId, command: 'synthetic', cwd: '/synthetic' } });
  assert.deepEqual(model.waitingItems({ sessions: [f.s] }).map(i => i.kind), ['approval', 'question']);
  f.resolve('cmd'); f.r.emit('state', 'working');
  f.w.answer(f.s.id, f.s.approvals.find(a => a.params.isBlocking === false).requestId, { q: ['First'] }, 'window');
  assert.deepEqual(model.waitingItems({ sessions: [f.s] }), [], 'answered: nothing waits for the person');
  // A blocking question keeps the one approval row as before.
  const g = fixture(t); g.ask('held', true);
  assert.deepEqual(model.waitingItems({ sessions: [g.s] }).map(i => [i.kind, i.title]), [['approval', '']]);
  // Real Codex 0.168 (Default mode) also reports its turn as waiting on the question: still one row, gone once answered.
  const h = fixture(t); h.r.emit('state', 'working'); h.ask('nb'); h.r.emit('state', 'approval');
  assert.deepEqual(model.waitingItems({ sessions: [h.s] }).map(i => i.kind), ['question']);
  h.w.answer(h.s.id, h.s.approval.requestId, { q: ['First'] }, 'window');
  assert.deepEqual(model.waitingItems({ sessions: [h.s] }), []);
});

test('the phone home row says the member needs you while a non-blocking question is open', t => {
  const f = fixture(t); f.r.emit('state', 'working'); f.ask('nb');
  const grant = { roomIds: [], records: false }, records = { status: () => null, acknowledge: () => {} };
  const phone = new MobileWorkspace({ snapshot: () => ({ sessions: [f.s], rooms: [] }), roomState: {}, records });
  const client = { refresh: async () => {}, route: () => ({ key: '.' }) };
  const read = () => phone.read(client, grant, [{ serviceKey: '.', sessionId: f.s.id, nativeId: f.s.nativeId, actions: ['read'] }]);
  return read().then(view => {
    assert.equal(view.sessions[0].question, true);
    f.w.answer(f.s.id, f.s.approval.requestId, { q: ['First'] }, 'window');
    return read();
  }).then(view => assert.equal(view.sessions[0].question, false));
});

test('stewardEvents records an open question once and its end once, across a restart, without model work', t => {
  const { ButlerIngress } = require('../butler-ingress.cjs'), { RoomState } = require('../room-state.cjs');
  const f = fixture(t), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-question-events-')); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  f.r.emit('state', 'working'); f.ask('nb'); f.s.messages.push({ text: 'PRIVATE TRANSCRIPT NEVER COPIED' });
  const ingress = new ButlerIngress(dir, { roomState: new RoomState(dir) });
  ingress.observeNativeQuestions([f.s]); ingress.observeNativeQuestions([f.s]);
  // A state without the member proves nothing.
  ingress.observeNativeQuestions([]);
  const reopened = new ButlerIngress(dir, { roomState: new RoomState(dir) });
  reopened.observeNativeQuestions([f.s]);
  f.w.answer(f.s.id, f.s.approval.requestId, { q: ['First'] }, 'window');
  reopened.observeNativeQuestions([f.s]); reopened.observeNativeQuestions([f.s]);
  const events = reopened.ledger.eventsAfter(null).events;
  assert.deepEqual(events.map(e => [e.kind, e.payload.reason]), [['blocked', 'native-question'], ['recovery', 'native-question-ended']]);
  assert.deepEqual([events[0].payload.memberName, events[0].payload.title, events[0].payload.text], ['Synthetic member', 'Way', 'Which synthetic way?']);
  assert.ok(!JSON.stringify(events).includes('PRIVATE TRANSCRIPT'));
  assert.equal(reopened.ledger.pendingEvents().length, 0, 'the observation does not start model work');
  // Ending the session clears its requests, so a still-open question is recorded as ended too.
  const g = fixture(t); g.r.emit('state', 'working'); g.ask('left');
  reopened.observeNativeQuestions([g.s]); g.r.emit('state', 'ended'); reopened.observeNativeQuestions([g.s]);
  assert.deepEqual(reopened.ledger.eventsAfter(null).events.slice(2).map(e => e.payload.reason), ['native-question', 'native-question-ended']);
});

test('the session view and the 「等你」 row enable the answer form for an open non-blocking question', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const renderer = read('renderer/renderer.js'), board = read('renderer/task-board.js');
  assert.match(renderer, /const open = s\.state === 'approval' \|\| window\.nativeWorkspaceApproval\.nonBlockingQuestion\(s\.approval\) && \['working', 'idle'\]\.includes\(s\.state\);/);
  assert.match(renderer, /else if \(item\.kind === 'question'\) renderWaitingQuestion\(slot\.question, item\);/);
  assert.match(renderer, /appendQuestionForm\(parent, questions, s\.owner !== owner [^\n]*api\.answer\(s\.id, item\.requestId, answers\)\)/);
  assert.match(board, /\['background-confirmation', 'question', 'operator-creation'\]\.includes\(row\.kind\)/);
  assert.match(board, /onWaiting\(d\.slot, row\.waiting\)/);
  const messages = require('../ui-messages.js'), zh = messages.zh || messages.messages?.zh, en = messages.en || messages.messages?.en;
  assert.equal(zh['stream.question'], zh['approval.nonBlocking']); assert.equal(en['stream.question'], en['approval.nonBlocking']);
});
