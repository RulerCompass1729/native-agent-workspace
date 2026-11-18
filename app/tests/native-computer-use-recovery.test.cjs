const test = require('node:test');
const assert = require('node:assert/strict');
const { createComputerUseGate, scopedTools, computerUseEnvironment } = require('../native-computer-use.cjs');

const observe = { name: 'inspect_ui', arguments: { app_target: 'PID:123', window_id: 456, fresh: true, include_elements: true } };
const accepted = { isError: false, _meta: { mutation_dispatched: true, dispatch_state: 'dispatched' } };
function fixture(prefix = '') {
  let clock = 1000, started = 'original', reads = 0, actions = 0, opened = false, value = '';
  const calls = [], gate = createComputerUseGate({ identity: pid => ({ pid, started }), now: () => clock });
  const invoke = async params => {
    calls.push(params);
    if (['see', 'inspect_ui'].includes(params.name)) return { isError: false, content: [{ type: 'text', text: 'Synthetic owned controls' }], _meta: {
      snapshot_id: prefix + 'snapshot-' + ++reads, used_cache: false,
      target_receipt: { pid: 123, window_id: params.arguments.window_id, process_start_identity_decimal: '1700000000123456' },
      focused_element: { processIdentifier: 123, windowID: 456, role: 'AXTextField', frame: [[10, 20], [100, 30]] },
      ui_elements: [
        { id: 'button', ax_role: 'AXButton', label: 'Open dialog', is_actionable: true, is_enabled: true },
        { id: 'field', ax_role: 'AXTextField', label: 'Owned field', value, is_actionable: true, is_enabled: true, is_value_settable: true, bounds: { x: 10, y: 20, width: 100, height: 30 } },
        ...(opened ? [{ id: 'cancel', ax_role: 'AXButton', label: 'Cancel dialog', is_actionable: true, is_enabled: true }] : []),
      ],
    } };
    actions++;
    if (params.name === 'type') value = params.arguments.text;
    return accepted;
  };
  const click = snapshot => ({ name: 'click', arguments: { snapshot, on: 'button', expect: { label: 'Cancel dialog' } } });
  const recover = snapshot => ({ name: 'recover_input', arguments: { app_target: 'PID:123', window_id: 456, snapshot, acknowledge_unknown: true } });
  const read = async (change, request = observe) => gate(request, async p => { const result = await invoke(p); change?.(result); return result; });
  return { gate, invoke, click, recover, read, calls,
    async lock() { const before = await read(); const result = await gate(click(before._meta.snapshot_id), invoke); assert.equal(result.isError, true); },
    async acknowledge() { const readback = await read(); return gate(recover(readback._meta.snapshot_id), invoke); },
    clock: n => { clock = n; }, started: s => { started = s; }, open: () => { opened = true; },
    counts: () => ({ reads, actions }),
  };
}

test('the local recovery tool is explicit; the pinned upstream catalog and environment still allow only four tools', () => {
  const upstream = { tools: ['see', 'inspect_ui', 'click', 'type'].map(name => ({ name, inputSchema: { properties: {} } })) };
  const tools = scopedTools(upstream).tools, recovery = tools.find(t => t.name === 'recover_input');
  assert.ok(recovery);
  assert.equal(recovery.inputSchema.additionalProperties, false);
  assert.equal(recovery.inputSchema.properties.acknowledge_unknown.const, true);
  assert.deepEqual(recovery.inputSchema.required, ['app_target', 'window_id', 'snapshot', 'acknowledge_unknown']);
  assert.equal(upstream.tools.length, 4);
  assert.equal(computerUseEnvironment({}).PEEKABOO_ALLOW_TOOLS, 'see,inspect_ui,click,type');
  assert.throws(() => scopedTools({ tools: [...upstream.tools, recovery] }), /catalog changed/);
});

