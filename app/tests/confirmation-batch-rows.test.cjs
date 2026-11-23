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
