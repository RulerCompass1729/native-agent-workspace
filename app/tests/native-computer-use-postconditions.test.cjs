const test = require('node:test');
const assert = require('node:assert/strict');
const { createComputerUseGate, scopedTools } = require('../native-computer-use.cjs');

const observe = { name: 'inspect_ui', arguments: { app_target: 'PID:123', window_id: 456, fresh: true, include_elements: true } };
function capture(snapshot, { value = '', focused = true, opened = false } = {}) {
  return { isError: false, content: [{ type: 'text', text: 'Owned synthetic controls' }], _meta: {
    snapshot_id: snapshot, used_cache: false,
    target_receipt: { pid: 123, window_id: 456, process_start_identity_decimal: '1700000000123456' },
    focused_element: focused ? { processIdentifier: 123, windowID: 456, role: 'AXTextField', frame: [[10, 20], [100, 30]] } : null,
    ui_elements: [
      { id: 'button', ax_role: 'AXButton', label: 'Open owned dialog', is_actionable: true, is_enabled: true },
      { id: 'field', ax_role: 'AXTextField', label: 'Owned field', value, bounds: { x: 10, y: 20, width: 100, height: 30 }, is_actionable: true, is_enabled: true, is_value_settable: true },
      ...(opened ? [{ id: 'dialog', ax_role: 'AXButton', label: 'Cancel owned dialog', is_actionable: true, is_enabled: true }] : []),
    ],
  } };
}
// The actual secretary receipt has success:true but explicitly says only
// dispatched_unverified. An ACK is not a page, focus or literal-text proof.
const accepted = { isError: false, content: [{ type: 'text', text: 'Clicked successfully' }], _meta: {
  state: 'dispatched_unverified', dispatch_state: 'dispatched', mutation_dispatched: true,
  effect: 'unverifiable', requires_fresh_observation: true, retry_safe: false,
} };
const click = { name: 'click', arguments: { snapshot: 'before', on: 'button', expect: { label: 'Cancel owned dialog' } } };
const type = { name: 'type', arguments: { snapshot: 'before', on: 'field', text: 'hello world', clear: true } };
async function trial(request, after, before = capture('before'), mutationResult = accepted) {
  let reads = 0, actions = 0;
  const calls = [], gate = createComputerUseGate({ identity: pid => ({ pid, started: 'original' }) });
  const invoke = async params => {
    calls.push(params);
    if (params.name === 'inspect_ui') return ++reads === 1 ? before : after;
    actions++; return mutationResult;
  };
  await gate(observe, invoke);
  return { result: await gate(request, invoke), gate, invoke, calls, counts: () => ({ reads, actions }) };
}
test('a successful dispatch with unchanged actual page is an error, never clicked successfully', async () => {
  const t = await trial(click, capture('after'));
  assert.equal(t.result.isError, true);
  assert.equal(t.result.structuredContent.outcome, 'dispatched_unverified');
  assert.equal(t.result.structuredContent.retrySafe, false);
  assert.ok(!JSON.stringify(t.result.content).includes('Clicked successfully'));
  const result = await t.gate(observe, t.invoke);
  assert.equal(result.isError, false);
  assert.equal(result._meta.naw_input_blocked, true);
  await assert.rejects(t.gate({ ...click, arguments: { ...click.arguments, snapshot: 'after' } }, t.invoke), /completion unknown/);
  assert.deepEqual(t.counts(), { reads: 3, actions: 1 });
});
test('only a fresh exact-window expected page fact verifies the postcondition, not transport delivery', async () => {
  const t = await trial(click, capture('after', { opened: true }));
  assert.equal(t.result.isError, false);
  assert.equal(t.result.structuredContent.outcome, 'postcondition_observed');
  assert.equal(t.result.structuredContent.dispatchState, 'dispatched');
  assert.equal(t.result.structuredContent.deliveryVerified, false);
  assert.deepEqual(t.calls[2], observe, 'one read-only AX observation, no screenshot/focus/retry');
  await assert.rejects(t.gate(click, t.invoke), /fresh exact NAW snapshot/);
});
test('literal spaces and complete text must match actual field readback', async () => {
  for (const value of ['', 'helloworld', 'hello']) {
    const t = await trial(type, capture('after', { value }));
    assert.equal(t.result.isError, true, value);
    assert.deepEqual(t.counts(), { reads: 2, actions: 1 });
  }
  const t = await trial(type, capture('after', { value: 'hello world' }));
  assert.equal(t.result.isError, false);
  assert.equal(t.result.structuredContent.outcome, 'postcondition_observed');
});
test('typing refuses a field without actual focus before dispatch', async () => {
  await assert.rejects(trial(type, capture('after'), capture('before', { focused: false })), /focused/);
});
test('matching text in an unfocused field is not a focus or completed-input proof', async () => {
  const t = await trial(type, capture('after', { value: 'hello world', focused: false }));
  assert.equal(t.result.isError, true);
});
test('a click can verify focus on its exact settable field', async () => {
  const request = { name: 'click', arguments: { snapshot: 'before', on: 'field', expect: { focused: true } } };
  const t = await trial(request, capture('after'), capture('before', { focused: false }));
  assert.equal(t.result.isError, false);
});
test('missing, cached, reused-snapshot or wrong-window post-observation cannot verify an action', async () => {
  for (const corrupt of [r => { delete r._meta.snapshot_id; }, r => { r._meta.used_cache = true; },
    r => { r._meta.snapshot_id = 'before'; }, r => { r._meta.target_receipt.window_id = 999; },
    r => { r._meta.target_receipt.process_start_identity_decimal = '1700000000999999'; },
    r => { r._meta.ui_elements.forEach(e => { e.is_actionable = false; }); }]) {
    const after = capture('after', { opened: true }); corrupt(after);
    assert.equal((await trial(click, after)).result.isError, true);
  }
});
test('click requires a bounded explicit page/focus postcondition before dispatch', async () => {
  const gate = createComputerUseGate({ identity: pid => ({ pid, started: 'original' }) }); let actions = 0;
  const invoke = async p => p.name === 'inspect_ui' ? capture('before') : (actions++, accepted);
  for (const expect of [undefined, {}, { label: '' }, { label: 'x', focused: true }, { label: 'x', code: 'no' }]) {
    await gate(observe, invoke);
    await assert.rejects(gate({ name: 'click', arguments: { snapshot: 'before', on: 'button', expect } }, invoke), /postcondition/);
  }
  assert.equal(actions, 0);
});
test('successful shell-only AX output without a snapshot is not an actionable observation', async () => {
  const gate = createComputerUseGate({ identity: pid => ({ pid, started: 'original' }) });
  await assert.rejects(gate(observe, async () => ({ content: [{ type: 'text', text: '7 shell elements' }], _meta: { snapshot_id: null } })), /[Oo]bservation/);
});
test('the model-visible click schema carries the page/focus postcondition', () => {
  const tools = scopedTools({ tools: ['see','inspect_ui','click','type'].map(name => ({ name, inputSchema: { properties: {} } })) });
  assert.ok(tools.tools.find(t => t.name === 'click').inputSchema.required.includes('expect'));
});
test('an unchanged sidebar label already present before clicking cannot prove navigation', async () => {
  const request = { name: 'click', arguments: { snapshot: 'before', on: 'button', expect: { label: 'Open owned dialog' } } };
  await assert.rejects(trial(request, capture('after')), /already|new page/);
});
test('matching text and focus on another identically labelled field cannot prove the original target', async () => {
  const after = capture('after', { value: 'hello world' });
  after._meta.ui_elements[1].bounds.x = 500; after._meta.focused_element.frame[0][0] = 500;
  assert.equal((await trial(type, after)).result.isError, true);
});
test('error-marked or malformed observation success flags never mint input authority', async () => {
  for (const isError of [true, undefined, null, 0, 'false']) {
    const gate = createComputerUseGate({ identity: pid => ({ pid, started: 'original' }) }); let mutations = 0;
    await gate(observe, async () => capture('before'));
    const bad = capture('before');
    if (isError === undefined) delete bad.isError; else bad.isError = isError;
    try { const result = await gate(observe, async () => bad); assert.equal(result.isError, true); } catch (error) { assert.match(error.message, /[Oo]bservation/); }
    await assert.rejects(gate(type, async () => { mutations++; return accepted; }), /fresh exact NAW snapshot/);
    assert.equal(mutations, 0);
  }
});
test('post-action snapshots also require an explicit protocol success flag', async () => {
  for (const isError of [true, undefined, null, 0, 'false']) {
    const after = capture('after', { opened: true });
    if (isError === undefined) delete after.isError; else after.isError = isError;
    assert.equal((await trial(click, after)).result.isError, true);
  }
});