test('post-lock observation stays read-only; explicit recovery permits a later fresh click without retrying the unknown action', async () => {
  const h = fixture(); await h.lock();
  const readback = await h.read(), snapshot = readback._meta.snapshot_id;
  assert.equal(readback._meta.naw_input_blocked, true);
  await assert.rejects(h.gate(h.click(snapshot), h.invoke), /completion unknown/);
  const calls = h.calls.length, result = await h.gate(h.recover(snapshot), h.invoke);
  assert.equal(h.calls.length, calls, 'acknowledgement is local, never forwarded to the desktop');
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.previousAction, 'unconfirmed');
  assert.equal(result.structuredContent.retrySafe, false);
  assert.match(JSON.stringify(result.content), /Do not retry/);
  await assert.rejects(h.gate(h.click(snapshot), h.invoke), /fresh exact NAW snapshot/);
  const next = await h.read(); h.open();
  assert.equal((await h.gate(h.click(next._meta.snapshot_id), h.invoke)).isError, false);
  assert.equal(h.counts().actions, 2, 'one original action, one separately observed later action, no recovery dispatch');
});

test('typing also recovers only with a new focused-field snapshot and original literal-text verification', async () => {
  const h = fixture(); await h.lock(); await h.acknowledge(); const next = await h.read();
  const result = await h.gate({ name: 'type', arguments: { snapshot: next._meta.snapshot_id, on: 'field', text: 'synthetic text', clear: true } }, h.invoke);
  assert.equal(result.isError, false); assert.equal(result.structuredContent.postcondition, 'text_and_focus');
});

test('confirmation without any observation after the lock is refused locally', async () => {
  const h = fixture(); await h.lock(); const calls = h.calls.length;
  await assert.rejects(h.gate(h.recover('snapshot-1'), h.invoke), /Recovery requires/);
  assert.equal(h.calls.length, calls);
});

test('recovery without an unknown input is refused', async () => {
  const h = fixture(); const result = await h.read();
  await assert.rejects(h.gate(h.recover(result._meta.snapshot_id), h.invoke), /No input recovery/);
});

test('missing acknowledgement, extra arguments, foreign snapshots and wrong windows cannot clear the lock', async () => {
  for (const change of [a => { delete a.acknowledge_unknown; }, a => { a.acknowledge_unknown = false; },
    a => { a.force = true; }, a => { a.snapshot = 'foreign'; }, a => { a.window_id = 999; }, a => { a.app_target = 'PID:999'; }]) {
    const h = fixture(); await h.lock(); const r = await h.read(), request = h.recover(r._meta.snapshot_id); change(request.arguments);
    await assert.rejects(h.gate(request, h.invoke), /Recovery requires/);
    await assert.rejects(h.gate(h.click(r._meta.snapshot_id), h.invoke), /completion unknown/);
    assert.equal(h.counts().actions, 1);
  }
});

test('expired, backward-clock or restarted-process recovery observations are refused', async () => {
  for (const change of [h => h.clock(61001), h => h.clock(999), h => h.started('replacement')]) {
    const h = fixture(); await h.lock(); const r = await h.read(); change(h);
    await assert.rejects(h.gate(h.recover(r._meta.snapshot_id), h.invoke), /Recovery requires/);
    assert.equal(h.counts().actions, 1);
  }
});

test('cached, reused, wrong-window, malformed-generation and error observations never qualify for recovery', async () => {
  for (const change of [r => { r._meta.used_cache = true; }, r => { r._meta.snapshot_id = 'snapshot-1'; },
    r => { r._meta.snapshot_id = 'snapshot-2'; }, r => { r._meta.target_receipt.window_id = 999; },
    r => { r._meta.target_receipt.process_start_identity_decimal = '1700000000999999'; },
    r => { delete r._meta.target_receipt; }, r => { r.isError = true; }]) {
    const h = fixture(); await h.lock(); let r;
    try { r = await h.read(change); } catch { /* Refusal itself grants nothing. */ }
    await assert.rejects(h.gate(h.recover(r?._meta?.snapshot_id || 'snapshot-3'), h.invoke), /Recovery requires/);
  }
});

