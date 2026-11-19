const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { BackgroundControl, dialog } = require('../background-control.cjs');
const sender = { id: 'agent', nativeId: 'native', provider: 'codex', name: 'Agent' };
const identity = { nativeId: 'native', sessionId: 'native-session', turnId: 'turn', callId: 'call' };
const binding = () => ({ sender, identity, valid: () => true });
const options = { message: 'Archive?', buttons: ['Cancel', 'Archive'], cancelId: 0 };
const tick = () => new Promise(resolve => setImmediate(resolve));
// One agent with archive cards for A, B, C; A's archive waits on `hold` once it starts.
function setup(t, clock = { now: 1_000_000 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-decision-queue-')); fs.chmodSync(dir, 0o700);
  const performed = [], started = []; let release; const hold = new Promise(resolve => { release = resolve; });
  const handlers = new Map([['archive', async (c, target) => {
    const answer = await dialog(c, 'message', options);
    if (answer.response !== 1) return;
    started.push(target); if (target === 'A') await hold; performed.push(target);
  }]]);
  const contexts = [];
  const config = { dataDir: dir, handlers, now: () => clock.now, context: async (actor, saved) => {
    const c = { background: true, view: saved || { selected: actor.id, draft: '' }, confirmationActors: () => [actor], checkActor: async () => {}, client: { close() {} }, win: { destroy() {} } };
    contexts.push(c); return c;
  } };
  const controller = new BackgroundControl(config);
  t.after(async () => { release(); await controller.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const ask = async target => assert.equal((await controller.call(binding(), { action: 'invoke', operation_id: target, method: 'archive', arguments: [target] })).state, 'confirmation-required');
  const answer = id => controller.rows('agent').find(m => m.backgroundOperation.id === id).backgroundOperation.answer;
  // Resolves once A's archive has started, with A's still unsettled answer.
  const runningA = async () => { const a = controller.decide('agent', 'native', 'A', 1); while (!started.includes('A')) await tick(); return [a]; };
  return { controller, config, clock, performed, started, release, ask, answer, runningA, contexts };
}
test('an answer given while the same agent runs another waits for it, then runs with its own checks', async t => {
  const f = setup(t); await f.ask('A'); await f.ask('B');
  const [a] = await f.runningA();
  const b = f.controller.decide('agent', 'native', 'B', 1);
  assert.equal(f.answer('B'), 'queued'); assert.equal(f.controller.receipt(sender, 'A').state, 'running');
  const [card] = f.controller.confirmations().filter(c => c.operationId === 'B');
  assert.equal(card.message.backgroundOperation.answer, 'queued');
  await tick(); assert.deepEqual(f.performed, []);
  f.release();
  assert.equal((await a).state, 'complete'); assert.equal((await b).state, 'complete');
  assert.deepEqual(f.performed, ['A', 'B']); assert.equal(f.answer('B'), undefined);
});
test('a queued answer whose target changed meanwhile is not carried out; the running one is unaffected', async t => {
  const f = setup(t); let target = 'old-native';
  const c = await f.controller.view(sender); c.fingerprint = () => ({ nativeId: target });
  await f.ask('A'); await f.ask('B');
  const [a] = await f.runningA();
  const b = f.controller.decide('agent', 'native', 'B', 1);
  target = 'replacement-native'; f.release();
  assert.equal((await a).state, 'complete'); assert.equal((await b).state, 'unconfirmed');
  assert.deepEqual(f.performed, ['A']);
});
test('a queued answer is judged against its deadline when it runs, not when it was clicked', async t => {
  const clock = { now: 1_000_000 }, f = setup(t, clock);
  await f.ask('B'); clock.now += 9 * 60_000; await f.ask('A');
  const [a] = await f.runningA();
  const b = f.controller.decide('agent', 'native', 'B', 1);
  assert.equal(f.answer('B'), 'queued');
  clock.now += 2 * 60_000; f.release();
  assert.equal((await a).state, 'complete');
  const result = await b;
  // Settled by the existing expiry path: this handler had asked before its card, so the card reads expired after start.
  assert.equal(result.disposition, 'expired'); assert.equal(result.reason, 'deadline-elapsed');
  assert.deepEqual(f.performed, ['A']);
});
test('clicking the same answer again while it waits or runs is that one answer; a different answer is refused', async t => {
  const f = setup(t); await f.ask('A'); await f.ask('B');
  const [a] = await f.runningA();
  const againA = f.controller.decide('agent', 'native', 'A', 1);
  const b = f.controller.decide('agent', 'native', 'B', 1), againB = f.controller.decide('agent', 'native', 'B', 1);
  await assert.rejects(f.controller.decide('agent', 'native', 'B', 0), error => error.uiMessage?.key === 'error.background.answerPending');
  f.release();
  const results = await Promise.all([a, againA, b, againB]);
  assert.deepEqual(results.map(r => r.state), ['complete', 'complete', 'complete', 'complete']);
  assert.deepEqual(f.performed, ['A', 'B']);
  await assert.rejects(f.controller.decide('agent', 'native', 'B', 1), error => error.uiMessage?.key === 'error.background.cardHandled' && /no longer current/.test(error.message));
  assert.deepEqual(f.performed, ['A', 'B']);
});
test('closing while an answer waits carries nothing out; the card still waits for the person after reopening', async t => {
  const f = setup(t); await f.ask('A'); await f.ask('B');
  const [a] = await f.runningA();
  const b = f.controller.decide('agent', 'native', 'B', 1);
  const closing = f.controller.close(); f.release();
  await a; await assert.rejects(b, /closing/); await closing;
  assert.deepEqual(f.performed, ['A']);
  assert.equal(f.controller.receipt(sender, 'B').state, 'confirmation-required');
  const reopened = new BackgroundControl(f.config); t.after(() => reopened.close());
  assert.equal(reopened.receipt(sender, 'B').state, 'confirmation-required');
});
test('a mobile answer waits in the same queue; its authority is checked again when it runs and its binding is unchanged', async t => {
  const f = setup(t); await f.ask('A'); await f.ask('B'); await f.ask('C');
  const before = f.controller.mobileBinding('agent', 'native', 'B', 1);
  const [a] = await f.runningA();
  let allowed = true, checks = 0;
  const authorize = () => { checks++; if (!allowed) throw Error('This mobile confirmation is no longer current'); };
  const b = f.controller.decide('agent', 'native', 'B', 1, authorize);
  assert.equal(f.answer('B'), 'queued');
  assert.deepEqual(f.controller.mobileBinding('agent', 'native', 'B', 1), before);
  const c = f.controller.decide('agent', 'native', 'C', 1, () => {});
  const atClick = checks; allowed = false; f.release();
  await a; await assert.rejects(b, /mobile confirmation is no longer current/);
  assert.ok(checks > atClick);
  assert.equal((await c).state, 'complete');
  assert.deepEqual(f.performed, ['A', 'C']);
  assert.equal(f.controller.receipt(sender, 'B').state, 'confirmation-required');
});
test('specific reasons replace "no longer current" for a card that is gone, handled or expired', async t => {
  const clock = { now: 1_000_000 }, f = setup(t, clock);
  await assert.rejects(f.controller.decide('agent', 'native', 'missing', 1), error => error.uiMessage?.key === 'error.background.cardGone');
  await f.ask('B'); assert.equal((await f.controller.decide('agent', 'native', 'B', 0)).state, 'cancelled');
  await assert.rejects(f.controller.decide('agent', 'native', 'B', 1), error => error.uiMessage?.key === 'error.background.cardHandled');
  await f.ask('C'); clock.now += 11 * 60_000; f.controller.rows('agent');
  await assert.rejects(f.controller.decide('agent', 'native', 'C', 1), error => error.uiMessage?.key === 'error.background.cardExpired');
  assert.deepEqual(f.performed, []);
});
