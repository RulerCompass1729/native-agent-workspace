const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const app = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..');
const source = process.env.NAW_TEST_OUTBOX_SOURCE || path.join(app, 'computer-use-outbox.cjs');
const { createComputerUseViewGate } = require(path.join(app, 'native-computer-use.cjs'));
const text = 'One  exact task 中文 🙂; no automatic resend.';
const decode = result => JSON.parse(result.content[0].text);

async function fixture(t, options = {}) {
  let gate, send, notify, viewSpec, subscribed, closed = 0, unsubscribed = 0;
  const attempts = [], snapshots = [];
  const grant = { callerId: 'caller', callerNativeId: 'native-caller', spaceId: 'shared',
    recipientId: 'receiver', recipientName: 'Receiver', nativeId: 'native-receiver', memberRevision: 4, text,
    privateExtra: 'MUST_NOT_ENTER_VIEW' };
  const facts = { ...grant, owner: 'owned-outbox', callerValid: true, selected: 'room', surface: 'records',
    revision: '1', body: '', recipientId: '', ready: true };
  const module = { exports: {} };
  // Run the unchanged production module with an in-memory lease dependency.
  // The actual gate stays in use; this test opens no Unix socket or browser.
  vm.runInThisContext(Module.wrap(fs.readFileSync(source, 'utf8')), { filename: source })(module.exports, id => {
    if (id === './native-computer-use.cjs') return { createComputerUseViewLease: async config => {
      gate = createComputerUseViewGate(config); let ended = false;
      return { leaseFile: 'in-memory-owned-lease', async close() {
        if (ended) return; ended = true; gate.revoke(); await config.dispose();
      } };
    } };
    if (id === './computer-use-outbox-native.cjs') return require(path.join(path.dirname(source), id));
    assert.equal(id, 'node:crypto'); return require(id);
  }, module, source, path.dirname(source));
  const outbox = await module.exports.openOutbox(grant, {
    createView: async (spec, callbacks) => {
      viewSpec = spec; send = callbacks.send;
      return { owner: facts.owner, inspect: async () => ({ ...facts }),
        target: async ref => ({ id: ref === 'e1' ? 'shared-input' : 'other', visible: true,
          kind: ref === 'e2' ? 'mention' : ref === 'e3' ? 'send' : 'other', recipientId: 'receiver' }),
        invoke: async (name, args) => {
          if (name === 'browser_snapshot') return { content: [{ type: 'text', text:
            '### Snapshot\n```yaml\n- textbox "Message" [ref=e1]\n- option "Receiver" [ref=e2]\n- button "Send" [ref=e3]\n```' }] };
          if (name === 'browser_type') facts.body = args.text;
          if (args.target === 'e2') facts.recipientId = 'receiver';
          if (args.target === 'e3') await send();
          facts.revision += 'x';
          return { content: [{ type: 'text', text: 'Dispatch acknowledged only.' }] };
        }, showReceipt: receipt => snapshots.push(receipt), close: async () => { closed++; } };
    },
    forwardOnce: async spec => {
      attempts.push(spec);
      return options.forward ? options.forward(spec) : 'message-one';
    },
    watchReceipt: async (spec, callback) => {
      subscribed = spec; notify = callback;
      if (options.watch) await options.watch(spec, callback);
      return () => { unsubscribed++; };
    },
  });
  t.after(() => outbox.close());
  const action = async (name, target, body) => {
    const receipt = decode(await gate.call('browser_snapshot'));
    return gate.call(name, { snapshot: receipt.snapshot, target, ...(body === undefined ? {} : { text: body }) });
  };
  const compose = async () => {
    await action('browser_type', 'e1', '@'); await action('browser_click', 'e2');
    await action('browser_type', 'e1', text);
  };
  const event = (delta = {}) => ({ messageId: 'message-one', recipientId: 'receiver', nativeId: 'native-receiver',
    inputTag: 'message-one', source: 'codex-native', nativeReceived: true, turnId: 'turn-one', ...delta });
  const command = (delta = {}) => ({ kind: 'commandExecution', id: 'command-one', inputTag: 'message-one',
    turnId: 'turn-one', command: 'pwd', status: 'completed', exitCode: 0, ...delta });
  return { outbox, grant, facts, attempts, snapshots, compose, action, event, command,
    send: () => send(), notify: value => notify(value), viewSpec: () => viewSpec,
    subscribed: () => subscribed, closed: () => closed, unsubscribed: () => unsubscribed };
}

