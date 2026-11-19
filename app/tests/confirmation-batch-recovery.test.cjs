const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { actor, tick, fixture, render } = require('./fixtures/confirmation-batch-scene.cjs');
async function enteredA(f) {
  for (let n = 0; n < 100 && !f.entered.includes('A'); n++) await tick();
  assert.ok(f.entered.includes('A'), 'The first operation reached its held handler');
}

test('close releases waiting answers without interrupting the current operation', async () => {
  const f = await fixture(); let closing, a, b, c;
  try {
    await f.ask('A'); await f.ask('B'); await f.ask('C');
    assert.ok(f.cards().every(card => card.actionable));
    const expiry = f.cards()[1].expiresAt;
    a = f.control.decide('agent', 'native', 'A', 1); await enteredA(f);
    let bState = 'pending', cState = 'pending';
    b = f.control.decide('agent', 'native', 'B', 1);
    b.then(() => { bState = 'fulfilled'; }, () => { bState = 'rejected'; });
    closing = f.control.close();
    c = f.control.decide('agent', 'native', 'C', 1);
    c.then(() => { cState = 'fulfilled'; }, () => { cState = 'rejected'; });
    for (let n = 0; n < 20; n++) await tick();
    assert.equal(bState, 'rejected'); assert.equal(cState, 'rejected');
    assert.equal(f.control.decisions.size, 1); assert.equal(f.control.decisionTails.size, 0);
    assert.deepEqual(f.entered, ['A']); assert.deepEqual(f.effects, []);
    assert.equal(f.control.receipt(actor, 'B').state, 'confirmation-required');
    assert.equal(f.cards()[1].expiresAt, expiry);
    f.release(); assert.equal((await a).state, 'complete'); await closing;
    assert.deepEqual(f.effects, ['A']);
  } finally {
    f.release(); await Promise.allSettled([a, b, c, closing]); await f.cleanup();
  }
});

test('a failed operation does not poison later answers', async () => {
  const f = await fixture();
  try {
    await f.ask('A'); await f.ask('B');
    const original = f.control.perform.bind(f.control);
    f.control.perform = (actor, args, ...rest) => args.operation_id === 'A'
      ? Promise.reject(Error('Synthetic perform rejection')) : original(actor, args, ...rest);
    const results = await Promise.allSettled([
      f.control.decide('agent', 'native', 'A', 1), f.control.decide('agent', 'native', 'B', 1),
    ]);
    for (let n = 0; n < 5; n++) await tick();
    assert.equal(results[0].status, 'rejected'); assert.equal(results[1].value.state, 'complete');
    assert.deepEqual(f.effects, ['B']);
    assert.equal(f.control.decisions.size, 0); assert.equal(f.control.decisionTails.size, 0);
  } finally { await f.cleanup(); }
});

test('a side effect with an unconfirmed receipt is never void', async () => {
  const f = await fixture(true);
  try {
    await f.ask('A'); await f.ask('B'); f.release();
    await f.control.decide('agent', 'native', 'A', 1);
    const receipt = await f.control.decide('agent', 'native', 'B', 1), cards = f.cards();
    assert.equal(receipt.state, 'unconfirmed'); assert.deepEqual(f.effects, ['A', 'B']);
    assert.ok(cards.at(-1).message.backgroundOperation.error);
    const batch = render(cards, true);
    assert.equal(batch.itemState, 'unconfirmed');
    assert.ok(batch.shown.includes('结果未确认 1 项')); assert.ok(batch.shown.includes('作废 0 项'));
  } finally { await f.cleanup(); }
});

test('merged cards retain the operation error', async () => {
  const f = await fixture(); let a, b;
  try {
    await f.ask('A'); await f.ask('B');
    a = f.control.decide('agent', 'native', 'A', 1); await enteredA(f);
    b = f.control.decide('agent', 'native', 'B', 1);
    f.bump(); f.release(); await a;
    assert.equal((await b).state, 'unconfirmed'); assert.deepEqual(f.effects, ['A']);
    const cards = f.cards(), reason = cards.at(-1).message.backgroundOperation.error;
    assert.ok(reason);
    assert.ok(render(cards, false).shown.includes(reason)); assert.ok(render(cards, true).shown.includes(reason));
  } finally {
    f.release(); await Promise.allSettled([a, b]); await f.cleanup();
  }
});

