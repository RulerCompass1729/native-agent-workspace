'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { ButlerInputBoundary, MAX_REQUEST_BYTES } = require('../butler-dsh-input.cjs');
const { ButlerReadBudget, HEADROOM, FEEDBACK } = require('../butler-dsh-read-budget.cjs');
const endpoint = 'https://api.deepseek.com/anthropic/v1/messages';
const result = text => ({ content: [{ type: 'text', text }], isError: false });
function setup(initial = '', count = 1) {
  const boundary = new ButlerInputBoundary(endpoint), budget = new ButlerReadBudget(boundary);
  const prefix = [{ id: 'input', role: 'user', content: [{ type: 'text', text: initial }] }];
  budget.beginStep(prefix);
  const source = { system: 'Fixed policy', messages: [{ role: 'user', content: prefix[0].content }] };
  boundary.wrapFetch(() => {})(endpoint, { method: 'POST', body: JSON.stringify(source) });
  const messages = [...prefix, { id: 'assistant', role: 'assistant', content: Array.from({ length: count }, (_, i) => ({ type: 'tool-call', id: `read-${i}`, name: 'readBusiness', arguments: '{"kind":"queue"}' })) }];
  return { boundary, budget, messages, source, exec: { callId: 'read-0' } };
}
test('a whole page is admitted at reserved boundary; one more byte withholds it without poisoning the batch', () => {
  for (const extra of [0, 1]) {
    const { boundary, budget, exec, messages } = setup('x'.repeat(100000));
    const overhead = budget.preview(exec, messages, result('p')) - 1;
    const page = result('p'.repeat(MAX_REQUEST_BYTES - HEADROOM - overhead + extra)), saved = structuredClone(page);
    const decision = budget.after(exec, page, messages);
    assert.deepEqual(page, saved, 'No record/text truncation'); assert.equal(boundary.failed, null);
    if (extra) {
      assert.equal(decision.kind, 'block'); assert.match(decision.feedback[0].text, /not delivered/);
      assert.equal(budget.before(exec, messages), FEEDBACK);
      assert.deepEqual(budget.summary(), { acceptedResults: 0, withheldResults: 1, skippedReads: 1, exhausted: true });
    } else { assert.equal(decision, null); assert.equal(budget.summary().acceptedResults, 1); }
  }
});
test('preview exactly matches next transmitted text-only request, with escaped content and pending results', () => {
  const { boundary, budget, exec, messages, source } = setup('"\\界', 2);
  const page = result('"\\界'.repeat(8000));
  const preview = budget.preview(exec, messages, page);
  const next = structuredClone(source);
  next.messages.push({ role: 'assistant', content: messages[1].content.map(b => ({ type: 'tool_use', id: b.id, name: b.name, input: JSON.parse(b.arguments) })) },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-0', content: page.content, is_error: false }, { type: 'tool_result', tool_use_id: 'read-1', content: [{ type: 'text', text: FEEDBACK }], is_error: true }] });
  let actual;
  boundary.wrapFetch((_url, init) => { actual = Buffer.byteLength(init.body); })(endpoint, { method: 'POST', body: JSON.stringify(next) });
  assert.equal(preview, actual);
});
test('one assistant with many tool calls reserves a refusal for every pending result', () => {
  const a = setup('', 1), b = setup('', 6);
  assert.ok(b.budget.preview(b.exec, b.messages, result('page')) > a.budget.preview(a.exec, a.messages, result('page')) + 1000);
  assert.equal(b.budget.after(b.exec, result('p'.repeat(100000)), b.messages), null);
  const second = { callId: 'read-1' };
  assert.equal(b.budget.after(second, result('p'.repeat(100000)), b.messages).kind, 'block');
  assert.equal(b.budget.before({ callId: 'read-2' }, b.messages), FEEDBACK);
  b.budget.reset(); assert.deepEqual(b.budget.summary(), { acceptedResults: 0, withheldResults: 0, skippedReads: 0, exhausted: false });
});
test('deferred contexts count and old hard tool limits still latch before any replacement', () => {
  const a = setup('x'.repeat(100000));
  const page = { ...result('p'.repeat(50000)), additionalContexts: [{ role: 'user', content: [{ type: 'text', text: '"'.repeat(30000) }] }] };
  assert.equal(a.budget.after(a.exec, page, a.messages).kind, 'block'); assert.equal(a.boundary.failed, null);
  const b = setup(); assert.throws(() => b.budget.after(b.exec, result('x'.repeat(150000)), b.messages), { code: 'input-boundary' });
  assert.equal(b.boundary.failed, 'input-boundary');
});
test('a changed session prefix or unsupported content refuses instead of trusting a byte guess', () => {
  for (const alter of [m => { m[0].id = 'replacement'; }, m => { m[1].content.push({ type: 'reasoning', text: 'unqualified' }); }]) {
    const x = setup(); alter(x.messages);
    assert.throws(() => x.budget.after(x.exec, result('page'), x.messages), { code: 'input-boundary' });
  }
});
