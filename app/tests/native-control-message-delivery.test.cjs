const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const app = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..');
const { Workspace } = require(path.join(app, 'workspace.cjs'));
const { createComputerUseViewGate } = require(path.join(app, 'native-computer-use.cjs'));

// Exercise the real gate and Workspace consumers. The controlled runtime below
// is a transport boundary, not evidence that a real CLI received this message.
const body = 'Read  two spaces 中文 🙂; preserve the exact body.';
const decode = result => JSON.parse(result.content[0].text);
const tree = '- textbox "Message" [ref=e1]\n- option "Receiver" [ref=e2]\n- button "Send" [ref=e3]';
const snapshot = () => ({ content: [{ type: 'text', text: '### Snapshot\n```yaml\n' + tree + '\n```' }] });
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, send = async () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-control-regression-'));
  // Counts attempts at the controlled transport, including rejected attempts.
  const runtimes = new Map(), writes = [], calls = [];
  const workspace = new Workspace({ binaries: {}, close() {}, create(record) {
    const runtime = new EventEmitter();
    record.nativeId = 'native-' + record.id;
    runtime.chatAvailable = runtime.addressedSendAvailable = true;
    runtime.start = async () => runtime.emit('state', 'idle');
    runtime.send = async (text, tag, guard) => {
      assert.equal(guard(), true);
      writes.push({ id: record.id, nativeId: record.nativeId, text, tag });
      return send({ runtime, text, tag, guard });
    };
    runtimes.set(record.id, runtime); return runtime;
  } }, root);
  t.after(() => { workspace.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const receiver = await workspace.create('codex', root, 'receiver-owner', 'Receiver');
  const decoy = await workspace.create('codex', root, 'decoy-owner', 'Other agent');
  for (const id of [receiver, decoy]) workspace.join(id, true);
  workspace.setDraft(receiver, 'RECEIVER_UNSENT_PRIVATE_DRAFT', 'receiver-owner');
  workspace.setDraft(decoy, 'DECOY_UNSENT_PRIVATE_DRAFT', 'decoy-owner');
  const identities = [receiver, decoy].map(id => ({ id, nativeId: workspace.get(id).nativeId,
    owner: workspace.get(id).owner, draft: workspace.drafts.get(id) }));
  const grant = { owner: 'owned-composer', spaceId: 'shared', recipientId: receiver,
    nativeId: workspace.get(receiver).nativeId, memberRevision: workspace.get(receiver).memberRevision, text: body };
  const facts = { ...grant, selected: 'room', surface: 'records', revision: '1', body: '', recipientId: '', ready: true };
  let revoked = 0;
  const gate = createComputerUseViewGate({ grant, inspect: async () => ({ ...facts }),
    target: async ref => ({ id: ref === 'e1' ? 'shared-input' : 'other', visible: true,
      kind: ref === 'e2' ? 'mention' : ref === 'e3' ? 'send' : 'other', recipientId: receiver }),
    onRevoke: () => revoked++,
    invoke: async (name, args) => {
      calls.push({ name, args });
      if (name === 'browser_snapshot') return snapshot();
      if (name === 'browser_type') facts.body = args.text;
      if (args.target === 'e2') facts.recipientId = receiver;
      if (args.target === 'e3') await workspace.forward(facts.recipientId, facts.body, grant.owner);
      facts.revision += 'x';
      return { content: [{ type: 'text', text: 'Dispatch accepted, delivery not established.' }] };
    } });
  const action = async (name, target, text) => {
    const receipt = decode(await gate.call('browser_snapshot'));
    return gate.call(name, { snapshot: receipt.snapshot, target, ...(text === undefined ? {} : { text }) });
  };
  const compose = async () => {
    await action('browser_type', 'e1', '@');
    await action('browser_click', 'e2');
    await action('browser_type', 'e1', body);
  };
  const assertPreserved = () => {
    assert.deepEqual(identities.map(({ id }) => ({ id, nativeId: workspace.get(id).nativeId,
      owner: workspace.get(id).owner, draft: workspace.drafts.get(id) })), identities);
  };
  const rows = () => {
    const tag = writes[0]?.tag;
    const input = workspace.get(receiver).messages.find(row => row.id === tag);
    const room = workspace.roomFor('shared').messages.find(row => row.id === tag);
    return { tag, input, room, delivery: room?.deliveries?.find(row => row.id === tag) };
  };
  return { workspace, receiver, decoy, runtimes, writes, calls, grant, facts, gate, action, compose,
    assertPreserved, rows, revoked: () => revoked };
}

test('exact selected native recipient and literal body traverse the gate; ACK is not receipt', { timeout: 3000 }, async t => {
  const f = await fixture(t); await f.compose();
  const result = decode(await f.action('browser_click', 'e3'));
  assert.equal(result.outcome, 'dispatched_unconfirmed'); assert.equal(result.delivery, 'unconfirmed');
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes[0], { id: f.receiver, nativeId: f.grant.nativeId, text: body, tag: f.rows().tag });
  const { input, room, delivery } = f.rows();
  assert.equal(input.text, body); assert.equal(room.text, body); assert.equal(delivery.text, body);
  assert.equal(room.recipientId, f.receiver); assert.equal(delivery.recipientId, f.receiver);
  for (const row of [input, room, delivery]) assert.equal(row.status, 'awaiting-native');
  assert.equal(f.workspace.get(f.decoy).messages.filter(row => row.role === 'user').length, 0);
  const type = f.calls.filter(call => call.name === 'browser_type').at(-1);
  assert.equal(type.args.text, body); assert.equal(type.args.submit, false);
  assert.equal(f.calls.some(call => call.name === 'browser_press_key'), false);
  f.assertPreserved();
});