test('failed enqueue restores still-actionable cards after a fresh read', async () => {
  const f = await fixture();
  try {
    await f.ask('A'); await f.ask('B');
    const scope = render(f.cards(), false).sandbox;
    let calls = 0, toasts = 0;
    scope.api.backgroundDecision = (...args) => { calls++; return f.control.decide(...args); };
    scope.toastError = () => { toasts++; };
    const original = f.control.context;
    f.control.context = async () => { throw Error('Synthetic background view is temporarily unavailable'); };
    f.control.contexts.clear(); f.control.opened.clear();
    await submit(scope);
    f.control.context = original;
    for (let n = 0; n < 5; n++) await tick();
    const fresh = f.cards(); scope.state.backgroundConfirmations = fresh; scope.message = fresh.at(-1).message;
    assert.equal(roleOf(scope).batch.started, false);
    assert.ok(fresh.every(card => card.actionable && card.state === 'confirmation-required' && !card.message.backgroundOperation.answer));
    assert.equal(calls, 2); assert.equal(toasts, 1); assert.deepEqual(f.effects, []);
    assert.equal(f.control.decisions.size, 0);
  } finally { await f.cleanup(); }
});

const roleOf = scope => vm.runInContext('confirmationBatchRole(message.backgroundOperation)', scope);
const submit = scope => vm.runInContext('answerConfirmationBatch(nativeWorkspaceConfirmationBatch.plan(state.backgroundConfirmations)[0], false)', scope);

test('failed enqueue rereads once and restores only unanswered actionable cards', async () => {
  const f = await fixture();
  try {
    await f.ask('A'); await f.ask('B');
    const scope = render(f.cards(), false).sandbox;
    let calls = 0, reads = 0;
    scope.api.backgroundDecision = async () => { calls++; throw Error('Synthetic enqueue failure'); };
    scope.api.initial = async () => { reads++; return { backgroundConfirmationsAvailable: true, backgroundConfirmations: f.cards() }; };
    await submit(scope);
    assert.equal(roleOf(scope).batch.started, false);
    assert.equal(calls, 2); assert.equal(reads, 1);
    assert.deepEqual(f.effects, []);
    await tick(); assert.equal(calls, 2, 'No automatic resend after recovery');
  } finally { await f.cleanup(); }
});

test('unknown enqueue outcome stays locked on stale or unavailable snapshots', async () => {
  const f = await fixture();
  try {
    await f.ask('A'); await f.ask('B');
    const scope = render(f.cards(), false).sandbox;
    let calls = 0;
    scope.api.backgroundDecision = async () => { calls++; throw Error('Synthetic transport failure'); };
    scope.api.initial = async () => { throw Error('Synthetic read failure'); };
    await submit(scope);
    assert.equal(roleOf(scope).batch.started, true, 'The original snapshot cannot prove non-enqueue');
    scope.state.backgroundConfirmationsAvailable = false;
    scope.state.backgroundConfirmations = f.cards();
    assert.equal(roleOf(scope).batch.started, true, 'An unavailable snapshot cannot restore controls');
    scope.state.backgroundConfirmationsAvailable = true;
    scope.state.backgroundConfirmations = f.cards();
    assert.equal(roleOf(scope).batch.started, false);
    assert.equal(calls, 2);
  } finally { await f.cleanup(); }
});