test('outbox preserves the approved recipient/body; only matching native receipt and command prove working', { timeout: 3000 }, async t => {
  const f = await fixture(t);
  assert.deepEqual(Object.keys(f.viewSpec()).sort(), ['recipient', 'requestId', 'spaceId', 'text']);
  assert.deepEqual(f.viewSpec().recipient, { id: 'receiver', label: 'Receiver' });
  await f.compose(); const ack = decode(await f.action('browser_click', 'e3'));
  assert.equal(ack.delivery, 'unconfirmed'); assert.equal(f.attempts.length, 1);
  assert.equal(f.attempts[0].recipientId, 'receiver'); assert.equal(f.attempts[0].nativeId, 'native-receiver');
  assert.equal(f.attempts[0].text, text); assert.equal(f.outbox.receipt().text, text);
  assert.equal(f.outbox.receipt().status, 'delivery-unconfirmed');
  assert.equal(f.outbox.receipt().nativeReceived, false); assert.equal(f.outbox.receipt().firstCommand, null);
  assert.deepEqual(f.subscribed(), { messageId: 'message-one', recipientId: 'receiver', nativeId: 'native-receiver' });
  f.notify(f.event()); assert.equal(f.outbox.receipt().status, 'received');
  f.notify(f.event({ firstCommand: f.command() }));
  const receipt = await f.outbox.wait({ timeoutMs: 100 });
  assert.equal(receipt.status, 'working'); assert.equal(receipt.turnId, 'turn-one');
  assert.equal(receipt.firstCommand.command, 'pwd'); assert.equal(receipt.nativeReceived, true);
  f.notify(f.event({ firstCommand: f.command({ command: 'different later command' }) }));
  assert.equal(f.outbox.receipt().firstCommand.command, 'pwd'); assert.equal(f.attempts.length, 1);
});

test('wrong message, target, native identity, source, input tag or turn cannot certify receipt', { timeout: 3000 }, async t => {
  const f = await fixture(t); await f.compose(); await f.action('browser_click', 'e3');
  for (const delta of [{ messageId: 'other' }, { recipientId: 'other' }, { nativeId: 'other-native' },
    { inputTag: 'other' }, { source: 'ui-ack' }, { nativeReceived: false }, { turnId: '' }]) {
    f.notify(f.event({ firstCommand: f.command(), ...delta }));
    assert.equal(f.outbox.receipt().status, 'delivery-unconfirmed');
    assert.equal(f.outbox.receipt().nativeReceived, false); assert.equal(f.outbox.receipt().firstCommand, null);
  }
  f.notify(f.event({ firstCommand: f.command({ turnId: 'wrong-turn' }) }));
  assert.equal(f.outbox.receipt().status, 'received'); assert.equal(f.outbox.receipt().firstCommand, null);
  f.notify(f.event({ turnId: 'other-turn', firstCommand: f.command({ turnId: 'other-turn' }) }));
  assert.equal(f.outbox.receipt().turnId, 'turn-one'); assert.equal(f.outbox.receipt().firstCommand, null);
  f.notify(f.event({ firstCommand: f.command() })); assert.equal(f.outbox.receipt().status, 'working');
});

test('concurrent sends and replay after an ACK make only one forward attempt', { timeout: 3000 }, async t => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { forward: async () => { await pending; return 'message-one'; } });
  t.after(release); await f.compose();
  const first = f.send();
  try { await assert.rejects(f.send()); assert.equal(f.attempts.length, 1); }
  finally { release(); }
  await first; await assert.rejects(f.send()); assert.equal(f.attempts.length, 1);
  assert.equal(f.outbox.receipt().status, 'delivery-unconfirmed');
});

test('forward or subscription failures keep an unconfirmed receipt and cannot resend', { timeout: 3000 }, async t => {
  for (const options of [{ forward: async () => { throw Error('Outcome unknown'); } },
    { watch: async () => { throw Error('Receipt subscription failed'); } }]) {
    const f = await fixture(t, options); await f.compose(); await f.send();
    assert.equal(f.outbox.receipt().status, 'unconfirmed'); assert.equal(f.outbox.receipt().retry, false);
    await assert.rejects(f.send()); assert.equal(f.attempts.length, 1);
  }
});