test('a successful observation of another exact window cannot acknowledge the original unknown input', async () => {
  const h = fixture(); await h.lock();
  const other = await h.read(null, { ...observe, arguments: { ...observe.arguments, window_id: 999 } });
  await assert.rejects(h.gate({ name: 'recover_input', arguments: { ...h.recover(other._meta.snapshot_id).arguments, window_id: 999 } }, h.invoke), /Recovery requires/);
});

test('a failed subsequent observation invalidates an older recovery receipt', async () => {
  const h = fixture(); await h.lock(); const r = await h.read();
  await h.read(x => { x.isError = true; });
  await assert.rejects(h.gate(h.recover(r._meta.snapshot_id), h.invoke), /Recovery requires/);
});

test('fresh pixel see can qualify with an exact receipt even when AX has no actionable rows', async () => {
  const h = fixture(); await h.lock();
  const r = await h.read(x => { x.content = [{ type: 'image', mimeType: 'image/png', data: 'synthetic' }]; x._meta.ui_elements = []; }, { name: 'see', arguments: { app_target: 'PID:123', window_id: 456, fresh: true } });
  assert.equal((await h.gate(h.recover(r._meta.snapshot_id), h.invoke)).isError, false);
});

test('after acknowledgement a cached or reused recovery snapshot cannot grant the first input', async () => {
  for (const change of [r => { r._meta.used_cache = true; }, r => { r._meta.snapshot_id = 'snapshot-3'; }]) {
    const h = fixture(); await h.lock(); await h.acknowledge();
    await assert.rejects(h.read(change), /fresh exact NAW snapshot|qualified exact-window receipt/);
    await assert.rejects(h.gate(h.click('snapshot-3'), h.invoke), /fresh exact NAW snapshot/);
    assert.equal(h.counts().actions, 1);
  }
});

test('recovery cannot race an in-flight observation', async () => {
  const h = fixture(); await h.lock(); let finish;
  const pending = h.gate(observe, async p => { const result = await h.invoke(p); await new Promise(resolve => { finish = resolve; }); return result; });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(h.gate(h.recover('snapshot-3'), h.invoke), /in flight/);
  finish(); const result = await pending;
  assert.equal((await h.gate(h.recover(result._meta.snapshot_id), h.invoke)).isError, false);
});

test('recovery receipts belong to one client and cannot be reused after a second unknown action', async () => {
  const a = fixture('a-'), b = fixture('b-'); await a.lock(); await b.lock(); const ar = await a.read(); await b.read();
  await assert.rejects(b.gate(b.recover(ar._meta.snapshot_id), b.invoke), /Recovery requires/);
  await a.gate(a.recover(ar._meta.snapshot_id), a.invoke);
  const next = await a.read(); assert.equal((await a.gate(a.click(next._meta.snapshot_id), a.invoke)).isError, true);
  await assert.rejects(a.gate(a.recover(ar._meta.snapshot_id), a.invoke), /Recovery requires/);
});

test('transport timeout, uncertain bridge error and missing post-observation all use the same explicit recovery', async () => {
  for (const mode of ['timeout', 'error', 'post-observation']) {
    const h = fixture(); const before = await h.read(); let inputs = 0;
    const uncertain = async p => {
      if (p.name === 'inspect_ui') throw Error('Synthetic observation unavailable');
      inputs++;
      if (mode === 'timeout') throw Error('Synthetic transport timeout');
      return mode === 'error' ? { isError: true, _meta: { mutation_dispatched: true } } : accepted;
    };
    try { await h.gate(h.click(before._meta.snapshot_id), uncertain); } catch (error) { assert.match(error.message, /transport timeout/); }
    await assert.rejects(h.gate(h.click(before._meta.snapshot_id), h.invoke), /completion unknown/);
    assert.equal((await h.acknowledge()).isError, false);
    assert.equal(inputs, 1, 'recovery never replays the uncertain mutation');
  }
});
