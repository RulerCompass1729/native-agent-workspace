const test = require('node:test');
const assert = require('node:assert/strict');
const { openOutbox } = require('../computer-use-outbox.cjs');

const grant = { callerId: 'sender', callerNativeId: 'native-sender', spaceId: 'shared',
  recipientId: 'recipient', recipientName: 'Recipient', nativeId: 'native-recipient',
  memberRevision: 1, text: 'Read the current task and run the assigned command' };
const command = { kind: 'commandExecution', id: 'command-1', command: 'git status --short', inputTag: 'message-1', turnId: 'turn-1' };
const nativeReceipt = extra => ({ messageId: 'message-1', recipientId: grant.recipientId,
  nativeId: grant.nativeId, source: 'codex-native', inputTag: 'message-1', turnId: 'turn-1', nativeReceived: true, ...extra });
async function fixture(t, options = {}) {
  const facts = { ...grant, callerValid: true, owner: 'owned-outbox', selected: 'room', surface: 'records',
    body: grant.text, ready: true, revision: '1' };
  let send, update, closed = false;
  const calls = { forward: [], watch: [], unsubscribe: 0, close: 0, rendered: [] };
  const view = { owner: facts.owner, inspect: async () => ({ ...facts }), target: async () => null,
    invoke: async () => { throw Error('This source test does not run a browser'); },
    showReceipt(value) { if (closed) throw Error('View already closed'); calls.rendered.push(value); },
    async close() { closed = true; calls.close++; } };
  let model;
  const outbox = await openOutbox({ ...grant, privateChat: 'DO_NOT_EXPOSE', terminal: 'DO_NOT_EXPOSE', ...options.grant }, {
    createView: async (projection, actions) => { model = projection; send = actions.send; return view; },
    forwardOnce: async value => { calls.forward.push(value); return options.forward ? options.forward(value) : 'message-1'; },
    watchReceipt: async (scope, listener) => {
      calls.watch.push(scope); update = listener;
      if (options.initial) listener(options.initial);
      return options.watch ? options.watch(scope, listener) : () => { calls.unsubscribe++; };
    },
  });
  t.after(() => outbox.close());
  return { outbox, facts, calls, view, model, send: () => send(), update: value => update(value) };
}
test('the new renderer receives only this recipient/body, never caller credentials or other surfaces', async t => {
  const f = await fixture(t);
  assert.deepEqual(Object.keys(f.model).sort(), ['recipient', 'requestId', 'spaceId', 'text']);
  assert.deepEqual(f.model.recipient, { id: grant.recipientId, label: 'Recipient' });
  assert.ok(!JSON.stringify(f.model).includes('DO_NOT_EXPOSE'));
  assert.equal(f.outbox.receipt().status, 'draft');
});
test('one approved multiline task retains tabs and boundary whitespace', async t => {
  const text = '  One task\n\twith exact context.  ';
  const f = await fixture(t, { grant: { text } }); f.facts.body = text;
  assert.equal(f.model.text, text); await f.send();
  assert.equal(f.calls.forward[0].text, text); assert.equal(f.outbox.receipt().text, text);
});
test('a forward ACK is unconfirmed; timeout retains the body and a second send is refused', async t => {
  const f = await fixture(t);
  assert.equal((await f.send()).status, 'delivery-unconfirmed');
  const value = await f.outbox.wait({ timeoutMs: 1 });
  assert.equal(value.status, 'unconfirmed'); assert.equal(value.nativeReceived, false);
  assert.equal(value.text, grant.text); assert.equal(value.retry, false);
  await assert.rejects(f.send()); assert.equal(f.calls.forward.length, 1);
});
test('only native receive and the same input/turn first command complete the receipt', async t => {
  const f = await fixture(t, { initial: nativeReceipt({ firstCommand: command, privateChat: 'DO_NOT_EXPOSE' }) });
  await f.send(); const value = await f.outbox.wait();
  assert.equal(value.status, 'working'); assert.equal(value.nativeReceived, true);
  assert.deepEqual(value.firstCommand, { id: command.id, command: command.command, source: 'codex-native' });
  assert.ok(!JSON.stringify(value).includes('DO_NOT_EXPOSE'));
  assert.deepEqual(f.calls.watch, [{ messageId: 'message-1', recipientId: grant.recipientId, nativeId: grant.nativeId }]);
});
test('foreign receipts, unbound commands and forged success cannot count as this task executing', async t => {
  const f = await fixture(t); await f.send();
  for (const change of [{ messageId: 'other' }, { recipientId: 'other' }, { nativeId: 'other' },
    { source: 'tool-success' }, { inputTag: 'other' }, { nativeReceived: false }]) {
    f.update(nativeReceipt({ firstCommand: command, ...change }));
    assert.equal(f.outbox.receipt().nativeReceived, false);
  }
  f.update(nativeReceipt({ status: 'success' }));
  assert.equal(f.outbox.receipt().status, 'received');
  for (const change of [{ inputTag: 'other' }, { turnId: 'other' }, { kind: 'mcpToolCall' }]) {
    f.update(nativeReceipt({ firstCommand: { ...command, ...change } }));
    assert.equal(f.outbox.receipt().firstCommand, null);
  }
  f.update(nativeReceipt({ turnId: 'other', firstCommand: { ...command, turnId: 'other' } }));
  assert.equal(f.outbox.receipt().turnId, 'turn-1');
  f.update(nativeReceipt({ firstCommand: command })); assert.equal(f.outbox.receipt().status, 'working');
});
test('stale caller, recipient membership or edited body prevents even the first forward', async t => {
  for (const delta of [{ callerValid: false }, { callerId: 'other' }, { callerNativeId: 'other' },
    { memberRevision: 2 }, { nativeId: 'other' }, { recipientId: 'other' }, { body: 'Later human edit' }, { ready: false }]) {
    const f = await fixture(t); Object.assign(f.facts, delta);
    assert.equal((await f.send()).status, 'not-sent'); assert.equal(f.calls.forward.length, 0);
  }
});
test('unknown delivery is retained and never sent again', async t => {
  const f = await fixture(t, { forward: async () => { throw Error('Unknown completion'); } });
  assert.equal((await f.send()).status, 'unconfirmed');
  await assert.rejects(f.send()); assert.equal(f.calls.forward.length, 1);
  assert.equal(f.outbox.receipt().text, grant.text);
});
test('closing during delivery cannot install a watcher or update a destroyed view', async t => {
  let resolve, started;
  const entered = new Promise(r => { started = r; });
  const delivery = new Promise(r => { resolve = r; });
  const f = await fixture(t, { forward: () => { started(); return delivery; } });
  const pending = f.send(); await entered; await f.outbox.close(); resolve('message-1');
  const value = await pending;
  assert.equal(value.status, 'unconfirmed'); assert.equal(f.calls.watch.length, 0);
  assert.equal(f.calls.close, 1);
});
test('closing releases the scoped subscription and wakes pending receipt readers once', async t => {
  const f = await fixture(t); await f.send(); const pending = f.outbox.wait();
  await f.outbox.close(); await pending; await f.outbox.close();
  assert.equal(f.calls.unsubscribe, 1); assert.equal(f.calls.close, 1);
});