test('partial enqueue failure never unlocks the accepted card or resends it', async () => {
  const f = await fixture();
  try {
    await f.ask('A'); await f.ask('B'); await f.ask('C');
    const scope = render(f.cards(), false).sandbox;
    const fresh = f.cards();
    fresh[0].message.backgroundOperation.answer = 'running'; fresh[0].actionable = false;
    const calls = [];
    scope.api.backgroundDecision = async (_session, _native, id) => {
      calls.push(id);
      if (id !== 'A') throw Error('Synthetic pre-enqueue refusal');
      return { state: 'running' };
    };
    scope.api.initial = async () => ({ backgroundConfirmationsAvailable: true, backgroundConfirmations: fresh });
    await submit(scope);
    scope.state.backgroundConfirmations = fresh;
    scope.message = fresh[0].message;
    assert.equal(roleOf(scope).batch.started, true);
    assert.deepEqual(Array.from(roleOf(scope).batch.cards, c => c.operationId), ['A']);
    scope.message = fresh[2].message;
    assert.equal(roleOf(scope).batch.started, false);
    assert.deepEqual(Array.from(roleOf(scope).batch.cards, c => c.operationId), ['B', 'C']);
    assert.deepEqual(calls, ['A', 'B', 'C']);
  } finally { await f.cleanup(); }
});

test('submission intent is separate from execution and duplicate clicks send once', async () => {
  const f = await fixture(); let release;
  try {
    await f.ask('A'); await f.ask('B');
    const scope = render(f.cards(), false).sandbox;
    const hold = new Promise(resolve => { release = resolve; }); let calls = 0;
    scope.api.backgroundDecision = async () => { calls++; await hold; return { state: 'complete' }; };
    const first = submit(scope), second = submit(scope);
    await tick(); assert.equal(calls, 2);
    assert.equal(roleOf(scope).batch.submitting, true);
    release(); await Promise.all([first, second]);
    assert.equal(roleOf(scope).batch.submitting, false);
    assert.equal(calls, 2);
  } finally { release?.(); await f.cleanup(); }
});

test('merged errors are plain text and error-only updates invalidate the batch render key', async () => {
  const f = await fixture();
  try {
    await f.ask('A'); await f.ask('B'); f.release();
    await f.control.decide('agent', 'native', 'A', 1);
    await f.control.decide('agent', 'native', 'B', 1);
    const cards = f.cards(), scope = render(cards, true).sandbox;
    const op = cards[0].message.backgroundOperation;
    op.state = 'unconfirmed'; op.error = '<img src=x onerror=synthetic()> first';
    vm.runInContext('renderBackgroundControls(entry,message)', scope);
    assert.ok(scope.entry.backgroundControls.textContent.includes(op.error));
    const before = scope.entry.backgroundKey;
    op.error = 'Second synthetic reason';
    vm.runInContext('renderBackgroundControls(entry,message)', scope);
    assert.notEqual(scope.entry.backgroundKey, before);
    assert.ok(scope.entry.backgroundControls.textContent.includes(op.error));
    op.resultNotice = { key: 'background.batch.item.void' };
    vm.runInContext('renderBackgroundControls(entry,message)', scope);
    assert.ok(!scope.entry.backgroundControls.textContent.includes(op.error), 'Server result notice takes precedence');
  } finally { await f.cleanup(); }
});

test('a late read from the failed attempt cannot remove a newer explicit submission', async () => {
  const f = await fixture(); let finishRead, finishSecond;
  const pendingRead = new Promise(resolve => { finishRead = resolve; });
  const pendingSecond = new Promise(resolve => { finishSecond = resolve; });
  let first, second;
  try {
    await f.ask('A'); await f.ask('B');
    const scope = render(f.cards(), false).sandbox;
    let calls = 0;
    scope.api.backgroundDecision = async () => { calls++; throw Error('Synthetic first enqueue failure'); };
    scope.api.initial = () => pendingRead;
    first = submit(scope);
    await tick();
    scope.state.backgroundConfirmations = f.cards();
    assert.equal(roleOf(scope).batch.started, false);
    scope.api.backgroundDecision = async () => { calls++; await pendingSecond; return { state: 'complete' }; };
    second = submit(scope);
    await tick(); assert.equal(calls, 4);
    finishRead({ backgroundConfirmationsAvailable: true, backgroundConfirmations: f.cards() });
    await first;
    assert.equal(roleOf(scope).batch.started, true);
    assert.equal(roleOf(scope).batch.submitting, true);
    finishSecond(); await second;
  } finally {
    finishRead({ backgroundConfirmationsAvailable: false }); finishSecond();
    await Promise.allSettled([first, second]); await f.cleanup();
  }
});
