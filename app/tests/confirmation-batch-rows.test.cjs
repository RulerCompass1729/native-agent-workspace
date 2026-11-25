const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const { actor, tick, fixture, render } = require('./fixtures/confirmation-batch-scene.cjs');
const all = el => [el, ...el.children.filter(c => typeof c !== 'string').flatMap(all)];
const find = (el, cls) => all(el).filter(c => String(c.className).split(' ').includes(cls));
const detailOf = d => d.children.find(c => c.tag === 'pre')?.textContent;
let time = 0;
function inputCard(id, target, extra = {}, op = {}) {
  const summary = { action: 'input', method: 'input', target, risks: [] };
  const detail = JSON.stringify({ method: 'input', arguments: [target, 'Synthetic words for ' + target] }, null, 2);
  const backgroundOperation = { id, sessionId: 'agent', nativeId: 'native', state: 'confirmation-required', summary, expiresAt: 5000000,
    arguments: JSON.stringify([target, 'Synthetic words for ' + target], null, 2),
    confirmation: { kind: 'message', options: { message: 'Input?', detail, buttons: ['Cancel', 'Confirm'], cancelId: 0 } }, ...op };
  return { key: 'agent:native:' + id, operationId: id, sessionId: 'agent', nativeId: 'native', time: ++time, state: 'confirmation-required',
    actionable: true, expiresAt: backgroundOperation.expiresAt, summary, message: { backgroundOperation }, ...extra };
}
test('every merged row opens to the same full text its single card shows', () => {
  const cards = [inputCard('a', 'Target A'), inputCard('b', 'Target B')];
  const merged = render(cards).sandbox.entry.backgroundControls, rows = find(merged, 'background-batch-details');
  assert.equal(rows.length, 2);
  for (const [index, card] of cards.entries()) {
    const single = render([card]).sandbox.entry.backgroundControls, own = find(single, 'background-details');
    assert.equal(own.length, 1);
    assert.equal(detailOf(rows[index]), detailOf(own[0]));
    assert.equal(detailOf(rows[index]), card.message.backgroundOperation.confirmation.options.detail);
    assert.match(find(rows[index], 'background-batch-summary')[0].textContent, new RegExp(card.summary.target));
  }
});
test('rows stay expandable while running and after the result, with the single card text for that state', () => {
  const startedAt = Date.now() - 4000;
  const cards = [inputCard('a', 'Target A', { state: 'complete', actionable: false }, { state: 'complete' }),
    inputCard('b', 'Target B', { state: 'running', actionable: false }, { state: 'running', startedAt })];
  const shown = render(cards, true).sandbox.entry.backgroundControls, rows = find(shown, 'background-batch-details');
  assert.equal(rows.length, 2);
  for (const [index, card] of cards.entries())
    assert.equal(detailOf(rows[index]), detailOf(find(render([card]).sandbox.entry.backgroundControls, 'background-details')[0]));
});
test('rows show their own deadline only when the deadlines differ; the card keeps the soonest', () => {
  const same = render([inputCard('a', 'Target A'), inputCard('b', 'Target B')]).sandbox.entry.backgroundControls;
  assert.equal(find(same, 'background-batch-remaining').length, 0);
  const cards = [inputCard('a', 'Target A', { expiresAt: 4000000 }), inputCard('b', 'Target B', { expiresAt: 4600000 })];
  const differ = render(cards).sandbox.entry.backgroundControls, own = find(differ, 'background-batch-remaining');
  assert.deepEqual(own.map(el => el.dataset.expiresAt), ['4000000', '4600000']);
  assert.equal(find(differ, 'background-state')[0].dataset.expiresAt, '4000000');
});
test('confirm all runs merged input cards one at a time, each with its own receipt', async () => {
  const f = await fixture(); let submit;
  try {
    await f.askInput('in-1', 'A', 'first synthetic line'); await f.askInput('in-2', 'B', 'second synthetic line');
    const cards = f.cards(), scope = render(cards).sandbox;
    assert.equal(vm.runInContext('nativeWorkspaceConfirmationBatch.plan(state.backgroundConfirmations).length', scope), 1);
    scope.api.backgroundDecision = (session, native, id, response) => f.control.decide(session, native, id, response);
    scope.api.initial = async () => ({ backgroundConfirmations: f.cards() });
    submit = vm.runInContext('answerConfirmationBatch(nativeWorkspaceConfirmationBatch.plan(state.backgroundConfirmations)[0], false)', scope);
    for (let n = 0; n < 100 && !f.entered.includes('A'); n++) await tick();
    assert.deepEqual(f.entered, ['A'], 'the second input waits while the first runs');
    f.release(); await submit;
    assert.deepEqual(f.effects, ['A:first synthetic line', 'B:second synthetic line']);
    const receipts = ['in-1', 'in-2'].map(id => f.control.receipt(actor, id));
    assert.deepEqual(receipts.map(r => [r.id, r.state]), [['in-1', 'complete'], ['in-2', 'complete']]);
    assert.ok(receipts[0].humanDecisionAt <= receipts[1].humanDecisionAt);
  } finally { f.release(); await Promise.allSettled([submit]); await f.cleanup(); }
});
test('merged stop cards say once that work stops, and one confirm gives every session its own receipt', async () => {
  const f = await fixture(); let submit;
  try {
    for (const id of ['A', 'D', 'B', 'E']) await f.askStop(id);
    const cards = f.cards(), page = render(cards), scope = page.sandbox, box = scope.entry.backgroundControls;
    const batches = vm.runInContext('nativeWorkspaceConfirmationBatch.plan(state.backgroundConfirmations)', scope);
    assert.deepEqual(Array.from(batches, b => Array.from(b.cards, c => c.operationId)), [['stop-A', 'stop-B'], ['stop-D', 'stop-E']]);
    assert.match(page.shown, /断开 Codex 会话 · 2 项/);
    assert.equal(find(box, 'background-risk').length, 1);
    assert.equal(find(box, 'background-risk')[0].textContent, '会停下正在进行的工作');
    assert.deepEqual(find(box, 'background-batch-details').map(detailOf), ['What disconnecting does', 'What disconnecting does']);
    scope.api.backgroundDecision = (session, native, id, response) => f.control.decide(session, native, id, response);
    scope.api.initial = async () => ({ backgroundConfirmations: f.cards() });
    submit = vm.runInContext('answerConfirmationBatch(nativeWorkspaceConfirmationBatch.plan(state.backgroundConfirmations)[0], false)', scope);
    await submit;
    assert.deepEqual(f.effects, ['stop:A', 'stop:B']);
    assert.deepEqual(['stop-A', 'stop-B', 'stop-D', 'stop-E'].map(id => f.control.receipt(actor, id).state),
      ['complete', 'complete', 'confirmation-required', 'confirmation-required'], 'the other batch still waits');
  } finally { f.release(); await Promise.allSettled([submit]); await f.cleanup(); }
});
test('a card its batch answers is one line with a way there: no waiting badge, no details, nothing to answer with', () => {
  const cards = [inputCard('a', 'Target A'), inputCard('b', 'Target B')], page = render(cards), scope = page.sandbox;
  const toggles = {}, entry = { item: { classList: { toggle: (name, on) => { toggles[name] = on; } } }, actions: { before() {} } };
  scope.entry = entry; scope.message = cards[1].message;
  vm.runInContext('renderBackgroundControls(entry,message)', scope);
  const box = entry.backgroundControls;
  assert.equal(toggles['background-card'], false);
  assert.equal(box.className, 'background-operation background-merged');
  assert.match(box.textContent, /Target B.*已并入「全部确认（2）」/);
  const go = all(box).filter(el => el.tag === 'button');
  assert.deepEqual(go.map(el => el.textContent), ['去确认']);
  assert.match(go[0].computed['aria-label'], /^去确认：.*Target B/, 'each line\'s button is named by its own card');
  assert.deepEqual([find(box, 'background-state'), find(box, 'background-details'), find(box, 'background-buttons')], [[], [], []]);
  // What the merged card does not say about this one stays here.
  delete entry.backgroundKey; entry.backgroundControls = null; cards[1].message.backgroundOperation.deliveryBlocked = 'temporarily-unavailable';
  vm.runInContext('renderBackgroundControls(entry,message)', scope);
  assert.equal(find(entry.backgroundControls, 'is-warning').length, 1);
  // Once the batch is answered each card tells its own state again.
  const started = render(cards, true); started.sandbox.entry = entry; started.sandbox.message = cards[1].message;
  delete entry.backgroundKey; entry.backgroundControls = null;
  vm.runInContext('renderBackgroundControls(entry,message)', started.sandbox);
  assert.equal(toggles['background-card'], true);
  assert.equal(find(entry.backgroundControls, 'background-state').length, 1);
});