test('only a matching controlled native receive event advances the input; reply binds exact native identity', { timeout: 3000 }, async t => {
  const f = await fixture(t); await f.compose(); await f.action('browser_click', 'e3');
  const { tag, input, delivery } = f.rows(), runtime = f.runtimes.get(f.receiver);
  runtime.emit('submitted', 'unknown-tag');
  assert.equal(input.status, 'awaiting-native'); assert.equal(delivery.status, 'awaiting-native');
  runtime.emit('replyBound', { tag, nativeId: f.workspace.get(f.decoy).nativeId, turnId: 'wrong-turn' });
  assert.equal(input.nativeId, undefined); assert.equal(input.turnId, undefined);
  runtime.emit('submitted', tag);
  assert.equal(input.status, 'submitted'); assert.equal(delivery.status, 'submitted');
  runtime.emit('replyBound', { tag, nativeId: f.grant.nativeId, turnId: 'received-turn' });
  assert.equal(input.nativeId, f.grant.nativeId); assert.equal(input.turnId, 'received-turn');
  runtime.emit('replyBound', { tag, nativeId: f.grant.nativeId, turnId: 'later-unrelated-turn' });
  assert.equal(input.turnId, 'received-turn');
  runtime.emit('submitted', tag);
  assert.equal(f.writes.length, 1); assert.equal(f.rows().room.deliveries.length, 1);
  f.assertPreserved();
});

test('one snapshot/grant cannot dispatch duplicate or concurrent sends', { timeout: 3000 }, async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async () => { entered(); await pending; });
  t.after(release); await f.compose();
  const receipt = decode(await f.gate.call('browser_snapshot'));
  const args = { snapshot: receipt.snapshot, target: 'e3' };
  const first = f.gate.call('browser_click', args);
  try {
    await started;
    await assert.rejects(f.gate.call('browser_click', args));
    await assert.rejects(f.gate.call('browser_snapshot'));
    assert.equal(f.writes.length, 1);
  } finally { release(); }
  await first;
  await assert.rejects(f.gate.call('browser_click', args));
  const later = decode(await f.gate.call('browser_snapshot'));
  await assert.rejects(f.gate.call('browser_click', { snapshot: later.snapshot, target: 'e3' }));
  assert.equal(f.writes.length, 1); assert.equal(f.rows().room.deliveries.length, 1);
  f.assertPreserved();
});

test('a receiver error remains unconfirmed and revokes this channel without retry', { timeout: 3000 }, async t => {
  const f = await fixture(t, async () => { throw Error('Controlled receive outcome unknown'); });
  await f.compose(); await assert.rejects(f.action('browser_click', 'e3'));
  assert.equal(f.revoked(), 1);
  for (const row of [f.rows().input, f.rows().room, f.rows().delivery]) assert.equal(row.status, 'unconfirmed');
  await tick(); await tick();
  await assert.rejects(f.gate.call('browser_snapshot'));
  await assert.rejects(f.gate.call('browser_click', { snapshot: 'stale', target: 'e3' }));
  assert.equal(f.writes.length, 1);
  assert.equal(f.calls.filter(call => call.args.target === 'e3').length, 1);
  f.assertPreserved();
});