// The qualified bridge reports an accepted AXPress without an effect proof as
// isError:true. That is not delivery proof, and it is not a reason to retry.
function unverifiedClick() {
  return { isError: true, _meta: { state: 'dispatched_unverified', effect: 'unverifiable', dispatch_state: 'dispatched',
    mutation_dispatched: true, dispatched_unit_count: 1, retry_safe: false, requires_fresh_observation: true,
    delivery_mode: 'background', delivery_mechanism: 'accessibility_action',
    target_receipt: { pid: 123, window_id: 456, process_start_identity_decimal: '1700000000123456' },
    target_identity: { kind: 'window', pid: 123, window_id: 456, process_start_identity_decimal: '1700000000123456' } } };
}
test('one unverified exact background AX click can be checked by a new page fact without resending', async () => {
  const t = await trial(click, capture('after', { opened: true }), capture('before'), unverifiedClick());
  assert.equal(t.result.isError, false);
  assert.equal(t.result.structuredContent.outcome, 'postcondition_observed');
  assert.equal(t.result.structuredContent.deliveryVerified, false);
  assert.equal(t.result.structuredContent.retrySafe, false);
  assert.deepEqual(t.counts(), { reads: 2, actions: 1 });
});
test('an unverified click without the new page fact stays unknown and never retries', async () => {
  const t = await trial(click, capture('after'), capture('before'), unverifiedClick());
  assert.equal(t.result.isError, true);
  assert.deepEqual(t.counts(), { reads: 2, actions: 1 });
  await assert.rejects(t.gate(click, t.invoke), /completion unknown/);
});
test('foreign, partial, foreground or malformed bridge-error receipts cannot enter the postcondition path', async () => {
  for (const change of [r => { r._meta.target_receipt.pid = 999; }, r => { r._meta.target_identity.window_id = 999; },
    r => { r._meta.target_receipt.process_start_identity_decimal = '1700000000999999'; }, r => { r._meta.dispatched_unit_count = 2; },
    r => { r._meta.delivery_mode = 'foreground'; }, r => { r._meta.mutation_dispatched = false; }, r => { delete r._meta.target_identity; }]) {
    const output = unverifiedClick(); change(output);
    const t = await trial(click, capture('after', { opened: true }), capture('before'), output);
    assert.equal(t.result.isError, true); assert.deepEqual(t.counts(), { reads: 1, actions: 1 });
  }
});
test('an error-marked or wrong-window post-read cannot confirm a dispatched-unverified click', async () => {
  for (const change of [r => { r.isError = true; }, r => { r._meta.target_receipt.window_id = 999; }, r => { r._meta.used_cache = true; }]) {
    const after = capture('after', { opened: true }); change(after);
    const t = await trial(click, after, capture('before'), unverifiedClick());
    assert.equal(t.result.isError, true); assert.deepEqual(t.counts(), { reads: 2, actions: 1 });
  }
});
test('bridge errors during typing retain the original locked behavior', async () => {
  const t = await trial(type, capture('after', { value: 'hello world' }), capture('before'), unverifiedClick());
  assert.equal(t.result.isError, true); assert.deepEqual(t.counts(), { reads: 1, actions: 1 });
});