test('an atomic initial matching receipt is retained even if subscription later fails', { timeout: 3000 }, async t => {
  const f = await fixture(t, { watch: async (_spec, notify) => {
    notify({ messageId: 'message-one', recipientId: 'receiver', nativeId: 'native-receiver', inputTag: 'message-one',
      source: 'codex-native', nativeReceived: true, turnId: 'turn-one', firstCommand: {
        kind: 'commandExecution', id: 'command-one', inputTag: 'message-one', turnId: 'turn-one', command: 'pwd', status: 'completed', exitCode: 0 } });
    throw Error('Subscription ended after initial receipt');
  } });
  await f.compose(); await f.send();
  assert.equal(f.outbox.receipt().status, 'working'); assert.equal(f.outbox.receipt().nativeReceived, true);
  await assert.rejects(f.send()); assert.equal(f.attempts.length, 1);
});

test('changed authorization refuses before forwarding and close ignores late events', { timeout: 3000 }, async t => {
  for (const delta of [{ callerValid: false }, { callerNativeId: 'other-caller' }, { nativeId: 'other-native' },
    { memberRevision: 9 }, { recipientId: 'other' }, { body: text.replace('  ', ' ') }, { ready: false }]) {
    const f = await fixture(t); await f.compose(); Object.assign(f.facts, delta); await f.send();
    assert.equal(f.outbox.receipt().status, 'not-sent'); assert.equal(f.attempts.length, 0);
    await assert.rejects(f.send());
  }
  const f = await fixture(t); await f.compose(); await f.send();
  await f.outbox.close(); await f.outbox.close();
  assert.equal(f.closed(), 1); assert.equal(f.unsubscribed(), 1);
  f.notify(f.event({ firstCommand: f.command() }));
  assert.equal(f.outbox.receipt().status, 'unconfirmed'); assert.equal(f.outbox.receipt().nativeReceived, false);
  await assert.rejects(f.send()); assert.equal(f.attempts.length, 1);
});

test('closing during dispatch cannot reopen the receipt or subscribe after cleanup', { timeout: 3000 }, async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { forward: async () => { entered(); await pending; return 'message-one'; } });
  t.after(release); await f.compose(); const first = f.send();
  try {
    await started; await f.outbox.close();
    const count = f.snapshots.length;
    release(); await first;
    assert.equal(f.snapshots.length, count);
    assert.equal(f.subscribed(), undefined);
    assert.equal(f.outbox.receipt().status, 'unconfirmed');
    assert.equal(f.outbox.receipt().nativeReceived, false);
    await assert.rejects(f.send()); assert.equal(f.attempts.length, 1); assert.equal(f.closed(), 1);
  } finally { release(); }
});

// Callback-boundary checks only. Actual Codex.event -> owner -> Core command
// provenance is exercised by native-control-retained-outbox-regression.test.cjs.
test('Core refuses incomplete command evidence and retains a failed exit without retry', { timeout: 3000 }, async t => {
  const f = await fixture(t); await f.compose(); await f.send();
  for (const delta of [{ status: 'running' }, { status: 'declined' }, { exitCode: undefined },
    { exitCode: null }, { exitCode: '0' }, { exitCode: 0.5 }]) {
    f.notify(f.event({ firstCommand: f.command(delta) }));
    assert.equal(f.outbox.receipt().status, 'received');
    assert.equal(f.outbox.receipt().firstCommand, null);
  }
  f.notify(f.event({ firstCommand: f.command({ status: 'failed', exitCode: 7 }) }));
  const value = await f.outbox.wait({ timeoutMs: 100 });
  assert.equal(value.status, 'command-failed'); assert.equal(value.firstCommand.status, 'failed');
  assert.equal(value.firstCommand.exitCode, 7); assert.equal(value.retry, false);
  f.notify(f.event({ firstCommand: f.command({ id: 'later-success' }) }));
  assert.equal(f.outbox.receipt().status, 'command-failed', 'Later success cannot replace the first failed command');
  await assert.rejects(f.send()); assert.equal(f.attempts.length, 1);
});