test('a late dispatch error cannot erase a matching native acceptance or resend it', { timeout: 3000 }, async t => {
  const f = await fixture(t, async ({ runtime, tag }) => {
    runtime.emit('submitted', tag);
    throw Error('Controlled ACK lost after acceptance');
  });
  await f.compose(); await assert.rejects(f.action('browser_click', 'e3'));
  for (const row of [f.rows().input, f.rows().room, f.rows().delivery]) assert.equal(row.status, 'submitted');
  await tick(); await assert.rejects(f.gate.call('browser_snapshot'));
  assert.equal(f.writes.length, 1); assert.equal(f.revoked(), 1); f.assertPreserved();
});

test('a definite no-send refusal is not retried automatically', { timeout: 3000 }, async t => {
  const f = await fixture(t, async () => { throw Object.assign(Error('Controlled not sent'), { notSent: true }); });
  await f.compose(); await assert.rejects(f.action('browser_click', 'e3'));
  await tick(); await tick();
  await assert.rejects(f.gate.call('browser_snapshot'));
  for (const row of [f.rows().input, f.rows().room, f.rows().delivery]) assert.equal(row.status, 'unconfirmed');
  assert.equal(f.writes.length, 1); assert.equal(f.revoked(), 1); f.assertPreserved();
});

test('recipient, body, native identity, membership and readiness changes refuse before dispatch', { timeout: 3000 }, async t => {
  for (const change of [
    f => { f.facts.recipientId = f.decoy; },
    f => { f.facts.body = body.replace('  ', ' '); },
    f => { f.facts.nativeId = f.workspace.get(f.decoy).nativeId; },
    f => { f.facts.memberRevision++; },
    f => { f.facts.ready = false; },
  ]) {
    const f = await fixture(t); await f.compose();
    const receipt = decode(await f.gate.call('browser_snapshot')); change(f);
    await assert.rejects(f.gate.call('browser_click', { snapshot: receipt.snapshot, target: 'e3' }));
    await tick(); assert.equal(f.writes.length, 0);
    assert.equal(f.calls.filter(call => call.args.target === 'e3').length, 0);
    f.assertPreserved();
  }
});

test('a submitted tag emitted by another native runtime cannot certify target delivery', { timeout: 3000 }, async t => {
  const f = await fixture(t); await f.compose(); await f.action('browser_click', 'e3');
  const { tag, input, room, delivery } = f.rows();
  f.runtimes.get(f.decoy).emit('submitted', tag);
  assert.equal(input.status, 'awaiting-native');
  assert.equal(room.status, 'awaiting-native');
  assert.equal(delivery.status, 'awaiting-native');
  f.runtimes.get(f.receiver).emit('submitted', tag);
  for (const row of [input, room, delivery]) assert.equal(row.status, 'submitted');
  assert.equal(f.writes.length, 1); f.assertPreserved();
});

test('the shared send route keeps the complete literal multiline body and edge whitespace', { timeout: 3000 }, async t => {
  const f = await fixture(t);
  const literal = '\n  First line\twith spacing 中文\nSecond line  \n';
  await f.workspace.forward(f.receiver, literal, f.grant.owner);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].text, literal);
  for (const row of [f.rows().input, f.rows().room, f.rows().delivery]) assert.equal(row.text, literal);
  f.assertPreserved();
});

test('an image-only forward does not restore whitespace control characters as native text', { timeout: 3000 }, async t => {
  const f = await fixture(t);
  const media = require(path.join(app, 'space-images.cjs'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64');
  const decoder = { createFromBuffer: bytes => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }),
    toPNG: () => bytes, resize: () => ({ toDataURL: () => 'data:image/png;base64,' + bytes.toString('base64') }),
    toDataURL: () => 'data:image/png;base64,' + bytes.toString('base64') }) };
  const refs = media.stageSpaceImages(f.workspace.dataDir, 'shared', [{ bytes: png, name: 'Image.png' }], decoder);
  f.runtimes.get(f.receiver).spaceImagesAvailable = true;
  await f.workspace.forward(f.receiver, '\x0b', f.grant.owner, null, 'shared',
    { version: require('node:crypto').randomUUID(), refs });
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].text, '');
  for (const row of [f.rows().input, f.rows().room, f.rows().delivery]) assert.equal(row.text, '');
});
